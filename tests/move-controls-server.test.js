/**
 * The move controls on the server (/api/mocap3d/controls, lib/mocap/move-controls-store.js): validated like the
 * other settings, stored on the disk AND in the bucket (Railway's disk is wiped on every redeploy), restored from the
 * bucket at startup and lazily; the move registry derived from the clip library — a clip given a brand-new move role
 * appears in it by itself.
 *
 * Its own folders, never the real ones: the disk (MOVE_CONTROLS_FILE), a folder standing in for the bucket
 * (MOVE_CONTROLS_CLOUD_DIR), a clip library of two cloned motions (MOCAP_DIR) — every storage credential is blanked,
 * so no real bucket is touched. The API is driven in-process (server.js as a handler); one test starts the real
 * `node server.js` (port 3474…3478, killed by PID) on a wiped disk to see the startup restore.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-server-'));
const DISK = path.join(TMP, 'disk'), BUCKET = path.join(TMP, 'bucket'), MOCAP = path.join(TMP, 'mocap');
const FILE = path.join(DISK, 'move-controls.json'), CLOUD = path.join(BUCKET, '_meta', 'move-controls.json');
const PASS = 'mc-test-pw';
const SRC = path.join(REPO, 'data', 'mocap');
// two small generated crossovers from the clip library (cloned: the real library is never written)
const CLIPS = ['mo-mulm8d6camce', 'mo-mulm8e8ug69b'];
const HAVE = CLIPS.every((id) => fs.existsSync(path.join(SRC, id, 'meta.json')));
const BLANK = {
  FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: '',
  FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '', FIREBASE_PRIVATE_KEY_ID: '', FIREBASE_STORAGE_BUCKET: '',
  project_id: '', client_email: '', private_key: '', private_key_id: '',
  R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_PUBLIC_URL: '', STORAGE_BACKEND: '',
  GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', FAL_KEY: '',
};
const ENV = { ...BLANK, APP_PASSWORD: PASS, MOVE_CONTROLS_FILE: FILE, MOVE_CONTROLS_CLOUD_DIR: BUCKET, MOCAP_DIR: MOCAP };

let srv, base;
test.before(async () => {
  fs.mkdirSync(MOCAP, { recursive: true });
  if (HAVE) for (const id of CLIPS) {
    try { execFileSync('cp', ['-Rc', path.join(fs.realpathSync(SRC), id), MOCAP]); }   // (an APFS clone: instant, no space)
    catch { execFileSync('cp', ['-R', path.join(fs.realpathSync(SRC), id), MOCAP]); }
  }
  Object.assign(process.env, ENV);
  const handler = require('../server.js');
  srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function call(method, p, body, { auth = true, at = base } = {}) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(at + p, { method, headers: { ...(auth ? { Authorization: `Bearer ${PASS}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (q) => {
      const ch = []; q.on('data', (c) => ch.push(c));
      q.on('end', () => { const txt = Buffer.concat(ch).toString(); let j = null; try { j = JSON.parse(txt); } catch {} res({ status: q.statusCode, j, txt }); });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const bindingOf = (j, role) => j.controls.bindings.filter((b) => b.role === role);

test('GET: the defaults (nothing stored), the move registry from the library', { skip: !HAVE }, async () => {
  const { DEFAULT_BINDINGS } = await import('../engine3d/move-controls.mjs');
  const r = await call('GET', '/api/mocap3d/controls');
  assert.strictEqual(r.status, 200, r.txt);
  assert.strictEqual(r.j.isDefault, true);
  assert.strictEqual(r.j.source, 'defaults');
  assert.deepStrictEqual(r.j.controls.bindings, JSON.parse(JSON.stringify(DEFAULT_BINDINGS)));
  assert.deepStrictEqual(r.j.defaults.bindings, r.j.controls.bindings);
  assert.ok(r.j.conflicts.some((c) => c.a === 'move-crossover' && c.b === 'move-double-cross' && c.type === 'prefix'));
  const cross = r.j.moves.find((m) => m.role === 'move-crossover');
  assert.deepStrictEqual(cross.clips.map((c) => c.name).sort(), ['Crossover (generated)', 'Crossover on the move (generated)']);
  assert.deepStrictEqual([cross.available, cross.switchesHand, cross.arrows], [true, true, ['←']]);
  const hesi = r.j.moves.find((m) => m.role === 'move-hesi');
  assert.deepStrictEqual([hesi.available, hesi.clips.length, hesi.describe], [false, 0, ['flick forward (0°)']]);
  assert.ok(r.j.moves.find((m) => m.role === 'shot-jumper')?.bindable === false, 'shots are listed, on the shot button');
  assert.ok(!fs.existsSync(FILE) && !fs.existsSync(CLOUD), 'a GET writes nothing');
  assert.strictEqual((await call('GET', '/api/mocap3d/controls?moves=0')).j.moves, undefined, '?moves=0: no registry');
  const no = await call('GET', '/api/mocap3d/controls', undefined, { auth: false });
  assert.ok([401, 302, 303].includes(no.status), `behind the password (${no.status})`);
});

test('PUT: validated like the other settings — a bad step or a duplicate trigger is a 400 and nothing is written', { skip: !HAVE }, async () => {
  for (const body of [{}, { bindings: 'x' }, { bindings: [{ role: 'move-x', steps: [{ flick: 90, hold: 90 }] }] }, { bindings: [{ role: 'shot-jumper', steps: [{ flick: 0 }] }] },
    { bindings: [{ role: 'move-a', steps: [{ flick: 90 }] }, { role: 'move-b', steps: [{ flick: 90 }] }] }, '{not json']) {
    const r = await call('PUT', '/api/mocap3d/controls', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${r.txt}`);
    assert.ok(r.j.error && (Array.isArray(r.j.errors) ? r.j.errors.length : true));
  }
  assert.match((await call('PUT', '/api/mocap3d/controls', { bindings: [{ role: 'move-a', steps: [{ flick: 90 }] }, { role: 'move-b', steps: [{ flick: 90 }] }] })).j.errors.join(), /same trigger/);
  assert.ok(!fs.existsSync(FILE) && !fs.existsSync(CLOUD));
});

test('PUT one move: saved on the disk and in the bucket; a trigger another move has is a 409 unless taken from it', { skip: !HAVE }, async () => {
  // a 2-step combo for a brand-new move
  let r = await call('PUT', '/api/mocap3d/controls/move-pullback-cross?moves=0', { steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' });
  assert.strictEqual(r.status, 200, r.txt);
  assert.deepStrictEqual([r.j.success, r.j.savedToCloud, r.j.storage, r.j.isDefault], [true, true, 'test-bucket', false]);
  assert.deepStrictEqual(bindingOf(r.j, 'move-pullback-cross'), [{ role: 'move-pullback-cross', steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' }]);
  assert.ok(r.j.conflicts.some((c) => c.a === 'move-btl' && c.b === 'move-pullback-cross' && c.type === 'prefix'), 'the btl it starts with: a prefix, fine');
  const disk = readJson(FILE), cloud = readJson(CLOUD);
  assert.deepStrictEqual(disk, cloud, 'the bucket has exactly what the disk has');
  assert.deepStrictEqual(disk.bindings, r.j.controls.bindings);
  assert.ok(disk.updatedAt && disk.version === 1);
  // the hesitation onto the crossover's trigger: 409, nothing changes
  r = await call('PUT', '/api/mocap3d/controls/move-hesi', { steps: [{ flick: 270 }] });
  assert.strictEqual(r.status, 409, r.txt);
  assert.deepStrictEqual(r.j.conflicts.map((c) => [c.role, c.type]), [['move-crossover', 'same']]);
  assert.deepStrictEqual(readJson(FILE), disk);
  // taken from it: the crossover has no trigger now; the hesitation keeps its place in the list
  const order0 = disk.bindings.map((b) => b.role);
  r = await call('PUT', '/api/mocap3d/controls/move-hesi?unbindOthers=1', { steps: [{ flick: 270 }] });
  assert.strictEqual(r.status, 200, r.txt);
  assert.deepStrictEqual(bindingOf(r.j, 'move-hesi').map((b) => b.steps), [[{ flick: 270 }]]);
  assert.deepStrictEqual(bindingOf(r.j, 'move-crossover'), []);
  assert.deepStrictEqual(r.j.controls.bindings.map((b) => b.role), order0.filter((x) => x !== 'move-crossover'), 'the order kept (it breaks exact ties)');
  assert.deepStrictEqual(r.j.moves.find((m) => m.role === 'move-crossover').triggers, [], 'the registry shows it without a trigger');
  // the crossover's default back: the hesitation has it — 409; taken back: the hesitation has none
  r = await call('POST', '/api/mocap3d/controls/reset?moves=0', { role: 'move-crossover' });
  assert.strictEqual(r.status, 409, r.txt);
  r = await call('POST', '/api/mocap3d/controls/reset?moves=0', { role: 'move-crossover', unbindOthers: true });
  assert.strictEqual(r.status, 200, r.txt);
  assert.deepStrictEqual(bindingOf(r.j, 'move-crossover').map((b) => b.steps), [[{ flick: 270 }]]);
  assert.deepStrictEqual(bindingOf(r.j, 'move-hesi'), []);
  r = await call('POST', '/api/mocap3d/controls/reset?moves=0', { role: 'move-hesi' });
  assert.deepStrictEqual(bindingOf(r.j, 'move-hesi').map((b) => b.steps), [[{ flick: 0 }]]);
  // several triggers for one move; none
  r = await call('PUT', '/api/mocap3d/controls/move-spin?moves=0', { bindings: [{ steps: [{ spin: 'cw' }] }, { steps: [{ hold: 180, ms: 600 }] }] });
  assert.deepStrictEqual(bindingOf(r.j, 'move-spin').map((b) => b.steps), [[{ spin: 'cw' }], [{ hold: 180, ms: 600 }]]);
  r = await call('PUT', '/api/mocap3d/controls/move-spin?moves=0', { steps: null });
  assert.deepStrictEqual(bindingOf(r.j, 'move-spin'), []);
  r = await call('POST', '/api/mocap3d/controls/reset?moves=0', { role: 'move-spin' });
  assert.deepStrictEqual(bindingOf(r.j, 'move-spin').map((b) => b.steps), [[{ spin: 'any' }]]);
  // bad roles / triggers
  for (const [m, p, body] of [['PUT', '/api/mocap3d/controls/shot-jumper', { steps: [{ flick: 0 }] }], ['PUT', '/api/mocap3d/controls/move-X', { steps: [{ flick: 0 }] }], ['PUT', '/api/mocap3d/controls/..%2Fx', { steps: [{ flick: 0 }] }],
    ['DELETE', '/api/mocap3d/controls/idle', undefined], ['PUT', '/api/mocap3d/controls/move-x', { steps: [{ flick: 0, spin: 'cw' }] }], ['PUT', '/api/mocap3d/controls/move-x', { steps: [{ release: true }] }]]) {
    const x = await call(m, p, body);
    assert.strictEqual(x.status, 400, `${m} ${p} ${JSON.stringify(body)} → ${x.status}`);
  }
  // DELETE: the move has no trigger
  r = await call('DELETE', '/api/mocap3d/controls/move-pullback-cross?moves=0');
  assert.deepStrictEqual(bindingOf(r.j, 'move-pullback-cross'), []);
  r = await call('PUT', '/api/mocap3d/controls/move-pullback-cross?moves=0', { steps: [{ flick: 225 }, { flick: 90 }], mode: 'wait' });
  assert.strictEqual(r.status, 200);
});

test('a new animation: a clip given a brand-new move role is in the library\'s roles, on the court and in the registry', { skip: !HAVE }, async () => {
  let r = await call('PUT', `/api/mocap3d/clip/${CLIPS[0]}`, { role: 'move-pullback-cross' });
  assert.strictEqual(r.status, 200, r.txt);
  assert.strictEqual(r.j.game.role, 'move-pullback-cross');
  assert.deepStrictEqual(r.j.built.hands, { entry: 'right', exit: 'left' });
  for (const bad of ['move-Bad', 'pullback', 'move-', 'shot-new']) assert.strictEqual((await call('PUT', `/api/mocap3d/clip/${CLIPS[1]}`, { role: bad })).status, 400, bad);
  const lib = (await call('GET', '/api/mocap3d/library')).j;
  assert.deepStrictEqual([lib.roles['move-pullback-cross']?.custom, lib.roles['move-pullback-cross']?.type, lib.roles['move-pullback-cross']?.runtime], [true, 'action', true]);
  assert.ok(lib.court.some((c) => c.id === CLIPS[0] && c.role === 'move-pullback-cross'), 'the court loads it');
  r = await call('GET', '/api/mocap3d/controls');
  const pb = r.j.moves.find((m) => m.role === 'move-pullback-cross');
  assert.deepStrictEqual([pb.label, pb.custom, pb.available, pb.switchesHand, pb.clips.map((c) => c.id), pb.arrows], ['Pullback cross', true, true, true, [CLIPS[0]], ['↙ →']]);
  assert.deepStrictEqual(r.j.moves.find((m) => m.role === 'move-crossover').clips.map((c) => c.id), [CLIPS[1]], 'the other crossover is still the crossover');
});

test('a redeploy (the disk wiped): restored from the bucket — lazily, and at startup by the real server', { skip: !HAVE }, async () => {
  const saved = readJson(CLOUD);
  // lazily, on the first request
  fs.rmSync(DISK, { recursive: true, force: true });
  delete require.cache[require.resolve('../lib/mocap/move-controls-store.js')];
  const store = require('../lib/mocap/move-controls-store.js');   // (a fresh process' store: lazy restore not tried yet)
  const st = await store.load();
  assert.deepStrictEqual([st.source, st.isDefault], ['bucket', false]);
  assert.deepStrictEqual(st.controls.bindings, saved.bindings);
  assert.deepStrictEqual(readJson(FILE), saved, 'back on the disk');
  // at startup: `node server.js` on a wiped disk restores it before any request
  fs.rmSync(DISK, { recursive: true, force: true });
  const port = await freePort();
  const env = { ...process.env, ...ENV, PORT: String(port), CAPTURE_HTTPS: '0', CAPTURE_DIR: path.join(TMP, 'capture') };
  for (const k of ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (c) => { out += c; }); proc.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(FILE)) {
      if (proc.exitCode !== null) throw new Error('server exited:\n' + out.slice(-2000));
      if (Date.now() > deadline) throw new Error('not restored at startup within 30 s:\n' + out.slice(-2000));
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(out, /restored move-controls from storage/);
    const r = await call('GET', '/api/mocap3d/controls?moves=0', undefined, { at: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.status, 200, r.txt);
    assert.deepStrictEqual(r.j.controls.bindings, saved.bindings);
    assert.strictEqual(r.j.source, 'disk', 'restored before the request');
  } finally {
    if (proc.exitCode === null) process.kill(proc.pid, 'SIGKILL');
    await exited;
  }
});

test('reset: everything back to the defaults — stored as such (a redeploy restores the defaults, not an older set)', { skip: !HAVE }, async () => {
  const r = await call('POST', '/api/mocap3d/controls/reset?moves=0', {});
  assert.strictEqual(r.status, 200, r.txt);
  assert.strictEqual(r.j.isDefault, true);
  assert.deepStrictEqual(r.j.controls.bindings, r.j.defaults.bindings);
  assert.strictEqual(readJson(CLOUD).reset, true);
  assert.strictEqual((await call('GET', '/api/mocap3d/controls?moves=0')).j.isDefault, true);
  // the same through PUT { reset: true }
  await call('PUT', '/api/mocap3d/controls/move-hesi?moves=0', { steps: [{ flick: 45 }] });
  assert.strictEqual((await call('GET', '/api/mocap3d/controls?moves=0')).j.isDefault, false);
  assert.strictEqual((await call('PUT', '/api/mocap3d/controls?moves=0', { reset: true })).j.isDefault, true);
});

function freePort() {
  const can = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
  return (async () => { for (let p = 3474; p <= 3478; p++) if (await can(p)) return p; throw new Error('no free port in 3474-3478'); })();
}
