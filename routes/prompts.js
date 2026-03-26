/**
 * Prompt Lab Routes — A/B comparison, quick-test, history
 * Provides endpoints for testing custom prompt sections, comparing
 * two prompt variants side by side, and viewing prompt version history.
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, buildSectionedPrompt, getDefaultSections, loadTraining } = require('../../sprite-generator/prompts');
const { cutFrames, upscaleNN, processSingleFrame } = require('../../sprite-processor/index');
const { recordCost, getImageCost, loadCostData } = require('../middleware/cost-tracker');
const jobStore = require('../job-store');

function register(router, { ASSETS_DIR, RAW_DIR, json, parseBody }) {

  // ─── Shared: prepare a single pose-reference frame for generation ────

  async function prepareRefFrame(character, animation, frameIndex) {
    const anim = ANIMATIONS[animation];
    if (!anim) throw new Error(`Unknown animation: ${animation}`);
    if (!anim.breezyFile) throw new Error(`No Breezy reference for ${animation}`);

    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found: ${character}full.png`);

    const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
    if (!fs.existsSync(poseRefPath)) throw new Error(`Breezy ref not found: ${anim.breezyFile}`);

    // Ensure character exists at runtime
    if (!CHARACTERS[character]) {
      CHARACTERS[character] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };
    }

    const totalFrames = anim.frames;
    const idx = Math.min(frameIndex || 0, totalFrames - 1);

    fs.mkdirSync(RAW_DIR, { recursive: true });

    const labDir = path.join(RAW_DIR, `${character}-${animation}-promptlab`);
    fs.mkdirSync(labDir, { recursive: true });

    // Cut reference strip into frames (reuse if already done)
    const refFramesDir = path.join(labDir, 'ref-frames');
    if (!fs.existsSync(refFramesDir) || fs.readdirSync(refFramesDir).filter(f => f.endsWith('.png')).length === 0) {
      fs.mkdirSync(refFramesDir, { recursive: true });
      await cutFrames(poseRefPath, refFramesDir);
    }

    const refFrames = fs.readdirSync(refFramesDir).filter(f => f.endsWith('.png')).sort();
    if (idx >= refFrames.length) throw new Error(`Frame index ${idx} out of range (0-${refFrames.length - 1})`);

    const refFramePath = path.join(refFramesDir, refFrames[idx]);

    // Upscale to 512x512
    const upscaledDir = path.join(labDir, 'upscaled');
    fs.mkdirSync(upscaledDir, { recursive: true });
    const upPath = path.join(upscaledDir, `frame-${String(idx).padStart(3, '0')}.png`);
    await upscaleNN(refFramePath, upPath, { width: 512, height: 512 });

    return { upPath, portraitPath, labDir, totalFrames, frameIndex: idx };
  }

  // ─── Generate a single frame with given sections ────────────────────

  async function generateTestFrame(client, modelId, character, animation, frameIndex, totalFrames, upPath, portraitPath, labDir, customSections, label) {
    const prompt = buildSectionedPrompt(character, animation, {
      frameIndex,
      totalFrames,
      customSections,
    });

    const suffix = label ? `-${label}` : '';
    const stamp = Date.now();
    const outPath = path.join(labDir, `test-frame-${String(frameIndex).padStart(3, '0')}${suffix}-${stamp}.png`);

    await client.generateSingleFrame(prompt, upPath, portraitPath, {
      model: modelId,
      outputPath: outPath,
    });

    const costInfo = recordCost(modelId, 'promptlab_test', '1K', 2, {
      character, animation, frame: frameIndex, label: label || 'test',
    });

    // Process the frame (BG removal + crop)
    const processedPath = outPath.replace('.png', '-processed.png');
    await processSingleFrame(outPath, processedPath, { width: 180, height: 180 });

    // Build URLs relative to raw serving path
    const relDir = path.relative(RAW_DIR, labDir);
    const rawUrl = `/fbf-working/${relDir}/${path.basename(outPath)}`;
    const processedUrl = `/fbf-working/${relDir}/${path.basename(processedPath)}`;

    return {
      imageUrl: rawUrl,
      processedUrl,
      processedPath,
      cost: costInfo.totalCost,
      runningTotal: costInfo.runningTotal,
    };
  }

  // POST /api/prompt-lab/test — Quick single-frame test with custom prompt sections
  router.post('/api/prompt-lab/test', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, frameIndex, model, customSections } = body;

    if (!character) return json(res, { error: 'character required' }, 400);
    if (!animation) return json(res, { error: 'animation required' }, 400);

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const ref = await prepareRefFrame(character, animation, frameIndex || 0);

      // If no custom sections, use defaults
      let sections = customSections;
      if (!sections) {
        const defaults = getDefaultSections(character, animation, {
          frameIndex: ref.frameIndex,
          totalFrames: ref.totalFrames,
        });
        sections = {};
        for (const [key, sec] of Object.entries(defaults)) {
          sections[key] = { enabled: sec.enabled !== false, text: sec.text };
        }
      }

      const result = await generateTestFrame(
        client, modelId, character, animation,
        ref.frameIndex, ref.totalFrames,
        ref.upPath, ref.portraitPath, ref.labDir,
        sections, 'test'
      );

      return json(res, {
        success: true,
        imageUrl: result.imageUrl,
        processedUrl: result.processedUrl,
        cost: +result.cost.toFixed(4),
        runningTotal: +result.runningTotal.toFixed(4),
        frameIndex: ref.frameIndex,
        totalFrames: ref.totalFrames,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/prompt-lab/compare — A/B comparison (generates 2 variants)
  router.post('/api/prompt-lab/compare', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, frameIndex, model, sectionsA, sectionsB } = body;

    if (!character) return json(res, { error: 'character required' }, 400);
    if (!animation) return json(res, { error: 'animation required' }, 400);
    if (!sectionsA) return json(res, { error: 'sectionsA required' }, 400);
    if (!sectionsB) return json(res, { error: 'sectionsB required' }, 400);

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const ref = await prepareRefFrame(character, animation, frameIndex || 0);

      // Generate variant A
      const resultA = await generateTestFrame(
        client, modelId, character, animation,
        ref.frameIndex, ref.totalFrames,
        ref.upPath, ref.portraitPath, ref.labDir,
        sectionsA, 'A'
      );

      // Small delay between generations to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));

      // Generate variant B
      const resultB = await generateTestFrame(
        client, modelId, character, animation,
        ref.frameIndex, ref.totalFrames,
        ref.upPath, ref.portraitPath, ref.labDir,
        sectionsB, 'B'
      );

      return json(res, {
        success: true,
        frameIndex: ref.frameIndex,
        totalFrames: ref.totalFrames,
        resultA: {
          imageUrl: resultA.imageUrl,
          processedUrl: resultA.processedUrl,
          cost: +resultA.cost.toFixed(4),
        },
        resultB: {
          imageUrl: resultB.imageUrl,
          processedUrl: resultB.processedUrl,
          cost: +resultB.cost.toFixed(4),
        },
        totalCost: +(resultA.cost + resultB.cost).toFixed(4),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/prompt-lab/history — Prompt version history from training data + job history
  router.get('/api/prompt-lab/history', (req, res, params, query) => {
    try {
      const versions = [];

      // Source 1: Training data (prompt feedback history)
      const training = loadTraining();
      if (training.history && training.history.length > 0) {
        for (const entry of training.history) {
          versions.push({
            source: 'training',
            timestamp: entry.timestamp,
            character: null,
            animation: entry.animation,
            sections: null,
            score: entry.rating ? entry.rating * 20 : null, // Convert 1-5 rating to 0-100 scale
            notes: entry.notes || null,
            promptUsed: entry.promptUsed || null,
          });
        }
      }

      // Source 2: Job history with prompt sections
      const filter = {};
      if (query.character) filter.character = query.character;
      if (query.animation) filter.animation = query.animation;

      const jobs = jobStore.listJobs(filter);
      for (const job of jobs) {
        if (job.promptSections || job.promptText) {
          versions.push({
            source: 'job',
            timestamp: job.startedAt,
            character: job.character,
            animation: job.animation,
            sections: job.promptSections || null,
            score: job.qualityScore,
            mode: job.mode,
            model: job.model,
            status: job.status,
            frames: job.completedFrames,
            totalFrames: job.totalFrames,
            jobId: job.id,
          });
        }
      }

      // Source 3: Prompt overrides from training
      if (training.promptOverrides) {
        for (const [animName, overrides] of Object.entries(training.promptOverrides)) {
          versions.push({
            source: 'override',
            timestamp: null,
            character: null,
            animation: animName,
            sections: null,
            score: null,
            overrides,
          });
        }
      }

      // Sort by timestamp (newest first), nulls at end
      versions.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });

      return json(res, {
        versions,
        totalEntries: versions.length,
        trainingIterations: training.totalIterations || 0,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
