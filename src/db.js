import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scheduler.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS post_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_url TEXT,
    error TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const nowIso = () => new Date().toISOString();

export function createPost({ title, description, fileName, originalName, mimeType, scheduledAt, platforms }) {
  const insertPost = db.prepare(`
    INSERT INTO posts (title, description, file_name, original_name, mime_type, scheduled_at)
    VALUES (@title, @description, @fileName, @originalName, @mimeType, @scheduledAt)
  `);
  const insertTarget = db.prepare(`INSERT INTO post_targets (post_id, platform) VALUES (?, ?)`);

  const tx = db.transaction(() => {
    const { lastInsertRowid } = insertPost.run({ title, description, fileName, originalName, mimeType, scheduledAt });
    for (const platform of platforms) insertTarget.run(lastInsertRowid, platform);
    return lastInsertRowid;
  });
  return getPost(tx());
}

export function getPost(id) {
  const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id);
  if (!post) return null;
  post.targets = db.prepare(`SELECT * FROM post_targets WHERE post_id = ? ORDER BY platform`).all(id);
  return post;
}

export function listPosts() {
  // Soonest first, so the next post to go out is at the top. Posts that have
  // already run sink below the queue, newest first — otherwise something
  // published months ago would sit above everything still waiting.
  const posts = db
    .prepare(
      `SELECT * FROM posts
       ORDER BY
         CASE WHEN status IN ('scheduled', 'processing') THEN 0 ELSE 1 END,
         CASE WHEN status IN ('scheduled', 'processing') THEN scheduled_at END ASC,
         scheduled_at DESC`
    )
    .all();
  const targets = db.prepare(`SELECT * FROM post_targets`).all();
  const byPost = new Map();
  for (const t of targets) {
    if (!byPost.has(t.post_id)) byPost.set(t.post_id, []);
    byPost.get(t.post_id).push(t);
  }
  for (const p of posts) p.targets = (byPost.get(p.id) ?? []).sort((a, b) => a.platform.localeCompare(b.platform));
  return posts;
}

export function getDuePosts() {
  return db
    .prepare(`SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?`)
    .all(nowIso())
    .map((row) => getPost(row.id));
}

export function setPostStatus(id, status) {
  db.prepare(`UPDATE posts SET status = ? WHERE id = ?`).run(status, id);
}

export function setTargetStatus(targetId, { status, resultUrl = null, error = null }) {
  db.prepare(`UPDATE post_targets SET status = ?, result_url = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(status, resultUrl, error, nowIso(), targetId);
}

// Only a post that hasn't gone out yet is worth editing; the WHERE guard makes
// the status check atomic, so an edit can't land while the scheduler publishes.
export const EDITABLE_STATUSES = ['scheduled', 'failed', 'partial'];

export function updatePost(id, { title, description, scheduledAt }) {
  const info = db
    .prepare(
      `UPDATE posts SET title = ?, description = ?, scheduled_at = ?
       WHERE id = ? AND status IN ('scheduled', 'failed', 'partial')`
    )
    .run(title, description, scheduledAt, id);
  return info.changes === 0 ? null : getPost(id);
}

// "Reschedule all" moves many posts at once. Each UPDATE carries the same
// editable-status guard as updatePost, so a post the scheduler claimed in the
// meantime is skipped rather than yanked around mid-publish.
export function bulkReschedule(changes) {
  const stmt = db.prepare(
    `UPDATE posts SET scheduled_at = ? WHERE id = ? AND status IN ('scheduled', 'failed', 'partial')`
  );
  const tx = db.transaction(() => {
    let updated = 0;
    for (const { id, scheduledAt } of changes) updated += stmt.run(scheduledAt, id).changes;
    return updated;
  });
  const updated = tx();
  return { updated, skipped: changes.length - updated };
}

export function deletePost(id) {
  const post = getPost(id);
  if (!post) return null;
  db.prepare(`DELETE FROM post_targets WHERE post_id = ?`).run(id);
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(id);
  return post;
}

// Re-queue failed targets and put the post back on the schedule.
export function retryPost(id) {
  const post = getPost(id);
  if (!post) return null;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status = 'failed'`).run(id);
    db.prepare(`UPDATE posts SET status = 'scheduled' WHERE id = ?`).run(id);
  });
  tx();
  return getPost(id);
}

// Every file the DB still points at. Anything else in uploads/ is dead weight.
export function usedFileNames() {
  return new Set(db.prepare(`SELECT file_name FROM posts`).all().map((r) => r.file_name));
}

export function getSetting(key) {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

export function deleteSetting(key) {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}
