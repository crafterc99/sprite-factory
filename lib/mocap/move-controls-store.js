/**
 * The move controls on the server (the right-stick bindings, engine3d/move-controls.mjs): one JSON file on the disk,
 * mirrored to the bucket — as movement-profiles / testing-config: Railway's disk is wiped on every redeploy, the
 * bucket is the durable copy.
 *
 *   disk    data/move-controls.json            (MOVE_CONTROLS_FILE overrides: the tests' own folder)
 *   bucket  _meta/move-controls.json           (lib/r2-storage.js: Firebase Storage or R2)
 *
 * Startup (server.js, the background restore): restoreFromStorage() — the bucket's copy always wins (always
 * refresh, like movement-profiles); with none there the disk's stays (never pushed up). A request before that ran (or
 * after a redeploy wiped the disk) restores it lazily. A save writes the disk (atomically) and then the bucket, and
 * says whether the bucket has it. Tests: MOVE_CONTROLS_CLOUD_DIR is a folder standing in for the bucket — no real
 * storage is touched (and with the storage variables blank, none is configured).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('../r2-storage');

const FILE = process.env.MOVE_CONTROLS_FILE ? path.resolve(process.env.MOVE_CONTROLS_FILE) : path.resolve(__dirname, '../../data/move-controls.json');
const KEY = '_meta/move-controls.json';
const FAKE = process.env.MOVE_CONTROLS_CLOUD_DIR ? path.resolve(process.env.MOVE_CONTROLS_CLOUD_DIR) : null;

const MC = () => import('../../engine3d/move-controls.mjs');

/** The bucket (or the tests' stand-in): available, get (null: not there), put. */
const cloud = {
  available: () => !!FAKE || !!storage.isAvailable(),
  where: () => (FAKE ? 'test-bucket' : storage.isAvailable() ? storage.backend : null),
  async get() {
    if (FAKE) { try { return JSON.parse(await fs.promises.readFile(path.join(FAKE, KEY), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
    if (!storage.isAvailable()) return null;
    const buf = await storage.downloadFile(KEY);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  },
  async put(obj) {
    if (FAKE) { const p = path.join(FAKE, KEY); await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p + '.part', JSON.stringify(obj, null, 1)); await fs.promises.rename(p + '.part', p); return; }
    if (!storage.isAvailable()) return;
    await storage.uploadJson(KEY, obj);
    // (the r2 backend logs a failed upload instead of throwing: read it back so "saved to the bucket" is true)
    const back = await storage.downloadFile(KEY);
    if (!back || JSON.parse(back.toString('utf8')).updatedAt !== obj.updatedAt) throw new Error('the bucket did not keep the upload');
  },
};

function writeLocal(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, FILE);
}
function readLocal() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

let lazyTried = false;
/**
 * The controls: { controls: { version, bindings, updatedAt? }, isDefault, source: 'disk'|'bucket'|'defaults' }.
 * A stored copy that no longer validates (a role renamed by hand) falls back to the defaults — never a broken game.
 */
async function load() {
  const { validateControls, defaultControls } = await MC();
  let raw = readLocal(), source = raw ? 'disk' : null;
  if (!raw && !lazyTried && cloud.available()) {
    lazyTried = true;
    try { raw = await cloud.get(); if (raw) { writeLocal(raw); source = 'bucket'; } } catch (e) { console.warn('  [move-controls] lazy restore failed:', e.message); }
  }
  if (raw) {
    const v = validateControls(raw);
    if (v.ok) return { controls: { ...v.clean, ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}) }, isDefault: raw.reset === true, source };
    console.warn('  [move-controls] the stored controls do not validate — using the defaults:', v.errors.slice(0, 3).join('; '));
  }
  return { controls: defaultControls(), isDefault: true, source: 'defaults' };
}

let chain = Promise.resolve();
/**
 * Validate and save (serialised: one write at a time). null = back to the defaults (the file and the bucket copy
 * then hold the defaults, so a redeploy restores "defaults", not an older custom set).
 * @returns {{ ok, errors?, conflicts?, controls?, savedToCloud?, cloudError? }}
 */
function save(input) {
  const run = async () => {
    const { validateControls, defaultControls } = await MC();
    const v = validateControls(input == null ? defaultControls() : input);
    if (!v.ok) return { ok: false, errors: v.errors, conflicts: v.conflicts || [] };
    const obj = { ...v.clean, updatedAt: new Date().toISOString(), ...(input == null ? { reset: true } : {}) };
    writeLocal(obj);
    let savedToCloud = false, cloudError = null;
    if (cloud.available()) {
      try { await cloud.put(obj); savedToCloud = true; } catch (e) { cloudError = e.message; console.error('  [move-controls] ✗ bucket backup FAILED:', e.message); }
    }
    return { ok: true, controls: obj, conflicts: v.conflicts, savedToCloud, cloudError, storage: cloud.where() };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Startup: the bucket's copy always replaces the disk's (Railway's disk is fresh after a redeploy anyway). */
async function restoreFromStorage() {
  if (!cloud.available()) return { restored: false, reason: 'no storage' };
  try {
    const remote = await cloud.get();
    if (remote && typeof remote === 'object' && Array.isArray(remote.bindings)) {
      writeLocal(remote);
      lazyTried = true;
      console.log(`  [startup] restored move-controls from storage (${remote.bindings.length} binding(s))`);
      return { restored: true };
    }
    // (nothing in the bucket: the disk's copy, if any, stays — it is not pushed up: a bucket that could not be read
    // just now must never be overwritten by an older disk copy; every save uploads)
    return { restored: false, reason: 'nothing in the bucket' };
  } catch (e) {
    console.warn('  [startup] move-controls restore failed (non-fatal):', e.message);
    return { restored: false, error: e.message };
  }
}

module.exports = { load, save, restoreFromStorage, FILE, KEY };
