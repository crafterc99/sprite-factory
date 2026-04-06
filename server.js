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
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
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
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=60',
      'ETag': etag,
    });
    fs.createReadStream(imagePath).pipe(res);
  } catch {
    json(res, { error: 'Image not found' }, 404);
  }
}

async function runWithConcurrency(tasks, concurrency = 2, delayMs = 2000) {
  const results = [];
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
require('./routes/prompts').register(router, ctx);
require('./routes/prompt-pipeline').register(router, ctx);
require('./routes/production').register(router, ctx);
require('./routes/anchor').register(router, ctx);
require('./routes/animation-contract').register(router, ctx);
require('./routes/char-pipeline').register(router, ctx);
require('./routes/wardrobe').register(router);
require('./routes/anim-lib').register(router, ctx);
require('./routes/studio-gen').register(router, ctx);
require('./routes/apply-anim').register(router, ctx);

// ─── Testing Config Endpoint ─────────────────────────────────────────────
const TESTING_CONFIG_FILE = path.join(__dirname, 'data/.testing-config.json');
router.get('/api/testing-config', async (req, res) => {
  try {
    if (fs.existsSync(TESTING_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(TESTING_CONFIG_FILE, 'utf8'));
      return json(res, data);
    }
    const { downloadFile, isAvailable } = require('./lib/supabase-storage');
    if (isAvailable()) {
      const buf = await downloadFile('_meta/testing-config.json');
      if (buf) {
        const data = JSON.parse(buf.toString('utf8'));
        return json(res, data);
      }
    }
    return json(res, {});
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});
router.post('/api/testing-config', async (req, res) => {
  try {
    const body = await parseBody(req);
    fs.mkdirSync(path.dirname(TESTING_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(TESTING_CONFIG_FILE, JSON.stringify(body, null, 2));
    const { uploadJson, isAvailable } = require('./lib/supabase-storage');
    if (isAvailable()) {
      await uploadJson('_meta/testing-config.json', body);
    }
    return json(res, { success: true });
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

  // Serve engine JS modules (/engine/*.js)
  if (pathname.startsWith('/engine/')) {
    const file = pathname.replace('/engine/', '');
    const enginePath = path.join(__dirname, 'engine', file);
    if (fs.existsSync(enginePath) && enginePath.endsWith('.js')) {
      const src = fs.readFileSync(enginePath);
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Content-Length': src.length });
      return res.end(src);
    }
    res.writeHead(404); return res.end('Not found');
  }

  // Serve sprite assets — disk first, Supabase fallback
  if (pathname.startsWith('/assets/')) {
    const file = decodeURIComponent(pathname.replace('/assets/', ''));
    const localPath = path.join(ASSETS_DIR, file);
    if (fs.existsSync(localPath)) return serveImage(res, localPath);
    // Not on disk — try Supabase Storage and cache locally
    const { downloadFile, isAvailable } = require('./lib/supabase-storage');
    if (isAvailable()) {
      const buf = await downloadFile(file);
      if (buf) {
        try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, buf); } catch {}
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

  res.writeHead(404);
  res.end('Not found');
}

// ─── Server ─────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    // Pull latest committed data on startup (e.g. from another machine or manual git push)
    try {
      execSync('git pull origin main --no-rebase --ff-only', { cwd: __dirname, timeout: 15000, stdio: 'ignore' });
      console.log('  [startup] git pull ok');
    } catch {
      // Not fatal — offline or no remote, just start with local data
    }

    // ── STEP 1: Sync deletions from Supabase FIRST — before any asset restore
    // This ensures we know exactly which characters are deleted before downloading anything.
    // Returns a Set of deleted character names so later steps can skip their files.
    let deletedCharSet = new Set();
    try {
      const { syncDeletedFromSupabase } = require('./routes/characters');
      deletedCharSet = await syncDeletedFromSupabase();
      if (deletedCharSet.size > 0) {
        console.log(`  [startup] tombstoned ${deletedCharSet.size} deleted character(s): ${[...deletedCharSet].join(', ')}`);
      }
    } catch (e) {
      console.warn('  [startup] character deletion sync failed (non-fatal):', e.message);
    }

    // ── STEP 2: Restore character body angle images from .characters.json base64
    try {
      const CHARACTERS_FILE = path.join(__dirname, 'data/.characters.json');
      const ASSETS_DIR_RESTORE = path.join(__dirname, 'data/assets');
      if (fs.existsSync(CHARACTERS_FILE)) {
        const chars = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
        // Merge disk deletedSet with Supabase deletedSet for full coverage
        const localDeleted = Array.isArray(chars._deleted) ? chars._deleted : [];
        const fullDeletedSet = new Set([...deletedCharSet, ...localDeleted]);
        fs.mkdirSync(ASSETS_DIR_RESTORE, { recursive: true });
        for (const [name, char] of Object.entries(chars)) {
          if (name === '_deleted') continue;
          if (fullDeletedSet.has(name)) continue; // don't restore assets for deleted chars
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
            if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(char.portraitBase64.replace(/^data:image\/\w+;base64,/,''), 'base64'));
          }
        }
        console.log('  [startup] character assets restored from .characters.json');
      }
    } catch (e) {
      console.warn('  [startup] asset restore failed (non-fatal):', e.message);
    }

    // ── STEP 3: Restore missing assets from Supabase — skipping deleted chars
    try {
      const { restoreAssetsToDir } = require('./lib/supabase-storage');
      await restoreAssetsToDir(path.join(__dirname, 'data/assets'), deletedCharSet);
    } catch (e) {
      console.warn('  [startup] Supabase restore failed (non-fatal):', e.message);
    }

    // ── STEP 4: Restore animation library from Supabase if local index is empty
    try {
      const { restoreFromSupabase: restoreAnimLib } = require('./routes/anim-lib');
      await restoreAnimLib();
    } catch (e) {
      console.warn('  [startup] anim-lib restore failed (non-fatal):', e.message);
    }

    // ── STEP 5: Restore wardrobe from Supabase if local is empty
    try {
      const { restoreFromSupabase: restoreWardrobe } = require('./routes/wardrobe');
      await restoreWardrobe();
    } catch (e) {
      console.warn('  [startup] wardrobe restore failed (non-fatal):', e.message);
    }

    // ── STEP 6: Restore remaining metadata from Supabase if missing locally
    try {
      const { downloadFile, isAvailable } = require('./lib/supabase-storage');
      if (isAvailable()) {
        const restoreJson = async (sbKey, localPath, label) => {
          if (fs.existsSync(localPath)) return; // already on disk
          const buf = await downloadFile(sbKey);
          if (!buf) return;
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, buf);
          console.log(`  [startup] restored ${label} from Supabase`);
        };
        await Promise.all([
          restoreJson('_meta/custom-animations.json',  path.join(__dirname, 'data/.custom-animations.json'),  'custom-animations'),
          restoreJson('_meta/char-prompts.json',        path.join(__dirname, 'data/.char-prompts.json'),        'char-prompts'),
          restoreJson('_meta/frame-prompts.json',       path.join(__dirname, 'data/frame-prompts.json'),        'frame-prompts'),
          restoreJson('_meta/cost-tracking.json',       path.join(__dirname, 'data/.cost-tracking.json'),       'cost-tracking'),
          restoreJson('_meta/testing-config.json',      path.join(__dirname, 'data/.testing-config.json'),      'testing-config'),
        ]);
        // Restore apply-anim metadata files
        const { listFiles } = require('./lib/supabase-storage');
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
          console.log(`  [startup] restored ${applyMetaFiles.length} apply-anim metadata file(s) from Supabase`);
        }
      }
    } catch (e) {
      console.warn('  [startup] metadata restore failed (non-fatal):', e.message);
    }

    const server = http.createServer(handler);
    server.listen(PORT, () => {
      const { CHARACTERS } = require('./lib/sprite-generator/prompts');
      console.log(`\n  Sprite Production Studio running at http://localhost:${PORT}\n`);
      console.log(`  Characters: ${Object.keys(CHARACTERS).join(', ')}`);
      console.log(`  Animations: 8`);
      console.log(`  API Key: ${process.env.GEMINI_API_KEY ? 'set' : 'NOT SET — export GEMINI_API_KEY'}`);
      console.log(`  GitHub Sync: ${process.env.GITHUB_TOKEN ? 'enabled' : 'DISABLED — set GITHUB_TOKEN for persistence'}\n`);
    });
  })();
}

module.exports = handler;
