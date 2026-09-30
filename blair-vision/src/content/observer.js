// Event-driven perception loop.
//   DOM mutation / visibility / scroll / heartbeat -> debounce -> detect -> fingerprint
//   -> unchanged? do NOTHING : analyze (abort any older request) -> update HUD.
// State machine: IDLE -> DETECTED -> STABILIZING -> ANALYZING -> ANSWERED -> WAITING_FOR_CHANGE

import { detectQuestion } from './question-detector.js';

export const DEBOUNCE_MS = 180;
export const MAX_WAIT_MS = 1000;
export const STABILIZE_MS = 150;
export const ERROR_RETRY_MS = 15000;
export const MAX_ERROR_RETRIES = 2;

/**
 * @param {{
 *  doc?: Document, win?: Window, hud: { setState:(s:any)=>void, host?: Element, state?: any },
 *  analyze: (msg:{requestId:number, question:any}) => Promise<{ok:boolean, result?:any, error?:string, code?:string, aborted?:boolean}>,
 *  cancel?: (requestId:number) => void,
 *  getSettings: () => any,
 *  detect?: (doc: Document) => any,
 *  log?: (...a:any[]) => void,
 *  now?: () => number,
 *  onResult?: (result:any, payload:any) => void,
 * }} deps
 */
export function createObserver(deps) {
  const { doc = document, hud, analyze, cancel = () => {}, getSettings, detect = detectQuestion, log = () => {}, now = () => Date.now(), onResult = () => {} } = deps;
  const win = /** @type {any} */ (deps.win ?? doc.defaultView);

  let state = 'IDLE';
  let lastFp = null; // fingerprint we are analyzing / have answered
  let pendingFp = null; // fingerprint awaiting stabilization
  let currentReq = 0;
  let inflight = 0; // requestId in flight, 0 = none
  let paused = false;
  let destroyed = false;
  let timer = null;
  let firstAt = 0;
  let stabilizeTimer = null;
  let heartbeatTimer = null;
  let mo = null;
  let lastError = null; // { fp, at, retries, code }
  let lastPayload = null;
  let lastResult = null;
  let lastShown = null; // HUD state of the answer currently on screen
  let invalidated = false; // HUD switched to "…" because the question changed; request still debounced
  let lastQuick = 0;
  const listeners = [];

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)); };

  function abortInflight() {
    if (inflight) { cancel(inflight); inflight = 0; }
    currentReq++; // any late response is now stale
  }

  function setKind(kind, extra = {}) {
    hud.setState({ kind, ...extra });
  }

  function schedule(reason) {
    if (destroyed || paused) return;
    const s = getSettings();
    if (!s.autoDetect) return;
    const t = now();
    if (!firstAt) firstAt = t;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - t));
    timer = setTimeout(() => { firstAt = 0; check('mutation'); }, wait);
    if (reason) log(`${reason} detected`);
    quickInvalidate();
  }

  /**
   * Leading-edge guard: the moment the on-screen question no longer matches the answer shown, stop showing
   * that answer. Costs one extract+hash (throttled) and NEVER sends a request; that stays debounced.
   */
  function quickInvalidate() {
    if (invalidated || (state !== 'ANSWERED' && state !== 'WAITING_FOR_CHANGE')) return;
    const t = now();
    if (t - lastQuick < 60) return;
    lastQuick = t;
    const r = detect(doc);
    if (r.found && r.payload.fingerprint === lastFp) return;
    invalidated = true;
    setKind('detecting');
  }

  /** One perception pass. Cheap when nothing changed: extract + hash + compare, then return. */
  function check(trigger = 'manual', { force = false } = {}) {
    if (destroyed || paused) return;
    const settings = getSettings();
    if (doc.visibilityState === 'hidden' && !settings.runWhenHidden) return; // never spend while hidden
    if (!settings.autoDetect && trigger !== 'manual') return;

    const r = detect(doc);
    if (!r.found) {
      if (lastFp !== null || pendingFp !== null) {
        abortInflight();
        lastFp = pendingFp = null;
        lastPayload = lastResult = lastShown = null;
      }
      invalidated = false;
      if (state !== 'IDLE' || hud.state?.kind !== (r.visual ? 'visual' : 'idle')) {
        state = 'IDLE';
        setKind(r.visual ? 'visual' : 'idle', r.visual ? { message: 'Visual content detected. Use “Analyze visible content” from the popup.' } : {});
      }
      return;
    }
    const p = r.payload;

    if (!force && p.fingerprint === lastFp) {
      if (invalidated && lastShown) { invalidated = false; hud.setState(lastShown); } // false alarm (partial render): restore
      if (state === 'ANSWERED') state = 'WAITING_FOR_CHANGE';
      maybeRetryAfterError(p);
      return; // unchanged: no model request, no HUD work
    }

    // New or changed question.
    if (state === 'IDLE' || state === 'ANSWERED' || state === 'WAITING_FOR_CHANGE') {
      state = 'DETECTED';
      log('candidate question found:', p.question.slice(0, 80));
    }
    if (!force && trigger !== 'mutation' && pendingFp !== p.fingerprint) {
      // Seen via heartbeat/scroll/visibility: confirm it is stable before spending anything.
      pendingFp = p.fingerprint;
      state = 'STABILIZING';
      setKind('detecting');
      clearTimeout(stabilizeTimer);
      stabilizeTimer = setTimeout(() => check('stabilize'), STABILIZE_MS);
      return;
    }
    if (trigger === 'mutation' || trigger === 'stabilize' || force) pendingFp = null;
    startAnalysis(p);
  }

  function startAnalysis(p) {
    abortInflight();
    const reqId = ++currentReq;
    inflight = reqId;
    lastFp = p.fingerprint;
    lastPayload = p;
    lastError = null;
    invalidated = false;
    state = 'ANALYZING';
    log('fingerprint:', p.fingerprint);
    setKind('thinking');
    Promise.resolve(analyze({ requestId: reqId, question: p })).then((res) => {
      if (destroyed || reqId !== currentReq || p.fingerprint !== lastFp) { log('stale response ignored'); return; }
      inflight = 0;
      if (res?.ok) {
        lastError = null;
        lastResult = res.result;
        const r = res.result;
        log(`Answer ${r.answer} confidence=${r.confidence.toFixed(2)}`);
        state = 'ANSWERED';
        lastShown = {
          kind: r.lowConfidence ? 'low' : 'result',
          answer: r.answer, answerText: r.answerText, confidence: r.confidence, latencyMs: r.latencyMs,
          source: r.source, pageSource: p.source, cost: r.cost, probabilities: r.probabilities, reason: r.reason,
        };
        hud.setState(lastShown);
        log('HUD updated');
        onResult(r, p);
      } else if (!res?.aborted) {
        state = 'WAITING_FOR_CHANGE';
        lastError = { fp: p.fingerprint, at: now(), retries: (lastError?.retries ?? 0), code: res?.code };
        log('error:', res?.error);
        setKind('error', { message: res?.error || 'Request failed' });
      }
    }, (err) => {
      if (destroyed || reqId !== currentReq) return;
      inflight = 0;
      state = 'WAITING_FOR_CHANGE';
      lastError = { fp: p.fingerprint, at: now(), retries: 0, code: 'exception' };
      setKind('error', { message: String(err?.message || err) });
    });
  }

  // A failed request may be retried a couple of times at heartbeat pace; never for config errors.
  function maybeRetryAfterError(p) {
    if (!lastError || lastError.fp !== p.fingerprint) return;
    if (['no_key', 'bad_key', 'config', 'no_credits'].includes(lastError.code)) return;
    if (lastError.retries >= MAX_ERROR_RETRIES || now() - lastError.at < ERROR_RETRY_MS) return;
    const prev = lastError;
    startAnalysis(p);
    lastError = { ...prev, at: now(), retries: prev.retries + 1 };
  }

  function start() {
    if (mo || destroyed) return;
    mo = new win.MutationObserver((records) => {
      const host = hud.host;
      if (host && records.every((r) => host.contains(r.target))) return; // our own HUD
      schedule('mutation');
    });
    mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'aria-hidden', 'aria-checked', 'aria-selected', 'disabled'] });
    on(doc, 'visibilitychange', () => { if (doc.visibilityState === 'visible') check('visible'); });
    on(win, 'scroll', () => schedule(''), { passive: true });
    on(win, 'popstate', () => schedule('navigation'));
    on(win, 'hashchange', () => schedule('navigation'));
    const beat = () => {
      clearInterval(heartbeatTimer);
      const sec = Math.max(2, Number(getSettings().heartbeatSec) || 5);
      heartbeatTimer = setInterval(() => check('heartbeat'), sec * 1000);
    };
    beat();
    check('mutation'); // initial understanding of the visible page
  }

  return {
    start,
    check,
    get state() { return state; },
    get lastResult() { return lastResult; },
    get lastPayload() { return lastPayload; },
    /** Re-read settings (e.g. heartbeat interval) and re-evaluate the page. */
    refresh() {
      clearInterval(heartbeatTimer);
      const sec = Math.max(2, Number(getSettings().heartbeatSec) || 5);
      heartbeatTimer = setInterval(() => check('heartbeat'), sec * 1000);
      lastFp = pendingFp = null;
      if (!paused) check('mutation');
    },
    setPaused(p) {
      if (paused === p) return;
      paused = p;
      if (p) {
        abortInflight();
        clearTimeout(timer); clearTimeout(stabilizeTimer);
        state = 'IDLE';
        setKind('paused');
      } else {
        lastFp = pendingFp = null;
        setKind('idle');
        check('mutation');
      }
    },
    get paused() { return paused; },
    destroy() {
      destroyed = true;
      abortInflight();
      clearTimeout(timer); clearTimeout(stabilizeTimer); clearInterval(heartbeatTimer);
      mo?.disconnect();
      listeners.forEach((off) => off());
    },
  };
}
