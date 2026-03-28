#!/usr/bin/env node
/**
 * TASK-6005 — Reprocess viv-idle with padding fix.
 *
 * Fix: each frame's character content is resized to fit within 160x160
 * (10px margin on all sides), then embedded centered in a 180x180
 * transparent canvas.  This is identical to the UPLOAD-BGX-001 fix that
 * brought z-dribble from FAILED (68/100) to 100/100.
 *
 * Input:  data/raw-sprites/viv-idle-raw.png  (4-frame horizontal strip, 1344x768)
 * Output: data/assets/viv-idle.png           (720x180, 4 frames)
 *         data/assets/viv-idle-frames/       (individual 180x180 PNGs)
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');

const BASE_DIR   = path.resolve(__dirname, '..');
const RAW_PATH   = path.join(BASE_DIR, 'data/raw-sprites/viv-idle-raw.png');
const ASSETS_DIR = path.join(BASE_DIR, 'data/assets');
const OUTPUT_PATH = path.join(ASSETS_DIR, 'viv-idle.png');
const FRAMES_DIR  = path.join(ASSETS_DIR, 'viv-idle-frames');
const TEMP_DIR    = path.join(BASE_DIR, 'data/.tmp-viv-idle-reprocess');

const {
  removeBackground,
  cropToContent,
  evaluateStrip,
} = require('../lib/sprite-processor/index');

const STATUS_FILE = '/tmp/reprocess-viv-idle-status.json';

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[status]', JSON.stringify(obj, null, 2));
}

// ── Padding embed ────────────────────────────────────────────────────────────
// Resize contentPath so character fits within 160x160, then composite centered
// onto a fresh 180x180 transparent canvas.
async function embedWithPadding(contentPath, outputPath) {
  const FRAME_SIZE   = 180;
  const CONTENT_AREA = 160; // 10px margin all sides

  // Fit character within 160x160 (preserves aspect ratio, transparent fill)
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  writeStatus({ status: 'starting', rawPath: RAW_PATH });

  if (!fs.existsSync(RAW_PATH)) {
    writeStatus({ status: 'error', error: 'Raw not found: ' + RAW_PATH });
    process.exit(1);
  }

  const meta = await sharp(RAW_PATH).metadata();
  console.log(`Raw: ${meta.width}x${meta.height}`);

  if (meta.width !== 1344 || meta.height !== 768) {
    writeStatus({ status: 'error', error: `Unexpected raw dimensions: ${meta.width}x${meta.height}, expected 1344x768` });
    process.exit(1);
  }

  const FRAME_COUNT = 4;
  const frameWidth  = Math.floor(meta.width / FRAME_COUNT); // 336
  const frameHeight = meta.height;                           // 768

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // Step 1: Cut raw into 4 individual frames
  console.log(`\nStep 1: cutting ${FRAME_COUNT} frames (${frameWidth}x${frameHeight} each)`);
  const cutPaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cutPath = path.join(TEMP_DIR, `cut-${String(i).padStart(3,'0')}.png`);
    await sharp(RAW_PATH)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: frameHeight })
      .toFile(cutPath);
    cutPaths.push(cutPath);
  }
  console.log(`  Cut ${cutPaths.length} frames`);

  // Step 2: Remove green background from each frame
  console.log(`\nStep 2: background removal (HSV chroma key)`);
  const cleanPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    const cleanPath = path.join(TEMP_DIR, `clean-${String(i).padStart(3,'0')}.png`);
    await removeBackground(cutPaths[i], cleanPath, {
      hueMin: 80,
      hueMax: 160,
      satMin: 0.25,
      valMin: 0.25,
    });
    cleanPaths.push(cleanPath);
    process.stdout.write(`  BG removal: ${i + 1}/${FRAME_COUNT}\r`);
  }
  console.log(`  BG removal: ${FRAME_COUNT}/${FRAME_COUNT} done`);

  // Step 3: cropToContent then embedWithPadding (160x160 within 180x180)
  console.log(`\nStep 3: cropToContent -> embed in 180x180 with 10px margin`);
  const paddedPaths = [];
  for (let i = 0; i < cleanPaths.length; i++) {
    // 3a: Crop to bounding box of visible content (standard pipeline crop)
    const croppedPath = path.join(TEMP_DIR, `cropped-${String(i).padStart(3,'0')}.png`);
    await cropToContent(cleanPaths[i], croppedPath, {
      width: 160,
      height: 160,
      padding: 2, // small inner crop padding before embedding
    });

    // 3b: Embed centered in 180x180 with 10px margin guaranteeing no edge bleed
    const paddedPath = path.join(TEMP_DIR, `padded-${String(i).padStart(3,'0')}.png`);
    await embedWithPadding(croppedPath, paddedPath);
    paddedPaths.push(paddedPath);

    process.stdout.write(`  Frame ${i + 1}/${FRAME_COUNT} padded\r`);
  }
  console.log(`  Padded ${paddedPaths.length} frames`);

  // Step 4: Assemble 4 frames into 720x180 strip
  console.log(`\nStep 4: assembling 720x180 strip`);
  const FRAME_SIZE = 180;

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
    .toFile(OUTPUT_PATH);

  console.log(`  Strip saved: ${OUTPUT_PATH}`);

  // Step 5: Save individual frames to viv-idle-frames/
  console.log(`\nStep 5: saving individual frames`);
  for (let i = 0; i < paddedPaths.length; i++) {
    const destPath = path.join(FRAMES_DIR, `frame-${i}.png`);
    fs.copyFileSync(paddedPaths[i], destPath);
    console.log(`  frame-${i}.png saved`);
  }

  // Step 6: Verify output dimensions
  const outMeta = await sharp(OUTPUT_PATH).metadata();
  console.log(`\nOutput dimensions: ${outMeta.width}x${outMeta.height} (expected 720x180)`);
  if (outMeta.width !== 720 || outMeta.height !== 180) {
    writeStatus({ status: 'error', error: `Wrong output dimensions: ${outMeta.width}x${outMeta.height}` });
    process.exit(1);
  }

  // Step 7: QC evaluation
  console.log(`\nStep 7: QC evaluation`);
  const framePaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    framePaths.push(path.join(FRAMES_DIR, `frame-${i}.png`));
  }
  const qc = await evaluateStrip(framePaths);

  console.log(`\n=== QC RESULTS ===`);
  console.log(`Overall score:    ${qc.overallScore}/100`);
  console.log(`Avg frame score:  ${qc.avgFrameScore}/100`);
  console.log(`Consistency:      ${qc.consistencyScore}/100`);
  console.log(`Median fill:      ${qc.medianFill}%`);
  console.log(`Passed:           ${qc.passed}`);

  console.log(`\nPer-frame scores:`);
  qc.frameResults.forEach((r, i) => {
    const issueStr = r.issues.map(iss => `${iss.type}(${iss.severity})`).join(', ') || 'none';
    console.log(`  Frame ${i}: ${r.score}/100  fill=${r.metrics.fillHeight}%  coverage=${r.metrics.coverage}%  issues: ${issueStr}`);
  });

  if (qc.issues.length > 0) {
    console.log(`\nStrip issues:`);
    for (const issue of qc.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.msg} (frames: ${issue.affectedFrames.join(',')})`);
    }
  }

  // Cleanup temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log(`\nTemp dir cleaned`);

  const THRESHOLD = 80;
  const accepted  = qc.overallScore >= THRESHOLD;

  if (accepted) {
    console.log(`\nPASSED: ${qc.overallScore}/100 >= ${THRESHOLD} threshold  — ACCEPTED`);
    console.log(`Output:  ${OUTPUT_PATH}`);
    console.log(`Frames:  ${FRAMES_DIR}`);
    writeStatus({
      status: 'done',
      accepted: true,
      score: qc.overallScore,
      threshold: THRESHOLD,
      outputPath: OUTPUT_PATH,
      framesDir: FRAMES_DIR,
      frameCount: FRAME_COUNT,
      dimensions: `${outMeta.width}x${outMeta.height}`,
      qc: {
        overallScore: qc.overallScore,
        avgFrameScore: qc.avgFrameScore,
        consistencyScore: qc.consistencyScore,
        medianFill: qc.medianFill,
        frameScores: qc.frameResults.map(r => r.score),
        issues: qc.issues,
        consistencyIssues: qc.consistencyIssues,
      },
    });
  } else {
    console.log(`\nFAILED: ${qc.overallScore}/100 < ${THRESHOLD} threshold  — BLOCKED`);
    console.log(`Issues:`);
    for (const issue of qc.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.msg}`);
    }
    writeStatus({
      status: 'failed',
      accepted: false,
      score: qc.overallScore,
      threshold: THRESHOLD,
      outputPath: OUTPUT_PATH,
      frameCount: FRAME_COUNT,
      dimensions: `${outMeta.width}x${outMeta.height}`,
      qc: {
        overallScore: qc.overallScore,
        avgFrameScore: qc.avgFrameScore,
        consistencyScore: qc.consistencyScore,
        medianFill: qc.medianFill,
        frameScores: qc.frameResults.map(r => r.score),
        issues: qc.issues,
      },
    });
    process.exit(2);
  }
}

main().catch(err => {
  writeStatus({ status: 'error', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
