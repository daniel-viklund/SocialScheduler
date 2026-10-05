# Social Scheduler

A small self-hosted web app for scheduling uploads to **YouTube** and **Instagram**.
Pick a video (or image, for Instagram), pick the platform, write the text, confirm the
next available posting slot (or choose a specific date and time) — a background scheduler uploads it automatically when the time comes.

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

## Posting schedule

Open **Settings · Posting schedule** on the website to choose weekdays, a posting
time, and timezone separately for each platform. Defaults are YouTube on Fridays
and Instagram on Mondays and Fridays, both at 18:00 Europe/Stockholm. Settings are
saved in SQLite and shared across browsers.

New posts default to **Next available slot**. Suggestions search forward from now,
fill gaps, and skip existing bookings on that platform, including manual bookings
and posts created before the latest settings change. A booking occupies its minute;
a post at another time on the same day does not consume the recurring slot.
Changing settings never moves existing posts. **Pick a specific date and time**
keeps manual scheduling available, using the browser timezone displayed below it.

Recurring times follow the configured timezone through daylight saving changes.
A nonexistent spring-forward time is skipped; a repeated autumn time uses its first
occurrence only. The server checks availability again after an upload; if the
suggested slot changed, review the updated suggestion and submit again.

Pressing **Schedule** adds the file to an upload queue and immediately frees the
form for the next video. Uploads run one at a time, with separate progress and
retry controls. Pending queue entries count toward next-slot suggestions in that
tab. Removing or failing an earlier upload does not move later confirmed slots.
Keep the tab open until uploads finish; the queue is held in browser memory and
is not restored after a reload. Retry uses the same upload ID to avoid duplicate
posts if the server saved an upload but its response was lost.

Run `npm test` for scheduling and API tests. Tests use a temporary data directory
and do not start the publisher or change existing posts.

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
7. **OAuth consent screen → Publishing status → Publish app.** While the app is in
   **Testing**, Google expires every refresh token after 7 days; each YouTube upload
   then fails with `invalid_grant` until you click **Connect YouTube** again. Once the
   app is in production the token lasts until you revoke it. Consenting shows a
   "Google hasn't verified this app" warning (Advanced → continue) — fine for your own account.
   Production mode needs a home page and a privacy policy URL on the **Branding** page:
   use `$PUBLIC_BASE_URL` and `$PUBLIC_BASE_URL/privacy` (the app serves `public/privacy.html`).
   If the host sits behind Cloudflare Access, add a bypass rule for `/privacy` so the page
   is actually public.

The app asks Google for a fresh access token at boot and once a day. If the refresh
token has died, the YouTube row turns red with a **Reconnect YouTube** button and the
reason, and any upload that comes due fails with that same message rather than a bare
`invalid_grant`.

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
23–60 fps, 3 s – 15 min, and **≤ 300 MB**. Feed images must be JPEG, ≤ 8 MB, with an
aspect ratio between 4:5 and 1.91:1. Instagram only reports a bad file when the post
comes due, so the app checks these limits itself when a post targets Instagram:

- The form refuses an oversized file before uploading it.
- `POST /api/posts` probes the uploaded file with `ffprobe` and rejects it with every
  problem listed (the file is deleted, nothing is scheduled). YouTube-only posts are
  not checked — YouTube takes almost anything.
- The one thing it fixes rather than rejects is the metadata atom sitting at the end of
  the file (most editors' default): the upload is losslessly remuxed in place with
  `-movflags +faststart`, and the response says so.

This needs `ffmpeg`/`ffprobe` installed on the server (`apt install ffmpeg` on the Pi).
Without it, Instagram posts are rejected with a message saying so.

To check an export before uploading it:

```bash
npm run check:video -- ride.mp4
```

## Deploying to Debian

The production app lives in `/home/user/socialscheduler` on `ssh debian` and runs
with Docker Compose. Node and ffmpeg are included in the image. The container runs
as UID 1000, so `data/` must be writable by that user. Settings come from `.env`;
the database, account tokens, and uploaded media persist in the mounted `data/` directory.
Docker restarts the app after a server reboot.

In the personal Cloudflare tunnel, route `scheduler.example.com` to
**HTTP → `127.0.0.1:3000`**. The port binds only to Debian's loopback interface.
Keep `PUBLIC_BASE_URL=https://scheduler.example.com` in `.env`.

For direct uploads at home, open **http://192.168.0.63:3000**. A separate nginx
container binds to that LAN address and accepts only clients from `192.168.0.0/24`.
It streams uploads directly to the app. LAN access bypasses Cloudflare Access:
devices on this subnet can use the scheduler without a login, over plain HTTP.
Use a trusted home network and do not forward port 3000 on the router. Reserve
`192.168.0.63` for Debian in the router's DHCP settings so the binding stays valid.
The Cloudflare route continues using `127.0.0.1:3000`; keep the public URL for OAuth
connections and Instagram media fetching.

The host's `bikefable-firewall` also needs an exception before its forward-chain
drop rule. Run once on Debian: `sudo python3 ~/socialscheduler/deploy/enable-lan-firewall.py`.
This backs up and syntax-checks the existing configuration, then permits only
home-LAN traffic originally addressed to `192.168.0.63:3000` and translated by
Docker to the nginx port. The exception persists across reboots.

```bash
ssh debian 'cd ~/socialscheduler && docker compose ps'
ssh debian 'cd ~/socialscheduler && docker compose logs --tail=50'
ssh debian 'cd ~/socialscheduler && docker compose restart app'
```

Commit the deployment files before using `npm run deploy`. It deploys the committed
tree from your Mac using rsync, builds the image, starts the container, and checks
`/api/status`. It refuses a dirty working tree by default. It backs up the source
and `.env` to `~/socialscheduler-backups/` (keeping five backups); these are not
database or media backups. Remote `data/`, `.env`, and `node_modules/` are preserved.

```bash
./scripts/deploy.sh            # deploy HEAD to Debian and health-check it
./scripts/deploy.sh --dry-run  # show file changes without deploying
```

Override `SS_HOST`, `SS_DIR`, or `SS_PORT` if needed (defaults: `debian`,
`socialscheduler` relative to the remote home directory, and `3000`). The old
systemd deployment remains available with `SS_MODE=systemd`, `SS_HOST`, and
`SS_SERVICE`; avoid starting the Pi copy while Debian is running because both
copies would publish scheduled posts.

## How it works

- `POST /api/posts` stores the file in `data/uploads/` and a row in SQLite (`data/scheduler.db`).
- A cron job (`* * * * *`) picks up posts whose time has come and uploads to each
  selected platform independently; per-platform status, result links, and errors are
  shown in the UI, with a **Retry failed** button for anything that errored.
- A post targets one platform, chosen from a dropdown. The text fields follow it:
  YouTube gets a **Title** (required, it refuses an empty one) plus a description,
  Instagram gets a single **Caption**, which is the only text a post shows there.
  Switching to Instagram carries anything already typed as a title into the caption.
- The API still accepts several platforms per post (`platforms` repeated), and posts
  made that way still render in both lists. The scheduler builds an Instagram caption
  as `title` + blank line + `description`, so an older post that only had a title
  still publishes correctly, and editing it folds the two into one caption.
- The UI lists posts per platform — a post targeting both appears in both lists, each
  showing that platform's own state — and every card names the file it will publish,
  flagging one that has gone missing from `data/uploads/`. A caption-only post is
  listed by the first line of its caption.
- The lists show pending posts by default; **Published**, **Failed** and **All** chips
  filter both lists at once, each carrying a count. The choice is remembered per browser.
- `PATCH /api/posts/:id` edits the title, description, and publish time of a post that
  hasn't gone out yet (`scheduled`, `failed`, `partial`); the file itself can't be swapped.
  An empty title is rejected only when the post targets YouTube.
- Uploaded media is served at `/media/<file>` so Instagram can fetch it via `PUBLIC_BASE_URL`.
- An interrupted upload leaves a half-written file in `data/uploads/`. Files no post
  references are swept at boot and hourly once they've been idle for an hour, and the
  **Clean up** button in the UI (`POST /api/storage/cleanup`) removes them on demand
  after 5 minutes of idleness. The disk readout counts scheduled files and leftovers
  separately.

Keep the app running (e.g. `pm2`, `launchd`, or a small VPS) so scheduled posts
actually publish — nothing uploads while the process is stopped.

## Instagram limits
Instagram limits the video format, use this command to make the API accept the file: `ffmpeg -i in.mp4 -map 0:v:0 -map 0:a:0 -c:v libx264 -preset slow -crf 18 -maxrate 20M -bufsize 40M -pix_fmt yuv420p -profile:v high -level 4.2 -c:a copy -movflags +faststart out_ig.mp4`
