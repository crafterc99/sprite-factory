'use strict';
/**
 * Pose Import Route — POST /api/v2/pose/import
 * Accepts SAM 3D skeleton JSON, parses joints, stores on character record.
 */
const { parseSkeleton } = require('../modules/pose-import');
const { loadCharacters, saveCharacters } = require('./characters');

function register(router, ctx) {
  const { json, parseBody } = ctx;

  // POST /api/v2/pose/import
  // Body: { character, skeletonJson, poseSource?, netAnchor? }
  router.post('/api/v2/pose/import', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { character, skeletonJson, poseSource = 'manual', netAnchor } = body;

      if (!character)   return json(res, { error: 'character is required' }, 400);
      if (!skeletonJson) return json(res, { error: 'skeletonJson is required' }, 400);

      const parsed = parseSkeleton(skeletonJson, poseSource);

      const registry = loadCharacters();
      if (!registry[character]) {
        registry[character] = { name: character, created_at: new Date().toISOString() };
      }
      registry[character].skeleton_json = skeletonJson;
      registry[character].pose_source   = poseSource;
      registry[character].net_anchor    = netAnchor ?? { x: 480, y: 185 };
      registry[character].updated_at    = new Date().toISOString();
      await saveCharacters(registry);

      return json(res, {
        success: true,
        character,
        parsed: {
          facingAngleDeg: parsed.facingAngleDeg,
          bodyLean: parsed.bodyLean,
          kneeBend: parsed.kneeBend,
          proportions: parsed.proportions,
          directionHints: parsed.directionHints,
        },
      });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });

  // GET /api/v2/pose/:character — retrieve stored pose for a character
  router.get('/api/v2/pose/:character', (req, res, params) => {
    try {
      const registry = loadCharacters();
      const char = registry[params.character];
      if (!char) return json(res, { error: 'Character not found' }, 404);
      if (!char.skeleton_json) return json(res, { error: 'No pose data for this character' }, 404);

      const parsed = parseSkeleton(char.skeleton_json, char.pose_source ?? 'manual');
      return json(res, {
        character: params.character,
        pose_source: char.pose_source,
        net_anchor: char.net_anchor,
        parsed: {
          facingAngleDeg: parsed.facingAngleDeg,
          bodyLean: parsed.bodyLean,
          kneeBend: parsed.kneeBend,
          proportions: parsed.proportions,
          directionHints: parsed.directionHints,
        },
      });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });
}

module.exports = { register };
