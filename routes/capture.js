/**
 * Soul Jam Capture — REST API (the real-time side is lib/capture/hub.js, at /api/capture/ws).
 *
 *   GET  /api/capture/libraries                         the capture libraries (BASIC-01 …)
 *   GET  /api/capture/sessions                          sessions with progress
 *   POST /api/capture/sessions {libraryId, name}        new session
 *   GET  /api/capture/sessions/:sid                     the session (+ progress, next missing)
 *   GET  /api/capture/sessions/:sid/pair                pairing: a live code, camera URLs, QR (director)
 *   POST /api/capture/pair {code | token}               a camera joins (QR token, or the 6-digit code) → session + token
 *   POST /api/capture/sessions/:sid/setup {setup}       the cameras are placed for this setup
 *   POST /api/capture/sessions/:sid/takes {animId}      arm a take of an animation
 *   POST /api/capture/sessions/:sid/calibrations {setup} arm a calibration recording
 *   POST /api/capture/sessions/:sid/checks              arm a camera check (2 s test recording, never a take)
 *   PUT  /api/capture/sessions/:sid/rec/:rid/:cam/chunk/:seq   upload one chunk (camera; idempotent)
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/status       chunks the server has (resume)
 *   POST /api/capture/sessions/:sid/rec/:rid/:cam/complete     all chunks sent + the camera's metadata
 *   GET  /api/capture/sessions/:sid/rec/:rid                   the take / calibration record
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/video        the recording (Range)
 *   GET  /api/capture/sessions/:sid/rec/:rid/:cam/still.jpg    a still (calibration landmarks)
 *   POST /api/capture/sessions/:sid/rec/:rid/finish {cams}     go on with the cameras that uploaded (one stayed away)
 *   POST /api/capture/sessions/:sid/rec/:rid/accept {force}    accept (+ select) → SAVED (the server does this by itself
 *                                                              once a take's uploads are in and no camera failed)
 *   POST /api/capture/sessions/:sid/rec/:rid/reject            discard a take (footage kept)
 *   POST /api/capture/sessions/:sid/rec/:rid/select            mark best
 *   POST /api/capture/sessions/:sid/rec/:rid/landmarks {cam, points}   calibration landmarks
 *   PUT|GET /api/capture/sessions/:sid/calref/:setup/:cam      a camera's calibration reference view (moved-camera check)
 *   POST /api/capture/sessions/:sid/animations/:aid/skip {skipped}     skip / unskip an animation
 *   GET  /api/capture/sessions/:sid/export.tar                 the organised dataset
 *   GET  /api/capture/processors                               processing back-ends (SAM 3D Body …)
 *   POST /api/capture/sessions/:sid/rec/:rid/process {processor, cam, fps, maxFrames, confirmCostUsd}
 *   POST /api/capture/sessions/:sid/process-batch {takes, cam, fps, confirmCostUsd}   queue takes for analysis
 *                                                              (no confirmCostUsd → 402 with the quote, nothing queued)
 *   GET  /api/capture/sessions/:sid/analysis                   the analysis queue + live progress
 *
 * A take moves on by itself (nobody reviews it): RECORD → the cameras upload → the checks run →
 * SAVED and selected (the newest recorded take of its animation), or "needs redo" when a camera
 * produced no decodable video. A calibration the same (saved → the cameras keep their reference
 * view). A camera check never becomes a take: its verdict goes to session.cameraChecks.
 *
 * Camera devices only hold the session's pairing token (X-Capture-Token): they may upload chunks,
 * complete their upload, keep their calibration reference and read the session — nothing else.
 *
 * Durability (Railway's disk does not survive a deploy): every record write is mirrored to the
 * bucket (lib/capture/store.js), and a camera's recording is mirrored before its upload is
 * confirmed — the phone keeps its copy of the chunks until then.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('../lib/capture/store');
const cloud = require('../lib/capture/cloud');
const media = require('../lib/capture/media');
const validators = require('../lib/capture/validators');
const processing = require('../lib/capture/processing');
const analysis = require('../lib/capture/analysis');
const auth = require('../middleware/auth');

let libs = null;
const libraries = () => (libs ||= Promise.all([import('../capture/basic01.mjs'), import('../capture/protocol.mjs'), import('../capture/court-layout.mjs'), import('../capture/schema.mjs')])
  .then(([b, p, c, s]) => ({ LIBRARIES: b.LIBRARIES, P: p, C: c, S: s })));

const CAMS = ['camA', 'camB'];
const SETUPS = ['A', 'B', 'C'];
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };
const MAX_NATIVE_BYTES = 2 * 1024 ** 3;

/** A JSON body, at most `max` bytes (the pairing endpoint is open to anyone). */
function body(req, max = 256 << 10) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > max) { over = true; req.destroy(); reject(Object.assign(new Error('request too large'), { status: 413 })); } else chunks.push(c); });
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
/** A file name inside a take's folder (never a path). */
const plainName = (f) => typeof f === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(f) && !f.startsWith('.');
/** What a camera may say about its recording (anything else, e.g. file names, is the server's). */
const CAMERA_META = ['deviceId', 'device', 'track', 'capabilities', 'recorder', 'source', 'clock', 'startedAtServerMs', 'stoppedAtServerMs', 'commandAtServerMs', 'frames', 'streamedChunks', 'stopReconciled', 'stopCapped', 'interrupted', 'recoveredAt', 'storageError', 'recError', 'recWarn'];
function cameraMeta(m) {
  const out = {};
  if (m && typeof m === 'object') for (const k of CAMERA_META) if (m[k] !== undefined) out[k] = m[k];
  return JSON.stringify(out).length < 64 << 10 ? out : { note: 'camera metadata too large — dropped' };
}
/** The client address Railway saw: the right-most X-Forwarded-For hop (the left ones are the client's to write). */
const clientIp = (req) => String((req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();

function register(router, { json, TMP_DIR, PORT }, hubRef) {
  // camera API calls with their session's pairing token pass the password gate (checked against
  // the stored session every time — a restart or a new container knows every token)
  auth.allowCapture(async (req, pathname) => {
    const tok = req.headers['x-capture-token'];
    const m = pathname.match(/^\/api\/capture\/sessions\/([A-Za-z0-9_-]+)(\/rec\/[A-Za-z0-9_-]+\/cam[AB]\/(chunk\/\d+|status|complete)|\/calref\/[ABC]\/cam[AB])?$/);
    if (!tok || !m || !(m[2] || req.method === 'GET')) return false;
    const s = await store.loadSession(m[1]).catch(() => null);
    return !!s && store.sameSecret(s.pair?.token, tok);
  });
  const hub = () => hubRef.hub;
  hubRef.onStop = (sid, rid) => maybeFinish(sid, rid).catch((e) => console.error('[capture] finish', e.message));
  const err = (res, e) => { if (res.headersSent) return res.destroy(); json(res, { error: e.message, ...(e.missing ? { missing: e.missing } : {}) }, e.status || 500); };
  const isDirector = (req) => !auth.enabled() || auth.isAuthed(req);
  const needDirector = (req, res) => { if (isDirector(req)) return false; json(res, { error: 'director only — sign in', login: '/login' }, 401); return true; };
  const libOf = async (s) => { const L = (await libraries()).LIBRARIES[s.libraryId]; if (!L) throw Object.assign(new Error(`unknown library ${s.libraryId}`), { status: 400 }); return L; };
  const forCameras = (s) => ({ ...s, pair: { code: s.pair?.code } });
  /** A file the record points at, on this disk (fetched from the bucket after a redeploy). */
  const local = async (abs) => { if (!fs.existsSync(abs)) await cloud.ensureLocal(abs, store.cloudKey(abs)).catch(() => null); return fs.existsSync(abs) ? abs : null; };
  // analysis (SAM 3D Body) runs only when the director sends takes, one at a time, surviving restarts
  const queue = analysis.createQueue({ hub, local, TMP_DIR, anim: async (s, id) => (await libraries()).LIBRARIES[s?.libraryId]?.animations.find((a) => a.id === id) || null });
  hubRef.onBoot = () => { const t = setTimeout(() => queue.resumeAll().catch((e) => console.error('[capture] analysis resume', e.message)), 3000); t.unref?.(); };

  // ── libraries + sessions
  router.get('/api/capture/libraries', async (req, res) => {
    const { LIBRARIES, C, S, P } = await libraries();
    json(res, { schemaVersion: S.SCHEMA_VERSION, protocolVersion: P.PROTOCOL_VERSION, libraries: Object.values(LIBRARIES).map((l) => ({ id: l.id, name: l.name, count: l.animations.length, description: l.description })), setups: C.SETUPS, court: C.COURT, states: S.STATES });
  });
  router.get('/api/capture/sessions', async (req, res) => {
    if (needDirector(req, res)) return;
    try {
      const { P } = await libraries();
      const out = [];
      for (const s of await store.listSessions()) {
        const L = (await libraries()).LIBRARIES[s.libraryId]; if (!L) continue;
        const pr = P.progress(L, s);
        out.push({ id: s.id, name: s.name, libraryId: s.libraryId, createdAt: s.createdAt, updatedAt: s.updatedAt, total: pr.total, complete: pr.complete, missing: pr.missing, perSetup: pr.perSetup, next: pr.next ? { id: pr.next.id, key: pr.next.key, title: pr.next.title, subtitle: pr.next.subtitle, courtSetup: pr.next.courtSetup } : null });
      }
      json(res, { sessions: out, cloud: cloud.available() });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions', async (req, res) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const libraryId = b.libraryId || 'BASIC-01';
      if (!(await libraries()).LIBRARIES[libraryId]) return json(res, { error: `unknown library ${libraryId}` }, 400);
      const s = await store.createSession({ libraryId, name: String(b.name || '').slice(0, 80) || `${libraryId} · ${new Date().toISOString().slice(0, 10)}` });
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
      json(res, { session: director ? s : forCameras(s), progress: P.progress(L, s), director });
      // takes a restart (or a refused bucket write) left half-way are moved on; queued analysis resumes
      if (director) { settle(s.id); queue.touch(s.id, s); }
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/pair', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      if (!(await store.loadSession(p.sid))) return json(res, { error: 'session not found' }, 404);
      const s = await store.refreshPairCode(p.sid);           // the code is live for 15 minutes from here
      const urls = cameraUrls(req, s, PORT);
      const QR = require('qrcode');
      const qr = await QR.toString(urls[0].url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      json(res, { code: s.pair.code, codeExpiresAt: s.pair.codeExpiresAt, urls, qrSvg: qr, https: !!global.__captureLan });
    } catch (e) { err(res, e); }
  });
  // a camera joins: the QR's token, or the 6-digit code typed on the home page (rate limited; codes
  // expire 15 minutes after the director last opened the pair screen)
  const tries = new Map();                                // client → attempt times (last minute)
  let codeFails = [];                                     // failed code attempts, all clients (last minute)
  setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (!v.some((x) => now - x < 60000)) tries.delete(k); }, 60000).unref?.();
  router.post('/api/capture/pair', async (req, res) => {
    try {
      const now = Date.now(), ip = clientIp(req);
      const t = (tries.get(ip) || []).filter((x) => now - x < 60000);
      if (t.length >= 12) return json(res, { error: 'too many attempts — wait a minute' }, 429);
      t.push(now); tries.set(ip, t);
      const b = await body(req, 4096);
      const tok = typeof b.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(b.token) ? b.token : null;
      const code = String(b.code || '').replace(/\D/g, '');
      if (!tok) {
        codeFails = codeFails.filter((x) => now - x < 60000);
        if (codeFails.length >= 60) return json(res, { error: 'too many wrong codes right now — wait a minute, or scan the QR code' }, 429);
      }
      const s = tok ? await store.findSessionByToken(tok) : code.length === 6 ? await store.findSessionByCode(code) : null;
      if (!s) { if (!tok) codeFails.push(now); return json(res, { error: tok ? 'this pairing link is not valid' : 'no session with that code (codes expire — open "Pair camera" on the director for a fresh one)' }, 404); }
      json(res, { sessionId: s.id, token: s.pair.token, name: s.name });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/setup', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const s = await store.updateSession(p.sid, (s) => {
        if (!SETUPS.includes(b.setup)) return;
        s.currentSetup = b.setup;
        // cameras placed without a calibration recording (can be calibrated later; a moved camera still flags it)
        if (b.skipCalibration && (!s.calibrations[b.setup] || s.calibrations[b.setup].status !== 'valid')) s.calibrations[b.setup] = { ...(s.calibrations[b.setup] || { takes: [], current: null }), status: 'skipped', skippedAt: new Date().toISOString() };
      });
      hub()?.broadcast(s.id, { t: 'session', session: forCameras(s) });
      json(res, { session: s });
    } catch (e) { err(res, e); }
  });

  // ── arm a take / a calibration
  router.post('/api/capture/sessions/:sid/takes', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const L = await libOf(s);
      const anim = L.animations.find((a) => a.id === b.animId);
      if (!anim) return json(res, { error: `no animation ${b.animId}` }, 400);
      const cal = s.calibrations?.[anim.courtSetup];
      const rec = await store.createRecording(s.id, { kind: 'take', anim, setup: anim.courtSetup, calibrationId: cal?.current || null, library: { id: L.id, version: L.version } });
      armBroadcast(s.id, rec);
      json(res, { take: rec });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/calibrations', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      if (!SETUPS.includes(b.setup)) return json(res, { error: 'setup must be A, B or C' }, 400);
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const L = await libOf(s);
      const rec = await store.createRecording(s.id, { kind: 'calibration', setup: b.setup, library: { id: L.id, version: L.version } });
      armBroadcast(s.id, { ...rec, title: `CALIBRATION ${b.setup}`, subtitle: 'court landmarks · 10 s', targetDurationSec: 10 });
      json(res, { calibration: rec });
    } catch (e) { err(res, e); }
  });
  // a camera check: 2 s through the whole path (record → upload → decode here), never a take
  router.post('/api/capture/sessions/:sid/checks', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      await body(req, 4096);
      const s = await store.loadSession(p.sid);
      if (!s) return json(res, { error: 'session not found' }, 404);
      const L = await libOf(s);
      const rec = await store.createCheck(s.id, { library: { id: L.id, version: L.version } });
      armBroadcast(s.id, { ...rec, title: 'CAMERA CHECK', subtitle: '2 s test recording' });
      json(res, { check: rec });
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
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      json(res, await store.chunkStatus(p.sid, rec, p.cam));
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/:cam/complete', async (req, res, p) => {
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const b = await body(req, 16 << 20);
      // one completion per camera at a time (a retried request waits, then finds it done)
      const out = await store.withLock(`c:${p.sid}:${p.rid}:${p.cam}`, async () => {
        let rec = await store.loadRecording(p.sid, p.rid);
        if (!rec) return null;
        if (rec.cameras?.[p.cam]?.file) return { rec, fresh: false };
        const chunks = +b.chunks;
        if (!(Number.isInteger(chunks) && chunks >= 0 && chunks <= 2000)) throw Object.assign(new Error('bad chunk count'), { status: 400 });
        // chunks the phone lost (e.g. its storage was full for a second): the rest is still assembled
        const gaps = Array.isArray(b.gaps) ? [...new Set(b.gaps.filter((n) => Number.isInteger(n) && n >= 0 && n < chunks))].slice(0, 2000) : [];
        const mime = String(b.mimeType || '').split(';')[0];
        const a = await store.assemble(p.sid, rec, p.cam, { chunks, ext: EXT[mime] || 'webm', gaps });
        const fr = Array.isArray(b.frames) ? b.frames.filter(Number.isFinite).slice(0, 200000) : [];
        const framesFile = `${p.cam}.frames.json`, framesAbs = store.recordingPath(p.sid, rec, framesFile);
        await store.writeJsonAtomic(framesAbs, { schema: 'souljam.capture.frames/1', cam: p.cam, clock: 'server ms', note: 'capture time of each frame the device saw (requestVideoFrameCallback), mapped to the session clock', frames: fr, mediaTimes: Array.isArray(b.mediaTimes) ? b.mediaTimes.filter(Number.isFinite).slice(0, 200000) : [] });
        // durable BEFORE the record points at it, and before the phone hears "ok" and drops its copy
        await store.mirror(a.path);
        await store.mirror(framesAbs);
        const meta = cameraMeta(b.meta);
        rec = await store.updateRecording(p.sid, p.rid, (r) => {
          const prev = r.cameras[p.cam] || {};              // (a native high-fps file attached earlier stays)
          r.cameras[p.cam] = { ...meta, ...(prev.native ? { native: prev.native } : {}), role: p.cam, file: a.name, bytes: a.bytes, mimeType: b.mimeType || null, framesFile, mirrored: cloud.available(), upload: { chunks, ...(gaps.length ? { gaps } : {}), completedAt: new Date().toISOString() }, ...(r.accepted ? { arrivedAfterAccept: true } : {}) };
        });
        await store.dropChunks(p.sid, rec, p.cam);
        return { rec, fresh: true };
      });
      if (!out) return json(res, { error: 'take not found' }, 404);
      if (out.fresh) hub()?.takeUpdate(p.sid, out.rec, { event: 'uploaded', cam: p.cam });
      json(res, { ok: true, take: out.rec });
      // every camera the take waits for is in → the checks → saved (or needs redo)
      maybeFinish(p.sid, p.rid).catch((e) => console.error('[capture] finish', e.message));
    } catch (e) { err(res, e); }
  });

  /** The cameras a take waits for: the ones READY when it started (hub), else the ones that uploaded. */
  const expectedCams = (rec) => {
    if (Array.isArray(rec.expectedCams) && rec.expectedCams.length) return rec.expectedCams.filter((c) => CAMS.includes(c));
    const up = CAMS.filter((c) => rec.cameras?.[c]?.file);
    return up.length ? up : CAMS;
  };
  const checking = new Set();                            // takes being validated by THIS process
  function maybeFinish(sid, rid) {
    return store.withLock(`f:${sid}:${rid}`, async () => {
      const rec = await store.loadRecording(sid, rid);
      if (!rec || !['armed', 'recording', 'uploading', 'validating'].includes(rec.state)) return;
      // 'validating' left by an earlier process (a redeploy mid-check) is simply run again
      if (checking.has(`${sid}:${rid}`)) return;
      const cams = expectedCams(rec);
      if (!cams.every((c) => rec.cameras?.[c]?.file)) return;
      checking.add(`${sid}:${rid}`);
      try { await (rec.kind === 'check' ? finishCheck(sid, rid, rec, cams) : validateTake(sid, rid, rec, cams)); }
      finally { checking.delete(`${sid}:${rid}`); }
    });
  }
  /** The checks, then — nobody reviews — saved (and selected if newest), or "needs redo" when a camera produced no usable video. */
  async function validateTake(sid, rid, rec, cams) {
      const v = await store.updateRecording(sid, rid, (r) => { r.state = 'validating'; r.validatingAt = new Date().toISOString(); });
      hub()?.takeUpdate(sid, v);
      const files = {};
      for (const c of cams) files[c] = await local(store.recordingPath(sid, rec, rec.cameras[c].file));
      // (outside the record's lock: the checks take seconds; what they learn is merged in after)
      const checked = structuredClone(rec);
      const validation = await validators.validate(checked, files, { cams });
      const hard = validators.hardFailures(validation);
      const r2 = await store.updateRecording(sid, rid, (r) => {
        if (r.state !== 'validating') return;
        r.validation = validation; r.cams = cams;
        if (hard.length) { r.state = 'failed'; r.failReason = validators.reasonOf(hard); r.failedAt = new Date().toISOString(); }
        else r.state = 'review';                             // checked: saved right below (settle() retries if that fails)
        if (checked.syncResult) r.syncResult = checked.syncResult;
        for (const c of cams) for (const k of ['fileInfo', 'motion']) if (checked.cameras?.[c]?.[k] && r.cameras?.[c]) r.cameras[c][k] = checked.cameras[c][k];
      });
      hub()?.takeUpdate(sid, r2, { event: r2.state === 'failed' ? 'failed' : 'checked' });
      if (r2.state === 'failed') await noteResult(sid, r2);
      else if (r2.state === 'review') await autoSave(sid, r2);
  }
  /** A camera check: did each camera produce real video? The verdict goes to session.cameraChecks (per device). */
  async function finishCheck(sid, rid, rec, cams) {
    const v = await store.updateRecording(sid, rid, (r) => { r.state = 'validating'; r.validatingAt = new Date().toISOString(); });
    hub()?.takeUpdate(sid, v);
    const part = CAMS.filter((c) => cams.includes(c) || (rec.finishedWithout || []).includes(c));
    const result = {}, info = {};
    for (const c of part) {
      const cc = rec.cameras?.[c];
      const abs = cc?.file ? await local(store.recordingPath(sid, rec, cc.file)) : null;
      const pr = abs ? await media.probe(abs).catch((e) => ({ ok: false, error: e.message })) : null;
      if (pr?.ok) info[c] = pr;
      result[c] = validators.checkCamera(cc, pr);
    }
    const at = new Date().toISOString();
    const r2 = await store.updateRecording(sid, rid, (r) => {
      if (r.state !== 'validating') return;
      r.state = 'checked'; r.result = result; r.cams = cams; r.checkedAt = at;
      for (const c of Object.keys(info)) if (r.cameras?.[c]) r.cameras[c].fileInfo = info[c];
    });
    const s = await store.updateSession(sid, (s) => {
      s.cameraChecks ||= {};
      for (const [c, x] of Object.entries(result)) s.cameraChecks[c] = { checkId: rid, ...x, deviceId: rec.cameras?.[c]?.deviceId || s.devices?.[c]?.deviceId || null, at };
    });
    hub()?.disarm(sid, rid);
    hub()?.takeUpdate(sid, r2, { event: 'checked' });
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s) });
  }
  /** A take's outcome in the session — what the animation list shows (failed with its reason, rejected). */
  async function noteResult(sid, rec) {
    const at = new Date().toISOString();
    const s = await store.updateSession(sid, (s) => {
      if (rec.kind === 'calibration') {
        const c = (s.calibrations[rec.courtSetup] ||= { takes: [rec.id], current: null, status: 'missing' });
        if (rec.state === 'failed') c.lastFailed = { id: rec.id, reason: rec.failReason || 'failed', at };
        return;
      }
      if (rec.kind !== 'take') return;
      const e = (s.animations[rec.animId] ||= { takes: [rec.id], selectedTake: null });
      (e.results ||= {})[rec.id] = rec.state === 'failed' ? { state: 'failed', reason: rec.failReason || 'failed', at } : { state: rec.state, at };
    });
    hub()?.disarm(sid, rec.id);
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s) });
    return s;
  }
  async function autoSave(sid, rec) {
    try { await acceptRecording(sid, rec, { auto: true }); }
    catch (e) { console.error('[capture] auto-save', rec.id, e.message); }   // stays checked ('review'): settle() saves it later
  }
  /**
   * Move on what a restart (or a refused bucket write) left half-way — the newest take of each
   * animation and each setup's newest calibration: a checked take whose save failed is saved, an
   * outcome missing from the session is written, a stuck take is nudged, a take armed but never
   * started (> 2 min) is discarded. In the background, at most every 4 s per session.
   */
  const settling = new Map();
  function settle(sid) {
    const last = settling.get(sid);
    if (last && (last.running || Date.now() - last.at < 4000)) return;
    const st = { running: true, at: Date.now() };
    settling.set(sid, st);
    (async () => {
      const s = await store.loadSession(sid);
      if (!s) return;
      const ids = [];
      for (const e of Object.values(s.animations || {})) { const id = e.takes?.[e.takes.length - 1]; if (id && !e.results?.[id]) ids.push(id); }
      for (const c of Object.values(s.calibrations || {})) { const id = c.takes?.[c.takes.length - 1]; if (id && c.current !== id && c.lastFailed?.id !== id) ids.push(id); }
      for (const id of ids) {
        const rec = await store.loadRecording(sid, id).catch(() => null);
        if (rec) await settleRec(sid, rec).catch((e) => console.error('[capture] settle', id, e.message));
      }
    })().catch((e) => console.error('[capture] settle', e.message)).finally(() => { st.running = false; st.at = Date.now(); });
  }
  async function settleRec(sid, rec) {
    if (rec.state === 'review') {                            // checked, not saved (a restart, or the bucket refused)
      const hard = validators.hardFailures(rec.validation);
      if (!hard.length) return autoSave(sid, rec);
      const r = await store.updateRecording(sid, rec.id, (x) => { if (x.state === 'review') { x.state = 'failed'; x.failReason = validators.reasonOf(hard); x.failedAt = new Date().toISOString(); } });
      hub()?.takeUpdate(sid, r, { event: 'failed' });
      return noteResult(sid, r);
    }
    if (rec.state === 'accepted') return acceptRecording(sid, rec, { auto: true });   // its session write was lost
    if (rec.state === 'failed' || (rec.state === 'rejected' && rec.kind === 'take')) return noteResult(sid, rec);
    if (rec.state === 'armed' && !Object.keys(rec.cameras || {}).length && Date.now() - Date.parse(rec.createdAt || 0) > 120000) {
      const r = await store.updateRecording(sid, rec.id, (x) => { if (x.state === 'armed') { x.state = 'rejected'; x.rejectedAt = new Date().toISOString(); x.note = 'armed but never started'; } });
      return noteResult(sid, r);
    }
    nudge(sid, rec);
  }
  /** A take that should move on but nothing is driving it (a restart mid-check / mid-finish). */
  const nudge = (sid, rec) => { if (['armed', 'recording', 'uploading', 'validating'].includes(rec.state) && !checking.has(`${sid}:${rec.id}`)) maybeFinish(sid, rec.id).catch((e) => console.error('[capture] finish', e.message)); };
  // go on with what arrived when a camera stays away (e.g. its phone died mid-take)
  router.post('/api/capture/sessions/:sid/rec/:rid/finish', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const up = CAMS.filter((c) => rec.cameras?.[c]?.file);
      if (!up.length) return json(res, { error: 'no camera has uploaded this take yet' }, 409);
      if (!['armed', 'recording', 'uploading'].includes(rec.state) && !(rec.state === 'validating' && !checking.has(`${p.sid}:${p.rid}`))) return json(res, { error: `the take is ${rec.state}` }, 409);
      await store.updateRecording(p.sid, p.rid, (r) => { r.expectedCams = up; r.finishedWithout = CAMS.filter((c) => !up.includes(c)); if (r.state !== 'uploading') r.state = 'uploading'; });
      await maybeFinish(p.sid, p.rid);
      json(res, { take: await store.loadRecording(p.sid, p.rid) });
    } catch (e) { err(res, e); }
  });

  // native high-frame-rate path: a 120 / 240 fps file recorded by the phone's camera app for this take
  router.put('/api/capture/sessions/:sid/rec/:rid/:cam/native', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      if (+req.headers['content-length'] > MAX_NATIVE_BYTES) return json(res, { error: 'file too large (2 GB max)' }, 413);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const ext = (String(req.headers['x-filename'] || 'native.mov').match(/\.(mov|mp4|m4v|webm|mkv)$/i)?.[1] || 'mov').toLowerCase();
      const name = `${p.cam}.native.${ext}`, abs = store.recordingPath(p.sid, rec, name);
      const tmp = `${abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      try {
        await new Promise((resolve, reject) => {
          let n = 0; const ws = fs.createWriteStream(tmp);
          req.on('data', (c) => { n += c.length; if (n > MAX_NATIVE_BYTES) { req.unpipe(ws); req.destroy(); ws.destroy(); reject(Object.assign(new Error('file too large (2 GB max)'), { status: 413 })); } });
          req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
        });
      } catch (e) { await fs.promises.rm(tmp, { force: true }).catch(() => {}); throw e; }
      await fs.promises.rename(tmp, abs);
      const info = await media.probe(abs).catch((e) => ({ error: e.message }));
      // where is the take's sync chirp in the native file? (it heard the same chirp as the web recording)
      const SA = require('../lib/capture/sync-audio');
      const x = await SA.pcm(abs, { maxSec: 300 }).catch(() => null);
      const chirp = x ? await SA.findChirpAsync(x) : null;
      await store.mirror(abs);                               // in the bucket before the take points at it
      const updated = await store.updateRecording(p.sid, p.rid, (r) => {
        (r.cameras[p.cam] ||= { role: p.cam }).native = { file: name, bytes: fs.statSync(abs).size, source: 'native-import', probe: info, chirp, mirrored: cloud.available(), importedAt: new Date().toISOString(), note: 'recorded by the phone\'s own camera app (true high frame rate); aligned to the take by the sync chirp' };
      });
      json(res, { take: updated });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/rec/:rid', async (req, res, p) => {
    try { const rec = await recOr404(res, p.sid, p.rid); if (!rec) return; nudge(p.sid, rec); json(res, { take: rec }); } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/rec/:rid/:cam/video', async (req, res, p) => {
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const c = rec.cameras?.[p.cam];
      if (!c?.file) return json(res, { error: 'no recording yet' }, 404);
      const abs = await local(store.recordingPath(p.sid, rec, c.file));
      if (!abs) return json(res, { error: 'file missing' }, 404);
      serveRange(req, res, abs, cloud.contentType(abs));
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/rec/:rid/:cam/still.jpg', async (req, res, p, q) => {
    try {
      if (!CAMS.includes(p.cam)) return json(res, { error: 'bad camera' }, 400);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const c = rec.cameras?.[p.cam];
      if (!c?.file) return json(res, { error: 'no recording yet' }, 404);
      const abs = await local(store.recordingPath(p.sid, rec, c.file));
      if (!abs) return json(res, { error: 'file missing' }, 404);
      const buf = await media.still(abs, Math.max(0, +(q.t ?? 1) || 0));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' }); res.end(buf);
    } catch (e) { err(res, e); }
  });

  // ── accept (the server does it by itself; the API stays) / discard / mark best / skip
  /**
   * SAVED: every file of the recording in the bucket, then its record says accepted, then the
   * session's progress — only after all of it. A manual accept selects the take (unless
   * select:false); the automatic one only when it is the animation's newest recorded take.
   */
  async function acceptRecording(sid, rec, { force = false, select, auto = false } = {}) {
    // every file of the take in the bucket first (uploads are mirrored as they complete; this
    // catches anything that was not) …
    const dir = store.recDir(sid, rec.kind, rec.id);
    for (const c of CAMS) {
      const cc = rec.cameras?.[c]; if (!cc) continue;
      for (const [f, done] of [[cc.file, cc.mirrored], [cc.file && cc.framesFile, cc.mirrored], [cc.native?.file, cc.native?.mirrored]]) {
        if (!f || (done && cloud.available())) continue;
        if (!plainName(f)) continue;
        const abs = path.join(dir, f);
        if (fs.existsSync(abs)) await store.mirror(abs);
        else if (!done) throw Object.assign(new Error(`${f} is missing on the server — record it again`), { status: 409 });
      }
    }
    // … then the record says accepted (mirrored; on failure the local copy goes back) …
    const saved = await store.updateRecording(sid, rec.id, (r) => { r.state = 'accepted'; r.accepted = true; r.acceptedAt ||= new Date().toISOString(); r.forced = !!force && !rec.validation?.ok; if (auto) r.autoSaved = true; });
    // … then the session's progress. SAVED only after all of it.
    const at = new Date().toISOString();
    const s = await store.updateSession(sid, (s) => {
      if (rec.kind === 'calibration') {
        const c = (s.calibrations[rec.courtSetup] ||= { takes: [rec.id], current: null });
        c.current = rec.id; c.status = 'valid'; c.acceptedAt = at; delete c.suspectReason; delete c.lastFailed;
        s.currentSetup = rec.courtSetup;
      } else {
        const e = (s.animations[rec.animId] ||= { takes: [rec.id], selectedTake: null });
        const i = (id) => e.takes.indexOf(id);
        if (auto ? (!e.selectedTake || i(e.selectedTake) < i(rec.id)) : (!e.selectedTake || select !== false)) e.selectedTake = rec.id;
        (e.results ||= {})[rec.id] = {
          state: 'recorded', at, cams: CAMS.filter((c) => saved.cameras?.[c]?.file),
          durations: Object.fromEntries(CAMS.filter((c) => saved.cameras?.[c]?.fileInfo?.durationSec).map((c) => [c, saved.cameras[c].fileInfo.durationSec])),
          warnings: (saved.validation?.checks || []).filter((c) => c.level !== 'ok').map((c) => c.msg).slice(0, 4),
        };
        e.skipped = false;
      }
    });
    if (rec.kind === 'take') await markSelected(sid, s.animations[rec.animId]);
    hub()?.disarm(sid, rec.id);
    hub()?.takeUpdate(sid, saved, { event: 'saved' });
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s) });
    // a saved calibration: each camera keeps what it sees now as the reference (moved-camera check)
    if (rec.kind === 'calibration') hub()?.broadcast(sid, { t: 'setref', setup: rec.courtSetup, from: 'server' }, { roles: CAMS });
    return { saved, session: s };
  }
  router.post('/api/capture/sessions/:sid/rec/:rid/accept', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (rec.kind === 'check') return json(res, { error: 'a camera check is not a take' }, 409);
      if (!['review', 'accepted', 'failed'].includes(rec.state)) return json(res, { error: `the take is ${rec.state} — wait for the upload + checks` }, 409);
      if (!rec.validation?.ok && !b.force) return json(res, { error: 'the checks failed — accept anyway with force', validation: rec.validation }, 409);
      const { saved, session: s } = await acceptRecording(p.sid, rec, { force: !!b.force, select: b.select });
      const { P } = await libraries(), L = await libOf(s);
      json(res, { saved: true, cloud: cloud.available(), take: saved, progress: P.progress(L, s, { after: rec.animId || null }) });
    } catch (e) { err(res, e); }
  });
  /** Exactly the animation's selected take carries selected: true. */
  async function markSelected(sid, e) {
    for (const tid of e?.takes || []) {
      const want = tid === e.selectedTake;
      const r = await store.loadRecording(sid, tid, 'take').catch(() => null);
      if (r && !!r.selected !== want) await store.updateRecording(sid, tid, (x) => { x.selected = want; });
    }
  }
  router.post('/api/capture/sessions/:sid/rec/:rid/reject', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const r = await store.updateRecording(p.sid, p.rid, (r) => { if (r.state !== 'accepted') { r.state = 'rejected'; r.rejectedAt = new Date().toISOString(); } });
      if (r.state === 'rejected') await noteResult(p.sid, r);
      hub()?.disarm(p.sid, p.rid);
      hub()?.takeUpdate(p.sid, r, { event: 'rejected' });
      json(res, { take: r });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/select', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      if (!rec.accepted || rec.kind !== 'take') return json(res, { error: 'only an accepted take can be the selected one' }, 409);
      const s = await store.updateSession(p.sid, (s) => { s.animations[rec.animId].selectedTake = rec.id; });
      await markSelected(p.sid, s.animations[rec.animId]);
      hub()?.broadcast(p.sid, { t: 'session', session: forCameras(s) });
      json(res, { session: s });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/rec/:rid/landmarks', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      if (!CAMS.includes(b.cam)) return json(res, { error: 'cam must be camA or camB' }, 400);
      const { C } = await libraries();
      const pts = {};
      for (const [k, v] of Object.entries(b.points || {})) if (Object.hasOwn(C.COURT.landmarks, k) && Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) pts[k] = v;
      const r = await store.updateRecording(p.sid, p.rid, (r) => { (r.landmarks ||= {})[b.cam] = { image: pts, world: Object.fromEntries(Object.keys(pts).map((k) => [k, C.COURT.landmarks[k]])), units: 'normalised image coords (0–1) ↔ court metres', at: new Date().toISOString() }; });
      json(res, { calibration: r });
    } catch (e) { err(res, e); }
  });
  // live status of the room's devices (what the hub sees right now) — for the director / diagnosis
  router.get('/api/capture/sessions/:sid/devices', async (req, res, p) => {
    if (needDirector(req, res)) return;
    const r = hub()?.rooms.get(p.sid);
    const now = Date.now(), out = {};
    for (const [role, d] of r?.devices || []) out[role] = { online: d.online, lastSeenAgoMs: now - (d.lastSeen || 0), deviceId: d.deviceId, ua: d.device?.ua || null, state: d.state ? { ...d.state, camera: d.state.camera ? { width: d.state.camera.width, height: d.state.camera.height, frameRate: d.state.camera.frameRate, mime: d.state.camera.mime, label: d.state.camera.label } : null } : null };
    json(res, { armed: r?.armed || null, devices: out });
  });
  // a camera's calibration reference view: kept on the server, so a reloaded camera page still
  // notices being moved (camera token or director)
  router.put('/api/capture/sessions/:sid/calref/:setup/:cam', async (req, res, p) => {
    try {
      if (!SETUPS.includes(p.setup) || !CAMS.includes(p.cam)) return json(res, { error: 'bad setup / camera' }, 400);
      const b = await body(req, 64 << 10);
      const ok = b.w === 64 && b.h === 36 && Array.isArray(b.px) && b.px.length === 64 * 36 && b.px.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);
      if (!ok) return json(res, { error: 'bad reference' }, 400);
      if (!(await store.loadSession(p.sid))) return json(res, { error: 'session not found' }, 404);
      await store.saveCalRef(p.sid, p.setup, p.cam, { w: b.w, h: b.h, px: b.px });
      json(res, { ok: true });
    } catch (e) { err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/calref/:setup/:cam', async (req, res, p) => {
    try {
      if (!SETUPS.includes(p.setup) || !CAMS.includes(p.cam)) return json(res, { error: 'bad setup / camera' }, 400);
      const r = await store.loadCalRef(p.sid, p.setup, p.cam);
      if (!r) return json(res, { error: 'no reference' }, 404);
      json(res, { ref: r });
    } catch (e) { err(res, e); }
  });
  router.post('/api/capture/sessions/:sid/animations/:aid/skip', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const { LIBRARIES } = await libraries();
      const s0 = await store.loadSession(p.sid);
      if (!s0) return json(res, { error: 'session not found' }, 404);
      if (!LIBRARIES[s0.libraryId]?.animations.some((a) => a.id === p.aid)) return json(res, { error: `no animation ${p.aid}` }, 400);
      const s = await store.updateSession(p.sid, (s) => { (s.animations[p.aid] ||= { takes: [], selectedTake: null }).skipped = b.skipped !== false; });
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
      const entries = [], takesIndex = [], missing = [];
      const addRec = async (rec, folder) => {
        const dir = store.recDir(s.id, rec.kind, rec.id);
        const add = async (file, name) => { if (!plainName(file)) return; const abs = await local(path.join(dir, file)); if (abs) entries.push({ name: `${root}/${folder}/${name}`, file: abs }); else missing.push(`${folder}/${name}`); };
        for (const cam of CAMS) {
          const c = rec.cameras?.[cam]; if (!c?.file) continue;
          await add(c.file, `${cam}${path.extname(c.file)}`);
          if (c.native?.file) await add(c.native.file, `${cam}.native${path.extname(c.native.file)}`);
          await add(c.framesFile || `${cam}.frames.json`, `${cam}.frames.json`);
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
        progress: P.progress(L, s), takes: takesIndex, ...(missing.length ? { missingFiles: missing } : {}),
        conventions: { clock: 'all *AtServerMs / frames.json times: the session server clock (ms since epoch); per camera clock.offsetMs = server − device', court: C.COURT.frame, holds: 'one-shot takes include ~1 s start and end holds (capture handles, not part of the game clip)' },
      };
      entries.unshift({ name: `${root}/session.json`, data: sessionJson });
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="${root}.tar"`, 'Cache-Control': 'no-store' });
      await store.streamTar(res, entries);
      res.end();
    } catch (e) { err(res, e); }
  });

  // ── processing (pluggable; SAM 3D Body through the existing mocap pipeline)
  router.get('/api/capture/processors', async (req, res) => json(res, { processors: processing.list() }));
  router.post('/api/capture/sessions/:sid/rec/:rid/process', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      const rec = await recOr404(res, p.sid, p.rid); if (!rec) return;
      const cam = CAMS.includes(b.cam) ? b.cam : 'camA';
      if (!rec.cameras?.[cam]?.file) return json(res, { error: `${cam} has no recording` }, 409);
      if (!(await local(store.recordingPath(p.sid, rec, rec.cameras[cam].file)))) return json(res, { error: `${cam}'s recording is missing on the server` }, 409);
      const job = await processing.start(b.processor || 'sam3dbody', { sessionId: p.sid, take: rec, cam, fps: b.fps, maxFrames: b.maxFrames, start: b.start, end: b.end, confirmCostUsd: b.confirmCostUsd, TMP_DIR, role: typeof b.role === 'string' ? b.role : null });
      json(res, { job });
    } catch (e) { err(res, e); }
  });
  // the analysis queue: the director sends recorded takes with an explicit cost confirmation
  router.post('/api/capture/sessions/:sid/process-batch', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try {
      const b = await body(req);
      json(res, await queue.enqueue(p.sid, { takes: b.takes, cam: b.cam, fps: b.fps, confirmCostUsd: b.confirmCostUsd }));
    } catch (e) { if (e.status === 402) return json(res, { error: e.message, ...(e.extra || {}) }, 402); err(res, e); }
  });
  router.get('/api/capture/sessions/:sid/analysis', async (req, res, p) => {
    if (needDirector(req, res)) return;
    try { json(res, await queue.status(p.sid)); } catch (e) { err(res, e); }
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
  const stream = (opts) => { const rs = fs.createReadStream(abs, opts); rs.on('error', () => res.destroy()); rs.pipe(res); };
  if (m && (m[1] || m[2])) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (!(start >= 0 && start <= end)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    stream({ start, end });
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    stream({});
  }
}

/** The URLs a camera can join by: the LAN HTTPS listener (phones need HTTPS for the camera) and this origin. */
function cameraUrls(req, s, PORT) {
  const out = [];
  const lan = global.__captureLan;
  if (lan) for (const ip of lan.ips) out.push({ url: `https://${ip}:${lan.port}/capture?pair=${s.pair.token}`, kind: 'lan-https' });
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  const host = req.headers.host;
  const here = `${proto}://${host}/capture?pair=${s.pair.token}`;
  if (!out.some((u) => u.url === here)) out.push({ url: here, kind: proto === 'https' || /^localhost|^127\./.test(host || '') ? 'this-origin' : 'this-origin-http (cameras need HTTPS)' });
  // the same-origin one first when the director itself is on HTTPS (Railway, the LAN listener)
  if (proto === 'https') out.sort((a, b) => (a.url === here ? -1 : b.url === here ? 1 : 0));
  return out;
}

module.exports = { register, cameraUrls, lanIps: () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) };
