/**
 * Character sheet import — one turnaround image → a studio character.
 *
 * Splits a model sheet (N full-body poses side by side on a flat background)
 * into per-angle body references:
 *   - background colour sampled from the border, removed by colour distance
 *     with a soft edge (works for muted greens/greys, not only #00FF00)
 *   - connected components; poses = components taller than 40% of the sheet,
 *     small pieces (earrings, detached shoe logos) merged into the pose they
 *     overlap, anything else (props, lights, text) dropped
 *   - poses ordered left→right and mapped to angle indices by `order`
 *     (default "front,right,back,left" — the usual turnaround layout)
 *
 * Angle indices follow the studio: 0 Front, 1 Front Right, 2 Right,
 * 3 Back Right, 4 Back, 5 Back Left, 6 Left, 7 Front Left. "right" = the
 * character faces screen-right.
 */
'use strict';

const sharp = require('sharp');

const ANGLE_OF = {
  front: 0, 'front-right': 1, right: 2, 'back-right': 3, back: 4, 'back-left': 5, left: 6, 'front-left': 7,
};

async function splitSheet(buf, { order = 'front,right,back,left', tolerance = 42 } = {}) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  // Background = median of the border pixels
  const border = [];
  for (let x = 0; x < W; x += 4) { border.push(x); border.push((H - 1) * W + x); }
  for (let y = 0; y < H; y += 4) { border.push(y * W); border.push(y * W + W - 1); }
  const ch = (c) => { const v = border.map((i) => data[i * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [ch(0), ch(1), ch(2)];

  // Foreground by colour distance (soft band for anti-aliased edges)
  const dist = new Float32Array(W * H);
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]);
    dist[i] = d;
    fg[i] = d > tolerance ? 1 : 0;
  }

  // Connected components (4-neighbour)
  const lab = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!fg[i] || lab[i] !== -1) continue;
    const id = comps.length;
    const c = { id, n: 0, minX: W, minY: H, maxX: 0, maxY: 0 };
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W, y = (j / W) | 0;
      c.n++;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      if (x > 0 && fg[j - 1] && lab[j - 1] === -1) { lab[j - 1] = id; stack.push(j - 1); }
      if (x < W - 1 && fg[j + 1] && lab[j + 1] === -1) { lab[j + 1] = id; stack.push(j + 1); }
      if (y > 0 && fg[j - W] && lab[j - W] === -1) { lab[j - W] = id; stack.push(j - W); }
      if (y < H - 1 && fg[j + W] && lab[j + W] === -1) { lab[j + W] = id; stack.push(j + W); }
    }
    comps.push(c);
  }

  const poses = comps.filter((c) => c.maxY - c.minY > H * 0.4).sort((a, b) => a.minX - b.minX);
  if (!poses.length) throw new Error('No full-body figures found on the sheet');
  // Merge small pieces lying inside a pose's box (earrings, logos, gaps)
  const owner = new Int32Array(comps.length).fill(-1);
  poses.forEach((p, k) => { owner[p.id] = k; });
  for (const c of comps) {
    if (owner[c.id] !== -1 || c.n < 12) continue;
    const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
    const k = poses.findIndex((p) => cx >= p.minX - 8 && cx <= p.maxX + 8 && cy >= p.minY - 8 && cy <= p.maxY + 8);
    if (k >= 0) owner[c.id] = k;
  }

  const names = order.split(',').map((s) => s.trim().toLowerCase());
  const out = [];
  for (let k = 0; k < poses.length; k++) {
    const p = poses[k];
    const pad = 16;
    const x0 = Math.max(0, p.minX - pad), y0 = Math.max(0, p.minY - pad);
    const x1 = Math.min(W - 1, p.maxX + pad), y1 = Math.min(H - 1, p.maxY + pad);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y0 + y) * W + (x0 + x), o = (y * w + x) * 4;
      const l = lab[i];
      const mine = l >= 0 && owner[l] === k;
      // Soft alpha on the anti-aliased rim next to this pose
      let a = 0;
      if (mine) a = 255;
      else if (dist[i] > tolerance * 0.45) {
        const nb = [i - 1, i + 1, i - W, i + W];
        if (nb.some((q) => q >= 0 && q < W * H && lab[q] >= 0 && owner[lab[q]] === k)) a = Math.round(255 * Math.min(1, (dist[i] - tolerance * 0.45) / (tolerance * 0.55)));
      }
      px[o] = data[i * 4]; px[o + 1] = data[i * 4 + 1]; px[o + 2] = data[i * 4 + 2]; px[o + 3] = a;
    }
    const png = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const name = names[k] || `pose-${k}`;
    out.push({ name, angleIdx: ANGLE_OF[name] ?? null, png, box: [x0, y0, w, h] });
  }
  return { poses: out, background: bg, size: [W, H] };
}

/** Put a cut-out on the studio's green-screen reference canvas (3:4, feet at 95%). */
async function toReferenceCanvas(cutPng, { width = 768, height = 1024, bg = { r: 0, g: 255, b: 0, alpha: 1 } } = {}) {
  const meta = await sharp(cutPng).metadata();
  const scale = Math.min((height * 0.9) / meta.height, (width * 0.9) / meta.width);
  const w = Math.round(meta.width * scale), h = Math.round(meta.height * scale);
  const scaled = await sharp(cutPng).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: bg } })
    .composite([{ input: scaled, left: Math.round((width - w) / 2), top: Math.round(height * 0.95 - h) }])
    .png().toBuffer();
}

module.exports = { splitSheet, toReferenceCanvas, ANGLE_OF };
