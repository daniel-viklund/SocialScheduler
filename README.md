# Social Scheduler

A small self-hosted web app for scheduling uploads to **YouTube** and **Instagram**.
Upload videos and images into a reusable **Media library**, organize them by platform,
and schedule one or several whenever you are ready. A background scheduler publishes
confirmed posts automatically when their time comes.

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

## Media library and scheduling

The interface has three areas:

- **Media library** — upload multiple videos or images, preview files, search and filter,
  and categorize files for YouTube, Instagram, both platforms, or neither. Categories
  are organizational labels; they do not schedule or publish anything. Save default
  titles and captions in file details, and change them for individual posts later.
- **Schedule** — review upcoming, published, and failed posts. Edit text and dates,
  retry failed targets, or spread upcoming posts across new dates with a preview.
- **Settings** — connect accounts, choose your posting routine, and manage storage.

Choose **Upload files** or drop files onto the library. Select **Save to library** to
organize files without a publishing date. Set a common platform category,
then adjust individual files if needed. Uploads run one at a time, with individual
progress and retry controls. Successful files are saved immediately, even if another
file fails. Keep the tab open until uploads finish; pending files are held in browser
memory. Retry reuses the same upload ID to avoid duplicate library entries if a response
is lost. Saved files persist across reloads and server restarts.

To schedule while uploading, choose **Upload & schedule** in the upload dialog, or
use the **Upload & schedule** button in Schedule. **Next available slot** is the default.
Before uploading, every file shows its suggested date, time, and timezone separately
for each selected platform. Suggestions skip booked dates, earlier files in the selection,
and dates held by uploads already queued in this tab. They refresh when files or platforms
change, periodically while the dialog is open, and with **Refresh dates**. A failed preview
can be retried without losing your titles or captions.

These are suggestions, not reservations: after each upload finishes and passes validation, the server assigns the next free slot
in each target platform's posting routine. It skips booked dates, including earlier files
in the batch, and uses each platform's timezone. Files for both platforms can get different
dates. Dates are chosen and booked together, so concurrent uploads cannot take the same
platform slot; a slot that passes during a long upload is skipped automatically.

Alternatively, select **Choose a date and time**, set a default date, and adjust each
file's date. Manual dates use your browser timezone. In either mode you can adjust each
file's platform, YouTube title/description, and Instagram caption before starting.
The button uploads and schedules automatically, with the confirmed dates shown in the
queue and Schedule; there is no separate library-selection step. Each file
is independent, so a failed file does not prevent the others from finishing. For a file
targeting both platforms, its two posts are scheduled together. Files also stay in the
library. If scheduling fails, retry skips the completed upload and reuses the scheduling
request ID to avoid duplicate posts. Keep the tab open until uploading and scheduling
finish; files that finish uploading remain in the library even if scheduling is interrupted.

To schedule existing files, select one or more and choose **Schedule selected** (up to 50 files
per batch). Choose a platform for each file; **Both platforms** creates separate posts
with their own text and dates. Review titles, captions, dates, and timezones before
confirming. Files stay in the library and can be used again. Scheduling is atomic:
if a file fails validation or a suggested slot was taken, none of that batch is saved.
Go back to review fresh dates after a slot conflict. Scheduling retries reuse a request
ID to prevent duplicate posts after a lost response.

**Next available posting slots** follows the per-platform routine in Settings. Defaults
are YouTube on Fridays and Instagram on Mondays and Fridays, at 18:00 Europe/Stockholm.
Suggestions fill gaps and skip dates already booked on that platform, even if the
existing booking has a different time. Selected files get distinct available dates.
Recurring times follow daylight saving changes; missing spring-forward times are skipped
and repeated autumn times use the first occurrence. Changing your routine keeps existing
posts at their confirmed dates.

**Choose a date and time** uses your browser timezone and lets you spread a selection
a chosen number of days apart. Files targeting both platforms use the same manual time.
Manual scheduling may share a date with an existing post. The Schedule view shows all
dates in the browser timezone; recurring slot reviews show the routine's timezone.

Existing uploaded posts are added to the library automatically on the first startup
after upgrading, without moving any posts. Removing a scheduled post keeps its library
file. A library file used by any scheduled or historical post cannot be deleted until
those local posts are removed. Removing local history does not delete published posts
from YouTube or Instagram. Cleanup protects both library files and post attachments.

Run `npm test` for scheduling, migration, storage, validation, and library API tests.
Tests use temporary data directories and do not start the publisher or change existing posts.

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
comes due, so the app checks these limits with `ffprobe` when you confirm an Instagram schedule.
Library uploads can be saved and categorized before they are ready to publish. If a
file is incompatible, the scheduling dialog explains the problem, the whole batch
remains unscheduled, and the original files stay in your library.

If the metadata atom sits at the end of an otherwise valid video, the app losslessly
remuxes it with `-movflags +faststart` and reports the adjustment. The legacy direct
upload endpoint (`POST /api/posts`) still validates at upload time and removes a rejected
upload. YouTube-only files are not probed.

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

- Express serves the responsive frontend directly; no frontend build step is required.
- `POST /api/media` saves one upload to `data/uploads/` with metadata in SQLite.
  The UI sends multi-file selections as sequential requests with per-file progress.
- `GET /api/media` lists library files, categories, file sizes, and usage counts.
  `PATCH /api/media/:id` saves categories and default text; `DELETE` removes an unused file.
- `POST /api/media/schedule/preview` calculates dates without creating posts.
  `POST /api/media/schedule` validates the files and creates the entire selection in one
  transaction. Each item targets one platform. A persisted request ID makes retry safe.
- The legacy `POST /api/posts` endpoint still supports direct upload and scheduling.
- Every minute, the scheduler publishes due posts. Each platform keeps independent
  status, result links, and errors. Retry republishes only failed targets.
- `PATCH /api/posts/:id` edits text and dates of scheduled, failed, or partially failed
  posts. `POST /api/posts/reschedule` updates multiple dates in one transaction.
- Uploaded media is served at `/media/<file>` so Instagram can fetch it via `PUBLIC_BASE_URL`.
- Unreferenced files from interrupted uploads are swept at boot and hourly after an hour
  of idleness. Settings' **Clean up interrupted uploads** uses a five-minute idle window.
  Files referenced by either the library or a post are always retained.

Keep the app running (e.g. `pm2`, `launchd`, or a small VPS) so scheduled posts
actually publish — nothing uploads while the process is stopped.

## Instagram limits
Instagram limits the video format, use this command to make the API accept the file: `ffmpeg -i in.mp4 -map 0:v:0 -map 0:a:0 -c:v libx264 -preset slow -crf 18 -maxrate 20M -bufsize 40M -pix_fmt yuv420p -profile:v high -level 4.2 -c:a copy -movflags +faststart out_ig.mp4`
