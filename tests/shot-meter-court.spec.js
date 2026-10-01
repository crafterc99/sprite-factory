#!/usr/bin/env node
/**
 * The shot meter on the real court (engine3d/shot-meter.mjs; docs/ball-contact-system.md → THE SHOT METER):
 * court3d.html in Chromium (Playwright) with a virtual clock, an iPad-sized window (1180 × 820), the standing jump
 * shot (□ = I) released once in every band — EXCELLENT, SLIGHTLY EARLY, EARLY, VERY EARLY, SLIGHTLY LATE, LATE, and
 * never let go (VERY LATE) — each filmed: the meter the moment □ went down, the frame after the button came up (the
 * label beside the bar), what the ball met (the hoop from the side, frozen on the frame it first touched the rim / the
 * glass, or came down through the rim's height), and the result. Checked per release: the label; the bar on its mark on
 * the frame the ball leaves (the meter in sync with the clip); the flight its band calls for, as the physics flew it
 * (swish: in, touching nothing; slightly early: the front of the rim first, out; early: short, touching nothing;
 * slightly late: the back of the rim first, out; late / held: the glass first, out); the result shown; the meter's bar
 * at least 170 px tall and its label at least 18 px, on top of the HUD.
 *
 *   node tests/shot-meter-court.spec.js [--fps 30] [--char ac-001] [--base http://localhost:3456]
 *
 * Needs the local server and the clip library. Writes tests/reports/shot-meter/<char>-<fps>fps/ (gitignored): the
 * screenshots and report.json. Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), BASE = opt('base', 'http://localhost:3456');
const OUT = path.join(__dirname, 'reports', 'shot-meter', `${CHAR}-${FPS}fps`);
fs.mkdirSync(OUT, { recursive: true });

// the releases: frames of the shot clip off its release frame (the jump shot: 30 fps) — null: never let go
const BANDS = [
  ['excellent', -1, 'EXCELLENT', 'swish'],
  ['slightly-early', -4, 'SLIGHTLY EARLY', 'front-rim'],
  ['early', -6, 'EARLY', 'short'],
  ['very-early', -12, 'VERY EARLY', 'short'],
  ['slightly-late', 4, 'SLIGHTLY LATE', 'back-rim'],
  ['late', 6, 'LATE', 'off-glass'],
  ['held', null, 'VERY LATE', 'off-glass'],
];

let browser = null;
process.on('unhandledRejection', async (e) => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
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
  await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=0`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
  if (!(await page.evaluate(() => !!window.__c3dReady && !!window.__ball))) { console.error('court did not start', errors); process.exit(1); }
  await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
  await page.addStyleTag({ content: '#help,#vid,#toast{display:none!important}' });
  // a recorder in the page: every frame's ball, the shot's first contact with the rim / the glass, the meter
  await page.evaluate(() => {
    const S = window.__court3d, B = window.__ball.session;
    window.__rec = { frames: [] };
    const step = B.step.bind(B);
    B.step = function (...a) {
      if (window.__freeze) return window.__freeze;   // (frozen: the same frame filmed again)
      const out = step(...a);
      window.__lastOut = { ...out, p: out.p.slice(), q: out.q.slice(), events: [] };
      const ph = this.phys, L = this.lastShot, c = this.hoop.center;
      const fr = { t: +this.t.toFixed(4), s: out.state, p: out.p.map((x) => +x.toFixed(4)), act: S.player.action?.clip?.name || null, at: S.player.action ? +S.player.action.t.toFixed(3) : null, fill: window.__shotMeter.view().fill, clipT: window.__shotMeter.clipT(), clock: S.meter.shot ? S.meter.fracOf(S.meter.clipT) : null };
      // (along the shot from the rim's centre: − on the shooter's side)
      if (L && out.state === 'SHOT_RELEASE') {
        const u = [c[0] - L.from[0], c[2] - L.from[2]], l = Math.hypot(u[0], u[1]), along = ((out.p[0] - c[0]) * u[0] + (out.p[2] - c[2]) * u[1]) / l;
        const first = [...(ph?.touchedSince || [])].find((n) => n === 'rim' || n === 'board');
        if (first && !L.__first) L.__first = { name: first, along: +along.toFixed(3), t: fr.t };
        const prev = window.__rec.frames[window.__rec.frames.length - 1];
        if (L.__down == null && prev && prev.s === 'SHOT_RELEASE' && prev.p[1] > c[1] + 0.03 && out.p[1] <= c[1] + 0.03) L.__down = +along.toFixed(3);
        fr.along = +along.toFixed(3);
      }
      window.__rec.frames.push(fr);
      return out;
    };
  });
  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 240000 });
  const now = () => page.evaluate(() => {
    const S = window.__court3d, B = window.__ball.session, R = window.__rec, el = document.getElementById('shotMeter'), bar = el.querySelector('.sm-bar'), fb = el.querySelector('.sm-fb');
    const L = B.lastShot;
    return { f: R.frames[R.frames.length - 1], n: R.frames.length, v: window.__shotMeter.view(), sh: window.__shotMeter.shot(), clipT: window.__shotMeter.clipT(), hasBall: S.player.hasBall && !S.player.ballFree, mode: S.player.mode, state: B.state,
      shown: getComputedStyle(el).display === 'block', z: +getComputedStyle(el).zIndex, barH: bar.offsetHeight, barW: bar.offsetWidth, labelPx: parseFloat(getComputedStyle(fb).fontSize),
      last: L ? { first: L.__first || null, down: L.__down ?? null, through: L.through, outcome: L.outcome, meter: L.meter, provisional: L.provisional, reaimed: L.reaimed || null, result: L.result, from: L.from, t: L.t } : null };
  });
  /** Freeze the frame just drawn and film it with the camera on the hoop from the shooter's side (or `cam`). */
  const filmHoop = async (name, from) => {
    await page.evaluate(({ from }) => {
      const S = window.__court3d, c = window.__ball.session.hoop.center;
      S.speed = 0; S.freezePose = true; window.__freeze = window.__lastOut;
      const u = [c[0] - from[0], c[2] - from[2]], l = Math.hypot(u[0], u[1]); u[0] /= l; u[1] /= l;
      const side = [-u[1], u[0]];
      S.camFixed = { pos: [c[0] + side[0] * 3.6 - u[0] * 1.2, c[1] + 0.35, c[2] + side[1] * 3.6 - u[1] * 1.2], look: [c[0] - u[0] * 0.3, c[1] + 0.05, c[2] - u[1] * 0.3] };
    }, { from });
    await frames(2); await shot(name);
    await page.evaluate(() => { const S = window.__court3d; S.speed = 1; S.freezePose = false; window.__freeze = null; S.camFixed = null; });
  };
  await page.mouse.click(900, 420);
  await sec(1.0);

  const results = [];
  for (const [key, k, wantLabel, wantFlight] of BANDS) {
    // the ball back, the player settled (the rebounder's pass after the last shot)
    for (let i = 0; i < 6 * FPS; i++) { const st = await now(); if (st.hasBall && st.mode === 'loco' && /^(HELD|DRIBBLE|CATCH|BOUNCE)/.test(st.state)) break; if (i === 4 * FPS) await page.keyboard.press('KeyX'); await frames(1); }
    await sec(0.8);
    const r = { key, want: wantLabel, wantFlight, release: k };
    const t0 = await page.evaluate(() => window.__ball.session.t);   // (this band's shot: launched after this — lastShot is the previous one until then)
    // □ down: the meter is up at once (empty until the shot clip starts)
    await page.keyboard.down('KeyI');
    await frames(1);
    let st = await now();
    r.shownOnPress = st.shown; r.barPx = [st.barW, st.barH]; r.zIndex = st.z;
    if (key === 'excellent') {
      await shot(`${key}-0-pressed`);
      // the same moment on a desktop window (1440 × 900)
      await page.setViewportSize({ width: 1440, height: 900 }); await frames(3); await shot(`${key}-0-pressed-desktop`);
      const d = await now(); r.desktopBarPx = [d.barW, d.barH];
      await page.setViewportSize({ width: 1180, height: 820 }); await frames(2);
    }
    let up = false, launch = null, graded = false, filmedHoop = false, done = false;
    for (let i = 0; i < 8 * FPS && !done; i++) {
      await frames(1);
      st = await now();
      const f = st.f;
      // the launch: the bar on its mark on the frame the ball left
      if (!launch && f.s === 'SHOT_RELEASE') {
        const prev = await page.evaluate(() => window.__rec.frames[window.__rec.frames.length - 2]);
        // (the clip's own position on the bar — the drawn fill stops where the button came up, as in 2K)
        launch = { clipFrame: f.at, rel: st.sh?.rel, fill: f.clock, prevFill: prev?.clock, mark: st.v.mark, held: !up };
      }
      // let go k frames off the release frame (the meter's clock: the clip's time as drawn)
      if (!up && k != null && st.sh && st.clipT != null && st.clipT >= st.sh.rel + k - 1e-6) { await page.keyboard.up('KeyI'); up = true; r.upAt = +(st.clipT - st.sh.rel).toFixed(2); }
      if (!graded && st.v.label) {
        graded = true; r.label = st.v.label; r.labelPx = st.labelPx;
        await frames(1); await shot(`${key}-1-graded`);
      }
      // what the ball met: the frame it first touched the rim / the glass, or came down through the rim's height
      if (!filmedHoop && st.last && st.last.t > t0 && (st.last.first || st.last.down != null || st.last.through)) { filmedHoop = true; await filmHoop(`${key}-2-hoop`, st.last.from); }
      if (st.v.result && graded && filmedHoop && st.last?.t > t0) { r.result = st.v.result; await shot(`${key}-3-result`); done = true; }
    }
    if (!up) { await page.keyboard.up('KeyI'); }
    st = await now();
    const L = st.last && st.last.t > t0 ? st.last : {};
    const flight = !L.first ? (L.through ? 'swish' : L.down == null || L.down < 0 ? 'short' : 'long') : L.first.name === 'board' ? 'off-glass' : L.first.along < 0 ? 'front-rim' : 'back-rim';
    r.flight = flight; r.first = L.first; r.down = L.down; r.through = L.through; r.reaimed = L.reaimed; r.launch = launch; r.e = L.meter?.e ?? null;
    const onMark = launch && launch.prevFill <= launch.mark + 1e-6 && launch.fill >= launch.mark - 1e-6;
    r.checks = {
      label: r.label === wantLabel, flight: flight === wantFlight, out: wantFlight === 'swish' ? !!L.through : !L.through,
      result: wantFlight === 'swish' ? r.result === 'SWISH' : wantFlight === 'short' ? r.result === 'AIR BALL' : r.result === 'MISS',
      onMark: !!onMark, shownOnPress: !!r.shownOnPress, big: r.barPx[1] >= 170 && r.barPx[0] >= 22 && (r.labelPx ?? 0) >= 18, onTop: r.zIndex >= 10,
    };
    r.ok = Object.values(r.checks).every(Boolean);
    results.push(r);
    console.log(`${r.ok ? '✔' : '✖'} ${key.padEnd(15)} let go ${k == null ? 'never' : `${k} frames`} → ${r.label} (${r.e != null ? Math.round(r.e * 1000) + ' ms' : '?'}) → ${flight}${L.first ? ` (first ${L.first.name} at ${L.first.along} m along)` : L.down != null ? ` (down at ${L.down} m along)` : ''} · ${r.result} · bar on its mark at the launch ${onMark ? 'yes' : 'NO'} (frame ${launch?.clipFrame} of rel ${launch?.rel}: ${launch?.prevFill?.toFixed(3)} → ${launch?.fill?.toFixed(3)}) · bar ${r.barPx.join('×')} px, label ${r.labelPx} px${L.reaimed ? ` · bent ${L.reaimed.dv} m/s in the air` : ''}${r.ok ? '' : ' · FAILED ' + Object.entries(r.checks).filter(([, v]) => !v).map(([n]) => n).join(', ')}`);
    await sec(0.5);
  }
  const report = { fps: FPS, char: CHAR, errors, results, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('screenshots:', OUT);
  await browser.close();
  process.exit(results.length === BANDS.length && results.every((r) => r.ok) && !errors.length ? 0 : 1);
})();
