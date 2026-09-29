/**
 * Two-camera (or more) ball triangulation — the multi-view path of the ball
 * pipeline. One camera leaves the ball's depth uncertain (the physics system
 * repairs it against the body, BP.repairClipBall); two calibrated, synced
 * cameras measure it: each view's 2-D detection is a ray, the ball is where
 * the rays meet (linear DLT, least squares over all views that see it).
 *
 * Camera: { K: 3×3 intrinsics (row-major arrays), R: 3×3 world→camera rotation,
 *           t: [tx,ty,tz] (x_cam = R·X + t) } — or { P: 3×4 } directly.
 * Units: world metres, image pixels.
 */
'use strict';

/** 3×4 projection matrix P = K [R | t]. */
function projectionMatrix(cam) {
  if (cam.P) return cam.P;
  const { K, R, t } = cam, Rt = R.map((row, i) => [...row, t[i]]);
  return K.map((kr) => [0, 1, 2, 3].map((j) => kr[0] * Rt[0][j] + kr[1] * Rt[1][j] + kr[2] * Rt[2][j]));
}

/** Pixel of a world point in a camera (null behind it). */
function project(cam, X) {
  const P = projectionMatrix(cam), h = [X[0], X[1], X[2], 1];
  const x = P.map((r) => r[0] * h[0] + r[1] * h[1] + r[2] * h[2] + r[3] * h[3]);
  return x[2] > 1e-9 ? [x[0] / x[2], x[1] / x[2]] : null;
}

/** Eigen-decomposition of a symmetric 4×4 (cyclic Jacobi). Returns { values, vectors (columns) }. */
function symEig4(A) {
  const a = A.map((r) => r.slice()), V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: [0, 1, 2, 3].map((i) => a[i][i]), vectors: V };
}

/**
 * Triangulate one point from ≥ 2 views.
 * @param {Array<{cam, uv: [u,v], w?: number}>} obs  detections (w: confidence weight)
 * @returns {{ p: [x,y,z], reprojErr: number (px, RMS), views: number } | null}
 */
function triangulate(obs) {
  const rows = [];
  for (const o of obs) {
    if (!o?.uv) continue;
    const P = projectionMatrix(o.cam), w = o.w ?? 1, [u, v] = o.uv;
    // normalise each row pair so a far camera does not dominate the least squares
    const r1 = P[2].map((x, j) => u * x - P[0][j]), r2 = P[2].map((x, j) => v * x - P[1][j]);
    const n1 = Math.hypot(...r1) || 1, n2 = Math.hypot(...r2) || 1;
    rows.push(r1.map((x) => (x / n1) * w), r2.map((x) => (x / n2) * w));
  }
  if (rows.length < 4) return null;
  const AtA = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const { values, vectors } = symEig4(AtA);
  const k = values.indexOf(Math.min(...values));
  const h = vectors.map((r) => r[k]);
  if (Math.abs(h[3]) < 1e-12) return null;
  const p = [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
  let se = 0, n = 0;
  for (const o of obs) { if (!o?.uv) continue; const q = project(o.cam, p); if (!q) return null; se += (q[0] - o.uv[0]) ** 2 + (q[1] - o.uv[1]) ** 2; n++; }
  return { p, reprojErr: Math.sqrt(se / n), views: n };
}

/**
 * A whole ball track from synced cameras.
 * @param {Array<{cam, track: Array<[u,v]|null>, offset?: number}>} views  per camera: detections per frame
 *        (offset: this camera's frame index for world frame 0 — a sync correction)
 * @param {{ maxReprojErr?: number }} [opts]  frames whose rays do not meet within this (px) are dropped
 * @returns {Array<{ p, reprojErr, views } | null>} per frame (null: < 2 views or rejected)
 */
function triangulateTrack(views, { maxReprojErr = 6 } = {}) {
  const F = Math.max(...views.map((v) => v.track.length - (v.offset || 0)));
  const out = [];
  for (let i = 0; i < F; i++) {
    const obs = views.map((v) => ({ cam: v.cam, uv: v.track[i + (v.offset || 0)] || null })).filter((o) => o.uv);
    const r = obs.length >= 2 ? triangulate(obs) : null;
    out.push(r && r.reprojErr <= maxReprojErr ? r : null);
  }
  return out;
}

module.exports = { projectionMatrix, project, triangulate, triangulateTrack, symEig4 };
