/**
 * Soul Jam Capture — persistent storage of capture sessions, takes, calibrations and uploads.
 *
 *   data/capture/sessions/<sessionId>/
 *     session.json                          progress: per animation its takes + the selected one
 *     takes/<takeId>/take.json              the take's metadata (machine-readable, see docs/capture.md)
 *     takes/<takeId>/camA.mp4|webm, camB.*  the recordings (assembled from uploaded chunks)
 *     takes/<takeId>/camA.frames.json …     per-frame server timestamps
 *     takes/<takeId>/uploads/<cam>/<n>.part chunks until assembled (idempotent, resumable)
 *     calibrations/<calId>/…                same layout, one per court setup (kept apart from takes)
 *
 * Every write is atomic (temp file + rename). Nothing lives only in memory: a server restart, a
 * page refresh or a dropped connection resumes from disk. When cloud storage is configured
 * (Railway: Firebase / R2) every saved file is mirrored under _meta/capture/… before the take is
 * reported saved, and sessions are restored from it (Railway's disk does not survive a deploy).
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const cloud = require('./cloud');

const ROOT = path.resolve(process.env.CAPTURE_DIR || path.join(__dirname, '..', '..', 'data', 'capture'));
const SESS = path.join(ROOT, 'sessions');
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const CAM_RE = /^cam[AB]$/;
const KINDS = { take: 'takes', calibration: 'calibrations', check: 'checks' };
const FILES = { take: 'take.json', calibration: 'calibration.json', check: 'check.json' };
/** A recording's kind from its id: cal-… calibration, chk-… camera check, else a take. */
const kindOf = (id) => (String(id).startsWith('cal-') ? 'calibration' : String(id).startsWith('chk-') ? 'check' : 'take');

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const sessionDir = (id) => path.join(SESS, safe(id));
const recDir = (sid, kind, id) => path.join(sessionDir(sid), KINDS[kind] || 'takes', safe(id));
const cloudKey = (abs) => '_meta/capture/' + path.relative(ROOT, abs).split(path.sep).join('/');

async function writeJsonAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(JSON.stringify(obj, null, 1)); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
}
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// one writer at a time per session (session.json is read-modify-write)
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** Mirror a file to the cloud (when configured) — throws if it fails, so "saved" is only reported after it. */
async function mirror(abs) {
  if (!cloud.available()) return { cloud: false };
  await cloud.putFile(abs, cloudKey(abs));
  return { cloud: true };
}

/*
 * Which copy of a JSON record is current? This process's own writes are (every write is mirrored).
 * A record this process has not written yet may have a newer copy in the cloud: after a redeploy
 * the local disk starts empty, and for a short while the old container can still be writing. So
 * until this process writes a record — or the old container is certainly gone — it is read from
 * the cloud (briefly cached), falling back to the local copy when the cloud has none.
 */
const BOOT = Date.now();
const OVERLAP_MS = 120000;                                  // a redeploy's old container is gone by then
const owned = new Set();                                    // records this process wrote (or trusts)
const peeked = new Map();                                   // file → { at, obj }
const gen = new Map();                                      // file → local write generation
let bucketDownUntil = 0;                                    // after a failed read: use local copies for a while
const unavailable = () => Object.assign(new Error('storage is unreachable — try again'), { status: 503 });
async function writeLocalCopy(f, buf) {
  await fsp.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, f);
}
/*
 * While a record's new version is being mirrored (the bucket may take seconds: retries with
 * backoff), readers get the last version the bucket confirmed — nobody sees "saved" before the
 * bucket has it. Read-modify-writes of one record are serialised by its lock, so they never start
 * while their own record is in flight.
 */
const inflight = new Map();                                 // file → { obj: the last confirmed version (null: none yet) }
async function readRecord(f) {
  if (inflight.has(f)) { const c = inflight.get(f).obj; return c ? structuredClone(c) : null; }
  if (!cloud.available() || owned.has(f)) return readJson(f);
  const hit = peeked.get(f);
  if (hit && Date.now() - hit.at < 2000) return hit.obj;
  const g0 = gen.get(f) || 0;
  if (Date.now() < bucketDownUntil) { const l = await readJson(f); if (l) return l; throw unavailable(); }
  let buf = null;
  try { buf = await cloud.getFile(cloudKey(f)); }
  catch {                                                  // bucket unreachable: a local copy if there is one, else "try again" (not "not found")
    bucketDownUntil = Date.now() + 10000;
    const l = await readJson(f);
    if (l) { if (Date.now() - BOOT > OVERLAP_MS) owned.add(f); return l; }
    throw unavailable();
  }
  // a write that happened while the bucket answered is newer than what it answered
  if ((gen.get(f) || 0) !== g0 || owned.has(f)) return readJson(f);
  if (!buf) return readJson(f);
  const obj = JSON.parse(buf.toString('utf8'));
  await writeLocalCopy(f, buf);
  if ((gen.get(f) || 0) !== g0) return readJson(f);
  if (Date.now() - BOOT > OVERLAP_MS) owned.add(f); else peeked.set(f, { at: Date.now(), obj });
  return obj;
}
/** Write a JSON record: atomically on disk, then mirrored (throws when the mirror fails). */
async function writeRecord(f, obj, { mirror: doMirror = true, restoreOnFail = undefined } = {}) {
  gen.set(f, (gen.get(f) || 0) + 1);
  const guard = doMirror && cloud.available() ? { obj: inflight.get(f)?.obj ?? await readJson(f).catch(() => null) } : null;
  if (guard) inflight.set(f, guard);
  try {
    await writeJsonAtomic(f, obj);
    owned.add(f); peeked.delete(f);
    if (doMirror) await mirror(f);
  } catch (e) {
    // (still guarded: nobody reads the refused version in between)
    if (restoreOnFail !== undefined) { gen.set(f, (gen.get(f) || 0) + 1); await writeJsonAtomic(f, restoreOnFail).catch(() => {}); }
    throw e;
  } finally { if (guard && inflight.get(f) === guard) inflight.delete(f); }
  return f;
}
/**
 * Read-modify-write under the record's lock. If the mirror fails, the local copy goes back to what
 * it was — so nothing is ever confirmed (e.g. a camera's upload) that the bucket does not have.
 */
async function rewrite(f, load, fn, write, { rollback = true } = {}) {
  const cur = await load();
  if (!cur) return { missing: true };
  const before = structuredClone(cur);
  const out = await fn(cur);
  await write(cur, rollback ? { restoreOnFail: before } : {});
  return { value: cur, out };
}

// ── sessions
async function createSession({ libraryId, name, pairCode = null }) {
  const id = newId('cs');
  const s = {
    schema: 'souljam.capture.session/1', id, libraryId, name: name || libraryId, createdAt: new Date().toISOString(), updatedAt: null,
    pair: { token: crypto.randomBytes(18).toString('base64url'), code: pairCode || newPairCode(), codeExpiresAt: new Date(Date.now() + PAIR_CODE_TTL_MS).toISOString() },
    currentSetup: null, calibrations: {}, animations: {}, takeCounter: 0, devices: {},
  };
  await saveSession(s);
  return s;
}
async function saveSession(s, opts) {
  s.updatedAt = new Date().toISOString();
  await writeRecord(path.join(sessionDir(s.id), 'session.json'), s, opts);
  return s;
}
async function loadSession(id) {
  if (!safe(id)) return null;
  return readRecord(path.join(sessionDir(id), 'session.json'));   // Railway after a redeploy: from the bucket
}
/** Read-modify-write a session under its lock. */
function updateSession(id, fn) {
  return withLock('s:' + id, async () => {
    const r = await rewrite(path.join(sessionDir(id), 'session.json'), () => loadSession(id), fn, (x, o) => saveSession(x, o));
    if (r.missing) throw Object.assign(new Error('session not found'), { status: 404 });
    return r.out === undefined ? r.value : r.out;
  });
}
let cloudIds = { at: 0, ids: [] };                          // the bucket's session ids (listing is slow: cached)
async function listSessions() {
  const ids = new Set();
  try { for (const d of await fsp.readdir(SESS)) ids.add(d); } catch {}
  if (cloud.available()) {
    if (Date.now() - cloudIds.at > 30000) {
      const keys = await cloud.list('_meta/capture/sessions/').catch(() => null);
      if (keys) {                                           // (a failed listing is not remembered as "no sessions")
        const found = [];
        for (const k of keys) { const m = k.match(/^_meta\/capture\/sessions\/([^/]+)\/session\.json$/); if (m) found.push(m[1]); }
        cloudIds = { at: Date.now(), ids: found };
      }
    }
    for (const id of cloudIds.ids) ids.add(id);
  }
  const out = [];
  for (const id of ids) { const s = await loadSession(id).catch(() => null); if (s) out.push(s); }
  return out.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}
const sameSecret = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B); };
/** The session this pairing token belongs to. */
async function findSessionByToken(token) {
  for (const s of await listSessions()) if (sameSecret(s.pair?.token, token)) return s;
  return null;
}
/** The session whose 6-digit code this is — only while the code is live (the director re-issues it). */
async function findSessionByCode(code) {
  const now = Date.now();
  for (const s of await listSessions()) if (s.pair?.code && sameSecret(s.pair.code, code) && Date.parse(s.pair.codeExpiresAt || 0) > now) return s;
  return null;
}
const PAIR_CODE_TTL_MS = 15 * 60000;
const newPairCode = () => String(crypto.randomInt(100000, 1000000));
/** A live pairing code for the director's pair screen: the current one, or a fresh one when it expired. */
function refreshPairCode(id) {
  return updateSession(id, (s) => {
    if (!(Date.parse(s.pair.codeExpiresAt || 0) - Date.now() > 60000)) { s.pair.code = newPairCode(); }
    s.pair.codeExpiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS).toISOString();
  });
}
// ── takes / calibrations (a "recording": kind take | calibration)
async function createRecording(sessionId, { kind = 'take', anim = null, setup, calibrationId = null, library, targetDurationSec = null, extra = null }) {
  return updateSession(sessionId, async (s) => {
    const id = newId(kind === 'calibration' ? 'cal' : 'tk');
    s.takeCounter = (s.takeCounter || 0) + 1;
    let takeNo = 1;
    if (kind === 'take') {
      const e = (s.animations[anim.id] ||= { takes: [], selectedTake: null });
      takeNo = e.takes.length + 1;
      e.takes.push(id);
    } else {
      const c = (s.calibrations[setup] ||= { takes: [], current: null, status: 'missing' });
      takeNo = c.takes.length + 1;
      c.takes.push(id);
    }
    const rec = {
      schema: kind === 'calibration' ? 'souljam.capture.calibration/1' : 'souljam.capture.take/1',
      kind, id, sessionId, library, takeNo, courtSetup: setup, calibrationId, ...(extra || {}),
      ...(kind === 'calibration' ? { targetDurationSec: targetDurationSec || 20 } : {}),
      ...(anim ? { animId: anim.id, animKey: anim.key, title: anim.title, subtitle: anim.subtitle || null, category: anim.category, startState: anim.startState, endState: anim.endState, endResolves: anim.endResolves || null, direction: anim.direction, ballHand: anim.ballHand, targetDurationSec: anim.durationSec, loop: anim.loop } : {}),
      state: 'armed', createdAt: new Date().toISOString(), sync: {}, cameras: {}, validation: null, accepted: false, selected: false, processing: {},
      autoSave: true,                                       // saved by itself once checked (takes of the old, reviewed flow lack this)
    };
    await writeRecording(sessionId, rec);
    return rec;
  });
}
/**
 * A camera check: a 2 s test recording through the whole path (record → upload → decode on the
 * server). Kept apart from takes and calibrations and never part of the session's progress.
 */
async function createCheck(sessionId, { library = null } = {}) {
  const s = await loadSession(sessionId);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const rec = {
    schema: 'souljam.capture.check/1', kind: 'check', id: newId('chk'), sessionId, library, takeNo: 1, courtSetup: s.currentSetup || null,
    targetDurationSec: 2, state: 'armed', createdAt: new Date().toISOString(), sync: {}, cameras: {}, validation: null, accepted: false, selected: false, processing: {},
  };
  await writeRecording(sessionId, rec);
  return rec;
}
const recFile = (sessionId, kind, id) => path.join(recDir(sessionId, kind, id), FILES[kind] || FILES.take);
/** Every change to a take / calibration record is mirrored (Railway's disk does not survive a deploy). */
async function writeRecording(sessionId, rec, opts) {
  return writeRecord(recFile(sessionId, rec.kind, rec.id), rec, opts);
}
async function loadRecording(sessionId, id, kind = null) {
  if (!safe(sessionId) || !safe(id)) return null;
  return readRecord(recFile(sessionId, kind || kindOf(id), id));   // the id says which
}
/**
 * Read-modify-write one recording under its lock. By default a failed mirror puts the local copy
 * back (nothing is confirmed that the bucket lacks). { rollback: false } is for facts that happened
 * whether or not the bucket answered (the hub's start / stop / chirp times): they stay on disk and
 * go up with the next write.
 */
function updateRecording(sessionId, id, fn, { rollback = true } = {}) {
  return withLock('r:' + sessionId + ':' + id, async () => {
    const kind = kindOf(id);
    const r = await rewrite(recFile(sessionId, kind, id), () => loadRecording(sessionId, id), fn, (x, o) => writeRecording(sessionId, x, o), { rollback });
    if (r.missing) throw Object.assign(new Error('take not found'), { status: 404 });
    return r.out === undefined ? r.value : r.out;
  });
}

// ── the calibration reference view of each camera (moved-camera check), kept apart from session.json
const calRefFile = (sessionId, setup, cam) => path.join(sessionDir(sessionId), 'calrefs', `${setup}-${cam}.json`);
async function saveCalRef(sessionId, setup, cam, ref) { await writeRecord(calRefFile(sessionId, setup, cam), { setup, cam, ...ref, at: new Date().toISOString() }); }
function loadCalRef(sessionId, setup, cam) { return readRecord(calRefFile(sessionId, setup, cam)); }
const recordingPath = (sessionId, rec, file) => path.join(recDir(sessionId, rec.kind, rec.id), file);

// ── uploads: chunks (idempotent by sequence number), then assemble
const uploadDir = (sessionId, rec, cam) => path.join(recDir(sessionId, rec.kind, rec.id), 'uploads', cam);
// limits for one camera's recording: 120 s at ≤ 40 Mbit/s is ~600 MB (Safari's MP4 recorder may
// deliver it as ONE chunk at the stop); 1 s chunks → ~120 of them
const MAX_REC_BYTES = 900 << 20, MAX_CHUNKS = 2000;
async function putChunk(sessionId, rec, cam, seq, req, { maxBytes = MAX_REC_BYTES } = {}) {
  if (!CAM_RE.test(cam)) throw Object.assign(new Error('bad camera'), { status: 400 });
  if (!(Number.isInteger(seq) && seq >= 0 && seq < MAX_CHUNKS)) throw Object.assign(new Error('bad chunk number'), { status: 400 });
  const dir = uploadDir(sessionId, rec, cam);
  await fsp.mkdir(dir, { recursive: true });
  const name = `${String(seq).padStart(5, '0')}.part`, final = path.join(dir, name);
  // what this camera already uploaded for the take (a retried chunk replaces itself, so not counted)
  let have = 0;
  for (const f of await fsp.readdir(dir)) if (f.endsWith('.part') && f !== name) have += (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
  const limit = Math.min(maxBytes, MAX_REC_BYTES - have);
  if (limit <= 0) throw Object.assign(new Error('recording too large'), { status: 413 });
  const tmp = `${final}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      req.on('data', (c) => { bytes += c.length; if (bytes > limit) { req.unpipe(ws); req.destroy(); ws.destroy(); reject(Object.assign(new Error('chunk too large'), { status: 413 })); } });
      req.on('error', reject); ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  await fsp.rename(tmp, final);                         // a repeated chunk simply replaces itself
  return { seq, bytes };
}
async function chunkStatus(sessionId, rec, cam) {
  const dir = uploadDir(sessionId, rec, cam);
  let have = [];
  try { have = (await fsp.readdir(dir)).filter((f) => f.endsWith('.part')).map((f) => +f.slice(0, 5)).sort((a, b) => a - b); } catch {}
  return { have, assembled: !!rec.cameras?.[cam]?.file };
}
/** The chunks of an assembled (and saved) recording are no longer needed. */
function dropChunks(sessionId, rec, cam) { return fsp.rm(uploadDir(sessionId, rec, cam), { recursive: true, force: true }); }
/**
 * All chunks 0…n−1 present → one file (camA.mp4 …). The chunks stay until the caller has saved
 * the result (dropChunks), so a failed save can simply assemble again.
 */
async function assemble(sessionId, rec, cam, { chunks, ext, gaps = [] }) {
  const dir = uploadDir(sessionId, rec, cam);
  const missing = [], lost = new Set(gaps);                 // gaps: chunks the phone itself lost (skipped)
  for (let i = 0; i < chunks; i++) if (!lost.has(i) && !fs.existsSync(path.join(dir, `${String(i).padStart(5, '0')}.part`))) missing.push(i);
  if (missing.length) throw Object.assign(new Error(`missing chunks ${missing.slice(0, 8).join(',')}`), { status: 409, missing });
  const name = `${cam}.${ext}`;
  const out = recordingPath(sessionId, rec, name);
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const ws = fs.createWriteStream(tmp);
  let failed = null;
  ws.on('error', (e) => { failed = e; });
  let bytes = 0;
  try {
    for (let i = 0; i < chunks && !failed; i++) {
      const part = path.join(dir, `${String(i).padStart(5, '0')}.part`);
      if (lost.has(i) && !fs.existsSync(part)) continue;
      const buf = await fsp.readFile(part);
      bytes += buf.length;
      if (!ws.write(buf)) await new Promise((r) => { ws.once('drain', r); ws.once('error', r); });
    }
    await new Promise((resolve) => { if (failed) return resolve(); ws.end(resolve); ws.once('error', resolve); });
    if (failed) throw failed;
    const fh = await fsp.open(tmp, 'r+'); await fh.sync(); await fh.close();
    await fsp.rename(tmp, out);
  } catch (e) { ws.destroy(); await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  return { name, bytes, path: out };
}

// ── export: a tar stream of the organised dataset (videos are already compressed)
function tarHeader(name, size, mtime = Date.now() / 1000, type = '0') {
  const b = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf('/', 154); prefix = name.slice(0, i); name = name.slice(i + 1); }
  b.write(name, 0, 100);
  b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136);
  b.write('        ', 148);
  b.write(type, 156);
  b.write('ustar\0' + '00', 257);
  b.write(prefix, 345, 155);
  let sum = 0; for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
/**
 * Stream an export as tar: entries [{ name, file? | data? }]. Waits for backpressure.
 */
async function streamTar(res, entries) {
  const write = (buf) => (res.write(buf) ? Promise.resolve() : new Promise((r) => res.once('drain', r)));
  for (const e of entries) {
    const data = e.data != null ? Buffer.from(typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 1)) : null;
    const size = data ? data.length : (await fsp.stat(e.file)).size;
    await write(tarHeader(e.name, size));
    if (data) await write(data);
    else for await (const chunk of fs.createReadStream(e.file, { highWaterMark: 1 << 20 })) await write(chunk);
    const pad = (512 - (size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024));
}

module.exports = {
  ROOT, BOOT, safe, newId, writeJsonAtomic, writeRecord, readJson, withLock, mirror, cloudKey,
  createSession, saveSession, loadSession, updateSession, listSessions, findSessionByToken, findSessionByCode, refreshPairCode, sameSecret, PAIR_CODE_TTL_MS,
  createRecording, createCheck, kindOf, writeRecording, loadRecording, updateRecording, recordingPath, recDir, saveCalRef, loadCalRef,
  putChunk, chunkStatus, assemble, dropChunks, streamTar, tarHeader, MAX_REC_BYTES,
};
