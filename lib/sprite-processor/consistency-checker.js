/**
 * Consistency Checker — Phase 7: Quality + Ball Standardization
 *
 * Cross-animation validation for a character's sprites.
 * Checks height consistency, ball standardization, color consistency,
 * and baseline alignment across ALL animations.
 *
 * Usage:
 *   const { auditCharacter } = require('./consistency-checker');
 *   const report = await auditCharacter('breezy', '/path/to/assets');
 *   console.log(report.passed, report.overallScore);
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const { evaluateFrame, rgbToHsv } = require('./index');
const { detectBall } = require('../sprite-generator/smart-selector');
const {
  BASELINE_PIXEL_HEIGHT,
  BASELINE_Y,
  DEFAULT_FRAME_SIZE,
} = require('./height-scaler');

// Animation layout — mirrors GRID_LAYOUT from index.js
const GRID_LAYOUT = [
  { name: 'static-dribble',    frames: 6 },
  { name: 'dribble',           frames: 8 },
  { name: 'jumpshot',          frames: 7 },
  { name: 'stepback',          frames: 4 },
  { name: 'crossover',         frames: 4 },
  { name: 'defense-backpedal', frames: 4 },
  { name: 'defense-shuffle',   frames: 2 },
  { name: 'steal',             frames: 3 },
];

// Animations that should contain a basketball
const BALL_ANIMATIONS = new Set([
  'static-dribble',
  'dribble',
  'jumpshot',
  'stepback',
  'crossover',
]);

// ─── Ball Detection for Sprite Frames ───────────────────────────────────

/**
 * Detect a basketball in a processed sprite frame (transparent background).
 *
 * Unlike detectBall in smart-selector.js which works on video frames with
 * backgrounds, this scans raw pixel data for orange/brown hues on a
 * transparent canvas. Only considers pixels with alpha > 10.
 *
 * @param {string} framePath - Path to a processed sprite frame PNG
 * @returns {{ found: boolean, x: number, y: number, width: number, height: number, area: number, diameter: number }}
 *   x,y = centroid of orange pixels; width,height = bounding box; area = pixel count; diameter = avg of bbox dims
 */
async function detectBallInSprite(framePath) {
  const { data, info } = await sharp(framePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sumX = 0, sumY = 0, count = 0;
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      // Skip transparent pixels
      if (a <= 10) continue;

      const { h, s, v } = rgbToHsv(r, g, b);

      // Basketball orange/brown: hue 5-55, saturation > 0.2, value > 0.3
      if (h >= 5 && h <= 55 && s > 0.2 && v > 0.3) {
        sumX += x;
        sumY += y;
        count++;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 3) {
    return { found: false, x: 0, y: 0, width: 0, height: 0, area: 0, diameter: 0 };
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;

  return {
    found: true,
    x: Math.round(sumX / count),
    y: Math.round(sumY / count),
    width: bboxW,
    height: bboxH,
    area: count,
    diameter: (bboxW + bboxH) / 2,
  };
}

// ─── Character Bounds Measurement ───────────────────────────────────────

/**
 * Measure the bounding box of non-transparent content in a frame.
 *
 * @param {string} framePath - Path to a processed sprite frame PNG
 * @returns {{ minX, maxX, minY, maxY, contentWidth, contentHeight, fillHeight, baselineY, centerX }}
 *   fillHeight = fraction of frame height occupied by content (0-1)
 *   baselineY = maxY position (bottom of content)
 *   centerX = horizontal center of content
 */
async function measureCharacterBounds(framePath) {
  const { data, info } = await sharp(framePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  let hasContent = false;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        hasContent = true;
      }
    }
  }

  if (!hasContent) {
    return {
      minX: 0, maxX: 0, minY: 0, maxY: 0,
      contentWidth: 0, contentHeight: 0,
      fillHeight: 0, baselineY: 0, centerX: 0,
    };
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;

  return {
    minX,
    maxX,
    minY,
    maxY,
    contentWidth,
    contentHeight,
    fillHeight: contentHeight / info.height,
    baselineY: maxY,
    centerX: Math.round((minX + maxX) / 2),
  };
}

// ─── Single Animation Consistency ───────────────────────────────────────

/**
 * Helper: compute median of a numeric array.
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Check consistency within a single animation's frames.
 *
 * Measures height, baseline, and ball metrics across all frames and flags
 * inconsistencies.
 *
 * @param {string[]} framePaths - Ordered frame PNG paths for one animation
 * @param {object} opts - { expectBall: boolean }
 * @returns {{ heightVariance, baselineVariance, ballMetrics, issues }}
 */
async function checkAnimationConsistency(framePaths, opts = {}) {
  const expectBall = opts.expectBall || false;

  const measurements = [];
  const ballResults = [];

  // Measure every frame
  for (const fp of framePaths) {
    const bounds = await measureCharacterBounds(fp);
    const ball = await detectBallInSprite(fp);
    measurements.push(bounds);
    ballResults.push(ball);
  }

  const heights = measurements.map(m => m.contentHeight).filter(h => h > 0);
  const baselines = measurements.map(m => m.baselineY).filter(b => b > 0);

  const medianHeight = median(heights);
  const medianBaseline = median(baselines);

  // Height variance: max deviation from median as a fraction
  const heightVariance = heights.length > 0
    ? Math.max(...heights.map(h => Math.abs(h - medianHeight) / Math.max(medianHeight, 1)))
    : 0;

  // Baseline variance: max deviation in pixels
  const baselineVariance = baselines.length > 0
    ? Math.max(...baselines.map(b => Math.abs(b - medianBaseline)))
    : 0;

  // Ball metrics
  const ballFound = ballResults.map(b => b.found);
  const ballSizes = ballResults.filter(b => b.found).map(b => b.diameter);
  const medianBallSize = median(ballSizes);
  const ballSizeVariance = ballSizes.length > 0
    ? Math.max(...ballSizes.map(s => Math.abs(s - medianBallSize) / Math.max(medianBallSize, 1)))
    : 0;

  // Ball position consistency: standard deviation of centroid positions
  const ballPositions = ballResults.filter(b => b.found).map(b => ({ x: b.x, y: b.y }));
  let positionConsistency = 1.0;
  if (ballPositions.length > 1) {
    const meanX = ballPositions.reduce((s, p) => s + p.x, 0) / ballPositions.length;
    const meanY = ballPositions.reduce((s, p) => s + p.y, 0) / ballPositions.length;
    const variance = ballPositions.reduce((s, p) => {
      return s + Math.pow(p.x - meanX, 2) + Math.pow(p.y - meanY, 2);
    }, 0) / ballPositions.length;
    const stdDev = Math.sqrt(variance);
    // Normalize: lower std dev = higher consistency (0-1 scale)
    // A std dev of 0 = perfect consistency (1.0), large values approach 0
    positionConsistency = Math.max(0, 1 - (stdDev / 50));
  }

  const ballMetrics = {
    found: ballFound,
    sizes: ballSizes,
    sizeVariance: ballSizeVariance,
    positionConsistency,
  };

  // Detect issues
  const issues = [];

  // Height inconsistency: frames vary >15% from median height
  if (heightVariance > 0.15 && heights.length > 1) {
    const affectedFrames = [];
    for (let i = 0; i < measurements.length; i++) {
      const h = measurements[i].contentHeight;
      if (h > 0 && Math.abs(h - medianHeight) / Math.max(medianHeight, 1) > 0.15) {
        affectedFrames.push(i);
      }
    }
    issues.push({
      type: 'height_inconsistent',
      severity: 'major',
      message: `Frame heights vary ${(heightVariance * 100).toFixed(1)}% from median (${medianHeight}px). Threshold: 15%`,
      affectedFrames,
    });
  }

  // Baseline drift: baseline Y varies >5px from median
  if (baselineVariance > 5 && baselines.length > 1) {
    const affectedFrames = [];
    for (let i = 0; i < measurements.length; i++) {
      const b = measurements[i].baselineY;
      if (b > 0 && Math.abs(b - medianBaseline) > 5) {
        affectedFrames.push(i);
      }
    }
    issues.push({
      type: 'baseline_drift',
      severity: 'major',
      message: `Baseline Y varies ${baselineVariance.toFixed(1)}px from median (${medianBaseline}px). Threshold: 5px`,
      affectedFrames,
    });
  }

  // Ball size inconsistency: diameter varies >30%
  if (ballSizeVariance > 0.30 && ballSizes.length > 1) {
    const affectedFrames = [];
    for (let i = 0; i < ballResults.length; i++) {
      if (ballResults[i].found) {
        const dev = Math.abs(ballResults[i].diameter - medianBallSize) / Math.max(medianBallSize, 1);
        if (dev > 0.30) {
          affectedFrames.push(i);
        }
      }
    }
    issues.push({
      type: 'ball_size_inconsistent',
      severity: 'minor',
      message: `Ball diameter varies ${(ballSizeVariance * 100).toFixed(1)}% from median (${medianBallSize.toFixed(1)}px). Threshold: 30%`,
      affectedFrames,
    });
  }

  // Ball missing: expected but not found in some frames
  if (expectBall) {
    const missingFrames = [];
    for (let i = 0; i < ballFound.length; i++) {
      if (!ballFound[i]) missingFrames.push(i);
    }
    if (missingFrames.length > 0 && missingFrames.length < ballFound.length) {
      // Only flag if ball is found in SOME frames but missing in others
      issues.push({
        type: 'ball_missing',
        severity: 'minor',
        message: `Ball expected but missing in ${missingFrames.length}/${ballFound.length} frames`,
        affectedFrames: missingFrames,
      });
    }
  }

  return {
    heightVariance,
    baselineVariance,
    ballMetrics,
    issues,
  };
}

// ─── Cross-Animation Character Audit ────────────────────────────────────

/**
 * Full cross-animation quality audit for a character.
 *
 * For each animation that has extracted frames, runs consistency checks.
 * Then checks cross-animation consistency for height and ball size.
 *
 * @param {string} characterName - e.g. "breezy", "99"
 * @param {string} assetsDir - Directory containing {character}-{anim}-frames/ dirs
 * @returns {object} Full quality report
 */
async function auditCharacter(characterName, assetsDir) {
  console.log(`\nAuditing character: ${characterName}`);
  console.log(`Assets directory: ${assetsDir}\n`);

  const animations = {};
  const allHeights = {};        // animName -> median content height
  const allBallSizes = {};      // animName -> median ball diameter (ball anims only)

  for (const { name: animName } of GRID_LAYOUT) {
    const framesDir = path.join(assetsDir, `${characterName}-${animName}-frames`);

    if (!fs.existsSync(framesDir)) {
      console.log(`  [SKIP] ${animName}: no frames directory`);
      continue;
    }

    // Gather frame paths
    const framePaths = fs.readdirSync(framesDir)
      .filter(f => /\.png$/i.test(f))
      .sort()
      .map(f => path.join(framesDir, f));

    if (framePaths.length === 0) {
      console.log(`  [SKIP] ${animName}: empty frames directory`);
      continue;
    }

    const expectBall = BALL_ANIMATIONS.has(animName);
    console.log(`  [CHECK] ${animName}: ${framePaths.length} frames${expectBall ? ' (ball expected)' : ''}`);

    const result = await checkAnimationConsistency(framePaths, { expectBall });

    // Compute per-animation score
    let animScore = 100;
    for (const issue of result.issues) {
      if (issue.severity === 'major') animScore -= 10;
      if (issue.severity === 'minor') animScore -= 5;
    }
    animScore = Math.max(0, animScore);

    animations[animName] = {
      score: animScore,
      heightVariance: result.heightVariance,
      baselineVariance: result.baselineVariance,
      ballMetrics: result.ballMetrics,
      issues: result.issues,
      frameCount: framePaths.length,
    };

    // Collect cross-animation data
    // Measure median height for this animation
    const heights = [];
    for (const fp of framePaths) {
      const bounds = await measureCharacterBounds(fp);
      if (bounds.contentHeight > 0) heights.push(bounds.contentHeight);
    }
    if (heights.length > 0) {
      allHeights[animName] = median(heights);
    }

    // Collect ball sizes for ball animations
    if (expectBall && result.ballMetrics.sizes.length > 0) {
      allBallSizes[animName] = median(result.ballMetrics.sizes);
    }
  }

  // ─── Cross-Animation Checks ─────────────────────────────────────────

  const crossAnimationIssues = [];

  // Cross-animation height consistency: within 10% of overall median
  const heightValues = Object.values(allHeights);
  const overallMedianHeight = median(heightValues);

  const heightPerAnimation = {};
  for (const [animName, medH] of Object.entries(allHeights)) {
    heightPerAnimation[animName] = medH;
  }

  if (heightValues.length > 1 && overallMedianHeight > 0) {
    const maxHeightDev = Math.max(
      ...heightValues.map(h => Math.abs(h - overallMedianHeight) / overallMedianHeight)
    );

    if (maxHeightDev > 0.10) {
      const affectedAnimations = [];
      for (const [animName, medH] of Object.entries(allHeights)) {
        const dev = Math.abs(medH - overallMedianHeight) / overallMedianHeight;
        if (dev > 0.10) affectedAnimations.push(animName);
      }
      crossAnimationIssues.push({
        type: 'cross_anim_height_inconsistent',
        severity: 'major',
        message: `Character height varies ${(maxHeightDev * 100).toFixed(1)}% across animations (median: ${overallMedianHeight.toFixed(0)}px). Threshold: 10%`,
        affectedAnimations,
      });
    }
  }

  // Cross-animation ball size consistency
  const ballSizeValues = Object.values(allBallSizes);
  const overallMedianBallSize = median(ballSizeValues);

  const ballPerAnimation = {};
  for (const [animName, medS] of Object.entries(allBallSizes)) {
    ballPerAnimation[animName] = medS;
  }

  if (ballSizeValues.length > 1 && overallMedianBallSize > 0) {
    const maxBallDev = Math.max(
      ...ballSizeValues.map(s => Math.abs(s - overallMedianBallSize) / overallMedianBallSize)
    );

    if (maxBallDev > 0.30) {
      const affectedAnimations = [];
      for (const [animName, medS] of Object.entries(allBallSizes)) {
        const dev = Math.abs(medS - overallMedianBallSize) / overallMedianBallSize;
        if (dev > 0.30) affectedAnimations.push(animName);
      }
      crossAnimationIssues.push({
        type: 'cross_anim_ball_size_inconsistent',
        severity: 'major',
        message: `Ball size varies ${(maxBallDev * 100).toFixed(1)}% across animations (median: ${overallMedianBallSize.toFixed(1)}px). Threshold: 30%`,
        affectedAnimations,
      });
    }
  }

  // ─── Overall Scoring ────────────────────────────────────────────────

  let overallScore = 100;

  // Deduct for cross-animation issues
  for (const issue of crossAnimationIssues) {
    if (issue.type === 'cross_anim_height_inconsistent') {
      overallScore -= 20;
    } else if (issue.type === 'cross_anim_ball_size_inconsistent') {
      overallScore -= 15;
    }
  }

  // Deduct for per-animation issues
  for (const [animName, animData] of Object.entries(animations)) {
    for (const issue of animData.issues) {
      if (issue.severity === 'major') overallScore -= 10;
      if (issue.severity === 'minor') overallScore -= 5;
    }
  }

  overallScore = Math.max(0, overallScore);

  const report = {
    character: characterName,
    overallScore,
    animations,
    crossAnimationIssues,
    heightConsistency: {
      median: overallMedianHeight,
      variance: heightValues.length > 1
        ? Math.max(...heightValues.map(h => Math.abs(h - overallMedianHeight) / Math.max(overallMedianHeight, 1)))
        : 0,
      perAnimation: heightPerAnimation,
    },
    ballConsistency: {
      medianSize: overallMedianBallSize,
      variance: ballSizeValues.length > 1
        ? Math.max(...ballSizeValues.map(s => Math.abs(s - overallMedianBallSize) / Math.max(overallMedianBallSize, 1)))
        : 0,
      perAnimation: ballPerAnimation,
    },
    passed: overallScore >= 70,
  };

  // Print summary
  console.log(`\n  ─── Audit Report: ${characterName} ───`);
  console.log(`  Overall Score: ${overallScore}/100 ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  Height Consistency: median ${overallMedianHeight.toFixed(0)}px, variance ${(report.heightConsistency.variance * 100).toFixed(1)}%`);
  if (overallMedianBallSize > 0) {
    console.log(`  Ball Consistency:   median ${overallMedianBallSize.toFixed(1)}px, variance ${(report.ballConsistency.variance * 100).toFixed(1)}%`);
  }

  console.log(`\n  Per-Animation:`);
  for (const [animName, animData] of Object.entries(animations)) {
    const issueStr = animData.issues.length > 0
      ? ` | ${animData.issues.length} issue(s)`
      : '';
    console.log(`    ${animName}: ${animData.score}/100 (${animData.frameCount} frames)${issueStr}`);
  }

  if (crossAnimationIssues.length > 0) {
    console.log(`\n  Cross-Animation Issues:`);
    for (const issue of crossAnimationIssues) {
      console.log(`    [${issue.severity.toUpperCase()}] ${issue.message}`);
      console.log(`      Affected: ${issue.affectedAnimations.join(', ')}`);
    }
  }

  console.log('');

  return report;
}

// ─── Exports ────────────────────────────────────────────────────────────

module.exports = {
  detectBallInSprite,
  measureCharacterBounds,
  checkAnimationConsistency,
  auditCharacter,
};
