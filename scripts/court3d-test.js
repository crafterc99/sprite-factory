#!/usr/bin/env node
/**
 * 3D Court sandbox check (court3d.html) in headless Chromium (software WebGL).
 *
 *   SF_PASSWORD=... node scripts/court3d-test.js --base <url> --out ./c3d [--relay]
 *
 * Checks: loads + renders, the idle dribble ball really bounces (reaches the
 * floor and comes back to the hand), WASD moves the player while they keep
 * facing the basket, holding I plays the step-back jumper, the ball leaves the
 * hand, reaches the rim (SWISH) and the player returns to idle.
 * --relay serves every request through Node's fetch (flaky sandbox networks).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (args.base || 'http://localhost:3456').replace(/\/$/, '');
const OUT = args.out || path.join(process.cwd(), 'court3d-test');
const PW = process.env.SF_PASSWORD || '';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, ...(PW ? { extraHTTPHeaders: { Authorization: `Bearer ${PW}` } } : {}) });
  if (args.relay) {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().startsWith(BASE) && !req.url().startsWith('https://cdn.jsdelivr.net/')) return route.abort();
      for (let a = 0; ; a++) {
        try {
          const res = await fetch(req.url(), { method: req.method(), headers: { ...req.headers(), ...(PW && req.url().startsWith(BASE) ? { authorization: `Bearer ${PW}` } : {}) }, redirect: 'manual' });
          const body = Buffer.from(await res.arrayBuffer());
          const headers = {}; res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = v; });
          return await route.fulfill({ status: res.status, headers, body });
        } catch (e) { if (a >= 3) return route.abort(); await new Promise((r) => setTimeout(r, 600 * (a + 1))); }
      }
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(`${BASE}/court3d`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__court3d?.idle, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.mouse.click(600, 400);

  const rep = { errors };
  rep.loaded = await page.evaluate(() => ({ idle: __court3d.idle.meta.name, idleFrames: __court3d.idle.meta.frameCount, move: __court3d.move.meta.name, moveFrames: __court3d.move.meta.frameCount, verts: __court3d.idle.meta.vertexCount, fps: document.getElementById('fps').textContent }));
  await page.screenshot({ path: path.join(OUT, '1-idle.png') });

  // Idle dribble: sample the ball height for 3 s
  const ballYs = await page.evaluate(async () => {
    const out = []; const t0 = performance.now();
    await new Promise((res) => { const f = () => { out.push(window.__ballProbe ? window.__ballProbe() : null); if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(); }; f(); });
    return out.filter((v) => v != null);
  });
  const minY = Math.min(...ballYs), maxY = Math.max(...ballYs);
  rep.dribble = { samples: ballYs.length, minY: +minY.toFixed(3), maxY: +maxY.toFixed(3), bouncesToFloor: minY < 0.2, backToHand: maxY > 0.6 };

  // Move: W for 1 s → position changes, still facing the basket
  const p0 = await page.evaluate(() => [__court3d.pos.x, __court3d.pos.z]);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1000);
  const mid = await page.evaluate(() => ({ state: document.getElementById('state').textContent }));
  await page.keyboard.up('KeyW');
  const p1 = await page.evaluate(() => ({ pos: [__court3d.pos.x, __court3d.pos.z], yaw: __court3d.yaw, faceErr: Math.abs(((__court3d.yaw - Math.atan2(-__court3d.pos.x, -__court3d.pos.z)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) }));
  rep.move = { movedM: +Math.hypot(p1.pos[0] - p0[0], p1.pos[1] - p0[1]).toFixed(2), stateWhileMoving: mid.state, facesHoopErrRad: +p1.faceErr.toFixed(3) };
  await page.screenshot({ path: path.join(OUT, '2-moved.png') });

  // Shot: hold I
  await page.keyboard.down('KeyI'); await page.waitForTimeout(300); await page.keyboard.up('KeyI');
  const seq = []; let swish = false, shots = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const s = await page.evaluate(() => ({ st: __court3d.state, label: document.getElementById('state').textContent, f: +__court3d.clipT.toFixed(1), free: !!__court3d.freeBall, by: __court3d.freeBall ? +__court3d.freeBall.p.y.toFixed(2) : null }));
    seq.push(s);
    if (s.label === 'SWISH') swish = true;
    if ((s.st === 'shot' && shots === 0 && s.f > 12) || (s.free && shots === 1)) { await page.screenshot({ path: path.join(OUT, `3-shot-${++shots}.png`) }); }
    if (s.st === 'idle' && seq.some((q) => q.st === 'shot') && !s.free) break;
    await page.waitForTimeout(80);
  }
  rep.shot = {
    started: seq.some((q) => q.st === 'shot'), released: seq.some((q) => q.free), swish,
    reachedFrame: Math.max(...seq.filter((q) => q.st !== 'idle').map((q) => q.f), 0), backToIdle: seq[seq.length - 1]?.st === 'idle',
  };
  await page.screenshot({ path: path.join(OUT, '4-after.png') });
  rep.pass = !errors.length && rep.dribble.bouncesToFloor && rep.dribble.backToHand && rep.move.movedM > 0.5 && rep.move.facesHoopErrRad < 0.05
    && rep.shot.started && rep.shot.released && rep.shot.swish && rep.shot.backToIdle;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep, null, 1));
  await browser.close();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
