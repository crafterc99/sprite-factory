/**
 * Character rig — one SAM 3D Body scan → a skinned character any game clip
 * can drive (court3d.html via public/js/anim3d.js).
 *
 *   rest mesh     the performer's scan (one frame), scaled to the character's
 *                 height; optional proportions (longer legs/arms, torso) are
 *                 applied by re-posing the scan on a stretched skeleton
 *   skinning      the mesh guide's surface binding: each vertex follows two of
 *                 the 47 bone segments (geodesic labelling, blended at joints).
 *                 In the engine that is plain linear-blend skinning:
 *                   v = Σ w · M_seg(pose) · M_seg(rest)⁻¹ · v_rest
 *                 where M_seg = [u·L | v | w | a] is built from joint positions
 *                 exactly as mesh-guide.js segFrame does (same code in anim3d.js)
 *   skeleton      rest joints (MHR70) + bone lengths along skeleton.PARENT —
 *                 what clips are retargeted to, so any clip plays on any rig
 *   outfit        per-vertex colours by body part (bake3d palette)
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const S = require('./skeleton');
const { J } = S;
const MG = require('./mesh-guide');
const store = require('./store');
const { outfitColors, PAL } = require('./bake3d');

const RIG_VERSION = 3;

// Characters. `from` = another preset whose scan is reused; proportions are
// multipliers on bone lengths (1 = the performer's own build).
const CHARACTERS = {
  // textured MPFB (MakeHuman, CC0) character on Ankh's MHR skeleton — scripts/mpfb/
  player: { name: 'Player · 5\'11" (textured)', from: 'ankh', heightM: 1.81, palette: {} },
  ankh: { name: 'Ankh · 6\'0"', heightM: 1.83, palette: {} },
  big: { name: 'Big · 6\'11"', from: 'ankh', heightM: 2.11, proportions: { leg: 1.07, arm: 1.08, torso: 1.02 }, palette: { shirt: [240, 240, 244], shorts: [20, 70, 200] } },
  guard: { name: 'Guard · 5\'9"', from: 'ankh', heightM: 1.75, proportions: { leg: 0.97, arm: 0.98, torso: 1.0 }, palette: { shirt: [250, 196, 30], shorts: [30, 30, 36] } },
};
// artist-made characters (scripts/import-rigged-character.js → mhr-rigs/<id>.json.gz + custom.json)
// (re-read when a character is unknown or the registry changed: Character Factory imports show up
// without a server restart)
let _regMtime = 0;
function loadCustomRegistry() {
  try {
    const f = path.join(__dirname, 'mhr-rigs', 'custom.json');
    const mt = fs.statSync(f).mtimeMs;
    if (mt === _regMtime) return;
    _regMtime = mt;
    const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [cid, c] of Object.entries(reg)) if (/^[a-z0-9-]+$/.test(cid) && (!Object.hasOwn(CHARACTERS, cid) || CHARACTERS[cid].custom)) CHARACTERS[cid] = { name: String(c.name || cid), from: 'ankh', heightM: +c.heightM || 1.8, palette: {}, custom: true };
  } catch { /* none yet */ }
}
loadCustomRegistry();

const LEG_BONES = new Set(['left-knee', 'right-knee', 'left-ankle', 'right-ankle'].map((n) => J[n]));
const ARM_BONES = new Set(['left-elbow', 'right-elbow', 'left-wrist', 'right-wrist'].map((n) => J[n]));
const TORSO_BONES = new Set([J.neck]);

function boneLengths(P) {
  const Q = S.withPelvis(P);
  return S.PARENT.map((p, k) => (p < 0 ? 0 : +S.dist(Q[k], Q[p]).toFixed(5)));
}

/** Standing height from bone lengths (the scan itself is posed, e.g. crouched). */
function standingHeight(bl) {
  const leg = (s) => bl[J[`${s}-knee`]] + bl[J[`${s}-ankle`]] + 0.85 * bl[J[`${s}-heel`]];
  const earToNeck = (bl[J['left-ear']] + bl[J['right-ear']]) / 2;
  return (leg('left') + leg('right')) / 2 + bl[J.neck] + 1.95 * earToNeck;
}

/** Rebuild a skeleton with scaled bone groups (FK from the pelvis). */
function reproportion(P, prop = {}) {
  const Q = S.withPelvis(P);
  const out = Q.map((p) => p.slice());
  for (const k of S.TOPO) {
    const p = S.PARENT[k];
    if (p < 0) continue;
    const m = LEG_BONES.has(k) ? prop.leg || 1 : ARM_BONES.has(k) ? prop.arm || 1 : TORSO_BONES.has(k) ? prop.torso || 1 : 1;
    out[k] = S.add(out[p], S.scale(S.sub(Q[k], Q[p]), m));
  }
  return out.slice(0, 70);
}

/**
 * Scan frames ranked for skinning: limbs clear of the body first (cleaner
 * weights); frames the cleaned motion uses rank above trimmed-off ones.
 */
function rankRestFrames(recs, used = new Set()) {
  const scored = [];
  for (const r of recs) {
    const P = r.meshKp3d || r.kp3d;
    if (!P) continue;
    const hip = S.mid(P[J['left-hip']], P[J['right-hip']]), neck = P[J.neck];
    const axis = S.norm(S.sub(neck, hip));
    const off = (q) => { const d = S.sub(q, hip); return S.len(S.sub(d, S.scale(axis, S.dot(d, axis)))); };
    const score = Math.min(off(P[J['left-wrist']]), off(P[J['right-wrist']])) + 0.5 * S.dist(P[J['left-knee']], P[J['right-knee']])
      - (r.meshAlignErr || 0) * 2 + (used.has(r.file) ? 1 : 0);
    scored.push({ r, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.r);
}

/** Every motion id: the index, plus motion folders on disk the index lacks (local dev). */
async function listMotionIds() {
  const idx = await store.loadIndex();
  const ids = new Set(Object.values(idx.motions || {}).map((m) => m.id || m.motionId).filter(Boolean));
  try { for (const d of fs.readdirSync(path.dirname(store.motionDir('x')))) if (/^mo-/.test(d) && fs.existsSync(path.join(store.motionDir(d), 'meta.json'))) ids.add(d); } catch {}
  return [...ids];
}

async function listMeshMotions() {
  const metas = await Promise.all((await listMotionIds()).map((id) => store.loadMotionFile(id, 'meta').catch(() => null)));
  return metas.filter((m) => m?.mesh?.frames).map((m) => ({ id: m.id, name: m.name || m.id, createdAt: m.createdAt }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The motion whose scan a character is made from (default: the first idle with meshes). */
async function sourceMotionFor(def, opts = {}) {
  if (opts.motionId) return opts.motionId;
  if (def.motionId) return def.motionId;
  const ms = await listMeshMotions();
  if (!ms.length) throw new Error('no motion with SAM 3D Body meshes yet — analyse a clip on /mocap and add its 3D body mesh first');
  return (ms.find((m) => /idle|stance/i.test(m.name)) || ms[0]).id;
}

const cache = new Map();

/**
 * @param {string} charId preset id (ankh | big | guard)
 * @param {object} opts { motionId, frame (source file name) } — build from another scan
 */
/**
 * MHR rigs (v4): baked offline by scripts/mhr/bake_rig.py from the MHR body
 * model (Meta's Momentum Human Rig, Apache-2.0) fitted to the performer —
 * its own mesh, 127-joint skeleton (clavicles, spine, limb twist joints) and
 * skin weights. The court drives it with engine3d/mhr-skin.mjs.
 */
const MHR_DIR = path.join(__dirname, 'mhr-rigs');
const mhrCache = new Map();
function mhrRig(charId) {
  const fp = path.join(MHR_DIR, `${charId}.json.gz`);
  // cached per file version: a re-imported character is picked up without a restart
  const mt = fs.existsSync(fp) ? fs.statSync(fp).mtimeMs : 0;
  if (mhrCache.has(charId) && mhrCache.get(charId).mtime === mt) return mhrCache.get(charId);
  if (!mt) return null;
  const gz = fs.readFileSync(fp);
  const json = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  const out = { json, gz, mtime: mt, etag: '"' + crypto.createHash('sha1').update(gz).digest('hex').slice(0, 20) + '"' };
  mhrCache.set(charId, out);
  return out;
}

async function buildRig(charId = 'ankh', opts = {}) {
  if (!Object.hasOwn(CHARACTERS, charId)) loadCustomRegistry();
  const def0 = Object.hasOwn(CHARACTERS, charId) ? CHARACTERS[charId] : null;
  if (!def0) throw new Error(`unknown character "${charId}"`);
  // the MHR rig unless an older scan rig is asked for (?legacy=1, ?motion, ?frame)
  if (!opts.legacy && !opts.motionId && !opts.frame) { const m = mhrRig(charId); if (m) return m; }
  const base = def0.from ? CHARACTERS[def0.from] : def0;
  const def = { ...base, ...def0, palette: { ...(base.palette || {}), ...(def0.palette || {}) } };
  const motionId = await sourceMotionFor(def, opts);
  const raw = await store.loadMotionFile(motionId, 'raw');
  if (!raw?.meshFaces) throw new Error(`motion ${motionId} has no 3D body mesh`);
  const recs = raw.frames.filter((r) => r.mesh && (r.meshKp3d || r.kp3d));
  const motion = await store.loadMotionFile(motionId, 'motion').catch(() => null);
  const used = new Set((motion?.frames || []).map((f) => f.sourceFile).filter(Boolean));
  const loadAsset = async (name) => { const fp = await store.loadMotionAsset(motionId, name).catch(() => null); return fp ? fs.readFileSync(fp) : null; };
  const ranked = opts.frame ? recs.filter((r) => r.file === opts.frame) : rankRestFrames(recs, used);
  if (!ranked.length) throw new Error(`motion ${motionId} has no usable scan frame`);
  // the first ranked frame whose mesh is downloadable
  let rec = null, meshBuf = null;
  for (const r of ranked.slice(0, 6)) { meshBuf = await loadAsset(r.mesh); if (meshBuf) { rec = r; break; } }
  if (!rec) throw new Error('mesh download failed — retry');
  const key = JSON.stringify([RIG_VERSION, charId, def, motionId, rec.file, rec.mesh]);
  const etag = '"' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '"';
  if (cache.has(key)) return cache.get(key);
  const asset = `rig-v${RIG_VERSION}-${charId}.json.gz`;
  const diskPath = path.join(store.motionDir(motionId), asset);
  const tryLoad = (buf) => { try { const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); if (j.key === key) return { json: j, gz: buf }; } catch {} return null; };
  let hit = fs.existsSync(diskPath) ? tryLoad(fs.readFileSync(diskPath)) : null;
  if (!hit) {
    try { const fp = await store.loadMotionAsset(motionId, asset); if (fp) hit = tryLoad(fs.readFileSync(fp)); } catch {}
  }
  if (hit) {
    const out = { ...hit, etag };
    cache.set(key, out);
    return out;
  }

  const facesBuf = await loadAsset(raw.meshFaces);
  if (!facesBuf) throw new Error('mesh download failed — retry');
  const faces = MG.decodeFaces(facesBuf);
  const verts = MG.decodeVerts(meshBuf);
  const kp = rec.meshKp3d || rec.kp3d;
  const bind = MG.bindMesh(verts, kp, faces);

  // proportions, then one uniform scale to the character's height
  let rest = def.proportions ? reproportion(kp, def.proportions) : kp.map((p) => p.slice());
  let v = def.proportions ? MG.poseMesh(bind, rest) : Float32Array.from(verts);
  const s = def.heightM / standingHeight(boneLengths(rest));
  rest = rest.map((p) => S.scale(p, s));
  for (let i = 0; i < v.length; i++) v[i] *= s;
  const boneLen = boneLengths(rest);
  // sole offset: how far the shoe's sole sits below the heel/toe keypoints
  // (clips put the lowest KEYPOINT on the floor; the mesh must stand on it)
  const soleDepth = [];
  for (const [side, segK] of [['left', 3 + 5], ['right', 25 + 5]]) {
    const heel = rest[J[`${side}-heel`]], big = rest[J[`${side}-big-toe-tip`]], small = rest[J[`${side}-small-toe-tip`]], ankle = rest[J[`${side}-ankle`]];
    let nrm = S.norm(S.cross(S.sub(big, heel), S.sub(small, heel)));
    if (S.dot(S.sub(ankle, heel), nrm) < 0) nrm = S.scale(nrm, -1);
    const d = [];
    for (let i = 0; i < bind.n; i++) if (bind.seg[i * 2] === segK) d.push(S.dot(S.sub([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]], heel), nrm));
    if (d.length) soleDepth.push(-S.percentile(d, 0.02));
  }
  const soleOffset = soleDepth.length ? Math.max(0, Math.min(0.12, soleDepth.reduce((a, b) => a + b, 0) / soleDepth.length)) : 0;
  const legLen = (boneLen[J['left-knee']] + boneLen[J['left-ankle']] + boneLen[J['right-knee']] + boneLen[J['right-ankle']]) / 2;

  const n = bind.n;
  const skin = new Uint8Array(n * 2), weight = new Uint8Array(n);
  for (let i = 0; i < n; i++) { skin[i * 2] = bind.seg[i * 2]; skin[i * 2 + 1] = bind.seg[i * 2 + 1]; weight[i] = Math.round(Math.max(0, Math.min(1, bind.wt[i])) * 255); }
  const faces16 = n < 65536;
  const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
  const json = {
    key, version: RIG_VERSION, id: charId, name: def.name, heightM: def.heightM,
    source: { motionId, file: rec.file }, vertexCount: n, faceCount: faces.length / 3,
    segCount: MG.SEGS.length,
    verts: b64(Float32Array.from(v)),
    faces: b64(faces16 ? Uint16Array.from(faces) : Uint32Array.from(faces)), faces32: !faces16,
    skin: b64(skin), weight: b64(weight),
    colors: b64(outfitColors(bind, def.palette)),
    restJoints: rest.map((p) => p.map((x) => +x.toFixed(5))),
    boneLen, parent: S.PARENT, legLen: +legLen.toFixed(4), soleOffset: +soleOffset.toFixed(4),
    proportions: def.proportions || null,
  };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(json)));
  const out = { json, gz, etag };
  cache.set(key, out);
  try { fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, gz); } catch {}
  store.saveMotionAsset(motionId, asset, gz).catch(() => {});
  return out;
}

function listCharacters() {
  loadCustomRegistry();
  return Object.entries(CHARACTERS).map(([id, d]) => ({ id, name: d.name, heightM: d.heightM, proportions: d.proportions || null }));
}

module.exports = { buildRig, listCharacters, listMeshMotions, listMotionIds, CHARACTERS, boneLengths, standingHeight, reproportion, rankRestFrames, PAL };
