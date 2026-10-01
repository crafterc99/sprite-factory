#!/usr/bin/env node
/**
 * Visual test of the pro stick (engine3d/pro-stick.mjs) on the real court: court3d.html in Chromium
 * (Playwright) with a virtual clock (exact frame steps) and a synthetic standard gamepad — every
 * ball-handling move on the right stick, relative to his facing and the ball hand:
 *
 *   flicks     toward the free hand (crossover, both ways) · forward (hesitation: no clip yet, a note) ·
 *              back-diagonal free side (between the legs → the crossover) · straight back (behind the back →
 *              the crossover) · toward the ball hand (in-and-out: no clip yet)
 *   circles    a half and a quarter circle → the spin
 *   hold       held toward the free hand for 1 s → one hold, one move
 *   rebound    a flick with a one-frame overshoot back → one gesture
 *   chain      a crossover flick, then a half circle 0.3 s later → the crossover, then the spin
 *   shot       the stick while □ / I is held and while the shot flies: ignored, never buffered past the pass back
 *   buttons    R3 switches hand (no move) · the D-pad turns the camera (the right stick does not)
 *   cameras    a side camera: the stick is read on the screen (up = toward his right hand there)
 *   keyboard   the arrows as the stick: a tap = a flick, a roll ↓ ↘ → ↗ = a spin; Q / E orbit the camera
 *   touch      a swipe on the touch zone (an iPad without a controller) = a flick
 *   double     the ball in the right hand: a flick left, then right = the double crossover (main's gesture); the key L
 *   classic    ?pad=classic (a second page load): the right stick and the arrows are the camera, ○ the crossover
 *
 * Every scenario is checked frame by frame like tests/ball-court.spec.js (the ball never through the floor,
 * never lost, no recovery, no rejected transition, the hand skin ≤ 3 mm into the ball).
 *
 *   node tests/pro-stick-court.spec.js [--char ac-001] [--fps 30] [--only pro|classic] [--base http://localhost:3456]
 *
 * Needs the local server (bash mac-dev.sh) and the clip library (npm run clips:pull).
 * Writes tests/reports/pro-stick-court/<char>-<fps>fps/ (gitignored). Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), BASE = opt('base', 'http://localhost:3456'), ONLY = opt('only', null);
const OUT = path.join(__dirname, 'reports', 'pro-stick-court', `${CHAR}-${FPS}fps`);
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
  // virtual clock: every rendered frame is exactly 1/FPS s of game time
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
  // a synthetic standard gamepad: the court reads it once per frame (readInput); window.__padQ holds the
  // next frames' states (each { rs: [x, y], btn: { index: on } } is applied as that frame reads the pad and
  // stays until changed)
  await ctx.addInitScript(() => {
    const pad = { id: 'Synthetic Pad (STANDARD GAMEPAD)', index: 0, mapping: 'standard', connected: true, timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__pad = pad; window.__padQ = [];
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => {
      const s = window.__padQ.shift();
      if (s?.rs) { pad.axes[2] = s.rs[0]; pad.axes[3] = s.rs[1]; }
      if (s?.btn) for (const [i, on] of Object.entries(s.btn)) { pad.buttons[i].pressed = !!on; pad.buttons[i].value = on ? 1 : 0; }
      return [pad, null, null, null];
    } });
  });

  const results = [];
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
  const sec = (s) => frames(Math.round(s * FPS));
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  /** Open the court (pro or classic), the frame recorder in it. */
  async function open(q) {
    await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=1${q}`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
    if (!(await page.evaluate(() => !!window.__c3dReady && !!window.__ball))) { console.error('court did not start', await page.evaluate(() => document.getElementById('err')?.textContent), errors); process.exit(1); }
    await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
    await page.addStyleTag({ content: '#help,#vid{display:none!important}' });
    await page.evaluate(() => {
      const S = window.__court3d, B = window.__ball.session, P = S.player;
      window.__rec = { frames: [], bounces: [], catches: [], recoveries: [], actions: [], switches: [] };
      const step = B.step.bind(B);
      B.step = function (...a) {
        const out = step(...a);
        const Hd = this.lastHands ? ['left', 'right'].map((h) => this.lastHands[h]?.depth).filter((d) => d != null) : [];
        window.__rec.frames.push({ t: +this.t.toFixed(4), s: out.state, y: +out.p[1].toFixed(4), action: P.action?.clip?.name || null, role: P.action?.role || null, held: this.ctl.heldHand, hand: Hd.length ? +Math.max(...Hd).toFixed(4) : null, skin: !!this.hc });
        for (const e of out.events) { if (e.type === 'bounce') window.__rec.bounces.push({ t: +e.t.toFixed(3) }); if (e.type === 'catch') window.__rec.catches.push({ t: +e.t.toFixed(3), hand: e.hand, err: +(e.err || 0).toFixed(3) }); if (e.type === 'recovery') window.__rec.recoveries.push({ t: +e.t.toFixed(3), reason: e.reason }); }
        return out;
      };
      // every move / shot that starts, every hand switch (the crossover dribble)
      const up = P.update.bind(P);
      P.update = function (...a) {
        const r = up(...a);
        for (const e of r.events) { if (e.type === 'action') window.__rec.actions.push({ t: +(S.gameT || 0).toFixed(3), role: e.role, clip: e.clip, mirror: !!e.mirror }); if (e.type === 'handSwitch') window.__rec.switches.push({ t: +(S.gameT || 0).toFixed(3), hand: e.hand }); }
        return r;
      };
    });
    await page.mouse.click(900, 420);
    await sec(1.0);
  }
  const mark = () => page.evaluate(() => ({ f: window.__rec.frames.length, a: window.__rec.actions.length, s: window.__stick.log().length, w: window.__rec.switches.length, t: window.__court3d.gameT }));
  /** What happened since the mark: the frames, the moves, the gestures. */
  const since = (m) => page.evaluate((m) => { const R = window.__rec, t0 = R.frames[m.f]?.t ?? m.t ?? 0; return { frames: R.frames.slice(m.f), actions: R.actions.slice(m.a), stick: window.__stick.log().slice(m.s), switches: R.switches.slice(m.w), bounces: R.bounces.filter((b) => b.t >= t0), catches: R.catches.filter((c) => c.t >= t0), recoveries: R.recoveries.filter((c) => c.t >= t0) }; }, m);
  /** The frame-by-frame checks (as tests/ball-court.spec.js) + the scenario's own; one result row. */
  const check = async (name, m, own) => {
    const r = await since(m), F = r.frames, minY = Math.min(...F.map((f) => f.y));
    const lost = F.filter((f) => f.s === 'LOOSE').length, rejected = await page.evaluate(() => window.__ball.session.ctl.rejected);
    const skin = F.some((f) => f.skin), hd = F.filter((f) => f.hand != null), worst = hd.reduce((a, f) => (f.hand > a.hand ? f : a), { hand: -Infinity });
    const handOver3 = hd.filter((f) => f.hand > 0.003).length;
    const clean = minY >= 0.116 && !lost && !r.recoveries.length && !rejected && skin && handOver3 === 0;
    let o = { ok: true, why: '' };
    try { o = (await own(r)) || o; } catch (e) { o = { ok: false, why: 'threw: ' + e.message }; }
    results.push({ name, ok: clean && o.ok, clean, why: o.why || '', frames: F.length, minY: +minY.toFixed(4), lost, recoveries: r.recoveries, rejected, catches: r.catches.length, maxHandDepthMm: hd.length ? +(worst.hand * 1000).toFixed(1) : null, handFramesOver3mm: handOver3,
      stick: r.stick.map((g) => `${g.kind} ${g.gesture || ''}${g.theta != null ? ' θ' + g.theta : ''} → ${g.ignored ? 'ignored: ' + g.ignored : g.role || (g.handSwitch ? 'hand switch' : 'no clip')}${g.fellBack ? ' (fallback)' : ''}`),
      actions: r.actions.map((a) => `${a.role} ${a.clip}${a.mirror ? ' (mirror)' : ''} @${a.t}`), ...(o.extra || {}) });
    return r;
  };
  // ── the pad
  const queue = (seq) => page.evaluate((seq) => { window.__padQ.push(...seq); }, seq);
  const rep = (n, s) => Array.from({ length: n }, () => s);
  /** A flick: the stick out for n frames, back to the centre. */
  const flick = async (x, y, n = 3, settle = 0) => { await queue([...rep(n, { rs: [x, y] }), { rs: [0, 0] }]); await frames(n + 1 + settle); };
  const polar = (a, r = 1) => [Math.sin((a * Math.PI) / 180) * r, -Math.cos((a * Math.PI) / 180) * r];
  /** A circle on the rim: from → to (deg, stick: 0 up, +90 right) over ms, then back to the centre. */
  const arc = async (from, to, ms) => { const n = Math.max(2, Math.round((ms / 1000) * FPS)); await queue([...Array.from({ length: n + 1 }, (_, k) => ({ rs: polar(from + ((to - from) * k) / n) })), { rs: [0, 0] }]); await frames(n + 2); };
  const btn = async (i, nFrames = 1) => { await queue([{ btn: { [i]: true } }, ...rep(nFrames - 1, {}), { btn: { [i]: false } }]); await frames(nFrames + 1); };
  const hand = () => page.evaluate(() => { const B = window.__ball.session, h = B.ctl.heldHand; return h === 'left' || h === 'right' ? h : B.ctl.flight?.toHand || window.__court3d.player.hand; });
  /**
   * The stick direction [x, y-down] that points at θ in his frame (0 forward, +90 toward the free hand) on the
   * screen as it is now (the camera, his yaw, the ball hand) — the inverse of pro-stick stickTheta.
   */
  const stickFor = (theta) => page.evaluate((theta) => {
    const S = window.__court3d, P = S.player, B = window.__ball.session;
    const h0 = B.ctl.heldHand, hand = h0 === 'left' || h0 === 'right' ? h0 : B.ctl.flight?.toHand || P.hand;
    const f = [S.camLook.x - S.camPos.x, S.camLook.z - S.camPos.z], fl = Math.hypot(f[0], f[1]); f[0] /= fl; f[1] /= fl;
    const r = [-f[1], f[0]], fw = [Math.sin(P.yaw), Math.cos(P.yaw)], left = [Math.cos(P.yaw), -Math.sin(P.yaw)], off = hand === 'left' ? [-left[0], -left[1]] : left;
    const c = Math.cos((theta * Math.PI) / 180), s = Math.sin((theta * Math.PI) / 180), w = [fw[0] * c + off[0] * s, fw[1] * c + off[1] * s];
    return [w[0] * r[0] + w[1] * r[1], -(w[0] * f[0] + w[1] * f[1])];
  }, theta);
  /** Wait until the ball is held in one hand and no move plays (a clean start for the next scenario). */
  const settle = async (maxS = 3) => { for (let i = 0; i < maxS * FPS; i += 3) { const ok = await page.evaluate(() => { const B = window.__ball.session, P = window.__court3d.player; return P.mode === 'loco' && !P.switchPending && (B.ctl.heldHand === 'left' || B.ctl.heldHand === 'right') && !B.buffer.length; }); if (ok) return true; await frames(3); } return false; };
  const noteNow = () => page.evaluate(() => { const el = document.getElementById('stickNote'); return getComputedStyle(el).display === 'block' ? el.textContent : null; });
  const camYaw = () => page.evaluate(() => window.__court3d.camYaw);
  const has = (r, kind, gesture, role) => r.stick.some((g) => g.kind === kind && (!gesture || g.gesture === gesture) && (role === undefined || g.role === role));

  if (ONLY !== 'classic') {
    await open('');
    // ── 1 / 2: toward the free hand = the crossover, both ways
    for (const [i, label] of [[1, 'RS toward the free hand = crossover'], [2, 'RS toward the new free hand = crossover back']]) {
      await settle();
      const h0 = await hand(), m = await mark();
      // (the 2K chase camera: behind him, at the hoop — his free hand is on the screen's left when the ball is in his right)
      await flick(h0 === 'right' ? -1 : 1, 0);
      await sec(0.25); if (i === 1) await shot('1-crossover-flick');
      await sec(2.0);
      const h1 = await hand();
      await check(label, m, (r) => ({ ok: r.stick.length === 1 && has(r, 'flick', 'crossover', 'move-crossover') && r.actions.length === 1 && r.actions[0].role === 'move-crossover' && h1 !== h0, why: `hand ${h0} → ${h1}`, extra: { hand: [h0, h1] } }));
    }
    // ── 3: forward = the hesitation: no clip yet — a note, no move
    await settle(); let m = await mark();
    await flick(...(await stickFor(0)));
    await frames(2); const note3 = await noteNow(); await shot('3-hesitation-note');
    await sec(1.2);
    await check('RS forward = hesitation (no clip yet: a note)', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === 'hesi' && r.stick[0].missing && !r.actions.length && /hesitation/i.test(note3 || ''), why: `note "${note3}"` }));
    // ── 4: back-diagonal on the free side = between the legs → the crossover (no clip of its own)
    await settle(); m = await mark(); let h0 = await hand();
    await flick(...(await stickFor(135)));
    await frames(2); const note4 = await noteNow();
    await sec(2.0);
    await check('RS back-diagonal, free side = between the legs → crossover', m, async (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === 'btl' && r.stick[0].fellBack && r.actions.length === 1 && r.actions[0].role === 'move-crossover' && (await hand()) !== h0, why: `note "${note4}"` }));
    // ── 5: straight back = behind the back → the crossover
    await settle(); m = await mark(); h0 = await hand();
    await flick(...(await stickFor(180)));
    await sec(2.0);
    await check('RS straight back = behind the back → crossover', m, async (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === 'btb' && r.stick[0].fellBack && r.actions.length === 1 && r.actions[0].role === 'move-crossover' && (await hand()) !== h0 }));
    // ── 6: toward the ball hand = the in-and-out: no clip yet
    await settle(); m = await mark();
    await flick(...(await stickFor(-90)));
    await frames(2); const note6 = await noteNow();
    await sec(1.0);
    await check('RS toward the ball hand = in-and-out (no clip yet)', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === 'inout' && r.stick[0].missing && !r.actions.length && /in-and-out/i.test(note6 || ''), why: `note "${note6}"` }));
    // ── 7 / 8: a half circle, a quarter circle = the spin
    for (const [label, from, to, ms, pic] of [['half circle = spin', 180, 360, 300, '7-spin'], ['quarter circle = spin', 180, 90, 200, null]]) {
      await settle(); m = await mark();
      await arc(from, to, ms);
      if (pic) { await sec(0.4); await shot(pic); }
      await sec(3.0);
      await check(label, m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].kind === 'spin' && r.stick[0].role === 'move-spin' && r.actions.some((a) => a.role === 'move-spin') && !r.actions.some((a) => a.role !== 'move-spin') }));
    }
    // ── 9: held toward the free hand for 1 s = one hold, one move
    await settle(); m = await mark();
    { const d = await stickFor(90); await queue([...rep(Math.round(FPS), { rs: d }), { rs: [0, 0] }]); await frames(Math.round(FPS) + 1); }
    await sec(1.5);
    await check('RS held toward the free hand 1 s = one move', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].kind === 'hold' && r.stick[0].role === 'move-crossover' && r.actions.filter((a) => a.role === 'move-crossover').length === 1 && r.actions.length === 1 }));
    // ── 10: a flick that overshoots back for one frame = one gesture
    await settle(); m = await mark();
    { const d = await stickFor(90); await queue([...rep(3, { rs: d }), { rs: [-0.5 * d[0], -0.5 * d[1]] }, { rs: [0, 0] }]); await frames(5); }
    await sec(2.0);
    await check('flick with a one-frame overshoot = one gesture', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].kind === 'flick' && r.stick[0].gesture === 'crossover' && r.actions.length === 1 }));
    // ── 11: a crossover flick, then a half circle 0.3 s later = the crossover, then the spin
    await settle(); m = await mark();
    await flick(...(await stickFor(90)));
    await sec(0.3);
    await arc(0, 180, 300);
    await sec(4.0);
    await check('chain: crossover flick, then a half circle', m, (r) => ({ ok: r.actions.map((a) => a.role).join(',') === 'move-crossover,move-spin' && r.stick.length === 2, why: r.actions.map((a) => a.role).join(',') }));
    // ── 12: the shot — the stick while I is held, and while the ball flies: ignored, nothing buffered past the pass back
    await settle(); m = await mark();
    {
      await page.keyboard.down('KeyI');
      let up = false, rel = false, flew = false, caughtAt = null;
      for (let i = 0; i < Math.round(9 * FPS); i++) {
        await frames(1);
        const st = await page.evaluate(() => { const S = window.__court3d, a = S.player.action; return { mode: S.player.mode, t: a?.t ?? null, rel: a?.clip?.shot?.releaseFrame ?? null, s: window.__ball.state(), gameT: S.gameT }; });
        if (!up && i === Math.round(0.2 * FPS)) await flick(...(await stickFor(90)));   // (I held: ignored)
        if (!up && st.mode === 'action' && st.rel != null && st.t >= st.rel - 1.25) { await page.keyboard.up('KeyI'); up = true; }
        if (st.s === 'SHOT_RELEASE') rel = true;
        if (rel && !flew) { flew = true; await sec(0.3); await flick(1, 0, 3, 4); await flick(0, 1, 3, 2); }   // (in the air: no ball — two flicks, past the 150 ms cooldown)
        if (flew && caughtAt == null && /^HELD_/.test(st.s)) caughtAt = st.gameT;
        if (caughtAt != null && st.gameT - caughtAt >= 1.5) break;
      }
      if (!up) await page.keyboard.up('KeyI');
      await check('the stick during a shot does nothing', m, (r) => {
        const after = r.actions.filter((a) => /^move-/.test(a.role));
        return { ok: r.stick.length >= 3 && r.stick.every((g) => g.ignored) && r.stick.some((g) => g.ignored === 'shooting') && r.stick.some((g) => g.ignored === 'no ball') && caughtAt != null && !after.length && r.actions.filter((a) => /^shot-/.test(a.role)).length === 1, why: `caught ${caughtAt}`, extra: { ignored: r.stick.map((g) => g.ignored) } };
      });
    }
    // ── 13: R3 = switch hand (the crossover dribble), no move
    await settle(); m = await mark(); h0 = await hand();
    await btn(11, 1);
    await sec(1.5);
    const h13 = await hand();
    await check('R3 = switch hand', m, (r) => ({ ok: h13 !== h0 && !r.actions.length && r.switches.length === 1 && !r.stick.length, why: `${h0} → ${h13}` }));
    // ── 14: the D-pad turns the camera; the right stick does not
    await settle(); m = await mark();
    {
      const y0 = await camYaw();
      await queue([{ btn: { 15: true } }, ...rep(Math.round(FPS) - 1, {}), { btn: { 15: false } }]); await frames(Math.round(FPS) + 1);
      const y1 = await camYaw();
      await shot('14-dpad-orbit');
      await queue([...rep(Math.round(0.6 * FPS), { rs: [1, 0] }), { rs: [0, 0] }]); await frames(Math.round(0.6 * FPS) + 1);
      const y2 = await camYaw();
      await page.evaluate(() => { window.__court3d.camYaw = 0; });
      await sec(2.0);
      await check('D-pad orbits the camera, the right stick does not', m, () => ({ ok: Math.abs(y1 - y0 - 1.8) <= 0.15 && Math.abs(y2 - y1) < 1e-9, why: `camYaw ${y0.toFixed(2)} → ${y1.toFixed(2)} (D-pad 1 s) → ${y2.toFixed(2)} (RS)` }));
    }
    // ── 15: a side camera — the stick is read on the screen: up = toward his right hand
    await settle(); m = await mark();
    {
      await page.evaluate(() => { const S = window.__court3d, p = S.player.pos, y = S.player.yaw; S.camFixed = { pos: [p[0] + Math.cos(y) * 3.1, 1.05, p[1] - Math.sin(y) * 3.1], look: [p[0], 0.62, p[1]] }; });
      await frames(2);
      const h = await hand();
      await flick(0, -1);
      await frames(2); await shot('15-side-camera');
      await sec(2.0);
      await page.evaluate(() => { window.__court3d.camFixed = null; });
      const want = h === 'left' ? 'crossover' : 'inout';
      await check('side camera: RS up = toward his right hand', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === want, why: `hand ${h}: want ${want}, got ${r.stick[0]?.gesture} θ ${r.stick[0]?.theta}` }));
      await sec(1.0);
    }
    // ── 16: the keyboard — the arrows are the stick; Q / E orbit
    await settle(); m = await mark();
    {
      const h = await hand();
      await page.keyboard.press(h === 'right' ? 'ArrowLeft' : 'ArrowRight');   // (a tap shorter than a frame)
      await sec(2.2);
      await settle();
      // the roll ↓ ↘ → ↗
      await page.keyboard.down('ArrowDown'); await frames(1);
      await page.keyboard.down('ArrowRight'); await frames(1);
      await page.keyboard.up('ArrowDown'); await frames(1);
      await page.keyboard.down('ArrowUp'); await frames(1);
      await page.keyboard.up('ArrowUp'); await page.keyboard.up('ArrowRight'); await frames(1);
      await sec(3.0);
      const y0 = await camYaw();
      await page.keyboard.down('KeyQ'); await sec(0.5); await page.keyboard.up('KeyQ');
      const y1 = await camYaw();
      await page.evaluate(() => { window.__court3d.camYaw = 0; });
      await sec(1.5);
      await check('keyboard: arrow tap = crossover, roll = spin, Q orbits', m, (r) => ({ ok: r.stick.length === 2 && r.stick[0].kind === 'flick' && r.stick[0].gesture === 'crossover' && r.stick[1].kind === 'spin' && r.actions[0]?.role === 'move-crossover' && r.actions.some((a) => a.role === 'move-spin') && y1 < y0 - 0.6, why: `camYaw ${y0.toFixed(2)} → ${y1.toFixed(2)}` }));
    }
    // ── 17: touch — a fast swipe on the touch zone (an iPad without a controller) = a flick
    await settle(); m = await mark();
    {
      const h = await hand();
      // (the whole swipe between two frames: the zone keeps its furthest point for one frame)
      await page.evaluate((dx) => {
        const z = document.getElementById('proZone'), ev = (type, x) => z.dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 300, bubbles: true }));
        ev('pointerdown', 800); ev('pointermove', 800 + dx * 0.5); ev('pointermove', 800 + dx); ev('pointerup', 800 + dx);
      }, h === 'right' ? -90 : 90);
      await sec(2.2);
      await check('touch zone: a swipe toward the free hand = crossover', m, (r) => ({ ok: r.stick.length === 1 && r.stick[0].gesture === 'crossover' && r.actions[0]?.role === 'move-crossover' }));
    }
    // ── 18: the double crossover (live on main as "right stick: flick left, then right"): the ball in the right
    // hand, the chase camera — a flick left, then right; then the keyboard's L
    const toRight = async () => { await settle(); if ((await hand()) !== 'right') { await btn(11, 1); await sec(1.2); await settle(); } return hand(); };
    if (await page.evaluate(() => !!window.__court3d.player.lib['move-double-cross'])) {
      let hR = await toRight(); m = await mark();
      await flick(-1, 0); await flick(1, 0);
      await sec(0.5); await shot('18-double-crossover');
      await sec(2.2);
      let hEnd = await hand();
      await check('RS flick left, then right = double crossover', m, (r) => ({ ok: hR === 'right' && r.stick.length === 2 && r.stick[0].gesture === 'crossover' && r.stick[1].gesture === 'doublecross' && r.stick[1].role === 'move-double-cross' && r.actions.some((a) => a.role === 'move-double-cross' && !a.mirror) && !r.actions.some((a) => a.role === 'move-crossover' && a.t > r.actions.find((b) => b.role === 'move-double-cross').t) && r.catches.some((c) => c.hand === 'left') && hEnd === 'right', why: `hand ${hR} → ${hEnd}` }));
      hR = await toRight(); m = await mark();
      await page.keyboard.press('KeyL');
      await sec(2.6);
      hEnd = await hand();
      await check('keyboard L = double crossover', m, (r) => ({ ok: r.actions.length === 1 && r.actions[0].role === 'move-double-cross' && r.catches.some((c) => c.hand === 'left') && hEnd === 'right', why: `hand ${hR} → ${hEnd}` }));
    } else results.push({ name: 'double crossover', ok: false, why: 'no move-double-cross clip in the library', stick: [], actions: [] });
    await shot('19-end');
  }

  if (ONLY !== 'pro') {
    // ── classic (a second page load): the right stick and the arrows are the camera, ○ the crossover
    await open('&pad=classic');
    await settle();
    let m = await mark();
    const y0 = await camYaw();
    await queue([...rep(Math.round(FPS), { rs: [1, 0] }), { rs: [0, 0] }]); await frames(Math.round(FPS) + 1);
    const y1 = await camYaw();
    await page.evaluate(() => { window.__court3d.camYaw = 0; });
    await sec(1.5);
    await check('classic: the right stick is the camera (no gestures)', m, (r) => ({ ok: Math.abs(y1 - y0 - 1.8) <= 0.15 && !r.stick.length && !r.actions.length, why: `camYaw ${y0.toFixed(2)} → ${y1.toFixed(2)}` }));
    await settle(); m = await mark();
    await btn(1, 1);
    await sec(2.2);
    await check('classic: ○ = crossover', m, (r) => ({ ok: r.actions.length === 1 && r.actions[0].role === 'move-crossover' && !r.stick.length }));
    await settle(); m = await mark();
    const k0 = await camYaw();
    await page.keyboard.down('ArrowRight'); await sec(0.5); await page.keyboard.up('ArrowRight');
    const k1 = await camYaw();
    await check('classic: the arrows turn the camera', m, (r) => ({ ok: k1 > k0 + 0.6 && !r.stick.length && !r.actions.length, why: `camYaw ${k0.toFixed(2)} → ${k1.toFixed(2)}` }));
    await shot('20-classic');
  }

  const report = { fps: FPS, char: CHAR, errors, results, at: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(58)} ${r.clean ? '' : '[NOT CLEAN] '}${r.why ? `(${r.why}) ` : ''}stick [${r.stick.join(' | ')}] · moves [${r.actions.join(' | ')}] · frames ${r.frames} · min y ${r.minY} · lost ${r.lost} · recoveries ${r.recoveries.length} · rejected ${r.rejected} · hands ${r.maxHandDepthMm == null ? '—' : r.maxHandDepthMm > 0 ? r.maxHandDepthMm + ' mm in' : -r.maxHandDepthMm + ' mm clear'} (${r.handFramesOver3mm} > 3 mm)`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('report + screenshots:', OUT);
  await browser.close();
  process.exit(results.length && results.every((r) => r.ok) && !errors.length ? 0 : 1);
})();
