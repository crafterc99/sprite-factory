/**
 * Export Routes — Grid sheet export, Soul Jam deploy, audit, templates
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { buildGrid, GRID_LAYOUT } = require('../lib/sprite-processor/index');
const r2 = require('../lib/r2-storage');

const R2_GAME_PREFIX = 'game-assets';

const FRAME_SIZE = 180;
const SPRITE_FACTORY_ROOT = path.resolve(__dirname, '..');
const SOUL_JAM_PUBLIC_DIR = path.resolve(SPRITE_FACTORY_ROOT, '..', 'soul-jam', 'public');
const SOUL_JAM_IMAGES_DIR = path.join(SOUL_JAM_PUBLIC_DIR, 'assets', 'images');
const SOUL_JAM_REGISTRY_PATH = path.join(SOUL_JAM_PUBLIC_DIR, 'characters-registry.json');
const ASSETS_DIR_LOCAL = path.join(SPRITE_FACTORY_ROOT, 'data', 'assets');
const CONTRACT_PATH = path.join(SPRITE_FACTORY_ROOT, 'data', 'animation-contract.json');

// Soul Jam animation slots — maps Soul Jam animation names to sprite-factory strip names
const SOUL_JAM_SLOTS = {
  idleDribble: { sfAnim: 'static-dribble',   fps: 8,  repeat: -1 },
  runDribble:  { sfAnim: 'dribble',           fps: 10, repeat: -1 },
  jumpshot:    { sfAnim: 'jumpshot',          fps: 8,  repeat: 0  },
  stepback:    { sfAnim: 'stepback',          fps: 8,  repeat: 0  },
  crossover:   { sfAnim: 'crossover',         fps: 13, repeat: 0  },
  backpedal:   { sfAnim: 'defense-backpedal', fps: 8,  repeat: -1 },
  shuffle:     { sfAnim: 'defense-shuffle',   fps: 6,  repeat: -1 },
  steal:       { sfAnim: 'steal',             fps: 8,  repeat: 0  },
};

function loadContract() {
  try { return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')); } catch { return { animations: {} }; }
}

function loadRegistry() {
  try {
    if (fs.existsSync(SOUL_JAM_REGISTRY_PATH)) return JSON.parse(fs.readFileSync(SOUL_JAM_REGISTRY_PATH, 'utf8'));
  } catch {}
  return { version: '1', characters: {} };
}

function register(router, { ASSETS_DIR, json, parseBody }) {

  // GET /api/grid/:char — Build grid sheet
  router.get('/api/grid/:char', async (req, res, params) => {
    const charName = params.char;
    try {
      const result = await buildGrid(charName);
      return json(res, { success: true, ...result });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/audit/:char — Run full quality audit on a character
  router.post('/api/audit/:char', async (req, res, params) => {
    const charName = params.char;
    try {
      const { auditCharacter } = require('../lib/sprite-processor/consistency-checker');
      const report = await auditCharacter(charName, ASSETS_DIR);
      return json(res, { success: true, report });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // ─── Template Routes ─────────────────────────────────────────────────

  // GET /api/templates — List all templates
  router.get('/api/templates', (req, res, params, query) => {
    try {
      const { listTemplates } = require('../lib/sprite-generator/template-engine');
      const filter = {};
      if (query.animation) filter.animation = query.animation;
      if (query.character) filter.character = query.character;
      const templates = listTemplates(filter);
      return json(res, { templates });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/templates — Save a new template
  router.post('/api/templates', async (req, res) => {
    const body = await parseBody(req);
    try {
      const { saveTemplate } = require('../lib/sprite-generator/template-engine');
      const { character, animation, name, quality, model, promptSections } = body;

      const stripPath = path.join(ASSETS_DIR, `${character}-${animation}.png`);
      if (!fs.existsSync(stripPath)) {
        return json(res, { error: `Strip not found: ${character}-${animation}.png` }, 404);
      }

      const framesDir = path.join(ASSETS_DIR, `${character}-${animation}-frames`);
      let framePaths = [];
      if (fs.existsSync(framesDir)) {
        framePaths = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.png'))
          .sort()
          .map(f => path.join(framesDir, f));
      }

      const template = saveTemplate({
        character, animation, stripPath, framePaths,
        quality, model, promptSections,
        name: name || `${character} ${animation}`,
      });

      return json(res, { success: true, template });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/templates/:id — Get a template
  router.get('/api/templates/:id', (req, res, params) => {
    try {
      const { loadTemplate } = require('../lib/sprite-generator/template-engine');
      const template = loadTemplate(params.id);
      if (!template) return json(res, { error: 'Template not found' }, 404);
      return json(res, { template });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/templates/:id/apply — Apply template to a character
  router.post('/api/templates/:id/apply', async (req, res, params) => {
    const body = await parseBody(req);
    try {
      const { applyTemplate } = require('../lib/sprite-generator/template-engine');
      const result = applyTemplate(params.id, body.character, ASSETS_DIR);
      return json(res, { success: true, ...result });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/templates/:id — Delete a template
  router.delete('/api/templates/:id', (req, res, params) => {
    try {
      const { deleteTemplate } = require('../lib/sprite-generator/template-engine');
      const result = deleteTemplate(params.id);
      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // ─── Soul Jam Atlas Export ───────────────────────────────────────────

  // POST /api/export/soul-jam — Build atlas PNG + JSON for soul-jam game
  // Body: { character: string, animations?: string[] }
  router.post('/api/export/soul-jam', async (req, res) => {
    const body = await parseBody(req);
    const { character, animations: requestedAnims } = body;
    if (!character) return json(res, { error: 'character is required' }, 400);

    // Verify soul-jam directory exists
    if (!fs.existsSync(SOUL_JAM_IMAGES_DIR)) {
      return json(res, {
        error: `soul-jam assets directory not found: ${SOUL_JAM_IMAGES_DIR}`,
        hint: 'Clone the soul-jam repo as a sibling of sprite-factory at ../soul-jam',
      }, 404);
    }

    // Load animation contract for frame counts
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    } catch (e) {
      return json(res, { error: `Failed to load animation-contract.json: ${e.message}` }, 500);
    }

    // Determine which animations to include
    let animNames = requestedAnims;
    if (!animNames || animNames.length === 0) {
      // Default: all animations in contract that have files on disk
      animNames = Object.keys(contract.animations);
    }

    // Resolve animation strips — verify each file exists and get frame count
    const strips = [];
    const missing = [];
    for (const animName of animNames) {
      const stripPath = path.join(ASSETS_DIR_LOCAL, `${character}-${animName}.png`);
      if (!fs.existsSync(stripPath)) {
        missing.push(animName);
        continue;
      }
      // Frame count: from contract if available, else detect from image width
      let frames = contract.animations[animName]?.frames;
      if (!frames) {
        const meta = await sharp(stripPath).metadata();
        frames = Math.round(meta.width / FRAME_SIZE);
      }
      strips.push({ name: animName, path: stripPath, frames });
    }

    if (strips.length === 0) {
      return json(res, {
        error: `No animation strips found for character "${character}"`,
        missing,
        searched: ASSETS_DIR_LOCAL,
      }, 404);
    }

    // Sheet dimensions: width = max frames * FRAME_SIZE, height = strips * FRAME_SIZE
    const maxFrames = Math.max(...strips.map(s => s.frames));
    const sheetWidth = maxFrames * FRAME_SIZE;
    const sheetHeight = strips.length * FRAME_SIZE;

    // Composite all strips vertically
    const composites = [];
    for (let i = 0; i < strips.length; i++) {
      composites.push({
        input: strips[i].path,
        left: 0,
        top: i * FRAME_SIZE,
      });
    }

    const sheetFile = `${character}-spritesheet.png`;
    const jsonFile  = `${character}-spritesheet.json`;
    const sheetPath = path.join(SOUL_JAM_IMAGES_DIR, sheetFile);
    const jsonPath  = path.join(SOUL_JAM_IMAGES_DIR, jsonFile);

    try {
      await sharp({
        create: {
          width: sheetWidth,
          height: sheetHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(composites)
        .png()
        .toFile(sheetPath);
    } catch (e) {
      return json(res, { error: `Failed to composite sheet: ${e.message}` }, 500);
    }

    // Build atlas JSON — new contract schema (row/y/frames/width per animation)
    const atlasAnimations = {};
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      atlasAnimations[s.name] = {
        row: i,
        frames: s.frames,
        y: i * FRAME_SIZE,
        width: s.frames * FRAME_SIZE,
        fps: contract.animations[s.name]?.fps || 8,
        loop: contract.animations[s.name]?.loop ?? false,
      };
    }

    const atlas = {
      character,
      frameSize: FRAME_SIZE,
      width: sheetWidth,
      height: sheetHeight,
      animations: atlasAnimations,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(atlas, null, 2));

    const totalFrames = strips.reduce((acc, s) => acc + s.frames, 0);
    return json(res, {
      success: true,
      character,
      sheet_path: sheetPath,
      json_path: jsonPath,
      sheet_dimensions: { width: sheetWidth, height: sheetHeight },
      frame_count: totalFrames,
      animations_included: strips.map(s => s.name),
      animations_missing: missing,
    });
  });

  // ─── Deploy to Soul Jam ──────────────────────────────────────────────

  // GET /api/deploy/status — per-character deploy status vs Soul Jam
  router.get('/api/deploy/status', (req, res) => {
    const { CHARACTERS: promptChars } = require('../lib/sprite-generator/prompts');
    const { getCharacterRegistry } = require('./characters');
    const fileRegistry = getCharacterRegistry(ASSETS_DIR_LOCAL);
    // Merge: prompt system is canonical, file registry fills in portrait/name data
    const chars = { ...promptChars };
    for (const [id, data] of Object.entries(fileRegistry)) {
      if (id.startsWith('_')) continue;
      chars[id] = { ...chars[id], ...data };
    }
    const contract = loadContract();
    const reg = loadRegistry();
    const soulJamAvailable = fs.existsSync(SOUL_JAM_PUBLIC_DIR);

    const status = {};
    for (const [charId, charData] of Object.entries(chars)) {
      if (charId.startsWith('_') || !charData || typeof charData !== 'object') continue;

      const animations = {};
      let readyCount = 0;
      let deployedCount = 0;

      for (const [sjSlot, slotDef] of Object.entries(SOUL_JAM_SLOTS)) {
        const sfAnim = slotDef.sfAnim;
        const stripPath = path.join(ASSETS_DIR_LOCAL, `${charId}-${sfAnim}.png`);
        const ready = fs.existsSync(stripPath);
        if (ready) readyCount++;

        const deployedPath = path.join(SOUL_JAM_IMAGES_DIR, `${charId}-${sfAnim}.png`);
        const deployed = soulJamAvailable && fs.existsSync(deployedPath);
        if (deployed) deployedCount++;

        const contractAnim = contract.animations?.[sfAnim] || {};
        animations[sjSlot] = { sfAnim, ready, deployed, frames: contractAnim.frames || null };
      }

      status[charId] = {
        id: charId,
        name: charData.name || charId,
        portraitPath: charData.portraitPath || `${charId}full.png`,
        readyCount,
        deployedCount,
        totalSlots: Object.keys(SOUL_JAM_SLOTS).length,
        inRegistry: !!(reg.characters && reg.characters[charId]),
        animations,
      };
    }

    const r2RegistryUrl = r2.isAvailable()
      ? r2.getPublicUrl(`${R2_GAME_PREFIX}/characters-registry.json`)
      : null;
    return json(res, { status, soulJamAvailable, r2Available: r2.isAvailable(), r2RegistryUrl });
  });

  // POST /api/deploy/:char — Copy animation strips to Soul Jam + upload to R2 + update registry
  router.post('/api/deploy/:char', async (req, res, params) => {
    const charId = params.char.toLowerCase();
    const { CHARACTERS: promptChars } = require('../lib/sprite-generator/prompts');
    const { getCharacterRegistry } = require('./characters');
    const fileRegistry = getCharacterRegistry(ASSETS_DIR_LOCAL);
    const charData = { ...promptChars[charId], ...fileRegistry[charId] };
    if (!promptChars[charId] && !fileRegistry[charId]) return json(res, { error: `Character "${charId}" not found` }, 404);

    const contract = loadContract();
    const deployed = [];
    const missing = [];
    const animDefs = {};
    const useR2 = r2.isAvailable();

    for (const [sjSlot, slotDef] of Object.entries(SOUL_JAM_SLOTS)) {
      const sfAnim = slotDef.sfAnim;
      const srcPath = path.join(ASSETS_DIR_LOCAL, `${charId}-${sfAnim}.png`);
      if (!fs.existsSync(srcPath)) {
        missing.push({ slot: sjSlot, sfAnim });
        continue;
      }

      const destFile = `${charId}-${sfAnim}.png`;
      const r2Key = `${R2_GAME_PREFIX}/${destFile}`;

      const contractAnim = contract.animations?.[sfAnim] || {};
      const frames = contractAnim.frames || 4;
      const animEntry = {
        textureKey: `${charId}-${sfAnim}`,
        startFrame: 0,
        endFrame: frames - 1,
        fps: contractAnim.fps || slotDef.fps,
        repeat: slotDef.repeat,
      };

      // Upload to R2 if configured
      if (useR2) {
        try {
          await r2.uploadFile(r2Key, srcPath, 'image/png');
          animEntry.url = r2.getPublicUrl(r2Key);
        } catch (e) {
          console.error(`[deploy] R2 upload failed for ${destFile}:`, e.message);
        }
      }

      // Copy to local soul-jam dir if present (local dev convenience)
      if (fs.existsSync(SOUL_JAM_IMAGES_DIR)) {
        try { fs.copyFileSync(srcPath, path.join(SOUL_JAM_IMAGES_DIR, destFile)); } catch {}
      }

      animDefs[sjSlot] = animEntry;
      deployed.push({ slot: sjSlot, sfAnim, file: destFile, r2: !!animEntry.url });
    }

    // Build and persist registry
    const reg = loadRegistry();
    reg.characters[charId] = {
      id: charId,
      name: charData.name || charId,
      spriteSize: 180,
      deployedAt: new Date().toISOString(),
      animations: animDefs,
    };

    // Upload registry to R2 so Soul Jam can fetch it anywhere
    if (useR2) {
      try {
        await r2.uploadJson(`${R2_GAME_PREFIX}/characters-registry.json`, reg);
        reg._registryUrl = r2.getPublicUrl(`${R2_GAME_PREFIX}/characters-registry.json`);
      } catch (e) {
        console.error('[deploy] R2 registry upload failed:', e.message);
      }
    }

    // Also write registry locally (for local dev / soul-jam sibling dir)
    if (fs.existsSync(SOUL_JAM_PUBLIC_DIR)) {
      try { fs.writeFileSync(SOUL_JAM_REGISTRY_PATH, JSON.stringify(reg, null, 2)); } catch {}
    }

    return json(res, {
      success: true,
      character: charId,
      deployed: deployed.length,
      missing: missing.length,
      deployedAnims: deployed,
      missingAnims: missing,
      r2: useR2,
      registryUrl: reg._registryUrl || null,
      registryUpdated: true,
      totalInRegistry: Object.keys(reg.characters).length,
    });
  });
}

module.exports = { register };
