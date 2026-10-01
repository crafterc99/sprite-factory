/**
 * Shot flight — the arc a released shot takes, and the hook a shot meter drives.
 *
 * planShot picks the aim point from the shot's OUTCOME (a make aims at the rim's centre; a miss
 * short / long / off the rim / an airball aims that far off), then the flight time from a
 * believable ENTRY ANGLE (47° down into the ring, apex ≥ 45 cm over the rim), then the launch
 * velocity that lands exactly there under gravity AND the ball's air drag (the same closed form
 * as BasketballPhysicsSystem.ballisticTo, so Rapier flies the planned arc), plus backspin.
 *
 * outcomeFor maps a meter's grade (quality 0…1, timing early / late / perfect) to an outcome —
 * the only randomness is a "rim" grade's roll (in or out), from a seedable rng (mulberry32), so
 * a replay with the same seed is the same shot. With no meter the intent is a make.
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
  // aim offsets per outcome, metres along the shot (− short / + long) or across it
  miss: { short: -0.34, long: 0.30, rimFront: -0.19, rimBack: 0.21, side: 0.24, airball: -0.95, rimMake: -0.06, rimSide: 0.08 },
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
 * @returns {{ outcome, aim: number[], T: number, v0: number[], w0: number[], apexY: number, entryDeg: number, seg: object }}
 */
export function planShot({ from, hoop = null, outcome = null, quality = 1, timing = 'perfect', rng = Math.random, cfg = {} } = {}) {
  const c = { ...SHOT_DEFAULTS, ...cfg, miss: { ...SHOT_DEFAULTS.miss, ...(cfg.miss || {}) } };
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
  if (outcome === 'rim-make') dz = M.rimMake;
  else if (outcome === 'rim-out') { dz = timing === 'late' ? M.rimBack : M.rimFront; dx = (rng() < 0.5 ? -1 : 1) * M.rimSide; }
  else if (outcome === 'short' || outcome === 'long' || outcome === 'airball') dz = M[outcome];
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
