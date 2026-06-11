/**
 * Auto Pipeline — Frame-by-frame animation generation for all characters.
 *
 * Every animation is generated one frame at a time:
 *   Image 1: character body angle reference (identity anchor)
 *   Image 2: breezy pose frame (motion reference)
 *
 * Strip mode has been eliminated. All generation is FBF.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { ANIMATIONS } = require('./sprite-generator/prompts');
const { NanaBananaClient } = require('./sprite-generator/nano-banana');
const { cutFrames, upscaleNN, removeBackground, cropToContent } = require('./sprite-processor/index');
const { recordCost } = require('../middleware/cost-tracker');

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../data/.characters.json');
const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, '../data/assets');
const RAW_DIR = process.env.RAW_DIR || path.resolve(__dirname, '../data/raw-sprites');

const MODEL = 'gemini-3.1-flash-image-preview';

const FBF_PROMPT = [
  'Keep the exact character from Image 1. Copy only the exact pose from Image 2.',
  'Do not mix faces or identities. Make sure the character\'s face does not change at all.',
  'Do not change body shape, skin tone, hairstyle, or facial structure.',
  'Match Image 2\'s full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing.',
  'Natural anatomy, no distortions.',
  'ART STYLE: render in the exact same clean anime art style as Image 1. Do NOT use pixel art, 16-bit, retro, arcade, or low-resolution styles. No pixelation, no dithering, no black pixel outlines.',
  'Pure green (#00FF00) background. Full body visible. 1:1 square frame.',
].join('\n');

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

// ─── Strip builder ────────────────────────────────────────────────────────────

async function buildStrip(framePaths, outputPath) {
  const metas = await Promise.all(framePaths.map(p => sharp(p).metadata()));
  const w = metas[0].width;
  const h = metas[0].height;
  const strip = sharp({
    create: { width: w * framePaths.length, height: h, channels: 4, background: { r:0, g:0, b:0, alpha:0 } },
  });
  const composites = framePaths.map((p, i) => ({ input: p, left: i * w, top: 0 }));
  await strip.composite(composites).png().toFile(outputPath);
}

// ─── Core FBF generation for a single animation ───────────────────────────────

/**
 * Generate one animation for one character, frame by frame.
 * @param {NanaBananaClient} client
 * @param {string} characterName
 * @param {string} animKey
 * @param {{ onFrame?: (i, total) => void }} opts
 * @returns {string} path to assembled strip
 */
async function generateAnimFBF(client, characterName, animKey, opts = {}) {
  const { onFrame } = opts;
  const anim = ANIMATIONS[animKey];
  const totalFrames = anim.frames;

  // Resolve identity anchor (Image 1) — prefer matching angle, fall back to portrait
  const angleIndex = anim.angleIndex ?? 0;
  const angleFramePath = path.join(ASSETS_DIR, `${characterName}-angle-${angleIndex}.png`);
  const portraitPath = path.join(ASSETS_DIR, `${characterName}full.png`);
  const charRef = fs.existsSync(angleFramePath) ? angleFramePath : portraitPath;

  // Resolve and cut pose frames (Image 2)
  const genDir = path.join(RAW_DIR, `${characterName}-${animKey}-fbf`);
  fs.mkdirSync(genDir, { recursive: true });

  let poseFramePaths = [];
  if (anim.breezyFile) {
    const poseRefPath = path.join(ASSETS_DIR, anim.breezyFile);
    if (fs.existsSync(poseRefPath)) {
      const framesDir = path.join(genDir, 'pose-frames');
      fs.mkdirSync(framesDir, { recursive: true });
      const cutResult = await cutFrames(poseRefPath, framesDir, { frameCount: totalFrames });
      // Upscale each pose frame to 512×512
      const upDir = path.join(genDir, 'pose-upscaled');
      fs.mkdirSync(upDir, { recursive: true });
      for (let i = 0; i < cutResult.frames.length && i < totalFrames; i++) {
        const upPath = path.join(upDir, `frame-${String(i).padStart(3,'0')}.png`);
        await upscaleNN(cutResult.frames[i], upPath, { width: 512, height: 512 });
        poseFramePaths.push(upPath);
      }
    }
  }

  // Generate each frame
  const processedPaths = [];
  for (let i = 0; i < totalFrames; i++) {
    if (onFrame) onFrame(i, totalFrames);

    const refImages = [charRef];
    if (poseFramePaths[i]) refImages.push(poseFramePaths[i]);

    const result = await client.generate(FBF_PROMPT, {
      referenceImages: refImages,
      aspectRatio: '1:1',
      resolution: '1K',
      model: MODEL,
      maxRetries: 2,
      timeoutMs: 90000,
    });

    const rawPath = path.join(genDir, `raw-${i}.png`);
    fs.writeFileSync(rawPath, result.imageBuffer);
    recordCost(MODEL, 'fbf_frame', '1K', refImages.length, { character: characterName, animation: animKey, frame: i });

    // Process: remove bg, crop, scale to 180×180
    const processedPath = path.join(genDir, `frame-${i}.png`);
    await removeBackground(rawPath, rawPath);
    await cropToContent(rawPath, processedPath, { width: 180, height: 180, padding: 10 });
    processedPaths.push(processedPath);
  }

  // Assemble horizontal strip
  const stripPath = path.join(ASSETS_DIR, `${characterName}-${animKey}.png`);
  await buildStrip(processedPaths, stripPath);
  return stripPath;
}

// ─── runAutoPipeline ─────────────────────────────────────────────────────────

async function runAutoPipeline(characterName) {
  const chars = loadCharacters();
  const char = chars[characterName];
  if (!char) throw new Error(`Character '${characterName}' not found in registry`);

  const missing = [];
  if (!(char.anchor && char.anchor.status === 'complete')) missing.push('body angles');
  if (!char.headshotAnglesComplete) missing.push('headshot angles');
  if (!char.clothesAnglesComplete) missing.push('clothes angles');
  if (missing.length > 0) {
    throw new Error(`Cannot run pipeline for '${characterName}' — incomplete assets: ${missing.join('; ')}`);
  }

  const client = new NanaBananaClient({ model: MODEL });
  const animationsGenerated = [];
  const failed = [];

  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });

  for (const animKey of Object.keys(ANIMATIONS)) {
    console.log(`[auto-pipeline] FBF ${animKey} for ${characterName}…`);
    try {
      await generateAnimFBF(client, characterName, animKey);
      animationsGenerated.push(animKey);
    } catch (err) {
      console.error(`[auto-pipeline] failed ${animKey}:`, err.message);
      failed.push({ animKey, error: err.message });
    }
  }

  const updatedChars = loadCharacters();
  if (updatedChars[characterName]) {
    updatedChars[characterName].studioReady = true;
    updatedChars[characterName].pipelineCompletedAt = new Date().toISOString();
    saveCharacters(updatedChars);
  }

  return { character: characterName, animationsGenerated, failed, studioReady: true };
}

// ─── fillGaps ────────────────────────────────────────────────────────────────

async function fillGaps(characterName, opts = {}) {
  const { onProgress } = opts;
  const emit = (event, data) => { if (onProgress) onProgress(event, data); };

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
    try {
      await generateAnimFBF(client, characterName, animKey, {
        onFrame: (i, total) => emit('frame', { animKey, frame: i, total }),
      });
      generated.push(animKey);
      emit('anim_done', { animKey, url: `/assets/${characterName}-${animKey}.png` });
    } catch (err) {
      failed.push({ animKey, error: err.message });
      emit('anim_error', { animKey, error: err.message });
    }
  }

  const chars = loadCharacters();
  if (chars[characterName]) {
    chars[characterName].studioReady = true;
    chars[characterName].pipelineCompletedAt = new Date().toISOString();
    saveCharacters(chars);
  }

  emit('complete', { character: characterName, generated, skipped, failed });
  return { character: characterName, generated, skipped, failed, studioReady: true };
}

module.exports = { runAutoPipeline, fillGaps, generateAnimFBF };
