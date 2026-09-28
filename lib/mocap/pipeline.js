/**
 * Mocap pipeline orchestration (Stage 1: hosted SAM 3 + SAM 3D Body on fal).
 *
 *   analyzeVideo  — video → sampled frames → SAM 3 masks + ball → SAM 3D Body
 *                   per frame → raw.json → motion.json (clean, reusable move)
 *   generateMove  — motion × character × views × hands → mannequin pose refs →
 *                   image model → aligned to the mannequin → canonical ball →
 *                   QC + auto-retry → game strip + hi-res frames + result record
 *   regenFrame    — redo one frame of a finished variant (optional instruction)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const S = require('./skeleton');
const providers = require('./providers');
const { buildMotion } = require('./motion-builder');
const M = require('./mannequin');
const C = require('./compose');
const models = require('./image-models');
const store = require('./store');

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../../data/.characters.json');

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function findVideo(sessionDir) {
  if (!fs.existsSync(sessionDir)) return null;
  const f = fs.readdirSync(sessionDir).find((x) => /\.(mov|mp4|m4v|avi|mkv|webm)$/i.test(x));
  return f ? path.join(sessionDir, f) : null;
}

// ── Analyze ────────────────────────────────────────────────────────────────
/** Frame × person mask (+ ball disc), cropped with margin, on white, ≤ 900px tall. */
async function performerCutout(framePath, seg) {
  const { img, st } = await maskedFrame(framePath, seg);
  const W = seg.imgW, H = seg.imgH;
  const pad = Math.round(0.06 * (st.bbox[3] - st.bbox[1]));
  const x0 = Math.max(0, st.bbox[0] - pad), y0 = Math.max(0, st.bbox[1] - pad);
  const x1 = Math.min(W - 1, st.bbox[2] + pad), y1 = Math.min(H - 1, st.bbox[3] + pad);
  return sharp(img)
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .resize({ height: 900, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).png().toBuffer();
}

/**
 * Close-up of the ball hand (real pixels, person + ball mask): finger spread,
 * wrist angle and how the fingers wrap the ball — the detail a full-body
 * cut-out is too small to show. Null when there is no ball in the frame.
 */
async function handCrop(framePath, seg, kp2d) {
  if (!seg.ball || !kp2d) return null;
  const { u, v, r } = seg.ball;
  const hand = (side) => {
    const w = kp2d[S.J[`${side}-wrist`]], t = kp2d[S.J[`${side}-middle-tip`]];
    if (!w || !t) return null;
    const c = [(w[0] + t[0]) / 2, (w[1] + t[1]) / 2];
    return { side, c, len: Math.hypot(t[0] - w[0], t[1] - w[1]), d: Math.hypot(c[0] - u, c[1] - v) };
  };
  const h = [hand('left'), hand('right')].filter(Boolean).sort((a, b) => a.d - b.d)[0];
  if (!h) return null;
  const near = h.d < 3.5 * r;
  const cx = near ? (h.c[0] + u) / 2 : h.c[0], cy = near ? (h.c[1] + v) / 2 : h.c[1];
  const size = Math.round(Math.max(3.4 * r, 2.8 * h.len, 64) + (near ? h.d : 0));
  const W = seg.imgW, H = seg.imgH;
  const x0 = Math.max(0, Math.round(cx - size / 2)), y0 = Math.max(0, Math.round(cy - size / 2));
  const w = Math.min(W - x0, size), hh = Math.min(H - y0, size);
  if (w < 16 || hh < 16) return null;
  const { img } = await maskedFrame(framePath, seg);
  const buf = await sharp(img).extract({ left: x0, top: y0, width: w, height: hh })
    .resize(384, 384, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
  return { buf, side: h.side };
}

/** Frame with everything but the performer (+ ball) made transparent. */
async function maskedFrame(framePath, seg) {
  const W = seg.imgW, H = seg.imgH;
  const { mask } = await providers.decodeMask(seg.personMaskPng, W, H);
  if (seg.ball) {
    const { u, v, r } = seg.ball;
    for (let y = Math.max(0, Math.floor(v - r)); y < Math.min(H, Math.ceil(v + r)); y++) {
      for (let x = Math.max(0, Math.floor(u - r)); x < Math.min(W, Math.ceil(u + r)); x++) if ((x - u) ** 2 + (y - v) ** 2 <= r * r) mask[y * W + x] = 1;
    }
  }
  const st = providers.maskStats(mask, W, H);
  if (!st) throw new Error('empty mask');
  const { data } = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let k = 0; k < W * H; k++) data[k * 4 + 3] = mask[k] ? 255 : 0;
  return { img: await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), st };
}

// ── SAM 3D Body mesh (clay-figure guide) ───────────────────────────────────
/**
 * Parse + align one frame's .ply to that frame's keypoints and store it
 * compactly. rec.meshKp3d = the keypoints the mesh was aligned/bound to.
 */
async function storeFrameMesh(motionId, rec, ply, kp3d, state) {
  const MG = require('./mesh-guide');
  const { verts, faces } = MG.parsePly(ply);
  const al = MG.alignMesh(verts, kp3d);
  if (!(al.err < 0.09)) { rec.meshError = `mesh didn't fit the skeleton (${Math.round(al.err * 100)} cm)`; return false; }
  if (!state.faces) {
    state.faces = faces.length; state.nVerts = verts.length / 3;
    state.facesName = 'mesh-faces.bin';
    await store.saveMotionAsset(motionId, state.facesName, MG.encodeFaces(faces));
  } else if (verts.length / 3 !== state.nVerts || faces.length !== state.faces) {
    rec.meshError = 'mesh topology differs from the first frame'; return false;
  }
  const aligned = MG.applyAlign(verts, al);
  const origin = S.mid(kp3d[S.J['left-hip']], kp3d[S.J['right-hip']]);
  rec.mesh = `mesh-${String(rec.index).padStart(3, '0')}.bin`;
  rec.meshKp3d = kp3d;
  rec.meshFit = +al.err.toFixed(3);
  delete rec.meshError;
  await store.saveMotionAsset(motionId, rec.mesh, MG.encodeVerts(aligned, origin));
  return true;
}

const meshCtxCache = new Map();
/** Mesh context for a motion (null when it has no meshes). Cached per process. */
async function getMeshCtx(motionId, raw) {
  if (process.env.MOCAP_GUIDE === 'mannequin') return null;
  if (meshCtxCache.has(motionId)) return meshCtxCache.get(motionId);
  const p = (async () => {
    raw = raw || (await store.loadMotionFile(motionId, 'raw'));
    const MG = require('./mesh-guide');
    // bind to the keypoints the mesh was aligned to
    const r2 = raw && { ...raw, frames: raw.frames.map((f) => (f.meshKp3d ? { ...f, kp3d: f.meshKp3d } : f)) };
    return MG.loadMeshContext(r2, async (name) => {
      const fp = await store.loadMotionAsset(motionId, name);
      return fp ? fs.readFileSync(fp) : null;
    });
  })().catch((e) => { console.warn('[mocap] mesh context failed:', e.message); return null; });
  meshCtxCache.set(motionId, p);
  return p;
}

/** Performer hand close-up for motion frame fi (mirrored for the other-hand variant). */
async function handRef(ctx, fi) {
  if (!ctx.raw) ctx.raw = await store.loadMotionFile(ctx.motionId, 'raw');
  const file = ctx.motion.frames[fi]?.sourceFile;
  const rec = ctx.raw?.frames?.find((r) => r.file === file);
  if (!rec?.hand) return null;
  if (rec.personBBox && rec.bbox && bboxIoU(rec.personBBox, rec.bbox) < 0.3) return null;
  const p = await store.loadMotionAsset(ctx.motionId, rec.hand);
  if (!p) return null;
  let buf = fs.readFileSync(p);
  if (ctx.mirror) buf = await sharp(buf).flop().png().toBuffer();
  return buf;
}

/**
 * Add SAM 3D Body meshes + hand close-ups to a motion analysed before they
 * existed (or whose mesh download failed). Needs the source frames (kept as
 * motion assets since this version, or still on disk).
 */
async function enrichMotion(id, progress = () => {}) {
  const raw = await store.loadMotionFile(id, 'raw');
  if (!raw) throw new Error('Motion not found');
  const dir = store.motionDir(id);
  const state = raw.meshFaces ? { facesName: raw.meshFaces, faces: raw.meshFaceCount, nVerts: raw.meshVerts } : {};
  const todo = raw.frames.filter((r) => !r.error && (!r.mesh || (!r.hand && r.ball)));
  let cost = 0, done = 0, meshes = 0, hands = 0, missing = 0;
  progress({ done, total: todo.length, msg: `Adding 3D body mesh + hand close-ups to ${todo.length} frames…` });
  // First frame alone establishes the topology, then the rest in parallel
  const run = async (rec) => {
    const i = rec.index;
    let fp = path.join(dir, 'frames', rec.file);
    if (!fs.existsSync(fp)) fp = await store.loadMotionAsset(id, `src-${String(i).padStart(3, '0')}.jpg`);
    const maskPath = path.join(dir, 'masks', `mask-${String(i).padStart(3, '0')}.png`);
    if (!fp || !fs.existsSync(fp)) { missing++; done++; return; }
    try {
      const meta = await sharp(fp).metadata();
      if (!rec.hand && rec.ball && fs.existsSync(maskPath)) {
        const hc = await handCrop(fp, { personMaskPng: fs.readFileSync(maskPath), ball: rec.ball, imgW: meta.width, imgH: meta.height }, rec.kp2d);
        if (hc) { rec.hand = `hand-${String(i).padStart(3, '0')}.png`; rec.handSide = hc.side; await store.saveMotionAsset(id, rec.hand, hc.buf); hands++; }
      }
      if (!rec.mesh) {
        const body = await providers.bodyFrame(fp, fs.existsSync(maskPath) ? maskPath : null, { mesh: true });
        cost += body.cost || 0;
        if (body.ply && (await storeFrameMesh(id, rec, body.ply, body.kp3d, state))) meshes++;
        else if (!body.ply) rec.meshError = 'SAM 3D Body returned no mesh';
      }
    } catch (e) { rec.meshError = String(e.message || e).slice(0, 200); }
    done++;
    progress({ done, total: todo.length, msg: `Frame ${done}/${todo.length}` });
  };
  if (todo.length) await run(todo[0]);
  await pool(todo.slice(1), 4, run);
  if (state.facesName) Object.assign(raw, { meshFaces: state.facesName, meshFaceCount: state.faces, meshVerts: state.nVerts });
  await store.saveMotionFile(id, 'raw', raw);
  meshCtxCache.delete(id);
  const meta = (await store.loadMotionFile(id, 'meta')) || { id };
  meta.mesh = { frames: raw.frames.filter((r) => r.mesh).length, total: raw.frames.length };
  meta.hands = raw.frames.filter((r) => r.hand).length;
  await store.saveMotionFile(id, 'meta', meta);
  if (missing && !meshes) throw new Error(`Source frames for this motion are gone (analysed before frames were kept) — re-analyse the clip to get the 3D mesh`);
  return { meshes, hands, missing, cost: +cost.toFixed(3), meta };
}

function bboxIoU(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Signed smallest angle difference in degrees. */
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** The performer cut-out matching motion frame fi (mirrored for the other-hand variant). */
async function performerRef(ctx, fi) {
  const { motion } = ctx;
  if (!ctx.raw) ctx.raw = await store.loadMotionFile(ctx.motionId, 'raw');
  const file = motion.frames[fi]?.sourceFile;
  const rec = ctx.raw?.frames?.find((r) => r.file === file);
  if (!rec?.cut) return null;
  // SAM 3 occasionally masks the wrong thing (a mural, another person): skip
  // the photo when its mask barely overlaps the body SAM 3D Body found
  if (rec.personBBox && rec.bbox && bboxIoU(rec.personBBox, rec.bbox) < 0.3) return null;
  const p = await store.loadMotionAsset(ctx.motionId, rec.cut);
  if (!p) return null;
  let buf = fs.readFileSync(p);
  if (ctx.mirror) buf = await sharp(buf).flop().png().toBuffer();
  // Camera angle the performer was filmed from, in the render's view space
  const src = (motion.report?.sourceYawDeg ?? 0) * (ctx.mirror ? -1 : 1);
  const delta = Math.abs(angDiff(M.VIEWS[ctx.view].yaw, src));
  return { buf, delta, srcYaw: src };
}
/**
 * @param {object} o { sessionId, name, fps=12 (≤30), start, end, maxFrames=48 (≤240), TMP_DIR }
 * @param {function} progress ({ step, done, total, msg })
 */
async function analyzeVideo(o, progress = () => {}) {
  const { extractFrames } = require('../sprite-generator/video-extractor');
  const sessionDir = path.join(o.TMP_DIR, store.safeId(o.sessionId));
  const video = findVideo(sessionDir);
  if (!video) throw new Error('No uploaded video for this session — upload or record one first');

  const id = store.newId('mo');
  const dir = store.motionDir(id);
  const framesDir = path.join(dir, 'frames');
  const masksDir = path.join(dir, 'masks');
  fs.mkdirSync(masksDir, { recursive: true });

  const fps = Math.max(4, Math.min(30, +o.fps || 12));
  const extractOpts = { fps, scale: 'min(1280\\,iw)' };
  if (o.start > 0) extractOpts.start = String(o.start);
  if (o.end > (o.start || 0)) extractOpts.duration = String(Math.max(0.2, o.end - (o.start || 0)));
  progress({ step: 'extract', done: 0, total: 1, msg: 'Extracting frames…' });
  await extractFrames(video, framesDir, extractOpts);
  let files = fs.readdirSync(framesDir).filter((f) => /^frame-\d+\.(png|jpe?g)$/i.test(f)).sort();
  const maxFrames = Math.max(2, Math.min(240, +o.maxFrames || 48)); // 240 = 8 s at 30 fps (moves, locomotion)
  if (files.length > maxFrames) {
    for (const f of files.slice(maxFrames)) fs.rmSync(path.join(framesDir, f), { force: true });
    files = files.slice(0, maxFrames);
  }
  if (files.length < 2) throw new Error('Clip too short — need at least 2 frames');

  let cost = 0;
  let done = 0;
  const total = files.length;
  const meshState = {};
  progress({ step: 'measure', done, total, msg: `Measuring ${total} frames (SAM 3 + SAM 3D Body)…` });
  let firstDone;
  meshState.first = new Promise((r) => { firstDone = r; });
  const rawFrames = await pool(files, 4, async (file, i) => {
    const fp = path.join(framesDir, file);
    const rec = { file, index: i };
    try {
      const seg = await providers.segmentFrame(fp);
      cost += seg.cost || 0;
      const maskPath = path.join(masksDir, `mask-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(maskPath, seg.personMaskPng);
      rec.ball = seg.ball;
      rec.personBBox = seg.person?.bbox || null;
      // The performer at this exact moment (real pixels, SAM 3 mask) — the
      // generator's reference for hand shapes, grip and orientation
      try {
        rec.cut = `cut-${String(i).padStart(3, '0')}.png`;
        await store.saveMotionAsset(id, rec.cut, await performerCutout(fp, seg));
      } catch (e) { rec.cut = null; }
      // Keep the source frame (re-measuring / adding meshes later needs it)
      await store.saveMotionAsset(id, `src-${String(i).padStart(3, '0')}.jpg`, await sharp(fp).jpeg({ quality: 88 }).toBuffer()).catch(() => {});
      const body = await providers.bodyFrame(fp, maskPath, { mesh: true });
      cost += body.cost || 0;
      Object.assign(rec, { kp2d: body.kp2d, kp3d: body.kp3d, camT: body.camT, focal: body.focal, imgW: body.imgW, imgH: body.imgH, bbox: body.bbox });
      try {
        const hc = await handCrop(fp, seg, body.kp2d);
        if (hc) { rec.hand = `hand-${String(i).padStart(3, '0')}.png`; rec.handSide = hc.side; await store.saveMotionAsset(id, rec.hand, hc.buf); }
      } catch (e) { /* optional */ }
      if (body.ply) {
        // The first frame fixes the mesh topology; others store after it
        if (i > 0) await meshState.first;
        try { await storeFrameMesh(id, rec, body.ply, body.kp3d, meshState); } catch (e) { rec.meshError = String(e.message || e).slice(0, 200); }
      }
    } catch (err) {
      rec.error = String(err.message || err).slice(0, 300);
    }
    if (i === 0) firstDone();
    done++;
    progress({ step: 'measure', done, total, msg: `Measured ${done}/${total} frames` });
    return rec;
  });
  firstDone();

  const failed = rawFrames.filter((r) => r.error);
  if (failed.length === rawFrames.length) {
    throw new Error(`Every frame failed: ${failed[0].error}`);
  }

  const raw = { version: 1, fps, sessionId: o.sessionId, frames: rawFrames };
  if (meshState.facesName) Object.assign(raw, { meshFaces: meshState.facesName, meshFaceCount: meshState.faces, meshVerts: meshState.nVerts });
  const motion = buildMotion(raw, o.settings || {});
  const meta = {
    id, name: (o.name || 'move').trim().slice(0, 60), createdAt: new Date().toISOString(),
    fps, frameCount: motion.frameCount, sourceFrames: files.length, failedFrames: failed.length,
    statureM: motion.statureM, startingHand: motion.startingHand, report: motion.report,
    measureCost: +cost.toFixed(3), settings: motion.settings,
    mesh: { frames: rawFrames.filter((r) => r.mesh).length, total: rawFrames.length },
    hands: rawFrames.filter((r) => r.hand).length,
  };
  await store.saveMotionFile(id, 'raw', raw);
  await store.saveMotionFile(id, 'motion', motion);
  await store.saveMotionFile(id, 'meta', meta);
  await store.upsertIndex('motions', id, { name: meta.name, createdAt: meta.createdAt, frameCount: meta.frameCount, fps, startingHand: meta.startingHand });
  progress({ step: 'done', done: total, total, msg: 'Motion ready' });
  return { motionId: id, meta };
}

/** Re-clean a motion from raw.json with new settings (smoothing, trim, …). */
async function reprocessMotion(id, settings) {
  const raw = await store.loadMotionFile(id, 'raw');
  if (!raw) throw new Error('Motion not found');
  const meta = (await store.loadMotionFile(id, 'meta')) || { id };
  const motion = buildMotion(raw, settings || {});
  Object.assign(meta, { frameCount: motion.frameCount, statureM: motion.statureM, startingHand: motion.startingHand, report: motion.report, settings: motion.settings, updatedAt: new Date().toISOString() });
  await store.saveMotionFile(id, 'motion', motion);
  await store.saveMotionFile(id, 'meta', meta);
  await store.upsertIndex('motions', id, { frameCount: meta.frameCount, startingHand: meta.startingHand });
  return { motion, meta };
}

// ── Character helpers ──────────────────────────────────────────────────────
function loadCharacter(charName) {
  let reg = {};
  try { if (fs.existsSync(CHARACTERS_FILE)) reg = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8')); } catch {}
  const c = reg[charName] || {};
  const heightInches = +c.heightInches || 72;
  return {
    name: charName,
    heightInches,
    statureM: heightInches * 0.0254,
    pixelHeight: +c.pixelHeight || Math.round((111.6 * heightInches) / 72),
    description: c.clothingDescription || c.description || '',
  };
}

function characterRefs(ASSETS_DIR, charName, angleIdx) {
  const pick = (...names) => names.map((n) => path.join(ASSETS_DIR, n)).find((p) => fs.existsSync(p)) || null;
  const angle = pick(`${charName}-angle-${angleIdx}.png`, `${charName}-angle-0.png`, `${charName}full.png`);
  const portrait = pick(`${charName}full.png`, `${charName}-angle-0.png`);
  return { angle, portrait: portrait && portrait !== angle ? portrait : null };
}

// ── Compact reference sheets (low OpenAI input-image limits) ─────────────────
/** Side-by-side labelled sheet of up to 3 images, each fitted into a 2:3 cell. */
async function refSheet(parts) {
  const cw = 512, chh = 768, gap = 16, lab = 44;
  const W = parts.length * cw + (parts.length - 1) * gap;
  const tiles = [];
  for (let i = 0; i < parts.length; i++) {
    const buf = Buffer.isBuffer(parts[i].img) ? parts[i].img : fs.readFileSync(parts[i].img);
    const fitted = await sharp(buf).flatten({ background: '#ffffff' }).resize(cw, chh, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    tiles.push({ input: fitted, left: i * (cw + gap), top: lab });
    const text = parts[i].label.replace(/[<&>]/g, '');
    tiles.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${lab}"><text x="8" y="31" font-family="sans-serif" font-size="26" font-weight="700" fill="#111">${text}</text></svg>`), left: i * (cw + gap), top: 0 });
  }
  return sharp({ create: { width: W, height: chh + lab, channels: 3, background: '#ffffff' } }).composite(tiles).png().toBuffer();
}

// Ball IN HAND: the performer photo decides where it sits (the tracked 3D ball
// position is approximate); the model draws it as a magenta disc that compose
// swaps for the canonical ball. `hand` comes from the 3D motion.
const HELD_RULE = (hand, refs) => `- The character is holding the basketball in their ${hand.toUpperCase()} hand (the ${hand === 'left' ? 'BLUE' : 'RED'} hand in the guide). ${refs} show exactly how the performer holds it at this moment — draw the ball in that hand the same way: same side of the hand, same height relative to the body, same grip and finger spread, fingers wrapping around it and drawn IN FRONT of the ball where they overlap. Draw the ball as a flat, solid, pure magenta #FF00FF disc (no seams, no shading, no outline), about the size of the character's head. Never draw an orange basketball. No other magenta anywhere.`;
const PROXY_RULE = '- The solid MAGENTA disc in the guide is the basketball. Draw it exactly there, the same size, as a flat solid pure magenta #FF00FF disc (no seams, no shading, no outline). The hand holding it must grip it naturally: palm against the disc, fingers spread and wrapped around its edge, fingers drawn IN FRONT of the disc where they wrap over it — as the performer holds the real ball. Never draw an orange basketball. No other magenta anywhere.';
const NO_BALL_RULE = 'Do NOT draw a basketball or any ball — the ball is in the air here and is added separately; keep the hand shapes from the pose.';

const MESH_RULES = [
  '- The GUIDE is the performer\'s real 3D body scan (a bare clay figure). Take ONLY the pose, camera angle, body orientation, limb overlap and size from it. Draw the character\'s own face, hair, clothes, shoes and proportions — never the bare scan.',
  '- BLUE body parts (arm, hand, leg, foot) are the character\'s LEFT side; RED are the RIGHT side; grey is the torso and head. Shading shows depth: lighter = nearer the camera, dark outlines separate limbs in front from limbs behind. The eyes show where the face points (none visible = the back of the head).',
];
const HANDS_RULE = (ref) => `${ref} is a close-up of the performer\'s ball hand at this moment — copy its finger spread, wrist bend and how the fingers wrap the ball exactly (skin, sleeves and colours come from the character, not the photo).`;

function buildCompactPrompt({ viewLabel, hasAnchor, perf, transparent, charDescription, custom, proxy, mesh, hands, held }) {
  const lines = [
    `Image 1 panel "A" is the CHARACTER — keep this exact person: face, hair, skin tone, tattoos, body build, outfit, shoes, colours and clean art style.${hasAnchor ? ' Panel "B" is an approved frame of this same animation — match its rendering, colours, line weight, proportions and scale exactly.' : ''}`,
    `Image 2 panel "GUIDE" is a ${mesh ? '3D body scan of the performer' : 'motion-capture pose guide'} seen from the ${viewLabel} camera angle. Redraw the character from panel A in exactly this pose, at this camera angle, filling the same area as the guide figure, full body, nothing cropped.`,
    ...(mesh ? MESH_RULES : ['- BLUE guide limbs, hand and ear are the character\'s LEFT side; RED are the RIGHT side. Every finger is drawn — match finger positions and palm direction. Eyes and the nose wedge show where the face points (none = back of the head).']),
  ];
  if (perf) lines.push(perf.delta <= 30
    ? 'Image 2 panel "PERFORMER" is the real performer at this exact moment from almost the same camera angle — copy hand shapes, grip, wrist/elbow angles, head turn, lean and feet precisely. Use ONLY the pose, never their face, skin, hair or clothes.'
    : `Image 2 panel "PERFORMER" is the real performer at this moment from a different camera angle (${perf.srcLabel}) — use it for hand shapes, grip and timing; the camera angle and orientation must follow the GUIDE. Use ONLY the pose, never their face, skin, hair or clothes.`);
  if (hands) lines.push(HANDS_RULE('Image 2 panel "HANDS"'));
  if (charDescription) lines.push(`Character notes: ${charDescription}`);
  if (held) lines.push(HELD_RULE(held, perf ? `Image 2 panels "PERFORMER"${hands ? ' and "HANDS"' : ''}` : 'The pose'));
  else if (proxy) lines.push(PROXY_RULE);
  lines.push(
    `- Output ONE character only (not a sheet, no panels, no labels).${proxy || held ? '' : ` ${NO_BALL_RULE}`}`,
    '- No floor, shadow, text or props. Clean illustrated game-character style exactly like panel A.',
    transparent ? 'Background: fully transparent.' : 'Background: solid pure green #00FF00, no green on the character.',
  );
  if (custom) lines.push(`SPECIFIC INSTRUCTION: ${custom}`);
  return lines.join('\n');
}

// ── Prompt ────────────────────────────────────────────────────────────────
function buildPrompt({ viewLabel, hasAnchor, hasPortrait, transparent, charDescription, custom, performer, proxy, mesh, hands, held }) {
  let n = 2;
  const anchorIdx = hasAnchor ? ++n : null;
  const performerIdx = performer ? ++n : null;
  const handsIdx = hands ? ++n : null;
  const portraitIdx = hasPortrait ? ++n : null;
  const lines = [
    'Image 1 is the CHARACTER. Keep this exact person: face, hair, skin tone, body build, outfit, shoes, colours and clean art style. Do not redesign anything.',
    `Image 2 is a ${mesh ? '3D BODY SCAN of the performer' : 'POSE MANNEQUIN from motion capture'}, seen from the ${viewLabel} camera angle. Redraw the character from Image 1 in exactly this pose:`,
    ...(mesh ? MESH_RULES : ['- BLUE guide limbs, hand and ear are the character\'s LEFT side; RED are the RIGHT side. Grey is the torso and head. Every finger is drawn — match each hand\'s finger positions and palm direction. The eyes and the nose wedge show exactly where the face points (none visible = the back of the head).']),
    '- Match every joint angle, elbow and knee bend, torso lean, head direction and foot placement. Same camera angle and framing: the character fills the same area of the image as the mannequin, feet at the same height, full body visible, nothing cropped.',
  ];
  if (anchorIdx) lines.push(`Image ${anchorIdx} is an approved frame of this same animation. Match its rendering exactly — same colours, line weight, shading, proportions and scale.`);
  if (performerIdx) {
    lines.push(performer.delta <= 30
      ? `Image ${performerIdx} is the real performer at this exact moment, filmed from almost the same camera angle. Copy the pose from it precisely — hand shapes, finger positions, grip on the ball, wrist and elbow angles, head turn, torso lean and foot placement. Use ONLY the pose: never their face, skin, hair or clothes. The guide (Image 2) fixes the size and framing.`
      : `Image ${performerIdx} is the real performer at this exact moment, filmed from a different camera angle (${performer.srcLabel}). Use it for hand shapes, finger positions, grip and the timing of the motion — but the camera angle and body orientation must follow the guide in Image 2. Use ONLY the pose: never their face, skin, hair or clothes.`);
  }
  if (handsIdx) lines.push(HANDS_RULE(`Image ${handsIdx}`));
  if (portraitIdx) lines.push(`Image ${portraitIdx} is the character's front reference — use it to keep the face and outfit identical.`);
  if (charDescription) lines.push(`Character notes: ${charDescription}`);
  lines.push(
    held ? HELD_RULE(held, [performerIdx && `Image ${performerIdx}`, handsIdx && `Image ${handsIdx}`].filter(Boolean).join(' and ') || 'The pose') : proxy ? PROXY_RULE : `- ${NO_BALL_RULE}`,
    '- No floor, shadow, text, logo or props. One character only.',
    '- Clean illustrated game-character style exactly like Image 1. No pixel art, no photo realism changes.',
    transparent
      ? 'Background: fully transparent.'
      : 'Background: solid pure green #00FF00 everywhere around the character. No green anywhere on the character.',
  );
  if (custom) lines.push(`SPECIFIC INSTRUCTION: ${custom}`);
  return lines.join('\n');
}

// ── Generate ──────────────────────────────────────────────────────────────
/**
 * Orange share of the character reference itself (skin, clothing), measured
 * on the character only — the green reference background must not dilute it,
 * or skin tones read as "the model drew a ball".
 */
async function refOrangeShare(refPath) {
  const buf = fs.readFileSync(refPath);
  const prep = await C.prepareGenerated(buf, false).catch(() => null);
  return (await C.colorProfile(prep ? prep.buf : buf)).orangeShare;
}
function variantName(motionMeta, view, hand) {
  const base = String(motionMeta.name || 'move').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'move';
  return `mocap-${base}-${motionMeta.id.slice(-4)}-z${view}-${hand}`;
}

async function generateOneFrame(ctx, fi, { anchorPath, custom } = {}) {
  const { motion, view, mirror, statureM, ppm, refs, model, quality, charInfo, workDir } = ctx;
  // Ball in hand → magenta proxy disc in the guide, so the model draws the
  // grip around it (MOCAP_BALL_PROXY=0 → old behaviour: no ball in the guide)
  // In hand → no ball in the guide; the model places it from the performer
  // photo (see HELD_RULE). MOCAP_BALL_PROXY=0 → no ball handling at all.
  const useProxy = ctx.ballProxy !== false && process.env.MOCAP_BALL_PROXY !== '0';
  const r = await M.renderFrame(motion, fi, { view, mirror, statureM, ppm, ballProxy: false, meshCtx: ctx.meshCtx });
  const mesh = r.guide === 'mesh';
  const held = useProxy && r.ballPx?.held ? r.ballPx.hand : null;
  const proxy = false;
  const posePath = path.join(workDir, `pose-${fi}.png`);
  const poseAlphaPath = path.join(workDir, `pose-alpha-${fi}.png`);
  fs.writeFileSync(posePath, r.png);
  fs.writeFileSync(poseAlphaPath, r.alphaPng);
  const info = models.modelInfo(model);
  const perf = ctx.usePerformer === false ? null : await performerRef(ctx, fi).catch(() => null);
  const hands = ctx.useHands === false ? null : await handRef(ctx, fi).catch(() => null);
  const nearest = Object.values(M.VIEWS).reduce((b, v) => (Math.abs(angDiff(v.yaw, perf?.srcYaw ?? 0)) < Math.abs(angDiff(b.yaw, perf?.srcYaw ?? 0)) ? v : b));
  const perfInfo = perf ? { delta: perf.delta, srcLabel: `roughly ${nearest.label.toLowerCase()}` } : null;
  // Tight "input images per minute" limits (low OpenAI tiers): pack the
  // references into 2 labelled sheets instead of up to 5 separate images
  const lim = models.inputImageLimit();
  const compact = info.provider === 'openai' && (process.env.OPENAI_COMPACT_REFS === '1' || (lim && lim < 8));
  let images, prompt;
  if (compact) {
    const charParts = [{ img: refs.angle, label: 'A: character' }];
    if (anchorPath) charParts.push({ img: anchorPath, label: 'B: approved frame' });
    const poseParts = [{ img: r.png, label: 'GUIDE' }];
    if (perf) poseParts.push({ img: perf.buf, label: 'PERFORMER' });
    if (hands) poseParts.push({ img: hands, label: 'HANDS' });
    images = [await refSheet(charParts), await refSheet(poseParts)];
    prompt = buildCompactPrompt({ viewLabel: M.VIEWS[view].label, hasAnchor: !!anchorPath, perf: perfInfo, transparent: info.transparent, charDescription: charInfo.description, custom, proxy, mesh, hands: !!hands, held });
  } else {
    images = [refs.angle, r.png];
    if (anchorPath) images.push(anchorPath);
    if (perf) images.push(perf.buf);
    if (hands) images.push(hands);
    if (refs.portrait) images.push(refs.portrait);
    prompt = buildPrompt({
      viewLabel: M.VIEWS[view].label, hasAnchor: !!anchorPath, hasPortrait: !!refs.portrait,
      transparent: info.transparent, charDescription: charInfo.description, custom, performer: perfInfo, proxy, mesh, hands: !!hands, held,
    });
  }
  const gen = await models.generateImage({ model, prompt, images, quality, poseIndex: compact ? -1 : 1, poseBuf: r.png });
  fs.writeFileSync(path.join(workDir, `raw-${fi}.png`), gen.buffer);
  // Keep every raw generation (disk + R2) so a variant can be re-aligned /
  // re-composited later (motion clean-up, ball fixes) without new model calls
  const rawFile = `raw-${fi}-${Date.now().toString(36)}.png`;
  const genDir = path.join(ctx.ASSETS_DIR, `${ctx.charName}-${ctx.animName}-gen`);
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, rawFile), gen.buffer);
  const r2 = require('../r2-storage');
  if (r2.isAvailable()) r2.uploadFile(`${ctx.charName}-${ctx.animName}-gen/${rawFile}`, gen.buffer).catch(() => {});
  const prep = await C.prepareGenerated(gen.buffer, gen.transparent);
  return { fi, render: r, prep, k: C.fitScaleFor(prep.stats, r.bbox), cost: gen.cost || 0, rawFile, transparent: gen.transparent, guide: r.guide, hands: !!hands };
}

async function finishFrame(ctx, g, kMedian, anchorProfile) {
  const lo = kMedian * (1 - C.QC_LIMITS.scaleDev), hi = kMedian * (1 + C.QC_LIMITS.scaleDev);
  const k = Math.max(lo, Math.min(hi, g.k));
  const scaleDev = Math.abs(g.k - kMedian) / kMedian;
  const placed = await C.placeOnCanvas(g.prep, g.render.bbox, k);
  // The model's magenta ball proxy (if it drew one where the mocap ball is)
  // becomes the canonical ball, keeping its fingers-over-ball grip. Otherwise
  // (ball in the air, or no disc drawn) the ball is composited from physics.
  // Ball in hand: keep it where the model drew it (it followed the performer
  // photo) — magenta disc or an orange ball — as the canonical ball texture.
  // Ball in the air: from the tracked motion.
  const bp = g.render.ballPx;
  const proxy = bp?.held ? await C.findHeldBall(placed, bp) : await C.findProxy(placed, bp);
  const body = (await C.stripProxy(placed)).buf; // QC + palette on the body only
  const sil = await C.silhouetteQC(body, g.render.alphaPng);
  const prof = await C.colorProfile(body);
  const palette = anchorProfile ? C.histIntersection(prof.hist, anchorProfile.hist) : null;
  // A drawn ball is only a problem when the ball should be in the air
  const drewBall = bp?.held ? false : await C.detectDrawnBall(body, bp?.r || 0.12 * ctx.ppm);
  const withBall = proxy ? await C.swapProxyBall(placed, proxy) : await C.compositeBall(body, bp);
  const qc = C.judge({ sil, palette, drewBall, scaleDev });
  qc.metrics = { coverage: +sil.coverage.toFixed(3), spill: +sil.spill.toFixed(3), palette: palette == null ? null : +palette.toFixed(3), scaleDev: +scaleDev.toFixed(3), drewBall, ballGrip: proxy ? proxy.kind || 'proxy' : false };
  return { canvas: withBall, charOnly: body, profile: prof, qc, k };
}

/**
 * Shot metadata for a variant: which strip frame the ball leaves the hand and
 * where (game-frame px, 180×180, feet at y=170, unflipped) — the court/game
 * spawns its ball flight there.
 */
function shotInfo(ctx, frameIdx) {
  const rel = ctx.motion.report?.shotRelease;
  if (!rel || !frameIdx) return null;
  const j = frameIdx.findIndex((fi) => fi >= rel.releaseFrame);
  if (j < 0) return null;
  const v = M.VIEWS[ctx.view] || M.VIEWS[1];
  const fr = M.posedFrame(ctx.motion, rel.lastHeldFrame, { yawDeg: v.yaw, mirror: ctx.mirror, statureM: ctx.statureM });
  const b = M.ballInfo(fr, ctx.ppm);
  if (!b) return null;
  const k = ctx.charInfo.pixelHeight / (ctx.statureM * ctx.ppm);
  const left = M.CANVAS.w / 2 - (C.GAME.size / 2) / k, top = M.CANVAS.ground - C.GAME.baseline / k;
  return {
    releaseStripFrame: j, releaseSourceFrame: rel.releaseFrame,
    ...(rel.stepFrame != null ? { stepStripFrame: Math.max(0, frameIdx.findIndex((fi) => fi >= rel.stepFrame)) } : {}),
    releasePx: { x: +((b.x - left) * k).toFixed(1), y: +((b.y - top) * k).toFixed(1) },
    ballRadiusPx: +(b.r * k).toFixed(1),
    hand: ctx.mirror ? (rel.hand === 'left' ? 'right' : 'left') : rel.hand,
  };
}

async function writeVariantOutputs(ctx, finals, frameIdx) {
  const { ASSETS_DIR, charName, animName, statureM, ppm, charInfo } = ctx;
  const r2 = require('../r2-storage');
  const framesDir = path.join(ASSETS_DIR, `${charName}-${animName}-frames`);
  fs.mkdirSync(framesDir, { recursive: true });
  const gameBufs = [];
  let clipped = false;
  for (let i = 0; i < finals.length; i++) {
    const game = await C.toGameFrame(finals[i].canvas, { statureM, ppm, pixelHeight: charInfo.pixelHeight });
    const hires = await C.toGameFrame(finals[i].canvas, { statureM, ppm, pixelHeight: charInfo.pixelHeight, outSize: C.GAME.size * C.HIRES });
    clipped = clipped || game.clipped;
    gameBufs.push(game.buf);
    const fp = path.join(framesDir, `frame-${i}.png`);
    fs.writeFileSync(fp, hires.buf);
    if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}-frames/frame-${i}.png`, fp).catch(() => {});
  }
  const stripPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
  await C.buildStripFromFrames(gameBufs, stripPath);
  if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}.png`, stripPath).catch(() => {});
  // Marks the frames as pre-aligned so studio rebuilds never re-scale them per frame
  const shot = shotInfo(ctx, frameIdx);
  const genmeta = { mode: 'mocap-aligned', frameSize: C.GAME.size, hiresSize: C.GAME.size * C.HIRES, baseline: C.GAME.baseline, pixelHeight: charInfo.pixelHeight, motionId: ctx.motionId, view: ctx.view, hand: ctx.hand, ...(shot ? { shot } : {}) };
  const metaPath = path.join(ASSETS_DIR, `${charName}-${animName}-genmeta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(genmeta));
  if (r2.isAvailable()) r2.uploadFile(`${charName}-${animName}-genmeta.json`, metaPath, 'application/json').catch(() => {});
  return { stripUrl: `/assets/${charName}-${animName}.png?v=${Date.now().toString(36)}`, frameUrls: finals.map((_, i) => `/assets/${charName}-${animName}-frames/frame-${i}.png`), clipped, shot };
}

/**
 * @param {object} o { motionId, charName, views:[1..5], hands:['right','left'], model, quality,
 *                     frameStep=1, retries=1, concurrency=3, ASSETS_DIR, TMP_DIR }
 */
async function generateMove(o, progress = () => {}) {
  const motion = await store.loadMotionFile(o.motionId, 'motion');
  const meta = await store.loadMotionFile(o.motionId, 'meta');
  if (!motion || !meta) throw new Error('Motion not found');
  const charInfo = loadCharacter(o.charName);
  const views = (o.views && o.views.length ? o.views : [1]).map(Number).filter((v) => M.VIEWS[v]);
  const hands = (o.hands && o.hands.length ? o.hands : [motion.startingHand || 'right']).filter((h) => h === 'left' || h === 'right');
  const step = Math.max(1, +o.frameStep || 1);
  const frameIdx = Array.from({ length: motion.frameCount }, (_, i) => i).filter((i) => i % step === 0);
  const model = o.model || 'gemini-3-pro-image-preview';
  const retries = Math.max(0, Math.min(3, o.retries ?? 1));
  const baseHand = motion.startingHand || 'right';

  const resultId = store.newId('mr');
  const result = {
    id: resultId, motionId: o.motionId, motionName: meta.name, charName: o.charName, model,
    quality: o.quality || 'high', createdAt: new Date().toISOString(), fps: Math.max(1, Math.round((motion.fps || 12) / step)),
    frameIdx, variants: [], cost: meas(0), status: 'running',
  };
  function meas(x) { return +x.toFixed(4); }

  const totalFrames = views.length * hands.length * frameIdx.length;
  let doneFrames = 0;
  const tick = (msg) => progress({ done: doneFrames, total: totalFrames, msg, resultId, variants: result.variants });

  for (const hand of hands) {
    const mirror = hand !== baseHand;
    const ppm = M.fitScale(motion, { statureM: charInfo.statureM, mirror });
    for (const view of views) {
      const refs = characterRefs(o.ASSETS_DIR, o.charName, M.VIEWS[view].angleIdx);
      if (!refs.angle) throw new Error(`No reference image for "${o.charName}" — generate body angles or a portrait first`);
      const animName = variantName(meta, view, hand);
      const workDir = path.join(o.TMP_DIR, 'mocap-gen', resultId, animName);
      fs.mkdirSync(workDir, { recursive: true });
      const refOrange = await refOrangeShare(refs.angle);
      const meshCtx = o.guide === 'mannequin' ? null : await getMeshCtx(o.motionId);
      const ctx = { ...o, motion, view, hand, mirror, statureM: charInfo.statureM, ppm, refs, model, quality: o.quality || 'high', charInfo, workDir, animName, refOrange, meshCtx };
      const variant = { view, viewLabel: M.VIEWS[view].label, hand, mirror, animName, status: 'generating', frames: [], ppm, statureM: charInfo.statureM, pixelHeight: charInfo.pixelHeight, guide: meshCtx ? 'mesh' : 'mannequin' };
      result.variants.push(variant);
      tick(`${M.VIEWS[view].label} · ${hand} hand: anchor frame…`);

      // Anchor frame first; the rest reference it (parallel, consistent)
      const gens = new Array(frameIdx.length);
      gens[0] = await generateOneFrame(ctx, frameIdx[0]);
      result.cost += gens[0].cost;
      doneFrames++;
      const anchorPath = path.join(workDir, 'anchor.png');
      // Anchor reference = the anchor character placed at its own scale on the pose canvas
      fs.writeFileSync(anchorPath, await C.placeOnCanvas(gens[0].prep, gens[0].render.bbox, gens[0].k));
      tick(`${M.VIEWS[view].label} · ${hand} hand: frames…`);
      await pool(frameIdx.slice(1), Math.max(1, Math.min(4, +o.concurrency || 3)), async (fi, j) => {
        gens[j + 1] = await generateOneFrame(ctx, fi, { anchorPath });
        result.cost += gens[j + 1].cost;
        doneFrames++;
        tick(`${M.VIEWS[view].label} · ${hand}: ${doneFrames}/${totalFrames} frames`);
      });

      // Align with a clamped per-frame scale around the median, then QC + retry
      const kMedian = S.median(gens.map((g) => g.k));
      let anchorFinal = await finishFrame(ctx, gens[0], kMedian, null);
      const finals = [anchorFinal];
      for (let j = 1; j < gens.length; j++) finals.push(await finishFrame(ctx, gens[j], kMedian, anchorFinal.profile));
      for (let j = 0; j < finals.length; j++) {
        let attempts = 1;
        while (!finals[j].qc.pass && attempts <= retries) {
          tick(`${M.VIEWS[view].label} · ${hand}: retrying frame ${j + 1} (${finals[j].qc.issues[0]})`);
          const g = await generateOneFrame(ctx, frameIdx[j], { anchorPath: j === 0 ? null : anchorPath });
          result.cost += g.cost;
          const f = await finishFrame(ctx, g, kMedian, j === 0 ? null : anchorFinal.profile);
          attempts++;
          if (f.qc.score > finals[j].qc.score) { finals[j] = f; gens[j] = g; }
          finals[j].rawFile = gens[j].rawFile;
        }
        finals[j].qc.attempts = attempts;
        if (j === 0) anchorFinal = finals[0];
      }

      const out = await writeVariantOutputs(ctx, finals, frameIdx);
      Object.assign(variant, {
        status: 'done', kMedian, spriteUrl: out.stripUrl, frameUrls: out.frameUrls, clipped: out.clipped, shot: out.shot || null,
        frameCount: finals.length, fps: result.fps,
        frames: finals.map((f, j) => ({ index: j, sourceFrame: frameIdx[j], pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, attempts: f.qc.attempts, metrics: f.qc.metrics, raw: gens[j].rawFile, transparent: gens[j].transparent })),
        qcPassRate: +(finals.filter((f) => f.qc.pass).length / finals.length).toFixed(2),
      });
      await store.saveResult(result);
      tick(`${M.VIEWS[view].label} · ${hand} hand done`);
    }
  }
  result.status = 'done';
  result.cost = +result.cost.toFixed(4);
  await store.saveResult(result);
  await store.upsertIndex('results', resultId, { motionId: o.motionId, charName: o.charName, model, createdAt: result.createdAt, variants: result.variants.length });
  return result;
}

/** Regenerate one frame of a finished variant. */
async function regenFrame(o) {
  const result = await store.loadResult(o.resultId);
  if (!result) throw new Error('Result not found');
  const variant = result.variants.find((v) => v.animName === o.animName);
  if (!variant) throw new Error('Variant not found');
  const motion = await store.loadMotionFile(result.motionId, 'motion');
  const charInfo = loadCharacter(result.charName);
  const j = +o.frameIndex;
  const fi = result.frameIdx[j];
  if (fi == null) throw new Error('frameIndex out of range');
  const refs = characterRefs(o.ASSETS_DIR, result.charName, M.VIEWS[variant.view].angleIdx);
  const workDir = path.join(o.TMP_DIR, 'mocap-gen', result.id, variant.animName);
  fs.mkdirSync(workDir, { recursive: true });
  const model = o.model || result.model;
  const ctx = {
    ...o, motion, view: variant.view, hand: variant.hand, mirror: variant.mirror, statureM: variant.statureM,
    ppm: variant.ppm, refs, model, quality: result.quality, charInfo, workDir, animName: variant.animName, motionId: result.motionId, charName: result.charName,
    refOrange: await refOrangeShare(refs.angle),
    meshCtx: variant.guide === 'mesh' ? await getMeshCtx(result.motionId) : null,
  };
  // Anchor = hi-res frame 0 mapped back onto the pose canvas is not needed: the
  // model only needs to see the approved look, so hand it frame 0 as-is.
  const framesDir = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}-frames`);
  const anchorPath = j === 0 ? null : path.join(framesDir, 'frame-0.png');
  const g = await generateOneFrame(ctx, fi, { anchorPath: anchorPath && fs.existsSync(anchorPath) ? anchorPath : null, custom: o.customPrompt });
  const anchorProfile = anchorPath && fs.existsSync(anchorPath) ? await C.colorProfile(fs.readFileSync(anchorPath)) : null;
  const f = await finishFrame(ctx, g, variant.kMedian || g.k, anchorProfile);

  // Rebuild the strip from the stored hi-res frames with this one replaced
  const game = await C.toGameFrame(f.canvas, { statureM: variant.statureM, ppm: variant.ppm, pixelHeight: charInfo.pixelHeight, outSize: C.GAME.size * C.HIRES });
  const target = path.join(framesDir, `frame-${j}.png`);
  fs.writeFileSync(target, game.buf);
  const r2 = require('../r2-storage');
  if (r2.isAvailable()) r2.uploadFile(`${result.charName}-${variant.animName}-frames/frame-${j}.png`, target).catch(() => {});
  const bufs = [];
  for (let i = 0; i < variant.frameCount; i++) {
    const p = path.join(framesDir, `frame-${i}.png`);
    bufs.push(await sharp(p).resize(C.GAME.size, C.GAME.size, { kernel: 'lanczos3' }).png().toBuffer());
  }
  const stripPath = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}.png`);
  await C.buildStripFromFrames(bufs, stripPath);
  if (r2.isAvailable()) r2.uploadFile(`${result.charName}-${variant.animName}.png`, stripPath).catch(() => {});

  variant.frames[j] = { index: j, sourceFrame: fi, pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, attempts: (variant.frames[j]?.attempts || 1) + 1, metrics: f.qc.metrics, raw: g.rawFile, transparent: g.transparent };
  variant.spriteUrl = `/assets/${result.charName}-${variant.animName}.png?v=${Date.now().toString(36)}`;
  variant.qcPassRate = +(variant.frames.filter((x) => x.pass).length / variant.frames.length).toFixed(2);
  result.cost = +((result.cost || 0) + g.cost).toFixed(4);
  await store.saveResult(result);
  return { variant, frameUrl: `/assets/${result.charName}-${variant.animName}-frames/frame-${j}.png?v=${Date.now().toString(36)}` };
}

/**
 * Re-align + re-composite a finished result from its stored raw generations
 * against the CURRENT motion (after a re-clean or a ball fix). No model calls.
 */
async function recomposeResult(o) {
  const result = await store.loadResult(o.resultId);
  if (!result) throw new Error('Result not found');
  const motion = await store.loadMotionFile(result.motionId, 'motion');
  const charInfo = loadCharacter(result.charName);
  const r2 = require('../r2-storage');
  let done = 0;
  for (const variant of result.variants) {
    if (o.animName && variant.animName !== o.animName) continue;
    const refs = characterRefs(o.ASSETS_DIR, result.charName, M.VIEWS[variant.view].angleIdx);
    const ctx = {
      ...o, motion, view: variant.view, hand: variant.hand, mirror: variant.mirror, statureM: charInfo.statureM,
      charName: result.charName, animName: variant.animName, motionId: result.motionId, charInfo,
      refOrange: await refOrangeShare(refs.angle),
      meshCtx: variant.guide === 'mesh' ? await getMeshCtx(result.motionId) : null,
    };
    ctx.ppm = M.fitScale(motion, { statureM: charInfo.statureM, mirror: variant.mirror });
    const genDir = path.join(o.ASSETS_DIR, `${result.charName}-${variant.animName}-gen`);
    const gens = [];
    for (let j = 0; j < variant.frames.length; j++) {
      const fr = variant.frames[j];
      if (!fr.raw) throw new Error(`${variant.animName} frame ${j} has no stored raw generation (made before recompose existed)`);
      let raw = null;
      const p = path.join(genDir, fr.raw);
      if (fs.existsSync(p)) raw = fs.readFileSync(p);
      else if (r2.isAvailable()) raw = await r2.downloadFile(`${result.charName}-${variant.animName}-gen/${fr.raw}`);
      if (!raw) throw new Error(`raw generation missing: ${fr.raw}`);
      const fi = Math.min(motion.frameCount - 1, result.frameIdx[j]);
      const render = await M.renderFrame(motion, fi, { view: variant.view, mirror: variant.mirror, statureM: charInfo.statureM, ppm: ctx.ppm, meshCtx: ctx.meshCtx });
      const prep = await C.prepareGenerated(raw, fr.transparent !== false && models.modelInfo(result.model).transparent);
      gens.push({ fi, render, prep, k: C.fitScaleFor(prep.stats, render.bbox), rawFile: fr.raw, transparent: fr.transparent });
    }
    const kMedian = S.median(gens.map((g) => g.k));
    const anchor = await finishFrame(ctx, gens[0], kMedian, null);
    const finals = [anchor];
    for (let j = 1; j < gens.length; j++) finals.push(await finishFrame(ctx, gens[j], kMedian, anchor.profile));
    const out = await writeVariantOutputs(ctx, finals, result.frameIdx);
    Object.assign(variant, {
      shot: out.shot || null, kMedian, ppm: ctx.ppm, statureM: charInfo.statureM, pixelHeight: charInfo.pixelHeight, spriteUrl: out.stripUrl, frameUrls: out.frameUrls, clipped: out.clipped,
      frames: finals.map((f, j) => ({ ...variant.frames[j], pass: f.qc.pass, score: f.qc.score, issues: f.qc.issues, metrics: f.qc.metrics })),
      qcPassRate: +(finals.filter((f) => f.qc.pass).length / finals.length).toFixed(2), recomposedAt: new Date().toISOString(),
    });
    done++;
  }
  await store.saveResult(result);
  return { result, variantsRecomposed: done };
}

module.exports = { handCrop, recomposeResult, analyzeVideo, reprocessMotion, enrichMotion, getMeshCtx, generateMove, regenFrame, loadCharacter, buildPrompt, buildCompactPrompt, variantName };
