#!/usr/bin/env node
/**
 * The River practice court (court3d.html ?court=river, engine3d/court-river.mjs) on the real game: Chromium
 * (Playwright) with a virtual clock (exact frame steps), driven by the keyboard like a player.
 *
 *   load       ?court=river: no console errors, the court picker shows River, the instanced props stay instanced
 *              (one InstancedMesh each, their counts), draw calls / triangles of a frame
 *   frame      the GLB's rims, nets and boards where the game's hoop physics is (both hoops): the rims' centres on
 *              the goals, the physics boards' faces on the visible boards
 *   look       the reference camera (layout.renderCamera) side by side with replica-cycles.png; two gameplay views
 *   moves      crossover, spin, a right-stick flick (arrows): played, the ball never lost / recovered
 *   shots      the shot meter at the hoop the game plays at: EXCELLENT → a swish through the VISIBLE rim (filmed at
 *              the rim's height, the ball's centre inside the ring); SLIGHTLY LATE → the back of the rim, LATE → off
 *              the glass, each filmed on the physics step it touched (its distance to the visible rim / board's face
 *              checked); the far (East) hoop: a ball dropped through its middle falls through touching nothing, one
 *              dropped on its front edge touches the visible rim
 *   walls      walking into the bleachers, the rubble, the hoop's post, the left wall, the waterfront barrier: every
 *              tick inside the walkable rectangle and out of every footprint, stopped at it without jitter
 *   loft       the door (in the waterfront corner): the prompt, ✕ → the loft, out again → the River court restored
 *              (objects, background, fog, environment, tone mapping, camera), outside the door facing the hoop; a shot
 *   other      a replay (?replay=), the ball lab (?balltest=), the touch / lite path (no planar reflection, smaller
 *              shadow map, the touch buttons, a touch shot), the outfit worn on the River court
 *   picker     the top bar's court picker switches courts and is remembered on the device (VANTHEAH the default)
 *
 * Screenshots + report.json: tests/reports/river-court/ (look at them: 0-reference-vs-cycles.png, 1-/2-gameplay,
 * 3-swish-through-rim, 4-rim-hit, 5-board-hit, 6-east-hoop, 7-door).
 *
 *   node tests/river-court.spec.js [--char ac-001] [--fps 30] [--base http://localhost:3456] [--swiftshader] [--skip-loft]
 *
 * The court is ~1.7 M triangles with a planar reflection: the browser uses the Mac's GPU (Metal) unless --swiftshader.
 * Needs the local server, the clip library (npm run clips:pull) and assets/courts/river.glb + river-layout.json (and
 * loft.glb for the door). Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), BASE = opt('base', 'http://localhost:3456'), SOFT = argv.includes('--swiftshader'), SKIP_LOFT = argv.includes('--skip-loft');
const OUT = path.join(__dirname, 'reports', 'river-court');
fs.mkdirSync(OUT, { recursive: true });
const RIM_Y = 3.05, RIM_R = 0.2286;

const fails = [], notes = {};
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); return ok; };

/** The virtual clock: every rendered frame is exactly 1/FPS s of game time (the video box off: no stray 404s). */
const clockScript = ({ FPS, clear }) => {
  let vt = performance.now();
  const STEP = 1000 / FPS, V = (window.__vt = { frames: 0, budget: Infinity });
  performance.now = () => vt;
  const q = [];
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.cancelAnimationFrame = () => {};
  const pump = () => {
    if (V.budget > 0 && q.length) { const cbs = q.splice(0); vt += STEP; V.frames++; if (V.budget !== Infinity) V.budget--; for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } }
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  try { if (clear && !sessionStorage.getItem('__rc_cleared')) { localStorage.clear(); sessionStorage.setItem('__rc_cleared', '1'); } localStorage.setItem('court3d_vid', JSON.stringify({ on: false })); } catch {}
};

let browser = null;
process.on('unhandledRejection', async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });

(async () => {
  browser = await chromium.launch({ args: SOFT ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const errors = [];
  const watch = (page, tag) => {
    page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text().slice(0, 300)}${m.location()?.url ? ' @ ' + m.location().url : ''}`); });
  };
  const ready = async (page) => {
    await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
    const ok = await page.evaluate(() => !!window.__c3dReady);
    if (ok) await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
    return ok;
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 724 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(clockScript, { FPS, clear: true });
  const page = await ctx.newPage();
  watch(page, 'river');
  const t0 = Date.now();
  await page.goto(`${BASE}/court3d.html?court=river&char=${CHAR}&outfit=tee:0,shorts:0`, { waitUntil: 'load', timeout: 90000 });
  if (!(await ready(page)) || !(await page.evaluate(() => !!window.__river && !!window.__ball))) {
    console.error('the River court did not start:', await page.evaluate(() => document.getElementById('err')?.textContent), errors);
    await browser.close(); process.exit(1);
  }
  notes.loadMs = Date.now() - t0;
  await page.addStyleTag({ content: '#help,#vid{display:none!important}' });
  // a tick recorder: where he is, the ball's state, recoveries; the first contact of every collider (where the ball
  // was on the physics step it began); the ball crossing the rim's height on the way down
  await page.evaluate(({ RIM_Y }) => {
    const S = window.__court3d, B = window.__ball.session, ph = B.phys;
    window.__rec = { ticks: [], recoveries: [], touches: [], crossings: [] };
    const add = ph.touchedSince.add.bind(ph.touchedSince);
    ph.touchedSince.add = (name) => {
      if (!ph.touchedSince.has(name) && name !== 'floor' && !ph.parts?.has(name)) { const t = ph.ball.translation(), v = ph.ball.linvel(); window.__rec.touches.push({ name, p: [t.x, t.y, t.z], v: [v.x, v.y, v.z], t: B.t }); }
      return add(name);
    };
    let prev = null;
    const step = B.step.bind(B);
    B.step = function (...a) {
      if (window.__freeze) return window.__freeze;   // (a frame held: filmed again)
      const out = step(...a), st = window.__loft.state();
      window.__lastOut = { ...out, p: out.p.slice(), q: out.q.slice(), events: [] };
      window.__rec.ticks.push({ w: st.where, tr: st.trans, p: [S.player.pos[0], S.player.pos[1]], s: out.state, y: out.p[1], act: S.player.action?.clip?.name || null, shot: !!S.player.action?.clip?.shot });
      for (const e of out.events) if (e.type === 'recovery') window.__rec.recoveries.push(e.reason);
      if (prev && prev[1] > RIM_Y && out.p[1] <= RIM_Y) { const k = (prev[1] - RIM_Y) / (prev[1] - out.p[1]); window.__rec.crossings.push({ t: this.t, s: out.state, p: prev.map((x, i) => x + (out.p[i] - x) * k) }); }
      prev = out.p.slice();
      return out;
    };
  }, { RIM_Y });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const shot = (name, p = page) => p.screenshot({ path: path.join(OUT, name + '.png'), timeout: 240000 });
  const pos = () => page.evaluate(() => window.__court3d.player.pos.slice());
  const recMark = () => page.evaluate(() => window.__rec.ticks.length);
  const ticksSince = (i) => page.evaluate((i) => window.__rec.ticks.slice(i), i);
  const held = new Set();
  const setKeys = async (want) => { for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); } for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); } };
  /** Walk like a player: WASD toward a point (camera-relative, re-aimed every 3 frames). */
  async function walkTo(x, z, { tol = 0.3, maxS = 15, onStep = null } = {}) {
    for (let i = 0, n = Math.round((maxS * FPS) / 3); i < n; i++) {
      const g = await page.evaluate(([x, z]) => {
        const { THREE, camera } = window.__loft.dbg(), p = window.__court3d.player.pos;
        const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize();
        const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
        const dx = x - p[0], dz = z - p[1], d = Math.hypot(dx, dz);
        return { d, fw: (dx * f.x + dz * f.z) / (d || 1), rt: (dx * r.x + dz * r.z) / (d || 1) };
      }, [x, z]);
      if (g.d < tol) break;
      const want = new Set();
      if (g.fw > 0.38) want.add('KeyW'); if (g.fw < -0.38) want.add('KeyS');
      if (g.rt > 0.38) want.add('KeyD'); if (g.rt < -0.38) want.add('KeyA');
      await setKeys(want);
      await frames(3);
      if (onStep) await onStep(i);
    }
    await setKeys(new Set());
    await frames(2);
  }
  const spread = (ps, k) => Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k]));
  const hasBall = () => page.evaluate(() => { const S = window.__court3d, st = window.__ball.state(); return S.player.hasBall && !S.player.ballFree && S.player.mode === 'loco' && /^(HELD|DRIBBLE|CATCH|BOUNCE)/.test(st); });
  async function ballBack() { for (let i = 0; i < 7 * FPS; i++) { if (await hasBall()) return true; if (i === 4 * FPS) await page.keyboard.press('KeyX'); await frames(1); } return hasBall(); }
  const view = (v) => page.evaluate((v) => window.__river.view(v), v);
  const hideHud = async (on) => page.evaluate((on) => { let s = document.getElementById('__rcHud'); if (on && !s) { s = document.createElement('style'); s.id = '__rcHud'; s.textContent = '.bar,#toast,#stickNote,#shotMeter,#doorPrompt,#help,#vid{display:none!important}'; document.head.appendChild(s); } if (!on && s) s.remove(); }, on);
  await page.mouse.click(900, 420);
  await sec(0.6);

  // ── load: the picker, instancing, the frame's cost ──
  console.log('load');
  check(await page.evaluate(() => window.__courtKind === 'river' && document.getElementById('selCourt').value === 'river'), 'the River court is up, the picker shows River');
  const stats = await page.evaluate(() => window.__river.stats());
  notes.stats = stats;
  const inst = await page.evaluate(() => { const { court } = window.__river.dbg(); const out = {}; court.root.traverse((o) => { if (/^inst-/.test(o.name)) out[o.name] = { instanced: !!o.isInstancedMesh, count: o.count }; }); return out; });
  const wantInst = { 'inst-01-bleachers': 2, 'inst-02-floodlight': 4, 'inst-03-weeds': 80, 'inst-04-tree': 10, 'inst-05-rubble': 4, 'inst-06-vine-curtain': 79, 'inst-hoop': 2 };
  check(Object.entries(wantInst).every(([k, n]) => inst[k]?.instanced && inst[k].count === n), `the repeated props stay instanced (${Object.entries(inst).map(([k, v]) => `${k.replace('inst-', '')} ×${v.count}${v.instanced ? '' : ' NOT instanced'}`).join(', ')})`);
  await sec(0.5);
  notes.cost = { start: await page.evaluate(() => window.__river.frameCost()) };
  console.log('  frame (2K camera at the start):', JSON.stringify(notes.cost.start));

  // ── the frame: the visible hoops where the hoop physics is ──
  console.log('frame');
  const frame = await page.evaluate(() => {
    const { court } = window.__river.dbg(), C = window.__river.colliders();
    const c = (n) => { const b = court.boundsOf(n); return b && { c: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2], r: (b.max.x - b.min.x) / 2, min: b.min.toArray(), max: b.max.toArray() }; };
    return { west: c('Hoop_West_Rim'), east: c('Hoop_East_Rim'), wNet: c('Hoop_West_Net'), eNet: c('Hoop_East_Net'), wFace: c('board-face--1'), eFace: c('board-face-1'), boardFaceX: C.boardFaceX, offsetZ: 12.425, goal: window.__ball.session.hoop.center };
  });
  notes.frame = frame;
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  check(frame.west && d3(frame.west.c, [0, RIM_Y, 0]) < 0.005 && d3(frame.goal, [0, RIM_Y, 0]) < 1e-9, `the West rim (the game's hoop) on the physics rim: centre off by ${(d3(frame.west.c, [0, RIM_Y, 0]) * 1000).toFixed(1)} mm`);
  check(frame.east && d3(frame.east.c, [0, RIM_Y, 24.85]) < 0.005, `the East rim on the physics rim: centre off by ${(d3(frame.east.c, [0, RIM_Y, 24.85]) * 1000).toFixed(1)} mm`);
  check(Math.abs(frame.west.r - (RIM_R + 0.0095)) < 0.006, `the visible rim's radius ${(frame.west.r * 100).toFixed(1)} cm (the physics ring ${(RIM_R * 100).toFixed(2)} + its tube)`);
  const wFaceZ = frame.wFace.max[2], eFaceZ = frame.eFace.min[2], physWZ = frame.offsetZ - frame.boardFaceX, physEZ = frame.offsetZ + frame.boardFaceX;
  check(Math.abs(wFaceZ - physWZ) < 0.002 && Math.abs(eFaceZ - physEZ) < 0.002, `the physics boards' faces on the visible boards (West ${wFaceZ.toFixed(3)} vs ${physWZ.toFixed(3)}, East ${eFaceZ.toFixed(3)} vs ${physEZ.toFixed(3)})`);

  // ── the look: the reference camera vs the Cycles render; two gameplay views ──
  console.log('look');
  await hideHud(true);
  const rc = await page.evaluate(() => window.__river.renderCamera());
  await view(rc); await frames(3);
  await shot('0-reference-view');
  notes.cost.reference = await page.evaluate(() => window.__river.frameCost());
  try {
    const sharp = require('sharp');
    const W = 1280, H = 724, ref = await sharp(path.join(__dirname, '..', 'assets', 'court-river', 'renders', 'replica-cycles.png')).resize(W, H, { fit: 'fill' }).toBuffer();
    const label = (t) => Buffer.from(`<svg width="${W}" height="40"><rect width="100%" height="100%" fill="rgba(0,0,0,0.55)"/><text x="14" y="27" font-family="Helvetica" font-size="20" fill="#fff">${t}</text></svg>`);
    await sharp({ create: { width: W * 2 + 8, height: H, channels: 3, background: '#000' } })
      .composite([{ input: path.join(OUT, '0-reference-view.png'), left: 0, top: 0 }, { input: ref, left: W + 8, top: 0 }, { input: label('the game (three.js, real time)'), left: 0, top: H - 40 }, { input: label('replica-cycles.png (Cycles)'), left: W + 8, top: H - 40 }])
      .png().toFile(path.join(OUT, '0-reference-vs-cycles.png'));
  } catch (e) { console.log('  (no side by side: ' + e.message + ')'); }
  await view(null); await hideHud(false);
  await page.evaluate(() => { window.__court3d.camSnap = true; }); await sec(0.5);
  await shot('1-gameplay-start');

  // ── moves ──
  console.log('moves');
  let m0 = await recMark();
  const acts = new Set();
  for (const k of ['KeyO', 'KeyK']) { await page.keyboard.press(k); for (let i = 0; i < 12; i++) { await frames(5); for (const t of await ticksSince(m0)) if (t.act) acts.add(t.act); } }
  await page.evaluate(() => window.__stick.reset());
  await page.keyboard.press('ArrowLeft'); await sec(0.2); await page.keyboard.press('ArrowRight'); await sec(1.6);
  for (const t of await ticksSince(m0)) if (t.act) acts.add(t.act);
  const stickLog = await page.evaluate(() => window.__stick.log());
  notes.moves = [...acts];
  check(acts.size >= 2, `moves play on the River court (${[...acts].join(', ')})`);
  check(stickLog.some((g) => !g.ignored), `the right stick's gestures are read (${stickLog.map((g) => (g.gesture || g.kind) + '→' + (g.role || g.ignored || '')).join(', ')})`);
  await ballBack();
  // a second gameplay view: dribbling across toward the bleachers, the 2K camera behind him
  let walkShot = false;
  await walkTo(-6, 6.5, { maxS: 6, onStep: async (i) => { if (i === 14 && !walkShot) { walkShot = true; await shot('2-gameplay-dribble'); } } });
  if (!walkShot) await shot('2-gameplay-dribble');

  // ── shots: the meter at the game's hoop ──
  console.log('shots');
  await walkTo(1.8, 5.2);
  await ballBack(); await sec(0.8);
  /** Hold □ (I) and let go k frames off the clip's release frame (null: never); film what the ball met. */
  async function meterShot(key, k, film) {
    await ballBack(); await sec(0.8);
    const tStart = await page.evaluate(() => window.__ball.session.t);
    const c0 = await page.evaluate(() => window.__rec.crossings.length), h0 = await page.evaluate(() => window.__rec.touches.length);
    await page.keyboard.down('KeyI');
    let up = false, res = null, filmed = false;
    for (let i = 0; i < 9 * FPS; i++) {
      await frames(1);
      const st = await page.evaluate(() => ({ sh: window.__shotMeter.shot(), clipT: window.__shotMeter.clipT(), v: window.__shotMeter.view(), last: window.__ball.session.lastShot, rec: { c: window.__rec.crossings.length, h: window.__rec.touches.length } }));
      if (!up && k != null && st.sh && st.clipT != null && st.clipT >= st.sh.rel + k - 1e-6) { await page.keyboard.up('KeyI'); up = true; }
      const L = st.last && st.last.t > tStart ? st.last : null;
      if (L && !filmed) {
        const evt = await page.evaluate(({ c0, h0, tStart }) => ({ cross: window.__rec.crossings.slice(c0).find((c) => c.t > tStart && c.s === 'SHOT_RELEASE') || null, touch: window.__rec.touches.slice(h0).find((h) => h.t > tStart && (h.name === 'rim' || h.name === 'board')) || null }), { c0, h0, tStart });
        const at = await film(evt, L);
        if (at) filmed = at;
      }
      if (L && st.v.result) { res = { result: st.v.result, label: st.v.label }; break; }
    }
    if (!up) await page.keyboard.up('KeyI');
    const last = await page.evaluate(() => window.__shotMeter.last());
    const L = await page.evaluate(() => window.__ball.session.lastShot);
    const touches = await page.evaluate(({ h0, tStart }) => window.__rec.touches.slice(h0).filter((h) => h.t > tStart), { h0, tStart });
    return { key, label: last?.label, make: last?.make, result: last?.result || res?.result, through: L?.through, touches, filmed };
  }
  /** Freeze the frame with the ball at p (a physics step's position), the camera on the hoop from the side. */
  async function filmAt(name, p, camPos, look) {
    await page.evaluate(({ p, camPos, look }) => {
      const S = window.__court3d;
      S.speed = 0; S.freezePose = true; window.__freeze = { ...window.__lastOut, p: p.slice() };
      S.camFixed = { pos: camPos, look };
    }, { p, camPos, look });
    await hideHud(true); await frames(3); await shot(name); await hideHud(false);
    await page.evaluate(() => { const S = window.__court3d; S.speed = 1; S.freezePose = false; window.__freeze = null; S.camFixed = null; });
  }
  // EXCELLENT: through the visible rim (filmed where the ball's centre comes down through the rim's height)
  const ex = await meterShot('excellent', -1, async (e) => {
    if (!e.cross) return null;
    await filmAt('3-swish-through-rim', e.cross.p, [2.6, 3.55, 1.7], [0, 3.0, -0.05]);
    await filmAt('3b-swish-side', e.cross.p, [3.4, 3.15, -0.15], [0, 3.0, -0.1]);
    return e.cross.p;
  });
  const exR = ex.filmed ? Math.hypot(ex.filmed[0], ex.filmed[2]) : null;
  notes.excellent = ex;
  check(ex.label === 'EXCELLENT' && ex.make && ex.result === 'SWISH' && ex.through && !ex.touches.some((h) => h.name === 'rim' || h.name === 'board'), `EXCELLENT → a swish (${ex.label} → ${ex.result}; touched ${ex.touches.map((h) => h.name).join(', ') || 'nothing'})`);
  check(exR != null && exR < RIM_R - 0.12 + 0.03, `…through the visible rim: its centre ${exR != null ? (exR * 100).toFixed(1) : '?'} cm off the rim's centre at the rim's height (the ring's inner radius ${(RIM_R * 100).toFixed(1)} cm, the ball's 12)`);
  // SLIGHTLY LATE: the back of the rim (filmed on the step it touched)
  const rimHit = await meterShot('slightly-late', 4, async (e) => {
    if (!e.touch) return null;
    await filmAt('4-rim-hit', e.touch.p, [2.8, 3.25, e.touch.p[2] + 0.2], [e.touch.p[0], 3.05, e.touch.p[2]]);
    return e.touch;
  });
  notes.rimHit = rimHit;
  const tr = rimHit.filmed;
  const rimGap = tr && tr.name === 'rim' ? Math.hypot(Math.hypot(tr.p[0], tr.p[2]) - RIM_R, tr.p[1] - RIM_Y) - 0.12 - 0.0095 : null;
  check(rimHit.label === 'SLIGHTLY LATE' && tr?.name === 'rim' && rimHit.result === 'MISS', `SLIGHTLY LATE → the rim first, out (${rimHit.label} → first ${tr?.name || 'nothing'} → ${rimHit.result})`);
  check(rimGap != null && Math.abs(rimGap) < 0.015, `…touching the visible rim: the ball's surface ${rimGap != null ? (rimGap * 1000).toFixed(1) : '?'} mm off the rim's tube on the step it touched`);
  // LATE: off the glass (filmed on the step it touched, from the side: the ball against the board's face)
  const glass = await meterShot('late', 6, async (e) => {
    if (!e.touch) return null;
    await filmAt('5-board-hit', e.touch.p, [2.7, e.touch.p[1] + 0.15, e.touch.p[2] + 0.35], [e.touch.p[0], e.touch.p[1], e.touch.p[2] - 0.12]);
    return e.touch;
  });
  notes.boardHit = glass;
  const tb = glass.filmed;
  const boardGap = tb && tb.name === 'board' ? (tb.p[2] - 0.12) - wFaceZ : null;
  check(glass.label === 'LATE' && tb?.name === 'board' && glass.result === 'MISS', `LATE → off the glass, out (${glass.label} → first ${tb?.name || 'nothing'} → ${glass.result})`);
  check(boardGap != null && Math.abs(boardGap) < 0.015, `…touching the visible board: the ball's surface ${boardGap != null ? (boardGap * 1000).toFixed(1) : '?'} mm off the board's face on the step it touched`);
  // the far (East) hoop: no shot goes there — a ball dropped through its middle, and one on its front edge
  console.log('east hoop');
  await ballBack(); await sec(0.5);
  async function drop(p, ms = 1.6) {
    const h0 = await page.evaluate(() => window.__rec.touches.length), c0 = await page.evaluate(() => window.__rec.crossings.length);
    await page.evaluate((p) => { window.__ball.session.phys.touchedSince.clear(); window.__ball.session.drop(p, [0, 0, 0], [0, 0, 0]); }, p);
    await sec(ms);
    return page.evaluate(({ h0, c0 }) => ({ touches: window.__rec.touches.slice(h0), cross: window.__rec.crossings.slice(c0) }), { h0, c0 });
  }
  const eMid = await drop([0, 4.3, 24.85]);
  const eCross = eMid.cross[0];
  check(eCross && Math.hypot(eCross.p[0], eCross.p[2] - 24.85) < 0.03 && !eMid.touches.some((h) => /rim|board/.test(h.name)), `East: dropped through its middle — down through the rim touching nothing (${eMid.touches.map((h) => h.name).join(', ') || 'nothing'})`);
  if (eCross) await filmAt('6-east-hoop-through', eCross.p, [2.4, 3.6, 22.9], [0, 3.0, 24.9]);
  await page.keyboard.press('KeyX'); await sec(0.8);
  const eEdge = await drop([0, 4.3, 24.85 - RIM_R]);
  const et = eEdge.touches.find((h) => h.name === 'rim');
  const eGap = et ? Math.hypot(Math.hypot(et.p[0], et.p[2] - 24.85) - RIM_R, et.p[1] - RIM_Y) - 0.12 - 0.0095 : null;
  check(eGap != null && Math.abs(eGap) < 0.015, `East: dropped on its front edge — touches the visible rim (${eGap != null ? (eGap * 1000).toFixed(1) : '?'} mm off its tube)`);
  if (et) await filmAt('6b-east-rim-hit', et.p, [2.4, 3.4, 23.6], [0, 3.05, 24.7]);
  await page.keyboard.press('KeyX'); await sec(0.8);
  await ballBack();

  // ── walls: bleachers, rubble, the hoop's post, the left wall, the waterfront ──
  console.log('walls');
  const W = await page.evaluate(() => window.__river.W());
  const box = (n) => W.colliders.find((c) => c.name === n);
  const wm = await recMark();
  /**
   * Walk to `from`, then straight along `dir` ([dx, dz]) into what is there: the camera held behind him looking
   * along it (the keys are camera relative: W is exactly that way), W held for s seconds. His positions over the
   * last 20 frames.
   */
  async function pushInto(from, dir, s = 3) {
    await walkTo(from[0], from[1], { maxS: 20 });
    await page.evaluate(({ from, dir }) => { window.__court3d.camFixed = { pos: [from[0] - dir[0] * 4, 2.2, from[1] - dir[1] * 4], look: [from[0] + dir[0] * 4, 1.0, from[1] + dir[1] * 4] }; }, { from, dir });
    await frames(2);
    await page.keyboard.down('KeyW'); await sec(s - 0.7);
    const ps = []; for (let i = 0; i < 10; i++) { await frames(2); ps.push(await pos()); }
    await page.keyboard.up('KeyW');
    await page.evaluate(() => { window.__court3d.camFixed = null; }); await sec(0.3);
    return ps;
  }
  const bl = box('01-bleachers#1'), blZ = (bl.minZ + bl.maxZ) / 2;
  const pBl = await pushInto([bl.maxX + 1.6, blZ], [-1, 0]);
  check(Math.abs(Math.min(...pBl.map((p) => p[0])) - (bl.maxX + 0.3)) < 0.03 && spread(pBl, 0) < 0.01, `stopped at the bleachers' front, no jitter (x ${Math.min(...pBl.map((p) => p[0])).toFixed(3)} vs ${(bl.maxX + 0.3).toFixed(3)}, spread ${(spread(pBl, 0) * 100).toFixed(2)} cm)`);
  // (where he must stop: the walkable rectangle's edge, or the wall's / fence's own footprint if it reaches further in)
  const R = 0.3, wallX = Math.max(W.bounds.minX, ...W.colliders.filter((c) => c.maxX < -16.2 && c.minZ - R < -2.6 && c.maxZ + R > -2.6).map((c) => c.maxX + R));
  const pWall = await pushInto([-16.2, -2.6], [-1, 0]);
  check(Math.abs(Math.min(...pWall.map((p) => p[0])) - wallX) < 0.03 && spread(pWall, 0) < 0.01, `stopped at the left wall, no jitter (x ${Math.min(...pWall.map((p) => p[0])).toFixed(3)} vs ${wallX.toFixed(3)}, spread ${(spread(pWall, 0) * 100).toFixed(2)} cm)`);
  const waterZ = Math.max(W.bounds.minZ, ...W.colliders.filter((c) => c.maxZ < -5.5 && c.minX - R < -8 && c.maxX + R > -8).map((c) => c.maxZ + R));
  const pWater = await pushInto([-8, -5.5], [0, -1]);
  check(Math.abs(Math.min(...pWater.map((p) => p[1])) - waterZ) < 0.03 && spread(pWater, 1) < 0.01, `stopped at the waterfront barrier, no jitter (z ${Math.min(...pWater.map((p) => p[1])).toFixed(3)} vs ${waterZ.toFixed(3)}, spread ${(spread(pWater, 1) * 100).toFixed(2)} cm)`);
  const pole = box('hoop-pole--1'), poleX = (pole.minX + pole.maxX) / 2;
  const pPole = await pushInto([poleX, pole.minZ - 1.4], [0, 1]);
  check(Math.abs(Math.max(...pPole.map((p) => p[1])) - (pole.minZ - 0.3)) < 0.03 && spread(pPole, 1) < 0.01, `stopped at the hoop's post, no jitter (z ${Math.max(...pPole.map((p) => p[1])).toFixed(3)} vs ${(pole.minZ - 0.3).toFixed(3)}, spread ${(spread(pPole, 1) * 100).toFixed(2)} cm)`);
  const ru = box('05-rubble#0'), ruZ = (ru.minZ + ru.maxZ) / 2;
  const pRu = await pushInto([ru.minX - 1.6, ruZ], [1, 0]);
  check(Math.abs(Math.max(...pRu.map((p) => p[0])) - (ru.minX - 0.3)) < 0.03 && spread(pRu, 0) < 0.01, `stopped at the rubble, no jitter (x ${Math.max(...pRu.map((p) => p[0])).toFixed(3)} vs ${(ru.minX - 0.3).toFixed(3)}, spread ${(spread(pRu, 0) * 100).toFixed(2)} cm)`);
  const walk = (await ticksSince(wm)).filter((t) => t.w === 'court' && !t.tr);
  const inB = (p, m = 1e-6) => p[0] >= W.bounds.minX - m && p[0] <= W.bounds.maxX + m && p[1] >= W.bounds.minZ - m && p[1] <= W.bounds.maxZ + m;
  const worst = await page.evaluate((pts) => import('/js/loft.mjs').then((LM) => { const W = window.__river.W(); let w = 0, at = null; for (const p of pts) { const d = LM.penetration(p[0], p[1], LM.PLAYER_R, W); if (d > w) { w = d; at = p; } } return { w, at }; }), walk.map((t) => t.p));
  check(walk.length > 200 && walk.every((t) => inB(t.p)), `every tick inside the walkable rectangle (${walk.length} ticks)`);
  check(worst.w < 0.012, `never inside the bleachers / rubble / hoop post / the door's stair-house (worst ${(worst.w * 100).toFixed(1)} cm${worst.at ? ' at ' + worst.at.map((v) => v.toFixed(2)) : ''})`);

  // ── the loft door, from the River court ──
  if (!SKIP_LOFT) {
    console.log('loft');
    const door = await page.evaluate(() => window.__loft.door());
    const before = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), env: window.__loft.env(), near: window.__loft.dbg().camera.near, far: window.__loft.dbg().camera.far, fog: !!window.__loft.dbg().scene.fog }));
    let doorShot = false;
    await walkTo(door.out[0], door.out[1], { maxS: 20, onStep: async () => {
      if (doorShot) return;
      const p = await pos();
      if (Math.hypot(p[0] - door.x, p[1] - door.z) < 3.5) {
        doorShot = true;
        await page.evaluate((d) => { window.__court3d.camFixed = { pos: [d.x + 5.0, 1.9, d.z + 2.4], look: [d.x - 0.4, 1.3, d.z] }; }, door);
        await frames(1); await shot('7-door'); await page.evaluate(() => { window.__court3d.camFixed = null; });
      }
    } });
    let s = await page.evaluate(() => window.__loft.state());
    check(s.where === 'court' && s.prompt === 'enter', `at the door: the prompt (${s.prompt})`);
    await page.keyboard.press('KeyX');
    for (let i = 0; i < 1500; i++) { await frames(2); s = await page.evaluate(() => window.__loft.state()); if (s.where === 'loft' && !s.trans) break; if (s.error && !s.loading) break; }
    await sec(0.6);
    const inside = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), inScene: window.__loft.inScene(), env: window.__loft.env(), has: window.__court3d.player.hasBall }));
    check(s.where === 'loft' && inside.inScene && JSON.stringify(inside.vis) === '["LoftWorld"]' && inside.has, `✕ → in the loft, only the loft drawn, with the ball (${s.error || inside.vis})`);
    await shot('7b-loft-inside');
    const LW = await page.evaluate(() => window.__loft.W());
    await walkTo(LW.exit.x, LW.exit.z + 0.05, { tol: 0.3 });
    await page.keyboard.press('KeyX');
    for (let i = 0; i < 300; i++) { await frames(3); s = await page.evaluate(() => window.__loft.state()); if (s.where === 'court' && !s.trans) break; }
    await sec(0.6);
    const after = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), inScene: window.__loft.inScene(), env: window.__loft.env(), near: window.__loft.dbg().camera.near, far: window.__loft.dbg().camera.far, fog: !!window.__loft.dbg().scene.fog, p: window.__court3d.player.pos.slice(), yaw: window.__court3d.player.yaw, has: window.__court3d.player.hasBall, kind: window.__courtKind, river: !!window.__court3d.river }));
    check(s.where === 'court' && !after.inScene && after.river, 'back on the River court, the loft out of the scene');
    check(JSON.stringify(after.vis) === JSON.stringify(before.vis), `the River court's world restored (${after.vis.length} objects)`);
    check(JSON.stringify(after.env) === JSON.stringify(before.env) && after.fog === before.fog && after.near === before.near && after.far === before.far, 'its sky, fog, environment, AgX exposure and camera restored');
    const toHoop = Math.atan2(-after.p[0], -after.p[1]);
    check(Math.hypot(after.p[0] - door.out[0], after.p[1] - door.out[1]) < 0.35 && Math.abs(Math.atan2(Math.sin(after.yaw - toHoop), Math.cos(after.yaw - toHoop))) < 0.5 && after.has, `outside the door, facing the hoop, with the ball (${after.p.map((v) => v.toFixed(2))})`);
    await sec(0.6); await shot('7c-back-on-river-court');
    await walkTo(1.8, 5.2, { maxS: 20 });
    const shots0 = await page.evaluate(() => window.__court3d.shotsTaken || 0);
    await page.keyboard.down('KeyI'); await sec(0.45); await page.keyboard.up('KeyI'); await sec(2.5);
    check((await page.evaluate(() => window.__court3d.shotsTaken || 0)) > shots0, 'a shot on the River court after the loft');
    await ballBack();
  }
  // every tick of this page
  const all = await ticksSince(0), recs = await page.evaluate(() => window.__rec.recoveries);
  check(all.every((t) => t.y > 0.1), 'the ball never through the floor');
  notes.recoveries = recs;
  check(!recs.length, `no ball recovery on the River court (${recs.join(', ')})`);
  const outfit = await page.evaluate(() => ({ sel: window.__outfit.sel(), state: window.__outfit.state().length }));
  check(Object.keys(outfit.sel).length >= 1 && outfit.state >= 1, `the outfit is worn on the River court (${JSON.stringify(outfit.sel)})`);
  await page.close();

  // ── a replay and the ball lab on the River court ──
  console.log('replay · ball lab');
  const lib = await (await ctx.request.get(`${BASE}/api/mocap3d/library`)).json();
  const idle = (lib.court || []).find((c) => c.role === 'idle');
  {
    const p = await ctx.newPage(); watch(p, 'replay');
    await p.goto(`${BASE}/court3d.html?court=river&char=${CHAR}&replay=${encodeURIComponent(idle.id)}`, { waitUntil: 'load', timeout: 90000 });
    const ok = await ready(p);
    await p.evaluate(() => new Promise((res) => { window.__vt.budget = 30; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }));
    const r = await p.evaluate(() => ({ kind: window.__courtKind, replay: !!window.__court3d.replay, t: window.__court3d.replay?.t }));
    check(ok && r.kind === 'river' && r.replay && r.t > 0, `a replay plays on the River court (${idle.name}, t ${r.t?.toFixed?.(1)})`);
    await p.close();
  }
  {
    const p = await ctx.newPage(); watch(p, 'balltest');
    await p.goto(`${BASE}/court3d.html?court=river&char=${CHAR}&balltest=dribble-right`, { waitUntil: 'load', timeout: 90000 });
    const ok = await ready(p);
    await p.evaluate(() => new Promise((res) => { window.__vt.budget = 60; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }));
    const r = await p.evaluate(() => ({ kind: window.__courtKind, lab: window.__court3d.lab && { name: window.__court3d.lab.name, t: window.__court3d.lab.t }, y: window.__ballProbe() }));
    check(ok && r.kind === 'river' && r.lab?.name === 'dribble-right' && r.lab.t > 0.5 && r.y > 0.1, `the ball lab runs on the River court (${JSON.stringify(r.lab)})`);
    await p.close();
  }

  // ── touch / lite: an iPad-class device ──
  console.log('touch · lite');
  {
    const tctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await tctx.addInitScript(clockScript, { FPS, clear: false });
    const p = await tctx.newPage(); watch(p, 'lite');
    await p.goto(`${BASE}/court3d.html?court=river&char=${CHAR}&lite=1`, { waitUntil: 'load', timeout: 90000 });
    const ok = await ready(p);
    const fr = (n) => p.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
    await fr(20);
    const L = await p.evaluate(() => { const { court, renderer } = window.__river.dbg(); return { stats: window.__river.stats(), shadow: court.sun.shadow.mapSize.toArray(), puddle: court.puddles[0]?.material?.name, pr: renderer.getPixelRatio(), shootBtn: getComputedStyle(document.getElementById('shootBtn')).display, cost: window.__river.frameCost() }; });
    notes.lite = L;
    check(ok && !L.stats.reflector && /env mirror/.test(L.puddle || '') && L.shadow[0] * L.shadow[1] <= 2048 * 512 && L.pr <= 1.5, `lite: no planar reflection, the puddles mirror the environment, shadow map ${L.shadow.join('×')}, pixel ratio ${L.pr}`);
    check(L.shootBtn !== 'none', `touch: the touch buttons are up (SHOOT ${L.shootBtn})`);
    // a touch shot: press SHOOT, let go
    const s0 = await p.evaluate(() => window.__court3d.shotsTaken || 0);
    await p.dispatchEvent('#shootBtn', 'pointerdown', { pointerId: 7, pointerType: 'touch' });
    await fr(Math.round(0.9 * FPS));
    await p.dispatchEvent('#shootBtn', 'pointerup', { pointerId: 7, pointerType: 'touch' });
    await fr(Math.round(2.5 * FPS));
    check((await p.evaluate(() => window.__court3d.shotsTaken || 0)) > s0, 'touch: SHOOT shoots on the River court');
    await p.screenshot({ path: path.join(OUT, '8-lite-touch.png') });
    await tctx.close();
  }

  // ── the court picker: switches, remembered on this device ──
  console.log('picker');
  {
    const p = await ctx.newPage(); watch(p, 'picker');
    await p.goto(`${BASE}/court3d.html?court=river&char=${CHAR}`, { waitUntil: 'load', timeout: 90000 });
    await ready(p);
    await Promise.all([p.waitForNavigation({ timeout: 90000 }), p.selectOption('#selCourt', 'vantheah')]);
    await ready(p);
    const a = await p.evaluate(() => ({ kind: window.__courtKind, sel: document.getElementById('selCourt').value, saved: localStorage.getItem('court3d_court'), url: location.search }));
    check(a.kind === 'vantheah' && a.sel === 'vantheah' && a.saved === 'vantheah', `the picker → VANTHEAH (${JSON.stringify(a)})`);
    await Promise.all([p.waitForNavigation({ timeout: 90000 }), p.selectOption('#selCourt', 'river')]);
    await ready(p);
    // another character (the Player picker): still the River court
    const other = await p.evaluate((c) => [...document.querySelectorAll('#selChar option')].map((o) => o.value).find((v) => v !== c), CHAR);
    if (other) {
      await Promise.all([p.waitForNavigation({ timeout: 90000 }), p.selectOption('#selChar', other)]);
      const okc = await ready(p);
      const c = await p.evaluate(() => ({ kind: window.__courtKind, char: new URLSearchParams(location.search).get('char'), hasBall: window.__court3d.player.hasBall }));
      check(okc && c.kind === 'river' && c.char === other && c.hasBall, `another character (${other}) on the River court (${JSON.stringify(c)})`);
    }
    await p.goto(`${BASE}/court3d.html?char=${CHAR}`, { waitUntil: 'load', timeout: 90000 });
    await ready(p);
    const b = await p.evaluate(() => ({ kind: window.__courtKind, sel: document.getElementById('selCourt').value }));
    check(b.kind === 'river' && b.sel === 'river', `remembered: no ?court= → the River court (${JSON.stringify(b)})`);
    await p.evaluate(() => localStorage.removeItem('court3d_court'));
    await p.goto(`${BASE}/court3d.html?char=${CHAR}`, { waitUntil: 'load', timeout: 90000 });
    await ready(p);
    check(await p.evaluate(() => window.__courtKind === 'vantheah'), 'nothing saved → VANTHEAH (the default)');
    await p.close();
  }

  check(!errors.length, `no console errors${errors.length ? ': ' + errors.slice(0, 6).join(' | ') : ''}`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ fps: FPS, char: CHAR, gpu: SOFT ? 'swiftshader' : 'metal', fails, notes, errors, at: new Date().toISOString() }, null, 1));
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed', '→', OUT);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
