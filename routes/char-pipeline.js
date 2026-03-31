/**
 * Character Pipeline Routes — 8-Step Character Creation
 *
 * Steps:
 *  1. Upload Headshot (client-side only — no route needed)
 *  2. Generate Pixel Character  → POST /api/char-pipeline/pixel-char
 *     Confirm Selection         → POST /api/char-pipeline/pixel-char/confirm
 *  3. Generate Head Angle Sheet → POST /api/char-pipeline/head-sheet
 *  4. Slice Head Angles         → POST /api/char-pipeline/head-slice
 *  5. Generate Body Angle Sheet → POST /api/char-pipeline/body-sheet
 *  6. Slice Body Frames         → POST /api/char-pipeline/body-slice
 *  7. Generate Final Frames     → POST /api/char-pipeline/final-frames
 *     (or use body frames)      → POST /api/char-pipeline/finalize
 *  8. Clothing System           → POST /api/char-pipeline/clothing/upload
 *                                 POST /api/char-pipeline/clothing/apply
 *     Complete                  → POST /api/char-pipeline/complete
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { recordCost } = require('../middleware/cost-tracker');
const { cutFrames } = require('../lib/sprite-processor/index');
const { CHARACTERS } = require('../lib/sprite-generator/prompts');

const CHARACTERS_FILE = path.resolve(__dirname, '../data/.characters.json');

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

function computeScale(heightInches) {
  const baseHeight = 72;
  const scaleMultiplier = +(heightInches / baseHeight).toFixed(3);
  const pixelHeight = Math.round(111.6 * heightInches / baseHeight);
  return { scaleMultiplier, pixelHeight };
}

const ANGLE_LABELS_6 = ['front', 'front_right', 'right', 'back', 'back_left', 'left'];

// ── Prompt builders ─────────────────────────────────────────────────────────

function buildPixelCharPrompt(hasStyleRef) {
  const lines = [
    hasStyleRef
      ? 'Image 1 is the style reference — match this exact pixel art style. Image 2 is the person to convert.'
      : 'Convert the uploaded photo into 16-bit arcade pixel art.',
    '',
    'Create a FULL BODY standing character portrait showing the complete person from head to shoes.',
    'The character must be standing upright, facing forward, arms relaxed at sides, in a neutral standing pose.',
    'Show the ENTIRE body — head, torso, arms, hands, legs, feet/shoes. Do NOT crop or zoom in.',
    '',
    'ACCURACY IS CRITICAL:',
    '- Match the person\'s EXACT skin tone — do not lighten or darken it',
    '- Match their EXACT facial features, face shape, eyes, nose, mouth',
    '- Match their EXACT hairstyle, hair color, hair texture',
    '- Match their EXACT outfit, clothing colors, and shoes from the photo',
    '- Match their body type and proportions',
    '',
    'STYLE:',
    '- 16-bit arcade pixel art, GBA game style — chunky pixels, NOT high-resolution',
    '- Bold thick black pixel outlines around the entire character body',
    '- Limited color palette with high contrast arcade shading',
    '- Sharp pixel edges — NO anti-aliasing, NO blur, NO smooth gradients',
    '- The character should look like they belong in a retro basketball arcade game',
    '',
    'Output on a pure white background (#FFFFFF only).',
    'FULL BODY only. No environment. No extra elements. No cropping.',
  ];
  return lines.join('\n');
}

function buildHeadSheetPrompt() {
  return [
    'Image 1 is the character portrait in 16-bit pixel art style.',
    '',
    'Generate a HORIZONTAL SPRITE SHEET showing the character\'s HEAD from 6 different angles.',
    'Arrange exactly 6 frames horizontally, left to right:',
    '  Frame 1: Front-facing (0°)',
    '  Frame 2: Front-right (45°)',
    '  Frame 3: Right profile (90°)',
    '  Frame 4: Back (180°)',
    '  Frame 5: Back-left (225°)',
    '  Frame 6: Left profile (270°)',
    '',
    'Each frame shows ONLY the head and neck. No body below the neck.',
    'Match the EXACT face, hair, skin tone, and style from Image 1.',
    '16-bit pixel art, GBA style. Bold black pixel outlines.',
    'Separate each frame with a 1-pixel black border. White background.',
    'Output a single wide horizontal strip — 6 frames wide × 1 frame tall.',
  ].join('\n');
}

function buildBodySheetPrompt() {
  return [
    'Image 1 is the character portrait in 16-bit pixel art style.',
    '',
    'Generate a HORIZONTAL SPRITE SHEET showing the FULL BODY character from 6 different angles.',
    'Arrange exactly 6 frames horizontally, left to right:',
    '  Frame 1: Front (0°) — facing viewer',
    '  Frame 2: Front-right (45°)',
    '  Frame 3: Right profile (90°)',
    '  Frame 4: Back (180°)',
    '  Frame 5: Back-left (225°)',
    '  Frame 6: Left profile (270°)',
    '',
    'Each frame shows the COMPLETE body from head to toe. Neutral standing pose, arms at sides.',
    'Match the EXACT outfit, skin tone, proportions, hairstyle from Image 1.',
    '16-bit pixel art, GBA style. Bold black pixel outlines.',
    'Separate each frame with a 1-pixel black border. Pure green (#00FF00) background.',
    'Output a single wide horizontal strip — 6 frames wide × 1 frame tall.',
  ].join('\n');
}

function buildFinalFramePrompt(angleLabel) {
  return [
    `Image 1 is the character's body at the ${angleLabel} angle in 16-bit pixel art.`,
    `Image 2 is the character portrait showing exact face, hair, and clothing details.`,
    '',
    `Generate a clean, finished 16-bit pixel art sprite of the character at the ${angleLabel} angle.`,
    'FULL BODY from head to toe. Neutral standing pose, arms relaxed.',
    'Match EXACT face, hair, skin tone, outfit, and proportions from both reference images.',
    '16-bit pixel art, GBA style. Bold black outlines. No anti-aliasing.',
    'Pure green (#00FF00) background for chroma keying.',
    'Square frame, 1:1 aspect ratio.',
  ].join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sliceSheet(sheetPath, outputDir, frameCount, destPattern) {
  const meta = await sharp(sheetPath).metadata();
  const frameWidth = Math.floor(meta.width / frameCount);
  fs.mkdirSync(outputDir, { recursive: true });
  const { frames } = await cutFrames(sheetPath, outputDir, { frameWidth, frameHeight: meta.height });

  const result = [];
  for (let i = 0; i < Math.min(frames.length, frameCount); i++) {
    const dest = destPattern.replace('{i}', i);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(frames[i], dest);
    result.push({ index: i, label: ANGLE_LABELS_6[i] || `angle_${i}`, path: dest });
  }
  return result;
}

// ── Route Registration ───────────────────────────────────────────────────────

function register(router, { ASSETS_DIR, TMP_DIR, json, parseBody, serveImage }) {

  // GET /api/char-pipeline/status/:name — Get pipeline state
  router.get('/api/char-pipeline/status/:name', (req, res, params) => {
    const { name } = params;
    const charDir = path.join(TMP_DIR, 'characters', name);

    const headFrames = [];
    const bodyFrames = [];
    const finalFrames = [];

    for (let i = 0; i < 6; i++) {
      const hp = path.join(ASSETS_DIR, `${name}-headshot-${i}.png`);
      if (fs.existsSync(hp)) headFrames.push({ index: i, label: ANGLE_LABELS_6[i], url: `/assets/${name}-headshot-${i}.png` });
      const bp = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(bp)) bodyFrames.push({ index: i, label: ANGLE_LABELS_6[i], url: `/assets/${name}-angle-${i}.png` });
      const fp = path.join(ASSETS_DIR, `${name}-final-${i}.png`);
      if (fs.existsSync(fp)) finalFrames.push({ index: i, label: ANGLE_LABELS_6[i], url: `/assets/${name}-final-${i}.png` });
    }

    const hasHeadSheet = fs.existsSync(path.join(charDir, 'head-sheet.png'));
    const hasBodySheet = fs.existsSync(path.join(charDir, 'body-sheet.png'));
    const hasPortrait = fs.existsSync(path.join(ASSETS_DIR, `${name}full.png`));

    return json(res, {
      name,
      hasPhoto: fs.existsSync(path.join(charDir, 'original.png')),
      hasOptions: fs.existsSync(path.join(charDir, 'option-0.png')),
      hasPortrait,
      portraitUrl: hasPortrait ? `/assets/${name}full.png` : null,
      hasHeadSheet,
      headSheetUrl: hasHeadSheet ? `/api/character/image/${name}/head-sheet.png` : null,
      headFrames,
      hasBodySheet,
      bodySheetUrl: hasBodySheet ? `/api/character/image/${name}/body-sheet.png` : null,
      bodyFrames,
      finalFrames,
    });
  });

  // POST /api/char-pipeline/pixel-char — Step 2: Generate 4 pixel art options
  router.post('/api/char-pipeline/pixel-char', async (req, res) => {
    const body = await parseBody(req);
    const { name, photoBase64, model, promptOverride, count = 4 } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });

      const originalPath = path.join(charDir, 'original.png');
      if (photoBase64) {
        const data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(originalPath, Buffer.from(data, 'base64'));
      } else if (!fs.existsSync(originalPath)) {
        return json(res, { error: 'Photo required' }, 400);
      }

      const styleRef = path.join(ASSETS_DIR, '99full.png');
      const hasStyleRef = fs.existsSync(styleRef);
      const prompt = promptOverride?.trim() || buildPixelCharPrompt(hasStyleRef);

      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });
      const referenceImages = hasStyleRef ? [styleRef, originalPath] : [originalPath];

      const options = [];
      for (let i = 0; i < count; i++) {
        try {
          const result = await client.generate(prompt, {
            referenceImages,
            aspectRatio: '3:4',
            resolution: '2K',
            model: modelId,
          });
          const optPath = path.join(charDir, `option-${i}.png`);
          fs.writeFileSync(optPath, result.imageBuffer);
          recordCost(modelId, 'char_pipeline', '2K', referenceImages.length, { character: name, step: 'pixel-char', option: i });
          options.push({ index: i, url: `/api/character/image/${name}/option-${i}.png` });
        } catch (err) {
          options.push({ index: i, error: err.message });
        }
        if (i < count - 1) await new Promise(r => setTimeout(r, 1500));
      }

      return json(res, {
        success: true,
        name,
        originalUrl: `/api/character/image/${name}/original.png`,
        options: options.filter(o => !o.error),
        errors: options.filter(o => o.error),
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/pixel-char/confirm — Pick option, save portrait
  router.post('/api/char-pipeline/pixel-char/confirm', async (req, res) => {
    const body = await parseBody(req);
    const { name, optionIndex, heightInches, weightLbs, build, jerseyNumber, teamColors } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      const optPath = path.join(charDir, `option-${optionIndex}.png`);
      if (!fs.existsSync(optPath)) return json(res, { error: 'Option not found' }, 404);

      const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
      fs.copyFileSync(optPath, portraitPath);

      CHARACTERS[name] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };

      const registry = loadCharacters();
      const height = heightInches || 72;
      const { scaleMultiplier, pixelHeight } = computeScale(height);
      registry[name] = {
        ...(registry[name] || {}),
        name, id: name,
        description: CHARACTERS[name].description,
        style: CHARACTERS[name].style,
        heightInches: height,
        weightLbs: weightLbs || 185,
        build: build || 'athletic',
        jerseyNumber: jerseyNumber || '',
        teamColors: teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
        portraitPath: `${name}full.png`,
        scaleMultiplier, pixelHeight,
        status: 'portrait_done',
      };
      saveCharacters(registry);

      return json(res, {
        success: true, name,
        portraitUrl: `/assets/${name}full.png`,
        character: registry[name],
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/head-sheet — Step 3: Generate 6-angle head strip
  router.post('/api/char-pipeline/head-sheet', async (req, res) => {
    const body = await parseBody(req);
    const { name, model, promptOverride } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found — complete Step 2 first' }, 400);

    try {
      const prompt = promptOverride?.trim() || buildHeadSheetPrompt();
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const result = await client.generate(prompt, {
        referenceImages: [portraitPath],
        aspectRatio: '16:9',
        resolution: '2K',
        model: modelId,
      });

      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });
      const sheetPath = path.join(charDir, 'head-sheet.png');
      fs.writeFileSync(sheetPath, result.imageBuffer);
      recordCost(modelId, 'char_pipeline', '2K', 1, { character: name, step: 'head-sheet' });

      return json(res, {
        success: true, name,
        sheetUrl: `/api/character/image/${name}/head-sheet.png`,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/head-slice — Step 4: Slice head strip into frames
  router.post('/api/char-pipeline/head-slice', async (req, res) => {
    const body = await parseBody(req);
    const { name, labels } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const sheetPath = path.join(TMP_DIR, 'characters', name, 'head-sheet.png');
    if (!fs.existsSync(sheetPath)) return json(res, { error: 'Head sheet not found — complete Step 3 first' }, 400);

    try {
      const sliceDir = path.join(TMP_DIR, 'characters', name, 'head-frames');
      const destPattern = path.join(ASSETS_DIR, `${name}-headshot-{i}.png`);
      const angleLabels = labels || ANGLE_LABELS_6;

      const sliced = await sliceSheet(sheetPath, sliceDir, 6, destPattern);
      const frames = sliced.map((f, i) => ({
        ...f,
        label: angleLabels[i] || f.label,
        url: `/assets/${name}-headshot-${i}.png`,
      }));

      return json(res, { success: true, name, frames });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/body-sheet — Step 5: Generate 6-angle body strip
  router.post('/api/char-pipeline/body-sheet', async (req, res) => {
    const body = await parseBody(req);
    const { name, model, promptOverride, clothingNote, clothingImages } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });

      // Save any clothing reference images to temp files
      const clothingPaths = [];
      if (Array.isArray(clothingImages) && clothingImages.length > 0) {
        const clothingDir = path.join(charDir, 'clothing-refs');
        fs.mkdirSync(clothingDir, { recursive: true });
        for (let i = 0; i < clothingImages.length; i++) {
          const data = clothingImages[i].replace(/^data:image\/\w+;base64,/, '');
          const p = path.join(clothingDir, `ref-${i}.png`);
          fs.writeFileSync(p, Buffer.from(data, 'base64'));
          clothingPaths.push(p);
        }
      }

      // Build prompt — add clothing context note if present
      let basePrompt = promptOverride?.trim() || buildBodySheetPrompt();
      if (clothingNote) {
        basePrompt += `\n\n${clothingNote.trim()}`;
        basePrompt += '\nMatch the outfit from the additional clothing reference images exactly.';
      }

      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });
      const referenceImages = [portraitPath, ...clothingPaths];

      const result = await client.generate(basePrompt, {
        referenceImages,
        aspectRatio: '16:9',
        resolution: '2K',
        model: modelId,
      });

      const sheetPath = path.join(charDir, 'body-sheet.png');
      fs.writeFileSync(sheetPath, result.imageBuffer);
      recordCost(modelId, 'char_pipeline', '2K', referenceImages.length, { character: name, step: 'body-sheet' });

      return json(res, {
        success: true, name,
        sheetUrl: `/api/character/image/${name}/body-sheet.png`,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/body-slice — Step 6: Slice body strip
  router.post('/api/char-pipeline/body-slice', async (req, res) => {
    const body = await parseBody(req);
    const { name, labels } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const sheetPath = path.join(TMP_DIR, 'characters', name, 'body-sheet.png');
    if (!fs.existsSync(sheetPath)) return json(res, { error: 'Body sheet not found — complete Step 5 first' }, 400);

    try {
      const sliceDir = path.join(TMP_DIR, 'characters', name, 'body-frames');
      const destPattern = path.join(ASSETS_DIR, `${name}-angle-{i}.png`);
      const angleLabels = labels || ANGLE_LABELS_6;

      const sliced = await sliceSheet(sheetPath, sliceDir, 6, destPattern);
      const frames = sliced.map((f, i) => ({
        ...f,
        label: angleLabels[i] || f.label,
        url: `/assets/${name}-angle-${i}.png`,
      }));

      return json(res, { success: true, name, frames });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/final-frames — Step 7: AI-generate one clean frame per angle
  router.post('/api/char-pipeline/final-frames', async (req, res) => {
    const body = await parseBody(req);
    const { name, model, promptOverride } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);

    // Collect available body frames
    const bodyFrames = [];
    for (let i = 0; i < 6; i++) {
      const bp = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(bp)) bodyFrames.push({ index: i, path: bp });
    }
    if (bodyFrames.length === 0) return json(res, { error: 'No body frames — complete Steps 5-6 first' }, 400);

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });
      const finalDir = path.join(TMP_DIR, 'characters', name, 'final-frames');
      fs.mkdirSync(finalDir, { recursive: true });

      const finalFrames = [];
      for (const frame of bodyFrames) {
        const angleLabel = ANGLE_LABELS_6[frame.index] || `angle_${frame.index}`;
        const prompt = promptOverride || buildFinalFramePrompt(angleLabel);

        const result = await client.generate(prompt, {
          referenceImages: [frame.path, portraitPath],
          aspectRatio: '1:1',
          resolution: '1K',
          model: modelId,
        });

        const outPath = path.join(finalDir, `frame-${frame.index}.png`);
        fs.writeFileSync(outPath, result.imageBuffer);

        const destPath = path.join(ASSETS_DIR, `${name}-final-${frame.index}.png`);
        fs.copyFileSync(outPath, destPath);
        finalFrames.push({ index: frame.index, label: angleLabel, url: `/assets/${name}-final-${frame.index}.png` });
        recordCost(modelId, 'char_pipeline', '1K', 2, { character: name, step: 'final-frames', angleIndex: frame.index });

        if (frame.index < bodyFrames[bodyFrames.length - 1].index) await new Promise(r => setTimeout(r, 1500));
      }

      return json(res, { success: true, name, finalFrames });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/finalize — Step 7 alt: use body frames as final (free)
  router.post('/api/char-pipeline/finalize', async (req, res) => {
    const body = await parseBody(req);
    const { name } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const finalFrames = [];
    for (let i = 0; i < 6; i++) {
      const src = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(src)) {
        const dest = path.join(ASSETS_DIR, `${name}-final-${i}.png`);
        fs.copyFileSync(src, dest);
        finalFrames.push({ index: i, label: ANGLE_LABELS_6[i], url: `/assets/${name}-final-${i}.png` });
      }
    }

    return json(res, { success: true, name, finalFrames });
  });

  // POST /api/char-pipeline/complete — Finish pipeline, register character
  router.post('/api/char-pipeline/complete', async (req, res) => {
    const body = await parseBody(req);
    const { name } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    if (!CHARACTERS[name]) {
      CHARACTERS[name] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };
    }

    const registry = loadCharacters();
    if (registry[name]) {
      registry[name].status = 'pipeline_complete';
      registry[name].pipelineCompletedAt = new Date().toISOString();
      saveCharacters(registry);
    }

    return json(res, { success: true, name, character: registry[name] || null });
  });

  // POST /api/char-pipeline/clothing/upload — Upload clothing reference
  router.post('/api/char-pipeline/clothing/upload', async (req, res) => {
    const body = await parseBody(req);
    const { name, imageBase64, category = 'top', label } = body;
    if (!name || !imageBase64) return json(res, { error: 'name and imageBase64 required' }, 400);

    try {
      const clothingDir = path.join(TMP_DIR, 'characters', name, 'clothing');
      fs.mkdirSync(clothingDir, { recursive: true });

      const itemId = `${category}-${Date.now()}`;
      const imagePath = path.join(clothingDir, `${itemId}.png`);
      const data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(imagePath, Buffer.from(data, 'base64'));

      return json(res, {
        success: true,
        item: {
          id: itemId,
          category,
          label: label || category,
          url: `/api/character/image/${name}/clothing/${itemId}.png`,
        },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/clothing/apply — AI-apply clothing to all angles
  router.post('/api/char-pipeline/clothing/apply', async (req, res) => {
    const body = await parseBody(req);
    const { name, itemId, model } = body;
    if (!name || !itemId) return json(res, { error: 'name and itemId required' }, 400);

    const clothingPath = path.join(TMP_DIR, 'characters', name, 'clothing', `${itemId}.png`);
    if (!fs.existsSync(clothingPath)) return json(res, { error: 'Clothing item not found' }, 404);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);

    try {
      const modelId = model || 'gemini-2.5-flash-image';
      const client = new NanaBananaClient({ model: modelId });

      const results = [];
      for (let i = 0; i < 6; i++) {
        const bodyFramePath = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
        if (!fs.existsSync(bodyFramePath)) continue;

        const angleLabel = ANGLE_LABELS_6[i];
        const prompt = [
          `Image 1 is the character body at the ${angleLabel} angle.`,
          `Image 2 is the character portrait.`,
          `Image 3 is the clothing item to apply.`,
          '',
          `Redraw the character at the ${angleLabel} angle wearing the clothing from Image 3.`,
          'Keep all other features identical — face, hair, skin tone, proportions, pose.',
          '16-bit pixel art, GBA style. Bold black outlines. Green (#00FF00) background.',
        ].join('\n');

        const result = await client.generate(prompt, {
          referenceImages: [bodyFramePath, portraitPath, clothingPath],
          aspectRatio: '3:4',
          resolution: '2K',
          model: modelId,
        });

        const outPath = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
        fs.writeFileSync(outPath, result.imageBuffer);
        results.push({ index: i, label: angleLabel, url: `/assets/${name}-angle-${i}.png` });
        recordCost(modelId, 'char_pipeline', '2K', 3, { character: name, step: 'clothing-apply', angleIndex: i });

        if (i < 5) await new Promise(r => setTimeout(r, 1500));
      }

      return json(res, { success: true, name, results });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
