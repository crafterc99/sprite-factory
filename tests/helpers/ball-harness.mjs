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
const TR = await import('../../engine3d/ball-trajectory.mjs');
const SM = await import('../../engine3d/shot-meter.mjs');
const PS = await import('../../engine3d/pro-stick.mjs');
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
      // (as court3d.html clipMeta: the Contact Editor's saved edits ride on the clip)
      if (entry?.ballContacts) j.ballContacts = entry.ballContacts;
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
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function segDist(p, a, b) { const ab = sub(b, a), t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9))); return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]); }

const FINGER_CHAINS = { thumb: ['thumb1', 'thumb2', 'thumb3', 'thumb_null'], index: ['index1', 'index2', 'index3', 'index_null'], middle: ['middle1', 'middle2', 'middle3', 'middle_null'], ring: ['ring1', 'ring2', 'ring3', 'ring_null'], pinky: ['pinky1', 'pinky2', 'pinky3', 'pinky_null'] };

/**
 * A game: rig + clips + Player + physics + session.
 * @param {object} o { rig: 'player' | 'guard' | 'big' | 'ac-001' | …, fps: 60, clips?: json[], start?: [x, z], seed?,
 *                     handContact: false → the session without the hands' skin (the joint passes, as a rig with no mesh),
 *                     fingers: true → a rig without the hands' skin gets the court's joint render pass (contact-ik
 *                     clearHandsOfBall) every tick, and every tick's worst finger / knuckle / palm joint clearance is measured (m.fingers),
 *                     shotMeter: { cfg? } → the session gets a shot meter (engine3d/shot-meter.mjs) and scripts hold the
 *                     shot button: a segment's shoot (bool, or ({ t, P, meter }) → bool: held this tick) with shotRole (default
 *                     'shot-jumper') — the press starts the shot, the release grades it (as court3d.html) }
 * Shot meter scripts: m.meter (its history), m.makes / m.misses, m.shotEvents (shot / make / shotEnd / dropped).
 * Every tick the hands' full LOD0 skin (true LBS of the drawn matrices) is measured against the ball:
 * m.maxHandPen / handPenAt / handPenTicks3mm (> 0 = inside), in held ticks the holding palm's gap and the
 * fingertip pads on the surface (m.palmGapHeldMed, m.gripTipsHeldMed), the fingertip motion the hand pass
 * adds per tick (m.maxFingerPopAdd, relative to the wrist) and its cost (m.handMsPerTick).
 * Flare — a hand that owns the ball (held / catching) with its palm on it (≤ 1 cm): each fingertip pad's gap
 * off the surface (m.flareTipMax / flareAt / flareTipP90 / flareTicks15mm over m.contactTicks; the thumb:
 * m.thumbTipMax). Finger joints of that hand, tick to tick: the change the hand pass adds beyond the
 * animation's own (m.maxJointJumpAdd rad, m.maxJointRateAdd rad/s, jointJumpAt) and the animation's own
 * (m.maxBaseJointJump: a spike in the clip), and the drawn joint's own change (m.maxFinalJointJump).
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
  // (the court's hoop: court3d.html — the rim and its backboard, BASELINE_Z + 1.22)
  ph.addHoop({ center: [0, 3.05, 0], rimR: 0.2286, tube: 0.012, board: { center: [0, 2.9 + 0.535, -1.575 + 1.22], half: [0.915, 0.535, 0.02] } });
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
  // the hands' own skin (as court3d.html: subsampled for the pass; the full LOD0 skin measures it)
  const handContact = o.handContact === false ? null : IK.buildHandContact(rigJson, mrig, A.b64, { maxPerSeg: IK.HAND.maxPerSeg, maxPalm: IK.HAND.maxPalm });
  const hcFull = IK.buildHandContact(rigJson, mrig, A.b64);
  const meter = o.shotMeter ? new SM.ShotMeter(o.shotMeter) : null;
  const evs = [];
  // the body's own skin (as court3d.html): every dribble's flight is planned clear of it
  const bodyContact = o.bodyContact === false ? null : BS.buildBodyContact(rigJson, mrig, A.b64);
  const session = new BS.BallSession({ player: P, mhrRig: mrig, IK, MS, phys: ph, limbRadii: rig.limbRadii, trace: !!o.trace, handContact, bodyContact, ...(o.seed != null ? { seed: o.seed } : {}), shotMeter: meter, onEvent: (e) => { if (/^(shot|make|shotEnd|dropped)$/.test(e.type)) evs.push({ ...e, at: t }); } });
  session.setGraph(lib);
  // the hand pass, observed: what it adds to the fingertips' motion (relative to the wrist), its cost
  const tipsRel = () => { const out = []; for (const s of ['l', 'r']) { const w = IK.jointPos(mats, mrig, mrig.JI[`${s}_wrist`]); for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) out.push(sub(IK.jointPos(mats, mrig, mrig.JI[`${s}_${f}_null`]), w)); } return out; };
  // every finger joint's flexion (rad; about its hinge against the parent bone — the thumb: its bend)
  const jointAngles = () => {
    const out = {};
    if (!hcFull) return out;
    for (const s of ['l', 'r']) out[s] = hcFull[s].segs.map((sg) => {
      const a = IK.jointPos(mats, mrig, sg.j), d = unit(sub(IK.jointPos(mats, mrig, sg.jc), a)), dp = unit(sub(a, IK.jointPos(mats, mrig, sg.jp)));
      if (!sg.hinge0) return Math.acos(Math.max(-1, Math.min(1, dot(dp, d))));
      const o = sg.j * 16, h = sg.hinge0, u = unit([mats[o] * h[0] + mats[o + 4] * h[1] + mats[o + 8] * h[2], mats[o + 1] * h[0] + mats[o + 5] * h[1] + mats[o + 9] * h[2], mats[o + 2] * h[0] + mats[o + 6] * h[1] + mats[o + 10] * h[2]]);
      return Math.atan2(dot(cross(dp, d), u), dot(dp, d));
    });
    return out;
  };
  const handObs = { before: null, after: null, ms: 0, n: 0, angBefore: null, angAfter: null };
  if (session.hc) {
    const resolve = session.resolveHands.bind(session);
    session.resolveHands = (M, dt) => { handObs.before = tipsRel(); handObs.angBefore = jointAngles(); const t0 = process.hrtime.bigint(); const r = resolve(M, dt); handObs.ms += Number(process.hrtime.bigint() - t0) / 1e6; handObs.n++; handObs.after = tipsRel(); handObs.angAfter = jointAngles(); return r; };
  }
  const fps = o.fps || 60, dt = 1 / fps;
  let t = 0;
  // first pose + a new possession
  pose(P.update(dt, { face: HOOP }), dt);
  session.reset(mats, t);

  const bodyOf = () => BP.bodySampleFromJoints(IK.jointAccessor(mats, mrig), ph.cfg, null);

  /**
   * Run a script: [[from, to, { move: [x, z], sprint, trig: role, hand: 'left'|'right', switchHand, shoot, shotRole, stick }], …]
   * (move = WORLD direction; 'toHoop' / 'awayHoop' / 'sideHoop' / 'diagHoop' are relative to the hoop).
   * stick: the right stick, raw [x, y-down] (or u → [x, y] over the segment, u 0…1) — the pro stick
   * (engine3d/pro-stick.mjs MoveControls, the move bindings: makeGame's o.controls, else the defaults) as
   * court3d.html runs it, the chase camera behind him looking at the hoop: m.stick (every read and where it went),
   * m.stickBufferMax (stick requests queued at once).
   */
  function run(script, opts = {}) {
    const T = Math.max(...script.map((s) => s[1]));
    const fired = new Set();
    const m = {
      fps, ticks: 0, states: {}, transitions: [], maxJump: 0, maxVelErr: 0, minY: Infinity, floorViolations: 0, nan: 0,
      catches: [], bounces: [], releases: 0, recoveries: [], rejected: 0, ownershipMismatch: 0, heldTicks: 0,
      maxHeldGap: 0, heldGapSum: 0, heldGapN: 0, minLegClear: Infinity, legClearAt: null, maxIkReach: 0, maxExtension: 0,
      actions: [], looseTicks: 0, moveEvents: [], shots: [], fingers: null, pops: [],
      maxHandPen: -Infinity, handPenAt: null, handPenTicks3mm: 0, palmGapsHeld: [], gripTipsHeld: [], maxFingerPopAdd: 0, fingerPopAt: null,
      contactTicks: 0, flareTips: [], flareTipMax: 0, flareAt: null, flareTicks15mm: 0, thumbTipMax: 0, thumbAt: null,
      maxJointJumpAdd: 0, jointJumpAt: null, maxBaseJointJump: 0, baseJointJumpAt: null, maxFinalJointJump: 0, finalJointJumpAt: null,
    };
    let prevAng = null;
    let prev = null, prevV = null, prev2 = null, prevBounce = false, prevRel = null, prevRel2 = null, prevHadRef = false, prevRef = null, prevRef2 = null, passCatch = null;
    // (the drawn ball is its path at drawT — the tick's time, but the bounce instant on the bounce tick, where the floor
    // contact is drawn: steps and accelerations are over the time between the drawn instants)
    let prevDrawT = null, prevDrawT2 = null;
    let prevObs = null;
    const ms0 = handObs.ms, n0 = handObs.n;
    const flightStart = new Map(), ev0 = evs.length;
    const pro = new PS.MoveControls({ controls: o.controls || null, sticks: { pad: {} } }); m.stick = []; m.stickBufferMax = 0;
    for (let k = 0; t < T - 1e-9 && k < 1e6; k++) {
      const seg = script.find(([a, b]) => t >= a && t < b)?.[2] || {};
      const key = script.find(([a, b]) => t >= a && t < b);
      // input
      if (seg.hand && !fired.has(key) && P.hand !== seg.hand) { fired.add(key); if (!P.setHand(seg.hand)) session.requestHandSwitch(); else session.reset(mats, t); }
      if (seg.switchHand && !fired.has(key)) { fired.add(key); session.requestHandSwitch(); }
      if (seg.trig && !fired.has(key)) { fired.add(key); session.requestMove(seg.trig, t); }
      // the shot button (a meter game): held this tick? — the press starts the shot, the release grades it
      let shootHeld = false;
      if (meter && (seg.shoot !== undefined || meter.btn)) {
        const held = shootHeld = typeof seg.shoot === 'function' ? !!seg.shoot({ t, P, meter }) : !!seg.shoot;
        SM.shootButton(meter, { held, t, P, request: (role) => session.requestMove(role, t), roleOf: () => seg.shotRole || 'shot-jumper' });
      }
      // the right stick (court3d.html gameTick → stickMove): the gesture → the move, a newer one replacing its queued one
      const sv = typeof seg.stick === 'function' ? seg.stick(key ? (t - key[0]) / (key[1] - key[0]) : 0) : (seg.stick || [0, 0]);
      const gst = pro.sample('pad', sv[0], sv[1], t * 1000);
      {
        const h = [-P.pos[0], -P.pos[1]], hl = Math.hypot(h[0], h[1]) || 1, f = [h[0] / hl, h[1] / hl];   // (the chase camera looks at the hoop)
        const ctx = { P, ctl: session.ctl, lib, camFwd: f, camRight: [-f[1], f[0]], shootHeld };
        const res = gst ? pro.read(gst, ctx) : pro.tick(t * 1000, ctx);
        // (as court3d.html stickMove: a wait that ended plays its held moves first; the newest replaces a queued one)
        for (const r of res ? [...(res.before || []), res] : []) {
          if (r.recording) continue;
          m.stick.push({ t: +t.toFixed(3), a: r.a ?? +(gst?.a ?? 0).toFixed(1), mode: P.mode, action: P.action?.clip?.name || null, ...r, before: undefined });
          if (r.ignored || r.waiting) continue;
          if (r.handSwitch) { if (P.mode === 'loco') session.requestHandSwitch(); } else if (r.role) session.requestMove(r.role, t, { src: 'stick', replace: r === res.before?.[0] || !res.before, hand: r.hand, ...(r.combo ? { degrade: r.degrade } : {}) });
        }
      }
      m.stickBufferMax = Math.max(m.stickBufferMax, session.buffer.filter((b) => b.src === 'stick').length);
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
      // (the court's render pass for a rig without the hands' skin: hands out of the ball, fingers
      // conformed — court3d.html ballStepContact; with it the session already did it)
      if (o.fingers) {
        if (!session.hc) IK.clearHandsOfBall(mats, mrig, out.p, C.cfg.R, { holding: C.heldHand, rf: ph.cfg.radii.finger });
        if (C.controlled || (out.state === 'SHOT_RELEASE' && (session.free?.t ?? 9) < 0.25)) measureFingers(m, out, t);
      }
      if (hcFull) measureHandSkin(m, out, t);
      // the fingertip motion the hand pass adds this tick (beyond the pose's own, relative to the wrist)
      if (session.hc && handObs.after) {
        if (prevObs) {
          let add_ = 0, i_ = -1;
          for (let i = 0; i < handObs.after.length; i++) { const x = dist(handObs.after[i], prevObs.after[i]) - dist(handObs.before[i], prevObs.before[i]); if (x > add_) { add_ = x; i_ = i; } }
          if (add_ > m.maxFingerPopAdd) { m.maxFingerPopAdd = add_; m.fingerPopAt = { t: +t.toFixed(3), state: out.state, tip: i_, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null }; }
        }
        prevObs = { before: handObs.before, after: handObs.after };
      }
      // finger joints of a hand that owns the ball (held / catching), tick to tick: what the hand pass adds
      // to each joint's change beyond the animation's own (a glitch), and the animation's own (a clip spike)
      if (session.hc && handObs.angAfter?.l) {
        const own = /^(HELD|CATCH)_/.test(out.state) ? (out.state.endsWith('BOTH') ? ['l', 'r'] : [out.state.endsWith('LEFT') ? 'l' : 'r']) : [];
        if (prevAng) for (const s of own) {
          if (!prevAng.own.includes(s)) continue;
          const A = handObs.angAfter[s], B = handObs.angBefore[s], pA = prevAng.after[s], pB = prevAng.before[s];
          for (let i = 0; i < A.length; i++) {
            const add = Math.abs(A[i] - pA[i]) - Math.abs(B[i] - pB[i]), base = Math.abs(B[i] - pB[i]), sg = hcFull[s].segs[i];
            const at = () => ({ t: +t.toFixed(4), state: out.state, joint: `${s}_${sg.f}${sg.k < 0 ? 'root' : sg.k}`, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null });
            if (add > m.maxJointJumpAdd) { m.maxJointJumpAdd = add; m.jointJumpAt = at(); }
            if (base > m.maxBaseJointJump) { m.maxBaseJointJump = base; m.baseJointJumpAt = at(); }
            const fin = Math.abs(A[i] - pA[i]);
            if (fin > m.maxFinalJointJump) { m.maxFinalJointJump = fin; m.finalJointJumpAt = at(); }
          }
        }
        prevAng = { own, after: handObs.angAfter, before: handObs.angBefore };
      }
      // shots: the flight from the release (apex, closest to the rim's centre, through the ring, body contacts)
      if (out.events.some((e) => e.type === 'state' && e.to === 'SHOT_RELEASE')) m.shots.push({ tRelease: +t.toFixed(4), frame: P.action ? +P.action.t.toFixed(3) : null, releaseFrame: P.action?.clip?.shot?.releaseFrame ?? null, clip: P.action?.clip?.name || null, from: out.p.slice(), v0: out.v.slice(), plan: session.lastShot ? { outcome: session.lastShot.outcome, T: session.lastShot.T, swept: session.lastShot.swept } : null, maxY: out.p[1], minRimDist: Infinity, through: false, bodyTouchTicks: 0, minSpeed01: Infinity, palmDist01: Infinity, prevP: out.p.slice() });
      const sh = m.shots[m.shots.length - 1];
      if (sh && out.state === 'SHOT_RELEASE') {
        const ft = t - sh.tRelease;
        sh.maxY = Math.max(sh.maxY, out.p[1]);
        const rd = Math.hypot(out.p[0], out.p[1] - 3.05, out.p[2]);
        if (rd < sh.minRimDist) { sh.minRimDist = rd; sh.closestAt = out.p.slice(); }
        if (sh.prevP[1] > 3.05 && out.p[1] <= 3.05 && Math.hypot(out.p[0], out.p[2]) < 0.2286 - 0.03) sh.through = true;
        // what it met first — the rim (its front: on the shooter's side of the rim's centre, or its back) or the glass —
        // and where it came down through the rim's height (m along the shot from the rim's centre: − short, + long)
        if (!sh.first) { const n = [...ph.touchedSince].find((x) => x === 'rim' || x === 'board'); if (n) { const u = [-sh.from[0], -sh.from[2]], l = Math.hypot(u[0], u[1]); sh.first = { name: n, along: +((out.p[0] * u[0] + out.p[2] * u[1]) / l).toFixed(3), t: +ft.toFixed(3) }; } }
        if (sh.down == null && sh.prevP[1] > 3.05 + 0.03 && out.p[1] <= 3.05 + 0.03) { const u = [-sh.from[0], -sh.from[2]], l = Math.hypot(u[0], u[1]); sh.down = +((out.p[0] * u[0] + out.p[2] * u[1]) / l).toFixed(3); }
        sh.touched = [...ph.touchedSince].filter((x) => !ph.parts.has(x));
        if (ft <= 0.3 + 1e-9 && [...ph.touching].some((n) => ph.parts.has(n))) sh.bodyTouchTicks++;
        if (ft <= 0.1 + 1e-9) { sh.minSpeed01 = Math.min(sh.minSpeed01, len(out.v)); const T = session.lastTargets; sh.palmDist01 = Math.min(len(sub(out.p, T.left.p)), len(sub(out.p, T.right.p))); }
        sh.prevP = out.p.slice();
      }
      // ── measurements
      m.ticks++;
      m.states[out.state] = (m.states[out.state] || 0) + 1;
      for (const e of out.events) {
        if (e.type === 'state') m.transitions.push(`${e.from}→${e.to}`);
        if (e.type === 'catch') m.catches.push({ t: +t.toFixed(3), hand: e.hand, err: e.err, expected: P.heldHandNow(), early: !!e.early });
        if (e.type === 'bounce') { const planned = C.lastFlight?.plannedBounce || C.flight?.plannedBounce; m.bounces.push({ t: +e.t.toFixed(3), p: e.p, restitution: e.restitution, planned }); }
        if (e.type === 'release') { m.releases++; flightStart.set('cur', t); }
        if (e.type === 'recovery') m.recoveries.push({ t: +t.toFixed(3), reason: e.reason });
      }
      const p = out.p;
      if (![...p, ...out.v].every(Number.isFinite)) m.nan++;
      m.minY = Math.min(m.minY, p[1]);
      if (p[1] < C.cfg.R - 0.004) m.floorViolations++;
      const drawT = out.drawT ?? t, span = prevDrawT != null ? Math.max(1e-6, drawT - prevDrawT) : dt;
      if (prev) {
        const jump = dist(p, prev);
        if (jump / span > m.maxJump) { m.maxJump = jump / span; m.jumpAt = { t: +t.toFixed(3), state: out.state, v: +len(out.v).toFixed(2) }; }   // m/s implied by one tick (over the drawn instants)
        // teleport: a step longer than the ball's own speed (either end of the tick — or its impact
        // speed when it bounced inside the tick: at 30 fps a tick can start before a fast dribble's
        // bounce and end after it, faster in between than at either end) allows
        let vBounce = 0;
        if (out.events.some((e) => e.type === 'bounce')) { const fl = C.flight || C.lastFlight; if (fl?.down && fl.tb != null) vBounce = len(TR.segVel(fl.down, fl.tb)); }
        // (a flight's own path between the two drawn instants: the bounce tick draws the floor contact, up to half a tick
        // from its own time — the step is the path's length, which a mid-flight speed above both ends can make longer)
        let pathLen = 0;
        const flc = C.flight || C.lastFlight;
        if (flc && !flc.toss && flc.down && flc.up && prevDrawT != null && prevDrawT >= flc.tr - 1e-6 && drawT <= flc.tc + 1e-6) {
          const at = (x) => (x <= flc.tb ? TR.segPos(flc.down, x) : TR.segPos(flc.up, x));
          let q = at(prevDrawT); for (let k = 1; k <= 8; k++) { const x = prevDrawT + (span * k) / 8, r = at(x); pathLen += dist(q, r); q = r; }
        }
        const allowed = Math.max(Math.max(len(prevV), len(out.v), vBounce) * span, pathLen);
        if (jump - allowed > (m.maxTeleport || 0)) { m.maxTeleport = jump - allowed; m.teleportAt = { t: +t.toFixed(3), state: out.state }; }
        const pred = [prev[0] + (prevV[0] + out.v[0]) * span / 2, prev[1] + (prevV[1] + out.v[1]) * span / 2, prev[2] + (prevV[2] + out.v[2]) * span / 2];
        // position change vs reported velocity (a teleport shows here); the bounce tick itself is a
        // velocity discontinuity by nature
        const bounced = out.events.some((e) => e.type === 'bounce' || (e.type === 'state' && /BOUNCE/.test(e.to)));
        if (C.controlled && !out.recovery && !bounced) { const e = dist(pred, p); if (e > m.maxVelErr) { m.maxVelErr = e; m.velErrAt = { t: +t.toFixed(3), state: out.state }; } }
      }
      // pops: the ball's acceleration from its drawn positions (the bounce itself excluded) — in a
      // hold measured relative to the holding palm (the ball rides the hand; the hand's own motion
      // is the animation's), in flight absolute
      // (a bounce and a throw — a pass / pick-up launch, a shot — are impulses by nature, and so is
      // the catch of a pass: the hands stop a ball flying at 6–12 m/s — a made shot's rebound comes
      // back from under the hoop)
      for (const e of out.events) if (e.type === 'state') {
        if (e.from === 'PASS_RELEASE') passCatch = { end: Infinity };
        if (passCatch && /^CATCH_/.test(e.from) && /^HELD_/.test(e.to)) passCatch.end = t + 2.5 * dt;
      }
      const passCatchTick = !!passCatch && t <= passCatch.end;
      if (passCatch && t > passCatch.end) passCatch = null;
      const bounceTick = passCatchTick || out.events.some((e) => e.type === 'bounce' || (e.type === 'state' && /PASS_RELEASE|SHOT_RELEASE|LOOSE/.test(e.to)));
      const hh = /^HELD_|^CATCH_/.test(out.state) ? (out.state.endsWith('BOTH') ? 'both' : out.state.endsWith('RIGHT') ? 'right' : 'left') : null;
      const ref = hh ? C.targetOf(hh, session.lastTargets)?.p : null;
      const rel = ref ? [p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]] : p.slice();
      const handA = ref && prevRef && prevRef2 ? len([ref[0] - 2 * prevRef[0] + prevRef2[0], ref[1] - 2 * prevRef[1] + prevRef2[1], ref[2] - 2 * prevRef[2] + prevRef2[2]]) / (dt * dt) : 0;
      if (prevRel && prevRel2 && !bounceTick && !prevBounce && C.controlled && (!!ref === prevHadRef)) {
        // (second difference over the drawn instants: uneven after a bounce tick)
        const h1 = prevDrawT2 != null ? Math.max(1e-6, prevDrawT - prevDrawT2) : dt, h2 = span;
        const a = len([0, 1, 2].map((k) => (2 * ((rel[k] - prevRel[k]) / h2 - (prevRel[k] - prevRel2[k]) / h1)) / (h1 + h2)));
        const own = a - 1.25 * handA;
        if (own > (m.maxOwnAccel ?? -Infinity)) { m.maxOwnAccel = own; m.maxAccel = a; m.accelAt = { t: +t.toFixed(3), state: out.state, handAccel: +handA.toFixed(0) }; }
        if (a > 400 && a > 1.25 * handA) m.pops.push({ t: +t.toFixed(4), a: Math.round(a), handAccel: Math.round(handA), state: out.state });
      }
      m.maxHandAccel = Math.max(m.maxHandAccel || 0, handA);
      prevBounce = bounceTick;
      prevRel2 = prevHadRef === !!ref ? prevRel : null; prevRel = rel; prevHadRef = !!ref;
      prevRef2 = ref && prevRef ? prevRef : null; prevRef = ref ? ref.slice() : null;
      prev2 = prev ? prev.slice() : null;
      prev = p.slice(); prevV = out.v.slice();
      prevDrawT2 = prevDrawT; prevDrawT = drawT;
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
    // (the catch error: where a flight ended vs the palm then — an early catch, the hand meeting the ball before its
    // planned contact, is caught where they met: ≤ earlyCatchDist by construction, counted apart)
    const planned = m.catches.filter((c) => !c.early);
    m.maxCatchErr = planned.length ? Math.max(...planned.map((c) => c.err || 0)) : 0;
    m.earlyCatches = m.catches.length - planned.length;
    m.maxBounceErr = m.bounces.filter((b) => b.planned).length ? Math.max(...m.bounces.filter((b) => b.planned).map((b) => Math.hypot(b.p[0] - b.planned[0], b.p[2] - b.planned[2]))) : 0;
    m.log = session.ctl.log.slice();
    m.sessionStats = { ...session.stats };
    m.makes = session.stats.makes; m.misses = session.stats.misses;
    m.shotEvents = evs.slice(ev0);
    if (meter) m.meter = meter.history.map((h) => ({ ...h }));
    const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    m.palmGapHeldMed = med(m.palmGapsHeld); m.gripTipsHeldMed = med(m.gripTipsHeld);
    const p90 = (a) => { if (!a.length) return null; const q = [...a].sort((x, y) => x - y); return q[Math.floor((q.length - 1) * 0.9)]; };
    m.flareTipP90 = p90(m.flareTips); m.maxJointRateAdd = m.maxJointJumpAdd * fps;
    m.handMsPerTick = handObs.n > n0 ? (handObs.ms - ms0) / (handObs.n - n0) : null;
    m.finalHand = P.hand; m.finalHeld = session.ctl.heldHand;
    return m;
  }
  /**
   * The hands' full LOD0 skin against the ball this tick (true LBS of the matrices as drawn): the
   * deepest vertex (> 0 inside), and in a hold the holding palm's gap and how many fingertip pads
   * (index … pinky) are on the surface (≤ 6 mm).
   */
  function measureHandSkin(m, out, t) {
    const R = session.ctl.cfg.R, c = out.p;
    const gap = (Hs, v) => Math.hypot(Hs.pos[v * 3] - c[0], Hs.pos[v * 3 + 1] - c[1], Hs.pos[v * 3 + 2] - c[2]) - R;
    let worst = -Infinity, side = null;
    for (const s of ['l', 'r']) {
      const Hs = hcFull[s];
      MS.skinVerts(Hs.v0, Hs.si, Hs.sw, mats, Hs.pos);
      for (let v = 0; v < Hs.n; v++) { const d = -gap(Hs, v); if (d > worst) { worst = d; side = s; } }
    }
    if (worst > m.maxHandPen) { m.maxHandPen = worst; m.handPenAt = { t: +t.toFixed(3), state: out.state, side, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null }; }
    if (worst > 0.003) m.handPenTicks3mm++;
    // flare: a hand that owns the ball (held / catching) with its palm on it (≤ 1 cm): how far each fingertip pad is off the surface
    const st = out.state, owner = /^(HELD|CATCH)_/.test(st) ? (st.endsWith('BOTH') ? ['l', 'r'] : [st.endsWith('LEFT') ? 'l' : 'r']) : [];
    let contact = false, flare = false;
    for (const s of owner) {
      const Hs = hcFull[s];
      let pg = Infinity; for (const v of Hs.palm) pg = Math.min(pg, gap(Hs, v));
      if (pg > 0.01) continue;
      contact = true;
      for (const sg of Hs.segs) {
        if (sg.k !== 2 || !sg.verts.length) continue;
        let mg = Infinity; for (const v of sg.verts) mg = Math.min(mg, gap(Hs, v));
        const at = { t: +t.toFixed(4), state: st, finger: `${s}_${sg.f}`, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(1) : null };
        if (sg.f === 'thumb') { if (mg > m.thumbTipMax) { m.thumbTipMax = mg; m.thumbAt = at; } continue; }
        m.flareTips.push(mg);
        if (mg > m.flareTipMax) { m.flareTipMax = mg; m.flareAt = at; }
        if (mg > 0.015) flare = true;
      }
    }
    if (contact) m.contactTicks++;
    if (flare) m.flareTicks15mm++;
    const h = session.ctl.heldHand;
    if (h) for (const s of h === 'both' ? ['l', 'r'] : [h[0]]) {
      const Hs = hcFull[s];
      let pg = Infinity; for (const v of Hs.palm) pg = Math.min(pg, gap(Hs, v));
      m.palmGapsHeld.push(pg);
      let tips = 0;
      for (const sg of Hs.segs) { if (sg.k !== 2 || sg.f === 'thumb') continue; let mg = Infinity; for (const v of sg.verts) mg = Math.min(mg, gap(Hs, v)); if (mg < 0.006) tips++; }
      m.gripTipsHeld.push(tips);
    }
  }
  const C_rejected = () => session.ctl.rejected;
  /** The worst clearance of each part of the hands from the ball this tick (after the render pass). */
  function measureFingers(m, out, t) {
    const R = session.ctl.cfg.R, rf = ph.cfg.radii.finger, b = out.p;
    const F = (m.fingers ||= { distal: { min: Infinity }, proximal: { min: Infinity }, thumb1: { min: Infinity }, knuckles: { min: Infinity }, palm: { min: Infinity } });
    const at = (cls, d, part) => { if (d < F[cls].min) F[cls] = { min: d, part, t: +t.toFixed(3), state: out.state, clip: P.action?.clip?.name || 'loco', frame: P.action ? +P.action.t.toFixed(2) : null }; };
    const J = (n) => IK.jointPos(mats, mrig, mrig.JI[n]);
    for (const s of ['l', 'r']) {
      for (const [f, ch] of Object.entries(FINGER_CHAINS)) {
        const r = f === 'thumb' ? rf * 1.15 : rf;
        for (let k = 0; k < 3; k++) {
          const d = segDist(b, J(`${s}_${ch[k]}`), J(`${s}_${ch[k + 1]}`)) - R - r;
          at(k > 0 ? 'distal' : f === 'thumb' ? 'thumb1' : 'proximal', d, `${s}_${ch[k]}`);
        }
      }
      for (const k of ['index1', 'middle1', 'ring1', 'pinky1']) at('knuckles', dist(b, J(`${s}_${k}`)) - R - rf, `${s}_${k}`);
      at('palm', dist(b, IK.palmFrame(mats, mrig, s).c) - R - 0.014, `palm_${s}`);
    }
  }
  return { P, session, ph, rig, mrig, mats, lib, run, get t() { return t; }, rigJson, hcFull, meter, evs };
}
