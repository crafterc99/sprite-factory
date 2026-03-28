#!/usr/bin/env node
/**
 * Reprocess snoop-idle-regen-raw.png through the fixed pipeline.
 * Skips generation — uses existing raw at data/raw-sprites/snoop-idle-regen-raw.png.
 * Fixed pipeline includes cropToContent before resizeFrame (bug from prior run is now fixed).
 * Writes result to data/assets/snoop-idle.png if QC >= 80.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const BASE_DIR = path.resolve(__dirname, '..');
const RAW_PATH = path.join(BASE_DIR, 'data/raw-sprites/snoop-idle-regen-raw.png');
const ASSETS_DIR = path.join(BASE_DIR, 'data/assets');
const OUTPUT_PATH = path.join(ASSETS_DIR, 'snoop-idle.png');
const FRAMES_DIR = path.join(ASSETS_DIR, 'snoop-idle-frames');
const TEMP_DIR = path.join(BASE_DIR, 'data', '.tmp-snoop-idle-reprocess');

const {
  processSprite,
  evaluateStrip,
  cutFrames,
} = require('../lib/sprite-processor/index');

const STATUS_FILE = '/tmp/reprocess-snoop-idle-status.json';

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  console.log('[status]', JSON.stringify(obj, null, 2));
}

async function main() {
  writeStatus({ status: 'starting', rawPath: RAW_PATH });

  // Verify raw exists and has correct dimensions
  if (!fs.existsSync(RAW_PATH)) {
    writeStatus({ status: 'error', error: 'Raw file not found: ' + RAW_PATH });
    process.exit(1);
  }

  const meta = await sharp(RAW_PATH).metadata();
  console.log(`Raw dimensions: ${meta.width}x${meta.height}`);

  if (meta.width !== 1344 || meta.height !== 768) {
    writeStatus({
      status: 'error',
      error: `Unexpected raw dimensions: ${meta.width}x${meta.height}, expected 1344x768`,
    });
    process.exit(1);
  }

  // Run the fixed processSprite pipeline
  // frameCount=5 causes: frameWidth = Math.floor(1344/5) = 268, frameHeight = 768
  // Fixed pipeline: cutFrames -> removeBackground -> cropToContent (NEW) -> resize -> buildStrip
  writeStatus({ status: 'processing', rawPath: RAW_PATH });

  const processed = await processSprite(RAW_PATH, 'snoop-idle', {
    frameCount: 5,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  console.log(`\nProcessed: ${processed.outputPath}`);
  console.log(`Frames: ${processed.frameCount} x ${processed.frameSize}x${processed.frameSize}`);

  // Verify output dimensions
  const outMeta = await sharp(processed.outputPath).metadata();
  const expectedW = processed.frameCount * processed.frameSize;
  const expectedH = processed.frameSize;
  console.log(`Output: ${outMeta.width}x${outMeta.height} (expected ${expectedW}x${expectedH})`);

  // Collect frame paths for QC evaluation
  const framePaths = [];
  for (let i = 0; i < processed.frameCount; i++) {
    const fp = path.join(processed.framesDir, `frame-${i}.png`);
    if (!fs.existsSync(fp)) {
      writeStatus({ status: 'error', error: `Frame not found: ${fp}` });
      process.exit(1);
    }
    framePaths.push(fp);
  }

  // Run QC evaluation
  console.log(`\nRunning QC evaluation on ${framePaths.length} frames...`);
  const qc = await evaluateStrip(framePaths);

  console.log(`\n=== QC RESULTS ===`);
  console.log(`Overall score:    ${qc.overallScore}/100`);
  console.log(`Avg frame score:  ${qc.avgFrameScore}/100`);
  console.log(`Consistency:      ${qc.consistencyScore}/100`);
  console.log(`Median fill:      ${qc.medianFill}%`);
  console.log(`Passed:           ${qc.passed}`);

  if (qc.issues.length > 0) {
    console.log(`\nIssues:`);
    for (const issue of qc.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.msg} (frames: ${issue.affectedFrames.join(',')})`);
    }
  }

  console.log(`\nPer-frame scores:`);
  qc.frameResults.forEach((r, i) => {
    const issueTypes = r.issues.map(iss => iss.type).join(', ') || 'none';
    console.log(`  Frame ${i}: ${r.score}/100  fill=${r.metrics.fillHeight}%  coverage=${r.metrics.coverage}%  issues: ${issueTypes}`);
  });

  const THRESHOLD = 80;
  const accepted = qc.overallScore >= THRESHOLD;

  if (accepted) {
    console.log(`\nPASSED: ${qc.overallScore}/100 >= ${THRESHOLD} threshold`);
    console.log(`Output at: ${processed.outputPath}`);
    writeStatus({
      status: 'done',
      accepted: true,
      score: qc.overallScore,
      threshold: THRESHOLD,
      outputPath: processed.outputPath,
      framesDir: processed.framesDir,
      frameCount: processed.frameCount,
      dimensions: `${outMeta.width}x${outMeta.height}`,
      qc: {
        overallScore: qc.overallScore,
        avgFrameScore: qc.avgFrameScore,
        consistencyScore: qc.consistencyScore,
        medianFill: qc.medianFill,
        frameScores: qc.frameResults.map(r => r.score),
        issues: qc.issues,
      },
    });
  } else {
    console.log(`\nFAILED: ${qc.overallScore}/100 < ${THRESHOLD} threshold`);
    console.log(`Issues:`);
    for (const issue of qc.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.msg}`);
    }
    writeStatus({
      status: 'failed',
      accepted: false,
      score: qc.overallScore,
      threshold: THRESHOLD,
      outputPath: processed.outputPath,
      frameCount: processed.frameCount,
      qc: {
        overallScore: qc.overallScore,
        avgFrameScore: qc.avgFrameScore,
        consistencyScore: qc.consistencyScore,
        medianFill: qc.medianFill,
        frameScores: qc.frameResults.map(r => r.score),
        issues: qc.issues,
      },
    });
    process.exit(2);
  }
}

main().catch(err => {
  writeStatus({ status: 'error', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
