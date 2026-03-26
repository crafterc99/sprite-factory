#!/usr/bin/env node
/**
 * Reference Strip Builder
 *
 * Takes selected key frames and composites them into a single horizontal
 * reference strip image. This becomes Image 1 (pose/layout reference)
 * for Nano Banana Pro generation.
 *
 * Usage:
 *   node strip-builder.js ./keyframes/ -o ref-strip.png
 *   node strip-builder.js ./keyframes/ -o ref-strip.png --height 512
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

/**
 * Build a horizontal reference strip from a set of frame images.
 *
 * @param {string[]} framePaths - Paths to frame images
 * @param {string} outputPath - Output PNG path
 * @param {object} opts - { height, padding }
 * @returns {{ outputPath, frameCount, width, height }}
 */
async function buildRefStrip(framePaths, outputPath, opts = {}) {
  const targetHeight = opts.height || 512;
  const padding = opts.padding || 0;

  if (framePaths.length === 0) throw new Error('No frames provided');

  // Resize all frames to equal height, maintaining aspect ratio
  const resizedBuffers = [];
  const frameDims = [];

  for (const fp of framePaths) {
    const meta = await sharp(fp).metadata();
    const scale = targetHeight / meta.height;
    const newWidth = Math.round(meta.width * scale);

    const buf = await sharp(fp)
      .resize(newWidth, targetHeight, { fit: 'fill' })
      .png()
      .toBuffer();

    resizedBuffers.push(buf);
    frameDims.push({ width: newWidth, height: targetHeight });
  }

  // Calculate total strip dimensions
  const totalWidth = frameDims.reduce((sum, d) => sum + d.width + padding, -padding);
  const totalHeight = targetHeight;

  // Composite all frames side by side
  const composites = [];
  let xOffset = 0;

  for (let i = 0; i < resizedBuffers.length; i++) {
    composites.push({
      input: resizedBuffers[i],
      left: xOffset,
      top: 0,
    });
    xOffset += frameDims[i].width + padding;
  }

  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return {
    outputPath,
    frameCount: framePaths.length,
    width: totalWidth,
    height: totalHeight,
  };
}

/**
 * Build strip from a directory of frame images.
 */
async function buildFromDir(dir, outputPath, opts = {}) {
  const framePaths = fs.readdirSync(dir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort()
    .map(f => path.join(dir, f));

  if (framePaths.length === 0) {
    throw new Error(`No image files found in ${dir}`);
  }

  return buildRefStrip(framePaths, outputPath, opts);
}

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const inputDir = args[0];

  if (!inputDir) {
    console.log(chalk.cyan.bold('\n  Reference Strip Builder\n'));
    console.log(chalk.white('  Usage:'));
    console.log(chalk.gray('    node strip-builder.js <frames-dir> -o <output.png> [--height 512]\n'));
    console.log(chalk.white('  Options:'));
    console.log(chalk.gray('    -o, --output <path>   Output PNG path (default: ref-strip.png)'));
    console.log(chalk.gray('    --height <px>          Frame height (default: 512)'));
    console.log(chalk.gray('    --padding <px>         Gap between frames (default: 0)'));
    process.exit(0);
  }

  const getOpt = (name, alt) => {
    const idx = args.indexOf(`--${name}`);
    const idx2 = alt ? args.indexOf(alt) : -1;
    const i = idx >= 0 ? idx : idx2;
    return i >= 0 ? args[i + 1] : undefined;
  };

  const outputPath = getOpt('output', '-o') || 'ref-strip.png';
  const height = getOpt('height') ? parseInt(getOpt('height')) : 512;
  const padding = getOpt('padding') ? parseInt(getOpt('padding')) : 0;

  buildFromDir(inputDir, outputPath, { height, padding })
    .then(result => {
      console.log(chalk.green(`\n  Built reference strip: ${result.frameCount} frames`));
      console.log(chalk.gray(`  Size: ${result.width} x ${result.height}px`));
      console.log(chalk.gray(`  Output: ${result.outputPath}`));
    })
    .catch(err => {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    });
}

module.exports = { buildRefStrip, buildFromDir };
