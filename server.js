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
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=300',
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
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
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

// ─── Deploy Endpoint ─────────────────────────────────────────────────────
const { execSync } = require('child_process');
router.post('/api/deploy', async (req, res) => {
  try {
    const output = execSync(
      'git add -A && git diff --cached --quiet || git commit -m "feat: prompt updates from studio" && git push origin main',
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    return router.handle(req, res, pathname);
  }

  // Serve sprite assets
  if (pathname.startsWith('/assets/')) {
    const file = pathname.replace('/assets/', '');
    return serveImage(res, path.join(ASSETS_DIR, file));
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
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    const { CHARACTERS } = require('./lib/sprite-generator/prompts');
    console.log(`\n  Sprite Production Studio running at http://localhost:${PORT}\n`);
    console.log(`  Characters: ${Object.keys(CHARACTERS).join(', ')}`);
    console.log(`  Animations: 8`);
    console.log(`  API Key: ${process.env.GEMINI_API_KEY ? 'set' : 'NOT SET — export GEMINI_API_KEY'}\n`);
  });
}

module.exports = handler;
