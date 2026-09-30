import { DEFAULT_SETTINGS, EMPTY_STATS } from './types.js';

const CACHE_KEY = 'bv_cache';
const STATS_KEY = 'bv_stats';
export const CACHE_LIMIT = 500;

/** Serialises read-modify-write cycles so concurrent updates don't clobber each other. */
function queue() {
  let p = Promise.resolve();
  return (fn) => {
    const run = p.then(fn, fn);
    p = run.catch(() => {});
    return run;
  };
}

/**
 * Storage facade over a chrome.storage-like area ({ get, set, remove }).
 * Injectable so tests can pass an in-memory fake.
 */
export function createStore(area) {
  const enqueue = queue();

  const store = {
    async getSettings() {
      const stored = await area.get(Object.keys(DEFAULT_SETTINGS));
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    async saveSettings(patch) {
      const clean = {};
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) clean[k] = v;
      await area.set(clean);
      return store.getSettings();
    },

    // fingerprint (contentKey) -> { answerText, answer, confidence, latencyMs, probabilities, source, ts }
    async cacheGet(key) {
      const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
      return cache[key] || null;
    },
    cacheSet(key, entry) {
      return enqueue(async () => {
        const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
        cache[key] = { ...entry, ts: Date.now() };
        const keys = Object.keys(cache);
        if (keys.length > CACHE_LIMIT) {
          keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, keys.length - CACHE_LIMIT).forEach((k) => delete cache[k]);
        }
        await area.set({ [CACHE_KEY]: cache });
      });
    },
    async cacheSize() {
      const { [CACHE_KEY]: cache = {} } = await area.get(CACHE_KEY);
      return Object.keys(cache).length;
    },
    cacheClear: () => enqueue(() => area.remove(CACHE_KEY)),

    async getStats() {
      const { [STATS_KEY]: s = {} } = await area.get(STATS_KEY);
      return { ...EMPTY_STATS, ...s };
    },
    updateStats(reducer) {
      return enqueue(async () => {
        const { [STATS_KEY]: s = {} } = await area.get(STATS_KEY);
        const next = reducer({ ...EMPTY_STATS, ...s });
        await area.set({ [STATS_KEY]: next });
        return next;
      });
    },
    resetStats: () => enqueue(() => area.remove(STATS_KEY)),
  };
  return store;
}
