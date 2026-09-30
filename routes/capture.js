/**
 * Soul Jam Capture — REST API (the real-time side is lib/capture/hub.js, at /api/capture/ws).
 *
 *   GET  /api/capture/libraries                         the capture libraries (BASIC-01 …)
 *   GET  /api/capture/sessions                          sessions with progress
 *   POST /api/capture/sessions {libraryId, name}        new session
 *   GET  /api/capture/sessions/:sid                     the session (+ progress, next missing)
 *   GET  /api/capture/sessions/:sid/pair                pairing: code, camera URLs, QR (director)
 *   POST /api/capture/pair {code}                       a camera joins with the 6-digit code → session + token
 *   POST /api/capture/sessions/:sid/setup {setup}       the cameras are placed for this setup
 *   POST /api/capture/sessions/:sid/takes {animId}      arm a take of an animation
 *   POST /api/capture/sessions/:sid/calibrations {setup} arm a calibration recording
 *   PUT  /api/capture/sessions/:sid/rec/:rid/:cam/chunk/:seq   upload one chunk (camera; idempotent)
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/status       chunks the server has (resume)
 *   POST /api/capture/sessions/:sid/rec/:rid/:cam/complete     all chunks sent + the camera's metadata
 *   GET  /api/capture/sessions/:sid/rec/:rid                   the take / calibration record
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/video        the recording (Range)
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/still.jpg    a still (calibration landmarks)
 *   POST /api/capture/sessions/:sid/rec/:rid/accept {force}    accept (+ select) → SAVED
 *   POST /api/capture/sessions/:sid/rec/:rid/reject            retake (footage kept)
 *   POST /api/capture/sessions/:sid/rec/:rid/select            mark best
 *   POST /api/capture/sessions/:sid/rec/:rid/landmarks {cam, points}   calibration landmarks
 *   POST /api/capture/sessions/:sid/animations/:aid/skip {skipped}     skip / unskip an animation
 *   GET  /api/capture/sessions/:sid/export.tar                 the organised dataset
 *   GET  /api/capture/processors                               processing back-ends (SAM 3D Body …)
 *   POST /api/capture/sessions/:sid/rec/:rid/process {processor, cam, fps, maxFrames, confirmCostUsd}
 *
 * Camera devices only hold the session's pairing token (X-Capture-Token): they may upload chunks,
 * complete their upload and read the session — nothing else.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../lib/capture/store');
const cloud = require('../lib/capture/cloud');
const media = require('../lib/capture/media');
const validators = require('../lib/capture/validators');
const processing = require('../lib/capture/processing');
const auth = require('../middleware/auth');

let libs = null;
const libraries = () => (libs ||= Promise.all([import('../capture/basic01.mjs'), import('../capture/protocol.mjs'), import('../capture/court-layout.mjs'), import('../capture/schema.mjs')])
  .then(([b, p, c, s]) => ({ LIBRARIES: b.LIBRARIES, P: p, C: c, S: s })));

const CAMS = ['camA', 'camB'];
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };

// pairing tokens known to this process (for the auth gate's synchronous check)
const tokens = new Map();                         // token → sessionId
async function loadTokens() { for (const s of await store.listSessions().catch(() => [])) if (s.pair?.token) tokens.set(s.pair.token, s.id); }

function register(router, { json, parseBody, TMP_DIR, PORT }, hubRef) {
  loadTokens().catch(() => {});
  // camera API calls with a valid pairing token for THEIR session pass the password gate
  auth.allowCapture((req, pathname) => {
    const tok = req.headers['x-capture-token'];
    const m = pathname.match(/^\/api\/capture\/sessions\/([A-Za-z0-9_-]+)(\/rec\/[A-Za-z0-9_-]+\/cam[AB]\/(chunk\/\d+|status|complete))?$/);
    return !!(tok && m && tokens.get(tok) === m[1] && (m[2] || req.method === 'GET'));
  });
  const hub = () => hubRef.hub;
  const err = (res, e) => json(res, { error: e.message, ...(e.missing ? { missing: e.missing } : {}) }, e.status || 500);
  const isDirector = (req) => !auth.enabled() || auth.isAuthed(req);
  const needDirector = (req, res) => { if (isDirector(req)) return false; json(res, { error: 'director only — sign in' }, 403); return true; };
  const libOf = async (s) => { const L = (await libraries()).LIBRARIES[s.libraryId]; if (!L) throw Object.assign(new Error(`unknown library ${s.libraryId}`), { status: 400 }); return L; };
  // ── libraries + sessions
  router.get('/api/capture/libraries', async (req, res) => {
    const { LIBRARIES, C, S, P } = await libraries();
    json(res, { schemaVersion: S.SCHEMA_VERSION, protocolVersion: P.PROTOCOL_VERSION, libraries: Object.values(LIBRARIES).map((l) => ({ id: l.id, name: l.name, count: l.animations.length, description: l.description })), setups: C.SETUPS, court: C.COURT, states: S.STATES });
  });
  router.get('/api/capture/sessions', async (req, res) => {
    if (needDirector(req, res)) return;
    const { P } = await libraries();
    const out = [];
    for (const s of await store.listSessions()) {
      const L = (await libraries()).LIBRARIES[s.libraryId]; if (!L) continue;
      const pr = P.progress(L, s);
      out.push({ id: s.id, name: s.name, libraryId: s.libraryId, createdAt: s.createdAt, updatedAt: s.updatedAt, total: pr.total, complete: pr.complete, missing: pr.missing, perSetup: pr.perSetup, next: pr.next ? { id: pr.next.id, key: pr.next.key, title: pr.next.title, subtitle: pr.next.subtitle, courtSetup: pr.next.courtSetup } : null });
    }
    json(res, { sessions: out, cloud: cloud.available() });
  });
  router.post('/api/capture/sessions', async (req, res) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const libraryId = body.libraryId || 'BASIC-01';
      if (!(await libraries()).LIBRARIES[libraryId]) return json(res, { error: `unknown library ${libraryId}` }, 400);
      const s = await store.createSession({ libraryId, name: String(body.name || '').slice(0, 80) || `${libraryId} · ${new Date().toISOString().slice(0, 10)}` });
      tokens.set(s.pair.token, s.id);
      const { P } = await libraries();
      json(res, { session: s, progress: P.progress(await libOf(s), s) });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid', async (req, res, p) => {
    try {
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const { P } = await libraries(), L = await libOf(s);
      const director = isDirector(req);
      json(res, { session: { ...s, pair: director ? s.pair : { code: s.pair.code } }, progress: P.progress(L, s), director });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/pair', async (req, res, p) => {
    if (needDirector(req, res)) return;
    const s = await store.loadSession(p.sid);
    if (!s) return json(res, { error: 'session not found' }, 404);
    const urls = cameraUrls(req, s, PORT);
    const QR = require('qrcode');
    const qr = await QR.toString(urls[0].url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    json(res, { code: s.pair.code, urls, qrSvg: qr, https: !!global.__captureLan });
  });
  // a camera types the 6-digit code (rate limited)
  const tries = new Map();
  router.post('/api/capture/pair', async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 60000);
    t.push(now); tries.set(ip, t);
    if (t.length > 12) return json(res, { error: 'too many attempts — wait a minute' }, 429);
    const body = await parseBody(req);
    const code = String(body.code || '').replace(/\D/g, '');
    const tok = typeof body.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.token) ? body.token : null;
    const s = tok ? await store.findSessionByPair(tok) : code.length === 6 ? await store.findSessionByPair(code) : null;
    if (!s) return json(res, { error: 'no session with that code' }, 404);
    tokens.set(s.pair.token, s.id);
    json(res, { sessionId: s.id, token: s.pair.token, name: s.name });
  });
  router.post('/api/capture/sessions/:sid/setup', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const s = await store.updateSession(p.sid, (s) => {
        if (!['A', 'B', 'C'].includes(body.setup)) return;
        s.currentSetup = body.setup;
        // cameras placed without a calibration recording (can be calibrated later; a moved camera still flags it)
        if (body.skipCalibration && (!s.calibrations[body.setup] || s.calibrations[body.setup].status !== 'valid')) s.calibrations[body.setup] = { ...(s.calibrations[body.setup] || { takes: [], current: null }), status: 'skipped', skippedAt: new Date().toISOString() };
      });
      hub()?.broadcast(s.id, { t: 'session', session: { ...s, pair: { code: s.pair.code } } });
      json(res, { session: s });
    } catch (e) { err(res, e); }
  });

  // ── arm a take / a calibration
  router.post('/api/capture/sessions/:sid/takes', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const L = await libOf(s);
      const anim = L.animations.find((a) => a.id === body.animId);
      if (!anim) return json(res, { error: `no animation ${body.animId}` }, 400);
      const cal = s.calibrations?.[anim.courtSetup];
      const rec = await store.createRecording(s.id, { kind: 'take', anim, setup: anim.courtSetup, calibrationId: cal?.current || null, library: { id: L.id, version: L.version } });
      armBroadcast(s.id, rec);
      json(res, { take: rec });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/calibrations', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      if (!['A', 'B', 'C'].includes(body.setup)) return json(res, { error: 'setup must be A, B or C' }, 400);
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const L = await libOf(s);
      const rec = await store.createRecording(s.id, { kind: 'calibration', setup: body.setup, library: { id: L.id, version: L.version } });
      armBroadcast(s.id, { ...rec, title: `CALIBRATION ${body.setup}`, subtitle: 'court landmarks · 10 s', targetDurationSec: 10 });
      json(res, { calibration: rec });
    } catch (e) { err(res, e); }
  });
  function armBroadcast(sid, rec) {
    const h = hub(); if (!h) return;
    const r = h.room(sid);
    r.armed = { takeId: rec.id, kind: rec.kind, animId: rec.animId || null, setup: rec.courtSetup, takeNo: rec.takeNo, title: rec.title || null, subtitle: rec.subtitle || null, targetDurationSec: rec.targetDurationSec || null };
    h.broadcast(sid, { t: 'armed', armed: r.armed });
    h.presence(sid);
  }

  // ── uploads (cameras)
  const recOr404 = async (res, sid, rid) => { const r = await store.loadRecording(sid, rid); if (!r) json(res, { error: 'take not found' }, 404); return r; };
  router.put('/api/capture/sessions/:sid/rec/:rid/:cam/chunk/:seq', async (req, res, p) => {
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (rec.cameras?.[p.cam]?.file) return json(res, { ok: true, already: true });
      const out = await store.putChunk(p.sid, rec, p.cam, +p.seq, req);
      json(res, { ok: true, ...out });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/rec/:rid/:cam/status', async (req, res, p) => {
    const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
    json(res, await store.chunkStatus(p.sid, rec, p.cam));
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/:cam/complete', async (req, res, p) => {
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const body = await parseBody(req);
      let rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (!rec.cameras?.[p.cam]?.file) {
        const mime = String(body.mimeType || '').split(';')[0];
        const ext = EXT[mime] || 'webm';
        const a = await store.assemble(p.sid, rec, p.cam, { chunks: +body.chunks, ext });
        const fr = Array.isArray(body.frames) ? body.frames.filter(Number.isFinite).slice(0, 200000) : [];
        const framesFile = `${p.cam}.frames.json`;
        await store.writeJsonAtomic(store.recordingPath(p.sid, rec, framesFile), { schema: 'souljam.capture.frames/1', cam: p.cam, clock: 'server ms', note: 'capture time of each frame the device saw (requestVideoFrameCallback), mapped to the session clock', frames: fr, mediaTimes: Array.isArray(body.mediaTimes) ? body.mediaTimes.slice(0, 200000) : [] });
        rec = await store.updateRecording(p.sid, p.rid, (r) => {
          r.cameras[p.cam] = { ...(body.meta || {}), role: p.cam, file: a.name, bytes: a.bytes, mimeType: body.mimeType || null, framesFile, upload: { chunks: +body.chunks, completedAt: new Date().toISOString() } };
        });
        hub()?.takeUpdate(p.sid, rec, { event: 'uploaded', cam: p.cam });
      }
      json(res, { ok: true, take: rec });
      // both cameras in (or the only one the session records) → validate → review
      maybeFinish(p.sid, p.rid).catch((e) => console.error('[capture] finish', e));
    } catch (e) { err(res, e); }
  });

  const expectedCams = async (sid, rec) => {
    const s = await store.loadSession(sid);
    const h = hub()?.rooms.get(sid);
    // the cameras that were online when it was armed; at least the ones that uploaded
    const want = s?.singleCamera ? ['camA'] : CAMS;
    return want.filter((c) => rec.cameras?.[c] || (h?.devices.get(c)?.online ?? true));
  };
  async function maybeFinish(sid, rid) {
    const rec = await store.loadRecording(sid, rid);
    if (!rec || ['review', 'accepted', 'rejected', 'validating'].includes(rec.state)) return;
    const cams = await expectedCams(sid, rec);
    if (!cams.every((c) => rec.cameras?.[c]?.file)) return;
    await store.updateRecording(sid, rid, (r) => { r.state = 'validating'; });
    hub()?.takeUpdate(sid, { ...rec, state: 'validating' });
    const files = {};
    for (const c of cams) files[c] = store.recordingPath(sid, rec, rec.cameras[c].file);
    const r2 = await store.updateRecording(sid, rid, async (r) => {
      r.validation = await validators.validate(r, files, { cams });
      r.state = 'review';
      r.cams = cams;
    });
    hub()?.takeUpdate(sid, r2, { event: 'review' });
  }

  // native high-frame-rate path: a 120 / 240 fps file recorded by the phone's camera app for this take
  router.put('/api/capture/sessions/:sid/rec/:rid/:cam/native', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const ext = (String(req.headers['x-filename'] || 'native.mov').match(/\.(mov|mp4|m4v|webm|mkv)$/i)?.[1] || 'mov').toLowerCase();
      const name = `${p.cam}.native.${ext}`, abs = store.recordingPath(p.sid, rec, name);
      await new Promise((resolve, reject) => { const ws = fs.createWriteStream(abs + '.tmp'); req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); });
      fs.renameSync(abs + '.tmp', abs);
      const info = await media.probe(abs);
      // where is the take's sync chirp in the native file? (it heard the same chirp as the web recording)
      const SA = require('../lib/capture/sync-audio');
      const x = await SA.pcm(abs).catch(() => null);
      const chirp = x ? SA.findChirp(x) : null;
      const updated = await store.updateRecording(p.sid, p.rid, (r) => {
        (r.cameras[p.cam] ||= { role: p.cam }).native = { file: name, bytes: fs.statSync(abs).size, source: 'native-import', probe: info, chirp, importedAt: new Date().toISOString(), note: 'recorded by the phone\'s own camera app (true high frame rate); aligned to the take by the sync chirp' };
      });
      await store.mirror(abs);
      json(res, { take: updated });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/rec/:rid', async (req, res, p) => {
    const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
    json(res, { take: rec });
  });
  router.get('/api/capture/sessions/:sid/rec/:rid/:cam/video', async (req, res, p) => {
    const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
    const c = rec.cameras?.[p.cam];
    if (!c?.file) return json(res, { error: 'no recording yet' }, 404);
    const abs = store.recordingPath(p.sid, rec, c.file);
    if (!fs.existsSync(abs)) await cloud.ensureLocal(abs, store.cloudKey(abs)).catch(() => null);
    if (!fs.existsSync(abs)) return json(res, { error: 'file missing' }, 404);
    serveRange(req, res, abs, cloud.contentType(abs));
  });
  router.get('/api/capture/sessions/:sid/rec/:rid/:cam/still.jpg', async (req, res, p, q) => {
    const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
    const c = rec.cameras?.[p.cam];
    if (!c?.file) return json(res, { error: 'no recording yet' }, 404);
    try {
      const buf = await media.still(store.recordingPath(p.sid, rec, c.file), Math.max(0, +(q.t ?? 1)));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' }); res.end(buf);
    } catch (e) { err(res, e); }
  });

  // ── review: accept / retake / mark best / skip
  router.post('/api/capture/sessions/:sid/rec/:rid/accept', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (rec.state !== 'review' && rec.state !== 'accepted') return json(res, { error: `the take is ${rec.state} — wait for the upload + checks` }, 409);
      if (!rec.validation?.ok && !body.force) return json(res, { error: 'the checks failed — accept anyway with force', validation: rec.validation }, 409);
      // persist (and mirror) the files first; "saved" only after all of it
      const dir = store.recDir(p.sid, rec.kind, rec.id);
      const saved = await store.updateRecording(p.sid, p.rid, (r) => { r.state = 'accepted'; r.accepted = true; r.acceptedAt = new Date().toISOString(); r.forced = !!body.force && !rec.validation?.ok; });
      const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !f.endsWith('.tmp'));
      for (const f of files) await store.mirror(path.join(dir, f));
      const s = await store.updateSession(p.sid, (s) => {
        if (rec.kind === 'calibration') {
          const c = (s.calibrations[rec.courtSetup] ||= { takes: [], current: null });
          c.current = rec.id; c.status = 'valid'; c.acceptedAt = new Date().toISOString(); delete c.suspectReason;
          s.currentSetup = rec.courtSetup;
        } else {
          const e = (s.animations[rec.animId] ||= { takes: [rec.id], selectedTake: null });
          if (!e.selectedTake || body.select !== false) e.selectedTake = rec.id;
          e.skipped = false;
          s.currentSetup = rec.courtSetup;
        }
      });
      if (rec.kind === 'take' && s.animations[rec.animId].selectedTake === rec.id) await store.updateRecording(p.sid, p.rid, (r) => { r.selected = true; });
      hub()?.disarm(p.sid, p.rid);
      hub()?.takeUpdate(p.sid, saved, { event: 'saved' });
      hub()?.broadcast(p.sid, { t: 'session', session: { ...s, pair: { code: s.pair.code } } });
      const { P } = await libraries(), L = await libOf(s);
      json(res, { saved: true, cloud: cloud.available(), take: saved, progress: P.progress(L, s, { after: rec.animId || null }) });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/reject', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const r = await store.updateRecording(p.sid, p.rid, (r) => { if (r.state !== 'accepted') { r.state = 'rejected'; r.rejectedAt = new Date().toISOString(); } });
      hub()?.disarm(p.sid, p.rid);
      hub()?.takeUpdate(p.sid, r, { event: 'rejected' });
      json(res, { take: r });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/select', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (!rec.accepted) return json(res, { error: 'only an accepted take can be the selected one' }, 409);
      const s = await store.updateSession(p.sid, (s) => { s.animations[rec.animId].selectedTake = rec.id; });
      for (const tid of s.animations[rec.animId].takes) await store.updateRecording(p.sid, tid, (r) => { r.selected = tid === rec.id; }).catch(() => {});
      hub()?.broadcast(p.sid, { t: 'session', session: { ...s, pair: { code: s.pair.code } } });
      json(res, { session: s });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/landmarks', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      if (!CAMS.includes(body.cam)) return json(res, { error: 'cam must be camA or camB' }, 400);
      const { C } = await libraries();
      const pts = {};
      for (const [k, v] of Object.entries(body.points || {})) if (C.COURT.landmarks[k] && Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) pts[k] = v;
      const r = await store.updateRecording(p.sid, p.rid, (r) => { (r.landmarks ||= {})[body.cam] = { image: pts, world: Object.fromEntries(Object.keys(pts).map((k) => [k, C.COURT.landmarks[k]])), units: 'normalised image coords (0–1) ↔ court metres', at: new Date().toISOString() }; });
      json(res, { calibration: r });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/animations/:aid/skip', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const s = await store.updateSession(p.sid, (s) => { (s.animations[p.aid] ||= { takes: [], selectedTake: null }).skipped = body.skipped !== false; });
      json(res, { session: s });
    } catch (e) { err(res, e); }
  });

  // ── export: SoulJam_BASIC01/session.json · calibration/setup_A/cal01/… · setup_A/cross_RL/take01/…
  router.get('/api/capture/sessions/:sid/export.tar', async (req, res, p, q) => {
    if (needDirector(req, res)) return;
    try {
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const { P, C, S } = await libraries(), L = await libOf(s);
      const all = q.all === '1';                          // every take, not only accepted ones
      const root = `SoulJam_${L.id.replace(/[^A-Za-z0-9]/g, '')}`;
      const entries = [], takesIndex = [];
      const addRec = async (rec, folder) => {
        const dir = store.recDir(s.id, rec.kind, rec.id);
        for (const cam of CAMS) {
          const c = rec.cameras?.[cam]; if (!c?.file) continue;
          const abs = path.join(dir, c.file);
          if (!fs.existsSync(abs)) await cloud.ensureLocal(abs, store.cloudKey(abs)).catch(() => null);
          if (fs.existsSync(abs)) entries.push({ name: `${root}/${folder}/${cam}${path.extname(c.file)}`, file: abs });
          if (c.native?.file) { const n = path.join(dir, c.native.file); if (!fs.existsSync(n)) await cloud.ensureLocal(n, store.cloudKey(n)).catch(() => null); if (fs.existsSync(n)) entries.push({ name: `${root}/${folder}/${cam}.native${path.extname(c.native.file)}`, file: n }); }
          const fr = path.join(dir, c.framesFile || `${cam}.frames.json`);
          if (fs.existsSync(fr)) entries.push({ name: `${root}/${folder}/${cam}.frames.json`, file: fr });
        }
        entries.push({ name: `${root}/${folder}/metadata.json`, data: { ...rec, exportFolder: folder } });
      };
      for (const [setup, c] of Object.entries(s.calibrations || {})) {
        for (const [i, id] of (c.takes || []).entries()) {
          const rec = await store.loadRecording(s.id, id, 'calibration'); if (!rec || (!all && !rec.accepted)) continue;
          await addRec(rec, `calibration/setup_${setup}/cal${String(i + 1).padStart(2, '0')}`);
        }
      }
      for (const a of P.captureOrder(L)) {
        const e = s.animations[a.id]; if (!e) continue;
        for (const id of e.takes) {
          const rec = await store.loadRecording(s.id, id, 'take'); if (!rec || (!all && !rec.accepted)) continue;
          const folder = P.takeFolder(a, rec.takeNo);
          await addRec(rec, folder);
          takesIndex.push({ animId: a.id, key: a.key, folder, takeId: rec.id, takeNo: rec.takeNo, accepted: rec.accepted, selected: e.selectedTake === rec.id });
        }
      }
      const sessionJson = {
        schema: 'souljam.capture.export/1', exportedAt: new Date().toISOString(), session: { ...s, pair: undefined },
        library: L, states: S.STATES, court: C.COURT, setups: C.SETUPS, captureOrder: P.captureOrder(L).map((a) => a.id),
        progress: P.progress(L, s), takes: takesIndex,
        conventions: { clock: 'all *AtServerMs / frames.json times: the session server clock (ms since epoch); per camera clock.offsetMs = server − device', court: C.COURT.frame, holds: 'one-shot takes include ~1 s start and end holds (capture handles, not part of the game clip)' },
      };
      entries.unshift({ name: `${root}/session.json`, data: sessionJson });
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="${root}.tar"`, 'Cache-Control': 'no-store' });
      await store.streamTar(res, entries);
      res.end();
    } catch (e) { if (!res.headersSent) err(res, e); else res.destroy(e); }
  });

  // ── processing (pluggable; SAM 3D Body through the existing mocap pipeline)
  router.get('/api/capture/processors', async (req, res) => json(res, { processors: processing.list() }));
  router.post('/api/capture/sessions/:sid/rec/:rid/process', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const body = await parseBody(req);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const job = await processing.start(body.processor || 'sam3dbody', { sessionId: p.sid, take: rec, cam: body.cam || 'camA', fps: body.fps, maxFrames: body.maxFrames, start: body.start, end: body.end, confirmCostUsd: body.confirmCostUsd, TMP_DIR, role: body.role });
      json(res, { job });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/jobs/:jid', async (req, res, p) => {
    if (needDirector(req, res)) return;
    const j = processing.job(p.jid);
    if (!j) return json(res, { error: 'no such job' }, 404);
    json(res, { job: j });
  });
}

function serveRange(req, res, abs, type) {
  const size = fs.statSync(abs).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (!(start >= 0 && start <= end)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(abs).pipe(res);
  }
}

/** The URLs a camera can join by: the LAN HTTPS listener (phones need HTTPS for the camera) and this origin. */
function cameraUrls(req, s, PORT) {
  const out = [];
  const lan = global.__captureLan;
  if (lan) for (const ip of lan.ips) out.push({ url: `https://${ip}:${lan.port}/capture?pair=${s.pair.token}`, kind: 'lan-https' });
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const here = `${proto}://${host}/capture?pair=${s.pair.token}`;
  if (!out.some((u) => u.url === here)) out.push({ url: here, kind: proto === 'https' || /^localhost|^127\./.test(host || '') ? 'this-origin' : 'this-origin-http (cameras need HTTPS)' });
  // the same-origin one first when the director itself is on HTTPS (Railway, the LAN listener)
  if (proto === 'https') out.sort((a, b) => (a.url === here ? -1 : b.url === here ? 1 : 0));
  return out;
}

module.exports = { register, cameraUrls, lanIps: () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) };
