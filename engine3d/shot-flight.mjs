/**
 * Shot flight — the arc a released shot takes, and the hook a shot meter drives.
 *
 * planShot picks the aim point from the shot's OUTCOME (a make aims at the rim's centre, a swish
 * just short of it; a miss short / long / off the rim / an airball aims that far off), then the flight time from a
 * believable ENTRY ANGLE (47° down into the ring, apex ≥ 45 cm over the rim), then the launch
 * velocity that lands exactly there under gravity AND the ball's air drag (the same closed form
 * as BasketballPhysicsSystem.ballisticTo, so Rapier flies the planned arc), plus backspin.
 *
 * The court's shot meter (engine3d/shot-meter.mjs aimOf) passes an explicit dz instead (how far short / long of
 * the rim's centre its release timing sends the ball, no roll): the ball then leaves along the SAME direction as the
 * clean swish from that spot — its launch speed differs (launchAlong: slower → short, faster → too hard, long, off
 * the glass; a too-hard one is also `pitch` degrees flatter) — and Rapier flies it into whatever it meets (the rim, the
 * glass, nothing).
 *
 * outcomeFor maps the older grade hook (quality 0…1, timing early / late / perfect; setShotInput) to an outcome —
 * the only randomness is a "rim" grade's roll (in or out), from a seedable rng (mulberry32), so a replay with the
 * same seed is the same shot. With no meter the intent is a make. reaimShot gives the aim a late release (known only
 * after the launch) steers a flight in the air to.
 *
 * Pure, engine-agnostic (no three.js).
 */
import { solveSegment } from './ball-trajectory.mjs';

export const SHOT_DEFAULTS = Object.freeze({
  entryDeg: 47,            // descent angle into the ring (a good shooter: 45–50°)
  minApexOverRim: 0.45,    // m: the arc peaks at least this far over the rim
  aimLift: 0.03,           // m over the rim plane (the ball's centre crosses it just inside)
  rimY: 3.05, rimR: 0.2286, R: 0.12,
  g: 9.81,
  drag: 0.02,              // 1/s linear air damping (BALL_DEFAULTS.linearDamping)
  backspin: 18,            // rad/s (≈ 3 rev/s)
  // aim offsets per outcome, metres along the shot (− short / + long) or across it — calibrated on
  // Rapier (tests/shot-meter.test.js: 120 spots 1.2–11 m, both boards): a swish goes in touching
  // nothing, make / rim-make always go in (a make touches the rim now and then, a rim-make mostly),
  // every miss stays out (rim-out / short / long on the rim or the board, an airball touches nothing)
  miss: { swish: -0.025, short: -0.34, long: 0.34, longSide: 0.1, rimFront: -0.19, rimBack: 0.21, side: 0.24, airball: -0.95, rimMake: -0.05, rimSide: 0.08 },
  // meter grade thresholds (quality ≥ …)
  grades: { swish: 0.92, make: 0.8, rim: 0.65, miss: 0.4 },
});
export const OUTCOMES = ['swish', 'make', 'rim-make', 'rim-out', 'short', 'long', 'airball', 'left', 'right'];
export const isMake = (o) => o === 'swish' || o === 'make' || o === 'rim-make';

/** Seedable uniform [0, 1) generator (deterministic replays). */
export function mulberry32(seed = 0x5eed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * A meter grade → an outcome. quality 1 = the perfect window; timing says which side a miss is on.
 * @param {{ quality?: number, timing?: 'early'|'late'|'perfect', rng?: () => number, cfg?: object }} o
 */
export function outcomeFor({ quality = 1, timing = 'perfect', rng = Math.random, cfg = SHOT_DEFAULTS } = {}) {
  const q = clamp(+quality || 0, 0, 1), G = cfg.grades || SHOT_DEFAULTS.grades;
  if (q >= G.swish) return 'swish';
  if (q >= G.make) return 'make';
  if (q >= G.rim) return rng() < (q - 0.5) / 0.3 ? 'rim-make' : 'rim-out';
  if (q >= G.miss) return timing === 'late' ? 'long' : 'short';
  return timing === 'late' ? 'long' : 'airball';
}

/**
 * The shot's arc.
 * @param {object} o
 *   from     release point [x, y, z]
 *   hoop     { center: [x, y, z], rimR }
 *   outcome  one of OUTCOMES (else from quality / timing via outcomeFor)
 *   quality, timing, rng   the meter's grade (see outcomeFor)
 *   cfg      overrides of SHOT_DEFAULTS (g, drag: the physics' gravity / linear damping)
 *   dz       (the shot meter) m along the shot from the rim's centre where the ball's centre comes down through the
 *            aim height (rim + aimLift): − short, + long. The launch keeps the clean swish's direction from `from`
 *            (launchAlong): only the speed changes — pitch: degrees added to its elevation (the same heading).
 *            `outcome` is then just its name (front-rim, off-glass, …).
 * @returns {{ outcome, aim: number[], T: number, v0: number[], w0: number[], apexY: number, entryDeg: number, seg: object }}
 */
export function planShot({ from, hoop = null, outcome = null, quality = 1, timing = 'perfect', rng = Math.random, cfg = {}, dz: dzIn = null, pitch = 0 } = {}) {
  const c = { ...SHOT_DEFAULTS, ...cfg, miss: { ...SHOT_DEFAULTS.miss, ...(cfg.miss || {}) } };
  if (Number.isFinite(dzIn)) return planAlong({ from, hoop, outcome, dz: dzIn, cfg, pitch });
  const center = hoop?.center || [0, c.rimY, 0];
  const rimY = center[1];
  if (!OUTCOMES.includes(outcome)) outcome = outcomeFor({ quality, timing, rng, cfg: c });
  // along (u) and across (s) the shot, horizontally
  let ux = center[0] - from[0], uz = center[2] - from[2];
  const l = Math.hypot(ux, uz);
  if (l > 1e-6) { ux /= l; uz /= l; } else { ux = 0; uz = 1; }
  const u = [ux, 0, uz], s = [-uz, 0, ux];   // s = u × up (a right-hand side of the shot)
  let dz = 0, dx = 0;
  const M = c.miss;
  // (a swish crosses the rim plane just short of the centre: at 47° the ball's centre, 3 cm over the
  // plane at the aim, reaches it 3 cm further on — clear of the back of the ring; a plain make aims
  // at the centre and brushes the rim now and then; a long one is off to a side too, or from close
  // in it can drop off the board)
  if (outcome === 'swish') dz = M.swish;
  else if (outcome === 'rim-make') dz = M.rimMake;
  else if (outcome === 'rim-out') { dz = timing === 'late' ? M.rimBack : M.rimFront; dx = (rng() < 0.5 ? -1 : 1) * M.rimSide; }
  else if (outcome === 'long') { dz = M.long; dx = (rng() < 0.5 ? -1 : 1) * M.longSide; }
  else if (outcome === 'short' || outcome === 'airball') dz = M[outcome];
  else if (outcome === 'left') dx = -M.side;
  else if (outcome === 'right') dx = M.side;
  const aim = [center[0] + u[0] * dz + s[0] * dx, rimY + c.aimLift, center[2] + u[2] * dz + s[2] * dx];
  // flight time from the entry angle: tan θ = (g T² / 2 − h) / d  →  T = √(2 (h + d tan θ) / g)
  const d = Math.hypot(aim[0] - from[0], aim[2] - from[2]), h = aim[1] - from[1], g = c.g;
  const th = (c.entryDeg * Math.PI) / 180;
  let T = Math.sqrt(Math.max(1e-4, (2 * (h + d * Math.tan(th))) / g));
  // …high enough: the apex at least minApexOverRim over the rim (a flat shot from close in)
  const apexOf = (TT) => { const vy = h / TT + (g * TT) / 2; return vy > 0 ? from[1] + (vy * vy) / (2 * g) : from[1]; };
  const needY = rimY + c.minApexOverRim;
  if (apexOf(T) < needY) {
    const vy = Math.sqrt(2 * g * Math.max(0, needY - from[1]));
    const disc = vy * vy - 2 * g * h;
    if (disc >= 0) T = Math.max(T, (vy + Math.sqrt(disc)) / g);
  }
  // launch velocity: exact under gravity + linear drag (v' = −g ŷ − k v), as ballisticTo
  const k = c.drag, D = [aim[0] - from[0], aim[1] - from[1], aim[2] - from[2]];
  let v0;
  if (!(k > 1e-6)) v0 = [D[0] / T, (D[1] + 0.5 * g * T * T) / T, D[2] / T];
  else { const f = (1 - Math.exp(-k * T)) / k; v0 = [D[0] / f, (D[1] + (g / k) * T) / f - g / k, D[2] / f]; }
  // backspin: the top of the ball turns back toward the shooter (ω along u × up = s)
  const w0 = [s[0] * c.backspin, 0, s[2] * c.backspin];
  const vyA = h / T - (g * T) / 2;
  const entryDeg = (Math.atan2(-vyA, d / T) * 180) / Math.PI;
  const seg = solveSegment({ t0: 0, p0: from.slice(), t1: T, p1: aim, g, floorY: -1e3, R: c.R, w: w0, kind: 'shot' });
  return { outcome, aim, T, v0, w0, apexY: apexOf(T), entryDeg, seg, rimDist: l };
}

/**
 * A shot re-aimed in the air (a shot meter's late grade, known only after the launch): the aim of
 * `outcome` for the shot launched at `from` (the flight is steered to it, arriving when planned).
 * A long miss from close in (< longMinDist) is a back-rim one instead: bent after the launch, a long
 * one there can still drop in off the board (calibrated on Rapier, tests/shot-meter.test.js).
 * at = { p, T } (optional): where the ball is and the flight time left → seg, the rest of the arc.
 */
export function reaimShot({ from, hoop = null, outcome, timing = 'late', rng = Math.random, cfg = {}, at = null, dz = null, pitch = 0 } = {}) {
  const center = hoop?.center || [0, SHOT_DEFAULTS.rimY, 0];
  if (dz == null && outcome === 'long' && Math.hypot(center[0] - from[0], center[2] - from[2]) < (cfg.longMinDist ?? 2.5)) outcome = 'rim-out';
  const P = planShot({ from, hoop, outcome, timing, rng, cfg, dz, pitch });
  // (at = { p, T }: the ball now and the flight time left — the rest of the bent arc, for Ball Debug Mode)
  const seg = at ? solveSegment({ t0: 0, p0: at.p.slice(), t1: at.T, p1: P.aim, g: cfg.g ?? SHOT_DEFAULTS.g, floorY: -1e3, R: cfg.R ?? SHOT_DEFAULTS.R, kind: 'shot' }) : null;
  return { outcome: P.outcome, aim: P.aim, T: P.T, v0: P.v0, seg };
}

/**
 * A late release (the shot meter's grade known only after the launch — the button still held on the release frame):
 * the flight that timing calls for (planShot with dz / pitch, launched from `from` when the shot was), and the point the
 * ball in the air is steered to — that flight's own position `past` m along the shot beyond the rim's centre (short of
 * the glass, before it can meet the rim's back), and when it is there (s after the launch). Steered there (BallSession
 * steer), the ball meets the rim / the glass as that flight does (calibrated on Rapier, tests/shot-meter.test.js).
 * @returns {{ plan: object, aim: number[], T: number }}
 */
export function lateFlight({ from, hoop = null, outcome, dz, pitch = 0, cfg = {}, past = 0.15 } = {}) {
  const c = { ...SHOT_DEFAULTS, ...cfg };
  const plan = planShot({ from, hoop, outcome, dz, pitch, cfg });
  const center = hoop?.center || [0, c.rimY, 0];
  let ux = center[0] - from[0], uz = center[2] - from[2];
  const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
  const along = (t) => { const q = dragPos(from, plan.v0, t, c.g, c.drag).p; return (q[0] - center[0]) * ux + (q[2] - center[2]) * uz; };
  let lo = 0, hi = plan.T;
  if (along(hi) < past) return { plan, aim: plan.aim.slice(), T: plan.T };
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (along(m) < past) lo = m; else hi = m; }
  return { plan, aim: dragPos(from, plan.v0, hi, c.g, c.drag).p, T: hi };
}

/**
 * Where a launch from p0 at velocity v (gravity g, linear drag k: v' = −g ŷ − k v) is t seconds later, and its velocity.
 * (expm1: exact and stable for a tiny k too.)
 */
export function dragPos(p0, v, t, g, k) {
  if (!(k > 1e-9)) return { p: [p0[0] + v[0] * t, p0[1] + v[1] * t - 0.5 * g * t * t, p0[2] + v[2] * t], v: [v[0], v[1] - g * t, v[2]] };
  const f = -Math.expm1(-k * t) / k, e = Math.exp(-k * t), gk = g / k;
  return { p: [p0[0] + v[0] * f, p0[1] + (v[1] + gk) * f - gk * t, p0[2] + v[2] * f], v: [v[0] * e, (v[1] + gk) * e - gk, v[2] * e] };
}

/**
 * The launch along a fixed direction n (unit, upward) from p0 whose ball centre comes DOWN through height yA at
 * horizontal distance X — its speed and the time it gets there (gravity g, linear drag k). A distance short of what the
 * slowest launch reaching yA comes down at (it would have to cross yA still rising): that launch's speed scaled by
 * √(X / its distance) — the ball never reaches yA (an air ball, short); T is then when it is X along.
 * @returns {{ speed: number, T: number, reaches: boolean }}
 */
export function launchAlong(p0, n, yA, X, { g = SHOT_DEFAULTS.g, drag: k = SHOT_DEFAULTS.drag } = {}) {
  const nh = Math.hypot(n[0], n[2]), ny = n[1];
  const yAt = (s, t) => dragPos(p0, [n[0] * s, ny * s, n[2] * s], t, g, k).p[1];
  const tApex = (s) => (k > 1e-9 ? Math.log1p((k * s * ny) / g) / k : (s * ny) / g);
  const xAt = (s, t) => s * nh * (k > 1e-9 ? -Math.expm1(-k * t) / k : t);
  /** The horizontal distance at which a launch of speed s comes down through yA (−1: its apex is under yA). */
  const xDown = (s) => {
    const ta = tApex(s);
    if (yAt(s, ta) < yA) return { x: -1, t: ta };
    let lo = ta, hi = ta + 0.25;
    while (yAt(s, hi) > yA && hi < ta + 20) hi += 0.5;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (yAt(s, m) > yA) lo = m; else hi = m; }
    const t = (lo + hi) / 2;
    return { x: xAt(s, t), t };
  };
  // the slowest launch that reaches yA (its apex on it)
  let lo = 0, hi = 60;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (yAt(m, tApex(m)) >= yA) hi = m; else lo = m; }
  const sMin = hi, dMin = xDown(sMin);
  if (X <= dMin.x) {
    const speed = sMin * Math.sqrt(Math.max(0.01, X / Math.max(1e-6, dMin.x)));
    // (when it is X along: x(t) = speed · nh · f(t))
    const fx = X / Math.max(1e-6, speed * nh), T = k > 1e-9 ? (k * fx < 0.999 ? -Math.log1p(-k * fx) / k : 10) : fx;
    return { speed, T, reaches: false };
  }
  let a = sMin, b = Math.max(sMin * 2, 30);
  while (xDown(b).x < X && b < 200) b *= 1.5;
  for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (xDown(m).x < X) a = m; else b = m; }
  const speed = (a + b) / 2;
  return { speed, T: xDown(speed).t, reaches: true };
}

/**
 * The shot meter's flight: the clean swish's launch direction from `from`, the speed that brings the ball's centre
 * down through the aim height dz along the shot from the rim's centre (− short, + long). dz = the swish's own: the
 * clean swish itself.
 */
function planAlong({ from, hoop, outcome, dz, cfg, pitch = 0 }) {
  const c = { ...SHOT_DEFAULTS, ...cfg, miss: { ...SHOT_DEFAULTS.miss, ...(cfg.miss || {}) } };
  const clean = planShot({ from, hoop, outcome: 'swish', cfg });
  if (Math.abs(dz - c.miss.swish) < 1e-9 && !pitch) return { ...clean, outcome: outcome || 'swish', dz };
  const center = hoop?.center || [0, c.rimY, 0];
  const l = Math.hypot(center[0] - from[0], center[2] - from[2]);
  const sp = Math.hypot(...clean.v0);
  let n = clean.v0.map((x) => x / sp);
  // (pitch: degrees added to the launch's elevation — the same heading, a flatter (−) or a higher arc)
  if (pitch) { const h = Math.hypot(n[0], n[2]), el = Math.atan2(n[1], h) + (pitch * Math.PI) / 180; n = [(n[0] / h) * Math.cos(el), Math.sin(el), (n[2] / h) * Math.cos(el)]; }
  const yA = center[1] + c.aimLift, X = Math.max(0.05, l + dz);
  const L = launchAlong(from, n, yA, X, { g: c.g, drag: c.drag });
  const v0 = n.map((x) => x * L.speed), T = L.T, end = dragPos(from, v0, T, c.g, c.drag);
  const aim = end.p;
  const vh = Math.hypot(end.v[0], end.v[2]), entryDeg = (Math.atan2(-end.v[1], vh) * 180) / Math.PI;
  const ta = c.drag > 1e-9 ? Math.log1p((c.drag * v0[1]) / c.g) / c.drag : v0[1] / c.g;
  const apexY = v0[1] > 0 ? dragPos(from, v0, ta, c.g, c.drag).p[1] : from[1];
  const seg = solveSegment({ t0: 0, p0: from.slice(), t1: T, p1: aim, g: c.g, floorY: -1e3, R: c.R, w: clean.w0, kind: 'shot' });
  return { outcome: outcome || (dz < 0 ? 'short' : 'long'), aim, T, v0, w0: clean.w0.slice(), apexY, entryDeg, seg, rimDist: l, dz, speedScale: L.speed / sp, reaches: L.reaches };
}
