#!/usr/bin/env node
/**
 * TASK-6014 (retry): Generate 99 idle + walk baseline animations
 *
 * Angles (Part A) already done in task-6014-99-angles-baseline.js.
 * This script retries only the animations:
 *   - 99-idle.png: 4 frames, 720x180, fps 6, loop true, hasBall false, >= 80/100
 *   - 99-walk.png: 8 frames, 1440x180, fps 10, loop true, hasBall false, >= 80/100
 *   - Ref: data/assets/99-angle-2.png
 *   - Apply 160x160-within-180x180 padding fix
 *
 * Fixes from first attempt:
 *   - idle: aspect ratio 4:1 not supported -> use 16:9 (same as all other strip gens)
 *   - walk: 78/100 CONDITIONAL (empty frame) -> regen with stronger "no empty frames" prompt
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

function buildIdlePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'CRITICAL: ALL FRAMES must contain a LARGE, FULLY-VISIBLE character.',
    'Every single one of the 4 frames must show the complete character, large and clear.',
    'NO empty frames, NO blank cells. Character is large in every frame.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. Orange-red jersey (#FF4400) with number 99, white shorts.',
    'Maintain exact appearance throughout all 4 frames.',
    '',
    'ANIMATION: IDLE — looping idle stance, 4 frames, NO basketball.',
    'Frame 1: neutral standing pose, weight centered, arms at sides.',
    'Frame 2: slight weight shift to right foot, left shoulder drops minimally.',
    'Frame 3: weight back to center, small breath-in expansion of chest.',
    'Frame 4: slight weight shift to left foot, returning toward frame 1.',
    'Subtle motion only — small breathing and weight shifts. The character barely moves.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 4 frames side by side in ONE horizontal strip, total 720x180 pixels.',
    '- Each frame exactly 180x180 pixels, NO gaps between frames, NO borders.',
    '- Character fills 80-85% of frame height — visible and large.',
    '- Feet near the bottom of each frame, head near the top.',
    '- Consistent character size and position in all 4 frames.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00).',
    'NO green (#00FF00) on character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

function buildWalkPrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'CRITICAL: EVERY SINGLE ONE of the 8 frames must contain a LARGE, FULLY-VISIBLE character.',
    'The character must fill 80-85% of the frame height in ALL 8 frames.',
    'NO empty frames. NO near-empty frames. NO tiny characters. NO blank cells.',
    'ALL 8 frames must show the complete player — no exceptions.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. Orange-red jersey (#FF4400) with number 99, white shorts.',
    'Side-profile view. Maintain exact appearance throughout all 8 frames.',
    '',
    'ANIMATION: WALK CYCLE — standard 8-frame walk, NO basketball, side-profile view.',
    'Frame 1: right foot heel strike, left arm swings forward, weight forward.',
    'Frame 2: right foot flat, weight transferring, left foot lifting.',
    'Frame 3: right foot toe push-off, body rises slightly, left leg swings.',
    'Frame 4: both feet off ground briefly, mid-stride float.',
    'Frame 5: left foot heel strike, right arm swings forward.',
    'Frame 6: left foot flat, weight transferring, right foot lifting.',
    'Frame 7: left foot toe push-off, body rises, right leg swings.',
    'Frame 8: mid-stride float completing cycle back to frame 1.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 8 frames side by side in ONE horizontal strip, total 1440x180 pixels.',
    '- Each frame exactly 180x180 pixels, NO gaps, NO borders.',
    '- Character fills 80-85% of each 180px frame height in EVERY frame.',
    '- Feet near bottom edge, head near top edge in all frames.',
    '- Consistent character size and baseline throughout.',
    '- ALL 8 CELLS MUST CONTAIN THE FULL CHARACTER — no blank or empty cells.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00).',
    'NO green (#00FF00) on character body, clothes, or skin.',
    'NO anti-aliasing. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

async function runAnimation(client, { animName, frames, expectedW, prompt, charRef, hasBall, fps }) {
  const rawPath   = path.join(RAW_DIR,    `99-${animName}-raw.png`);
  const finalPath = path.join(ASSETS_DIR, `99-${animName}.png`);
  const framesDir = path.join(ASSETS_DIR, `99-${animName}-frames`);
  const tempDir   = path.join(BASE_DIR,   `data/.tmp-6014-retry-${animName}`);

  console.log(`\n====== Generating 99-${animName} (${frames} frames) ======`);

  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(tempDir,   { recursive: true });

  // All strips use 16:9 — this is what works for all other characters
  const result = await client.generate(prompt, {
    referenceImages: [charRef],
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL_ID,
    timeoutMs: 240000,
    maxRetries: 4,
  });

  fs.writeFileSync(rawPath, result.imageBuffer);
  const rawMeta = await sharp(rawPath).metadata();
  console.log(`  Raw saved: ${rawPath} (${rawMeta.width}x${rawMeta.height})`);

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: '99', animation: animName });

  // Cut frames
  const frameWidth = Math.floor(rawMeta.width / frames);
  const cutPaths = [];
  for (let i = 0; i < frames; i++) {
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
      width:    FRAME_SIZE * frames,
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

  if (outMeta.width !== expectedW || outMeta.height !== 180) {
    throw new Error(`Wrong dimensions: ${outMeta.width}x${outMeta.height}, expected ${expectedW}x180`);
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
  console.log(`  QC score: ${qc.overallScore}/100 (passed: ${qc.passed})`);
  console.log(`  Avg frame: ${qc.avgFrameScore}, consistency: ${qc.consistencyScore}, fill: ${qc.medianFill}%`);
  for (const iss of qc.issues) {
    console.log(`  Issue [${iss.severity}] ${iss.type}: ${iss.msg}`);
  }

  const accepted = qc.overallScore >= QC_THRESHOLD;
  const qcStatus = accepted ? 'ACCEPTED' : (qc.overallScore >= 70 ? 'CONDITIONAL' : 'FAILED');
  console.log(`  Status: ${qcStatus} (${qc.overallScore}/100)`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    animName,
    frames,
    fps,
    finalPath,
    framesDir,
    width: outMeta.width,
    height: outMeta.height,
    qcScore: qc.overallScore,
    qcStatus,
    accepted,
    hasBall,
    qc,
  };
}

async function main() {
  console.log('\n====== TASK-6014 retry: 99 idle + walk ======');

  const charRef = path.join(ASSETS_DIR, '99-angle-2.png');
  if (!fs.existsSync(charRef)) {
    console.error(`ERROR: char ref not found: ${charRef} — run task-6014 Part A first`);
    process.exit(1);
  }

  const client = new NanaBananaClient({ model: MODEL_ID });
  const animResults = {};

  // 99-idle
  try {
    animResults.idle = await runAnimation(client, {
      animName:  'idle',
      frames:    4,
      expectedW: 720,
      fps:       6,
      prompt:    buildIdlePrompt(),
      charRef,
      hasBall:   false,
    });
  } catch (err) {
    console.error(`ERROR 99-idle: ${err.message}`);
    animResults.idle = { animName: 'idle', qcStatus: 'ERROR', error: err.message, accepted: false };
  }

  // 99-walk
  try {
    animResults.walk = await runAnimation(client, {
      animName:  'walk',
      frames:    8,
      expectedW: 1440,
      fps:       10,
      prompt:    buildWalkPrompt(),
      charRef,
      hasBall:   false,
    });
  } catch (err) {
    console.error(`ERROR 99-walk: ${err.message}`);
    animResults.walk = { animName: 'walk', qcStatus: 'ERROR', error: err.message, accepted: false };
  }

  // Update animation-contract.json
  const accepted = Object.values(animResults).filter(r => r.accepted);
  if (accepted.length > 0) {
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    if (!contract.characters) contract.characters = {};
    if (!contract.characters['99']) contract.characters['99'] = { animations: {} };
    if (!contract.characters['99'].animations) contract.characters['99'].animations = {};

    for (const r of accepted) {
      const action = r.animName === 'idle'
        ? 'standing idle, subtle weight shift and breathing'
        : 'walk cycle, no ball';

      contract.characters['99'].animations[r.animName] = {
        frames: r.frames,
        frameWidth: 180,
        frameHeight: 180,
        stripWidth: r.width,
        stripHeight: 180,
        fps: r.fps,
        loop: true,
        hasBall: r.hasBall,
        category: 'locomotion',
        action,
        qcStatus: r.qcStatus,
        qcScore: `${r.qcScore}/100`,
        qcNote: `TASK-6014 — 99 baseline generation (retry). ${r.frames} frames, ${r.width}x180 confirmed. Padding fix applied.`,
        file: `data/assets/99-${r.animName}.png`,
      };
    }

    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); // validate
    console.log(`\n  animation-contract.json updated: added 99.animations.${accepted.map(r => r.animName).join(', ')}`);
  }

  console.log('\n====== TASK-6014 retry COMPLETE ======');
  for (const [k, v] of Object.entries(animResults)) {
    const score = v.qcScore != null ? `${v.qcScore}/100` : (v.error || 'N/A');
    console.log(`  99-${k}: ${v.qcStatus} score=${score} dims=${v.width ?? '?'}x${v.height ?? '?'}`);
  }

  return animResults;
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
