/**
 * Game-clip builder — a measured motion → a clean, engine-ready animation clip.
 *
 * Monocular capture measures body-relative pose well, but absolute travel
 * badly (camera depth drifts). A game needs the opposite guarantee: feet that
 * never slide and travel that matches the feet. So:
 *
 *   1. world motion (motion-builder, in place OFF, its foot lock OFF)
 *   2. per-foot CONTACTS: lowest heel/toe point near the floor AND the foot
 *      nearly still, with hysteresis + minimum durations (stature-scaled)
 *   3. ROOT = floor point under the hips + body facing (hips + shoulders),
 *      smoothed; joints re-expressed in ROOT SPACE (root at origin, facing +Z)
 *   4. ROOT MOTION by foot-anchored odometry: a planted foot does not move in
 *      the world, so the root moves by exactly minus that foot's motion
 *      relative to the body. In the air: the take-off velocity is kept
 *      (no horizontal forces in flight). Measured travel is only a fallback,
 *      with its camera-depth component damped.
 *   5. PINNING: during each contact the planted point is fixed to one floor
 *      spot (y = 0) with two-bone leg IK (bone lengths kept), eased in/out
 *   6. LOOPS: best cycle by pose + velocity + contact-phase distance; the seam
 *      error is spread across the cycle so it loops invisibly
 *   7. ball in root space, shot release, foot-plant sync markers, speed/
 *      direction stats and a quality report (slide before/after, seam, drift)
 *   8. WARPS (optional): travel the capture cannot measure (a step-back filmed
 *      toward the camera) is set to an intended displacement over a frame
 *      window; the correction goes to airborne/swing frames, never to frames
 *      where a foot is planted
 *   9. QC flags: plain-language warnings about how the take was recorded
 *
 * Replaying root motion + root-space joints puts every planted foot on one
 * spot by construction; the runtime (court3d.html) retargets to any
 * character's bone lengths and IK-locks the same contacts.
 */
'use strict';

const S = require('./skeleton');
const { J } = S;
const { buildMotion, BALL_RADIUS_M } = require('./motion-builder');

const FOOT_PTS = {
  left: ['left-heel', 'left-big-toe-tip', 'left-small-toe-tip'].map((n) => J[n]),
  right: ['right-heel', 'right-big-toe-tip', 'right-small-toe-tip'].map((n) => J[n]),
};
const LEG = {
  left: { hip: J['left-hip'], knee: J['left-knee'], ankle: J['left-ankle'] },
  right: { hip: J['right-hip'], knee: J['right-knee'], ankle: J['right-ankle'] },
};
const BODY_IDX = Array.from({ length: 21 }, (_, i) => i).concat([J['left-wrist'], J['right-wrist'], J.neck]);

const DEFAULTS = {
  hOn: 0.045, hOff: 0.075,   // m — contact starts below hOn, ends above hOff (stature-scaled)
  vOn: 0.45, vOff: 0.85,     // m/s — horizontal foot speed for contact start/end (stature-scaled)
  minContactS: 0.08,         // shorter contacts are noise (≥ 2 frames at 24+ fps)
  gapS: 0.07,                // shorter gaps inside a contact are filled
  yawSigmaS: 0.08,           // facing smoothing (s)
  rootSigmaS: 0.08,          // root position smoothing (s)
  depthTrust: 0.3,           // weight of measured travel along the camera depth axis (fallback only)
  pinEaseS: 0.15,            // ease in/out of foot pinning around each contact (cubic)
  loopMinS: 0.6,             // shortest loop cycle (≈ one stride + one dribble)
};

function gaussianSmooth(series, sigma) {
  if (!(sigma > 0.05)) return series.slice();
  const r = Math.ceil(sigma * 2.5);
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  return series.map((_, i) => {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const v = series[i + k];
      if (v === undefined || !Number.isFinite(v)) continue;
      s += v * w[k + r]; ws += w[k + r];
    }
    return ws ? s / ws : series[i];
  });
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rot = (yaw, v) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; }; // = rotY(yaw)·v

// ── 2. contacts ─────────────────────────────────────────────────────────────
/**
 * @returns {{ left: {on: boolean[], intervals: number[][]}, right: … }}
 */
function detectContacts(frames, fps, statureM, opts = {}, viewDir = null) {
  const o = { ...DEFAULTS, ...opts };
  // Foot speed is judged ACROSS the camera; the camera-depth component (where
  // monocular capture drifts — up to ~1 m/s on side-filmed clips) counts at
  // depthTrust weight only
  const vd = viewDir && Math.hypot(viewDir[0], viewDir[2]) > 0.5 ? [viewDir[0], viewDir[2]] : null;
  const k = (statureM || 1.75) / 1.75;
  const N = frames.length;
  const out = {};
  for (const side of ['left', 'right']) {
    const pts = FOOT_PTS[side];
    const h = frames.map((P) => Math.min(...pts.map((j) => P[j][1])));
    // speed of the point(s) actually on the floor: the heel while the heel is
    // down, the toes at push-off (the foot's centroid moves ~0.8 m/s in a
    // heel-to-toe roll while the heel is planted)
    const hLow = o.hOn * k;
    const ptSpeed = (i, a, b, j) => {
      let dx = frames[b][j][0] - frames[a][j][0], dz = frames[b][j][2] - frames[a][j][2];
      if (vd) {
        const along = dx * vd[0] + dz * vd[1];
        dx -= along * vd[0]; dz -= along * vd[1];
        return ((Math.hypot(dx, dz) + o.depthTrust * Math.abs(along)) * fps) / (b - a);
      }
      return (Math.hypot(dx, dz) * fps) / (b - a);
    };
    let v = frames.map((_, i) => {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      if (b <= a) return 0;
      const low = pts.filter((j) => frames[i][j][1] < h[i] + 0.02 && frames[i][j][1] < Math.max(hLow, h[i] + 0.02));
      const use = low.length ? low : pts;
      return Math.min(...use.map((j) => ptSpeed(i, a, b, j)));
    });
    v = gaussianSmooth(v, 0.7);
    // vertical speed (reliable: floor-snapped heights)
    const vy = h.map((_, i) => { const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1); return b > a ? (Math.abs(h[b] - h[a]) * fps) / (b - a) : 0; });
    // Adaptive speed gate: the apparent speed of feet that are ON the floor is
    // this clip's translation noise (~0 on clean data, 1–2 m/s on noisy
    // monocular clips). The horizontal gate sits above that noise, so a noisy
    // clip falls back to height + vertical speed — the reliable cues.
    const cand = v.filter((_, i) => h[i] < o.hOn * k);
    const noise = cand.length ? S.median(cand) : 0;
    const vOn = Math.max(o.vOn * k, 2.5 * noise), vOff = Math.max(o.vOff * k, 3.5 * noise);
    const on = new Array(N).fill(false);
    let st = false;
    for (let i = 0; i < N; i++) {
      if (!st && h[i] < o.hOn * k && v[i] < vOn && vy[i] < 0.6 * k) st = true;
      else if (st && (h[i] > o.hOff * k || v[i] > vOff)) st = false;
      on[i] = st;
    }
    // fill short gaps, drop short contacts
    const gap = Math.max(1, Math.round(o.gapS * fps)), minLen = Math.max(fps >= 24 ? 2 : 1, Math.round(o.minContactS * fps));
    const runs = (arr, val) => { const r = []; let s0 = -1; for (let i = 0; i <= N; i++) { const x = i < N && arr[i] === val; if (x && s0 < 0) s0 = i; if (!x && s0 >= 0) { r.push([s0, i - 1]); s0 = -1; } } return r; };
    for (const [a, b] of runs(on, false)) if (a > 0 && b < N - 1 && b - a + 1 <= gap) for (let i = a; i <= b; i++) on[i] = true;
    for (const [a, b] of runs(on, true)) if (b - a + 1 < minLen && !(a === 0 && b === N - 1)) for (let i = a; i <= b; i++) on[i] = false;
    out[side] = { on, intervals: runs(on, true), height: h, speed: v, noise: +noise.toFixed(3) };
  }
  return out;
}

// ── 3. root + root space ────────────────────────────────────────────────────
function measureRoot(frames, fps, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rx = frames.map((P) => (P[J['left-hip']][0] + P[J['right-hip']][0]) / 2);
  const rz = frames.map((P) => (P[J['left-hip']][2] + P[J['right-hip']][2]) / 2);
  let yaw = frames.map((P) => {
    const left = S.add(S.sub(P[J['left-hip']], P[J['right-hip']]), S.sub(P[J['left-shoulder']], P[J['right-shoulder']]));
    const f = S.cross(left, [0, 1, 0]);
    return Math.atan2(f[0], f[2]);
  });
  for (let i = 1; i < yaw.length; i++) yaw[i] = yaw[i - 1] + wrapPi(yaw[i] - yaw[i - 1]); // unwrap
  yaw = gaussianSmooth(yaw, o.yawSigmaS * fps);
  return { x: gaussianSmooth(rx, o.rootSigmaS * fps), z: gaussianSmooth(rz, o.rootSigmaS * fps), yaw };
}

const toRootSpace = (P, x, z, yaw) => P.map((p) => rot(-yaw, [p[0] - x, p[1], p[2] - z]));
const fromRootSpace = (P, x, z, yaw) => P.map((p) => { const q = rot(yaw, p); return [q[0] + x, q[1], q[2] + z]; });

/** Foot points on the floor in this frame (the lowest one if none is under thr). */
function groundedPts(P, side, thr) {
  const g = FOOT_PTS[side].filter((j) => P[j][1] < thr);
  if (g.length) return g;
  let b = FOOT_PTS[side][0];
  for (const j of FOOT_PTS[side]) if (P[j][1] < P[b][1]) b = j;
  return [b];
}

// ── 4. foot-anchored odometry ───────────────────────────────────────────────
/**
 * Root path from the planted feet. For a foot planted in frames i and i+1 the
 * same floor point (the one of heel/toes that is lowest across both frames)
 * must not move in the world:  W(i) + R(yaw_i)·a_i = W(i+1) + R(yaw_i+1)·a_i+1
 */
function odometry(rs, contacts, meas, fps, viewDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const N = rs.length;
  const W = [[meas.x[0], meas.z[0]]];
  let lastVel = null, grounded = 0, fallback = 0;
  const vd = viewDir && Math.hypot(viewDir[0], viewDir[2]) > 0.5 ? [viewDir[0], viewDir[2]] : null;
  for (let i = 0; i < N - 1; i++) {
    const est = [];
    for (const side of ['left', 'right']) {
      if (!(contacts[side].on[i] && contacts[side].on[i + 1])) continue;
      // every foot point on the floor in BOTH frames (heel strike: heel, flat:
      // all, push-off: toes) — the same physical points in both frames
      const thr = o.hOff * ((o.statureM || 1.75) / 1.75);
      let pts = FOOT_PTS[side].filter((j) => rs[i][j][1] < thr && rs[i + 1][j][1] < thr);
      if (!pts.length) { let b = FOOT_PTS[side][0]; for (const j of FOOT_PTS[side]) if (Math.max(rs[i][j][1], rs[i + 1][j][1]) < Math.max(rs[i][b][1], rs[i + 1][b][1])) b = j; pts = [b]; }
      for (const j of pts) {
        const a = rot(meas.yaw[i], rs[i][j]), b = rot(meas.yaw[i + 1], rs[i + 1][j]);
        est.push([a[0] - b[0], a[2] - b[2]]);
      }
    }
    let d;
    if (est.length) {
      d = [est.reduce((s, e) => s + e[0], 0) / est.length, est.reduce((s, e) => s + e[1], 0) / est.length];
      lastVel = lastVel ? [lastVel[0] * 0.4 + d[0] * 0.6, lastVel[1] * 0.4 + d[1] * 0.6] : d;
      grounded++;
    } else if (lastVel) {
      d = lastVel; // airborne: horizontal velocity is conserved
    } else {
      // no contact yet: measured travel, camera-depth component damped
      d = [meas.x[i + 1] - meas.x[i], meas.z[i + 1] - meas.z[i]];
      if (vd) { const along = d[0] * vd[0] + d[1] * vd[1]; d = [d[0] - (1 - o.depthTrust) * along * vd[0], d[1] - (1 - o.depthTrust) * along * vd[1]]; }
      fallback++;
    }
    W.push([W[i][0] + d[0], W[i][1] + d[1]]);
  }
  return { W, groundedSteps: grounded, fallbackSteps: fallback };
}

// ── 5. pinning (two-bone IK) ────────────────────────────────────────────────
/** Knee for a new ankle target keeping thigh/shin lengths, bending like the original knee. */
function solveKnee(hip, knee, ankle, target, L1 = S.dist(hip, knee), L2 = S.dist(knee, ankle)) {
  let d = S.sub(target, hip);
  let L = S.len(d);
  const reach = L1 + L2 - 1e-4;
  let t = target;
  if (L > reach) { t = S.add(hip, S.scale(d, reach / L)); d = S.sub(t, hip); L = reach; }
  if (L < Math.abs(L1 - L2) + 1e-4) return { knee, ankle: t, clamped: true };
  const u = S.norm(d);
  const a = (L1 * L1 - L2 * L2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  let pole = S.sub(S.sub(knee, hip), S.scale(u, S.dot(S.sub(knee, hip), u)));
  if (S.len(pole) < 1e-6) pole = [0, 0, 1];
  return { knee: S.add(S.add(hip, S.scale(u, a)), S.scale(S.norm(pole), h)), ankle: t, clamped: t !== target };
}

/**
 * Pin every contact in WORLD frames (on a copy). A pin eases in/out with a
 * cubic over pinEaseS (never more than half the gap to the next contact).
 * Where a pinned foot is out of the leg's reach, the body is lowered first
 * (smoothed), so legs never over-straighten or pop. Returns { frames, clampedFrames, pelvisDropCm }.
 */
function pinFeet(world, contacts, fps, opts = {}) {
  const o0 = { ...DEFAULTS, ...opts };
  const legLen = {};
  for (const sd of ['left', 'right']) legLen[sd] = [S.median(world.map((P) => S.dist(P[LEG[sd].hip], P[LEG[sd].knee]))), S.median(world.map((P) => S.dist(P[LEG[sd].knee], P[LEG[sd].ankle])))];
  const o = { ...o0, legLen };
  const first = pinPass(world, contacts, fps, o);
  if (!first.deficit.some((d) => d > 0.002)) return { frames: first.frames, clampedFrames: first.clamped, pelvisDropCm: 0 };
  // lower everything above the feet by the (smoothed) reach deficit, then re-pin
  const drop = gaussianSmooth(first.deficit, Math.max(1, 0.1 * fps)).map((d, i) => Math.max(d, first.deficit[i] > 0 ? first.deficit[i] + 0.002 : 0));
  const FEET = new Set(['left', 'right'].flatMap((sd) => [LEG[sd].ankle, ...FOOT_PTS[sd]]));
  const lowered = world.map((P, i) => P.map((p, j) => (FEET.has(j) ? p.slice() : [p[0], p[1] - drop[i], p[2]])));
  const second = pinPass(lowered, contacts, fps, o);
  return { frames: second.frames, clampedFrames: second.clamped, pelvisDropCm: +(Math.max(...drop) * 100).toFixed(1) };
}

function pinPass(world, contacts, fps, o) {
  const N = world.length, easeMax = Math.max(1, Math.round(o.pinEaseS * fps));
  const out = world.map((P) => P.map((p) => p.slice()));
  const deficit = new Array(N).fill(0);
  let clamped = 0;
  const cubic = (x) => x * x * (3 - 2 * x);
  for (const side of ['left', 'right']) {
    const { hip, knee, ankle } = LEG[side];
    const footJ = [ankle, ...FOOT_PTS[side]];
    const thr = o.hOff * ((o.statureM || 1.75) / 1.75);
    const iv = contacts[side].intervals;
    // the leg is rigid: one thigh and one shin length for the whole clip
    const L1 = o.legLen?.[side]?.[0] ?? S.median(world.map((P) => S.dist(P[hip], P[knee])));
    const L2 = o.legLen?.[side]?.[1] ?? S.median(world.map((P) => S.dist(P[knee], P[ankle])));
    for (let c = 0; c < iv.length; c++) {
      const [s0, e0] = iv[c];
      const gapBefore = c > 0 ? s0 - iv[c - 1][1] - 1 : Infinity, gapAfter = c + 1 < iv.length ? iv[c + 1][0] - e0 - 1 : Infinity;
      const easeIn = Math.max(1, Math.min(easeMax, Math.floor(gapBefore / 2))), easeOut = Math.max(1, Math.min(easeMax, Math.floor(gapAfter / 2)));
      // each foot point's own floor spot: its average position while grounded
      const tgt = {};
      for (const j of FOOT_PTS[side]) {
        let x = 0, z = 0, n = 0;
        for (let i = s0; i <= e0; i++) if (groundedPts(world[i], side, thr).includes(j)) { x += world[i][j][0]; z += world[i][j][2]; n++; }
        if (n) tgt[j] = [x / n, z / n];
      }
      let lastOff = [0, 0];
      for (let i = Math.max(0, s0 - easeIn); i <= Math.min(N - 1, e0 + easeOut); i++) {
        const w = i < s0 ? cubic(1 - (s0 - i) / (easeIn + 1)) : i > e0 ? cubic(1 - (i - e0) / (easeOut + 1)) : 1;
        const P = out[i];
        const src = world[Math.max(s0, Math.min(e0, i))];
        const g = groundedPts(src, side, thr).filter((j) => tgt[j]);
        let ox = lastOff[0], oz = lastOff[1];
        if (g.length && i >= s0 && i <= e0) {
          ox = g.reduce((a, j) => a + tgt[j][0] - P[j][0], 0) / g.length;
          oz = g.reduce((a, j) => a + tgt[j][1] - P[j][2], 0) / g.length;
          lastOff = [ox, oz];
        } else if (i < s0) {
          const g0 = groundedPts(world[s0], side, thr).filter((j) => tgt[j]);
          if (g0.length) { ox = g0.reduce((a, j) => a + tgt[j][0] - world[s0][j][0], 0) / g0.length; oz = g0.reduce((a, j) => a + tgt[j][1] - world[s0][j][2], 0) / g0.length; }
        }
        const low = Math.min(...FOOT_PTS[side].map((q) => P[q][1]));
        const off = [ox * w, i >= s0 && i <= e0 ? -low : -Math.min(0, low) * w, oz * w];
        const target = S.add(P[ankle], off);
        const r = solveKnee(P[hip], P[knee], P[ankle], target, L1, L2);
        const moved = S.sub(r.ankle, P[ankle]);
        if (r.clamped) {
          clamped++;
          // how far the hip must come down (straight) to reach the target
          const L = L1 + L2 - 1e-3;
          const dx = target[0] - P[hip][0], dz = target[2] - P[hip][2], hz = Math.hypot(dx, dz);
          if (hz < L) deficit[i] = Math.max(deficit[i], (P[hip][1] - target[1]) - Math.sqrt(L * L - hz * hz));
        }
        P[knee] = r.knee;
        for (const q of footJ) P[q] = S.add(P[q], moved);
      }
    }
  }
  return { frames: out, clamped, deficit };
}

/** Worst world drift (m) of the planted point across each contact. */
/**
 * Foot slide while planted: for every foot point, over the frames of a contact
 * where that point is on the floor, its largest distance from its own mean
 * spot. worst = over all contacts, mean = average per contact.
 */
function slideMetric(world, contacts, thr = 0.075) {
  let worst = 0, sum = 0, n = 0;
  for (const side of ['left', 'right']) {
    for (const [s0, e0] of contacts[side].intervals) {
      if (e0 <= s0) continue;
      let d = 0;
      for (const j of FOOT_PTS[side]) {
        const pts = [];
        for (let i = s0; i <= e0; i++) if (groundedPts(world[i], side, thr).includes(j)) pts.push(world[i][j]);
        if (pts.length < 2) continue;
        const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[2], 0) / pts.length];
        d = Math.max(d, ...pts.map((p) => Math.hypot(p[0] - c[0], p[2] - c[1])));
      }
      worst = Math.max(worst, d); sum += d; n++;
    }
  }
  return { worstCm: +(worst * 100).toFixed(1), meanCm: n ? +((sum / n) * 100).toFixed(1) : 0 };
}

// ── 6. loops ────────────────────────────────────────────────────────────────
/**
 * Best loop window [a, b): playing … b−2, b−1, a, a+1 … must look like any
 * other stretch of the clip. Scored by the joint accelerations across the
 * seam (second differences — pose AND velocity continuity in one number),
 * foot-contact agreement and the ball's held/free phase. b may be N (the
 * whole tail): the frame after b−1 is then extrapolated, so a clip that is
 * exactly one cycle (e.g. one dribble) loops as a whole.
 */
function findLoop(rs, contacts, fps, opts = {}, balls = null) {
  const o = { ...DEFAULTS, ...opts };
  const N = rs.length, minLen = Math.max(4, Math.round(o.loopMinS * fps));
  if (N < minLen + 1) return null;
  const at = (i) => (i < N ? rs[i] : rs[N - 1].map((p, k) => S.sub(S.scale(p, 2), rs[N - 2][k])));
  const acc = (P0, P1, P2) => {
    let s = 0;
    for (const k of BODY_IDX) s += S.len(S.add(S.sub(P0[k], S.scale(P1[k], 2)), P2[k]));
    return s / BODY_IDX.length;
  };
  // typical in-clip acceleration (what a seam may cost for free)
  let base = 0;
  for (let i = 1; i < N - 1; i++) base += acc(rs[i - 1], rs[i], rs[i + 1]);
  base /= Math.max(1, N - 2);
  const heldAt = (i) => (balls ? !!(balls[Math.min(i, N - 1)] && balls[Math.min(i, N - 1)].held) : null);
  // a dribble loop must hold a whole ball cycle: in the hand AND away from it
  const dribble = balls && balls.some((x) => x && x.held) && balls.some((x) => x && !x.held);
  let best = null;
  for (let a = 0; a <= Math.min(N - minLen, Math.floor(N * 0.5)); a++) {
    for (let b = a + minLen; b <= N; b++) {
      if (dribble) {
        let h = false, f = false;
        for (let i = a; i < b; i++) { if (!balls[i]) continue; if (balls[i].held) h = true; else f = true; }
        if (!h || !f) continue;
      }
      const e1 = acc(rs[b - 2] || rs[b - 1], rs[b - 1], rs[a]);   // …b−2, b−1 → a
      const e2 = acc(rs[b - 1], rs[a], rs[a + 1]);                 // b−1 → a, a+1…
      let cost = Math.max(0, (e1 + e2) / 2 - base);
      if (b < N) cost += ['left', 'right'].filter((sd) => contacts[sd].on[a] !== contacts[sd].on[b]).length * 0.02;
      // the ball must be in the same phase: the seam may not jump a held ball out of the hand
      if (balls && b < N && heldAt(a) !== heldAt(b)) cost += 0.03;
      cost -= 0.004 * ((b - a) / fps); // prefer longer cycles when equal
      let dp = 0; const T = at(b);
      for (const k of BODY_IDX) dp += S.dist(rs[a][k], T[k]);
      if (!best || cost < best.cost) best = { a, b, cost, poseCm: (dp / BODY_IDX.length) * 100, seamTarget: T };
    }
  }
  return best;
}

// ── build ───────────────────────────────────────────────────────────────────
/**
 * @param {object} raw raw.json (or { worldFrames, fps, statureM, viewDir } for tests)
 * @param {object} o { type: 'loop'|'action', role, name, settings (motion-builder), ...DEFAULTS overrides }
 */
function buildGameClip(raw, o = {}) {
  let world, fps, statureM, viewDir, balls, shot = null, report = {};
  if (raw.worldFrames) {
    world = raw.worldFrames; fps = raw.fps; statureM = raw.statureM || 1.75; viewDir = raw.viewDir || null; balls = raw.balls || world.map(() => null);
  } else {
    const m = buildMotion(raw, { ...(o.settings || {}), inPlace: false, footLock: false });
    world = m.frames.map((f) => f.joints); fps = m.fps; statureM = m.statureM; viewDir = m.report.viewDir || null;
    balls = m.frames.map((f) => f.ball); shot = m.report.shotRelease || null; report = m.report;
  }
  const N = world.length;
  const contacts = detectContacts(world, fps, statureM, o, viewDir);
  const meas = measureRoot(world, fps, o);
  let rs = world.map((P, i) => toRootSpace(P, meas.x[i], meas.z[i], meas.yaw[i]));
  const oo = { ...o, statureM };
  const odo = odometry(rs, contacts, meas, fps, viewDir, oo);
  // world as a game would replay it: odometry root + root-space pose
  const replay = rs.map((P, i) => fromRootSpace(P, odo.W[i][0], odo.W[i][1], meas.yaw[i]));
  const thrS = DEFAULTS.hOff * (statureM / 1.75);
  const slideMeasured = slideMetric(world, contacts, thrS), slideOdo = slideMetric(replay, contacts, thrS);
  const pinned = pinFeet(replay, contacts, fps, oo);
  const slidePinned = slideMetric(pinned.frames, contacts, thrS);
  rs = pinned.frames.map((P, i) => toRootSpace(P, odo.W[i][0], odo.W[i][1], meas.yaw[i]));

  // root motion deltas in each frame's root space (delta to the next frame)
  const delta = (i, j) => {
    const d = rot(-meas.yaw[i], [odo.W[j][0] - odo.W[i][0], 0, odo.W[j][1] - odo.W[i][1]]);
    return [d[0], d[2], wrapPi(meas.yaw[j] - meas.yaw[i])];
  };
  let a = 0, b = N; // frames [a, b)
  let loop = null;
  const type = o.type === 'loop' ? 'loop' : 'action';
  if (type === 'loop') {
    loop = findLoop(rs, contacts, fps, o, balls);
    if (loop) { a = loop.a; b = loop.b; }
  }
  const F = b - a;
  const joints = [], rootMotion = [];
  for (let i = a; i < b; i++) {
    let P = rs[i];
    if (loop) { // spread the seam: (the frame after b−1) maps onto frame a
      const t = (i - a) / F;
      P = P.map((p, k) => S.add(p, S.scale(S.sub(rs[a][k], loop.seamTarget[k]), t)));
    }
    joints.push(P);
    rootMotion.push(i + 1 < N ? delta(i, i + 1) : loop && N > 1 ? delta(N - 2, N - 1) : [0, 0, 0]);
  }
  // ── warps: intended travel over a window (root frame of its first frame)
  const warpReport = [];
  for (const w of o.warp || []) {
    const f0 = Math.max(0, Math.min(F - 1, w.from | 0)), f1 = Math.max(f0 + 1, Math.min(F, w.to | 0));
    // actual travel over [f0, f1) expressed in f0's root frame
    let yaw = 0, ax = 0, az = 0; const yawAt = [];
    for (let i = f0; i < f1; i++) {
      yawAt.push(yaw);
      const d = rot(yaw, [rootMotion[i][0], 0, rootMotion[i][1]]);
      ax += d[0]; az += d[2]; yaw += rootMotion[i][2];
    }
    const cx = (+w.dx || 0) - ax, cz = (+w.dz || 0) - az;
    // weights: frames with no planted foot take the correction
    const wt = []; let ws = 0;
    for (let i = f0; i < f1; i++) {
      const planted = ['left', 'right'].filter((sd) => contacts[sd].on[a + i]).length;
      const q = planted === 0 ? 1 : planted === 1 ? 0.25 : 0.03;
      wt.push(q); ws += q;
    }
    for (let i = f0; i < f1; i++) {
      const k = wt[i - f0] / ws;
      const d = rot(-yawAt[i - f0], [cx * k, 0, cz * k]);
      rootMotion[i] = [rootMotion[i][0] + d[0], rootMotion[i][1] + d[2], rootMotion[i][2]];
    }
    warpReport.push({ from: f0, to: f1, measured: [+ax.toFixed(3), +az.toFixed(3)], target: [+(+w.dx || 0).toFixed(3), +(+w.dz || 0).toFixed(3)], correctionCm: Math.round(Math.hypot(cx, cz) * 100) });
  }
  const cOut = {};
  for (const side of ['left', 'right']) {
    const on = contacts[side].on.slice(a, b);
    // smooth 0..1 weights for runtime IK blending
    const wgt = on.map((x, i) => (x ? 1 : 0));
    cOut[side] = { on: on.map((x) => (x ? 1 : 0)), weight: gaussianSmooth(wgt, 0.8).map((x) => +x.toFixed(3)) };
  }
  const markers = {};
  for (const side of ['left', 'right']) {
    markers[`${side}Plant`] = cOut[side].on.map((x, i) => (x && !cOut[side].on[(i - 1 + F) % F] ? i : -1)).filter((i) => i >= 0 && (loop || i > 0 || cOut[side].on[0]));
  }
  const ballOut = [];
  for (let i = a; i < b; i++) {
    const bl = balls[i];
    if (!bl) { ballOut.push(null); continue; }
    const p = bl.p || bl;
    // the ball was measured with the (unpinned) joints: same root as `world`
    const q = rot(-meas.yaw[i], [p[0] - meas.x[i], p[1], p[2] - meas.z[i]]);
    const P = joints[i - a];
    const palm = (s) => S.mid(P[J[`${s}-wrist`]], P[J[`${s}-middle-first-joint`]]);
    const hand = bl.hand || (S.dist(q, palm('left')) <= S.dist(q, palm('right')) ? 'left' : 'right');
    const out = { p: q.map((x) => +x.toFixed(4)), held: !!bl.held, hand };
    // held: offset from the palm, so the ball stays in the (retargeted, IK'd) hand
    if (bl.held) out.off = S.sub(q, palm(hand)).map((x) => +x.toFixed(4));
    ballOut.push(out);
  }
  // travel stats in the root frame
  const tot = rootMotion.reduce((s, d) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]], [0, 0, 0]);
  const dur = F / fps;
  // bone lengths (median over the clip) for retargeting
  const boneLen = new Array(70).fill(0);
  for (let k = 0; k < 70; k++) {
    const p = S.PARENT[k];
    boneLen[k] = +S.median(joints.map((P) => S.dist(P[k], p === S.PELVIS ? S.mid(P[J['left-hip']], P[J['right-hip']]) : P[p]))).toFixed(4);
  }
  const f32 = (rows) => { const a2 = new Float32Array(rows.length * rows[0].length * (rows[0][0].length || 1)); let q = 0; for (const r of rows) for (const v of r) { if (Array.isArray(v)) for (const c of v) a2[q++] = c; else a2[q++] = v; } return Buffer.from(a2.buffer).toString('base64'); };
  const hipHeight = S.median(joints.map((P) => (P[J['left-hip']][1] + P[J['right-hip']][1]) / 2));
  const depthDrift = viewDir ? (() => {
    const mx = meas.x[N - 1] - meas.x[0], mz = meas.z[N - 1] - meas.z[0];
    const ox = odo.W[N - 1][0] - odo.W[0][0], oz = odo.W[N - 1][1] - odo.W[0][1];
    return +(((mx - ox) * viewDir[0] + (mz - oz) * viewDir[2])).toFixed(3);
  })() : null;
  const speed = Math.hypot(tot[0], tot[1]) / dur;
  const shotOut = shot && shot.releaseFrame >= a && shot.releaseFrame < b ? {
    releaseFrame: shot.releaseFrame - a, lastHeldFrame: shot.lastHeldFrame - a, hand: shot.hand,
    stepFrame: shot.stepFrame != null && shot.stepFrame >= a ? shot.stepFrame - a : null,
    point: ballOut[shot.lastHeldFrame - a]?.p || null, // root space, like every clip position
  } : null;
  // entry window for actions: the runtime may start the clip anywhere in it
  // (best pose match) so a move answers the button at once
  const entry = type === 'action' ? { min: 0, max: Math.max(0, Math.min(F - 1, o.entryMax != null ? o.entryMax | 0 : shotOut?.stepFrame != null ? shotOut.stepFrame - Math.round(0.25 * fps) : 0)) } : null;
  const contactsN = { left: contacts.left.intervals.length, right: contacts.right.intervals.length };
  const quality = {
    contacts: contactsN,
    translationNoiseMps: Math.max(contacts.left.noise, contacts.right.noise),
    slideMeasuredCm: slideMeasured.worstCm, slideRootMotionCm: slideOdo.worstCm, slidePinnedCm: slidePinned.worstCm,
    ikClampedFrames: pinned.clampedFrames,
    pelvisDropCm: pinned.pelvisDropCm,
    rootFromFeet: +(odo.groundedSteps / Math.max(1, N - 1)).toFixed(2),
    depthDriftRemovedM: depthDrift,
    loopSeamCm: loop ? +loop.poseCm.toFixed(1) : null,
    warps: warpReport,
  };
  quality.flags = qcFlags({ quality, fps, type, role: o.role, frames: F, contacts, a, b, loop });
  return {
    version: 2,
    name: o.name || 'clip', role: o.role || null, type, fps, frameCount: F, statureM: +statureM.toFixed(3),
    joints: f32(joints),                         // F × 70 × 3, root space (m)
    rootMotion: f32(rootMotion.map((d) => [d])), // F × 3: dx, dz (m, root frame of frame i), dyaw (rad) to the next frame
    contacts: cOut, markers,
    ball: ballOut,
    shot: shotOut,
    entry,
    loop: loop ? { from: a, to: b, poseErrCm: +loop.poseCm.toFixed(1) } : null,
    stats: {
      speed: +speed.toFixed(3),
      speedHipsPerS: +(speed / (hipHeight || 0.9)).toFixed(3), // scales to any character's legs
      hipHeight: +hipHeight.toFixed(3),
      dirDeg: Math.hypot(tot[0], tot[1]) > 0.05 ? Math.round((Math.atan2(tot[0], tot[1]) * 180) / Math.PI) : 0,
      turnDegPerS: Math.round(((tot[2] * 180) / Math.PI) / dur),
      durationS: +dur.toFixed(3),
    },
    boneLen, parent: S.PARENT,
    quality,
    source: { report, trimStart: o.settings?.trimStart || 0, trimEnd: o.settings?.trimEnd || 0 },
  };
}

/**
 * Plain-language warnings about the take — each names what to change when
 * recording it again (see docs/RECORDING.md).
 */
function qcFlags({ quality: q, fps, type, role, frames, contacts, a, b, loop }) {
  const out = [];
  const add = (code, level, msg) => out.push({ code, level, msg });
  const moving = type === 'action' || /^loco|^start|^stop|^move|^shot|^layup/.test(role || '');
  if (moving && fps < 20) add('low-fps', 'warn', `Analysed at ${fps} fps — use 30 fps for moves and locomotion (a jog step touches the floor ~0.25 s).`);
  if (Math.abs(q.depthDriftRemovedM || 0) > 0.3) add('depth-travel', 'warn', `${Math.abs(q.depthDriftRemovedM).toFixed(1)} m of travel toward/away from the camera was not trusted — film travel ACROSS the frame (camera side-on to the path).`);
  if (q.translationNoiseMps > 0.5) add('noisy-feet', 'warn', `Planted feet jitter ~${q.translationNoiseMps.toFixed(1)} m/s in the capture — film closer (performer ≥ half the frame height), 1080p+, tripod, shutter ≥ 1/500.`);
  if (!q.contacts.left && !q.contacts.right) add('no-contacts', moving ? 'bad' : 'warn', 'No foot plants found — feet must be in frame with heels and toes visible for the whole take.');
  if (q.slidePinnedCm > 4) add('slide', 'warn', `Planted feet still move ${q.slidePinnedCm} cm after cleanup.`);
  if (q.ikClampedFrames > frames * 0.15) add('ik-clamped', 'warn', `${q.ikClampedFrames} frames needed a straight leg to reach the floor — check the analysed height (stature).`);
  if (loop && q.loopSeamCm > 6) add('loop-seam', 'warn', `Loop seam ${q.loopSeamCm} cm — record 20–30 s to a metronome so a clean whole cycle exists.`);
  if (type === 'loop' && !loop) add('no-loop', 'bad', 'No loopable cycle found in the analysed window — analyse a longer window with at least one whole cycle.');
  if (type === 'action') {
    const k = Math.max(1, Math.round(0.2 * fps));
    const both = (i) => contacts.left.on[i] && contacts.right.on[i];
    let s0 = 0; for (let i = a; i < Math.min(b, a + k); i++) if (both(i)) s0++;
    if (s0 < k * 0.6) add('no-start-hold', 'warn', 'The move does not start from a planted stance — hold the idle stance ≥ 1 s before the move.');
  }
  return out;
}

/** Decode helpers (tests / server-side previews). */
function decodeClip(clip) {
  const f = (b64, stride) => { const a = new Float32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer); const rows = []; for (let i = 0; i < a.length; i += stride) rows.push(Array.from(a.subarray(i, i + stride))); return rows; };
  const flat = f(clip.joints, 210);
  return { joints: flat.map((r) => Array.from({ length: 70 }, (_, k) => [r[k * 3], r[k * 3 + 1], r[k * 3 + 2]])), rootMotion: f(clip.rootMotion, 3) };
}

/** Replay a clip in the world (root motion + root-space joints) — what the runtime does. */
function replayClip(clip, { cycles = 1 } = {}) {
  const { joints, rootMotion } = decodeClip(clip);
  let x = 0, z = 0, yaw = 0;
  const out = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < joints.length; i++) {
      out.push(fromRootSpace(joints[i], x, z, yaw));
      const d = rot(yaw, [rootMotion[i][0], 0, rootMotion[i][1]]);
      x += d[0]; z += d[2]; yaw += rootMotion[i][2];
    }
  }
  return out;
}

module.exports = { buildGameClip, qcFlags, detectContacts, measureRoot, odometry, pinFeet, solveKnee, slideMetric, findLoop, decodeClip, replayClip, toRootSpace, fromRootSpace, DEFAULTS, FOOT_PTS };
