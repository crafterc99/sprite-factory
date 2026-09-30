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
const KINDS = { take: 'takes', calibration: 'calibrations' };

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

// ── sessions
async function createSession({ libraryId, name, pairCode = null }) {
  const id = newId('cs');
  const s = {
    schema: 'souljam.capture.session/1', id, libraryId, name: name || libraryId, createdAt: new Date().toISOString(), updatedAt: null,
    pair: { token: crypto.randomBytes(18).toString('base64url'), code: pairCode || String(crypto.randomInt(100000, 999999)) },
    currentSetup: null, calibrations: {}, animations: {}, takeCounter: 0, devices: {},
  };
  await saveSession(s);
  return s;
}
async function saveSession(s) {
  s.updatedAt = new Date().toISOString();
  const f = path.join(sessionDir(s.id), 'session.json');
  await writeJsonAtomic(f, s);
  await mirror(f);
  return s;
}
async function loadSession(id) {
  const f = path.join(sessionDir(id), 'session.json');
  let s = await readJson(f);
  if (!s && cloud.available()) {                            // Railway after a redeploy: restore from the bucket
    const buf = await cloud.getFile(cloudKey(f)).catch(() => null);
    if (buf) { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, buf); s = JSON.parse(buf.toString('utf8')); }
  }
  return s;
}
/** Read-modify-write a session under its lock. */
function updateSession(id, fn) {
  return withLock('s:' + id, async () => {
    const s = await loadSession(id);
    if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
    const out = await fn(s);
    await saveSession(s);
    return out === undefined ? s : out;
  });
}
async function listSessions() {
  const ids = new Set();
  try { for (const d of await fsp.readdir(SESS)) ids.add(d); } catch {}
  if (cloud.available()) { for (const k of await cloud.list('_meta/capture/sessions/').catch(() => [])) { const m = k.match(/^_meta\/capture\/sessions\/([^/]+)\/session\.json$/); if (m) ids.add(m[1]); } }
  const out = [];
  for (const id of ids) { const s = await loadSession(id).catch(() => null); if (s) out.push(s); }
  return out.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}
async function findSessionByPair(tokenOrCode) {
  for (const s of await listSessions()) if (s.pair?.token === tokenOrCode || s.pair?.code === tokenOrCode) return s;
  return null;
}

// ── takes / calibrations (a "recording": kind take | calibration)
async function createRecording(sessionId, { kind = 'take', anim = null, setup, calibrationId = null, library }) {
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
      kind, id, sessionId, library, takeNo, courtSetup: setup, calibrationId,
      ...(kind === 'calibration' ? { targetDurationSec: 10 } : {}),
      ...(anim ? { animId: anim.id, animKey: anim.key, title: anim.title, subtitle: anim.subtitle || null, category: anim.category, startState: anim.startState, endState: anim.endState, endResolves: anim.endResolves || null, direction: anim.direction, ballHand: anim.ballHand, targetDurationSec: anim.durationSec, loop: anim.loop } : {}),
      state: 'armed', createdAt: new Date().toISOString(), sync: {}, cameras: {}, validation: null, accepted: false, selected: false, processing: {},
    };
    await writeRecording(sessionId, rec);
    return rec;
  });
}
async function writeRecording(sessionId, rec) {
  const f = path.join(recDir(sessionId, rec.kind, rec.id), rec.kind === 'calibration' ? 'calibration.json' : 'take.json');
  await writeJsonAtomic(f, rec);
  return f;
}
async function loadRecording(sessionId, id, kind = null) {
  for (const k of kind ? [kind] : ['take', 'calibration']) {
    const f = path.join(recDir(sessionId, k, id), k === 'calibration' ? 'calibration.json' : 'take.json');
    let r = await readJson(f);
    if (!r && cloud.available()) { const buf = await cloud.getFile(cloudKey(f)).catch(() => null); if (buf) { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, buf); r = JSON.parse(buf.toString('utf8')); } }
    if (r) return r;
  }
  return null;
}
/** Read-modify-write one recording under its lock. */
function updateRecording(sessionId, id, fn) {
  return withLock('r:' + sessionId + ':' + id, async () => {
    const r = await loadRecording(sessionId, id);
    if (!r) throw Object.assign(new Error('take not found'), { status: 404 });
    const out = await fn(r);
    await writeRecording(sessionId, r);
    return out === undefined ? r : out;
  });
}
const recordingPath = (sessionId, rec, file) => path.join(recDir(sessionId, rec.kind, rec.id), file);

// ── uploads: chunks (idempotent by sequence number), then assemble
const uploadDir = (sessionId, rec, cam) => path.join(recDir(sessionId, rec.kind, rec.id), 'uploads', cam);
async function putChunk(sessionId, rec, cam, seq, req, { maxBytes = 64 << 20 } = {}) {
  if (!CAM_RE.test(cam)) throw Object.assign(new Error('bad camera'), { status: 400 });
  if (!(Number.isInteger(seq) && seq >= 0 && seq < 100000)) throw Object.assign(new Error('bad chunk number'), { status: 400 });
  const dir = uploadDir(sessionId, rec, cam);
  await fsp.mkdir(dir, { recursive: true });
  const final = path.join(dir, `${String(seq).padStart(5, '0')}.part`);
  const tmp = `${final}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    req.on('data', (c) => { bytes += c.length; if (bytes > maxBytes) { req.destroy(); ws.destroy(); reject(Object.assign(new Error('chunk too large'), { status: 413 })); } });
    req.on('error', reject); ws.on('error', reject);
    ws.on('finish', resolve);
    req.pipe(ws);
  });
  await fsp.rename(tmp, final);                         // a repeated chunk simply replaces itself
  return { seq, bytes };
}
async function chunkStatus(sessionId, rec, cam) {
  const dir = uploadDir(sessionId, rec, cam);
  let have = [];
  try { have = (await fsp.readdir(dir)).filter((f) => f.endsWith('.part')).map((f) => +f.slice(0, 5)).sort((a, b) => a - b); } catch {}
  return { have, assembled: !!rec.cameras?.[cam]?.file };
}
/** All chunks 0…n−1 present → one file (camA.mp4 …); the chunks are then removed. */
async function assemble(sessionId, rec, cam, { chunks, ext }) {
  const dir = uploadDir(sessionId, rec, cam);
  const missing = [];
  for (let i = 0; i < chunks; i++) if (!fs.existsSync(path.join(dir, `${String(i).padStart(5, '0')}.part`))) missing.push(i);
  if (missing.length) throw Object.assign(new Error(`missing chunks ${missing.slice(0, 8).join(',')}`), { status: 409, missing });
  const name = `${cam}.${ext}`;
  const out = recordingPath(sessionId, rec, name);
  const tmp = out + '.tmp';
  const ws = fs.createWriteStream(tmp);
  let bytes = 0;
  for (let i = 0; i < chunks; i++) {
    const buf = await fsp.readFile(path.join(dir, `${String(i).padStart(5, '0')}.part`));
    bytes += buf.length;
    if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject); });
  const fh = await fsp.open(tmp, 'r+'); await fh.sync(); await fh.close();
  await fsp.rename(tmp, out);
  await fsp.rm(dir, { recursive: true, force: true });
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
  ROOT, safe, newId, writeJsonAtomic, readJson, withLock, mirror, cloudKey,
  createSession, saveSession, loadSession, updateSession, listSessions, findSessionByPair,
  createRecording, writeRecording, loadRecording, updateRecording, recordingPath, recDir,
  putChunk, chunkStatus, assemble, streamTar, tarHeader,
};
