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
 *
 *   3D animation set (court3d.html → engine3d/anim3d.mjs)
 *   GET  /api/mocap3d/library                    motions + game role/settings/quality, roles, characters
 *   GET  /api/mocap3d/clip/:id                   built game clip (gz JSON, ETag)
 *   PUT  /api/mocap3d/clip/:id                   { role, type, trimStart, trimEnd, warp, entryMax, mirror, notes } → rebuilt
 *   POST /api/mocap3d/clip/:id/build             force a rebuild
 *   GET  /api/mocap3d/rig/:char                  character rig (gz JSON, ETag) ?motion&frame
 *   GET|PUT|DELETE /api/mocap3d/contacts/:id     ball contact edits of a clip (Contact Editor; meta.ballContacts)
 *   GET  /api/mocap3d/outfits/:char              the character's garments (outfit picker)
 *   GET  /api/mocap3d/outfit/:char/:gid          one garment (gz JSON, ETag)
 *   POST /api/mocap3d/character/generate          character from video: A-pose views → Rodin 3D { motionId, frames, outfit }
 *   GET  /api/mocap3d/character/job/:id[/file/:n]  job status / its files (views, model.glb, textures)
 *   POST /api/mocap3d/generate                   { kind: run-dribble | crossover | crossover-moving, hand, speed } → new motion
 *   POST /api/mocap3d/import                     { name, role, fps, skeleton: mhr70|soma|smplx, frames, upAxis, units } → new motion
 *   POST /api/mocap3d/import-kimodo              raw Kimodo .npz body ?name&role&arms=dribble|crossover|none&hand&prompt → new motion
 *
 *   Move controls (the right-stick bindings: engine3d/move-controls.mjs, stored by lib/mocap/move-controls-store.js)
 *   GET  /api/mocap3d/controls                   { controls, isDefault, defaults, conflicts, moves } (?moves=0: no registry)
 *   PUT  /api/mocap3d/controls                   { bindings: [...] } replaces them all ({ reset: true }: the defaults)
 *   PUT  /api/mocap3d/controls/:role             one move's trigger { steps, mirror?, mode?, fallback? } (or { bindings: [...] }
 *                                                several, { steps: null } none); 409 when another move has the same trigger
 *                                                (?unbindOthers=1 / unbindOthers: true takes it from them)
 *   DELETE /api/mocap3d/controls/:role           the move has no trigger
 *   POST /api/mocap3d/controls/reset             { role? } the defaults (all, or that move's)
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

function register(baseRouter, ctx) {
  const { ASSETS_DIR, TMP_DIR, json, parseBody } = ctx;
  // Every :id must already be a canonical id: store.safeId strips characters,
  // so '~' or 'a.' would otherwise alias another motion (or the data root).
  const guard = (h) => (req, res, params, query) => {
    if (params && 'id' in params && (!params.id || store.safeId(params.id) !== params.id)) return json(res, { error: 'Invalid id' }, 400);
    return h(req, res, params, query);
  };
  const router = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m, (p, h) => baseRouter[m](p, guard(h))]));

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

  // ── Character from a turnaround sheet ────────────────────────────────────
  // Body: { name, heightInches, imageBase64, order?, description?, fillAngles?, model? }
  // → splits the sheet into angle references ({name}-angle-{i}.png + {name}full.png),
  //   registers the character, optionally generates the missing 45° game angles.
  router.post('/api/mocap/character-from-sheet', async (req, res) => {
    const body = await parseBody(req);
    const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!name || !body.imageBase64) return json(res, { error: 'name and imageBase64 required' }, 400);
    const jobId = startJob('character');
    setImmediate(async () => {
      const t0 = Date.now();
      try {
        const { splitSheet, toReferenceCanvas } = require('../lib/mocap/character-sheet');
        const r2 = require('../lib/r2-storage');
        const { loadCharacters, saveCharacters, computeScale } = require('./characters');
        const buf = Buffer.from(String(body.imageBase64).replace(/^data:[^,]+,/, ''), 'base64');
        patchJob(jobId, { progress: { msg: 'Splitting sheet…', done: 0, total: 1 } });
        const sheet = await splitSheet(buf, { order: body.order || 'front,right,back,left' });
        const written = [];
        const save = async (file, png) => {
          const p = path.join(ASSETS_DIR, file);
          fs.mkdirSync(ASSETS_DIR, { recursive: true });
          fs.writeFileSync(p, png);
          if (r2.isAvailable()) await r2.uploadFile(file, p);
          written.push(`/assets/${file}`);
        };
        const cutouts = {};
        for (const p of sheet.poses) {
          if (p.angleIdx == null) continue;
          cutouts[p.angleIdx] = p.png;
          const canvas = await toReferenceCanvas(p.png);
          await save(`${name}-angle-${p.angleIdx}.png`, canvas);
          if (p.angleIdx === 0) await save(`${name}full.png`, canvas);
        }

        // Missing 45° game angles (Z2 front-left = 7, Z4 back-left = 5)
        // 7 front-left + 5 back-left (court zones), 1 front-right (the Soul Jam game angle)
        const fill = body.fillAngles === false ? [] : [7, 5, 1].filter((i) => !cutouts[i]);
        const filled = [];
        let fillError = null;
        if (fill.length && cutouts[0]) try {
          const info = models.listModels().find((m) => m.id === body.model) || models.listModels().find((m) => m.available);
          if (info?.available) {
            const refs = [cutouts[0], cutouts[6] || cutouts[2], cutouts[4]].filter(Boolean);
            const desc = { 1: 'a three-quarter FRONT-RIGHT view: body turned 45° so the character faces between the viewer and the RIGHT edge of the image (we see the face and chest, and their left side)', 7: 'a three-quarter FRONT-LEFT view: body turned 45° so the character faces between the viewer and the left edge of the image (we see the face and chest, and their right side)', 5: 'a three-quarter BACK-LEFT view: body turned so the character faces away from the viewer and toward the left edge of the image (we see the back of the head and back, and a little of their right side)' };
            let k = 0;
            for (const idx of fill) {
              patchJob(jobId, { progress: { msg: `Generating ${({ 7: 'front-left', 5: 'back-left', 1: 'front-right (game)' })[idx]} angle…`, done: ++k, total: fill.length + 1 } });
              const prompt = [
                'These images are a character turnaround of ONE character: Image 1 front view, Image 2 side view, Image 3 back view.',
                `Draw this exact same character standing in the same relaxed neutral pose from ${desc[idx]}.`,
                'Keep every detail identical: face, hair, skin tone, tattoos, clothing, shorts pattern, socks, shoes, colours, line art and shading style. Same body proportions and height.',
                'Full body head to feet, nothing cropped, one character only, no floor, no shadow, no text.',
                info.transparent ? 'Background: fully transparent.' : 'Background: solid pure green #00FF00.',
              ].join('\n');
              const gen = await models.generateImage({ model: info.id, prompt, images: refs, quality: 'high' });
              let png = gen.buffer;
              if (!gen.transparent) {
                const C = require('../lib/mocap/compose');
                png = (await C.prepareGenerated(png, false)).buf;
              }
              const st = await M.alphaStats(png);
              if (st) png = await sharp(png).extract({ left: st.minX, top: st.minY, width: st.w, height: st.h }).png().toBuffer();
              await save(`${name}-angle-${idx}.png`, await toReferenceCanvas(png));
              if (gen.cost) recordCostExact(info.id, 'character_angle', gen.cost, { name, angle: idx });
              filled.push(idx);
            }
          }
        } catch (e) {
          // Missing angles are optional — register the character with what the
          // sheet provided (court/generation fall back to the front angle)
          fillError = e.message;
          console.warn('[mocap] angle fill failed, continuing:', e.message);
        }

        // Register (through the characters module so its cache + R2 backup stay in sync)
        const reg = loadCharacters();
        const heightInches = Math.max(60, Math.min(90, +body.heightInches || 74));
        const { scaleMultiplier, pixelHeight } = computeScale(heightInches);
        reg[name] = {
          ...(reg[name] || {}), name, id: name,
          description: body.description || reg[name]?.description || 'the character shown in the reference — keep their exact appearance, outfit, hairstyle, skin tone, tattoos and proportions',
          style: 'clean anime illustration',
          heightInches, scaleMultiplier, pixelHeight,
          portraitPath: `${name}full.png`, status: 'confirmed', source: 'character-sheet',
          savedAnimations: reg[name]?.savedAnimations || {},
        };
        if (Array.isArray(reg._deleted)) reg._deleted = reg._deleted.filter((n) => n !== name);
        await saveCharacters(reg);
        patchJob(jobId, { status: 'done', result: { name, heightInches, pixelHeight, angles: Object.keys(cutouts).map(Number).concat(filled).sort((a, b) => a - b), files: written, fillError, seconds: +((Date.now() - t0) / 1000).toFixed(1) } });
      } catch (err) {
        console.error('[mocap] character-from-sheet failed:', err);
        patchJob(jobId, { status: 'error', error: err.message });
      }
    });
    json(res, { jobId });
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

  // ── 3D sandbox (court3d.html) ──────────────────────────────────────────
  // Motions that have SAM 3D Body meshes → playable on the 3D court
  router.get('/api/mocap3d/motions', async (req, res) => {
    const idx = await store.loadIndex();
    const out = [];
    for (const m of Object.values(idx.motions || {})) {
      const meta = await store.loadMotionFile(m.id || m.motionId || '', 'meta').catch(() => null);
      if (meta?.mesh?.frames) out.push({ id: meta.id, name: meta.name, frameCount: meta.frameCount, fps: meta.fps, shot: !!meta.report?.shotRelease, createdAt: meta.createdAt });
    }
    json(res, { motions: out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
  });
  // Baked 3D character animation for one motion (gzipped JSON, cached)
  router.get('/api/mocap3d/bake/:id', async (req, res, params) => {
    try {
      const { gz, rawLength } = await require('../lib/mocap/bake3d').bakeGz(params.id);
      // X-Raw-Length: the decompressed size, so the page can show real progress
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, 'X-Raw-Length': rawLength, 'Cache-Control': 'private, max-age=300' });
      res.end(gz);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── 3D animation set (skeletal runtime: engine3d/anim3d.mjs) ──────────
  const GC = require('../lib/mocap/game-clips');
  const RIG = require('../lib/mocap/character-rig');
  const { roleDef } = require('../lib/mocap/game-roles');
  // gzipped JSON with an ETag (304 when the browser already has it)
  const sendGz = (req, res, { gz, etag, json: j }) => {
    const inm = String(req.headers['if-none-match'] || '').split(/\s*,\s*/).map((t) => t.replace(/^W\//, ''));
    if (etag && inm.includes(etag)) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, ETag: etag, 'Cache-Control': 'private, no-cache', 'X-Raw-Length': j ? Buffer.byteLength(JSON.stringify(j)) : '' });
    res.end(gz);
  };
  // Every motion with its game role/settings + build quality; the roles table; characters
  router.get('/api/mocap3d/library', async (req, res) => {
    try {
      const clips = await GC.library();
      // (roles: the game's, plus the new move roles clips were given — move-<name>)
      json(res, { clips, court: await GC.clipsForCourt(clips), roles: GC.rolesFor(clips), characters: RIG.listCharacters() });
    } catch (err) { json(res, { error: err.message }, 500); }
  });
  router.get('/api/mocap3d/characters', (req, res) => json(res, { characters: RIG.listCharacters() }));
  // Built game clip (gz JSON, ETag)
  router.get('/api/mocap3d/clip/:id', async (req, res, params) => {
    try { sendGz(req, res, await GC.build(params.id)); }
    catch (err) { json(res, { error: err.message }, 400); }
  });
  // Save game settings { role, type, trimStart, trimEnd, warp, entryMax, mirror, notes } → rebuilt summary
  router.put('/api/mocap3d/clip/:id', async (req, res, params) => {
    const body = await parseBody(req);
    try {
      const prev = (await store.loadMotionFile(params.id, 'meta'))?.game;
      const game = await GC.saveSettings(params.id, body || {});
      let j;
      // settings that don't build are not kept: the motion stays as it was
      try { ({ json: j } = await GC.build(params.id, { force: true })); }
      catch (err) { await GC.restoreSettings(params.id, prev); throw err; }
      json(res, { success: true, game, built: GC.summary(j) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });
  router.post('/api/mocap3d/clip/:id/build', async (req, res, params) => {
    try {
      const { json: j } = await GC.build(params.id, { force: true });
      json(res, { success: true, game: j.game, built: GC.summary(j) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });
  // Generated motions (not filmed): { kind: 'run-dribble' | 'crossover' | 'crossover-moving', hand, speed }
  // Character from video: A-pose views of the performer → Rodin 3D model (lib/mocap/character-gen.js)
  router.post('/api/mocap3d/character/generate', async (req, res) => {
    const body = (await parseBody(req)) || {};
    try { json(res, { job: require('../lib/mocap/character-gen').start(body) }); }
    catch (err) { json(res, { error: err.message }, 400); }
  });
  router.get('/api/mocap3d/character/job/:id', async (req, res, params) => {
    const job = require('../lib/mocap/character-gen').getJob(params.id);
    if (!job) return json(res, { error: 'job not found' }, 404);
    json(res, { job });
  });
  router.get('/api/mocap3d/character/job/:id/file/:name', async (req, res, params) => {
    const p = require('../lib/mocap/character-gen').filePath(params.id, params.name);
    if (!p) { res.writeHead(404); return res.end(); }
    const type = /\.glb$/i.test(p) ? 'model/gltf-binary' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png';
    const buf = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });

  router.post('/api/mocap3d/generate', async (req, res) => {
    const body = (await parseBody(req)) || {};
    try {
      const GEN = require('../lib/mocap/motion-gen');
      const GM = require('../lib/mocap/generated-motions');
      const hand = body.hand === 'left' ? 'left' : 'right';
      const kinds = {
        'run-dribble': () => GEN.runDribble({ hand, speed: Math.max(2.5, Math.min(6.5, +body.speed || 4.4)) }),
        crossover: () => GEN.crossover({ hand }),
        'crossover-moving': () => GEN.crossover({ hand, moving: true }),
      };
      if (!kinds[body.kind]) return json(res, { error: `kind must be one of ${Object.keys(kinds).join(', ')}` }, 400);
      const id = await GM.saveGenerated(kinds[body.kind]());
      const { json: j } = await GC.build(id, { force: true });
      json(res, { success: true, id, name: j.name, role: j.role, built: GC.summary(j) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });
  // Import joint positions from a motion generator (Kimodo) or any tool:
  // { name, role, type, fps, skeleton: 'mhr70' | 'soma' | 'smplx', jointNames?, frames, upAxis: 'y'|'z', units: 'm'|'cm', balls?, hand? }
  router.post('/api/mocap3d/import', async (req, res) => {
    const body = (await parseBody(req)) || {};
    try {
      const K = require('../lib/mocap/kimodo');
      const GM = require('../lib/mocap/generated-motions');
      const GEN = require('../lib/mocap/motion-gen');
      const frames = K.toMHR70(body);
      const fps = +body.fps || 30;
      const balls = Array.isArray(body.balls) && body.balls.length === frames.length ? body.balls : GEN.synthesizeBall(frames, fps, { hand: body.hand || null });
      const role = body.role && roleDef(body.role) ? body.role : null;
      const id = await GM.saveGenerated({
        name: String(body.name || 'imported motion').slice(0, 80), role, type: body.type || (role ? roleDef(role).type : 'action'),
        fps, statureM: +body.statureM || 1.8, frames, balls, source: String(body.source || body.skeleton || 'import').slice(0, 40), prompt: body.prompt ? String(body.prompt).slice(0, 500) : null,
        entryMax: body.entryMax != null ? +body.entryMax : undefined,
      });
      const { json: j } = await GC.build(id, { force: true });
      json(res, { success: true, id, built: GC.summary(j) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  // Kimodo "Download → NPZ" straight in (raw body, ≤ 30 MB):
  // ?name&role&arms=dribble|crossover|none&hand=right|left&prompt=
  // arms: Kimodo has no ball — "dribble" scripts the dribble arm onto the body
  // (one push per stride, synced to the foot plants), "crossover" crosses the
  // ball at the motion's sharpest cut, "none" keeps Kimodo's arms (ball read from the hands)
  router.post('/api/mocap3d/import-kimodo', async (req, res, params, query) => {
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 30e6) throw new Error('file too large (max 30 MB)'); chunks.push(c); }
      const K = require('../lib/mocap/kimodo');
      const GEN = require('../lib/mocap/motion-gen');
      const GM = require('../lib/mocap/generated-motions');
      const src = K.kimodoFrames(Buffer.concat(chunks));
      const frames = K.toMHR70({ skeleton: 'soma', frames: src.frames, rotations: src.rotations });
      const fps = +query.fps || 30, hand = query.hand === 'left' ? 'left' : 'right';
      const arms = ['dribble', 'crossover', 'none'].includes(query.arms) ? query.arms : 'dribble';
      const g = arms === 'dribble' ? GEN.dribbleOnto(frames, fps, { hand }) : arms === 'crossover' ? GEN.crossoverOnto(frames, fps, { hand }) : { frames, balls: GEN.synthesizeBall(frames, fps) };
      const role = query.role && roleDef(query.role) ? query.role : (arms === 'crossover' ? 'move-crossover' : null);
      const type = query.type || (role ? roleDef(role).type : arms === 'crossover' ? 'action' : 'loop');
      const id = await GM.saveGenerated({
        name: String(query.name || 'Kimodo motion').slice(0, 80), role, type, fps, statureM: 1.8, frames: g.frames, balls: g.balls,
        source: 'kimodo', prompt: query.prompt ? String(query.prompt).slice(0, 500) : null, entryMax: g.entryMax,
        params: { arms, hand },
      });
      const { json: j } = await GC.build(id, { force: true });
      json(res, { success: true, id, built: GC.summary(j) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  // Ball contacts of a clip (Contact Editor): the saved edits (null = the automatic detection is used)
  router.get('/api/mocap3d/contacts/:id', async (req, res, params) => {
    try { json(res, { id: params.id, contacts: await GC.loadBallContacts(params.id) }); }
    catch (err) { json(res, { error: err.message }, 404); }
  });
  router.put('/api/mocap3d/contacts/:id', async (req, res, params) => {
    try {
      const body = await parseBody(req);
      json(res, { success: true, id: params.id, contacts: await GC.saveBallContacts(params.id, body?.contacts ?? null) });
    } catch (err) { json(res, { error: err.message }, 400); }
  });
  router.delete('/api/mocap3d/contacts/:id', async (req, res, params) => {
    try { await GC.saveBallContacts(params.id, null); json(res, { success: true, id: params.id, contacts: null }); }
    catch (err) { json(res, { error: err.message }, 400); }
  });

  // ── Move controls: the right-stick bindings — which gesture / sequence plays which move ──
  const MCS = require('../lib/mocap/move-controls-store');
  const MCM = () => import('../engine3d/move-controls.mjs');
  /** Every move the court can play (the library's clips by role, the roles table) with its triggers. */
  async function moveRegistryFor(bindings) {
    const { moveRegistry } = await MCM();
    const lib = await GC.library();
    const clips = {};
    for (const c of await GC.clipsForCourt(lib)) {
      const h = lib.find((m) => m.id === c.id)?.built?.hands;
      (clips[c.role] ||= []).push({ id: c.id, name: c.name, ...(h?.entry ? { hand: h.entry } : {}), ...(h?.exit ? { endHand: h.exit } : {}) });
    }
    return moveRegistry({ roles: GC.rolesFor(lib), clips, bindings });
  }
  async function controlsView(controls, isDefault, query = {}, extra = {}) {
    const { defaultControls, allConflicts } = await MCM();
    const out = { ...extra, controls, isDefault, defaults: defaultControls(), conflicts: allConflicts(controls.bindings) };
    if (query.moves !== '0') { try { out.moves = await moveRegistryFor(controls.bindings); } catch (e) { out.moves = null; out.movesError = e.message; } }
    return out;
  }
  const sendSaved = async (res, r, query, status = 200) => {
    if (!r.ok) return json(res, { error: 'invalid move controls', errors: r.errors, conflicts: r.conflicts || [] }, 400);
    json(res, await controlsView(r.controls, !!r.controls.reset, query, { success: true, savedToCloud: r.savedToCloud, cloudError: r.cloudError, storage: r.storage }), status);
  };
  /** A move's new bindings among the rest (its place in the list kept: the order breaks exact ties). */
  async function withRole(role, mine, { unbindOthers = false } = {}) {
    const { normalizeBinding, conflictsOf, relation } = await MCM();
    const errors = [];
    const clean = mine.map((b, i) => { const r = normalizeBinding({ ...b, role }); if (!r.ok) errors.push(...r.errors.map((e) => `trigger ${i + 1}: ${e}`)); return r.binding; });
    if (errors.length) return { errors };
    const cur = (await MCS.load()).controls.bindings;
    let others = cur.filter((b) => b.role !== role);
    const conflicts = clean.flatMap((b) => conflictsOf(b, others));
    const same = conflicts.filter((c) => c.type === 'same');
    if (same.length && !unbindOthers) return { conflict: same, conflicts };
    if (unbindOthers) others = others.filter((o) => !clean.some((b) => relation(b, o)?.type === 'same'));
    const at = cur.findIndex((b) => b.role === role), before = at < 0 ? others.length : cur.slice(0, at).filter((b) => others.includes(b)).length;
    return { bindings: [...others.slice(0, before), ...clean, ...others.slice(before)], conflicts, unbound: same.map((c) => c.role) };
  }
  const roleParam = async (res, role) => { const { isMoveRole } = await MCM(); if (isMoveRole(role)) return true; json(res, { error: `"${String(role).slice(0, 60)}" is not a move role (move-…)` }, 400); return false; };
  router.get('/api/mocap3d/controls', async (req, res, params, query) => {
    try { const st = await MCS.load(); json(res, await controlsView(st.controls, st.isDefault, query, { source: st.source })); }
    catch (err) { json(res, { error: err.message }, 500); }
  });
  router.put('/api/mocap3d/controls', async (req, res, params, query) => {
    try {
      const body = await parseBody(req);
      await sendSaved(res, await MCS.save(body?.reset === true ? null : body), query);
    } catch (err) { json(res, { error: err.message }, 500); }
  });
  router.post('/api/mocap3d/controls/reset', async (req, res, params, query) => {
    try {
      const body = await parseBody(req);
      if (!body?.role) return sendSaved(res, await MCS.save(null), query);
      if (!(await roleParam(res, body.role))) return;
      const { DEFAULT_BINDINGS } = await MCM();
      const w = await withRole(body.role, DEFAULT_BINDINGS.filter((b) => b.role === body.role), { unbindOthers: body.unbindOthers === true || query.unbindOthers === '1' });
      if (w.conflict) return json(res, { error: 'another move has this trigger', conflicts: w.conflict }, 409);
      await sendSaved(res, await MCS.save({ bindings: w.bindings }), query);
    } catch (err) { json(res, { error: err.message }, 500); }
  });
  router.put('/api/mocap3d/controls/:role', async (req, res, params, query) => {
    try {
      if (!(await roleParam(res, params.role))) return;
      const body = await parseBody(req);
      const { unbindOthers, ...b } = body || {};
      const mine = b.steps === null || (Array.isArray(b.bindings) && !b.bindings.length) ? [] : Array.isArray(b.bindings) ? b.bindings : [b];
      const w = await withRole(params.role, mine, { unbindOthers: unbindOthers === true || query.unbindOthers === '1' });
      if (w.errors) return json(res, { error: 'invalid trigger', errors: w.errors }, 400);
      if (w.conflict) return json(res, { error: 'another move has this trigger', conflicts: w.conflict }, 409);
      await sendSaved(res, await MCS.save({ bindings: w.bindings }), query);
    } catch (err) { json(res, { error: err.message }, 500); }
  });
  router.delete('/api/mocap3d/controls/:role', async (req, res, params, query) => {
    try {
      if (!(await roleParam(res, params.role))) return;
      const w = await withRole(params.role, []);
      await sendSaved(res, await MCS.save({ bindings: w.bindings }), query);
    } catch (err) { json(res, { error: err.message }, 500); }
  });

  // Character rig (skinned mesh + skeleton), ?motion=&frame= to build from another scan
  // outfits of a character (the court's outfit picker): the list, then one garment (gz JSON, ETag)
  router.get('/api/mocap3d/outfits/:char', async (req, res, params) => {
    json(res, RIG.outfitIndex(params.char) || { rig: params.char, garments: [] });
  });
  router.get('/api/mocap3d/outfit/:char/:gid', async (req, res, params) => {
    const f = RIG.outfitFile(params.char, params.gid);
    if (!f) return json(res, { error: 'no such garment' }, 404);
    sendGz(req, res, f);
  });
  router.get('/api/mocap3d/rig/:char', async (req, res, params, query) => {
    try { sendGz(req, res, await RIG.buildRig(params.char, { motionId: query.motion || undefined, frame: query.frame || undefined, legacy: query.legacy === '1' })); }
    catch (err) { json(res, { error: err.message }, 400); }
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

  // Add SAM 3D Body meshes + hand close-ups to an existing motion
  router.post('/api/mocap/motion/:id/enrich', async (req, res, params) => {
    const st = providers.status();
    if (!st.fal && !st.mock) return json(res, { error: 'FAL_KEY is not set on the server' }, 400);
    const jobId = startJob('enrich');
    setImmediate(async () => {
      try {
        const out = await pipeline.enrichMotion(params.id, (p) => patchJob(jobId, { progress: p }));
        if (out.cost) recordCostExact('fal-sam3dbody-mesh', 'mocap_enrich', out.cost, { motionId: params.id });
        sheetCache.clear();
        patchJob(jobId, { status: 'done', result: out });
      } catch (err) {
        console.error('[mocap] enrich failed:', err);
        patchJob(jobId, { status: 'error', error: err.message });
      }
    });
    json(res, { jobId });
  });

  async function sourceFramePath(id, i) {
    const raw = await store.loadMotionFile(id, 'raw');
    const fr = raw?.frames?.[+i];
    if (!fr) return { raw, fr: null, p: null };
    const p = path.join(store.motionDir(id), 'frames', fr.file);
    if (fs.existsSync(p)) return { raw, fr, p };
    // frames on disk go with a redeploy: the analysis keeps each source frame as a cloud asset
    const asset = await store.loadMotionAsset(id, `src-${String(fr.index ?? +i).padStart(3, '0')}.jpg`).catch(() => null);
    return { raw, fr, p: asset && fs.existsSync(asset) ? asset : null };
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
    return { view: +query.view || 1, mirror: query.mirror === '1', statureM, drawBall: query.ball !== '0', guide: query.guide === 'mannequin' ? 'mannequin' : 'mesh' };
  }
  const meshFor = (id, o) => (o.guide === 'mesh' ? pipeline.getMeshCtx(id) : null);

  router.get('/api/mocap/motion/:id/render', async (req, res, params, query) => {
    const motion = await store.loadMotionFile(params.id, 'motion');
    if (!motion) return json(res, { error: 'motion not found' }, 404);
    const o = renderOpts(query, motion);
    const ppm = M.fitScale(motion, { statureM: o.statureM, mirror: o.mirror });
    const fi = Math.max(0, Math.min(motion.frameCount - 1, +query.frame || 0));
    const w = Math.min(768, +query.w || 384);
    const r = await M.renderFrame(motion, fi, { ...o, ppm, previewWidth: w, meshCtx: await meshFor(params.id, o) });
    res.setHeader('X-Guide', r.guide || 'mannequin');
    sendPng(res, r.png, 30);
  });

  router.get('/api/mocap/motion/:id/sheet', async (req, res, params, query) => {
    const motion = await store.loadMotionFile(params.id, 'motion');
    if (!motion) return json(res, { error: 'motion not found' }, 404);
    const o = renderOpts(query, motion);
    const ppm = M.fitScale(motion, { statureM: o.statureM, mirror: o.mirror });
    const w = Math.min(384, +query.w || 192);
    const h = Math.round((w * M.CANVAS.h) / M.CANVAS.w);
    const key = JSON.stringify([params.id, motion.settings, motion.frameCount, o, w, !!(await meshFor(params.id, o))]);
    let buf = sheetCache.get(key);
    const meshCtx = await meshFor(params.id, o);
    if (!buf) {
      const tiles = await Promise.all(Array.from({ length: motion.frameCount }, async (_, i) => {
        const r = await M.renderFrame(motion, i, { ...o, ppm, previewWidth: w, meshCtx });
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

  // Re-align + re-composite from stored raw generations (no model calls)
  router.post('/api/mocap/recompose', async (req, res) => {
    const body = await parseBody(req);
    if (!body.resultId) return json(res, { error: 'resultId required' }, 400);
    try {
      const t0 = Date.now();
      const out = await pipeline.recomposeResult({ ...body, ASSETS_DIR, TMP_DIR });
      json(res, { success: true, seconds: +((Date.now() - t0) / 1000).toFixed(1), variantsRecomposed: out.variantsRecomposed, result: out.result });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Raw per-frame measurements (debugging / offline re-processing)
  router.get('/api/mocap/motion/:id/raw', async (req, res, params) => {
    const raw = await store.loadMotionFile(params.id, 'raw');
    if (!raw) return json(res, { error: 'motion not found' }, 404);
    json(res, raw);
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
