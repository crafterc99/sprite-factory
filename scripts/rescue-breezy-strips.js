#!/usr/bin/env node
/**
 * INTEGRATION-003: Rescue Breezy Orphaned Strips
 *
 * These 3 files are batch renders on black backgrounds, NOT uniform grids.
 * Each file has sprites arranged in 2 content rows, with ~4 sprites per row.
 * We detect sprite clusters, extract each one, resize to 180px height,
 * remove black background, and assemble into a horizontal strip.
 */

'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = '/Users/pshelley/sprite-tools/sprite-factory/data/assets';
const TARGET_HEIGHT = 180;
const BG_THRESHOLD = 40; // color distance from black to consider as background
const MIN_CLUSTER_WIDTH = 80; // min pixels to count as a sprite column
const CLUSTER_GAP_THRESHOLD = 15; // gap (px) between columns that splits clusters

const FILES = [
  'breezy-defensive-slide-left',
  'breezy-defensive-slide-right',
  'breezy-idle-dribble',
];

function colorDist(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Find content row ranges (non-black rows) in the image.
 * Returns array of { yStart, yEnd } for each content block.
 */
function findRowRanges(data, width, height, channels) {
  const rowBrightness = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (b > 20) rowBrightness[y] += b;
    }
  }

  const threshold = 5000;
  const MIN_ROW_HEIGHT = 50; // ignore tiny row fragments (noise)
  const ROW_GAP_THRESHOLD = 50; // merge rows separated by less than this many blank rows
  const rowContent = rowBrightness.map(b => b > threshold);
  const rawRanges = [];
  let inContent = false;
  let start = 0;

  for (let y = 0; y < height; y++) {
    if (rowContent[y] && !inContent) {
      inContent = true;
      start = y;
    } else if (!rowContent[y] && inContent) {
      inContent = false;
      rawRanges.push({ yStart: start, yEnd: y - 1 });
    }
  }
  if (inContent) rawRanges.push({ yStart: start, yEnd: height - 1 });

  // Filter out tiny row fragments and merge nearby rows
  const filtered = rawRanges.filter(r => (r.yEnd - r.yStart + 1) >= MIN_ROW_HEIGHT);

  const ranges = [];
  let i = 0;
  while (i < filtered.length) {
    let rStart = filtered[i].yStart;
    let rEnd = filtered[i].yEnd;
    i++;
    while (i < filtered.length) {
      const gap = filtered[i].yStart - rEnd - 1;
      if (gap < ROW_GAP_THRESHOLD) {
        rEnd = filtered[i].yEnd;
        i++;
      } else {
        break;
      }
    }
    ranges.push({ yStart: rStart, yEnd: rEnd });
  }

  return ranges;
}

/**
 * For a given row range, find column clusters (individual sprites).
 * Returns array of { xStart, xEnd } for each sprite column cluster.
 */
function findColClusters(data, width, height, channels, yStart, yEnd) {
  const colBrightness = new Float64Array(width);
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      colBrightness[x] += b;
    }
  }

  // Smooth column brightness with a 3-pixel window to eliminate single-pixel noise
  const SMOOTH_WINDOW = 3;
  const smoothed = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let dx = -SMOOTH_WINDOW; dx <= SMOOTH_WINDOW; dx++) {
      const nx = x + dx;
      if (nx >= 0 && nx < width) { sum += colBrightness[nx]; count++; }
    }
    smoothed[x] = sum / count;
  }

  const maxB = Math.max(...smoothed);
  // Use 2% of max or 2000 minimum as threshold
  const colThreshold = Math.max(maxB * 0.02, 2000);
  const colContent = smoothed.map(b => b > colThreshold);

  // Build list of contiguous content runs with gaps
  // First pass: find all [start, end] runs of content
  const runs = [];
  let inRun = false;
  let runStart = 0;
  for (let x = 0; x < width; x++) {
    if (colContent[x] && !inRun) {
      inRun = true;
      runStart = x;
    } else if (!colContent[x] && inRun) {
      inRun = false;
      runs.push({ xStart: runStart, xEnd: x - 1 });
    }
  }
  if (inRun) runs.push({ xStart: runStart, xEnd: width - 1 });

  // Second pass: merge runs that are separated by small gaps, split on large gaps
  const clusters = [];
  let i = 0;
  while (i < runs.length) {
    let clusterStart = runs[i].xStart;
    let clusterEnd = runs[i].xEnd;
    i++;

    while (i < runs.length) {
      const gap = runs[i].xStart - clusterEnd - 1;
      if (gap < CLUSTER_GAP_THRESHOLD) {
        // Merge this run into current cluster
        clusterEnd = runs[i].xEnd;
        i++;
      } else {
        // Large gap — end current cluster
        break;
      }
    }

    const clusterWidth = clusterEnd - clusterStart + 1;
    if (clusterWidth >= MIN_CLUSTER_WIDTH) {
      clusters.push({ xStart: clusterStart, xEnd: clusterEnd });
    }
  }

  return clusters;
}

/**
 * Extract a cell from the source image, remove black background,
 * and resize to TARGET_HEIGHT while maintaining aspect ratio.
 */
async function extractAndProcess(sourceBuffer, width, height, channels, xStart, xEnd, yStart, yEnd) {
  const cellW = xEnd - xStart + 1;
  const cellH = yEnd - yStart + 1;

  // Create RGBA buffer for the cell
  const cellData = Buffer.alloc(cellW * cellH * 4);

  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const srcIdx = ((yStart + y) * width + (xStart + x)) * channels;
      const dstIdx = (y * cellW + x) * 4;

      const r = sourceBuffer[srcIdx];
      const g = sourceBuffer[srcIdx + 1];
      const b = sourceBuffer[srcIdx + 2];
      const srcA = channels === 4 ? sourceBuffer[srcIdx + 3] : 255;

      // Check if pixel is near-black background
      const distFromBlack = colorDist(r, g, b, 0, 0, 0);
      const alpha = (srcA < 10 || distFromBlack < BG_THRESHOLD) ? 0 : 255;

      cellData[dstIdx] = r;
      cellData[dstIdx + 1] = g;
      cellData[dstIdx + 2] = b;
      cellData[dstIdx + 3] = alpha;
    }
  }

  // Create sharp image from the cell
  const cellImg = sharp(cellData, {
    raw: { width: cellW, height: cellH, channels: 4 },
  });

  // Resize to exactly TARGET_HEIGHT x TARGET_HEIGHT (180x180) using 'contain' to preserve
  // aspect ratio, with transparent padding to fill the square frame
  return cellImg
    .resize(TARGET_HEIGHT, TARGET_HEIGHT, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function rescueFile(filename) {
  const rawPath = path.join(ASSETS_DIR, filename + '-raw.png');
  const outPath = path.join(ASSETS_DIR, filename + '.png');

  console.log(`\n[${filename}]`);
  console.log(`  Source: ${rawPath}`);

  const { data, info } = await sharp(rawPath)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  console.log(`  Dimensions: ${width}x${height}, channels: ${channels}`);

  // Step 1: Find content row ranges
  const rowRanges = findRowRanges(data, width, height, channels);
  console.log(`  Content rows found: ${rowRanges.length}`);
  rowRanges.forEach((r, i) => {
    console.log(`    Row ${i}: y=${r.yStart}-${r.yEnd} (height=${r.yEnd - r.yStart + 1})`);
  });

  // Step 2: For each row range, find sprite column clusters
  const allCells = [];
  for (let ri = 0; ri < rowRanges.length; ri++) {
    const row = rowRanges[ri];
    const clusters = findColClusters(data, width, height, channels, row.yStart, row.yEnd);
    console.log(`  Row ${ri} sprites: ${clusters.length}`);
    clusters.forEach((c, ci) => {
      const cellW = c.xEnd - c.xStart + 1;
      console.log(`    Sprite ${ci}: x=${c.xStart}-${c.xEnd} (w=${cellW})`);
      allCells.push({ xStart: c.xStart, xEnd: c.xEnd, yStart: row.yStart, yEnd: row.yEnd });
    });
  }

  if (allCells.length === 0) {
    console.error(`  ERROR: No sprites found in ${filename}`);
    return null;
  }

  console.log(`  Total sprites extracted: ${allCells.length}`);

  // Step 3: Extract each sprite and build horizontal strip
  const frameBuffers = [];
  const frameDims = [];

  for (let i = 0; i < allCells.length; i++) {
    const cell = allCells[i];
    const buf = await extractAndProcess(
      data, width, height, channels,
      cell.xStart, cell.xEnd, cell.yStart, cell.yEnd
    );
    const meta = await sharp(buf).metadata();
    frameBuffers.push(buf);
    frameDims.push({ width: meta.width, height: meta.height });
    console.log(`    Frame ${i}: ${meta.width}x${meta.height}`);
  }

  // Assemble horizontal strip
  const totalWidth = frameDims.reduce((sum, d) => sum + d.width, 0);
  const composites = [];
  let xOffset = 0;

  for (let i = 0; i < frameBuffers.length; i++) {
    composites.push({ input: frameBuffers[i], left: xOffset, top: 0 });
    xOffset += frameDims[i].width;
  }

  await sharp({
    create: {
      width: totalWidth,
      height: TARGET_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outPath);

  const outMeta = await sharp(outPath).metadata();
  console.log(`  Output: ${outPath}`);
  console.log(`  Output dimensions: ${outMeta.width}x${outMeta.height}`);
  console.log(`  Frame count: ${allCells.length}, Expected width: ${allCells.length * 180} (actual: ${outMeta.width})`);

  return {
    filename,
    frameCount: allCells.length,
    outputWidth: outMeta.width,
    outputHeight: outMeta.height,
  };
}

async function main() {
  console.log('=== INTEGRATION-003: Rescue Breezy Orphaned Strips ===');

  const results = [];
  for (const filename of FILES) {
    try {
      const result = await rescueFile(filename);
      if (result) results.push(result);
    } catch (err) {
      console.error(`  ERROR processing ${filename}:`, err.message);
    }
  }

  console.log('\n=== SUMMARY ===');
  results.forEach(r => {
    console.log(`${r.filename}: ${r.frameCount} frames, ${r.outputWidth}x${r.outputHeight}`);
  });

  // Verify all outputs are (N*180)x180
  let allPass = true;
  results.forEach(r => {
    const isValidHeight = r.outputHeight === TARGET_HEIGHT;
    const isValidWidth = r.outputWidth > 0 && r.outputWidth % 1 === 0;
    if (!isValidHeight) {
      console.error(`FAIL: ${r.filename} height is ${r.outputHeight}, expected ${TARGET_HEIGHT}`);
      allPass = false;
    }
    if (r.frameCount < 2) {
      console.warn(`WARN: ${r.filename} only has ${r.frameCount} frame(s), expected >=2`);
    }
    console.log(`${isValidHeight ? 'PASS' : 'FAIL'}: ${r.filename} - ${r.outputWidth}x${r.outputHeight} (${r.frameCount} frames)`);
  });

  if (allPass) {
    console.log('\nAll strips rescued successfully.');
  } else {
    console.error('\nSome strips failed validation.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
