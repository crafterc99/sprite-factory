#!/usr/bin/env node
/**
 * TASK-6013: Regenerate snoop-dribble from scratch
 *
 * Previous attempt (TASK-6012) scored 74/100 CONDITIONAL due to empty frame issue.
 * This is a clean regen with explicit "every frame must contain a large character" instruction.
 *
 * Spec:
 *   - snoop-dribble.png: 8 frames, 1440x180, fps 10, loop true, hasBall true
 *   - Ref: data/assets/snoop-angle-2.png as char ref
 *   - Ref: data/assets/snoop-idle.png as style ref
 *   - Apply 160x160-within-180x180 padding fix
 *   - QC threshold: 80/100 -> ACCEPTED
 *   - If ACCEPTED: save to data/assets/snoop-dribble.png, add to animation-contract.json
 *   - If FAILED: log failure, do NOT retry (per task spec)
 *
 * Model: gemini-2.5-flash-image
 */
'use strict';

const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { removeBackground, cropToContent, evaluateStrip } = require('../lib/sprite-processor/index');

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

const FRAME_SIZE   = 180;
const CONTENT_AREA = 160;

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

function buildDribblePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'CRITICAL: EVERY SINGLE FRAME must contain a LARGE, FULLY-VISIBLE character.',
    'The character must fill 80-85% of the frame height in ALL 8 frames.',
    'NO empty frames. NO near-empty frames. NO tiny characters. NO missing characters.',
    'If any frame is blank or the character is not large and clearly visible,',
    'the output is REJECTED. All 8 frames must show the full character.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. Dark green jersey, tan/gold shorts. Side-profile view.',
    'Maintain their exact appearance throughout ALL 8 frames.',
    '',
    'ANIMATION: DRIBBLE — running dribble cycle, 8 frames, WITH basketball.',
    'Frame 1: stride begins, right foot heel strike, ball bouncing low at right side.',
    'Frame 2: right foot down, ball rising from bounce, arm extending down.',
    'Frame 3: right foot push-off, ball at peak (hip height), left leg swings forward.',
    'Frame 4: airborne mid-stride, ball dropping again, both feet off ground briefly.',
    'Frame 5: left foot heel strike, ball bouncing low at right side.',
    'Frame 6: left foot down, ball rising from bounce.',
    'Frame 7: left foot push-off, ball at peak, right leg swings forward.',
    'Frame 8: airborne mid-stride, ball dropping, cycle completes back to frame 1.',
    'The basketball must be clearly visible and bouncing in EVERY frame.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 8 frames side by side in ONE horizontal strip, total 1440x180 pixels.',
    '- Each frame exactly 180x180 pixels, NO gaps, NO borders.',
    '- Character fills 80-85% of each 180px frame height — LARGE AND VISIBLE.',
    '- Feet near the bottom edge, head near the top edge of each frame.',
    '- Consistent character size and baseline in EVERY frame.',
    '- ALL 8 CELLS MUST CONTAIN THE FULL CHARACTER — no blank cells.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00).',
    'NO green (#00FF00) on character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

async function main() {
  console.log('\n====== TASK-6013: snoop-dribble regen from scratch ======');

  const charRef     = path.join(ASSETS_DIR, 'snoop-angle-2.png');
  const styleRef    = path.join(ASSETS_DIR, 'snoop-idle.png');
  const rawPath     = path.join(RAW_DIR,    'snoop-dribble-regen-raw.png');
  const finalPath   = path.join(ASSETS_DIR, 'snoop-dribble.png');
  const framesDir   = path.join(ASSETS_DIR, 'snoop-dribble-frames');
  const tempDir     = path.join(BASE_DIR,   'data/.tmp-task-6013');

  if (!fs.existsSync(charRef)) {
    console.error(`ERROR: char ref not found: ${charRef}`);
    process.exit(1);
  }

  fs.mkdirSync(framesDir,  { recursive: true });
  fs.mkdirSync(tempDir,    { recursive: true });

  const client = new NanaBananaClient({ model: MODEL_ID });
  const FRAMES = 8;

  const refImages = [charRef];
  if (fs.existsSync(styleRef)) refImages.push(styleRef);

  console.log(`\nGenerating snoop-dribble (attempt TASK-6013, clean regen)...`);
  console.log(`  Refs: ${refImages.map(r => path.basename(r)).join(', ')}`);

  const result = await client.generate(buildDribblePrompt(), {
    referenceImages: refImages,
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000,
    maxRetries: 4,
  });

  fs.writeFileSync(rawPath, result.imageBuffer);
  const rawMeta = await sharp(rawPath).metadata();
  console.log(`  Raw saved: ${rawPath} (${rawMeta.width}x${rawMeta.height})`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'snoop', animation: 'dribble-regen' });

  // Cut frames
  const frameWidth = Math.floor(rawMeta.width / FRAMES);
  const cutPaths = [];
  for (let i = 0; i < FRAMES; i++) {
    const cutPath = path.join(tempDir, `cut-${String(i).padStart(3, '0')}.png`);
    await sharp(rawPath)
      .extract({ left: i * frameWidth, top: 0, width: frameWidth, height: rawMeta.height })
      .toFile(cutPath);
    cutPaths.push(cutPath);
  }

  // Remove background
  const cleanPaths = [];
  for (let i = 0; i < cutPaths.length; i++) {
    const cleanPath = path.join(tempDir, `clean-${String(i).padStart(3, '0')}.png`);
    await removeBackground(cutPaths[i], cleanPath, {
      hueMin: 80, hueMax: 160, satMin: 0.25, valMin: 0.25,
    });
    cleanPaths.push(cleanPath);
  }

  // cropToContent + embedWithPadding (160x160 within 180x180)
  const paddedPaths = [];
  for (let i = 0; i < cleanPaths.length; i++) {
    const croppedPath = path.join(tempDir, `cropped-${String(i).padStart(3, '0')}.png`);
    await cropToContent(cleanPaths[i], croppedPath, {
      width: CONTENT_AREA, height: CONTENT_AREA, padding: 2,
    });
    const paddedPath = path.join(tempDir, `padded-${String(i).padStart(3, '0')}.png`);
    await embedWithPadding(croppedPath, paddedPath);
    paddedPaths.push(paddedPath);
  }

  // Assemble strip
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
      width:    FRAME_SIZE * FRAMES,
      height:   FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(finalPath);

  const outMeta = await sharp(finalPath).metadata();
  console.log(`  Strip saved: ${finalPath} (${outMeta.width}x${outMeta.height})`);

  if (outMeta.width !== 1440 || outMeta.height !== 180) {
    console.error(`ERROR: Wrong dimensions: ${outMeta.width}x${outMeta.height}, expected 1440x180`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Save individual frames
  for (let i = 0; i < paddedPaths.length; i++) {
    fs.copyFileSync(paddedPaths[i], path.join(framesDir, `frame-${String(i).padStart(3, '0')}.png`));
  }

  // QC evaluation
  const framePaths = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(framesDir, f));

  const qc = await evaluateStrip(framePaths);
  console.log(`\n  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  for (const iss of qc.issues) {
    console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : (qc.overallScore >= 70 ? 'CONDITIONAL' : 'FAILED');
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (accepted) {
    // Update animation-contract.json
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    if (!contract.characters) contract.characters = {};
    if (!contract.characters.snoop) contract.characters.snoop = { animations: {} };
    if (!contract.characters.snoop.animations) contract.characters.snoop.animations = {};

    contract.characters.snoop.animations.dribble = {
      frames: FRAMES,
      frameWidth: 180,
      frameHeight: 180,
      stripWidth: outMeta.width,
      stripHeight: 180,
      fps: 10,
      loop: true,
      hasBall: true,
      category: 'ball-handling',
      action: 'running dribble, full run cycle with basketball',
      qcStatus,
      qcScore: `${qc.overallScore}/100`,
      qcNote: `TASK-6013 — clean regen from scratch, empty-frame issue from TASK-6012 avoided. ${FRAMES} frames, ${outMeta.width}x180. Padding fix applied.`,
      file: 'data/assets/snoop-dribble.png',
    };

    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); // validate
    console.log(`\n  animation-contract.json updated: characters.snoop.animations.dribble`);

    console.log('\n====== TASK-6013: DONE — ACCEPTED ======');
    console.log(`  snoop-dribble.png: ${outMeta.width}x${outMeta.height}, ${FRAMES} frames, QC ${qc.overallScore}/100`);
  } else {
    console.log('\n====== TASK-6013: DONE — NOT ACCEPTED ======');
    console.log(`  QC: ${qc.overallScore}/100 (${qcStatus})`);
    console.log(`  Per task spec: do NOT retry if < 80/100. Logging failure.`);
    console.log(`  snoop-dribble.png on disk reflects this run but is NOT added to contract.`);
  }

  // Return result summary for reporting
  return {
    animName: 'dribble',
    qcScore: qc.overallScore,
    qcStatus,
    accepted,
    dimensions: `${outMeta.width}x${outMeta.height}`,
    frames: FRAMES,
    avgFrameScore: qc.avgFrameScore,
    consistencyScore: qc.consistencyScore,
    medianFill: qc.medianFill,
    issues: qc.issues,
  };
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
