#!/usr/bin/env node
/**
 * The game character's rig as a standard skinned glTF (GLB) — the reference a
 * 3D artist models and rigs against: the MHR skeleton (127 joints, the game's
 * joint names and hierarchy, bind pose), the current body mesh in that pose
 * with its skin weights (4 per vertex) and textures (PNG).
 *
 *   node scripts/export-rig-reference.js [rig=player] [outDir=docs/character-brief]
 *
 * Writes <outDir>/<rig>-rig-reference.glb and <outDir>/skeleton.json (joints:
 * name, parent, bind position / rotation in metres, world, y-up, +z forward).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const rigName = process.argv[2] || 'player';
const outDir = process.argv[3] || path.join(__dirname, '..', 'docs', 'character-brief');
const RIGS = path.join(__dirname, '..', 'lib', 'mocap', 'mhr-rigs');

const b64 = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
// quaternion helpers (x, y, z, w)
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => { const u = [q[0], q[1], q[2]], s = q[3]; const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2], uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2]; return [0, 1, 2].map((i) => 2 * d * u[i] + (s * s - uu) * v[i] + 2 * s * c[i]); };
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((x) => x / l); };
/** Column-major 4×4 of the world transform T = [R | t]. */
const mat = (q, t) => {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1];
};
/** Inverse of a rigid transform [R | t] → [Rᵀ | −Rᵀt]. */
const invMat = (q, t) => { const qi = qinv(q), ti = qrot(qi, t).map((v) => -v); return mat(qi, ti); };

(async () => {
  const rig = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RIGS, `${rigName}.json.gz`))));
  const m = rig.mhr, n = m.names.length;
  const wq = m.bindRot.map(qnorm), wt = m.bindPos;
  // joint nodes with local TRS (parent⁻¹ · world)
  const nodes = [], jointNodes = [];
  for (let i = 0; i < n; i++) {
    const p = m.parents[i];
    const lq = p < 0 ? wq[i] : qnorm(qmul(qinv(wq[p]), wq[i]));
    const lt = p < 0 ? wt[i] : qrot(qinv(wq[p]), wt[i].map((v, k) => v - wt[p][k]));
    nodes.push({ name: m.names[i], translation: lt.map((v) => +v.toFixed(6)), rotation: lq.map((v) => +v.toFixed(7)), children: [] });
    jointNodes.push(i);
  }
  for (let i = 0; i < n; i++) if (m.parents[i] >= 0) nodes[m.parents[i]].children.push(i);
  for (const nd of nodes) if (!nd.children.length) delete nd.children;
  const roots = [...Array(n).keys()].filter((i) => m.parents[i] < 0);

  // buffers
  const chunks = []; let off = 0; const views = [], accessors = [];
  const addView = (buf, target) => { const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) }); chunks.push(buf); off += buf.length; return views.length - 1; };
  const addAcc = (arr, type, comp, count, extra = {}) => { const bv = addView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), extra.target); delete extra.target; accessors.push({ bufferView: bv, componentType: comp, count, type, ...extra }); return accessors.length - 1; };

  const meshes = [], materials = [], textures = [], images = [], meshNodes = [];
  for (const part of rig.parts) {
    const V = b64(part.verts, Float32Array), UV = b64(part.uv, Float32Array);
    const F = part.faces32 ? b64(part.faces, Uint32Array) : b64(part.faces, Uint16Array);
    const SI = b64(part.skinIdx, Uint8Array), SW = b64(part.skinW, Float32Array);
    const nv = V.length / 3;
    // smooth normals
    const N = new Float32Array(nv * 3);
    for (let f = 0; f < F.length; f += 3) {
      const a = F[f] * 3, b = F[f + 1] * 3, c = F[f + 2] * 3;
      const e1 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
    }
    for (let i = 0; i < nv; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
    // weights: normalised, joints as uint16
    const J4 = new Uint16Array(nv * 4), W4 = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) { let s = 0; for (let k = 0; k < 4; k++) s += SW[i * 4 + k]; for (let k = 0; k < 4; k++) { J4[i * 4 + k] = SI[i * 4 + k]; W4[i * 4 + k] = s > 0 ? SW[i * 4 + k] / s : k === 0 ? 1 : 0; } }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], V[i * 3 + k]); mx[k] = Math.max(mx[k], V[i * 3 + k]); }
    // the rig stores Blender UVs (v up); glTF's v runs down the image (as the game does on load)
    const uvFlip = new Float32Array(UV.length); for (let i = 0; i < UV.length; i += 2) { uvFlip[i] = UV[i]; uvFlip[i + 1] = 1 - UV[i + 1]; }
    const attrs = {
      POSITION: addAcc(V, 'VEC3', 5126, nv, { min: mn, max: mx, target: 34962 }),
      NORMAL: addAcc(N, 'VEC3', 5126, nv, { target: 34962 }),
      TEXCOORD_0: addAcc(uvFlip, 'VEC2', 5126, nv, { target: 34962 }),
      JOINTS_0: addAcc(J4, 'VEC4', 5123, nv, { target: 34962 }),
      WEIGHTS_0: addAcc(W4, 'VEC4', 5126, nv, { target: 34962 }),
    };
    const indices = addAcc(F, 'SCALAR', part.faces32 ? 5125 : 5123, F.length, { target: 34963 });
    // textures → PNG
    const texOf = async (file) => {
      if (!file) return null;
      const fp = path.join(RIGS, file.replace(/^\/?chars\//, '').replace(/^([a-z0-9-]+)\//, '$1-tex/'));
      const alt = path.join(RIGS, `${rigName}-tex`, path.basename(file));
      const src = fs.existsSync(fp) ? fp : fs.existsSync(alt) ? alt : null;
      if (!src) return null;
      const png = await sharp(src).png().toBuffer();
      images.push({ bufferView: addView(png), mimeType: 'image/png', name: path.basename(src, path.extname(src)) });
      textures.push({ source: images.length - 1 });
      return textures.length - 1;
    };
    const baseTex = await texOf(part.map), normTex = await texOf(part.normalMap);
    materials.push({ name: `${part.name}_material`, pbrMetallicRoughness: { ...(baseTex != null ? { baseColorTexture: { index: baseTex } } : {}), metallicFactor: 0, roughnessFactor: 0.8 }, ...(normTex != null ? { normalTexture: { index: normTex } } : {}) });
    meshes.push({ name: part.name, primitives: [{ attributes: attrs, indices, material: materials.length - 1 }] });
    nodes.push({ name: `${part.name}_mesh`, mesh: meshes.length - 1, skin: 0 });
    meshNodes.push(nodes.length - 1);
  }
  const ibm = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) ibm.set(invMat(wq[i], wt[i]), i * 16);
  const ibmAcc = addAcc(ibm, 'MAT4', 5126, n);
  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'sprite-factory export-rig-reference' },
    scene: 0, scenes: [{ name: `${rig.name} rig reference`, nodes: [...roots, ...meshNodes] }],
    nodes, meshes, materials, ...(textures.length ? { textures, images } : {}),
    skins: [{ name: 'MHR_skeleton', joints: jointNodes, inverseBindMatrices: ibmAcc, skeleton: roots[0] }],
    accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  let js = Buffer.from(JSON.stringify(gltf)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binP = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const hdr = Buffer.alloc(12); hdr.write('glTF', 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
  const ch = (len, t) => { const c = Buffer.alloc(8); c.writeUInt32LE(len, 0); c.write(t, 4); return c; };
  fs.mkdirSync(outDir, { recursive: true });
  const glbPath = path.join(outDir, `${rigName}-rig-reference.glb`);
  fs.writeFileSync(glbPath, Buffer.concat([hdr, ch(js.length, 'JSON'), js, ch(binP.length, 'BIN\0'), binP]));
  const skel = { units: 'metres', up: '+Y', forward: '+Z', heightM: rig.heightM, joints: m.names.map((name, i) => ({ name, parent: m.parents[i] >= 0 ? m.names[m.parents[i]] : null, bindPosition: wt[i].map((v) => +v.toFixed(5)), bindRotation: wq[i].map((v) => +v.toFixed(6)) })) };
  fs.writeFileSync(path.join(outDir, 'skeleton.json'), JSON.stringify(skel, null, 1));
  console.log(JSON.stringify({ glb: glbPath, bytes: fs.statSync(glbPath).size, joints: n, parts: rig.parts.map((p) => ({ name: p.name, vertices: p.vertexCount })), textures: images.length }));
})().catch((e) => { console.error(e); process.exit(1); });
