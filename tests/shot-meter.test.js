/**
 * The shot meter (engine3d/shot-meter.mjs) and the flights it calls for (engine3d/shot-flight.mjs):
 *
 *   timing      the grade of a release, in the shot clip's own time (its release frame, its fps, the frame it was
 *               entered at): EXCELLENT ±80 ms, SLIGHTLY ±160, EARLY / LATE ±260, then VERY; a tap is VERY EARLY;
 *               held to the end of the late zone (the clip's end, ≥ 0.3 s) is VERY LATE; the game speed scales it
 *   the bar     up from the press; fills with the clip from its first frame and reaches its mark exactly on the
 *               release frame — for every shot clip (the jump shot 30 fps, the step-back 15 fps entered at 0–4, the
 *               between-the-legs combo 30 fps), mirrored, at any tick rate and game speed
 *   the flight  no roll: the timing error → the flight (aimOf), continuous within a band: short / front rim /
 *               swish / back rim / off the glass — more short the earlier, harder the later
 *   the launch  graded before the release frame → that flight from the launch; still held → the clean swish, bent
 *               in the air to the late flight once held past the green window (lateNow), the final one once
 *   Rapier      every band does what it says from 120 spots on both boards (1.2–11 m, every angle, 2.0–2.6 m high),
 *               the late ones as the session steers them; per shot clip, a release in each band
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SM = import('../engine3d/shot-meter.mjs');
const SF = import('../engine3d/shot-flight.mjs');
const BP = import('../engine3d/basketball-physics.mjs');
const RAPIER = import(path.join(__dirname, '..', 'node_modules', '@dimforge', 'rapier3d-compat', 'dist', 'rapier.mjs')).then(async (m) => { await m.default.init(); return m.default; });

// the court's shot clips, as the library builds them (tests/ball-contact.test.js plays the real ones): the jump shot
// (30 fps, released on 27 of 32), the step-back (15 fps, 23 of 35, entered at frame 0–4), the between-the-legs →
// crossover → shot combo (resampled to 30 fps from its 20 fps capture: released on 60 of 69) — and their mirrors
const J = { name: 'jump shot', F: 32, fps: 30, shot: { releaseFrame: 27 } };
const SB = { name: 'step-back', F: 35, fps: 15, shot: { releaseFrame: 23 } };
const COMBO = { name: 'btl combo', F: 69, fps: 30, shot: { releaseFrame: 60 } };
const mirrorOf = (c) => ({ ...c, name: c.name + ' (mirrored)', mirror: true, shot: { ...c.shot } });
const SHOT_CLIPS = [[J, 0], [SB, 0], [SB, 4], [COMBO, 0], [mirrorOf(J), 0], [mirrorOf(SB), 2]];
const action = (clip, t0 = 0) => ({ clip, t0, t: t0 });

/**
 * A shot from press to grade: ticks of dt game seconds (speed × real dt); the button comes up on the first tick whose
 * clip time (as drawn: before the tick) is ≥ upAt (frames), or never. The launch on the release frame (atLaunch), then
 * every tick the late flight (lateNow) while the button is still held.
 */
function play(M, clip, { t0 = 0, hz = 60, speed = 1, upAt = Infinity, startAt = 0.1, maxT = 6 } = {}) {
  const meter = new M.ShotMeter();
  const dt = speed / hz, a = action(clip, t0);
  let t = 0, started = false, launched = null, onMark = null;
  const lates = [];
  meter.press(t, 'shot-jumper');
  for (let tick = 0; t < maxT && tick < 100000; tick++) {
    // the button, before the tick (as the court / harness: the frame last drawn)
    if (meter.btn && started && meter.clipT >= upAt - 1e-9) meter.release(t, a.t < clip.F - 1 ? a.t : null);
    t += dt;
    if (!started && t >= startAt - 1e-9) { started = true; meter.start(a, t); }
    else if (started && a.t < clip.F - 1) {
      const prev = a.t; a.t = Math.min(clip.F - 1, a.t + dt * clip.fps);
      if (!launched && prev < clip.shot.releaseFrame && a.t >= clip.shot.releaseFrame - 1e-4) { launched = meter.atLaunch(t); onMark = { fill: meter.fracOf(a.t), prevFill: meter.fracOf(prev) }; }
    }
    meter.tick(started && a.t < clip.F - 1 ? a : null, t);
    if (launched) { const L = meter.lateNow(); if (L) lates.push({ t, ...L }); }
    if (meter.outcome && launched && (meter.outcome.consumed || !launched.provisional)) break;
  }
  return { meter, launched, a, lates, onMark };
}

test('grades: EXCELLENT within ±80 ms of the release frame, then slightly (±160) / plain (±260) / very early or late; a tap is VERY EARLY', async () => {
  const M = await SM;
  const L = (e, b) => M.gradeTiming(e, b).label;
  assert.strictEqual(M.SHOT_METER.green, 0.08, 'the green window: ±80 ms at 1×');
  for (const e of [0, 0.079, -0.079, 0.08, -0.08]) assert.strictEqual(L(e), 'EXCELLENT', `${e}`);
  assert.strictEqual(L(-0.09), 'SLIGHTLY EARLY'); assert.strictEqual(L(0.09), 'SLIGHTLY LATE');
  assert.strictEqual(L(-0.16), 'SLIGHTLY EARLY'); assert.strictEqual(L(0.16), 'SLIGHTLY LATE');
  assert.strictEqual(L(-0.17), 'EARLY'); assert.strictEqual(L(0.2), 'LATE');
  assert.strictEqual(L(-0.27), 'VERY EARLY'); assert.strictEqual(L(0.27), 'VERY LATE');
  for (const e of [0, 0.3, -2]) assert.strictEqual(L(e, true), 'VERY EARLY', 'before the shot started');
});

test('the flight of a timing error: no roll — swish / front rim / short / back rim / off the glass, more short the earlier, harder the later', async () => {
  const M = await SM;
  const cat = (e, lateEnd, b) => M.flightOf(M.aimOf(e, M.SHOT_METER, lateEnd, b).outcome);
  const WANT = [[0, 'swish'], [-0.08, 'swish'], [0.08, 'swish'], [-0.1, 'front-rim'], [-0.16, 'front-rim'], [-0.17, 'short'], [-0.26, 'short'], [-0.4, 'short'], [-2, 'short'],
    [0.1, 'back-rim'], [0.16, 'back-rim'], [0.17, 'off-glass'], [0.26, 'off-glass'], [0.4, 'off-glass'], [2, 'off-glass']];
  for (const [e, want] of WANT) assert.strictEqual(cat(e, 0.3), want, `${(e * 1000).toFixed(0)} ms → ${want}`);
  assert.strictEqual(cat(0.3, 0.3, true), 'short', 'a tap: short (an air ball)');
  // (the swish is today's clean swish: the same flight as a perfect shot)
  const SFm = await SF;
  assert.strictEqual(M.aimOf(0.01).dz, SFm.SHOT_DEFAULTS.miss.swish);
  // more short the earlier, harder the later: dz never turns back as the error grows (each side), the same for any e
  for (const lateEnd of [0.3, 0.73]) {
    let prev = M.aimOf(0).dz;
    for (let e = 0; e <= 1.0; e += 0.005) { const d = M.aimOf(-e, M.SHOT_METER, lateEnd).dz; assert.ok(d <= prev + 1e-12, `early ${e.toFixed(3)}: ${d} ≤ ${prev}`); prev = d; }
    prev = M.aimOf(0).dz;
    for (let e = 0; e <= 1.0; e += 0.005) { const A = M.aimOf(e, M.SHOT_METER, lateEnd); assert.ok(A.dz >= prev - 1e-12, `late ${e.toFixed(3)}: ${A.dz} ≥ ${prev}`); prev = A.dz; }
    assert.strictEqual(M.aimOf(lateEnd, M.SHOT_METER, lateEnd).dz, M.AIM.veryLate[1], 'held to the end of the late zone: the hardest');
  }
  // deterministic: the same release, the same flight
  assert.deepStrictEqual(M.aimOf(-0.123), M.aimOf(-0.123));
});

test('the bar follows each shot clip: up from the press, 0 at the clip\'s first frame, exactly on the mark at the release frame, full lateMin later', async () => {
  const M = await SM;
  for (const [clip, t0] of SHOT_CLIPS) {
    const m = new M.ShotMeter(), n = `${clip.name}/${t0}`;
    m.press(0, 'shot-jumper');
    // (up the moment the button is pressed — empty until the shot clip starts)
    assert.ok(m.view().visible && m.view().fill === 0, `${n}: shown, empty, from the press`);
    m.start(action(clip, t0), 0.1);
    const s = m.shot, rel = clip.shot.releaseFrame;
    assert.strictEqual(s.riseStart, t0, `${n}: fills from the frame the clip was entered at`);
    assert.strictEqual(m.fracOf(t0), 0);
    assert.ok(Math.abs(m.fracOf(rel) - m.cfg.mark) < 1e-12, `${n}: on the mark at the release frame`);
    let prev = -1;
    for (let ct = t0; ct <= clip.F + 20; ct += 0.25) { const f = m.fracOf(ct); assert.ok(f >= prev - 1e-12 && f <= 1, 'monotonic, ≤ 1'); prev = f; }
    assert.strictEqual(m.fracOf(rel + m.cfg.lateMin * clip.fps), 1, 'full lateMin after the release frame');
    // the late zone runs to the clip's end (≥ lateMin): held there, VERY LATE
    assert.strictEqual(s.lateEnd, Math.max(m.cfg.lateMin, (clip.F - 1 - rel) / clip.fps));
    const v = m.view();
    assert.ok(Math.abs(v.band[0] - m.fracOf(rel - 0.08 * clip.fps)) < 1e-12 && Math.abs(v.band[1] - m.fracOf(rel + 0.08 * clip.fps)) < 1e-12, 'the green band: ±80 ms around the mark');
    assert.ok(v.band[0] < m.cfg.mark && v.band[1] > m.cfg.mark);
  }
});

test('in sync with the clip at real playback speed: the bar reaches the mark on the frame the ball leaves, for every shot clip, at 30 / 60 / 120 Hz and 1× / 0.5× / 0.25× game speed', async () => {
  const M = await SM;
  for (const [clip, t0] of SHOT_CLIPS) for (const hz of [30, 60, 120]) for (const speed of [1, 0.5, 0.25]) {
    const r = play(M, clip, { t0, hz, speed, upAt: clip.shot.releaseFrame });
    const n = `${clip.name}/${t0} @${hz} Hz ×${speed}`;
    // (the launch tick: the bar crosses the mark on it)
    assert.ok(r.onMark && r.onMark.prevFill < r.meter.cfg.mark + 1e-9 && r.onMark.fill >= r.meter.cfg.mark - 1e-9, `${n}: on the mark when the ball leaves (${JSON.stringify(r.onMark)})`);
    // let go on the release frame: EXCELLENT, |e| under one tick of clip time
    assert.strictEqual(r.meter.outcome.label, 'EXCELLENT', n);
    assert.ok(Math.abs(r.meter.outcome.e) <= speed / hz + 1e-9, `${n}: e ${(r.meter.outcome.e * 1000).toFixed(1)} ms`);
  }
  // the time the bar takes to fill = the clip's wind-up, real time ÷ game speed: the jump shot 0.9 s, the step-back
  // 1.27–1.53 s, the combo 2 s (its dribbles too) at 1×
  for (const [clip, t0, want] of [[J, 0, 0.9], [SB, 0, 23 / 15], [SB, 4, 19 / 15], [COMBO, 0, 2.0]]) {
    const r = play(M, clip, { t0, hz: 60, upAt: clip.shot.releaseFrame, startAt: 0 });
    assert.ok(Math.abs(r.meter.outcome.at - want) <= 2 / 60 + 1e-9, `${clip.name}/${t0}: fills over ${want.toFixed(2)} s (let go at ${r.meter.outcome.at.toFixed(3)})`);
  }
});

test('timing in clip frames: a release k frames off the release frame grades k / fps, at 30 / 60 / 120 Hz ticks, every shot clip', async () => {
  const M = await SM;
  for (const [clip, t0] of SHOT_CLIPS) for (const hz of [30, 60, 120]) for (const k of [-12, -6, -4, -3, -2, -1, 0, 1, 2, 3, 5]) {
    const rel = clip.shot.releaseFrame;
    if (rel + k < t0) continue;
    const { meter } = play(M, clip, { t0, hz, upAt: rel + k });
    // (released on a tick: up to one tick of clip time after upAt)
    const e = meter.outcome?.e;
    assert.ok(e >= k / clip.fps - 1e-9 && e <= k / clip.fps + clip.fps / hz / clip.fps + 1e-9, `${clip.name} @${hz} Hz, k ${k}: e ${e}`);
    assert.strictEqual(meter.outcome.label, M.gradeTiming(e).label);
  }
  // (the step-back at 15 fps: one frame is 67 ms — one frame off is still EXCELLENT, two is SLIGHTLY, three is EARLY)
  assert.strictEqual(play(M, SB, { hz: 60, upAt: 22 }).meter.outcome.label, 'EXCELLENT');
  assert.strictEqual(play(M, SB, { hz: 60, upAt: 21 }).meter.outcome.label, 'SLIGHTLY EARLY');
  assert.strictEqual(play(M, SB, { hz: 60, upAt: 20 }).meter.outcome.label, 'EARLY');
  // (the jump shot at 30 fps: two frames early is EXCELLENT, four is SLIGHTLY EARLY, six is EARLY)
  assert.strictEqual(play(M, J, { hz: 60, upAt: 25 }).meter.outcome.label, 'EXCELLENT');
  assert.strictEqual(play(M, J, { hz: 60, upAt: 23 }).meter.outcome.label, 'SLIGHTLY EARLY');
  assert.strictEqual(play(M, J, { hz: 60, upAt: 21 }).meter.outcome.label, 'EARLY');
});

test('game speed: at 0.5× the green window lasts twice as many real frames; the grade of a clip time is the same', async () => {
  const M = await SM;
  const greens = (speed) => {
    let n = 0;
    for (let k = -40; k <= 40; k++) {
      const upAt = J.shot.releaseFrame + (k * speed * J.fps) / 60;   // a release on real frame k around the release frame
      if (play(M, J, { hz: 60, speed, upAt }).meter.outcome.grade === 'green') n++;
    }
    return n;
  };
  const g1 = greens(1), g05 = greens(0.5);
  assert.ok(g1 >= 9 && g1 <= 11, `±80 ms at 1×: ${g1} real frames at 60 Hz`);
  assert.ok(Math.abs(g05 - 2 * g1) <= 1, `green frames: ${g1} at 1×, ${g05} at 0.5×`);
  assert.strictEqual(play(M, J, { hz: 60, speed: 0.5, upAt: 23 }).meter.outcome.label, play(M, J, { hz: 60, speed: 1, upAt: 23 }).meter.outcome.label);
});

test('a tap (let go before the shot started) is VERY EARLY — an air ball, known at the launch; the bar never filled', async () => {
  const M = await SM;
  const meter = new M.ShotMeter();
  meter.press(0, 'shot-jumper'); meter.release(0.05, null);
  assert.strictEqual(meter.outcome, null, 'not graded before the shot starts');
  meter.start(action(J, 0), 0.1);
  assert.strictEqual(meter.outcome.label, 'VERY EARLY');
  const L = meter.atLaunch(0.8);
  assert.ok(L && !L.provisional && L.outcome === 'airball' && L.dz === M.AIM.veryEarly[1], 'the launch knows it');
  assert.strictEqual(meter.lateNow(), null, 'nothing left to hand over');
  assert.strictEqual(meter.view().fill, 0, 'the bar never filled');
});

test('held through the launch: the clean swish; held past the green window the late flight of the timing so far (only harder), the final one once; never let go: VERY LATE at the clip\'s end — the hardest', async () => {
  const M = await SM;
  // released 3 frames late (the jump shot, 30 fps: +100 ms) — SLIGHTLY LATE: the back of the rim
  const r = play(M, J, { hz: 60, upAt: 30 });
  assert.ok(r.launched?.provisional && r.launched.outcome === 'swish', 'the button was still held at the launch: the clean swish');
  assert.strictEqual(r.meter.outcome.label, 'SLIGHTLY LATE');
  const fin = r.lates.filter((l) => l.final);
  assert.strictEqual(fin.length, 1, 'the final grade handed over once');
  assert.strictEqual(fin[0].outcome, 'back-rim');
  assert.ok(r.lates.filter((l) => !l.final).every((l) => l.e > M.SHOT_METER.green), 'nothing before the green window ran out');
  // held: the late flight only gets harder
  const n = play(M, SB, { hz: 60 });
  assert.strictEqual(n.meter.outcome.label, 'VERY LATE');
  // (the step-back's late zone runs to its clip's end: 0.73 s after its release frame)
  assert.ok(Math.abs(n.meter.outcome.e - (34 - 23) / 15) < 1e-9, `graded at the clip's end (${n.meter.outcome.e})`);
  assert.strictEqual(n.meter.outcome.dz, M.AIM.veryLate[1], 'the hardest');
  let prev = -Infinity, cats = [];
  for (const l of n.lates) { assert.ok(l.dz >= prev - 1e-12, 'harder the later'); prev = l.dz; if (cats.at(-1) !== l.outcome) cats.push(l.outcome); }
  assert.deepStrictEqual(cats, ['back-rim', 'off-glass']);
  assert.strictEqual(n.meter.view().fill, 1, 'the bar is full');
  // the jump shot's clip ends 4 frames after its release: the late zone runs on to lateMin on the meter's clock
  const j = play(M, J, { hz: 60 });
  assert.strictEqual(j.meter.outcome.label, 'VERY LATE');
  assert.ok(Math.abs(j.meter.outcome.e - M.SHOT_METER.lateMin) < 1e-9, `graded at the end of the late zone (${j.meter.outcome.e})`);
  // released after the clip ended, before the late zone did: graded by that time
  const e = play(M, J, { hz: 60, upAt: 27 + 6 });
  assert.strictEqual(e.meter.outcome.label, M.gradeTiming(6 / 30).label);
});

test('the meter only runs for a shot it armed: no press → no meter (a plain make); a short wind-up has none; a dropped request hides it; the result shown', async () => {
  const M = await SM;
  const m = new M.ShotMeter();
  m.start(action(J, 0), 0);
  assert.strictEqual(m.phase, 'idle', 'not pressed: nothing');
  assert.strictEqual(m.atLaunch(1), null);
  assert.strictEqual(m.view().visible, false);
  m.press(0); m.start(action({ ...J, shot: { releaseFrame: 3 } }, 0), 0);
  assert.strictEqual(m.phase, 'idle', 'a 0.1 s wind-up: no meter');
  m.press(0); m.cancel();
  assert.strictEqual(m.phase, 'idle', 'dropped');
  m.press(0); m.tick(null, 2);
  assert.strictEqual(m.phase, 'idle', 'a press whose shot never started times out');
  // results: SWISH touches nothing, MAKE touched the rim, AIR BALL touched neither rim nor board
  const res = (made, touched) => { const q = new M.ShotMeter(); q.press(0); q.start(action(J, 0), 0); q.release(0.5, 26); q.atLaunch(0.9); q.onResult({ made, touched }); return q.view().result; };
  assert.strictEqual(res(true, []), 'SWISH'); assert.strictEqual(res(true, ['rim']), 'MAKE');
  assert.strictEqual(res(false, ['rim', 'board']), 'MISS'); assert.strictEqual(res(false, []), 'AIR BALL');
  // the label next to the bar: the grade, in its colour
  const q = new M.ShotMeter(); q.press(0); q.start(action(J, 0), 0); q.release(0.5, 23);
  assert.deepStrictEqual([q.view().label, q.view().color], ['SLIGHTLY EARLY', M.GRADE_COLOR.slight]);
});

test('the shot button: one press, one shot — still held after a dropped request or a new ball it must come up first; a tap then a hold is the same shot', async () => {
  const M = await SM;
  const meter = new M.ShotMeter();
  const P = { hasBall: true, ballFree: false, mode: 'loco', action: null };
  const reqs = [];
  const btn = (held, t) => M.shootButton(meter, { held, t, P, request: (r) => reqs.push(r), roleOf: () => 'shot-jumper' });
  btn(true, 0); btn(true, 0.1);
  assert.deepStrictEqual(reqs, ['shot-jumper'], 'one request per press');
  meter.cancel();   // (the request was dropped: no valid window in 1.2 s)
  btn(true, 0.2); btn(true, 1.5);
  assert.strictEqual(reqs.length, 1, 'still held: no new shot (no auto-repeat)');
  btn(false, 1.6); btn(true, 1.7);
  assert.strictEqual(reqs.length, 2, 'let go and pressed again: a new shot');
  // a tap, then held again before the shot started: the hold times it
  btn(false, 1.75);
  assert.ok(meter.up?.beforeStart, 'up before the shot started');
  btn(true, 1.8);
  assert.strictEqual(reqs.length, 2, 'the same shot (no second request)');
  meter.start(action(J, 0), 1.9);
  assert.strictEqual(meter.phase, 'rising');
  assert.strictEqual(meter.outcome, null, 'not graded as a tap');
  // no ball: the button does nothing
  meter.reset(); btn(false, 2); P.hasBall = false; btn(true, 2.1);
  assert.strictEqual(reqs.length, 2, 'no ball, no shot');
  // a new possession while the button is held: no shot until it comes up
  btn(false, 2.2); P.hasBall = true; btn(true, 2.3); meter.reset(); btn(true, 2.4);
  assert.strictEqual(reqs.length, 3, 'held through the new ball: still the one press');
  // the press that asked for the new ball is not a shot — it must come up first
  btn(false, 2.5); meter.reset(); P.hasBall = false; btn(true, 2.6);
  P.hasBall = true; meter.reset(); meter.notAShot(); btn(true, 2.7); btn(true, 2.8);
  assert.strictEqual(reqs.length, 3, 'the new-ball press does not shoot');
  btn(false, 2.9); btn(true, 3.0);
  assert.strictEqual(reqs.length, 4, 'the next press does');
  meter.start(action(J, 0), 3.05); btn(false, 3.1); meter.notAShot();
  assert.strictEqual(meter.btn, false, 'notAShot leaves a shot on the meter alone');
  meter.reset(); btn(false, 3.2); P.hasBall = false; btn(true, 3.3); P.hasBall = true; btn(true, 3.4); btn(true, 3.5);
  assert.strictEqual(reqs.length, 4, 'a press with no ball does not shoot the pass back');
  btn(false, 3.6); btn(true, 3.7);
  assert.strictEqual(reqs.length, 5, 'the next press does');
});

// ── Rapier: the flights on the rim / the glass ─────────────────────────────
const C = [0, 3.05, 0], RIM_R = 0.2286;
// the classic board and the VANTHEAH court's (engine3d/court-vantheah.mjs: its rim tube / segments, the board 0.375 m back)
const BOARDS = {
  classic: { tube: 0.012, segments: 24, board: { center: [0, 3.435, -0.355], half: [0.915, 0.535, 0.02] } },
  vantheah: { tube: 0.0095, segments: 32, board: { center: [0, 3.425, -0.375], half: [0.9, 0.525, 0.025] } },
};
const SPOTS = [];
for (const d of [1.2, 1.6, 2, 3, 4.6, 6.75, 8.5, 11]) for (const deg of [-80, -40, 0, 35, 80]) for (const y of [2.0, 2.3, 2.6]) { const a = (deg * Math.PI) / 180; SPOTS.push({ f: [Math.sin(a) * d, y, Math.cos(a) * d], wide: Math.abs(deg) > 60 }); }
const where = (f) => `${Math.hypot(f[0], f[2]).toFixed(1)} m / ${((Math.atan2(f[0], f[2]) * 180) / Math.PI).toFixed(0)}° / ${f[1]} m`;

/**
 * One shot on Rapier, as the session flies it: aim (aimOf, known at the launch) → that flight from the launch; or
 * late(t) (the meter's lateNow: { outcome, dz, pitch } once held past the green window) → the clean swish, steered
 * in the air to lateFlight's point (≤ steerAccel, off steerStop before it or once the rim / glass is touched).
 * → its category: swish (in, touching nothing) / front-rim / back-rim (the rim first, on the shooter's side of its
 * centre or past it) / off-glass (the glass first) / short / long (touched nothing: where it came down).
 */
async function fly(from, court, { aim = null, late = null } = {}) {
  const R = await RAPIER, { BasketballPhysicsSystem } = await BP, F = await SF, M = await SM;
  const sys = new BasketballPhysicsSystem(R, {}), B = BOARDS[court];
  sys.addHoop({ center: C, rimR: RIM_R, tube: B.tube, segments: B.segments, board: B.board });
  const cfg = { g: sys.cfg.gravity, drag: sys.cfg.linearDamping }, hoop = { center: C, rimR: RIM_R };
  const A = aim || { outcome: 'swish', dz: M.AIM.swish, pitch: 0 };
  const plan = F.planShot({ from, hoop, outcome: A.outcome, dz: A.dz, pitch: A.pitch || 0, cfg });
  sys.placeBall(from, plan.v0, plan.w0); sys.throwBall(plan.v0, 'none'); sys.touchedSince.clear();
  const u = [-from[0], -from[2]], ul = Math.hypot(u[0], u[1]);
  const along = (p) => (p[0] * u[0] + p[2] * u[1]) / ul;
  let through = false, prev = sys.pos, t = 0, first = null, down = null, steer = null, key = null, dv = 0;
  const dt = 1 / 60, SMc = M.SHOT_METER;
  for (let i = 0; i < 420; i++) {
    const L = late ? late(t) : null;
    const touched = sys.touchedSince.has('rim') || sys.touchedSince.has('board');
    if (L && !touched && `${L.dz}:${L.pitch}` !== key) {
      const W = F.lateFlight({ from, hoop, outcome: L.outcome, dz: L.dz, pitch: L.pitch || 0, cfg });
      if (t <= W.T - SMc.steerStop) { steer = W; key = `${L.dz}:${L.pitch}`; }
    }
    if (steer && !touched && t <= steer.T - SMc.steerStop) {
      const v = sys.vel, need = sys.ballisticTo(steer.aim, Math.max(SMc.steerStop, steer.T - t)), d = need.map((x, k) => x - v[k]), l = Math.hypot(...d);
      if (l > 0.005) { const k = Math.min(1, (SMc.steerAccel * dt) / l); sys.impartVelocity(v.map((x, j) => x + d[j] * k)); dv += l * k; }
    }
    sys.advance(dt, null, null, { has: false }, { has: false }); t += dt;
    const p = sys.pos, v = sys.vel;
    if (!first) { const n = [...sys.touchedSince].find((x) => x === 'rim' || x === 'board'); if (n) first = { name: n, along: along(p) }; }
    if (down == null && prev[1] > C[1] + 0.03 && p[1] <= C[1] + 0.03) down = along(p);
    if (prev[1] > C[1] && p[1] <= C[1] && Math.hypot(p[0], p[2]) < RIM_R - 0.03) through = true;
    prev = p;
    if (through || (t > 0.3 && v[1] < 0 && p[1] < C[1] - 0.35)) break;
  }
  sys.dispose?.();
  const cat = !first ? (through ? 'swish' : down == null || down < 0 ? 'short' : 'long') : first.name === 'board' ? 'off-glass' : first.along < 0 ? 'front-rim' : 'back-rim';
  return { through, cat, first, down, dv };
}
/** The meter's late flight of a button held until e = up (s after the release frame), the ball launched on it (t = e). */
const heldUntil = (M, up, lateEnd) => (t) => { const e = Math.min(t, up); return e > M.SHOT_METER.green ? M.aimOf(e, M.SHOT_METER, lateEnd) : null; };

test('Rapier: every band does what it says from 120 spots on both boards — swish touches nothing; slightly early: the front of the rim, out; early: short (an air ball); slightly late: the back of the rim, out; late / held: off the glass, out', async () => {
  const M = await SM;
  // (released before / on the launch: the flight from the launch; after it: steered in the air as the session does)
  const CASES = [
    ['EXCELLENT −80 ms', { e: -0.08 }, 'swish'], ['EXCELLENT', { e: 0 }, 'swish'], ['EXCELLENT +80 ms (held through the launch)', { up: 0.08 }, 'swish'],
    ['SLIGHTLY EARLY −90 ms', { e: -0.09 }, 'front-rim'], ['SLIGHTLY EARLY −160 ms', { e: -0.16 }, 'front-rim'],
    ['EARLY −170 ms', { e: -0.17 }, 'short'], ['EARLY −260 ms', { e: -0.26 }, 'short'], ['VERY EARLY −400 ms', { e: -0.4 }, 'short'], ['a tap', { tap: true }, 'short'],
    ['SLIGHTLY LATE +90 ms', { up: 0.09 }, 'back-rim'], ['SLIGHTLY LATE +160 ms', { up: 0.16 }, 'back-rim'],
    ['LATE +170 ms', { up: 0.17 }, 'off-glass'], ['LATE +260 ms', { up: 0.26 }, 'off-glass'], ['held to the end (0.3 s)', { up: 0.3 }, 'off-glass'], ['held to the end (0.73 s: the step-back)', { up: 0.73, lateEnd: 0.73 }, 'off-glass'],
  ];
  const rows = [];
  let maxDv = 0;
  for (const court of Object.keys(BOARDS)) for (const [label, c, want] of CASES) {
    const tally = {};
    for (const s of SPOTS) {
      const r = c.up != null ? await fly(s.f, court, { late: heldUntil(M, c.up, c.lateEnd ?? 0.3) }) : await fly(s.f, court, { aim: M.aimOf(c.e ?? 0, M.SHOT_METER, 0.3, !!c.tap) });
      tally[r.cat] = (tally[r.cat] || 0) + 1;
      maxDv = Math.max(maxDv, r.dv);
      const at = `${court}: ${label} from ${where(s.f)}`;
      assert.strictEqual(r.through, want === 'swish', `${at}: ${want === 'swish' ? 'in' : 'out'} (${r.cat}, first ${JSON.stringify(r.first)})`);
      // (from near the baseline the glass is not in a too-hard shot's path: it flies long, past the rim)
      const ok = r.cat === want || (want === 'off-glass' && s.wide && r.cat === 'long');
      assert.ok(ok, `${at}: ${want} (got ${r.cat}, first ${JSON.stringify(r.first)}, down ${r.down?.toFixed(2)})`);
    }
    rows.push(`${court} · ${label}: ${JSON.stringify(tally)}`);
  }
  console.log(rows.join('\n'));
  console.log(`the most a late flight is bent in the air: ${maxDv.toFixed(2)} m/s`);
  assert.ok(maxDv <= 3, `a bend (≤ 3 m/s in all: ${maxDv.toFixed(2)})`);
});

test('per shot clip: a release in each band → its flight on Rapier (jump shot 30 fps, step-back 15 fps, the btl combo, mirrored), from in front, the wing and close in', async () => {
  const M = await SM;
  const FROM = [[0, 2.3, 4.6], [Math.sin(0.6) * 6.75, 2.4, Math.cos(0.6) * 6.75], [-0.9, 2.1, 1.6]];
  const BANDS = [[-0.06, 'EXCELLENT', 'swish'], [0, 'EXCELLENT', 'swish'], [0.06, 'EXCELLENT', 'swish'], [-0.12, 'SLIGHTLY EARLY', 'front-rim'], [-0.2, 'EARLY', 'short'], [-0.35, 'VERY EARLY', 'short'],
    [0.12, 'SLIGHTLY LATE', 'back-rim'], [0.2, 'LATE', 'off-glass'], [null, 'VERY LATE', 'off-glass']];
  const rows = [];
  for (const [clip, t0] of SHOT_CLIPS) for (const [e, label, want] of BANDS) {
    const rel = clip.shot.releaseFrame;
    if (e != null && rel + e * clip.fps < t0) continue;
    const r = play(M, clip, { t0, hz: 60, upAt: e == null ? Infinity : rel + e * clip.fps });
    const o = r.meter.outcome, n = `${clip.name}/${t0}: ${e == null ? 'never let go' : `${(e * 1000).toFixed(0)} ms`}`;
    assert.strictEqual(o.label, label, `${n}: ${label} (e ${o.e})`);
    assert.strictEqual(M.flightOf(o.outcome), want, `${n}: ${want}`);
    for (const f of FROM) {
      // (the court's: let go before the launch → that flight; still held at the launch → steered by lateNow)
      const late = r.launched.provisional ? heldUntil(M, o.e, r.meter.shot.lateEnd) : null;
      const fl = late ? await fly(f, 'classic', { late }) : await fly(f, 'classic', { aim: { outcome: o.outcome, dz: o.dz, pitch: o.pitch } });
      assert.strictEqual(fl.cat, want, `${n} from ${where(f)}: ${want} (got ${fl.cat})`);
      assert.strictEqual(fl.through, want === 'swish');
    }
    rows.push(`${clip.name}/${t0} ${e == null ? 'held' : (e * 1000).toFixed(0) + ' ms'} → ${o.label} → ${want}`);
  }
  console.log(rows.join('\n'));
});

// the court reads when the button came up between two frames (buttonMoment) — and a release after the shot clip ended
// is graded at THAT moment on the meter's own clock (clipAt), not at the last drawn frame
test('the button\'s moment between frames: a release after the shot clip ended is graded when it came up, not at the last frame (any game speed)', async () => {
  const M = await SM;
  // a shot whose late zone runs past its clip's end (the jump shot: released on 27 of 32, 30 fps)
  const SHORT = { name: 'short', F: 32, fps: 30, shot: { releaseFrame: 27 } };
  for (const speed of [1, 0.5]) for (const upMs of [4, 11]) {
    const meter = new M.ShotMeter(), P = { hasBall: true, ballFree: false, mode: 'action', action: action(SHORT, 0) };
    const dtReal = 1 / 60, dt = dtReal * speed;
    meter.press(0, 'shot-jumper'); meter.start(P.action, 0);
    let t = 0;
    while (P.action.t < SHORT.F - 1) { t += dt; P.action.t = Math.min(SHORT.F - 1, P.action.t + dt * SHORT.fps); meter.tick(P.action, t); }
    P.mode = 'loco'; const endT = t, endClip = P.action.t; P.action = null;
    t += dt; meter.tick(null, t);   // (one more frame drawn after it ended)
    const frameAt0 = 1000, mo = M.buttonMoment({ gameT: t, speed, upAt: frameAt0 + upMs, frameAt0, frameRdt: dtReal, action: P.action });
    M.shootButton(meter, { held: false, t: mo.t, clipT: mo.clipT, P, request: () => {}, roleOf: () => 'shot-jumper' });
    assert.ok(meter.outcome, `graded (speed ${speed})`);
    const want = endClip + (t - endT + (upMs / 1000) * speed) * SHORT.fps;   // the clip time when it came up
    assert.ok(Math.abs(meter.outcome.clipT - want) < 1e-6, `speed ${speed}, up ${upMs} ms into the frame: graded at clip time ${meter.outcome.clipT.toFixed(4)}, want ${want.toFixed(4)}`);
    assert.ok(Math.abs(meter.outcome.e - (want - 27) / 30) < 1e-6, 'its timing error is from that moment');
  }
  const mo = M.buttonMoment({ gameT: 2, speed: 0.5, upAt: null, frameRdt: 0.02 });
  assert.ok(Math.abs(mo.since - 0.01) < 1e-12 && Math.abs(mo.t - 2.005) < 1e-12, `halfway: ${JSON.stringify(mo)}`);
  const mp = M.buttonMoment({ gameT: 1, speed: 1, upAt: 1008, frameAt0: 1000, frameRdt: 1 / 60, action: action(SHORT, 20) });
  assert.ok(Math.abs(mp.clipT - (20 + 0.008 * 30)) < 1e-9 && Math.abs(mp.t - 1.008) < 1e-12, JSON.stringify(mp));
});

test('the fixed-direction launch (shot-flight launchAlong): the clean swish\'s heading, only the speed changes; it comes down through the aim height dz along', async () => {
  const F = await SF;
  const hoop = { center: C, rimR: RIM_R }, cfg = { drag: 0.02 };
  for (const from of [[0, 2.3, 6.75], [3, 2.0, 0.5], [-1, 2.6, 1.2]]) {
    const clean = F.planShot({ from, hoop, outcome: 'swish', cfg });
    const same = F.planShot({ from, hoop, outcome: 'swish', dz: F.SHOT_DEFAULTS.miss.swish, cfg });
    assert.deepStrictEqual(same.v0, clean.v0, 'the green flight is the clean swish');
    const n0 = clean.v0.map((x) => x / Math.hypot(...clean.v0));
    let prev = 0;
    for (const dz of [-0.6, -0.3, -0.1, 0.2, 0.6, 1.1]) {
      const p = F.planShot({ from, hoop, outcome: 'x', dz, cfg }), sp = Math.hypot(...p.v0), n = p.v0.map((x) => x / sp);
      assert.ok(Math.hypot(n[0] - n0[0], n[1] - n0[1], n[2] - n0[2]) < 1e-9, `dz ${dz}: the same direction`);
      assert.ok(sp > prev, `dz ${dz}: faster the longer`); prev = sp;
      if (p.reaches) {
        const l = Math.hypot(from[0], from[2]), u = [-from[0] / l, -from[2] / l];
        assert.ok(Math.abs(p.aim[1] - (C[1] + F.SHOT_DEFAULTS.aimLift)) < 1e-6 && Math.abs(p.aim[0] * u[0] + p.aim[2] * u[1] - dz) < 1e-6, `dz ${dz}: down through the aim height there (${p.aim})`);
      }
    }
    // pitch: the same heading, a flatter launch
    const hard = F.planShot({ from, hoop, outcome: 'off-glass', dz: 1.1, pitch: -6, cfg });
    const el = (v) => Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180 / Math.PI;
    assert.ok(Math.abs(el(hard.v0) - (el(clean.v0) - 6)) < 1e-9, 'pitch −6°: 6° flatter');
    assert.ok(Math.abs(Math.atan2(hard.v0[0], hard.v0[2]) - Math.atan2(clean.v0[0], clean.v0[2])) < 1e-9, 'the same heading');
  }
});
