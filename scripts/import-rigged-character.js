#!/usr/bin/env node
/**
 * Import an artist's rigged character (skinned glTF / GLB on the game's MHR
 * skeleton — see docs/character-brief/) as a court character.
 *
 *   node scripts/import-rigged-character.js <model.glb> <id> ["Display name"] [--from player]
 *
 * - joints are matched BY NAME to the supplied skeleton (docs/character-brief/skeleton.json);
 *   unknown joints are an error when they carry weight
 * - whatever pose the artist bound in (the supplied pose, an A-pose, a T-pose), the mesh is
 *   re-expressed in the game's bind pose through the artist's own skinning:
 *     v' = Σ w_j · B_game_j · IBM_artist_j · v
 * - bone lengths that differ from the game skeleton by more than 2 cm are reported
 *   (the proportions differ: tell the developer — the skeleton is refitted, not the mesh)
 * - every skinned primitive becomes a part (up to 4 influences, strongest kept, renormalised);
 *   base-colour and normal textures → WebP (<id>-tex/)
 * Writes lib/mocap/mhr-rigs/<id>.json.gz (+ -tex/) and registers <id> in
 * lib/mocap/mhr-rigs/custom.json (the court's Player menu lists it).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const FROM = opt('from', 'player');
const [file, id, name] = args;
if (!file || !id || !/^[a-z0-9-]+$/.test(id)) { console.error('usage: import-rigged-character.js <model.glb> <id: a-z0-9-> ["Display name"] [--from player]'); process.exit(2); }
const RIGS = path.join(__dirname, '..', 'lib', 'mocap', 'mhr-rigs');

// ── small matrix helpers (column-major 4×4, as glTF) ──
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const apply = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const inv = (m) => { // general 4×4 inverse
  const a = m, o = new Array(16);
  o[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  o[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  o[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  o[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  o[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  o[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  o[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  o[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  o[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  o[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  o[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  o[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  o[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  o[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  o[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  o[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * o[0] + a[1] * o[4] + a[2] * o[8] + a[3] * o[12];
  return o.map((x) => x / det);
};
const qmat = ([x, y, z, w], t = [0, 0, 0]) => [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1];

(async () => {
  // ── read the GLB ──
  const buf = fs.readFileSync(file);
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error('not a GLB (binary glTF) file — export as .glb');
  const jl = buf.readUInt32LE(12), gltf = JSON.parse(buf.slice(20, 20 + jl).toString('utf8'));
  const bin = buf.slice(20 + jl + 8, 20 + jl + 8 + buf.readUInt32LE(20 + jl));
  const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const read = (ai) => {
    const a = gltf.accessors[ai], bv = gltf.bufferViews[a.bufferView], [T, sz] = COMP[a.componentType], nc = NC[a.type];
    const stride = bv.byteStride || sz * nc, base = (bv.byteOffset || 0) + (a.byteOffset || 0), out = new Float64Array(a.count * nc);
    const dv = new DataView(bin.buffer, bin.byteOffset);
    const get = { 5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[a.componentType];
    const norm = a.normalized ? { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType] : 1;
    for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) out[i * nc + c] = get(base + i * stride + c * sz) / norm;
    void T; return { data: out, nc, count: a.count };
  };
  const skin = gltf.skins?.[0];
  if (!skin) throw new Error('the model has no skin (it must be rigged — skinned to the supplied skeleton)');
  const ref = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RIGS, `${FROM}.json.gz`))));
  const M = ref.mhr, JI = Object.fromEntries(M.names.map((n, i) => [n, i]));
  const artistJoints = skin.joints.map((ni) => gltf.nodes[ni].name || `node${ni}`);
  const ibm = skin.inverseBindMatrices != null ? read(skin.inverseBindMatrices).data : null;
  const IBM = artistJoints.map((_, j) => (ibm ? Array.from(ibm.slice(j * 16, j * 16 + 16)) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const Bgame = M.names.map((_, i) => qmat(M.bindRot[i], M.bindPos[i]));
  // artist joint j → game joint index; per artist joint the re-binding matrix B_game · IBM_artist
  const map = artistJoints.map((n) => (Object.hasOwn(JI, n) ? JI[n] : -1));
  const rebind = IBM.map((m, j) => (map[j] >= 0 ? mul(Bgame[map[j]], m) : null));
  // proportions: each bone's length (joint → its parent) in the artist's bind vs the game skeleton
  // (lengths, not positions: a different bind POSE — A-pose, T-pose — is fine and handled above)
  const artistPos = {};
  artistJoints.forEach((n, j) => { if (map[j] < 0) return; const W = inv(IBM[j]); artistPos[n] = [W[12], W[13], W[14]]; });
  const devs = [];
  for (const [n, p] of Object.entries(artistPos)) {
    const gi = JI[n], par = M.parents[gi]; if (par < 0) continue;
    const pn = M.names[par], pp = artistPos[pn]; if (!pp) continue;
    const la = Math.hypot(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]), q = M.bindPos[gi], qp = M.bindPos[par];
    const lg = Math.hypot(q[0] - qp[0], q[1] - qp[1], q[2] - qp[2]);
    devs.push({ n, d: Math.abs(la - lg) });
  }
  devs.sort((a, b) => b.d - a.d);

  // ── primitives → parts ──
  const parts = [], texDir = path.join(RIGS, `${id}-tex`);
  fs.mkdirSync(texDir, { recursive: true });
  const saveTex = async (ti, kind, partName) => {
    if (ti == null) return null;
    const t = gltf.textures[ti], src = t.extensions?.EXT_texture_webp?.source ?? t.source, im = gltf.images[src];
    const bv = gltf.bufferViews[im.bufferView];
    const data = im.bufferView != null ? bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) : fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(im.uri)));
    const fn = `${partName}-${kind}.webp`.replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
    await sharp(data).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: kind === 'normal' ? 92 : 88 }).toFile(path.join(texDir, fn));
    return `/chars/${id}/${fn}`;
  };
  let unknownWeight = 0, dropped = 0, vtot = 0;
  let minY = Infinity, maxY = -Infinity;
  for (const node of gltf.nodes) {
    if (node.mesh == null || node.skin == null) continue;
    const mesh = gltf.meshes[node.mesh];
    for (const [pi, prim] of mesh.primitives.entries()) {
      const A = prim.attributes;
      if (A.POSITION == null || A.JOINTS_0 == null || A.WEIGHTS_0 == null) continue;
      const P = read(A.POSITION).data, UV = A.TEXCOORD_0 != null ? read(A.TEXCOORD_0).data : null;
      const Js = [read(A.JOINTS_0).data, A.JOINTS_1 != null ? read(A.JOINTS_1).data : null].filter(Boolean);
      const Ws = [read(A.WEIGHTS_0).data, A.WEIGHTS_1 != null ? read(A.WEIGHTS_1).data : null].filter(Boolean);
      const nv = P.length / 3;
      const verts = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), si = new Uint8Array(nv * 4), sw = new Float32Array(nv * 4);
      for (let v = 0; v < nv; v++) {
        const inf = [];
        for (let s = 0; s < Js.length; s++) for (let k = 0; k < 4; k++) { const w = Ws[s][v * 4 + k]; if (w > 1e-6) inf.push({ j: Js[s][v * 4 + k], w }); }
        let tot = inf.reduce((a, x) => a + x.w, 0) || 1;
        // re-bind to the game's bind pose through the artist's own skinning
        const p0 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], q = [0, 0, 0];
        for (const { j, w } of inf) {
          if (!rebind[j]) { unknownWeight += w / tot; continue; }
          const r = apply(rebind[j], p0); q[0] += r[0] * w / tot; q[1] += r[1] * w / tot; q[2] += r[2] * w / tot;
        }
        verts.set(q, v * 3); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
        if (UV) { uv[v * 2] = UV[v * 2]; uv[v * 2 + 1] = 1 - UV[v * 2 + 1]; }  // the rigs store Blender UVs (v up)
        const top = inf.filter((x) => map[x.j] >= 0).sort((a, b) => b.w - a.w);
        if (top.length > 4) dropped++;
        const k4 = top.slice(0, 4), s4 = k4.reduce((a, x) => a + x.w, 0) || 1;
        k4.forEach((x, k) => { si[v * 4 + k] = map[x.j]; sw[v * 4 + k] = x.w / s4; });
      }
      const idx = prim.indices != null ? read(prim.indices).data : Float64Array.from({ length: nv }, (_, i) => i);
      const faces32 = nv > 65535;
      const faces = faces32 ? Uint32Array.from(idx) : Uint16Array.from(idx);
      const mat = prim.material != null ? gltf.materials[prim.material] : {};
      const pname = `${(mesh.name || node.name || 'part').toLowerCase().replace(/[^a-z0-9]+/g, '_')}${mesh.primitives.length > 1 ? '_' + pi : ''}`;
      const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
      parts.push({
        name: parts.length === 0 && !/body/.test(pname) ? pname : pname, vertexCount: nv,
        verts: b64(verts), uv: b64(uv), faces: b64(faces), faces32, skinIdx: b64(si), skinW: b64(sw),
        map: await saveTex(mat.pbrMetallicRoughness?.baseColorTexture?.index, 'color', pname),
        normalMap: await saveTex(mat.normalTexture?.index, 'normal', pname),
        alpha: mat.alphaMode === 'MASK' || mat.alphaMode === 'BLEND',
      });
      vtot += nv;
    }
  }
  if (!parts.length) throw new Error('no skinned mesh primitives (POSITION + JOINTS_0 + WEIGHTS_0) found');
  if (unknownWeight > 0.5) throw new Error(`weights on joints the game skeleton does not have (${artistJoints.filter((_, j) => map[j] < 0).slice(0, 8).join(', ')}) — use the supplied skeleton's joint names`);
  // the body part first (the court draws it single-sided)
  parts.sort((a, b) => (/body/.test(b.name) ? 1 : 0) - (/body/.test(a.name) ? 1 : 0));
  const rig = { ...ref, id, name: name || id, heightM: +(maxY - Math.min(0, minY)).toFixed(3), parts, source: { model: path.basename(file), importedFrom: 'artist rig', skeleton: FROM } };
  fs.writeFileSync(path.join(RIGS, `${id}.json.gz`), zlib.gzipSync(JSON.stringify(rig), { level: 9 }));
  // register (the court's Player menu)
  const regPath = path.join(RIGS, 'custom.json');
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
  reg[id] = { name: `${name || id}`, heightM: rig.heightM };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 1));
  console.log(JSON.stringify({
    id, parts: parts.map((p) => ({ name: p.name, vertices: p.vertexCount, map: !!p.map, normal: !!p.normalMap })), vertices: vtot, heightM: rig.heightM,
    jointsMatched: map.filter((j) => j >= 0).length, jointsUnknown: artistJoints.filter((_, j) => map[j] < 0),
    maxBoneLengthDiffCm: +(devs[0]?.d * 100 || 0).toFixed(1), worstBones: devs.slice(0, 4).map((x) => `${x.n} ${(x.d * 100).toFixed(1)} cm`),
    verticesOverFourInfluences: dropped,
    warning: devs[0]?.d > 0.02 ? 'bone lengths differ from the game skeleton by > 2 cm — the proportions differ: refit the skeleton to this model before shipping' : null,
  }, null, 1));
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
