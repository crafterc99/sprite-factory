#!/usr/bin/env node
/**
 * Standalone script: regenerate snoop-idle.png
 * Writes status to /tmp/regen-snoop-idle-status.json on completion or error.
 */
const path = require('path');
const fs = require('fs');

const ASSETS_DIR = path.resolve(__dirname, '../data/assets');
const RAW_DIR = path.resolve(__dirname, '../data/raw-sprites');

const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { processSprite } = require('../lib/sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const STATUS_FILE = '/tmp/regen-snoop-idle-status.json';

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
}

async function main() {
  writeStatus({ status: 'running', startedAt: new Date().toISOString() });

  // Use cheapest image model
  const modelId = 'gemini-2.5-flash-image';
  const client = new NanaBananaClient({ model: modelId });

  const character = 'snoop';
  const animation = 'idle';
  const totalFrames = 4;

  const charRef = path.join(ASSETS_DIR, 'snoopfull.png');
  if (!fs.existsSync(charRef)) {
    writeStatus({ status: 'error', error: 'snoopfull.png not found' });
    process.exit(1);
  }

  const prompt = [
    'EXACTLY 4 frames side by side in one image, 720x180 total (each frame 180x180).',
    'Pixel art sprite sheet. BRIGHT GREEN (#00FF00) background ONLY — no white, no gray, no dark.',
    'CHARACTER SIZE CRITICAL: feet touch the very bottom edge of the 180px frame height,',
    'head within 5px of the top edge — character fills the full 180px height.',
    '',
    'IDLE ANIMATION ONLY — standing still with very subtle breathing/weight-shift.',
    'NO basketball at all. NO dribbling. NO shooting. NO jumping. NO running.',
    '',
    'Frame 1: neutral upright relaxed standing pose, arms at sides, weight centered.',
    'Frame 2: very slight lean right, right knee softly bent, right shoulder dips slightly.',
    'Frame 3: back to center, minimal movement, both knees soft.',
    'Frame 4: very slight lean left, left knee softly bent, left shoulder dips slightly.',
    '',
    'Loop: Frame 4 flows naturally back into Frame 1.',
    '',
    'Consistent character identity in all 4 frames.',
    'Basketball player outfit.',
    'ONE character only per frame.',
    'No extra characters, no border, no artifacts, no text.',
    'Style: 16-bit pixel art, GBA style, bold black pixel outlines.',
  ].join('\n');

  const outputPath = path.join(RAW_DIR, `${character}-${animation}-raw.png`);

  try {
    writeStatus({ status: 'generating', startedAt: new Date().toISOString() });

    // Call generate directly so we can pass a longer timeoutMs
    const result = await client.generate(prompt, {
      referenceImages: [charRef],
      aspectRatio: '16:9',
      resolution: '2K',
      model: modelId,
      timeoutMs: 180000, // 3 min per attempt
    });

    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(outputPath, result.imageBuffer);

    writeStatus({ status: 'processing', rawPath: outputPath });

    const costInfo = recordCost(modelId, 'strip', '2K', 1, { character, animation });

    const processed = await processSprite(outputPath, `${character}-${animation}`, {
      frameCount: totalFrames,
      targetSize: 180,
      outputDir: ASSETS_DIR,
    });

    const finalPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);

    writeStatus({
      status: 'done',
      completedAt: new Date().toISOString(),
      frames: processed.frameCount,
      outputPath: finalPath,
      cost: costInfo,
    });

    console.log('SUCCESS:', finalPath);
    console.log('Frames:', processed.frameCount);
  } catch (err) {
    writeStatus({ status: 'error', error: err.message, stack: err.stack });
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

main();
