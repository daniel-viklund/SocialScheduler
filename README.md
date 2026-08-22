# Social Scheduler

A small self-hosted web app for scheduling uploads to **YouTube** and **Instagram**.
Pick a video (or image, for Instagram), write a title and caption, choose a publish
time — a background scheduler uploads it automatically when the time comes.

- **YouTube** — YouTube Data API v3 with OAuth (one-click "Connect YouTube" in the UI)
- **Instagram** — Meta Graph API content publishing (Reels for videos, feed posts for images)
- Express + SQLite + node-cron, no build step

## Quick start

```bash
npm install
cp .env.example .env   # fill in credentials, see below
npm start              # http://localhost:3000
```

The scheduler checks every minute for due posts. Posts that came due while the app
was stopped are published as soon as it starts again.

## YouTube setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** → configure (External is fine), add your
   Google account as a test user.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application** → add redirect URI `http://localhost:3000/auth/youtube/callback`.
5. Put the client ID/secret in `.env` as `YT_CLIENT_ID` / `YT_CLIENT_SECRET`.
6. Start the app and click **Connect YouTube** — the refresh token is stored locally
   and uploads work from then on.

> Note: while your Google Cloud app is in "testing" mode, videos uploaded via the API
> are locked to **private** until the app passes Google's audit. For personal use,
> testing mode works fine; set `YT_PRIVACY=private` and flip visibility in YouTube
> Studio, or request verification.

## Instagram setup

Uses the **Instagram API with Instagram Login** — your Instagram account authorises the
app directly, so no Facebook Page and no Page linking is involved.

Instagram *downloads* your media from a public URL rather than accepting a file upload,
so the app must be reachable from the internet when a post publishes.

1. Convert your Instagram account to **Business** (Settings → Account type and tools).
2. Create an app at [developers.facebook.com](https://developers.facebook.com/), then add
   the **Instagram** product and open *API setup with Instagram login*.
3. Copy the **Instagram app ID** and **Instagram app secret** into `.env` as
   `IG_APP_ID` / `IG_APP_SECRET`. These are not the same as the Facebook app ID/secret.
4. Start a tunnel and set `PUBLIC_BASE_URL` to its https URL:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   This URL is used for both the OAuth redirect and the media Instagram fetches, so it
   must be public https — Instagram rejects http redirect URIs.
5. In the Meta app, add `$PUBLIC_BASE_URL/auth/instagram/callback` to the OAuth redirect
   URIs. `npm run check:instagram` prints the exact string to paste.
6. Restart the app (`.env` is read at boot) and click **Connect Instagram**.

Verify the whole chain at any time:

```bash
npm run check:instagram
```

Tokens last 60 days and are refreshed automatically at startup once they are within 10
days of expiry; the UI shows the remaining days.

### Media requirements

Reels published through the API must be MP4/MOV, H.264/HEVC + AAC, ≤ 1920 px wide,
23–60 fps, 3 s – 15 min, and **≤ 300 MB**. The metadata atom must sit at the front of
the file (`-movflags +faststart`), which most editors do not do by default.

Check an export before scheduling it:

```bash
npm run check:video -- ride.mp4
```

## Deploying to the Pi

`./scripts/deploy.sh` (or `npm run deploy`) pushes the current commit from your Mac to
the Pi over ssh. The Pi has no git checkout and this repo is private, so the script
mirrors the committed tree with rsync rather than pulling from GitHub:

```bash
./scripts/deploy.sh            # deploy HEAD, restart the service, health-check it
./scripts/deploy.sh --dry-run  # show what would change, touch nothing
```

It refuses to run on a dirty working tree, tars the current source into
`~/socialscheduler-backups/` first (keeping the last 5), re-runs `npm ci --omit=dev`
only when `package-lock.json` changed, restarts the systemd unit, then waits for
`/api/status` to answer — dumping the journal and failing loudly if it doesn't.
`data/`, `.env` and `node_modules/` on the Pi are never touched.

Host, directory, service name and port come from `SS_HOST` / `SS_DIR` / `SS_SERVICE` /
`SS_PORT` (defaults: `srv-soundtarget.local`, `~/socialscheduler`, `socialscheduler`,
and the `PORT` from the Pi's `.env`).

## How it works

- `POST /api/posts` stores the file in `data/uploads/` and a row in SQLite (`data/scheduler.db`).
- A cron job (`* * * * *`) picks up posts whose time has come and uploads to each
  selected platform independently; per-platform status, result links, and errors are
  shown in the UI, with a **Retry failed** button for anything that errored.
- `PATCH /api/posts/:id` edits the title, description, and publish time of a post that
  hasn't gone out yet (`scheduled`, `failed`, `partial`); the file itself can't be swapped.
- Uploaded media is served at `/media/<file>` so Instagram can fetch it via `PUBLIC_BASE_URL`.
- An interrupted upload leaves a half-written file in `data/uploads/`. Files no post
  references are swept at boot and hourly once they've been idle for an hour, and the
  **Clean up** button in the UI (`POST /api/storage/cleanup`) removes them on demand
  after 5 minutes of idleness. The disk readout counts scheduled files and leftovers
  separately.

Keep the app running (e.g. `pm2`, `launchd`, or a small VPS) so scheduled posts
actually publish — nothing uploads while the process is stopped.
