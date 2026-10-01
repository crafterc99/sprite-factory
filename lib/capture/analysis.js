/**
 * Soul Jam Capture — the analysis queue. Nothing is analysed automatically: the director picks the
 * recorded takes, the camera view and confirms the cost (POST …/process-batch); the server then
 * runs them through the processor (SAM 3D Body today) ONE AT A TIME.
 *
 * Persisted, so a redeploy loses nothing:
 *   session.analysisQueue = [{ takeId, animId, cam, fps, maxFrames, estimateUsd, queuedAt }]   (the order)
 *   take.analysis         = { state: queued | running | done | error, cam, fps, maxFrames, estimateUsd,
 *                             queuedAt, startedAt, finishedAt, attempts, error, motionId }       (the truth)
 *   session.animations[id].analysis = { takeId, state, cam, motionId?, error?, at }          (the list's summary)
 * On boot (and on the next GET of a session) queued items — and "running" ones no process is
 * running any more (a restart mid-run) — are picked up again. An item interrupted twice is marked
 * as an error instead of being paid for a third time.
 */
'use strict';
const store = require('./store');
const processing = require('./processing');

const PROCESSOR = 'sam3dbody';
const MAX_ATTEMPTS = 2;

/**
 * @param deps.hub()       the WebSocket hub (broadcasts), may return null
 * @param deps.local(abs)  the file on this disk (fetched from the bucket after a redeploy) or null
 * @param deps.anim(session, animId)  the animation definition (for its game role)
 * @param deps.TMP_DIR     where the pipeline reads its input
 */
function createQueue({ hub, local, anim, TMP_DIR }) {
  const known = new Set();                    // sessions that may have queued work
  const runningHere = new Set();              // take ids this process is running right now
  const failedWrite = new Map();              // take id → time its result could not be written (no instant re-run)
  const progress = new Map();                 // take id → the pipeline's last progress report (memory only)
  let pumping = false;

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
  const forCameras = (s) => ({ ...s, pair: { code: s.pair?.code } });

  /**
   * Queue takes for analysis. Without a confirmCostUsd ≥ the estimate it only answers the quote
   * (HTTP 402 with the breakdown) — nothing is queued and nothing is spent.
   */
  async function enqueue(sid, { takes, cam = 'camA', fps = 30, confirmCostUsd } = {}) {
    const avail = processing.availability(PROCESSOR);
    if (!avail.available) throw Object.assign(new Error(avail.why), { status: 400 });
    if (!['camA', 'camB'].includes(cam)) throw Object.assign(new Error('cam must be camA or camB'), { status: 400 });
    fps = [10, 15, 20, 24, 30].includes(+fps) ? +fps : 30;
    const ids = [...new Set(Array.isArray(takes) ? takes.filter((t) => typeof t === 'string').slice(0, 200) : [])];
    if (!ids.length) throw Object.assign(new Error('no takes'), { status: 400 });
    const s = await store.loadSession(sid);
    if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
    const items = [], skipped = [];
    const cpf = processing.PROCESSORS[PROCESSOR].costPerFrameUsd;
    for (const takeId of ids) {
      const rec = store.kindOf(takeId) === 'take' ? await store.loadRecording(sid, takeId, 'take').catch(() => null) : null;
      if (!rec) { skipped.push({ takeId, reason: 'no such take' }); continue; }
      if (!rec.accepted) { skipped.push({ takeId, reason: 'not recorded yet (still uploading, or its check failed)' }); continue; }
      if (!rec.cameras?.[cam]?.file) { skipped.push({ takeId, reason: `no ${cam === 'camA' ? 'CAM A' : 'CAM B'} recording` }); continue; }
      if (['queued', 'running'].includes(rec.analysis?.state)) { skipped.push({ takeId, reason: 'already queued' }); continue; }
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
    for (const it of items) {
      await store.updateRecording(sid, it.takeId, (r) => { r.analysis = { state: 'queued', processor: PROCESSOR, cam: it.cam, fps: it.fps, maxFrames: it.maxFrames, estimateUsd: it.estimateUsd, queuedAt, attempts: 0, error: null }; });
    }
    const s2 = await store.updateSession(sid, (x) => {
      const q = (x.analysisQueue ||= []);
      for (const it of items) {
        if (!q.some((y) => y.takeId === it.takeId)) q.push({ takeId: it.takeId, animId: it.animId, cam: it.cam, fps: it.fps, maxFrames: it.maxFrames, estimateUsd: it.estimateUsd, queuedAt });
        const e = x.animations?.[it.animId];
        if (e) e.analysis = { takeId: it.takeId, state: 'queued', cam: it.cam, at: queuedAt };
      }
      (x.analysisLog ||= []).push({ at: queuedAt, takes: items.length, frames, confirmedUsd: +confirmCostUsd, estimateUsd });
      if (x.analysisLog.length > 50) x.analysisLog.splice(0, x.analysisLog.length - 50);
    });
    hub()?.broadcast(sid, { t: 'session', session: forCameras(s2) }, { roles: ['director'] });
    known.add(sid);
    pump();
    return { queued: items, skipped, estimateUsd, frames };
  }

  /** The next item to run: queued, or "running" in the record but not in this process (a restart). */
  async function next() {
    for (const sid of [...known]) {
      const s = await store.loadSession(sid).catch(() => null);
      const q = s?.analysisQueue || [];
      if (!q.length) { known.delete(sid); continue; }
      for (const item of q) {
        let rec;
        try { rec = await store.loadRecording(sid, item.takeId, 'take'); } catch { continue; }   // storage unreachable: later
        const st = rec?.analysis?.state;
        if (!rec || !st || st === 'done' || st === 'error') {           // settled already: drop it from the queue
          await store.updateSession(sid, (x) => { x.analysisQueue = (x.analysisQueue || []).filter((y) => y.takeId !== item.takeId); }).catch(() => {});
          continue;
        }
        if (runningHere.has(item.takeId)) continue;
        if (Date.now() - (failedWrite.get(item.takeId) || 0) < 60000) continue;
        if (st === 'queued' || st === 'running') return { sid, item, rec };
      }
    }
    return null;
  }

  async function runOne({ sid, item, rec }) {
    const takeId = item.takeId, animId = rec.animId;
    const a = rec.analysis;
    if (a.state === 'running' && (a.attempts || 0) >= MAX_ATTEMPTS) {
      await setState(sid, takeId, animId, { state: 'error', error: `interrupted ${a.attempts} times by a server restart — send it again`, finishedAt: new Date().toISOString() }, { dequeue: true });
      return;
    }
    runningHere.add(takeId);
    try {
      let r1;
      try { r1 = await setState(sid, takeId, animId, { state: 'running', startedAt: new Date().toISOString(), attempts: (a.attempts || 0) + 1, error: null, ...(a.state === 'running' ? { resumedAfterRestart: true } : {}) }); }
      catch (e) { failedWrite.set(takeId, Date.now()); console.error('[capture] analysis not started', takeId, e.message); return; }
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
      const at = new Date().toISOString();
      try {
        if (result) {
          await store.updateRecording(sid, takeId, (r) => { ((r.processing ||= {})[PROCESSOR] ||= {})[a.cam] = { ...result, at }; });
          await setState(sid, takeId, animId, { state: 'done', finishedAt: at, motionId: result.motionId, frames: result.frames ?? null, costUsd: result.costUsd ?? null }, { dequeue: true });
        } else {
          await setState(sid, takeId, animId, { state: 'error', finishedAt: at, error }, { dequeue: true });
        }
      } catch (e) {
        failedWrite.set(takeId, Date.now());              // the bucket refused: retried later, not re-run at once
        console.error('[capture] analysis result not saved', takeId, e.message);
      }
    } finally { runningHere.delete(takeId); progress.delete(takeId); }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = await next();
        if (!job) break;
        await runOne(job).catch((e) => console.error('[capture] analysis', e.message));
      }
    } catch (e) { console.error('[capture] analysis queue', e.message); }
    finally { pumping = false; }
  }

  /** A session was read: if it has queued work nobody is running, run it. */
  function touch(sid, session) {
    if (!session?.analysisQueue?.length) return;
    if (!known.has(sid) || !pumping) { known.add(sid); pump(); }
  }
  /** After a boot: every session with a queue. */
  async function resumeAll() {
    for (const s of await store.listSessions().catch(() => [])) if (s.analysisQueue?.length) known.add(s.id);
    pump();
  }
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
  return { enqueue, pump, touch, resumeAll, status, progress };
}

module.exports = { createQueue, PROCESSOR };
