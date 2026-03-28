#!/usr/bin/env node
/**
 * TASK-6001: Generate viv baseline animations — idle, dribble, walk
 *
 * Character: viv
 *   - Female basketball player, shorter build (63 in, scale 0.875)
 *   - Long dark brown hair, glasses, dark skin tone
 *   - Brown/dark top, black basketball shorts with white trim, dark sneakers
 *   - Style: 16-bit pixel art, GBA style
 *
 * Animations:
 *   1. viv-idle    — 4 frames, 720x180,  loop: true,  no ball
 *   2. viv-dribble — 8 frames, 1440x180, loop: true,  ball (running dribble)
 *   3. viv-walk    — 8 frames, 1440x180, loop: true,  no ball
 *
 * Model: gemini-2.5-flash-image (pro models returning 500)
 * QC threshold: 80/100 to ACCEPT
 *
 * Output: data/assets/viv-{anim}.png
 * Status: /tmp/viv-baseline-status.json
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { processSprite } = require('../lib/sprite-processor/index');
const { evaluateStrip } = require('../lib/sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const ASSETS_DIR = path.resolve(__dirname, '../data/assets');
const RAW_DIR    = path.resolve(__dirname, '../data/raw-sprites');
const STATUS_FILE = '/tmp/viv-baseline-status.json';
const QC_THRESHOLD = 80;

// Character references (side-profile angle 2 gives a clear side view)
const CHAR_REF  = path.join(ASSETS_DIR, 'viv-angle-2.png');
const BALL_HIGH = path.join(ASSETS_DIR, 'viv-ball-dribble-high.png');

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[STATUS]', JSON.stringify(obj, null, 2));
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Build prompt for viv-idle: 4 frames, 720x180
 * Reference Image 1 is the character angle ref (side-profile).
 */
function buildIdlePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, glasses, long dark brown hair,',
    'skin tone, outfit (brown/dark top, black shorts with white trim, dark sneakers), and proportions.',
    'This character is slightly shorter than average (about 63 inches) — keep their exact build.',
    '',
    'ANIMATION: IDLE — standing still, subtle breathing and weight shift. NO basketball.',
    'Frame 1: neutral upright stance, arms relaxed at sides, weight centered, knees soft.',
    'Frame 2: very slight weight shift right, right shoulder dips slightly, right knee softly bent.',
    'Frame 3: return to center, minimal movement, both knees soft, natural relaxed pose.',
    'Frame 4: very slight weight shift left, left shoulder dips slightly, left knee softly bent.',
    'Loop: Frame 4 flows naturally back into Frame 1.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 4 frames side by side in ONE horizontal strip image, total 720x180 pixels.',
    '- Each frame is exactly 180x180 pixels, NO gaps, NO borders between frames.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet touch near the bottom edge, head near the top edge of each frame.',
    '- Same character size, angle, and baseline in every frame.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00) — NO white, NO gray, NO dark background.',
    'NO green (#00FF00) on the character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

/**
 * Build prompt for viv-dribble: 8 frames, 1440x180
 * Reference Image 1 = char angle ref (side-profile).
 * Reference Image 2 = viv-ball-dribble-high.png (ball position at top of dribble).
 */
function buildDribblePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1,',
    'using Image 2 as reference for the basketball style and size.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, glasses, long dark brown hair,',
    'skin tone, outfit (brown/dark top, black shorts with white trim, dark sneakers), and proportions.',
    'This character is slightly shorter than average (about 63 inches) — keep their exact build.',
    '',
    'ANIMATION: RUNNING DRIBBLE — full run cycle while dribbling basketball on right side.',
    'The basketball from Image 2 should appear correctly scaled.',
    'Frame 1: right foot forward, ball held high at waist on right side, leaning forward.',
    'Frame 2: mid-stride, pushing ball downward, left leg swinging forward.',
    'Frame 3: mid-stride, ball heading toward ground, both feet near ground.',
    'Frame 4: left foot planted, ball hitting ground/bouncing low.',
    'Frame 5: left foot pushing off, ball bouncing back up, right leg forward.',
    'Frame 6: airborne, ball rising to mid-height on right side.',
    'Frame 7: right foot landing, ball rising to hip height.',
    'Frame 8: right foot planted, ball back at high position, completing cycle.',
    'Loop: Frame 8 flows back into Frame 1.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 8 frames side by side in ONE horizontal strip image, total 1440x180 pixels.',
    '- Each frame is exactly 180x180 pixels, NO gaps, NO borders between frames.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet touch near the bottom edge, head near the top edge of each frame.',
    '- Same character size and baseline in every frame.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00) — NO white, NO gray, NO dark background.',
    'NO green (#00FF00) on the character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

/**
 * Build prompt for viv-walk: 8 frames, 1440x180
 * Reference Image 1 = char angle ref (side-profile). No ball.
 */
function buildWalkPrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, glasses, long dark brown hair,',
    'skin tone, outfit (brown/dark top, black shorts with white trim, dark sneakers), and proportions.',
    'This character is slightly shorter than average (about 63 inches) — keep their exact build.',
    '',
    'ANIMATION: WALK CYCLE — standard 8-frame walk, NO basketball, side-profile view.',
    'Frame 1: right foot heel strike, left arm swings forward, weight shifting forward.',
    'Frame 2: right foot flat on ground, weight transferring, left foot lifting.',
    'Frame 3: right foot toe push-off, body rises slightly, left leg swinging through.',
    'Frame 4: both feet briefly off ground, mid-stride float, arms at natural swing.',
    'Frame 5: left foot heel strike, right arm swings forward.',
    'Frame 6: left foot flat, weight transferring, right foot lifting.',
    'Frame 7: left foot toe push-off, body rises slightly, right leg swinging through.',
    'Frame 8: both feet briefly off ground, mid-stride float completing cycle.',
    'Loop: Frame 8 flows naturally back into Frame 1.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 8 frames side by side in ONE horizontal strip image, total 1440x180 pixels.',
    '- Each frame is exactly 180x180 pixels, NO gaps, NO borders between frames.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet touch near the bottom edge, head near the top edge of each frame.',
    '- Same character size and baseline in every frame.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00) — NO white, NO gray, NO dark background.',
    'NO green (#00FF00) on the character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runAnimation({ name, frames, prompt, refs }) {
  const modelId = 'gemini-2.5-flash-image';
  const client = new NanaBananaClient({ model: modelId });

  const rawPath = path.join(RAW_DIR, `viv-${name}-raw.png`);
  const finalPath = path.join(ASSETS_DIR, `viv-${name}.png`);
  const framesDir = path.join(ASSETS_DIR, `viv-${name}-frames`);

  console.log(`\n====== Generating viv-${name} (${frames} frames) ======`);

  // Generate raw image
  const result = await client.generate(prompt, {
    referenceImages: refs,
    aspectRatio: '16:9',
    resolution: '2K',
    model: modelId,
    timeoutMs: 240000, // 4 min
    maxRetries: 4,
  });

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPath, result.imageBuffer);
  console.log(`  Raw saved: ${rawPath}`);

  recordCost(modelId, 'strip', '2K', 1, { character: 'viv', animation: name });

  // Process sprite: cut frames, remove BG, crop to content, build strip
  const processed = await processSprite(rawPath, `viv-${name}`, {
    frameCount: frames,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  console.log(`  Processed: ${processed.frameCount} frames -> ${finalPath}`);

  // Verify dimensions
  const sharp = require('sharp');
  const meta = await sharp(finalPath).metadata();
  console.log(`  Dimensions: ${meta.width}x${meta.height}`);

  // QC: evaluate strip
  const framePaths = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(framesDir, f));

  const evalResult = await evaluateStrip(framePaths);
  console.log(`  QC score: ${evalResult.overallScore}/100 (passed: ${evalResult.passed})`);
  console.log(`  Avg frame score: ${evalResult.avgFrameScore}, consistency: ${evalResult.consistencyScore}`);
  if (evalResult.issues.length > 0) {
    console.log(`  Issues: ${evalResult.issues.map(i => i.type).join(', ')}`);
  }

  const accepted = evalResult.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : 'FAILED';

  console.log(`  Status: ${qcStatus} (${evalResult.overallScore}/100, threshold ${QC_THRESHOLD})`);

  return {
    name,
    frames: processed.frameCount,
    rawPath,
    finalPath,
    framesDir,
    width: meta.width,
    height: meta.height,
    qcScore: evalResult.overallScore,
    qcStatus,
    evalResult,
  };
}

async function main() {
  writeStatus({ status: 'running', startedAt: new Date().toISOString() });

  // Validate refs exist
  if (!fs.existsSync(CHAR_REF)) {
    writeStatus({ status: 'error', error: `Character ref not found: ${CHAR_REF}` });
    process.exit(1);
  }
  if (!fs.existsSync(BALL_HIGH)) {
    writeStatus({ status: 'error', error: `Ball ref not found: ${BALL_HIGH}` });
    process.exit(1);
  }

  const results = {};

  // ── 1. viv-idle ────────────────────────────────────────────────────────
  try {
    writeStatus({ status: 'generating viv-idle', startedAt: new Date().toISOString() });
    results.idle = await runAnimation({
      name: 'idle',
      frames: 4,
      prompt: buildIdlePrompt(),
      refs: [CHAR_REF],
    });
  } catch (err) {
    console.error('ERROR viv-idle:', err.message);
    results.idle = { name: 'idle', qcStatus: 'ERROR', error: err.message };
  }

  // ── 2. viv-dribble ─────────────────────────────────────────────────────
  try {
    writeStatus({ status: 'generating viv-dribble', startedAt: new Date().toISOString() });
    results.dribble = await runAnimation({
      name: 'dribble',
      frames: 8,
      prompt: buildDribblePrompt(),
      refs: [CHAR_REF, BALL_HIGH],
    });
  } catch (err) {
    console.error('ERROR viv-dribble:', err.message);
    results.dribble = { name: 'dribble', qcStatus: 'ERROR', error: err.message };
  }

  // ── 3. viv-walk ────────────────────────────────────────────────────────
  try {
    writeStatus({ status: 'generating viv-walk', startedAt: new Date().toISOString() });
    results.walk = await runAnimation({
      name: 'walk',
      frames: 8,
      prompt: buildWalkPrompt(),
      refs: [CHAR_REF],
    });
  } catch (err) {
    console.error('ERROR viv-walk:', err.message);
    results.walk = { name: 'walk', qcStatus: 'ERROR', error: err.message };
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const accepted = Object.values(results).filter(r => r.qcStatus === 'ACCEPTED').map(r => r.name);
  const failed   = Object.values(results).filter(r => r.qcStatus !== 'ACCEPTED').map(r => `${r.name}(${r.qcStatus}:${r.qcScore ?? r.error})`);

  console.log('\n====== SUMMARY ======');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  viv-${k}: ${v.qcStatus} score=${v.qcScore ?? 'N/A'} dims=${v.width ?? '?'}x${v.height ?? '?'}`);
  }
  console.log(`  Accepted: ${accepted.join(', ') || 'none'}`);
  console.log(`  Failed:   ${failed.join(', ') || 'none'}`);

  writeStatus({
    status: 'done',
    completedAt: new Date().toISOString(),
    results,
    accepted,
    failed,
  });
}

main().catch(err => {
  writeStatus({ status: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
