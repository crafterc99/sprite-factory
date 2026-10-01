/**
 * Soul Jam Capture — the real-time hub (WebSocket at /api/capture/ws?session=<id>&token=<pair token>).
 *
 * One room per capture session: the director and the cameras (camA, camB) connect; the hub keeps
 * presence (READY / offline), answers clock pings (the shared session clock is the server's),
 * turns the director's RECORD / STOP into timed commands for every camera (start at the same
 * server time), relays take progress and the cameras' live snapshots (director only). The state
 * that matters is persisted by the store; a
 * device that reconnects gets it back from the session, not from memory here.
 */
'use strict';
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./store');

const sameToken = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B); };

const CAM_ROLES = ['camA', 'camB'];
const RELAYS = ['setref', 'zoom'];   // the only director → camera commands
const START_LEAD_MS = 800;       // capture/protocol.mjs START_LEAD_SEC
const HALT_LEAD_MS = 60;
// a camera expected in a take says it got the start (its state report carries the take id); one
// that has not by this long after the scheduled start never started (asleep, page in the background)
const ACK_GRACE_MS = Number(process.env.CAPTURE_ACK_GRACE_MS) || 3000;
/** The camera placement (one calibration) of each court setup — = capture/court-layout.mjs stationOf. */
const STATION_OF = { A: 'A', B: 'A', C: 'C' };
/**
 * Did this camera's state report say it got the start of `takeId`? (Its state names the take it
 * records now, or the last one it started. A page of the earlier code — still open on a phone
 * after a deploy — reports no take at all: there, "recording" is the acknowledgement.)
 */
const startedTake = (st, takeId) => !!st && ([st.take, st.lastTake].includes(takeId) || (st.take === undefined && st.lastTake === undefined && st.recording === true));
const STALE_MS = 12000;        // READY needs a camera state report this recent (a busy phone can go quiet for seconds)
const PING_MS = 5000;         // WebSocket protocol pings: answered by the browser's network stack even while the page is busy
// live snapshots: a small JPEG a camera sends every ~1.5 s while idle, relayed to the director only
const SNAP_MIN_MS = 700;         // at most this often per camera (extra ones are dropped)
const SNAP_MAX_CHARS = 160000;   // a data: URL (~120 KB of JPEG) — well under the socket's maxPayload
const SNAP_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

class Hub {
  constructor({ isAuthed, onTake, onStop, onMissing } = {}) {
    this.isAuthed = isAuthed || (() => true);
    this.onTake = onTake || null;
    this.onStop = onStop || null;
    this.onMissing = onMissing || null;           // (sid, takeId, cams): expected cameras that never started
    this.rooms = new Map();                     // sessionId → { devices: Map(role → dev), armed }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 << 10 });
    this.wss.on('error', (e) => console.error('[capture] ws server', e.message));
    this.timer = setInterval(() => this.sweep(), PING_MS);
    this.timer.unref?.();
    if (process.env.CAPTURE_DEBUG) { let t = Date.now(); const lag = setInterval(() => { const n = Date.now(); if (n - t > 700) console.log(`[capture] event loop blocked ${n - t - 250} ms`); t = n; }, 250); lag.unref?.(); }
  }
  /** Attach to an http(s) server's upgrade event (both the http and the LAN https listener). */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      // a reset or a malformed frame on a raw socket must never take the whole server down
      socket.on('error', () => { try { socket.destroy(); } catch {} });
      let u;
      try { u = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
      if (u.pathname !== '/api/capture/ws') {                // other upgrade paths: someone else's, or nobody's
        if (server.listenerCount('upgrade') <= 1) socket.destroy();
        return;
      }
      this.authorize(req, u).then((ctx) => {
        if (socket.destroyed) return;
        if (!ctx) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, ctx));
      }).catch(() => { socket.destroy(); });
    });
  }
  /**
   * Director: the studio sign-in (or none when the gate is off). Cameras: the session's pair
   * token — which only ever grants the camera roles, never the director.
   */
  async authorize(req, u) {
    const sid = store.safe(u.searchParams.get('session'));
    const token = u.searchParams.get('token') || '';
    const s = sid ? await store.loadSession(sid) : null;
    if (!s) return null;
    const director = !!this.isAuthed(req);
    const paired = sameToken(token, s.pair?.token);
    if (!paired && !director) return null;
    return { session: s, paired, director };
  }
  room(id) { let r = this.rooms.get(id); if (!r) this.rooms.set(id, (r = { devices: new Map(), armed: null, snaps: {} })); return r; }
  connect(ws, { session, director }) {
    const sid = session.id, room = this.room(sid);
    let me = null;
    ws.alive = true;
    ws.director = !!director;
    ws.on('error', () => { try { ws.terminate(); } catch {} });   // e.g. an over-size frame: drop this socket, not the server
    ws.on('pong', () => { ws.alive = true; if (me) me.lastSeen = Date.now(); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      this.handle(ws, sid, room, m, (d) => { me = d; }, () => me).catch((e) => this.send(ws, { t: 'error', msg: e.message }));
    });
    ws.on('close', () => {
      if (me && room.devices.get(me.role)?.ws === ws) { me.online = false; me.ws = null; me.lastSeen = Date.now(); this.presence(sid); }
    });
  }
  send(ws, m) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch {} } }
  broadcast(sid, m, { roles = null } = {}) {
    const r = this.rooms.get(sid); if (!r) return;
    for (const d of r.devices.values()) if (d.online && (!roles || roles.includes(d.role))) this.send(d.ws, m);
  }
  presence(sid) {
    const r = this.rooms.get(sid); if (!r) return;
    const devices = {};
    const now = Date.now();
    for (const [role, d] of r.devices) devices[role] = { role, deviceId: d.deviceId, online: d.online, ready: !!(d.online && d.state?.ready && now - (d.state.at || 0) < STALE_MS), state: d.state || null, lastSeen: d.lastSeen, device: d.device };
    this.broadcast(sid, { t: 'presence', devices, armed: r.armed, now: Date.now() });
  }
  /** Dead sockets (no answer to a protocol ping) are dropped; live-but-busy pages are kept. */
  sweep() {
    for (const [sid, r] of this.rooms) {
      let changed = false;
      for (const d of r.devices.values()) {
        if (!d.online || !d.ws) continue;
        if (!d.ws.alive) { if (process.env.CAPTURE_DEBUG) console.log(`[capture] ${d.role}: no pong → offline`); d.online = false; changed = true; try { d.ws.terminate(); } catch {} continue; }
        d.ws.alive = false;
        try { d.ws.ping(); } catch {}
      }
      // READY also expires when a camera stops reporting
      if (changed || [...r.devices.values()].some((d) => d.online && d.state?.ready)) this.presence(sid);
    }
  }
  async handle(ws, sid, room, m, setMe, getMe) {
    const now = Date.now();
    if (m.t === 'ping') return this.send(ws, { t: 'pong', c: m.c, s: now });
    if (m.t === 'hello') {
      const role = ['director', 'camA', 'camB'].includes(m.role) ? m.role : 'camB';
      // a camera's pairing token never makes it the director (start / stop / relay / kick)
      if (role === 'director' && !ws.director) { this.send(ws, { t: 'error', msg: 'the director role needs the studio sign-in' }); try { ws.close(4001, 'director needs sign-in'); } catch {} return; }
      const deviceId = String(m.deviceId || '').slice(0, 64);
      const device = m.device && typeof m.device === 'object' && JSON.stringify(m.device).length < 2000 ? m.device : null;
      const prev = room.devices.get(role);
      // the newest page takes the role; the old one is told so and stops reconnecting (no ping-pong)
      if (prev?.ws && prev.ws !== ws) { this.send(prev.ws, { t: 'replaced', role }); try { prev.ws.close(4000, 'replaced'); } catch {} }
      const d = { role, ws, deviceId, device, state: prev?.deviceId === deviceId ? prev.state : null, online: true, lastSeen: now };
      room.devices.set(role, d);
      setMe(d);
      let s = await store.loadSession(sid);
      // the session records which device holds each role — written only when that changes
      if (s && s.devices?.[role]?.deviceId !== deviceId) s = await store.updateSession(sid, (x) => { x.devices[role] = { deviceId, device, since: new Date().toISOString() }; });
      this.send(ws, { t: 'welcome', you: role, now, session: s ? publicSession(s) : null, armed: room.armed });
      // a director (re)joining sees each camera's last picture right away
      if (role === 'director') for (const snap of Object.values(room.snaps)) if (now - snap.at < 60000) this.send(ws, snap);
      return this.presence(sid);
    }
    const me = getMe();
    if (!me) return this.send(ws, { t: 'error', msg: 'say hello first' });
    me.lastSeen = now; me.online = true;
    switch (m.t) {
      case 'state': {
        me.state = { ...(m.state || {}), at: now };
        // "I got the start of this take" (its state names the take it records, or recorded last)
        const a = room.armed;
        if (a?.recording && CAM_ROLES.includes(me.role) && startedTake(me.state, a.takeId)) (a.acks ||= new Set()).add(me.role);
        return this.presence(sid);
      }
      case 'arm': {                                           // director: the next take is this animation (the take is created by the REST call)
        if (me.role !== 'director') return;
        room.armed = m.take ? { takeId: m.take.id, kind: m.take.kind, animId: m.take.animId || null, setup: m.take.courtSetup, takeNo: m.take.takeNo, title: m.take.title || null, subtitle: m.take.subtitle || null, targetDurationSec: m.take.targetDurationSec || null } : null;
        this.broadcast(sid, { t: 'armed', armed: room.armed });
        return this.presence(sid);
      }
      case 'start': {
        if (me.role !== 'director' || !room.armed || room.armed.takeId !== m.takeId) return this.send(ws, { t: 'error', msg: 'nothing armed' });
        if (room.armed.recording) return;                     // a repeated start
        // the take waits for exactly the cameras that were READY when it started
        const expected = CAM_ROLES.filter((c) => { const d = room.devices.get(c); return d?.online && d.state?.ready && now - (d.state.at || 0) < STALE_MS; });
        if (!expected.length) return this.send(ws, { t: 'error', msg: 'no camera is ready' });
        const at = now + START_LEAD_MS;
        room.armed.recording = true; room.armed.at = at; room.armed.expectedCams = expected; room.armed.acks = new Set();
        this.broadcast(sid, { t: 'record', takeId: m.takeId, at });     // first: the start time has to reach the cameras before it passes
        this.presence(sid);
        const t = setTimeout(() => this.checkStarted(sid, m.takeId), at - Date.now() + ACK_GRACE_MS);
        t.unref?.();
        await store.updateRecording(sid, m.takeId, (r) => { r.state = 'recording'; r.expectedCams = expected; r.sync.startAtServerMs = at; r.sync.leadMs = START_LEAD_MS; r.sync.commandAtServerMs = now; }, { rollback: false });
        return;
      }
      case 'stop': {
        if (me.role !== 'director' || typeof m.takeId !== 'string') return;
        const armed = room.armed?.takeId === m.takeId ? room.armed : null;
        // a repeated STOP (the director resends until it hears the halt) repeats the same halt
        if (armed && armed.recording === false && armed.stoppedAt) return this.broadcast(sid, { t: 'halt', takeId: m.takeId, at: armed.stoppedAt });
        const at = now + HALT_LEAD_MS;
        if (armed) { armed.recording = false; armed.stoppedAt = at; }
        this.broadcast(sid, { t: 'halt', takeId: m.takeId, at });
        this.presence(sid);
        // also after a server restart (nothing armed in memory): the take on disk is stopped
        await store.updateRecording(sid, m.takeId, (r) => {
          if (!r.sync.stopAtServerMs) r.sync.stopAtServerMs = at;
          if (r.state === 'armed' || r.state === 'recording') r.state = 'uploading';   // never back from review / accepted
        }, { rollback: false });
        this.onStop?.(sid, m.takeId);                         // cameras that finished before the STOP (self-capped): on to review
        return;
      }
      case 'snap': {                                          // a camera's live picture → the director (never another camera)
        if (!CAM_ROLES.includes(me.role)) return;
        const jpg = typeof m.jpg === 'string' ? m.jpg : '';
        if (!jpg || jpg.length > SNAP_MAX_CHARS || !SNAP_RE.test(jpg)) return;
        if (now - (me.snapAt || 0) < SNAP_MIN_MS) return;     // rate limit
        me.snapAt = now;
        const snap = { t: 'snap', role: me.role, jpg, w: Math.min(4096, Math.max(0, m.w | 0)), h: Math.min(4096, Math.max(0, m.h | 0)), at: now };
        room.snaps[me.role] = snap;
        this.broadcast(sid, snap, { roles: ['director'] });
        return;
      }
      case 'relay':                                           // director → cameras: "store your calibration reference now" · "zoom to …"
        if (me.role !== 'director' || !m.msg || !RELAYS.includes(m.msg.t)) return;
        if (m.msg.t === 'zoom') {
          const z = +m.msg.zoom;
          if (!CAM_ROLES.includes(m.msg.role) || !(z > 0 && z <= 20)) return;
          this.broadcast(sid, { t: 'zoom', zoom: z, from: 'director' }, { roles: [m.msg.role] });
          return;
        }
        this.broadcast(sid, { t: m.msg.t, setup: ['A', 'B', 'C'].includes(m.msg.setup) ? m.msg.setup : null, from: 'director' }, { roles: CAM_ROLES });
        return;
      case 'chirp':                                           // the director played the sync chirp at server time m.at
        if (me.role !== 'director' || typeof m.takeId !== 'string' || !Number.isFinite(m.at)) return;
        await store.updateRecording(sid, m.takeId, (r) => { r.sync.chirp = { f0: m.chirp?.f0, f1: m.chirp?.f1, durationMs: m.chirp?.durationMs, gain: m.chirp?.gain, atServerMs: m.at, playedBy: 'director', uncertaintyMs: Number.isFinite(m.uncertaintyMs) ? m.uncertaintyMs : null }; }, { rollback: false });
        return;
      case 'moved': {                                         // a camera moved since calibration (one per camera placement)
        const setup = STATION_OF[m.setup] || null;
        if (!setup) return;
        const reason = `${me.role}: ${String(m.reason || 'moved').slice(0, 120)}`;
        const changed = await store.updateSession(sid, (s) => { const c = s.calibrations[setup]; if (c && ['valid', 'skipped'].includes(c.status)) { c.status = 'suspect'; c.suspectReason = reason; c.suspectAt = new Date().toISOString(); return true; } return false; });
        if (changed) this.broadcast(sid, { t: 'calibration', setup, status: 'suspect', reason });
        return;
      }
      default: return;
    }
  }
  /**
   * A few seconds after a take's scheduled start: did every expected camera say it started? One
   * that did not (its page asleep or in the background when RECORD was pressed) will never upload:
   * the director is told at once, the take records it (missingCams) and goes on without it.
   */
  async checkStarted(sid, takeId) {
    const room = this.rooms.get(sid), a = room?.armed;
    if (!a || a.takeId !== takeId) return;                    // discarded / already finished
    const acks = a.acks || new Set();
    for (const c of a.expectedCams || []) if (startedTake(room.devices.get(c)?.state, takeId)) acks.add(c);
    const missing = (a.expectedCams || []).filter((c) => !acks.has(c));
    if (!missing.length) return;
    a.missingCams = missing;
    this.broadcast(sid, { t: 'notrecording', takeId, cams: missing, kind: a.kind || null, animId: a.animId || null });
    try {
      await store.updateRecording(sid, takeId, (r) => { r.missingCams = missing; r.missingAt = new Date().toISOString(); }, { rollback: false });
    } catch (e) { console.error('[capture] missing cams', takeId, e.message); }
    this.onMissing?.(sid, takeId, missing);
  }
  /** A take changed (upload progress, validation, saved): tell the room. */
  takeUpdate(sid, take, extra = {}) { this.broadcast(sid, { t: 'take', take: publicTake(take), ...extra }); }
  disarm(sid, takeId) { const r = this.rooms.get(sid); if (r?.armed?.takeId === takeId) { r.armed = null; this.broadcast(sid, { t: 'armed', armed: null }); this.presence(sid); } }
  close() { clearInterval(this.timer); this.wss.close(); }
}

/** What clients may see of a session (never the pair token to cameras — they already hold it). */
function publicSession(s) {
  const { pair, ...rest } = s;
  return { ...rest, pair: { code: pair?.code } };
}
function publicTake(t) { return t; }

module.exports = { Hub, publicSession, START_LEAD_MS, SNAP_MIN_MS, SNAP_MAX_CHARS, CAM_ROLES, STATION_OF, ACK_GRACE_MS, startedTake };
