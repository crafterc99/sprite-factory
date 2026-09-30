/**
 * Soul Jam Capture — the app (director + camera modes). Plain modules, no build step.
 *
 *   /capture                       sessions: new / continue / join as a camera
 *   /capture?session=<id>          DIRECTOR (this phone is also camera A unless &cam=0)
 *   /capture?pair=<token>[&role=camA|camB]   CAMERA (B by default) — one tap, then hands-free
 *
 * All state that matters is on the server (sessions, takes, uploads); this page can be closed and
 * reopened at any point. Recordings are chunked to the device's IndexedDB and uploaded as they are
 * recorded (capture/uploader.mjs), so a refresh or a Wi-Fi drop loses nothing.
 */
import { LIBRARIES } from './basic01.mjs';
import { STATES, stateLabel, CAPTURE_PROTOCOL } from './schema.mjs';
import * as P from './protocol.mjs';
import { SETUPS, courtSVG } from './court-layout.mjs';
import { ClockSync, CHIRP, frameStats } from './camera-sync.mjs';
import { WebCamera } from './camera.mjs';
import { Uploader, recLock } from './uploader.mjs';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deviceId = (() => { try { let d = localStorage.getItem('sjc-device'); if (!d) { d = 'dev-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('sjc-device', d); } return d; } catch { return 'dev-' + Math.random().toString(36).slice(2, 10); } })();
const deviceInfo = () => ({ ua: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || null, screen: [screen.width, screen.height, devicePixelRatio], secure: isSecureContext });
const DIR_LABEL = { none: 'in place', forward: 'forward', backward: 'backward', right: 'right', left: 'left', 'forward-right': 'forward-right', 'forward-left': 'forward-left', 'back-right': 'back-right', 'back-left': 'back-left', 'to-basket': 'toward the basket', up: 'vertical' };
const HAND_LABEL = { R: 'right hand', L: 'left hand', both: 'two hands', none: 'no ball' };

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const r = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Capture-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}

// ── one WebSocket per role (the director phone opens "director" and "camA")
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
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/capture/ws?session=${encodeURIComponent(this.sessionId)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ''}`;
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

// ── camera role (camera B's phone, or camera A on the director's phone)
class CameraRole {
  constructor({ sessionId, role, token, clock, video, onUi }) {
    Object.assign(this, { sessionId, role, token, clock, onUi });
    this.cam = new WebCamera({ video, clock, onChunk: (seq, blob, tag, mime) => this.onChunk(seq, blob, tag, mime), onState: () => this.pushState() });
    this.lost = new Map(); this.locks = new Map();
    this.uploader = new Uploader({ token, onProgress: (p) => { this.uploads = p; this.onUi?.(); this.pushState(); } });
    this.link = new Link({ sessionId, role, token, clock, onMessage: (m) => this.onMessage(m), onStatus: () => { this.onUi?.(); this.pushState(); } });
    this.take = null; this.recording = false; this.uploads = null; this.setup = null; this.movedReason = null;
    // anything left from before a refresh; a take the page died in is finished with what it recorded
    this.uploader.recoverInterrupted().catch(() => {}).then(() => this.uploader.wake());
    this.stateTimer = setInterval(() => this.pushState(), 1000);
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
    const get = () => api(`/api/capture/sessions/${encodeURIComponent(this.sessionId)}/calref/${setup}/${this.role}`, { token: this.token });
    try {
      let r;
      // (a calibration accepted a moment ago: its reference is on its way — the 'setref' relay)
      try { r = await get(); } catch (e) { if (e.status !== 404) throw e; await sleep(6000); if (this.cam.ref) return; r = await get(); }
      if (!this.cam.ref) { this.cam.ref = r.ref; this.watchFrom(setup); }
    } catch (e) {
      if (e.status !== 404 || this.cam.ref) { this.refLoading = null; return; }   // try again on the next connect
      if (c.status === 'valid') this.link.send({ t: 'moved', setup, reason: 'this camera has no reference view of the calibration (it was not connected when it was accepted) — recalibrate' });
      else { await this.waitForPicture(); if (!this.cam.ref && this.cam.setReference()) { this.saveReference(setup); this.watchFrom(setup); } }
    }
  }
  async waitForPicture() { for (let i = 0; i < 40 && !this.cam.video?.videoWidth; i++) await sleep(250); }
  saveReference(setup) {
    const ref = this.cam.ref; if (!ref) return;
    api(`/api/capture/sessions/${encodeURIComponent(this.sessionId)}/calref/${setup}/${this.role}`, { method: 'PUT', body: ref, token: this.token }).catch(() => {});
  }
  async start(opts = {}) {
    const d = await this.cam.open(opts);
    try { await navigator.wakeLock?.request('screen'); } catch {}
    this.pushState(); this.onUi?.();
    return d;
  }
  ready() { return !!(this.cam.stream && this.link.open && this.clock.best); }
  pushState() {
    this.link.send({ t: 'state', state: { ready: this.ready(), recording: this.recording, camera: this.cam.stream ? this.cam.describe() : null, clock: this.clock.best, uploads: this.uploads, calibrated: !!this.cam.ref, moved: this.movedReason, streaming: this.recording ? !!this.cam.streaming : undefined } });
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
    if (m.t === 'record') {
      if (!this.cam.stream || (this.recording && this.take === m.takeId)) return;
      this.take = m.takeId; this.recording = true; this.recAt = m.at;
      this.holdLock(m.takeId);
      this.cam.start({ atLocal: this.clock.toLocal(m.at) ?? Date.now(), tag: m.takeId });
      // safety: never record forever if the stop never arrives
      clearTimeout(this.capTimer);
      this.capTimer = setTimeout(() => { if (this.recording && this.take === m.takeId) this.onMessage({ t: 'halt', takeId: m.takeId, at: this.clock.toServer(Date.now()), capped: true }); }, 120000);
      this.onUi?.();
    } else if (m.t === 'halt' && m.takeId === this.take && this.recording) {
      this.recording = false;
      clearTimeout(this.capTimer);
      const r = await this.cam.stop({ atLocal: this.clock.toLocal(m.at) ?? Date.now() });
      const d = this.cam.describe();
      const lost = this.lost.get(m.takeId) || []; this.lost.delete(m.takeId);
      await this.uploader.addFinal({ sessionId: this.sessionId, takeId: m.takeId, cam: this.role, payload: {
        chunks: r.chunks, ...(lost.length ? { gaps: lost } : {}), mimeType: r.mime, frames: r.frames, mediaTimes: r.mediaTimes,
        meta: {
          deviceId, device: deviceInfo(), track: { width: d.width, height: d.height, frameRate: d.frameRate, facingMode: d.facingMode, zoom: d.zoom, label: d.label, aspectRatio: d.aspectRatio },
          capabilities: d.capabilities, recorder: { mimeType: r.mime, bitsPerSecond: r.bps, timesliceMs: 1000 }, source: 'web',
          clock: this.clock.best, startedAtServerMs: this.clock.toServer(r.startedLocal), stoppedAtServerMs: this.clock.toServer(r.stoppedLocal),
          commandAtServerMs: this.recAt, frames: frameStats(r.frames), streamedChunks: !!r.streaming, ...(this.storageError && lost.length ? { storageError: this.storageError } : {}),
          ...(m.reconciled ? { stopReconciled: 'the stop arrived after a reconnect: the recording ran past the director\'s stop (trim to sync.stopAtServerMs)' } : {}), ...(m.capped ? { stopCapped: 'no stop within 120 s' } : {}),
        },
      } });
      this.dropLock(m.takeId);
      if (this.take === m.takeId) this.take = null;         // (a new take may have started meanwhile)
      this.onUi?.();
    } else if (m.t === 'setref' && m.setup) {               // calibration accepted: this is the view to keep
      this.movedReason = null;
      if (this.cam.setReference()) this.saveReference(m.setup);
      this.watchFrom(m.setup);
      this.onUi?.();
    } else if (m.t === 'welcome' || m.t === 'session') {
      const s = m.session; if (s?.currentSetup) this.setup = s.currentSetup;
      if (m.t === 'welcome' && s) this.restoreReference(s);  // a reloaded page keeps watching for being moved
    } else if (m.t === 'replaced') {
      this.onUi?.();
    }
  }
}

/** Footage the server did not know (kept aside on this phone, never deleted automatically). */
const keptBanner = (u) => (u?.kept ? `<div class="banner">${u.kept} recording${u.kept > 1 ? 's' : ''} (${(u.keptBytes / 1e6).toFixed(1)} MB) kept on this phone — the server no longer knows ${u.kept > 1 ? 'those takes' : 'that take'}. <button data-act="keptSave">SAVE TO PHONE</button> <button data-act="keptDrop">DISCARD</button></div>` : '');
/** The banner buttons (the banners are re-drawn every second, so one delegated handler). */
function keptActions(box, role, redraw) {
  box.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act, cr = role();
    if (!act || !cr) return;
    if (act === 'takeover') cr.link.reopen();
    else if (act === 'keptSave') {
      for (const f of await cr.uploader.keptFiles()) { const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    } else if (act === 'keptDrop') { if (confirm('Discard the footage kept on this phone? It is not on the server.')) await cr.uploader.dropKept(); }
    redraw();
  });
}

window.addEventListener('sjc-db-blocked', () => { const b = document.createElement('div'); b.className = 'banner bad'; b.textContent = 'Another Soul Jam Capture tab on this phone is holding its storage — close the other tab.'; document.body.prepend(b); });

// ═══ CAMERA MODE ═══════════════════════════════════════════════════════════
async function cameraMode(token, role) {
  show($('camera'));
  document.querySelector('header').classList.add('hidden');
  let pair;
  try { pair = await api('/api/capture/pair', { method: 'POST', body: { token } }); }
  catch (e) { $('camInfo').textContent = `Pairing failed: ${e.message}. Scan the director's QR code again.`; show($('camTap'), false); return; }
  try { localStorage.setItem('sjc-pair', JSON.stringify({ token, role, sessionId: pair.sessionId })); } catch {}
  const clock = new ClockSync();
  $('camRole').textContent = role === 'camA' ? 'CAMERA A' : 'CAMERA B';
  const ui = (msg) => {
    const c = cr;
    const ready = c.ready();
    $('camStatus').innerHTML = `<i class="dot ${c.recording ? 'rec' : ready ? 'ok' : 'warn'}"></i><span>${c.recording ? 'RECORDING' : ready ? 'READY' : c.link.open ? 'starting camera' : 'reconnecting'}</span>`;
    const d = c.cam.stream ? c.cam.describe() : null;
    $('camFormat').textContent = d ? `${d.width}×${d.height} · ${d.frameRate ? Math.round(d.frameRate) : '?'} fps` : '—';
    const u = c.uploads;
    $('camUpload').textContent = !u ? 'uploads —' : u.chunks || u.finals ? `uploading ${u.chunks} · ${(u.bytes / 1e6).toFixed(1)} MB${u.error ? ' · retrying' : ''}` : 'uploads ✓';
    document.getElementById('camera').classList.toggle('recording', c.recording);
    $('camBanner').innerHTML = (c.link.replaced ? `<div class="banner bad">Another page is now ${c.role === 'camA' ? 'camera A' : 'camera B'} — this one stopped. <button data-act="takeover">USE THIS PHONE</button></div>` : '')
      + (c.movedReason ? `<div class="banner bad">Camera moved (${esc(c.movedReason)}) — the director will ask to recalibrate.</div>` : '')
      + keptBanner(u)
      + (d?.capabilities?.webLimited ? `<div class="banner">This browser gives ${d.frameRate ? Math.round(d.frameRate) : '?'} fps, not 120 — see "native capture" in the guide for true 120 fps.</div>` : '')
      + (msg ? `<div class="banner">${esc(msg)}</div>` : '');
  };
  keptActions($('camBanner'), () => cr, () => ui());
  const cr = new CameraRole({ sessionId: pair.sessionId, role, token, clock, video: $('camVideo'), onUi: ui });
  $('camInfo').textContent = `Paired with “${pair.name}”. Leave this phone on its tripod — the director starts and stops recording.`;
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
    $('sessions').innerHTML = list.sessions.length ? list.sessions.map((s) => `<div><div class="grow"><b>${esc(s.name)}</b><div class="small dim">${esc(s.libraryId)} · ${s.complete}/${s.total} complete · ${s.missing} missing${s.next ? ` · next: ${esc(s.next.title)} ${esc(s.next.subtitle || '')} (setup ${s.next.courtSetup})` : ' · done'}</div></div><a href="/capture?session=${encodeURIComponent(s.id)}&continue=1"><button class="pri">${s.missing ? 'CONTINUE MISSING' : 'OPEN'}</button></a></div>`).join('') : '<div class="dim">No sessions yet.</div>';
    $('homeNote').textContent = list.cloud ? 'Takes are saved on the server and mirrored to cloud storage.' : 'Takes are saved on this server’s disk (data/capture).';
  }
  $('newSession').onclick = async () => {
    try { const r = await api('/api/capture/sessions', { method: 'POST', body: { libraryId: 'BASIC-01' } }); location.href = `/capture?session=${encodeURIComponent(r.session.id)}`; }
    catch (e) { alert(e.message); }
  };
  $('joinBtn').onclick = async () => {
    try { const r = await api('/api/capture/pair', { method: 'POST', body: { code: $('joinCode').value } }); location.href = `/capture?pair=${encodeURIComponent(r.token)}&role=${$('joinRole').value}`; }
    catch (e) { $('joinErr').textContent = e.message; }
  };
  // a camera that was paired before: offer to rejoin
  try { const p = JSON.parse(localStorage.getItem('sjc-pair') || 'null'); if (p?.token) $('joinErr').innerHTML = `<a href="/capture?pair=${encodeURIComponent(p.token)}&role=${esc(p.role)}">Rejoin the last session as ${p.role === 'camA' ? 'Camera A' : 'Camera B'}</a>`; } catch {}
}

// ═══ DIRECTOR ══════════════════════════════════════════════════════════════
async function directorMode(sessionId) {
  show($('director'));
  const D = { sessionId, session: null, progress: null, lib: null, current: null, presence: {}, take: null, phase: 'idle', clock: new ClockSync(), cam: null, calib: null };
  window.__capture = D;
  const load = async () => {
    const r = await api(`/api/capture/sessions/${encodeURIComponent(sessionId)}`);
    D.session = r.session; D.progress = r.progress; D.lib = LIBRARIES[r.session.libraryId];
    return r;
  };
  try { await load(); } catch (e) {
    if (e.status === 401 || e.status === 403) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    $('director').innerHTML = `<div class="card">Could not open the session: ${esc(e.message)} — <a href="/capture">sessions</a></div>`; return;
  }
  D.order = P.captureOrder(D.lib);
  D.current = D.progress.next || D.order[0];

  // this phone = camera A (unless ?cam=0)
  const selfCam = Q.get('cam') !== '0';
  if (selfCam) {
    D.cam = new CameraRole({ sessionId, role: 'camA', token: null, clock: D.clock, video: $('selfVideo'), onUi: () => render() });
    D.cam.start().catch((e) => { D.camErr = e.message; render(); });
  } else show($('selfPv'), false);
  D.link = new Link({ sessionId, role: 'director', clock: D.clock, onMessage: (m) => onMessage(m), onStatus: (up) => { if (up && D.stopFor) sendStop(); render(); } });

  function onMessage(m) {
    if (m.t === 'halt' && m.takeId === D.stopFor) { D.stopFor = null; clearTimeout(D.stopTimer); }   // the STOP arrived
    if (m.t === 'error' && D.phase === 'recording' && !D.recAt && m.msg === 'no camera is ready') { alert('Could not start: no camera is ready.'); D.phase = 'idle'; render(); }
    // this page was refreshed (or reopened) while the cameras record: bring STOP back — any take or calibration
    if ((m.t === 'welcome' || m.t === 'presence') && m.armed?.recording && D.phase === 'idle' && !D.take && !D.resuming) resumeRecording(m.armed);
    if (m.t === 'presence') { D.presence = m.devices || {}; render(); }
    else if (m.t === 'session') { D.session = m.session; D.progress = P.progress(D.lib, D.session); render(); }
    else if (m.t === 'take' && D.take && m.take.id === D.take.id) { D.take = m.take; if (m.take.state === 'review') D.phase = 'review'; renderReview(); render(); }
    else if (m.t === 'calibration') { D.session.calibrations[m.setup] = { ...(D.session.calibrations[m.setup] || {}), status: m.status, suspectReason: m.reason }; render(); }
    else if (m.t === 'record' && D.take && m.takeId === D.take.id) { D.recAt = m.at; scheduleChirp(m.at); }
  }

  // ── the audible sync event: a chirp shortly after the start, heard by both cameras' microphones
  let actx = null;
  function scheduleChirp(atServer) {
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      const localWall = D.clock.toLocal(atServer + P.CHIRP_AT_SEC * 1000) ?? Date.now() + 350;
      const delay = Math.max(0.02, (localWall - Date.now()) / 1000);
      const t0 = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
      o.frequency.setValueAtTime(CHIRP.f0, t0); o.frequency.exponentialRampToValueAtTime(CHIRP.f1, t0 + CHIRP.durationMs / 1000);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(CHIRP.gain, t0 + 0.005); g.gain.setValueAtTime(CHIRP.gain, t0 + CHIRP.durationMs / 1000 - 0.01); g.gain.linearRampToValueAtTime(0, t0 + CHIRP.durationMs / 1000);
      o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + CHIRP.durationMs / 1000 + 0.02);
      const playedServer = D.clock.toServer(Date.now() + delay * 1000 + (actx.outputLatency || actx.baseLatency || 0) * 1000);
      D.link.send({ t: 'chirp', takeId: D.take.id, at: playedServer, chirp: CHIRP, uncertaintyMs: (D.clock.best?.uncertaintyMs || 0) + 10 });
    } catch {}
  }

  // ── what to show
  const camReady = (role) => !!D.presence[role]?.ready;
  const cal = (setup) => D.session.calibrations?.[setup] || null;
  function needsSetup(anim) {
    if (!anim) return false;
    const c = cal(anim.courtSetup);
    return D.session.currentSetup !== anim.courtSetup || !c || !['valid', 'skipped'].includes(c.status);
  }
  function render() {
    const s = D.session, pr = D.progress, a = D.current;
    for (const [role, pill] of [['camA', 'pillA'], ['camB', 'pillB']]) {
      const p = D.presence[role], st = p?.state, dot = $(pill).querySelector('.dot');
      dot.className = `dot ${st?.recording ? 'rec' : p?.ready ? 'ok' : p?.online ? 'warn' : 'bad'}`;
      $(pill + 'txt').textContent = st?.recording ? 'REC' : p?.ready ? `READY${st?.camera?.frameRate ? ' · ' + Math.round(st.camera.frameRate) + ' fps' : ''}` : p?.online ? 'starting' : 'offline';
    }
    if (!a) {
      $('setupLine').textContent = 'ALL ANIMATIONS COMPLETE';
      $('totals').textContent = `${pr.total} TOTAL · ${pr.complete} COMPLETE · ${pr.missing} MISSING`;
      show($('animCard'), false); show($('recordBox'), false); show($('setupCard'), false);
      return;
    }
    const st = SETUPS[a.courtSetup], ps = pr.perSetup[a.courtSetup];
    $('setupLine').textContent = `SETUP ${a.courtSetup} — ${st.name} · ${ps.complete} / ${ps.total} COMPLETE`;
    $('totals').textContent = `${pr.total} TOTAL · ${pr.complete} COMPLETE · ${pr.missing} MISSING`;
    $('setupBar').style.width = `${(100 * ps.complete) / Math.max(1, ps.total)}%`;
    // banners: calibration suspect, camera trouble, web fps limits
    const bs = [];
    const c = cal(a.courtSetup);
    if (c?.status === 'suspect') bs.push(`<div class="banner bad">Calibration for setup ${a.courtSetup} may be invalid — ${esc(c.suspectReason || 'a camera moved')}. Recalibrate.</div>`);
    if (D.camErr) bs.push(`<div class="banner bad">This phone's camera: ${esc(D.camErr)}</div>`);
    const lim = ['camA', 'camB'].map((r) => [r, D.presence[r]?.state?.camera]).filter(([, cam]) => cam?.capabilities?.webLimited && cam.frameRate);
    if (lim.length) bs.push(`<div class="banner small">Browser capture: ${lim.map(([r, cam]) => `${r === 'camA' ? 'A' : 'B'} ${Math.round(cam.frameRate)} fps`).join(' · ')} — 120 fps is not available to web pages on ${lim.length > 1 ? 'these phones' : 'this phone'} (see docs/capture.md → native capture).</div>`);
    const up = ['camA', 'camB'].map((r) => D.presence[r]?.state?.uploads).filter((u) => u && (u.chunks || u.finals));
    if (up.length) bs.push(`<div class="banner">Uploading ${up.reduce((x, u) => x + u.chunks, 0)} chunk(s) from the cameras…</div>`);
    if (D.link.replaced) bs.push('<div class="banner bad">This session is now directed from another page — this one stopped. <button data-act="direct">DIRECT FROM HERE</button></div>');
    if (D.cam?.link.replaced) bs.push('<div class="banner bad">Camera A is now another page — this phone stopped being camera A. <button data-act="takeover">USE THIS PHONE AS CAM A</button></div>');
    if (D.cam) bs.push(keptBanner(D.cam.uploads));
    $('banners').innerHTML = bs.join('');
    // setup card when the cameras need to move / calibrate
    const setupNeeded = needsSetup(a) && D.phase === 'idle';
    show($('setupCard'), setupNeeded);
    if (setupNeeded) {
      $('setupTitle').textContent = `SETUP ${a.courtSetup} — ${st.name}`;
      $('setupSub').textContent = D.session.currentSetup && D.session.currentSetup !== a.courtSetup ? `MOVE THE CAMERAS · ${st.purpose}` : st.purpose;
      $('setupCourt').innerHTML = courtSVG(a.courtSetup, null, { width: 520 });
      $('setupCamA').textContent = `${st.camA.label} — ${st.camA.note}`;
      $('setupCamB').textContent = `${st.camB.label} — ${st.camB.note}`;
      $('setupFraming').innerHTML = [...st.framing, st.travelNote].map((x) => `<li>${esc(x)}</li>`).join('');
      $('calibrateBtn').textContent = c?.status === 'suspect' ? `RECALIBRATE SETUP ${a.courtSetup}` : `CALIBRATE SETUP ${a.courtSetup}`;
    }
    // animation card
    const e = s.animations?.[a.id], done = !!e?.selectedTake;
    $('animMeta').textContent = `#${a.id} · ${a.key}${done ? ` · ✓ DONE (take ${e.takes.indexOf(e.selectedTake) + 1} of ${e.takes.length})` : e?.takes?.length ? ` · ${e.takes.length} take(s), none accepted` : ''}`;
    $('animTitle').textContent = a.title; $('animSub').textContent = a.subtitle || '';
    $('fStart').textContent = stateLabel(a.startState); $('fEnd').textContent = a.endResolves ? `${a.endState}/${a.endResolves}` : a.endState;
    $('fStart').title = [].concat(a.startState).map((x) => STATES[x]?.name).join(' / '); $('fEnd').title = STATES[a.endState]?.name || '';
    $('fDur').textContent = `~${a.durationSec} SEC${a.loop ? ' · LOOP' : ''}`;
    const fpsA = D.presence.camA?.state?.camera?.frameRate, fpsB = D.presence.camB?.state?.camera?.frameRate;
    $('fFps').textContent = `120 FPS if supported${fpsA || fpsB ? ` · now A ${fpsA ? Math.round(fpsA) : '—'} · B ${fpsB ? Math.round(fpsB) : '—'}` : ''}`;
    $('fHand').textContent = HAND_LABEL[a.ballHand]; $('fDir').textContent = DIR_LABEL[a.direction];
    $('fProtocol').textContent = a.loop ? `LOOP: ${a.durationSec} s of natural, repeated cycles at game speed.` : `HOLD ${stateLabel(a.startState)} ~1 s → the move at GAME SPEED → HOLD ${a.endState} ~1 s.`;
    $('fCues').innerHTML = a.cues.map((x) => `<li>${esc(x)}</li>`).join('');
    $('animCourt').innerHTML = courtSVG(a.courtSetup, a, { width: 520 });
    $('animCams').textContent = `Cam A: ${st.camA.label} · Cam B: ${st.camB.label}`;
    $('animFraming').innerHTML = st.framing.map((x) => `<li>${esc(x)}</li>`).join('');
    // record button
    const bothReady = camReady('camA') && camReady('camB');
    const oneReady = camReady('camA') || camReady('camB');
    const rb = $('recordBtn');
    rb.disabled = !(D.link.open && oneReady) || setupNeeded || D.phase !== 'idle';
    rb.textContent = bothReady ? 'RECORD BOTH' : oneReady ? `RECORD (${camReady('camA') ? 'CAM A' : 'CAM B'} ONLY)` : 'RECORD BOTH';
    $('recordWhy').textContent = !D.link.open ? 'connecting…' : setupNeeded ? 'place + calibrate the cameras for this setup first' : !oneReady ? 'waiting for the cameras' : !bothReady ? 'only one camera is ready — pair / wake camera B for two-view takes' : '';
    show($('recordBox'), D.phase === 'idle');
    show($('recordingBox'), D.phase === 'recording');
    show($('reviewBox'), D.phase === 'uploading' || D.phase === 'review');
    const codeLive = s.pair?.code && Date.parse(s.pair.codeExpiresAt || 0) > Date.now();
    $('deviceLine').textContent = `Session ${s.name} · ${s.id} · pairing code ${codeLive ? s.pair.code : '— (open Pair camera)'} · clock ±${D.clock.best ? D.clock.best.uncertaintyMs.toFixed(0) : '?'} ms`;
  }

  // ── recording lifecycle
  async function record() {
    const a = D.current; if (!a) return;
    try {
      const kind = D.calib ? 'calibration' : 'take';
      const r = kind === 'calibration'
        ? await api(`/api/capture/sessions/${sessionId}/calibrations`, { method: 'POST', body: { setup: D.calib } })
        : await api(`/api/capture/sessions/${sessionId}/takes`, { method: 'POST', body: { animId: a.id } });
      D.take = r.take || r.calibration;
      D.phase = 'recording'; D.recStart = performance.now();
      $('recName').textContent = kind === 'calibration' ? `CALIBRATION · SETUP ${D.calib} — walk the court lines, hold the ball at the free-throw line, stand under the rim` : `${a.title} ${a.subtitle || ''} · take ${D.take.takeNo} · ${stateLabel(a.startState)} → ${a.endState}`;
      render();
      D.link.send({ t: 'start', takeId: D.take.id });
      runTimer(kind === 'calibration' ? 10 : a.durationSec);
    } catch (e) { alert(`Could not start: ${e.message}`); D.phase = 'idle'; render(); }
  }
  async function resumeRecording(armed) {
    D.resuming = true;
    try {
      const r = await api(`/api/capture/sessions/${sessionId}/rec/${armed.takeId}`);
      if (r.take.state !== 'recording' || D.phase !== 'idle' || D.take) return;
      D.take = r.take; D.phase = 'recording'; D.calib = r.take.kind === 'calibration' ? r.take.courtSetup : null;
      D.recAt = armed.at || r.take.sync?.startAtServerMs || null; D.recStart = performance.now();
      $('recName').textContent = r.take.kind === 'calibration' ? `CALIBRATION · SETUP ${r.take.courtSetup} (resumed)` : `${r.take.title || 'take'} ${r.take.subtitle || ''} · take ${r.take.takeNo} (resumed)`;
      render(); runTimer(r.take.targetDurationSec || 4);
    } catch {} finally { D.resuming = false; }
  }
  function runTimer(target) {
    const tick = () => {
      if (D.phase !== 'recording') return;
      const t = D.recAt ? Math.max(0, (D.clock.toLocal(D.recAt) != null ? Date.now() - D.clock.toLocal(D.recAt) : performance.now() - D.recStart) / 1000) : 0;
      $('timer').textContent = t.toFixed(1);
      $('recBar').style.width = `${Math.min(100, (100 * t) / target)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  }
  function stop() {
    if (D.phase !== 'recording') return;
    D.stopFor = D.take.id; D.stoppedAt = Date.now();
    sendStop();
    D.phase = 'uploading'; D.recAt = null;
    renderReview(); render();
    pollTake();
  }
  // the STOP is sent until the hub answers with the halt — also across a reconnect (a dropped
  // message would leave the cameras recording until their 120 s cap)
  function sendStop() {
    clearTimeout(D.stopTimer);
    if (!D.stopFor) return;
    D.link.send({ t: 'stop', takeId: D.stopFor });
    D.stopTimer = setTimeout(sendStop, 2000);
  }
  $('finishBtn').onclick = async () => {
    const t = D.take; if (!t) return;
    $('finishBtn').disabled = true;
    try { const r = await api(`/api/capture/sessions/${sessionId}/rec/${t.id}/finish`, { method: 'POST', body: {} }); D.take = r.take; if (r.take.state === 'review') D.phase = 'review'; }
    catch (e) { alert(e.message); }
    $('finishBtn').disabled = false; renderReview(); render();
  };
  async function pollTake() {
    // the WebSocket brings updates; this is the safety net (and the resume path after a refresh)
    const id = D.take?.id;
    for (let i = 0; i < 600 && D.take?.id === id && D.phase === 'uploading'; i++) {
      await sleep(1500);
      try { const r = await api(`/api/capture/sessions/${sessionId}/rec/${id}`); if (D.take?.id !== id) return; D.take = r.take; if (r.take.state === 'review') D.phase = 'review'; renderReview(); render(); } catch {}
    }
  }
  function renderReview() {
    const t = D.take; if (!t) return;
    $('reviewTitle').textContent = t.kind === 'calibration' ? `Calibration · setup ${t.courtSetup} · #${t.takeNo}` : `${t.title} ${t.subtitle || ''} · take ${t.takeNo}`;
    $('reviewState').textContent = t.state === 'review' ? (t.validation?.ok ? 'checks passed' : 'checks: look') : t.state;
    const expected = t.expectedCams?.length ? t.expectedCams : ['camA', 'camB'];
    const cams = ['camA', 'camB'].filter((c) => t.cameras?.[c]?.file || expected.includes(c));
    $('uploadLine').textContent = cams.map((c) => `${c === 'camA' ? 'Cam A' : 'Cam B'}: ${t.cameras?.[c]?.file ? `✓ ${(t.cameras[c].bytes / 1e6).toFixed(1)} MB` : !D.presence[c]?.online ? 'offline — its upload continues when it is back' : D.presence[c]?.state?.uploads?.chunks ? `uploading (${D.presence[c].state.uploads.chunks} left)` : 'finishing…'}`).join(' · ');
    // a camera that stays away (phone died, out of Wi-Fi): review what arrived instead of waiting
    const up = ['camA', 'camB'].filter((c) => t.cameras?.[c]?.file), waiting = expected.filter((c) => !t.cameras?.[c]?.file);
    const late = ['armed', 'recording', 'uploading'].includes(t.state) && up.length && waiting.length && Date.now() - (D.stoppedAt || 0) > 10000;
    show($('finishRow'), !!late);
    if (late) { $('finishBtn').textContent = `REVIEW WITHOUT ${waiting.map((c) => (c === 'camA' ? 'CAM A' : 'CAM B')).join(' + ')}`; $('finishWhy').textContent = 'its footage is still added to this take if it arrives later'; }
    const vids = cams.filter((c) => t.cameras?.[c]?.file);
    const have = [...$('reviewVids').querySelectorAll('video')].map((v) => v.dataset.cam).join(',');
    if (have !== vids.join(',')) $('reviewVids').innerHTML = vids.map((c) => `<div><div class="small dim">${c === 'camA' ? 'CAM A' : 'CAM B'}</div><video data-cam="${c}" playsinline controls preload="metadata" src="/api/capture/sessions/${sessionId}/rec/${t.id}/${c}/video"></video></div>`).join('');
    $('playBoth').disabled = !vids.length;
    const v = t.validation;
    $('checks').innerHTML = v ? v.checks.map((c) => `<div class="${c.level}">${esc(c.msg)}</div>`).join('') : '<div class="dim">checks run when both recordings are in…</div>';
    $('acceptBtn').disabled = t.state !== 'review';
    $('acceptBtn').textContent = t.kind === 'calibration' ? (v && !v.ok ? 'ACCEPT ANYWAY' : 'ACCEPT CALIBRATION') : (v && !v.ok ? 'ACCEPT ANYWAY + NEXT' : 'ACCEPT + NEXT');
  }
  $('playBoth').onclick = () => { const vs = [...$('reviewVids').querySelectorAll('video')]; vs.forEach((v) => { v.currentTime = 0; }); vs.forEach((v) => v.play()); };
  async function accept() {
    const t = D.take; if (!t) return;
    $('acceptBtn').disabled = true;
    try {
      const r = await api(`/api/capture/sessions/${sessionId}/rec/${t.id}/accept`, { method: 'POST', body: { force: !t.validation?.ok } });
      if (!r.saved) throw new Error('not saved');
      await load();
      show($('reviewBox'), false); show($('savedBox'));
      if (t.kind === 'calibration') {
        D.link.send({ t: 'relay', msg: { t: 'setref', setup: t.courtSetup } });          // cameras keep this view as the calibration reference
        D.calib = null; D.take = null; D.phase = 'idle';
        await sleep(700); show($('savedBox'), false);
        landmarks(r.take);
      } else {
        D.take = null; D.phase = 'idle';
        const next = r.progress.next;
        await sleep(900); show($('savedBox'), false);
        D.current = next;                                   // straight to the next missing animation
      }
      render();
    } catch (e) { alert(`Not saved: ${e.message}`); $('acceptBtn').disabled = false; }
  }
  async function retake() {
    const t = D.take; if (!t) return;
    try { await api(`/api/capture/sessions/${sessionId}/rec/${t.id}/reject`, { method: 'POST', body: {} }); } catch {}
    D.take = null; D.phase = 'idle';
    await load(); render();
  }
  keptActions($('banners'), () => D.cam, () => render());
  $('banners').addEventListener('click', (e) => { if (e.target?.dataset?.act === 'direct') { D.link.reopen(); render(); } });
  $('recordBtn').onclick = record;
  $('stopBtn').onclick = stop;
  $('acceptBtn').onclick = accept;
  $('retakeBtn').onclick = retake;
  $('calibrateBtn').onclick = () => { D.calib = D.current.courtSetup; D.phase = 'idle'; record(); };
  $('skipCalBtn').onclick = async () => {
    const setup = D.current.courtSetup;
    const r = await api(`/api/capture/sessions/${sessionId}/setup`, { method: 'POST', body: { setup, skipCalibration: true } });
    D.session = r.session; D.progress = P.progress(D.lib, D.session);
    D.link.send({ t: 'relay', msg: { t: 'setref', setup } });            // cameras still watch for being moved
    render();
  };
  const step = (dir) => { const i = D.order.indexOf(D.current); D.current = D.order[(i + dir + D.order.length) % D.order.length]; render(); };
  $('prevAnim').onclick = () => step(-1); $('nextAnim').onclick = () => step(1);
  $('missingBtn').onclick = async () => { await load(); D.current = D.progress.next; render(); window.scrollTo(0, 0); };
  $('sessionsBtn').onclick = () => { location.href = '/capture'; };
  $('pairBtn').onclick = async () => {
    const box = $('pairBox'); show(box, box.classList.contains('hidden'));
    if (box.classList.contains('hidden')) return;
    try {
      const r = await api(`/api/capture/sessions/${sessionId}/pair`);
      $('qr').innerHTML = r.qrSvg; $('pairCode').textContent = r.code;
      D.session.pair = { ...(D.session.pair || {}), code: r.code, codeExpiresAt: r.codeExpiresAt };
      $('pairExpiry').textContent = `valid until ${new Date(r.codeExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (the QR code does not expire)`;
      show($('pairLanHint'), !!r.https);
      $('pairUrls').innerHTML = r.urls.map((u) => `<div><a href="${esc(u.url)}" target="_blank">${esc(u.url.replace(/pair=.*/, 'pair=…'))}</a> <span class="dim">(${esc(u.kind)})</span></div>`).join('');
    } catch (e) { $('pairUrls').textContent = e.message; }
  };
  $('takesBtn').onclick = async () => { const box = $('takesBox'); show(box, box.classList.contains('hidden')); if (!box.classList.contains('hidden')) renderTakes(); };
  async function renderTakes() {
    const a = D.current, e = D.session.animations?.[a.id];
    if (!e?.takes?.length) { $('takesBox').innerHTML = `<div class="dim">No takes of ${esc(a.title)} ${esc(a.subtitle || '')} yet.</div>`; return; }
    const takes = await Promise.all(e.takes.map((id) => api(`/api/capture/sessions/${sessionId}/rec/${id}`).then((r) => r.take).catch(() => null)));
    const procs = await api('/api/capture/processors').then((r) => r.processors).catch(() => []);
    $('takesBox').innerHTML = `<b>${esc(a.title)} ${esc(a.subtitle || '')}</b><div class="list">` + takes.filter(Boolean).map((t) => `<div><div class="grow">take ${t.takeNo} · ${t.state}${e.selectedTake === t.id ? ' · <b style="color:var(--ok)">SELECTED</b>' : ''}<div class="small dim">${['camA', 'camB'].filter((c) => t.cameras?.[c]?.file).map((c) => `<a href="/api/capture/sessions/${sessionId}/rec/${t.id}/${c}/video" target="_blank">${c}</a>`).join(' · ')}${t.processing?.sam3dbody ? ' · SAM 3D: ' + Object.entries(t.processing.sam3dbody).map(([c, p]) => `${c} ${esc(p.motionId)}`).join(', ') : ''}</div></div>`
      + (t.accepted && e.selectedTake !== t.id ? `<button data-sel="${t.id}">MARK BEST</button>` : '')
      + (t.accepted && procs.find((p) => p.id === 'sam3dbody')?.available ? `<button data-proc="${t.id}">SAM 3D Body…</button>` : '')
      + ['camA', 'camB'].map((c) => `<label class="small" style="border:1px solid var(--line);border-radius:10px;padding:6px 8px;cursor:pointer">${t.cameras?.[c]?.native ? `${c} ${Math.round(t.cameras[c].native.probe?.fps || 0)} fps ✓` : `+ ${c} 120 fps file`}<input type="file" accept="video/*" data-native="${t.id}" data-cam="${c}" style="display:none"></label>`).join('') + '</div>').join('') + '</div>'
      + '<p class="small dim">Native high-frame-rate path: record the same take with the phone\'s camera app at 120/240 fps (the director\'s sync chirp is in its audio), then attach the file here — it is aligned to the take by that chirp.</p>';
    $('takesBox').querySelectorAll('[data-native]').forEach((inp) => { inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      inp.parentElement.firstChild.textContent = `uploading ${(f.size / 1e6).toFixed(0)} MB…`;
      const r = await fetch(`/api/capture/sessions/${sessionId}/rec/${inp.dataset.native}/${inp.dataset.cam}/native`, { method: 'PUT', headers: { 'X-Filename': f.name }, body: f, credentials: 'same-origin' });
      if (!r.ok) alert(`Upload failed: HTTP ${r.status}`);
      renderTakes();
    }; });
    $('takesBox').querySelectorAll('[data-sel]').forEach((b) => { b.onclick = async () => { await api(`/api/capture/sessions/${sessionId}/rec/${b.dataset.sel}/select`, { method: 'POST', body: {} }); await load(); render(); renderTakes(); }; });
    $('takesBox').querySelectorAll('[data-proc]').forEach((b) => { b.onclick = async () => {
      const cam = prompt('Process which camera view with SAM 3D Body? (camA / camB)', 'camA'); if (!cam) return;
      const frames = 120, cost = (frames * 0.03).toFixed(2);
      if (!confirm(`This sends ${frames} frames of ${cam} to fal.ai (SAM 3D Body) — about $${cost}. Continue?`)) return;
      try { const r = await api(`/api/capture/sessions/${sessionId}/rec/${b.dataset.proc}/process`, { method: 'POST', body: { processor: 'sam3dbody', cam, fps: 30, maxFrames: frames, confirmCostUsd: +cost, role: (a.gameRoles || [])[0] } }); alert(`Processing started (job ${r.job.id}).`); }
      catch (e) { alert(e.message); }
    }; });
  }
  $('exportBtn').onclick = () => { const box = $('exportBox'); show(box, box.classList.contains('hidden')); $('exportLink').href = `/api/capture/sessions/${sessionId}/export.tar`; $('exportAll').href = `/api/capture/sessions/${sessionId}/export.tar?all=1`; };

  // ── calibration landmarks: tap known court points on each camera's still
  async function landmarks(rec) {
    const box = $('landmarkBox');
    const cams = ['camA', 'camB'].filter((c) => rec.cameras?.[c]?.file);
    const names = Object.keys((await api('/api/capture/libraries')).court.landmarks);
    for (const cam of cams) {
      show(box); $('lmCam').textContent = cam === 'camA' ? 'CAM A' : 'CAM B';
      const pts = {}; let cur = names[0];
      const img = `/api/capture/sessions/${sessionId}/rec/${rec.id}/${cam}/still.jpg?t=1`;
      const draw = () => {
        $('lmNames').innerHTML = names.map((n) => `<button data-n="${n}" class="${n === cur ? 'pri' : ''}" style="padding:6px 8px;font-size:12px">${n.replace(/_/g, ' ')}${pts[n] ? ' ✓' : ''}</button>`).join('');
        $('lmImg').innerHTML = `<img src="${img}" alt="calibration still">` + Object.values(pts).map(([u, v]) => `<i style="left:${u * 100}%;top:${v * 100}%"></i>`).join('');
        $('lmNames').querySelectorAll('button').forEach((b) => { b.onclick = () => { cur = b.dataset.n; draw(); }; });
        $('lmImg').querySelector('img').onclick = (e) => { const r = e.target.getBoundingClientRect(); pts[cur] = [+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4)]; const i = names.indexOf(cur); cur = names[Math.min(names.length - 1, i + 1)]; draw(); };
      };
      draw();
      const saved = await new Promise((resolve) => { $('lmSave').onclick = () => resolve(true); $('lmSkip').onclick = () => resolve(false); });
      if (saved && Object.keys(pts).length) await api(`/api/capture/sessions/${sessionId}/rec/${rec.id}/landmarks`, { method: 'POST', body: { cam, points: pts } }).catch((e) => alert(e.message));
    }
    show(box, false);
    render();
  }

  // resume after a refresh: a take that was being uploaded / reviewed
  const inflight = D.session.animations?.[D.current?.id]?.takes?.slice(-1)[0];
  if (inflight) {
    try {
      const r = await api(`/api/capture/sessions/${sessionId}/rec/${inflight}`);
      if (['uploading', 'validating', 'review'].includes(r.take.state)) { D.take = r.take; D.phase = r.take.state === 'review' ? 'review' : 'uploading'; D.stoppedAt = Date.parse(r.take.validatingAt || '') || Date.now(); renderReview(); if (D.phase === 'uploading') pollTake(); }
    } catch {}
  }
  render();
  setInterval(render, 1000);
}

// ═══ route ═════════════════════════════════════════════════════════════════
if (Q.get('pair')) cameraMode(Q.get('pair'), Q.get('role') === 'camA' ? 'camA' : 'camB');
else if (Q.get('session')) directorMode(Q.get('session'));
else homeMode();
