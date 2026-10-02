#!/usr/bin/env node
/**
 * The move controls on the real court (court3d.html in Chromium, Playwright, a virtual clock: every frame exactly
 * 1/FPS s; a synthetic standard gamepad) — a NEW animation set up and tested the way the user will:
 *
 *   new move     an existing clip ("Crossover cut · Kimodo") is given a brand-new role, move-pullback-cross, through
 *                PUT /api/mocap3d/clip/:id — it appears in the court's move registry by itself
 *   API combo    PUT /api/mocap3d/controls/move-pullback-cross { steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' }:
 *                the court loads it; on the gamepad's right stick, ball in the right hand: back-diagonal on the free
 *                side, then toward the ball hand → that clip plays (nothing before it: the combo waits)
 *   wait ends    the first flick alone → the gap runs out → its own move plays, late (between the legs → crossover)
 *   record       window.__controls.startRecording(role) → forward, then back on the stick → the steps, the conflicts
 *                → setTrigger (saved on the server) → performed → the clip plays
 *   panel        M opens the temporary debug panel: every move, the new one with its clip and trigger
 *
 * Every scenario is also checked frame by frame like tests/pro-stick-court.spec.js (the ball never through the floor,
 * never lost, no recovery, no rejected transition, the hand skin ≤ 3 mm into the ball).
 *
 * It starts its OWN server (node server.js on --port, default 3474; killed by PID at the end) on its own folders: a
 * clone of the clip library (APFS clone: instant) — so giving a clip a new role never touches the real one — a temp
 * controls file and a stand-in bucket folder; every storage credential is blanked (no real bucket is written).
 *
 *   node tests/move-controls-court.spec.js [--char ac-001] [--fps 30] [--port 3474] [--keep]
 *
 * Writes tests/reports/move-controls-court/<char>-<fps>fps/ (gitignored). Exit code 1 on a failed check.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const FPS = +opt('fps', 30), CHAR = opt('char', 'ac-001'), PORT = +opt('port', 3474), KEEP = argv.includes('--keep');
const REPO = path.resolve(__dirname, '..'), BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'reports', 'move-controls-court', `${CHAR}-${FPS}fps`);
fs.mkdirSync(OUT, { recursive: true });
const NEW_ROLE = 'move-pullback-cross';

// ── the isolated server ───────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-court-'));
const MOCAP = path.join(TMP, 'mocap'), CTRL = path.join(TMP, 'disk', 'move-controls.json'), BUCKET = path.join(TMP, 'bucket');
let server = null;
function startServer() {
  const src = fs.realpathSync(path.join(REPO, 'data', 'mocap'));
  try { execFileSync('cp', ['-Rc', src + '/', MOCAP]); } catch { execFileSync('cp', ['-R', src + '/', MOCAP]); }
  const env = {
    ...process.env, PORT: String(PORT), MOCAP_DIR: MOCAP, MOVE_CONTROLS_FILE: CTRL, MOVE_CONTROLS_CLOUD_DIR: BUCKET,
    CAPTURE_HTTPS: '0', CAPTURE_DIR: path.join(TMP, 'capture'), APP_PASSWORD: '',
    FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '',
    FIREBASE_PRIVATE_KEY_ID: '', FIREBASE_STORAGE_BUCKET: '', project_id: '', client_email: '', private_key: '', private_key_id: '',
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_PUBLIC_URL: '', STORAGE_BACKEND: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', FAL_KEY: '',
  };
  for (const k of ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'NODE_OPTIONS']) delete env[k];
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (c) => { log = (log + c).slice(-20000); }); proc.stderr.on('data', (c) => { log = (log + c).slice(-20000); });
  server = { proc, log: () => log, exited: new Promise((r) => proc.once('exit', r)) };
}
async function stopServer() {
  if (server && server.proc.exitCode === null) { process.kill(server.proc.pid, 'SIGKILL'); await server.exited; }
  if (!KEEP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on('exit', () => { try { if (server?.proc.exitCode === null) process.kill(server.proc.pid, 'SIGKILL'); } catch {} });
function api(method, p, body) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(BASE + p, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (q) => {
      const ch = []; q.on('data', (c) => ch.push(c)); q.on('end', () => { const t = Buffer.concat(ch).toString(); let j = null; try { j = JSON.parse(t); } catch {} res({ status: q.statusCode, j, t }); });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

(async () => {
  const results = [], errors = [];
  let browser = null;
  try {
    startServer();
    for (let i = 0; ; i++) {
      if (server.proc.exitCode !== null) throw new Error('server exited:\n' + server.log().slice(-3000));
      const h = await api('GET', '/api/health').catch(() => null);
      if (h?.status === 200) break;
      if (i > 600) throw new Error('server did not answer /api/health:\n' + server.log().slice(-3000));
      await new Promise((r) => setTimeout(r, 100));
    }
    // ── a new animation: an existing clip given a brand-new move role (in the cloned library)
    const lib = (await api('GET', '/api/mocap3d/library')).j;
    // ("Crossover cut · Kimodo": clean from a standstill, and the crossover keeps its standing variant "Crossover (generated)" —
    // with only "Crossover on the move (generated)" left, a standing crossover misses its catch by 2 cm, button or stick alike)
    const onCourt = (c) => c.game.role === 'move-crossover' && lib.court.some((x) => x.id === c.id);
    const clip = lib.clips.find((c) => c.name === 'Crossover cut · Kimodo' && onCourt(c)) || lib.clips.find((c) => onCourt(c) && !/\(generated\)$/.test(c.name)) || lib.clips.find(onCourt);
    if (!clip) throw new Error('no crossover clip in the library to turn into a new move');
    let r = await api('PUT', `/api/mocap3d/clip/${clip.id}`, { role: NEW_ROLE });
    if (r.status !== 200) throw new Error(`PUT clip role: ${r.status} ${r.t}`);
    // ── its trigger: a brand-new 2-step combo, through the API
    const COMBO = { steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' };
    r = await api('PUT', `/api/mocap3d/controls/${NEW_ROLE}`, COMBO);
    if (r.status !== 200) throw new Error(`PUT controls: ${r.status} ${r.t}`);
    const regApi = r.j.moves.find((m) => m.role === NEW_ROLE);
    results.push({ name: 'API: the new move is in the registry with its clip and its trigger', ok: !!regApi && regApi.available && regApi.custom && regApi.clips.some((c) => c.id === clip.id) && regApi.arrows[0] === '↙ →' && r.j.savedToCloud === true, why: JSON.stringify(regApi && { clips: regApi.clips.map((c) => c.name), arrows: regApi.arrows, switchesHand: regApi.switchesHand }), stick: [], actions: [] });

    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
    // virtual clock (as tests/pro-stick-court.spec.js): every rendered frame is exactly 1/FPS s of game time
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
    // a synthetic standard gamepad: window.__padQ holds the next frames' states ({ rs: [x, y] }, kept until changed)
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
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    const frames = (n) => page.evaluate((n) => new Promise((res) => { window.__vt.budget = n; const w = () => (window.__vt.budget <= 0 ? res() : setTimeout(w, 5)); w(); }), n);
    const sec = (s) => frames(Math.round(s * FPS));
    const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });

    await page.goto(`${BASE}/court3d.html?char=${CHAR}&balldbg=1`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__c3dReady || window.__c3dFailed, null, { timeout: 240000 });
    if (!(await page.evaluate(() => !!window.__c3dReady && !!window.__ball))) throw new Error('court did not start: ' + (await page.evaluate(() => document.getElementById('err')?.textContent)));
    await page.waitForFunction(() => window.__court3d.loadingRest === 0, null, { timeout: 180000 });
    const info = await page.evaluate(() => window.__controls.ready);
    await page.addStyleTag({ content: '#help,#vid{display:none!important}' });
    // the frame recorder (as tests/pro-stick-court.spec.js)
    await page.evaluate(() => {
      const S = window.__court3d, B = window.__ball.session, P = S.player;
      window.__rec = { frames: [], catches: [], recoveries: [], actions: [] };
      const step = B.step.bind(B);
      B.step = function (...a) {
        const out = step(...a);
        const Hd = this.lastHands ? ['left', 'right'].map((h) => this.lastHands[h]?.depth).filter((d) => d != null) : [];
        window.__rec.frames.push({ t: +this.t.toFixed(4), s: out.state, y: +out.p[1].toFixed(4), hand: Hd.length ? +Math.max(...Hd).toFixed(4) : null, skin: !!this.hc });
        for (const e of out.events) { if (e.type === 'catch') window.__rec.catches.push({ t: +e.t.toFixed(3), hand: e.hand }); if (e.type === 'recovery') window.__rec.recoveries.push({ t: +e.t.toFixed(3), reason: e.reason }); }
        return out;
      };
      const up = P.update.bind(P);
      P.update = function (...a) {
        const r = up(...a);
        for (const e of r.events) if (e.type === 'action') window.__rec.actions.push({ t: +(S.gameT || 0).toFixed(3), role: e.role, clip: e.clip, mirror: !!e.mirror });
        return r;
      };
    });
    await page.mouse.click(900, 420);
    await sec(1.0);

    const mark = () => page.evaluate(() => ({ f: window.__rec.frames.length, a: window.__rec.actions.length, s: window.__stick.log().length, t: window.__court3d.gameT }));
    const since = (m) => page.evaluate((m) => { const R = window.__rec, t0 = R.frames[m.f]?.t ?? m.t ?? 0; return { frames: R.frames.slice(m.f), actions: R.actions.slice(m.a), stick: window.__stick.log().slice(m.s), catches: R.catches.filter((c) => c.t >= t0), recoveries: R.recoveries.filter((c) => c.t >= t0) }; }, m);
    const check = async (name, m, own) => {
      const r = await since(m), F = r.frames, minY = Math.min(...F.map((f) => f.y));
      const lost = F.filter((f) => f.s === 'LOOSE').length, rejected = await page.evaluate(() => window.__ball.session.ctl.rejected);
      const hd = F.filter((f) => f.hand != null), handOver3 = hd.filter((f) => f.hand > 0.003).length;
      const clean = minY >= 0.116 && !lost && !r.recoveries.length && !rejected && F.some((f) => f.skin) && handOver3 === 0;
      let o = { ok: true, why: '' };
      try { o = (await own(r)) || o; } catch (e) { o = { ok: false, why: 'threw: ' + e.message }; }
      results.push({ name, ok: clean && o.ok, clean, why: o.why || '', frames: F.length, minY: +minY.toFixed(4), lost, recoveries: r.recoveries, rejected, handFramesOver3mm: handOver3,
        stick: r.stick.map((g) => g.waiting ? `waiting for ${g.waiting.join(',')}` : g.ignored ? `ignored: ${g.ignored}` : `${g.kind} ${g.binding}${g.role && g.role !== g.binding ? ' → ' + g.role : ''}${g.combo ? ' (combo)' : ''}${g.late != null ? ` late ${g.late} ms` : ''}`),
        actions: r.actions.map((a) => `${a.role} ${a.clip}${a.mirror ? ' (mirror)' : ''} @${a.t}`) });
      return r;
    };
    const queue = (seq) => page.evaluate((seq) => { window.__padQ.push(...seq); }, seq);
    const rep = (n, s) => Array.from({ length: n }, () => s);
    const hand = () => page.evaluate(() => { const B = window.__ball.session, h = B.ctl.heldHand; return h === 'left' || h === 'right' ? h : B.ctl.flight?.toHand || window.__court3d.player.hand; });
    const settle = async (maxS = 3) => { for (let i = 0; i < maxS * FPS; i += 3) { const ok = await page.evaluate(() => { const B = window.__ball.session, P = window.__court3d.player; return P.mode === 'loco' && !P.switchPending && (B.ctl.heldHand === 'left' || B.ctl.heldHand === 'right') && !B.buffer.length; }); if (ok) return true; await frames(3); } return false; };
    const toRight = async () => { await settle(); if ((await hand()) !== 'right') { await queue([{ btn: { 11: true } }, { btn: { 11: false } }]); await frames(2); await sec(1.2); await settle(); } return hand(); };
    /** The stick direction [x, y-down] for a BINDING angle (0 forward, 90 the ball hand, 270 the free hand) as the screen is now. */
    const stickFor = (bindA) => page.evaluate((bindA) => {
      const S = window.__court3d, P = S.player, B = window.__ball.session;
      const h0 = B.ctl.heldHand, hand = h0 === 'left' || h0 === 'right' ? h0 : B.ctl.flight?.toHand || P.hand;
      const theta = -bindA;   // (θ: + toward the free hand)
      const f = [S.camLook.x - S.camPos.x, S.camLook.z - S.camPos.z], fl = Math.hypot(f[0], f[1]); f[0] /= fl; f[1] /= fl;
      const r = [-f[1], f[0]], fw = [Math.sin(P.yaw), Math.cos(P.yaw)], left = [Math.cos(P.yaw), -Math.sin(P.yaw)], off = hand === 'left' ? [-left[0], -left[1]] : left;
      const c = Math.cos((theta * Math.PI) / 180), s = Math.sin((theta * Math.PI) / 180), w = [fw[0] * c + off[0] * s, fw[1] * c + off[1] * s];
      return [w[0] * r[0] + w[1] * r[1], -(w[0] * f[0] + w[1] * f[1])];
    }, bindA);
    /** Flicks of binding angles, each out for 3 frames and back for 1 (both directions read before either is sent). */
    const flicks = async (...angles) => { const ds = []; for (const a of angles) ds.push(await stickFor(a)); await queue(ds.flatMap((d) => [...rep(3, { rs: d }), { rs: [0, 0] }])); await frames(ds.length * 4); };

    // ── the bindings reached the court
    {
      const st = await page.evaluate((role) => ({ mine: window.__controls.get().bindings.filter((b) => b.role === role), reg: window.__controls.registry().find((m) => m.role === role), info: window.__controls.info() }), NEW_ROLE);
      results.push({ name: 'court: the saved bindings and the new move are loaded', ok: info.source === 'saved' && JSON.stringify(st.mine) === JSON.stringify([{ role: NEW_ROLE, ...COMBO }]) && !!st.reg && st.reg.available && st.reg.clips.some((c) => c.name === clip.name), why: JSON.stringify({ info, reg: st.reg && { clips: st.reg.clips.map((c) => c.name), switchesHand: st.reg.switchesHand } }), stick: [], actions: [] });
    }
    // ── 1: the API's combo on the gamepad: back-diagonal on the free side, then toward the ball hand → the new clip
    let hR = await toRight(), m = await mark();
    await flicks(225, 90);
    await sec(0.3); await shot('1-pullback-cross');
    await sec(2.2);
    await check('RS 225° then 90° (the API\'s new combo) = the new clip, nothing before it', m, (r) => {
      const reads = r.stick.filter((g) => !g.waiting && !g.ignored), act = r.actions.find((a) => a.role === NEW_ROLE);
      return { ok: hR === 'right' && r.stick[0]?.waiting?.includes(NEW_ROLE) && reads.length === 1 && reads[0].binding === NEW_ROLE && reads[0].combo && reads[0].role === NEW_ROLE && !!act && act.clip === clip.name && r.actions[0]?.role === NEW_ROLE, why: `hand ${hR}` };
    });
    // ── 2: the first flick alone: the wait runs out, its own move plays late (between the legs → the crossover)
    hR = await toRight(); m = await mark();
    await flicks(225);
    await sec(2.4);
    await check('RS 225° alone: the wait runs out → between the legs (→ crossover), late', m, (r) => {
      const reads = r.stick.filter((g) => !g.waiting && !g.ignored);
      return { ok: r.stick[0]?.waiting && reads.length === 1 && reads[0].binding === 'move-btl' && reads[0].late >= 340 && r.actions.length >= 1 && r.actions[0].role === reads[0].role && !r.actions.some((a) => a.role === NEW_ROLE), why: `late ${reads[0]?.late} ms → ${reads[0]?.role}` };
    });
    // ── 3: record a new trigger on the stick (the designed UI's path: window.__controls), save it, play it
    hR = await toRight(); m = await mark();
    {
      await page.evaluate((role) => { window.__recDone = null; window.__controls.startRecording(role).then((x) => { window.__recDone = x; }); }, NEW_ROLE);
      await flicks(0, 180);
      await sec(1.0);
      const rec = await page.evaluate(() => window.__recDone);
      const saved = rec && !rec.cancelled ? await page.evaluate(({ role, b }) => window.__controls.setTrigger(role, b).then((x) => ({ ok: x.ok, status: x.status, mine: x.controls?.bindings.filter((y) => y.role === role) })), { role: NEW_ROLE, b: rec.binding }) : null;
      const onServer = (await api('GET', '/api/mocap3d/controls?moves=0')).j.controls.bindings.filter((b) => b.role === NEW_ROLE);
      await settle();
      const m2 = await mark();
      await flicks(0, 180);
      await sec(0.3); await shot('3-recorded-trigger');
      await sec(2.2);
      const r3 = await since(m2);
      const act = r3.actions.find((a) => a.role === NEW_ROLE);
      await check('record: forward then back on the stick → saved → plays the new clip', m, (r) => ({
        ok: !!rec && !rec.cancelled && JSON.stringify(rec.steps) === JSON.stringify([{ flick: 0 }, { flick: 180 }]) && rec.conflicts.some((c) => c.role === 'move-hesi' && c.type === 'extends')
          && saved?.ok && JSON.stringify(onServer) === JSON.stringify([{ role: NEW_ROLE, steps: [{ flick: 0 }, { flick: 180 }], mode: 'wait' }])
          && !r.actions.slice(0, r.actions.length - r3.actions.length).length && !!act && act.clip === clip.name && r3.actions[0]?.role === NEW_ROLE,
        why: JSON.stringify({ steps: rec?.steps, conflicts: rec?.conflicts?.map((c) => `${c.type} ${c.role}`), saved: saved?.status, onServer: onServer.map((b) => b.steps) }),
      }));
    }
    // ── 4: the temporary panel (M): every move, the new one with its clip and trigger
    await page.keyboard.press('KeyM'); await frames(3);
    const panel = await page.evaluate((role) => ({ shown: getComputedStyle(document.getElementById('mcPanel')).display !== 'none', row: document.querySelector(`#mcRows tr[data-role="${role}"]`)?.textContent || '', rows: document.querySelectorAll('#mcRows tr').length }), NEW_ROLE);
    await shot('4-panel');
    await page.keyboard.press('KeyM'); await frames(2);
    const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('mcPanel')).display === 'none');
    results.push({ name: 'panel: M shows every move, the new one with its clip and trigger', ok: panel.shown && hidden && panel.rows >= 9 && /Pullback cross/.test(panel.row) && panel.row.includes(clip.name) && /↑ ↓/.test(panel.row), why: JSON.stringify(panel), stick: [], actions: [] });
  } catch (e) {
    results.push({ name: 'run', ok: false, why: e.stack || e.message, stick: [], actions: [] });
  } finally {
    try { await browser?.close(); } catch {}
    await stopServer();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ fps: FPS, char: CHAR, errors, results, at: new Date().toISOString() }, null, 1));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(70)} ${r.clean === false ? '[NOT CLEAN] ' : ''}${r.why ? `(${r.why}) ` : ''}${r.stick.length ? `stick [${r.stick.join(' | ')}] ` : ''}${r.actions.length ? `· moves [${r.actions.join(' | ')}]` : ''}${r.frames ? ` · frames ${r.frames} · min y ${r.minY} · lost ${r.lost} · recoveries ${r.recoveries.length} · rejected ${r.rejected} · hands>3mm ${r.handFramesOver3mm}` : ''}`);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  console.log('report + screenshots:', OUT);
  process.exit(results.length && results.every((r) => r.ok) && !errors.length ? 0 : 1);
})();
