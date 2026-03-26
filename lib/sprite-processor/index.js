#!/usr/bin/env node
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SOUL_JAM_ASSETS = path.resolve(__dirname, '../../../soul-jam/public/assets/images');
const DEFAULT_FRAME_SIZE = 180;
const DEFAULT_BG_COLOR = { r: 0, g: 255, b: 0 }; // #00FF00 green (Nano Banana standard)

// Animation layout for grid sheet assembly
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

/**
 * Detect frames in a horizontal sprite strip by dividing width by frame height.
 * Returns { width, height, frameCount, frameWidth, frameHeight }
 */
async function detectFrames(imagePath, opts = {}) {
  const meta = await sharp(imagePath).metadata();
  const frameHeight = opts.frameHeight || meta.height;
  const frameWidth = opts.frameWidth || frameHeight; // assume square if not specified
  const cols = Math.round(meta.width / frameWidth);
  const rows = Math.round(meta.height / frameHeight);
  return {
    width: meta.width,
    height: meta.height,
    frameWidth,
    frameHeight,
    cols,
    rows,
    frameCount: cols * rows,
  };
}

/**
 * Cut a sprite sheet (strip or grid) into individual frame PNGs.
 */
async function cutFrames(imagePath, outputDir, opts = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const info = await detectFrames(imagePath, opts);
  const frames = [];

  for (let row = 0; row < info.rows; row++) {
    for (let col = 0; col < info.cols; col++) {
      const idx = row * info.cols + col;
      const outPath = path.join(outputDir, `frame-${String(idx).padStart(3, '0')}.png`);
      await sharp(imagePath)
        .extract({
          left: col * info.frameWidth,
          top: row * info.frameHeight,
          width: info.frameWidth,
          height: info.frameHeight,
        })
        .toFile(outPath);
      frames.push(outPath);
    }
  }

  console.log(`Cut ${frames.length} frames (${info.frameWidth}x${info.frameHeight}) from ${path.basename(imagePath)}`);
  return { frames, info };
}

/**
 * Nearest-neighbor upscale — preserves pixel art crispness.
 * Green background fill to match the chroma key pipeline.
 *
 * @param {string} imagePath - Input image path
 * @param {string} outputPath - Output path for upscaled image
 * @param {object} opts - { width: 512, height: 512 }
 */
async function upscaleNN(imagePath, outputPath, opts = {}) {
  const targetW = opts.width || 512;
  const targetH = opts.height || 512;

  await sharp(imagePath)
    .resize(targetW, targetH, {
      kernel: sharp.kernel.nearest,
      fit: 'contain',
      background: { r: 0, g: 255, b: 0, alpha: 255 }, // green BG matches chroma key
    })
    .png()
    .toFile(outputPath);

  return outputPath;
}

// ─── HSV-based green chroma key ──────────────────────────────────────────

/**
 * Convert RGB (0-255) to HSV (h: 0-360, s: 0-1, v: 0-1).
 */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  const v = max;

  return { h, s, v };
}

/**
 * Remove green background using HSV-based chroma keying.
 *
 * Removes pixels where:
 *   - Hue is in the green range [hueMin, hueMax] (default: 80-160)
 *   - Saturation > satMin (default: 0.25)
 *   - Value > valMin (default: 0.25)
 *
 * Also does edge feathering for semi-transparent pixels near the boundary.
 */
async function removeBackground(imagePath, outputPath, opts = {}) {
  const hueMin = opts.hueMin ?? 80;
  const hueMax = opts.hueMax ?? 160;
  const satMin = opts.satMin ?? 0.25;
  const valMin = opts.valMin ?? 0.25;

  // Legacy RGB tolerance mode (backward compat)
  const useLegacy = opts.useLegacyRgb === true;

  const image = sharp(imagePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  const output = Buffer.alloc(data.length);
  data.copy(output);

  let removedCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];

    if (useLegacy) {
      // Legacy: simple RGB tolerance
      const bgColor = opts.bgColor || DEFAULT_BG_COLOR;
      const tolerance = opts.tolerance || 40;
      const dr = Math.abs(r - bgColor.r);
      const dg = Math.abs(g - bgColor.g);
      const db = Math.abs(b - bgColor.b);
      if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
        output[i + 3] = 0;
        removedCount++;
      }
    } else {
      // HSV chroma key (default)
      const { h, s, v } = rgbToHsv(r, g, b);

      if (h >= hueMin && h <= hueMax && s > satMin && v > valMin) {
        // Core green — fully transparent
        output[i + 3] = 0;
        removedCount++;
      } else if (h >= (hueMin - 15) && h <= (hueMax + 15) && s > (satMin * 0.6) && v > (valMin * 0.6)) {
        // Edge zone — partial transparency for smoother edges
        const hDist = Math.min(
          Math.abs(h - hueMin) / 15,
          Math.abs(h - hueMax) / 15
        );
        const sDist = s > satMin ? 0 : (satMin - s) / (satMin * 0.4);
        const edgeFactor = Math.max(hDist, sDist);
        const newAlpha = Math.round(edgeFactor * data[i + 3]);
        if (newAlpha < data[i + 3]) {
          output[i + 3] = newAlpha;
          removedCount++;
        }
      }
    }
  }

  await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outputPath || imagePath);

  return { outputPath: outputPath || imagePath, removedPixels: removedCount };
}

/**
 * Resize a frame to target dimensions, maintaining aspect ratio and centering.
 */
async function resizeFrame(imagePath, outputPath, opts = {}) {
  const targetW = opts.width || DEFAULT_FRAME_SIZE;
  const targetH = opts.height || DEFAULT_FRAME_SIZE;

  await sharp(imagePath)
    .resize(targetW, targetH, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Assemble individual frame PNGs into a horizontal sprite strip.
 */
async function buildStrip(framePaths, outputPath, opts = {}) {
  const frameW = opts.frameWidth || DEFAULT_FRAME_SIZE;
  const frameH = opts.frameHeight || DEFAULT_FRAME_SIZE;
  const count = framePaths.length;

  const canvas = sharp({
    create: {
      width: frameW * count,
      height: frameH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  const composites = await Promise.all(
    framePaths.map(async (fp, i) => {
      const buf = await sharp(fp)
        .resize(frameW, frameH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      return { input: buf, left: i * frameW, top: 0 };
    })
  );

  await canvas.composite(composites).png().toFile(outputPath);
  console.log(`Built strip: ${count} frames x ${frameW}x${frameH} -> ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Full pipeline: raw generated image -> cut -> remove bg -> resize -> Soul Jam-ready strip.
 */
async function processSprite(inputImage, outputName, opts = {}) {
  const targetSize = opts.targetSize || DEFAULT_FRAME_SIZE;
  const outputDir = opts.outputDir || SOUL_JAM_ASSETS;
  const tempDir = path.join(__dirname, '.tmp', outputName);
  fs.mkdirSync(tempDir, { recursive: true });

  console.log(`\nProcessing: ${path.basename(inputImage)} -> ${outputName}`);
  console.log(`Target: ${targetSize}x${targetSize} frames, output to ${outputDir}\n`);

  // Step 1: Detect and cut frames
  const cutOpts = {};
  if (opts.frameCount) {
    const meta = await sharp(inputImage).metadata();
    cutOpts.frameWidth = Math.round(meta.width / opts.frameCount);
    cutOpts.frameHeight = meta.height;
  }
  if (opts.frameWidth) cutOpts.frameWidth = opts.frameWidth;
  if (opts.frameHeight) cutOpts.frameHeight = opts.frameHeight;

  const { frames } = await cutFrames(inputImage, tempDir, cutOpts);

  // Step 2: Remove background from each frame (HSV green chroma key by default)
  const cleanFrames = [];
  for (let i = 0; i < frames.length; i++) {
    const cleanPath = path.join(tempDir, `clean-${String(i).padStart(3, '0')}.png`);
    await removeBackground(frames[i], cleanPath, {
      // HSV params for green (#00FF00) background
      hueMin: opts.hueMin ?? 80,
      hueMax: opts.hueMax ?? 160,
      satMin: opts.satMin ?? 0.25,
      valMin: opts.valMin ?? 0.25,
      // Legacy fallback
      useLegacyRgb: opts.useLegacyRgb,
      bgColor: opts.bgColor,
      tolerance: opts.tolerance,
    });
    cleanFrames.push(cleanPath);
    process.stdout.write(`  BG removal: ${i + 1}/${frames.length}\r`);
  }
  console.log(`  BG removal: ${frames.length}/${frames.length} done`);

  // Step 3: Resize frames to target
  const resizedFrames = [];
  for (let i = 0; i < cleanFrames.length; i++) {
    const resizedPath = path.join(tempDir, `resized-${String(i).padStart(3, '0')}.png`);
    await resizeFrame(cleanFrames[i], resizedPath, { width: targetSize, height: targetSize });
    resizedFrames.push(resizedPath);
  }
  console.log(`  Resized ${resizedFrames.length} frames to ${targetSize}x${targetSize}`);

  // Step 4: Build horizontal strip
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${outputName}.png`);
  await buildStrip(resizedFrames, outputPath, { frameWidth: targetSize, frameHeight: targetSize });

  // Step 5: Also save individual frames for inspection
  const framesDir = path.join(outputDir, `${outputName}-frames`);
  fs.mkdirSync(framesDir, { recursive: true });
  for (let i = 0; i < resizedFrames.length; i++) {
    fs.copyFileSync(resizedFrames[i], path.join(framesDir, `frame-${i}.png`));
  }
  console.log(`  Individual frames saved to ${outputName}-frames/`);

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n  Done! Output: ${outputPath}`);
  console.log(`  Strip: ${resizedFrames.length} x ${targetSize}x${targetSize} = ${resizedFrames.length * targetSize}x${targetSize}px`);

  return {
    outputPath,
    framesDir,
    frameCount: resizedFrames.length,
    frameSize: targetSize,
  };
}

// ─── Crop to Content ────────────────────────────────────────────────────

/**
 * Scan raw pixel alpha to find bounding box of non-transparent content,
 * crop to that box + padding, then resize to target dimensions.
 * Eliminates letterboxing from `fit: contain` on full images.
 */
async function cropToContent(imagePath, outputPath, opts = {}) {
  const targetW = opts.width || DEFAULT_FRAME_SIZE;
  const targetH = opts.height || DEFAULT_FRAME_SIZE;
  const padding = opts.padding || 4;

  const image = sharp(imagePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  let minX = info.width, minY = info.height, maxX = 0, maxY = 0;
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
    // No content found — just resize
    await sharp(imagePath)
      .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);
    return outputPath;
  }

  // Add padding
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(info.width - 1, maxX + padding);
  maxY = Math.min(info.height - 1, maxY + padding);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  await sharp(imagePath)
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Process a single frame image (NOT a strip).
 * Pipeline: removeBackground → cropToContent (or scaleToHeight if targetPixelHeight given) → done.
 * No cutFrames — input IS a single frame.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} opts - { width, height, targetPixelHeight, baselineY }
 */
async function processSingleFrame(inputPath, outputPath, opts = {}) {
  const targetW = opts.width || DEFAULT_FRAME_SIZE;
  const targetH = opts.height || DEFAULT_FRAME_SIZE;

  // If height-aware processing requested, use the height scaler
  if (opts.targetPixelHeight) {
    try {
      const { processFrameWithHeight } = require('./height-scaler');
      return await processFrameWithHeight(inputPath, outputPath, {
        targetPixelHeight: opts.targetPixelHeight,
        baselineY: opts.baselineY || 170,
        width: targetW,
        height: targetH,
        hueMin: opts.hueMin,
        hueMax: opts.hueMax,
        satMin: opts.satMin,
        valMin: opts.valMin,
      });
    } catch (err) {
      console.log(`  Height scaler unavailable, falling back to standard: ${err.message}`);
    }
  }

  // Standard pipeline: BG removal → crop to content
  const cleanPath = outputPath.replace('.png', '-clean.png');

  // Step 1: Remove green background
  await removeBackground(inputPath, cleanPath, {
    hueMin: opts.hueMin ?? 80,
    hueMax: opts.hueMax ?? 160,
    satMin: opts.satMin ?? 0.25,
    valMin: opts.valMin ?? 0.25,
  });

  // Step 2: Crop to content and resize
  await cropToContent(cleanPath, outputPath, { width: targetW, height: targetH });

  // Clean up temp
  try { fs.unlinkSync(cleanPath); } catch {}

  return outputPath;
}

/**
 * Measure content height ratio in a processed frame.
 * Returns the fraction of frame height occupied by non-transparent content.
 */
async function measureContentHeight(framePath) {
  const image = sharp(framePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  let minY = info.height, maxY = 0;
  let hasContent = false;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 10) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        hasContent = true;
      }
    }
  }

  if (!hasContent) return 0;
  return (maxY - minY + 1) / info.height;
}

/**
 * Normalize frame sizes across all processed frames.
 * Measures content height in each frame, finds median,
 * and re-crops frames that deviate >tolerance from median.
 */
async function normalizeFrameSizes(framePaths, opts = {}) {
  const targetW = opts.targetWidth || DEFAULT_FRAME_SIZE;
  const targetH = opts.targetHeight || DEFAULT_FRAME_SIZE;
  const tolerance = opts.tolerance || 0.15;

  // Measure all frames
  const ratios = await Promise.all(framePaths.map(measureContentHeight));

  // Find median
  const sorted = [...ratios].filter(r => r > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return framePaths;
  const median = sorted[Math.floor(sorted.length / 2)];

  let adjustedCount = 0;
  for (let i = 0; i < framePaths.length; i++) {
    if (ratios[i] === 0) continue;
    const deviation = Math.abs(ratios[i] - median) / median;
    if (deviation > tolerance) {
      // Re-crop this frame to match median scale
      // Scale factor: if current is 20% taller than median, shrink by that factor
      const scale = median / ratios[i];
      const meta = await sharp(framePaths[i]).metadata();

      // Resize proportionally then re-fit to target
      const scaledW = Math.round(meta.width * scale);
      const scaledH = Math.round(meta.height * scale);

      await sharp(framePaths[i])
        .resize(scaledW, scaledH, { kernel: sharp.kernel.nearest })
        .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(framePaths[i] + '.tmp.png');

      fs.renameSync(framePaths[i] + '.tmp.png', framePaths[i]);
      adjustedCount++;
    }
  }

  if (adjustedCount > 0) {
    console.log(`  Normalized ${adjustedCount} frame(s) to median height ratio ${(median * 100).toFixed(0)}%`);
  }

  return framePaths;
}

// ─── Quality Evaluator ──────────────────────────────────────────────────

/**
 * Quality thresholds derived from analyzing known-good Breezy sprites:
 * - Breezy fill height: 57-63% (character is ~60% of frame height)
 * - Breezy coverage: 8-11% of total pixels
 * - Breezy frame variance: ±3% across frames
 */
const QUALITY_THRESHOLDS = {
  fillMin: 0.40,
  fillMax: 0.92,
  fillIdeal: 0.62,
  coverageMin: 0.05,
  coverageMax: 0.45,
  greenMaxPct: 0.5,
  sizeVarianceMax: 0.18,
  edgeContactMax: 0.10,
};

async function evaluateFrame(framePath) {
  const { data, info } = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  let contentPixels = 0, greenPixels = 0;
  let topEdge = 0, bottomEdge = 0, leftEdge = 0, rightEdge = 0;
  const total = info.width * info.height;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      if (a > 10) {
        contentPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (g > 200 && r < 100 && b < 100) greenPixels++;
        if (y <= 1) topEdge++;
        if (y >= info.height - 2) bottomEdge++;
        if (x <= 1) leftEdge++;
        if (x >= info.width - 2) rightEdge++;
      }
    }
  }

  const has = contentPixels > 0;
  const contentH = has ? maxY - minY + 1 : 0;
  const contentW = has ? maxX - minX + 1 : 0;
  const fill = contentH / info.height;
  const coverage = contentPixels / total;
  const greenPct = has ? greenPixels / contentPixels : 0;
  const edge = Math.max(topEdge / info.width, bottomEdge / info.width, leftEdge / info.height, rightEdge / info.height);

  const metrics = {
    contentW, contentH,
    fillHeight: +(fill * 100).toFixed(1),
    coverage: +(coverage * 100).toFixed(1),
    greenPct: +(greenPct * 100).toFixed(2),
    edgeContact: +(edge * 100).toFixed(1),
  };

  const issues = [];
  let score = 100;

  if (!has || coverage < QUALITY_THRESHOLDS.coverageMin) {
    issues.push({ type: 'empty', severity: 'critical', msg: `Empty frame (${metrics.coverage}% coverage)` });
    score -= 50;
  }
  if (fill > QUALITY_THRESHOLDS.fillMax) {
    const sev = fill > 0.95 ? 'critical' : 'major';
    issues.push({ type: 'too_large', severity: sev, msg: `Too large (${metrics.fillHeight}% fill)` });
    score -= fill > 0.95 ? 35 : 25;
  }
  if (fill < QUALITY_THRESHOLDS.fillMin && has) {
    issues.push({ type: 'too_small', severity: 'major', msg: `Too small (${metrics.fillHeight}% fill)` });
    score -= 20;
  }
  if (greenPct > QUALITY_THRESHOLDS.greenMaxPct / 100) {
    issues.push({ type: 'green_remnant', severity: 'minor', msg: `Green remnants (${metrics.greenPct}%)` });
    score -= 10;
  }
  if (coverage > QUALITY_THRESHOLDS.coverageMax) {
    issues.push({ type: 'blob', severity: 'major', msg: `Blob (${metrics.coverage}% coverage)` });
    score -= 15;
  }
  if (edge > QUALITY_THRESHOLDS.edgeContactMax) {
    issues.push({ type: 'edge_bleed', severity: 'minor', msg: `Edge bleed (${metrics.edgeContact}%)` });
    score -= 10;
  }

  if (Math.abs(fill - QUALITY_THRESHOLDS.fillIdeal) < 0.10) score = Math.min(100, score + 5);

  return { score: Math.max(0, score), issues, metrics };
}

async function evaluateStrip(framePaths) {
  const frameResults = await Promise.all(framePaths.map(evaluateFrame));

  const fills = frameResults.map(r => r.metrics.fillHeight).filter(f => f > 0);
  const sorted = [...fills].sort((a, b) => a - b);
  const medianFill = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  let consistencyScore = 100;
  const consistencyIssues = [];

  if (fills.length > 1) {
    const maxDev = Math.max(...fills.map(f => Math.abs(f - medianFill) / Math.max(medianFill, 1)));
    if (maxDev > QUALITY_THRESHOLDS.sizeVarianceMax) {
      consistencyIssues.push({
        type: 'size_inconsistent', severity: 'major',
        msg: `Sizes vary ${(maxDev * 100).toFixed(0)}% (max ${(QUALITY_THRESHOLDS.sizeVarianceMax * 100)}%)`,
        maxDeviation: +(maxDev * 100).toFixed(1),
      });
      consistencyScore -= Math.min(40, Math.round(maxDev * 100));
    }
  }

  const avgFrame = frameResults.reduce((s, r) => s + r.score, 0) / Math.max(frameResults.length, 1);
  const overall = Math.round(avgFrame * 0.6 + consistencyScore * 0.4);

  // Aggregate unique issues
  const seen = new Set();
  const aggregated = [];
  for (const fr of frameResults) {
    for (const issue of fr.issues) {
      if (!seen.has(issue.type)) {
        seen.add(issue.type);
        const affected = frameResults.map((r, i) => r.issues.some(is => is.type === issue.type) ? i : -1).filter(i => i >= 0);
        aggregated.push({ ...issue, affectedFrames: affected });
      }
    }
  }

  // Generate fixes
  const fixes = [];
  for (const issue of [...aggregated, ...consistencyIssues]) {
    switch (issue.type) {
      case 'too_large':
        fixes.push({ section: 'sizeAnchoring', action: 'append', text: '\n- Character must NOT fill the entire frame — target ~60-65% of frame height with padding on all sides' });
        fixes.push({ section: 'outputStyle', action: 'append', text: '\n- Leave clear empty space above the head and below the feet' });
        break;
      case 'too_small':
        fixes.push({ section: 'sizeAnchoring', action: 'append', text: '\n- Character is TOO SMALL — scale up to fill ~60-65% of frame height' });
        break;
      case 'green_remnant':
        fixes.push({ section: 'outputStyle', action: 'append', text: '\n- CRITICAL: absolutely NO green (#00FF00) anywhere on the character body, clothes, or skin' });
        break;
      case 'size_inconsistent':
        fixes.push({ section: 'sizeAnchoring', action: 'append', text: '\n- CRITICAL: character height must be IDENTICAL in every single frame — lock proportions' });
        break;
      case 'empty':
        fixes.push({ section: 'poseReplication', action: 'append', text: '\n- Character MUST be clearly visible, fully rendered, and recognizable in every frame' });
        break;
      case 'edge_bleed':
        fixes.push({ section: 'outputStyle', action: 'append', text: '\n- Keep character centered with clear padding from all frame edges' });
        break;
    }
  }

  return {
    passed: overall >= 70 && !aggregated.some(i => i.severity === 'critical'),
    overallScore: overall,
    avgFrameScore: Math.round(avgFrame),
    consistencyScore: Math.round(consistencyScore),
    medianFill: +medianFill.toFixed(1),
    frameResults,
    issues: aggregated,
    consistencyIssues,
    fixes,
  };
}

function applyFixes(sections, fixes) {
  const modified = JSON.parse(JSON.stringify(sections));
  for (const fix of fixes) {
    const sec = modified[fix.section];
    if (!sec) continue;
    if (!sec.text.includes(fix.text.trim().substring(0, 40))) {
      sec.text += fix.text;
    }
    sec.enabled = true;
  }
  return modified;
}

// ─── Grid Sheet Assembler ───────────────────────────────────────────────

/**
 * Build a grid sprite sheet from individual animation strips.
 *
 * Takes all animation strips for a character and composites into a single
 * sprite grid PNG with one row per animation.
 *
 * Layout (rows):
 *   0: static-dribble    (6 x 180)
 *   1: dribble            (8 x 180) <- widest
 *   2: jumpshot           (7 x 180)
 *   3: stepback           (4 x 180)
 *   4: crossover          (4 x 180)
 *   5: defense-backpedal  (4 x 180)
 *   6: defense-shuffle    (2 x 180)
 *   7: steal              (3 x 180)
 *
 * @param {string} characterName - Character name (e.g., "99", "breezy")
 * @param {object} opts - { frameSize, assetsDir, outputDir }
 * @returns {{ outputPath, manifestPath, width, height, rows }}
 */
async function buildGrid(characterName, opts = {}) {
  const frameSize = opts.frameSize || DEFAULT_FRAME_SIZE;
  const assetsDir = opts.assetsDir || SOUL_JAM_ASSETS;
  const outputDir = opts.outputDir || assetsDir;

  // Find max width (most frames in any row)
  const maxFrames = Math.max(...GRID_LAYOUT.map(r => r.frames));
  const gridWidth = maxFrames * frameSize;
  const gridHeight = GRID_LAYOUT.length * frameSize;

  console.log(`\nBuilding grid sheet for ${characterName}`);
  console.log(`  Grid: ${maxFrames} cols x ${GRID_LAYOUT.length} rows = ${gridWidth}x${gridHeight}px`);

  const composites = [];
  const manifest = {
    character: characterName,
    frameSize,
    width: gridWidth,
    height: gridHeight,
    animations: {},
  };

  let missingCount = 0;

  for (let row = 0; row < GRID_LAYOUT.length; row++) {
    const { name, frames } = GRID_LAYOUT[row];
    const stripPath = path.join(assetsDir, `${characterName}-${name}.png`);

    manifest.animations[name] = {
      row,
      frames,
      y: row * frameSize,
      width: frames * frameSize,
    };

    if (!fs.existsSync(stripPath)) {
      console.log(`  [${row}] ${name}: MISSING (${stripPath})`);
      missingCount++;
      continue;
    }

    // Read the strip and composite each frame into the grid
    const stripMeta = await sharp(stripPath).metadata();
    const stripFrameW = Math.round(stripMeta.width / frames);

    for (let col = 0; col < frames; col++) {
      const frameBuf = await sharp(stripPath)
        .extract({
          left: col * stripFrameW,
          top: 0,
          width: stripFrameW,
          height: stripMeta.height,
        })
        .resize(frameSize, frameSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();

      composites.push({
        input: frameBuf,
        left: col * frameSize,
        top: row * frameSize,
      });
    }

    console.log(`  [${row}] ${name}: ${frames} frames`);
  }

  if (missingCount > 0) {
    console.log(`\n  WARNING: ${missingCount} animation(s) missing. Grid will have empty rows.`);
  }

  // Create the grid
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${characterName}-spritesheet.png`);
  const manifestPath = path.join(outputDir, `${characterName}-spritesheet.json`);

  await sharp({
    create: {
      width: gridWidth,
      height: gridHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  // Save manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n  Grid sheet: ${outputPath}`);
  console.log(`  Manifest:   ${manifestPath}`);
  console.log(`  Size: ${gridWidth}x${gridHeight}px (${(fs.statSync(outputPath).size / 1024).toFixed(1)}KB)`);

  return {
    outputPath,
    manifestPath,
    width: gridWidth,
    height: gridHeight,
    rows: GRID_LAYOUT.length,
    missingAnimations: missingCount,
  };
}

module.exports = {
  detectFrames,
  cutFrames,
  removeBackground,
  resizeFrame,
  upscaleNN,
  buildStrip,
  processSprite,
  buildGrid,
  cropToContent,
  processSingleFrame,
  normalizeFrameSizes,
  evaluateFrame,
  evaluateStrip,
  applyFixes,
  QUALITY_THRESHOLDS,
  rgbToHsv,
  SOUL_JAM_ASSETS,
  DEFAULT_FRAME_SIZE,
  DEFAULT_BG_COLOR,
  GRID_LAYOUT,
};
