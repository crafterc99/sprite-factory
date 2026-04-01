/**
 * Generation Routes — Strip + FBF + single-frame generation
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, ANGLE_NAMES, BALL_VARIANTS, buildPoseTransferPrompt, buildTextOnlyAnimPrompt, buildSingleFramePrompt, buildSectionedPrompt, getDefaultSections, buildFilmToSpritePrompt, buildFilmToSingleFramePrompt, buildAnglePrompt, buildHeadshotAnglePrompt, buildClothesAnglePrompt, buildBallRefPrompt, getActiveSections, getActivePrompt } = require('../lib/sprite-generator/prompts');
const { processSprite, cutFrames, upscaleNN, buildStrip, processSingleFrame, normalizeFrameSizes } = require('../lib/sprite-processor/index');
const { buildRefStrip } = require('../lib/sprite-generator/strip-builder');
const { recordCost, getImageCost, loadCostData } = require('../middleware/cost-tracker');
const jobStore = require('../job-store');

const FRAME_PROMPTS_PATH = path.join(__dirname, '../data/frame-prompts.json');

// Module-level store for bulk animation jobs. Keyed by bulkJobId (UUID).
// Each value: { bulkJobId, animation, model, createdAt, jobs: [...] }
// Each job: { jobId, character, animation, status: 'pending'|'running'|'done'|'failed', error? }
const bulkJobs = new Map();

// Run an array of async task functions with a concurrency limit.
// Each task is a zero-argument function that returns a Promise.
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then(r => { executing.splice(executing.indexOf(p), 1); return r; });
    executing.push(p);
    results.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

function loadFramePrompts() {
  try {
    if (!fs.existsSync(FRAME_PROMPTS_PATH)) {
      return { _comment: 'Per-frame prompt overrides. Keyed by character.animationName.frameIndex.', overrides: {} };
    }
    return JSON.parse(fs.readFileSync(FRAME_PROMPTS_PATH, 'utf8'));
  } catch (err) {
    return { overrides: {} };
  }
}

function saveFramePrompts(data) {
  fs.writeFileSync(FRAME_PROMPTS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

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
          prompt = getActivePrompt('angle', angleName, buildAnglePrompt, charName, angleName, ai, 8);
          if (hasPortrait) references.push({ type: 'portrait', path: `${charName}full.png` });
          settings = { mode: 'angle', angleName, angleIndex: ai, totalAngles: 8 };
          break;
        }
        case 'ball': {
          const v = variant || (BALL_VARIANTS && BALL_VARIANTS[0]) || 'right-hand-low';
          const vi = parseInt(angleIndex) || 0;
          prompt = getActivePrompt('ball', v, buildBallRefPrompt, charName, v, vi);
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

  // POST /api/generate — REMOVED: strip mode eliminated. Use /api/studio/generate (FBF).
  router.post('/api/generate', async (req, res) => {
    return json(res, { error: 'Strip mode removed. Use POST /api/studio/generate for frame-by-frame generation.' }, 410);
  });

  // POST /api/generate-LEGACY — kept for reference only, not registered
  async function _legacyStripGenerate(req, res) {
    const body = await parseBody(req);
    const { character, animation, model, customPrompt } = body;

    try {
      const modelId = model || 'gemini-3-pro-image-preview';
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
        } else if (poseRef) {
          // Pose transfer mode: Image 1 = pose strip, Image 2 = character portrait
          const data = buildPoseTransferPrompt(character, animation);
          prompt = data.prompt;
        } else {
          // Text-only mode: Image 1 = character portrait (identity anchor), no pose reference
          const data = buildTextOnlyAnimPrompt(character, animation);
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

        // Persist customPrompt as the base prompt for frame 0 so it is visible in the prompt editor
        if (customPrompt) {
          const store = loadFramePrompts();
          const key = `${character}.${animation}.0`;
          store.overrides[key] = { prompt: customPrompt, updatedAt: new Date().toISOString() };
          saveFramePrompts(store);
        }

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

        const batchPrompt = customPrompt || [
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
      await buildRefStrip(allFramePaths, finalStripPath, { height: 180 });

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
  }

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
      const modelId = model || 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });

      const anim = ANIMATIONS[animation];
      if (!anim) throw new Error(`Unknown animation: ${animation}`);
      if (!anim.breezyFile) throw new Error(`No Breezy reference for ${animation}`);

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found: ${character}full.png`);

      const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
      if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found: ${anim.breezyFile}`);

      // Resolve the body angle frame that best matches this animation's viewing direction
      const angleIndex = anim.angleIndex ?? 0;
      const angleFramePath = path.join(ASSETS_DIR, `${character}-angle-${angleIndex}.png`);
      const charRef = fs.existsSync(angleFramePath) ? angleFramePath : portraitPath;

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

      
      const concurrency = 1;
      const interFrameDelay = 15000;
      const maxRetries = 5;
      const retryBaseDelay = 20000;

      const rawOutputPaths = [];

      const tasks = upscaledPaths.map((upPath, i) => async () => {
        sse({ type: 'frame_start', frame: i, total: totalFrames });

        // Frame 0 is the style anchor — pass it to frames 1+ for rendering consistency
        const styleAnchorPath = i > 0 ? rawOutputPaths[0] : null;

        let prompt;
        if (customSections) {
          prompt = buildSectionedPrompt(character, animation, {
            frameIndex: i,
            totalFrames,
            customSections,
          });
        } else {
          // Use saved overrides if available, otherwise fall back to default
          const active = getActiveSections(character, animation, { frameIndex: i, totalFrames });
          const hasOverrides = Object.values(active).some(s => s.isCustom);
          if (hasOverrides) {
            const merged = {};
            for (const [k, v] of Object.entries(active)) merged[k] = { enabled: true, text: v.text };
            prompt = buildSectionedPrompt(character, animation, { frameIndex: i, totalFrames, customSections: merged });
          } else {
            const promptData = buildSingleFramePrompt(character, animation, i, totalFrames, { hasStyleAnchor: !!styleAnchorPath });
            prompt = promptData.prompt;
          }
        }

        const outPath = path.join(fbfDir, `raw-frame-${String(i).padStart(3, '0')}.png`);

        let lastErr;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            await client.generateSingleFrame(prompt, upPath, charRef, {
              model: modelId,
              outputPath: outPath,
              styleAnchorPath,
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
      const modelId = model || 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });

      const anim = ANIMATIONS[animation];
      if (!anim) throw new Error(`Unknown animation: ${animation}`);

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found`);

      const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
      if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found`);

      // Resolve angle frame for identity anchor (Image 1)
      const angleIndex = anim.angleIndex ?? 0;
      const angleFramePath = path.join(ASSETS_DIR, `${character}-angle-${angleIndex}.png`);
      const charRef = fs.existsSync(angleFramePath) ? angleFramePath : portraitPath;

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
        const active = getActiveSections(character, animation, { frameIndex, totalFrames });
        const hasOverrides = Object.values(active).some(s => s.isCustom);
        if (hasOverrides) {
          const merged = {};
          for (const [k, v] of Object.entries(active)) merged[k] = { enabled: true, text: v.text };
          prompt = buildSectionedPrompt(character, animation, { frameIndex, totalFrames, customSections: merged });
        } else {
          const promptData = buildSingleFramePrompt(character, animation, frameIndex, totalFrames);
          prompt = promptData.prompt;
        }
      }

      // Generate
      const attemptNum = Date.now();
      const outPath = path.join(fbfDir, `raw-frame-${String(frameIndex).padStart(3, '0')}-attempt-${attemptNum}.png`);

      await client.generateSingleFrame(prompt, upPath, charRef, {
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

  // POST /api/generate/angles — generate all 8 angle reference sprites for a character
  router.post('/api/generate/angles', async (req, res) => {
    const body = await parseBody(req);
    const { character, angleIndex } = body; // angleIndex optional: if provided, generate only that angle (0-7)
    if (!character) return json(res, { error: 'character required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: `Portrait not found: ${character}full.png` }, 400);

    const modelId = body.model && ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'].includes(body.model)
      ? body.model
      : 'gemini-2.5-flash-image';
    const client = new NanaBananaClient({ model: modelId });

    const indices = angleIndex != null ? [parseInt(angleIndex)] : [0, 1, 2, 3, 4, 5, 6, 7];
    const results = [];

    for (const ai of indices) {
      const angleName = ANGLE_NAMES[ai];
      if (!angleName) { results.push({ angleIndex: ai, error: 'invalid angle index' }); continue; }
      try {
        const prompt = getActivePrompt('angle', angleName, buildAnglePrompt, character, angleName, ai, 8);
        const outputPath = path.join(ASSETS_DIR, `${character}-angle-${ai}.png`);
        await client.generateSprite(prompt, null, portraitPath, {
          aspectRatio: '3:4',
          resolution: '2K',
          model: modelId,
          outputPath,
        });
        recordCost(modelId, 'angle', '2K', 1, { character, angleName });
        results.push({ angleIndex: ai, angleName, url: `/assets/${character}-angle-${ai}.png`, status: 'done' });
      } catch (err) {
        results.push({ angleIndex: ai, angleName, error: err.message, status: 'failed' });
      }
    }

    const done = results.filter(r => r.status === 'done');
    const failed = results.filter(r => r.status === 'failed');

    // After a full 8-angle body generation, check if auto-pipeline should fire
    if (angleIndex == null && done.length === 8) {
      try {
        const { loadCharacters } = require('./characters');
        const chars = loadCharacters();
        const char = chars[character];
        if (char &&
            char.anchor && char.anchor.status === 'complete' &&
            char.headshotAnglesComplete === true &&
            char.clothesAnglesComplete === true) {
          console.log(`[auto-pipeline] All assets ready for ${character} — starting pipeline`);
          const { runAutoPipeline } = require('../lib/auto-pipeline');
          runAutoPipeline(character).catch(err =>
            console.error(`[auto-pipeline] Pipeline failed for ${character}:`, err.message)
          );
        }
      } catch (err) {
        // Non-fatal — log and continue so the angle response is not affected
        console.error('[auto-pipeline] Pre-check error:', err.message);
      }
    }

    return json(res, { success: failed.length === 0, character, generated: done, failed });
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

  // POST /api/angle/regenerate — alias for /api/generate/angles with richer response shape
  // Accepts { character, angleIndex? } and reruns the targeted angle(s).
  // Delegates to the same generation logic as POST /api/generate/angles to avoid duplication.
  router.post('/api/angle/regenerate', async (req, res) => {
    const body = await parseBody(req);
    const { character, angleIndex, type } = body;
    if (!character) return json(res, { error: 'character required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: `Portrait not found: ${character}full.png` }, 400);

    const modelId = body.model && ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'].includes(body.model)
      ? body.model
      : 'gemini-2.5-flash-image';
    const client = new NanaBananaClient({ model: modelId });

    const indices = angleIndex != null ? [parseInt(angleIndex)] : [0, 1, 2, 3, 4, 5, 6, 7];
    const results = [];

    for (const ai of indices) {
      const angleName = ANGLE_NAMES[ai];
      if (!angleName) { results.push({ angleIndex: ai, error: 'invalid angle index' }); continue; }
      try {
        let prompt, outputFilename;
        if (type === 'headshot') {
          prompt = getActivePrompt('headshot', angleName, buildHeadshotAnglePrompt, character, angleName, ai, 8);
          outputFilename = `${character}-headshot-${ai}.png`;
        } else if (type === 'clothes') {
          prompt = getActivePrompt('clothes', angleName, buildClothesAnglePrompt, character, angleName, ai, 8);
          outputFilename = `${character}-clothes-${ai}.png`;
        } else {
          prompt = getActivePrompt('angle', angleName, buildAnglePrompt, character, angleName, ai, 8);
          outputFilename = `${character}-angle-${ai}.png`;
        }
        const outputPath = path.join(ASSETS_DIR, outputFilename);
        await client.generateSprite(prompt, null, portraitPath, {
          aspectRatio: '3:4',
          resolution: '2K',
          model: modelId,
          outputPath,
        });
        recordCost(modelId, 'angle', '2K', 1, { character, angleName });
        results.push({ angleIndex: ai, angleName, url: `/assets/${outputFilename}`, status: 'done' });
      } catch (err) {
        results.push({ angleIndex: ai, angleName, error: err.message, status: 'failed' });
      }
    }

    const done = results.filter(r => r.status === 'done');
    const failed = results.filter(r => r.status === 'failed');
    return json(res, {
      success: failed.length === 0,
      character,
      type: type || 'body',
      mode: angleIndex != null ? 'single' : 'full_set',
      generated: done,
      failed,
    });
  });

  // GET /api/frame-prompts/:character/:animName
  // Returns the framePrompts array for an animation, merging contract base prompts with disk overrides.
  router.get('/api/frame-prompts/:character/:animName', (req, res, params) => {
    const { character, animName } = params;
    try {
      const anim = ANIMATIONS[animName];
      const totalFrames = anim ? anim.frames : 0;

      // Build base array from contract framePrompts (if present) or empty strings
      const contractPrompts = (anim && Array.isArray(anim.framePrompts)) ? anim.framePrompts : [];
      const base = [];
      for (let i = 0; i < totalFrames; i++) {
        base.push(contractPrompts[i] || '');
      }

      // Merge overrides from frame-prompts.json
      const store = loadFramePrompts();
      const merged = base.map((bp, i) => {
        const key = `${character}.${animName}.${i}`;
        const override = store.overrides[key];
        return {
          frameIndex: i,
          prompt: override ? override.prompt : bp,
          hasOverride: !!override,
          updatedAt: override ? override.updatedAt : null,
        };
      });

      return json(res, { character, animName, totalFrames, frames: merged });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/frame-prompts/:character/:animName/:frameIndex
  // Saves a prompt override for a specific frame. Body: { prompt: "..." }
  router.post('/api/frame-prompts/:character/:animName/:frameIndex', async (req, res, params) => {
    const { character, animName, frameIndex } = params;
    const fi = parseInt(frameIndex, 10);
    if (isNaN(fi) || fi < 0) return json(res, { error: 'Invalid frameIndex' }, 400);

    try {
      const body = await parseBody(req);
      const { prompt } = body;
      if (typeof prompt !== 'string') return json(res, { error: 'prompt (string) required in body' }, 400);

      const store = loadFramePrompts();
      const key = `${character}.${animName}.${fi}`;
      store.overrides[key] = { prompt, updatedAt: new Date().toISOString() };
      saveFramePrompts(store);

      return json(res, { success: true, key, prompt, updatedAt: store.overrides[key].updatedAt });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/frame-prompts/:character/:animName/:frameIndex/rerun
  // Regenerates a single frame using the stored override prompt (or contract base prompt),
  // then splices the result back into the existing strip at data/assets/{character}-{animName}.png.
  // Body (optional): { model: "gemini-..." }
  router.post('/api/frame-prompts/:character/:animName/:frameIndex/rerun', async (req, res, params) => {
    const sharp = require('sharp');
    const { character, animName, frameIndex } = params;
    const fi = parseInt(frameIndex, 10);
    if (isNaN(fi) || fi < 0) return json(res, { error: 'Invalid frameIndex' }, 400);

    try {
      const body = await parseBody(req);
      const modelId = body.model || 'gemini-3-pro-image-preview';

      // 1. Resolve prompt: override > contract base > generated default
      const store = loadFramePrompts();
      const key = `${character}.${animName}.${fi}`;
      const override = store.overrides[key];
      let prompt;
      if (override && override.prompt) {
        prompt = override.prompt;
      } else {
        const anim = ANIMATIONS[animName];
        if (anim && anim.prompt) {
          prompt = anim.prompt;
        } else if (anim) {
          prompt = `${anim.action || animName} — frame ${fi + 1}`;
        } else {
          prompt = `${animName} animation — frame ${fi + 1}`;
        }
      }

      // 2. Load character portrait + angle ref
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) {
        return json(res, { error: `Portrait not found: ${portraitPath}` }, 404);
      }
      const rerunAnim = ANIMATIONS[animName];
      const rerunAngleIndex = rerunAnim?.angleIndex ?? 0;
      const rerunAnglePath = path.join(ASSETS_DIR, `${character}-angle-${rerunAngleIndex}.png`);
      const rerunCharRef = fs.existsSync(rerunAnglePath) ? rerunAnglePath : portraitPath;

      // 3. Generate the new frame to a temp path
      const tmpPath = `/tmp/${character}-${animName}-frame${fi}-override.png`;
      const client = new NanaBananaClient({ model: modelId });
      await client.generateSingleFrame(prompt, null, rerunCharRef, {
        outputPath: tmpPath,
        aspectRatio: '1:1',
        resolution: '1K',
        model: modelId,
      });

      // 4. Process the new frame to 180x180
      const { processSingleFrame } = require('../lib/sprite-processor/index');
      const processedTmpPath = `/tmp/${character}-${animName}-frame${fi}-override-proc.png`;
      await processSingleFrame(tmpPath, processedTmpPath, { width: 180, height: 180 });

      // 5. Splice the processed frame into the existing strip
      const stripPath = path.join(ASSETS_DIR, `${character}-${animName}.png`);
      if (!fs.existsSync(stripPath)) {
        return json(res, { error: `Strip not found: ${stripPath}` }, 404);
      }

      const stripMeta = await sharp(stripPath).metadata();
      const stripWidth = stripMeta.width;
      const stripHeight = stripMeta.height;

      const newFrameBuf = await sharp(processedTmpPath)
        .resize(180, 180, { fit: 'fill' })
        .toBuffer();

      await sharp(stripPath)
        .composite([{
          input: newFrameBuf,
          left: fi * 180,
          top: 0,
        }])
        .resize(stripWidth, stripHeight, { fit: 'fill', kernel: 'nearest' })
        .toFile(stripPath + '.tmp.png');

      fs.renameSync(stripPath + '.tmp.png', stripPath);

      // Clean up temp files
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(processedTmpPath); } catch (_) {}

      return json(res, {
        success: true,
        frameIndex: fi,
        outputPath: `data/assets/${character}-${animName}.png`,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/animation/apply-bulk
  // Body: { characters: [...], animation: "dribble", model?: "gemini-2.5-flash-image" }
  // Creates a pending job per character, returns immediately with { bulkJobId, jobs },
  // then runs generation for each character in series (TASK-6003 adds parallelism).
  router.post('/api/animation/apply-bulk', async (req, res) => {
    const body = await parseBody(req);
    const { characters, animation, model, concurrency: concurrencyRaw } = body;

    if (!Array.isArray(characters) || characters.length === 0) {
      return json(res, { error: 'characters must be a non-empty array' }, 400);
    }
    if (!animation) {
      return json(res, { error: 'animation is required' }, 400);
    }

    const bulkJobId = crypto.randomUUID();
    const modelId = model || 'gemini-3-pro-image-preview';
    const concurrency = Math.min(Math.max(Number(concurrencyRaw) || 3, 1), 5);

    const jobs = characters.map(character => ({
      jobId: crypto.randomUUID(),
      character,
      animation,
      status: 'pending',
    }));

    bulkJobs.set(bulkJobId, {
      bulkJobId,
      animation,
      model: modelId,
      concurrency,
      createdAt: new Date().toISOString(),
      jobs,
    });

    // Respond immediately before kicking off generation
    json(res, { bulkJobId, jobs });

    // FBF: generate each character frame-by-frame with concurrency limit
    const { generateAnimFBF } = require('../lib/auto-pipeline');

    setImmediate(() => {
      const tasks = jobs.map(job => async () => {
        job.status = 'running';
        try {
          await generateAnimFBF(
            new NanaBananaClient({ model: modelId }),
            job.character,
            job.animation,
          );
          job.status = 'done';
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
        }
      });
      runWithConcurrency(tasks, concurrency);
    });
  });

  // GET /api/animation/apply-bulk/:bulkJobId
  // Returns current status for all jobs in a bulk batch.
  router.get('/api/animation/apply-bulk/:bulkJobId', (req, res, params) => {
    const entry = bulkJobs.get(params.bulkJobId);
    if (!entry) return json(res, { error: 'Bulk job not found' }, 404);

    const total = entry.jobs.length;
    const done = entry.jobs.filter(j => j.status === 'done').length;
    const failed = entry.jobs.filter(j => j.status === 'failed').length;
    const running = entry.jobs.filter(j => j.status === 'running').length;
    const pending = entry.jobs.filter(j => j.status === 'pending').length;

    return json(res, {
      bulkJobId: entry.bulkJobId,
      animation: entry.animation,
      model: entry.model,
      concurrency: entry.concurrency,
      createdAt: entry.createdAt,
      summary: { total, done, failed, running, pending },
      jobs: entry.jobs,
    });
  });

  // ─── Fill-Gaps Helper ────────────────────────────────────────────────────
  // Replicates POST /api/generate logic (single-call + batch paths) without
  // going through HTTP. Returns { frames, cost } on success; throws on failure.
  async function generateMissingStrip(character, animKey, modelId, client) {
    const anim = ANIMATIONS[animKey];
    if (!anim) throw new Error(`Unknown animation: ${animKey}`);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!CHARACTERS[character] && fs.existsSync(portraitPath)) {
      CHARACTERS[character] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };
    }

    const totalFrames = anim.frames;
    const charRef = fs.existsSync(portraitPath) ? portraitPath : null;
    const poseRefCandidate = anim.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;
    const poseRef = poseRefCandidate && fs.existsSync(poseRefCandidate) ? poseRefCandidate : null;

    fs.mkdirSync(RAW_DIR, { recursive: true });

    const MAX_FRAMES_PER_BATCH = 4;

    if (totalFrames <= MAX_FRAMES_PER_BATCH || !poseRef) {
      const prompt = poseRef
        ? buildPoseTransferPrompt(character, animKey).prompt
        : buildTextOnlyAnimPrompt(character, animKey).prompt;

      const outputPath = path.join(RAW_DIR, `${character}-${animKey}-raw.png`);
      await client.generateSprite(prompt, poseRef, charRef, {
        aspectRatio: '16:9', resolution: '2K', model: modelId, outputPath,
      });

      const costInfo = recordCost(modelId, 'strip', '2K', (poseRef ? 1 : 0) + (charRef ? 1 : 0), { character, animation: animKey });
      const processed = await processSprite(outputPath, `${character}-${animKey}`, {
        frameCount: totalFrames, targetSize: 180, outputDir: ASSETS_DIR,
      });
      return { frames: processed.frameCount, cost: costInfo.totalCost };
    }

    // Batch mode — same logic as POST /api/generate batch path
    const refFramesDir = path.join(RAW_DIR, `${character}-${animKey}-ref-frames`);
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
      const miniStripPath = path.join(RAW_DIR, `${character}-${animKey}-batch${b}-ref.png`);
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
        `- Same size character in EVERY frame`,
      ].join('\n');

      const batchOutputPath = path.join(RAW_DIR, `${character}-${animKey}-batch${b}-raw.png`);
      await client.generateSprite(batchPrompt, miniStripPath, charRef, {
        aspectRatio: '16:9', resolution: '2K', model: modelId, outputPath: batchOutputPath,
      });

      recordCost(modelId, 'strip_batch', '2K', (charRef ? 2 : 1), { character, animation: animKey, batch: b });
      const batchProcessed = await processSprite(batchOutputPath, `${character}-${animKey}-batch${b}`, {
        frameCount: batch.count, targetSize: 180, outputDir: RAW_DIR,
      });
      batchOutputs.push(batchProcessed);
    }

    const allFramePaths = [];
    for (let b = 0; b < batchOutputs.length; b++) {
      const framesDir = batchOutputs[b].framesDir;
      if (fs.existsSync(framesDir)) {
        fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort()
          .forEach(f => allFramePaths.push(path.join(framesDir, f)));
      }
    }

    const finalStripPath = path.join(ASSETS_DIR, `${character}-${animKey}.png`);
    await buildRefStrip(allFramePaths, finalStripPath, { height: 180 });
    return { frames: allFramePaths.length, cost: batches.length * getImageCost(modelId, '2K') };
  }

  // Shared gap-scan + run logic used by both fill-gaps routes.
  // characters: string[] — names to check
  // Returns details[] (already includes skipped entries); generates missing ones with concurrency 3.
  async function runFillGaps(characters, modelId) {
    const animKeys = Object.keys(ANIMATIONS);
    const client = new NanaBananaClient({ model: modelId });
    const skipped = [];
    const tasks = [];

    for (const character of characters) {
      for (const animKey of animKeys) {
        const stripPath = path.join(ASSETS_DIR, `${character}-${animKey}.png`);
        if (fs.existsSync(stripPath)) {
          skipped.push({ character, animKey, status: 'skipped' });
          continue;
        }
        tasks.push(async () => {
          try {
            const result = await generateMissingStrip(character, animKey, modelId, client);
            return { character, animKey, status: 'generated', frames: result.frames, cost: result.cost };
          } catch (err) {
            return { character, animKey, status: 'failed', error: err.message };
          }
        });
      }
    }

    const taskResults = await runWithConcurrency(tasks, 6);
    const details = [...skipped, ...taskResults];

    return {
      total: details.length,
      generated: taskResults.filter(r => r.status === 'generated').length,
      skipped: skipped.length,
      failed: taskResults.filter(r => r.status === 'failed').length,
      details,
    };
  }

  // POST /api/pipeline/fill-gaps — Fill missing animation strips for all characters
  // Body: { model? }
  router.post('/api/pipeline/fill-gaps', async (req, res) => {
    try {
      const body = await parseBody(req);
      const modelId = (body.model && ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'].includes(body.model))
        ? body.model : 'gemini-2.5-flash-image';

      // Discover roster from *full.png files in ASSETS_DIR
      const portraits = fs.existsSync(ASSETS_DIR)
        ? fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('full.png')).map(f => f.replace('full.png', ''))
        : [];

      if (portraits.length === 0) return json(res, { error: 'No characters found in assets directory' }, 404);

      const report = await runFillGaps(portraits, modelId);
      return json(res, { ...report, characters: portraits, model: modelId });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/pipeline/fill-gaps/:character — Fill missing animation strips for one character
  // Body: { model? }
  router.post('/api/pipeline/fill-gaps/:character', async (req, res, params) => {
    try {
      const { character } = params;
      const body = await parseBody(req);
      const modelId = (body.model && ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'].includes(body.model))
        ? body.model : 'gemini-2.5-flash-image';

      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) {
        return json(res, { error: `Portrait not found: ${character}full.png` }, 404);
      }

      const report = await runFillGaps([character], modelId);
      return json(res, { ...report, character, model: modelId });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
