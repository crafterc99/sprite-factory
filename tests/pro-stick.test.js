/**
 * Pro stick (engine3d/pro-stick.mjs): every ball-handling move on the right stick.
 *
 *   recognizer  analog flicks / holds / spins at 30, 60 and 120 fps; rebounds, nudges, NaN, reset
 *   keyboard    the arrow keys as the stick (taps, digital diagonals, rolls, a held key)
 *   mapping     the stick (screen-relative) → θ in the player's frame (+ = toward the free hand) → the move
 *   roles       the move → the role the library has (fallbacks, missing clips, the hand switch)
 *   gates       no ball / the shot button / a shot playing; the ball hand
 *   buffer      BallSession.requestMove: a newer stick request replaces the queued one
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const PS = import('../engine3d/pro-stick.mjs');
const BS = import('../engine3d/ball-session.mjs');

const RAD = Math.PI / 180;
/** The stick at angle a (deg, 0 = up, +90 = right) and radius r → raw [x, y-down]. */
const polar = (a, r = 1) => [Math.sin(a * RAD) * r, -Math.cos(a * RAD) * r];
/** Feed a stick profile (tMs → [x, y]) for durMs at fps; every gesture it fires. */
function feed(stick, fps, durMs, prof) {
  const out = [];
  for (let i = 0; i * 1000 / fps <= durMs + 1e-9; i++) {
    const t = i * 1000 / fps, [x, y] = prof(t);
    const g = stick.sample(x, y, t);
    if (g) out.push(g);
  }
  return out;
}
/** The first sample time ≥ t0 at fps. */
const firstAt = (t0, fps) => Math.ceil(t0 * fps / 1000 - 1e-9) * 1000 / fps;
const angClose = (a, b, tol) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180) <= tol;

// ── the recognizer (analog) ────────────────────────────────────────────────
for (const fps of [30, 60, 120]) {
  test(`recognizer @${fps} fps: flicks, holds, spins — exactly the gestures made`, async () => {
    const { ProStick } = await PS;
    const run = (durMs, prof) => feed(new ProStick(), fps, durMs, prof);

    // an analog flick left: 20 ms rise, 60 ms at the rim, back, a 0.4 spring-back to the right
    let g = run(500, (t) => (t < 20 ? polar(-90, t / 20) : t < 80 ? polar(-90) : t < 100 ? polar(-90, 1 - (t - 80) / 20) : t < 140 ? polar(90, 0.4) : [0, 0]));
    assert.strictEqual(g.length, 1, `one flick (${JSON.stringify(g)})`);
    assert.strictEqual(g[0].kind, 'flick');
    assert.ok(angClose(g[0].a, -90, 5), `left (${g[0].a})`);
    assert.ok(Math.abs(g[0].dir[0] + 1) < 0.01 && Math.abs(g[0].dir[1]) < 0.01, 'dir is the raw stick direction');

    // a diagonal flick (back-left)
    g = run(400, (t) => (t < 70 ? polar(-135) : [0, 0]));
    assert.strictEqual(g.length, 1); assert.strictEqual(g[0].kind, 'flick');
    assert.ok(angClose(g[0].a, -135, 5), `back-left (${g[0].a})`);

    // a nudge (0.5 for 100 ms): nothing
    assert.strictEqual(run(400, (t) => (t < 100 ? polar(90, 0.5) : [0, 0])).length, 0, 'a nudge is no gesture');

    // held left for 600 ms: one hold after 220 ms, the release adds nothing
    const t0 = 50;
    g = run(900, (t) => (t >= t0 && t < t0 + 600 ? polar(-90) : [0, 0]));
    assert.strictEqual(g.length, 1, `one hold (${JSON.stringify(g)})`);
    assert.strictEqual(g[0].kind, 'hold');
    const tin = firstAt(t0, fps);
    assert.ok(g[0].t - tin >= 220 - 1e-9 && g[0].t - tin <= 220 + 1000 / fps + 1e-9, `the hold fires at 220 ms (${(g[0].t - tin).toFixed(1)})`);
    assert.ok(angClose(g[0].a, -90, 1));

    // a half circle 180 → 0 through 270 (down, left, up) in 300 ms: one spin, no flick on the release
    g = run(700, (t) => (t < 300 ? polar(180 + (t / 300) * 180) : [0, 0]));
    assert.strictEqual(g.length, 1, `one spin (${JSON.stringify(g)})`);
    assert.strictEqual(g[0].kind, 'spin');
    assert.ok(Math.abs(g[0].sweep) >= 75, `swept ${g[0].sweep}°`);

    // a quarter circle 180 → 90 in 200 ms: a spin
    g = run(600, (t) => (t <= 200 ? polar(180 - (t / 200) * 90) : [0, 0]));
    assert.deepStrictEqual(g.map((x) => x.kind), ['spin'], 'a quarter circle is a spin');

    // a 60° curve in 150 ms: a flick (not a spin)
    g = run(500, (t) => (t <= 150 ? polar(-90 - (t / 150) * 60) : [0, 0]));
    assert.deepStrictEqual(g.map((x) => x.kind), ['flick'], 'a 60° curve is a flick');
    assert.ok(angClose(g[0].a, -120, 20), `its direction is the curve's (${g[0].a})`);

    // a slow 90° roll over 1 s: a hold (not a spin)
    g = run(1300, (t) => (t <= 1000 ? polar(-90 + (t / 1000) * 90) : [0, 0]));
    assert.deepStrictEqual(g.map((x) => x.kind), ['hold'], 'a slow roll is a hold');

    // two flicks the same way 100 ms apart: one gesture (the cooldown); a full flick straight back 100 ms after
    // the first: two (the double crossover's second flick — its peak ≥ 0.9: not a spring-back); 250 ms apart: two
    const two = (gap, b = 90) => run(gap + 500, (t) => (t < 60 ? polar(-90) : t >= gap && t < gap + 60 ? polar(b) : [0, 0]));
    assert.strictEqual(two(100, -90).length, 1, 'two flicks the same way 100 ms apart: one gesture');
    assert.strictEqual(two(100, -60).length, 1, 'a second flick 30° off, 100 ms later: one gesture');
    g = two(100);
    assert.deepStrictEqual(g.map((x) => x.kind), ['flick', 'flick'], 'a full flick straight back 100 ms later: two');
    assert.ok(angClose(g[0].a, -90, 5) && angClose(g[1].a, 90, 5));
    g = two(250);
    assert.deepStrictEqual(g.map((x) => x.kind), ['flick', 'flick'], 'two flicks 250 ms apart: two');
    assert.ok(angClose(g[0].a, -90, 5) && angClose(g[1].a, 90, 5));
    // swung straight across, never read at the centre (left for 80 ms, then right for 80 ms, back): two flicks, the
    // second the other way — not one averaged into forward / back
    g = run(600, (t) => (t < 80 ? polar(-90) : t < 160 ? polar(90) : [0, 0]));
    assert.deepStrictEqual(g.map((x) => x.kind), ['flick', 'flick'], `swung across: two flicks (${JSON.stringify(g)})`);
    assert.ok(angClose(g[0].a, -90, 5) && angClose(g[1].a, 90, 5), `left, then right (${g.map((x) => x.a.toFixed(0))})`);

    // a flick, then the stick springs back to 0.8 on the other side for one frame: one flick, the right way
    const f1 = Math.ceil(80 * fps / 1000) * 1000 / fps;
    g = run(500, (t) => (t < 80 ? polar(-90) : t < f1 + 1000 / fps - 1e-6 ? polar(90, 0.8) : [0, 0]));
    assert.strictEqual(g.length, 1, `one gesture (${JSON.stringify(g)})`);
    assert.strictEqual(g[0].kind, 'flick', 'through the centre in one frame is no circle');
    assert.ok(angClose(g[0].a, -90, 5), `still a flick left (${g[0].a})`);

    // NaN axes: the centre, nothing thrown
    const s = new ProStick();
    assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) assert.strictEqual(s.sample(NaN, undefined, i * 16), null); });
    assert.strictEqual(s.debug().out, false);

    // reset() drops an excursion in progress
    const r = new ProStick();
    r.sample(...polar(-90), 0); r.sample(...polar(-90), 1000 / fps);
    assert.strictEqual(r.debug().out, true);
    r.reset();
    assert.strictEqual(r.sample(0, 0, 2000 / fps), null, 'no flick after a reset');
  });
}

// ── the arrow keys (KEYBOARD_STICK, 30 fps) ────────────────────────────────
test('keyboard: a tap is a flick, a roll through four arrow states is a spin, a held key a hold', async () => {
  const { ProStick, KEYBOARD_STICK } = await PS;
  const K = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1], LD: [-1, 1], DR: [1, 1], RU: [1, -1] };
  const unit = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  /** keys: the arrow state per frame (null = none); 30 fps; then released for 10 frames */
  const keys = (frames) => { const s = new ProStick(KEYBOARD_STICK), out = []; [...frames, ...Array(10).fill(null)].forEach((k, i) => { const v = k ? unit(K[k]) : [0, 0]; const g = s.sample(v[0], v[1], (i * 1000) / 30); if (g) out.push(g); }); return out; };
  let g = keys(['L']);
  assert.deepStrictEqual(g.map((x) => x.kind), ['flick'], 'a one-frame tap of ← is a flick');
  assert.ok(angClose(g[0].a, -90, 0.5), `left (${g[0].a})`);
  g = keys(['L', 'LD']);
  assert.deepStrictEqual(g.map((x) => x.kind), ['flick']);
  assert.ok(angClose(g[0].a, -112.5, 0.5), `← then ←↓ is a flick at −112.5 (${g[0].a})`);
  g = keys(['L', 'LD', 'D']);
  assert.deepStrictEqual(g.map((x) => x.kind), ['flick'], '←, ←↓, ↓ is a flick, not a spin');
  assert.ok(angClose(g[0].a, -135, 0.5), `at −135 (${g[0].a})`);
  for (const seq of [['D', 'DR', 'R', 'RU'], ['D', 'D', 'DR', 'DR', 'R', 'R', 'RU', 'RU'], ['D', 'DR', 'DR', 'R', 'RU']]) {
    g = keys(seq);
    assert.deepStrictEqual(g.map((x) => x.kind), ['spin'], `${seq.join(' ')} is a spin`);
  }
  g = keys(Array(12).fill('L'));
  assert.deepStrictEqual(g.map((x) => x.kind), ['hold'], '← held 12 frames is a hold');
  assert.ok(g[0].t >= 260 && g[0].t <= 260 + 1000 / 30, `at ≈260 ms (${g[0].t})`);
});

// ── mapping: the stick → θ → the move ──────────────────────────────────────
test('mapping: the stick is read on the screen, θ in the player\'s frame (+ toward the free hand), the sectors', async () => {
  const { stickTheta, sectorOf } = await PS;
  // the chase camera behind him (he faces +Z): camera forward +Z, its right −X
  const chase = { f: [0, 1], r: [-1, 0] };
  const th = (dir, hand, cam = chase, yaw = 0) => stickTheta(dir, cam.f, cam.r, yaw, hand);
  const near = (a, b) => assert.ok(angClose(a, b, 1e-6), `${a} ≈ ${b}`);
  near(th([0, -1], 'right'), 0); assert.strictEqual(sectorOf(th([0, -1], 'right')), 'hesi');
  near(th([-1, 0], 'right'), 90); assert.strictEqual(sectorOf(th([-1, 0], 'right')), 'crossover');
  near(th([-1, 0], 'left'), -90); assert.strictEqual(sectorOf(th([-1, 0], 'left')), 'inout');
  assert.strictEqual(sectorOf(th([1, 0], 'right')), 'inout');
  assert.strictEqual(sectorOf(th([1, 0], 'left')), 'crossover');
  near(Math.abs(th([0, 1], 'right')), 180); assert.strictEqual(sectorOf(th([0, 1], 'right')), 'btb'); assert.strictEqual(sectorOf(th([0, 1], 'left')), 'btb');
  const dl = [-Math.SQRT1_2, Math.SQRT1_2], dr = [Math.SQRT1_2, Math.SQRT1_2];
  near(th(dl, 'right'), 135); assert.strictEqual(sectorOf(th(dl, 'right')), 'btl');
  near(th(dl, 'left'), -135); assert.strictEqual(sectorOf(th(dl, 'left')), 'stepback');
  assert.strictEqual(sectorOf(th(dr, 'right')), 'stepback');
  assert.strictEqual(sectorOf(th(dr, 'left')), 'btl');
  // he faces +X (yaw 90°), the camera behind him: stick left with the right hand is still toward his free hand
  near(th([-1, 0], 'right', { f: [1, 0], r: [0, 1] }, Math.PI / 2), 90);
  // a side camera (on his left, looking −X; its right −Z): up = toward his right hand
  const side = { f: [-1, 0], r: [0, -1] };
  assert.strictEqual(sectorOf(th([0, -1], 'left', side)), 'crossover');
  assert.strictEqual(sectorOf(th([0, -1], 'right', side)), 'inout');
  assert.strictEqual(sectorOf(th([-1, 0], 'right', side)), 'hesi');
  // the sector boundaries
  const B = [[34.9, 'hesi'], [35, 'crossover'], [104.9, 'crossover'], [105, 'btl'], [149.9, 'btl'], [150, 'btb'], [-150, 'btb'], [180, 'btb'], [-180, 'btb'],
    [-149.9, 'stepback'], [-105, 'stepback'], [-104.9, 'inout'], [-35, 'inout'], [-34.9, 'hesi'], [0, 'hesi']];
  for (const [a, s] of B) assert.strictEqual(sectorOf(a), s, `θ ${a} → ${s}`);
});

// ── roles: what the library has ────────────────────────────────────────────
test('roles: each gesture plays its clip, falls back along its chain, or says it has none', async () => {
  const { resolveGesture, gestureNote } = await PS;
  const lib = { 'move-crossover': {}, 'move-spin': {}, 'idle:mirror': {} };
  const flick = { kind: 'flick' }, hold = { kind: 'hold' }, spin = { kind: 'spin' };
  const R = (g, th, L = lib, o) => resolveGesture(g, th, L, o);
  let r = R(flick, 135);
  assert.deepStrictEqual([r.gesture, r.role, r.fellBack, r.missing], ['btl', 'move-crossover', true, false], 'btl → the crossover');
  r = R(flick, 180); assert.deepStrictEqual([r.gesture, r.role, r.fellBack], ['btb', 'move-crossover', true], 'btb → the crossover');
  for (const [th, ge] of [[0, 'hesi'], [-70, 'inout'], [-130, 'stepback']]) { r = R(flick, th); assert.deepStrictEqual([r.gesture, r.role, r.missing], [ge, null, true], `${ge}: no clip`); }
  r = R(spin, 12); assert.deepStrictEqual([r.gesture, r.role, r.fellBack], ['spin', 'move-spin', false], 'a circle is the spin (whatever its angle)');
  r = R(hold, 90); assert.deepStrictEqual([r.gesture, r.role, r.kind], ['crossover', 'move-crossover', 'hold'], 'no size-up: a hold is its direction\'s move');
  r = R(hold, 90, { ...lib, 'move-sizeup': {} }); assert.deepStrictEqual([r.gesture, r.role], ['sizeup', 'move-sizeup'], 'a size-up clip takes the hold');
  r = R(flick, 135, { ...lib, 'move-btl': {} }); assert.deepStrictEqual([r.role, r.fellBack], ['move-btl', false], 'a between-the-legs clip plays as itself');
  r = R(flick, -70, { ...lib, 'move-hesi': {} }); assert.deepStrictEqual([r.gesture, r.role, r.fellBack], ['inout', 'move-hesi', true], 'in-and-out → the hesitation');
  r = R(flick, 90, { 'move-spin': {}, 'idle:mirror': {} });
  assert.deepStrictEqual([r.role, r.handSwitch, r.fellBack, r.missing], [null, true, true, false], 'no crossover clip: the crossover dribble');
  r = R(flick, 90, { 'move-spin': {} }, { canSwitch: false });
  assert.deepStrictEqual([r.handSwitch, r.missing], [false, true], 'and no mirrored idle either: missing');
  const names = { 'move-crossover': 'crossover' };
  assert.strictEqual(gestureNote(R(flick, 0), names), 'Hesitation — no clip yet');
  assert.strictEqual(gestureNote(R(flick, 135), names), 'Between the legs → crossover (no between the legs clip yet)');
  assert.strictEqual(gestureNote(R(flick, 90, { 'idle:mirror': {} }), names), 'Crossover → crossover dribble (no crossover clip yet)');
  assert.strictEqual(gestureNote(R(flick, 90), names), null, 'played as asked: no note');
  assert.strictEqual(gestureNote({ ignored: 'no ball' }), null);
});

test('gates: no ball, the shot button, a shot playing — ignored; the hand: held, else in flight to, else the dribble hand', async () => {
  const { routeGesture } = await PS;
  const lib = { 'move-crossover': {}, 'idle:mirror': {} };
  const g = { kind: 'flick', dir: [-1, 0] }, cam = { camFwd: [0, 1], camRight: [-1, 0] };
  const P = (o) => ({ hasBall: true, ballFree: false, mode: 'loco', yaw: 0, hand: 'left', ...o });
  assert.strictEqual(routeGesture(g, { P: P({ hasBall: false }), ctl: {}, lib, ...cam }).ignored, 'no ball');
  assert.strictEqual(routeGesture(g, { P: P({ ballFree: true }), ctl: {}, lib, ...cam }).ignored, 'no ball');
  assert.strictEqual(routeGesture(g, { P: P(), ctl: {}, lib, ...cam, shootHeld: true }).ignored, 'shooting');
  assert.strictEqual(routeGesture(g, { P: P({ mode: 'action', action: { clip: { shot: { releaseFrame: 20 } } } }), ctl: {}, lib, ...cam }).ignored, 'shot');
  assert.ok(!routeGesture(g, { P: P({ mode: 'action', action: { clip: {} } }), ctl: {}, lib, ...cam }).ignored, 'a move playing: routed (buffered)');
  // stick left (screen) = his left: toward the free hand with the ball in the right hand
  let r = routeGesture(g, { P: P(), ctl: { heldHand: 'right' }, lib, ...cam });
  assert.deepStrictEqual([r.hand, r.gesture, r.role], ['right', 'crossover', 'move-crossover'], 'held right');
  r = routeGesture(g, { P: P({ hand: 'right' }), ctl: { heldHand: null, flight: { toHand: 'left' } }, lib, ...cam });
  assert.deepStrictEqual([r.hand, r.gesture], ['left', 'inout'], 'in flight to the left hand');
  r = routeGesture(g, { P: P({ hand: 'left' }), ctl: { heldHand: 'both' }, lib, ...cam });
  assert.strictEqual(r.hand, 'left', 'two hands / none: the dribble hand');
});

// ── the double crossover (main: "right stick, flick left then right") ─────────
test('double crossover: a crossover flick, then a flick straight back within 0.5 s while the ball is still in that hand', async () => {
  const { routeGesture, ProStick } = await PS;
  const lib = { 'move-crossover': {}, 'move-double-cross': {}, 'idle:mirror': {} };
  const cam = { camFwd: [0, 1], camRight: [-1, 0] };
  const P = (o) => ({ hasBall: true, ballFree: false, mode: 'loco', yaw: 0, hand: 'right', ...o });
  const flick = (x, t) => ({ kind: 'flick', dir: [x, 0], a: x < 0 ? -90 : 90, t });
  const held = (h) => ({ heldHand: h });
  // the ball in the right hand, the chase camera: left (the crossover), then right → the double crossover
  const a = routeGesture(flick(-1, 1000), { P: P(), ctl: held('right'), lib, ...cam });
  assert.deepStrictEqual([a.gesture, a.role], ['crossover', 'move-crossover']);
  let b = routeGesture(flick(1, 1300), { P: P(), ctl: held('right'), lib, ...cam, prev: a });
  assert.deepStrictEqual([b.gesture, b.role, b.combo], ['doublecross', 'move-double-cross', true], `left, then right: ${JSON.stringify(b)}`);
  // too slow (> 0.5 s): the second flick is its own move (toward the ball hand: the in-and-out)
  b = routeGesture(flick(1, 1600), { P: P(), ctl: held('right'), lib, ...cam, prev: a });
  assert.deepStrictEqual([b.gesture, !!b.combo], ['inout', false], 'too slow: no combo');
  // the first crossover already let go of the ball (it is on its way to the left hand): a crossover back
  b = routeGesture(flick(1, 1300), { P: P(), ctl: { heldHand: null, flight: { toHand: 'left' } }, lib, ...cam, prev: a });
  assert.deepStrictEqual([b.gesture, b.role, !!b.combo], ['crossover', 'move-crossover', false], 'mid-crossover: the flick back is a crossover back');
  // the same way twice / right then left with the ball in the right hand: no combo
  b = routeGesture(flick(-1, 1300), { P: P(), ctl: held('right'), lib, ...cam, prev: a });
  assert.ok(!b.combo, 'left, left: no combo');
  const r1 = routeGesture(flick(1, 1000), { P: P(), ctl: held('right'), lib, ...cam });
  b = routeGesture(flick(-1, 1300), { P: P(), ctl: held('right'), lib, ...cam, prev: r1 });
  assert.deepStrictEqual([r1.gesture, b.gesture, !!b.combo], ['inout', 'crossover', false], 'right (toward the ball hand), then left: an in-and-out, then a crossover');
  // the ball in the left hand: right (toward the free hand), then left → the double crossover (its mirror plays)
  const l1 = routeGesture(flick(1, 1000), { P: P({ hand: 'left' }), ctl: held('left'), lib, ...cam });
  b = routeGesture(flick(-1, 1250), { P: P({ hand: 'left' }), ctl: held('left'), lib, ...cam, prev: l1 });
  assert.deepStrictEqual([l1.gesture, b.role, b.combo], ['crossover', 'move-double-cross', true], 'left hand: right, then left');
  // no double crossover clip: the flick back is its own move
  b = routeGesture(flick(1, 1300), { P: P(), ctl: held('right'), lib: { 'move-crossover': {} }, ...cam, prev: a });
  assert.deepStrictEqual([b.gesture, !!b.combo], ['inout', false], 'no clip: no combo');
  // a combo is not chained: a third flick within the window is its own move
  const c = routeGesture(flick(-1, 1450), { P: P(), ctl: held('right'), lib, ...cam, prev: { ...b, combo: true } });
  assert.ok(!c.combo, 'no third');
  // through the recognizer at 30 / 60 / 120 fps: left for 80 ms, centre, right for 80 ms — two flicks 100–200 ms apart
  for (const fps of [30, 60, 120]) {
    const st = new ProStick(), gs = feed(st, fps, 700, (t) => (t < 80 ? polar(-90) : t < 110 ? [0, 0] : t < 190 ? polar(90) : [0, 0]));
    assert.deepStrictEqual(gs.map((x) => [x.kind, Math.round(x.a)]), [['flick', -90], ['flick', 90]], `@${fps}: two flicks (${JSON.stringify(gs)})`);
    const x1 = routeGesture(gs[0], { P: P(), ctl: held('right'), lib, ...cam }), x2 = routeGesture(gs[1], { P: P(), ctl: held('right'), lib, ...cam, prev: x1 });
    assert.strictEqual(x2.role, 'move-double-cross', `@${fps}: the double crossover`);
  }
});

// ── the buffer: a newer stick request replaces the queued one ──────────────
test('buffer: a newer stick request replaces its queued one; others are never replaced; at most 3', async () => {
  const { BallSession } = await BS;
  const s = new BallSession({ player: {}, mhrRig: null, IK: null });
  s.requestMove('move-spin', 0, { src: 'stick', replace: true });
  s.requestMove('move-crossover', 0.1, { src: 'stick', replace: true });
  s.requestMove('shot-jumper', 0.2);
  assert.deepStrictEqual(s.buffer.map((b) => b.role), ['move-crossover', 'shot-jumper']);
  s.requestMove('move-spin', 0.3, { src: 'stick', replace: true });
  assert.deepStrictEqual(s.buffer.map((b) => b.role), ['shot-jumper', 'move-spin'], 'the unsourced shot stays');
  s.requestMove('move-crossover', 0.4); s.requestMove('move-crossover', 0.5);
  assert.deepStrictEqual(s.buffer.map((b) => b.role), ['move-spin', 'move-crossover', 'move-crossover'], 'the 3-entry cap still holds');
  assert.ok(s.ctl.log.some((l) => /newer stick request replaces/.test(l)), 'logged');
  assert.deepStrictEqual(s.snapshot().buffer, ['move-spin', 'move-crossover', 'move-crossover'], 'snapshot: the roles only');
  s.requestMove('move-spin', 0.6);
  assert.strictEqual(s.buffer.length, 3);
  assert.strictEqual(s.stats.requests, 7);
});

// ── the buffer: a request pushed out of a full buffer is dropped like any other (its shot meter goes away) ──
test('buffer: a request pushed out of the full buffer is dropped — a queued shot\'s armed meter goes with it, the next press works', async () => {
  const { BallSession } = await BS;
  const SM = await import('../engine3d/shot-meter.mjs');
  const meter = new SM.ShotMeter({ seed: 1 }), evs = [];
  const s = new BallSession({ player: {}, mhrRig: null, IK: null, shotMeter: meter, onEvent: (e) => evs.push(e) });
  // the shot button: pressed (armed), its request queued, then three stick moves behind it
  assert.ok(meter.press(0, 'shot-jumper'));
  s.requestMove('shot-jumper', 0);
  s.requestMove('move-crossover', 0.1); s.requestMove('move-spin', 0.2);
  assert.strictEqual(meter.phase, 'armed');
  s.requestMove('move-crossover', 0.3);   // (the 4th: the shot is pushed out of the buffer)
  assert.deepStrictEqual(s.buffer.map((b) => b.role), ['move-crossover', 'move-spin', 'move-crossover']);
  assert.strictEqual(meter.phase, 'idle', 'the pushed-out shot is dropped: its meter is no longer armed');
  assert.deepStrictEqual(evs.filter((e) => e.type === 'dropped').map((e) => e.role), ['shot-jumper'], 'a dropped event for it');
  assert.strictEqual(s.stats.dropped, 1, 'counted as dropped');
  assert.ok(s.ctl.log.some((l) => /shot-jumper dropped/.test(l)), 'logged');
  // the button comes up, the next press is a new shot (it used to be swallowed: the meter still "armed")
  meter.release(0.4);
  assert.ok(meter.press(0.5, 'shot-jumper'), 'the next press arms the meter');
});

// ── the double crossover is recognised against the hand the ball is in THEN: fired later from the other hand, a crossover ──
test('buffer: a double crossover recognised with the ball in one hand never fires from the other — it is a crossover back there', async () => {
  const { BallSession } = await BS;
  const mk = (held) => {
    const P = { hasBall: true, ballFree: false, mode: 'loco', hand: held, switchPending: false, hasMoveFor: () => true, canChain: () => true };
    const s = new BallSession({ player: P, mhrRig: null, IK: null });
    s.ctl.state = held === 'left' ? 'HELD_LEFT' : 'HELD_RIGHT';
    s.lastSchedule = { events: [] };
    return s;
  };
  // recognised with the ball in the right hand (a crossover flick, then straight back) — the request waited while the
  // crossover could not be interrupted, the crossover let go and the LEFT hand caught it: a crossover back, never the
  // mirrored double crossover (left → right → left)
  let s = mk('left');
  s.requestMove('move-double-cross', 0, { src: 'stick', replace: true, hand: 'right' });
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-crossover', hand: 'left' }, 'from the other hand: the crossover back');
  assert.ok(s.ctl.log.some((l) => /double crossover.*crossover/i.test(l)), 'the downgrade is logged');
  // still in the hand it was recognised in: the double crossover
  s = mk('right');
  s.requestMove('move-double-cross', 0, { src: 'stick', replace: true, hand: 'right' });
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-double-cross', hand: 'right' }, 'the same hand: the double crossover');
  // the L key / a request with no recognition hand: as asked, from whichever hand holds the ball
  s = mk('left');
  s.requestMove('move-double-cross', 0);
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-double-cross', hand: 'left' }, 'no recognition hand: as asked');
});
