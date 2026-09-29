#!/usr/bin/env node
/**
 * Import a rigged character (FBX or GLB; Mixamo "mixamorig" skeletons from Mixamo, Tripo, Meshy,
 * AccuRig, or a UE4 / UE5 Mannequin skeleton) as a court character on the game's MHR skeleton,
 * with the hands re-rigged for ball contact.
 *
 *   node scripts/import-mixamo-character.mjs <model.glb|model.fbx> <id> ["Display name"] [--from player]
 *        [--palette '{"skin":[120,80,55],"shirt":[245,245,245],...}'] [--proportions model|game]
 *
 * Textures: the base colour and normal map of each material are written to
 * lib/mocap/mhr-rigs/<id>-tex/*.webp (max 2048) and served at /chars/<id>/…; UVs are kept (the
 * mesh is welded on position for the rig, on position + UV for rendering, so seams stay sharp).
 * A model without texture gets a flat colour per garment piece (--palette).
 *
 * 1. Pose fit: every Mixamo bone is moved onto the matching game joint (rotation + its length
 *    along the bone; bones with several children — hips, chest, hands — by a least-squares fit
 *    of all their children, so the palm and the face keep their facing). The mesh follows through
 *    its own skin weights: it lands on the game skeleton in the game's bind pose.
 * 2. Weights on the 127 game joints:
 *    - body: each Mixamo bone's weight is spread over its game joints (with the twist joints
 *      along the arms and legs) as the game's own body rig spreads them at the nearest point;
 *    - fingers: one finger per vertex (the model's own finger, cleaned by neighbour vote: the
 *      source weights bleed between fingers), weights along that finger's joints only —
 *      rigid phalanges, blended at each knuckle — so a finger never pulls its neighbour;
 *    - palm: from the game body rig's palm (wrist, pinky / thumb metacarpals).
 * 3. Parts by garment (separate mesh pieces: skin, shirt, shorts, shoes, hair, eyes…), each a flat
 *    colour (--palette) when the model has no texture.
 * Writes lib/mocap/mhr-rigs/<id>.json.gz and registers <id> in lib/mocap/mhr-rigs/custom.json.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import * as THREE from 'three';

import { resolveObjectURL } from 'buffer';

// Node shims for the three.js loaders. An <img> here "loads" at once and keeps the bytes behind
// its src (blob: from an embedded texture, data:, or a file next to the model), so the textures
// can be re-encoded below; nothing is decoded or uploaded.
function grabImage(u) {
  if (u.startsWith('blob:')) { const b = resolveObjectURL(u); return b ? b.arrayBuffer().then((a) => Buffer.from(a)) : Promise.resolve(null); }
  if (u.startsWith('data:')) return Promise.resolve(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
  const rel = decodeURIComponent(u).replace(/\\/g, '/');
  const f = [rel, path.join(path.dirname(file), rel), path.join(path.dirname(file), path.basename(rel))].find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  return Promise.resolve(f ? fs.readFileSync(f) : null);
}
function fakeImage() {
  const L = {};
  const img = { style: {}, width: 1, height: 1, addEventListener(t, f) { (L[t] ||= []).push(f); }, removeEventListener(t, f) { L[t] = (L[t] || []).filter((g) => g !== f); } };
  Object.defineProperty(img, 'src', { get() { return img._src; }, set(u) { img._src = u; img._bytes = grabImage(String(u)); setTimeout(() => (L.load || []).slice().forEach((f) => f.call(img, {})), 0); } });
  return img;
}
globalThis.self ??= globalThis; globalThis.window ??= globalThis;
globalThis.document ??= { createElementNS: (ns, name) => (name === 'img' ? fakeImage() : { style: {}, addEventListener() {}, getContext: () => null }) };
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const FROM = opt('from', 'player');
const PAL_IN = JSON.parse(opt('palette', '{}'));
const PROPS = opt('proportions', 'model');
const TEXSIZE = +opt('tex-size', 2048);
const LOD = +opt('lod', 0), LOD_DIST = +opt('lod-dist', 0);   // LOD n of an imported character: same skeleton, scale and textures
const MAPPING_FILE = opt('mapping', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'character_pipeline', 'tripo_to_souljam_bones.json'));
const MATERIAL = JSON.parse(opt('material', 'null'));
const [file, id, dispName] = args;
if (!file || !id || !/^[a-z0-9-]+$/.test(id)) { console.error('usage: import-mixamo-character.mjs <model.fbx> <id: a-z0-9-> ["Display name"] [--from player] [--palette json]'); process.exit(2); }
const RIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mocap', 'mhr-rigs');

// ── vectors ──
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]), nrm = (a) => sc(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
// 3×3 row-major
const mv = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const mm = (A, B) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return o; };
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Smallest rotation taking unit a onto unit b. */
function swing(a, b) {
  const v = cross(a, b), c = dot(a, b);
  if (c < -0.9999) { const ax = nrm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])); return [2 * ax[0] * ax[0] - 1, 2 * ax[0] * ax[1], 2 * ax[0] * ax[2], 2 * ax[1] * ax[0], 2 * ax[1] * ax[1] - 1, 2 * ax[1] * ax[2], 2 * ax[2] * ax[0], 2 * ax[2] * ax[1], 2 * ax[2] * ax[2] - 1]; }
  const k = 1 / (1 + c);
  return [v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1], v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0], v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c];
}
/** Best rotation R (weighted Kabsch): R·p_i ≈ q_i (both centred). Horn's quaternion method. */
function kabsch(P, Q, W) {
  const S = new Array(9).fill(0);
  P.forEach((p, i) => { for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += W[i] * p[r] * Q[i][c]; });
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz], [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
  // largest eigenvector by power iteration on N + 4|N|·I
  const sh = 4 * Math.max(...N.flat().map(Math.abs)) + 1e-9;
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 200; it++) { const nq = N.map((row, r) => row.reduce((a, x, c) => a + x * q[c], 0) + sh * q[r]); const l = Math.hypot(...nq); q = nq.map((x) => x / l); }
  const [w, x, y, z] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

// ── the game rig ──
const ref = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RIGS, `${FROM}.json.gz`))));
const M = ref.mhr, JI = Object.fromEntries(M.names.map((n, i) => [n, i]));
let B2 = M.bindPos.map((p) => p.slice());             // the skeleton the mesh is fitted to (refitted below)
const GP = (n) => B2[JI[n]];
const b64 = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const refPart = ref.parts.find((p) => p.name === 'body') || ref.parts[0];
let RV = b64(refPart.verts, Float32Array); const RSI = b64(refPart.skinIdx, Uint8Array), RSW = b64(refPart.skinW, Float32Array), RN = RV.length / 3;

// ── the model (FBX, or GLB / glTF with embedded data) ──
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const IS_GLTF = /\.(glb|gltf)$/i.test(file);
console.warn = () => {};   // FBXLoader: ">4 weights" notices
const root = IS_GLTF
  ? (await new Promise((res, rej) => new GLTFLoader().parse(ab, path.dirname(path.resolve(file)) + '/', res, rej))).scene
  : new FBXLoader().parse(ab, path.dirname(path.resolve(file)) + '/');
root.updateMatrixWorld(true);
const meshes = []; root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
if (!meshes.length) throw new Error(`no skinned mesh in ${path.basename(file)} (it must be rigged)`);
const bones = meshes[0].skeleton.bones;
// bone names: Mixamo ("mixamorig:Hips", Tripo / Meshy / AccuRig) as they are; a UE4 / UE5
// Mannequin skeleton is mapped onto the Mixamo names. Its extra bones (the in-between spine and
// neck bones, twist, metacarpal and IK bones) ride rigidly with their parent and give their
// weight to their parent's game joints.
const rawName = (b) => (b?.name || '').replace(/^mixamorig\d*:?/, '');
const UEMAP = {};
{
  const have = new Set(bones.map((b) => rawName(b).toLowerCase()));
  if (have.has('pelvis') && have.has('hand_l')) {
    const sp = [1, 2, 3, 4, 5].map((k) => `spine_0${k}`).filter((n) => have.has(n));
    const pick = sp.length >= 5 ? [sp[0], sp[2], sp[4]] : sp.length === 4 ? [sp[0], sp[1], sp[3]] : sp;
    ['Spine', 'Spine1', 'Spine2'].forEach((m, i) => { if (pick[i]) UEMAP[pick[i]] = m; });
    Object.assign(UEMAP, { pelvis: 'Hips', neck_01: 'Neck', head: 'Head' });
    for (const [s, x] of [['Left', 'l'], ['Right', 'r']]) {
      Object.assign(UEMAP, { [`clavicle_${x}`]: `${s}Shoulder`, [`upperarm_${x}`]: `${s}Arm`, [`lowerarm_${x}`]: `${s}ForeArm`, [`hand_${x}`]: `${s}Hand`,
        [`thigh_${x}`]: `${s}UpLeg`, [`calf_${x}`]: `${s}Leg`, [`foot_${x}`]: `${s}Foot`, [`ball_${x}`]: `${s}ToeBase` });
      for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let k = 1; k <= 3; k++) UEMAP[`${f.toLowerCase()}_0${k}_${x}`] = `${s}Hand${f}${k}`;
    }
  }
}
const SKELETON = Object.keys(UEMAP).length ? 'ue-mannequin' : 'mixamo';
const bn = (b) => { const n = rawName(b); return UEMAP[n.toLowerCase()] || n; };
const BI = Object.fromEntries(bones.map((b, i) => [bn(b), i]));
if (BI.Hips == null || BI.LeftHand == null || BI.RightHandIndex1 == null) throw new Error('not a Mixamo or UE Mannequin skeleton (Hips / hands / fingers not found)');
const MISSING = ['LeftHandMiddle1', 'LeftHandIndex1', 'LeftHandPinky1', 'RightHandMiddle1', 'RightHandPinky1', 'LeftUpLeg', 'RightUpLeg', 'LeftArm', 'RightArm', 'Neck', 'Head', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].filter((n) => BI[n] == null);
if (MISSING.length) throw new Error('skeleton is missing ' + MISSING.join(', '));
// bind pose (world) of every bone: matrixWorld of the bind = inverse(boneInverse)
const bw = bones.map((b, i) => new THREE.Matrix4().copy(meshes[0].skeleton.boneInverses[i]).invert());
const bpos0 = bw.map((m) => [m.elements[12], m.elements[13], m.elements[14]]);

// welded vertices (FBX triangles carry their own corners) + faces, per mesh piece.
// Two levels: V (welded on position: the rig works on these, so the surface stays connected
// across UV seams) and render vertices (welded on position + UV: a seam keeps its separate UVs,
// every copy takes its position's weights). Each face also keeps its material.
const V = [], W = [], faces = [], facesR = [], faceMat = [];
const rvPos = [], rvUV = [];
const key = new Map(), rkey = new Map();
const MATS = [], matIndex = new Map();
for (const mesh of meshes) {
  const g = mesh.geometry, pa = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, ua = g.attributes.uv;
  const bm = mesh.bindMatrix, v3 = new THREE.Vector3();
  const idx = g.index ? g.index.array : null, n = idx ? idx.length : pa.count;
  const remap = new Int32Array(pa.count).fill(-1), rremap = new Int32Array(pa.count).fill(-1);
  for (let i = 0; i < pa.count; i++) {
    v3.fromBufferAttribute(pa, i).applyMatrix4(bm);
    const k = [v3.x, v3.y, v3.z].map((x) => Math.round(x * 1e5)).join(',');
    let u = key.get(k);
    if (u == null) {
      u = V.length; key.set(k, u); V.push([v3.x, v3.y, v3.z]);
      const inf = []; for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > 1e-4) inf.push([mesh.skeleton.bones === bones ? si.getComponent(i, c) : BI[bn(mesh.skeleton.bones[si.getComponent(i, c)])], w]); }
      const s = inf.reduce((a, x) => a + x[1], 0) || 1; W.push(inf.map(([j, w]) => [j, w / s]));
    }
    remap[i] = u;
    // the rigs store UVs with v up (Blender's); glTF's v runs down the image, FBX's already up
    const uv = ua ? [ua.getX(i), IS_GLTF ? 1 - ua.getY(i) : ua.getY(i)] : [0, 0];
    const rk = u + '|' + Math.round(uv[0] * 1e5) + ',' + Math.round(uv[1] * 1e5);
    let r = rkey.get(rk);
    if (r == null) { r = rvPos.length; rkey.set(rk, r); rvPos.push(u); rvUV.push(uv); }
    rremap[i] = r;
  }
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const gm = mats.map((m) => { if (!matIndex.has(m)) { matIndex.set(m, MATS.length); MATS.push(m); } return matIndex.get(m); });
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
  for (const grp of groups) {
    const mi = gm[grp.materialIndex ?? 0] ?? gm[0];
    for (let t = grp.start; t < Math.min(n, grp.start + grp.count); t += 3) {
      const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
      const a = remap[i0], b = remap[i1], c = remap[i2];
      if (a !== b && b !== c && a !== c) { faces.push([a, b, c]); facesR.push([rremap[i0], rremap[i1], rremap[i2]]); faceMat.push(mi); }
    }
  }
}
// textures: the base colour and normal map of every material (bytes held by the image shim)
const texOf = async (t) => (t?.image?._bytes ? await t.image._bytes : null);
const MATTEX = await Promise.all(MATS.map(async (m) => ({ name: m.name || 'material', color: await texOf(m.map), normal: await texOf(m.normalMap), rough: await texOf(m.roughnessMap || m.metalnessMap), ao: await texOf(m.aoMap), rgb: m.color ? m.color.clone().convertLinearToSRGB().toArray().map((x) => Math.round(x * 255)) : null })));
const TEXTURED = MATTEX.some((m) => m.color);
const NV = V.length;
const nbr = Array.from({ length: NV }, () => new Set());
for (const [a, b, c] of faces) { nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b); }

// ── 1. pose fit ──
let minY0 = Infinity, maxY0 = -Infinity; for (const v of V) { minY0 = Math.min(minY0, v[1]); maxY0 = Math.max(maxY0, v[1]); }
const BASE = LOD ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RIGS, `${id}.json.gz`)))) : null;
if (LOD && !BASE) throw new Error(`LOD ${LOD}: import LOD 0 of ${id} first`);
const S = LOD ? BASE.source.scale : ref.heightM / (maxY0 - minY0);   // uniform scale to the game character's height (LODs: LOD 0's)
const X = (p) => sc(p, S);
const A = bpos0.map(X);                               // bone heads, scaled
const side = (s) => (s === 'Left' ? 'l_' : 'r_');

// ── 0. the skeleton takes the model's proportions (--proportions game keeps the game's) ──
// each chain of joints is scaled to the model's segment length (the joints keep their directions
// and rotations); the feet, head and hip width keep the game's sizes. The rest keypoints, bone
// lengths and leg length the animations retarget to are re-derived from it.
const segRatio = {};
if (process.env.DEBUG_JOINTS) for (const n of process.env.DEBUG_JOINTS.split(',')) console.error('joint', n, BI[n] != null ? A[BI[n]].map((x) => x.toFixed(3)).join(', ') : 'missing', 'scale', S.toFixed(3));
if (PROPS === 'model') {
  const Ab = (n) => A[BI[n]], L = (a, b) => len(sub(a, b)), G0 = (n) => M.bindPos[JI[n]];
  const both = (f) => (f('Left', 'l_') + f('Right', 'r_')) / 2;
  const midp = (a, b) => sc(add(a, b), 0.5);
  segRatio.thigh = both((s, p) => L(Ab(s + 'Leg'), Ab(s + 'UpLeg')) / L(G0(p + 'lowleg'), G0(p + 'upleg')));
  segRatio.shin = both((s, p) => L(Ab(s + 'Foot'), Ab(s + 'Leg')) / L(G0(p + 'foot'), G0(p + 'lowleg')));
  segRatio.torso = (Ab('Neck')[1] - midp(Ab('LeftUpLeg'), Ab('RightUpLeg'))[1]) / (G0('c_neck')[1] - midp(G0('l_upleg'), G0('r_upleg'))[1]);
  segRatio.neck = L(Ab('Head'), Ab('Neck')) / L(G0('c_head'), G0('c_neck'));
  segRatio.shoulder = L(Ab('LeftArm'), Ab('RightArm')) / L(G0('l_uparm'), G0('r_uparm'));
  segRatio.upper = both((s, p) => L(Ab(s + 'ForeArm'), Ab(s + 'Arm')) / L(G0(p + 'lowarm'), G0(p + 'uparm')));
  segRatio.fore = both((s, p) => L(Ab(s + 'Hand'), Ab(s + 'ForeArm')) / L(G0(p + 'wrist'), G0(p + 'lowarm')));
  const handLen = (pts) => pts.slice(1).reduce((a, q, i) => a + L(q, pts[i]), 0);
  // wrist → middle fingertip; a skeleton without fingertip end bones (UE) stops at the last knuckle
  segRatio.hand = both((s, p) => {
    const tip = BI[s + 'HandMiddle4'] != null;
    const mix = [s + 'Hand', s + 'HandMiddle1', s + 'HandMiddle2', s + 'HandMiddle3', ...(tip ? [s + 'HandMiddle4'] : [])];
    const game = ['wrist', 'middle1', 'middle2', 'middle3', ...(tip ? ['middle_null'] : [])];
    return handLen(mix.map(Ab)) / handLen(game.map((n) => G0(p + n)));
  });
  // which ratio moves joint j (its offset from its parent): by the segment it lies on
  const inSub = (j, rootName) => { for (let q = j; q >= 0; q = M.parents[q]) if (M.names[q] === rootName) return true; return false; };
  const ratioOf = (j) => {
    const n = M.names[j], pn = M.parents[j] >= 0 ? M.names[M.parents[j]] : '';
    if (/^[lr]_(foot|talocrural|subtalar|transversetarsal|ball)$/.test(n) && /foot|talocrural|subtalar|transversetarsal/.test(pn)) return 1;
    if (/^[lr]_upleg$/.test(pn)) return segRatio.thigh;
    if (/^[lr]_lowleg$/.test(pn)) return segRatio.shin;
    if (/^[lr]_upleg/.test(n) && pn === 'root') return 1;                           // hip width
    if (inSub(j, 'c_head') && n !== 'c_head') return 1;                             // head
    if (/^c_neck/.test(pn)) return segRatio.neck;
    if (/^[lr]_clavicle$/.test(pn)) return segRatio.shoulder;
    if (/^[lr]_uparm$/.test(pn)) return segRatio.upper;
    if (/^[lr]_lowarm$/.test(pn) || /^[lr]_wrist_twist$/.test(pn)) return segRatio.fore;
    if (inSub(j, 'l_wrist') || inSub(j, 'r_wrist')) return segRatio.hand;
    if (/^(root|c_spine\d)$/.test(pn)) return segRatio.torso;                      // spine, neck base, clavicles
    return 1;
  };
  const nb = M.bindPos.map((p) => p.slice()), done = new Uint8Array(M.names.length);
  const place = (j) => { if (done[j]) return; const p = M.parents[j]; if (p >= 0) { place(p); nb[j] = add(nb[p], sc(sub(M.bindPos[j], M.bindPos[p]), ratioOf(j))); } done[j] = 1; };
  M.names.forEach((_, j) => place(j));
  // feet stay on the floor
  const dy = M.bindPos[JI.l_ball][1] - nb[JI.l_ball][1];
  B2 = nb.map((p) => [p[0], p[1] + dy, p[2]]);
  // the game's body mesh follows its joints (weight transfer reference)
  const R2 = new Float32Array(RV.length);
  for (let r = 0; r < RN; r++) for (let c = 0; c < 4; c++) { const j = RSI[r * 4 + c], w = RSW[r * 4 + c]; if (!w) continue; for (let k = 0; k < 3; k++) R2[r * 3 + k] += w * (RV[r * 3 + k] + B2[j][k] - M.bindPos[j][k]); }
  RV = R2;
}
/** Mixamo joint → game joint (position targets). */
const TARGET = {};
TARGET.Hips = 'root'; TARGET.Spine = 'c_spine1'; TARGET.Spine1 = 'c_spine2'; TARGET.Spine2 = 'c_spine3'; TARGET.Neck = 'c_neck'; TARGET.Head = 'c_head';
for (const s of ['Left', 'Right']) {
  const p = side(s);
  Object.assign(TARGET, { [`${s}Shoulder`]: p + 'clavicle', [`${s}Arm`]: p + 'uparm', [`${s}ForeArm`]: p + 'lowarm', [`${s}Hand`]: p + 'wrist',
    [`${s}UpLeg`]: p + 'upleg', [`${s}Leg`]: p + 'lowleg', [`${s}Foot`]: p + 'foot', [`${s}ToeBase`]: p + 'ball' });
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const g = f.toLowerCase();
    for (let k = 1; k <= 3; k++) TARGET[`${s}Hand${f}${k}`] = p + g + k;
    TARGET[`${s}Hand${f}4`] = p + g + '_null';
  }
}
const children = bones.map(() => []); bones.forEach((b, i) => { if (b.parent?.isBone) children[bones.indexOf(b.parent)].push(i); });
const tgt = (i) => (TARGET[bn(bones[i])] && JI[TARGET[bn(bones[i])]] != null ? GP(TARGET[bn(bones[i])]) : null);
const NOSTRETCH = /^(Head|Neck|HeadTop_End)$|ToeBase|Toe_End/;
const AXIAL = /^(Spine|Spine1|Spine2|Neck|Head|HeadTop_End|LeftShoulder|RightShoulder)$/;
// frames: up = (point u1 − point u0), across = (point l0 − point l1); each point: game-joint / Mixamo-bone names
const J2 = (mix, game) => (get) => get(get.game ? game : mix);
const HIPS = (get) => (get.game ? sc(add(get('l_upleg'), get('r_upleg')), 0.5) : sc(add(get('LeftUpLeg'), get('RightUpLeg')), 0.5));
const SHOULDERS = (get) => (get.game ? sc(add(get('l_uparm'), get('r_uparm')), 0.5) : sc(add(get('LeftArm'), get('RightArm')), 0.5));
const FRAME = {
  Hips: [HIPS, SHOULDERS, J2('LeftUpLeg', 'l_upleg'), J2('RightUpLeg', 'r_upleg')],
  Spine2: [HIPS, SHOULDERS, J2('LeftArm', 'l_uparm'), J2('RightArm', 'r_uparm')],
  LeftHand: [J2('LeftHand', 'l_wrist'), J2('LeftHandMiddle1', 'l_middle1'), J2('LeftHandIndex1', 'l_index1'), J2('LeftHandPinky1', 'l_pinky1')],
  RightHand: [J2('RightHand', 'r_wrist'), J2('RightHandMiddle1', 'r_middle1'), J2('RightHandIndex1', 'r_index1'), J2('RightHandPinky1', 'r_pinky1')],
};
const T = new Array(bones.length);                    // per bone: x' = t + R·Sx(x − A)
const order = []; (function walk(i) { order.push(i); children[i].forEach(walk); })(BI.Hips);
for (const i of order) {
  const pi = bones[i].parent?.isBone ? bones.indexOf(bones[i].parent) : -1;
  const name = bn(bones[i]), Rp = pi >= 0 && T[pi] ? T[pi].R : I3;   // (a bone above Hips, e.g. Tripo's Root, is not fitted)
  // limb joints are pinned onto the game's; the spine, neck, head and clavicles ride with their
  // parent (the two skeletons place those joints differently — the game's clavicles sit at the
  // sternum, its neck ~10 cm further forward — pinning them would shear the chest and push the
  // head forward); the hips go where the two hip joints' centre goes
  let a;
  if (name === 'Hips') { const mA = sc(add(A[BI.LeftUpLeg], A[BI.RightUpLeg]), 0.5), mG = sc(add(GP('l_upleg'), GP('r_upleg')), 0.5); a = add(A[i], sub(mG, mA)); }
  else if (AXIAL.test(name)) a = T[pi].apply(A[i]);
  else a = tgt(i) || (pi >= 0 ? T[pi].apply(A[i]) : A[i]);
  const kids = children[i].filter((c) => tgt(c));
  const fr = FRAME[name];
  if (fr) {
    // hips / chest / hand: the frame of two directions (up, across) — the facing of the pelvis, the
    // chest and the palm — mapped onto the game's. The torso's up is mid-hips → mid-shoulders (as
    // the animation solver's), not the first spine / neck bone (the game's neck base leans forward)
    const frame = (u, l) => { const y = nrm(u), z = nrm(cross(l, y)), x = cross(y, z); return [x, y, z]; };
    const [u0, u1, l0, l1] = fr;
    const getM = (n) => A[BI[n]], getG = Object.assign((n) => GP(n), { game: true });
    const vm = (f) => f(getM), vg = (f) => f(getG);
    const Fm = frame(vm(u1).map((v, k) => v - vm(u0)[k]), vm(l0).map((v, k) => v - vm(l1)[k]));
    const Fg = frame(vg(u1).map((v, k) => v - vg(u0)[k]), vg(l0).map((v, k) => v - vg(l1)[k]));
    // R = Fg · Fmᵀ (columns = frame axes)
    const R = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) R[r * 3 + c] += Fg[k][r] * Fm[k][c];
    T[i] = { R, a, A: A[i], k: 1, d: [0, 1, 0], apply(x) { return add(this.a, mv(this.R, sub(x, this.A))); } };
  } else if ((AXIAL.test(name) && !/Shoulder/.test(name)) || !(name in TARGET || /_End$/.test(name))) {
    // the spine / neck / head ride with their parent; so do bones the game has no joint for
    // (UE's in-between spine / neck, twist, metacarpal bones)
    T[i] = { R: Rp, a, A: A[i], k: 1, d: [0, 1, 0], apply(x) { return add(this.a, mv(this.R, sub(x, this.A))); } };
  } else if (kids.length === 1) {
    const c = kids[0], d = sub(A[c], A[i]), dT = sub(tgt(c), a);
    const R = mm(swing(nrm(mv(Rp, d)), nrm(dT)), Rp), k = NOSTRETCH.test(bn(bones[i])) ? 1 : len(dT) / (len(d) || 1), dh = nrm(d);
    T[i] = { R, a, A: A[i], k, d: dh, apply(x) { const r = sub(x, this.A), along = dot(r, this.d); return add(this.a, mv(this.R, add(r, sc(this.d, along * (this.k - 1))))); } };
  } else {
    T[i] = { R: Rp, a, A: A[i], k: 1, d: [0, 1, 0], apply(x) { return add(this.a, mv(this.R, sub(x, this.A))); } };
  }
}
const isHandBone = (n) => /^(Left|Right)Hand/.test(n);
// ── pieces (skin, garments, hair, face) — in the scaled model, before the fit ──
const Q = V.map(X);
const par = Int32Array.from({ length: NV }, (_, i) => i), fr = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
for (const [a, b, c] of faces) { par[fr(a)] = fr(b); par[fr(c)] = fr(b); }
const comps = new Map(); for (let u = 0; u < NV; u++) { const r = fr(u); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(u); }
const domBone = (vs) => { const acc = {}; for (const u of vs) for (const [j, w] of W[u]) acc[bn(bones[j])] = (acc[bn(bones[j])] || 0) + w; return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([n]) => n); };
// a piece spanning most of the height is the whole figure in one mesh (a textured single-mesh
// export: skin and clothes one surface, told apart only by the texture): it keeps the model's own
// weights mapped like skin, cleaned of stray arm / hand weight below
const bbOfQ = (vs) => vs.reduce((o, u) => { const p = Q[u]; for (let k = 0; k < 3; k++) { o.mn[k] = Math.min(o.mn[k], p[k]); o.mx[k] = Math.max(o.mx[k], p[k]); } return o; }, { mn: [9, 9, 9], mx: [-9, -9, -9] });
const WHOLE = new Set([...comps.values()].filter((vs) => { const b = bbOfQ(vs); return b.mx[1] - b.mn[1] > 0.6 * ref.heightM; }));
const headSkinN = Math.max(0, ...[...comps.values()].filter((vs) => !WHOLE.has(vs) && /Head|Neck/.test(domBone(vs)[0] || '')).map((vs) => vs.length));
// small pieces in front of the face come in left / right pairs: from the bottom up lips, eyes, brows
const faceLevel = new Map();
{
  const bbOf = bbOfQ;
  const heads = [...comps.values()].filter((vs) => !WHOLE.has(vs) && /Head|Neck/.test(domBone(vs)[0] || ''));
  // the head's skin: its biggest piece, or (one-mesh figure) the vertices the head bone carries
  const skin = heads.find((vs) => vs.length === headSkinN)
    || [...WHOLE].flatMap((vs) => vs.filter((u) => /^(Head|HeadTop_End)$/.test(bn(bones[(W[u].slice().sort((a, b) => b[1] - a[1])[0] || [BI.Hips])[0]]))));
  const sb = skin?.length ? bbOf(skin) : null, midZ = sb ? (sb.mn[2] + sb.mx[2]) / 2 : 0;
  if (sb) {
  const small = heads.filter((vs) => vs !== skin).map((vs) => ({ vs, bb: bbOf(vs) })).filter(({ bb }) => bb.mx[1] - bb.mn[1] < 0.045 && bb.mn[2] > midZ + 0.03 && bb.mn[1] > sb.mn[1] + 0.1);
  const levels = [];
  for (const it of small.sort((x, y) => x.bb.mn[1] - y.bb.mn[1])) {
    const cy = (it.bb.mn[1] + it.bb.mx[1]) / 2, L = levels.find((l) => Math.abs(l.cy - cy) < 0.008);
    if (L) L.items.push(it); else levels.push({ cy, items: [it] });
  }
  const pairs = levels.filter((l) => l.items.length === 2 && l.items[0].bb.mn[0] * l.items[1].bb.mn[0] < 0 || (l.items.length === 2 && Math.sign((l.items[0].bb.mn[0] + l.items[0].bb.mx[0])) !== Math.sign((l.items[1].bb.mn[0] + l.items[1].bb.mx[0]))));
  const names = pairs.length >= 3 ? ['lips', 'eyes', 'brows'] : pairs.length === 2 ? ['eyes', 'brows'] : ['eyes'];
  pairs.slice(-names.length).forEach((l, i) => l.items.forEach((it) => faceLevel.set(it.vs, names[i])));
  }
}
const CLS_LOG = [];
function classify(vs) { const r = classify0(vs); if (process.env.CLS) { const bb = vs.reduce((o, u) => { const p = Q[u]; for (let k = 0; k < 3; k++) { o.mn[k] = Math.min(o.mn[k], p[k]); o.mx[k] = Math.max(o.mx[k], p[k]); } return o; }, { mn: [9, 9, 9], mx: [-9, -9, -9] }); console.error(r.padEnd(7), vs.length, "y", bb.mn[1].toFixed(3), bb.mx[1].toFixed(3), "x", bb.mn[0].toFixed(3), bb.mx[0].toFixed(3), "z", bb.mn[2].toFixed(3), bb.mx[2].toFixed(3), domBone(vs)[0]); } return r; }
function classify0(vs) {
  if (WHOLE.has(vs)) return 'body';
  const db = domBone(vs), top = db[0] || '';
  const bb = vs.reduce((o, u) => { const p = Q[u]; for (let k = 0; k < 3; k++) { o.mn[k] = Math.min(o.mn[k], p[k]); o.mx[k] = Math.max(o.mx[k], p[k]); } return o; }, { mn: [9, 9, 9], mx: [-9, -9, -9] });
  const hands = db.slice(0, 3).some((n) => isHandBone(n) || /ForeArm/.test(n));
  if (/Foot|Toe/.test(top)) return 'shoe';
  if (/^(Left|Right)Leg$/.test(top) && bb.mn[1] > 0.05) return 'legs';
  if (/UpLeg|Hips/.test(top)) return 'shorts';
  if (hands && /Arm|ForeArm|Hand/.test(top)) return 'arms';
  if (/Arm|Spine|Shoulder/.test(top)) return 'shirt';
  if (/Head|Neck/.test(top)) {
    // the head's biggest piece is the skin (face, neck, ears); small pieces in front of the face are
    // the eyes (at the eye joints' height), brows (above) and lips (below); the rest is hair
    if (vs.length === headSkinN) return 'body';
    const fl = faceLevel.get(vs);
    if (fl) return fl;
    return 'hair';
  }
  return 'body';
}
const PALETTE = { body: [118, 78, 54], arms: [118, 78, 54], legs: [118, 78, 54], hair: [22, 18, 16], brows: [22, 18, 16], eyes: [40, 28, 22], lips: [92, 56, 44],
  shirt: [238, 238, 240], shorts: [24, 30, 44], shoe: [236, 236, 236], ...PAL_IN };
if (PAL_IN.skin) PALETTE.body = PALETTE.arms = PALETTE.legs = PAL_IN.skin;
const partsVerts = {};
const cls = new Array(NV);
for (const vs of comps.values()) { const c = classify(vs); const k = ['body', 'arms', 'legs'].includes(c) ? 'body' : c; (partsVerts[k] ||= []).push(...vs); for (const u of vs) cls[u] = k; }
// garments carry only their own bones' weights (auto-riggers bleed the hands into the shorts
// they rest on, the arms into the shirt's sides): anything else is dropped before the fit, and a
// vertex left without weight takes its neighbours'
const OWN = { shorts: /^(Hips|Spine|Spine1|(Left|Right)(UpLeg|Leg))$/, shirt: /^(Hips|Spine|Spine1|Spine2|Neck|(Left|Right)(Shoulder|Arm|ForeArm))$/,
  shoe: /^(Left|Right)(Leg|Foot|ToeBase|Toe_End)$/, hair: /^(Head|HeadTop_End|Neck)$/, eyes: /^(Head|HeadTop_End)$/, brows: /^(Head|HeadTop_End)$/, lips: /^(Head|HeadTop_End)$/ };
// on a one-piece figure there are no garment edges, so the arm, forearm and hand weights are kept
// only near their own bone (the auto-rig's hands bleed into the hips and thighs they rest on)
const wholeV = new Uint8Array(NV); for (const vs of WHOLE) for (const u of vs) wholeV[u] = 1;
const segD = (p, a, b) => { const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1e-9))); return len(sub(p, add(a, sc(ab, t)))); };
const effName = (j) => { const n = bn(bones[j]); return n in TARGET || /_End$/.test(n) ? n : bn(bones[j].parent); };
const handLenM = (s) => { const pts = ['Hand', 'HandMiddle1', 'HandMiddle2', 'HandMiddle3'].map((n) => A[BI[s + n]]); return pts.slice(1).reduce((a, q, i) => a + len(sub(q, pts[i])), 0); };
const stray = (u, j) => {
  const m = /^(Left|Right)(Arm|ForeArm|Hand)/.exec(effName(j)); if (!m) return false;
  const s = m[1], p = Q[u];
  if (m[2] === 'Arm') return segD(p, A[BI[s + 'Arm']], A[BI[s + 'ForeArm']]) > 0.14;
  if (m[2] === 'ForeArm') return segD(p, A[BI[s + 'ForeArm']], A[BI[s + 'Hand']]) > 0.12;
  return len(sub(p, A[BI[s + 'Hand']])) > 1.6 * handLenM(s) + 0.03;
};
let bled = 0, strayCleaned = 0;
{
  const empty = [];
  for (let u = 0; u < NV; u++) {
    const re = OWN[cls[u]]; if (!re && (!wholeV[u] || process.env.CF_NO_STRAY)) continue;
    const keep = W[u].filter(([j]) => (re ? re.test(bn(bones[j])) : !stray(u, j)));
    if (keep.length === W[u].length) continue;
    if (re) bled++; else strayCleaned++;
    const s1 = keep.reduce((q, x) => q + x[1], 0);
    W[u] = s1 > 1e-3 ? keep.map(([j, w]) => [j, w / s1]) : null; if (!W[u]) empty.push(u);
  }
  for (let it = 0; it < 50 && empty.some((u) => !W[u]); it++) for (const u of empty) if (!W[u]) { const nb = [...nbr[u]].find((v) => W[v]); if (nb != null) W[u] = W[nb].slice(); }
  for (const u of empty) if (!W[u]) W[u] = [[BI.Hips, 1]];
}
// (bones outside the Hips tree — a UE root or IK bone — move with the hips)
const P = V.map((v, u) => { const x = X(v); let o = [0, 0, 0]; for (const [j, w] of W[u]) o = add(o, sc((T[j] || T[BI.Hips]).apply(x), w)); return o; });
// the spine / neck / head pivots of the game skeleton move to where the model's own joints landed
// (the mesh bends and turns about the points it was built around); the head's inner joints and the
// neck's twist joints move with them, the clavicles and limbs stay
{
  const moves = [['Spine', 'c_spine1'], ['Spine1', 'c_spine2'], ['Spine2', 'c_spine3'], ['Neck', 'c_neck'], ['Head', 'c_head']];
  for (const [mx, g] of moves) {
    const j = JI[g], d = sub(T[BI[mx]].a, B2[j]);
    const sub1 = (q) => { B2[q] = add(B2[q], d); for (let c = 0; c < M.names.length; c++) if (M.parents[c] === q && (g === 'c_head' || /twist/.test(M.names[c]))) sub1(c); };
    sub1(j);
  }
}

// ── 2. weights ──
const G = {};                                          // Mixamo bone → its game joints
const J = (...n) => n.map((x) => JI[x]).filter((x) => x != null);
const tw = (p, base, n0, n1) => [p + base, ...Array.from({ length: n1 - n0 + 1 }, (_, k) => `${p}${base}_twist${n0 + k}_proc`)];
G.Hips = J('root', 'c_spine0'); G.Spine = J('c_spine1'); G.Spine1 = J('c_spine2'); G.Spine2 = J('c_spine3');
G.Neck = J('c_neck', 'c_neck_twist0_proc', 'c_neck_twist1_proc'); G.Head = J('c_head'); G.HeadTop_End = G.Head;
for (const s of ['Left', 'Right']) {
  const p = side(s);
  G[`${s}Shoulder`] = J(p + 'clavicle'); G[`${s}Arm`] = J(...tw(p, 'uparm', 0, 4)); G[`${s}ForeArm`] = J(...tw(p, 'lowarm', 1, 4), p + 'wrist_twist');
  G[`${s}UpLeg`] = J(...tw(p, 'upleg', 0, 4)); G[`${s}Leg`] = J(...tw(p, 'lowleg', 1, 4));
  G[`${s}Foot`] = J(p + 'foot', p + 'talocrural', p + 'subtalar', p + 'transversetarsal'); G[`${s}ToeBase`] = J(p + 'ball'); G[`${s}Toe_End`] = G[`${s}ToeBase`];
  G[`${s}Hand`] = J(p + 'wrist', p + 'pinky0', p + 'thumb0');   // the palm (fingers: below)
}
// the persistent mapping (tools/character_pipeline/tripo_to_souljam_bones.json): written once from
// the tables above, then read — every character maps through the same file
{
  const toNames = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map((j) => M.names[j]) : v]));
  if (!fs.existsSync(MAPPING_FILE) || process.argv.includes('--write-mapping')) {
    fs.mkdirSync(path.dirname(MAPPING_FILE), { recursive: true });
    fs.writeFileSync(MAPPING_FILE, JSON.stringify({
      about: 'Tripo / Mixamo skeleton → SOUL_JAM_MASTER_SKELETON (MHR, 127 joints). target: the game joint each source joint is fitted onto. weights: the game joints a source bone\'s skin weight is spread over (twist joints included). ueMannequin: UE4/UE5 names mapped onto the Mixamo names first. Fingers: one finger per vertex along that finger\'s own joints (import-mixamo-character.mjs).',
      skeleton: { joints: M.names.length, root: M.names[M.parents.indexOf(-1)] },
      target: TARGET, weights: toNames(G),
      ueMannequin: { pelvis: 'Hips', 'spine_01': 'Spine', 'spine_03 (UE5) / spine_02 (UE4)': 'Spine1', 'spine_05 (UE5) / spine_03 (UE4)': 'Spine2', neck_01: 'Neck', head: 'Head', 'clavicle_l/r': 'Left/RightShoulder', 'upperarm_l/r': 'Left/RightArm', 'lowerarm_l/r': 'Left/RightForeArm', 'hand_l/r': 'Left/RightHand', 'thigh_l/r': 'Left/RightUpLeg', 'calf_l/r': 'Left/RightLeg', 'foot_l/r': 'Left/RightFoot', 'ball_l/r': 'Left/RightToeBase', '<finger>_0<k>_l/r': 'Left/RightHand<Finger><k>', 'twist / metacarpal / ik / in-between spine': 'ride with the parent bone' },
    }, null, 1));
  } else {
    const mp = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    for (const k of Object.keys(TARGET)) delete TARGET[k];
    Object.assign(TARGET, mp.target);
    for (const k of Object.keys(G)) delete G[k];
    for (const [k, v] of Object.entries(mp.weights)) G[k] = v.map((n) => JI[n]).filter((x) => x != null);
  }
}
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const handSide = (n) => (n.startsWith('Left') ? 'Left' : 'Right');
const fingerOfBone = (n) => { const m = /Hand(Thumb|Index|Middle|Ring|Pinky)/.exec(n); return m ? m[1] : 'Palm'; };
// the game rig's vertices per joint group (nearest-point weight transfer)
const groupVerts = new Map();
const groupOf = (gs) => {
  const k = gs.join(','); if (groupVerts.has(k)) return groupVerts.get(k);
  const set = new Set(gs), out = [];
  for (let r = 0; r < RN; r++) { let s = 0; for (let c = 0; c < 4; c++) if (set.has(RSI[r * 4 + c])) s += RSW[r * 4 + c]; if (s > 0.25) out.push(r); }
  groupVerts.set(k, out); return out;
};
function transfer(p, gs) {
  const cand = groupOf(gs); if (!cand.length) return [[gs[0], 1]];
  let best = -1, bd = Infinity;
  for (const r of cand) { const d = (RV[r * 3] - p[0]) ** 2 + (RV[r * 3 + 1] - p[1]) ** 2 + (RV[r * 3 + 2] - p[2]) ** 2; if (d < bd) { bd = d; best = r; } }
  const set = new Set(gs), out = [];
  for (let c = 0; c < 4; c++) { const j = RSI[best * 4 + c], w = RSW[best * 4 + c]; if (w > 0 && set.has(j)) out.push([j, w]); }
  const s = out.reduce((a, x) => a + x[1], 0);
  return s > 0 ? out.map(([j, w]) => [j, w / s]) : [[gs[0], 1]];
}
// finger of every hand vertex: the model's dominant finger, cleaned by a neighbour vote
const fingerLabel = new Array(NV).fill(null);
for (let u = 0; u < NV; u++) {
  const acc = {}; let hw = 0;
  for (const [j, w] of W[u]) { const n = bn(bones[j]); if (!isHandBone(n)) continue; hw += w; const f = fingerOfBone(n); acc[f] = (acc[f] || 0) + w; }
  if (hw > 0) fingerLabel[u] = Object.entries(acc).sort((a, b) => b[1] - a[1])[0][0];
}
for (let it = 0; it < 3; it++) {
  const next = fingerLabel.slice();
  for (let u = 0; u < NV; u++) {
    if (!fingerLabel[u]) continue;
    const votes = { [fingerLabel[u]]: 1.5 };
    for (const v of nbr[u]) if (fingerLabel[v]) votes[fingerLabel[v]] = (votes[fingerLabel[v]] || 0) + 1;
    next[u] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  }
  fingerLabel.splice(0, NV, ...next);
}
/** Weights along one finger: rigid phalanges, blended across each knuckle. */
function fingerWeights(p, s, f) {
  const pre = side(s), g = f.toLowerCase();
  const rootJ = f === 'Thumb' ? pre + 'thumb0' : f === 'Pinky' ? pre + 'pinky0' : pre + 'wrist';
  const chain = [rootJ, pre + g + 1, pre + g + 2, pre + g + 3, pre + g + '_null'];
  if (f === 'Thumb' && d2(GP(pre + 'thumb0'), GP(pre + 'wrist')) < 1e-6) chain[0] = pre + 'wrist';
  const pts = chain.map(GP);
  // arc-length position of p along the chain
  let bestD = Infinity, bestS = 0, acc = 0; const cum = [0];
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[k + 1], ab = sub(b, a), L = len(ab) || 1e-6;
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (L * L))), q = add(a, sc(ab, t)), dd = d2(p, q);
    if (dd < bestD) { bestD = dd; bestS = acc + t * L; }
    acc += L; cum.push(acc);
  }
  // segment k belongs to joint chain[k]; blend ±h around each joint (wider at the knuckle)
  const out = new Map();
  let wSeg = [0, 0, 0, 0];
  let k = 3; for (let q = 0; q < 4; q++) if (bestS < cum[q + 1]) { k = q; break; }
  wSeg[k] = 1;
  for (let q = 1; q < 4; q++) {
    const L0 = cum[q] - cum[q - 1], L1 = cum[q + 1] - cum[q], h = Math.min(L0, L1) * (q === 1 ? 0.45 : 0.3);
    const x = (bestS - (cum[q] - h)) / (2 * h);
    if (x > 0 && x < 1) { const t = x * x * (3 - 2 * x); wSeg = [0, 0, 0, 0]; wSeg[q - 1] = 1 - t; wSeg[q] = t; break; }
  }
  wSeg.forEach((w, q) => { if (w > 1e-4) out.set(JI[chain[q]], (out.get(JI[chain[q]]) || 0) + w); });
  return [...out];
}
/** Garments: the weights of the nearest points of the game's body (4, by inverse distance) — every
 *  garment over the same body point moves as that point does (the shirt's hem with the shorts' waist). */
function bodyWeights(p) {
  const best = [];
  for (let r = 0; r < RN; r++) {
    const d = (RV[r * 3] - p[0]) ** 2 + (RV[r * 3 + 1] - p[1]) ** 2 + (RV[r * 3 + 2] - p[2]) ** 2;
    if (best.length < 4 || d < best[3][0]) { best.push([d, r]); best.sort((a, b) => a[0] - b[0]); if (best.length > 4) best.pop(); }
  }
  const out = new Map();
  for (const [d, r] of best) { const iw = 1 / (Math.sqrt(d) + 0.005); for (let c = 0; c < 4; c++) { const w = RSW[r * 4 + c]; if (w > 0) out.set(RSI[r * 4 + c], (out.get(RSI[r * 4 + c]) || 0) + w * iw); } }
  const t = [...out.values()].reduce((a, x) => a + x, 0) || 1;
  for (const [j, w] of out) out.set(j, w / t);
  return out;
}
const GARMENT = new Set(['shirt', 'shorts', 'shoe']);
let Wg = new Array(NV);
for (let u = 0; u < NV; u++) {
  if (GARMENT.has(cls[u])) { Wg[u] = bodyWeights(P[u]); continue; }
  const acc = new Map(), put = (j, w) => acc.set(j, (acc.get(j) || 0) + w);
  let handW = 0, handSideName = null;
  for (const [j, w] of W[u]) {
    const n = bn(bones[j]);
    if (isHandBone(n)) { handW += w; handSideName = handSide(n); continue; }
    const gs = G[n] || G[bn(bones[j].parent)] || [JI.root];
    for (const [gj, gw] of transfer(P[u], gs)) put(gj, w * gw);
  }
  if (handW > 0) {
    const f = fingerLabel[u];
    const hw = f && f !== 'Palm' ? fingerWeights(P[u], handSideName, f) : transfer(P[u], G[`${handSideName}Hand`]);
    for (const [gj, gw] of hw) put(gj, handW * gw);
  }
  Wg[u] = acc;
}
// smooth the body weights over the surface (not the fingers: rigid phalanges stay rigid)
const fingerJ = new Set(M.names.map((n, i) => (/(thumb|index|middle|ring|pinky)(\d|_null)/.test(n) ? i : -1)).filter((i) => i >= 0));
for (let it = 0; it < 2; it++) {
  Wg = Wg.map((m, u) => {
    if ([...m.keys()].some((j) => fingerJ.has(j))) return m;
    const o = new Map(); const add1 = (mm, w) => { for (const [j, x] of mm) o.set(j, (o.get(j) || 0) + x * w); };
    add1(m, 1); let tot = 1; for (const v of nbr[u]) { if ([...Wg[v].keys()].some((j) => fingerJ.has(j))) continue; add1(Wg[v], 0.5); tot += 0.5; }
    for (const [j, x] of o) o.set(j, x / tot);
    return o;
  });
}
const top4 = Wg.map((m) => { const e = [...m].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4); const s = e.reduce((a, x) => a + x[1], 0) || 1; return e.map(([j, w]) => [j, w / s]); });

// layered garments move with what is under them: an outer layer's vertex within a few cm of an
// inner surface takes that surface's weights (fading out over the gap), so the shorts' waist can't
// poke through the shirt hem, nor an arm through its sleeve, a leg through the shorts, an ankle
// through the shoe collar
const headY = P.reduce((m, p) => Math.max(m, p[1]), -Infinity);
// (in order: the shirt follows the arms / neck under it; the shorts' waistband hidden under the
// shirt follows the shirt — else it pokes out when the pelvis tilts; the shoe collars the ankles)
const LAYERS = [['shirt', ['body'], 0.012, 0.05], ['shorts', ['shirt'], 0.03, 0.09], ['shoe', ['body'], 0.012, 0.05]];
let layered = 0;
for (const [outer, inners, NEAR, FAR] of LAYERS) {
  const inn = (partsVerts[inners[0]] || []).concat(...inners.slice(1).map((k) => partsVerts[k] || []));
  if (!inn.length || !partsVerts[outer]) continue;
  for (const u of partsVerts[outer]) {
    let best = -1, bd = FAR * FAR;
    for (const v of inn) { const d = d2(P[u], P[v]); if (d < bd) { bd = d; best = v; } }
    if (best < 0) continue;
    const t = Math.min(1, (FAR - Math.sqrt(bd)) / (FAR - NEAR));
    const m = new Map(); for (const [j, w] of top4[u]) m.set(j, (1 - t) * w); for (const [j, w] of top4[best]) m.set(j, (m.get(j) || 0) + t * w);
    const e = [...m].sort((a, b) => b[1] - a[1]).slice(0, 4), s4 = e.reduce((a, x) => a + x[1], 0) || 1;
    top4[u] = e.map(([j, w]) => [j, w / s4]); layered++;
  }
}
// feet on the floor: the soles are where the game's feet stand
let minY = Infinity; for (const p of P) minY = Math.min(minY, p[1]);
const lift = -Math.min(0, minY);
const colorOf = (k) => PALETTE[k] || [200, 200, 200];
const ORDER = ['body', 'shirt', 'shorts', 'shoe', 'hair', 'eyes', 'brows', 'lips'];
const parts = [];
const bb64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
// one part per garment piece and material (a part carries one texture); the render vertices
// keep the UV seams, the weights are their position's
const texDir = path.join(RIGS, `${id}-tex`);
if (TEXTURED) { if (!LOD) fs.rmSync(texDir, { recursive: true, force: true }); fs.mkdirSync(texDir, { recursive: true }); }
const { default: sharp } = TEXTURED ? await import('sharp') : { default: null };
const texUrl = new Map();
async function saveTex(mi, kind) {
  const k = mi + kind; if (texUrl.has(k)) return texUrl.get(k);
  const data = MATTEX[mi][kind]; let url = null;
  if (data) {
    const fn = `${MATTEX[mi].name}-${mi}-${kind}.webp`.replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
    if (LOD && fs.existsSync(path.join(texDir, fn))) { url = `/chars/${id}/${fn}`; texUrl.set(k, url); return url; }   // LODs share LOD 0's textures (never re-encoded at another size)
    await sharp(data).resize({ width: TEXSIZE, height: TEXSIZE, fit: 'inside', withoutEnlargement: true }).webp(kind === 'color' ? { quality: 88 } : { quality: 92 }).toFile(path.join(texDir, fn));
    url = `/chars/${id}/${fn}`;
  }
  texUrl.set(k, url); return url;
}
// normals on the welded surface (area-weighted), shared by every UV-seam copy: no lighting seam
const NRM = new Float32Array(NV * 3);
for (const [a, b, c] of faces) { const n = cross(sub(P[b], P[a]), sub(P[c], P[a])); for (const u of [a, b, c]) { NRM[u * 3] += n[0]; NRM[u * 3 + 1] += n[1]; NRM[u * 3 + 2] += n[2]; } }
for (let u = 0; u < NV; u++) { const l = Math.hypot(NRM[u * 3], NRM[u * 3 + 1], NRM[u * 3 + 2]) || 1; NRM[u * 3] /= l; NRM[u * 3 + 1] /= l; NRM[u * 3 + 2] /= l; }
const groupsOut = new Map();
faces.forEach(([a], f) => { const g = `${cls[a]}|${TEXTURED ? faceMat[f] : 0}`; (groupsOut.get(g) || groupsOut.set(g, []).get(g)).push(f); });
const perCls = {}; for (const g of groupsOut.keys()) { const c = g.split('|')[0]; perCls[c] = (perCls[c] || 0) + 1; }
const gkeys = [...groupsOut.keys()].sort((x, y) => ORDER.indexOf(x.split('|')[0]) - ORDER.indexOf(y.split('|')[0]) || +x.split('|')[1] - +y.split('|')[1]);
for (const g of gkeys) {
  const [k, miS] = g.split('|'), mi = +miS, fl = groupsOut.get(g);
  const loc = new Map(), rv = [];
  const fs3 = fl.flatMap((f) => facesR[f].map((r) => { if (!loc.has(r)) { loc.set(r, rv.length); rv.push(r); } return loc.get(r); }));
  const verts = new Float32Array(rv.length * 3), uv = new Float32Array(rv.length * 2), si = new Uint8Array(rv.length * 4), sw = new Float32Array(rv.length * 4);
  const nrm = new Float32Array(rv.length * 3);
  rv.forEach((r, i) => { const u = rvPos[r]; verts.set(P[u], i * 3); uv.set(rvUV[r], i * 2); nrm.set(NRM.subarray(u * 3, u * 3 + 3), i * 3); top4[u].forEach(([j, w], c) => { si[i * 4 + c] = j; sw[i * 4 + c] = w; }); });
  const faces32 = rv.length > 65535;
  const map = TEXTURED ? await saveTex(mi, 'color') : null, normalMap = TEXTURED ? await saveTex(mi, 'normal') : null;
  // glTF packs roughness (G) and metallic (B) into one map; three.js reads those channels as is
  const rmap = TEXTURED ? await saveTex(mi, 'rough') : null, aoMap = TEXTURED ? await saveTex(mi, 'ao') : null;
  // untextured: the palette colour; an untextured material of a textured model: its own colour
  const color = map ? null : TEXTURED && MATTEX[mi].rgb ? MATTEX[mi].rgb : colorOf(k);
  parts.push({ name: perCls[k] > 1 ? `${k}-${mi}` : k, vertexCount: rv.length, verts: bb64(verts), uv: bb64(uv), faces: bb64(faces32 ? Uint32Array.from(fs3) : Uint16Array.from(fs3)), faces32,
    skinIdx: bb64(si), skinW: bb64(sw), map, normalMap, ...(rmap ? { roughnessMap: rmap, metalnessMap: rmap } : {}), ...(aoMap ? { aoMap } : {}), alpha: false, color, ...(TEXTURED ? { normals: bb64(nrm) } : {}) });
}
// shoes below the game's feet: the runtime stands the feet keypoints soleOffset above the floor,
// so the soles land on it (the skeleton and mesh stay as bound)
// the refitted skeleton's rest keypoints (joint + its local offset), bone lengths, leg length
const { MHR70, PELVIS } = await import('../engine3d/anim3d.mjs');
const qrot = (q, v) => { const u = [q[0], q[1], q[2]], w = q[3], c = cross(u, v), dd = dot(u, v), uu = dot(u, u); return [0, 1, 2].map((i) => 2 * dd * u[i] + (w * w - uu) * v[i] + 2 * w * c[i]); };
const restJoints = M.kpJoint.map((j, k) => add(B2[j], qrot(M.bindRot[j], M.kpOffset[k])).map((v) => +v.toFixed(5)));
const KI = Object.fromEntries(MHR70.map((n, i) => [n, i]));
const R71 = restJoints.concat([sc(add(restJoints[KI['left-hip']], restJoints[KI['right-hip']]), 0.5)]);
const boneLen = ref.parent.map((q, i) => (q < 0 ? ref.boneLen[i] : +len(sub(R71[i], R71[q])).toFixed(5)));
const legLen = (boneLen[KI['left-knee']] + boneLen[KI['left-ankle']] + boneLen[KI['right-knee']] + boneLen[KI['right-ankle']]) / 2;
const sole0 = Math.min(...['left-big-toe-tip', 'left-small-toe-tip', 'left-heel', 'right-big-toe-tip', 'right-small-toe-tip', 'right-heel'].map((n) => restJoints[KI[n]][1]));
void PELVIS;
const rig = { ...ref, id, name: dispName || id, heightM: +(headY + lift).toFixed(3), soleOffset: +(sole0 + lift).toFixed(5), parts,
  mhr: { ...ref.mhr, bindPos: B2.map((p) => p.map((v) => +v.toFixed(5))) }, restJoints, boneLen, legLen,
  source: { model: path.basename(file), importedFrom: SKELETON === 'mixamo' ? 'mixamo rig' : 'ue mannequin rig', skeleton: FROM, scale: +S.toFixed(4) } };
delete rig.lods;                                      // LOD 0 re-imported: its LODs follow
if (MATERIAL) rig.material = MATERIAL;
else if (TEXTURED && !rig.material) rig.material = { preset: 'souljam-illustrated' };
if (LOD) {
  BASE.lods = (BASE.lods || []).filter((l) => l.level !== LOD).concat([{ level: LOD, dist: LOD_DIST, parts }]).sort((a, b) => a.level - b.level);
  fs.writeFileSync(path.join(RIGS, `${id}.json.gz`), zlib.gzipSync(JSON.stringify(BASE), { level: 9 }));
} else fs.writeFileSync(path.join(RIGS, `${id}.json.gz`), zlib.gzipSync(JSON.stringify(rig), { level: 9 }));
const regPath = path.join(RIGS, 'custom.json');
const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
if (!LOD) reg[id] = { name: dispName || id, heightM: rig.heightM };
fs.writeFileSync(regPath, JSON.stringify(reg, null, 1));

// ── report ──
const fingerCross = (() => { let n = 0; for (let u = 0; u < NV; u++) { const fs1 = new Set(top4[u].map(([j]) => (/(thumb|index|middle|ring|pinky)/.exec(M.names[j]) || [])[1]).filter(Boolean)); if (fs1.size > 1) n++; } return n; })();
console.log(JSON.stringify({ id, skeleton: SKELETON, scale: +S.toFixed(3), vertices: NV, renderVertices: rvPos.length, triangles: faces.length,
  textures: TEXTURED ? [...texUrl.values()].filter(Boolean).map((u) => path.basename(u)) : 'none (flat part colours)', onePieceFigure: WHOLE.size > 0, strayArmWeightsCleaned: strayCleaned,
  parts: parts.map((p) => `${p.name}:${p.vertexCount}${p.map ? ' [tex]' : ''}`), heightM: rig.heightM, soleOffset: rig.soleOffset, legLen: +legLen.toFixed(3), proportions: PROPS, segRatio: Object.fromEntries(Object.entries(segRatio).map(([k, v]) => [k, +v.toFixed(3)])), lift: +lift.toFixed(3),
  garmentWeightsCleaned: bled, layeredVertices: layered, handVertices: fingerLabel.filter(Boolean).length, verticesOnTwoFingers: fingerCross,
  jointShiftCm: order.filter((i) => tgt(i)).map((i) => [bn(bones[i]), len(sub(T[i].a, A[i]))]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, d]) => `${n} ${(d * 100).toFixed(1)}`) }, null, 1));
