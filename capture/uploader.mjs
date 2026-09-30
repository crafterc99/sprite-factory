/**
 * Soul Jam Capture — the resumable uploader. Every recorded chunk is written to IndexedDB on the
 * device FIRST, then uploaded (PUT, idempotent per chunk number) with retries and backoff; the
 * take's "complete" message (frame times, camera metadata) is queued the same way and only sent
 * once all of its chunks are in. A page refresh, an app restart or a Wi-Fi drop loses nothing:
 * on load the queue resumes where it stopped. Chunks are deleted from the device only after the
 * server confirmed them.
 */

const DB = 'souljam-capture', VER = 1;
function db() {
  return (db._p ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('finals')) d.createObjectStore('finals', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
const all = (store) => tx(store, 'readonly', (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Uploader {
  /** @param base '' (same origin) · token: the pairing token (cameras) · onProgress({pending, sentBytes, error, done}) */
  constructor({ base = '', token = null, onProgress = null, onComplete = null } = {}) {
    Object.assign(this, { base, token, onProgress, onComplete });
    this.running = false; this.sentBytes = 0; this.error = null; this.kick = null;
    window.addEventListener('online', () => this.wake());
  }
  headers(extra = {}) { return { ...(this.token ? { 'X-Capture-Token': this.token } : {}), ...extra }; }
  /** A chunk: persisted on the device before anything else. */
  async addChunk({ sessionId, takeId, cam, seq, blob }) {
    await tx('chunks', 'readwrite', (s) => s.put({ k: `${takeId}|${cam}|${String(seq).padStart(5, '0')}`, sessionId, takeId, cam, seq, blob, size: blob.size, at: Date.now() }));
    this.wake();
  }
  /** The take's end: sent after its chunks (the server assembles and validates). */
  async addFinal({ sessionId, takeId, cam, payload }) {
    await tx('finals', 'readwrite', (s) => s.put({ k: `${takeId}|${cam}`, sessionId, takeId, cam, payload, at: Date.now() }));
    this.wake();
  }
  async pending() {
    const [c, f] = await Promise.all([all('chunks'), all('finals')]);
    return { chunks: c.length, bytes: c.reduce((a, x) => a + x.size, 0), finals: f.length, takes: [...new Set([...c, ...f].map((x) => x.takeId))] };
  }
  wake() { if (this.kick) this.kick(); if (!this.running) this.run(); }
  async report(extra = {}) { try { const p = await this.pending(); this.onProgress?.({ ...p, sentBytes: this.sentBytes, error: this.error, ...extra }); } catch {} }
  async run() {
    if (this.running) return;
    this.running = true;
    let backoff = 500;
    try {
      for (;;) {
        const chunks = (await all('chunks')).sort((a, b) => (a.k < b.k ? -1 : 1));
        const finals = await all('finals');
        if (!chunks.length && !finals.length) { this.error = null; await this.report({ idle: true }); break; }
        try {
          if (chunks.length) {
            const c = chunks[0];
            const r = await fetch(`${this.base}/api/capture/sessions/${c.sessionId}/rec/${c.takeId}/${c.cam}/chunk/${c.seq}`, { method: 'PUT', headers: this.headers({ 'Content-Type': 'application/octet-stream' }), body: c.blob });
            if (r.status === 404) { await tx('chunks', 'readwrite', (s) => s.delete(c.k)); continue; }      // the take no longer exists
            if (!r.ok) throw new Error(`chunk upload HTTP ${r.status}`);
            await tx('chunks', 'readwrite', (s) => s.delete(c.k));
            this.sentBytes += c.size;
          } else {
            // finals whose chunks are all sent
            const f = finals[0];
            const r = await fetch(`${this.base}/api/capture/sessions/${f.sessionId}/rec/${f.takeId}/${f.cam}/complete`, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(f.payload) });
            if (r.status === 409) {
              const j = await r.json().catch(() => ({}));
              throw new Error(`server is missing chunks ${JSON.stringify(j.missing || [])} of ${f.takeId}`);
            }
            if (r.status === 404) { await tx('finals', 'readwrite', (s) => s.delete(f.k)); continue; }
            if (!r.ok) throw new Error(`complete HTTP ${r.status}`);
            await tx('finals', 'readwrite', (s) => s.delete(f.k));
            this.onComplete?.(f, await r.json().catch(() => null));
          }
          this.error = null; backoff = 500;
          await this.report();
        } catch (e) {
          this.error = e.message;
          await this.report();
          await Promise.race([sleep(backoff), new Promise((r) => { this.kick = r; })]);
          this.kick = null;
          backoff = Math.min(15000, backoff * 2);
        }
      }
    } finally { this.running = false; }
  }
}
