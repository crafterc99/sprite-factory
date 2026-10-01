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
import { planShot, mulberry32 } from './shot-flight.mjs';
import { handColliders, clearance, sweepClear, fitBallToHands } from './ball-fit.mjs';

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
   *                     handContact?: contact-ik buildHandContact() of this rig — the hands' own skin against the ball }
   */
  constructor(o) {
    this.P = o.player; this.mrig = o.mhrRig; this.IK = o.IK; this.phys = o.phys || null; this.MS = o.MS || null;
    this.ctl = new BallController(o.cfg || {});
    this.hoop = o.hoop || { center: [0, 3.05, 0], rimR: 0.2286 };
    this.buffer = [];              // queued move requests { role, at }
    this.graph = null;
    this.t = 0;
    this.prevTargets = null;
    this.free = null;              // a shot / loose ball in the physics: { kind, t, bounces0 }
    this.stats = { requests: 0, fired: 0, dropped: 0, switches: 0, waited: 0, shots: 0, passes: 0, pickups: 0 };
    this.onEvent = o.onEvent || null;
    this.armScale = 1;
    this.legRadii = o.limbRadii || null;
    this.lastBody = null;
    this.trace = o.trace ? [] : null;
    this.rng = mulberry32(o.seed ?? 0x5eed);   // shot outcomes (a meter's "rim" grade): seeded, replayable
    this.shotInput = null;                      // the next shot's grade (setShotInput), consumed at its release
    this.lastShot = null;
    // the hands' own skin (contact-ik buildHandContact): the palm target clears the palm skin, and every
    // tick the palm rests on the ball, the fingers are out of it or (holding) on it — null: the joint passes
    // (the mesh data is shared; the scratch skin and the fingers' smoothing state are this session's own)
    const own = (H) => ({ ...H, pos: new Float32Array(H.pos.length), prevTh: new Float32Array(H.prevTh.length) });
    this.hc = o.handContact ? { l: own(o.handContact.l), r: own(o.handContact.r) } : null;
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
      if (e.type === 'bounce' && e.world && caps) {
        // constraint: the bounce spot never inside a leg / foot (the pose now; planted feet stay)
        const m = clearOfCaps([e.world[0], this.ctl.cfg.floorY + this.ctl.cfg.R, e.world[2]], caps, this.ctl.cfg.R, 0.015);
        if (m.shift > 0.001) { e.world = m.p; e.cleared = m.shift; }
      }
    }
    return S;
  }

  // ── input: move requests, the buffer and the move graph ──
  /** A move / shot request (the input). It fires at the next valid window (see nextTrigger). */
  requestMove(role, t = this.t) {
    this.stats.requests++;
    if (this.buffer.length >= 3) this.buffer.shift();
    this.buffer.push({ role, at: t });
    this.log(`input ${role} (buffered)`);
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
    while (this.buffer.length && t - this.buffer[0].at > 1.2) { const d = this.buffer.shift(); this.stats.dropped++; this.log(`input ${d.role} dropped (no valid window in 1.2 s)`); }
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
    if (!P.hasMoveFor(req.role, hand)) {
      if (P.hasMoveFor(req.role, other(hand))) {
        if (P.mode === 'loco' && !P.switchPending) { this.requestHandSwitch(); this.log(`${req.role} starts in the ${other(hand)} hand: crossover first`); }
        this.stats.waited++;
        return null;
      }
      this.buffer.shift(); this.stats.dropped++; this.log(`input ${req.role}: no clip`);
      return { missing: req.role };
    }
    this.buffer.shift(); this.stats.fired++;
    this.log(`${req.role} fires (${hand} hand)`);
    return { role: req.role, hand };
  }

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
    if (this.hc) for (const s of ['l', 'r']) this.hc[s].prevTh.fill(0);
    this.snapHands = true;   // (the new possession's hand holds the ball at once: its next pass is not eased)
    const targets = this.targets(mats, 0);
    const hand = P.hand || 'right';   // the dribbling hand (syncDribbleToCatch put its idle in a hold)
    if (this.phys) this.phys.suspend?.();   // (suspend also makes the body solid again after a shot)
    this.free = null; this.buffer = [];
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
    this.t = t;
    const P = this.P, C = this.ctl, ph = this.phys;
    if (!this.armLen) this.measureArms(mats);
    const targets = this.targets(mats, dt);
    const S = this.worldSchedule(targets, mats);
    this.lastSchedule = S; this.lastTargets = targets;
    if (body) this.lastBody = body;
    // gameplay events from the animation
    const releaseNow = (r?.events || []).some((e) => e.type === 'release');
    for (const e of r?.events || []) if (e.type === 'handSwitch') this.log(`idle → ${e.hand} hand`);
    // the hands hold the ball this tick (clear of them, a shot on its launch side) …
    C.update(t, dt, { targets, schedule: S, player: { pos: P.pos, vel: P.vel, yaw: P.yaw }, obstacles: this.legCaps(mats), hands: body || this.lastBody, shot: this.shotContext() });
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
    if (C.controlled) this.yieldLegs(mats);
    // the hands' own skin against the ball where it is drawn this tick (every state: a shot's hands
    // let go of it, a free hand never passes through it)
    if (this.hc) this.resolveHands(mats, dt);
    if (this.trace) this.trace.push({ t, s: C.state, p: C.p.slice(), hand: S.hand, tl: targets.left.p, tr: targets.right.p });
    return C.out();
  }

  /**
   * The shot leaves the hands from where the ball is this tick (fitted clear of them, on its
   * launch side): the arc to the rim (engine3d/shot-flight.mjs — a make unless the meter's grade
   * says otherwise), started clear of the body, with the ball ↔ body contacts off until it is
   * clear of the thrower (the physics would otherwise swallow the throw in the hands it leaves).
   */
  shoot(t, targets, body = this.lastBody) {
    const C = this.ctl, ph = this.phys;
    const input = this.shotInput || { outcome: 'make' };
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
    this.free = { kind: 'shot', t: 0, bounces0: ph?.stats?.bounces ?? 0, through: false, plan, ghost: !!ph, prevP: from.slice() };
    if (ph) {
      ph.resume?.(from, plan.v0, plan.w0, body);
      ph.setBodyCollision?.(false);
      ph.throwBall(plan.v0, holding === 'left' || holding === 'right' ? holding : 'both');
    }
    this.lastShot = { outcome: plan.outcome, aim: plan.aim, T: plan.T, v0: plan.v0, w0: plan.w0, apexY: plan.apexY, entryDeg: plan.entryDeg, from, swept, t, input, through: false, minRimDist: Infinity, maxY: from[1] };
    this.log(`shot → ${plan.outcome} (T ${plan.T.toFixed(2)} s, entry ${plan.entryDeg.toFixed(0)}°, apex ${plan.apexY.toFixed(2)} m${swept ? `, launched ${(swept * 100).toFixed(1)} cm clear of the hands` : ''})`);
    this.onEvent?.({ type: 'shot', t, outcome: plan.outcome, aim: plan.aim, T: plan.T });
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
      // the result (the meter reads it): through the ring downward, closest to the rim's centre, apex
      const L = this.lastShot, c = this.hoop.center;
      if (L) {
        L.maxY = Math.max(L.maxY, p[1]);
        L.minRimDist = Math.min(L.minRimDist, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
        if (!L.through && f.prevP && f.prevP[1] > c[1] && p[1] <= c[1] && Math.hypot(p[0] - c[0], p[2] - c[2]) < this.hoop.rimR - 0.03) L.through = true;   // (f.through is the court's own swish flag)
      }
      f.prevP = p.slice();
      const settled = ph.state === 'FREE' || ph.stats.bounces - (f.bounces0 ?? 0) >= 3 || f.t > 4.5;
      if (settled) this.passBack(t, targets);
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
    for (const [s, side] of [['l', 'left'], ['r', 'right']]) {
      const holds = held === side || held === 'both';
      this.gripW[side] = ease(this.gripW[side], holds || catching === side ? 1 : 0);
      this.pullW[side] = ease(this.pullW[side], holds && !fitted ? 1 : 0);
      out[side] = this.IK.resolveHandBall(mats, this.mrig, this.hc[s], s, { p: C.p, R: C.cfg.R }, { grip: this.gripW[side], pull: this.pullW[side], pullMax: (this.IK.HAND?.pullMax ?? 0) * this.armScale, clear: this.palmClear[side], dt, reachArm: this.IK.reachArm });
    }
    return (this.lastHands = out);
  }

  /** Knee yield: a leg the (controlled) ball still overlaps moves its knee away, hip and ankle fixed. */
  yieldLegs(mats) {
    const C = this.ctl, R = C.cfg.R, p = C.p;
    const r = this.legRadii || { thigh: 0.07, shin: 0.05 };
    const J = (n) => this.IK.jointPos(mats, this.mrig, this.mrig.JI[n]);
    for (const s of ['l', 'r']) {
      const hip = J(`${s}_upleg`), knee = J(`${s}_lowleg`), ank = J(`${s}_foot`);
      let worst = null;
      for (const [a, b, rr] of [[hip, knee, r.thigh], [knee, ank, r.shin]]) {
        const ab = sub(b, a), u = clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9), 0, 1);
        const q = add(a, sc(ab, u)), d = sub(q, p), dl = len(d), pen = rr + R + 0.004 - dl;
        if (pen > 0 && dl > 1e-6 && (!worst || pen > worst.pen)) worst = { pen, n: sc(d, 1 / dl) };
      }
      if (!worst) continue;
      const y = sc([worst.n[0], 0, worst.n[2]], Math.min(0.05, worst.pen) / (Math.hypot(worst.n[0], worst.n[2]) || 1));
      this.IK.yieldLeg(mats, this.mrig, s, y);
      this.stats.legYields = (this.stats.legYields || 0) + 1;
    }
  }

  log(m) { this.ctl.logLine('[session] ' + m, this.t); }
  /** Compact state (networking): the controller's snapshot + the move buffer. */
  snapshot() { return { ball: this.ctl.snapshot(), buffer: this.buffer.map((b) => b.role) }; }
}

export { BALL_CONTROL_DEFAULTS };
