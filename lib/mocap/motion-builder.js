/**
 * Motion builder — raw per-frame SAM 3D Body results → clean motion.json.
 *
 * World space of the output: metres, +Y up, ground at y = 0, subject facing
 * +Z (toward the viewer) at the start of the clip, pelvis at x = z = 0.
 *
 * Steps (every one is deterministic and re-runnable from raw.json):
 *   1. detect the keypoint/camera convention by re-projection error
 *   2. camera space → y-up world; lift the ball to 3D from its known size
 *   3. fill missing frames, repair left/right label swaps, reject outliers
 *   4. temporal smoothing (the per-frame estimator jitters)
 *   5. level the ground (camera pitch/roll) and face the subject forward
 *   6. ground + foot lock (no floating, no sinking, no skating)
 *   7. stature estimate, root trajectory, in-place option, starting hand
 */
'use strict';

const S = require('./skeleton');
const MR = require('./mhr-rots');
const { J } = S;
const S_NJ = S.MHR70.length;

const BALL_RADIUS_M = 0.12; // size 7 basketball ≈ 24 cm diameter
const BODY_IDX = Array.from({ length: 21 }, (_, i) => i).concat([J['left-wrist'], J['right-wrist'], J.neck]);
const FOOT = {
  left: [J['left-ankle'], J['left-heel'], J['left-big-toe-tip'], J['left-small-toe-tip']],
  right: [J['right-ankle'], J['right-heel'], J['right-big-toe-tip'], J['right-small-toe-tip']],
};
const FOOT_LOW = {
  left: [J['left-heel'], J['left-big-toe-tip'], J['left-small-toe-tip']],
  right: [J['right-heel'], J['right-big-toe-tip'], J['right-small-toe-tip']],
};

const DEFAULTS = { smoothing: 1.2, footLock: true, inPlace: true, trimStart: 0, trimEnd: 0 };

// ── 1. convention detection ─────────────────────────────────────────────────
const flipYZ = (p) => [p[0], -p[1], -p[2]];
const CONVENTIONS = {
  'kp+t': (kp, t) => S.add(kp, t),
  'kp': (kp) => kp,
  'flip(kp)+t': (kp, t) => S.add(flipYZ(kp), t),
  'flip(kp+t)': (kp, t) => flipYZ(S.add(kp, t)),
};

function reprojError(fr, conv) {
  const cx = fr.imgW / 2, cy = fr.imgH / 2, f = fr.focal;
  const errs = [];
  for (const i of BODY_IDX) {
    const c = CONVENTIONS[conv](fr.kp3d[i], fr.camT || [0, 0, 0]);
    if (!(c[2] > 0.05)) { errs.push(1e6); continue; }
    const u = (f * c[0]) / c[2] + cx, v = (f * c[1]) / c[2] + cy;
    errs.push(Math.hypot(u - fr.kp2d[i][0], v - fr.kp2d[i][1]));
  }
  return S.median(errs);
}

function detectConvention(frames) {
  const valid = frames.filter((f) => f && f.kp3d && f.kp2d && f.focal).slice(0, 12);
  if (!valid.length) return { conv: 'kp+t', err: NaN };
  let best = null;
  for (const conv of Object.keys(CONVENTIONS)) {
    const err = S.median(valid.map((f) => reprojError(f, conv)));
    if (!best || err < best.err) best = { conv, err };
  }
  return best;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const toWorld = (c) => [c[0], -c[1], -c[2]]; // camera (x right, y down, z fwd) → y-up, +Z toward viewer
const pelvisOf = (P) => S.mid(P[J['left-hip']], P[J['right-hip']]);
const mapPts = (P, fn) => P.map((p) => (p ? fn(p) : p));

function gaussianSmooth(series, sigma) {
  // series: array of numbers (NaN allowed = skip). Centered, edge-normalised.
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

function lerpPose(A, B, t) {
  return A.map((a, i) => [a[0] + (B[i][0] - a[0]) * t, a[1] + (B[i][1] - a[1]) * t, a[2] + (B[i][2] - a[2]) * t]);
}

// ── bad-frame rejection ─────────────────────────────────────────────────────
const EDGE_PTS = ['nose', 'left-ankle', 'right-ankle', 'left-heel', 'right-heel', 'left-big-toe-tip', 'right-big-toe-tip'].map((n) => J[n]);
/**
 * A frame is rejected when (a) the person is cut off by the image edge — a
 * head or foot keypoint lies outside the picture while the person box touches
 * the border (SAM then guesses the missing part and the whole body jumps),
 * (b) its camera depth spikes > 0.5 m away from its neighbours, or (c) its 2D
 * pelvis spikes away from the line through its neighbours. At most a third of
 * the frames are ever dropped (a clip that is all edge-to-edge keeps them).
 * @returns {{ i: number, why: string }[]}
 */
function badFrames(src) {
  const out = [], feetCut = [];
  const measured = (fr) => fr && fr.kp2d && fr.kp3d && !fr.error;
  // a measurement with no camera translation or null joints is re-made too
  // (it would otherwise sit at the camera, or crash later steps)
  const fin3 = (p) => Array.isArray(p) && p.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
  const whole = (fr) => fin3(fr.camT) && fr.kp3d.length >= S_NJ && fr.kp3d.every(fin3) && fr.kp2d.length >= S_NJ && fr.kp2d.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const ok = (fr) => measured(fr) && whole(fr);
  const pel2 = (fr) => [(fr.kp2d[J['left-hip']][0] + fr.kp2d[J['right-hip']][0]) / 2, (fr.kp2d[J['left-hip']][1] + fr.kp2d[J['right-hip']][1]) / 2];
  const steps = [];
  for (let i = 1; i < src.length; i++) if (ok(src[i]) && ok(src[i - 1])) { const a = pel2(src[i]), b = pel2(src[i - 1]); steps.push(Math.hypot(a[0] - b[0], a[1] - b[1])); }
  steps.sort((a, b) => a - b);
  const medStep = steps.length ? steps[steps.length >> 1] : 0;
  for (let i = 0; i < src.length; i++) {
    const fr = src[i];
    if (!measured(fr)) continue;
    if (!whole(fr)) { out.push({ i, why: 'incomplete measurement' }); continue; }
    const H = fr.imgH || 0, W = fr.imgW || 0;
    const box = fr.bbox || fr.personBBox;
    if (H && box) {
      const touches = box[1] <= 1 || box[3] >= H - 1 || box[0] <= 1 || box[2] >= W - 1;
      const off = (k) => { const q = fr.kp2d[k]; return q && (q[1] < -2 || q[1] > H + 2 || q[0] < -2 || q[0] > W + 2); };
      // the head out of the picture makes SAM guess the whole body (fake hops):
      // drop it. Feet past the bottom edge don't — the frame keeps its hands and
      // upper body (the clip builder is told which frames had their feet cut)
      if (touches && off(J.nose)) { out.push({ i, why: 'cut off by the frame edge' }); continue; }
      if (touches && EDGE_PTS.some(off)) feetCut.push(i);
    }
    const nb = [i - 2, i - 1, i + 1, i + 2].filter((k) => k >= 0 && k < src.length && ok(src[k]) && src[k].camT);
    if (fr.camT && nb.length >= 2) {
      const zs = nb.map((k) => src[k].camT[2]).sort((a, b) => a - b);
      const med = zs.length % 2 ? zs[zs.length >> 1] : (zs[zs.length / 2 - 1] + zs[zs.length / 2]) / 2;
      if (Math.abs(fr.camT[2] - med) > 0.5 && Math.abs(zs[zs.length - 1] - zs[0]) < 0.5) { out.push({ i, why: 'depth spike' }); continue; }
    }
    if (i > 0 && i < src.length - 1 && ok(src[i - 1]) && ok(src[i + 1]) && medStep > 0 && box) {
      const a = pel2(src[i - 1]), b = pel2(src[i + 1]), c = pel2(fr);
      const dev = Math.hypot(c[0] - (a[0] + b[0]) / 2, c[1] - (a[1] + b[1]) / 2);
      const hBox = box[3] - box[1];
      if (dev > Math.max(3 * medStep, 0.15 * hBox) && Math.hypot(a[0] - b[0], a[1] - b[1]) < dev) out.push({ i, why: '2D jump' });
    }
  }
  const res = out.length > src.length / 3 ? [] : out;
  res.feetCut = feetCut;
  return res;
}

// ── main ────────────────────────────────────────────────────────────────────
/**
 * @param {object} raw  { fps, frames: [{ kp2d, kp3d, camT, focal, imgW, imgH, ball, error? }] }
 * @param {object} opts { smoothing, footLock, inPlace, trimStart, trimEnd }
 */
function buildMotion(raw, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const report = { lrSwaps: 0, outliersFixed: 0, framesMissing: 0, ballFrames: 0, footLockFrames: 0 };
  let src = raw.frames.slice(o.trimStart || 0, raw.frames.length - (o.trimEnd || 0));
  if (src.length < 2) throw new Error('Need at least 2 frames after trimming');
  // 1b. frames whose measurement is garbage (body cut off by the frame edge,
  // depth or 2D spikes) are re-made by interpolation like missing ones
  const bad = badFrames(src);
  if (bad.feetCut.length) report.feetCutFrames = bad.feetCut.length;
  if (bad.length) {
    report.droppedFrames = bad;
    const drop = new Set(bad.map((b) => b.i));
    src = src.map((fr, i) => (drop.has(i) ? { ...fr, error: 'dropped: ' + bad.find((b) => b.i === i).why } : fr));
  }

  const { conv, err } = detectConvention(src);
  report.convention = conv;
  report.reprojErrPx = Number.isFinite(err) ? +err.toFixed(1) : null;

  // 2. camera → world, ball lift
  let poses = src.map((fr) => {
    if (!fr || !fr.kp3d || fr.error) return null;
    return fr.kp3d.map((kp) => toWorld(CONVENTIONS[conv](kp, fr.camT || [0, 0, 0])));
  });
  // Ball depth. Size-based depth (focal × radius / pixels) is unreliable —
  // motion blur and hands change the apparent size — and once the subject's
  // yaw is removed, a depth error turns into a sideways error (the ball
  // "sticks" to one side). The hands are measured well, so: when the ball is
  // at a hand, its depth is that hand's depth; between touches (bounces) the
  // depth is interpolated; size-based depth is only a last resort. The ball
  // then sits exactly on the camera ray through its 2D centre.
  const camOf = (fr, k) => CONVENTIONS[conv](fr.kp3d[k], fr.camT || [0, 0, 0]);
  const WR = [J['left-wrist'], J['right-wrist']];
  const ballDepth = src.map((fr, i) => {
    if (!fr || !fr.ball || !poses[i] || !fr.kp2d || !(fr.ball.r > 1)) return null;
    let best = null;
    for (const k of WR) {
      const d = Math.hypot(fr.kp2d[k][0] - fr.ball.u, fr.kp2d[k][1] - fr.ball.v) / fr.ball.r;
      if (d < 2.2 && (!best || d < best.d)) best = { d, z: camOf(fr, k)[2] };
    }
    return best ? best.z : null;
  });
  const touchIdx = ballDepth.map((z, i) => (z == null ? -1 : i)).filter((i) => i >= 0);
  report.ballTouches = touchIdx.length;
  let balls = src.map((fr, i) => {
    const P = poses[i];
    if (!fr || !fr.ball || !P || !(fr.ball.r > 1)) return null;
    const f = fr.focal, cx = fr.imgW / 2, cy = fr.imgH / 2;
    const pelvisDepth = -pelvisOf(P)[2];
    let z = ballDepth[i];
    if (z == null && touchIdx.length) {
      const a = [...touchIdx].reverse().find((t) => t < i), b = touchIdx.find((t) => t > i);
      if (a != null && b != null) z = ballDepth[a] + ((ballDepth[b] - ballDepth[a]) * (i - a)) / (b - a);
      else z = ballDepth[a != null ? a : b];
    }
    if (z == null) {
      z = (f * BALL_RADIUS_M) / fr.ball.r;
      if (Math.abs(z - pelvisDepth) > 0.6) z = pelvisDepth - 0.25; // a dribble is in front of the body
    }
    const c = [((fr.ball.u - cx) * z) / f, ((fr.ball.v - cy) * z) / f, z];
    return toWorld(c);
  });

  // every frame's camera centre (origin of the camera space) and a point on
  // each measured ball ray: the ball's 2D position as an exact 3D ray, kept
  // through every transform below (the dribble fit uses them)
  let camO = src.map(() => [0, 0, 0]);
  let ballRay = balls.map((b) => (b ? b.slice() : null));

  // 3a. fill missing frames by interpolation
  const have = poses.map((p) => !!p);
  if (!have.some(Boolean)) throw new Error('No frame had a usable body reconstruction');
  for (let i = 0; i < poses.length; i++) {
    if (poses[i]) continue;
    report.framesMissing++;
    let a = i - 1; while (a >= 0 && !have[a]) a--;
    let b = i + 1; while (b < poses.length && !have[b]) b++;
    if (a >= 0 && b < poses.length) poses[i] = lerpPose(poses[a], poses[b], (i - a) / (b - a));
    else poses[i] = (poses[a >= 0 ? a : b]).map((p) => p.slice());
  }

  // 3a'. frames whose body was re-made (cut off / failed) still saw the ball:
  //      put it on its camera ray at the interpolated depth (never freeze it)
  const focalOf = (i) => { for (let d = 0; d < src.length; d++) for (const k of [i - d, i + d]) if (src[k]?.focal && src[k]?.imgW) return src[k]; return null; };
  for (let i = 0; i < src.length; i++) {
    const fr = src[i];
    if (balls[i] || !fr?.ball || !(fr.ball.r > 1)) continue;
    const cam = focalOf(i);
    if (!cam) continue;
    let z = null;
    const a = [...touchIdx].reverse().find((t) => t < i), bb = touchIdx.find((t) => t > i);
    if (a != null && bb != null) z = ballDepth[a] + ((ballDepth[bb] - ballDepth[a]) * (i - a)) / (bb - a);
    if (z == null) z = -pelvisOf(poses[i])[2] - 0.25;
    const f = cam.focal, cx = cam.imgW / 2, cy = cam.imgH / 2;
    balls[i] = toWorld([((fr.ball.u - cx) * z) / f, ((fr.ball.v - cy) * z) / f, z]);
    balls[i].interpolated = true;
    ballRay[i] = balls[i].slice();
  }

  // body-model joint rotations (SAM 3D Body's MHR fit), where measured
  let rotQ = MR.framesToQuats(src);
  if (rotQ.filter(Boolean).length < src.length * 0.5) rotQ = null;
  // 3b. left/right label swap repair (compare to previous frame)
  for (let i = 1; i < poses.length; i++) {
    const prev = poses[i - 1], cur = poses[i];
    const pc = pelvisOf(cur), pp = pelvisOf(prev);
    const rel = (P, pv, k) => S.sub(P[k], pv);
    let same = 0, swapped = 0;
    for (const k of BODY_IDX) {
      same += S.dist(rel(cur, pc, k), rel(prev, pp, k));
      swapped += S.dist(rel(cur, pc, S.MIRROR_PERM[k]), rel(prev, pp, k));
    }
    if (swapped < same * 0.6) {
      poses[i] = S.MIRROR_PERM.map((k) => cur[k]);
      report.lrSwaps++;
      if (rotQ) rotQ[i] = null; // that frame's rotations belong to the swapped labels: re-made from neighbours
    }
  }

  // 3b'. slow-motion takes: phones export slo-mo as normal-speed video with
  //      the middle slowed (×4 at 120 fps, ×8 at 240 fps). timeMap gives the
  //      slowdown per source-frame range; everything is resampled onto real
  //      time so physics (ball arcs, jumps) and playback speed are true.
  let srcIndex = src.map((_, i) => (o.trimStart || 0) + i);
  if (o.timeMap && Array.isArray(o.timeMap.segments) && o.timeMap.segments.length) {
    const fpsIn = raw.fps || 12, fpsOut = Math.max(10, Math.min(120, +o.timeMap.fps || 30));
    const slowAt = (i) => { const g = o.timeMap.segments.find((sg) => srcIndex[i] >= sg.from && srcIndex[i] < sg.to); return g ? Math.max(1, +g.slow || 1) : 1; };
    const T = [0];
    for (let i = 1; i < poses.length; i++) T.push(T[i - 1] + 1 / fpsIn / slowAt(i - 1));
    const n2 = Math.max(2, Math.floor(T[T.length - 1] * fpsOut) + 1);
    const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    const P2 = [], B2 = [], O2 = [], Y2 = [], Q2 = [], S2 = [];
    let i = 0;
    for (let k = 0; k < n2; k++) {
      const t = k / fpsOut;
      while (i < T.length - 2 && T[i + 1] <= t) i++;
      const u = Math.min(1, Math.max(0, (t - T[i]) / ((T[i + 1] - T[i]) || 1)));
      P2.push(poses[i].map((p, j) => lerp3(p, poses[i + 1][j], u)));
      const ba = balls[i], bb = balls[i + 1];
      B2.push(ba && bb ? Object.assign(lerp3(ba, bb, u), { interpolated: ba.interpolated || bb.interpolated }) : (u < 0.5 ? ba : bb) || null);
      O2.push(lerp3(camO[i], camO[i + 1], u));
      const ra = ballRay[i], rb = ballRay[i + 1];
      Y2.push(ra && rb ? Object.assign(lerp3(ra, rb, u), { interpolated: ra.interpolated || rb.interpolated }) : null);
      if (rotQ) { const qa = rotQ[i], qb = rotQ[i + 1]; Q2.push(qa && qb ? qa.map((q, j) => MR.slerp(q, qb[j], u)) : (qa || qb)); }
      S2.push(u < 0.5 ? i : i + 1);
    }
    report.timeMap = { segments: o.timeMap.segments, fpsIn, fpsOut, realSeconds: +T[T.length - 1].toFixed(3), frames: n2 };
    poses = P2; balls = B2; camO = O2; ballRay = Y2; if (rotQ) rotQ = Q2;
    srcIndex = S2.map((k) => srcIndex[k]);
    src = S2.map((k) => src[k]);
    raw = { ...raw, fps: fpsOut };
  }

  // 3c. per-joint outliers (Hampel filter over a 5-frame window, root-relative)
  const N = poses.length;
  for (let k = 0; k < 70; k++) {
    for (let i = 0; i < N; i++) {
      const win = [];
      for (let d = -2; d <= 2; d++) if (d && poses[i + d]) win.push(S.sub(poses[i + d][k], pelvisOf(poses[i + d])));
      if (win.length < 2) continue;
      const med = [0, 1, 2].map((c) => S.median(win.map((w) => w[c])));
      const pv = pelvisOf(poses[i]);
      const cur = S.sub(poses[i][k], pv);
      if (S.dist(cur, med) > 0.35) { poses[i][k] = S.add(med, pv); report.outliersFixed++; }
    }
  }

  // Ball: fill short gaps (≤ 3 frames) linearly
  for (let i = 0; i < N; i++) {
    if (balls[i]) continue;
    let a = i - 1; while (a >= 0 && !balls[a]) a--;
    let b = i + 1; while (b < N && !balls[b]) b++;
    if (a >= 0 && b < N && b - a <= 4) {
      const t = (i - a) / (b - a);
      balls[i] = [0, 1, 2].map((c) => balls[a][c] + (balls[b][c] - balls[a][c]) * t);
      balls[i].interpolated = true;
    }
  }

  // 4. temporal smoothing
  const sig = +o.smoothing || 0;
  if (sig > 0.05) {
    for (let k = 0; k < 70; k++) for (let c = 0; c < 3; c++) {
      const sm = gaussianSmooth(poses.map((P) => P[k][c]), sig);
      for (let i = 0; i < N; i++) poses[i][k][c] = sm[i];
    }
    // Ball moves fast (bounces) — much lighter smoothing so the floor hit stays sharp
    for (let c = 0; c < 3; c++) {
      const sm = gaussianSmooth(balls.map((b) => (b ? b[c] : NaN)), Math.min(0.6, sig * 0.4));
      for (let i = 0; i < N; i++) if (balls[i]) balls[i][c] = sm[i];
    }
  }

  if (rotQ) rotQ = MR.smoothQuats(MR.fillQuats(rotQ), Math.min(1, sig * 0.7));

  // 5a. level the ground: up vector from the early (stance) frames
  const early = poses.slice(0, Math.max(2, Math.ceil(N * 0.25)));
  const upSamples = early.map((P) => S.norm(S.sub(P[J.neck], S.mid(P[J['left-ankle']], P[J['right-ankle']]))));
  let up = S.norm([0, 1, 2].map((c) => S.median(upSamples.map((u) => u[c]))));
  // A stance can lean; never trust more than ~25° of correction from posture alone
  if (S.dot(up, [0, 1, 0]) < Math.cos((25 * Math.PI) / 180)) up = S.norm(S.add(up, [0, 2, 0]));
  const Rup = S.rotBetween(up, [0, 1, 0]);
  const apply = (fn) => {
    poses = poses.map((P) => mapPts(P, fn));
    balls = balls.map((b) => (b ? Object.assign(fn(b), { interpolated: b.interpolated }) : null));
    camO = camO.map(fn); ballRay = ballRay.map((q) => (q ? fn(q) : null));
  };
  apply((p) => S.mulMV(Rup, p));

  // 5b. face forward (+Z) using the early frames' hips + shoulders
  const fwdSamples = early.map((P0, i) => {
    const P = poses[i];
    const left = S.add(S.sub(P[J['left-hip']], P[J['right-hip']]), S.sub(P[J['left-shoulder']], P[J['right-shoulder']]));
    return S.norm(S.cross(left, [0, 1, 0]));
  });
  const fwd = [S.median(fwdSamples.map((f) => f[0])), 0, S.median(fwdSamples.map((f) => f[2]))];
  const yaw = -Math.atan2(fwd[0], fwd[2]);
  const p0 = pelvisOf(poses[0]);
  const Ryaw = S.rotY(yaw);
  apply((p) => S.mulMV(Ryaw, [p[0] - p0[0], p[1], p[2] - p0[2]]));
  report.sourceYawDeg = Math.round((-yaw * 180) / Math.PI);
  if (rotQ) rotQ = MR.rotateAll(rotQ, MR.quatOf(Ryaw.map((row) => [0, 1, 2].map((c) => row[0] * Rup[0][c] + row[1] * Rup[1][c] + row[2] * Rup[2][c]))));
  // Camera depth axis in the output frame (the camera looked along −Z before
  // levelling + facing): body-relative pose is reliable, travel along this
  // axis is not (monocular depth). Used by the game-clip builder.
  {
    const v = S.mulMV(Ryaw, S.mulMV(Rup, [0, 0, -1]));
    const l = Math.hypot(v[0], v[2]) || 1;
    report.viewDir = [+(v[0] / l).toFixed(4), 0, +(v[2] / l).toFixed(4)];
  }

  // 6a. ground: low percentile of the lowest foot point per frame
  const footMin = poses.map((P) => Math.min(...FOOT_LOW.left.concat(FOOT_LOW.right).map((k) => P[k][1])));
  const ground = S.percentile(footMin, 0.05);
  apply((p) => [p[0], p[1] - ground, p[2]]);
  // A ball never goes through the floor
  balls = balls.map((b) => (b ? Object.assign([b[0], Math.max(BALL_RADIUS_M, b[1]), b[2]], { interpolated: b.interpolated }) : null));

  // 6a'. per-frame floor snap. Monocular depth drifts as the player travels
  //      toward/away from the camera, so the whole body floats or sinks frame
  //      to frame (feet look wrong from other angles). Snap the lowest foot to
  //      the floor on grounded frames; airborne frames (jumps) keep their
  //      height relative to the interpolated floor offset. Smoothed.
  let liftSeries = null;
  if (o.floorSnap !== false) {
    // Drift is slow, jumps are fast: the floor reference is the running
    // minimum of the lowest foot over ±0.5 s (every jump/hop has a grounded
    // frame within that window), smoothed. Frames near it are snapped exactly;
    // frames clearly above it (hops, jump shots) keep their height over it.
    const lowAll = poses.map((P) => Math.min(...FOOT_LOW.left.concat(FOOT_LOW.right).map((k) => P[k][1])));
    const clipFps = raw.fps || 12;
    const hw = Math.max(3, Math.round(clipFps * 0.5));
    const runMin = lowAll.map((_, i) => Math.min(...lowAll.slice(Math.max(0, i - hw), i + hw + 1)));
    const base = gaussianSmooth(runMin, Math.max(1, clipFps * 0.25));
    const lift = lowAll.map((h, i) => h - base[i]);
    liftSeries = lift;
    let off = lowAll.map((h, i) => (lift[i] < 0.06 ? -h : -base[i]));
    off = gaussianSmooth(off, 0.8);
    poses = poses.map((P, i) => mapPts(P, (p) => [p[0], p[1] + off[i], p[2]]));
    camO = camO.map((p, i) => [p[0], p[1] + off[i], p[2]]); ballRay = ballRay.map((q, i) => (q ? [q[0], q[1] + off[i], q[2]] : null));
    balls = balls.map((b, i) => (b ? Object.assign([b[0], b[1] + off[i], b[2]], { interpolated: b.interpolated }) : null));
    report.floorSnapMaxCm = Math.round(Math.max(...off.map(Math.abs)) * 100);
    report.airborneFrames = lift.filter((v) => v >= 0.06).length;
    report.maxJumpCm = Math.round(Math.max(0, ...lift) * 100);
  }

  // 6b. foot lock: contact = near ground + slow; pin height (and skating) during contact
  const fps = raw.fps || 12;
  if (o.footLock) {
    for (const side of ['left', 'right']) {
      const low = poses.map((P) => Math.min(...FOOT_LOW[side].map((k) => P[k][1])));
      const heel = poses.map((P) => P[FOOT_LOW[side][0]]);
      const contact = poses.map((_, i) => {
        const v = i > 0 ? Math.hypot(heel[i][0] - heel[i - 1][0], heel[i][2] - heel[i - 1][2]) * fps : 0;
        return low[i] < 0.05 && v < 0.6;
      });
      let i = 0;
      while (i < N) {
        if (!contact[i]) { i++; continue; }
        let j = i; while (j + 1 < N && contact[j + 1]) j++;
        const anchor = [S.median(heel.slice(i, j + 1).map((h) => h[0])), S.median(heel.slice(i, j + 1).map((h) => h[2]))];
        for (let t = i; t <= j; t++) {
          const dx = Math.max(-0.12, Math.min(0.12, anchor[0] - heel[t][0]));
          const dz = Math.max(-0.12, Math.min(0.12, anchor[1] - heel[t][2]));
          const dy = -low[t];
          for (const k of FOOT[side]) poses[t][k] = [poses[t][k][0] + dx, poses[t][k][1] + dy, poses[t][k][2] + dz];
          report.footLockFrames++;
        }
        i = j + 1;
      }
      // never below the floor
      for (let t = 0; t < N; t++) {
        const m = Math.min(...FOOT_LOW[side].map((k) => poses[t][k][1]));
        if (m < 0) for (const k of FOOT[side]) poses[t][k][1] -= m;
      }
    }
  }

  // 7. stature from pose-invariant segment lengths
  const seg = (a, b) => S.median(poses.map((P) => S.dist(P[J[a]], P[J[b]])));
  const shin = (seg('left-knee', 'left-ankle') + seg('right-knee', 'right-ankle')) / 2;
  const thigh = (seg('left-hip', 'left-knee') + seg('right-hip', 'right-knee')) / 2;
  const torso = S.median(poses.map((P) => S.dist(pelvisOf(P), P[J.neck])));
  const neckHead = S.median(poses.map((P) => S.dist(P[J.neck], S.mid(P[J['left-ear']], P[J['right-ear']]))));
  const ankleH = S.median(poses.map((P) => (P[J['left-ankle']][1] + P[J['right-ankle']][1]) / 2)) || 0.08;
  const statureM = +(Math.min(0.12, Math.max(0.05, ankleH)) + shin + thigh + torso + neckHead + 0.12).toFixed(3);

  // root trajectory + in-place
  const root = poses.map((P) => { const p = pelvisOf(P); return [+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4)]; });
  if (o.inPlace) {
    // Remove the TRAVEL, not the pelvis sway: subtracting the raw per-frame
    // pelvis made planted feet jitter/skate; a smoothed root keeps the body's
    // natural weight shift and feet slide only at the travel speed (standard
    // in-place animation — the game moves the player)
    const sig = Math.max(1.5, (fps || 12) * 0.3);
    const rx = gaussianSmooth(root.map((r) => r[0]), sig), rz = gaussianSmooth(root.map((r) => r[2]), sig);
    poses = poses.map((P, i) => mapPts(P, (p) => [p[0] - rx[i], p[1], p[2] - rz[i]]));
    balls = balls.map((b, i) => (b ? Object.assign([b[0] - rx[i], b[1], b[2] - rz[i]], { interpolated: b.interpolated }) : null));
    camO = camO.map((p, i) => [p[0] - rx[i], p[1], p[2] - rz[i]]); ballRay = ballRay.map((q, i) => (q ? [q[0] - rx[i], q[1], q[2] - rz[i]] : null));
  }

  // starting hand: wrist closest to the ball in the first quarter
  let startingHand = null;
  const q = Math.max(1, Math.ceil(N * 0.25));
  let dl = 0, dr = 0, nb = 0;
  for (let i = 0; i < q; i++) {
    if (!balls[i]) continue;
    dl += S.dist(balls[i], poses[i][J['left-wrist']]);
    dr += S.dist(balls[i], poses[i][J['right-wrist']]);
    nb++;
  }
  if (nb) startingHand = dr <= dl ? 'right' : 'left';
  report.ballFrames = balls.filter(Boolean).length;

  // 8. dribble physics — a clean ball path instead of noisy per-frame lifts:
  //    in hand  → the ball rides under the dribbling palm
  //    released → straight line down to a floor bounce, straight line back up
  //               to the catch (timing from the lowest detected point)
  if (o.ballPhysics !== false && report.ballFrames >= 4) {
    const palm = (P, side) => S.mid(P[J[`${side}-wrist`]], P[J[`${side}-middle-first-joint`]]);
    // Contact is decided in the image first: SAM 3's ball circle and the hand keypoints are both
    // exact in 2D (depth is the uncertain axis). A hand touches the ball when one of its keypoints
    // (wrist, any finger joint) lies on or over the ball's circle; 3D only confirms it.
    const HAND_KP = Object.fromEntries(['left', 'right'].map((sd) => [sd, Object.keys(J).filter((n) => n === `${sd}-wrist` || new RegExp(`^${sd}-(thumb|index|middle|ring|pinky)-`).test(n)).map((n) => J[n])]));
    const touch2d = src.map((fr) => {
      if (!fr?.ball || !fr.kp2d || !(fr.ball.r > 1)) return null;
      let best = null;
      for (const sd of ['left', 'right']) {
        for (const k of HAND_KP[sd]) {
          const q = fr.kp2d[k]; if (!q) continue;
          const d = Math.hypot(q[0] - fr.ball.u, q[1] - fr.ball.v) / fr.ball.r;
          if (!best || d < best.d) best = { side: sd, d };
        }
      }
      return best && best.d < 1.25 ? best : null;
    });
    const handSide = [], d3 = [];
    const held3d = balls.map((b, i) => {
      if (!b) return false;
      const dl = S.dist(b, palm(poses[i], 'left')), dr = S.dist(b, palm(poses[i], 'right'));
      handSide[i] = dl <= dr ? 'left' : 'right';
      d3[i] = Math.min(dl, dr);
      return d3[i] < 0.24;
    });
    // SAM sees the ball touching that hand in the picture: a contact even when the 3D depth puts
    // it up to 40 cm off — inside a hold only (held on both sides within 3 frames), so a gap in
    // the hold is closed but a release / catch keeps its measured frame
    const heldNear = (i, dir) => { for (let k = i + dir; k >= 0 && k < N && Math.abs(k - i) <= 3; k += dir) if (held3d[k] && handSide[k] === handSide[i]) return true; return false; };
    const inHand = held3d.map((h, i) => h || (!!balls[i] && touch2d[i]?.side === handSide[i] && d3[i] < 0.4 && heldNear(i, -1) && heldNear(i, 1)));
    report.ballContacts2d = touch2d.filter(Boolean).length;
    // In hand: the ball sits against the palm on the side it was measured —
    // under the palm when dribbling, on top of it when gathering/shooting
    // ray of a measured ball: camera centre → the detected ball (exact in 2D)
    const rayOf = (k) => (ballRay[k] ? { o: camO[k], d: S.norm(S.sub(ballRay[k], camO[k])) } : null);
    // The held ball sits against the palm (radius + 3 cm from the palm joint centre — the runtime's
    // palm contact), toward where SAM saw it: on the point of its camera ray nearest the palm.
    const PALM_T = 0.03;
    const held = (i) => {
      const P = poses[i];
      const p = palm(P, handSide[i]);
      const b = balls[i];
      let dir = [0, -1, 0.15];
      // seen in the picture: the ball is on its ray, at the point nearest the palm
      const ry = rayOf(i);
      if (ry) {
        const t = S.dot(S.sub(p, ry.o), ry.d);
        const onRay = S.add(ry.o, S.scale(ry.d, t));
        const d = S.sub(onRay, p);
        if (S.len(d) > 0.02) dir = d;
      } else if (b && !b.interpolated) { const d = S.sub(b, p); if (S.len(d) > 0.02) dir = d; }
      const q = S.add(p, S.scale(S.norm(dir), BALL_RADIUS_M + PALM_T));
      return [q[0], Math.max(BALL_RADIUS_M, q[1]), q[2]];
    };
    // Free flight between two touches = gravity arcs through one floor bounce
    // (or one arc, hand to hand). For a bounce time the path is linear in the
    // bounce spot (x, z): least squares against every measured ball ray gives
    // it exactly; the best bounce time wins. The fitted path goes where the
    // video shows it — between the legs, behind the body, on any plane.
    const G = 9.81, R0 = BALL_RADIUS_M;
    const arcY = (y0, y1, T, t) => { const v = (y1 - y0 + 0.5 * G * T * T) / T; return y0 + v * t - 0.5 * G * t * t; };
    const fitFlight = (a, c, A, Cc) => {
      const obs = [];
      for (let k = a + 1; k < c; k++) { const ry = rayOf(k); if (ry && !ballRay[k].interpolated) obs.push({ k, ...ry }); }
      const T = (c - a) / fps;
      // path at frame k given bounce frame tb and bounce spot (bx, bz):
      //   p = base + bx·ex + bz·ez  (ex, ez = [wx,0,0], [0,0,wz]), base/weights from the arcs
      const pathTerms = (k, tb) => {
        if (tb == null) { const t = (k - a) / (c - a); return { base: [A[0] + (Cc[0] - A[0]) * t, arcY(A[1], Cc[1], T, t * T), A[2] + (Cc[2] - A[2]) * t], w: 0 }; }
        if (k <= tb) { const u = (k - a) / (tb - a); return { base: [A[0] * (1 - u), arcY(A[1], R0, (tb - a) / fps, (k - a) / fps), A[2] * (1 - u)], w: u }; }
        const u = (k - tb) / (c - tb); return { base: [Cc[0] * u, arcY(R0, Cc[1], (c - tb) / fps, (k - tb) / fps), Cc[2] * u], w: 1 - u };
      };
      const perp = (v, d) => S.sub(v, S.scale(d, S.dot(v, d)));   // component off the ray
      let best = null;
      const cands = [null];
      for (let tb = a + 1; tb <= c - 1; tb += 0.25) cands.push(tb);
      for (const tb of cands) {
        // minimise Σ |perp(base + bx·wX + bz·wZ − o)|² over (bx, bz)
        let sxx = 0, sxz = 0, szz = 0, rx = 0, rz = 0, c0 = 0;
        const terms = obs.map((ob) => ({ ob, ...pathTerms(ob.k, tb) }));
        for (const { ob, base, w } of terms) {
          const r = perp(S.sub(base, ob.o), ob.d), ex = perp([w, 0, 0], ob.d), ez = perp([0, 0, w], ob.d);
          sxx += S.dot(ex, ex); sxz += S.dot(ex, ez); szz += S.dot(ez, ez); rx += S.dot(ex, r); rz += S.dot(ez, r); c0 += S.dot(r, r);
        }
        let bx = (A[0] + Cc[0]) / 2, bz = (A[2] + Cc[2]) / 2, err;
        if (tb != null) {
          const det = sxx * szz - sxz * sxz;
          if (det > 1e-9) { bx = -(szz * rx - sxz * rz) / det; bz = -(sxx * rz - sxz * rx) / det; }
          err = c0 + 2 * (bx * rx + bz * rz) + bx * bx * sxx + 2 * bx * bz * sxz + bz * bz * szz;
        } else err = c0;
        // a bounce far from both hands is not a dribble (bad fit / no data)
        if (tb != null && Math.min(Math.hypot(bx - A[0], bz - A[2]), Math.hypot(bx - Cc[0], bz - Cc[2])) > 1.5) continue;
        if (!best || err < best.err) best = { tb, bx, bz, err };
      }
      if (!best || obs.length < 2) return null;
      const out2 = [];
      for (let k = a + 1; k < c; k++) {
        const { base, w } = pathTerms(k, best.tb);
        out2.push([base[0] + best.bx * w, Math.max(R0, base[1]), base[2] + best.bz * w]);
      }
      report.ballFit = (report.ballFit || []).concat([{ from: a, to: c, bounce: best.tb, rms: +Math.sqrt(best.err / Math.max(1, obs.length)).toFixed(3), obs: obs.length }]);
      return out2;
    };
    const out = balls.map((b, i) => (inHand[i] ? held(i) : b ? b.slice() : null));
    // A hold is one contact: the ball's place on the hand (in the hand's own frame) changes
    // smoothly through it, not by each frame's detection noise — smoothed over each held run,
    // kept on the palm surface (distance radius + palm thickness from the palm centre).
    const handBasis = (P, sd) => {
      const w = P[J[`${sd}-wrist`]], x = S.norm(S.sub(P[J[`${sd}-middle-third-joint`]], w));
      const a = S.sub(P[J[`${sd}-index-third-joint`]], w), c = S.sub(P[J[`${sd}-pinky-third-joint`]], w);
      const n0 = S.norm([a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]]);
      const y = S.norm([n0[1] * x[2] - n0[2] * x[1], n0[2] * x[0] - n0[0] * x[2], n0[0] * x[1] - n0[1] * x[0]]);
      const n = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
      return { x, y, n };
    };
    for (let i0 = 0; i0 < N; ) {
      if (!inHand[i0] || !out[i0]) { i0++; continue; }
      let i1 = i0; while (i1 + 1 < N && inHand[i1 + 1] && out[i1 + 1] && handSide[i1 + 1] === handSide[i0]) i1++;
      if (i1 - i0 >= 8) {   // long holds only: a short hold is a push — its measured path is the release
        const loc = [];
        for (let k = i0; k <= i1; k++) {
          const Bk = handBasis(poses[k], handSide[k]), o = S.sub(out[k], palm(poses[k], handSide[k]));
          loc.push([S.dot(o, Bk.x), S.dot(o, Bk.y), S.dot(o, Bk.n)]);
        }
        const sm = [0, 1, 2].map((c) => gaussianSmooth(loc.map((l) => l[c]), 1.2));
        for (let k = i0; k <= i1; k++) {
          const Bk = handBasis(poses[k], handSide[k]), p = palm(poses[k], handSide[k]);
          let o = [sm[0][k - i0], sm[1][k - i0], sm[2][k - i0]];
          const L = Math.hypot(o[0], o[1], o[2]) || 1; o = o.map((v) => (v / L) * (BALL_RADIUS_M + PALM_T));
          const q = S.add(p, S.add(S.add(S.scale(Bk.x, o[0]), S.scale(Bk.y, o[1])), S.scale(Bk.n, o[2])));
          out[k] = [q[0], Math.max(BALL_RADIUS_M, q[1]), q[2]];
        }
        report.ballHoldsSmoothed = (report.ballHoldsSmoothed || 0) + 1;
      }
      i0 = i1 + 1;
    }
    let i = 0, segments = 0;
    while (i < N) {
      if (inHand[i] || !balls[i]) { i++; continue; }
      let j = i; while (j + 1 < N && !inHand[j + 1] && balls[j + 1]) j++;
      const a = i - 1, c = j + 1;                     // release / catch frames (in hand)
      const fit = a >= 0 && c < N && inHand[a] && inHand[c] ? fitFlight(a, c, out[a], out[c]) : null;
      if (fit) {
        for (let k = a + 1; k < c; k++) out[k] = fit[k - a - 1];
        segments++;
      } else if (a >= 0 && c < N && inHand[a] && inHand[c]) {
        const A = out[a], Cc = out[c];
        let tb = i; for (let k = i; k <= j; k++) if (balls[k][1] < balls[tb][1]) tb = k; // bounce frame
        const floor = [(A[0] + Cc[0]) / 2, BALL_RADIUS_M, (A[2] + Cc[2]) / 2];
        for (let k = i; k <= j; k++) {
          const t = k <= tb ? (k - a) / (tb - a) : (k - tb) / (c - tb);
          const from = k <= tb ? A : floor, to = k <= tb ? floor : Cc;
          out[k] = [0, 1, 2].map((d) => from[d] + (to[d] - from[d]) * t);
        }
        segments++;
      }
      i = j + 1;
    }
    // Shot: after the LAST in-hand frame the ball never comes back and it
    // goes UP (or rises out of frame) → it was released. From then on the
    // sprite has no ball — the game flies it from the release point.
    let lastHeld = -1;
    for (let k = N - 1; k >= 0; k--) if (inHand[k]) { lastHeld = k; break; }
    const released = new Array(N).fill(false);
    if (lastHeld >= 0 && lastHeld < N - 1) {
      const y0 = out[lastHeld][1];
      const tail = balls.slice(lastHeld + 1).map((b) => (b ? b[1] : null));
      const seen = tail.filter((v) => v != null);
      const rises = seen.length ? Math.max(...seen) - y0 > 0.15 || (seen[0] > y0 + 0.03 && seen.length < tail.length) : false;
      if (rises) {
        for (let k = lastHeld + 1; k < N; k++) released[k] = true;
        const pr = poses[lastHeld];
        // A hop before the jump (step-back, side-step): the first airborne run
        // that ends before the jump containing the release
        let stepFrame = null;
        if (liftSeries) {
          const air = liftSeries.map((v) => v >= 0.06);
          let j0 = lastHeld; while (j0 > 0 && air[j0 - 1]) j0--;           // jump take-off
          if (!air[lastHeld]) { while (j0 < N - 1 && !air[j0]) j0++; }     // released just before take-off
          let k = j0 - 1; while (k >= 0 && !air[k]) k--;                   // grounded gap before it
          if (k >= 0) { while (k > 0 && air[k - 1]) k--; stepFrame = k; }
        }
        report.shotRelease = {
          stepFrame,
          lastHeldFrame: lastHeld, releaseFrame: lastHeld + 1,
          point: out[lastHeld].map((v) => +v.toFixed(3)),
          hand: S.dist(out[lastHeld], palm(pr, 'left')) < S.dist(out[lastHeld], palm(pr, 'right')) ? 'left' : 'right',
        };
      }
    }
    balls = out.map((b, k) => (released[k] ? null : b ? Object.assign(b, { interpolated: !inHand[k] && !balls[k], held: !!inHand[k], ...(inHand[k] ? { hand: handSide[k] } : {}) }) : null));
    report.ballReleased = released.filter(Boolean).length;
    report.ballHeldFrames = inHand.filter(Boolean).length;
    report.bounces = segments;
  }

  const r4 = (p) => [+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4)];
  return {
    version: 1,
    fps,
    frameCount: N,
    settings: o,
    statureM,
    startingHand,
    root,
    frames: poses.map((P, i) => ({
      joints: P.map(r4),
      ball: balls[i] ? { p: r4(balls[i]), r: BALL_RADIUS_M, interpolated: !!balls[i].interpolated, ...(balls[i].held !== undefined ? { held: balls[i].held } : {}), ...(balls[i].hand ? { hand: balls[i].hand } : {}) } : null,
      sourceFile: src[i]?.file || null, srcIndex: srcIndex[i],
      ...(rotQ ? { rots: rotQ[i].flat().map((x) => +x.toFixed(5)) } : {}),
    })),
    report,
  };
}

module.exports = {
  badFrames, buildMotion, detectConvention, BALL_RADIUS_M, DEFAULTS };
