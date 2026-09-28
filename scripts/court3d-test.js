#!/usr/bin/env node
/**
 * 3D Court check (court3d.html + engine3d/anim3d.mjs) in headless Chromium
 * (software WebGL).
 *
 *   SF_PASSWORD=... node scripts/court3d-test.js --base <url> --out ./c3d [--relay] [--char big]
 *
 * Checks: the skinned character loads and renders; the idle dribble ball
 * really bounces (floor → hand); moving with W/A/S/D translates the player,
 * who keeps facing the basket while the feet plant (world foot slide of
 * planted feet measured by the runtime, cm); holding I plays the shot — the
 * ball leaves the hand, reaches the rim (SWISH) and the player returns to the
 * dribble; no page errors.
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
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, ...(PW ? { extraHTTPHeaders: { Authorization: `Bearer ${PW}` } } : {}) });
  if (args.relay) {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().startsWith(BASE)) return route.abort();
      for (let a = 0; ; a++) {
        try {
          const res = await fetch(req.url(), { method: req.method(), headers: { ...req.headers(), ...(PW ? { authorization: `Bearer ${PW}` } : {}) }, redirect: 'manual' });
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
  const q = args.char ? `?char=${encodeURIComponent(args.char)}` : '';
  await page.goto(`${BASE}/court3d${q}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__court3d?.player || document.getElementById('err')?.textContent, null, { timeout: 180000 });
  const err = await page.evaluate(() => document.getElementById('err').textContent);
  if (!(await page.evaluate(() => !!window.__court3d?.player))) { console.log(JSON.stringify({ pass: false, loadError: err, errors })); await browser.close(); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.mouse.click(600, 400);
  await page.evaluate(() => { const p = window.__court3d.player; p.metrics.slideMaxCm = 0; p.metrics.popMax = 0; });

  const rep = { errors };
  rep.loaded = await page.evaluate(() => {
    const S = window.__court3d;
    return { char: S.rig.name, verts: S.rig.vertexCount, clips: Object.keys(S.player.lib).filter((k) => !k.endsWith(':mirror')), hand: S.player.hand, fps: document.getElementById('fps').textContent };
  });
  await page.screenshot({ path: path.join(OUT, '1-idle.png') });

  // Idle dribble: sample the ball height + feet for a few seconds
  const idle = await page.evaluate(async () => {
    const out = []; const t0 = performance.now();
    await new Promise((res) => { const f = () => { out.push(window.__ballProbe()); if (performance.now() - t0 < 5000) requestAnimationFrame(f); else res(); }; f(); });
    return { ys: out, slide: window.__court3d.player.metrics.slideMaxCm };
  });
  rep.dribble = { samples: idle.ys.length, minY: +Math.min(...idle.ys).toFixed(3), maxY: +Math.max(...idle.ys).toFixed(3), bouncesToFloor: Math.min(...idle.ys) < 0.2, backToHand: Math.max(...idle.ys) > 0.6, idleSlideCm: +idle.slide.toFixed(2) };

  // Move: each direction for 1.5 s, then stop
  const moves = {};
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    const p0 = await page.evaluate(() => { const p = window.__court3d.player; p.metrics.slideMaxCm = 0; return p.pos.slice(); });
    await page.keyboard.down(k); await page.waitForTimeout(1500);
    const mid = await page.evaluate(() => document.getElementById('state').textContent);
    await page.keyboard.up(k); await page.waitForTimeout(900);
    const p1 = await page.evaluate(() => { const S = window.__court3d, p = S.player; return { pos: p.pos.slice(), yaw: p.yaw, slide: p.metrics.slideMaxCm }; });
    const faceErr = Math.abs(((p1.yaw - Math.atan2(-p1.pos[0], -p1.pos[1])) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    moves[k] = { movedM: +Math.hypot(p1.pos[0] - p0[0], p1.pos[1] - p0[1]).toFixed(2), state: mid, faceErrRad: +faceErr.toFixed(3), slideCm: +p1.slide.toFixed(2) };
  }
  rep.move = moves;
  await page.screenshot({ path: path.join(OUT, '2-moved.png') });

  // Feel + moves (only when the clips exist): run-dribble, crossovers picked by the matcher, stops
  const lib = await page.evaluate(() => Object.keys(window.__court3d.player.lib).filter((k) => !k.includes(':')));
  rep.feel = {};
  if (lib.includes('move-crossover')) {
    const picks = [];
    const cross = async (label) => {
      await page.evaluate(() => { window.__court3d.lastPick = null; window.__court3d.player.metrics.slideMaxCm = 0; });
      const hand0 = await page.evaluate(() => window.__court3d.player.hand);
      const tp = Date.now();
      await page.keyboard.press('KeyO');
      await page.waitForFunction(() => window.__court3d.lastPick, null, { timeout: 3000 }).catch(() => {});
      const latencyMs = Date.now() - tp;
      const pk = await page.evaluate(() => { const S = window.__court3d, p = S.player; return { pick: S.lastPick ? { clip: S.lastPick.clip, mirror: S.lastPick.mirror, frame: S.lastPick.entry, of: S.lastPick.variants } : null, mode: p.mode }; });
      await page.waitForFunction(() => window.__court3d.player.mode === 'loco', null, { timeout: 6000 }).catch(() => {});
      const after = await page.evaluate(() => ({ hand: window.__court3d.player.hand, mode: window.__court3d.player.mode, slide: window.__court3d.player.metrics.slideMaxCm }));
      pk.hand = hand0; pk.latencyMs = latencyMs;
      picks.push({ label, ...pk, handAfter: after.hand, modeAfter: after.mode, slideCm: +after.slide.toFixed(2) });
    };
    await page.waitForFunction(() => window.__court3d.player.mode === 'loco' && Math.hypot(...window.__court3d.player.vel) < 0.1, null, { timeout: 4000 }).catch(() => {});
    await cross('standing');
    await page.waitForTimeout(600);
    // moving: across the court (away from the stanchion, so no collision pushes the player)
    await page.keyboard.down('KeyD'); await page.waitForTimeout(900);
    await cross('moving');
    await page.keyboard.up('KeyD'); await page.waitForTimeout(800);
    rep.feel.crossovers = picks;
  }
  // sprint (run-dribble) then let go: slide-in stop
  await page.evaluate(() => { const p = window.__court3d.player; p.teleport(0, 2.5); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__court3d.player.metrics.slideMaxCm = 0; });
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyS');
  await page.waitForTimeout(1600);
  const run = await page.evaluate(() => { const S = window.__court3d, p = S.player; return { label: document.getElementById('state').textContent, speed: Math.hypot(...p.vel), runFace: p.runFace, source: p.source, pos: p.pos.slice() }; });
  await page.screenshot({ path: path.join(OUT, '2b-run.png') });
  await page.keyboard.up('KeyS'); await page.keyboard.up('ShiftLeft');
  const stopSeq = [];
  const tS = Date.now();
  while (Date.now() - tS < 1200) { stopSeq.push(await page.evaluate(() => ({ label: document.getElementById('state').textContent, v: Math.hypot(...window.__court3d.player.vel), pos: window.__court3d.player.pos.slice() }))); await page.waitForTimeout(50); }
  const last = stopSeq[stopSeq.length - 1];
  rep.feel.run = { ...run, speed: +run.speed.toFixed(2), runFace: +run.runFace.toFixed(2) };
  rep.feel.stop = { labels: [...new Set(stopSeq.map((x) => x.label))], slideInM: +Math.hypot(last.pos[0] - run.pos[0], last.pos[1] - run.pos[1]).toFixed(2), stopped: last.v < 0.1, slideCm: +(await page.evaluate(() => window.__court3d.player.metrics.slideMaxCm)).toFixed(2) };
  await page.evaluate(() => { window.__court3d.player.teleport(1.8, 5.2); });
  await page.waitForTimeout(900);

  // Shot: hold I
  await page.evaluate(() => { window.__court3d.player.metrics.slideMaxCm = 0; });
  await page.keyboard.down('KeyI'); await page.waitForTimeout(300); await page.keyboard.up('KeyI');
  const seq = []; let shots = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const s = await page.evaluate(() => { const S = window.__court3d, p = S.player; return { mode: p.mode, role: p.action?.role || null, t: p.action ? +p.action.t.toFixed(1) : null, label: document.getElementById('state').textContent, free: !!S.freeBall }; });
    seq.push(s);
    if ((s.mode === 'action' && shots === 0 && s.t > 10) || (s.free && shots === 1)) await page.screenshot({ path: path.join(OUT, `3-shot-${++shots}.png`) });
    if (s.mode === 'loco' && seq.some((x) => x.mode === 'action') && !s.free) break;
    await page.waitForTimeout(60);
  }
  const shotSlide = await page.evaluate(() => window.__court3d.player.metrics.slideMaxCm);
  const swishes = await page.evaluate(() => window.__court3d.swishes || 0);
  rep.shot = {
    started: seq.some((x) => x.mode === 'action'), role: (seq.find((x) => x.role) || {}).role || null,
    released: seq.some((x) => x.free), swish: swishes > 0 || seq.some((x) => x.label === 'SWISH'),
    backToDribble: seq[seq.length - 1]?.mode === 'loco', slideCm: +shotSlide.toFixed(2),
  };
  await page.screenshot({ path: path.join(OUT, '4-after.png') });
  rep.popMax = await page.evaluate(() => +window.__court3d.player.metrics.popMax.toFixed(0));
  const mv = Object.values(rep.move);
  const feelOk = (!rep.feel.crossovers || rep.feel.crossovers.every((c) => c.pick && c.handAfter !== c.hand && c.slideCm < 3))
    && rep.feel.run.speed > 3 && rep.feel.stop.stopped && rep.feel.stop.slideCm < 3;
  rep.pass = !errors.length && feelOk && rep.dribble.bouncesToFloor && rep.dribble.backToHand && rep.dribble.idleSlideCm < 1
    && mv.every((m) => m.movedM > 0.5 && m.faceErrRad < 0.1 && m.slideCm < 2)
    && rep.shot.started && rep.shot.released && rep.shot.swish && rep.shot.backToDribble && rep.shot.slideCm < 3;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep, null, 1));
  await browser.close();
  process.exit(rep.pass ? 0 : 1);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
