/**
 * Soul Jam Capture — unit tests (the two-device flow itself: tests/capture-e2e.spec.js).
 * Library + schema (BASIC-01, the state graph), session order + the next missing animation, the
 * shared clock and take alignment, the store (sessions, resumable chunks, assembly), the export's
 * tar layout, and the validators on a generated video.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-unit-'));
process.env.CAPTURE_DIR = TMP;
process.env.CAPTURE_CLOUD = '0';
const store = require('../lib/capture/store');
const media = require('../lib/capture/media');
const validators = require('../lib/capture/validators');
const L = import('../capture/basic01.mjs');
const S = import('../capture/schema.mjs');
const P = import('../capture/protocol.mjs');
const Y = import('../capture/camera-sync.mjs');
const C = import('../capture/court-layout.mjs');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('BASIC-01: 82 valid animations, one source of truth, every record has start + end states', async () => {
  const { BASIC01 } = await L, s = await S;
  assert.strictEqual(BASIC01.animations.length, 82);
  assert.deepStrictEqual(s.validateLibrary(BASIC01), []);
  assert.deepStrictEqual(BASIC01.animations.map((a) => +a.id), Array.from({ length: 82 }, (_, i) => i + 1));
  for (const a of BASIC01.animations) { assert.ok(a.startState && a.endState, a.id); if (a.loop) assert.ok(s.startStates(a).every((x) => x === a.endState), `${a.id} loop`); }
  const by = (k) => BASIC01.animations.find((a) => a.key === k);
  assert.deepStrictEqual([by('cross_RL').startState, by('cross_RL').endState], ['DR', 'DL']);
  assert.deepStrictEqual([by('tween_RL').startState, by('tween_RL').endState], ['DR', 'DL']);
  assert.deepStrictEqual([by('hesi_R').startState, by('hesi_R').endState], ['DR', 'DR']);
  assert.deepStrictEqual([by('jab_R').startState, by('jab_R').endState], ['TR', 'TR']);
  assert.deepStrictEqual([by('jab_drive_R').startState, by('jab_drive_R').endState], ['TR', 'MR']);
  assert.deepStrictEqual([by('jumpshot').startState, by('jumpshot').endState, by('jumpshot').endResolves], ['G', 'LAND', 'N']);
  // 360 locomotion 008–023: eight directions per hand, loops, MR / ML
  const loco = BASIC01.animations.filter((a) => +a.id >= 8 && +a.id <= 23);
  assert.strictEqual(new Set(loco.map((a) => a.direction)).size, 8);
  assert.ok(loco.every((a) => a.loop && a.durationSec === 8 && a.startState === (a.ballHand === 'R' ? 'MR' : 'ML')));
});

test('state graph: states as nodes, animations as edges (chains are possible)', async () => {
  const { BASIC01 } = await L, s = await S;
  const g = s.stateGraph(BASIC01);
  for (const st of ['N', 'TR', 'TL', 'DR', 'DL', 'MR', 'ML', 'G', 'DEF', 'DEF_M', 'LAND']) assert.ok(g.nodes.includes(st), st);
  // DR → DL → DR (a crossover chain) and DR → G → LAND
  assert.ok(g.edges.some((e) => e.from === 'DR' && e.to === 'DL') && g.edges.some((e) => e.from === 'DL' && e.to === 'DR'));
  assert.ok(g.edges.some((e) => e.from === 'DR' && e.to === 'G') && g.edges.some((e) => e.from === 'G' && e.to === 'LAND' && e.resolves === 'N'));
});

test('session order: every setup A animation before B before C; body state then hand within a setup', async () => {
  const { BASIC01 } = await L, p = await P;
  const o = p.captureOrder(BASIC01);
  const setups = o.map((a) => a.courtSetup).join('');
  assert.match(setups, /^A+B+C+$/);
  assert.strictEqual(o[0].key, 'neutral_idle');
  const a = o.filter((x) => x.courtSetup === 'A');
  const i = (k) => a.findIndex((x) => x.key === k);
  assert.ok(i('stationary_dribble_R') < i('cross_RL') && i('cross_RL') < i('stationary_dribble_L'), 'right-hand dribble work before left');
});

test('progress + next missing: continues forward after the accepted one, skips done / skipped, wraps', async () => {
  const { BASIC01 } = await L, p = await P;
  const o = p.captureOrder(BASIC01);
  const sess = { animations: {} };
  let pr = p.progress(BASIC01, sess);
  assert.deepStrictEqual([pr.total, pr.complete, pr.missing, pr.next.id], [82, 0, 82, o[0].id]);
  sess.animations[o[0].id] = { takes: ['t1'], selectedTake: 't1' };
  sess.animations[o[2].id] = { takes: [], selectedTake: null, skipped: true };
  pr = p.progress(BASIC01, sess, { after: o[0].id });
  assert.strictEqual(pr.next.id, o[1].id);
  assert.strictEqual(p.nextMissing(BASIC01, sess, { after: o[1].id }).id, o[3].id, 'skipped one passed over');
  assert.strictEqual(pr.perSetup.A.complete, 1);
  assert.strictEqual(p.nextMissing(BASIC01, sess, { after: o[81].id }).id, o[1].id, 'wraps to the first missing');
  assert.strictEqual(p.takeFolder(o[0], 3), `setup_A/${o[0].key}/take03`);
});

test('clock sync: the lowest-latency samples give the server offset to a few ms', async () => {
  const { ClockSync } = await Y;
  const c = new ClockSync(), trueOff = 123456.7;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const up = 5 + rnd() * 60, down = 5 + rnd() * 60, c0 = 1e6 + i * 1000;
    c.add(c0, c0 + up + trueOff, c0 + up + down);
  }
  const b = c.best;
  assert.ok(Math.abs(b.offsetMs - trueOff) < b.uncertaintyMs + 1, `offset ${b.offsetMs} vs ${trueOff} (±${b.uncertaintyMs})`);
  assert.ok(Math.abs(c.toLocal(c.toServer(5e6)) - 5e6) < 1e-6);
});

test('take alignment from per-frame timestamps: offset, overlap, nearest pairs, measured fps', async () => {
  const { alignTakes, frameStats } = await Y;
  const a = Array.from({ length: 120 }, (_, i) => 1000 + i * (1000 / 60));
  const b = Array.from({ length: 120 }, (_, i) => 1037 + i * (1000 / 60));
  const r = alignTakes(a, b);
  assert.strictEqual(Math.round(r.offsetMs), 37);
  assert.ok(Math.abs(r.fpsA - 60) < 0.1 && r.pairs.length > 100 && r.jitterMs <= 1000 / 120 + 0.01);
  const st = frameStats([0, 16.7, 33.3, 83.3, 100]);
  assert.strictEqual(st.dropped, 1);
});

// a request-like stream for putChunk
const reqOf = (buf) => Object.assign(Readable.from([buf]), { destroy() {} });

test('store: session, takes numbered per animation, resumable chunks (idempotent), assembly, missing chunks refused', async () => {
  const { BASIC01 } = await L;
  const s = await store.createSession({ libraryId: 'BASIC-01' });
  assert.match(s.pair.code, /^\d{6}$/);
  const anim = BASIC01.animations[36];
  const t1 = await store.createRecording(s.id, { kind: 'take', anim, setup: anim.courtSetup, library: { id: 'BASIC-01' } });
  const t2 = await store.createRecording(s.id, { kind: 'take', anim, setup: anim.courtSetup, library: { id: 'BASIC-01' } });
  assert.deepStrictEqual([t1.takeNo, t2.takeNo], [1, 2]);
  assert.strictEqual(t1.startState, 'DR'); assert.strictEqual(t1.endState, 'DL');
  const parts = [Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cc')];
  await store.putChunk(s.id, t1, 'camB', 0, reqOf(parts[0]));
  await store.putChunk(s.id, t1, 'camB', 2, reqOf(parts[2]));
  await assert.rejects(store.assemble(s.id, t1, 'camB', { chunks: 3, ext: 'webm' }), /missing chunks 1/);
  await store.putChunk(s.id, t1, 'camB', 1, reqOf(Buffer.from('XXXX')));
  await store.putChunk(s.id, t1, 'camB', 1, reqOf(parts[1]));                 // a retried chunk replaces itself
  assert.deepStrictEqual((await store.chunkStatus(s.id, t1, 'camB')).have, [0, 1, 2]);
  const a = await store.assemble(s.id, t1, 'camB', { chunks: 3, ext: 'webm' });
  assert.strictEqual(fs.readFileSync(a.path, 'utf8'), 'aaaabbbbcc');
  const s2 = await store.loadSession(s.id);
  assert.deepStrictEqual(s2.animations[anim.id].takes, [t1.id, t2.id]);
  // calibration recordings live apart from takes
  const cal = await store.createRecording(s.id, { kind: 'calibration', setup: 'A', library: { id: 'BASIC-01' } });
  assert.ok(store.recDir(s.id, 'calibration', cal.id).includes(`${path.sep}calibrations${path.sep}`));
  assert.strictEqual((await store.loadSession(s.id)).calibrations.A.takes[0], cal.id);
});

test('export tar: a valid archive with the dataset layout', async () => {
  const f = path.join(TMP, 'data.bin'); fs.writeFileSync(f, Buffer.alloc(1500, 7));
  const out = []; const res = new Writable({ write(c, e, cb) { out.push(c); cb(); } });
  await store.streamTar(res, [
    { name: 'SoulJam_BASIC01/session.json', data: { ok: true } },
    { name: 'SoulJam_BASIC01/setup_A/cross_RL/take01/camA.webm', file: f },
    { name: 'SoulJam_BASIC01/setup_A/a_very_long_animation_key_name_for_the_prefix_field_test/take01/camA.frames.json', data: { frames: [1, 2] } },
  ]);
  const tarFile = path.join(TMP, 'x.tar'); fs.writeFileSync(tarFile, Buffer.concat(out));
  const names = execFileSync('tar', ['-tf', tarFile]).toString().trim().split('\n');
  assert.deepStrictEqual(names, ['SoulJam_BASIC01/session.json', 'SoulJam_BASIC01/setup_A/cross_RL/take01/camA.webm', 'SoulJam_BASIC01/setup_A/a_very_long_animation_key_name_for_the_prefix_field_test/take01/camA.frames.json']);
  const x = path.join(TMP, 'x'); fs.mkdirSync(x); execFileSync('tar', ['-xf', tarFile, '-C', x]);
  assert.strictEqual(fs.statSync(path.join(x, 'SoulJam_BASIC01/setup_A/cross_RL/take01/camA.webm')).size, 1500);
});

test('validators + media on a generated take: probe, motion map, checks', async () => {
  const f = path.join(TMP, 'take.webm');
  execFileSync(media.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-c:v', 'libvpx', '-b:v', '1M', f]);
  const p = await media.probe(f);
  assert.ok(p.ok && Math.abs(p.durationSec - 3) < 0.2 && Math.abs(p.fps - 30) < 1.5 && p.width === 640, JSON.stringify(p));
  const m = await media.motionMap(f, { durationSec: p.durationSec });
  assert.ok(m.bbox, 'the test pattern moves');
  const take = { kind: 'take', sessionId: 's', takeNo: 1, courtSetup: 'A', createdAt: 'x', animId: '001', startState: 'N', endState: 'N', targetDurationSec: 3, cameras: { camA: { track: { frameRate: 30 }, frames: { fps: 30 }, clock: { uncertaintyMs: 4 }, startedAtServerMs: 1000 } } };
  const v = await validators.validate(take, { camA: f }, { cams: ['camA'] });
  assert.ok(v.ok, JSON.stringify(v.checks));
  assert.ok(v.checks.some((c) => c.id === 'duration-camA' && c.level === 'ok'));
  assert.ok(v.planned.length >= 3, 'future validators listed');
  const bad = await validators.validate({ ...take, cameras: {} }, { camA: f }, { cams: ['camA', 'camB'] });
  assert.ok(!bad.ok && bad.checks.some((c) => c.level === 'fail' && /camB/.test(c.msg)));
});

test('court layout: setups A/B/C with cameras + a top-down diagram; paths follow the facing', async () => {
  const c = await C, { BASIC01 } = await L;
  for (const s of ['A', 'B', 'C']) { assert.ok(c.SETUPS[s].camA.pos && c.SETUPS[s].camB.pos && c.SETUPS[s].framing.length); assert.match(c.courtSVG(s), /^<svg[\s\S]+<\/svg>$/); }
  const fwd = BASIC01.animations.find((a) => a.key === 'dribble_forward_R');
  const p = c.playerPath(fwd);
  assert.ok(p.end[1] < p.start[1], 'forward = toward the basket (facing −y)');
  assert.ok(c.COURT.landmarks.rim_centre[2] === 3.05);
});

test('sync chirp: found in two recordings at their own times → the exact camera offset', async () => {
  const SA = require('../lib/capture/sync-audio');
  const tpl = SA.chirpTemplate(), sr = SA.SR;
  let seed = 3; const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3;
  const mk = (atSec) => { const x = new Float32Array(sr * 4); for (let i = 0; i < x.length; i++) x[i] = noise(); const s = Math.round(atSec * sr); for (let i = 0; i < tpl.length; i++) x[s + i] += 0.5 * tpl[i]; return x; };
  const a = SA.findChirp(mk(1.2345), { aroundSec: 1.2 }), b = SA.findChirp(mk(0.9876), { aroundSec: 1.1 });
  assert.ok(a && Math.abs(a.atSec - 1.2345) < 1 / sr + 1e-6 && a.snr > 3, JSON.stringify(a));
  assert.ok(b && Math.abs(b.atSec - 0.9876) < 1 / sr + 1e-6, JSON.stringify(b));
  assert.ok(Math.abs((a.atSec - b.atSec) - 0.2469) < 2 / sr, 'offset to a sample');
});

test('camera moved: a nudged camera is detected; a player walking through the view is not', async () => {
  const { WebCamera } = await import('../capture/camera.mjs');
  const w = 64, h = 36;
  const scene = (ox, oy, blob) => ({ w, h, px: Array.from({ length: w * h }, (_, i) => { const x = i % w, y = (i / w) | 0; return ((Math.floor((x + ox) / 5) + Math.floor((y + oy) / 4)) % 2 ? 200 : 60) + (blob && Math.hypot(x - blob[0], y - blob[1]) < 7 ? 80 : 0); }) });
  const ref = scene(0, 0, null);
  assert.strictEqual(WebCamera.compare(ref, scene(0, 0, [30, 18])).moved, false, 'a player in frame');
  assert.strictEqual(WebCamera.compare(ref, scene(3, 0, null)).moved, true, 'camera nudged 3 px');
  assert.strictEqual(WebCamera.compare(ref, scene(0, 0, null)).moved, false, 'nothing changed');
});
