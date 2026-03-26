#!/usr/bin/env node
/**
 * Reference Sheet Builder
 *
 * Creates a composite reference image for Higgsfield generation:
 * - Left side: Character reference (99's portrait)
 * - Right side: Breezy's animation frames as pose reference
 *
 * This gives Higgsfield both WHO to draw and WHAT POSES to draw.
 *
 * Usage:
 *   node reference-builder.js <animation>
 *   node reference-builder.js all
 *   node reference-builder.js idle-dribble --char-ref /path/to/face.png
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { ANIMATIONS } = require('./prompts');

const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const RAW_DIR = path.resolve(__dirname, '../../raw-sprites');
const REFS_DIR = path.resolve(__dirname, '../../raw-sprites/references');
const DEFAULT_CHAR_REF = '/Users/crafterc/Downloads/hf_20260308_035112_1880e12f-0043-4740-aa86-a08758745e0b.png';

// Map animation names to Breezy's actual sprite filenames
// Some animations don't have Breezy refs yet (block, dunk, pass, celebration)
const BREEZY_SPRITE_MAP = {
  'idle-dribble': { file: 'breezy-static-dribble.png', frameW: 180, frameH: 180 },
  'dribble': { file: 'breezy-dribble.png', frameW: 180, frameH: 180 },
  'jumpshot': { file: 'breezy-jumpshot.png', frameW: 180, frameH: 180 },
  'stepback': { file: 'breezy-stepback.png', frameW: 180, frameH: 180 },
  'crossover': { file: 'breezy-crossover.png', frameW: 180, frameH: 180 },
  'defense-backpedal': { file: 'breezy-defense-backpedal.png', frameW: 180, frameH: 180 },
  'defense-shuffle': { file: 'breezy-defense-shuffle.png', frameW: 180, frameH: 180 },
  'steal': { file: 'breezy-steal.png', frameW: 180, frameH: 180 },
};

/**
 * Build a reference composite sheet for a single animation.
 *
 * Layout:
 * ┌──────────────┬────────────────────────────────┐
 * │              │  Frame 1  Frame 2  Frame 3 ... │
 * │  Character   │  (Breezy's animation frames    │
 * │  Reference   │   as pose reference)            │
 * │  (99)        │                                 │
 * │              │                                 │
 * └──────────────┴────────────────────────────────┘
 */
async function buildReferenceSheet(animName, opts = {}) {
  const charRefPath = opts.charRef || DEFAULT_CHAR_REF;
  const anim = ANIMATIONS[animName];
  if (!anim) throw new Error(`Unknown animation: ${animName}`);

  const breezyRef = BREEZY_SPRITE_MAP[animName];
  const frameCount = anim.frames;

  fs.mkdirSync(REFS_DIR, { recursive: true });

  // Target sizes
  const charRefSize = 512; // character reference column width
  const frameSize = 256;   // each pose reference frame
  const padding = 20;
  const labelHeight = 60;

  // Calculate dimensions
  const framesPerRow = Math.min(frameCount, 4);
  const frameRows = Math.ceil(frameCount / framesPerRow);
  const poseAreaW = framesPerRow * (frameSize + padding) + padding;
  const poseAreaH = frameRows * (frameSize + padding) + padding + labelHeight;

  const totalW = charRefSize + padding * 3 + poseAreaW;
  const totalH = Math.max(charRefSize + padding * 2 + labelHeight, poseAreaH + labelHeight);

  // Start with white canvas
  const composites = [];

  // 1. Add character reference (left side)
  const charRefBuf = await sharp(charRefPath)
    .resize(charRefSize, charRefSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  composites.push({
    input: charRefBuf,
    left: padding,
    top: labelHeight + padding,
  });

  // 2. Add "CHARACTER REF" label area (a colored bar)
  const charLabelBuf = await sharp({
    create: { width: charRefSize, height: labelHeight - 10, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 255 } },
  }).png().toBuffer();

  composites.push({
    input: charLabelBuf,
    left: padding,
    top: 5,
  });

  // 3. Add pose reference frames (right side)
  if (breezyRef) {
    const breezyPath = path.join(SOUL_JAM_ASSETS, breezyRef.file);
    if (fs.existsSync(breezyPath)) {
      // Cut Breezy's strip into individual frames
      const stripMeta = await sharp(breezyPath).metadata();
      const actualFrames = Math.round(stripMeta.width / breezyRef.frameW);

      for (let i = 0; i < Math.min(actualFrames, frameCount); i++) {
        const row = Math.floor(i / framesPerRow);
        const col = i % framesPerRow;

        const frameBuf = await sharp(breezyPath)
          .extract({
            left: i * breezyRef.frameW,
            top: 0,
            width: breezyRef.frameW,
            height: breezyRef.frameH,
          })
          .resize(frameSize, frameSize, { fit: 'contain', background: { r: 240, g: 240, b: 240, alpha: 255 } })
          .png()
          .toBuffer();

        composites.push({
          input: frameBuf,
          left: charRefSize + padding * 2 + col * (frameSize + padding),
          top: labelHeight + padding + row * (frameSize + padding),
        });
      }
    }
  }

  // 4. Add "POSE REF" label
  const poseLabelBuf = await sharp({
    create: { width: poseAreaW - padding, height: labelHeight - 10, channels: 4, background: { r: 255, g: 100, b: 0, alpha: 255 } },
  }).png().toBuffer();

  composites.push({
    input: poseLabelBuf,
    left: charRefSize + padding * 2,
    top: 5,
  });

  // Build the composite
  const outputPath = path.join(REFS_DIR, `99-${animName}-reference.png`);

  await sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 255 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return { outputPath, hasPoserRef: !!breezyRef, frameCount };
}

/**
 * Build reference sheets for ALL animations.
 */
async function buildAll(opts = {}) {
  const results = [];
  for (const animName of Object.keys(ANIMATIONS)) {
    try {
      const result = await buildReferenceSheet(animName, opts);
      results.push({ animName, ...result });
    } catch (err) {
      results.push({ animName, error: err.message });
    }
  }
  return results;
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);
  const animName = args[0];
  const charRefIdx = args.indexOf('--char-ref');
  const charRef = charRefIdx >= 0 ? args[charRefIdx + 1] : undefined;

  if (!animName) {
    console.log(chalk.cyan.bold('\nReference Sheet Builder\n'));
    console.log(chalk.white('Usage:'));
    console.log(chalk.gray('  node reference-builder.js <animation>    Build one reference sheet'));
    console.log(chalk.gray('  node reference-builder.js all             Build all 12'));
    console.log(chalk.gray('  node reference-builder.js all --char-ref /path/to/face.png'));
    console.log(chalk.gray('\nAvailable animations:'));
    for (const [name, anim] of Object.entries(ANIMATIONS)) {
      const hasRef = BREEZY_SPRITE_MAP[name] ? chalk.green('has pose ref') : chalk.yellow('no pose ref');
      console.log(chalk.gray(`  ${name.padEnd(22)} ${anim.frames} frames  ${hasRef}`));
    }
    process.exit(0);
  }

  (async () => {
    if (animName === 'all') {
      console.log(chalk.cyan.bold('\nBuilding all reference sheets...\n'));
      const results = await buildAll({ charRef });
      for (const r of results) {
        if (r.error) {
          console.log(chalk.red(`  ✗ ${r.animName}: ${r.error}`));
        } else {
          const refTag = r.hasPoserRef ? chalk.green('+ pose ref') : chalk.yellow('prompt only');
          console.log(chalk.white(`  ✓ ${r.animName.padEnd(22)} → ${path.basename(r.outputPath)}  ${refTag}`));
        }
      }
      console.log(chalk.green.bold(`\n✅ ${results.filter(r => !r.error).length} reference sheets saved to raw-sprites/references/`));
      console.log(chalk.gray('\nUpload each reference image to Higgsfield along with the matching prompt.'));
    } else {
      console.log(chalk.cyan(`Building reference sheet for ${animName}...`));
      const result = await buildReferenceSheet(animName, { charRef });
      console.log(chalk.green(`✓ Saved: ${result.outputPath}`));
      console.log(chalk.gray(`  Pose reference: ${result.hasPoserRef ? 'yes (from Breezy)' : 'no (use prompt only)'}`));
    }
  })().catch(err => {
    console.error(chalk.red(err.message));
    process.exit(1);
  });
}

module.exports = { buildReferenceSheet, buildAll };
