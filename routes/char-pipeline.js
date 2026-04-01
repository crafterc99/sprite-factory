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
const { cutFrames, removeBackground, cropToContent } = require('../lib/sprite-processor/index');
const { CHARACTERS } = require('../lib/sprite-generator/prompts');

const CHARACTERS_FILE = path.resolve(__dirname, '../data/.characters.json');
const CHAR_PROMPTS_FILE = path.resolve(__dirname, '../data/.char-prompts.json');

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

function loadCharPrompts() {
  try {
    if (fs.existsSync(CHAR_PROMPTS_FILE)) {
      return { ...getDefaultPrompts(), ...JSON.parse(fs.readFileSync(CHAR_PROMPTS_FILE, 'utf8')) };
    }
  } catch {}
  return getDefaultPrompts();
}

function saveCharPrompts(data) {
  const dir = path.dirname(CHAR_PROMPTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHAR_PROMPTS_FILE, JSON.stringify(data, null, 2));
}

function computeScale(heightInches) {
  const baseHeight = 72;
  const scaleMultiplier = +(heightInches / baseHeight).toFixed(3);
  const pixelHeight = Math.round(111.6 * heightInches / baseHeight);
  return { scaleMultiplier, pixelHeight };
}

const ANGLE_LABELS_8 = ['front', 'front_right_45', 'right_90', 'back_right_135', 'back_180', 'back_left_225', 'left_270', 'front_left_315'];

// ── Prompt builders ─────────────────────────────────────────────────────────

function getDefaultStep1Prompt() {
  return [
    'Transform the uploaded image into 16-bit arcade pixel art.',
    'IMPORTANT RULES:',
    'Do NOT change the pose.',
    'Do NOT change facial features.',
    'Do NOT add new objects.',
    'Do NOT change clothing design.',
    'Do NOT modify hairstyle.',
    'Do NOT add accessories.',
    'Do NOT change proportions.',
    'Do NOT add background elements.',
    'Only convert the image into clean 16-bit arcade pixel style with:',
    'Sharp pixel edges',
    'Limited color palette',
    'black outlines',
    'High contrast arcade shading',
    'No anti-aliasing',
    'No blur',
    'Keep the character exactly as shown.',
    'Output on a pure white background (#FFFFFF only).',
    'No environment. No extra elements. Only the character.',
  ].join('\n');
}

function getDefaultStep2Prompt() {
  return 'give the full image of this character standing naturally with a white background.';
}

function getDefaultPrompts() {
  return {
    step1: getDefaultStep1Prompt(),
    step2: getDefaultStep2Prompt(),
    bodySheet: buildBodySheetPrompt(),
    headSheet: buildHeadSheetPrompt(),
  };
}

function buildBodySheetPrompt() {
  return [
    'Use the uploaded character as the EXACT base reference.',
    '',
    'Generate a pixel-perfect character turnaround sheet with no stylistic changes.',
    '',
    '',
    'STYLE',
    '',
    'Match the exact pixel art style of the reference',
    'No lighting changes',
    'No shading changes',
    'No reinterpretation or added detail',
    '',
    '',
    'CHARACTER LOCK (STRICT)',
    '',
    'Keep the exact same face, proportions, and body shape',
    'Keep identical outfit: same clothing as shown in the reference',
    'Maintain consistent pixel scale',
    'Do not modify height, structure, or features in any way',
    '',
    '',
    'VIEWS (ONLY THESE 8)',
    '',
    'Front (0°)',
    '3/4 Front Right (45°)',
    'Right Side (90°)',
    '3/4 Back Right (135°)',
    'Back (180°)',
    '3/4 Back Left (225°)',
    'Left Side (270°)',
    '3/4 Front Left (315°)',
    '',
    '',
    'LAYOUT',
    '',
    'Arrange in 2 rows of 4',
    'Equal spacing between each character',
    'All characters at identical scale',
    'Feet aligned on the same baseline',
    '',
    '',
    'RESTRICTIONS',
    '',
    'No action poses',
    'No ball',
    'No text or labels',
    'No extra elements',
    'No duplicates',
    'Full body visible in every view',
    '',
    '',
    'OUTPUT GOAL',
    '',
    'A clean, consistent 8-angle turnaround sheet for animation reference.',
    '',
    '',
    'BACKGROUND',
    '',
    'Solid bright green (#00FF00) behind every character cell. No other colors in the background.',
  ].join('\n');
}

function buildHeadSheetPrompt() {
  return [
    'Create ONLY the following headshot angles of this pixelated character, only the head and neck not their shirt, maintaining pixel style and character detail:',
    '',
    '1. Front view',
    '2. 3/4 front right (45°)',
    '3. Right side (90°)',
    '4. 3/4 back right (135°)',
    '5. Back view (180°)',
    '6. 3/4 back left (225°)',
    '7. Left side (270°)',
    '8. 3/4 front left (315°)',
    '',
    'Arrange in 2 rows of 4.',
    'Equal spacing. All heads at identical scale. White background.',
    'Head and neck only — no shoulders, no shirt visible.',
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

// Center a frame buffer: trim background, place character centered (feet at bottom).
async function centerFrame(buf) {
  try {
    // Sample corner pixel as background color
    const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = data[0], g = data[1], b = data[2];

    // Trim background from all edges
    let trimmed;
    try {
      trimmed = await sharp(buf)
        .trim({ background: { r, g, b, alpha: 255 }, threshold: 30 })
        .png()
        .toBuffer();
    } catch {
      trimmed = buf;
    }
    const tm = await sharp(trimmed).metadata();

    // Build a square canvas with 8% padding; gravity=south keeps feet at bottom
    const inner = Math.max(tm.width, tm.height);
    const pad = Math.max(8, Math.round(inner * 0.08));
    const size = inner + pad * 2;
    return await sharp({
      create: { width: size, height: size, channels: 3, background: { r, g, b } },
    })
      .composite([{ input: trimmed, gravity: 'south', top: undefined, left: undefined }])
      .png()
      .toBuffer();
  } catch {
    return buf; // fallback: return as-is
  }
}

// Slice a sheet that may be a horizontal strip (1 row) or a grid (2 rows of 4).
// Always returns exactly frameCount frames in reading order (left-to-right, top-to-bottom).
async function sliceSheet(sheetPath, outputDir, frameCount, destPattern) {
  const meta = await sharp(sheetPath).metadata();
  fs.mkdirSync(outputDir, { recursive: true });

  const cols = frameCount / 2; // 4 for 8-frame sheets
  const isGrid = meta.width / meta.height < cols * 1.5; // roughly square-ish → grid layout

  const result = [];

  if (isGrid && frameCount === 8) {
    // 2-row × 4-column grid
    const fw = Math.floor(meta.width / 4);
    const fh = Math.floor(meta.height / 2);
    // 1px inset on each edge to avoid picking up divider lines between cells
    const inset = 1;
    let idx = 0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        // Use toBuffer() to avoid sharp's "same file" error and any path collision
        const raw = await sharp(sheetPath)
          .extract({
            left: col * fw + inset,
            top: row * fh + inset,
            width: fw - inset * 2,
            height: fh - inset * 2,
          })
          .png()
          .toBuffer();
        const buf = await centerFrame(raw);
        const outPath = path.join(outputDir, `frame-${idx}.png`);
        fs.writeFileSync(outPath, buf);
        const dest = destPattern.replace('{i}', idx);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        result.push({ index: idx, label: ANGLE_LABELS_8[idx] || `angle_${idx}`, path: dest });
        idx++;
      }
    }
  } else {
    // Horizontal strip
    const frameWidth = Math.floor(meta.width / frameCount);
    const frameHeight = meta.height;
    let idx = 0;
    for (let col = 0; col < frameCount; col++) {
      const raw = await sharp(sheetPath)
        .extract({ left: col * frameWidth, top: 0, width: frameWidth, height: frameHeight })
        .png()
        .toBuffer();
      const buf = await centerFrame(raw);
      const outPath = path.join(outputDir, `frame-${idx}.png`);
      fs.writeFileSync(outPath, buf);
      const dest = destPattern.replace('{i}', idx);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      result.push({ index: idx, label: ANGLE_LABELS_8[idx] || `angle_${idx}`, path: dest });
      idx++;
    }
  }
  return result;
}

// ── Async Job Store ───────────────────────────────────────────────────────────
// Each long-running AI call returns a jobId immediately; client polls for result.
// This avoids Railway's HTTP proxy timeout on slow generation requests.

const jobs = new Map();

function startJob() {
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  jobs.set(jobId, { status: 'pending', result: null, error: null });
  setTimeout(() => jobs.delete(jobId), 15 * 60 * 1000); // clean up after 15 min
  return jobId;
}

function finishJob(jobId, result) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, status: 'done', result });
}

function failJob(jobId, errMsg) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, status: 'error', error: errMsg });
}

// ── Route Registration ───────────────────────────────────────────────────────

function register(router, { ASSETS_DIR, TMP_DIR, json, parseBody, serveImage }) {

  // GET /api/char-pipeline/job/:jobId — Poll for async job result
  router.get('/api/char-pipeline/job/:jobId', (req, res, params) => {
    const job = jobs.get(params.jobId);
    if (!job) return json(res, { error: 'Job not found' }, 404);
    return json(res, { jobId: params.jobId, ...job });
  });

  // GET /api/char-pipeline/preview/:name — Serve the step2 portrait preview (for resume after page refresh)
  router.get('/api/char-pipeline/preview/:name', (req, res, params) => {
    const previewPath = path.join(TMP_DIR, 'characters', params.name, 'step2-preview.png');
    if (!fs.existsSync(previewPath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    fs.createReadStream(previewPath).pipe(res);
  });

  // GET /api/char-pipeline/status/:name — Get pipeline state
  router.get('/api/char-pipeline/status/:name', (req, res, params) => {
    const { name } = params;
    const charDir = path.join(TMP_DIR, 'characters', name);

    const headFrames = [];
    const bodyFrames = [];
    const finalFrames = [];

    for (let i = 0; i < 8; i++) {
      const hp = path.join(ASSETS_DIR, `${name}-headshot-${i}.png`);
      if (fs.existsSync(hp)) headFrames.push({ index: i, label: ANGLE_LABELS_8[i], url: `/assets/${name}-headshot-${i}.png` });
      const bp = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(bp)) bodyFrames.push({ index: i, label: ANGLE_LABELS_8[i], url: `/assets/${name}-angle-${i}.png` });
      const fp = path.join(ASSETS_DIR, `${name}-final-${i}.png`);
      if (fs.existsSync(fp)) finalFrames.push({ index: i, label: ANGLE_LABELS_8[i], url: `/assets/${name}-final-${i}.png` });
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

  // GET /api/char-pipeline/prompts — Return current character generation prompts
  router.get('/api/char-pipeline/prompts', (req, res) => {
    return json(res, loadCharPrompts());
  });

  // POST /api/char-pipeline/prompts — Save updated prompts
  router.post('/api/char-pipeline/prompts', async (req, res) => {
    const body = await parseBody(req);
    const current = loadCharPrompts();
    const updated = { ...current };
    if (body.step1 !== undefined) updated.step1 = body.step1;
    if (body.step2 !== undefined) updated.step2 = body.step2;
    if (body.bodySheet !== undefined) updated.bodySheet = body.bodySheet;
    if (body.headSheet !== undefined) updated.headSheet = body.headSheet;
    saveCharPrompts(updated);
    return json(res, { success: true, prompts: updated });
  });

  // POST /api/char-pipeline/pixel-char/step1 — Start async: save photo + convert to pixel art
  router.post('/api/char-pipeline/pixel-char/step1', async (req, res) => {
    const body = await parseBody(req);
    const { name, photoBase64 } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const charDir = path.join(TMP_DIR, 'characters', name);
    fs.mkdirSync(charDir, { recursive: true });
    const originalPath = path.join(charDir, 'original.png');

    if (photoBase64) {
      const data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(originalPath, Buffer.from(data, 'base64'));
    } else if (!fs.existsSync(originalPath)) {
      return json(res, { error: 'Photo required' }, 400);
    }

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });
        const step1 = await client.generate(loadCharPrompts().step1, {
          referenceImages: [originalPath],
          aspectRatio: '3:4',
          resolution: '2K',
          model: modelId,
          maxRetries: 1,
          timeoutMs: 80000,
        });
        const step1Path = path.join(charDir, 'step1-pixel.png');
        fs.writeFileSync(step1Path, step1.imageBuffer);
        recordCost(modelId, 'char_pipeline', '2K', 1, { character: name, step: 'pixel-char-step1' });
        finishJob(jobId, { success: true, name });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
  });

  // POST /api/char-pipeline/pixel-char/step2 — Start async: pixel art → standing portrait
  // Result contains imageBase64 so client can display inline without a separate HTTP request.
  router.post('/api/char-pipeline/pixel-char/step2', async (req, res) => {
    const body = await parseBody(req);
    const { name } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const step1Path = path.join(TMP_DIR, 'characters', name, 'step1-pixel.png');
    if (!fs.existsSync(step1Path)) return json(res, { error: 'Step 1 not found — run step1 first' }, 400);

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });
        const step2 = await client.generate(loadCharPrompts().step2, {
          referenceImages: [step1Path],
          aspectRatio: '3:4',
          resolution: '2K',
          model: modelId,
          maxRetries: 1,
          timeoutMs: 80000,
        });
        recordCost(modelId, 'char_pipeline', '2K', 1, { character: name, step: 'pixel-char-step2' });
        // Also persist portrait to disk so client can resume after page refresh
        const previewPath = path.join(TMP_DIR, 'characters', name, 'step2-preview.png');
        fs.writeFileSync(previewPath, step2.imageBuffer);
        const imageBase64 = 'data:image/png;base64,' + step2.imageBuffer.toString('base64');
        finishJob(jobId, { success: true, name, imageBase64 });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
  });

  // POST /api/char-pipeline/pixel-char/confirm — Save confirmed portrait
  // Accepts portraitBase64 (data URL) directly from client to avoid filesystem issues.
  router.post('/api/char-pipeline/pixel-char/confirm', async (req, res) => {
    const body = await parseBody(req);
    const { name, portraitBase64, heightInches, weightLbs, build, jerseyNumber, teamColors } = body;
    if (!name) return json(res, { error: 'name required' }, 400);
    if (!portraitBase64) return json(res, { error: 'portraitBase64 required' }, 400);

    try {
      const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
      const data = portraitBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(portraitPath, Buffer.from(data, 'base64'));

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
      const prompt = promptOverride?.trim() || loadCharPrompts().headSheet;
      const modelId = 'gemini-3-pro-image-preview';
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
      const angleLabels = labels || ANGLE_LABELS_8;

      const sliced = await sliceSheet(sheetPath, sliceDir, 8, destPattern);
      const frames = sliced.map((f, i) => ({
        ...f,
        label: (angleLabels && angleLabels[i]) || f.label,
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
      let basePrompt = promptOverride?.trim() || loadCharPrompts().bodySheet;
      if (clothingNote) {
        basePrompt += `\n\n${clothingNote.trim()}`;
        basePrompt += '\nMatch the outfit from the additional clothing reference images exactly.';
      }

      const modelId = 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });
      const referenceImages = [portraitPath, ...clothingPaths];

      const result = await client.generate(basePrompt, {
        referenceImages,
        aspectRatio: '16:9',
        resolution: '2K',
        model: modelId,
        maxRetries: 1,
        timeoutMs: 80000,
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
      const angleLabels = labels || ANGLE_LABELS_8;

      const sliced = await sliceSheet(sheetPath, sliceDir, 8, destPattern);
      const frames = sliced.map((f, i) => ({
        ...f,
        label: (angleLabels && angleLabels[i]) || f.label,
        url: `/assets/${name}-angle-${i}.png`,
      }));

      return json(res, { success: true, name, frames });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/char-pipeline/generate-body-angles — Start async: generate body sheet + slice
  router.post('/api/char-pipeline/generate-body-angles', async (req, res) => {
    const body = await parseBody(req);
    const { name, promptOverride, clothingNote, clothingImages } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);

    const charDir = path.join(TMP_DIR, 'characters', name);
    fs.mkdirSync(charDir, { recursive: true });

    // Save clothing refs synchronously before returning
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

    let basePrompt = promptOverride?.trim() || loadCharPrompts().bodySheet;
    if (clothingNote) {
      basePrompt += `\n\n${clothingNote.trim()}`;
      basePrompt += '\nMatch the outfit from the additional clothing reference images exactly.';
    }

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });
        const referenceImages = [portraitPath, ...clothingPaths];

        const result = await client.generate(basePrompt, {
          referenceImages,
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          maxRetries: 1,
          timeoutMs: 80000,
        });

        const sheetPath = path.join(charDir, 'body-sheet.png');
        fs.writeFileSync(sheetPath, result.imageBuffer);
        recordCost(modelId, 'char_pipeline', '2K', referenceImages.length, { character: name, step: 'body-sheet' });

        const sliceDir = path.join(charDir, 'body-frames');
        const destPattern = path.join(ASSETS_DIR, `${name}-angle-{i}.png`);
        const sliced = await sliceSheet(sheetPath, sliceDir, 8, destPattern);

        // Remove green background and crop each angle to a clean transparent PNG
        for (let i = 0; i < sliced.length; i++) {
          const framePath = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
          if (fs.existsSync(framePath)) {
            await removeBackground(framePath, framePath);
            await cropToContent(framePath, framePath, { width: 180, height: 180, padding: 10 });
          }
        }

        const frames = sliced.map((f, i) => ({
          ...f,
          label: ANGLE_LABELS_8[i] || f.label,
          url: `/assets/${name}-angle-${i}.png`,
        }));

        finishJob(jobId, { success: true, name, sheetUrl: `/api/character/image/${name}/body-sheet.png`, frames });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
  });

  // POST /api/char-pipeline/generate-head-angles — Start async: generate head sheet + slice
  router.post('/api/char-pipeline/generate-head-angles', async (req, res) => {
    const body = await parseBody(req);
    const { name, promptOverride } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found — complete Step 2 first' }, 400);

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const prompt = promptOverride?.trim() || loadCharPrompts().headSheet;
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });

        const result = await client.generate(prompt, {
          referenceImages: [portraitPath],
          aspectRatio: '16:9',
          resolution: '2K',
          model: modelId,
          maxRetries: 1,
          timeoutMs: 80000,
        });

        const charDir = path.join(TMP_DIR, 'characters', name);
        fs.mkdirSync(charDir, { recursive: true });
        const sheetPath = path.join(charDir, 'head-sheet.png');
        fs.writeFileSync(sheetPath, result.imageBuffer);
        recordCost(modelId, 'char_pipeline', '2K', 1, { character: name, step: 'head-sheet' });

        const sliceDir = path.join(charDir, 'head-frames');
        const destPattern = path.join(ASSETS_DIR, `${name}-headshot-{i}.png`);
        const sliced = await sliceSheet(sheetPath, sliceDir, 8, destPattern);
        const frames = sliced.map((f, i) => ({
          ...f,
          label: ANGLE_LABELS_8[i] || f.label,
          url: `/assets/${name}-headshot-${i}.png`,
        }));

        finishJob(jobId, { success: true, name, sheetUrl: `/api/character/image/${name}/head-sheet.png`, frames });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
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
    for (let i = 0; i < 8; i++) {
      const bp = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(bp)) bodyFrames.push({ index: i, path: bp });
    }
    if (bodyFrames.length === 0) return json(res, { error: 'No body frames — complete Steps 5-6 first' }, 400);

    try {
      const modelId = model || 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });
      const finalDir = path.join(TMP_DIR, 'characters', name, 'final-frames');
      fs.mkdirSync(finalDir, { recursive: true });

      const finalFrames = [];
      for (const frame of bodyFrames) {
        const angleLabel = ANGLE_LABELS_8[frame.index] || `angle_${frame.index}`;
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
    for (let i = 0; i < 8; i++) {
      const src = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
      if (fs.existsSync(src)) {
        const dest = path.join(ASSETS_DIR, `${name}-final-${i}.png`);
        fs.copyFileSync(src, dest);
        finalFrames.push({ index: i, label: ANGLE_LABELS_8[i], url: `/assets/${name}-final-${i}.png` });
      }
    }

    return json(res, { success: true, name, finalFrames });
  });

  // POST /api/char-pipeline/rename-angle — Update the stored label for a sliced angle
  router.post('/api/char-pipeline/rename-angle', async (req, res) => {
    const body = await parseBody(req);
    const { name, type, index, label } = body;
    if (!name || !label || index === undefined) return json(res, { error: 'name, type, index, label required' }, 400);

    // Rename the file to reflect the new label
    const prefix = type === 'head' ? `${name}-headshot-` : `${name}-angle-`;
    const src = path.join(ASSETS_DIR, `${prefix}${index}.png`);
    if (!fs.existsSync(src)) return json(res, { error: 'Frame not found' }, 404);

    // Store label in character registry
    const registry = loadCharacters();
    if (!registry[name]) registry[name] = { name, id: name };
    if (!registry[name].angleLabels) registry[name].angleLabels = {};
    if (!registry[name].angleLabels[type]) registry[name].angleLabels[type] = {};
    registry[name].angleLabels[type][index] = label;
    saveCharacters(registry);

    return json(res, { success: true, name, type, index, label });
  });

  // POST /api/char-pipeline/regen-angle — Async: regenerate a single angle frame with a modifier
  router.post('/api/char-pipeline/regen-angle', async (req, res) => {
    const body = await parseBody(req);
    const { name, type, index, modifier } = body;
    if (!name || !modifier || index === undefined) return json(res, { error: 'name, type, index, modifier required' }, 400);

    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (!fs.existsSync(portraitPath)) return json(res, { error: 'Portrait not found' }, 400);

    const prefix = type === 'head' ? `${name}-headshot-` : `${name}-angle-`;
    const framePath = path.join(ASSETS_DIR, `${prefix}${index}.png`);
    if (!fs.existsSync(framePath)) return json(res, { error: 'Frame not found' }, 404);

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const angleLabel = ANGLE_LABELS_8[index] || `angle_${index}`;
        const isHead = type === 'head';
        const basePrompt = isHead
          ? loadCharPrompts().headSheet
          : loadCharPrompts().bodySheet;
        const prompt = basePrompt + `\n\nKeep everything the exact same but: ${modifier.trim()}\nGenerate only the ${angleLabel} angle view.`;

        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });
        const result = await client.generate(prompt, {
          referenceImages: [portraitPath, framePath],
          aspectRatio: isHead ? '1:1' : '1:1',
          resolution: '1K',
          model: modelId,
          maxRetries: 1,
          timeoutMs: 80000,
        });

        // Center and save
        const centered = await centerFrame(result.imageBuffer);
        fs.writeFileSync(framePath, centered);

        const imageBase64 = 'data:image/png;base64,' + centered.toString('base64');
        recordCost(modelId, 'char_pipeline', '1K', 2, { character: name, step: 'regen-angle', index });
        finishJob(jobId, { success: true, name, type, index, imageBase64, url: `/assets/${prefix}${index}.png` });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
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
      const modelId = model || 'gemini-3-pro-image-preview';
      const client = new NanaBananaClient({ model: modelId });

      const results = [];
      for (let i = 0; i < 8; i++) {
        const bodyFramePath = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
        if (!fs.existsSync(bodyFramePath)) continue;

        const angleLabel = ANGLE_LABELS_8[i];
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

  // POST /api/char-pipeline/apply-outfit — Apply top and/or bottom garments to a portrait
  // Runs sequentially: top first, then bottom applied to the top result.
  // Returns a new portrait base64 with the outfit swapped in.
  router.post('/api/char-pipeline/apply-outfit', async (req, res) => {
    const body = await parseBody(req);
    const { portraitBase64, topId, bottomId } = body;
    if (!portraitBase64) return json(res, { error: 'portraitBase64 required' }, 400);
    if (!topId && !bottomId) return json(res, { error: 'topId or bottomId required' }, 400);

    const WARDROBE_DIR = path.resolve(__dirname, '../data/wardrobe');
    const WARDROBE_INDEX = path.resolve(__dirname, '../data/wardrobe.json');
    let wardrobe = [];
    try {
      if (fs.existsSync(WARDROBE_INDEX)) wardrobe = JSON.parse(fs.readFileSync(WARDROBE_INDEX, 'utf8'));
    } catch {}

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });

        const tmpDir = path.join(TMP_DIR, 'outfit-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpId = Date.now().toString(36);

        // Save starting portrait to temp file
        let currentPortraitPath = path.join(tmpDir, `portrait-${tmpId}.png`);
        const portraitData = portraitBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(currentPortraitPath, Buffer.from(portraitData, 'base64'));

        // Step 1: Apply top garment
        if (topId) {
          const topPath = path.join(WARDROBE_DIR, `${topId}.png`);
          if (!fs.existsSync(topPath)) throw new Error(`Top wardrobe image not found (id: ${topId})`);

          const topPrompt = 'Keep everything about this pixelated character the exact same just substitute their top garments for the second uploaded image.';
          const topResult = await client.generate(topPrompt, {
            referenceImages: [currentPortraitPath, topPath],
            aspectRatio: '3:4',
            resolution: '2K',
            model: modelId,
            maxRetries: 1,
            timeoutMs: 80000,
          });

          const topResultPath = path.join(tmpDir, `after-top-${tmpId}.png`);
          fs.writeFileSync(topResultPath, topResult.imageBuffer);
          currentPortraitPath = topResultPath;
          recordCost(modelId, 'char_pipeline', '2K', 2, { step: 'apply-top' });
        }

        // Step 2: Apply bottom garment (to the top-applied result, or original if no top)
        if (bottomId) {
          const bottomPath = path.join(WARDROBE_DIR, `${bottomId}.png`);
          if (!fs.existsSync(bottomPath)) throw new Error(`Bottom wardrobe image not found (id: ${bottomId})`);

          const bottomPrompt = 'Keep everything about this pixelated character the exact same just substitute their bottom garments for the second uploaded image.';
          const bottomResult = await client.generate(bottomPrompt, {
            referenceImages: [currentPortraitPath, bottomPath],
            aspectRatio: '3:4',
            resolution: '2K',
            model: modelId,
            maxRetries: 1,
            timeoutMs: 80000,
          });

          const bottomResultPath = path.join(tmpDir, `after-bottom-${tmpId}.png`);
          fs.writeFileSync(bottomResultPath, bottomResult.imageBuffer);
          currentPortraitPath = bottomResultPath;
          recordCost(modelId, 'char_pipeline', '2K', 2, { step: 'apply-bottom' });
        }

        const imageBase64 = 'data:image/png;base64,' + fs.readFileSync(currentPortraitPath).toString('base64');
        finishJob(jobId, { success: true, imageBase64 });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
  });
}

module.exports = { register };
