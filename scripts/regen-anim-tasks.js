#!/usr/bin/env node
/**
 * regen-anim-tasks.js
 *
 * Executes ANIM-REGEN-SNOOP-IDLE and ANIM-REGEN-Z-STEPBACK.
 * Uses gemini-2.5-flash-image (pro models down).
 * TEXT-ONLY mode with character portrait as sole reference image.
 * Runs QC evaluation with task-specific pass thresholds.
 * Does NOT retry on QC fail — logs as FAILED and notes pro model retry needed.
 *
 * Post-generation processing:
 * - The model returns a 1344x768 (or similar 16:9) image
 * - We cut it into frameCount columns (each column = one frame)
 * - Resize each frame to 180x180 using nearest-neighbor
 * - Build the final strip at the target dimensions
 * - Evaluate the assembled strip
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'data/assets');
const RAW_DIR = path.join(ROOT, 'data/raw-sprites');
const TMP_DIR = path.join(ROOT, 'data/.regen-tmp');

const { NanaBananaClient } = require(path.join(ROOT, 'lib/sprite-generator/nano-banana'));
const { buildStrip, evaluateStrip } = require(path.join(ROOT, 'lib/sprite-processor/index'));

// Model override — pro models are down
const MODEL = 'gemini-2.5-flash-image';
const FRAME_SIZE = 180; // target frame size in px

// ─── Task definitions ───────────────────────────────────────────────────────

const TASKS = [
  {
    id: 'ANIM-REGEN-SNOOP-IDLE',
    outputPath: path.join(ASSETS_DIR, 'snoop-idle.png'),
    rawPath: path.join(RAW_DIR, 'snoop-idle-regen-raw.png'),
    framesDir: path.join(ASSETS_DIR, 'snoop-idle-frames'),
    frameCount: 5,
    passThreshold: 80,
    characterRef: path.join(ASSETS_DIR, 'snoopfull.png'),
    prompt: `Generate a 5-frame horizontal sprite strip showing a looping idle animation for a basketball player.

CHARACTER: the character shown in Image 1 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions (Celtics-style #7 jersey, blue uniform, goggles/sunglasses, athletic build)

ANIMATION: standing idle, subtle weight shift and breathing — no basketball. The character stands in place with minimal movement. This is a looping animation.

FRAME BREAKDOWN:
(1) neutral upright stance — weight centered, arms relaxed at sides, knees soft
(2) slight weight shift right — right shoulder dips minimally, left arm drifts slightly outward
(3) back to neutral center — arms settle, both feet grounded
(4) slight weight shift left — left shoulder dips minimally, right arm drifts slightly outward
(5) return to center — nearly identical to frame 1, closing the loop

OUTPUT:
- Single horizontal strip, EXACTLY 5 frames, equally-sized, no gaps, no borders
- Each frame contains ONE full-body character — character is LARGE and fills 85-90% of each frame height
- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character
- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds
- NO green (#00FF00) on the character itself
- Same character size in every frame, feet on same baseline
- Consistent character identity across ALL 5 frames — same face, outfit, skin tone`,
  },
  {
    id: 'ANIM-REGEN-Z-STEPBACK',
    outputPath: path.join(ASSETS_DIR, 'z-stepback.png'),
    rawPath: path.join(RAW_DIR, 'z-stepback-regen-raw.png'),
    framesDir: path.join(ASSETS_DIR, 'z-stepback-frames'),
    frameCount: 4,
    passThreshold: 75,
    zeroTolerance: true,
    characterRef: path.join(ASSETS_DIR, 'zfull.png'),
    prompt: `Generate a 4-frame horizontal sprite strip showing a stepback jumper animation for a basketball player.

CHARACTER: the character shown in Image 1 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions (black hoodie, grey/white sweatpants, chain necklace, dark sneakers, athletic build)

ANIMATION: stepback jumper — creating space off the dribble. Non-looping sequence.

FRAME BREAKDOWN:
(1) dribbling approach — character moving forward with ball at hip height, weight forward
(2) hard plant — front foot plants sharply, ball gathering to body, momentum braking
(3) stepback — rear foot pushes backward creating space, body leaning back, ball rising to shooting pocket
(4) shot ready — weight on back foot, ball at chest/shooting position, space clearly created

CRITICAL — CHARACTER PURITY:
- ONE character per frame — no secondary figures, no partial figures at any frame edge
- Same character identity in ALL 4 frames — same clothing, build, face, chain
- Do NOT mix in any other character from training data

OUTPUT:
- Single horizontal strip, EXACTLY 4 frames, equally-sized, no gaps, no borders
- Each frame contains ONE full-body character — character is LARGE and fills 85-90% of each frame height
- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character
- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds
- NO green (#00FF00) on the character itself
- Same character size in every frame, feet on same baseline`,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

/**
 * Cut a horizontal strip into N equal columns, resize each to FRAME_SIZE x FRAME_SIZE,
 * return array of output paths.
 */
async function cutAndResizeFrames(imagePath, outputDir, frameCount) {
  fs.mkdirSync(outputDir, { recursive: true });
  const meta = await sharp(imagePath).metadata();
  const colWidth = Math.floor(meta.width / frameCount);
  const colHeight = meta.height;

  log(`  Input image: ${meta.width}x${meta.height}, cutting ${frameCount} frames at ${colWidth}x${colHeight}`);

  const framePaths = [];
  for (let i = 0; i < frameCount; i++) {
    const outPath = path.join(outputDir, `frame-${String(i).padStart(3, '0')}.png`);
    await sharp(imagePath)
      .extract({ left: i * colWidth, top: 0, width: colWidth, height: colHeight })
      .resize(FRAME_SIZE, FRAME_SIZE, {
        kernel: sharp.kernel.nearest,
        fit: 'contain',
        background: { r: 0, g: 255, b: 0, alpha: 255 },
      })
      .png()
      .toFile(outPath);
    framePaths.push(outPath);
  }
  return framePaths;
}

/**
 * Call Gemini API with model override and reference image.
 */
async function generate(prompt, characterRef) {
  const { GoogleGenAI } = require('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY env var required');

  const ai = new GoogleGenAI({ apiKey });

  const parts = [];
  // Image 1 = character ref
  const imageData = fs.readFileSync(characterRef);
  parts.push({
    inlineData: {
      mimeType: 'image/png',
      data: imageData.toString('base64'),
    },
  });
  parts.push({ text: prompt });

  const MAX_RETRIES = 6;
  const TIMEOUT_MS = 120000;

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  let response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts }],
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
          },
        }),
        TIMEOUT_MS
      );
      break;
    } catch (err) {
      const errMsg = err.message || '';
      const isRetryable = err.status === 429 || err.status === 503 || err.code === 429 || err.code === 503 ||
        errMsg.includes('429') || errMsg.includes('503') || errMsg.includes('Service Unavailable') ||
        errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota') || errMsg.includes('exhausted') ||
        errMsg.includes('Too many requests') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded') ||
        errMsg.includes('timed out') || (err.name === 'ApiError' && err.status >= 500);

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.min(5000 * Math.pow(2, attempt) + Math.random() * 2000, 60000);
        log(`  [API] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${(delay / 1000).toFixed(0)}s... — ${errMsg.substring(0, 80)}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  if (!response || !response.candidates || !response.candidates[0]) {
    throw new Error('No candidates in API response');
  }

  const contentParts = response.candidates[0].content?.parts || [];
  let imageBuffer = null;
  let description = '';
  for (const part of contentParts) {
    if (part.text) description = part.text;
    if (part.inlineData) imageBuffer = Buffer.from(part.inlineData.data, 'base64');
  }

  if (!imageBuffer) {
    throw new Error('No image in API response. Parts: ' + JSON.stringify(contentParts.map(p => Object.keys(p))));
  }

  return { imageBuffer, description };
}

// ─── Main task runner ────────────────────────────────────────────────────────

async function runTask(task) {
  log(`=== Starting ${task.id} ===`);
  log(`Model: ${MODEL} | Frames: ${task.frameCount} | Target strip: ${task.frameCount * FRAME_SIZE}x${FRAME_SIZE}`);
  log(`Output: ${task.outputPath}`);

  const result = {
    taskId: task.id,
    status: 'UNKNOWN',
    score: null,
    avgFrameScore: null,
    consistencyScore: null,
    medianFill: null,
    passed: false,
    issues: [],
    frameScores: [],
    outputPath: task.outputPath,
    rawPath: task.rawPath,
    error: null,
  };

  if (!fs.existsSync(task.characterRef)) {
    result.status = 'FAILED';
    result.error = `Character portrait not found: ${task.characterRef}`;
    log(`ERROR: ${result.error}`);
    return result;
  }

  // ── Step 1: Generate ──────────────────────────────────────────────────────
  log(`Generating with ${MODEL}...`);
  let genResult;
  try {
    genResult = await generate(task.prompt, task.characterRef);
  } catch (err) {
    result.status = 'FAILED';
    result.error = `Generation failed: ${err.message}`;
    log(`ERROR: ${result.error}`);
    return result;
  }

  log(`Generation complete. Image: ${genResult.imageBuffer.length} bytes`);

  // ── Step 2: Save raw output ───────────────────────────────────────────────
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(task.rawPath, genResult.imageBuffer);
  log(`Raw saved: ${task.rawPath}`);

  // Check dimensions
  const rawMeta = await sharp(genResult.imageBuffer).metadata();
  log(`Raw dimensions: ${rawMeta.width}x${rawMeta.height}`);

  // ── Step 3: Cut frames from the generated strip ───────────────────────────
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpFramesDir = path.join(TMP_DIR, `${task.id}-frames`);

  let framePaths;
  try {
    // Save raw first so cutAndResizeFrames can read it
    const tmpRaw = path.join(TMP_DIR, `${task.id}-raw.png`);
    fs.writeFileSync(tmpRaw, genResult.imageBuffer);
    framePaths = await cutAndResizeFrames(tmpRaw, tmpFramesDir, task.frameCount);
  } catch (err) {
    result.status = 'FAILED';
    result.error = `Frame cutting failed: ${err.message}`;
    log(`ERROR: ${result.error}`);
    return result;
  }

  log(`Cut and resized ${framePaths.length} frames to ${FRAME_SIZE}x${FRAME_SIZE}`);

  // ── Step 4: Build final strip ─────────────────────────────────────────────
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  try {
    await buildStrip(framePaths, task.outputPath, { frameWidth: FRAME_SIZE, frameHeight: FRAME_SIZE });
    log(`Final strip assembled: ${task.outputPath}`);
  } catch (err) {
    result.status = 'FAILED';
    result.error = `Strip assembly failed: ${err.message}`;
    log(`ERROR: ${result.error}`);
    return result;
  }

  // Save individual frames to the designated frames dir
  fs.mkdirSync(task.framesDir, { recursive: true });
  for (let i = 0; i < framePaths.length; i++) {
    const destPath = path.join(task.framesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.copyFileSync(framePaths[i], destPath);
  }
  log(`Individual frames saved to: ${task.framesDir}`);

  // ── Step 5: QC evaluation ─────────────────────────────────────────────────
  log(`Evaluating ${framePaths.length} frames...`);

  let evaluation;
  try {
    evaluation = await evaluateStrip(framePaths);
  } catch (err) {
    result.status = 'FAILED';
    result.error = `Evaluation failed: ${err.message}`;
    log(`ERROR: ${result.error}`);
    return result;
  }

  result.score = evaluation.overallScore;
  result.avgFrameScore = evaluation.avgFrameScore;
  result.consistencyScore = evaluation.consistencyScore;
  result.medianFill = evaluation.medianFill;
  result.issues = evaluation.issues;
  result.frameScores = evaluation.frameResults.map(f => f.score);

  log(`QC Score: ${evaluation.overallScore}/100 (avg frame: ${evaluation.avgFrameScore}, consistency: ${evaluation.consistencyScore})`);
  log(`Median fill: ${evaluation.medianFill}%`);
  log(`Issues: ${evaluation.issues.length > 0 ? evaluation.issues.map(i => `${i.type}(${i.severity})`).join(', ') : 'none'}`);
  log(`Frame scores: [${result.frameScores.join(', ')}]`);

  // ── Step 6: Pass/fail decision ────────────────────────────────────────────

  // Zero-tolerance check for z-stepback — critical pixel issues = contamination risk
  if (task.zeroTolerance) {
    const hasCritical = evaluation.issues.some(i => i.severity === 'critical');
    if (hasCritical) {
      result.status = 'FAILED';
      result.passed = false;
      log(`FAILED — zero-tolerance critical issue: ${evaluation.issues.filter(i => i.severity === 'critical').map(i => i.type).join(', ')}`);
      log(`NOTE: Do NOT retry — needs pro model retry when API recovers`);
      log(`NOTE: Manual visual review also needed for character contamination (second figure)`);
      return result;
    }
    log(`Zero-tolerance: no critical pixel issues (visual contamination needs human review)`);
  }

  if (evaluation.overallScore >= task.passThreshold) {
    result.status = 'PASSED';
    result.passed = true;
    log(`PASSED — ${evaluation.overallScore}/100 >= threshold ${task.passThreshold}/100`);
  } else {
    result.status = 'FAILED';
    result.passed = false;
    log(`FAILED — ${evaluation.overallScore}/100 < threshold ${task.passThreshold}/100`);
    log(`NOTE: Do NOT retry — needs pro model retry when API recovers`);
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('=== ANIMATION REGEN TASKS ===');
  log(`Model: ${MODEL} | Tasks: ${TASKS.map(t => t.id).join(', ')}`);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const results = [];

  for (const task of TASKS) {
    try {
      const r = await runTask(task);
      results.push(r);
    } catch (err) {
      log(`UNHANDLED ERROR in ${task.id}: ${err.message}`);
      results.push({
        taskId: task.id,
        status: 'FAILED',
        error: `Unhandled: ${err.message}`,
        score: null,
        passed: false,
      });
    }
    log('');
  }

  // Print summary
  log('=== FINAL SUMMARY ===');
  for (const r of results) {
    log(`${r.taskId}: ${r.status} | Score: ${r.score ?? 'N/A'}/100 | Pass threshold: ${TASKS.find(t => t.id === r.taskId)?.passThreshold}`);
    if (r.error) log(`  Error: ${r.error}`);
    if (r.issues && r.issues.length > 0) {
      log(`  Issues: ${r.issues.map(i => `${i.type}(${i.severity}) frames[${(i.affectedFrames || []).join(',')}]`).join(', ')}`);
    }
    if (r.frameScores && r.frameScores.length > 0) {
      log(`  Frame scores: [${r.frameScores.join(', ')}]`);
    }
  }

  // Write results JSON
  const summaryPath = path.join(ROOT, 'data/regen-anim-results.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  log(`\nResults written to: ${summaryPath}`);

  return results;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
