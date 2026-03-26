/**
 * Export Routes — Grid sheet export, Soul Jam deploy, audit, templates
 */
const fs = require('fs');
const path = require('path');
const { buildGrid, GRID_LAYOUT } = require('../../sprite-processor/index');

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
      const { auditCharacter } = require('../../sprite-processor/consistency-checker');
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
      const { listTemplates } = require('../../sprite-generator/template-engine');
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
      const { saveTemplate } = require('../../sprite-generator/template-engine');
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
      const { loadTemplate } = require('../../sprite-generator/template-engine');
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
      const { applyTemplate } = require('../../sprite-generator/template-engine');
      const result = applyTemplate(params.id, body.character, ASSETS_DIR);
      return json(res, { success: true, ...result });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/templates/:id — Delete a template
  router.delete('/api/templates/:id', (req, res, params) => {
    try {
      const { deleteTemplate } = require('../../sprite-generator/template-engine');
      const result = deleteTemplate(params.id);
      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
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
