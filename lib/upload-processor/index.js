/**
 * Upload Processor — auto-processes headshot and bodyshot uploads
 *
 * For each source image:
 *   1. Detect background color from corner sampling
 *   2. Find bounding box of non-background subject pixels
 *   3. Add type-appropriate padding
 *   4. Crop and normalize to output dimensions
 *   5. Save processed PNG + metadata JSON
 *
 * All transforms are recorded in metadata so manual adjustments
 * can be applied via reprocess() without touching the original.
 */

'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Output dimensions per source type
const OUTPUT_DIMS = {
  headshot: { width: 512, height: 512 },
  bodyshot: { width: 384, height: 512 },
  clothing: { width: 512, height: 512 },
};

// Padding as fraction of detected subject size
const PADDING_FRAC = {
  headshot: 0.40,  // loose — capture full head + neck + shoulder hint
  bodyshot: 0.12,  // tight — preserve full body proportion
  clothing: 0.20,
};

// BG detection: color distance threshold
// Pixels within this Euclidean distance of the detected BG color are treated as background
const BG_THRESHOLD = 35;

// Minimum subject pixels before falling back to full image
const MIN_SUBJECT_PX = 200;

// ─── Color math ─────────────────────────────────────────────────────────────

function colorDist(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Sample corners of the image to estimate background color.
 * Returns [r, g, b] average.
 */
function sampleBackgroundColor(data, width, height, channels) {
  const sampleRadius = Math.max(2, Math.floor(Math.min(width, height) * 0.04));
  const samples = [];

  for (let dy = 0; dy < sampleRadius; dy++) {
    for (let dx = 0; dx < sampleRadius; dx++) {
      const corners = [
        [dx, dy],
        [width - 1 - dx, dy],
        [dx, height - 1 - dy],
        [width - 1 - dx, height - 1 - dy],
      ];
      for (const [cx, cy] of corners) {
        const idx = (cy * width + cx) * channels;
        samples.push([data[idx], data[idx + 1], data[idx + 2]]);
      }
    }
  }

  const sum = samples.reduce((acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b], [0, 0, 0]);
  return sum.map(v => Math.round(v / samples.length));
}

// ─── Bounds detection ────────────────────────────────────────────────────────

/**
 * Find the bounding box of non-background pixels.
 * Returns { bounds, bgColor, subjectPixels, fallback }.
 */
async function detectSubjectBounds(imagePath, threshold) {
  threshold = threshold || BG_THRESHOLD;

  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const channels = 4; // ensureAlpha guarantees RGBA

  const [bgR, bgG, bgB] = sampleBackgroundColor(data, width, height, channels);

  let minX = width, maxX = 0, minY = height, maxY = 0;
  let subjectPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const a = data[idx + 3];
      if (a < 10) continue; // pre-existing transparency

      const dist = colorDist(data[idx], data[idx + 1], data[idx + 2], bgR, bgG, bgB);
      if (dist > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        subjectPixels++;
      }
    }
  }

  const fallback = subjectPixels < MIN_SUBJECT_PX || minX >= maxX || minY >= maxY;

  return {
    imageSize: { width, height },
    bounds: fallback
      ? { left: 0, top: 0, right: width - 1, bottom: height - 1 }
      : { left: minX, top: minY, right: maxX, bottom: maxY },
    bgColor: { r: bgR, g: bgG, b: bgB },
    subjectPixels,
    fallback,
  };
}

// ─── Crop computation ────────────────────────────────────────────────────────

/**
 * Compute the final crop rectangle from detected bounds + padding + manual adjustments.
 * Manual adjustments are pixel offsets: positive values expand the crop outward.
 * Returns { left, top, width, height } clamped to image size.
 */
function computeCrop(detectedBounds, imageSize, paddingFrac, adjustments) {
  adjustments = adjustments || {};

  const subjW = detectedBounds.right - detectedBounds.left;
  const subjH = detectedBounds.bottom - detectedBounds.top;

  const padX = Math.round(subjW * paddingFrac);
  const padY = Math.round(subjH * paddingFrac);

  // Base crop from padding
  let left = detectedBounds.left - padX;
  let top = detectedBounds.top - padY;
  let right = detectedBounds.right + padX;
  let bottom = detectedBounds.bottom + padY;

  // Apply manual trim adjustments (positive = expand outward from auto bounds)
  left -= (adjustments.left_expand || 0);
  top -= (adjustments.top_expand || 0);
  right += (adjustments.right_expand || 0);
  bottom += (adjustments.bottom_expand || 0);

  // Apply trim (positive = shrink inward)
  left += (adjustments.left_trim || 0);
  top += (adjustments.top_trim || 0);
  right -= (adjustments.right_trim || 0);
  bottom -= (adjustments.bottom_trim || 0);

  // Zoom adjustment: zoom > 1 = zoom in (crop smaller), zoom < 1 = zoom out (crop larger)
  if (adjustments.zoom && adjustments.zoom !== 1.0) {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const halfW = (right - left) / 2 / adjustments.zoom;
    const halfH = (bottom - top) / 2 / adjustments.zoom;
    left = cx - halfW;
    top = cy - halfH;
    right = cx + halfW;
    bottom = cy + halfH;
  }

  // Clamp to image bounds
  left = Math.max(0, Math.round(left));
  top = Math.max(0, Math.round(top));
  right = Math.min(imageSize.width - 1, Math.round(right));
  bottom = Math.min(imageSize.height - 1, Math.round(bottom));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

// ─── Main process function ───────────────────────────────────────────────────

/**
 * Process a source image (headshot, bodyshot, or clothing).
 *
 * @param {string} sourcePath - path to original uploaded image
 * @param {string} type - 'headshot' | 'bodyshot' | 'clothing'
 * @param {object} [options]
 * @param {string} [options.outputDir] - dir for processed output (default: same dir as source)
 * @param {object} [options.adjustments] - manual adjustment overrides
 * @param {number} [options.bgThreshold] - color distance threshold (default: BG_THRESHOLD)
 *
 * @returns {Promise<{ processedPath, metaPath, meta }>}
 */
async function processSource(sourcePath, type, options) {
  options = options || {};
  const outputDir = options.outputDir || path.dirname(sourcePath);
  const adjustments = options.adjustments || {};
  const bgThreshold = options.bgThreshold || BG_THRESHOLD;

  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const processedPath = path.join(outputDir, `${baseName}-processed.png`);
  const metaPath = path.join(outputDir, `${baseName}-meta.json`);

  // Load existing meta if present (preserves manual_adjustments history)
  let existingMeta = null;
  if (fs.existsSync(metaPath)) {
    try { existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }

  // Detect subject bounds
  const detection = await detectSubjectBounds(sourcePath, bgThreshold);
  const { imageSize, bounds, bgColor, subjectPixels, fallback } = detection;

  const paddingFrac = PADDING_FRAC[type] || 0.20;
  const crop = computeCrop(bounds, imageSize, paddingFrac, adjustments);

  const outDims = OUTPUT_DIMS[type] || OUTPUT_DIMS.bodyshot;

  // Build Sharp pipeline: crop → resize → output
  await sharp(sourcePath)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(outDims.width, outDims.height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(processedPath);

  const meta = {
    version: '1.0',
    type,
    source_file: path.basename(sourcePath),
    source_path: path.resolve(sourcePath),
    source_dimensions: imageSize,
    bg_color: bgColor,
    bg_threshold: bgThreshold,
    bg_detection: fallback ? 'fallback_full_image' : 'corner_sample',
    subject_pixels: subjectPixels,
    detected_bounds: bounds,
    padding_frac: paddingFrac,
    crop,
    output_dimensions: outDims,
    processing_mode: Object.keys(adjustments).length > 0 ? 'manual' : 'auto',
    manual_adjustments: {
      top_trim: adjustments.top_trim || 0,
      bottom_trim: adjustments.bottom_trim || 0,
      left_trim: adjustments.left_trim || 0,
      right_trim: adjustments.right_trim || 0,
      top_expand: adjustments.top_expand || 0,
      bottom_expand: adjustments.bottom_expand || 0,
      left_expand: adjustments.left_expand || 0,
      right_expand: adjustments.right_expand || 0,
      zoom: adjustments.zoom || 1.0,
    },
    processed_at: new Date().toISOString(),
    // Preserve adjustment history
    adjustment_history: existingMeta ? [
      ...(existingMeta.adjustment_history || []),
      {
        adjustments: existingMeta.manual_adjustments,
        processed_at: existingMeta.processed_at,
      },
    ] : [],
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  return { processedPath, metaPath, meta };
}

/**
 * Reprocess a previously processed source with updated manual adjustments.
 * Reads the existing meta to get source path and detected_bounds.
 *
 * @param {string} metaPath - path to the existing *-meta.json
 * @param {object} adjustments - new manual adjustments
 * @returns {Promise<{ processedPath, metaPath, meta }>}
 */
async function reprocessSource(metaPath, adjustments) {
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Meta file not found: ${metaPath}`);
  }

  const existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sourceDir = path.dirname(metaPath);
  // Prefer stored absolute path; fall back to basename-in-same-dir
  const sourcePath = existingMeta.source_path && fs.existsSync(existingMeta.source_path)
    ? existingMeta.source_path
    : path.join(sourceDir, existingMeta.source_file);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Original source not found: ${sourcePath}`);
  }

  return processSource(sourcePath, existingMeta.type, {
    outputDir: sourceDir,
    adjustments,
    bgThreshold: existingMeta.bg_threshold,
  });
}

/**
 * Load existing processing metadata for a source type under a character's staging dir.
 * Returns null if not yet processed.
 */
function loadSourceMeta(stagingDir, type) {
  const metaPath = path.join(stagingDir, `${type}-meta.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Apply a user-supplied adjust transform to a source image.
 * Re-crops from the original using an explicit crop_box in original image space.
 *
 * @param {string} originalPath - path to original (unprocessed) source image
 * @param {string} type - 'headshot' | 'bodyshot' | 'clothing'
 * @param {string} outputDir - directory for adjusted output
 * @param {object} params
 * @param {object} [params.crop_box] - { x, y, w, h } in original image pixels (all optional; defaults to auto-detected bounds from meta if available, else full image)
 * @param {number} [params.offset_x=0] - horizontal shift in original pixels (applied to crop_box center; positive = right)
 * @param {number} [params.offset_y=0] - vertical shift in original pixels (positive = down)
 * @param {number} [params.scale=1.0] - zoom into the crop region (>1 = zoom in = smaller crop area = more zoomed)
 * @param {object} [params.existingMeta] - previously saved processing meta (used to default crop_box if none provided)
 *
 * @returns {Promise<{ adjustedPath, cropBox, outputDimensions, validation }>}
 */
async function adjustSource(originalPath, type, outputDir, params) {
  params = params || {};

  if (!fs.existsSync(originalPath)) {
    throw new Error(`Original source not found: ${originalPath}`);
  }

  // Get original image dimensions
  const meta = await sharp(originalPath).metadata();
  const imgW = meta.width;
  const imgH = meta.height;

  // Determine crop_box — use supplied, or fall back to full image
  let { x = 0, y = 0, w = imgW, h = imgH } = params.crop_box || {};

  // Apply offset (shift crop center)
  const offsetX = Number(params.offset_x) || 0;
  const offsetY = Number(params.offset_y) || 0;
  if (offsetX || offsetY) {
    x += offsetX;
    y += offsetY;
  }

  // Apply scale (zoom: scale > 1 = zoom in = shrink crop area)
  const scale = Number(params.scale) || 1.0;
  if (scale !== 1.0 && scale > 0) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    w = w / scale;
    h = h / scale;
    x = cx - w / 2;
    y = cy - h / 2;
  }

  // Clamp to image bounds
  const validation = { warnings: [] };
  const clamped = clampCropBox({ x, y, w, h }, imgW, imgH, validation);

  const outDims = OUTPUT_DIMS[type] || OUTPUT_DIMS.bodyshot;
  const adjustedPath = path.join(outputDir, `${type}-adjusted.png`);

  fs.mkdirSync(outputDir, { recursive: true });

  await sharp(originalPath)
    .extract({
      left: clamped.x,
      top: clamped.y,
      width: clamped.w,
      height: clamped.h,
    })
    .resize(outDims.width, outDims.height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(adjustedPath);

  return {
    adjustedPath,
    cropBox: clamped,
    outputDimensions: outDims,
    validation,
  };
}

/**
 * Clamp a crop_box to image bounds. Returns corrected { x, y, w, h }.
 * Throws if result has zero width or height.
 */
function clampCropBox(box, imgW, imgH, validation) {
  let { x, y, w, h } = box;

  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);

  // Clamp origin
  if (x < 0) { w += x; x = 0; validation.warnings.push(`x clamped from ${box.x} to 0`); }
  if (y < 0) { h += y; y = 0; validation.warnings.push(`y clamped from ${box.y} to 0`); }

  // Clamp extent
  if (x + w > imgW) { w = imgW - x; validation.warnings.push(`w clamped to fit image width (${imgW})`); }
  if (y + h > imgH) { h = imgH - y; validation.warnings.push(`h clamped to fit image height (${imgH})`); }

  if (w <= 0 || h <= 0) {
    throw new Error(`crop_box results in zero-size region after clamping (x=${x} y=${y} w=${w} h=${h} — image is ${imgW}×${imgH})`);
  }

  return { x, y, w, h };
}

module.exports = {
  processSource,
  reprocessSource,
  adjustSource,
  detectSubjectBounds,
  computeCrop,
  clampCropBox,
  loadSourceMeta,
  OUTPUT_DIMS,
  PADDING_FRAC,
  BG_THRESHOLD,
};
