#!/usr/bin/env node
/**
 * polish-animations.js
 *
 * Targeted regeneration for QC-flagged animations.
 *
 * POLISH-001: breezy-dribble
 *   Problem: Character fills ~40% frame height, target is ~85%.
 *   Fix: Enhanced size-forcing prompt. Pose ref present — pose-transfer mode.
 *
 * POLISH-002: breezy-steal
 *   Problem: Frame 2 identity drift (darker skin, profile angle shift).
 *   Fix: Explicit per-frame identity lock + consistent front-facing anchor.
 *
 * Usage:
 *   node scripts/polish-animations.js          (runs both)
 *   node scripts/polish-animations.js dribble
 *   node scripts/polish-animations.js steal
 */

'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { processSprite } = require('../lib/sprite-processor/index');

const ASSETS_DIR = path.resolve(__dirname, '../data/assets');
const RAW_DIR = path.resolve(__dirname, '../data/raw-sprites');
const PORTRAIT = path.join(ASSETS_DIR, 'breezyfull.png');
const MODEL = 'gemini-2.5-flash-image';

// ─── Polish Definitions ───────────────────────────────────────────────────────

const POLISHES = {

  // POLISH-001: dribble — character size too small (~40% fill, need ~85%)
  dribble: {
    id: 'POLISH-001',
    frames: 8,
    fps: 10,
    loop: true,
    poseRef: path.join(ASSETS_DIR, 'breezy-dribble.png'),
    buildPrompt(frames) {
      return [
        `REPLICATE Image 1 EXACTLY. Copy every body position, pose, and limb placement frame-for-frame. ONLY replace the character's identity with Image 2.`,
        ``,
        `Image 1 is an ${frames}-frame sprite sheet. Reproduce all ${frames} frames in the same order, same spacing — with Image 2's character instead.`,
        ``,
        `CRITICAL — BODY POSITION:`,
        `- Match Image 1's body pose EXACTLY in every frame — same arm angles, leg positions, weight distribution`,
        `- Same ball position and hand placement`,
        `- Treat Image 1 as motion capture — do NOT reinterpret`,
        ``,
        `CHARACTER SWAP:`,
        `- Replace ONLY the character identity with Image 2 — face, skin tone, hair, outfit`,
        `- Keep Image 2's exact proportions, clothing colors, jersey number`,
        ``,
        `⚠️ SIZE — THIS IS THE MOST IMPORTANT RULE:`,
        `- The character MUST fill 80-90% of each frame's HEIGHT`,
        `- At 180px frame height: character body should span approximately 145-162px tall`,
        `- If the character appears small (filling less than half the frame), it is WRONG`,
        `- Make the character LARGE — feet near the bottom, head near the top of each frame`,
        `- Same character scale in every single frame — lock size across all ${frames} frames`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} frames, equally-sized, no gaps, no borders`,
        `- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
        `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
        `- NO green (#00FF00) on the character itself`,
        `- Feet on same baseline across all frames`,
      ].join('\n');
    },
  },

  // POLISH-002: steal — frame 2 identity drift (darker skin, angle shift)
  steal: {
    id: 'POLISH-002',
    frames: 3,
    fps: 8,
    loop: false,
    poseRef: path.join(ASSETS_DIR, 'breezy-steal.png'),
    buildPrompt(frames) {
      return [
        `REPLICATE Image 1 EXACTLY. Copy every body position, pose, and limb placement frame-for-frame. ONLY replace the character's identity with Image 2.`,
        ``,
        `Image 1 is a ${frames}-frame sprite sheet of a steal attempt: (1) defensive stance ready (2) lunging forward arm reaching to swipe (3) follow through arm fully extended.`,
        ``,
        `CRITICAL — BODY POSITION:`,
        `- Match Image 1's body pose EXACTLY in every frame — same lean, same reach angle`,
        `- Treat Image 1 as motion capture — do NOT reinterpret poses`,
        ``,
        `⚠️ IDENTITY LOCK — MUST BE CONSISTENT ACROSS ALL ${frames} FRAMES:`,
        `- Same character in frame 1, frame 2, AND frame 3 — this is non-negotiable`,
        `- Use Image 2's skin tone in EVERY frame — do not darken or lighten between frames`,
        `- Keep the same face, hairstyle (dark braids), outfit (#11 jersey) across all frames`,
        `- The viewing angle must stay consistent — front-facing or slight 3/4, do NOT switch to profile`,
        `- Frame 2 is a lunge — body leans forward but character identity stays IDENTICAL to frames 1 and 3`,
        ``,
        `CHARACTER SWAP:`,
        `- Replace ONLY the character identity with Image 2`,
        `- Keep Image 2's exact proportions, clothing colors, jersey number`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} frames, equally-sized, no gaps, no borders`,
        `- Characters must be LARGE — fill ~85% of each frame's height`,
        `- Same character size in every frame, feet on same baseline`,
        `- Style: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
        `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
        `- NO green (#00FF00) on the character itself`,
      ].join('\n');
    },
  },
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runPolish(key) {
  const p = POLISHES[key];
  if (!p) throw new Error(`Unknown polish: ${key}. Available: ${Object.keys(POLISHES).join(', ')}`);

  const client = new NanaBananaClient({ model: MODEL });
  const rawPath = path.join(RAW_DIR, `breezy-${key}-polish-raw.png`);
  const outputName = `breezy-${key}`;

  console.log(`\n[${p.id}] ${key} — ${p.frames}f, pose-transfer mode`);

  if (!fs.existsSync(PORTRAIT)) throw new Error(`Portrait not found: ${PORTRAIT}`);
  if (!fs.existsSync(p.poseRef)) throw new Error(`Pose ref not found: ${p.poseRef}`);

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const prompt = p.buildPrompt(p.frames);

  await client.generateSprite(prompt, p.poseRef, PORTRAIT, {
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL,
    outputPath: rawPath,
  });

  console.log(`[${p.id}] Raw saved → ${rawPath}`);
  console.log(`[${p.id}] Processing...`);

  const rawMeta = await sharp(rawPath).metadata();
  const frameWidth = Math.floor(rawMeta.width / p.frames);

  const processed = await processSprite(rawPath, outputName, {
    frameCount: p.frames,
    frameWidth,
    frameHeight: rawMeta.height,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  const finalPath = path.join(ASSETS_DIR, `${outputName}.png`);

  // Verify output dimensions
  const finalMeta = await sharp(finalPath).metadata();
  const actualFrames = Math.round(finalMeta.width / 180);

  console.log(`[${p.id}] Done → ${finalPath} (${finalMeta.width}x${finalMeta.height}, ${actualFrames} frames @ 180px)`);

  return {
    id: p.id,
    key,
    frames: actualFrames,
    width: finalMeta.width,
    height: finalMeta.height,
    path: finalPath,
    status: actualFrames === p.frames ? 'ok' : 'frame-count-mismatch',
  };
}

async function main() {
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : Object.keys(POLISHES);

  const invalid = targets.filter(t => !POLISHES[t]);
  if (invalid.length > 0) {
    console.error(`Unknown polish targets: ${invalid.join(', ')}`);
    console.error(`Available: ${Object.keys(POLISHES).join(', ')}`);
    process.exit(1);
  }

  console.log(`Polish run: ${targets.map(t => POLISHES[t].id + ' (' + t + ')').join(', ')}`);

  const results = [];
  for (const key of targets) {
    try {
      const result = await runPolish(key);
      results.push({ ...result, error: null });
    } catch (err) {
      console.error(`[${key}] FAILED: ${err.message}`);
      results.push({ id: POLISHES[key]?.id || key, key, status: 'error', error: err.message });
    }
  }

  console.log('\n─── Summary ─────────────────────────────────────────');
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`  ✓ ${r.id} — breezy-${r.key}.png (${r.frames}f, ${r.width}x${r.height})`);
    } else {
      console.log(`  ✗ ${r.id} — breezy-${r.key} ERROR: ${r.error || r.status}`);
    }
  }
  console.log('─────────────────────────────────────────────────────');

  const failed = results.filter(r => r.status !== 'ok');
  if (failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
