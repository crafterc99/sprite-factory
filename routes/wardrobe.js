/**
 * Wardrobe Routes — Clothing library for character outfit application
 *
 * Items: { id, name, type: 'top'|'bottom', subcategory, imageData, angles: { front?, back?, left?, right? }, createdAt }
 * Index (with embedded image data) stored in: data/wardrobe.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { scheduleSync } = require('../lib/auto-git-sync');
const { uploadFile: sbUpload, uploadJson: sbUploadJson, downloadFile: sbDownload, isAvailable: sbAvailable } = require('../lib/r2-storage');

const WARDROBE_INDEX = path.resolve(__dirname, '../data/wardrobe.json');
const SB_META_KEY = '_meta/wardrobe.json';

const TOP_SUBCATEGORIES    = ['hoodie', 't-shirt', 'long sleeve', 'tank top', 'jersey', 'jacket', 'sweatshirt', 'polo'];
const BOTTOM_SUBCATEGORIES = ['pants', 'shorts', 'three-quarter', 'leggings', 'joggers', 'sweatpants', 'jeans'];

function loadIndex() {
  try {
    if (fs.existsSync(WARDROBE_INDEX)) return JSON.parse(fs.readFileSync(WARDROBE_INDEX, 'utf8'));
  } catch {}
  return [];
}

function saveIndex(items) {
  fs.mkdirSync(path.dirname(WARDROBE_INDEX), { recursive: true });
  fs.writeFileSync(WARDROBE_INDEX, JSON.stringify(items, null, 2));
  if (sbAvailable()) {
    sbUploadJson(SB_META_KEY, items).catch(e =>
      console.warn('[wardrobe] R2 backup failed:', e.message)
    );
  }
}

async function restoreFromStorage() {
  if (!sbAvailable()) return;
  try {
    // Always prefer Supabase — it is the source of truth, not the local file.
    const buf = await sbDownload(SB_META_KEY);
    if (!buf) return; // Supabase has no backup yet — keep whatever is local
    const remote = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(remote) || remote.length === 0) return;
    fs.mkdirSync(path.dirname(WARDROBE_INDEX), { recursive: true });
    fs.writeFileSync(WARDROBE_INDEX, JSON.stringify(remote, null, 2));
    console.log(`  [wardrobe] restored ${remote.length} item(s) from R2`);
  } catch (e) {
    console.warn('  [wardrobe] R2 restore failed (non-fatal):', e.message);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

async function resizeImage(base64) {
  const raw = base64.replace(/^data:image\/\w+;base64,/, '');
  const buf = await sharp(Buffer.from(raw, 'base64'))
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 8 })
    .toBuffer();
  return buf.toString('base64');
}

function register(router) {

  // GET /api/wardrobe — list all items (strip image data to keep response small)
  router.get('/api/wardrobe', (req, res) => {
    const items = loadIndex().map(({ imageData, angles, ...rest }) => ({
      ...rest,
      hasAngles: angles ? Object.keys(angles).filter(k => !!angles[k]) : [],
    }));
    json(res, { items, topSubcategories: TOP_SUBCATEGORIES, bottomSubcategories: BOTTOM_SUBCATEGORIES });
  });

  // POST /api/wardrobe — add a new wardrobe item
  router.post('/api/wardrobe', async (req, res) => {
    const body = await parseBody(req);
    const { name, type, subcategory, imageBase64, anglesBase64 } = body;
    if (!name || !type || !imageBase64) return json(res, { error: 'name, type, imageBase64 required' }, 400);
    if (!['top', 'bottom'].includes(type)) return json(res, { error: 'type must be "top" or "bottom"' }, 400);

    try {
      const imageData = await resizeImage(imageBase64);

      // Process optional angle images
      const angles = {};
      if (anglesBase64 && typeof anglesBase64 === 'object') {
        for (const side of ['front', 'back', 'left', 'right']) {
          if (anglesBase64[side]) {
            angles[side] = await resizeImage(anglesBase64[side]);
          }
        }
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const items = loadIndex();
      const item = {
        id, name, type,
        subcategory: subcategory || (type === 'top' ? 't-shirt' : 'pants'),
        imageData,
        angles: Object.keys(angles).length > 0 ? angles : undefined,
        createdAt: new Date().toISOString(),
      };
      items.push(item);
      saveIndex(items);
      scheduleSync();

      json(res, { success: true, item: { id, name, type, subcategory: item.subcategory, createdAt: item.createdAt } });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/wardrobe/:id
  router.delete('/api/wardrobe/:id', (req, res, params) => {
    const items = loadIndex();
    const idx = items.findIndex(i => i.id === params.id);
    if (idx === -1) return json(res, { error: 'not found' }, 404);
    items.splice(idx, 1);
    saveIndex(items);
    scheduleSync();
    json(res, { success: true });
  });

  // GET /api/wardrobe/image/:id — main front image
  router.get('/api/wardrobe/image/:id', (req, res, params) => {
    const item = loadIndex().find(i => i.id === params.id);
    if (!item?.imageData) { res.writeHead(404); res.end(); return; }
    const buf = Buffer.from(item.imageData, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });

  // GET /api/wardrobe/angle/:id/:side — front/back/left/right angle image
  router.get('/api/wardrobe/angle/:id/:side', (req, res, params) => {
    const item = loadIndex().find(i => i.id === params.id);
    const data = item?.angles?.[params.side];
    if (!data) { res.writeHead(404); res.end(); return; }
    const buf = Buffer.from(data, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });

}

module.exports = { register, restoreFromStorage };
