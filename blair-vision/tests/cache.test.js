import { describe, it, expect, vi } from 'vitest';
import { createStore, CACHE_LIMIT } from '../src/shared/storage.js';
import { createRouter } from '../src/background/provider-router.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';
import { fingerprintQuestion } from '../src/content/fingerprint.js';
import { averageLatency } from '../src/shared/cost.js';
import { memoryArea, Q } from './helpers.js';

const settings = { ...DEFAULT_SETTINGS, typesafeKey: 'k', threshold: 0.7 };

function setup({ jevAnswer = 'C', confidence = 0.91, probs, fallbackAnswer } = {}) {
  const store = createStore(memoryArea());
  const jev = { decide: vi.fn(async (q) => ({
    answer: jevAnswer, confidence, latencyMs: 400, usage: { cost: 0.00002 }, model: 'jev',
    probabilities: probs ?? Object.fromEntries(q.choices.map((c) => [c.id, c.id === jevAnswer ? 0.9 : 0.1 / (q.choices.length - 1)])),
    ambiguous: false,
  })) };
  const fallback = { decide: vi.fn(async () => ({ answer: fallbackAnswer ?? 'A', confidence: 0.8, latencyMs: 900, usage: { cost: 0.001 }, reason: 'because', model: 'fb' })) };
  return { store, jev, fallback, router: createRouter({ store, jev, fallback }) };
}

const mk = (question, texts) => {
  const choices = texts.map((t, i) => ({ id: 'ABCD'[i], text: t }));
  return { question, choices, context: '', url: 'http://x/', ...fingerprintQuestion(question, choices) };
};

describe('cache', () => {
  it('second identical question makes ZERO model calls', async () => {
    const { router, jev, store } = setup();
    const q = Q();
    const a = await router.analyze(q, settings);
    const b = await router.analyze(q, settings);
    expect(a.source).toBe('jev');
    expect(b.source).toBe('cache');
    expect(b.answer).toBe('C');
    expect(b.cost).toBe(0);
    expect(jev.decide).toHaveBeenCalledTimes(1);
    const s = await store.getStats();
    expect(s).toMatchObject({ questionsAnalyzed: 2, cacheHits: 1, jevCalls: 1, fallbackCalls: 0 });
    expect(s.estimatedCost).toBeCloseTo(0.00002);
    expect(averageLatency(s)).toBe(400);
  });

  it('reordered choices still hit the cache and map to the new letter', async () => {
    const { router, jev } = setup({ jevAnswer: 'C' });
    await router.analyze(mk('Largest planet?', ['Earth', 'Mars', 'Jupiter', 'Venus']), settings); // Jupiter = C
    const r = await router.analyze(mk('Largest planet?', ['Jupiter', 'Venus', 'Earth', 'Mars']), settings);
    expect(r.source).toBe('cache');
    expect(r.answer).toBe('A');
    expect(r.answerText).toBe('Jupiter');
    expect(r.probabilities.A).toBeGreaterThan(0.8);
    expect(jev.decide).toHaveBeenCalledTimes(1);
  });

  it('different questions miss the cache', async () => {
    const { router, jev } = setup({ jevAnswer: 'A' });
    await router.analyze(mk('Q one?', ['x', 'y']), settings);
    await router.analyze(mk('Q two?', ['x', 'y']), settings);
    expect(jev.decide).toHaveBeenCalledTimes(2);
  });

  it('clear cache forces a new call', async () => {
    const { router, jev, store } = setup();
    await router.analyze(Q(), settings);
    await store.cacheClear();
    expect(await store.cacheSize()).toBe(0);
    await router.analyze(Q(), settings);
    expect(jev.decide).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entries beyond the limit', async () => {
    const store = createStore(memoryArea());
    for (let i = 0; i < CACHE_LIMIT + 5; i++) await store.cacheSet(`k${i}`, { answerText: 'x', confidence: 1 });
    expect(await store.cacheSize()).toBe(CACHE_LIMIT);
    expect(await store.cacheGet('k0')).toBeNull();
    expect(await store.cacheGet(`k${CACHE_LIMIT + 4}`)).not.toBeNull();
  });

  it('does not cache failures', async () => {
    const { router, jev, store } = setup();
    jev.decide.mockRejectedValueOnce(new Error('boom'));
    await expect(router.analyze(Q(), settings)).rejects.toThrow('boom');
    expect(await store.cacheSize()).toBe(0);
  });
});

describe('reasoning fallback', () => {
  it('is OFF by default: low confidence stays Jev-only', async () => {
    const { router, fallback } = setup({ confidence: 0.4 });
    const r = await router.analyze(Q(), settings);
    expect(fallback.decide).not.toHaveBeenCalled();
    expect(r.source).toBe('jev');
    expect(r.lowConfidence).toBe(true);
  });

  it('when enabled, runs only for low confidence / ambiguity / reasoning-heavy questions', async () => {
    const on = { ...settings, reasoningFallback: true };
    let t = setup({ confidence: 0.95 });
    await t.router.analyze(mk('Capital of France?', ['Paris', 'Rome']), on);
    expect(t.fallback.decide).not.toHaveBeenCalled();

    t = setup({ confidence: 0.5, fallbackAnswer: 'B' });
    const low = await t.router.analyze(mk('Some hard one?', ['x', 'y']), on);
    expect(t.fallback.decide).toHaveBeenCalledTimes(1);
    expect(low).toMatchObject({ source: 'fallback', answer: 'B', reason: 'because' });
    const s = await t.store.getStats();
    expect(s).toMatchObject({ jevCalls: 1, fallbackCalls: 1 });

    t = setup({ confidence: 0.95 });
    await t.router.analyze(mk('Calculate 12 * 13', ['156', '146']), on);
    expect(t.fallback.decide).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully to Jev when the fallback errors', async () => {
    const t = setup({ confidence: 0.3 });
    t.fallback.decide.mockRejectedValue(new Error('down'));
    const r = await t.router.analyze(Q(), { ...settings, reasoningFallback: true });
    expect(r.source).toBe('jev');
    expect(r.answer).toBe('C');
  });
});
