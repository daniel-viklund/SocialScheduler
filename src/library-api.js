import fs from 'node:fs';
import path from 'node:path';
import {
  UPLOADS_DIR,
  listMedia,
  getMedia,
  getMediaByUploadId,
  createMedia,
  updateMedia,
  deleteMedia,
  getNextSlot,
  scheduleMediaBatch,
  getScheduleRequest,
} from './db.js';
import { prepareForInstagram } from './mediacheck.js';

const platforms = ['youtube', 'instagram'];
const validId = (id) =>
  typeof id === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(id);
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
function categories(value) {
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((p) => !platforms.includes(p)) ||
    new Set(value).size !== value.length
  ) {
    fail('Choose YouTube, Instagram, both, or leave the file uncategorized.');
  }
  return value;
}

export function mountLibraryRoutes(app, upload, withFile) {
  // Protect files while asynchronous Instagram validation/remuxing is in flight.
  const busy = new Set();
  const route = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };

  app.get('/api/media', (req, res) =>
    res.set('Cache-Control', 'no-store').json(listMedia().map(withFile)),
  );
  app.post(
    '/api/media',
    upload.single('file'),
    route(async (req, res) => {
      try {
        if (!req.file) fail('Choose a video or image to upload.');
        const uploadId = req.body.uploadId || null;
        if (uploadId && !validId(uploadId)) fail('Invalid upload ID.');
        const existing = uploadId && getMediaByUploadId(uploadId);
        if (existing) {
          fs.rmSync(req.file.path, { force: true });
          return res.json(withFile(existing));
        }
        const selected = categories([].concat(req.body.platforms || []));
        const media = createMedia({
          fileName: req.file.filename,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          platforms: selected,
          uploadId,
        });
        res.status(201).json(withFile(media));
      } catch (err) {
        if (req.file) fs.rmSync(req.file.path, { force: true });
        throw err;
      }
    }),
  );

  app.patch(
    '/api/media/:id',
    route((req, res) => {
      const media = getMedia(Number(req.params.id));
      if (!media) fail('File not found.', 404);
      const title = req.body.title ?? media.title;
      const description = req.body.description ?? media.description;
      if (
        typeof title !== 'string' ||
        title.length > 100 ||
        typeof description !== 'string'
      )
        fail('Enter a title of up to 100 characters and a caption.');
      res.json(
        withFile(
          updateMedia(media.id, {
            title: title.trim(),
            description,
            platforms: categories(req.body.platforms ?? media.platforms),
          }),
        ),
      );
    }),
  );

  app.delete(
    '/api/media/:id',
    route((req, res) => {
      const id = Number(req.params.id);
      if (busy.has(id))
        fail('This file is being scheduled. Try again in a moment.', 409);
      const media = deleteMedia(id);
      if (!media) fail('File not found.', 404);
      fs.rmSync(path.join(UPLOADS_DIR, media.file_name), { force: true });
      res.json({ ok: true });
    }),
  );

  function cleanItems(body, preview) {
    if (!['next', 'manual'].includes(body?.mode))
      fail('Choose next available slots or a specific date.');
    if (
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 100
    )
      fail('Select between 1 and 100 posts.');
    const seen = new Set();
    const held = { youtube: [], instagram: [] };
    return body.items.map((item) => {
      if (
        !Number.isInteger(item?.mediaId) ||
        !platforms.includes(item.platform)
      )
        fail('Each post needs a file and platform.');
      const key = `${item.mediaId}:${item.platform}`;
      if (seen.has(key))
        fail('A file can only appear once per platform in a selection.');
      seen.add(key);
      const media = getMedia(item.mediaId);
      if (!media || withFile(media).file_missing)
        fail('A selected file is missing. Refresh the library.', 409);
      if (item.platform === 'youtube' && !media.mime_type.startsWith('video/'))
        fail(`${media.original_name}: YouTube requires a video.`);
      const title =
        item.title ?? (item.platform === 'youtube' ? media.title : '');
      const description = item.description ?? media.description;
      if (typeof title !== 'string' || typeof description !== 'string')
        fail('Title and caption must be text.');
      if (item.platform === 'youtube' && (!title.trim() || title.length > 100))
        fail(
          `${media.original_name}: add a YouTube title of 1–100 characters.`,
        );
      let scheduledAt = item.scheduledAt;
      let timezone;
      if (preview && body.mode === 'next') {
        const slot = getNextSlot(
          item.platform,
          new Date(),
          held[item.platform],
        );
        scheduledAt = slot.scheduledAt;
        timezone = slot.timezone;
        held[item.platform].push(scheduledAt);
      }
      if (
        (typeof scheduledAt !== 'string' ||
          !Number.isFinite(Date.parse(scheduledAt)) ||
          Date.parse(scheduledAt) <= Date.now())
      )
        fail('Choose a publishing time in the future.');
      return {
        mediaId: media.id,
        platform: item.platform,
        title: title.trim(),
        description,
        scheduledAt: new Date(scheduledAt).toISOString(),
        timezone,
        originalName: media.original_name,
      };
    });
  }

  app.post(
    '/api/media/schedule/preview',
    route((req, res) => {
      res.json({ items: cleanItems(req.body, true) });
    }),
  );
  app.post(
    '/api/media/schedule',
    route(async (req, res) => {
      if (!validId(req.body?.requestId))
        fail('A valid scheduling request ID is required.');
      const existing = getScheduleRequest(req.body.requestId);
      if (existing)
        return res.json({ posts: existing.map(withFile), warnings: [] });
      const items = cleanItems(req.body, false);
      const ids = [...new Set(items.map((item) => item.mediaId))];
      if (ids.some((id) => busy.has(id)))
        fail(
          'A selected file is already being scheduled. Try again in a moment.',
          409,
        );
      ids.forEach((id) => busy.add(id));
      try {
        const warnings = [];
        for (const item of items.filter(
          (item) => item.platform === 'instagram',
        )) {
          const media = getMedia(item.mediaId);
          const result = await prepareForInstagram(
            path.join(UPLOADS_DIR, media.file_name),
            media.mime_type,
          );
          warnings.push(
            ...result.warnings.map(
              (warning) => `${media.original_name}: ${warning}`,
            ),
          );
        }
        const posts = scheduleMediaBatch(
          items,
          req.body.mode,
          req.body.requestId,
        );
        res.status(201).json({ posts: posts.map(withFile), warnings });
      } finally {
        ids.forEach((id) => busy.delete(id));
      }
    }),
  );
}
