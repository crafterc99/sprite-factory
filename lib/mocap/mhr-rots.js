/**
 * SAM 3D Body's MHR joint rotations through the motion / game-clip pipeline.
 *
 * Every analysed frame carries rec.mhr.rots: 127 world rotations (row-major
 * 3×3, MHR's y-up space = motion-builder's toWorld space). They are the
 * body model's own fit — hands, fingers, forearm twist included — so replaying
 * them makes the character match the video far better than re-deriving
 * rotations from keypoints. Kept as unit quaternions [x, y, z, w].
 */
'use strict';

const NJ_MHR = 127;

function matToQuat(m, o = 0) {
  // m: flat row-major 3×3 at offset o
  const a = m[o], b = m[o + 1], c = m[o + 2], d = m[o + 3], e = m[o + 4], f = m[o + 5], g = m[o + 6], h = m[o + 7], i = m[o + 8];
  const t = a + e + i;
  let x, y, z, w;
  if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); w = 0.25 / s; x = (h - f) * s; y = (c - g) * s; z = (d - b) * s; }
  else if (a > e && a > i) { const s = 2 * Math.sqrt(1 + a - e - i); w = (h - f) / s; x = 0.25 * s; y = (b + d) / s; z = (c + g) / s; }
  else if (e > i) { const s = 2 * Math.sqrt(1 + e - a - i); w = (c - g) / s; x = (b + d) / s; y = 0.25 * s; z = (f + h) / s; }
  else { const s = 2 * Math.sqrt(1 + i - a - e); w = (d - b) / s; x = (c + g) / s; y = (f + h) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}
const qmul = (p, q) => [
  p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1],
  p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
  p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3],
  p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2],
];
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  if (d > 0.9995) { const q = a.map((v, k) => v + (s * b[k] - v) * t); const l = Math.hypot(...q); return q.map((v) => v / l); }
  const th = Math.acos(Math.min(1, d)), sa = Math.sin(th), k0 = Math.sin((1 - t) * th) / sa, k1 = (s * Math.sin(t * th)) / sa;
  return a.map((v, k) => k0 * v + k1 * b[k]);
}
/** Quaternion of a 3×3 (nested rows). */
const quatOf = (R) => matToQuat(R.flat());
/** Rotation about +Y by angle a, as a quaternion. */
const qY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

/** Frames' rots → quats (null where a frame has none). */
function framesToQuats(src) {
  return src.map((fr) => {
    const r = fr && !fr.error && fr.mhr && fr.mhr.rots;
    if (!r || r.length !== NJ_MHR * 9) return null;
    const out = new Array(NJ_MHR);
    for (let j = 0; j < NJ_MHR; j++) out[j] = matToQuat(r, j * 9);
    return out;
  });
}

/** Fill null frames by slerp between neighbours (hold at the ends). */
function fillQuats(Q) {
  const have = Q.map((q) => !!q);
  if (!have.some(Boolean)) return null;
  return Q.map((q, i) => {
    if (q) return q;
    let a = i - 1; while (a >= 0 && !have[a]) a--;
    let b = i + 1; while (b < Q.length && !have[b]) b++;
    if (a >= 0 && b < Q.length) return Q[a].map((qa, j) => slerp(qa, Q[b][j], (i - a) / (b - a)));
    return Q[a >= 0 ? a : b].map((x) => x.slice());
  });
}

/** Gaussian smoothing on quaternions (hemisphere-aligned weighted average). */
function smoothQuats(Q, sigma) {
  if (!(sigma > 0.05)) return Q;
  const r = Math.ceil(sigma * 2.5), N = Q.length;
  return Q.map((_, i) => Q[i].map((qi, j) => {
    const acc = [0, 0, 0, 0];
    for (let k = -r; k <= r; k++) {
      const f = Q[i + k]; if (!f) continue;
      const q = f[j], w = Math.exp(-(k * k) / (2 * sigma * sigma));
      const s = q[0] * qi[0] + q[1] * qi[1] + q[2] * qi[2] + q[3] * qi[3] < 0 ? -w : w;
      for (let c = 0; c < 4; c++) acc[c] += q[c] * s;
    }
    const l = Math.hypot(...acc) || 1;
    return acc.map((v) => v / l);
  }));
  void N;
}

/** Apply a world rotation (quat) to every joint of every frame. */
const rotateAll = (Q, q) => Q.map((f) => f.map((x) => qmul(q, x)));

/** Pack F × 127 quats as base64 Int16 (×32767). */
function packQuats(Q) {
  const a = new Int16Array(Q.length * NJ_MHR * 4);
  let o = 0;
  for (const f of Q) for (const q of f) { const s = q[3] < 0 ? -1 : 1; for (let c = 0; c < 4; c++) a[o++] = Math.round(q[c] * s * 32767); }
  return Buffer.from(a.buffer).toString('base64');
}

module.exports = { NJ_MHR, matToQuat, qmul, slerp, quatOf, qY, framesToQuats, fillQuats, smoothQuats, rotateAll, packQuats };
