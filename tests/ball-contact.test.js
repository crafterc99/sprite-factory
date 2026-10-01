/**
 * Ball contact system tests (docs/ball-contact-system.md → TESTING).
 *
 * Unit: the trajectory solver, contact detection on the recorded between-the-legs → cross → shot
 * take, the state machine's allowed transitions, the compact (networkable) state, edit validation.
 * Game scenarios: the court's real game tick run headless (tests/helpers/ball-harness.mjs: the
 * real Player, MHR skinning, physics, IK and engine3d/ball-session.mjs) on the court's clips —
 * stationary right / left dribble, crossovers both ways, jog, backpedal, sideways, diagonal,
 * sprint, a combo, an interruption, at 30 / 60 / 120 fps, on characters of different height and
 * arm length. Every tick is checked: floor, teleports, catches, bounces, transitions, NaN,
 * ownership, IK reach, leg clearance of controlled flights.
 *
 * Game scenarios need the clip library (data/mocap: npm run clips:pull) and skip without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T = import('../engine3d/ball-trajectory.mjs');
const BC = import('../engine3d/ball-contacts.mjs');
const CTL = import('../engine3d/ball-control.mjs');
const H = import('./helpers/ball-harness.mjs');
const HAVE_CLIPS = fs.existsSync(path.join(ROOT, 'data', 'mocap', 'index.json'));
const skip = HAVE_CLIPS ? false : 'no clip library (npm run clips:pull)';

const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ── solver ──────────────────────────────────────────────────────────────────
test('solver: a segment hits its target at its time, starts with the hand velocity, never below the floor', async () => {
  const S = await T;
  const seg = S.solveSegment({ t0: 1, p0: [0.3, 0.85, 0.3], v0: [0.3, -2.4, 0.2], t1: 1.22, p1: [0.35, 0.12, 0.42], kind: 'down' });
  assert.ok(d3(S.segPos(seg, 1.22), [0.35, 0.12, 0.42]) < 1e-9, 'lands on the bounce target');
  assert.ok(d3(S.segVel(seg, 1), [0.3, -2.4, 0.2]) < 1e-9, 'leaves with the hand velocity (C1 at the release)');
  assert.ok(S.segMinY(seg) >= 0.12 - 1e-6, `never below floor + R (min ${S.segMinY(seg)})`);
  // velocity is the derivative of position (closed form)
  const h = 1e-5, fd = S.segPos(seg, 1.1 + h).map((x, k) => (x - S.segPos(seg, 1.1 - h)[k]) / (2 * h));
  assert.ok(d3(fd, S.segVel(seg, 1.1)) < 1e-6);
});

test('solver: a planned dribble bounces exactly on the floor with a believable restitution and meets the hand', async () => {
  const S = await T;
  const P = S.planDribble({ tr: 0, pr: [0.3, 0.85, 0.3], vr: [0, -1.8, 0.1], tb: 0.2, tbWindow: [0.15, 0.25], pb: [0.32, 0, 0.38], tc: 0.5, pc: [0.3, 0.82, 0.33] });
  assert.ok(Math.abs(S.segPos(P.down, P.tb)[1] - 0.12) < 1e-9, 'ball centre = floor + R at the bounce');
  assert.ok(P.restitution >= S.REST_RANGE[0] && P.restitution <= S.REST_RANGE[1], `restitution ${P.restitution}`);
  assert.ok(d3(S.segPos(P.up, 0.5), [0.3, 0.82, 0.33]) < 1e-9, 'arrives at the catch target');
  assert.ok(Math.min(S.segMinY(P.down), S.segMinY(P.up)) >= 0.12 - 1e-6);
});

test('solver: re-targeting mid-flight keeps position and velocity continuous (no pop)', async () => {
  const S = await T;
  const P = S.planDribble({ tr: 0, pr: [0.3, 0.85, 0.3], vr: [0, -1.8, 0], tb: 0.2, pb: [0.32, 0, 0.38], tc: 0.5, pc: [0.3, 0.82, 0.33] });
  const r = S.retarget(P.up, 0.4, [0.36, 0.86, 0.37]);
  assert.ok(d3(S.segPos(r, 0.4), S.segPos(P.up, 0.4)) < 1e-9);
  assert.ok(d3(S.segVel(r, 0.4), S.segVel(P.up, 0.4)) < 1e-9);
  assert.ok(d3(S.segPos(r, 0.5), [0.36, 0.86, 0.37]) < 1e-9);
});

test('solver: frame-rate independent — the same time gives the same ball at 30, 60 and 120 fps', async () => {
  const S = await T;
  const P = S.planDribble({ tr: 0, pr: [0.3, 0.85, 0.3], vr: [0, -1.8, 0], tb: 0.2, pb: [0.32, 0, 0.38], tc: 0.5, pc: [0.3, 0.82, 0.33] });
  const at = (t) => (t <= P.tb ? S.segPos(P.down, t) : S.segPos(P.up, t));
  for (const fps of [30, 60, 120]) { let t = 0; for (let k = 0; k < fps * 0.3; k++) t += 1 / fps; assert.ok(d3(at(t), at(0.3)) < 1e-9); }
});

// ── the state machine ───────────────────────────────────────────────────────
test('state machine: invalid transitions are rejected and logged; a new possession holds the ball on the palm', async () => {
  const C = await CTL;
  const ctl = new C.BallController();
  const palm = { c: [0, 1, 0], n: [0, -1, 0], x: [1, 0, 0], y: [0, 0, 1] };
  const targets = { left: { ...C.palmTarget(palm, ctl.cfg, 'left'), v: [0, 0, 0] }, right: { ...C.palmTarget({ ...palm, c: [0.3, 1, 0] }, ctl.cfg, 'right'), v: [0, 0, 0] } };
  assert.ok(ctl.giveBall('left', targets, 0));
  assert.strictEqual(ctl.state, 'HELD_LEFT');
  assert.ok(d3(ctl.p, targets.left.p) < 1e-9);
  assert.strictEqual(ctl.go('BOUNCE', 'test'), false, 'HELD → BOUNCE is not a valid transition');
  assert.strictEqual(ctl.rejected, 1);
  assert.ok(ctl.log.some((l) => /REJECTED HELD_LEFT → BOUNCE/.test(l)));
  for (const [from, list] of Object.entries(C.TRANSITIONS)) for (const to of list) assert.ok(C.STATES.includes(to), `${from} → ${to} is a known state`);
});

test('compact state: a snapshot restores to the same ball path (networking)', async () => {
  const C = await CTL, S = await T;
  const a = new C.BallController();
  a.state = 'DRIBBLE_DOWN'; a.t = 0.1;
  const P = S.planDribble({ tr: 0, pr: [0.3, 0.85, 0.3], vr: [0, -1.8, 0], tb: 0.2, pb: [0.32, 0, 0.38], tc: 0.5, pc: [0.3, 0.82, 0.33] });
  a.flight = { kind: 'dribble', down: P.down, up: P.up, tr: 0, tb: P.tb, tc: 0.5, fromHand: 'left', toHand: 'left', bounceAt: [0.32, 0.12, 0.38], catchAt: [0.3, 0.82, 0.33], eventIds: {} };
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  assert.ok(JSON.stringify(snap).length < 1200, 'compact');
  const b = new C.BallController(); b.restore(snap);
  for (const t of [0.12, 0.2, 0.33, 0.49]) assert.ok(d3(a.evaluate(t), b.evaluate(t)) < 1e-4, `same ball at ${t}`);
});

test('contact edits: validation keeps good events, rejects bad ones', async () => {
  const K = await BC;
  assert.strictEqual(K.validateEdits({ events: [{ type: 'release', hand: 'right', frame: 9 }, { type: 'bounce', frame: 11.5, local: [0.2, 0.12, 0.4] }] }).ok, true);
  assert.strictEqual(K.validateEdits({ events: [{ type: 'teleport', frame: 3 }] }).ok, false);
  assert.strictEqual(K.validateEdits({ events: [{ type: 'catch', frame: 'soon' }] }).ok, false);
});

test('contacts: a two-hand start enters in the clip\'s own hand (a mirrored clip\'s is the other one, never the literal right)', async () => {
  const K = await BC;
  const both = () => ({ F: 30, fps: 30, loop: false, events: [{ id: 'g1', type: 'gather', hand: 'both', frame: 0 }, { id: 's1', type: 'shot', hand: 'both', frame: 20 }] });
  assert.strictEqual(K.finalize({ ...both(), defaultHand: 'left' }).entryHand, 'left');
  assert.strictEqual(K.finalize(both()).entryHand, 'right', 'no hint: the right hand');
  const oneHand = { F: 30, fps: 30, loop: false, events: [{ id: 'g1', type: 'gather', hand: 'both', frame: 0 }, { id: 's1', type: 'shot', hand: 'right', frame: 20 }], defaultHand: 'left' };
  assert.strictEqual(K.finalize(oneHand).entryHand, 'right', 'the hand that lets go first still wins');
});

// ── detection on the recorded take ──────────────────────────────────────────
test('auto detection: the recorded between-the-legs → cross → shot take (two floor contacts, the right hands)', { skip }, async () => {
  const { courtClips, makeGame } = await H;
  void makeGame;
  const clips = await courtClips();
  const j = clips.find((c) => /btl-cross-shot/.test(c.name));
  assert.ok(j, 'the recorded move is in the library');
  const A = await import('../engine3d/anim3d.mjs');
  const zlib = require('zlib');
  const rig = A.prepareRig(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib/mocap/mhr-rigs/player.json.gz')))));
  const c = A.prepareClip(JSON.parse(JSON.stringify(j)), rig);
  const E = c.ballContacts.events;
  const near = (type, frame, hand) => E.find((e) => e.type === type && Math.abs(e.frame - frame) <= 1.2 && (!hand || e.hand === hand));
  assert.ok(near('release', 9.1, 'right'), 'right hand releases into the between-the-legs');
  assert.ok(near('bounce', 11.5), 'bounce between the legs');
  assert.ok(near('catch', 13.7, 'left'), 'left hand catches it');
  assert.ok(near('release', 23.1, 'left'), 'left hand releases the crossover');
  assert.ok(near('bounce', 24.3), 'crossover bounce');
  assert.ok(near('catch', 25.8, 'right'), 'right hand catches the crossover');
  assert.ok(near('shot', 59.5), 'the shot');
  assert.strictEqual(E.filter((e) => e.type === 'bounce').length, 2, 'exactly two floor contacts');
  assert.strictEqual(c.ballContacts.entryHand, 'right');
  for (const e of E) assert.ok(e.conf > 0 && e.conf <= 1 && e.window[0] <= e.frame && e.window[1] >= e.frame, `${e.type} has a window and a confidence`);
  // the bounce between the legs is placed clear of this character's legs
  const b = near('bounce', 11.5), caps = c.contactInput.legsAt(b.frame), bw = K_fromLocal(b.local, c.contactInput.traj(b.frame));
  for (const cp of caps) assert.ok(segDist(bw, cp.a, cp.b) - cp.r - 0.12 >= 0.01, 'bounce spot clear of the legs');
});
// every dribble touches the floor exactly once — from the motion, for any set of contacts: a saved (Contact Editor) set
// with the floor contacts missing gets them where the motion puts them (the between-the-legs one between the feet), a
// flight with two keeps one, a hand-off that stays up keeps none
test('contacts: every dribble touches the floor exactly once — missing floor contacts are put in where the motion puts them (between the legs: between the feet)', { skip }, async () => {
  const { courtClips } = await H;
  const A = await import('../engine3d/anim3d.mjs'), K = await BC;
  const zlib = require('zlib');
  const rig = A.prepareRig(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib/mocap/mhr-rigs/ac-001.json.gz')))));
  const j = (await courtClips()).find((c) => /btl-cross-shot/.test(c.name));
  const auto = A.prepareClip(JSON.parse(JSON.stringify(j)), rig).ballContacts;
  const keep = auto.events.filter((e) => e.type !== 'bounce').map((e) => ({ id: e.id, type: e.type, hand: e.hand, frame: e.frame, window: e.window }));
  // a saved set with the releases and catches only (the floor contacts never placed)
  const k = JSON.parse(JSON.stringify(j)); k.ballContacts = { version: 1, events: keep, savedAt: 'test' };
  const c = A.prepareClip(k, rig), E = c.ballContacts.events, C = c.contactInput;
  const B = E.filter((e) => e.type === 'bounce');
  assert.strictEqual(B.length, 2, `two floor contacts put back (${K.describe(c.ballContacts).join('; ')})`);
  for (const fl of c.ballContacts.flights) assert.ok(fl.bounce, `every flight bounces (${JSON.stringify(fl)})`);
  // at the moments of the motion: within 1.5 frames of the detected ones
  const ab = auto.events.filter((e) => e.type === 'bounce');
  B.forEach((b, i) => assert.ok(Math.abs(b.frame - ab[i].frame) <= 1.5, `floor contact ${i + 1} @${b.frame.toFixed(1)} (detected @${ab[i].frame.toFixed(1)})`));
  // the between-the-legs one: between the feet (along the line from foot to foot), from that line back to under the hips
  const b = B[0], caps = C.legsAt(b.frame), pw = K_fromLocal(b.local, C.traj(b.frame));
  const foot = (q) => [(q.a[0] + q.b[0]) / 2, (q.a[2] + q.b[2]) / 2], L = foot(caps[2]), Rf = foot(caps[5]), d = [Rf[0] - L[0], Rf[1] - L[1]], w = Math.hypot(...d);
  const hip = [(caps[0].a[0] + caps[3].a[0]) / 2, (caps[0].a[2] + caps[3].a[2]) / 2], side = (q) => ((q[0] - L[0]) * -d[1] + (q[1] - L[1]) * d[0]) / w, sg = Math.sign(side(hip)) || 1;
  const u = ((pw[0] - L[0]) * d[0] + (pw[2] - L[1]) * d[1]) / (w * w), back = sg * side([pw[0], pw[2]]), hips = sg * side(hip);
  assert.ok(u > 0.15 && u < 0.85 && back > -0.05 && back < hips + 0.05, `between the feet (along ${u.toFixed(2)}), ${(back * 100).toFixed(1)} cm behind their line (the hips ${(hips * 100).toFixed(1)} cm)`);
  assert.ok(Math.abs(pw[1] - 0.12) < 1e-3, 'on the floor');
  // a flight with two floor contacts keeps one; a hand-off that stays up keeps none
  const two = JSON.parse(JSON.stringify(j)); two.ballContacts = { version: 1, savedAt: 'test', events: [...keep, ...auto.events.filter((e) => e.type === 'bounce').map((e) => ({ ...e })), { id: 'bx', type: 'bounce', frame: auto.events.find((e) => e.type === 'bounce').frame + 1, local: [0, 0.12, 0.3] }] };
  assert.strictEqual(A.prepareClip(two, rig).ballContacts.events.filter((e) => e.type === 'bounce').length, 2, 'one floor contact per dribble');
  const toss = K.ensureBounces(K.finalize({ F: 20, fps: 30, loop: false, events: [{ id: 'r1', type: 'release', hand: 'right', frame: 5 }, { id: 'c1', type: 'catch', hand: 'left', frame: 12 }] }),
    { F: 20, fps: 30, loop: false, R: 0.12, floorY: 0, traj: () => [0, 0, 0], frames: Array.from({ length: 20 }, () => ({ ball: [0, 1.1, 0.3], palmL: [0.2, 1.0, 0.3], palmR: [-0.2, 1.0, 0.3] })) });
  assert.strictEqual(toss.events.filter((e) => e.type === 'bounce').length, 0, 'a hand-off above the knees stays a toss');
});

// the floor contact (docs → TRAJECTORY MODEL): the between-the-legs bounce of the recorded move lands between the feet,
// under the hips, and the ball is DRAWN on the floor on each bounce's frame at any frame rate — both bounces of the move,
// at the moments of the motion
test('game: the between-the-legs move — both floor contacts at their moments, drawn on the floor (± 1 mm), the first between the feet under the body (AC, 30 / 60 / 120 fps)', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const IK = await import('../engine3d/contact-ik.mjs');
  const clips = (await courtClips()).filter((c) => c.role !== 'shot-stepback' || /btl-cross/.test(c.name));
  for (const fps of [30, 60, 120]) {
    const g = await makeGame({ rig: 'ac-001', fps, clips });
    const B = [];
    const m = g.run([[0, 1, { hand: 'right' }], [1, 1.6, { trig: 'shot-stepback', move: 'toHoop' }], [1.6, 3.2, {}]], {
      onTick: ({ out, P, mats, session }) => {
        if (!out.events.some((e) => e.type === 'bounce') || !/btl-cross/.test(P.action?.clip?.name || '')) return;
        const J = (n) => IK.jointPos(mats, g.mrig, g.mrig.JI[n]), foot = (s) => { const a = J(`${s}_foot`), b = J(`${s}_ball`); return [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2]; };
        const L = foot('l'), Rf = foot('r'), d = [Rf[0] - L[0], Rf[1] - L[1]], w = Math.hypot(...d), p = out.p, hip = [(J('l_upleg')[0] + J('r_upleg')[0]) / 2, (J('l_upleg')[2] + J('r_upleg')[2]) / 2];
        // (along the feet's line 0 … 1, and how far behind it — toward the hips — signed so the hips are behind)
        const side = (q) => ((q[0] - L[0]) * -d[1] + (q[1] - L[1]) * d[0]) / w, sg = Math.sign(side(hip)) || 1;
        B.push({ frame: P.action.t, drawn: p[1] - 0.12, along: ((p[0] - L[0]) * d[0] + (p[2] - L[1]) * d[1]) / (w * w), back: sg * side([p[0], p[2]]), hips: sg * side(hip), plan: session.ctl.flight?.plan || session.ctl.lastFlight?.plan, state: out.state });
      },
    });
    const n = `@${fps}`;
    assert.strictEqual(B.length, 2, `${n}: two floor contacts in the move (${JSON.stringify(B)})`);
    for (const b of B) assert.ok(b.state === 'BOUNCE' && Math.abs(b.drawn) <= 0.001, `${n}: drawn on the floor on its frame (${(b.drawn * 1000).toFixed(1)} mm, ${b.state})`);
    assert.ok(Math.abs(B[0].frame - 11.5) <= 1.5 && Math.abs(B[1].frame - 24.3) <= 1.5, `${n}: at the moments of the motion (clip frames ${B.map((b) => b.frame.toFixed(1))})`);
    // between the legs: between the feet, from their line back to under the hips
    assert.ok(B[0].along > 0.2 && B[0].along < 0.8 && B[0].back > -0.05 && B[0].back < B[0].hips + 0.05, `${n}: between the legs — between the feet (along ${B[0].along.toFixed(2)}), ${(B[0].back * 100).toFixed(1)} cm behind their line (the hips ${(B[0].hips * 100).toFixed(1)} cm)`);
    assert.ok(B[0].plan?.gate, `${n}: planned in the gate between the feet (${JSON.stringify(B[0].plan)})`);
    // (the crossover back is caught hard — 9 m/s into the right hand: 430–560 m/s² on that catch before the floor
    // contacts were planned too; tests/ball-court and the player rig's run hold it to the 400 default)
    assertClean(`btl ${n}`, m, { catchErr: 0.06, pop: 600 });
  }
});

// the user's double crossover (IMG_5866): the capture's hold rule kept the left hand "holding" a ball it had pushed
// down (22 → 28) and the left hand "catching" a rising ball the right hand takes after the clip ends (31, 32) — the
// contacts had to be saved by hand. The automatic ones must give the same timeline (± 1 frame), as filmed and mirrored.
test('auto detection: the double crossover (its saved contacts removed) — the same timeline as the hand-made one, ± 1 frame', { skip }, async () => {
  const { courtClips } = await H;
  const j = (await courtClips()).find((c) => c.role === 'move-double-cross');
  if (!j) { console.log('no double crossover in this library: skipped'); return; }
  const A = await import('../engine3d/anim3d.mjs');
  const zlib = require('zlib');
  const rig = A.prepareRig(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib/mocap/mhr-rigs/ac-001.json.gz')))));
  const manual = [['release', 'right', 5], ['bounce', null, 7], ['catch', 'left', 9], ['release', 'left', 22], ['bounce', null, 29], ['catch', 'right', 32]];
  const saved = j.ballContacts;
  if (saved) assert.deepStrictEqual(saved.events.map((e) => [e.type, e.hand, e.frame]), manual, 'the reference is the saved (hand-made) set');
  const sw = (h) => (h === 'left' ? 'right' : h === 'right' ? 'left' : h);
  for (const mirror of [false, true]) {
    const k = JSON.parse(JSON.stringify(j)); delete k.ballContacts;
    const c = A.prepareClip(k, rig, { mirror }), K = c.ballContacts, n = mirror ? 'mirrored' : 'as filmed';
    const E = K.events.filter((e) => ['release', 'bounce', 'catch'].includes(e.type));
    assert.strictEqual(E.length, manual.length, `${n}: ${JSON.stringify(E.map((e) => [e.type, e.hand, +e.frame.toFixed(1)]))}`);
    manual.forEach(([type, hand, frame], i) => {
      const e = E[i], want = mirror ? sw(hand) : hand;
      assert.ok(e.type === type && (e.hand || null) === want && Math.abs(e.frame - frame) <= 1, `${n}: ${type} ${want || ''} @${frame} — got ${e.type} ${e.hand || ''} @${e.frame.toFixed(1)} (${K.log.join('; ')})`);
    });
    assert.deepStrictEqual([K.entryHand, K.exitHand], mirror ? ['left', 'left'] : ['right', 'right'], `${n}: enters and leaves in the same hand`);
    for (const e of E) if (e.type === 'bounce') assert.ok(Array.isArray(e.local) && e.local.every(Number.isFinite), `${n}: the bounce has a floor spot`);
  }
});
// a dribble move whose last dribble is still in the air when its clip ends must not drop the ball (it used to: a
// release with no catch is let go to the physics — LOOSE): caught on the last frame, or kept in the hand
test('auto detection: no move ends with the ball let go — a last flight is caught on the last frame by the hand it heads to, or kept', { skip }, async () => {
  const { courtClips } = await H;
  const A = await import('../engine3d/anim3d.mjs');
  const zlib = require('zlib');
  const rig = A.prepareRig(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib/mocap/mhr-rigs/ac-001.json.gz')))));
  for (const j0 of await courtClips()) for (const mirror of [false, true]) {
    if (/^shot-/.test(j0.role)) continue;
    const j = JSON.parse(JSON.stringify(j0)); delete j.ballContacts;
    const c = A.prepareClip(j, rig, { mirror }), K = c.ballContacts, n = `${j.name}${mirror ? ' (mirrored)' : ''}`;
    const E = K.events;
    for (const e of E.filter((x) => x.type === 'release' || x.type === 'pass')) {
      if (c.loop) continue;
      assert.ok(e.type === 'release' && E.some((x) => x.type === 'catch' && x.frame > e.frame && x.frame <= c.F - 1 + 1e-6), `${n}: release @${e.frame.toFixed(1)} is caught in the clip (${K.log.join('; ')})`);
    }
    assert.ok(K.entryHand === 'left' || K.entryHand === 'right', `${n}: an entry hand`);
    assert.ok(K.exitHand === 'left' || K.exitHand === 'right' || K.exitHand === 'both', `${n}: an exit hand`);
  }
});
const K_fromLocal = (q, tr) => { const c = Math.cos(tr[2]), s = Math.sin(tr[2]); return [c * q[0] + s * q[2] + tr[0], q[1], -s * q[0] + c * q[2] + tr[1]]; };
function segDist(p, a, b) { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9))); return d3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]); }

// ── game scenarios ──────────────────────────────────────────────────────────
/** The shared checks of every scenario (m: harness metrics). */
function assertClean(name, m, { moving = false, catchErr = moving ? 0.12 : 0.03, pop: popMax = 400 } = {}) {
  assert.strictEqual(m.nan, 0, `${name}: no NaN`);
  assert.strictEqual(m.rejected, 0, `${name}: no invalid state transition`);
  assert.strictEqual(m.floorViolations, 0, `${name}: never through the floor (min y ${m.minY.toFixed(4)})`);
  assert.ok(m.minY >= 0.12 - 0.004, `${name}: ball centre ≥ floor + R`);
  assert.strictEqual(m.looseTicks, 0, `${name}: never lost (LOOSE)`);
  assert.strictEqual(m.recoveryCount, 0, `${name}: no failsafe recovery needed (${JSON.stringify(m.recoveries)})`);
  assert.ok(m.releases >= 2 && m.catches.length >= m.releases - 1, `${name}: dribbles caught (${m.catches.length}/${m.releases})`);
  assert.ok(m.bounces.length >= m.releases - 1, `${name}: each dribble bounces (${m.bounces.length})`);
  assert.ok(m.maxCatchErr < catchErr, `${name}: catch at the expected hand (${(m.maxCatchErr * 100).toFixed(1)} cm)`);
  // no teleport: every step matches the ball's own velocity (and nothing moves at an impossible speed)
  assert.ok((m.maxTeleport || 0) < 0.03, `${name}: no teleport — no step longer than the ball's speed allows (+${((m.maxTeleport || 0) * 100).toFixed(1)} cm at ${JSON.stringify(m.teleportAt)})`);
  // (a pop is the ball's own: above 40 g AND well beyond what the holding hand itself does then)
  const pop = (m.maxAccel || 0) > popMax && (m.maxAccel || 0) > 1.25 * (m.accelAt?.handAccel || 0);
  assert.ok(!pop, `${name}: no pop — the drawn ball never jerks beyond 40 g on its own (${(m.maxAccel || 0).toFixed(0)} m/s² at ${JSON.stringify(m.accelAt)})`);
  assert.ok(m.maxJump < 20, `${name}: no impossible speed (${m.maxJump.toFixed(1)} m/s in one tick at ${JSON.stringify(m.jumpAt)})`);
  assert.ok(m.ownershipMismatch <= m.fps * 0.1, `${name}: the ball is in the hand the animation holds it with (${m.ownershipMismatch} ticks)`);
  const fl = m.leg?.flight;
  if (fl) assert.ok(fl.min >= -0.005, `${name}: controlled flights never enter a leg (${(fl.min * 100).toFixed(1)} cm)`);
  assert.ok(m.maxIkReach <= 0.04 * 1.4 + 0.002, `${name}: IK corrections stay small (${(m.maxIkReach * 100).toFixed(1)} cm)`);
}
const SCEN = {
  'right stationary dribble': { s: [[0, 3.5, { hand: 'right' }]] },
  'left stationary dribble': { s: [[0, 3.5, {}]] },
  'right → left crossover': { s: [[0, 0.8, { hand: 'right' }], [0.8, 4.5, { trig: 'move-crossover' }]] },
  'left → right crossover': { s: [[0, 0.8, {}], [0.8, 4.5, { trig: 'move-crossover' }]] },
  // (runs toward the basket start 12 m out: the court's stanchion stops a player at the hoop, the harness doesn't)
  'forward jog dribble': { s: [[0, 0.8, {}], [0.8, 3.6, { move: 'toHoop' }]], moving: true, start: [0.5, 12] },
  'backward dribble': { s: [[0, 0.8, {}], [0.8, 3.6, { move: 'awayHoop' }]], moving: true },
  'horizontal dribble': { s: [[0, 0.8, {}], [0.8, 3.6, { move: 'sideHoop' }]], moving: true },
  'diagonal dribble': { s: [[0, 0.8, {}], [0.8, 3.6, { move: 'diagHoop' }]], moving: true },
  'sprint dribble': { s: [[0, 0.8, {}], [0.8, 2.8, { move: 'toHoop', sprint: true }]], moving: true, start: [0.5, 12] },
  'combo: crossover then spin': { s: [[0, 0.8, {}], [0.8, 1.6, { trig: 'move-crossover' }], [1.6, 6, { trig: 'move-spin' }]] },
  'interruption: a move requested mid-flight waits for the catch': { s: [[0, 0.45, {}], [0.45, 4, { trig: 'move-crossover' }]] },
};
for (const [name, sc] of Object.entries(SCEN)) {
  test(`game: ${name} (60 fps)`, { skip }, async () => {
    const { makeGame } = await H;
    const g = await makeGame({ rig: 'player', fps: 60, start: sc.start });
    const m = g.run(sc.s);
    assertClean(name, m, { moving: !!sc.moving });
    if (/crossover|combo|interruption/.test(name)) assert.ok(m.actions.length >= 1, `${name}: the move played (${JSON.stringify(m.actions)})`);
    if (/interruption/.test(name)) assert.ok(m.sessionStats.waited > 0 || m.actions[0].t > 0.45, 'the request was buffered to a valid window');
  });
}

test('game: the recorded between-the-legs → cross → shot move — two floor contacts, through the legs, never lost', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  // (the move is the moving shot — □ on the move; alone in that slot so it is the one that plays)
  const clips = (await courtClips()).filter((c) => c.role !== 'shot-stepback' || /btl-cross/.test(c.name));
  const g = await makeGame({ rig: 'player', fps: 60, clips });
  // (the shot really reaches the rim now: it drops through and bounces under it before the pass back)
  const m = g.run([[0, 1, {}], [1, 9.5, { trig: 'shot-stepback' }]]);
  const move = m.actions.find((a) => /btl-cross/.test(a.clip));
  assert.ok(move, 'the move played');
  const inMove = m.bounces.filter((b) => b.t > move.t && b.t < move.t + 1.2);
  assert.strictEqual(inMove.length, 2, `two floor contacts in the move (${JSON.stringify(inMove.map((b) => b.t))})`);
  for (const b of inMove) assert.ok(Math.abs(b.p[1] - 0.12) < 1e-6, 'on the floor, not through it');
  assert.ok(m.leg.flight.min >= -0.005, `through the legs without touching them (${(m.leg.flight.min * 100).toFixed(1)} cm)`);
  assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, 'shot, then passed back');
  assertClean('btl-cross-shot', m, { catchErr: 0.06 });
});

test('game: the jump shot (□ standing, the user’s own video) — released at the top of the jump (its arm), through the net, back to idle when it ends, passed back', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const clips = await courtClips();
  const jumper = clips.find((c) => c.role === 'shot-jumper');
  assert.ok(jumper && /IMG_5816/.test(jumper.name), `the jump shot is the user's video (${jumper?.name})`);
  const rel = jumper.shot.releaseFrame;
  assert.ok(rel >= 26 && rel <= 28, `released where the shooting arm straightens (frame ${rel}), not where the ball left the picture (20)`);
  for (const rig of ['player', 'ac-001']) {
    const fps = 60, g = await makeGame({ rig, fps });
    let endAt = null, startAt = null, releaseAt = null, entry = null;
    const m = g.run([[0, 1, {}], [1, 8.5, { trig: 'shot-jumper' }]], {
      onTick: ({ t, P, out }) => {
        if (P.mode === 'action' && /IMG_5816/.test(P.action?.clip?.name || '') && startAt == null) { startAt = t; entry = P.action.t0; }
        if (startAt != null && endAt == null && P.mode === 'loco') endAt = t;
        if (releaseAt == null && out.state === 'SHOT_RELEASE') releaseAt = t;
      },
    });
    assert.ok(startAt != null, `${rig}: the jump shot played`);
    const clipLen = (jumper.frameCount - 1) / jumper.fps;
    assert.ok(endAt != null && endAt - startAt < clipLen + 0.1, `${rig}: back to idle as the clip ends — no hold on the last frame (${(endAt - startAt).toFixed(2)} s for a ${clipLen.toFixed(2)} s clip)`);
    assert.ok(releaseAt != null && releaseAt > startAt && releaseAt < endAt, `${rig}: released during the shot`);
    // (the first action tick already plays one tick of the clip)
    const want = (rel - entry) / jumper.fps - 1 / fps;
    assert.ok(Math.abs(releaseAt - startAt - want) <= 1.5 / fps, `${rig}: released on its frame (${(releaseAt - startAt).toFixed(3)} s after the start, want ${want.toFixed(3)})`);
    assert.ok(m.shots[0]?.through, `${rig}: through the net (closest ${(m.shots[0]?.minRimDist * 100).toFixed(1)} cm from the rim's centre, apex ${m.shots[0]?.maxY.toFixed(2)} m)`);
    assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, `${rig}: shot, then passed back`);
    assert.strictEqual(m.recoveries.length, 0, `${rig}: no failsafe recovery`);
  }
});

// ── shots: every shot clip lets go of the ball, clean, and it goes in ──────
const SHOT_CLIPS = [['shot-jumper', /IMG_5816/, 'jump shot'], ['shot-stepback', /btl-cross/, 'between-the-legs → cross → shot'], ['shot-stepback', /Step back jumpshot/, 'step-back jumper']];
/** One shot clip alone in its role (the one □ plays), run from a dribble; a moving shot on the move. */
async function shotGame(role, re, rig, fps, o = {}) {
  const { makeGame, courtClips } = await H;
  const all = await courtClips();
  const clip = all.find((c) => c.role === role && re.test(c.name));
  if (!clip) return null;
  const g = await makeGame({ rig, fps, clips: all.filter((c) => c.role !== role || c === clip), ...o });
  // (a make drops through, bounces under the hoop, is passed back: ~5–7 s after the release; the
  // moving shot is entered on the move, then the stick is let go)
  const m = g.run([[0, 1, o.start0 || {}], [1, 1.6, { trig: role, move: role === 'shot-stepback' ? 'toHoop' : undefined }], [1.6, 10, {}]], o.run || {});
  return { g, m, clip };
}
for (const [role, re, label] of SHOT_CLIPS) {
  test(`game: the ${label} leaves the hands on its release frame and goes through the net (player / AC, 30 / 60 fps)`, { skip }, async () => {
    for (const rig of ['player', 'ac-001']) for (const fps of [30, 60]) {
      const G = await shotGame(role, re, rig, fps);
      if (!G) return;   // (that clip is not in this library)
      const { m, g } = G, n = `${label} · ${rig} @${fps}`;
      const sh = m.shots[0];
      assert.ok(sh, `${n}: the shot was released (${JSON.stringify(m.actions)})`);
      const step = g.P.lib[role]?.fps / fps || 30 / fps;
      assert.ok(sh.frame >= sh.releaseFrame - 1e-3 && sh.frame < sh.releaseFrame + step + 1e-3, `${n}: released on the tick its clip reaches frame ${sh.releaseFrame} (at ${sh.frame})`);
      const v0 = Math.hypot(...sh.v0);
      assert.ok(sh.palmDist01 >= 0.25, `${n}: 0.1 s later the ball is clear of both palms (${(sh.palmDist01 * 100).toFixed(0)} cm)`);
      assert.ok(sh.minSpeed01 >= 0.9 * v0 - 9.81 * 0.1, `${n}: the throw keeps its speed (${sh.minSpeed01.toFixed(2)} of ${v0.toFixed(2)} m/s) — nothing in the hands swallows it`);
      assert.strictEqual(sh.bodyTouchTicks, 0, `${n}: never touches the thrower's body on the way out`);
      assert.ok(sh.maxY >= 3.5, `${n}: a real arc (apex ${sh.maxY.toFixed(2)} m)`);
      assert.ok(sh.minRimDist <= 0.12 && sh.through, `${n}: through the net (closest ${(sh.minRimDist * 100).toFixed(1)} cm from the rim's centre)`);
      assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, `${n}: one shot, passed back (${JSON.stringify(m.sessionStats)})`);
      assert.strictEqual(m.recoveries.length, 0, `${n}: no failsafe recovery (${JSON.stringify(m.recoveries)})`);
      assert.strictEqual(m.rejected, 0, `${n}: no invalid transition`);
      assert.strictEqual(m.nan, 0, `${n}: no NaN`);
      assert.ok((m.maxTeleport || 0) < 0.03, `${n}: no teleport (+${((m.maxTeleport || 0) * 100).toFixed(1)} cm at ${JSON.stringify(m.teleportAt)})`);
      // (the set, the hold's fit and the release: no pop of the ball's own — the between-the-legs
      // crossover catch has its own, older 0.5 km/s² kick on AC at 60 fps, outside the shot)
      const pops = m.pops.filter((q) => q.t >= sh.tRelease - 0.6 && q.t <= sh.tRelease + 0.3);
      assert.strictEqual(pops.length, 0, `${n}: no pop around the release (${JSON.stringify(pops)})`);
    }
  });
}

test('game: fingers never go through the ball — a palm and a grip at most (dribbles, moves and every shot, player / AC, 30 / 60 fps)', { skip }, async () => {
  const { makeGame } = await H;
  // measured on what is drawn: the hands' full LOD0 skin (true LBS of the final matrices) against the
  // ball, every tick (the joint capsules were a proxy — the stock player's thumb2 / 3 carry no skin)
  let worst = null;
  const check = (n, m) => {
    assert.ok(Number.isFinite(m.maxHandPen), `${n}: measured`);
    assert.strictEqual(m.handPenTicks3mm, 0, `${n}: no tick with the hand skin > 3 mm inside the ball (worst ${(m.maxHandPen * 1000).toFixed(1)} mm at ${JSON.stringify(m.handPenAt)})`);
    if (!worst || m.maxHandPen > worst.pen) worst = { pen: m.maxHandPen, at: m.handPenAt, n };
  };
  for (const rig of ['player', 'ac-001']) for (const fps of [30, 60]) {
    for (const [name, sc] of Object.entries(SCEN)) {
      const g = await makeGame({ rig, fps, start: sc.start, fingers: true });
      check(`${name} · ${rig} @${fps}`, g.run(sc.s));
    }
    for (const [role, re, label] of SHOT_CLIPS) {
      const G = await shotGame(role, re, rig, fps, { fingers: true });
      if (G) check(`${label} · ${rig} @${fps}`, G.m);
    }
  }
  console.log(`deepest hand skin: ${(worst.pen * 1000).toFixed(1)} mm (${worst.n}, ${JSON.stringify(worst.at)}) — < 0: outside the ball`);
});

// the plan's scenarios for the hand's own skin (the same scripts as the prototype that measured it)
const SKIN_SCEN = {
  'right stationary dribble': { s: [[0, 3, { hand: 'right' }]] },
  'left stationary dribble': { s: [[0, 3, {}]] },
  crossover: { s: [[0, 0.8, { hand: 'right' }], [0.8, 4, { trig: 'move-crossover' }]] },
  spin: { s: [[0, 0.8, {}], [0.8, 5, { trig: 'move-spin' }]] },
  jog: { s: [[0, 0.8, {}], [0.8, 3.6, { move: 'toHoop' }]], start: [0.5, 12] },
  'jump shot': { s: [[0, 1, {}], [1, 4, { trig: 'shot-jumper' }]] },
  'btl-cross-shot': { s: [[0, 1, {}], [1, 5.5, { trig: 'shot-stepback' }]], clips: (c) => c.role !== 'shot-stepback' || /btl-cross/.test(c.name) },
};
test('game: hands never inside the ball (skin) — the palm rests on it, the holding hand grips it, no finger pops (AC 60 / 30, player 60)', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const all = await courtClips();
  const rows = [];
  for (const [rig, fps] of [['ac-001', 60], ['player', 60], ['ac-001', 30]]) {
    for (const [name, sc] of Object.entries(SKIN_SCEN)) {
      const g = await makeGame({ rig, fps, start: sc.start, clips: sc.clips ? all.filter(sc.clips) : undefined });
      assert.ok(g.session.hc, `${rig}: the session has the hand skin`);
      const m = g.run(sc.s), n = `${name} · ${rig} @${fps}`, mm = (x) => (x * 1000).toFixed(1);
      rows.push(`${n}: skin ${mm(m.maxHandPen)} mm · palm gap ${mm(m.palmGapHeldMed)} mm · pads ${m.gripTipsHeldMed}/4 · pop ${mm(m.maxFingerPopAdd)} mm · ${m.handMsPerTick.toFixed(2)} ms`);
      // P1: never inside (the prototype: ≥ 1 mm outside everywhere)
      assert.strictEqual(m.handPenTicks3mm, 0, `${n}: no tick > 3 mm inside (${mm(m.maxHandPen)} mm at ${JSON.stringify(m.handPenAt)})`);
      assert.ok(m.maxHandPen <= 0.003, `${n}: the hand skin ≤ 3 mm into the ball (${mm(m.maxHandPen)} mm)`);
      // P2 / P3: in a hold the palm rests on the ball and the fingertips are on it
      assert.ok(m.palmGapHeldMed <= 0.008, `${n}: the holding palm rests on the ball (median gap ${mm(m.palmGapHeldMed)} mm)`);
      assert.ok(m.gripTipsHeldMed >= 3, `${n}: the holding hand grips it (median ${m.gripTipsHeldMed} of 4 fingertip pads on the surface)`);
      // P4: what the pass adds to a fingertip's per-tick motion (relative to the wrist) — not a pop
      if (fps === 60 && /dribble|jog|jump shot/.test(name)) assert.ok(m.maxFingerPopAdd <= 0.045, `${n}: no finger pop (${mm(m.maxFingerPopAdd)} mm at ${JSON.stringify(m.fingerPopAt)})`);
      // P6: cheap (≈ 0.5 ms for both hands; the bound is loose for a busy test machine)
      assert.ok(m.handMsPerTick < 3, `${n}: ${m.handMsPerTick.toFixed(2)} ms per tick for both hands`);
      if (/dribble|crossover/.test(name)) assertClean(n, m);
      if (name === 'jump shot' || name === 'btl-cross-shot') assert.ok(m.shots[0]?.through, `${n}: the shot still leaves the hands and goes in (apex ${m.shots[0]?.maxY.toFixed(2)} m)`);
    }
  }
  console.log(rows.join('\n'));
});

// ── flare: the fingers of the hand that has the ball wrap it — never flare off it. (The user's screenshot:
// the live court at 0.25× speed, AC's idle dribble, the index / pinky / thumb flaring up off the ball while
// the hand holds it.) Measured on the drawn skin: every tick a hand owns the ball (held / catching) with its
// palm on it (≤ 1 cm), each fingertip pad's gap off the surface; and tick to tick, how fast the hand pass
// turns a finger joint beyond the animation's own motion (a glitch), and the animation's own (a clip spike).
test('game: fingers never flare off the ball while the hand has it — the idle dribble at 0.25× speed, moves and shots (AC / player)', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const IK = await import('../engine3d/contact-ik.mjs');
  const all = await courtClips(), CR = IK.HAND.curlRate, mm = (x) => (x * 1000).toFixed(1);
  const idleR = [[0, 3, { hand: 'right' }]], idleL = [[0, 3, {}]];
  const btl = (c) => c.role !== 'shot-stepback' || /btl-cross/.test(c.name);
  // (idle: the user's case — every tick; a 0.25× court runs 240 Hz game ticks. Moves / shots: a fast catch
  // or a shot's launch pocket may lift a fingertip for a tick or two; the rest of the hold is on the ball)
  const idleAC = { tipMax: 0.006, thumbMax: 0.006, rate: CR * 1.1, clipRate: 6 };
  const idlePlayer = { tipMax: 0.015, rate: CR * 2, clipRate: 6 };
  const moving = { p90: 0.006, frac: 0.05 };
  const CASES = [
    ['idle dribble (right) · AC @ 0.25× speed', 'ac-001', 240, idleR, null, idleAC],
    ['idle dribble (left) · AC @ 0.25× speed', 'ac-001', 240, idleL, null, idleAC],
    ['idle dribble (right) · AC @60', 'ac-001', 60, idleR, null, idleAC],
    ['idle dribble (left) · AC @60', 'ac-001', 60, idleL, null, idleAC],
    ['idle dribble · AC @30', 'ac-001', 30, idleR, null, idleAC],
    ['idle dribble · player @60', 'player', 60, idleR, null, idlePlayer],
    ['idle dribble · player @ 0.25× speed', 'player', 240, idleR, null, idlePlayer],
    ['jog · AC @60', 'ac-001', 60, [[0, 0.8, {}], [0.8, 3.6, { move: 'toHoop' }]], { start: [0.5, 12] }, moving],
    ['crossover · AC @60', 'ac-001', 60, SKIN_SCEN.crossover.s, null, moving],
    ['crossover · player @60', 'player', 60, SKIN_SCEN.crossover.s, null, moving],
    ['spin · AC @60', 'ac-001', 60, SKIN_SCEN.spin.s, null, moving],
    ['jump shot · AC @60', 'ac-001', 60, SKIN_SCEN['jump shot'].s, null, moving],
    ['jump shot · AC @30', 'ac-001', 30, SKIN_SCEN['jump shot'].s, null, moving],
    ['between-the-legs → cross → shot · AC @60', 'ac-001', 60, SKIN_SCEN['btl-cross-shot'].s, { clips: all.filter(btl) }, moving],
  ];
  const rows = [];
  for (const [n, rig, fps, script, o, b] of CASES) {
    const g = await makeGame({ rig, fps, ...(o || {}) });
    const m = g.run(script);
    rows.push(`${n}: fingertips ${mm(m.flareTipMax)} mm max · ${mm(m.flareTipP90)} p90 · thumb ${mm(m.thumbTipMax)} · ${m.flareTicks15mm}/${m.contactTicks} ticks > 15 mm · joints ${m.maxJointRateAdd.toFixed(0)} rad/s added, clip ${(m.maxBaseJointJump * fps).toFixed(1)} rad/s`);
    assert.ok(m.contactTicks > 10, `${n}: the hand had the ball (${m.contactTicks} ticks)`);
    const at = (x) => JSON.stringify(x);
    if (b.tipMax != null) assert.ok(m.flareTipMax <= b.tipMax, `${n}: no fingertip flares off the ball in contact (${mm(m.flareTipMax)} mm at ${at(m.flareAt)}; ≤ ${mm(b.tipMax)})`);
    if (b.thumbMax != null) assert.ok(m.thumbTipMax <= b.thumbMax, `${n}: the thumb stays on the ball (${mm(m.thumbTipMax)} mm at ${at(m.thumbAt)})`);
    if (b.rate != null) assert.ok(m.maxJointRateAdd <= b.rate, `${n}: the pass never jerks a finger joint (${m.maxJointRateAdd.toFixed(1)} rad/s at ${at(m.jointJumpAt)}; ≤ ${b.rate.toFixed(0)})`);
    if (b.clipRate != null) assert.ok(m.maxBaseJointJump * fps <= b.clipRate, `${n}: the clip's own finger joints have no spike in contact (${(m.maxBaseJointJump * fps).toFixed(1)} rad/s at ${at(m.baseJointJumpAt)})`);
    if (b.p90 != null) assert.ok(m.flareTipP90 <= b.p90, `${n}: the fingertips are on the ball through the hold (p90 ${mm(m.flareTipP90)} mm)`);
    if (b.frac != null) assert.ok(m.flareTicks15mm <= b.frac * m.contactTicks, `${n}: a fingertip lifts > 15 mm only for a moment (${m.flareTicks15mm} of ${m.contactTicks} ticks, worst ${mm(m.flareTipMax)} mm at ${at(m.flareAt)})`);
    assert.strictEqual(m.handPenTicks3mm, 0, `${n}: and never into the ball (${mm(m.maxHandPen)} mm)`);
  }
  console.log(rows.join('\n'));
});

test('game: the shot meter hook — the grade picks the outcome (a short one hits the front of the rim, a make goes in), seeded = the same shot', { skip }, async () => {
  const role = 'shot-jumper', re = /IMG_5816/;
  const make = await shotGame(role, re, 'ac-001', 60, { run: {} });
  if (!make) return;
  assert.ok(make.m.shots[0].through, 'no input: a make');
  const short = await shotGame(role, re, 'ac-001', 60, { run: { onTick: ({ t, session }) => { if (t < 0.02) session.setShotInput({ outcome: 'short' }); } } });
  const s = short.m.shots[0];
  assert.strictEqual(s.plan.outcome, 'short');
  assert.ok(!s.through, `a short shot does not go in (closest ${(s.minRimDist * 100).toFixed(1)} cm)`);
  // closest to the rim on the shooter's side (the front of the rim)
  const toShooter = [s.from[0], 0, s.from[2]], off = [s.closestAt[0], 0, s.closestAt[2]];
  assert.ok(off[0] * toShooter[0] + off[2] * toShooter[2] > 0, `short: at the front of the rim (${JSON.stringify(s.closestAt.map((x) => +x.toFixed(2)))})`);
  // a graded shot (a "rim" grade rolls in or out): the same seed, the same shot
  const graded = async () => (await shotGame(role, re, 'ac-001', 60, { seed: 99, run: { onTick: ({ t, session }) => { if (t < 0.02) session.setShotInput({ quality: 0.7, timing: 'late' }); } } })).m.shots[0];
  const a = await graded(), b = await graded();
  assert.deepStrictEqual({ o: a.plan.outcome, v0: a.v0, rim: a.minRimDist, thr: a.through }, { o: b.plan.outcome, v0: b.v0, rim: b.minRimDist, thr: b.through }, 'deterministic');
});

// ── the shot meter (engine3d/shot-meter.mjs): hold □, let go on the release frame ──────────────
/** The shot button held from 1 s until the meter's clock (the shot clip's time, as drawn) reaches its release frame + k (frames); k null: never let go. */
const letGoAt = (k) => { let up = false; return ({ meter }) => !(up ||= (k != null && !!meter.shot && meter.clipT >= meter.shot.rel + k)); };
/** One shot clip alone in its role, shot with the button (a moving shot entered on the move; hand: the ball in that hand first). */
async function meterGame(role, re, rig, fps, shoot, { hand = null } = {}) {
  const { makeGame, courtClips } = await H;
  const all = await courtClips();
  const clip = all.find((c) => c.role === role && re.test(c.name));
  if (!clip) return null;
  const g = await makeGame({ rig, fps, clips: all.filter((c) => c.role !== role || c === clip), shotMeter: {} });
  const m = g.run([[0, 1, hand ? { hand } : {}], [1, 1.6, { shoot, shotRole: role, move: role === 'shot-stepback' ? 'toHoop' : undefined }], [1.6, 10, { shoot, shotRole: role }]]);
  return { g, m, clip };
}
/**
 * What the ball did on the court's physics (the harness's shot record): swish (in, touching nothing) / front-rim /
 * back-rim (the rim first, on the shooter's side of its centre or past it) / off-glass (the glass first) / short /
 * long (touched nothing: where it came down through the rim's height).
 */
const flightCat = (s) => (!s.first ? (s.through ? 'swish' : s.down == null || s.down < 0 ? 'short' : 'long') : s.first.name === 'board' ? 'off-glass' : s.first.along < 0 ? 'front-rim' : 'back-rim');
/** The grade's flight is what the ball did: a swish goes in touching nothing, every other band stays out; the result shown. */
function assertMeterShot(n, G, want = null) {
  const { m, g } = G, h = m.meter[0], L = g.session.lastShot, s = m.shots[0];
  assert.ok(h, `${n}: graded (${JSON.stringify(m.meter)})`);
  if (want) assert.strictEqual(h.label, want, `${n}: ${want} (e ${h.e} s)`);
  assert.strictEqual(m.meter.length, 1, `${n}: one shot`);
  assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, `${n}: one shot, passed back (${JSON.stringify(m.sessionStats)})`);
  assert.ok(s.frame >= s.releaseFrame - 1e-3 && s.frame < s.releaseFrame + 1, `${n}: the ball left on the clip's release frame (${s.frame} / ${s.releaseFrame})`);
  const cat = flightCat(s);
  assert.strictEqual(cat, h.flight, `${n}: ${h.label} → ${h.flight}: the ball did that (${cat}: first ${JSON.stringify(s.first)}, down ${s.down}, through ${s.through}, touched ${JSON.stringify(s.touched)})`);
  assert.strictEqual(m.makes, h.flight === 'swish' ? 1 : 0, `${n}: ${h.flight === 'swish' ? 'in' : 'out'} (made ${m.makes})`);
  assert.strictEqual(h.result, h.flight === 'swish' ? 'SWISH' : h.flight === 'short' ? 'AIR BALL' : 'MISS', `${n}: the result shown (${h.result})`);
  const ev = m.shotEvents.find((e) => e.type === (h.make ? 'make' : 'shotEnd'));
  assert.ok(ev && ev.made === h.make, `${n}: the ${h.make ? 'make' : 'shotEnd'} event (${JSON.stringify(m.shotEvents.map((e) => e.type))})`);
  assert.strictEqual(m.recoveries.length, 0, `${n}: no failsafe recovery`);
  assert.strictEqual(m.rejected, 0, `${n}: no invalid transition`);
  assert.strictEqual(m.nan, 0, `${n}: no NaN`);
  return { h, L, s, cat };
}

test('game: the shot meter — let go on the release frame: EXCELLENT, a swish, in each clip\'s own window (jump shot AC / player, 60 / 30 fps, mirrored; the 15 fps step-back; the between-the-legs combo)', { skip }, async () => {
  const CASES = [['shot-jumper', /IMG_5816/, 'ac-001', 60], ['shot-jumper', /IMG_5816/, 'ac-001', 30], ['shot-jumper', /IMG_5816/, 'player', 60], ['shot-jumper', /IMG_5816/, 'player', 60, 'left'], ['shot-stepback', /Step back jumpshot/, 'ac-001', 60], ['shot-stepback', /btl-cross/, 'ac-001', 60]];
  for (const [role, re, rig, fps, hand] of CASES) {
    const G = await meterGame(role, re, rig, fps, letGoAt(-0.6), { hand });
    if (!G) continue;
    const n = `${G.clip.name} · ${rig} @${fps}${hand ? ` (${hand} hand)` : ''}`;
    const { h, L } = assertMeterShot(n, G, 'EXCELLENT');
    assert.ok(Math.abs(h.e) <= 0.08, `${n}: within the green window (${(h.e * 1000).toFixed(0)} ms)`);
    assert.strictEqual(G.m.makes, 1, `${n}: in`);
    const sh = G.m.shotEvents.find((e) => e.type === 'shot'), mk = G.m.shotEvents.find((e) => e.type === 'make');
    assert.ok(mk.at - sh.at <= L.T + 0.3, `${n}: in on its planned flight (${(mk.at - sh.at).toFixed(2)} s, planned ${L.T.toFixed(2)})`);
    if (hand === 'left') assert.ok(G.m.actions.some((a) => /IMG_5816/.test(a.clip) && a.mirror), `${n}: the mirrored jump shot played`);
  }
});

test('game: the shot meter — a release in every band, every shot clip: the label, and the ball does what the timing says (front rim / short / back rim / off the glass), the same clip every time', { skip }, async () => {
  // (frames off the release frame: the jump shot and the combo 30 fps, the step-back 15 fps; null: never let go)
  const BANDS30 = [[-3.5, 'SLIGHTLY EARLY'], [-6, 'EARLY'], [-12, 'VERY EARLY'], [3.5, 'SLIGHTLY LATE'], [6, 'LATE'], [null, 'VERY LATE']];
  const BANDS15 = [[-2, 'SLIGHTLY EARLY'], [-3, 'EARLY'], [-6, 'VERY EARLY'], [2, 'SLIGHTLY LATE'], [3, 'LATE'], [null, 'VERY LATE']];
  const CLIPS = [['shot-jumper', /IMG_5816/, BANDS30], ['shot-stepback', /Step back jumpshot/, BANDS15], ['shot-stepback', /btl-cross/, BANDS30]];
  const rows = [];
  for (const [role, re, bands] of CLIPS) {
    for (const [k, want] of [...bands, ['tap', 'VERY EARLY']]) {
      const shoot = k === 'tap' ? ({ t }) => t < 1.02 : letGoAt(k);
      const G = await meterGame(role, re, 'ac-001', 60, shoot);
      if (!G) break;
      const n = `${G.clip.name}: ${k === 'tap' ? 'a tap' : k == null ? 'never let go' : `${k} frames`}`;
      const { h, L, cat } = assertMeterShot(n, G, want);
      // the animation is the clip itself, every time: the shot clip played to the launch
      assert.ok(G.m.actions.some((a) => a.clip === G.clip.name), `${n}: the shot clip played`);
      // a release after the launch (late / held): the ball left on the clean swish, bent to the late flight in the air
      if (k == null || k > 0) {
        assert.ok(L.provisional, `${n}: the button was still held at the launch`);
        assert.ok(L.reaimed && L.reaimed.dv <= 3, `${n}: bent to ${L.reaimed?.outcome} in the air (${JSON.stringify(L.reaimed)})`);
      } else assert.ok(!L.provisional && L.meter?.label === want, `${n}: graded before the launch (${JSON.stringify(L.meter)})`);
      rows.push(`${n} → ${h.label} (${(h.e * 1000).toFixed(0)} ms) → ${cat} · ${h.result}${L.reaimed ? ` · bent ${L.reaimed.dv} m/s` : ''}`);
    }
  }
  console.log(rows.join('\n'));
});

test('game: the shot meter — deterministic: the same release, the same shot', { skip }, async () => {
  const run = async () => { const G = await meterGame('shot-jumper', /IMG_5816/, 'ac-001', 60, letGoAt(-4)); return { h: G.m.meter, v0: G.m.shots[0].v0, rim: G.m.shots[0].minRimDist, makes: G.m.makes }; };
  const a = await run(), b = await run();
  assert.deepStrictEqual(a, b);
});

test('game: the mirrored jump shot starts in the left hand — □ with the ball in the left hand fires at once (no crossover first)', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const g = await makeGame({ rig: 'player', fps: 60 });
  const variants = g.lib['shot-jumper:variants'] || [g.lib['shot-jumper']];
  const j = variants.find((c) => /IMG_5816/.test(c.name));
  assert.strictEqual(j.ballContacts.entryHand, 'right');
  assert.strictEqual(j.mirrored?.ballContacts.entryHand, 'left', 'the mirror enters with the left hand');
  void courtClips;
  const m = g.run([[0, 1, {}], [1, 3, { trig: 'shot-jumper' }]]);
  assert.ok(!m.log.some((l) => /crossover first/.test(l)), 'no crossover before the shot');
  assert.ok(m.actions.some((a) => /IMG_5816/.test(a.clip) && a.mirror), `the mirrored jump shot played (${JSON.stringify(m.actions)})`);
});

// ── the pro stick (engine3d/pro-stick.mjs): every ball-handling move on the right stick ───────────
// (the harness runs court3d.html's stick path: the recognizer, the chase camera behind him at the hoop, the
// gates, the role, the buffer — a newer stick request replacing its queued one)
const polarStick = (a, r = 1) => [Math.sin(a * Math.PI / 180) * r, -Math.cos(a * Math.PI / 180) * r];
const PRO_SCEN = {
  'flick toward the free hand = crossover (R→L)': { s: [[0, 0.8, { hand: 'right' }], [0.8, 0.9, { stick: [-1, 0] }], [0.9, 4.5, {}]], gesture: 'crossover', kind: 'flick', role: 'move-crossover', finalHand: 'left' },
  'flick toward the free hand = crossover (L→R)': { s: [[0, 0.8, {}], [0.8, 0.9, { stick: [1, 0] }], [0.9, 4.5, {}]], gesture: 'crossover', kind: 'flick', role: 'move-crossover', finalHand: 'right' },
  // (the spin clip has its own ~0.5 km/s² kick on a dribble ~0.85 s in — the same when △ / K plays it: the
  // stick's spin is held to the button's)
  'quarter circle = spin': { s: [[0, 0.8, {}], [0.8, 1.0, { stick: (u) => polarStick(180 - 90 * u) }], [1.0, 5, {}]], gesture: 'spin', kind: 'spin', role: 'move-spin', sameAs: [[0, 0.97, {}], [0.97, 5, { trig: 'move-spin' }]] },
  'back-diagonal, free side = between the legs → the crossover': { s: [[0, 0.8, { hand: 'right' }], [0.8, 0.9, { stick: [-Math.SQRT1_2, Math.SQRT1_2] }], [0.9, 4.5, {}]], gesture: 'btl', kind: 'flick', role: 'move-crossover', fellBack: true, finalHand: 'left' },
  'held toward the free hand = one move': { s: [[0, 0.8, { hand: 'right' }], [0.8, 2.0, { stick: [-1, 0] }], [2.0, 4.5, {}]], gesture: 'crossover', kind: 'hold', role: 'move-crossover', finalHand: 'left' },
};
for (const [name, sc] of Object.entries(PRO_SCEN)) {
  test(`game: pro stick — ${name} (60 fps)`, { skip }, async () => {
    const { makeGame } = await H;
    const m = (await makeGame({ rig: 'player', fps: 60 })).run(sc.s);
    assert.strictEqual(m.stick.length, 1, `${name}: one gesture (${JSON.stringify(m.stick)})`);
    const g = m.stick[0];
    assert.deepStrictEqual([g.kind, g.gesture, g.role, !!g.fellBack], [sc.kind, sc.gesture, sc.role, !!sc.fellBack], `${name}: ${JSON.stringify(g)}`);
    assert.strictEqual(m.actions.length, 1, `${name}: exactly one move (${JSON.stringify(m.actions)})`);
    assert.strictEqual(m.actions[0].role, sc.role);
    assert.ok(m.actions[0].t - g.t <= 0.25, `${name}: it starts at once (${m.actions[0].t} after the gesture at ${g.t})`);
    if (sc.finalHand) assert.strictEqual(m.finalHand, sc.finalHand, `${name}: the ball ends in the other hand`);
    assert.ok(m.stickBufferMax <= 1, `${name}: never more than one stick request queued`);
    let pop;
    if (sc.sameAs) { const b = (await makeGame({ rig: 'player', fps: 60 })).run(sc.sameAs); pop = Math.max(400, (b.maxAccel || 0) * 1.02); }
    assertClean(name, m, { pop });
  });
}
test('game: pro stick — the crossover flick at 30 fps, and on AC (60 fps)', { skip }, async () => {
  const { makeGame } = await H;
  const sc = PRO_SCEN['flick toward the free hand = crossover (R→L)'];
  for (const [rig, fps] of [['player', 30], ['ac-001', 60]]) {
    const m = (await makeGame({ rig, fps })).run(sc.s), n = `${rig} @${fps}`;
    assert.deepStrictEqual(m.stick.map((g) => [g.kind, g.gesture, g.role]), [['flick', 'crossover', 'move-crossover']], `${n}: ${JSON.stringify(m.stick)}`);
    assert.deepStrictEqual(m.actions.map((a) => a.role), ['move-crossover'], n);
    assert.strictEqual(m.finalHand, 'left', `${n}: into the left hand`);
    assertClean(n, m);
  }
});
test('game: pro stick — flick left, then right = the double crossover (the user\'s clip IMG_5866): right → left → right, clean (player / AC, 60 / 30 fps)', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const all = await courtClips();
  if (!all.some((c) => c.role === 'move-double-cross')) return;   // (not in this library)
  for (const [rig, fps] of [['player', 60], ['ac-001', 60], ['ac-001', 30]]) {
    // the ball in the right hand, the chase camera: a flick left, then right ~0.15 s later
    const m = (await makeGame({ rig, fps })).run([[0, 0.8, { hand: 'right' }], [0.8, 0.88, { stick: [-1, 0] }], [0.88, 0.95, {}], [0.95, 1.03, { stick: [1, 0] }], [1.03, 4.5, {}]]), n = `${rig} @${fps}`;
    assert.deepStrictEqual(m.stick.map((g) => [g.kind, g.gesture, g.role]), [['flick', 'crossover', 'move-crossover'], ['flick', 'doublecross', 'move-double-cross']], `${n}: ${JSON.stringify(m.stick)}`);
    const dc = m.actions.find((a) => a.role === 'move-double-cross');
    assert.ok(dc && /double-cross/.test(dc.clip) && !dc.mirror, `${n}: the double crossover played, from the right hand (${JSON.stringify(m.actions)})`);
    assert.ok(dc.t - m.stick[1].t <= 0.25, `${n}: at once (${dc.t} after the flick at ${m.stick[1].t})`);
    assert.strictEqual(m.actions.filter((a) => a.role === 'move-crossover' && a.t > dc.t).length, 0, `${n}: no crossover after it`);
    // its contacts: right lets go → the left hand → back to the right
    const after = m.catches.filter((c) => c.t > dc.t);
    assert.deepStrictEqual(after.slice(0, 2).map((c) => c.hand), ['left', 'right'], `${n}: caught left, then right (${JSON.stringify(after)})`);
    assert.strictEqual(m.finalHand, 'right', `${n}: ends in the right hand`);
    assertClean(n, m, { catchErr: 0.06 });
  }
});
// the double crossover is recognised against the hand the ball is in when the flick back is read: a request that has to
// wait (the crossover can't be interrupted) and fires after the LEFT hand caught the ball is a crossover back — it used
// to play the mirrored double crossover there (right → left, then left → right → left)
test('game: pro stick — a double crossover that waits past the crossover\'s release is a crossover back from the other hand, never the mirrored double crossover', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  if (!(await courtClips()).some((c) => c.role === 'move-double-cross')) return;   // (not in this library)
  // the flick back 0.2 s after the first one: the crossover is already past its interruption window
  const m = (await makeGame({ rig: 'player', fps: 60 })).run([[0, 0.8, { hand: 'right' }], [0.8, 0.88, { stick: [-1, 0] }], [0.88, 1.0, {}], [1.0, 1.08, { stick: [1, 0] }], [1.08, 4.5, {}]]);
  assert.deepStrictEqual(m.stick.map((g) => [g.gesture, g.role, g.hand]), [['crossover', 'move-crossover', 'right'], ['doublecross', 'move-double-cross', 'right']], `recognised with the ball in the right hand: ${JSON.stringify(m.stick)}`);
  assert.ok(!m.actions.some((a) => a.role === 'move-double-cross'), `no double crossover plays from the left hand (${JSON.stringify(m.actions)})`);
  assert.deepStrictEqual(m.actions.map((a) => [a.role, a.mirror]), [['move-crossover', false], ['move-crossover', true]], `the crossover, then the crossover back (${JSON.stringify(m.actions)})`);
  assert.ok(m.log.some((l) => /fires from the left hand: a crossover back/.test(l)), 'the downgrade is logged');
  assert.strictEqual(m.finalHand, 'right', 'back in the right hand');
  assertClean('double crossover → crossover back', m, { catchErr: 0.06 });
});
test('game: pro stick — forward is the hesitation: no clip yet, nothing plays, the dribble goes on', { skip }, async () => {
  const { makeGame } = await H;
  const m = (await makeGame({ rig: 'player', fps: 60 })).run([[0, 0.8, {}], [0.8, 0.9, { stick: [0, -1] }], [0.9, 3.5, {}]]);
  assert.strictEqual(m.stick.length, 1);
  assert.deepStrictEqual([m.stick[0].gesture, m.stick[0].missing, m.stick[0].role], ['hesi', true, null]);
  assert.strictEqual(m.actions.length, 0, 'no move');
  assert.ok(m.releases >= 4, `the dribble goes on (${m.releases} releases)`);
  assertClean('hesitation (no clip)', m);
});
test('game: pro stick — gestures during a move wait one at a time (the newest replaces the queued one)', { skip }, async () => {
  const { makeGame } = await H;
  // a crossover flick, a half circle while it plays, then a flick back before the spin could start (right after the half
  // circle: the crossover's catch — the spin's first valid window — may come as early as ~0.5 s after its release)
  const m = (await makeGame({ rig: 'player', fps: 60 })).run([[0, 0.8, { hand: 'right' }], [0.8, 0.9, { stick: [-1, 0] }], [0.9, 1.1, {}], [1.1, 1.3, { stick: (u) => polarStick(180 + 180 * u) }], [1.3, 1.33, {}], [1.33, 1.43, { stick: [1, 0] }], [1.43, 6, {}]]);
  assert.deepStrictEqual(m.stick.map((g) => g.kind), ['flick', 'spin', 'flick'], JSON.stringify(m.stick));
  assert.ok(m.stickBufferMax <= 1, `one stick request queued at most (${m.stickBufferMax})`);
  assert.ok(m.actions.length >= 2, `the first move and the newest (${JSON.stringify(m.actions)})`);
  assert.deepStrictEqual(m.actions.map((a) => a.role), ['move-crossover', 'move-crossover'], 'the flick back replaced the queued spin');
  assert.ok(m.log.some((l) => /newer stick request replaces/.test(l)), 'the replacement is logged');
  assert.strictEqual(m.finalHand, 'right', 'crossed over and back');
  assertClean('gestures during a move', m);
});
test('game: pro stick — during a shot the stick does nothing (never buffered past the pass back)', { skip }, async () => {
  const { makeGame } = await H;
  // a flick in the wind-up (a shot playing), one in the flight and one after (no ball)
  let shotFrom = null, passCatch = null;
  const m = (await makeGame({ rig: 'player', fps: 60 })).run([[0, 1, {}], [1, 1.3, { trig: 'shot-jumper' }], [1.3, 1.4, { stick: [1, 0] }], [1.4, 1.9, {}], [1.9, 2.0, { stick: [1, 0] }], [2.0, 2.3, {}], [2.3, 2.4, { stick: [-1, 0] }], [2.4, 10, {}]], {
    onTick: ({ t, P, out }) => { if (shotFrom == null && P.mode === 'action' && P.action?.clip?.shot) shotFrom = t; if (shotFrom != null && passCatch == null && t > 3 && /^HELD_/.test(out.state)) passCatch = t; },
  });
  assert.ok(shotFrom != null && m.sessionStats.shots === 1 && m.sessionStats.passes === 1, `the shot, then the pass back (${JSON.stringify(m.sessionStats)})`);
  assert.strictEqual(m.stick.length, 3, JSON.stringify(m.stick));
  assert.deepStrictEqual(m.stick.map((g) => g.ignored), ['shot', 'no ball', 'no ball'], 'every gesture ignored: the shot playing, then no ball');
  assert.ok(passCatch != null, 'the pass back was caught');
  assert.ok(!m.actions.some((a) => /^move-/.test(a.role)), `no move starts after the catch (${JSON.stringify(m.actions)})`);
  assert.strictEqual(m.stickBufferMax, 0, 'nothing buffered');
  assert.strictEqual(m.recoveryCount, 0); assert.strictEqual(m.rejected, 0); assert.strictEqual(m.nan, 0);
});

for (const fps of [30, 120]) {
  test(`game: frame-rate independence — the same dribble and move at ${fps} fps as at 60`, { skip }, async () => {
    const { makeGame } = await H;
    const script = [[0, 0.8, {}], [0.8, 4, { trig: 'move-crossover' }]];
    const a = (await makeGame({ rig: 'player', fps: 60 })).run(script);
    const b = (await makeGame({ rig: 'player', fps })).run(script);
    assertClean(`crossover @${fps}`, b);
    assert.strictEqual(b.bounces.length, a.bounces.length, `same number of bounces (${b.bounces.length} vs ${a.bounces.length})`);
    // input is read per tick, so the move starts on a tick boundary: bounces are compared from the
    // idle's clock before the move, and from the move's own start inside it
    const mA = a.actions[0].t, mB = b.actions[0].t;
    assert.ok(Math.abs(mA - mB) <= 2 / Math.min(fps, 60) + 1e-6, `the move starts within two input ticks (${mA} vs ${mB})`);
    for (let i = 0; i < a.bounces.length; i++) {
      const ra = a.bounces[i].t - (a.bounces[i].t > mA ? mA : 0), rb = b.bounces[i].t - (b.bounces[i].t > mB ? mB : 0);
      assert.ok(Math.abs(ra - rb) <= 0.02, `bounce ${i} at the same time (${ra.toFixed(3)} vs ${rb.toFixed(3)} s)`);
    }
  });
}

for (const rig of ['guard', 'big', 'ac-001']) {
  test(`game: character variation — ${rig} (height / arm length) dribbles and crosses over cleanly`, { skip }, async () => {
    const { makeGame } = await H;
    const g = await makeGame({ rig, fps: 60 });
    const m = g.run([[0, 0.8, {}], [0.8, 4.2, { trig: 'move-crossover' }]]);
    assertClean(rig, m);
  });
}
