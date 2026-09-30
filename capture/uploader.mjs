/**
 * Soul Jam Capture — the resumable uploader. Every recorded chunk is written to IndexedDB on the
 * device FIRST, then uploaded (PUT, idempotent per chunk number) with retries and backoff; the
 * take's "complete" message (frame times, camera metadata) is queued the same way and only sent
 * once all of its chunks are in. A page refresh, an app restart or a Wi-Fi drop loses nothing:
 * on load the queue resumes where it stopped.
 *
 * The device's copy is the backup until the server has SAVED the recording: chunks are kept
 * (marked sent) until the take's "complete" is confirmed — the server answers it only after the
 * recording is in cloud storage — and chunks the server lost (a redeploy mid-upload) are sent
 * again. A recording cut short by a reload or an app kill is finished with what was recorded.
 * Nothing is ever deleted because the server said "not found": that footage is kept aside on the
 * device (keptAside / saveKept / dropKept) until the operator saves or discards it.
 */

const DB = 'souljam-capture', VER = 2;
function db() {
  return (db._p ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('finals')) d.createObjectStore('finals', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('kept')) d.createObjectStore('kept', { keyPath: 'k' });
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); db._p = null; }; resolve(d); };
    r.onerror = () => reject(r.error);
    // an older capture tab still has the database open: it is asked to let go (above); until then say so
    r.onblocked = () => window.dispatchEvent(new CustomEvent('sjc-db-blocked'));
  }));
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(Array.isArray(stores) ? stores.map((s) => t.objectStore(s)) : t.objectStore(stores))).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
const all = (store) => tx(store, 'readonly', (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = (x) => `${x.takeId}|${x.cam}`;
/** The Web Lock a page holds while it records a take (so another tab never 'recovers' it). */
export const recLock = (takeId, cam) => `sjc-rec:${takeId}|${cam}`;

export class Uploader {
  /** @param base '' (same origin) · token: the pairing token (cameras) · onProgress({pending, sentBytes, error, done}) */
  constructor({ base = '', token = null, onProgress = null, onComplete = null } = {}) {
    Object.assign(this, { base, token, onProgress, onComplete });
    this.running = false; this.sentBytes = 0; this.error = null; this.kick = null;
    window.addEventListener('online', () => this.wake());
  }
  /** Each queued item goes up with the pairing of the session it was recorded for. */
  headers(item, extra = {}) { const t = item?.token !== undefined ? item.token : this.token; return { ...(t ? { 'X-Capture-Token': t } : {}), ...extra }; }
  /** A chunk: persisted on the device before anything else. */
  async addChunk({ sessionId, takeId, cam, seq, blob, mime = null }) {
    await tx('chunks', 'readwrite', (s) => s.put({ k: `${takeId}|${cam}|${String(seq).padStart(5, '0')}`, sessionId, takeId, cam, seq, blob, size: blob.size, mime, token: this.token, sent: false, at: Date.now() }));
    this.wake();
  }
  /** The take's end: sent after its chunks (the server assembles, saves and validates). */
  async addFinal({ sessionId, takeId, cam, payload }) {
    await tx('finals', 'readwrite', (s) => s.put({ k: `${takeId}|${cam}`, sessionId, takeId, cam, payload, token: this.token, at: Date.now() }));
    this.wake();
  }
  /**
   * After a reload / app kill mid-take: recordings with chunks on the device but no "complete"
   * (the recorder died with the page) are finished with what was recorded. Call before recording.
   */
  async recoverInterrupted({ exceptTakeId = null } = {}) {
    const [chunks, finals] = await Promise.all([all('chunks'), all('finals')]);
    const done = new Set(finals.map(group));
    // a recording another tab of this browser is still making holds its lock (CameraRole): not interrupted
    let held = new Set();
    try { const q = await navigator.locks?.query?.(); held = new Set([...(q?.held || []), ...(q?.pending || [])].map((l) => l.name)); } catch {}
    const open = new Map();
    for (const c of chunks) {
      if (c.takeId === exceptTakeId || done.has(group(c)) || held.has(recLock(c.takeId, c.cam))) continue;
      const g = open.get(group(c)) || { ...c, n: 0, have: new Set() }; g.n = Math.max(g.n, c.seq + 1); g.have.add(c.seq); g.mime ||= c.mime; g.token ||= c.token; open.set(group(c), g);
    }
    for (const g of open.values()) {
      const gaps = []; for (let i = 0; i < g.n; i++) if (!g.have.has(i)) gaps.push(i);
      await tx('finals', 'readwrite', (s) => s.put({ k: `${g.takeId}|${g.cam}`, sessionId: g.sessionId, takeId: g.takeId, cam: g.cam, token: g.token ?? this.token, at: Date.now(), payload: { chunks: g.n, gaps, mimeType: g.mime || 'video/webm', frames: [], mediaTimes: [],
        meta: { source: 'web', interrupted: 'the camera page was reloaded or closed while recording: finished with the chunks recorded until then (no frame times)', recoveredAt: new Date().toISOString() } } }));
    }
    if (open.size) this.wake();
    return open.size;
  }
  async pending() {
    const [c, f, k] = await Promise.all([all('chunks'), all('finals'), all('kept')]);
    const unsent = c.filter((x) => !x.sent);
    return { chunks: unsent.length, bytes: unsent.reduce((a, x) => a + x.size, 0), held: c.length, finals: f.length, takes: [...new Set([...unsent, ...f].map((x) => x.takeId))],
      kept: new Set(k.filter((x) => x.kind === 'chunk').map(group)).size, keptBytes: k.reduce((a, x) => a + (x.size || 0), 0) };
  }
  wake() { if (this.kick) this.kick(); if (!this.running) this.run(); }
  async report(extra = {}) { try { const p = await this.pending(); this.onProgress?.({ ...p, sentBytes: this.sentBytes, error: this.error, ...extra }); } catch {} }
  /** The server no longer knows this take: keep its footage aside on the device (never delete it). */
  async keepAside(takeId, cam, why) {
    await tx(['chunks', 'finals', 'kept'], 'readwrite', ([cs, fs, ks]) => new Promise((res) => {
      const r = cs.getAll(); r.onsuccess = () => {
        for (const c of r.result) if (c.takeId === takeId && c.cam === cam) { ks.put({ ...c, k: 'c|' + c.k, kind: 'chunk', why }); cs.delete(c.k); }
        const f = fs.get(`${takeId}|${cam}`); f.onsuccess = () => { if (f.result) { ks.put({ ...f.result, k: 'f|' + f.result.k, kind: 'final', why }); fs.delete(f.result.k); } res(); };
      };
    }));
  }
  /** Footage kept aside, as one file per recording (to save on the phone). */
  async keptFiles() {
    const k = (await all('kept')).filter((x) => x.kind === 'chunk').sort((a, b) => (a.k < b.k ? -1 : 1));
    const by = new Map();
    for (const c of k) { const g = by.get(group(c)) || { takeId: c.takeId, cam: c.cam, mime: c.mime || 'video/webm', parts: [] }; g.parts.push(c.blob); by.set(group(c), g); }
    return [...by.values()].map((g) => ({ name: `${g.takeId}-${g.cam}.${/mp4/.test(g.mime) ? 'mp4' : 'webm'}`, blob: new Blob(g.parts, { type: g.mime.split(';')[0] }) }));
  }
  async dropKept() { await tx('kept', 'readwrite', (s) => s.clear()); await this.report(); }
  async run() {
    if (this.running) return;
    this.running = true;
    let backoff = 500;
    const blocked = new Map();                               // group → retry time (refused: the others go first)
    const refuse = (x, status) => { blocked.set(group(x), Date.now() + 30000); this.error = `the server refused ${x.takeId} (HTTP ${status}) — retrying later`; };
    try {
      for (;;) {
        const now = Date.now();
        const chunks = await all('chunks');
        const allUnsent = chunks.filter((c) => !c.sent), allFinals = await all('finals');
        const open = (x) => !(blocked.get(group(x)) > now);
        const unsent = allUnsent.filter(open).sort((a, b) => (a.k < b.k ? -1 : 1));
        const finals = allFinals.filter(open).filter((f) => !allUnsent.some((c) => group(c) === group(f))).sort((a, b) => (a.k < b.k ? -1 : 1));
        if (!allUnsent.length && !allFinals.length) { this.error = null; await this.report({ idle: true }); break; }
        if (!unsent.length && !finals.length) {             // everything left is waiting on a refusal
          await this.report();
          const next = Math.min(...[...blocked.values()].filter((t) => t > now), now + 30000);
          await Promise.race([sleep(Math.max(500, next - now)), new Promise((r) => { this.kick = r; })]); this.kick = null;
          continue;
        }
        try {
          if (unsent.length) {
            const c = unsent[0];
            const r = await fetch(`${this.base}/api/capture/sessions/${c.sessionId}/rec/${c.takeId}/${c.cam}/chunk/${c.seq}`, { method: 'PUT', headers: this.headers(c, { 'Content-Type': 'application/octet-stream' }), body: c.blob });
            if (r.status === 404) { await this.keepAside(c.takeId, c.cam, 'the server does not know this take'); continue; }
            if (r.status === 401 || r.status === 403) { refuse(c, r.status); await this.report(); continue; }
            if (!r.ok) throw new Error(`chunk upload HTTP ${r.status}`);
            await tx('chunks', 'readwrite', (s) => s.put({ ...c, sent: true }));          // kept until the recording is saved
            this.sentBytes += c.size;
          } else {
            const f = finals[0];
            const r = await fetch(`${this.base}/api/capture/sessions/${f.sessionId}/rec/${f.takeId}/${f.cam}/complete`, { method: 'POST', headers: this.headers(f, { 'Content-Type': 'application/json' }), body: JSON.stringify(f.payload) });
            if (r.status === 401 || r.status === 403) { refuse(f, r.status); await this.report(); continue; }
            if (r.status === 409) {
              // the server lost chunks (e.g. a redeploy mid-upload): send them again from the device
              const missing = ((await r.json().catch(() => ({}))).missing || []).filter(Number.isInteger);
              const mine = new Map(chunks.filter((c) => group(c) === group(f)).map((c) => [c.seq, c]));
              const resend = missing.filter((n) => mine.has(n)), gone = missing.filter((n) => !mine.has(n));
              if (resend.length) { await tx('chunks', 'readwrite', (s) => { for (const n of resend) s.put({ ...mine.get(n), sent: false }); }); continue; }
              if (gone.length) {
                // lost on the phone too (e.g. its storage was full for a moment): the rest is still saved, around the gap
                const gaps = [...new Set([...(f.payload.gaps || []), ...gone])].sort((a, b) => a - b);
                if (gaps.length >= f.payload.chunks) { await this.keepAside(f.takeId, f.cam, 'nothing of the recording reached the server'); continue; }
                await tx('finals', 'readwrite', (s) => s.put({ ...f, payload: { ...f.payload, gaps } }));
                continue;
              }
              throw new Error(`the server is missing chunks of ${f.takeId}`);
            }
            if (r.status === 404) { await this.keepAside(f.takeId, f.cam, 'the server does not know this take'); continue; }
            if (!r.ok) throw new Error(`complete HTTP ${r.status}`);
            // saved on the server (and in cloud storage): the device's copy can go
            await tx(['finals', 'chunks'], 'readwrite', ([fs, cs]) => { fs.delete(f.k); for (const c of chunks) if (group(c) === group(f)) cs.delete(c.k); });
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
