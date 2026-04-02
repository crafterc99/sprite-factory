/**
 * Wardrobe Routes — Clothing library for character outfit application
 *
 * Items: { id, name, type: 'top'|'bottom', imageData: 'base64...', createdAt }
 * Index (with embedded image data) stored in: data/wardrobe.json
 *
 * Images are embedded as base64 in the JSON so they survive Railway redeploys.
 * No separate image files are needed — everything lives in one committed file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { scheduleSync } = require('../lib/auto-git-sync');
const { uploadFile: sbUpload, downloadFile: sbDownload, isAvailable: sbAvailable } = require('../lib/supabase-storage');

const WARDROBE_INDEX = path.resolve(__dirname, '../data/wardrobe.json');
const SB_META_KEY = '_meta/wardrobe.json';

function loadIndex() {
  try {
    if (fs.existsSync(WARDROBE_INDEX)) return JSON.parse(fs.readFileSync(WARDROBE_INDEX, 'utf8'));
  } catch {}
  return [];
}

function saveIndex(items) {
  fs.mkdirSync(path.dirname(WARDROBE_INDEX), { recursive: true });
  const jsonStr = JSON.stringify(items, null, 2);
  fs.writeFileSync(WARDROBE_INDEX, jsonStr);
  // Back up to Supabase so it survives Railway redeploys
  if (sbAvailable()) sbUpload(SB_META_KEY, Buffer.from(jsonStr));
}

async function restoreFromSupabase() {
  if (!sbAvailable()) return;
  try {
    const local = loadIndex();
    if (local.length > 0) return;
    const buf = await sbDownload(SB_META_KEY);
    if (!buf) return;
    const remote = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(remote) || remote.length === 0) return;
    fs.mkdirSync(path.dirname(WARDROBE_INDEX), { recursive: true });
    fs.writeFileSync(WARDROBE_INDEX, JSON.stringify(remote, null, 2));
    console.log(`  [wardrobe] restored ${remote.length} item(s) from Supabase`);
  } catch (e) {
    console.warn('  [wardrobe] Supabase restore failed (non-fatal):', e.message);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function register(router) {

  // GET /api/wardrobe — list all wardrobe items (without imageData to keep response small)
  router.get('/api/wardrobe', (req, res) => {
    const items = loadIndex().map(({ imageData, ...rest }) => rest);
    json(res, { items });
  });

  // POST /api/wardrobe — add a new wardrobe item
  router.post('/api/wardrobe', async (req, res) => {
    const body = await parseBody(req);
    const { name, type, imageBase64 } = body;
    if (!name || !type || !imageBase64) return json(res, { error: 'name, type, imageBase64 required' }, 400);
    if (!['top', 'bottom'].includes(type)) return json(res, { error: 'type must be "top" or "bottom"' }, 400);

    try {
      // Resize to max 512px on longest side to keep JSON file size manageable
      const rawData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const resized = await sharp(Buffer.from(rawData, 'base64'))
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 8 })
        .toBuffer();
      const imageData = resized.toString('base64');

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const items = loadIndex();
      const item = { id, name, type, imageData, createdAt: new Date().toISOString() };
      items.push(item);
      saveIndex(items);
      scheduleSync();

      json(res, { success: true, item: { id, name, type, createdAt: item.createdAt } });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // DELETE /api/wardrobe/:id — remove a wardrobe item
  router.delete('/api/wardrobe/:id', (req, res, params) => {
    const { id } = params;
    const items = loadIndex();
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return json(res, { error: 'not found' }, 404);
    items.splice(idx, 1);
    saveIndex(items);
    scheduleSync();
    json(res, { success: true });
  });

  // GET /api/wardrobe/image/:id — serve wardrobe item image from embedded base64
  router.get('/api/wardrobe/image/:id', (req, res, params) => {
    const items = loadIndex();
    const item = items.find(i => i.id === params.id);
    if (!item || !item.imageData) { res.writeHead(404); res.end(); return; }
    const buf = Buffer.from(item.imageData, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });

}

module.exports = { register, restoreFromSupabase };
