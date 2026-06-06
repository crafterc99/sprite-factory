'use strict';

/**
 * Cloudflare R2 Storage — persistent binary asset layer (S3-compatible)
 *
 * Required env vars:
 *   R2_ENDPOINT       — https://<account-id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID  — R2 API token access key
 *   R2_SECRET_ACCESS_KEY — R2 API token secret
 *   R2_BUCKET         — bucket name (e.g. "sprite-factory")
 *
 * All functions are no-ops when env vars are not set.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

let _client = null;

function getClient() {
  if (_client) return _client;
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  _client = new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return _client;
}

function getBucket() {
  return process.env.R2_BUCKET || 'sprite-factory';
}

function isAvailable() {
  return !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

async function uploadFile(key, bufferOrPath, contentType = 'image/png') {
  const client = getClient();
  if (!client) return;
  try {
    const fs = require('fs');
    const Body = typeof bufferOrPath === 'string' ? fs.readFileSync(bufferOrPath) : bufferOrPath;
    await client.send(new PutObjectCommand({ Bucket: getBucket(), Key: key, Body, ContentType: contentType }));
  } catch (e) {
    console.warn(`[r2] upload failed (${key}):`, e.message);
  }
}

async function uploadJson(key, obj) {
  const client = getClient();
  if (!client) return;
  try {
    const Body = Buffer.from(JSON.stringify(obj));
    await client.send(new PutObjectCommand({ Bucket: getBucket(), Key: key, Body, ContentType: 'application/json' }));
  } catch (e) {
    console.warn(`[r2] uploadJson failed (${key}):`, e.message);
  }
}

async function downloadFile(key) {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

async function deleteFiles(keys) {
  const client = getClient();
  if (!client || !keys.length) return false;
  try {
    const Objects = keys.map(Key => ({ Key }));
    await client.send(new DeleteObjectsCommand({ Bucket: getBucket(), Delete: { Objects } }));
    return true;
  } catch (e) {
    console.warn(`[r2] deleteFiles failed:`, e.message);
    return false;
  }
}

function getPublicUrl(key) {
  const endpoint = process.env.R2_PUBLIC_URL || process.env.R2_ENDPOINT;
  if (!endpoint) return null;
  return `${endpoint}/${getBucket()}/${key}`;
}

async function listFiles(prefix) {
  const client = getClient();
  if (!client) return [];
  try {
    const results = [];
    let ContinuationToken;
    do {
      const res = await client.send(new ListObjectsV2Command({
        Bucket: getBucket(),
        Prefix: prefix || '',
        ContinuationToken,
        MaxKeys: 1000,
      }));
      if (res.Contents) results.push(...res.Contents.map(o => o.Key));
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return results;
  } catch {
    return [];
  }
}

async function restoreAssetsToDir(assetsDir, deletedSet) {
  if (!isAvailable()) return;
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(assetsDir, { recursive: true });

  const files = await listFiles();
  if (!files.length) return;

  const skipPrefixes = deletedSet && deletedSet.size > 0
    ? [...deletedSet].flatMap(n => [`${n}full.png`, `${n}-`])
    : [];

  let restored = 0, skipped = 0;
  await Promise.all(files.map(async (filename) => {
    if (filename.startsWith('_meta/')) return;
    if (skipPrefixes.some(p => filename === p || filename.startsWith(p))) { skipped++; return; }
    const localPath = path.join(assetsDir, filename);
    if (fs.existsSync(localPath)) return;
    const buf = await downloadFile(filename);
    if (buf) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buf);
      restored++;
    }
  }));

  if (restored > 0 || skipped > 0) {
    console.log(`  [r2] restored ${restored} asset(s) from R2${skipped ? ` (skipped ${skipped} deleted-char files)` : ''}`);
  }
}

async function verifyConnection() {
  if (!isAvailable()) return { ok: false, error: 'R2 env vars not set' };
  try {
    const keys = await listFiles('_meta');
    return { ok: true, keyCount: keys.length, metaKeys: keys.map(k => k.replace('_meta/', '')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isAvailable, uploadFile, uploadJson, downloadFile, deleteFiles, getPublicUrl, listFiles, restoreAssetsToDir, verifyConnection };
