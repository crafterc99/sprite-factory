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
const K_fromLocal = (q, tr) => { const c = Math.cos(tr[2]), s = Math.sin(tr[2]); return [c * q[0] + s * q[2] + tr[0], q[1], -s * q[0] + c * q[2] + tr[1]]; };
function segDist(p, a, b) { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ((ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) || 1e-9))); return d3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]); }

// ── game scenarios ──────────────────────────────────────────────────────────
/** The shared checks of every scenario (m: harness metrics). */
function assertClean(name, m, { moving = false, catchErr = moving ? 0.12 : 0.03 } = {}) {
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
  const pop = (m.maxAccel || 0) > 400 && (m.maxAccel || 0) > 1.25 * (m.accelAt?.handAccel || 0);
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
  const m = g.run([[0, 1, {}], [1, 7, { trig: 'shot-stepback' }]]);
  const move = m.actions.find((a) => /btl-cross/.test(a.clip));
  assert.ok(move, 'the move played');
  const inMove = m.bounces.filter((b) => b.t > move.t && b.t < move.t + 1.2);
  assert.strictEqual(inMove.length, 2, `two floor contacts in the move (${JSON.stringify(inMove.map((b) => b.t))})`);
  for (const b of inMove) assert.ok(Math.abs(b.p[1] - 0.12) < 1e-6, 'on the floor, not through it');
  assert.ok(m.leg.flight.min >= -0.005, `through the legs without touching them (${(m.leg.flight.min * 100).toFixed(1)} cm)`);
  assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, 'shot, then passed back');
  assertClean('btl-cross-shot', m, { catchErr: 0.06 });
});

test('game: the jump shot (□ standing, the user’s own video) — released on its frame, back to idle when it ends, passed back', { skip }, async () => {
  const { makeGame, courtClips } = await H;
  const clips = await courtClips();
  const jumper = clips.find((c) => c.role === 'shot-jumper');
  assert.ok(jumper && /IMG_5816/.test(jumper.name), `the jump shot is the user's video (${jumper?.name})`);
  for (const rig of ['player', 'ac-001']) {
    const g = await makeGame({ rig, fps: 60 });
    let endAt = null, startAt = null, releaseAt = null;
    const m = g.run([[0, 1, {}], [1, 6.5, { trig: 'shot-jumper' }]], {
      onTick: ({ t, P, out }) => {
        if (P.mode === 'action' && /IMG_5816/.test(P.action?.clip?.name || '') && startAt == null) startAt = t;
        if (startAt != null && endAt == null && P.mode === 'loco') endAt = t;
        if (releaseAt == null && out.state === 'SHOT_RELEASE') releaseAt = t;
      },
    });
    assert.ok(startAt != null, `${rig}: the jump shot played`);
    const clipLen = (jumper.frameCount - 1) / jumper.fps;
    assert.ok(endAt != null && endAt - startAt < clipLen + 0.1, `${rig}: back to idle as the clip ends — no hold on the last frame (${(endAt - startAt).toFixed(2)} s for a ${clipLen.toFixed(2)} s clip)`);
    assert.ok(releaseAt != null && releaseAt > startAt && releaseAt < endAt, `${rig}: released during the shot`);
    assert.ok(m.sessionStats.shots === 1 && m.sessionStats.passes === 1, `${rig}: shot, then passed back`);
    assert.strictEqual(m.recoveries.length, 0, `${rig}: no failsafe recovery`);
  }
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
