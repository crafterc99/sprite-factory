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

test('court layout: setups A/B/C with cameras + a top-down diagram; paths follow the facing; A and B share one camera placement', async () => {
  const c = await C, { BASIC01 } = await L;
  for (const s of ['A', 'B', 'C']) { assert.ok(c.SETUPS[s].camA.pos && c.SETUPS[s].camB.pos && c.SETUPS[s].framing.length); assert.match(c.courtSVG(s), /^<svg[\s\S]+<\/svg>$/); }
  const fwd = BASIC01.animations.find((a) => a.key === 'dribble_forward_R');
  const p = c.playerPath(fwd);
  assert.ok(p.end[1] < p.start[1], 'forward = toward the basket (facing −y)');
  assert.ok(c.COURT.landmarks.rim_centre[2] === 3.05);
  assert.deepStrictEqual(['A', 'B', 'C'].map(c.stationOf), ['A', 'A', 'C']);
  assert.ok(c.sameStation('A', 'B') && !c.sameStation('B', 'C'));
  // the server's copy of that mapping (lib/capture/hub.js) agrees
  const { STATION_OF } = require('../lib/capture/hub');
  for (const s of ['A', 'B', 'C']) assert.strictEqual(STATION_OF[s], c.stationOf(s), s);
});

test('camera placements: with a phone\'s normal lens each camera sees its whole area head to feet (nearest corner ≥ 4.5 m, ≤ 60° across, ≤ 36° tall), the rim too at the rim; positions in plain court words', async () => {
  const c = await C;
  for (const st of Object.values(c.STATIONS)) {
    for (const cam of ['camA', 'camB']) {
      const f = c.framing(st[cam], st.area, { top: 2.5 });
      assert.ok(f.nearM >= 4.5, `${st.id} ${cam}: nearest corner ${f.nearM} m`);
      assert.ok(f.acrossDeg <= 60, `${st.id} ${cam}: ${f.acrossDeg}° across`);
      assert.ok(f.verticalDeg <= 36, `${st.id} ${cam}: ${f.verticalDeg}° from the floor to head height at the nearest corner`);
      assert.match(st[cam].note, /(sideline|lane line|baseline)/, 'where it stands, in court words');
      assert.match(st[cam].note, /m from ✕/);
    }
    // every path of the station's setups is inside its area
    const { BASIC01 } = await L;
    for (const a of BASIC01.animations.filter((x) => st.setups.includes(x.courtSetup))) {
      const pth = c.playerPath(a);
      for (const q of [pth.start, pth.end]) assert.ok(q[0] >= st.area.x[0] && q[0] <= st.area.x[1] && q[1] >= st.area.y[0] && q[1] <= st.area.y[1], `${a.key} ${q} in station ${st.id}`);
    }
  }
  // setup C: the rim (3.05 m) is in both pictures (angle above the lens at its distance < 20°)
  for (const cam of ['camA', 'camB']) {
    const p = c.STATIONS.C[cam].pos, d = Math.hypot(p[0] - c.COURT.basket[0], p[1] - c.COURT.basket[1]);
    assert.ok(Math.atan((c.COURT.basket[2] + 0.4 - p[2]) / d) * 180 / Math.PI < 20, `${cam} sees above the rim`);
  }
  assert.match(c.spotWords([0, 6.6]), /^in the middle, 0\.8 m behind the free-throw line$/);
  assert.match(c.spotWords([-6.5, 2]), /right sideline, 2\.0 m up from the baseline/, 'right = −x as you face the hoop');
});

test('START / FINISH paths: left- and right-hand moves toward the basket mirror each other; a right-hand layup starts on the athlete\'s right (−x); one-shots travel their own distance', async () => {
  const c = await C, { BASIC01 } = await L;
  const by = (k) => BASIC01.animations.find((a) => a.key === k);
  const pairs = BASIC01.animations.filter((a) => a.direction === 'to-basket' && a.ballHand === 'R').map((a) => [a, by(a.key.replace(/_R$/, '_L'))]);
  assert.ok(pairs.length >= 7 && pairs.every(([, l]) => l), pairs.map(([r]) => r.key).join(','));
  for (const [r, l] of pairs) {
    const pr = c.playerPath(r), pl = c.playerPath(l);
    assert.deepStrictEqual([pl.start[0], pl.start[1], pl.end[0], pl.end[1]], [-pr.start[0] || 0, pr.start[1], -pr.end[0] || 0, pr.end[1]], `${r.key} / ${l.key} mirror`);
    assert.ok(pr.end[0] < 0 && pl.end[0] > 0, `${r.key} finishes on his right, ${l.key} on his left`);
  }
  const lay = c.playerPath(by('layup_R'));
  assert.ok(lay.start[0] < -1 && lay.end[1] < lay.start[1], `right-hand layup from the right side: ${lay.start}`);
  assert.deepStrictEqual(c.playerPath(by('two_foot_finish')).start[0], 0, 'two-foot finishes come down the middle');
  // one-shots: their own distance (a step-back is one step, a closeout several)
  const len = (k) => c.playerPath(by(k)).lengthM;
  assert.strictEqual(len('stepback_R'), 1);
  assert.strictEqual(len('pullback_R'), 1.5);
  assert.ok(len('closeout') >= 3 && len('defense_to_sprint') >= 3.5 && len('stationary_to_forward_R') >= 3);
  assert.strictEqual(len('cross_RL'), 0, 'a crossover stays on its spot');
});

test('START and FINISH labels never overlap, for every animation (focused and full diagrams)', async () => {
  const c = await C, { BASIC01 } = await L;
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const k of [0.8, 1]) for (const a of BASIC01.animations) {
    const m = c.pathMarks(c.playerPath(a), { k });
    if (m.finish) assert.ok(!hit(m.start, m.finish), `${a.key} (k ${k}): START ${JSON.stringify(m.start)} / FINISH ${JSON.stringify(m.finish)}`);
  }
  const svg = c.courtSVG('A', BASIC01.animations.find((a) => a.key === 'stepback_R'), { focus: true, cameras: false });
  assert.match(svg, />START</); assert.match(svg, />FINISH</);
});

test('the athlete\'s instructions: a clip that starts moving never says "hold the start pose", one that ends moving never "hold the finish pose"; still states keep their holds; where in court words', async () => {
  const { BASIC01 } = await L, I = await import('../capture/instructions.mjs');
  const movingIn = BASIC01.animations.filter(I.startsMoving), movingOut = BASIC01.animations.filter(I.endsMoving);
  assert.ok(movingIn.length >= 10 && movingOut.length >= 5, `${movingIn.length} start moving, ${movingOut.length} end moving`);
  for (const a of BASIC01.animations) {
    const x = I.takeScript(a), cues = x.phases.map((p) => p.cue).join(' | ');
    if (a.loop) { assert.match(x.protocol, /^Loop/); continue; }
    if (I.startsMoving(a)) {
      assert.ok(!/Hold the start pose/i.test(x.protocol) && !/HOLD THE START/.test(cues), `${a.key}: ${x.protocol} / ${cues}`);
      assert.match(x.startWhere, /already .* as you cross START/);
      assert.match(cues, /ALREADY MOVING/);
    } else assert.match(x.protocol, /^Hold the start pose 1 s/, a.key);
    if (I.endsMoving(a)) {
      assert.ok(!/hold the finish pose/i.test(x.protocol) && !/HOLD THE FINISH/.test(cues), `${a.key}: ${x.protocol}`);
      assert.match(x.finishWhere, /don't stop/);
    } else assert.match(x.protocol, /hold the finish pose 1 s/, a.key);
    assert.ok(x.phases.every((p) => !p.say || p.at >= 0.6), `${a.key}: nothing is spoken over the sync chirp`);
  }
  const lay = I.takeScript(BASIC01.animations.find((a) => a.key === 'layup_R'));
  assert.match(lay.startMarks, /right of the middle/);
  assert.match(lay.finishWhere, /about 3\.4 m toward the hoop/);
  assert.match(I.takeScript(BASIC01.animations.find((a) => a.key === 'stepback_R')).finishWhere, /about 1\.0 m backward/);
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

test('recorder format: WebKit (iPhone / iPad / Safari) records MP4 first; Chromium WebM first; a UA check that knows iPadOS', async () => {
  const { pickMime, isWebKit, mimeCandidates } = await import('../capture/camera.mjs');
  const all = () => true;
  assert.match(pickMime({ webkit: true, supported: all }), /^video\/mp4/);
  assert.match(pickMime({ webkit: false, supported: all }), /^video\/webm/);
  // an iPhone that also claims VP9 WebM still gets MP4 (it recorded 5 bytes of WebM)
  assert.strictEqual(pickMime({ webkit: true, supported: (m) => m === 'video/webm;codecs=vp9,opus' || m === 'video/mp4' }), 'video/mp4');
  assert.strictEqual(pickMime({ webkit: true, supported: (m) => m.startsWith('video/webm') }), 'video/webm;codecs=h264,opus', 'WebM only when there is no MP4');
  assert.ok(mimeCandidates(true).indexOf('video/mp4') < mimeCandidates(true).indexOf('video/webm'));
  // a format the device recorded nothing with (while frames arrived) is passed over — but never the last one it has
  assert.strictEqual(pickMime({ webkit: false, supported: all, bad: new Set(['video/webm;codecs=h264,opus']) }), 'video/webm;codecs=vp9,opus');
  assert.strictEqual(pickMime({ webkit: true, supported: (m) => m === 'video/mp4', bad: new Set(['video/mp4']) }), 'video/mp4');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
  const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15';
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1';
  assert.deepStrictEqual([isWebKit(iphone, 5), isWebKit(ipadDesktop, 5), isWebKit(ipadDesktop, 0), isWebKit(chromeMac, 0), isWebKit(chromeIos, 5)], [true, true, true, false, true]);
});

test('recording health: the iPhone case (5 bytes, no frames), a hidden page, a paused preview with real data, Safari holding its data until the stop', async () => {
  const { recordingProblem } = await import('../capture/camera.mjs');
  assert.match(recordingProblem({ chunks: 1, bytes: 5, frames: 0, elapsedMs: 1600 }), /only 5 bytes/);
  assert.match(recordingProblem({ hidden: true, chunks: 1, bytes: 90000, frames: 30, elapsedMs: 1600 }), /background/);
  assert.match(recordingProblem({ muted: true, chunks: 1, bytes: 90000, frames: 30 }), /no picture/);
  assert.match(recordingProblem({ trackState: 'ended' }), /stopped/);
  assert.match(recordingProblem({ error: 'NotSupportedError' }), /recorder failed/);
  assert.strictEqual(recordingProblem({ chunks: 1, bytes: 90000, frames: 0, elapsedMs: 1600 }), null, 'data streaming, preview paused: not an error');
  assert.strictEqual(recordingProblem({ chunks: 0, bytes: 0, frames: 45, elapsedMs: 1600 }), null, 'Safari: frames, the data comes at the stop');
  assert.match(recordingProblem({ chunks: 0, bytes: 0, frames: 0, elapsedMs: 3200 }), /no video frames and no data/);
  assert.match(recordingProblem({ chunks: 0, bytes: 0, frames: 60, final: true, elapsedMs: 2000 }), /no data/);
  assert.match(recordingProblem({ chunks: 2, bytes: 9000, frames: 60, final: true, elapsedMs: 2000 }), /only 9000 bytes/);
  assert.strictEqual(recordingProblem({ chunks: 0, bytes: 0, final: true, elapsedMs: 200 }), null, 'a STOP right after RECORD is not a camera problem');
  assert.strictEqual(recordingProblem({ chunks: 2, bytes: 400000, frames: 60, final: true, elapsedMs: 2000 }), null);
  // Safari's MP4 recorder may hand over only the file header until the STOP: while frames arrive
  // that is never a live alarm (it would flag a working iPhone) — the final check judges the file
  assert.strictEqual(recordingProblem({ chunks: 1, bytes: 1200, frames: 40, elapsedMs: 1600 }), null);
  assert.strictEqual(recordingProblem({ chunks: 1, bytes: 1500, frames: 190, elapsedMs: 3200 }), null);
  assert.strictEqual(recordingProblem({ chunks: 3, bytes: 1200, frames: 90, elapsedMs: 3200 }), null);
  assert.match(recordingProblem({ chunks: 1, bytes: 1500, frames: 190, final: true, elapsedMs: 3200 }), /only 1500 bytes/, '… the finished file does');
  assert.match(recordingProblem({ chunks: 1, bytes: 5, frames: 0, rvfc: false, elapsedMs: 1600 }), /only 5 bytes/, 'no frame counter: the bytes alone');
  assert.strictEqual(recordingProblem({ chunks: 1, bytes: 3000, frames: 5, final: true, elapsedMs: 300 }), null, 'a CANCEL right after the start is not a camera problem');
});

test('camera check verdict: real video passes; 5 bytes / no decode / no frames / nothing arrived fail with the reason; what the camera said is kept apart', async () => {
  const ok = validators.checkCamera({ file: 'camA.webm', bytes: 900000, frames: { frames: 60, fps: 30 } }, { ok: true, durationSec: 2.01, fps: 30, width: 1280, height: 720 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.reason, null);
  const bad = validators.checkCamera({ file: 'camB.webm', bytes: 5, frames: { frames: 0 }, recError: 'the recorder produced only 5 bytes' }, { ok: false });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /only 5 bytes · the video does not decode · no video frames/);
  assert.strictEqual(bad.cameraSaid, 'the recorder produced only 5 bytes');
  assert.match(validators.checkCamera(undefined, null).reason, /no recording arrived/);
  assert.match(validators.checkCamera({ file: 'x.webm', bytes: 60000 }, { ok: true, durationSec: 0.3 }).reason, /only 0.3 s/);
  // a browser that can't count frames (no requestVideoFrameCallback): the decoded file decides
  assert.strictEqual(validators.checkCamera({ file: 'camB.mp4', bytes: 800000, frames: { frames: 0 }, recorder: { rvfc: false } }, { ok: true, durationSec: 2 }).ok, true);
  assert.strictEqual(validators.checkCamera({ file: 'camB.mp4', bytes: 800000, frames: { frames: 0 }, recorder: { rvfc: true } }, { ok: true, durationSec: 2 }).ok, false);
  // hard failures (needs redo) vs warnings
  const hard = validators.hardFailures({ checks: [{ id: 'decode-camB', level: 'fail', msg: 'x' }, { id: 'fps-camA', level: 'fail', msg: 'y' }, { id: 'file-camA', level: 'ok', msg: 'z' }, { id: 'duration-match', level: 'warn', msg: 'w' }] });
  assert.deepStrictEqual(hard.map((c) => c.id), ['decode-camB']);
});

test('slot status + the next animation to record: uploading, recorded (newest selected), failed (needs redo), analysed; recorded / uploading slots are passed over', async () => {
  const { BASIC01 } = await L, p = await P;
  const o = p.captureOrder(BASIC01), [a0, a1, a2, a3] = o;
  const s = { animations: {
    [a0.id]: { takes: ['t1'], selectedTake: null },                                                        // in flight
    [a1.id]: { takes: ['t2', 't3'], selectedTake: 't2', results: { t2: { state: 'recorded' }, t3: { state: 'failed', reason: 'camB: 5 bytes' } } },
    [a2.id]: { takes: ['t4'], selectedTake: null, results: { t4: { state: 'failed', reason: 'camB: file is only 5 bytes' } } },
    [a3.id]: { takes: ['t5'], selectedTake: 't5', results: { t5: { state: 'recorded' } }, analysis: { takeId: 't5', state: 'done', motionId: 'mo-x' } },
  } };
  assert.strictEqual(p.slotStatus(s, a0.id).status, 'uploading');
  assert.deepStrictEqual([p.slotStatus(s, a1.id).status, p.slotStatus(s, a1.id).takeId], ['recorded', 't2']);
  assert.match(p.slotStatus(s, a1.id).note, /newest take failed/);
  assert.deepStrictEqual([p.slotStatus(s, a2.id).status, p.slotStatus(s, a2.id).reason], ['failed', 'camB: file is only 5 bytes']);
  assert.strictEqual(p.slotStatus(s, a3.id).status, 'analysed');
  assert.strictEqual(p.slotStatus(s, o[4].id).status, 'missing');
  const n = p.slotCounts(BASIC01, s);
  assert.deepStrictEqual([n.uploading, n.recorded, n.failed, n.analysed, n.done, n.toRecord], [1, 1, 1, 1, 2, 79]);
  assert.strictEqual(p.nextToRecord(BASIC01, s).id, a2.id, 'the first one to (re)do');
  assert.strictEqual(p.nextToRecord(BASIC01, s, { after: a2.id }).id, o[4].id, 'on after the one just recorded');
  assert.strictEqual(p.nextToRecord(BASIC01, s, { after: o[81].id }).id, a2.id, 'wraps');
  // a redo in flight on a recorded slot
  s.animations[a3.id].takes.push('t6');
  assert.deepStrictEqual([p.slotStatus(s, a3.id).status, p.slotStatus(s, a3.id).redo], ['uploading', true]);
  assert.strictEqual(p.autoStopSec(a0), a0.durationSec, 'a loop stops on time');
  assert.strictEqual(p.autoStopSec(BASIC01.animations.find((a) => a.key === 'cross_RL')), 5, 'a one-shot gets 1 s more');
});

test('court diagram for the record step: START + FINISH markers, the path, a focused view; stationary moves share one spot', async () => {
  const c = await C, { BASIC01 } = await L;
  const drive = BASIC01.animations.find((a) => a.key === 'jab_drive_R');
  const svg = c.courtSVG('B', drive, { focus: true, cameras: false });
  assert.match(svg, />START</); assert.match(svg, />FINISH</);
  assert.ok(!/>A<\/text>/.test(svg), 'no cameras when asked');
  const vb = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number), full = c.courtSVG('B').match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(vb[2] < full[2] * 0.7 && vb[2] >= 160, `focused (${vb[2]} of ${full[2]} wide)`);
  const cross = c.courtSVG('A', BASIC01.animations.find((a) => a.key === 'cross_RL'));
  assert.match(cross, /START \+ FINISH/);
  assert.match(c.courtSVG('A'), />A<\/text>[\s\S]*>B<\/text>/, 'the setup view shows both cameras');
});

test('pose descriptions: every state has plain words and a short name; the list shows start → finish in words', async () => {
  const s = await S, { BASIC01 } = await L;
  for (const k of Object.keys(s.STATES)) assert.ok(s.POSES[k] && s.POSES[k].length > 20 && s.STATES[k].short, k);
  assert.match(s.POSES.TR, /right hip/);
  assert.strictEqual(s.poseRoute(BASIC01.animations.find((a) => a.key === 'cross_RL')), 'Dribble R → Dribble L');
  for (const a of BASIC01.animations) assert.ok(!/\b(TR|TL|DR|DL|MR|ML|DEF_M|N_SPRINT)\b/.test(s.poseRoute(a)), a.key);
});

test('calibration walk: one per camera placement; four corners numbered front-left → front-right → back-right → back-left (as he faces the hoop), and the middle; timed at an easy walk; the diagram draws it instead of START / FINISH', async () => {
  const c = await C;
  for (const id of ['A', 'B', 'C']) {
    const w = c.calibrationWalk(id), ar = c.STATIONS[c.stationOf(id)].area;
    assert.strictEqual(w.station, c.stationOf(id));
    // an easy walk (1.3 m/s, never ~3 m/s): 2 s on ✕, the five legs, 2 s arms up → about 20 s
    for (const l of w.legs) assert.ok(l.metres / (l.until - l.at) <= 1.31, `${id}: leg to ${l.to} at ${(l.metres / (l.until - l.at)).toFixed(2)} m/s`);
    assert.ok(w.totalSec >= 18 && w.totalSec <= 28, `${id}: ${w.totalSec} s`);
    assert.strictEqual(c.calibrationSec(id), w.totalSec);
    assert.deepStrictEqual(w.legs.map((l) => l.to), [1, 2, 3, 4, 0]);
    const seq = []; for (let t = 0; t <= w.totalSec; t += 0.25) { const st = c.walkStep(w, t); if (seq[seq.length - 1] !== `${st.phase}${st.target}`) seq.push(`${st.phase}${st.target}`); }
    assert.deepStrictEqual(seq, ['start0', 'walk1', 'walk2', 'walk3', 'walk4', 'walk0', 'end0']);
    assert.ok(w.corners.every((k) => k.words && /m /.test(k.words)) && w.middleWords, 'every mark in court words (for the cones / tape)');
    assert.deepStrictEqual(w.corners.map((x) => x.n), [1, 2, 3, 4]);
    assert.strictEqual(new Set(w.corners.map((x) => x.pos.join())).size, 4, `${id}: four different corners`);
    for (const x of w.corners) assert.ok(ar.x.includes(x.pos[0]) && ar.y.includes(x.pos[1]), `${id}: ${x.name} is a corner of the area`);
    // 1 and 2 are the front (toward the hoop): nearer the basket than 3 and 4
    const d = (p) => Math.hypot(p[0] - c.COURT.basket[0], p[1] - c.COURT.basket[1]);
    assert.ok(Math.max(d(w.corners[0].pos), d(w.corners[1].pos)) < Math.min(d(w.corners[2].pos), d(w.corners[3].pos)), `${id}: front corners nearer the hoop`);
    const svg = c.courtSVG(id, null, { calibration: true, highlight: 2 });
    assert.ok(['>1<', '>2<', '>3<', '>4<', '>✕<'].every((x) => svg.includes(x)) && !/START|FINISH/.test(svg), id);
    assert.match(svg, /#ffd166/, 'the current corner is lit');
  }
  // setup A: he faces the baseline, so his left is +x
  assert.deepStrictEqual(c.calibrationWalk('A').corners[0].pos, [2.1, 3.3]);
  assert.strictEqual(c.calibrationWalk('B').corners[0].pos.join(), c.calibrationWalk('A').corners[0].pos.join(), 'B uses A\'s placement');
  const p = await P;
  assert.strictEqual(p.calibrationSec('C'), c.calibrationWalk('C').totalSec);
});

test('next to record: the cameras\' current placement first (its redos too), then the others; what is left at a placement; legacy takes nobody saved ask for a decision; a short newer take is a note', async () => {
  const { BASIC01 } = await L, p = await P, c = await C;
  const o = p.captureOrder(BASIC01);
  const A = o.filter((a) => c.stationOf(a.courtSetup) === 'A'), Cc = o.filter((a) => a.courtSetup === 'C');
  const s = { currentSetup: 'A', animations: {} };
  for (const a of A) s.animations[a.id] = { takes: ['t' + a.id], selectedTake: 't' + a.id, results: { ['t' + a.id]: { state: 'recorded' } } };
  const redo = A[4];
  s.animations[redo.id] = { takes: ['x1'], selectedTake: null, results: { x1: { state: 'failed', reason: 'camB: 5 bytes' } } };
  // after the last animation of the placement, the one that needs a redo HERE comes before setup C
  assert.strictEqual(p.nextToRecord(BASIC01, s, { after: A[A.length - 1].id }).id, redo.id);
  assert.deepStrictEqual(p.stationTodo(BASIC01, s, 'B').toRecord.map((a) => a.id), [redo.id], 'A and B are one placement');
  s.animations[redo.id] = { takes: ['x1', 'x2'], selectedTake: null, results: { x1: { state: 'failed', reason: 'x' } } };   // its redo is uploading
  assert.strictEqual(p.nextToRecord(BASIC01, s, { after: A[A.length - 1].id }).id, Cc[0].id, 'nothing left to record here: on to setup C');
  assert.deepStrictEqual(p.stationTodo(BASIC01, s, 'A').uploading.map((a) => a.id), [redo.id]);
  assert.ok(p.needsSetupChange(s, Cc[0]) && !p.needsSetupChange(s, A[A.length - 1]));
  // at setup C, an animation left in A is only offered once C is done
  s.currentSetup = 'C'; delete s.animations[redo.id];
  assert.strictEqual(p.nextToRecord(BASIC01, s).id, Cc[0].id);
  // a take of the old (reviewed) flow nobody accepted: needs a decision, never counted as recorded
  const L0 = Cc[1];
  s.animations[L0.id] = { takes: ['r1'], selectedTake: null, results: { r1: { state: 'review', reason: 'recorded before the automatic flow' } } };
  assert.deepStrictEqual([p.slotStatus(s, L0.id).status, p.slotStatus(s, L0.id).review], ['failed', true]);
  // a newer short take that was not selected: the selected one stays, with a note
  s.animations[L0.id] = { takes: ['g1', 'g2'], selectedTake: 'g1', results: { g1: { state: 'recorded' }, g2: { state: 'recorded', short: true, passedOver: true, warnings: ['camA: 3.0 s — shorter than half the target (8 s)'] } } };
  const st = p.slotStatus(s, L0.id);
  assert.deepStrictEqual([st.status, st.takeId], ['recorded', 'g1']);
  assert.match(st.note, /newest take \(2\) is short/);
});

test('the hub hears "I started this take" from a camera page — and from one of the earlier code still open on a phone after a deploy; failure reasons lead with plain words', async () => {
  const { startedTake } = require('../lib/capture/hub');
  assert.ok(startedTake({ take: 'tk1', lastTake: 'tk1', recording: true }, 'tk1'));
  assert.ok(startedTake({ take: null, lastTake: 'tk1', recording: false }, 'tk1'), 'already stopped again: lastTake');
  assert.ok(!startedTake({ take: null, lastTake: 'tk0', recording: false }, 'tk1'), 'asleep: still names the previous take');
  assert.ok(!startedTake({ take: null, lastTake: null, recording: false }, 'tk1'));
  assert.ok(startedTake({ recording: true }, 'tk1'), 'an older page (no take ids in its state): recording counts');
  assert.ok(!startedTake({ recording: false }, 'tk1') && !startedTake(null, 'tk1'));
  assert.strictEqual(validators.reasonOf([{ msg: 'camB: file is only 25 bytes' }, { msg: 'camB: the recording does not decode' }]), 'camB recorded no usable video (file is only 25 bytes, the recording does not decode)');
  assert.strictEqual(validators.reasonOf([{ msg: 'no recording from camB' }]), 'no recording from camB');
});

test('the live hotfixes, kept: every iOS browser records MP4 (High profile first); a camera that delivers no picture 3 s in is reported even while audio flows', async () => {
  const { pickMime, isWebKit, mimeCandidates, recordingProblem } = await import('../capture/camera.mjs');
  assert.strictEqual(mimeCandidates(true)[0], 'video/mp4;codecs=avc1.640028,mp4a.40.2');
  assert.strictEqual(pickMime({ webkit: true, supported: () => true }), 'video/mp4;codecs=avc1.640028,mp4a.40.2');
  const fxios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15';
  const inApp = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const macWebView = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  assert.deepStrictEqual([isWebKit(fxios, 5), isWebKit(inApp, 5), isWebKit(macWebView, 0), isWebKit(android, 5)], [true, true, true, false]);
  // no frame and the preview not playing 3 s in: the camera delivers no picture (audio alone can be > 4 kB)
  assert.match(recordingProblem({ chunks: 3, bytes: 48000, frames: 0, playing: false, elapsedMs: 3200 }), /not delivering a picture/);
  assert.strictEqual(recordingProblem({ chunks: 1, bytes: 16000, frames: 0, playing: false, elapsedMs: 1600 }), null, 'not before 3 s (the preview is restarted at 1.6 s)');
  assert.strictEqual(recordingProblem({ chunks: 3, bytes: 900000, frames: 0, playing: true, elapsedMs: 3200 }), null, 'playing, data flowing, no frame times: a warning only (recWarn)');
});
