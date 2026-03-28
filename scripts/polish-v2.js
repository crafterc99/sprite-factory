#!/usr/bin/env node
/**
 * polish-v2.js
 *
 * Pixel-anchored regeneration for ANIMATION-001 and ANIMATION-002.
 *
 * Critical prompt fix: replace all percentage size language with exact pixel anchoring.
 * "feet at the very bottom edge of the 180px frame, head within 10px of top"
 * — percentage language ("fill 80-90%") is ignored by the model; pixel constraints are not.
 *
 * ANIMATION-001: breezy-dribble  70/100 → target ≥90
 *   Problems: character 55-65% fill, green artifacts frames 3-4
 *
 * ANIMATION-002: breezy-walk     80/100 → target ≥90
 *   Problems: cursor artifact frame 7, some near-identical frames
 *
 * Usage:
 *   node scripts/polish-v2.js dribble
 *   node scripts/polish-v2.js walk
 *   node scripts/polish-v2.js dribble walk
 */

'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { processSprite } = require('../lib/sprite-processor/index');

const ASSETS_DIR = path.resolve(__dirname, '../data/assets');
const RAW_DIR    = path.resolve(__dirname, '../data/raw-sprites');
const PORTRAIT   = path.join(ASSETS_DIR, 'breezyfull.png');
const MODEL      = process.env.SPRITE_MODEL || 'gemini-2.5-flash-image';

// ─── Shared blocks ────────────────────────────────────────────────────────────

const IDENTITY = `CHARACTER (identical in every frame):
Female basketball player — brown skin, long dark braids, athletic build.
White jersey with number 11, pink/magenta trim. White shorts, pink trim. Purple sneakers.
16-bit pixel art, GBA style, bold BLACK pixel outlines on the character.`;

// KEY FIX: pixel anchoring, not percentages
const PIXEL_ANCHOR = `SIZE — PIXEL-EXACT ANCHORING (most critical rule):
The character is drawn inside a 180×180 pixel square frame.
- The character's feet must touch the BOTTOM EDGE of the frame (pixel row 175–180).
- The character's head must reach within 10 pixels of the TOP of the frame (pixel row 0–10).
- The full body — head, torso, legs, feet — must be visible. No cropping.
- The character must be TALL. If the character looks small or leaves large empty space above or below, this is wrong.
Do not leave empty space at the bottom of the frame. Do not leave empty space at the top.`;

const BG_CLEAN = `BACKGROUND (production-critical):
Every non-character pixel must be solid bright green (#00FF00).
No partial green on character outlines or limbs.
No black borders, no dark boxes, no frame separators, no grid lines, no vignettes.
No cursor icons, no pointer arrows, no watermarks, no overlay symbols in any frame.
The green background goes right up to the character's pixel outline — no feathering, no shadow.`;

const STRIP_OUT = (n) => `OUTPUT:
Single horizontal strip — exactly ${n} equally-sized square frames side by side.
Each frame is 180×180px. Total strip width: ${n * 180}px. Height: 180px.
No gaps between frames. No outer border around the strip.`;

// ─── Target definitions ───────────────────────────────────────────────────────

const TARGETS = {

  // ANIMATION-001: breezy-dribble
  // Problems: 55-65% fill (too small), green artifacts frames 3-4
  dribble: {
    taskId: 'ANIMATION-001',
    frames: 8,
    fps: 10,
    loop: true,
    poseRef: null, // existing breezy-dribble.png is 4096×512 (broken batch output) — text-only until regenerated
    buildPrompt(n) {
      return [
        `Generate an ${n}-frame pixel art sprite sheet of a female basketball player doing a RUNNING DRIBBLE.`,
        ``,
        IDENTITY,
        ``,
        PIXEL_ANCHOR,
        ``,
        `ORIENTATION (locked for all ${n} frames):
Character faces LEFT. Strict side-profile view. The camera is to the character's right.
Do NOT face the character toward the camera. Do NOT use a 3/4 angle. Side-profile only.`,
        ``,
        `ANIMATION — RUNNING DRIBBLE, side-profile left-facing (${n} frames):
This is a basketball player running left while simultaneously dribbling a ball.
The body follows a full run cycle. The ball bounces alongside the run rhythm.

(1) Right foot heel strikes ground. Ball is HIGH — at waist level on the right side. Left arm swings back.
(2) Right foot flat, full weight on it. Ball DROPS — moving toward floor. Body over right foot.
(3) Mid-stride transition. Ball hits FLOOR — at ground level beside right foot.
(4) Left foot heel strike. Ball BOUNCES UP from floor — rising fast. Right arm swings back.
(5) Left foot flat, full weight on it. Ball HIGH again — at waist on right side.
(6) Left toe push-off, body rising. Ball DROPS again toward floor.
(7) Both feet briefly off ground — peak of stride airborne. Ball mid-drop.
(8) Right foot landing again. Ball low near floor. Completing the loop back to frame 1.

Ball rules: Orange basketball with black seam lines. Ball visible in ALL ${n} frames. Ball is always to the right of the body (dribble hand). Ball alternates HIGH-at-waist and LOW-at-floor across the stride cycle.`,
        ``,
        BG_CLEAN,
        ``,
        STRIP_OUT(n),
      ].join('\n\n');
    },
  },

  // ANIMATION-002: breezy-walk
  // Problems: cursor artifact in frame 7, some near-identical frames
  walk: {
    taskId: 'ANIMATION-002',
    frames: 8,
    fps: 10,
    loop: true,
    poseRef: null, // text-only
    buildPrompt(n) {
      return [
        `Generate an ${n}-frame pixel art sprite sheet of a female basketball player doing a WALK CYCLE.`,
        ``,
        IDENTITY,
        ``,
        PIXEL_ANCHOR,
        ``,
        `ORIENTATION (locked for all ${n} frames):
Character faces LEFT. Strict side-profile view. The camera is to the character's right.
The same side-profile angle must be used in frame 1, frame 2, frame 3 … all the way through frame ${n}.
Do NOT rotate toward the camera at any point. Do NOT drift to 3/4 angle.`,
        ``,
        `ANIMATION — WALK CYCLE, side-profile left-facing (${n} frames):
This is a clean, readable walk. Each frame must look visibly different from the frame before it.

(1) RIGHT heel strikes. LEFT arm swings forward. Body upright. Weight on right foot.
(2) RIGHT foot flat. Weight fully on right. LEFT leg swings forward past hip. RIGHT arm back.
(3) RIGHT toe push-off. LEFT knee rises. Body lifts slightly. Arms crossing midpoint.
(4) MID-STRIDE — both feet briefly off ground. RIGHT arm forward. Body between steps.
(5) LEFT heel strikes. RIGHT arm swings forward. Body upright. Weight on left foot.
(6) LEFT foot flat. Weight fully on left. RIGHT leg swings forward past hip. LEFT arm back.
(7) LEFT toe push-off. RIGHT knee rises. Body lifts slightly. Arms crossing midpoint.
(8) MID-STRIDE — both feet off ground again. LEFT arm forward. Completing loop to frame 1.

Frame rules:
- EACH frame must show a clearly different body position from the frames before and after it.
- Arms must counterswing with legs (right arm forward when left leg is forward).
- Feet stay on the same horizontal baseline — no vertical drift between frames.
- No basketball — hands free, natural arm swing.
- NO cursor icons, NO pointer symbols, NO artifacts in frame 7 or any other frame.`,
        ``,
        BG_CLEAN,
        ``,
        STRIP_OUT(n),
      ].join('\n\n');
    },
  },
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run(key) {
  const t = TARGETS[key];
  if (!t) throw new Error(`Unknown target: ${key}. Available: ${Object.keys(TARGETS).join(', ')}`);

  const client = new NanaBananaClient({ model: MODEL });
  const rawPath = path.join(RAW_DIR, `breezy-${key}-polish2-raw.png`);
  const outputName = `breezy-${key}`;

  console.log(`\n[${t.taskId}] ${key} — ${t.frames}f, ${t.poseRef ? 'pose-transfer' : 'text-only'}`);

  if (!fs.existsSync(PORTRAIT)) throw new Error(`Portrait not found: ${PORTRAIT}`);
  if (t.poseRef && !fs.existsSync(t.poseRef)) throw new Error(`Pose ref not found: ${t.poseRef}`);

  fs.mkdirSync(RAW_DIR, { recursive: true });

  await client.generateSprite(t.buildPrompt(t.frames), t.poseRef || null, PORTRAIT, {
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL,
    outputPath: rawPath,
  });

  console.log(`[${t.taskId}] Raw → ${rawPath}`);

  const rawMeta = await sharp(rawPath).metadata();
  const frameWidth = Math.floor(rawMeta.width / t.frames);
  console.log(`[${t.taskId}] Raw dims: ${rawMeta.width}×${rawMeta.height}, frameWidth: ${frameWidth}`);

  await processSprite(rawPath, outputName, {
    frameCount: t.frames,
    frameWidth,
    frameHeight: rawMeta.height,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  const finalPath = path.join(ASSETS_DIR, `${outputName}.png`);
  const finalMeta = await sharp(finalPath).metadata();
  const actualFrames = Math.round(finalMeta.width / 180);

  console.log(`[${t.taskId}] ✓ ${finalPath} — ${finalMeta.width}×${finalMeta.height}, ${actualFrames}f`);

  if (actualFrames !== t.frames) {
    throw new Error(`Frame count mismatch: expected ${t.frames}, got ${actualFrames}`);
  }

  return { taskId: t.taskId, key, frames: actualFrames, width: finalMeta.width, height: finalMeta.height };
}

async function main() {
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : Object.keys(TARGETS);

  const invalid = targets.filter(t => !TARGETS[t]);
  if (invalid.length > 0) {
    console.error(`Unknown: ${invalid.join(', ')}. Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const key of targets) {
    try {
      results.push({ ...(await run(key)), error: null });
    } catch (err) {
      console.error(`[${key}] FAILED: ${err.message}`);
      results.push({ taskId: TARGETS[key]?.taskId, key, error: err.message });
    }
  }

  console.log('\n─── Summary ──────────────────────────────────────────');
  for (const r of results) {
    if (!r.error) console.log(`  ✓ ${r.taskId} breezy-${r.key}.png (${r.frames}f, ${r.width}×${r.height})`);
    else          console.log(`  ✗ ${r.taskId} breezy-${r.key} — ${r.error}`);
  }
  console.log('──────────────────────────────────────────────────────');

  if (results.some(r => r.error)) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
