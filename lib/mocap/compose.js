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
  // Size/centre come from the body only — a magenta ball proxy held out at
  // arm's length must not shift the alignment
  const body = await stripProxy(buf);
  const stats = await alphaStats(body.buf);
  if (!stats) throw new Error('Generated image is empty after background removal');
  return { buf, stats, proxyPx: body.count };
}

// ── magenta ball proxy ─────────────────────────────────────────────────────
/** Magenta-ish pixel (also catches anti-aliased disc edges blended with skin/cloth). */
function isProxy(r, g, b) {
  return r > 110 && b > 110 && r - g > 70 && b - g > 70 && Math.abs(r - b) < 110;
}

/** Copy of the image with proxy pixels made transparent (+ how many there were). */
async function stripProxy(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 24 && isProxy(data[i], data[i + 1], data[i + 2])) { data[i + 3] = 0; count++; }
  }
  if (!count) return { buf, count };
  return { buf: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(), count };
}

/** Connected blobs of pixels matching `pred` (downscaled 2×): [{x,y,r,n,box}] biggest first. */
async function blobs(buf, pred, minN = 30, close = 0) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, st = 2;
  const w = Math.ceil(W / st), h = Math.ceil(H / st);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) {
    const i = (y * W + x) * 4;
    if (data[i + 3] > 24 && pred(data[i], data[i + 1], data[i + 2])) m[(y / st) * w + x / st] = 1;
  }
  if (close > 0) {
    // bridge thin gaps (a drawn ball's seam lines) so it reads as one blob
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -close; dy <= close; dy++) for (let dx = -close; dx <= close; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) d[Y * w + X] = 1;
      }
    }
    m.set(d);
  }
  const seen = new Uint8Array(w * h), out = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    const q = [i]; seen[i] = 1;
    let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (q.length) {
      const j = q.pop(); n++;
      const x = j % w, y = (j / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - w, j + w]) if (k >= 0 && k < w * h && m[k] && !seen[k] && Math.abs((k % w) - x) <= 1) { seen[k] = 1; q.push(k); }
    }
    if (n * st * st < minN) continue;
    out.push({ x: ((x0 + x1) / 2) * st, y: ((y0 + y1) / 2) * st, r: (Math.max(x1 - x0, y1 - y0) + 1) * st / 2, n: n * st * st, box: [x0 * st, y0 * st, x1 * st, y1 * st] });
  }
  return out.sort((a, b) => b.n - a.n);
}

// Orange basketball-like pixel (bright, saturated orange; not skin)
function isOrangeBall(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx !== r || mx < 140 || (mx - mn) / mx < 0.62) return false;
  const hue = (60 * (g - b)) / (mx - mn);
  return hue >= 10 && hue <= 36;
}

/**
 * The ball the MODEL drew in the character's hand (it followed the performer
 * photo): the magenta proxy disc anywhere on the character, or failing that
 * a round orange ball. Size is clamped to the true ball size (±20%) so the
 * ball never changes size between frames. Returns { x, y, r, kind } or null.
 */
async function findHeldBall(buf, ballPx) {
  const R = ballPx?.r || 40;
  const mag = (await blobs(buf, isProxy)).filter((b) => b.n > Math.PI * R * R * 0.2);
  let best = mag[0] && { ...mag[0], kind: 'proxy' };
  if (!best) {
    // round, ball-sized orange blob (seams split it a little — loose roundness)
    const org = (await blobs(buf, isOrangeBall, 30, 2)).filter((b) => {
      const bw = b.box[2] - b.box[0] + 2, bh = b.box[3] - b.box[1] + 2;
      return b.r > R * 0.6 && b.r < R * 1.7 && bw / bh > 0.6 && bw / bh < 1.65 && b.n / (bw * bh) > 0.45;
    });
    // closing grew the blob by ~4 px on each side
    if (org[0]) best = { ...org[0], r: org[0].r - 4, kind: 'drawn' };
  }
  if (!best) return null;
  return { x: best.x, y: best.y, r: Math.max(R * 0.85, Math.min(R * 1.2, best.r)), kind: best.kind, n: best.n };
}

/**
 * Find the proxy disc near where the mocap puts the ball (placed canvas
 * coordinates). Returns { x, y, r, n } or null when the model didn't draw one.
 */
async function findProxy(buf, ballPx) {
  if (!ballPx || !(ballPx.r > 1)) return null;
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, R = ballPx.r * 2.5;
  const x0 = Math.max(0, Math.floor(ballPx.x - R)), x1 = Math.min(W - 1, Math.ceil(ballPx.x + R));
  const y0 = Math.max(0, Math.floor(ballPx.y - R)), y1 = Math.min(H - 1, Math.ceil(ballPx.y + R));
  let n = 0, sx = 0, sy = 0, mnx = W, mxx = -1, mny = H, mxy = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    if (data[i + 3] > 24 && isProxy(data[i], data[i + 1], data[i + 2])) {
      n++; sx += x; sy += y;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
    }
  }
  // At least a third of the expected disc (fingers cover part of it)
  if (n < Math.PI * ballPx.r * ballPx.r * 0.33) return null;
  // Extent-based radius (fingers only hide the inside), clamped to the mocap
  // size so the ball never changes size between frames by more than ~±20%
  const rExt = Math.max(mxx - mnx + 1, mxy - mny + 1) / 2;
  const r = Math.max(ballPx.r * 0.85, Math.min(ballPx.r * 1.2, rExt));
  return { x: (mnx + mxx) / 2, y: (mny + mxy) / 2, r, n };
}

/**
 * Replace the model's magenta disc with the canonical ball: the ball goes
 * under the character, and every proxy pixel of the character becomes
 * transparent so the ball shows through exactly where the model drew it —
 * fingers wrapped over the disc stay in front. Proxy pixels outside the
 * canonical circle (a sloppy disc) simply vanish.
 */
async function swapProxyBall(charBuf, proxy) {
  // A drawn orange ball is replaced the same way as the magenta disc
  const isBallPx = proxy.kind === 'drawn' ? isOrangeBall : isProxy;
  const { data, info } = await sharp(charBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Inside the ball circle → transparent (ball shows through). Outside it
  // (a sloppy, oversized disc) → grow the surrounding colours in, so a disc
  // drawn over the torso never leaves a see-through hole.
  let left = [];
  const r2 = (proxy.r + 0.5) * (proxy.r + 0.5);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!(data[i + 3] > 0)) continue;
    const x = p % W, y = (p / W) | 0;
    let hit = isBallPx(data[i], data[i + 1], data[i + 2]);
    if (proxy.kind === 'drawn') {
      // a drawn ball: only its own pixels (not orange clothing elsewhere),
      // including its near-black seam lines
      const d2 = (x - proxy.x) ** 2 + (y - proxy.y) ** 2;
      if (d2 > (proxy.r * 1.35) ** 2) continue;
      if (!hit && d2 < (proxy.r * 0.95) ** 2 && 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2] < 40) hit = true;
    }
    if (!hit) continue;
    if ((x - proxy.x) ** 2 + (y - proxy.y) ** 2 <= r2) data[i + 3] = 0;
    else { left.push(p); data[i + 3] = 1; } // 1 = "pending fill"
  }
  for (let it = 0; it < 8 && left.length; it++) {
    const next = [];
    const fills = [];
    for (const p of left) {
      const x = p % W, y = (p / W) | 0;
      let src = -1;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && data[q * 4 + 3] > 1) { src = q; break; }
      }
      if (src >= 0) fills.push([p, src]); else next.push(p);
    }
    for (const [p, q] of fills) for (let c = 0; c < 4; c++) data[p * 4 + c] = data[q * 4 + c];
    left = next;
  }
  for (const p of left) data[p * 4 + 3] = 0;
  // Soften the remaining magenta tint on the anti-aliased finger edges
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    if (!data[i + 3]) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r - g > 40 && b - g > 40) { const m = Math.round((r + g + b) / 3); data[i + 2] = Math.min(b, m); data[i] = Math.min(r, Math.max(m, g + 20)); }
  }
  const cleaned = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const layer = await ballLayer({ x: proxy.x, y: proxy.y, r: proxy.r });
  if (!layer) return cleaned;
  return sharp(layer).composite([{ input: cleaned }]).png().toBuffer();
}

async function ballLayer(ballPx) {
  const b = await ballPng(ballPx.r);
  const bm = await sharp(b).metadata();
  const left = Math.round(ballPx.x - bm.width / 2), top = Math.round(ballPx.y - bm.height / 2);
  if (left < -bm.width || top < -bm.height || left > CANVAS.w || top > CANVAS.h) return null;
  return sharp({ create: { width: CANVAS.w, height: CANVAS.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: b, left: Math.max(-bm.width + 1, left), top: Math.max(-bm.height + 1, top) }]).png().toBuffer();
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
  const layer = await ballLayer(ballPx);
  if (!layer) return charBuf;
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
  prepareGenerated, fitScaleFor, placeOnCanvas, compositeBall, stripProxy, findProxy, findHeldBall, swapProxyBall, isProxy, isOrangeBall, blobs,
  silhouetteQC, colorProfile, histIntersection, judge, detectDrawnBall,
  toGameFrame, buildStripFromFrames,
};
