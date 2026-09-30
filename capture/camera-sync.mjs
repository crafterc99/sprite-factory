/**
 * Soul Jam Capture — camera synchronisation.
 *
 * Browsers cannot trigger two phones' sensors on the same hardware clock. So nothing here pretends
 * the two recordings start on the same frame. Instead every take carries what an offline step
 * needs to align them to within a frame:
 *
 *   1. a shared session clock: each device measures its offset to the server clock (NTP-style:
 *      round trips over the WebSocket, the lowest-latency sample wins, refreshed continuously);
 *   2. a coordinated start: the director asks both cameras to start at the same *server* time;
 *   3. per-frame timestamps: every recorded frame's capture time (requestVideoFrameCallback) mapped
 *      to the server clock;
 *   4. an audible sync event: the director plays a chirp a fixed time after the start, which both
 *      cameras' microphones record — an offline cross-correlation pins the offset exactly.
 *
 * alignTakes() gives the offset between two cameras from (3); the chirp refines it from (4).
 */

/** Clock offset estimator (server time − local time), from ping round trips. */
export class ClockSync {
  constructor({ keep = 24 } = {}) { this.samples = []; this.keep = keep; }
  /** c0 = local send time, s = server time on receipt, c1 = local receive time (ms). */
  add(c0, s, c1) {
    const rtt = c1 - c0;
    if (!(rtt >= 0) || rtt > 5000) return;
    this.samples.push({ offset: s - (c0 + c1) / 2, rtt, at: c1 });
    if (this.samples.length > this.keep) this.samples.shift();
  }
  /** The offset of the lowest-round-trip samples (their median), its uncertainty (± half that round trip). */
  get best() {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 4)));
    const off = s.map((x) => x.offset).sort((a, b) => a - b)[Math.floor(s.length / 2)];
    return { offsetMs: off, rttMs: s[0].rtt, uncertaintyMs: s[0].rtt / 2, samples: this.samples.length };
  }
  toServer(localMs) { const b = this.best; return b ? localMs + b.offsetMs : null; }
  toLocal(serverMs) { const b = this.best; return b ? serverMs - b.offsetMs : null; }
}

/** The sync chirp: a short up-sweep, loud and unmistakable in both microphones. */
export const CHIRP = { f0: 1800, f1: 5200, durationMs: 90, gain: 0.9 };

/**
 * Offline alignment of two cameras from their per-frame server timestamps.
 * @param {number[]} a camera A frame times (server ms), @param {number[]} b camera B's
 * @returns {{offsetMs:number, overlap:[number,number], pairs:number[][], fpsA:number, fpsB:number, jitterMs:number}}
 *   offsetMs: B's first frame − A's first frame; pairs: [iA, iB] nearest frames in the overlap
 */
export function alignTakes(a, b) {
  if (!a?.length || !b?.length) return null;
  const fps = (t) => (t.length > 1 ? (1000 * (t.length - 1)) / (t[t.length - 1] - t[0]) : 0);
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[a.length - 1], b[b.length - 1]);
  const pairs = [];
  let j = 0, jit = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < lo || a[i] > hi) continue;
    while (j + 1 < b.length && Math.abs(b[j + 1] - a[i]) <= Math.abs(b[j] - a[i])) j++;
    pairs.push([i, j]); jit = Math.max(jit, Math.abs(b[j] - a[i]));
  }
  return { offsetMs: b[0] - a[0], overlap: [lo, hi], pairs, fpsA: +fps(a).toFixed(2), fpsB: +fps(b).toFixed(2), jitterMs: +jit.toFixed(2) };
}

/** Measured frame rate + the gaps (dropped frames) of a frame-time list. */
export function frameStats(t) {
  if (!t || t.length < 2) return { frames: t?.length || 0, fps: 0, maxGapMs: 0, dropped: 0 };
  const d = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  const sorted = [...d].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)];
  return { frames: t.length, fps: +((1000 * (t.length - 1)) / (t[t.length - 1] - t[0])).toFixed(2), medianIntervalMs: +med.toFixed(2), maxGapMs: +Math.max(...d).toFixed(1), dropped: d.filter((x) => x > med * 1.6).length };
}
