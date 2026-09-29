/**
 * Tripo v3 API client (https://openapi.tripo3d.ai/v3). Bearer auth from TRIPO_API_KEY (never
 * logged), response envelope {code, data}, retries only for transient failures (network, 429,
 * 5xx), polling with backoff that follows the server's own time estimate.
 *
 * Every create* call returns a task id; waitForTask() resolves to the finished task detail.
 * Inputs to processing steps are a task id (task_…) or an uploaded file token (file_…).
 */
import fs from 'fs';
import path from 'path';
import { TRIPO } from './config.mjs';

export class TripoError extends Error {
  constructor(msg, { status, code, requestId, transient = false } = {}) { super(msg); this.status = status; this.code = code; this.requestId = requestId; this.transient = transient; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.obj': 'text/plain' };

export class TripoClient {
  constructor({ apiKey = process.env.TRIPO_API_KEY, baseUrl = TRIPO.baseUrl, log = () => {}, maxRetries = 4, timeoutMs = 120000 } = {}) {
    if (!apiKey) throw new TripoError('TRIPO_API_KEY is not set (add it to .env)');
    this.key = apiKey; this.base = baseUrl.replace(/\/$/, ''); this.log = log; this.maxRetries = maxRetries; this.timeoutMs = timeoutMs;
  }

  async send(method, p, { json, form } = {}) {
    let last;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt) { const d = Math.min(30000, 1500 * 2 ** (attempt - 1)); this.log(`  retry ${attempt} in ${d / 1000}s (${last.message})`); await sleep(d); }
      try { return await this.sendOnce(method, p, { json, form }); } catch (e) { last = e; if (!e.transient) throw e; }
    }
    throw last;
  }

  async sendOnce(method, p, { json, form }) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.base + p, { method, signal: ctl.signal, headers: { Authorization: `Bearer ${this.key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : form });
    } catch (e) { throw new TripoError(`network: ${e.message}`, { transient: true }); } finally { clearTimeout(t); }
    let env; try { env = await res.json(); } catch { throw new TripoError(`HTTP ${res.status} (non-JSON)`, { status: res.status, transient: res.status >= 500 || res.status === 429 }); }
    if (!res.ok || env.code !== 0) {
      throw new TripoError(`${method} ${p}: ${env.message || 'error'}${env.suggestion ? ` (${env.suggestion})` : ''}`, { status: res.status, code: env.code, requestId: env.request_id, transient: res.status >= 500 || res.status === 429 });
    }
    return env.data;
  }

  // ── account / files / tasks ──
  getBalance() { return this.send('GET', '/v3/account/balance'); }
  async uploadFile(file) {
    const ext = path.extname(file).toLowerCase();
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)], { type: MIME[ext] || 'application/octet-stream' }), path.basename(file));
    return (await this.send('POST', '/v3/files', { form })).file_token;
  }
  getTask(id) { return this.send('GET', `/v3/tasks/${encodeURIComponent(id)}`); }
  async createTask(endpoint, payload) { const d = await this.send('POST', endpoint, { json: payload }); return d.task_id; }

  /** Polls until the task finishes: 3 s, growing ×1.5 to 30 s, or the server's remaining-time hint. */
  async waitForTask(id, { timeoutMs = 45 * 60000, onProgress } = {}) {
    const t0 = Date.now(); let delay = 3000;
    for (;;) {
      const task = await this.getTask(id);
      if (task.status === 'success') return task;
      if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(task.status)) throw new TripoError(`task ${id} ${task.status}${task.error_message || task.error_msg ? `: ${task.error_message || task.error_msg}` : ''}${task.error_code ? ` (Tripo code ${task.error_code})` : ''}`, { code: task.status, tripoCode: task.error_code });
      onProgress?.(task);
      if (Date.now() - t0 > timeoutMs) throw new TripoError(`task ${id} still ${task.status} after ${Math.round(timeoutMs / 60000)} min (it keeps running; resume later)`, { transient: false, code: 'timeout' });
      const hint = task.running_left_time > 0 ? task.running_left_time * 500 : 0;
      await sleep(Math.max(3000, Math.min(30000, hint || delay)));
      delay = Math.min(30000, delay * 1.5);
    }
  }

  // ── generation ──
  createImageModel(input, params = {}) { return this.createTask('/v3/generation/image-to-model', { model: TRIPO.sourceModel, ...params, input }); }
  /** views: { front: token, left?, back?, right? } — sent as explicit view keys, never by position. */
  async createMultiviewModel(views, params = {}) {
    if (!views.front) throw new TripoError('multiview needs a front view');
    const inputs = Object.entries(views).filter(([, v]) => v).map(([k, v]) => ({ [k]: v }));
    return this.createTask('/v3/generation/multiview-to-model', { model: TRIPO.sourceModel, ...params, inputs });
  }

  /** Image → image (e.g. template: 't_pose' turns a character reference into a T-pose). */
  createImageToImage(input, params = {}) { return this.createTask('/v3/generation/image-to-image', { input, ...params }); }

  // ── processing ──
  rigCheck(input) { return this.createTask('/v3/animations/rig-check', { input }); }
  rig(input, { rig_type = 'biped', spec = TRIPO.rigSpec, out_format = 'glb', model = TRIPO.rigModel } = {}) { return this.createTask('/v3/animations/rig', { input, rig_type, spec, out_format, model }); }
  retarget(rigTaskId, animations, extra = {}) { return this.createTask('/v3/animations/retarget', { input: rigTaskId, animations, ...extra }); }
  segment(input, extra = {}) { return this.createTask('/v3/mesh/segment', { input, ...extra }); }
  complete(segmentTaskId, extra = {}) { return this.createTask('/v3/mesh/complete', { input: segmentTaskId, ...extra }); }
  decimate(input, face_limit, extra = {}) { return this.createTask('/v3/mesh/decimate', { input, face_limit, ...extra }); }
  texture(input, extra = {}) { return this.createTask('/v3/models/texture', { input, ...extra }); }
  convert(input, format, extra = {}) { return this.createTask('/v3/models/convert', { input, format, ...extra }); }

  /** Every URL in a finished task's output (string fields and {url} objects). */
  static outputUrls(task) {
    const found = [];
    const visit = (v, k) => { if (typeof v === 'string' && /^https?:\/\//.test(v)) found.push({ field: k, url: v }); else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) visit(vv, k ? `${k}.${kk}` : kk); };
    visit(task.output, '');
    return found;
  }
  async download(url, dest) {
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer())); return dest;
      } catch (e) { if (a >= 3) throw new TripoError(`download failed: ${e.message}`); await sleep(2000 * (a + 1)); }
    }
  }
}
