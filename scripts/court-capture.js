#!/usr/bin/env node
/**
 * Record a character playing a move on the studio's Testing court (Game Mode).
 *
 *   SF_PASSWORD=... node scripts/court-capture.js --base <url> --char ankh --move cross --out ./court
 *
 * Produces court.webm + court.gif + stills. Uses the Playwright Chromium in
 * PLAYWRIGHT_BROWSERS_PATH (set CHROMIUM_PATH to override).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (args.base || 'http://localhost:3456').replace(/\/$/, '');
const OUT = args.out || path.join(process.cwd(), 'court-capture');
const PW = process.env.SF_PASSWORD || '';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  // Honour an outbound HTTPS proxy (CI / sandboxed containers)
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  let proxy;
  if (proxyUrl && !/localhost|127\.0\.0\.1/.test(BASE)) {
    const u = new URL(proxyUrl);
    proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') };
  }
  const browser = await chromium.launch({ proxy, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: !!proxy, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  const errors = [];
  const httpErr = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) httpErr.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 100)}`); });
  const q = `page=testing&char=${encodeURIComponent(args.char)}` + (PW ? `&key=${encodeURIComponent(PW)}` : '');
  for (let a = 0; ; a++) {
    try { await page.goto(`${BASE}/?${q}`, { waitUntil: 'load', timeout: 60000 }); break; }
    catch (e) { if (a >= 4) throw e; await page.waitForTimeout(3000 * (a + 1)); }
  }
  await page.waitForFunction((c) => typeof TESTING !== 'undefined' && TESTING.selectedChar === c && typeof GM !== 'undefined' && GM.active, args.char, { timeout: 30000 })
    .catch(async () => {
      await page.evaluate((c) => { testingSelectChar(c); if (!GM.active) startGameMode(true); }, args.char);
    });
  await page.waitForTimeout(+args.wait || 6000);
  if (args.scale) await page.evaluate((k) => { TESTING.scale = k; }, +args.scale); // capture only, not saved
  if (args.zone) {
    // Find a spot inside the requested court zone (zone ids match COURT_ZONES)
    args.pos = await page.evaluate((zid) => {
      for (let y = 460; y >= 80; y -= 10) for (let x = 480; x <= 800; x += 20) {
        if (getZoneForPos(x, y)?.id === zid && !isOutOfBounds(x, y)) return `${x},${y}`;
      }
      return null;
    }, +args.zone);
  }
  if (args.pos) {
    const [x, y] = String(args.pos).split(',').map(Number);
    await page.evaluate(([x, y]) => { if (GM.physics) { GM.physics.x = x; GM.physics.y = y; } }, [x, y]);
    await page.waitForTimeout(800);
  }
  const state = await page.evaluate(() => ({
    pos: GM.physics ? [Math.round(GM.physics.x), Math.round(GM.physics.y)] : null,
    char: [Math.round(TESTING.charX), Math.round(TESTING.charY)], scale: TESTING.scale, pixelHeight: TESTING.pixelHeight,
    canvas: [document.getElementById('testingCourt').width, document.getElementById('testingCourt').height, TESTING._dpr],
    cssSize: (() => { const r = document.getElementById('testingCourt').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    selectedAnim: TESTING.selectedAnim, active: (() => { try { const a = getActiveStrip(); return a ? { src: a.img.src.slice(-60), w: a.img.naturalWidth, n: a.frameCount, zone: a.zone?.id } : null; } catch (e) { return 'err ' + e.message; } })(),
    charAnims: (GM.charAnims || []).map((a) => a.name + ':' + (a.zoneId ?? a.zone ?? '') + ':' + (a.startingHand ?? a.hand ?? '')).slice(0, 8), hasPlayer: !!GM.player,
    hd: (TESTING.hdFrames || []).map((i) => i.naturalWidth + 'x' + i.naturalHeight).slice(0, 3), frame: TESTING.currentFrame,
    selected: TESTING.selectedChar, gm: GM.active, playerState: GM.player?.state, zone: GM.zone?.id ?? GM.currentZone ?? null,
    strip: GM.currentStrip?.src || TESTING.stripImg?.src || null,
  })).catch((e) => ({ err: e.message }));
  console.log('state', JSON.stringify(state));
  const court = await page.$('#testingCourt');
  await court.scrollIntoViewIfNeeded();
  await court.screenshot({ path: path.join(OUT, 'court-idle.png') });
  const move = args.move || 'cross';
  for (let i = 0; i < (+args.reps || 5); i++) {
    await page.evaluate((m) => {
      // Same call the right-stick flick makes in Game Mode
      if (m === 'cross' && GM.physics) GM.physics.facingRight = !GM.physics.facingRight;
      GM._actionHand = GM.ballHand;
      GM.player.triggerAction(m, m === 'cross' ? { type: 'stationary' } : null);
    }, move);
    await page.waitForTimeout(350);
    await court.screenshot({ path: path.join(OUT, `court-${move}-${i}.png`) });
    await page.waitForTimeout(1100);
  }
  const video = page.video();
  await ctx.close();
  await browser.close();
  const webm = await video.path();
  const final = path.join(OUT, 'court.webm');
  fs.renameSync(webm, final);
  try {
    const ffmpeg = require('ffmpeg-static');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '2', '-i', final, '-vf', 'fps=15,scale=900:-1:flags=lanczos', path.join(OUT, 'court.gif')]);
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '2', '-i', final, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'court.mp4')]);
  } catch (e) { console.warn('gif/mp4 conversion failed:', e.message); }
  console.log(JSON.stringify({ out: OUT, errors, httpErr: [...new Set(httpErr)].slice(0, 20) }));
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
