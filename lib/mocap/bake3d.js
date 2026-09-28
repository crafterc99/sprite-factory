/**
 * bake3d — a cleaned mocap motion + its SAM 3D Body scans → a 3D character
 * animation for the browser sandbox (court3d.html).
 *
 * Per motion frame the performer's scan is re-posed on the cleaned joints
 * (same surface skinning as the 2D pose guide), so the vertices of every frame
 * correspond 1:1 and the browser can blend frames smoothly at any frame rate.
 *
 * Output (JSON, arrays base64):
 *   meta     fps, frameCount, statureM (after retarget), loop, name
 *   faces    Uint32 triangle indices (shared by every frame)
 *   colors   Uint8 RGB per vertex — outfit painted by body part (character look)
 *   frames   Int16 xyz per vertex per frame, metres / QUANT, y-up, feet on y=0,
 *            facing +Z, in place (travel is separate)
 *   palms    per frame [lx,ly,lz, rx,ry,rz] — where the hands are (ball logic)
 *   balls    per frame { p:[x,y,z], held, hand } | null (null = released / none)
 *   travel   per frame [x, z] body travel relative to frame 0 (step-backs etc.)
 *   shot     release info when the move is a shot
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const S = require('./skeleton');
const { J } = S;
const MG = require('./mesh-guide');
const store = require('./store');

const BAKE_ASSET = 'bake3d-v1.json.gz';
const QUANT = 0.0005; // 0.5 mm per unit (±16 m)
const CHARACTER_HEIGHT_M = 1.83; // ankh, 6'0"

// Outfit palette (ankh: black oversized tee, red shorts, white socks + shoes)
const PAL = {
  skin: [112, 72, 48], hair: [26, 18, 12], shirt: [22, 22, 26], shorts: [206, 30, 36],
  sock: [236, 236, 236], shoe: [245, 245, 245], sole: [200, 200, 205],
};
// Segment index → body part (mesh-guide SEGS order: pelvis, chest, head, then
// per side: upper arm, forearm, hand, thigh, shin, foot, 16 finger bones)
function partOf(k) {
  if (k === 0) return 'pelvis';
  if (k === 1) return 'chest';
  if (k === 2) return 'head';
  const j = (k - 3) % 22;
  return ['upperArm', 'forearm', 'hand', 'thigh', 'shin', 'foot'][j] || 'finger';
}

/** Paint the outfit on the scan from each vertex's bone and position along it. */
function outfitColors(bind) {
  const out = new Uint8Array(bind.n * 3);
  for (let i = 0; i < bind.n; i++) {
    const k = bind.seg[i * 2];
    const t = bind.loc[i * 6];          // 0 at the bone's start joint → 1 at its end
    const back = bind.loc[i * 6 + 2];   // along the bone frame's w axis
    let c;
    switch (partOf(k)) {
      case 'pelvis': c = t < 0.5 ? PAL.shorts : PAL.shirt; break;
      case 'chest': c = PAL.shirt; break;
      case 'head': c = t > 1.3 || (t > 0.85 && back < -0.03) ? PAL.hair : PAL.skin; break;
      case 'upperArm': c = t < 0.55 ? PAL.shirt : PAL.skin; break;
      case 'thigh': c = t < 0.82 ? PAL.shorts : PAL.skin; break;
      case 'shin': c = t > 0.8 ? PAL.sock : PAL.skin; break;
      case 'foot': c = t < 0.08 ? PAL.sock : PAL.shoe; break;
      default: c = PAL.skin;
    }
    out.set(c, i * 3);
  }
  return out;
}

function gaussianSmooth(series, sigma) {
  const r = Math.ceil(sigma * 2.5);
  return series.map((_, i) => {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const v = series[i + k];
      if (v === undefined) continue;
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      s += v * w; ws += w;
    }
    return ws ? s / ws : series[i];
  });
}

const cache = new Map();

async function bake(motionId, { heightM = CHARACTER_HEIGHT_M } = {}) {
  const motion = await store.loadMotionFile(motionId, 'motion');
  const meta = await store.loadMotionFile(motionId, 'meta');
  if (!motion) throw new Error('motion not found');
  const key = JSON.stringify([motionId, motion.settings, motion.frameCount, heightM]);
  if (cache.has(key)) return cache.get(key);
  const diskPath = path.join(store.motionDir(motionId), 'bake3d.json');
  if (fs.existsSync(diskPath)) {
    try { const j = JSON.parse(fs.readFileSync(diskPath, 'utf8')); if (j.key === key) { cache.set(key, j); return j; } } catch {}
  }
  // Cloud copy (survives redeploys/restarts — a cold rebake takes 5–15 s)
  try {
    const fp = await store.loadMotionAsset(motionId, BAKE_ASSET);
    if (fp) {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8'));
      if (j.key === key) {
        cache.set(key, j);
        try { fs.writeFileSync(diskPath, JSON.stringify(j)); } catch {}
        return j;
      }
    }
  } catch {}
  const { getMeshCtx } = require('./pipeline');
  const meshCtx = await getMeshCtx(motionId);
  if (!meshCtx) throw new Error('this motion has no SAM 3D Body meshes — use "Add 3D body mesh" on its Motion page first');

  const s = heightM / (motion.statureM || heightM);
  const N = motion.frameCount;
  const footIdx = [J['left-heel'], J['right-heel'], J['left-big-toe-tip'], J['right-big-toe-tip'], J['left-small-toe-tip'], J['right-small-toe-tip']];
  const frames = [], palms = [], balls = [];
  let colors = null, nV = 0;
  for (let i = 0; i < N; i++) {
    const bind = await meshCtx.bindingForFrame(motion, i);
    if (!bind) throw new Error(`no mesh binding for frame ${i}`);
    if (!colors) { colors = outfitColors(bind); nV = bind.n; }
    const P = motion.frames[i].joints;
    const v = MG.poseMesh(bind, P);
    // sole on the floor-snapped feet (same as the 2D guide)
    const footKpY = Math.min(...footIdx.map((k) => P[k][1]));
    let meshFootY = Infinity;
    for (let q = 0; q < bind.n; q++) if (bind.foot[q] && v[q * 3 + 1] < meshFootY) meshFootY = v[q * 3 + 1];
    const lift = Number.isFinite(meshFootY) ? footKpY - meshFootY : 0;
    const q16 = new Int16Array(nV * 3);
    for (let q = 0; q < nV * 3; q++) {
      const val = (q % 3 === 1 ? v[q] + lift : v[q]) * s;
      q16[q] = Math.max(-32767, Math.min(32767, Math.round(val / QUANT)));
    }
    frames.push(Buffer.from(q16.buffer).toString('base64'));
    const palm = (side) => S.scale(S.mid(P[J[`${side}-wrist`]], P[J[`${side}-middle-first-joint`]]), s);
    const pl = palm('left'), pr = palm('right');
    palms.push([...pl, ...pr].map((x) => +x.toFixed(4)));
    const b = motion.frames[i].ball;
    if (b) {
      const bp = S.scale(b.p, s);
      balls.push({ p: bp.map((x) => +x.toFixed(4)), held: !!b.held, hand: S.dist(bp, pl) <= S.dist(bp, pr) ? 'left' : 'right' });
    } else balls.push(null);
  }
  // body travel (the in-place motion had it removed): smoothed pelvis path
  const root = motion.root || [];
  const sig = Math.max(1.5, (motion.fps || 12) * 0.3);
  const rx = gaussianSmooth(root.map((r) => r[0]), sig), rz = gaussianSmooth(root.map((r) => r[2]), sig);
  const travel = root.length === N ? rx.map((x, i) => [+((x - rx[0]) * s).toFixed(4), +((rz[i] - rz[0]) * s).toFixed(4)]) : Array.from({ length: N }, () => [0, 0]);

  const out = {
    key,
    meta: {
      motionId, name: meta?.name || motionId, fps: motion.fps || 12, frameCount: N, vertexCount: nV,
      statureM: heightM, scale: +s.toFixed(4), quant: QUANT, ballRadius: +(0.12 * s).toFixed(4),
      startingHand: motion.startingHand || null,
    },
    faces: Buffer.from(Uint32Array.from(meshCtx.faces).buffer).toString('base64'),
    colors: Buffer.from(colors).toString('base64'),
    frames, palms, balls, travel,
    shot: motion.report?.shotRelease ? { ...motion.report.shotRelease, point: S.scale(motion.report.shotRelease.point, s) } : null,
  };
  cache.set(key, out);
  try { fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, JSON.stringify(out)); } catch {}
  store.saveMotionAsset(motionId, BAKE_ASSET, zlib.gzipSync(Buffer.from(JSON.stringify(out)))).catch(() => {});
  return out;
}

/** Gzipped response body for a bake (cached per bake key). */
const gzCache = new Map();
async function bakeGz(motionId, opts) {
  const out = await bake(motionId, opts);
  let hit = gzCache.get(out.key);
  if (!hit) {
    const raw = Buffer.from(JSON.stringify(out));
    hit = { gz: zlib.gzipSync(raw), rawLength: raw.length };
    gzCache.set(out.key, hit);
    if (gzCache.size > 8) gzCache.delete(gzCache.keys().next().value);
  }
  return hit;
}

module.exports = { bake, bakeGz, outfitColors, partOf, QUANT, PAL };
