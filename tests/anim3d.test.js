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

test('bad frames: a body cut off by the frame edge is re-made, not trusted', () => {
  const fr = (i, cut) => {
    const kp2d = Array.from({ length: 70 }, () => [300, 250]);
    if (cut) kp2d[J.nose] = [300, -40];
    return { kp2d, kp3d: Array.from({ length: 70 }, () => [0, 0, 5]), camT: [0, 0, 5], imgW: 640, imgH: 480, bbox: [200, cut ? 0 : 40, 400, 470] };
  };
  const src = Array.from({ length: 10 }, (_, i) => fr(i, i === 6));
  assert.deepStrictEqual(MB.badFrames(src).map((b) => b.i), [6]);
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
