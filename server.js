#!/usr/bin/env node
/**
 * Sprite Factory — Production Studio Server
 *
 * Thin router importing route modules. All business logic lives in routes/.
 *
 * Provides a web UI for the entire sprite generation pipeline:
 * - Upload video → extract frames → smart select → build strip
 * - Generate sprites via Nano Banana Pro API
 * - Process, preview, and export to Soul Jam
 * - Train prompt quality with feedback loops
 * - Character intake with physical attributes
 * - Pipeline orchestration for full roster generation
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load .env if present (no-op on Railway, where vars come from the platform).
// Kept inline so local dev works without adding a `dotenv` dependency.
(() => {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never override platform-injected vars
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3456;
const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, 'data/assets');
const RAW_DIR = process.env.RAW_DIR || path.resolve(__dirname, 'data/raw-sprites');
const TMP_DIR = process.env.TMP_DIR || path.resolve(__dirname, 'data/.video-tmp');

// ─── Simple Router ──────────────────────────────────────────────────────

class Router {
  constructor() {
    this.routes = [];
  }

  _add(method, pattern, handler) {
    // Convert :param patterns to regex
    const paramNames = [];
    const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, regex, paramNames, handler, pattern });
  }

  get(pattern, handler) { this._add('GET', pattern, handler); }
  post(pattern, handler) { this._add('POST', pattern, handler); }
  put(pattern, handler) { this._add('PUT', pattern, handler); }
  patch(pattern, handler) { this._add('PATCH', pattern, handler); }
  delete(pattern, handler) { this._add('DELETE', pattern, handler); }

  async handle(req, res, pathname) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const query = Object.fromEntries(url.searchParams.entries());

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.regex);
      if (match) {
        const params = {};
        route.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return route.handler(req, res, params, query);
      }
    }

    return json(res, { error: 'Not found' }, 404);
  }
}

// ─── Shared Helpers ─────────────────────────────────────────────────────

function serveStatic(res, filePath, contentType) {
  try {
    const stat = fs.statSync(filePath);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    const isHtml = contentType === 'text/html';

    // Conditional GET — repeat visits get a tiny 304 instead of re-downloading
    // the (large) body when nothing changed
    if (res.req?.headers?.['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      // HTML always revalidates (ETag turns that into a 304); scripts/assets
      // are used from cache instantly and refreshed in the background
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300, stale-while-revalidate=86400',
      'ETag': etag,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveImage(res, imagePath) {
  try {
    const stat = fs.statSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

    // Conditional GET — gallery re-renders revalidate instead of re-downloading
    if (res.req?.headers?.['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=3600',
      'ETag': etag,
    });
    fs.createReadStream(imagePath).pipe(res);
  } catch {
    json(res, { error: 'Image not found' }, 404);
  }
}

// Downscaled asset thumbnails, generated once per (file mtime, width) and
// cached on disk — keeps roster/studio grids light without touching originals
const THUMB_CACHE_DIR = path.join(__dirname, '.thumb-cache');
async function serveAssetThumb(res, imagePath, w) {
  try {
    const stat = fs.statSync(imagePath);
    const key = `${path.basename(imagePath).replace(/[^a-zA-Z0-9._-]/g, '_')}-${stat.mtimeMs.toString(36)}-w${w}.png`;
    const thumbPath = path.join(THUMB_CACHE_DIR, key);
    if (!fs.existsSync(thumbPath)) {
      fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
      const sharp = require('sharp');
      await sharp(imagePath).resize({ width: w, withoutEnlargement: true }).png().toFile(thumbPath);
    }
    return serveImage(res, thumbPath);
  } catch {
    return serveImage(res, imagePath); // resize failed — fall back to original
  }
}

async function runWithConcurrency(tasks, concurrency = 2, delayMs = 2000) {  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      if (i > 0) await new Promise(r => setTimeout(r, delayMs));
      results[i] = await tasks[i]();
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Register Routes ────────────────────────────────────────────────────

const router = new Router();
const ctx = { ASSETS_DIR, RAW_DIR, TMP_DIR, PORT, json, parseBody, serveImage, serveStatic, runWithConcurrency };

// Import and register all route modules
require('./routes/characters').register(router, ctx);
require('./routes/generation').register(router, ctx);
require('./routes/evaluation').register(router, ctx);
require('./routes/video').register(router, ctx);
require('./routes/export').register(router, ctx);
require('./routes/pipeline').register(router, ctx);
require('./routes/production').register(router, ctx);
require('./routes/anchor').register(router, ctx);
require('./routes/animation-contract').register(router, ctx);
require('./routes/char-pipeline').register(router, ctx);
require('./routes/wardrobe').register(router);
require('./routes/anim-lib').register(router, ctx);
require('./routes/studio-gen').register(router, ctx);
require('./routes/apply-anim').register(router, ctx);
require('./routes/quality-check').register(router);
require('./routes/quiz').register(router, ctx);
require('./routes/movement-profiles').register(router);
require('./routes/pose-import').register(router, ctx);

// ─── Storage Status Endpoint ─────────────────────────────────────────────
router.get('/api/storage-status', async (req, res) => {
  const vars = {
    R2_ENDPOINT: !!process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: !!process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: !!process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: !!process.env.R2_BUCKET,
  };
  const r2Available = vars.R2_ENDPOINT && vars.R2_ACCESS_KEY_ID && vars.R2_SECRET_ACCESS_KEY;
  const backend = r2Available ? 'r2' : 'none';
  let connected = false;
  if (r2Available) {
    try {
      const { listFiles } = require('./lib/r2-storage');
      await listFiles('_meta');
      connected = true;
    } catch (e) { vars._connectError = e.message; }
  }
  return json(res, { backend, r2Available, connected, vars });
});

// ─── Testing Config Endpoint ─────────────────────────────────────────────
const TESTING_CONFIG_FILE = path.join(__dirname, 'data/.testing-config.json');

// Health/status — lets the client confirm cloud persistence is working
router.get('/api/testing-config/status', async (req, res) => {
  const { isAvailable, downloadFile } = require('./lib/r2-storage');
  const r2Ok = isAvailable();
  let hasCloud = false;
  if (r2Ok) {
    try { hasCloud = !!(await downloadFile('_meta/testing-config.json')); } catch {}
  }
  json(res, {
    r2: r2Ok,
    hasCloud,
    hasLocal: fs.existsSync(TESTING_CONFIG_FILE),
  });
});

router.get('/api/testing-config', async (req, res) => {
  try {
    const { downloadFile, isAvailable } = require('./lib/r2-storage');
    // Always prefer the live R2 copy so zone edits from any session are reflected
    if (isAvailable()) {
      const buf = await downloadFile('_meta/testing-config.json');
      if (buf) {
        const data = JSON.parse(buf.toString('utf8'));
        // Keep local file in sync for fast cold-start reads
        fs.mkdirSync(path.dirname(TESTING_CONFIG_FILE), { recursive: true });
        fs.writeFileSync(TESTING_CONFIG_FILE, JSON.stringify(data, null, 2));
        return json(res, data);
      }
    }
    // R2 unavailable — fall back to local disk
    if (fs.existsSync(TESTING_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(TESTING_CONFIG_FILE, 'utf8'));
      return json(res, data);
    }
    return json(res, {});
  } catch (e) {
    // Last-resort: try local disk
    try {
      if (fs.existsSync(TESTING_CONFIG_FILE)) {
        return json(res, JSON.parse(fs.readFileSync(TESTING_CONFIG_FILE, 'utf8')));
      }
    } catch {}
    json(res, { error: e.message }, 500);
  }
});

router.post('/api/testing-config', async (req, res) => {
  try {
    const body = await parseBody(req);
    fs.mkdirSync(path.dirname(TESTING_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(TESTING_CONFIG_FILE, JSON.stringify(body, null, 2));
    const { uploadJson, isAvailable } = require('./lib/r2-storage');
    let savedToCloud = false;
    if (isAvailable()) {
      await uploadJson('_meta/testing-config.json', body);
      savedToCloud = true;
    }
    return json(res, { success: true, savedToCloud });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ─── Testing Image Endpoints (court + hoop) ──────────────────────────────
// Saves uploaded images to data/assets/ + R2 so any device can load them.
// Client reads back via /assets/court-uploaded.png and /assets/hoop-processed.png
// which already have R2 fallback built into the /assets/ handler.

const COURT_IMG_PATH = path.join(ASSETS_DIR, 'court-uploaded.png');
const HOOP_IMG_PATH  = path.join(ASSETS_DIR, 'hoop-processed.png');

router.post('/api/testing-images/court', async (req, res) => {
  try {
    const body = await parseBody(req);
    if (!body.dataUrl) return json(res, { error: 'dataUrl required' }, 400);
    const b64 = body.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(COURT_IMG_PATH, buf);
    const { uploadFile, isAvailable } = require('./lib/r2-storage');
    if (isAvailable()) {
      await uploadFile('court-uploaded.png', COURT_IMG_PATH).catch(e => console.warn('[testing-images] court upload failed:', e.message));
    }
    return json(res, { success: true, url: '/assets/court-uploaded.png' });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

router.post('/api/testing-images/hoop', async (req, res) => {
  try {
    const body = await parseBody(req);
    if (!body.dataUrl) return json(res, { error: 'dataUrl required' }, 400);
    const b64 = body.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(HOOP_IMG_PATH, buf);
    const { uploadFile, isAvailable } = require('./lib/r2-storage');
    if (isAvailable()) {
      await uploadFile('hoop-processed.png', HOOP_IMG_PATH).catch(e => console.warn('[testing-images] hoop upload failed:', e.message));
    }
    return json(res, { success: true, url: '/assets/hoop-processed.png' });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

router.get('/api/testing-images/status', (req, res) => {
  json(res, {
    hasCourt: fs.existsSync(COURT_IMG_PATH),
    hasHoop:  fs.existsSync(HOOP_IMG_PATH),
    courtUrl: fs.existsSync(COURT_IMG_PATH) ? '/assets/court-uploaded.png' : null,
    hoopUrl:  fs.existsSync(HOOP_IMG_PATH)  ? '/assets/hoop-processed.png'  : null,
  });
});

// POST /api/debug/r2-write-test — round-trip write+read to confirm R2 uploads work
router.post('/api/debug/r2-write-test', async (req, res) => {
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return json(res, { ok: false, error: 'R2 env vars missing' });
  }
  const bucket = R2_BUCKET || 'sprite-factory';
  const key = '_meta/write-test.json';
  const ts = Date.now();
  const client = new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  // Test write
  let writeError = null;
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key,
      Body: Buffer.from(JSON.stringify({ ok: true, ts })),
      ContentType: 'application/json',
    }));
  } catch (e) {
    writeError = e.message;
  }
  if (writeError) return json(res, { ok: false, stage: 'write', error: writeError, bucket, endpoint: R2_ENDPOINT.slice(0, 50) });

  // Test read
  let readError = null, readTs = null;
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of r.Body) chunks.push(chunk);
    readTs = JSON.parse(Buffer.concat(chunks).toString('utf8')).ts;
  } catch (e) {
    readError = e.message;
  }
  if (readError) return json(res, { ok: false, stage: 'read', error: readError });
  return json(res, { ok: true, match: ts === readTs, bucket, endpoint: R2_ENDPOINT.slice(0, 50) });
});

// ─── Database Health / Debug Endpoint ───────────────────────────────────────
// Drives the red "DATA PERSISTENCE BROKEN" banner in index-v2.html.
// Returns ok:true when R2 is reachable; ok:false → banner shows.
// /api/debug/db drives the persistence banner on every page load but costs
// 4 R2 round-trips (~2s) — cache the verdict for 60s
let _dbHealthCache = { t: 0, result: null };

router.get('/api/debug/db', async (req, res) => {
  const { verifyConnection, isAvailable, downloadFile } = require('./lib/r2-storage');

  if (_dbHealthCache.result && Date.now() - _dbHealthCache.t < 60000) {
    return json(res, _dbHealthCache.result);
  }

  const bucket = process.env.R2_BUCKET || 'sprite-factory';
  const endpointPreview = process.env.R2_ENDPOINT
    ? `${process.env.R2_ENDPOINT.slice(0, 48)}…  bucket=${bucket}`
    : 'NOT SET';
  const keyPreview = process.env.R2_ACCESS_KEY_ID
    ? `${process.env.R2_ACCESS_KEY_ID.slice(0, 6)}…`
    : 'NOT SET';

  if (!isAvailable()) {
    return json(res, {
      ok: false,
      configured: false,
      backend: 'none',
      endpointPreview, keyPreview,
      // Legacy fields kept so older clients don't break:
      urlPreview: endpointPreview, urlSet: false, keySet: false,
      error: 'R2 not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (and optionally R2_BUCKET) in Railway → Variables.',
      fix: 'Railway dashboard → your service → Variables → add R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. Create the bucket + an Object Read/Write API token in Cloudflare → R2 first. Redeploy.',
    });
  }

  try {
    const health = await verifyConnection();
    const result = {
      ok: health.ok, configured: true,
      backend: 'r2',
      endpointPreview, keyPreview,
      // Legacy aliases:
      urlPreview: endpointPreview,
      keyCount: health.keyCount, metaKeys: health.metaKeys, error: health.error,
      hint: health.ok ? null
        : `R2 connection failed — check: 1) R2_ENDPOINT is "https://<account>.r2.cloudflarestorage.com" (no trailing slash, no bucket in path), 2) bucket "${bucket}" exists in this account, 3) the API token has Object Read+Write on it.`,
    };

    // Peek at character count
    try {
      const charBuf = await downloadFile('_meta/characters-full.json');
      if (charBuf) {
        const chars = JSON.parse(charBuf.toString('utf8'));
        result.characters = Object.keys(chars).filter(k => k !== '_deleted').length;
        result.deletedChars = (chars._deleted || []).length;
      } else {
        result.characters = 0;
        result.charactersMissing = true;
      }
    } catch { result.characters = 'parse-error'; }

    // Peek at anim-lib count
    try {
      const animBuf = await downloadFile('_meta/anim-lib-index.json');
      if (animBuf) {
        const anims = JSON.parse(animBuf.toString('utf8'));
        result.animations = Object.keys(anims).length;
      } else {
        result.animations = 0;
        result.animsMissing = true;
      }
    } catch { result.animations = 'parse-error'; }

    // Peek at wardrobe count
    try {
      const wardBuf = await downloadFile('_meta/wardrobe.json');
      if (wardBuf) {
        const ward = JSON.parse(wardBuf.toString('utf8'));
        result.wardrobe = ward.length;
      } else {
        result.wardrobe = 0;
        result.wardrobeMissing = true;
      }
    } catch { result.wardrobe = 'parse-error'; }

    _dbHealthCache = { t: Date.now(), result };
    json(res, result);
  } catch (e) {
    json(res, { ok: false, configured: true, error: e.message });
  }
});

// ─── Full storage migration / backup endpoint ─────────────────────────────
router.post('/api/migrate-to-storage', async (req, res) => {
  const { isAvailable, uploadFile: storeFile, uploadJson: storeJson } = require('./lib/r2-storage');
  if (!isAvailable()) return json(res, { ok: false, error: 'No storage backend configured' });

  const results = {};
  let assetCount = 0;

  // ── Metadata JSON files ──
  const metaUploads = [
    { file: 'data/.characters.json',          key: '_meta/characters-full.json',   label: 'characters' },
    { file: 'data/anim-lib/index.json',        key: '_meta/anim-lib-index.json',    label: 'animations' },
    { file: 'data/wardrobe.json',              key: '_meta/wardrobe.json',          label: 'wardrobe' },
    { file: 'data/.testing-config.json',       key: '_meta/testing-config.json',    label: 'testingConfig' },
    { file: 'data/court-presets.json',         key: '_meta/court-presets.json',     label: 'courtPresets' },
    { file: 'data/.custom-animations.json',    key: '_meta/custom-animations.json', label: 'customAnimations' },
    { file: 'data/.clothing-registry.json',    key: '_meta/clothing-registry.json', label: 'clothingRegistry' },
    { file: 'data/.char-prompts.json',         key: '_meta/char-prompts.json',      label: 'charPrompts' },
    { file: 'data/frame-prompts.json',         key: '_meta/frame-prompts.json',     label: 'framePrompts' },
    { file: 'data/.cost-tracking.json',        key: '_meta/cost-tracking.json',     label: 'costTracking' },
  ];

  for (const { file, key, label } of metaUploads) {
    try {
      const fullPath = path.join(__dirname, file);
      if (!fs.existsSync(fullPath)) { results[label] = 'skipped (not found)'; continue; }
      const obj = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      await storeJson(key, obj);
      const count = Array.isArray(obj) ? obj.length : Object.keys(obj).filter(k => k !== '_deleted').length;
      results[label] = `saved (${count})`;
    } catch (e) { results[label] = `FAILED: ${e.message}`; }
  }

  // ── apply-anim metadata ──
  try {
    const applyDir = path.join(__dirname, 'data/apply-anim');
    if (fs.existsSync(applyDir)) {
      const files = fs.readdirSync(applyDir).filter(f => f.endsWith('.json'));
      await Promise.all(files.map(async f => {
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(applyDir, f), 'utf8'));
          await storeJson(`_meta/apply-anim/${f}`, obj);
        } catch {}
      }));
      results.applyAnim = `saved (${files.length})`;
    }
  } catch (e) { results.applyAnim = `FAILED: ${e.message}`; }

  // ── Binary assets (PNGs, webp) ──
  try {
    const assetsDir = path.join(__dirname, 'data/assets');
    if (fs.existsSync(assetsDir)) {
      const walkDir = (dir, base) => {
        const entries = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) entries.push(...walkDir(path.join(dir, entry.name), rel));
          else entries.push({ abs: path.join(dir, entry.name), rel });
        }
        return entries;
      };
      const allAssets = walkDir(assetsDir, '');
      await Promise.all(allAssets.map(async ({ abs, rel }) => {
        try { await storeFile(rel, abs); assetCount++; } catch {}
      }));
    }
    results.assets = `uploaded (${assetCount})`;
  } catch (e) { results.assets = `FAILED: ${e.message}`; }

  json(res, { ok: true, backend: process.env.R2_ENDPOINT ? 'r2' : 'none', results });
});

// ─── Court Presets Endpoints ─────────────────────────────────────────────
const COURT_PRESETS_FILE = path.join(__dirname, 'data/court-presets.json');

function readCourtPresets() {
  try {
    if (fs.existsSync(COURT_PRESETS_FILE)) return JSON.parse(fs.readFileSync(COURT_PRESETS_FILE, 'utf8'));
  } catch {}
  return {};
}

router.get('/api/court-presets', (req, res) => {
  const stored = readCourtPresets();
  const presets = Object.values(stored);
  if (!presets.find(p => p.id === 'default')) {
    presets.unshift({ id: 'default', name: 'Main Court', courtImage: '/assets/court.webp', foregroundImage: null });
  }
  json(res, { presets });
});

router.get('/api/court-presets/:id', (req, res, params) => {
  const stored = readCourtPresets();
  const preset = stored[params.id];
  if (preset) return json(res, preset);
  json(res, { error: 'Not found' }, 404);
});

router.put('/api/court-presets/:id', async (req, res, params) => {
  try {
    const body = await parseBody(req);
    const stored = readCourtPresets();
    stored[params.id] = { ...body, id: params.id };
    fs.mkdirSync(path.dirname(COURT_PRESETS_FILE), { recursive: true });
    fs.writeFileSync(COURT_PRESETS_FILE, JSON.stringify(stored, null, 2));
    const { uploadJson, isAvailable } = require('./lib/r2-storage');
    if (isAvailable()) {
      await uploadJson('_meta/court-presets.json', stored).catch(e => console.warn('[court-presets] storage backup failed:', e.message));
    }
    json(res, { success: true });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ─── Sync Status Endpoint ────────────────────────────────────────────────
router.get('/api/sync-status', (req, res) => {
  try {
    const { getSyncStatus } = require('./lib/auto-git-sync');
    json(res, getSyncStatus());
  } catch (e) {
    json(res, { status: 'error', error: e.message });
  }
});

// ─── Deploy Endpoint ─────────────────────────────────────────────────────
const { execSync } = require('child_process');
router.post('/api/deploy', async (req, res) => {
  try {
    const body = await parseBody(req).catch(() => ({}));
    const msg = body.message || 'chore: save data and deploy from studio';
    const output = execSync(
      `git add -A && git diff --cached --quiet || git commit -m "${msg.replace(/"/g, "\\\"")}" && git push origin main`,
      { cwd: __dirname, timeout: 30000 }
    ).toString();
    return json(res, { success: true, output });
  } catch (err) {
    const output = err.stdout?.toString() || err.message;
    return json(res, { success: false, output, error: err.message });
  }
});

// ─── Request Handler ────────────────────────────────────────────────────

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    try {
      return await router.handle(req, res, pathname);
    } catch (err) {
      console.error('[server] Unhandled route error:', err);
      if (!res.headersSent) json(res, { error: err.message || 'Internal server error' }, 500);
      return;
    }
  }

  // Serve engine JS modules (/engine/*.js) — ETag/304 + background revalidation
  if (pathname.startsWith('/engine/')) {
    const file = pathname.replace('/engine/', '');
    const enginePath = path.join(__dirname, 'engine', file);
    if (fs.existsSync(enginePath) && enginePath.endsWith('.js')) {
      return serveStatic(res, enginePath, 'application/javascript');
    }
    res.writeHead(404); return res.end('Not found');
  }

  // Serve sprite assets — disk first, R2 fallback
  if (pathname.startsWith('/assets/')) {
    const file = decodeURIComponent(pathname.replace('/assets/', ''));
    const localPath = path.join(ASSETS_DIR, file);
    // ?w=256 → downscaled, disk-cached thumbnail. Roster grids render dozens
    // of multi-MB portraits into ~180px cells — full files killed page loads.
    const thumbW = Math.min(1024, parseInt(url.searchParams.get('w')) || 0);
    if (fs.existsSync(localPath)) {
      if (thumbW > 0) return serveAssetThumb(res, localPath, thumbW);
      return serveImage(res, localPath);
    }
    // Not on disk — try R2 and cache locally
    const { downloadFile, isAvailable } = require('./lib/r2-storage');
    if (isAvailable()) {
      const buf = await downloadFile(file);
      if (buf) {
        try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, buf); } catch {}
        if (thumbW > 0 && fs.existsSync(localPath)) return serveAssetThumb(res, localPath, thumbW);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Content-Length': buf.length });
        return res.end(buf);
      }
    }
    res.writeHead(404); return res.end('Not found');
  }

  // Serve raw sprites
  if (pathname.startsWith('/raw/')) {
    const file = pathname.replace('/raw/', '');
    return serveImage(res, path.join(RAW_DIR, file));
  }

  // Serve FBF working directory files
  if (pathname.startsWith('/fbf-working/')) {
    const file = pathname.replace('/fbf-working/', '');
    return serveImage(res, path.join(RAW_DIR, file));
  }

  // Serve the web UI
  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'index-v2.html'), 'text/html');
  }
  if (pathname === '/v2' || pathname === '/v2/') {
    return serveStatic(res, path.join(__dirname, 'index-v2.html'), 'text/html');
  }
  if (pathname === '/skeleton-viewer' || pathname === '/skeleton-viewer.html') {
    return serveStatic(res, path.join(__dirname, 'skeleton-viewer.html'), 'text/html');
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─── Server ─────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {

    // Bind PORT immediately so Railway's health check passes within the startup window.
    // All restore/seed work runs in the background after the server is already listening.
    const server = http.createServer(handler);
    server.listen(PORT, () => {
      const { CHARACTERS } = require('./lib/sprite-generator/prompts');
      console.log(`\n  Sprite Production Studio running at http://localhost:${PORT}\n`);
      console.log(`  Characters: ${Object.keys(CHARACTERS).join(', ')}`);
      console.log(`  Animations: 8`);
      console.log(`  API Key: ${process.env.GEMINI_API_KEY ? 'set' : 'NOT SET — export GEMINI_API_KEY'}`);
      const r2On = !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
      const storageLine = r2On
        ? `R2 (bucket=${process.env.R2_BUCKET || 'sprite-factory'})`
        : 'NOT SET — data will not persist';
      console.log(`  Storage: ${storageLine}\n`);
    });

    // ── Background restore — runs after PORT is bound ──────────────────────
    setImmediate(async () => {

    // ── R2 connectivity check — must pass before restoring any data
    const { verifyConnection: sbVerify, isAvailable: sbIsAvailable } = require('./lib/r2-storage');
    const storageBackend = 'R2';
    if (!sbIsAvailable()) {
      console.error('\n  ╔══════════════════════════════════════════════════════════════╗');
      console.error('  ║  CRITICAL: R2 not configured (R2_ENDPOINT et al not set)      ║');
      console.error('  ║  All data (characters, anims, wardrobe) will be LOST on       ║');
      console.error('  ║  every Railway redeploy. Set env vars in Railway dashboard.   ║');
      console.error('  ╚══════════════════════════════════════════════════════════════╝\n');
    } else {
      const sbHealth = await sbVerify();
      if (!sbHealth.ok) {
        console.error(`  [startup] ✗ ${storageBackend} connection FAILED: ${sbHealth.error}`);
        console.error('  [startup] Data will not persist across redeploys until this is fixed.');
      } else {
        console.log(`  [startup] ✓ ${storageBackend} connected — ${sbHealth.keyCount} asset(s) in bucket`);
      }
    }

    // ── STEP 1: Sync deletions from storage FIRST — before any asset restore
    // This ensures we know exactly which characters are deleted before downloading anything.
    // Returns a Set of deleted character names so later steps can skip their files.
    let deletedCharSet = new Set();
    try {
      const { syncDeletedFromStorage } = require('./routes/characters');
      deletedCharSet = await syncDeletedFromStorage();
      if (deletedCharSet.size > 0) {
        console.log(`  [startup] tombstoned ${deletedCharSet.size} deleted character(s): ${[...deletedCharSet].join(', ')}`);
      }
    } catch (e) {
      console.warn('  [startup] character deletion sync failed (non-fatal):', e.message);
    }

    // ── STEP 2: Restore assets from R2 FIRST — full resolution files take priority
    // Base64 thumbnails in .characters.json are only used as a last-resort fallback
    // if R2 is unreachable. Doing this before base64 restore means R2 files win
    // and portrait/angle quality is preserved at full resolution.
    try {
      const { restoreAssetsToDir, downloadFile: dlFile, isAvailable: sbReady } = require('./lib/r2-storage');
      await restoreAssetsToDir(path.join(__dirname, 'data/assets'), deletedCharSet);
      // Always force-refresh the court and hoop images — they change frequently and
      // the "skip if exists" logic in restoreAssetsToDir would keep stale versions.
      if (sbReady()) {
        const assetsDir = path.join(__dirname, 'data/assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        for (const fname of ['court-uploaded.png', 'hoop-processed.png']) {
          try {
            const buf = await dlFile(fname);
            if (buf) { fs.writeFileSync(path.join(assetsDir, fname), buf); }
          } catch {}
        }
      }
    } catch (e) {
      console.warn('  [startup] storage restore failed (non-fatal):', e.message);
    }

    // ── STEP 3: Fallback — restore any STILL-MISSING assets from .characters.json base64
    // Only runs for files that R2 couldn't provide (network issue or file never uploaded).
    // This is intentionally AFTER the R2 restore so full-res R2 files always win.
    try {
      const CHARACTERS_FILE = path.join(__dirname, 'data/.characters.json');
      const ASSETS_DIR_RESTORE = path.join(__dirname, 'data/assets');
      if (fs.existsSync(CHARACTERS_FILE)) {
        const chars = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
        const localDeleted = Array.isArray(chars._deleted) ? chars._deleted : [];
        const fullDeletedSet = new Set([...deletedCharSet, ...localDeleted]);
        fs.mkdirSync(ASSETS_DIR_RESTORE, { recursive: true });
        for (const [name, char] of Object.entries(chars)) {
          if (name === '_deleted') continue;
          if (fullDeletedSet.has(name)) continue;
          if (char.bodyAngles) {
            for (const [idx, b64] of Object.entries(char.bodyAngles)) {
              const p = path.join(ASSETS_DIR_RESTORE, `${name}-angle-${idx}.png`);
              if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(b64, 'base64'));
            }
          }
          if (char.headshots) {
            for (const [idx, b64] of Object.entries(char.headshots)) {
              const p = path.join(ASSETS_DIR_RESTORE, `${name}-headshot-${idx}.png`);
              if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(b64, 'base64'));
            }
          }
          if (char.portraitBase64) {
            const p = path.join(ASSETS_DIR_RESTORE, `${name}full.png`);
            if (!fs.existsSync(p)) {
              fs.writeFileSync(p, Buffer.from(char.portraitBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
            }
          }
        }
        console.log('  [startup] base64 fallback restore complete (only missing files)');
      }
    } catch (e) {
      console.warn('  [startup] base64 fallback restore failed (non-fatal):', e.message);
    }

    // ── STEP 4: Restore animation library from storage if local index is empty
    try {
      const { restoreFromStorage: restoreAnimLib } = require('./routes/anim-lib');
      await restoreAnimLib();
    } catch (e) {
      console.warn('  [startup] anim-lib restore failed (non-fatal):', e.message);
    }

    // ── STEP 5: Restore wardrobe from storage if local is empty
    try {
      const { restoreFromStorage: restoreWardrobe } = require('./routes/wardrobe');
      await restoreWardrobe();
    } catch (e) {
      console.warn('  [startup] wardrobe restore failed (non-fatal):', e.message);
    }

    // ── STEP 6: Restore remaining metadata from storage
    // testing-config is ALWAYS refreshed from storage (zone positions change frequently).
    // Other metadata files are only restored if missing locally.
    try {
      const { downloadFile, isAvailable } = require('./lib/r2-storage');
      if (isAvailable()) {
        const restoreJson = async (sbKey, localPath, label, alwaysRefresh) => {
          if (!alwaysRefresh && fs.existsSync(localPath)) return; // already on disk
          const buf = await downloadFile(sbKey);
          if (!buf) return;
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, buf);
          console.log(`  [startup] restored ${label} from storage`);
        };
        await Promise.all([
          restoreJson('_meta/characters-full.json',    path.join(__dirname, 'data/.characters.json'),          'characters',        true), // always refresh — R2 is source of truth, not git
          restoreJson('_meta/custom-animations.json',  path.join(__dirname, 'data/.custom-animations.json'),  'custom-animations', true),
          restoreJson('_meta/char-prompts.json',        path.join(__dirname, 'data/.char-prompts.json'),        'char-prompts'),
          restoreJson('_meta/frame-prompts.json',       path.join(__dirname, 'data/frame-prompts.json'),        'frame-prompts'),
          restoreJson('_meta/cost-tracking.json',       path.join(__dirname, 'data/.cost-tracking.json'),       'cost-tracking'),
          restoreJson('_meta/testing-config.json',      path.join(__dirname, 'data/.testing-config.json'),      'testing-config',    true), // always refresh
          restoreJson('_meta/court-presets.json',       path.join(__dirname, 'data/court-presets.json'),        'court-presets',     true),
          restoreJson('_meta/clothing-registry.json',   path.join(__dirname, 'data/.clothing-registry.json'),  'clothing-registry', true),
          restoreJson('_meta/movement-profiles.json',   path.join(__dirname, 'data/movement-profiles.json'),    'movement-profiles', true),
          restoreJson('_meta/production-db.json',       path.join(__dirname, 'data/.production-db.json'),       'production-db',     true),
        ]);
        // Restore apply-anim metadata files
        const { listFiles } = require('./lib/r2-storage');
        const applyMetaFiles = (await listFiles('_meta/apply-anim')).filter(f => f.endsWith('.json'));
        const applyAnimDir = path.join(__dirname, 'data/apply-anim');
        fs.mkdirSync(applyAnimDir, { recursive: true });
        await Promise.all(applyMetaFiles.map(async (sbKey) => {
          const fname = path.basename(sbKey);
          const localPath = path.join(applyAnimDir, fname);
          if (fs.existsSync(localPath)) return;
          const buf = await downloadFile(sbKey);
          if (buf) { fs.writeFileSync(localPath, buf); }
        }));
        if (applyMetaFiles.length > 0) {
          console.log(`  [startup] restored ${applyMetaFiles.length} apply-anim metadata file(s) from storage`);
        }
      }
    } catch (e) {
      console.warn('  [startup] metadata restore failed (non-fatal):', e.message);
    }

    // ── STEP 7: Proactively seed R2 from local state (first-run or gap fill)
    // If a file exists locally but the R2 backup is stale/missing, upload now.
    // This ensures the next cold deploy will always have the latest data to restore.
    try {
      const { isAvailable: sbOk, uploadJson: sbPushJson, uploadFile: sbPushFile, downloadFile: sbPeek } = require('./lib/r2-storage');
      if (sbOk()) {
        const seedIfMissing = async (sbKey, localPath) => {
          if (!fs.existsSync(localPath)) return;
          const existing = await sbPeek(sbKey).catch(() => null);
          if (existing) return; // already backed up — don't overwrite with stale local copy
          const content = fs.readFileSync(localPath);
          await sbPushJson(sbKey, JSON.parse(content.toString('utf8')));
          console.log(`  [startup] seeded ${sbKey} → cloud storage (first backup)`);
        };
        const seedFileIfMissing = async (sbKey, localPath) => {
          if (!fs.existsSync(localPath)) return;
          const existing = await sbPeek(sbKey).catch(() => null);
          if (existing) return;
          await sbPushFile(sbKey, localPath);
          console.log(`  [startup] seeded ${sbKey} → cloud storage (first backup)`);
        };
        // Seed characters only if R2 has NO backup yet (first-ever deploy)
        // NEVER overwrite R2 with git data — R2 is the source of truth, not git
        await seedIfMissing('_meta/characters-full.json',   path.join(__dirname, 'data/.characters.json'));
        await seedIfMissing('_meta/court-presets.json',      path.join(__dirname, 'data/court-presets.json'));
        await seedIfMissing('_meta/clothing-registry.json',  path.join(__dirname, 'data/.clothing-registry.json'));
        await seedIfMissing('_meta/movement-profiles.json',  path.join(__dirname, 'data/movement-profiles.json'));
        await seedIfMissing('_meta/production-db.json',      path.join(__dirname, 'data/.production-db.json'));
        // Seed court.webp to R2 if not already there (restoreAssetsToDir picks it up next deploy)
        await seedFileIfMissing('court.webp', path.join(__dirname, 'data/assets/court.webp'));
      }
    } catch (e) {
      console.warn('  [startup] R2 seed failed (non-fatal):', e.message);
    }

    // ── Periodic storage backup (safety net) ──────────────────────────────
    // Every 5 minutes, flush all current data to R2 as a safety net in case
    // individual fire-and-forget saves failed. Uses content-hash change
    // detection so unchanged files are skipped — no wasted R2 writes/cost.
    const crypto = require('crypto');
    const _backupHashes = new Map(); // r2Key -> last-uploaded content hash
    const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

    // Files to back up: [localPath, r2Key, skipIfEmpty]
    const BACKUP_TARGETS = [
      ['data/.characters.json',          '_meta/characters-full.json',   true],
      ['data/anim-lib/index.json',        '_meta/anim-lib-index.json',    true],
      ['data/wardrobe.json',              '_meta/wardrobe.json',          true],
      ['data/.clothing-registry.json',    '_meta/clothing-registry.json', false],
      ['data/court-presets.json',         '_meta/court-presets.json',     false],
      ['data/.testing-config.json',       '_meta/testing-config.json',    false],
      ['data/movement-profiles.json',     '_meta/movement-profiles.json', false],
      ['data/.production-db.json',        '_meta/production-db.json',     false],
    ];

    async function runBackup(label) {
      const { isAvailable: sbOk, uploadFile: sbPushRaw } = require('./lib/r2-storage');
      if (!sbOk()) return;
      let uploaded = 0;
      for (const [rel, key, skipIfEmpty] of BACKUP_TARGETS) {
        try {
          const fullPath = path.join(__dirname, rel);
          if (!fs.existsSync(fullPath)) continue;
          const buf = fs.readFileSync(fullPath);
          if (skipIfEmpty) {
            const parsed = JSON.parse(buf.toString('utf8'));
            const n = Array.isArray(parsed)
              ? parsed.length
              : Object.keys(parsed).filter(k => k !== '_deleted').length;
            if (n === 0) continue;
          }
          const h = hashOf(buf);
          if (_backupHashes.get(key) === h) continue;
          await sbPushRaw(key, buf, 'application/json');
          _backupHashes.set(key, h);
          uploaded++;
        } catch (e) {
          console.warn(`  [backup] ${key} failed:`, e.message);
        }
      }
      if (uploaded > 0) console.log(`  [backup:${label}] ✓ flushed ${uploaded} changed file(s) to R2`);
    }

    // Run once at startup to establish baseline hashes (so first interval skips unchanged files)
    setTimeout(() => runBackup('startup').catch(() => {}), 10000);
    setInterval(() => runBackup(new Date().toISOString().slice(0, 19)).catch(() => {}), 5 * 60 * 1000);

    }); // end setImmediate (background restore)

    // ── Graceful shutdown — flush all data to R2 before Railway kills us ──
    // Railway sends SIGTERM with a grace window before hard SIGKILL.
    // Without this, any fire-and-forget R2 saves in-flight are dropped.
    process.on('SIGTERM', async () => {
      console.log('\n  [shutdown] SIGTERM — flushing data to R2...');
      const deadline = Date.now() + 20000; // 20s hard cap

      try {
        const { flushToR2 } = require('./routes/characters');
        await Promise.race([
          flushToR2(),
          new Promise(r => setTimeout(r, deadline - Date.now())),
        ]);
        console.log('  [shutdown] ✓ Character data flushed');
      } catch (e) {
        console.error('  [shutdown] Character flush error:', e.message);
      }

      try {
        await Promise.race([
          runBackup('shutdown'),
          new Promise(r => setTimeout(r, deadline - Date.now())),
        ]);
        console.log('  [shutdown] ✓ Final backup complete');
      } catch (e) {
        console.error('  [shutdown] Final backup error:', e.message);
      }

      process.exit(0);
    });
  })();
}

module.exports = handler;
