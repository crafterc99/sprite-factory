// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createObserver, DEBOUNCE_MS } from '../src/content/observer.js';
import { Q } from './helpers.js';

const settings = { autoDetect: true, heartbeatSec: 5, runWhenHidden: false };
const result = (answer = 'C', over = {}) => ({ ok: true, result: { answer, answerText: 'x', confidence: 0.9, latencyMs: 10, source: 'jev', cost: 0, lowConfidence: false, ...over } });

function setup({ analyze } = {}) {
  let payload = Q({ fingerprint: 'fp1' });
  let found = true;
  const hud = { states: [], setState(s) { this.states.push(s); this.state = s; }, state: null, host: document.createElement('div') };
  const an = vi.fn(analyze ?? (async () => result()));
  const cancel = vi.fn();
  const obs = createObserver({ hud, analyze: an, cancel, getSettings: () => settings, detect: () => (found ? { found: true, payload } : { found: false, visual: false }) });
  return {
    obs, hud, an, cancel,
    set: (fp, extra = {}) => { payload = Q({ fingerprint: fp, ...extra }); },
    setFound: (f) => { found = f; },
  };
}
const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('observer', () => {
  it('analyzes once, then does NOTHING while the fingerprint is unchanged (mutations + heartbeats)', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    expect(t.an).toHaveBeenCalledTimes(1);
    expect(t.hud.state).toMatchObject({ kind: 'result', answer: 'C' });
    const calls = t.hud.states.length;
    // 20 heartbeats + a burst of mutations with an unchanged question
    for (let i = 0; i < 5; i++) { document.body.append(document.createElement('span')); await tick(DEBOUNCE_MS + 20); }
    await tick(100_000);
    expect(t.an).toHaveBeenCalledTimes(1);
    expect(t.hud.states.length).toBe(calls); // not even a HUD write
    expect(t.obs.state).toBe('WAITING_FOR_CHANGE');
    t.obs.destroy();
  });

  it('follows question changes automatically via MutationObserver (debounced)', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    t.set('fp2');
    document.body.append(document.createElement('div'));
    await tick(DEBOUNCE_MS + 30);
    expect(t.an).toHaveBeenCalledTimes(2);
    expect(t.an.mock.calls[1][0].question.fingerprint).toBe('fp2');
    t.obs.destroy();
  });

  it('coalesces a burst of mutations into one analysis', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    t.set('fp2');
    for (let i = 0; i < 20; i++) { document.body.append(document.createElement('i')); await tick(10); }
    await tick(DEBOUNCE_MS + 30);
    expect(t.an).toHaveBeenCalledTimes(2);
    t.obs.destroy();
  });

  it('heartbeat catches a change the observer missed, after stabilizing', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    t.set('fp2'); // no mutation event
    await tick(5000 + 10);
    expect(t.obs.state).toBe('STABILIZING');
    expect(t.hud.state.kind).toBe('detecting');
    await tick(200);
    expect(t.an).toHaveBeenCalledTimes(2);
    t.obs.destroy();
  });

  it('never shows an answer that belongs to the previous question (stale response ignored, old request cancelled)', async () => {
    const resolvers = [];
    const t = setup({ analyze: () => new Promise((r) => resolvers.push(r)) });
    t.obs.start();
    await tick(10);
    t.set('fp2');
    document.body.append(document.createElement('div'));
    await tick(DEBOUNCE_MS + 30);
    expect(t.an).toHaveBeenCalledTimes(2);
    expect(t.cancel).toHaveBeenCalledWith(t.an.mock.calls[0][0].requestId);
    resolvers[1](result('B'));
    await tick(0);
    resolvers[0](result('A')); // late answer for question 1
    await tick(0);
    expect(t.hud.state).toMatchObject({ kind: 'result', answer: 'B' });
    t.obs.destroy();
  });

  it('stops showing the old answer immediately when the question changes (no request until debounce)', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    expect(t.hud.state.kind).toBe('result');
    t.set('fp2');
    document.body.append(document.createElement('div'));
    await tick(0); // microtask: MutationObserver callback ran
    expect(t.hud.state.kind).toBe('detecting');
    expect(t.an).toHaveBeenCalledTimes(1); // still no new request
    await tick(DEBOUNCE_MS + 30);
    expect(t.an).toHaveBeenCalledTimes(2);
    t.obs.destroy();
  });

  it('restores the answer if the "change" was a partial render that settled back to the same question', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    t.setFound(false); // mid-render: question briefly gone
    document.body.append(document.createElement('div'));
    await tick(0);
    expect(t.hud.state.kind).toBe('detecting');
    t.setFound(true); // same fp1 again
    await tick(DEBOUNCE_MS + 30);
    expect(t.hud.state).toMatchObject({ kind: 'result', answer: 'C' });
    expect(t.an).toHaveBeenCalledTimes(1);
    t.obs.destroy();
  });

  it('does nothing while the tab is hidden', async () => {
    const t = setup();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    t.obs.start();
    await tick(10_000);
    expect(t.an).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(200);
    expect(t.an).toHaveBeenCalledTimes(1);
    t.obs.destroy();
  });

  it('pause stops requests and cancels in-flight; resume re-evaluates', async () => {
    const t = setup({ analyze: () => new Promise(() => {}) });
    t.obs.start();
    await tick(10);
    t.obs.setPaused(true);
    expect(t.cancel).toHaveBeenCalled();
    expect(t.hud.state.kind).toBe('paused');
    t.set('fp2');
    document.body.append(document.createElement('div'));
    await tick(6000);
    expect(t.an).toHaveBeenCalledTimes(1);
    t.obs.setPaused(false);
    await tick(10);
    expect(t.an).toHaveBeenCalledTimes(2);
    t.obs.destroy();
  });

  it('shows low confidence as "answer ?" state and errors without hammering', async () => {
    let n = 0;
    const t = setup({ analyze: async () => (++n === 1 ? result('C', { lowConfidence: true, confidence: 0.5 }) : { ok: false, error: 'HTTP 500', code: 'http' }) });
    t.obs.start();
    await tick(10);
    expect(t.hud.state.kind).toBe('low');
    t.set('fp2');
    document.body.append(document.createElement('div'));
    await tick(DEBOUNCE_MS + 30);
    expect(t.hud.state).toMatchObject({ kind: 'error', message: 'HTTP 500' });
    const calls = t.an.mock.calls.length;
    await tick(10_000); // < ERROR_RETRY_MS: no retry
    expect(t.an.mock.calls.length).toBe(calls);
    t.obs.destroy();
  });

  it('config errors (no key) are never retried', async () => {
    const t = setup({ analyze: async () => ({ ok: false, error: 'no key', code: 'no_key' }) });
    t.obs.start();
    await tick(200_000);
    expect(t.an).toHaveBeenCalledTimes(1);
    t.obs.destroy();
  });

  it('question disappearing resets to idle', async () => {
    const t = setup();
    t.obs.start();
    await tick(10);
    t.setFound(false);
    document.body.append(document.createElement('div'));
    await tick(DEBOUNCE_MS + 30);
    expect(t.hud.state.kind).toBe('idle');
    expect(t.obs.state).toBe('IDLE');
    t.obs.destroy();
  });
});
