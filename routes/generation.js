/**
 * Generation Routes — Strip + FBF + single-frame generation
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, ANGLE_NAMES, BALL_VARIANTS, buildPoseTransferPrompt, buildSingleFramePrompt, buildSectionedPrompt, getDefaultSections, buildFilmToSpritePrompt, buildFilmToSingleFramePrompt, buildAnglePrompt, buildBallRefPrompt } = require('../../sprite-generator/prompts');
const { processSprite, cutFrames, upscaleNN, buildStrip, processSingleFrame, normalizeFrameSizes } = require('../../sprite-processor/index');
const { buildRefStrip } = require('../../sprite-generator/strip-builder');
const { recordCost, getImageCost, loadCostData } = require('../middleware/cost-tracker');
const jobStore = require('../job-store');

function register(router, { ASSETS_DIR, RAW_DIR, runWithConcurrency, json, parseBody }) {

  // GET /api/prompt-sections?character=X&animation=Y&mode=fbf|strip
  router.get('/api/prompt-sections', (req, res, params, query) => {
    const character = query.character || '99';
    const animation = query.animation || 'static-dribble';
    const mode = query.mode || 'fbf';

    try {
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!CHARACTERS[character] && fs.existsSync(portraitPath)) {
        CHARACTERS[character] = {
          description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: '16-bit pixel art, GBA style',
        };
      }

      const anim = ANIMATIONS[animation];
      if (!anim) return json(res, { error: `Unknown animation: ${animation}` }, 400);

      const opts = mode === 'fbf' ? { frameIndex: 0, totalFrames: anim.frames } : {};
      const sections = getDefaultSections(character, animation, opts);
      return json(res, { sections, totalFrames: anim.frames, mode });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  });

  // GET /api/prompt-preview — Preview the full prompt text for any generation type
  // Query: type=strip|fbf|angle|ball|video|video-fbf&character=X&animation=Y&frameIndex=0&frameCount=6&action=...&angleIndex=0&variant=...
  router.get('/api/prompt-preview', (req, res, params, query) => {
    const { type, character, animation, frameIndex, frameCount, action, angleIndex, variant } = query;

    try {
      const charName = character || '99';
      // Ensure character exists
      const portraitPath = path.join(ASSETS_DIR, `${charName}full.png`);
      const hasPortrait = fs.existsSync(portraitPath);
      if (!CHARACTERS[charName] && hasPortrait) {
        CHARACTERS[charName] = {
          description: 'the character shown in Image 2',
          style: '16-bit pixel art, GBA style',
        };
      }

      let prompt = '';
      let references = [];
      let settings = {};

      switch (type) {
        case 'strip': {
          const anim = ANIMATIONS[animation];
          const data = buildPoseTransferPrompt(charName, animation);
          prompt = data.prompt;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          if (anim?.breezyFile) references.push({ type: 'pose-reference', path: anim.breezyFile });
          settings = { mode: 'strip', totalFrames: anim?.frames || 6, resolution: '2K', aspectRatio: '16:9' };
          break;
        }
        case 'fbf': {
          const anim = ANIMATIONS[animation];
          const totalFrames = anim?.frames || 6;
          const fi = parseInt(frameIndex) || 0;
          const data = buildSingleFramePrompt(charName, animation, fi, totalFrames);
          prompt = data.prompt;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          if (anim?.breezyFile) references.push({ type: 'pose-reference', path: anim.breezyFile, note: `frame ${fi}/${totalFrames}, upscaled to 512x512` });
          settings = { mode: 'fbf', frameIndex: fi, totalFrames, resolution: '1K', aspectRatio: '1:1' };
          break;
        }
        case 'angle': {
          const ai = parseInt(angleIndex) || 0;
          const angleName = ANGLE_NAMES[ai] || 'front';
          const data = buildAnglePrompt(charName, angleName, ai, 8);
          prompt = data.prompt || data;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          settings = { mode: 'angle', angleName, angleIndex: ai, totalAngles: 8 };
          break;
        }
        case 'ball': {
          const v = variant || (BALL_VARIANTS && BALL_VARIANTS[0]) || 'right-hand-low';
          const vi = parseInt(angleIndex) || 0;
          const data = buildBallRefPrompt(charName, v, vi);
          prompt = data.prompt || data;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          settings = { mode: 'ball', variant: v, variantIndex: vi };
          break;
        }
        case 'video': {
          const count = parseInt(frameCount) || 6;
          const desc = action || animation || 'custom move';
          const data = buildFilmToSpritePrompt(charName, desc, count);
          prompt = data.prompt;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          references.push({ type: 'video-strip', note: 'Reference strip built from selected video frames' });
          settings = { mode: 'video-strip', frameCount: count, resolution: '2K', aspectRatio: count >= 6 ? '21:9' : '16:9' };
          break;
        }
        case 'video-fbf': {
          const total = parseInt(frameCount) || 6;
          const fi2 = parseInt(frameIndex) || 0;
          const desc2 = action || animation || 'custom move';
          const data = buildFilmToSingleFramePrompt(charName, desc2, fi2, total);
          prompt = data.prompt;
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          references.push({ type: 'video-frame', note: `Selected video frame ${fi2 + 1}/${total} as pose reference` });
          settings = { mode: 'video-fbf', frameIndex: fi2, totalFrames: total, resolution: '1K', aspectRatio: '1:1' };
          break;
        }
        default:
          return json(res, { error: `Unknown type: ${type}. Use: strip, fbf, angle, ball, video, video-fbf` }, 400);
      }

      return json(res, { prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt), references, settings });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  });

  // POST /api/generate — Generate a single sprite (with batch support for 5+ frames)
  router.post('/api/generate', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, model, customPrompt } = body;

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!CHARACTERS[character] && fs.existsSync(portraitPath)) {
        CHARACTERS[character] = {
          description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: '16-bit pixel art, GBA style',
        };
      }

      const anim = ANIMATIONS[animation];
      const totalFrames = anim?.frames || 6;
      const charRef = fs.existsSync(portraitPath) ? portraitPath : null;
      const poseRef = anim?.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;

      fs.mkdirSync(RAW_DIR, { recursive: true });

      const job = jobStore.createJob({ character, animation, mode: 'strip', model: modelId, totalFrames });

      const MAX_FRAMES_PER_BATCH = 4;

      if (totalFrames <= MAX_FRAMES_PER_BATCH || !poseRef) {
        let prompt;
        if (customPrompt) {
          prompt = customPrompt;
        } else {
          const data = buildPoseTransferPrompt(character, animation);
          prompt = data.prompt;
        }

        const outputPath = path.join(RAW_DIR, `${character}-${animation}-raw.png`);
        await client.generateSprite(prompt, poseRef, charRef, {
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          outputPath,
        });

        const costInfo = recordCost(modelId, 'strip', '2K', (poseRef ? 1 : 0) + (charRef ? 1 : 0), { character, animation });

        const processed = await processSprite(outputPath, `${character}-${animation}`, {
          frameCount: totalFrames,
          targetSize: 180,
          outputDir: ASSETS_DIR,
        });

        jobStore.updateJob(job.id, {
          status: 'complete',
          stripPath: path.join(ASSETS_DIR, `${character}-${animation}.png`),
          totalCost: costInfo.totalCost,
          completedFrames: processed.frameCount,
          completedAt: new Date().toISOString(),
        });

        return json(res, {
          success: true,
          jobId: job.id,
          raw: `/raw/${character}-${animation}-raw.png`,
          processed: `/assets/${character}-${animation}.png`,
          frames: processed.frameCount,
          batched: false,
          cost: costInfo,
        });
      }

      // BATCH MODE
      const refFramesDir = path.join(RAW_DIR, `${character}-${animation}-ref-frames`);
      fs.mkdirSync(refFramesDir, { recursive: true });
      const cutResult = await cutFrames(poseRef, refFramesDir, { frameCount: totalFrames });
      const refFramePaths = cutResult.frames;

      const batches = [];
      for (let i = 0; i < totalFrames; i += MAX_FRAMES_PER_BATCH) {
        const end = Math.min(i + MAX_FRAMES_PER_BATCH, totalFrames);
        batches.push({ start: i, end, count: end - i, frames: refFramePaths.slice(i, end) });
      }

      const batchOutputs = [];
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const miniStripPath = path.join(RAW_DIR, `${character}-${animation}-batch${b}-ref.png`);
        await buildRefStrip(batch.frames, miniStripPath, { targetHeight: 180 });

        const batchPrompt = [
          `REPLICATE Image 1 EXACTLY. Keep every body position, pose, limb placement, and composition identical. ONLY replace the character's identity with Image 2.`,
          ``,
          `Image 1 shows ${batch.count} frames of a ${anim.action} animation (frames ${batch.start + 1}-${batch.end} of ${totalFrames}).`,
          `Copy these ${batch.count} frames frame-for-frame — same poses, same spacing — but with Image 2's character.`,
          ``,
          `CRITICAL — BODY POSITION:`,
          `- Body position, pose, and composition in EVERY frame must match Image 1 EXACTLY`,
          `- Same arm positions, leg positions, body angle, ball placement`,
          `- Treat Image 1 as motion capture — do NOT reinterpret`,
          ``,
          `OUTPUT:`,
          `- Single horizontal strip, EXACTLY ${batch.count} frames, equally-sized, no gaps, no borders`,
          `- LARGE detailed characters filling most of each frame's height — NOT tiny`,
          `- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around character`,
          `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
          `- NO green on the character itself`,
          `- Same character size in every frame, feet on same baseline`,
        ].join('\n');

        const batchOutputPath = path.join(RAW_DIR, `${character}-${animation}-batch${b}-raw.png`);
        await client.generateSprite(batchPrompt, miniStripPath, charRef, {
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          outputPath: batchOutputPath,
        });

        recordCost(modelId, 'strip_batch', '2K', (charRef ? 2 : 1), { character, animation, batch: b });

        const batchProcessed = await processSprite(batchOutputPath, `${character}-${animation}-batch${b}`, {
          frameCount: batch.count,
          targetSize: 180,
          outputDir: RAW_DIR,
        });

        batchOutputs.push(batchProcessed);
      }

      const allFramePaths = [];
      for (let b = 0; b < batchOutputs.length; b++) {
        const framesDir = batchOutputs[b].framesDir;
        if (fs.existsSync(framesDir)) {
          const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
          frameFiles.forEach(f => allFramePaths.push(path.join(framesDir, f)));
        }
      }

      const finalStripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      await buildRefStrip(allFramePaths, finalStripPath, { targetHeight: 180 });

      const costData = loadCostData();
      jobStore.updateJob(job.id, {
        status: 'complete',
        stripPath: finalStripPath,
        completedFrames: allFramePaths.length,
        completedAt: new Date().toISOString(),
      });

      return json(res, {
        success: true,
        jobId: job.id,
        processed: `/assets/${character}-${animation}.png`,
        frames: allFramePaths.length,
        batched: true,
        batchCount: batches.length,
        batchSizes: batches.map(b => b.count),
        cost: { totalCost: batches.length * getImageCost(modelId, '2K'), runningTotal: costData.totalSpend },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/generate-fbf — Frame-by-frame generation with SSE progress
  router.post('/api/generate-fbf', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, model, customSections } = body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    function sse(data) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const anim = ANIMATIONS[animation];
      if (!anim) throw new Error(`Unknown animation: ${animation}`);
      if (!anim.breezyFile) throw new Error(`No Breezy reference for ${animation}`);

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found: ${character}full.png`);

      const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
      if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found: ${anim.breezyFile}`);

      const totalFrames = anim.frames;
      fs.mkdirSync(RAW_DIR, { recursive: true });

      const fbfDir = path.join(RAW_DIR, `${character}-${animation}-fbf`);
      fs.mkdirSync(fbfDir, { recursive: true });

      const job = jobStore.createJob({
        character, animation, mode: 'fbf', model: modelId, totalFrames,
        promptSections: customSections || null,
      });

      sse({ type: 'start', animation, character, totalFrames, jobId: job.id });

      // Cut Breezy reference strip into individual frames
      const refFramesDir = path.join(fbfDir, 'ref-frames');
      fs.mkdirSync(refFramesDir, { recursive: true });
      const cutResult = await cutFrames(poseRefPath, refFramesDir);
      const refFramePaths = cutResult.frames.slice(0, totalFrames);

      // Upscale each frame to 512x512
      const upscaledDir = path.join(fbfDir, 'upscaled');
      fs.mkdirSync(upscaledDir, { recursive: true });
      const upscaledPaths = [];
      for (let i = 0; i < refFramePaths.length; i++) {
        const upPath = path.join(upscaledDir, `frame-${String(i).padStart(3, '0')}.png`);
        await upscaleNN(refFramePaths[i], upPath, { width: 512, height: 512 });
        upscaledPaths.push(upPath);
      }

      sse({ type: 'prep_done', framesReady: upscaledPaths.length });

      const isPro = modelId.includes('pro');
      const concurrency = isPro ? 1 : 2;
      const interFrameDelay = isPro ? 15000 : 2000;
      const maxRetries = isPro ? 5 : 3;
      const retryBaseDelay = isPro ? 20000 : 5000;

      const rawOutputPaths = [];

      const tasks = upscaledPaths.map((upPath, i) => async () => {
        sse({ type: 'frame_start', frame: i, total: totalFrames });

        let prompt;
        if (customSections) {
          prompt = buildSectionedPrompt(character, animation, {
            frameIndex: i,
            totalFrames,
            customSections,
          });
        } else {
          const promptData = buildSingleFramePrompt(character, animation, i, totalFrames);
          prompt = promptData.prompt;
        }

        const outPath = path.join(fbfDir, `raw-frame-${String(i).padStart(3, '0')}.png`);

        let lastErr;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            await client.generateSingleFrame(prompt, upPath, portraitPath, {
              model: modelId,
              outputPath: outPath,
            });
            rawOutputPaths[i] = outPath;
            const frameCost = recordCost(modelId, 'fbf_frame', '1K', 2, { character, animation, frame: i });
            jobStore.recordAttempt(job.id, i, { rawPath: outPath, promptText: prompt });
            sse({ type: 'frame_done', frame: i, rawUrl: `/fbf-working/${character}-${animation}-fbf/raw-frame-${String(i).padStart(3, '0')}.png`, cost: frameCost });
            return;
          } catch (err) {
            lastErr = err;
            if (attempt < maxRetries - 1) {
              const wait = retryBaseDelay * Math.pow(1.5, attempt) + Math.random() * 3000;
              sse({ type: 'frame_retry', frame: i, error: err.message, attempt: attempt + 1, maxRetries, waitSec: Math.round(wait / 1000) });
              await new Promise(r => setTimeout(r, wait));
            }
          }
        }
        sse({ type: 'frame_error', frame: i, error: lastErr?.message });
      });

      await runWithConcurrency(tasks, concurrency, interFrameDelay);

      // Process all raw frames
      const processedDir = path.join(fbfDir, 'processed');
      fs.mkdirSync(processedDir, { recursive: true });
      const processedPaths = [];

      for (let i = 0; i < totalFrames; i++) {
        const rawPath = rawOutputPaths[i];
        if (!rawPath || !fs.existsSync(rawPath)) {
          sse({ type: 'process_skip', frame: i });
          continue;
        }

        const processedPath = path.join(processedDir, `frame-${String(i).padStart(3, '0')}.png`);
        await processSingleFrame(rawPath, processedPath, { width: 180, height: 180 });
        processedPaths.push(processedPath);
        sse({ type: 'frame_processed', frame: i, processedUrl: `/fbf-working/${character}-${animation}-fbf/processed/frame-${String(i).padStart(3, '0')}.png` });
      }

      // Normalize frame sizes
      if (processedPaths.length > 1) {
        await normalizeFrameSizes(processedPaths, { targetWidth: 180, targetHeight: 180 });
        sse({ type: 'normalized', frames: processedPaths.length });
      }

      // Assemble horizontal strip
      const stripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      await buildStrip(processedPaths, stripPath, { frameWidth: 180, frameHeight: 180 });

      // Save individual frames
      const framesOutDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
      fs.mkdirSync(framesOutDir, { recursive: true });
      processedPaths.forEach((p, i) => {
        fs.copyFileSync(p, path.join(framesOutDir, `frame-${i}.png`));
      });

      const finalCostData = loadCostData();

      jobStore.updateJob(job.id, {
        status: 'complete',
        stripPath,
        completedFrames: processedPaths.length,
        processedPaths: processedPaths.map(p => path.basename(p)),
        completedAt: new Date().toISOString(),
      });

      sse({
        type: 'complete',
        jobId: job.id,
        url: `/assets/${character}-${animation}.png`,
        frames: processedPaths.length,
        totalFrames,
        failed: totalFrames - processedPaths.length,
        cost: { totalCost: processedPaths.length * getImageCost(modelId, '1K'), runningTotal: finalCostData.totalSpend },
      });
    } catch (err) {
      sse({ type: 'error', message: err.message });
    }

    res.end();
  });

  // POST /api/generate-frame — Single frame regeneration (for cherry-picking)
  router.post('/api/generate-frame', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, frameIndex, model, customSections, jobId } = body;

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const anim = ANIMATIONS[animation];
      if (!anim) throw new Error(`Unknown animation: ${animation}`);

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found`);

      const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
      if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found`);

      const totalFrames = anim.frames;

      // Cut and upscale the specific reference frame
      const fbfDir = path.join(RAW_DIR, `${character}-${animation}-fbf`);
      fs.mkdirSync(fbfDir, { recursive: true });

      const refFramesDir = path.join(fbfDir, 'ref-frames');
      if (!fs.existsSync(refFramesDir) || fs.readdirSync(refFramesDir).length === 0) {
        fs.mkdirSync(refFramesDir, { recursive: true });
        await cutFrames(poseRefPath, refFramesDir);
      }

      const refFrames = fs.readdirSync(refFramesDir).filter(f => f.endsWith('.png')).sort();
      const refFramePath = path.join(refFramesDir, refFrames[frameIndex]);

      const upscaledDir = path.join(fbfDir, 'upscaled');
      fs.mkdirSync(upscaledDir, { recursive: true });
      const upPath = path.join(upscaledDir, `frame-${String(frameIndex).padStart(3, '0')}.png`);
      await upscaleNN(refFramePath, upPath, { width: 512, height: 512 });

      // Build prompt
      let prompt;
      if (customSections) {
        prompt = buildSectionedPrompt(character, animation, {
          frameIndex,
          totalFrames,
          customSections,
        });
      } else {
        const promptData = buildSingleFramePrompt(character, animation, frameIndex, totalFrames);
        prompt = promptData.prompt;
      }

      // Generate
      const attemptNum = Date.now();
      const outPath = path.join(fbfDir, `raw-frame-${String(frameIndex).padStart(3, '0')}-attempt-${attemptNum}.png`);

      await client.generateSingleFrame(prompt, upPath, portraitPath, {
        model: modelId,
        outputPath: outPath,
      });

      const costInfo = recordCost(modelId, 'fbf_frame', '1K', 2, { character, animation, frame: frameIndex });

      // Process the frame
      const processedPath = path.join(fbfDir, `processed-frame-${String(frameIndex).padStart(3, '0')}-attempt-${attemptNum}.png`);
      await processSingleFrame(outPath, processedPath, { width: 180, height: 180 });

      // Record attempt
      if (jobId) {
        jobStore.recordAttempt(jobId, frameIndex, {
          rawPath: outPath,
          processedPath,
          promptText: prompt,
        });
      }

      return json(res, {
        success: true,
        frameIndex,
        rawUrl: `/fbf-working/${character}-${animation}-fbf/${path.basename(outPath)}`,
        processedUrl: `/fbf-working/${character}-${animation}-fbf/${path.basename(processedPath)}`,
        processedPath,
        cost: costInfo,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/cherry-pick — Replace a frame in the current strip with a specific attempt
  router.post('/api/cherry-pick', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, frameIndex, processedPath } = body;

    try {
      if (!processedPath || !fs.existsSync(processedPath)) {
        return json(res, { error: 'Processed frame not found' }, 400);
      }

      // Copy the selected frame into the frames directory
      const framesDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
      fs.mkdirSync(framesDir, { recursive: true });
      const targetPath = path.join(framesDir, `frame-${frameIndex}.png`);
      fs.copyFileSync(processedPath, targetPath);

      // Rebuild the strip from all frames
      const allFrames = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.png'))
        .sort()
        .map(f => path.join(framesDir, f));

      const stripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      await buildStrip(allFrames, stripPath, { frameWidth: 180, frameHeight: 180 });

      return json(res, {
        success: true,
        frameIndex,
        stripUrl: `/assets/${character}-${animation}.png`,
        frames: allFrames.length,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/jobs — List generation jobs
  router.get('/api/jobs', (req, res, params, query) => {
    const filter = {};
    if (query.character) filter.character = query.character;
    if (query.animation) filter.animation = query.animation;
    if (query.status) filter.status = query.status;
    const jobs = jobStore.listJobs(filter);
    return json(res, { jobs });
  });

  // GET /api/jobs/:id — Get a specific job
  router.get('/api/jobs/:id', (req, res, params) => {
    const job = jobStore.getJob(params.id);
    if (!job) return json(res, { error: 'Job not found' }, 404);
    return json(res, { job });
  });

  // GET /api/jobs/:id/attempts/:frame — Get all attempts for a frame
  router.get('/api/jobs/:id/attempts/:frame', (req, res, params) => {
    const attempts = jobStore.getFrameAttempts(params.id, parseInt(params.frame));
    return json(res, { attempts });
  });
}

module.exports = { register };
