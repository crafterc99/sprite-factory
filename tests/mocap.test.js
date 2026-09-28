/**
 * Mocap pipeline tests — run with `npm test` (node:test, no API keys needed).
 *
 * MOCAP_MOCK=1 replaces fal (SAM 3 / SAM 3D Body) and the image models with a
 * deterministic synthetic dribble, so this exercises the real HTTP routes,
 * motion cleanup, mannequin renders, alignment, QC, strips and the auth gate.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mocap-test-'));
Object.assign(process.env, {
  MOCAP_MOCK: '1',
  APP_PASSWORD: 'test-pass-123',
  ASSETS_DIR: path.join(TMP, 'assets'),
  RAW_DIR: path.join(TMP, 'raw'),
  TMP_DIR: path.join(TMP, 'video-tmp'),
  MOCAP_DIR: path.join(TMP, 'mocap'),
  CHARACTERS_FILE: path.join(TMP, 'characters.json'),
  COST_FILE: path.join(TMP, 'cost.json'),
  R2_ENDPOINT: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
});
for (const d of ['assets', 'raw', 'video-tmp', 'mocap']) fs.mkdirSync(path.join(TMP, d), { recursive: true });

const sharp = require('sharp');
const handler = require('../server');
const S = require('../lib/mocap/skeleton');
const mock = require('../lib/mocap/mock');
const { buildMotion } = require('../lib/mocap/motion-builder');

let server, base, cookie = '';

function req(method, url, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(u, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch {} }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitJob(jobId, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const r = await req('GET', `/api/mocap/job/${jobId}`);
    if (r.json.status === 'done') return r.json.result;
    if (r.json.status === 'error') throw new Error(r.json.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('job timeout');
    await new Promise((res) => setTimeout(res, 150));
  }
}

test.before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('motion builder recovers canonical pose from a yawed, pitched camera', async () => {
  const frames = [];
  for (let i = 1; i <= 16; i++) {
    const b = await mock.bodyFrame(`frame-${i}.png`, 1080, 1920);
    const s = await mock.segmentFrame(`frame-${i}.png`, 1080, 1920);
    frames.push({ ...b, ball: s.ball });
  }
  const m = buildMotion({ fps: 12, frames });
  assert.strictEqual(m.report.convention, 'kp+t');
  assert.strictEqual(m.report.sourceYawDeg, 30);
  const P = m.frames[0].joints;
  // left hip is on the subject's left (+X when facing +Z) and hips are level
  assert.ok(Math.abs(P[S.J['left-hip']][0] - 0.1) < 0.01);
  assert.ok(Math.abs(P[S.J['left-hip']][1] - P[S.J['right-hip']][1]) < 0.01);
  // feet on the ground, ball never below the floor, starting hand detected
  assert.ok(Math.abs(Math.min(P[S.J['left-heel']][1], P[S.J['left-big-toe-tip']][1])) < 0.01);
  for (const f of m.frames) assert.ok(f.ball.p[1] >= 0.1);
  assert.strictEqual(m.startingHand, 'right');
  assert.ok(m.statureM > 1.6 && m.statureM < 1.95, `stature ${m.statureM}`);
});

test('password gate blocks everything until signed in', async () => {
  let r = await req('GET', '/api/mocap/status');
  assert.strictEqual(r.status, 401);
  r = await req('GET', '/mocap');
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.location, /^\/login/);
  r = await req('POST', '/login', { body: 'password=wrong', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(r.status, 401);
  // private link
  r = await req('GET', '/mocap?key=test-pass-123');
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.location, '/mocap');
  cookie = r.headers['set-cookie'][0].split(';')[0];
  r = await req('GET', '/api/mocap/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ready, true);
  r = await req('GET', '/api/health', { headers: { Cookie: '' } });
  assert.strictEqual(r.status, 200);
});

test('full pipeline: upload → analyze → render → generate → regen', async () => {
  // Synthetic 2 s clip
  const ffmpeg = require('ffmpeg-static');
  const vid = path.join(TMP, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', vid], { stdio: 'ignore' });
  let r = await req('POST', '/api/video/upload', { body: fs.readFileSync(vid), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.strictEqual(r.status, 200);
  const sessionId = r.json.sessionId;

  r = await req('POST', '/api/mocap/analyze', { body: { sessionId, name: 'Test Dribble', fps: 12, maxFrames: 16 } });
  const an = await waitJob(r.json.jobId);
  const motionId = an.motionId;
  assert.strictEqual(an.meta.frameCount, 16);
  assert.strictEqual(an.meta.failedFrames, 0);

  r = await req('GET', `/api/mocap/motion/${motionId}`);
  assert.strictEqual(r.json.motion.frames.length, 16);

  for (const url of [`/api/mocap/motion/${motionId}/render?view=3&frame=2`, `/api/mocap/motion/${motionId}/overlay/1`, `/api/mocap/motion/${motionId}/sheet?view=1&w=96`]) {
    r = await req('GET', url, { raw: true });
    assert.strictEqual(r.status, 200, url);
    assert.strictEqual(r.headers['content-type'], 'image/png');
  }
  const sheetMeta = await sharp(r.buf).metadata();
  assert.strictEqual(sheetMeta.width, 96 * 16);

  // Reprocess with different smoothing keeps frame count
  r = await req('POST', `/api/mocap/motion/${motionId}/reprocess`, { body: { settings: { smoothing: 2, trimStart: 2 } } });
  assert.strictEqual(r.json.meta.frameCount, 14);

  // Target character (6'6")
  const fig = await sharp({ create: { width: 600, height: 900, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect x="200" y="80" width="200" height="760" rx="60" fill="#3355aa"/></svg>') }]).png().toBuffer();
  for (const f of ['tstfull.png', 'tst-angle-0.png', 'tst-angle-6.png', 'tst-angle-7.png']) fs.writeFileSync(path.join(process.env.ASSETS_DIR, f), fig);
  fs.writeFileSync(process.env.CHARACTERS_FILE, JSON.stringify({ tst: { name: 'tst', heightInches: 78, pixelHeight: 121 } }));

  r = await req('GET', '/api/mocap/characters');
  assert.ok(r.json.characters.find((c) => c.name === 'tst' && c.angles.length === 3));

  r = await req('POST', '/api/mocap/generate', { body: { motionId, charName: 'tst', views: [1, 3], hands: ['right', 'left'], model: 'gpt-image-2.5-sunburst', frameStep: 2, retries: 1 } });
  assert.ok(r.json.jobId, JSON.stringify(r.json));
  const result = await waitJob(r.json.jobId, 240000);
  assert.strictEqual(result.variants.length, 4);
  for (const v of result.variants) {
    assert.strictEqual(v.status, 'done');
    const strip = path.join(process.env.ASSETS_DIR, `tst-${v.animName}.png`);
    const meta = await sharp(strip).metadata();
    assert.strictEqual(meta.height, 180);
    assert.strictEqual(meta.width, 180 * v.frameCount);
    assert.strictEqual(v.frames.length, v.frameCount);
    assert.ok(v.frames.every((f) => typeof f.score === 'number'));
    assert.ok(fs.existsSync(path.join(process.env.ASSETS_DIR, `tst-${v.animName}-genmeta.json`)));
  }
  // Left-hand variant is the mirrored motion
  assert.ok(result.variants.some((v) => v.hand === 'left' && v.mirror));

  // Feet land on the game baseline (y≈170) in every frame of the front variant
  const front = result.variants.find((v) => v.view === 1 && v.hand === 'right');
  const strip = path.join(process.env.ASSETS_DIR, `tst-${front.animName}.png`);
  for (let i = 0; i < front.frameCount; i++) {
    const { data, info } = await sharp(strip).extract({ left: i * 180, top: 0, width: 180, height: 180 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let maxY = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[(y * 180 + x) * 4 + 3] > 40) maxY = Math.max(maxY, y);
    assert.ok(Math.abs(maxY - 170) <= 6, `frame ${i} feet at ${maxY}`);
  }

  r = await req('POST', '/api/mocap/regen-frame', { body: { resultId: result.id, animName: front.animName, frameIndex: 1, customPrompt: 'arms slightly wider' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.variant.frames[1].attempts >= 2);

  r = await req('GET', `/api/mocap/results?motionId=${motionId}`);
  assert.strictEqual(r.json.results.length, 1);

  // Every analysed frame kept a real-pixel performer cut-out for the generator
  r = await req('GET', `/api/mocap/motion/${motionId}/raw`);
  assert.ok(r.json.frames.every((f) => f.cut), 'performer cut-outs recorded');

  // Re-clean the motion, then recompose from stored raws — no model calls
  r = await req('POST', '/api/mocap/recompose', { body: { resultId: result.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.variantsRecomposed, 4);
  assert.ok(r.json.result.variants.every((v) => v.recomposedAt));
});

test('studio image client routes to GPT Image when no Gemini key (green-flattened output)', async () => {
  const saved = { g: process.env.GEMINI_API_KEY, o: process.env.OPENAI_API_KEY, m: process.env.MOCAP_MOCK };
  delete process.env.GEMINI_API_KEY; process.env.OPENAI_API_KEY = 'sk-test'; delete process.env.MOCAP_MOCK;
  const realFetch = global.fetch;
  const calls = [];
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="24" y="8" width="16" height="48" fill="#c00"/></svg>') }]).png().toBuffer();
  global.fetch = async (url, init) => {
    calls.push({ url, model: init.body.get ? init.body.get('model') : null, size: init.body.get ? init.body.get('size') : null, n: init.body.getAll ? init.body.getAll('image[]').length : 0 });
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: transparent.toString('base64') }], usage: { input_tokens: 1000, output_tokens: 2000, input_tokens_details: { image_tokens: 800, text_tokens: 200 } } }) };
  };
  try {
    const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
    const ref = path.join(TMP, 'ref.png');
    fs.writeFileSync(ref, transparent);
    const c = new NanaBananaClient();
    assert.strictEqual(c.provider, 'openai');
    const r = await c.generate('pose the character', { referenceImages: [ref, ref], aspectRatio: '3:4', resolution: '1K', model: 'gemini-3-pro-image-preview' });
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/images/edits');
    assert.strictEqual(calls[0].model, 'gpt-image-2.5-sunburst');
    assert.strictEqual(calls[0].size, '912x1216');
    assert.strictEqual(calls[0].n, 2);
    const px = await sharp(r.imageBuffer).raw().toBuffer({ resolveWithObject: true });
    assert.deepStrictEqual([...px.data.slice(0, 3)], [0, 255, 0]); // background flattened to #00FF00
    await c.generate('x', { referenceImages: [ref], model: 'gemini-3.1-flash-image-preview' });
    assert.strictEqual(calls[1].model, 'gpt-image-2.5-flare');
  } finally {
    global.fetch = realFetch;
    if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
    if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o; else delete process.env.OPENAI_API_KEY;
    if (saved.m !== undefined) process.env.MOCAP_MOCK = saved.m;
  }
});

test('court perspective zones follow the hoop (game geometry)', () => {
  const { perspectiveZone, TEST_COURT, NET_BASE } = require('../engine/GameCourt');
  const h = NET_BASE;
  assert.deepStrictEqual([TEST_COURT.width, TEST_COURT.height], [960, 540]);
  assert.strictEqual(perspectiveZone(h.x + 400, h.y).id, 3);           // beside the hoop → side view
  assert.strictEqual(perspectiveZone(h.x + 400, h.y).flip, false);     // hoop on the left → faces left
  assert.strictEqual(perspectiveZone(h.x, h.y + 300).id, 5);           // straight below → back to camera
  assert.strictEqual(perspectiveZone(h.x + 300, h.y + 300).id, 4);     // below-right → back left
  assert.strictEqual(perspectiveZone(h.x + 100, h.y - 45).id, 2);      // above-right → front left
  assert.strictEqual(perspectiveZone(h.x - 60, h.y + 5).flip, true);   // behind the hoop → mirrored
  // Every zone is reachable inside the hardwood
  const seen = new Set();
  const b = TEST_COURT.bounds;
  for (let x = b.left; x <= b.right; x += 8) for (let y = b.top; y <= b.bottom; y += 8) seen.add(perspectiveZone(x, y).id);
  assert.deepStrictEqual([...seen].sort(), [1, 2, 3, 4, 5]);
});

test('game deploy resolver: game angle first, mirrored side views keep frame order', async () => {
  const { resolveGameStrip, materialize } = require('../lib/game-deploy');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-deploy-'));
  // 3-frame strip: frame i has a mark at x = 10 + i*20 (left part of each cell)
  const cells = [0, 1, 2].map((i) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect x="${10 + i * 20}" y="20" width="10" height="100" fill="#f00"/></svg>`), left: i * 180, top: 0 }));
  await sharp({ create: { width: 540, height: 180, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(cells).png().toFile(path.join(dir, 'c-side.png'));
  fs.copyFileSync(path.join(dir, 'c-side.png'), path.join(dir, 'c-game.png'));
  const slotDef = { sfAnim: 'crossover', fps: 13 };
  const saved = { cross_z3_left: { spriteUrl: '/assets/c-side.png', frameCount: 3, fps: 6 } };
  let r = resolveGameStrip({ assetsDir: dir, charId: 'c', sjSlot: 'crossover', slotDef, saved });
  assert.deepStrictEqual([r.source, r.mirror, r.frames, r.fps], ['side-mirrored', true, 3, 6]);
  await materialize(r, path.join(dir, 'out.png'));
  for (let i = 0; i < 3; i++) {
    const { data } = await sharp(path.join(dir, 'out.png')).extract({ left: i * 180, top: 0, width: 180, height: 180 }).raw().toBuffer({ resolveWithObject: true });
    let x0 = 999; for (let x = 0; x < 180; x++) if (data[(60 * 180 + x) * 4 + 3] > 0) { x0 = x; break; }
    assert.strictEqual(x0, 180 - (10 + i * 20) - 10, `frame ${i} mirrored in place`);
  }
  saved.cross_game_right = { spriteUrl: '/assets/c-game.png', frameCount: 3, fps: 6 };
  r = resolveGameStrip({ assetsDir: dir, charId: 'c', sjSlot: 'crossover', slotDef, saved });
  assert.deepStrictEqual([r.source, r.mirror], ['game-angle', false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OpenAI rate limit: learns input-image limit, waits and retries; no-credits fails fast', async () => {
  const saved = { o: process.env.OPENAI_API_KEY, m: process.env.MOCAP_MOCK };
  process.env.OPENAI_API_KEY = 'sk-test'; delete process.env.MOCAP_MOCK;
  const models = require('../lib/mocap/image-models');
  const realFetch = global.fetch;
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit reached for gpt-image-2.5-sunburst (for limit gpt-image) in organization org-x on input-images per min: Limit 5, Used 5, Requested 1. Please try again in 50ms.' } }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png.toString('base64') }], usage: {} }) };
  };
  try {
    const t0 = Date.now();
    const out = await models.openaiEdit({ model: 'gpt-image-2.5-sunburst', prompt: 'x', images: [png, png], size: '1024x1536' });
    assert.ok(out.buffer.length > 0);
    assert.strictEqual(n, 2);
    assert.strictEqual(models.inputImageLimit(), 5);
    assert.ok(Date.now() - t0 >= 500, 'waited the suggested retry delay');
    models._rl.limit = null; models._rl.log = [];
    n = 0;
    global.fetch = async () => { n++; return { ok: false, status: 429, json: async () => ({ error: { message: 'You have no credits remaining. Add credits to continue using the API.' } }) }; };
    await assert.rejects(models.openaiEdit({ model: 'gpt-image-2.5-sunburst', prompt: 'x', images: [png], size: '1024x1536' }), /no credits/);
    assert.strictEqual(n, 1, 'no retries on exhausted credits');
  } finally {
    global.fetch = realFetch;
    models._rl.limit = null; models._rl.log = [];
    if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o; else delete process.env.OPENAI_API_KEY;
    if (saved.m !== undefined) process.env.MOCAP_MOCK = saved.m;
  }
});

test('firebase storage backend: service-account parsing + stable download URLs', () => {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sa = { type: 'service_account', project_id: 'soul-jam-test', private_key_id: 'abc123', client_email: 'firebase-adminsdk@soul-jam-test.iam.gserviceaccount.com', private_key: k.replace(/\n/g, '\\n') };
  const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
  process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(JSON.stringify(sa)).toString('base64');
  delete require.cache[require.resolve('../lib/firebase-storage')];
  const fb = require('../lib/firebase-storage');
  try {
    assert.strictEqual(fb.isConfigured(), true);
    assert.strictEqual(fb.getBucket(), 'soul-jam-test.firebasestorage.app');
    const u1 = fb.getPublicUrl('game-assets/ankh-sj-crossover.png');
    assert.strictEqual(u1, fb.getPublicUrl('game-assets/ankh-sj-crossover.png'), 'deterministic token');
    assert.match(u1, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/soul-jam-test\.firebasestorage\.app\/o\/game-assets%2Fankh-sj-crossover\.png\?alt=media&token=[0-9a-f-]{36}$/);
    assert.notStrictEqual(fb.tokenFor('a'), fb.tokenFor('b'));
  } finally {
    if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved;
    delete require.cache[require.resolve('../lib/firebase-storage')];
  }
});

test('ball proxy: magenta disc becomes the canonical ball, fingers stay in front', async () => {
  const C = require('../lib/mocap/compose');
  const { CANVAS } = require('../lib/mocap/mannequin');
  // body block + magenta disc (r=40 at 400,500) with a grey "finger" bar over it
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.w}" height="${CANVAS.h}">
    <rect x="300" y="200" width="120" height="600" fill="#556070"/>
    <circle cx="400" cy="500" r="40" fill="#FF00FF"/>
    <rect x="380" y="470" width="40" height="10" fill="#8a6a50"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const px = async (b, x, y) => { const { data } = await sharp(b).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true }); return [...data]; };
  const prep = await C.prepareGenerated(buf, true);
  assert.ok(prep.proxyPx > 3000, 'proxy pixels found');
  assert.strictEqual(prep.stats.maxX, 419, 'disc excluded from body stats');
  const proxy = await C.findProxy(buf, { x: 405, y: 495, r: 40 });
  assert.ok(proxy && Math.abs(proxy.x - 400) < 2 && Math.abs(proxy.y - 500) < 2, 'disc located');
  const out = await C.swapProxyBall(buf, proxy);
  const centre = await px(out, 425, 505), finger = await px(out, 410, 475);
  assert.ok(centre[0] > 150 && centre[1] < 140 && centre[2] < 90 && centre[3] > 200, `ball colour at disc (${centre})`);
  assert.deepStrictEqual(finger.slice(0, 3), [0x8a, 0x6a, 0x50], 'finger drawn over the ball');
  // No magenta left anywhere
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  let mag = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 24 && C.isProxy(data[i], data[i + 1], data[i + 2])) mag++;
  assert.strictEqual(mag, 0);
  // No disc drawn → no proxy (falls back to physics compositing)
  assert.strictEqual(await C.findProxy(buf, { x: 100, y: 100, r: 40 }), null);
});
