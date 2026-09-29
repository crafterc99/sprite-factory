'use strict';
/**
 * Character Factory API (/api/cf/*). Thin layer over tools/character_pipeline/: the same manifest,
 * stage graph and CLI the command line uses. Heavy work runs as jobs (CLI processes), never here.
 * See docs/character-factory-plan.md §7.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CP = path.join(ROOT, 'tools', 'character_pipeline');
const CHAR_DIR = path.join(ROOT, 'assets', 'characters');
const RIGS = path.join(ROOT, 'lib', 'mocap', 'mhr-rigs');
const ID_RE = /^[a-z0-9_-]{2,40}$/;
const PARTS = ['body', 'head', 'hand_left', 'hand_right', 'hair', 'shoes', 'clothing', 'accessory'];
const VIEWS = ['front', 'left', 'right', 'back', '3/4', 'palm', 'back-of-hand', 'thumb', 'pinky', 'unknown'];
const IMG_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]];

let _mods = null;
async function mods() {
  if (_mods) return _mods;
  const imp = (f) => import(path.join(CP, f));
  const [config, manifest, state, jobs, stages, refs, tripo] = await Promise.all(['config.mjs', 'manifest.mjs', 'state.mjs', 'jobs.mjs', 'stages.mjs', 'refs.mjs', 'tripo-client.mjs'].map(imp));
  _mods = { config, manifest, state, jobs, stages, refs, tripo };
  return _mods;
}

function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function fail(res, status, error, extra = {}) { json(res, { error, ...extra }, status); }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error(`file larger than ${Math.round(limit / 1048576)} MB`), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function readJson(req) { const b = await readRaw(req, 1 << 20); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
const charExists = (id) => ID_RE.test(id) && fs.existsSync(path.join(CHAR_DIR, id, 'manifests', 'character.json'));
const fileUrl = (id, rel) => (rel ? `/api/cf/characters/${id}/file?path=${encodeURIComponent(rel)}` : null);
const exists = (id, rel) => !!rel && fs.existsSync(path.join(CHAR_DIR, id, rel));

function thumbOf(id, m) {
  const c = ['previews/in-game-front.png', 'previews/assembled/front.png', m.generation?.body?.files?.rendered_image, m.generation?.body?.files?.rendered_image_url,(m.references || []).find((r) => r.part === 'body')?.cleaned, (m.references || [])[0]?.cleaned];
  return fileUrl(id, c.find((x) => exists(id, x)));
}
const labelOf = (s) => (typeof s === 'string' ? s : 'DRAFT');
const STATUS_TEXT = { DRAFT: 'Draft', REFERENCES_INCOMPLETE: 'References incomplete', REFERENCES_READY: 'References ready', GENERATING_SOURCE: 'Generating', SOURCE_READY: 'Assembly required', ASSEMBLING: 'Processing', ASSEMBLED: 'Processing', OPTIMIZING: 'Processing', GAME_MESH_READY: 'Rigging', RIGGING: 'Rigging', RIGGED: 'Rigged', ANIMATION_VALIDATION: 'Validation', COURT_VALIDATION: 'Validation', GAME_READY: 'Game ready', FAILED: 'Failed' };

async function summary(id) {
  const { manifest, state, jobs, stages } = await mods();
  const m = manifest.loadManifest(id);
  const job = jobs.activeJob(id) || null;
  const st = state.computeState(m, { job });
  const rep0 = m.stages.import?.reports?.[0];
  const rid = stages.rigIdOf(id);
  return {
    id, name: m.name || id, style: m.style, quality: m.quality, heightMeters: m.heightMeters, notes: m.notes || '',
    status: labelOf(st.pipeline), statusText: STATUS_TEXT[labelOf(st.pipeline)] || labelOf(st.pipeline), stage: st.next, thumbnail: thumbOf(id, m),
    triangles: rep0?.triangles ?? null, rigStatus: st.stages.rig.status, lodStatus: st.stages.lods.status, lods: Object.keys(m.lods || {}).length,
    credits: m.credits?.spent || 0, updatedAt: m.updatedAt || m.createdAt, rigId: fs.existsSync(path.join(RIGS, `${rid}.json.gz`)) ? rid : null,
    job: job && { id: job.id, op: job.op, status: job.status, stage: job.stage },
    // (UI, read-only) status of the next open stage, the stage a process is running now, and which 3D models exist
    stageStatus: st.next ? st.stages[st.next]?.status || null : null,
    runningStage: Object.keys(st.stages).find((k) => st.stages[k].status === 'running') || null,
    models: { source: Object.values(m.generation || {}).some((g) => exists(id, g.sourceHigh)), assembled: exists(id, 'assembled/high.glb'), game: exists(id, 'game/lod0.glb') },
  };
}

let _bal = null;
async function tripoStatus(force) {
  const { config, tripo } = await mods();
  const key = !!process.env.TRIPO_API_KEY;
  if (!key) return { configured: false, balance: null, error: null };
  if (!force && _bal && Date.now() - _bal.at < 60000) return _bal.v;
  let v;
  try { const b = await new tripo.TripoClient({ maxRetries: 1, timeoutMs: 15000 }).getBalance(); v = { configured: true, balance: b.balance, frozen: b.frozen, error: null }; }
  catch (e) { v = { configured: true, balance: null, error: e.message }; }
  _bal = { at: Date.now(), v }; void config;
  return v;
}

function register(router) {
  // ── factory status / dashboard ──
  router.get('/api/cf/status', async (req, res, p, q) => {
    const { config } = await mods();
    const blender = fs.existsSync(config.BLENDER) ? config.BLENDER : null;
    let clips = null;
    try { const GC = require('../lib/mocap/game-clips'); const lib = await GC.library(); clips = { count: lib.length, court: (await GC.clipsForCourt(lib)).length }; } catch (e) { clips = { count: 0, court: 0, error: e.message }; }
    json(res, {
      tripo: await tripoStatus(q.refresh === '1'),
      blender: { found: !!blender, path: blender },
      limits: { maxCreditsPerCharacter: config.LIMITS.maxCreditsPerCharacter, maxRetriesPerStage: config.LIMITS.maxRetriesPerStage, tripoConcurrency: +(process.env.TRIPO_CONCURRENCY || 3) },
      usdPerCredit: process.env.TRIPO_USD_PER_CREDIT ? +process.env.TRIPO_USD_PER_CREDIT : null,
      quality: config.QUALITY, models: { source: config.TRIPO.sourceModel, sourceParams: config.TRIPO.source, rig: config.TRIPO.rigModel, rigSpec: config.TRIPO.rigSpec },
      clips, storage: !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.R2_ACCESS_KEY_ID), pipelineVersion: config.PIPELINE_VERSION,
    });
  });

  router.get('/api/cf/summary', async (req, res) => {
    const ids = fs.existsSync(CHAR_DIR) ? fs.readdirSync(CHAR_DIR).filter((d) => !d.startsWith('_') && charExists(d)) : [];
    const list = await Promise.all(ids.map(summary));
    const { jobs, manifest } = await mods();
    const all = jobs.listJobs();
    const builds = ids.map((id) => manifest.loadManifest(id)).map((m) => Object.values(m.stages || {}).reduce((a, s) => a + (s.status === 'done' && s.seconds ? s.seconds : 0), 0)).filter((s) => s > 0);
    const credits = list.reduce((a, c) => a + c.credits, 0);
    const usd = process.env.TRIPO_USD_PER_CREDIT ? +(credits * +process.env.TRIPO_USD_PER_CREDIT).toFixed(2) : null;
    json(res, {
      characters: list.length, gameReady: list.filter((c) => c.status === 'GAME_READY').length, processing: list.filter((c) => c.job).length, failed: list.filter((c) => c.status === 'FAILED').length,
      credits, estimatedUsd: usd, jobsRunning: all.filter((j) => j.status === 'running').length, averageBuildSeconds: builds.length ? Math.round(builds.reduce((a, b) => a + b, 0) / builds.length) : null, buildsMeasured: builds.length,
    });
  });

  // ── characters ──
  router.get('/api/cf/characters', async (req, res) => {
    const ids = fs.existsSync(CHAR_DIR) ? fs.readdirSync(CHAR_DIR).filter((d) => !d.startsWith('_') && charExists(d)) : [];
    const list = await Promise.all(ids.map(summary));
    list.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    json(res, { characters: list });
  });

  router.post('/api/cf/characters', async (req, res) => {
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return fail(res, 400, 'a name is required');
    let id = String(b.id || '').trim().toLowerCase();
    if (!id) { const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'character'; let n = 1; do { id = `${base}_${String(n).padStart(3, '0')}`; n++; } while (charExists(id)); }
    if (!ID_RE.test(id)) return fail(res, 400, 'id: 2–40 of a–z, 0–9, _ or -');
    if (charExists(id)) return fail(res, 409, `${id} already exists`);
    const { manifest, config } = await mods();
    const m = manifest.loadManifest(id);
    Object.assign(m, { name, style: b.style || 'soul-jam-illustrated', notes: String(b.notes || '').slice(0, 2000), heightMeters: b.heightMeters ? Math.max(1.2, Math.min(2.4, +b.heightMeters)) : null, quality: config.QUALITY[b.quality] ? b.quality : 'hero', createdAt: new Date().toISOString() });
    manifest.saveManifest(m);
    json(res, await summary(id), 201);
  });

  router.get('/api/cf/characters/:id', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { manifest, state, jobs, stages, config } = await mods();
    const m = manifest.loadManifest(p.id);
    const job = jobs.activeJob(p.id) || null;
    const st = state.computeState(m, { job });
    const refs = (m.references || []).map((r) => ({ ...r, cleanedUrl: fileUrl(p.id, r.cleaned), originalUrl: fileUrl(p.id, r.original) }));
    const gen = Object.fromEntries(Object.entries(m.generation || {}).map(([k, g]) => [k, { ...g, output: undefined, task: g.task && { ...g.task, output: undefined }, sourceUrl: fileUrl(p.id, g.sourceHigh && exists(p.id, g.sourceHigh) ? g.sourceHigh : null), renderUrl: fileUrl(p.id, [g.files?.rendered_image, g.files?.rendered_image_url].find((f) => exists(p.id, f)) || null), sourceBytes: g.sourceHigh && exists(p.id, g.sourceHigh) ? fs.statSync(path.join(CHAR_DIR, p.id, g.sourceHigh)).size : null }]));
    const previews = {};
    const pv = path.join(CHAR_DIR, p.id, 'previews');
    if (fs.existsSync(pv)) (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(png|jpg|webp)$/i.test(e.name)) { const r = path.relative(path.join(CHAR_DIR, p.id), f); previews[r] = fileUrl(p.id, r); } } })(pv);
    const files = { assembledGlb: 'assembled/high.glb', gameGlb: 'game/lod0.glb', rigGlb: 'rigs/tripo_rig.glb' };
    const lodFiles = Object.fromEntries(Object.entries(m.lods || {}).map(([k, l]) => [k, { ...l, url: fileUrl(p.id, exists(p.id, l.file) ? l.file : null), bytes: exists(p.id, l.file) ? fs.statSync(path.join(CHAR_DIR, p.id, l.file)).size : null }]));
    const textures = fs.existsSync(path.join(CHAR_DIR, p.id, 'textures')) ? fs.readdirSync(path.join(CHAR_DIR, p.id, 'textures')).filter((f) => f.endsWith('.png')).map((f) => ({ name: f, url: fileUrl(p.id, `textures/${f}`), bytes: fs.statSync(path.join(CHAR_DIR, p.id, 'textures', f)).size })) : [];
    json(res, {
      summary: await summary(p.id), manifest: { ...m, references: undefined, generation: undefined }, references: refs, generation: gen, state: st,
      files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, exists(p.id, f) ? { url: fileUrl(p.id, f), bytes: fs.statSync(path.join(CHAR_DIR, p.id, f)).size } : null])),
      lods: lodFiles, textures, previews, rigId: stages.rigIdOf(p.id), quality: config.QUALITY[m.quality] || config.QUALITY.hero,
      courtUrl: fs.existsSync(path.join(RIGS, `${stages.rigIdOf(p.id)}.json.gz`)) ? `/court3d?char=${stages.rigIdOf(p.id)}` : null,
    });
  });

  router.patch('/api/cf/characters/:id', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { manifest, config } = await mods();
    if ((await mods()).jobs.activeJob(p.id)) return fail(res, 409, 'a job is running for this character');
    const b = await readJson(req), m = manifest.loadManifest(p.id);
    if (b.name != null) m.name = String(b.name).trim().slice(0, 60) || m.name;
    if (b.notes != null) m.notes = String(b.notes).slice(0, 2000);
    if (b.heightMeters !== undefined) m.heightMeters = b.heightMeters ? Math.max(1.2, Math.min(2.4, +b.heightMeters)) : null;
    if (b.quality && config.QUALITY[b.quality]) m.quality = b.quality;
    if (b.material && typeof b.material === 'object') m.material = b.material;
    manifest.saveManifest(m);
    json(res, await summary(p.id));
  });

  router.delete('/api/cf/characters/:id', async (req, res, p, q) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    if (q.confirm !== p.id) return fail(res, 400, `confirm by passing ?confirm=${p.id}`);
    const { jobs, stages } = await mods();
    if (jobs.activeJob(p.id)) return fail(res, 409, 'a job is running for this character');
    const rid = stages.rigIdOf(p.id);
    fs.rmSync(path.join(CHAR_DIR, p.id), { recursive: true, force: true });
    fs.rmSync(path.join(RIGS, `${rid}.json.gz`), { force: true });
    fs.rmSync(path.join(RIGS, `${rid}-tex`), { recursive: true, force: true });
    const reg = path.join(RIGS, 'custom.json');
    if (fs.existsSync(reg)) { const r = JSON.parse(fs.readFileSync(reg, 'utf8')); delete r[rid]; fs.writeFileSync(reg, JSON.stringify(r, null, 1)); }
    json(res, { deleted: p.id });
  });

  router.post('/api/cf/characters/:id/duplicate', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { manifest } = await mods();
    const src = manifest.loadManifest(p.id);
    let id, n = 2; const base = p.id.replace(/_\d{3}$/, ''); do { id = `${base}_${String(n).padStart(3, '0')}`; n++; } while (charExists(id));
    const m = manifest.loadManifest(id);
    Object.assign(m, { name: `${src.name || p.id} (copy)`, style: src.style, notes: src.notes, heightMeters: src.heightMeters, quality: src.quality, createdAt: new Date().toISOString() });
    const from = path.join(CHAR_DIR, p.id, 'references', '_original'), to = path.join(CHAR_DIR, id, 'references', '_original');
    if (fs.existsSync(from)) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f)); }
    const ov = path.join(CHAR_DIR, p.id, 'references', 'overrides.json');
    if (fs.existsSync(ov)) fs.copyFileSync(ov, path.join(CHAR_DIR, id, 'references', 'overrides.json'));
    manifest.saveManifest(m);
    if (fs.existsSync(to)) await reingest(id);
    json(res, await summary(id), 201);
  });

  // ── references ──
  async function reingest(id) {
    const { manifest, stages } = await mods();
    const m = manifest.loadManifest(id);
    m.stages.ingest = { ...(m.stages.ingest || {}), key: null };
    const dir = path.join(CHAR_DIR, id, 'references', '_original');
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => /\.(png|jpe?g|webp)$/i.test(f))) { m.references = []; m.stages.ingest = { status: 'ready' }; manifest.saveManifest(m); return m; }
    await stages.ingest(m, {});
    m.stages.ingest = { ...m.stages.ingest, status: 'done', finishedAt: new Date().toISOString() };
    try { stages.validate(m); } catch { /* blocking issues are recorded on the manifest */ }
    manifest.saveManifest(m);
    return m;
  }

  router.post('/api/cf/characters/:id/references', async (req, res, p, q) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { jobs } = await mods();
    if (jobs.activeJob(p.id)) return fail(res, 409, 'a job is running for this character');
    const name = path.basename(String(q.name || '')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 80);
    if (!/\.(png|jpe?g|webp)$/i.test(name)) return fail(res, 400, 'images only: .png, .jpg, .webp');
    let buf;
    try { buf = await readRaw(req, 20 << 20); } catch (e) { return fail(res, e.status || 400, e.message); }
    if (!IMG_MAGIC.some((sig) => sig.every((b, i) => buf[i] === b))) return fail(res, 400, 'not a PNG / JPEG / WebP file');
    const dir = path.join(CHAR_DIR, p.id, 'references', '_original'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    if (q.part || q.view) setOverride(p.id, name, { part: PARTS.concat(['hands']).includes(q.part) ? q.part : undefined, view: VIEWS.includes(q.view) ? q.view : undefined });
    const m = await reingest(p.id);
    json(res, { uploaded: name, references: (m.references || []).filter((r) => r.name === name).map((r) => ({ ...r, cleanedUrl: fileUrl(p.id, r.cleaned) })), validation: m.validation }, 201);
  });

  function setOverride(id, name, o) {
    const f = path.join(CHAR_DIR, id, 'references', '_original', 'overrides.json');
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    cur[name] = { ...(cur[name] || {}), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
    fs.writeFileSync(f, JSON.stringify(cur, null, 1));
  }

  router.patch('/api/cf/characters/:id/references/:name', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const name = path.basename(decodeURIComponent(p.name));
    if (!fs.existsSync(path.join(CHAR_DIR, p.id, 'references', '_original', name))) return fail(res, 404, 'no such reference');
    const b = await readJson(req);
    if (b.part && !PARTS.concat(['hands']).includes(b.part)) return fail(res, 400, 'part: ' + PARTS.join(', '));
    if (b.view && !VIEWS.includes(b.view)) return fail(res, 400, 'view: ' + VIEWS.join(', '));
    const view = { 'back-of-hand': 'back' }[b.view] || b.view;
    setOverride(p.id, name, { part: b.part, view, side: b.side });
    const m = await reingest(p.id);
    json(res, { references: m.references.filter((r) => r.name === name), validation: m.validation });
  });

  router.delete('/api/cf/characters/:id/references/:name', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const name = path.basename(decodeURIComponent(p.name));
    const f = path.join(CHAR_DIR, p.id, 'references', '_original', name);
    if (!fs.existsSync(f)) return fail(res, 404, 'no such reference');
    fs.rmSync(f);
    const m = await reingest(p.id);
    json(res, { deleted: name, references: m.references.length });
  });

  // ── jobs ──
  router.post('/api/cf/characters/:id/jobs', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { jobs } = await mods();
    const b = await readJson(req);
    if (['build', 'resume', 'generate', 'rig'].includes(b.op) && !process.env.TRIPO_API_KEY) return fail(res, 412, 'Tripo API key required', { action: 'Add TRIPO_API_KEY to .env and restart the server' });
    try { json(res, jobs.startJob({ character: p.id, op: String(b.op || ''), part: b.part ? String(b.part) : undefined }), 202); }
    catch (e) { fail(res, e.status || 400, e.message); }
  });
  router.get('/api/cf/jobs', async (req, res, p, q) => {
    const { jobs } = await mods();
    json(res, { jobs: jobs.listJobs({ character: q.character && ID_RE.test(q.character) ? q.character : undefined }).slice(0, +(q.limit || 200)) });
  });
  router.get('/api/cf/jobs/:job', async (req, res, p) => {
    const { jobs } = await mods();
    const j = jobs.readJob(p.job); if (!j) return fail(res, 404, 'no such job');
    json(res, { ...j, logTail: jobs.logTail(j, 120) });
  });
  router.post('/api/cf/jobs/:job/cancel', async (req, res, p) => {
    const { jobs } = await mods();
    const j = jobs.readJob(p.job); if (!j) return fail(res, 404, 'no such job');
    if (!['running', 'queued'].includes(j.status)) return fail(res, 409, `job is ${j.status}`);
    json(res, jobs.cancelJob(p.job));
  });

  // ── files (path-checked) and versions ──
  router.get('/api/cf/characters/:id/file', async (req, res, p, q) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const base = path.join(CHAR_DIR, p.id);
    const f = path.resolve(base, String(q.path || ''));
    if (!f.startsWith(base + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return fail(res, 404, 'no such file');
    const ext = path.extname(f).toLowerCase();
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.json': 'application/json', '.log': 'text/plain; charset=utf-8' }[ext];
    if (!type) return fail(res, 403, 'file type not served');
    const st = fs.statSync(f);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=60', 'Last-Modified': st.mtime.toUTCString() });
    fs.createReadStream(f).pipe(res);
  });
  router.get('/api/cf/characters/:id/versions', async (req, res, p) => {
    if (!charExists(p.id)) return fail(res, 404, 'no such character');
    const { manifest } = await mods();
    json(res, { versions: manifest.loadManifest(p.id).versions || [] });
  });
}

module.exports = { register };
