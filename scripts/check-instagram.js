// Validates the Instagram half of the setup end to end.
//   node scripts/check-instagram.js
import 'dotenv/config';
import * as instagram from '../src/instagram.js';
import { getSetting } from '../src/db.js';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`); };
const info = (m) => console.log(`        ${m}`);

console.log('\nInstagram setup check\n');

// 1. Config that must be in .env before the OAuth dance can start.
for (const key of ['IG_APP_ID', 'IG_APP_SECRET', 'PUBLIC_BASE_URL']) {
  (process.env[key] ? ok : bad)(`${key} ${process.env[key] ? 'set' : 'is empty in .env'}`);
}

// 2. PUBLIC_BASE_URL does double duty: OAuth redirect and the media URL
//    Instagram fetches from. Both require public https.
const base = process.env.PUBLIC_BASE_URL;
if (base) {
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base)) {
    bad(`PUBLIC_BASE_URL=${base} is local — Instagram rejects http redirects and cannot fetch media from it`);
  } else if (!base.startsWith('https://')) {
    bad(`PUBLIC_BASE_URL must be https, got ${base}`);
  } else {
    ok(`PUBLIC_BASE_URL is public https`);
    try {
      const res = await fetch(base, { redirect: 'follow' });
      (res.ok ? ok : bad)(`PUBLIC_BASE_URL reachable (HTTP ${res.status})`);
    } catch (err) {
      bad(`PUBLIC_BASE_URL unreachable: ${err.message} — is the app running behind the tunnel?`);
    }
  }
  if (instagram.isConfigured()) {
    info(`redirect URI to whitelist in the Meta app:`);
    info(`  ${instagram.redirectUri()}`);
  }
}

// 3. Has the account actually been connected through the UI?
if (!instagram.isConnected()) {
  bad('no Instagram account connected — start the app and click "Connect Instagram"');
  console.log(`\n${fail} problem(s).\n`);
  process.exit(1);
}

const expiresAt = instagram.tokenExpiresAt();
const days = expiresAt ? Math.round((expiresAt - Date.now()) / 864e5) : null;
if (days === null) info('token expiry unknown');
else (days > 7 ? ok : bad)(`token valid ${days} more day(s) — ${expiresAt.toDateString()}`);
ok(`ig_user_id=${getSetting('ig_user_id')}`);

// 4. Prove the token actually works against the live API.
try {
  const res = await fetch(
    `https://graph.instagram.com/me?fields=user_id,username&access_token=${getSetting('ig_access_token')}`
  );
  const me = await res.json();
  if (me.error) bad(`token rejected by Instagram: ${me.error.message}`);
  else ok(`authenticated as @${me.username}`);
} catch (err) {
  bad(`could not reach graph.instagram.com: ${err.message}`);
}

try {
  const limit = await instagram.publishingLimit();
  if (limit) ok(`published ${limit.used}/${limit.total} in the last 24h`);
} catch (err) {
  info(`publishing limit unavailable: ${err.message}`);
}

if (fail) {
  console.log(`\n${fail} problem(s).\n`);
  process.exit(1);
}
console.log('\nAll checks passed — Instagram is ready.\n');
