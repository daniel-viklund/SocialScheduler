import fs from 'node:fs';
import { google } from 'googleapis';
import { getSetting, setSetting, deleteSetting } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

// Set when Google refuses the stored refresh token. A dead token still *looks*
// connected (it is just a string in the settings table), so without this the
// UI kept saying "connected" while every upload failed with a bare
// `invalid_grant`. Cleared by a successful reconnect or a successful probe.
const TOKEN_ERROR_KEY = 'yt_token_error';

export function isConfigured() {
  return Boolean(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET);
}

// "Connected" means we hold a refresh token Google has not rejected.
export function isConnected() {
  return isConfigured() && Boolean(getSetting('yt_refresh_token')) && !connectionError();
}

export function connectionError() {
  return getSetting(TOKEN_ERROR_KEY);
}

function appUrl() {
  return process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function oauthClient() {
  if (!isConfigured()) {
    throw new Error('YouTube is not configured. Set YT_CLIENT_ID and YT_CLIENT_SECRET in .env');
  }
  return new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    `${appUrl()}/auth/youtube/callback`
  );
}

function authedClient() {
  const refreshToken = getSetting('yt_refresh_token');
  if (!refreshToken) {
    throw new Error('YouTube account not connected. Open the app and click "Connect YouTube".');
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Google answers a refresh with `invalid_grant` once the token has expired or
// been revoked. Only re-consenting fixes that, so remember it and say so. The
// usual cause: a Cloud project whose OAuth consent screen is still in
// "Testing" — Google expires those refresh tokens after 7 days.
function isInvalidGrant(err) {
  return err?.response?.data?.error === 'invalid_grant' || err?.message === 'invalid_grant';
}

function recordDeadToken(err) {
  const why = err?.response?.data?.error_description || 'token expired or revoked';
  const message =
    `YouTube access is no longer valid (${why}). Click "Connect YouTube" to reconnect. ` +
    'If the Google Cloud app is still in "Testing", its tokens expire after 7 days — publish it to production.';
  setSetting(TOKEN_ERROR_KEY, message);
  return new Error(message);
}

export function authUrl() {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function handleCallback(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app from https://myaccount.google.com/permissions and connect again.');
  }
  setSetting('yt_refresh_token', tokens.refresh_token);
  deleteSetting(TOKEN_ERROR_KEY);
}

// Ask Google for an access token without uploading anything. Run at boot and
// daily so a dead token shows up in the UI before a scheduled post is due.
export async function checkConnection() {
  if (!isConfigured() || !getSetting('yt_refresh_token')) return { ok: false, reason: 'not connected' };
  try {
    await authedClient().getAccessToken();
    deleteSetting(TOKEN_ERROR_KEY);
    return { ok: true };
  } catch (err) {
    if (isInvalidGrant(err)) return { ok: false, reason: recordDeadToken(err).message };
    // A network hiccup is not a verdict on the token; leave the state alone.
    return { ok: false, reason: String(err.message || err), transient: true };
  }
}

export async function uploadVideo({ filePath, mimeType, title, description }) {
  if (!mimeType.startsWith('video/')) {
    throw new Error('YouTube uploads must be video files');
  }
  // A token already known to be dead: fail with the useful message straight
  // away instead of asking Google for another invalid_grant.
  const known = connectionError();
  if (known) throw new Error(known);

  const youtube = google.youtube({ version: 'v3', auth: authedClient() });

  try {
    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description },
        status: {
          privacyStatus: process.env.YT_PRIVACY || 'public',
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(filePath) },
    });
    return `https://youtu.be/${res.data.id}`;
  } catch (err) {
    if (isInvalidGrant(err)) throw recordDeadToken(err);
    throw err;
  }
}
