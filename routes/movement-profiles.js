'use strict';
/**
 * movement-profiles.js — CRUD API for named MovementProfile definitions
 *
 * GET    /api/movement-profiles        — list all profiles
 * GET    /api/movement-profiles/:id    — get single profile
 * POST   /api/movement-profiles        — create profile
 * PUT    /api/movement-profiles/:id    — replace profile
 * DELETE /api/movement-profiles/:id    — delete profile
 */

const fs   = require('fs');
const path = require('path');
const { scheduleSync } = require('../lib/auto-git-sync');

const DATA_FILE = path.resolve(__dirname, '../data/movement-profiles.json');

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  scheduleSync();
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function validateProfile(p) {
  if (!p.id || typeof p.id !== 'string') return 'id required';
  if (!p.label) return 'label required';
  if (!Array.isArray(p.keyframes) || p.keyframes.length < 2) return 'keyframes[] with ≥2 points required';
  for (const kf of p.keyframes) {
    if (kf.t == null || kf.dx == null || kf.dy == null) return 'each keyframe needs t, dx, dy';
  }
  return null;
}

function register(router) {
  // GET all
  router.get('/api/movement-profiles', (req, res) => {
    json(res, { profiles: Object.values(load()) });
  });

  // GET single
  router.get('/api/movement-profiles/:id', (req, res, params) => {
    const data = load();
    const p = data[params.id];
    if (!p) return json(res, { error: 'not found' }, 404);
    json(res, p);
  });

  // POST create
  router.post('/api/movement-profiles', async (req, res) => {
    const body = await parseBody(req);
    const err = validateProfile(body);
    if (err) return json(res, { error: err }, 400);
    const data = load();
    const id = body.id.trim().toLowerCase().replace(/\s+/g, '-');
    body.id = id;
    data[id] = body;
    save(data);
    json(res, { success: true, profile: body });
  });

  // PUT replace
  router.put('/api/movement-profiles/:id', async (req, res, params) => {
    const body = await parseBody(req);
    body.id = params.id;
    const err = validateProfile(body);
    if (err) return json(res, { error: err }, 400);
    const data = load();
    if (!data[params.id]) return json(res, { error: 'not found' }, 404);
    data[params.id] = body;
    save(data);
    json(res, { success: true, profile: body });
  });

  // DELETE
  router.delete('/api/movement-profiles/:id', (req, res, params) => {
    const data = load();
    if (!data[params.id]) return json(res, { error: 'not found' }, 404);
    delete data[params.id];
    save(data);
    json(res, { success: true });
  });
}

module.exports = { register };
