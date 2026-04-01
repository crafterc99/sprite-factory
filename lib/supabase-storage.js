'use strict';

/**
 * Supabase Storage — persistent binary asset layer
 *
 * All sprite PNGs (portraits, angles, headshots, sprite sheets) are uploaded
 * here so they survive Railway redeploys without living in git.
 *
 * Required env vars:
 *   SUPABASE_URL          — project URL, e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  — service-role key (NOT the anon key)
 *
 * Bucket: "sprite-assets"  (create it in Supabase dashboard, set to Public)
 *
 * All functions are no-ops when env vars are not set, so the app works
 * in local dev without Supabase configured.
 */

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
 */
async function restoreAssetsToDir(assetsDir) {
  if (!isAvailable()) return;
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(assetsDir, { recursive: true });

  const files = await listFiles();
  if (!files.length) return;

  let restored = 0;
  await Promise.all(files.map(async (filename) => {
    const localPath = path.join(assetsDir, filename);
    if (fs.existsSync(localPath)) return; // already present
    const buf = await downloadFile(filename);
    if (buf) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buf);
      restored++;
    }
  }));

  if (restored > 0) {
    console.log(`  [supabase] restored ${restored} asset(s) from Supabase Storage`);
  }
}

module.exports = { isAvailable, uploadFile, downloadFile, getPublicUrl, listFiles, restoreAssetsToDir };
