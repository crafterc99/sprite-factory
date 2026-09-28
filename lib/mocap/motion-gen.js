/**
 * Generated basketball motions — a small parametric humanoid (MHR70
 * keypoints, metres, y-up, facing +Z, left = +X) posed by IK from planned
 * feet, pelvis, trunk and hands, plus the ball. Used for clips nobody has
 * recorded yet (run-dribble, crossover) and as ball ground truth for motions
 * generated elsewhere (Kimodo has no ball: synthesizeBall() reads the dribble
 * from the hands).
 *
 *   runDribble({ speed, fps, cycles, hand })        speed dribble, flight phase, ball pushed ahead
 *   crossover({ fps, hand, moving })                ball crosses in front, R → L, with a side step
 *
 * Output: { fps, statureM, frames: [70 × [x,y,z]], balls: [{ p, held, hand } | null], name, role, type }
 * — the shape clip-builder.buildGameClip({ worldFrames, … }) takes.
 */
'use strict';

const S = require('./skeleton');
const { J } = S;

// 1.80 m adult
const D = {
  hipW: 0.095, thigh: 0.45, shin: 0.44, ankleH: 0.085, trunk: 0.5, shoulderW: 0.19,
  upperArm: 0.3, forearm: 0.27, stature: 1.8, ballR: 0.12,
};
const V = { add: S.add, sub: S.sub, sc: S.scale, dot: S.dot, cross: S.cross, norm: S.norm, len: S.len };
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const rotYv = (yaw, v) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };
/** Rotation matrix (rows) from yaw (about Y), pitch (forward lean about the local X) and roll (about local Z). */
function frameOf(yaw, pitch = 0, roll = 0) {
  // local axes before yaw: right-handed, fwd = +Z, left = +X, up = +Y
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  let up = [0, cp, sp], fwd = [0, -sp, cp], left = [1, 0, 0];
  // roll: tilt up toward left (+roll leans to the left)
  up = V.add(V.sc(up, cr), V.sc(left, sr)); left = V.sub(V.sc(left, cr), V.sc([0, cp, sp], sr));
  return { left: rotYv(yaw, left), up: rotYv(yaw, up), fwd: rotYv(yaw, fwd) };
}
const inFrame = (F, o, v) => V.add(o, V.add(V.add(V.sc(F.left, v[0]), V.sc(F.up, v[1])), V.sc(F.fwd, v[2])));

/** Two-bone IK: joint (knee/elbow) for root→end target, bending toward `pole`. */
function ik(root, target, L1, L2, pole) {
  let d = V.sub(target, root), L = V.len(d);
  const reach = (L1 + L2) * 0.999;
  if (L > reach) { d = V.sc(d, reach / L); L = reach; }
  const u = V.norm(d);
  const a = (L1 * L1 - L2 * L2 + L * L) / (2 * L), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  let p = V.sub(pole, V.sc(u, V.dot(pole, u)));
  if (V.len(p) < 1e-6) p = [0, 0, 1];
  return { mid: V.add(V.add(root, V.sc(u, a)), V.sc(V.norm(p), h)), end: V.add(root, d) };
}

/**
 * One pose. st = {
 *   pelvis [x,y,z], yaw, pitch (trunk lean fwd), roll, twist (chest vs hips, rad), headYaw,
 *   feet: { left: { ankle [x,y,z], yaw, pitch }, right: … },
 *   hands: { left: { wrist [x,y,z], palm [x,y,z] (palm normal), curl }, right: … } }
 */
function pose(st) {
  const P = new Array(70);
  const set = (n, p) => { P[J[n]] = p.map((x) => +x.toFixed(5)); };
  const H = frameOf(st.yaw, 0, 0);                         // hips
  const C = frameOf(st.yaw + (st.twist || 0), st.pitch || 0, st.roll || 0); // chest
  const pel = st.pelvis;
  for (const [s, sx] of [['left', 1], ['right', -1]]) set(`${s}-hip`, inFrame(H, pel, [sx * D.hipW, 0, 0]));
  const neck = inFrame(C, pel, [0, D.trunk, 0.02]);
  set('neck', neck);
  for (const [s, sx] of [['left', 1], ['right', -1]]) {
    set(`${s}-shoulder`, inFrame(C, neck, [sx * D.shoulderW, -0.05, -0.01]));
    set(`${s}-acromion`, inFrame(C, neck, [sx * (D.shoulderW + 0.02), -0.03, -0.01]));
  }
  const Hd = frameOf(st.yaw + (st.twist || 0) + (st.headYaw || 0), (st.pitch || 0) * 0.4 - 0.05, 0);
  set('nose', inFrame(Hd, neck, [0, 0.16, 0.11]));
  set('left-eye', inFrame(Hd, neck, [0.033, 0.19, 0.085])); set('right-eye', inFrame(Hd, neck, [-0.033, 0.19, 0.085]));
  set('left-ear', inFrame(Hd, neck, [0.075, 0.16, -0.01])); set('right-ear', inFrame(Hd, neck, [-0.075, 0.16, -0.01]));
  // legs + feet
  for (const [s, sx] of [['left', 1], ['right', -1]]) {
    const f = st.feet[s], hip = P[J[`${s}-hip`]];
    const Fd = frameOf(f.yaw, f.pitch || 0, 0);
    const knee = ik(hip, f.ankle, D.thigh, D.shin, V.add(Fd.fwd, [0, 0.1, 0]));
    set(`${s}-knee`, knee.mid); set(`${s}-ankle`, knee.end);
    const a = knee.end;
    set(`${s}-heel`, inFrame(Fd, a, [0, -0.06, -0.065]));
    set(`${s}-big-toe-tip`, inFrame(Fd, a, [-sx * 0.02, -0.07, 0.17]));
    set(`${s}-small-toe-tip`, inFrame(Fd, a, [sx * 0.045, -0.07, 0.14]));
  }
  // arms + hands
  for (const [s, sx] of [['left', 1], ['right', -1]]) {
    const h = st.hands[s], sh = P[J[`${s}-shoulder`]];
    const pole = V.add(V.add(V.sc(C.left, sx * 0.6), V.sc(C.fwd, -0.5)), [0, -0.3, 0]); // elbows out and back
    const arm = ik(sh, h.wrist, D.upperArm, D.forearm, pole);
    set(`${s}-elbow`, arm.mid); set(`${s}-wrist`, arm.end);
    const fore = V.norm(V.sub(arm.end, arm.mid));
    const flex = V.norm(V.cross(V.sub(sh, arm.mid), V.sub(arm.end, arm.mid)));
    const n = V.len(flex) > 1e-6 ? flex : C.left;
    set(`${s}-olecranon`, V.add(arm.mid, V.sc(V.norm(V.sub(V.sc(fore, -1), V.sc(V.sub(sh, arm.mid), 0))), 0.0)));
    const back = V.norm(V.add(V.norm(V.sub(sh, arm.mid)), fore)); // bisector points to the back of the elbow
    set(`${s}-olecranon`, V.sub(arm.mid, V.sc(back, 0.03)));
    set(`${s}-cubital-fossa`, V.add(arm.mid, V.sc(back, 0.03)));
    void n;
    // hand frame: fingers continue the forearm, bent toward the palm normal
    const palm = V.norm(h.palm || [0, -1, 0]);
    let dir = V.norm(V.sub(fore, V.sc(palm, V.dot(fore, palm))));
    if (!(V.len(dir) > 0.5)) dir = fore;
    const across = V.norm(V.cross(palm, dir)); // thumb side for the right hand is −across·sx
    const curl = h.curl ?? 0.35;
    const w = arm.end;
    const fingers = [['index', 0.022], ['middle', 0.004], ['ring', -0.014], ['pinky', -0.03]];
    for (const [fname, off] of fingers) {
      let p = V.add(V.add(w, V.sc(dir, 0.085)), V.sc(across, off * sx));
      set(`${s}-${fname}-third-joint`, p);
      let fd = dir;
      for (const [jn, len, bend] of [['second-joint', 0.042, curl], ['first-joint', 0.026, curl], ['tip', 0.022, curl * 0.8]]) {
        fd = V.norm(V.add(V.sc(fd, Math.cos(bend)), V.sc(palm, Math.sin(bend))));
        p = V.add(p, V.sc(fd, len));
        set(`${s}-${fname}-${jn}`, p);
      }
    }
    // thumb from the wrist, on the index side, toward the palm
    let t = V.add(V.add(w, V.sc(dir, 0.03)), V.sc(across, 0.03 * sx));
    set(`${s}-thumb-third-joint`, t);
    let td = V.norm(V.add(V.add(V.sc(dir, 0.6), V.sc(across, 0.5 * sx)), V.sc(palm, 0.35)));
    for (const [jn, len] of [['second-joint', 0.035], ['first-joint', 0.03], ['tip', 0.025]]) { t = V.add(t, V.sc(td, len)); set(`${s}-thumb-${jn}`, t); td = V.norm(V.add(td, V.sc(palm, 0.25))); }
  }
  return P;
}
const palmOf = (P, s) => S.mid(P[J[`${s}-wrist`]], P[J[`${s}-middle-first-joint`]]);

/**
 * Speed dribble: running (flight phase) straight ahead, one push per stride,
 * the ball bouncing ~0.6 m ahead of the body; off arm swings. A whole number
 * of strides → loops.
 */
function runDribble({ speed = 4.4, fps = 30, cycles = 2, hand = 'right', cadence = 2.9 } = {}) {
  const stride = 2 / cadence;                  // s per gait cycle (2 steps)
  const T = stride * cycles, N = Math.round(T * fps);
  const duty = 0.36;                            // share of the cycle a foot is on the floor
  const frames = [], balls = [];
  const off = hand === 'right' ? 'left' : 'right', hs = hand === 'right' ? -1 : 1;
  const stepLen = speed * stride;               // one foot's travel per cycle
  const footAt = (side, t) => {
    const ph0 = side === 'left' ? 0 : 0.5;
    const u = t / stride + ph0, k = Math.floor(u), ph = u - k;     // ph 0 = this foot lands
    const land = (kk) => (kk - ph0) * stride * speed + speed * stride * duty * 0.5 - 0.05; // plant under the body mid-stance
    const lat = (side === 'left' ? 1 : -1) * 0.1;
    if (ph < duty) return { ankle: [lat, D.ankleH, land(k)], pitch: ph > duty * 0.7 ? -0.5 * (ph - duty * 0.7) / (duty * 0.3) : 0, planted: true };
    const s = (ph - duty) / (1 - duty), e = smooth(s);
    const z = lerp(land(k), land(k + 1), e);
    const y = D.ankleH + 0.3 * Math.sin(Math.PI * Math.min(1, s * 1.15)) ** 1.3 * (1 - 0.3 * s); // heel kicks up behind
    return { ankle: [lat, y, z], pitch: -0.6 * Math.sin(Math.PI * s) * (1 - s), planted: false };
  };
  for (let i = 0; i < N; i++) {
    const t = i / fps, root = speed * t;
    const cyc = (t / stride) % 1;              // 0 = left plant
    // pelvis: lowest mid-stance, highest mid-flight (two per cycle)
    const bob = -0.035 * Math.cos(4 * Math.PI * (cyc - duty / 2));
    const pelvis = [0, 0.9 + bob, root];
    const hipYaw = 0.12 * Math.sin(2 * Math.PI * (cyc - 0.25));  // hips swing with the legs
    const feet = { left: footAt('left', t), right: footAt('right', t) };
    for (const s of ['left', 'right']) feet[s].yaw = 0;
    // off arm: pumps opposite to its leg
    const swing = Math.sin(2 * Math.PI * (cyc + (off === 'left' ? 0.5 : 0)));
    const ox = off === 'left' ? 1 : -1;
    const offWrist = [ox * 0.24, 1.0 + 0.06 * swing, root + 0.12 + 0.2 * swing];
    // dribble hand: one push per cycle, ball ahead of the body
    const dp = (cyc + 0.15) % 1;                 // push when the dribble-side foot is down
    let wy, wz, held, by, bz;
    const ahead = 0.42;
    if (dp < 0.35) {                             // catch → carry → push down (in contact)
      const q = dp / 0.35;
      wy = lerp(1.0, 0.82, smooth(q)); wz = root + ahead + 0.1 * q;
      held = true;
    } else {                                     // ball away: hand rises back to meet it
      const q = (dp - 0.35) / 0.65;
      wy = lerp(0.82, 1.0, smooth(q)); wz = root + ahead + 0.1 - 0.1 * q;
      held = false;
    }
    const dribWrist = [hs * 0.3, wy, wz];
    const P = pose({
      pelvis, yaw: hipYaw, pitch: 0.2, roll: 0, twist: -hipYaw * 1.6, headYaw: 0,
      feet,
      hands: { [hand]: { wrist: dribWrist, palm: [0, -1, 0.25], curl: 0.3 }, [off]: { wrist: offWrist, palm: [-ox * 0.8, -0.2, 0.3], curl: 0.9 } },
    });
    frames.push(P);
    const palm = palmOf(P, hand);
    balls.push(held ? { p: V.add(palm, [0, -(D.ballR + 0.03), 0.02]), held: true, hand } : { p: [palm[0], Math.max(D.ballR, palm[1] - 0.5), palm[2] + 0.1], held: false, hand });
    void by; void bz;
  }
  return { name: 'Run dribble (generated)', role: 'loco-sprint', type: 'loop', fps, statureM: D.stature, frames, balls, source: 'procedural', params: { speed, cycles, hand, cadence } };
}

/**
 * Crossover: dribbling in `hand` (IDS), a hard dribble across the front of the
 * body (bounce between the feet), caught by the other hand, with a lateral
 * step toward the new ball side; ends dribbling in the other hand.
 * moving: enters jogging forward (≈2 m/s) and cuts across.
 */
function crossover({ fps = 30, hand = 'right', moving = false } = {}) {
  const other = hand === 'right' ? 'left' : 'right';
  const toSide = other === 'left' ? 1 : -1;     // +X = left
  const T = moving ? 1.9 : 2.2, N = Math.round(T * fps);
  const frames = [], balls = [];
  const tCross0 = moving ? 0.55 : 0.75, tCross1 = tCross0 + 0.3;   // the cross (release → catch)
  const vIn = moving ? 2.0 : 0;
  // stance feet (x = lateral, z = forward): IDS with the ball-side foot back
  const stance = (h) => ({ left: [0.2, h === 'right' ? 0.12 : -0.08], right: [-0.2, h === 'right' ? -0.08 : 0.12] });
  const s0 = stance(hand), s1 = stance(other);
  const shift = 0.32 * toSide;                  // body travel toward the new side
  for (let i = 0; i < N; i++) {
    const t = i / fps;
    // root: moving variant keeps forward speed until the cut, then goes sideways
    const zRoot = moving ? vIn * Math.min(t, tCross0) + vIn * 0.4 * Math.max(0, Math.min(t - tCross0, 0.5)) : 0;
    const k = smooth((t - tCross0 + 0.1) / 0.5);  // weight transfer across the cross
    const xRoot = shift * k;
    const dip = -0.07 * Math.exp(-(((t - (tCross0 + 0.12)) / 0.18) ** 2));  // sink into the cross
    const pelvis = [xRoot, 0.84 + dip, zRoot + 0.02];
    // feet: the lead foot (new side) steps out during the cross; the trail foot follows
    const stepA = smooth((t - (tCross0 - 0.05)) / 0.22), stepB = smooth((t - (tCross0 + 0.2)) / 0.24);
    const lead = other, trail = hand;
    const fp = {};
    for (const sd of ['left', 'right']) {
      const a = s0[sd], b = s1[sd];
      const g = sd === lead ? stepA : stepB;
      let x = lerp(a[0], b[0], g) + shift * g, z = lerp(a[1], b[1], g);
      if (moving) {
        // jogging in: alternate small steps along z until the cut
        const ph = (t * 2.6 + (sd === 'left' ? 0 : 0.5)) % 1;
        const run = Math.max(0, 1 - smooth((t - tCross0 + 0.15) / 0.2));
        const stepZ = vIn / 2.6;
        z += run * (Math.floor(t * 2.6 + (sd === 'left' ? 0 : 0.5)) * stepZ + (ph < 0.5 ? 0 : smooth((ph - 0.5) / 0.5) * stepZ)) + (1 - run) * (vIn * tCross0);
      }
      const lift = 0.07 * Math.sin(Math.PI * g) + (moving ? 0.08 * Math.max(0, Math.sin(Math.PI * 2 * ((t * 2.6 + (sd === 'left' ? 0 : 0.5)) % 1) - Math.PI)) * Math.max(0, 1 - smooth((t - tCross0 + 0.15) / 0.2)) : 0);
      fp[sd] = { ankle: [x, D.ankleH + Math.max(0, lift), z], yaw: 0, pitch: 0 };
    }
    // ball: dribble in `hand` (0.5 s cycles), the cross, then dribble in `other`
    const dribble = (hd, tt, base) => {         // hand position + held for a stationary dribble cycle
      const c = ((tt % 0.5) + 0.5) % 0.5 / 0.5;
      const sx = hd === 'left' ? 1 : -1;
      const held = c < 0.4;
      const y = held ? lerp(0.98, 0.72, smooth(c / 0.4)) : lerp(0.72, 0.98, smooth((c - 0.4) / 0.6));
      return { wrist: [base[0] + sx * 0.36, y, base[2] + 0.22], held };
    };
    let wR, wL, held = true, ballHand = hand;
    const base = [xRoot, 0, zRoot];
    const idleOff = (hd) => { const sx = hd === 'left' ? 1 : -1; return [base[0] + sx * 0.28, 1.08, base[2] + 0.34]; }; // guard arm
    if (t < tCross0 - 0.18) {
      const d = dribble(hand, t, base); held = d.held;
      if (hand === 'right') { wR = d.wrist; wL = idleOff('left'); } else { wL = d.wrist; wR = idleOff('right'); }
    } else if (t < tCross1 + 0.02) {
      // wind-up (ball held high on the ball side) → push across and down → catch low on the new side
      const q = (t - (tCross0 - 0.18)) / (tCross1 + 0.02 - (tCross0 - 0.18));
      const sxA = hand === 'left' ? 1 : -1, sxB = -sxA;
      const pushEnd = 0.18 / (tCross1 + 0.02 - (tCross0 - 0.18));
      const wBall = q < pushEnd
        ? [base[0] + sxA * lerp(0.36, 0.22, q / pushEnd), lerp(0.95, 0.62, smooth(q / pushEnd)), base[2] + 0.28]
        : [base[0] + sxA * 0.18, 0.75, base[2] + 0.28];
      const wCatch = [base[0] + sxB * lerp(0.1, 0.34, smooth((q - pushEnd) / (1 - pushEnd))), lerp(0.85, 0.66, smooth((q - pushEnd) / (1 - pushEnd))), base[2] + 0.3];
      held = q < pushEnd;
      ballHand = held ? hand : other;
      if (hand === 'right') { wR = wBall; wL = wCatch; } else { wL = wBall; wR = wCatch; }
    } else {
      const d = dribble(other, t - tCross1 - 0.02, base); held = d.held;  // caught at the end of the cross
      ballHand = other;
      if (other === 'right') { wR = d.wrist; wL = idleOff('left'); } else { wL = d.wrist; wR = idleOff('right'); }
    }
    const lean = 0.18 + 0.08 * Math.exp(-(((t - (tCross0 + 0.1)) / 0.2) ** 2));
    const P = pose({
      pelvis, yaw: 0.1 * toSide * (k - 0.5), pitch: lean, roll: -0.12 * toSide * (k - 0.5), twist: 0, headYaw: 0,
      feet: fp,
      hands: { right: { wrist: wR, palm: [0.2, -1, 0.1], curl: 0.35 }, left: { wrist: wL, palm: [-0.2, -1, 0.1], curl: 0.35 } },
    });
    frames.push(P);
    const palm = palmOf(P, ballHand);
    balls.push(held ? { p: V.add(palm, [0, -(D.ballR + 0.03), 0.02]), held: true, hand: ballHand } : { p: [palm[0], Math.max(D.ballR, palm[1] - 0.4), palm[2]], held: false, hand: ballHand });
  }
  return {
    name: moving ? 'Crossover on the move (generated)' : 'Crossover (generated)', role: 'move-crossover', type: 'action',
    fps, statureM: D.stature, frames, balls, source: 'procedural', params: { hand, moving },
    entryMax: Math.max(0, Math.round((tCross0 - 0.25) * fps)), // the move may start right before the cross
  };
}

/**
 * A ball for a motion that has none (Kimodo): contact while a hand is in the
 * upper part of its bounce cycle and not rising fast; the hand that is lower
 * and in front is the dribble hand. Free segments are flown by the runtime.
 */
function synthesizeBall(frames, fps, { hand = null } = {}) {
  const N = frames.length;
  const wy = (s) => frames.map((P) => palmOf(P, s)[1]);
  const smoothS = (a) => a.map((_, i) => { let s = 0, n = 0; for (let k = -1; k <= 1; k++) { const v = a[i + k]; if (v != null) { s += v; n++; } } return s / n; });
  const Y = { left: smoothS(wy('left')), right: smoothS(wy('right')) };
  // dribble hand per frame: the one lower (and nearer the ball height band) — or fixed
  const which = frames.map((_, i) => hand || (Y.left[i] < Y.right[i] ? 'left' : 'right'));
  const out = [];
  for (let i = 0; i < N; i++) {
    const s = which[i], y = Y[s];
    const lo = Math.min(...y.slice(Math.max(0, i - fps), Math.min(N, i + fps))), hi = Math.max(...y.slice(Math.max(0, i - fps), Math.min(N, i + fps)));
    const vy = ((y[Math.min(N - 1, i + 1)] - y[Math.max(0, i - 1)]) * fps) / 2;
    const band = hi - lo > 0.08 ? (y[i] - lo) / (hi - lo) : 1;
    const held = band > 0.45 && vy < 0.8;
    const palm = palmOf(frames[i], s);
    out.push(held ? { p: V.add(palm, [0, -(D.ballR + 0.03), 0.02]), held: true, hand: s } : { p: [palm[0], Math.max(D.ballR, palm[1] - 0.4), palm[2]], held: false, hand: s });
  }
  return out;
}

// ── scripted hands on a generated body (Kimodo) ────────────────────────────
/** Body frame of a pose: floor point under the hips + facing (hips + shoulders). */
function bodyFrame(P) {
  const lh = P[J['left-hip']], rh = P[J['right-hip']], ls = P[J['left-shoulder']], rs = P[J['right-shoulder']];
  const left = V.norm(V.add(V.sub(lh, rh), V.sub(ls, rs)));
  const fwd = V.norm([-left[2], 0, left[0]]);            // left × up … (+X left, +Z fwd)
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const o = S.mid(lh, rh);
  return { o: [o[0], 0, o[2]], yaw, pelvisY: o[1] };
}
const bodyToWorld = (B, v) => { const r = rotYv(B.yaw, v); return [B.o[0] + r[0], r[1], B.o[2] + r[2]]; };

/** Re-solve one arm to a wrist target (two-bone IK with the source's own lengths), rebuild the hand. */
function setArm(P, s, wrist, palm, curl, P0) {
  const sx = s === 'left' ? 1 : -1;
  const sh = P[J[`${s}-shoulder`]];
  const L1 = S.dist(P0[J[`${s}-shoulder`]], P0[J[`${s}-elbow`]]) || D.upperArm, L2 = S.dist(P0[J[`${s}-elbow`]], P0[J[`${s}-wrist`]]) || D.forearm;
  const B = bodyFrame(P);
  const leftV = rotYv(B.yaw, [1, 0, 0]), fwdV = rotYv(B.yaw, [0, 0, 1]);
  const pole = V.add(V.add(V.sc(leftV, sx * 0.6), V.sc(fwdV, -0.5)), [0, -0.3, 0]);
  const arm = ik(sh, wrist, L1, L2, pole);
  P[J[`${s}-elbow`]] = arm.mid; P[J[`${s}-wrist`]] = arm.end;
  const back = V.norm(V.add(V.norm(V.sub(sh, arm.mid)), V.norm(V.sub(arm.end, arm.mid))));
  P[J[`${s}-olecranon`]] = V.sub(arm.mid, V.sc(back, 0.03)); P[J[`${s}-cubital-fossa`]] = V.add(arm.mid, V.sc(back, 0.03));
  // hand (same construction as pose())
  const fore = V.norm(V.sub(arm.end, arm.mid));
  const pn = V.norm(palm);
  let dir = V.norm(V.sub(fore, V.sc(pn, V.dot(fore, pn)))); if (!(V.len(dir) > 0.5)) dir = fore;
  const across = V.norm(V.cross(pn, dir)), w = arm.end;
  for (const [fname, off] of [['index', 0.022], ['middle', 0.004], ['ring', -0.014], ['pinky', -0.03]]) {
    let p = V.add(V.add(w, V.sc(dir, 0.085)), V.sc(across, off * sx)); P[J[`${s}-${fname}-third-joint`]] = p;
    let fd = dir;
    for (const [jn, len, bend] of [['second-joint', 0.042, curl], ['first-joint', 0.026, curl], ['tip', 0.022, curl * 0.8]]) { fd = V.norm(V.add(V.sc(fd, Math.cos(bend)), V.sc(pn, Math.sin(bend)))); p = V.add(p, V.sc(fd, len)); P[J[`${s}-${fname}-${jn}`]] = p; }
  }
  let t = V.add(V.add(w, V.sc(dir, 0.03)), V.sc(across, 0.03 * sx)); P[J[`${s}-thumb-third-joint`]] = t;
  let td = V.norm(V.add(V.add(V.sc(dir, 0.6), V.sc(across, 0.5 * sx)), V.sc(pn, 0.35)));
  for (const [jn, len] of [['second-joint', 0.035], ['first-joint', 0.03], ['tip', 0.025]]) { t = V.add(t, V.sc(td, len)); P[J[`${s}-thumb-${jn}`]] = t; td = V.norm(V.add(td, V.sc(pn, 0.25))); }
}

/** Plant times of a foot (frames where contact starts) from the lowest heel/toe. */
function plantsOf(frames, side) {
  const h = frames.map((P) => Math.min(P[J[`${side}-heel`]][1], P[J[`${side}-big-toe-tip`]][1]));
  const lo = Math.min(...h), on = h.map((y) => y < lo + 0.04);
  const out = []; for (let i = 1; i < on.length; i++) if (on[i] && !on[i - 1]) out.push(i);
  return out;
}

/**
 * Dribble arm(s) scripted onto a generated body. plan(t, i, B) → {
 *   ballHand, held, arms: { right: { w (0..1 override), pos (body frame), palm (body frame), curl }, left: … } }
 * The override weight blends the source arm's wrist into the scripted one, so
 * an arm can hand back to the generated motion. Returns { frames, balls }.
 */
function scriptArms(src, fps, plan) {
  const frames = [], balls = [];
  src.forEach((P0, i) => {
    const P = P0.map((p) => p.slice());
    const B = bodyFrame(P0), t = i / fps;
    const q = plan(t, i, B);
    for (const s of ['left', 'right']) {
      const a = q.arms[s];
      if (!a || !(a.w > 0)) continue;
      const tgt = bodyToWorld(B, a.pos);
      const wr = V.add(V.sc(P0[J[`${s}-wrist`]], 1 - a.w), V.sc(tgt, a.w));
      const palm = rotYv(B.yaw, a.palm || [0, -1, 0.2]);
      setArm(P, s, wr, palm, a.curl ?? 0.35, P0);
    }
    frames.push(P);
    const palm = palmOf(P, q.ballHand);
    balls.push(q.held ? { p: V.add(palm, [0, -(D.ballR + 0.03), 0.02]), held: true, hand: q.ballHand } : { p: [palm[0], Math.max(D.ballR, palm[1] - 0.45), palm[2]], held: false, hand: q.ballHand });
  });
  return { frames, balls };
}

/** Body-frame dribble hand for cycle phase c ∈ [0,1): push (in contact) then rise to the catch. */
function dribbleHand(side, c, { ahead = 0.3, lat = 0.3, top = 1.0, bottom = 0.78 } = {}) {
  const sx = side === 'left' ? 1 : -1;
  const held = c < 0.38;
  const y = held ? lerp(top, bottom, smooth(c / 0.38)) : lerp(bottom, top, smooth((c - 0.38) / 0.62));
  return { pos: [sx * lat, y, ahead + (held ? 0.08 * c : 0.03)], palm: [sx * 0.15, -1, 0.25], curl: 0.3, held };
}

/**
 * Kimodo (or any generated) jog/run → run-dribble: one push per stride, synced
 * to the dribble-side foot plants, the ball ahead of the body.
 */
function dribbleOnto(frames, fps, { hand = 'right', ahead = 0.34 } = {}) {
  const plants = plantsOf(frames, hand);
  const phaseAt = (i) => {
    let k = plants.findIndex((p) => p > i);
    if (k <= 0) { const per = plants.length > 1 ? plants[1] - plants[0] : Math.round(fps * 0.7); const p0 = plants.length ? plants[0] : 0; return (((i - p0) / per) % 1 + 1) % 1; }
    return (i - plants[k - 1]) / (plants[k] - plants[k - 1]);
  };
  const off = hand === 'right' ? 'left' : 'right';
  return scriptArms(frames, fps, (t, i, B) => {
    const d = dribbleHand(hand, (phaseAt(i) + 0.9) % 1, { ahead, top: B.pelvisY + 0.1, bottom: B.pelvisY - 0.12 });
    return { ballHand: hand, held: d.held, arms: { [hand]: { w: 1, ...d }, [off]: null } };
  });
}

/**
 * Generated jog + cut → crossover on the move: dribble in `hand`, cross in
 * front at the cut (largest change of travel direction), dribble in the other
 * hand after it; each arm hands back to the generated motion when not handling.
 */
function crossoverOnto(frames, fps, { hand = 'right' } = {}) {
  const other = hand === 'right' ? 'left' : 'right';
  // the cut: where the travel direction turns fastest (hips, smoothed)
  const hip = frames.map((P) => S.mid(P[J['left-hip']], P[J['right-hip']]));
  let cut = Math.floor(frames.length / 2), best = 0;
  for (let i = 6; i < frames.length - 6; i++) {
    const a = V.sub(hip[i], hip[i - 5]), b = V.sub(hip[i + 5], hip[i]);
    const la = Math.hypot(a[0], a[2]), lb = Math.hypot(b[0], b[2]);
    if (la < 0.02 || lb < 0.02) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[2] * b[2]) / (la * lb))));
    if (turn > best) { best = turn; cut = i; }
  }
  const tc = cut / fps, t0 = tc - 0.22, t1 = tc + 0.1;
  return {
    ...scriptArms(frames, fps, (t, i, B) => {
      const dr = (s, tt) => dribbleHand(s, ((tt % 0.5) + 0.5) % 0.5 / 0.5, { top: B.pelvisY + 0.1, bottom: B.pelvisY - 0.14, ahead: 0.3 });
      const guard = (s) => ({ pos: [(s === 'left' ? 1 : -1) * 0.28, B.pelvisY + 0.28, 0.32], palm: [s === 'left' ? -0.7 : 0.7, -0.3, 0.4], curl: 0.5 });
      const sxA = hand === 'left' ? 1 : -1;
      if (t < t0) {
        const d = dr(hand, t - t0 + 0.5 * 10);
        return { ballHand: hand, held: d.held, arms: { [hand]: { w: 1, ...d }, [other]: { w: smooth((t - (t0 - 0.35)) / 0.3), ...guard(other) } } };
      }
      if (t < t1) {
        const q = (t - t0) / (t1 - t0), push = 0.45;
        const armA = q < push ? { pos: [sxA * lerp(0.3, 0.12, q / push), lerp(B.pelvisY + 0.05, B.pelvisY - 0.2, smooth(q / push)), 0.3], palm: [-sxA * 0.6, -1, 0.2], curl: 0.3 } : { ...guard(hand), pos: [sxA * 0.14, B.pelvisY - 0.05, 0.3] };
        const armB = { pos: [-sxA * lerp(0.08, 0.3, smooth((q - push) / (1 - push))), lerp(B.pelvisY - 0.02, B.pelvisY - 0.14, smooth((q - push) / (1 - push))), 0.32], palm: [sxA * 0.2, -1, 0.2], curl: 0.3 };
        const held = q < push;
        return { ballHand: held ? hand : other, held: held || q > 0.98, arms: { [hand]: { w: 1, ...armA }, [other]: { w: 1, ...armB } } };
      }
      const d = dr(other, t - t1);
      return { ballHand: other, held: d.held, arms: { [other]: { w: 1, ...d }, [hand]: { w: 1 - smooth((t - t1) / 0.35), ...guard(hand) } } };
    }),
    cutFrame: cut,
    entryMax: Math.max(0, Math.round((t0 - 0.25) * fps)),
  };
}

module.exports = { runDribble, crossover, synthesizeBall, pose, D, scriptArms, dribbleOnto, crossoverOnto, bodyFrame, plantsOf };
