'use strict';
/**
 * Animation Contract API — v1
 *
 * Serves animation metadata contracts from data/assets/animations/v1/.
 * These contracts define the canonical frame format, states, and sprite sheet
 * layout that downstream consumers (playback, export, review) build against.
 *
 * Endpoints:
 *   GET /api/animation-contract             — list all available contracts
 *   GET /api/animation-contract/schema      — return the v1 schema definition
 *   GET /api/animation-contract/:character  — return a character's v1 contract
 */

const fs = require('fs');
const path = require('path');

const CONTRACT_DIR = path.resolve(__dirname, '../data/assets/animations/v1');

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function register(router, { json }) {
  // List all available character contracts
  router.get('/api/animation-contract', (req, res) => {
    let files;
    try {
      files = fs.readdirSync(CONTRACT_DIR);
    } catch {
      return json(res, { error: 'Animation contract directory not found' }, 500);
    }

    const characters = files
      .filter(f => f.endsWith('.json') && f !== 'schema.json')
      .map(f => f.replace('.json', ''));

    return json(res, {
      schemaVersion: '1.0.0',
      contractDir: 'data/assets/animations/v1/',
      characters,
    });
  });

  // Return the v1 schema definition
  router.get('/api/animation-contract/schema', (req, res) => {
    const schema = loadJSON(path.join(CONTRACT_DIR, 'schema.json'));
    if (!schema) return json(res, { error: 'Schema not found' }, 404);
    return json(res, schema);
  });

  // Return a specific character's animation contract
  router.get('/api/animation-contract/:character', (req, res, params) => {
    const character = params.character.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const contractPath = path.join(CONTRACT_DIR, `${character}.json`);
    const contract = loadJSON(contractPath);
    if (!contract) {
      return json(res, {
        error: `No animation contract found for character: ${character}`,
        hint: 'Check GET /api/animation-contract for available characters',
      }, 404);
    }
    return json(res, contract);
  });
}

module.exports = { register };
