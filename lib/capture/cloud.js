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

// tests: a local folder stands in for the bucket (CAPTURE_CLOUD_DIR) — the restart / redeploy paths
// are exercised without touching real cloud storage
const FAKE = process.env.CAPTURE_CLOUD_DIR ? path.resolve(process.env.CAPTURE_CLOUD_DIR) : null;
const fakePath = (key) => { const p = path.resolve(FAKE, key); if (!p.startsWith(FAKE + path.sep)) throw new Error('bad key'); return p; };

function available() { return process.env.CAPTURE_CLOUD !== '0' && (!!FAKE || !!storage.isAvailable()); }

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
    if (FAKE) { const d = fakePath(key); await fs.promises.mkdir(path.dirname(d), { recursive: true }); await fs.promises.copyFile(abs, d + '.part'); await fs.promises.rename(d + '.part', d); }
    else if (storage.backend === 'firebase') {
      await storage.bucketHandle().upload(abs, { destination: key, resumable: size > 8 << 20, metadata: { contentType: contentType(abs) } });
    } else {
      const { Upload } = require('@aws-sdk/lib-storage');
      await new Upload({ client: storage.getClient(), params: { Bucket: storage.getBucket(), Key: key, Body: fs.createReadStream(abs), ContentType: contentType(abs) }, queueSize: 3, partSize: 8 << 20 }).done();
    }
    return { key, bytes: size };
  });
}

const notFound = (e) => e && (e.code === 404 || e.statusCode === 404 || e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey');

/** The object's bytes; null when it is not in the bucket (throws when the bucket can't be reached). */
async function getFile(key) {
  if (FAKE) return fs.promises.readFile(fakePath(key)).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (storage.backend === 'firebase') {
    try { const [buf] = await retry(() => storage.bucketHandle().file(key).download().catch((e) => { if (notFound(e)) return [null]; throw e; }), 3); return buf; }
    catch (e) { if (notFound(e)) return null; throw e; }
  }
  return storage.downloadFile(key);
}

/**
 * Download a mirrored file to its local path if it is not there (Railway after a redeploy). Into a
 * temp file first, then renamed — a failed or half download is never served; concurrent requests
 * for the same file share one download.
 */
const downloading = new Map();
function ensureLocal(abs, key) {
  if (fs.existsSync(abs)) return Promise.resolve(abs);
  if (!available()) return Promise.resolve(null);
  if (downloading.has(abs)) return downloading.get(abs);
  const p = (async () => {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.dl`;
    try {
      if (FAKE) {
        try { await fs.promises.copyFile(fakePath(key), tmp); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      } else if (storage.backend === 'firebase') {
        try { await storage.bucketHandle().file(key).download({ destination: tmp }); } catch (e) { if (notFound(e)) return null; throw e; }
      } else {
        const buf = await storage.downloadFile(key);
        if (!buf) return null;
        await fs.promises.writeFile(tmp, buf);
      }
      await fs.promises.rename(tmp, abs);
      return abs;
    } finally { fs.promises.rm(tmp, { force: true }).catch(() => {}); }
  })().finally(() => downloading.delete(abs));
  downloading.set(abs, p);
  return p;
}

async function list(prefix) {
  if (FAKE) {
    const out = [], walk = async (d) => { for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(path.relative(FAKE, p).split(path.sep).join('/')); } };
    await walk(FAKE);
    return out.filter((k) => k.startsWith(prefix));
  }
  if (storage.backend === 'firebase') {
    const [files] = await storage.bucketHandle().getFiles({ prefix });
    return files.map((f) => f.name);
  }
  const out = await storage.listFiles(prefix);
  return (out || []).map((x) => (typeof x === 'string' ? x : x.key || x.Key));
}

module.exports = { available, putFile, getFile, ensureLocal, list, contentType, notFound, backend: () => storage.backend };
