#!/usr/bin/env node
/**
 * Step-back jumper check on the Testing court (Game Mode), driven by the
 * keyboard exactly like a player: hold a direction (left stick), then HOLD
 * I (Square) → step-back jumper.
 *
 *   SF_PASSWORD=... node scripts/court-shot-test.js --base <url> --char ankh --out ./shot-test
 *
 * For each court zone 1–5 (+ a spot where the hoop is to the player's right):
 *   idle strip = idle-dribble for that zone, facing the hoop (mirrored when needed)
 *   the shot uses stepback-jumpshot for that zone
 *   the step-back burst moves the player AWAY from the hoop
 *   the ball leaves the hand on the release frame and flies to the rim
 * Writes report.json, stills and shot.webm/.mp4/.gif.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (args.base || 'http://localhost:3456').replace(/\/$/, '');
const OUT = args.out || path.join(process.cwd(), 'shot-test');
const PW = process.env.SF_PASSWORD || '';
const CHAR = args.char || 'ankh';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  let proxy;
  if (proxyUrl && !/localhost|127\.0\.0\.1/.test(BASE)) {
    const u = new URL(proxyUrl);
    proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') };
  }
  const browser = await chromium.launch({ proxy, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
  // Password as a header on every request (no ?key= redirect / rate limit)
  const ctx = await browser.newContext({ ignoreHTTPSErrors: !!proxy, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } }, ...(PW ? { extraHTTPHeaders: { Authorization: `Bearer ${PW}` } } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = `page=testing&char=${encodeURIComponent(CHAR)}`;
  for (let a = 0; ; a++) {
    try { await page.goto(`${BASE}/?${q}`, { waitUntil: 'load', timeout: 60000 }); break; }
    catch (e) { if (a >= 4) throw e; await page.waitForTimeout(3000 * (a + 1)); }
  }
  await page.waitForFunction((c) => typeof TESTING !== 'undefined' && TESTING.selectedChar === c && typeof GM !== 'undefined' && GM.active && GM.player, CHAR, { timeout: 30000 })
    .catch(async () => { await page.evaluate((c) => { testingSelectChar(c); if (!GM.active) startGameMode(true); }, CHAR); });
  await page.waitForTimeout(+args.wait || 6000);
  const court = await page.$('#testingCourt');
  await court.scrollIntoViewIfNeeded();
  await page.mouse.click(5, 5); // focus the page, not an input

  // One spot per zone (flip false), plus one behind the hoop line (flip true)
  const spots = await page.evaluate(() => {
    const out = [];
    const ok = (x, y) => !isOutOfBounds(x, y);
    for (const zid of [1, 2, 3, 4, 5]) {
      let best = null;
      for (let y = 90; y <= 500; y += 6) for (let x = 120; x <= 900; x += 10) {
        const z = getZoneForPos(x, y);
        if (z?.id !== zid || z.flip || !ok(x, y)) continue;
        // prefer spots well inside the zone, 250–450 px from the hoop
        const d = Math.hypot(x - NET_ANCHOR.x, y - NET_ANCHOR.y);
        const centre = [8, 45, 90, 135, 172][zid - 1];
        const score = Math.abs(d - 260) * 0.3 + Math.abs(z.facingAngle - centre) * 6;
        if (!best || score < best.score) best = { x, y, score, zone: zid, flip: false, angle: Math.round(z.facingAngle) };
      }
      if (best) out.push(best);
    }
    for (let y = 150; y <= 480; y += 6) for (let x = 56; x < NET_ANCHOR.x - 4; x += 4) {
      const z = getZoneForPos(x, y);
      if (z?.flip && ok(x, y)) { out.push({ x, y, zone: z.id, flip: true, angle: Math.round(z.facingAngle) }); return out; }
    }
    return out;
  });
  console.log('spots', JSON.stringify(spots));

  const report = { base: BASE, char: CHAR, spots: [] };
  for (const [si, sp] of spots.entries()) {
    await page.evaluate(({ x, y }) => { GM.physics.x = x; GM.physics.y = y; GM.physics.vx = 0; GM.physics.vy = 0; GM._shotBall = null; }, sp);
    await page.waitForTimeout(1400);
    const idle = await page.evaluate(() => ({ anim: GM.player.currentAnim, key: GM._loadedAnimKey, mirrored: !GM.physics.facingRight, zone: getZoneForPos(TESTING.charX, TESTING.charY) }));
    await court.screenshot({ path: path.join(OUT, `z${sp.zone}${sp.flip ? 'f' : ''}-0-idle.png`) });
    // Walk sideways (away from the hoop's side, then back): still facing the hoop?
    const walk = [];
    for (const k of ['KeyD', 'KeyA']) {
      await page.keyboard.down(k);
      for (let t = 0; t < 4; t++) {
        await page.waitForTimeout(90);
        walk.push(await page.evaluate(() => { const z = getZoneForPos(TESTING.charX, TESTING.charY); return { mirrored: !GM.physics.facingRight, flip: !!z?.flip, anim: GM.player.currentAnim }; }));
      }
      await page.keyboard.up(k);
    }
    await page.evaluate(({ x, y }) => { GM.physics.x = x; GM.physics.y = y; GM.physics.vx = 0; GM.physics.vy = 0; }, sp);
    await page.waitForTimeout(700);
    // Left stick: a short push straight at the hoop (keeps the zone angle),
    // or away from it behind the hoop line; then HOLD Square
    const keys = await page.evaluate((flip) => {
      const dx = (NET_ANCHOR.x - TESTING.charX) * (flip ? -1 : 1), dy = (NET_ANCHOR.y - TESTING.charY) * (flip ? -1 : 1);
      const k = [];
      if (Math.abs(dx) > Math.abs(dy) * 0.4) k.push(dx < 0 ? 'KeyA' : 'KeyD');
      if (Math.abs(dy) > Math.abs(dx) * 0.4) k.push(dy < 0 ? 'KeyW' : 'KeyS');
      return k;
    }, sp.flip);
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(120);
    await page.keyboard.down('KeyI');
    await page.waitForTimeout(90);
    for (const k of keys) await page.keyboard.up(k);
    await page.waitForTimeout(230);
    await page.keyboard.up('KeyI');
    const start = await page.evaluate(() => ({ x: TESTING.charX, y: TESTING.charY, zone: getZoneForPos(TESTING.charX, TESTING.charY) }));
    const samples = [];
    const t0 = Date.now();
    let shots = 0;
    while (Date.now() - t0 < 3600) {
      const s = await page.evaluate(() => ({
        anim: GM.player.currentAnim, state: GM.player.state, key: GM._loadedAnimKey, frame: TESTING.currentFrame,
        x: TESTING.charX, y: TESTING.charY, mirrored: !GM.physics.facingRight,
        ball: GM._shotBall ? { x0: GM._shotBall.x0, y0: GM._shotBall.y0, t: GM._shotBall.t } : null,
        meta: GM.charAnims.find((a) => a.animKey === GM._loadedAnimKey)?._shotMeta ?? null,
      }));
      samples.push({ ms: Date.now() - t0, ...s });
      if (s.ball && shots < 2 && (shots === 0 || s.ball.t > 0.5)) { await court.screenshot({ path: path.join(OUT, `z${sp.zone}${sp.flip ? 'f' : ''}-${++shots}-ball.png`) }); }
      if (!s.ball && s.anim === 'stepback-jumpshot' && samples.filter((q) => q.anim === 'stepback-jumpshot').length === 3) {
        await court.screenshot({ path: path.join(OUT, `z${sp.zone}${sp.flip ? 'f' : ''}-0-shot.png`) });
      }
      await page.waitForTimeout(60);
    }
    const shot = samples.filter((q) => q.anim === 'stepback-jumpshot');
    const hoop = await page.evaluate(() => ({ x: NET_ANCHOR.x, y: NET_ANCHOR.y, rim: gmRimPoint() }));
    const dStart = Math.hypot(start.x - hoop.x, start.y - hoop.y);
    const dEnd = shot.length ? Math.hypot(shot[shot.length - 1].x - hoop.x, shot[shot.length - 1].y - hoop.y) : null;
    const firstBall = samples.find((q) => q.ball);
    const r = {
      ...sp, idle, shotKey: shot[0]?.key ?? null, shotFrames: shot.length ? Math.max(...shot.map((q) => q.frame)) + 1 : 0,
      shotMirrored: shot[0]?.mirrored ?? null, movedAwayPx: dEnd != null ? Math.round(dEnd - dStart) : null,
      ballLaunched: !!firstBall, releaseFrame: firstBall?.frame ?? null, release: firstBall ? [Math.round(firstBall.ball.x0), Math.round(firstBall.ball.y0)] : null,
      meta: shot.find((q) => q.meta)?.meta ?? null, backToIdle: samples[samples.length - 1].anim,
    };
    r.shotZone = start.zone?.id; r.shotZoneFlip = !!start.zone?.flip;
    r.walkFacesHoop = walk.filter((w) => w.anim === 'idle-dribble').every((w) => w.mirrored === w.flip);
    r.pass = r.idle.key === `idle-dribble_z${sp.zone}_right` && r.idle.mirrored === sp.flip
      && r.shotKey === `stepback-jumpshot_z${r.shotZone}_right` && r.shotMirrored === r.shotZoneFlip
      && r.movedAwayPx > 5 && r.ballLaunched && r.backToIdle === 'idle-dribble' && r.walkFacesHoop;
    report.spots.push(r);
    console.log(JSON.stringify(r));
  }
  report.errors = errors;
  report.pass = report.spots.length >= 5 && report.spots.every((s) => s.pass) && !errors.length;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const video = page.video();
  await ctx.close();
  await browser.close();
  const final = path.join(OUT, 'shot.webm');
  fs.renameSync(await video.path(), final);
  try {
    const ffmpeg = require('ffmpeg-static');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', final, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'shot.mp4')]);
  } catch (e) { console.warn('mp4 conversion failed:', e.message); }
  console.log(JSON.stringify({ pass: report.pass, errors }));
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
