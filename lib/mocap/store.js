/**
 * Mocap persistence — local disk first, R2 backup (restored lazily).
 *
 *   data/mocap/<motionId>/{meta,raw,motion}.json   → R2 _meta/mocap/<motionId>/*.json
 *   data/mocap/<motionId>/frames|masks/            → local only (preview; re-derivable)
 *   data/mocap/results/<resultId>.json             → R2 _meta/mocap/results/<resultId>.json
 *
 * _meta/ keys are skipped by restoreAssetsToDir, so they are fetched on demand.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const r2 = require('../r2-storage');

const ROOT = process.env.MOCAP_DIR || path.resolve(__dirname, '../../data/mocap');
const RESULTS = path.join(ROOT, 'results');

const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
const motionDir = (id) => {
  const s = safeId(id);
  if (!s) throw new Error('empty motion id');
  return path.join(ROOT, s);
};

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

async function saveMotionFile(id, name, obj) {
  writeJson(path.join(motionDir(id), `${name}.json`), obj);
  if (r2.isAvailable()) await r2.uploadJson(`_meta/mocap/${safeId(id)}/${name}.json`, obj);
}

async function loadMotionFile(id, name) {
  const p = path.join(motionDir(id), `${name}.json`);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!r2.isAvailable()) return null;
  const buf = await r2.downloadFile(`_meta/mocap/${safeId(id)}/${name}.json`);
  if (!buf) return null;
  writeJson(p, JSON.parse(buf.toString('utf8')));
  return JSON.parse(buf.toString('utf8'));
}

/** Binary per-motion assets (performer cut-outs) — disk + R2 _meta, lazy restore. */
async function saveMotionAsset(id, name, buf) {
  const p = path.join(motionDir(id), 'assets', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  if (r2.isAvailable()) await r2.uploadFile(`_meta/mocap/${safeId(id)}/assets/${name}`, buf);
  return p;
}

async function loadMotionAsset(id, name) {
  const p = path.join(motionDir(id), 'assets', name);
  if (fs.existsSync(p)) return p;
  if (!r2.isAvailable()) return null;
  const buf = await r2.downloadFile(`_meta/mocap/${safeId(id)}/assets/${name}`);
  if (!buf) return null;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

async function loadIndex() {
  const p = path.join(ROOT, 'index.json');
  if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} }
  if (r2.isAvailable()) {
    const buf = await r2.downloadFile('_meta/mocap/index.json');
    if (buf) { const idx = JSON.parse(buf.toString('utf8')); writeJson(p, idx); return idx; }
  }
  return { motions: {}, results: {} };
}

async function saveIndex(idx) {
  writeJson(path.join(ROOT, 'index.json'), idx);
  if (r2.isAvailable()) await r2.uploadJson('_meta/mocap/index.json', idx);
}

async function upsertIndex(kind, id, summary) {
  const idx = await loadIndex();
  idx[kind] = idx[kind] || {};
  idx[kind][id] = { ...(idx[kind][id] || {}), ...summary, id };
  await saveIndex(idx);
}

async function removeFromIndex(kind, id) {
  const idx = await loadIndex();
  if (idx[kind]) delete idx[kind][id];
  await saveIndex(idx);
}

async function saveResult(result) {
  writeJson(path.join(RESULTS, `${safeId(result.id)}.json`), result);
  if (r2.isAvailable()) await r2.uploadJson(`_meta/mocap/results/${safeId(result.id)}.json`, result);
}

async function loadResult(id) {
  const p = path.join(RESULTS, `${safeId(id)}.json`);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!r2.isAvailable()) return null;
  const buf = await r2.downloadFile(`_meta/mocap/results/${safeId(id)}.json`);
  if (!buf) return null;
  writeJson(p, JSON.parse(buf.toString('utf8')));
  return JSON.parse(buf.toString('utf8'));
}

module.exports = {
  ROOT, motionDir, safeId, newId,
  saveMotionFile, loadMotionFile, saveMotionAsset, loadMotionAsset, loadIndex, upsertIndex, removeFromIndex, saveResult, loadResult,
};
