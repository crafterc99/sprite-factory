/**
 * Soul Jam Capture — exact two-camera sync from the audible sync event.
 *
 * The director plays a short up-chirp (capture/camera-sync.mjs CHIRP) a fixed time after the start
 * of every take; both cameras' microphones record it. This finds the chirp in each recording by a
 * matched filter (normalised cross-correlation with the synthesised chirp, in a window around
 * where the session clock says it should be) and reports where it is in each file's own timeline.
 * The difference is the cameras' offset to within a sample (1/16000 s) — independent of browser
 * clocks — and it is cross-checked against the frame-timestamp estimate.
 */
'use strict';
const media = require('./media');

const SR = 16000;
const CHIRP = { f0: 1800, f1: 5200, durationMs: 90 };           // = capture/camera-sync.mjs

function chirpTemplate(c = CHIRP, sr = SR) {
  const n = Math.round((c.durationMs / 1000) * sr), out = new Float32Array(n), T = c.durationMs / 1000, k = Math.log(c.f1 / c.f0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = (2 * Math.PI * c.f0 * T * (Math.exp((t / T) * k) - 1)) / k;   // exponential sweep, as WebAudio's exponentialRamp
    const env = Math.min(1, t / 0.005, (T - t) / 0.01);
    out[i] = Math.sin(ph) * Math.max(0, env);
  }
  return out;
}

/** Mono 16 kHz PCM of a recording's audio (Float32Array; the first maxSec), or null if it has no audio. */
async function pcm(file, { maxSec = 600 } = {}) {
  const r = await media.run(['-hide_banner', '-loglevel', 'error', '-i', file, '-t', String(maxSec), '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { binary: true, timeoutMs: 120000 });
  if (r.code !== 0 || !r.stdout.length) return null;
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)));
}

// in-place radix-2 FFT (re, im: Float64Array of length 2^k)
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Where is the chirp in this audio? `aroundSec` = expected time (from the session clock), searched
 * ± windowSec (the whole file without it). Normalised cross-correlation via FFT (fast on minutes
 * of audio). Returns { atSec, score (0–1), snr } or null.
 */
/** Normalised cross-correlation of the template at start positions lo…hi (one FFT). */
function scan(x, lo, hi, tpl, tn, scores) {
  const m = tpl.length;
  const seg = x.subarray(lo, hi + m);
  let N = 1; while (N < seg.length + m) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(seg); br.set(tpl);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < N; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }   // A · conj(B)
  fft(ar, ai, true);
  const cs = new Float64Array(seg.length + 1);                         // cumulative energy
  for (let i = 0; i < seg.length; i++) cs[i + 1] = cs[i] + seg[i] * seg[i];
  let best = -1, at = -1;
  for (let s = 0; s <= hi - lo; s++) {
    const e = cs[s + m] - cs[s];
    const sc = e > 1e-9 ? ar[s] / (Math.sqrt(e) * tn) : 0;
    if ((s + lo) % 16 === 0) scores.push(Math.abs(sc));
    if (sc > best) { best = sc; at = s + lo; }
  }
  return { best, at };
}
const range = (x, m, aroundSec, windowSec) => [
  aroundSec == null ? 0 : Math.max(0, Math.floor((aroundSec - windowSec) * SR)),
  aroundSec == null ? x.length - m : Math.min(x.length - m, Math.ceil((aroundSec + windowSec) * SR)),
];
const tplNorm = (tpl) => { let tn = 0; for (let i = 0; i < tpl.length; i++) tn += tpl[i] * tpl[i]; return Math.sqrt(tn); };
function result(best, at, scores) {
  if (at < 0) return null;
  scores.sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] || 1e-6;
  return { atSec: +(at / SR).toFixed(5), score: +best.toFixed(3), snr: +(best / median).toFixed(1) };
}
function findChirp(x, { aroundSec = null, windowSec = 2.5, tpl = chirpTemplate() } = {}) {
  if (!x || x.length < tpl.length + 10) return null;
  const [lo, hi] = range(x, tpl.length, aroundSec, windowSec);
  if (hi <= lo) return null;
  const scores = [], r = scan(x, lo, hi, tpl, tplNorm(tpl), scores);
  return result(r.best, r.at, scores);
}
/**
 * The same search over a long recording (a whole native file): in ~4 s pieces, giving the event
 * loop back between them, so the server keeps answering while it runs.
 */
async function findChirpAsync(x, { aroundSec = null, windowSec = 2.5, tpl = chirpTemplate(), segSec = 4 } = {}) {
  if (!x || x.length < tpl.length + 10) return null;
  const [lo, hi] = range(x, tpl.length, aroundSec, windowSec);
  if (hi <= lo) return null;
  const tn = tplNorm(tpl), scores = [], step = Math.round(segSec * SR);
  let best = -1, at = -1;
  for (let a = lo; a <= hi; a += step) {
    const r = scan(x, a, Math.min(hi, a + step - 1), tpl, tn, scores);
    if (r.best > best) { best = r.best; at = r.at; }
    await new Promise((res) => setImmediate(res));
  }
  return result(best, at, scores);
}

/**
 * Sync a take: the chirp in each camera's recording → the offset between the cameras' timelines.
 * @param take the take record (sync.chirp.atServerMs, cameras[cam].startedAtServerMs)
 * @param files { camA: path, camB: path }
 */
async function syncTake(take, files) {
  const out = { method: 'chirp', sampleRate: SR, cams: {} };
  const chirpAt = take.sync?.chirp?.atServerMs;
  for (const [cam, f] of Object.entries(files)) {
    if (!f) continue;
    const x = await pcm(f).catch(() => null);
    if (!x) { out.cams[cam] = { found: false, why: 'no audio track' }; continue; }
    const started = take.cameras?.[cam]?.startedAtServerMs;
    const expect = chirpAt && started ? (chirpAt - started) / 1000 : null;
    const r = await findChirpAsync(x, { aroundSec: expect });
    const ok = !!r && r.score > 0.25 && r.snr > 3;
    out.cams[cam] = { found: ok, ...(r || {}), expectedSec: expect != null ? +expect.toFixed(4) : null };
  }
  const a = out.cams.camA, b = out.cams.camB;
  if (a?.found && b?.found) {
    // the same instant is at a.atSec in A's file and b.atSec in B's: B's file starts (a − b) s after A's
    out.offsetSec = +(a.atSec - b.atSec).toFixed(5);
    const sa = take.cameras?.camA?.startedAtServerMs, sb = take.cameras?.camB?.startedAtServerMs;
    if (sa && sb) { out.clockOffsetSec = +((sb - sa) / 1000).toFixed(4); out.clockErrorMs = +((out.clockOffsetSec - out.offsetSec) * 1000).toFixed(1); }
  }
  return out;
}

module.exports = { syncTake, findChirp, findChirpAsync, chirpTemplate, pcm, fft, SR, CHIRP };
