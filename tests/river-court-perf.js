#!/usr/bin/env node
/**
 * What the River practice court costs (court3d.html ?court=river): a real clock (no virtual one), the Mac's GPU
 * (Metal). Per setup — desktop at 1× and 2× pixels (the planar reflection on), the lite path (?lite=1: no reflection,
 * the smaller shadow map, ≤ 1.5× pixels — what an iPad gets), and VANTHEAH at 1× for comparison — in the game's own
 * 2K view and from the reference camera:
 *   fps         frames drawn per second over 5 s (the browser caps it at the display's 60)
 *   frame ms    what a frame really costs, uncapped: 4 frames drawn back to back and waited for on the GPU (a
 *               1-pixel read back), ÷ 4 — the median of 30 (1000 / ms ≈ the fps it could reach; the game's own frame
 *               queued before them makes it a slight overestimate)
 *   calls / tris  draw calls and triangles of a whole frame (shadow + reflection + picture) and of the picture alone
 *
 * (?adapt=0: the page's own step down to 1× pixels is off — the frame-cost loop's extra frames would trigger it.)
 *
 *   node tests/river-court-perf.js [--char ac-001] [--base http://localhost:3456]
 *
 * Writes tests/reports/river-court/perf.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const CHAR = opt('char', 'ac-001'), BASE = opt('base', 'http://localhost:3456');
const OUT = path.join(__dirname, 'reports', 'river-court');
fs.mkdirSync(OUT, { recursive: true });

const SETUPS = [
  { name: 'river desktop 1×', q: 'court=river', vp: { width: 1280, height: 720 }, dpr: 1 },
  { name: 'river desktop 2× (Retina)', q: 'court=river', vp: { width: 1280, height: 720 }, dpr: 2 },
  { name: 'river lite (iPad path)', q: 'court=river&lite=1', vp: { width: 1180, height: 820 }, dpr: 2, touch: true },
  { name: 'VANTHEAH desktop 1× (for comparison)', q: 'court=vantheah', vp: { width: 1280, height: 720 }, dpr: 1 },
];

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const out = [];
  for (const S of SETUPS) {
    const ctx = await browser.newContext({ viewport: S.vp, deviceScaleFactor: S.dpr, hasTouch: !!S.touch, isMobile: !!S.touch });
    await ctx.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('court3d_vid', JSON.stringify({ on: false })); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/court3d.html?${S.q}&char=${CHAR}&loftpreload=0&adapt=0`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
    await page.waitForFunction(() => window.__court3d?.loadingRest === 0, null, { timeout: 180000 });
    await page.waitForTimeout(2500);   // (shaders, textures settled; the lite path may drop to 1× pixels by itself)
    const measure = () => page.evaluate(async () => {
      const { renderer, scene, camera } = window.__loft.dbg();
      // fps: frames drawn in 5 s
      const fps = await new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 5000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); });
      // frame ms: one frame drawn and finished on the GPU
      const gl = renderer.getContext(), px = new Uint8Array(4), ms = [];
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // (the game's frame done first)
        const t = performance.now(); for (let k = 0; k < 4; k++) renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ms.push((performance.now() - t) / 4);
      }
      ms.sort((a, b) => a - b);
      const cost = window.__river ? window.__river.frameCost() : (() => { const info = renderer.info; info.autoReset = false; info.reset(); renderer.render(scene, camera); const r = { all: { calls: info.render.calls, triangles: info.render.triangles } }; info.autoReset = true; return r; })();
      return { fps: +fps.toFixed(1), frameMs: { mean: +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2), median: +ms[15].toFixed(2), p90: +ms[27].toFixed(2) }, pixelRatio: renderer.getPixelRatio(), canvas: [renderer.domElement.width, renderer.domElement.height], ...cost };
    });
    const r = { setup: S.name, game: await measure() };
    if (await page.evaluate(() => !!window.__river)) {
      await page.evaluate(() => window.__river.view(window.__river.renderCamera()));
      await page.waitForTimeout(500);
      r.reference = await measure();
      await page.evaluate(() => window.__river.view(null));
      r.stats = await page.evaluate(() => { const s = window.__river.stats(); return { tris: s.tris, instanced: s.instanced, reflector: s.reflector, shadow: window.__river.dbg().court.sun.shadow.mapSize.toArray() }; });
    }
    r.errors = errors;
    out.push(r);
    console.log(`${S.name.padEnd(38)} 2K view: ${r.game.fps} fps · frame ${r.game.frameMs.median} ms (≈${Math.round(1000 / r.game.frameMs.median)} fps uncapped) · ${r.game.all.calls} calls / ${(r.game.all.triangles / 1e6).toFixed(2)} M tris${r.game.picture ? ` (picture ${r.game.picture.calls} / ${(r.game.picture.triangles / 1e6).toFixed(2)} M)` : ''} · ${r.game.canvas.join('×')} px${r.reference ? `  |  reference view: ${r.reference.fps} fps · ${r.reference.frameMs.median} ms · ${r.reference.all.calls} calls / ${(r.reference.all.triangles / 1e6).toFixed(2)} M tris` : ''}`);
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify({ at: new Date().toISOString(), char: CHAR, gpu: 'metal (Apple M1)', results: out }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
