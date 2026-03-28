#!/usr/bin/env node
/**
 * generate-base-animations.js
 *
 * Text-only strip generation for breezy's base animation states:
 *   idle (4 frames), walk (8 frames), jump (5 frames)
 *
 * No pose reference exists for these — portrait is used as character identity
 * reference only. Prompts describe the animation entirely via text.
 *
 * Output: data/assets/breezy-{animation}.png (180px-frame horizontal strips)
 *
 * Usage:
 *   node scripts/generate-base-animations.js
 *   node scripts/generate-base-animations.js idle
 *   node scripts/generate-base-animations.js walk jump
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

// ─── Animation Definitions ────────────────────────────────────────────────────

const ANIMATIONS = {
  idle: {
    frames: 4,
    fps: 6,
    loop: true,
    action: 'standing idle, subtle weight shift and breathing',
    frameBreakdown: '(1) neutral upright stance, weight centered, arms relaxed at sides (2) slight weight shift to right foot, right shoulder dips slightly (3) back to center, minimal movement, knees soft (4) slight weight shift to left foot, left shoulder dips slightly',
  },
  walk: {
    frames: 8,
    fps: 10,
    loop: true,
    action: 'standard walk cycle, no basketball',
    frameBreakdown: '(1) right foot heel strike, left arm forward (2) right foot flat, weight transferring (3) right foot toe push-off, body rising (4) both feet briefly off ground, mid-stride (5) left foot heel strike, right arm forward (6) left foot flat, weight transferring (7) left foot toe push-off, body rising (8) both feet briefly off ground completing stride',
  },
  jump: {
    frames: 5,
    fps: 8,
    loop: false,
    action: 'vertical jump, no basketball',
    frameBreakdown: '(1) athletic crouch, knees bent deep, arms swinging back for momentum (2) explosive push-off, legs extending, arms swinging up (3) peak of jump, fully airborne, legs tucked slightly, arms raised (4) beginning descent, legs extending downward, arms lowering (5) landing with bent knees absorbing impact, arms out for balance',
  },
};

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildTextOnlyPrompt(anim) {
  return [
    `Generate a pixel art sprite sheet for the character shown in Image 1.`,
    ``,
    `CHARACTER: Use the character from Image 1 exactly — same face, skin tone, hairstyle, outfit, and proportions.`,
    ``,
    `ANIMATION: ${anim.action}`,
    `Frame breakdown: ${anim.frameBreakdown}`,
    ``,
    `OUTPUT FORMAT:`,
    `- Single horizontal strip of EXACTLY ${anim.frames} frames, equally-sized, NO gaps, NO borders`,
    `- Characters must be LARGE — fill ~85% of each frame's height`,
    `- Same character size in every frame, feet on same baseline`,
    `- Smooth, readable animation — each frame flows naturally from the previous`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character`,
    `Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
    `NO green (#00FF00) on the character itself`,
    `NO anti-aliasing, NO gradients on background`,
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generate(animName) {
  const anim = ANIMATIONS[animName];
  if (!anim) throw new Error(`Unknown animation: ${animName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const client = new NanaBananaClient({ model: 'gemini-2.5-flash-image' });

  const rawPath = path.join(RAW_DIR, `breezy-${animName}-raw.png`);
  const outputName = `breezy-${animName}`;

  console.log(`\n[${animName}] Generating ${anim.frames}-frame strip (text-only, ${anim.action})...`);

  if (!fs.existsSync(PORTRAIT)) {
    throw new Error(`Portrait not found: ${PORTRAIT}`);
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const prompt = buildTextOnlyPrompt(anim);

  // No pose reference — portrait is the only reference image (character identity)
  await client.generateSprite(prompt, null, PORTRAIT, {
    aspectRatio: '16:9',
    resolution: '2K',
    model: 'gemini-2.5-flash-image',
    outputPath: rawPath,
  });

  console.log(`[${animName}] Raw saved → ${rawPath}`);
  console.log(`[${animName}] Processing sprite (cutting ${anim.frames} frames at 180px)...`);

  // Use floor to avoid off-by-one when rawWidth % frameCount != 0
  const rawMeta = await sharp(rawPath).metadata();
  const frameWidth = Math.floor(rawMeta.width / anim.frames);

  const processed = await processSprite(rawPath, outputName, {
    frameCount: anim.frames,
    frameWidth,
    frameHeight: rawMeta.height,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  const finalPath = path.join(ASSETS_DIR, `${outputName}.png`);
  console.log(`[${animName}] Done → ${finalPath} (${processed.frameCount} frames)`);

  return { animName, frames: processed.frameCount, path: finalPath };
}

async function main() {
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : Object.keys(ANIMATIONS);

  const invalid = targets.filter(t => !ANIMATIONS[t]);
  if (invalid.length > 0) {
    console.error(`Unknown animations: ${invalid.join(', ')}`);
    console.error(`Available: ${Object.keys(ANIMATIONS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Generating base animations for breezy: ${targets.join(', ')}`);
  console.log(`Portrait: ${PORTRAIT}`);
  console.log(`Output dir: ${ASSETS_DIR}`);

  const results = [];
  for (const name of targets) {
    try {
      const result = await generate(name);
      results.push({ ...result, status: 'ok' });
    } catch (err) {
      console.error(`[${name}] FAILED: ${err.message}`);
      results.push({ animName: name, status: 'error', error: err.message });
    }
  }

  console.log('\n─── Summary ─────────────────────────────────────────');
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`  ✓ breezy-${r.animName}.png  (${r.frames} frames)`);
    } else {
      console.log(`  ✗ breezy-${r.animName}  ERROR: ${r.error}`);
    }
  }
  console.log('─────────────────────────────────────────────────────');

  const failed = results.filter(r => r.status === 'error');
  if (failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
