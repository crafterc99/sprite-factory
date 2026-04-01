/**
 * Animation Library Routes — Pose-reference animation storage
 *
 * Animations saved here are the source material for Studio generation.
 * Each animation stores: name, angle/POV, fps, loop, N pose-frame PNGs.
 *
 * Index: data/anim-lib/index.json
 * Frames: data/anim-lib/{name}/frame-{i}.png
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
      ...a,
      // Add URL for first frame as thumbnail
      thumbUrl: `/api/anim-lib/frame/${a.name}/0`,
    }));
    json(res, { animations });
  });

  // POST /api/anim-lib — save animation from video session subjects
  // Body: { name, angle, fps, loop, sessionId, frameFiles }
  // Copies subject-extracted frames from the video session
  router.post('/api/anim-lib', async (req, res) => {
    const body = await parseBody(req);
    const { name, angle, fps, loop, sessionId, frameFiles, frameBase64Array } = body;
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!angle) return json(res, { error: 'angle required' }, 400);

    const animId = name.trim().toLowerCase().replace(/\s+/g, '-');
    const animDir = path.join(LIB_DIR, animId);
    fs.mkdirSync(animDir, { recursive: true });

    try {
      let frames = [];

      if (frameBase64Array && Array.isArray(frameBase64Array) && frameBase64Array.length > 0) {
        // Save from base64 array (direct upload path)
        for (let i = 0; i < frameBase64Array.length; i++) {
          const data = frameBase64Array[i].replace(/^data:image\/\w+;base64,/, '');
          const outPath = path.join(animDir, `frame-${i}.png`);
          fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
          frames.push(outPath);
        }
      } else if (sessionId && frameFiles && Array.isArray(frameFiles)) {
        // Copy subject-extracted frames from video session
        const sessionDir = path.join(TMP_DIR || path.resolve(__dirname, '../data/.video-tmp'), sessionId);
        const subjectDir = path.join(sessionDir, 'subjects');

        for (let i = 0; i < frameFiles.length; i++) {
          const file = frameFiles[i];
          // Subject file is created by /api/video/extract-subjects as subject-0.png, subject-1.png, etc.
          const subjectFile = path.join(subjectDir, `subject-${i}.png`);
          // Fallback: use original frame if subject not extracted
          const originalFile = path.join(sessionDir, 'frames', path.basename(file));
          const srcFile = fs.existsSync(subjectFile) ? subjectFile : originalFile;

          const outPath = path.join(animDir, `frame-${i}.png`);
          if (fs.existsSync(srcFile)) {
            fs.copyFileSync(srcFile, outPath);
          } else {
            // Try finding in any subfolder of sessionDir
            const allFiles = fs.readdirSync(sessionDir, { recursive: false });
            let found = false;
            for (const d of allFiles) {
              const candidate = path.join(sessionDir, d, path.basename(file));
              if (fs.existsSync(candidate)) {
                fs.copyFileSync(candidate, outPath);
                found = true;
                break;
              }
            }
            if (!found) continue; // skip missing frame
          }
          frames.push(outPath);
        }
      } else {
        return json(res, { error: 'frameBase64Array or (sessionId + frameFiles) required' }, 400);
      }

      if (frames.length === 0) return json(res, { error: 'No frames could be saved' }, 400);

      const angleIndex = ANGLE_LABELS.indexOf(angle);
      const entry = {
        name: animId,
        displayName: name.trim(),
        angle,
        angleIndex: angleIndex >= 0 ? angleIndex : 0,
        fps: parseInt(fps) || 8,
        loop: loop === true || loop === 'true',
        frameCount: frames.length,
        createdAt: new Date().toISOString(),
      };

      const index = loadIndex();
      index[animId] = entry;
      saveIndex(index);
      scheduleSync();

      json(res, { success: true, animation: { ...entry, thumbUrl: `/api/anim-lib/frame/${animId}/0` } });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/anim-lib/:name — delete animation
  router.delete('/api/anim-lib/:name', (req, res, params) => {
    const { name } = params;
    const index = loadIndex();
    if (!index[name]) return json(res, { error: 'not found' }, 404);

    try {
      const animDir = path.join(LIB_DIR, name);
      if (fs.existsSync(animDir)) {
        const files = fs.readdirSync(animDir);
        files.forEach(f => fs.unlinkSync(path.join(animDir, f)));
        fs.rmdirSync(animDir);
      }
    } catch {}

    delete index[name];
    saveIndex(index);
    scheduleSync();
    json(res, { success: true });
  });

  // GET /api/anim-lib/frame/:name/:index — serve a single pose frame
  router.get('/api/anim-lib/frame/:name/:index', (req, res, params) => {
    const framePath = path.join(LIB_DIR, params.name, `frame-${params.index}.png`);
    if (!fs.existsSync(framePath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
    fs.createReadStream(framePath).pipe(res);
  });
}

module.exports = { register, ANGLE_LABELS };
