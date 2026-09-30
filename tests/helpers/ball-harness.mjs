/**
 * Headless game harness for the ball contact system: the court's game tick (court3d.html
 * gameTick) with the real Player (anim3d), MHR skinning (mhr-skin), physics (Rapier), contact IK
 * and engine3d/ball-session.mjs — no browser. Scenarios are scripted input over time; every tick
 * is measured (floor, teleports, catches, bounces, ownership, transitions, NaN, IK reach, leg
 * clearance).
 *
 *   const g = await makeGame({ rig: 'player', fps: 60 });
 *   const m = g.run([[0, 3, { hand: 'right' }], [3, 6, { move: [0, -1] }]]);
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const require = createRequire(import.meta.url);

const A = await import('../../engine3d/anim3d.mjs');
const MS = await import('../../engine3d/mhr-skin.mjs');
const IK = await import('../../engine3d/contact-ik.mjs');
const BP = await import('../../engine3d/basketball-physics.mjs');
const BS = await import('../../engine3d/ball-session.mjs');
const RAPIER = (await import('../../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs')).default;
await RAPIER.init();

export const COURT_ROLES = ['idle', 'loco-fwd', 'loco-sprint', 'move-crossover', 'move-spin', 'shot-jumper', 'shot-stepback'];

let clipCache = null;
/** The court's clips from the local clip library (data/mocap), built as the server builds them. */
export async function courtClips() {
  if (clipCache) return clipCache;
  const dataDir = path.join(ROOT, 'data', 'mocap');
  if (!fs.existsSync(dataDir)) return (clipCache = null);
  const prev = process.cwd();
  try {
    process.chdir(ROOT);
    const GC = require(path.join(ROOT, 'lib', 'mocap', 'game-clips.js'));
    const lib = await GC.library();
    const court = await GC.clipsForCourt(lib);
    const out = [];
    for (const c of court) {
      const { json } = await GC.build(c.id);
      const j = JSON.parse(JSON.stringify(json));
      j.role = c.role;
      const entry = lib.find((x) => x.id === c.id);
      if (entry?.source) j.trackSource = entry.source === 'video' ? 'video' : 'generated';
      out.push(j);
    }
    return (clipCache = out);
  } catch (e) {
    return (clipCache = null);
  } finally { process.chdir(prev); }
}

const loadRig = (id) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib', 'mocap', 'mhr-rigs', `${id}.json.gz`))));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => len(sub(a, b));
function segDist(p, a, b) { const ab = sub(b, a), t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9))); return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]); }

/**
 * A game: rig + clips + Player + physics + session.
 * @param {object} o { rig: 'player' | 'guard' | 'big' | 'ac-001' | …, fps: 60, clips?: json[], start?: [x, z] }
 */
export async function makeGame(o = {}) {
  const rigJson = loadRig(o.rig || 'player');
  const clips = o.clips || (await courtClips());
  if (!clips) throw new Error('no clip library (data/mocap) — run npm run clips:pull');
  const rig = A.prepareRig(rigJson);
  const mrig = MS.prepareMhr(rigJson, A.MHR70);
  rig.limbRadii = BS.measureLimbRadii(rigJson, mrig, A.b64) || null;
  const lib = A.buildLibrary(clips.map((c) => JSON.parse(JSON.stringify(c))), rig);
  const HOOP = [0, 0];
  const start = o.start || [1.8, 5.2];
  const P = new A.Player(rig, lib, { x: start[0], z: start[1], yaw: Math.atan2(HOOP[0] - start[0], HOOP[1] - start[1]) });
  const ph = new BP.BasketballPhysicsSystem(RAPIER, rig.limbRadii ? { radii: { ...BP.BALL_DEFAULTS.radii, ...rig.limbRadii } } : {});
  ph.addHoop({ center: [0, 3.05, 0], rimR: 0.2286, tube: 0.012 });
  const mats = new Float32Array(mrig.n * 16);
  const cap = { key: '', w: 0 };
  const pose = (r, dt) => {
    const srcs = r?.rotSrc ? r.rotSrc.filter((q) => q.clip?.rots) : [];
    const key = r ? `${r.source}|${srcs.map((q) => q.clip.name + (q.clip.mirror ? '~' : '')).join(',')}` : '';
    if (key !== cap.key) { const had = cap.key !== ''; cap.key = key; cap.w = 0; if (had && dt > 0) (cap.xf ||= MS.createCrossfade(mrig)).start(mats); }
    const target = srcs.length ? srcs.reduce((a, q) => a + q.w, 0) : 0;
    cap.w += (Math.min(1, target) - cap.w) * (1 - Math.exp(-dt / 0.05));
    if (cap.w > 0.002) MS.mhrBoneMatricesCaptured(r.pose, mrig, srcs, cap.w, mats);
    else MS.mhrBoneMatrices(r.pose, mrig, mats);
    // (as court3d.html poseCharacter: a source change crossfades the skeleton from where it was)
    cap.xf?.apply(mats, dt);
  };
  const session = new BS.BallSession({ player: P, mhrRig: mrig, IK, MS, phys: ph, limbRadii: rig.limbRadii, trace: !!o.trace });
  session.setGraph(lib);
  const fps = o.fps || 60, dt = 1 / fps;
  let t = 0;
  // first pose + a new possession
  pose(P.update(dt, { face: HOOP }), dt);
  session.reset(mats, t);

  const bodyOf = () => BP.bodySampleFromJoints(IK.jointAccessor(mats, mrig), ph.cfg, null);

  /**
   * Run a script: [[from, to, { move: [x, z], sprint, trig: role, hand: 'left'|'right', switchHand }], …]
   * (move = WORLD direction; 'toHoop' / 'awayHoop' / 'sideHoop' / 'diagHoop' are relative to the hoop).
   */
  function run(script, opts = {}) {
    const T = Math.max(...script.map((s) => s[1]));
    const fired = new Set();
    const m = {
      fps, ticks: 0, states: {}, transitions: [], maxJump: 0, maxVelErr: 0, minY: Infinity, floorViolations: 0, nan: 0,
      catches: [], bounces: [], releases: 0, recoveries: [], rejected: 0, ownershipMismatch: 0, heldTicks: 0,
      maxHeldGap: 0, heldGapSum: 0, heldGapN: 0, minLegClear: Infinity, legClearAt: null, maxIkReach: 0, maxExtension: 0,
      actions: [], looseTicks: 0, moveEvents: [], shots: 0,
    };
    let prev = null, prevV = null, prev2 = null, prevBounce = false, prevRel = null, prevRel2 = null, prevHadRef = false, prevRef = null, prevRef2 = null;
    const flightStart = new Map();
    for (let k = 0; t < T - 1e-9 && k < 1e6; k++) {
      const seg = script.find(([a, b]) => t >= a && t < b)?.[2] || {};
      const key = script.find(([a, b]) => t >= a && t < b);
      // input
      if (seg.hand && !fired.has(key) && P.hand !== seg.hand) { fired.add(key); if (!P.setHand(seg.hand)) session.requestHandSwitch(); else session.reset(mats, t); }
      if (seg.switchHand && !fired.has(key)) { fired.add(key); session.requestHandSwitch(); }
      if (seg.trig && !fired.has(key)) { fired.add(key); session.requestMove(seg.trig, t); }
      const trig = session.nextTrigger(t);
      let mv = seg.move || [0, 0];
      const toH = [-P.pos[0], -P.pos[1]], l = Math.hypot(...toH) || 1, f = [toH[0] / l, toH[1] / l], sd = [f[1], -f[0]];
      if (mv === 'toHoop') mv = f; else if (mv === 'awayHoop') mv = [-f[0], -f[1]]; else if (mv === 'sideHoop') mv = sd; else if (mv === 'diagHoop') mv = [(f[0] + sd[0]) * 0.7071, (f[1] + sd[1]) * 0.7071];
      t += dt;
      const r = P.update(dt, { move: mv, sprint: !!seg.sprint, face: HOOP, trigger: trig?.role || null, triggerHand: trig?.hand });
      for (const e of r.events) if (e.type === 'action') m.actions.push({ t: +t.toFixed(3), role: e.role, clip: e.clip, mirror: e.mirror });
      pose(r, dt);
      const out = session.step(t, dt, r, mats, bodyOf());
      const C = session.ctl;
      // ── measurements
      m.ticks++;
      m.states[out.state] = (m.states[out.state] || 0) + 1;
      for (const e of out.events) {
        if (e.type === 'state') m.transitions.push(`${e.from}→${e.to}`);
        if (e.type === 'catch') m.catches.push({ t: +t.toFixed(3), hand: e.hand, err: e.err, expected: P.heldHandNow() });
        if (e.type === 'bounce') { const planned = C.lastFlight?.plannedBounce || C.flight?.plannedBounce; m.bounces.push({ t: +e.t.toFixed(3), p: e.p, restitution: e.restitution, planned }); }
        if (e.type === 'release') { m.releases++; flightStart.set('cur', t); }
        if (e.type === 'recovery') m.recoveries.push({ t: +t.toFixed(3), reason: e.reason });
      }
      const p = out.p;
      if (![...p, ...out.v].every(Number.isFinite)) m.nan++;
      m.minY = Math.min(m.minY, p[1]);
      if (p[1] < C.cfg.R - 0.004) m.floorViolations++;
      if (prev) {
        const jump = dist(p, prev);
        if (jump / dt > m.maxJump) { m.maxJump = jump / dt; m.jumpAt = { t: +t.toFixed(3), state: out.state, v: +len(out.v).toFixed(2) }; }   // m/s implied by one tick
        // teleport: a step longer than the ball's own speed (either end of the tick) allows
        const allowed = Math.max(len(prevV), len(out.v)) * dt;
        if (jump - allowed > (m.maxTeleport || 0)) { m.maxTeleport = jump - allowed; m.teleportAt = { t: +t.toFixed(3), state: out.state }; }
        const pred = [prev[0] + (prevV[0] + out.v[0]) * dt / 2, prev[1] + (prevV[1] + out.v[1]) * dt / 2, prev[2] + (prevV[2] + out.v[2]) * dt / 2];
        // position change vs reported velocity (a teleport shows here); the bounce tick itself is a
        // velocity discontinuity by nature
        const bounced = out.events.some((e) => e.type === 'bounce' || (e.type === 'state' && /BOUNCE/.test(e.to)));
        if (C.controlled && !out.recovery && !bounced) { const e = dist(pred, p); if (e > m.maxVelErr) { m.maxVelErr = e; m.velErrAt = { t: +t.toFixed(3), state: out.state }; } }
      }
      // pops: the ball's acceleration from its drawn positions (the bounce itself excluded) — in a
      // hold measured relative to the holding palm (the ball rides the hand; the hand's own motion
      // is the animation's), in flight absolute
      // (a bounce and a throw — a pass / pick-up launch, a shot — are impulses by nature)
      const bounceTick = out.events.some((e) => e.type === 'bounce' || (e.type === 'state' && /PASS_RELEASE|SHOT_RELEASE|LOOSE/.test(e.to)));
      const hh = /^HELD_|^CATCH_/.test(out.state) ? (out.state.endsWith('BOTH') ? 'both' : out.state.endsWith('RIGHT') ? 'right' : 'left') : null;
      const ref = hh ? C.targetOf(hh, session.lastTargets)?.p : null;
      const rel = ref ? [p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]] : p.slice();
      const handA = ref && prevRef && prevRef2 ? len([ref[0] - 2 * prevRef[0] + prevRef2[0], ref[1] - 2 * prevRef[1] + prevRef2[1], ref[2] - 2 * prevRef[2] + prevRef2[2]]) / (dt * dt) : 0;
      if (prevRel && prevRel2 && !bounceTick && !prevBounce && C.controlled && (!!ref === prevHadRef)) {
        const a = len([rel[0] - 2 * prevRel[0] + prevRel2[0], rel[1] - 2 * prevRel[1] + prevRel2[1], rel[2] - 2 * prevRel[2] + prevRel2[2]]) / (dt * dt);
        const own = a - 1.25 * handA;
        if (own > (m.maxOwnAccel ?? -Infinity)) { m.maxOwnAccel = own; m.maxAccel = a; m.accelAt = { t: +t.toFixed(3), state: out.state, handAccel: +handA.toFixed(0) }; }
      }
      m.maxHandAccel = Math.max(m.maxHandAccel || 0, handA);
      prevBounce = bounceTick;
      prevRel2 = prevHadRef === !!ref ? prevRel : null; prevRel = rel; prevHadRef = !!ref;
      prevRef2 = ref && prevRef ? prevRef : null; prevRef = ref ? ref.slice() : null;
      prev2 = prev ? prev.slice() : null;
      prev = p.slice(); prevV = out.v.slice();
      if (/^HELD_/.test(out.state)) {
        m.heldTicks++;
        const h = out.state === 'HELD_BOTH' ? 'both' : out.state.endsWith('RIGHT') ? 'right' : 'left';
        const anim = P.heldHandNow();
        if (anim && anim !== h && h !== 'both' && anim !== 'both' && P.mode !== 'action') m.ownershipMismatch++;
        const T0 = C.targetOf(h, session.lastTargets);
        if (T0 && C.hold && t - C.hold.t0 > 0.1) { const gap = dist(p, T0.p); m.maxHeldGap = Math.max(m.maxHeldGap, gap); m.heldGapSum += gap; m.heldGapN++; }
      }
      if (out.state === 'LOOSE') m.looseTicks++;
      // leg clearance while the ball is controlled: flights (the solver's paths) vs holds / catches
      // (the ball on the palm: an animation-fit question)
      if (C.controlled) {
        const cat = /^(DRIBBLE_|BOUNCE)/.test(out.state) ? 'flight' : /^(RELEASE_|CATCH_)/.test(out.state) ? 'contact' : /^HELD_/.test(out.state) ? 'held' : null;
        if (cat) {
          let worst = Infinity;
          for (const c of session.legCaps(mats)) worst = Math.min(worst, segDist(p, c.a, c.b) - c.r - C.cfg.R);
          m.leg = m.leg || {};
          const L = (m.leg[cat] ||= { min: Infinity, at: null, over2cmTicks: 0 });
          if (worst < L.min) { L.min = worst; L.at = { t: +t.toFixed(3), state: out.state, move: P.action?.clip?.name || 'loco' }; }
          if (worst < -0.02) L.over2cmTicks++;
          if (cat !== 'held' && worst < m.minLegClear) { m.minLegClear = worst; m.legClearAt = L.at; }
        }
      }
      if (session.lastIk) m.maxIkReach = Math.max(m.maxIkReach, session.lastIk.reach || 0);
      for (const s of ['l', 'r']) {
        const J = (n) => IK.jointPos(mats, mrig, mrig.JI[`${s}_${n}`]);
        const l1 = dist(J('uparm'), J('lowarm')), l2 = dist(J('lowarm'), J('wrist'));
        m.maxExtension = Math.max(m.maxExtension, dist(J('uparm'), J('wrist')) / (l1 + l2));
      }
      if (opts.onTick) opts.onTick({ t, out, P, session, mats });
    }
    m.rejected = C_rejected();
    m.recoveryCount = m.recoveries.length;
    m.meanHeldGap = m.heldGapN ? m.heldGapSum / m.heldGapN : 0;
    m.maxCatchErr = m.catches.length ? Math.max(...m.catches.map((c) => c.err || 0)) : 0;
    m.maxBounceErr = m.bounces.filter((b) => b.planned).length ? Math.max(...m.bounces.filter((b) => b.planned).map((b) => Math.hypot(b.p[0] - b.planned[0], b.p[2] - b.planned[2]))) : 0;
    m.log = session.ctl.log.slice();
    m.sessionStats = { ...session.stats };
    return m;
  }
  const C_rejected = () => session.ctl.rejected;
  return { P, session, ph, rig, mrig, mats, lib, run, get t() { return t; }, rigJson };
}
