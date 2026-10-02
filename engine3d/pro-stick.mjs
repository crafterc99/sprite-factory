/**
 * Pro stick: every ball-handling move on the right stick (NBA 2K style), relative to the player's facing and the
 * hand the ball is in — read against the user's move bindings (engine3d/move-controls.mjs). Pure JS (no three.js,
 * no DOM): the court (court3d.html, as /js/pro-stick.mjs) and the node tests (tests/helpers/ball-harness.mjs) run
 * the same code.
 *
 *   ProStick      the segmenter: raw stick samples → gestures (flick / hold / spin / release), with its proven
 *                 filters (deadzone hysteresis, spring-back, swing-across split, cooldown)
 *   stickTheta    the stick (screen-relative, as the left stick) → θ in the player's own frame:
 *                 0 = forward, +90 = toward the free (off) hand, −90 = toward the ball hand, ±180 = back
 *   MoveControls  the recognizer: every tick the sticks' gestures → steps in his frame (relative to the ball hand,
 *                 mirrored in the left hand) → matched against every binding (sequences: the longest match wins; a
 *                 single move a combo starts with plays at once and upgrades, or the combo waits) → the move. It
 *                 ALWAYS reads a move from an attempt: no binding near enough → the nearest single-step binding.
 *                 Also: recording a trigger, the conflicts, the live event stream for a test view, the registry.
 *   routeGesture  (stateless, the default bindings) one gesture + the previous read → the read — the old API
 *
 * The defaults are the old fixed mapping at 45° (move-controls.mjs DEFAULT_BINDINGS): toward the free hand
 * crossover · toward the ball hand in-and-out · back-diagonal free side between the legs · back-diagonal ball side
 * step-back · straight back behind the back · forward hesitation · a ¼ or ½ circle spin · a hold size-up (no
 * size-up clip: the hold is a flick of its direction, once per push) · a crossover flick, then within 0.5 s one
 * straight back (≥ 120° from it) the double crossover. A move with no clip falls back (btb → btl → crossover → the
 * crossover dribble; in-and-out → hesitation) or says so (gestureNote).
 */
import {
  DEFAULT_TOL, DEFAULT_GAP, DEFAULT_HOLD_MS, MAX_STEPS, HAND_SWITCH, ROLE_FALLBACKS, ROLE_GESTURE, GESTURE_NAMES,
  defaultControls, validateControls, normalizeBinding, conflictsOf, quantizeAngle, norm360, wrap180, angDist,
  roleLabel, describeBinding, moveRegistry,
} from './move-controls.mjs';

export { HAND_SWITCH, GESTURE_NAMES, ROLE_GESTURE };

export const PRO_STICK_DEFAULTS = {
  start: 0.30, end: 0.22,                  // an excursion starts at r ≥ 0.30 and ends at r < 0.22 (hysteresis)
  flickPeak: 0.65, flickRiseMs: 180, flickMaxMs: 420, dirFrac: 0.85,
  rim: 0.80, holdMs: 220, holdDriftDeg: 22,
  rotR: 0.60, rotMinDeg: 75, rotMaxMs: 500,
  rotMaxStepDeg: 100,                      // one sample turning further is the stick crossing the centre (a rebound), not a circle
  cooldownMs: 150, reboundMs: 140, reboundDeg: 60, reboundPeak: 0.9,
  swingDeg: 120,                           // two samples further apart than this at the rim: the stick swung straight through the centre (two flicks)
  slowFlick: true,                         // a push past flickPeak too slow for a flick and never steady for a hold still reads: a flick (slow)
  holdLevels: [],                          // longer holds a binding asks for (ms > holdMs): the same hold reported again (ext) at each
  spinLevels: [],                          // further turns a binding asks for (180, 270, 360): the same circle again (ext), 15° early
  releases: false,                         // the stick let go after a hold / a circle: a 'release' gesture
};
/** The double crossover's old window: the second flick within ms of the first, turned ≥ minTurnDeg (DEFAULT_BINDINGS: gap 500, tol 180 − 120). */
export const COMBO = Object.freeze({ ms: 500, minTurnDeg: 120 });
/**
 * The arrow keys as the right stick: digital diagonals sweep 90° by accident (← ↙ ↓ is a flick), a roll through
 * four arrow states sweeps 135° (↓ ↘ → ↗ is a spin) — the threshold sits between them, clear of float rounding;
 * a key is held longer than a thumb flick.
 */
export const KEYBOARD_STICK = { rotMinDeg: 120, holdMs: 260 };

const nextLevel = (levels, cur) => { let n = null; for (const l of levels || []) if (l > cur + 1e-9 && (n == null || l < n)) n = l; return n; };
const dirOfA = (a) => { const rad = a * Math.PI / 180; return [Math.sin(rad), -Math.cos(rad)]; };

/**
 * The gesture segmenter. Feed it one sample per frame (both axes raw, y down = pulled back; t in ms):
 *   flick  out past 0.65 within 180 ms and back to the centre within 420 ms — fires on the return,
 *          its direction the circular mean of the samples ≥ 0.85 × the peak; slower (and never a hold): a flick,
 *          slow: true (an attempt always reads)
 *   hold   at the rim (≥ 0.8) with a steady angle (≤ 22° drift) for 220 ms — fires once (ms: how long), and again
 *          (ext) at each longer level a binding asks for (holdLevels)
 *   spin   ≥ 75° of net travel along the rim (≥ 0.6) inside 500 ms — fires at once (turn 90), and again (ext) at
 *          each further turn a binding asks for (spinLevels: 180 at ≥ 165° …)
 *   release  (releases on) back at the centre after a hold / a spin
 * One gesture per excursion (its extensions and release aside: same ex), 150 ms apart at least (a full flick
 * straight back excepted: the double crossover's second flick); the stick springing back (an excursion starting
 * within 140 ms of the last one's end, opposite it within 60°, peaking under 0.9) is ignored. A stick swung
 * straight across (two samples ≥ 120° apart, both out — a fast flick back at a low frame rate never reads the
 * centre) ends the first excursion there and starts the next: two flicks, not one averaged into a third
 * direction. Below r 0.30 (and a nudge peaking under 0.65) is noise: nothing.
 */
export class ProStick {
  constructor(cfg = {}) { this.cfg = { ...PRO_STICK_DEFAULTS }; this.configure(cfg); this.exN = 0; this.reset(); }
  /** Change the config (the move bindings' hold / spin levels and releases): takes effect from the next excursion. */
  configure(cfg = {}) {
    this.cfg = { ...this.cfg, ...cfg };
    for (const k of ['holdLevels', 'spinLevels']) this.cfg[k] = [...new Set((this.cfg[k] || []).filter(Number.isFinite))].sort((a, b) => a - b);
    return this;
  }
  reset() { this.ex = null; this.lastEnd = null; this.lastFire = -1e9; this.lastFireA = null; }
  /**
   * One sample: x, y raw stick (y down = pulled back), t ms.
   * @returns {null | { kind: 'flick'|'hold'|'spin'|'release', a: number (deg, 0 = stick up, +90 = right), dir: [x, y], t,
   *                    ex (the excursion), t0 (its start), peak?, sweep?, turn?, ms?, slow?, ext? }}
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
      e = this.ex = { id: ++this.exN, t0: t, tPeak: null, peak: 0, near: [], tail: [], u: a, hist: [], steadyT: null, steadyA: a, done: null, fired: false, lastA: a, lastR: 0,
        rebound: !!this.lastEnd && t - this.lastEnd.t <= c.reboundMs && angDist(a, this.lastEnd.a + 180) <= c.reboundDeg };
    }
    if (r < c.end) { this.ex = null; return this.endExcursion(e, t); }   // back to the centre: the excursion ends → maybe a flick
    if (r > e.peak) e.peak = r;
    if (e.tPeak == null && r >= c.flickPeak) e.tPeak = t;
    if (t - e.t0 <= c.flickMaxMs) e.near.push({ r, a });   // (a flick is over by then: a long excursion keeps a short tail only)
    else { e.tail.push({ r, a }); if (e.tail.length > 40) e.tail.shift(); }
    if (!e.done) {
      if (r >= c.rotR) {                               // rotation: net travel along the rim inside rotMaxMs
        const step = e.hist.length ? wrap180(a - e.lastA) : 0;
        if (Math.abs(step) > c.rotMaxStepDeg) e.hist = [];   // (through the centre between two samples: not a circle)
        e.u = e.hist.length ? e.u + step : a;
        e.hist.push({ t, u: e.u });
        while (e.hist.length && t - e.hist[0].t > c.rotMaxMs) e.hist.shift();
        let best = 0; for (const h of e.hist) if (Math.abs(e.u - h.u) > Math.abs(best)) best = e.u - h.u;
        if (Math.abs(best) >= c.rotMinDeg) {
          e.done = 'spin'; e.lastA = a; e.lastR = r;
          e.spinU0 = e.u - best; e.spinSign = Math.sign(best); e.spinT = t; e.spinNext = nextLevel(c.spinLevels, 90);
          const g = this.fire({ kind: 'spin', a, sweep: best, turn: 90, ex: e.id, t0: e.t0 }, t);
          e.fired = !!g; return g;
        }
      } else e.hist = [];
      if (r >= c.rim) {                                // hold: out at the rim, the angle steady
        if (e.steadyT == null || angDist(a, e.steadyA) > c.holdDriftDeg) { e.steadyT = t; e.steadyA = a; }
        else if (t - e.steadyT >= c.holdMs) {
          e.done = 'hold'; e.lastA = a; e.lastR = r; e.holdNext = nextLevel(c.holdLevels, t - e.steadyT);
          const g = this.fire({ kind: 'hold', a: e.steadyA, peak: e.peak, ms: Math.round(t - e.steadyT), ex: e.id, t0: e.t0 }, t);
          e.fired = !!g; return g;
        }
      } else e.steadyT = null;
    } else {
      const g = this.extend(e, r, a, t);
      e.lastA = a; e.lastR = r;
      if (g) return g;
      return swung;
    }
    e.lastA = a; e.lastR = r; return swung;
  }
  /** A hold / circle that already fired goes on: reported again at the next level a binding asks for (ext). */
  extend(e, r, a, t) {
    const c = this.cfg;
    if (!e.fired) return null;
    if (e.done === 'hold' && e.holdNext != null) {
      if (r < c.rim || angDist(a, e.steadyA) > c.holdDriftDeg) { e.holdNext = null; return null; }   // (let go of the rim or turned: over)
      const ms = t - e.steadyT;
      if (ms >= e.holdNext) { e.holdNext = nextLevel(c.holdLevels, ms); return this.extOut({ kind: 'hold', a: e.steadyA, peak: e.peak, ms: Math.round(ms), ex: e.id, t0: e.t0 }, t); }
    }
    if (e.done === 'spin' && e.spinNext != null) {
      const step = wrap180(a - e.lastA);
      if (r < c.rotR || Math.abs(step) > c.rotMaxStepDeg || t - e.spinT > 2 * c.rotMaxMs) { e.spinNext = null; return null; }
      e.u += step;
      const turned = (e.u - e.spinU0) * e.spinSign;
      if (turned >= e.spinNext - 15) { const turn = e.spinNext; e.spinNext = nextLevel(c.spinLevels, turn); return this.extOut({ kind: 'spin', a, sweep: e.u - e.spinU0, turn, ex: e.id, t0: e.t0 }, t); }
    }
    return null;
  }
  extOut(g, t) { return { ...g, ext: true, t, dir: dirOfA(g.a) }; }
  /** An excursion ends (back at the centre, or swung across it): a flick, if it was one (or the release of a hold / circle). */
  endExcursion(e, t) {
    const c = this.cfg, dirA = this.dirOf(e); this.lastEnd = { t, a: dirA };
    if (e.done) return c.releases && e.fired ? { kind: 'release', a: e.lastA, after: e.done, ms: Math.round(t - e.t0), ex: e.id, t0: e.t0, t, dir: dirOfA(e.lastA) } : null;
    if (e.peak < c.flickPeak || (e.rebound && e.peak < c.reboundPeak)) return null;
    if (e.tPeak != null && e.tPeak - e.t0 <= c.flickRiseMs && t - e.t0 <= c.flickMaxMs) return this.fire({ kind: 'flick', a: dirA, peak: e.peak, ex: e.id, t0: e.t0 }, t);
    // too slow for a flick, never steady enough for a hold: still an attempt (its direction from the whole push)
    return c.slowFlick ? this.fire({ kind: 'flick', a: this.dirOf(e, true), peak: e.peak, slow: true, ex: e.id, t0: e.t0 }, t) : null;
  }
  /** The excursion's direction: the circular mean of its samples at ≥ dirFrac × its peak (all: its tail too). */
  dirOf(e, all = false) { const k = this.cfg.dirFrac * e.peak; let sx = 0, sy = 0; for (const q of all ? e.near.concat(e.tail) : e.near) if (q.r >= k) { sx += Math.sin(q.a * Math.PI / 180); sy += Math.cos(q.a * Math.PI / 180); } return Math.atan2(sx, sy) * 180 / Math.PI; }
  /**
   * A gesture fires — not within cooldownMs of the last one, unless it is a full flick straight back (≥ swingDeg
   * from the last one, peak ≥ reboundPeak): the double crossover's second flick comes that fast.
   */
  fire(g, t) {
    const c = this.cfg, back = g.kind === 'flick' && this.lastFireA != null && (g.peak ?? 0) >= c.reboundPeak && angDist(g.a, this.lastFireA) >= c.swingDeg;
    if (t - this.lastFire < c.cooldownMs && !back) return null;
    this.lastFire = t; this.lastFireA = g.a;
    return { ...g, t, dir: dirOfA(g.a) };
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
/**
 * θ → the old fixed mapping's move (before bindings; kept for reference — the recognizer reads the bindings, whose
 * defaults are this at 45°: the borders moved to the midpoints between the bound angles).
 */
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

// ── steps and matching ────────────────────────────────────────────────────
const ATTEMPT = new Set(['flick', 'hold', 'spin']);
/**
 * A gesture → a step in his frame: a relative to the ball hand (as if in the right hand: 0 forward, 90 the ball
 * hand, 270 the free hand — mirrored with the ball in the left), ar his own (90 = his right whatever the hand);
 * a circle's sense rot (cw = from forward toward the ball hand) / rotR (cw = toward his right).
 */
export function stepOf(g, { theta, phi, hand }) {
  const s = { kind: g.kind, a: +norm360(-theta).toFixed(2), ar: +norm360(-phi).toFixed(2), hand, t: g.t, ex: g.ex ?? null, src: g.src ?? null };
  if (g.kind === 'spin') { const sw = g.sweep || 0; s.rotR = sw >= 0 ? 'cw' : 'ccw'; s.rot = (hand === 'left' ? -sw : sw) >= 0 ? 'cw' : 'ccw'; s.turn = g.turn || 90; }
  if (g.kind === 'hold') s.ms = g.ms ?? DEFAULT_HOLD_MS;
  if (g.kind === 'release') s.after = g.after || null;
  if (g.ext) s.ext = true;
  if (g.slow) s.slow = true;
  return s;
}
/** The same step read with the ball in the other hand (a mirrored binding then reads it mirrored). */
export function otherHandStep(s) {
  const o = { ...s, a: norm360(360 - s.a), hand: s.hand === 'left' ? 'right' : 'left' };
  if (s.rot) o.rot = s.rot === 'cw' ? 'ccw' : 'cw';
  return o;
}
/** One step against one binding step: null, or { score (lower = nearer), grow (it would match if the hold / circle went on) }. */
export function matchStep(s, p, mirror = true) {
  const A = mirror ? s.a : s.ar;
  if ('flick' in p) { if (s.kind !== 'flick') return null; const d = angDist(A, p.flick); return d <= (p.tol ?? DEFAULT_TOL) + 1e-6 ? { score: d } : null; }
  if ('hold' in p) {
    if (s.kind !== 'hold') return null;
    let score = 45;
    if (p.hold !== 'any') { const d = angDist(A, p.hold); if (d > (p.tol ?? DEFAULT_TOL) + 1e-6) return null; score = d; }
    return (s.ms ?? 0) + 1e-6 >= (p.ms || 0) ? { score } : { score, grow: true };
  }
  if ('spin' in p) {
    if (s.kind !== 'spin') return null;
    if (p.spin !== 'any' && p.spin !== (mirror ? s.rot : s.rotR)) return null;
    const score = p.spin === 'any' ? 10 : 0;
    return (s.turn || 90) >= (p.turn || 90) ? { score } : { score, grow: true };
  }
  if ('release' in p) return s.kind === 'release' ? { score: 0 } : null;
  return null;
}
/** A binding's first k steps against the last k steps of seq (in order, each inside the previous step's gap). */
function tailMatch(seq, b, k) {
  const L = seq.length;
  if (k > L || k > b.steps.length) return null;
  const mirror = b.mirror !== false;
  let score = 0, grow = false;
  for (let i = 0; i < k; i++) {
    const s = seq[L - k + i], m = matchStep(s, b.steps[i], mirror);
    if (!m) return null;
    if (m.grow) { if (i < k - 1) return null; grow = true; }
    if (i > 0) { const p = seq[L - k + i - 1]; if (!((s.tb ?? s.t) - p.t <= (b.steps[i - 1].gap ?? DEFAULT_GAP) + 1e-6)) return null; }
    score += m.score;
  }
  return { score, grow };
}
const keyOf = (s) => `${s.src ?? ''}#${s.ex ?? ''}@${s.tb ?? s.t}`;
const stepView = (s) => ({ kind: s.kind, a: +s.a.toFixed(1), ar: +s.ar.toFixed(1), hand: s.hand, t: s.t, ...(s.rot ? { rot: s.rot, turn: s.turn } : {}), ...(s.ms != null ? { ms: s.ms } : {}), ...(s.slow ? { slow: true } : {}), ...(s.ext ? { ext: true } : {}) });
/** The role a binding plays from the clips the library has (lib[role]): itself, else its fallbacks, else missing. */
function resolveRole(b, env) {
  const chain = [b.role, ...(b.fallback || ROLE_FALLBACKS[b.role] || [])];
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r === HAND_SWITCH ? env.canSwitch : env.has(r)) return { role: r === HAND_SWITCH ? null : r, handSwitch: r === HAND_SWITCH, fellBack: i > 0, missing: false };
  }
  return { role: null, handSwitch: false, fellBack: false, missing: true };
}
/** The gates (no ball, the shot button held, a shot playing): a gesture then is ignored, never buffered. */
function gateOf(ctx) {
  const P = ctx?.P;
  if (!P) return null;
  if (!P.hasBall || P.ballFree) return 'no ball';
  if (ctx.shootHeld) return 'shooting';
  if (P.mode === 'action' && P.action?.clip?.shot) return 'shot';
  return null;
}
/** The ball hand and θ / φ of a gesture (court / harness context); env.has(role): the library has a clip. */
function envOf(g, ctx) {
  const { P, ctl, lib, camFwd = [0, 1], camRight = [-1, 0] } = ctx || {};
  const hand = ctx?.hand || ballHandOf(ctl, P), dir = g.dir || dirOfA(g.a ?? 0), yaw = P?.yaw ?? 0;
  return { hand, theta: stickTheta(dir, camFwd, camRight, yaw, hand), phi: stickTheta(dir, camFwd, camRight, yaw, 'right'), ...hasOf(lib) };
}
const hasOf = (lib) => (lib ? { has: (r) => !!lib[r], canSwitch: !!lib['idle:mirror'] } : { has: () => true, canSwitch: true });
/** Several reads at once (a wait that ended, then this one): the last, the others in before (request them first, in order). */
function combine(list) {
  const xs = list.filter(Boolean);
  if (!xs.length) return null;
  const last = xs[xs.length - 1];
  if (xs.length > 1) last.before = [...(last.before || []), ...xs.slice(0, -1)];
  return last;
}

/**
 * The recognizer: the sticks' gestures → the move, against the move bindings.
 *
 *   const mc = new MoveControls({ controls })          // controls: { bindings } (default: DEFAULT_BINDINGS)
 *   per frame:  g = mc.sample('pad', x, y, tMs)          // each stick source ('pad', 'kbd', …), every frame
 *               read = g ? mc.read(g, ctx) : mc.tick(tMs, ctx)
 *   ctx: { P (Player: hasBall, ballFree, mode, action, yaw, hand), ctl (BallController: heldHand, flight), lib
 *          (the roles the library has), camFwd, camRight ([x, z] on the floor), shootHeld }
 *   read: { role (to request; null = none), gesture, label, binding, kind, match: 'exact'|'nearest', nearest, combo,
 *           n (steps), steps, upgradeOf, degrade (a combo fired from the other hand plays this), hand, theta, phi,
 *           handSwitch, fellBack, missing, late?, before?: [reads to request first] }
 *         | { ignored: 'no ball'|'shooting'|'shot' } | { waiting: [roles], deadline } | { recording: role }
 *
 * Rules: a step continues the sequence when it comes inside the previous step's gap in the same ball hand (a step
 * from the other hand, or later, starts a new one). The longest complete match wins (then the nearest angles, then
 * the binding order); a combo (≥ 2 steps) counts only if it has a clip. A gesture that is a whole single move AND
 * how a combo starts: the single plays at once and the combo upgrades it (replacing it if it has not started), or
 * — a combo with mode 'wait', or a hold / circle that may still grow into a longer one — nothing plays until the
 * combo completes or its gap runs out (then the held moves play, late). A combo is never chained into another.
 * No binding near enough: the nearest single-step binding by angle (an attempt always reads a move). A hold no
 * playable hold binding takes is read as a flick of its direction.
 */
export class MoveControls {
  constructor({ controls = null, sticks = { pad: {}, kbd: KEYBOARD_STICK }, historyMax = 60, trailMax = 160 } = {}) {
    this.sticks = {};
    for (const [k, cfg] of Object.entries(sticks || {})) this.sticks[k] = new ProStick(cfg);
    this.listeners = new Set();
    this.hist = []; this.historyMax = historyMax;
    this.trailBuf = []; this.trailMax = trailMax; this.trailLast = {};
    this.testOn = false;
    this.rec = null;
    this.m = { seq: [], fired: null, pending: null, lastStep: null };
    const r = this.setControls(controls || defaultControls());
    if (!r.ok) throw new Error('invalid move controls: ' + r.errors.join('; '));
  }
  // ── the bindings ──
  /** Replace the bindings (validated; nothing changes when they are invalid). @returns {{ ok, errors, conflicts }} */
  setControls(c) {
    const v = validateControls(c);
    if (!v.ok) return { ok: false, errors: v.errors, conflicts: v.conflicts || [] };
    this.ctl = { ...v.clean, ...(c?.updatedAt ? { updatedAt: c.updatedAt } : {}) };
    this.bindings = this.ctl.bindings;
    this.maxGap = Math.max(DEFAULT_GAP, ...this.bindings.flatMap((b) => b.steps.map((s) => s.gap || 0))) + 50;
    this.applyLevels();
    this.resetMatch();
    this.emit({ type: 'bindings', controls: this.controls });
    return { ok: true, errors: [], conflicts: v.conflicts };
  }
  /** A copy of the controls: { version, bindings, updatedAt? }. */
  get controls() { return JSON.parse(JSON.stringify(this.ctl)); }
  /** What the sticks must report for these bindings: the longer holds, the further circles, releases. */
  recognizerConfig() {
    const steps = this.bindings.flatMap((b) => b.steps);
    const holdLevels = [...new Set(steps.filter((s) => 'hold' in s && s.ms).map((s) => s.ms))];
    const spinLevels = [...new Set(steps.filter((s) => 'spin' in s && s.turn > 90).map((s) => s.turn))];
    return { holdLevels, spinLevels, releases: steps.some((s) => 'release' in s) || holdLevels.length > 0 || spinLevels.length > 0 };
  }
  applyLevels() {
    const rc = this.recognizerConfig();
    for (const st of Object.values(this.sticks)) st.configure({ ...rc, holdLevels: rc.holdLevels.filter((ms) => ms > st.cfg.holdMs) });
  }
  /** Every binding x relates to (same trigger / prefix / extends / overlap) — excluding x's own role's other triggers when asked. */
  conflicts(binding, { exceptRole = null } = {}) {
    const r = normalizeBinding(binding);
    if (!r.ok) return [];
    return conflictsOf(r.binding, this.bindings.filter((b) => b.role !== exceptRole));
  }
  /** The move registry for this library (moveRegistry): roles = /api/mocap3d/library's roles, lib = the Player's library. */
  registry({ roles = {}, lib = {} } = {}) {
    const clips = {};
    for (const [k, v] of Object.entries(lib || {})) {
      if (!k.endsWith(':variants') || !Array.isArray(v)) continue;
      clips[k.slice(0, -9)] = v.map((c) => ({ id: c.json?.id ?? null, name: c.name, hand: c.hand, endHand: c.endHand }));
    }
    return moveRegistry({ roles, clips, bindings: this.bindings });
  }
  // ── input ──
  /** One raw stick sample of a source ('pad', 'kbd' …) → its gesture or null. Every source, every frame. */
  sample(src, x, y, t) {
    const st = this.sticks[src];
    if (!st) return null;
    const g = st.sample(x, y, t);
    const r = Number.isFinite(x) && Number.isFinite(y) ? Math.hypot(x, y) : 0;
    if (r >= 0.1 || this.trailLast[src]) {
      this.trailBuf.push({ src, x: +(+x || 0).toFixed(3), y: +(+y || 0).toFixed(3), t });
      if (this.trailBuf.length > this.trailMax) this.trailBuf.shift();
      if (this.testOn) this.emit({ type: 'sample', src, x, y, r, t });
    }
    this.trailLast[src] = r >= 0.1;
    if (g) g.src = src;
    return g;
  }
  /** The live test view: 'sample' events every frame the stick is out (off: only steps / reads). */
  test(on = true) { this.testOn = !!on; return this.testOn; }
  /** One gesture (sample's) → the read (or null: nothing to do yet). */
  read(g, ctx) {
    if (this.rec) return this.recordGesture(g, ctx);
    const gate = gateOf(ctx);
    if (gate) {
      this.resetMatch();
      const r = { ignored: gate, kind: g.kind, t: g.t };
      if (g.kind !== 'release' && !g.ext) { this.emit({ type: 'ignored', reason: gate, kind: g.kind, t: g.t }); this.remember(r); return r; }
      return null;
    }
    const env = envOf(g, ctx), s = stepOf(g, env);
    this.emit({ type: 'step', step: stepView(s), stick: { a: +(g.a ?? 0).toFixed(1), src: g.src ?? null }, trail: this.trail(g.src, g.t0) });
    return this.push(s, env, ctx, g);
  }
  /** Every tick (no gesture): a wait that ran out plays its moves; a recording ends. */
  tick(t, ctx) {
    if (this.rec) { this.recordTick(t); return null; }
    const P = this.m.pending;
    if (!P || t < P.deadline) return null;
    return this.flushPending(ctx, t);
  }
  /** Drop every excursion in progress and the sequence (focus lost, a new possession). */
  reset() { for (const st of Object.values(this.sticks)) st.reset(); this.resetMatch(); }
  resetMatch() { this.m = { seq: [], fired: null, pending: null, lastStep: null }; }

  // ── the matcher ──
  /** Every complete match of the sequence and every binding it may still become. */
  evaluate(seq, env) {
    const complete = [], pend = [];
    const last = seq[seq.length - 1];
    this.bindings.forEach((b, i) => {
      const n = b.steps.length;
      if (n > 1 && resolveRole(b, env).missing) return;   // (a combo with no clip never swallows its steps)
      for (let k = 1; k <= Math.min(n, seq.length); k++) {
        const m = tailMatch(seq, b, k);
        if (!m) continue;
        if (k === n && !m.grow) { complete.push({ b, i, n, score: m.score }); continue; }
        const p = b.steps[k - 1];
        const deadline = m.grow ? last.t + ('hold' in p ? Math.max(0, (p.ms || 0) - (last.ms || 0)) + 80 : 600) : last.t + (p.gap ?? DEFAULT_GAP);
        pend.push({ b, i, k, used: k, grow: m.grow, deadline });
      }
    });
    // a hold no playable hold binding takes is read as a flick of its direction (the old "once per push")
    if (last?.kind === 'hold' && !last.ext && !complete.some((c) => c.n === 1 && !resolveRole(c.b, env).missing)) {
      for (let j = complete.length - 1; j >= 0; j--) if (complete[j].n === 1) complete.splice(j, 1);
      const f = { ...last, kind: 'flick' };
      this.bindings.forEach((b, i) => { if (b.steps.length === 1) { const m = matchStep(f, b.steps[0], b.mirror !== false); if (m && !m.grow) complete.push({ b, i, n: 1, score: m.score, asHold: true }); } });
    }
    // an extension (a longer hold, a further circle) only counts for the bindings that needed it
    if (last?.ext && last.prev) {
      const seq0 = [...seq.slice(0, -1), last.prev];
      for (let j = complete.length - 1; j >= 0; j--) { const m = tailMatch(seq0, complete[j].b, complete[j].n); if (m && !m.grow) complete.splice(j, 1); }
    }
    complete.sort((x, y) => y.n - x.n || x.score - y.score || x.i - y.i);
    return { complete, pend };
  }
  /** The nearest single-step binding to an attempt that matched none: by angle, its own kind first. */
  nearest(s) {
    const singles = this.bindings.map((b, i) => ({ b, i })).filter(({ b }) => b.steps.length === 1);
    const ang = (b, v) => angDist(b.mirror !== false ? s.a : s.ar, v);
    const pools = {
      flick: [['flick', (b, p) => ang(b, p.flick)], ['hold', (b, p) => (p.hold === 'any' ? 200 : ang(b, p.hold))], ['spin', () => 300]],
      hold: [['hold', (b, p) => (p.hold === 'any' ? 200 : ang(b, p.hold))], ['flick', (b, p) => ang(b, p.flick)], ['spin', () => 300]],
      spin: [['spin', (b, p) => (p.spin === 'any' || p.spin === (b.mirror !== false ? s.rot : s.rotR) ? 0 : 1)], ['flick', (b, p) => ang(b, p.flick)], ['hold', (b, p) => (p.hold === 'any' ? 200 : ang(b, p.hold))]],
    }[s.kind] || [];
    for (const [kind, score] of pools) {
      let best = null;
      for (const c of singles) { const p = c.b.steps[0]; if (!(kind in p)) continue; const sc = score(c.b, p); if (!best || sc < best.score - 1e-9) best = { ...c, n: 1, score: sc, nearest: true }; }
      if (best) return best;
    }
    return null;
  }
  /** A match → the read. */
  readOf(c, seq, env) {
    const b = c.b, steps = seq.slice(-c.n), last = steps[steps.length - 1];
    const read = {
      t: last.t, kind: c.asHold ? 'hold' : last.kind, gesture: ROLE_GESTURE[b.role] || b.role, label: roleLabel(b.role), binding: b.role,
      match: c.nearest ? 'nearest' : 'exact', nearest: !!c.nearest, combo: c.n > 1, n: c.n, steps: steps.map(stepView), keys: steps.map(keyOf),
      theta: env.theta, phi: env.phi, hand: env.hand, ...resolveRole(b, env), upgradeOf: null,
    };
    if (c.n > 1) read.degrade = this.degradeOf(last, env);
    return read;
  }
  /** What a combo plays if it fires from the other hand (its first move took the ball there first): its last step read alone there. */
  degradeOf(last, env) {
    const o = otherHandStep(last), env2 = { ...env, hand: o.hand };
    const { complete } = this.evaluate([o], env2);
    const c = complete.find((x) => x.n === 1) || this.nearest(o);
    return c ? c.b.role : null;
  }
  push(s, env, ctx, g) {
    const M = this.m, out = [];
    if (M.pending && s.t > M.pending.deadline) out.push(this.flushPending(ctx, s.t));
    // the sequence: a step continues it in the same hand inside the gap; an extension replaces its own step
    const last = M.seq[M.seq.length - 1];
    if (s.ext) {
      const prev = M.lastStep && M.lastStep.ex === s.ex && M.lastStep.src === s.src ? M.lastStep : null;
      if (prev) { s.prev = prev; s.tb = prev.tb ?? prev.t; }
      if (prev && last === prev) M.seq[M.seq.length - 1] = s; else M.seq = [s];
    } else {
      if (last && (last.hand !== s.hand || s.t - last.t > this.maxGap)) { M.seq = []; M.fired = null; }
      M.seq.push(s);
      if (M.seq.length > MAX_STEPS + 1) M.seq.shift();
    }
    M.lastStep = s;
    const { complete, pend } = this.evaluate(M.seq, env);
    const best = complete[0] || null;
    // a release nothing uses is no step of anything
    if (s.kind === 'release' && !best && !pend.some((p) => 'release' in p.b.steps[p.k - 1])) { M.seq.pop(); M.lastStep = M.seq[M.seq.length - 1] || null; }
    const rel = pend.filter((p) => p.used >= (best ? best.n : 1));
    const waits = rel.filter((p) => p.grow || p.b.mode === 'wait');
    const attempt = ATTEMPT.has(s.kind) && !s.ext;
    const near = !best && attempt ? this.nearest(s) : null;
    const read = best ? this.readOf(best, M.seq, env) : near ? this.readOf(near, [s], env) : null;
    if (read && g) read.a = +(g.a ?? 0).toFixed(1);
    if (waits.length) {
      // the combo may still come: this reading is held back
      const deadline = Math.max(...waits.map((p) => p.deadline));
      if (!M.pending) M.pending = { reads: [], deadline };
      if (read) { M.pending.reads = M.pending.reads.filter((r) => !r.keys.every((k) => read.keys.includes(k))); M.pending.reads.push(read); }
      M.pending.deadline = deadline;
      const w = { waiting: [...new Set(waits.map((p) => p.b.role))], deadline, held: M.pending.reads.map((r) => r.role || r.binding), kind: s.kind, t: s.t, step: stepView(s), hand: s.hand };
      this.emit({ type: 'waiting', ...w });
      this.remember(w);
      out.push(w);
      return combine(out);
    }
    // whatever was held back plays first (unless this reading takes its steps: a combo, a longer hold)
    if (M.pending) {
      for (const r of M.pending.reads) if (!(read && r.keys.every((k) => read.keys.includes(k)))) { r.late = Math.round(s.t - r.t); out.push(r); this.emit({ type: 'read', read: r }); this.remember(r); }
      M.pending = null;
    }
    if (read) {
      if (M.fired && read.keys.includes(M.fired.keys[M.fired.keys.length - 1]) && M.fired.binding !== read.binding) read.upgradeOf = M.fired.role || M.fired.binding;
      // a combo it may still become keeps the sequence (the upgrade); else it starts again (combos never chain)
      if (rel.some((p) => p.used >= read.n)) M.fired = read; else { M.seq = []; M.fired = null; }
      this.emit({ type: 'read', read });
      this.remember(read);
      out.push(read);
    }
    return combine(out);
  }
  flushPending(ctx, t) {
    const P = this.m.pending;
    this.m.pending = null; this.m.seq = []; this.m.fired = null;
    if (!P?.reads.length) return null;
    const gate = gateOf(ctx);
    if (gate) { const r = { ignored: gate, kind: P.reads[P.reads.length - 1].kind, t, late: true }; this.emit({ type: 'ignored', reason: gate, t, late: true }); this.remember(r); return r; }
    for (const r of P.reads) { r.late = Math.round(t - r.t); this.emit({ type: 'read', read: r }); this.remember(r); }
    return combine(P.reads.slice());
  }
  /**
   * A dry run: the moves these steps (binding steps, relative to the ball hand, dt ms apart — a step's own dt
   * overrides) would play, in order — the UI's "test" without a stick, and the tests'. lib: the library (null: every
   * move has a clip). Nothing is recorded or emitted.
   */
  simulate(steps, { hand = 'right', lib = null, dt = 120 } = {}) {
    const saved = this.m, savedRec = this.rec, savedL = this.listeners;
    this.m = { seq: [], fired: null, pending: null, lastStep: null }; this.rec = null; this.listeners = new Set();
    const savedHist = this.hist; this.hist = [];
    const out = [];
    let t = 0, ex = 0;
    try {
      for (const p of steps) {
        t += p.dt ?? dt;
        const kind = ['flick', 'hold', 'spin', 'release'].find((k) => k in p);
        const a = kind === 'flick' ? p.flick : kind === 'hold' ? (p.hold === 'any' ? 0 : p.hold) : p.a ?? 0;
        const ar = hand === 'left' ? norm360(360 - a) : a;
        const s = { kind, a, ar, hand, t, ex: p.ext ? ex : ++ex, src: 'sim' };
        if (kind === 'spin') { s.rot = p.spin === 'ccw' ? 'ccw' : 'cw'; s.rotR = hand === 'left' ? (s.rot === 'cw' ? 'ccw' : 'cw') : s.rot; s.turn = p.turn || 90; }
        if (kind === 'hold') s.ms = p.ms ?? DEFAULT_HOLD_MS;
        if (p.ext) s.ext = true;
        const env = { hand, theta: wrap180(-a), phi: wrap180(-ar), ...hasOf(lib) };
        const r = this.push(s, env, null, null);
        if (r) for (const x of [...(r.before || []), r]) out.push(x);
      }
      const r = this.m.pending ? this.flushPending(null, t + 5000) : null;
      if (r) for (const x of [...(r.before || []), r]) out.push(x);
    } finally { this.m = saved; this.rec = savedRec; this.listeners = savedL; this.hist = savedHist; }
    return out.filter((x) => !x.waiting).map(({ before, ...x }) => x);
  }

  // ── recording a trigger ──
  /**
   * Record the next gesture sequence the player performs on the stick as role's trigger: it ends endMs after the
   * last gesture (or at MAX_STEPS); nothing plays meanwhile. Angles relative to the ball hand (mirrored in the left
   * hand), quantized to 45° (fine: 22.5°); a pause longer than the default gap is kept as that step's gap.
   * @param {string} role
   * @param {{ endMs?: number, fine?: boolean, holdAny?: boolean, mirror?: boolean, mode?: 'upgrade'|'wait', timeoutMs?: number }} opts
   * @returns {Promise<{ role, steps, binding, conflicts, describe } | { role, cancelled: true, reason }>}
   */
  startRecording(role, opts = {}) {
    if (this.rec) this.cancelRecording('restarted');
    const own = this.bindings.find((b) => b.role === role);
    const o = { endMs: 650, fine: false, holdAny: false, mode: own?.mode, timeoutMs: 20000, ...opts };
    o.mirror = opts.mirror ?? (own ? own.mirror !== false : true);   // (the move's own setting, unless asked)
    this.resetMatch();
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    this.rec = { role, opts: o, steps: [], times: [], lastT: null, startT: null, resolve };
    this.emit({ type: 'record', phase: 'start', role });
    return done;
  }
  cancelRecording(reason = 'cancelled') {
    const R = this.rec;
    if (!R) return false;
    this.rec = null;
    const out = { role: R.role, cancelled: true, reason, steps: R.steps };
    this.emit({ type: 'record', phase: 'cancel', ...out });
    R.resolve(out);
    return true;
  }
  /** The recording in progress: { role, steps } or null. */
  get recording() { return this.rec ? { role: this.rec.role, steps: this.rec.steps.map((s) => ({ ...s })) } : null; }
  recordGesture(g, ctx) {
    const R = this.rec, o = R.opts;
    if (R.startT == null) R.startT = g.t;
    if (g.kind === 'release') return null;
    const env = envOf(g, ctx), s = stepOf(g, env), A = o.mirror === false ? s.ar : s.a, q = (a) => quantizeAngle(a, o.fine ? 22.5 : 45);
    let step;
    if (s.kind === 'flick') step = { flick: q(A) };
    else if (s.kind === 'hold') step = { hold: o.holdAny ? 'any' : q(A) };
    else step = { spin: o.spinAny ? 'any' : o.mirror === false ? s.rotR : s.rot, ...(s.turn > 90 ? { turn: s.turn } : {}) };
    if (s.ext && R.steps.length && R.exLast === s.ex) R.steps[R.steps.length - 1] = step;   // (a longer circle: the same step)
    else {
      if (R.steps.length) {
        const dt = s.t - R.lastT;
        if (dt > DEFAULT_GAP) R.steps[R.steps.length - 1].gap = Math.min(2000, Math.ceil((dt + 120) / 50) * 50);   // (as slow as it was recorded, with room)
      }
      R.steps.push(step);
    }
    R.lastT = s.t; R.exLast = s.ex;
    this.emit({ type: 'record', phase: 'step', role: R.role, step: { ...step }, steps: R.steps.map((x) => ({ ...x })), seen: stepView(s) });
    if (R.steps.length >= MAX_STEPS) this.finishRecording();
    return { recording: R.role, step, kind: g.kind, t: g.t };
  }
  recordTick(t) {
    const R = this.rec;
    if (!R) return;
    if (R.lastT == null) { if (R.startT == null) R.startT = t; if (t - R.startT > R.opts.timeoutMs) this.cancelRecording('timeout'); return; }
    if (t - R.lastT >= R.opts.endMs) this.finishRecording();
  }
  finishRecording() {
    const R = this.rec;
    if (!R) return;
    this.rec = null;
    const nb = normalizeBinding({ role: R.role, steps: R.steps, ...(R.opts.mirror === false ? { mirror: false } : {}), ...(R.opts.mode ? { mode: R.opts.mode } : {}) });
    const out = nb.ok
      ? { role: R.role, steps: nb.binding.steps, binding: nb.binding, conflicts: conflictsOf(nb.binding, this.bindings.filter((b) => b.role !== R.role)), describe: describeBinding(nb.binding) }
      : { role: R.role, cancelled: true, reason: nb.errors.join('; '), steps: R.steps };
    this.emit({ type: 'record', phase: out.cancelled ? 'cancel' : 'done', ...out });
    R.resolve(out);
  }

  // ── the event stream (a test view) ──
  /** Listen: fn(event) for 'sample' (test on), 'step', 'read', 'waiting', 'ignored', 'record', 'bindings'. @returns unsubscribe */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(e) { for (const f of this.listeners) { try { f(e); } catch (err) { /* a listener never breaks the game */ } } }
  remember(r) { this.hist.push(r); if (this.hist.length > this.historyMax) this.hist.shift(); }
  /** The last reads (and ignored / waiting gestures), oldest first. */
  history() { return this.hist.slice(); }
  /** The stick samples kept (r ≥ 0.1 and the one after), oldest first — of a source since t0 when given. */
  trail(src = null, t0 = null) { return this.trailBuf.filter((p) => (src == null || p.src === src) && (t0 == null || p.t >= t0 - 1)).map((p) => [p.x, p.y, p.t]); }
}

// ── the old stateless API (the default bindings, or ctx.controls) ─────────
const defaultMC = { mc: null };
function statelessMC(controls) {
  if (!controls) return (defaultMC.mc ||= new MoveControls({ sticks: {} }));
  return new MoveControls({ controls, sticks: {} });
}
/**
 * One gesture → the read, without state: prev (the previous read) is the sequence so far — a single move read
 * just before (the double crossover's first flick) can be upgraded. Gates as MoveControls.read.
 * @returns the read (see MoveControls) — { gesture, kind, theta, role, handSwitch, fellBack, missing, combo, hand, phi, t, … }
 */
export function routeGesture(g, { P, ctl, lib, camFwd, camRight, shootHeld = false, prev = null, controls = null }) {
  const mc = statelessMC(controls);
  mc.resetMatch(); mc.hist = []; mc.listeners = new Set();
  const ctx = { P, ctl, lib, camFwd, camRight, shootHeld };
  if (prev && !prev.ignored && !prev.combo && !prev.waiting && Array.isArray(prev.steps) && prev.steps.length === 1 && prev.binding) {
    const p = prev.steps[0];
    const s = { kind: p.kind, a: p.a, ar: p.ar, hand: p.hand, t: p.t, ex: -1, src: 'prev', ...(p.rot ? { rot: p.rot, rotR: p.rot, turn: p.turn } : {}), ...(p.ms != null ? { ms: p.ms } : {}) };
    mc.m.seq = [s]; mc.m.lastStep = s; mc.m.fired = { ...prev, keys: [keyOf(s)] };
  }
  const r = mc.read({ ...g, t: g.t ?? 0 }, ctx);
  mc.resetMatch();
  return r || { kind: g.kind, t: g.t, gesture: null, role: null, missing: true, handSwitch: false, fellBack: false };
}
/** θ (his frame, + toward the free hand) and a gesture kind → the default bindings' single move, resolved against lib. */
export function resolveGesture(g, theta, lib, { canSwitch = true } = {}) {
  const mc = statelessMC(null), a = norm360(-theta), s = { kind: g.kind, a, ar: a, hand: 'right', t: 0, ex: null, src: null, ...(g.kind === 'spin' ? { rot: 'cw', rotR: 'cw', turn: 90 } : {}), ...(g.kind === 'hold' ? { ms: DEFAULT_HOLD_MS } : {}) };
  const env = { hand: 'right', theta, phi: theta, has: (r) => !!lib[r], canSwitch };
  const { complete } = mc.evaluate([s], env);
  const c = complete.find((x) => x.n === 1) || mc.nearest(s);
  const r = mc.readOf(c, [s], env);
  return { gesture: r.gesture, kind: r.kind, theta, role: r.role, handSwitch: r.handSwitch, fellBack: r.fellBack, missing: r.missing, nearest: r.nearest, binding: r.binding };
}
/** The on-screen note for a gesture with no clip of its own (null: it played as asked). */
export function gestureNote(res, roleNames = {}) {
  if (!res || res.ignored || res.waiting || res.recording) return null;
  const n = GESTURE_NAMES[res.gesture] || res.label || roleLabel(res.binding || res.gesture || '');
  if (res.missing) return `${n} — no clip yet`;
  if (res.fellBack) return `${n} → ${res.handSwitch ? 'crossover dribble' : (roleNames[res.role] || res.role)} (no ${n.toLowerCase()} clip yet)`;
  return null;
}
