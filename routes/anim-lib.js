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

const LIB_DIR = path.resolve(__dirname, '../data/anim-lib');
const INDEX_FILE = path.join(LIB_DIR, 'index.json');

const ANGLE_LABELS = ['front','front_right_45','right_90','back_right_135','back_180','back_left_225','left_270','front_left_315'];

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveIndex(data) {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(data, null, 2));
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
  // Body: { name, angle, fps, loop, frameBase64Array } or { name, angle, fps, loop, sessionId, frameFiles }
  router.post('/api/anim-lib', async (req, res) => {
    const body = await parseBody(req);
    const { name, angle, fps, loop, sessionId, frameFiles, frameBase64Array } = body;
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!angle) return json(res, { error: 'angle required' }, 400);

    const animId = name.trim().toLowerCase().replace(/\s+/g, '-');

    try {
      let framesBase64 = [];

      if (frameBase64Array && Array.isArray(frameBase64Array) && frameBase64Array.length > 0) {
        // Strip data URI prefix and store
        framesBase64 = frameBase64Array.map(d => d.replace(/^data:image\/\w+;base64,/, ''));
      } else if (sessionId && frameFiles && Array.isArray(frameFiles)) {
        // Read subject-extracted frames from video session
        const sessionDir = path.join(TMP_DIR || path.resolve(__dirname, '../data/.video-tmp'), sessionId);
        const subjectDir = path.join(sessionDir, 'subjects');

        for (let i = 0; i < frameFiles.length; i++) {
          const file = frameFiles[i];
          const subjectFile = path.join(subjectDir, `subject-${i}.png`);
          const originalFile = path.join(sessionDir, 'frames', path.basename(file));
          const srcFile = fs.existsSync(subjectFile) ? subjectFile : originalFile;

          if (fs.existsSync(srcFile)) {
            framesBase64.push(fs.readFileSync(srcFile).toString('base64'));
          } else {
            const allFiles = fs.readdirSync(sessionDir, { recursive: false });
            let found = false;
            for (const d of allFiles) {
              const candidate = path.join(sessionDir, d, path.basename(file));
              if (fs.existsSync(candidate)) {
                framesBase64.push(fs.readFileSync(candidate).toString('base64'));
                found = true;
                break;
              }
            }
            if (!found) continue;
          }
        }
      } else {
        return json(res, { error: 'frameBase64Array or (sessionId + frameFiles) required' }, 400);
      }

      if (framesBase64.length === 0) return json(res, { error: 'No frames could be saved' }, 400);

      const angleIndex = ANGLE_LABELS.indexOf(angle);
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

module.exports = { register, ANGLE_LABELS };
