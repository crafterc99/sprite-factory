#!/usr/bin/env node
/**
 * Visual test of the ball contact system on the real court (docs/ball-contact-system.md →
 * TESTING): court3d.html in Chromium (Playwright) with a virtual clock (exact frame steps),
 * driven by the keyboard like a player — idle dribble, jog, sprint, stop, change of direction,
 * crossover, a combo, and the recorded between-the-legs → cross → shot move — every frame
 * checked (state, floor, loss, recoveries, transitions, the character's own hand skin never more
 * than 3 mm into the ball) and filmed: a contact sheet of the move
 * seen from the side, plus one Ball Debug Mode shot per scenario. Both shots are taken with the
 * shot meter: I held, let go one frame before the clip's release frame (EXCELLENT) — the meter
 * shows, fills to its mark, grades the release, and the ball swishes.
 *
 *   node tests/ball-court.spec.js [--fps 30] [--char player] [--base http://localhost:3456]
 *
 * Needs the local server (bash mac-dev.sh) and the clip library (npm run clips:pull).
 * Writes tests/reports/ball-court/ (gitignored). Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'player'), BASE = opt('base', 'http://localhost:3456');
const OUT = path.join(__dirname, 'reports', 'ball-court', `${CHAR}-${FPS}fps`);
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
  }, { FPS });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  // (the between-the-legs → cross → shot move is the moving shot: focused so it is the only one there)
  await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=1&focus=mo-mulp87wqvabn`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
  const ready = await page.evaluate(() => !!window.__c3dReady && !!window.__ball);
  if (!ready) { console.error('court did not start', await page.evaluate(() => document.getElementById('err')?.textContent), errors); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
  await page.addStyleTag({ content: '#help,#vid{display:none!important}' });
  // a frame recorder in the page: every rendered frame's ball state
  await page.evaluate(() => {
    const S = window.__court3d, B = window.__ball.session;
    window.__rec = { frames: [], bounces: [], catches: [], recoveries: [] };
    const step = B.step.bind(B);
    B.step = function (...a) {
      const out = step(...a), C = this.ctl, T = this.lastTargets;
      // (dPalm: the ball's distance to the nearer palm target — a released shot leaves them)
      const dPalm = T ? Math.min(...['left', 'right'].map((h) => Math.hypot(out.p[0] - T[h].p[0], out.p[1] - T[h].p[1], out.p[2] - T[h].p[2]))) : null;
      // (hand: the deepest skin of either hand into the ball this frame, m — > 0 inside; null: no hand skin / both far)
      const Hd = this.lastHands ? ['left', 'right'].map((h) => this.lastHands[h]?.depth).filter((d) => d != null) : [];
      window.__rec.frames.push({ t: +this.t.toFixed(4), s: out.state, y: +out.p[1].toFixed(4), p: out.p.map((x) => +x.toFixed(3)), action: S.player.action?.clip?.name || null, at: S.player.action ? +S.player.action.t.toFixed(2) : null, dPalm: dPalm != null ? +dPalm.toFixed(3) : null, hand: Hd.length ? +Math.max(...Hd).toFixed(4) : null, skin: !!this.hc });
      for (const e of out.events) { if (e.type === 'bounce') window.__rec.bounces.push({ t: +e.t.toFixed(3), p: e.p.map((x) => +x.toFixed(3)) }); if (e.type === 'catch') window.__rec.catches.push({ t: +e.t.toFixed(3), hand: e.hand, err: +(e.err || 0).toFixed(3) }); if (e.type === 'recovery') window.__rec.recoveries.push({ t: +e.t.toFixed(3), reason: e.reason }); }
      return out;
    };
  });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const key = async (code, s) => { await page.keyboard.down(code); await sec(s); await page.keyboard.up(code); };
  const camSide = () => page.evaluate(() => { const S = window.__court3d, p = S.player.pos, y = S.player.yaw; S.camFixed = { pos: [p[0] + Math.cos(y) * 3.1, 1.05, p[1] - Math.sin(y) * 3.1], look: [p[0], 0.62, p[1]] }; });
  const camFree = () => page.evaluate(() => { window.__court3d.camFixed = null; });
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  await page.mouse.click(900, 420);
  await sec(1.0);

  const results = [];
  const check = async (name, from) => {
    const r = await page.evaluate((from) => { const R = window.__rec; return { frames: R.frames.slice(from), bounces: R.bounces.filter((b) => b.t >= (R.frames[from]?.t ?? 0)), catches: R.catches.filter((c) => c.t >= (R.frames[from]?.t ?? 0)), recoveries: R.recoveries.filter((c) => c.t >= (R.frames[from]?.t ?? 0)) }; }, from);
    const F = r.frames, minY = Math.min(...F.map((f) => f.y));
    const lost = F.filter((f) => f.s === 'LOOSE').length, rejected = await page.evaluate(() => window.__ball.session.ctl.rejected);
    // the hands never inside the ball: this character's own hand skin, every frame (≤ 3 mm)
    const skin = F.some((f) => f.skin), hd = F.filter((f) => f.hand != null), worst = hd.reduce((a, f) => (f.hand > a.hand ? f : a), { hand: -Infinity });
    const handMm = hd.length ? +(worst.hand * 1000).toFixed(1) : null, handOver3 = hd.filter((f) => f.hand > 0.003).length;
    const ok = minY >= 0.116 && !lost && !r.recoveries.length && !rejected && skin && handOver3 === 0;
    results.push({ name, ok, frames: F.length, minY: +minY.toFixed(4), lost, recoveries: r.recoveries, rejected, bounces: r.bounces.length, catches: r.catches.length, maxCatchErrCm: r.catches.length ? +(Math.max(...r.catches.map((c) => c.err)) * 100).toFixed(1) : 0, states: [...new Set(F.map((f) => f.s))], handSkin: skin, maxHandDepthMm: handMm, handDepthAt: hd.length ? { t: worst.t, s: worst.s, action: worst.action, at: worst.at } : null, handFramesOver3mm: handOver3 });
    return r;
  };
  const mark = () => page.evaluate(() => window.__rec.frames.length);
  const swishes = () => page.evaluate(() => window.__court3d.swishes || 0);
  /**
   * The shot meter on this frame (hold I, let go on its mark): the playing shot's clip time and
   * release frame, the meter's view, and whether the bar is on screen.
   */
  const meterNow = () => page.evaluate(() => {
    const S = window.__court3d, a = S.player.action, v = window.__shotMeter.view(), el = document.getElementById('shotMeter');
    return { mode: S.player.mode, a: a?.clip?.name || '', t: a?.t ?? null, rel: a?.clip?.shot?.releaseFrame ?? null, s: window.__ball.state(), gameT: S.gameT, v, shown: getComputedStyle(el).display === 'block', greenPx: el.querySelector('.sm-green').offsetHeight, fillPx: el.querySelector('.sm-fill').offsetHeight };
  });
  /** Hold I from now; let go once the shot clip is within `early` frames of its release frame (one frame early at 30 fps: EXCELLENT). */
  const meterShot = () => ({ held: true, up: null, rise: null, shownFrames: 0, maxGreenPx: 0, maxFill: 0, result: null });
  const meterFrame = async (ms, st, i, name, early = 1.25) => {
    if (st.shown) { ms.shownFrames++; ms.maxGreenPx = Math.max(ms.maxGreenPx, st.greenPx); ms.maxFill = Math.max(ms.maxFill, st.v.fill); }
    if (ms.rise == null && st.shown && st.v.fill > 0.4) { ms.rise = i; await shot(`${name}-meter-rise`); }
    if (ms.held && st.mode === 'action' && st.rel != null && st.t >= st.rel - early) { await page.keyboard.up('KeyI'); ms.held = false; ms.up = { i, clipT: st.t, rel: st.rel }; }
    if (ms.up && ms.up.i === i - 1) await shot(`${name}-meter-graded`);
    if (!ms.result && st.v.result) { ms.result = st.v.result; await shot(`${name}-meter-result`); }
  };
  /** The meter shot: shown while it rose (the green window on it), let go before the release frame → EXCELLENT, a make, the result shown. */
  const meterChecks = async (ms) => {
    const last = await page.evaluate(() => window.__shotMeter.last());
    const ok = !!last && last.label === 'EXCELLENT' && last.make && last.result === 'SWISH' && ms.shownFrames > 5 && ms.maxGreenPx > 0 && ms.maxFill > 0.7;
    return { ok, grade: last?.label, e: last?.e, outcome: last?.outcome, result: last?.result, shownFrames: ms.shownFrames, greenPx: ms.maxGreenPx, maxFill: +ms.maxFill.toFixed(2), letGo: ms.up };
  };
  /**
   * A shot really leaves the hands and goes in (the ball used to be launched inside the thrower's
   * own hands and fall at his feet): the release, the apex over 3.4 m, a swish, and the ball ≥ 20 cm
   * from the palms within 3 frames of the release.
   */
  const shotChecks = (r, sw0, sw1) => {
    const F = r.frames, i = F.findIndex((f) => f.s === 'SHOT_RELEASE');
    const rel = i >= 0 ? F[i] : null, after = i >= 0 ? F.slice(i, i + 4) : [];
    const leaves = after.some((f) => f.dPalm != null && f.dPalm >= 0.2);
    const apex = Math.max(0, ...F.filter((f) => f.s === 'SHOT_RELEASE').map((f) => f.y));
    return { ok: !!rel && apex > 3.4 && sw1 - sw0 >= 1 && leaves, release: rel && { t: rel.t, clipFrame: rel.at, clip: rel.action, p: rel.p }, apex: +apex.toFixed(2), swishes: sw1 - sw0, leavesPalmsCm: after.map((f) => f.dPalm != null ? Math.round(f.dPalm * 100) : null), flight: F.filter((f) => f.s === 'SHOT_RELEASE').filter((_, k) => k % 3 === 0).slice(0, 24).map((f) => [f.t, ...f.p]) };
  };

  // ── scenarios (keyboard: WASD move · Shift run · O crossover · K spin · I shoot)
  let m = await mark(); await sec(2); await camFree(); await shot('1-idle-dribble'); await check('idle dribble', m);
  // the idle dribble at 0.25× speed (the user's screenshot of the live court: fingers flaring off the ball in
  // the hold) — the hand's skin checked every frame (check()), close-ups of the hand on the ball
  m = await mark();
  await page.evaluate(() => { window.__court3d.speed = 0.25; });
  const closeUps = [];
  for (let i = 0; i < Math.round(3 * FPS) && closeUps.length < 6; i++) {
    await frames(1);
    const st = await page.evaluate(() => { const S = window.__court3d, B = window.__ball.session, p = B.ctl.p, y = S.player.yaw; return { s: B.state, p, y, hand: B.ctl.heldHand }; });
    if (/^HELD_/.test(st.s) && i % Math.max(1, Math.round(FPS / 3)) === 0) {
      // (a camera ~0.9 m from the ball, a little above it, on the dribbling hand's side)
      const side = st.hand === 'left' ? 1 : -1, c = Math.cos(st.y), sn = Math.sin(st.y);
      await page.evaluate(({ p, c, sn, side }) => { window.__court3d.camFixed = { pos: [p[0] + sn * 0.75 + c * 0.45 * side, p[1] + 0.25, p[2] + c * 0.75 - sn * 0.45 * side], look: p }; }, { p: st.p, c, sn, side });
      await frames(1);
      const f = path.join(OUT, `1b-idle-quarter-speed-hand-${closeUps.length}.png`);
      await page.screenshot({ path: f });
      closeUps.push(f);
    }
  }
  await page.evaluate(() => { window.__court3d.speed = 1; });
  await camFree();
  await check('idle dribble at 0.25× speed (hand close-ups)', m);
  m = await mark(); await key('KeyW', 2.2); await shot('2-jog'); await check('jog dribble', m);
  m = await mark(); await sec(0.8); await check('stop', m);
  m = await mark(); await page.keyboard.down('ShiftLeft'); await key('KeyS', 1.6); await page.keyboard.up('ShiftLeft'); await shot('3-sprint'); await check('sprint dribble', m);
  m = await mark(); await key('KeyA', 0.9); await key('KeyD', 0.9); await shot('4-change-direction'); await check('change of direction', m);
  m = await mark(); await sec(0.6); await page.keyboard.press('KeyO'); await sec(2.6); await shot('5-crossover'); await check('crossover', m);
  m = await mark(); await page.keyboard.press('KeyO'); await sec(0.3); await page.keyboard.press('KeyK'); await sec(3.2); await check('combo: crossover → spin', m);
  // the jump shot (□ standing: the user's own video) — released on its frame, straight back to idle
  // when the clip ends (no hold on the last frame), then the rebound is passed back and caught
  await sec(1.0); await camFree();
  m = await mark();
  let sw0 = await swishes();
  const js = { start: null, end: null, name: null, rel: null };
  // (the shot meter: I held from the press, let go one frame before the release frame)
  const jm = meterShot();
  await page.keyboard.down('KeyI');
  // (a made shot drops through, bounces under the hoop and is passed back: ~7 s)
  for (let i = 0; i < Math.round(8 * FPS); i++) {
    await frames(1);
    const st = await meterNow();
    if (st.mode === 'action' && /shot-jumper/.test(st.a) && js.start == null) { js.start = st.gameT; js.name = st.a; }
    if (js.start != null && js.end == null && st.mode === 'loco') js.end = st.gameT;
    await meterFrame(jm, st, i, '6a-jump-shot');
    if (js.rel == null && st.s === 'SHOT_RELEASE') { js.rel = i; await shot('6b-jump-shot-release'); }
    if (js.rel != null && i === js.rel + Math.round(0.4 * FPS)) await shot('6c-jump-shot-flight');
  }
  if (jm.held) await page.keyboard.up('KeyI');
  const jr = await check('jump shot (□ standing)', m);
  const jsShot = shotChecks(jr, sw0, await swishes());
  results[results.length - 1].shot = jsShot;
  results[results.length - 1].ok &&= jsShot.ok;
  const jsMeter = await meterChecks(jm);
  results[results.length - 1].meter = jsMeter;
  results[results.length - 1].ok &&= jsMeter.ok;
  const clipDur = await page.evaluate((n) => { const c = (window.__court3d.player.lib['shot-jumper:variants'] || [window.__court3d.player.lib['shot-jumper']]).find((x) => x && x.name === n); return c ? (c.F - 1) / c.fps : null; }, js.name);
  results[results.length - 1].jumpShot = { clip: js.name, seconds: js.end != null && js.start != null ? +(js.end - js.start).toFixed(2) : null, clipSeconds: clipDur && +clipDur.toFixed(2) };
  results[results.length - 1].ok &&= !!js.name && js.end != null && clipDur != null && js.end - js.start < clipDur + 0.15 && jr.catches.length >= 1;
  // the recorded move (□ on the move), filmed from the side
  await sec(1.0); await camSide();
  m = await mark();
  sw0 = await swishes();
  // (□ held on the move — the meter fills over the shot at the end of the move — let go on its mark)
  const bm = meterShot();
  await page.keyboard.down('KeyW'); await sec(0.25); await page.keyboard.down('KeyI'); await sec(0.1); await page.keyboard.up('KeyW');
  const sheet = [];
  for (let i = 0; i < Math.round(6.5 * FPS); i++) {
    await frames(1);
    const st = await meterNow();
    await meterFrame(bm, st, i, '7-btl-shot');
    if (/btl-cross/.test(st.a) && st.t >= 5 && st.t <= 30 && sheet.length < 24 && i % Math.max(1, Math.round(FPS / 15)) === 0) {
      const f = path.join(OUT, `move-${String(sheet.length).padStart(2, '0')}.png`);
      await page.screenshot({ path: f, clip: { x: 290, y: 90, width: 600, height: 560 } });
      sheet.push({ f, frame: +st.t.toFixed(1), state: st.s });
    }
  }
  const mv = await check('recorded between-the-legs → cross → shot', m);
  const moveBounces = mv.bounces.filter((b) => mv.frames.some((f) => /btl-cross/.test(f.action || '') && Math.abs(f.t - b.t) < 0.05));
  results[results.length - 1].moveBounces = moveBounces.length;
  results[results.length - 1].ok &&= moveBounces.length === 2;
  const mvShot = shotChecks(mv, sw0, await swishes());
  results[results.length - 1].shot = mvShot;
  results[results.length - 1].ok &&= mvShot.ok;
  if (bm.held) await page.keyboard.up('KeyI');
  const mvMeter = await meterChecks(bm);
  results[results.length - 1].meter = mvMeter;
  results[results.length - 1].ok &&= mvMeter.ok;
  fs.writeFileSync(path.join(OUT, 'sheet.json'), JSON.stringify(sheet, null, 1));
  const report = { fps: FPS, char: CHAR, errors, results, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(42)}${r.jumpShot ? ` [${r.jumpShot.clip}: back to idle after ${r.jumpShot.seconds} s of a ${r.jumpShot.clipSeconds} s clip]` : ''}${r.shot ? ` [shot: released at clip frame ${r.shot.release?.clipFrame}, apex ${r.shot.apex} m, swishes ${r.shot.swishes}, palms ${r.shot.leavesPalmsCm.join('→')} cm]` : ''}${r.meter ? ` [meter: ${r.meter.grade} (${r.meter.e != null ? Math.round(r.meter.e * 1000) + ' ms' : '—'}) → ${r.meter.result}, shown ${r.meter.shownFrames} frames]` : ''} frames ${String(r.frames).padStart(4)} · bounces ${r.bounces}${r.moveBounces != null ? ` (in the move ${r.moveBounces})` : ''} · catches ${r.catches} (max err ${r.maxCatchErrCm} cm) · min y ${r.minY} · lost ${r.lost} · recoveries ${r.recoveries.length} · rejected ${r.rejected} · hands ${r.handSkin ? (r.maxHandDepthMm == null ? 'far' : `${r.maxHandDepthMm > 0 ? r.maxHandDepthMm + ' mm in' : -r.maxHandDepthMm + ' mm clear'} (${r.handFramesOver3mm} frames > 3 mm)`) : 'NO HAND SKIN'}`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('report + screenshots:', OUT);
  await browser.close();
  process.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1);
})();
