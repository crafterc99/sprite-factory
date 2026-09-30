/**
 * 3D animation set tests — game clips (clip-builder), character skinning and
 * the runtime (engine3d/anim3d.mjs): retargeting, foot planner, recorded
 * locomotion, actions. Synthetic data only (no captures, no keys).
 *
 * The runtime is measured the way a player sees it: world positions of
 * planted feet (slide), facing, travel.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/mocap/skeleton');
const MG = require('../lib/mocap/mesh-guide');
const CB = require('../lib/mocap/clip-builder');
const MB = require('../lib/mocap/motion-builder');
const { synthWalk } = require('../lib/mocap/synth');
const { poseAt } = require('../lib/mocap/mock');
const { defaultWarps } = require('../lib/mocap/game-roles');
const GEN = require('../lib/mocap/motion-gen');
const K = require('../lib/mocap/kimodo');

const A = import('../engine3d/anim3d.mjs');
const { J } = S;

// ── fixtures ────────────────────────────────────────────────────────────────
/** The mock pose with real (non-coincident) finger joints. */
function handPose(t) {
  const P = poseAt(t).P.map((p) => p.slice());
  const F = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  for (const side of ['left', 'right']) {
    const w = P[J[`${side}-wrist`]], sx = side === 'left' ? 1 : -1;
    F.forEach((f, fi) => ['third-joint', 'second-joint', 'first-joint', 'tip'].forEach((k, ki) => {
      P[J[`${side}-${f}-${k}`]] = [w[0] + sx * (fi - 2) * 0.018, w[1] - 0.03 - ki * 0.022, w[2] + 0.02 + ki * 0.004];
    }));
  }
  return P;
}
function mockRigJson(scale = 1) {
  const P = poseAt(0).P.map((p) => S.scale(p, scale));
  const Q = S.withPelvis(P);
  const boneLen = S.PARENT.map((p, k) => (p < 0 ? 0 : S.dist(Q[k], Q[p])));
  const legLen = (boneLen[J['left-knee']] + boneLen[J['left-ankle']] + boneLen[J['right-knee']] + boneLen[J['right-ankle']]) / 2;
  return { id: 'mock', name: 'Mock', heightM: 1.8 * scale, restJoints: P, boneLen, parent: S.PARENT, legLen, soleOffset: 0 };
}
/** A standing dribble (the mock) as an idle loop with a real ball cycle. */
function idleClip() {
  const fps = 12, frames = [], balls = [];
  for (let i = 0; i < 36; i++) {
    const { P, ball } = poseAt(i / fps);
    frames.push(P);
    const w = P[J['right-wrist']];
    balls.push({ p: ball, held: S.dist(ball, w) < 0.2, hand: 'right' });
  }
  return CB.buildGameClip({ worldFrames: frames, fps, statureM: 1.75, balls }, { type: 'loop', role: 'idle', name: 'idle' });
}
const walkClip = (role, dir, speed = 1.6, type = 'loop', seconds = 4) => {
  const w = synthWalk({ fps: 30, seconds, speed, dir, cycle: 0.8, drift: [0.15, 0] });
  return CB.buildGameClip({ worldFrames: w.frames, fps: 30, statureM: 1.75 }, { type, role, name: role });
};
function simulate(P, A_, seconds, inp, dt = 1 / 60) {
  const HOOP = [0, 0];
  const events = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const r = P.update(dt, { face: HOOP, ...inp(i * dt) });
    events.push(...r.events);
  }
  return events;
}
const faceErr = (P) => Math.abs(((P.yaw - Math.atan2(-P.pos[0], -P.pos[1])) + Math.PI * 3) % (Math.PI * 2) - Math.PI);

// ── skinning ────────────────────────────────────────────────────────────────
test('skinning: runtime bone matrices reproduce the mesh-guide surface binding exactly', async () => {
  const { segMatrices, invertSegMatrices, boneMatrices, NSEG, NJ } = await A;
  assert.strictEqual(NSEG, MG.SEGS.length);
  // a binding like bindMesh makes: each vertex is ONE rest point seen from two
  // segments (local coords from each segment's rest frame)
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const flat = (P) => { const f = new Float32Array(NJ * 3); S.withPelvis(P).forEach((p, k) => f.set(p, k * 3)); return f; };
  const rest = handPose(0), pose = handPose(0.37).map((p) => [p[0] * 1.02 + 0.3, p[1], p[2] - 0.2]);
  const RF = segMatrices(flat(rest));
  const n = 400, bind = { n, seg: new Uint8Array(n * 2), wt: new Float32Array(n), loc: new Float32Array(n * 6) };
  const pts = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rnd() * NSEG), k2 = (k + 1 + Math.floor(rnd() * 3)) % NSEG;
    bind.seg[i * 2] = k; bind.seg[i * 2 + 1] = k2; bind.wt[i] = 0.3 + 0.7 * rnd();
    const o = k * 16, L = Math.hypot(RF[o], RF[o + 1], RF[o + 2]);
    const t = rnd(), a = (rnd() - 0.5) * 0.12, b = (rnd() - 0.5) * 0.12;
    const p = [0, 1, 2].map((c) => RF[o + 12 + c] + RF[o + c] * t + RF[o + 4 + c] * a + RF[o + 8 + c] * b);
    pts.push(p);
    for (const [slot, kk] of [[0, k], [1, k2]]) {
      const q = kk * 16, LL = Math.hypot(RF[q], RF[q + 1], RF[q + 2]);
      const d = [0, 1, 2].map((c) => p[c] - RF[q + 12 + c]);
      bind.loc[i * 6 + slot * 3] = (d[0] * RF[q] + d[1] * RF[q + 1] + d[2] * RF[q + 2]) / (LL * LL);
      bind.loc[i * 6 + slot * 3 + 1] = d[0] * RF[q + 4] + d[1] * RF[q + 5] + d[2] * RF[q + 6];
      bind.loc[i * 6 + slot * 3 + 2] = d[0] * RF[q + 8] + d[1] * RF[q + 9] + d[2] * RF[q + 10];
    }
    void L;
  }
  const vRest = MG.poseMesh(bind, rest), vPose = MG.poseMesh(bind, pose);
  // the rest frames agree with mesh-guide's own (posing on the rest skeleton returns the points)
  let restErr = 0;
  for (let i = 0; i < n; i++) restErr = Math.max(restErr, Math.hypot(vRest[i * 3] - pts[i][0], vRest[i * 3 + 1] - pts[i][1], vRest[i * 3 + 2] - pts[i][2]));
  assert.ok(restErr < 1e-4, `rest frames differ by ${(restErr * 1000).toFixed(3)} mm`);
  const B = boneMatrices(flat(pose), invertSegMatrices(segMatrices(flat(rest))));
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const out = [0, 0, 0];
    for (const [slot, w] of [[0, bind.wt[i]], [1, 1 - bind.wt[i]]]) {
      const o = bind.seg[i * 2 + slot] * 16, x = vRest[i * 3], y = vRest[i * 3 + 1], z = vRest[i * 3 + 2];
      for (let r = 0; r < 3; r++) out[r] += w * (B[o + r] * x + B[o + 4 + r] * y + B[o + 8 + r] * z + B[o + 12 + r]);
    }
    worst = Math.max(worst, Math.hypot(out[0] - vPose[i * 3], out[1] - vPose[i * 3 + 1], out[2] - vPose[i * 3 + 2]));
  }
  assert.ok(worst < 2e-4, `GPU skinning differs from poseMesh by ${(worst * 1000).toFixed(3)} mm`);
});

// ── clips ───────────────────────────────────────────────────────────────────
test('game clip from a drifting synthetic walk: contacts, root motion, loop, pinned feet', () => {
  const w = synthWalk({ fps: 30, seconds: 3, speed: 1.4, dir: 0, drift: [0.25, 0] });
  const c = CB.buildGameClip({ worldFrames: w.frames, fps: 30, statureM: 1.75, viewDir: [1, 0, 0] }, { type: 'loop' });
  assert.ok(Math.abs(c.stats.speed - 1.4) < 0.08, `speed ${c.stats.speed}`);
  assert.ok(Math.abs(c.stats.dirDeg) <= 3, `dir ${c.stats.dirDeg}`);
  assert.ok(c.quality.contacts.left >= 2 && c.quality.contacts.right >= 2);
  assert.ok(c.quality.slidePinnedCm < 1.5, `pinned slide ${c.quality.slidePinnedCm} cm`);
  assert.ok(c.loop && c.loop.poseErrCm < 3, `loop ${JSON.stringify(c.loop)}`);
  assert.ok(Math.abs(c.quality.depthDriftRemovedM - 0.25) < 0.08, `depth drift ${c.quality.depthDriftRemovedM}`);
  // replayed twice, a planted foot stays on one spot (root motion matches the feet)
  const rp = CB.replayClip(c, { cycles: 2 });
  const on = c.contacts.left.on.concat(c.contacts.left.on).map(Boolean);
  const cont = { left: { on, intervals: [] }, right: { on: [], intervals: [] } };
  let s0 = -1; on.forEach((x, i) => { if (x && s0 < 0) s0 = i; if ((!x || i === on.length - 1) && s0 >= 0) { cont.left.intervals.push([s0, x ? i : i - 1]); s0 = -1; } });
  assert.ok(CB.slideMetric(rp, cont, 0.075).worstCm < 2.5, 'replay slide');
});

test('dribble loop holds a whole ball cycle; held balls ride the palm', () => {
  const c = idleClip();
  assert.ok(c.loop, 'loop found');
  const held = c.ball.filter((b) => b && b.held).length, free = c.ball.filter((b) => b && !b.held).length;
  assert.ok(held > 0 && free > 0, `held ${held} free ${free}`);
  assert.ok(c.ball.filter((b) => b && b.held).every((b) => b.off && Math.hypot(...b.off) < 0.3), 'palm offsets');
  assert.deepStrictEqual(c.quality.flags.filter((f) => f.level === 'bad'), []);
});

test('warp: travel the camera cannot measure is set to the intended displacement', () => {
  const w = synthWalk({ fps: 30, seconds: 2, speed: 1.2, dir: 0 });
  const raw = { worldFrames: w.frames, fps: 30, statureM: 1.75 };
  const base = CB.buildGameClip(raw, { type: 'action' });
  const c = CB.buildGameClip(raw, { type: 'action', warp: [{ from: 10, to: 40, dx: 0, dz: -0.8 }] });
  const { rootMotion } = CB.decodeClip(c);
  let x = 0, z = 0, yaw = 0;
  for (let i = 10; i < 40; i++) { const d = [Math.cos(yaw) * rootMotion[i][0] + Math.sin(yaw) * rootMotion[i][1], -Math.sin(yaw) * rootMotion[i][0] + Math.cos(yaw) * rootMotion[i][1]]; x += d[0]; z += d[1]; yaw += rootMotion[i][2]; }
  assert.ok(Math.hypot(x, z + 0.8) < 0.01, `warped travel ${x.toFixed(3)},${z.toFixed(3)}`);
  assert.ok(c.quality.warps[0].correctionCm > 50);
  assert.ok(base.quality.warps.length === 0);
  // step-back defaults: hop straight back, from the step frame to the landing
  const fake = { shot: { stepFrame: 5, releaseFrame: 12 }, frameCount: 20, contacts: { left: { on: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, right: { on: new Array(20).fill(0) } }, stats: { hipHeight: 0.8 } };
  const dw = defaultWarps('shot-stepback', fake);
  assert.strictEqual(dw[0].from, 5); assert.strictEqual(dw[0].to, 11); assert.ok(dw[0].dz < -0.8);
});

test('bad frames: a body cut off by the frame edge is re-made, not trusted (only the head out: kept)', () => {
  const fr = (i, cut) => {
    const kp2d = Array.from({ length: 70 }, () => [300, 250]);
    if (cut) kp2d[J.nose] = [300, -40];
    if (cut === 'shoulders') { kp2d[J['left-shoulder']] = [260, -10]; kp2d[J['right-shoulder']] = [340, -10]; }
    return { kp2d, kp3d: Array.from({ length: 70 }, () => [0, 0, 5]), camT: [0, 0, 5], imgW: 640, imgH: 480, bbox: [200, cut ? 0 : 40, 400, 470] };
  };
  // head and shoulders past the edge: SAM guesses the whole body → dropped
  const src = Array.from({ length: 10 }, (_, i) => fr(i, i === 6 ? 'shoulders' : false));
  assert.deepStrictEqual(MB.badFrames(src).map((b) => b.i), [6]);
  // only the head past the top edge (a jump shot filmed close): the body is in view → kept
  const srcHead = Array.from({ length: 10 }, (_, i) => fr(i, i === 6 ? 'head' : false));
  assert.deepStrictEqual(MB.badFrames(srcHead).map((b) => b.i), []);
  // a depth spike too
  const src2 = Array.from({ length: 10 }, (_, i) => ({ ...fr(i, false), camT: [0, 0, i === 4 ? 6.2 : 5] }));
  assert.deepStrictEqual(MB.badFrames(src2).map((b) => b.i), [4]);
});

// ── runtime ─────────────────────────────────────────────────────────────────
test('retarget: clips take the character\'s bone lengths; travel scales with the legs', async () => {
  const { prepareRig, prepareClip, sampleTraj, NJ } = await A;
  const walk = walkClip('loco-fwd', 0, 1.6);
  for (const scale of [1, 1.2]) {
    const rig = prepareRig(mockRigJson(scale));
    const c = prepareClip(walk, rig);
    for (let i = 0; i < c.F; i += 7) {
      const P = c.frames.subarray(i * NJ * 3, (i + 1) * NJ * 3);
      for (const k of rig.topo) {
        const p = rig.parent[k];
        const l = Math.hypot(P[k * 3] - P[p * 3], P[k * 3 + 1] - P[p * 3 + 1], P[k * 3 + 2] - P[p * 3 + 2]);
        assert.ok(Math.abs(l - rig.boneLen[k]) < 1e-4, `bone ${S.MHR70[k]} ${l} vs ${rig.boneLen[k]}`);
      }
    }
    const tr = sampleTraj(c, c.F - 1);
    assert.ok(Math.abs(c.speed - walk.stats.speed * c.k) < 0.05, `speed ${c.speed} vs ${walk.stats.speed}×${c.k}`);
    assert.ok(Math.abs(tr[0]) < 0.05 * c.F, 'detrended loop');
  }
});

test('player: idle, then procedural steps in 8 directions — planted feet never slide, always faces the hoop', async () => {
  const { prepareRig, buildLibrary, Player } = await A;
  const rig = prepareRig(mockRigJson(1));
  const lib = buildLibrary([idleClip()], rig);
  const P = new Player(rig, lib, { x: 0, z: 30, yaw: Math.PI });
  simulate(P, A, 2, () => ({}));
  assert.strictEqual(P.metrics.slideMaxCm, 0, 'idle slide');
  const ball = P.result().ball;
  assert.ok(ball && ball[1] > 0.05 && ball[1] < 1.6, 'ball in play');
  for (let d = 0; d < 8; d++) {
    const a = (d * Math.PI) / 4, mv = [Math.sin(a), Math.cos(a)];
    const p0 = P.pos.slice();
    P.metrics.slideMaxCm = 0;
    const ev = simulate(P, A, 1.2, () => ({ move: mv, sprint: d === 4 }));
    simulate(P, A, 0.8, () => ({}));
    assert.ok(Math.hypot(P.pos[0] - p0[0], P.pos[1] - p0[1]) > 1, `dir ${d} moved`);
    assert.ok(P.metrics.slideMaxCm < 0.5, `dir ${d}: planted foot slid ${P.metrics.slideMaxCm.toFixed(2)} cm`);
    assert.ok(faceErr(P) < 0.06, `dir ${d} facing ${faceErr(P)}`);
    assert.ok(ev.filter((e) => e.type === 'plant').length >= 3, `dir ${d} stepped`);
  }
  // (the mock's legs are near-straight — a stress case; before the soft-IK / heel-lift / velocity fixes this read ~1900)
  assert.ok(P.metrics.popMax < 1200, `pose pops ${P.metrics.popMax.toFixed(0)} m/s²`);
});

test('player: recorded loops drive locomotion (direction blend, phase sync, speed match) without slide', async () => {
  const { prepareRig, buildLibrary, Player } = await A;
  const rig = prepareRig(mockRigJson(1));
  const lib = buildLibrary([idleClip(), walkClip('loco-fwd', 0, 1.8), walkClip('loco-left', Math.PI / 2, 1.4), walkClip('loco-right', -Math.PI / 2, 1.4), walkClip('loco-back', Math.PI, 1.4)], rig);
  const P = new Player(rig, lib, { x: 0, z: 30, yaw: Math.PI });
  simulate(P, A, 1, () => ({}));
  let clipFrames = 0;
  for (const mv of [[0, -1], [1, 0], [0, 1], [-0.7, -0.7], [-1, 0]]) {
    P.metrics.slideMaxCm = 0;
    for (let i = 0; i < 90; i++) { P.update(1 / 60, { face: [0, 0], move: mv }); if (P.source === 'clip-loco') clipFrames++; }
    assert.ok(P.metrics.slideMaxCm < 1, `recorded loop ${mv}: slide ${P.metrics.slideMaxCm.toFixed(2)} cm`);
  }
  simulate(P, A, 1, () => ({}));
  assert.ok(clipFrames > 300, `recorded loops used (${clipFrames} frames)`);
  assert.strictEqual(P.source, 'proc');
});

test('player: an action plays with root motion from its best entry frame and hands the feet back', async () => {
  const { prepareRig, buildLibrary, Player } = await A;
  const rig = prepareRig(mockRigJson(1));
  const move = walkClip('move-hesi', 0, 1.5, 'action', 1.6);
  const lib = buildLibrary([idleClip(), move], rig);
  const P = new Player(rig, lib, { x: 0, z: 30, yaw: Math.PI });
  simulate(P, A, 1, () => ({}));
  const p0 = P.pos.slice();
  const ev = simulate(P, A, 0.05, () => ({ trigger: 'move-hesi' }));
  assert.ok(ev.some((e) => e.type === 'action'), 'started');
  assert.strictEqual(P.mode, 'action');
  const ev2 = simulate(P, A, 3, () => ({}));
  assert.ok(ev2.some((e) => e.type === 'actionEnd'), 'ended');
  assert.strictEqual(P.mode, 'loco');
  const moved = Math.hypot(P.pos[0] - p0[0], P.pos[1] - p0[1]);
  assert.ok(moved > 1.2, `root motion moved ${moved.toFixed(2)} m`);
  assert.ok(P.metrics.slideMaxCm < 2, `action slide ${P.metrics.slideMaxCm.toFixed(2)} cm`);
  // a missing role is reported, not crashed
  const ev3 = simulate(P, A, 0.05, () => ({ trigger: 'move-spin' }));
  assert.ok(ev3.some((e) => e.type === 'missing'));
});

// ── responsive controls, generated clips, matcher ───────────────────────────
const genClip = (g) => { const c = CB.buildGameClip({ worldFrames: g.frames, fps: g.fps, statureM: g.statureM, balls: g.balls }, { type: g.type, role: g.role, name: g.name, entryMax: g.entryMax }); c.id = g.name; return c; };

test('controls: instant first step, quick reversal, slide-in stop with a skid, sprint faces the run', async () => {
  const { prepareRig, buildLibrary, Player } = await A;
  const rig = prepareRig(mockRigJson(1));
  const P = new Player(rig, buildLibrary([idleClip()], rig), { x: 0, z: 9, yaw: Math.PI });
  simulate(P, A, 1, () => ({}));
  let first = null;
  const ev = simulate(P, A, 0.3, () => ({ move: [1, 0] }));
  first = ev.findIndex((e) => e.type === 'lift');
  assert.ok(first >= 0 && first <= 2, `first step on the first frames (event #${first})`);
  assert.ok(Math.hypot(...P.vel) > 1.5, `speed after 0.3 s ${Math.hypot(...P.vel).toFixed(2)}`);
  // reversal
  let t = 0; for (; t < 0.5 && P.vel[0] > 0; t += 1 / 60) P.update(1 / 60, { face: [0, 0], move: [-1, 0] });
  assert.ok(t < 0.15, `reversal took ${(t * 1000).toFixed(0)} ms`);
  // sprint away from the hoop: faces the run; letting go glides into a stop (skid) with planted feet
  simulate(P, A, 1.4, () => ({ move: [0, 1], sprint: true }));
  assert.ok(Math.abs(Math.atan2(Math.sin(P.yaw), Math.cos(P.yaw))) < 0.2, `faces the run (yaw ${P.yaw.toFixed(2)})`);
  const p0 = P.pos.slice(); P.metrics.slideMaxCm = 0;
  const stopEv = simulate(P, A, 1.4, () => ({}));
  const glide = Math.hypot(P.pos[0] - p0[0], P.pos[1] - p0[1]);
  assert.ok(glide > 0.2 && glide < 1.2, `slide-in ${glide.toFixed(2)} m`);
  assert.ok(stopEv.some((e) => e.type === 'stop') && stopEv.some((e) => e.type === 'skid'), 'stop + skid events');
  assert.ok(P.metrics.slideMaxCm < 0.5, `planted feet slid ${P.metrics.slideMaxCm.toFixed(2)} cm (skid excluded)`);
  assert.ok(faceErr(P) < 0.15, 'back to facing the hoop');
});

test('generated run-dribble + crossovers: whole ball cycles, loops, entry windows, hand change', () => {
  const run = genClip(GEN.runDribble()), cr = genClip(GEN.crossover()), cm = genClip(GEN.crossover({ moving: true }));
  assert.ok(run.loop && run.stats.speed > 3.8, `run loop ${JSON.stringify(run.loop)} ${run.stats.speed}`);
  assert.ok(run.ball.some((b) => b?.held) && run.ball.some((b) => b && !b.held), 'dribble cycle');
  for (const c of [cr, cm]) {
    assert.strictEqual(c.ball.find((b) => b?.held).hand, 'right');
    assert.strictEqual([...c.ball].reverse().find((b) => b?.held).hand, 'left');
    assert.ok(c.entry.max > 3, 'entry window up to the cross');
    assert.ok(c.quality.slidePinnedCm < 1.5);
  }
});

test('nearest-pose matcher: variant + mirror + frame chosen from the pose, the ball hand switches', async () => {
  const { prepareRig, buildLibrary, Player, matchPose, clipFeatures } = await A;
  const rig = prepareRig(mockRigJson(1));
  const lib = buildLibrary([idleClip(), genClip(GEN.crossover()), genClip(GEN.crossover({ moving: true }))], rig);
  // a frame matches itself best
  const c = lib['move-crossover'];
  const f = clipFeatures(c);
  const m = matchPose([{ clip: c }], f.subarray(20 * 19, 21 * 19));
  assert.ok(Math.abs(m.frame - 20) <= 1, `self match ${m.frame}`);
  const P = new Player(rig, lib, { x: 0, z: 9, yaw: Math.PI });
  simulate(P, A, 1, () => ({}));
  const hand0 = P.hand;
  const ev = simulate(P, A, 0.05, () => ({ trigger: 'move-crossover' }));
  const pick = ev.find((e) => e.type === 'action');
  assert.ok(pick && /Crossover \(generated\)/.test(pick.clip), `standing picks the standing crossover (${pick && pick.clip})`);
  simulate(P, A, 2.5, () => ({}));
  assert.notStrictEqual(P.hand, hand0, 'ball changed hands');
  // jogging forward (toward the hoop) is nearest to the crossover that enters jogging
  simulate(P, A, 1.0, () => ({ move: [0, -1] }));
  const ev2 = simulate(P, A, 0.05, () => ({ move: [0, -1], trigger: 'move-crossover' }));
  const pick2 = ev2.find((e) => e.type === 'action');
  assert.ok(pick2 && /on the move/.test(pick2.clip), `moving picks the moving crossover (${pick2 && pick2.clip})`);
  assert.ok(P.metrics.slideMaxCm < 1, `slide ${P.metrics.slideMaxCm}`);
});

test('kimodo import: SOMA-77 joints → MHR70, npz reader, scripted dribble arm', () => {
  // a tiny SOMA-shaped skeleton walking forward (joint names from the real skeleton)
  const names = K.SOMA77;
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const P = poseAt(i / 30).P;
    const z = i * 0.05;
    const at = (n) => { const p = P[J[n]]; return [p[0], p[1], p[2] + z]; };
    const m = { Hips: S.mid(at('left-hip'), at('right-hip')), Neck1: at('neck'), Head: S.add(at('neck'), [0, 0.15, 0.02]) };
    for (const [s2, s] of [['Left', 'left'], ['Right', 'right']]) Object.assign(m, { [`${s2}Leg`]: at(`${s}-hip`), [`${s2}Shin`]: at(`${s}-knee`), [`${s2}Foot`]: at(`${s}-ankle`), [`${s2}ToeEnd`]: at(`${s}-big-toe-tip`), [`${s2}Arm`]: at(`${s}-shoulder`), [`${s2}ForeArm`]: at(`${s}-elbow`), [`${s2}Hand`]: at(`${s}-wrist`) });
    frames.push(names.map((n) => m[n] || m.Hips));
  }
  // Kimodo's joint order → the fitted SOMA map: the rest pose (T-pose) gives
  // keypoints next to the matching joints, left on +X, nose in front of the head
  const M77 = require('../lib/mocap/kimodo-mhr70.json').soma77;
  const rest = Array.from({ length: 5 }, (_, i) => M77.rest.map((p) => [p[0], p[1] + 0.999, p[2] + i * 0.05]));
  const tp = K.toMHR70({ skeleton: 'soma', frames: rest });
  assert.strictEqual(tp[0].length, 70);
  assert.ok(tp.every((P) => P.every((q) => q.every(Number.isFinite))), 'finite keypoints');
  const lift = rest[0][names.indexOf('LeftFoot')][1] - tp[0][J['left-ankle']][1]; // the floor snap moved everything down by this
  const at = (k, f = 2) => [tp[f][J[k]][0], tp[f][J[k]][1] + lift, tp[f][J[k]][2]];
  const d = (k, n) => S.len(S.sub(at(k), rest[2][names.indexOf(n)]));
  assert.ok(d('left-knee', 'LeftShin') < 0.06 && d('right-wrist', 'RightHand') < 0.06, `keypoints by their joints (knee ${d('left-knee', 'LeftShin').toFixed(3)} m)`);
  assert.ok(at('left-wrist')[0] > 0.3 && at('right-wrist')[0] < -0.3, 'left = +X');
  assert.ok(at('nose')[2] > rest[2][names.indexOf('Head')][2] + 0.05, 'nose in front');
  // any other skeleton by joint names (the common set): derived surface points
  const alias = K.SKELETONS.soma.alias;
  const mhr = K.toMHR70({ skeleton: 'named', jointNames: names.map((n) => alias[n] || n), frames });
  assert.strictEqual(mhr[0].length, 70);
  assert.ok(Math.abs(mhr[5][J['left-knee']][2] - frames[5][names.indexOf('LeftShin')][2]) < 1e-6, 'knee carried over');
  const lowest = Math.min(...mhr.flatMap((P) => [P[J['left-heel']][1], P[J['right-heel']][1]]));
  assert.ok(Math.abs(lowest) < 1e-6, 'feet on the floor');
  const g = GEN.dribbleOnto(mhr, 30, { hand: 'right' });
  assert.ok(g.balls.some((b) => b.held) && g.balls.some((b) => !b.held), 'scripted dribble has a ball cycle');
  // npz round trip (stored, one float32 array)
  const arr = new Float32Array([1, 2, 3, 4, 5, 6]);
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 2, 3), }";
  const pad = 64 - ((10 + header.length + 1) % 64);
  const hdr = Buffer.from(header + ' '.repeat(pad) + '\n', 'latin1');
  const npy = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY', 'latin1'), Buffer.from([1, 0]), Buffer.from([hdr.length & 255, hdr.length >> 8]), hdr, Buffer.from(arr.buffer)]);
  const name = Buffer.from('posed_joints.npy');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(npy.length, 18); local.writeUInt32LE(npy.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(npy.length, 20); cen.writeUInt32LE(npy.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, npy]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(body.length, 16);
  const z = K.readNpz(Buffer.concat([body, cen, name, eocd]));
  assert.deepStrictEqual(z.posed_joints.shape, [1, 2, 3]);
  assert.deepStrictEqual(Array.from(z.posed_joints.data), [1, 2, 3, 4, 5, 6]);
});

test('MHR rig: solver poses the body model like SAM 3D Body did (rigid bones, cm-level mesh error)', async () => {
  const zlib = require('zlib'), fs = require('fs'), path = require('path');
  const M = await import('../engine3d/mhr-skin.mjs');
  const rig = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/mocap/mhr-rigs/ankh.json.gz'))));
  assert.strictEqual(rig.kind, 'mhr');
  const R = M.prepareMhr(rig, (await A).MHR70);
  assert.strictEqual(R.n, 127);
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mhr-frames.json'), 'utf8'));
  const u = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const verts = u(rig.verts, Float32Array), sIdx = u(rig.mhr.skinIdx, Uint8Array), sW = u(rig.mhr.skinW, Float32Array);
  const gt = new Float32Array(R.n * 16);
  let sum = 0, cnt = 0;
  // the capture at the rig's size (the runtime retargets poses to the rig the same way)
  const J = (await A).J, legOf = (kp) => ['left', 'right'].reduce((t, sd) => t + Math.hypot(...[0, 1, 2].map((c) => kp[J[sd + '-hip']][c] - kp[J[sd + '-knee']][c])) + Math.hypot(...[0, 1, 2].map((c) => kp[J[sd + '-knee']][c] - kp[J[sd + '-ankle']][c])), 0) / 2;
  const k = rig.legLen / (fx.frames.reduce((t, f) => t + legOf(f.kp3d), 0) / fx.frames.length);
  for (const f0 of fx.frames) {
    const f = { ...f0, kp3d: f0.kp3d.map((p) => p.map((x) => x * k)), joints: f0.joints.map((x) => x * k) };
    // camera → world (y up, +Z toward the viewer); the rotations are already in that space
    const P = f.kp3d.flatMap((p) => [p[0], -p[1], -p[2]]);
    const mats = M.mhrBoneMatrices(P, R);
    for (let i = 0; i < R.n; i++) {
      const o = i * 16, c = (k) => [mats[o + k * 4], mats[o + k * 4 + 1], mats[o + k * 4 + 2]];
      const [x, y, z] = [c(0), c(1), c(2)];
      const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      assert.ok(Math.abs(d(x, x) - 1) < 1e-4 && Math.abs(d(y, y) - 1) < 1e-4 && Math.abs(d(x, y)) < 1e-4, 'bones stay rigid (no scale / shear)');
      const G = f.rots.slice(i * 9, i * 9 + 9), B = M._internal.quatToMat(rig.mhr.bindRot[i]);
      const Q = [0, 1, 2].map((r) => [0, 1, 2].map((cc) => G[r * 3] * B[cc][0] + G[r * 3 + 1] * B[cc][1] + G[r * 3 + 2] * B[cc][2]));
      const p = [f.joints[i * 3], -f.joints[i * 3 + 1], -f.joints[i * 3 + 2]], b = R.b[i];
      const t = [0, 1, 2].map((r) => p[r] - (Q[r][0] * b[0] + Q[r][1] * b[1] + Q[r][2] * b[2]));
      gt.set([Q[0][0], Q[1][0], Q[2][0], 0, Q[0][1], Q[1][1], Q[2][1], 0, Q[0][2], Q[1][2], Q[2][2], 0, t[0], t[1], t[2], 1], o);
    }
    const a = M.skinVerts(verts, sIdx, sW, mats), g = M.skinVerts(verts, sIdx, sW, gt);
    for (let v = 0; v < a.length; v += 3) { sum += Math.hypot(a[v] - g[v], a[v + 1] - g[v + 1], a[v + 2] - g[v + 2]); cnt++; }
  }
  const meanCm = (sum / cnt) * 100;
  assert.ok(meanCm < 2.5, `mean vertex error vs SAM 3D Body ${meanCm.toFixed(2)} cm`);
});

test('capture layer: recorded clips replay the capture\'s own arm / hand / finger rotations (mirrored exactly)', async () => {
  const zlib = require('zlib'), fs = require('fs'), path = require('path');
  const M = await import('../engine3d/mhr-skin.mjs'), An = await A;
  const MR = require('../lib/mocap/mhr-rots');
  const rig = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../lib/mocap/mhr-rigs/ankh.json.gz'))));
  const R = M.prepareMhr(rig, An.MHR70);
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mhr-frames.json'), 'utf8')).frames[2];
  const q = []; for (let j = 0; j < 127; j++) q.push(MR.matToQuat(f.rots, j * 9));
  const packed = Buffer.from(MR.packQuats([q]), 'base64');
  const rots = new Int16Array(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
  const clip = { F: 1, loop: false, mirror: false, rots, rotsJoints: 127 };
  const P = f.kp3d.flatMap((p) => [p[0], -p[1], -p[2]]);
  const { quatToMat } = M._internal;
  const mm = (a, b) => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c]));
  const tr = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
  const ang = (a, b) => { const m = mm(a, tr(b)); return Math.acos(Math.max(-1, Math.min(1, (m[0][0] + m[1][1] + m[2][2] - 1) / 2))) * 180 / Math.PI; };
  const rel = (mats, j) => { const c = M.jointWorld(mats, R, R.chest).G, g = M.jointWorld(mats, R, j).G; return mm(tr(c), g); };
  const capRel = (j) => mm(tr(quatToMat(q[R.chest])), quatToMat(q[j]));
  const mats = M.mhrBoneMatricesCaptured(P, R, [{ clip, t: 0, w: 1 }], 1, new Float32Array(127 * 16));
  for (const nm of ['r_wrist', 'l_wrist', 'r_index2', 'l_thumb2', 'r_lowarm', 'c_head']) {
    assert.ok(ang(rel(mats, R.JI[nm]), capRel(R.JI[nm])) < 0.5, `${nm} relative to the chest = capture`);
  }
  const solo = M.mhrBoneMatrices(P, R);
  assert.ok(ang(rel(solo, R.JI.r_index2), capRel(R.JI.r_index2)) > ang(rel(mats, R.JI.r_index2), capRel(R.JI.r_index2)), 'closer to the capture than the solver alone');
  // mirrored copy: the right hand takes the left hand's rotation reflected across the midplane
  const mir = M.mhrBoneMatricesCaptured(P, R, [{ clip: { ...clip, mirror: true }, t: 0, w: 1 }], 1, new Float32Array(127 * 16));
  const S = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], refl = (m) => mm(S, mm(m, S));
  const Qm = (mats2, j) => mm(M.jointWorld(mats2, R, j).G, tr(R.R0[j]));
  const expect = mm(refl(mm(tr(mm(quatToMat(q[R.chest]), tr(R.R0[R.chest]))), mm(quatToMat(q[R.JI.l_wrist]), tr(R.R0[R.JI.l_wrist])))), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  const got = mm(tr(Qm(mir, R.chest)), Qm(mir, R.JI.r_wrist));
  assert.ok(ang(got, expect) < 0.5, 'mirrored hand = reflected partner');
});

test('zoomed SAM 3D Body calls map back to the full frame exactly (2D, 3D direction, camera translation)', () => {
  const Z = require('../lib/mocap/zoom');
  const { poseAt } = require('../lib/mocap/mock');
  const W = 1920, H = 1080, f = 1400;
  // a body 3.5 m away, well off to the right and low in the frame (camera coords: y down)
  const P = poseAt(0.3).P.map((p) => [p[0] - 0.1, -(p[1] - 0.9), p[2]]);   // root-relative, y down
  const T = [1.1, 0.35, 3.5];
  const proj = (p) => [f * (p[0] + T[0]) / (p[2] + T[2]) + W / 2, f * (p[1] + T[1]) / (p[2] + T[2]) + H / 2];
  const kp2d = P.map(proj);
  const xs = kp2d.map((q) => q[0]), ys = kp2d.map((q) => q[1]);
  const crop = Z.cropFor([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], W, H);
  assert.ok(crop.s > 1.5, `the player is enlarged (×${crop.s.toFixed(2)})`);
  // what the model reports for the crop: it sees the person as if on its own optical axis
  const ray = S.norm([(crop.ox + crop.outW / crop.s / 2 - W / 2) / f, (crop.oy + crop.outH / crop.s / 2 - H / 2) / f, 1]);
  const Rinv = S.rotBetween(ray, [0, 0, 1]);
  const body = {
    kp2d: kp2d.map((q) => [(q[0] - crop.ox) * crop.s, (q[1] - crop.oy) * crop.s]),
    kp3d: P.map((p) => S.mulMV(Rinv, p)), camT: S.mulMV(Rinv, T), focal: f * crop.s, bbox: null, mhr: null,
  };
  const out = Z.uncrop(body, crop, { W, H, focal: f });
  const err2d = Math.max(...out.kp2d.map((q, k) => Math.hypot(q[0] - kp2d[k][0], q[1] - kp2d[k][1])));
  const err3d = Math.max(...out.kp3d.map((p, k) => S.dist(p, P[k])));
  assert.ok(err2d < 1e-6, `2D exact (${err2d})`);
  assert.ok(err3d < 1e-6, `3D direction restored (${err3d})`);
  assert.ok(S.dist(out.camT, T) < 0.01, `camera translation re-solved (${S.dist(out.camT, T).toFixed(4)} m)`);
});

test('ball events: a one-hand dribble loop is classified as that hand\'s dribble; a hand change as a crossover', async () => {
  const { prepareRig, prepareClip, classifyBallEvents } = await A;
  const rig = prepareRig(mockRigJson(1));
  const c = prepareClip(idleClip(), rig);
  const ev = c.ballEvents || classifyBallEvents(c);
  assert.deepStrictEqual([...new Set(ev.frames)], ['RIGHT_HAND_DRIBBLE'], ev.segments.map((s) => s.label).join(' '));
  // the same loop with the second half's catches in the other hand: its flights become crossovers
  const cross = { ...c, ball: c.ball.map((b, i) => (b ? { ...b, hand: i >= c.F / 2 ? 'left' : 'right' } : b)) };
  const labels = new Set(classifyBallEvents(cross).frames);
  assert.ok(labels.has('CROSSOVER') && labels.has('LEFT_HAND_DRIBBLE') && labels.has('RIGHT_HAND_DRIBBLE'), [...labels].join(' '));
});
