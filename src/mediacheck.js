// Preflight media against Instagram's content-publishing limits.
//
// Instagram fetches the file when the post is due and only then says "ERROR",
// hours after anyone was looking. Everything here can be decided at upload
// time instead, from container headers alone, so a bad export is bounced
// while the file is still open in the editor.
//
// Used by the upload route (blocking, when Instagram is a target) and by
// `npm run check:video` (prints the same results for a file on disk).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

// Reels via the API: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media#reel-specifications
export const REEL_MAX_BYTES = 300 * 1e6;
// Feed images: JPEG only, 8 MB, aspect 4:5 .. 1.91:1.
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

// Thrown for verdicts the user has to act on (as opposed to ffprobe being
// missing, which is a server problem). `problems` carries the individual lines.
export class MediaError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'MediaError';
    this.problems = problems;
  }
}

export async function probe(file) {
  let stdout;
  try {
    ({ stdout } = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { maxBuffer: 1 << 24 }));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('ffprobe not found — install ffmpeg on the server to validate Instagram media');
    }
    throw new Error(`ffprobe could not read the file: ${(err.stderr || err.message).trim()}`);
  }
  return JSON.parse(stdout);
}

// Instagram streams the file, and with the moov atom after mdat it can reject
// or stall. Most editors (Resolve included) write it at the end by default.
// Returns true (at end), false (at front) or null (could not tell).
export function moovAtEnd(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 32 && pos < size; i++) {
      if (fs.readSync(fd, head, 0, 16, pos) < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); headerLen = 16; }
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < headerLen) break;
      if (type === 'moov') return false;
      if (type === 'mdat') return true;
      pos += boxSize;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Each entry: { level: 'ok' | 'warn' | 'fail', text, fixable? }. `fixable`
// marks the one failure a lossless remux repairs (see remuxFaststart).
function collector() {
  const results = [];
  return {
    results,
    ok: (text) => results.push({ level: 'ok', text }),
    warn: (text) => results.push({ level: 'warn', text }),
    fail: (text, fixable = false) => results.push({ level: 'fail', text, fixable }),
    check: (cond, text) => results.push({ level: cond ? 'ok' : 'fail', text, fixable: false }),
  };
}

function summarize(results) {
  return {
    results,
    problems: results.filter((r) => r.level === 'fail' && !r.fixable).map((r) => r.text),
    warnings: results.filter((r) => r.level === 'warn').map((r) => r.text),
    needsFaststart: results.some((r) => r.level === 'fail' && r.fixable),
  };
}

export async function checkReel(file) {
  const c = collector();
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v) {
    c.fail('no video stream');
    return summarize(c.results);
  }

  const fmt = info.format.format_name || '';
  c.check(/mp4|mov/.test(fmt), `container ${fmt} (need MP4 or MOV)`);

  const moov = moovAtEnd(file);
  if (moov === null) c.warn('could not locate moov atom');
  else if (moov) c.fail('moov atom is at the END — needs +faststart', true);
  else c.ok('moov atom at front (faststart)');

  const size = fs.statSync(file).size;
  const mb = size / 1e6;
  c.check(size <= REEL_MAX_BYTES, `file size ${mb.toFixed(1)} MB (limit 300 MB)`);

  const dur = parseFloat(info.format.duration || v.duration || 0);
  const mins = Math.floor(dur / 60), secs = Math.round(dur % 60);
  if (dur < 3) c.fail(`duration ${dur.toFixed(1)}s (minimum 3s)`);
  else if (dur > 900) c.fail(`duration ${mins}m${secs}s (maximum 15m)`);
  else c.ok(`duration ${mins}m${secs}s`);

  const vbr = parseInt(v.bit_rate || info.format.bit_rate || 0, 10) / 1e6;
  if (!vbr) c.warn('bitrate not reported');
  else c.check(vbr <= 25, `video bitrate ${vbr.toFixed(1)} Mbps (limit 25)`);

  c.check(/^(h264|hevc)$/.test(v.codec_name), `video codec ${v.codec_name} (need h264 or hevc)`);
  c.check(v.pix_fmt === 'yuv420p', `pixel format ${v.pix_fmt} (need yuv420p / 4:2:0)`);
  c.check(v.width <= 1920, `${v.width}x${v.height} (horizontal pixel limit is 1920)`);

  const [n, d] = (v.r_frame_rate || '0/1').split('/').map(Number);
  const fps = d ? n / d : 0;
  c.check(fps >= 23 && fps <= 60, `${fps.toFixed(2)} fps (allowed 23-60)`);

  const ratio = v.width / v.height;
  if (Math.abs(ratio - 9 / 16) < 0.02) c.ok('aspect 9:16');
  else if (ratio < 0.01 || ratio > 10) c.fail(`aspect ${ratio.toFixed(3)}:1 out of range`);
  else c.warn(`aspect ${ratio.toFixed(3)}:1 is allowed but not 9:16 — expect crop or bars`);

  if (!a) c.warn('no audio stream');
  else {
    c.check(a.codec_name === 'aac', `audio codec ${a.codec_name} (need aac — MOV/PCM exports fail here)`);
    c.check(Number(a.sample_rate) <= 48000, `sample rate ${a.sample_rate} Hz (max 48000)`);
    c.check(a.channels <= 2, `${a.channels} audio channel(s) (max 2)`);
  }

  return summarize(c.results);
}

export async function checkImage(file) {
  const c = collector();
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) {
    c.fail('not a readable image');
    return summarize(c.results);
  }

  c.check(v.codec_name === 'mjpeg', `format ${v.codec_name === 'mjpeg' ? 'JPEG' : v.codec_name} (Instagram only accepts JPEG)`);

  const size = fs.statSync(file).size;
  c.check(size <= IMAGE_MAX_BYTES, `file size ${(size / 1048576).toFixed(1)} MB (limit 8 MB)`);

  const ratio = v.width / v.height;
  c.check(ratio >= 0.8 - 0.005 && ratio <= 1.91 + 0.005,
    `aspect ${ratio.toFixed(2)}:1 (allowed 4:5 through 1.91:1)`);
  if (v.width > 1440) c.warn(`${v.width}x${v.height} will be scaled down to 1440 px wide`);
  else c.ok(`${v.width}x${v.height}`);

  return summarize(c.results);
}

// Lossless: copies the streams into a new container with moov at the front,
// then replaces the original. A few seconds even on a Pi.
export async function remuxFaststart(file) {
  const ext = path.extname(file);
  const tmp = `${file.slice(0, -ext.length || undefined)}.faststart${ext}`;
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-c', 'copy', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    const detail = err.code === 'ENOENT' ? 'ffmpeg not found' : (err.stderr || err.message).trim();
    throw new Error(`faststart remux failed: ${detail}`);
  }
}

// What the upload route calls. Resolves with { warnings } once the file is
// acceptable — repairing the moov position in place if that is all that is
// wrong — and throws MediaError with the full list otherwise.
export async function prepareForInstagram(file, mimeType) {
  const isVideo = mimeType.startsWith('video/');
  const verdict = isVideo ? await checkReel(file) : await checkImage(file);
  const warnings = [...verdict.warnings];

  if (verdict.problems.length) {
    const lines = [...verdict.problems];
    // Worth knowing for the re-export, even though it would have been fixed.
    if (verdict.needsFaststart) lines.push('moov atom at the end (export with faststart)');
    throw new MediaError(
      `Not allowed on Instagram ${isVideo ? 'Reels' : 'feed'}: ${lines.join('; ')}`,
      lines
    );
  }
  if (verdict.needsFaststart) {
    await remuxFaststart(file);
    warnings.push('moov atom was at the end — remuxed with +faststart');
  }
  return { warnings };
}
