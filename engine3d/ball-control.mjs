/**
 * BallController — the explicit BallControlState machine (docs/ball-contact-system.md → STATE
 * MACHINE). The engine always knows why the ball is where it is:
 *
 *   HELD_*           on a palm target (position + orientation constraint, tiny smoothing)
 *   RELEASE_* / DRIBBLE_DOWN / BOUNCE / DRIBBLE_UP_* / CATCH_*   a solved trajectory between contacts
 *   PASS_RELEASE     a solved pass to the receiving hand
 *   SHOT_RELEASE / LOOSE / DEAD   the physics engine (nobody controls the ball)
 *
 * Inputs each tick: time, the two palm targets (BallTarget_L / BallTarget_R from the skinned
 * skeleton) and the animation's ball schedule (the next contacts, their windows and predicted
 * world points). Output: the ball's position / velocity / orientation / spin, who owns it,
 * whether physics runs it, and the transitions that happened.
 *
 * Deterministic: everything is a function of time and the inputs (segments are closed-form),
 * so 30 / 60 / 120 fps give the same path, and snapshot() is a compact networkable state.
 * Engine-agnostic (no three.js).
 */
import { G, planDribble, planBounce, planToss, solveSegment, retarget, segPos, segVel, segRot, releaseSpin, packSegment, unpackSegment, qmul, qinv, qnorm, qslerp, qexp, quatFromBasis, rollingSpin } from './ball-trajectory.mjs';
import { fitBallToHands } from './ball-fit.mjs';

export const STATES = ['HELD_RIGHT', 'HELD_LEFT', 'HELD_BOTH', 'RELEASE_RIGHT', 'RELEASE_LEFT', 'DRIBBLE_DOWN', 'BOUNCE', 'DRIBBLE_UP_RIGHT', 'DRIBBLE_UP_LEFT', 'CATCH_RIGHT', 'CATCH_LEFT', 'SHOT_RELEASE', 'PASS_RELEASE', 'LOOSE', 'DEAD'];
const H = { left: 'LEFT', right: 'RIGHT', both: 'BOTH' };
const handOf = (s) => (/_RIGHT$/.test(s) ? 'right' : /_LEFT$/.test(s) ? 'left' : /_BOTH$/.test(s) ? 'both' : null);
export const isHeld = (s) => /^HELD_/.test(s);
export const isFlight = (s) => /^(RELEASE_|DRIBBLE_|BOUNCE|CATCH_|PASS_RELEASE)/.test(s);
export const isPhysics = (s) => s === 'SHOT_RELEASE' || s === 'LOOSE' || s === 'DEAD';

/** Allowed transitions (anything else is rejected and logged). */
const RECOVER = ['HELD_RIGHT', 'HELD_LEFT', 'HELD_BOTH'];   // failsafe: any controlled state may recover into a hold
export const TRANSITIONS = {
  HELD_RIGHT: ['RELEASE_RIGHT', 'HELD_BOTH', 'HELD_LEFT', 'SHOT_RELEASE', 'PASS_RELEASE', 'LOOSE', 'DEAD', 'HELD_RIGHT'],
  HELD_LEFT: ['RELEASE_LEFT', 'HELD_BOTH', 'HELD_RIGHT', 'SHOT_RELEASE', 'PASS_RELEASE', 'LOOSE', 'DEAD', 'HELD_LEFT'],
  HELD_BOTH: ['HELD_RIGHT', 'HELD_LEFT', 'RELEASE_RIGHT', 'RELEASE_LEFT', 'SHOT_RELEASE', 'PASS_RELEASE', 'LOOSE', 'DEAD'],
  RELEASE_RIGHT: ['DRIBBLE_DOWN', 'DRIBBLE_UP_RIGHT', 'DRIBBLE_UP_LEFT', 'LOOSE', 'DEAD', ...RECOVER],
  RELEASE_LEFT: ['DRIBBLE_DOWN', 'DRIBBLE_UP_RIGHT', 'DRIBBLE_UP_LEFT', 'LOOSE', 'DEAD', ...RECOVER],
  DRIBBLE_DOWN: ['BOUNCE', 'LOOSE', 'DEAD', ...RECOVER],
  BOUNCE: ['DRIBBLE_UP_RIGHT', 'DRIBBLE_UP_LEFT', 'LOOSE', 'DEAD', ...RECOVER],
  DRIBBLE_UP_RIGHT: ['CATCH_RIGHT', 'DRIBBLE_UP_LEFT', 'LOOSE', 'DEAD', ...RECOVER],
  DRIBBLE_UP_LEFT: ['CATCH_LEFT', 'DRIBBLE_UP_RIGHT', 'LOOSE', 'DEAD', ...RECOVER],
  CATCH_RIGHT: ['HELD_RIGHT', 'HELD_BOTH', 'LOOSE', 'DEAD', ...RECOVER],
  CATCH_LEFT: ['HELD_LEFT', 'HELD_BOTH', 'LOOSE', 'DEAD', ...RECOVER],
  SHOT_RELEASE: ['LOOSE', 'DEAD', 'PASS_RELEASE'],
  PASS_RELEASE: ['CATCH_RIGHT', 'CATCH_LEFT', 'LOOSE', 'DEAD', ...RECOVER],
  LOOSE: ['CATCH_RIGHT', 'CATCH_LEFT', 'DEAD', 'HELD_RIGHT', 'HELD_LEFT', 'PASS_RELEASE'],
  DEAD: ['HELD_RIGHT', 'HELD_LEFT', 'PASS_RELEASE', 'LOOSE'],
};

export const BALL_CONTROL_DEFAULTS = Object.freeze({
  R: 0.12, floorY: 0, g: G,
  // palm targets: ball centre = palm centre + n·(R + palmThickness + normal) + y·along
  palmThickness: 0.014,
  offsets: { left: { normal: 0, along: 0.012 }, right: { normal: 0, along: 0.012 } },
  // controlled attachment
  holdHalflife: 0.012,      // s: an offset from the target (after a catch / hand change) decays this fast (no steady-state lag)
  handoffTime: 0.12,        // s: a hand change inside a hold blends the target over this long
  releaseTime: 0.05,        // s: RELEASE_* lasts until the ball is clear of the palm, at most this long
  releaseClear: 0.03,       // m: clear of the palm
  catchBlend: 0.08,         // s: the last stretch before a catch blends from the flight into the palm
  catchDist: 0.45,          // m: a receiving hand only takes a ball this close (with the right state / hand / approach)
  earlyCatchDist: 0.035,    // m: a receiving hand that reaches the rising ball before its planned catch takes it then (its
                            // clip snaps it to the catch pose early) — the ball settles onto it instead of pushing it away
  catchDecel: 110,          // m/s²: a hand absorbs the ball's speed (relative to the palm) at most this fast (≈ 11 g)
  arriveMatch: 0.6,         // the last stretch of a flight arrives with this share of the palm's own velocity (a soft catch)
  approachCos: -0.2,        // the ball must be arriving (relative velocity · direction to the palm ≥ this · speed)
  // trajectories that follow a moving target
  maxTargetSpeed: 4.0,      // m/s a flight's target may be moved (a re-predicted hand / bounce point) — no swerves
  maxTimeShift: 1.2,        // s per s a catch time may move (the animation's clock changed)
  minFlight: 0.12,          // s: shortest dribble flight (hand → floor → hand)
  homeTime: 0.2,            // s before a catch: the flight homes in on the real palm (extrapolated), away from the long-range prediction
  legMargin: 0.008,         // m: a controlled ball keeps this clear of the legs (collision policy: slide around, never bounce off)
  maxHeldPush: 0.06,        // m: a ball on the palm is moved at most this far out of a leg (the hand follows by IK; the knee yields the rest)
  // failsafe
  maxDistFromPlayer: 2.5,   // m in a controlled state
  recoverTime: 0.08,        // s: hidden correction window
  floorTol: 0.004,          // m below floor + R before a correction
  // IK (weights + limits; applied by the session)
  ikFar: 0.25, ikNear: 0.1, ikContact: 0.03,  // s before a catch: 0 → 0.2 → 0.6 → 1
  ikHoldSettled: 0.3,       // weight once the hold is established and aligned
  ikRate: 8,                // 1/s: most a weight changes per second (never snaps)
  ikReleaseFade: 0.08,      // s
  maxHandCorrection: 0.04,  // m (× arm length / 0.62)
  maxWristRotation: 0.3,    // rad
  maxElbowCorrection: 0.25, // rad
  maxExtension: 0.97,       // × (upper arm + forearm)
  // the held ball out of the rigid hands / arms / head (engine3d/ball-fit.mjs): a two-hand hold,
  // and any hold of a shot's last half second
  handFit: true,
  handFitMargin: 0.002,     // m clear
  handFitMax: 0.3,          // m, the most it moves the ball off its targets
  handFitHalflife: 0.04,    // s, the fit eases in / out (critically damped): a correction, never a pop
  handFitMaxSpeed: 2.0,     // m/s the correction itself may move
  handSkin: false,          // the session has the hands' own skin contact: in a two-hand hold the hands are not obstacles of the
                            // fit (their palms are moved onto / out of the ball, their fingers wrap it — the fit used to push
                            // the ball onto the heels of the hands, the fingers far off it)
  shotPocketTime: 0.3,      // s before a shot's release the ball goes to the launch side of the hands
});

// ── vectors ──
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const finite3 = (a) => !!a && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
const moveToward = (a, b, maxD) => { const d = sub(b, a), l = len(d); return l <= maxD || l < 1e-9 ? b.slice() : add(a, sc(d, maxD / l)); };
// critically damped decay of an offset (exact, frame-rate independent): x'' = −k² x − 2k x'
function decay(x, v, halflife, dt) {
  const k = (0.6931 * 2) / Math.max(1e-4, halflife) / 2, e = Math.exp(-k * dt);
  const j1 = v.map((vi, i) => vi + x[i] * k);
  return [x.map((xi, i) => e * (xi + j1[i] * dt)), v.map((vi, i) => e * (vi - j1[i] * k * dt))];
}

/**
 * A palm target from a palm frame (engine3d/contact-ik.mjs palmFrame: c, n, x, y) and its offsets.
 * @returns {{ p: number[], n: number[], x: number[], y: number[], q: number[], c: number[] }}
 */
export function palmTarget(f, cfg = BALL_CONTROL_DEFAULTS, hand = 'right') {
  const o = cfg.offsets?.[hand] || { normal: 0, along: 0.012 };
  const p = add(add(f.c, sc(f.n, cfg.R + cfg.palmThickness + (o.normal || 0))), sc(f.y, o.along ?? 0.012));
  return { p, n: f.n, x: f.x, y: f.y, c: f.c, q: quatFromBasis(f.x, f.y, hand === 'right' ? f.n : sc(f.n, -1)) };
}

export class BallController {
  constructor(cfg = {}) {
    this.cfg = { ...BALL_CONTROL_DEFAULTS, ...cfg, offsets: { ...BALL_CONTROL_DEFAULTS.offsets, ...(cfg.offsets || {}) } };
    this.state = 'DEAD'; this.since = 0; this.t = 0;
    this.p = [0, this.cfg.R, 0]; this.v = [0, 0, 0]; this.q = [0, 0, 0, 1]; this.w = [0, 0, 0];
    this.drawT = 0;            // the time along the ball's path its drawn position is (t; the bounce tick: the bounce instant)
    this.hold = null;          // { hand, off: [x,y,z], offV, attach (quat), from (handoff), t0 }
    this.flight = null;        // { kind, down, up, toss, tr, tb, tc, fromHand, toHand, bounceAt, catchAt, eventIds }
    this.recovery = null;      // { t0, T, from, fromV, reason }
    this.ik = { left: 0, right: 0 };
    this.log = []; this.recoveries = 0; this.rejected = 0; this.transitions = 0;
    this.events = [];
    this.stats = { bounces: 0, catches: 0, releases: 0, maxCatchErr: 0, maxBounceErr: 0, floorViolations: 0, nan: 0 };
    this.moveId = null; this.u = null; this.expected = null;
    this.last = { targets: null, schedule: null };
  }

  // ── transitions ──
  go(next, reason = '', t = this.t) {
    const cur = this.state;
    if (next === cur && !isHeld(next)) return true;
    if (!(TRANSITIONS[cur] || []).includes(next)) {
      this.rejected++;
      this.logLine(`REJECTED ${cur} → ${next}${reason ? ' (' + reason + ')' : ''}`, t);
      return false;
    }
    this.state = next; this.since = t; this.transitions++;
    this.events.push({ type: 'state', from: cur, to: next, reason, t });
    this.logLine(`${cur} → ${next}${reason ? ' · ' + reason : ''}`, t);
    return true;
  }
  logLine(m, t = this.t) { this.log.push(`${t.toFixed(3)} ${m}`); if (this.log.length > 400) this.log.splice(0, 100); }
  get owner() { const h = handOf(this.state); return isHeld(this.state) || /^(RELEASE_)/.test(this.state) ? h : /^(DRIBBLE_UP_|CATCH_)/.test(this.state) ? h : this.state === 'DRIBBLE_DOWN' || this.state === 'BOUNCE' ? this.flight?.toHand || this.flight?.fromHand : null; }
  get physics() { return isPhysics(this.state); }
  get controlled() { return !isPhysics(this.state); }
  /** The hand that holds the ball now (held states only). */
  get heldHand() { return isHeld(this.state) ? handOf(this.state) : null; }

  // ── gameplay commands ──
  /** A new possession: the ball on a palm, at rest relative to it. */
  giveBall(hand, targets, t = this.t) {
    const T = this.targetOf(hand, targets);
    if (!T) return false;
    this.state = `HELD_${H[hand]}`; this.since = t;
    this.p = T.p.slice(); this.v = (T.v || [0, 0, 0]).slice(); this.w = [0, 0, 0];
    this.hold = { hand, off: [0, 0, 0], offV: [0, 0, 0], attach: qmul(qinv(T.q), this.q), t0: t };
    this.flight = null; this.recovery = null; this.fitOff = null; this.fitV = null;
    this.logLine(`new possession → HELD_${H[hand]}`, t);
    this.events.push({ type: 'possession', hand, t });
    return true;
  }
  /** Shot / physics hand-off: the ball leaves under the physics engine (the caller throws it). */
  toPhysics(state = 'SHOT_RELEASE', reason = 'shot', t = this.t) {
    if (!this.go(state, reason, t)) { this.state = state; this.since = t; }
    this.flight = null; this.hold = null; this.recovery = null; this.fitOff = null; this.fitV = null;
    this.ik = { left: 0, right: 0 };
  }
  /** Physics reports the ball (LOOSE / SHOT / DEAD): the controller mirrors it. */
  syncPhysics(p, v, q, w) { if (finite3(p)) { this.p = p.slice(); this.v = v.slice(); this.q = q.slice(); this.w = w.slice(); } }
  /**
   * A controlled pass (or a pick-up toss) from where the ball is to a receiving hand's target at
   * time tc; the receiving hand takes it on arrival.
   */
  pass(toHand, targetAt, tc, t = this.t, reason = 'pass') {
    const from = this.p.slice(), vr = this.v.slice();
    if (!this.go('PASS_RELEASE', reason, t)) return false;
    const toss = planToss({ tr: t, pr: from, vr: null, tc, pc: targetAt, g: this.cfg.g, floorY: this.cfg.floorY, R: this.cfg.R, w0: this.w, q0: this.q });
    void vr;
    this.flight = { kind: 'pass', toss, tr: t, tc, fromHand: null, toHand, catchAt: targetAt.slice(), eventIds: {} };
    this.hold = null;
    return true;
  }

  targetOf(hand, targets) {
    if (!targets) return null;
    if (hand === 'both') {
      const L = targets.left, R = targets.right;
      if (!L || !R) return L || R;
      return { p: lerp(L.p, R.p, 0.5), v: lerp(L.v || [0, 0, 0], R.v || [0, 0, 0], 0.5), q: qslerp(L.q, R.q, 0.5), n: L.n, c: lerp(L.c, R.c, 0.5) };
    }
    return targets[hand] || null;
  }

  /**
   * One tick.
   * @param {number} t       game time (s)
   * @param {number} dt      tick length (s)
   * @param {object} f       { targets: { left, right } (p, v, q, n, c), schedule (Player.ballSchedule + world points), player: { pos, vel, yaw },
   *                          obstacles (leg capsules), hands (body sample: the held-ball fit), shot ({ releaseIn: s, prefer: launch direction } | null) }
   */
  update(t, dt, f) {
    this.events = [];
    this.t = t; this.lastDt = dt; this.drawT = t;
    this.last = { targets: f.targets, schedule: f.schedule };
    const S = f.schedule || { events: [] };
    this.moveId = S.moveId || null; this.u = S.u ?? null; this.expected = S.hand || null;
    if (isPhysics(this.state)) { this.updateIk(dt, f); return this.out(); }
    // ── held
    if (isHeld(this.state)) this.updateHeld(t, dt, f, S);
    // ── in flight (planned trajectory)
    if (isFlight(this.state)) this.updateFlight(t, dt, f, S);
    this.failsafe(t, dt, f);
    this.updateIk(dt, f);
    return this.out();
  }

  out() {
    return { p: this.p, v: this.v, q: this.q, w: this.w, state: this.state, owner: this.owner, physics: this.physics, events: this.events, ik: this.ik, flight: this.flight, recovery: this.recovery, drawT: this.drawT };
  }

  // ── HELD_* : the ball follows its palm target (offset decays; orientation follows the palm)
  updateHeld(t, dt, f, S) {
    let hand = handOf(this.state);
    const h = this.hold || (this.hold = { hand, off: [0, 0, 0], offV: [0, 0, 0], attach: [0, 0, 0, 1], t0: t });
    // the animation moves the ball to both hands (gather / shot set) or to the other hand inside a hold
    const want = S.hand && S.hand !== hand && !S.inFlight ? S.hand : null;
    // a hand-off only when the receiving hand is really at the ball (else the animation's label is
    // just ahead of / behind the ball: keep it where it physically is)
    const toT = want ? this.targetOf(want, f.targets) : null;
    const near = toT && len(sub(toT.p, this.p)) < (want === 'both' ? 0.22 : 0.16);
    if (want && near) {
      const from = this.targetOf(hand, f.targets), to = this.targetOf(want, f.targets);
      if (from && to && this.go(`HELD_${H[want]}`, 'hand-off', t)) {
        // keep the ball where it is: the offset to the new target decays (a hand-off, not a teleport)
        // (the hand fit's own correction stays its own: not counted twice)
        h.off = sub(sub(this.p, this.fitOff || [0, 0, 0]), to.p); h.offV = sub(sub(this.v, this.fitV || [0, 0, 0]), to.v || [0, 0, 0]);
        h.hand = want; hand = want; h.t0 = t;
        h.attach = qmul(qinv(to.q), this.q);
      }
    }
    const T = this.targetOf(hand, f.targets);
    if (!T) return;
    [h.off, h.offV] = decay(h.off, h.offV, this.cfg.holdHalflife, dt);
    const p = add(T.p, h.off);
    const v = add(T.v || [0, 0, 0], h.offV);
    this.p = p; this.v = v;
    // never inside the hands: a two-hand hold (the palms can be closer than the ball is wide), or
    // any hold in a shot's last half second (the ball goes where it will be thrown from)
    const cfg = this.cfg;
    if (cfg.handFit && f.hands && (hand === 'both' || (f.shot && f.shot.releaseIn <= 0.5))) this.fitToHands(dt, hand, f.hands, f.shot);
    else if (this.fitOff) this.fitToHands(dt, hand, null, null);
    const qT = qnorm(qmul(T.q, h.attach));
    this.w = sc(sub(qT.slice(0, 3), this.q.slice(0, 3)), 2 / Math.max(1e-4, dt));
    this.q = qT;
    if (f.obstacles?.length) this.pushOutCapped(f.obstacles, dt);
    // the release (or a shot / pass from the clip: the game handles those)
    const rel = (S.events || []).find((e) => e.type === 'release' && (e.hand === hand || hand === 'both'));
    if (rel && rel.in <= 1e-6) this.release(t, f, S, rel);
  }

  /**
   * The held ball out of the rigid hand (ball-fit): the correction eases toward the fitted place
   * (critically damped, speed-capped) and its motion is the ball's too (no teleport, no pop).
   * body null: ease the correction back to nothing.
   */
  fitToHands(dt, hand, body, shot) {
    const c = this.cfg;
    let want = [0, 0, 0];
    if (body) {
      const w = shot ? smooth(1 - shot.releaseIn / Math.max(1e-3, c.shotPocketTime)) : 0;
      const r = fitBallToHands(this.p, body, c.R, { holding: hand, prefer: shot?.prefer || null, preferWeight: w, margin: c.handFitMargin, maxMove: c.handFitMax, holdingRigid: !(c.handSkin && hand === 'both') });
      want = sub(r.p, this.p);
      this.lastFit = { moved: r.moved, clearance: r.clearance, ok: r.ok, pocket: w >= 0.5 };
    }
    const prev = this.fitOff || [0, 0, 0];
    let [x, v] = decay(sub(prev, want), this.fitV || [0, 0, 0], c.handFitHalflife, dt);
    let next = add(want, x);
    const step = sub(next, prev), sl = len(step), cap = c.handFitMaxSpeed * dt;
    if (sl > cap) { next = add(prev, sc(step, cap / sl)); v = sc(step, c.handFitMaxSpeed / sl); }
    this.fitOff = next; this.fitV = v;
    this.p = add(this.p, next);
    this.v = add(this.v, sc(sub(next, prev), 1 / Math.max(1e-4, dt)));
    this.stats.maxHandFit = Math.max(this.stats.maxHandFit || 0, len(next));
    if (!body && len(next) < 1e-4 && len(v) < 1e-3) { this.fitOff = null; this.fitV = null; }
  }

  release(t, f, S, rel) {
    const hand = rel.hand && rel.hand !== 'both' ? rel.hand : handOf(this.state) === 'both' ? 'right' : handOf(this.state);
    const E = S.events || [];
    const catchEv = E.find((e) => e.type === 'catch' && e.in > rel.in + 1e-4);
    const bounceEv = E.find((e) => e.type === 'bounce' && e.in > rel.in && (!catchEv || e.in < catchEv.in));
    const T0 = this.targetOf(hand, f.targets);
    const vr = T0?.v ? T0.v.slice() : this.v.slice();
    const pr = this.p.slice();
    this.fitOff = null; this.fitV = null;
    if (!catchEv) {
      // released and nobody receives it (a let-go / pass in the clip): the physics takes it
      this.go(`RELEASE_${H[hand]}`, 'release (no catch)', t);
      this.toPhysics('LOOSE', 'released, no catch', t);
      this.events.push({ type: 'release', hand, t, loose: true });
      return;
    }
    const tc = t + Math.max(this.cfg.minFlight, catchEv.in);
    const pc = catchEv.world || this.targetOf(catchEv.hand, f.targets)?.p || pr;
    const cfg = this.cfg;
    let fl;
    if (bounceEv && bounceEv.world) {
      // exact event times (not the tick that noticed them): the same plan at any frame rate
      const trPlan = t + Math.min(0, rel.in);
      const tb = clamp(t + bounceEv.in, trPlan + 0.04, tc - 0.04);
      const ref = bounceEv.worldRaw || bounceEv.world;   // (the spot the schedule re-predicts every tick)
      const req = { tr: t, trPlan, prPlan: sub(pr, sc(vr, t - trPlan)), pr, vr, tb, tbWindow: bounceEv.window ? [t + bounceEv.window[0], t + bounceEv.window[1]] : null, pb: ref, pbContact: bounceEv.world, conf: bounceEv.conf, tc, pc, vc: null, g: cfg.g, floorY: cfg.floorY, R: cfg.R, w0: releaseSpin(vr, cfg.R), q0: this.q, fromHand: hand, toHand: catchEv.hand };
      // the bounce from the motion, the flight clear of the body (the session's planner: the body as it will be), else the
      // contact's own spot
      const planned = f.planFlight ? f.planFlight(req) : null;
      const plan = planned || planDribble({ ...req, pb: bounceEv.world });
      const pb = planned ? planned.pb : bounceEv.world;
      if (plan) {
        fl = { kind: 'dribble', down: plan.down, up: plan.up, tr: t, tb: plan.tb, tc, restitution: plan.restitution, bounceAt: [pb[0], cfg.floorY + cfg.R, pb[2]], plannedBounce: pb.slice() };
        // (the planned spot rides on the schedule's re-predicted one: the body moves on, the choice stays)
        if (planned) fl.plan = { why: planned.why, gate: planned.gate, clearance: planned.clearance, checked: planned.checked, whyNot: planned.whyNot || null };
        if (planned && planned.why !== 'contact') fl.bounceShift = [pb[0] - ref[0], 0, pb[2] - ref[2]];
      }
    }
    if (!fl) fl = { kind: 'toss', toss: planToss({ tr: t, pr, vr, tc, pc, g: cfg.g, floorY: cfg.floorY, R: cfg.R, w0: releaseSpin(vr, cfg.R), q0: this.q }), tr: t, tc };
    Object.assign(fl, { fromHand: hand, toHand: catchEv.hand === 'both' ? hand : catchEv.hand, catchAt: pc.slice(), eventIds: { release: rel.id, bounce: bounceEv?.id, catch: catchEv.id }, moveId: S.moveId, profile: bounceEv?.profile || catchEv?.profile || null, pr: pr.slice(), vr: vr.slice() });
    this.flight = fl;
    const vinS = fl.down ? Math.hypot(...segVel(fl.down, fl.tb)) : null;
    const pw = fl.plan ? `, ${fl.plan.why}${fl.plan.whyNot ? ` (the contact's own: ${fl.plan.whyNot})` : ''}${fl.plan.clearance != null ? (Number.isFinite(fl.plan.clearance) ? ` ${(fl.plan.clearance * 100).toFixed(1)} cm clear` : ' clear') : ''}` : '';
    this.go(`RELEASE_${H[hand]}`, `release → ${fl.kind === 'dribble' ? 'bounce' : 'toss'} → ${fl.toHand}${fl.down ? ` (flight ${(fl.tc - t).toFixed(3)} s, bounce +${(fl.tb - t).toFixed(3)} s, ${vinS.toFixed(1)} m/s in, e ${fl.restitution.toFixed(2)}, heights ${pr[1].toFixed(2)} → ${pc[1].toFixed(2)}${pw})` : ''}`, t);
    this.hold = null;
    this.stats.releases++;
    this.events.push({ type: 'release', hand, t, toHand: fl.toHand, kind: fl.kind });
  }

  // ── flights: evaluate the planned segments, re-target them as the predictions move
  updateFlight(t, dt, f, S) {
    const fl = this.flight, cfg = this.cfg;
    if (!fl) { this.recover(t, f, 'flight lost'); return; }
    const E = S.events || [];
    // re-predict the catch (the hand's future target) and the bounce (the body moved)
    const catchEv = fl.eventIds?.catch ? E.find((e) => e.id === fl.eventIds.catch && e.type === 'catch') || E.find((e) => e.type === 'catch') : E.find((e) => e.type === 'catch');
    const bounceEv = fl.eventIds?.bounce ? E.find((e) => e.id === fl.eventIds.bounce && e.type === 'bounce') : null;
    const segNow = () => (fl.toss ? fl.toss : t <= fl.tb ? fl.down : fl.up);
    // the animation's clock may run a little faster / slower (speed changes the dribble tempo)
    if (catchEv && t < fl.tc - cfg.catchBlend) {
      const tcNew = t + Math.max(0.02, catchEv.in);
      if (Math.abs(tcNew - fl.tc) > 1e-4) fl.tc = fl.tc + clamp(tcNew - fl.tc, -cfg.maxTimeShift * dt, cfg.maxTimeShift * dt);
      if (catchEv.hand && catchEv.hand !== fl.toHand && catchEv.hand !== 'both' && fl.tc - t > 0.15) {
        this.logLine(`catch hand changed ${fl.toHand} → ${catchEv.hand} mid-flight (re-planned)`, t);
        fl.toHand = catchEv.hand;
      }
    }
    const Th = this.targetOf(fl.toHand, f.targets);
    let pc = catchEv?.world || Th?.p || fl.catchAt;
    const tau = fl.tc - t;
    // the last stretch: home in on where the palm really is (its position extrapolated to the catch)
    // — unless the catch point is the exact skinned prediction of the move's own frame
    if (Th && tau < cfg.homeTime && !catchEv?.skinned) pc = lerp(pc, add(Th.p, sc(Th.v || [0, 0, 0], Math.max(0, tau))), smooth(1 - tau / cfg.homeTime));
    fl.catchAt = moveToward(fl.catchAt, pc, cfg.maxTargetSpeed * (tau < cfg.homeTime ? 3.5 : 1) * dt);
    if (!fl.toss && t < fl.tb - 0.01 && bounceEv?.world) {
      const ref = fl.bounceShift ? add(bounceEv.worldRaw || bounceEv.world, fl.bounceShift) : bounceEv.world;
      const nb = [ref[0], cfg.floorY + cfg.R, ref[2]];
      const moved = moveToward(fl.bounceAt, nb, cfg.maxTargetSpeed * dt);
      if (len(sub(moved, fl.bounceAt)) > 1e-4) { fl.bounceAt = moved; fl.down = retarget(fl.down, t, fl.bounceAt, fl.tb); }
    }
    // keep the rest of the flight pointed at the (moved) catch
    const vArr = Th?.v && tau < 0.25 && fl.kind !== 'pass' ? Th.v : null;   // (the palm's velocity: a dribble arrives with part of it)
    if (fl.toss) { if (t < fl.tc - 1e-3 && (len(sub(fl.toss.p1, fl.catchAt)) > 1e-4 || Math.abs(fl.toss.t1 - fl.tc) > 1e-4 || vArr)) fl.toss = retarget(fl.toss, t, fl.catchAt, fl.tc, { v1: vArr, matchEnd: cfg.arriveMatch }); }
    else if (t > fl.tb && t < fl.tc - 1e-3 && (len(sub(fl.up.p1, fl.catchAt)) > 1e-4 || Math.abs(fl.up.t1 - fl.tc) > 1e-4 || vArr)) fl.up = retarget(fl.up, t, fl.catchAt, fl.tc, { v1: vArr, matchEnd: cfg.arriveMatch });
    else if (t <= fl.tb && (len(sub(fl.up.p1, fl.catchAt)) > 1e-4 || Math.abs(fl.up.t1 - fl.tc) > 1e-4)) {
      // the up arc starts at the bounce: re-solve it whole (it hasn't begun)
      fl.up = solveSegment({ t0: fl.tb, p0: fl.bounceAt, v0: null, t1: fl.tc, p1: fl.catchAt, g: cfg.g, floorY: cfg.floorY, R: cfg.R, w: fl.up.w, q0: fl.up.q0, kind: 'up' });
    }
    // ── state progression
    const st = this.state;
    if (/^RELEASE_/.test(st)) {
      const T = this.targetOf(fl.fromHand, f.targets);
      const clear = !T || len(sub(segPos(segNow(), t), T.p)) > cfg.releaseClear || t - fl.tr >= cfg.releaseTime;
      if (clear) this.go(fl.toss ? `DRIBBLE_UP_${H[fl.toHand]}` : 'DRIBBLE_DOWN', fl.toss ? 'toss' : 'clear of the palm', t);
    }
    // the floor contact is DRAWN: the tick nearest the bounce shows the ball on the floor, at the bounce point (BOUNCE,
    // one tick — the bounce instant, ≤ half a tick from this tick's time), the next one rising from it. (Drawn at the
    // tick's own time it would be up to v·dt/2 above the floor on both sides — at 9 m/s and 30 fps 15 cm: never seen
    // touching it.) The path itself is unchanged.
    if (this.state === 'BOUNCE') this.go(`DRIBBLE_UP_${H[fl.toHand]}`, 'rebound', t);
    if (this.state === 'DRIBBLE_DOWN' && t >= fl.tb - 0.5 * (this.lastDt || 0)) {
      this.go('BOUNCE', `floor at ${fl.bounceAt.map((x) => x.toFixed(2)).join(', ')}`, fl.tb);
      this.stats.bounces++;
      if (fl.plannedBounce) this.stats.maxBounceErr = Math.max(this.stats.maxBounceErr, Math.hypot(fl.bounceAt[0] - fl.plannedBounce[0], fl.bounceAt[2] - fl.plannedBounce[2]));
      this.events.push({ type: 'bounce', t: fl.tb, p: fl.bounceAt.slice(), restitution: fl.restitution });
      this.p = segPos(fl.down, fl.tb); this.v = segVel(fl.up, fl.tb); this.q = segRot(fl.down, fl.tb); this.w = fl.up.w;
      this.drawT = fl.tb;
      return;
    }
    if (/^DRIBBLE_UP_/.test(this.state) && handOf(this.state) !== fl.toHand) this.go(`DRIBBLE_UP_${H[fl.toHand]}`, 'receiver changed', t);
    // catch: the right state + the expected hand + close + arriving
    const Tc0 = this.targetOf(fl.toHand, f.targets);
    const relArr = Tc0 ? len(sub(segVel(segNow(), fl.tc), Tc0.v || [0, 0, 0])) : 0;
    const blendLead = Math.max(cfg.catchBlend, Math.min(0.14, relArr / cfg.catchDecel));
    // an early meeting: the receiving hand is at the ball before the planned catch (its clip brings it in early):
    // it takes it now — the catch blend settles the ball onto it
    if (/^DRIBBLE_UP_/.test(this.state) && Tc0 && t < fl.tc - blendLead && t > (fl.tb ?? fl.tr) + 0.02) {
      const bp = segPos(segNow(), t), d = len(sub(bp, Tc0.p));
      if (d < cfg.earlyCatchDist) {
        this.logLine(`early catch: the ${fl.toHand} palm met the ball ${((fl.tc - t) * 1000).toFixed(0)} ms early`, t);
        fl.tc = t; fl.predErr = d; fl.blendEnd = t + Math.max(this.lastDt || 1 / 60, d / 1.5);
        fl.catchFrom = { t, p: bp, v: segVel(segNow(), t), err: d };
        fl.early = true;
        this.go(`CATCH_${H[fl.toHand]}`, `${fl.toHand} palm ${(d * 100).toFixed(1)} cm, met early`, t);
      }
    }
    if ((/^DRIBBLE_UP_/.test(this.state) || this.state === 'PASS_RELEASE') && t >= fl.tc - blendLead) {
      const T = Tc0;
      const bp = segPos(segNow(), t), bv = segVel(segNow(), t);
      const d = T ? len(sub(bp, T.p)) : Infinity;
      const rel = T ? sub(bv, T.v || [0, 0, 0]) : [0, 0, 0], dir = T ? sub(T.p, bp) : [0, 0, 0];
      const arriving = d < 0.02 || dot(rel, dir) >= cfg.approachCos * len(rel) * len(dir);
      if (T && d < cfg.catchDist && arriving) {
        // the blend takes as long as the remaining gap needs at ≤ 1.5 m/s of correction (never a sweep)
        const endAt = segPos(segNow(), fl.tc), Tend = add(T.p, sc(T.v || [0, 0, 0], Math.max(0, fl.tc - t)));
        fl.predErr = len(sub(endAt, Tend));   // the catch prediction's error (flight end vs the palm then)
        fl.blendEnd = Math.max(fl.tc, t + fl.predErr / 1.5);
        fl.catchFrom = { t, p: bp, v: bv, err: d };
        this.go(`CATCH_${H[fl.toHand]}`, `${fl.toHand} palm ${(d * 100).toFixed(1)} cm, arriving`, t);
      } else if (t >= fl.tc) {
        // the hand is not where the flight ended: recover into it (hidden, short)
        this.recover(t, f, T ? `catch miss ${(d * 100).toFixed(0)} cm` : 'receiving hand missing', fl.toHand);
        return;
      }
    }
    // ── position
    // the palm's real position AT the catch time, interpolated between the ticks around it (the
    // honest catch error: where the flight ended vs where the palm was then)
    {
      const Tn = this.targetOf(fl.toHand, f.targets);
      if (Tn && fl.lastTgt && fl.catchErr == null && t >= fl.tc && fl.lastTgt.t < fl.tc) {
        const k = (fl.tc - fl.lastTgt.t) / Math.max(1e-6, t - fl.lastTgt.t);
        fl.catchErr = len(sub(segPos(fl.toss || fl.up, fl.tc), lerp(fl.lastTgt.p, Tn.p, k)));
      }
      if (Tn) fl.lastTgt = { t, p: Tn.p.slice() };
    }
    if (/^CATCH_/.test(this.state)) {
      // the hand already met the ball (a fast catch: the hand swept onto it before the planned contact): caught
      // now — it settles onto the palm in the hold (its offset decays) instead of flying on into the hand
      const Tm = this.targetOf(fl.toHand, f.targets);
      if (Tm && t < (fl.blendEnd || fl.tc) - dt && len(sub(this.p, Tm.p)) < cfg.earlyCatchDist) { this.logLine(`early catch: the ${fl.toHand} palm met the ball ${(((fl.blendEnd || fl.tc) - t) * 1000).toFixed(0)} ms early`, t); fl.early = true; this.completeCatch(t, f); return; }
      // the ball stays on its flight; only the prediction error — where the palm will really be at
      // the catch (its motion extrapolated) minus where the flight was aimed — is blended in, so it
      // meets the real palm exactly at the catch without being pulled toward where the palm is NOW
      const T = this.targetOf(fl.toHand, f.targets);
      const tEnd = fl.blendEnd || fl.tc;
      const span = Math.max(1e-3, tEnd - fl.catchFrom.t), x = clamp((t - fl.catchFrom.t) / span, 0, 1);
      const s = smooth(x);
      const seg = segNow(), bp = segPos(seg, Math.min(t, fl.tc)), bv = t < fl.tc ? segVel(seg, t) : [0, 0, 0];
      const aimed = segPos(seg, fl.tc);
      const ext = T ? add(T.p, sc(T.v || [0, 0, 0], Math.max(0, fl.tc - t))) : aimed;
      const corr = sub(ext, aimed);
      this.p = add(bp, sc(corr, s));
      this.v = add(bv, T ? sc(T.v || [0, 0, 0], t >= fl.tc ? s : 0) : [0, 0, 0]);
      this.q = segRot(seg, Math.min(t, fl.tc)); this.w = seg.w;
      if (f.obstacles?.length) this.pushOutCapped(f.obstacles, dt);
      // a blend's velocity is how the ball really moves (hand-offs to physics, the debug view)
      if (fl.lastP && dt > 0) this.v = sc(sub(this.p, fl.lastP), 1 / dt);
      fl.lastP = this.p.slice();
      if (t >= tEnd) this.completeCatch(t, f);
      return;
    }
    const seg = segNow();
    this.p = segPos(seg, t); this.v = segVel(seg, t); this.q = segRot(seg, t); this.w = seg.w;
    // collision policy while controlled: the player's own legs never knock the ball away — a flight
    // that would enter a leg slides around it and the rest of the path is re-solved to the same
    // bounce / catch (constraint correction)
    if (f.obstacles?.length && !/^RELEASE_/.test(this.state)) this.clearLegs(t, f.obstacles);
  }

  /** A ball on / arriving at the palm, out of the legs by at most maxHeldPush (no path to re-solve). */
  pushOutCapped(caps, dt = 1 / 60) {
    const cfg = this.cfg;
    const base = this.p;
    let p = this.p, moved = 0;
    for (let it = 0; it < 2; it++) for (const c of caps) {
      const ab = sub(c.b, c.a), u = clamp(dot(sub(p, c.a), ab) / (dot(ab, ab) || 1e-9), 0, 1);
      const d = sub(p, add(c.a, sc(ab, u))), dl = len(d), pen = c.r + cfg.R + cfg.legMargin - dl;
      if (pen <= 0 || dl < 1e-6) continue;
      const step = Math.min(pen, cfg.maxHeldPush - moved);
      if (step <= 0) continue;
      p = add(p, sc(d, step / dl)); moved += step;
    }
    // the push eases in / out (half-life 25 ms): a knee sweeping past moves the ball, never pops it
    const want = sub(p, base), prev = this.pushOff || [0, 0, 0];
    const k = 1 - Math.exp((-0.6931 * dt) / 0.025);
    const off = add(prev, sc(sub(want, prev), k));
    this.pushOff = off;
    this.p = add(base, off); this.v = add(this.v, sc(sub(off, prev), 1 / Math.max(1e-4, dt)));
    this.heldPush = len(off);
    if (moved > 0) this.stats.maxHeldPush = Math.max(this.stats.maxHeldPush || 0, moved);
  }

  clearLegs(t, caps) {
    const fl = this.flight, cfg = this.cfg;
    let p = this.p, v = this.v, pushed = 0;
    // anticipate: a leg on the path in the next 50 ms steers the ball around it now (a velocity
    // change, no position jump) — the same at 30 fps as at 120
    const seg = fl.toss || (t < fl.tb ? fl.down : fl.up), H = Math.max(0.06, 2.5 * (this.lastDt || 1 / 60));
    const tEnd = fl.toss ? fl.tc : t < fl.tb ? fl.tb : fl.tc;
    if (t + 0.015 < tEnd - 0.01) {
      let steer = null;
      for (const h of [H / 3, (2 * H) / 3, H]) {
        if (t + h > tEnd - 0.005) break;
        const q = segPos(seg, t + h);
        for (const c of caps) {
          const ab = sub(c.b, c.a), u = clamp(dot(sub(q, c.a), ab) / (dot(ab, ab) || 1e-9), 0, 1);
          const d = sub(q, add(c.a, sc(ab, u))), dl = len(d), pen = c.r + cfg.R + cfg.legMargin - dl;
          if (pen > 0 && dl > 1e-6) { let n = sc(d, 1 / dl); if (q[1] + n[1] * pen < cfg.floorY + cfg.R) { n = [n[0], 0, n[2]]; const l = len(n) || 1; n = sc(n, 1 / l); } if (!steer || pen / h > steer.pen / steer.h) steer = { pen, n, h }; }
        }
      }
      if (steer) {
        v = add(v, sc(steer.n, (steer.pen + 0.004) / steer.h));
        const base = { g: cfg.g, floorY: cfg.floorY, R: cfg.R };
        if (fl.toss) fl.toss = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tc, p1: fl.catchAt, w: fl.toss.w, q0: this.q, kind: fl.toss.kind });
        else if (t < fl.tb) fl.down = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tb, p1: fl.bounceAt, w: fl.down.w, q0: this.q, kind: 'down' });
        else fl.up = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tc, p1: fl.catchAt, w: fl.up.w, q0: this.q, kind: 'up' });
        this.v = v;
        this.stats.legSteers = (this.stats.legSteers || 0) + 1;
      }
    }
    for (let it = 0; it < 2; it++) {
      for (const c of caps) {
        const ab = sub(c.b, c.a), u = clamp(dot(sub(p, c.a), ab) / (dot(ab, ab) || 1e-9), 0, 1);
        const q = add(c.a, sc(ab, u)), d = sub(p, q), dl = len(d);
        const pen = c.r + cfg.R + cfg.legMargin - dl;
        if (pen <= 0) continue;
        let n = dl > 1e-6 ? sc(d, 1 / dl) : [0, 0, 1];
        // never push the ball into the floor: slide sideways instead
        if (p[1] + n[1] * pen < cfg.floorY + cfg.R) { n = [n[0], 0, n[2]]; const l = len(n) || 1; n = sc(n, 1 / l); }
        p = add(p, sc(n, pen));
        const vn = dot(v, n); if (vn < 0) v = sub(v, sc(n, vn));
        pushed = Math.max(pushed, pen);
      }
    }
    if (!pushed) return;
    this.stats.legSlides = (this.stats.legSlides || 0) + 1;
    this.stats.maxLegPush = Math.max(this.stats.maxLegPush || 0, pushed);
    this.p = p; this.v = v;
    const base = { g: cfg.g, floorY: cfg.floorY, R: cfg.R };
    // (a slide with almost no flight left is not re-solved: the ball would have to sprint to its target)
    const left = fl.toss ? fl.tc - t : t < fl.tb ? fl.tb - t : fl.tc - t;
    if (left < 0.04) return;
    if (fl.toss) fl.toss = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tc, p1: fl.catchAt, w: fl.toss.w, q0: this.q, kind: fl.toss.kind });
    else if (t < fl.tb - 1e-3) fl.down = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tb, p1: fl.bounceAt, w: fl.down.w, q0: this.q, kind: 'down' });
    else if (t < fl.tc - 1e-3) fl.up = solveSegment({ ...base, t0: t, p0: p, v0: v, t1: fl.tc, p1: fl.catchAt, w: fl.up.w, q0: this.q, kind: 'up' });
  }

  completeCatch(t, f) {
    const fl = this.flight, hand = fl.toHand;
    const T = this.targetOf(hand, f.targets);
    // the prediction error at the contact: where the flight ended vs where the palm really is
    const seg = fl.toss || fl.up;
    // (the palm AT the catch time: this tick may be a little past it, and a catching hand moves fast)
    const Tat = T ? sub(T.p, sc(T.v || [0, 0, 0], Math.max(0, t - fl.tc))) : null;
    const err = fl.catchErr ?? (T && seg ? len(sub(segPos(seg, fl.tc), Tat)) : 0);
    this.stats.catches++; this.stats.maxCatchErr = Math.max(this.stats.maxCatchErr, err);
    this.go(`HELD_${H[hand]}`, 'caught', t);
    this.fitOff = null; this.fitV = null;
    // (the blend ended matched to the palm: the hold starts at rest relative to it — no spring kick)
    this.hold = { hand, off: T ? sub(this.p, T.p) : [0, 0, 0], offV: [0, 0, 0], attach: T ? qmul(qinv(T.q), this.q) : [0, 0, 0, 1], t0: t };
    // (an early catch is where the hand met the ball — its distance then is not a prediction error: `early`)
    this.events.push({ type: 'catch', hand, t, err, approach: fl.catchFrom?.err ?? null, early: !!fl.early });
    this.lastFlight = fl; this.flight = null;
  }

  // ── failsafe: never let chaos through (NaN, under the floor, impossibly far, lost plans)
  failsafe(t, dt, f) {
    const cfg = this.cfg;
    if (this.recovery) {
      const r = this.recovery, s = smooth((t - r.t0) / r.T);
      const T = this.targetOf(r.hand, f.targets);
      const from = add(r.from, sc(r.fromV, Math.min(t - r.t0, r.T)));
      if (T) { this.p = lerp(from, T.p, s); this.v = lerp(r.fromV, T.v || [0, 0, 0], s); }
      if (s >= 1) {
        this.recovery = null;
        if (T) { this.hold = { hand: r.hand, off: [0, 0, 0], offV: [0, 0, 0], attach: qmul(qinv(T.q), this.q), t0: t }; }
      }
      return;
    }
    const bad = !finite3(this.p) || !finite3(this.v);
    if (bad) { this.stats.nan++; this.recover(t, f, 'NaN', null, true); return; }
    if (this.p[1] < cfg.floorY + cfg.R - cfg.floorTol) { this.stats.floorViolations++; this.logLine(`floor correction ${(100 * (cfg.floorY + cfg.R - this.p[1])).toFixed(1)} cm`, t); this.p[1] = cfg.floorY + cfg.R; if (this.v[1] < 0) this.v[1] = 0; }
    const pl = f.player;
    // (a pass or pick-up in flight starts wherever the ball was — under the hoop after a shot — and
    // follows its own planned toss to the hands: it may be far from the player by design)
    const passing = this.flight?.kind === 'pass';
    if (pl && !passing && Math.hypot(this.p[0] - pl.pos[0], this.p[2] - pl.pos[1]) > cfg.maxDistFromPlayer) this.recover(t, f, 'too far from the player');
  }
  /** Hidden correction: blend from where the ball is into the expected hand's target, then hold. */
  recover(t, f, reason, hand = null, snap = false) {
    const want = hand || this.expected || this.hold?.hand || this.flight?.toHand || 'right';
    const h = want === 'both' ? 'both' : want;
    const T = this.targetOf(h, f.targets);
    this.recoveries++;
    this.logLine(`RECOVERY (${reason}) → ${h}`, t);
    this.events.push({ type: 'recovery', reason, t, hand: h });
    const next = `HELD_${H[h]}`;
    if (!this.go(next, 'recovery: ' + reason, t)) { this.state = next; this.since = t; }
    this.flight = null; this.fitOff = null; this.fitV = null;
    if (snap || !finite3(this.p)) {
      if (T) { this.p = T.p.slice(); this.v = (T.v || [0, 0, 0]).slice(); }
      this.hold = { hand: h, off: [0, 0, 0], offV: [0, 0, 0], attach: [0, 0, 0, 1], t0: t };
      return;
    }
    this.recovery = { t0: t, T: this.cfg.recoverTime, from: this.p.slice(), fromV: finite3(this.v) ? this.v.slice() : [0, 0, 0], reason, hand: h };
    this.hold = { hand: h, off: [0, 0, 0], offV: [0, 0, 0], attach: T ? qmul(qinv(T.q), this.q) : [0, 0, 0, 1], t0: t };
  }

  // ── IK weights per hand (smooth, rate-limited): the session applies them with the limits
  updateIk(dt, f) {
    const c = this.cfg, want = { left: 0, right: 0 }, st = this.state;
    const curve = (tau) => (tau > c.ikFar ? 0 : tau > c.ikNear ? 0.2 * smooth((c.ikFar - tau) / (c.ikFar - c.ikNear)) : tau > c.ikContact ? 0.2 + 0.4 * smooth((c.ikNear - tau) / (c.ikNear - c.ikContact)) : 0.6 + 0.4 * smooth((c.ikContact - tau) / c.ikContact));
    if (isHeld(st)) {
      const hands = handOf(st) === 'both' ? ['left', 'right'] : [handOf(st)];
      const settled = this.hold && this.t - this.hold.t0 > 0.15 && len(this.hold.off) < 0.01 && !(this.heldPush > 0.005);
      for (const h of hands) want[h] = settled ? c.ikHoldSettled : 1;
    } else if (/^(DRIBBLE_UP_|CATCH_)/.test(st) || st === 'PASS_RELEASE') {
      const h = this.flight?.toHand; if (h && h !== 'both') want[h] = /^CATCH_/.test(st) ? 1 : curve((this.flight.tc || 0) - this.t);
    } else if (/^RELEASE_/.test(st)) {
      const h = handOf(st); want[h] = 1 - smooth((this.t - this.since) / c.ikReleaseFade);
    }
    for (const h of ['left', 'right']) {
      const d = want[h] - this.ik[h], m = c.ikRate * dt;
      this.ik[h] = clamp(this.ik[h] + clamp(d, -m, m), 0, 1);
    }
  }

  // ── compact state (networking, replays): enough to re-evaluate the ball deterministically
  snapshot() {
    const r = (a) => a.map((x) => +x.toFixed(4));
    return {
      s: this.state, t: +this.t.toFixed(4), since: +this.since.toFixed(4), move: this.moveId, u: this.u,
      p: r(this.p), v: r(this.v), q: r(this.q),
      hold: this.hold ? { h: this.hold.hand, off: r(this.hold.off), a: r(this.hold.attach) } : null,
      fl: this.flight ? { k: this.flight.kind, from: this.flight.fromHand, to: this.flight.toHand, tr: this.flight.tr, tb: this.flight.tb ?? null, tc: this.flight.tc, down: packSegment(this.flight.down), up: packSegment(this.flight.up), toss: packSegment(this.flight.toss), bounce: this.flight.bounceAt ? r(this.flight.bounceAt) : null, ev: this.flight.eventIds } : null,
    };
  }
  restore(o) {
    this.state = o.s; this.t = o.t; this.since = o.since; this.moveId = o.move; this.u = o.u;
    this.p = o.p.slice(); this.v = o.v.slice(); this.q = o.q.slice();
    this.hold = o.hold ? { hand: o.hold.h, off: o.hold.off.slice(), offV: [0, 0, 0], attach: o.hold.a.slice(), t0: o.t } : null;
    this.flight = o.fl ? { kind: o.fl.k, fromHand: o.fl.from, toHand: o.fl.to, tr: o.fl.tr, tb: o.fl.tb, tc: o.fl.tc, down: unpackSegment(o.fl.down), up: unpackSegment(o.fl.up), toss: unpackSegment(o.fl.toss), bounceAt: o.fl.bounce, catchAt: (unpackSegment(o.fl.up) || unpackSegment(o.fl.toss))?.p1, eventIds: o.fl.ev || {} } : null;
  }
  /** Ball position at time t from the snapshot state alone (what a remote client would draw). */
  evaluate(t) {
    const fl = this.flight;
    if (!fl) return this.p.slice();
    const seg = fl.toss || (t <= fl.tb ? fl.down : fl.up);
    return segPos(seg, t);
  }
  /** The planned path (debug drawing): points from now to the catch, with the event points. */
  plannedPath(n = 40) {
    const fl = this.flight;
    if (!fl) return null;
    const pts = [];
    const t0 = fl.tr, t1 = fl.tc;
    for (let k = 0; k <= n; k++) { const t = t0 + ((t1 - t0) * k) / n; const seg = fl.toss || (t <= fl.tb ? fl.down : fl.up); pts.push({ t, p: segPos(seg, t), past: t <= this.t }); }
    return { pts, release: fl.toss ? segPos(fl.toss, t0) : segPos(fl.down, t0), bounce: fl.bounceAt || null, catch: fl.catchAt, tb: fl.tb ?? null, tc: fl.tc, tr: fl.tr, kind: fl.kind, fromHand: fl.fromHand, toHand: fl.toHand };
  }
}
