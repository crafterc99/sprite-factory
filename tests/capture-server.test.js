/**
 * Soul Jam Capture — the REAL server in its production shape (Railway: one instance, a disk that is
 * wiped on every redeploy, the bucket as the only durable store, the APP_PASSWORD gate on).
 *
 * `node server.js` is started as a child process with a temp folder as its disk (CAPTURE_DIR) and
 * another temp folder standing in for the bucket (CAPTURE_CLOUD_DIR, lib/capture/cloud.js). No real
 * cloud storage is touched: every credential variable is blanked. A "redeploy" kills the server by
 * PID, deletes the disk and starts a new server on the same folders.
 *
 * Driven like the phones drive it: the director with the studio password (Bearer), the cameras with
 * only the session's pairing token (X-Capture-Token / ws ?token=), over REST and the WebSocket hub.
 * The chunks are a real 2 s WebM (ffmpeg-static) split into three byte ranges.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const FFMPEG = require('ffmpeg-static');

const REPO = path.resolve(__dirname, '..');
const PASS = 't3st-pass';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-server-'));
const DISK = path.join(TMP, 'disk');          // CAPTURE_DIR — "the container's disk" (wiped on redeploy)
const BUCKET = path.join(TMP, 'bucket');      // CAPTURE_CLOUD_DIR — the fake bucket (survives)
const PORTS = [3471, 3479];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `p`, or a clear failure after `ms` (nothing in these tests may hang until the runner's timeout). */
function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms); })]).finally(() => clearTimeout(t));
}

// ── the test video: 2 s of moving test pattern + a tone, split into 3 chunks ──────────────────────
let VIDEO = null, PARTS = null;
function makeVideo() {
  const f = path.join(TMP, 'fixture.webm');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-shortest', '-f', 'webm', f]);
  VIDEO = fs.readFileSync(f);
  assert.ok(VIDEO.length > 60000, `fixture video is ${VIDEO.length} bytes (the validators want > 50 kB)`);
  const a = Math.floor(VIDEO.length / 3), b = Math.floor((2 * VIDEO.length) / 3);
  PARTS = [VIDEO.subarray(0, a), VIDEO.subarray(a, b), VIDEO.subarray(b)];
}

// ── the server process ──────────────────────────────────────────────────────────────────────────
let srv = null;                                // { proc, port, exited, out() }
function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}
async function freePort() {
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (await canListen(p)) return p;
  throw new Error(`no free port in ${PORTS[0]}-${PORTS[1]}`);
}
function serverEnv(port, extra = {}) {
  const env = {
    ...process.env,
    APP_PASSWORD: PASS, PORT: String(port),
    CAPTURE_DIR: DISK, CAPTURE_CLOUD_DIR: BUCKET, CAPTURE_CLOUD: '1', CAPTURE_HTTPS: '0', CAPTURE_DEBUG: '',
    // never a real bucket: every storage credential blanked (server.js's .env loader keeps these)
    FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: '',
    FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '', FIREBASE_PRIVATE_KEY_ID: '', FIREBASE_STORAGE_BUCKET: '',
    project_id: '', client_email: '', private_key: '', private_key_id: '',
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_PUBLIC_URL: '', STORAGE_BACKEND: '',
    // no paid services; the mocap pipeline (MOCAP_MOCK=1 tests) writes into the temp folder
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', FAL_KEY: '', MOCAP_MOCK: '',
    MOCAP_DIR: path.join(TMP, 'mocap'), TMP_DIR: path.join(TMP, 'video-tmp'),
    ...extra,
  };
  for (const k of ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
  return env;
}
async function startServer(extraEnv) {
  assert.strictEqual(srv, null, 'a server is already running');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: serverEnv(port, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (c) => { out = (out + c).slice(-20000); });
  proc.stderr.on('data', (c) => { out = (out + c).slice(-20000); });
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  srv = { proc, port, exited, out: () => out };
  const deadline = Date.now() + 20000;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) { srv = null; throw new Error(`server exited at boot:\n${out.slice(-3000)}`); }
    const r = await request('GET', '/api/health', { timeout: 1000 }).catch(() => null);
    if (r?.status === 200 && r.json?.ok) break;
    if (Date.now() > deadline) { proc.kill('SIGKILL'); srv = null; throw new Error(`server did not answer /api/health:\n${out.slice(-3000)}`); }
    await sleep(50);
  }
}
/** Kill the server we started (by PID) and wait for it to be gone. */
async function stopServer() {
  if (!srv) return;
  const { proc, exited } = srv;
  srv = null;
  if (proc.exitCode === null && proc.signalCode === null) process.kill(proc.pid, 'SIGKILL');
  await exited;
}
const alive = () => !!srv && srv.proc.exitCode === null && srv.proc.signalCode === null;
/** A Railway redeploy: the process dies, the disk is gone, a new server starts on the bucket. */
async function redeploy({ wipe = true, between = null, env } = {}) {
  await stopServer();
  if (wipe) fs.rmSync(DISK, { recursive: true, force: true });
  if (between) await between();
  await startServer(env);
}
process.on('exit', () => { try { if (alive()) process.kill(srv.proc.pid, 'SIGKILL'); } catch {} });

// ── HTTP (a fresh connection per request: nothing pooled across a restart) ─────────────────────────
function request(method, p, { headers = {}, body = null, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!srv) return reject(new Error('no server'));
    const h = { ...headers };
    if (body != null) h['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${p} timed out`)));
    req.end(body ?? undefined);
  });
}
const DIRECTOR = { Authorization: `Bearer ${PASS}` };
/** The director (signed in with the studio password). */
function dapi(method, p, body) {
  return request(method, p, { headers: { ...DIRECTOR, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? Buffer.from(JSON.stringify(body)) : null });
}
/** A camera phone: only the pairing token. */
function capi(token, method, p, body, extraHeaders = {}) {
  const isBuf = Buffer.isBuffer(body);
  return request(method, p, { headers: { 'X-Capture-Token': token, ...(body !== undefined ? { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json' } : {}), ...extraHeaders }, body: body === undefined ? null : isBuf ? body : Buffer.from(JSON.stringify(body)) });
}
let ipN = 1;
/** A distinct client address per pairing (the rate limit keys on the right-most X-Forwarded-For). */
const nextIp = () => `198.51.100.${ipN++}`;

// ── WebSocket clients ─────────────────────────────────────────────────────────────────────────────
const SOCKETS = new Set();
class Sock {
  constructor(query, headers = {}) {
    this.all = []; this.queue = []; this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/capture/ws?${query}`, { headers });
    SOCKETS.add(this);
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => { SOCKETS.delete(this); resolve({ code, reason: String(reason) }); }));
    this.opened = within(new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('unexpected-response', (req, res) => { reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); this.ws.terminate?.(); });
      this.ws.once('error', reject);
    }), 10000, 'the WebSocket handshake');
    this.opened.catch(() => {});
    this.ws.on('error', () => {});
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      this.all.push(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); } else this.queue.push(m);
    });
  }
  send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  /** Drop what arrived so far (wait only for what comes next). */
  clear() { this.queue.length = 0; }
  /** The first not-yet-consumed message matching `pred` (already here, or the next to arrive). */
  waitFor(pred, what = 'a message', ms = 10000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${what}; last messages: ${JSON.stringify(this.all.slice(-4).map((m) => ({ t: m.t, ...(m.take ? { state: m.take.state } : {}), ...(m.msg ? { msg: m.msg } : {}) })))}`));
      }, ms);
      this.waiters.push(w);
    });
  }
  close() { try { this.ws.terminate(); } catch {} }
}
async function camera(sid, token, role, deviceId = `${role}-device`) {
  const s = new Sock(`session=${encodeURIComponent(sid)}&token=${encodeURIComponent(token)}`);
  s.role = role;
  await s.opened;
  s.send({ t: 'hello', role, deviceId, device: { ua: 'node-test' } });
  await s.waitFor((m) => m.t === 'welcome', `${role} welcome`);
  return s;
}
async function directorWs(sid) {
  const s = new Sock(`session=${encodeURIComponent(sid)}`, DIRECTOR);
  await s.opened;
  s.send({ t: 'hello', role: 'director', deviceId: 'director-device' });
  const w = await s.waitFor((m) => m.t === 'welcome', 'director welcome');
  assert.strictEqual(w.you, 'director');
  return s;
}
/** Cameras report READY / not ready; resolves when the director sees exactly that. */
async function setReady(dir, cams) {
  dir.clear();
  for (const [sock, ready] of cams) sock.send({ t: 'state', state: { ready } });
  return dir.waitFor((m) => m.t === 'presence' && cams.every(([sock, ready]) => !!m.devices?.[sock.role]?.ready === ready), 'presence with the cameras READY');
}

// ── capture flow helpers ─────────────────────────────────────────────────────────────────────────
let ANIMS = null;
async function newSession(name) {
  const r = await dapi('POST', '/api/capture/sessions', { libraryId: 'BASIC-01', name });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  if (!ANIMS) ANIMS = (await import('../capture/basic01.mjs')).BASIC01.animations;
  return r.json.session;
}
async function pairByToken(s) {
  const r = await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: Buffer.from(JSON.stringify({ token: s.pair.token })) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.sessionId, s.id);
  return r.json.token;
}
async function armTake(sid, animId) {
  const r = await dapi('POST', `/api/capture/sessions/${sid}/takes`, { animId });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.take;
}
const recUrl = (sid, rid, cam, rest) => `/api/capture/sessions/${sid}/rec/${rid}${cam ? `/${cam}` : ''}${rest ? `/${rest}` : ''}`;
async function putChunks(sid, rid, cam, token, seqs = [0, 1, 2]) {
  for (const i of seqs) {
    const r = await capi(token, 'PUT', recUrl(sid, rid, cam, `chunk/${i}`), PARTS[i]);
    assert.strictEqual(r.status, 200, `chunk ${i}: ${r.status} ${JSON.stringify(r.json)}`);
  }
}
function completeBody(extra = {}) {
  const t0 = Date.now();
  return {
    chunks: 3, mimeType: 'video/webm;codecs=vp8,opus',
    frames: Array.from({ length: 60 }, (_, i) => t0 + i * (1000 / 30)), mediaTimes: Array.from({ length: 60 }, (_, i) => i / 30),
    meta: { source: 'web', track: { frameRate: 30, width: 640, height: 360 }, clock: { offsetMs: 0, uncertaintyMs: 4 }, startedAtServerMs: t0 },
    ...extra,
  };
}
const complete = (sid, rid, cam, token, extra) => capi(token, 'POST', recUrl(sid, rid, cam, 'complete'), completeBody(extra));
async function getTake(sid, rid) {
  const r = await dapi('GET', recUrl(sid, rid));
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.take;
}
async function waitTake(sid, rid, pred, what, ms = 30000) {
  const deadline = Date.now() + ms;
  let t = null;
  for (;;) {
    t = await getTake(sid, rid);
    if (pred(t)) return t;
    if (Date.now() > deadline) throw new Error(`take ${rid}: timed out waiting for ${what} (state ${t.state})`);
    await sleep(100);
  }
}
/** A take uploaded by `cam` over REST only (no RECORD / STOP): it is checked and SAVED by itself. */
async function uploadedTake(sid, token, animId, cam = 'camA') {
  const t = await armTake(sid, animId);
  await putChunks(sid, t.id, cam, token);
  const r = await complete(sid, t.id, cam, token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return waitTake(sid, t.id, (x) => x.state === 'accepted', 'saved (accepted)');
}
const getSession = async (sid) => { const r = await dapi('GET', `/api/capture/sessions/${sid}`); assert.strictEqual(r.status, 200, JSON.stringify(r.json)); return r.json; };
const bucketPath = (...p) => path.join(BUCKET, '_meta', 'capture', 'sessions', ...p);
const diskPath = (...p) => path.join(DISK, 'sessions', ...p);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** The entries of a (ustar) tar archive: name → bytes. */
function untar(buf) {
  const out = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = str(0, 100), prefix = str(345, 500), size = parseInt(str(124, 136).trim(), 8);
    out.set(prefix ? `${prefix}/${name}` : name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
/** A raw HTTP exchange on a plain socket: what came back before the server closed it (or timeout). */
function rawExchange(text, ms = 3000) {
  return new Promise((resolve) => {
    let got = '', done = false;
    const s = net.connect(srv.port, '127.0.0.1', () => s.write(text));
    const finish = (how) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve({ how, got }); };
    const t = setTimeout(() => finish('timeout'), ms);
    s.on('data', (d) => { got += d.toString('latin1'); });
    s.on('end', () => finish('end'));
    s.on('close', () => finish('close'));
    s.on('error', (e) => finish(`error ${e.code}`));
  });
}
async function assertHealthy(label) {
  assert.ok(alive(), `${label}: the server process died\n${srv?.out().slice(-2000) || ''}`);
  const r = await request('GET', '/api/health', { timeout: 5000 }).catch((e) => ({ status: 0, err: e.message }));
  assert.strictEqual(r.status, 200, `${label}: /api/health → ${r.status} ${r.err || ''}`);
}

before(async () => {
  makeVideo();
  await startServer();
});
after(async () => {
  for (const s of [...SOCKETS]) s.close();
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
let FIRST = null;                                // (a) → (b): the session / take the redeploy restores

test('(a) full take over REST + WebSocket: RECORD → chunks → STOP → complete mirrors video, frames and take.json to the bucket before the 200', async () => {
  const s = await newSession('server-test a');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true]]);
  const anim = ANIMS[0];
  const take = await armTake(s.id, anim.id);
  assert.strictEqual(take.state, 'armed');
  const armed = await camA.waitFor((m) => m.t === 'armed' && m.armed?.takeId === take.id, 'armed on the camera');
  assert.strictEqual(armed.armed.animId, anim.id);

  // RECORD: every camera gets the same future start time
  const before = Date.now();
  dir.send({ t: 'start', takeId: take.id });
  const rec = await camA.waitFor((m) => m.t === 'record' && m.takeId === take.id, 'record on the camera');
  assert.ok(rec.at >= before + 500, `the start time is in the future (lead ${rec.at - before} ms)`);
  const recording = await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  assert.deepStrictEqual(recording.expectedCams, ['camA'], 'the take waits for the READY camera');
  assert.strictEqual(recording.sync.startAtServerMs, rec.at);

  await putChunks(s.id, take.id, 'camA', token);
  const st = await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'status'));
  assert.deepStrictEqual(st.json, { have: [0, 1, 2], assembled: false });

  // STOP → halt (a repeated STOP repeats the same halt)
  dir.send({ t: 'stop', takeId: take.id });
  const halt = await camA.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt on the camera');
  dir.send({ t: 'stop', takeId: take.id });
  const halt2 = await camA.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'the repeated halt');
  assert.strictEqual(halt2.at, halt.at, 'a repeated STOP repeats the same halt time');
  await waitTake(s.id, take.id, (t) => t.state === 'uploading', 'uploading after STOP');

  // complete: 200 only once the bucket has the video, the frame times and the record pointing at them
  const body = completeBody();
  const r = await capi(token, 'POST', recUrl(s.id, take.id, 'camA', 'complete'), body);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const bVideo = bucketPath(s.id, 'takes', take.id, 'camA.webm');
  const bFrames = bucketPath(s.id, 'takes', take.id, 'camA.frames.json');
  const bTake = bucketPath(s.id, 'takes', take.id, 'take.json');
  assert.ok(fs.existsSync(bVideo), 'bucket has camA.webm');
  assert.ok(fs.existsSync(bFrames), 'bucket has camA.frames.json');
  assert.ok(fs.existsSync(bTake), 'bucket has take.json');
  assert.ok(fs.readFileSync(bVideo).equals(VIDEO), 'the bucket video is the chunks, in order');
  assert.deepStrictEqual(readJson(bFrames).frames, body.frames);
  const tj = readJson(bTake);
  assert.strictEqual(tj.cameras.camA.file, 'camA.webm', 'the bucket record points at the video');
  assert.strictEqual(tj.cameras.camA.framesFile, 'camA.frames.json');
  assert.strictEqual(tj.cameras.camA.mirrored, true);
  assert.strictEqual(tj.cameras.camA.bytes, VIDEO.length);
  assert.ok(fs.existsSync(bucketPath(s.id, 'session.json')), 'bucket has session.json');
  assert.ok(!fs.existsSync(diskPath(s.id, 'takes', take.id, 'uploads', 'camA')), 'the chunks are dropped once the recording is saved');

  // → checked → SAVED by itself, nobody reviews (single camera: expectedCams); the newest take is selected
  const done = await waitTake(s.id, take.id, (t) => t.state === 'accepted', 'saved');
  assert.deepStrictEqual(done.cams, ['camA']);
  assert.ok(done.validation && Array.isArray(done.validation.checks), 'validation ran');
  assert.ok(done.cameras.camA.fileInfo?.ok, 'probe result merged into the record');
  assert.ok(done.cameras.camA.motion?.bbox, 'motion map merged into the record');
  assert.strictEqual(done.autoSaved, true);
  assert.strictEqual(done.selected, true);
  await dir.waitFor((m) => m.t === 'take' && m.take?.id === take.id && m.take.state === 'accepted', 'the saved update on the director');
  assert.strictEqual(readJson(bTake).state, 'accepted', 'the saved state is mirrored too');
  const bs = readJson(bucketPath(s.id, 'session.json')).animations[anim.id];
  assert.strictEqual(bs.selectedTake, take.id, 'selected in the bucket');
  assert.strictEqual(bs.results[take.id].state, 'recorded');
  assert.deepStrictEqual(bs.results[take.id].cams, ['camA']);
  // a retried complete (the phone never heard the 200) is answered from the saved record
  const again = await capi(token, 'POST', recUrl(s.id, take.id, 'camA', 'complete'), body);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.take.cameras.camA.bytes, VIDEO.length);

  camA.close(); dir.close();
  FIRST = { s, token, take: done };
});

test('(b) redeploy: disk wiped, a new server restores the session, the take, video, still.jpg, export.tar and the calibration reference from the bucket', async () => {
  assert.ok(FIRST, 'needs the take from test (a)');
  const { s, token, take } = FIRST;
  const ref = { w: 64, h: 36, px: Array.from({ length: 64 * 36 }, (_, i) => (i * 7) % 256) };
  const put = await capi(token, 'PUT', `/api/capture/sessions/${s.id}/calref/A/camB`, ref);
  assert.strictEqual(put.status, 200, JSON.stringify(put.json));

  await redeploy();
  assert.ok(!fs.existsSync(path.join(DISK, 'sessions', s.id)), 'the disk really is empty');

  // the first requests after the redeploy arrive together (the takes list: videos, a still, …):
  // they share one download from the bucket and none of them sees a half-written file
  const vurl = recUrl(s.id, take.id, 'camA', 'video');
  const burst = await Promise.all([
    dapi('GET', vurl), dapi('GET', vurl), request('GET', vurl, { headers: { ...DIRECTOR, Range: 'bytes=0-999' } }),
    dapi('GET', recUrl(s.id, take.id, 'camA', 'still.jpg')), dapi('GET', `/api/capture/sessions/${s.id}/export.tar?all=1`),
  ]);
  assert.deepStrictEqual(burst.map((r) => r.status), [200, 200, 206, 200, 200]);
  assert.ok(burst[0].buf.equals(VIDEO) && burst[1].buf.equals(VIDEO), 'concurrent restores serve the whole video');
  assert.ok(burst[2].buf.equals(VIDEO.subarray(0, 1000)));

  const gs = await dapi('GET', `/api/capture/sessions/${s.id}`);
  assert.strictEqual(gs.status, 200, JSON.stringify(gs.json));
  assert.strictEqual(gs.json.session.id, s.id);
  assert.strictEqual(gs.json.session.pair.token, s.pair.token);
  assert.deepStrictEqual(gs.json.session.animations[take.animId].takes, [take.id]);
  const list = await dapi('GET', '/api/capture/sessions');
  assert.ok(list.json.sessions.some((x) => x.id === s.id), 'the session is listed from the bucket');

  const t = await getTake(s.id, take.id);
  assert.strictEqual(t.state, 'accepted');
  assert.strictEqual(t.cameras.camA.file, 'camA.webm');
  assert.deepStrictEqual(t.expectedCams, ['camA']);

  const v = await dapi('GET', recUrl(s.id, take.id, 'camA', 'video'));
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.headers['content-type'], 'video/webm');
  assert.ok(v.buf.equals(VIDEO), `video bytes restored (${v.buf.length} vs ${VIDEO.length})`);
  const range = await request('GET', recUrl(s.id, take.id, 'camA', 'video'), { headers: { ...DIRECTOR, Range: 'bytes=100-199' } });
  assert.strictEqual(range.status, 206);
  assert.ok(range.buf.equals(VIDEO.subarray(100, 200)));

  const still = await dapi('GET', recUrl(s.id, take.id, 'camA', 'still.jpg'));
  assert.strictEqual(still.status, 200, still.buf.toString().slice(0, 200));
  assert.strictEqual(still.headers['content-type'], 'image/jpeg');
  assert.ok(still.buf[0] === 0xff && still.buf[1] === 0xd8, 'a JPEG');

  const ex = await dapi('GET', `/api/capture/sessions/${s.id}/export.tar?all=1`);
  assert.strictEqual(ex.status, 200);
  assert.strictEqual(ex.headers['content-type'], 'application/x-tar');
  const files = untar(ex.buf);
  const names = [...files.keys()];
  const folder = `SoulJam_BASIC01/setup_${take.courtSetup}/${take.animKey}/take01`;
  assert.ok(files.has(`${folder}/camA.frames.json`), `export has camA.frames.json: ${names.join(', ')}`);
  assert.ok(files.has(`${folder}/metadata.json`), 'export has metadata.json');
  assert.ok(files.get(`${folder}/camA.webm`)?.equals(VIDEO), 'export has the video');
  assert.strictEqual(JSON.parse(files.get(`${folder}/metadata.json`)).id, take.id);
  assert.strictEqual(JSON.parse(files.get(`${folder}/camA.frames.json`)).frames.length, 60);
  const sj = JSON.parse(files.get('SoulJam_BASIC01/session.json'));
  assert.strictEqual(sj.missingFiles, undefined, `no file missing from the export: ${sj.missingFiles}`);
  assert.strictEqual(sj.session.pair, undefined, 'the pairing token is not exported');

  // the camera token still works (checked against the stored session), the reference view is back
  const st = await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'status'));
  assert.strictEqual(st.status, 200);
  const cr = await capi(token, 'GET', `/api/capture/sessions/${s.id}/calref/A/camB`);
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.json));
  assert.deepStrictEqual(cr.json.ref.px, ref.px);
});

test('(c) redeploy mid-upload + mid-take: STOP still works on the new server, lost chunks are reported (409 missing) and the re-sent chunks complete the take', async () => {
  const s = await newSession('server-test c');
  const token = await pairByToken(s);
  let camA = await camera(s.id, token, 'camA');
  let dir = await directorWs(s.id);
  await setReady(dir, [[camA, true]]);
  const take = await armTake(s.id, ANIMS[1].id);
  dir.send({ t: 'start', takeId: take.id });
  await camA.waitFor((m) => m.t === 'record' && m.takeId === take.id, 'record');
  await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  await putChunks(s.id, take.id, 'camA', token, [0, 1]);
  assert.deepStrictEqual((await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'status'))).json.have, [0, 1]);

  await redeploy();                                   // the chunks were only on the wiped disk

  // the director's STOP on the new server (nothing armed in its memory) still stops the take
  camA = await camera(s.id, token, 'camA');
  dir = await directorWs(s.id);
  dir.send({ t: 'stop', takeId: take.id });
  await camA.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt after the restart');
  const stopped = await waitTake(s.id, take.id, (t) => t.state === 'uploading', 'uploading after the STOP');
  assert.ok(Number.isFinite(stopped.sync.stopAtServerMs));

  const r = await complete(s.id, take.id, 'camA', token);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.missing, [0, 1, 2]);
  assert.deepStrictEqual((await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'status'))).json.have, []);
  assert.ok(!fs.existsSync(bucketPath(s.id, 'takes', take.id, 'camA.webm')), 'nothing half-saved');

  await putChunks(s.id, take.id, 'camA', token);        // the phone re-sends what the server lost
  const r2 = await complete(s.id, take.id, 'camA', token);
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  assert.ok(fs.readFileSync(bucketPath(s.id, 'takes', take.id, 'camA.webm')).equals(VIDEO));
  const done = await waitTake(s.id, take.id, (t) => t.state === 'accepted', 'saved');
  assert.strictEqual(done.cameras.camA.bytes, VIDEO.length);
  camA.close(); dir.close();
});

test('(c) the bucket refuses the video: no 200, the record does not point at a file, the chunks stay on the server; the retried complete succeeds without re-sending', async () => {
  const s = await newSession('server-test c2');
  const token = await pairByToken(s);
  const take = await armTake(s.id, ANIMS[11].id);
  await putChunks(s.id, take.id, 'camA', token);
  const dirB = bucketPath(s.id, 'takes', take.id);
  fs.chmodSync(dirB, 0o555);                             // the bucket stops taking writes for this take
  let r;
  try { r = await complete(s.id, take.id, 'camA', token); }
  finally { fs.chmodSync(dirB, 0o755); }
  assert.ok(r.status >= 500, `complete → ${r.status} ${JSON.stringify(r.json)} (the phone must keep its copy)`);
  const t = await getTake(s.id, take.id);
  assert.strictEqual(t.cameras.camA, undefined, 'the record does not point at an unsaved recording');
  assert.strictEqual(readJson(bucketPath(s.id, 'takes', take.id, 'take.json')).cameras.camA, undefined);
  assert.ok(!fs.existsSync(bucketPath(s.id, 'takes', take.id, 'camA.webm')));
  assert.deepStrictEqual((await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'status'))).json, { have: [0, 1, 2], assembled: false }, 'the chunks are kept');
  const r2 = await complete(s.id, take.id, 'camA', token);          // the uploader's retry, same chunks
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  assert.ok(fs.readFileSync(bucketPath(s.id, 'takes', take.id, 'camA.webm')).equals(VIDEO));
  assert.strictEqual(readJson(bucketPath(s.id, 'takes', take.id, 'take.json')).cameras.camA.file, 'camA.webm');
  await waitTake(s.id, take.id, (x) => x.state === 'accepted', 'saved');
});

test('(d) expected cameras: only camA READY at RECORD → the take is saved with camA alone (camB connected, not ready)', async () => {
  const s = await newSession('server-test d1');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const camB = await camera(s.id, token, 'camB');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true], [camB, false]]);
  const take = await armTake(s.id, ANIMS[2].id);
  dir.send({ t: 'start', takeId: take.id });
  await camA.waitFor((m) => m.t === 'record' && m.takeId === take.id, 'record on camA');
  const t1 = await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  assert.deepStrictEqual(t1.expectedCams, ['camA']);
  dir.send({ t: 'stop', takeId: take.id });
  await dir.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt');
  await putChunks(s.id, take.id, 'camA', token);
  assert.strictEqual((await complete(s.id, take.id, 'camA', token)).status, 200);
  const done = await waitTake(s.id, take.id, (t) => t.state === 'accepted', 'saved without camB');
  assert.deepStrictEqual(done.cams, ['camA']);
  assert.strictEqual(done.cameras.camB, undefined);
  assert.ok(done.validation.checks.some((c) => c.id === 'cameras' && c.level === 'ok'), JSON.stringify(done.validation.checks));
  camA.close(); camB.close(); dir.close();
});

test('(d) POST …/finish: both cameras expected, camB never uploads → the take goes on with camA alone; camB arriving later is still added', async () => {
  const s = await newSession('server-test d2');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const camB = await camera(s.id, token, 'camB');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true], [camB, true]]);
  const take = await armTake(s.id, ANIMS[3].id);
  dir.send({ t: 'start', takeId: take.id });
  await camB.waitFor((m) => m.t === 'record' && m.takeId === take.id, 'record on camB');
  const t1 = await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  assert.deepStrictEqual(t1.expectedCams, ['camA', 'camB']);
  dir.send({ t: 'stop', takeId: take.id });
  await dir.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt');
  await waitTake(s.id, take.id, (t) => t.state === 'uploading', 'uploading');
  await putChunks(s.id, take.id, 'camA', token);
  assert.strictEqual((await complete(s.id, take.id, 'camA', token)).status, 200);
  // camB is expected: the take waits (nothing would move it to validating in the meantime)
  await sleep(400);
  const waiting = await getTake(s.id, take.id);
  assert.strictEqual(waiting.state, 'uploading', 'waits for the expected camB');
  // a camera cannot decide that; the director can
  assert.strictEqual((await capi(token, 'POST', recUrl(s.id, take.id, null, 'finish'), {})).status, 401);
  const f = await dapi('POST', recUrl(s.id, take.id, null, 'finish'), {});
  assert.strictEqual(f.status, 200, JSON.stringify(f.json));
  assert.strictEqual(f.json.take.state, 'accepted', 'checked and saved with camA');
  assert.deepStrictEqual(f.json.take.expectedCams, ['camA']);
  assert.deepStrictEqual(f.json.take.finishedWithout, ['camB']);
  assert.deepStrictEqual(f.json.take.cams, ['camA']);
  // finish again: the take is no longer waiting
  assert.strictEqual((await dapi('POST', recUrl(s.id, take.id, null, 'finish'), {})).status, 409);
  // camB's footage turns up after all: kept with the take, which stays saved
  await putChunks(s.id, take.id, 'camB', token);
  assert.strictEqual((await complete(s.id, take.id, 'camB', token)).status, 200);
  const later = await getTake(s.id, take.id);
  assert.strictEqual(later.cameras.camB.file, 'camB.webm');
  assert.strictEqual(later.state, 'accepted');
  assert.strictEqual(later.cameras.camB.arrivedAfterAccept, true);
  assert.ok(fs.existsSync(bucketPath(s.id, 'takes', take.id, 'camB.webm')));
  camA.close(); camB.close(); dir.close();
});

test('(e) SAVED by itself (mirrored): the newest recorded take is selected; MARK BEST moves it; a manual accept with select:false keeps it', async () => {
  const s = await newSession('server-test e');
  const token = await pairByToken(s);
  const anim = ANIMS[4];
  const t1 = await uploadedTake(s.id, token, anim.id);
  // (a take's record says "accepted" first; the selected marks follow the session's selection a moment later)
  const selected = async (a, b, want) => {
    let got;
    for (const t0 = Date.now(); ;) {
      const x = await getTake(s.id, a.id), y = await getTake(s.id, b.id);
      const bx = readJson(bucketPath(s.id, 'takes', a.id, 'take.json')), by = readJson(bucketPath(s.id, 'takes', b.id, 'take.json'));
      got = [x.selected, y.selected];
      if ((JSON.stringify(got) === JSON.stringify(want) && JSON.stringify([bx.selected, by.selected]) === JSON.stringify(got)) || Date.now() - t0 > 8000) {
        assert.deepStrictEqual([bx.selected, by.selected], got, 'the bucket agrees');
        return got;
      }
      await sleep(100);
    }
  };
  assert.strictEqual(readJson(bucketPath(s.id, 'takes', t1.id, 'take.json')).state, 'accepted', 'saved in the bucket');
  assert.strictEqual(readJson(bucketPath(s.id, 'session.json')).animations[anim.id].selectedTake, t1.id, 'progress in the bucket');
  const t2 = await uploadedTake(s.id, token, anim.id);
  assert.deepStrictEqual([t1.takeNo, t2.takeNo], [1, 2]);
  assert.deepStrictEqual(await selected(t1, t2, [false, true]), [false, true], 'the newest recorded take is the selected one');

  const sel = await dapi('POST', recUrl(s.id, t1.id, null, 'select'), {});
  assert.strictEqual(sel.status, 200, JSON.stringify(sel.json));
  assert.strictEqual(sel.json.session.animations[anim.id].selectedTake, t1.id);
  assert.deepStrictEqual(await selected(t1, t2, [true, false]), [true, false], 'MARK BEST moves the mark');

  // the accept API stays: accepting take 2 again without selecting it keeps take 1
  const a3 = await dapi('POST', recUrl(s.id, t2.id, null, 'accept'), { force: true, select: false });
  assert.strictEqual(a3.status, 200, JSON.stringify(a3.json));
  assert.strictEqual(a3.json.saved, true);
  assert.deepStrictEqual(await selected(t1, t2, [true, false]), [true, false]);
  const sess = await getSession(s.id);
  assert.strictEqual(sess.session.animations[anim.id].selectedTake, t1.id);
  assert.strictEqual(sess.progress.complete, 1);
  assert.deepStrictEqual(Object.values(sess.session.animations[anim.id].results).map((r) => r.state), ['recorded', 'recorded']);
});

test('(e) the bucket refuses the session write while a take is saved: it is not reported saved (no selection in the bucket or on disk); the next GET once the bucket works → SAVED', async () => {
  const s = await newSession('server-test e2');
  const token = await pairByToken(s);
  const anim = ANIMS[10];
  const take = await armTake(s.id, anim.id);
  await putChunks(s.id, take.id, 'camA', token);
  const bSession = bucketPath(s.id, 'session.json');
  fs.mkdirSync(`${bSession}.part`);                      // the bucket refuses session.json (the take's own files still go in)
  try {
    assert.strictEqual((await complete(s.id, take.id, 'camA', token)).status, 200);
    await waitTake(s.id, take.id, (t) => t.state === 'accepted', 'the take record saved');
    await sleep(300);
    assert.strictEqual(readJson(bSession).animations[anim.id].selectedTake, null, 'progress not marked in the bucket');
    assert.strictEqual(readJson(bSession).animations[anim.id].results, undefined);
    const now = await getSession(s.id);
    assert.strictEqual(now.session.animations[anim.id].selectedTake, null, 'nor on disk');
    assert.strictEqual(now.progress.complete, 0);
  } finally { fs.rmSync(`${bSession}.part`, { recursive: true, force: true }); }
  // the director's next reads settle it
  const deadline = Date.now() + 30000;
  let sess;
  for (;;) {
    sess = await getSession(s.id);
    if (sess.session.animations[anim.id].selectedTake === take.id) break;
    if (Date.now() > deadline) assert.fail('the take was never marked saved in the session after the bucket came back');
    await sleep(500);
  }
  assert.strictEqual(readJson(bSession).animations[anim.id].selectedTake, take.id);
  assert.strictEqual(readJson(bSession).animations[anim.id].results[take.id].state, 'recorded');
  assert.strictEqual(sess.progress.complete, 1);
});

test('(f) late STOP: a take already saved is not moved back by a STOP', async () => {
  const s = await newSession('server-test f');
  const token = await pairByToken(s);
  const take = await uploadedTake(s.id, token, ANIMS[5].id);
  assert.strictEqual(take.sync.stopAtServerMs, undefined);
  const dir = await directorWs(s.id);
  dir.send({ t: 'stop', takeId: take.id });
  await dir.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt');
  // the STOP's write has landed once the stop time is on the record
  const t = await waitTake(s.id, take.id, (x) => Number.isFinite(x.sync?.stopAtServerMs), 'the STOP written');
  assert.strictEqual(t.state, 'accepted', 'still saved');
  const acc = await dapi('POST', recUrl(s.id, take.id, null, 'accept'), { force: true });
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.json));
  dir.send({ t: 'stop', takeId: take.id });
  await dir.waitFor((m) => m.t === 'halt' && m.takeId === take.id, 'halt 2');
  await sleep(300);
  const t2 = await getTake(s.id, take.id);
  assert.strictEqual(t2.state, 'accepted', 'still accepted');
  assert.strictEqual(readJson(bucketPath(s.id, 'takes', take.id, 'take.json')).state, 'accepted');
  dir.close();
});

test('(g) security: a pairing token cannot take the director role (close 4001), cannot join another session, a wrong token gets 401', async () => {
  const s = await newSession('server-test g1');
  const other = await newSession('server-test g1 other');
  const token = await pairByToken(s);
  const c = new Sock(`session=${s.id}&token=${token}`);
  await c.opened;
  c.send({ t: 'hello', role: 'director', deviceId: 'sneaky' });
  const err = await c.waitFor((m) => m.t === 'error', 'the refusal');
  assert.match(err.msg, /sign-in/);
  const closed = await within(c.closed, 5000, 'the socket to be closed');
  assert.strictEqual(closed.code, 4001);
  // start / stop as a camera: ignored
  const cam = await camera(s.id, token, 'camA');
  const take = await armTake(s.id, ANIMS[6].id);
  cam.send({ t: 'start', takeId: take.id });
  cam.send({ t: 'stop', takeId: take.id });
  await sleep(300);
  assert.strictEqual((await getTake(s.id, take.id)).state, 'armed', 'a camera cannot start or stop a take');
  cam.close();
  // this session's token for another session, and a made-up token
  const x = new Sock(`session=${other.id}&token=${token}`);
  await assert.rejects(x.opened, (e) => e.status === 401);
  const y = new Sock(`session=${s.id}&token=${'x'.repeat(24)}`);
  await assert.rejects(y.opened, (e) => e.status === 401);
  const z = new Sock(`session=${s.id}`);                  // no token, not signed in
  await assert.rejects(z.opened, (e) => e.status === 401);
});

test('(g) security: a second page for camB replaces the first ({t:"replaced"} + close 4000); session.json records the device only when it changes', async () => {
  const s = await newSession('server-test g2');
  const token = await pairByToken(s);
  const b1 = await camera(s.id, token, 'camB', 'phone-1');
  assert.strictEqual((await dapi('GET', `/api/capture/sessions/${s.id}`)).json.session.devices.camB.deviceId, 'phone-1');
  const b2 = await camera(s.id, token, 'camB', 'phone-2');
  const rep = await b1.waitFor((m) => m.t === 'replaced', 'replaced on the first page');
  assert.strictEqual(rep.role, 'camB');
  assert.strictEqual((await within(b1.closed, 5000, 'the first page to be closed')).code, 4000);
  const d2 = (await dapi('GET', `/api/capture/sessions/${s.id}`)).json.session.devices.camB;
  assert.strictEqual(d2.deviceId, 'phone-2');
  // the same phone again (a reconnect): the role moves to the new socket, session.json is not rewritten
  const mtime = fs.statSync(bucketPath(s.id, 'session.json')).mtimeMs;
  const before = readJson(bucketPath(s.id, 'session.json')).updatedAt;
  const b3 = await camera(s.id, token, 'camB', 'phone-2');
  assert.strictEqual((await within(b2.closed, 5000, 'the second page to be closed')).code, 4000);
  const after = readJson(bucketPath(s.id, 'session.json'));
  assert.strictEqual(after.updatedAt, before, 'no session write for the same device');
  assert.strictEqual(fs.statSync(bucketPath(s.id, 'session.json')).mtimeMs, mtime);
  assert.strictEqual(after.devices.camB.since, d2.since);
  b3.close();
});

test('(g) security: a camera token cannot accept, export, list sessions, read a take record or touch another session', async () => {
  const s = await newSession('server-test g3');
  const other = await newSession('server-test g3 other');
  const token = await pairByToken(s);
  const take = await uploadedTake(s.id, token, ANIMS[7].id);
  const otherTake = await armTake(other.id, ANIMS[7].id);
  const no = (r) => [401, 403].includes(r.status);
  assert.ok(no(await capi(token, 'POST', recUrl(s.id, take.id, null, 'accept'), { force: true })), 'accept');
  assert.ok(no(await capi(token, 'POST', recUrl(s.id, take.id, null, 'reject'), {})), 'reject');
  assert.ok(no(await capi(token, 'GET', `/api/capture/sessions/${s.id}/export.tar`)), 'export.tar');
  assert.ok(no(await capi(token, 'GET', `/api/capture/sessions/${s.id}/export.tar?all=1`)), 'export.tar?all=1');
  assert.ok(no(await capi(token, 'GET', `/api/capture/sessions/${s.id}/pair`)), 'pair screen (the code)');
  assert.ok(no(await capi(token, 'GET', '/api/capture/sessions')), 'session list');
  assert.ok(no(await capi(token, 'POST', `/api/capture/sessions/${s.id}/takes`, { animId: ANIMS[7].id })), 'arm a take');
  assert.ok(no(await capi(token, 'GET', recUrl(s.id, take.id))), 'the take record');
  assert.ok(no(await capi(token, 'GET', recUrl(s.id, take.id, 'camA', 'video'))), 'the video');
  // another session: nothing
  assert.ok(no(await capi(token, 'GET', `/api/capture/sessions/${other.id}`)), 'read another session');
  assert.ok(no(await capi(token, 'PUT', recUrl(other.id, otherTake.id, 'camA', 'chunk/0'), PARTS[0])), 'upload into another session');
  assert.ok(no(await capi(token, 'GET', recUrl(other.id, otherTake.id, 'camA', 'status'))), 'status of another session');
  // its own session: readable, without the pairing token
  const own = await capi(token, 'GET', `/api/capture/sessions/${s.id}`);
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.json.director, false);
  assert.strictEqual(own.json.session.pair.token, undefined, 'the token is not handed back');
  // chunk caps
  assert.strictEqual((await capi(token, 'PUT', recUrl(s.id, otherTake.id, 'camA', 'chunk/0'), PARTS[0])).status, 404, 'take id of another session under this one');
  const t2 = await armTake(s.id, ANIMS[8].id);
  assert.strictEqual((await capi(token, 'PUT', recUrl(s.id, t2.id, 'camA', 'chunk/2000'), Buffer.from('x'))).status, 400, 'chunk 2000 refused');
  assert.strictEqual((await capi(token, 'POST', recUrl(s.id, t2.id, 'camA', 'complete'), { chunks: 2001 })).status, 400, '2001 chunks refused');
});

test('(g) security: request bodies are capped (1 MB pairing body → 413 / connection closed) and the server stays up', async () => {
  const big = Buffer.alloc(1 << 20, 0x61);
  const huge = Buffer.concat([Buffer.from('{"code":"'), big, Buffer.from('"}')]);
  const r = await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: huge }).catch((e) => ({ status: 'closed', err: e.code || e.message }));
  assert.ok(r.status === 413 || r.status === 'closed', `pair with 1 MB → ${r.status} ${r.err || ''}`);
  await assertHealthy('after the 1 MB pairing body');
  // a director route (256 KB cap)
  const s = await newSession('server-test g4');
  const r2 = await request('POST', `/api/capture/sessions/${s.id}/takes`, { headers: { ...DIRECTOR, 'Content-Type': 'application/json' }, body: Buffer.concat([Buffer.from('{"animId":"'), Buffer.alloc(300 << 10, 0x61), Buffer.from('"}')]) }).catch((e) => ({ status: 'closed', err: e.code || e.message }));
  assert.ok(r2.status === 413 || r2.status === 'closed', `takes with 300 KB → ${r2.status}`);
  await assertHealthy('after the 300 KB body');
  assert.deepStrictEqual((await dapi('GET', `/api/capture/sessions/${s.id}`)).json.session.animations, {}, 'nothing armed by the oversized request');
});

test('(g) security: 13 wrong pairing codes from one client → 429 (keyed on the right-most X-Forwarded-For hop)', async () => {
  const client = nextIp();
  const statuses = [];
  for (let i = 0; i < 13; i++) {
    // the left hops are the client's to write: changing them must not reset the limit
    const r = await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${i}.1, ${client}` }, body: Buffer.from(JSON.stringify({ code: '000000' })) });
    statuses.push(r.status);
  }
  assert.deepStrictEqual(statuses, [...Array(12).fill(404), 429]);
  // another client is not affected
  const s = await newSession('server-test g5');
  const ok = await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: Buffer.from(JSON.stringify({ code: s.pair.code })) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.sessionId, s.id);
});

test('(g) security: an expired pairing code is refused (404); the director\'s pair screen issues a live code that pairs', async () => {
  const s = await newSession('server-test g6');
  const past = new Date(Date.now() - 60000).toISOString();
  await redeploy({
    wipe: false,
    between: () => {
      for (const f of [bucketPath(s.id, 'session.json'), diskPath(s.id, 'session.json')]) {
        const j = readJson(f); j.pair.codeExpiresAt = past; fs.writeFileSync(f, JSON.stringify(j));
      }
    },
  });
  const pairCode = (code) => request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: Buffer.from(JSON.stringify({ code })) });
  const r = await pairCode(s.pair.code);
  assert.strictEqual(r.status, 404, JSON.stringify(r.json));
  const p = await dapi('GET', `/api/capture/sessions/${s.id}/pair`);
  assert.strictEqual(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.code, /^\d{6}$/);
  assert.ok(Date.parse(p.json.codeExpiresAt) > Date.now() + 14 * 60000, 'live for 15 minutes');
  assert.ok(p.json.urls.some((u) => u.url.includes(`pair=${s.pair.token}`)));
  const r2 = await pairCode(p.json.code);
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  assert.strictEqual(r2.json.sessionId, s.id);
  assert.strictEqual(r2.json.token, s.pair.token);
  // the QR token never expires
  assert.strictEqual((await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: Buffer.from(JSON.stringify({ token: s.pair.token })) })).status, 200);
});

test('(g) security: the global cap — 60 wrong codes a minute from any clients → every code attempt gets 429; the QR token still pairs', async () => {
  const s = await newSession('server-test g7');
  const code = (c, ip) => request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: Buffer.from(JSON.stringify({ code: c })) });
  let n = 0, got = null;
  for (; n < 70; n++) {                                     // a new client each time: never the per-client limit
    const r = await code('000000', `192.0.2.${n + 1}`);
    if (r.status === 429) { got = r; break; }
    assert.strictEqual(r.status, 404);
  }
  assert.ok(got && n <= 60, `the global cap answered 429 after ${n} wrong codes`);
  const right = await code(s.pair.code, '192.0.2.200');
  assert.strictEqual(right.status, 429, 'while the cap holds, codes are not looked up at all');
  const tok = await request('POST', '/api/capture/pair', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.201' }, body: Buffer.from(JSON.stringify({ token: s.pair.token })) });
  assert.strictEqual(tok.status, 200, 'the QR token is not affected');
});

test('(h) crash resistance: a 1 MB WebSocket frame, an upgrade for "//" and an upgrade to "/other" — the server stays up', async () => {
  const s = await newSession('server-test h');
  const token = await pairByToken(s);
  const dir = await directorWs(s.id);
  const cam = await camera(s.id, token, 'camA');
  cam.send(JSON.stringify({ t: 'state', state: { ready: true }, pad: 'x'.repeat(1 << 20) }));
  const closed = await within(cam.closed, 5000, 'the over-size socket to be closed');
  assert.ok([1009, 1006].includes(closed.code), `the over-size socket is dropped (close ${closed.code})`);
  await assertHealthy('after the 1 MB frame');
  // the rest of the room is unaffected
  dir.send({ t: 'ping', c: 1 });
  await dir.waitFor((m) => m.t === 'pong' && m.c === 1, 'pong on the director socket');

  const upgrade = (target) => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
  const a = await rawExchange(upgrade('//'));
  assert.ok(!/^HTTP\/1\.1 101/.test(a.got), `no upgrade for // (${a.how})`);
  assert.notStrictEqual(a.how, 'timeout', 'the socket is closed');
  await assertHealthy('after an upgrade for //');
  const b = await rawExchange(upgrade('/other'));
  assert.ok(!/^HTTP\/1\.1 101/.test(b.got), `no upgrade for /other (${b.how})`);
  assert.notStrictEqual(b.how, 'timeout', 'the socket is closed');
  await assertHealthy('after an upgrade to /other');
  const c = await rawExchange(upgrade(`/api/capture/ws?session=${s.id}&token=%E0%A4%A`));
  assert.ok(!/^HTTP\/1\.1 101/.test(c.got), 'a malformed token is not let in');
  await assertHealthy('after a malformed ws query');
  // and the hub still works
  const cam2 = await camera(s.id, token, 'camA');
  cam2.close(); dir.close();
});

test('redeploy while a take is being validated: the take is not stuck in "validating" on the new server', async (t0) => {
  const s = await newSession('server-test validating');
  const token = await pairByToken(s);
  const dir = await directorWs(s.id);
  const take = await armTake(s.id, ANIMS[9].id);
  await putChunks(s.id, take.id, 'camA', token);
  assert.strictEqual((await complete(s.id, take.id, 'camA', token)).status, 200);
  // the moment the server says "validating", the container goes away (a push to main mid-session)
  await dir.waitFor((m) => m.t === 'take' && m.take?.id === take.id && m.take.state === 'validating', 'validating');
  await stopServer();
  const bTake = bucketPath(s.id, 'takes', take.id, 'take.json');
  const j = readJson(bTake);
  if (j.state !== 'validating') {                       // the checks beat the kill: leave what a mid-check kill leaves
    Object.assign(j, { state: 'validating', validatingAt: new Date().toISOString(), validation: null });
    fs.writeFileSync(bTake, JSON.stringify(j));
    t0.diagnostic('the checks finished before the kill: the bucket record was set to what a mid-check kill leaves');
  } else t0.diagnostic('killed mid-validation: the bucket record says "validating"');
  fs.rmSync(DISK, { recursive: true, force: true });
  await startServer();
  // nobody has to do anything: the take is checked again and saved
  const deadline = Date.now() + 8000;
  let t = null;
  while (Date.now() < deadline) { t = await getTake(s.id, take.id); if (t.state === 'accepted') break; await sleep(250); }
  if (t.state !== 'accepted') {
    const f = await dapi('POST', recUrl(s.id, take.id, null, 'finish'), {});
    const a = await dapi('POST', recUrl(s.id, take.id, null, 'accept'), { force: true });
    assert.fail(`still "${t.state}" 5 s after the redeploy; finish → ${f.status} ${f.json?.error}; accept → ${a.status} ${a.json?.error}`);
  }
});

test('complete when the bucket refuses the take record: a retried complete answers 200 only once the bucket record points at the video', async () => {
  if (!alive()) await startServer();
  const s = await newSession('server-test record-mirror');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const camB = await camera(s.id, token, 'camB');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true], [camB, true]]);
  const take = await armTake(s.id, ANIMS[12].id);
  dir.send({ t: 'start', takeId: take.id });
  await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  dir.send({ t: 'stop', takeId: take.id });
  await waitTake(s.id, take.id, (t) => t.state === 'uploading', 'uploading');   // camA + camB expected
  await putChunks(s.id, take.id, 'camA', token);
  const bTake = bucketPath(s.id, 'takes', take.id, 'take.json');
  fs.mkdirSync(`${bTake}.part`);                        // the bucket refuses take.json (the video still goes in)
  let r;
  try { r = await complete(s.id, take.id, 'camA', token); }
  finally { fs.rmSync(`${bTake}.part`, { recursive: true, force: true }); }
  assert.ok(r.status >= 500, `the first complete fails (${r.status})`);
  const r2 = await complete(s.id, take.id, 'camA', token);   // the uploader retries once the bucket is back
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  const inBucket = readJson(bTake).cameras?.camA?.file;
  if (!inBucket) {
    camA.close(); camB.close(); dir.close();
    await redeploy();
    const t = await getTake(s.id, take.id);
    assert.fail(`complete answered 200 (the phone drops its chunks) but the bucket's take.json has no camA; after a redeploy the take has cameras ${JSON.stringify(Object.keys(t.cameras || {}))} (state ${t.state}) although camA.webm is in the bucket: ${fs.existsSync(bucketPath(s.id, 'takes', take.id, 'camA.webm'))}`);
  }
  assert.strictEqual(inBucket, 'camA.webm');
  camA.close(); camB.close(); dir.close();
});

test('crash resistance: a plain HTTP "GET //" does not take the server down', async () => {
  if (!alive()) await startServer();
  const r = await rawExchange('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  await sleep(300);
  const up = alive();
  if (!up) {
    const out = srv.out();
    await stopServer();
    await startServer();                                  // leave a running server for anything after this
    assert.fail(`the server process exited on "GET //" (${r.how}):\n${out.split('\n').filter((l) => /Invalid URL|ERR_INVALID_URL|at /.test(l)).slice(0, 4).join('\n')}`);
  }
  await assertHealthy('after GET //');
});

// ═══ the new flow: camera checks, live snapshots, "needs redo", the analysis queue ══════════════════

test('(i) camera check: a 2 s test through the whole path; each camera gets a verdict for its device (session.cameraChecks); a 5-byte recording fails; a check is never a take', async () => {
  if (!alive()) await startServer();
  const s = await newSession('server-test check');
  const token = await pairByToken(s);
  assert.strictEqual((await capi(token, 'POST', `/api/capture/sessions/${s.id}/checks`, {})).status, 401, 'a camera cannot start a check');
  const camA = await camera(s.id, token, 'camA', 'phone-a');
  const camB = await camera(s.id, token, 'camB', 'phone-b');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true], [camB, true]]);
  const r = await dapi('POST', `/api/capture/sessions/${s.id}/checks`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const chk = r.json.check;
  assert.match(chk.id, /^chk-/);
  assert.strictEqual(chk.kind, 'check');
  await camB.waitFor((m) => m.t === 'armed' && m.armed?.takeId === chk.id && m.armed.kind === 'check', 'the check armed on camB');
  dir.send({ t: 'start', takeId: chk.id });
  await camA.waitFor((m) => m.t === 'record' && m.takeId === chk.id, 'record');
  await waitTake(s.id, chk.id, (t) => t.state === 'recording', 'recording');
  dir.send({ t: 'stop', takeId: chk.id });
  await camB.waitFor((m) => m.t === 'halt' && m.takeId === chk.id, 'halt');
  // camA: real video · camB: an iPhone whose recorder gave 5 bytes and whose page saw no frames
  await putChunks(s.id, chk.id, 'camA', token);
  assert.strictEqual((await complete(s.id, chk.id, 'camA', token, { meta: { source: 'web', deviceId: 'phone-a', track: { frameRate: 30, width: 640, height: 360 }, frames: { frames: 60, fps: 30 } } })).status, 200);
  assert.strictEqual((await capi(token, 'PUT', recUrl(s.id, chk.id, 'camB', 'chunk/0'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).status, 200);
  const cb = await capi(token, 'POST', recUrl(s.id, chk.id, 'camB', 'complete'), { chunks: 1, mimeType: 'video/webm;codecs=vp9,opus', frames: [], meta: { source: 'web', deviceId: 'phone-b', frames: { frames: 0, fps: 0 }, recError: 'the recorder produced only 5 bytes' } });
  assert.strictEqual(cb.status, 200, JSON.stringify(cb.json));
  const done = await waitTake(s.id, chk.id, (t) => t.state === 'checked', 'checked');
  assert.strictEqual(done.result.camA.ok, true, JSON.stringify(done.result.camA));
  assert.strictEqual(done.result.camB.ok, false);
  assert.match(done.result.camB.reason, /only 5 bytes/);
  assert.match(done.result.camB.reason, /does not decode/);
  assert.match(done.result.camB.reason, /no video frames/);
  assert.strictEqual(done.result.camB.cameraSaid, 'the recorder produced only 5 bytes');
  const sess = await getSession(s.id);
  const cc = sess.session.cameraChecks;
  assert.deepStrictEqual([cc.camA.ok, cc.camA.deviceId, cc.camA.checkId], [true, 'phone-a', chk.id]);
  assert.deepStrictEqual([cc.camB.ok, cc.camB.deviceId], [false, 'phone-b']);
  assert.ok(cc.camA.bytes === VIDEO.length && cc.camA.durationSec > 1.5 && cc.camA.frames === 60, JSON.stringify(cc.camA));
  assert.strictEqual(readJson(bucketPath(s.id, 'session.json')).cameraChecks.camB.ok, false, 'the verdict is in the bucket');
  await dir.waitFor((m) => m.t === 'session' && m.session?.cameraChecks?.camB, 'the verdict on the director');
  // never a take: not in the animations, the progress or the export, and it cannot be accepted
  assert.deepStrictEqual(sess.session.animations, {});
  assert.strictEqual(sess.progress.complete, 0);
  assert.ok(fs.existsSync(bucketPath(s.id, 'checks', chk.id, 'check.json')), 'kept apart under checks/');
  assert.strictEqual((await dapi('POST', recUrl(s.id, chk.id, null, 'accept'), { force: true })).status, 409);
  const ex = untar((await dapi('GET', `/api/capture/sessions/${s.id}/export.tar?all=1`)).buf);
  assert.ok(![...ex.keys()].some((k) => k.includes(chk.id) || /checks?\//.test(k)), 'not exported');
  camA.close(); camB.close(); dir.close();
});

test('(j) live snapshots: a camera\'s JPEG reaches the director only; rate-limited; invalid / oversized ones dropped; a director opened later gets the last one', async () => {
  const s = await newSession('server-test snap');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const camB = await camera(s.id, token, 'camB');
  const dir = await directorWs(s.id);
  const jpg = (n) => 'data:image/jpeg;base64,' + Buffer.alloc(n, 7).toString('base64');
  camB.send({ t: 'snap', jpg: jpg(9000), w: 320, h: 180 });
  const m = await dir.waitFor((x) => x.t === 'snap', 'the snapshot on the director');
  assert.deepStrictEqual([m.role, m.w, m.h, m.jpg], ['camB', 320, 180, jpg(9000)]);
  camB.send({ t: 'snap', jpg: jpg(100), w: 1, h: 1 });                   // right after the first: dropped (rate limit)
  await sleep(800);
  camB.send({ t: 'snap', jpg: 'data:image/png;base64,AAAA', w: 2 });
  camB.send({ t: 'snap', jpg: 'javascript:alert(1)', w: 3 });
  camB.send({ t: 'snap', jpg: jpg(130000), w: 4 });                     // over 160 000 characters
  await sleep(400);
  assert.strictEqual(dir.all.filter((x) => x.t === 'snap').length, 1, 'only the first snapshot was relayed');
  camB.send({ t: 'snap', jpg: jpg(200), w: 10, h: 10 });                // later than the limit: relayed
  await dir.waitFor((x) => x.t === 'snap' && x.w === 10, 'the next snapshot');
  dir.send({ t: 'snap', jpg: jpg(100), w: 5 });                          // the director cannot inject one
  await sleep(300);
  assert.ok(!camA.all.some((x) => x.t === 'snap') && !camB.all.some((x) => x.t === 'snap'), 'never to a camera');
  assert.strictEqual(dir.all.filter((x) => x.t === 'snap').length, 2);
  const dir2 = await directorWs(s.id);                                  // a director page opened later
  const last = await dir2.waitFor((x) => x.t === 'snap' && x.role === 'camB', 'the last snapshot on hello');
  assert.strictEqual(last.w, 10);
  await assertHealthy('after the snapshots');
  camA.close(); camB.close(); dir.close(); dir2.close();
});

test('(k) a camera that produced no decodable video: the take "needs redo" (failed, with the reason), never selected; "use it anyway" (accept force) saves it', async () => {
  const s = await newSession('server-test redo');
  const token = await pairByToken(s);
  const camA = await camera(s.id, token, 'camA');
  const camB = await camera(s.id, token, 'camB');
  const dir = await directorWs(s.id);
  await setReady(dir, [[camA, true], [camB, true]]);
  const anim = ANIMS[13];
  const take = await armTake(s.id, anim.id);
  dir.send({ t: 'start', takeId: take.id });
  await waitTake(s.id, take.id, (t) => t.state === 'recording', 'recording');
  dir.send({ t: 'stop', takeId: take.id });
  await waitTake(s.id, take.id, (t) => t.state === 'uploading', 'uploading');
  await putChunks(s.id, take.id, 'camA', token);
  assert.strictEqual((await complete(s.id, take.id, 'camA', token)).status, 200);
  assert.strictEqual((await capi(token, 'PUT', recUrl(s.id, take.id, 'camB', 'chunk/0'), Buffer.alloc(5, 1))).status, 200);
  assert.strictEqual((await capi(token, 'POST', recUrl(s.id, take.id, 'camB', 'complete'), { chunks: 1, mimeType: 'video/webm', meta: { source: 'web', recError: 'the recorder produced only 5 bytes' } })).status, 200);
  const t = await waitTake(s.id, take.id, (x) => x.state === 'failed', 'failed (needs redo)');
  assert.match(t.failReason, /camB/);
  assert.strictEqual(t.accepted, false);
  assert.strictEqual(t.selected, false);
  assert.ok(t.validation.checks.some((c) => c.id === 'recorder-camB' && c.level === 'warn'), 'what the camera said is on the record');
  const sess = await getSession(s.id);
  const e = sess.session.animations[anim.id];
  assert.strictEqual(e.selectedTake, null);
  assert.strictEqual(e.results[take.id].state, 'failed');
  assert.match(e.results[take.id].reason, /camB/);
  const P = await import('../capture/protocol.mjs');
  assert.strictEqual(P.slotStatus(sess.session, anim.id).status, 'failed');
  assert.strictEqual(sess.progress.complete, 0);
  assert.strictEqual(readJson(bucketPath(s.id, 'session.json')).animations[anim.id].results[take.id].state, 'failed');
  assert.strictEqual((await dapi('POST', recUrl(s.id, take.id, null, 'accept'), {})).status, 409, 'not without force');
  const ok = await dapi('POST', recUrl(s.id, take.id, null, 'accept'), { force: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.take.forced, true);
  const s2 = await getSession(s.id);
  assert.strictEqual(s2.session.animations[anim.id].selectedTake, take.id);
  assert.strictEqual(P.slotStatus(s2.session, anim.id).status, 'recorded');
  camA.close(); camB.close(); dir.close();
});

test('(l) analysis without the processor: 400 with the honest reason, nothing queued; a camera token can neither queue nor read it', async () => {
  const s = await newSession('server-test ana0');
  const token = await pairByToken(s);
  const t = await uploadedTake(s.id, token, ANIMS[14].id);
  const r = await dapi('POST', `/api/capture/sessions/${s.id}/process-batch`, { takes: [t.id], cam: 'camA', confirmCostUsd: 100 });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /FAL_KEY/);
  const st = await dapi('GET', `/api/capture/sessions/${s.id}/analysis`);
  assert.strictEqual(st.status, 200, JSON.stringify(st.json));
  assert.strictEqual(st.json.available, false);
  assert.match(st.json.why, /FAL_KEY/);
  assert.strictEqual(st.json.processor.costPerFrameUsd, 0.03);
  assert.ok([401, 403].includes((await capi(token, 'POST', `/api/capture/sessions/${s.id}/process-batch`, { takes: [t.id], confirmCostUsd: 100 })).status));
  assert.ok([401, 403].includes((await capi(token, 'GET', `/api/capture/sessions/${s.id}/analysis`)).status));
  assert.strictEqual((await getTake(s.id, t.id)).analysis, undefined, 'nothing queued');
});

test('(m) analysis queue (MOCAP_MOCK=1, no money): a quote without confirmation queues nothing (402); confirmed takes run one at a time → done with the motion on the take; a take not recorded is left out', async () => {
  await redeploy({ wipe: false, env: { MOCAP_MOCK: '1' } });
  const s = await newSession('server-test ana1');
  const token = await pairByToken(s);
  const t1 = await uploadedTake(s.id, token, ANIMS[15].id);
  const t2 = await uploadedTake(s.id, token, ANIMS[16].id);
  const armed = await armTake(s.id, ANIMS[17].id);                      // never recorded
  const url = `/api/capture/sessions/${s.id}/process-batch`;
  const q = await dapi('POST', url, { takes: [t1.id, t2.id, armed.id], cam: 'camA', fps: 10 });
  assert.strictEqual(q.status, 402, JSON.stringify(q.json));
  assert.strictEqual(q.json.items.length, 2);
  assert.strictEqual(q.json.frames, q.json.items.reduce((a, x) => a + x.maxFrames, 0));
  assert.ok(q.json.items.every((x) => x.maxFrames === 20), 'a 2 s take at 10 frames/s = 20 frames');
  assert.strictEqual(q.json.estimateUsd, +(q.json.frames * 0.03).toFixed(2));
  assert.deepStrictEqual(q.json.skipped.map((x) => x.takeId), [armed.id]);
  assert.strictEqual((await getTake(s.id, t1.id)).analysis, undefined, 'a quote queues nothing');
  const low = await dapi('POST', url, { takes: [t1.id, t2.id], cam: 'camA', fps: 10, confirmCostUsd: q.json.estimateUsd - 0.05 });
  assert.strictEqual(low.status, 402, 'a confirmation below the estimate is refused');
  assert.strictEqual((await getTake(s.id, t1.id)).analysis, undefined);
  const ok = await dapi('POST', url, { takes: [t1.id, t2.id], cam: 'camA', fps: 10, confirmCostUsd: q.json.estimateUsd });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.deepStrictEqual(ok.json.queued.map((x) => x.takeId), [t1.id, t2.id]);
  for (const t of [t1, t2]) {
    const d = await waitTake(s.id, t.id, (x) => ['done', 'error'].includes(x.analysis?.state), 'the analysis', 90000);
    assert.strictEqual(d.analysis.state, 'done', JSON.stringify(d.analysis));
    assert.match(d.analysis.motionId, /^mo-/);
    assert.strictEqual(d.processing.sam3dbody.camA.motionId, d.analysis.motionId);
    assert.strictEqual(d.analysis.attempts, 1);
  }
  const a1 = (await getTake(s.id, t1.id)).analysis, a2 = (await getTake(s.id, t2.id)).analysis;
  assert.ok(Date.parse(a2.startedAt) >= Date.parse(a1.finishedAt), `one at a time (${a1.finishedAt} → ${a2.startedAt})`);
  assert.ok(fs.existsSync(path.join(TMP, 'mocap', a1.motionId)), 'the motion is in the (temp) mocap library');
  // (the take's record is the truth and is written first; the session's queue drops it right after)
  let sess;
  for (const t0 = Date.now(); ;) { sess = await getSession(s.id); if (!sess.session.analysisQueue?.length || Date.now() - t0 > 8000) break; await sleep(100); }
  assert.deepStrictEqual(sess.session.analysisQueue, []);
  const P = await import('../capture/protocol.mjs');
  assert.strictEqual(P.slotStatus(sess.session, ANIMS[15].id).status, 'analysed');
  assert.strictEqual(readJson(bucketPath(s.id, 'session.json')).animations[ANIMS[16].id].analysis.state, 'done');
});

test('(n) the analysis queue survives a redeploy: queued items and one "running" when the server died are run on boot; one interrupted twice becomes an error instead of a third payment', async () => {
  if (!alive()) await startServer({ MOCAP_MOCK: '1' });
  const s = await newSession('server-test ana2');
  const token = await pairByToken(s);
  const takes = [];
  for (const i of [18, 19, 20]) takes.push(await uploadedTake(s.id, token, ANIMS[i].id));
  const url = `/api/capture/sessions/${s.id}/process-batch`;
  const q = await dapi('POST', url, { takes: takes.map((t) => t.id), cam: 'camA', fps: 10 });
  assert.strictEqual(q.status, 402);
  const ok = await dapi('POST', url, { takes: takes.map((t) => t.id), cam: 'camA', fps: 10, confirmCostUsd: q.json.estimateUsd });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  // the container dies at once; what the bucket says then: #1 was running (1st try), #2 was running
  // for the 2nd time already, #3 still queued
  await redeploy({
    env: { MOCAP_MOCK: '1' },
    between: () => {
      const set = (id, a) => { const f = bucketPath(s.id, 'takes', id, 'take.json'); const j = readJson(f); j.analysis = { ...j.analysis, ...a }; delete j.analysis.motionId; fs.writeFileSync(f, JSON.stringify(j)); };
      set(takes[0].id, { state: 'running', attempts: 1, startedAt: new Date().toISOString() });
      set(takes[1].id, { state: 'running', attempts: 2, startedAt: new Date().toISOString() });
      set(takes[2].id, { state: 'queued', attempts: 0 });
      const sf = bucketPath(s.id, 'session.json'), sj = readJson(sf);
      sj.analysisQueue = ok.json.queued.map((x) => ({ takeId: x.takeId, animId: x.animId, cam: x.cam, fps: x.fps, maxFrames: x.maxFrames, estimateUsd: x.estimateUsd, queuedAt: new Date().toISOString() }));
      fs.writeFileSync(sf, JSON.stringify(sj));
    },
  });
  // nobody opens the session: the boot picks the queue up by itself
  const settled = (t) => waitTake(s.id, t.id, (x) => ['done', 'error'].includes(x.analysis?.state) && x.analysis.finishedAt, `take ${t.id} analysed`, 90000);
  const d0 = await settled(takes[0]), d1 = await settled(takes[1]), d2 = await settled(takes[2]);
  assert.strictEqual(d0.analysis.state, 'done', JSON.stringify(d0.analysis));
  assert.strictEqual(d0.analysis.attempts, 2);
  assert.strictEqual(d0.analysis.resumedAfterRestart, true);
  assert.strictEqual(d1.analysis.state, 'error');
  assert.match(d1.analysis.error, /interrupted 2 times/);
  assert.strictEqual(d2.analysis.state, 'done', JSON.stringify(d2.analysis));
  assert.strictEqual(d2.analysis.attempts, 1);
  // (the take's record is the truth and is written first; the session's queue drops it right after)
  let sess;
  for (const t0 = Date.now(); ;) { sess = await getSession(s.id); if (!sess.session.analysisQueue?.length || Date.now() - t0 > 8000) break; await sleep(100); }
  assert.deepStrictEqual(sess.session.analysisQueue, []);
  assert.strictEqual(sess.session.animations[takes[1].animId].analysis.state, 'error');
  assert.strictEqual(sess.session.animations[takes[0].animId].analysis.state, 'done');
});
