#!/usr/bin/env node
/**
 * TASK-6002: Generate bron-test baseline animations — idle + dribble
 *
 * Character: bron-test
 *   - Athletic basketball player, 72 in, standard build
 *   - Portrait: data/assets/bron-testfull.png
 *   - Angles: bron-test-angle-0..7.png (use angle-2 = side-L as char ref)
 *
 * Animations:
 *   1. bron-test-idle    — 4 frames, 720x180,  loop: true,  no ball, fps 6
 *   2. bron-test-dribble — 8 frames, 1440x180, loop: true,  hasBall true, fps 10
 *
 * Padding fix: 160x160-within-180x180 (proven fix for fill-height issues)
 * Model: gemini-2.5-flash-image (pro models returning 500)
 * QC threshold: 80/100 to ACCEPT
 *
 * Output: data/assets/bron-test-idle.png, data/assets/bron-test-dribble.png
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { removeBackground, cropToContent, evaluateStrip } = require('../lib/sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const BASE_DIR    = path.resolve(__dirname, '..');
const ASSETS_DIR  = path.join(BASE_DIR, 'data/assets');
const RAW_DIR     = path.join(BASE_DIR, 'data/raw-sprites');
const CONTRACT_PATH = path.join(BASE_DIR, 'data/animation-contract.json');
const STATUS_FILE = '/tmp/bron-test-baseline-status.json';
const MODEL_ID    = 'gemini-2.5-flash-image';
const QC_THRESHOLD = 80;

const CHAR_REF = path.join(ASSETS_DIR, 'bron-test-angle-2.png'); // side-L profile

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[STATUS]', JSON.stringify(obj));
}

// ── Prompt Builders ───────────────────────────────────────────────────────────

function buildIdlePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. This is a side-profile view of the character.',
    'Maintain their exact appearance throughout all frames.',
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

function buildDribblePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. This is a side-profile view of the character.',
    'Maintain their exact appearance throughout all frames.',
    '',
    'ANIMATION: RUNNING DRIBBLE — full run cycle while dribbling basketball on right side.',
    'Character runs from left to right, side-profile view.',
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
    'BASKETBALL: Standard orange basketball with black lines.',
    'Ball should bounce on the right side of the character throughout the dribble cycle.',
    'Ball size proportional to character — roughly 15-18px diameter at 180px scale.',
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

// ── Padding Fix (160x160-within-180x180) ─────────────────────────────────────

async function embedWithPadding(contentPath, outputPath) {
  const FRAME_SIZE   = 180;
  const CONTENT_AREA = 160; // 10px margin all sides

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

// ── Per-animation runner ───────────────────────────────────────────────────────

async function runAnimation({ name, frames, expectedWidth, prompt, refs }) {
  const rawPath    = path.join(RAW_DIR, `bron-test-${name}-raw.png`);
  const finalPath  = path.join(ASSETS_DIR, `bron-test-${name}.png`);
  const framesDir  = path.join(ASSETS_DIR, `bron-test-${name}-frames`);
  const tempDir    = path.join(BASE_DIR, `data/.tmp-bron-test-${name}`);

  console.log(`\n====== Generating bron-test-${name} (${frames} frames) ======`);

  const client = new NanaBananaClient({ model: MODEL_ID });

  // Generate raw image
  const result = await client.generate(prompt, {
    referenceImages: refs,
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000, // 4 min
    maxRetries: 4,
  });

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPath, result.imageBuffer);
  console.log(`  Raw saved: ${rawPath}`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'bron-test', animation: name });

  // Detect raw dimensions
  const rawMeta = await sharp(rawPath).metadata();
  console.log(`  Raw dimensions: ${rawMeta.width}x${rawMeta.height}`);

  const FRAME_COUNT = frames;
  const frameWidth  = Math.floor(rawMeta.width / FRAME_COUNT);
  const frameHeight = rawMeta.height;

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  // Step 1: Cut raw into individual frames
  console.log(`  Step 1: cutting ${FRAME_COUNT} frames (${frameWidth}x${frameHeight})`);
  const cutPaths = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cutPath = path.join(tempDir, `cut-${String(i).padStart(3,'0')}.png`);
    await sharp(rawPath)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: frameHeight })
      .toFile(cutPath);
    cutPaths.push(cutPath);
  }

  // Step 2: Remove green background
  console.log(`  Step 2: background removal`);
  const cleanPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    const cleanPath = path.join(tempDir, `clean-${String(i).padStart(3,'0')}.png`);
    await removeBackground(cutPaths[i], cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });
    cleanPaths.push(cleanPath);
  }

  // Step 3: cropToContent then embedWithPadding (160x160 within 180x180)
  console.log(`  Step 3: crop + padding fix (160x160 within 180x180)`);
  const paddedPaths = [];
  for (let i = 0; i < cleanPaths.length; i++) {
    const croppedPath = path.join(tempDir, `cropped-${String(i).padStart(3,'0')}.png`);
    await cropToContent(cleanPaths[i], croppedPath, {
      width: 160, height: 160, padding: 2,
    });
    const paddedPath = path.join(tempDir, `padded-${String(i).padStart(3,'0')}.png`);
    await embedWithPadding(croppedPath, paddedPath);
    paddedPaths.push(paddedPath);
  }

  // Step 4: Assemble strip
  console.log(`  Step 4: assembling ${expectedWidth}x180 strip`);
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
    .toFile(finalPath);

  console.log(`  Strip saved: ${finalPath}`);

  // Step 5: Save individual frames
  for (let i = 0; i < paddedPaths.length; i++) {
    const destPath = path.join(framesDir, `frame-${String(i).padStart(3,'0')}.png`);
    fs.copyFileSync(paddedPaths[i], destPath);
  }
  console.log(`  Saved ${paddedPaths.length} frames to ${framesDir}`);

  // Verify output dimensions
  const outMeta = await sharp(finalPath).metadata();
  console.log(`  Output: ${outMeta.width}x${outMeta.height} (expected ${expectedWidth}x180)`);
  if (outMeta.width !== expectedWidth || outMeta.height !== 180) {
    throw new Error(`Wrong output dimensions: ${outMeta.width}x${outMeta.height}, expected ${expectedWidth}x180`);
  }

  // QC evaluation
  const framePaths = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(framesDir, f));

  const qc = await evaluateStrip(framePaths);
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  if (qc.issues.length > 0) {
    for (const iss of qc.issues) {
      console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
    }
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : 'FAILED';
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    name,
    frames: FRAME_COUNT,
    finalPath,
    framesDir,
    width: outMeta.width,
    height: outMeta.height,
    qcScore: qc.overallScore,
    qcStatus,
    qc,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  writeStatus({ status: 'starting' });

  if (!fs.existsSync(CHAR_REF)) {
    writeStatus({ status: 'error', error: `Char ref not found: ${CHAR_REF}` });
    process.exit(1);
  }

  const results = {};

  // ── 1. bron-test-idle ──────────────────────────────────────────────────────
  try {
    writeStatus({ status: 'generating bron-test-idle' });
    results.idle = await runAnimation({
      name: 'idle',
      frames: 4,
      expectedWidth: 720,
      prompt: buildIdlePrompt(),
      refs: [CHAR_REF],
    });
  } catch (err) {
    console.error('ERROR bron-test-idle:', err.message);
    results.idle = { name: 'idle', qcStatus: 'ERROR', error: err.message };
  }

  // ── 2. bron-test-dribble ───────────────────────────────────────────────────
  try {
    writeStatus({ status: 'generating bron-test-dribble' });
    results.dribble = await runAnimation({
      name: 'dribble',
      frames: 8,
      expectedWidth: 1440,
      prompt: buildDribblePrompt(),
      refs: [CHAR_REF],
    });
  } catch (err) {
    console.error('ERROR bron-test-dribble:', err.message);
    results.dribble = { name: 'dribble', qcStatus: 'ERROR', error: err.message };
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n====== SUMMARY ======');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  bron-test-${k}: ${v.qcStatus} score=${v.qcScore ?? 'N/A'} dims=${v.width ?? '?'}x${v.height ?? '?'}`);
  }

  // Update animation-contract.json for ACCEPTED animations
  const accepted = Object.values(results).filter(r => r.qcStatus === 'ACCEPTED');
  if (accepted.length > 0) {
    try {
      const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      if (!contract.characters) contract.characters = {};
      if (!contract.characters['bron-test']) contract.characters['bron-test'] = { animations: {} };

      for (const r of accepted) {
        const isIdle    = r.name === 'idle';
        const isDribble = r.name === 'dribble';
        contract.characters['bron-test'].animations[r.name] = {
          frames: r.frames,
          frameWidth: 180,
          frameHeight: 180,
          stripWidth: r.width,
          stripHeight: 180,
          fps: isIdle ? 6 : 10,
          loop: true,
          hasBall: isDribble,
          category: isIdle ? 'locomotion' : 'ball-handling',
          action: isIdle
            ? 'standing idle, subtle weight shift and breathing'
            : 'running dribble, full run cycle with basketball',
          qcStatus: 'ACCEPTED',
          qcScore: `${r.qcScore}/100`,
          qcNote: `TASK-6002 — bron-test baseline generation. ${r.frames} frames, ${r.width}x${r.height} confirmed.`,
          file: `data/assets/bron-test-${r.name}.png`,
        };
      }

      fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
      // Validate JSON parses
      JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      console.log(`\nUpdated animation-contract.json: added ${accepted.map(r => r.name).join(', ')} to characters.bron-test`);
    } catch (err) {
      console.error(`Failed to update animation-contract.json: ${err.message}`);
    }
  }

  const acceptedNames = Object.values(results).filter(r => r.qcStatus === 'ACCEPTED').map(r => r.name);
  const failedNames   = Object.values(results).filter(r => r.qcStatus !== 'ACCEPTED').map(r => `${r.name}(${r.qcStatus})`);

  writeStatus({
    status: 'done',
    completedAt: new Date().toISOString(),
    results,
    accepted: acceptedNames,
    failed: failedNames,
  });
}

main().catch(err => {
  writeStatus({ status: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
