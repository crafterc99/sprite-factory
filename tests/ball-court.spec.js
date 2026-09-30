#!/usr/bin/env node
/**
 * Visual test of the ball contact system on the real court (docs/ball-contact-system.md →
 * TESTING): court3d.html in Chromium (Playwright) with a virtual clock (exact frame steps),
 * driven by the keyboard like a player — idle dribble, jog, sprint, stop, change of direction,
 * crossover, a combo, and the recorded between-the-legs → cross → shot move — every frame
 * checked (state, floor, loss, recoveries, transitions) and filmed: a contact sheet of the move
 * seen from the side, plus one Ball Debug Mode shot per scenario.
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
  await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=1`, { waitUntil: 'load', timeout: 90000 });
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
      const out = step(...a), C = this.ctl;
      window.__rec.frames.push({ t: +this.t.toFixed(4), s: out.state, y: +out.p[1].toFixed(4), p: out.p.map((x) => +x.toFixed(3)), action: S.player.action?.clip?.name || null, at: S.player.action ? +S.player.action.t.toFixed(2) : null });
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
    const ok = minY >= 0.116 && !lost && !r.recoveries.length && !rejected;
    results.push({ name, ok, frames: F.length, minY: +minY.toFixed(4), lost, recoveries: r.recoveries, rejected, bounces: r.bounces.length, catches: r.catches.length, maxCatchErrCm: r.catches.length ? +(Math.max(...r.catches.map((c) => c.err)) * 100).toFixed(1) : 0, states: [...new Set(F.map((f) => f.s))] });
    return r;
  };
  const mark = () => page.evaluate(() => window.__rec.frames.length);

  // ── scenarios (keyboard: WASD move · Shift run · O crossover · K spin · I shoot)
  let m = await mark(); await sec(2); await camFree(); await shot('1-idle-dribble'); await check('idle dribble', m);
  m = await mark(); await key('KeyW', 2.2); await shot('2-jog'); await check('jog dribble', m);
  m = await mark(); await sec(0.8); await check('stop', m);
  m = await mark(); await page.keyboard.down('ShiftLeft'); await key('KeyS', 1.6); await page.keyboard.up('ShiftLeft'); await shot('3-sprint'); await check('sprint dribble', m);
  m = await mark(); await key('KeyA', 0.9); await key('KeyD', 0.9); await shot('4-change-direction'); await check('change of direction', m);
  m = await mark(); await sec(0.6); await page.keyboard.press('KeyO'); await sec(2.6); await shot('5-crossover'); await check('crossover', m);
  m = await mark(); await page.keyboard.press('KeyO'); await sec(0.3); await page.keyboard.press('KeyK'); await sec(3.2); await check('combo: crossover → spin', m);
  // the recorded move, filmed from the side
  await sec(1.0); await camSide();
  m = await mark();
  await page.keyboard.press('KeyI');
  const sheet = [];
  for (let i = 0; i < Math.round(4.2 * FPS); i++) {
    await frames(1);
    const st = await page.evaluate(() => ({ a: window.__court3d.player.action?.clip?.name || '', t: window.__court3d.player.action?.t ?? -1, s: window.__ball.state() }));
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
  fs.writeFileSync(path.join(OUT, 'sheet.json'), JSON.stringify(sheet, null, 1));
  const report = { fps: FPS, char: CHAR, errors, results, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(42)} frames ${String(r.frames).padStart(4)} · bounces ${r.bounces}${r.moveBounces != null ? ` (in the move ${r.moveBounces})` : ''} · catches ${r.catches} (max err ${r.maxCatchErrCm} cm) · min y ${r.minY} · lost ${r.lost} · recoveries ${r.recoveries.length} · rejected ${r.rejected}`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('report + screenshots:', OUT);
  await browser.close();
  process.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1);
})();
