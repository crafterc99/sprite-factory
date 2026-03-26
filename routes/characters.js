/**
 * Character Routes — CRUD + style conversion + roster
 */
const fs = require('fs');
const path = require('path');
const { CHARACTERS, ANIMATIONS } = require('../../sprite-generator/prompts');
const { NanaBananaClient } = require('../../sprite-generator/nano-banana');
const { recordCost } = require('../middleware/cost-tracker');

const CHARACTERS_FILE = path.resolve(__dirname, '../../../.characters.json');
const CUSTOM_ANIMS_FILE = path.resolve(__dirname, '../../../.custom-animations.json');

// ─── Persistent Character Registry ────────────────────────────────────

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

// ─── Custom Animation Registry ────────────────────────────────────────

function loadCustomAnimations() {
  try {
    if (fs.existsSync(CUSTOM_ANIMS_FILE)) return JSON.parse(fs.readFileSync(CUSTOM_ANIMS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveCustomAnimations(data) {
  const dir = path.dirname(CUSTOM_ANIMS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CUSTOM_ANIMS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get or initialize character data. Merges persistent JSON with runtime CHARACTERS.
 */
function getCharacterRegistry(assetsDir) {
  const persisted = loadCharacters();

  // Auto-discover from *full.png files
  if (fs.existsSync(assetsDir)) {
    const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('full.png'));
    for (const f of files) {
      const name = f.replace('full.png', '');
      if (!persisted[name]) {
        persisted[name] = {
          name,
          id: name,
          description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: '16-bit pixel art, GBA style',
          heightInches: 72, // default 6'0"
          weightLbs: 185,
          build: 'athletic',
          jerseyNumber: '',
          teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
          portraitPath: `${name}full.png`,
          originalPhotoPath: null,
          scaleMultiplier: 1.0,
          pixelHeight: 112,
          completedAnims: [],
          status: 'new',
        };
      }
      // Also ensure runtime CHARACTERS dict stays in sync
      if (!CHARACTERS[name]) {
        CHARACTERS[name] = {
          description: persisted[name].description || 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
          style: persisted[name].style || '16-bit pixel art, GBA style',
        };
      }
    }
  }

  return persisted;
}

function computeScale(heightInches) {
  const baseHeight = 72; // 6'0" baseline
  const scaleMultiplier = +(heightInches / baseHeight).toFixed(3);
  const pixelHeight = Math.round(111.6 * heightInches / baseHeight);
  return { scaleMultiplier, pixelHeight };
}

// ─── Route Handler ──────────────────────────────────────────────────────

function register(router, { ASSETS_DIR, TMP_DIR, runWithConcurrency, json, parseBody, serveImage }) {

  // GET /api/characters — List all characters
  router.get('/api/characters', (req, res) => {
    const registry = getCharacterRegistry(ASSETS_DIR);
    const customAnims = loadCustomAnimations();

    // Sync runtime CHARACTERS
    if (fs.existsSync(ASSETS_DIR)) {
      const files = fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('full.png'));
      for (const f of files) {
        const name = f.replace('full.png', '');
        if (!CHARACTERS[name]) {
          CHARACTERS[name] = {
            description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
            style: '16-bit pixel art, GBA style',
          };
        }
      }
    }

    // Merge predefined + custom animations
    const allAnimations = { ...ANIMATIONS, ...customAnims };
    return json(res, { characters: CHARACTERS, animations: allAnimations, registry, customAnimations: customAnims });
  });

  // GET /api/character/:name — Get a single character's full data
  router.get('/api/character/:name', (req, res, params) => {
    const registry = getCharacterRegistry(ASSETS_DIR);
    const name = params.name;
    const char = registry[name];
    if (!char) return json(res, { error: 'Character not found' }, 404);
    return json(res, { character: char });
  });

  // POST /api/character/save — Save/update character data
  router.post('/api/character/save', async (req, res) => {
    const body = await parseBody(req);
    const { name } = body;
    if (!name) return json(res, { error: 'name required' }, 400);

    const registry = getCharacterRegistry(ASSETS_DIR);
    const existing = registry[name] || {};

    const heightInches = body.heightInches || existing.heightInches || 72;
    const { scaleMultiplier, pixelHeight } = computeScale(heightInches);

    registry[name] = {
      ...existing,
      name,
      id: name,
      description: body.description || existing.description || 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
      style: body.style || existing.style || '16-bit pixel art, GBA style',
      heightInches,
      weightLbs: body.weightLbs || existing.weightLbs || 185,
      build: body.build || existing.build || 'athletic',
      jerseyNumber: body.jerseyNumber != null ? body.jerseyNumber : (existing.jerseyNumber || ''),
      teamColors: body.teamColors || existing.teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
      portraitPath: existing.portraitPath || `${name}full.png`,
      originalPhotoPath: body.originalPhotoPath || existing.originalPhotoPath || null,
      scaleMultiplier,
      pixelHeight,
      completedAnims: existing.completedAnims || [],
      status: existing.status || 'new',
    };

    // Sync to runtime CHARACTERS
    CHARACTERS[name] = {
      description: registry[name].description,
      style: registry[name].style,
      heightInches: registry[name].heightInches,
      weightLbs: registry[name].weightLbs,
      build: registry[name].build,
      jerseyNumber: registry[name].jerseyNumber,
      teamColors: registry[name].teamColors,
    };

    saveCharacters(registry);
    return json(res, { success: true, character: registry[name] });
  });

  // GET /api/sprites/:char — List all animation sprites for a character
  router.get('/api/sprites/:char', (req, res, params) => {
    const charName = params.char;
    const customAnims = loadCustomAnimations();
    const allAnims = { ...ANIMATIONS, ...customAnims };
    const anims = Object.keys(allAnims);
    const sprites = {};
    for (const anim of anims) {
      const file = `${charName}-${anim}.png`;
      const filePath = path.join(ASSETS_DIR, file);
      sprites[anim] = {
        exists: fs.existsSync(filePath),
        file,
        path: filePath,
        url: `/assets/${file}`,
        custom: !!customAnims[anim],
      };
    }
    return json(res, { character: charName, sprites });
  });

  // GET /api/reference-images?character=X&animation=Y
  router.get('/api/reference-images', (req, res, params, query) => {
    const character = query.character || '99';
    const animation = query.animation || 'static-dribble';

    const anim = ANIMATIONS[animation];
    const portraitPath = path.join(ASSETS_DIR, `${character}full.png`);
    const poseRefPath = anim?.breezyFile ? path.join(ASSETS_DIR, anim.breezyFile) : null;

    return json(res, {
      portrait: {
        exists: fs.existsSync(portraitPath),
        url: `/assets/${character}full.png`,
        label: `Image 2: ${character} portrait`,
      },
      poseRef: {
        exists: poseRefPath ? fs.existsSync(poseRefPath) : false,
        url: anim?.breezyFile ? `/assets/${anim.breezyFile}` : null,
        label: `Image 1: ${anim?.action || animation} (Breezy ref)`,
      },
    });
  });

  // ─── Character Creation (4-option picker) ──────────────────────────

  function buildCharPrompt(extraInstructions) {
    const styleRef = path.join(ASSETS_DIR, '99full.png');
    const hasStyleRef = fs.existsSync(styleRef);

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

    if (extraInstructions) {
      lines.push('', 'ADDITIONAL INSTRUCTIONS:', extraInstructions);
    }

    return { prompt: lines.join('\n'), hasStyleRef, styleRefPath: hasStyleRef ? styleRef : null };
  }

  // POST /api/character/create — Generate 4 options from photo
  router.post('/api/character/create', async (req, res) => {
    const body = await parseBody(req);
    const { name, photoBase64, photoPath, model, changeRequest, count } = body;
    if (!name) return json(res, { error: 'Character name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });

      let originalPath = path.join(charDir, 'original.png');
      if (photoBase64) {
        const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(originalPath, Buffer.from(base64Data, 'base64'));
      } else if (photoPath && fs.existsSync(photoPath)) {
        fs.copyFileSync(photoPath, originalPath);
      } else if (!fs.existsSync(originalPath)) {
        return json(res, { error: 'Photo required' }, 400);
      }

      const { prompt, hasStyleRef, styleRefPath } = buildCharPrompt(changeRequest);
      const client = new NanaBananaClient({ model: model || 'gemini-2.5-flash-image' });
      const numOptions = count || 4;

      const referenceImages = [];
      if (styleRefPath) referenceImages.push(styleRefPath);
      referenceImages.push(originalPath);

      const optionTasks = [];
      for (let i = 0; i < numOptions; i++) {
        const idx = i;
        optionTasks.push(async () => {
          try {
            const result = await client.generate(prompt, {
              referenceImages,
              aspectRatio: '3:4',
              resolution: '2K',
              model: model || 'gemini-2.5-flash-image',
            });
            const optPath = path.join(charDir, `option-${idx}.png`);
            fs.writeFileSync(optPath, result.imageBuffer);
            const charCost = recordCost(model || 'gemini-2.5-flash-image', 'character', '2K', referenceImages.length, { character: name, option: idx });
            return { index: idx, url: `/api/character/image/${name}/option-${idx}.png`, cost: charCost };
          } catch (err) {
            return { index: idx, error: err.message };
          }
        });
      }

      const options = await runWithConcurrency(optionTasks, 2, 3000);
      const successful = options.filter(o => !o.error);

      return json(res, {
        success: true,
        name,
        originalUrl: `/api/character/image/${name}/original.png`,
        options: successful,
        errors: options.filter(o => o.error),
        changeRequest: changeRequest || null,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/character/confirm — Pick the best option and save as final
  router.post('/api/character/confirm', async (req, res) => {
    const body = await parseBody(req);
    const { name, optionIndex, feedback, heightInches, weightLbs, build, jerseyNumber, teamColors } = body;
    if (!name) return json(res, { error: 'Character name required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      const optPath = path.join(charDir, `option-${optionIndex}.png`);
      if (!fs.existsSync(optPath)) return json(res, { error: 'Option not found' }, 404);

      const pixelPath = path.join(ASSETS_DIR, `${name}full.png`);
      fs.copyFileSync(optPath, pixelPath);

      // Register in runtime
      CHARACTERS[name] = {
        description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
        style: '16-bit pixel art, GBA style',
      };

      // Save extended data to registry
      const registry = getCharacterRegistry(ASSETS_DIR);
      const height = heightInches || 72;
      const { scaleMultiplier, pixelHeight } = computeScale(height);

      registry[name] = {
        ...(registry[name] || {}),
        name,
        id: name,
        description: CHARACTERS[name].description,
        style: CHARACTERS[name].style,
        heightInches: height,
        weightLbs: weightLbs || 185,
        build: build || 'athletic',
        jerseyNumber: jerseyNumber || '',
        teamColors: teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
        portraitPath: `${name}full.png`,
        scaleMultiplier,
        pixelHeight,
        status: 'portrait_done',
      };
      saveCharacters(registry);

      // Save training feedback
      const trainingFile = path.join(TMP_DIR, 'characters', 'training.json');
      let training = {};
      if (fs.existsSync(trainingFile)) training = JSON.parse(fs.readFileSync(trainingFile, 'utf8'));
      if (!training.sessions) training.sessions = [];
      training.sessions.push({
        name,
        selectedOption: optionIndex,
        feedback: feedback || '',
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(trainingFile, JSON.stringify(training, null, 2));

      return json(res, {
        success: true,
        name,
        pixelArtUrl: `/assets/${name}full.png`,
        character: registry[name],
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/character/upload-photo — Raw binary photo upload
  router.post('/api/character/upload-photo', async (req, res, params, query) => {
    const name = query.name;
    if (!name) return json(res, { error: 'name query param required' }, 400);

    try {
      const charDir = path.join(TMP_DIR, 'characters', name);
      fs.mkdirSync(charDir, { recursive: true });
      const photoPath = path.join(charDir, 'original.png');
      const writeStream = fs.createWriteStream(photoPath);
      await new Promise((resolve, reject) => {
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      return json(res, { success: true, photoPath, size: fs.statSync(photoPath).size });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/character/image/:name/:file — Serve character images
  router.get('/api/character/image/:name/:file', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, 'characters', params.name, params.file));
  });

  // DELETE /api/character/:name — Remove a character
  router.delete('/api/character/:name', (req, res, params) => {
    const name = params.name;
    const protectedChars = ['breezy', '99'];
    if (protectedChars.includes(name)) {
      return json(res, { error: 'Cannot delete core character' }, 400);
    }
    const portraitPath = path.join(ASSETS_DIR, `${name}full.png`);
    if (fs.existsSync(portraitPath)) fs.unlinkSync(portraitPath);
    delete CHARACTERS[name];

    // Remove from persistent registry
    const registry = loadCharacters();
    delete registry[name];
    saveCharacters(registry);

    return json(res, { success: true, deleted: name });
  });

  // ─── Roster ──────────────────────────────────────────────────────────

  // GET /api/roster
  router.get('/api/roster', (req, res) => {
    const registry = getCharacterRegistry(ASSETS_DIR);
    const customAnims = loadCustomAnimations();
    const allAnims = { ...ANIMATIONS, ...customAnims };
    const roster = [];
    const files = fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : [];
    const fullFiles = files.filter(f => f.endsWith('full.png'));

    for (const f of fullFiles) {
      const name = f.replace('full.png', '');
      const anims = Object.keys(allAnims);
      const sprites = {};
      let completedCount = 0;
      for (const anim of anims) {
        const spriteFile = `${name}-${anim}.png`;
        const exists = fs.existsSync(path.join(ASSETS_DIR, spriteFile));
        sprites[anim] = { exists, file: spriteFile, url: `/assets/${spriteFile}`, custom: !!customAnims[anim] };
        if (exists) completedCount++;
      }
      const gridFile = `${name}-spritesheet.png`;
      const hasGrid = fs.existsSync(path.join(ASSETS_DIR, gridFile));

      roster.push({
        name,
        portrait: `/assets/${f}`,
        portraitFile: f,
        sprites,
        completedAnims: completedCount,
        totalAnims: anims.length,
        hasGrid,
        gridUrl: hasGrid ? `/assets/${gridFile}` : null,
        ...(registry[name] || {}),
      });
    }

    return json(res, { roster, totalCharacters: roster.length });
  });

  // ─── Custom Animations CRUD ──────────────────────────────────────────

  // GET /api/animations — List all animations (predefined + custom)
  router.get('/api/animations', (req, res) => {
    const customAnims = loadCustomAnimations();
    const allAnims = { ...ANIMATIONS, ...customAnims };
    return json(res, {
      animations: allAnims,
      predefined: Object.keys(ANIMATIONS),
      custom: Object.keys(customAnims),
    });
  });

  // POST /api/animations/save — Create/update a custom animation
  router.post('/api/animations/save', async (req, res) => {
    const body = await parseBody(req);
    const { name, frames, fps, loop, action, frameBreakdown, source } = body;
    if (!name) return json(res, { error: 'Animation name required' }, 400);

    // Don't allow overwriting predefined animations
    if (ANIMATIONS[name]) return json(res, { error: `Cannot overwrite predefined animation: ${name}` }, 400);

    const customAnims = loadCustomAnimations();
    customAnims[name] = {
      frames: frames || 6,
      fps: fps || 8,
      loop: loop !== undefined ? loop : false,
      action: action || name,
      frameBreakdown: frameBreakdown || '',
      breezyFile: null, // Custom animations don't have Breezy references
      custom: true,
      source: source || 'video',
      createdAt: customAnims[name]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveCustomAnimations(customAnims);
    return json(res, { success: true, animation: customAnims[name], name });
  });

  // DELETE /api/animations/:name — Remove a custom animation
  router.delete('/api/animations/:name', (req, res, params) => {
    const name = params.name;
    if (ANIMATIONS[name]) return json(res, { error: 'Cannot delete predefined animation' }, 400);

    const customAnims = loadCustomAnimations();
    if (!customAnims[name]) return json(res, { error: 'Custom animation not found' }, 404);

    delete customAnims[name];
    saveCustomAnimations(customAnims);
    return json(res, { success: true, deleted: name });
  });

  // GET /api/animations/frames — Check if frames exist for a character+animation
  router.get('/api/animations/frames', (req, res, params, query) => {
    const character = query.character;
    const animation = query.animation;
    if (!character || !animation) return json(res, { error: 'character and animation query params required' }, 400);

    const customAnims = loadCustomAnimations();
    const allAnims = { ...ANIMATIONS, ...customAnims };
    const anim = allAnims[animation];
    if (!anim) return json(res, { error: 'Animation not found' }, 404);

    const framesDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
    const stripFile = path.join(ASSETS_DIR, `${character}-${animation}.png`);
    const hasStrip = fs.existsSync(stripFile);
    let frameFiles = [];
    if (fs.existsSync(framesDir)) {
      frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
    }

    return json(res, {
      character,
      animation,
      hasStrip,
      stripUrl: hasStrip ? `/assets/${character}-${animation}.png` : null,
      frameCount: frameFiles.length,
      frames: frameFiles.map((f, i) => ({
        index: i,
        url: `/assets/${character}-${animation}-frames/${f}`,
      })),
      animData: anim,
      isCustom: !!customAnims[animation],
    });
  });

  // GET /api/roster/:char/download
  router.get('/api/roster/:char/download', (req, res, params) => {
    const charName = params.char;
    const files = fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : [];
    const charFiles = files.filter(f => f.startsWith(charName));
    const assets = charFiles.map(f => ({
      file: f,
      url: `/assets/${f}`,
      size: fs.statSync(path.join(ASSETS_DIR, f)).size,
    }));
    return json(res, { character: charName, assets });
  });
}

module.exports = { register, loadCharacters, saveCharacters, getCharacterRegistry, computeScale, loadCustomAnimations, saveCustomAnimations };
