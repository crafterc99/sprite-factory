#!/usr/bin/env node
/**
 * In-game checks of the VANTHEAH practice court (court3d.html, default court):
 * player scale and foot contact, dribble height, rim + backboard collision
 * (physical ball thrown at them), a shot through the rim, full-court
 * navigation and bounds. State-driven (waits on the game, not the clock), so it
 * also runs under software WebGL at a few fps.
 *
 *   node scripts/court-vantheah-check.js [--base http://localhost:3456] [--out dir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (args.base || 'http://localhost:3456').replace(/\/$/, '');
const OUT = args.out || path.join(process.cwd(), 'court3d-test');
const PW = process.env.SF_PASSWORD || '';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 500 }, extraHTTPHeaders: PW ? { Authorization: `Bearer ${PW}` } : {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400 && !/\/frame\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/court3d.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || document.getElementById('err')?.textContent, null, { timeout: 240000 });
  await page.waitForFunction(() => window.__court3d?.loadingRest === 0, null, { timeout: 240000 }).catch(() => {});
  const rep = { errors };
  rep.court = await page.evaluate(() => ({ loaded: !!window.__court3d.court, colliders: window.__court3d.courtColliders?.count || 0 }));

  // game-state helpers (run in the page)
  const frames = (n) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const snap = () => page.evaluate(() => {
    const S = window.__court3d, ph = S.phys, P = S.player, W = P.world;
    return { pos: P.pos.slice(), ball: ph.cur.p.slice(), state: ph.state, lost: ph.lost, free: S.freeBall?.kind || null, poseY: Array.from({ length: 70 }, (_, i) => W[i * 3 + 1]) };
  });
  await frames(30);

  // 1. scale + foot contact (idle, a few frames)
  const s1 = [];
  for (let i = 0; i < 8; i++) { await frames(3); s1.push(await snap()); }
  // the runtime's world joints (MHR70 keypoints): the lowest are the heels / toes, the highest the eyes / ears
  const lows = s1.map((s) => Math.min(...s.poseY)), highs = s1.map((s) => Math.max(...s.poseY));
  rep.scale = { topJointM: +Math.max(...highs).toFixed(3) };
  rep.feet = { lowestJointM: +Math.min(...lows).toFixed(3), highestLowestJointM: +Math.max(...lows).toFixed(3) };

  // 2. dribble height (idle dribble, sampled over several cycles)
  const ys = [];
  for (let i = 0; i < 60; i++) { await frames(1); ys.push((await snap()).ball[1]); }
  rep.dribble = { minY: +Math.min(...ys).toFixed(3), maxY: +Math.max(...ys).toFixed(3) };

  // 3. rim / backboard collision: the ball thrown (physics impulse) at the front of the rim and at the board
  const throwAt = (target, T) => page.evaluate(({ target, T }) => new Promise((res) => {
    const S = window.__court3d, ph = S.phys;
    S.freeBall = { kind: 'test', t: 0 }; S.player.hasBall = false; S.player.ballFree = true;
    ph.placeBall([0, 2.2, 3.2]); ph.touchedSince.clear();
    ph.throwBall(ph.ballisticTo(target, T), 'both');
    const hits = new Set(); const path = []; let n = 0;
    const f = () => { for (const t of ph.touchedSince) hits.add(t); path.push(ph.cur.p.slice()); if (++n < 90) requestAnimationFrame(f); else res({ hits: [...hits], path }); };
    requestAnimationFrame(f);
  }), { target, T });
  const rimHit = await throwAt([0, 3.05, 0.2286], 0.9);
  rep.rim = { contacts: rimHit.hits.filter((h) => h !== 'floor'), ballEndY: +rimHit.path[rimHit.path.length - 1][1].toFixed(2) };
  const boardHit = await throwAt([0, 3.6, -0.36], 0.8);
  rep.board = { contacts: boardHit.hits.filter((h) => h !== 'floor'), maxZBehindBoard: +Math.min(...boardHit.path.map((p) => p[2])).toFixed(3) };
  // back to play
  await page.evaluate(() => { const S = window.__court3d; S.freeBall = null; S.player.giveBall(); S.player.teleport(1.8, 5.2); });
  await frames(20);

  // 4. a shot through the rim (the game's own shot: hold I)
  await page.evaluate(() => { window.__court3d.swishes = 0; });
  await page.mouse.click(400, 250);
  await page.keyboard.down('KeyI'); await frames(4); await page.keyboard.up('KeyI');
  let shot = { started: false, released: false, swish: false };
  for (let i = 0; i < 400; i++) {
    await frames(1);
    const s = await page.evaluate(() => ({ m: window.__court3d.player.mode, fb: window.__court3d.freeBall?.kind, sw: window.__court3d.swishes || 0 }));
    if (s.m === 'action') shot.started = true;
    if (s.fb === 'shot') shot.released = true;
    if (s.sw) { shot.swish = true; break; }
    if (shot.released && s.fb !== 'shot') break;
  }
  rep.shot = shot;

  // 5. full-court navigation: walk to the far (East) end, then bounds at the corners
  await page.evaluate(() => { window.__court3d.player.teleport(0, 18); });
  await frames(10);
  const z0 = (await snap()).pos[1];
  await page.keyboard.down('KeyS');
  let z1 = z0;
  for (let i = 0; i < 80; i++) { await frames(1); z1 = (await snap()).pos[1]; if (z1 > 25.5) break; }
  await page.keyboard.up('KeyS');
  await frames(20);
  const far = await snap();
  rep.navigation = { from: +z0.toFixed(2), reachedZ: +z1.toFixed(2), eastBaselineZ: 26.425, ballWithPlayer: +Math.hypot(far.ball[0] - far.pos[0], far.ball[2] - far.pos[1]).toFixed(2), lost: far.lost };
  const clamp = await page.evaluate(() => new Promise((res) => {
    const S = window.__court3d, P = S.player; P.pos[0] = 30; P.pos[1] = 40;
    requestAnimationFrame(() => requestAnimationFrame(() => res(P.pos.slice())));
  }));
  rep.bounds = { clampedTo: clamp.map((v) => +v.toFixed(2)) };
  await page.evaluate(() => window.__court3d.player.teleport(1.8, 5.2));
  await frames(10);
  await page.screenshot({ path: path.join(OUT, 'vantheah.png') });

  rep.pass = !errors.length && rep.court.loaded && rep.court.colliders > 40
    && rep.feet.lowestJointM > -0.02 && rep.feet.highestLowestJointM < 0.12
    && rep.scale.topJointM > 1.5 && rep.scale.topJointM < 1.95
    && rep.dribble.minY < 0.2 && rep.dribble.maxY > 0.6 && rep.dribble.maxY < 1.3
    && rep.rim.contacts.includes('rim') && rep.board.contacts.includes('board') && rep.board.maxZBehindBoard > -0.42
    && rep.shot.started && rep.shot.released
    && rep.navigation.reachedZ > 24 && !rep.navigation.lost
    && Math.abs(rep.bounds.clampedTo[0] - 7.1) < 0.01 && Math.abs(rep.bounds.clampedTo[1] - 26.025) < 0.01;
  fs.writeFileSync(path.join(OUT, 'vantheah-report.json'), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep, null, 1));
  await browser.close();
  process.exit(rep.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
