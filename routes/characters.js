/**
 * Character Routes — CRUD + style conversion + roster
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { CHARACTERS, ANIMATIONS } = require('../lib/sprite-generator/prompts');
const { NanaBananaClient } = require('../lib/sprite-generator/nano-banana');
const { recordCost } = require('../middleware/cost-tracker');
const { processSource, reprocessSource, adjustSource, loadSourceMeta } = require('../lib/upload-processor');
const { scheduleSync } = require('../lib/auto-git-sync');

const CHARACTERS_FILE = process.env.CHARACTERS_FILE || path.resolve(__dirname, '../data/.characters.json');
const CUSTOM_ANIMS_FILE = process.env.CUSTOM_ANIMS_FILE || path.resolve(__dirname, '../data/.custom-animations.json');

// ─── Character Package (layered asset structure) ───────────────────────

const ANGLE_NAMES = ['front', 'front_right', 'right', 'back_right', 'back', 'back_left', 'left', 'front_left'];
const CLOTHING_CATEGORIES = ['top', 'bottom', 'shoes', 'full_outfit'];
const SOURCE_TYPES = ['headshot', 'bodyshot', 'clothing'];

function packageDir(name, tmpDir) {
  return path.join(tmpDir, 'characters', name);
}

function packageFilePath(name, tmpDir) {
  return path.join(packageDir(name, tmpDir), 'package.json');
}

function loadPackage(name, tmpDir) {
  const pkgPath = packageFilePath(name, tmpDir);
  try {
    if (fs.existsSync(pkgPath)) return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {}
  return null;
}

function savePackage(pkg, name, tmpDir) {
  const dir = packageDir(name, tmpDir);
  fs.mkdirSync(dir, { recursive: true });
  pkg.updated_at = new Date().toISOString();
  fs.writeFileSync(packageFilePath(name, tmpDir), JSON.stringify(pkg, null, 2));
}

function defaultFit() {
  return { offset_x: 0, offset_y: 0, scale_x: 1.0, scale_y: 1.0 };
}

function initAngle(index) {
  return { index, file: null, url: null, status: 'pending' };
}

function initClothingSlot() {
  return { item_id: null, source_path: null, status: 'none', fit: defaultFit(), anchors: {} };
}

function initPackage(name) {
  const now = new Date().toISOString();
  const angles = {};
  ANGLE_NAMES.forEach((angleName, i) => { angles[angleName] = initAngle(i); });
  const clothing = { accessories: [] };
  CLOTHING_CATEGORIES.forEach(cat => { clothing[cat] = initClothingSlot(); });

  return {
    character_id: name,
    version: '1.0',
    created_at: now,
    updated_at: now,
    status: 'intake',
    sources: {
      headshot: { original_path: null, processed_path: null, meta_path: null, uploaded_at: null, status: 'pending', crop_box: null, bg_removed: false, user_adjusted: false },
      bodyshot: { original_path: null, processed_path: null, meta_path: null, uploaded_at: null, status: 'pending', crop_box: null, bg_removed: false, user_adjusted: false },
      clothing: [],
    },
    base: {
      head_master: { path: null, source: null, status: 'pending' },
      body_master: { path: null, source: null, status: 'pending' },
      portrait: { path: null, url: null, status: 'pending' },
    },
    clothing,
    angles,
    export: {
      status: 'pending',
      manifest_path: null,
      animation_pipeline_ready: false,
      exported_at: null,
    },
  };
}

function recomputePackageStatus(pkg) {
  const hasHead = ['ready', 'processed'].includes(pkg.sources.headshot.status);
  const hasBody = ['ready', 'processed'].includes(pkg.sources.bodyshot.status);
  const portraitReady = pkg.base.portrait.status === 'ready';
  const anglesReady = ANGLE_NAMES.every(a => pkg.angles[a].status === 'ready');

  if (anglesReady && portraitReady) {
    pkg.status = pkg.export.animation_pipeline_ready ? 'export_ready' : 'angles_ready';
  } else if (portraitReady) {
    pkg.status = 'portrait_ready';
  } else if (hasHead || hasBody) {
    pkg.status = 'sources_staged';
  } else {
    pkg.status = 'intake';
  }
  return pkg;
}

// ─── Persistent Character Registry ────────────────────────────────────

const { uploadFile: sbUpload, uploadJson: sbUploadJson, downloadFile: sbDownload, deleteFiles: sbDeleteFiles, isAvailable: sbAvailable } = require('../lib/r2-storage');
const { readJsonCached, writeJsonCached } = require('../lib/json-cache');
const SB_DELETED_KEY = '_meta/deleted-chars.json';
const SB_REGISTRY_KEY = '_meta/characters-full.json';

function loadCharacters() {
  return readJsonCached(CHARACTERS_FILE, {});
}

/** Returns the set of permanently deleted character names */
function loadDeletedSet() {
  const data = loadCharacters();
  return new Set(Array.isArray(data._deleted) ? data._deleted : []);
}

function saveCharacters(data) {
  const dir = path.dirname(CHARACTERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonCached(CHARACTERS_FILE, data);
  if (sbAvailable()) {
    const deleted = Array.isArray(data._deleted) ? data._deleted : [];
    sbUploadJson(SB_REGISTRY_KEY, data)
      .then(() => console.log(`[characters] ✓ R2 backup saved (${Object.keys(data).filter(k=>k!=='_deleted').length} chars)`))
      .catch(e => console.error('[characters] ✗ CRITICAL — R2 backup FAILED, data will be lost on redeploy:', e.message));
    if (deleted.length > 0) {
      sbUploadJson(SB_DELETED_KEY, { deleted }).catch(e => console.warn('[characters] deleted-list backup failed:', e.message));
    }
  }
}

/**
 * Called at startup — merges any deletions stored in Supabase into local registry.
 * Also checks the full registry backup in case git push failed to capture a deletion.
 * Returns the final Set of deleted character names so startup can skip re-downloading their files.
 */
async function syncDeletedFromStorage() {
  if (!sbAvailable()) return new Set();
  const remoteDeleted = new Set();
  try {
    // Primary source: full registry backup (most authoritative — includes all deletions)
    const fullBuf = await sbDownload(SB_REGISTRY_KEY);
    if (fullBuf) {
      const remoteRegistry = JSON.parse(fullBuf.toString('utf8'));
      if (Array.isArray(remoteRegistry._deleted)) {
        for (const n of remoteRegistry._deleted) remoteDeleted.add(n);
      }
      // Always restore registry from R2 — it is the source of truth, not git.
      // This overwrites any stale git-cloned .characters.json on every deploy.
      if (Object.keys(remoteRegistry).filter(k => k !== '_deleted').length > 0) {
        const dir = path.dirname(CHARACTERS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(remoteRegistry, null, 2));
        console.log(`  [characters] restored ${Object.keys(remoteRegistry).filter(k=>k!=='_deleted').length} character(s) from R2`);
      }
    }

    // Secondary source: dedicated deleted-chars backup (smaller, faster)
    const delBuf = await sbDownload(SB_DELETED_KEY);
    if (delBuf) {
      const { deleted } = JSON.parse(delBuf.toString('utf8'));
      if (Array.isArray(deleted)) {
        for (const n of deleted) remoteDeleted.add(n);
      }
    }

    if (remoteDeleted.size === 0) return new Set();

    const registry = loadCharacters();
    const localDeleted = new Set(Array.isArray(registry._deleted) ? registry._deleted : []);
    const merged = [...new Set([...localDeleted, ...remoteDeleted])];
    const newCount = merged.length - localDeleted.size;

    if (newCount > 0) {
      registry._deleted = merged;
      for (const name of merged) delete registry[name]; // remove any that came back via git
      // Write to disk only (don't re-upload — we just downloaded from R2)
      const dir = path.dirname(CHARACTERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(registry, null, 2));
      console.log(`  [characters] applied ${newCount} deletion(s) from R2`);
    }

    return new Set(merged);
  } catch (e) {
    console.warn('  [characters] R2 deletion sync failed (non-fatal):', e.message);
    return remoteDeleted;
  }
}

// ─── Custom Animation Registry ────────────────────────────────────────

function loadCustomAnimations() {
  return readJsonCached(CUSTOM_ANIMS_FILE, {});
}

function saveCustomAnimations(data) {
  const dir = path.dirname(CUSTOM_ANIMS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonCached(CUSTOM_ANIMS_FILE, data);
  if (sbAvailable()) sbUploadJson('_meta/custom-animations.json', data)
    .catch(e => console.error('[characters] custom-animations R2 backup FAILED:', e.message));
}

// ─── Clothing Registry ─────────────────────────────────────────────────

const CLOTHING_REGISTRY_FILE = path.resolve(__dirname, '../data/.clothing-registry.json');

function loadClothingRegistry() {
  return readJsonCached(CLOTHING_REGISTRY_FILE, { items: [] });
}

function saveClothingRegistry(registry) {
  fs.mkdirSync(path.dirname(CLOTHING_REGISTRY_FILE), { recursive: true });
  writeJsonCached(CLOTHING_REGISTRY_FILE, registry);
  if (sbAvailable()) sbUploadJson('_meta/clothing-registry.json', registry).catch(e => console.warn('[clothing-registry] R2 backup failed:', e.message));
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
      teamColors: existing.teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
      ratings: body.ratings || existing.ratings || null,
      portraitPath: existing.portraitPath || `${name}full.png`,
      originalPhotoPath: body.originalPhotoPath || existing.originalPhotoPath || null,
      scaleMultiplier,
      pixelHeight,
      scaleGroup:     body.scaleGroup     ?? existing.scaleGroup     ?? null,
      refNormEnabled: body.refNormEnabled ?? existing.refNormEnabled ?? true,
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
    scheduleSync();
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

  // POST /api/character/create — deprecated, use /api/char-pipeline/pixel-char/step1 + step2
  router.post('/api/character/create', (req, res) => {
    return json(res, { error: 'Use /api/char-pipeline/pixel-char/step1 and step2 instead' }, 410);
  });

  // POST /api/character/confirm — Pick the best option and save as final
  router.post('/api/character/confirm', async (req, res) => {
    const body = await parseBody(req);
    const { name, optionIndex, feedback, heightInches, weightLbs, build, jerseyNumber, teamColors, ratings } = body;
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
        teamColors: (registry[name] || {}).teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
        ratings: ratings || (registry[name] || {}).ratings || null,
        portraitPath: `${name}full.png`,
        scaleMultiplier,
        pixelHeight,
        status: 'portrait_done',
      };
      saveCharacters(registry);
      scheduleSync();

      // Fire-and-forget: kick off animation gap-fill for this character in the background.
      // Does not block the confirm response.
      (() => {
        const port = process.env.PORT || 3456;
        const body = JSON.stringify({ model: 'gemini-3-pro-image-preview' });
        const req = http.request(
          { hostname: 'localhost', port, path: `/api/pipeline/fill-gaps/${encodeURIComponent(name)}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          res => { res.resume(); } // drain response, don't block
        );
        req.on('error', err => console.error(`[fill-gaps] background trigger failed for ${name}:`, err.message));
        req.write(body);
        req.end();
      })();

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

  // POST /api/character/:name/ratings — update player ratings
  router.post('/api/character/:name/ratings', async (req, res, params) => {
    const body = await parseBody(req);
    const { ratings } = body;
    if (!ratings || typeof ratings !== 'object') return json(res, { error: 'ratings object required' }, 400);
    const registry = getCharacterRegistry(ASSETS_DIR);
    // Auto-register if discoverable (has portrait file) but not yet in JSON registry
    if (!registry[params.name]) {
      const portraitPath = path.join(ASSETS_DIR, `${params.name}full.png`);
      if (!fs.existsSync(portraitPath)) return json(res, { error: 'Character not found' }, 404);
      registry[params.name] = { name: params.name, id: params.name };
    }
    registry[params.name].ratings = { ...ratings };
    saveCharacters(registry);
    scheduleSync();
    return json(res, { success: true, ratings: registry[params.name].ratings });
  });

  // POST /api/character/:name/save-animation — attach a generated sprite to the character
  router.post('/api/character/:name/save-animation', async (req, res, params) => {
    const body = await parseBody(req);
    const { animId, animName, spriteUrl, fps, frameCount, angle, angleIndex } = body;
    if (!animId) return json(res, { error: 'animId required' }, 400);
    const registry = loadCharacters();
    // Auto-register character if they're in the roster (have angle files) but not in registry
    if (!registry[params.name]) {
      registry[params.name] = { name: params.name, id: params.name, savedAnimations: {} };
    }
    if (!registry[params.name].savedAnimations) registry[params.name].savedAnimations = {};
    registry[params.name].savedAnimations[animId] = {
      animId, animName: animName || animId, spriteUrl, fps: fps || 8, frameCount: frameCount || 1,
      angle: angle || null, angleIndex: angleIndex !== undefined ? angleIndex : null,
      savedAt: new Date().toISOString(),
    };
    saveCharacters(registry);
    scheduleSync();
    return json(res, { success: true, animation: registry[params.name].savedAnimations[animId] });
  });

  // DELETE /api/character/:name — Remove a character
  router.delete('/api/character/:name', async (req, res, params) => {
    const name = params.name;

    // Delete portrait and all angle/headshot assets from disk
    const assetsToDelete = fs.existsSync(ASSETS_DIR)
      ? fs.readdirSync(ASSETS_DIR).filter(f => f.startsWith(`${name}-`) || f === `${name}full.png`)
      : [];
    for (const f of assetsToDelete) {
      try { fs.unlinkSync(path.join(ASSETS_DIR, f)); } catch {}
    }
    delete CHARACTERS[name];

    // Remove from registry + add to tombstone list so safety net can't re-add them
    const registry = loadCharacters();
    delete registry[name];
    if (!Array.isArray(registry._deleted)) registry._deleted = [];
    if (!registry._deleted.includes(name)) registry._deleted.push(name);
    saveCharacters(registry);  // also backs up _deleted to R2

    // Delete from R2 — awaited so files don't come back on next redeploy
    if (sbAvailable()) {
      try {
        const { listFiles } = require('../lib/r2-storage');
        const files = await listFiles();
        const toRemove = files.filter(f =>
          f === `${name}full.png` ||
          f.startsWith(`${name}-`) ||
          f.startsWith(`applyf-${name}`)
        );
        if (toRemove.length > 0) await sbDeleteFiles(toRemove);
      } catch (e) {
        console.warn(`[characters] R2 deletion failed for "${name}" (files may reappear on redeploy):`, e.message);
      }
    }

    // git rm the deleted asset files so they don't come back on next redeploy
    const { scheduleSync: _sync, _gitRmAndSync } = require('../lib/auto-git-sync');
    if (assetsToDelete.length > 0) {
      _gitRmAndSync(assetsToDelete.map(f => `data/assets/${f}`));
    } else {
      _sync();
    }

    return json(res, { success: true, deleted: name });
  });

  // ─── Roster ──────────────────────────────────────────────────────────

  // GET /api/roster
  router.get('/api/roster', (req, res) => {
    // .characters.json is the source of truth — chars exist even if portrait file is missing
    const registry = loadCharacters();
    const deletedSet = new Set(Array.isArray(registry._deleted) ? registry._deleted : []);
    const customAnims = loadCustomAnimations();
    const allAnims = { ...ANIMATIONS, ...customAnims };
    const fileSet = new Set(fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : []);
    const roster = [];

    // Safety net: add portrait-file-only chars — but NEVER re-add deleted characters
    for (const f of fileSet) {
      if (!f.endsWith('full.png')) continue;
      const n = f.replace('full.png', '');
      if (deletedSet.has(n)) continue; // tombstoned — skip even if file exists on disk
      if (!registry[n]) {
        registry[n] = { name: n, id: n, status: 'portrait_done', portraitPath: f };
      }
    }

    for (const [name, charData] of Object.entries(registry)) {
      if (name === '_deleted') continue; // skip metadata key
      if (deletedSet.has(name)) continue; // skip tombstoned characters
      // Portrait: full.png on disk > angle-0 fallback
      let portrait = null;
      if (fileSet.has(`${name}full.png`)) portrait = `/assets/${name}full.png`;
      else if (fileSet.has(`${name}-angle-0.png`)) portrait = `/assets/${name}-angle-0.png`;

      const anims = Object.keys(allAnims);
      const sprites = {};
      let completedCount = 0;
      for (const anim of anims) {
        const spriteFile = `${name}-${anim}.png`;
        const exists = fileSet.has(spriteFile);
        sprites[anim] = { exists, file: spriteFile, url: `/assets/${spriteFile}`, custom: !!customAnims[anim] };
        if (exists) completedCount++;
      }
      const gridFile = `${name}-spritesheet.png`;
      const hasGrid = fileSet.has(gridFile);
      const bodyAnglesCount = [0,1,2,3,4,5,6,7].filter(i => fileSet.has(`${name}-angle-${i}.png`)).length;
      const headAnglesCount = [0,1,2,3,4,5,6,7].filter(i => fileSet.has(`${name}-headshot-${i}.png`)).length;

      roster.push({
        name,
        portrait,
        portraitFile: `${name}full.png`,
        sprites,
        completedAnims: completedCount,
        totalAnims: anims.length,
        hasGrid,
        gridUrl: hasGrid ? `/assets/${gridFile}` : null,
        bodyAnglesCount,
        headAnglesCount,
        hasBodyAngles: bodyAnglesCount === 8,
        hasHeadAngles: headAnglesCount === 8,
        ...charData,
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

  // ─── Character Package (layered upload pipeline) ──────────────────────

  // GET /api/character/:name/package — return current layered package state
  router.get('/api/character/:name/package', (req, res, params) => {
    const name = params.name;
    const pkg = loadPackage(name, TMP_DIR) || initPackage(name);

    // Hydrate angle status from files on disk (angles may have been added externally)
    ANGLE_NAMES.forEach((angleName, i) => {
      const angleFile = `${name}-angle-${i}.png`;
      const angleFullPath = path.join(ASSETS_DIR, angleFile);
      if (fs.existsSync(angleFullPath) && pkg.angles[angleName].status !== 'ready') {
        pkg.angles[angleName] = {
          index: i,
          file: angleFile,
          url: `/assets/${angleFile}`,
          status: 'ready',
        };
      }
    });

    // Hydrate portrait from assets disk
    const portraitFile = path.join(ASSETS_DIR, `${name}full.png`);
    if (fs.existsSync(portraitFile) && pkg.base.portrait.status !== 'ready') {
      pkg.base.portrait = {
        path: portraitFile,
        url: `/assets/${name}full.png`,
        status: 'ready',
      };
    }

    recomputePackageStatus(pkg);
    return json(res, { character_id: name, package: pkg });
  });

  // POST /api/character/upload-source — staged upload for headshot, bodyshot, or clothing
  // Query params: name (required), type (headshot|bodyshot|clothing), category (for clothing), label
  // Body: raw binary image
  router.post('/api/character/upload-source', async (req, res, params, query) => {
    const name = query.name;
    const type = query.type;
    const category = query.category || null;
    const label = query.label || null;

    if (!name) return json(res, { error: 'name query param required' }, 400);
    if (!SOURCE_TYPES.includes(type)) {
      return json(res, { error: `type must be one of: ${SOURCE_TYPES.join(', ')}` }, 400);
    }
    if (type === 'clothing' && !CLOTHING_CATEGORIES.includes(category)) {
      return json(res, { error: `clothing category must be one of: ${CLOTHING_CATEGORIES.join(', ')}` }, 400);
    }

    try {
      const sourceDir = path.join(TMP_DIR, 'characters', name, 'sources');
      fs.mkdirSync(sourceDir, { recursive: true });

      let destPath;
      if (type === 'clothing') {
        const clothingDir = path.join(sourceDir, 'clothing');
        fs.mkdirSync(clothingDir, { recursive: true });
        const itemId = `${category}-${Date.now()}`;
        destPath = path.join(clothingDir, `${itemId}.png`);
      } else {
        destPath = path.join(sourceDir, `${type}.png`);
      }

      const writeStream = fs.createWriteStream(destPath);
      await new Promise((resolve, reject) => {
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const size = fs.statSync(destPath).size;
      if (size === 0) return json(res, { error: 'Uploaded file is empty' }, 400);

      // Auto-process: detect subject, crop, normalize
      let processResult = null;
      let processError = null;
      try {
        processResult = await processSource(destPath, type === 'clothing' ? 'clothing' : type, {
          outputDir: type === 'clothing' ? path.dirname(destPath) : sourceDir,
        });
      } catch (err) {
        // Processing failure is non-fatal — original is still stored
        processError = err.message;
      }

      const now = new Date().toISOString();
      const pkg = loadPackage(name, TMP_DIR) || initPackage(name);

      if (type === 'headshot') {
        const activePath = processResult ? processResult.processedPath : destPath;
        pkg.sources.headshot = {
          original_path: destPath,
          processed_path: processResult ? processResult.processedPath : null,
          meta_path: processResult ? processResult.metaPath : null,
          uploaded_at: now,
          status: processResult ? 'processed' : 'ready',
          crop_box: processResult ? processResult.meta.crop : null,
          bg_removed: processResult ? processResult.meta.bg_detection !== 'fallback_full_image' : false,
          user_adjusted: false,
        };
        if (pkg.base.head_master.status !== 'ready') {
          pkg.base.head_master = { path: activePath, source: 'headshot', status: 'ready' };
        }
      } else if (type === 'bodyshot') {
        const activePath = processResult ? processResult.processedPath : destPath;
        pkg.sources.bodyshot = {
          original_path: destPath,
          processed_path: processResult ? processResult.processedPath : null,
          meta_path: processResult ? processResult.metaPath : null,
          uploaded_at: now,
          status: processResult ? 'processed' : 'ready',
          crop_box: processResult ? processResult.meta.crop : null,
          bg_removed: processResult ? processResult.meta.bg_detection !== 'fallback_full_image' : false,
          user_adjusted: false,
        };
        if (pkg.base.body_master.status !== 'ready') {
          pkg.base.body_master = { path: activePath, source: 'bodyshot', status: 'ready' };
        }
        if (pkg.base.head_master.status !== 'ready') {
          pkg.base.head_master = { path: activePath, source: 'extracted_from_bodyshot', status: 'ready' };
        }
      } else if (type === 'clothing') {
        const itemId = path.basename(destPath, '.png');
        const clothingEntry = {
          item_id: itemId,
          category,
          label: label || category,
          path: destPath,
          processed_path: processResult ? processResult.processedPath : null,
          meta_path: processResult ? processResult.metaPath : null,
          processing_error: processError || null,
          uploaded_at: now,
          status: 'ready',
        };
        pkg.sources.clothing.push(clothingEntry);
        if (!pkg.clothing[category]) pkg.clothing[category] = initClothingSlot();
        pkg.clothing[category].item_id = itemId;
        pkg.clothing[category].source_path = destPath;
        pkg.clothing[category].processed_path = processResult ? processResult.processedPath : null;
        pkg.clothing[category].status = 'ready';
      }

      recomputePackageStatus(pkg);
      savePackage(pkg, name, TMP_DIR);

      // Build serve URLs for processed image
      const processedFileName = processResult ? path.basename(processResult.processedPath) : null;
      const processedUrl = processedFileName
        ? `/api/character/image/${name}/sources/${processedFileName}`
        : null;

      return json(res, {
        success: true,
        name,
        type,
        category: category || null,
        path: destPath,
        size,
        processed_url: processedUrl,
        processing: processResult ? {
          status: 'ok',
          bg_detection: processResult.meta.bg_detection,
          subject_pixels: processResult.meta.subject_pixels,
          detected_bounds: processResult.meta.detected_bounds,
          crop: processResult.meta.crop,
          output_dimensions: processResult.meta.output_dimensions,
        } : { status: 'failed', error: processError },
        package_status: pkg.status,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/character/:name/clothing — return all clothing slots with state and serve URLs
  router.get('/api/character/:name/clothing', (req, res, params) => {
    const name = params.name;
    const pkg = loadPackage(name, TMP_DIR) || initPackage(name);
    const slots = {};

    CLOTHING_CATEGORIES.forEach(cat => {
      const slot = pkg.clothing[cat] || initClothingSlot();
      const sourceFile = slot.source_path ? path.basename(slot.source_path) : null;
      const processedFile = slot.processed_path ? path.basename(slot.processed_path) : null;
      slots[cat] = {
        item_id: slot.item_id,
        status: slot.status,
        source_url: sourceFile ? `/api/character/image/${name}/sources/clothing/${sourceFile}` : null,
        processed_url: processedFile ? `/api/character/image/${name}/sources/clothing/${processedFile}` : null,
        fit: slot.fit,
        anchors: slot.anchors,
      };
    });

    return json(res, {
      character_id: name,
      clothing: slots,
      categories: CLOTHING_CATEGORIES,
    });
  });

  // POST /api/character/:name/clothing/:category/fit — update clothing fit/offset metadata
  router.post('/api/character/:name/clothing/:category/fit', async (req, res, params) => {
    const { name, category } = params;
    if (!CLOTHING_CATEGORIES.includes(category)) {
      return json(res, { error: `category must be one of: ${CLOTHING_CATEGORIES.join(', ')}` }, 400);
    }

    const body = await parseBody(req);
    const pkg = loadPackage(name, TMP_DIR);
    if (!pkg) return json(res, { error: 'No package found for this character' }, 404);
    if (!pkg.clothing[category] || pkg.clothing[category].status === 'none') {
      return json(res, { error: `No ${category} clothing in package` }, 404);
    }

    const fit = pkg.clothing[category].fit;

    // Validate and clamp fit values — offset in pixels (±500 max), scale 0.1–5.0
    function safeNum(val, fallback) {
      const n = Number(val);
      return isNaN(n) ? fallback : n;
    }
    if (body.offset_x != null) fit.offset_x = Math.max(-500, Math.min(500, safeNum(body.offset_x, fit.offset_x)));
    if (body.offset_y != null) fit.offset_y = Math.max(-500, Math.min(500, safeNum(body.offset_y, fit.offset_y)));
    if (body.scale_x != null) fit.scale_x = Math.max(0.1, Math.min(5.0, safeNum(body.scale_x, fit.scale_x)));
    if (body.scale_y != null) fit.scale_y = Math.max(0.1, Math.min(5.0, safeNum(body.scale_y, fit.scale_y)));

    if (body.anchors && typeof body.anchors === 'object') {
      pkg.clothing[category].anchors = { ...pkg.clothing[category].anchors, ...body.anchors };
    }

    savePackage(pkg, name, TMP_DIR);
    return json(res, { success: true, category, fit: pkg.clothing[category].fit, anchors: pkg.clothing[category].anchors });
  });

  // POST /api/character/:name/clothing/:category/fit/reset — reset fit to defaults
  router.post('/api/character/:name/clothing/:category/fit/reset', (req, res, params) => {
    const { name, category } = params;
    if (!CLOTHING_CATEGORIES.includes(category)) {
      return json(res, { error: `category must be one of: ${CLOTHING_CATEGORIES.join(', ')}` }, 400);
    }
    const pkg = loadPackage(name, TMP_DIR);
    if (!pkg) return json(res, { error: 'No package found' }, 404);
    if (!pkg.clothing[category] || pkg.clothing[category].status === 'none') {
      return json(res, { error: `No ${category} clothing in package` }, 404);
    }
    pkg.clothing[category].fit = { offset_x: 0, offset_y: 0, scale_x: 1.0, scale_y: 1.0 };
    pkg.clothing[category].anchors = {};
    savePackage(pkg, name, TMP_DIR);
    return json(res, { success: true, category, fit: pkg.clothing[category].fit });
  });

  // DELETE /api/character/:name/clothing/:category — remove clothing item from slot
  router.delete('/api/character/:name/clothing/:category', (req, res, params) => {
    const { name, category } = params;
    if (!CLOTHING_CATEGORIES.includes(category)) {
      return json(res, { error: `category must be one of: ${CLOTHING_CATEGORIES.join(', ')}` }, 400);
    }
    const pkg = loadPackage(name, TMP_DIR);
    if (!pkg) return json(res, { error: 'No package found' }, 404);

    // Remove from clothing slot
    pkg.clothing[category] = initClothingSlot();

    // Remove from sources.clothing list
    pkg.sources.clothing = pkg.sources.clothing.filter(
      c => c.category !== category
    );

    savePackage(pkg, name, TMP_DIR);
    return json(res, { success: true, category, status: 'removed' });
  });

  // POST /api/character/apply-clothing — apply a registry clothing item to a character slot
  router.post('/api/character/apply-clothing', async (req, res) => {
    const body = await parseBody(req);
    const { character, item_id, category } = body;
    if (!character || !item_id || !category) {
      return json(res, { error: 'character, item_id, and category are required' }, 400);
    }
    if (!CLOTHING_CATEGORIES.includes(category)) {
      return json(res, { error: `category must be one of: ${CLOTHING_CATEGORIES.join(', ')}` }, 400);
    }
    try {
      const registry = loadClothingRegistry();
      const item = registry.items.find(i => i.id === item_id);
      if (!item) return json(res, { error: `Clothing item '${item_id}' not found in registry` }, 404);

      let pkg = loadPackage(character, TMP_DIR);
      if (!pkg) pkg = initPackage(character);

      pkg.clothing[category] = {
        ...initClothingSlot(),
        item_id: item.id,
        source_path: item.asset_path,
        anchors: item.anchors || {},
        status: 'applied',
        fit: pkg.clothing[category]?.fit || defaultFit(),
      };

      recomputePackageStatus(pkg);
      savePackage(pkg, character, TMP_DIR);

      return json(res, {
        success: true,
        character,
        category,
        applied: {
          item_id: item.id,
          name: item.name,
          type: item.type,
          asset_path: item.asset_path,
          anchors: item.anchors,
          status: 'applied',
        },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/character/:name/sources/:type/reprocess — re-run processing with manual adjustments
  // Body: { adjustments: { top_trim, bottom_trim, left_trim, right_trim, top_expand, bottom_expand,
  //                        left_expand, right_expand, zoom }, save: true|false }
  // save=false (preview mode): runs processing, returns result, does NOT update package
  // save=true (default): runs processing and commits result to package.json
  router.post('/api/character/:name/sources/:type/reprocess', async (req, res, params) => {
    const { name, type } = params;
    if (!['headshot', 'bodyshot', 'clothing'].includes(type)) {
      return json(res, { error: 'type must be headshot, bodyshot, or clothing' }, 400);
    }

    try {
      const sourceDir = path.join(TMP_DIR, 'characters', name, 'sources');
      const metaPath = path.join(sourceDir, `${type}-meta.json`);
      if (!fs.existsSync(metaPath)) {
        return json(res, { error: `No processing metadata found for ${type} — upload first` }, 404);
      }

      const body = await parseBody(req);
      const adjustments = body.adjustments || {};
      // save defaults to true for backward compat; pass save:false for preview
      const shouldSave = body.save !== false;

      const processResult = await reprocessSource(metaPath, adjustments);

      // Only update package when save=true
      if (shouldSave) {
        const pkg = loadPackage(name, TMP_DIR);
        if (pkg) {
          const src = type === 'headshot' ? pkg.sources.headshot : pkg.sources.bodyshot;
          if (src) {
            src.processed_path = processResult.processedPath;
            src.meta_path = processResult.metaPath;
            src.crop_box = processResult.meta.crop;
            src.user_adjusted = Object.keys(adjustments).some(k => adjustments[k] !== 0 && adjustments[k] !== 1.0);
            src.status = 'processed';
          }
          if (type === 'headshot' && pkg.base.head_master.source === 'headshot') {
            pkg.base.head_master.path = processResult.processedPath;
          }
          if (type === 'bodyshot') {
            if (pkg.base.body_master.source === 'bodyshot') {
              pkg.base.body_master.path = processResult.processedPath;
            }
            if (pkg.base.head_master.source === 'extracted_from_bodyshot') {
              pkg.base.head_master.path = processResult.processedPath;
            }
          }
          savePackage(pkg, name, TMP_DIR);
        }
      }

      const processedFileName = path.basename(processResult.processedPath);
      return json(res, {
        success: true,
        type,
        saved: shouldSave,
        processed_url: `/api/character/image/${name}/sources/${processedFileName}`,
        processing: {
          status: 'ok',
          bg_detection: processResult.meta.bg_detection,
          detected_bounds: processResult.meta.detected_bounds,
          crop: processResult.meta.crop,
          output_dimensions: processResult.meta.output_dimensions,
          manual_adjustments: processResult.meta.manual_adjustments,
        },
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/character/:name/source/:type/adjust — direct crop_box adjustment
  // Body: { crop_box: {x,y,w,h}, offset_x, offset_y, scale }
  // crop_box is in original image pixel coordinates. All fields optional.
  // Replaces processed_path with adjusted result. Always saves to package.
  router.post('/api/character/:name/source/:type/adjust', async (req, res, params) => {
    const { name, type } = params;
    if (!['headshot', 'bodyshot', 'clothing'].includes(type)) {
      return json(res, { error: 'type must be headshot, bodyshot, or clothing' }, 400);
    }

    try {
      const pkg = loadPackage(name, TMP_DIR);
      if (!pkg) return json(res, { error: 'No package found for this character — upload first' }, 404);

      const src = type === 'headshot' ? pkg.sources.headshot
        : type === 'bodyshot' ? pkg.sources.bodyshot
        : null;

      const originalPath = src ? src.original_path : null;
      if (!originalPath || !fs.existsSync(originalPath)) {
        return json(res, { error: `Original ${type} source not found — upload first` }, 404);
      }

      const body = await parseBody(req);
      const sourceDir = path.join(TMP_DIR, 'characters', name, 'sources');

      const result = await adjustSource(originalPath, type, sourceDir, {
        crop_box: body.crop_box || null,
        offset_x: body.offset_x || 0,
        offset_y: body.offset_y || 0,
        scale: body.scale || 1.0,
      });

      // Update package
      if (src) {
        src.processed_path = result.adjustedPath;
        src.crop_box = result.cropBox;
        src.user_adjusted = true;
        src.status = 'processed';
      }
      // Keep base masters in sync
      if (type === 'headshot' && pkg.base.head_master.source === 'headshot') {
        pkg.base.head_master.path = result.adjustedPath;
      }
      if (type === 'bodyshot') {
        if (pkg.base.body_master.source === 'bodyshot') {
          pkg.base.body_master.path = result.adjustedPath;
        }
        if (pkg.base.head_master.source === 'extracted_from_bodyshot') {
          pkg.base.head_master.path = result.adjustedPath;
        }
      }
      savePackage(pkg, name, TMP_DIR);

      const adjustedFileName = path.basename(result.adjustedPath);
      return json(res, {
        success: true,
        type,
        adjusted_url: `/api/character/image/${name}/sources/${adjustedFileName}`,
        crop_box: result.cropBox,
        output_dimensions: result.outputDimensions,
        validation: result.validation,
      });
    } catch (err) {
      // Surface validation errors (zero-size, out-of-bounds) as 400
      const isValidation = err.message.includes('zero-size') || err.message.includes('clamping');
      return json(res, { error: err.message }, isValidation ? 400 : 500);
    }
  });

  // GET /api/character/:name/sources/:type/meta — return current processing metadata
  router.get('/api/character/:name/sources/:type/meta', (req, res, params) => {
    const { name, type } = params;
    const sourceDir = path.join(TMP_DIR, 'characters', name, 'sources');
    const meta = loadSourceMeta(sourceDir, type);
    if (!meta) return json(res, { error: `No processing metadata for ${type}` }, 404);
    return json(res, { type, meta });
  });

  // POST /api/character/:name/package/sync-angles — scan disk and mark ready angles
  router.post('/api/character/:name/package/sync-angles', (req, res, params) => {
    const name = params.name;
    const pkg = loadPackage(name, TMP_DIR) || initPackage(name);

    const synced = [];
    ANGLE_NAMES.forEach((angleName, i) => {
      const angleFile = `${name}-angle-${i}.png`;
      const angleFullPath = path.join(ASSETS_DIR, angleFile);
      if (fs.existsSync(angleFullPath)) {
        pkg.angles[angleName] = { index: i, file: angleFile, url: `/assets/${angleFile}`, status: 'ready' };
        synced.push(angleName);
      }
    });

    // Sync portrait too
    const portraitFile = path.join(ASSETS_DIR, `${name}full.png`);
    if (fs.existsSync(portraitFile)) {
      pkg.base.portrait = { path: portraitFile, url: `/assets/${name}full.png`, status: 'ready' };
    }

    recomputePackageStatus(pkg);
    savePackage(pkg, name, TMP_DIR);

    return json(res, {
      success: true,
      character_id: name,
      package_status: pkg.status,
      angles_synced: synced,
      angles_ready: ANGLE_NAMES.filter(a => pkg.angles[a].status === 'ready'),
      angles_pending: ANGLE_NAMES.filter(a => pkg.angles[a].status === 'pending'),
    });
  });

  // POST /api/character/:name/package/export — build export manifest for animation pipeline
  router.post('/api/character/:name/package/export', (req, res, params) => {
    const name = params.name;
    const pkg = loadPackage(name, TMP_DIR) || initPackage(name);

    // Sync disk state before export
    const portraitFile = path.join(ASSETS_DIR, `${name}full.png`);
    if (fs.existsSync(portraitFile)) {
      pkg.base.portrait = { path: portraitFile, url: `/assets/${name}full.png`, status: 'ready' };
    }
    ANGLE_NAMES.forEach((angleName, i) => {
      const angleFile = `${name}-angle-${i}.png`;
      const angleFullPath = path.join(ASSETS_DIR, angleFile);
      if (fs.existsSync(angleFullPath)) {
        pkg.angles[angleName] = { index: i, file: angleFile, url: `/assets/${angleFile}`, status: 'ready' };
      }
    });
    recomputePackageStatus(pkg);

    if (pkg.base.portrait.status !== 'ready') {
      return json(res, { error: 'Portrait not ready — confirm character before exporting' }, 400);
    }

    const registry = getCharacterRegistry(ASSETS_DIR);
    const charMeta = registry[name] || {};

    const manifest = {
      character_id: name,
      package_version: '1.0',
      portrait_url: pkg.base.portrait.url,
      portrait_path: pkg.base.portrait.path,
      angles: {},
      clothing_layers: {},
      character_meta: {
        heightInches: charMeta.heightInches || 72,
        weightLbs: charMeta.weightLbs || 185,
        build: charMeta.build || 'athletic',
        jerseyNumber: charMeta.jerseyNumber || '',
        teamColors: charMeta.teamColors || { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
        scaleMultiplier: charMeta.scaleMultiplier || 1.0,
        pixelHeight: charMeta.pixelHeight || 112,
      },
      exported_at: new Date().toISOString(),
    };

    ANGLE_NAMES.forEach(angleName => {
      const a = pkg.angles[angleName];
      manifest.angles[angleName] = a.status === 'ready'
        ? { url: a.url, path: path.join(ASSETS_DIR, a.file) }
        : { url: null, path: null };
    });

    CLOTHING_CATEGORIES.forEach(cat => {
      const c = pkg.clothing[cat];
      manifest.clothing_layers[cat] = {
        item_id: c?.item_id || null,
        url: c?.source_path ? `/api/character/image/${name}/sources/clothing/${path.basename(c.source_path)}` : null,
        fit: c?.fit || { offset_x: 0, offset_y: 0, scale_x: 1.0, scale_y: 1.0 },
      };
    });

    const manifestPath = path.join(TMP_DIR, 'characters', name, 'export-manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    pkg.export = {
      status: 'ready',
      manifest_path: manifestPath,
      animation_pipeline_ready: true,
      exported_at: manifest.exported_at,
    };
    recomputePackageStatus(pkg);
    savePackage(pkg, name, TMP_DIR);

    return json(res, { success: true, character_id: name, package_status: pkg.status, manifest });
  });

  // GET /api/character/image/:name/sources/:file — serve staged source images
  router.get('/api/character/image/:name/sources/:file', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, 'characters', params.name, 'sources', params.file));
  });

  // GET /api/character/image/:name/sources/clothing/:file
  router.get('/api/character/image/:name/sources/clothing/:file', (req, res, params) => {
    return serveImage(res, path.join(TMP_DIR, 'characters', params.name, 'sources', 'clothing', params.file));
  });

  // GET /api/clothing — list all clothing items in the registry
  router.get('/api/clothing', (req, res) => {
    try {
      const registry = loadClothingRegistry();
      return json(res, { items: registry.items, count: registry.items.length });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/clothing — add a clothing item to the registry
  router.post('/api/clothing', async (req, res) => {
    const body = await parseBody(req);
    const { id, type, name, asset_path, anchors, tags } = body;
    if (!id || !type || !asset_path) return json(res, { error: 'id, type, and asset_path required' }, 400);
    const VALID_TYPES = ['top', 'bottom', 'shoes', 'full_outfit'];
    if (!VALID_TYPES.includes(type)) return json(res, { error: `type must be one of: ${VALID_TYPES.join(', ')}` }, 400);
    try {
      const registry = loadClothingRegistry();
      if (registry.items.find(i => i.id === id)) return json(res, { error: `Item with id '${id}' already exists` }, 409);
      const item = { id, type, name: name || id, asset_path, anchors: anchors || {}, tags: tags || [], created_at: new Date().toISOString() };
      registry.items.push(item);
      saveClothingRegistry(registry);
      return json(res, { success: true, item });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/clothing/:id — remove a clothing item from the registry
  router.delete('/api/clothing/:id', (req, res, params) => {
    const { id } = params;
    try {
      const registry = loadClothingRegistry();
      const before = registry.items.length;
      registry.items = registry.items.filter(i => i.id !== id);
      if (registry.items.length === before) return json(res, { error: `Item '${id}' not found` }, 404);
      saveClothingRegistry(registry);
      return json(res, { success: true, deleted: id });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/character/:name/head-override
  // Body: { angle, body: { sourceAngle }, clothes: { sourceAngle } }
  // Saves a head-override entry for the given angle into package.json headOverrides.
  router.post('/api/character/:name/head-override', async (req, res, params) => {
    try {
      const { name } = params;
      const body = await parseBody(req);
      const { angle, body: bodyOverride, clothes: clothesOverride } = body;
      if (!angle) return json(res, { error: 'angle required' }, 400);

      const pkg = loadPackage(name, TMP_DIR) || initPackage(name);
      if (!pkg.headOverrides) pkg.headOverrides = {};
      pkg.headOverrides[angle] = {};
      if (bodyOverride)   pkg.headOverrides[angle].body    = bodyOverride;
      if (clothesOverride) pkg.headOverrides[angle].clothes = clothesOverride;

      savePackage(pkg, name, TMP_DIR);
      return json(res, { success: true, angle, headOverride: pkg.headOverrides[angle] });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/character/:name/head-override/:angle
  // Removes the head-override entry for the given angle from package.json headOverrides.
  router.delete('/api/character/:name/head-override/:angle', (req, res, params) => {
    try {
      const { name, angle } = params;
      const pkg = loadPackage(name, TMP_DIR) || initPackage(name);

      if (!pkg.headOverrides || !pkg.headOverrides[angle]) {
        return json(res, { error: `No head override found for angle '${angle}'` }, 404);
      }

      delete pkg.headOverrides[angle];
      savePackage(pkg, name, TMP_DIR);
      return json(res, { success: true, deleted: angle });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  const VALID_ANGLE_NAMES = ['front', 'front-3/4-L', 'side-L', 'back-3/4-L', 'back', 'back-3/4-R', 'side-R', 'front-3/4-R'];

  // POST /api/characters/:name/head-override
  // Body: { targetAngle, targetLayer, sourceAngle }
  // Merges a single layer override into headOverrides[targetAngle][targetLayer].
  router.post('/api/characters/:name/head-override', async (req, res, params) => {
    try {
      const { name } = params;
      const body = await parseBody(req);
      const { targetAngle, targetLayer, sourceAngle } = body;

      if (!VALID_ANGLE_NAMES.includes(targetAngle)) {
        return json(res, { error: `Invalid targetAngle — must be one of: ${VALID_ANGLE_NAMES.join(', ')}` }, 400);
      }
      if (targetLayer !== 'body' && targetLayer !== 'clothes') {
        return json(res, { error: 'Invalid layer — must be "body" or "clothes"' }, 400);
      }
      if (targetAngle !== sourceAngle) {
        return json(res, { error: 'Angle mismatch — use the matching headshot angle' }, 400);
      }

      const pkg = loadPackage(name, TMP_DIR) || initPackage(name);
      if (!pkg.headOverrides) pkg.headOverrides = {};
      if (!pkg.headOverrides[targetAngle]) pkg.headOverrides[targetAngle] = {};
      pkg.headOverrides[targetAngle][targetLayer] = { sourceAngle };

      savePackage(pkg, name, TMP_DIR);
      return json(res, { success: true, headOverrides: pkg.headOverrides });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/characters/:name/head-override/:angle/:layer
  // Removes headOverrides[angle][layer]; prunes the angle key if it becomes empty.
  router.delete('/api/characters/:name/head-override/:angle/:layer', (req, res, params) => {
    try {
      const { name, angle, layer } = params;

      if (layer !== 'body' && layer !== 'clothes') {
        return json(res, { error: 'Invalid layer — must be "body" or "clothes"' }, 400);
      }

      const pkg = loadPackage(name, TMP_DIR) || initPackage(name);
      if (!pkg.headOverrides || !pkg.headOverrides[angle] || !pkg.headOverrides[angle][layer]) {
        return json(res, { error: `No override found for angle '${angle}', layer '${layer}'` }, 404);
      }

      delete pkg.headOverrides[angle][layer];
      if (Object.keys(pkg.headOverrides[angle]).length === 0) {
        delete pkg.headOverrides[angle];
      }

      savePackage(pkg, name, TMP_DIR);
      return json(res, { success: true, headOverrides: pkg.headOverrides });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/characters/:name/rebuild-override/:angle
  // Body: { bodySrc, clothesSrc?, headSrc?, angleIndex }
  // Exactly one of clothesSrc or headSrc must be provided alongside bodySrc.
  router.post('/api/characters/:name/rebuild-override/:angle', async (req, res, params) => {
    try {
      const { name, angle } = params;
      const body = await parseBody(req);
      const { bodySrc, headSrc, clothesSrc, angleIndex } = body;

      if (!bodySrc) return json(res, { error: 'bodySrc required' }, 400);
      if (!clothesSrc && !headSrc) return json(res, { error: 'clothesSrc or headSrc required' }, 400);

      function srcToPath(src) {
        if (!src) return null;
        const filename = src.replace(/^\/assets\//, '');
        const p = path.join(ASSETS_DIR, filename);
        return fs.existsSync(p) ? p : null;
      }

      const bodyPath = srcToPath(bodySrc);
      if (!bodyPath) return json(res, { error: `Body reference not found: ${bodySrc}` }, 404);

      const isClothes = !!clothesSrc;
      const refPath = isClothes ? srcToPath(clothesSrc) : srcToPath(headSrc);
      if (!refPath) return json(res, { error: `Reference image not found: ${isClothes ? clothesSrc : headSrc}` }, 404);

      const idx = angleIndex ?? angle;

      let prompt, outFilename;
      if (isClothes) {
        prompt = 'Image 1 is the body pose reference. Image 2 is the clothing reference. Generate a pixel art sprite of this character wearing the exact outfit from Image 2 in the exact pose from Image 1. Keep body proportions, pose, and position from Image 1. Replace the outfit entirely with what is shown in Image 2. Same pixel art style, green background #00FF00.';
        outFilename = `${name}-angle-rebuilt-${idx}.png`;
      } else {
        prompt = 'Image 1 is the body pose reference. Image 2 is the head/face reference. Generate a pixel art sprite replacing the head in Image 1 with the face from Image 2. Keep body pose, outfit, and proportions from Image 1. Replace only the head and face with Image 2. Same pixel art style, green background #00FF00.';
        outFilename = `${name}-angle-head-rebuilt-${idx}.png`;
      }

      const client = new NanaBananaClient({ model: 'gemini-3-pro-image-preview' });
      const result = await client.generateSprite(prompt, bodyPath, refPath, {
        aspectRatio: '1:1',
        resolution: '1K',
        model: 'gemini-3-pro-image-preview',
      });

      const outPath = path.join(ASSETS_DIR, outFilename);
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
      fs.writeFileSync(outPath, result.imageBuffer);

      recordCost('gemini-3-pro-image-preview', 'rebuild', '1K', 2, {
        character: name,
        angleIndex: idx,
        type: isClothes ? 'clothes' : 'head',
      });

      return json(res, { success: true, url: `/assets/${outFilename}`, angleIndex: idx });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}

module.exports = { register, loadCharacters, saveCharacters, syncDeletedFromStorage, getCharacterRegistry, computeScale, loadCustomAnimations, saveCustomAnimations, loadPackage, savePackage, initPackage, ANGLE_NAMES, CLOTHING_CATEGORIES };
