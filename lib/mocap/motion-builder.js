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
const { J } = S;

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
    }
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

  // 6a. ground: low percentile of the lowest foot point per frame
  const footMin = poses.map((P) => Math.min(...FOOT_LOW.left.concat(FOOT_LOW.right).map((k) => P[k][1])));
  const ground = S.percentile(footMin, 0.05);
  apply((p) => [p[0], p[1] - ground, p[2]]);
  // A ball never goes through the floor
  balls = balls.map((b) => (b ? Object.assign([b[0], Math.max(BALL_RADIUS_M, b[1]), b[2]], { interpolated: b.interpolated }) : null));

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
          const dx = Math.max(-0.05, Math.min(0.05, anchor[0] - heel[t][0]));
          const dz = Math.max(-0.05, Math.min(0.05, anchor[1] - heel[t][2]));
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
    poses = poses.map((P, i) => mapPts(P, (p) => [p[0] - root[i][0], p[1], p[2] - root[i][2]]));
    balls = balls.map((b, i) => (b ? Object.assign([b[0] - root[i][0], b[1], b[2] - root[i][2]], { interpolated: b.interpolated }) : null));
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
      ball: balls[i] ? { p: r4(balls[i]), r: BALL_RADIUS_M, interpolated: !!balls[i].interpolated } : null,
      sourceFile: src[i]?.file || null,
    })),
    report,
  };
}

module.exports = { buildMotion, detectConvention, BALL_RADIUS_M, DEFAULTS };
