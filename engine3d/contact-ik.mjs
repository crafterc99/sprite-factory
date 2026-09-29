/**
 * Contact IK — the final, bounded correction of the animated skeleton
 * against the PHYSICAL basketball (render layer, after the physics step).
 *
 * The SAM-driven pose stays the base; physics owns the ball. This only moves
 * the body a little toward the ball — never the ball into the hand:
 *   reachArm    two-bone reach (shoulder, elbow) so the palm meets the ball's surface (≤ ikMax)
 *   aimHand     turn the hand at the wrist so the palm faces the ball (≤ ikAimMax)
 *   conformFingers  every phalanx outside the ball; a controlling hand curls onto its surface
 *   yieldLeg    the knee moves by the physics system's leg yield (hip + ankle fixed)
 *
 * Works on MHR skinning matrices (M = [Q | p − Q·b], column-major 4×4 per joint)
 * as written by engine3d/mhr-skin.mjs; `rig` is prepareMhr()'s result.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Rotation matrix (rows) about unit axis u by angle a. */
function axisAngle(u, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = u;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}
const mv = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
/** Shortest rotation taking direction a onto b, optionally limited to maxAngle. */
function swing(a, b, maxAngle = Math.PI) {
  const u = norm(a), v = norm(b), c = clamp(dot(u, v), -1, 1);
  let ax = cross(u, v); const s = len(ax);
  if (s < 1e-9) return null;
  ax = sc(ax, 1 / s);
  return axisAngle(ax, Math.min(Math.acos(c), maxAngle));
}

/** Subtree joint lists (joint + descendants), cached on the rig. */
function subtree(rig, j) {
  rig._sub ||= new Map();
  if (rig._sub.has(j)) return rig._sub.get(j);
  const out = [], st = [j];
  while (st.length) { const k = st.pop(); out.push(k); for (const c of rig.children[k]) st.push(c); }
  rig._sub.set(j, out);
  return out;
}

/** World position of joint j (p = Q·b + t). */
export function jointPos(mats, rig, j) {
  const o = j * 16, b = rig.b[j];
  return [mats[o] * b[0] + mats[o + 4] * b[1] + mats[o + 8] * b[2] + mats[o + 12], mats[o + 1] * b[0] + mats[o + 5] * b[1] + mats[o + 9] * b[2] + mats[o + 13], mats[o + 2] * b[0] + mats[o + 6] * b[1] + mats[o + 10] * b[2] + mats[o + 14]];
}
/** Accessor name → world position (for bodySampleFromJoints). */
export function jointAccessor(mats, rig) {
  const cache = new Map();
  return (name) => {
    let p = cache.get(name);
    if (!p) { const j = rig.JI[name]; p = j == null ? [0, 0, 0] : jointPos(mats, rig, j); cache.set(name, p); }
    return p;
  };
}

/** Rotate joint j's subtree by R (rows) about the world point `pivot`. */
export function rotateSubtree(mats, rig, j, R, pivot) {
  for (const k of subtree(rig, j)) {
    const o = k * 16;
    // Q' = R·Q  (columns of Q are mats[o..o+2], [o+4..o+6], [o+8..o+10])
    for (const c of [0, 4, 8]) {
      const col = [mats[o + c], mats[o + c + 1], mats[o + c + 2]], r = mv(R, col);
      mats[o + c] = r[0]; mats[o + c + 1] = r[1]; mats[o + c + 2] = r[2];
    }
    // t' = R·(t − pivot) + pivot
    const t = [mats[o + 12] - pivot[0], mats[o + 13] - pivot[1], mats[o + 14] - pivot[2]], r = mv(R, t);
    mats[o + 12] = r[0] + pivot[0]; mats[o + 13] = r[1] + pivot[1]; mats[o + 14] = r[2] + pivot[2];
  }
}

const J = (rig, name) => rig.JI[name];

/** Palm frame of one hand from the matrices (same construction as the physics body). */
export function palmFrame(mats, rig, s) {
  const P = (n) => jointPos(mats, rig, J(rig, `${s}_${n}`));
  const wr = P('wrist'), m1 = P('middle1'), i1 = P('index1'), p1 = P('pinky1');
  const y = norm(sub(m1, wr));
  let x = sub(i1, p1); x = norm(sub(x, sc(y, dot(x, y))));
  const z = cross(x, y), n = s === 'r' ? z : sc(z, -1);
  return { wr, c: add(add(wr, sc(sub(m1, wr), 0.55)), sc(n, -0.004)), n, x, y };
}

/**
 * Reach: move the wrist by `delta` (world) with a two-bone solve — bend the
 * elbow for the new shoulder–wrist distance, then swing the arm onto it.
 */
export function reachArm(mats, rig, s, delta) {
  const iS = J(rig, `${s}_uparm`), iE = J(rig, `${s}_lowarm`), iW = J(rig, `${s}_wrist`);
  const S = jointPos(mats, rig, iS), E = jointPos(mats, rig, iE), W = jointPos(mats, rig, iW);
  const Wt = add(W, delta);
  const l1 = len(sub(E, S)), l2 = len(sub(W, E));
  const d = clamp(len(sub(Wt, S)), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  // elbow: current vs wanted interior angle
  let axis = cross(sub(E, S), sub(W, E));
  if (len(axis) < 1e-6) axis = cross(sub(E, S), [0, 1, 0]);
  axis = norm(axis);
  const cur = Math.acos(clamp(dot(norm(sub(S, E)), norm(sub(W, E))), -1, 1));
  const want = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  if (Math.abs(want - cur) > 1e-5) rotateSubtree(mats, rig, iE, axisAngle(axis, cur - want), E);
  // swing the whole arm about the shoulder onto the target
  const W2 = jointPos(mats, rig, iW);
  const R = swing(sub(W2, S), sub(Wt, S));
  if (R) rotateSubtree(mats, rig, iS, R, S);
}

/** Aim: turn the hand at the wrist so the palm normal points toward `dir` (≤ maxAngle). */
export function aimHand(mats, rig, s, dir, maxAngle) {
  const f = palmFrame(mats, rig, s);
  const R = swing(f.n, dir, maxAngle);
  if (R) rotateSubtree(mats, rig, J(rig, `${s}_wrist`), R, f.wr);
}

const FINGER_CHAINS = { thumb: ['thumb1', 'thumb2', 'thumb3', 'thumb_null'], index: ['index1', 'index2', 'index3', 'index_null'], middle: ['middle1', 'middle2', 'middle3', 'middle_null'], ring: ['ring1', 'ring2', 'ring3', 'ring_null'], pinky: ['pinky1', 'pinky2', 'pinky3', 'pinky_null'] };

/**
 * Fingers on the outside of the sphere: each phalanx is turned about its base
 * joint so its far end sits at (ball radius + finger radius) from the centre —
 * out of the ball if it had entered it, or (grip) curled onto it when the hand
 * controls the ball and the finger is close. Bounded per joint.
 */
export function conformFingers(mats, rig, s, ball, R, { grip = true, rf = 0.0095, maxAngle = 0.7, reach = 0.035 } = {}) {
  let moved = 0;
  for (const [f, ch] of Object.entries(FINGER_CHAINS)) {
    const r = f === 'thumb' ? rf * 1.15 : rf;
    for (let k = 0; k < 3; k++) {
      const ja = J(rig, `${s}_${ch[k]}`), jb = J(rig, `${s}_${ch[k + 1]}`);
      if (ja == null || jb == null) continue;
      const a = jointPos(mats, rig, ja), b = jointPos(mats, rig, jb);
      const want = R + r;
      const dist = (p) => len(sub(p, ball));
      const d0 = dist(b);
      const inside = d0 < want - 1e-4;
      const curl = grip && !inside && d0 < want + reach && dist(a) > want;
      if (!inside && !curl) continue;
      // axis that swings the tip toward the centre for +θ
      let ax = cross(sub(b, a), sub(ball, a));
      if (len(ax) < 1e-9) continue;
      ax = norm(ax);
      const tipAt = (th) => add(a, mv(axisAngle(ax, th), sub(b, a)));
      // search the angle that puts the tip on the surface: inside → negative (out), curl → positive (onto it)
      let lo = inside ? -maxAngle : 0, hi = inside ? 0 : maxAngle;
      const f0 = (th) => dist(tipAt(th)) - want;          // > 0 outside
      if (inside && f0(lo) < 0) lo = -maxAngle;            // cannot fully clear: take the bound
      for (let it = 0; it < 18; it++) {
        const mid = (lo + hi) / 2;
        if (inside) { if (f0(mid) < 0) hi = mid; else lo = mid; }
        else { if (f0(mid) > 0) lo = mid; else hi = mid; }
      }
      const th = inside ? lo : lo;
      if (Math.abs(th) > 1e-4) { rotateSubtree(mats, rig, ja, axisAngle(ax, th), a); moved++; }
    }
  }
  return moved;
}

/** Knee yield: move the knee by `y` (world), hip and ankle fixed (planted feet stay put). */
export function yieldLeg(mats, rig, s, y) {
  if (len(y) < 1e-4) return;
  const iH = J(rig, `${s}_upleg`), iK = J(rig, `${s}_lowleg`), iA = J(rig, `${s}_foot`);
  const H = jointPos(mats, rig, iH), K = jointPos(mats, rig, iK), A = jointPos(mats, rig, iA);
  const Kt = add(K, y);
  const R1 = swing(sub(K, H), sub(Kt, H));
  if (R1) rotateSubtree(mats, rig, iH, R1, H);
  const K2 = jointPos(mats, rig, iK), A2 = jointPos(mats, rig, iA);
  const R2 = swing(sub(A2, K2), sub(A, K2));
  if (R2) rotateSubtree(mats, rig, iK, R2, K2);
}

/**
 * The whole contact pass for one frame.
 * @param {Float32Array} mats  bone matrices (modified in place)
 * @param {object} rig   prepareMhr() result
 * @param {object} ball  { p: [x,y,z], R }
 * @param {object} ctl   { hand: 'left'|'right'|null, weight: 0–1 (contact 1, approach < 1), grip: bool, other: 'left'|'right'|null, otherWeight,
 *                         reachMax / reachLimit: a catch reach (the hand goes to a ball it would miss) }
 * @param {object} cfg   physics config (ikStrength, ikMax, ikAimMax, palmThickness, radii.finger)
 * @param {object} [legYield] { left: [x,y,z], right }
 */
export function contactPass(mats, rig, ball, ctl, cfg, legYield = null) {
  const out = { reach: 0, aim: 0, fingers: 0 };
  if (legYield) for (const [s, side] of [['l', 'left'], ['r', 'right']]) yieldLeg(mats, rig, s, legYield[side]);
  const hands = [];
  if (ctl?.hand) hands.push([ctl.hand, ctl.weight ?? 1]);
  if (ctl?.other) hands.push([ctl.other, ctl.otherWeight ?? 0]);
  for (const [side, w0] of hands) {
    const s = side[0], w = clamp(w0 * (cfg.ikStrength ?? 1), 0, 1);
    if (w <= 0.001) continue;
    // where the palm would touch the ball's surface (same geometry as the physics palm target, inverted)
    const f = palmFrame(mats, rig, s);
    const toBall = norm(sub(ball.p, f.c));
    const want = sub(sub(ball.p, sc(toBall, ball.R + cfg.palmThickness)), sc(f.y, 0.012));
    let d = sub(want, f.c);
    const dl = len(d);
    if (dl > (ctl.reachLimit ?? cfg.ikReach ?? 0.3)) continue;   // too far: this is not a contact
    d = sc(d, Math.min(1, ((ctl.reachMax ?? cfg.ikMax) * w) / (dl || 1)) * w);
    reachArm(mats, rig, s, d); out.reach = Math.max(out.reach, len(d));
    aimHand(mats, rig, s, toBall, cfg.ikAimMax * w); out.aim += 1;
    out.fingers += conformFingers(mats, rig, s, ball.p, ball.R, { grip: ctl.grip !== false && w > 0.5, rf: cfg.radii?.finger ?? 0.0095 });
  }
  // fingers of a hand not in control must still never be inside the ball
  for (const side of ['left', 'right']) if (!hands.some(([h]) => h === side)) out.fingers += conformFingers(mats, rig, side[0], ball.p, ball.R, { grip: false, rf: cfg.radii?.finger ?? 0.0095 });
  return out;
}
