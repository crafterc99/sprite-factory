/**
 * Ball setup for a clip library on a character: the recorded (single-camera)
 * ball tracks are made physically valid for THIS body before play —
 * BP.repairClipBall on every clip (and its mirrored copy), with the clip's
 * poses skinned exactly as the court shows them (capture layer included).
 */
import { samplePose, NP } from './anim3d.mjs';
import { mhrBoneMatricesCaptured, mhrBoneMatrices } from './mhr-skin.mjs';
import { jointAccessor } from './contact-ik.mjs';
import { bodySampleFromJoints, repairClipBall, BALL_DEFAULTS } from './basketball-physics.mjs';

/** Body sample of a clip's pose at a frame (root space). */
export function clipBodyAt(clip, mrig, cfg = BALL_DEFAULTS) {
  const mats = new Float32Array(mrig.n * 16), pose = new Float32Array(NP * 3);
  return (i) => {
    pose.set(samplePose(clip, i));
    if (clip.rots && clip.rotsJoints === mrig.n) mhrBoneMatricesCaptured(pose, mrig, [{ clip, t: i, w: 1 }], 1, mats);
    else mhrBoneMatrices(pose, mrig, mats);
    return bodySampleFromJoints(jointAccessor(mats, mrig), cfg);
  };
}

/**
 * Flights with no recorded ball (synthetic clips: the runtime flies a gravity arc hand → floor → hand):
 * does that arc fit through this body? Worst clearance (m) over all such flights.
 */
export function arcClearance(clip, bodyAt, cfg = BALL_DEFAULTS) {
  const F = clip.F, ball = clip.ball || [], R = cfg.radius;
  let worst = Infinity;
  for (let i = 0; i < F; i++) {
    if (!ball[i] || ball[i].held || ball[i].rec) continue;
    let j = i; while (j + 1 < F && ball[j + 1] && !ball[j + 1].held) j++;
    const A = ball[i - 1]?.held ? ball[i - 1].p : null, C = ball[j + 1]?.held ? ball[j + 1].p : null;
    if (A && C) {
      const B = [(A[0] + C[0]) / 2, R, (A[2] + C[2]) / 2];
      for (let k = 1; k < 12; k++) {
        const u = k / 12, p = u < 0.5 ? A.map((a, d) => a + (B[d] - a) * u * 2) : B.map((b, d) => b + (C[d] - b) * (u - 0.5) * 2);
        const S = bodyAt(Math.round(i - 1 + (j - i + 2) * u));
        for (const [n, c] of Object.entries(S.caps)) {
          if (!/thigh|shin|foot/.test(n)) continue;
          const ab = c.b.map((v, d) => v - c.a[d]), t = Math.max(0, Math.min(1, ((p[0] - c.a[0]) * ab[0] + (p[1] - c.a[1]) * ab[1] + (p[2] - c.a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
          worst = Math.min(worst, Math.hypot(p[0] - c.a[0] - ab[0] * t, p[1] - c.a[1] - ab[1] * t, p[2] - c.a[2] - ab[2] * t) - c.r - R);
        }
      }
    }
    i = j;
  }
  return worst;
}

/**
 * Repair every clip of a library (lib from buildLibrary) and drop the variants
 * whose ball path cannot fit this body (a synthetic arc through a leg) whenever
 * a valid variant of the same role exists. Returns a report per clip.
 */
export function repairLibrary(lib, mrig, cfg = BALL_DEFAULTS) {
  const seen = new Set(), report = [];
  const visit = (c) => {
    if (!c || typeof c !== 'object' || !c.ball || seen.has(c)) return;
    seen.add(c);
    if (!c.ballRepair) {
      const bodyAt = clipBodyAt(c, mrig, cfg);
      c.ballRepair = repairClipBall(c, bodyAt, { margin: cfg.planMargin ?? 0.02, viewDir: c.json?.viewDirRoot ? [c.mirror ? -c.json.viewDirRoot[0] : c.json.viewDirRoot[0], 0, c.json.viewDirRoot[2]] : null, cfg });
      c.ballRepair.arcClearance = arcClearance(c, bodyAt, cfg);
      c.ballInvalid = c.ballRepair.arcClearance < -0.03;   // more than 3 cm into a leg: this body cannot play it
      report.push({ clip: c.name + (c.mirror ? ' (mirrored)' : ''), ...c.ballRepair, invalid: c.ballInvalid });
    }
    if (c.mirrored) visit(c.mirrored);
  };
  for (const v of Object.values(lib)) { if (Array.isArray(v)) v.forEach(visit); else visit(v); }
  // prune: a role keeps only its physically valid variants (if it has any)
  for (const key of Object.keys(lib)) {
    if (!key.endsWith(':variants')) continue;
    const vs = lib[key], ok = vs.filter((c) => !c.ballInvalid);
    if (ok.length && ok.length < vs.length) {
      lib[key] = ok;
      const role = key.slice(0, -9);
      if (lib[role]?.ballInvalid) { lib[role] = ok[0]; if (ok[0].mirrored) lib[role + ':mirror'] = ok[0].mirrored; }
      for (const c of vs) if (c.ballInvalid) report.push({ clip: c.name, dropped: true, role });
    }
    // mirrored copies that cannot fit are not offered either
    for (const c of lib[key]) if (c.mirrored?.ballInvalid && !c.ballInvalid) c.mirrored = null;
  }
  return report;
}
