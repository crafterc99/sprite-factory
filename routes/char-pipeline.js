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
const { scheduleSync } = require('../lib/auto-git-sync');
const { uploadFile: sbUpload, uploadJson: sbUploadJson, isAvailable: sbAvailable } = require('../lib/supabase-storage');

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
  if (sbAvailable()) sbUploadJson('_meta/char-prompts.json', data);
}

function computeScale(heightInches) {
  const baseHeight = 72;
  const scaleMultiplier = +(heightInches / baseHeight).toFixed(3);
  const pixelHeight = Math.round(111.6 * heightInches / baseHeight);
  return { scaleMultiplier, pixelHeight };
}

const ANGLE_LABELS_8 = ['Front', 'Front Right', 'Right', 'Back Right', 'Back', 'Back Left', 'Left', 'Front Left'];

// ── Prompt builders ─────────────────────────────────────────────────────────

function getDefaultPortraitPrompt() {
  return [
    'Convert this photo into a 16-bit arcade pixel art character portrait.',
    'The character must be standing upright, facing forward, full body visible.',
    'RULES:',
    'Preserve exact face, skin tone, hairstyle, and clothing from the photo.',
    'Pure white background (#FFFFFF). No environment, no shadows, no extra elements.',
    '16-bit pixel art style: bold black outlines, flat color fills, high-contrast shading.',
    'No anti-aliasing. No blur. No gradients.',
    'Character centered, feet at bottom, head near top of frame.',
  ].join('\n');
}

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
    portrait: getDefaultPortraitPrompt(),
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

function updateJob(jobId, progress) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, progress });
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

  // GET /api/char-pipeline/prompts — Return current prompts
  router.get('/api/char-pipeline/prompts', (req, res) => {
    const p = loadCharPrompts();
    if (!p.portrait) p.portrait = getDefaultPortraitPrompt();
    // Include studio default if not saved yet
    if (!p.studio) {
      const DEFAULT_STUDIO = [
        'Keep the exact pixelated character from Image 1. Copy only the exact pose and limb/body position from Image 2.',
        'Do not mix faces or identities. make sure the characters face does not change at all.',
        'Do not change body shape, skin tone, hairstyle, or facial structure.',
        'Match Image 2\'s full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing.',
        'natural anatomy, no distortions.',
        'Pure green (#00FF00) background.',
      ].join('\n');
      p.studio = DEFAULT_STUDIO;
    }
    return json(res, p);
  });

  // POST /api/char-pipeline/prompts — Save updated prompts
  router.post('/api/char-pipeline/prompts', async (req, res) => {
    const body = await parseBody(req);
    const current = loadCharPrompts();
    const updated = { ...current };
    if (body.portrait !== undefined) updated.portrait = body.portrait;
    if (body.step1 !== undefined) updated.step1 = body.step1;
    if (body.step2 !== undefined) updated.step2 = body.step2;
    if (body.studio !== undefined) updated.studio = body.studio;
    saveCharPrompts(updated);
    return json(res, { success: true, prompts: updated });
  });

  // POST /api/char-pipeline/pixel-char/portrait — FAST: photo → pixel art → standing portrait in one job
  router.post('/api/char-pipeline/pixel-char/portrait', async (req, res) => {
    const body = await parseBody(req);
    const { name, photoBase64 } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const charDir = path.join(TMP_DIR, 'characters', name);
    fs.mkdirSync(charDir, { recursive: true });
    const originalPath = path.join(charDir, 'original.png');

    if (photoBase64) {
      // Strip data URL prefix, decode, then re-encode to PNG via sharp
      // This normalises JPEG/WEBP/PNG to a clean PNG regardless of what the client sent
      const data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
      await sharp(Buffer.from(data, 'base64')).png().toFile(originalPath);
    } else if (!fs.existsSync(originalPath)) {
      return json(res, { error: 'Photo required' }, 400);
    }

    const jobId = startJob();

    setImmediate(async () => {
      try {
        const modelId = 'gemini-3-pro-image-preview';
        const client = new NanaBananaClient({ model: modelId });

        // Step 1: photo → pixel art
        updateJob(jobId, { step: 1, total: 2, msg: 'Step 1/2 — Converting photo to pixel art…' });
        const step1 = await client.generate(loadCharPrompts().step1, {
          referenceImages: [originalPath],
          aspectRatio: '3:4',
          resolution: '1K',
          model: modelId,
          maxRetries: 2,
          timeoutMs: 120000,
        });
        if (!step1.imageBuffer) throw new Error('Step 1 returned no image');
        const step1Path = path.join(charDir, 'step1-pixel.png');
        fs.writeFileSync(step1Path, step1.imageBuffer);
        recordCost(modelId, 'char_pipeline', '1K', 1, { character: name, step: 'portrait-step1' });

        // Step 2: pixel art → clean standing portrait
        updateJob(jobId, { step: 2, total: 2, msg: 'Step 2/2 — Building standing portrait…' });
        const step2 = await client.generate(loadCharPrompts().step2, {
          referenceImages: [step1Path],
          aspectRatio: '3:4',
          resolution: '1K',
          model: modelId,
          maxRetries: 2,
          timeoutMs: 120000,
        });
        if (!step2.imageBuffer) throw new Error('Step 2 returned no image');
        recordCost(modelId, 'char_pipeline', '1K', 1, { character: name, step: 'portrait-step2' });

        const previewPath = path.join(charDir, 'step2-preview.png');
        fs.writeFileSync(previewPath, step2.imageBuffer);
        const imageBase64 = 'data:image/png;base64,' + step2.imageBuffer.toString('base64');
        finishJob(jobId, { success: true, name, imageBase64 });
      } catch (err) {
        failJob(jobId, err.message);
      }
    });

    return json(res, { jobId, status: 'started' });
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
      await sharp(Buffer.from(data, 'base64')).png().toFile(originalPath);
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
          maxRetries: 3,
          timeoutMs: 150000,
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
          maxRetries: 3,
          timeoutMs: 150000,
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
      sbUpload(`${name}full.png`, portraitPath);

      // Store a small thumbnail (240×320) so portrait survives Railway redeploys
      const thumbBuf = await sharp(portraitPath).resize(240, 320, { fit: 'inside' }).png().toBuffer();
      const portraitThumb = thumbBuf.toString('base64');

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
        portraitBase64: portraitThumb,
        scaleMultiplier, pixelHeight,
        status: 'portrait_done',
      };
      saveCharacters(registry);
      scheduleSync();

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
        maxRetries: 3,
        timeoutMs: 150000,
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

        // Generate all 8 body angles in parallel — fastest possible
        const frames = await Promise.all(ANGLE_LABELS_8.map(async (angleLabel, i) => {
          const anglePrompt = [
            'Use the uploaded character as the EXACT base reference. Do not change face, skin tone, hairstyle, body shape, or outfit.',
            '',
            `Generate ONE single full-body pixel art sprite of this character viewed from the ${angleLabel} angle (${i * 45}°).`,
            '',
            'CRITICAL: ONE character only. Do NOT show multiple copies or duplicates of the character.',
            'CRITICAL: Do NOT tile, repeat, or show the character more than once.',
            'STYLE: Match the exact pixel art style of the reference. 16-bit GBA style. Bold black outlines. No anti-aliasing.',
            'BODY: Full body visible from head to toe. Neutral standing pose. Arms relaxed at sides.',
            'FRAMING: Single character centered in frame. Feet at bottom. Head near top. No cropping.',
            'BACKGROUND: Solid bright green (#00FF00). Nothing else.',
            'OUTPUT: Exactly one character. Square 1:1 frame. No text, no labels, no borders.',
          ].join('\n');

          const result = await client.generate(anglePrompt, {
            referenceImages,
            aspectRatio: '1:1',
            resolution: '1K',
            model: modelId,
            maxRetries: 2,
            timeoutMs: 150000,
          });

          const framePath = path.join(ASSETS_DIR, `${name}-angle-${i}.png`);
          fs.writeFileSync(framePath, result.imageBuffer);
          sbUpload(`${name}-angle-${i}.png`, framePath);
          recordCost(modelId, 'char_pipeline', '1K', referenceImages.length, { character: name, step: `body-angle-${i}` });

          await removeBackground(framePath, framePath);
          const tmpPath = framePath + '.crop.tmp.png';
          await cropToContent(framePath, tmpPath, { width: 180, height: 180, padding: 10 });
          fs.renameSync(tmpPath, framePath);

          return { index: i, label: angleLabel, url: `/assets/${name}-angle-${i}.png` };
        }));

        // Persist angle base64 in .characters.json so they survive Railway redeploys
        const registry = loadCharacters();
        if (!registry[name]) {
          // Safeguard: character was never confirmed (confirm step was skipped/interrupted).
          // Create a minimal but valid registry entry so the character is visible on the dashboard.
          registry[name] = {
            name, id: name,
            description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
            style: '16-bit pixel art, GBA style',
            heightInches: 72, weightLbs: 185, build: 'athletic',
            jerseyNumber: '', teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
            portraitPath: `${name}full.png`,
            scaleMultiplier: 1, pixelHeight: 32,
            status: 'portrait_done',
          };
        }
        registry[name].bodyAngles = {};
        for (const f of frames) {
          const p = path.join(ASSETS_DIR, `${name}-angle-${f.index}.png`);
          if (fs.existsSync(p)) registry[name].bodyAngles[f.index] = fs.readFileSync(p).toString('base64');
        }
        saveCharacters(registry);
        scheduleSync();
        finishJob(jobId, { success: true, name, frames });
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

        // Generate all 8 headshot angles in parallel
        const charDir = path.join(TMP_DIR, 'characters', name);
        fs.mkdirSync(charDir, { recursive: true });

        const frames = await Promise.all(ANGLE_LABELS_8.map(async (angleLabel, i) => {
          const anglePrompt = [
            'Use the uploaded character as the EXACT reference. Do not change face, skin tone, hairstyle, or features.',
            '',
            `Generate a single headshot of this character at the ${angleLabel} angle (${i * 45}°).`,
            '',
            'HEAD AND NECK ONLY — no shoulders, no shirt visible.',
            'STYLE: Match the exact pixel art style of the reference. 16-bit GBA style. Bold black outlines.',
            'FRAMING: Head centered. Clean white background.',
            'OUTPUT: Single headshot only. Square 1:1 frame. No text, no labels.',
          ].join('\n');

          const result = await client.generate(anglePrompt, {
            referenceImages: [portraitPath],
            aspectRatio: '1:1',
            resolution: '1K',
            model: modelId,
            maxRetries: 2,
            timeoutMs: 150000,
          });

          const framePath = path.join(ASSETS_DIR, `${name}-headshot-${i}.png`);
          fs.writeFileSync(framePath, result.imageBuffer);
          sbUpload(`${name}-headshot-${i}.png`, framePath);
          recordCost(modelId, 'char_pipeline', '1K', 1, { character: name, step: `head-angle-${i}` });

          return { index: i, label: angleLabel, url: `/assets/${name}-headshot-${i}.png` };
        }));

        // Persist headshot base64 in .characters.json
        const registry = loadCharacters();
        if (!registry[name]) {
          registry[name] = {
            name, id: name,
            description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
            style: '16-bit pixel art, GBA style',
            heightInches: 72, weightLbs: 185, build: 'athletic',
            jerseyNumber: '', teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
            portraitPath: `${name}full.png`,
            scaleMultiplier: 1, pixelHeight: 32,
            status: 'portrait_done',
          };
        }
        registry[name].headshots = {};
        for (const f of frames) {
          const p = path.join(ASSETS_DIR, `${name}-headshot-${f.index}.png`);
          if (fs.existsSync(p)) registry[name].headshots[f.index] = fs.readFileSync(p).toString('base64');
        }
        saveCharacters(registry);
        scheduleSync();
        finishJob(jobId, { success: true, name, frames });
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
        sbUpload(`${name}-final-${frame.index}.png`, destPath);
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
    scheduleSync();

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
          maxRetries: 3,
          timeoutMs: 150000,
        });

        // Center, save, and sync to git so it survives redeployment
        const centered = await centerFrame(result.imageBuffer);
        fs.writeFileSync(framePath, centered);
        scheduleSync();

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
      scheduleSync();
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
        sbUpload(`${name}-angle-${i}.png`, outPath);
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
    const { portraitBase64, topId, bottomId, topSubcategory, bottomSubcategory } = body;
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
        const modelId = 'gemini-3.1-flash-image-preview'; // flash for outfit swap — speed > quality
        const client = new NanaBananaClient({ model: modelId });

        const tmpDir = path.join(TMP_DIR, 'outfit-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpId = Date.now().toString(36);

        // Save starting portrait to temp file
        let currentPortraitPath = path.join(tmpDir, `portrait-${tmpId}.png`);
        const portraitData = portraitBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(currentPortraitPath, Buffer.from(portraitData, 'base64'));

        // Helper: resolve wardrobe item to a temp file path (images are stored as base64 in JSON)
        function wardrobeItemPath(id) {
          const item = wardrobe.find(i => i.id === id);
          if (!item) throw new Error(`Wardrobe item not found (id: ${id})`);
          const imgData = item.imageData;
          if (!imgData) throw new Error(`Wardrobe image data missing (id: ${id})`);
          const p = path.join(tmpDir, `wardrobe-${id}-${tmpId}.png`);
          fs.writeFileSync(p, Buffer.from(imgData, 'base64'));
          return p;
        }

        const genOpts = { aspectRatio: '3:4', resolution: '1K', model: modelId, maxRetries: 3, timeoutMs: 120000 };

        // Resolve subcategory labels for precise prompts
        const topLabel    = topSubcategory    || 'top garment';
        const bottomLabel = bottomSubcategory || 'bottom garment';

        if (topId) {
          const topPath = wardrobeItemPath(topId);
          const result = await client.generate(
            `Keep everything about this pixelated character exactly the same. Replace only their ${topLabel} with the one shown in the second image. Match the style, color and fit exactly.`,
            { referenceImages: [currentPortraitPath, topPath], ...genOpts }
          );
          const outPath = path.join(tmpDir, `after-top-${tmpId}.png`);
          fs.writeFileSync(outPath, result.imageBuffer);
          currentPortraitPath = outPath;
          recordCost(modelId, 'char_pipeline', '1K', 2, { step: 'apply-top' });
        }

        if (bottomId) {
          const bottomPath = wardrobeItemPath(bottomId);
          const result = await client.generate(
            `Keep everything about this pixelated character exactly the same. Replace only their ${bottomLabel} with the one shown in the second image. Match the style, color and fit exactly.`,
            { referenceImages: [currentPortraitPath, bottomPath], ...genOpts }
          );
          const outPath = path.join(tmpDir, `after-bottom-${tmpId}.png`);
          fs.writeFileSync(outPath, result.imageBuffer);
          currentPortraitPath = outPath;
          recordCost(modelId, 'char_pipeline', '1K', 2, { step: 'apply-bottom' });
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
