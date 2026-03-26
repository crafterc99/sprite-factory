/**
 * Pipeline Routes — Full character pipeline orchestration
 * Generates all 8 animations for a character sequentially with SSE progress,
 * budget tracking, checkpoint/resume, and deployment.
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, buildSectionedPrompt, getDefaultSections } = require('../../sprite-generator/prompts');
const { cutFrames, upscaleNN, buildStrip, processSingleFrame, normalizeFrameSizes, buildGrid } = require('../../sprite-processor/index');
const { recordCost, getImageCost, loadCostData } = require('../middleware/cost-tracker');
const jobStore = require('../job-store');

const PIPELINE_DIR = path.resolve(__dirname, '../../../.pipeline-data');

const DEFAULT_ANIM_ORDER = [
  'static-dribble',
  'dribble',
  'jumpshot',
  'stepback',
  'crossover',
  'defense-backpedal',
  'defense-shuffle',
  'steal',
];

// ─── Checkpoint Helpers ──────────────────────────────────────────────────

function ensurePipelineDir() {
  if (!fs.existsSync(PIPELINE_DIR)) fs.mkdirSync(PIPELINE_DIR, { recursive: true });
}

function getCheckpointPath(character, timestamp) {
  return path.join(PIPELINE_DIR, `${character}-${timestamp}.json`);
}

function saveCheckpoint(checkpointPath, data) {
  ensurePipelineDir();
  fs.writeFileSync(checkpointPath, JSON.stringify(data, null, 2));
}

function loadLatestCheckpoint(character) {
  ensurePipelineDir();
  const files = fs.readdirSync(PIPELINE_DIR)
    .filter(f => f.startsWith(`${character}-`) && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    return JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

// ─── Route Handler ───────────────────────────────────────────────────────

function register(router, { ASSETS_DIR, RAW_DIR, runWithConcurrency, json, parseBody }) {

  // POST /api/pipeline/start — Start full pipeline for a character
  router.post('/api/pipeline/start', async (req, res) => {
    const body = await parseBody(req);
    const { character, model, budget, animations } = body;

    if (!character) return json(res, { error: 'character required' }, 400);

    // SSE setup
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
      const budgetLimit = parseFloat(budget) || 5.00;
      const animOrder = animations || DEFAULT_ANIM_ORDER;

      // Validate character portrait exists
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) {
        throw new Error(`Portrait not found: ${character}full.png`);
      }

      // Ensure character is registered at runtime
      if (!CHARACTERS[character]) {
        CHARACTERS[character] = {
          description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: '16-bit pixel art, GBA style',
        };
      }

      const isPro = modelId.includes('pro');
      const concurrency = isPro ? 1 : 2;
      const interFrameDelay = isPro ? 15000 : 2000;
      const maxRetries = isPro ? 5 : 3;
      const retryBaseDelay = isPro ? 20000 : 5000;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const checkpointPath = getCheckpointPath(character, timestamp);

      const checkpoint = {
        character,
        model: modelId,
        budget: budgetLimit,
        status: 'running',
        animOrder,
        completedAnims: [],
        animResults: {},
        currentAnim: null,
        totalCost: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };

      saveCheckpoint(checkpointPath, checkpoint);
      fs.mkdirSync(RAW_DIR, { recursive: true });

      sse({
        type: 'pipeline_start',
        character,
        model: modelId,
        budget: budgetLimit,
        animations: animOrder,
        total: animOrder.length,
      });

      let totalPipelineCost = 0;

      for (let animIdx = 0; animIdx < animOrder.length; animIdx++) {
        const animName = animOrder[animIdx];
        const anim = ANIMATIONS[animName];

        if (!anim) {
          sse({ type: 'anim_skip', animation: animName, reason: 'unknown animation' });
          continue;
        }

        if (!anim.breezyFile) {
          sse({ type: 'anim_skip', animation: animName, reason: 'no Breezy reference' });
          continue;
        }

        const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
        if (!fs.existsSync(poseRefPath)) {
          sse({ type: 'anim_skip', animation: animName, reason: `reference not found: ${anim.breezyFile}` });
          continue;
        }

        const totalFrames = anim.frames;
        const frameCostEach = getImageCost(modelId, '1K');
        const estimatedAnimCost = totalFrames * frameCostEach;

        // Budget check: stop if next animation would exceed remaining budget
        if (totalPipelineCost + estimatedAnimCost > budgetLimit) {
          sse({
            type: 'budget_stop',
            animation: animName,
            index: animIdx,
            spent: +totalPipelineCost.toFixed(4),
            remaining: +(budgetLimit - totalPipelineCost).toFixed(4),
            needed: +estimatedAnimCost.toFixed(4),
          });
          break;
        }

        checkpoint.currentAnim = animName;
        saveCheckpoint(checkpointPath, checkpoint);

        sse({ type: 'anim_start', animation: animName, index: animIdx, total: animOrder.length });

        const fbfDir = path.join(RAW_DIR, `${character}-${animName}-fbf`);
        fs.mkdirSync(fbfDir, { recursive: true });

        // Create a job for this animation
        const job = jobStore.createJob({
          character,
          animation: animName,
          mode: 'fbf',
          model: modelId,
          totalFrames,
        });

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

        // Generate each frame
        const rawOutputPaths = [];
        let animCost = 0;

        const tasks = upscaledPaths.map((upPath, i) => async () => {
          const prompt = buildSectionedPrompt(character, animName, {
            frameIndex: i,
            totalFrames,
          });

          const outPath = path.join(fbfDir, `raw-frame-${String(i).padStart(3, '0')}.png`);

          let lastErr;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              await client.generateSingleFrame(prompt, upPath, portraitPath, {
                model: modelId,
                outputPath: outPath,
              });
              rawOutputPaths[i] = outPath;
              const frameCost = recordCost(modelId, 'pipeline_frame', '1K', 2, {
                character, animation: animName, frame: i,
              });
              animCost += frameCost.totalCost;

              jobStore.recordAttempt(job.id, i, { rawPath: outPath, promptText: prompt });

              sse({
                type: 'frame_done',
                animation: animName,
                frame: i,
                totalFrames,
                cost: +frameCost.totalCost.toFixed(4),
              });
              return;
            } catch (err) {
              lastErr = err;
              if (attempt < maxRetries - 1) {
                const wait = retryBaseDelay * Math.pow(1.5, attempt) + Math.random() * 3000;
                sse({
                  type: 'frame_retry',
                  animation: animName,
                  frame: i,
                  attempt: attempt + 1,
                  maxRetries,
                  error: err.message,
                });
                await new Promise(r => setTimeout(r, wait));
              }
            }
          }
          sse({ type: 'frame_error', animation: animName, frame: i, error: lastErr?.message });
        });

        await runWithConcurrency(tasks, concurrency, interFrameDelay);

        // Process all raw frames
        const processedDir = path.join(fbfDir, 'processed');
        fs.mkdirSync(processedDir, { recursive: true });
        const processedPaths = [];

        for (let i = 0; i < totalFrames; i++) {
          const rawPath = rawOutputPaths[i];
          if (!rawPath || !fs.existsSync(rawPath)) continue;

          const processedPath = path.join(processedDir, `frame-${String(i).padStart(3, '0')}.png`);
          await processSingleFrame(rawPath, processedPath, { width: 180, height: 180 });
          processedPaths.push(processedPath);
        }

        // Normalize frame sizes
        if (processedPaths.length > 1) {
          await normalizeFrameSizes(processedPaths, { targetWidth: 180, targetHeight: 180 });
        }

        // Build strip
        const stripPath = path.join(ASSETS_DIR, `${character}-${animName}.png`);
        await buildStrip(processedPaths, stripPath, { frameWidth: 180, frameHeight: 180 });

        // Save individual frames
        const framesOutDir = path.join(ASSETS_DIR, `${character}-${animName}-frames`);
        fs.mkdirSync(framesOutDir, { recursive: true });
        processedPaths.forEach((p, i) => {
          fs.copyFileSync(p, path.join(framesOutDir, `frame-${i}.png`));
        });

        // Update job
        jobStore.updateJob(job.id, {
          status: 'complete',
          stripPath,
          completedFrames: processedPaths.length,
          processedPaths: processedPaths.map(p => path.basename(p)),
          totalCost: animCost,
          completedAt: new Date().toISOString(),
        });

        totalPipelineCost += animCost;

        // Compute a quality score (frames successfully generated / total)
        const score = processedPaths.length === totalFrames ? 100
          : Math.round((processedPaths.length / totalFrames) * 100);

        checkpoint.completedAnims.push(animName);
        checkpoint.animResults[animName] = {
          jobId: job.id,
          frames: processedPaths.length,
          totalFrames,
          cost: +animCost.toFixed(4),
          score,
          stripUrl: `/assets/${character}-${animName}.png`,
        };
        checkpoint.totalCost = +totalPipelineCost.toFixed(4);
        saveCheckpoint(checkpointPath, checkpoint);

        sse({
          type: 'anim_complete',
          animation: animName,
          score,
          frames: processedPaths.length,
          totalFrames,
          cost: +animCost.toFixed(4),
          url: `/assets/${character}-${animName}.png`,
        });
      }

      // Pipeline complete
      checkpoint.status = 'complete';
      checkpoint.currentAnim = null;
      checkpoint.totalCost = +totalPipelineCost.toFixed(4);
      checkpoint.completedAt = new Date().toISOString();
      saveCheckpoint(checkpointPath, checkpoint);

      sse({
        type: 'pipeline_complete',
        character,
        completedAnims: checkpoint.completedAnims,
        totalAnims: animOrder.length,
        totalCost: +totalPipelineCost.toFixed(4),
        budget: parseFloat(budget) || 5.00,
        checkpointFile: path.basename(checkpointPath),
      });

    } catch (err) {
      sse({ type: 'error', message: err.message });
    }

    res.end();
  });

  // GET /api/pipeline/status/:character — Get pipeline status for a character
  router.get('/api/pipeline/status/:character', (req, res, params) => {
    const character = params.character;

    const checkpoint = loadLatestCheckpoint(character);
    if (!checkpoint) {
      return json(res, {
        character,
        status: 'none',
        completedAnims: [],
        currentAnim: null,
        totalCost: 0,
        startedAt: null,
      });
    }

    return json(res, {
      character: checkpoint.character,
      status: checkpoint.status,
      completedAnims: checkpoint.completedAnims,
      currentAnim: checkpoint.currentAnim,
      totalCost: checkpoint.totalCost,
      budget: checkpoint.budget,
      model: checkpoint.model,
      animResults: checkpoint.animResults,
      startedAt: checkpoint.startedAt,
      completedAt: checkpoint.completedAt,
    });
  });

  // POST /api/pipeline/deploy/:character — Deploy character to Soul Jam (build grid sheet)
  router.post('/api/pipeline/deploy/:character', async (req, res, params) => {
    const character = params.character;

    try {
      const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
      if (!fs.existsSync(portraitPath)) {
        return json(res, { error: `Character portrait not found: ${character}full.png` }, 404);
      }

      const result = await buildGrid(character, { assetsDir: ASSETS_DIR, outputDir: ASSETS_DIR });

      // Update the checkpoint if one exists
      const checkpoint = loadLatestCheckpoint(character);
      if (checkpoint) {
        checkpoint.status = 'deployed';
        checkpoint.deployedAt = new Date().toISOString();
        checkpoint.gridPath = result.outputPath;
        checkpoint.manifestPath = result.manifestPath;
        // Re-save by creating a fresh checkpoint file
        ensurePipelineDir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        saveCheckpoint(getCheckpointPath(character, timestamp), checkpoint);
      }

      return json(res, {
        success: true,
        character,
        gridPath: result.outputPath,
        manifestPath: result.manifestPath,
        gridUrl: `/assets/${character}-spritesheet.png`,
        width: result.width,
        height: result.height,
        rows: result.rows,
        missingAnimations: result.missingAnimations,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
