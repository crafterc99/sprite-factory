'use strict';
/**
 * quality-check.js — Frame quality verification pipeline
 *
 * GET  /api/quality-check/:character/:anim
 *   Slices the strip into frames using the pixel-perfect pipeline, reassembles
 *   it, then does a pixel-level diff against the original.
 *
 * Reports:
 *   a) original cut frame  ← direct sharp.extract from disk
 *   b) exported frame      ← reassembled strip from sliced frames
 *   maxDelta === 0 = perfect lossless round-trip
 */

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');
const os   = require('os');

const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, '../data/assets');

function register(router, ctx) {
  const json = ctx?.json ?? ((res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });

  router.get('/api/quality-check/:character/:anim', async (req, res, params) => {
    const { character, anim } = params;
    const stripPath = path.join(ASSETS_DIR, `${character}-${anim}.png`);
    if (!fs.existsSync(stripPath)) {
      return json(res, { error: `Strip not found: ${character}-${anim}.png` }, 404);
    }
    try {
      const result = await runQualityCheck(stripPath);
      return json(res, { character, anim, ...result });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  router.post('/api/quality-check', async (req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { stripPath: rel } = JSON.parse(body || '{}');
        const stripPath = rel ? path.resolve(__dirname, '..', rel) : null;
        if (!stripPath || !fs.existsSync(stripPath)) {
          return json(res, { error: 'stripPath not found' }, 400);
        }
        const result = await runQualityCheck(stripPath);
        return json(res, { stripPath: rel, ...result });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    });
  });
}

/**
 * Core quality check: slice → reassemble → diff
 */
async function runQualityCheck(stripPath) {
  const meta = await sharp(stripPath).metadata();
  const stripW = meta.width;
  const stripH = meta.height;
  const frameSize = stripH; // frames are square (180×180)
  const frameCount = Math.round(stripW / frameSize);

  if (frameCount < 1) throw new Error(`Invalid strip: ${stripW}x${stripH}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfqc-'));

  try {
    // Step 1: Slice frames (nearest-neighbor, lossless PNG)
    const framePaths = [];
    for (let i = 0; i < frameCount; i++) {
      const p = path.join(tmpDir, `frame-${i}.png`);
      await sharp(stripPath)
        .extract({ left: i * frameSize, top: 0, width: frameSize, height: frameSize })
        .png({ compressionLevel: 0, effort: 1 })
        .toFile(p);
      framePaths.push(p);
    }

    // Step 2: Reassemble strip from sliced frames (no resize — exact placement)
    const reassembledPath = path.join(tmpDir, 'reassembled.png');
    const composites = framePaths.map((p, i) => ({ input: p, left: i * frameSize, top: 0 }));
    await sharp({
      create: { width: stripW, height: stripH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(composites)
      .png({ compressionLevel: 0, effort: 1 })
      .toFile(reassembledPath);

    // Step 3: Pixel-level diff
    const origBuf  = await sharp(stripPath).ensureAlpha().raw().toBuffer();
    const reconBuf = await sharp(reassembledPath).ensureAlpha().raw().toBuffer();
    const stripDiff = pixelDiff(origBuf, reconBuf);

    // Per-frame diffs
    const frameResults = await Promise.all(framePaths.map(async (fp, i) => {
      const origFrame  = await sharp(stripPath)
        .extract({ left: i * frameSize, top: 0, width: frameSize, height: frameSize })
        .ensureAlpha().raw().toBuffer();
      const reconFrame = await sharp(fp).ensureAlpha().raw().toBuffer();
      return { index: i, ...pixelDiff(origFrame, reconFrame) };
    }));

    return {
      frameCount,
      frameSize,
      stripW,
      stripH,
      roundTrip: stripDiff,
      frames: frameResults,
      pipeline: {
        kernel: 'nearest (pixel-perfect)',
        compression: 'lossless PNG (compressionLevel:0, effort:1)',
        smoothing: 'disabled',
      },
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Compare two raw pixel buffers. maxDelta === 0 = lossless. */
function pixelDiff(a, b) {
  if (a.length !== b.length) {
    return { maxDelta: 255, meanDelta: 255, identical: false, pass: false, note: 'size mismatch' };
  }
  let total = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    total += d;
  }
  return {
    maxDelta: max,
    meanDelta: parseFloat((total / a.length).toFixed(4)),
    identical: max === 0,
    pass: max === 0,
  };
}

module.exports = { register, runQualityCheck };
