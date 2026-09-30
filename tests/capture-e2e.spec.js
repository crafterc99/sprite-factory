#!/usr/bin/env node
/**
 * Soul Jam Capture — end-to-end test with two simulated devices (Chromium with a fake camera +
 * microphone): a dedicated server (own data dir + a local folder standing in for the bucket), the
 * DIRECTOR (also camera A) and CAMERA B.
 *
 *   pairing (QR link) → both READY → calibrate setup A → record → retake → record → ACCEPT + NEXT
 *   → SAVED ✓ and the next missing animation → refresh (resume) → a take with camera B's network
 *   dropped mid-recording (IndexedDB queue → uploads after reconnect) → camera B page reload →
 *   home: CONTINUE MISSING → export (tar layout) — every step asserted.
 *
 * Then the production failure modes (each phase reports its own checks; a failed phase is reported
 * and the flow is brought back to a known state before the next one):
 *   quick STOP (RECORD → STOP in ~200 ms, before the scheduled start) → retake → a normal take that
 *   decodes on both cameras · camera B's page reloaded mid-take (recoverInterrupted finishes B's
 *   partial recording) · the director page refreshed mid-recording (STOP is back and works) · a
 *   second page opening camera B's link (USE THIS PHONE, no reconnect flapping) · the server killed,
 *   its local disk wiped, started again on the same bucket (Railway redeploy): reconnect, progress,
 *   video, export and a new take all come back from the bucket · the same redeploy while camera B
 *   is offline mid-upload (the chunks it had sent are gone: 409 {missing} → re-sent from the phone).
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
const DATA = fs.mkdtempSync(path.join(opt('tmp', os.tmpdir()), 'sjc-e2e-'));
const CAP = path.join(DATA, 'capture');          // the server's local disk (CAPTURE_DIR) — wiped in the restart phase
const CLOUD = path.join(DATA, 'bucket');         // stands in for Firebase Storage (CAPTURE_CLOUD_DIR)
const results = [];
let lastCheck = 'start';
const check = (name, ok, detail = '') => { lastCheck = name; results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } }); return r.headers.get('content-type')?.includes('json') ? r.json() : r; };
const oneLine = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// ── the dedicated server (started again in the restart phase: same port, same bucket folder)
let srv = null, srvLog = '';
const serverEnv = () => {
  const e = { ...process.env, PORT: String(PORT), CAPTURE_DIR: CAP, CAPTURE_CLOUD_DIR: CLOUD, CAPTURE_HTTPS: '0', APP_PASSWORD: '', CAPTURE_DEBUG: '1',
    // no real cloud storage, ever
    FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '', FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '', FIREBASE_STORAGE_BUCKET: '',
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' };
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

(async () => {
  srv = await startServer();
  // one browser per device (like two phones): network emulation (offline) must not leak between them
  const browsers = [];
  const errors = [];
  let netQuiet = false;                                      // the server is down on purpose: connection failures are expected
  const mk = async (name) => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(browser);
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, permissions: ['camera', 'microphone'] });
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
    return { browser, ctx, page, ws, completes };
  };
  const shot = (page, n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  try {
    // 1. director creates a BASIC-01 session from the home page
    const A = await mk('director');
    await A.page.goto(`${BASE}/capture`);
    await A.page.click('#newSession');
    await A.page.waitForURL(/session=/, { timeout: 15000 });
    const sessionId = new URL(A.page.url()).searchParams.get('session');
    check('session created', !!sessionId, sessionId);
    await A.page.waitForFunction(() => document.querySelector('#pillAtxt')?.textContent.startsWith('READY'), null, { timeout: 30000 });
    check('CAM A ready (this phone)', true, await A.page.textContent('#pillAtxt'));
    // 2. pair camera B with the QR link
    await A.page.click('#pairBtn');
    await A.page.waitForSelector('#qr svg', { timeout: 10000 });
    const pairHref = await A.page.$eval('#pairUrls a', (a) => a.href);
    check('pairing QR + link shown', /pair=/.test(pairHref), (await A.page.textContent('#pairCode')));
    await shot(A.page, '1-director-pair');
    const B = await mk('cameraB');
    await B.page.goto(pairHref);
    // one tap to start the camera (skipped by the page itself when the permission is already granted)
    await B.page.click('#camStart', { timeout: 4000 }).catch(() => {});
    await A.page.waitForFunction(() => document.querySelector('#pillBtxt')?.textContent.startsWith('READY'), null, { timeout: 30000 });
    check('CAM B ready after one tap', true, await A.page.textContent('#pillBtxt'));
    const fmt = await B.page.textContent('#camFormat');
    check('camera B reports its negotiated format', /\d+×\d+ · \d+ fps/.test(fmt), fmt);
    await shot(B.page, '2-cameraB-ready');
    // 3. setup A: calibrate
    await A.page.waitForSelector('#setupCard:not(.hidden)');
    check('setup A card with the court diagram', await A.page.$('#setupCourt svg') != null, await A.page.textContent('#setupTitle'));
    await shot(A.page, '3-setup-A');
    await A.page.click('#calibrateBtn');
    await A.page.waitForSelector('#recordingBox:not(.hidden)', { timeout: 10000 });
    await sleep(2600);
    await A.page.click('#stopBtn');
    await A.page.waitForFunction(() => /ACCEPT/.test(document.querySelector('#acceptBtn')?.textContent) && !document.querySelector('#acceptBtn').disabled, null, { timeout: 60000 });
    const calChecks = await A.page.textContent('#checks');
    check('calibration recorded by both cameras + checked', /camA/.test(calChecks) && /camB/.test(calChecks), calChecks.replace(/\s+/g, ' ').slice(0, 160));
    await A.page.click('#acceptBtn');
    await A.page.waitForSelector('#landmarkBox:not(.hidden)', { timeout: 20000 });
    // tap two landmarks on camera A's still, save; skip camera B
    await A.page.waitForSelector('#lmImg img');
    const img = await A.page.$('#lmImg img'); const bb = await img.boundingBox();
    await A.page.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.7);
    await A.page.mouse.click(bb.x + bb.width * 0.7, bb.y + bb.height * 0.7);
    await A.page.click('#lmSave');
    await sleep(500);
    await A.page.click('#lmSkip');
    await A.page.waitForSelector('#landmarkBox.hidden', { state: 'attached' });
    let s = (await api(`/api/capture/sessions/${sessionId}`)).session;
    check('calibration A saved as valid, separate from takes', s.calibrations.A?.status === 'valid' && s.currentSetup === 'A');
    // 4. first animation: record → RETAKE → record → ACCEPT + NEXT
    const first = await A.page.textContent('#animTitle');
    const whyNot = () => A.page.evaluate(() => ({ why: document.querySelector('#recordWhy')?.textContent, a: document.querySelector('#pillAtxt')?.textContent, b: document.querySelector('#pillBtxt')?.textContent, phase: window.__capture?.phase, link: window.__capture?.link?.open, setup: document.querySelector('#setupCard')?.classList.contains('hidden') ? 'hidden' : 'shown' }));
    const waitRecordable = async () => { try { await A.page.waitForFunction(() => !document.querySelector('#recordBtn').disabled, null, { timeout: 25000 }); } catch (e) { throw new Error('RECORD stayed disabled: ' + JSON.stringify(await whyNot())); } };
    const recordOnce = async (ms = 2600) => {
      await waitRecordable();
      await A.page.click('#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      await sleep(ms);
      await A.page.click('#stopBtn');
      await A.page.waitForFunction(() => !document.querySelector('#acceptBtn').disabled, null, { timeout: 60000 });
    };
    await recordOnce();
    await shot(A.page, '4-review');
    check('review: both previews + checks', (await A.page.$$('#reviewVids video')).length === 2, (await A.page.textContent('#checks')).replace(/\s+/g, ' ').slice(0, 200));
    await A.page.click('#retakeBtn');
    await A.page.waitForSelector('#recordBox:not(.hidden)');
    await recordOnce();
    await A.page.click('#acceptBtn');
    await A.page.waitForSelector('#savedBox:not(.hidden)', { timeout: 20000 });
    check('SAVED ✓ shown after persistence', true);
    await A.page.waitForSelector('#savedBox.hidden', { state: 'attached', timeout: 10000 });
    const second = await A.page.textContent('#animTitle');
    check('ACCEPT + NEXT advanced to the next missing animation', second && second !== first, `${first} → ${second}`);
    s = (await api(`/api/capture/sessions/${sessionId}`)).session;
    const done = Object.entries(s.animations).filter(([, e]) => e.selectedTake);
    check('retake kept both takes, the accepted one selected', done.length === 1 && done[0][1].takes.length === 2);
    // 5. refresh the director: resumes on the next missing one
    await A.page.reload();
    await A.page.waitForFunction(() => document.querySelector('#pillBtxt')?.textContent.startsWith('READY') && document.querySelector('#pillAtxt')?.textContent.startsWith('READY'), null, { timeout: 40000 });
    const afterReload = await A.page.textContent('#animTitle');
    check('refresh resumes at the next missing animation', afterReload === second, afterReload);
    check('progress survives the refresh', /1 COMPLETE/.test(await A.page.textContent('#totals')), await A.page.textContent('#totals'));
    // 6. camera B's network drops mid-take: its chunks wait on the device, upload after reconnect
    await waitRecordable();
    await A.page.click('#recordBtn');
    await A.page.waitForSelector('#recordingBox:not(.hidden)');
    await sleep(1200);
    await B.ctx.setOffline(true);
    await sleep(1800);
    await A.page.click('#stopBtn');
    await sleep(2500);
    const pend = await B.page.evaluate(() => window.__capture.role.uploader.pending());
    check('offline camera B keeps its chunks on the device', pend.chunks + pend.finals > 0, JSON.stringify(pend));
    await B.ctx.setOffline(false);
    await A.page.waitForFunction(() => !document.querySelector('#acceptBtn').disabled, null, { timeout: 90000 });
    check('after reconnect the take completes with both cameras', /Cam A: ✓.*Cam B: ✓/.test(await A.page.textContent('#uploadLine')), await A.page.textContent('#uploadLine'));
    await A.page.click('#acceptBtn');
    await A.page.waitForSelector('#savedBox:not(.hidden)', { timeout: 20000 });
    await A.page.waitForSelector('#savedBox.hidden', { state: 'attached', timeout: 10000 });
    // 7. camera B page reload: re-pairs by itself (the token is in its URL)
    await B.page.reload();
    await B.page.click('#camStart', { timeout: 4000 }).catch(() => {});
    await A.page.waitForFunction(() => document.querySelector('#pillBtxt')?.textContent.startsWith('READY'), null, { timeout: 30000 });
    check('camera B reload re-pairs automatically', true);
    // 8. home: CONTINUE MISSING
    await A.page.goto(`${BASE}/capture`);
    await A.page.waitForSelector('#sessions a');
    const row = await A.page.textContent('#sessions');
    check('home lists the session with 2 complete, 80 missing', /2\/82 complete · 80 missing/.test(row), row.replace(/\s+/g, ' ').slice(0, 160));
    await A.page.click('#sessions a button');
    await A.page.waitForSelector('#animTitle');
    await A.page.waitForFunction(() => document.querySelector('#animTitle').textContent !== '—');
    s = (await api(`/api/capture/sessions/${sessionId}`));
    check('CONTINUE MISSING opens the next missing animation', (await A.page.textContent('#animTitle')) === s.progress.next.title, s.progress.next.key);
    await shot(A.page, '5-continue-missing');
    // 9. export: the tar's layout
    const tarFile = path.join(DATA, 'export.tar');
    const r = await fetch(`${BASE}/api/capture/sessions/${sessionId}/export.tar`);
    fs.writeFileSync(tarFile, Buffer.from(await r.arrayBuffer()));
    const names = execFileSync('tar', ['-tf', tarFile]).toString().trim().split('\n');
    const has = (re) => names.some((n) => re.test(n));
    check('export: session.json', has(/^SoulJam_BASIC01\/session\.json$/));
    check('export: calibration/setup_A/cal01 with both cameras', has(/^SoulJam_BASIC01\/calibration\/setup_A\/cal01\/camA\.(webm|mp4)$/) && has(/calibration\/setup_A\/cal01\/camB\./) && has(/calibration\/setup_A\/cal01\/metadata\.json$/));
    check('export: setup_A/<animation>/take02 with camA, camB, frame times, metadata', has(/^SoulJam_BASIC01\/setup_A\/[a-z0-9_A-Z]+\/take02\/camA\.(webm|mp4)$/) && has(/setup_A\/[a-zA-Z0-9_]+\/take02\/camB\./) && has(/take02\/camA\.frames\.json$/) && has(/take02\/metadata\.json$/));
    check('export: only accepted takes by default (the rejected first take is left out)', !has(/setup_A\/neutral_idle\/take01\//) && has(/setup_A\/neutral_idle\/take02\/camA\./));
    const x = path.join(DATA, 'x'); fs.mkdirSync(x); execFileSync('tar', ['-xf', tarFile, '-C', x]);
    const sj = JSON.parse(fs.readFileSync(path.join(x, 'SoulJam_BASIC01', 'session.json'), 'utf8'));
    check('export session.json: library, states, court, capture order, progress', sj.library?.animations?.length === 82 && sj.states?.DR && sj.court?.landmarks && sj.captureOrder?.length === 82 && sj.progress?.complete === 2, `complete ${sj.progress?.complete}`);
    const md = names.find((n) => /setup_A\/.*take02\/metadata\.json$/.test(n));
    const meta = JSON.parse(fs.readFileSync(path.join(x, md), 'utf8'));
    check('take metadata: states, sync, per-camera track / clock / frames', meta.startState && meta.endState && meta.sync?.startAtServerMs && meta.cameras?.camA?.clock && meta.cameras?.camB?.track?.frameRate && meta.cameras?.camA?.frames?.fps > 0, `A ${meta.cameras?.camA?.track?.width}×${meta.cameras?.camA?.track?.height}@${meta.cameras?.camA?.track?.frameRate} measured ${meta.cameras?.camA?.frames?.fps} fps · chirp ${!!meta.sync?.chirp}`);

    // ═══ production failure modes ═══════════════════════════════════════════
    const takeOf = async (id) => (await api(`/api/capture/sessions/${sessionId}/rec/${id}`)).take;
    const bothReady = (timeout = 40000) => A.page.waitForFunction(() => document.querySelector('#pillBtxt')?.textContent.startsWith('READY') && document.querySelector('#pillAtxt')?.textContent.startsWith('READY'), null, { timeout });
    const clickEl = (page, sel) => page.evaluate((q) => document.querySelector(q).click(), sel);
    const dirTakeId = () => A.page.evaluate(() => window.__capture?.take?.id || null);
    /** A camera page's uploader: how many chunks it holds for the take (IndexedDB). */
    const heldOn = (page, director) => page.evaluate(async (dir) => { const u = dir ? window.__capture?.cam?.uploader : window.__capture?.role?.uploader; return u ? (await u.pending()).held : 0; }, director).catch(() => 0);
    const waitHeld = async (page, director, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await heldOn(page, director) > 0) return true; await sleep(100); } return false; };
    /** A reloaded camera page: its camera starts (a tap only when the page did not start it itself). */
    const camUp = async (page) => {
      await page.waitForFunction(() => !!window.__capture?.role, null, { timeout: 15000 });
      await page.waitForFunction(() => document.getElementById('camTap')?.classList.contains('hidden'), null, { timeout: 3000 }).catch(() => clickEl(page, '#camStart'));
    };
    /** Wait for the take to reach review; if it waits for a camera, press REVIEW WITHOUT (returns how). */
    const reachReview = async (timeout = 60000, { finish = true } = {}) => {
      const t0 = Date.now(); let via = 'review';
      while (Date.now() - t0 < timeout) {
        const st = await A.page.evaluate(() => ({ ok: !document.querySelector('#acceptBtn').disabled && window.__capture?.phase === 'review', fin: !document.getElementById('finishRow').classList.contains('hidden') && !document.getElementById('finishBtn').disabled, label: document.getElementById('finishBtn').textContent }));
        if (st.ok) return via;
        if (st.fin && finish) { via = st.label; await clickEl(A.page, '#finishBtn'); await sleep(1000); continue; }
        await sleep(300);
      }
      throw new Error(`the take did not reach review in ${timeout / 1000} s (${await A.page.textContent('#reviewState').catch(() => '?')} · ${await A.page.textContent('#uploadLine').catch(() => '?')})`);
    };
    const retake = async () => { await clickEl(A.page, '#retakeBtn'); await A.page.waitForSelector('#recordBox:not(.hidden)', { timeout: 15000 }); };
    const acceptTake = async () => {
      await clickEl(A.page, '#acceptBtn');
      await A.page.waitForSelector('#savedBox:not(.hidden)', { timeout: 20000 });
      await A.page.waitForSelector('#savedBox.hidden', { state: 'attached', timeout: 10000 });
    };
    const decodeFails = (t) => (t?.validation?.checks || []).filter((c) => /^decode-/.test(c.id) || /does not decode/.test(c.msg));
    let B2 = null;
    /** After a failed phase: nothing recording / in review, camera B back on its first page, both cameras READY. */
    const recover = async () => {
      if (B2) { await B2.browser.close().catch(() => {}); browsers.splice(browsers.indexOf(B2.browser), 1); B2 = null; }
      netQuiet = false;
      await B.ctx.setOffline(false).catch(() => {});
      await B.page.evaluate(() => { const l = window.__capture?.role?.link; if (l?.replaced || l?.denied) l.reopen(); }).catch(() => {});
      if (await A.page.evaluate(() => window.__capture?.phase).catch(() => null) === 'recording') { await clickEl(A.page, '#stopBtn').catch(() => {}); await sleep(4000); }
      const t = await dirTakeId().catch(() => null);
      if (t) await api(`/api/capture/sessions/${sessionId}/rec/${t}/reject`, { method: 'POST', body: '{}' }).catch(() => {});
      await A.page.goto(`${BASE}/capture?session=${sessionId}`);
      await bothReady(45000);
    };
    const phase = async (name, fn) => {
      try { await fn(); }
      catch (e) {
        check(`${name} (phase)`, false, oneLine(e.message, 300));
        await shot(A.page, `fail-${name.replace(/\W+/g, '-')}`).catch(() => {});
        await recover();
      }
    };

    // 10. quick STOP: RECORD → STOP before the cameras' scheduled start (800 ms lead) → retake →
    //     a normal take: no orphan MediaRecorder from the aborted one corrupts it
    await A.page.goto(`${BASE}/capture?session=${sessionId}`);
    await bothReady();
    await phase('quick STOP', async () => {
      await waitRecordable();
      const q = await A.page.evaluate(async () => {
        const t0 = performance.now();
        document.getElementById('recordBtn').click();
        while (document.getElementById('recordingBox').classList.contains('hidden') && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 150));
        document.getElementById('stopBtn').click();
        return { ms: Math.round(performance.now() - t0), take: window.__capture.take?.id };
      });
      const via = await reachReview(45000);
      await sleep(1500);                                     // well past the scheduled start: a leftover recorder would be running now
      const recs = { A: await A.page.evaluate(() => ({ rec: window.__capture.cam?.cam.cur?.rec?.state || 'none', recording: !!window.__capture.cam?.cam.recording })), B: await B.page.evaluate(() => ({ rec: window.__capture.role.cam.cur?.rec?.state || 'none', recording: !!window.__capture.role.cam.recording })) };
      const tq = await takeOf(q.take);
      const idle = ['A', 'B'].every((k) => ['inactive', 'none'].includes(recs[k].rec) && !recs[k].recording);
      check(`quick STOP ${q.ms} ms after RECORD: the take reaches review, no recorder left running`, q.ms < 450 && tq.state === 'review' && via === 'review' && idle,
        `A ${recs.A.rec} · B ${recs.B.rec} · camA ${tq.cameras?.camA?.upload?.chunks ?? '—'} chunk(s) ${tq.cameras?.camA?.bytes ?? '—'} B · camB ${tq.cameras?.camB?.upload?.chunks ?? '—'} chunk(s) ${tq.cameras?.camB?.bytes ?? '—'} B`);
      await retake();
      await waitRecordable();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      const tid = await dirTakeId();
      await sleep(2200);
      await clickEl(A.page, '#stopBtn');
      await reachReview(60000);
      const t = await takeOf(tid);
      const bad = decodeFails(t), info = ['camA', 'camB'].map((c) => t.cameras?.[c]?.fileInfo);
      check('after the quick STOP + retake: the next take decodes on camA and camB', t.cameras?.camA?.file && t.cameras?.camB?.file && !bad.length && info.every((i) => i?.ok && i.durationSec >= 1),
        bad.length ? bad.map((c) => c.msg).join('; ') : `camA ${info[0]?.durationSec} s · camB ${info[1]?.durationSec} s · chunks ${t.cameras?.camA?.upload?.chunks}/${t.cameras?.camB?.upload?.chunks}`);
      await acceptTake();
    });

    // 11. camera B's page reloaded mid-take: its partial recording is finished from the device
    //     (Uploader.recoverInterrupted) — or, if it had nothing yet, the director reviews without it
    await phase('camera B reload mid-take', async () => {
      await bothReady();
      await waitRecordable();
      const t0 = Date.now();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      const tid = await dirTakeId();
      const hadChunk = await waitHeld(B.page, false);        // its first 1 s chunk is on the device (~1.9 s after RECORD: 0.8 s lead + 1 s)
      const at = Date.now() - t0;
      await B.page.reload();
      await camUp(B.page);
      await A.page.waitForFunction(() => document.querySelector('#pillBtxt')?.textContent.startsWith('READY'), null, { timeout: 30000 });
      check('camera B reloaded mid-take: re-pairs by itself (pairing kept in its link)', true, `reloaded ${at} ms after RECORD${hadChunk ? ' with a chunk on the device' : ' (no chunk yet)'}`);
      await sleep(800);
      await clickEl(A.page, '#stopBtn');
      const via = await reachReview(60000);
      const t = await takeOf(tid);
      const b = t.cameras?.camB;
      const pendB = await B.page.evaluate(() => window.__capture.role.uploader.pending());
      const ok = hadChunk
        ? t.state === 'review' && t.cameras?.camA?.file && b?.file && !!b.interrupted && b.upload?.chunks >= 1 && pendB.held === 0 && pendB.finals === 0
        : t.state === 'review' && /REVIEW WITHOUT/.test(via) && (t.finishedWithout || []).includes('camB');
      check('camera B reloaded mid-take: the take reaches review with B\'s partial recording', ok,
        hadChunk ? `via ${via} · camB ${b?.file || 'NO FILE'} ${b?.bytes ?? ''} B, ${b?.upload?.chunks ?? '?'} chunk(s), interrupted: ${!!b?.interrupted} · B's device queue ${JSON.stringify({ held: pendB.held, finals: pendB.finals })}` : `B had no chunk yet → ${via} → ${t.state}, without ${t.finishedWithout}`);
      await retake();
    });

    // 12. the director page refreshed mid-recording: STOP is back, works, the take reaches review
    //     (this phone is camera A too: its recording is finished from the device like camera B's)
    await phase('director refresh mid-recording', async () => {
      await bothReady();
      await waitRecordable();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      const tid = await dirTakeId();
      const hadChunk = await waitHeld(A.page, true);
      await A.page.reload();
      const back = await A.page.waitForSelector('#recordingBox:not(.hidden)', { timeout: 15000 }).then(() => true, () => false);
      const st = await A.page.evaluate(() => ({ phase: window.__capture?.phase, take: window.__capture?.take?.id, stop: !!document.querySelector('#stopBtn')?.offsetParent, name: document.getElementById('recName')?.textContent }));
      check('director refreshed mid-recording: the recording box with STOP is back', back && st.phase === 'recording' && st.take === tid && st.stop, oneLine(st.name, 120));
      if (!back) throw new Error('no recording box after the refresh');
      await sleep(600);
      await clickEl(A.page, '#stopBtn');
      const via = await reachReview(60000);
      const t = await takeOf(tid);
      const stopped = await A.page.evaluate(() => window.__capture.stopFor == null);
      const bRec = await B.page.evaluate(() => window.__capture.role.cam.cur?.rec?.state || 'none');
      const ok = t.state === 'review' && t.sync?.stopAtServerMs && t.cameras?.camB?.file && !t.cameras.camB.stopCapped && stopped && bRec === 'inactive'
        && (hadChunk ? t.cameras?.camA?.file && !!t.cameras.camA.interrupted : true);
      check('director refresh: STOP works (camera B halts) and the take reaches review', ok,
        `via ${via} · camA ${t.cameras?.camA?.file || '—'}${t.cameras?.camA?.interrupted ? ' (interrupted, from the device)' : ''} · camB ${t.cameras?.camB?.file || '—'} · halt heard ${stopped} · B recorder ${bRec}`);
      await retake();
    });

    // 13. a second page opens camera B's pairing link: the newest page takes the role, the first one
    //     says so and stays off (no ping-pong), USE THIS PHONE takes it back
    await phase('second page on camera B', async () => {
      await bothReady();
      const devB1 = await B.page.evaluate(() => localStorage.getItem('sjc-device'));
      B2 = await mk('cameraB-second');
      const s1 = { ...B.ws };
      await B2.page.goto(pairHref);
      await camUp(B2.page);
      await B.page.waitForFunction(() => !!document.querySelector('#camBanner [data-act=takeover]'), null, { timeout: 15000 });
      const l1 = await B.page.evaluate(() => { const l = window.__capture.role.link; return { replaced: !!l.replaced, closed: !!l.closed, open: !!l.open, banner: document.getElementById('camBanner').textContent }; });
      check('second page on camera B\'s link: the first page shows USE THIS PHONE and stops', l1.replaced && l1.closed && !l1.open, oneLine(l1.banner, 120));
      // ~8 s: the role must stay with the second page (sampled on the director), nobody reconnects
      const holder = new Set();
      for (let i = 0; i < 16; i++) { holder.add(await A.page.evaluate(() => window.__capture.presence?.camB?.deviceId || '—')); await sleep(500); }
      const d1 = { opened: B.ws.opened - s1.opened, replaced: B.ws.replaced - s1.replaced }, d2 = { ...B2.ws };
      const dev2 = await B2.page.evaluate(() => localStorage.getItem('sjc-device'));
      check('no reconnect flapping over 8 s (≤ 1 "replaced", the first page never reconnects)', d1.replaced + d2.replaced <= 1 && d1.opened === 0 && d2.opened === 1 && holder.size === 1 && holder.has(dev2),
        `first page: ${d1.opened} new socket(s), ${d1.replaced} replaced · second page: ${d2.opened} socket(s), ${d2.replaced} replaced · camB holders seen by the director: ${[...holder].map((h) => (h === dev2 ? 'second page' : h === devB1 ? 'first page' : h)).join(', ')}`);
      // USE THIS PHONE on the first page
      const s2 = { b1: { ...B.ws }, b2: { ...B2.ws } };
      await B.page.evaluate(() => document.querySelector('#camBanner [data-act=takeover]').click());
      const back = await A.page.waitForFunction((id) => window.__capture.presence?.camB?.deviceId === id && window.__capture.presence.camB.ready, devB1, { timeout: 15000 }).then(() => true, () => false);
      const l2 = await B2.page.waitForFunction(() => window.__capture.role.link.replaced, null, { timeout: 10000 }).then(() => true, () => false);
      await sleep(4000);
      const e1 = { opened: B.ws.opened - s2.b1.opened, replaced: B.ws.replaced - s2.b1.replaced }, e2 = { opened: B2.ws.opened - s2.b2.opened, replaced: B2.ws.replaced - s2.b2.replaced };
      const still = await A.page.evaluate(() => window.__capture.presence?.camB?.deviceId);
      const banner2 = await B2.page.evaluate(() => !!document.querySelector('#camBanner [data-act=takeover]'));
      check('USE THIS PHONE takes camera B back (the second page stops, no flapping)', back && l2 && banner2 && still === devB1 && e1.opened === 1 && e1.replaced === 0 && e2.opened === 0 && e2.replaced === 1,
        `first page: ${e1.opened} socket(s), ${e1.replaced} replaced · second page: ${e2.opened} new socket(s), ${e2.replaced} replaced, banner ${banner2} · camB now ${still === devB1 ? 'the first page' : still}`);
      await B2.browser.close(); browsers.splice(browsers.indexOf(B2.browser), 1); B2 = null;
      await bothReady();
    });

    // 14. Railway redeploy: the server is killed, its local disk wiped, and it starts again on the
    //     same bucket — everything comes back from the bucket
    await phase('server restart with the disk wiped', async () => {
      await bothReady();
      const before = await api(`/api/capture/sessions/${sessionId}`);
      const totals0 = await A.page.textContent('#totals');
      const accepted = Object.entries(before.session.animations).filter(([, e]) => e.selectedTake).map(([aid, e]) => ({ aid, tid: e.selectedTake }));
      const sockets0 = A.ws.opened, socketsB0 = B.ws.opened;
      netQuiet = true;
      await killServer(srv, 'SIGKILL');
      const down = await A.page.waitForFunction(() => !window.__capture.link.open, null, { timeout: 15000 }).then(() => true, () => false);
      fs.rmSync(CAP, { recursive: true, force: true });
      const wiped = !fs.existsSync(CAP);
      const bootAt = Date.now();                             // the old process is gone: presence seen after this is the new one's
      srv = await startServer();
      const t0 = Date.now();
      await A.page.waitForFunction(() => window.__capture.link.open, null, { timeout: 30000 });
      // (the page keeps its last presence while the link is down: wait for the new process's own)
      const fresh = await A.page.waitForFunction((since) => ['camA', 'camB'].every((c) => window.__capture.presence?.[c]?.ready && window.__capture.presence[c].lastSeen >= since), bootAt, { timeout: 45000 }).then(() => true, () => false);
      await bothReady(45000);
      netQuiet = false;
      check('restart with the disk wiped: the director page reconnects on its own', down && wiped && fresh && A.ws.opened > sockets0 && B.ws.opened > socketsB0 && await A.page.evaluate(() => window.__capture.link.open),
        `disk wiped ${wiped} · director + both cameras READY on the new process ${((Date.now() - t0) / 1000).toFixed(1)} s after it was up (fresh ${fresh}) · new sockets: director page ${A.ws.opened - sockets0}, camera B ${B.ws.opened - socketsB0}`);
      const after = await api(`/api/capture/sessions/${sessionId}`);
      const list = await api('/api/capture/sessions');
      const row = list.sessions?.find((x) => x.id === sessionId);
      const totals1 = await A.page.textContent('#totals');
      check('restart: progress unchanged (the session is read back from the bucket)', after.progress?.complete === before.progress.complete && after.progress.complete === accepted.length && row?.complete === before.progress.complete && totals1 === totals0
        && JSON.stringify(Object.fromEntries(Object.entries(after.session.animations).map(([k, e]) => [k, e.selectedTake]))) === JSON.stringify(Object.fromEntries(Object.entries(before.session.animations).map(([k, e]) => [k, e.selectedTake]))),
        `${after.progress?.complete} complete (before ${before.progress.complete}) · list ${row ? row.complete : 'MISSING'} · page "${totals1}"`);
      // an accepted take's video: served (restored from the bucket) and it plays in the browser
      const last = accepted[accepted.length - 1], lt = await takeOf(last.tid);
      const url = `/api/capture/sessions/${sessionId}/rec/${last.tid}/camA/video`;
      const vr = await fetch(BASE + url), vbytes = (await vr.arrayBuffer()).byteLength;
      const played = await A.page.evaluate(async (src) => {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = src; document.body.appendChild(v);
        try {
          await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('media error ' + (v.error?.code ?? '?'))); setTimeout(() => rej(new Error('no data in 10 s')), 10000); });
          await v.play();
          const t1 = performance.now();
          while (v.currentTime < 0.3 && performance.now() - t1 < 8000) await new Promise((r) => setTimeout(r, 100));
          return { ok: v.currentTime >= 0.3, t: +v.currentTime.toFixed(2), w: v.videoWidth, h: v.videoHeight };
        } catch (e) { return { ok: false, err: e.message }; } finally { v.pause(); v.remove(); }
      }, url);
      check('restart: an accepted take\'s video still plays (GET …/video 200)', vr.status === 200 && vbytes === lt.cameras?.camA?.bytes && played.ok,
        `HTTP ${vr.status} · ${vbytes} B (record ${lt.cameras?.camA?.bytes}) · played to ${played.t ?? '—'} s ${played.w || ''}×${played.h || ''}${played.err ? ' · ' + played.err : ''}`);
      // the export: every accepted take + the calibration, nothing missing
      const tar2 = path.join(DATA, 'export-after-restart.tar');
      const er = await fetch(`${BASE}/api/capture/sessions/${sessionId}/export.tar`);
      fs.writeFileSync(tar2, Buffer.from(await er.arrayBuffer()));
      const names2 = execFileSync('tar', ['-tf', tar2]).toString().trim().split('\n');
      const x2 = path.join(DATA, 'x2'); fs.mkdirSync(x2); execFileSync('tar', ['-xf', tar2, '-C', x2]);
      const sj2 = JSON.parse(fs.readFileSync(path.join(x2, 'SoulJam_BASIC01', 'session.json'), 'utf8'));
      const lost = [];
      for (const { tid } of accepted) {
        const t = await takeOf(tid), folder = `SoulJam_BASIC01/setup_${t.courtSetup}/${t.animKey}/take${String(t.takeNo).padStart(2, '0')}`;
        for (const f of [`camA${path.extname(t.cameras.camA.file)}`, `camB${path.extname(t.cameras.camB.file)}`, 'camA.frames.json', 'camB.frames.json', 'metadata.json']) if (!names2.includes(`${folder}/${f}`)) lost.push(`${folder}/${f}`);
        for (const c of ['camA', 'camB']) { const f = path.join(x2, folder, `${c}${path.extname(t.cameras[c].file)}`); if (fs.existsSync(f) && fs.statSync(f).size !== t.cameras[c].bytes) lost.push(`${folder}/${c} (size)`); }
      }
      const cal = names2.some((n) => /calibration\/setup_A\/cal01\/camA\./.test(n)) && names2.some((n) => /calibration\/setup_A\/cal01\/camB\./.test(n));
      check('restart: the export still contains every accepted take + the calibration', !lost.length && cal && !sj2.missingFiles && sj2.progress?.complete === accepted.length,
        lost.length ? `lost: ${lost.slice(0, 4).join(', ')}` : `${accepted.length} accepted takes + cal01 · ${names2.length} entries${sj2.missingFiles ? ' · missingFiles ' + sj2.missingFiles.join(', ') : ''}`);
      // a new take after the restart: recorded, accepted, in the bucket
      await waitRecordable();
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      const tid = await dirTakeId();
      await sleep(2400);
      await clickEl(A.page, '#stopBtn');
      await reachReview(60000);
      await acceptTake();
      const t = await takeOf(tid), p = await api(`/api/capture/sessions/${sessionId}`);
      const inBucket = ['camA', 'camB'].every((c) => t.cameras?.[c]?.file && fs.existsSync(path.join(CLOUD, '_meta', 'capture', 'sessions', sessionId, 'takes', tid, t.cameras[c].file)))
        && fs.existsSync(path.join(CLOUD, '_meta', 'capture', 'sessions', sessionId, 'takes', tid, 'take.json'));
      const bucketRec = JSON.parse(fs.readFileSync(path.join(CLOUD, '_meta', 'capture', 'sessions', sessionId, 'takes', tid, 'take.json'), 'utf8'));
      check('restart: a new take is recorded + accepted (files and record in the bucket)', t.state === 'accepted' && t.selected && p.progress.complete === accepted.length + 1 && inBucket && bucketRec.state === 'accepted' && !decodeFails(t).length,
        `${t.animKey} take ${t.takeNo} · progress ${p.progress.complete} · in bucket ${inBucket} (record says ${bucketRec.state})`);
    });

    // 15. a redeploy MID-UPLOAD: camera B is offline when the take stops, the server restarts with
    //     an empty disk (the chunks B had already sent are gone), B comes back: its "complete" is
    //     answered 409 {missing}, it sends those chunks again from its device, the take completes
    await phase('server restart mid-upload', async () => {
      await bothReady();
      await waitRecordable();
      const c0 = B.completes.length;
      await clickEl(A.page, '#recordBtn');
      await A.page.waitForSelector('#recordingBox:not(.hidden)');
      const tid = await dirTakeId();
      // B has uploaded at least one chunk (the server has it; B keeps its copy, marked sent)
      let p = null; const w0 = Date.now();
      while (Date.now() - w0 < 8000) { p = await B.page.evaluate(() => window.__capture.role.uploader.pending()); if (p.held > p.chunks) break; await sleep(100); }
      const had = (await api(`/api/capture/sessions/${sessionId}/rec/${tid}/camB/status`)).have || [];
      if (!(p?.held > p?.chunks) || !had.length) throw new Error(`camera B had not uploaded a chunk yet (${JSON.stringify(p)}, server has ${JSON.stringify(had)})`);
      await B.ctx.setOffline(true);
      await sleep(1200);
      await clickEl(A.page, '#stopBtn');
      // camera A's recording is in (and in the bucket) before the redeploy
      const w1 = Date.now(); let ta = null;
      while (Date.now() - w1 < 20000) { ta = await takeOf(tid); if (ta.cameras?.camA?.file) break; await sleep(300); }
      if (!ta?.cameras?.camA?.file) throw new Error('camera A did not upload before the redeploy');
      netQuiet = true;
      await killServer(srv, 'SIGKILL');
      fs.rmSync(CAP, { recursive: true, force: true });
      srv = await startServer();
      await B.ctx.setOffline(false);
      let via;
      try { via = await reachReview(90000, { finish: false }); } finally { netQuiet = false; }
      const t = await takeOf(tid), b = t.cameras?.camB || {};
      const codes = B.completes.slice(c0);
      const pendB = await B.page.evaluate(() => window.__capture.role.uploader.pending());
      check('redeploy mid-upload: B re-sends the chunks the server lost (409 missing) and the take completes', t.state === 'review' && b.file && codes.includes(409) && codes[codes.length - 1] === 200 && !decodeFails(t).length && b.fileInfo?.ok && pendB.held === 0 && pendB.kept === 0,
        `server had chunk(s) ${had.join(',')} before · B's "complete" answers: ${codes.join(' → ') || 'none'} · camB ${b.upload?.chunks ?? '?'} chunk(s), ${b.fileInfo?.durationSec ?? '?'} s${b.stopReconciled ? ' (stop reconciled)' : ''} · B's device ${JSON.stringify({ held: pendB.held, kept: pendB.kept })}`);
      await retake();
    });
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
    if (bad.length && !results.some((r) => r.name === 'run' && r.ok)) console.log('server log tail:\n' + srvLog.split('\n').slice(-15).join('\n'));
    process.exit(bad.length ? 1 : 0);
  }
})().catch((e) => { console.error('✖ could not start:', e.message); if (srv) try { process.kill(srv.pid, 'SIGKILL'); } catch {} process.exit(1); });
