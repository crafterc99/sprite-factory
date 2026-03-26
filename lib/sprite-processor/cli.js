#!/usr/bin/env node
const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const {
  processSprite,
  cutFrames,
  removeBackground,
  buildStrip,
  detectFrames,
  buildGrid,
  SOUL_JAM_ASSETS,
} = require('./index');

const program = new Command();

program
  .name('sprite')
  .description('Soul Jam sprite processor — automates cutting, bg removal, and sheet assembly')
  .version('1.0.0');

// ─── PROCESS: Full pipeline ─────────────────────────────────────────────
program
  .command('process')
  .description('Full pipeline: cut → remove bg → resize → build strip')
  .argument('<input>', 'Path to raw sprite image from Higgsfield')
  .argument('<name>', 'Output name (e.g. "breezy-crossover")')
  .option('-f, --frames <n>', 'Number of frames in the strip', parseInt)
  .option('-s, --size <px>', 'Target frame size (default: 180)', parseInt, 180)
  .option('-t, --tolerance <n>', 'BG removal tolerance 0-255 (default: 40)', parseInt, 40)
  .option('-b, --bg <hex>', 'Background color to remove (default: #00FF00)', '#00FF00')
  .option('-o, --output <dir>', 'Output directory', SOUL_JAM_ASSETS)
  .option('--no-bg-removal', 'Skip background removal step')
  .option('--frame-width <px>', 'Manual frame width override', parseInt)
  .option('--frame-height <px>', 'Manual frame height override', parseInt)
  .action(async (input, name, opts) => {
    const inputPath = path.resolve(input);
    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`File not found: ${inputPath}`));
      process.exit(1);
    }

    const bgColor = hexToRgb(opts.bg);
    console.log(chalk.cyan.bold('\n🎨 Soul Jam Sprite Processor\n'));
    console.log(chalk.gray(`Input:     ${inputPath}`));
    console.log(chalk.gray(`Output:    ${name}.png`));
    console.log(chalk.gray(`Frame size: ${opts.size}x${opts.size}`));
    if (opts.frames) console.log(chalk.gray(`Frames:    ${opts.frames}`));
    console.log(chalk.gray(`BG color:  ${opts.bg} (tolerance: ${opts.tolerance})`));
    console.log(chalk.gray(`Output dir: ${opts.output}\n`));

    try {
      const result = await processSprite(inputPath, name, {
        frameCount: opts.frames,
        targetSize: opts.size,
        tolerance: opts.bgRemoval === false ? 0 : opts.tolerance,
        bgColor,
        outputDir: opts.output,
        frameWidth: opts.frameWidth,
        frameHeight: opts.frameHeight,
      });

      console.log(chalk.green.bold(`\n✅ Sprite ready!`));
      console.log(chalk.white(`   ${result.outputPath}`));
      console.log(chalk.gray(`\n   Add to PreloadScene.ts:`));
      console.log(chalk.yellow(`   this.load.spritesheet('${name}', 'assets/images/${name}.png', { frameWidth: ${result.frameSize}, frameHeight: ${result.frameSize} });`));
    } catch (err) {
      console.error(chalk.red(`\nError: ${err.message}`));
      process.exit(1);
    }
  });

// ─── CUT: Just cut frames ──────────────────────────────────────────────
program
  .command('cut')
  .description('Cut a sprite sheet into individual frames')
  .argument('<input>', 'Path to sprite sheet')
  .argument('<outputDir>', 'Directory for output frames')
  .option('-f, --frames <n>', 'Expected frame count', parseInt)
  .option('--frame-width <px>', 'Frame width', parseInt)
  .option('--frame-height <px>', 'Frame height', parseInt)
  .action(async (input, outputDir, opts) => {
    const inputPath = path.resolve(input);
    const outDir = path.resolve(outputDir);
    console.log(chalk.cyan(`Cutting ${path.basename(inputPath)}...`));

    const cutOpts = {};
    if (opts.frames) {
      const meta = await require('sharp')(inputPath).metadata();
      cutOpts.frameWidth = Math.round(meta.width / opts.frames);
      cutOpts.frameHeight = meta.height;
    }
    if (opts.frameWidth) cutOpts.frameWidth = opts.frameWidth;
    if (opts.frameHeight) cutOpts.frameHeight = opts.frameHeight;

    const { frames, info } = await cutFrames(inputPath, outDir, cutOpts);
    console.log(chalk.green(`Done! ${frames.length} frames saved to ${outDir}`));
  });

// ─── STRIP: Assemble frames into strip ──────────────────────────────────
program
  .command('strip')
  .description('Assemble individual frames into a horizontal strip')
  .argument('<framesDir>', 'Directory containing frame PNGs')
  .argument('<output>', 'Output strip path')
  .option('-s, --size <px>', 'Frame size', parseInt, 180)
  .action(async (framesDir, output, opts) => {
    const dir = path.resolve(framesDir);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => path.join(dir, f));

    if (files.length === 0) {
      console.error(chalk.red('No PNG files found in directory'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Assembling ${files.length} frames...`));
    await buildStrip(files, path.resolve(output), {
      frameWidth: opts.size,
      frameHeight: opts.size,
    });
    console.log(chalk.green(`Done! Strip saved to ${output}`));
  });

// ─── REMOVE-BG: Remove background color ────────────────────────────────
program
  .command('remove-bg')
  .description('Remove background color from an image')
  .argument('<input>', 'Input image')
  .argument('[output]', 'Output image (defaults to overwrite)')
  .option('-b, --bg <hex>', 'Background color (default: #00FF00)', '#00FF00')
  .option('-t, --tolerance <n>', 'Tolerance 0-255 (default: 40)', parseInt, 40)
  .action(async (input, output, opts) => {
    const inputPath = path.resolve(input);
    const outputPath = output ? path.resolve(output) : inputPath;
    const bgColor = hexToRgb(opts.bg);

    console.log(chalk.cyan(`Removing ${opts.bg} background...`));
    await removeBackground(inputPath, outputPath, {
      bgColor,
      tolerance: opts.tolerance,
    });
    console.log(chalk.green(`Done! Saved to ${outputPath}`));
  });

// ─── INFO: Analyze a sprite sheet ───────────────────────────────────────
program
  .command('info')
  .description('Analyze a sprite sheet and show frame info')
  .argument('<input>', 'Path to sprite sheet')
  .option('-s, --size <px>', 'Expected frame size', parseInt, 180)
  .action(async (input, opts) => {
    const inputPath = path.resolve(input);
    const info = await detectFrames(inputPath, {
      frameWidth: opts.size,
      frameHeight: opts.size,
    });

    console.log(chalk.cyan.bold(`\nSprite Sheet Info: ${path.basename(inputPath)}\n`));
    console.log(`  Image size:  ${info.width} × ${info.height}`);
    console.log(`  Frame size:  ${info.frameWidth} × ${info.frameHeight}`);
    console.log(`  Grid:        ${info.cols} cols × ${info.rows} rows`);
    console.log(`  Total frames: ${info.frameCount}`);
    console.log(`  Strip width:  ${info.cols * info.frameWidth}px (at ${info.frameWidth}px/frame)`);
  });

// ─── BATCH: Process a whole folder of raw sprites ───────────────────────
program
  .command('batch')
  .description('Process all images in a folder (reads manifest.json for config)')
  .argument('<dir>', 'Directory with raw images and manifest.json')
  .option('-s, --size <px>', 'Target frame size', parseInt, 180)
  .option('-o, --output <dir>', 'Output directory', SOUL_JAM_ASSETS)
  .action(async (dir, opts) => {
    const inputDir = path.resolve(dir);
    const manifestPath = path.join(inputDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      console.error(chalk.red(`No manifest.json found in ${inputDir}`));
      console.log(chalk.gray('\nCreate a manifest.json like:'));
      console.log(chalk.yellow(JSON.stringify({
        sprites: [
          { file: 'raw-crossover.png', name: 'breezy-crossover', frames: 4 },
          { file: 'raw-jumpshot.png', name: 'breezy-jumpshot', frames: 7 },
        ],
      }, null, 2)));
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(chalk.cyan.bold(`\nBatch processing ${manifest.sprites.length} sprites...\n`));

    for (const sprite of manifest.sprites) {
      const inputPath = path.join(inputDir, sprite.file);
      if (!fs.existsSync(inputPath)) {
        console.log(chalk.yellow(`⚠ Skipping ${sprite.file} (not found)`));
        continue;
      }

      await processSprite(inputPath, sprite.name, {
        frameCount: sprite.frames,
        targetSize: sprite.size || opts.size,
        tolerance: sprite.tolerance || 40,
        bgColor: sprite.bgColor ? hexToRgb(sprite.bgColor) : undefined,
        outputDir: opts.output,
      });
    }

    console.log(chalk.green.bold(`\n✅ Batch complete!`));
  });

// ─── GRID: Assemble all strips into a single grid sheet ─────────────────
program
  .command('grid')
  .description('Assemble all animation strips for a character into a single grid sprite sheet')
  .argument('<character>', 'Character name (e.g., 99, breezy)')
  .option('-s, --size <px>', 'Frame size (default: 180)', parseInt, 180)
  .option('-a, --assets <dir>', 'Assets directory', SOUL_JAM_ASSETS)
  .option('-o, --output <dir>', 'Output directory', SOUL_JAM_ASSETS)
  .action(async (character, opts) => {
    console.log(chalk.cyan.bold(`\n  Grid Sheet Assembler — ${character}\n`));

    try {
      const result = await buildGrid(character, {
        frameSize: opts.size,
        assetsDir: opts.assets,
        outputDir: opts.output,
      });

      if (result.missingAnimations > 0) {
        console.log(chalk.yellow(`\n  ${result.missingAnimations} animations missing — grid has empty rows`));
      }
      console.log(chalk.green.bold(`\n  Grid sheet ready: ${result.outputPath}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

program.parse();
