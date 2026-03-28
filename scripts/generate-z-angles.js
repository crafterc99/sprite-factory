#!/usr/bin/env node
/**
 * TASK-2004: Generate z directional angle sprites (8 cardinal/diagonal)
 *
 * Character: z
 *   - Athletic basketball player, 72 in, jersey-less standardized outfit
 *   - Style: 16-bit pixel art, GBA style
 *   - Portrait: data/assets/zfull.png
 *   - Ref angles for guidance: data/assets/viv-angle-0..7.png
 *
 * Output: data/assets/z-angle-0.png through z-angle-7.png (180x180 each)
 * Model: gemini-2.5-flash-image (pro models returning 500)
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { recordCost } = require('../middleware/cost-tracker');

const BASE_DIR   = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(BASE_DIR, 'data/assets');
const CHARS_FILE = path.join(BASE_DIR, 'data/.characters.json');
const STATUS_FILE = '/tmp/z-angles-status.json';
const MODEL_ID   = 'gemini-2.5-flash-image';

const PORTRAIT_PATH = path.join(ASSETS_DIR, 'zfull.png');

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

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[STATUS]', JSON.stringify(obj));
}

function buildAnglePrompt(angleName, angleIndex) {
  const angleDesc = ANGLE_DESCRIPTIONS[angleName];
  return [
    `IDENTITY REFERENCE: Image 1 is the character's portrait. Keep their exact face, skin tone, hairstyle, and body proportions.`,
    ``,
    `TASK: Generate this character ${angleDesc}.`,
    `This is angle ${angleIndex + 1} of 8 in a full turnaround sheet.`,
    ``,
    `OUTFIT — STANDARDIZED:`,
    `- Plain brown t-shirt (solid #8B4513 / saddle brown)`,
    `- Black baggy basketball pants/shorts`,
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

/**
 * Post-process a generated angle image: remove green BG, crop to content,
 * embed in 180x180 with 10px margin (same padding fix as z-dribble and viv-idle).
 */
async function postProcessAngle(rawBuffer, outputPath) {
  const FRAME_SIZE   = 180;
  const CONTENT_AREA = 160; // 10px margin all sides

  // Save raw buffer to temp
  const tmpRaw = outputPath + '.tmp-raw.png';
  fs.writeFileSync(tmpRaw, rawBuffer);

  // Load and detect size
  const meta = await sharp(tmpRaw).metadata();

  // Remove green background (HSV chroma key)
  // Convert to raw pixel data and zero out green pixels
  const { data, info } = await sharp(tmpRaw)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = data;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    // Simple green screen: if green channel dominates by a lot and is bright
    if (g > 180 && g > r * 1.4 && g > b * 1.4) {
      pixels[i + 3] = 0; // transparent
    }
  }

  const cleanBuffer = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();

  // Find content bounding box
  const cleanMeta = await sharp(cleanBuffer).metadata();
  const { data: cleanData, info: cleanInfo } = await sharp(cleanBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = cleanInfo.width, minY = cleanInfo.height, maxX = 0, maxY = 0;
  for (let y = 0; y < cleanInfo.height; y++) {
    for (let x = 0; x < cleanInfo.width; x++) {
      const idx = (y * cleanInfo.width + x) * 4;
      if (cleanData[idx + 3] > 10) { // visible pixel
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let cropped;
  if (maxX < minX || maxY < minY) {
    // No content found — use the whole image
    cropped = cleanBuffer;
  } else {
    const padding = 4;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(cleanInfo.width - 1, maxX + padding);
    maxY = Math.min(cleanInfo.height - 1, maxY + padding);

    cropped = await sharp(cleanBuffer)
      .extract({
        left: minX, top: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      })
      .toBuffer();
  }

  // Scale to fit within 160x160 (preserves aspect ratio)
  const scaled = await sharp(cropped)
    .resize(CONTENT_AREA, CONTENT_AREA, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  const scaledMeta = await sharp(scaled).metadata();
  const left = Math.round((FRAME_SIZE - scaledMeta.width)  / 2);
  const top  = Math.round((FRAME_SIZE - scaledMeta.height) / 2);

  // Embed centered in 180x180 transparent canvas
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

  // Cleanup temp
  fs.unlinkSync(tmpRaw);

  const outMeta = await sharp(outputPath).metadata();
  return { width: outMeta.width, height: outMeta.height };
}

async function main() {
  writeStatus({ status: 'starting', portrait: PORTRAIT_PATH });

  if (!fs.existsSync(PORTRAIT_PATH)) {
    writeStatus({ status: 'error', error: `Portrait not found: ${PORTRAIT_PATH}` });
    process.exit(1);
  }

  const client = new NanaBananaClient({ model: MODEL_ID });
  const generated = [];
  const failed = [];

  for (let i = 0; i < 8; i++) {
    const angleName = ANGLE_NAMES[i];
    const outputPath = path.join(ASSETS_DIR, `z-angle-${i}.png`);

    console.log(`\n=== Generating z-angle-${i} (${angleName}) ===`);
    writeStatus({ status: `generating angle ${i}`, angleName, angleIndex: i });

    try {
      const prompt = buildAnglePrompt(angleName, i);

      const result = await client.generate(prompt, {
        referenceImages: [PORTRAIT_PATH],
        aspectRatio: '1:1',
        resolution: '1K',
        model: MODEL_ID,
        timeoutMs: 120000, // 2 min per angle
        maxRetries: 4,
      });

      recordCost(MODEL_ID, 'angle', '1K', 1, { character: 'z', angleName });

      // Post-process: remove BG, crop, embed in 180x180
      const dims = await postProcessAngle(result.imageBuffer, outputPath);
      console.log(`  Saved: ${outputPath} (${dims.width}x${dims.height})`);

      generated.push({ angleIndex: i, angleName, outputPath, dims });
    } catch (err) {
      console.error(`  FAILED angle ${i} (${angleName}): ${err.message}`);
      failed.push({ angleIndex: i, angleName, error: err.message });
    }

    // Small delay between requests to avoid rate limiting
    if (i < 7) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Verify all 8 generated
  const allPaths = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(ASSETS_DIR, `z-angle-${i}.png`);
    if (fs.existsSync(p)) {
      allPaths.push(`z-angle-${i}.png`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Generated: ${generated.length}/8 angles`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`  FAILED angle-${f.angleIndex} (${f.angleName}): ${f.error}`);
    }
  }

  // Update .characters.json with angle paths
  if (allPaths.length > 0) {
    try {
      const chars = JSON.parse(fs.readFileSync(CHARS_FILE, 'utf8'));
      if (!chars.z) chars.z = {};
      if (!chars.z.anchor) chars.z.anchor = { angles: [], ballRefs: [], status: 'partial' };
      chars.z.anchor.angles = allPaths;
      if (allPaths.length === 8) chars.z.anchor.status = 'complete';
      fs.writeFileSync(CHARS_FILE, JSON.stringify(chars, null, 2) + '\n', 'utf8');
      console.log(`\nUpdated .characters.json: z.anchor.angles = [${allPaths.join(', ')}]`);
    } catch (err) {
      console.error(`Failed to update .characters.json: ${err.message}`);
    }
  }

  writeStatus({
    status: 'done',
    completedAt: new Date().toISOString(),
    generated: generated.length,
    failed: failed.length,
    anglePaths: allPaths,
    failedDetails: failed,
  });

  if (failed.length > 0) process.exit(1);
}

main().catch(err => {
  writeStatus({ status: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
