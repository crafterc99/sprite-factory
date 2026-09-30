import { describe, it, expect, vi } from 'vitest';
import { buildRequest, createJevProvider, validateChoice, endpointFor, ProviderError } from '../src/providers/jev.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';
import { Q } from './helpers.js';

const settings = { ...DEFAULT_SETTINGS, typesafeKey: 'test-key' };
const okBody = (over = {}) => ({
  answers: { answer: { choice: 'C', confidence: 0.91, probabilities: { A: 0.03, B: 0.03, C: 0.91, D: 0.03 } } },
  usage: { cost: 0.00003 }, model: 'typesafe/jev-1.13', ...over,
});
const resp = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe('request', () => {
  it('is a minimal choice question with candidates as criteria', () => {
    const r = buildRequest(Q({ context: 'ctx' }), settings);
    expect(r.model).toBe('~typesafe/jev-latest');
    expect(r.questions.answer.type).toBe('choice');
    expect(r.questions.answer.criteria).toEqual({ A: 'Earth', B: 'Mars', C: 'Jupiter', D: 'Venus' });
    expect(r.state.question).toBe('What planet is largest?');
    expect(r.state.page.text).toBe('ctx');
    expect(JSON.stringify(r).length).toBeLessThan(800);
  });
  it('picks endpoint per provider', () => {
    expect(endpointFor({ ...settings, provider: 'openrouter', openrouterKey: 'k' }).url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(endpointFor({ ...settings, provider: 'jbc', jbcKey: 'k' }).url).toBe('https://jevbrowsercontrol.com/api/v1/decisions');
    expect(endpointFor(settings).url).toBe('https://api.typesafe.ai/v1/systemone');
  });
});

describe('decide', () => {
  it('parses a valid response and reports latency, usage and ambiguity', async () => {
    const fetchImpl = vi.fn(async () => resp(okBody()));
    const r = await createJevProvider({ fetchImpl }).decide(Q(), settings);
    expect(r).toMatchObject({ answer: 'C', confidence: 0.91, ambiguous: false, usage: { cost: 0.00003 } });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });
  it('flags ambiguity when top two are close', async () => {
    const body = okBody({ answers: { answer: { choice: 'C', confidence: 0.4, probabilities: { A: 0.05, B: 0.05, C: 0.45, D: 0.45 } } } });
    const r = await createJevProvider({ fetchImpl: async () => resp(body) }).decide(Q(), settings);
    expect(r.ambiguous).toBe(true);
  });
  it('refuses without a key, without calling the network', async () => {
    const fetchImpl = vi.fn();
    await expect(createJevProvider({ fetchImpl }).decide(Q(), { ...settings, typesafeKey: '' })).rejects.toMatchObject({ code: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('maps HTTP errors', async () => {
    const p = createJevProvider({ fetchImpl: async () => resp({ error: { message: 'nope' } }, 401) });
    await expect(p.decide(Q(), settings)).rejects.toMatchObject({ code: 'bad_key', status: 401 });
  });
  it('reads TypeSafe-style error bodies', async () => {
    const p = createJevProvider({ fetchImpl: async () => resp({ detail: { error_type: 'authentication_error', message: 'Cannot authenticate' } }, 401) });
    await expect(p.decide(Q(), settings)).rejects.toThrow(/Cannot authenticate/);
  });
  it('rejects malformed distributions', async () => {
    const bad = okBody({ answers: { answer: { choice: 'Z', confidence: 0.9, probabilities: { A: 1 } } } });
    await expect(createJevProvider({ fetchImpl: async () => resp(bad) }).decide(Q(), settings)).rejects.toBeInstanceOf(ProviderError);
  });
  it('propagates abort', async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn((_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))));
    const p = createJevProvider({ fetchImpl }).decide(Q(), settings, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('validateChoice', () => {
    const ids = ['A', 'B'];
    expect(() => validateChoice({ choice: 'A', confidence: 0.6, probabilities: { A: 0.6, B: 0.4 } }, ids)).not.toThrow();
    expect(() => validateChoice({ choice: 'B', confidence: 0.6, probabilities: { A: 0.6, B: 0.4 } }, ids)).toThrow();
  });
});
