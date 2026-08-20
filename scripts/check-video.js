// Preflight a finished export against Instagram's Reels API limits.
//   node scripts/check-video.js ride.mp4
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/check-video.js <file>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }

let fail = 0;
const ok   = (m) => console.log(`  ok    ${m}`);
const bad  = (m) => { fail++; console.log(`  FAIL  ${m}`); };
const warn = (m) => console.log(`  warn  ${m}`);

const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
], { encoding: 'utf8', maxBuffer: 1 << 24 }));

const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
if (!v) { bad('no video stream'); process.exit(1); }

console.log(`\n${file}\n`);

// --- container ------------------------------------------------------------
const fmt = probe.format.format_name || '';
(/mp4|mov/.test(fmt) ? ok : bad)(`container ${fmt}`);

// --- moov atom position: the one Resolve gives you no control over ---------
// Instagram streams the file; with moov at the end it can reject or stall.
const fd = fs.openSync(file, 'r');
let pos = 0, order = [];
const size = fs.statSync(file).size;
while (pos < size && order.length < 32) {
  const head = Buffer.alloc(16);
  if (fs.readSync(fd, head, 0, 16, pos) < 8) break;
  let boxSize = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  let headerLen = 8;
  if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); headerLen = 16; }
  else if (boxSize === 0) boxSize = size - pos;
  if (boxSize < headerLen) break;
  order.push(type);
  if (type === 'moov' || type === 'mdat') { if (order.filter(t => t === 'moov' || t === 'mdat').length === 1 && type === 'moov') break; }
  pos += boxSize;
}
fs.closeSync(fd);
const iMoov = order.indexOf('moov'), iMdat = order.indexOf('mdat');
if (iMoov === -1) warn('could not locate moov atom');
else if (iMdat !== -1 && iMoov > iMdat) bad('moov atom is at the END — needs +faststart (see remux below)');
else ok('moov atom at front (faststart)');

// --- size / duration / bitrate -------------------------------------------
const mb = size / 1e6;
(mb <= 300 ? ok : bad)(`file size ${mb.toFixed(1)} MB (limit 300 MB)`);

const dur = parseFloat(probe.format.duration || v.duration || 0);
const mins = Math.floor(dur / 60), secs = Math.round(dur % 60);
if (dur < 3) bad(`duration ${dur.toFixed(1)}s (minimum 3s)`);
else if (dur > 900) bad(`duration ${mins}m${secs}s (maximum 15m)`);
else ok(`duration ${mins}m${secs}s`);

const vbr = parseInt(v.bit_rate || probe.format.bit_rate || 0, 10) / 1e6;
if (!vbr) warn('bitrate not reported');
else (vbr <= 25 ? ok : bad)(`video bitrate ${vbr.toFixed(1)} Mbps (limit 25)`);

// --- video stream ---------------------------------------------------------
(/^(h264|hevc)$/.test(v.codec_name) ? ok : bad)(`video codec ${v.codec_name} (need h264 or hevc)`);
(v.pix_fmt === 'yuv420p' ? ok : bad)(`pixel format ${v.pix_fmt} (need yuv420p / 4:2:0)`);
(v.width <= 1920 ? ok : bad)(`${v.width}x${v.height} — horizontal pixels limit is 1920`);

const [n, d] = (v.r_frame_rate || '0/1').split('/').map(Number);
const fps = d ? n / d : 0;
(fps >= 23 && fps <= 60 ? ok : bad)(`${fps.toFixed(2)} fps (allowed 23-60)`);

const ratio = v.width / v.height;
if (Math.abs(ratio - 9 / 16) < 0.02) ok('aspect 9:16');
else if (ratio < 0.01 || ratio > 10) bad(`aspect ${ratio.toFixed(3)}:1 out of range`);
else warn(`aspect ${ratio.toFixed(3)}:1 — allowed, but not 9:16; expect crop or bars`);

// --- audio ----------------------------------------------------------------
if (!a) warn('no audio stream');
else {
  (a.codec_name === 'aac' ? ok : bad)(`audio codec ${a.codec_name} (need aac — MOV/PCM exports fail here)`);
  (Number(a.sample_rate) <= 48000 ? ok : bad)(`sample rate ${a.sample_rate} Hz (max 48000)`);
  (a.channels <= 2 ? ok : bad)(`${a.channels} channel(s) (max 2)`);
}

if (fail) {
  console.log(`\n${fail} problem(s). Lossless fix if only faststart failed:`);
  console.log(`  ffmpeg -i "${file}" -c copy -movflags +faststart "fixed.mp4"\n`);
  process.exit(1);
}
console.log('\nAll checks passed — safe to schedule.\n');
