/**
 * Export Routes — Grid sheet export, Soul Jam deploy, audit, templates
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { buildGrid, GRID_LAYOUT } = require('../lib/sprite-processor/index');

const FRAME_SIZE = 180;
const SPRITE_FACTORY_ROOT = path.resolve(__dirname, '..');
const SOUL_JAM_IMAGES_DIR = path.resolve(SPRITE_FACTORY_ROOT, '..', 'soul-jam', 'public', 'assets', 'images');
const ASSETS_DIR_LOCAL = path.join(SPRITE_FACTORY_ROOT, 'data', 'assets');
const CONTRACT_PATH = path.join(SPRITE_FACTORY_ROOT, 'data', 'animation-contract.json');

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

  // POST /api/deploy/:char — Full deploy: build grid + generate game entries
  router.post('/api/deploy/:char', async (req, res, params) => {
    const charName = params.char;
    try {
      // 1. Build grid sheet
      const gridResult = await buildGrid(charName);

      // 2. Check which animations exist
      const anims = GRID_LAYOUT.map(row => {
        const stripFile = `${charName}-${row.name}.png`;
        return {
          name: row.name,
          frames: row.frames,
          exists: fs.existsSync(path.join(ASSETS_DIR, stripFile)),
        };
      });

      const completedAnims = anims.filter(a => a.exists);
      const missingAnims = anims.filter(a => !a.exists);

      // 3. Generate Characters.ts snippet
      const { loadCharacters } = require('./characters');
      const registry = loadCharacters();
      const charData = registry[charName] || {};

      const charactersEntry = [
        `  '${charName}': {`,
        `    name: '${charData.name || charName}',`,
        `    spritesheet: '${charName}-spritesheet',`,
        `    spritesheetPath: 'assets/images/${charName}-spritesheet.png',`,
        `    frameSize: 180,`,
        `    animations: {`,
        ...completedAnims.map(a => {
          const layout = GRID_LAYOUT.find(r => r.name === a.name);
          const row = GRID_LAYOUT.indexOf(layout);
          return `      '${a.name}': { row: ${row}, frames: ${a.frames}, fps: 8, loop: ${['static-dribble', 'dribble', 'defense-backpedal', 'defense-shuffle'].includes(a.name)} },`;
        }),
        `    },`,
        `  },`,
      ].join('\n');

      // 4. Generate PreloadScene.ts snippet
      const preloadEntry = `    this.load.spritesheet('${charName}-spritesheet', 'assets/images/${charName}-spritesheet.png', { frameWidth: 180, frameHeight: 180 });`;

      return json(res, {
        success: true,
        character: charName,
        grid: gridResult,
        completedAnims: completedAnims.length,
        missingAnims: missingAnims.map(a => a.name),
        gameIntegration: {
          charactersEntry,
          preloadEntry,
          instructions: [
            `1. Grid sheet saved to: ${gridResult.outputPath}`,
            `2. Add the following to Characters.ts:`,
            charactersEntry,
            `3. Add the following to PreloadScene.ts:`,
            preloadEntry,
            missingAnims.length > 0 ? `4. Missing animations: ${missingAnims.map(a => a.name).join(', ')}` : '4. All animations complete!',
          ],
        },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register };
