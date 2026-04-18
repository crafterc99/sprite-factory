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
const { removeGreenBackground, cropToContent, getContentBounds, placeContentInFrame, processFrameSetConsistently } = require('../lib/sprite-processor/index');
const { uploadFile: sbUpload } = require('../lib/supabase-storage');

const { scaleToHeight, BASELINE_Y, DEFAULT_FRAME_SIZE } = require('../lib/sprite-processor/height-scaler');
const ANIM_LIB_DIR  = path.resolve(__dirname, '../data/anim-lib');
const ANIM_LIB_INDEX = path.join(ANIM_LIB_DIR, 'index.json');

const DEFAULT_STUDIO_PROMPT =
  'Replace the pixelated character from Image 2 with the pose from Image 1. The background is pure green (#00FF00).';

const PROMPTS_FILE = path.resolve(__dirname, '../data/.char-prompts.json');

function loadStudioPrompt() {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
      if (d.studio) return d.studio;
    }
  } catch {}
  return DEFAULT_STUDIO_PROMPT;
}

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../data/.characters.json');
function loadCharPixelHeight(charName) {
  try {
    if (fs.existsSync(CHARACTERS_FILE)) {
      const reg = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
      return reg[charName]?.pixelHeight || null;
    }
  } catch {}
  return null;
}

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

async function buildStrip(framePaths, outputPath, opts = {}) {
  // Scale each native-res content frame to standard 180×180 using height-scaler.
  // This keeps strips browser-safe (<4096px wide for iOS canvas) and game-engine
  // compatible (PlayerRenderer expects 180×180 with baseline at Y=170).
  const targetPixelHeight = opts.pixelHeight || 112;
  const frameSize = DEFAULT_FRAME_SIZE; // 180

  const scaledBufs = await Promise.all(framePaths.map(async (p, i) => {
    const tmpPath = p + '-strip-scaled.png';
    try {
      await scaleToHeight(p, tmpPath, targetPixelHeight, BASELINE_Y, frameSize);
      const buf = fs.readFileSync(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
      return buf;
    } catch (err) {
      console.warn(`[studio-gen] buildStrip scale failed for frame ${i}, using simple resize:`, err.message);
      return sharp(p)
        .resize(frameSize, frameSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
        .png({ compressionLevel: 0, effort: 1 })
        .toBuffer();
    }
  }));

  await sharp({
    create: { width: frameSize * framePaths.length, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite(scaledBufs.map((buf, i) => ({ input: buf, left: i * frameSize, top: 0 })))
    .png({ compressionLevel: 0, effort: 1 })
    .toFile(outputPath);
}

async function processFrame(srcPath, outPath) {
  // Remove green BG, then exact-crop to content bounds — zero resize, all original pixels preserved
  const transparentPath = srcPath + '-transparent.png';
  try {
    await removeGreenBackground(srcPath, transparentPath, { feather: 0 });
    const bounds = await getContentBounds(transparentPath);
    if (bounds.w > 0 && bounds.h > 0) {
      await sharp(transparentPath)
        .extract({ left: bounds.minX, top: bounds.minY, width: bounds.w, height: bounds.h })
        .png({ compressionLevel: 0, effort: 1 })
        .toFile(outPath);
    } else {
      await sharp(transparentPath).png({ compressionLevel: 0, effort: 1 }).toFile(outPath);
    }
  } catch (err) {
    console.warn(`[studio-gen] processFrame fallback (${srcPath}):`, err.message);
    // Fallback: use raw AI image to ensure frame always exists
    await sharp(srcPath).png({ compressionLevel: 0, effort: 1 }).toFile(outPath);
  } finally {
    try { fs.unlinkSync(transparentPath); } catch {}
  }
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

  // GET /api/studio/frame-info/:charName/:animName/:frameIndex
  // Returns master frame info, detected content bounds, heights, and scale for a single frame.
  router.get('/api/studio/frame-info/:charName/:animName/:frameIndex', async (req, res, params) => {
    const { charName, animName, frameIndex } = params;
    const fi = parseInt(frameIndex, 10);
    try {
      const masterPath = path.join(ASSETS_DIR, `${charName}-${animName}-masters`, `frame-${fi}.png`);
      const finalPath  = path.join(ASSETS_DIR, `${charName}-${animName}-frames`, `frame-${fi}.png`);
      const metaPath   = path.join(ASSETS_DIR, `${charName}-${animName}-genmeta.json`);

      const hasMaster = fs.existsSync(masterPath);
      const hasFinal  = fs.existsSync(finalPath);

      let bounds = null;
      let masterSize = null;
      if (hasMaster) {
        bounds = await getContentBounds(masterPath);
        const meta = await require('sharp')(masterPath).metadata();
        masterSize = { width: meta.width, height: meta.height };
      }

      let genMeta = null;
      if (fs.existsSync(metaPath)) {
        try { genMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      }

      const targetHeight = loadCharPixelHeight(charName);
      const frameBounds = genMeta?.allBounds?.[fi] || bounds;

      json(res, {
        charName,
        animName,
        frameIndex: fi,
        masterUrl:  hasMaster ? `/assets/${charName}-${animName}-masters/frame-${fi}.png` : null,
        finalUrl:   hasFinal  ? `/assets/${charName}-${animName}-frames/frame-${fi}.png`  : null,
        masterSize,
        bounds: frameBounds,
        visibleHeight: frameBounds?.h || null,
        targetHeight,
        scale: genMeta?.scale || null,
        globalMaxH: genMeta?.globalMaxH || null,
        frameSize: genMeta?.frameSize || 180,
        padding: genMeta?.padding || 8,
      });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // POST /api/studio/generate — generate sprite for character + animation
  // Body: { charName, animName, model? }
  router.post('/api/studio/generate', async (req, res) => {
    const body = await parseBody(req);
    const { charName, animName, model, resizeMode } = body;
    if (!charName || !animName) return json(res, { error: 'charName and animName required' }, 400);
    const pipelineOpts = { resizeMode: resizeMode || process.env.SPRITE_RESIZE_MODE || 'high-quality' };

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

        // Phase 1: Generate all raw frames in parallel
        const rawPaths = await Promise.all(
          Array.from({ length: frameCount }, async (_, i) => {
            const posePath = posePaths[i];
            if (!posePath || !fs.existsSync(posePath)) {
              throw new Error(`Pose frame ${i} not found for animation "${animName}"`);
            }

            const result = await client.generate(loadStudioPrompt(), {
              referenceImages: [posePath, resolvedAnglePath],
              aspectRatio: '3:4',
              resolution: '1K',
              model: modelId,
              maxRetries: 1,
              timeoutMs: 70000,
            });

            const rawPath = path.join(genDir, `raw-${i}.png`);
            fs.writeFileSync(rawPath, result.imageBuffer);
            recordCost(modelId, 'studio_gen', '1K', 2, { charName, animName, frame: i });
            updateJob(jobId, { frame: i + 1, total: frameCount, msg: `✓ Frame ${i + 1} done` });
            return rawPath;
          })
        );

        // Phase 2: Remove green BG and crop each frame — per-frame fallback so one bad frame doesn't fail the job
        updateJob(jobId, { frame: frameCount, total: frameCount, msg: 'Processing frames…' });
        const processedPaths = await Promise.all(
          rawPaths.map(async (rawPath, i) => {
            const outPath = path.join(genDir, `frame-${i}.png`);
            try {
              await processFrame(rawPath, outPath);
            } catch (err) {
              console.warn(`[studio-gen] frame ${i} processing failed, using raw:`, err.message);
              await sharp(rawPath).png({ compressionLevel: 0, effort: 1 }).toFile(outPath);
            }
            return outPath;
          })
        );

        // Assemble sprite strip — 180×180 per frame, game-engine compatible
        const stripPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
        const charPixelHeight = loadCharPixelHeight(charName);
        await buildStrip(processedPaths, stripPath, { pixelHeight: charPixelHeight });
        sbUpload(`${charName}-${animName}.png`, stripPath);

        // Copy individual frames to assets dir so the result grid can load them
        const framesOutDir = path.join(ASSETS_DIR, `${charName}-${animName}-frames`);
        fs.mkdirSync(framesOutDir, { recursive: true });
        processedPaths.forEach((p, i) => {
          const dest = path.join(framesOutDir, `frame-${i}.png`);
          fs.copyFileSync(p, dest);
          sbUpload(`${charName}-${animName}-frames/frame-${i}.png`, dest);
        });

        finishJob(jobId, {
          success: true,
          charName,
          animName,
          frameCount: processedPaths.length,
          fps: anim.fps,
          spriteUrl: `/assets/${charName}-${animName}.png`,
        });
      } catch (err) {
        const msg = err?.message || String(err) || 'Unknown error';
        console.error('[studio-gen] job failed:', err);
        failJob(jobId, msg);
      }
    });

    return json(res, { jobId, status: 'started' });
  });

  // POST /api/studio/regen-frame — regenerate a single frame from an anim-lib animation
  // Body: { charName, animName, frameIndex, model?, customPrompt?, identityFix?: { headshotIndex } }
  router.post('/api/studio/regen-frame', async (req, res) => {
    const body = await parseBody(req);
    const { charName, animName, frameIndex, model, customPrompt, identityFix, resizeMode } = body;
    const regenPipelineOpts = { resizeMode: resizeMode || process.env.SPRITE_RESIZE_MODE || 'high-quality' };
    if (!charName || !animName || frameIndex == null) {
      return json(res, { error: 'charName, animName, and frameIndex required' }, 400);
    }

    const lib = loadAnimLib();
    const anim = lib[animName];
    if (!anim) return json(res, { error: `Animation "${animName}" not found in library` }, 400);

    const fi = parseInt(frameIndex, 10);
    if (fi < 0 || fi >= anim.frameCount) return json(res, { error: 'frameIndex out of range' }, 400);

    // Resolve character angle reference
    let resolvedAnglePath = null;
    const tryIndices = [anim.angleIndex, 0, 1, 2, 3, 4, 5, 6, 7];
    for (const idx of tryIndices) {
      const p = path.join(ASSETS_DIR, `${charName}-angle-${idx}.png`);
      if (fs.existsSync(p)) { resolvedAnglePath = p; break; }
    }
    const portraitPath = path.join(ASSETS_DIR, `${charName}full.png`);
    if (!resolvedAnglePath && fs.existsSync(portraitPath)) resolvedAnglePath = portraitPath;
    if (!resolvedAnglePath) return json(res, { error: `No body angle or portrait found for "${charName}"` }, 400);

    try {
      const modelId = model || 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });

      const genDir = path.join(TMP_DIR, 'studio-gen', `${charName}-${animName}`);
      fs.mkdirSync(genDir, { recursive: true });

      // Write the specific pose frame from base64
      const posePath = path.join(genDir, `pose-regen-${fi}.png`);
      if (!anim.framesBase64 || !anim.framesBase64[fi]) {
        return json(res, { error: `Pose frame ${fi} not found in library` }, 400);
      }
      fs.writeFileSync(posePath, Buffer.from(anim.framesBase64[fi], 'base64'));

      // Determine prompt and image order based on mode
      let prompt;
      let referenceImages;

      if (identityFix) {
        // Identity Fix: pose frame (Image 1) + selected headshot (Image 2)
        const hsIdx = parseInt(identityFix.headshotIndex, 10);
        const headshotPath = path.join(ASSETS_DIR, `${charName}-headshot-${hsIdx}.png`);
        if (!fs.existsSync(headshotPath)) {
          return json(res, { error: `Headshot ${hsIdx} not found for "${charName}"` }, 400);
        }
        prompt = [
          'Keep the exact character from Image 1. Copy only the head from Image 2.',
          'Do not mix faces or identities. Make sure the character\'s face does not change at all.',
          'Do not change body shape, skin tone, hairstyle, or facial structure.',
          'Use Image 2\'s head completely while maintaining all other details from Image 1.',
          'The background is pure green (#00FF00).',
        ].join(' ');
        referenceImages = [posePath, headshotPath];
      } else if (customPrompt) {
        // Edit mode: keep character but apply user modification
        prompt = `Keep all details about the character exactly the same but: ${customPrompt}. The background is pure green (#00FF00).`;
        referenceImages = [posePath, resolvedAnglePath];
      } else {
        // Standard regen
        prompt = loadStudioPrompt();
        referenceImages = [posePath, resolvedAnglePath];
      }

      const result = await client.generate(prompt, {
        referenceImages,
        aspectRatio: '3:4',
        resolution: '1K',
        model: modelId,
        maxRetries: 1,
        timeoutMs: 70000,
      });

      const attemptNum = Date.now();
      const rawPath = path.join(genDir, `raw-regen-${fi}-${attemptNum}.png`);
      fs.writeFileSync(rawPath, result.imageBuffer);
      recordCost(modelId, 'studio_regen', '1K', 2, { charName, animName, frame: fi });

      const processedPath = path.join(genDir, `regen-${fi}-${attemptNum}.png`);
      await processFrame(rawPath, processedPath);

      // Update the frame in assets dir
      const framesOutDir = path.join(ASSETS_DIR, `${charName}-${animName}-frames`);
      fs.mkdirSync(framesOutDir, { recursive: true });
      const frameDest = path.join(framesOutDir, `frame-${fi}.png`);
      fs.copyFileSync(processedPath, frameDest);
      sbUpload(`${charName}-${animName}-frames/frame-${fi}.png`, frameDest);

      // Rebuild the sprite strip from all frames so Save picks up the changes
      const totalFrames = anim.frameCount;
      const allFramePaths = Array.from({ length: totalFrames }, (_, i) =>
        path.join(framesOutDir, `frame-${i}.png`)
      ).filter(p => fs.existsSync(p));
      if (allFramePaths.length > 0) {
        const stripPath = path.join(ASSETS_DIR, `${charName}-${animName}.png`);
        const charPixelHeight = loadCharPixelHeight(charName);
        await buildStrip(allFramePaths, stripPath, { pixelHeight: charPixelHeight });
        sbUpload(`${charName}-${animName}.png`, stripPath);
      }

      const processedUrl = `/assets/${charName}-${animName}-frames/frame-${fi}.png`;
      json(res, { success: true, processedUrl, processedPath });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
