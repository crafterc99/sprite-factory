#!/usr/bin/env node
/**
 * TASK-6011: Generate bron-test-walk.png
 *
 * Character: bron-test
 *   - Athletic basketball player, 72 in / 185 lbs
 *   - Style: 16-bit pixel art, GBA style
 *   - Portrait: data/assets/bron-testfull.png
 *   - Char ref: data/assets/bron-test-angle-2.png (side-L profile)
 *
 * Animation: walk cycle, 8 frames, 1440x180, fps 10, loop true, no ball
 * Padding fix: 160x160-within-180x180
 * Model: gemini-2.5-flash-image
 * QC threshold: 80/100
 *
 * Output: data/assets/bron-test-walk.png
 */
'use strict';

const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { removeBackground, cropToContent, evaluateStrip } = require('../lib/sprite-processor/index');

// cost-tracker is optional — log gracefully if missing
let recordCost = () => {};
try {
  const ct = require('../middleware/cost-tracker');
  if (ct && ct.recordCost) recordCost = ct.recordCost;
} catch (_) {}

const BASE_DIR      = path.resolve(__dirname, '..');
const ASSETS_DIR    = path.join(BASE_DIR, 'data/assets');
const RAW_DIR       = path.join(BASE_DIR, 'data/raw-sprites');
const CONTRACT_PATH = path.join(BASE_DIR, 'data/animation-contract.json');
const MODEL_ID      = 'gemini-2.5-flash-image';
const QC_THRESHOLD  = 80;

const CHAR_REF   = path.join(ASSETS_DIR, 'bron-test-angle-2.png');
const OUTPUT     = path.join(ASSETS_DIR, 'bron-test-walk.png');
const FRAMES_DIR = path.join(ASSETS_DIR, 'bron-test-walk-frames');
const RAW_PATH   = path.join(RAW_DIR, 'bron-test-walk-raw.png');
const TEMP_DIR   = path.join(BASE_DIR, 'data/.tmp-bron-test-walk');

const FRAME_COUNT   = 8;
const EXPECTED_W    = 1440;
const FRAME_SIZE    = 180;
const CONTENT_AREA  = 160;

function buildWalkPrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. This is a side-profile view of the character.',
    'Maintain their exact appearance throughout all frames.',
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

async function embedWithPadding(contentPath, outputPath) {
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
  console.log('\n====== TASK-6011: bron-test-walk generation ======');

  if (!fs.existsSync(CHAR_REF)) {
    console.error(`ERROR: Char ref not found: ${CHAR_REF}`);
    process.exit(1);
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const client = new NanaBananaClient({ model: MODEL_ID });

  // Generate raw strip
  console.log(`\nGenerating bron-test-walk (8 frames) via ${MODEL_ID}...`);
  const result = await client.generate(buildWalkPrompt(), {
    referenceImages: [CHAR_REF],
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000,
    maxRetries: 4,
  });

  fs.writeFileSync(RAW_PATH, result.imageBuffer);
  const rawMeta = await sharp(RAW_PATH).metadata();
  console.log(`  Raw saved: ${RAW_PATH} (${rawMeta.width}x${rawMeta.height})`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'bron-test', animation: 'walk' });

  // Cut frames
  console.log(`\nStep 1: Cutting ${FRAME_COUNT} frames...`);
  const frameWidth = Math.floor(rawMeta.width / FRAME_COUNT);
  const cutPaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cutPath = path.join(TEMP_DIR, `cut-${String(i).padStart(3, '0')}.png`);
    await sharp(RAW_PATH)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: rawMeta.height })
      .toFile(cutPath);
    cutPaths.push(cutPath);
  }

  // Remove background
  console.log(`\nStep 2: Background removal...`);
  const cleanPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    const cleanPath = path.join(TEMP_DIR, `clean-${String(i).padStart(3, '0')}.png`);
    await removeBackground(cutPaths[i], cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });
    cleanPaths.push(cleanPath);
  }

  // cropToContent + embedWithPadding
  console.log(`\nStep 3: Crop + padding fix (160x160 within 180x180)...`);
  const paddedPaths = [];
  for (let i = 0; i < cleanPaths.length; i++) {
    const croppedPath = path.join(TEMP_DIR, `cropped-${String(i).padStart(3, '0')}.png`);
    await cropToContent(cleanPaths[i], croppedPath, {
      width: CONTENT_AREA, height: CONTENT_AREA, padding: 2,
    });
    const paddedPath = path.join(TEMP_DIR, `padded-${String(i).padStart(3, '0')}.png`);
    await embedWithPadding(croppedPath, paddedPath);
    paddedPaths.push(paddedPath);
  }

  // Assemble strip
  console.log(`\nStep 4: Assembling ${EXPECTED_W}x180 strip...`);
  const composites = await Promise.all(
    paddedPaths.map(async (fp, i) => {
      const buf = await sharp(fp)
        .resize(FRAME_SIZE, FRAME_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      return { input: buf, left: i * FRAME_SIZE, top: 0 };
    })
  );

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
    .toFile(OUTPUT);

  const outMeta = await sharp(OUTPUT).metadata();
  console.log(`  Strip saved: ${OUTPUT} (${outMeta.width}x${outMeta.height})`);

  if (outMeta.width !== EXPECTED_W || outMeta.height !== 180) {
    throw new Error(`Wrong dimensions: ${outMeta.width}x${outMeta.height}, expected ${EXPECTED_W}x180`);
  }

  // Save individual frames
  for (let i = 0; i < paddedPaths.length; i++) {
    const destPath = path.join(FRAMES_DIR, `frame-${String(i).padStart(3, '0')}.png`);
    fs.copyFileSync(paddedPaths[i], destPath);
  }
  console.log(`  Frames saved to ${FRAMES_DIR}`);

  // QC evaluation
  console.log(`\nStep 5: QC evaluation...`);
  const framePaths = fs.readdirSync(FRAMES_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(FRAMES_DIR, f));

  const qc = await evaluateStrip(framePaths);
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  for (const iss of qc.issues) {
    console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : (qc.overallScore >= 70 ? 'CONDITIONAL' : 'FAILED');
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Update animation-contract.json
  console.log(`\nUpdating animation-contract.json...`);
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  if (!contract.characters) contract.characters = {};
  if (!contract.characters['bron-test']) contract.characters['bron-test'] = { animations: {} };
  if (!contract.characters['bron-test'].animations) contract.characters['bron-test'].animations = {};

  contract.characters['bron-test'].animations['walk'] = {
    frames: FRAME_COUNT,
    frameWidth: 180,
    frameHeight: 180,
    stripWidth: outMeta.width,
    stripHeight: 180,
    fps: 10,
    loop: true,
    hasBall: false,
    category: 'locomotion',
    action: 'walk cycle, no ball',
    qcStatus,
    qcScore: `${qc.overallScore}/100`,
    qcNote: `TASK-6011 — bron-test walk generation. ${FRAME_COUNT} frames, ${outMeta.width}x180 confirmed. Padding fix applied.`,
    file: 'data/assets/bron-test-walk.png',
  };

  fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); // validate
  console.log(`  Contract updated: characters.bron-test.animations.walk = ${qcStatus} ${qc.overallScore}/100`);

  // Cleanup temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log('\n====== TASK-6011 COMPLETE ======');
  console.log(`  Output: ${OUTPUT}`);
  console.log(`  QC: ${qcStatus} ${qc.overallScore}/100`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
