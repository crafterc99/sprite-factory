#!/usr/bin/env node
/**
 * TASK-6012: Generate snoop angles (8) then baseline animations (dribble + walk)
 *
 * Character: snoop
 *   - Athletic basketball player, 72 in / 185 lbs
 *   - Team colors: primary #263e0f (dark green), secondary #aa7942 (tan/gold)
 *   - Style: 16-bit pixel art, GBA style
 *   - Portrait: data/assets/snoopfull.png
 *
 * Part A — Angles: snoop-angle-0.png through snoop-angle-7.png (180x180 each)
 *   - Update data/.characters.json snoop.anchor.angles
 *
 * Part B — Animations:
 *   - snoop-dribble.png: 8 frames, 1440x180, fps 10, loop true, hasBall true
 *   - snoop-walk.png:    8 frames, 1440x180, fps 10, loop true, hasBall false
 *   - Ref: snoop-angle-2.png (side-L profile, just generated)
 *
 * All outputs: 160x160-within-180x180 padding fix applied
 * Model: gemini-2.5-flash-image
 * QC threshold: 80/100
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
const CHARS_PATH    = path.join(BASE_DIR, 'data/.characters.json');
const MODEL_ID      = 'gemini-2.5-flash-image';
const QC_THRESHOLD  = 80;

const PORTRAIT_PATH = path.join(ASSETS_DIR, 'snoopfull.png');

const FRAME_SIZE   = 180;
const CONTENT_AREA = 160;

const ANGLE_NAMES = [
  'front', 'front-3/4-L', 'side-L', 'back-3/4-L',
  'back', 'back-3/4-R', 'side-R', 'front-3/4-R',
];

const ANGLE_DESCRIPTIONS = {
  'front':        'facing directly toward the camera, head-on front view',
  'front-3/4-L':  'turned roughly 45 degrees to the left, three-quarter front view from the left side',
  'side-L':       'turned 90 degrees to the left, full left-side profile view',
  'back-3/4-L':   'turned roughly 135 degrees to the left, three-quarter rear view from the left side',
  'back':         'facing directly away from the camera, full rear view',
  'back-3/4-R':   'turned roughly 135 degrees to the right, three-quarter rear view from the right side',
  'side-R':       'turned 90 degrees to the right, full right-side profile view',
  'front-3/4-R':  'turned roughly 45 degrees to the right, three-quarter front view from the right side',
};

// ── Shared utilities ──────────────────────────────────────────────────────────

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

async function postProcessAngle(rawBuffer, outputPath) {
  const tmpRaw = outputPath + '.tmp-raw.png';
  fs.writeFileSync(tmpRaw, rawBuffer);

  // Remove green background (HSV chroma key approach from generate-z-angles.js)
  const { data, info } = await sharp(tmpRaw)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Buffer.from(data);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (g > 180 && g > r * 1.4 && g > b * 1.4) {
      pixels[i + 3] = 0;
    }
  }

  const cleanBuffer = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();

  // Find content bounding box
  const { data: cleanData, info: cleanInfo } = await sharp(cleanBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = cleanInfo.width, minY = cleanInfo.height, maxX = 0, maxY = 0;
  let hasContent = false;
  for (let y = 0; y < cleanInfo.height; y++) {
    for (let x = 0; x < cleanInfo.width; x++) {
      const idx = (y * cleanInfo.width + x) * 4;
      if (cleanData[idx + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        hasContent = true;
      }
    }
  }

  let cropped;
  if (!hasContent || maxX < minX || maxY < minY) {
    cropped = cleanBuffer;
  } else {
    const padding = 4;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(cleanInfo.width - 1, maxX + padding);
    maxY = Math.min(cleanInfo.height - 1, maxY + padding);

    cropped = await sharp(cleanBuffer)
      .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
      .toBuffer();
  }

  // Scale to fit within 160x160
  const scaled = await sharp(cropped)
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

  fs.unlinkSync(tmpRaw);

  const outMeta = await sharp(outputPath).metadata();
  return { width: outMeta.width, height: outMeta.height };
}

// ── Part A: Generate snoop angles ─────────────────────────────────────────────

function buildAnglePrompt(angleName, angleIndex) {
  const angleDesc = ANGLE_DESCRIPTIONS[angleName];
  return [
    `IDENTITY REFERENCE: Image 1 is the character's portrait. Keep their exact face, skin tone, hairstyle, and body proportions.`,
    ``,
    `TASK: Generate this character ${angleDesc}.`,
    `This is angle ${angleIndex + 1} of 8 in a full turnaround sheet.`,
    ``,
    `OUTFIT — STANDARDIZED:`,
    `- Dark green jersey/tank top (color #263e0f)`,
    `- Tan/gold basketball shorts (color #aa7942)`,
    `- Basketball held casually in the right hand at hip level`,
    `- Same shoes/sneakers as the portrait`,
    ``,
    `POSE:`,
    `- Standing upright in a relaxed neutral stance`,
    `- Weight evenly distributed, arms relaxed`,
    `- Basketball held in right hand at hip height`,
    `- Full body from head to shoes, NO cropping`,
    ``,
    `FRAME OUTPUT:`,
    `- SINGLE 180x180 pixel frame only`,
    `- Character fills ~85% of frame height`,
    `- Feet near the bottom edge, head near the top edge`,
    ``,
    `CONSISTENCY:`,
    `- Match the exact same proportions and height as Image 1`,
    `- Same pixel art style, same level of detail`,
    `- Same outline thickness and color palette`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Single character, full body, ONE frame only, 180x180 pixels`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');
}

async function generateAngles(client) {
  console.log('\n====== PART A: Generating snoop angles ======');

  const generated = [];
  const failed    = [];

  for (let i = 0; i < 8; i++) {
    const angleName  = ANGLE_NAMES[i];
    const outputPath = path.join(ASSETS_DIR, `snoop-angle-${i}.png`);

    console.log(`\n--- Generating snoop-angle-${i} (${angleName}) ---`);

    try {
      const result = await client.generate(buildAnglePrompt(angleName, i), {
        referenceImages: [PORTRAIT_PATH],
        aspectRatio: '1:1',
        resolution: '1K',
        model: MODEL_ID,
        timeoutMs: 120000,
        maxRetries: 4,
      });

      recordCost(MODEL_ID, 'angle', '1K', 1, { character: 'snoop', angleName });

      const dims = await postProcessAngle(result.imageBuffer, outputPath);
      console.log(`  Saved: snoop-angle-${i}.png (${dims.width}x${dims.height})`);
      generated.push({ i, angleName, outputPath });
    } catch (err) {
      console.error(`  FAILED angle ${i} (${angleName}): ${err.message}`);
      failed.push({ i, angleName, error: err.message });
    }

    if (i < 7) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nAngles summary: ${generated.length}/8 generated, ${failed.length} failed`);

  // Collect angle paths for .characters.json update
  const anglePaths = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(ASSETS_DIR, `snoop-angle-${i}.png`);
    if (fs.existsSync(p)) {
      anglePaths.push(`snoop-angle-${i}.png`);
    }
  }

  // Update .characters.json
  if (anglePaths.length > 0) {
    const chars = JSON.parse(fs.readFileSync(CHARS_PATH, 'utf8'));
    if (!chars.snoop) chars.snoop = {};
    if (!chars.snoop.anchor) chars.snoop.anchor = { angles: [], ballRefs: [], status: 'partial' };
    chars.snoop.anchor.angles = anglePaths;
    if (anglePaths.length === 8) chars.snoop.anchor.status = 'complete';
    fs.writeFileSync(CHARS_PATH, JSON.stringify(chars, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(CHARS_PATH, 'utf8')); // validate
    console.log(`  .characters.json updated: snoop.anchor.angles = [${anglePaths.join(', ')}]`);
  }

  return { generated, failed, anglePaths };
}

// ── Part B: Generate animations ───────────────────────────────────────────────

function buildDribblePrompt() {
  return [
    'Generate a 16-bit pixel art sprite sheet for the basketball player shown in Image 1.',
    '',
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. Dark green jersey, tan/gold shorts. This is a side-profile view.',
    'Maintain their exact appearance throughout all frames.',
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
    'The basketball should be clearly visible and bounce smoothly in every frame.',
    '',
    'OUTPUT FORMAT:',
    '- EXACTLY 8 frames side by side in ONE horizontal strip, total 1440x180 pixels.',
    '- Each frame exactly 180x180 pixels, NO gaps, NO borders.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet near the bottom edge, head near the top edge of each frame.',
    '- Consistent character size and baseline in every frame.',
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
    'IDENTITY: Use the EXACT character from Image 1 — same face, hairstyle, skin tone,',
    'outfit, and proportions. Dark green jersey, tan/gold shorts. This is a side-profile view.',
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
    '- EXACTLY 8 frames side by side in ONE horizontal strip, total 1440x180 pixels.',
    '- Each frame exactly 180x180 pixels, NO gaps, NO borders.',
    '- Character fills ~80-85% of each 180px frame height.',
    '- Feet near the bottom edge, head near the top edge of each frame.',
    '- Same character size and baseline in every frame.',
    '',
    'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
    'Background: solid bright green (#00FF00).',
    'NO green (#00FF00) on character body, clothes, or skin.',
    'NO anti-aliasing on background. ONE character per frame. No text, no borders, no UI.',
  ].join('\n');
}

async function runAnimation(client, { animName, frames, expectedW, prompt, charRef, hasBall }) {
  const rawPath   = path.join(RAW_DIR, `snoop-${animName}-raw.png`);
  const finalPath = path.join(ASSETS_DIR, `snoop-${animName}.png`);
  const framesDir = path.join(ASSETS_DIR, `snoop-${animName}-frames`);
  const tempDir   = path.join(BASE_DIR, `data/.tmp-snoop-${animName}`);

  console.log(`\n====== Generating snoop-${animName} (${frames} frames) ======`);

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

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

  recordCost(MODEL_ID, 'strip', '2K', 1, { character: 'snoop', animation: animName });

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

  // cropToContent + embedWithPadding
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
      width:  FRAME_SIZE * frames,
      height: FRAME_SIZE,
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n====== TASK-6012: snoop angles + animations ======');

  if (!fs.existsSync(PORTRAIT_PATH)) {
    console.error(`ERROR: Portrait not found: ${PORTRAIT_PATH}`);
    process.exit(1);
  }

  const client = new NanaBananaClient({ model: MODEL_ID });

  // ── PART A: Angles ──────────────────────────────────────────────────────────
  const anglesResult = await generateAngles(client);

  // Determine char ref for animations (use angle-2 if available)
  const angle2Path = path.join(ASSETS_DIR, 'snoop-angle-2.png');
  const charRef    = fs.existsSync(angle2Path) ? angle2Path : PORTRAIT_PATH;
  console.log(`\nUsing char ref for animations: ${path.basename(charRef)}`);

  // ── PART B: Animations ──────────────────────────────────────────────────────
  const animResults = {};

  // snoop-dribble
  try {
    animResults.dribble = await runAnimation(client, {
      animName:  'dribble',
      frames:    8,
      expectedW: 1440,
      prompt:    buildDribblePrompt(),
      charRef,
      hasBall:   true,
    });
  } catch (err) {
    console.error(`ERROR snoop-dribble: ${err.message}`);
    animResults.dribble = { animName: 'dribble', qcStatus: 'ERROR', error: err.message, accepted: false };
  }

  // snoop-walk
  try {
    animResults.walk = await runAnimation(client, {
      animName:  'walk',
      frames:    8,
      expectedW: 1440,
      prompt:    buildWalkPrompt(),
      charRef,
      hasBall:   false,
    });
  } catch (err) {
    console.error(`ERROR snoop-walk: ${err.message}`);
    animResults.walk = { animName: 'walk', qcStatus: 'ERROR', error: err.message, accepted: false };
  }

  // ── Update animation-contract.json ─────────────────────────────────────────
  const accepted = Object.values(animResults).filter(r => r.accepted);
  if (accepted.length > 0) {
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

    if (!contract.characters) contract.characters = {};
    if (!contract.characters.snoop) contract.characters.snoop = { animations: {} };
    if (!contract.characters.snoop.animations) contract.characters.snoop.animations = {};

    for (const r of accepted) {
      const fps      = 10;
      const category = r.hasBall ? 'ball-handling' : 'locomotion';
      const action   = r.hasBall
        ? 'running dribble, full run cycle with basketball'
        : 'walk cycle, no ball';

      contract.characters.snoop.animations[r.animName] = {
        frames: r.frames,
        frameWidth: 180,
        frameHeight: 180,
        stripWidth: r.width,
        stripHeight: 180,
        fps,
        loop: true,
        hasBall: r.hasBall,
        category,
        action,
        qcStatus: r.qcStatus,
        qcScore: `${r.qcScore}/100`,
        qcNote: `TASK-6012 — snoop baseline generation. ${r.frames} frames, ${r.width}x180 confirmed. Padding fix applied.`,
        file: `data/assets/snoop-${r.animName}.png`,
      };
    }

    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); // validate
    console.log(`\n  animation-contract.json updated: added snoop.animations.${accepted.map(r => r.animName).join(', ')}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n====== TASK-6012 COMPLETE ======');
  console.log(`\nPart A — Angles:`);
  console.log(`  Generated: ${anglesResult.generated.length}/8`);
  if (anglesResult.failed.length > 0) {
    for (const f of anglesResult.failed) console.log(`  FAILED: angle-${f.i} (${f.angleName})`);
  }
  console.log(`  .characters.json updated: snoop.anchor.angles`);

  console.log(`\nPart B — Animations:`);
  for (const [k, v] of Object.entries(animResults)) {
    console.log(`  snoop-${k}: ${v.qcStatus} score=${v.qcScore ?? 'N/A'} dims=${v.width ?? '?'}x${v.height ?? '?'}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
