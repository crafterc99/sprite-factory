#!/usr/bin/env node
/**
 * The loft behind the court's door (court3d.html, engine3d/loft.mjs) on the real court: Chromium (Playwright)
 * with a virtual clock (exact frame steps), driven by the keyboard like a player.
 *
 *   failure    the GLB answers HTTP 500: ✕ at the door shows the load panel with the error and "Try again", the
 *              court stays exactly as it was (no half-swapped scene), he still plays
 *   door       he walks from the start to the stair-house behind the baseline: the prompt "Enter the loft"
 *   load       "Try again" (the GLB served): real progress (MB, %), time to ready, then straight in
 *   ✕          near the door ✕ goes through it and does nothing else (a lost ball is not replaced on the court)
 *   inside     the court world hidden (only the loft drawn), AgX, no fog; he stands at the spawn, inside the bounds,
 *              with the ball
 *   walls      walking into a wall and into the sofa: every frame inside the bounds and out of the furniture, no
 *              jitter pushing against them
 *   □          "No hoop in here": no meter, no shot clip, the ball stays in play
 *   moves      crossover, spin, a right-stick (arrow) flick: they play in the loft; a dropped ball comes back
 *   exit       at the exit "Back to the court": ✕ → the court world restored exactly (objects, background, fog,
 *              environment, tone mapping, camera), he stands outside the door facing the court; a shot works
 *   again      in again (the prompt tapped): cached — no download, in at once
 *
 * Every tick is recorded (where, position, ball state): never inside a wall / the furniture, the ball never through
 * the floor, no recovery. Screenshots: tests/reports/loft-door/ (the door on the court, the first view inside,
 * walking, back on the court, the load error).
 *
 *   node tests/loft-door.spec.js [--char player] [--fps 30] [--court vantheah|classic] [--base http://localhost:3456] [--swiftshader]
 *
 * The loft is ~1.6 M triangles and ~1.5 GB of textures: the browser uses the Mac's GPU (Metal) unless
 * --swiftshader. Needs the local server, the clip library (npm run clips:pull) and assets/courts/loft.glb +
 * loft-layout.json. Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'player'), BASE = opt('base', 'http://localhost:3456'), SOFT = argv.includes('--swiftshader'), COURT = opt('court', 'vantheah');
const OUT = path.join(__dirname, 'reports', 'loft-door', COURT === 'classic' ? 'classic' : '');
fs.mkdirSync(OUT, { recursive: true });

const fails = [], notes = {};
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); return ok; };

(async () => {
  const browser = await chromium.launch({ args: SOFT ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
  // virtual clock: every rendered frame is exactly 1/FPS s of game time
  await ctx.addInitScript(({ FPS }) => {
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
    // (the video box off: a clip whose source video is not on this machine 404s its frames — not the loft's)
    try { localStorage.clear(); localStorage.setItem('court3d_vid', JSON.stringify({ on: false })); } catch {}
  }, { FPS });
  const page = await ctx.newPage();
  const errors = [];
  let expect500 = true;
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (expect500 && /status of 500/.test(t)) return; errors.push(t.slice(0, 300) + (m.location()?.url ? ' @ ' + m.location().url : '')); });
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
  // the GLB: a forced failure first (HTTP 500), then served — and every request of it counted
  let glbRequests = 0, glbFail = true;
  await page.route('**/courts/loft.glb*', (route) => { glbRequests++; if (glbFail) return route.fulfill({ status: 500, body: 'forced failure (test)' }); return route.continue(); });

  await page.goto(`${BASE}/court3d.html?char=${CHAR}${COURT === 'classic' ? '&court=classic' : ''}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
  if (!(await page.evaluate(() => !!window.__c3dReady && !!window.__loft && !!window.__ball))) { console.error('court did not start', await page.evaluate(() => document.getElementById('err')?.textContent), errors); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
  await page.addStyleTag({ content: '#help,#vid{display:none!important}' });
  // a tick recorder: where he is, the ball's state
  await page.evaluate(() => {
    const S = window.__court3d, B = window.__ball.session;
    window.__rec = { ticks: [], recoveries: [] };
    const step = B.step.bind(B);
    B.step = function (...a) {
      const out = step(...a), st = window.__loft.state();
      window.__rec.ticks.push({ w: st.where, tr: st.trans, p: [S.player.pos[0], S.player.pos[1]], s: out.state, y: out.p[1], act: S.player.action?.clip?.name || null, shot: !!S.player.action?.clip?.shot });
      for (const e of out.events) if (e.type === 'recovery') window.__rec.recoveries.push(e.reason);
      return out;
    };
  });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const st = () => page.evaluate(() => window.__loft.state());
  const pos = () => page.evaluate(() => window.__court3d.player.pos.slice());
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const recMark = () => page.evaluate(() => window.__rec.ticks.length);
  const ticksSince = (i) => page.evaluate((i) => window.__rec.ticks.slice(i), i);
  // walk like a player: WASD toward a point (camera-relative, re-aimed every 3 frames)
  const held = new Set();
  const setKeys = async (want) => { for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); } for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); } };
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
  await page.mouse.click(900, 420);
  await sec(0.5);

  const door = await page.evaluate(() => window.__loft.door());
  const courtBefore = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), env: window.__loft.env(), near: window.__loft.dbg().camera.near, far: window.__loft.dbg().camera.far }));
  notes.courtBefore = courtBefore;

  // ── the door, from the start (seen ahead, past the hoop), then up to it ──
  console.log('door');
  await shot('0-start-door-ahead');
  let doorShot = false;
  await walkTo(door.x + 0.4, door.z + 0.6, { onStep: async () => {
    if (doorShot) return;
    const p = await pos();
    if (Math.hypot(p[0] - door.x, p[1] - door.z) < 3.2) {
      // (a camera in front of the stair-house: the door, its sign and lamp, the player walking up)
      doorShot = true;
      await page.evaluate((d) => { window.__court3d.camFixed = { pos: [d.x + 2.6, 1.75, d.face + 5.2], look: [d.x - 0.3, 1.25, d.face] }; }, door);
      await frames(1); await shot('1-door-on-court');
      await page.evaluate(() => { window.__court3d.camFixed = null; });
    }
  } });
  let s = await st();
  check(s.where === 'court' && s.prompt === 'enter', `at the door: the prompt (${s.prompt})`);
  check(await page.evaluate(() => getComputedStyle(document.getElementById('doorPrompt')).display !== 'none' && /Enter the loft/.test(document.getElementById('doorPrompt').textContent)), 'the prompt reads "Enter the loft"');

  // ── the forced failure: the GLB answers 500 ──
  console.log('failure (HTTP 500)');
  await page.keyboard.press('KeyX');
  for (let i = 0; i < 400; i++) { await frames(3); s = await st(); if (s.error && !s.loading) break; }
  await frames(3);
  const panel = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('loftLoad')).display !== 'none', text: document.getElementById('loftLoad').innerText, retry: getComputedStyle(document.getElementById('loftRetry')).display !== 'none' }));
  check(panel.shown && /could not load/i.test(panel.text) && /500/.test(panel.text) && panel.retry, `the load panel: the error and "Try again" (${panel.text.replace(/\s+/g, ' ')})`);
  await shot('5-load-error');
  const intact = await page.evaluate(() => ({ where: window.__loft.state().where, inScene: window.__loft.inScene(), vis: window.__loft.courtVisible(), env: window.__loft.env() }));
  check(intact.where === 'court' && !intact.inScene && JSON.stringify(intact.vis) === JSON.stringify(courtBefore.vis) && JSON.stringify(intact.env) === JSON.stringify(courtBefore.env), 'the court untouched after the failure (objects, environment, tone mapping)');
  const pf0 = await pos(); await page.keyboard.down('KeyD'); await sec(0.6); await page.keyboard.up('KeyD'); await sec(0.3); const pf1 = await pos();
  check(Math.hypot(pf1[0] - pf0[0], pf1[1] - pf0[1]) > 0.3, 'he still plays after the failure');
  await walkTo(door.x + 0.4, door.z + 0.6);

  // ── Try again (served now): real progress, time to ready, then straight in ──
  console.log('load');
  glbFail = false; expect500 = false;
  const tRetry = Date.now();
  await page.click('#loftRetry');
  const seen = { mb: false, pct: false };
  let tReady = null, tInside = null;
  for (let i = 0; i < 2000; i++) {
    await frames(2);
    const t = await page.evaluate(() => document.getElementById('loftLoad').innerText);
    if (/\d+(\.\d)? \/ \d+(\.\d)? MB/.test(t)) seen.mb = true;
    if (/Loading the loft… \d+%/.test(t)) seen.pct = true;
    s = await st();
    if (s.loaded && !tReady) tReady = Date.now();
    if (s.where === 'loft' && !s.trans) { tInside = Date.now(); break; }
    if (s.error && !s.loading) break;
  }
  await sec(0.5);
  const stats = await page.evaluate(() => window.__loft.stats());
  notes.load = { readyMs: tReady && tReady - tRetry, insideMs: tInside && tInside - tRetry, stats };
  console.log('  load:', JSON.stringify(notes.load));
  check(seen.mb && seen.pct, 'the panel showed real progress (MB and %)');
  check(!!tReady && !!tInside, `loaded and in (ready ${tReady && tReady - tRetry} ms, inside ${tInside && tInside - tRetry} ms)`);

  // ── inside ──
  console.log('inside');
  const W = await page.evaluate(() => window.__loft.W());
  const inside = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), inScene: window.__loft.inScene(), env: window.__loft.env(), p: window.__court3d.player.pos.slice(), has: window.__court3d.player.hasBall, ball: window.__ball.state() }));
  check(inside.inScene && JSON.stringify(inside.vis) === '["LoftWorld"]', `only the loft is drawn (${inside.vis})`);
  check(inside.env.toneMapping === 6 && !inside.env.fog && inside.env.env, 'AgX, no fog, the room\'s environment');
  const inB = (p, m = 1e-6) => p[0] >= W.bounds.minX - m && p[0] <= W.bounds.maxX + m && p[1] >= W.bounds.minZ - m && p[1] <= W.bounds.maxZ + m;
  check(inB(inside.p) && Math.hypot(inside.p[0] - W.spawn.x, inside.p[1] - W.spawn.z) < 0.3, `he stands at the spawn, inside the bounds (${inside.p.map((v) => v.toFixed(2))})`);
  check(inside.has && /^(HELD|RELEASE|DRIBBLE|BOUNCE|CATCH)/.test(inside.ball), `he has the ball (${inside.ball})`);
  await sec(0.6);
  await shot('2-inside-first-view');

  // ── walls and the sofa ──
  console.log('walls');
  const m0 = await recMark();
  // into the sofa (straight ahead of the spawn), then on pushing against it
  await walkTo(W.spawn.x, W.spawn.z - 4.5, { maxS: 4 });
  await page.keyboard.down('KeyW'); await sec(1.0);
  const pSofa = []; for (let i = 0; i < 10; i++) { await frames(2); pSofa.push(await pos()); }
  await page.keyboard.up('KeyW'); await sec(0.3);
  await shot('3b-at-the-sofa');
  // into the right-hand wall (a view while he walks)
  let walkShot = false;
  await walkTo(W.bounds.maxX + 3, W.spawn.z - 1.5, { maxS: 6, onStep: async (i) => { if (i === 8 && !walkShot) { walkShot = true; await shot('3-walking'); } } });
  await page.keyboard.down('KeyD'); await sec(0.8);
  const pWall = []; for (let i = 0; i < 10; i++) { await frames(2); pWall.push(await pos()); }
  await page.keyboard.up('KeyD'); await sec(0.3);
  const walk = (await ticksSince(m0)).filter((t) => t.w === 'loft' && !t.tr);
  const worst = await page.evaluate((pts) => import('/js/loft.mjs').then((LM) => { const W = window.__loft.W(); let w = 0; for (const p of pts) w = Math.max(w, LM.penetration(p[0], p[1], LM.PLAYER_R, W)); return w; }), walk.map((t) => t.p));
  check(walk.length > 60 && walk.every((t) => inB(t.p)), `every tick inside the bounds (${walk.length} ticks)`);
  check(worst < 0.012, `never inside the furniture (worst ${(worst * 100).toFixed(1)} cm)`);
  const sofaZ = Math.max(...pSofa.map((p) => p[1])), sofaFront = W.colliders.find((c) => /sofa/.test(c.name)).maxZ + 0.3;
  const spread = (ps, k) => Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k]));
  check(Math.abs(sofaZ - sofaFront) < 0.05 && spread(pSofa, 1) < 0.01, `stopped at the sofa's front, no jitter (z ${sofaZ.toFixed(3)} vs ${sofaFront.toFixed(3)}, spread ${(spread(pSofa, 1) * 100).toFixed(2)} cm)`);
  check(Math.abs(Math.max(...pWall.map((p) => p[0])) - W.bounds.maxX) < 0.02 && spread(pWall, 0) < 0.01, `stopped at the wall, no jitter (spread ${(spread(pWall, 0) * 100).toFixed(2)} cm)`);

  // ── □: no hoop in here ──
  console.log('□');
  const shots0 = await page.evaluate(() => window.__court3d.shotsTaken || 0);
  await page.keyboard.down('KeyI'); await sec(0.2);
  const toast = await page.evaluate(() => ({ on: getComputedStyle(document.getElementById('toast')).display !== 'none', t: document.getElementById('toast').textContent }));
  await sec(0.8); await page.keyboard.up('KeyI'); await sec(1.0);
  const afterShot = await page.evaluate(() => ({ shots: window.__court3d.shotsTaken || 0, free: window.__ball.session.free, meter: window.__court3d.meter?.phase, meterShown: getComputedStyle(document.getElementById('shotMeter')).display !== 'none', has: window.__court3d.player.hasBall, ball: window.__ball.state() }));
  check(toast.on && /No hoop in here/.test(toast.t), `□ → "${toast.t}"`);
  const shotTicks = (await ticksSince(m0)).filter((t) => t.shot);
  check(afterShot.shots === shots0 && !afterShot.free && (afterShot.meter === 'idle' || afterShot.meter == null) && !afterShot.meterShown && !shotTicks.length, 'no meter, no shot clip, no shot');
  check(afterShot.has, `the ball stays in play (${afterShot.ball})`);

  // ── moves, and a dropped ball ──
  console.log('moves');
  await walkTo(W.spawn.x + 2.5, W.spawn.z - 0.5, { maxS: 5 });
  const m1 = await recMark();
  const acts = new Set();
  for (const k of ['KeyO', 'KeyK', 'KeyL']) { await page.keyboard.press(k); for (let i = 0; i < 12; i++) { await frames(5); for (const t of await ticksSince(m1)) if (t.act) acts.add(t.act); } }
  await page.evaluate(() => window.__stick.reset());
  await page.keyboard.press('ArrowLeft'); await sec(0.2); await page.keyboard.press('ArrowRight'); await sec(1.6);
  const stickLog = await page.evaluate(() => window.__stick.log());
  notes.moves = [...acts]; notes.stick = stickLog;
  check(acts.size >= 2, `moves play in the loft (${[...acts].join(', ')})`);
  check(stickLog.length > 0 && stickLog.some((g) => !g.ignored), `the right stick's gestures are taken (${stickLog.map((g) => g.gesture + '→' + (g.role || g.ignored || '')).join(', ')})`);
  await sec(1.0);
  await page.evaluate(() => { const S = window.__court3d, P = S.player, f = [Math.sin(P.yaw), Math.cos(P.yaw)]; window.__ball.session.drop([P.pos[0] + f[0] * 0.8, 1.6, P.pos[1] + f[1] * 0.8]); });
  await sec(1.2);
  const loose = await page.evaluate(() => ({ has: window.__court3d.player.hasBall, s: window.__ball.state() }));
  await page.keyboard.press('KeyX'); await sec(0.6);
  const back = await page.evaluate(() => ({ has: window.__court3d.player.hasBall, s: window.__ball.state(), where: window.__loft.state().where }));
  check(!loose.has && back.has && back.where === 'loft', `a dropped ball comes back in the loft (${loose.s} → ${back.s})`);

  // ── the exit ──
  console.log('exit');
  await walkTo(W.exit.x, W.exit.z + 0.05, { tol: 0.3 });
  s = await st();
  const exitTxt = await page.evaluate(() => document.getElementById('doorPrompt').textContent);
  check(s.prompt === 'exit' && /Back to the court/.test(exitTxt), `at the exit: "${exitTxt}"`);
  // ✕ with no ball at the exit: through the door, not a new ball
  await page.evaluate(() => { const S = window.__court3d, P = S.player; window.__ball.session.drop([P.pos[0], 1.5, P.pos[1] - 0.8]); });
  await sec(0.5);
  await page.keyboard.press('KeyX'); await frames(4);
  const midFade = await page.evaluate(() => ({ s: window.__loft.state(), has: window.__court3d.player.hasBall }));
  check(midFade.s.trans === 'out' && !midFade.has, '✕ at the door goes through it and does nothing else (no new ball while the door fades)');
  for (let i = 0; i < 200; i++) { await frames(3); s = await st(); if (s.where === 'court' && !s.trans) break; }
  const after = await page.evaluate(() => ({ vis: window.__loft.courtVisible(), inScene: window.__loft.inScene(), env: window.__loft.env(), near: window.__loft.dbg().camera.near, far: window.__loft.dbg().camera.far, p: window.__court3d.player.pos.slice(), yaw: window.__court3d.player.yaw, has: window.__court3d.player.hasBall }));
  check(s.where === 'court' && !after.inScene, 'back on the court, the loft out of the scene');
  check(JSON.stringify(after.vis) === JSON.stringify(courtBefore.vis), `the court world restored (${after.vis})`);
  check(JSON.stringify(after.env) === JSON.stringify(courtBefore.env) && after.near === courtBefore.near && after.far === courtBefore.far, 'background, fog, environment, tone mapping, camera restored');
  const toHoop = Math.atan2(-after.p[0], -after.p[1]);
  check(Math.hypot(after.p[0] - door.x, after.p[1] - door.face - 0.95) < 0.35 && Math.abs(Math.atan2(Math.sin(after.yaw - toHoop), Math.cos(after.yaw - toHoop))) < 0.5 && after.has, `outside the door, facing the court, with the ball (${after.p.map((v) => v.toFixed(2))})`);
  await sec(0.8);
  await shot('4-back-on-court');
  // the court still shoots
  await walkTo(1.5, 4.5);
  const shotsC = await page.evaluate(() => window.__court3d.shotsTaken || 0);
  await page.keyboard.down('KeyI'); await sec(0.45); await page.keyboard.up('KeyI'); await sec(2.5);
  check((await page.evaluate(() => window.__court3d.shotsTaken || 0)) > shotsC, 'a shot on the court after the loft');

  // ── in again: cached (the prompt tapped) ──
  console.log('again');
  await sec(2.0);
  await walkTo(door.x + 0.4, door.z + 0.6);
  const req0 = glbRequests;
  await page.dispatchEvent('#doorPrompt', 'pointerdown');
  let fr = 0;
  for (; fr < 120; fr += 2) { await frames(2); s = await st(); if (s.where === 'loft' && !s.trans) break; }
  check(s.where === 'loft' && glbRequests === req0 && fr <= 40, `in again from cache (${fr} frames, ${glbRequests - req0} downloads)`);
  // and out again
  await walkTo(W.exit.x, W.exit.z + 0.05, { tol: 0.3 });
  await page.keyboard.press('KeyX');
  for (let i = 0; i < 200; i++) { await frames(3); s = await st(); if (s.where === 'court' && !s.trans) break; }
  check(s.where === 'court', 'out again');

  // ── every tick ──
  const all = await ticksSince(0), recs = await page.evaluate(() => window.__rec.recoveries);
  const R = 0.12;
  check(all.every((t) => t.y > R - 0.02), 'the ball never through the floor');
  check(!recs.length, `no ball recovery (${recs.join(', ')})`);
  check(!errors.length, `no console errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);

  if (failed.length) console.log('  (HTTP errors seen: ' + [...new Set(failed)].join(', ') + ')');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ fps: FPS, char: CHAR, gpu: SOFT ? 'swiftshader' : 'metal', fails, notes, errors, httpErrors: [...new Set(failed)] }, null, 1));
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed', '→', OUT);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
