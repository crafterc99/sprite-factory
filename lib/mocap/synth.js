/**
 * Synthetic locomotion with exact ground truth — for testing the game-clip
 * builder (contacts, root motion, foot pinning, loop extraction).
 *
 * A walker/jogger in world space (metres, y-up, starts facing +Z): the pelvis
 * travels at `speed` along `dir` (radians, 0 = forward/+Z, π/2 = +X strafe);
 * each foot alternates a planted stance (fixed on the floor — the truth for
 * contact detection and slide) and a swing arc to the next plant. Knees by
 * two-bone IK. The upper body is the mock dribble pose. Optional corruptions
 * that monocular capture produces: a slow whole-body drift along a camera
 * "view" direction (depth error) and per-joint jitter.
 */
'use strict';

const S = require('./skeleton');
const { J } = S;
const { poseAt } = require('./mock');

const THIGH = 0.47, SHIN = 0.46;

function twoBoneKnee(hip, ankle, poleDir) {
  const d = S.sub(ankle, hip);
  const L = Math.min(THIGH + SHIN - 1e-4, Math.max(1e-3, S.len(d)));
  const u = S.norm(d);
  const a = (THIGH * THIGH - SHIN * SHIN + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
  let pole = S.sub(poleDir, S.scale(u, S.dot(poleDir, u)));
  pole = S.len(pole) > 1e-6 ? S.norm(pole) : [0, 0, 1];
  return S.add(S.add(hip, S.scale(u, a)), S.scale(pole, h));
}

/**
 * @param {object} o { fps=30, seconds=3, speed=1.4 m/s, dir=0 rad, cycle=1.0 s,
 *                     stance=0.62 (fraction of the cycle a foot is planted),
 *                     lift=0.09 m, drift=[dx,dz] m over the clip, jitter=0 m, seed=1 }
 * @returns {{ frames: number[][][], fps, truth: { contacts: {left:boolean[], right:boolean[]},
 *           root: number[][] (pelvis floor point per frame, no drift), speed, dir } }}
 */
function synthWalk(o = {}) {
  const fps = o.fps || 30, seconds = o.seconds || 3, speed = o.speed ?? 1.4, dir = o.dir || 0;
  const cycle = o.cycle || 0.9, stance = o.stance ?? 0.62, lift = o.lift ?? 0.09;
  const drift = o.drift || [0, 0], jitter = o.jitter || 0;
  let seed = o.seed || 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const N = Math.round(seconds * fps);
  const travel = [Math.sin(dir), 0, Math.cos(dir)];
  const rootAt = (t) => S.scale(travel, speed * t);
  const frames = [], truthRoot = [], cL = [], cR = [];
  // Foot plant spots: a foot lands when its stance starts; during stance the
  // hip passes over it (plant at the root position of mid-stance)
  const footWorld = (side, t) => {
    const off = side === 'left' ? 0 : 0.5;
    const lat = side === 'left' ? 0.11 : -0.11;
    const ph = (((t / cycle + off) % 1) + 1) % 1;       // 0..1, stance first
    const k = Math.floor(t / cycle + off);                // step index
    const plantAt = (kk) => {                             // world plant spot of step kk
      const tMid = (kk - off + stance / 2) * cycle;
      return S.add(rootAt(tMid), [lat, 0, 0]);
    };
    if (ph < stance) return { p: plantAt(k), planted: true, swing: 0 };
    const s = (ph - stance) / (1 - stance);               // 0..1 through the swing
    const from = plantAt(k), to = plantAt(k + 1);
    const e = s * s * (3 - 2 * s);
    const p = S.add(S.add(from, S.scale(S.sub(to, from), e)), [0, lift * Math.sin(Math.PI * s), 0]);
    return { p, planted: false, swing: s };
  };
  for (let i = 0; i < N; i++) {
    const t = i / fps;
    const base = poseAt(t).P;
    const r = rootAt(t);
    const bob = 0.02 * Math.cos((4 * Math.PI * t) / cycle) - 0.04; // dribble crouch keeps strides in reach
    const P = base.map((p) => (p ? [p[0] + r[0], p[1] + bob, p[2] + r[2]] : p));
    for (const side of ['left', 'right']) {
      const f = footWorld(side, t);
      const ankle = [f.p[0], 0.08 + f.p[1], f.p[2]];
      const hip = P[J[`${side}-hip`]];
      P[J[`${side}-ankle`]] = ankle;
      P[J[`${side}-knee`]] = twoBoneKnee(hip, ankle, [0, 0, 1]);
      const sx = side === 'left' ? 1 : -1;
      P[J[`${side}-heel`]] = [ankle[0], ankle[1] - 0.06, ankle[2] - 0.06];
      P[J[`${side}-big-toe-tip`]] = [ankle[0] + 0.01 * sx, ankle[1] - 0.06, ankle[2] + 0.16];
      P[J[`${side}-small-toe-tip`]] = [ankle[0] + 0.05 * sx, ankle[1] - 0.06, ankle[2] + 0.13];
      (side === 'left' ? cL : cR).push(f.planted);
    }
    truthRoot.push([r[0], 0, r[2]]);
    // corruptions: slow depth drift + jitter
    const dr = [drift[0] * (i / Math.max(1, N - 1)), 0, drift[1] * (i / Math.max(1, N - 1))];
    frames.push(P.map((p) => [p[0] + dr[0] + jitter * rnd(), p[1] + jitter * rnd(), p[2] + dr[2] + jitter * rnd()]));
  }
  return { frames, fps, truth: { contacts: { left: cL, right: cR }, root: truthRoot, speed, dir } };
}

module.exports = { synthWalk, THIGH, SHIN };
