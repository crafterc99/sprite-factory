/**
 * Minimal fal.ai queue client (no SDK dependency).
 *
 *   submit  POST https://queue.fal.run/<endpoint>        → { request_id, status_url, response_url }
 *   poll    GET  status_url                               → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   result  GET  response_url                             → endpoint output JSON
 *
 * Images are sent inline as data URIs, so nothing has to be publicly hosted.
 * Auth: FAL_KEY env var ("Authorization: Key <FAL_KEY>").
 */
'use strict';

const fs = require('fs');
const path = require('path');

const QUEUE_BASE = 'https://queue.fal.run';

function falKey() {
  return (process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.FALAI_API_KEY || process.env.FAL_AI_KEY || '').trim();
}

function isConfigured() {
  return !!falKey();
}

function toDataUri(bufOrPath, mime) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  let type = mime;
  if (!type) {
    const ext = Buffer.isBuffer(bufOrPath) ? '' : path.extname(bufOrPath).toLowerCase();
    type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  }
  return `data:${type};base64,${buf.toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.detail ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)) : text.slice(0, 300);
    const err = new Error(`fal ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Run an endpoint to completion through the queue.
 * Retries transient failures (429/5xx/network) with backoff.
 */
async function run(endpoint, input, { timeoutMs = 180000, pollMs = 1200, retries = 2 } = {}) {
  if (!isConfigured()) throw new Error('FAL_KEY is not set — add it in Railway → Variables');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sub = await request(`${QUEUE_BASE}/${endpoint}`, { method: 'POST', body: JSON.stringify(input) });
      const statusUrl = sub.status_url || `${QUEUE_BASE}/${endpoint}/requests/${sub.request_id}/status`;
      const responseUrl = sub.response_url || `${QUEUE_BASE}/${endpoint}/requests/${sub.request_id}`;
      const t0 = Date.now();
      for (;;) {
        await sleep(pollMs);
        const st = await request(statusUrl, { method: 'GET' });
        if (st.status === 'COMPLETED') break;
        if (Date.now() - t0 > timeoutMs) throw new Error(`fal ${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      return await request(responseUrl, { method: 'GET' });
    } catch (err) {
      lastErr = err;
      const transient = !err.status || err.status === 429 || err.status >= 500;
      if (!transient || attempt === retries) break;
      await sleep(1500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/** Download a fal-hosted file (masks, meshes) to a Buffer. */
async function download(url) {
  if (url.startsWith('data:')) return Buffer.from(url.split(',')[1], 'base64');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url.slice(0, 80)}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { run, download, toDataUri, isConfigured };
