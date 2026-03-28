#!/usr/bin/env node
/**
 * regen-animations.js
 *
 * Targeted full-regen for QC-failed animations.
 * Each animation has a precisely engineered prompt addressing the specific failure.
 *
 * REGEN-001  breezy-dribble  Score 18/100 → side-profile, size, running cycle, ball present
 * REGEN-002  breezy-steal    Score 32/100 → consistent angle, coherent 3-frame sequence
 * REGEN-003  breezy-walk     Score 28/100 → side-profile locked, size, walk cycle
 * REGEN-004  breezy-jump     Score 42/100 → black artifact elimination, identity frame 1
 * POLISH-003 breezy-idle     Score 82/100 → visible per-frame difference at small scale
 *
 * Usage:
 *   node scripts/regen-animations.js dribble
 *   node scripts/regen-animations.js walk steal
 *   node scripts/regen-animations.js dribble walk steal jump idle
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
const MODEL      = 'gemini-2.5-flash-image';

// ─── Character identity block reused across all prompts ───────────────────────
const IDENTITY = `CHARACTER IDENTITY (must be consistent in EVERY frame):
- Female basketball player, brown skin, long dark braids
- White basketball jersey with #11, pink/magenta trim
- White shorts with pink trim, purple sneakers
- Athletic build, medium height
- 16-bit pixel art, GBA style, bold BLACK pixel outlines`;

const SIZE_RULE = `⚠️ SIZE — MOST CRITICAL RULE:
- Character must fill 80–90% of each frame's HEIGHT
- At 180px tall frame: character body should span ~145–162px
- Head near top of frame, feet near bottom baseline
- A small character (filling less than 60% of height) is an AUTOMATIC FAILURE
- Lock character scale — same height in EVERY frame`;

const BG_RULE = `BACKGROUND + OUTPUT:
- Solid bright green (#00FF00) background — NO black, NO dark, NO borders, NO boxes
- NO green on the character itself
- NO cursor artifacts, overlays, or watermarks
- NO anti-aliasing on background edges`;

// ─── Regen Definitions ────────────────────────────────────────────────────────

const REGENS = {

  // REGEN-001: breezy-dribble
  // Failures: front-facing (needs side-profile), size ~40%, cursor artifact, no run cycle
  dribble: {
    id: 'REGEN-001',
    frames: 8,
    fps: 10,
    loop: true,
    poseRef: path.join(ASSETS_DIR, 'breezy-dribble.png'),
    buildPrompt(frames) {
      return [
        `Generate a ${frames}-frame pixel art sprite sheet of a female basketball player doing a RUNNING DRIBBLE.`,
        ``,
        IDENTITY,
        ``,
        `⚠️ ORIENTATION — SECOND MOST CRITICAL RULE:`,
        `- Character faces LEFT — SIDE PROFILE view throughout ALL ${frames} frames`,
        `- This is a SIDE-SCROLLING game sprite — character moves LEFT across the screen`,
        `- Do NOT face the character toward the camera (front-facing is WRONG)`,
        `- Do NOT rotate to 3/4 angle — strict side profile, facing left`,
        ``,
        SIZE_RULE,
        ``,
        `ANIMATION — RUNNING DRIBBLE (${frames} frames, left-facing side profile):`,
        `This is a full run cycle where the character simultaneously runs and dribbles a basketball.`,
        `Frame breakdown:`,
        `(1) Right foot forward, ball HIGH at waist — left arm back for balance`,
        `(2) Right foot pushing off, ball DESCENDING — stride continues`,
        `(3) Both feet off ground MID-STRIDE — ball hitting/near floor`,
        `(4) Left foot forward, ball BOUNCING UP — right arm back`,
        `(5) Left foot pushing off, ball RISING — stride continues`,
        `(6) Both feet off ground MID-STRIDE — ball at waist height`,
        `(7) Right foot landing, ball HIGH — run cycle repeats`,
        `(8) Weight on right foot, ball DESCENDING — completing loop`,
        ``,
        `BALL RULES:`,
        `- Basketball must be visible in ALL ${frames} frames`,
        `- Ball alternates HIGH (waist level) and LOW (near floor) as character runs`,
        `- Ball is orange with black seam lines, ~12px diameter at 180px scale`,
        `- Ball is on the RIGHT side of the character (dribble hand facing left)`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} equally-sized frames, no gaps, no borders`,
        ``,
        BG_RULE,
      ].join('\n');
    },
  },

  // REGEN-003: breezy-walk
  // Failures: 25-35% fill, angle drifts from side to front across 8 frames
  walk: {
    id: 'REGEN-003',
    frames: 8,
    fps: 10,
    loop: true,
    poseRef: null, // text-only — no reliable pose ref exists
    buildPrompt(frames) {
      return [
        `Generate an ${frames}-frame pixel art sprite sheet of a female basketball player doing a WALK CYCLE.`,
        ``,
        IDENTITY,
        ``,
        `⚠️ ORIENTATION — SECOND MOST CRITICAL RULE:`,
        `- Character faces LEFT — SIDE PROFILE view throughout ALL ${frames} frames`,
        `- This is a SIDE-SCROLLING game sprite`,
        `- Do NOT rotate toward camera at any frame — side profile locked for ALL ${frames} frames`,
        `- Frames 1–8 must all use the exact same camera angle`,
        ``,
        SIZE_RULE,
        ``,
        `ANIMATION — WALK CYCLE (${frames} frames, left-facing side profile):`,
        `Frame breakdown:`,
        `(1) Right heel strike — left arm swings forward`,
        `(2) Right foot flat, weight transferring forward — body upright`,
        `(3) Right foot toe-off, body slightly elevated — arms cross mid-swing`,
        `(4) Mid-stride — both feet briefly off ground, right arm forward`,
        `(5) Left heel strike — right arm swings forward`,
        `(6) Left foot flat, weight transferring — body upright`,
        `(7) Left foot toe-off, body slightly elevated — arms cross mid-swing`,
        `(8) Mid-stride — both feet briefly off ground, completing loop`,
        ``,
        `POSE RULES:`,
        `- Arms counterswing with legs — right arm forward when left leg forward`,
        `- Feet stay on the same horizontal baseline across all ${frames} frames`,
        `- No ball — hands free, natural arm swing`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} equally-sized frames, no gaps, no borders`,
        ``,
        BG_RULE,
      ].join('\n');
    },
  },

  // REGEN-002: breezy-steal
  // Failures: angle incoherence across 3 frames, rendering style mismatch, size
  steal: {
    id: 'REGEN-002',
    frames: 3,
    fps: 8,
    loop: false,
    poseRef: null, // text-only — past pose ref produced incoherence
    buildPrompt(frames) {
      return [
        `Generate a ${frames}-frame pixel art sprite sheet of a female basketball player making a STEAL ATTEMPT.`,
        ``,
        IDENTITY,
        ``,
        `⚠️ ANGLE LOCK — ALL ${frames} FRAMES MUST USE THE SAME CAMERA ANGLE:`,
        `- Use 3/4 front-diagonal view (character facing slightly toward camera + left)`,
        `- Frame 1, Frame 2, Frame 3 — identical camera angle, no rotation between frames`,
        `- If even one frame uses a different angle, this is a FAILURE`,
        ``,
        SIZE_RULE,
        ``,
        `ANIMATION — STEAL ATTEMPT (${frames} frames, 3/4 front view):`,
        `(1) READY STANCE: Athletic defensive crouch, knees bent, weight low, arms out — anticipation pose`,
        `(2) LUNGE: Explosive lunge forward, right arm shooting out to SWIPE at an imaginary ball — full reach, body leaning hard forward`,
        `(3) FOLLOW-THROUGH: Arm extended, body recovering from lunge, weight shifting back to balance`,
        ``,
        `IDENTITY RULES (CRITICAL — enforced per frame):`,
        `- Same face, same skin tone, same dark braids in frame 1, 2, AND 3`,
        `- Same rendering style across all frames — do NOT switch pixel detail level`,
        `- Same build and proportions — do NOT change body type between frames`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} equally-sized frames, no gaps, no borders`,
        ``,
        BG_RULE,
      ].join('\n');
    },
  },

  // REGEN-004: breezy-jump
  // Failures: black rectangular border artifacts around all 5 frames, frame 1 identity mismatch
  jump: {
    id: 'REGEN-004',
    frames: 5,
    fps: 8,
    loop: false,
    poseRef: null, // text-only — cleaner than retrying with artifact ref
    buildPrompt(frames) {
      return [
        `Generate a ${frames}-frame pixel art sprite sheet of a female basketball player doing a VERTICAL JUMP.`,
        ``,
        IDENTITY,
        ``,
        `⚠️ BACKGROUND — PRODUCTION CRITICAL:`,
        `- The background MUST be solid flat green (#00FF00) and NOTHING ELSE`,
        `- NO black borders, NO dark boxes, NO rectangular outlines around frames`,
        `- NO frame separators, NO grid lines, NO shadows`,
        `- This output goes directly into a chroma-key pipeline — any non-green background pixel will corrupt the output`,
        ``,
        `⚠️ IDENTITY — SAME CHARACTER ALL ${frames} FRAMES:`,
        `- Every frame: dark braids, brown skin, white #11 jersey, purple sneakers`,
        `- Do NOT change hair style or color between frames`,
        `- Same rendering style (pixel detail level) in ALL ${frames} frames`,
        ``,
        SIZE_RULE,
        ``,
        `ANIMATION — VERTICAL JUMP (${frames} frames, FRONT-FACING):`,
        `- Character faces TOWARD the camera — front view — this is correct for jump`,
        `(1) Deep crouch: knees sharply bent, torso leaning forward, arms pulled back`,
        `(2) Launch: legs fully extending, arms swinging upward, toes leaving ground`,
        `(3) PEAK: Both feet clearly off ground, body at maximum height, arms raised`,
        `(4) Descent: body dropping, legs extending downward, arms lowering`,
        `(5) Landing: knees bent absorbing impact, both feet on ground, arms out`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} equally-sized frames, no gaps, no borders`,
        `- Solid green (#00FF00) fills every non-character pixel — no exceptions`,
        ``,
        BG_RULE,
      ].join('\n');
    },
  },

  // POLISH-003: breezy-idle
  // Issue: near-static — frames show negligible visual difference at 52px preview
  idle: {
    id: 'POLISH-003',
    frames: 4,
    fps: 6,
    loop: true,
    poseRef: null,
    buildPrompt(frames) {
      return [
        `Generate a ${frames}-frame pixel art sprite sheet of a female basketball player in an IDLE BREATHING animation.`,
        ``,
        IDENTITY,
        ``,
        SIZE_RULE,
        ``,
        `⚠️ MOTION VISIBILITY — CRITICAL FOR THIS ANIMATION:`,
        `- This animation plays at 6fps at 52×52px preview size`,
        `- Each frame MUST show a clearly different visual state from adjacent frames`,
        `- Subtle pixel-level differences are NOT enough — the changes must be obvious`,
        `- Think of this as a 4-pose sequence, each one clearly different`,
        ``,
        `ANIMATION — IDLE (${frames} frames, FRONT-FACING):`,
        `Character stands still but shows clear life through exaggerated breathing and weight shift.`,
        `(1) EXHALE LOW: Neutral stance, weight centered, shoulders slightly dropped, arms relaxed at sides, slight head tilt down`,
        `(2) INHALE PEAK: Chest visibly raised, shoulders up, torso expands, head level, slight lean back — clear UPWARD shift vs frame 1`,
        `(3) SETTLE: Weight shifts LEFT, left hip out, right knee slightly bent, arms relaxed — clear SIDEWAYS shift vs frame 2`,
        `(4) SETTLE RIGHT: Weight shifts RIGHT, right hip out, left knee slightly bent, slight head tilt — mirror of frame 3, clear difference`,
        ``,
        `CHARACTER stays fully stationary — feet planted, no walking or running.`,
        `The ONLY movement is breathing (chest rise) and weight shift (hip sway).`,
        `Each frame transition must be readable at 52px size.`,
        ``,
        `OUTPUT:`,
        `- Single horizontal strip, EXACTLY ${frames} equally-sized frames, no gaps, no borders`,
        ``,
        BG_RULE,
      ].join('\n');
    },
  },
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runRegen(key) {
  const r = REGENS[key];
  if (!r) throw new Error(`Unknown target: ${key}. Available: ${Object.keys(REGENS).join(', ')}`);

  const client = new NanaBananaClient({ model: MODEL });
  const rawPath = path.join(RAW_DIR, `breezy-${key}-regen-raw.png`);
  const outputName = `breezy-${key}`;

  console.log(`\n[${r.id}] ${key} — ${r.frames}f, ${r.poseRef ? 'pose-transfer' : 'text-only'} mode`);

  if (!fs.existsSync(PORTRAIT)) throw new Error(`Portrait not found: ${PORTRAIT}`);
  if (r.poseRef && !fs.existsSync(r.poseRef)) throw new Error(`Pose ref not found: ${r.poseRef}`);

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const prompt = r.buildPrompt(r.frames);

  // Portrait is always passed as character reference (Image 1 or Image 2 depending on mode)
  await client.generateSprite(prompt, r.poseRef || null, PORTRAIT, {
    aspectRatio: '16:9',
    resolution: '2K',
    model: MODEL,
    outputPath: rawPath,
  });

  console.log(`[${r.id}] Raw saved → ${rawPath}`);
  console.log(`[${r.id}] Processing...`);

  const rawMeta = await sharp(rawPath).metadata();
  const frameWidth = Math.floor(rawMeta.width / r.frames);

  const processed = await processSprite(rawPath, outputName, {
    frameCount: r.frames,
    frameWidth,
    frameHeight: rawMeta.height,
    targetSize: 180,
    outputDir: ASSETS_DIR,
  });

  const finalPath = path.join(ASSETS_DIR, `${outputName}.png`);
  const finalMeta = await sharp(finalPath).metadata();
  const actualFrames = Math.round(finalMeta.width / 180);

  console.log(`[${r.id}] ✓ ${finalPath} — ${finalMeta.width}×${finalMeta.height}, ${actualFrames}f @ 180px`);

  return {
    id: r.id,
    key,
    frames: actualFrames,
    expectedFrames: r.frames,
    width: finalMeta.width,
    height: finalMeta.height,
    path: finalPath,
    ok: actualFrames === r.frames,
  };
}

async function main() {
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : Object.keys(REGENS);

  const invalid = targets.filter(t => !REGENS[t]);
  if (invalid.length > 0) {
    console.error(`Unknown targets: ${invalid.join(', ')}`);
    process.exit(1);
  }

  console.log(`Regen: ${targets.map(t => `${REGENS[t].id}(${t})`).join(', ')}`);

  const results = [];
  for (const key of targets) {
    try {
      const result = await runRegen(key);
      results.push({ ...result, error: null });
    } catch (err) {
      console.error(`[${key}] FAILED: ${err.message}`);
      results.push({ id: REGENS[key]?.id, key, ok: false, error: err.message });
    }
  }

  console.log('\n─── Summary ─────────────────────────────────────────');
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.id} breezy-${r.key}.png (${r.frames}f, ${r.width}×${r.height})`);
    } else {
      console.log(`  ✗ ${r.id} breezy-${r.key} — ${r.error || `frame count mismatch: got ${r.frames}, expected ${r.expectedFrames}`}`);
    }
  }
  console.log('─────────────────────────────────────────────────────');

  if (results.some(r => !r.ok)) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
