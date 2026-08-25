// Preflight a finished export against Instagram's Reels API limits.
//   node scripts/check-video.js ride.mp4
//
// The upload route runs the same check automatically when Instagram is a
// target; this is for checking an export before you upload it.
import fs from 'node:fs';
import { checkReel } from '../src/mediacheck.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/check-video.js <file>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }

const { results, problems, warnings, needsFaststart } = await checkReel(file);

console.log(`\n${file}\n`);
for (const r of results) {
  const tag = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[r.level];
  console.log(`  ${tag}  ${r.text}`);
}

if (problems.length) {
  console.log(`\n${problems.length + (needsFaststart ? 1 : 0)} problem(s) — re-export.\n`);
  process.exit(1);
}
if (needsFaststart) {
  console.log('\nOnly faststart failed. The server fixes this on upload; to fix it yourself, losslessly:');
  console.log(`  ffmpeg -i "${file}" -c copy -movflags +faststart "fixed.mp4"\n`);
  process.exit(0);
}
console.log(`\nAll checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''} — safe to schedule.\n`);
