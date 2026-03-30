/**
 * Auto Pipeline — Runs the full animation generation pipeline for a character.
 *
 * Triggered automatically after all three asset sets (body angles, headshot angles,
 * clothes angles) are confirmed complete. Can also be triggered manually via
 * POST /api/pipeline/run.
 *
 * Uses gemini-2.5-flash-image. Do NOT switch to gemini-3-pro-image-preview — it
 * returns 500 errors.
 */
const fs = require('fs');
const path = require('path');
const { ANIMATIONS, buildPoseTransferPrompt, buildTextOnlyAnimPrompt } = require('./sprite-generator/prompts');
const { NanaBananaClient } = require('./sprite-generator/nano-banana');
const { processSprite } = require('./sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../data/.characters.json');
const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, '../data/assets');
const RAW_DIR = process.env.RAW_DIR || path.resolve(__dirname, '../data/raw-sprites');

const MODEL = 'gemini-2.5-flash-image';

// All animation keys from ANIMATIONS in lib/sprite-generator/prompts.js.
// Kept as a local constant so auto-pipeline.js has no runtime dependency on the
// full prompts module shape.
const ALL_ANIM_KEYS = Object.keys(ANIMATIONS);

// ─── Registry Helpers ────────────────────────────────────────────────────────

function loadCharacters() {
  try {
    if (fs.existsSync(CHARACTERS_FILE)) return JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveCharacters(data) {
  const dir = path.dirname(CHARACTERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(data, null, 2));
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runAutoPipeline(characterName) {
  // 1. Load character record
  const chars = loadCharacters();
  const char = chars[characterName];
  if (!char) throw new Error(`Character '${characterName}' not found in registry`);

  // 2. Check all three asset sets are complete before proceeding
  const missing = [];
  if (!(char.anchor && char.anchor.status === 'complete')) missing.push('body angles (anchor.status !== complete)');
  if (!char.headshotAnglesComplete) missing.push('headshot angles (headshotAnglesComplete not set)');
  if (!char.clothesAnglesComplete) missing.push('clothes angles (clothesAnglesComplete not set)');
  if (missing.length > 0) {
    throw new Error(`Cannot run pipeline for '${characterName}' — incomplete assets: ${missing.join('; ')}`);
  }

  // 3. TODO: No /api/package/build route exists — package build step skipped.
  //    If a package build route is added in the future, call it here before
  //    starting animation generation.

  const portraitPath = path.join(ASSETS_DIR, `${characterName}full.png`);
  const client = new NanaBananaClient({ model: MODEL });

  const animationsGenerated = [];
  const failed = [];

  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });

  // 4. Generate every animation sequentially to avoid overwhelming the Gemini API
  for (const animKey of ALL_ANIM_KEYS) {
    console.log(`[auto-pipeline] generating ${animKey} for ${characterName}...`);

    const anim = ANIMATIONS[animKey];
    if (!anim) {
      failed.push({ animKey, error: 'Unknown animation key — not present in ANIMATIONS map' });
      continue;
    }

    try {
      const totalFrames = anim.frames;
      const charRef = fs.existsSync(portraitPath) ? portraitPath : null;
      const poseRefCandidate = anim.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;
      const poseRef = poseRefCandidate && fs.existsSync(poseRefCandidate) ? poseRefCandidate : null;

      let prompt;
      if (poseRef) {
        const data = buildPoseTransferPrompt(characterName, animKey);
        prompt = data.prompt;
      } else {
        const data = buildTextOnlyAnimPrompt(characterName, animKey);
        prompt = data.prompt;
      }

      const rawOutputPath = path.join(RAW_DIR, `${characterName}-${animKey}-raw.png`);
      await client.generateSprite(prompt, poseRef, charRef, {
        aspectRatio: '16:9',
        resolution: '2K',
        model: MODEL,
        outputPath: rawOutputPath,
      });

      recordCost(MODEL, 'strip', '2K', (poseRef ? 1 : 0) + (charRef ? 1 : 0), {
        character: characterName,
        animation: animKey,
      });

      await processSprite(rawOutputPath, `${characterName}-${animKey}`, {
        frameCount: totalFrames,
        targetSize: 180,
        outputDir: ASSETS_DIR,
      });

      // 5. Confirm strip PNG written to disk
      const stripPath = path.join(ASSETS_DIR, `${characterName}-${animKey}.png`);
      if (!fs.existsSync(stripPath)) {
        throw new Error(`Strip not found on disk after generation: ${stripPath}`);
      }
      console.log(`[auto-pipeline] saved ${stripPath}`);
      animationsGenerated.push(animKey);

    } catch (err) {
      console.error(`[auto-pipeline] failed ${animKey} for ${characterName}:`, err.message);
      failed.push({ animKey, error: err.message });
      // Continue — one failed animation does not abort the pipeline
    }
  }

  // 6. Mark character as studio-ready in registry
  const updatedChars = loadCharacters();
  if (updatedChars[characterName]) {
    updatedChars[characterName].studioReady = true;
    updatedChars[characterName].pipelineCompletedAt = new Date().toISOString();
    saveCharacters(updatedChars);
  }

  console.log(
    `[auto-pipeline] complete for ${characterName} — ` +
    `${animationsGenerated.length} generated, ${failed.length} failed`
  );

  // 7. Return summary
  return {
    character: characterName,
    animationsGenerated,
    failed,
    studioReady: true,
  };
}

/**
 * fillGaps — Generate only animations missing on disk for a character.
 * Uses breezy pose-transfer where available, text-only otherwise.
 * No asset-completion check — safe to call at any time.
 * @param {string} characterName
 * @param {{ onProgress?: (event: string, data: object) => void }} opts
 */
async function fillGaps(characterName, opts = {}) {
  const { onProgress } = opts;
  const emit = (event, data) => { if (onProgress) onProgress(event, data); };

  const portraitPath = path.join(ASSETS_DIR, `${characterName}full.png`);
  const client = new NanaBananaClient({ model: MODEL });
  const generated = [];
  const skipped = [];
  const failed = [];

  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const keys = Object.keys(ANIMATIONS);
  emit('start', { character: characterName, total: keys.length });

  for (const animKey of keys) {
    const stripPath = path.join(ASSETS_DIR, `${characterName}-${animKey}.png`);
    if (fs.existsSync(stripPath)) {
      skipped.push(animKey);
      emit('skip', { animKey, reason: 'already exists' });
      continue;
    }

    emit('anim_start', { animKey });
    const anim = ANIMATIONS[animKey];

    try {
      const charRef = fs.existsSync(portraitPath) ? portraitPath : null;
      const poseRefCandidate = anim.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;
      const poseRef = poseRefCandidate && fs.existsSync(poseRefCandidate) ? poseRefCandidate : null;

      const promptData = poseRef
        ? buildPoseTransferPrompt(characterName, animKey)
        : buildTextOnlyAnimPrompt(characterName, animKey);

      const rawOutputPath = path.join(RAW_DIR, `${characterName}-${animKey}-raw.png`);
      await client.generateSprite(promptData.prompt, poseRef, charRef, {
        aspectRatio: '16:9',
        resolution: '2K',
        model: MODEL,
        outputPath: rawOutputPath,
      });

      recordCost(MODEL, 'strip', '2K', (poseRef ? 1 : 0) + (charRef ? 1 : 0), {
        character: characterName, animation: animKey,
      });

      await processSprite(rawOutputPath, `${characterName}-${animKey}`, {
        frameCount: anim.frames,
        targetSize: 180,
        outputDir: ASSETS_DIR,
      });

      if (!fs.existsSync(stripPath)) throw new Error('Strip missing after generation');
      generated.push(animKey);
      emit('anim_done', { animKey, url: `/assets/${characterName}-${animKey}.png` });
    } catch (err) {
      failed.push({ animKey, error: err.message });
      emit('anim_error', { animKey, error: err.message });
    }
  }

  // Mark studio-ready
  const chars = loadCharacters();
  if (chars[characterName]) {
    chars[characterName].studioReady = true;
    chars[characterName].pipelineCompletedAt = new Date().toISOString();
    saveCharacters(chars);
  }

  emit('complete', { character: characterName, generated, skipped, failed });
  return { character: characterName, generated, skipped, failed, studioReady: true };
}

module.exports = { runAutoPipeline, fillGaps };
