/**
 * Basketball physics tests — engine3d/basketball-physics.mjs (Rapier), the
 * physics test scenes (engine3d/ball-lab.mjs), the contact IK
 * (engine3d/contact-ik.mjs) and the two-camera triangulation
 * (lib/mocap/ball-triangulate.js).
 *
 * The ball is a Rapier rigid body: nothing here sets its position during play.
 * Every scene checks it the way a viewer would see it — it leaves the hand on
 * every dribble, never passes through the body or the floor, bounces like a
 * basketball and comes back to the hand the move intends.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const TRI = require('../lib/mocap/ball-triangulate');

const ROOT = path.join(__dirname, '..');
const mods = (async () => {
  const R = (await import('../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs')).default;
  await R.init();
  return {
    R,
    BP: await import('../engine3d/basketball-physics.mjs'),
    LAB: await import('../engine3d/ball-lab.mjs'),
    IK: await import('../engine3d/contact-ik.mjs'),
    MS: await import('../engine3d/mhr-skin.mjs'),
    A: await import('../engine3d/anim3d.mjs'),
  };
})();

const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Run one lab scene through a fresh system; returns the metrics + the system. */
async function scene(name, cfg = {}) {
  const { R, BP, LAB } = await mods;
  const sys = new BP.BasketballPhysicsSystem(R, cfg);
  let pelvis = null;
  const r = LAB.runScene(sys, LAB.scenes()[name], { bodySample: (J, y) => { const S = BP.bodySampleFromJoints(J, sys.cfg, y); if (S.boxes.pelvis) pelvis = S.boxes.pelvis.c; return S; } });
  sys.dispose?.();
  return { ...r, sys, pelvis };
}

/** The shared expectations of every dribbling scene. */
function assertCleanDribble(name, r, { minGap = 0.3, maxVideoErr = 0.06 } = {}) {
  const st = r.stats;
  assert.strictEqual(r.sys.lost, false, `${name}: possession kept`);
  assert.strictEqual(st.penetrations.length, 0, `${name}: no collider penetration beyond tolerance (${JSON.stringify(st.penetrations.slice(0, 2))})`);
  assert.ok(st.maxPenetration < 0.006, `${name}: max penetration ${(st.maxPenetration * 1000).toFixed(1)} mm`);
  assert.ok(st.releases >= 2, `${name}: released ${st.releases}×`);
  assert.ok(st.catches >= st.releases, `${name}: every release caught (${st.catches}/${st.releases})`);
  assert.ok(st.bounces >= st.releases, `${name}: each dribble bounces on the floor (${st.bounces})`);
  assert.ok(r.flightMaxGaps.length >= 2 && r.flightMaxGaps.every((g) => g > minGap), `${name}: the ball separates from the hand on every dribble (${r.flightMaxGaps.map((g) => g.toFixed(2))})`);
  assert.ok(r.videoErrMean < maxVideoErr, `${name}: follows the video intent (${(r.videoErrMean * 100).toFixed(1)} cm)`);
  assert.ok(!r.log.some((l) => l.p[1] < r.sys.cfg.radius - 0.006), `${name}: never below the floor`);
}

test('config: 1 unit = 1 m, a regulation ball, fixed high-rate step with CCD', async () => {
  const { BP } = await mods;
  const c = BP.BALL_DEFAULTS;
  assert.ok(Math.abs(c.radius - 0.12) < 1e-9 && Math.abs(c.mass - 0.62) < 1e-9);
  assert.ok(c.hz >= 120 && c.hz <= 180 && c.hzFast >= c.hz);
  assert.strictEqual(c.ccd, true);
  assert.ok(Math.abs(c.gravity - 9.81) < 1e-9);
});

test('dropped ball: bounces like a basketball (COR ≈ 0.8) and settles on the floor', async () => {
  const r = await scene('drop');
  const ap = r.stats.apexes;
  assert.ok(ap.length >= 4, `apexes ${ap}`);
  for (let i = 1; i < ap.length; i++) assert.ok(ap[i] < ap[i - 1], 'each bounce lower');
  const cor = Math.sqrt(ap[1] / ap[0]);
  assert.ok(cor > 0.72 && cor < 0.88, `COR ${cor.toFixed(3)}`);
  assert.strictEqual(r.stats.penetrations.length, 0);
  assert.ok(Math.abs(r.final.p[1] - r.sys.cfg.radius) < 0.01, `rests on the floor (${r.final.p[1].toFixed(3)})`);
});

test('dropped ball with spin: the floor turns spin into travel (rolls away)', async () => {
  const r = await scene('drop-spin');
  assert.ok(Math.abs(r.final.p[0]) > 1, `travelled ${r.final.p[0].toFixed(2)} m`);
  assert.ok(r.stats.apexes[1] < r.stats.apexes[0]);
});

for (const name of ['dribble-right', 'dribble-left', 'pound', 'low']) {
  test(`stationary dribble (${name}): impulses, a bounce each time, back to the same hand`, async () => {
    const r = await scene(name);
    assertCleanDribble(name, r, { minGap: name === 'low' ? 0.2 : 0.3 });
    assert.strictEqual(new Set(r.log.map((l) => l.hand).filter(Boolean)).size, 1, 'one hand');
    const ap = r.stats.apexes.slice(0, -1);
    assert.ok(Math.max(...ap) - Math.min(...ap) < 0.05, `steady bounce heights ${ap.map((a) => a.toFixed(2))}`);
  });
}

for (const name of ['cross-rl', 'cross-lr']) {
  test(`crossover (${name}): diagonal travel across the body with a bounce, caught by the other hand, spinning`, async () => {
    const r = await scene(name);
    assertCleanDribble(name, r);
    const xs = r.log.map((l) => l.p[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 0.8, `lateral travel ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} m`);
    const hands = [...new Set(r.log.map((l) => l.hand).filter(Boolean))];
    assert.strictEqual(hands.length, 2, 'both hands');
    assert.ok(r.log.some((l) => len(l.w) > 5), 'the hand gives it spin');
  });
}

test('between the legs: through the real gap under the pelvis (no leg penetration)', async () => {
  for (const name of ['btl', 'btl-narrow']) {
    const r = await scene(name);
    assertCleanDribble(name, r);
    const zs = r.log.map((l) => l.p[2]);
    assert.ok(Math.min(...zs) < r.pelvis[2] - 0.1 && Math.max(...zs) > r.pelvis[2] + 0.1, `${name}: passes under the body (${Math.min(...zs).toFixed(2)}..${Math.max(...zs).toFixed(2)})`);
    if (name === 'btl-narrow') assert.ok(r.maxLegYield > 0 && r.maxLegYield <= r.sys.cfg.legYieldMax + 1e-6, `bounded leg IK made room (${(r.maxLegYield * 100).toFixed(1)} cm)`);
  }
});

test('behind the back: around the pelvis, from one hand to the other', async () => {
  const r = await scene('btb');
  assertCleanDribble('btb', r);
  const free = r.log.filter((l) => /AIRBORNE|BOUNCE|FLOOR/.test(l.state));
  assert.ok(free.length && free.every((l) => l.p[2] < r.pelvis[2] - 0.15), 'the flight stays behind the pelvis');
  assert.strictEqual(new Set(r.log.map((l) => l.hand).filter(Boolean)).size, 2);
});

test('moving dribble: the ball travels with the player, every catch made', async () => {
  const r = await scene('moving');
  assertCleanDribble('moving', r);
  assert.ok(r.final.p[2] > 5, `travelled ${r.final.p[2].toFixed(2)} m`);
});

test('teleport / new possession: the body jumps metres, the ball on the new palm stays there (no swept limb, no pop velocity)', async () => {
  const { R, BP, LAB } = await mods;
  const sys = new BP.BasketballPhysicsSystem(R, {});
  const sc = LAB.scenes()['dribble-right'];
  const f = sc.at(0), J1 = f.joints;
  const shift = (J, d) => (typeof J === 'function' ? (n) => { const v = J(n); return v && [v[0] + d[0], v[1], v[2] + d[1]]; }
    : Object.fromEntries(Object.entries(J).map(([k, v]) => [k, Array.isArray(v) ? [v[0] + d[0], v[1], v[2] + d[1]] : v])));
  const far = BP.bodySampleFromJoints(shift(J1, [1.6, 4.6]), sys.cfg, sys.legYield), here = BP.bodySampleFromJoints(J1, sys.cfg, sys.legYield);
  // the body plays a moment at the old spot (limb and palm velocities history there)
  sys.placeBall([5, 1, 9]);
  for (let i = 0; i < 20; i++) sys.advance(1 / 60, far, far, f.intent, f.intent);
  // new possession here: the body is snapped, the ball placed on the palm
  sys.snapBody(here);
  sys.placeBall(sys.palmTarget(here.palms[f.intent.hand]));
  let vmax = 0;
  for (let i = 0; i < 12; i++) { sys.advance(1 / 60, here, here, f.intent, f.intent); vmax = Math.max(vmax, len(sys.cur.v)); }
  sys.dispose?.();
  assert.ok(vmax < 3, `ball speed after the reset ${vmax.toFixed(1)} m/s (a swept / popped limb throws it at hundreds)`);
});

test('gather: a bounce into a two-hand hold (possession control)', async () => {
  const r = await scene('gather');
  assert.strictEqual(r.sys.lost, false);
  assert.strictEqual(r.stats.penetrations.length, 0);
  assert.ok(/POSSESSION_CONTROL|HAND_CONTACT/.test(r.sys.state), r.sys.state);
});

test('states: the dribble passes through the documented state machine', async () => {
  const { BP } = await mods;
  const r = await scene('cross-rl');
  for (const s of ['HAND_CONTACT', 'HAND_RELEASE', 'AIRBORNE', 'BOUNCE_RISING', 'HAND_APPROACH', 'POSSESSION_CONTROL']) assert.ok(r.statesSeen.includes(s), `${s} in ${r.statesSeen}`);
  for (const s of r.statesSeen) assert.ok(BP.BALL_STATES.includes(s), s);
});

test('physics rate: fixed step at the configured rate (not the frame rate), faster when the ball is fast', async () => {
  for (const hz of [120, 180]) {
    const r = await scene('pound', { hz, hzFast: hz });
    assertCleanDribble(`pound @${hz}`, r);
    assert.ok(Math.abs(r.stats.stepHz - hz) < 2, `stepped at ${r.stats.stepHz} Hz`);
  }
});

test('ballistic aim (shots, passes): gravity and air damping included — lands on target', async () => {
  const { R, BP } = await mods;
  const ph = new BP.BasketballPhysicsSystem(R, {});
  ph.placeBall([1.5, 2.6, 5.5]);
  const to = [0, 3.08, 0], T = 1.14;
  ph.throwBall(ph.ballisticTo(to, T), 'both');
  let best = Infinity, t = 0;
  while (t < 2) { ph.advance(1 / 240, null, null, { has: false }, { has: false }); t += 1 / 240; if (ph.cur.v[1] < 0) best = Math.min(best, dist(ph.cur.p, to)); }
  assert.ok(best < 0.03, `passes within ${(best * 100).toFixed(1)} cm of the target`);
});

test('catch match: the release aims the bounce where the catching hand will be (spin and floor friction included)', async () => {
  const { R, BP } = await mods;
  const ph = new BP.BasketballPhysicsSystem(R, {});
  ph.placeBall([0, 0.85, 0]);
  const catchT = [0.6, 0.8, 0.3], catchIn = 0.5;
  const v = ph.catchMatch(ph.bounceMatch ? [0, ph.bounceMatch(-4, { catchTarget: catchT, catchIn }), 0] : [0, -4, 0], { catchTarget: catchT, catchIn });
  ph.impartVelocity(v);
  let t = 0;
  while (t < catchIn - 1e-6) { ph.advance(1 / 240, null, null, { has: false }, { has: false }); t += 1 / 240; }
  const e = Math.hypot(ph.cur.p[0] - catchT[0], ph.cur.p[2] - catchT[2]);
  assert.ok(ph.stats.bounces === 1, 'one bounce');
  assert.ok(e < 0.06, `horizontal miss at the catch ${(e * 100).toFixed(1)} cm`);
});

test('live tuning: radius / mass / restitution change the simulation without a restart', async () => {
  const { R, BP } = await mods;
  const drop = (patch) => {
    const ph = new BP.BasketballPhysicsSystem(R, {});
    ph.setConfig(patch);
    ph.placeBall([0, 1.5, 0]);
    for (let i = 0; i < 240 * 1.5; i++) ph.advance(1 / 240, null, null, { has: false }, { has: false });
    return ph.stats.apexes[0];
  };
  const base = drop({}), dead = drop({ courtRestitution: 0.4, ballRestitution: 0.4 });
  assert.ok(dead < base * 0.6, `lower restitution, lower bounce (${base.toFixed(2)} → ${dead.toFixed(2)})`);
});

// ── contact IK on the real character rig ────────────────────────────────────
async function playerRig() {
  const { MS, A } = await mods;
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib/mocap/mhr-rigs/player.json.gz'))));
  const rig = MS.prepareMhr(json, A.MHR70);
  const mats = new Float32Array(rig.n * 16);
  for (let j = 0; j < rig.n; j++) mats[j * 16] = mats[j * 16 + 5] = mats[j * 16 + 10] = mats[j * 16 + 15] = 1;
  return { rig, mats };
}

test('contact IK: the arm reaches (bone lengths kept, shoulder fixed) — it moves the hand, never the ball', async () => {
  const { IK } = await mods;
  const { rig, mats } = await playerRig();
  const P = (n) => IK.jointPos(mats, rig, rig.JI[n]);
  const S0 = P('r_uparm'), E0 = P('r_lowarm'), W0 = P('r_wrist');
  const delta = [0.05, 0.04, 0.06];
  IK.reachArm(mats, rig, 'r', delta);
  const S1 = P('r_uparm'), E1 = P('r_lowarm'), W1 = P('r_wrist');
  assert.ok(dist(W1, W0.map((v, i) => v + delta[i])) < 0.002, 'wrist reaches the target');
  assert.ok(Math.abs(dist(S1, E1) - dist(S0, E0)) < 1e-4 && Math.abs(dist(E1, W1) - dist(E0, W0)) < 1e-4, 'bone lengths kept');
  assert.ok(dist(S0, S1) < 1e-5, 'shoulder fixed');
});

test('contact IK: fingers conform to the ball surface (no finger inside the ball)', async () => {
  const { IK } = await mods;
  const { rig, mats } = await playerRig();
  const f = IK.palmFrame(mats, rig, 'r');
  const R = 0.12, ball = f.c.map((v, i) => v + f.n[i] * (R + 0.014) + f.y[i] * 0.012);
  IK.conformFingers(mats, rig, 'r', ball, R, { grip: true, rf: 0.0095 });
  for (const n of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    const tip = IK.jointPos(mats, rig, rig.JI[`r_${n}_null`]);
    assert.ok(dist(tip, ball) > R + 0.0095 - 0.004, `${n} tip outside the ball (${((dist(tip, ball) - R) * 100).toFixed(1)} cm from the surface)`);
  }
});

// ── the hand's own skin against the ball (contact-ik buildHandContact / resolveHandBall) ──
async function rigAt(id) {
  const { MS, A } = await mods;
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, `lib/mocap/mhr-rigs/${id}.json.gz`))));
  const rig = MS.prepareMhr(json, A.MHR70);
  const mats = new Float32Array(rig.n * 16);
  for (let j = 0; j < rig.n; j++) mats[j * 16] = mats[j * 16 + 5] = mats[j * 16 + 10] = mats[j * 16 + 15] = 1;
  return { json, rig, mats };
}

test('hand skin: each hand is sorted into its rigid palm and phalanges, with hinges that flex toward the palm (player / AC)', async () => {
  const { IK, A } = await mods;
  for (const id of ['player', 'ac-001']) {
    const { json, rig } = await rigAt(id);
    const hc = IK.buildHandContact(json, rig, A.b64);
    assert.ok(hc, `${id}: built from its mesh`);
    for (const s of ['l', 'r']) {
      const H = hc[s];
      assert.ok(H.palm.length > 50, `${id} ${s}: the palm has skin (${H.palm.length})`);
      assert.strictEqual(H.segs.length, 16, 'thumb root + 5 × 3 phalanges');
      for (const sg of H.segs) {
        // (the stock player's thumb skin is (nearly) all on thumb0 — the rigid palm: its thumb joints carry
        // little or none, nothing drawn to move; AC's every phalanx has skin)
        if (sg.f !== 'thumb' || id === 'ac-001') assert.ok(sg.verts.length > 0, `${id} ${s} ${sg.f}${sg.k}: has skin`);
        if (!sg.hinge0) continue;
        // +θ about the bind hinge turns the phalanx toward the palm normal (flexion) on both hands
        const a = rig.b[sg.j], d = [0, 1, 2].map((k) => rig.b[sg.jc][k] - a[k]), u = sg.hinge0, th = 0.3;
        const cr = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]], ud = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
        const r = [0, 1, 2].map((k) => d[k] * Math.cos(th) + cr[k] * Math.sin(th) + u[k] * ud * (1 - Math.cos(th)));
        const dn = (v) => v[0] * H.bindN[0] + v[1] * H.bindN[1] + v[2] * H.bindN[2];
        assert.ok(dn(r) > dn(d), `${id} ${s} ${sg.f}${sg.k}: the hinge flexes toward the palm`);
      }
    }
    const sub = IK.buildHandContact(json, rig, A.b64, { maxPerSeg: IK.HAND.maxPerSeg, maxPalm: IK.HAND.maxPalm });
    for (const sg of sub.r.segs) assert.ok(sg.verts.length <= IK.HAND.maxPerSeg, 'subsampled');
    assert.ok(sub.r.palm.length <= IK.HAND.maxPalm && sub.r.all.length === hc.r.n, 'palm subsampled; the final check sees every vertex');
  }
  assert.strictEqual(IK.buildHandContact({ kind: 'mhr', mhr: {} }, (await rigAt('player')).rig, (await mods).A.b64), null, 'no mesh: null (the joint passes stay in charge)');
});

test('hand skin: a ball buried in the palm (the old 1 cm palm) ends with every skin vertex outside it, the palm on it and the fingertips gripping it', async () => {
  const { IK, A, MS } = await mods;
  for (const id of ['player', 'ac-001']) {
    const { json, rig, mats: M0 } = await rigAt(id);
    const full = IK.buildHandContact(json, rig, A.b64), hc = IK.buildHandContact(json, rig, A.b64, { maxPerSeg: IK.HAND.maxPerSeg, maxPalm: IK.HAND.maxPalm });
    for (const s of ['l', 'r']) {
      const mats = M0.slice(), R = 0.12, f = IK.palmFrame(mats, rig, s), p = f.c.map((v, i) => v + f.n[i] * (R + 0.014));
      const H = full[s], gap = (v) => Math.hypot(H.pos[v * 3] - p[0], H.pos[v * 3 + 1] - p[1], H.pos[v * 3 + 2] - p[2]) - R;
      MS.skinVerts(H.v0, H.si, H.sw, mats, H.pos);
      let before = Infinity; for (let v = 0; v < H.n; v++) before = Math.min(before, gap(v));
      assert.ok(before < -0.01, `${id} ${s}: the old palm target buries the ball in the hand (${(-before * 1000).toFixed(0)} mm)`);
      const r = IK.resolveHandBall(mats, rig, hc[s], s, { p, R }, { grip: 1 });
      MS.skinVerts(H.v0, H.si, H.sw, mats, H.pos);
      let worst = Infinity; for (let v = 0; v < H.n; v++) worst = Math.min(worst, gap(v));
      assert.ok(worst >= 0.001 - 1e-4, `${id} ${s}: every vertex of the full hand skin ≥ 1 mm outside (${(worst * 1000).toFixed(2)} mm)`);
      assert.ok(Math.abs(r.depth + worst) < 1e-4, `${id} ${s}: the reported depth is the real one (${(r.depth * 1000).toFixed(2)} mm)`);
      let pg = Infinity; for (const v of H.palm) pg = Math.min(pg, gap(v));
      assert.ok(pg <= 0.01, `${id} ${s}: the palm rests on the ball (${(pg * 1000).toFixed(1)} mm)`);
      const tips = H.segs.filter((sg) => sg.k === 2 && sg.f !== 'thumb').filter((sg) => { let m = Infinity; for (const v of sg.verts) m = Math.min(m, gap(v)); return m < 0.006; }).length;
      assert.ok(tips >= 3, `${id} ${s}: the fingertips grip it (${tips} of 4 on the surface)`);
    }
  }
});

test('contact IK: a catch reach is bounded and ramps in (ikCatchMax)', async () => {
  const { R, BP } = await mods;
  const ph = new BP.BasketballPhysicsSystem(R, {});
  const body = { palms: { right: { c: [0.3, 0.9, 0.3], n: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], h: [0.04, 0.05, 0.007], q: [0, 0, 0, 1] } } };
  ph.hand = 'right'; ph.state = 'LOOSE'; ph.ctl = { mode: 'loose' }; ph.placeBall([0.3, 0.9, 0.75]);
  let out = null;
  for (let i = 0; i < 20; i++) { ph.time += 0.01; out = ph.ikControl(body); }
  assert.ok(out.reachMax > ph.cfg.ikMax && out.reachMax <= ph.cfg.ikCatchMax + 1e-9, `reach ${out.reachMax}`);
});

// ── single-camera repair and two-camera triangulation ───────────────────────
test('single camera: a recorded ball path through the legs is moved out along the camera depth axis', async () => {
  const { BP } = await mods;
  // a body: two vertical leg capsules at x = ±0.12; a recorded flight straight through the left one
  const S = { caps: { thigh_l: { a: [0.12, 0.9, 0], b: [0.12, 0.5, 0], r: 0.078 }, shin_l: { a: [0.12, 0.5, 0], b: [0.12, 0.1, 0], r: 0.056 } }, boxes: {}, palms: {} };
  const F = 20, ball = [];
  for (let i = 0; i < F; i++) {
    const held = i < 3 || i > 16;
    ball.push({ held, hand: 'right', p: held ? [0.12, 0.8, 0.45] : [0.12, 0.8 - 0.6 * Math.sin((Math.PI * (i - 3)) / 14), 0.45 - 0.45 * Math.sin((Math.PI * (i - 3)) / 14)] });
  }
  const clip = { F, fps: 30, ball, loop: false };
  const rep = BP.repairClipBall(clip, () => S, { margin: 0.02, viewDir: [0, 0, 1] });
  assert.ok(rep.frames > 0, 'frames moved');
  for (const b of clip.ball) if (!b.held) {
    for (const c of Object.values(S.caps)) {
      const t = Math.max(0, Math.min(1, (b.p[1] - c.a[1]) / (c.b[1] - c.a[1])));
      const q = [c.a[0], c.a[1] + (c.b[1] - c.a[1]) * t, c.a[2]];
      assert.ok(dist(b.p, q) - c.r - 0.12 > -0.005, `clear of the leg (${((dist(b.p, q) - c.r - 0.12) * 100).toFixed(1)} cm)`);
    }
  }
  for (const i of [0, 1, 2, 17, 18, 19]) assert.deepStrictEqual(clip.ball[i].p, [0.12, 0.8, 0.45], 'hands untouched');
});

test('two cameras: triangulation recovers the 3-D ball path (DLT, ~1 cm with 1 px noise at 6 m)', () => {
  const K = [[1000, 0, 640], [0, 1000, 360], [0, 0, 1]];
  const look = (eye, at) => {
    const f = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]], fl = Math.hypot(...f), z = f.map((v) => v / fl);
    const x0 = [z[2], 0, -z[0]], xl = Math.hypot(...x0), x = x0.map((v) => v / xl);
    const y = [x[1] * z[2] - x[2] * z[1], x[2] * z[0] - x[0] * z[2], x[0] * z[1] - x[1] * z[0]].map((v) => -v);
    const Rm = [x, y, z], t = Rm.map((r) => -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]));
    return { K, R: Rm, t };
  };
  const camA = look([0, 1.2, 6], [0, 0.6, 0]), camB = look([5, 1.4, 3], [0, 0.6, 0]);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const truth = [], trA = [], trB = [];
  for (let i = 0; i < 40; i++) {
    const t = i / 30, y = Math.abs(0.9 * Math.cos(t * 5)) + 0.12;
    const X = [-0.4 + 0.02 * i, y, 0.4 - 0.01 * i];
    truth.push(X);
    const a = TRI.project(camA, X), b = TRI.project(camB, X);
    trA.push([a[0] + rnd(), a[1] + rnd()]); trB.push(i === 11 ? null : [b[0] + rnd(), b[1] + rnd()]);
  }
  const out = TRI.triangulateTrack([{ cam: camA, track: trA }, { cam: camB, track: trB }]);
  assert.strictEqual(out[11], null, 'one view only: no depth, no point');
  const errs = out.map((o, i) => (o ? dist(o.p, truth[i]) : null)).filter((e) => e != null);
  assert.ok(errs.length === 39 && Math.max(...errs) < 0.015, `max error ${(Math.max(...errs) * 100).toFixed(2)} cm`);
  assert.ok(out.filter(Boolean).every((o) => o.reprojErr < 3), 'rays meet (reprojection < 3 px)');
});
