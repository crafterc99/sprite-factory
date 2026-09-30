/**
 * Soul Jam Capture — cloud mirror of capture files (the project's storage backend: Firebase
 * Storage or Cloudflare R2, lib/r2-storage.js). Unlike the generic helpers, uploads here stream
 * large videos (resumable / multipart), retry, and THROW when they fail — a take is only reported
 * saved after its files are really in the bucket. Credentials stay on the server.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('../r2-storage');

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const contentType = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function available() { return process.env.CAPTURE_CLOUD !== '0' && !!storage.isAvailable(); }

async function retry(fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(500 * 2 ** i); }
  }
  throw err;
}

async function putFile(abs, key) {
  const size = fs.statSync(abs).size;
  return retry(async () => {
    if (storage.backend === 'firebase') {
      await storage.bucketHandle().upload(abs, { destination: key, resumable: size > 8 << 20, metadata: { contentType: contentType(abs) } });
    } else {
      const { Upload } = require('@aws-sdk/lib-storage');
      await new Upload({ client: storage.getClient(), params: { Bucket: storage.getBucket(), Key: key, Body: fs.createReadStream(abs), ContentType: contentType(abs) }, queueSize: 3, partSize: 8 << 20 }).done();
    }
    return { key, bytes: size };
  });
}

async function getFile(key) {
  if (storage.backend === 'firebase') {
    const [buf] = await storage.bucketHandle().file(key).download();
    return buf;
  }
  return storage.downloadFile(key);
}

/** Download a mirrored file to its local path if it is not there (Railway after a redeploy). */
async function ensureLocal(abs, key) {
  if (fs.existsSync(abs)) return abs;
  if (!available()) return null;
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  if (storage.backend === 'firebase') { await storage.bucketHandle().file(key).download({ destination: abs }); return abs; }
  const buf = await storage.downloadFile(key);
  if (!buf) return null;
  await fs.promises.writeFile(abs, buf);
  return abs;
}

async function list(prefix) {
  if (storage.backend === 'firebase') {
    const [files] = await storage.bucketHandle().getFiles({ prefix });
    return files.map((f) => f.name);
  }
  const out = await storage.listFiles(prefix);
  return (out || []).map((x) => (typeof x === 'string' ? x : x.key || x.Key));
}

module.exports = { available, putFile, getFile, ensureLocal, list, contentType, backend: () => storage.backend };
