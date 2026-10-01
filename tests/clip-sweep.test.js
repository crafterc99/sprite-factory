/**
 * The clip sweep (docs/ball-contact-system.md → TESTING): every clip the court can play — every clip of the local
 * library (data/mocap) with a runtime role, each alone in its role, from both hands (as filmed and mirrored), the
 * user's double crossover with its saved contacts and without them (the automatic ones) — through the real game
 * tick on AC (tests/helpers/clip-sweep.mjs), measured on what is drawn, every tick:
 *
 *   hands   the hand skin never inside the ball (≥ 1 mm outside); a contact hand's fingertip pads on the ball
 *           (≤ 6 mm, the thumb ≤ 8 mm); no finger joint turned faster than 26.5 rad/s beyond the clip's own motion
 *   body    a flight never enters the body's skin (torso, head, legs); a ball on the hand ≤ 3 cm into it
 *   ball    never lost, no failsafe recovery, no rejected transition, no NaN, never under the floor, catches on the palm
 *
 *   floor   STRICT, every clip: each bounce touches the floor (± 3 mm), no flight under it, every dribble that goes down
 *           exactly one floor contact; the flying ball never in the body skin (near a hand the capture itself puts in the
 *           body, no deeper than the ball on that hand)
 *
 * A clip the user uploads later is swept by the same rules. A clip · hand with a KNOWN residual (a hand / held-ball
 * metric beyond the limit) is held to its MEASURED value + a tiny epsilon (KNOWN_EPS: 0.2 mm, 0.2 rad/s): never worse —
 * one that got better passes and says so (tighten the fixture: SWEEP_WRITE_KNOWN=1 node --test tests/clip-sweep.test.js
 * rewrites it from the run). Never a ceiling on the STRICT metrics. Needs the clip library (npm run clips:pull).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HAVE_CLIPS = fs.existsSync(path.join(ROOT, 'data', 'mocap', 'index.json'));
const skip = HAVE_CLIPS ? false : 'no clip library (npm run clips:pull)';
const SW = import('./helpers/clip-sweep.mjs');
const H = import('./helpers/ball-harness.mjs');

/**
 * Known residuals (AC @60 fps): the case ("clip · hand") → the metric → its measured value. Open work
 * (docs/ball-contact-system.md → KNOWN REMAINING ISSUES): a fingertip / thumb off the ball for a tick or two at a fast
 * catch, a two-hand set whose capture puts the ball on the heels of the hands, a held ball the capture puts against a
 * shin / the chest, a finger joint turned fast in such a tick. Written from a run (SWEEP_WRITE_KNOWN=1).
 */
const KNOWN_FILE = path.join(__dirname, 'fixtures', 'clip-sweep-known.json');
const KNOWN = require(KNOWN_FILE);
/** The ceiling of a known residual: its measured value + this (m; rad/s for jointRate). */
const KNOWN_EPS = Object.freeze({ tipGap: 0.0002, thumbGap: 0.0002, jointRate: 0.2, bodyHeld: 0.0002, handInside: 0.0002, catchErr: 0.0002 });

const mm = (x) => `${(x * 1000).toFixed(1)} mm`;

test('clip sweep: every runtime clip of the library, both hands — hands, body and ball on every tick (AC, 60 fps)', { skip, timeout: 900000 }, async () => {
  const S = await SW, { courtClips } = await H;
  const all = await courtClips();
  assert.ok(all && all.length, 'the clip library builds');
  // the saved contact edits ride on the clip (as the court applies them); a clip with saved edits is swept without them too
  const extra = [];
  for (const c of all) if (c.ballContacts) { const e = JSON.parse(JSON.stringify(c)); delete e.ballContacts; extra.push({ ...e, name: `${c.name} [auto]` }); }
  const cases = await S.sweepCases(all);
  for (const x of extra) for (const c of await S.sweepCases([...all.filter((y) => y.role !== x.role), x])) if (c.clip === x.name) cases.push(c);
  assert.ok(cases.length >= all.length, `cases (${cases.length})`);
  const rows = [], fails = [], better = [], write = {};
  for (const cs of cases) {
    const row = await S.runCase(cs, { rig: 'ac-001', fps: 60 });
    rows.push(row);
    const known = KNOWN[row.key] || {};
    const L = { ...S.SWEEP_LIMITS };
    // (the floor and the flights are STRICT: no clip has a ceiling on them)
    for (const [k, v] of Object.entries(known)) if (k in L && !S.STRICT.includes(k)) {
      L[k] = Math.max(L[k], v + (KNOWN_EPS[k] ?? 0));
      if (row[k] < v - (k === 'jointRate' ? 1 : 0.001)) better.push(`${row.key} ${k}: ${row[k]} (fixture ${v}) — tighten it`);
    }
    // (what this run would write as the known residuals: every metric beyond its universal limit)
    for (const k of Object.keys(KNOWN_EPS)) if (k in S.SWEEP_LIMITS && !S.STRICT.includes(k) && (k === 'handInside' ? row[k] > S.SWEEP_LIMITS[k] : row[k] > S.SWEEP_LIMITS[k])) (write[row.key] ||= {})[k] = row[k];
    const f = S.sweepFailures(row, L);
    // (the clip played as itself — not a fallback)
    if (!/^(idle|loco-)/.test(row.role) && !row.played.some((p) => p.startsWith(row.clip))) f.push(`${row.clip} never played (${JSON.stringify(row.actions)})`);
    if (f.length) fails.push(`${row.key}: ${f.join('; ')}`);
  }
  fs.mkdirSync(path.join(ROOT, 'tests', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests', 'reports', 'clip-sweep.json'), JSON.stringify(rows, null, 1));
  console.log(rows.map((r) => `${r.key.padEnd(48)} skin ${mm(r.handInside)} · tips ${mm(r.tipGap)} · thumb ${mm(r.thumbGap)} · joints ${r.jointRate} rad/s · body flight ${mm(r.bodyFlight)} held ${mm(r.bodyHeld)} · floor contacts ${r.bounces.length} (worst ${mm(r.bounceErr)}) · ${r.dribbles} dribbles · floor dip ${mm(r.floorDip)} · lost ${r.lost} · recoveries ${r.recoveries}`).join('\n'));
  if (better.length) console.log('better than the known residuals:\n' + better.join('\n'));
  // (a known residual of a case that no longer exists, or a metric of it now within the limits: the fixture is stale)
  const stale = Object.entries(KNOWN).filter(([k]) => !k.startsWith('_')).flatMap(([key, m]) => Object.keys(m).filter((k) => !write[key]?.[k]).map((k) => `${key} ${k}`));
  if (process.env.SWEEP_WRITE_KNOWN) {
    fs.writeFileSync(KNOWN_FILE, JSON.stringify({ _note: 'measured residuals beyond the sweep limits, per case (clip · hand), AC @60 fps — the ceiling is the value + KNOWN_EPS (tests/clip-sweep.test.js); rewrite: SWEEP_WRITE_KNOWN=1 node --test tests/clip-sweep.test.js', ...write }, null, 1) + '\n');
    console.log(`wrote ${KNOWN_FILE}`);
  } else assert.deepStrictEqual(stale, [], `known residuals no longer measured (tighten the fixture): ${stale.join(', ')}`);
  assert.deepStrictEqual(fails, [], fails.join('\n'));
});

// every dribble of every clip's contacts touches the floor exactly once (engine3d/ball-contacts.mjs ensureBounces): each
// release → catch flight that goes down — the ball's own frames well below both hands, or the releasing palm pushing
// down to a catch not much lower — has one bounce; one that stays up (a hand-off) none. Both hands, the saved and the
// automatic contacts.
test('clip contacts: every dribble that goes down has exactly one floor contact (every clip, both hands, saved and automatic)', { skip }, async () => {
  const { courtClips } = await H;
  const A = await import('../engine3d/anim3d.mjs');
  const zlib = require('zlib');
  const rig = A.prepareRig(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib', 'mocap', 'mhr-rigs', 'ac-001.json.gz')))));
  const bad = [];
  let n = 0;
  for (const j0 of await courtClips()) for (const mirror of [false, true]) for (const auto of j0.ballContacts ? [false, true] : [false]) {
    const j = JSON.parse(JSON.stringify(j0)); if (auto) delete j.ballContacts;
    const c = A.prepareClip(j, rig, { mirror }), K = c.ballContacts, C = c.contactInput, E = K.events;
    const palm = (f, h) => { const q = C.frames[Math.max(0, Math.min(C.F - 1, Math.round(f)))]; return h === 'left' ? q.palmL : q.palmR; };
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (e.type !== 'release' || (e.hand !== 'left' && e.hand !== 'right')) continue;
      let k = i + 1, bounces = 0;
      for (; k < E.length && E[k].type === 'bounce'; k++) bounces++;
      const ca = E[k];
      if (!ca || ca.type !== 'catch') continue;
      n++;
      const pr = palm(e.frame, e.hand), pc = palm(ca.frame, ca.hand === 'left' || ca.hand === 'right' ? ca.hand : e.hand);
      const vy = ((palm(e.frame + 1, e.hand)[1] - palm(e.frame - 1, e.hand)[1]) * C.fps) / 2;
      let low = Infinity; for (let f = Math.ceil(e.frame); f <= Math.floor(ca.frame); f++) { const b = C.frames[f]?.ball; if (b) low = Math.min(low, b[1]); }
      const down = bounces > 0 || low < Math.min(pr[1], pc[1]) - 0.15 || (vy <= -0.4 && pc[1] > pr[1] - 0.25);
      if (bounces !== (down ? 1 : 0)) bad.push(`${c.name}${mirror ? ' (mirrored)' : ''}${auto ? ' [auto]' : ''}: ${e.hand} @${e.frame.toFixed(1)} → ${ca.hand} @${ca.frame.toFixed(1)} has ${bounces} floor contacts (${down ? 'goes down: 1' : 'stays up: 0'})`);
    }
  }
  assert.ok(n > 20, `dribbles checked (${n})`);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});
