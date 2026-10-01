/**
 * Soul Jam Capture — the analysis queue. Nothing is analysed automatically: the director picks the
 * recorded takes, the camera view and confirms the cost (POST …/process-batch); the server then
 * runs them through the processor (SAM 3D Body today) ONE AT A TIME.
 *
 * Persisted, so a redeploy loses nothing:
 *   session.analysisQueue = [{ takeId, animId, cam, fps, maxFrames, estimateUsd, queuedAt }]   (the order)
 *   take.analysis         = { state: queued | running | done | error, cam, fps, maxFrames, estimateUsd,
 *                             queuedAt, startedAt, beatAt, finishedAt, attempts, error, motionId } (the truth)
 *   session.animations[id].analysis = { takeId, state, cam, motionId?, error?, at }          (the list's summary)
 *
 * Paid work is never repeated without the director asking again:
 *   - a running item writes a heartbeat (beatAt) every few seconds. Another process (a redeploy's
 *     old container still finishing in its shutdown window) leaves a running item alone while its
 *     heartbeat is fresh; once the heartbeat is stale its process is gone, and the item becomes an
 *     ERROR ("interrupted by a server restart — send it again"), never a silent second payment;
 *   - after a boot, queued items are left for a grace period (the old container may still be
 *     pumping the same queue), unless this process queued them itself;
 *   - SIGTERM drains the queue: no new item starts;
 *   - a result the bucket refused to store is kept in memory and only its writes are retried — the
 *     pipeline is not run again.
 * On boot (and on the next read of a session) queued items are picked up again.
 */
'use strict';
const crypto = require('crypto');
const store = require('./store');
const processing = require('./processing');

const PROCESSOR = 'sam3dbody';
const envMs = (k, d) => { const v = process.env[k]; return v != null && v !== '' && Number.isFinite(+v) ? +v : d; };
/** A running item whose heartbeat is older than this: the process that ran it is gone. */
const LEASE_MS = envMs('CAPTURE_ANALYSIS_LEASE_MS', 90000);
const BEAT_MS = Math.max(500, Math.min(15000, Math.round(LEASE_MS / 6)));
/** After a boot, queued items another process may still take wait this long (unless queued here). */
const BOOT_GRACE_MS = envMs('CAPTURE_ANALYSIS_GRACE_MS', 120000);
/** A write the bucket refused is tried again after this long. */
const RETRY_MS = envMs('CAPTURE_ANALYSIS_RETRY_MS', 60000);
const INTERRUPTED = 'interrupted by a server restart while it ran — it was not run again automatically (that would pay for it twice): send it again';

/**
 * @param deps.hub()       the WebSocket hub (broadcasts), may return null
 * @param deps.local(abs)  the file on this disk (fetched from the bucket after a redeploy) or null
 * @param deps.anim(session, animId)  the animation definition (for its game role)
 * @param deps.TMP_DIR     where the pipeline reads its input
 */
function createQueue({ hub, local, anim, TMP_DIR }) {
  const BOOT = Date.now();
  const INSTANCE = crypto.randomBytes(4).toString('hex');
  const known = new Set();                    // sessions that may have queued work
  const runningHere = new Set();              // take ids this process is running right now
  const queuedHere = new Set();               // take ids the director queued on this process
  const failedWrite = new Map();              // take id → when a write failed (retried after RETRY_MS)
  const pendingResult = new Map();            // take id → { result | error } the bucket has not stored yet
  const notStarted = new Set();               // take ids this process marked running but could not start (the bucket refused)
  const progress = new Map();                 // take id → the pipeline's last progress report (memory only)
  let pumping = false, draining = false, wakeTimer = null, wakeAt = 0;

  const forCameras = (s) => ({ ...s, pair: { code: s.pair?.code } });
  const summary = (a, takeId) => ({ takeId, state: a.state, cam: a.cam, ...(a.motionId ? { motionId: a.motionId } : {}), ...(a.error ? { error: a.error } : {}), at: new Date().toISOString() });
  async function setState(sid, takeId, animId, patch, { dequeue = false } = {}) {
    const r = await store.updateRecording(sid, takeId, (x) => { x.analysis = { ...(x.analysis || {}), ...patch }; });
    const s = await store.updateSession(sid, (s) => {
      if (dequeue) s.analysisQueue = (s.analysisQueue || []).filter((q) => q.takeId !== takeId);
      const e = s.animations?.[animId];
      if (e) e.analysis = summary(r.analysis, takeId);
    });
    hub()?.takeUpdate(sid, r, { event: 'analysis' });
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s) }, { roles: ['director'] });
    return r;
  }
  /** Run pump() again at `at` (the earliest moment a skipped item becomes runnable). */
  function wakeLater(at) {
    if (draining || (wakeTimer && wakeAt <= at)) return;
    clearTimeout(wakeTimer);
    wakeAt = at;
    wakeTimer = setTimeout(() => { wakeTimer = null; wakeAt = 0; pump(); }, Math.max(200, at - Date.now()));
    wakeTimer.unref?.();
  }

  /**
   * Queue takes for analysis. Without a confirmCostUsd ≥ the estimate it only answers the quote
   * (HTTP 402 with the breakdown) — nothing is queued and nothing is spent.
   */
  async function enqueue(sid, { takes, cam = 'camA', fps = 30, confirmCostUsd } = {}) {
    const avail = processing.availability(PROCESSOR);
    if (!avail.available) throw Object.assign(new Error(avail.why), { status: 400 });
    if (!['camA', 'camB'].includes(cam)) throw Object.assign(new Error('cam must be camA or camB'), { status: 400 });
    if (draining) throw Object.assign(new Error('the server is restarting — send them again in a minute'), { status: 503 });
    fps = [10, 15, 20, 24, 30].includes(+fps) ? +fps : 30;
    const ids = [...new Set(Array.isArray(takes) ? takes.filter((t) => typeof t === 'string').slice(0, 200) : [])];
    if (!ids.length) throw Object.assign(new Error('no takes'), { status: 400 });
    const s = await store.loadSession(sid);
    if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
    const items = [], skipped = [];
    const cpf = processing.PROCESSORS[PROCESSOR].costPerFrameUsd;
    // "queued" / "running" counts only for a take that really is in the queue: a take record marked
    // queued whose session write was lost (the bucket refused it, or the process died between the
    // two writes) is in nobody's queue and would otherwise be stuck "already queued" for ever
    const inQueue = new Set((s.analysisQueue || []).map((q) => q.takeId));
    for (const takeId of ids) {
      const rec = store.kindOf(takeId) === 'take' ? await store.loadRecording(sid, takeId, 'take').catch(() => null) : null;
      if (!rec) { skipped.push({ takeId, reason: 'no such take' }); continue; }
      if (!rec.accepted) { skipped.push({ takeId, reason: 'not recorded yet (still uploading, or its check failed)' }); continue; }
      if (!rec.cameras?.[cam]?.file) { skipped.push({ takeId, reason: `no ${cam === 'camA' ? 'CAM A' : 'CAM B'} recording` }); continue; }
      if (['queued', 'running'].includes(rec.analysis?.state) && inQueue.has(takeId)) { skipped.push({ takeId, reason: 'already queued' }); continue; }
      const durationSec = rec.cameras[cam].fileInfo?.durationSec || rec.targetDurationSec || 4;
      const maxFrames = processing.framesFor(durationSec, fps);
      items.push({ takeId, animId: rec.animId, cam, fps, maxFrames, durationSec, estimateUsd: +(maxFrames * cpf).toFixed(2) });
    }
    const estimateUsd = +items.reduce((a, x) => a + x.estimateUsd, 0).toFixed(2);
    const frames = items.reduce((a, x) => a + x.maxFrames, 0);
    if (!items.length) return { queued: [], skipped, estimateUsd: 0, frames: 0 };
    if (!(+confirmCostUsd + 0.005 >= estimateUsd)) {
      throw Object.assign(new Error(`this sends ${frames} frames to ${processing.PROCESSORS[PROCESSOR].name.split(' (')[0]} — about $${estimateUsd.toFixed(2)}. Confirm the cost to start.`), { status: 402, extra: { estimateUsd, frames, items, skipped } });
    }
    const queuedAt = new Date().toISOString();
    const queued = [];
    for (const it of items) {
      // decided again under the record's lock: a concurrent confirm (or the queue) may have started it
      // meanwhile — a running item with a live heartbeat is never overwritten (that would run it twice)
      const ok = await store.updateRecording(sid, it.takeId, (r) => {
        const a = r.analysis;
        if (a?.state === 'running' && Date.now() - (Date.parse(a.beatAt || a.startedAt || 0) || 0) < LEASE_MS) return false;
        r.analysis = { state: 'queued', processor: PROCESSOR, cam: it.cam, fps: it.fps, maxFrames: it.maxFrames, estimateUsd: it.estimateUsd, queuedAt, attempts: 0, error: null };
        return true;
      });
      if (!ok) { skipped.push({ takeId: it.takeId, reason: 'already running' }); continue; }
      queuedHere.add(it.takeId);
      queued.push(it);
    }
    if (!queued.length) return { queued: [], skipped, estimateUsd: 0, frames: 0 };
    const s2 = await store.updateSession(sid, (x) => {
      const q = (x.analysisQueue ||= []);
      for (const it of queued) {
        if (!q.some((y) => y.takeId === it.takeId)) q.push({ takeId: it.takeId, animId: it.animId, cam: it.cam, fps: it.fps, maxFrames: it.maxFrames, estimateUsd: it.estimateUsd, queuedAt });
        const e = x.animations?.[it.animId];
        if (e) e.analysis = { takeId: it.takeId, state: 'queued', cam: it.cam, at: queuedAt };
      }
      (x.analysisLog ||= []).push({ at: queuedAt, takes: queued.length, frames, confirmedUsd: +confirmCostUsd, estimateUsd });
      if (x.analysisLog.length > 50) x.analysisLog.splice(0, x.analysisLog.length - 50);
    });
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s2) }, { roles: ['director'] });
    known.add(sid);
    pump();
    return { queued, skipped, estimateUsd: +queued.reduce((a, x) => a + x.estimateUsd, 0).toFixed(2), frames: queued.reduce((a, x) => a + x.maxFrames, 0) };
  }

  /**
   * The next item to work on: a result waiting to be stored, a queued item, or a "running" one
   * whose process is gone (→ an error, never a re-run). Items not runnable yet schedule a wake-up.
   */
  async function next() {
    const now = Date.now();
    for (const sid of [...known]) {
      const s = await store.loadSession(sid).catch(() => null);
      const q = s?.analysisQueue || [];
      if (!q.length) { known.delete(sid); continue; }
      for (const item of q) {
        const id = item.takeId;
        if (runningHere.has(id)) continue;
        const failed = failedWrite.get(id) || 0;
        if (now - failed < RETRY_MS) { wakeLater(failed + RETRY_MS); continue; }
        let rec;
        try { rec = await store.loadRecording(sid, id, 'take'); } catch { wakeLater(now + RETRY_MS); continue; }   // storage unreachable: later
        if (pendingResult.has(id)) return { sid, item, rec, pending: true };
        const a = rec?.analysis, st = a?.state;
        if (!rec || !st || st === 'done' || st === 'error') {           // settled already: drop it from the queue
          await store.updateSession(sid, (x) => { x.analysisQueue = (x.analysisQueue || []).filter((y) => y.takeId !== id); }).catch(() => {});
          continue;
        }
        if (st === 'running') {
          if (a.owner === INSTANCE && notStarted.has(id)) return { sid, item, rec };   // never got to the pipeline here
          const beat = Date.parse(a.beatAt || a.startedAt || 0) || 0;
          if (now - beat < LEASE_MS) { wakeLater(beat + LEASE_MS + 50); continue; }   // another process is on it (its heartbeat is fresh)
          return { sid, item, rec, interrupted: true };
        }
        if (st === 'queued') {
          if (now - BOOT < BOOT_GRACE_MS && !queuedHere.has(id)) { wakeLater(BOOT + BOOT_GRACE_MS); continue; }
          return { sid, item, rec };
        }
      }
    }
    return null;
  }

  /** Store an item's outcome (a done result or the pipeline's error). Throws when the bucket refuses. */
  async function storeOutcome(sid, takeId, animId, cam, out) {
    const at = new Date().toISOString();
    if (out.result) {
      await store.updateRecording(sid, takeId, (r) => { ((r.processing ||= {})[PROCESSOR] ||= {})[cam] = { ...out.result, at }; });
      await setState(sid, takeId, animId, { state: 'done', finishedAt: at, motionId: out.result.motionId, frames: out.result.frames ?? null, costUsd: out.result.costUsd ?? null }, { dequeue: true });
    } else {
      await setState(sid, takeId, animId, { state: 'error', finishedAt: at, error: out.error }, { dequeue: true });
    }
  }

  async function runOne(job) {
    const { sid, item, rec } = job;
    const takeId = item.takeId, animId = rec?.animId || item.animId, a = rec?.analysis || {};
    if (job.interrupted) {
      // the run it was on had already stored its (paid) result — the process died before saying
      // "done": it is done, never an error that invites sending (and paying for) it again
      const res = rec?.processing?.[PROCESSOR]?.[a.cam];
      if (res?.motionId && Date.parse(res.at || 0) >= (Date.parse(a.startedAt || 0) || 0)) {
        await setState(sid, takeId, animId, { state: 'done', finishedAt: res.at, motionId: res.motionId, frames: res.frames ?? null, costUsd: res.costUsd ?? null, recovered: 'its result was stored before a server restart' }, { dequeue: true });
        return;
      }
      await setState(sid, takeId, animId, { state: 'error', error: INTERRUPTED, interrupted: true, finishedAt: new Date().toISOString() }, { dequeue: true });
      return;
    }
    if (job.pending) {                                         // the pipeline ran (and was paid): only store it
      const p = pendingResult.get(takeId);
      await storeOutcome(sid, takeId, animId, p.cam, p);
      pendingResult.delete(takeId);
      return;
    }
    runningHere.add(takeId);
    let beat = null;
    try {
      const startedAt = new Date().toISOString();
      let r1;
      try { r1 = await setState(sid, takeId, animId, { state: 'running', startedAt, beatAt: startedAt, owner: INSTANCE, attempts: (a.attempts || 0) + (notStarted.has(takeId) ? 0 : 1), error: null }); }
      catch (e) { notStarted.add(takeId); throw e; }
      notStarted.delete(takeId);
      // the heartbeat: another process leaves this item alone while it is fresh
      beat = setInterval(() => {
        store.updateRecording(sid, takeId, (x) => { if (x.analysis?.state === 'running' && x.analysis.owner === INSTANCE) x.analysis.beatAt = new Date().toISOString(); }, { rollback: false }).catch(() => {});
      }, BEAT_MS);
      beat.unref?.();
      let result = null, error = null;
      try {
        const c = r1.cameras?.[a.cam];
        if (!c?.file || !(await local(store.recordingPath(sid, r1, c.file)))) throw new Error(`${a.cam}'s recording is missing on the server`);
        const s = await store.loadSession(sid);
        const role = ((await anim(s, animId))?.gameRoles || [])[0] || null;
        let last = 0;
        result = await processing.run(PROCESSOR, { sessionId: sid, take: r1, cam: a.cam, fps: a.fps, maxFrames: a.maxFrames, TMP_DIR, role }, (p) => {
          progress.set(takeId, { ...p, at: Date.now() });
          if (Date.now() - last > 1000) { last = Date.now(); hub()?.broadcast(sid, { t: 'analysis', takeId, progress: p }, { roles: ['director'] }); }
        });
      } catch (e) { error = e.message || String(e); }
      clearInterval(beat); beat = null;
      // kept until the bucket has it: a refused write is retried, the pipeline is not run again
      const out = { result, error: result ? null : error, cam: a.cam };
      pendingResult.set(takeId, out);
      await storeOutcome(sid, takeId, animId, a.cam, out);
      pendingResult.delete(takeId);
    } finally { clearInterval(beat); runningHere.delete(takeId); progress.delete(takeId); }
  }

  async function pump() {
    if (pumping || draining) return;
    pumping = true;
    try {
      for (;;) {
        if (draining) break;
        const job = await next();
        if (!job) break;
        try { await runOne(job); }
        catch (e) {                                            // the bucket refused a write: retried later (never a re-run)
          failedWrite.set(job.item.takeId, Date.now());
          console.error('[capture] analysis', job.item.takeId, e.message);
        }
      }
    } catch (e) { console.error('[capture] analysis queue', e.message); }
    finally { pumping = false; }
  }

  /** A session was read: if it has queued work nobody is running, run it. */
  function touch(sid, session) {
    if (!session?.analysisQueue?.length) return;
    known.add(sid);
    if (!pumping) pump();
  }
  /** After a boot: every session with a queue. */
  async function resumeAll() {
    for (const s of await store.listSessions().catch(() => [])) if (s.analysisQueue?.length) known.add(s.id);
    pump();
  }
  /** SIGTERM: start nothing new (a running item finishes if the shutdown window allows). */
  function drain() { draining = true; clearTimeout(wakeTimer); wakeTimer = null; }
  /** What the analysis screen shows: availability, cost per frame, the queue with live progress. */
  async function status(sid) {
    const s = await store.loadSession(sid);
    if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
    touch(sid, s);
    const p = processing.PROCESSORS[PROCESSOR], av = processing.availability(PROCESSOR);
    return {
      processor: { id: p.id, name: p.name, costPerFrameUsd: p.costPerFrameUsd, maxFrames: processing.MAX_FRAMES },
      available: av.available, why: av.why, mock: !!av.mock,
      queue: (s.analysisQueue || []).map((q) => ({ ...q, running: runningHere.has(q.takeId), progress: progress.get(q.takeId) || null })),
    };
  }
  return { enqueue, pump, touch, resumeAll, drain, status, progress };
}

module.exports = { createQueue, PROCESSOR, LEASE_MS, BOOT_GRACE_MS, INTERRUPTED };
