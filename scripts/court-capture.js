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
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = `page=testing&char=${encodeURIComponent(args.char)}` + (PW ? `&key=${encodeURIComponent(PW)}` : '');
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((c) => typeof TESTING !== 'undefined' && TESTING.selectedChar === c && typeof GM !== 'undefined' && GM.active, args.char, { timeout: 30000 })
    .catch(async () => {
      await page.evaluate((c) => { testingSelectChar(c); if (!GM.active) startGameMode(true); }, args.char);
    });
  await page.waitForTimeout(2500);
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
  console.log(JSON.stringify({ out: OUT, errors }));
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
