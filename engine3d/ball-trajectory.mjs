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
