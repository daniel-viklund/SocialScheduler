import fs from 'node:fs';
import { google } from 'googleapis';
import { getSetting, setSetting } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export function isConfigured() {
  return Boolean(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET);
}

export function isConnected() {
  return isConfigured() && Boolean(getSetting('yt_refresh_token'));
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
}

export async function uploadVideo({ filePath, mimeType, title, description }) {
  if (!mimeType.startsWith('video/')) {
    throw new Error('YouTube uploads must be video files');
  }
  const refreshToken = getSetting('yt_refresh_token');
  if (!refreshToken) {
    throw new Error('YouTube account not connected. Open the app and click "Connect YouTube".');
  }

  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: client });

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
}
