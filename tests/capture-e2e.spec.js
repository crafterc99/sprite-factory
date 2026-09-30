#!/usr/bin/env node
/**
 * Soul Jam Capture — end-to-end test with two simulated devices (Chromium with a fake camera +
 * microphone): a dedicated server (own data dir), the DIRECTOR (also camera A) and CAMERA B.
 *
 *   pairing (QR link) → both READY → calibrate setup A → record → retake → record → ACCEPT + NEXT
 *   → SAVED ✓ and the next missing animation → refresh (resume) → a take with camera B's network
 *   dropped mid-recording (IndexedDB queue → uploads after reconnect) → camera B page reload →
 *   home: CONTINUE MISSING → export (tar layout) — every step asserted.
 *
 *   node tests/capture-e2e.spec.js [--port 3461] [--keep]
 * Screenshots: tests/reports/capture-e2e/ (gitignored). Exit 1 on a failed check.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-e2e-'));
const results = [];
let lastCheck = 'start';
const check = (name, ok, detail = '') => { lastCheck = name; results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } }); return r.headers.get('content-type')?.includes('json') ? r.json() : r; };

(async () => {
  // ── a dedicated server
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CAPTURE_DIR: DATA, CAPTURE_HTTPS: '0', APP_PASSWORD: '', CAPTURE_CLOUD: '0', CAPTURE_DEBUG: '1', FIREBASE_SERVICE_ACCOUNT: '', R2_ENDPOINT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/capture/libraries`); if (r.ok) break; } catch {} await sleep(500); }
  // one browser per device (like two phones): network emulation (offline) must not leak between them
  const browsers = [];
  const errors = [];
  const mk = async (name) => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(browser);
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} (after "${lastCheck}"): ${m.text().slice(0, 200)}`); });
    return { ctx, page };
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
  } catch (e) {
    check('run', false, e.message);
  } finally {
    check('no page errors', !errors.length, errors.slice(0, 5).join(' | '));
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, errors, at: new Date().toISOString() }, null, 1));
    fs.writeFileSync(path.join(OUT, 'server.log'), srvLog);
    for (const b of browsers) await b.close();
    srv.kill();
    if (!argv.includes('--keep')) fs.rmSync(DATA, { recursive: true, force: true });
    else console.log('data kept in', DATA);
    const bad = results.filter((r) => !r.ok);
    if (bad.length && !results.some((r) => r.name === 'run' && r.ok)) console.log('server log tail:\n' + srvLog.split('\n').slice(-15).join('\n'));
    process.exit(bad.length ? 1 : 0);
  }
})();
