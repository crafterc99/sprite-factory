/**
 * Soul Jam Capture — the real-time hub (WebSocket at /api/capture/ws?session=<id>&token=<pair token>).
 *
 * One room per capture session: the director and the cameras (camA, camB) connect; the hub keeps
 * presence (READY / offline), answers clock pings (the shared session clock is the server's),
 * turns the director's RECORD / STOP into timed commands for every camera (start at the same
 * server time), and relays take progress. The state that matters is persisted by the store; a
 * device that reconnects gets it back from the session, not from memory here.
 */
'use strict';
const { WebSocketServer } = require('ws');
const store = require('./store');

const START_LEAD_MS = 800;       // capture/protocol.mjs START_LEAD_SEC
const HALT_LEAD_MS = 60;
const STALE_MS = 12000;        // READY needs a camera state report this recent (a busy phone can go quiet for seconds)
const PING_MS = 5000;         // WebSocket protocol pings: answered by the browser's network stack even while the page is busy

class Hub {
  constructor({ isAuthed, onTake } = {}) {
    this.isAuthed = isAuthed || (() => true);
    this.onTake = onTake || null;
    this.rooms = new Map();                     // sessionId → { devices: Map(role → dev), armed }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    this.timer = setInterval(() => this.sweep(), PING_MS);
    this.timer.unref?.();
    if (process.env.CAPTURE_DEBUG) { let t = Date.now(); const lag = setInterval(() => { const n = Date.now(); if (n - t > 700) console.log(`[capture] event loop blocked ${n - t - 250} ms`); t = n; }, 250); lag.unref?.(); }
  }
  /** Attach to an http(s) server's upgrade event (both the http and the LAN https listener). */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/api/capture/ws') return;          // other upgrade paths are not ours
      this.authorize(req, u).then((ctx) => {
        if (!ctx) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, ctx));
      }).catch(() => { socket.destroy(); });
    });
  }
  /** Director: the studio sign-in (or none when the gate is off). Cameras: the session's pair token. */
  async authorize(req, u) {
    const sid = store.safe(u.searchParams.get('session'));
    const token = u.searchParams.get('token') || '';
    const s = sid ? await store.loadSession(sid) : null;
    if (!s) return null;
    const paired = token && token === s.pair?.token;
    if (!paired && !this.isAuthed(req)) return null;
    return { session: s, paired };
  }
  room(id) { let r = this.rooms.get(id); if (!r) this.rooms.set(id, (r = { devices: new Map(), armed: null })); return r; }
  connect(ws, { session }) {
    const sid = session.id, room = this.room(sid);
    let me = null;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; if (me) me.lastSeen = Date.now(); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      this.handle(ws, sid, room, m, (d) => { me = d; }, () => me).catch((e) => this.send(ws, { t: 'error', msg: e.message }));
    });
    ws.on('close', () => {
      if (me && room.devices.get(me.role)?.ws === ws) { me.online = false; me.ws = null; me.lastSeen = Date.now(); this.presence(sid); }
    });
  }
  send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
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
      const prev = room.devices.get(role);
      if (prev?.online && prev.ws !== ws && prev.deviceId !== m.deviceId) this.send(prev.ws, { t: 'replaced', role });   // the newest device takes the role
      if (prev?.ws && prev.ws !== ws) { try { prev.ws.close(4000, 'replaced'); } catch {} }
      const d = { role, ws, deviceId: String(m.deviceId || '').slice(0, 64), device: m.device || null, state: prev?.deviceId === m.deviceId ? prev.state : null, online: true, lastSeen: now };
      room.devices.set(role, d);
      setMe(d);
      await store.updateSession(sid, (s) => { s.devices[role] = { deviceId: d.deviceId, device: d.device, lastSeen: new Date().toISOString() }; });
      const s = await store.loadSession(sid);
      this.send(ws, { t: 'welcome', you: role, now, session: publicSession(s), armed: room.armed });
      return this.presence(sid);
    }
    const me = getMe();
    if (!me) return this.send(ws, { t: 'error', msg: 'say hello first' });
    me.lastSeen = now; me.online = true;
    switch (m.t) {
      case 'state': me.state = { ...(m.state || {}), at: now }; return this.presence(sid);
      case 'arm': {                                           // director: the next take is this animation (the take is created by the REST call)
        if (me.role !== 'director') return;
        room.armed = m.take ? { takeId: m.take.id, kind: m.take.kind, animId: m.take.animId || null, setup: m.take.courtSetup, takeNo: m.take.takeNo, title: m.take.title || null, subtitle: m.take.subtitle || null, targetDurationSec: m.take.targetDurationSec || null } : null;
        this.broadcast(sid, { t: 'armed', armed: room.armed });
        return this.presence(sid);
      }
      case 'start': {
        if (me.role !== 'director' || !room.armed || room.armed.takeId !== m.takeId) return this.send(ws, { t: 'error', msg: 'nothing armed' });
        const at = now + START_LEAD_MS;
        room.armed.recording = true; room.armed.at = at;
        await store.updateRecording(sid, m.takeId, (r) => { r.state = 'recording'; r.sync.startAtServerMs = at; r.sync.leadMs = START_LEAD_MS; r.sync.commandAtServerMs = now; });
        this.broadcast(sid, { t: 'record', takeId: m.takeId, at });
        return this.presence(sid);
      }
      case 'stop': {
        if (me.role !== 'director' || !room.armed || room.armed.takeId !== m.takeId) return;
        const at = now + HALT_LEAD_MS;
        room.armed.recording = false; room.armed.stoppedAt = at;
        await store.updateRecording(sid, m.takeId, (r) => { r.state = 'uploading'; r.sync.stopAtServerMs = at; });
        this.broadcast(sid, { t: 'halt', takeId: m.takeId, at });
        return this.presence(sid);
      }
      case 'relay':                                           // director → cameras (e.g. "store your calibration reference now")
        if (me.role !== 'director' || !m.msg || typeof m.msg.t !== 'string') return;
        this.broadcast(sid, { ...m.msg, from: 'director' }, { roles: ['camA', 'camB'] });
        return;
      case 'chirp':                                           // the director played the sync chirp at server time m.at
        if (me.role !== 'director') return;
        await store.updateRecording(sid, m.takeId, (r) => { r.sync.chirp = { atServerMs: m.at, ...(m.chirp || {}), playedBy: 'director', uncertaintyMs: m.uncertaintyMs ?? null }; });
        return;
      case 'moved': {                                         // a camera moved since calibration
        const setup = m.setup;
        if (!setup) return;
        await store.updateSession(sid, (s) => { const c = s.calibrations[setup]; if (c && c.status === 'valid') { c.status = 'suspect'; c.suspectReason = `${me.role}: ${String(m.reason || 'moved').slice(0, 120)}`; c.suspectAt = new Date().toISOString(); } });
        this.broadcast(sid, { t: 'calibration', setup, status: 'suspect', reason: `${me.role}: ${m.reason || 'moved'}` });
        return;
      }
      default: return;
    }
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

module.exports = { Hub, publicSession, START_LEAD_MS };
