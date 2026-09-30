#!/usr/bin/env node
/**
 * Visual test of the outfit (engine3d/garments.mjs) on the real court: court3d.html in Chromium
 * (Playwright) with a virtual clock (exact frame steps), AC wearing the baggy tee + mesh shorts,
 * driven by the keyboard like a player — standing, jogging, sprinting, stopping, a crossover, the
 * shot — with a camera that follows him. Writes close-ups from the front / side / back, a contact
 * sheet of the fabric swinging as he sprints and stops, and the outfit picker; checks every frame
 * for page errors and that the fabric never resets mid-play.
 *
 *   node tests/outfit-court.spec.js [--fps 30] [--char ac-001] [--outfit tee:0,shorts:0] [--base http://localhost:3456]
 *
 * Needs the local server (bash mac-dev.sh) and the clip library (npm run clips:pull).
 * Writes tests/reports/outfit-court/ (gitignored). Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), OUTFIT = opt('outfit', 'tee:0,shorts:0'), BASE = opt('base', 'http://localhost:3456');
const OUT = path.join(__dirname, 'reports', 'outfit-court', `${CHAR}-${OUTFIT.replace(/[^a-z0-9]+/gi, '_')}-${FPS}fps`);
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
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
    try { localStorage.clear(); } catch {}
  }, { FPS });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`${BASE}/court3d.html?char=${CHAR}&outfit=${OUTFIT}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
  if (!(await page.evaluate(() => !!window.__c3dReady))) { console.error('court did not start', errors); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
  await page.evaluate(() => window.__outfitReady);
  const worn = await page.evaluate(() => window.__outfit.state());
  await page.addStyleTag({ content: '#help,#vid,#toast{display:none!important}' });
  // a camera that follows the player: 'front' | 'side' | 'back' | '34' at a distance, every frame
  await page.evaluate(() => {
    const S = window.__court3d;
    window.__cam = null;
    const follow = () => {
      const c = window.__cam;
      if (c) {
        const p = S.player.pos, y = S.player.yaw, a = y + c.ang, d = c.dist;
        S.camFixed = { pos: [p[0] + Math.sin(a) * d, c.h, p[1] + Math.cos(a) * d], look: [p[0], c.look, p[1]] };
      }
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  });
  const cam = (view, dist = 2.6, h = 1.25, look = 1.05) => page.evaluate((c) => { window.__cam = c; }, { ang: { front: 0, side: Math.PI / 2, back: Math.PI, '34': Math.PI / 4 }[view], dist, h, look });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const shot = (name, clip) => page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000, animations: 'allow', caret: 'initial', ...(clip ? { clip } : {}) });
  const CLIP = { x: 300, y: 120, width: 500, height: 600 };
  const results = [];
  const check = async (name) => {
    const st = await page.evaluate(() => window.__outfit.state());
    const ok = st.length === worn.length && st.every((w) => w.resets <= 3 && Number.isFinite(w.maxOffset));
    results.push({ name, ok, state: st });
  };
  await page.mouse.click(900, 420);

  // 1. standing: the fabric settles and rests on him — four sides
  await sec(1.5);
  for (const v of ['front', '34', 'side', 'back']) { await cam(v); await sec(0.35); await shot(`1-stand-${v}`, CLIP); }
  await check('standing');
  // 2. jog toward the hoop, filmed from the side
  await cam('side', 3.0);
  await page.keyboard.down('KeyW'); await sec(1.6); await shot('2-jog-side', CLIP); await page.keyboard.up('KeyW');
  await check('jog');
  // 3. sprint + stop: the contact sheet of the fabric swinging and settling
  const sheet = [];
  await cam('side', 3.0);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyA');
  for (let i = 0; i < Math.round(1.4 * FPS); i++) { await frames(1); if (i % Math.max(1, Math.round(FPS / 6)) === 0) { const f = path.join(OUT, `sheet-${String(sheet.length).padStart(2, '0')}.png`); await shot(`sheet-${String(sheet.length).padStart(2, '0')}`, CLIP); sheet.push({ f, phase: 'sprint' }); } }
  await page.keyboard.up('KeyA'); await page.keyboard.up('ShiftLeft');
  for (let i = 0; i < Math.round(1.2 * FPS); i++) { await frames(1); if (i % Math.max(1, Math.round(FPS / 6)) === 0) { await shot(`sheet-${String(sheet.length).padStart(2, '0')}`, CLIP); sheet.push({ phase: 'stop' }); } }
  await check('sprint + stop');
  // 4. crossover + the shot (front / 3-4)
  await cam('34', 2.8);
  await page.keyboard.press('KeyO'); await sec(0.5); await shot('4-crossover', CLIP); await sec(1.6);
  await check('crossover');
  await cam('front', 3.2, 1.4, 1.3);
  await page.keyboard.press('KeyI'); await sec(0.55); await shot('5-shot-rise', CLIP); await sec(0.35); await shot('5-shot-release', CLIP); await sec(2.0);
  await check('shot');
  // 5. the outfit picker (colours) — a black tee, red shorts
  // (clicked in the page: Playwright's "stable" wait needs animation frames, which the virtual clock holds)
  await page.evaluate(() => document.getElementById('outfitBtn').click()); await sec(0.1);
  if (!(await page.evaluate(() => getComputedStyle(document.getElementById('outfitPanel')).display === 'block'))) results.push({ name: 'picker opens', ok: false, state: [] });
  await page.evaluate(() => { window.__outfit.color('top', 1); window.__outfit.color('bottom', 1); });
  await cam('34', 2.6); await sec(0.8);
  await shot('6-picker');
  await check('colours');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ fps: FPS, char: CHAR, outfit: OUTFIT, worn, errors, results, sheet: sheet.length, at: new Date().toISOString() }, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(16)} ${r.state.map((w) => `${w.id} offset ≤ ${(w.maxOffset * 100).toFixed(1)} cm · resets ${w.resets} · steps ${w.steps}`).join(' | ')}`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('screenshots:', OUT);
  await browser.close();
  process.exit(results.every((r) => r.ok) && !errors.length && worn.length ? 0 : 1);
})();
