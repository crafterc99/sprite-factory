/** In-memory stand-in for chrome.storage.local. */
export function memoryArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') keys = [keys];
      const out = {};
      for (const k of keys ?? Object.keys(data)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(k) { delete data[k]; },
  };
}

export const Q = (over = {}) => ({
  question: 'What planet is largest?',
  choices: [{ id: 'A', text: 'Earth' }, { id: 'B', text: 'Mars' }, { id: 'C', text: 'Jupiter' }, { id: 'D', text: 'Venus' }],
  context: '', url: 'http://x/', fingerprint: 'fp1', contentKey: 'ck1', ...over,
});
