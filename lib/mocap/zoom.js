/**
 * Zoomed SAM 3D Body calls: hands at full detail.
 *
 * SAM 3D Body refines each hand with a dedicated hand decoder, but only when
 * the hand's box in the image it receives is > 64 px (sam3d_body.py,
 * hand_box_size_thresh). In a 1080p phone frame a hand is ~40–60 px, so the
 * refinement is skipped and fingers come from the coarse body decoder. We send
 * a crop around the player, enlarged so the hands clear that bar, and map the
 * answer back to the full frame:
 *
 *   2D   u = u_crop / s + ox                    (exact)
 *   3D   the model assumes the crop centre is on the optical axis: rotate the
 *        body onto the true ray through the crop centre (R_fix)
 *   t    camera translation re-solved from the 2D keypoints with the real focal
 *        length (linear least squares; rotation known)
 *   rots MHR world rotations (y-up = F·camera): F·R_fix·F · G
 */
'use strict';

const S = require('./skeleton');

/** Crop around a person box: margin, enlarged so the person is ~targetPx tall (never shrunk). */
function cropFor(bbox, W, H, { targetPx = 1900, margin = 0.14, maxScale = 4, scale = null, maxOut = 4096 } = {}) {
  const [x0, y0, x1, y1] = bbox;
  const bw = x1 - x0, bh = y1 - y0;
  const side = Math.max(bw, bh) * (1 + 2 * margin);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let ox = Math.round(cx - side / 2), oy = Math.round(cy - side / 2);
  let cw = Math.round(side), ch = Math.round(side);
  ox = Math.max(0, Math.min(W - 1, ox)); oy = Math.max(0, Math.min(H - 1, oy));
  cw = Math.min(cw, W - ox); ch = Math.min(ch, H - oy);
  // enlargement: given (from the measured hand size) or from the person's height
  let s = scale || targetPx / Math.max(1, bh * (1 + 2 * margin));
  s = Math.max(1, Math.min(maxScale, s, maxOut / Math.max(cw, ch)));
  return { ox, oy, cw, ch, s, outW: Math.round(cw * s), outH: Math.round(ch * s) };
}

const F = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
const mm = (a, b) => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c]));

/** Camera translation from 2D keypoints + 3D shape (rotation known), focal f, principal point (cx, cy). */
function solveCamT(kp3d, kp2d, f, cx, cy, idx) {
  // (u − cx)(Z + tz) = f (X + tx)   and   (v − cy)(Z + tz) = f (Y + ty)
  const A = [], b = [];
  for (const k of idx) {
    const P = kp3d[k], q = kp2d[k];
    if (!P || !q || !Number.isFinite(q[0])) continue;
    const du = q[0] - cx, dv = q[1] - cy;
    A.push([f, 0, -du]); b.push(du * P[2] - f * P[0]);
    A.push([0, f, -dv]); b.push(dv * P[2] - f * P[1]);
  }
  // normal equations 3×3
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (let i = 0; i < A.length; i++) for (let a = 0; a < 3; a++) { r[a] += A[i][a] * b[i]; for (let c = 0; c < 3; c++) M[a][c] += A[i][a] * A[i][c]; }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!(Math.abs(D) > 1e-12)) return null;
  const col = (c) => M.map((row, i) => row.map((v, j) => (j === c ? r[i] : v)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/** Body keypoints used for the translation fit (torso + limbs, not fingers). */
const FIT_IDX = Array.from({ length: 21 }, (_, i) => i).concat([S.J['left-wrist'], S.J['right-wrist'], S.J.neck]);

/**
 * Map a SAM 3D Body answer on a crop back to the full frame.
 * @param {object} body  providers.bodyFrame() result for the crop image
 * @param {object} crop  cropFor() result
 * @param {object} frame { W, H, focal } — focal of the full frame (px)
 */
function uncrop(body, crop, frame) {
  const { ox, oy, s, outW, outH } = crop;
  const f = frame.focal || (body.focal / s);
  const cx = frame.W / 2, cy = frame.H / 2;
  const kp2d = body.kp2d.map((q) => [q[0] / s + ox, q[1] / s + oy]);
  // rotate onto the true ray through the crop centre
  const ray = S.norm([(ox + outW / s / 2 - cx) / f, (oy + outH / s / 2 - cy) / f, 1]);
  const Rfix = S.rotBetween([0, 0, 1], ray);
  const kp3d = body.kp3d.map((p) => S.mulMV(Rfix, p));
  const camT = solveCamT(kp3d, kp2d, f, cx, cy, FIT_IDX) || S.mulMV(Rfix, body.camT);
  const bbox = body.bbox ? [body.bbox[0] / s + ox, body.bbox[1] / s + oy, body.bbox[2] / s + ox, body.bbox[3] / s + oy] : null;
  let mhr = body.mhr;
  if (mhr?.rots) {
    const Rw = mm(F, mm(Rfix, F));   // the same rotation in MHR's y-up space
    const rots = [], joints = [];
    for (let j = 0; j < mhr.rots.length / 9; j++) {
      const G = [mhr.rots.slice(j * 9, j * 9 + 3), mhr.rots.slice(j * 9 + 3, j * 9 + 6), mhr.rots.slice(j * 9 + 6, j * 9 + 9)];
      rots.push(...mm(Rw, G).flat().map((x) => +x.toFixed(5)));
    }
    for (let j = 0; j < mhr.joints.length / 3; j++) joints.push(...S.mulMV(Rfix, mhr.joints.slice(j * 3, j * 3 + 3)).map((x) => +x.toFixed(5)));
    mhr = { ...mhr, rots, joints };
  }
  return { ...body, kp2d, kp3d, camT, focal: f, bbox, imgW: frame.W, imgH: frame.H, mhr, zoom: { ox, oy, s: +s.toFixed(3) } };
}

/** Hand size in the frame (px, largest hand's keypoint extent) → the enlargement that puts it at ~110 px. */
function scaleForHands(kp2d, targetHandPx = 110) {
  let ext = 0;
  for (const s of ['left', 'right']) {
    const pts = S.MHR70.map((n, k) => [n, k]).filter(([n]) => n.startsWith(s + '-') && /(thumb|index|middle|ring|pinky)|wrist/.test(n)).map(([, k]) => kp2d[k]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    ext = Math.max(ext, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  }
  return ext > 1 ? targetHandPx / ext : null;
}

/** Agreement of a zoomed answer with a full-frame one (same frame): root rotation (deg) and 2D (px). */
function compare(full, zoomed) {
  const d2 = FIT_IDX.map((k) => Math.hypot(full.kp2d[k][0] - zoomed.kp2d[k][0], full.kp2d[k][1] - zoomed.kp2d[k][1]));
  let rootDeg = null;
  if (full.mhr?.rots && zoomed.mhr?.rots) {
    const g = (m) => [m.slice(9, 12), m.slice(12, 15), m.slice(15, 18)]; // joint 1 = root
    const a = g(full.mhr.rots), b = g(zoomed.mhr.rots);
    const t = a[0][0] * b[0][0] + a[0][1] * b[0][1] + a[0][2] * b[0][2] + a[1][0] * b[1][0] + a[1][1] * b[1][1] + a[1][2] * b[1][2] + a[2][0] * b[2][0] + a[2][1] * b[2][1] + a[2][2] * b[2][2];
    rootDeg = (Math.acos(Math.max(-1, Math.min(1, (t - 1) / 2))) * 180) / Math.PI;
  }
  return { kp2dPx: +(d2.reduce((x, y) => x + y, 0) / d2.length).toFixed(1), rootDeg: rootDeg == null ? null : +rootDeg.toFixed(1) };
}

module.exports = { cropFor, uncrop, solveCamT, compare, scaleForHands, FIT_IDX };
