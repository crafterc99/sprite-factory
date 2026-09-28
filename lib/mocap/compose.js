/**
 * Compose — generated image → aligned, QC'd, game-ready sprite frame.
 *
 * Sizing never comes from the generated image. The mannequin render for the
 * frame is the ground truth: the generated character is scaled/translated so
 * its silhouette matches the mannequin (feet on the ground line, same height,
 * same horizontal centre), with the per-frame scale clamped around the
 * animation's median so one odd frame can't pump the size.
 *
 * The ball is never generated: the canonical ball sprite is composited at the
 * mocap ball position, in front of or behind the body.
 *
 * Game frame: 180×180, feet at y=170 (PlayerRenderer origin 0.5, 0.97),
 * character stature = registry pixelHeight, same crop window every frame.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { CANVAS, ballPng, alphaStats } = require('./mannequin');

const GAME = { size: 180, baseline: 170 };
const HIRES = 3; // stored per-frame assets at 540×540

async function removeGreen(buf) {
  const { removeGreenBackground } = require('../sprite-processor/index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-green-'));
  try {
    const a = path.join(dir, 'in.png'), b = path.join(dir, 'out.png');
    fs.writeFileSync(a, buf);
    await removeGreenBackground(a, b, { feather: 1 });
    return fs.readFileSync(b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Keep only the largest opaque blob (drops stray specks the model adds). */
async function largestBlob(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const lab = new Int32Array(W * H).fill(-1);
  const sizes = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (lab[i] !== -1 || data[i * 4 + 3] <= 24) continue;
    const id = sizes.length; let n = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const j = stack.pop(); n++;
      const x = j % W, y = (j / W) | 0;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of nb) if (k >= 0 && lab[k] === -1 && data[k * 4 + 3] > 24) { lab[k] = id; stack.push(k); }
    }
    sizes.push(n);
  }
  if (sizes.length <= 1) return buf;
  const keepMin = Math.max(...sizes) * 0.04; // keep big pieces (e.g. a detached hand), drop specks
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && sizes[lab[i]] < keepMin) data[i * 4 + 3] = 0;
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/**
 * Prepare a raw generation: background → alpha, onto the mannequin canvas
 * width, largest blob. Returns { buf, stats }.
 */
async function prepareGenerated(rawBuf, transparent) {
  let buf = transparent ? rawBuf : await removeGreen(rawBuf);
  buf = await sharp(buf).ensureAlpha().resize({ width: CANVAS.w }).png().toBuffer();
  buf = await largestBlob(buf);
  const stats = await alphaStats(buf);
  if (!stats) throw new Error('Generated image is empty after background removal');
  return { buf, stats };
}

/** Scale factor that makes the generated silhouette as tall as the mannequin's. */
function fitScaleFor(genStats, poseBBox) {
  return poseBBox.h / genStats.h;
}

/** Place the prepared character on the mannequin canvas at scale k. */
async function placeOnCanvas(prep, poseBBox, k) {
  const w = Math.max(1, Math.round((await sharp(prep.buf).metadata()).width * k));
  const scaled = await sharp(prep.buf).resize({ width: w, kernel: 'lanczos3' }).png().toBuffer();
  const meta = await sharp(scaled).metadata();
  // feet: generated bbox bottom → mannequin bbox bottom; x: centroid → centroid
  const left = Math.round(poseBBox.cx - prep.stats.cx * k);
  const top = Math.round(poseBBox.maxY - (prep.stats.maxY + 1) * k + 1);
  // Composite onto an oversized canvas then crop, so off-canvas parts don't throw
  const pad = Math.max(meta.width, meta.height);
  const big = await sharp({ create: { width: CANVAS.w + 2 * pad, height: CANVAS.h + 2 * pad, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: scaled, left: left + pad, top: top + pad }]).png().toBuffer();
  return sharp(big).extract({ left: pad, top: pad, width: CANVAS.w, height: CANVAS.h }).png().toBuffer();
}

/** Add the canonical ball at the mocap position (behind or in front of the body). */
async function compositeBall(charBuf, ballPx) {
  if (!ballPx || !(ballPx.r > 1)) return charBuf;
  const b = await ballPng(ballPx.r);
  const bm = await sharp(b).metadata();
  const left = Math.round(ballPx.x - bm.width / 2), top = Math.round(ballPx.y - bm.height / 2);
  if (left < -bm.width || top < -bm.height || left > CANVAS.w || top > CANVAS.h) return charBuf;
  const layer = await sharp({ create: { width: CANVAS.w, height: CANVAS.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: b, left: Math.max(-bm.width + 1, left), top: Math.max(-bm.height + 1, top) }]).png().toBuffer();
  if (ballPx.behind) {
    return sharp(layer).composite([{ input: charBuf }]).png().toBuffer();
  }
  return sharp(charBuf).composite([{ input: layer }]).png().toBuffer();
}

// ── QC ─────────────────────────────────────────────────────────────────────
async function alphaGrid(buf, w = 128, h = 192) {
  const { data } = await sharp(buf).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = data[i * 4 + 3] > 64 ? 1 : 0;
  return { g, w, h };
}

function dilate({ g, w, h }, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!g[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1;
    }
  }
  return { g: out, w, h };
}

/**
 * Silhouette agreement with the mannequin. Clothing/hair make the character
 * bigger than the mannequin, so "spill" is measured against a dilated mannequin.
 */
async function silhouetteQC(charBuf, poseAlphaBuf) {
  const c = await alphaGrid(charBuf);
  const p = await alphaGrid(poseAlphaBuf);
  const pd = dilate(p, 4);
  const cd = dilate(c, 2);
  let pN = 0, covered = 0, cN = 0, spill = 0;
  for (let i = 0; i < c.g.length; i++) {
    if (p.g[i]) { pN++; if (cd.g[i]) covered++; }
    if (c.g[i]) { cN++; if (!pd.g[i]) spill++; }
  }
  return { coverage: pN ? covered / pN : 0, spill: cN ? spill / cN : 1 };
}

/** Colour histogram (4 bits/channel → 512 bins) of opaque pixels + orange share. */
async function colorProfile(buf) {
  const { data } = await sharp(buf).ensureAlpha().resize(160, 240, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const hist = new Float64Array(512);
  let n = 0, orange = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)]++;
    n++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 90 && (mx - mn) / mx > 0.5 && mx === r) {
      const hue = (60 * (g - b)) / (mx - mn);
      if (hue >= 10 && hue <= 38) orange++;
    }
  }
  if (n) for (let i = 0; i < 512; i++) hist[i] /= n;
  return { hist, orangeShare: n ? orange / n : 0 };
}

/**
 * Did the model draw a basketball? Looks for a bright, saturated orange blob
 * that is round and ball-sized (expected radius from the mocap). Skin and
 * arms fail at least one of: colour, roundness, size.
 */
async function detectDrawnBall(buf, expectedR = 40) {
  const scale = 0.5;
  const { data, info } = await sharp(buf).ensureAlpha().resize({ width: Math.round(CANVAS.w * scale) }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (a < 128) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx !== r || mx < 140 || (mx - mn) / mx < 0.65) continue;
    const hue = (60 * (g - b)) / (mx - mn);
    if (hue >= 12 && hue <= 34) m[i] = 1;
  }
  // Close the seam lines (dilate 3px) so a ball reads as one round blob
  const d = new Uint8Array(W * H);
  const R = 3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H && dx * dx + dy * dy <= R * R) d[Y * W + X] = 1;
    }
  }
  m.set(d);
  const seen = new Uint8Array(W * H);
  const er = expectedR * scale + R;
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1;
    let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (st.length) {
      const j = st.pop(); n++;
      const x = j % W, y = (j / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && m[k] && !seen[k]) { seen[k] = 1; st.push(k); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, r = Math.max(bw, bh) / 2;
    const round = bw / bh > 0.7 && bw / bh < 1.4 && n / (bw * bh) > 0.55;
    if (round && r > er * 0.5 && r < er * 1.8) return true;
  }
  return false;
}

function histIntersection(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
  return s;
}

const QC_LIMITS = { coverage: 0.72, spill: 0.30, palette: 0.50, scaleDev: 0.12 };

/** Pass/fail with human-readable reasons. */
function judge({ sil, palette, drewBall, scaleDev }) {
  const issues = [];
  if (sil.coverage < QC_LIMITS.coverage) issues.push(`pose mismatch — only ${(sil.coverage * 100).toFixed(0)}% of the mocap body covered`);
  if (sil.spill > QC_LIMITS.spill) issues.push(`${(sil.spill * 100).toFixed(0)}% of the character is outside the mocap silhouette`);
  if (palette != null && palette < QC_LIMITS.palette) issues.push(`colours drifted from the anchor frame (${(palette * 100).toFixed(0)}% match)`);
  if (drewBall) issues.push('model drew a basketball (the ball is composited, not generated)');
  if (scaleDev > QC_LIMITS.scaleDev) issues.push(`size off by ${(scaleDev * 100).toFixed(0)}% vs the animation median (corrected)`);
  const score = Math.round(100 * Math.max(0, Math.min(1,
    0.45 * Math.min(1, sil.coverage / 0.9) + 0.25 * (1 - Math.min(1, sil.spill / 0.5)) +
    0.2 * (palette == null ? 1 : Math.min(1, palette / 0.8)) + 0.1 * (drewBall ? 0 : 1))));
  // A corrected size alone is not a failure
  const hard = issues.filter((m) => !m.startsWith('size off'));
  return { pass: hard.length === 0, score, issues };
}

// ── game frame packing ─────────────────────────────────────────────────────
/**
 * Canvas (mannequin coordinates) → game frame with the SAME crop window for
 * every frame: stature → pixelHeight, ground → y=170, canvas centre → x=90.
 */
async function toGameFrame(canvasBuf, { statureM, ppm, pixelHeight = 112, outSize = GAME.size }) {
  const k = pixelHeight / (statureM * ppm); // canvas px → game px
  const win = GAME.size / k;
  const left = Math.round(CANVAS.w / 2 - (GAME.size / 2) / k);
  const top = Math.round(CANVAS.ground - GAME.baseline / k);
  const size = Math.round(win);
  const padL = Math.max(0, -left), padT = Math.max(0, -top);
  const padR = Math.max(0, left + size - CANVAS.w), padB = Math.max(0, top + size - CANVAS.h);
  const extended = await sharp(canvasBuf)
    .extend({ left: padL, top: padT, right: padR, bottom: padB, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  // Clipped = opaque content falls outside the fixed crop window
  const st = await alphaStats(canvasBuf);
  const clipped = !!st && (st.minY < top || st.minX < left || st.maxX >= left + size || st.maxY >= top + size);
  const buf = await sharp(extended)
    .extract({ left: left + padL, top: top + padT, width: size, height: size })
    .resize(outSize, outSize, { kernel: 'lanczos3' })
    .png().toBuffer();
  return { buf, clipped };
}

/** Horizontal strip of equal frames (Soul Jam/PlayerRenderer layout). */
async function buildStripFromFrames(frameBufs, outPath, size = GAME.size) {
  await sharp({ create: { width: size * frameBufs.length, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(frameBufs.map((b, i) => ({ input: b, left: i * size, top: 0 })))
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

module.exports = {
  GAME, HIRES, QC_LIMITS,
  prepareGenerated, fitScaleFor, placeOnCanvas, compositeBall,
  silhouetteQC, colorProfile, histIntersection, judge, detectDrawnBall,
  toGameFrame, buildStripFromFrames,
};
