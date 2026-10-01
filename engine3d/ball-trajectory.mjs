/**
 * BallTrajectorySolver — deterministic ball paths between contacts (docs/ball-contact-system.md).
 *
 * A segment runs from a start (position, velocity, time) to a target (position, time):
 *   vertical   exact ballistic under gravity through both end points
 *   horizontal constant velocity through both end points
 *   + a cubic start correction  Δv0 · τ(1 − τ/T)²   (the start velocity = the hand's; ends kept)
 *   + a cubic end correction    Δv1 · τ²(τ − T)/T²  (the arrival velocity blended toward the hand's)
 * so the path is C1 at a release / catch, lands exactly on its target at exactly its time and is
 * otherwise the physical arc. Position, velocity and rotation are closed-form functions of time:
 * the same at 30, 60 or 120 fps, and a segment is a few numbers (networkable).
 *
 * Engine-agnostic (no three.js); runs in the browser and in Node. Units: metres, seconds, y up.
 */

export const G = 9.81;
export const REST_TARGET = 0.78;             // believable dribble restitution (ball on hardwood ≈ 0.75–0.85)
export const REST_RANGE = [0.55, 0.95];

// ── vectors (arrays) ──
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const finite3 = (a) => !!a && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

// ── quaternions [x, y, z, w] ──
export function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export function qnorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
/** Rotation by angular velocity w (rad/s) over dt seconds. */
export function qexp(w, dt) {
  const a = len(w) * dt;
  if (a < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(a / 2) / (len(w) || 1);
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
}
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
}
/** Quaternion from an orthonormal basis (columns x, y, z). */
export function quatFromBasis(x, y, z) {
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
  return qnorm(q);
}

/** Angular velocity of a ball rolling (no slip) on the floor at horizontal velocity v. */
export const rollingSpin = (v, R) => sc(cross([0, 1, 0], [v[0], 0, v[2]]), 1 / R);

// ── segments ──
/**
 * Solve one segment.
 * @param {object} o
 *   t0, p0      start time / position
 *   v0          start velocity to match (null: the arc's own)
 *   t1, p1      target time / position
 *   v1          velocity to blend the arrival toward (null: none) — matchEnd (0..1) of the way
 *   g, floorY, R
 *   w, q0       angular velocity (rad/s, constant over the segment) and orientation at t0
 *   kind        'down' (hand → floor) | 'up' (floor → hand) | 'toss' (hand → hand) | 'pass'
 * @returns {object} segment (plain data: evaluate with segPos / segVel / segRot)
 */
export function solveSegment({ t0, p0, v0 = null, t1, p1, v1 = null, matchEnd = 0.5, g = G, floorY = 0, R = 0.12, w = [0, 0, 0], q0 = [0, 0, 0, 1], kind = 'toss' }) {
  const T = Math.max(1e-3, t1 - t0);
  const vLin = [(p1[0] - p0[0]) / T, (p1[1] - p0[1] + 0.5 * g * T * T) / T, (p1[2] - p0[2]) / T];
  const baseVel = (tau) => [vLin[0], vLin[1] - g * tau, vLin[2]];
  let dv0 = v0 && finite3(v0) ? sub(v0, baseVel(0)) : [0, 0, 0];
  let dv1 = v1 && finite3(v1) ? sc(sub(v1, baseVel(T)), clamp(matchEnd, 0, 1)) : [0, 0, 0];
  // corrections are bounded (a hand can't turn a ball around in a segment) …
  const cap = (v, m) => { const l = len(v); return l > m ? sc(v, m / l) : v; };
  dv0 = cap(dv0, 6); dv1 = cap(dv1, 4);
  const seg = { t0, t1, T, p0: p0.slice(), p1: p1.slice(), vLin, g, dv0, dv1, w: w.slice(), q0: q0.slice(), kind, floorY, R };
  // … and never take the ball below the floor: scale the vertical corrections down until clear
  const floor = floorY + R - 1e-4;
  const below = () => { for (let k = 1; k < 32; k++) if (segPos(seg, t0 + (T * k) / 32)[1] < floor) return true; return false; };
  if (below()) {
    let lo = 0, hi = 1;
    const y0 = seg.dv0[1], y1 = seg.dv1[1];
    for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; seg.dv0[1] = y0 * m; seg.dv1[1] = y1 * m; if (below()) hi = m; else lo = m; }
    seg.dv0[1] = y0 * lo; seg.dv1[1] = y1 * lo;
    seg.floorClamped = true;
  }
  return seg;
}

/** Position of a segment at time t (clamped to its span). */
export function segPos(s, t) {
  const tau = clamp(t - s.t0, 0, s.T), T = s.T, u = tau / T;
  const c0 = tau * (1 - u) * (1 - u), c1 = (tau * tau * (tau - T)) / (T * T);
  return [
    s.p0[0] + s.vLin[0] * tau + s.dv0[0] * c0 + s.dv1[0] * c1,
    s.p0[1] + s.vLin[1] * tau - 0.5 * s.g * tau * tau + s.dv0[1] * c0 + s.dv1[1] * c1,
    s.p0[2] + s.vLin[2] * tau + s.dv0[2] * c0 + s.dv1[2] * c1,
  ];
}
/** Velocity of a segment at time t. */
export function segVel(s, t) {
  const tau = clamp(t - s.t0, 0, s.T), T = s.T, u = tau / T;
  const d0 = (1 - u) * (1 - 3 * u), d1 = (3 * tau * tau - 2 * T * tau) / (T * T);
  return [s.vLin[0] + s.dv0[0] * d0 + s.dv1[0] * d1, s.vLin[1] - s.g * tau + s.dv0[1] * d0 + s.dv1[1] * d1, s.vLin[2] + s.dv0[2] * d0 + s.dv1[2] * d1];
}
/** Orientation of a segment at time t (closed form: constant spin from q0). */
export function segRot(s, t) { return qnorm(qmul(qexp(s.w, clamp(t - s.t0, 0, s.T)), s.q0)); }
/** Lowest ball-centre height over the segment (for checks). */
export function segMinY(s, n = 48) { let m = Infinity; for (let k = 0; k <= n; k++) m = Math.min(m, segPos(s, s.t0 + (s.T * k) / n)[1]); return m; }

/**
 * Re-solve a segment from where the ball is NOW (position + velocity at t) to a moved target:
 * position and velocity stay continuous, only the rest of the path bends (the target moved
 * because the player moved or the hand's predicted pose changed).
 */
export function retarget(s, t, p1, t1 = s.t1, opts = {}) {
  if (t >= t1 - 1e-3) return s;
  const p = segPos(s, t), v = segVel(s, t);
  return solveSegment({ t0: t, p0: p, v0: v, t1, p1, v1: opts.v1 ?? null, matchEnd: opts.matchEnd ?? 0.5, g: s.g, floorY: s.floorY, R: s.R, w: s.w, q0: segRot(s, t), kind: s.kind });
}

/**
 * A dribble flight: release (hand) → bounce (floor target) → catch (hand target), with the
 * bounce time chosen inside its window so the bounce looks physical (implied restitution close
 * to REST_TARGET, never above 1). Returns { down, up, tb, restitution }.
 * @param {object} o
 *   tr, pr, vr      release time / ball position / hand velocity
 *   tb, tbWindow    authored bounce time and its window [t0, t1]
 *   pb              bounce target (x, z used; y is set to the floor contact)
 *   tc, pc, vc      catch time / hand target / hand velocity at the catch
 *   w0, q0          spin and orientation at the release
 */
export function planDribble({ tr, trPlan = tr, prPlan = null, pr, vr, tb, tbWindow = null, pb, tc, pc, vc = null, g = G, floorY = 0, R = 0.12, w0 = [0, 0, 0], q0 = [0, 0, 0, 1], matchEnd = 0.5 }) {
  // (the bounce time is chosen for the release's exact event time trPlan — the same at any frame
  // rate — and the down arc is then solved from the tick it is released on, tr)
  const yb = floorY + R;
  const bounceAt = [pb[0], yb, pb[2]];
  const lo = Math.max(trPlan + 0.04, tbWindow ? tbWindow[0] : tb), hi = Math.min(tc - 0.04, tbWindow ? tbWindow[1] : tb);
  const cands = [];
  if (hi <= lo) cands.push(clamp(tb, trPlan + 0.04, tc - 0.04));
  else for (let k = 0; k <= 10; k++) cands.push(lo + ((hi - lo) * k) / 10);
  let best = null;
  for (const t of cands) {
    const Td = t - trPlan, Tu = tc - t;
    if (Td <= 0.02 || Tu <= 0.02) continue;
    const down = solveSegment({ t0: trPlan, p0: prPlan || pr, v0: vr, t1: t, p1: bounceAt, g, floorY, R, w: w0, q0, kind: 'down' });
    const vin = segVel(down, t);
    const vyOut = (pc[1] - yb + 0.5 * g * Tu * Tu) / Tu;
    const e = vyOut / Math.max(1e-3, -vin[1]);
    // believable bounce (restitution ≈ 0.78, never > 1), a hand can't pound the ball faster than
    // ~8.5 m/s, and the authored bounce time is preferred
    const sp = Math.hypot(vin[0], vin[1], vin[2]);
    const cost = (e - REST_TARGET) ** 2 + (e > 1 ? 4 * (e - 1) ** 2 : 0) + 0.02 * Math.max(0, sp - 8.5) ** 2 + 0.3 * ((t - tb) / Math.max(0.02, (hi - lo) / 2 || 0.02)) ** 2 * 0.05 + (vin[1] > -0.3 ? 5 : 0);
    if (!best || cost < best.cost) best = { cost, t, down, vin, e };
  }
  if (!best) return null;
  const t = Math.max(best.t, tr + 0.03);
  if (trPlan !== tr || t !== best.t) { best.down = solveSegment({ t0: tr, p0: pr, v0: vr, t1: t, p1: bounceAt, g, floorY, R, w: w0, q0, kind: 'down' }); best.vin = segVel(best.down, t); }
  // bounce: vertical from the up arc, spin half-way toward rolling on the floor
  const vHin = [best.vin[0], 0, best.vin[2]];
  const wUp = add(sc(w0, 0.5), sc(rollingSpin(vHin, R), 0.5));
  const qb = segRot(best.down, t);
  const up = solveSegment({ t0: t, p0: bounceAt, v0: null, t1: tc, p1: pc, v1: vc, matchEnd, g, floorY, R, w: wUp, q0: qb, kind: 'up' });
  return { down: best.down, up, tb: t, restitution: best.e, vin: best.vin, vout: segVel(up, t) };
}

/**
 * Where a ball that goes from one side of the feet to the other crosses between them (x, z): the hands' path
 * (release A → catch B, on the floor) through the gate between the feet's centres, inside it (≥ 12 % of the stance
 * from either foot). null: the path does not pass between the legs.
 * @returns {{ p: number[], s: number, u: number, d: number[], n: number[] } | null}  p on the floor plane [x, z]; s along
 *   A → B; u along left → right foot; d the feet line's direction, n its normal (unit, [x, z])
 */
export function gateCrossing(A, B, feet) {
  if (!feet?.l || !feet?.r) return null;
  const a = [A[0], A[2]], ab = [B[0] - A[0], B[2] - A[2]], L = feet.l, fr = [feet.r[0] - L[0], feet.r[1] - L[1]];
  const den = ab[0] * fr[1] - ab[1] * fr[0], w = Math.hypot(fr[0], fr[1]);
  if (Math.abs(den) < 1e-9 || w < 0.12 || Math.hypot(ab[0], ab[1]) < 0.08) return null;
  const qa = [L[0] - a[0], L[1] - a[1]];
  const s = (qa[0] * fr[1] - qa[1] * fr[0]) / den, u = (qa[0] * ab[1] - qa[1] * ab[0]) / den;
  if (s <= 0 || s >= 1 || u < 0.12 || u > 0.88) return null;
  const d = [fr[0] / w, fr[1] / w], n = [-d[1], d[0]];
  let p = [a[0] + ab[0] * s, a[1] + ab[1] * s];
  // under the hips (feet.h: the hips' centre on the floor): the point of the hands' path nearest under them, when it
  // is still between the feet
  if (feet.h) {
    const l2 = ab[0] * ab[0] + ab[1] * ab[1], sh = clamp(((feet.h[0] - a[0]) * ab[0] + (feet.h[1] - a[1]) * ab[1]) / l2, 0.05, 0.95);
    const q = [a[0] + ab[0] * sh, a[1] + ab[1] * sh], uq = ((q[0] - L[0]) * d[0] + (q[1] - L[1]) * d[1]) / w;
    if (uq >= 0.12 && uq <= 0.88) p = q;
  }
  return { p, s, u, d, n, width: w, onFeetLine: [a[0] + ab[0] * s, a[1] + ab[1] * s] };
}

export const BOUNCE_PLAN = Object.freeze({
  rest: 0.78, restRange: [0.55, 0.95],   // a believable bounce
  keep: 0.8,                              // horizontal speed kept through the bounce (friction takes some, it never turns back)
  maxImpact: 8.5,                         // m/s: harder than this into the floor reads as a slam
  reach: 0.3, step: 0.02,                 // m: the spots tried around the motion's spot
  times: 13,                              // bounce times tried in the window
  margin: 0.01,                           // m: the flight's clearance of the body …
  contactMargin: 0.005,                   // m: … the contact's own flight is kept down to this
  spotMargin: 0.02,                       // m: … and of its floor contact (by the feet: a foot planting or lifting is the least sure)
  skipNear: 0.03,                         // m: … this close to the release / catch point the ball is on the hand (not a flight) …
  nearHand: 0.08, marginNear: 0.004,      // … and within nearHand of it the margin tapers to marginNear (a hand at a knee: the ball arrives along its skin)
  handForced: 0.2,                        // m: near a hand whose own ball is in the body, the ball may be that deep, tapering over this
  checks: 28,                             // flights checked against the body, at most (a failing one stops at its first contact) …
  repairs: 4,                             // … each best spot moved this many times away from where its flight touched the body
  deficitCost: 8,                         // none clear: each metre short of the margin costs this much (1 cm ≈ a 0.08 cost)
  better: 0.1,                            // a flight re-planned for its physics replaces the contact's own only when it scores this much better
                                          // (a 1.06 restitution the motion's dribble clock forces is not worth a different catch)
});
/**
 * The bounce of a hand → floor → hand flight, chosen from the motion (docs/ball-contact-system.md → TRAJECTORY MODEL →
 * the floor contact): WHERE the ball meets the floor and WHEN (inside the contact's window), so that
 *   - the flight is physical: gravity, the releasing hand's own velocity (a push down is fine), a believable
 *     restitution, the horizontal speed kept through the bounce (some lost to friction, never turned back);
 *   - it lands where the motion puts it — a ball whose path goes from one side of the feet to the other passes
 *     between the legs: it bounces in that gate, under the hips, on the line from the releasing hand to the catching
 *     one (gateCrossing); any other on the contact's own spot (the capture's, weighed by its confidence);
 *   - the whole flight stays clear of the body (o.clearAt(t, p): the ball's clearance at game time t, the body as it
 *     will be then) — the best-ranked candidates are solved (planDribble) and checked, the first clear one wins (none:
 *     the clearest);
 * and at the bounce time the ball's centre is exactly floorY + R there (planDribble).
 * o: tr, trPlan, pr, prPlan, vr, tb, tbWindow, pb (the contact's spot), conf, tc, pc, vc, g, floorY, R, w0, q0, matchEnd,
 *    feetAt?(t) → { l: [x, z], r: [x, z] }, clearAt?(t, p) → m, cfg? (BOUNCE_PLAN overrides)
 * @returns planDribble's result + { pb, gate, clearance, cost, checked, why }   (null: no flight possible)
 */
export function planBounce(o) {
  const c = { ...BOUNCE_PLAN, ...(o.cfg || {}) };
  const { tr, trPlan = tr, pr, prPlan = null, vr, tc, pc, vc = null, g = G, floorY = 0, R = 0.12, w0 = [0, 0, 0], q0 = [0, 0, 0, 1], matchEnd = 0.5 } = o;
  const p0 = prPlan || pr, yb = floorY + R, v0 = vr && finite3(vr) ? vr : [0, 0, 0];
  const lo = Math.max(trPlan + 0.04, o.tbWindow ? o.tbWindow[0] : o.tb), hi = Math.min(tc - 0.04, o.tbWindow ? o.tbWindow[1] : o.tb);
  const tb0 = clamp(o.tb, trPlan + 0.04, tc - 0.04), hw = Math.max(0.02, (hi - lo) / 2);
  const times = hi <= lo ? [tb0] : Array.from({ length: c.times }, (_, k) => lo + ((hi - lo) * k) / (c.times - 1));
  // the motion's spot: between the legs (the hands' path through the gate between the feet), else the contact's
  const feet = o.feetAt ? o.feetAt(clamp(tb0, lo, Math.max(lo, hi))) : null;
  const gate = gateCrossing(p0, pc, feet);
  if (o.debug) o.debug.push({ feet, gate, prior: o.pb, p0, pc, lo, hi });
  const prior = gate ? gate.p : [o.pb[0], o.pb[2]], conf = gate ? 1 : clamp(o.conf ?? 0.6, 0.2, 1);
  // the cost of a bounce at (tb, x, z): its physics, how far it is from the motion's spot, the gate
  const slice = (tb) => {
    const Td = tb - trPlan, Tu = tc - tb;
    if (Td <= 0.02 || Tu <= 0.02) return null;
    const vy0 = (yb - p0[1] + 0.5 * g * Td * Td) / Td, vinY = vy0 - g * Td, uy = (pc[1] - yb + 0.5 * g * Tu * Tu) / Tu;
    if (vinY > -0.5) return null;
    const e = uy / -vinY;
    if (!(e > 0)) return null;
    const costE = (e - c.rest) ** 2 + 4 * Math.max(0, e - c.restRange[1]) ** 2 + 4 * Math.max(0, c.restRange[0] - e) ** 2;
    const ft = gate && o.feetAt ? o.feetAt(tb) : null;
    return { tb, Td, Tu, vy0, vinY, e, base: costE + 0.004 * ((tb - o.tb) / hw) ** 2, fg: ft ? gateFrame(ft) : null };
  };
  const costOf = (S, x, z) => {
    const { Td, Tu, vy0, vinY } = S;
    const vx = (x - p0[0]) / Td, vz = (z - p0[2]) / Td, ux = (pc[0] - x) / Tu, uz = (pc[2] - z) / Tu;
    // horizontal: kept through the bounce (along the way in, a little lost; never turned back, not much sideways)
    const s = Math.hypot(vx, vz);
    let costH;
    if (s > 0.25) { const u = (ux * vx + uz * vz) / s, wx = ux - (u * vx) / s, wz = uz - (u * vz) / s; costH = 0.002 * (u - c.keep * s) ** 2 + 0.01 * Math.min(0, u) ** 2 + 0.01 * Math.max(0, u - 1.05 * s) ** 2 + 0.004 * (wx * wx + wz * wz); }
    else costH = 0.003 * (ux * ux + uz * uz);
    // the release: the hand's own motion — sideways it carries the ball, down it may push it harder
    const dy = vy0 - v0[1];
    const costL = 0.003 * ((vx - v0[0]) ** 2 + (vz - v0[2]) ** 2) + 0.003 * Math.max(0, dy) ** 2 + 0.002 * Math.max(0, -dy - 4) ** 2;
    const sp = Math.hypot(vx, vinY, vz), costV = 0.01 * Math.max(0, sp - c.maxImpact) ** 2;
    const costP = 4 * conf * ((x - prior[0]) ** 2 + (z - prior[1]) ** 2);   // (10 cm off it: 0.04 × conf)
    // between the legs: inside the gate between the feet at that moment
    let costG = 0;
    if (S.fg) { const uu = ((x - S.fg.L[0]) * S.fg.d[0] + (z - S.fg.L[1]) * S.fg.d[1]) / S.fg.w; costG = 0.05 * ((Math.max(0, 0.18 - uu) + Math.max(0, uu - 0.82)) / 0.1) ** 2; }
    return S.base + costH + costL + costV + costP + costG;
  };
  // the best spot of each bounce time (a grid around the motion's spot)
  const n = Math.round(c.reach / c.step), starts = [];
  for (const tb of times) {
    const S = slice(tb);
    if (!S) continue;
    let best = null;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = prior[0] + i * c.step, z = prior[1] + j * c.step, cost = costOf(S, x, z);
      if (!best || cost < best.cost) best = { S, tb, x, z, cost };
    }
    if (best) starts.push(best);
  }
  if (!starts.length) return null;
  starts.sort((a, b) => a.cost - b.cost);
  const solve = (k) => {
    const pl = planDribble({ tr, trPlan, prPlan, pr, vr, tb: k.tb, tbWindow: null, pb: [k.x, yb, k.z], tc, pc, vc, g, floorY, R, w0, q0, matchEnd });
    return pl ? { ...pl, pb: [k.x, yb, k.z] } : null;
  };
  const done = (pl, k, extra) => ({ ...pl, gate: !!gate, cost: k.cost, ...extra });
  if (!o.clearAt) { const pl = solve(starts[0]); return pl && done(pl, starts[0], { clearance: null, checked: 0, why: gate ? 'gate' : 'spot' }); }
  // clear of the body: from the best spots (best first), each repaired a few times — a flight that touches the body
  // moves its bounce away from where it touched (by how much the bounce moves the ball there); the first clear one wins
  const h = 1 / 120;
  // (the clearance is measured against the margin it needs there: the full margin in the air, tapering to marginNear
  // within nearHand of the hand that lets go / catches — returned as clearance − need + margin, so ≥ margin = clear)
  // (… and where a hand itself holds the ball in the body — the capture's hand at a shin, behind a calf — the ball near
  // it may be as deep as on it, tapering to the full margin handForced m away: no bounce makes that clear)
  const onHand = { r: Math.min(c.margin, o.clearAt(tr, pr)), c: Math.min(c.margin, o.clearAt(tc, pc)) };
  const forced = (d, c0) => (c0 >= c.margin ? c.margin : c0 + (c.margin - c0) * clamp((d - c.skipNear) / Math.max(1e-6, c.handForced - c.skipNear), 0, 1));
  const needAt = (p) => {
    const dr = len(sub(p, pr)), dc = len(sub(p, pc)), d = Math.min(dr, dc);
    return Math.min(c.marginNear + (c.margin - c.marginNear) * clamp((d - c.skipNear) / Math.max(1e-6, c.nearHand - c.skipNear), 0, 1), forced(dr, onHand.r), forced(dc, onHand.c));
  };
  const near = {};
  const clearance = (pl, stop = -Infinity) => {
    // (the floor contact is drawn on the tick nearest the bounce — up to half a frame either side of it: the spot is
    // checked against the body over ±1/60 s, a 30 fps tick's reach)
    let m = Infinity, w = null;
    for (const dt of [0, -1 / 60, 1 / 60, -1 / 120, 1 / 120]) {
      // (the feet are where the body's prediction is least sure — a foot planting or lifting: the spot keeps spotMargin)
      const x = o.clearAt(clamp(pl.tb + dt, tr, tc), pl.pb, near) - Math.max(c.spotMargin, needAt(pl.pb)) + c.margin;
      if (x < m) { m = x; w = { t: pl.tb + dt, p: pl.pb, q: near.q }; }
      if (m < stop) return { m, w };
    }
    if (m >= stop) for (let t = tr; t <= tc + 1e-9; t += h) {
      const p = t <= pl.tb ? segPos(pl.down, t) : segPos(pl.up, t);
      if (len(sub(p, pr)) < c.skipNear || len(sub(p, pc)) < c.skipNear) continue;
      const x = o.clearAt(t, p, near) - needAt(p) + c.margin;
      if (x < m) { m = x; w = { t, p, q: near.q }; }
      if (m < stop) break;
    }
    return { m, w };
  };
  // the contact's own flight first (its spot, its time chosen in its window — as authored): kept exactly when it is
  // physical (a believable restitution, not a slam), lands in the gate when the hands' path goes between the legs, and
  // is clear of the body — only a flight that fails one of those is planned anew
  const pbA = o.pbContact || o.pb;
  const A = pbA && planDribble({ tr, trPlan, prPlan, pr, vr, tb: o.tb, tbWindow: o.tbWindow, pb: pbA, tc, pc, vc, g, floorY, R, w0, q0, matchEnd });
  let whyNot = null;
  if (A) {
    A.pb = [pbA[0], yb, pbA[2]];
    const vin = Math.hypot(...A.vin), fg = gate && o.feetAt ? gateFrame(o.feetAt(A.tb)) : null;
    const inGate = !fg || (() => { const uu = ((pbA[0] - fg.L[0]) * fg.d[0] + (pbA[2] - fg.L[1]) * fg.d[1]) / fg.w, off = Math.abs((pbA[0] - fg.L[0]) * fg.d[1] - (pbA[2] - fg.L[1]) * fg.d[0]); return uu >= 0.18 && uu <= 0.82 && off <= 0.12; })();
    whyNot = !(A.restitution >= c.restRange[0] && A.restitution <= c.restRange[1]) ? `restitution ${A.restitution.toFixed(2)}` : vin > c.maxImpact * 1.15 ? `${vin.toFixed(1)} m/s into the floor` : !inGate ? 'not between the feet' : null;
    // (the dribble layer — a loop whose catch frames are built to meet its own bounces — keeps its tempo: a restitution
    // its dribble clock forces is not re-timed; only a move's flights are)
    if (whyNot && inGate && (o.trust ?? 1) < 1) whyNot = null;
    if (!whyNot) {
      // (the contact's own flight keeps its place a little closer to the body than a new one is put: contactMargin)
      const { m } = clearance(A);
      A.clear = m;
      if (m >= c.contactMargin) return { ...A, gate: !!gate, cost: 0, clearance: m, checked: 1, why: 'contact' };
      whyNot = `${(m * 100).toFixed(1)} cm from the body`;
    }
  }
  // a re-plan starts from the contact's own flight — its time, its spot — and moves it (the same flight at any frame
  // rate, near the motion's). Only its clearance failed: its time stays (the spot moves), and a move that does not
  // clear it by ≥ 3 mm more keeps it as it was. Its physics or the gate failed: every time of the window is tried.
  const onlyClear = !!A && A.clear != null;
  if (A && !gate) {
    const S = slice(A.tb);
    if (S) { if (onlyClear) starts.length = 0; starts.unshift({ S, tb: A.tb, x: pbA[0], z: pbA[2], cost: costOf(S, pbA[0], pbA[2]) }); }
    if (S && onlyClear) {
      // (and the best spots at that time on rings around the contact's spot)
      for (const r of [0.04, 0.08, 0.12]) for (let a = 0; a < 8; a++) { const x = pbA[0] + r * Math.cos((a * Math.PI) / 4), z = pbA[2] + r * Math.sin((a * Math.PI) / 4); starts.push({ S, tb: A.tb, x, z, cost: costOf(S, x, z) }); }
      const head = starts.shift(); starts.sort((a, b) => a.cost - b.cost); starts.unshift(head);
    }
  }
  // every flight tried scores its cost + how far short of clear it is (× how much the body's prediction is trusted: a
  // move's own future pose fully, the dribble layer's — its pose now — less); a clear one scores its cost. The best
  // wins; a clear one nearly as cheap as the best spot ends the search
  let checked = A ? 1 : 0, best = null;
  const tried = [], lam = c.deficitCost * (o.trust ?? 1), good = Math.min(...starts.map((q) => q.cost)) + 0.03;
  for (const s0 of starts) {
    if (checked >= c.checks) break;
    if (tried.some((q) => Math.abs(q.tb - s0.tb) < 0.004 && Math.hypot(q.x - s0.x, q.z - s0.z) < 0.015)) continue;
    let k = s0;
    for (let rep = 0; rep <= c.repairs && checked < c.checks; rep++) {
      tried.push(k); checked++;
      const pl = solve(k);
      if (!pl) break;
      const { m, w } = clearance(pl), clear = m >= c.margin, score = k.cost + lam * Math.max(0, c.margin - m);
      if (!best || score < best.score) best = done(pl, k, { clearance: m, checked, repairs: rep, score, why: !clear ? 'best-effort' : gate ? 'gate' : rep ? 'moved' : 'spot', whyNot });
      if (clear) { if (k.cost <= good) return best; break; }
      if (o.debug) o.debug.push({ tb: +k.tb.toFixed(3), x: +k.x.toFixed(3), z: +k.z.toFixed(3), cost: +k.cost.toFixed(4), cl: +m.toFixed(3), at: +w.t.toFixed(3), p: w.p.map((q) => +q.toFixed(3)) });
      // repair: move the bounce away from where the flight touched (horizontally), by the deficit over how far the
      // bounce moves the ball at that moment (down: (τ/Td)²(2 − τ/Td); up: 1 − τ/Tu)
      if (!w?.q) break;
      const sens = w.t <= k.tb ? (() => { const u = clamp((w.t - tr) / Math.max(1e-3, k.tb - tr), 0, 1); return u * u * (2 - u); })() : clamp(1 - (w.t - k.tb) / Math.max(1e-3, tc - k.tb), 0, 1);
      let d = [w.p[0] - w.q[0], w.p[2] - w.q[2]];
      const dl = Math.hypot(d[0], d[1]);
      if (dl < 1e-4 || sens < 0.15) break;
      d = [d[0] / dl, d[1] / dl];
      const step = Math.min(0.12, (c.margin - m + 0.004) / sens);
      const x = k.x + d[0] * step, z = k.z + d[1] * step;
      k = { S: k.S, tb: k.tb, x, z, cost: costOf(k.S, x, z) };
    }
  }
  // (a clearance-only re-plan that gains < 3 mm keeps the contact's own flight; so does a physics re-plan that is not
  // clearly more physical — the motion's own timing may allow nothing better: a 0.12 s dribble from the hip is a slam
  // whatever its bounce)
  if (onlyClear && (!best || best.clearance < A.clear + 0.003)) return { ...A, gate: !!gate, cost: 0, clearance: A.clear, checked, why: 'contact', whyNot };
  if (A && !onlyClear && !gate && best) {
    // (scored as the others: its cost + how far short of clear it is — a re-plan has to beat it by c.better)
    const S = slice(A.tb), costA = S ? costOf(S, pbA[0], pbA[2]) : Infinity, mA = clearance(A).m, scoreA = costA + lam * Math.max(0, c.margin - mA);
    if (!(best.score < scoreA - c.better && best.clearance >= Math.min(c.margin, mA) - 0.003)) return { ...A, gate: false, cost: costA, score: scoreA, clearance: mA, checked, why: 'contact', whyNot: `${whyNot}; nothing clearly better` };
  }
  return best;
}
function gateFrame(ft) { const L = ft.l, d = [ft.r[0] - L[0], ft.r[1] - L[1]], w = Math.hypot(d[0], d[1]) || 1; return { L, d: [d[0] / w, d[1] / w], w }; }

/** A hand-to-hand toss (no bounce): one arc from the release to the catch. */
export function planToss({ tr, pr, vr, tc, pc, vc = null, g = G, floorY = 0, R = 0.12, w0 = [0, 0, 0], q0 = [0, 0, 0, 1] }) {
  return solveSegment({ t0: tr, p0: pr, v0: vr, t1: tc, p1: pc, v1: vc, g, floorY, R, w: w0, q0, kind: 'toss' });
}

/** Spin given to the ball as the hand pushes it down: backspin against the push's horizontal motion. */
export function releaseSpin(vHand, R, gain = 0.5) { return sc(rollingSpin(vHand, R), -gain); }

/** Compact, JSON-safe copy of a segment (networking / snapshots). */
export function packSegment(s) {
  if (!s) return null;
  const r = (a) => a.map((x) => +x.toFixed(5));
  return { t0: +s.t0.toFixed(5), t1: +s.t1.toFixed(5), p0: r(s.p0), p1: r(s.p1), vLin: r(s.vLin), dv0: r(s.dv0), dv1: r(s.dv1), w: r(s.w), q0: r(s.q0), g: s.g, kind: s.kind, floorY: s.floorY, R: s.R };
}
export function unpackSegment(o) { return o ? { ...o, T: Math.max(1e-3, o.t1 - o.t0) } : null; }
