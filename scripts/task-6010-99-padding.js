#!/usr/bin/env node
/**
 * TASK-6010: Apply 160x160-within-180x180 padding fix to 99-static-dribble.png
 *
 * Input:  data/assets/99-static-dribble.png  (6-frame 1080x180 strip)
 * Output: data/assets/99-static-dribble.png  (overwrite, same dims, padded)
 * QC threshold: >= 80/100
 *
 * Precedent: identical fix applied to z-dribble, viv-idle, joaquin-static-dribble.
 * Root cause: all 6 frames are 98.9-100% fill height — no padding was applied
 * at generation time. cropToContent + embedWithPadding brings it within spec.
 */
'use strict';

const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const { removeBackground, cropToContent, evaluateStrip } = require('../lib/sprite-processor/index');

const BASE_DIR      = path.resolve(__dirname, '..');
const ASSETS_DIR    = path.join(BASE_DIR, 'data/assets');
const CONTRACT_PATH = path.join(BASE_DIR, 'data/animation-contract.json');

const INPUT_PATH    = path.join(ASSETS_DIR, '99-static-dribble.png');
const FRAMES_DIR    = path.join(ASSETS_DIR, '99-static-dribble-frames');
const TEMP_DIR      = path.join(BASE_DIR, 'data/.tmp-99-static-dribble-padding');
const FRAME_COUNT   = 6;
const FRAME_SIZE    = 180;
const CONTENT_AREA  = 160; // 10px margin all sides
const QC_THRESHOLD  = 80;

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
  console.log('\n====== TASK-6010: 99-static-dribble padding fix ======');

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`ERROR: Input not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  const inputMeta = await sharp(INPUT_PATH).metadata();
  console.log(`Input: ${inputMeta.width}x${inputMeta.height}`);

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // Step 1: Cut into 6 frames
  console.log(`\nStep 1: Cutting ${FRAME_COUNT} frames from strip...`);
  const frameWidth = Math.floor(inputMeta.width / FRAME_COUNT);
  const cutPaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cutPath = path.join(TEMP_DIR, `cut-${String(i).padStart(3, '0')}.png`);
    await sharp(INPUT_PATH)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: inputMeta.height })
      .toFile(cutPath);
    cutPaths.push(cutPath);
    console.log(`  Frame ${i}: cut at x=${i * frameWidth}, width=${frameWidth}`);
  }

  // Step 2: cropToContent (the source frames already have transparent BG from prior
  // processing — but we still need to handle any residual green pixels)
  console.log(`\nStep 2: Background removal + cropToContent...`);
  const croppedPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    // Check if the source already has alpha/transparency
    const meta = await sharp(cutPaths[i]).metadata();

    let workPath = cutPaths[i];
    // If the frame has a green background (non-alpha), remove it first
    if (meta.channels < 4 || meta.hasAlpha === false) {
      const cleanPath = path.join(TEMP_DIR, `clean-${String(i).padStart(3, '0')}.png`);
      await removeBackground(cutPaths[i], cleanPath, {
        hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
      });
      workPath = cleanPath;
    }

    const croppedPath = path.join(TEMP_DIR, `cropped-${String(i).padStart(3, '0')}.png`);
    await cropToContent(workPath, croppedPath, {
      width: CONTENT_AREA,
      height: CONTENT_AREA,
      padding: 2,
    });
    croppedPaths.push(croppedPath);

    const croppedMeta = await sharp(croppedPath).metadata();
    console.log(`  Frame ${i}: cropped content -> ${croppedMeta.width}x${croppedMeta.height}`);
  }

  // Step 3: Embed each cropped frame in 180x180 with 10px margin
  console.log(`\nStep 3: Embedding in 180x180 with padding (160x160 content area)...`);
  const paddedPaths = [];
  for (let i = 0; i < croppedPaths.length; i++) {
    const paddedPath = path.join(TEMP_DIR, `padded-${String(i).padStart(3, '0')}.png`);
    await embedWithPadding(croppedPaths[i], paddedPath);
    paddedPaths.push(paddedPath);

    const paddedMeta = await sharp(paddedPath).metadata();
    console.log(`  Frame ${i}: padded -> ${paddedMeta.width}x${paddedMeta.height}`);
  }

  // Step 4: Assemble 6-frame horizontal strip 1080x180
  console.log(`\nStep 4: Assembling 1080x180 strip...`);
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
    .toFile(INPUT_PATH);  // overwrite in place

  const outMeta = await sharp(INPUT_PATH).metadata();
  console.log(`  Strip saved: ${INPUT_PATH} (${outMeta.width}x${outMeta.height})`);

  if (outMeta.width !== 1080 || outMeta.height !== 180) {
    throw new Error(`Unexpected dimensions: ${outMeta.width}x${outMeta.height}, expected 1080x180`);
  }

  // Step 5: Save individual frames
  console.log(`\nStep 5: Saving individual frames to ${FRAMES_DIR}...`);
  for (let i = 0; i < paddedPaths.length; i++) {
    const destPath = path.join(FRAMES_DIR, `frame-${String(i).padStart(3, '0')}.png`);
    fs.copyFileSync(paddedPaths[i], destPath);
    console.log(`  Saved frame-${String(i).padStart(3, '0')}.png`);
  }

  // Step 6: QC evaluation
  console.log(`\nStep 6: QC evaluation...`);
  const framePaths = fs.readdirSync(FRAMES_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(FRAMES_DIR, f));

  const qc = await evaluateStrip(framePaths);
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  if (qc.issues.length > 0) {
    for (const iss of qc.issues) {
      console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
    }
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : (qc.overallScore >= 70 ? 'CONDITIONAL' : 'FAILED');
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Step 7: Update animation-contract.json
  if (accepted) {
    console.log(`\nStep 7: Updating animation-contract.json...`);
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

    if (!contract.characters) contract.characters = {};
    if (!contract.characters['99']) contract.characters['99'] = { animations: {} };
    if (!contract.characters['99'].animations) contract.characters['99'].animations = {};

    contract.characters['99'].animations['static-dribble'] = {
      frames: FRAME_COUNT,
      frameWidth: 180,
      frameHeight: 180,
      stripWidth: 1080,
      stripHeight: 180,
      fps: 8,
      loop: true,
      hasBall: true,
      category: 'ball-handling',
      action: 'stationary dribble, ball bouncing at side',
      qcStatus: 'ACCEPTED',
      qcScore: `${qc.overallScore}/100`,
      qcNote: `TASK-6010 — 160x160-within-180x180 padding fix applied. All ${FRAME_COUNT} frames reprocessed. Upgraded from FAILED 74/100.`,
      file: 'data/assets/99-static-dribble.png',
    };

    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
    // Validate JSON parses
    JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    console.log(`  animation-contract.json updated — characters["99"].animations["static-dribble"] = ACCEPTED ${qc.overallScore}/100`);
  } else {
    console.log(`\nStep 7: SKIPPING contract update (QC did not pass: ${qc.overallScore}/100 < ${QC_THRESHOLD})`);
    // Still update with actual score
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    if (contract.characters && contract.characters['99'] && contract.characters['99'].animations && contract.characters['99'].animations['static-dribble']) {
      contract.characters['99'].animations['static-dribble'].qcScore = `${qc.overallScore}/100`;
      contract.characters['99'].animations['static-dribble'].qcStatus = qcStatus;
      contract.characters['99'].animations['static-dribble'].qcNote = `TASK-6010 — padding fix applied but score ${qc.overallScore}/100 below threshold. Issues: ${qc.issues.map(i => i.type).join(', ')}`;
      fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
    }
  }

  // Cleanup temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log('\n====== TASK-6010 COMPLETE ======');
  console.log(`  Input:    ${INPUT_PATH}`);
  console.log(`  Output:   ${INPUT_PATH} (overwritten)`);
  console.log(`  QC:       ${qcStatus} ${qc.overallScore}/100`);
  console.log(`  Frames:   ${FRAMES_DIR}`);

  return {
    qcStatus,
    qcScore: qc.overallScore,
    accepted,
    outputPath: INPUT_PATH,
    framesDir: FRAMES_DIR,
  };
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
