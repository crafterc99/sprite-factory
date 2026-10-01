/**
 * Soul Jam Capture — the app (director + camera modes). Plain modules, no build step.
 *
 *   /capture                       sessions: new / continue / join as a camera
 *   /capture?session=<id>          DIRECTOR (this device is also camera A unless &cam=0)
 *   /capture?pair=<token>[&role=camA|camB]   CAMERA (B by default) — one tap, then hands-free
 *
 * The director works in steps: 1 Connect (pair CAM B, both cameras pass a 2 s camera check) ·
 * 2 Calibrate (place the cameras, mark the floor, one ~20 s walk recording that saves itself) ·
 * 3 Record (one animation at a time: countdown, spoken cues, it stops by itself, straight on to the
 * next — uploads and checks run in the background) · Animations (every slot and its status, takes,
 * MARK BEST) · Analysis (send recorded takes to SAM 3D Body with an explicit cost confirmation).
 *
 * All state that matters is on the server (sessions, takes, uploads); this page can be closed and
 * reopened at any point. Recordings are chunked to the device's IndexedDB and uploaded as they are
 * recorded (capture/uploader.mjs), so a refresh or a Wi-Fi drop loses nothing.
 */
import { LIBRARIES } from './basic01.mjs';
import { STATES, poseRoute } from './schema.mjs';
import * as P from './protocol.mjs';
import { SETUPS, STATIONS, courtSVG, calibrationWalk, walkStep, stationOf } from './court-layout.mjs';
import { takeScript, phaseAt, poseName, poseDesc } from './instructions.mjs';
import { ClockSync, CHIRP, frameStats } from './camera-sync.mjs';
import { WebCamera } from './camera.mjs';
import { Uploader, recLock, storageMode } from './uploader.mjs';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const show = (el, on = true) => el && el.classList.toggle('hidden', !on);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** innerHTML only when it changed (re-rendering every second must not eat taps or restart videos). */
const setHTML = (el, html) => { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } };
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const deviceId = (() => { try { let d = localStorage.getItem('sjc-device'); if (!d) { d = 'dev-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('sjc-device', d); } return d; } catch { return 'dev-' + Math.random().toString(36).slice(2, 10); } })();
const deviceInfo = () => ({ ua: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || null, screen: [screen.width, screen.height, devicePixelRatio], secure: isSecureContext });
const CAMS = ['camA', 'camB'];
const CAM = { camA: 'CAM A', camB: 'CAM B' };
const DIR_LABEL = { none: 'on the spot', forward: 'toward the hoop', backward: 'away from the hoop', right: 'to his right', left: 'to his left', 'forward-right': 'forward-right', 'forward-left': 'forward-left', 'back-right': 'back-right', 'back-left': 'back-left', 'to-basket': 'toward the hoop', up: 'straight up' };
const NUM_WORD = ['the middle', 'one', 'two', 'three', 'four'];
const HAND_LABEL = { R: 'right hand', L: 'left hand', both: 'both hands', none: 'no ball' };
/** A check's wording for the operator: "camB: …" → "CAM B: …". */
const human = (s) => String(s ?? '').replace(/\bcam([AB])\b/g, 'CAM $1');
const mimeLabel = (m) => (/mp4/.test(m || '') ? 'MP4' : /webm/.test(m || '') ? 'WebM' : m ? m.split(';')[0] : '?');
const fmtFormat = (d) => (d ? `${d.width}×${d.height} · ${d.frameRate ? Math.round(d.frameRate) : '?'} fps${d.orientation ? ` · ${d.orientation}` : ''} · ${mimeLabel(d.mime)}` : '—');

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const r = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Capture-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}

// ── one WebSocket per role (the director device opens "director" and "camA")
const LINKS = new Set();
// leaving the page (refresh, navigation): close cleanly — no reconnect attempt mid-unload
window.addEventListener('pagehide', () => { for (const l of LINKS) l.close(); });
class Link {
  constructor({ sessionId, role, token = null, clock, onMessage, onStatus }) {
    Object.assign(this, { sessionId, role, token, clock, onMessage, onStatus });
    this.ws = null; this.open = false; this.retry = 500; this.closed = false;
    LINKS.add(this);
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/capture/ws?session=${enc(this.sessionId)}${this.token ? `&token=${enc(this.token)}` : ''}`;
    const ws = (this.ws = new WebSocket(url));
    ws.onopen = () => {
      this.open = true; this.retry = 500; this.onStatus?.(true);
      this.send({ t: 'hello', role: this.role, deviceId, device: deviceInfo() });
      clearInterval(this.pinger);
      const ping = () => this.send({ t: 'ping', c: Date.now() });
      ping(); this.pinger = setInterval(ping, 1000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { this.clock.add(m.c, m.s, Date.now()); return; }
      this.onMessage?.(m, this);
    };
    ws.onclose = (e) => {
      this.open = false; clearInterval(this.pinger);
      // another page took this role (4000), or the role needs the studio sign-in (4001): stay off
      // until the operator says otherwise — two pages reconnecting would evict each other forever
      if (e.code === 4000 || e.code === 4001) { this.closed = true; this.replaced = e.code === 4000; this.denied = e.code === 4001; }
      this.onStatus?.(false);
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), (this.retry = Math.min(8000, this.retry * 1.6)));
    };
    ws.onerror = () => {};
  }
  /** Take the role back on this page (after another page took it). */
  reopen() { clearTimeout(this.reconnectTimer); this.closed = false; this.replaced = false; this.denied = false; this.retry = 500; LINKS.add(this); this.connect(); }
  send(m) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  close() { this.closed = true; clearInterval(this.pinger); clearTimeout(this.reconnectTimer); try { this.ws?.close(); } catch {} LINKS.delete(this); }
}

// ── camera role (camera B's phone, or camera A on the director's device)
class CameraRole {
  constructor({ sessionId, role, token, clock, video, onUi, snapshots = true }) {
    Object.assign(this, { sessionId, role, token, clock, onUi, snapshots });
    this.cam = new WebCamera({ video, clock, onChunk: (seq, blob, tag, mime) => this.onChunk(seq, blob, tag, mime), onState: () => this.pushState() });
    // "is it really recording?" — told to the director within ~2 s (screen locked, a recorder giving 5 bytes …)
    this.cam.onHealth = (msg, tag) => { this.recError = { msg, takeId: tag, at: Date.now() }; this.pushState(); this.onUi?.(); };
    this.lost = new Map(); this.locks = new Map();
    this.uploader = new Uploader({ token, onProgress: (p) => { this.uploads = p; this.onUi?.(); this.pushState(); }, onComplete: () => { this.savedAt = Date.now(); this.onUi?.(); } });
    this.link = new Link({ sessionId, role, token, clock, onMessage: (m) => this.onMessage(m), onStatus: () => { this.onUi?.(); this.pushState(); } });
    this.take = null; this.lastTake = null; this.lastKind = null; this.session = null; this.recording = false; this.uploads = null; this.setup = null; this.movedReason = null; this.recError = null; this.armed = null; this.directorOnline = true;
    // anything left from before a refresh; a take the page died in is finished with what it recorded
    this.uploader.recoverInterrupted().catch(() => {}).then(() => this.uploader.wake());
    this.stateTimer = setInterval(() => this.pushState(), 1000);
    // the director sees what this camera sees: a small picture every 1.5 s while idle
    this.snapTimer = setInterval(() => this.sendSnap(), 1500);
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }
  /** Back in front: keep the screen awake, the preview playing, the camera open. */
  async onVisibility() {
    this.pushState();
    if (document.visibilityState !== 'visible') return;
    this.requestWake();
    if (this.cam.stream && this.cam.track?.readyState === 'ended' && !this.recording) { try { await this.cam.open(); } catch {} }
    this.cam.keepPlaying();
    this.pushState(); this.onUi?.();
  }
  async requestWake() { try { if (navigator.wakeLock && (!this.wakeLock || this.wakeLock.released)) this.wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  sendSnap() {
    if (!this.snapshots || this.recording || !this.link.open || !this.directorOnline || document.visibilityState !== 'visible') return;
    const s = this.cam.snapshot();
    if (s) this.link.send({ t: 'snap', ...s });
  }
  /** Keep the calibration reference view (moved-camera check) on the server — it survives a reload. */
  watchFrom(setup) {
    this.setup = setup;
    this.cam.watchMoves((reason) => { this.movedReason = reason; this.link.send({ t: 'moved', setup: this.setup, reason }); this.onUi?.(); });
  }
  async restoreReference(session) {
    const setup = session?.currentSetup, c = session?.calibrations?.[setup];
    if (!setup || !c || !['valid', 'skipped'].includes(c.status) || this.cam.ref || this.refLoading === setup) return;
    this.refLoading = setup;
    const get = () => api(`/api/capture/sessions/${enc(this.sessionId)}/calref/${setup}/${this.role}`, { token: this.token });
    try {
      let r;
      // (a calibration saved a moment ago: its reference is on its way — the 'setref' relay)
      try { r = await get(); } catch (e) { if (e.status !== 404) throw e; await sleep(6000); if (this.cam.ref) return; r = await get(); }
      if (!this.cam.ref) { this.cam.ref = r.ref; this.watchFrom(setup); }
    } catch (e) {
      if (e.status !== 404 || this.cam.ref) { this.refLoading = null; return; }   // try again on the next connect
      if (c.status === 'valid') this.link.send({ t: 'moved', setup, reason: 'this camera has no reference view of the calibration (it was not connected when it was saved) — recalibrate' });
      else { await this.waitForPicture(); if (!this.cam.ref && this.cam.setReference()) { this.saveReference(setup); this.watchFrom(setup); } }
    }
  }
  async waitForPicture() { for (let i = 0; i < 40 && !this.cam.video?.videoWidth; i++) await sleep(250); }
  saveReference(setup) {
    const ref = this.cam.ref; if (!ref) return;
    api(`/api/capture/sessions/${enc(this.sessionId)}/calref/${setup}/${this.role}`, { method: 'PUT', body: ref, token: this.token }).catch(() => {});
  }
  async start(opts = {}) {
    const d = await this.cam.open(opts);
    this.requestWake();
    this.pushState(); this.onUi?.();
    return d;
  }
  ready() { return !!(this.cam.stream && this.cam.track?.readyState !== 'ended' && this.link.open && this.clock.best && document.visibilityState !== 'hidden'); }
  pushState() {
    // take / lastTake: "I got the start of this take" — the hub tells a camera that never started (asleep) from one that did
    this.link.send({ t: 'state', state: { ready: this.ready(), recording: this.recording, take: this.recording ? this.take : null, lastTake: this.lastTake, camera: this.cam.stream ? this.cam.describe() : null, clock: this.clock.best, uploads: this.uploads, calibrated: !!this.cam.ref, moved: this.movedReason,
      streaming: this.recording ? !!this.cam.streaming : undefined, recError: this.recError?.msg || null, recErrorTake: this.recError?.takeId || null, hidden: document.visibilityState === 'hidden' } });
  }
  /** A recorded chunk → the device's store, for the take that recording belongs to. */
  onChunk(seq, blob, tag, mime) {
    const takeId = tag || this.take; if (!takeId) return;
    this.uploader.addChunk({ sessionId: this.sessionId, takeId, cam: this.role, seq, blob, mime: mime || blob.type || null }).catch((e) => {
      // e.g. the phone's storage is full: say so, and tell the server which second is missing
      (this.lost.get(takeId) || this.lost.set(takeId, []).get(takeId)).push(seq);
      this.storageError = `${e.name || 'error'}: ${e.message}`; this.onUi?.(`This phone could not store a recorded chunk (${this.storageError}). Free some space.`);
    });
  }
  /** While recording a take, hold a lock: another tab of this browser never mistakes it for an interrupted one. */
  holdLock(takeId) { if (!navigator.locks || this.locks.has(takeId)) return; let release; const p = new Promise((r) => { release = r; }); this.locks.set(takeId, release); navigator.locks.request(recLock(takeId, this.role), () => p).catch(() => {}); }
  dropLock(takeId) { this.locks.get(takeId)?.(); this.locks.delete(takeId); }
  async onMessage(m) {
    // reconnected after a drop: if the director stopped the take meanwhile, stop at that moment
    if ((m.t === 'welcome' || m.t === 'presence' || m.t === 'armed') && this.recording && this.take) {
      const a = m.armed;
      if (!a || a.takeId !== this.take || a.recording === false) return this.onMessage({ t: 'halt', takeId: this.take, at: a?.takeId === this.take && a.stoppedAt ? a.stoppedAt : this.clock.toServer(Date.now()), reconciled: true });
    }
    if (m.t === 'presence') { this.directorOnline = !!m.devices?.director?.online; if (m.armed !== undefined) this.armed = m.armed; }
    if (m.t === 'armed') { this.armed = m.armed; this.onUi?.(); }
    if (m.t === 'record') {
      if (!this.cam.stream || (this.recording && this.take === m.takeId)) return;
      this.take = m.takeId; this.lastTake = m.takeId; this.lastKind = this.armed?.takeId === m.takeId ? this.armed.kind : null; this.recording = true; this.recAt = m.at; this.recError = null;
      this.holdLock(m.takeId);
      this.cam.keepPlaying();
      this.cam.start({ atLocal: this.clock.toLocal(m.at) ?? Date.now(), tag: m.takeId });
      // safety: never record forever if the stop never arrives
      clearTimeout(this.capTimer);
      this.capTimer = setTimeout(() => { if (this.recording && this.take === m.takeId) this.onMessage({ t: 'halt', takeId: m.takeId, at: this.clock.toServer(Date.now()), capped: true }); }, 120000);
      this.pushState(); this.onUi?.();
    } else if (m.t === 'halt' && m.takeId === this.take && this.recording) {
      this.recording = false;
      clearTimeout(this.capTimer);
      const r = await this.cam.stop({ atLocal: this.clock.toLocal(m.at) ?? Date.now() });
      const d = this.cam.describe();
      const lost = this.lost.get(m.takeId) || []; this.lost.delete(m.takeId);
      await this.uploader.addFinal({ sessionId: this.sessionId, takeId: m.takeId, cam: this.role, payload: {
        chunks: r.chunks, ...(lost.length ? { gaps: lost } : {}), mimeType: r.mime, frames: r.frames, mediaTimes: r.mediaTimes,
        meta: {
          deviceId, device: deviceInfo(), track: { width: d.width, height: d.height, frameRate: d.frameRate, facingMode: d.facingMode, zoom: d.zoom, label: d.label, aspectRatio: d.aspectRatio, orientation: d.orientation },
          capabilities: d.capabilities, recorder: { mimeType: r.mime, bitsPerSecond: r.bps, timesliceMs: 1000, bytes: r.bytes, rvfc: !!r.rvfc, ...(r.mimeSwitched ? { nextMimeType: r.mimeSwitched } : {}) }, source: 'web',
          clock: this.clock.best, startedAtServerMs: this.clock.toServer(r.startedLocal), stoppedAtServerMs: this.clock.toServer(r.stoppedLocal),
          commandAtServerMs: this.recAt, frames: frameStats(r.frames), streamedChunks: !!r.streaming, ...(this.storageError && lost.length ? { storageError: this.storageError } : {}),
          ...(r.recError ? { recError: r.recError } : {}), ...(r.recWarn ? { recWarn: r.recWarn } : {}),
          ...(m.reconciled ? { stopReconciled: 'the stop arrived after a reconnect: the recording ran past the director\'s stop (trim to sync.stopAtServerMs)' } : {}), ...(m.capped ? { stopCapped: 'no stop within 120 s' } : {}),
        },
      } });
      this.dropLock(m.takeId);
      if (this.take === m.takeId) this.take = null;         // (a new take may have started meanwhile)
      this.pushState(); this.onUi?.();
    } else if (m.t === 'setref' && m.setup) {               // calibration saved: this is the view to keep
      this.movedReason = null;
      if (this.cam.setReference()) this.saveReference(m.setup);
      this.watchFrom(m.setup);
      this.onUi?.();
    } else if (m.t === 'zoom' && this.cam.stream) {          // the director widens / narrows this camera (Calibrate step)
      await this.cam.setZoom(m.zoom);
      this.pushState(); this.onUi?.();
    } else if (m.t === 'welcome' || m.t === 'session') {
      const s = m.session; if (s) this.session = s;
      if (s?.currentSetup) this.setup = s.currentSetup;
      if (m.t === 'welcome') { this.armed = m.armed || null; if (s) this.restoreReference(s); }   // a reloaded page keeps watching for being moved
    } else if (m.t === 'replaced') {
      this.onUi?.();
    }
  }
}

/** Footage the server did not know (kept aside on this phone, never deleted automatically). */
const keptBanner = (u) => (u?.kept ? `<div class="banner">${u.kept} recording${u.kept > 1 ? 's' : ''} (${(u.keptBytes / 1e6).toFixed(1)} MB) kept on this phone — the server no longer knows ${u.kept > 1 ? 'those takes' : 'that take'}. <button class="small" data-act="keptSave">SAVE TO PHONE</button> <button class="small" data-act="keptDrop">DISCARD</button></div>` : '');
/** The banner buttons (the banners are re-drawn every second, so one delegated handler). */
function keptActions(box, role, redraw) {
  box.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act, cr = role();
    if (!act || !cr) return;
    if (act === 'takeover') cr.link.reopen();
    else if (act === 'keptSave') {
      for (const f of await cr.uploader.keptFiles()) { const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    } else if (act === 'keptDrop') { if (confirm('Discard the footage kept on this phone? It is not on the server.')) await cr.uploader.dropKept(); }
    else return;
    redraw();
  });
}

window.addEventListener('sjc-db-memory', () => { const b = document.createElement('div'); b.className = 'banner'; b.textContent = 'Phone storage is unavailable here — recordings upload straight from memory. Keep this page open (don\'t reload it) until uploads say ✓.'; document.body.prepend(b); });
window.addEventListener('sjc-db-blocked', () => { const b = document.createElement('div'); b.className = 'banner bad'; b.textContent = 'Another Soul Jam Capture tab on this phone is holding its storage — close the other tab.'; document.body.prepend(b); });

// ═══ CAMERA MODE (camera B's phone) ═════════════════════════════════════════
async function cameraMode(token, role) {
  show($('camera'));
  const setStatus = (cls, big, sub) => { $('camStatusBox').className = `cam-status ${cls}`; setText($('camStatus'), big); setText($('camSub'), sub); };
  let pair;
  try { pair = await api('/api/capture/pair', { method: 'POST', body: { token } }); }
  catch (e) { setStatus('bad', 'Pairing failed', `${e.message}. Scan the director's QR code again.`); show($('camTap'), false); return; }
  try { localStorage.setItem('sjc-pair', JSON.stringify({ token, role, sessionId: pair.sessionId })); } catch {}
  const clock = new ClockSync();
  $('camRole').textContent = CAM[role];
  $('camRole').style.color = role === 'camA' ? 'var(--a)' : 'var(--b)';
  let note = null;
  const ui = (msg) => {
    if (typeof msg === 'string') note = msg;
    const c = cr, d = c.cam.stream ? c.cam.describe() : null, u = c.uploads;
    const pending = u ? (u.chunks || 0) + (u.finals || 0) : 0;
    const kind = c.armed?.kind;
    if (!c.cam.stream) setStatus('', 'Camera off', 'Tap the button to start the camera');
    else if (c.recording) setStatus('rec', kind === 'check' ? '● CAMERA CHECK' : kind === 'calibration' ? '● CALIBRATING' : '● RECORDING', 'Keep this screen on and the phone still');
    else if (c.link.replaced) setStatus('bad', 'Stopped', `Another page is ${CAM[role]} now`);
    else if (!c.link.open) setStatus('bad', 'Reconnecting…', 'Looking for the server — keep this page open');
    else if (pending) setStatus('up', `Uploading ${pending}…`, `${((u.bytes || 0) / 1e6).toFixed(1)} MB to go${u.error ? ' · retrying' : ''} — keep this page open`);
    else if (c.recError) setStatus('bad', '✗ The last recording failed', `${c.recError.msg}. Keep the screen on and this page in front.`);
    else if (c.lastKind === 'check' && c.savedAt && Date.now() - c.savedAt < 20000) {
      // a camera check: the server's verdict (bytes, a file that decodes, frames), not just "uploaded"
      const v = c.session?.cameraChecks?.[role];
      if (v?.checkId === c.lastTake) setStatus(v.ok ? 'ok' : 'bad', v.ok ? '✓ Camera check passed' : '✗ Camera check failed', v.ok ? `${v.durationSec ? v.durationSec.toFixed(1) + ' s of real video' : 'real video'} — waiting for the director` : `${v.reason}. Keep the screen on and this page in front.`);
      else setStatus('up', 'Checking the test video…', 'The server is checking that it decodes');
    }
    else if (c.savedAt && Date.now() - c.savedAt < 8000) setStatus('ok', '✓ Saved', 'Waiting for the director');
    else if (c.ready()) setStatus('ok', 'Connected ✓ — waiting for the director', `Paired with “${pair.name}”. Leave this phone on its tripod; the director starts and stops recording.`);
    else setStatus('', 'Starting…', '');
    setText($('camFormat'), fmtFormat(d));
    document.getElementById('camera').classList.toggle('recording', c.recording);
    setHTML($('camBanner'), (c.link.replaced ? `<div class="banner bad">Another page is now ${CAM[role]} — this one stopped. <button class="small" data-act="takeover">USE THIS PHONE</button></div>` : '')
      + (c.recError && c.recording ? `<div class="banner bad">This camera is not recording: ${esc(c.recError.msg)}. Keep the screen on and this page in front.</div>` : '')
      + (c.movedReason ? `<div class="banner bad">Camera moved (${esc(c.movedReason)}) — the director will ask to recalibrate.</div>` : '')
      + keptBanner(u)
      + (d?.orientation === 'portrait' && !c.recording ? '<div class="banner">Tip: turn the phone sideways (landscape) for a wider view.</div>' : '')
      + (note ? `<div class="banner">${esc(note)}</div>` : ''));
  };
  keptActions($('camBanner'), () => cr, () => ui());
  const cr = new CameraRole({ sessionId: pair.sessionId, role, token, clock, video: $('camVideo'), onUi: ui });
  setStatus('', 'Paired', `with “${pair.name}”. Tap the button to start the camera.`);
  const go = async () => {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) { try { await DeviceMotionEvent.requestPermission(); } catch {} }
      await cr.start();
      show($('camTap'), false); ui();
    } catch (e) { $('camStart').textContent = `Camera blocked: ${e.name || e.message} — tap to retry`; }
  };
  $('camStart').onclick = go;
  // browsers remember the permission: try right away (the tap stays as a fallback)
  try { const perm = await navigator.permissions?.query({ name: 'camera' }); if (perm?.state === 'granted') go(); } catch {}
  setInterval(() => ui(), 1000);
  window.__capture = { role: cr };
}

// ═══ HOME ══════════════════════════════════════════════════════════════════
async function homeMode() {
  show($('home'));
  let list;
  try { list = await api('/api/capture/sessions'); }
  catch (e) {
    const signIn = e.status === 403 || e.status === 401;
    $('sessions').innerHTML = `<div class="dim">${signIn ? 'Sign in to the studio to direct a session (<a href="/login?next=/capture">sign in</a>). Cameras can still join with a code below.' : esc(e.message)}</div>`; list = null;
    if (signIn) { $('newSession').disabled = true; $('newSession').title = 'sign in to the studio first'; }
  }
  if (list) {
    $('sessions').innerHTML = list.sessions.length ? list.sessions.map((s) => `<div><div class="grow"><b>${esc(s.name)}</b><div class="small dim">${esc(s.libraryId)} · ${s.complete}/${s.total} complete · ${s.missing} missing${s.next ? ` · next: ${esc(s.next.title)} ${esc(s.next.subtitle || '')} (setup ${s.next.courtSetup})` : ' · done'}</div></div><a href="/capture?session=${enc(s.id)}&continue=1"><button class="pri">${s.missing ? 'CONTINUE MISSING' : 'OPEN'}</button></a></div>`).join('') : '<div class="dim">No sessions yet.</div>';
    $('homeNote').textContent = list.cloud ? 'Takes are saved on the server and mirrored to cloud storage.' : 'Takes are saved on this server’s disk (data/capture).';
  }
  $('newSession').onclick = async () => {
    try { const r = await api('/api/capture/sessions', { method: 'POST', body: { libraryId: 'BASIC-01' } }); location.href = `/capture?session=${enc(r.session.id)}`; }
    catch (e) { $('joinErr').textContent = e.message; }
  };
  $('joinBtn').onclick = async () => {
    try { const r = await api('/api/capture/pair', { method: 'POST', body: { code: $('joinCode').value } }); location.href = `/capture?pair=${enc(r.token)}&role=${$('joinRole').value}`; }
    catch (e) { $('joinErr').textContent = e.message; }
  };
  // a camera that was paired before: offer to rejoin
  try { const p = JSON.parse(localStorage.getItem('sjc-pair') || 'null'); if (p?.token) $('joinErr').innerHTML = `<a href="/capture?pair=${enc(p.token)}&role=${esc(p.role)}">Rejoin the last session as ${CAM[p.role] || 'CAM B'}</a>`; } catch {}
}

// ═══ DIRECTOR ══════════════════════════════════════════════════════════════
const STEPS = ['connect', 'calibrate', 'record', 'slots', 'analysis'];
const STEP_EL = { connect: 'stepConnect', calibrate: 'stepCalibrate', record: 'stepRecord', slots: 'stepSlots', analysis: 'stepAnalysis' };
const SLOT_CHIP = { missing: ['', 'Not recorded'], uploading: ['info', 'Uploading…'], recorded: ['ok', 'Recorded ✓'], failed: ['bad', 'Check failed — redo'], analysed: ['done', 'Analysed ✓'], skipped: ['', 'Skipped'] };
/** Per-device settings (this iPad's countdown, its voice): conveniences only, never needed. */
const pref = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} } };
/**
 * The warning worth a "Redo?" next to a saved take: it was cut short (or ran far too long), a
 * camera said it was not recording, or (two cameras) only one of them recorded it. Not the device limits every take has (30 fps) nor the motion
 * heuristics (a possibly cropped athlete) — those stay in the take's checks.
 */
const IMPORTANT = /shorter than half|much longer than|said while recording|never started|one view: no 3-D/;
const importantWarning = (res) => (res?.warnings || []).find((w) => IMPORTANT.test(w)) || null;

async function directorMode(sessionId) {
  show($('director'));
  const cd0 = +pref.get('sjc-countdown', 3);
  const D = {
    sessionId, session: null, progress: null, lib: null, order: [], presence: {}, snaps: {}, clock: new ClockSync(), cam: null, camErr: null,
    step: 'connect', current: null, rec: null, check: null, cal: null, toast: null, pair: null, showPair: false, autoChecked: new Set(), autoCheckTimer: null,
    filter: 'all', sheet: null, sheetTakes: null, notice: null,
    takes: new Map(), stoppedAt: {}, notRec: {}, moveOnFrom: null,
    countdown: P.COUNTDOWNS.includes(cd0) ? cd0 : 3, voice: pref.get('sjc-voice', '1') !== '0',
    ana: { cam: 'camA', fps: 30, sel: new Set(), seen: new Set(), status: null, quote: null, busy: false, msg: null, err: null, progress: {} },
  };
  Object.defineProperty(D, 'phase', { get: () => D.rec?.phase || 'idle' });   // (tests)
  Object.defineProperty(D, 'oneCam', { get: () => !!D.session?.oneCamera });
  D.render = () => render();
  window.__capture = D;
  const sid = enc(sessionId);
  const load = async () => {
    const r = await api(`/api/capture/sessions/${sid}`);
    D.session = r.session; D.progress = r.progress; D.lib = LIBRARIES[r.session.libraryId];
    return r;
  };
  try { await load(); } catch (e) {
    if (e.status === 401 || e.status === 403) { location.href = `/login?next=${enc(location.pathname + location.search)}`; return; }
    $('director').innerHTML = `<main><div class="card">Could not open the session: ${esc(e.message)} — <a href="/capture">sessions</a></div></main>`; return;
  }
  D.order = P.captureOrder(D.lib);
  D.current = P.nextToRecord(D.lib, D.session) || D.order[0];

  // this device = camera A (unless ?cam=0)
  const selfCam = Q.get('cam') !== '0';
  if (selfCam) {
    D.cam = new CameraRole({ sessionId, role: 'camA', token: null, clock: D.clock, video: $('selfVideo'), onUi: () => render(), snapshots: false });
    D.cam.start().then(() => { D.camErr = null; render(); }).catch((e) => { D.camErr = `${e.name || 'error'}: ${e.message}`; render(); });
  } else { show($('selfVideo'), false); setText($('subA'), 'separate phone'); }
  D.link = new Link({ sessionId, role: 'director', clock: D.clock, onMessage: (m) => onMessage(m), onStatus: (up) => { if (up && D.stopFor) sendStop(); render(); } });

  function onMessage(m) {
    if (m.t === 'halt' && m.takeId === D.stopFor) { D.stopFor = null; clearTimeout(D.stopTimer); }   // the STOP arrived
    if (m.t === 'error' && D.rec && !D.rec.recAt && m.msg === 'no camera is ready') {
      const t = D.rec.take;
      failRec('No camera is ready — see 1 · Connect.');
      if (t) rejectTake(t.id);                              // never left "uploading" for minutes
    }
    // this page was refreshed (or reopened) while the cameras record: bring STOP back — any take, calibration or check
    if ((m.t === 'welcome' || m.t === 'presence') && m.armed?.recording && !D.rec && !D.resuming) resumeRecording(m.armed);
    if (m.t === 'presence') { D.presence = m.devices || {}; maybeAutoCheck(); render(); }
    else if (m.t === 'session') { setSession(m.session); render(); }
    else if (m.t === 'snap') { D.snaps[m.role] = m; paintViews(); }
    else if (m.t === 'take') onTake(m);
    else if (m.t === 'calibration') { const st = stationOf(m.setup); D.session.calibrations[st] = { ...(D.session.calibrations[st] || {}), status: m.status, suspectReason: m.reason }; render(); }
    else if (m.t === 'record' && D.rec?.take && m.takeId === D.rec.take.id) onRecordStart(m.at);
    else if (m.t === 'analysis') { D.ana.progress[m.takeId] = m.progress; if (D.step === 'analysis') renderAnalysis(); }
    else if (m.t === 'notrecording') { D.notRec[m.takeId] = { cams: m.cams || [], at: Date.now(), kind: m.kind || null, animId: m.animId || null }; render(); }
  }
  /**
   * A session update from the server (keeps the takes this page armed a moment ago). Never goes
   * back in time: a GET answered while a write was being mirrored carries the version before it,
   * and can arrive after the newer one came over the WebSocket — `updatedAt` only moves forward.
   */
  function setSession(s) {
    if (!s) return;
    if (D.session?.updatedAt && s.updatedAt && s.updatedAt < D.session.updatedAt) return;
    const mine = D.session?.animations || {};
    for (const [aid, e] of Object.entries(mine)) {
      const local = (e.takes || []).filter((t) => D.localTakes?.has(t));
      if (!local.length) continue;
      const ne = ((s.animations ||= {})[aid] ||= { takes: [], selectedTake: null });
      for (const t of local) if (!ne.takes.includes(t)) ne.takes.push(t);
    }
    if (!s.pair?.token && D.session?.pair?.token) s.pair = { ...D.session.pair, ...(s.pair || {}) };
    D.session = s; D.progress = P.progress(D.lib, s);
  }
  function onTake(m) {
    const t = m.take;
    D.takes.set(t.id, t);
    // "saved" only on the server's saved event (sent after the bucket has the files, the record and the progress)
    if (D.check?.take?.id === t.id) { D.check.take = t; if (t.state === 'checked') D.check.state = 'done'; }
    if (D.cal?.take?.id === t.id) { D.cal.take = t; if (m.event === 'saved') calSaved(); else if (t.state === 'failed') D.cal.state = 'failed'; }
    if (D.toast?.takeId === t.id) D.toast.state = m.event === 'saved' ? 'saved' : t.state === 'accepted' ? 'saving' : t.state;
    if (D.sheet && D.sheetTakes?.some((x) => x.id === t.id)) D.sheetTakes = D.sheetTakes.map((x) => (x.id === t.id ? t : x));
    if (m.event === 'analysis') loadAnalysis();               // the queue now, not at the next poll
    render();
  }

  // ── sounds: countdown beeps, the sync chirp (heard by both cameras' microphones) that doubles as
  // "GO", and spoken cues — the iPad faces the court from its tripod, so the athlete can't read it
  let actx = null;
  const audio = () => { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {} return actx; };
  function beep(freq = 660, len = 0.14) {
    const a = audio(); if (!a) return;
    try { const t0 = a.currentTime + 0.01, o = a.createOscillator(), g = a.createGain(); o.frequency.value = freq; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.35, t0 + 0.01); g.gain.linearRampToValueAtTime(0, t0 + len); o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + len + 0.02); } catch {}
  }
  /** Say it out loud (speech synthesis; a distinct beep where the device has no voice). */
  function say(text, fallbackFreq = 990) {
    if (!D.voice || !text) return;
    try {
      const ss = window.speechSynthesis;
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') { beep(fallbackFreq, 0.25); return; }
      ss.cancel();
      const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.volume = 1; u.lang = 'en-US';
      ss.speak(u);
    } catch { beep(fallbackFreq, 0.25); }
  }
  function scheduleChirp(takeId, atServer) {
    try {
      const a = audio(); if (!a) return;
      const localWall = D.clock.toLocal(atServer + P.CHIRP_AT_SEC * 1000) ?? Date.now() + 350;
      const delay = Math.max(0.02, (localWall - Date.now()) / 1000);
      const t0 = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
      o.frequency.setValueAtTime(CHIRP.f0, t0); o.frequency.exponentialRampToValueAtTime(CHIRP.f1, t0 + CHIRP.durationMs / 1000);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(CHIRP.gain, t0 + 0.005); g.gain.setValueAtTime(CHIRP.gain, t0 + CHIRP.durationMs / 1000 - 0.01); g.gain.linearRampToValueAtTime(0, t0 + CHIRP.durationMs / 1000);
      o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + CHIRP.durationMs / 1000 + 0.02);
      const playedServer = D.clock.toServer(Date.now() + delay * 1000 + (a.outputLatency || a.baseLatency || 0) * 1000);
      D.link.send({ t: 'chirp', takeId, at: playedServer, chirp: CHIRP, uncertaintyMs: (D.clock.best?.uncertaintyMs || 0) + 10 });
    } catch {}
  }

  // ── what the page knows
  const camReady = (role) => !!D.link.open && !!D.presence[role]?.ready;
  const camOnline = (role) => !!D.presence[role]?.online;
  const cal = (setup) => D.session.calibrations?.[stationOf(setup)] || null;
  const calOk = (setup) => ['valid', 'skipped'].includes(cal(setup)?.status);
  const here = () => stationOf(D.session.currentSetup);
  /** The cameras are not placed + calibrated (or skipped) for this animation's placement. */
  const needsSetup = (anim) => !!anim && (here() !== stationOf(anim.courtSetup) || !calOk(anim.courtSetup));
  const animById = (id) => D.lib.animations.find((a) => a.id === id);
  const posOf = (a) => D.order.indexOf(a) + 1;
  const stationName = (st) => STATIONS[stationOf(st)]?.name || st;
  const setupsOf = (st) => STATIONS[stationOf(st)]?.setups || [st];
  const bothReady = () => camReady('camA') && camReady('camB');
  /** A camera's check: none · running · pass · fail (a check counts only for the phone that holds the role now). */
  function checkOf(role) {
    const p = D.presence[role], c = D.session.cameraChecks?.[role];
    if (D.check && D.check.state !== 'done' && (D.check.roles || []).includes(role)) return { s: 'running' };
    if (!c) return { s: 'none' };
    if (c.deviceId && p?.deviceId && c.deviceId !== p.deviceId) return { s: 'none', other: true };
    return { s: c.ok ? 'pass' : 'fail', c };
  }
  const passing = () => CAMS.filter((r) => checkOf(r).s === 'pass');
  const connectDone = () => (D.oneCam ? passing().length >= 1 : passing().length === 2);
  /** One-camera mode is the session's (the server holds a calibration to both cameras otherwise). */
  async function setOneCam(on) {
    if (!!D.session.oneCamera === on) return;
    D.session.oneCamera = on;
    try { setSession((await api(`/api/capture/sessions/${sid}/setup`, { method: 'POST', body: { oneCamera: on } })).session); } catch (e) { note(`Could not save the camera mode: ${e.message}`); }
  }
  const rejectTake = (id) => api(`/api/capture/sessions/${sid}/rec/${enc(id)}/reject`, { method: 'POST', body: {} }).then(() => refresh()).catch(() => {});

  // ── steps
  function go(step) {
    if (!STEPS.includes(step) || D.rec) return;
    D.step = step;
    try { history.replaceState(null, '', `${location.pathname}${location.search}#${step}`); } catch {}
    if (step === 'connect' && !D.pair) loadPair();
    if (step === 'analysis') loadAnalysis();
    if (step === 'slots' || step === 'analysis' || step === 'record') refresh();
    render(); window.scrollTo(0, 0);
  }
  $('stepper').addEventListener('click', (e) => { const b = e.target.closest('button[data-step]'); if (b) go(b.dataset.step); });
  /** The session from the server (it also moves on anything a restart left half-way). */
  async function refresh() { try { const r = await api(`/api/capture/sessions/${sid}`); setSession(r.session); render(); } catch {} }

  // ── render
  function render() {
    renderHeader(); renderBanners();
    for (const s of STEPS) show($(STEP_EL[s]), s === D.step);
    if (D.step === 'connect') renderConnect();
    else if (D.step === 'calibrate') renderCalibrate();
    else if (D.step === 'record') renderRecord();
    else if (D.step === 'slots') renderSlots();
    else if (D.step === 'analysis') renderAnalysis();
    renderOverlay();
    if (D.sheet) renderSheet();
    paintViews(); attachMirrors();
  }
  function renderHeader() {
    for (const [role, pill] of [['camA', 'pillA'], ['camB', 'pillB']]) {
      const p = D.presence[role], st = p?.state, dot = $(pill).querySelector('.dot');
      dot.className = `dot ${st?.recording ? 'rec' : st?.recError ? 'bad' : camReady(role) ? 'ok' : p?.online ? 'warn' : 'bad'}`;
      setText($(pill + 'txt'), st?.recording ? 'REC' : camReady(role) ? 'READY' : p?.online ? (st?.hidden ? 'hidden' : 'starting') : 'offline');
    }
    const counts = P.slotCounts(D.lib, D.session);
    setText($('recCnt'), `${counts.done}/${counts.total}`);
    for (const b of $('stepper').querySelectorAll('button[data-step]')) {
      const s = b.dataset.step;
      b.classList.toggle('on', s === D.step);
      b.classList.toggle('done', s !== D.step && ((s === 'connect' && connectDone()) || (s === 'calibrate' && D.current && !needsSetup(D.current))));
      b.disabled = !!D.rec && s !== D.step;
    }
  }
  /** Takes whose expected camera has not uploaded half a minute after the stop (its phone asleep, offline, …). */
  function waitingTakes() {
    const out = [];
    for (const t of D.takes.values()) {
      if (!['recording', 'uploading'].includes(t.state) || t.kind === 'check') continue;
      const stopped = D.stoppedAt[t.id] || (t.sync?.stopAtServerMs ? D.clock.toLocal(t.sync.stopAtServerMs) : null);
      if (!stopped || Date.now() - stopped < 30000) continue;
      const lacking = (t.expectedCams || []).filter((c) => !t.cameras?.[c]?.file && !(t.missingCams || []).includes(c));
      if (lacking.length && CAMS.some((c) => t.cameras?.[c]?.file)) out.push({ t, lacking });
    }
    return out;
  }
  function renderBanners() {
    const bs = [];
    for (const r of CAMS) {
      const p = D.presence[r], st = p?.state;
      if (!p?.online) continue;
      if (st?.recError) bs.push(`<div class="banner bad">${st.recording ? `${CAM[r]} is not recording` : `${CAM[r]}'s last recording failed`} — keep its screen on and the page in front. <span class="small">(${esc(st.recError)})</span></div>`);
      else if (st?.hidden) bs.push(`<div class="banner">${CAM[r]}'s page is in the background — bring it to the front (and keep its screen on).</div>`);
      else if (st?.camera?.ended || st?.camera?.muted) bs.push(`<div class="banner">${CAM[r]}'s camera delivers no picture — keep its screen on and the page in front.</div>`);
    }
    // an expected camera that never started (the hub noticed a few seconds after RECORD)
    for (const [tid, x] of Object.entries(D.notRec)) {
      if (Date.now() - x.at > 90000 || D.rec?.take?.id === tid || (D.step === 'record' && D.toast?.takeId === tid)) continue;   // (the toast says it)
      const a = x.animId ? animById(x.animId) : null;
      bs.push(`<div class="banner bad">${x.cams.map((c) => CAM[c]).join(' + ')} did not start recording ${a ? `#${posOf(a)} ${esc(a.title)} ${esc(a.subtitle || '')}` : x.kind === 'calibration' ? 'the calibration' : x.kind === 'check' ? 'the camera check' : 'the last take'} — its page was asleep or in the background. ${x.kind === 'take' || a ? 'That take will need a redo. ' : ''}Keep its screen on and the page in front. <button class="small" data-act="notRecOk" data-take="${esc(tid)}">OK</button></div>`);
    }
    const waiting = waitingTakes();
    if (waiting.length) {
      const names = waiting.map(({ t }) => (t.kind === 'calibration' ? 'the calibration' : `#${posOf(animById(t.animId))} ${t.title || ''}`)).join(', ');
      const cams = [...new Set(waiting.flatMap((w) => w.lacking))].map((c) => CAM[c]).join(' + ');
      bs.push(`<div class="banner">Waiting for ${cams}'s upload: ${esc(names)} — keep its page open (the recording is kept on the phone). <button class="small" data-act="goOnWithout">Go on without ${cams}</button></div>`);
    }
    const c = D.current && cal(D.current.courtSetup);
    if (c?.status === 'suspect' && here() === stationOf(D.current.courtSetup)) bs.push(`<div class="banner bad">Setup ${stationOf(D.current.courtSetup)}: ${esc(human(c.suspectReason || 'a camera moved'))} — calibrate again. <button class="small" data-act="toCal">Calibrate</button></div>`);
    if (D.camErr) bs.push(`<div class="banner bad">This device's camera: ${esc(D.camErr)} <button class="small" data-act="camRetry">Try again</button></div>`);
    if (D.link.replaced) bs.push('<div class="banner bad">This session is now directed from another page — this one stopped. <button class="small" data-act="direct">DIRECT FROM HERE</button></div>');
    else if (!D.link.open) bs.push('<div class="banner">Reconnecting to the server…</div>');
    if (D.cam?.link.replaced) bs.push('<div class="banner bad">CAM A is now another page — this device stopped being CAM A. <button class="small" data-act="takeover">USE THIS DEVICE AS CAM A</button></div>');
    if (D.cam) bs.push(keptBanner(D.cam.uploads));
    if (D.notice) bs.push(`<div class="banner ${D.notice.bad ? 'bad' : ''}">${esc(D.notice.msg)} <button class="small" data-act="dismiss">OK</button></div>`);
    setHTML($('banners'), bs.join(''));
  }
  const note = (msg, bad = true) => { D.notice = { msg, bad }; render(); };

  /** Paint every camera view: this device's live video for CAM A, the relayed snapshots otherwise. */
  function paintViews() {
    const map = [['viewA', 'camA'], ['viewB', 'camB'], ['calViewA', 'camA'], ['calViewB', 'camB'], ['recViewA', 'camA'], ['recViewB', 'camB']];
    for (const [id, role] of map) paint($(id), role);
  }
  function paint(el, role) {
    if (!el) return;
    const vid = el.querySelector('video[data-self]'), img = el.querySelector('img.snap'), none = el.querySelector('.none'), age = el.querySelector('.age');
    const local = role === 'camA' && !!D.cam?.cam.stream;
    if (vid) show(vid, local);
    const snap = !local ? D.snaps[role] : null;
    if (img) { if (snap && img.dataset.at !== String(snap.at)) { img.src = snap.jpg; img.dataset.at = String(snap.at); } show(img, !!snap); }
    if (none) {
      show(none, !local && !snap);
      setText(none, role === 'camA' && D.cam ? (D.camErr ? `Camera blocked (${D.camErr})` : 'Starting the camera…') : !camOnline(role) ? `${CAM[role]} is not connected` : 'Waiting for its picture…');
    }
    if (age) { const old = snap && Date.now() - snap.at > 5000; show(age, !!old); if (old) setText(age, `${Math.round((Date.now() - snap.at) / 1000)} s ago`); }
  }
  /** Every <video data-self> shows this device's camera (the header's small one records the frame times). */
  function attachMirrors() {
    const st = D.cam?.cam.stream; if (!st) return;
    for (const v of document.querySelectorAll('video[data-self]')) {
      if (v.srcObject !== st) { v.srcObject = st; v.muted = true; v.playsInline = true; }
      if (v.paused && v.offsetParent !== null) v.play().catch(() => {});
    }
    D.cam.cam.keepPlaying();
  }

  // ── STEP 1: CONNECT
  async function loadPair() {
    try {
      const r = await api(`/api/capture/sessions/${sid}/pair`);
      D.pair = r;
      $('qr').innerHTML = r.qrSvg; setText($('pairCode'), r.code);
      setText($('pairExpiry'), `code valid until ${new Date(r.codeExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · the QR code does not expire`);
      show($('pairLanHint'), !!r.https);
      $('pairUrls').innerHTML = r.urls.map((u) => `<div>or open <a href="${esc(u.url)}" target="_blank">${esc(u.url.replace(/pair=.*/, 'pair=…'))}</a></div>`).join('');
    } catch (e) { setText($('pairUrls'), e.message); }
  }
  function checkLine(role) {
    const p = D.presence[role], k = checkOf(role);
    if (role === 'camA' && D.camErr) return ['bad', `✗ ${D.camErr}`];
    if (!p?.online) return ['', role === 'camB' ? 'Waiting for CAM B — scan the QR code with the second phone' : 'Waiting for CAM A'];
    if (k.s === 'running') return ['run', D.check?.state === 'checking' ? 'Camera check: checking the video…' : 'Camera check: recording 2 s…'];
    if (k.s === 'pass') { const c = k.c; return ['ok', `✓ Camera check passed — ${c.durationSec ? c.durationSec.toFixed(1) + ' s of real video' : 'real video'}${c.bytes ? `, ${(c.bytes / 1e6).toFixed(1)} MB` : ''}${c.frames ? `, ${c.frames} frames` : ''}${c.cameraSaid ? ` (it said: ${c.cameraSaid})` : ''}`]; }
    if (k.s === 'fail') return ['bad', `✗ Camera check failed — ${CAM[role]} recorded no usable video (${k.c.reason})${k.c.cameraSaid ? `. ${CAM[role]} said: ${k.c.cameraSaid}` : ''}. Keep its screen on and the page in front, then run the check again.`];
    if (!camReady(role)) return ['', !D.link.open ? 'Reconnecting…' : p.state?.hidden ? `${CAM[role]}'s page is in the background` : 'The camera is starting…'];
    return ['run', k.other ? 'A different phone — the camera check runs by itself…' : 'Camera check: starting…'];
  }
  function renderConnect() {
    for (const [role, sfx] of [['camA', 'A'], ['camB', 'B']]) {
      const p = D.presence[role], st = p?.state, d = st?.camera;
      const chip = $('st' + sfx);
      const [cls, txt] = st?.recording ? ['rec', '● REC'] : camReady(role) ? ['ok', 'READY'] : p?.online ? ['warn', st?.hidden ? 'HIDDEN' : 'STARTING'] : ['bad', 'OFFLINE'];
      chip.className = `chip ${cls}`; setText(chip, txt);
      setText($('info' + sfx), d ? fmtFormat(d) : p?.online ? 'camera starting…' : 'not connected');
      const [lc, lt] = checkLine(role);
      $('chk' + sfx).className = `checkline ${lc}`; setText($('chk' + sfx), lt);
    }
    show($('pairBox'), !camOnline('camB') || D.showPair);
    show($('viewB'), camOnline('camB') && !D.showPair);
    setText($('pairAgain'), D.showPair ? 'Hide the pairing code' : 'Pair a different phone as CAM B');
    const any = CAMS.some((r) => camReady(r));
    const running = !!(D.check && D.check.state !== 'done');
    $('checkBtn').disabled = !any || running || !!D.rec || !D.link.open;
    $('connectNext').disabled = passing().length < 2;
    setText($('connectNext'), needsSetup(D.current) ? 'NEXT: Calibrate →' : 'NEXT: Record →');
    $('oneCamBtn').disabled = passing().length < 1;
    show($('oneCamBtn'), passing().length < 2);
    setText($('connectWhy'), passing().length === 2 ? 'Both cameras recorded real video.' : running ? 'Checking the cameras…' : !camOnline('camB') ? 'Pair CAM B to record two views (3-D needs both).' : passing().length === 1 ? 'One camera passed the check.' : '');
  }
  $('pairAgain').onclick = () => { D.showPair = !D.showPair; if (D.showPair) loadPair(); render(); };
  $('checkBtn').onclick = () => runCheck();
  $('oneCamBtn').onclick = async () => { await setOneCam(true); go(needsSetup(D.current) ? 'calibrate' : 'record'); };
  $('connectNext').onclick = async () => { await setOneCam(false); go(needsSetup(D.current) ? 'calibrate' : 'record'); };
  /** Each phone's camera check runs by itself once it is READY (on this step). */
  function maybeAutoCheck() {
    if (D.step !== 'connect' || D.rec || (D.check && D.check.state !== 'done') || !D.link.open || D.autoCheckTimer) return;
    const due = CAMS.filter((r) => camReady(r) && checkOf(r).s === 'none' && !D.autoChecked.has(`${r}:${D.presence[r].deviceId}`));
    if (!due.length) return;
    // a moment for the other camera to become ready too: one check for both
    D.autoCheckTimer = setTimeout(() => {
      D.autoCheckTimer = null;
      if (D.step !== 'connect' || D.rec || (D.check && D.check.state !== 'done') || !D.link.open) return;
      for (const r of CAMS) if (camReady(r)) D.autoChecked.add(`${r}:${D.presence[r].deviceId}`);
      runCheck();
    }, 1500);
  }
  function runCheck() {
    if (D.rec || (D.check && D.check.state !== 'done') || !D.link.open) return;
    const roles = CAMS.filter(camReady);
    if (!roles.length) return;
    D.check = { state: 'starting', roles, at: Date.now() };
    begin('check');
  }

  // ── STEP 2: CALIBRATE (one per camera placement: setups A + B share one, C has its own)
  const calStation = () => stationOf(D.current?.courtSetup || D.session.currentSetup || 'A');
  function zoomCtl(role) {
    const d = D.presence[role]?.state?.camera, z = d?.capabilities?.zoom;
    if (!z || !(z.min < 1) || !camReady(role)) return '';
    const cur = +(d.zoom ?? 1), one = Math.max(z.min, Math.min(z.max, 1));
    return `<span class="zoom">zoom ${cur.toFixed(1)}× <button class="small" data-zoom="${role}" data-z="${z.min}" ${cur <= z.min + 0.01 ? 'disabled' : ''}>Wider (${z.min}×)</button><button class="small" data-zoom="${role}" data-z="${one}" ${Math.abs(cur - one) < 0.01 ? 'disabled' : ''}>1×</button></span>`;
  }
  function renderCalibrate() {
    const st = calStation(), S = STATIONS[st], c = cal(st), walk = calibrationWalk(st);
    const uses = setupsOf(st).map((x) => `${x} (${SETUPS[x].name.toLowerCase()})`).join(' and ');
    setText($('calTitle'), `2 · Calibrate — ${S.name}`);
    setText($('calFor'), `This camera placement is for setup${setupsOf(st).length > 1 ? 's' : ''} ${uses}. About ${walk.totalSec} s of walking.`);
    const moving = here() && here() !== st;
    show($('calMove'), !!moving || c?.status === 'stale');
    if (moving) setText($('calMove'), `New place: move the two cameras to the ${S.name.toLowerCase()} positions below, then mark the floor and calibrate.`);
    else if (c?.status === 'stale') setText($('calMove'), `The cameras were moved since this was calibrated (${c.staleReason || 'moved'}) — calibrate again (or skip).`);
    setHTML($('calCourt'), courtSVG(st, null, { width: 520, calibration: true }));
    setHTML($('calPlace'), `<b class="a">CAM A</b><span>${esc(S.camA.note)}</span><b class="b">CAM B</b><span>${esc(S.camB.note)}</span>`);
    setHTML($('calMarks'), `<li><b>✕ (middle)</b> — ${esc(walk.middleWords)}</li>${walk.corners.map((k) => `<li><b>${k.n}</b> ${esc(k.name)} — ${esc(k.words)}</li>`).join('')}`);
    setHTML($('calHowto'), [
      '<b>Place the cameras</b> as shown (A and B): lens at chest height, phone sideways, aimed at ✕; lock them on the tripods.',
      '<b>Mark the floor:</b> a cone or a piece of tape on ✕ and on corners 1–4 (where, in words: the list under the diagram).',
      '<b>Check both pictures:</b> stand on each numbered mark — you must be visible <b>head to feet</b> in both pictures. If not, move that camera back (or tap <b>Wider</b> if it offers a wider lens).',
      `<b>Press CALIBRATE.</b> After the countdown, walk at an easy pace ✕ → 1 → 2 → 3 → 4 → ✕ as the iPad says the corners (lit on the map), then stand on ✕ with your arms up. It stops by itself after ${walk.totalSec} s and saves.`,
    ].map((x) => `<li>${x}</li>`).join(''));
    setHTML($('calZoomA'), zoomCtl('camA')); setHTML($('calZoomB'), zoomCtl('camB'));
    // the result of this placement's calibration
    let html = '';
    const run = D.cal?.setup === st ? D.cal : null;
    const stills = (id) => `<div class="stills">${CAMS.map((cm) => `<div><div class="tiny dim" style="margin-bottom:4px">${CAM[cm]}</div><img alt="${CAM[cm]} calibration still" src="/api/capture/sessions/${sid}/rec/${enc(id)}/${cm}/still.jpg?t=1" onerror="this.style.visibility='hidden'"></div>`).join('')}</div>`;
    if (run && run.state === 'saving') {
      const t = run.take, waiting = CAMS.filter((cm) => (t?.expectedCams || []).includes(cm) && !t?.cameras?.[cm]?.file && !(t?.missingCams || []).includes(cm));
      const late = D.oneCam && waiting.length && Date.now() - run.at > 20000 && CAMS.some((cm) => t?.cameras?.[cm]?.file);
      html = `<div class="result" id="calSaving"><h3>Saving the calibration…</h3><div class="dim">Both recordings upload and are checked — a few seconds. Don't move the cameras.${waiting.length ? ` Waiting for ${waiting.map((x) => CAM[x]).join(' + ')}.` : ''}</div>${late ? `<div class="row" style="margin-top:8px"><button class="small" data-act="calFinish">Save with ${CAMS.filter((cm) => t.cameras?.[cm]?.file).map((x) => CAM[x]).join(' + ')} only</button></div>` : ''}</div>`;
    } else if (run && run.state === 'failed') {
      html = `<div class="result bad"><h3>✗ Calibration not saved</h3><div>${esc(human(run.take?.failReason || cal(st)?.lastFailed?.reason || 'a camera produced no usable video'))}</div><div class="dim small" style="margin-top:6px">Keep both screens on with the page in front, then press CALIBRATE again.</div></div>`;
    } else if ((run && run.state === 'saved') || (c?.status === 'valid' && c.current)) {
      const id = run?.state === 'saved' ? run.take.id : c.current, at = run?.state === 'saved' ? Date.now() : Date.parse(c.acceptedAt || '');
      html = `<div class="result ok" id="calSaved"><h3>Calibration saved ✓</h3><div class="dim small">${esc(S.name)}${at ? ' · ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} — don't move the cameras from now on. Next: <b>Record</b>.</div>${stills(id)}</div>`;
    } else if (c?.status === 'skipped') {
      html = '<div class="result"><h3>Calibration skipped</h3><div class="dim small">The cameras are placed; you can calibrate later from here (before moving them).</div></div>';
    } else if (c?.status === 'suspect') {
      html = `<div class="result bad"><h3>A camera moved</h3><div>${esc(human(c.suspectReason || ''))}</div><div class="dim small">Put it back (or leave it) and calibrate again.</div></div>`;
    } else if (c?.lastFailed) {
      html = `<div class="result bad"><h3>The last calibration failed</h3><div>${esc(human(c.lastFailed.reason))}</div></div>`;
    }
    setHTML($('calResult'), html);
    // (the result is at the top of the step: bring it into view once when it changes)
    const key = run ? `${run.take?.id}:${run.state}` : '';
    if (run && D.calShown !== key) { D.calShown = key; setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 50); }
    const done = (calOk(st) && here() === st && !(run && run.state === 'saving')) || run?.state === 'saved';
    // two cameras: both READY (a calibration needs both views); one camera only when chosen on step 1
    const ready = D.oneCam ? CAMS.some(camReady) : bothReady();
    $('calibrateBtn').disabled = !ready || !!D.rec || !!(run && run.state === 'saving') || !D.link.open;
    setText($('calibrateBtn'), c?.status === 'valid' || c?.status === 'suspect' || run ? 'CALIBRATE AGAIN' : 'CALIBRATE');
    $('calibrateBtn').classList.toggle('pri', !done); $('calibrateBtn').classList.toggle('big', !done);
    show($('calNext'), done);
    show($('skipCalBtn'), !done);
    setText($('calWhy'), !D.link.open ? 'Connecting…' : ready ? '' : D.oneCam ? 'Waiting for a camera — see 1 · Connect.' : `Waiting for ${CAMS.filter((r) => !camReady(r)).map((r) => CAM[r]).join(' + ')} to be READY (both cameras film the calibration) — or choose "Continue with one camera" on 1 · Connect.`);
  }
  $('calibrateBtn').onclick = () => begin('calibration', { setup: calStation() });
  $('calNext').onclick = () => go('record');
  $('skipCalBtn').onclick = async () => {
    const setup = calStation();
    try {
      const r = await api(`/api/capture/sessions/${sid}/setup`, { method: 'POST', body: { setup, skipCalibration: true } });
      setSession(r.session);
      D.link.send({ t: 'relay', msg: { t: 'setref', setup } });            // cameras still watch for being moved
      toStation(setup);
      go('record');
    } catch (e) { note(`Could not skip: ${e.message}`); }
  };
  /** The cameras are at placement `st` now: the animation on the Record step is one of its own. */
  function toStation(st) {
    if (D.current && stationOf(D.current.courtSetup) === stationOf(st)) return;
    D.current = P.nextToRecord(D.lib, { ...D.session, currentSetup: stationOf(st) }) || D.current;
  }

  // ── STEP 3: RECORD
  function renderRecord() {
    const a = D.current;
    const counts = P.slotCounts(D.lib, D.session);
    if (!a) { setHTML($('toast'), ''); return; }
    const st = SETUPS[a.courtSetup], ss = P.slotStatus(D.session, a.id), x = takeScript(a);
    setHTML($('recPos'), `#${posOf(a)} of ${D.order.length} · Setup ${a.courtSetup} — ${esc(st.name)} <span class="chip ${SLOT_CHIP[ss.status][0]}" style="margin-left:6px">${SLOT_CHIP[ss.status][1]}</span>${counts.toRecord === 0 && counts.uploading === 0 ? ' <span class="chip ok">All animations recorded ✓</span>' : ''}`);
    setText($('animTitle'), a.title); setText($('animSub'), a.subtitle || '');
    setText($('recCompact'), x.compact);
    setHTML($('animCourt'), courtSVG(a.courtSetup, a, { width: 560, focus: true, cameras: false }));
    setText($('startWhere'), x.startWhere); setText($('startMarks'), `Where: ${x.startMarks}`);
    setText($('moveWhere'), x.move);
    setText($('finishWhere'), x.finishWhere); setText($('finishMarks'), x.moving ? `Where: ${x.finishMarks}` : '');
    setText($('startPose'), poseName(a.startState)); setText($('startDesc'), poseDesc(a.startState));
    const endS = a.endResolves ? [a.endState] : a.endState;
    setText($('finishPose'), `${poseName(endS)}${a.endResolves ? ` → ${STATES[a.endResolves]?.name}` : ''}`); setText($('finishDesc'), poseDesc(endS));
    setHTML($('moveCues'), a.cues.map((c) => `<li>${esc(c)}</li>`).join(''));
    setText($('protocol'), x.protocol);
    setHTML($('facts'), [`~${a.durationSec} s${a.loop ? ' · loop' : ''}`, `ball: ${HAND_LABEL[a.ballHand]}`, `moves ${DIR_LABEL[a.direction]}`, ss.takes ? `${ss.takes} take${ss.takes > 1 ? 's' : ''} so far` : null, `#${a.id} ${a.key}`].filter(Boolean).map((f) => `<span class="chip">${esc(f)}</span>`).join(''));
    for (const b of $('countdownSeg').querySelectorAll('button[data-cd]')) b.classList.toggle('on', +b.dataset.cd === D.countdown);
    setText($('voiceBtn'), D.voice ? '🔊 Voice on' : '🔇 Voice off');
    // the cameras' placement: is this animation's one done (or does the current one still have work)?
    const now = here(), there = stationOf(a.courtSetup);
    let setupHtml = '';
    if (now && now !== there && D.moveOnFrom !== now) {
      const td = P.stationTodo(D.lib, D.session, now);
      if (td.toRecord.length || td.uploading.length) {
        setupHtml = `<b>Setup ${esc(setupsOf(now).join(' + '))} still has ${[td.toRecord.length ? `${td.toRecord.length} to record or redo` : '', td.uploading.length ? `${td.uploading.length} uploading (a failed check would need the cameras here)` : ''].filter(Boolean).join(' and ')}.</b> Finish them before moving the cameras.`
          + ` ${td.toRecord.length ? '<button class="small" data-act="toStationTodo">Go to them</button>' : ''}<button class="small" data-act="moveOn">Move the cameras anyway</button>`;
      }
    }
    if (!setupHtml && needsSetup(a)) {
      setupHtml = now && now !== there
        ? `Setup ${a.courtSetup} — ${esc(stationName(there).toLowerCase())}: move the cameras and calibrate first. <button class="small" data-act="toCal">2 · Calibrate</button>`
        : `Setup ${a.courtSetup}: place and calibrate the cameras first (or skip). <button class="small" data-act="toCal">2 · Calibrate</button>`;
    }
    show($('recSetup'), !!setupHtml);
    setHTML($('recSetup'), setupHtml);
    const setupBad = needsSetup(a);
    // record button
    const both = bothReady(), one = camReady('camA') || camReady('camB');
    const rb = $('recordBtn');
    rb.disabled = !(D.link.open && one) || setupBad || !!D.rec;
    setText(rb, both || !one ? 'RECORD' : `RECORD (${camReady('camA') ? 'CAM A' : 'CAM B'} only)`);
    setText($('recordWhy'), !D.link.open ? 'Connecting…' : setupBad ? 'Place / calibrate the cameras for this setup first.' : !one ? 'Waiting for the cameras — see 1 · Connect.' : !both && !D.oneCam ? 'Only one camera is ready — wake CAM B for two views.' : `${D.countdown}-s countdown, then it records and stops by itself.`);
    renderToast();
  }
  function renderToast() {
    const t = D.toast;
    if (!t) return setHTML($('toast'), '');
    const e = D.session.animations?.[t.anim.id], res = e?.results?.[t.takeId], nr = D.notRec[t.takeId];
    const failed = res?.state === 'failed' || t.state === 'failed';
    const saved = res?.state === 'recorded' || t.state === 'saved';
    const name = `${t.anim.title}${t.anim.subtitle ? ' ' + t.anim.subtitle : ''}`;
    const warn = saved && res ? importantWarning(res) : null;
    let msg, cls = '';
    if (failed) { msg = `✗ ${name}: the check failed — ${human(res?.reason || 'a camera produced no usable video')}. Record it again.`; cls = 'bad'; }
    else if (saved && res?.short && e?.selectedTake && e.selectedTake !== t.takeId) { msg = `✓ ${name} saved — but it is short (${human(warn || 'stopped early')}), so take ${e.takes.indexOf(e.selectedTake) + 1} stays the selected one. Redo?`; cls = 'warn'; }
    else if (saved && warn) { msg = `✓ ${name} saved — but ${human(warn)}. Redo?`; cls = 'warn'; }
    else if (saved) msg = `✓ ${name} — saved.`;
    if (saved && !t.savedAt) t.savedAt = Date.now();
    if (!cls && saved && Date.now() - t.savedAt > 15000) { D.toast = null; return setHTML($('toast'), ''); }   // done: it goes away by itself
    else if (nr) { msg = `✗ ${nr.cams.map((c) => CAM[c]).join(' + ')} did not start recording ${name} — it will need a redo. Keep that phone's screen on and the page in front.`; cls = 'bad'; }
    else msg = `✓ ${name} recorded — uploading in the background…`;
    const redo = !!cls || Date.now() - t.at < 12000;
    setHTML($('toast'), `<div class="toast ${cls}"><span class="t" id="toastMsg">${esc(msg)}</span>${redo ? `<button class="small" id="toastRedo" data-act="redo">Redo ${esc(t.anim.title)}</button>` : ''}${cls ? '<button class="small ghost" data-act="toastOk" title="dismiss">OK</button>' : ''}</div>`);
  }
  $('recordBtn').onclick = () => { if (D.current) begin('take', { anim: D.current }); };
  $('slotsBtn').onclick = () => go('slots');
  $('countdownSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-cd]'); if (!b) return; D.countdown = +b.dataset.cd; pref.set('sjc-countdown', D.countdown); render(); });
  $('voiceBtn').onclick = () => { D.voice = !D.voice; pref.set('sjc-voice', D.voice ? '1' : '0'); if (D.voice) say('Voice on'); render(); };
  const stepAnim = (dir) => { const i = D.order.indexOf(D.current); D.current = D.order[(i + dir + D.order.length) % D.order.length]; render(); };
  $('prevAnim').onclick = () => stepAnim(-1); $('nextAnim').onclick = () => stepAnim(1);

  // ── recording: countdown → the cameras start on the same server time → it stops by itself
  async function begin(kind, { anim = null, setup = null } = {}) {
    if (D.rec || !D.link.open) { if (kind === 'check' && D.check?.state === 'starting') { D.check = null; render(); } return; }
    const countdown = kind === 'check' ? 0 : D.countdown;
    const script = kind === 'take' ? takeScript(anim) : null, walk = kind === 'calibration' ? calibrationWalk(setup) : null;
    const target = kind === 'check' ? P.CHECK_SEC : kind === 'calibration' ? walk.totalSec : P.autoStopSec(anim);
    const r = (D.rec = { kind, anim, setup, target, script, walk, said: new Set(), phase: countdown ? 'countdown' : 'arming', n: countdown });
    if (kind !== 'check') {
      audio();
      if (kind === 'take') D.toast = null;
      // (said inside the tap: iOS lets a page speak only after a user gesture)
      say(kind === 'calibration' ? 'Stand in the middle. Then walk to each corner as I call it.' : script.prep);
    }
    render(); tick();
    if (!countdown) return arm(r);
    for (let n = countdown; n >= 1; n--) {
      if (D.rec !== r) return;
      r.n = n; if (n <= 3) beep(n === 1 ? 880 : 660);
      if (n === 1) arm(r);                                  // the recording starts ~0.8 s after "1": on "GO"
      await sleep(1000);
    }
  }
  async function arm(r) {
    try {
      const path = r.kind === 'take' ? 'takes' : r.kind === 'calibration' ? 'calibrations' : 'checks';
      const res = await api(`/api/capture/sessions/${sid}/${path}`, { method: 'POST', body: r.kind === 'take' ? { animId: r.anim.id } : r.kind === 'calibration' ? { setup: r.setup } : {} });
      r.take = res.take || res.calibration || res.check;
      if (D.rec !== r) { rejectTake(r.take.id); return; }   // cancelled meanwhile
      D.takes.set(r.take.id, r.take);
      if (r.kind === 'take') { const e = (D.session.animations[r.anim.id] ||= { takes: [], selectedTake: null }); if (!e.takes.includes(r.take.id)) e.takes.push(r.take.id); (D.localTakes ||= new Set()).add(r.take.id); }
      if (r.kind === 'check') Object.assign(D.check, { take: r.take, state: 'recording' });
      D.link.send({ t: 'start', takeId: r.take.id });
      r.startSent = Date.now();
      setTimeout(() => startFallback(r, 1), 3000);
    } catch (e) { if (D.rec === r) failRec(`Could not start: ${e.message}`); }
  }
  /** The 'record' message did not arrive: ask the server (or send the start again). */
  async function startFallback(r, n) {
    if (D.rec !== r || r.recAt || !r.take) return;
    try {
      const t = (await api(`/api/capture/sessions/${sid}/rec/${enc(r.take.id)}`)).take;
      if (D.rec !== r || r.recAt) return;
      if (t.sync?.startAtServerMs) return onRecordStart(t.sync.startAtServerMs);
      if (n >= 3) { rejectTake(r.take.id); return failRec('The cameras did not start — check the connection and try again.'); }
      D.link.send({ t: 'start', takeId: r.take.id });
    } catch {}
    setTimeout(() => startFallback(r, n + 1), 2500);
  }
  function onRecordStart(at) {
    const r = D.rec; if (!r || r.recAt) return;
    r.recAt = at; r.phase = 'recording';
    if (r.kind !== 'check') scheduleChirp(r.take.id, at);
    const startLocal = D.clock.toLocal(at) ?? Date.now();
    r.autoStop = setTimeout(() => { if (D.rec === r) stop(); }, Math.max(0, startLocal - Date.now()) + r.target * 1000);
    render();
  }
  function failRec(msg) {
    const r = D.rec; if (!r) return;
    clearTimeout(r.autoStop); D.rec = null;
    if (r.kind === 'check') D.check = { state: 'done', error: msg };
    note(msg);
  }
  /** Resume after this page was refreshed while the cameras record: STOP is back, the auto-stop too. */
  async function resumeRecording(armed) {
    D.resuming = true;
    try {
      const t = (await api(`/api/capture/sessions/${sid}/rec/${enc(armed.takeId)}`)).take;
      if (t.state !== 'recording' || D.rec) return;
      const anim = t.animId ? animById(t.animId) : null;
      const walk = t.kind === 'calibration' ? calibrationWalk(t.courtSetup) : null;
      const target = t.kind === 'check' ? P.CHECK_SEC : walk ? walk.totalSec : anim ? P.autoStopSec(anim) : (t.targetDurationSec || 4);
      const r = (D.rec = { kind: t.kind, anim, setup: t.courtSetup, target, script: anim ? takeScript(anim) : null, walk, said: new Set(), phase: 'recording', take: t, resumed: true, startSent: Date.now() });
      if (t.kind === 'check') D.check = { state: 'recording', take: t, roles: t.expectedCams || [], at: Date.now() };
      if (anim) D.current = anim;
      r.recAt = armed.at || t.sync?.startAtServerMs || D.clock.toServer(Date.now());
      const startLocal = D.clock.toLocal(r.recAt) ?? Date.now();
      r.autoStop = setTimeout(() => { if (D.rec === r) stop(); }, Math.max(300, startLocal + target * 1000 - Date.now()));
      if (t.kind !== 'check') D.step = t.kind === 'calibration' ? 'calibrate' : 'record';
      render(); tick();
    } catch {} finally { D.resuming = false; }
  }
  function stop() {
    const r = D.rec; if (!r) return;
    clearTimeout(r.autoStop);
    D.rec = null;
    if (!r.take) { if (r.kind === 'check') D.check = null; render(); return; }        // cancelled in the countdown (a late arm is discarded)
    D.stopFor = r.take.id; D.stoppedAt[r.take.id] = Date.now();
    sendStop();
    // CANCEL before the cameras started (at "1", or in the 0.8 s lead): the cameras halt and the
    // take is discarded — it is not a recording of the move (its footage is kept, never counted)
    const startLocal = r.recAt != null ? D.clock.toLocal(r.recAt) : null;
    if (startLocal == null || Date.now() < startLocal) {
      rejectTake(r.take.id);
      if (r.kind === 'check') D.check = null;
      render(); return;
    }
    if (r.kind === 'take') {
      D.toast = { takeId: r.take.id, anim: r.anim, at: Date.now(), state: 'uploading' };
      const next = P.nextToRecord(D.lib, D.session, { after: r.anim.id });
      if (next) D.current = next;                                        // straight on to the next one to record
    } else if (r.kind === 'calibration') {
      D.cal = { take: r.take, state: 'saving', setup: stationOf(r.setup), at: Date.now() };
      setTimeout(() => calWatch(r.take.id), 1500);
    } else if (r.kind === 'check') {
      Object.assign(D.check, { state: 'checking', stoppedAt: Date.now() });
      setTimeout(() => checkWatch(r.take.id), 1500);
    }
    render();
  }
  // the STOP is sent until the hub answers with the halt — also across a reconnect (a dropped
  // message would leave the cameras recording until their 120 s cap)
  function sendStop() {
    clearTimeout(D.stopTimer);
    if (!D.stopFor) return;
    D.link.send({ t: 'stop', takeId: D.stopFor });
    D.stopTimer = setTimeout(sendStop, 2000);
  }
  $('stopBtn').onclick = () => stop();
  /** The check's verdict (the WebSocket brings it; this is the safety net). A camera that never uploads: go on without it. */
  async function checkWatch(id) {
    for (let i = 0; i < 40 && D.check?.take?.id === id && D.check.state !== 'done'; i++) {
      await sleep(1000);
      try {
        const t = (await api(`/api/capture/sessions/${sid}/rec/${enc(id)}`)).take;
        if (D.check?.take?.id !== id) return;
        D.check.take = t;
        if (t.state === 'checked') { D.check.state = 'done'; await refresh(); return; }
        if (i === 14) await api(`/api/capture/sessions/${sid}/rec/${enc(id)}/finish`, { method: 'POST', body: {} }).catch(async (e) => { if (e.status === 409 && /no camera/.test(e.message)) { D.check = { state: 'done', error: 'no camera sent its test recording' }; note('Camera check: no camera sent its test recording — keep the pages open and try again.'); } });
      } catch {}
      render();
    }
    if (D.check?.take?.id === id && D.check.state !== 'done') D.check.state = 'done';
    render();
  }
  async function calSaved() {
    if (!D.cal) return;
    D.cal.state = 'saved';
    await refresh();
    toStation(D.cal.setup);                                 // on the Record step: the first animation of this placement
    render();
  }
  async function calWatch(id) {
    for (let i = 0; i < 120 && D.cal?.take?.id === id && D.cal.state === 'saving'; i++) {
      await sleep(1500);
      try {
        const t = (await api(`/api/capture/sessions/${sid}/rec/${enc(id)}`)).take;
        if (D.cal?.take?.id !== id || D.cal.state !== 'saving') return;
        D.cal.take = t;
        if (t.state === 'accepted' || t.state === 'failed') {
          await refresh();                                  // saved = the session says so (after the bucket has it)
          if (t.state === 'failed') D.cal.state = 'failed';
          else if (cal(D.cal.setup)?.current === id) await calSaved();
        }
      } catch {}
      render();
    }
  }

  function tick() {
    renderOverlay();
    if (D.rec) requestAnimationFrame(tick);
  }
  /** Say a cue once per recording (`key`); never in the first 0.6 s, where the sync chirp plays. */
  const sayOnce = (r, key, text, t) => { if (text && t != null && t >= 0.6 && !r.said.has(key)) { r.said.add(key); say(text); } };
  function renderOverlay() {
    const r = D.rec, ov = $('recOverlay');
    const on = !!r && r.kind !== 'check';
    show(ov, on);
    if (!on) return;
    const startLocal = r.recAt != null ? D.clock.toLocal(r.recAt) ?? null : null;
    const t = startLocal != null ? (Date.now() - startLocal) / 1000 : null;
    const live = t != null && t >= 0;
    ov.classList.toggle('recording', live);
    show($('ovRec'), live);
    setText($('stopBtn'), live ? 'STOP' : 'CANCEL');
    // a camera that is not recording is told right here (the page's banners are under this overlay)
    const nr = r.take ? D.notRec[r.take.id] : null;
    const warn = r.take ? CAMS.map((c) => {
      const p = D.presence[c], st = p?.state, expected = !r.take.expectedCams || r.take.expectedCams.includes(c);
      if (nr?.cams.includes(c)) return `${CAM[c]} did not start recording — its page is asleep or in the background (this take will need a redo).`;
      if (st?.recError && st.recErrorTake === r.take.id) return `${CAM[c]} is not recording — keep its screen on and the page in front (${st.recError}).`;
      if (live && expected && p && !p.online && D.presence[c]?.lastSeen) return `${CAM[c]} went offline — its recording is kept on the phone and uploads when it is back.`;
      if (live && st?.hidden) return `${CAM[c]}'s page is in the background — bring it to the front.`;
      return null;
    }).filter(Boolean) : [];
    show($('ovWarn'), warn.length > 0);
    setText($('ovWarn'), warn.join(' '));
    const a = r.anim, isCal = r.kind === 'calibration';
    setText($('ovTop'), isCal ? `CALIBRATION · ${stationName(r.setup)}` : `#${posOf(a)} of ${D.order.length} · SETUP ${a.courtSetup}${r.resumed ? ' · resumed' : ''}`);
    setText($('ovName'), isCal ? `Walk ✕ → 1 → 2 → 3 → 4 → ✕` : `${a.title}${a.subtitle ? ' · ' + a.subtitle : ''}`);
    // where the athlete goes: the calibration walk (the current mark lit), or the move's START → FINISH
    const step = isCal ? walkStep(r.walk, live ? t : null) : null;
    setHTML($('ovMap'), isCal ? courtSVG(r.setup, null, { width: 420, calibration: true, highlight: step.target }) : courtSVG(a.courtSetup, a, { width: 420, focus: true, cameras: false }));
    if (!live) {
      setText($('ovBig'), r.phase === 'countdown' || r.recAt ? String(Math.max(1, r.n || 1)) : '…');
      setText($('ovCue'), isCal ? 'Stand on ✕ (the middle)' : r.script.prep);
      $('ovBar').style.width = '0%';
      setText($('ovSub'), isCal ? 'Then walk ✕ → 1 → 2 → 3 → 4 → ✕ at an easy pace as the corners are called, and finish with your arms up.' : r.script.prepSub);
      return;
    }
    setText($('ovBig'), `${t.toFixed(1)}`);
    $('ovBar').style.width = `${Math.min(100, (100 * t) / r.target)}%`;
    let cue, sub;
    if (isCal) {
      const k = step.target, corner = k ? r.walk.corners[k - 1] : null;
      if (step.phase === 'start') { cue = 'Stand on ✕ — arms up'; sayOnce(r, 'start', 'Arms up', t); }
      else if (step.phase === 'end') { cue = 'Arms up — stand still on ✕'; sayOnce(r, 'end', 'Arms up. Stand still.', t); }
      else if (corner) { cue = `Walk to corner ${corner.n} (${corner.name})`; sayOnce(r, `c${k}`, `Corner ${NUM_WORD[k]}`, t); }
      else { cue = 'Back to ✕ (the middle)'; sayOnce(r, 'back', 'Back to the middle', t); }
      sub = `${corner ? `Corner ${corner.n}: ${corner.words}. ` : ''}Walk at an easy pace. Stops by itself at ${r.target} s.`;
    } else {
      const ph = phaseAt(r.script, t);
      cue = ph.cue; sayOnce(r, `p${ph.at}`, ph.say, t);
      sub = a.loop ? `Stops by itself at ${r.target} s.` : `Finish: ${poseName(a.endState)}${r.script.endMoving ? ' — keep going through FINISH' : ''}. Stops by itself at ${r.target} s.`;
    }
    setText($('ovCue'), cue); setText($('ovSub'), sub);
  }

  // ── ANIMATIONS
  function renderSlots() {
    const n = P.slotCounts(D.lib, D.session);
    setHTML($('slotTotals'), [`<span class="chip ok">${n.done} / ${n.total} recorded</span>`, n.uploading ? `<span class="chip info">${n.uploading} uploading</span>` : '', n.failed ? `<span class="chip bad">${n.failed} need a redo</span>` : '', n.analysed ? `<span class="chip done">${n.analysed} analysed</span>` : '', `<span class="chip">${n.toRecord} to record</span>`].join(''));
    for (const b of $('slotFilter').querySelectorAll('button')) { b.classList.toggle('on', b.dataset.filter === D.filter); setText(b, b.dataset.filter === 'todo' ? `To record (${n.toRecord})` : `All (${n.total})`); }
    const groups = [];
    for (const setup of ['A', 'B', 'C']) {
      const rows = D.order.filter((a) => a.courtSetup === setup).map((a) => ({ a, st: P.slotStatus(D.session, a.id) })).filter(({ st }) => D.filter === 'all' || ['missing', 'failed'].includes(st.status));
      if (!rows.length) continue;
      groups.push(`<div class="group"><h3>SETUP ${setup} — ${esc(SETUPS[setup].name)} · ${esc(SETUPS[setup].purpose)}</h3><div class="slots">${rows.map(({ a, st }) => {
        const [cls, label] = SLOT_CHIP[st.status];
        const an = st.analysis?.takeId === st.takeId ? st.analysis : null;
        const why = human(st.status === 'failed' ? st.reason : an?.state === 'error' ? `Analysis failed: ${an.error || 'error'}` : st.note || '');
        const res = st.takeId ? D.session.animations?.[a.id]?.results?.[st.takeId] : null;
        const warn = ['recorded', 'analysed'].includes(st.status) ? importantWarning(res) : null;
        const anNote = an && ['queued', 'running'].includes(an.state) ? ` · analysis ${an.state}` : '';
        return `<button class="slot${a === D.current ? ' cur' : ''}" data-anim="${a.id}" data-status="${st.status}"><span class="num">#${posOf(a)}</span><span class="nm">${esc(a.title)} <small>${esc(a.subtitle || '')}</small></span><span class="chip ${cls}">${label}</span><span class="st">${esc(poseRoute(a))} · ${a.durationSec} s${a.loop ? ' loop' : ''}${st.takes ? ` · ${st.takes} take${st.takes > 1 ? 's' : ''}` : ''}${anNote}</span>${warn ? `<span class="warnline">⚠ ${esc(human(warn))} — Redo?</span>` : ''}${why ? `<span class="why">${esc(why)}</span>` : ''}</button>`;
      }).join('')}</div></div>`);
    }
    setHTML($('slotList'), groups.join('') || '<div class="card">Everything is recorded ✓ — see <b>Analysis</b> to send the takes to SAM 3D Body.</div>');
    $('exportLink').href = `/api/capture/sessions/${sid}/export.tar`; $('exportAll').href = `/api/capture/sessions/${sid}/export.tar?all=1`;
    const codeLive = D.session.pair?.code && Date.parse(D.session.pair.codeExpiresAt || 0) > Date.now();
    setText($('deviceLine'), `Session ${D.session.name} · ${D.session.id}${codeLive ? ` · pairing code ${D.session.pair.code}` : ''} · ${D.oneCam ? 'one camera' : 'two cameras'} · clock ±${D.clock.best ? D.clock.best.uncertaintyMs.toFixed(0) : '?'} ms`);
  }
  $('slotFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-filter]'); if (b) { D.filter = b.dataset.filter; render(); } });
  $('slotList').addEventListener('click', (e) => { const b = e.target.closest('button[data-anim]'); if (b) openSheet(b.dataset.anim); });

  // one animation: its takes (MARK BEST, attach a native 120/240 fps file, record it again)
  async function openSheet(animId) {
    D.sheet = animId; D.sheetTakes = null; render();
    await loadSheet();
  }
  async function loadSheet() {
    const e = D.session.animations?.[D.sheet];
    const ids = e?.takes || [];
    D.sheetTakes = (await Promise.all(ids.map((id) => api(`/api/capture/sessions/${sid}/rec/${enc(id)}`).then((r) => r.take).catch(() => null)))).filter(Boolean);
    render();
  }
  function renderSheet() {
    const a = animById(D.sheet); if (!a) return;
    show($('slotSheet'));
    const e = D.session.animations?.[a.id], st = P.slotStatus(D.session, a.id), [cls, label] = SLOT_CHIP[st.status];
    const takes = D.sheetTakes;
    const stateChip = (t) => {
      const sel = e?.selectedTake === t.id;
      const m = { accepted: ['ok', 'saved'], failed: ['bad', 'check failed'], rejected: ['', 'discarded'], review: ['warn', 'checked, not saved'], validating: ['info', 'checking'], uploading: ['info', 'uploading'], recording: ['rec', 'recording'], armed: ['', 'armed'] }[t.state] || ['', t.state];
      return `<span class="chip ${m[0]}">${m[1]}</span>${sel ? ' <span class="chip ok">SELECTED</span>' : ''}${t.analysis?.state ? ` <span class="chip done">analysis: ${esc(t.analysis.state)}</span>` : ''}`;
    };
    const rows = !takes ? '<div class="dim">Loading the takes…</div>' : !takes.length ? '<div class="dim">No takes yet.</div>' : takes.map((t) => {
      const warn = (t.validation?.checks || []).filter((c) => c.level !== 'ok');
      const files = CAMS.filter((c) => t.cameras?.[c]?.file);
      const waiting = ['recording', 'uploading'].includes(t.state) && files.length && (t.expectedCams || []).some((c) => !t.cameras?.[c]?.file);
      return `<div><div class="line"><b style="font-size:17px">Take ${t.takeNo}</b> ${stateChip(t)}<span class="grow"></span>`
        + (t.accepted && e?.selectedTake !== t.id ? `<button class="small" data-sel="${t.id}">MARK BEST</button>` : '')
        + (['failed', 'review'].includes(t.state) && files.length ? `<button class="small" data-force="${t.id}">Use it anyway</button>` : '')
        + (waiting ? `<button class="small" data-finish="${t.id}">Go on with ${files.map((c) => CAM[c]).join(' + ')}</button>` : '')
        + '</div><div class="line">'
        + files.map((c) => `<a href="/api/capture/sessions/${sid}/rec/${enc(t.id)}/${c}/video" target="_blank"><button class="small">▶ ${CAM[c]}</button></a>`).join('')
        + (files.length ? '<span class="tiny dim" style="margin-left:6px">Slo-mo file:</span>' : '')
        + files.map((c) => `<label class="filebtn">${t.cameras?.[c]?.native ? `${CAM[c]} ${Math.round(t.cameras[c].native.probe?.fps || 0)} fps ✓` : `+ next to ${CAM[c]}`}<input type="file" accept="video/*" data-native="${t.id}" data-cam="${c}" style="display:none"></label>`).join('')
        + '</div>'
        + (t.failReason ? `<div class="chk" style="color:#ff9ea1">${esc(human(t.failReason))}</div>` : '')
        + (warn.length && !t.failReason ? `<div class="chk"><b>Checks:</b> ${warn.map((c) => esc(human(c.msg))).join(' · ')}</div>` : '')
        + (t.analysis?.error ? `<div class="chk" style="color:#ff9ea1">Analysis: ${esc(t.analysis.error)}</div>` : '')
        + '</div>';
    }).join('');
    setHTML($('sheetBody'), `<div class="row"><div class="grow"><div class="dim small">#${posOf(a)} · Setup ${a.courtSetup} · ${esc(poseRoute(a))}</div><div style="font-size:24px;font-weight:900">${esc(a.title)} <span style="color:#ffd166">${esc(a.subtitle || '')}</span></div></div><span class="chip ${cls}">${label}</span></div>`
      + (st.status === 'failed' ? `<div class="banner bad">${esc(human(st.reason))}</div>` : '')
      + `<div class="takes" style="margin-top:8px">${rows}</div>`
      + '<p class="tiny dim">120/240 fps: during the take, film the same move in Slo-mo with a <b>third phone</b> standing right next to CAM A or CAM B — not with CAM A or CAM B themselves (opening the Camera app on them stops their recording). Then attach that file here (“Slo-mo file”, next to the camera it stood by): the sync chirp in its sound lines it up with the take.</p>'
      + `<div class="row" style="justify-content:flex-end;margin-top:6px"><button data-act="sheetClose">Close</button><button class="pri" data-act="sheetRecord">${st.status === 'missing' ? 'Record it now' : 'Record it again'}</button></div>`);
  }
  $('slotSheet').addEventListener('click', async (e) => {
    if (e.target === $('slotSheet')) { closeSheet(); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'sheetClose') return closeSheet();
    if (b.dataset.act === 'sheetRecord') { D.current = animById(D.sheet); closeSheet(); go('record'); return; }
    try {
      if (b.dataset.sel) { await api(`/api/capture/sessions/${sid}/rec/${enc(b.dataset.sel)}/select`, { method: 'POST', body: {} }); }
      else if (b.dataset.force) { await api(`/api/capture/sessions/${sid}/rec/${enc(b.dataset.force)}/accept`, { method: 'POST', body: { force: true } }); }
      else if (b.dataset.finish) { await api(`/api/capture/sessions/${sid}/rec/${enc(b.dataset.finish)}/finish`, { method: 'POST', body: {} }); }
      else return;
      await refresh(); await loadSheet();
    } catch (err) { note(err.message); }
  });
  $('slotSheet').addEventListener('change', async (e) => {
    const inp = e.target; if (!inp?.dataset?.native) return;
    const f = inp.files?.[0]; if (!f) return;
    inp.parentElement.firstChild.textContent = `uploading ${(f.size / 1e6).toFixed(0)} MB…`;
    const r = await fetch(`/api/capture/sessions/${sid}/rec/${enc(inp.dataset.native)}/${inp.dataset.cam}/native`, { method: 'PUT', headers: { 'X-Filename': f.name }, body: f, credentials: 'same-origin' });
    if (!r.ok) note(`The file did not upload (HTTP ${r.status}).`);
    await loadSheet();
  });
  const closeSheet = () => { D.sheet = null; D.sheetTakes = null; show($('slotSheet'), false); render(); };

  // ── ANALYSIS
  const framesFor = (d, fps) => Math.max(2, Math.min(240, Math.ceil((d > 0 ? d : 4) * fps)));   // = lib/capture/processing.js framesFor
  function candidates() {
    const out = [];
    for (const a of D.order) {
      const st = P.slotStatus(D.session, a.id);
      if (st.status !== 'recorded') continue;
      const e = D.session.animations[a.id], take = e.selectedTake, res = e.results?.[take] || {};
      if (['queued', 'running'].includes(e.analysis?.state) && e.analysis.takeId === take) continue;
      const hasCam = !res.cams || res.cams.includes(D.ana.cam);
      const d = res.durations?.[D.ana.cam] || a.durationSec;
      const frames = framesFor(d, D.ana.fps), cost = frames * (D.ana.status?.processor?.costPerFrameUsd ?? 0.03);
      out.push({ a, take, hasCam, frames, cost, error: e.analysis?.takeId === take && e.analysis.state === 'error' ? e.analysis.error : null });
    }
    return out;
  }
  async function loadAnalysis() {
    try { D.ana.status = await api(`/api/capture/sessions/${sid}/analysis`); D.ana.err = null; } catch (e) { D.ana.err = e.message; }
    if (D.step === 'analysis') render();
    clearTimeout(D.ana.timer);
    if (D.step === 'analysis') D.ana.timer = setTimeout(loadAnalysis, D.ana.status?.queue?.length ? 2500 : 8000);
  }
  function renderAnalysis() {
    const s = D.ana.status;
    setHTML($('anaAvail'), (D.ana.err ? `<div class="banner bad">${esc(D.ana.err)}</div>` : s && !s.available ? `<div class="banner bad">SAM 3D Body is not available on this server: ${esc(s.why)}.</div>` : s?.mock ? '<div class="banner">Test server: SAM 3D Body runs in mock mode (synthetic results, no cost).</div>' : '')
      + (D.ana.msg && (D.ana.msg.bad || Date.now() - D.ana.msg.at < 8000) ? `<div class="banner ${D.ana.msg.bad ? 'bad' : 'ok'}" id="anaMsg">${esc(D.ana.msg.text)}</div>` : ''));
    for (const b of $('anaCam').querySelectorAll('button')) b.classList.toggle('on', b.dataset.cam === D.ana.cam);
    for (const b of $('anaFps').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.fps === D.ana.fps);
    const list = candidates();
    for (const c of list) if (!D.ana.seen.has(c.take)) { D.ana.seen.add(c.take); if (c.hasCam) D.ana.sel.add(c.take); }   // new ones: selected by default
    const sel = list.filter((c) => c.hasCam && D.ana.sel.has(c.take));
    const total = sel.reduce((x, c) => x + c.cost, 0), frames = sel.reduce((x, c) => x + c.frames, 0);
    setHTML($('anaList'), list.length ? list.map((c) => `<label class="ana-row"><input type="checkbox" data-take="${c.take}" ${c.hasCam && D.ana.sel.has(c.take) ? 'checked' : ''} ${c.hasCam ? '' : 'disabled'}><span><b>#${posOf(c.a)} ${esc(c.a.title)}</b> <span style="color:#ffd166">${esc(c.a.subtitle || '')}</span></span><span class="cost">$${c.cost.toFixed(2)}</span><span class="sub">${c.hasCam ? `${c.frames} frames` : `no ${CAM[D.ana.cam]} recording`}${c.error ? ` · <span style="color:#ff9ea1">last try failed: ${esc(c.error)}</span>` : ''}</span></label>`).join('')
      : '<div class="card dim">No recorded animation is waiting for analysis. Record some first (3 · Record), or see the queue above.</div>');
    setText($('anaTotal'), sel.length ? `${sel.length} animation${sel.length > 1 ? 's' : ''} · ${frames} frames · about $${total.toFixed(2)}` : 'Nothing selected.');
    $('anaSend').disabled = !sel.length || D.ana.busy || !s?.available;
    // the cost confirmation (the server's own quote)
    const q = D.ana.quote;
    show($('anaConfirm'), !!q);
    if (q) setHTML($('anaConfirmBody'), `<b style="font-size:21px">Send ${q.items.length} take${q.items.length > 1 ? 's' : ''} to SAM 3D Body?</b><p>${q.frames} frames of ${CAM[D.ana.cam]} → about <b>$${q.estimateUsd.toFixed(2)}</b> on fal.ai. They run one at a time on the server; you can close this page.</p>${q.skipped?.length ? `<p class="small dim">Left out: ${q.skipped.map((x) => esc(x.reason)).join(' · ')}</p>` : ''}<div class="row" style="justify-content:flex-end"><button data-act="anaNo">Cancel</button><button class="pri" id="anaYes" data-act="anaYes">Yes — spend about $${q.estimateUsd.toFixed(2)}</button></div>`);
    // what was sent (above the list, so progress and errors are seen first): running with its
    // progress, queued, then the latest results (done / the pipeline's error, word for word). The
    // session (over the WebSocket) is newer than the polled queue: an item it says is done is done.
    const settledNow = (it) => { const x = D.session.animations?.[it.animId]?.analysis; return x?.takeId === it.takeId && ['done', 'error'].includes(x.state); };
    const queue = (s?.queue || []).filter((it) => !settledNow(it)), inQueue = new Set(queue.map((q2) => q2.takeId));
    const recent = D.order.map((a) => ({ a, x: D.session.animations?.[a.id]?.analysis })).filter(({ x }) => x && ['done', 'error'].includes(x.state) && !inQueue.has(x.takeId)).sort((p, q2) => String(q2.x.at).localeCompare(String(p.x.at))).slice(0, 12);
    const qrow = (a, state, extra) => `<div class="qitem" data-take-state="${state}"><b>#${posOf(a)} ${esc(a.title)} <span style="color:#ffd166">${esc(a.subtitle || '')}</span></b>${extra}</div>`;
    show($('anaQueueBox'), queue.length + recent.length > 0);
    setHTML($('anaQueue'), queue.map((it) => {
      const a = animById(it.animId), p = D.ana.progress[it.takeId] || it.progress; const pct = p?.total ? Math.round((100 * (p.done || 0)) / p.total) : 0;
      return a ? qrow(a, it.running ? 'running' : 'queued', `<span class="chip ${it.running ? 'info' : ''}">${it.running ? 'running' : 'queued'}</span>${it.running ? `<span class="progress"><i style="width:${pct}%"></i></span><span class="tiny dim">${esc(p?.msg || 'starting…')}</span>` : `<span class="tiny dim">${CAM[it.cam] || ''} · ${it.maxFrames} frames · ~$${it.estimateUsd.toFixed(2)}</span>`}`) : '';
    }).join('') + recent.map(({ a, x }) => qrow(a, x.state, x.state === 'done'
      ? `<span class="chip done">done ✓</span><span class="tiny dim">motion ${esc(x.motionId || '')}</span>`
      : `<span class="chip bad">error</span><span class="err">${esc(x.error || 'failed')}</span>${analysisHint(x.error) ? `<span class="hint">${esc(analysisHint(x.error))}</span>` : ''}`)).join(''));
  }
  /** What to do about a pipeline error, in plain words (the error itself is shown as it is). */
  function analysisHint(e) {
    if (/balance|exhausted|locked|credit|insufficient|payment required|\b402\b/i.test(e || '')) return 'The fal.ai account has no credits left: top it up at fal.ai (Billing), then send the take again — it is back in the list below.';
    if (/FAL_KEY/.test(e || '')) return 'The server has no fal.ai key (FAL_KEY).';
    if (/interrupted by a server restart/.test(e || '')) return 'Nothing was charged twice. It is back in the list below: send it again.';
    return e ? 'It is back in the list below: send it again when the problem is fixed.' : '';
  }
  $('anaCam').addEventListener('click', (e) => { const b = e.target.closest('button[data-cam]'); if (b) { D.ana.cam = b.dataset.cam; D.ana.quote = null; render(); } });
  $('anaFps').addEventListener('click', (e) => { const b = e.target.closest('button[data-fps]'); if (b) { D.ana.fps = +b.dataset.fps; D.ana.quote = null; render(); } });
  $('anaAll').onclick = () => { for (const c of candidates()) if (c.hasCam) D.ana.sel.add(c.take); D.ana.quote = null; render(); };
  $('anaNone').onclick = () => { D.ana.sel.clear(); D.ana.quote = null; render(); };
  $('anaList').addEventListener('change', (e) => { const t = e.target.dataset?.take; if (!t) return; if (e.target.checked) D.ana.sel.add(t); else D.ana.sel.delete(t); D.ana.quote = null; render(); });
  const selectedTakes = () => candidates().filter((c) => c.hasCam && D.ana.sel.has(c.take)).map((c) => c.take);
  $('anaSend').onclick = async () => {
    D.ana.busy = true; D.ana.msg = null; render();
    try {
      const r = await api(`/api/capture/sessions/${sid}/process-batch`, { method: 'POST', body: { takes: selectedTakes(), cam: D.ana.cam, fps: D.ana.fps } });
      D.ana.msg = { at: Date.now(), text: r.queued?.length ? `Queued ${r.queued.length}.` : `Nothing to send${r.skipped?.length ? ': ' + r.skipped.map((x) => x.reason).join(' · ') : ''}.` };
    } catch (e) {
      if (e.status === 402 && e.body?.items) D.ana.quote = e.body;      // the server's quote: confirm it
      else D.ana.msg = { at: Date.now(), text: e.message, bad: true };
    }
    D.ana.busy = false; render();
  };
  $('anaConfirm').addEventListener('click', async (e) => {
    const act = e.target === $('anaConfirm') ? 'anaNo' : e.target.closest('button')?.dataset?.act; if (!act) return;
    const q = D.ana.quote; D.ana.quote = null;
    if (act !== 'anaYes' || !q) return render();
    D.ana.busy = true; render();
    try {
      const r = await api(`/api/capture/sessions/${sid}/process-batch`, { method: 'POST', body: { takes: q.items.map((x) => x.takeId), cam: D.ana.cam, fps: D.ana.fps, confirmCostUsd: q.estimateUsd } });
      D.ana.msg = { at: Date.now(), text: `Queued ${r.queued.length} take${r.queued.length === 1 ? '' : 's'} (about $${r.estimateUsd.toFixed(2)}). They run one at a time.` };
      for (const it of r.queued) D.ana.sel.delete(it.takeId);
    } catch (err) { D.ana.msg = { at: Date.now(), text: err.message, bad: true }; }
    D.ana.busy = false;
    await refresh(); loadAnalysis();
  });

  // ── banners / toast actions
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('button'), act = b?.dataset?.act;
    if (b?.dataset?.zoom) {                                  // Calibrate: widen / narrow a camera's view
      const role = b.dataset.zoom, z = +b.dataset.z;
      if (role === 'camA' && D.cam) D.cam.cam.setZoom(z).then(() => { D.cam.pushState(); render(); });
      else D.link.send({ t: 'relay', msg: { t: 'zoom', role, zoom: z } });
      return;
    }
    if (act === 'direct') { D.link.reopen(); render(); }
    else if (act === 'toCal') go('calibrate');
    else if (act === 'dismiss') { D.notice = null; render(); }
    else if (act === 'notRecOk') { delete D.notRec[b.dataset.take]; render(); }
    else if (act === 'camRetry') { D.camErr = null; D.cam?.start().then(() => render()).catch((err) => { D.camErr = `${err.name || 'error'}: ${err.message}`; render(); }); }
    else if (act === 'toastOk') { D.toast = null; render(); }
    else if (act === 'redo' && D.toast) { D.current = D.toast.anim; D.toast = null; render(); window.scrollTo(0, 0); }
    else if (act === 'calFinish' && D.cal?.take) api(`/api/capture/sessions/${sid}/rec/${enc(D.cal.take.id)}/finish`, { method: 'POST', body: {} }).catch((err) => note(err.message));
    else if (act === 'toStationTodo') { const td = P.stationTodo(D.lib, D.session, here()); if (td.toRecord[0]) { D.current = td.toRecord[0]; render(); window.scrollTo(0, 0); } }
    else if (act === 'moveOn') { D.moveOnFrom = here(); render(); }
    else if (act === 'goOnWithout') { for (const { t } of waitingTakes()) api(`/api/capture/sessions/${sid}/rec/${enc(t.id)}/finish`, { method: 'POST', body: {} }).then((r) => { D.takes.set(t.id, r.take); refresh(); }).catch((err) => note(err.message)); }
  });
  keptActions($('banners'), () => D.cam, () => render());

  // resume: the step in the link, else where the session stands
  const hashStep = location.hash.slice(1);
  D.step = STEPS.includes(hashStep) ? hashStep : Q.get('continue') ? (needsSetup(D.current) ? 'calibrate' : 'record') : 'connect';
  if (D.step === 'connect') loadPair();
  if (D.step === 'analysis') loadAnalysis();
  render();
  setInterval(() => { render(); }, 1000);
  // the session now and then (it also moves on takes a restart left half-way on the server)
  setInterval(() => { if (!D.rec) refresh(); }, 10000);
}

// ═══ route ═════════════════════════════════════════════════════════════════
if (Q.get('pair')) cameraMode(Q.get('pair'), Q.get('role') === 'camA' ? 'camA' : 'camB');
else if (Q.get('session')) directorMode(Q.get('session'));
else homeMode();
