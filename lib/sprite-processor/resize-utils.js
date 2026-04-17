'use strict';
/**
 * resize-utils.js — High-quality and pixel-perfect resize helpers for Sharp.
 *
 * progressiveResize(input, targetW, targetH, opts)
 *   High-quality: halves dimensions with lanczos3 until within 2x of target,
 *   then performs final resize. Equivalent to Photoshop Bicubic Sharper.
 *   Pixel-perfect: single-pass nearest-neighbor (lossless for pixel art).
 *
 * @param {Buffer|string} input   - Sharp-compatible input (buffer or file path)
 * @param {number} targetW
 * @param {number} targetH
 * @param {object} opts
 *   mode:       'high-quality' | 'pixel-perfect'  (default: 'high-quality')
 *   fit:        sharp fit value                    (default: 'contain')
 *   background: sharp background color             (default: transparent)
 * @returns {Promise<sharp.Sharp>}  Sharp instance ready for .toFile() / .toBuffer()
 */

const sharp = require('sharp');

async function progressiveResize(input, targetW, targetH, opts = {}) {
  const mode       = opts.mode       || process.env.SPRITE_RESIZE_MODE || 'high-quality';
  const fit        = opts.fit        || 'contain';
  const background = opts.background || { r: 0, g: 0, b: 0, alpha: 0 };

  if (mode === 'pixel-perfect') {
    return sharp(input).resize(targetW, targetH, { fit, kernel: 'nearest', background });
  }

  // ── High-quality path ─────────────────────────────────────────────────────
  const meta = await sharp(input).metadata();
  let curW = meta.width;
  let curH = meta.height;

  // Already within 2× of target — single lanczos3 pass is optimal
  if (curW <= targetW * 2 && curH <= targetH * 2) {
    return sharp(input).resize(targetW, targetH, { fit, kernel: 'lanczos3', background });
  }

  // Progressive halving: halve both dims together (preserves aspect ratio)
  // until both are within 2× of target
  let buf = await sharp(input).png({ compressionLevel: 0, effort: 1 }).toBuffer();

  while (curW > targetW * 2 || curH > targetH * 2) {
    // Scale W by 0.5; scale H proportionally to preserve aspect ratio
    const nextW = Math.max(targetW, Math.round(curW * 0.5));
    const nextH = Math.max(targetH, Math.round(curH * (nextW / curW)));

    if (nextW >= curW && nextH >= curH) break; // safety — no forward progress

    buf = await sharp(buf)
      .resize(nextW, nextH, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 0, effort: 1 })
      .toBuffer();

    curW = nextW;
    curH = nextH;
  }

  // Final step with correct fit (adds letterboxing if needed)
  return sharp(buf).resize(targetW, targetH, { fit, kernel: 'lanczos3', background });
}

module.exports = { progressiveResize };
