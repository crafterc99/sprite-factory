/**
 * Apply Animation to Character — Routes
 *
 * Generates animation frames by applying a pose sequence to a locked character identity.
 * Uses temporal chaining: each frame receives the previous frame as an additional reference
 * to prevent identity/scale drift across the sequence.
 *
 * Endpoints:
 *   POST /api/apply-anim/start  — submit job (charImageBase64, poseImagesBase64[], settings)
 *   GET  /api/apply-anim/job/:jobId — poll job status
 *   GET  /api/apply-anim/frame/:jobId/:index — serve live frame during generation
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { recordCost }       = require('../middleware/cost-tracker');
const { removeBackground, cropToContent } = require('../lib/sprite-processor/index');
const { uploadFile: sbUpload, uploadJson: sbUploadJson, isAvailable: sbAvailable } = require('../lib/supabase-storage');
const { scheduleSync } = require('../lib/auto-git-sync');

// ── Prompt ────────────────────────────────────────────────────────────────────

const BASE_PROMPT = `Use the provided character reference as the EXACT base identity.

STRICT IDENTITY LOCK:
- Do NOT change face, proportions, height, or body structure
- Do NOT redesign clothing
- Do NOT reinterpret style
- Keep identical pixel scale, colors, and outfit

TASK:
Apply the pose from the pose reference image to the character.

IMPORTANT:
- The pose reference is ONLY for body positioning
- Ignore all styling, colors, or identity from the pose reference
- Transfer ONLY joint positions and limb angles

CONSISTENCY REQUIREMENTS:
- Match the exact proportions and scale of the previous frame
- Do not introduce any scale drift
- Keep character centered
- Feet aligned to a consistent baseline

OUTPUT RULES:
- Same character, new pose
- Pure green (#00FF00) background
- No lighting or shading changes

This is one frame of a sprite animation sequence.
Do NOT generate a new character.`;

const CHAINED_SUFFIX = `

Image 3 is the PREVIOUS FRAME of this animation — use it to maintain perfect visual consistency across the sequence. Same scale, same proportions, same character identity.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) req.destroy(); // 80 MB limit
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function stripDataUrl(b64) {
  return b64.replace(/^data:image\/\w+;base64,/, '');
}

async function buildSpriteSheet(framePaths, outputPath, { frameWidth, frameHeight, columns }) {
  const cols   = Math.max(1, columns || Math.ceil(Math.sqrt(framePaths.length)));
  const rows   = Math.ceil(framePaths.length / cols);
  const sheetW = cols * frameWidth;
  const sheetH = rows * frameHeight;

  // Resize each frame to exact dimensions before compositing
  const resizedPaths = await Promise.all(framePaths.map(async (p, i) => {
    const tmp = p.replace('.png', '-resized.png');
    await sharp(p).resize(frameWidth, frameHeight, { fit: 'contain', kernel: 'nearest', background: { r:0,g:0,b:0,alpha:0 } }).png({ compressionLevel: 0, effort: 1 }).toFile(tmp);
    return tmp;
  }));

  const composites = resizedPaths.map((p, i) => ({
    input: p,
    left:  (i % cols) * frameWidth,
    top:   Math.floor(i / cols) * frameHeight,
  }));

  await sharp({
    create: { width: sheetW, height: sheetH, channels: 4, background: { r:0,g:0,b:0,alpha:0 } },
  }).composite(composites).png({ compressionLevel: 0, effort: 1 }).toFile(outputPath);

  // Clean up resized temps
  resizedPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
}

// ── Job Store ─────────────────────────────────────────────────────────────────

const jobs = new Map();
let jobCounter = 0;

function startJob(meta = {}) {
  const jobId = `aa-${Date.now().toString(36)}-${(++jobCounter).toString(36)}`;
  jobs.set(jobId, { status: 'pending', progress: null, result: null, error: null, ...meta });
  // Auto-expire after 45 minutes
  setTimeout(() => jobs.delete(jobId), 45 * 60 * 1000);
  return jobId;
}

function updateJob(jobId, patch) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, ...patch });
}

// ── Route Registration ────────────────────────────────────────────────────────

function register(router, ctx) {
  const { ASSETS_DIR, TMP_DIR } = ctx;

  // ── GET /api/apply-anim/job/:jobId ────────────────────────────────────────
  router.get('/api/apply-anim/job/:jobId', (req, res, params) => {
    const j = jobs.get(params.jobId);
    if (!j) return json(res, { error: 'job not found' }, 404);
    json(res, { status: j.status, progress: j.progress, result: j.result, error: j.error });
  });

  // ── GET /api/apply-anim/frame/:jobId/:index ───────────────────────────────
  // Serves a frame that was generated during an active job (for live preview)
  router.get('/api/apply-anim/frame/:jobId/:index', (req, res, params) => {
    const idx  = String(parseInt(params.index, 10)).padStart(2, '0');
    const fp   = path.join(TMP_DIR, 'apply-anim', params.jobId, 'frames', `frame-${idx}.png`);
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
    const buf = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });

  // ── POST /api/apply-anim/start ────────────────────────────────────────────
  // Body: { charImageBase64, poseImagesBase64[], settings?, model? }
  router.post('/api/apply-anim/start', async (req, res) => {
    const body = await parseBody(req);
    const { charImageBase64, poseImagesBase64, settings = {}, model } = body;

    if (!charImageBase64)
      return json(res, { error: 'charImageBase64 required' }, 400);
    if (!Array.isArray(poseImagesBase64) || poseImagesBase64.length === 0)
      return json(res, { error: 'poseImagesBase64 array required (at least 1 pose)' }, 400);
    if (poseImagesBase64.length > 24)
      return json(res, { error: 'Maximum 24 pose frames per job' }, 400);

    const frameWidth  = Math.min(512, Math.max(64,  parseInt(settings.frameWidth)  || 256));
    const frameHeight = Math.min(512, Math.max(64,  parseInt(settings.frameHeight) || 256));
    const columns     = Math.min(12,  Math.max(1,   parseInt(settings.columns)     || 4));
    const animId      = (settings.animId || `apply-${Date.now().toString(36)}`).replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
    const charName    = settings.charName || null;
    const animLabel   = settings.animLabel || animId;
    const modelId     = model || 'gemini-3-pro-image-preview';

    const jobId = startJob({ animId, charName });

    setImmediate(async () => {
      const workDir    = path.join(TMP_DIR, 'apply-anim', jobId);
      const framesDir  = path.join(workDir, 'frames');
      try {
        fs.mkdirSync(framesDir,  { recursive: true });

        // ── Write character reference to disk ──────────────────────────────
        const charRefPath = path.join(workDir, 'char-ref.png');
        fs.writeFileSync(charRefPath, Buffer.from(stripDataUrl(charImageBase64), 'base64'));
        sbUpload(`characters/${animId}/ref.png`, charRefPath);

        // ── Write pose images to disk ──────────────────────────────────────
        const posePaths = [];
        for (let i = 0; i < poseImagesBase64.length; i++) {
          const pp = path.join(workDir, `pose-${String(i).padStart(2,'0')}.png`);
          fs.writeFileSync(pp, Buffer.from(stripDataUrl(poseImagesBase64[i]), 'base64'));
          posePaths.push(pp);
          sbUpload(`poses/${animId}/pose_${String(i).padStart(2,'0')}.png`, pp);
        }

        const total = posePaths.length;
        updateJob(jobId, { progress: { frame: 0, total, msg: 'Starting…', frames: [] } });

        const client = new NanaBananaClient({ model: modelId });
        const processedPaths = [];
        let prevFramePath = null;

        // ── Sequential frame generation with temporal chaining ─────────────
        for (let i = 0; i < posePaths.length; i++) {
          updateJob(jobId, {
            progress: {
              frame: i,
              total,
              msg: `Generating frame ${i + 1} of ${total}…`,
              frames: processedPaths.map((_, fi) => `/api/apply-anim/frame/${jobId}/${fi}`),
            },
          });

          const refImages = [charRefPath, posePaths[i]];
          const prompt    = prevFramePath ? BASE_PROMPT + CHAINED_SUFFIX : BASE_PROMPT;
          if (prevFramePath) refImages.push(prevFramePath);

          const result = await client.generate(prompt, {
            referenceImages: refImages,
            aspectRatio:     '1:1',
            resolution:      '1K',
            model:           modelId,
            maxRetries:      2,
            timeoutMs:       120000,
          });

          recordCost(modelId, 'apply_anim', '1K', refImages.length, { animId, frame: i });

          // Save raw output
          const rawPath = path.join(framesDir, `raw-${String(i).padStart(2,'0')}.png`);
          fs.writeFileSync(rawPath, result.imageBuffer);

          // Remove green background + crop to target size
          const processedPath = path.join(framesDir, `frame-${String(i).padStart(2,'0')}.png`);
          await removeBackground(rawPath, rawPath);
          await cropToContent(rawPath, processedPath, { width: frameWidth, height: frameHeight, padding: 8 });

          processedPaths.push(processedPath);
          prevFramePath = processedPath;

          // Upload frame immediately so it persists
          sbUpload(`frames/${animId}/frame_${String(i).padStart(2,'0')}.png`, processedPath);

          updateJob(jobId, {
            progress: {
              frame: i + 1,
              total,
              msg: `✓ Frame ${i + 1}/${total} done`,
              frames: processedPaths.map((_, fi) => `/api/apply-anim/frame/${jobId}/${fi}`),
            },
          });
        }

        // ── Build sprite sheet ─────────────────────────────────────────────
        const sheetDir  = path.join(ASSETS_DIR, 'apply-anim');
        fs.mkdirSync(sheetDir, { recursive: true });
        const sheetPath = path.join(sheetDir, `${animId}-sheet.png`);
        await buildSpriteSheet(processedPaths, sheetPath, { frameWidth, frameHeight, columns });
        sbUpload(`spritesheets/${animId}/sheet.png`, sheetPath);

        // ── Copy frames to persistent assets dir ───────────────────────────
        const framesAssetDir = path.join(ASSETS_DIR, `applyf-${animId}`);
        fs.mkdirSync(framesAssetDir, { recursive: true });
        processedPaths.forEach((p, fi) => {
          const dest = path.join(framesAssetDir, `frame-${String(fi).padStart(2,'0')}.png`);
          fs.copyFileSync(p, dest);
        });

        // ── Metadata JSON ──────────────────────────────────────────────────
        const metadata = {
          animId,
          animLabel,
          charName,
          frameCount:    processedPaths.length,
          frameWidth,
          frameHeight,
          columns,
          fps:           8,
          generatedAt:   new Date().toISOString(),
          spriteSheetUrl: `/assets/apply-anim/${animId}-sheet.png`,
          frames: processedPaths.map((_, fi) => ({
            index: fi,
            url:   `/assets/applyf-${animId}/frame-${String(fi).padStart(2,'0')}.png`,
          })),
        };

        // Persist metadata to data/apply-anim/ and Supabase
        const metaDir = path.resolve(__dirname, '../data/apply-anim');
        fs.mkdirSync(metaDir, { recursive: true });
        fs.writeFileSync(path.join(metaDir, `${animId}.json`), JSON.stringify(metadata, null, 2));
        if (sbAvailable()) sbUploadJson(`_meta/apply-anim/${animId}.json`, metadata);
        scheduleSync();

        updateJob(jobId, {
          status: 'done',
          result: metadata,
          progress: {
            frame: processedPaths.length,
            total: processedPaths.length,
            msg:   '✓ Complete',
            frames: metadata.frames.map(f => f.url),
          },
        });

      } catch (err) {
        console.error('[apply-anim] job failed:', err.message);
        updateJob(jobId, { status: 'error', error: err.message });
      }
    });

    return json(res, { jobId, status: 'started' });
  });

  // ── GET /api/apply-anim/list — list saved animations ─────────────────────
  router.get('/api/apply-anim/list', (req, res) => {
    const metaDir = path.resolve(__dirname, '../data/apply-anim');
    try {
      if (!fs.existsSync(metaDir)) return json(res, { animations: [] });
      const files = fs.readdirSync(metaDir).filter(f => f.endsWith('.json'));
      const animations = files.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8')); }
        catch { return null; }
      }).filter(Boolean);
      json(res, { animations });
    } catch (e) {
      json(res, { animations: [] });
    }
  });
}

module.exports = { register };
