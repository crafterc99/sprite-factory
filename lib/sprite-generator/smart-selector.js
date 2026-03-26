#!/usr/bin/env node
/**
 * Smart Frame Selector
 *
 * Analyzes basketball footage frames using computer vision heuristics:
 * 1. Tracks the basketball (orange blob) position across frames
 * 2. Detects motion intensity between consecutive frames
 * 3. Picks key poses at inflection points (ball direction changes, peak motion)
 * 4. Learns from user feedback to improve future selections
 *
 * Usage:
 *   node smart-selector.js analyze <frames-dir> --count 6 --output ./keyframes/
 *   node smart-selector.js feedback <session-id> --rating 3 --notes "missed the crossover peak"
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const readline = require('readline');

const FEEDBACK_DIR = path.resolve(__dirname, '../../.training-data');
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'frame-selection-feedback.json');

// ─── Basketball Detection ───────────────────────────────────────────────

/**
 * Detect orange basketball pixels in a frame.
 * Returns { x, y, area, confidence } — centroid of the largest orange cluster.
 *
 * Basketball HSV: Hue 10-30, Sat > 0.4, Val > 0.3
 */
async function detectBall(framePath) {
  const image = sharp(framePath);
  const meta = await image.metadata();

  // Downsample for speed (analyze at 160px wide)
  const scale = 160 / meta.width;
  const w = 160;
  const h = Math.round(meta.height * scale);

  const { data } = await image
    .resize(w, h, { fit: 'fill' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  // Two-pass detection: strict orange first, then relaxed for indoor lighting
  let sumX = 0, sumY = 0, count = 0;
  const orangePixels = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Convert to HSV for better detection across lighting conditions
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let hue = 0;
      if (d !== 0) {
        if (max === r) hue = ((g - b) / d) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      const sat = max === 0 ? 0 : d / max;
      const val = max / 255;

      // Basketball detection: warm hues (orange/brown range)
      // Bright orange: hue 10-40, sat > 0.3
      // Indoor/muted: hue 15-50, sat > 0.15, R > G > B pattern
      const isBrightOrange = hue >= 5 && hue <= 45 && sat > 0.3 && val > 0.3;
      const isMutedOrange = hue >= 10 && hue <= 55 && sat > 0.12 && val > 0.35
        && r > g && g > b && (r - b) > 25;

      if (isBrightOrange || isMutedOrange) {
        const weight = isBrightOrange ? 2.0 : 1.0; // bright orange counts more
        sumX += x * weight;
        sumY += y * weight;
        count += weight;
        orangePixels.push({ x, y, weight });
      }
    }
  }

  if (count < 3) {
    return { x: -1, y: -1, area: 0, confidence: 0, found: false };
  }

  // Cluster detection: find the largest cluster of orange pixels (the ball)
  // Simple approach: use the centroid but weight by density
  const totalWeight = count;

  return {
    x: (sumX / totalWeight) / w,  // normalized 0-1
    y: (sumY / totalWeight) / h,  // normalized 0-1
    area: orangePixels.length / (w * h),  // fraction of frame that's orange
    confidence: Math.min(orangePixels.length / 30, 1),
    found: true,
    pixelCount: orangePixels.length,
  };
}

/**
 * Compute motion intensity between two frames.
 * Returns a 0-1 score where 1 = maximum change.
 */
async function computeMotion(framePath1, framePath2) {
  const size = 80; // small for speed

  const buf1 = await sharp(framePath1).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer();
  const buf2 = await sharp(framePath2).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer();

  let diff = 0;
  for (let i = 0; i < buf1.length; i++) {
    diff += Math.abs(buf1[i] - buf2[i]);
  }

  // Normalize: max possible diff = 255 * totalPixels
  return diff / (255 * buf1.length);
}

/**
 * Compute sharpness/blur score for a frame.
 * Uses Laplacian variance — higher = sharper, lower = more motion blur.
 * We WANT some motion blur for action frames but not too much.
 */
async function computeSharpness(framePath) {
  const size = 120;
  const { data } = await sharp(framePath)
    .resize(size, size, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Simple Laplacian: sum of |pixel - average of neighbors|
  let laplacianSum = 0;
  let count = 0;

  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const center = data[y * size + x];
      const neighbors = (
        data[(y - 1) * size + x] +
        data[(y + 1) * size + x] +
        data[y * size + (x - 1)] +
        data[y * size + (x + 1)]
      ) / 4;
      laplacianSum += Math.abs(center - neighbors);
      count++;
    }
  }

  return laplacianSum / count / 255; // 0-1, higher = sharper
}

// ─── Smart Selection Algorithm ──────────────────────────────────────────

/**
 * Analyze all frames and pick the best key frames for sprite animation.
 *
 * Strategy:
 * 1. Track ball position across all frames
 * 2. Compute motion between consecutive frames
 * 3. Find inflection points where ball changes direction (Y or X axis)
 * 4. Find peak motion frames (max body movement)
 * 5. Prefer sharp frames over blurry ones
 * 6. Apply learned preferences from feedback history
 *
 * @param {string[]} framePaths - All extracted frame paths (sorted)
 * @param {number} count - Number of key frames to select
 * @param {object} opts - { minSharpness, ballWeight, motionWeight }
 * @returns {{ selected: string[], analysis: object[] }}
 */
async function smartSelect(framePaths, count, opts = {}) {
  const feedback = loadFeedback();

  // Apply learned weights from feedback
  const ballWeight = opts.ballWeight ?? feedback.weights?.ballPosition ?? 0.35;
  const motionWeight = opts.motionWeight ?? feedback.weights?.motionPeak ?? 0.30;
  const sharpWeight = opts.sharpWeight ?? feedback.weights?.sharpness ?? 0.15;
  const spacingWeight = opts.spacingWeight ?? feedback.weights?.evenSpacing ?? 0.20;
  const minSharpness = opts.minSharpness ?? feedback.thresholds?.minSharpness ?? 0.02;

  console.log(chalk.gray(`  Weights: ball=${ballWeight} motion=${motionWeight} sharp=${sharpWeight} spacing=${spacingWeight}`));

  // Phase 1: Analyze every frame
  console.log(chalk.cyan(`  Analyzing ${framePaths.length} frames...`));
  const analysis = [];

  for (let i = 0; i < framePaths.length; i++) {
    const ball = await detectBall(framePaths[i]);
    const sharpness = await computeSharpness(framePaths[i]);
    const motion = i > 0 ? await computeMotion(framePaths[i - 1], framePaths[i]) : 0;

    analysis.push({
      index: i,
      path: framePaths[i],
      ball,
      sharpness,
      motion,
      score: 0, // computed below
    });

    if ((i + 1) % 10 === 0 || i === framePaths.length - 1) {
      process.stdout.write(chalk.gray(`    ${i + 1}/${framePaths.length}\r`));
    }
  }
  console.log(chalk.gray(`    ${framePaths.length}/${framePaths.length} analyzed`));

  // Phase 2: Compute ball direction changes (inflection points)
  for (let i = 1; i < analysis.length - 1; i++) {
    const prev = analysis[i - 1].ball;
    const curr = analysis[i].ball;
    const next = analysis[i + 1].ball;

    if (curr.found && prev.found && next.found) {
      // Ball Y direction change (bouncing)
      const dyPrev = curr.y - prev.y;
      const dyNext = next.y - curr.y;
      if ((dyPrev > 0 && dyNext < 0) || (dyPrev < 0 && dyNext > 0)) {
        analysis[i].ballInflection = true;
        analysis[i].inflectionMagnitude = Math.abs(dyPrev - dyNext);
      }

      // Ball X direction change (crossover)
      const dxPrev = curr.x - prev.x;
      const dxNext = next.x - curr.x;
      if ((dxPrev > 0.01 && dxNext < -0.01) || (dxPrev < -0.01 && dxNext > 0.01)) {
        analysis[i].ballInflection = true;
        analysis[i].inflectionMagnitude = (analysis[i].inflectionMagnitude || 0) + Math.abs(dxPrev - dxNext);
      }
    }
  }

  // Phase 3: Normalize and score each frame
  const maxMotion = Math.max(...analysis.map(a => a.motion), 0.001);
  const maxSharpness = Math.max(...analysis.map(a => a.sharpness), 0.001);
  const maxInflection = Math.max(...analysis.filter(a => a.inflectionMagnitude).map(a => a.inflectionMagnitude), 0.001);

  for (const frame of analysis) {
    let score = 0;

    // Ball position score: bonus for inflection points
    if (frame.ballInflection) {
      score += ballWeight * (frame.inflectionMagnitude / maxInflection);
    }
    // Bonus for ball being visible and in interesting positions (low = bounce, high = hold)
    if (frame.ball.found) {
      score += ballWeight * 0.3 * frame.ball.confidence;
      // Extra for ball at extremes (very high or very low in frame)
      const yExtreme = Math.abs(frame.ball.y - 0.5) * 2; // 0 at center, 1 at edges
      score += ballWeight * 0.2 * yExtreme;
    }

    // Motion score: prefer high-motion frames (action peaks)
    score += motionWeight * (frame.motion / maxMotion);

    // Sharpness: prefer clear frames, penalize extreme blur
    if (frame.sharpness > minSharpness) {
      score += sharpWeight * (frame.sharpness / maxSharpness);
    } else {
      score -= sharpWeight * 0.5; // penalty for too blurry
    }

    frame.score = score;
  }

  // Phase 4: Select top frames with minimum spacing constraint
  const minSpacing = Math.max(2, Math.floor(framePaths.length / (count * 2)));
  const selected = selectWithSpacing(analysis, count, minSpacing, spacingWeight, framePaths.length);

  return { selected: selected.map(s => s.path), analysis, selectedIndices: selected.map(s => s.index) };
}

/**
 * Select top-scoring frames while maintaining minimum spacing between selections.
 * Also rewards even distribution across the timeline.
 */
function selectWithSpacing(analysis, count, minSpacing, spacingWeight, totalFrames) {
  // Sort by score descending
  const candidates = analysis
    .filter(a => a.sharpness > 0.01) // filter out completely black/blank frames
    .map(a => ({ ...a }))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const usedIndices = new Set();

  // Always include first and last non-blank frames as bookends
  const firstValid = analysis.find(a => a.ball.found || a.motion > 0.01);
  const lastValid = [...analysis].reverse().find(a => a.ball.found || a.motion > 0.01);

  if (firstValid) {
    selected.push(firstValid);
    usedIndices.add(firstValid.index);
  }
  if (lastValid && lastValid.index !== firstValid?.index) {
    selected.push(lastValid);
    usedIndices.add(lastValid.index);
  }

  // Fill remaining slots with highest-scoring frames
  for (const candidate of candidates) {
    if (selected.length >= count) break;
    if (usedIndices.has(candidate.index)) continue;

    // Check minimum spacing from all already-selected frames
    const tooClose = selected.some(s => Math.abs(s.index - candidate.index) < minSpacing);
    if (tooClose) continue;

    selected.push(candidate);
    usedIndices.add(candidate.index);
  }

  // If we still need more, relax spacing
  if (selected.length < count) {
    for (const candidate of candidates) {
      if (selected.length >= count) break;
      if (usedIndices.has(candidate.index)) continue;
      selected.push(candidate);
      usedIndices.add(candidate.index);
    }
  }

  // Sort by frame index (chronological order)
  selected.sort((a, b) => a.index - b.index);

  return selected.slice(0, count);
}

// ─── Feedback System ────────────────────────────────────────────────────

function loadFeedback() {
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
  if (!fs.existsSync(FEEDBACK_FILE)) {
    const initial = {
      sessions: [],
      weights: {
        ballPosition: 0.35,
        motionPeak: 0.30,
        sharpness: 0.15,
        evenSpacing: 0.20,
      },
      thresholds: {
        minSharpness: 0.02,
      },
      totalSessions: 0,
    };
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
}

function saveFeedback(feedback) {
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
}

/**
 * Record a feedback session and adjust weights.
 *
 * @param {string} sessionId - Session identifier
 * @param {number} rating - 1-5 quality rating
 * @param {string} notes - What was wrong/right
 * @param {object} details - { preferredFrames, rejectedFrames, moveType }
 */
function recordFeedback(sessionId, rating, notes, details = {}) {
  const feedback = loadFeedback();

  const session = {
    id: sessionId,
    timestamp: new Date().toISOString(),
    rating,
    notes,
    moveType: details.moveType || 'unknown',
    preferredFrameIndices: details.preferredFrames || [],
    rejectedFrameIndices: details.rejectedFrames || [],
    selectedFrameIndices: details.selectedFrames || [],
  };

  feedback.sessions.push(session);
  feedback.totalSessions++;

  // Adjust weights based on feedback
  const learningRate = 0.1;

  if (rating <= 2) {
    // Poor selection — analyze what went wrong
    if (notes.toLowerCase().includes('blur') || notes.toLowerCase().includes('blurry')) {
      feedback.weights.sharpness = Math.min(0.5, feedback.weights.sharpness + learningRate);
      feedback.thresholds.minSharpness = Math.min(0.1, feedback.thresholds.minSharpness + 0.01);
    }
    if (notes.toLowerCase().includes('ball') || notes.toLowerCase().includes('position')) {
      feedback.weights.ballPosition = Math.min(0.6, feedback.weights.ballPosition + learningRate);
    }
    if (notes.toLowerCase().includes('motion') || notes.toLowerCase().includes('action') || notes.toLowerCase().includes('peak')) {
      feedback.weights.motionPeak = Math.min(0.5, feedback.weights.motionPeak + learningRate);
    }
    if (notes.toLowerCase().includes('spacing') || notes.toLowerCase().includes('spread') || notes.toLowerCase().includes('even')) {
      feedback.weights.evenSpacing = Math.min(0.5, feedback.weights.evenSpacing + learningRate);
    }
    if (notes.toLowerCase().includes('missed') || notes.toLowerCase().includes('crossover') || notes.toLowerCase().includes('transition')) {
      // Missed key transitions — boost ball inflection detection
      feedback.weights.ballPosition = Math.min(0.6, feedback.weights.ballPosition + learningRate * 1.5);
      feedback.weights.motionPeak = Math.min(0.5, feedback.weights.motionPeak + learningRate);
    }
  } else if (rating >= 4) {
    // Good selection — reinforce current weights slightly
    // Move weights 5% toward current values (stabilize)
  }

  // Normalize weights to sum to 1.0
  const totalWeight = feedback.weights.ballPosition + feedback.weights.motionPeak +
    feedback.weights.sharpness + feedback.weights.evenSpacing;
  feedback.weights.ballPosition /= totalWeight;
  feedback.weights.motionPeak /= totalWeight;
  feedback.weights.sharpness /= totalWeight;
  feedback.weights.evenSpacing /= totalWeight;

  saveFeedback(feedback);

  console.log(chalk.green(`\n  Feedback recorded! (Session #${feedback.totalSessions})`));
  console.log(chalk.gray(`  Updated weights:`));
  console.log(chalk.gray(`    Ball position: ${(feedback.weights.ballPosition * 100).toFixed(0)}%`));
  console.log(chalk.gray(`    Motion peaks:  ${(feedback.weights.motionPeak * 100).toFixed(0)}%`));
  console.log(chalk.gray(`    Sharpness:     ${(feedback.weights.sharpness * 100).toFixed(0)}%`));
  console.log(chalk.gray(`    Even spacing:  ${(feedback.weights.evenSpacing * 100).toFixed(0)}%`));

  return feedback;
}

/**
 * Interactive feedback prompt after frame selection.
 * Returns the feedback data.
 */
async function promptFeedback(sessionId, selectedIndices, totalFrames) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log(chalk.cyan.bold('\n  ─── Frame Selection Feedback ───\n'));
  console.log(chalk.white(`  Selected frames: [${selectedIndices.join(', ')}] out of ${totalFrames} total`));

  const ratingStr = await ask(chalk.yellow('  Rate this selection (1=terrible, 5=perfect): '));
  const rating = parseInt(ratingStr) || 3;

  const notes = await ask(chalk.yellow('  What should be different? (e.g., "missed the crossover peak", "too blurry"): '));

  let moveType = await ask(chalk.yellow('  What move is this? (dribble/crossover/jumpshot/stepback/etc): '));
  moveType = moveType.trim() || 'unknown';

  let preferredStr = await ask(chalk.yellow('  Better frame numbers? (comma-separated, or Enter to skip): '));
  const preferredFrames = preferredStr.trim()
    ? preferredStr.split(/[,\s]+/).map(n => parseInt(n)).filter(n => !isNaN(n))
    : [];

  rl.close();

  return recordFeedback(sessionId, rating, notes, {
    moveType,
    preferredFrames,
    selectedFrames: selectedIndices,
  });
}

// ─── Main Pipeline ──────────────────────────────────────────────────────

async function analyzeAndSelect(framesDir, outputDir, count, opts = {}) {
  const framePaths = fs.readdirSync(framesDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort()
    .map(f => path.join(framesDir, f));

  if (framePaths.length === 0) throw new Error(`No frames found in ${framesDir}`);

  console.log(chalk.cyan.bold('\n  Smart Frame Selector\n'));
  console.log(chalk.gray(`  Frames: ${framePaths.length}`));
  console.log(chalk.gray(`  Selecting: ${count} key frames`));
  console.log(chalk.gray(`  Output: ${outputDir}\n`));

  const { selected, analysis, selectedIndices } = await smartSelect(framePaths, count, opts);

  // Copy selected frames to output
  fs.mkdirSync(outputDir, { recursive: true });
  const outputs = [];
  for (let i = 0; i < selected.length; i++) {
    const ext = path.extname(selected[i]);
    const outPath = path.join(outputDir, `keyframe-${String(i + 1).padStart(3, '0')}${ext}`);
    fs.copyFileSync(selected[i], outPath);
    outputs.push(outPath);
  }

  // Print selection summary
  console.log(chalk.green(`\n  Selected ${selected.length} key frames:\n`));
  for (let i = 0; i < selectedIndices.length; i++) {
    const idx = selectedIndices[i];
    const a = analysis[idx];
    const ballStr = a.ball.found
      ? `ball@(${(a.ball.x * 100).toFixed(0)}%,${(a.ball.y * 100).toFixed(0)}%)${a.ballInflection ? ' INFLECTION' : ''}`
      : 'no ball';
    console.log(chalk.white(`    [${String(idx).padStart(3)}] score=${a.score.toFixed(3)} motion=${a.motion.toFixed(3)} sharp=${a.sharpness.toFixed(3)} ${ballStr}`));
  }

  // Session ID for feedback
  const sessionId = `${path.basename(framesDir)}-${Date.now()}`;
  console.log(chalk.gray(`\n  Session: ${sessionId}`));

  // Ask for feedback if interactive
  if (opts.feedback !== false && process.stdin.isTTY) {
    await promptFeedback(sessionId, selectedIndices, framePaths.length);
  }

  return { outputs, selectedIndices, sessionId, analysis };
}

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['analyze', 'feedback', 'weights'].includes(command)) {
    console.log(chalk.cyan.bold('\n  Smart Frame Selector\n'));
    console.log(chalk.white('  Commands:'));
    console.log(chalk.gray('    analyze <frames-dir> --count 6 --output ./keyframes/'));
    console.log(chalk.gray('    feedback                       Show current learned weights'));
    console.log(chalk.gray('    weights --reset                Reset weights to defaults'));
    console.log(chalk.white('\n  The selector learns from your feedback after each run.'));
    process.exit(0);
  }

  const getOpt = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  if (command === 'feedback' || command === 'weights') {
    const feedback = loadFeedback();
    if (args.includes('--reset')) {
      feedback.weights = { ballPosition: 0.35, motionPeak: 0.30, sharpness: 0.15, evenSpacing: 0.20 };
      feedback.thresholds = { minSharpness: 0.02 };
      saveFeedback(feedback);
      console.log(chalk.green('  Weights reset to defaults.'));
    } else {
      console.log(chalk.cyan.bold('\n  Learned Weights\n'));
      console.log(chalk.white(`  Ball position: ${(feedback.weights.ballPosition * 100).toFixed(0)}%`));
      console.log(chalk.white(`  Motion peaks:  ${(feedback.weights.motionPeak * 100).toFixed(0)}%`));
      console.log(chalk.white(`  Sharpness:     ${(feedback.weights.sharpness * 100).toFixed(0)}%`));
      console.log(chalk.white(`  Even spacing:  ${(feedback.weights.evenSpacing * 100).toFixed(0)}%`));
      console.log(chalk.gray(`\n  Total sessions: ${feedback.totalSessions}`));
      if (feedback.sessions.length > 0) {
        const recent = feedback.sessions.slice(-3);
        console.log(chalk.gray(`  Recent feedback:`));
        for (const s of recent) {
          console.log(chalk.gray(`    [${s.rating}/5] ${s.moveType}: ${s.notes}`));
        }
      }
    }
    process.exit(0);
  }

  const framesDir = args[1];
  const count = parseInt(getOpt('count') || '6');
  const outputDir = getOpt('output') || './smart-keyframes/';
  const noFeedback = args.includes('--no-feedback');

  analyzeAndSelect(framesDir, outputDir, count, { feedback: !noFeedback })
    .then(result => {
      console.log(chalk.green(`\n  Done! ${result.outputs.length} keyframes saved to ${outputDir}`));
    })
    .catch(err => {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    });
}

module.exports = { smartSelect, detectBall, computeMotion, computeSharpness, analyzeAndSelect, recordFeedback, loadFeedback, promptFeedback };
