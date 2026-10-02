/**
 * Move controls (engine3d/move-controls.mjs — the bindings; engine3d/pro-stick.mjs MoveControls — the recognizer):
 * every move on a right-stick trigger the user sets, single gestures or sequences.
 *
 *   model        validation (quantised angles, strict keys, a release after a hold), the defaults = the old mapping,
 *                conflicts (same / prefix / extends / overlap, mirrored or not), words, the move registry
 *   segmenting   raw stick samples → steps (flick / hold / spin / release); noise below the deadzone is nothing
 *   reading      45° quantisation, mirroring with the ball hand (and a binding that is not mirrored), the nearest
 *                single move when nothing matches, a hold no hold binding takes = a flick
 *   sequences    a 2-step combo (flick 225°, then 90° = the pull-back cross), the longest match, upgrade vs wait,
 *                gaps, a combo never chained, a hand change starts a new sequence, the combo's degrade
 *   levels       a long hold, a half circle, a release step
 *   recording    startRecording → the steps, the gaps, mirrored in the left hand, the conflicts
 *   events       step / read / waiting / ignored / record, the trail
 *   buffer       BallSession: a combo fired from the other hand plays its degrade
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const MCm = import('../engine3d/move-controls.mjs');
const PS = import('../engine3d/pro-stick.mjs');
const BS = import('../engine3d/ball-session.mjs');

const RAD = Math.PI / 180;
/** The stick at angle a (deg, 0 = up, +90 = right) and radius r → raw [x, y-down]. */
const polar = (a, r = 1) => [Math.sin(a * RAD) * r, -Math.cos(a * RAD) * r];
/**
 * The court's context: the chase camera behind him (he faces +Z, yaw 0), the ball in `hand` — so a stick angle IS
 * the binding angle with the ball in the right hand (stick ← = 270 = toward the free hand).
 */
const ctxOf = (hand = 'right', lib = null, extra = {}) => ({
  P: { hasBall: true, ballFree: false, mode: 'loco', yaw: 0, hand }, ctl: { heldHand: hand }, camFwd: [0, 1], camRight: [-1, 0],
  lib: lib || { 'move-crossover': {}, 'move-spin': {}, 'move-double-cross': {}, 'idle:mirror': {} }, shootHeld: false, ...extra,
});
/**
 * Drive a MoveControls with a stick profile (tMs → [x, y]) on source src at fps for durMs; every read (the held
 * ones of a 'wait' first, as the court requests them).
 */
function drive(mc, prof, { fps = 60, durMs = 1000, src = 'pad', ctx = ctxOf(), t0 = 0 } = {}) {
  const out = [];
  for (let i = 0; i * 1000 / fps <= durMs + 1e-9; i++) {
    const t = t0 + i * 1000 / fps, [x, y] = prof(t - t0);
    const g = mc.sample(src, x, y, t);
    const c = typeof ctx === 'function' ? ctx(t - t0) : ctx;
    const r = g ? mc.read(g, c) : mc.tick(t, c);
    if (r) for (const x of [...(r.before || []), r]) out.push(x);
  }
  return out;
}
/** Flicks (stick angles) at the given times (ms), each out for 60 ms. */
const flicks = (...seq) => (t) => { for (const [at, a] of seq) if (t >= at && t < at + 60) return polar(a); return [0, 0]; };
const roles = (reads) => reads.filter((r) => !r.waiting && !r.ignored).map((r) => r.role || r.binding);

// ── the model ───────────────────────────────────────────────────────────────
test('model: steps are validated strictly and stored compactly (22.5° angles, defaults left out)', async () => {
  const M = await MCm;
  assert.deepStrictEqual(M.normalizeStep({ flick: 44 }).step, { flick: 45 });
  assert.deepStrictEqual(M.normalizeStep({ flick: 22.4 }).step, { flick: 22.5 });
  assert.deepStrictEqual(M.normalizeStep({ flick: -90 }).step, { flick: 270 });
  assert.deepStrictEqual(M.normalizeStep({ flick: 405 }).step, { flick: 45 });
  assert.deepStrictEqual(M.normalizeStep({ hold: 'any', ms: 600 }).step, { hold: 'any', ms: 600 });
  assert.deepStrictEqual(M.normalizeStep({ hold: 90, ms: 200 }).step, { hold: 90 }, 'a hold shorter than the recognizer\'s is the plain hold');
  assert.deepStrictEqual(M.normalizeStep({ spin: 'cw', turn: 180 }).step, { spin: 'cw', turn: 180 });
  assert.deepStrictEqual(M.normalizeStep({ flick: 90, gap: 350, tol: 22.5 }).step, { flick: 90 }, 'defaults are left out');
  for (const bad of [{ flick: 90, hold: 90 }, {}, { flik: 90 }, { flick: 'left' }, { spin: 'left' }, { spin: 'cw', turn: 45 }, { flick: 90, ms: 300 }, { hold: 90, ms: 50 }, { flick: 90, gap: 10 }, { release: 1 }, { flick: 90, extra: 1 }]) {
    assert.ok(!M.normalizeStep(bad).ok, `rejected: ${JSON.stringify(bad)}`);
  }
  let r = M.normalizeBinding({ role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90, gap: 400 }], mirror: true, mode: 'upgrade' });
  assert.deepStrictEqual(r.binding, { role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }] }, 'compact: mirror / upgrade / the last gap left out');
  r = M.normalizeBinding({ role: 'move-x', steps: [{ hold: 270 }, { release: true }], mirror: false, mode: 'wait' });
  assert.deepStrictEqual(r.binding, { role: 'move-x', steps: [{ hold: 270 }, { release: true }], mirror: false, mode: 'wait' });
  assert.deepStrictEqual(M.normalizeBinding({ role: 'move-x', steps: [{ flick: 0 }], mode: 'wait' }).binding, { role: 'move-x', steps: [{ flick: 0 }] }, 'a single step has no mode');
  for (const bad of [{ role: 'shot-jumper', steps: [{ flick: 0 }] }, { role: 'move-x', steps: [] }, { role: 'move-x', steps: [{ release: true }] }, { role: 'move-x', steps: [{ flick: 0 }, { release: true }] },
    { role: 'Move-X', steps: [{ flick: 0 }] }, { role: 'move-x', steps: Array(7).fill({ flick: 0 }) }, { role: 'move-x', steps: [{ flick: 0 }], mirror: 'yes' }, { role: 'move-x', steps: [{ flick: 0 }], fallback: ['idle'] }, { role: 'move-x', steps: [{ flick: 0 }], foo: 1 }]) {
    assert.ok(!M.normalizeBinding(bad).ok, `rejected: ${JSON.stringify(bad)}`);
  }
});

test('model: the defaults are the old mapping at 45°, valid, with the double crossover as the crossover\'s upgrade', async () => {
  const M = await MCm;
  const d = M.defaultControls();
  const v = M.validateControls(d);
  assert.ok(v.ok, v.errors.join('; '));
  const by = Object.fromEntries(d.bindings.map((b) => [b.role, b.steps]));
  assert.deepStrictEqual(by, {
    'move-crossover': [{ flick: 270 }], 'move-inout': [{ flick: 90 }], 'move-btl': [{ flick: 225 }], 'move-stepback': [{ flick: 135 }], 'move-btb': [{ flick: 180 }],
    'move-hesi': [{ flick: 0 }], 'move-spin': [{ spin: 'any' }], 'move-sizeup': [{ hold: 'any' }], 'move-double-cross': [{ flick: 270, gap: 500 }, { flick: 90, tol: 60 }],
  });
  assert.ok(v.conflicts.some((c) => c.a === 'move-crossover' && c.b === 'move-double-cross' && c.type === 'prefix'), JSON.stringify(v.conflicts));
  assert.ok(!v.conflicts.some((c) => c.type === 'same'));
  d.bindings[0].steps = [{ flick: 0 }];   // the crossover on the hesitation's trigger
  const bad = M.validateControls(d);
  assert.ok(!bad.ok && /same trigger/.test(bad.errors.join()), bad.errors.join('; '));
  assert.ok(Object.isFrozen(M.DEFAULT_BINDINGS) && Object.isFrozen(M.DEFAULT_BINDINGS[0].steps[0]), 'the defaults cannot be changed by accident');
});

test('model: conflicts — same / prefix / extends / overlap, mirrored and not', async () => {
  const M = await MCm;
  const rel = (x, y) => M.relation(x, y)?.type || null;
  const b = (role, steps, o = {}) => ({ role, steps, ...o });
  assert.strictEqual(rel(b('move-a', [{ flick: 90 }]), b('move-b', [{ flick: 90 }])), 'same');
  assert.strictEqual(rel(b('move-a', [{ flick: 225 }]), b('move-b', [{ flick: 225 }, { flick: 90 }])), 'prefix');
  assert.strictEqual(rel(b('move-b', [{ flick: 225 }, { flick: 90 }]), b('move-a', [{ flick: 225 }])), 'extends');
  assert.strictEqual(rel(b('move-a', [{ hold: 'any' }]), b('move-b', [{ hold: 90 }])), 'overlap');
  assert.strictEqual(rel(b('move-a', [{ flick: 90 }]), b('move-b', [{ flick: 135 }])), null, '45° apart: two moves');
  assert.strictEqual(rel(b('move-a', [{ flick: 90 }]), b('move-b', [{ flick: 112.5 }])), 'overlap', '22.5° apart: the tolerances overlap');
  // not mirrored: 90 is his right in both hands; mirrored: 90 is the ball hand — the same in the right hand only
  const r = M.relation(b('move-a', [{ flick: 90 }], { mirror: false }), b('move-b', [{ flick: 90 }]));
  assert.deepStrictEqual(r, { type: 'same', hand: 'right' });
  assert.deepStrictEqual(M.relation(b('move-a', [{ flick: 90 }], { mirror: false }), b('move-b', [{ flick: 270 }])), { type: 'same', hand: 'left' }, 'his right = the ball hand in the right hand, the free hand in the left');
  assert.strictEqual(rel(b('move-a', [{ spin: 'cw' }]), b('move-b', [{ spin: 'ccw' }])), null, 'two mirrored circles the other way: never the same');
  assert.deepStrictEqual(M.relation(b('move-a', [{ spin: 'cw' }]), b('move-b', [{ spin: 'ccw' }], { mirror: false })), { type: 'same', hand: 'left' }, 'a mirrored cw is a ccw in the left hand');
  assert.strictEqual(rel(b('move-a', [{ spin: 'cw' }], { mirror: false }), b('move-b', [{ spin: 'ccw' }], { mirror: false })), null);
  const cs = M.conflictsOf(b('move-pullback-cross', [{ flick: 225 }, { flick: 90 }]), M.defaultControls().bindings);
  assert.deepStrictEqual(cs.map((c) => [c.role, c.type]), [['move-btl', 'extends']]);
  assert.match(cs[0].text, /Between the legs plays first, then upgrades to this/);
});

test('model: words and arrows', async () => {
  const M = await MCm;
  const dc = M.DEFAULT_BINDINGS.find((x) => x.role === 'move-double-cross');
  assert.strictEqual(M.describeBinding(dc), 'flick toward the free hand (270°) → within 500 ms flick toward the ball hand (90°)');
  assert.strictEqual(M.arrowsOf(dc), '← →');
  assert.strictEqual(M.describeBinding({ role: 'move-x', steps: [{ hold: 'any', ms: 600 }] }), 'hold anywhere ≥ 600 ms');
  assert.strictEqual(M.describeBinding({ role: 'move-x', steps: [{ spin: 'cw', turn: 180 }], mirror: false }), '½ circle clockwise (not mirrored)');
  assert.strictEqual(M.roleLabel('move-pullback-cross'), 'Pullback cross');
  assert.strictEqual(M.roleLabel('move-btl'), 'Between the legs');
});

test('registry: every move from the roles table, the clips and the bindings — a new role appears by itself', async () => {
  const M = await MCm;
  const roles = {
    idle: { type: 'loop', runtime: true }, 'move-crossover': { type: 'action', label: 'Crossover (RS toward the free hand)', group: 'moves', runtime: true, switchesHand: true },
    'move-hesi': { type: 'action', label: 'Hesitation', group: 'moves', runtime: true }, 'shot-jumper': { type: 'action', label: 'Jump shot', group: 'shots', runtime: true, shot: true },
    'start-fwd': { type: 'action', label: 'Start', group: 'transitions', runtime: false },
  };
  const clips = { 'move-crossover': [{ id: 'mo-1', name: 'Crossover', hand: 'right', endHand: 'left' }], 'move-pullback-cross': [{ id: 'mo-9', name: 'Pull-back cross', hand: 'right', endHand: 'left' }], 'shot-jumper': [{ id: 'mo-2', name: 'J' }] };
  const reg = M.moveRegistry({ roles, clips, bindings: [...M.defaultControls().bindings, { role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' }] });
  const ids = reg.map((m) => m.role);
  assert.deepStrictEqual(ids.slice(0, 2), ['move-crossover', 'move-hesi'], 'the roles table first');
  assert.ok(ids.includes('move-pullback-cross') && ids.includes('move-double-cross') && !ids.includes('idle') && !ids.includes('start-fwd'), ids.join());
  assert.strictEqual(ids[ids.length - 1], 'shot-jumper', 'shots last');
  const pb = reg.find((m) => m.role === 'move-pullback-cross');
  assert.deepStrictEqual([pb.label, pb.custom, pb.available, pb.switchesHand, pb.bindable, pb.clips.map((c) => c.name)], ['Pullback cross', true, true, true, true, ['Pull-back cross']]);
  assert.deepStrictEqual(pb.arrows, ['↙ →']);
  assert.match(pb.describe[0], /waits/);
  const hs = reg.find((m) => m.role === 'move-hesi');
  assert.deepStrictEqual([hs.available, hs.switchesHand, hs.triggers.length], [false, null, 1]);
  const sh = reg.find((m) => m.role === 'shot-jumper');
  assert.deepStrictEqual([sh.input, sh.bindable, sh.triggers.length], ['shoot', false, 0]);
});

// ── segmenting + reading ─────────────────────────────────────────────────────
test('reading: a flick toward the free hand is the crossover in either hand (mirrored), toward the ball hand the in-and-out', async () => {
  const { MoveControls } = await PS;
  const lib = { 'move-crossover': {}, 'move-inout': {}, 'idle:mirror': {} };
  for (const fps of [30, 60, 120]) {
    let r = drive(new MoveControls(), flicks([100, 270]), { fps, ctx: ctxOf('right', lib) });
    assert.deepStrictEqual(r.map((x) => [x.binding, x.match, x.kind, x.hand]), [['move-crossover', 'exact', 'flick', 'right']], `@${fps} right hand ←`);
    assert.ok(Math.abs(r[0].steps[0].a - 270) < 2, `a ${r[0].steps[0].a}`);
    r = drive(new MoveControls(), flicks([100, 270]), { fps, ctx: ctxOf('left', lib) });
    assert.deepStrictEqual(r.map((x) => [x.binding, x.hand]), [['move-inout', 'left']], `@${fps} left hand ← (toward the ball hand)`);
    assert.ok(Math.abs(r[0].steps[0].a - 90) < 2 && Math.abs(r[0].steps[0].ar - 270) < 2, 'mirrored: a 90 (ball hand), ar 270 (his left)');
    r = drive(new MoveControls(), flicks([100, 90]), { fps, ctx: ctxOf('left', lib) });
    assert.deepStrictEqual(roles(r), ['move-crossover'], `@${fps} left hand → (toward the free hand)`);
  }
});

test('reading: 45° quantisation — each flick is the bound angle within 22.5°; the borders are halfway', async () => {
  const { MoveControls } = await PS;
  const mc = new MoveControls();
  const at = (a) => drive(mc, flicks([50, a]), { durMs: 400, t0: (at.t = (at.t || 0) + 2000) })[0];
  for (const [a, want] of [[270, 'move-crossover'], [250, 'move-crossover'], [292, 'move-crossover'], [90, 'move-inout'], [112, 'move-inout'], [113, 'move-stepback'], [135, 'move-stepback'], [157, 'move-stepback'], [158, 'move-btb'], [180, 'move-btb'], [202, 'move-btb'], [203, 'move-btl'], [225, 'move-btl'], [247, 'move-btl'], [248, 'move-crossover'], [0, 'move-hesi'], [20, 'move-hesi'], [340, 'move-hesi']]) {
    const r = at(a);
    assert.strictEqual(r?.binding, want, `stick ${a}° → ${r?.binding} (${JSON.stringify(r?.steps)})`);
    assert.strictEqual(r.match, 'exact', `${a}°: exact`);
  }
  // 45° from forward: no binding within 22.5° — the nearest by angle (never nothing)
  let r = at(40);
  assert.deepStrictEqual([r.binding, r.match, r.nearest], ['move-hesi', 'nearest', true], `40° → the nearest (hesitation) ${JSON.stringify(r)}`);
  r = at(50);
  assert.deepStrictEqual([r.binding, r.match], ['move-inout', 'nearest'], '50° → the nearest (in-and-out)');
  r = at(315);
  assert.deepStrictEqual([r.binding, r.match], ['move-crossover', 'nearest'], 'exactly between: the binding listed first (the lateral move)');
});

test('reading: a binding that is not mirrored reads his own left / right whatever the hand', async () => {
  const { MoveControls } = await PS;
  const mc = new MoveControls({ controls: { bindings: [{ role: 'move-hesi', steps: [{ flick: 90 }], mirror: false }, { role: 'move-crossover', steps: [{ flick: 180 }] }] } });
  const lib = { 'move-hesi': {}, 'move-crossover': {} };
  assert.deepStrictEqual(roles(drive(mc, flicks([50, 90]), { ctx: ctxOf('right', lib) })), ['move-hesi'], 'right hand, stick →');
  assert.deepStrictEqual(roles(drive(mc, flicks([50, 90]), { ctx: ctxOf('left', lib), t0: 5000 })), ['move-hesi'], 'left hand, stick → (his right still)');
  const r = drive(mc, flicks([50, 270]), { ctx: ctxOf('left', lib), t0: 9000 });
  assert.deepStrictEqual(r.map((x) => [x.binding, x.match]), [['move-crossover', 'nearest']], 'left hand, stick ← is not his right: the nearest move');
  // a mirrored and an unmirrored binding on one trigger in one hand: refused
  assert.ok(!mc.setControls({ bindings: [{ role: 'move-hesi', steps: [{ flick: 90 }], mirror: false }, { role: 'move-crossover', steps: [{ flick: 270 }] }] }).ok, 'the same trigger with the ball in the left hand');
});

test('reading: noise below the deadzone (and a nudge) is nothing; a slow push still reads; the gates ignore', async () => {
  const { MoveControls } = await PS;
  const mc = new MoveControls(), evs = [];
  mc.on((e) => evs.push(e.type));
  // the thumb resting off-centre, wobbling at r 0.25 for 2 s; a nudge to 0.5
  assert.deepStrictEqual(drive(mc, (t) => polar(t * 0.3, 0.25), { durMs: 2000 }), []);
  assert.deepStrictEqual(drive(mc, (t) => (t < 100 ? polar(270, 0.5) : [0, 0]), { durMs: 500, t0: 3000 }), []);
  assert.deepStrictEqual(evs, [], 'no event at all');
  // pushed slowly (0.6 s to the rim and back, never steady): a flick (slow), not nothing
  const slow = (t) => (t < 600 ? polar(270 + (t / 600) * 30, Math.min(0.75, t / 300)) : [0, 0]);   // (never at the rim: no hold)
  const r = drive(mc, slow, { durMs: 900, t0: 5000 });
  assert.deepStrictEqual(r.map((x) => [x.binding, x.steps[0].slow]), [['move-crossover', true]], JSON.stringify(r));
  // no ball / the shot button / a shot playing: ignored, never buffered
  for (const [extra, why] of [[{ P: { hasBall: false, yaw: 0 } }, 'no ball'], [{ shootHeld: true }, 'shooting'], [{ P: { hasBall: true, yaw: 0, mode: 'action', action: { clip: { shot: {} } } } }, 'shot']]) {
    const x = drive(new MoveControls(), flicks([50, 270]), { durMs: 300, ctx: ctxOf('right', null, extra) });
    assert.deepStrictEqual(x.map((y) => y.ignored), [why]);
  }
});

test('reading: a hold — the size-up with its clip, else a flick of its direction (once per push)', async () => {
  const { MoveControls } = await PS;
  const held = (t) => (t >= 50 && t < 1050 ? polar(270) : [0, 0]);
  let r = drive(new MoveControls(), held, { durMs: 1300 });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.binding, x.role]), [['hold', 'move-crossover', 'move-crossover']], 'no size-up clip: the crossover');
  r = drive(new MoveControls(), held, { durMs: 1300, ctx: ctxOf('right', { 'move-sizeup': {}, 'move-crossover': {} }) });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.binding]), [['hold', 'move-sizeup']], 'a size-up clip takes the hold');
  // the keyboard as the stick: a held ← (digital) is the same
  r = drive(new MoveControls(), (t) => (t < 400 ? [-1, 0] : [0, 0]), { fps: 30, src: 'kbd', durMs: 700 });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.binding]), [['hold', 'move-crossover']], 'the arrow key held');
  r = drive(new MoveControls(), (t) => (t < 30 ? [-1, 0] : [0, 0]), { fps: 30, src: 'kbd', durMs: 400 });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.binding]), [['flick', 'move-crossover']], 'the arrow key tapped');
});

test('reading: circles — any, or by sense (cw = from forward toward the ball hand), mirrored in the left hand', async () => {
  const { MoveControls } = await PS;
  const controls = { bindings: [{ role: 'move-spin', steps: [{ spin: 'cw' }] }, { role: 'move-hesi', steps: [{ spin: 'ccw' }] }, { role: 'move-crossover', steps: [{ flick: 270 }] }] };
  const arc = (from, to, ms = 200) => (t) => (t >= 50 && t <= 50 + ms ? polar(from + (to - from) * (t - 50) / ms) : [0, 0]);
  const lib = { 'move-spin': {}, 'move-hesi': {}, 'move-crossover': {} };
  assert.deepStrictEqual(roles(drive(new MoveControls({ controls }), arc(0, 90), { ctx: ctxOf('right', lib) })), ['move-spin'], 'up → right, ball right: cw');
  assert.deepStrictEqual(roles(drive(new MoveControls({ controls }), arc(0, -90), { ctx: ctxOf('right', lib) })), ['move-hesi'], 'up → left, ball right: ccw');
  assert.deepStrictEqual(roles(drive(new MoveControls({ controls }), arc(0, -90), { ctx: ctxOf('left', lib) })), ['move-spin'], 'up → left, ball left: toward the ball hand = cw (mirrored)');
  // the defaults: any circle is the spin
  assert.deepStrictEqual(roles(drive(new MoveControls(), arc(180, 360, 300))), ['move-spin']);
  // no circle bound at all: the nearest single move by the stick's angle (never nothing)
  const r = drive(new MoveControls({ controls: { bindings: [{ role: 'move-crossover', steps: [{ flick: 270 }] }] } }), arc(180, 270, 200), { ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.binding, x.match]), [['spin', 'move-crossover', 'nearest']]);
});

// ── sequences ────────────────────────────────────────────────────────────────
test('sequences: flick 225° then 90° is the pull-back cross — upgraded from the between-the-legs, or waited for', async () => {
  const { MoveControls } = await PS;
  const M = await MCm;
  const lib = { 'move-pullback-cross': {}, 'move-crossover': {}, 'move-btl': {}, 'idle:mirror': {} };
  const withPB = (mode) => ({ bindings: [...M.defaultControls().bindings, { role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }], ...(mode ? { mode } : {}) }] });
  // upgrade (default): the between-the-legs plays at once, the pull-back cross upgrades it
  for (const fps of [30, 60, 120]) {
    const r = drive(new MoveControls({ controls: withPB() }), flicks([100, 225], [300, 90]), { fps, ctx: ctxOf('right', lib) });
    assert.deepStrictEqual(r.map((x) => [x.binding, x.combo, x.upgradeOf]), [['move-btl', false, null], ['move-pullback-cross', true, 'move-btl']], `@${fps}: ${JSON.stringify(r.map((x) => x.binding))}`);
    assert.strictEqual(r[1].degrade, 'move-crossover', 'from the other hand (the btl took the ball there): its last step there — a crossover back');
    assert.deepStrictEqual(r[1].steps.map((s) => Math.round(s.a / 45) * 45), [225, 90]);
  }
  // wait: nothing until the combo is complete
  let r = drive(new MoveControls({ controls: withPB('wait') }), flicks([100, 225], [300, 90]), { ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting:' + x.waiting.join() : x.binding)), ['waiting:move-pullback-cross', 'move-pullback-cross']);
  assert.ok(!r[1].before && !r[1].upgradeOf, 'no move before it');
  // wait, and the second flick never comes: the between-the-legs plays when the gap has run out (late)
  r = drive(new MoveControls({ controls: withPB('wait') }), flicks([100, 225]), { ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting' : x.binding)), ['waiting', 'move-btl']);
  assert.ok(r[1].late >= 350 && r[1].late < 380, `late by the gap (${r[1].late} ms)`);
  // wait, and a different flick comes: the held between-the-legs first, then that one
  r = drive(new MoveControls({ controls: withPB('wait') }), flicks([100, 225], [300, 0]), { ctx: ctxOf('right', { ...lib, 'move-hesi': {} }) });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting' : x.binding)), ['waiting', 'move-btl', 'move-hesi']);
  // the ball in the left hand: the whole trigger mirrored (stick 135°, then 270°)
  r = drive(new MoveControls({ controls: withPB() }), flicks([100, 135], [300, 270]), { ctx: ctxOf('left', lib) });
  assert.deepStrictEqual(roles(r), ['move-btl', 'move-pullback-cross'], 'left hand: mirrored');
  // no clip for the combo: it never swallows its steps
  r = drive(new MoveControls({ controls: withPB('wait') }), flicks([100, 225], [300, 90]), { ctx: ctxOf('right', { 'move-btl': {}, 'move-inout': {} }) });
  assert.deepStrictEqual(roles(r), ['move-btl', 'move-inout']);
});

test('sequences: gaps — each step inside the previous one\'s gap (default 350 ms; the double crossover 500)', async () => {
  const { MoveControls } = await PS;
  const M = await MCm;
  const lib = { 'move-pullback-cross': {}, 'move-btl': {}, 'move-inout': {}, 'move-crossover': {}, 'move-double-cross': {}, 'idle:mirror': {} };
  const controls = { bindings: [...M.defaultControls().bindings, { role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }] }] };
  // (a flick fires on its return: 60 ms out, so the reads are (b − a) apart)
  for (const [gap, want] of [[200, 'move-pullback-cross'], [340, 'move-pullback-cross'], [420, 'move-inout']]) {
    const r = drive(new MoveControls({ controls }), flicks([100, 225], [100 + gap, 90]), { ctx: ctxOf('right', lib) });
    assert.strictEqual(r[r.length - 1].binding, want, `225°, then 90° ${gap} ms later → ${want}`);
  }
  for (const [gap, want] of [[450, 'move-double-cross'], [560, 'move-inout']]) {
    const r = drive(new MoveControls(), flicks([100, 270], [100 + gap, 90]), { ctx: ctxOf('right', lib) });
    assert.strictEqual(r[r.length - 1].binding, want, `the double crossover ${gap} ms apart → ${want}`);
  }
  // a third flick right after the double crossover is its own move (a combo is never chained)
  const r = drive(new MoveControls(), flicks([100, 270], [300, 90], [500, 270]), { ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(roles(r), ['move-crossover', 'move-double-cross', 'move-crossover']);
  assert.ok(!r[2].combo && !r[2].upgradeOf);
});

test('sequences: the longest match wins; a step read in the other hand starts a new sequence', async () => {
  const { MoveControls } = await PS;
  const controls = { bindings: [
    { role: 'move-crossover', steps: [{ flick: 270 }] }, { role: 'move-inout', steps: [{ flick: 90 }] }, { role: 'move-hesi', steps: [{ flick: 0 }] },
    { role: 'move-double-cross', steps: [{ flick: 270 }, { flick: 90 }] }, { role: 'move-triple', steps: [{ flick: 270 }, { flick: 90 }, { flick: 0 }] },
  ] };
  const lib = { 'move-crossover': {}, 'move-inout': {}, 'move-hesi': {}, 'move-double-cross': {}, 'move-triple': {} };
  let r = drive(new MoveControls({ controls }), flicks([100, 270], [300, 90], [500, 0]), { ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => [x.binding, x.n, x.upgradeOf]), [['move-crossover', 1, null], ['move-double-cross', 2, 'move-crossover'], ['move-triple', 3, 'move-double-cross']], 'each step upgrades to the longer combo');
  // the ball changed hands between the steps (the crossover let go of it): the second flick is read alone, in the new hand
  r = drive(new MoveControls({ controls }), flicks([100, 270], [300, 90]), { ctx: (t) => ctxOf(t < 200 ? 'right' : 'left', lib) });
  assert.deepStrictEqual(r.map((x) => [x.binding, x.hand, x.combo]), [['move-crossover', 'right', false], ['move-crossover', 'left', false]], 'a crossover back, never the combo');
});

test('sequences: the old stateless routeGesture still upgrades the crossover with the previous read', async () => {
  const { routeGesture } = await PS;
  const lib = { 'move-crossover': {}, 'move-double-cross': {} }, cam = { camFwd: [0, 1], camRight: [-1, 0] };
  const P = { hasBall: true, ballFree: false, mode: 'loco', yaw: 0, hand: 'right' };
  const a = routeGesture({ kind: 'flick', dir: [-1, 0], a: -90, t: 0 }, { P, ctl: { heldHand: 'right' }, lib, ...cam });
  const b = routeGesture({ kind: 'flick', dir: [1, 0], a: 90, t: 200 }, { P, ctl: { heldHand: 'right' }, lib, ...cam, prev: a });
  assert.deepStrictEqual([a.gesture, b.gesture, b.combo, b.upgradeOf, b.degrade], ['crossover', 'doublecross', true, 'move-crossover', 'move-crossover']);
  // with bindings of the user's
  const c = routeGesture({ kind: 'flick', dir: [-1, 0], a: -90, t: 0 }, { P, ctl: { heldHand: 'right' }, lib: { 'move-hesi': {} }, ...cam, controls: { bindings: [{ role: 'move-hesi', steps: [{ flick: 270 }] }] } });
  assert.deepStrictEqual([c.binding, c.role], ['move-hesi', 'move-hesi']);
});

// ── levels: a long hold, a half circle, a release ───────────────────────────
test('levels: a long hold waits for its length; a half circle upgrades the quarter; a release ends a hold', async () => {
  const { MoveControls } = await PS;
  const lib = { 'move-sizeup': {}, 'move-crossover': {}, 'move-spin': {}, 'move-x': {}, 'move-y': {}, 'move-z': {} };
  const M = await MCm;
  // a hold anywhere for 600 ms → move-x: a shorter hold reads as before when it ends (released: the stick's own move)
  let mc = new MoveControls({ controls: { bindings: [...M.defaultControls().bindings.filter((b) => b.role !== 'move-sizeup'), { role: 'move-x', steps: [{ hold: 'any', ms: 600 }] }] } });
  assert.deepStrictEqual(mc.sticks.pad.cfg.holdLevels, [600], 'the stick reports the 600 ms hold');
  let r = drive(mc, (t) => (t >= 50 && t < 950 ? polar(270) : [0, 0]), { durMs: 1200, ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting' : x.binding)), ['waiting', 'move-x'], 'held 0.9 s: move-x');
  r = drive(mc, (t) => (t >= 50 && t < 450 ? polar(270) : [0, 0]), { durMs: 1200, ctx: ctxOf('right', lib), t0: 5000 });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting' : x.binding)), ['waiting', 'move-crossover'], 'held 0.4 s: its direction\'s move, when it was let go');
  assert.ok(r[1].late < 250, `played on the release (${r[1].late} ms after the hold read)`);
  // a half circle → move-y; a quarter → the spin
  mc = new MoveControls({ controls: { bindings: [{ role: 'move-spin', steps: [{ spin: 'any' }] }, { role: 'move-y', steps: [{ spin: 'any', turn: 180 }] }] } });
  r = drive(mc, (t) => (t >= 50 && t <= 350 ? polar(180 + (t - 50) / 300 * 180) : [0, 0]), { durMs: 900, ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(roles(r), ['move-y'], `a half circle (${JSON.stringify(r.map((x) => x.waiting || x.binding))})`);
  r = drive(mc, (t) => (t >= 50 && t <= 200 ? polar(180 - (t - 50) / 150 * 90) : [0, 0]), { durMs: 900, ctx: ctxOf('right', lib), t0: 5000 });
  assert.deepStrictEqual(roles(r), ['move-spin'], 'a quarter circle');
  // hold toward the free hand, then let go → move-z
  mc = new MoveControls({ controls: { bindings: [{ role: 'move-crossover', steps: [{ flick: 270 }] }, { role: 'move-z', steps: [{ hold: 270 }, { release: true }], mode: 'wait' }] } });
  assert.strictEqual(mc.sticks.pad.cfg.releases, true);
  r = drive(mc, (t) => (t >= 50 && t < 600 ? polar(270) : [0, 0]), { durMs: 900, ctx: ctxOf('right', lib) });
  assert.deepStrictEqual(r.map((x) => (x.waiting ? 'waiting' : x.binding)), ['waiting', 'move-z']);
  assert.ok(r[1].t >= 600 && r[1].t < 640, `on the release (${r[1].t})`);
});

// ── recording ────────────────────────────────────────────────────────────────
test('recording: the next sequence performed becomes the steps (relative to the ball hand), with its conflicts', async () => {
  const { MoveControls } = await PS;
  let mc = new MoveControls();
  const evs = [];
  mc.on((e) => { if (e.type === 'record') evs.push(e.phase); });
  let done = mc.startRecording('move-pullback-cross');
  assert.deepStrictEqual(mc.recording, { role: 'move-pullback-cross', steps: [] });
  let r = drive(mc, flicks([100, 222], [300, 95]), { durMs: 1200 });
  assert.deepStrictEqual(r.map((x) => [x.recording, x.role]), [['move-pullback-cross', undefined], ['move-pullback-cross', undefined]], 'every gesture is recorded, nothing plays');
  let out = await done;
  assert.deepStrictEqual(out.steps, [{ flick: 225 }, { flick: 90 }]);
  assert.deepStrictEqual(out.binding, { role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }] });
  assert.deepStrictEqual(out.conflicts.map((c) => [c.role, c.type]), [['move-btl', 'extends']]);
  assert.deepStrictEqual(evs, ['start', 'step', 'step', 'done']);
  assert.strictEqual(mc.recording, null);
  // the ball in the left hand: performed mirrored (135°, then 270°), stored the same
  done = mc.startRecording('move-pullback-cross');
  drive(mc, flicks([100, 135], [300, 270]), { durMs: 1200, ctx: ctxOf('left'), t0: 5000 });
  assert.deepStrictEqual((await done).steps, [{ flick: 225 }, { flick: 90 }]);
  // a slower pause than the default gap is kept (with room); a hold; the same trigger as another move
  done = mc.startRecording('move-hesi', { holdAny: true });
  // (the flick reads at ≈167 ms, the hold at ≈633: 467 ms apart — kept as a 600 ms gap)
  drive(mc, (t) => (t >= 100 && t < 160 ? polar(180) : t >= 400 && t < 1000 ? polar(90) : [0, 0]), { durMs: 2000, t0: 9000 });
  out = await done;
  assert.deepStrictEqual(out.steps, [{ flick: 180, gap: 600 }, { hold: 'any' }]);
  done = mc.startRecording('move-hesi');
  drive(mc, flicks([100, 270]), { durMs: 1000, t0: 15000 });
  out = await done;
  assert.deepStrictEqual(out.conflicts.filter((c) => c.type === 'same').map((c) => c.role), ['move-crossover']);
  // the move's own setting: not mirrored → his own angles
  mc = new MoveControls({ controls: { bindings: [{ role: 'move-hesi', steps: [{ flick: 0 }], mirror: false }] } });
  done = mc.startRecording('move-hesi');
  drive(mc, flicks([100, 270]), { durMs: 1000, ctx: ctxOf('left') });
  assert.deepStrictEqual((await done).binding, { role: 'move-hesi', steps: [{ flick: 270 }], mirror: false });
  // cancelled / nothing performed
  done = mc.startRecording('move-hesi', { timeoutMs: 500 });
  drive(mc, () => [0, 0], { durMs: 800, t0: 30000 });
  assert.deepStrictEqual(await done, { role: 'move-hesi', cancelled: true, reason: 'timeout', steps: [] });
});

// ── events + the dry run ─────────────────────────────────────────────────────
test('events: step (with its trail), read, waiting, ignored; the history; simulate', async () => {
  const { MoveControls } = await PS;
  const mc = new MoveControls({ controls: { bindings: [{ role: 'move-crossover', steps: [{ flick: 270 }] }, { role: 'move-x', steps: [{ flick: 270 }, { flick: 90 }], mode: 'wait' }] } });
  const evs = [];
  const off = mc.on((e) => evs.push(e));
  mc.test(true);
  drive(mc, flicks([100, 270], [300, 90]), { ctx: ctxOf('right', { 'move-crossover': {}, 'move-x': {} }) });
  drive(mc, flicks([100, 270]), { ctx: ctxOf('right', null, { shootHeld: true }), t0: 5000 });
  const types = evs.map((e) => e.type).filter((t) => t !== 'sample');
  assert.deepStrictEqual(types, ['step', 'waiting', 'step', 'read', 'ignored']);
  assert.ok(evs.filter((e) => e.type === 'sample').length >= 6, 'live samples while the test view is on');
  const st = evs.find((e) => e.type === 'step');
  assert.ok(st.trail.length >= 3 && st.trail.every((p) => p.length === 3), `the excursion's trail (${st.trail.length} points)`);
  assert.ok(Math.abs(st.step.a - 270) < 2 && st.stick.src === 'pad');
  const rd = evs.find((e) => e.type === 'read').read;
  assert.deepStrictEqual([rd.binding, rd.combo, rd.match, rd.steps.length], ['move-x', true, 'exact', 2]);
  assert.deepStrictEqual(mc.history().map((h) => h.waiting ? 'waiting' : h.ignored ? 'ignored' : h.binding), ['waiting', 'move-x', 'ignored']);
  off(); mc.test(false);
  const n = evs.length;
  drive(mc, flicks([100, 270]), { t0: 9000 });
  assert.strictEqual(evs.length, n, 'unsubscribed');
  // the dry run (the UI's "what would this do"), nothing recorded in the history
  const h0 = mc.history().length;
  assert.deepStrictEqual(mc.simulate([{ flick: 270 }, { flick: 90 }]).map((x) => x.binding), ['move-x']);
  assert.deepStrictEqual(mc.simulate([{ flick: 270 }]).map((x) => [x.binding, x.late != null]), [['move-crossover', true]], 'the wait runs out: the crossover, late');
  assert.deepStrictEqual(mc.simulate([{ flick: 270 }, { flick: 90, dt: 600 }]).map((x) => x.binding), ['move-crossover', 'move-crossover'], 'too slow: the crossover, then the nearest move to 90°');
  assert.strictEqual(mc.history().length, h0);
});

test('bindings: invalid controls are refused (nothing changes); the stick levels follow the bindings', async () => {
  const { MoveControls } = await PS;
  const mc = new MoveControls();
  const before = mc.controls;
  const r = mc.setControls({ bindings: [{ role: 'move-a', steps: [{ flick: 90 }] }, { role: 'move-b', steps: [{ flick: 90 }] }] });
  assert.ok(!r.ok && /same trigger/.test(r.errors[0]));
  assert.deepStrictEqual(mc.controls, before);
  assert.throws(() => new MoveControls({ controls: { bindings: 'x' } }), /invalid move controls/);
  assert.deepStrictEqual(mc.sticks.pad.cfg.holdLevels, []);
  assert.strictEqual(mc.sticks.pad.cfg.releases, false, 'the defaults: the stick exactly as before');
  mc.setControls({ bindings: [{ role: 'move-a', steps: [{ hold: 'any', ms: 900 }] }, { role: 'move-b', steps: [{ spin: 'cw', turn: 180 }] }] });
  assert.deepStrictEqual([mc.sticks.pad.cfg.holdLevels, mc.sticks.pad.cfg.spinLevels, mc.sticks.kbd.cfg.holdLevels], [[900], [180], [900]]);
});

// ── the buffer: a combo fired from the other hand plays its degrade ─────────
test('buffer: a combo recognised in one hand fires from the other as its degrade (generic), once', async () => {
  const { BallSession } = await BS;
  const mk = (held) => {
    const P = { hasBall: true, ballFree: false, mode: 'loco', hand: held, switchPending: false, hasMoveFor: () => true, canChain: () => true };
    const s = new BallSession({ player: P, mhrRig: null, IK: null });
    s.ctl.state = held === 'left' ? 'HELD_LEFT' : 'HELD_RIGHT';
    s.lastSchedule = { events: [] };
    return s;
  };
  let s = mk('left');
  s.requestMove('move-pullback-cross', 0, { src: 'stick', replace: true, hand: 'right', degrade: 'move-crossover' });
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-crossover', hand: 'left' });
  assert.ok(s.ctl.log.some((l) => /move-pullback-cross \(recognised in the right hand\) fires from the left hand: move-crossover instead/.test(l)));
  s = mk('right');
  s.requestMove('move-pullback-cross', 0, { src: 'stick', replace: true, hand: 'right', degrade: 'move-crossover' });
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-pullback-cross', hand: 'right' }, 'the same hand: the combo');
  // degrade null: dropped
  s = mk('left');
  s.requestMove('move-x', 0, { src: 'stick', replace: true, hand: 'right', degrade: null });
  assert.strictEqual(s.nextTrigger(0.2), null);
  assert.strictEqual(s.buffer.length, 0);
  // a single move (no degrade) from the other hand: as asked
  s = mk('left');
  s.requestMove('move-spin', 0, { src: 'stick', replace: true, hand: 'right' });
  assert.deepStrictEqual(s.nextTrigger(0.2), { role: 'move-spin', hand: 'left' });
});
