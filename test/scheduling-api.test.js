import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import without starting the publisher, with a disposable DB and uploads folder.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-scheduler-test-'));
process.env.SCHEDULER_DATA_DIR = dataDir;
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const json = async (url, options) => {
  const res = await fetch(`${base}${url}`, options);
  return { status: res.status, body: await res.json() };
};
const upload = (scheduledAt, scheduleMode) => {
  const body = new FormData();
  body.append('file', new Blob(['test video'], { type: 'video/mp4' }), 'test.mp4');
  body.append('title', 'Test video');
  body.append('platforms', 'youtube');
  body.append('scheduledAt', scheduledAt);
  if (scheduleMode) body.append('scheduleMode', scheduleMode);
  return json('/api/posts', { method: 'POST', body });
};

test('settings, booking conflicts, manual scheduling, editing and deletion', async () => {
  const initial = await json('/api/settings/posting-schedule');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.youtube.days, [5]);
  assert.deepEqual(initial.body.instagram.days, [1, 5]);

  const first = (await json('/api/next-slot?platform=youtube')).body;
  const booked = await upload(first.scheduledAt, 'next');
  assert.equal(booked.status, 201);
  assert.equal(booked.body.scheduled_at, first.scheduledAt);
  const second = (await json('/api/next-slot?platform=youtube')).body;
  assert.notEqual(second.scheduledAt, first.scheduledAt);

  // A second tab cannot book the same suggestion, even concurrently.
  const attempts = await Promise.all([upload(second.scheduledAt, 'next'), upload(second.scheduledAt, 'next')]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
  const stale = await upload(first.scheduledAt, 'next');
  assert.equal(stale.status, 409);

  const settings = structuredClone(initial.body);
  settings.youtube = { days: [3], time: '09:15', timezone: 'America/New_York' };
  const saved = await json('/api/settings/posting-schedule', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await json('/api/settings/posting-schedule')).body, settings);
  assert.deepEqual(JSON.parse(db.getSetting('posting_schedule')), settings);
  assert.equal(db.getPost(booked.body.id).scheduled_at, first.scheduledAt);
  const changed = (await json('/api/next-slot?platform=youtube')).body;
  assert.equal(new Intl.DateTimeFormat('en', { timeZone: changed.timezone, weekday: 'long' }).format(new Date(changed.scheduledAt)), 'Wednesday');

  // A booking on the other platform doesn't consume YouTube's slot.
  const other = db.createPost({ title: '', description: '', fileName: 'other.mp4', originalName: 'other.mp4', mimeType: 'video/mp4', scheduledAt: changed.scheduledAt, platforms: ['instagram'] });
  assert.equal((await json('/api/next-slot?platform=youtube')).body.scheduledAt, changed.scheduledAt);
  const manual = await upload(changed.scheduledAt); // older clients omit scheduleMode
  assert.equal(manual.status, 201);
  assert.notEqual((await json('/api/next-slot?platform=youtube')).body.scheduledAt, changed.scheduledAt);

  // Moving within the same date keeps the day occupied; another date frees it.
  const moved = new Date(Date.parse(changed.scheduledAt) + 3600000).toISOString();
  assert.equal((await json(`/api/posts/${manual.body.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledAt: moved }),
  })).status, 200);
  assert.notEqual((await json('/api/next-slot?platform=youtube')).body.scheduledAt, changed.scheduledAt);
  assert.equal((await upload(changed.scheduledAt, 'next')).status, 409);
  assert.equal((await json(`/api/posts/${manual.body.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledAt: new Date(Date.parse(moved) + 86400000).toISOString() }),
  })).status, 200);
  assert.equal((await json('/api/next-slot?platform=youtube')).body.scheduledAt, changed.scheduledAt);

  // An old booking in the new cadence is honored, regardless of settings age.
  await upload(changed.scheduledAt, 'manual');
  await json('/api/settings/posting-schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initial.body) });
  await json('/api/settings/posting-schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.notEqual((await json('/api/next-slot?platform=youtube')).body.scheduledAt, changed.scheduledAt);

  const invalid = await json('/api/settings/posting-schedule', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, youtube: { ...settings.youtube, days: [] } }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await json('/api/settings/posting-schedule')).body, settings);
  assert.equal((await json('/api/next-slot?platform=invalid')).status, 400);
  db.deletePost(other.id);
  const deleteSlot = (await json('/api/next-slot?platform=youtube')).body.scheduledAt;
  const toDelete = await upload(deleteSlot, 'next');
  assert.equal((await json(`/api/posts/${toDelete.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await json('/api/next-slot?platform=youtube')).body.scheduledAt, deleteSlot);
});

test('queued slots stay distinct and later uploads survive an earlier removal', async () => {
  const first = (await json('/api/next-slot?platform=youtube')).body.scheduledAt;
  const next = await json('/api/next-slot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'youtube', heldSlots: [new Date(Date.parse(first) - 3600000).toISOString()] }),
  });
  assert.equal(next.status, 200);
  assert.notEqual(next.body.scheduledAt, first);
  // The first file was removed from the browser queue without uploading.
  const later = await upload(next.body.scheduledAt, 'next');
  assert.equal(later.status, 201);
  assert.equal((await json('/api/next-slot?platform=youtube')).body.scheduledAt, first);
  assert.equal((await json('/api/next-slot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'youtube', heldSlots: ['invalid'] }),
  })).status, 400);
});

test('retrying an upload after losing the response does not create another post', async () => {
  const scheduledAt = (await json('/api/next-slot?platform=youtube')).body.scheduledAt;
  const send = () => {
    const body = new FormData();
    body.append('file', new Blob(['test'], { type: 'video/mp4' }), 'retry.mp4');
    body.append('title', 'Safe retry');
    body.append('platforms', 'youtube');
    body.append('scheduledAt', scheduledAt);
    body.append('scheduleMode', 'next');
    body.append('uploadId', 'upload-retry-test-12345');
    return json('/api/posts', { method: 'POST', body });
  };
  const before = db.listPosts().length;
  const first = await send();
  const retry = await send();
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(first.body.id, retry.body.id);
  assert.equal(db.listPosts().length, before + 1);
});
