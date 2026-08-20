import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { UPLOADS_DIR, createPost, listPosts, getPost, deletePost, retryPost } from './db.js';
import * as youtube from './youtube.js';
import * as instagram from './instagram.js';
import { startScheduler } from './scheduler.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only video and image files are allowed'), ok);
  },
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
  });
});

app.get('/api/posts', (req, res) => {
  res.json(listPosts());
});

app.post('/api/posts', upload.single('file'), (req, res) => {
  // Multer has already written the file to disk; don't leave it orphaned on rejection.
  const reject = (code, error) => {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    res.status(code).json({ error });
  };
  try {
    const { title, description = '', scheduledAt } = req.body;
    const platforms = [].concat(req.body.platforms || []);

    if (!req.file) return reject(400, 'A video or image file is required');
    if (!title?.trim()) return reject(400, 'Title is required');
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
      return reject(400, 'A valid schedule time is required');
    }
    const valid = ['youtube', 'instagram'];
    if (platforms.length === 0 || platforms.some((p) => !valid.includes(p))) {
      return reject(400, 'Pick at least one platform (youtube, instagram)');
    }
    if (platforms.includes('youtube') && !req.file.mimetype.startsWith('video/')) {
      return reject(400, 'YouTube only accepts video files');
    }

    const post = createPost({
      title: title.trim(),
      description,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      scheduledAt: new Date(scheduledAt).toISOString(),
      platforms,
    });
    res.status(201).json(post);
  } catch (err) {
    reject(500, String(err.message || err));
  }
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
  res.json(retryPost(post.id));
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
  res.status(400).json({ error: String(err.message || err) });
});

app.listen(PORT, () => {
  console.log(`Social Scheduler running at http://localhost:${PORT}`);
  instagram
    .refreshTokenIfNeeded()
    .then((r) => {
      if (r.refreshed) console.log('[instagram] access token refreshed, ~60 days remaining');
      else if (r.error) console.warn(`[instagram] token refresh failed: ${r.error}`);
    })
    .catch(() => {});
  startScheduler();
});
