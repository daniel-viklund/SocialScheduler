// Instagram API with Instagram Login (graph.instagram.com).
// No Facebook Page and no Page linking: the app user authorises their Instagram
// professional account directly, and the token exchange hands back the user id.
import { getSetting, setSetting } from './db.js';

const AUTH = 'https://www.instagram.com/oauth/authorize';
const TOKEN = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];

export function isConfigured() {
  return Boolean(process.env.IG_APP_ID && process.env.IG_APP_SECRET && process.env.PUBLIC_BASE_URL);
}

export function isConnected() {
  return isConfigured() && Boolean(getSetting('ig_access_token'));
}

export function connectedUsername() {
  return getSetting('ig_username');
}

export function tokenExpiresAt() {
  const at = getSetting('ig_token_expires_at');
  return at ? new Date(at) : null;
}

// Instagram rejects plain-http redirect URIs, so this must be the tunnel URL,
// not localhost. Same origin the media is served from, so it is already https.
export function redirectUri() {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_URL || '';
  return `${base.replace(/\/$/, '')}/auth/instagram/callback`;
}

function requireConfig() {
  if (!isConfigured()) {
    throw new Error('Instagram is not configured. Set IG_APP_ID, IG_APP_SECRET and PUBLIC_BASE_URL in .env');
  }
}

export function authUrl() {
  requireConfig();
  const uri = redirectUri();
  if (!uri.startsWith('https://')) {
    throw new Error(`Instagram requires an https redirect URI, got "${uri}". Set PUBLIC_BASE_URL to your tunnel URL.`);
  }
  const url = new URL(AUTH);
  url.searchParams.set('client_id', process.env.IG_APP_ID);
  url.searchParams.set('redirect_uri', uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(','));
  return url.toString();
}

export async function handleCallback(code) {
  requireConfig();
  if (!code) throw new Error('No authorization code returned by Instagram');

  // 1. code -> short-lived token (this response also carries the user id).
  const form = new URLSearchParams({
    client_id: process.env.IG_APP_ID,
    client_secret: process.env.IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code: String(code).replace(/#_$/, ''), // Instagram appends "#_" on redirect
  });
  const shortRes = await fetch(TOKEN, { method: 'POST', body: form });
  const short = await shortRes.json();
  if (!shortRes.ok || short.error_type || short.error) {
    throw new Error(`Token exchange failed: ${short.error_message || short.error?.message || shortRes.statusText}`);
  }

  // 2. short-lived -> long-lived (60 days).
  const longUrl = new URL(`${GRAPH}/access_token`);
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', process.env.IG_APP_SECRET);
  longUrl.searchParams.set('access_token', short.access_token);
  const longRes = await fetch(longUrl);
  const long = await longRes.json();
  if (!longRes.ok || long.error) {
    throw new Error(`Long-lived token exchange failed: ${long.error?.message || longRes.statusText}`);
  }

  storeToken(long.access_token, long.expires_in);
  setSetting('ig_user_id', String(short.user_id));

  try {
    const me = await graph('me', { fields: 'user_id,username' });
    if (me.username) setSetting('ig_username', me.username);
    if (me.user_id) setSetting('ig_user_id', String(me.user_id));
  } catch {
    // Username is cosmetic; publishing only needs the id we already stored.
  }
}

function storeToken(token, expiresInSeconds) {
  setSetting('ig_access_token', token);
  const ttl = Number(expiresInSeconds) || 60 * 24 * 3600;
  setSetting('ig_token_expires_at', new Date(Date.now() + ttl * 1000).toISOString());
}

// Long-lived tokens last 60 days and can be refreshed once they are 24h old.
// Refreshing well before expiry means the scheduler never dies of a stale token.
export async function refreshTokenIfNeeded({ force = false } = {}) {
  if (!isConnected()) return { refreshed: false, reason: 'not connected' };
  const expiresAt = tokenExpiresAt();
  const daysLeft = expiresAt ? (expiresAt - Date.now()) / 864e5 : 0;
  if (!force && daysLeft > 10) return { refreshed: false, daysLeft };

  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', getSetting('ig_access_token'));
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    return { refreshed: false, error: data.error?.message || res.statusText, daysLeft };
  }
  storeToken(data.access_token, data.expires_in);
  return { refreshed: true, daysLeft: (Number(data.expires_in) || 0) / 86400 };
}

async function graph(path, params = {}, method = 'GET') {
  const token = getSetting('ig_access_token');
  if (!token) throw new Error('Instagram account not connected. Open the app and click "Connect Instagram".');

  const url = new URL(`${GRAPH}/${path}`);
  let res;
  if (method === 'GET') {
    for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body: new URLSearchParams({ ...params, access_token: token }) });
  }
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Instagram API error: ${data.error?.message || res.statusText}`);
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Instagram downloads the media from fileUrl rather than accepting an upload,
// so PUBLIC_BASE_URL must stay reachable for the whole publish.
export async function publish({ fileUrl, mimeType, caption }) {
  requireConfig();
  const igUserId = getSetting('ig_user_id');
  if (!igUserId) throw new Error('Instagram account not connected. Open the app and click "Connect Instagram".');

  await refreshTokenIfNeeded().catch(() => {});

  const isVideo = mimeType.startsWith('video/');
  const containerParams = isVideo
    ? { media_type: 'REELS', video_url: fileUrl, caption }
    : { image_url: fileUrl, caption };

  const { id: creationId } = await graph(`${igUserId}/media`, containerParams, 'POST');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (true) {
    const { status_code: status } = await graph(creationId, { fields: 'status_code' });
    if (status === 'FINISHED') break;
    if (status === 'ERROR') {
      throw new Error('Instagram failed to process the media (check format/aspect ratio and that PUBLIC_BASE_URL is publicly reachable)');
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for Instagram to process the media');
    await sleep(5000);
  }

  const { id: mediaId } = await graph(`${igUserId}/media_publish`, { creation_id: creationId }, 'POST');

  try {
    const { permalink } = await graph(mediaId, { fields: 'permalink' });
    return permalink;
  } catch {
    return `https://www.instagram.com/ (media id ${mediaId})`;
  }
}

export async function publishingLimit() {
  const igUserId = getSetting('ig_user_id');
  if (!igUserId) return null;
  const { data } = await graph(`${igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' });
  return { used: data?.[0]?.quota_usage ?? 0, total: data?.[0]?.config?.quota_total ?? 100 };
}
