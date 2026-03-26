/**
 * Height Scaler — Height/baseline/scale system for sprite standardization
 *
 * Baseline: 6'0" (72") = 100% scale = 112px content height (62% of 180px frame)
 *
 * | Height | Scale | Pixel Height | % of 180px |
 * |--------|-------|-------------|-----------|
 * | 5'8"   | 0.944 | 105px       | 58%       |
 * | 6'0"   | 1.000 | 112px       | 62%       |
 * | 6'4"   | 1.056 | 118px       | 65%       |
 * | 6'8"   | 1.111 | 124px       | 69%       |
 * | 7'0"   | 1.167 | 130px       | 72%       |
 *
 * Formula: pixelHeight = Math.round(111.6 * heightInches / 72)
 *
 * Baseline anchoring: Feet at Y=170 (97% of frame) — matches PlayerRenderer.ts origin(0.5, 0.97).
 * Taller characters fill upward. Shorter characters get more transparent padding above head.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const DEFAULT_FRAME_SIZE = 180;
const BASELINE_HEIGHT_INCHES = 72; // 6'0"
const BASELINE_PIXEL_HEIGHT = 112; // ~62% of 180
const BASELINE_Y = 170; // 97% of 180px frame — feet position

/**
 * Compute scale metrics from height in inches.
 */
function computeScaleFromHeight(heightInches) {
  const scaleMultiplier = +(heightInches / BASELINE_HEIGHT_INCHES).toFixed(3);
  const pixelHeight = Math.round(111.6 * heightInches / BASELINE_HEIGHT_INCHES);
  const framePct = +((pixelHeight / DEFAULT_FRAME_SIZE) * 100).toFixed(1);
  return { scaleMultiplier, pixelHeight, framePct };
}

/**
 * Scale a processed frame to the correct height based on character height.
 *
 * After BG removal + crop-to-content:
 * 1. Scale content to targetPixelHeight
 * 2. Position feet at baseline Y=170
 * 3. Pad to 180×180 with transparency
 *
 * @param {string} framePath - Input frame (already BG-removed and cropped)
 * @param {string} outputPath - Output path
 * @param {number} targetPixelHeight - Computed pixel height for this character
 * @param {number} baselineY - Y position for feet (default 170)
 * @param {number} frameSize - Output frame dimensions (default 180)
 */
async function scaleToHeight(framePath, outputPath, targetPixelHeight, baselineY = BASELINE_Y, frameSize = DEFAULT_FRAME_SIZE) {
  const image = sharp(framePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  // Find content bounds
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
    // Empty frame — just resize
    await sharp(framePath)
      .resize(frameSize, frameSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);
    return outputPath;
  }

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;

  // Scale content to target height while maintaining aspect ratio
  const scale = targetPixelHeight / contentH;
  const scaledW = Math.round(contentW * scale);
  const scaledH = targetPixelHeight;

  // Crop to content first
  const croppedBuf = await sharp(framePath)
    .extract({ left: minX, top: minY, width: contentW, height: contentH })
    .resize(scaledW, scaledH, { kernel: sharp.kernel.nearest })
    .toBuffer();

  // Position on canvas: feet at baselineY, centered horizontally
  const left = Math.max(0, Math.round((frameSize - scaledW) / 2));
  const top = Math.max(0, baselineY - scaledH); // feet at baseline

  // Create transparent canvas and composite
  await sharp({
    create: {
      width: frameSize,
      height: frameSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: croppedBuf,
      left,
      top: Math.max(0, top),
    }])
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Process a single frame with height-aware scaling.
 * Pipeline: removeBackground → scaleToHeight → output
 *
 * @param {string} inputPath - Raw frame path
 * @param {string} outputPath - Output path
 * @param {object} opts - { targetPixelHeight, baselineY, width, height }
 */
async function processFrameWithHeight(inputPath, outputPath, opts = {}) {
  const { removeBackground, cropToContent } = require('./index');

  const targetPixelHeight = opts.targetPixelHeight || BASELINE_PIXEL_HEIGHT;
  const baselineY = opts.baselineY || BASELINE_Y;
  const frameSize = opts.width || DEFAULT_FRAME_SIZE;

  // Step 1: Remove green background
  const cleanPath = outputPath.replace('.png', '-clean.png');
  await removeBackground(inputPath, cleanPath, {
    hueMin: opts.hueMin ?? 80,
    hueMax: opts.hueMax ?? 160,
    satMin: opts.satMin ?? 0.25,
    valMin: opts.valMin ?? 0.25,
  });

  // Step 2: Scale to correct height and position on baseline
  await scaleToHeight(cleanPath, outputPath, targetPixelHeight, baselineY, frameSize);

  // Clean up temp
  try { fs.unlinkSync(cleanPath); } catch {}

  return outputPath;
}

/**
 * Get a height table for reference.
 */
function getHeightTable() {
  const heights = [
    { label: "5'6\"", inches: 66 },
    { label: "5'8\"", inches: 68 },
    { label: "5'10\"", inches: 70 },
    { label: "6'0\"", inches: 72 },
    { label: "6'2\"", inches: 74 },
    { label: "6'4\"", inches: 76 },
    { label: "6'6\"", inches: 78 },
    { label: "6'8\"", inches: 80 },
    { label: "6'10\"", inches: 82 },
    { label: "7'0\"", inches: 84 },
    { label: "7'2\"", inches: 86 },
  ];

  return heights.map(h => {
    const { scaleMultiplier, pixelHeight, framePct } = computeScaleFromHeight(h.inches);
    return { ...h, scaleMultiplier, pixelHeight, framePct };
  });
}

module.exports = {
  computeScaleFromHeight,
  scaleToHeight,
  processFrameWithHeight,
  getHeightTable,
  BASELINE_HEIGHT_INCHES,
  BASELINE_PIXEL_HEIGHT,
  BASELINE_Y,
  DEFAULT_FRAME_SIZE,
};
