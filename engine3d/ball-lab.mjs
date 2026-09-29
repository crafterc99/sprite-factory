/**
 * Ball lab — procedural test scenes for the BasketballPhysicsSystem.
 *
 * A parametric mannequin (MHR joint names, so the same collision body is
 * built from it as from the animated character) with scripted hand paths,
 * and the same kind of ball INTENT an animation provides: which hand should
 * control the ball when, and the "video" trajectory (an ideal gravity path
 * with a floor bounce). The hands never carry the ball: they meet it, push
 * it, let go and meet it again; physics decides where it actually goes.
 *
 * Scenes: drop, drop-spin, dribble-right, dribble-left, pound, low,
 * cross-rl, cross-lr, btl, btb, moving, gather.
 */
import { BALL_DEFAULTS } from './basketball-physics.mjs';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Two-bone IK: joint between root a and target t (lengths l1, l2), bending toward pole. */
function twoBone(a, t, l1, l2, pole) {
  let d = sub(t, a); const L = Math.min(len(d), (l1 + l2) * 0.999); d = norm(d);
  const cosA = clamp((l1 * l1 + L * L - l2 * l2) / (2 * l1 * L), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const p = norm(sub(pole, sc(d, dot(pole, d))));
  return add(a, add(sc(d, l1 * cosA), sc(p, l1 * sinA)));
}
/** Cubic Hermite position + velocity. */
function hermite(p0, v0, p1, v1, T, t) {
  const s = clamp(t / T, 0, 1), s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = (6 * s2 - 6 * s) / T, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / T, d11 = 3 * s2 - 2 * s;
  return { p: add(add(sc(p0, h00), sc(v0, h10 * T)), add(sc(p1, h01), sc(v1, h11 * T))), v: add(add(sc(p0, d00), sc(v0, d10)), add(sc(p1, d01), sc(v1, d11))) };
}

// ── the mannequin (facing +z, +x = its left, metres; ~1.83 m) ──
const BODY = {
  root: [0, 0.94, 0.05], c_spine1: [0, 1.08, 0.03], c_spine2: [0, 1.2, 0.0], c_spine3: [0, 1.41, 0.02], c_neck: [0, 1.51, 0.06],
  c_head: [0, 1.61, 0.08], c_head_null: [0, 1.81, 0.1], l_uparm: [0.18, 1.44, 0.04], r_uparm: [-0.18, 1.44, 0.04],
  l_upleg: [0.09, 0.92, 0.06], r_upleg: [-0.09, 0.92, 0.06],
};
const L_UP = 0.28, L_FORE = 0.27, L_THIGH = 0.43, L_SHIN = 0.41;
const FING = { index: [0.047, 0.028, 0.022], middle: [0.05, 0.031, 0.024], ring: [0.047, 0.029, 0.022], pinky: [0.038, 0.022, 0.02] };

/**
 * Joint positions of the mannequin.
 * @param {object} p { at:[x,z] body offset, drop: pelvis drop, feet:{left:[x,y,z],right}, palms:{left:{c,n,y,curl},right} }
 */
export function mannequin(p) {
  const off = [p.at?.[0] || 0, -(p.drop || 0), p.at?.[1] || 0];
  const J = {};
  for (const [k, v] of Object.entries(BODY)) J[k] = add(v, k.includes('upleg') || k === 'root' || k.startsWith('c_') || k.includes('uparm') ? off : [0, 0, 0]);
  for (const [s, side] of [['l', 'left'], ['r', 'right']]) {
    const sg = s === 'l' ? 1 : -1;
    // leg: hip → knee (bends forward) → ankle on the given foot spot
    const ank = add(p.feet[side], [off[0], 0, off[2]]);
    J[`${s}_foot`] = ank;
    J[`${s}_lowleg`] = twoBone(J[`${s}_upleg`], ank, L_THIGH, L_SHIN, [sg * 0.15, 0, 1]);
    J[`${s}_ball`] = add(ank, [0, -0.05, 0.15]);
    // arm: shoulder → elbow (back / out) → wrist placed so the palm sits where asked
    const pm = p.palms[side];
    const n = norm(pm.n), y = norm(sub(pm.y, sc(n, dot(pm.y, n))));
    const x = s === 'r' ? cross(y, n) : cross(y, sc(n, -1));
    const m1Off = 0.086, pc = pm.c;
    const wr = sub(sub(pc, sc(y, 0.55 * m1Off)), sc(n, -0.004));
    J[`${s}_wrist`] = wr;
    J[`${s}_lowarm`] = twoBone(J[`${s}_uparm`], wr, L_UP, L_FORE, [sg * 0.5, -0.2, -1]);
    const m1 = add(wr, sc(y, m1Off));
    J[`${s}_middle1`] = m1;
    const knuck = { index: add(m1, sc(x, 0.022)), middle: m1, ring: add(m1, sc(x, -0.02)), pinky: add(m1, sc(x, -0.038)) };
    const curl = pm.curl ?? 0.35;
    for (const [f, ls] of Object.entries(FING)) {
      let q = knuck[f]; J[`${s}_${f}1`] = q;
      const names = [`${s}_${f}2`, `${s}_${f}3`, `${s}_${f}_null`];
      for (let k = 0; k < 3; k++) {
        const th = curl * (0.35 + 0.45 * k);
        q = add(q, sc(norm(add(sc(y, Math.cos(th)), sc(n, Math.sin(th)))), ls[k]));
        J[names[k]] = q;
      }
    }
    // thumb: from the base of the palm, out to the index side and along
    let t = add(add(wr, sc(y, 0.025)), sc(x, 0.03)); J[`${s}_thumb1`] = t;
    const td = norm(add(add(sc(x, 0.7), sc(y, 0.7)), sc(n, 0.25 + curl * 0.3)));
    for (const [k, l] of [['thumb2', 0.04], ['thumb3', 0.032], ['thumb_null', 0.026]]) { t = add(t, sc(td, l)); J[`${s}_${k}`] = t; }
  }
  return (name) => J[name] || J.root;
}

// ── dribble timelines ──
const R0 = BALL_DEFAULTS.radius, G = BALL_DEFAULTS.gravity;
/**
 * One dribble cycle as the "video" would show it: release at pr (ball
 * centre, moving vy0 down), bounce at pb, rise to the catch at pc; the
 * catching hand then rides the ball up, reverses and pushes it down again.
 */
function cycle({ pr, pb, pc, vy0, e = 0.8, hold = 0.2, handA, handB, t0 }) {
  const yr = pr[1] - R0;
  const t1 = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * G * yr)) / G;           // yr − vy0 t − g t²/2 = 0  (vy0 > 0 = down speed)
  const vImp = vy0 + G * t1, vUp = e * vImp;
  const hc = pc[1] - R0;
  const disc = vUp * vUp - 2 * G * hc;
  const t2 = disc > 0 ? (vUp - Math.sqrt(disc)) / G : vUp / G;
  const vc = vUp - G * t2;                                              // still rising at the catch
  return { pr, pb, pc, vy0, t1, t2, vImp, vUp, vc, hold, handA, handB, t0, T: t1 + t2 };
}
/** Ball "video" position/velocity at time t within a flight. */
function flightAt(c, t) {
  if (t <= c.t1) {
    const k = t / c.t1;
    const hx = lerp(c.pr, c.pb, k);
    return { p: [hx[0], c.pr[1] - c.vy0 * t - 0.5 * G * t * t, hx[2]], v: [(c.pb[0] - c.pr[0]) / c.t1, -c.vy0 - G * t, (c.pb[2] - c.pr[2]) / c.t1] };
  }
  const u = t - c.t1, k = u / c.t2;
  const hx = lerp(c.pb, c.pc, k);
  return { p: [hx[0], R0 + c.vUp * u - 0.5 * G * u * u, hx[2]], v: [(c.pc[0] - c.pb[0]) / c.t2, c.vUp - G * u, (c.pc[2] - c.pb[2]) / c.t2] };
}

/**
 * A scene: { name, duration, setup(sys), at(t) → { joints|null, intent }, checks }.
 * The timeline alternates hold (hand on the ball) and flight (ball free).
 */
function dribbleScene(name, legs, cycles, { move = [0, 0], palmTilt = {}, curl = 0.3, extra = {} } = {}) {
  // hold segments between flights; the first hold starts at t = 0 with the ball in handA of cycle 0
  const tl = [];
  let t = 0;
  for (const c of cycles) {
    // the hold ends moving exactly as the ball leaves: down, and sideways toward the bounce (a crossover push travels)
    const cc0 = cycle({ ...c, t0: 0 });
    const vRel = [(c.pb[0] - c.pr[0]) / cc0.t1, -c.vy0, (c.pb[2] - c.pr[2]) / cc0.t1];
    const prevF = tl.length ? tl[tl.length - 1].c : null;
    const vCatch = prevF ? [(prevF.pc[0] - prevF.pb[0]) / prevF.t2, prevF.vc, (prevF.pc[2] - prevF.pb[2]) / prevF.t2] : [0, 0, 0];
    // a sideways push starts from further back on the carrying side (the hand gathers the ball across)
    const from = prevF ? prevF.pc : add(c.pr, [0, 0.14, 0]);
    const hold = { kind: 'hold', t0: t, T: c.hold, hand: c.handA, to: c.pr, vTo: vRel, from, vFrom: vCatch };
    tl.push(hold); t += c.hold;
    const cc = cycle({ ...c, t0: t }); tl.push({ kind: 'flight', t0: t, T: cc.T, c: cc }); t += cc.T;
  }
  const last = tl[tl.length - 1];
  tl.push({ kind: 'hold', t0: t, T: 0.3, hand: last.c.handB, from: last.c.pc, vFrom: [(last.c.pc[0] - last.c.pb[0]) / last.c.t2, last.c.vc, (last.c.pc[2] - last.c.pb[2]) / last.c.t2], to: add(last.c.pc, [0, 0.1, 0]), vTo: [0, 0, 0], end: true });
  const duration = t + 0.3;
  const mv = (tt) => [move[0] * tt, 0, move[1] * tt];
  const seg = (tt) => tl.find((s) => tt >= s.t0 && tt < s.t0 + s.T) || tl[tl.length - 1];
  // the ball's "video" path (hold: Hermite between catch and release; flight: gravity arcs)
  const video = (tt) => {
    const s = seg(tt), u = tt - s.t0;
    let r;
    if (s.kind === 'hold') {
      // decelerate the rising ball, stop, push it down to the release point
      r = hermite(s.from, s.vFrom, s.to, s.vTo, s.T, u);
    } else r = flightAt(s.c, u);
    return { p: add(r.p, mv(tt)), v: add(r.v, [move[0], 0, move[1]]) };
  };
  const palmN = (hand, tt) => palmTilt[hand] ? norm(palmTilt[hand](tt)) : [0, -1, 0];
  const palmOnBall = (ballP, hand, tt) => { const n = palmN(hand, tt); return sub(sub(ballP, sc(n, R0 + 0.014)), sc([0, 0, 1], 0.012)); };
  const rest = { left: [0.34, 0.9, 0.12], right: [-0.34, 0.9, 0.12] };
  // hand paths: holding hand rides the ball; a free hand eases from its release point back up (above the ball) and down to its next catch
  const handAt = (hand, tt) => {
    const s = seg(tt), u = tt - s.t0;
    if (s.kind === 'hold' && s.hand === hand) return palmOnBall(video(tt).p, hand, tt);
    // find this hand's previous release and next catch
    let prevRel = null, nextCatch = null;
    for (const q of tl) {
      if (q.kind !== 'flight') continue;
      if (q.c.handA === hand && q.t0 <= tt) prevRel = q;
      if (q.c.handB === hand && q.t0 + q.T > tt && !nextCatch) nextCatch = q;
    }
    const idle = add(rest[hand], mv(tt));
    if (nextCatch && (!prevRel || prevRel === nextCatch || prevRel.t0 <= nextCatch.t0)) {
      const tc = nextCatch.t0 + nextCatch.T;
      const start = prevRel && prevRel.t0 <= tt ? { t: prevRel.t0, p: palmOnBall(add(prevRel.c.pr, mv(prevRel.t0)), hand, prevRel.t0), v: [move[0], -prevRel.c.vy0 * 0.35, move[1]] } : { t: Math.max(0, tc - 0.6), p: idle, v: [move[0], 0, move[1]] };
      const end = { p: palmOnBall(add(nextCatch.c.pc, mv(tc)), hand, tc), v: [move[0], nextCatch.c.vc, move[1]] };
      // the hand waits above its catch point: it never dives after the ball
      const hi = add(end.p, [0, 0.12, 0]);
      const mid = start.t + (tc - start.t) * 0.45;
      if (tt < start.t) return idle;
      if (tt < mid) return hermite(start.p, start.v, hi, [move[0], -0.3, move[1]], mid - start.t, tt - start.t).p;
      return hermite(hi, [move[0], -0.3, move[1]], end.p, end.v, tc - mid, tt - mid).p;
    }
    if (prevRel) {
      // after its last release the hand eases to rest
      return hermite(palmOnBall(add(prevRel.c.pr, mv(prevRel.t0)), hand, prevRel.t0), [move[0], -prevRel.c.vy0 * 0.35, move[1]], idle, [move[0], 0, move[1]], 0.5, tt - prevRel.t0).p;
    }
    return idle;
  };
  const at = (tt) => {
    const s = seg(tt);
    const palms = {};
    for (const hand of ['left', 'right']) palms[hand] = { c: handAt(hand, tt), n: palmN(hand, tt), y: [0, 0, 1], curl };
    const joints = mannequin({ at: [mv(tt)[0], mv(tt)[2]], drop: legs.drop || 0.06, feet: legs.feet, palms });
    const vd = video(tt);
    // intent (what an animation knows): held or not, which hand, the upcoming release / catch
    let catchIn = null, catchHand = null, releaseIn = null;
    let catchTarget = null;
    if (s.kind === 'flight') { catchIn = s.t0 + s.T - tt; catchHand = s.c.handB; catchTarget = add(s.c.pc, mv(s.t0 + s.T)); }
    else if (!s.end) {
      releaseIn = s.t0 + s.T - tt;
      const nf = tl[tl.indexOf(s) + 1];
      if (nf?.kind === 'flight') { catchIn = nf.t0 + nf.T - tt; catchHand = nf.c.handB; catchTarget = add(nf.c.pc, mv(nf.t0 + nf.T)); }
    }
    const hand = s.kind === 'hold' ? s.hand : s.c.handA;
    const va = video(tt + 0.15);
    return {
      joints,
      intent: { has: true, held: s.kind === 'hold', hand, catchHand, catchIn, catchTarget, releaseIn, target: vd.p, targetVel: vd.v, targetAhead: va.p, event: extra.event || null },
    };
  };
  return { name, duration, at, timeline: tl, video, start: () => video(0), ...extra };
}

const STANCE = {
  square: { feet: { left: [0.2, 0.09, 0.02], right: [-0.2, 0.09, 0.02] }, drop: 0.08 },
  wide: { feet: { left: [0.26, 0.09, 0.02], right: [-0.26, 0.09, 0.02] }, drop: 0.12 },
  stagger: { feet: { left: [0.24, 0.09, 0.3], right: [-0.24, 0.09, -0.26] }, drop: 0.14 },
  staggerNarrow: { feet: { left: [0.17, 0.09, 0.26], right: [-0.17, 0.09, -0.22] }, drop: 0.12 },
};

function repeatCycles(n, c) { return Array.from({ length: n }, () => ({ ...c })); }

/** All test scenes. */
export function scenes() {
  const out = {};
  // dribble spots outside the knees (a real dribble never bounces into the leg)
  const rightSpot = [-0.4, 0.72, 0.4], leftSpot = [0.4, 0.72, 0.4];
  const drb = (spot, hand) => ({ pr: spot, pb: add([spot[0], R0, spot[2]], [0, 0, 0.04]), pc: add(spot, [0, 0.02, 0]), vy0: 3.4, hold: 0.2, handA: hand, handB: hand });
  out['dribble-right'] = dribbleScene('dribble-right', STANCE.square, repeatCycles(5, drb(rightSpot, 'right')), { extra: { event: 'RIGHT_HAND_DRIBBLE' } });
  out['dribble-left'] = dribbleScene('dribble-left', STANCE.square, repeatCycles(5, drb(leftSpot, 'left')), { extra: { event: 'LEFT_HAND_DRIBBLE' } });
  out.pound = dribbleScene('pound', STANCE.wide, repeatCycles(6, { ...drb([-0.42, 0.66, 0.42], 'right'), vy0: 6.2, hold: 0.14 }), { extra: { event: 'RIGHT_HAND_DRIBBLE' } });
  out.low = dribbleScene('low', STANCE.wide, repeatCycles(6, { pr: [-0.44, 0.42, 0.44], pb: [-0.44, R0, 0.46], pc: [-0.44, 0.44, 0.44], vy0: 2.2, hold: 0.12, handA: 'right', handB: 'right' }), { curl: 0.2, extra: { event: 'RIGHT_HAND_DRIBBLE' } });
  // seen from above a crossover travels in a straight line hand to hand (a bounce cannot turn it), bouncing midway
  const crossRL = { pr: [-0.4, 0.7, 0.4], pb: [0.0, R0, 0.43], pc: [0.4, 0.72, 0.46], vy0: 3.6, hold: 0.2, handA: 'right', handB: 'left' };
  const crossLR = { ...crossRL, pr: [0.4, 0.7, 0.4], pc: [-0.4, 0.72, 0.46], handA: 'left', handB: 'right' };
  // the pushing palm faces down and toward the other hand; the catching palm down and toward the ball
  const tiltRL = { right: () => [0.45, -1, 0], left: () => [-0.35, -1, 0] };
  const tiltLR = { right: () => [0.35, -1, 0], left: () => [-0.45, -1, 0] };
  out['cross-rl'] = dribbleScene('cross-rl', STANCE.square, [drb(rightSpot, 'right'), crossRL, drb(leftSpot, 'left')], { palmTilt: tiltRL, extra: { event: 'CROSSOVER' } });
  out['cross-lr'] = dribbleScene('cross-lr', STANCE.square, [drb(leftSpot, 'left'), crossLR, drb(rightSpot, 'right')], { palmTilt: tiltLR, extra: { event: 'CROSSOVER' } });
  // between the legs: left foot forward; right hand (front-right) → between the feet → left hand (back-left)
  // the ball enters in front of the (back) right knee, bounces in the channel between the front-left and
  // back-right shins, and rises behind the (front) left shin to the left hand
  const btl = { pr: [-0.34, 0.56, 0.4], pb: [0.0, R0, 0.1], pc: [0.36, 0.56, -0.16], vy0: 3.4, hold: 0.2, handA: 'right', handB: 'left' };
  out.btl = dribbleScene('btl', STANCE.stagger, [{ ...drb([-0.34, 0.6, 0.4], 'right') }, btl, { ...drb([0.36, 0.58, -0.16], 'left') }],
    { palmTilt: { right: () => [0.35, -1, -0.3], left: () => [-0.3, -1, 0.3] }, extra: { event: 'BETWEEN_LEGS' } });
  out['btl-narrow'] = dribbleScene('btl-narrow', STANCE.staggerNarrow, [{ ...drb([-0.32, 0.6, 0.36], 'right') }, { ...btl, pr: [-0.32, 0.56, 0.36], pb: [0.0, R0, 0.08], pc: [0.34, 0.56, -0.14] }, { ...drb([0.34, 0.58, -0.14], 'left') }],
    { palmTilt: { right: () => [0.35, -1, -0.3], left: () => [-0.3, -1, 0.3] }, extra: { event: 'BETWEEN_LEGS' } });
  // behind the back: right hand behind the right hip → floor behind → left hand behind the left hip
  // straight across behind the hips (pelvis back ≈ z −0.08, so the ball centre stays behind z −0.2)
  const btb = { pr: [-0.4, 0.72, -0.3], pb: [0.0, R0, -0.32], pc: [0.4, 0.7, -0.34], vy0: 3.2, hold: 0.2, handA: 'right', handB: 'left' };
  out.btb = dribbleScene('btb', STANCE.square, [{ ...drb([-0.4, 0.72, -0.3], 'right') }, btb, { ...drb([0.4, 0.7, -0.34], 'left') }],
    { palmTilt: { right: () => [0.4, -1, -0.2], left: () => [-0.4, -1, -0.2] }, extra: { event: 'BEHIND_BACK' } });
  // moving dribble: the whole player travels forward at 2 m/s
  out.moving = dribbleScene('moving', STANCE.square, repeatCycles(5, { ...drb(rightSpot, 'right'), vy0: 3.4 }), { move: [0, 2.0], extra: { event: 'RIGHT_HAND_DRIBBLE' } });
  // gather: a bounce rises between both palms, which close on it and hold it at the chest
  out.gather = gatherScene();
  out.drop = { name: 'drop', duration: 6, start: () => ({ p: [0, 1.8, 0.6], v: [0, 0, 0], w: [0, 0, 0] }), at: () => ({ joints: null, intent: { has: false } }), noPlayer: true };
  out['drop-spin'] = { name: 'drop-spin', duration: 6, start: () => ({ p: [0, 1.5, 0.6], v: [0.8, 0, 0], w: [0, 0, -18] }), at: () => ({ joints: null, intent: { has: false } }), noPlayer: true };
  return out;
}

function gatherScene() {
  // ball dropped from 1.3 m in front; both hands come in from the sides and catch it at ~0.95 m as it rises
  const p0 = [0, 1.6, 0.38], e = 0.8;
  const tFall = Math.sqrt(2 * (p0[1] - R0) / G), vImp = G * tFall, vUp = e * vImp;
  const yc = 0.95, disc = vUp * vUp - 2 * G * (yc - R0), t2 = (vUp - Math.sqrt(disc)) / G, tc = tFall + t2, vc = vUp - G * t2;
  const video = (t) => {
    if (t < tFall) return { p: [p0[0], p0[1] - 0.5 * G * t * t, p0[2]], v: [0, -G * t, 0] };
    if (t < tc) { const u = t - tFall; return { p: [p0[0], R0 + vUp * u - 0.5 * G * u * u, p0[2]], v: [0, vUp - G * u, 0] }; }
    const u = t - tc, r = hermite([p0[0], yc, p0[2]], [0, vc, 0], [p0[0], 1.1, p0[2] - 0.05], [0, 0, 0], 0.35, u);
    return u < 0.35 ? r : { p: [p0[0], 1.1, p0[2] - 0.05], v: [0, 0, 0] };
  };
  const palmsAt = (t) => {
    const b = t < tc ? [p0[0], yc, p0[2]] : video(t).p;
    const w = t < tc ? clamp((tc - t) / 0.35, 0, 1) : 0;   // the hands close on the ball as it arrives
    const off = R0 + 0.014 + 0.18 * w;
    return { left: { c: add(b, [off, 0, 0]), n: [-1, 0, 0], y: [0, 0.3, 1], curl: 0.45 }, right: { c: add(b, [-off, 0, 0]), n: [1, 0, 0], y: [0, 0.3, 1], curl: 0.45 } };
  };
  return {
    name: 'gather', duration: tc + 1.0, video, start: () => ({ p: p0, v: [0, 0, 0], w: [0, 0, 0] }),
    at: (t) => {
      const joints = mannequin({ drop: 0.08, feet: STANCE.square.feet, palms: palmsAt(t) });
      const held = t >= tc - 0.02;
      const vd = video(t);
      return { joints, intent: held ? { has: true, held: true, hand: 'right', target: vd.p, targetVel: vd.v, event: 'GATHER' } : { has: true, held: false, hand: 'right', catchHand: 'right', catchIn: tc - t, target: vd.p, targetVel: vd.v, event: 'GATHER' } };
    },
    tc,
  };
}

/**
 * Run a scene headless through a system (Node tests; the court's lab view
 * steps the same scene in real time).
 * @returns metrics
 */
export function runScene(sys, scene, { bodySample, dt = 1 / 60 } = {}) {
  const st = scene.start ? scene.start() : { p: [0, 1, 0] };
  const first = scene.at(0);
  if (scene.noPlayer || !first.intent?.held) sys.placeBall(st.p, st.v || [0, 0, 0], st.w || [0, 0, 0]);
  else {
    // the ball starts in the first hand (on its palm surface), at rest relative to it
    const S0 = bodySample(first.joints, sys.legYield);
    const palm = S0.palms[first.intent.hand];
    sys.placeBall(sys.palmTarget(palm), [0, 0, 0], [0, 0, 0]);
  }
  const log = [];
  let S0 = first.joints ? bodySample(first.joints, sys.legYield) : null, I0 = first.intent;
  let t = 0, minFlightGap = [], curGap = null, lastHeld = I0?.held, maxYield = 0;
  const lat = [];
  while (t < scene.duration) {
    const f = scene.at(t + dt);
    const S1 = f.joints ? bodySample(f.joints, sys.legYield) : null;
    sys.advance(dt, S0, S1, I0, f.intent);
    t += dt;
    const b = sys.cur;
    maxYield = Math.max(maxYield, len(sys.legYield.left), len(sys.legYield.right));
    // hand ↔ ball separation during each flight
    if (f.intent?.has && !f.intent.held) { curGap = Math.max(curGap ?? -1, sys.handGap ?? 0); }
    if (f.intent?.held && lastHeld === false && curGap != null) { minFlightGap.push(curGap); curGap = null; }
    lastHeld = f.intent?.held;
    log.push({ t: +t.toFixed(4), p: b.p, v: b.v, w: b.w, state: sys.state, hand: sys.hand, target: f.intent?.target || null, gap: sys.handGap });
    lat.push(b.p[0]);
    S0 = S1; I0 = f.intent;
  }
  const errs = log.filter((l) => l.target).map((l) => len(sub(l.p, l.target)));
  return {
    log, stats: sys.stats, flightMaxGaps: minFlightGap, maxLegYield: maxYield,
    videoErrMean: errs.length ? errs.reduce((a, x) => a + x, 0) / errs.length : null,
    videoErrMax: errs.length ? Math.max(...errs) : null,
    final: sys.cur, statesSeen: [...new Set(log.map((l) => l.state))],
  };
}
