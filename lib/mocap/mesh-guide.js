/**
 * Mesh guide — the performer's real SAM 3D Body mesh, re-posed on the cleaned
 * motion and rendered as a shaded "clay" figure from any game angle.
 *
 *   parsePly      SAM 3D Body .ply (ascii or binary) → verts + triangles
 *   alignMesh     the .ply coordinate frame isn't documented — find the rigid
 *                 flip + translation that puts the mesh on the frame's 3D
 *                 keypoints (nearest-vertex fit over the body keypoints)
 *   bindMesh      every vertex → its 1–2 nearest bone segments, stored in each
 *                 segment's local frame (built from the same keypoints)
 *   poseMesh      rebuild the vertices on the CLEANED joints (smoothed, floor-
 *                 snapped, foot-locked, in-place, any yaw/mirror) — so the mesh
 *                 follows exactly the motion the game uses, with the scan's
 *                 real volume, hands and head shape
 *   rasterize     software z-buffer render: smooth-shaded clay, blue = left
 *                 limbs, red = right, grey torso/head, dark outlines at depth
 *                 edges, eyes when visible, optional ball (proxy disc/preview)
 *
 * No GPU and no extra dependencies: ~20k vertices render in well under 100 ms.
 */
'use strict';

const zlib = require('zlib');
const S = require('./skeleton');
const { J } = S;

// ── PLY ────────────────────────────────────────────────────────────────────
const PLY_TYPES = {
  char: ['getInt8', 1], int8: ['getInt8', 1], uchar: ['getUint8', 1], uint8: ['getUint8', 1],
  short: ['getInt16', 2], int16: ['getInt16', 2], ushort: ['getUint16', 2], uint16: ['getUint16', 2],
  int: ['getInt32', 4], int32: ['getInt32', 4], uint: ['getUint32', 4], uint32: ['getUint32', 4],
  float: ['getFloat32', 4], float32: ['getFloat32', 4], double: ['getFloat64', 8], float64: ['getFloat64', 8],
};

function parsePly(buf) {
  const headEnd = buf.indexOf('end_header');
  if (headEnd < 0) throw new Error('not a PLY file');
  const header = buf.slice(0, headEnd).toString('latin1').split(/\r?\n/);
  let bodyStart = headEnd + 'end_header'.length;
  if (buf[bodyStart] === 0x0d) bodyStart++;
  if (buf[bodyStart] === 0x0a) bodyStart++;
  let format = 'ascii';
  const elements = [];
  for (const line of header) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else el.props.push({ type: t[1], name: t[2] });
    }
  }
  const vEl = elements.find((e) => e.name === 'vertex');
  const fEl = elements.find((e) => e.name === 'face');
  if (!vEl) throw new Error('PLY has no vertices');
  const ix = ['x', 'y', 'z'].map((n) => vEl.props.findIndex((p) => p.name === n));
  if (ix.some((i) => i < 0)) throw new Error('PLY vertices lack x/y/z');
  const verts = new Float32Array(vEl.count * 3);
  const tris = [];

  if (format === 'ascii') {
    const lines = buf.slice(bodyStart).toString('latin1').split(/\r?\n/);
    let li = 0;
    for (const el of elements) {
      for (let k = 0; k < el.count; k++) {
        while (li < lines.length && !lines[li].trim()) li++;
        const vals = lines[li++].trim().split(/\s+/).map(Number);
        if (el === vEl) for (let d = 0; d < 3; d++) verts[k * 3 + d] = vals[ix[d]];
        else if (el === fEl) {
          const n = vals[0];
          for (let q = 1; q < n - 1; q++) tris.push(vals[1], vals[1 + q], vals[2 + q]);
        }
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = bodyStart;
    const read = (type) => {
      const [fn, size] = PLY_TYPES[type] || [];
      if (!fn) throw new Error(`PLY type ${type} not supported`);
      const v = size === 1 ? dv[fn](off) : dv[fn](off, le);
      off += size;
      return v;
    };
    for (const el of elements) {
      for (let k = 0; k < el.count; k++) {
        const row = [];
        let face = null;
        for (const p of el.props) {
          if (p.list) {
            const n = read(p.countType);
            const idx = [];
            for (let q = 0; q < n; q++) idx.push(read(p.type));
            if (el === fEl && (p.name === 'vertex_indices' || p.name === 'vertex_index' || !face)) face = idx;
            row.push(null);
          } else row.push(read(p.type));
        }
        if (el === vEl) for (let d = 0; d < 3; d++) verts[k * 3 + d] = row[ix[d]];
        else if (el === fEl && face) for (let q = 1; q < face.length - 1; q++) tris.push(face[0], face[q], face[q + 1]);
      }
    }
  }
  return { verts, faces: Uint32Array.from(tris) };
}

/** Binary PLY writer (tests / mock provider). */
function writePly(verts, faces) {
  const nV = verts.length / 3, nF = faces.length / 3;
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${nV}\nproperty float x\nproperty float y\nproperty float z\nelement face ${nF}\nproperty list uchar int vertex_indices\nend_header\n`, 'latin1');
  const body = Buffer.alloc(nV * 12 + nF * 13);
  let o = 0;
  for (let i = 0; i < nV * 3; i++) { body.writeFloatLE(verts[i], o); o += 4; }
  for (let f = 0; f < nF; f++) {
    body.writeUInt8(3, o); o += 1;
    for (let q = 0; q < 3; q++) { body.writeInt32LE(faces[f * 3 + q], o); o += 4; }
  }
  return Buffer.concat([head, body]);
}

// ── alignment ──────────────────────────────────────────────────────────────
const BODY_KP = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 20, J['left-wrist'], J['right-wrist'], J.neck];
const SIGNS = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]; // proper rotations only

/**
 * Rigid flip + translation that puts the mesh onto the keypoints (the space
 * the keypoints are in). Returns { sign, t, err } — err = median distance (m)
 * from each body keypoint to the nearest vertex (keypoints sit on/inside the
 * surface, so a good fit is a few cm).
 */
function alignMesh(verts, kp3d) {
  const n = verts.length / 3;
  const step = Math.max(1, Math.floor(n / 2500));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push([verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]);
  const kps = BODY_KP.map((k) => kp3d[k]).filter(Boolean);
  const kc = kps.reduce((a, p) => S.add(a, p), [0, 0, 0]).map((v) => v / kps.length);
  let best = null;
  for (const sg of SIGNS) {
    const sv = sample.map((p) => [p[0] * sg[0], p[1] * sg[1], p[2] * sg[2]]);
    const vc = sv.reduce((a, p) => S.add(a, p), [0, 0, 0]).map((v) => v / sv.length);
    let t = S.sub(kc, vc);
    let err = Infinity;
    for (let it = 0; it < 8; it++) {
      const deltas = [];
      const ds = [];
      for (const k of kps) {
        let bd = Infinity, bp = null;
        for (const p of sv) {
          const dx = p[0] + t[0] - k[0], dy = p[1] + t[1] - k[1], dz = p[2] + t[2] - k[2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; bp = p; }
        }
        deltas.push(S.sub(k, S.add(bp, t)));
        ds.push(Math.sqrt(bd));
      }
      err = S.median(ds);
      // Keypoints are inside the body, the nearest vertex is on the surface:
      // move by a damped mean so the fit settles at the centre, not a side
      const m = deltas.reduce((a, d) => S.add(a, d), [0, 0, 0]).map((v) => (v / deltas.length) * 0.8);
      t = S.add(t, m);
      if (S.len(m) < 1e-4) break;
    }
    if (!best || err < best.err) best = { sign: sg, t, err };
  }
  return best;
}

function applyAlign(verts, { sign, t }) {
  const out = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    out[i] = verts[i] * sign[0] + t[0];
    out[i + 1] = verts[i + 1] * sign[1] + t[1];
    out[i + 2] = verts[i + 2] * sign[2] + t[2];
  }
  return out;
}

// ── compact storage ────────────────────────────────────────────────────────
const Q = 0.00025; // 0.25 mm per unit, ±8 m range

/** Aligned vertices → gzip(int16) relative to an origin. */
function encodeVerts(verts, origin) {
  const n = verts.length / 3;
  const buf = Buffer.alloc(8 + 12 + n * 6);
  buf.write('SFM1', 0, 'latin1');
  buf.writeUInt32LE(n, 4);
  for (let d = 0; d < 3; d++) buf.writeFloatLE(origin[d], 8 + d * 4);
  for (let i = 0; i < n * 3; i++) {
    const q = Math.max(-32767, Math.min(32767, Math.round((verts[i] - origin[i % 3]) / Q)));
    buf.writeInt16LE(q, 20 + i * 2);
  }
  return zlib.gzipSync(buf);
}

function decodeVerts(gz) {
  const buf = zlib.gunzipSync(gz);
  if (buf.toString('latin1', 0, 4) !== 'SFM1') throw new Error('bad mesh file');
  const n = buf.readUInt32LE(4);
  const o = [0, 1, 2].map((d) => buf.readFloatLE(8 + d * 4));
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = buf.readInt16LE(20 + i * 2) * Q + o[i % 3];
  return out;
}

function encodeFaces(faces) {
  const buf = Buffer.alloc(8 + faces.length * 4);
  buf.write('SFF1', 0, 'latin1');
  buf.writeUInt32LE(faces.length / 3, 4);
  for (let i = 0; i < faces.length; i++) buf.writeUInt32LE(faces[i], 8 + i * 4);
  return zlib.gzipSync(buf);
}

function decodeFaces(gz) {
  const buf = zlib.gunzipSync(gz);
  if (buf.toString('latin1', 0, 4) !== 'SFF1') throw new Error('bad faces file');
  const n = buf.readUInt32LE(4);
  const out = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = buf.readUInt32LE(8 + i * 4);
  return out;
}

// ── skinning ───────────────────────────────────────────────────────────────
// Segment: a → b, with a reference direction that fixes the twist.
// side: L | R | C | H (head) — colour in the render.
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
function segmentDefs() {
  const d = [];
  const mid = (a, b) => (P) => S.mid(P[J[a]], P[J[b]]);
  const pt = (n) => (P) => P[J[n]];
  const vec = (a, b) => (P) => S.sub(P[J[b]], P[J[a]]);
  const hip = mid('left-hip', 'right-hip'), sho = mid('left-shoulder', 'right-shoulder');
  const belly = (P) => S.mid(hip(P), sho(P));
  d.push({ a: hip, b: belly, ref: vec('left-hip', 'right-hip'), side: 'C' });
  d.push({ a: belly, b: pt('neck'), ref: vec('left-shoulder', 'right-shoulder'), side: 'C' });
  d.push({ a: pt('neck'), b: mid('left-ear', 'right-ear'), ref: vec('left-ear', 'right-ear'), side: 'H' });
  for (const side of ['left', 'right']) {
    const sd = side === 'left' ? 'L' : 'R';
    const n = (x) => `${side}-${x}`;
    const palmAcross = vec(n('index-third-joint'), n('pinky-third-joint'));
    const footFwd = vec(n('heel'), n('big-toe-tip'));
    d.push({ a: pt(n('shoulder')), b: pt(n('elbow')), ref: vec(n('cubital-fossa'), n('olecranon')), side: sd });
    d.push({ a: pt(n('elbow')), b: pt(n('wrist')), ref: palmAcross, side: sd });
    d.push({ a: pt(n('wrist')), b: pt(n('middle-third-joint')), ref: palmAcross, side: sd });
    d.push({ a: pt(n('hip')), b: pt(n('knee')), ref: footFwd, side: sd });
    d.push({ a: pt(n('knee')), b: pt(n('ankle')), ref: footFwd, side: sd, shin: true });
    d.push({ a: pt(n('ankle')), b: mid(n('big-toe-tip'), n('small-toe-tip')), ref: vec(n('big-toe-tip'), n('small-toe-tip')), side: sd, foot: true });
    for (const f of ['thumb', ...FINGERS]) {
      const chain = (f === 'thumb' ? ['wrist'] : []).concat(['third-joint', 'second-joint', 'first-joint', 'tip'].map((j) => `${f}-${j}`));
      for (let c = 0; c < chain.length - 1; c++) d.push({ a: pt(n(chain[c])), b: pt(n(chain[c + 1])), ref: palmAcross, side: sd, finger: true });
    }
  }
  return d;
}
const SEGS = segmentDefs();

function segFrame(seg, P, fallbackRef) {
  const a = seg.a(P), b = seg.b(P);
  const ab = S.sub(b, a);
  const L = S.len(ab) || 1e-6;
  const u = S.scale(ab, 1 / L);
  let r = seg.ref(P);
  r = S.sub(r, S.scale(u, S.dot(r, u)));
  if (S.len(r) < 1e-5) { r = S.sub(fallbackRef, S.scale(u, S.dot(fallbackRef, u))); }
  if (S.len(r) < 1e-5) r = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v = S.norm(S.sub(r, S.scale(u, S.dot(r, u))));
  const w = S.cross(u, v);
  return { a, u, v, w, L };
}
const framesFor = (P) => {
  const fb = S.sub(P[J['right-shoulder']], P[J['left-shoulder']]);
  return SEGS.map((s) => segFrame(s, P, fb));
};

/** Min-heap of [key, value] for Dijkstra. */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const top = v[0], lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lastK) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

/**
 * Vertex → bone segment, decided ALONG THE SURFACE: seeds are the skin points
 * right over each bone, and every vertex takes the geodesically nearest seed.
 * Straight-line distance can't separate skin that touches (a hanging arm vs.
 * the side of the chest); across the surface the torso's side is far from the
 * arm (the path goes through the armpit). A second, adjacent segment is
 * blended in near joints so bends stay smooth.
 */
function bindMesh(verts, kp3d, faces) {
  const F = framesFor(kp3d);
  const n = verts.length / 3;
  const V = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const eucl = (p, k) => {
    const f = F[k], ap = S.sub(p, f.a);
    const t = Math.max(0, Math.min(f.L, S.dot(ap, f.u)));
    return S.dist(p, S.add(f.a, S.scale(f.u, t)));
  };
  // Straight-line nearest bone per vertex (limb seeds are drawn only from
  // their own bone's skin, so a raised arm beside the head still gets seeds)
  const eNear = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = V(i);
    let bd = Infinity, bk = 0;
    for (let k = 0; k < F.length; k++) { const d = eucl(p, k) * (SEGS[k].finger ? 1.15 : 1); if (d < bd) { bd = d; bk = k; } }
    eNear[i] = bk;
  }
  const nearestVertex = (q, only = -1) => {
    let bd = Infinity, bi = -1;
    for (let i = 0; i < n; i++) {
      if (only >= 0 && eNear[i] !== only) continue;
      const dx = verts[i * 3] - q[0], dy = verts[i * 3 + 1] - q[1], dz = verts[i * 3 + 2] - q[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const shoW = S.dist(kp3d[J['left-shoulder']], kp3d[J['right-shoulder']]);
  const hipW = S.dist(kp3d[J['left-hip']], kp3d[J['right-hip']]);
  const label = new Int16Array(n).fill(-1);
  const gd = new Float64Array(n).fill(Infinity);
  const heap = new Heap();
  if (faces && faces.length) {
    // adjacency (CSR)
    const deg = new Uint32Array(n + 1);
    for (let f = 0; f < faces.length; f += 3) for (let q = 0; q < 3; q++) { deg[faces[f + q]] += 2; }
    const start = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice(0, n);
    const adj = new Uint32Array(start[n]);
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      adj[fill[a]++] = b; adj[fill[a]++] = c; adj[fill[b]++] = a; adj[fill[b]++] = c; adj[fill[c]++] = a; adj[fill[c]++] = b;
    }
    // seeds: skin right over each bone (torso/head also front + back skin)
    for (let k = 0; k < F.length; k++) {
      const f = F[k];
      const ts = SEGS[k].finger ? [0.5] : [0.25, 0.5, 0.75];
      for (const t of ts) {
        const p = S.add(f.a, S.scale(f.u, t * f.L));
        const qs = [p];
        if (SEGS[k].side === 'C' || SEGS[k].side === 'H') qs.push(S.add(p, S.scale(f.w, 0.4)), S.add(p, S.scale(f.w, -0.4)));
        // Torso sides / shoulder blades: points just inside the flanks, front
        // and back — their nearest skin is the torso's own, not the arm's
        if (SEGS[k].side === 'H') {
          // crown (the head bone is short; raised arms sit close to its sides)
          qs.push(S.add(p, S.scale(f.u, 0.35)));
        }
        if (SEGS[k].side === 'C') {
          const hw = 0.3 * (k === 1 ? shoW : hipW);
          for (const sv of [-1, 1]) for (const sw of [-1, 1]) qs.push(S.add(p, S.add(S.scale(f.v, sv * hw), S.scale(f.w, sw * 0.3))));
        }
        const limb = SEGS[k].side !== 'C' && SEGS[k].side !== 'H';
        for (const q of qs) {
          const vi = nearestVertex(q, limb ? k : -1);
          if (vi < 0 || gd[vi] === 0) continue;
          // The nearest skin must really be this bone's: close to it and not
          // closer to another bone (a hand resting on a thigh, a limb in front
          // of the chest, a finger the scan merged into the palm)
          const dk = eucl(V(vi), k);
          const cap = SEGS[k].finger ? 0.035 : SEGS[k].side === 'C' || SEGS[k].side === 'H' ? 0.3 : 0.14;
          if (dk <= cap && dk <= Math.min(...F.map((_, j) => eucl(V(vi), j))) * (SEGS[k].side === 'C' || SEGS[k].side === 'H' ? 2 : 1.25) + 0.005) {
            gd[vi] = 0; label[vi] = k; heap.push(0, vi);
          }
        }
      }
    }
    while (heap.size) {
      const i = heap.pop();
      const di = gd[i];
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = adj[e];
        const dx = verts[i * 3] - verts[j * 3], dy = verts[i * 3 + 1] - verts[j * 3 + 1], dz = verts[i * 3 + 2] - verts[j * 3 + 2];
        const nd = di + Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (nd < gd[j]) { gd[j] = nd; label[j] = label[i]; heap.push(nd, j); }
      }
    }
  }
  // segment adjacency (shared joints) for joint blending
  const nbr = F.map((f, k) => F.map((g, j) => j !== k && (
    S.dist(f.a, g.a) < 1e-4 || S.dist(f.a, S.add(g.a, S.scale(g.u, g.L))) < 1e-4 ||
    S.dist(S.add(f.a, S.scale(f.u, f.L)), g.a) < 1e-4)).map((x, j) => (x ? j : -1)).filter((j) => j >= 0));

  const seg = new Uint8Array(n * 2), wt = new Float32Array(n), loc = new Float32Array(n * 6), side = new Uint8Array(n), foot = new Uint8Array(n);
  const SIDE = { C: 0, L: 1, R: 2, H: 3 };
  // Head volume (head frame: u neck→ears, v across the ears, w forward): the
  // head is compact, so skin inside it is the head's even when a raised arm
  // or a hand in front of the face is the nearest bone
  const HEAD = SEGS.findIndex((sg) => sg.side === 'H');
  const hf = F[HEAD];
  const earHalf = S.dist(kp3d[J['left-ear']], kp3d[J['right-ear']]) / 2;
  const inHead = (p) => {
    const ap = S.sub(p, hf.a);
    const t = S.dot(ap, hf.u) / hf.L, a = S.dot(ap, hf.v), b = S.dot(ap, hf.w);
    return t > 0.3 && t < 2.6 && Math.abs(a) < earHalf * 1.15 && Math.abs(b) < 0.13;
  };
  for (let i = 0; i < n; i++) {
    const p = V(i);
    let s1 = inHead(p) ? HEAD : label[i];
    if (s1 < 0) { // unreached (no mesh faces / separate piece): straight-line nearest
      let bd = Infinity;
      for (let k = 0; k < F.length; k++) { const d = eucl(p, k) * (SEGS[k].finger ? 1.15 : 1); if (d < bd) { bd = d; s1 = k; } }
    }
    const d1 = eucl(p, s1);
    let s2 = s1, d2 = Infinity;
    for (const j of nbr[s1]) { const d = eucl(p, j); if (d < d2) { d2 = d; s2 = j; } }
    const w1 = 1 / (d1 + 0.01) ** 2;
    const w2 = s2 !== s1 && d2 < d1 * 1.5 + 0.015 ? 1 / (d2 + 0.01) ** 2 : 0;
    seg[i * 2] = s1; seg[i * 2 + 1] = s2;
    wt[i] = w1 / (w1 + w2);
    for (const [slot, k] of [[0, s1], [1, s2]]) {
      const f = F[k];
      const ap = S.sub(p, f.a);
      loc[i * 6 + slot * 3] = S.dot(ap, f.u) / f.L;
      loc[i * 6 + slot * 3 + 1] = S.dot(ap, f.v);
      loc[i * 6 + slot * 3 + 2] = S.dot(ap, f.w);
    }
    side[i] = SIDE[SEGS[s1].side];
    foot[i] = SEGS[s1].foot || SEGS[s1].shin ? 1 : 0;
  }
  return { seg, wt, loc, side, foot, n };
}

/** Rebuild the vertices on a new set of joints (same MHR70 order). */
function poseMesh(bind, P) {
  const F = framesFor(P);
  const out = new Float32Array(bind.n * 3);
  for (let i = 0; i < bind.n; i++) {
    let x = 0, y = 0, z = 0;
    for (let slot = 0; slot < 2; slot++) {
      const w = slot === 0 ? bind.wt[i] : 1 - bind.wt[i];
      if (w <= 0) continue;
      const f = F[bind.seg[i * 2 + slot]];
      const t = bind.loc[i * 6 + slot * 3] * f.L, a = bind.loc[i * 6 + slot * 3 + 1], b = bind.loc[i * 6 + slot * 3 + 2];
      x += w * (f.a[0] + f.u[0] * t + f.v[0] * a + f.w[0] * b);
      y += w * (f.a[1] + f.u[1] * t + f.v[1] * a + f.w[1] * b);
      z += w * (f.a[2] + f.u[2] * t + f.v[2] * a + f.w[2] * b);
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}

// ── raster ─────────────────────────────────────────────────────────────────
const COL = [[150, 156, 168], [47, 107, 255], [235, 52, 88], [184, 188, 196]]; // C, L, R, head
const LIGHT = S.norm([-0.45, 0.55, 0.85]);

/**
 * @param {Float32Array} sv screen-space verts: x px, y px (down), z metres (+ = nearer)
 * @param {Uint32Array} faces
 * @param {Uint8Array} side per-vertex colour class
 * @param {object} o { W, H, eyes: [[x,y,z]…] screen, eyeR px, ball: {x,y,z,r (px), rz (m), color:'proxy'|'ball'},
 *                     background: [r,g,b]|null, outlinePx }
 * @returns {{ rgba: Buffer, alpha: Buffer (mesh only, 1 channel) }}
 */
function rasterize(sv, faces, side, o) {
  const { W, H } = o;
  const zb = new Float32Array(W * H).fill(-Infinity);
  const nb = new Float32Array(W * H * 3);
  const cls = new Uint8Array(W * H).fill(255);
  // vertex normals (screen space: x right, y down → flip y for a right-handed frame)
  const nV = sv.length / 3;
  const vn = new Float32Array(nV * 3);
  const P = (i) => [sv[i * 3], -sv[i * 3 + 1], sv[i * 3 + 2] * o.ppm];
  for (let f = 0; f < faces.length; f += 3) {
    const a = P(faces[f]), b = P(faces[f + 1]), c = P(faces[f + 2]);
    const n = S.cross(S.sub(b, a), S.sub(c, a));
    for (let q = 0; q < 3; q++) { const k = faces[f + q] * 3; vn[k] += n[0]; vn[k + 1] += n[1]; vn[k + 2] += n[2]; }
  }
  for (let f = 0; f < faces.length; f += 3) {
    const i0 = faces[f], i1 = faces[f + 1], i2 = faces[f + 2];
    const x0 = sv[i0 * 3], y0 = sv[i0 * 3 + 1], z0 = sv[i0 * 3 + 2];
    const x1 = sv[i1 * 3], y1 = sv[i1 * 3 + 1], z1 = sv[i1 * 3 + 2];
    const x2 = sv[i2 * 3], y2 = sv[i2 * 3 + 1], z2 = sv[i2 * 3 + 2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const c = side[i0];
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const k = y * W + x;
        if (z <= zb[k]) continue;
        zb[k] = z;
        cls[k] = c;
        for (let d = 0; d < 3; d++) nb[k * 3 + d] = w0 * vn[i0 * 3 + d] + w1 * vn[i1 * 3 + d] + w2 * vn[i2 * 3 + d];
      }
    }
  }
  const alpha = Buffer.alloc(W * H);
  for (let k = 0; k < W * H; k++) if (cls[k] !== 255) alpha[k] = 255;

  // ball: a sphere in the same depth buffer
  const ballCls = 254;
  if (o.ball) {
    const { x: bx, y: by, r, z: bz, rz } = o.ball;
    for (let y = Math.max(0, Math.floor(by - r)); y <= Math.min(H - 1, Math.ceil(by + r)); y++) {
      for (let x = Math.max(0, Math.floor(bx - r)); x <= Math.min(W - 1, Math.ceil(bx + r)); x++) {
        const dd = ((x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2) / (r * r);
        if (dd > 1) continue;
        const z = bz + rz * Math.sqrt(1 - dd);
        const k = y * W + x;
        if (z <= zb[k]) continue;
        zb[k] = z; cls[k] = ballCls;
        nb[k * 3] = (x + 0.5 - bx) / r; nb[k * 3 + 1] = -(y + 0.5 - by) / r; nb[k * 3 + 2] = Math.sqrt(1 - dd);
      }
    }
  }

  const bg = o.background;
  const rgba = Buffer.alloc(W * H * 4);
  const ol = o.outlinePx ?? 2;
  const edgeDz = 0.05;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const c = cls[k];
    if (c === 255) {
      if (bg) { rgba[k * 4] = bg[0]; rgba[k * 4 + 1] = bg[1]; rgba[k * 4 + 2] = bg[2]; rgba[k * 4 + 3] = 255; }
      continue;
    }
    // outline: a neighbour within ol px is empty, or much further away
    let edge = false;
    for (let dy = -ol; dy <= ol && !edge; dy++) for (let dx = -ol; dx <= ol; dx++) {
      if (dx * dx + dy * dy > ol * ol) continue;
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) { edge = true; break; }
      const q = Y * W + X;
      if (cls[q] === 255 || zb[k] - zb[q] > edgeDz) { edge = true; break; }
    }
    let rgb;
    if (edge) rgb = [29, 32, 39];
    else if (c === ballCls) {
      if (o.ball.color === 'proxy') rgb = [255, 0, 255];
      else { const l = 0.55 + 0.45 * Math.max(0, S.dot([nb[k * 3], nb[k * 3 + 1], nb[k * 3 + 2]], LIGHT)); rgb = [224 * l, 106 * l, 31 * l]; }
    } else {
      let n = [nb[k * 3], nb[k * 3 + 1], nb[k * 3 + 2]];
      const ln = S.len(n) || 1;
      n = S.scale(n, 1 / ln);
      if (n[2] < 0) n = S.scale(n, -1);
      const l = 0.38 + 0.52 * Math.max(0, S.dot(n, LIGHT)) + 0.18 * n[2];
      rgb = COL[c].map((v) => v * l);
    }
    rgba[k * 4] = Math.min(255, rgb[0]); rgba[k * 4 + 1] = Math.min(255, rgb[1]); rgba[k * 4 + 2] = Math.min(255, rgb[2]); rgba[k * 4 + 3] = 255;
  }
  // eyes: dark dots where the eye keypoint is on the visible surface
  for (const e of o.eyes || []) {
    const ex = Math.round(e[0]), ey = Math.round(e[1]);
    if (ex < 0 || ey < 0 || ex >= W || ey >= H) continue;
    if (zb[ey * W + ex] - e[2] > 0.025) continue; // hidden behind the head
    const r = Math.max(1.5, o.eyeR || 3);
    for (let y = Math.floor(ey - r); y <= Math.ceil(ey + r); y++) for (let x = Math.floor(ex - r); x <= Math.ceil(ex + r); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H || (x - ex) ** 2 + (y - ey) ** 2 > r * r) continue;
      const k = y * W + x;
      if (cls[k] === 255) continue;
      rgba[k * 4] = 29; rgba[k * 4 + 1] = 32; rgba[k * 4 + 2] = 39;
    }
  }
  return { rgba, alpha };
}

// ── per-motion mesh context ────────────────────────────────────────────────
/**
 * Mesh data for a motion: faces + per-source-frame verts/keypoints, with
 * lazy decoding and binding. Motion frames without their own mesh (gap-filled)
 * use the nearest frame's binding on their own joints.
 * @param {object} raw raw.json
 * @param {function} loadAsset async (name) → Buffer|null
 */
async function loadMeshContext(raw, loadAsset) {
  const recs = (raw?.frames || []).filter((r) => r.mesh && r.kp3d);
  if (!recs.length || !raw.meshFaces) return null;
  const facesBuf = await loadAsset(raw.meshFaces);
  if (!facesBuf) return null;
  const faces = decodeFaces(facesBuf);
  const byFile = new Map(recs.map((r) => [r.file, r]));
  const binds = new Map();
  return {
    faces,
    files: recs.map((r) => r.file),
    async bindingFor(file) {
      if (binds.has(file)) return binds.get(file);
      const r = byFile.get(file);
      const p = (async () => {
        const buf = await loadAsset(r.mesh);
        if (!buf) return null;
        return bindMesh(decodeVerts(buf), r.kp3d, faces);
      })();
      binds.set(file, p);
      return p;
    },
    /** Binding for motion frame i: its own source frame, else the nearest one with a mesh. */
    async bindingForFrame(motion, i) {
      for (let d = 0; d < motion.frames.length; d++) {
        for (const k of d ? [i - d, i + d] : [i]) {
          const f = motion.frames[k]?.sourceFile;
          if (f && byFile.has(f)) { const b = await this.bindingFor(f); if (b) return b; }
        }
      }
      return null;
    },
  };
}

module.exports = {
  parsePly, writePly, alignMesh, applyAlign, encodeVerts, decodeVerts, encodeFaces, decodeFaces,
  bindMesh, poseMesh, rasterize, loadMeshContext, SEGS,
};
