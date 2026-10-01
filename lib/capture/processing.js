/**
 * Soul Jam Capture — processing interface. The capture dataset is model-agnostic; a processor
 * turns a take (one or both camera views) into something downstream — today the project's SAM 3D
 * Body mocap pipeline (lib/mocap/pipeline.js → a motion in the clip library), later multi-view
 * reconstruction, ball / hand tracking, segmentation… Each processor declares what it needs and
 * what it costs; paid ones only run with an explicit cost confirmation.
 *
 *   { id, name, kind: 'single-view' | 'multi-view', paid, costPerFrameUsd, requires: [env], run(ctx, progress) }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const jobs = new Map();

const PROCESSORS = {
  sam3dbody: {
    id: 'sam3dbody',
    name: 'SAM 3D Body (single view) → mocap motion',
    kind: 'single-view',
    paid: true,
    costPerFrameUsd: 0.03,                           // SAM 3 segmentation ×2 + SAM 3D Body (docs/MOCAP.md)
    requires: ['FAL_KEY'],
    outputs: 'a motion in the mocap library (raw.json / motion.json), buildable into a game clip',
    async run(ctx, progress) {
      const { sessionId, take, cam, TMP_DIR } = ctx;
      const c = take.cameras?.[cam];
      if (!c?.file) throw new Error(`${cam} has no recording`);
      const src = store.recordingPath(sessionId, take, c.file);
      // the pipeline reads a folder under TMP_DIR (like an upload); hard-link the take there
      const sid = `cap-${take.id}-${cam}`.replace(/[^A-Za-z0-9_-]/g, '');
      const dir = path.join(TMP_DIR, sid);
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'input' + path.extname(c.file));
      if (!fs.existsSync(dst)) { try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); } }
      const pipeline = require('../mocap/pipeline');
      const name = `${take.animKey || 'calibration'}-t${String(take.takeNo).padStart(2, '0')}-${cam}`;
      const out = await pipeline.analyzeVideo({ sessionId: sid, name, fps: ctx.fps, maxFrames: ctx.maxFrames, start: ctx.start, end: ctx.end, TMP_DIR }, progress);
      // game role from the animation definition (the court picks the clip up once it is built)
      if (ctx.role) {
        try { await require('../mocap/game-clips').saveSettings(out.motionId, { role: ctx.role }); } catch (e) { progress({ step: 'role', msg: `role not set: ${e.message}` }); }
      }
      return { motionId: out.motionId, name, frames: out.meta?.frameCount, costUsd: out.meta?.measureCost ?? null };
    },
  },
};

/** Can this server run the processor? { available, why } — MOCAP_MOCK=1 runs the pipeline on synthetic data (tests). */
function availability(id) {
  const p = PROCESSORS[id];
  if (!p) return { available: false, why: `unknown processor ${id}` };
  if (process.env.MOCAP_MOCK === '1') return { available: true, why: null, mock: true };
  const miss = p.requires.filter((k) => !process.env[k]);
  return miss.length ? { available: false, why: `${p.name} needs ${miss.join(', ')} on the server` } : { available: true, why: null };
}
function list() {
  return Object.values(PROCESSORS).map(({ run, ...p }) => ({ ...p, available: availability(p.id).available }));
}
/** The most frames one take sends (8 s at 30 fps). */
const MAX_FRAMES = 240;
/** Frames a take of `durationSec` sends at `fps` (what the cost is computed on). */
const framesFor = (durationSec, fps) => Math.max(2, Math.min(MAX_FRAMES, Math.ceil((+durationSec > 0 ? +durationSec : 4) * (+fps > 0 ? +fps : 30))));
const estimateUsd = (id, frames) => +(frames * (PROCESSORS[id]?.costPerFrameUsd || 0)).toFixed(2);

/** Run a processor on a take and wait for it (the analysis queue: one at a time). */
async function run(id, ctx, progress = () => {}) {
  const p = PROCESSORS[id];
  if (!p) throw Object.assign(new Error(`unknown processor ${id}`), { status: 400 });
  const a = availability(id);
  if (!a.available) throw Object.assign(new Error(a.why), { status: 400 });
  return p.run({ ...ctx, maxFrames: Math.max(2, Math.min(MAX_FRAMES, +ctx.maxFrames || 120)), fps: ctx.fps || 30 }, progress);
}

/** Start a processor on a take (returns a job; progress in job.progress, result in job.result). */
async function start(id, ctx) {
  const p = PROCESSORS[id];
  if (!p) throw Object.assign(new Error(`unknown processor ${id}`), { status: 400 });
  const a = availability(id);
  if (!a.available) throw Object.assign(new Error(a.why), { status: 400 });
  const frames = Math.max(2, Math.min(MAX_FRAMES, +ctx.maxFrames || 120));
  const est = +(frames * p.costPerFrameUsd).toFixed(2);
  if (p.paid && !(+ctx.confirmCostUsd >= est)) throw Object.assign(new Error(`this costs about $${est} (${frames} frames × $${p.costPerFrameUsd}) — send confirmCostUsd ≥ ${est} to run it`), { status: 402, estimateUsd: est });
  const job = { id: 'job-' + crypto.randomBytes(5).toString('hex'), processor: id, takeId: ctx.take.id, cam: ctx.cam, status: 'running', progress: null, result: null, error: null, estimateUsd: est, startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  (async () => {
    try {
      const result = await p.run({ ...ctx, maxFrames: frames, fps: ctx.fps || 30 }, (pr) => { job.progress = pr; });
      job.result = result; job.status = 'done';
      await store.updateRecording(ctx.sessionId, ctx.take.id, (r) => { ((r.processing ||= {})[id] ||= {})[ctx.cam] = { ...result, at: new Date().toISOString() }; });
    } catch (e) { job.status = 'error'; job.error = e.message; }
  })();
  return job;
}

module.exports = { PROCESSORS, list, start, run, availability, framesFor, estimateUsd, MAX_FRAMES, job: (id) => jobs.get(id) || null };
