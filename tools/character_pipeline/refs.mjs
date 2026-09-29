/**
 * Reference ingestion: copy the originals, classify each image (part + view), clean it for
 * generation (only the subject on a flat background: labels and stray marks removed), split a
 * two-hand sheet into left / right, and validate before any credits are spent.
 *
 * Classification order: overrides.json in the references folder > filename words
 * ("head", "front", "hand_left", "palm"…) > image analysis (subject mask on the plain
 * background: component count, bounding box, fill, skin share). Every decision records where it
 * came from and a confidence, so a wrong guess is visible in character.json and can be overridden.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const IMG = /\.(png|jpe?g|webp)$/i;

/** Subject mask on a plain background, at ≤ 384 px. */
async function analyse(file) {
  const img = sharp(file).rotate();
  const meta = await img.metadata();
  const scale = Math.min(1, 384 / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * scale)), h = Math.max(1, Math.round(meta.height * scale));
  const { data } = await img.clone().resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [data[(y * w + x) * 3], data[(y * w + x) * 3 + 1], data[(y * w + x) * 3 + 2]];
  // background: median of the border
  const border = []; for (let x = 0; x < w; x++) border.push(px(x, 0), px(x, h - 1)); for (let y = 0; y < h; y++) border.push(px(0, y), px(w - 1, y));
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  // robust spread (median distance): a subject crossing the border (a forearm) doesn't count
  const bd = border.map((p) => Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2])).sort((a, b) => a - b);
  const bgSpread = bd[Math.floor(bd.length * 0.75)] * 1.5;
  const thr = Math.max(28, bgSpread * 2.5);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = px(x, y); if (Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) > thr) mask[y * w + x] = 1; }
  // connected components (4-neighbour)
  const lab = new Int32Array(w * h).fill(-1), comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const c = { id: comps.length, n: 0, x0: w, y0: h, x1: 0, y1: 0, skin: 0 }, st = [s]; lab[s] = c.id;
    while (st.length) {
      const q = st.pop(), x = q % w, y = (q / w) | 0; c.n++;
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      const [r, g, b] = px(x, y); if (r > g && g > b && r - b > 30 && r < 245 && r > 60) c.skin++;   // warm skin hues (any tone)
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx] && lab[ny * w + nx] < 0) { lab[ny * w + nx] = c.id; st.push(ny * w + nx); }
    }
    comps.push(c);
  }
  const big = comps.filter((c) => c.n > w * h * 0.004).sort((a, b) => b.n - a.n);
  const main = big.filter((c) => c.n > (big[0]?.n || 0) * 0.25);
  return { meta, w, h, scale, bg: med, bgSpread, mask, lab, comps, big, main };
}

function fromName(file) {
  const n = path.basename(file).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const part = /\b(hand|hands)\b.*\b(l|left)\b|\bleft\b.*\bhand\b|hand ?l\b/.test(n) ? 'hand_left'
    : /\b(hand|hands)\b.*\b(r|right)\b|\bright\b.*\bhand\b|hand ?r\b/.test(n) ? 'hand_right'
      : /\bhands?\b/.test(n) ? 'hands' : /\b(head|face|portrait)\b/.test(n) ? 'head' : /\bhair\b/.test(n) ? 'hair' : /\b(shoe|shoes|sneaker)/.test(n) ? 'shoes'
        : /\b(body|full|turnaround)\b/.test(n) ? 'body' : null;
  const view = /\bfront\b/.test(n) ? 'front' : /\bback\b/.test(n) ? 'back' : /\b(left|profile l)\b/.test(n) && !/hand/.test(n) ? 'left' : /\bright\b/.test(n) && !/hand/.test(n) ? 'right'
    : /\b(3 4|three quarter|34)\b/.test(n) ? '3/4' : /\bpalm\b/.test(n) ? 'palm' : null;
  return { part, view };
}

/** Classify one image: part, view, and the subject boxes (for cleaning / splitting). */
export async function classify(file, override = {}) {
  const A = await analyse(file), name = fromName(file);
  const fr = (c) => ({ x0: c.x0 / A.w, y0: c.y0 / A.h, x1: (c.x1 + 1) / A.w, y1: (c.y1 + 1) / A.h });
  const main = A.main, m0 = main[0];
  const out = { file, width: A.meta.width, height: A.meta.height, source: 'image analysis', confidence: 'medium', notes: [] };
  if (!m0) return { ...out, part: override.part || name.part || 'unknown', view: override.view || name.view || 'front', confidence: 'low', notes: ['no subject found on the background'], boxes: [] };
  const bb = fr(m0), bh = bb.y1 - bb.y0, bw = bb.x1 - bb.x0, skin = m0.skin / m0.n;
  let part, view = 'front';
  // shape in pixels (images are rarely square): tall = height / width of the subject box
  const tall = (bh * A.h) / Math.max(1, bw * A.w);
  const edge = bb.y0 < 0.02 || bb.y1 > 0.98;
  if (main.length === 2 && Math.abs(main[0].n - main[1].n) / main[0].n < 0.4 && main.every((c) => c.skin / c.n > 0.45)) {
    part = 'hands';                                  // a two-hand sheet
  } else if (skin > 0.55 && edge && tall > 1.1) {
    part = 'hand';                                   // skin, leaving the frame at the forearm
  } else if (bh > 0.55 && tall > 1.45 && skin < 0.5) {
    part = 'body';                                   // a clothed figure most of the image tall
  } else if (skin >= 0.25 && tall >= 0.75 && tall <= 1.7) {
    part = 'head';
  } else part = 'accessory';
  out.notes.push(`subject ${(tall).toFixed(2)}× taller than wide, skin ${(skin * 100).toFixed(0)} %`);
  // front vs back vs profile: symmetry of the silhouette and whether skin faces us (a face)
  if (part === 'head' || part === 'body') {
    // (above the feet: a ground shadow is part of the mask; mirrored about the mass centre)
    let sym = 0, tot = 0;
    const yEnd = m0.y0 + Math.round((m0.y1 - m0.y0) * 0.88);
    let sx = 0, sn = 0; for (let y = m0.y0; y <= yEnd; y++) for (let x = m0.x0; x <= m0.x1; x++) if (A.lab[y * A.w + x] === m0.id) { sx += x; sn++; }
    const cx = Math.round(sx / (sn || 1)), half = Math.max(cx - m0.x0, m0.x1 - cx);
    for (let y = m0.y0; y <= yEnd; y++) for (let d = 1; d <= half; d++) { const a = cx - d >= 0 && A.lab[y * A.w + cx - d] === m0.id, b = cx + d < A.w && A.lab[y * A.w + cx + d] === m0.id; if (a || b) { tot++; if (a === b) sym++; } }
    const symmetry = tot ? sym / tot : 1;
    // skin in the top fifth of the subject (face / neck / arms) — a back view shows hair and shirt
    let top = 0, topSkin = 0;
    const yTop = m0.y0 + Math.round((m0.y1 - m0.y0) * (part === 'head' ? 0.6 : 0.15));
    for (let y = m0.y0; y <= yTop; y++) for (let x = m0.x0; x <= m0.x1; x++) if (A.lab[y * A.w + x] === m0.id) { top++; }
    const a2 = await analyseSkinBand(file, A, m0, yTop); topSkin = a2;
    // bodies: shoulder width / height (front or back ≈ 0.25, profile ≈ 0.13) — a thin figure's
    // limbs rarely mirror pixel for pixel; heads: the silhouette's symmetry
    let shoulder = 0;
    for (let y = m0.y0 + Math.round((m0.y1 - m0.y0) * 0.17); y <= m0.y0 + Math.round((m0.y1 - m0.y0) * 0.3); y++) { let l = -1, r = -1; for (let x = m0.x0; x <= m0.x1; x++) if (A.lab[y * A.w + x] === m0.id) { if (l < 0) l = x; r = x; } if (l >= 0) shoulder = Math.max(shoulder, (r - l + 1) / (m0.y1 - m0.y0 + 1)); }
    const profile = part === 'body' ? shoulder < 0.19 : symmetry < 0.8;
    // bodies: arms hanging at the sides (figure < 0.45× as wide as tall; an A-pose is ~0.5, a T-pose
    // ~1): hands rest on the hips / thighs, where the generated mesh joins them and a rig cannot
    // separate them → the pipeline makes a T-pose version first
    if (part === 'body') {
      // widest row between 15 % and 80 % of the height (the feet's ground shadow doesn't count)
      let widest = 0;
      for (let y = m0.y0 + Math.round((m0.y1 - m0.y0) * 0.15); y <= m0.y0 + Math.round((m0.y1 - m0.y0) * 0.8); y++) { let l = -1, r = -1; for (let x = m0.x0; x <= m0.x1; x++) if (A.lab[y * A.w + x] === m0.id) { if (l < 0) l = x; r = x; } if (l >= 0) widest = Math.max(widest, r - l + 1); }
      const ratio = widest / Math.max(1, m0.y1 - m0.y0 + 1);
      out.armsTouching = ratio < 0.45;
      out.notes.push(`figure ${ratio.toFixed(2)}× as wide as tall${out.armsTouching ? ': arms down at the sides' : ''}`);
    }
    view = profile ? 'profile' : topSkin > 0.25 ? 'front' : 'back';
    out.notes.push(`silhouette symmetry ${symmetry.toFixed(2)}${part === 'body' ? `, shoulder width / height ${shoulder.toFixed(2)}` : ''}, skin share near the top ${topSkin.toFixed(2)}`);
    if (view === 'profile') { view = 'left'; out.notes.push('profile: left / right not decided from the silhouette — set it in overrides.json if this is the right side'); out.confidence = 'low'; }
  }
  if (part === 'hands' || part === 'hand') {
    // fingers point away from the border the forearm leaves through; the view (back of the hand
    // vs palm) is taken as the back unless named: nails show on the back view
    out.fingers = bb.y0 < 0.02 ? 'down' : bb.y1 > 0.98 ? 'up' : 'unknown';
    view = name.view === 'palm' ? 'palm' : 'back';
    out.notes.push(`fingers ${out.fingers}; view assumed "${view}" (override with {"view":"palm"})`);
  }
  if (name.part) { part = name.part === 'hands' && part === 'hand' ? 'hand' : name.part; out.source = 'filename'; out.confidence = 'high'; }
  if (name.view) view = name.view;
  if (override.part) { part = override.part; out.source = 'overrides.json'; out.confidence = 'high'; }
  if (override.view) view = override.view;
  return { ...out, part, view, boxes: main.map(fr), skinShare: +skin.toFixed(2), bg: A.bg, bgSpread: +A.bgSpread.toFixed(1), _A: A };
}
async function analyseSkinBand(file, A, c, yTop) {
  // skin share of the subject's top band, from the same downsampled pixels
  const { data } = await sharp(file).rotate().resize(A.w, A.h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, s = 0;
  for (let y = c.y0; y <= yTop; y++) for (let x = c.x0; x <= c.x1; x++) { const i = y * A.w + x; if (A.lab[i] !== c.id) continue; n++; const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2]; if (r > g && g > b && r - b > 30 && r < 245 && r > 60) s++; }
  return n ? s / n : 0;
}

/**
 * Hand sides on a two-hand sheet. Back of the hand toward the viewer with the fingers down: the
 * right hand's thumb is on the viewer's right, so the hand on the image's left is the RIGHT hand
 * (fingers up, or a palm view: mirrored).
 */
export function handSides(cl) {
  const [a, b] = cl.boxes.slice(0, 2).sort((p, q) => p.x0 - q.x0);
  const flip = (cl.fingers === 'up') !== (cl.view === 'palm');
  return flip ? { hand_left: a, hand_right: b } : { hand_right: a, hand_left: b };
}

/** Writes the subject alone (one component, or a box) on its background, padded square-ish. */
export async function cleanCrop(file, cl, box, dest, { keepAll = false } = {}) {
  const A = cl._A, W = cl.width, H = cl.height;
  const pad = 0.06;
  const x0 = Math.max(0, Math.floor((box.x0 - pad) * W)), y0 = Math.max(0, Math.floor((box.y0 - pad) * H));
  const x1 = Math.min(W, Math.ceil((box.x1 + pad) * W)), y1 = Math.min(H, Math.ceil((box.y1 + pad) * H));
  // keep components overlapping the box; everything else becomes background
  const keep = new Set(A.comps.filter((c) => c.n > 3 && (keepAll || (c.x1 / A.w >= box.x0 - 0.01 && c.x0 / A.w <= box.x1 + 0.01 && c.y1 / A.h >= box.y0 - 0.01 && c.y0 / A.h <= box.y1 + 0.01)) && (c.n > A.w * A.h * 0.002 || A.main.includes(c))).map((c) => c.id));
  const mw = A.w, mh = A.h, m = Buffer.alloc(mw * mh);
  for (let i = 0; i < mw * mh; i++) m[i] = A.lab[i] >= 0 && keep.has(A.lab[i]) ? 255 : 0;
  const maskBig = await sharp(m, { raw: { width: mw, height: mh, channels: 1 } }).resize(W, H, { kernel: 'cubic' }).blur(2).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).toColourspace('b-w').raw().toBuffer();
  const src = await sharp(file).rotate().removeAlpha().extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).raw().toBuffer();
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < maskBig.length; i++) { const a = Math.min(1, maskBig[i] / 200); for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(src[i * 3 + c] * a + cl.bg[c] * (1 - a)); }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // small sources are upscaled (Lanczos) so the long side reaches 1024 px: Tripo needs ≥ 256 px and
  // gives thin detail from tiny inputs. It adds no real detail — a warning says so.
  const cw = x1 - x0, ch = y1 - y0, up = Math.max(1, 1024 / Math.max(cw, ch));
  let im = sharp(out, { raw: { width: cw, height: ch, channels: 3 } });
  if (up > 1.05) im = sharp(await im.png().toBuffer()).resize(Math.round(cw * up), Math.round(ch * up), { kernel: 'lanczos3' }).sharpen({ sigma: 0.8 });
  await im.png().toFile(dest);
  return { dest, width: Math.round(cw * (up > 1.05 ? up : 1)), height: Math.round(ch * (up > 1.05 ? up : 1)), upscaled: up > 1.05 ? +up.toFixed(2) : 1, sourceWidth: cw, sourceHeight: ch };
}

/** Pre-spend checks. Warnings, not blocks, unless generation is clearly impossible. */
export function validate(refs, { localParts = [] } = {}) {
  const warn = [], block = [];
  const by = (p) => refs.filter((r) => r.part === p);
  const body = by('body'), head = by('head'), hl = by('hand_left'), hr = by('hand_right');
  if (!body.length && !localParts.includes('body')) block.push('no full-body reference: the body master cannot be generated');
  for (const p of localParts) warn.push(`${p}: a local model is the master (made outside the pipeline; not regenerated)`);
  for (const r of refs) {
    const b = r.box || r.boxes?.[0];
    const minSide = Math.min(r.cropWidth ?? r.width, r.cropHeight ?? r.height);
    if (r.upscaled > 1) warn.push(`${r.name}: the ${r.part} is only ${r.cropWidth}×${r.cropHeight} px in the source; it was upscaled ×${r.upscaled} for generation, which adds no real detail — a ≥ 1024 px original gives a much better ${r.part} master`);
    else if (minSide < 768) warn.push(`${r.name}: ${minSide} px is small for a high-detail master (≥ 1024 px recommended)`);
    if (r.bgSpread > 25) warn.push(`${r.name}: the background is not flat (spread ${r.bgSpread}); the subject may merge with it`);
    if (b && r.part === 'body') {
      if (b.y1 > 0.985) warn.push(`${r.name}: the feet touch the bottom edge (may be cropped)`);
      if (b.y0 < 0.015) warn.push(`${r.name}: the head touches the top edge (may be cropped)`);
      if (b.x0 < 0.01 || b.x1 > 0.99) warn.push(`${r.name}: the subject touches a side edge`);
    }
    if (b && r.part === 'head' && (b.x0 < 0.01 || b.x1 > 0.99)) warn.push(`${r.name}: the head touches a side edge (ears / hair may be cropped)`);
    if (r.part === 'body' && r.armsTouching) warn.push(`${r.name}: the arms hang at the sides — hands and thighs would fuse and the rig could not separate them; the pipeline first makes a T-pose version of this reference (Tripo image-to-image, template t_pose, ~5 credits)`);
    if (r.confidence === 'low') warn.push(`${r.name}: classified as ${r.part}/${r.view} with low confidence — check it, or set overrides.json`);
  }
  for (const [p, list] of [['body', body], ['head', head], ['hand_left', hl], ['hand_right', hr]]) {
    const views = new Set(list.map((r) => r.view));
    if (list.length && !views.has('front') && !p.startsWith('hand')) warn.push(`${p}: no front view (Tripo needs one)`);
    if (list.length === 1) warn.push(`${p}: one view only → single-image generation (the unseen sides are inferred; add left / back / right views for multiview)`);
    if (!list.length && p !== 'body' && !localParts.includes(p)) warn.push(`${p}: no reference — the body master's own ${p.replace('_', ' ')} is used (no detail donor)`);
  }
  // identity (weak proxy): the subjects' skin shares should agree
  const skins = refs.filter((r) => r.skinTone).map((r) => r.skinTone);
  if (skins.length > 1) {
    const d = Math.max(...skins.map((a) => Math.max(...skins.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])))));
    if (d > 70) warn.push(`skin tones differ between references (Δ ${d.toFixed(0)}): check they show the same character`);
  }
  warn.push('not checked automatically: same identity / outfit across views, pose neutrality, perspective distortion — review the references page in the Character Lab');
  return { ok: !block.length, warnings: warn, blocking: block };
}

/** Median skin colour of a cleaned reference (identity proxy). */
export async function skinTone(file) {
  const { data } = await sharp(file).resize(96, 96, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = []; for (let i = 0; i < data.length; i += 3) { const r = data[i], g = data[i + 1], b = data[i + 2]; if (r > g && g > b && r - b > 30 && r < 245 && r > 60) s.push([r, g, b]); }
  if (s.length < 20) return null;
  return [0, 1, 2].map((c) => s.map((p) => p[c]).sort((a, b) => a - b)[s.length >> 1]);
}

export function listImages(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^_|^(cleaned)$/.test(e.name)) walk(p); } else if (IMG.test(e.name)) out.push(p); } })(dir);
  return out.sort();
}
