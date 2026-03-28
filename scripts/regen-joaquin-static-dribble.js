#!/usr/bin/env node
/**
 * TASK-6007: Regen joaquin static-dribble frames 4-5 and reassemble strip
 *
 * Character: joaquin
 *   - Stocky build, 66 in, 160 lbs
 *   - "Lucky Trucker" black shirt, blue jeans, brown basketball
 *   - Style: 16-bit pixel art, GBA style
 *   - Angle ref: joaquin-angle-2.png (side-L profile)
 *
 * Clean frames (keep as-is, reprocess only for padding consistency):
 *   data/assets/joaquin-static-dribble-frames/frame-000.png through frame-003.png
 *
 * Regenerate:
 *   frame-004.png and frame-005.png (artifacts — pipeline extraction errors)
 *
 * Steps:
 *   1. Regenerate frames 4-5 using angle-2 as ref + clean frames as style context
 *   2. Apply 160x160-within-180x180 padding fix to ALL 6 frames (including clean ones)
 *   3. Assemble 1080x180 single-row strip
 *   4. Save to data/assets/joaquin-static-dribble.png
 *   5. QC evaluate — target >= 80/100
 *   6. Update animation-contract.json if ACCEPTED
 *
 * Model: gemini-2.5-flash-image
 * QC threshold: 80/100
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
const STATUS_FILE   = '/tmp/joaquin-static-dribble-status.json';
const MODEL_ID      = 'gemini-2.5-flash-image';
const QC_THRESHOLD  = 80;
const TOTAL_FRAMES  = 6;

// refs
const CHAR_REF    = path.join(ASSETS_DIR, 'joaquin-angle-2.png');
const CLEAN_FRAMES_DIR = path.join(ASSETS_DIR, 'joaquin-static-dribble-frames');
const FINAL_PATH  = path.join(ASSETS_DIR, 'joaquin-static-dribble.png');

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[STATUS]', JSON.stringify(obj));
}

// ── Padding Fix (160x160-within-180x180) ─────────────────────────────────────

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

// ── Prompt for frames 4-5 ─────────────────────────────────────────────────────

/**
 * Generate frames 4 and 5 of the static dribble cycle.
 * Image 1 = joaquin-angle-2.png (character reference, side-L)
 * Image 2 = frame-003.png (pose reference: upright, ball held low at right side)
 */
function buildFrames45Prompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet continuation for the basketball player shown in Image 1.',
    'Image 2 shows the character mid-static-dribble (frame 3 of the cycle — upright, ball held low at right side).',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — "Lucky Trucker" black baseball shirt, blue jeans,',
    'stocky build, same face, hairstyle, skin tone. Side-profile view facing left.',
    'Maintain identical appearance to Image 2 in both frames.',
    '',
    'ANIMATION: STATIC DRIBBLE CONTINUATION — stationary dribble, ball on right side.',
    'These are frames 4 and 5 of a 6-frame loop. They should flow naturally from Image 2.',
    '',
    'Frame 1 (frame 4 of cycle): Ball bouncing back up from floor — ball rises to mid-shin height.',
    '  Character upright, weight slightly on right foot, right arm beginning to guide ball upward.',
    '',
    'Frame 2 (frame 5 of cycle): Ball continues rising — ball at knee height on right side.',
    '  Character standing, right arm extending slightly to receive ball, natural dribble rhythm.',
    '',
    'BASKETBALL: Standard orange basketball with black seam lines.',
    'Ball roughly 14-16px diameter at 180px scale. Only ONE ball visible per frame.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 2 frames side by side in ONE horizontal strip image, total 360x180 pixels.',
    '- Each frame is exactly 180x180 pixels, NO gaps, NO borders between frames.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet touch near the bottom edge, head near the top edge of each frame.',
    '- Same character size, angle, and baseline in both frames.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00) — NO white, NO gray, NO dark background.',
    'NO green (#00FF00) on the character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

// ── Process single raw frame from existing clean source ─────────────────────

async function reprocessCleanFrame(srcPath, tempDir, index) {
  const croppedPath = path.join(tempDir, `cropped-${String(index).padStart(3,'0')}.png`);
  const paddedPath  = path.join(tempDir, `padded-${String(index).padStart(3,'0')}.png`);

  // Check if source already has transparent bg (it should — these are from prior processing)
  const srcMeta = await sharp(srcPath).metadata();
  const hasAlpha = srcMeta.channels === 4;

  if (hasAlpha) {
    // Already has transparent bg — just crop to content and pad
    await cropToContent(srcPath, croppedPath, { width: 160, height: 160, padding: 2 });
  } else {
    // Green bg — remove it first
    const cleanPath = path.join(tempDir, `clean-${String(index).padStart(3,'0')}.png`);
    await removeBackground(srcPath, cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });
    await cropToContent(cleanPath, croppedPath, { width: 160, height: 160, padding: 2 });
  }

  await embedWithPadding(croppedPath, paddedPath);
  return paddedPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  writeStatus({ status: 'starting' });

  if (!fs.existsSync(CHAR_REF)) {
    writeStatus({ status: 'error', error: `Char ref not found: ${CHAR_REF}` });
    process.exit(1);
  }

  const frame003Path = path.join(CLEAN_FRAMES_DIR, 'frame-003.png');
  if (!fs.existsSync(frame003Path)) {
    writeStatus({ status: 'error', error: `frame-003.png not found in ${CLEAN_FRAMES_DIR}` });
    process.exit(1);
  }

  const tempDir = path.join(BASE_DIR, 'data/.tmp-joaquin-static-dribble');
  fs.mkdirSync(tempDir, { recursive: true });

  // ── Step 1: Reprocess clean frames 0-3 with padding fix ──────────────────
  console.log('\n====== Step 1: Reprocess clean frames 0-3 with padding fix ======');
  const paddedPaths = new Array(TOTAL_FRAMES);

  for (let i = 0; i < 4; i++) {
    const srcPath = path.join(CLEAN_FRAMES_DIR, `frame-${String(i).padStart(3,'0')}.png`);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Clean frame not found: ${srcPath}`);
    }
    paddedPaths[i] = await reprocessCleanFrame(srcPath, tempDir, i);
    console.log(`  Padded frame ${i}: ${paddedPaths[i]}`);
  }

  // ── Step 2: Regenerate frames 4-5 ────────────────────────────────────────
  console.log('\n====== Step 2: Regenerate frames 4-5 via Gemini ======');

  const rawPath45 = path.join(RAW_DIR, 'joaquin-static-dribble-frames45-raw.png');

  const client = new NanaBananaClient({ model: MODEL_ID });
  const prompt  = buildFrames45Prompt();

  writeStatus({ status: 'generating frames 4-5' });

  const result = await client.generate(prompt, {
    referenceImages: [CHAR_REF, frame003Path],
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000,
    maxRetries: 4,
  });

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPath45, result.imageBuffer);
  console.log(`  Raw saved: ${rawPath45}`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'joaquin', animation: 'static-dribble-frames45' });

  // Detect raw dimensions
  const rawMeta = await sharp(rawPath45).metadata();
  console.log(`  Raw dimensions: ${rawMeta.width}x${rawMeta.height}`);

  // Cut 2 frames from the raw strip
  const frameWidth45 = Math.floor(rawMeta.width / 2);
  for (let i = 0; i < 2; i++) {
    const cutPath   = path.join(tempDir, `cut45-${i}.png`);
    const cleanPath = path.join(tempDir, `clean45-${i}.png`);
    const croppedPath = path.join(tempDir, `cropped45-${i}.png`);
    const paddedPath  = path.join(tempDir, `padded45-${i}.png`);

    await sharp(rawPath45)
      .extract({ left: i * frameWidth45, top: 0, width: frameWidth45, height: rawMeta.height })
      .toFile(cutPath);

    await removeBackground(cutPath, cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });

    await cropToContent(cleanPath, croppedPath, { width: 160, height: 160, padding: 2 });
    await embedWithPadding(croppedPath, paddedPath);

    paddedPaths[4 + i] = paddedPath;
    console.log(`  Padded frame ${4 + i}: ${paddedPath}`);
  }

  // ── Step 3: Assemble 1080x180 strip ──────────────────────────────────────
  console.log('\n====== Step 3: Assembling 1080x180 strip ======');
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
      width:  FRAME_SIZE * TOTAL_FRAMES,
      height: FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(FINAL_PATH);

  console.log(`  Strip saved: ${FINAL_PATH}`);

  // Verify dimensions
  const outMeta = await sharp(FINAL_PATH).metadata();
  console.log(`  Output: ${outMeta.width}x${outMeta.height} (expected 1080x180)`);
  if (outMeta.width !== 1080 || outMeta.height !== 180) {
    throw new Error(`Wrong output dimensions: ${outMeta.width}x${outMeta.height}, expected 1080x180`);
  }

  // ── Step 4: Save individual frames back to frames dir ────────────────────
  const outFramesDir = CLEAN_FRAMES_DIR;
  fs.mkdirSync(outFramesDir, { recursive: true });
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const destPath = path.join(outFramesDir, `frame-${String(i).padStart(3,'0')}.png`);
    fs.copyFileSync(paddedPaths[i], destPath);
  }
  console.log(`  Saved all ${TOTAL_FRAMES} padded frames to ${outFramesDir}`);

  // ── Step 5: QC evaluation ────────────────────────────────────────────────
  console.log('\n====== Step 5: QC evaluation ======');
  const evalFramePaths = Array.from({ length: TOTAL_FRAMES }, (_, i) =>
    path.join(outFramesDir, `frame-${String(i).padStart(3,'0')}.png`)
  );

  const qc = await evaluateStrip(evalFramePaths);
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  if (qc.issues.length > 0) {
    for (const iss of qc.issues) {
      console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
    }
  }

  const qcStatus = qc.overallScore >= QC_THRESHOLD ? 'ACCEPTED' : 'FAILED';
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  // ── Step 6: Update animation-contract.json if ACCEPTED ───────────────────
  if (qcStatus === 'ACCEPTED') {
    try {
      const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      if (!contract.characters) contract.characters = {};
      if (!contract.characters['joaquin']) contract.characters['joaquin'] = { animations: {} };
      if (!contract.characters['joaquin'].animations) contract.characters['joaquin'].animations = {};

      contract.characters['joaquin'].animations['static-dribble'] = {
        frames: TOTAL_FRAMES,
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
        qcNote: `TASK-6007 — frames 4-5 regenerated, all 6 reprocessed with padding fix. ${TOTAL_FRAMES} frames, 1080x180 confirmed.`,
        file: 'data/assets/joaquin-static-dribble.png',
      };

      fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
      JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      console.log('\nUpdated animation-contract.json: added static-dribble to characters.joaquin');
    } catch (err) {
      console.error(`Failed to update animation-contract.json: ${err.message}`);
    }
  }

  const summary = {
    status: 'done',
    completedAt: new Date().toISOString(),
    outputPath: FINAL_PATH,
    dimensions: `${outMeta.width}x${outMeta.height}`,
    frames: TOTAL_FRAMES,
    qcScore: qc.overallScore,
    qcStatus,
  };

  writeStatus(summary);
  console.log('\n====== DONE ======');
  console.log(`  joaquin-static-dribble: ${qcStatus} ${qc.overallScore}/100 (1080x180, 6 frames)`);
}

main().catch(err => {
  writeStatus({ status: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
