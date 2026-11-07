import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cardSource = source.slice(source.indexOf('function mediaCard('), source.indexOf('function updateSelection('));
const context = vm.createContext({
  state: { selected: new Set() },
  esc: String,
  icon: () => '<svg></svg>',
  size: () => '1 MB',
  badge: () => '',
});
vm.runInContext(cardSource, context);
const media = {
  id: 'example', file_name: 'large.mp4', original_name: 'large.mp4',
  mime_type: 'video/mp4', file_size: 100000000, created_at: '2026-11-07',
  platforms: [], post_count: 0,
};

test('library video cards do not start media downloads and still offer previews', () => {
  const html = context.mediaCard(media);
  assert.doesNotMatch(html, /<(video|source)\b|src="\/media\//);
  assert.match(html, /data-detail="example"/);
  assert.match(html, /data-schedule="example"/);
});

test('library image cards keep lazy thumbnails', () => {
  const html = context.mediaCard({ ...media, mime_type: 'image/jpeg', file_name: 'photo.jpg' });
  assert.match(html, /<img src="\/media\/photo.jpg"[^>]*loading="lazy"/);
  assert.doesNotMatch(context.mediaCard({ ...media, file_missing: true }), /src="\/media\//);
});
