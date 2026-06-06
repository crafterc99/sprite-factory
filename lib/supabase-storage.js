'use strict';

/**
 * Storage router — prefers Cloudflare R2, falls back to Supabase.
 * All callers import from this file; backend is selected at runtime.
 *
 * R2 env vars (preferred):
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Supabase env vars (fallback):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

// Route to R2 when configured
if (process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  module.exports = require('./r2-storage');
  return;
}

// --- Supabase fallback below ---

const BUCKET = 'sprite-assets';

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  // Lazy require so the module loads even if the package isn't installed
  const { createClient } = require('@supabase/supabase-js');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** Returns true if Supabase is configured */
function isAvailable() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Upload a PNG buffer (or file path) to Supabase Storage.
 * key = filename, e.g. "99full.png" or "99-angle-0.png"
 * Fire-and-forget safe — always returns a promise (never throws sync).
 */
async function uploadFile(key, bufferOrPath) {
  const sb = getClient();
  if (!sb) return;
  try {
    const fs = require('fs');
    const buf = typeof bufferOrPath === 'string' ? fs.readFileSync(bufferOrPath) : bufferOrPath;
    const { error } = await sb.storage.from(BUCKET).upload(key, buf, {
      contentType: 'image/png',
      upsert: true,
    });
    if (error) throw error;
  } catch (e) {
    console.warn(`[supabase] upload failed (${key}):`, e.message);
  }
}

/**
 * Upload a JSON-serializable object to Supabase Storage with correct content-type.
 * Used for metadata backups (_meta/*.json).
 */
async function uploadJson(key, obj) {
  const sb = getClient();
  if (!sb) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj));
    const { error } = await sb.storage.from(BUCKET).upload(key, buf, {
      contentType: 'application/json',
      upsert: true,
    });
    if (error) throw error;
  } catch (e) {
    console.warn(`[supabase] uploadJson failed (${key}):`, e.message);
  }
}

/**
 * Delete one or more files from the bucket.
 * Returns true if successful, false if not configured or failed.
 */
async function deleteFiles(keys) {
  const sb = getClient();
  if (!sb || !keys.length) return false;
  try {
    const { error } = await sb.storage.from(BUCKET).remove(keys);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn(`[supabase] deleteFiles failed:`, e.message);
    return false;
  }
}

/**
 * Download a file from Supabase Storage.
 * Returns a Buffer, or null if not found / not configured.
 */
async function downloadFile(key) {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(key);
    if (error || !data) return null;
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/**
 * Get the public CDN URL for a file.
 * Returns null if Supabase is not configured.
 */
function getPublicUrl(key) {
  const sb = getClient();
  if (!sb) return null;
  const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
  return data?.publicUrl || null;
}

/**
 * List all files in the bucket recursively.
 * Supabase returns folder entries with id === null — we recurse into them.
 * Returns full relative paths, e.g. ["99full.png", "joaquin-walk-frames/frame-0.png"]
 */
async function listFiles(prefix) {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix || '', { limit: 1000 });
    if (error || !data) return [];
    const results = [];
    for (const f of data) {
      const fullKey = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.id === null) {
        // This is a folder — recurse
        const children = await listFiles(fullKey);
        results.push(...children);
      } else {
        results.push(fullKey);
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Restore all Supabase assets that are missing from the local assets directory.
 * Called at server startup. Silently skips files that already exist on disk.
 * Handles subdirectories (e.g. {char}-{anim}-frames/frame-N.png).
 *
 * @param {string} assetsDir - local directory to restore files into
 * @param {Set<string>} [deletedSet] - character names to skip (won't re-download their files)
 */
async function restoreAssetsToDir(assetsDir, deletedSet) {
  if (!isAvailable()) return;
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(assetsDir, { recursive: true });

  const files = await listFiles();
  if (!files.length) return;

  // Build prefix list for deleted characters so we can skip their files
  const skipPrefixes = deletedSet && deletedSet.size > 0
    ? [...deletedSet].flatMap(n => [`${n}full.png`, `${n}-`])
    : [];

  let restored = 0;
  let skipped = 0;
  await Promise.all(files.map(async (filename) => {
    // Skip _meta/ keys — those are JSON backups, not asset files
    if (filename.startsWith('_meta/')) return;
    // Skip files belonging to deleted characters
    if (skipPrefixes.some(p => filename === p || filename.startsWith(p))) {
      skipped++;
      return;
    }
    const localPath = path.join(assetsDir, filename);
    if (fs.existsSync(localPath)) return; // already present
    const buf = await downloadFile(filename);
    if (buf) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buf);
      restored++;
    }
  }));

  if (restored > 0 || skipped > 0) {
    console.log(`  [supabase] restored ${restored} asset(s) from Supabase Storage${skipped ? ` (skipped ${skipped} deleted-char files)` : ''}`);
  }
}

/**
 * Verify the Supabase connection is live and the bucket exists.
 * Does a minimal list (no recursive walk) to keep it fast.
 * Returns { ok: boolean, keyCount: number, metaKeys: string[], error?: string }
 */
async function verifyConnection() {
  if (!isAvailable()) return { ok: false, error: 'SUPABASE_URL or SUPABASE_SERVICE_KEY not set' };
  try {
    const { data, error } = await getClient().storage.from(BUCKET).list('_meta', { limit: 100 });
    if (error) return { ok: false, error: error.message };
    const metaKeys = (data || []).map(f => f.name);
    // Quick top-level count (non-recursive, cheap)
    const { data: topData } = await getClient().storage.from(BUCKET).list('', { limit: 200 });
    return { ok: true, keyCount: (topData || []).length, metaKeys };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isAvailable, uploadFile, uploadJson, downloadFile, deleteFiles, getPublicUrl, listFiles, restoreAssetsToDir, verifyConnection };
