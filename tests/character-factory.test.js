'use strict';
/**
 * Character factory: manifest, stage graph + invalidation, reference classification, Tripo request
 * construction + credit accounting (mocked Tripo), jobs, skeleton mapping, API routes.
 * Test characters are created under assets/characters/zz_test_* and removed afterwards.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const CP = path.join(ROOT, 'tools', 'character_pipeline');
const CHAR_DIR = path.join(ROOT, 'assets', 'characters');
const imp = (f) => import(path.join(CP, f));
const TMP = [];
const cleanup = () => { for (const id of TMP) fs.rmSync(path.join(CHAR_DIR, id), { recursive: true, force: true }); };
test.after(cleanup);

async function png(file, w, h, draw) {
  const sharp = require('sharp');
  const buf = Buffer.alloc(w * h * 3, 240);
  draw((x0, y0, x1, y1, rgb) => { for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) buf.set(rgb, (y * w + x) * 3); });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
  return file;
}
const SKIN = [150, 95, 60], SHIRT = [190, 190, 225], SHORTS = [200, 30, 40];

test('manifest: create, save, reload', async () => {
  const { loadManifest, saveManifest, manifestPath } = await imp('manifest.mjs');
  const id = 'zz_test_manifest'; TMP.push(id);
  const m = loadManifest(id);
  assert.equal(m.id, id); assert.deepEqual(m.references, []); assert.equal(m.credits.spent, 0);
  m.name = 'Test'; saveManifest(m);
  assert.ok(fs.existsSync(manifestPath(id)));
  assert.equal(loadManifest(id).name, 'Test');
});

test('reference classification: body, head, two-hand sheet (sides), validation warnings', async () => {
  const { classify, handSides, validate } = await imp('refs.mjs');
  const dir = path.join(CHAR_DIR, 'zz_test_refs'); TMP.push('zz_test_refs');
  // a front-facing figure: head, shirt with arms, shorts, legs — tall and narrow
  const body = await png(path.join(dir, 'a.png'), 600, 900, (r) => {
    r(270, 60, 330, 152, SKIN); r(200, 150, 400, 420, SHIRT); r(170, 160, 200, 420, SKIN); r(400, 160, 430, 420, SKIN);
    r(220, 420, 380, 600, SHORTS); r(240, 600, 290, 860, SKIN); r(310, 600, 360, 860, SKIN);
  });
  const head = await png(path.join(dir, 'b.png'), 500, 600, (r) => { r(120, 80, 380, 520, SKIN); r(100, 60, 400, 140, [30, 20, 15]); });
  const hands = await png(path.join(dir, 'c.png'), 1000, 700, (r) => { r(150, 0, 350, 600, SKIN); r(650, 0, 850, 600, SKIN); });
  const cb = await classify(body), ch = await classify(head), cs = await classify(hands);
  assert.equal(cb.part, 'body'); assert.equal(cb.view, 'front');
  assert.equal(ch.part, 'head');
  assert.equal(cs.part, 'hands'); assert.equal(cs.fingers, 'down'); assert.equal(cs.view, 'back');
  const sides = handSides(cs);
  assert.ok(sides.hand_right.x0 < sides.hand_left.x0, 'back view, fingers down: the image-left hand is the right hand');
  // overrides win over analysis
  assert.equal((await classify(body, { part: 'head', view: 'left' })).part, 'head');
  const v = validate([{ name: 'a.png', part: 'body', view: 'front', width: 600, height: 900, cropWidth: 300, cropHeight: 850, upscaled: 1.2, bgSpread: 1, box: cb.boxes[0], confidence: 'medium' }]);
  assert.ok(v.ok);
  assert.ok(v.warnings.some((w) => /upscaled/.test(w)));
  assert.ok(v.warnings.some((w) => /one view only/.test(w)));
  assert.ok(!validate([{ name: 'x.png', part: 'head', view: 'front', width: 600, height: 600, bgSpread: 1 }]).ok, 'no body reference blocks generation');
});

/** A mocked Tripo v3 API on globalThis.fetch; records every request. */
function mockTripo({ credits = 70, failCreate = null } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET';
    let body = null; if (init.body && typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ url: u, method, body, auth: init.headers?.Authorization });
    const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    if (u.endsWith('/v3/files')) return ok({ file_token: `file_${++n}` });
    if (u.includes('/v3/generation/')) { if (failCreate) return new Response(JSON.stringify({ code: 1004, message: failCreate }), { status: 400 }); return ok({ task_id: `task_${++n}` }); }
    if (u.includes('/v3/tasks/')) return ok({ task_id: u.split('/').pop(), status: 'success', type: 'image_to_model', credits_consumed: credits, output: { pbr_model: 'https://mock.tripo/m.glb', rendered_image: 'https://mock.tripo/r.webp' } });
    if (u.endsWith('/v3/account/balance')) return ok({ balance: 1000, frozen: 0 });
    if (u.startsWith('https://mock.tripo/')) return new Response(Buffer.from('glTF-mock'), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('Tripo client: bearer auth, multiview view keys, envelope errors', async () => {
  process.env.TRIPO_API_KEY ||= 'tsk_test';
  const { TripoClient } = await imp('tripo-client.mjs');
  const mk = mockTripo();
  try {
    const c = new TripoClient({ apiKey: 'tsk_test' });
    assert.equal((await c.getBalance()).balance, 1000);
    await c.createMultiviewModel({ front: 'file_a', back: 'file_b' }, { texture: true, model_seed: 7 });
    const mv = mk.calls.find((x) => x.url.endsWith('/multiview-to-model'));
    assert.equal(mv.auth, 'Bearer tsk_test');
    assert.deepEqual(mv.body.inputs, [{ front: 'file_a' }, { back: 'file_b' }], 'explicit view keys, not positions');
    assert.equal(mv.body.model, 'v3.1-20260211'); assert.equal(mv.body.model_seed, 7);
    await assert.rejects(() => c.createMultiviewModel({ back: 'x' }), /front view/);
  } finally { mk.restore(); }
  const bad = mockTripo({ failCreate: 'invalid parameter texture_version' });
  try { await assert.rejects(() => new TripoClient({ apiKey: 'tsk_test' }).createImageModel('file_1'), /texture_version/); } finally { bad.restore(); }
});

test('generation: seeds + params recorded, credits accounted, cache reuse, credit limit', async () => {
  process.env.TRIPO_API_KEY ||= 'tsk_test';
  const { loadManifest, saveManifest } = await imp('manifest.mjs');
  const st = await imp('stages.mjs');
  const { LIMITS } = await imp('config.mjs');
  const id = 'zz_test_gen'; TMP.push(id);
  const m = loadManifest(id);
  const f = await png(path.join(CHAR_DIR, id, 'references', 'body', 'front.png'), 300, 600, (r) => r(100, 20, 200, 580, SKIN));
  m.references = [{ name: 'b.png', part: 'body', view: 'front', cleaned: 'references/body/front.png', cleanedSha256: 'abc' }];
  saveManifest(m);
  const mk = mockTripo({ credits: 70 });
  try {
    await st.generate(m);
    const g = m.generation.body;
    assert.equal(g.task.status, 'success'); assert.equal(g.task.credits, 70); assert.equal(m.credits.spent, 70);
    assert.ok(g.seeds.model_seed && g.seeds.texture_seed); assert.equal(g.params.geometry_quality, 'detailed'); assert.equal(g.params.texture_quality, 'extreme');
    assert.ok(fs.existsSync(path.join(CHAR_DIR, id, g.sourceHigh)), 'source kept under source/tripo/<part>/<task>/');
    const creates = mk.calls.filter((x) => x.url.includes('/v3/generation/')).length;
    await st.generate(m);                                  // unchanged → cached, no new task, no credits
    assert.equal(mk.calls.filter((x) => x.url.includes('/v3/generation/')).length, creates);
    assert.equal(m.credits.spent, 70);
    // regenerate at the limit → refused before any request
    m.generation.body.key = 'regenerate'; m.credits.spent = LIMITS.maxCreditsPerCharacter;
    await assert.rejects(() => st.generate(m), /credit limit/);
    assert.equal(mk.calls.filter((x) => x.url.includes('/v3/generation/')).length, creates);
    assert.equal(m.generation.body.history?.length, 1, 'the previous source is kept in history');
  } finally { mk.restore(); void f; }
});

test('stage graph: regenerating the head makes downstream stale, body stays valid', async () => {
  const { loadManifest, saveManifest } = await imp('manifest.mjs');
  const { computeState } = await imp('state.mjs');
  const { genPlan } = await imp('stages.mjs');
  const id = 'zz_test_state'; TMP.push(id);
  const m = loadManifest(id);
  const D = path.join(CHAR_DIR, id);
  for (const p of ['body', 'head']) { fs.mkdirSync(path.join(D, 'source', p), { recursive: true }); fs.writeFileSync(path.join(D, 'source', p, 'm.glb'), 'x'); }
  m.references = [{ name: 'b', part: 'body', view: 'front', cleaned: 'r/b.png', cleanedSha256: 'b1' }, { name: 'h', part: 'head', view: 'front', cleaned: 'r/h.png', cleanedSha256: 'h1' }];
  m.stages.ingest = { status: 'done', at: '2026-01-01T00:00:00Z' };
  m.validation = { ok: true, warnings: [], blocking: [], at: '2026-01-01T00:00:01Z' };
  const t0 = Date.parse('2026-01-02T00:00:00Z'), T = (h) => new Date(t0 + h * 3600e3).toISOString();
  for (const p of ['body', 'head']) { m.generation[p] = { seeds: { model_seed: 1, texture_seed: 2 }, task: { id: p, status: 'success', finishedAt: T(0) }, sourceHigh: `source/${p}/m.glb` }; m.generation[p].key = genPlan(m, p).key; }
  const later = ['assemble', 'gamemesh', 'rig', 'import', 'lods', 'preview', 'courttest'];
  later.forEach((s, i) => { m.stages[s] = { status: 'done', finishedAt: T(1 + i) }; });
  saveManifest(m);
  let S = computeState(m);
  assert.equal(S.pipeline, 'GAME_READY');
  assert.ok(later.every((s) => S.stages[s].status === 'done'));
  // head regenerated after everything was built
  m.generation.head.task.finishedAt = T(20);
  S = computeState(m);
  assert.equal(S.parts.body.status, 'done'); assert.equal(S.parts.head.status, 'done');
  assert.equal(S.stages.generate.status, 'done');
  for (const s of later) assert.equal(S.stages[s].status, 'stale', s + ' should be stale');
  assert.equal(S.stages.assemble.status, 'stale');
  // head references changed (new cleaned image) → the head source itself is stale, body is not
  m.references[1].cleanedSha256 = 'h2';
  S = computeState(m);
  assert.equal(S.parts.head.status, 'stale'); assert.equal(S.parts.body.status, 'done');
  // a failed earliest stage → FAILED
  m.references[1].cleanedSha256 = 'h1'; m.generation.head.task.finishedAt = T(0);
  m.stages.assemble = { status: 'failed', error: 'boom', finishedAt: T(30) };
  S = computeState(m);
  assert.equal(S.stages.assemble.status, 'failed'); assert.equal(S.pipeline, 'FAILED');
});

test('jobs: persist, interrupted when the process is gone, whitelisted ops', async () => {
  const J = await imp('jobs.mjs');
  const id = 'zz-test-job-' + Date.now().toString(36);
  J.writeJob({ id, character: 'zz_test_state', op: 'validate', status: 'running', pid: 999999, createdAt: new Date().toISOString(), startedAt: new Date().toISOString() });
  const j = J.readJob(id);
  assert.equal(j.status, 'interrupted', 'a running job whose pid is gone reads as interrupted');
  assert.ok(J.listJobs({ character: 'zz_test_state' }).some((x) => x.id === id));
  fs.rmSync(path.join(J.JOBS_DIR, id + '.json'));
  assert.throws(() => J.startJob({ character: 'zz_test_state', op: 'rm -rf' }), /unknown operation/);
  assert.throws(() => J.startJob({ character: '../etc', op: 'validate' }), /bad character id/);
  assert.throws(() => J.startJob({ character: 'zz_test_state', op: 'generate', part: 'head;ls' }), /bad part/);
});

test('skeleton mapping: persistent file maps onto real master joints', () => {
  const map = JSON.parse(fs.readFileSync(path.join(CP, 'tripo_to_souljam_bones.json'), 'utf8'));
  const rig = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'lib', 'mocap', 'mhr-rigs', 'player.json.gz'))));
  const names = new Set(rig.mhr.names);
  assert.equal(rig.mhr.names.length, 127);
  for (const b of ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightUpLeg', 'LeftHandIndex1', 'RightHandThumb3']) assert.ok(map.target[b], b);
  for (const [k, v] of Object.entries(map.target)) assert.ok(names.has(v), `${k} → ${v} exists`);
  for (const [k, v] of Object.entries(map.weights)) for (const j of v) assert.ok(names.has(j), `${k} weight joint ${j}`);
});

/** Calls a registered route handler with a fake request / response. */
function routes() {
  const R = [];
  const add = (method) => (pattern, handler) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); R.push({ method, re, keys, handler }); };
  const router = { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
  require('../routes/character-factory').register(router);
  return async (method, url, body) => {
    const u = new URL(url, 'http://x'); const r = R.find((x) => x.method === method && x.re.test(u.pathname));
    if (!r) throw new Error('no route ' + url);
    const m = u.pathname.match(r.re); const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const req = Readable.from(body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]);
    req.method = method; req.headers = {};
    return new Promise((resolve) => {
      const chunks = []; let status = 200, headers = {};
      const res = { writeHead(s, h) { status = s; headers = h || {}; }, write(c) { chunks.push(Buffer.from(c)); }, end(c) { if (c) chunks.push(Buffer.from(c)); const b = Buffer.concat(chunks); resolve({ status, headers, body: /json/.test(headers['Content-Type'] || '') ? JSON.parse(b.toString() || '{}') : b }); }, on() {}, once() {}, emit() {}, removeListener() {} };
      Object.assign(res, { headersSent: false });
      r.handler(req, res, params, Object.fromEntries(u.searchParams));
    });
  };
}

test('API: create → upload + classify → reclassify → file access is path-checked → delete', async () => {
  const call = routes();
  const id = 'zz_test_api'; TMP.push(id);
  let r = await call('POST', '/api/cf/characters', { name: 'API Test', id });
  assert.equal(r.status, 201); assert.equal(r.body.id, id); assert.equal(r.body.status, 'DRAFT');
  assert.equal((await call('POST', '/api/cf/characters', { name: 'API Test', id })).status, 409);
  assert.equal((await call('POST', '/api/cf/characters', { name: 'x', id: '../bad' })).status, 400);
  const img = fs.readFileSync(await png(path.join(CHAR_DIR, '_test_tmp.png'), 600, 900, (q) => { q(270, 60, 330, 140, SKIN); q(200, 150, 400, 420, SHIRT); q(170, 160, 200, 420, SKIN); q(400, 160, 430, 420, SKIN); q(220, 420, 380, 600, SHORTS); q(240, 600, 290, 860, SKIN); q(310, 600, 360, 860, SKIN); }));
  fs.rmSync(path.join(CHAR_DIR, '_test_tmp.png'));
  assert.equal((await call('POST', `/api/cf/characters/${id}/references?name=evil.sh`, img)).status, 400, 'non-image names refused');
  assert.equal((await call('POST', `/api/cf/characters/${id}/references?name=fake.png`, Buffer.from('not an image'))).status, 400, 'magic bytes checked');
  r = await call('POST', `/api/cf/characters/${id}/references?name=body.png`, img);
  assert.equal(r.status, 201); assert.equal(r.body.references[0].part, 'body');
  r = await call('PATCH', `/api/cf/characters/${id}/references/body.png`, { part: 'body', view: 'back' });
  assert.equal(r.body.references[0].view, 'back');
  r = await call('GET', `/api/cf/characters/${id}`);
  assert.equal(r.body.references.length, 1); assert.equal(r.body.summary.status, 'REFERENCES_READY');
  assert.equal((await call('GET', `/api/cf/characters/${id}/file?path=../../../package.json`)).status, 404, 'no path traversal');
  assert.equal((await call('GET', `/api/cf/characters/${id}/file?path=${encodeURIComponent(r.body.references[0].cleaned)}`)).status, 200);
  const list = await call('GET', '/api/cf/characters');
  assert.ok(list.body.characters.some((c) => c.id === id));
  assert.equal((await call('DELETE', `/api/cf/characters/${id}`)).status, 400, 'delete needs confirmation');
  assert.equal((await call('DELETE', `/api/cf/characters/${id}?confirm=${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(CHAR_DIR, id)));
});
