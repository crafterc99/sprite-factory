/**
 * Skeleton definitions + small vector math for the mocap pipeline.
 *
 * Keypoint order is MHR70 — the 70 keypoints SAM 3D Body returns
 * (facebookresearch/sam-3d-body sam_3d_body/metadata/mhr70.py). Every
 * keypoints_2d / keypoints_3d array in the pipeline uses this indexing.
 */
'use strict';

const MHR70 = [
  'nose', 'left-eye', 'right-eye', 'left-ear', 'right-ear',
  'left-shoulder', 'right-shoulder', 'left-elbow', 'right-elbow',
  'left-hip', 'right-hip', 'left-knee', 'right-knee', 'left-ankle', 'right-ankle',
  'left-big-toe-tip', 'left-small-toe-tip', 'left-heel',
  'right-big-toe-tip', 'right-small-toe-tip', 'right-heel',
  'right-thumb-tip', 'right-thumb-first-joint', 'right-thumb-second-joint', 'right-thumb-third-joint',
  'right-index-tip', 'right-index-first-joint', 'right-index-second-joint', 'right-index-third-joint',
  'right-middle-tip', 'right-middle-first-joint', 'right-middle-second-joint', 'right-middle-third-joint',
  'right-ring-tip', 'right-ring-first-joint', 'right-ring-second-joint', 'right-ring-third-joint',
  'right-pinky-tip', 'right-pinky-first-joint', 'right-pinky-second-joint', 'right-pinky-third-joint',
  'right-wrist',
  'left-thumb-tip', 'left-thumb-first-joint', 'left-thumb-second-joint', 'left-thumb-third-joint',
  'left-index-tip', 'left-index-first-joint', 'left-index-second-joint', 'left-index-third-joint',
  'left-middle-tip', 'left-middle-first-joint', 'left-middle-second-joint', 'left-middle-third-joint',
  'left-ring-tip', 'left-ring-first-joint', 'left-ring-second-joint', 'left-ring-third-joint',
  'left-pinky-tip', 'left-pinky-first-joint', 'left-pinky-second-joint', 'left-pinky-third-joint',
  'left-wrist',
  'left-olecranon', 'right-olecranon', 'left-cubital-fossa', 'right-cubital-fossa',
  'left-acromion', 'right-acromion', 'neck',
];

const J = Object.fromEntries(MHR70.map((n, i) => [n, i]));

// Left↔right index permutation — used for mirroring (hand variants) and for
// repairing frames where the estimator swapped the sides.
const MIRROR_PERM = MHR70.map((name) => {
  if (name.startsWith('left-')) return J['right-' + name.slice(5)];
  if (name.startsWith('right-')) return J['left-' + name.slice(6)];
  return J[name];
});

// Mannequin segments. side: L | R | C (centre). width in metres.
const BONES = [
  { a: 'left-shoulder',  b: 'left-elbow',  side: 'L', w: 0.095, part: 'upper-arm' },
  { a: 'left-elbow',     b: 'left-wrist',  side: 'L', w: 0.080, part: 'forearm' },
  { a: 'right-shoulder', b: 'right-elbow', side: 'R', w: 0.095, part: 'upper-arm' },
  { a: 'right-elbow',    b: 'right-wrist', side: 'R', w: 0.080, part: 'forearm' },
  { a: 'left-hip',       b: 'left-knee',   side: 'L', w: 0.150, part: 'thigh' },
  { a: 'left-knee',      b: 'left-ankle',  side: 'L', w: 0.110, part: 'shin' },
  { a: 'right-hip',      b: 'right-knee',  side: 'R', w: 0.150, part: 'thigh' },
  { a: 'right-knee',     b: 'right-ankle', side: 'R', w: 0.110, part: 'shin' },
  { a: 'left-heel',      b: 'left-big-toe-tip',  side: 'L', w: 0.085, part: 'foot' },
  { a: 'right-heel',     b: 'right-big-toe-tip', side: 'R', w: 0.085, part: 'foot' },
  { a: 'neck',           b: 'head',        side: 'C', w: 0.110, part: 'neck' },
];

// Hands drawn as a wrist→middle-knuckle mitten
const HANDS = [
  { wrist: 'left-wrist',  knuckle: 'left-middle-first-joint',  tip: 'left-middle-tip',  side: 'L' },
  { wrist: 'right-wrist', knuckle: 'right-middle-first-joint', tip: 'right-middle-tip', side: 'R' },
];

// ── vec3 helpers (plain arrays) ─────────────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => scale(add(a, b), 0.5);
const dist = (a, b) => len(sub(a, b));

/** 3×3 matrix (row-major nested arrays) × vec3 */
const mulMV = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/** Rotation about +Y (up) by `rad` — right-handed, y-up world. */
function rotY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

/** Rotation about +X by `rad`. */
function rotX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** Rotation matrix taking unit vector `from` onto unit vector `to` (Rodrigues). */
function rotBetween(from, to) {
  const f = norm(from), t = norm(to);
  const v = cross(f, t);
  const c = dot(f, t);
  if (c > 0.999999) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (c < -0.999999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const k = 1 / (1 + c);
  return [
    [v[0] * v[0] * k + c,     v[1] * v[0] * k - v[2], v[2] * v[0] * k + v[1]],
    [v[0] * v[1] * k + v[2],  v[1] * v[1] * k + c,    v[2] * v[1] * k - v[0]],
    [v[0] * v[2] * k - v[1],  v[1] * v[2] * k + v[0], v[2] * v[2] * k + c],
  ];
}

// Joint hierarchy (MHR70 is a point set; this tree lets us retarget bone
// lengths, run FK/IK and blend without stretching). PELVIS = virtual joint 70,
// the midpoint of the hips — the root of the tree.
const PELVIS = 70;
const PARENT = (() => {
  const p = new Array(70).fill(-1);
  const set = (child, parent) => { p[J[child]] = parent === 'PELVIS' ? PELVIS : J[parent]; };
  for (const s of ['left', 'right']) {
    set(`${s}-hip`, 'PELVIS');
    set(`${s}-knee`, `${s}-hip`); set(`${s}-ankle`, `${s}-knee`);
    for (const f of ['heel', 'big-toe-tip', 'small-toe-tip']) set(`${s}-${f}`, `${s}-ankle`);
    set(`${s}-shoulder`, 'neck'); set(`${s}-acromion`, 'neck');
    set(`${s}-elbow`, `${s}-shoulder`); set(`${s}-wrist`, `${s}-elbow`);
    set(`${s}-olecranon`, `${s}-elbow`); set(`${s}-cubital-fossa`, `${s}-elbow`);
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      set(`${s}-${f}-third-joint`, `${s}-wrist`);
      set(`${s}-${f}-second-joint`, `${s}-${f}-third-joint`);
      set(`${s}-${f}-first-joint`, `${s}-${f}-second-joint`);
      set(`${s}-${f}-tip`, `${s}-${f}-first-joint`);
    }
  }
  set('neck', 'PELVIS');
  for (const n of ['nose', 'left-eye', 'right-eye', 'left-ear', 'right-ear']) set(n, 'neck');
  return p;
})();
// Parents before children (for FK passes)
const TOPO = (() => {
  const order = [], seen = new Set([PELVIS]);
  while (order.length < 70) {
    for (let k = 0; k < 70; k++) if (!seen.has(k) && seen.has(PARENT[k])) { order.push(k); seen.add(k); }
  }
  return order;
})();
/** Joints (70) → 71 points including the virtual pelvis. */
const withPelvis = (P) => P.concat([mid(P[J['left-hip']], P[J['right-hip']])]);

const median = (arr) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const percentile = (arr, p) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[i];
};

module.exports = {
  MHR70, J, MIRROR_PERM, BONES, HANDS, PELVIS, PARENT, TOPO, withPelvis,
  add, sub, scale, dot, cross, len, norm, mid, dist, mulMV, rotY, rotX, rotBetween,
  median, percentile,
};
