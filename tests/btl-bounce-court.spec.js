#!/usr/bin/env node
/**
 * The between-the-legs bounces on the real court (docs/ball-contact-system.md → TRAJECTORY MODEL → the floor contact):
 * court3d.html in Chromium (Playwright) with a virtual clock, the recorded between-the-legs → crossover → shot move
 * (mo-mulp87wqvabn, □ on the move), AC. Every frame of the move is recorded; the game is frozen (speed 0, the same ball
 * and pose) on each of its two BOUNCE frames and filmed from the front, the side and the back, and on every 2nd frame
 * from its first dribble to the crossover's catch — every frame while the ball is in the air — (front and side): the
 * ball going down, hitting the floor, coming up and caught, twice. Checked on every bounce frame: the ball's bottom on the floor (± 3 mm); the between-the-legs one
 * between the feet (along the line from one foot to the other).
 *
 *   node tests/btl-bounce-court.spec.js [--fps 30] [--char ac-001] [--base http://localhost:3456] [--dbg 1] [--tag name]
 *
 * Needs the local server and the clip library. Writes tests/reports/btl-bounces/<char>-<fps>fps/ (gitignored): the
 * screenshots and report.json. Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), BASE = opt('base', 'http://localhost:3456'), DBG = opt('dbg', '0') === '1';
const OUT = path.join(__dirname, 'reports', 'btl-bounces', `${CHAR}-${FPS}fps${opt('tag', '') ? '-' + opt('tag', '') : ''}`);
fs.mkdirSync(OUT, { recursive: true });

let browser = null;
// (never leave the browser behind: a failed run closes it too)
process.on('unhandledRejection', async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
  // virtual clock: every rendered frame is exactly 1/FPS s of real time (× the game speed)
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
  await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=${DBG ? 1 : 0}&focus=mo-mulp87wqvabn`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
  if (!(await page.evaluate(() => !!window.__c3dReady && !!window.__ball))) { console.error('court did not start', errors); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
  await page.addStyleTag({ content: '#help,#vid,#toast{display:none!important}' });
  // a recorder in the page: the ball every frame, and every bounce with the feet / hips as drawn on its frame
  await page.evaluate(() => {
    const S = window.__court3d, B = window.__ball.session;
    window.__rec = { frames: [], bounces: [] };
    const step = B.step.bind(B);
    B.step = function (t, dt, r, mats, body) {
      // (frozen: the frame being filmed again from another camera — the same ball, the same pose)
      if (window.__freeze) return window.__freeze;
      const out = step(t, dt, r, mats, body);
      window.__lastOut = { ...out, p: out.p.slice(), q: out.q.slice(), events: [] };
      const J = (n) => this.IK.jointPos(mats, this.mrig, this.mrig.JI[n]);
      const fr = { t: +t.toFixed(4), s: out.state, p: out.p.map((x) => +x.toFixed(4)), action: S.player.action?.clip?.name || null, at: S.player.action ? +S.player.action.t.toFixed(2) : null };
      window.__rec.frames.push(fr);
      for (const e of out.events) if (e.type === 'bounce') {
        const fl = this.ctl.flight || this.ctl.lastFlight;
        const foot = (s) => { const a = J(`${s}_foot`), b = J(`${s}_ball`); return [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2]; };
        window.__rec.bounces.push({ ...fr, tb: +e.t.toFixed(4), at3: e.p.map((x) => +x.toFixed(4)), from: fl?.fromHand, to: fl?.toHand, plan: fl?.plan || null, feet: { l: foot('l'), r: foot('r') }, hips: { l: J('l_upleg'), r: J('r_upleg') }, yaw: S.player.yaw });
      }
      return out;
    };
  });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  // (software rendering on a loaded machine: a frame can take a while)
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 240000 });
  /** Hold the camera at `dist` m from the ball, looking at it: 'front' (in front of him), 'side' (his right), 'back'. */
  const cam = (where, p, yaw, dist = 2.2, h = 0.55) => page.evaluate(({ where, p, yaw, dist, h }) => {
    const f = [Math.sin(yaw), Math.cos(yaw)], r = [-Math.cos(yaw), Math.sin(yaw)];   // his forward, his right (x, z)
    const d = where === 'front' ? f : where === 'back' ? [-f[0], -f[1]] : r;
    window.__court3d.camFixed = { pos: [p[0] + d[0] * dist, h, p[2] + d[1] * dist], look: [p[0], 0.3, p[2]] };
  }, { where, p, yaw, dist, h });
  await page.mouse.click(900, 420);
  await sec(1.0);

  // □ on the move (W, then I): the moving shot is the between-the-legs → crossover → shot move
  await page.keyboard.down('KeyW'); await sec(0.25); await page.keyboard.down('KeyI'); await sec(0.1); await page.keyboard.up('KeyW');
  const shots = [], seen = new Set(), seq = [];
  const yawNow = () => page.evaluate(() => window.__court3d.player.yaw);
  // (freeze the game on the frame just drawn — speed 0, the same ball and pose every frame — and film it from `views`)
  const film = async (name, p, yaw, views) => {
    await page.evaluate(() => { window.__court3d.speed = 0; window.__court3d.freezePose = true; window.__freeze = window.__lastOut; });
    const files = [];
    for (const where of views) { await cam(where, p, yaw); await frames(2); const f = `${name}-${where}`; await shot(f); files.push(f + '.png'); }
    await page.evaluate(() => { window.__court3d.speed = 1; window.__court3d.freezePose = false; window.__freeze = null; window.__court3d.camFixed = null; });
    return files;
  };
  let k = 0, caught = 0, done = false;
  for (let i = 0; i < Math.round(4 * FPS) && !done; i++) {
    await frames(1);
    const st = await page.evaluate(() => { const R = window.__rec; return { f: R.frames[R.frames.length - 1], b: R.bounces[R.bounces.length - 1] || null }; });
    if (!st.f || !/btl-cross/.test(st.f.action || '')) continue;
    if (st.f.at < 6) continue;
    const yaw = await yawNow();
    // (the frame the bounce happened on — the BOUNCE frame: the floor contact drawn): front, side and back
    if (st.b && st.f.t === st.b.t && !seen.has(st.b.tb)) {
      seen.add(st.b.tb);
      const n = shots.length + 1, files = await film(`bounce-${n}-clipframe-${st.b.at}`, st.b.p, yaw, ['front', 'side', 'back']);
      shots.push({ ...st.b, files });
      seq.push({ i: k, frame: st.f.at, state: st.f.s, y: st.f.p[1], files: files.filter((f) => /front|side/.test(f)), bounce: n });
    } else if (k % 2 === 0 || /^(RELEASE_|DRIBBLE_|CATCH_)/.test(st.f.s)) {
      // the sequence: every 2nd frame from the move's first dribble to the second catch — every frame while the ball is
      // in the air (at 30 fps a dribble is 3–4 frames) — from the front and the side
      const files = await film(`seq-${String(k).padStart(2, '0')}-clipframe-${st.f.at}-${st.f.s}`, st.f.p, yaw, ['front', 'side']);
      seq.push({ i: k, frame: st.f.at, state: st.f.s, y: st.f.p[1], files });
    }
    k++;
    if (/^CATCH_|^HELD_/.test(st.f.s) && shots.length >= 2 && /^HELD_/.test(st.f.s)) caught++;
    if (caught >= 3) done = true;
  }
  await page.keyboard.up('KeyI');
  // checks: every bounce of the move drawn on the floor; the between-the-legs one between the feet
  const R = 0.12, results = [];
  for (const b of shots) {
    const bottom = b.p[1] - R;
    // along the line from the left foot to the right foot (0 … 1) and off it (m)
    const L = b.feet.l, Rf = b.feet.r, d = [Rf[0] - L[0], Rf[1] - L[1]], w = Math.hypot(d[0], d[1]), u = ((b.p[0] - L[0]) * d[0] + (b.p[2] - L[1]) * d[1]) / (w * w);
    const off = ((b.p[0] - L[0]) * d[1] - (b.p[2] - L[1]) * d[0]) / w;
    const btl = b.from && b.to && b.from !== b.to && b.plan?.gate;
    const ok = Math.abs(bottom) <= 0.003 && (!btl || (u > 0.15 && u < 0.85));
    results.push({ ok, clipFrame: b.at, from: b.from, to: b.to, bottomMm: +(bottom * 1000).toFixed(1), betweenFeet: +u.toFixed(2), offFeetLineCm: +(off * 100).toFixed(1), stanceCm: +(w * 100).toFixed(1), plan: b.plan, files: b.files });
  }
  const gateBounce = results.find((r) => r.plan?.gate);
  const report = { fps: FPS, char: CHAR, errors, bounces: results, gateBounce: !!gateBounce, sequence: seq, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} bounce at clip frame ${r.clipFrame} (${r.from} → ${r.to}): bottom ${r.bottomMm} mm off the floor · along the feet ${r.betweenFeet} (stance ${r.stanceCm} cm, ${r.offFeetLineCm} cm off its line)${r.plan ? ` · ${r.plan.why}${r.plan.gate ? ' (between the legs)' : ''}, ${r.plan.clearance != null ? (r.plan.clearance * 100).toFixed(1) + ' cm clear' : ''}` : ''}`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('screenshots:', OUT);
  await browser.close();
  process.exit(results.length >= 2 && results.every((r) => r.ok) && gateBounce && !errors.length ? 0 : 1);
})();
