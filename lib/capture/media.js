/**
 * Soul Jam Capture — media helpers on recorded files (ffmpeg-static; no paid services):
 * probe (duration, codec, size, frame rate), a still frame, and a cheap motion map (where in the
 * picture things moved during the take — used to warn when the athlete ran out of frame).
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const FFMPEG = require('ffmpeg-static');

function run(args, { timeoutMs = 60000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
  });
}

/** Duration / codec / size / fps of a recording (from ffmpeg's own stream info + a decode pass). */
async function probe(file) {
  // decode to null: the real frame count and duration (a MediaRecorder WebM header often has none)
  const r = await run(['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: 180000 });
  const s = r.stderr;
  const v = s.match(/Stream #\d+:\d+[^:]*: Video: ([a-z0-9]+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/);
  const a = /Stream #\d+:\d+[^:]*: Audio: ([a-z0-9]+)/.exec(s);
  const fpsHdr = v && /, ([\d.]+) fps/.exec(v[0]);
  const frames = [...s.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]).pop() || 0;
  const times = [...s.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3]);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
  const durationSec = times.length ? times.pop() : dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0;
  return {
    ok: r.code === 0 && !!v,
    codec: v?.[1] || null, width: v ? +v[2] : null, height: v ? +v[3] : null,
    headerFps: fpsHdr ? +fpsHdr[1] : null, frames, durationSec: +durationSec.toFixed(3),
    fps: durationSec > 0 && frames ? +(frames / durationSec).toFixed(2) : null,
    audio: a?.[1] || null,
  };
}

/** A JPEG still at `t` seconds (for calibration landmark taps / previews). */
async function still(file, t = 1, out = null) {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', out || '-'], { binary: true });
  if (r.code !== 0) throw new Error('still failed: ' + r.stderr.slice(-200));
  return out || r.stdout;
}

/**
 * Where did things move? `n` downscaled grey frames across the take, differenced: the bounding
 * box of the pixels that changed (fractions of the frame) and how much of the motion touched
 * each edge. Cheap (a few hundred ms) — a proxy for "the athlete left the picture".
 */
async function motionMap(file, { n = 16, w = 96, h = 54, durationSec = null } = {}) {
  const d = durationSec || (await probe(file)).durationSec || 4;
  const fps = Math.max(0.5, n / Math.max(0.5, d));
  const r = await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps.toFixed(3)},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { binary: true, timeoutMs: 120000 });
  const buf = r.stdout, F = Math.floor(buf.length / (w * h));
  if (F < 2) return null;
  const moved = new Float32Array(w * h);
  for (let f = 1; f < F; f++) for (let i = 0; i < w * h; i++) { const dv = Math.abs(buf[f * w * h + i] - buf[(f - 1) * w * h + i]); if (dv > 24) moved[i]++; }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, total = 0;
  const edge = { left: 0, right: 0, top: 0, bottom: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const m = moved[y * w + x]; if (m < 2) continue;
    total += m; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    if (x <= 1) edge.left += m; if (x >= w - 2) edge.right += m; if (y <= 1) edge.top += m; if (y >= h - 2) edge.bottom += m;
  }
  if (x1 < 0) return { frames: F, bbox: null, total: 0, edges: edge };
  return { frames: F, bbox: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h].map((v) => +v.toFixed(3)), total, edges: Object.fromEntries(Object.entries(edge).map(([k, v]) => [k, +(v / total).toFixed(3)])) };
}

module.exports = { probe, still, motionMap, run, FFMPEG };
