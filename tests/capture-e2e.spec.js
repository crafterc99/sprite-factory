#!/usr/bin/env node
/**
 * Soul Jam Capture — end-to-end test with two simulated devices (Chromium with a fake camera +
 * microphone): a dedicated server (own data dir + a local folder standing in for the bucket), the
 * DIRECTOR (an iPad: 1180×820, also camera A) and CAMERA B (a phone: 390×844).
 *
 * The operator's flow, step by step, every step asserted:
 *   1 Connect — both cameras run the 2 s camera check by themselves; a camera B whose recorder
 *     produces nothing (the iPhone case: 5 bytes, no frames) shows ✗ with the reason and the
 *     director is told during the recording; after the fix the check passes, NEXT unlocks.
 *   2 Calibrate — the goal explained, where each camera stands and where the floor marks go (in
 *     court words), the walk diagram (corners 1–4, the middle), both live views, 3-2-1 → ~21 s at an
 *     easy walk with spoken + written prompts ("Corner one", "Walk to corner 2", lit on the map) →
 *     stops and saves by itself (no review, no landmarks) → "Calibration saved ✓" with both stills.
 *   3 Record — START/FINISH instructions (a move that starts moving never says "hold the start
 *     pose"), the phone layout shows them above the fold; the countdown setting; three animations
 *     back to back (the first stops by itself at its target, the others with STOP), no review:
 *     straight on to the next one.
 *   Animations — every slot with its status (Uploading → Recorded ✓), filters, totals; redo (the
 *     toast's Redo and "Record it again" from the list), MARK BEST; a take whose camera B records
 *     nothing is "Check failed — redo" with the reason, and the director saw it while recording.
 *   Analysis — nothing automatic; a selection, the cost, the server's quote to confirm, the queue
 *     runs (MOCAP_MOCK=1: no money) → "Analysed ✓".
 *
 * Then the production failure modes (each phase reports its own checks; a failed phase is reported
 * and the flow is brought back to a known state before the next one): CANCEL in the countdown ·
 * CANCEL before the cameras' scheduled start (the take is discarded, no recorder left running) ·
 * camera B offline mid-take
 * (chunks kept on the phone) · camera B reloaded mid-take · the director refreshed mid-recording
 * (STOP comes back) · camera B asleep at RECORD (never starts: told within seconds, the take is
 * "needs redo", nothing waits for it) · a second page on camera B's link (USE THIS PHONE, no flapping) · the server
 * killed with its disk wiped (Railway redeploy) · the same mid-upload (409 missing → re-sent) ·
 * home → CONTINUE MISSING · the export's layout.
 *
 * Screenshots of every step at an iPad (1180×820 and 820×1180) and a phone (390×844, 844×390)
 * size, each also checked for horizontal scrolling.
 *
 *   node tests/capture-e2e.spec.js [--port 3461] [--tmp <dir>] [--keep]
 * Screenshots: tests/reports/capture-e2e/ (gitignored). Exit 1 on a failed check.
 * Never touches a real bucket: the server runs with every cloud credential blanked and
 * CAPTURE_CLOUD_DIR=<temp folder> (lib/capture/cloud.js uses that folder as the bucket).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const PORT = +opt('port', 3461), BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'reports', 'capture-e2e'); fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
const DATA = fs.mkdtempSync(path.join(opt('tmp', os.tmpdir()), 'sjc-e2e-'));
const CAP = path.join(DATA, 'capture');          // the server's local disk (CAPTURE_DIR) — wiped in the restart phase
const CLOUD = path.join(DATA, 'bucket');         // stands in for Firebase Storage (CAPTURE_CLOUD_DIR)
const results = [];
let lastCheck = 'start';
const check = (name, ok, detail = '') => { lastCheck = name; results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } }); return r.headers.get('content-type')?.includes('json') ? r.json() : r; };
const oneLine = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const IPAD = { width: 1180, height: 820 }, IPAD_P = { width: 820, height: 1180 }, PHONE = { width: 390, height: 844 }, PHONE_L = { width: 844, height: 390 };

// ── the dedicated server (started again in the restart phases: same port, same bucket folder)
let srv = null, srvLog = '';
const serverEnv = () => {
  const e = { ...process.env, PORT: String(PORT), CAPTURE_DIR: CAP, CAPTURE_CLOUD_DIR: CLOUD, CAPTURE_HTTPS: '0', APP_PASSWORD: '', CAPTURE_DEBUG: '1',
    // no real cloud storage, ever; SAM 3D Body in mock mode (synthetic, no fal.ai, no money), writing into the temp folder
    FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '', FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '', FIREBASE_STORAGE_BUCKET: '',
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', FAL_KEY: '', GITHUB_TOKEN: '', MOCAP_MOCK: '1', MOCAP_DIR: path.join(DATA, 'mocap'), TMP_DIR: path.join(DATA, 'video-tmp') };
  delete e.CAPTURE_CLOUD;                                    // (CAPTURE_CLOUD=0 would switch the bucket folder off)
  return e;
};
async function startServer() {
  const from = srvLog.length;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  let up = false;
  for (let i = 0; i < 60 && child.exitCode == null && child.signalCode == null; i++) { try { const r = await fetch(`${BASE}/api/capture/libraries`); if (r.ok) { up = true; break; } } catch {} await sleep(500); }
  if (!up || child.exitCode != null) { try { child.kill('SIGKILL'); } catch {} throw new Error(`the test server did not start on :${PORT}${child.exitCode != null ? ` (exit ${child.exitCode})` : ''}`); }
  // safety: this server must not have a real bucket configured
  for (let i = 0; i < 40 && !/Storage: /.test(srvLog.slice(from)); i++) await sleep(100);
  const storage = /Storage: ([^\n]*)/.exec(srvLog.slice(from))?.[1] || '';
  if (!/NOT SET/.test(storage)) { process.kill(child.pid, 'SIGKILL'); throw new Error(`refusing to test against real storage ("Storage: ${storage}")`); }
  return child;
}
async function killServer(child, signal = 'SIGKILL') {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const gone = new Promise((r) => child.once('exit', r));
  process.kill(child.pid, signal);                           // this test's own server, by its PID
  await Promise.race([gone, sleep(15000)]);
}

/**
 * Camera B's phone can be "broken" like the user's iPhone: with window.__sjcBroken its
 * MediaRecorder hands out 5-byte chunks and requestVideoFrameCallback never fires.
 */
function breakableRecorder() {
  const Real = window.MediaRecorder, rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (!Real) return;
  const fake = (stream, o) => {
    const r = { state: 'inactive', mimeType: o?.mimeType || 'video/webm', stream, ondataavailable: null, onstop: null, onerror: null,
      start(ts = 1000) { this.state = 'recording'; this.t = setInterval(() => this.ondataavailable?.({ data: new Blob([new Uint8Array([26, 69, 223, 163, 1])], { type: this.mimeType }) }), ts); },
      stop() { if (this.state === 'inactive') return; clearInterval(this.t); this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array([0, 0, 0, 0, 0])], { type: this.mimeType }) }); this.onstop?.(); }, 20); },
      requestData() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} };
    return r;
  };
  window.MediaRecorder = new Proxy(Real, { construct(target, args) { return window.__sjcBroken ? fake(...args) : new target(...args); } });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) { return window.__sjcBroken ? 0 : rvfc.call(this, cb); };
}

(async () => {
  srv = await startServer();
  // one browser per device (like two phones): network emulation (offline) must not leak between them
  const browsers = [];
  const errors = [];
  let netQuiet = false;                                      // the server is down on purpose: connection failures are expected
  const mk = async (name, viewport, { breakable = false } = {}) => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(browser);
    const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
    if (breakable) await ctx.addInitScript(breakableRecorder);
    // what the director says out loud (speech synthesis) — the athlete can't see the iPad
    await ctx.addInitScript(() => { window.__said = []; const ss = window.speechSynthesis; if (ss) { const orig = ss.speak.bind(ss); ss.speak = (u) => { window.__said.push(u.text); try { orig(u); } catch {} }; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
      if (netQuiet && /WebSocket connection to .* failed|ERR_CONNECTION_REFUSED|Failed to fetch/.test(m.text())) return;
      errors.push(`${name} (after "${lastCheck}"): ${m.text().slice(0, 200)}`);
    });
    page.on('dialog', (d) => { errors.push(`${name} (after "${lastCheck}") dialog: ${d.message().slice(0, 200)}`); d.dismiss().catch(() => {}); });
    // every capture WebSocket this page opens, and every "replaced" it is told (flapping detector)
    const ws = { opened: 0, replaced: 0 };
    page.on('websocket', (w) => {
      if (!/\/api\/capture\/ws/.test(w.url())) return;
      ws.opened++;
      w.on('framereceived', (f) => { if (String(f.payload).includes('"t":"replaced"')) ws.replaced++; });
    });
    // the answers to this device's "complete" calls (the 409 {missing} → re-send path)
    const completes = [];
    page.on('response', (r) => { if (/\/api\/capture\/sessions\/[^/]+\/rec\/[^/]+\/cam[AB]\/complete$/.test(r.url())) completes.push(r.status()); });
    return { browser, ctx, page, ws, completes, viewport };
  };
  /** Screenshots at several sizes (viewport, as the operator sees it), each checked for horizontal scrolling. */
  const shots = async (dev, name, sizes = [dev.viewport], { top = true } = {}) => {
    const bad = [];
    for (const vp of sizes) {
      await dev.page.setViewportSize(vp);
      await sleep(350);
      if (top) await dev.page.evaluate(() => window.scrollTo(0, 0));
      const tag = `${vp.width}x${vp.height}`;
      await dev.page.screenshot({ path: path.join(OUT, `${name}-${tag}.png`) });
      const over = await dev.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1) bad.push(`${tag}: ${over}px too wide`);
    }
    await dev.page.setViewportSize(dev.viewport);
    await sleep(200);
    return bad;
  };
  const layoutBad = [];
  const shot = async (dev, name, sizes, o) => { const b = await shots(dev, name, sizes, o); layoutBad.push(...b.map((x) => `${name} ${x}`)); };
  try {
    // ═══ 1 · CONNECT ═══════════════════════════════════════════════════════
    const A = await mk('director', IPAD);
    await A.page.goto(`${BASE}/capture`);
    await A.page.click('#newSession');
    await A.page.waitForURL(/session=/, { timeout: 15000 });
    const sessionId = new URL(A.page.url()).searchParams.get('session');
    check('session created → step 1 Connect', !!sessionId && await A.page.isVisible('#stepConnect'), sessionId);
    const D = (fn, arg) => A.page.evaluate(fn, arg);
    const sess = async () => (await api(`/api/capture/sessions/${sessionId}`)).session;
    await A.page.waitForFunction(() => /^✓/.test(document.getElementById('chkA')?.textContent || ''), null, { timeout: 40000 });
    check('CAM A (this device) passes the camera check by itself', true, await A.page.textContent('#chkA'));
    const pairHref = await A.page.$eval('#pairUrls a', (a) => a.href);
    check('pairing QR + 6-digit code on CAM B\'s tile', /pair=/.test(pairHref) && await A.page.isVisible('#qr svg') && /^\d{6}$/.test((await A.page.textContent('#pairCode')).trim()), (await A.page.textContent('#pairCode')).trim());
    await shot(A, '01-connect-pair', [IPAD, PHONE]);
    for (const vp of [PHONE, PHONE_L, IPAD_P]) {
      await A.page.setViewportSize(vp); await sleep(250);
      const st = await D(() => [...document.querySelectorAll('#stepper button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), in: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.width > 30 }; }));
      check(`${vp.width}×${vp.height}: all five steps are on screen (1 Connect · 2 Calibrate · 3 Record · Animations · Analysis)`, st.length === 5 && st.every((x) => x.in), st.map((x) => `${x.t}${x.in ? '' : ' (OFF SCREEN)'}`).join(' · '));
    }
    await A.page.setViewportSize(IPAD); await sleep(200);

    // camera B: a phone whose recorder produces nothing (the user's iPhone)
    const B = await mk('cameraB', PHONE, { breakable: true });
    await B.page.goto(pairHref);
    await B.page.evaluate(() => { window.__sjcBroken = true; });
    await B.page.click('#camStart', { timeout: 4000 }).catch(() => {});
    let sawRecBanner = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const st = await D(() => ({ chk: document.getElementById('chkB').textContent, banner: document.getElementById('banners').textContent }));
      if (/CAM B (is not recording|'s last recording failed)/.test(st.banner) && !sawRecBanner) sawRecBanner = st.banner;
      if (/^✗/.test(st.chk)) break;
      await sleep(150);
    }
    const chkB = await A.page.textContent('#chkB');
    check('a CAM B that records nothing: the check shows ✗ with the reason', /^✗ Camera check failed/.test(chkB) && /only \d+ bytes/.test(chkB) && /does not decode/.test(chkB), oneLine(chkB, 220));
    check('… and the director is told while it records ("CAM B is not recording" / "CAM B\'s last recording failed")', !!sawRecBanner, oneLine(sawRecBanner, 180));
    check('… NEXT stays locked; "Continue with one camera" is offered', await A.page.isDisabled('#connectNext') && await A.page.isEnabled('#oneCamBtn'));
    const bStatus = await B.page.textContent('#camStatusBox');
    check('camera B\'s own page says its recording failed (not "Saved")', /last recording failed/.test(bStatus) && /5 bytes/.test(bStatus) && !/Saved/.test(bStatus), oneLine(bStatus, 160));
    await shot(A, '02-connect-camB-failed', [IPAD, PHONE]);
    await shot(B, '02-cameraB-failed', [PHONE]);

    // fixed (screen on, page in front): the check again → ✓, NEXT unlocks
    await B.page.evaluate(() => { window.__sjcBroken = false; });
    await A.page.click('#checkBtn');
    await A.page.waitForFunction(() => /^✓/.test(document.getElementById('chkB').textContent) && /^✓/.test(document.getElementById('chkA').textContent), null, { timeout: 40000 });
    check('after the fix: the camera check passes on both, NEXT unlocks', await A.page.isEnabled('#connectNext'), oneLine(await A.page.textContent('#chkB'), 120));
    await A.page.waitForFunction(() => { const i = document.getElementById('snapB'); return i && !i.classList.contains('hidden') && /^data:image\/jpeg/.test(i.src) && i.naturalWidth > 0; }, null, { timeout: 15000 }).catch(() => {});
    const snapB = await D(() => { const i = document.getElementById('snapB'); return { src: i.src.slice(0, 24), w: i.naturalWidth, shown: !i.classList.contains('hidden') }; });
    check('CAM B\'s tile shows its live picture (a small JPEG over the WebSocket)', snapB.shown && snapB.w > 0 && snapB.w <= 320 && /^data:image\/jpeg/.test(snapB.src), `${snapB.w}px wide`);
    const fmt = await B.page.textContent('#camFormat');
    check('camera B shows its format and orientation', /\d+×\d+ · \d+ fps · (landscape|portrait) · (WebM|MP4)/.test(fmt), fmt);
    check('the frame-rate note says 60 fps max in the browser and how to get 120/240', /at most 60 fps/.test(await A.page.textContent('#stepConnect .note')));
    await shot(A, '03-connect-ready', [IPAD, IPAD_P, PHONE]);
    await shot(B, '03-cameraB-waiting', [PHONE, PHONE_L]);

    // ═══ 2 · CALIBRATE ═════════════════════════════════════════════════════
    await A.page.click('#connectNext');
    await A.page.waitForSelector('#stepCalibrate:not(.hidden)');
    const lead = await A.page.textContent('#stepCalibrate .lead');
    check('Calibrate: the goal in plain words, the setup diagram, both live views', /combined into 3-D/.test(lead) && /must not move/.test(lead) && await A.page.$('#calCourt svg') != null && await A.page.isVisible('#calViewB img.snap'), oneLine(lead, 120));
    const place = await A.page.textContent('#calPlace'), marks = await A.page.$$eval('#calMarks li', (l) => l.map((x) => x.textContent)), howto = await A.page.textContent('#calHowto');
    check('… where each camera stands and where the 5 floor marks go, in court words; "head to feet" in both pictures', /CAM A.*sideline.*m from ✕/.test(place) && /CAM B/.test(place) && marks.length === 5 && marks.every((m) => /(m |middle)/.test(m)) && /head to feet/.test(howto) && /cone|tape/.test(howto), `${oneLine(place, 110)} · ${oneLine(marks[1], 70)}`);
    const calSvg = await A.page.$eval('#calCourt svg', (e) => e.outerHTML);
    check('… the diagram shows the calibration walk: corners 1–4 and the middle (no START / FINISH), both cameras', ['>1<', '>2<', '>3<', '>4<', '>✕<', '>A<', '>B<'].every((x) => calSvg.includes(x)) && !/START|FINISH/.test(calSvg));
    await shot(A, '04-calibrate', [IPAD, IPAD_P, PHONE]);
    const calTarget = (await import('../capture/court-layout.mjs')).calibrationSec('A');
    await A.page.click('#calibrateBtn');
    await A.page.waitForSelector('#recOverlay:not(.hidden)');
    const countdown = await A.page.textContent('#ovBig');
    await A.page.waitForSelector('#recOverlay.recording', { timeout: 10000 });
    const recAt = Date.now();
    // the prompts over time: when each corner comes up (an easy walk: corner 2 not before ~4.7 s)
    const seenCues = [];
    let ovMap = '', shotsDone = 0;
    while (await A.page.isVisible('#recOverlay') && Date.now() - recAt < 40000) {
      // the cue and the recording's own timer, read together (the page's clock, not this test's)
      const { c, tSec } = await D(() => ({ c: document.getElementById('ovCue').textContent, tSec: +document.getElementById('ovBig').textContent || 0 })).catch(() => ({ c: '', tSec: 0 }));
      if (c && c !== seenCues[seenCues.length - 1]?.cue) seenCues.push({ cue: c, t: +tSec.toFixed(1) });
      if (!ovMap && /^Walk to corner 1/.test(c)) ovMap = await A.page.$eval('#ovMap svg', (e) => e.outerHTML).catch(() => '');
      if (!shotsDone && /^Walk to corner 2/.test(c)) { shotsDone++; await shot(A, '05-calibrating', [IPAD], { top: false }); }
      else if (shotsDone === 1 && /^Walk to corner 4/.test(c)) { shotsDone++; await shot(A, '05-calibrating-corner4', [PHONE], { top: false }); }
      await sleep(150);
    }
    await A.page.waitForSelector('#recOverlay.hidden', { state: 'attached', timeout: 40000 });
    const calSec = (Date.now() - recAt) / 1000;
    const corners = seenCues.filter((x) => /^Walk to corner/.test(x.cue)).map((x) => +x.cue.match(/corner (\d)/)[1]);
    const c2 = seenCues.find((x) => /^Walk to corner 2/.test(x.cue));
    check(`calibration: 3-2-1, then prompts at an easy walk (corners 1 → 2 → 3 → 4 → the middle, lit on the map), stops by itself after ${calTarget} s`, /^[123]$/.test(countdown.trim()) && corners.join() === '1,2,3,4' && seenCues.some((x) => /^Back to ✕/.test(x.cue)) && c2 && c2.t >= 4.5 && /#ffd166/.test(ovMap) && calSec > calTarget - 1.5 && calSec < calTarget + 3, `countdown "${countdown}" · ${seenCues.map((x) => `${x.t}s ${x.cue.replace(/ \(.*\)/, '')}`).join(' → ')} · ${calSec.toFixed(1)} s`);
    const said = await D(() => window.__said || []);
    const hasVoice = await D(() => typeof window.speechSynthesis !== 'undefined');
    check('… the iPad says the corners out loud (the athlete can\'t see its screen)', !hasVoice || ['Corner one', 'Corner two', 'Corner three', 'Corner four', 'Back to the middle'].every((w) => said.includes(w)), hasVoice ? said.join(' · ') : 'no speech synthesis in this browser');
    await A.page.waitForSelector('#calSaved', { timeout: 60000 });
    await A.page.waitForFunction(() => [...document.querySelectorAll('#calSaved .stills img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => {});
    const stills = await A.page.$$eval('#calSaved .stills img', (is) => is.map((i) => i.naturalWidth));
    let s = await sess();
    check('"Calibration saved ✓" by itself, with both cameras\' stills (no review, no landmarks)', s.calibrations.A?.status === 'valid' && s.currentSetup === 'A' && stills.length === 2 && stills.every((w) => w > 0) && await A.page.$('#landmarkBox') == null, `stills ${stills.join(' + ')} px wide`);
    await shot(A, '06-calibration-saved', [IPAD, PHONE]);

    // ═══ 3 · RECORD ════════════════════════════════════════════════════════
    await A.page.click('#calNext');
    await A.page.waitForSelector('#stepRecord:not(.hidden)');
    const head = await A.page.textContent('#recPos'), title1 = await A.page.textContent('#animTitle');
    const svg = await A.page.$eval('#animCourt svg', (e) => e.outerHTML);
    const instr = { start: await A.page.textContent('#startPose'), startW: await A.page.textContent('#startWhere'), marks: await A.page.textContent('#startMarks'), finish: await A.page.textContent('#finishPose'), protocol: await A.page.textContent('#protocol') };
    check('Record: "#1 of 82 · Setup A", the name, a START/FINISH diagram, start + finish pose, where in court words, the protocol', /#1 of 82 · Setup A/.test(head) && title1 === 'NEUTRAL IDLE' && /START/.test(svg) && instr.start.length > 5 && instr.finish.length > 5 && /free-throw line/.test(instr.marks) && /stops by itself/.test(instr.protocol), `${oneLine(head, 60)} · ${title1} · start "${instr.start}" ${instr.startW} · ${instr.marks}`);
    await shot(A, '07-record', [IPAD, IPAD_P, PHONE, PHONE_L]);
    // a phone in portrait: the start → finish summary and RECORD without scrolling
    await A.page.setViewportSize(PHONE); await sleep(300); await A.page.evaluate(() => window.scrollTo(0, 0));
    const fold = await D(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const c = r('recCompact'), b = r('recordBtn'), ct = r('animCourt'); return { compact: c.height > 0 && c.bottom <= innerHeight, record: b.height > 0 && b.top >= 0 && b.bottom <= innerHeight, court: ct.bottom <= innerHeight - 60, text: document.getElementById('recCompact').textContent }; });
    await A.page.setViewportSize(IPAD); await sleep(200);
    check('390×844: the start → finish summary, the diagram and RECORD are on screen without scrolling', fold.compact && fold.record && fold.court, `${fold.text} · compact ${fold.compact} · court ${fold.court} · RECORD ${fold.record}`);
    // a move that starts already moving never says "hold the start pose"
    const layIdx = (await import('../capture/protocol.mjs')).captureOrder((await import('../capture/basic01.mjs')).BASIC01).findIndex((a) => a.key === 'pullback_R');
    await D((i) => { const d = window.__capture; d.current = d.order[i]; d.render(); }, layIdx);
    await sleep(300);
    const mv = { proto: await A.page.textContent('#protocol'), startW: await A.page.textContent('#startWhere'), finishW: await A.page.textContent('#finishWhere') };
    check('a move that starts moving (PULLBACK): "cross START already moving", never "hold the start pose"; FINISH 1.5 m back, in words', !/Hold the start pose/i.test(mv.proto) && /already moving/i.test(mv.proto) && /already .* as you cross START/.test(mv.startW) && /about 1\.5 m backward/.test(mv.finishW), `${oneLine(mv.proto, 90)} · ${oneLine(mv.startW, 80)}`);
    await shot(A, '07-record-moving-start', [IPAD, PHONE]);
    // the countdown is a setting kept on this device (3 / 5 / 10 s)
    await A.page.click('#countdownSeg button[data-cd="5"]');
    const cd5 = await D(() => [window.__capture.countdown, localStorage.getItem('sjc-countdown')]);
    await A.page.click('#countdownSeg button[data-cd="3"]');
    check('countdown setting: 5 s is kept on the device (back to 3 s for the test)', cd5[0] === 5 && cd5[1] === '5' && await D(() => window.__capture.countdown) === 3, JSON.stringify(cd5));
    // a one-shot with a path (START → FINISH) for the screenshots
    const order = (await import('../capture/protocol.mjs')).captureOrder((await import('../capture/basic01.mjs')).BASIC01);
    const driveIdx = order.findIndex((a) => a.key === 'jab_drive_R');
    await D((i) => { const d = window.__capture; d.current = d.order[i]; d.render(); }, driveIdx);
    await sleep(300);
    const svg2 = await A.page.$eval('#animCourt svg', (e) => e.outerHTML);
    check('a move with a path: START and FINISH marks, the finish pose', />START</.test(svg2) && />FINISH</.test(svg2) && /FINISH|mark/.test(await A.page.textContent('#finishWhere')), oneLine(await A.page.textContent('#finishWhere'), 80));
    await shot(A, '07-record-drive', [IPAD, PHONE]);
    await D(() => { const d = window.__capture; d.current = d.order[0]; d.render(); });
    await sleep(300);

    const waitRecordable = async () => { try { await A.page.waitForFunction(() => !document.getElementById('recordBtn').disabled, null, { timeout: 30000 }); } catch { throw new Error('RECORD stayed disabled: ' + await A.page.textContent('#recordWhy')); } };
    const clickEl = (page, sel) => page.evaluate((q) => document.querySelector(q).click(), sel);
    const title = () => A.page.textContent('#animTitle');
    /** RECORD → 3-2-1 → recording; stop after `ms` (or let it stop by itself: ms = null). Returns the take id + what was recorded. */
    const recordTake = async (ms = 2400, { onRecording = null } = {}) => {
      await waitRecordable();
      const before = await title();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recOverlay.recording', { timeout: 12000 });
      const tid = await D(() => window.__capture.rec?.take?.id || null);
      const at = Date.now();
      if (onRecording) await onRecording(tid);
      if (ms != null) { const left = ms - (Date.now() - at); if (left > 0) await sleep(left); await clickEl(A.page, '#stopBtn'); }
      await A.page.waitForSelector('#recOverlay.hidden', { state: 'attached', timeout: 20000 });
      return { tid, before, after: await title(), sec: (Date.now() - at) / 1000 };
    };

    // #1: stops by itself at its target (an 8 s loop)
    let shotRec = false;
    const r1 = await recordTake(null, { onRecording: async () => { await sleep(2500); await shot(A, '08-recording', [IPAD, PHONE], { top: false }); await shot(B, '08-cameraB-recording', [PHONE]); shotRec = true; } });
    const toast1 = await A.page.textContent('#toastMsg').catch(() => '');
    check('#1 stops by itself at its target (8 s), the next animation is up at once — no review', r1.sec > 7 && r1.sec < 10.5 && r1.after !== r1.before && /recorded|saved/.test(toast1) && await A.page.$('#acceptBtn') == null, `${r1.before} (${r1.sec.toFixed(1)} s) → ${r1.after} · "${oneLine(toast1, 80)}"`);
    await shot(A, '09-after-take', [IPAD, PHONE]);
    // #2, #3 with STOP, back to back
    const r2 = await recordTake(2400), r3 = await recordTake(2400);
    const ids = [r1.tid, r2.tid, r3.tid];
    check('three animations back to back, each straight on to the next', r2.after !== r2.before && r3.after !== r3.before && new Set([r1.before, r2.before, r3.before]).size === 3 && ids.every(Boolean), `${r1.before} → ${r2.before} → ${r3.before} → ${r3.after}`);

    // ═══ ANIMATIONS ════════════════════════════════════════════════════════
    await clickEl(A.page, '#stepper button[data-step="slots"]');
    await A.page.waitForSelector('#stepSlots:not(.hidden)');
    const statusOf = (key) => D((k) => { const a = window.__capture.lib.animations.find((x) => x.key === k); return document.querySelector(`.slot[data-anim="${a.id}"]`)?.dataset.status; }, key);
    const keys = await D((ids) => ids.map((id) => { for (const [aid, e] of Object.entries(window.__capture.session.animations)) if (e.takes.includes(id)) return window.__capture.lib.animations.find((a) => a.id === aid).key; return null; }), ids);
    const seen = new Set();
    const t1 = Date.now();
    for (;;) {
      const st = await Promise.all(keys.map(statusOf)); st.forEach((x) => seen.add(x));
      if (st.every((x) => x === 'recorded') || Date.now() - t1 > 60000) break;
      await sleep(250);
    }
    const final = await Promise.all(keys.map(statusOf));
    const totals = await A.page.textContent('#slotTotals');
    check('the list: the three slots go Uploading → Recorded ✓ (saved only once the bucket has them)', final.every((x) => x === 'recorded') && /3 \/ 82 recorded/.test(totals), `seen ${[...seen].join(', ')} · ${oneLine(totals, 80)}`);
    const rowsAll = await A.page.$$eval('.slot', (e) => e.length);
    await clickEl(A.page, '#slotFilter button[data-filter="todo"]'); await sleep(300);
    const rowsTodo = await A.page.$$eval('.slot', (e) => e.length);
    await clickEl(A.page, '#slotFilter button[data-filter="all"]'); await sleep(300);
    check('filters: All shows 82 slots grouped by setup, To record the 79 left', rowsAll === 82 && rowsTodo === 79 && (await A.page.$$('.group')).length === 3, `all ${rowsAll} · to record ${rowsTodo}`);
    const bucketSel = JSON.parse(fs.readFileSync(path.join(CLOUD, '_meta', 'capture', 'sessions', sessionId, 'session.json'), 'utf8'));
    check('recorded = in the bucket: each slot\'s selected take and its result are in the bucket\'s session.json', ids.every((id) => Object.values(bucketSel.animations).some((e) => e.selectedTake === id && e.results?.[id]?.state === 'recorded')));
    await shot(A, '10-animations', [IPAD, IPAD_P, PHONE]);

    // redo from the list: "Record it again" on #2, MARK BEST in its takes
    const k2 = keys[1];
    await D((k) => { const a = window.__capture.lib.animations.find((x) => x.key === k); document.querySelector(`.slot[data-anim="${a.id}"]`).click(); }, k2);
    await A.page.waitForSelector('#slotSheet:not(.hidden) .takes > div', { timeout: 10000 });
    await shot(A, '11-slot-takes', [IPAD, PHONE]);
    await A.page.click('#slotSheet button[data-act="sheetRecord"]');
    await A.page.waitForSelector('#stepRecord:not(.hidden)');
    const redoTitle = await title();
    const r2b = await recordTake(2400);
    const animOf = (key) => D((k) => window.__capture.lib.animations.find((x) => x.key === k).id, key);
    const a2 = await animOf(k2);
    const waitSel = async (aid, tid, ms = 60000) => { const t = Date.now(); for (;;) { const e = (await sess()).animations[aid]; if (e?.selectedTake === tid) return e; if (Date.now() - t > ms) return e; await sleep(300); } };
    let e2 = await waitSel(a2, r2b.tid);
    check('redo from the list ("Record it again"): a second take, the newest becomes the selected one', redoTitle === r2b.before && e2.takes.length === 2 && e2.selectedTake === r2b.tid, `${redoTitle}: takes ${e2.takes.length}, selected take ${e2.takes.indexOf(e2.selectedTake) + 1}`);
    await clickEl(A.page, '#stepper button[data-step="slots"]');
    await D((aid) => document.querySelector(`.slot[data-anim="${aid}"]`).click(), a2);
    await A.page.waitForSelector(`#slotSheet button[data-sel="${r2.tid}"]`, { timeout: 10000 });
    await A.page.click(`#slotSheet button[data-sel="${r2.tid}"]`);
    e2 = await waitSel(a2, r2.tid, 10000);
    check('MARK BEST on the first take makes it the selected one', e2.selectedTake === r2.tid);
    await A.page.click('#slotSheet button[data-act="sheetClose"]');

    // redo from the toast, right after a take
    await clickEl(A.page, '#stepper button[data-step="record"]');
    const r4 = await recordTake(2200);
    const redoShown = await A.page.isVisible('#toastRedo');
    await A.page.click('#toastRedo');
    await sleep(300);
    const backTo = await title();
    const r4b = await recordTake(2200);
    const animOfTake = (tid) => D((t) => Object.entries(window.__capture.session.animations).find(([, e]) => e.takes.includes(t))?.[0] || null, tid);
    const e4 = await waitSel(await animOfTake(r4b.tid), r4b.tid);
    check('the toast\'s Redo (shown for a few seconds) goes back to the one just recorded; the new take is selected', redoShown && backTo === r4.before && r4b.before === r4.before && e4?.selectedTake === r4b.tid, `${r4.before} → Redo → ${backTo}`);

    // a take where camera B records nothing: told during the take, then "Check failed — redo"
    await B.page.evaluate(() => { window.__sjcBroken = true; });
    let warnDuring = '';
    const r5 = await recordTake(3600, { onRecording: async () => { const t = Date.now(); while (Date.now() - t < 3300) { const w = await A.page.textContent('#ovWarn'); if (w && !warnDuring) { warnDuring = w; await shot(A, '12-recording-camB-failing', [IPAD], { top: false }); } await sleep(150); } } });
    await B.page.evaluate(() => { window.__sjcBroken = false; });
    const a5 = await animOfTake(r5.tid);
    let st5 = null; const t5 = Date.now();
    while (Date.now() - t5 < 60000) { st5 = (await import('../capture/protocol.mjs')).slotStatus(await sess(), a5); if (st5.status !== 'uploading') break; await sleep(400); }
    await clickEl(A.page, '#stepper button[data-step="slots"]');
    await sleep(500);
    const row5 = await D((aid) => document.querySelector(`.slot[data-anim="${aid}"]`)?.textContent, a5);
    check('CAM B records nothing: the director sees it during the take (in the recording screen)', /CAM B is not recording/.test(warnDuring), oneLine(warnDuring, 160));
    check('… the slot says "Check failed — redo" with the reason; nothing waited for a review', st5?.status === 'failed' && /camB/.test(st5.reason) && /Check failed/.test(row5) && /CAM B: /.test(row5), oneLine(row5, 200));
    await shot(A, '13-animations-failed', [IPAD, PHONE]);
    // redo it (camera B fixed)
    await D((aid) => document.querySelector(`.slot[data-anim="${aid}"]`).click(), a5);
    await A.page.waitForSelector('#slotSheet button[data-act="sheetRecord"]');
    await A.page.click('#slotSheet button[data-act="sheetRecord"]');
    const r5b = await recordTake(2400);
    const e5 = await waitSel(a5, r5b.tid);
    check('… recorded again: Recorded ✓', e5?.selectedTake === r5b.tid, `${r5b.before}`);

    // ═══ ANALYSIS ══════════════════════════════════════════════════════════
    await clickEl(A.page, '#stepper button[data-step="analysis"]');
    await A.page.waitForSelector('#stepAnalysis:not(.hidden)');
    await A.page.waitForFunction(() => document.querySelectorAll('#anaList input[data-take]').length >= 5, null, { timeout: 15000 });
    const nAna = await A.page.$$eval('#anaList input[data-take]', (e) => e.filter((x) => x.checked).length);
    const total0 = await A.page.textContent('#anaTotal');
    check('Analysis: nothing sent by itself; every recorded animation listed and selected, with the cost', nAna >= 5 && /about \$\d+\.\d\d/.test(total0) && !(await sess()).analysisQueue?.length, `${nAna} selected · ${total0}`);
    await shot(A, '14-analysis', [IPAD, PHONE]);
    await A.page.click('#anaNone');
    await A.page.click('#anaList input[data-take]');
    const pick = await A.page.$eval('#anaList input[data-take]', (e) => e.dataset.take);
    await A.page.click('#anaSend');
    await A.page.waitForSelector('#anaConfirm:not(.hidden) #anaYes', { timeout: 10000 });
    const conf = await A.page.textContent('#anaConfirm');
    const queuedBefore = (await api(`/api/capture/sessions/${sessionId}/rec/${pick}`)).take.analysis;
    check('"Send to analysis" asks to confirm the cost first (the server\'s own quote); nothing is queued yet', /about \$\d+\.\d\d/.test(conf) && !queuedBefore, oneLine(conf, 160));
    await shot(A, '15-analysis-confirm', [IPAD, PHONE], { top: false });
    await A.page.click('#anaYes');
    let an = null; const ta = Date.now();
    while (Date.now() - ta < 90000) { an = (await api(`/api/capture/sessions/${sessionId}/rec/${pick}`)).take.analysis; if (['done', 'error'].includes(an?.state)) break; await sleep(500); }
    // the screen follows the WebSocket (not the 2.5 s poll): "done" shows within moments
    await A.page.waitForFunction(() => /done/.test(document.getElementById('anaQueue').textContent), null, { timeout: 15000 }).catch(() => {});
    const qtext = await A.page.textContent('#anaQueue');
    check('confirmed: queued → runs (SAM 3D Body in mock mode, no money) → done, shown in the queue', an?.state === 'done' && /^mo-/.test(an.motionId) && /done/.test(qtext), `${an?.state} ${an?.motionId || an?.error || ''}`);
    await shot(A, '16-analysis-done', [IPAD, PHONE]);
    await clickEl(A.page, '#stepper button[data-step="slots"]');
    await sleep(500);
    const analysedRows = await A.page.$$eval('.slot[data-status="analysed"]', (e) => e.length);
    check('the analysed slot says "Analysed ✓" in the list', analysedRows === 1, `${analysedRows} analysed`);

    // ═══ production failure modes ═══════════════════════════════════════════
    const takeOf = async (id) => (await api(`/api/capture/sessions/${sessionId}/rec/${id}`)).take;
    /** A saved take's "selected" mark follows its "accepted" a moment later (after the session's selection). */
    const selectedTake = async (id, ms = 8000) => { let t; for (const t0 = Date.now(); ;) { t = await takeOf(id); if (t.selected || Date.now() - t0 > ms) return t; await sleep(200); } };
    const bothReady = (timeout = 40000) => A.page.waitForFunction(() => ['camA', 'camB'].every((c) => window.__capture?.presence?.[c]?.ready), null, { timeout });
    const heldOn = (page, director) => page.evaluate(async (dir) => { const u = dir ? window.__capture?.cam?.uploader : window.__capture?.role?.uploader; return u ? (await u.pending()).held : 0; }, director).catch(() => 0);
    const waitHeld = async (page, director, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await heldOn(page, director) > 0) return true; await sleep(100); } return false; };
    const camUp = async (page) => {
      await page.waitForFunction(() => !!window.__capture?.role, null, { timeout: 15000 });
      await page.waitForFunction(() => document.getElementById('camTap')?.classList.contains('hidden'), null, { timeout: 3000 }).catch(() => clickEl(page, '#camStart'));
    };
    /** A take moves on by itself: wait until it is saved (accepted) or needs a redo (failed). */
    const settled = async (id, ms = 60000, { finishAfter = null } = {}) => {
      const t = Date.now(); let tk = null, finished = false;
      while (Date.now() - t < ms) {
        tk = await takeOf(id);
        if (['accepted', 'failed', 'rejected'].includes(tk.state)) return tk;
        if (finishAfter && !finished && Date.now() - t > finishAfter) { finished = true; await api(`/api/capture/sessions/${sessionId}/rec/${id}/finish`, { method: 'POST', body: '{}' }).catch(() => {}); }
        await sleep(300);
      }
      throw new Error(`take ${id} did not settle in ${ms / 1000} s (state ${tk?.state})`);
    };
    const decodeFails = (t) => (t?.validation?.checks || []).filter((c) => /^decode-/.test(c.id) || /does not decode/.test(c.msg));
    const goRecord = async () => { await clickEl(A.page, '#stepper button[data-step="record"]'); await A.page.waitForSelector('#stepRecord:not(.hidden)'); };
    let B2 = null;
    /** After a failed phase: nothing recording, camera B back on its first page, both cameras READY. */
    const recover = async () => {
      if (B2) { await B2.browser.close().catch(() => {}); browsers.splice(browsers.indexOf(B2.browser), 1); B2 = null; }
      netQuiet = false;
      await B.ctx.setOffline(false).catch(() => {});
      await B.page.evaluate(() => { window.__sjcBroken = false; const l = window.__capture?.role?.link; if (l?.replaced || l?.denied) l.reopen(); }).catch(() => {});
      if (await D(() => !!window.__capture?.rec).catch(() => false)) { await clickEl(A.page, '#stopBtn').catch(() => {}); await sleep(4000); }
      await A.page.goto(`${BASE}/capture?session=${sessionId}#record`);
      await bothReady(45000);
    };
    const phase = async (name, fn) => {
      try { await fn(); }
      catch (e) {
        check(`${name} (phase)`, false, oneLine(e.message, 300));
        await A.page.screenshot({ path: path.join(OUT, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
        await recover();
      }
    };

    await goRecord();
    await bothReady();

    // CANCEL during the countdown: no take at all
    await phase('cancel in the countdown', async () => {
      await waitRecordable();
      const n0 = Object.values((await sess()).animations).reduce((x, e) => x + e.takes.length, 0);
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recOverlay:not(.hidden)');
      const label = await A.page.textContent('#stopBtn');
      await sleep(400);
      await clickEl(A.page, '#stopBtn');
      await A.page.waitForSelector('#recOverlay.hidden', { state: 'attached', timeout: 5000 });
      await sleep(3000);
      const n1 = Object.values((await sess()).animations).reduce((x, e) => x + e.takes.length, 0);
      check('CANCEL in the 3-2-1: no take is made, nothing records', label === 'CANCEL' && n1 === n0 && !(await D(() => window.__capture.cam?.cam.recording)), `button "${label}" · takes ${n0} → ${n1}`);
    });

    // STOP before the cameras' scheduled start (the 0.8 s lead): no recorder left running
    await phase('quick STOP', async () => {
      await waitRecordable();
      const q = await A.page.evaluate(async () => {
        document.getElementById('recordBtn').click();
        const t0 = performance.now();
        while (!window.__capture.rec?.recAt && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 5));
        const lead = window.__capture.rec?.recAt ? window.__capture.clock.toLocal(window.__capture.rec.recAt) - Date.now() : null;
        const take = window.__capture.rec?.take?.id;
        document.getElementById('stopBtn').click();
        return { take, lead: Math.round(lead) };
      });
      await sleep(2000);                                     // well past the scheduled start: a leftover recorder would be running now
      const recs = { A: await D(() => ({ rec: window.__capture.cam?.cam.cur?.rec?.state || 'none', recording: !!window.__capture.cam?.cam.recording })), B: await B.page.evaluate(() => ({ rec: window.__capture.role.cam.cur?.rec?.state || 'none', recording: !!window.__capture.role.cam.recording })) };
      const tq = await settled(q.take, 45000);
      const idle = ['A', 'B'].every((k) => ['inactive', 'none'].includes(recs[k].rec) && !recs[k].recording);
      const slotQ = (await import('../capture/protocol.mjs')).slotStatus(await sess(), tq.animId);
      check(`CANCEL ${q.lead} ms before the cameras' scheduled start: no recorder left running, the take is discarded (not a failed slot)`, q.lead > 0 && idle && tq.state === 'rejected' && slotQ.status !== 'failed' && slotQ.status !== 'uploading', `A ${recs.A.rec} · B ${recs.B.rec} · take ${tq.state} · slot ${slotQ.status}`);
      const r = await recordTake(2400);
      const t = await settled(r.tid);
      const bad = decodeFails(t), info = ['camA', 'camB'].map((c) => t.cameras?.[c]?.fileInfo);
      check('… the next take decodes on camA and camB', t.state === 'accepted' && !bad.length && info.every((i) => i?.ok && i.durationSec >= 1), bad.length ? bad.map((c) => c.msg).join('; ') : `camA ${info[0]?.durationSec} s · camB ${info[1]?.durationSec} s`);
    });

    // camera B's network drops mid-take: its chunks wait on the phone and upload after reconnect
    await phase('camera B offline mid-take', async () => {
      await bothReady();
      const r = await recordTake(3200, { onRecording: async () => { await sleep(1200); await B.ctx.setOffline(true); } });
      await sleep(2000);
      const pend = await B.page.evaluate(() => window.__capture.role.uploader.pending());
      check('offline camera B keeps its chunks on the phone', pend.chunks + pend.finals > 0, JSON.stringify({ chunks: pend.chunks, finals: pend.finals, held: pend.held }));
      await B.ctx.setOffline(false);
      const t = await settled(r.tid, 90000);
      check('after reconnect the take completes with both cameras and is saved', t.state === 'accepted' && t.cameras?.camA?.file && t.cameras?.camB?.file, `${t.state} · camB ${t.cameras?.camB?.bytes} B`);
    });

    // camera B's page reloaded mid-take: its partial recording is finished from the phone
    await phase('camera B reload mid-take', async () => {
      await bothReady();
      let hadChunk = false, at = 0;
      const r = await recordTake(null, { onRecording: async () => {
        const t0 = Date.now();
        hadChunk = await waitHeld(B.page, false);          // its first 1 s chunk is on the phone
        at = Date.now() - t0;
        await B.page.reload();
        await camUp(B.page);
        await A.page.waitForFunction(() => window.__capture.presence?.camB?.ready, null, { timeout: 30000 });
        await sleep(600);
        await clickEl(A.page, '#stopBtn');
      } });
      check('camera B reloaded mid-take: re-pairs by itself (the pairing is in its link)', true, `reloaded ${at} ms into the take${hadChunk ? ' with a chunk on the phone' : ''}`);
      const t = await settled(r.tid, 90000, { finishAfter: 20000 });
      const b = t.cameras?.camB;
      const pendB = await B.page.evaluate(() => window.__capture.role.uploader.pending());
      const ok = hadChunk ? b?.file && !!b.interrupted && b.upload?.chunks >= 1 && pendB.held === 0 && pendB.finals === 0 : (t.finishedWithout || []).includes('camB');
      check('… the take settles with B\'s partial recording (nothing stuck)', ['accepted', 'failed'].includes(t.state) && ok, `${t.state} · camB ${b?.file || 'NO FILE'} ${b?.bytes ?? ''} B, interrupted ${!!b?.interrupted}${t.failReason ? ' · ' + t.failReason : ''}`);
    });

    // the director page refreshed mid-recording: the recording screen with STOP is back and works
    await phase('director refresh mid-recording', async () => {
      await bothReady();
      await waitRecordable();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recOverlay.recording', { timeout: 12000 });
      const tid = await D(() => window.__capture.rec?.take?.id);
      const hadChunk = await waitHeld(A.page, true);
      await A.page.reload();
      const back = await A.page.waitForSelector('#recOverlay:not(.hidden)', { timeout: 15000 }).then(() => true, () => false);
      const st = await D(() => ({ phase: window.__capture?.phase, take: window.__capture?.rec?.take?.id, stop: !!document.querySelector('#stopBtn')?.offsetParent, top: document.getElementById('ovTop')?.textContent }));
      check('director refreshed mid-recording: the recording screen with STOP is back', back && st.phase === 'recording' && st.take === tid && st.stop, oneLine(st.top, 80));
      if (!back) throw new Error('no recording screen after the refresh');
      await sleep(500);
      await clickEl(A.page, '#stopBtn');
      const t = await settled(tid, 60000);
      const stopped = await D(() => window.__capture.stopFor == null);
      const bRec = await B.page.evaluate(() => window.__capture.role.cam.cur?.rec?.state || 'none');
      check('… STOP works (camera B halts) and the take settles by itself', ['accepted', 'failed'].includes(t.state) && t.sync?.stopAtServerMs && t.cameras?.camB?.file && !t.cameras.camB.stopCapped && stopped && bRec === 'inactive' && (hadChunk ? !!t.cameras?.camA?.interrupted : true),
        `${t.state} · camA ${t.cameras?.camA?.file || '—'}${t.cameras?.camA?.interrupted ? ' (interrupted, from the device)' : ''} · camB ${t.cameras?.camB?.file || '—'} · B recorder ${bRec}${t.failReason ? ' · ' + t.failReason : ''}`);
    });

    // camera B asleep at RECORD (READY a moment ago, its page no longer acts on anything): the hub
    // notices within seconds, the director is told in the recording screen, nothing waits for B
    await phase('camera B asleep at RECORD', async () => {
      await bothReady();
      await B.page.evaluate(() => { const r = window.__capture.role; r.__orig = r.onMessage; r.onMessage = (m) => (m.t === 'record' ? undefined : r.__orig.call(r, m)); });
      let warn = '';
      const r = await recordTake(5500, { onRecording: async () => { const t = Date.now(); while (Date.now() - t < 5000 && !/did not start recording/.test(warn)) { warn = await A.page.textContent('#ovWarn'); await sleep(150); } } });
      await B.page.evaluate(() => { const r = window.__capture.role; r.onMessage = r.__orig; delete r.__orig; });
      check('camera B asleep at RECORD: the recording screen says "CAM B did not start recording" within seconds', /CAM B did not start recording/.test(warn), oneLine(warn, 140));
      const t = await settled(r.tid, 30000);
      const toast = await A.page.textContent('#toast').catch(() => '');
      const banner = await A.page.textContent('#banners');
      check('… the take does not wait for it: "needs redo" (CAM B never started), the director is told', t.state === 'failed' && /camB never started recording/.test(t.failReason || '') && /(did not start|never started) recording/.test(toast + banner), `${t.state} · ${oneLine(t.failReason, 100)} · ${oneLine(toast || banner, 100)}`);
      await shot(A, '16b-camB-asleep', [IPAD, PHONE]);
    });

    // a second page opens camera B's link: the newest page takes the role, the first one says so
    // and stays off (no ping-pong); USE THIS PHONE takes it back
    await phase('second page on camera B', async () => {
      await bothReady();
      const devB1 = await B.page.evaluate(() => localStorage.getItem('sjc-device'));
      B2 = await mk('cameraB-second', PHONE);
      const s1 = { ...B.ws };
      await B2.page.goto(pairHref);
      await camUp(B2.page);
      await B.page.waitForFunction(() => !!document.querySelector('#camBanner [data-act=takeover]'), null, { timeout: 15000 });
      const l1 = await B.page.evaluate(() => { const l = window.__capture.role.link; return { replaced: !!l.replaced, closed: !!l.closed, open: !!l.open, banner: document.getElementById('camBanner').textContent }; });
      check('second page on camera B\'s link: the first page shows USE THIS PHONE and stops', l1.replaced && l1.closed && !l1.open, oneLine(l1.banner, 120));
      await shot(B, '17-cameraB-replaced', [PHONE]);
      const holder = new Set();
      for (let i = 0; i < 16; i++) { holder.add(await D(() => window.__capture.presence?.camB?.deviceId || '—')); await sleep(500); }
      const d1 = { opened: B.ws.opened - s1.opened, replaced: B.ws.replaced - s1.replaced }, d2 = { ...B2.ws };
      const dev2 = await B2.page.evaluate(() => localStorage.getItem('sjc-device'));
      check('no reconnect flapping over 8 s', d1.replaced + d2.replaced <= 1 && d1.opened === 0 && d2.opened === 1 && holder.size === 1 && holder.has(dev2),
        `first page: ${d1.opened} new socket(s), ${d1.replaced} replaced · second page: ${d2.opened} socket(s) · holders: ${[...holder].map((h) => (h === dev2 ? 'second page' : h === devB1 ? 'first page' : h)).join(', ')}`);
      const s2 = { b1: { ...B.ws }, b2: { ...B2.ws } };
      await B.page.evaluate(() => document.querySelector('#camBanner [data-act=takeover]').click());
      const back = await A.page.waitForFunction((id) => window.__capture.presence?.camB?.deviceId === id && window.__capture.presence.camB.ready, devB1, { timeout: 15000 }).then(() => true, () => false);
      const l2 = await B2.page.waitForFunction(() => window.__capture.role.link.replaced, null, { timeout: 10000 }).then(() => true, () => false);
      await sleep(4000);
      const e1 = { opened: B.ws.opened - s2.b1.opened, replaced: B.ws.replaced - s2.b1.replaced }, e2x = { opened: B2.ws.opened - s2.b2.opened, replaced: B2.ws.replaced - s2.b2.replaced };
      const still = await D(() => window.__capture.presence?.camB?.deviceId);
      check('USE THIS PHONE takes camera B back (the second page stops, no flapping)', back && l2 && still === devB1 && e1.opened === 1 && e1.replaced === 0 && e2x.opened === 0 && e2x.replaced === 1,
        `first page: ${e1.opened} socket(s) · second page: ${e2x.opened} new, ${e2x.replaced} replaced · camB now ${still === devB1 ? 'the first page' : still}`);
      await B2.browser.close(); browsers.splice(browsers.indexOf(B2.browser), 1); B2 = null;
      await bothReady();
    });

    // Railway redeploy: the server killed, its disk wiped, started again on the same bucket
    await phase('server restart with the disk wiped', async () => {
      await bothReady();
      const before = await api(`/api/capture/sessions/${sessionId}`);
      const saved = Object.entries(before.session.animations).filter(([, e]) => e.selectedTake).map(([aid, e]) => ({ aid, tid: e.selectedTake }));
      const sockets0 = A.ws.opened, socketsB0 = B.ws.opened;
      netQuiet = true;
      await killServer(srv, 'SIGKILL');
      const down = await A.page.waitForFunction(() => !window.__capture.link.open, null, { timeout: 15000 }).then(() => true, () => false);
      fs.rmSync(CAP, { recursive: true, force: true });
      const bootAt = Date.now();
      srv = await startServer();
      await A.page.waitForFunction(() => window.__capture.link.open, null, { timeout: 30000 });
      const fresh = await A.page.waitForFunction((since) => ['camA', 'camB'].every((c) => window.__capture.presence?.[c]?.ready && window.__capture.presence[c].lastSeen >= since), bootAt, { timeout: 45000 }).then(() => true, () => false);
      await bothReady(45000);
      netQuiet = false;
      check('restart with the disk wiped: the director and both cameras reconnect on their own', down && fresh && A.ws.opened > sockets0 && B.ws.opened > socketsB0, `new sockets: director page ${A.ws.opened - sockets0}, camera B ${B.ws.opened - socketsB0}`);
      const after = await api(`/api/capture/sessions/${sessionId}`);
      check('restart: progress unchanged (read back from the bucket)', after.progress?.complete === before.progress.complete
        && JSON.stringify(Object.fromEntries(Object.entries(after.session.animations).map(([k, e]) => [k, e.selectedTake]))) === JSON.stringify(Object.fromEntries(Object.entries(before.session.animations).map(([k, e]) => [k, e.selectedTake]))), `${after.progress?.complete} complete (before ${before.progress.complete})`);
      const last = saved[saved.length - 1], lt = await takeOf(last.tid);
      const url = `/api/capture/sessions/${sessionId}/rec/${last.tid}/camA/video`;
      const vr = await fetch(BASE + url), vbytes = (await vr.arrayBuffer()).byteLength;
      const played = await D(async (src) => {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = src; document.body.appendChild(v);
        try {
          await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('media error ' + (v.error?.code ?? '?'))); setTimeout(() => rej(new Error('no data in 10 s')), 10000); });
          await v.play();
          const t1 = performance.now();
          while (v.currentTime < 0.3 && performance.now() - t1 < 8000) await new Promise((r) => setTimeout(r, 100));
          return { ok: v.currentTime >= 0.3, t: +v.currentTime.toFixed(2) };
        } catch (e) { return { ok: false, err: e.message }; } finally { v.pause(); v.remove(); }
      }, url);
      check('restart: a saved take\'s video still plays', vr.status === 200 && vbytes === lt.cameras?.camA?.bytes && played.ok, `HTTP ${vr.status} · ${vbytes} B · played to ${played.t ?? '—'} s${played.err ? ' · ' + played.err : ''}`);
      await goRecord();
      const r = await recordTake(2400);
      await settled(r.tid);
      const t = await selectedTake(r.tid);
      const inBucket = ['camA', 'camB'].every((c) => t.cameras?.[c]?.file && fs.existsSync(path.join(CLOUD, '_meta', 'capture', 'sessions', sessionId, 'takes', r.tid, t.cameras[c].file)));
      check('restart: a new take is recorded and saved (files and record in the bucket)', t.state === 'accepted' && t.selected && inBucket && !decodeFails(t).length, `${t.animKey} · in bucket ${inBucket}`);
    });

    // a redeploy MID-UPLOAD: camera B offline when the take stops, the server restarts with an
    // empty disk, B comes back: 409 {missing} → it sends those chunks again from its phone
    await phase('server restart mid-upload', async () => {
      await bothReady();
      await waitRecordable();
      const c0 = B.completes.length;
      let had = [];
      const r = await recordTake(null, { onRecording: async (tid) => {
        let p = null; const w0 = Date.now();
        while (Date.now() - w0 < 8000) { p = await B.page.evaluate(() => window.__capture.role.uploader.pending()); if (p.held > p.chunks) break; await sleep(100); }
        had = (await api(`/api/capture/sessions/${sessionId}/rec/${tid}/camB/status`)).have || [];
        if (!(p?.held > p?.chunks) || !had.length) throw new Error(`camera B had not uploaded a chunk yet (${JSON.stringify(p)}, server has ${JSON.stringify(had)})`);
        await B.ctx.setOffline(true);
        await sleep(1000);
        await clickEl(A.page, '#stopBtn');
      } });
      const w1 = Date.now(); let ta = null;
      while (Date.now() - w1 < 20000) { ta = await takeOf(r.tid); if (ta.cameras?.camA?.file) break; await sleep(300); }
      if (!ta?.cameras?.camA?.file) throw new Error('camera A did not upload before the redeploy');
      netQuiet = true;
      await killServer(srv, 'SIGKILL');
      fs.rmSync(CAP, { recursive: true, force: true });
      srv = await startServer();
      await B.ctx.setOffline(false);
      let t;
      try { t = await settled(r.tid, 90000); } finally { netQuiet = false; }
      const b = t.cameras?.camB || {}, codes = B.completes.slice(c0);
      const pendB = await B.page.evaluate(() => window.__capture.role.uploader.pending());
      check('redeploy mid-upload: B re-sends the chunks the server lost (409 missing) and the take is saved', t.state === 'accepted' && b.file && codes.includes(409) && codes[codes.length - 1] === 200 && !decodeFails(t).length && pendB.held === 0 && pendB.kept === 0,
        `server had chunk(s) ${had.join(',')} · B's "complete" answers: ${codes.join(' → ') || 'none'} · B's phone ${JSON.stringify({ held: pendB.held, kept: pendB.kept })}`);
    });

    // home → CONTINUE MISSING → straight to the Record step at the next animation to record
    await phase('continue missing', async () => {
      await A.page.goto(`${BASE}/capture`);
      await A.page.waitForSelector('#sessions a');
      const row = await A.page.textContent('#sessions');
      await shot(A, '18-home', [IPAD, PHONE]);
      await A.page.click('#sessions a button');
      await A.page.waitForSelector('#stepRecord:not(.hidden)', { timeout: 15000 });
      await A.page.waitForFunction(() => document.querySelector('#animTitle').textContent !== '—');
      const s2 = await sess();
      const next = (await import('../capture/protocol.mjs')).nextToRecord((await import('../capture/basic01.mjs')).BASIC01, s2);
      check('home → CONTINUE MISSING opens the Record step at the next animation to record', (await title()) === next.title && /complete · \d+ missing/.test(row), `${next.key} · ${oneLine(row, 100)}`);
    });

    // the export: the organised dataset (saved takes only by default)
    await phase('export', async () => {
      const tarFile = path.join(DATA, 'export.tar');
      const r = await fetch(`${BASE}/api/capture/sessions/${sessionId}/export.tar`);
      fs.writeFileSync(tarFile, Buffer.from(await r.arrayBuffer()));
      const names = execFileSync('tar', ['-tf', tarFile]).toString().trim().split('\n');
      const has = (re) => names.some((n) => re.test(n));
      check('export: session.json + calibration/setup_A/cal01 with both cameras', has(/^SoulJam_BASIC01\/session\.json$/) && has(/calibration\/setup_A\/cal01\/camA\.(webm|mp4)$/) && has(/calibration\/setup_A\/cal01\/camB\./) && has(/calibration\/setup_A\/cal01\/metadata\.json$/));
      check('export: setup_A/<animation>/takeNN with camA, camB, frame times, metadata', has(/^SoulJam_BASIC01\/setup_A\/[a-zA-Z0-9_]+\/take01\/camA\.(webm|mp4)$/) && has(/take01\/camB\./) && has(/take01\/camA\.frames\.json$/) && has(/take01\/metadata\.json$/));
      const failedTake = await takeOf(r5.tid);
      check('export: only saved takes (the take whose camera B recorded nothing is left out)', failedTake.state === 'failed' && !names.some((n) => n.includes(`/${failedTake.animKey}/take${String(failedTake.takeNo).padStart(2, '0')}/`)), `${failedTake.animKey} take ${failedTake.takeNo}`);
      const x = path.join(DATA, 'x'); fs.mkdirSync(x); execFileSync('tar', ['-xf', tarFile, '-C', x]);
      const md = names.find((n) => /setup_A\/.*take01\/metadata\.json$/.test(n));
      const meta = JSON.parse(fs.readFileSync(path.join(x, md), 'utf8'));
      check('take metadata: states, sync, per-camera track / clock / frames / recorder', meta.startState && meta.endState && meta.sync?.startAtServerMs && meta.cameras?.camA?.clock && meta.cameras?.camB?.track?.frameRate && meta.cameras?.camA?.frames?.fps > 0 && meta.cameras?.camA?.recorder?.mimeType, `A ${meta.cameras?.camA?.track?.width}×${meta.cameras?.camA?.track?.height}@${meta.cameras?.camA?.track?.frameRate} · ${meta.cameras?.camA?.recorder?.mimeType}`);
    });
    check('layout: no horizontal scrolling at any screenshot size', !layoutBad.length, layoutBad.slice(0, 6).join(' · '));
  } catch (e) {
    check('run', false, e.message);
  } finally {
    check('no page errors', !errors.length, errors.slice(0, 5).join(' | '));
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, errors, at: new Date().toISOString() }, null, 1));
    fs.writeFileSync(path.join(OUT, 'server.log'), srvLog);
    for (const b of browsers) await b.close().catch(() => {});
    if (srv && srv.exitCode == null && srv.signalCode == null) { const gone = new Promise((r) => srv.once('exit', r)); srv.kill(); await Promise.race([gone, sleep(5000)]); if (srv.exitCode == null && srv.signalCode == null) process.kill(srv.pid, 'SIGKILL'); }
    if (!argv.includes('--keep')) fs.rmSync(DATA, { recursive: true, force: true });
    else console.log('data kept in', DATA);
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length} passed · ${bad.length} failed`);
    if (bad.length) console.log('server log tail:\n' + srvLog.split('\n').slice(-15).join('\n'));
    process.exit(bad.length ? 1 : 0);
  }
})().catch((e) => { console.error('✖ could not start:', e.message); if (srv) try { process.kill(srv.pid, 'SIGKILL'); } catch {} process.exit(1); });
