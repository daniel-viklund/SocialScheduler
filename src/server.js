import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import {
  DATA_DIR, UPLOADS_DIR, EDITABLE_STATUSES,
  createPost, listPosts, getPost, updatePost, deletePost, retryPost, usedFileNames, bulkReschedule,
} from './db.js';
import * as youtube from './youtube.js';
import * as instagram from './instagram.js';
import { prepareForInstagram, MediaError, REEL_MAX_BYTES, IMAGE_MAX_BYTES } from './mediacheck.js';
import { startScheduler } from './scheduler.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;
// Raw camera files and long 4K exports run well past the old 2 GB cap.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_GB || 16) * 1024 ** 3;

const app = express();
app.use(express.json());

// Cloudflare rewrites our `max-age=0` into a 4-hour *browser* TTL for .js/.css,
// so after a deploy a browser keeps running the old front-end until that
// expires. Stamping the asset URLs with a version that changes whenever the
// files do sidesteps the whole thing: the HTML is never cached (Cloudflare does
// not cache HTML by default, and we say no-cache), and a new version string
// means a URL the cache has never seen.
const ASSET_VERSION = (() => {
  try {
    const stamp = ['app.js', 'style.css']
      .map((f) => fs.statSync(path.join(ROOT, 'public', f)).mtimeMs)
      .join('-');
    return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 8);
  } catch {
    return String(Date.now());
  }
})();

const INDEX_HTML = fs
  .readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace(/(href="style\.css|src="app\.js)"/g, `$1?v=${ASSET_VERSION}"`);

const sendIndex = (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
};
app.get('/', sendIndex);
app.get('/index.html', sendIndex);

app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only video and image files are allowed'), ok);
  },
});

// An interrupted upload leaves its half-written file behind (multer only cleans
// up files whose write had already finished), so uploads/ can hold more than the
// posts do. Count the two apart instead of reporting the directory as "scheduled".
function scanUploads() {
  const known = usedFileNames();
  const scan = { uploadsBytes: 0, uploadCount: 0, orphanBytes: 0, orphanCount: 0, orphans: [] };
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    try {
      const st = fs.statSync(path.join(UPLOADS_DIR, name));
      if (!st.isFile()) continue;
      if (known.has(name)) {
        scan.uploadsBytes += st.size;
        scan.uploadCount += 1;
      } else {
        scan.orphanBytes += st.size;
        scan.orphanCount += 1;
        scan.orphans.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      // File deleted mid-scan; ignore.
    }
  }
  return scan;
}

function storageInfo() {
  const st = fs.statfsSync(DATA_DIR);
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  const { orphans, ...scan } = scanUploads();
  return { total, free, used: total - free, ...scan };
}

// A file is only safe to delete once nothing references it *and* it has sat
// untouched long enough that it can't be an upload still streaming in — an
// in-flight write keeps bumping mtime, so an idle file is a dead one.
const ORPHAN_IDLE_MS = 60 * 60 * 1000;

function sweepOrphans(idleMs = ORPHAN_IDLE_MS) {
  const cutoff = Date.now() - idleMs;
  const removed = { count: 0, bytes: 0 };
  for (const f of scanUploads().orphans) {
    if (f.mtimeMs > cutoff) continue;
    try {
      fs.rmSync(path.join(UPLOADS_DIR, f.name), { force: true });
      removed.count += 1;
      removed.bytes += f.size;
      console.log(`[cleanup] removed orphaned upload ${f.name} (${(f.size / 1024 ** 3).toFixed(2)} GB)`);
    } catch (err) {
      console.warn(`[cleanup] could not remove ${f.name}: ${err.message || err}`);
    }
  }
  return removed;
}

app.get('/api/storage', (req, res) => {
  try {
    res.json(storageInfo());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Manual "Clean up" from the UI: the user is watching, so a shorter idle window
// is enough to tell a dead file from an upload in flight.
app.post('/api/storage/cleanup', (req, res) => {
  try {
    res.json({ ...sweepOrphans(5 * 60 * 1000), storage: storageInfo() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    youtube: { configured: youtube.isConfigured(), connected: youtube.isConnected() },
    instagram: {
      configured: instagram.isConfigured(),
      connected: instagram.isConnected(),
      username: instagram.connectedUsername(),
      tokenExpiresAt: instagram.tokenExpiresAt(),
      redirectUri: instagram.isConfigured() ? instagram.redirectUri() : null,
    },
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    // So the form can bounce an oversized Instagram file before uploading it.
    instagramLimits: { reelMaxBytes: REEL_MAX_BYTES, imageMaxBytes: IMAGE_MAX_BYTES },
    storage: (() => {
      try {
        return storageInfo();
      } catch {
        return null;
      }
    })(),
  });
});

// The UI shows which file a post will publish, so every post it renders carries
// the file's size — and says so loudly when the file has gone missing.
function withFile(post) {
  if (!post) return post;
  try {
    const st = fs.statSync(path.join(UPLOADS_DIR, post.file_name));
    return { ...post, file_size: st.size, file_missing: false };
  } catch {
    return { ...post, file_size: null, file_missing: true };
  }
}

app.get('/api/posts', (req, res) => {
  res.json(listPosts().map(withFile));
});

app.post('/api/posts', upload.single('file'), async (req, res) => {
  // Multer has already written the file to disk; don't leave it orphaned on rejection.
  const reject = (code, error) => {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    res.status(code).json({ error });
  };
  try {
    const { title, description = '', scheduledAt } = req.body;
    const platforms = [].concat(req.body.platforms || []);

    if (!req.file) return reject(400, 'A video or image file is required');
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
      return reject(400, 'A valid schedule time is required');
    }
    const valid = ['youtube', 'instagram'];
    if (platforms.length === 0 || platforms.some((p) => !valid.includes(p))) {
      return reject(400, 'Pick at least one platform (youtube, instagram)');
    }
    // Instagram posts carry a caption and nothing else; only YouTube needs a
    // title, and it refuses an empty one.
    if (platforms.includes('youtube') && !title?.trim()) {
      return reject(400, 'Title is required for YouTube');
    }
    if (platforms.includes('youtube') && !req.file.mimetype.startsWith('video/')) {
      return reject(400, 'YouTube only accepts video files');
    }

    // Instagram would only report a bad export when the post comes due, so
    // check its limits now (and quietly fix the moov position if that is all).
    const warnings = [];
    if (platforms.includes('instagram')) {
      try {
        const verdict = await prepareForInstagram(req.file.path, req.file.mimetype);
        warnings.push(...verdict.warnings);
      } catch (err) {
        return reject(err instanceof MediaError ? 400 : 500, err.message);
      }
    }

    const post = createPost({
      title: (title || '').trim(),
      description,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      scheduledAt: new Date(scheduledAt).toISOString(),
      platforms,
    });
    res.status(201).json({ ...withFile(post), warnings });
  } catch (err) {
    reject(500, String(err.message || err));
  }
});

app.patch('/api/posts/:id', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!EDITABLE_STATUSES.includes(post.status)) {
    return res.status(409).json({ error: `A ${post.status} post can no longer be edited` });
  }

  const title = String(req.body.title ?? post.title).trim();
  const description = String(req.body.description ?? post.description);
  const scheduledAt = req.body.scheduledAt ?? post.scheduled_at;
  if (!title && post.targets.some((t) => t.platform === 'youtube')) {
    return res.status(400).json({ error: 'Title is required for YouTube' });
  }
  if (Number.isNaN(Date.parse(scheduledAt))) {
    return res.status(400).json({ error: 'A valid schedule time is required' });
  }

  const updated = updatePost(post.id, {
    title,
    description,
    scheduledAt: new Date(scheduledAt).toISOString(),
  });
  // Null means the guard in the UPDATE bit: the scheduler claimed it in between.
  if (!updated) return res.status(409).json({ error: 'Post is being published right now — reload to see its result' });
  res.json(withFile(updated));
});

// Bulk "reschedule all": the client computes a new time for every post (it has
// the list and shows a preview before committing), the server applies them in
// one transaction with the same editable-status guard as a single edit.
app.post('/api/posts/reschedule', (req, res) => {
  const changes = req.body?.changes;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 1000) {
    return res.status(400).json({ error: 'changes must be a non-empty array of { id, scheduledAt }' });
  }
  const seen = new Set();
  const clean = [];
  for (const c of changes) {
    const id = Number(c?.id);
    if (!Number.isInteger(id) || seen.has(id)) {
      return res.status(400).json({ error: 'Every change needs a unique numeric post id' });
    }
    if (!c?.scheduledAt || Number.isNaN(Date.parse(c.scheduledAt))) {
      return res.status(400).json({ error: `Post ${id} needs a valid schedule time` });
    }
    seen.add(id);
    clean.push({ id, scheduledAt: new Date(c.scheduledAt).toISOString() });
  }
  res.json(bulkReschedule(clean));
});

app.delete('/api/posts/:id', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status === 'processing') {
    return res.status(409).json({ error: 'Post is currently being published and cannot be deleted' });
  }
  deletePost(post.id);
  fs.rm(path.join(UPLOADS_DIR, post.file_name), { force: true }, () => {});
  res.json({ ok: true });
});

app.post('/api/posts/:id/retry', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!['failed', 'partial'].includes(post.status)) {
    return res.status(409).json({ error: 'Only failed or partially failed posts can be retried' });
  }
  res.json(withFile(retryPost(post.id)));
});

app.get('/auth/youtube', (req, res) => {
  try {
    res.redirect(youtube.authUrl());
  } catch (err) {
    res.status(500).send(String(err.message || err));
  }
});

app.get('/auth/youtube/callback', async (req, res) => {
  try {
    await youtube.handleCallback(req.query.code);
    res.redirect('/?youtube=connected');
  } catch (err) {
    res.status(500).send(`YouTube connection failed: ${String(err.message || err)}`);
  }
});

app.get('/auth/instagram', (req, res) => {
  try {
    res.redirect(instagram.authUrl());
  } catch (err) {
    res.status(500).send(String(err.message || err));
  }
});

app.get('/auth/instagram/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(400).send(`Instagram connection denied: ${req.query.error_description || req.query.error}`);
  }
  try {
    await instagram.handleCallback(req.query.code);
    res.redirect('/?instagram=connected');
  } catch (err) {
    res.status(500).send(`Instagram connection failed: ${String(err.message || err)}`);
  }
});

// Multer and route errors end up here so the frontend gets JSON, not an HTML stack trace.
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const gb = (MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(0);
    return res.status(413).json({ error: `File is larger than the ${gb} GB upload limit (raise MAX_UPLOAD_GB in .env)` });
  }
  res.status(400).json({ error: String(err.message || err) });
});

const server = app.listen(PORT, () => {
  console.log(`Social Scheduler running at http://localhost:${PORT}`);
  instagram
    .refreshTokenIfNeeded()
    .then((r) => {
      if (r.refreshed) console.log('[instagram] access token refreshed, ~60 days remaining');
      else if (r.error) console.warn(`[instagram] token refresh failed: ${r.error}`);
    })
    .catch(() => {});
  startScheduler();

  // Sweep leftovers from interrupted uploads at boot, then once an hour.
  const sweep = () => {
    try {
      const { count, bytes } = sweepOrphans();
      if (count > 0) console.log(`[cleanup] freed ${(bytes / 1024 ** 3).toFixed(2)} GB from ${count} orphaned file(s)`);
    } catch (err) {
      console.warn('[cleanup] sweep failed:', err.message || err);
    }
  };
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
});

// Node's default requestTimeout is 5 minutes, which aborts a multi-GB upload
// mid-stream and answers 408. Uploads here are slow by nature: disable it and
// rely on the socket dying instead.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
