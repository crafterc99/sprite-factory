/**
 * Studio Generation Routes — Character + Pose → Sprite
 *
 * Takes a character's angle reference image and a sequence of pose frames
 * from the animation library, generates each frame with:
 *   Image 1: character body angle (identity lock)
 *   Image 2: pose reference frame (motion copy)
 *
 * Output: sprite strip at data/assets/{charName}-{animName}.png
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { recordCost } = require('../middleware/cost-tracker');
const { removeBackground, cropToContent } = require('../lib/sprite-processor/index');

const ANIM_LIB_DIR = path.resolve(__dirname, '../data/anim-lib');
const ANIM_LIB_INDEX = path.join(ANIM_LIB_DIR, 'index.json');

const STUDIO_PROMPT = [
  'Keep the exact character from Image 1. Copy only the exact pose from Image 2.',
  'Do not mix faces or identities. make sure the characters face does not change at all.',
  'Do not change body shape, skin tone, hairstyle, or facial structure.',
  'Match Image 2\'s full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing.',
  'natural anatomy, no distortions.',
  'Pure green (#00FF00) background.',
].join('\n');

function loadAnimLib() {
  try {
    if (fs.existsSync(ANIM_LIB_INDEX)) return JSON.parse(fs.readFileSync(ANIM_LIB_INDEX, 'utf8'));
  } catch {}
  return {};
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Async Job Store ──────────────────────────────────────────────────────────

const jobs = new Map();

function startJob() {
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  jobs.set(jobId, { status: 'pending', result: null, error: null, progress: null });
  setTimeout(() => jobs.delete(jobId), 20 * 60 * 1000);
  return jobId;
}

function updateJob(jobId, progress) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, progress });
}

function finishJob(jobId, result) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, status: 'done', result });
}

function failJob(jobId, errMsg) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, status: 'error', error: errMsg });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildStrip(framePaths, outputPath) {
  const frames = await Promise.all(framePaths.map(p => sharp(p).metadata()));
  const w = frames[0].width;
  const h = frames[0].height;
  const strip = sharp({
    create: { width: w * framePaths.length, height: h, channels: 4, background: { r:0, g:0, b:0, alpha:0 } }
  });
  const composites = framePaths.map((p, i) => ({ input: p, left: i * w, top: 0 }));
  await strip.composite(composites).png().toFile(outputPath);
}

async function processFrame(srcPath, outPath) {
  await removeBackground(srcPath, srcPath);
  await cropToContent(srcPath, outPath, { width: 180, height: 180, padding: 10 });
}

// ── Routes ────────────────────────────────────────────────────────────────────

function register(router, ctx) {
  const { ASSETS_DIR, TMP_DIR } = ctx;

  // GET /api/studio/job/:jobId — poll generation job
  router.get('/api/studio/job/:jobId', (req, res, params) => {
    const job = jobs.get(params.jobId);
    if (!job) return json(res, { error: 'job not found' }, 404);
    json(res, { status: job.status, result: job.result, error: job.error, progress: job.progress });
  });

  // POST /api/studio/generate — generate sprite for character + animation
  // Body: { charName, animName, model? }
  router.post('/api/studio/generate', async (req, res) => {
    const body = await parseBody(req);
    const { charName, animName, model } = body;
    if (!charName || !animName) return json(res, { error: 'charName and animName required' }, 400);

    const lib = loadAnimLib();
    const anim = lib[animName];
    if (!anim) return json(res, { error: `Animation "${animName}" not found in library` }, 400);

    // Find the best available angle: exact match → front → any available
    const ANGLE_NAMES = ['Front','Front Right','Right','Back Right','Back','Back Left','Left','Front Left'];
    let resolvedAnglePath = null;
    const tryIndices = [anim.angleIndex, 0, 1, 2, 3, 4, 5, 6, 7];
    for (const idx of tryIndices) {
      const p = path.join(ASSETS_DIR, `${charName}-angle-${idx}.png`);
      if (fs.existsSync(p)) { resolvedAnglePath = p; break; }
    }
    // Also try portrait as last resort
    const portraitPath = path.join(ASSETS_DIR, `${charName}full.png`);
    if (!resolvedAnglePath && fs.existsSync(portraitPath)) resolvedAnglePath = portraitPath;
    if (!resolvedAnglePath) {
      return json(res, { error: `No body angle or portrait found for "${charName}" — generate body angles first` }, 400);
    }

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = model || 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });

        const genDir = path.join(TMP_DIR, 'studio-gen', `${charName}-${animName}`);
        fs.mkdirSync(genDir, { recursive: true });

        // Write pose frames from base64 stored in index.json to tmp files
        const poseFrameDir = path.join(genDir, 'pose-frames');
        fs.mkdirSync(poseFrameDir, { recursive: true });
        const posePaths = [];

        if (anim.framesBase64 && anim.framesBase64.length > 0) {
          for (let i = 0; i < anim.framesBase64.length; i++) {
            const posePath = path.join(poseFrameDir, `frame-${i}.png`);
            fs.writeFileSync(posePath, Buffer.from(anim.framesBase64[i], 'base64'));
            posePaths.push(posePath);
          }
        }

        const frameCount = anim.frameCount;
        updateJob(jobId, { frame: 0, total: frameCount, msg: `Generating all ${frameCount} frames in parallel…` });

        // Generate all frames in parallel for maximum speed
        const processedPaths = await Promise.all(
          Array.from({ length: frameCount }, async (_, i) => {
            const posePath = posePaths[i];
            if (!posePath || !fs.existsSync(posePath)) {
              throw new Error(`Pose frame ${i} not found for animation "${animName}"`);
            }

            const result = await client.generate(STUDIO_PROMPT, {
              referenceImages: [resolvedAnglePath, posePath],
              aspectRatio: '1:1',
              resolution: '1K',
              model: modelId,
              maxRetries: 2,
              timeoutMs: 90000,
            });

            const rawPath = path.join(genDir, `raw-${i}.png`);
            fs.writeFileSync(rawPath, result.imageBuffer);
            recordCost(modelId, 'studio_gen', '1K', 2, { charName, animName, frame: i });

            const processedPath = path.join(genDir, `frame-${i}.png`);
            await processFrame(rawPath, processedPath);
            updateJob(jobId, { frame: i + 1, total: frameCount, msg: `✓ Frame ${i + 1} done` });
            return processedPath;
          })
        );

        // Assemble sprite strip
        const stripPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
        await buildStrip(processedPaths, stripPath);

        finishJob(jobId, {
          success: true,
          charName,
          animName,
          frameCount: processedPaths.length,
          fps: anim.fps,
          spriteUrl: `/assets/${charName}-${animName}.png`,
        });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
  });
}

module.exports = { register };
