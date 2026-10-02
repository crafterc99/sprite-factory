/**
 * BallSession — one tick of the ball in the game (docs/ball-contact-system.md), shared by the
 * court (court3d.html) and the headless tests so both run exactly the same code:
 *
 *   input buffer + move graph → (Player.update, posing: the caller)
 *   → BallTarget_L / BallTarget_R from the skinned skeleton (the animation pose, before IK)
 *   → the animation's ball schedule, predicted in the world
 *   → BallController (state machine + trajectories)
 *   → physics only when nobody controls the ball (shot in flight, loose, dead)
 *   → small, limited IK toward the ball
 *   → the hands' own skin against the ball (palm on it, fingers out of it / gripping it)
 *
 * Engine-agnostic (no three.js). Needs: a Player (anim3d), the MHR rig (mhr-skin prepareMhr),
 * contact-ik, and optionally a BasketballPhysicsSystem.
 */
import { BallController, palmTarget, isHeld, BALL_CONTROL_DEFAULTS } from './ball-control.mjs';
import { clearOfCaps } from './ball-contacts.mjs';
import { planShot, lateFlight, mulberry32 } from './shot-flight.mjs';
import { handColliders, clearance, sweepClear, fitBallToHands } from './ball-fit.mjs';
import { meterAfterUpdate } from './shot-meter.mjs';
import { segPos, planBounce } from './ball-trajectory.mjs';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const other = (h) => (h === 'left' ? 'right' : h === 'right' ? 'left' : h);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Limb radii of a rig, measured from its own bind mesh (thigh / shin / foot / arms): the ball's
 * collision body and the bounce clearance fit THIS character, not a default adult.
 * @param {object} json   rig JSON (kind 'mhr', parts[0] = body with verts + skinIdx + skinW)
 * @param {object} mrig   prepareMhr() result (names, JI, b = bind joint positions)
 * @param {(s: string, T: any) => any} b64  base64 decoder (anim3d.b64)
 */
export function measureLimbRadii(json, mrig, b64) {
  try {
    const part = json.parts?.[0];
    if (!part) return null;
    const V = b64(part.verts, Float32Array), SI = b64(part.skinIdx, Uint8Array), SW = b64(part.skinW, Float32Array);
    const n = V.length / 3, J = (nm) => mrig.b[mrig.JI[nm]];
    const segs = {
      thigh: [['l_upleg', 'l_lowleg'], ['r_upleg', 'r_lowleg'], /^[lr]_upleg/],
      shin: [['l_lowleg', 'l_foot'], ['r_lowleg', 'r_foot'], /^[lr]_lowleg/],
      upperArm: [['l_uparm', 'l_lowarm'], ['r_uparm', 'r_lowarm'], /^[lr]_uparm/],
      forearm: [['l_lowarm', 'l_wrist'], ['r_lowarm', 'r_wrist'], /^[lr]_lowarm/],
    };
    const out = {};
    for (const [k, [sl, sr, re]] of Object.entries(segs)) {
      const ds = [];
      for (let i = 0; i < n; i++) {
        let best = 0, bw = 0; for (let c = 0; c < 4; c++) if (SW[i * 4 + c] > bw) { bw = SW[i * 4 + c]; best = SI[i * 4 + c]; }
        const nm = mrig.names[best];
        if (!re.test(nm)) continue;
        const [a, b] = nm[0] === 'l' ? sl : sr, A = J(a), B = J(b);
        if (!A || !B) continue;
        const p = [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], ab = sub(B, A), t = clamp(((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1] + (p[2] - A[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1), 0.15, 0.85);
        ds.push(len(sub(p, add(A, sc(ab, t)))));
      }
      if (ds.length > 20) { ds.sort((x, y) => x - y); out[k] = +ds[Math.floor(ds.length * 0.6)].toFixed(4); }
    }
    if (out.shin) out.foot = +(out.shin * 0.85).toFixed(4);
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** The body parts a flight must stay clear of: the dominant bone of a skin vertex → its part, the part's joint pair. */
const BODY_PARTS = [
  ['l_thigh', /^l_upleg/, 'l_upleg', 'l_lowleg'], ['l_shin', /^l_lowleg/, 'l_lowleg', 'l_foot'], ['l_foot', /^l_(foot|talocrural|subtalar|transversetarsal|ball)/, 'l_foot', 'l_ball'],
  ['r_thigh', /^r_upleg/, 'r_upleg', 'r_lowleg'], ['r_shin', /^r_lowleg/, 'r_lowleg', 'r_foot'], ['r_foot', /^r_(foot|talocrural|subtalar|transversetarsal|ball)/, 'r_foot', 'r_ball'],
  ['pelvis', /^(root|body_world|c_spine0)$/, 'root', 'c_spine1'], ['torso', /^(c_spine[123]|c_neck|c_head|[lr]_clavicle)/, 'c_spine1', 'c_head'],
];
/**
 * The body's own skin for the flight planner (engine3d/ball-trajectory.mjs planBounce): the rig's legs and torso — the
 * same skin the clip sweep measures (legs: upleg … ball; torso: root, spine, neck, head, clavicles) — thinned to one
 * vertex per `voxel` (bind pose) and grouped by body part (its joint pair and its bind radius, for culling): skinned
 * only where a flight can reach (skinBodyParts). null: a rig with no mesh (the planner falls back to leg capsules).
 */
export function buildBodyContact(json, mrig, b64, { voxel = 0.025 } = {}) {
  try {
    const part = json?.parts?.[0];
    if (!part?.verts || !part.skinIdx || !part.skinW) return null;
    const V = b64(part.verts, Float32Array), SI = b64(part.skinIdx, Uint8Array), SW = b64(part.skinW, Float32Array);
    const n = V.length / 3, JI = mrig.JI;
    if (SI.length < n * 4 || SW.length < n * 4) return null;
    const groups = BODY_PARTS.map(([name, re, a, b]) => ({ name, re, a: JI[a], b: JI[b], ids: [], seen: new Set() })).filter((g) => g.a != null && g.b != null);
    for (let i = 0; i < n; i++) {
      let best = -1, bw = 0;
      for (let c = 0; c < 4; c++) if (SW[i * 4 + c] > bw) { bw = SW[i * 4 + c]; best = SI[i * 4 + c]; }
      const nm = mrig.names[best] || '', g = groups.find((q) => q.re.test(nm));
      if (!g) continue;
      const key = `${Math.floor(V[i * 3] / voxel)},${Math.floor(V[i * 3 + 1] / voxel)},${Math.floor(V[i * 3 + 2] / voxel)}`;
      if (g.seen.has(key)) continue;
      g.seen.add(key); g.ids.push(i);
    }
    const parts = groups.filter((g) => g.ids.length).map((g) => {
      const m = g.ids.length, v0 = new Float32Array(m * 3), si = new Uint8Array(m * 4), sw = new Float32Array(m * 4);
      const A = mrig.b[g.a], B = mrig.b[g.b], ab = sub(B, A), l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
      let r = 0;
      g.ids.forEach((i, k) => {
        for (let d = 0; d < 3; d++) v0[k * 3 + d] = V[i * 3 + d];
        for (let c = 0; c < 4; c++) { si[k * 4 + c] = SI[i * 4 + c]; sw[k * 4 + c] = SW[i * 4 + c]; }
        const p = [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], u = clamp(((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1] + (p[2] - A[2]) * ab[2]) / l2, 0, 1);
        r = Math.max(r, len(sub(p, add(A, sc(ab, u)))));
      });
      return { name: g.name, a: g.a, b: g.b, r, n: m, v0, si, sw };
    });
    return parts.length ? { voxel, parts, n: parts.reduce((s, p) => s + p.n, 0) } : null;
  } catch { return null; }
}
/**
 * The body skin (buildBodyContact) as posed by `mats`, only the parts whose bind capsule (with `slack`) reaches the box
 * [lo, hi]: [{ name, pts: Float32Array, n, lo, hi }] (world, the parts' own bounding boxes).
 */
export function skinBodyParts(BCt, mats, mrig, IK, lo, hi, skin, slack = 0.08) {
  const out = [];
  for (const P of BCt.parts) {
    const a = IK.jointPos(mats, mrig, P.a), b = IK.jointPos(mats, mrig, P.b), r = P.r + slack;
    let off = false;
    for (let d = 0; d < 3 && !off; d++) if (Math.min(a[d], b[d]) - r > hi[d] || Math.max(a[d], b[d]) + r < lo[d]) off = true;
    if (off) continue;
    const pts = skin(P.v0, P.si, P.sw, mats, new Float32Array(P.n * 3));
    const plo = [Infinity, Infinity, Infinity], phi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.n; k++) for (let d = 0; d < 3; d++) { const x = pts[k * 3 + d]; if (x < plo[d]) plo[d] = x; if (x > phi[d]) phi[d] = x; }
    out.push({ name: P.name, pts, n: P.n, lo: plo, hi: phi, src: P });
  }
  return out;
}
/**
 * Clearance (m) of a ball (centre p, radius R) from posed body parts (skinBodyParts) — +∞ when none is within `reach`
 * of it; out.q: the nearest skin point.
 */
export function bodyClearance(parts, p, R, reach = 0.25, out = null) {
  let best = Infinity, bi = -1, bq = null;
  for (const P of parts) {
    if (p[0] < P.lo[0] - R - reach || p[0] > P.hi[0] + R + reach || p[1] < P.lo[1] - R - reach || p[1] > P.hi[1] + R + reach || p[2] < P.lo[2] - R - reach || p[2] > P.hi[2] + R + reach) continue;
    const q = P.pts;
    for (let k = 0; k < P.n; k++) { const dx = q[k * 3] - p[0], dy = q[k * 3 + 1] - p[1], dz = q[k * 3 + 2] - p[2], d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) { best = d2; bi = k; bq = q; } }
  }
  if (out) out.q = bq ? [bq[bi * 3], bq[bi * 3 + 1], bq[bi * 3 + 2]] : null;
  return Number.isFinite(best) ? Math.sqrt(best) - R : Infinity;
}
/** Linear-blend skinning of a vertex set (as mhr-skin.mjs skinVerts — used when the session has no MS). */
function skinLBS(verts, skinIdx, skinW, mats, out) {
  const n = verts.length / 3;
  for (let v = 0; v < n; v++) {
    const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinW[v * 4 + k];
      if (!w) continue;
      const o = skinIdx[v * 4 + k] * 16;
      ox += w * (mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]); oy += w * (mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]); oz += w * (mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]);
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
  return out;
}
/** Clearance (m) of a ball from capsules [{ a, b, r }] (a rig with no mesh); out.q: the nearest capsule surface point. */
export function capsClearance(caps, p, R, out = null) {
  let best = Infinity, bq = null;
  for (const c of caps) {
    const ab = sub(c.b, c.a), u = clamp(((p[0] - c.a[0]) * ab[0] + (p[1] - c.a[1]) * ab[1] + (p[2] - c.a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9), 0, 1);
    const a = add(c.a, sc(ab, u)), dl = len(sub(p, a)), d = dl - c.r - R;
    if (d < best) { best = d; bq = add(a, sc(sub(p, a), c.r / Math.max(1e-6, dl))); }
  }
  if (out) out.q = bq;
  return best;
}

/**
 * The ball-aware move graph: for each controlling hand, every move (role / clip / mirror) that
 * can start from it and the hand it ends in. RIGHT CONTROL → right hesitation, right crossover → LEFT …
 */
export function buildMoveGraph(lib) {
  const g = { left: [], right: [] };
  for (const [key, vs] of Object.entries(lib)) {
    if (!key.endsWith(':variants')) continue;
    const role = key.slice(0, -9);
    if (!/^(move|shot)-/.test(role)) continue;
    for (const v of vs) for (const c of [v, v.mirrored].filter(Boolean)) {
      const entry = c.ballContacts?.entryHand || c.hand, exit = c.ballContacts?.exitHand || c.endHand;
      if (entry === 'left' || entry === 'right') g[entry].push({ role, clip: c.name, id: c.json?.id, mirror: !!c.mirror, entry, exit, shot: !!c.shot });
    }
  }
  return g;
}

/**
 * Locomotion dribbling profiles (docs/ball-contact-system.md → TRAJECTORY MODEL): how the bounce
 * spot moves off the animation's local bounce point with the body's LOCAL velocity — forward lead
 * when running (the ball goes out in front), a little outward when sliding, pulled in when
 * backpedalling. Deterministic, blended by speed. Values are metres per (m/s), clamped.
 */
export const DRIBBLE_PROFILES = {
  forward: { lead: 0.07, max: 0.28 },      // jog / sprint: ball ahead of the body
  backward: { lead: 0.03, max: 0.08 },     // backpedal: kept close (toward the body)
  lateral: { lead: 0.035, max: 0.1 },      // slide: toward the travel side
};

export class BallSession {
  /**
   * @param {object} o  { player, mhrRig, IK, phys?, cfg?, hoop?: { center, rimR }, log?, seed? (the shot rng),
   *                     handContact?: contact-ik buildHandContact() of this rig — the hands' own skin against the ball,
   *                     shotMeter?: engine3d/shot-meter.mjs ShotMeter — the button's timing grades the shot (else every shot is a make) }
   */
  constructor(o) {
    this.P = o.player; this.mrig = o.mhrRig; this.IK = o.IK; this.phys = o.phys || null; this.MS = o.MS || null;
    this.ctl = new BallController({ ...(o.cfg || {}), handSkin: !!o.handContact });
    this.hoop = o.hoop || { center: [0, 3.05, 0], rimR: 0.2286 };
    this.buffer = [];              // queued move requests { role, at, src }
    this.graph = null;
    this.t = 0;
    this.prevTargets = null;
    this.free = null;              // a shot / loose ball in the physics: { kind, t, bounces0 }
    this.stats = { requests: 0, fired: 0, dropped: 0, switches: 0, waited: 0, shots: 0, passes: 0, pickups: 0, makes: 0, misses: 0 };
    this.onEvent = o.onEvent || null;
    this.armScale = 1;
    this.legRadii = o.limbRadii || null;
    this.lastBody = null;
    this.trace = o.trace ? [] : null;
    this.rng = mulberry32(o.seed ?? 0x5eed);   // shot outcomes (a meter's "rim" grade): seeded, replayable
    this.shotInput = null;                      // the next shot's grade (setShotInput), consumed at its release
    this.lastShot = null;
    this.meter = o.shotMeter || null;           // the shot meter (its clock follows the shot clip; its grade picks the outcome)
    // the hands' own skin (contact-ik buildHandContact): the palm target clears the palm skin, and every
    // tick the palm rests on the ball, the fingers are out of it or (holding) on it — null: the joint passes
    // (the mesh data is shared; the scratch skin and the fingers' smoothing state are this session's own)
    const own = (H) => ({ ...H, pos: new Float32Array(H.pos.length), prevTh: new Float32Array(H.prevTh.length) });
    this.hc = o.handContact ? { l: own(o.handContact.l), r: own(o.handContact.r) } : null;
    // the body's own skin (buildBodyContact): every dribble's flight is planned clear of it (planFlight) — null: the
    // rig's leg capsules
    this.bodyContact = o.bodyContact || null;
    this.lastPlan = null;                       // the last flight plan (planFlight): its bounce, why, clearance, cost
    this.palmClear = { left: 0, right: 0 };    // how much further out the palm skin puts the ball (m, per hand)
    this.gripW = { left: 0, right: 0 };        // grip weight per hand (eased)
    this.pullW = { left: 0, right: 0 };        // a holding palm follows a ball moved off its target (eased)
    this.lastHands = null;                     // resolveHandBall() per hand, last tick
  }

  /** A palm target's clearance of this hand's palm skin (moves T.p out along T.n; T.p0 = the uncleared point). */
  clearPalm(mats, T, hand, R) {
    const e = this.hc ? this.IK.palmClearance(mats, this.hc[hand[0]], T.p, T.n, R, this.IK.HAND?.margin) : 0;
    T.p0 = T.p; T.clear = e;
    if (e > 0) T.p = add(T.p, sc(T.n, e));
    return T;
  }

  get state() { return this.ctl.state; }
  setGraph(lib) { this.graph = buildMoveGraph(lib); return this.graph; }

  // ── palm targets from the skeleton ──
  targets(mats, dt) {
    const out = {};
    // per-clip palm offsets (Contact Editor) for the clip playing now, else the defaults
    const off = this.P.ballSrc?.clip?.ballContacts?.offsets;
    const cfg = off ? { ...this.ctl.cfg, offsets: { ...this.ctl.cfg.offsets, ...off } } : this.ctl.cfg;
    for (const [s, hand] of [['l', 'left'], ['r', 'right']]) {
      const f = this.IK.palmFrame(mats, this.mrig, s);
      // (the ball against this hand's own palm skin, not a 1 cm palm)
      const T = this.clearPalm(mats, palmTarget(f, cfg, hand), hand, cfg.R);
      this.palmClear[hand] = T.clear;
      const prev = this.prevTargets?.[hand];
      T.v = prev && dt > 0 ? sc(sub(T.p, prev.p), 1 / dt) : [0, 0, 0];
      if (len(T.v) > 14) T.v = prev?.v || [0, 0, 0];   // a pose pop is not a hand speed
      out[hand] = T;
    }
    this.prevTargets = out;
    return out;
  }
  /** The arm length of this character (IK limits scale with it). */
  measureArms(mats) {
    const J = (n) => this.IK.jointPos(mats, this.mrig, this.mrig.JI[n]);
    const l = len(sub(J('l_lowarm'), J('l_uparm'))) + len(sub(J('l_wrist'), J('l_lowarm')));
    this.armLen = l; this.armScale = clamp(l / 0.62, 0.7, 1.4);
    return l;
  }

  /** Leg / foot capsules of the current pose (bounce clearance), with this rig's radii. */
  legCaps(mats) {
    const J = (n) => this.IK.jointPos(mats, this.mrig, this.mrig.JI[n]);
    const r = this.legRadii || { thigh: 0.07, shin: 0.05, foot: 0.045 };
    const caps = [];
    for (const s of ['l', 'r']) caps.push({ a: J(`${s}_upleg`), b: J(`${s}_lowleg`), r: r.thigh }, { a: J(`${s}_lowleg`), b: J(`${s}_foot`), r: r.shin }, { a: J(`${s}_foot`), b: J(`${s}_ball`), r: r.foot || 0.045 });
    return caps;
  }

  /** The Player's schedule with every event's WORLD point (palm targets shifted by the predicted palm motion). */
  worldSchedule(targets, mats) {
    const S = this.P.ballSchedule();
    const caps = mats ? this.legCaps(mats) : null;
    // inside a move, the next catch is predicted on the SKINNED hand (the move's captured rotations
    // put it up to ~15 cm off its keypoints): one extra skeleton solve for that frame
    const nextCatch = S.action && this.MS ? S.events.find((e) => e.type === 'catch' && e.in > 0.01 && e.in < 0.6 && e.hand) : null;
    for (const e of S.events) {
      if (e === nextCatch) {
        const W = this.P.actionPoseWorld(e.tt);
        if (W) {
          const m2 = this.tmpMats || (this.tmpMats = new Float32Array(this.mrig.n * 16));
          const src = this.P.ballSrc;
          this.MS.mhrBoneMatricesCaptured(W, this.mrig, [{ clip: src.clip, t: e.tt, w: 1 }], 1, m2);
          const off = src.clip?.ballContacts?.offsets;
          const cfg = off ? { ...this.ctl.cfg, offsets: { ...this.ctl.cfg.offsets, ...off } } : this.ctl.cfg;
          const tgt = (h) => this.clearPalm(m2, palmTarget(this.IK.palmFrame(m2, this.mrig, h[0]), cfg, h), h, cfg.R).p;
          if (e.hand === 'both') { const L = tgt('left'), Rt = tgt('right'); e.world = L.map((x, k) => (x + Rt[k]) / 2); } else e.world = tgt(e.hand);
          e.skinned = true;
          continue;
        }
      }
      if ((e.type === 'catch' || e.type === 'release') && e.palmAt && e.palmNow) {
        const T = this.ctl.targetOf(e.hand, targets);
        if (T) e.world = add(T.p, sub(e.palmAt, e.palmNow));
      } else if (e.type === 'bounce' && e.world && !S.action) {
        // locomotion profile: lead the bounce with the body's local velocity (not inside a move: a
        // move's own bounce points are authored)
        const P = this.P, c = Math.cos(P.yaw), sn = Math.sin(P.yaw);
        const vf = P.vel[0] * sn + P.vel[1] * c, vs = P.vel[0] * c - P.vel[1] * sn;   // forward / left
        const Fp = DRIBBLE_PROFILES, f = vf >= 0 ? clamp(vf * Fp.forward.lead, 0, Fp.forward.max) : -clamp(-vf * Fp.backward.lead, 0, Fp.backward.max);
        const l = clamp(vs * Fp.lateral.lead, -Fp.lateral.max, Fp.lateral.max);
        e.world = [e.world[0] + sn * f + c * l, e.world[1], e.world[2] + c * f - sn * l];
        e.profileLead = [+f.toFixed(3), +l.toFixed(3)];
      }
      if (e.type === 'bounce' && e.world) e.worldRaw = e.world.slice();   // (before the clearance below: the flight planner's own spot)
      if (e.type === 'bounce' && e.world && caps) {
        // constraint: the bounce spot never inside a leg / foot (the pose now; planted feet stay)
        const m = clearOfCaps([e.world[0], this.ctl.cfg.floorY + this.ctl.cfg.R, e.world[2]], caps, this.ctl.cfg.R, 0.015);
        if (m.shift > 0.001) { e.world = m.p; e.cleared = m.shift; }
      }
    }
    return S;
  }

  // ── input: move requests, the buffer and the move graph ──
  /**
   * A move / shot request (the input). It fires at the next valid window (see nextTrigger).
   * opts.src names the input it came from ('stick': the right stick); with opts.replace a newer request
   * from that input replaces its queued one (the latest gesture wins, one at a time — never a backlog).
   * opts.hand: the hand the ball was in when the input was read (the pro stick's combos are recognised against it
   * — fired later from the other hand a combo plays opts.degrade instead: the double crossover a crossover back, see
   * nextTrigger).
   */
  requestMove(role, t = this.t, opts = {}) {
    this.stats.requests++;
    if (opts.src && opts.replace) {
      const n = this.buffer.length;
      this.buffer = this.buffer.filter((b) => b.src !== opts.src);
      if (this.buffer.length < n) this.log(`input: a newer ${opts.src} request replaces the queued one`);
    }
    // (a full buffer pushes its oldest request out: dropped like any other — a queued shot's armed meter goes with it,
    // else the meter stays "armed" and swallows the next press)
    if (this.buffer.length >= 3) { const d = this.buffer.shift(); this.stats.dropped++; this.log(`input ${d.role} dropped (the buffer is full)`); this.dropped(d.role); }
    this.buffer.push({ role, at: t, src: opts.src || null, hand: opts.hand === 'left' || opts.hand === 'right' ? opts.hand : null, ...(opts.degrade !== undefined ? { degrade: opts.degrade } : {}) });
    this.log(`input ${role}${opts.src ? ' [' + opts.src + ']' : ''} (buffered)`);
  }
  requestHandSwitch() { const ok = this.P.requestHandSwitch(); if (ok) { this.stats.switches++; this.log('hand switch requested (crossover dribble)'); } return ok; }
  /**
   * The move to start now, if the head of the buffer is valid: the ball held by the move's entry
   * hand, the playing move inside its interruption window, not about to release. A move with no
   * clip for the holding hand first plays a crossover dribble to the other hand.
   * @returns {{ role: string, hand: string } | null}
   */
  nextTrigger(t = this.t) {
    const P = this.P;
    while (this.buffer.length && t - this.buffer[0].at > 1.2) { const d = this.buffer.shift(); this.stats.dropped++; this.log(`input ${d.role} dropped (no valid window in 1.2 s)`); this.dropped(d.role); }
    const req = this.buffer[0];
    if (!req) return null;
    if (!P.hasBall || P.ballFree || !this.ctl.controlled) return null;
    const holder = this.ctl.heldHand;
    const isShot = /^shot-/.test(req.role);
    if (!holder || (holder === 'both' && !isShot)) { this.stats.waited++; return null; }
    if (P.mode === 'action' && !P.canChain()) { this.stats.waited++; return null; }
    const S = this.lastSchedule;
    const rel = S?.events?.find((e) => e.type === 'release' && e.in >= 0);
    if (rel && rel.in < 0.06) { this.stats.waited++; return null; }
    const hand = holder === 'both' ? (P.hand || 'right') : holder;
    // a combo was recognised with the ball in req.hand (the double crossover: a crossover flick, then straight back):
    // if it waited (its first move could not be interrupted) and the other hand has the ball by now, its last step is
    // that hand's own move (req.degrade, read by the pro stick) — never the mirrored combo (left → right → left)
    if (req.hand && req.hand !== hand && (req.degrade !== undefined || req.role === 'move-double-cross')) {
      const to = req.degrade !== undefined ? req.degrade : 'move-crossover';
      if (req.role === 'move-double-cross' && to === 'move-crossover') this.log(`double crossover (recognised in the ${req.hand} hand) fires from the ${hand} hand: a crossover back`);
      else this.log(`${req.role} (recognised in the ${req.hand} hand) fires from the ${hand} hand: ${to || 'nothing'} instead`);
      if (!to) { this.buffer.shift(); this.stats.dropped++; this.dropped(req.role); return null; }
      req.role = to; req.hand = null; delete req.degrade;   // (read once: a wait after this does not read it again)
    }
    if (!P.hasMoveFor(req.role, hand)) {
      if (P.hasMoveFor(req.role, other(hand))) {
        if (P.mode === 'loco' && !P.switchPending) { this.requestHandSwitch(); this.log(`${req.role} starts in the ${other(hand)} hand: crossover first`); }
        this.stats.waited++;
        return null;
      }
      this.buffer.shift(); this.stats.dropped++; this.log(`input ${req.role}: no clip`); this.dropped(req.role);
      return { missing: req.role };
    }
    this.buffer.shift(); this.stats.fired++;
    this.log(`${req.role} fires (${hand} hand)`);
    return { role: req.role, hand };
  }

  /** A request that will never fire: a shot's armed meter goes away with it. */
  dropped(role) { if (/^shot-/.test(role)) this.meter?.cancel(); this.onEvent?.({ type: 'dropped', role, t: this.t }); }

  // ── possession changes ──
  /**
   * The shot meter's grade for the NEXT release (engine3d/shot-flight.mjs outcomeFor / planShot):
   * { quality: 0…1, timing: 'early' | 'late' | 'perfect' } or an explicit { outcome }. No input: a make.
   */
  setShotInput(x) { this.shotInput = x ? { ...x } : null; }
  /** The playing shot's timing (the hold fit's launch pocket): null outside a shot. */
  shotContext() {
    const a = this.P.action, sh = a?.clip?.shot;
    if (!sh) return null;
    const releaseIn = Math.max(0, (sh.releaseFrame - a.t) / a.clip.fps);
    const plan = planShot({ from: this.ctl.p, hoop: this.hoop, outcome: 'make', cfg: this.shotCfg() });
    return { releaseIn, prefer: norm(plan.v0) };
  }
  shotCfg() { const ph = this.phys; return { g: ph?.cfg?.gravity ?? 9.81, drag: ph?.cfg?.linearDamping ?? 0, R: this.ctl.cfg.R }; }

  /** A new possession: the ball on the palm of the hand the animation dribbles with. */
  reset(mats, t = this.t) {
    const P = this.P;
    P.giveBall(); P.syncDribbleToCatch();
    this.gripW = { left: 0, right: 0 }; this.pullW = { left: 0, right: 0 }; this.palmClear = { left: 0, right: 0 }; this.lastHands = null;
    if (this.hc) for (const s of ['l', 'r']) { this.hc[s].prevTh.fill(0); this.hc[s].prevSp?.fill(0); }
    this.snapHands = true;   // (the new possession's hand holds the ball at once: its next pass is not eased)
    const targets = this.targets(mats, 0);
    const hand = P.hand || 'right';   // the dribbling hand (syncDribbleToCatch put its idle in a hold)
    if (this.phys) this.phys.suspend?.();   // (suspend also makes the body solid again after a shot)
    this.free = null; this.buffer = [];
    this.meter?.reset();
    this.ctl.giveBall(hand === 'both' ? (P.hand || 'right') : hand, targets, t);
    this.log(`new possession (${hand})`);
  }
  /** Debug: the ball dropped / thrown (LOOSE, physics). */
  drop(p, v = [0, 0, 0], w = [0, 0, 0], t = this.t) {
    const P = this.P;
    P.hasBall = false; P.ballFree = true;
    this.ctl.toPhysics('LOOSE', 'dropped', t);
    this.ctl.syncPhysics(p, v, [0, 0, 0, 1], w);
    this.phys?.resume?.(p, v, w, this.lastBody);
    this.phys?.setBodyCollision?.(true);
    this.free = { kind: 'loose', t: 0 };
  }

  /**
   * One tick, after the Player updated and the skeleton was posed (bone matrices = the animation
   * pose, before IK).
   * @param {number} t   game time
   * @param {number} dt  tick length
   * @param {object} r   Player.update result (events)
   * @param {Float32Array} mats  bone matrices (IK is applied to them here)
   * @param {object} [body]  physics body sample of this pose (BP.bodySampleFromJoints), for LOOSE / shots
   */
  step(t, dt, r, mats, body = null) {
    const P = this.P, C = this.ctl, ph = this.phys;
    this.t = t;
    if (!this.armLen) this.measureArms(mats);
    const targets = this.targets(mats, dt);
    const S = this.worldSchedule(targets, mats);
    this.lastSchedule = S; this.lastTargets = targets;
    if (body) this.lastBody = body;
    // the shot meter follows the shot clip's clock (a shot starting, the button held past the late zone)
    if (this.meter) meterAfterUpdate(this.meter, r?.events, P, t);
    // gameplay events from the animation
    const releaseNow = (r?.events || []).some((e) => e.type === 'release');
    for (const e of r?.events || []) if (e.type === 'handSwitch') this.log(`idle → ${e.hand} hand`);
    // the hands hold the ball this tick (clear of them, a shot on its launch side) …
    C.update(t, dt, { targets, schedule: S, player: { pos: P.pos, vel: P.vel, yaw: P.yaw }, obstacles: this.legCaps(mats), hands: body || this.lastBody, shot: this.shotContext(), planFlight: (req) => this.planFlight(req, mats) });
    // … and a shot leaves from exactly there (this tick's hands, not last tick's ball); its flight
    // starts next tick (this tick draws the ball where the hands let go of it)
    const shotNow = releaseNow && C.controlled;
    if (shotNow) this.shoot(t, targets, body || this.lastBody);
    const out = C.out();
    // ownership wins over the animation: if the dribble animation plays the other hand while the ball
    // is held (a hand change the ball never made), the animation conforms to the ball
    const holder = C.heldHand;
    if (holder && holder !== 'both' && P.mode === 'loco' && S.hand && S.hand !== 'both' && S.hand !== holder && !P.switchPending) {
      this.mismatchFor = (this.mismatchFor || 0) + dt;
      if (this.mismatchFor > 0.25) { if (P.setHand(holder)) { P.syncDribbleToCatch(); this.log(`animation hand ${S.hand} ≠ ball in ${holder}: the animation follows the ball`); } this.mismatchFor = 0; }
    } else this.mismatchFor = 0;
    for (const e of out.events) {
      if (e.type === 'catch') { if (!P.hasBall || P.ballFree) { P.giveBall(); P.syncDribbleToCatch(); } P.caught?.(); }
      if (e.type === 'recovery') this.log(`recovery: ${e.reason}`);
      this.onEvent?.(e);
    }
    // physics: only when nobody controls the ball
    if (C.physics && ph) {
      if (!shotNow) {
        ph.advance(dt, ph.lastSample || body, body, { has: false }, { has: false });
        const rs = ph.renderState(1);
        C.syncPhysics(rs.p, rs.v, rs.q, rs.w);
        this.freeBall(t, dt, targets, body || this.lastBody);
      }
    } else if (ph && !ph.suspended) ph.suspend?.();
    // IK: the last centimetres, never a stretch; a knee still in the ball's way yields (≤ 5 cm)
    this.applyIk(mats);
    if (C.controlled) this.yieldLegs(mats, dt); else if (this.yieldOff) this.yieldOff = null;
    // the hands' own skin against the ball where it is drawn this tick (every state: a shot's hands
    // let go of it, a free hand never passes through it)
    if (this.hc) this.resolveHands(mats, dt);
    if (this.trace) this.trace.push({ t, s: C.state, p: C.p.slice(), hand: S.hand, tl: targets.left.p, tr: targets.right.p });
    return C.out();
  }

  /**
   * A dribble's flight (the controller's release: hand → floor → hand), planned from the motion and clear of the body as
   * it will be during the flight (ball-trajectory.mjs planBounce): inside a move its own future pose (the skeleton
   * solved at each 1/120 s of the flight, the move's root motion), the dribble layer its pose now. The body is the rig's
   * own skin (bodyContact, only the parts a flight can reach), else its leg capsules; the feet give the gate between
   * the legs.
   * @param {object} req  the controller's request (planBounce's o, without the body)
   * @param {Float32Array} mats  this tick's bone matrices (the animation pose, before IK)
   */
  planFlight(req, mats) {
    const R = this.ctl.cfg.R, floorY = this.ctl.cfg.floorY, P = this.P, src = P.ballSrc;
    const xs = [req.pr[0], req.pc[0], req.pb[0]], zs = [req.pr[2], req.pc[2], req.pb[2]];
    // (the body a flight can reach: the hands', the contact's spot and the spots tried around it (planBounce reach),
    // from the floor to just above the hands)
    const lo = [Math.min(...xs) - 0.42, floorY - 0.05, Math.min(...zs) - 0.42], hi = [Math.max(...xs) + 0.42, Math.max(req.pr[1], req.pc[1]) + 0.15, Math.max(...zs) + 0.42];
    // (the body every 1/60 s of the flight — it moves ≤ 2–3 cm in that time; the path is checked every 1/120 s)
    const h = 1 / 60, N = Math.max(1, Math.ceil((req.tc - req.tr) / h) + 1), cache = new Array(N + 1);
    const JI = this.mrig.JI, J = (m, j) => this.IK.jointPos(m, this.mrig, j);
    const skin = this.MS?.skinVerts || skinLBS;
    const FEET = ['l_foot', 'l_ball', 'r_foot', 'r_ball', 'l_upleg', 'r_upleg'].map((n) => JI[n]);
    // the body as DRAWN now: the parts a flight can reach (skinned), else the leg capsules
    const live = this.bodyContact ? skinBodyParts(this.bodyContact, mats, this.mrig, this.IK, lo, hi, skin, 0.15) : null;
    const box = (pts) => { const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity]; for (let j = 0; j < pts.length; j++) { const d = j % 3; if (pts[j] < a[d]) a[d] = pts[j]; if (pts[j] > b[d]) b[d] = pts[j]; } return [a, b]; };
    // how it moves on: a move — its own future pose (the skeleton solved at that clip time, the move's root motion),
    // offset by how the drawn body differs from the clip's own now (planted feet held, the legs solved to them); the
    // dribble layer — its pose now (where its legs will swing is not known ahead: trusted less, and the flight's own
    // leg clearance steers around them as they come). Lazily: a sample's skeleton when a flight reaches its time, a
    // part's skin when a flight comes near that part.
    const ahead = !!(P.mode === 'action' && src?.rootSpace && this.MS && P.actionPoseWorld);
    const fpsNow = src?.fpsNow || src?.clip?.fps || 30, F = src?.clip?.F || 1;
    const clipMats = (tt) => { tt = Math.max(0, Math.min(F - 1, tt)); const W = P.actionPoseWorld(tt); if (!W) return null; const m = new Float32Array(this.mrig.n * 16); this.MS.mhrBoneMatricesCaptured(W, this.mrig, [{ clip: src.clip, t: tt, w: 1 }], 1, m); return m; };
    const baseM = ahead ? clipMats(src.t) : null;
    const nowFeet = FEET.map((j) => J(mats, j)), feetOff = baseM ? FEET.map((j, i) => sub(nowFeet[i], J(baseM, j))) : null;
    const offs = [];   // per live part: drawn now − the clip's own now (lazily)
    const offOf = (i) => offs[i] || (offs[i] = (() => { const b = skin(live[i].src.v0, live[i].src.si, live[i].src.sw, baseM, new Float32Array(live[i].n * 3)); for (let j = 0; j < b.length; j++) b[j] = live[i].pts[j] - b[j]; return b; })());
    const nowS = { m: mats, now: true, parts: live ? live.map((Q) => ({ pts: Q.pts, lo: Q.lo, hi: Q.hi })) : null, caps: live ? null : this.legCaps(mats), feet: nowFeet };
    const sample = (k) => {
      k = Math.max(0, Math.min(N, k));
      if (!ahead || !baseM || k === 0) return nowS;
      if (cache[k]) return cache[k];
      const m = clipMats(src.t + (req.tr + k * h - this.t) * fpsNow);
      if (!m) return (cache[k] = nowS);
      const S = { m, parts: live ? new Array(live.length) : null, caps: live ? null : this.legCaps(m).map((c, i) => ({ ...c, a: add(c.a, sub(nowS.caps[i].a, this.legCaps(baseM)[i].a)), b: add(c.b, sub(nowS.caps[i].b, this.legCaps(baseM)[i].b)) })), feet: FEET.map((j, i) => add(J(m, j), feetOff[i])) };
      return (cache[k] = S);
    };
    const partOf = (S, i) => {
      if (S.parts[i]) return S.parts[i];
      const pts = skin(live[i].src.v0, live[i].src.si, live[i].src.sw, S.m, new Float32Array(live[i].n * 3)), o = offOf(i);
      for (let j = 0; j < pts.length; j++) pts[j] += o[j];
      const [a, b] = box(pts);
      return (S.parts[i] = { pts, lo: a, hi: b });
    };
    const at = (t) => sample(Math.round((t - req.tr) / h));
    // (exact within 6 cm of the body — beyond, "clear" is all a plan needs to know)
    const reach = 0.06;
    // (a floor contact also keeps clear of the leg capsules the flight's own reactive clearance steers by: the foot's
    // is a tube round the heel → toe line, fuller than the foot — a contact inside it would be pushed off its spot)
    const capsNow = this.legCaps(mats), capsBase = baseM ? this.legCaps(baseM) : null;
    const capsAt = (S) => S.legs || (S.legs = S.now || !capsBase ? capsNow : this.legCaps(S.m).map((c, i) => ({ ...c, a: add(c.a, sub(capsNow[i].a, capsBase[i].a)), b: add(c.b, sub(capsNow[i].b, capsBase[i].b)) })));
    const legMargin = this.ctl.cfg.legMargin;
    const clearAt = (t, p, out = null) => {
      const S = at(t);
      if (live && p[1] < floorY + R + 0.01) { const o2 = out ? {} : null, a = clearAtSkin(S, p, out), b = capsClearance(capsAt(S), p, R, o2) - legMargin; if (b < a) { if (out) out.q = o2.q; return b; } return a; }
      return clearAtSkin(S, p, out);
    };
    const clearAtSkin = (S, p, out = null) => {
      if (!live) return capsClearance(S.caps, p, R, out);
      let best = Infinity, bq = null, bi = -1;
      const px = p[0], py = p[1], pz = p[2], far = R + reach;
      for (let i = 0; i < live.length; i++) {
        // (a part far from the ball at this pose — its bind capsule there — is not skinned)
        if (!S.now) {
          const cj = S.cj || (S.cj = []), C = cj[i] || (cj[i] = [J(S.m, live[i].src.a), J(S.m, live[i].src.b)]), a = C[0], b = C[1];
          const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], u = clamp(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / ((abx * abx + aby * aby + abz * abz) || 1e-9), 0, 1);
          if (Math.hypot(px - a[0] - abx * u, py - a[1] - aby * u, pz - a[2] - abz * u) > live[i].src.r + 0.1 + far) continue;
        }
        const Q = S.now ? S.parts[i] : partOf(S, i);
        if (px < Q.lo[0] - far || px > Q.hi[0] + far || py < Q.lo[1] - far || py > Q.hi[1] + far || pz < Q.lo[2] - far || pz > Q.hi[2] + far) continue;
        const q = Q.pts, n = live[i].n;
        for (let k = 0; k < n; k++) { const dx = q[k * 3] - px, dy = q[k * 3 + 1] - py, dz = q[k * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) { best = d2; bq = q; bi = k; } }
      }
      if (out) out.q = bq ? [bq[bi * 3], bq[bi * 3 + 1], bq[bi * 3 + 2]] : null;
      return Number.isFinite(best) ? Math.sqrt(best) - R : Infinity;
    };
    const feetAt = (t) => { const f = at(t).feet; return { l: [(f[0][0] + f[1][0]) / 2, (f[0][2] + f[1][2]) / 2], r: [(f[2][0] + f[3][0]) / 2, (f[2][2] + f[3][2]) / 2], h: [(f[4][0] + f[5][0]) / 2, (f[4][2] + f[5][2]) / 2] }; };
    const plan = planBounce({ ...req, clearAt, feetAt, trust: ahead ? 1 : 0.25 });
    this.lastPlan = plan ? { t: this.t, pb: plan.pb, tb: plan.tb, why: plan.why, gate: plan.gate, clearance: plan.clearance, cost: plan.cost, checked: plan.checked, prior: req.pb.slice(), clearAt } : null;
    return plan;
  }

  /**
   * The shot leaves the hands from where the ball is this tick (fitted clear of them, on its
   * launch side): the arc to the rim (engine3d/shot-flight.mjs — a make unless the meter's grade
   * says otherwise), started clear of the body, with the ball ↔ body contacts off until it is
   * clear of the thrower (the physics would otherwise swallow the throw in the hands it leaves).
   * The outcome: an explicit setShotInput, else the shot meter's grade — known when the button came
   * up before this frame: the flight its timing calls for (aimOf: dz / pitch — the clean swish's heading, the launch
   * speed / angle off by the timing error); still held: the clean swish, steered in the air to the late flight once
   * it is held past the green window (freeBall → lateGrade) — else a make.
   */
  shoot(t, targets, body = this.lastBody) {
    const C = this.ctl, ph = this.phys;
    const mi = this.meter?.atLaunch(t) ?? null;
    const input = this.shotInput || (mi ? { outcome: mi.outcome, dz: mi.dz, pitch: mi.pitch || 0 } : { outcome: 'make' });
    const provisional = !this.shotInput && !!mi?.provisional;
    this.shotInput = null;
    const holding = C.heldHand;
    let from = C.p.slice();
    const draws = [], rng = () => { const x = this.rng(); draws.push(x); return x; };
    let plan = planShot({ from, hoop: this.hoop, ...input, rng, cfg: this.shotCfg() });
    let swept = 0;
    if (body) {
      // a release point still touching the rigid hand (the fit eases in: a centimetre behind) starts
      // just clear of it — the smallest move, biased to the launch side; only if that fails, along
      // the launch (a grazing launch along the palm is the ball rolling off it: not an obstacle,
      // the ball ↔ body contacts are off until it is clear)
      const R = C.cfg.R, cols = handColliders(body, holding);
      if (clearance(from, cols, R) < 0) {
        const fit = fitBallToHands(from, body, R, { holding, prefer: norm(plan.v0), preferWeight: 0, cols });
        const to = fit.ok ? fit.p : sweepClear(from, plan.v0, body, R, { holding, cols }).p;
        swept = len(sub(to, from)); from = to;
        let k = 0; const replay = () => (k < draws.length ? draws[k++] : this.rng());
        plan = planShot({ from, hoop: this.hoop, ...input, outcome: plan.outcome, rng: replay, cfg: this.shotCfg() });
      }
    }
    C.toPhysics('SHOT_RELEASE', `shot release → ${plan.outcome}`, t);
    C.p = from.slice(); C.v = plan.v0.slice(); C.w = plan.w0.slice();
    this.stats.shots++;
    this.free = { kind: 'shot', t: 0, bounces0: ph?.stats?.bounces ?? 0, through: false, plan, ghost: !!ph, prevP: from.slice(), provisional, steer: null, reported: false };
    if (ph) {
      ph.resume?.(from, plan.v0, plan.w0, body);
      ph.setBodyCollision?.(false);
      ph.throwBall(plan.v0, holding === 'left' || holding === 'right' ? holding : 'both');
      ph.touchedSince?.clear();   // (what this shot touches: the result — a swish touches nothing)
    }
    const graded = mi && !mi.provisional ? { label: mi.label, grade: mi.grade, e: mi.e, make: mi.make, outcome: mi.outcome } : null;
    this.lastShot = { outcome: plan.outcome, aim: plan.aim, T: plan.T, v0: plan.v0, w0: plan.w0, apexY: plan.apexY, entryDeg: plan.entryDeg, from, swept, t, input, through: false, minRimDist: Infinity, maxY: from[1], meter: graded, provisional, result: null };
    this.log(`shot → ${plan.outcome}${graded ? ` (${graded.label})` : provisional ? ' (the button is still held: graded in the air)' : ''} (T ${plan.T.toFixed(2)} s, entry ${plan.entryDeg.toFixed(0)}°, apex ${plan.apexY.toFixed(2)} m${swept ? `, launched ${(swept * 100).toFixed(1)} cm clear of the hands` : ''})`);
    this.onEvent?.({ type: 'shot', t, outcome: plan.outcome, aim: plan.aim, T: plan.T, meter: graded, provisional });
    void targets;
  }

  /** Shots settle → a controlled pass back; a loose ball is picked up (a hand near a slow ball) or scooped. */
  freeBall(t, dt, targets, body = this.lastBody) {
    const f = this.free, C = this.ctl, ph = this.phys, P = this.P;
    if (!f) return;
    f.t += dt;
    const p = C.p, v = C.v, sp = len(v);
    if (f.kind === 'shot') {
      // the thrower's body is solid again once the ball is clear of it (or after half a second)
      if (f.ghost && (f.t > 0.5 || (f.t > 0.05 && body && clearance(p, handColliders(body, null), C.cfg.R) > 0.03))) { ph.setBodyCollision?.(true); f.ghost = false; }
      // a grade that came after the launch (the button let go late): the flight bends to it
      if (f.provisional) this.lateGrade(f);
      if (f.steer && !f.steer.done) this.steer(f, dt);
      // the result (the meter shows it): through the ring downward, closest to the rim's centre, apex
      const L = this.lastShot, c = this.hoop.center;
      if (L) {
        L.maxY = Math.max(L.maxY, p[1]);
        L.minRimDist = Math.min(L.minRimDist, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
        if (!L.through && f.prevP && f.prevP[1] > c[1] && p[1] <= c[1] && Math.hypot(p[0] - c[0], p[2] - c[2]) < this.hoop.rimR - 0.03) L.through = true;
        if (L.through && !f.reported) this.shotResult(f, t, true);
        // (below the rim and falling, not through: it can no longer go in)
        else if (!f.reported && f.t > 0.3 && v[1] < 0 && p[1] < c[1] - 0.35) this.shotResult(f, t, false);
      }
      f.prevP = p.slice();
      const settled = ph.state === 'FREE' || ph.stats.bounces - (f.bounces0 ?? 0) >= 3 || f.t > 4.5;
      if (settled) { if (!f.reported) this.shotResult(f, t, !!L?.through); this.passBack(t, targets); }
      return;
    }
    if (f.kind === 'loose' && f.t > 0.35 && sp < 3.5) {
      for (const h of ['left', 'right']) {
        const T = targets[h];
        if (T && len(sub(T.p, p)) < 0.28) { this.pickup(h, t, targets, 0.1); return; }
      }
      const dh = Math.hypot(p[0] - P.pos[0], p[2] - P.pos[1]);
      if (dh < 0.6 && p[1] < 0.6) this.pickup(P.hand || 'right', t, targets, 0.35);
    }
  }
  /**
   * The shot left with the button still held (a provisional swish): held past the green window, the flight bends to
   * the late flight the timing so far calls for (meter.lateNow — later = harder: the back of the rim, then off the
   * glass), and to the final one when the button comes up. It is steered to that flight's own point short of the
   * glass (shot-flight lateFlight), so it meets the rim / the glass as that flight does; nothing touched yet.
   */
  lateGrade(f) {
    const late = this.meter?.lateNow?.();
    if (!late) return;
    const L = this.lastShot, ph = this.phys;
    if (late.final) {
      f.provisional = false;
      if (L) L.meter = { label: late.label, grade: late.grade, e: late.e, make: late.make, outcome: late.outcome };
    }
    const touched = ph?.touchedSince?.has('rim') || ph?.touchedSince?.has('board');
    if (late.outcome === 'swish' || !L || touched) return;
    const key = `${late.outcome}:${late.dz.toFixed(4)}:${late.pitch || 0}`;
    if (f.steer?.key === key) return;
    const W = lateFlight({ from: L.from, hoop: this.hoop, outcome: late.outcome, dz: late.dz, pitch: late.pitch || 0, cfg: this.shotCfg() });
    if (f.t > W.T - this.meter.cfg.steerStop) return;   // (too late to bend: it flies on)
    f.steer = { key, aim: W.aim, T: W.T, accel: this.meter.cfg.steerAccel, stop: this.meter.cfg.steerStop, t0: f.steer?.t0 ?? f.t, dv: f.steer?.dv || 0 };
    f.plan = { ...f.plan, aim: W.plan.aim, seg: W.plan.seg };   // (Ball Debug Mode draws the late flight)
    if (L.outcome !== late.outcome) this.log(`late release (${late.final ? late.label : `held ${Math.round(late.e * 1000)} ms`}) → the flight bends to ${late.outcome} (+${f.t.toFixed(2)} s)`);
    L.outcome = late.outcome; L.aim = W.aim; L.reaimed = { t: +f.steer.t0.toFixed(3), outcome: late.outcome, dz: +late.dz.toFixed(3) };
  }
  /** Steering to f.steer.aim, arriving when the late flight is there (≤ accel m/s², a bend; off once the rim / glass is touched). */
  steer(f, dt) {
    const ph = this.phys, S = f.steer;
    if (!ph || ph.touchedSince?.has('rim') || ph.touchedSince?.has('board') || f.t > S.T - S.stop) { if (this.lastShot?.reaimed) this.lastShot.reaimed.dv = +S.dv.toFixed(3); f.steer = { ...S, done: true }; return; }
    if (S.done) return;
    const v = ph.vel, need = ph.ballisticTo(S.aim, Math.max(S.stop, S.T - f.t)), dv = sub(need, v), l = len(dv);
    if (l < 0.005) return;
    const k = Math.min(1, (S.accel * dt) / l);
    ph.impartVelocity(add(v, sc(dv, k)));
    S.dv += l * k;
    if (this.lastShot?.reaimed) this.lastShot.reaimed.dv = +S.dv.toFixed(3);
  }
  /** The shot's result, once: made (through the ring) or not — the meter shows it, the court flashes the net. */
  shotResult(f, t, made) {
    f.reported = true; f.through = made;
    const touched = [...(this.phys?.touchedSince || [])].filter((n) => !this.phys?.parts?.has(n));
    if (made) this.stats.makes++; else this.stats.misses++;
    if (this.lastShot) this.lastShot.result = { made, touched, t };
    this.meter?.onResult({ made, touched });
    this.log(`shot ${made ? 'made' : 'missed'}${touched.length ? ` (touched ${touched.join(', ')})` : ''}`);
    this.onEvent?.({ type: made ? 'make' : 'shotEnd', made, touched, t, outcome: this.lastShot?.outcome });
  }
  pickup(hand, t, targets, T) {
    const at = add(targets[hand].p, sc(targets[hand].v || [0, 0, 0], T));
    this.P.receive?.(hand);
    this.ph_suspend();
    this.ctl.pass(hand, at, t + T, t, 'pick-up');
    this.free = null; this.stats.pickups++;
    this.log(`pick-up (${hand})`);
  }
  /** The rebounder passes it back: a controlled pass that meets the player's hand. */
  passBack(t, targets) {
    const P = this.P, hand = P.hand || 'right';
    P.receive?.(hand);   // ready hands (the follow-through ends): the pass is aimed at them
    const T0 = targets[hand];
    const d = Math.hypot(T0.p[0] - this.ctl.p[0], T0.p[2] - this.ctl.p[2]);
    const T = clamp(d / 6, 0.55, 1.2);
    const at = [T0.p[0] + P.vel[0] * T, T0.p[1], T0.p[2] + P.vel[1] * T];
    this.ph_suspend();
    this.ctl.pass(hand, at, t + T, t, 'pass back');
    this.free = null; this.stats.passes++;
    this.onEvent?.({ type: 'pass', t, T });
  }
  ph_suspend() { if (this.phys) this.phys.suspend?.(); }

  /** Weighted, limited contact IK toward the ball (the controlling / receiving hand). */
  applyIk(mats) {
    const C = this.ctl, w = C.ik, c = C.cfg;
    const hands = ['left', 'right'].filter((h) => w[h] > 0.001).sort((a, b) => w[b] - w[a]);
    if (!hands.length || !C.controlled) return null;
    const ctl = { hand: hands[0], weight: w[hands[0]], other: hands[1] || null, otherWeight: hands[1] ? w[hands[1]] : 0, grip: isHeld(C.state), reachMax: c.maxHandCorrection * this.armScale, reachLimit: 0.14 * this.armScale };
    // (with the hand's skin: the palm meets the ball where its own skin does, and the fingers are left to resolveHands)
    const pt = this.hc ? { left: c.palmThickness + this.palmClear.left, right: c.palmThickness + this.palmClear.right } : c.palmThickness;
    const cfg = { ikStrength: 1, ikMax: c.maxHandCorrection * this.armScale, ikAimMax: c.maxWristRotation, palmThickness: pt, skinContact: !!this.hc, radii: { finger: 0.0095 }, ikReach: 0.14 * this.armScale, maxElbow: c.maxElbowCorrection, maxExtend: c.maxExtension };
    return (this.lastIk = this.IK.contactPass(mats, this.mrig, { p: C.p, R: c.R }, ctl, cfg, null));
  }

  /**
   * The hands' own skin against the ball (contact-ik resolveHandBall), after IK, before skinning:
   * the palm rests on it, no finger is inside it, and the hand that holds (or is catching) it grips
   * it — from the moment the ball flies to it; a holding palm that is off the ball reaches back onto
   * it (not while the ball is fitted off the hands' targets). Grip and pull ease in and out (≤ gripRate
   * per second); a new possession grips at once.
   */
  resolveHands(mats, dt) {
    if (this.snapHands) { this.snapHands = false; dt = 0; }
    // (the receiving hand grips from the moment the ball flies to it: the grip only turns a phalanx
    // that is near the ball's surface, so it acts as the ball arrives — the fingers are on it when the
    // palm is, not still opening a grip that ramps in after the contact)
    const C = this.ctl, held = C.heldHand, catching = /^(CATCH_|DRIBBLE_UP_)/.test(C.state) || C.state === 'PASS_RELEASE' ? C.flight?.toHand : null;
    const rate = (this.IK.HAND?.gripRate ?? 10) * Math.max(0, dt);
    const ease = (x, want) => (dt > 0 ? clamp(x + clamp(want - x, -rate, rate), 0, 1) : want);
    const out = {};
    // (no pull while the ball is fitted off the hands' targets — a two-hand hold squeezed by the capture, a
    // shot's launch pocket: pulling a palm onto it there drives the fingers into the ball, the arm pushes back)
    const fitted = !!C.fitOff && len(C.fitOff) > 0.01;
    // a hand about to catch (the flight lands on it within preShape s) shapes its grip around where the ball will
    // sit on it — its palm target as drawn now — so its fingers are on the ball when it arrives, never flicked out
    // of it the tick it lands
    const tau = C.flight?.tc != null ? C.flight.tc - this.t : Infinity;
    const off = this.P.ballSrc?.clip?.ballContacts?.offsets, tcfg = off ? { ...C.cfg, offsets: { ...C.cfg.offsets, ...off } } : C.cfg;
    for (const [s, side] of [['l', 'left'], ['r', 'right']]) {
      const holds = held === side || held === 'both';
      this.gripW[side] = ease(this.gripW[side], holds || catching === side ? 1 : 0);
      this.pullW[side] = ease(this.pullW[side], holds && !fitted ? 1 : 0);
      let gripBall = null;
      if (!holds && catching === side && tau <= (this.IK.HAND?.preShape ?? 0.12)) {
        // (as the ball comes within 5 cm of that place, the shape follows it onto the ball itself — continuously:
        // a switch from one sphere to the other redistributes the curl between the joints in one tick)
        const Tp = this.clearPalm(mats, palmTarget(this.IK.palmFrame(mats, this.mrig, s), tcfg, side), side, C.cfg.R).p;
        const d = len(sub(C.p, Tp)), w = clamp(1 - d / 0.05, 0, 1), k = w * w * (3 - 2 * w);
        gripBall = { p: add(Tp, sc(sub(C.p, Tp), k)), R: C.cfg.R };
      }
      // (… and never into the ball's way in: the curl stays out of where the flight still takes it)
      if (gripBall) {
        const fl = C.flight, seg = fl && (fl.toss || (this.t > (fl.tb ?? -Infinity) ? fl.up : null));
        gripBall.avoid = seg ? [1, 2, 3, 4].map((k) => segPos(seg, Math.min(fl.tc, this.t + (tau * k) / 4))) : [];
      }
      out[side] = this.IK.resolveHandBall(mats, this.mrig, this.hc[s], s, { p: C.p, R: C.cfg.R }, { grip: this.gripW[side], pull: this.pullW[side], pullMax: (this.IK.HAND?.pullMax ?? 0) * this.armScale, clear: this.palmClear[side], dt, reachArm: this.IK.reachArm, gripBall });
    }
    return (this.lastHands = out);
  }

  /**
   * Knee yield: a leg the (controlled) ball still overlaps moves its knee away (≤ 5 cm, hip and ankle fixed) — by how
   * deep the ball is in that leg's own skin (bodyContact; else its capsules). The yield goes out at once (the ball needs
   * it) and eases back (40 ms half-life) when the ball has passed.
   */
  yieldLegs(mats, dt = 1 / 60) {
    const C = this.ctl, R = C.cfg.R, p = C.p;
    const r = this.legRadii || { thigh: 0.07, shin: 0.05 };
    const J = (n) => this.IK.jointPos(mats, this.mrig, this.mrig.JI[n]);
    const parts = this.bodyContact ? skinBodyParts(this.bodyContact, mats, this.mrig, this.IK, p.map((x) => x - R - 0.1), p.map((x) => x + R + 0.1), this.MS?.skinVerts || skinLBS, 0.03).filter((Q) => /_(thigh|shin)$/.test(Q.name)) : null;
    this.yieldOff = this.yieldOff || { l: [0, 0, 0], r: [0, 0, 0] };
    const k = 1 - Math.exp((-0.6931 * Math.max(0, dt)) / 0.04);
    for (const s of ['l', 'r']) {
      const hip = J(`${s}_upleg`), knee = J(`${s}_lowleg`), ank = J(`${s}_foot`);
      let worst = null;
      for (const [a, b, rr] of [[hip, knee, r.thigh], [knee, ank, r.shin]]) {
        const ab = sub(b, a), u = clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9), 0, 1);
        const q = add(a, sc(ab, u)), d = sub(q, p), dl = len(d), pen = rr + R + 0.004 - dl;
        if (dl > 1e-6 && (!worst || pen > worst.pen)) worst = { pen, n: sc(d, 1 / dl) };
      }
      // (the skin: the deepest of this leg's thigh / shin points in the ball, + 4 mm — where it is deeper than the capsule)
      if (parts && worst) {
        let pen = -Infinity;
        for (const Q of parts) if (Q.name[0] === s) for (let i = 0; i < Q.n; i++) pen = Math.max(pen, R + 0.004 - Math.hypot(Q.pts[i * 3] - p[0], Q.pts[i * 3 + 1] - p[1], Q.pts[i * 3 + 2] - p[2]));
        worst.pen = Math.max(worst.pen, pen);
      }
      const want = worst && worst.pen > 0 ? sc([worst.n[0], 0, worst.n[2]], Math.min(0.05, worst.pen) / (Math.hypot(worst.n[0], worst.n[2]) || 1)) : [0, 0, 0];
      const prev = this.yieldOff[s];
      // (out at once when the ball needs more; back, eased)
      const next = len(want) >= len(prev) - 1e-6 ? want : add(prev, sc(sub(want, prev), k));
      this.yieldOff[s] = next;
      if (len(next) < 1e-4) continue;
      this.IK.yieldLeg(mats, this.mrig, s, next);
      this.stats.legYields = (this.stats.legYields || 0) + 1;
      this.stats.maxLegYield = Math.max(this.stats.maxLegYield || 0, len(next));
    }
  }

  log(m) { this.ctl.logLine('[session] ' + m, this.t); }
  /** Compact state (networking): the controller's snapshot + the move buffer. */
  snapshot() { return { ball: this.ctl.snapshot(), buffer: this.buffer.map((b) => b.role) }; }
}

export { BALL_CONTROL_DEFAULTS };
