import path from 'node:path';
import cron from 'node-cron';
import { UPLOADS_DIR, getDuePosts, getPost, setPostStatus, setTargetStatus } from './db.js';
import * as youtube from './youtube.js';
import * as instagram from './instagram.js';

let running = false;

export function startScheduler() {
  cron.schedule('* * * * *', () => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err));
  });
  // Also run once at boot so posts that came due while the app was down go out immediately.
  tick().catch((err) => console.error('[scheduler] tick failed:', err));
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const post of getDuePosts()) {
      await processPost(post);
    }
  } finally {
    running = false;
  }
}

async function processPost(post) {
  console.log(`[scheduler] processing post ${post.id} "${post.title}"`);
  setPostStatus(post.id, 'processing');

  const filePath = path.join(UPLOADS_DIR, post.file_name);
  const fileUrl = `${process.env.PUBLIC_BASE_URL || ''}/media/${post.file_name}`;

  for (const target of post.targets) {
    if (target.status === 'done') continue;
    setTargetStatus(target.id, { status: 'processing' });
    try {
      let resultUrl;
      if (target.platform === 'youtube') {
        resultUrl = await youtube.uploadVideo({
          filePath,
          mimeType: post.mime_type,
          title: post.title,
          description: post.description,
        });
      } else if (target.platform === 'instagram') {
        resultUrl = await instagram.publish({
          fileUrl,
          mimeType: post.mime_type,
          caption: [post.title, post.description].filter(Boolean).join('\n\n'),
        });
      } else {
        throw new Error(`Unknown platform: ${target.platform}`);
      }
      setTargetStatus(target.id, { status: 'done', resultUrl });
      console.log(`[scheduler] post ${post.id} → ${target.platform}: ${resultUrl}`);
    } catch (err) {
      setTargetStatus(target.id, { status: 'failed', error: String(err.message || err) });
      console.error(`[scheduler] post ${post.id} → ${target.platform} failed:`, err.message || err);
    }
  }

  const targets = getPost(post.id).targets;
  const failed = targets.filter((t) => t.status === 'failed').length;
  setPostStatus(post.id, failed === 0 ? 'done' : failed === targets.length ? 'failed' : 'partial');
}
