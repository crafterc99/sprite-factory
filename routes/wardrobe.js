/**
 * Wardrobe Routes — Clothing library for character outfit application
 *
 * Items: { id, name, type: 'top'|'bottom', createdAt }
 * Images stored in: data/wardrobe/{id}.png
 * Index stored in:  data/wardrobe.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WARDROBE_DIR = path.resolve(__dirname, '../data/wardrobe');
const WARDROBE_INDEX = path.resolve(__dirname, '../data/wardrobe.json');

function loadIndex() {
  try {
    if (fs.existsSync(WARDROBE_INDEX)) return JSON.parse(fs.readFileSync(WARDROBE_INDEX, 'utf8'));
  } catch {}
  return [];
}

function saveIndex(items) {
  fs.mkdirSync(path.dirname(WARDROBE_INDEX), { recursive: true });
  fs.writeFileSync(WARDROBE_INDEX, JSON.stringify(items, null, 2));
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

  // GET /api/wardrobe — list all wardrobe items
  router.get('/api/wardrobe', (req, res) => {
    const items = loadIndex();
    json(res, { items });
  });

  // POST /api/wardrobe — add a new wardrobe item
  router.post('/api/wardrobe', async (req, res) => {
    const body = await parseBody(req);
    const { name, type, imageBase64 } = body;
    if (!name || !type || !imageBase64) return json(res, { error: 'name, type, imageBase64 required' }, 400);
    if (!['top', 'bottom'].includes(type)) return json(res, { error: 'type must be "top" or "bottom"' }, 400);

    try {
      fs.mkdirSync(WARDROBE_DIR, { recursive: true });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const imgData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imgPath = path.join(WARDROBE_DIR, `${id}.png`);
      fs.writeFileSync(imgPath, Buffer.from(imgData, 'base64'));

      const items = loadIndex();
      const item = { id, name, type, createdAt: new Date().toISOString() };
      items.push(item);
      saveIndex(items);

      json(res, { success: true, item });
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

    try {
      const imgPath = path.join(WARDROBE_DIR, `${id}.png`);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    } catch {}

    items.splice(idx, 1);
    saveIndex(items);
    json(res, { success: true });
  });

  // GET /api/wardrobe/image/:id — serve wardrobe item image
  router.get('/api/wardrobe/image/:id', (req, res, params) => {
    const imgPath = path.join(WARDROBE_DIR, `${params.id}.png`);
    if (!fs.existsSync(imgPath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(imgPath).pipe(res);
  });

}

module.exports = { register };
