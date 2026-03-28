#!/usr/bin/env node
/**
 * gen-tasks-6002-6003.js
 *
 * TASK-6002: bron-test idle (4f) + dribble (8f)
 * TASK-6003: breezy jump regen (5f, target ≥85/100)
 *
 * Uses gemini-2.5-flash-image (pro models still returning 500).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { processSprite, evaluateStrip } = require('../lib/sprite-processor/index');

const ASSETS_DIR = path.resolve(__dirname, '../data/assets');
const RAW_DIR    = path.resolve(__dirname, '../data/raw-sprites');
const MODEL      = process.env.SPRITE_MODEL || 'gemini-2.5-flash-image';

fs.mkdirSync(RAW_DIR, { recursive: true });

// ─── Shared prompt blocks ─────────────────────────────────────────────────────

const PIXEL_ANCHOR = `SIZE — PIXEL-EXACT ANCHORING (critical):
The character is drawn inside a square frame.
- The character's feet must be at the VERY BOTTOM of the frame.
- The character's head must be at the VERY TOP of the frame (within 5% of top edge).
- The full body — head to feet — must be visible with NO cropping.
- The character must be TALL and fill the vertical space.`;

const BG = `BACKGROUND: Every non-character pixel must be solid bright green (#00FF00). No dark borders, no grid lines, no artifacts, no cursor icons, no watermarks.`;

const STRIP = (n) => `OUTPUT: Single horizontal strip — exactly ${n} equally-sized square frames side by side. No gaps, no borders around the strip.`;

// ─── TASK-6002: bron-test ─────────────────────────────────────────────────────

const BRON_IDENTITY = `CHARACTER (identical in every frame):
Male basketball player — tall, athletic, powerful build. Brown skin, short hair.
16-bit pixel art, GBA style, bold BLACK pixel outlines.
Keep the EXACT face, skin tone, build, and proportions of the character in Image 1 (angle ref) and Image 2 (portrait).`;

const BRON_TARGETS = {
  idle: {
    frames: 4,
    fps: 6,
    loop: true,
    angleRef: path.join(ASSETS_DIR, 'bron-test-angle-2.png'),
    portrait: path.join(ASSETS_DIR, 'bron-testfull.png'),
    buildPrompt(n) {
      return [
        `Generate a ${n}-frame pixel art sprite sheet of a male basketball player in a LOOPING IDLE STANCE.`,
        ``,
        BRON_IDENTITY,
        ``,
        PIXEL_ANCHOR,
        ``,
        `ORIENTATION: Character faces LEFT. Side-profile view. Same angle in all ${n} frames.`,
        ``,
        `ANIMATION — IDLE LOOP (${n} frames):
This is a subtle breathing / weight-shift cycle. No basketball.
(1) Standing upright, weight centered, arms relaxed at sides.
(2) Slight exhale — shoulders drop 1-2px, knees very slightly bent.
(3) Weight shifts subtly to left foot — left hip rises 1px. Arms hang naturally.
(4) Returns toward neutral. Completing the loop back to frame 1.
Each frame must look visibly different from adjacent frames — no frozen poses.
No basketball in any frame. Hands free.`,
        ``,
        BG,
        ``,
        STRIP(n),
      ].join('\n\n');
    },
  },

  dribble: {
    frames: 8,
    fps: 10,
    loop: true,
    angleRef: path.join(ASSETS_DIR, 'bron-test-angle-2.png'),
    portrait: path.join(ASSETS_DIR, 'bron-testfull.png'),
    buildPrompt(n) {
      return [
        `Generate an ${n}-frame pixel art sprite sheet of a male basketball player doing a RUNNING DRIBBLE.`,
        ``,
        BRON_IDENTITY,
        ``,
        PIXEL_ANCHOR,
        ``,
        `ORIENTATION: Character faces LEFT. Strict side-profile view. Same angle in ALL ${n} frames.`,
        ``,
        `ANIMATION — RUNNING DRIBBLE, side-profile left-facing (${n} frames):
Full run cycle while dribbling. Ball alternates HIGH (waist) and LOW (floor).

(1) Right heel strikes. Ball HIGH at waist. Left arm back.
(2) Right foot flat. Ball DROPS toward floor.
(3) Mid-stride. Ball hits FLOOR at ground level.
(4) Left heel strikes. Ball BOUNCES UP rising fast.
(5) Left foot flat. Ball HIGH at waist again.
(6) Left toe push-off. Ball DROPS again.
(7) Airborne — both feet off ground. Ball mid-drop.
(8) Right foot landing. Ball low near floor. Loop completes.

Ball: orange basketball with black seams. Visible in ALL ${n} frames. Always to the right of body (dribble hand side). HIGH-at-waist vs LOW-at-floor alternates with stride.`,
        ``,
        BG,
        ``,
        STRIP(n),
      ].join('\n\n');
    },
  },
};

// ─── TASK-6003: breezy jump ───────────────────────────────────────────────────

const BREEZY_IDENTITY = `CHARACTER (identical in every frame):
Female basketball player — brown skin, long dark braids, athletic build.
White jersey with number 11, pink/magenta trim. White shorts, pink trim. Purple sneakers.
16-bit pixel art, GBA style, bold BLACK pixel outlines.`;

const JUMP_TARGET = {
  frames: 5,
  fps: 8,
  loop: false,
  portrait: path.join(ASSETS_DIR, 'breezyfull.png'),
  angleRef: path.join(ASSETS_DIR, 'breezy-angle-2.png'),
  buildPrompt(n) {
    return [
      `Generate a ${n}-frame pixel art sprite sheet of a female basketball player doing a VERTICAL JUMP (no basketball).`,
      ``,
      BREEZY_IDENTITY,
      ``,
      PIXEL_ANCHOR,
      ``,
      `ORIENTATION: Character faces LEFT. Side-profile view. Same angle in ALL ${n} frames.`,
      ``,
      `ANIMATION — VERTICAL JUMP ARC (${n} frames, NOT looping):
This is a clean jump sequence with a visible arc from crouch to peak to land.
Each frame must show a CLEARLY DIFFERENT body position.

(1) CROUCH — knees bent, body lowered, arms swinging back. Feet on ground.
(2) TAKEOFF — legs pushing off, body rising, arms sweeping forward-up. One or both feet leaving ground.
(3) PEAK — fully airborne, body at maximum height, arms raised. Feet well off the ground.
(4) DESCENT — body falling, arms lowering. Feet below peak, approaching ground.
(5) LAND — feet hit ground, knees absorb impact, body slightly crouched.

CRITICAL — ARC RULES:
- The character's vertical position MUST change across frames: low in f1, higher in f2, highest in f3, lower in f4, back to ground in f5.
- Do NOT draw the same height in multiple frames.
- NO basketball in any frame. Hands free.
- NO black artifacts or corrupted pixels.`,
      ``,
      BG,
      ``,
      STRIP(n),
    ].join('\n\n');
  },
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function generate(taskId, charName, animName, target) {
  const client = new NanaBananaClient({ model: MODEL });
  const rawPath = path.join(RAW_DIR, `${charName}-${animName}-task-raw.png`);
  const outputName = `${charName}-${animName}`;

  console.log(`\n[${taskId}] ${charName}-${animName} — ${target.frames}f, model: ${MODEL}`);

  // Use angleRef as pose ref (Image 1), portrait as char ref (Image 2)
  const poseRef = target.angleRef || null;

  await client.generateSprite(target.buildPrompt(target.frames), poseRef, target.portrait, {
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL,
    outputPath: rawPath,
  });

  const rawMeta = await sharp(rawPath).metadata();
  const frameWidth = Math.floor(rawMeta.width / target.frames);
  console.log(`[${taskId}] Raw: ${rawMeta.width}×${rawMeta.height}, frameWidth: ${frameWidth}`);

  await processSprite(rawPath, outputName, {
    frameCount: target.frames,
    frameWidth,
    frameHeight: rawMeta.height,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  const finalPath = path.join(ASSETS_DIR, `${outputName}.png`);
  const finalMeta = await sharp(finalPath).metadata();
  const actualFrames = Math.round(finalMeta.width / 180);

  // QC
  const framesDir = path.join(ASSETS_DIR, `${outputName}-frames`);
  const framePaths = fs.readdirSync(framesDir).sort().map(f => path.join(framesDir, f));
  const qc = await evaluateStrip(framePaths);

  console.log(`[${taskId}] ✓ ${outputName}.png — ${finalMeta.width}×${finalMeta.height}, ${actualFrames}f`);
  console.log(`[${taskId}] QC: ${qc.overallScore}/100 ${qc.passed ? 'PASSED' : 'FAILED'} | fill: ${qc.medianFill}%`);
  if (qc.issues.length) qc.issues.forEach(i => console.log(`[${taskId}]   [${i.severity}] ${i.msg}`));

  return {
    taskId, charName, animName,
    outputPath: finalPath,
    frames: actualFrames,
    width: finalMeta.width,
    height: finalMeta.height,
    qcScore: qc.overallScore,
    qcPassed: qc.passed,
    qcMedianFill: qc.medianFill,
    qcIssues: qc.issues,
    error: null,
  };
}

async function main() {
  const tasks = [
    ['TASK-6002a', 'bron-test', 'idle',    BRON_TARGETS.idle],
    ['TASK-6002b', 'bron-test', 'dribble', BRON_TARGETS.dribble],
    ['TASK-6003',  'breezy',   'jump',    JUMP_TARGET],
  ];

  const results = [];
  for (const [taskId, charName, animName, target] of tasks) {
    try {
      results.push(await generate(taskId, charName, animName, target));
    } catch (err) {
      console.error(`[${taskId}] FAILED: ${err.message}`);
      results.push({ taskId, charName, animName, error: err.message });
    }
  }

  console.log('\n─── Summary ──────────────────────────────────────────');
  for (const r of results) {
    if (!r.error) {
      const status = r.qcPassed ? 'PASSED' : 'FAILED';
      console.log(`  ${r.qcPassed ? '✓' : '✗'} ${r.taskId} ${r.charName}-${r.animName}.png — ${r.qcScore}/100 ${status} (${r.frames}f, ${r.width}×${r.height}, fill ${r.qcMedianFill}%)`);
    } else {
      console.log(`  ✗ ${r.taskId} ${r.charName}-${r.animName} — ${r.error}`);
    }
  }
  console.log('──────────────────────────────────────────────────────');

  if (results.some(r => r.error)) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
