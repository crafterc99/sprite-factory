/**
 * Firebase Storage backend — same API as lib/r2-storage.js.
 *
 * Env (Railway → Variables):
 *   FIREBASE_SERVICE_ACCOUNT   — the service-account JSON (raw, or base64 of it).
 *                                Firebase console → Project settings → Service accounts →
 *                                "Generate new private key".
 *   FIREBASE_STORAGE_BUCKET    — optional; default <project_id>.firebasestorage.app
 *                                (falls back to <project_id>.appspot.com for older projects)
 *
 * Every object gets a deterministic Firebase download token, so public URLs
 * (Soul Jam loads sprites + the registry from them) work without making the
 * bucket public: https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<key>?alt=media&token=<t>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _creds;
let _credsError = null;

/**
 * Tolerant service-account parsing. Pasting the JSON into a dashboard often
 * turns the private key's "\n" escapes into real line breaks (invalid JSON),
 * wraps the value in quotes, or escapes the quotes — so after a strict
 * JSON.parse we fall back to pulling the four fields we need out of the text
 * and rebuilding the PEM key.
 */
/** Rebuild a clean PEM from whatever the key's line breaks turned into. */
function normalizePem(key) {
  const m = String(key || '').match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (!m) return key;
  const body = m[1].replace(/\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function parseServiceAccount(raw) {
  let text = raw.trim();
  if (!text.includes('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8'); } catch {}
  }
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"{'))) text = text.slice(1, -1);
  if (text.startsWith('"{')) { try { text = JSON.parse(text); } catch { text = text.slice(1, -1).replace(/\\"/g, '"'); } }
  try {
    const j = JSON.parse(text);
    if (j.private_key) j.private_key = normalizePem(j.private_key.replace(/\\n/g, '\n'));
    return j;
  } catch (strictErr) {
    const field = (name) => (text.match(new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`)) || [])[1];
    const pem = text.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
    if (!pem) throw new Error(`not valid JSON (${strictErr.message}) and no private key block found`);
    const body = pem[1].replace(/\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
    const private_key = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
    return { project_id: field('project_id'), client_email: field('client_email'), private_key_id: field('private_key_id'), private_key };
  }
}

function credentials() {
  if (_creds !== undefined) return _creds;
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
  _creds = null;
  if (!raw) return _creds;
  try {
    const j = parseServiceAccount(raw);
    if (j.client_email && j.private_key && j.project_id) _creds = j;
    else _credsError = `missing ${['project_id', 'client_email', 'private_key'].filter((k) => !j[k]).join(', ')}`;
  } catch (e) {
    _credsError = e.message;
  }
  if (_credsError) console.error('[firebase] FIREBASE_SERVICE_ACCOUNT unusable:', _credsError);
  return _creds;
}

/** Why the service account couldn't be used (no secret content). */
function configError() { credentials(); return _credsError; }

function isConfigured() { return !!credentials(); }
function isAvailable() { return isConfigured(); }

let _bucketName = null;
function getBucket() {
  if (_bucketName) return _bucketName;
  const c = credentials();
  _bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/$/, '')
    || (c ? `${c.project_id}.firebasestorage.app` : '');
  return _bucketName;
}

let _storage = null;
function client() {
  if (_storage) return _storage;
  const c = credentials();
  if (!c) return null;
  const { Storage } = require('@google-cloud/storage');
  _storage = new Storage({ projectId: c.project_id, credentials: { client_email: c.client_email, private_key: c.private_key } });
  return _storage;
}
const bucket = () => client().bucket(getBucket());

/** Deterministic download token per key (stable URLs, no read-back needed). */
function tokenFor(key) {
  const h = crypto.createHmac('sha256', credentials().private_key_id || credentials().client_email).update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function withRetry(fn, attempts = 3) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (e.code === 404 || e.code === 403 || e.code === 401) throw e;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw err;
}

async function uploadFile(key, bufferOrPath, contentType = 'image/png') {
  if (!isConfigured()) return;
  try {
    const body = typeof bufferOrPath === 'string' ? fs.readFileSync(bufferOrPath) : bufferOrPath;
    await withRetry(() => bucket().file(key).save(body, {
      resumable: false, contentType,
      metadata: { cacheControl: 'public, max-age=300', metadata: { firebaseStorageDownloadTokens: tokenFor(key) } },
    }));
  } catch (e) {
    console.warn(`[firebase] upload failed (${key}):`, e.message);
  }
}

async function uploadJson(key, obj) {
  return uploadFile(key, Buffer.from(JSON.stringify(obj)), 'application/json');
}

async function downloadFile(key) {
  if (!isConfigured()) return null;
  try {
    const [buf] = await withRetry(() => bucket().file(key).download());
    return buf;
  } catch {
    return null;
  }
}

async function deleteFiles(keys) {
  if (!isConfigured() || !keys.length) return false;
  try {
    await Promise.all(keys.map((k) => bucket().file(k).delete({ ignoreNotFound: true })));
    return true;
  } catch (e) {
    console.warn('[firebase] deleteFiles failed:', e.message);
    return false;
  }
}

function getPublicUrl(key) {
  if (!isConfigured()) return null;
  return `https://firebasestorage.googleapis.com/v0/b/${getBucket()}/o/${encodeURIComponent(key)}?alt=media&token=${tokenFor(key)}`;
}

async function listFiles(prefix) {
  if (!isConfigured()) return [];
  try {
    const [files] = await bucket().getFiles({ prefix: prefix || '', autoPaginate: true });
    return files.map((f) => f.name);
  } catch (e) {
    console.warn('[firebase] listFiles failed:', e.message);
    return [];
  }
}

async function restoreAssetsToDir(assetsDir, deletedSet) {
  if (!isConfigured()) return;
  fs.mkdirSync(assetsDir, { recursive: true });
  const files = await listFiles();
  if (!files.length) return;
  const skipPrefixes = deletedSet && deletedSet.size > 0 ? [...deletedSet].flatMap((n) => [`${n}full.png`, `${n}-`]) : [];
  let restored = 0, skipped = 0;
  // Bounded concurrency — a big roster is thousands of objects
  let i = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (i < files.length) {
      const filename = files[i++];
      if (filename.startsWith('_meta/') || filename.endsWith('/')) continue;
      if (skipPrefixes.some((p) => filename === p || filename.startsWith(p))) { skipped++; continue; }
      const localPath = path.join(assetsDir, filename);
      if (fs.existsSync(localPath)) continue;
      const buf = await downloadFile(filename);
      if (buf) {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, buf);
        restored++;
      }
    }
  }));
  if (restored > 0 || skipped > 0) console.log(`  [firebase] restored ${restored} asset(s)${skipped ? ` (skipped ${skipped} deleted-char files)` : ''}`);
}

/**
 * Soul Jam loads sprites/registry from this bucket in the browser, which
 * needs a CORS rule on the bucket. Set once per process (idempotent).
 */
let _corsDone = false;
async function ensureCors() {
  if (_corsDone) return;
  _corsDone = true;
  try {
    const [meta] = await bucket().getMetadata();
    const has = (meta.cors || []).some((c) => (c.origin || []).includes('*') && (c.method || []).includes('GET'));
    if (!has) {
      await bucket().setCorsConfiguration([...(meta.cors || []), { origin: ['*'], method: ['GET', 'HEAD'], responseHeader: ['Content-Type', 'Cache-Control'], maxAgeSeconds: 3600 }]);
      console.log(`  [firebase] CORS enabled on ${getBucket()} (GET from any origin) for the game`);
    }
  } catch (e) {
    console.warn('[firebase] could not set bucket CORS (game may not load sprites cross-origin):', e.message);
  }
}

async function verifyConnection() {
  if (!isConfigured()) return { ok: false, error: 'FIREBASE_SERVICE_ACCOUNT not set' };
  try {
    let [exists] = await bucket().exists();
    if (!exists && !process.env.FIREBASE_STORAGE_BUCKET && _bucketName.endsWith('.firebasestorage.app')) {
      // Projects created before Oct 2024 use <project>.appspot.com
      _bucketName = `${credentials().project_id}.appspot.com`;
      [exists] = await bucket().exists();
    }
    if (exists) ensureCors();
    if (!exists) return { ok: false, error: `bucket "${getBucket()}" not found — enable Storage in the Firebase console (Build → Storage → Get started) or set FIREBASE_STORAGE_BUCKET` };
    const keys = await listFiles('_meta');
    return { ok: true, keyCount: keys.length, metaKeys: keys.map((k) => k.replace('_meta/', '')), bucket: getBucket() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  backend: 'firebase', isConfigured, isAvailable, getBucket, uploadFile, uploadJson, downloadFile, deleteFiles,
  getPublicUrl, listFiles, restoreAssetsToDir, verifyConnection, tokenFor, ensureCors, configError, parseServiceAccount,
};
