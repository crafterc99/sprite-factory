/**
 * Evaluation Routes — Quality checks + auto-test pipeline
 */
const fs = require('fs');
const path = require('path');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { CHARACTERS, ANIMATIONS, buildSectionedPrompt, getDefaultSections } = require('../../sprite-generator/prompts');
const { cutFrames, upscaleNN, buildStrip, processSingleFrame, normalizeFrameSizes, evaluateFrame, evaluateStrip, applyFixes } = require('../../sprite-processor/index');
const { recordCost, getImageCost } = require('../middleware/cost-tracker');
const { trainPrompt, loadTraining } = require('../../sprite-generator/prompts');
const { loadFeedback } = require('../../sprite-generator/smart-selector');
const jobStore = require('../job-store');

function register(router, { ASSETS_DIR, RAW_DIR, runWithConcurrency, json, parseBody }) {

  // POST /api/evaluate — Evaluate existing frames without regenerating
  router.post('/api/evaluate', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation } = body;

    try {
      const framesDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
      if (!fs.existsSync(framesDir)) {
        return json(res, { error: 'No frames found. Generate first.' }, 404);
      }

      const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
      const framePaths = frames.map(f => path.join(framesDir, f));

      if (framePaths.length === 0) {
        return json(res, { error: 'No frame files found' }, 404);
      }

      const evaluation = await evaluateStrip(framePaths);
      return json(res, evaluation);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/auto-test — Generate, evaluate, auto-fix, and regenerate
  router.post('/api/auto-test', async (req, res) => {
    const body = await parseBody(req);
    const { character, animation, model, budget, maxIterations, customSections: initialSections } = body;
    const budgetLimit = parseFloat(budget) || 1.00;
    const iterLimit = parseInt(maxIterations) || 5;

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
      const isPro = modelId.includes('pro');
      const concurrency = isPro ? 1 : 2;
      const interFrameDelay = isPro ? 15000 : 2000;
      const maxRetries = isPro ? 5 : 3;
      const retryBaseDelay = isPro ? 20000 : 5000;
      const frameCostEach = getImageCost(modelId, '1K');

      fs.mkdirSync(RAW_DIR, { recursive: true });

      const fbfDir = path.join(RAW_DIR, `${character}-${animation}-autotest`);
      fs.mkdirSync(fbfDir, { recursive: true });

      const refFramesDir = path.join(fbfDir, 'ref-frames');
      fs.mkdirSync(refFramesDir, { recursive: true });
      const cutResult = await cutFrames(poseRefPath, refFramesDir);
      const refFramePaths = cutResult.frames.slice(0, totalFrames);

      const upscaledDir = path.join(fbfDir, 'upscaled');
      fs.mkdirSync(upscaledDir, { recursive: true });
      const upscaledPaths = [];
      for (let i = 0; i < refFramePaths.length; i++) {
        const upPath = path.join(upscaledDir, `frame-${String(i).padStart(3, '0')}.png`);
        await upscaleNN(refFramePaths[i], upPath, { width: 512, height: 512 });
        upscaledPaths.push(upPath);
      }

      sse({ type: 'autotest_start', character, animation, totalFrames, budget: budgetLimit, maxIterations: iterLimit });

      let spentTotal = 0;
      let currentSections = initialSections || null;
      let bestResult = null;
      let bestScore = 0;

      for (let iter = 0; iter < iterLimit; iter++) {
        const estimatedCost = totalFrames * frameCostEach;
        if (spentTotal + estimatedCost > budgetLimit) {
          sse({ type: 'budget_warning', iteration: iter, spent: +spentTotal.toFixed(4), remaining: +(budgetLimit - spentTotal).toFixed(4), needed: +estimatedCost.toFixed(4) });
          break;
        }

        const iterDir = path.join(fbfDir, `iter-${iter}`);
        fs.mkdirSync(iterDir, { recursive: true });

        sse({ type: 'iteration_start', iteration: iter, spent: +spentTotal.toFixed(4) });

        if (!currentSections) {
          const defaults = getDefaultSections(character, animation, { frameIndex: 0, totalFrames });
          currentSections = {};
          for (const [key, sec] of Object.entries(defaults)) {
            currentSections[key] = { enabled: sec.enabled !== false, text: sec.text };
          }
        }

        const rawPaths = [];
        let iterCost = 0;
        let failedFrames = 0;

        const tasks = upscaledPaths.map((upPath, i) => async () => {
          const prompt = buildSectionedPrompt(character, animation, {
            frameIndex: i,
            totalFrames,
            customSections: currentSections,
          });

          const outPath = path.join(iterDir, `raw-frame-${String(i).padStart(3, '0')}.png`);

          let lastErr;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              await client.generateSingleFrame(prompt, upPath, portraitPath, {
                model: modelId,
                outputPath: outPath,
              });
              rawPaths[i] = outPath;
              const cost = recordCost(modelId, 'autotest_frame', '1K', 2, { character, animation, frame: i, iteration: iter });
              iterCost += cost.totalCost;
              sse({ type: 'frame_done', iteration: iter, frame: i, cost: +cost.totalCost.toFixed(4) });
              return;
            } catch (err) {
              lastErr = err;
              if (attempt < maxRetries - 1) {
                const wait = retryBaseDelay * Math.pow(1.5, attempt) + Math.random() * 3000;
                sse({ type: 'frame_retry', iteration: iter, frame: i, attempt: attempt + 1, error: err.message });
                await new Promise(r => setTimeout(r, wait));
              }
            }
          }
          failedFrames++;
          sse({ type: 'frame_error', iteration: iter, frame: i, error: lastErr?.message });
        });

        await runWithConcurrency(tasks, concurrency, interFrameDelay);
        spentTotal += iterCost;

        const processedDir = path.join(iterDir, 'processed');
        fs.mkdirSync(processedDir, { recursive: true });
        const processedPaths = [];

        for (let i = 0; i < totalFrames; i++) {
          const rawPath = rawPaths[i];
          if (!rawPath || !fs.existsSync(rawPath)) continue;

          const processedPath = path.join(processedDir, `frame-${String(i).padStart(3, '0')}.png`);
          await processSingleFrame(rawPath, processedPath, { width: 180, height: 180 });
          processedPaths.push(processedPath);
        }

        if (processedPaths.length > 1) {
          await normalizeFrameSizes(processedPaths, { targetWidth: 180, targetHeight: 180 });
        }

        const iterStripPath = path.join(iterDir, 'strip.png');
        await buildStrip(processedPaths, iterStripPath, { frameWidth: 180, frameHeight: 180 });

        const framesOutDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
        fs.mkdirSync(framesOutDir, { recursive: true });
        processedPaths.forEach((p, i) => {
          fs.copyFileSync(p, path.join(framesOutDir, `frame-${i}.png`));
        });

        sse({ type: 'generation_done', iteration: iter, frames: processedPaths.length, failed: failedFrames, cost: +iterCost.toFixed(4) });

        const evaluation = await evaluateStrip(processedPaths);

        sse({
          type: 'evaluation',
          iteration: iter,
          passed: evaluation.passed,
          overallScore: evaluation.overallScore,
          avgFrameScore: evaluation.avgFrameScore,
          consistencyScore: evaluation.consistencyScore,
          medianFill: evaluation.medianFill,
          issues: evaluation.issues.map(i => ({ type: i.type, severity: i.severity, affectedFrames: i.affectedFrames })),
          fixes: evaluation.fixes.length,
        });

        if (evaluation.overallScore > bestScore) {
          bestScore = evaluation.overallScore;
          bestResult = {
            iteration: iter,
            score: evaluation.overallScore,
            stripPath: iterStripPath,
            processedPaths: [...processedPaths],
          };
        }

        if (evaluation.passed && evaluation.overallScore >= 75) {
          const finalStripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
          fs.copyFileSync(iterStripPath, finalStripPath);

          sse({
            type: 'autotest_complete',
            status: 'passed',
            iteration: iter,
            totalIterations: iter + 1,
            score: evaluation.overallScore,
            spent: +spentTotal.toFixed(4),
            url: `/assets/${character}-${animation}.png`,
          });
          break;
        }

        if (iter === iterLimit - 1) {
          if (bestResult) {
            const finalStripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
            fs.copyFileSync(bestResult.stripPath, finalStripPath);
          }

          sse({
            type: 'autotest_complete',
            status: 'max_iterations',
            iteration: iter,
            totalIterations: iter + 1,
            bestIteration: bestResult?.iteration,
            bestScore: bestScore,
            spent: +spentTotal.toFixed(4),
            url: bestResult ? `/assets/${character}-${animation}.png` : null,
          });
          break;
        }

        sse({ type: 'applying_fixes', iteration: iter, fixCount: evaluation.fixes.length, fixes: evaluation.fixes.map(f => f.section + ': ' + f.text.trim().substring(0, 60)) });
        currentSections = applyFixes(currentSections, evaluation.fixes);
      }

      if (spentTotal >= budgetLimit) {
        if (bestResult) {
          const finalStripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
          fs.copyFileSync(bestResult.stripPath, finalStripPath);
        }

        sse({
          type: 'autotest_complete',
          status: 'budget_exhausted',
          bestIteration: bestResult?.iteration,
          bestScore: bestScore,
          spent: +spentTotal.toFixed(4),
          budget: budgetLimit,
          url: bestResult ? `/assets/${character}-${animation}.png` : null,
        });
      }

    } catch (err) {
      sse({ type: 'error', message: err.message });
    }

    res.end();
  });

  // POST /api/feedback — Record generation feedback
  router.post('/api/feedback', async (req, res) => {
    const body = await parseBody(req);
    const result = trainPrompt(body.animation, body.rating, body.notes, body);
    return json(res, { success: true, totalIterations: result.totalIterations });
  });

  // GET /api/training — Get training data
  router.get('/api/training', (req, res) => {
    const training = loadTraining();
    const frameFeedback = loadFeedback();
    return json(res, { prompts: training, frames: frameFeedback });
  });

  // GET /api/costs — Get cost tracking data + scale projections
  router.get('/api/costs', (req, res) => {
    const { loadCostData } = require('../middleware/cost-tracker');
    const data = loadCostData();

    const avgCostPerAnim = data.totalGenerations > 0
      ? data.totalSpend / data.totalGenerations
      : 0.067;
    const animsPerChar = Object.keys(ANIMATIONS).length;

    const rosterCount = fs.existsSync(ASSETS_DIR)
      ? fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('full.png')).length
      : 0;

    const projections = {
      avgCostPerGeneration: avgCostPerAnim,
      costPerCharacter: avgCostPerAnim * animsPerChar * 1.5,
      animsPerCharacter: animsPerChar,
      currentRoster: rosterCount,
      scale: {
        '5_characters':  { gens: 5 * animsPerChar * 1.5,  cost: 5  * animsPerChar * 1.5 * avgCostPerAnim },
        '10_characters': { gens: 10 * animsPerChar * 1.5, cost: 10 * animsPerChar * 1.5 * avgCostPerAnim },
        '25_characters': { gens: 25 * animsPerChar * 1.5, cost: 25 * animsPerChar * 1.5 * avgCostPerAnim },
        '50_characters': { gens: 50 * animsPerChar * 1.5, cost: 50 * animsPerChar * 1.5 * avgCostPerAnim },
      },
    };

    return json(res, { ...data, projections });
  });

  // DELETE /api/costs — Reset cost tracking
  router.delete('/api/costs', (req, res) => {
    const { saveCostData } = require('../middleware/cost-tracker');
    saveCostData({ totalSpend: 0, totalGenerations: 0, byModel: {}, byType: {}, history: [] });
    return json(res, { success: true, message: 'Cost tracking reset' });
  });
}

module.exports = { register };
