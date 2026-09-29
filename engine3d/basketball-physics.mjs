/**
 * BasketballPhysicsSystem — the basketball as a real rigid body (Rapier).
 *
 * Rapier is authoritative: the ball is a dynamic sphere (gravity, CCD, spin,
 * restitution, friction); the visual mesh only follows it. The player is an
 * articulated set of KINEMATIC primitives (head, chest, pelvis, arms, palms,
 * finger phalanges, thighs, shins, feet) that follow the animated skeleton
 * every physics step, so the ball physically collides with the body: a
 * between-the-legs dribble must pass through the real gap between the legs.
 *
 * Control authority ("possession") never parents or teleports the ball. The
 * animation supplies INTENT (which hand should have the ball, when it lets go,
 * where the video says the ball goes) and the system turns it into forces:
 *
 *   held   → PD force toward the palm SURFACE (ball centre = palm + n·(R + t)),
 *            velocity target = palm velocity, clamped (never infinite)
 *   release→ one impulse from the release velocity of the video track blended
 *            with the hand's own velocity (dribble pressure), plus a friction
 *            impulse at the contact point from the hand's tangential motion
 *            (top / back / side spin)
 *   flight → pure physics + a weak, clamped pull toward the video trajectory
 *            (a soft target — never a position override)
 *   catch  → ramped PD from the receiving palm as the ball arrives
 *
 * Physics runs at a fixed step (default 120 Hz, up to 240) with an
 * accumulator; the renderer interpolates. Units: metres, kg, seconds, y up.
 *
 * Engine-agnostic: no three.js; runs in the browser and in Node (tests).
 */

// ── configuration (every tunable in one place; the court's panel edits these live) ──
export const BALL_DEFAULTS = Object.freeze({
  // world
  gravity: 9.81,
  hz: 120,                 // physics steps per second (120–240)
  hzFast: 240,             // …automatically, while the ball moves fast (hard pounds, crossovers, shots)
  fastStepDist: 0.03,      // m the ball may travel in one step before the fast rate kicks in
  maxSubsteps: 24,         // per rendered frame (covers a 0.1 s frame at 240 Hz; a stalled tab drops time instead of spiralling)
  ccd: true,               // continuous collision detection on the ball
  softCcd: 0.04,           // m, soft-CCD prediction distance (0 = off)
  // basketball (size 7: 29.5" circumference, ~0.62 kg, 7.5–8.5 psi)
  radius: 0.12,
  mass: 0.62,
  hollowInertia: true,     // I = 2/3 m R² (a thin shell), not a solid sphere
  ballRestitution: 0.82,
  ballFriction: 0.62,
  linearDamping: 0.02,     // air drag (small)
  angularDamping: 0.06,
  rollingResistance: 0.012, // × m g, opposing rolling on the court
  // court + hoop
  courtRestitution: 0.82,  // ball on hardwood: dropped from 1.8 m it comes back to ~1.2 m
  courtFriction: 0.55,
  rimRestitution: 0.6,
  boardRestitution: 0.65,
  // the player's body
  bodyRestitution: 0.2,    // clothes / skin absorb
  bodyFriction: 0.6,
  handFriction: 1.0,       // leather on skin grips
  fingerColliders: true,
  palmThickness: 0.014,    // half thickness of the palm box (m)
  radii: { head: 0.1, upperArm: 0.052, forearm: 0.042, thigh: 0.078, shin: 0.056, foot: 0.046, finger: 0.0095, thumb: 0.011 },
  chestHalf: [0.15, 0.155, 0.115],   // across, up, depth (half extents)
  pelvisHalf: [0.16, 0.15, 0.12],
  palmHalf: [0.042, 0.046],          // across, along (thickness: palmThickness)
  // hand control
  kp: 900,                 // N/m   PD position gain (hand ↔ ball)
  kd: 42,                  // N·s/m PD velocity gain (≈ critical for 0.62 kg)
  maxHandForce: 48,        // N (clamp; a hard pound needs ~30 N)
  maxCorrectionVel: 6,     // m/s, largest velocity change one release may impart
  contactDist: 0.06,       // m, ball-centre ↔ palm-target distance that counts as in the hand
  catchDist: 0.32,         // m, the receiving hand starts to act inside this
  releaseWindow: 0.05,     // s after a release with no hand force (the ball separates)…
  releaseDist: 0.03,       // …or until the ball is this far from the palm
  approachTime: 0.14,      // s before an expected catch the receiving hand engages
  handInfluence: 0.35,     // release velocity: share taken from the hand's own velocity
  pressureGain: 1.25,      // a hand driving down faster than the track pushes harder (× hand speed)
  spinGain: 0.6,           // tangential hand motion → friction impulse (spin)
  handMu: 0.9,             // friction limit of that impulse (× normal impulse)
  lostDist: 0.9,           // m, possession is lost when the ball is this far from the controlling hand…
  lostTime: 0.6,           // …for this long
  holdGain: 2,             // hold / gather phases: × PD gains, force limit, contact + catch range, lost time
  // soft video target (free flight)
  videoKp: 14,             // N/m
  videoKd: 2.5,            // N·s/m
  videoMaxForce: 2.5,      // N (≈ 0.4 g: guidance, never an override)
  videoRange: 1.0,         // m, no pull from further than this
  tightMoveSteer: 2,       // × videoMaxForce during between-the-legs / behind-the-back / crossovers
  // contact correction
  ikStrength: 1,           // 0–1, hand/finger contact IK (render layer)
  ikMax: 0.08,             // m, largest hand correction
  ikAimMax: 0.5,           // rad, largest palm re-aim toward the ball
  ikCatchMax: 0.3,         // m, how far the catching hand reaches for a ball it would otherwise miss
  legYield: true,          // legs make room for a ball passing between / around them
  legYieldMax: 0.05,       // m, largest knee displacement
  legYieldRate: 12,        // 1/s, how fast the leg moves out of the way / back
  contactMargin: 0.006,    // m, clearance the leg yield aims for
  penetrationTol: 0.006,   // m, deeper overlaps are logged
  lateCatchTime: 0.12,     // s a hand still takes (then pushes) a ball it reaches just after the video let go
  possessionAssist: 1,     // 0…1: undefended, the ball is guided to the catching hand (0 = pure ballistics)
  assistKp: 400,           // 1/s², tracking stiffness toward the animation's ball path (per kg)
  assistKd: 36,            // 1/s, tracking damping
  assistMaxAccel: 50,      // m/s², most the assist can bend the flight (5 g, only when the path diverges)
  assistMaxLift: 0.5,      // × weight: the assist can never hold the ball up (it always falls ≥ 0.5 g)
  assistLegAhead: 0.1,     // s: the assisted path also clears where the legs will be (a swinging foot)
  assistRange: 1.0,        // m, farther from the path than this = not a dribble any more (no assist)
  dribbleSpin: 12,         // rad/s of fingertip backspin on every dribble push (≈ 2 rev/s)
  dribbleSpinJitter: 0.35, // ± share of it, and a tilted axis: the seams tumble, never the same way twice
  regrabTime: 0.1,         // s after a release before a hand can take the ball again
  catchMatch: 1,           // 0..1: the release aims the bounce at where the catching hand will be
  catchMatchMax: 2.5,      // m/s, most horizontal change the catch aim adds to the recorded push
  pinchMaxVel: 2.5,        // m/s, ball speed relative to the hand while squeezed between the hand and the body
  maxBallSpeed: 16,        // m/s, no body contact launches the ball faster (a hard pass is ~12 m/s)
  limbMaxSpeed: 12,        // m/s, a body part moving faster than this in one step is an animation pop, not a hit (a sprinting swing foot reaches ~11)
  predictHorizon: 0.12,    // s, ball look-ahead for contact prediction
  planLimbHorizon: 0.12,   // s the release planner extrapolates each limb's own velocity (then the root's)
  planMargin: 0.025,       // m, clearance a planned release keeps from the body (prediction error allowance)
});

// ── small vector / quaternion helpers (arrays) ──
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clampLen = (v, m) => { const l = len(v); return l > m ? sc(v, m / l) : v; };
const V = (o) => [o.x, o.y, o.z];
const O = (a) => ({ x: a[0], y: a[1], z: a[2] });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function quatFromBasis(x, y, z) {
  // columns x, y, z of a rotation matrix → [x, y, z, w]
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const t = m00 + m11 + m22;
  let q;
  if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  const l = Math.hypot(...q) || 1; return q.map((v) => v / l);
}
/** Shortest rotation taking +Y onto direction d. */
export function quatYTo(d) {
  const u = norm(d), c = u[1];
  if (c < -0.99999) return [1, 0, 0, 0];
  const ax = [u[2], 0, -u[0]]; // (0,1,0) × u
  const w = 1 + c, l = Math.hypot(ax[0], ax[1], ax[2], w);
  return [ax[0] / l, ax[1] / l, ax[2] / l, w / l];
}
export function qrot(q, v) {
  const [x, y, z, w] = q, u = [x, y, z];
  const t = sc(cross(u, v), 2);
  return add(add(v, sc(t, w)), cross(u, t));
}
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  if (d > 0.9995) { const q = a.map((v, k) => v + (s * b[k] - v) * t); const l = Math.hypot(...q); return q.map((v) => v / l); }
  const th = Math.acos(Math.min(1, d)), sa = Math.sin(th), k0 = Math.sin((1 - t) * th) / sa, k1 = (s * Math.sin(t * th)) / sa;
  return a.map((v, k) => k0 * v + k1 * b[k]);
}
/** Closest point on segment ab to p, and its parameter. */
function closestOnSeg(p, a, b) {
  const ab = sub(b, a), t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1e-12), 0, 1);
  return { q: add(a, sc(ab, t)), t };
}
/** Signed distance from point p to an oriented box (centre c, rotation q, half extents h). */
function sdBox(p, c, q, h) {
  const l = qrot(qconj(q), sub(p, c));
  const d = [Math.abs(l[0]) - h[0], Math.abs(l[1]) - h[1], Math.abs(l[2]) - h[2]];
  const out = len([Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)]);
  const inside = Math.min(Math.max(d[0], d[1], d[2]), 0);
  // closest point on the box (for normals)
  const cl = [clamp(l[0], -h[0], h[0]), clamp(l[1], -h[1], h[1]), clamp(l[2], -h[2], h[2])];
  return { d: out + inside, q: add(c, qrot(q, cl)) };
}

// ── the collision body from the animated skeleton ─────────────────────────────
const FINGERS = { thumb: ['thumb1', 'thumb2', 'thumb3', 'thumb_null'], index: ['index1', 'index2', 'index3', 'index_null'], middle: ['middle1', 'middle2', 'middle3', 'middle_null'], ring: ['ring1', 'ring2', 'ring3', 'ring_null'], pinky: ['pinky1', 'pinky2', 'pinky3', 'pinky_null'] };
export const LEG_PARTS = { left: ['thigh_l', 'shin_l'], right: ['thigh_r', 'shin_r'] };

/**
 * Collision primitives from joint positions (MHR joint names, world metres).
 * @param {(name: string) => number[]} J  joint world position
 * @param {object} cfg   BALL_DEFAULTS (+ overrides)
 * @param {object} [yields] { left: [x,y,z], right: [x,y,z] } knee displacement (leg yield)
 * @returns {{ caps: object, boxes: object, palms: object }}
 *   caps  name → { a, b, r }            capsules (segment + radius)
 *   boxes name → { c, q, h }            oriented boxes (centre, rotation, half extents)
 *   palms side → { c, q, h, n, x, y }  palm boxes + outward normal (toward a ball on the palm)
 */
export function bodySampleFromJoints(J, cfg = BALL_DEFAULTS, yields = null) {
  const r = cfg.radii, caps = {}, boxes = {}, palms = {};
  // head
  const hd = J('c_head'), hn = J('c_head_null');
  caps.head = { a: lerp(hd, hn, 0.38), b: lerp(hd, hn, 0.56), r: r.head };
  // chest + pelvis boxes: frames from the joints (x across to the left, y up, z forward)
  const lu = J('l_uparm'), ru = J('r_uparm'), s2 = J('c_spine2'), nk = J('c_neck');
  const upC = norm(sub(nk, s2));
  let xC = sub(lu, ru); xC = norm(sub(xC, sc(upC, dot(xC, upC))));
  const zC = cross(xC, upC);
  boxes.chest = { c: add(lerp(s2, nk, 0.5), sc(zC, 0.02)), q: quatFromBasis(xC, upC, zC), h: cfg.chestHalf.slice() };
  const rt = J('root'), s1 = J('c_spine1'), lh = J('l_upleg'), rh = J('r_upleg');
  const upP = norm(sub(s2, rt));
  let xP = sub(lh, rh); xP = norm(sub(xP, sc(upP, dot(xP, upP))));
  const zP = cross(xP, upP);
  boxes.pelvis = { c: add(lerp(rt, s2, 0.45), sc(zP, 0.01)), q: quatFromBasis(xP, upP, zP), h: cfg.pelvisHalf.slice() };
  void s1;
  for (const [s, side] of [['l', 'left'], ['r', 'right']]) {
    const ua = J(`${s}_uparm`), la = J(`${s}_lowarm`), wr = J(`${s}_wrist`);
    caps[`upperarm_${s}`] = { a: ua, b: la, r: r.upperArm };
    // the forearm ends short of the wrist centre (its round cap would otherwise reach past the wrist into a ball on the palm; the palm box covers the wrist)
    caps[`forearm_${s}`] = { a: la, b: add(wr, sc(norm(sub(la, wr)), 0.035)), r: r.forearm };
    // palm: along = wrist → middle knuckle, across = pinky → index knuckle
    const m1 = J(`${s}_middle1`), i1 = J(`${s}_index1`), p1 = J(`${s}_pinky1`);
    const y = norm(sub(m1, wr));
    let x = sub(i1, p1); x = norm(sub(x, sc(y, dot(x, y))));
    const z = cross(x, y);
    // palm normal (toward a ball held on the palm): +z for the right hand, −z for the left
    const n = s === 'r' ? z : sc(z, -1);
    const c = add(lerp(wr, m1, 0.55), sc(n, -0.004));
    palms[side] = { c, q: quatFromBasis(x, y, z), h: [cfg.palmHalf[0], cfg.palmHalf[1], cfg.palmThickness], n, x, y };
    if (cfg.fingerColliders) {
      for (const [f, js] of Object.entries(FINGERS)) {
        for (let k = 0; k < 3; k++) caps[`${f}${k + 1}_${s}`] = { a: J(`${s}_${js[k]}`), b: J(`${s}_${js[k + 1]}`), r: f === 'thumb' ? r.thumb : r.finger };
      }
    }
    // legs (the knee may yield: hip and ankle stay put)
    const hip = J(`${s}_upleg`), ank = J(`${s}_foot`), toe = J(`${s}_ball`);
    let knee = J(`${s}_lowleg`);
    if (yields?.[side]) knee = add(knee, yields[side]);
    caps[`thigh_${s}`] = { a: hip, b: knee, r: r.thigh };
    caps[`shin_${s}`] = { a: knee, b: ank, r: r.shin };
    caps[`foot_${s}`] = { a: add(ank, sc(sub(ank, toe), 0.3)), b: toe, r: r.foot };
  }
  return { caps, boxes, palms };
}

/** Linear blend of two body samples (capsule ends lerp, box rotations slerp). */
export function lerpSample(A, B, t) {
  if (!A || t >= 1) return B;
  if (t <= 0) return A;
  const caps = {}, boxes = {}, palms = {};
  for (const k in B.caps) { const a = A.caps[k] || B.caps[k], b = B.caps[k]; caps[k] = { a: lerp(a.a, b.a, t), b: lerp(a.b, b.b, t), r: b.r }; }
  for (const k in B.boxes) { const a = A.boxes[k] || B.boxes[k], b = B.boxes[k]; boxes[k] = { c: lerp(a.c, b.c, t), q: qslerp(a.q, b.q, t), h: b.h }; }
  for (const k in B.palms) {
    const a = A.palms[k] || B.palms[k], b = B.palms[k], q = qslerp(a.q, b.q, t);
    const z = qrot(q, [0, 0, 1]);
    palms[k] = { c: lerp(a.c, b.c, t), q, h: b.h, n: k === 'right' ? z : sc(z, -1), x: qrot(q, [1, 0, 0]), y: qrot(q, [0, 1, 0]) };
  }
  return { caps, boxes, palms };
}

/** Blend of two ball intents: positions lerp, discrete flags from the nearer one. */
export function lerpIntent(A, B, t) {
  if (!A || !A.has || !B || !B.has) return t < 0.5 && A ? A : B;
  const near = t < 0.5 ? A : B;
  return { ...near, target: lerp(A.target, B.target, t), targetVel: lerp(A.targetVel, B.targetVel, t), targetAhead: B.targetAhead ? lerp(A.targetAhead || B.targetAhead, B.targetAhead, t) : null };
}

// ── single-camera ball track repair ─────────────────────────────────────────
/**
 * A recorded ball path (one camera: its depth is the least certain axis) that
 * passes through the player's own legs or torso is moved out of them — the
 * minimum distance, preferring the camera's depth axis, then sideways, then
 * up — so the video target is physically valid on this character. Only free
 * (in-flight) frames move; corrections are smoothed over neighbouring frames
 * and taper to zero at the hands (release / catch stay as recorded).
 *
 * @param {object} clip   prepared clip (clip.ball[i].p root space, modified in place)
 * @param {(frame: number) => object} bodyAt  body sample (bodySampleFromJoints) of the clip's pose at a frame, root space
 * @param {object} [opts] { margin, viewDir: [x,y,z] root-space camera axis, cfg }
 * @returns {{ frames: number, maxShift: number, worstBefore: number, worstAfter: number }}
 */
export function repairClipBall(clip, bodyAt, { margin = 0.02, viewDir = null, cfg = BALL_DEFAULTS } = {}) {
  const R = cfg.radius, F = clip.F, ball = clip.ball || [];
  const clearOf = (p, S) => {
    let w = Infinity;
    for (const [n, s] of Object.entries(S.caps)) {
      if (/thumb|index|middle|ring|pinky|arm/.test(n)) continue;
      const { q } = closestOnSeg(p, s.a, s.b); w = Math.min(w, len(sub(p, q)) - s.r - R);
    }
    for (const [, b] of Object.entries(S.boxes)) w = Math.min(w, sdBox(p, b.c, b.q, b.h).d - R);
    return w;
  };
  let d = viewDir ? norm([viewDir[0], 0, viewDir[2]]) : [0, 0, 1];
  const side = [d[2], 0, -d[0]];
  const dirs = [d, sc(d, -1), side, sc(side, -1), [0, 1, 0]];
  const shift = new Array(F).fill(null), bodies = new Array(F);
  let worstBefore = Infinity, n = 0;
  for (let i = 0; i < F; i++) {
    const b = ball[i];
    if (!b?.p || b.held) continue;
    const S = (bodies[i] = bodyAt(i)), c0 = clearOf(b.p, S);
    worstBefore = Math.min(worstBefore, c0);
    if (c0 >= margin) continue;
    let best = null;
    for (const [k, u] of dirs.entries()) {
      for (let s = 0.005; s <= 0.3; s += 0.005) {
        if (clearOf(add(b.p, sc(u, s)), S) >= margin) { const cost = s * (k < 2 ? 1 : k < 4 ? 1.6 : 2.2); if (!best || cost < best.cost) best = { v: sc(u, s), cost }; break; }
      }
    }
    if (best) { shift[i] = best.v; n++; }
  }
  if (!n) return { frames: 0, maxShift: 0, worstBefore, worstAfter: worstBefore };
  // smooth: each correction spreads over ±2 frames (envelope keeps every frame clear); held frames stay put
  const out = new Array(F).fill(null).map(() => [0, 0, 0]);
  for (let i = 0; i < F; i++) {
    if (!shift[i]) continue;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j < 0 || j >= F || !ball[j]?.p || ball[j].held) continue;
      const w = Math.exp(-(k * k) / (2 * 1.5 * 1.5));
      const cand = sc(shift[i], w);
      if (len(cand) > len(out[j])) out[j] = cand;
    }
  }
  let maxShift = 0, worstAfter = Infinity;
  for (let i = 0; i < F; i++) {
    const b = ball[i];
    if (!b?.p || b.held || !len(out[i])) continue;
    b.p = add(b.p, out[i]); b.repaired = true;
    maxShift = Math.max(maxShift, len(out[i]));
    worstAfter = Math.min(worstAfter, clearOf(b.p, bodies[i] || bodyAt(i)));
  }
  return { frames: n, maxShift, worstBefore, worstAfter };
}

// ── the system ───────────────────────────────────────────────────────────────
const GROUP_BALL = 0x0001, GROUP_BODY = 0x0002, GROUP_STATIC = 0x0004;
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const BALL_STATES = ['FREE', 'AIRBORNE', 'HAND_APPROACH', 'HAND_CONTACT', 'HAND_RELEASE', 'FLOOR_CONTACT', 'BOUNCE_RISING', 'POSSESSION_CONTROL', 'BODY_CONTACT', 'LOOSE'];

export class BasketballPhysicsSystem {
  /**
   * @param {object} RAPIER initialised @dimforge/rapier3d-compat module
   * @param {object} [cfg]  overrides of BALL_DEFAULTS
   * @param {object} [opts] { ballAt: [x,y,z], floorY: 0 }
   */
  constructor(RAPIER, cfg = {}, opts = {}) {
    this.R = RAPIER;
    this.cfg = { ...BALL_DEFAULTS, ...cfg, radii: { ...BALL_DEFAULTS.radii, ...(cfg.radii || {}) } };
    this.world = new RAPIER.World({ x: 0, y: -this.cfg.gravity, z: 0 });
    this.world.timestep = 1 / this.cfg.hz;
    this.queue = new RAPIER.EventQueue(true);
    this.names = new Map();    // collider handle → part name
    this.parts = new Map();    // part name → { body, col, kind }
    this.statics = [];
    this.floorY = opts.floorY ?? 0;
    const fb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, this.floorY - 0.5, 0));
    this.floorCol = this.world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40)
      .setRestitution(this.cfg.courtRestitution).setFriction(this.cfg.courtFriction)
      .setCollisionGroups(groups(GROUP_STATIC, GROUP_BALL)).setSolverGroups(groups(GROUP_STATIC, GROUP_BALL)), fb);
    this.names.set(this.floorCol.handle, 'floor');
    this.makeBall(opts.ballAt || [0, 1, 0]);
    // controller / state
    this.acc = 0; this.time = 0; this.steps = 0;
    this.state = 'FREE'; this.hand = null; this.mode = 'none';
    this.touching = new Set(); this.forces = new Map();
    this.defended = false;
    this._seed = 12345; this.rand = () => ((this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);        // set by the game while a defender contests the ball (assist off)
    this.touchedSince = new Set(); // every collider touched since the caller last cleared it (contacts shorter than a frame)
    this.wasHeld = false; this.heldFor = 0; this.sinceRelease = 1e9; this.lostFor = 0; this.lost = false;
    this.lastFloorAt = -1e9; this.prevSample = null; this.palmPrev = {}; this.palmVel = { left: [0, 0, 0], right: [0, 0, 0] };
    this.pushVel = { left: [0, 0, 0], right: [0, 0, 0] }; // the controlling palm's velocity while it had the ball (the release uses the push, not the follow-through)
    this.legYield = { left: [0, 0, 0], right: [0, 0, 0] };
    this.ctl = { force: [0, 0, 0], target: null, hand: null };
    this.prev = this.snapshot(); this.cur = this.prev;
    this.stats = { bounces: 0, apexes: [], maxPenetration: 0, penetrations: [], releases: 0, catches: 0, handContactTime: 0, separatedTime: 0, lastBounceAt: null, stepHz: 0 };
    this.warnings = [];
    this.lastSample = null; this.lastIntent = null;
    this._risingFromFloor = false; this._apex = 0;
  }

  // ── ball ──
  makeBall(p, v = [0, 0, 0], w = [0, 0, 0]) {
    const R = this.R, c = this.cfg;
    if (this.ball) { this.names.delete(this.ballCol.handle); this.world.removeRigidBody(this.ball); }
    const bd = R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1], p[2]).setLinvel(v[0], v[1], v[2]).setAngvel(O(w))
      .setCcdEnabled(!!c.ccd).setLinearDamping(c.linearDamping).setAngularDamping(c.angularDamping).setCanSleep(false);
    if (c.softCcd > 0 && bd.setSoftCcdPrediction) bd.setSoftCcdPrediction(c.softCcd);
    this.ball = this.world.createRigidBody(bd);
    const I = (c.hollowInertia ? 2 / 3 : 2 / 5) * c.mass * c.radius * c.radius;
    const cd = R.ColliderDesc.ball(c.radius).setMassProperties(c.mass, { x: 0, y: 0, z: 0 }, { x: I, y: I, z: I }, { x: 0, y: 0, z: 0, w: 1 })
      .setRestitution(c.ballRestitution).setFriction(c.ballFriction)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Average).setFrictionCombineRule(R.CoefficientCombineRule.Average)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0.2)
      .setCollisionGroups(groups(GROUP_BALL, GROUP_BODY | GROUP_STATIC)).setSolverGroups(groups(GROUP_BALL, GROUP_BODY | GROUP_STATIC));
    this.ballCol = this.world.createCollider(cd, this.ball);
    this.names.set(this.ballCol.handle, 'ball');
  }
  /** Explicit set-up / reset (tests, debug drop, a new possession) — not used by play. */
  placeBall(p, v = [0, 0, 0], w = [0, 0, 0]) {
    this.ball.setTranslation(O(p), true); this.ball.setLinvel(O(v), true); this.ball.setAngvel(O(w), true);
    this.ball.resetForces(true); this.ball.resetTorques(true);
    this.prev = this.cur = this.snapshot();
    this.touching.clear();
  }
  get pos() { return V(this.ball.translation()); }
  get vel() { return V(this.ball.linvel()); }
  get angvel() { return V(this.ball.angvel()); }
  snapshot() { const r = this.ball.rotation(); return { p: this.pos, q: [r.x, r.y, r.z, r.w], v: this.vel, w: this.angvel }; }
  /** Interpolated render state (alpha from advance()). */
  renderState(alpha = 1) {
    const a = this.prev, b = this.cur;
    return { p: lerp(a.p, b.p, alpha), q: qslerp(a.q, b.q, alpha), v: b.v, w: b.w };
  }
  /** An impulse that changes the ball's velocity to v (a shot / pass leaving the hand). */
  /**
   * A throw by the hands (a shot, a pass): the impulse, and the hands that let go are
   * guarded like a dribble release (their follow-through cannot hit the ball again).
   */
  throwBall(v, hands = 'both', maxDv = Infinity) {
    this.impartVelocity(v, maxDv);
    this.lastRelease = { t: this.time, v: this.vel, hand: hands };
    this.releasedBy = hands; this.sinceRelease = 0; this.wasHeld = false;
    if (hands === 'both') { this.gateFingers('left', true); this.gateFingers('right', true); } else if (hands === 'left' || hands === 'right') this.gateFingers(hands, true);
  }
  impartVelocity(v, maxDv = Infinity) {
    const dv = clampLen(sub(v, this.vel), maxDv), m = this.cfg.mass;
    this.ball.applyImpulse(O(sc(dv, m)), true);
    return dv;
  }
  /**
   * Hand switch: the hand that has the ball tosses it to the other hand's palm
   * (a move that starts in the other hand). One impulse, a ballistic path;
   * the receiving hand's catch control takes it.
   */
  handTransfer(toPalm, T = 0.3, videoAt = null) {
    // aim where the move expects the ball when it arrives (its video path), else at the palm
    const to = videoAt || this.palmTarget(toPalm);
    this.impartVelocity(this.ballisticTo(to, T), this.cfg.maxCorrectionVel + 2);
    this.transferUntil = this.time + T + 0.3;
    if (this.heldHand) { this.releasedBy = this.heldHand; this.gateFingers(this.heldHand, true); }
    this.sinceRelease = 0; this.stats.transfers = (this.stats.transfers || 0) + 1;
  }
  /** Ballistic velocity to reach `to` in T seconds from the ball's position (under gravity). */
  /** Launch velocity that reaches `to` in T s under gravity AND the ball's linear (air) damping. */
  ballisticTo(to, T) {
    const p = this.pos, g = this.cfg.gravity, k = this.cfg.linearDamping;
    if (!(k > 1e-6)) return [(to[0] - p[0]) / T, (to[1] - p[1] + 0.5 * g * T * T) / T, (to[2] - p[2]) / T];
    // v' = -g ŷ - k v  →  x(T) = x0 + (v0 + g/k ŷ)(1 - e^{-kT})/k - (g/k) T ŷ
    const f = (1 - Math.exp(-k * T)) / k;
    return [(to[0] - p[0]) / f, (to[1] - p[1] + (g / k) * T) / f - g / k, (to[2] - p[2]) / f];
  }

  // ── live tuning ──
  setConfig(patch) {
    const c = this.cfg, old = { ...c };
    Object.assign(c, patch);
    if (patch.radii) c.radii = { ...old.radii, ...patch.radii };
    this.world.gravity = { x: 0, y: -c.gravity, z: 0 };
    this.world.timestep = 1 / c.hz;
    this.floorCol.setRestitution(c.courtRestitution); this.floorCol.setFriction(c.courtFriction);
    for (const s of this.statics) s.col.setRestitution(s.kind === 'rim' ? c.rimRestitution : c.boardRestitution);
    for (const [name, p] of this.parts) { const hand = /palm|thumb|index|middle|ring|pinky/.test(name); p.col.setFriction(hand ? c.handFriction : c.bodyFriction); p.col.setRestitution(c.bodyRestitution); }
    // shape / mass changes rebuild the ball where it is, keeping its motion
    if (c.radius !== old.radius || c.mass !== old.mass || c.ccd !== old.ccd || c.softCcd !== old.softCcd || c.hollowInertia !== old.hollowInertia) {
      const s = this.snapshot(); this.makeBall(s.p, s.v, s.w);
    } else {
      this.ballCol.setRestitution(c.ballRestitution); this.ballCol.setFriction(c.ballFriction);
      this.ball.setLinearDamping(c.linearDamping); this.ball.setAngularDamping(c.angularDamping);
    }
    if (c.fingerColliders !== old.fingerColliders && !c.fingerColliders) for (const [name] of this.parts) if (/^(thumb|index|middle|ring|pinky)/.test(name)) this.removePart(name);
  }

  // ── static court objects ──
  /** Rim (a ring of short capsules) + backboard. */
  addHoop({ center = [0, 3.05, 0], rimR = 0.2286, tube = 0.01, board = null, segments = 24 } = {}) {
    const R = this.R, c = this.cfg;
    const mk = (desc, kind, pos, q = [0, 0, 0, 1]) => {
      const b = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pos[0], pos[1], pos[2]).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }));
      const col = this.world.createCollider(desc.setRestitution(kind === 'rim' ? c.rimRestitution : c.boardRestitution).setFriction(0.5)
        .setCollisionGroups(groups(GROUP_STATIC, GROUP_BALL)).setSolverGroups(groups(GROUP_STATIC, GROUP_BALL)), b);
      this.names.set(col.handle, kind); this.statics.push({ col, kind });
    };
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * 2 * Math.PI, a1 = ((i + 1) / segments) * 2 * Math.PI;
      const p0 = [center[0] + rimR * Math.cos(a0), center[1], center[2] + rimR * Math.sin(a0)];
      const p1 = [center[0] + rimR * Math.cos(a1), center[1], center[2] + rimR * Math.sin(a1)];
      mk(R.ColliderDesc.capsule(len(sub(p1, p0)) / 2, tube), 'rim', lerp(p0, p1, 0.5), quatYTo(sub(p1, p0)));
    }
    if (board) mk(R.ColliderDesc.cuboid(board.half[0], board.half[1], board.half[2]), 'board', board.center);
  }

  /** Any fixed box the ball can hit (stanchion, stands). */
  addStaticBox(center, half, { kind = 'static', restitution = 0.4, friction = 0.6 } = {}) {
    const R = this.R;
    const b = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(center[0], center[1], center[2]));
    const col = this.world.createCollider(R.ColliderDesc.cuboid(half[0], half[1], half[2]).setRestitution(restitution).setFriction(friction)
      .setCollisionGroups(groups(GROUP_STATIC, GROUP_BALL)).setSolverGroups(groups(GROUP_STATIC, GROUP_BALL)), b);
    this.names.set(col.handle, kind);
    return col;
  }

  // ── the articulated body ──
  removePart(name) { const p = this.parts.get(name); if (!p) return; this.names.delete(p.col.handle); this.world.removeRigidBody(p.body); this.parts.delete(name); }
  ensurePart(name, kind, dims) {
    let p = this.parts.get(name);
    if (p) return p;
    const R = this.R, c = this.cfg;
    const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    const hand = /palm|thumb|index|middle|ring|pinky/.test(name);
    const desc = (kind === 'cap' ? R.ColliderDesc.capsule(Math.max(1e-3, dims.half), dims.r) : R.ColliderDesc.cuboid(dims.h[0], dims.h[1], dims.h[2]))
      .setRestitution(c.bodyRestitution).setFriction(hand ? c.handFriction : c.bodyFriction)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
      .setCollisionGroups(groups(GROUP_BODY, GROUP_BALL)).setSolverGroups(groups(GROUP_BODY, GROUP_BALL));
    const col = this.world.createCollider(desc, body);
    p = { body, col, kind, half: dims.half, r: dims.r, h: dims.h, fresh: true };
    this.parts.set(name, p); this.names.set(col.handle, name);
    return p;
  }
  /**
   * Put the whole body at a pose NOW, with no motion (a teleport / new possession): every part is
   * repositioned, its colliders follow at once and no part has a velocity, so the next step can't
   * sweep the old pose through a ball placed on the new palm.
   */
  snapBody(S) {
    if (!S) return;
    for (const p of this.parts.values()) p.fresh = true;
    this.applySample(S);
    this.world.propagateModifiedBodyPositionsToColliders?.();
    this.lastSample = S; this.partVel = {};
    this.palmPrev = {}; this.palmVel = { left: [0, 0, 0], right: [0, 0, 0] }; this.palmAcc = { left: [0, 0, 0], right: [0, 0, 0] };
    for (const side of ['left', 'right']) if (S.palms?.[side]?.c) this.palmPrev[side] = S.palms[side].c;
  }
  /** Move every body part to its pose at the end of the coming step (kinematic: contacts get the limb's velocity). */
  applySample(S, h = 1 / this.cfg.hz) {
    const seen = new Set(), maxMove = this.cfg.limbMaxSpeed * h;
    const place = (p, pos, q) => {
      // a jump no limb can make in one step (an animation pop / transition) is not a hit:
      // the part is repositioned, not swept through the ball (no fake momentum)
      const cur = p.fresh ? null : V(p.body.translation());
      if (p.fresh || len(sub(pos, cur)) > maxMove) {
        p.body.setTranslation(O(pos), true); p.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true); p.fresh = false;
        if (cur) this.stats.limbPops = (this.stats.limbPops || 0) + 1;
      }
      p.body.setNextKinematicTranslation(O(pos)); p.body.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
    };
    for (const [name, s] of Object.entries(S.caps)) {
      const d = sub(s.b, s.a), half = len(d) / 2;
      const p = this.ensurePart(name, 'cap', { half, r: s.r });
      if (Math.abs(half - p.half) > 0.004 && p.col.setHalfHeight) { p.col.setHalfHeight(Math.max(1e-3, half)); p.half = half; }
      place(p, lerp(s.a, s.b, 0.5), half > 1e-5 ? quatYTo(d) : [0, 0, 0, 1]);
      seen.add(name);
    }
    for (const [name, s] of Object.entries(S.boxes)) { place(this.ensurePart(name, 'box', { h: s.h }), s.c, s.q); seen.add(name); }
    for (const [side, s] of Object.entries(S.palms)) { const name = `palm_${side[0]}`; place(this.ensurePart(name, 'box', { h: s.h }), s.c, s.q); seen.add(name); }
    for (const name of [...this.parts.keys()]) if (!seen.has(name)) this.removePart(name);
  }
  /** The releasing hand's fingers open as the ball leaves: not solid until it is clear of them. */
  gateFingers(side, open) {
    const s = side[0];
    for (const [name, p] of this.parts) {
      if (!name.endsWith('_' + s) || !/^(thumb|index|middle|ring|pinky)/.test(name)) continue;
      if (p.col.isEnabled() === open) p.col.setEnabled(!open);
    }
  }
  /** Take the player out of the simulation (no body parts). */
  clearBody() { for (const name of [...this.parts.keys()]) this.removePart(name); this.prevSample = null; }

  /** Ball-centre target on a palm's surface. */
  palmTarget(palm) {
    const c = this.cfg;
    return add(add(palm.c, sc(palm.y, 0.012)), sc(palm.n, c.radius + palm.h[2]));
  }
  /** A target point moved out of the legs / torso (never ask the ball to be inside the body). */
  projectOut(p, S, margin = this.cfg.contactMargin) {
    if (!S || !p) return p;
    const R = this.cfg.radius;
    let q = p;
    for (let it = 0; it < 3; it++) {
      let worst = null;
      for (const [n, s] of Object.entries(S.caps)) {
        if (!/thigh|shin|foot|head|arm/.test(n)) continue;
        const c = closestOnSeg(q, s.a, s.b), d = len(sub(q, c.q)) - s.r - R;
        if (d < margin && (!worst || d < worst.d)) worst = { d, n: norm(sub(q, c.q)) };
      }
      for (const [, b] of Object.entries(S.boxes)) {
        const r = sdBox(q, b.c, b.q, b.h), d = r.d - R;
        if (d < margin && (!worst || d < worst.d)) worst = { d, n: norm(sub(q, r.q)) };
      }
      if (!worst) break;
      q = add(q, sc(worst.n, margin - worst.d));
    }
    return q;
  }
  /**
   * Where a held ball should be: the video's ball (the recorded hand–ball
   * relation), but never inside the hand — pushed out along the palm normal to
   * the palm surface, and no further than contactDist from the palm target.
   */
  heldTarget(palm, video) {
    const c = this.cfg, pt = this.palmTarget(palm);
    if (!video) return pt;
    let q = video;
    const out = dot(sub(q, palm.c), palm.n), need = c.radius + palm.h[2];
    if (out < need) q = add(q, sc(palm.n, need - out));
    const d = sub(q, pt), l = len(d);
    return l > c.contactDist * 0.8 ? add(pt, sc(d, (c.contactDist * 0.8) / l)) : q;
  }

  // ── one fixed step ──
  /**
   * @param {number} h  step (s)
   * @param {object|null} S  body sample at the END of the step (null: no player)
   * @param {object|null} I  ball intent { has, held, hand, catchHand, catchIn, releaseIn, target, targetVel, targetAhead, event }
   */
  step(h, S, I) {
    const c = this.cfg, m = c.mass, g = c.gravity;
    this.world.timestep = h;
    if (S) {
      this.applySample(S, h);
      this.palmAcc ||= { left: [0, 0, 0], right: [0, 0, 0] };
      for (const side of ['left', 'right']) {
        const pc = S.palms[side]?.c;
        if (pc && this.palmPrev[side]) {
          let nv = sc(sub(pc, this.palmPrev[side]), 1 / h);
          if (len(nv) > c.limbMaxSpeed) nv = [0, 0, 0];   // a pop (teleport / blend jump), not a hand speed
          // hand acceleration (smoothed): the controller's feed-forward, so it leads instead of lagging
          this.palmAcc[side] = lerp(this.palmAcc[side], clampLen(sc(sub(nv, this.palmVel[side]), 1 / h), 120), 0.25);
          this.palmVel[side] = nv;
        }
        if (pc) this.palmPrev[side] = pc;
      }
    } else if (this.parts.size) this.clearBody();
    // finger colliders: solid on the hand that controls the ball (its grip), open on the other hand
    // (a hand arriving mid-blend must not slap the ball with its fingertips; its palm still meets it)
    // and open on a hand that just let go, until the ball is clear of them
    if (this.releasedBy && !(this.sinceRelease < 0.2 && (this.handGap ?? 1) < 0.1)) this.releasedBy = null;
    const ctlHand = I?.has ? (I.held ? I.hand : (I.catchHand || I.hand)) : null;
    for (const side of ['left', 'right']) this.gateFingers(side, (ctlHand && side !== ctlHand) || side === this.releasedBy || this.releasedBy === 'both');
    const x = this.pos, v = this.vel;
    let F = [0, 0, 0], mode = 'none', hand = null, target = null, limit = c.maxHandForce;
    const pd = (pt, vt, kp, kd) => add(sc(sub(pt, x), kp), sc(sub(vt, v), kd));
    const touchingBody = [...this.touching].some((n) => this.parts.has(n));
    const onFloor = this.touching.has('floor');
    this.sinceRelease += h;
    // a hand that just let go does not take the ball back within regrabTime (a one-frame
    // "held" flicker in a blended source would otherwise push the ball twice)
    if (I && I.held && !this.wasHeld && this.sinceRelease < c.regrabTime) I = { ...I, held: false };
    if (I && I.has && S && !this.lost) {
      hand = I.held ? I.hand : (I.catchHand || I.hand);
      // a recorded two-hand hold flickers between hand labels: control stays with the palm that has the ball
      if (I.held && this.wasHeld && this.heldHand && hand !== this.heldHand && S.palms[this.heldHand]) {
        const gNew = len(sub(x, this.palmTarget(S.palms[hand]))), gOld = len(sub(x, this.palmTarget(S.palms[this.heldHand])));
        if (gOld < c.contactDist * 1.5 && gNew > gOld + 0.03) hand = this.heldHand;
      }
      const palm = S.palms[hand];
      const pt = this.palmTarget(palm), vp = this.palmVel[hand] || [0, 0, 0];
      const gap = len(sub(x, pt));
      target = pt;
      if (I.held) {
        this._freeSince = null;
        if (!this.wasHeld) { this.stats.catches++; this.heldFor = 0; }
        this.heldFor += h;
        this.pushVel[hand] = vp;
        this.heldHand = hand;                                   // the hand that will let go
        if (I.releaseVel) this.pendingReleaseVel = I.releaseVel; // the video ball's velocity just after it does
        // two hands on the ball (a gather): the target sits between both palm surfaces
        const other = S.palms[hand === 'left' ? 'right' : 'left'];
        let pt2 = this.projectOut(this.heldTarget(palm, I.target), S), vt = vp;
        if (other) {
          const po = this.palmTarget(other), go = len(sub(x, po));
          if (go < c.contactDist * 1.5 && dot(other.n, palm.n) < -0.3) { pt2 = lerp(pt, po, 0.5); vt = lerp(vp, this.palmVel[hand === 'left' ? 'right' : 'left'], 0.5); mode = 'two-hand'; }
        }
        // a hold / gather is a firm (often two-hand) grip: more authority than a dribble touch
        const grip = /HOLD|GATHER/.test(I.event || '') ? c.holdGain : 1;
        if (grip > 1) limit = c.maxHandForce * grip;
        if (gap < c.contactDist * grip || mode === 'two-hand') {
          const ff = mode === 'two-hand' ? [0, 0, 0] : sc(this.palmAcc?.[hand] || [0, 0, 0], m);
          F = add(add(pd(pt2, vt, c.kp * grip, c.kd * Math.sqrt(grip)), [0, m * g, 0]), ff);
          this.state = this.heldFor > 0.3 ? 'POSSESSION_CONTROL' : 'HAND_CONTACT';
          mode = mode === 'two-hand' ? 'two-hand' : 'held'; this.lostFor = 0; this.inHandAt = this.time;
        } else if (gap < c.catchDist * grip) {
          const w = Math.max(0, 1 - (gap - c.contactDist) / (c.catchDist * grip - c.contactDist));
          F = sc(add(pd(this.projectOut(pt, S), vp, c.kp * grip, c.kd * Math.sqrt(grip)), [0, m * g, 0]), w);
          this.state = 'HAND_APPROACH'; mode = 'reach'; this.lostFor = 0;
        } else if (this.time < (this.transferUntil ?? -1)) {
          this.state = 'HAND_APPROACH'; mode = 'transfer'; // the ball is on its way to this hand
        } else {
          this.state = 'LOOSE'; mode = 'loose';
          const as = this.assistLevel();
          const A = as > 0 && !onFloor ? this.assistForce(x, v, I) : null;
          if (A) { F = A.F; limit = A.limit; mode = 'rescue'; this.stats.rescues = (this.stats.rescues || 0) + h; }
          else { F = this.steer(x, v, I); limit = this.steerLimit(I); }
          this.lostFor += h;
          if (gap > c.lostDist && this.lostFor > c.lostTime * grip * (as > 0 ? 3 : 1)) this.lost = true;
        }
        this.wasHeld = true;
      } else {
        const sfx = '_' + (this.heldHand || I.hand || 'r')[0];
        const hadIt = this.time - (this.inHandAt ?? -1e9) < 0.05 || gap < c.contactDist * 2
          || [...this.touching].some((n) => n.endsWith(sfx) && /^palm|^(thumb|index|middle|ring|pinky)/.test(n));
        if (this.wasHeld && hadIt) {
          const rh = this.heldHand || I.hand;
          this.release({ ...I, hand: rh, targetVel: this.pendingReleaseVel || I.targetVel }, S.palms[rh], this.pushVel[rh] || [0, 0, 0]);
          this.pendingReleaseVel = null; this.wasHeld = false; this.state = 'HAND_RELEASE'; mode = 'release';
        } else if (this.wasHeld && S.palms[this.heldHand || hand] && this.time - (this._freeSince ??= this.time) < c.lateCatchTime
          && len(sub(x, this.palmTarget(S.palms[this.heldHand || hand]))) < c.catchDist) {
          // a late touch: the video hand has let go, but this hand is only now reaching the ball —
          // it still takes it (and pushes the moment it has it), as a dribbler does
          const lh = this.heldHand || hand, lp = S.palms[lh], lpt = this.projectOut(this.palmTarget(lp), S), lv = this.palmVel[lh] || [0, 0, 0];
          const lg = len(sub(x, lpt)), w = clamp(1 - (lg - c.contactDist) / (c.catchDist - c.contactDist), 0.3, 1);
          F = sc(add(pd(lpt, lv, c.kp, c.kd), [0, m * g, 0]), w);
          hand = lh; target = lpt; this.state = 'HAND_APPROACH'; mode = 'late';
          if (lg < c.contactDist) this.inHandAt = this.time;
        } else if (this.wasHeld) {
          // the hand never had it (a missed catch): nothing pushes the ball — it just stays free
          this.pendingReleaseVel = null; this.wasHeld = false; this.physicalState(onFloor, touchingBody, v); mode = 'none';
        }
        else if (this.sinceRelease < c.releaseWindow && (this.handGap ?? 0) < c.releaseDist) { this.state = 'HAND_RELEASE'; mode = 'release'; }
        else {
          this.physicalState(onFloor, touchingBody, v);
          const approaching = dot(sub(v, vp), sub(pt, x)) > 0 || gap < c.contactDist;
          if (I.catchIn != null && I.catchIn < c.approachTime && gap < c.catchDist && approaching) {
            const w = clamp(1 - (gap - c.contactDist) / (c.catchDist - c.contactDist), 0, 1) * clamp(1 - I.catchIn / c.approachTime, 0.25, 1);
            F = sc(add(pd(pt, vp, c.kp, c.kd), [0, m * g, 0]), w);
            this.state = 'HAND_APPROACH'; mode = 'catch';
          } else if (!onFloor && !touchingBody) {
            const A = this.assistForce(x, v, I);
            if (A) { F = A.F; limit = A.limit; mode = 'assist'; target = I.target; }
            else { F = this.steer(x, v, I); limit = this.steerLimit(I); mode = 'steer'; target = I.target; }
          }
        }
      }
    } else {
      if (this.wasHeld && I && !I.has) { this.wasHeld = false; this.sinceRelease = 0; }
      this.physicalState(onFloor, touchingBody, v);
    }
    // rolling resistance on the court
    if (onFloor) {
      const vh = [v[0], 0, v[2]], s = len(vh);
      if (s > 0.01) F = add(F, sc(vh, -Math.min(c.rollingResistance * m * g, m * s / h) / s));
    }
    F = clampLen(F, limit);
    this.ball.resetForces(true); this.ball.resetTorques(true);
    if (len(F) > 0) this.ball.addForce(O(F), true);
    this.ctl = { force: F, target, hand, mode };
    this.hand = hand;
    // step
    this.prev = this.cur;
    this.world.step(this.queue);
    this.time += h; this.steps++;
    this.queue.drainCollisionEvents((h1, h2, started) => {
      const other = h1 === this.ballCol.handle ? h2 : h2 === this.ballCol.handle ? h1 : null;
      if (other == null) return;
      const name = this.names.get(other);
      if (!name) return;
      if (started) {
        this.touching.add(name); this.touchedSince.add(name);
        if (name === 'floor') { this.stats.bounces++; this.lastFloorAt = this.time; this.stats.lastBounceAt = this.time; this._risingFromFloor = true; this._apex = 0; }
      } else this.touching.delete(name);
    });
    this.forces.clear();
    this.queue.drainContactForceEvents((e) => {
      const other = e.collider1() === this.ballCol.handle ? e.collider2() : e.collider1();
      const name = this.names.get(other); if (name) this.forces.set(name, e.totalForceMagnitude());
    });
    this.cur = this.snapshot();
    // realism guard: a limb that moves implausibly fast (an animation blend) cannot launch the ball
    const sp = len(this.cur.v);
    if (sp > c.maxBallSpeed) {
      const v2 = sc(this.cur.v, c.maxBallSpeed / sp);
      this.ball.setLinvel(O(v2), true); this.cur.v = v2;
      this.stats.speedClamps = (this.stats.speedClamps || 0) + 1;
    }
    // release guard: the hand that just let go follows through with the ball; an animation jump of
    // that hand (a blend) must not hit it again — its flight stays the release's own
    if (this.releasedBy && this.lastRelease && this.sinceRelease < c.regrabTime
      && [...this.touching].some((n) => (this.releasedBy === 'both' || n.endsWith('_' + (this.releasedBy === 'left' ? 'l' : 'r'))) && /^palm|^(thumb|index|middle|ring|pinky)/.test(n))) {
      const vr = add(this.lastRelease.v, [0, -c.gravity * (this.time - this.lastRelease.t), 0]);
      if (len(sub(this.cur.v, vr)) > 0.3) { this.ball.setLinvel(O(vr), true); this.cur.v = vr; this.stats.releaseGuards = (this.stats.releaseGuards || 0) + 1; }
    }
    // squeeze guard: a ball pinched between the hand and another body part (a gather against the
    // thigh) deforms and stays with the hand — a rigid solver would squirt it out at limb speed
    if (this.hand && [...this.touching].some((n) => /^palm|^(thumb|index|middle|ring|pinky)/.test(n))
      && [...this.touching].some((n) => this.parts.has(n) && !/^palm|^(thumb|index|middle|ring|pinky)/.test(n))) {
      const pv = this.palmVel[this.hand] || [0, 0, 0], rel = sub(this.cur.v, pv);
      if (len(rel) > c.pinchMaxVel) {
        const v2 = add(pv, clampLen(rel, c.pinchMaxVel));
        this.ball.setLinvel(O(v2), true); this.cur.v = v2;
        this.stats.pinches = (this.stats.pinches || 0) + 1;
      }
    }
    // apex after a floor bounce (bounce heights)
    if (this._risingFromFloor) {
      this._apex = Math.max(this._apex, this.cur.p[1]);
      if (this.cur.v[1] < 0 && !this.touching.has('floor')) { this.stats.apexes.push(this._apex - c.radius); if (this.stats.apexes.length > 40) this.stats.apexes.shift(); this._risingFromFloor = false; }
    }
    if (S) { this.checkPenetration(S); this.updateLegYield(S, I, h); this.trackSeparation(S, h); }
    // body part velocities (consecutive samples): the release planner moves the limbs on
    if (S && this.lastSample && h > 0) {
      const L = this.lastSample, pv = this.partVel || (this.partVel = {}), vm = c.limbMaxSpeed;   // a pop is not a velocity
      // (a jump no limb can make — a teleport, a reset — is a reposition: no velocity at all, else
      // every part carries limbMaxSpeed along the jump and the ball in the hand is thrown with it)
      const vel = (x, o) => { const v = sc(sub(x, o), 1 / h); return len(v) > vm ? [0, 0, 0] : v; };
      for (const [n, cp] of Object.entries(S.caps)) { const o = L.caps[n]; if (o) pv[n] = { a: vel(cp.a, o.a), b: vel(cp.b, o.b) }; }
      for (const [n, bx] of Object.entries(S.boxes)) { const o = L.boxes[n]; if (o) pv[n] = { c: vel(bx.c, o.c) }; }
    }
    this.lastSample = S; this.lastIntent = I;
  }

  /** Soft pull toward the video trajectory (clamped by the caller). */
  steer(x, v, I) {
    const c = this.cfg;
    if (!I?.target) return [0, 0, 0];
    const e = sub(this.projectOut(I.target, this.lastSample, c.contactMargin * 2), x);
    if (len(e) > c.videoRange) return [0, 0, 0];
    return add(sc(e, c.videoKp), sc(sub(I.targetVel || [0, 0, 0], v), c.videoKd));
  }
  /** Possession assist level (0…1): cfg.possessionAssist, off while the ball handler is being defended. */
  assistLevel() { return this.defended ? 0 : clamp(this.cfg.possessionAssist ?? 0, 0, 1); }

  /**
   * Possession assist (undefended): the ball tracks the animation's own ball path — a
   * physical dribble already (gravity arc, floor bounce, into the hand) — with a bounded
   * PD force, so the corrections are small and any clip that carries a ball path works.
   * Contacts stay Rapier's; the force never lifts more than `assistMaxLift` × weight (no
   * floating ball) and is ≤ assistMaxAccel × level. Off while defended.
   * @returns {{F, limit}|null}
   */
  assistForce(x, v, I) {
    const c = this.cfg, lv = this.assistLevel();
    if (!(lv > 0) || !I?.target) return null;
    // the target clears the body now AND where the legs will be shortly (a swinging foot)
    let tgt = this.projectOut(I.target, this.lastSample, c.contactMargin * 2);
    const S = this.lastSample, pv = this.partVel;
    if (S && pv) {
      const ahead = { caps: {}, boxes: {} };
      for (const [n, cp] of Object.entries(S.caps)) {
        if (!/thigh|shin|foot/.test(n) || !pv[n]) continue;
        ahead.caps[n] = { ...cp, a: add(cp.a, sc(pv[n].a, c.assistLegAhead)), b: add(cp.b, sc(pv[n].b, c.assistLegAhead)) };
      }
      tgt = this.projectOut(tgt, ahead, c.contactMargin * 3);
    }
    const e = sub(tgt, x);
    if (len(e) > c.assistRange) return null;
    const m = c.mass;
    const F = add(sc(e, c.assistKp * m), sc(sub(I.targetVel || [0, 0, 0], v), c.assistKd * m));
    const lim = m * c.assistMaxAccel * lv, Fc = clampLen(F, lim);
    Fc[1] = Math.min(Fc[1], m * c.gravity * c.assistMaxLift);
    return { F: Fc, limit: lim };
  }

  /** Soft-steering limit: tight moves (through / around the body) get a little more guidance. */
  steerLimit(I) {
    const c = this.cfg;
    return /BETWEEN_LEGS|BEHIND_BACK|CROSSOVER/.test(I?.event || '') ? c.videoMaxForce * c.tightMoveSteer : c.videoMaxForce;
  }

  /** The release: impulse from the track's release velocity blended with the hand (pressure) + friction spin. */
  release(I, palm, vh) {
    const c = this.cfg, m = c.mass, R = c.radius;
    const vTrack = I.targetVel || [0, 0, 0];
    let vDes = add(sc(vTrack, 1 - c.handInfluence), sc(vh, c.handInfluence * c.pressureGain));
    // a hand driving down harder than the recorded dribble → a harder push
    const hy = vh[1] * c.pressureGain;
    if (hy < vDes[1]) vDes[1] = vDes[1] + (hy - vDes[1]) * 0.5;
    const v0 = this.vel;
    // friction at the contact point: the hand's tangential motion relative to the ball's intended
    // release motion spins it (top / back / side spin)
    let Jt = [0, 0, 0], pc = null;
    if (palm) {
      const n = palm.n, x = this.pos; pc = sub(x, sc(n, R));
      const vb = add(vDes, cross(this.angvel, sub(pc, x)));
      const rel = sub(vh, vb), vt = sub(rel, sc(n, dot(rel, n)));
      const Jn = Math.abs(dot(sc(sub(vDes, v0), m), n));
      Jt = clampLen(sc(vt, 0.4 * m * c.spinGain), c.handMu * Jn + 0.02);
    }
    // the fingertips: every push rolls the ball off the fingers — backspin (its bottom moving the
    // way the ball travels, so it comes back up toward the hand), never twice on the same axis
    let roll = [0, 0, 0];
    if (c.dribbleSpin > 0 && palm && vDes[1] < -0.5) {
      const vhh = [vDes[0], 0, vDes[2]], fdir = len(vhh) > 0.3 ? norm(vhh) : norm([palm.y?.[0] || 0, 0, palm.y?.[2] || 1]);
      const r1 = this.rand() - 0.5, r2 = this.rand() - 0.5, r3 = this.rand() - 0.5;
      let ax = norm(cross(fdir, [0, 1, 0]));
      ax = norm(add(ax, [r1 * 0.5, r2 * 0.35, r3 * 0.5]));
      const k = c.hollowInertia ? 2 / 3 : 2 / 5, Iner = k * m * R * R;
      roll = sc(ax, c.dribbleSpin * (1 + c.dribbleSpinJitter * (this.rand() * 2 - 1)));
      this.ball.applyTorqueImpulse(O(sc(roll, Iner)), true);
    }
    // energy: a recorded bounce that loses nothing would leave the real ball short of the catch —
    // push down as hard as it takes to come back up to the catching hand on time
    vDes[1] = this.bounceMatch(vDes[1], I);
    vDes = this.catchMatch(vDes, I, Jt, pc);
    // contact prediction may bend the release to clear the body (a linear correction, not hand slip)
    if (this.lastSample) vDes = this.planRelease(vDes, this.lastSample, I);
    const dv = clampLen(sub(vDes, v0), c.maxCorrectionVel);
    // linear impulse + the friction impulse at the contact point: together the ball leaves at exactly vDes, spinning
    this.ball.applyImpulse(O(sub(sc(dv, m), Jt)), true);
    if (pc) this.ball.applyImpulseAtPoint(O(Jt), O(pc), true);
    this.lastRelease = { t: this.time, v: add(v0, dv), spinImpulse: Jt, hand: I?.hand };
    this.sinceRelease = 0; this.stats.releases++;
    if (I?.hand) { this.releasedBy = I.hand; this.gateFingers(I.hand, true); }
  }

  /**
   * Horizontal release velocity for a dribble: the ball must reach the catch point
   * (where the hand will be, the body's own motion included) when the catch is due.
   * The floor bounce is modelled: friction takes the contact slip out, so the
   * horizontal speed after it is v' = v − (v + ω×r)·k/(1+k) with k = I/(mR²),
   * ω the spin the release gives. Blended by cfg.catchMatch, capped by catchMatchMax.
   */
  catchMatch(vDes, I, Jt = null, pc = null) {
    const c = this.cfg, g = c.gravity, R = c.radius, m = c.mass, Tc = I?.catchIn, ct = I?.catchTarget;
    if (!(c.catchMatch > 0) || !ct || !(Tc > 0.12) || vDes[1] >= 0) return vDes;
    const x = this.pos, h = x[1] - R, v0 = -vDes[1];
    if (h < 0.05) return vDes;
    const t1 = (-v0 + Math.sqrt(v0 * v0 + 2 * g * h)) / g;
    if (!(t1 < Tc - 0.02)) return vDes;                        // no bounce before the catch
    const k = c.hollowInertia ? 2 / 3 : 2 / 5, Iner = k * m * R * R;
    let w = this.angvel;
    if (Jt && pc) w = add(w, sc(cross(sub(pc, x), Jt), 1 / Iner));
    const wr = cross(w, [0, -R, 0]), q = k / (1 + k), u = Tc - t1, A = t1 + u * (1 - q);
    const out = vDes.slice();
    const dv = [0, 0];
    for (const [i, a] of [[0, 0], [1, 2]]) dv[i] = (ct[a] - x[a] + wr[a] * q * u) / A - vDes[a];
    const l = Math.hypot(dv[0], dv[1]), cap = c.catchMatchMax, s = (l > cap ? cap / l : 1) * c.catchMatch;
    out[0] += dv[0] * s; out[2] += dv[1] * s;
    return out;
  }

  /**
   * Vertical release speed for a dribble: after one floor bounce (restitution e)
   * the ball must be back at the catch height when the catch is due. Returns
   * the (downward, negative) vy — never softer than asked, capped.
   */
  bounceMatch(vy, I) {
    const c = this.cfg, g = c.gravity, R = c.radius, e = (c.ballRestitution + c.courtRestitution) / 2;
    const y0 = this.pos[1], yc = I?.catchTarget?.[1], Tc = I?.catchIn;
    if (yc == null || !(Tc > 0.08) || vy >= 0 || y0 - R < 0.05) return vy;
    const heightAt = (v0) => {   // v0 > 0 = downward speed at release
      const h = y0 - R, t1 = (-v0 + Math.sqrt(v0 * v0 + 2 * g * h)) / g;
      if (t1 >= Tc) return -Infinity;                        // still falling at the catch
      const vUp = e * (v0 + g * t1), u = Tc - t1;
      return R + vUp * u - 0.5 * g * u * u;
    };
    const want = yc - 0.02;
    if (heightAt(-vy) >= want) return vy;                    // the recorded push already gets there
    let lo = -vy, hi = -vy + c.maxCorrectionVel;
    if (heightAt(hi) < want) return -hi;
    for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (heightAt(m) < want) lo = m; else hi = m; }
    this.stats.bounceBoosts = (this.stats.bounceBoosts || 0) + 1;
    return -hi;
  }

  /**
   * Contact prediction at a release: fly the ball ahead (gravity + the floor
   * bounce) against the body as it stands and, if the path would meet a leg or
   * the torso, take the smallest change of release velocity that clears it.
   * No clear path within ±0.8 m/s → the move's recorded path is physically
   * invalid here: logged, and the clearest path is used (never a clip).
   */
  planRelease(vDes, S, I) {
    const c = this.cfg, R = c.radius, g = c.gravity, e = (c.ballRestitution + c.courtRestitution) / 2;
    const T = clamp((I?.catchIn ?? 0.5) + 0.05, 0.2, 0.9);
    const x0 = this.pos;
    const shapes = Object.entries(S.caps).filter(([n]) => /thigh|shin|foot/.test(n));
    const boxes = Object.entries(S.boxes);
    const catchP = I?.catchTarget || null, Tc = I?.catchIn ?? null;
    const shift = typeof I?.bodyShift === 'function' ? I.bodyShift : null;
    // fly the ball: worst clearance to the legs / torso, and where it is at the expected catch
    const fly = (v) => {
      let p = x0.slice(), vv = v.slice(), worst = Infinity, atCatch = null;
      for (let t = 0; t < T; t += 0.01) {
        vv[1] -= g * 0.01; p = add(p, sc(vv, 0.01));
        if (p[1] < R + this.floorY) { p[1] = R + this.floorY; vv[1] = -vv[1] * e; }
        // the body moves on meanwhile: each limb with its own velocity for a short look-ahead
        // (a swinging leg turns back soon after), then with the root motion
        const tf = t + 0.01, tl = Math.min(tf, c.planLimbHorizon);
        const pb = shift ? sub(p, sub(shift(tf), shift(tl))) : p;
        for (const [n, s] of shapes) {
          const pv = this.partVel?.[n];
          const a = pv ? add(s.a, sc(pv.a, tl)) : s.a, b = pv ? add(s.b, sc(pv.b, tl)) : s.b;
          const { q } = closestOnSeg(pb, a, b); worst = Math.min(worst, len(sub(pb, q)) - s.r - R);
        }
        for (const [n, b] of boxes) { const pv = this.partVel?.[n]; worst = Math.min(worst, sdBox(pb, pv ? add(b.c, sc(pv.c, tl)) : b.c, b.q, b.h).d - R); }
        if (Tc != null && !atCatch && t >= Tc) atCatch = p.slice();
      }
      return { cl: worst, miss: catchP && atCatch ? len(sub(atCatch, catchP)) : 0 };
    };
    const base = fly(vDes);
    this.lastPlan = { clearance: base.cl, changed: false };
    if (base.cl >= c.planMargin) return vDes;
    // smallest change that clears the body AND still arrives where the catching hand will be
    let best = null;
    const search = (span, step, dys) => {
      for (let dx = -span; dx <= span + 1e-3; dx += step) for (let dz = -span; dz <= span + 1e-3; dz += step) for (const dy of dys) {
        if (!dx && !dz && !dy) continue;
        const cand = add(vDes, [dx, dy, dz]), f = fly(cand), cl = f.cl, cost = Math.hypot(dx, dy, dz) + 4 * f.miss;
        const ok = cl >= c.planMargin;
        if (!best || (ok && (!best.ok || cost < best.cost)) || (!ok && !best.ok && cl > best.cl)) best = { v: cand, cl, cost, ok, miss: f.miss };
      }
    };
    search(0.8, 0.2, [0, -0.6, 0.6]);
    if (!best.ok) search(1.6, 0.4, [0, -1.2, -0.6, 0.6]);   // a tight move: a harder redirect before giving up
    if (best.ok && best.miss > c.catchDist + c.ikMax) best.ok = false; // it clears, but no hand could take it (even reaching): invalid all the same
    this.lastPlan = { clearance: base.cl, changed: true, newClearance: best.cl, dv: best.cost, catchMiss: best.miss };
    if (!best.ok) {
      const w = { t: +this.time.toFixed(3), invalidPath: true, needCm: +((c.planMargin - best.cl) * 100).toFixed(1), catchMissCm: +(best.miss * 100).toFixed(0), event: I?.event || null };
      this.stats.invalidPaths = (this.stats.invalidPaths || 0) + 1; this.warnings.push(w); if (this.warnings.length > 20) this.warnings.shift();
    }
    return best.v;
  }

  physicalState(onFloor, touchingBody, v) {
    if (onFloor) this.state = Math.hypot(v[0], v[1], v[2]) < 0.08 ? 'FREE' : 'FLOOR_CONTACT';
    else if (touchingBody) this.state = 'BODY_CONTACT';
    else if (this.time - this.lastFloorAt < 1.2 && v[1] > 0) this.state = 'BOUNCE_RISING';
    else this.state = 'AIRBORNE';
  }

  /**
   * What the contact IK should do with the hands this frame (after step/advance):
   * the controlling hand conforms to the ball in contact, eases in while it
   * approaches, and — when a catch is due but the ball would be missed —
   * reaches for it (≤ ikCatchMax, ramped in over ~0.1 s). The IK moves the hand,
   * never the ball; the colliders are built from the corrected pose.
   */
  ikControl(body) {
    const c = this.cfg, st = this.state, hand = this.hand;
    if (!hand || !body?.palms?.[hand]) return null;
    const pt = this.palmTarget(body.palms[hand]), d = len(sub(pt, this.cur.p));
    let w = 0, reach = false;
    if (st === 'HAND_CONTACT' || st === 'POSSESSION_CONTROL') w = 1;
    else if (st === 'HAND_APPROACH') w = Math.max(0, 1 - d / c.catchDist);
    else if (st === 'HAND_RELEASE') w = 0.5;
    if ((this.ctl?.mode === 'loose' || this.ctl?.mode === 'rescue') && d < c.ikCatchMax + c.catchDist) reach = true;
    const now = this.time, dt = Math.min(0.1, now - (this._ikT ?? now)); this._ikT = now;
    this._reachW = clamp((this._reachW || 0) + (reach ? 1 : -1) * dt / 0.1, 0, 1);
    const out = { hand, weight: Math.max(w, this._reachW), grip: w > 0.5 };
    if (this._reachW > 0) { out.reachMax = c.ikMax + (c.ikCatchMax - c.ikMax) * this._reachW; out.reachLimit = c.ikCatchMax + c.catchDist; }
    if (this.ctl?.mode === 'two-hand') { out.other = hand === 'left' ? 'right' : 'left'; out.otherWeight = w; }
    return out;
  }

  /** Signed distance of the ball to every part; overlaps deeper than the tolerance are logged. */
  checkPenetration(S) {
    const c = this.cfg, x = this.cur.p, R = c.radius;
    let worst = null;
    const test = (name, d, q) => { if (!worst || d < worst.d) worst = { name, d, q }; };
    for (const [name, s] of Object.entries(S.caps)) {
      if (this.parts.get(name)?.col.isEnabled() === false) continue; // opened fingers of a releasing hand
      const { q } = closestOnSeg(x, s.a, s.b); test(name, len(sub(x, q)) - s.r - R, q);
    }
    for (const [name, s] of Object.entries(S.boxes)) { const r = sdBox(x, s.c, s.q, s.h); test(name, r.d - R, r.q); }
    for (const [side, s] of Object.entries(S.palms)) { const r = sdBox(x, s.c, s.q, s.h); test(`palm_${side[0]}`, r.d - R, r.q); }
    test('floor', x[1] - this.floorY - R, [x[0], this.floorY, x[2]]);
    this.nearest = worst;
    if (worst && -worst.d > this.stats.maxPenetration) this.stats.maxPenetration = -worst.d;
    if (worst && -worst.d > c.penetrationTol) {
      const w = { t: +this.time.toFixed(3), collider: worst.name, depth: +(-worst.d).toFixed(4), normal: norm(sub(x, worst.q)).map((a) => +a.toFixed(3)), state: this.state };
      this.stats.penetrations.push(w); if (this.stats.penetrations.length > 50) this.stats.penetrations.shift();
      this.warnings.push(w); if (this.warnings.length > 20) this.warnings.shift();
    }
  }

  /**
   * Legs make room: when the ball is about to meet a thigh or shin (predicted a
   * short time ahead from its ballistic path), the knee moves out of its way by
   * the needed clearance (bounded, eased), hip and ankle fixed; it eases back
   * once the ball has passed. The renderer bends the mesh leg the same way.
   */
  updateLegYield(S, I, h) {
    const c = this.cfg;
    if (!c.legYield) { this.legYield = { left: [0, 0, 0], right: [0, 0, 0] }; return; }
    const x = this.cur.p, v = this.cur.v, R = c.radius, g = c.gravity;
    const pts = [x];
    for (const t of [0.03, 0.06, c.predictHorizon]) pts.push([x[0] + v[0] * t, Math.max(R, x[1] + v[1] * t - 0.5 * g * t * t), x[2] + v[2] * t]);
    for (const side of ['left', 'right']) {
      let need = [0, 0, 0];
      for (const name of LEG_PARTS[side]) {
        const s = S.caps[name];
        if (!s) continue;
        for (const p of pts) {
          const { q, t } = closestOnSeg(p, s.a, s.b);
          const d = len(sub(p, q)) - s.r - R;
          if (d < c.contactMargin) {
            let dir = sub(q, p); dir[1] = 0; dir = norm(dir);
            // the knee end moves; along the shin/thigh the displacement falls off toward the fixed end
            const lever = name.startsWith('thigh') ? Math.max(0.2, t) : Math.max(0.2, 1 - t);
            const cand = sc(dir, (c.contactMargin - d) / lever);
            if (len(cand) > len(need)) need = cand;
          }
        }
      }
      need = clampLen(need, c.legYieldMax);
      const k = 1 - Math.exp(-c.legYieldRate * h);
      const y = this.legYield[side];
      this.legYield[side] = clampLen(lerp(y, need, len(need) > len(y) ? Math.min(1, k * 2) : k), c.legYieldMax);
    }
    void I;
  }

  /** Hand ↔ ball contact bookkeeping (a dribble has to separate every cycle). */
  trackSeparation(S, h) {
    const handTouch = [...this.touching].some((n) => /^palm|^(thumb|index|middle|ring|pinky)/.test(n));
    let gap = Infinity;
    for (const side of ['left', 'right']) { const p = S.palms[side]; if (p) { const r = sdBox(this.cur.p, p.c, p.q, p.h); gap = Math.min(gap, r.d - this.cfg.radius); } }
    this.handGap = gap;
    if (handTouch || gap < 0.004) this.stats.handContactTime += h; else this.stats.separatedTime += h;
  }

  /**
   * Advance one rendered frame: fixed steps with the body and intent
   * interpolated across the frame. Returns the render interpolation alpha.
   */
  advance(dt, S0, S1, I0, I1) {
    const c = this.cfg;
    const acc0 = this.acc;
    this.acc += dt;
    let n = 0, done = 0, h = 1 / c.hz;
    const cap = c.maxSubsteps * Math.max(1, Math.round(c.hzFast / c.hz));
    for (;;) {
      // the step size follows the ball: fast → the fast rate (no tunnelling, shallow impacts)
      h = len(this.cur.v) / c.hz > c.fastStepDist ? 1 / Math.max(c.hz, c.hzFast) : 1 / c.hz;
      if (this.acc < h || n >= cap) break;
      this.acc -= h; n++; done += h;
      const tau = dt > 0 ? clamp((done - acc0) / dt, 0, 1) : 1;
      this.step(h, S1 ? lerpSample(S0 || S1, S1, tau) : null, lerpIntent(I0, I1, tau));
    }
    if (n >= cap) this.acc = 0;
    this._hzAcc = (this._hzAcc || 0) + n; this._hzT = (this._hzT || 0) + dt;
    if (this._hzT > 0.5) { this.stats.stepHz = Math.round(this._hzAcc / this._hzT); this._hzAcc = 0; this._hzT = 0; }
    this.lastH = h;
    return clamp(this.acc / h, 0, 1);
  }

  /** Ball ↔ part contact points and normals (debug). */
  contacts() {
    const out = [];
    for (const [name, p] of this.parts) {
      if (!this.touching.has(name)) continue;
      this.world.contactPair(this.ballCol, p.col, (man, flipped) => {
        const n = V(man.normal()), nn = flipped ? n : sc(n, -1);
        for (let i = 0; i < man.numSolverContacts(); i++) out.push({ name, p: V(man.solverContactPoint(i)), n: nn });
      });
    }
    if (this.touching.has('floor')) out.push({ name: 'floor', p: [this.cur.p[0], this.floorY, this.cur.p[2]], n: [0, 1, 0] });
    return out;
  }

  dispose() { this.world.free(); this.queue.free?.(); }
}
