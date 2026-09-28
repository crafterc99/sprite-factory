/**
 * Mocap routes — Stage 1 motion capture pipeline (see lib/mocap/pipeline.js).
 *
 *   GET  /api/mocap/status                       providers + keys configured
 *   GET  /api/mocap/models                       image models (+ availability)
 *   GET  /api/mocap/characters                   characters usable as targets
 *   POST /api/mocap/analyze                      { sessionId, name, fps, start, end, maxFrames, settings } → job
 *   GET  /api/mocap/job/:jobId                   poll any mocap job
 *   GET  /api/mocap/motions                      saved motions
 *   GET  /api/mocap/motion/:id                   { meta, motion }
 *   DELETE /api/mocap/motion/:id
 *   POST /api/mocap/motion/:id/reprocess         { settings } re-clean from raw
 *   GET  /api/mocap/motion/:id/frame/:i          source frame (?w=)
 *   GET  /api/mocap/motion/:id/overlay/:i        source frame + mask + keypoints + ball
 *   GET  /api/mocap/motion/:id/render            ?view&frame&char&mirror&ball&w → mannequin PNG
 *   GET  /api/mocap/motion/:id/sheet             ?view&char&mirror&w → all frames in one strip
 *   POST /api/mocap/generate                     { motionId, charName, views, hands, model, quality, frameStep, retries } → job
 *   GET  /api/mocap/results                      ?motionId
 *   GET  /api/mocap/result/:id
 *   POST /api/mocap/regen-frame                  { resultId, animName, frameIndex, customPrompt?, model? }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pipeline = require('../lib/mocap/pipeline');
const store = require('../lib/mocap/store');
const providers = require('../lib/mocap/providers');
const models = require('../lib/mocap/image-models');
const M = require('../lib/mocap/mannequin');
const S = require('../lib/mocap/skeleton');
const { recordCostExact } = require('../middleware/cost-tracker');

const jobs = new Map();
const sheetCache = new Map(); // mannequin preview sheets (cheap to rebuild, keyed by settings)
function startJob(kind) {
  const id = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  jobs.set(id, { id, kind, status: 'running', progress: null, result: null, error: null, startedAt: Date.now() });
  setTimeout(() => jobs.delete(id), 3 * 60 * 60 * 1000).unref();
  return id;
}
const patchJob = (id, p) => { const j = jobs.get(id); if (j) jobs.set(id, { ...j, ...p }); };

function sendPng(res, buf, maxAge = 60) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': `private, max-age=${maxAge}` });
  res.end(buf);
}

function register(router, ctx) {
  const { ASSETS_DIR, TMP_DIR, json, parseBody } = ctx;

  router.get('/api/mocap/status', (req, res) => {
    json(res, {
      fal: providers.status(),
      images: models.providerStatus(),
      ready: providers.status().fal || providers.status().mock,
      // Names only (never values) of key-like variables the server can see —
      // tells a misnamed/undeployed Railway variable apart from a missing one
      envSeen: Object.keys(process.env).filter((k) => /FAL|OPENAI|GEMINI|GOOGLE|APP_PASSWORD/i.test(k)).sort(),
      notes: {
        FAL_KEY: 'SAM 3 segmentation ($0.005/frame/prompt) + SAM 3D Body ($0.02/frame) via fal.ai',
        OPENAI_API_KEY: 'GPT Image 2.5 Sunburst / Flare',
        GEMINI_API_KEY: 'Nano Banana Pro / 2',
      },
    });
  });

  router.get('/api/mocap/models', (req, res) => json(res, { models: models.listModels() }));

  router.get('/api/mocap/characters', (req, res) => {
    const file = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../data/.characters.json');
    let reg = {};
    try { if (fs.existsSync(file)) reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const files = new Set(fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : []);
    const deleted = new Set(Array.isArray(reg._deleted) ? reg._deleted : []);
    const names = new Set(Object.keys(reg).filter((n) => n !== '_deleted'));
    for (const f of files) if (f.endsWith('full.png')) names.add(f.replace('full.png', ''));
    const characters = [...names].filter((n) => !deleted.has(n)).map((name) => {
      const c = reg[name] || {};
      const angles = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => files.has(`${name}-angle-${i}.png`));
      const portrait = files.has(`${name}full.png`) ? `/assets/${name}full.png?w=256` : angles.length ? `/assets/${name}-angle-${angles[0]}.png?w=256` : null;
      return { name, heightInches: c.heightInches || 72, pixelHeight: c.pixelHeight || 112, angles, portrait, usable: !!portrait };
    }).sort((a, b) => a.name.localeCompare(b.name));
    json(res, { characters });
  });

  router.get('/api/mocap/job/:jobId', (req, res, params) => {
    const j = jobs.get(params.jobId);
    if (!j) return json(res, { error: 'job not found (server restarted?)' }, 404);
    json(res, j);
  });

  // ── Analyze ──────────────────────────────────────────────────────────────
  router.post('/api/mocap/analyze', async (req, res) => {
    const body = await parseBody(req);
    if (!body.sessionId) return json(res, { error: 'sessionId required (upload a video first)' }, 400);
    const st = providers.status();
    if (!st.fal && !st.mock) return json(res, { error: 'FAL_KEY is not set on the server — add it in Railway → Variables' }, 400);
    const jobId = startJob('analyze');
    setImmediate(async () => {
      try {
        const out = await pipeline.analyzeVideo({ ...body, TMP_DIR }, (p) => patchJob(jobId, { progress: p }));
        if (out.meta.measureCost) recordCostExact('fal-sam3-sam3dbody', 'mocap_measure', out.meta.measureCost, { motionId: out.motionId });
        patchJob(jobId, { status: 'done', result: out });
      } catch (err) {
        console.error('[mocap] analyze failed:', err);
        patchJob(jobId, { status: 'error', error: err.message });
      }
    });
    json(res, { jobId });
  });

  router.get('/api/mocap/motions', async (req, res) => {
    const idx = await store.loadIndex();
    const motions = Object.values(idx.motions || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    json(res, { motions });
  });

  router.get('/api/mocap/motion/:id', async (req, res, params) => {
    const [meta, motion] = await Promise.all([store.loadMotionFile(params.id, 'meta'), store.loadMotionFile(params.id, 'motion')]);
    if (!meta || !motion) return json(res, { error: 'motion not found' }, 404);
    json(res, { meta, motion });
  });

  router.delete('/api/mocap/motion/:id', async (req, res, params) => {
    fs.rmSync(store.motionDir(params.id), { recursive: true, force: true });
    await store.removeFromIndex('motions', params.id);
    json(res, { success: true });
  });

  router.post('/api/mocap/motion/:id/reprocess', async (req, res, params) => {
    const body = await parseBody(req);
    try {
      const { meta } = await pipeline.reprocessMotion(params.id, body.settings || {});
      json(res, { success: true, meta });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  async function sourceFramePath(id, i) {
    const raw = await store.loadMotionFile(id, 'raw');
    const fr = raw?.frames?.[+i];
    if (!fr) return { raw, fr: null, p: null };
    const p = path.join(store.motionDir(id), 'frames', fr.file);
    return { raw, fr, p: fs.existsSync(p) ? p : null };
  }

  router.get('/api/mocap/motion/:id/frame/:i', async (req, res, params, query) => {
    const { p } = await sourceFramePath(params.id, params.i);
    if (!p) { res.writeHead(404); return res.end(); }
    const w = Math.min(1280, +query.w || 480);
    sendPng(res, await sharp(p).resize({ width: w, withoutEnlargement: true }).png().toBuffer(), 3600);
  });

  // Measurement check: what SAM 3 / SAM 3D Body actually saw on this frame
  router.get('/api/mocap/motion/:id/overlay/:i', async (req, res, params, query) => {
    const { fr, p } = await sourceFramePath(params.id, params.i);
    if (!p || !fr) { res.writeHead(404); return res.end(); }
    const meta = await sharp(p).metadata();
    const W = meta.width, H = meta.height;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
    const kp = fr.kp2d;
    if (kp) {
      const pairs = [
        ['left-shoulder', 'left-elbow', '#2f6bff'], ['left-elbow', 'left-wrist', '#2f6bff'],
        ['right-shoulder', 'right-elbow', '#eb3458'], ['right-elbow', 'right-wrist', '#eb3458'],
        ['left-hip', 'left-knee', '#2f6bff'], ['left-knee', 'left-ankle', '#2f6bff'],
        ['right-hip', 'right-knee', '#eb3458'], ['right-knee', 'right-ankle', '#eb3458'],
        ['left-shoulder', 'right-shoulder', '#ddd'], ['left-hip', 'right-hip', '#ddd'],
        ['left-shoulder', 'left-hip', '#ddd'], ['right-shoulder', 'right-hip', '#ddd'],
        ['left-ankle', 'left-big-toe-tip', '#2f6bff'], ['right-ankle', 'right-big-toe-tip', '#eb3458'],
      ];
      const lw = Math.max(3, W / 200);
      for (const [a, b, c] of pairs) {
        const A = kp[S.J[a]], B = kp[S.J[b]];
        if (A && B) svg += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" stroke="${c}" stroke-width="${lw}" stroke-linecap="round"/>`;
      }
      for (let k = 0; k < 21; k++) if (kp[k]) svg += `<circle cx="${kp[k][0]}" cy="${kp[k][1]}" r="${lw * 0.9}" fill="#fff" stroke="#000" stroke-width="1"/>`;
    }
    if (fr.ball) svg += `<circle cx="${fr.ball.u}" cy="${fr.ball.v}" r="${fr.ball.r}" fill="none" stroke="#ffb000" stroke-width="${Math.max(3, W / 250)}" stroke-dasharray="8 6"/>`;
    if (fr.error) svg += `<rect x="0" y="0" width="${W}" height="${Math.round(H / 14)}" fill="rgba(200,0,0,.75)"/><text x="12" y="${Math.round(H / 20)}" font-size="${Math.round(H / 32)}" fill="#fff" font-family="sans-serif">measure failed</text>`;
    svg += '</svg>';
    const layers = [];
    const maskP = path.join(store.motionDir(params.id), 'masks', `mask-${String(+params.i).padStart(3, '0')}.png`);
    if (fs.existsSync(maskP) && query.mask !== '0') {
      // Mask tint: green where SAM 3 says "person"
      const m = await sharp(maskP).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
      const tint = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i++) { if (m[i] > 127) { tint[i * 4 + 1] = 255; tint[i * 4 + 3] = 70; } }
      layers.push({ input: await sharp(tint, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() });
    }
    layers.push({ input: Buffer.from(svg) });
    const w = Math.min(1280, +query.w || 480);
    const out = await sharp(p).composite(layers).png().toBuffer();
    sendPng(res, await sharp(out).resize({ width: w, withoutEnlargement: true }).png().toBuffer(), 600);
  });

  function renderOpts(query, motion) {
    let statureM = motion.statureM;
    if (query.char) statureM = pipeline.loadCharacter(query.char).statureM;
    return { view: +query.view || 1, mirror: query.mirror === '1', statureM, drawBall: query.ball !== '0' };
  }

  router.get('/api/mocap/motion/:id/render', async (req, res, params, query) => {
    const motion = await store.loadMotionFile(params.id, 'motion');
    if (!motion) return json(res, { error: 'motion not found' }, 404);
    const o = renderOpts(query, motion);
    const ppm = M.fitScale(motion, { statureM: o.statureM, mirror: o.mirror });
    const fi = Math.max(0, Math.min(motion.frameCount - 1, +query.frame || 0));
    const w = Math.min(768, +query.w || 384);
    const r = await M.renderFrame(motion, fi, { ...o, ppm, previewWidth: w });
    sendPng(res, r.png, 30);
  });

  router.get('/api/mocap/motion/:id/sheet', async (req, res, params, query) => {
    const motion = await store.loadMotionFile(params.id, 'motion');
    if (!motion) return json(res, { error: 'motion not found' }, 404);
    const o = renderOpts(query, motion);
    const ppm = M.fitScale(motion, { statureM: o.statureM, mirror: o.mirror });
    const w = Math.min(384, +query.w || 192);
    const h = Math.round((w * M.CANVAS.h) / M.CANVAS.w);
    const key = JSON.stringify([params.id, motion.settings, motion.frameCount, o, w]);
    let buf = sheetCache.get(key);
    if (!buf) {
      const tiles = await Promise.all(Array.from({ length: motion.frameCount }, async (_, i) => {
        const r = await M.renderFrame(motion, i, { ...o, ppm, previewWidth: w });
        return { input: await sharp(r.png).resize(w, h, { fit: 'fill' }).png().toBuffer(), left: i * w, top: 0 };
      }));
      buf = await sharp({ create: { width: w * motion.frameCount, height: h, channels: 4, background: '#ffffff' } }).composite(tiles).png().toBuffer();
      sheetCache.set(key, buf);
      if (sheetCache.size > 60) sheetCache.delete(sheetCache.keys().next().value);
    }
    res.setHeader('X-Frame-Width', String(w));
    res.setHeader('X-Frame-Count', String(motion.frameCount));
    sendPng(res, buf, 30);
  });

  // ── Generate ─────────────────────────────────────────────────────────────
  router.post('/api/mocap/generate', async (req, res) => {
    const body = await parseBody(req);
    if (!body.motionId || !body.charName) return json(res, { error: 'motionId and charName required' }, 400);
    const info = models.listModels().find((m) => m.id === body.model) || models.listModels()[2];
    if (!info.available) return json(res, { error: `${info.label} is not configured — add ${info.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} in Railway → Variables` }, 400);
    const jobId = startJob('generate');
    setImmediate(async () => {
      try {
        const out = await pipeline.generateMove({ ...body, model: info.id, ASSETS_DIR, TMP_DIR }, (p) => patchJob(jobId, { progress: p }));
        if (out.cost) recordCostExact(out.model, 'mocap_generate', out.cost, { resultId: out.id, charName: out.charName });
        patchJob(jobId, { status: 'done', result: out });
      } catch (err) {
        console.error('[mocap] generate failed:', err);
        patchJob(jobId, { status: 'error', error: err.message });
      }
    });
    json(res, { jobId });
  });

  router.get('/api/mocap/results', async (req, res, params, query) => {
    const idx = await store.loadIndex();
    let results = Object.values(idx.results || {});
    if (query.motionId) results = results.filter((r) => r.motionId === query.motionId);
    results.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    json(res, { results });
  });

  router.get('/api/mocap/result/:id', async (req, res, params) => {
    const r = await store.loadResult(params.id);
    if (!r) return json(res, { error: 'result not found' }, 404);
    json(res, { result: r });
  });

  router.post('/api/mocap/regen-frame', async (req, res) => {
    const body = await parseBody(req);
    if (!body.resultId || !body.animName || body.frameIndex == null) return json(res, { error: 'resultId, animName, frameIndex required' }, 400);
    try {
      const out = await pipeline.regenFrame({ ...body, ASSETS_DIR, TMP_DIR });
      json(res, { success: true, ...out });
    } catch (err) {
      console.error('[mocap] regen failed:', err);
      json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
