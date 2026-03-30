#!/usr/bin/env node
/**
 * backfill-angles.js
 *
 * For every character in data/.characters.json, generate the three angle sets
 * that the UI expects (body, headshot, clothes) if the files don't already exist.
 *
 * Sets generated per character:
 *   body     — {char}-angle-{0..7}.png        via buildAnglePrompt
 *   headshot — {char}-headshot-{0..7}.png     via buildHeadshotAnglePrompt
 *   clothes  — {char}-clothes-{0..7}.png      via buildClothesAnglePrompt
 *
 * After all three sets finish for a character, .characters.json is updated:
 *   anchor.status          = 'complete'
 *   headshotAnglesComplete = true
 *   clothesAnglesComplete  = true
 *
 * Model: gemini-2.5-flash-image only.
 * Execution: fully sequential — no parallelism.
 * Skip: any output file that already exists on disk.
 *
 * Run syntax check only: node -e "require('./scripts/backfill-angles'); console.log('syntax OK')"
 * Run backfill:          node scripts/backfill-angles.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const { NanaBananaClient }        = require('../lib/sprite-generator/nano-banana');
const { buildAnglePrompt,
        buildHeadshotAnglePrompt,
        buildClothesAnglePrompt } = require('../lib/sprite-generator/prompts');

// ─── Paths ────────────────────────────────────────────────────────────────────

const BASE_DIR   = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(BASE_DIR, 'data/assets');
const CHARS_PATH = path.join(BASE_DIR, 'data/.characters.json');

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_ID     = 'gemini-2.5-flash-image';
const FRAME_SIZE   = 180;
const CONTENT_AREA = 160;

const ANGLE_NAMES = [
  'front', 'front-3/4-L', 'side-L', 'back-3/4-L',
  'back',  'back-3/4-R',  'side-R', 'front-3/4-R',
];

// ─── Post-processing: green removal + 160x160-within-180x180 padding ─────────

async function postProcessAngle(rawBuffer, outputPath) {
  const tmpRaw = outputPath + '.tmp-raw.png';
  fs.writeFileSync(tmpRaw, rawBuffer);

  // Remove green chroma-key background
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
    const pad = 4;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(cleanInfo.width  - 1, maxX + pad);
    maxY = Math.min(cleanInfo.height - 1, maxY + pad);
    cropped = await sharp(cleanBuffer)
      .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
      .toBuffer();
  }

  // Scale content to fit inside 160x160, then center in 180x180 transparent canvas
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

  const meta = await sharp(outputPath).metadata();
  return { width: meta.width, height: meta.height };
}

// ─── Generate one set of 8 angles for a character ────────────────────────────

/**
 * @param {NanaBananaClient} client
 * @param {string} charName
 * @param {string} portraitPath
 * @param {'body'|'headshot'|'clothes'} setType
 * @returns {{ done: number, skipped: number, failed: number }}
 */
async function generateAngleSet(client, charName, portraitPath, setType) {
  const label = `[backfill] ${charName} — ${setType}`;
  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < 8; i++) {
    const angleName = ANGLE_NAMES[i];

    // Determine output filename by set type
    let outputFilename;
    if (setType === 'body') {
      outputFilename = `${charName}-angle-${i}.png`;
    } else if (setType === 'headshot') {
      outputFilename = `${charName}-headshot-${i}.png`;
    } else {
      outputFilename = `${charName}-clothes-${i}.png`;
    }

    const outputPath = path.join(ASSETS_DIR, outputFilename);

    if (fs.existsSync(outputPath)) {
      skipped++;
      console.log(`${label} ${i + 1}/8 skip (exists): ${outputFilename}`);
      continue;
    }

    // Build prompt for this set type
    let promptObj;
    if (setType === 'body') {
      promptObj = buildAnglePrompt(charName, angleName, i, 8);
    } else if (setType === 'headshot') {
      promptObj = buildHeadshotAnglePrompt(charName, angleName, i, 8);
    } else {
      promptObj = buildClothesAnglePrompt(charName, angleName, i, 8);
    }

    try {
      console.log(`${label} ${i + 1}/8 generating: ${outputFilename} (${angleName})`);
      const result = await client.generate(promptObj.prompt, {
        referenceImages: [portraitPath],
        aspectRatio: '1:1',
        resolution: '1K',
        model: MODEL_ID,
        timeoutMs: 120000,
        maxRetries: 4,
      });

      const dims = await postProcessAngle(result.imageBuffer, outputPath);
      done++;
      console.log(`${label} ${done + skipped}/${done + skipped + failed} done — ${dims.width}x${dims.height}`);
    } catch (err) {
      failed++;
      console.error(`${label} ${i + 1}/8 FAILED (${angleName}): ${err.message}`);
    }

    // Brief pause between API calls to avoid rate limiting
    if (i < 7) await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`${label} complete — done: ${done}, skipped: ${skipped}, failed: ${failed}`);
  return { done, skipped, failed };
}

// ─── Update .characters.json after a character's sets are complete ─────────

function updateCharactersJson(charName, bodyDone, headshotDone, clothesDone) {
  const chars = JSON.parse(fs.readFileSync(CHARS_PATH, 'utf8'));
  const char = chars[charName];
  if (!char) return;

  if (!char.anchor) char.anchor = { angles: [], ballRefs: [], status: 'partial' };

  if (bodyDone) {
    const anglePaths = [];
    for (let i = 0; i < 8; i++) {
      const p = path.join(ASSETS_DIR, `${charName}-angle-${i}.png`);
      anglePaths.push(fs.existsSync(p) ? `${charName}-angle-${i}.png` : null);
    }
    char.anchor.angles = anglePaths;
    if (anglePaths.every(Boolean)) char.anchor.status = 'complete';
  }

  if (headshotDone) char.headshotAnglesComplete = true;
  if (clothesDone)  char.clothesAnglesComplete  = true;

  fs.writeFileSync(CHARS_PATH, JSON.stringify(chars, null, 2) + '\n', 'utf8');
  // Validate parse
  JSON.parse(fs.readFileSync(CHARS_PATH, 'utf8'));
  console.log(`[backfill] ${charName} — .characters.json updated (body:${bodyDone} headshot:${headshotDone} clothes:${clothesDone})`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const chars = JSON.parse(fs.readFileSync(CHARS_PATH, 'utf8'));
  const charNames = Object.keys(chars);

  console.log(`[backfill] Characters to process: ${charNames.join(', ')}`);

  const client = new NanaBananaClient({ model: MODEL_ID });

  for (const charName of charNames) {
    const char = chars[charName];
    const portraitFile = char.portraitPath || `${charName}full.png`;
    const portraitPath = path.join(ASSETS_DIR, portraitFile);

    if (!fs.existsSync(portraitPath)) {
      console.warn(`[backfill] ${charName} — portrait not found at ${portraitPath}, skipping`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[backfill] ${charName} — portrait: ${portraitFile}`);
    console.log(`${'='.repeat(60)}`);

    const bodyResult     = await generateAngleSet(client, charName, portraitPath, 'body');
    const headshotResult = await generateAngleSet(client, charName, portraitPath, 'headshot');
    const clothesResult  = await generateAngleSet(client, charName, portraitPath, 'clothes');

    const bodyOk     = (bodyResult.done     + bodyResult.skipped)     === 8;
    const headshotOk = (headshotResult.done + headshotResult.skipped) === 8;
    const clothesOk  = (clothesResult.done  + clothesResult.skipped)  === 8;

    if (bodyOk || headshotOk || clothesOk) {
      updateCharactersJson(charName, bodyOk, headshotOk, clothesOk);
    } else {
      console.warn(`[backfill] ${charName} — no sets fully complete, skipping .characters.json update`);
    }
  }

  console.log('\n[backfill] All characters processed.');
}

// Only run if executed directly (not when require()d for syntax check)
if (require.main === module) {
  main().catch(err => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  });
}
