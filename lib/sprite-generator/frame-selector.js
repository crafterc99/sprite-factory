#!/usr/bin/env node
/**
 * Key Frame Selector
 *
 * Two modes:
 *   - Manual: Terminal UI to pick specific frames by number
 *   - Auto-interval: Evenly sample N frames from the set
 *
 * Usage:
 *   node frame-selector.js select ./frames/ --pick 6 --output ./keyframes/
 *   node frame-selector.js auto ./frames/ --count 6 --output ./keyframes/
 */
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const readline = require('readline');

/**
 * Get sorted frame files from a directory.
 */
function getFrames(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  return fs.readdirSync(dir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort()
    .map(f => path.join(dir, f));
}

/**
 * Auto-interval: evenly sample N frames from total set.
 * Good for looping animations where you want even spacing.
 */
function autoSelect(frames, count) {
  if (count >= frames.length) return [...frames];
  if (count <= 0) return [];

  const selected = [];
  const step = (frames.length - 1) / (count - 1);

  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step);
    selected.push(frames[idx]);
  }

  return selected;
}

/**
 * Manual selection: prompt user to pick frame numbers.
 * Shows available frames and lets user type indices.
 */
async function manualSelect(frames, count) {
  console.log(chalk.cyan.bold('\n  Available Frames:\n'));

  // Show frame listing with indices
  for (let i = 0; i < frames.length; i++) {
    const name = path.basename(frames[i]);
    console.log(chalk.gray(`    [${String(i).padStart(3)}] ${name}`));
  }

  console.log(chalk.white(`\n  Total: ${frames.length} frames`));
  console.log(chalk.white(`  Pick ${count} frames for animation key poses.`));
  console.log(chalk.gray('  Enter frame numbers separated by commas (e.g., 3,12,28,45,61,80)\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.yellow('  > Frame numbers: '), (answer) => {
      rl.close();

      const indices = answer
        .split(/[,\s]+/)
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n) && n >= 0 && n < frames.length);

      if (indices.length === 0) {
        console.log(chalk.yellow('  No valid frames selected. Using auto-interval instead.'));
        resolve(autoSelect(frames, count));
      } else {
        resolve(indices.map(i => frames[i]));
      }
    });
  });
}

/**
 * Copy selected frames to output directory with sequential numbering.
 */
function copyFrames(selectedFrames, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const outputs = [];
  for (let i = 0; i < selectedFrames.length; i++) {
    const ext = path.extname(selectedFrames[i]);
    const outPath = path.join(outputDir, `keyframe-${String(i + 1).padStart(3, '0')}${ext}`);
    fs.copyFileSync(selectedFrames[i], outPath);
    outputs.push(outPath);
  }

  return outputs;
}

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const inputDir = args[1];

  if (!command || !inputDir || !['select', 'auto'].includes(command)) {
    console.log(chalk.cyan.bold('\n  Key Frame Selector\n'));
    console.log(chalk.white('  Usage:'));
    console.log(chalk.gray('    node frame-selector.js select <frames-dir> --pick <n> --output <dir>'));
    console.log(chalk.gray('    node frame-selector.js auto <frames-dir> --count <n> --output <dir>\n'));
    console.log(chalk.white('  Modes:'));
    console.log(chalk.gray('    select   Interactive — pick specific frame numbers'));
    console.log(chalk.gray('    auto     Even interval sampling'));
    process.exit(0);
  }

  const getOpt = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const count = parseInt(getOpt('pick') || getOpt('count') || '6');
  const outputDir = getOpt('output') || './keyframes/';

  (async () => {
    const frames = getFrames(inputDir);
    console.log(chalk.gray(`  Found ${frames.length} frames in ${inputDir}`));

    let selected;
    if (command === 'auto') {
      selected = autoSelect(frames, count);
      console.log(chalk.cyan(`  Auto-selected ${selected.length} frames (even interval)`));
    } else {
      selected = await manualSelect(frames, count);
      console.log(chalk.cyan(`  Selected ${selected.length} frames`));
    }

    const outputs = copyFrames(selected, outputDir);
    console.log(chalk.green(`\n  Saved ${outputs.length} keyframes → ${outputDir}`));
    for (const f of outputs) {
      console.log(chalk.gray(`    ${path.basename(f)}`));
    }
  })().catch(err => {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  });
}

module.exports = { getFrames, autoSelect, manualSelect, copyFrames };
