import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-library-test-'));
process.env.SCHEDULER_DATA_DIR = dataDir;
// Exercise the migration against the old schema and a real referenced file.
fs.mkdirSync(path.join(dataDir, 'uploads'));
fs.writeFileSync(path.join(dataDir, 'uploads', 'legacy.mp4'), 'existing media');
const legacy = new Database(path.join(dataDir, 'scheduler.db'));
legacy.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL, original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  CREATE TABLE post_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL,
  platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result_url TEXT, error TEXT, updated_at TEXT);
  INSERT INTO posts (title,file_name,original_name,mime_type,scheduled_at)
  VALUES ('Existing post','legacy.mp4','original.mp4','video/mp4','2099-01-01T12:00:00.000Z');
  INSERT INTO post_targets (post_id,platform) VALUES (1,'youtube');`);
legacy.close();
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const request = async (url, method = 'GET', body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return { status: response.status, body: await response.json() };
};
async function upload(
  platforms = [],
  id = crypto.randomUUID(),
  type = 'video/mp4',
) {
  const body = new FormData();
  body.append(
    'file',
    new Blob(['library media'], { type }),
    type.startsWith('image/') ? 'photo.jpg' : 'my.video.mp4',
  );
  body.append('uploadId', id);
  platforms.forEach((platform) => body.append('platforms', platform));
  const response = await fetch(`${base}/api/media`, { method: 'POST', body });
  return { status: response.status, body: await response.json() };
}
const itemsFor = (media) =>
  media.map((m) => ({ mediaId: m.id, platform: 'youtube' }));

test('existing posts become library files without moving their schedule', async () => {
  const media = (await request('/api/media')).body;
  assert.equal(media.length, 1);
  assert.equal(media[0].file_name, 'legacy.mp4');
  assert.deepEqual(media[0].platforms, ['youtube']);
  assert.equal(media[0].post_count, 1);
  assert.equal(db.getPost(1).scheduled_at, '2099-01-01T12:00:00.000Z');
  await request('/api/posts/1', 'DELETE');
  assert.ok(fs.existsSync(path.join(db.UPLOADS_DIR, 'legacy.mp4')));
});

test('uploads persist without dates or posts, support categories and safe retries', async () => {
  const before = db.listPosts().length;
  const id = crypto.randomUUID();
  const first = await upload(['youtube', 'instagram'], id);
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.platforms, ['youtube', 'instagram']);
  assert.equal(first.body.title, 'my.video');
  assert.equal(first.body.post_count, 0);
  assert.equal(db.listPosts().length, before);
  assert.ok(
    !db.getDuePosts().some((post) => post.file_name === first.body.file_name),
  );
  const retry = await upload(['youtube'], id);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  const edit = await request(`/api/media/${first.body.id}`, 'PATCH', {
    platforms: [],
    title: 'Later',
    description: 'A saved caption',
  });
  assert.deepEqual(edit.body.platforms, []);
  assert.equal(db.getMedia(first.body.id).description, 'A saved caption');
  assert.equal(
    (
      await request(`/api/media/${first.body.id}`, 'PATCH', {
        platforms: ['invalid'],
      })
    ).status,
    400,
  );
  assert.equal((await upload(['invalid'])).status, 400);
  assert.ok(db.usedFileNames().has(first.body.file_name));
});

test('cleanup keeps old unscheduled files; explicit deletion removes them', async () => {
  const { body: media } = await upload();
  const file = path.join(db.UPLOADS_DIR, media.file_name);
  const old = new Date(Date.now() - 7200000);
  fs.utimesSync(file, old, old);
  const orphan = path.join(db.UPLOADS_DIR, 'abandoned.mp4');
  fs.writeFileSync(orphan, 'abandoned');
  fs.utimesSync(orphan, old, old);
  const cleanup = await request('/api/storage/cleanup', 'POST');
  assert.equal(cleanup.body.count, 1);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(orphan));
  assert.equal((await request(`/api/media/${media.id}`, 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(file));
});

test('batch preview is read-only, books distinct slots, and confirmation is idempotent', async () => {
  const media = [
    (await upload(['youtube'])).body,
    (await upload(['youtube'])).body,
  ];
  const before = db.listPosts().length;
  const preview = await request('/api/media/schedule/preview', 'POST', {
    mode: 'next',
    items: itemsFor(media),
  });
  assert.equal(preview.status, 200);
  assert.notEqual(
    preview.body.items[0].scheduledAt,
    preview.body.items[1].scheduledAt,
  );
  assert.equal(db.listPosts().length, before);
  const body = {
    mode: 'next',
    items: preview.body.items,
    requestId: crypto.randomUUID(),
  };
  const first = await request('/api/media/schedule', 'POST', body);
  assert.equal(first.status, 201);
  const retry = await request('/api/media/schedule', 'POST', body);
  assert.equal(retry.status, 200);
  assert.deepEqual(
    first.body.posts.map((p) => p.id),
    retry.body.posts.map((p) => p.id),
  );
  assert.equal(db.listPosts().length, before + 2);
  assert.equal(db.getMedia(media[0].id).post_count, 1);
  assert.equal(
    (await request(`/api/media/${media[0].id}`, 'DELETE')).status,
    409,
  );
  await request(`/api/posts/${first.body.posts[0].id}`, 'DELETE');
  assert.ok(fs.existsSync(path.join(db.UPLOADS_DIR, media[0].file_name)));
  assert.equal(db.getMedia(media[0].id).post_count, 0);
});

test('a stale slot rolls back the entire batch, including earlier valid items', async () => {
  const media = [(await upload()).body, (await upload()).body];
  const preview = (
    await request('/api/media/schedule/preview', 'POST', {
      mode: 'next',
      items: itemsFor(media),
    })
  ).body;
  const occupied = preview.items[1];
  const booked = await request('/api/media/schedule', 'POST', {
    mode: 'manual',
    items: [occupied],
    requestId: crypto.randomUUID(),
  });
  assert.equal(booked.status, 201);
  const before = db.listPosts().length;
  const conflict = await request('/api/media/schedule', 'POST', {
    mode: 'next',
    items: preview.items,
    requestId: crypto.randomUUID(),
  });
  assert.equal(conflict.status, 409);
  assert.equal(db.listPosts().length, before);
  assert.equal(db.getMedia(media[0].id).post_count, 0);
});

test('manual scheduling reuses a file safely and rejects invalid selections', async () => {
  const media = (await upload()).body;
  const date = new Date(Date.now() + 86400000).toISOString();
  const item = { mediaId: media.id, platform: 'youtube', scheduledAt: date };
  const body = {
    mode: 'manual',
    items: [item],
    requestId: crypto.randomUUID(),
  };
  const first = await request('/api/media/schedule', 'POST', body);
  const second = await request('/api/media/schedule', 'POST', {
    ...body,
    requestId: crypto.randomUUID(),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  await request(`/api/posts/${first.body.posts[0].id}`, 'DELETE');
  assert.ok(fs.existsSync(path.join(db.UPLOADS_DIR, media.file_name)));
  assert.equal(db.getMedia(media.id).post_count, 1);
  for (const items of [
    [],
    [item, item],
    [{ ...item, title: '' }],
    [{ ...item, platform: 'invalid' }],
    [{ ...item, scheduledAt: '2000-01-01' }],
    [{ ...item, mediaId: 999999 }],
  ]) {
    assert.ok(
      (
        await request('/api/media/schedule/preview', 'POST', {
          mode: 'manual',
          items,
        })
      ).status >= 400,
    );
  }
  const image = (await upload([], crypto.randomUUID(), 'image/jpeg')).body;
  assert.equal(
    (
      await request('/api/media/schedule/preview', 'POST', {
        mode: 'manual',
        items: [{ ...item, mediaId: image.id }],
      })
    ).status,
    400,
  );
  fs.rmSync(path.join(db.UPLOADS_DIR, media.file_name));
  assert.equal(
    (
      await request('/api/media/schedule', 'POST', {
        ...body,
        requestId: crypto.randomUUID(),
      })
    ).status,
    409,
  );
});

test('Instagram validation failure leaves every selected file unscheduled and available', async () => {
  const media = [(await upload()).body, (await upload(['instagram'])).body];
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();
  const before = db.listPosts().length;
  const response = await request('/api/media/schedule', 'POST', {
    mode: 'manual',
    requestId: crypto.randomUUID(),
    items: [
      { mediaId: media[0].id, platform: 'youtube', scheduledAt },
      { mediaId: media[1].id, platform: 'instagram', scheduledAt },
    ],
  });
  assert.equal(response.status, 400);
  assert.equal(db.listPosts().length, before);
  for (const file of media)
    assert.ok(fs.existsSync(path.join(db.UPLOADS_DIR, file.file_name)));
  // Locks are released after failure, so files can be removed.
  assert.equal(
    (await request(`/api/media/${media[1].id}`, 'DELETE')).status,
    200,
  );
});

