#!/usr/bin/env node
/**
 * TASK-6003: Regen breezy-jump
 *
 * Current: 75/100 CONDITIONAL — target >= 85/100 to upgrade to ACCEPTED
 * Prior issues: flat arc, frame-to-frame identity drift, inconsistent size
 *
 * Spec:
 *   - Character: breezy, use breezy-angle-2.png (side-L profile) as char ref
 *   - 5 frames, 900x180, NO ball, fps 8, loop false
 *   - Clear jump arc: crouch -> launch -> peak -> descend -> land
 *
 * Padding fix: 160x160-within-180x180
 * Model: gemini-2.5-flash-image
 * QC threshold: 85/100 — if met, overwrite data/assets/breezy-jump.png + update contract
 *               if not met, log failure, do NOT overwrite, do NOT retry
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { removeBackground, cropToContent, evaluateStrip } = require('../lib/sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const BASE_DIR      = path.resolve(__dirname, '..');
const ASSETS_DIR    = path.join(BASE_DIR, 'data/assets');
const RAW_DIR       = path.join(BASE_DIR, 'data/raw-sprites');
const CONTRACT_PATH = path.join(BASE_DIR, 'data/animation-contract.json');
const STATUS_FILE   = '/tmp/regen-breezy-jump-status.json';
const MODEL_ID      = 'gemini-2.5-flash-image';
const QC_THRESHOLD  = 85;

const CHAR_REF   = path.join(ASSETS_DIR, 'breezy-angle-2.png'); // side-L profile
const OUTPUT_PATH = path.join(ASSETS_DIR, 'breezy-jump.png');
const RAW_PATH    = path.join(RAW_DIR, 'breezy-jump-regen2-raw.png');
const FRAMES_DIR  = path.join(ASSETS_DIR, 'breezy-jump-frames');
const TEMP_DIR    = path.join(BASE_DIR, 'data/.tmp-breezy-jump-regen');

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[STATUS]', JSON.stringify(obj));
}

function buildJumpPrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, brown skin, long dark braids,',
    'same jersey, shorts, sneakers, and proportions. Side-profile view throughout.',
    'CRITICAL: Character must remain IDENTICAL across all 5 frames — same size, same style.',
    '',
    'ANIMATION: VERTICAL JUMP — clear jump arc from crouch to peak to landing. NO basketball.',
    '',
    'Frame-by-frame breakdown (MANDATORY — follow exactly):',
    'Frame 1 — CROUCH/PREPARATION:',
    '  - Knees sharply bent, deep squat position',
    '  - Torso leaning slightly forward, head down',
    '  - Both feet flat on the ground',
    '  - Arms pulled back and low, coiling for launch',
    '  - Character is SHORTER than normal (crouched)',
    '',
    'Frame 2 — LAUNCH/TAKEOFF:',
    '  - Legs rapidly extending upward from the crouch',
    '  - Toes just leaving or barely off the ground',
    '  - Arms driving powerfully upward',
    '  - Body still relatively close to ground level',
    '',
    'Frame 3 — PEAK (maximum height):',
    '  - BOTH FEET CLEARLY OFF THE GROUND — character is airborne',
    '  - Body at maximum height, highest point of the jump',
    '  - Legs slightly tucked or extended, arms up high',
    '  - Visible gap between feet and ground baseline',
    '',
    'Frame 4 — DESCENT:',
    '  - Body dropping downward from peak',
    '  - Feet still off the ground, legs extending downward',
    '  - Arms beginning to lower for balance',
    '',
    'Frame 5 — LANDING:',
    '  - Both feet back on the ground',
    '  - Knees bent absorbing the impact of landing',
    '  - Slight forward lean, arms out for balance',
    '  - Similar pose to Frame 1 but landing instead of preparing',
    '',
    'SIZE REQUIREMENTS:',
    '  - Frame 1: character is SHORT (crouched) ~65-70% frame height',
    '  - Frame 2: character is MEDIUM height, extending upward',
    '  - Frame 3: character is at PEAK height, feet well above ground baseline',
    '  - Frame 4: character descending, feet elevated',
    '  - Frame 5: character FULL HEIGHT again on ground, ~80-85% frame height',
    '  - DO NOT make all frames the same size — the vertical position must vary!',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 5 frames side by side in ONE horizontal strip image, total 900x180 pixels.',
    '- Each frame is exactly 180x180 pixels, NO gaps, NO borders between frames.',
    '- The character should shift VERTICALLY within each frame to show jump height.',
    '- Same character identity in every frame — no style drift.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00) — NO white, NO gray, NO dark background.',
    'NO green (#00FF00) on the character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

async function embedWithPadding(contentPath, outputPath) {
  const FRAME_SIZE   = 180;
  const CONTENT_AREA = 160;

  const scaled = await sharp(contentPath)
    .resize(CONTENT_AREA, CONTENT_AREA, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  const scaledMeta = await sharp(scaled).metadata();
  const left = Math.round((FRAME_SIZE - scaledMeta.width)  / 2);
  const top  = Math.round((FRAME_SIZE - scaledMeta.height) / 2);

  await sharp({
    create: {
      width: FRAME_SIZE,
      height: FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: scaled, left, top }])
    .png()
    .toFile(outputPath);

  return outputPath;
}

async function main() {
  writeStatus({ status: 'starting' });

  if (!fs.existsSync(CHAR_REF)) {
    writeStatus({ status: 'error', error: `Char ref not found: ${CHAR_REF}` });
    process.exit(1);
  }

  console.log('\n====== Regenerating breezy-jump (5 frames, 900x180) ======');
  console.log(`QC threshold: ${QC_THRESHOLD}/100 to upgrade CONDITIONAL -> ACCEPTED`);

  const client = new NanaBananaClient({ model: MODEL_ID });

  // Generate raw image
  writeStatus({ status: 'generating' });
  const prompt = buildJumpPrompt();

  const result = await client.generate(prompt, {
    referenceImages: [CHAR_REF],
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000,
    maxRetries: 4,
  });

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, result.imageBuffer);
  console.log(`  Raw saved: ${RAW_PATH}`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'breezy', animation: 'jump' });

  const rawMeta = await sharp(RAW_PATH).metadata();
  console.log(`  Raw dimensions: ${rawMeta.width}x${rawMeta.height}`);

  const FRAME_COUNT = 5;
  const frameWidth  = Math.floor(rawMeta.width / FRAME_COUNT);
  const frameHeight = rawMeta.height;

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // Step 1: Cut raw frames
  console.log(`  Step 1: cutting ${FRAME_COUNT} frames (${frameWidth}x${frameHeight})`);
  const cutPaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cutPath = path.join(TEMP_DIR, `cut-${String(i).padStart(3,'0')}.png`);
    await sharp(RAW_PATH)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: frameHeight })
      .toFile(cutPath);
    cutPaths.push(cutPath);
  }

  // Step 2: Remove green background
  console.log(`  Step 2: background removal`);
  const cleanPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    const cleanPath = path.join(TEMP_DIR, `clean-${String(i).padStart(3,'0')}.png`);
    await removeBackground(cutPaths[i], cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });
    cleanPaths.push(cleanPath);
  }

  // Step 3: Crop to content + padding fix (160x160 within 180x180)
  console.log(`  Step 3: crop + padding fix`);
  const paddedPaths = [];
  for (let i = 0; i < cleanPaths.length; i++) {
    const croppedPath = path.join(TEMP_DIR, `cropped-${String(i).padStart(3,'0')}.png`);
    await cropToContent(cleanPaths[i], croppedPath, {
      width: 160, height: 160, padding: 2,
    });
    const paddedPath = path.join(TEMP_DIR, `padded-${String(i).padStart(3,'0')}.png`);
    await embedWithPadding(croppedPath, paddedPath);
    paddedPaths.push(paddedPath);
  }

  // Step 4: Assemble 900x180 strip
  console.log(`  Step 4: assembling 900x180 strip`);
  const FRAME_SIZE = 180;

  const composites = await Promise.all(
    paddedPaths.map(async (fp, i) => {
      const buf = await sharp(fp)
        .resize(FRAME_SIZE, FRAME_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      return { input: buf, left: i * FRAME_SIZE, top: 0 };
    })
  );

  const tmpOutputPath = path.join(TEMP_DIR, 'breezy-jump-regen.png');
  await sharp({
    create: {
      width:  FRAME_SIZE * FRAME_COUNT,
      height: FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(tmpOutputPath);

  const outMeta = await sharp(tmpOutputPath).metadata();
  console.log(`  Assembled: ${outMeta.width}x${outMeta.height}`);

  if (outMeta.width !== 900 || outMeta.height !== 180) {
    console.error(`  Wrong output dimensions: ${outMeta.width}x${outMeta.height}, expected 900x180`);
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    writeStatus({ status: 'error', error: `Wrong dimensions: ${outMeta.width}x${outMeta.height}` });
    process.exit(1);
  }

  // Step 5: QC evaluation on temp frames
  console.log(`  Step 5: QC evaluation`);
  const qc = await evaluateStrip(paddedPaths);
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  for (const r of qc.frameResults) {
    const issueStr = r.issues.map(i => `${i.type}(${i.severity})`).join(', ') || 'none';
    console.log(`  Frame ${qc.frameResults.indexOf(r)}: ${r.score}/100 fill=${r.metrics.fillHeight}% issues: ${issueStr}`);
  }
  if (qc.issues.length > 0) {
    for (const iss of qc.issues) {
      console.log(`  Strip issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
    }
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;

  if (accepted) {
    // Overwrite the final asset
    fs.copyFileSync(tmpOutputPath, OUTPUT_PATH);
    console.log(`\n  ACCEPTED (${qc.overallScore}/100 >= ${QC_THRESHOLD}) — overwrote ${OUTPUT_PATH}`);

    // Save individual frames to breezy-jump-frames/
    for (let i = 0; i < paddedPaths.length; i++) {
      const destPath = path.join(FRAMES_DIR, `frame-${String(i).padStart(3,'0')}.png`);
      fs.copyFileSync(paddedPaths[i], destPath);
    }

    // Update animation-contract.json
    try {
      const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      if (contract.animations && contract.animations.jump) {
        contract.animations.jump.qcStatus = 'ACCEPTED';
        contract.animations.jump.qcScore  = `${qc.overallScore}/100`;
        contract.animations.jump.qcNote   = `TASK-6003 regen — clear jump arc, ${FRAME_COUNT} frames. ${qc.overallScore}/100 ACCEPTED.`;
      }
      fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
      JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); // validate
      console.log(`  Updated contract: animations.jump qcStatus -> ACCEPTED (${qc.overallScore}/100)`);
    } catch (err) {
      console.error(`  Failed to update contract: ${err.message}`);
    }

    writeStatus({
      status: 'done',
      result: 'ACCEPTED',
      score: qc.overallScore,
      threshold: QC_THRESHOLD,
      outputPath: OUTPUT_PATH,
      qc: { overallScore: qc.overallScore, avgFrameScore: qc.avgFrameScore, consistencyScore: qc.consistencyScore },
    });

  } else {
    console.log(`\n  FAILED (${qc.overallScore}/100 < ${QC_THRESHOLD}) — existing breezy-jump.png NOT overwritten`);
    console.log(`  Per task spec: do NOT retry. Logging failure.`);
    writeStatus({
      status: 'done',
      result: 'FAILED',
      score: qc.overallScore,
      threshold: QC_THRESHOLD,
      note: 'Score below threshold — existing file preserved, no retry per spec',
      qc: {
        overallScore: qc.overallScore,
        avgFrameScore: qc.avgFrameScore,
        consistencyScore: qc.consistencyScore,
        issues: qc.issues,
        frameScores: qc.frameResults.map(r => r.score),
      },
    });
  }

  // Cleanup temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  writeStatus({ status: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
