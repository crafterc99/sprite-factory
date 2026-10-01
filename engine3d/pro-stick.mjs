/**
 * Pro stick: every ball-handling move on the right stick (NBA 2K style), relative to the player's
 * facing and the hand the ball is in. Pure JS (no three.js, no DOM): the court (court3d.html, as
 * /js/pro-stick.mjs) and the node tests (tests/helpers/ball-harness.mjs) run the same code.
 *
 *   ProStick        the recognizer: raw stick samples → a gesture (flick / hold / spin)
 *   stickTheta      the stick (screen-relative, as the left stick) → θ in the player's own frame:
 *                   0 = forward, +90 = toward the free (off) hand, −90 = toward the ball hand, ±180 = back
 *   sectorOf        θ → the move: hesitation · crossover · between the legs · behind the back · step-back · in-and-out
 *   resolveGesture  the move → the role the library has (a move with no clip falls back: btb → btl → crossover → a hand switch)
 *   routeGesture    the gates (no ball, the shot button held, a shot playing), the ball hand, θ, the role,
 *                   the double crossover combo
 *
 * Flick sectors (θ, degrees):   |θ| < 35 hesitation · 35…105 crossover · 105…150 between the legs ·
 * |θ| ≥ 150 behind the back · −150…−105 step-back · −105…−35 in-and-out. A ¼ or ½ circle is a spin;
 * holding a direction is a size-up (no size-up clip: that direction's move, once per push).
 * Double crossover (live on main as "flick left, then right"): a crossover flick, then within 0.5 s a flick
 * straight back (≥ 120° from it) while the ball is still in the hand it was in — with the ball in the right
 * hand and the chase camera: left, then right. (The ball already on its way to the other hand: the second
 * flick is that hand's own move — a crossover back.)
 */

export const PRO_STICK_DEFAULTS = {
  start: 0.30, end: 0.22,                  // an excursion starts at r ≥ 0.30 and ends at r < 0.22 (hysteresis)
  flickPeak: 0.65, flickRiseMs: 180, flickMaxMs: 420, dirFrac: 0.85,
  rim: 0.80, holdMs: 220, holdDriftDeg: 22,
  rotR: 0.60, rotMinDeg: 75, rotMaxMs: 500,
  rotMaxStepDeg: 100,                      // one sample turning further is the stick crossing the centre (a rebound), not a circle
  cooldownMs: 150, reboundMs: 140, reboundDeg: 60, reboundPeak: 0.9,
  swingDeg: 120,                           // two samples further apart than this at the rim: the stick swung straight through the centre (two flicks)
};
/** The double crossover combo: the second flick within ms of the first, turned ≥ minTurnDeg from it (in his frame). */
export const COMBO = Object.freeze({ ms: 500, minTurnDeg: 120 });
/**
 * The arrow keys as the right stick: digital diagonals sweep 90° by accident (← ↙ ↓ is a flick), a roll through
 * four arrow states sweeps 135° (↓ ↘ → ↗ is a spin) — the threshold sits between them, clear of float rounding;
 * a key is held longer than a thumb flick.
 */
export const KEYBOARD_STICK = { rotMinDeg: 120, holdMs: 260 };
/** The last fallback of a hand-changing move with no clip: the idle's crossover dribble. */
export const HAND_SWITCH = '#handSwitch';
/** Each gesture's roles, best first (the first one the library has plays). */
export const GESTURE_ROLES = {
  hesi: ['move-hesi'],
  inout: ['move-inout', 'move-hesi'],
  crossover: ['move-crossover', HAND_SWITCH],
  btl: ['move-btl', 'move-crossover', HAND_SWITCH],
  btb: ['move-btb', 'move-btl', 'move-crossover', HAND_SWITCH],
  stepback: ['move-stepback'],
  spin: ['move-spin'],
  sizeup: ['move-sizeup'],
  doublecross: ['move-double-cross'],
};
export const GESTURE_NAMES = { hesi: 'Hesitation', inout: 'In-and-out', crossover: 'Crossover', btl: 'Between the legs', btb: 'Behind the back', stepback: 'Step-back', spin: 'Spin', sizeup: 'Size-up', doublecross: 'Double crossover' };

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const angDist = (a, b) => Math.abs(wrap180(a - b));

/**
 * The gesture recognizer. Feed it one sample per frame (both axes raw, y down = pulled back; t in ms):
 *   flick  out past 0.65 within 180 ms and back to the centre within 420 ms — fires on the return,
 *          its direction the circular mean of the samples ≥ 0.85 × the peak
 *   hold   at the rim (≥ 0.8) with a steady angle (≤ 22° drift) for 220 ms — fires once
 *   spin   ≥ 75° of net travel along the rim (≥ 0.6) inside 500 ms — fires at once
 * One gesture per excursion, 150 ms apart at least (a full flick straight back excepted: the double
 * crossover's second flick); the stick springing back (an excursion starting
 * within 140 ms of the last one's end, opposite it within 60°, peaking under 0.9) is ignored. A stick swung
 * straight across (two samples ≥ 120° apart, both out — a fast flick back at a low frame rate never reads the
 * centre) ends the first excursion there and starts the next: two flicks, not one averaged into a third
 * direction.
 */
export class ProStick {
  constructor(cfg = {}) { this.cfg = { ...PRO_STICK_DEFAULTS, ...cfg }; this.reset(); }
  reset() { this.ex = null; this.lastEnd = null; this.lastFire = -1e9; this.lastFireA = null; }
  /**
   * One sample: x, y raw stick (y down = pulled back), t ms.
   * @returns {null | { kind: 'flick'|'hold'|'spin', a: number (deg, 0 = stick up, +90 = right), dir: [x, y], t, peak?, sweep? }}
   */
  sample(x, y, t) {
    const c = this.cfg;
    if (!Number.isFinite(x) || !Number.isFinite(y)) x = y = 0;
    const r = Math.min(1, Math.hypot(x, y)), a = Math.atan2(x, -y) * 180 / Math.PI;
    let e = this.ex;
    let swung = null;
    // swung straight across the centre between two samples: the first excursion ends here, the next starts now
    if (e && r >= c.start && e.lastR >= c.start && angDist(a, e.lastA) >= c.swingDeg) { swung = this.endExcursion(e, t); e = this.ex = null; }
    if (!e) {
      if (r < c.start) return null;
      e = this.ex = { t0: t, tPeak: null, peak: 0, near: [], u: a, hist: [], steadyT: null, steadyA: a, done: false, lastA: a, lastR: 0,
        rebound: !!this.lastEnd && t - this.lastEnd.t <= c.reboundMs && angDist(a, this.lastEnd.a + 180) <= c.reboundDeg };
    }
    if (r < c.end) { this.ex = null; return this.endExcursion(e, t); }   // back to the centre: the excursion ends → maybe a flick
    if (r > e.peak) e.peak = r;
    if (e.tPeak == null && r >= c.flickPeak) e.tPeak = t;
    if (t - e.t0 <= c.flickMaxMs) e.near.push({ r, a });   // (a flick is over by then: a long hold keeps no history)
    if (!e.done) {
      if (r >= c.rotR) {                               // rotation: net travel along the rim inside rotMaxMs
        const step = e.hist.length ? wrap180(a - e.lastA) : 0;
        if (Math.abs(step) > c.rotMaxStepDeg) e.hist = [];   // (through the centre between two samples: not a circle)
        e.u = e.hist.length ? e.u + step : a;
        e.hist.push({ t, u: e.u });
        while (e.hist.length && t - e.hist[0].t > c.rotMaxMs) e.hist.shift();
        let best = 0; for (const h of e.hist) if (Math.abs(e.u - h.u) > Math.abs(best)) best = e.u - h.u;
        if (Math.abs(best) >= c.rotMinDeg) { e.done = true; e.lastA = a; e.lastR = r; return this.fire({ kind: 'spin', a, sweep: best }, t); }
      } else e.hist = [];
      if (r >= c.rim) {                                // hold: out at the rim, the angle steady
        if (e.steadyT == null || angDist(a, e.steadyA) > c.holdDriftDeg) { e.steadyT = t; e.steadyA = a; }
        else if (t - e.steadyT >= c.holdMs) { e.done = true; e.lastA = a; e.lastR = r; return this.fire({ kind: 'hold', a: e.steadyA, peak: e.peak }, t); }
      } else e.steadyT = null;
    }
    e.lastA = a; e.lastR = r; return swung;
  }
  /** An excursion ends (back at the centre, or swung across it): a flick, if it was one. */
  endExcursion(e, t) {
    const c = this.cfg, dirA = this.dirOf(e); this.lastEnd = { t, a: dirA };
    if (e.done || e.peak < c.flickPeak || (e.rebound && e.peak < c.reboundPeak)) return null;
    if (e.tPeak == null || e.tPeak - e.t0 > c.flickRiseMs || t - e.t0 > c.flickMaxMs) return null;
    return this.fire({ kind: 'flick', a: dirA, peak: e.peak }, t);
  }
  /** The excursion's direction: the circular mean of its samples at ≥ dirFrac × its peak. */
  dirOf(e) { const k = this.cfg.dirFrac * e.peak; let sx = 0, sy = 0; for (const q of e.near) if (q.r >= k) { sx += Math.sin(q.a * Math.PI / 180); sy += Math.cos(q.a * Math.PI / 180); } return Math.atan2(sx, sy) * 180 / Math.PI; }
  /**
   * A gesture fires — not within cooldownMs of the last one, unless it is a full flick straight back (≥ swingDeg
   * from the last one, peak ≥ reboundPeak): the double crossover's second flick comes that fast.
   */
  fire(g, t) {
    const c = this.cfg, back = g.kind === 'flick' && this.lastFireA != null && (g.peak ?? 0) >= c.reboundPeak && angDist(g.a, this.lastFireA) >= c.swingDeg;
    if (t - this.lastFire < c.cooldownMs && !back) return null;
    this.lastFire = t; this.lastFireA = g.a;
    const rad = g.a * Math.PI / 180; return { ...g, t, dir: [Math.sin(rad), -Math.cos(rad)] };
  }
  debug() { return { out: !!this.ex, peak: this.ex?.peak || 0, lastFire: this.lastFire }; }
}

/**
 * The stick direction [x, y-down] → θ (degrees) in the player's own frame, + toward the free hand.
 * The stick is read relative to the screen, exactly as the left stick (court3d.html gameTick):
 * world = camRight · x − camFwd · y (camFwd / camRight: the camera's forward and right on the floor, [x, z]).
 * Then into the player's frame (yaw: facing [sin yaw, cos yaw]): lz forward, lx his LEFT.
 */
export function stickTheta(dir, camFwd, camRight, yaw, hand) {
  const wx = camRight[0] * dir[0] - camFwd[0] * dir[1], wz = camRight[1] * dir[0] - camFwd[1] * dir[1];
  const c = Math.cos(yaw), s = Math.sin(yaw), lx = c * wx - s * wz, lz = s * wx + c * wz;
  return Math.atan2(hand === 'left' ? -lx : lx, lz) * 180 / Math.PI;
}
/** θ → the flick's move. */
export function sectorOf(th) {
  const a = Math.abs(th);
  if (a < 35) return 'hesi';
  if (a >= 150) return 'btb';
  if (th > 0) return th < 105 ? 'crossover' : 'btl';
  return th > -105 ? 'inout' : 'stepback';
}
/** The hand the ball is in: held, else on its way to (a crossover in the air), else the dribble hand. */
export function ballHandOf(ctl, P) {
  const h = ctl?.heldHand; if (h === 'left' || h === 'right') return h;
  const to = ctl?.flight?.toHand; if (to === 'left' || to === 'right') return to;
  return P?.hand === 'left' ? 'left' : 'right';
}
/**
 * A gesture + θ → the role to request, from the roles the library has (lib[role]); a hand-changing
 * move with no clip at all falls back to the crossover dribble (canSwitch: the idle has a mirror).
 * @returns {{ gesture, kind, theta, role: string|null, handSwitch: boolean, fellBack: boolean, missing: boolean }}
 */
export function resolveGesture(g, theta, lib, { canSwitch = true } = {}) {
  let gesture = g.kind === 'spin' ? 'spin' : sectorOf(theta);
  if (g.kind === 'hold' && lib['move-sizeup']) gesture = 'sizeup';
  const chain = GESTURE_ROLES[gesture];
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r === HAND_SWITCH ? canSwitch : !!lib[r]) return { gesture, kind: g.kind, theta, role: r === HAND_SWITCH ? null : r, handSwitch: r === HAND_SWITCH, fellBack: i > 0, missing: false };
  }
  return { gesture, kind: g.kind, theta, role: null, handSwitch: false, fellBack: false, missing: true };
}
/**
 * The double crossover: this flick and the previous routed gesture (prev: routeGesture's result) make the
 * combo — a crossover flick, then within COMBO.ms a flick turned ≥ COMBO.minTurnDeg from it in his frame (φ),
 * with the ball still in (or on its way back to) the hand it was in: the first flick's crossover has not let
 * go of it yet (hand: ballHandOf now).
 */
export function isDoubleCross(prev, g, phi, hand, cfg = COMBO) {
  if (!prev || prev.ignored || prev.combo || prev.kind !== 'flick' || g.kind !== 'flick' || prev.gesture !== 'crossover') return false;
  if (!(g.t - prev.t <= cfg.ms) || angDist(phi, prev.phi) < cfg.minTurnDeg) return false;
  return hand === prev.hand;
}
/**
 * Everything the court does with a gesture (shared with the node harness): the gates, the hand, θ, the role.
 * No ball, the shot button held or a shot playing: ignored (never buffered — it cannot fire after the pass back).
 * prev: the last gesture this routed (the double crossover combo); the result carries t and φ (his frame,
 * + toward his left) for the next one.
 */
export function routeGesture(g, { P, ctl, lib, camFwd, camRight, shootHeld = false, prev = null }) {
  if (!P.hasBall || P.ballFree) return { ignored: 'no ball', kind: g.kind, t: g.t };
  if (shootHeld) return { ignored: 'shooting', kind: g.kind, t: g.t };
  if (P.mode === 'action' && P.action?.clip?.shot) return { ignored: 'shot', kind: g.kind, t: g.t };
  const hand = ballHandOf(ctl, P), theta = stickTheta(g.dir, camFwd, camRight, P.yaw, hand), phi = stickTheta(g.dir, camFwd, camRight, P.yaw, 'right');
  if (lib['move-double-cross'] && isDoubleCross(prev, g, phi, hand)) return { gesture: 'doublecross', kind: g.kind, theta, role: 'move-double-cross', handSwitch: false, fellBack: false, missing: false, combo: true, hand, phi, t: g.t };
  return { ...resolveGesture(g, theta, lib, { canSwitch: !!lib['idle:mirror'] }), hand, phi, t: g.t };
}
/** The on-screen note for a gesture with no clip of its own (null: it played as asked). */
export function gestureNote(res, roleNames = {}) {
  if (res.ignored) return null;
  const n = GESTURE_NAMES[res.gesture];
  if (res.missing) return `${n} — no clip yet`;
  if (res.fellBack) return `${n} → ${res.handSwitch ? 'crossover dribble' : (roleNames[res.role] || res.role)} (no ${n.toLowerCase()} clip yet)`;
  return null;
}
