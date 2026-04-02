/**
 * Animation Library Routes — Pose-reference animation storage
 *
 * Animations saved here are the source material for Studio generation.
 * Each animation stores: name, angle/POV, fps, loop, N pose-frame PNGs.
 *
 * All frame data is stored as base64 inside index.json so it persists
 * across Railway redeploys (no ephemeral filesystem dependency).
 *
 * Index: data/anim-lib/index.json  ← committed to git, survives deploys
 *   entry.framesBase64: string[]   ← base64-encoded PNG for each frame
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scheduleSync } = require('../lib/auto-git-sync');
const { uploadFile: sbUpload, downloadFile: sbDownload, isAvailable: sbAvailable } = require('../lib/supabase-storage');

const LIB_DIR = path.resolve(__dirname, '../data/anim-lib');
const INDEX_FILE = path.join(LIB_DIR, 'index.json');
const SB_META_KEY = '_meta/anim-lib-index.json';

// These labels match ANGLE_LABELS_8 in char-pipeline.js exactly — index = body angle file index
const ANGLE_LABELS = ['Front', 'Front Right', 'Right', 'Back Right', 'Back', 'Back Left', 'Left', 'Front Left'];

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveIndex(data) {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(INDEX_FILE, json);
  // Back up to Supabase so it survives Railway redeploys (fresh git clone wipes local file)
  if (sbAvailable()) {
    sbUpload(SB_META_KEY, Buffer.from(json));
  }
}

/**
 * Called on server startup — restores anim-lib index from Supabase if local is empty.
 * Prevents animations from being wiped when Railway redeploys from a fresh git clone.
 */
async function restoreFromSupabase() {
  if (!sbAvailable()) return;
  try {
    const local = loadIndex();
    if (Object.keys(local).length > 0) return; // Already have data locally
    const buf = await sbDownload(SB_META_KEY);
    if (!buf) return;
    const remote = JSON.parse(buf.toString('utf8'));
    if (Object.keys(remote).length === 0) return;
    fs.mkdirSync(LIB_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(remote, null, 2));
    console.log(`  [anim-lib] restored ${Object.keys(remote).length} animation(s) from Supabase`);
  } catch (e) {
    console.warn('  [anim-lib] Supabase restore failed (non-fatal):', e.message);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function register(router, ctx) {
  const { TMP_DIR } = ctx;

  // GET /api/anim-lib — list all animations
  router.get('/api/anim-lib', (req, res) => {
    const index = loadIndex();
    const animations = Object.values(index).map(a => ({
      name: a.name,
      displayName: a.displayName,
      angle: a.angle,
      angleIndex: a.angleIndex,
      fps: a.fps,
      loop: a.loop,
      frameCount: a.frameCount,
      createdAt: a.createdAt,
      thumbUrl: `/api/anim-lib/frame/${a.name}/0`,
    }));
    json(res, { animations });
  });

  // POST /api/anim-lib — save animation
  // Body: { name, angle, fps, loop, frameBase64Array?, sessionId?, frameFiles? }
  // frameBase64Array takes priority per-slot; missing slots filled from session disk files.
  router.post('/api/anim-lib', async (req, res) => {
    const body = await parseBody(req);
    const { name, angle, fps, loop, sessionId, frameFiles, frameBase64Array } = body;
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!angle) return json(res, { error: 'angle required' }, 400);
    if (!frameBase64Array?.length && !sessionId) {
      return json(res, { error: 'frameBase64Array or sessionId required' }, 400);
    }

    const animId = name.trim().toLowerCase().replace(/\s+/g, '-');

    try {
      let framesBase64 = [];

      if (sessionId && frameFiles && Array.isArray(frameFiles)) {
        // Build from session disk files; overlay any client-provided base64 where available
        const sessionDir = path.join(TMP_DIR || path.resolve(__dirname, '../data/.video-tmp'), sessionId);
        const subjectDir = path.join(sessionDir, 'subjects');

        for (let i = 0; i < frameFiles.length; i++) {
          // Client already extracted this frame — use it directly
          if (frameBase64Array && frameBase64Array[i]) {
            framesBase64.push(frameBase64Array[i].replace(/^data:image\/\w+;base64,/, ''));
            continue;
          }
          // Fall back to server-side subject or original frame file
          const file = frameFiles[i];
          const subjectFile = path.join(subjectDir, `subject-${i}.png`);
          const originalFile = path.join(sessionDir, 'frames', path.basename(file));
          const srcFile = fs.existsSync(subjectFile) ? subjectFile : originalFile;

          if (fs.existsSync(srcFile)) {
            framesBase64.push(fs.readFileSync(srcFile).toString('base64'));
          } else {
            // Last resort: scan session dir for the file
            try {
              const dirs = fs.readdirSync(sessionDir);
              for (const d of dirs) {
                const candidate = path.join(sessionDir, d, path.basename(file));
                if (fs.existsSync(candidate)) { framesBase64.push(fs.readFileSync(candidate).toString('base64')); break; }
              }
            } catch {}
          }
        }
      } else if (frameBase64Array && Array.isArray(frameBase64Array)) {
        framesBase64 = frameBase64Array.map(d => d.replace(/^data:image\/\w+;base64,/, ''));
      }

      if (framesBase64.length === 0) return json(res, { error: 'No frames could be saved' }, 400);

      // angle can be a label string or a numeric index string ("0"–"7")
      const angleIndex = /^\d+$/.test(String(angle))
        ? Math.min(7, Math.max(0, parseInt(angle)))
        : Math.max(0, ANGLE_LABELS.indexOf(angle));
      const entry = {
        name: animId,
        displayName: name.trim(),
        angle,
        angleIndex: angleIndex >= 0 ? angleIndex : 0,
        fps: parseInt(fps) || 8,
        loop: loop === true || loop === 'true',
        frameCount: framesBase64.length,
        createdAt: new Date().toISOString(),
        framesBase64,
      };

      const index = loadIndex();
      index[animId] = entry;
      saveIndex(index);
      scheduleSync();

      json(res, { success: true, animation: { name: entry.name, displayName: entry.displayName, angle: entry.angle, angleIndex: entry.angleIndex, fps: entry.fps, loop: entry.loop, frameCount: entry.frameCount, createdAt: entry.createdAt, thumbUrl: `/api/anim-lib/frame/${animId}/0` } });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/anim-lib/:name — delete animation
  router.delete('/api/anim-lib/:name', (req, res, params) => {
    const { name } = params;
    const index = loadIndex();
    if (!index[name]) return json(res, { error: 'not found' }, 404);
    delete index[name];
    saveIndex(index);
    scheduleSync();
    json(res, { success: true });
  });

  // GET /api/anim-lib/frame/:name/:index — serve a single pose frame
  router.get('/api/anim-lib/frame/:name/:index', (req, res, params) => {
    const index = loadIndex();
    const anim = index[params.name];
    const frameIdx = parseInt(params.index, 10);

    if (!anim || !anim.framesBase64 || !anim.framesBase64[frameIdx]) {
      res.writeHead(404);
      res.end();
      return;
    }

    const buf = Buffer.from(anim.framesBase64[frameIdx], 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60', 'Content-Length': buf.length });
    res.end(buf);
  });
}

module.exports = { register, ANGLE_LABELS, restoreFromSupabase };
