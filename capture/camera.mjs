/**
 * Soul Jam Capture — the camera side of a device (web implementation). Opens the camera, reports
 * what it can really do, records with MediaRecorder in 1 s chunks (handed to the uploader as they
 * come — nothing waits in memory for the end of the take), timestamps every frame it sees on the
 * session clock, and watches for the camera being moved after calibration.
 *
 * Honest capabilities: the constraints ask for 120 fps; whatever the device grants is read back
 * from the track (getSettings) and the frame rate is also *measured* while recording. Browsers on
 * phones commonly cap web capture at 30 or 60 fps even when the native camera app does 120/240 —
 * this module reports that (capabilities.webLimited) instead of pretending, and the UI points to
 * the native capture path (docs/capture.md) for true high-frame-rate takes.
 *
 * The same interface (open / capabilities / start / stop / onChunk) is what a native camera
 * implementation provides to the shared director / protocol code.
 */

const WANT = [
  { frameRate: 120, width: 1920, height: 1080 },
  { frameRate: 120, width: 1280, height: 720 },
  { frameRate: 60, width: 1920, height: 1080 },
  { frameRate: 60, width: 1280, height: 720 },
  { frameRate: 30, width: 1920, height: 1080 },
  { frameRate: 30, width: 1280, height: 720 },
];

/**
 * Is this WebKit (Safari: iPhone, iPad, Mac)? Every iOS / iPadOS browser is WebKit (Safari, Chrome =
 * CriOS, Firefox = FxiOS, Edge = EdgiOS, in-app web views), and iPadOS Safari says "Macintosh"
 * (told apart from a Mac by its touch points). Any AppleWebKit browser that is not Chromium counts.
 */
export function isWebKit(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0) {
  if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/.test(ua)) return true;
  if (/Macintosh/.test(ua) && touchPoints > 1) return true;
  return /AppleWebKit\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
}
const WEBM = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const MP4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
/**
 * The recorder format, best first. WebKit: MP4 (H.264) — an iPhone can claim WebM/VP9 and then
 * record nothing (a 5-byte file). Chromium: WebM, which streams real 1 s chunks while recording
 * (its MP4 recorder holds everything until the stop).
 */
export function mimeCandidates(webkit = isWebKit()) { return webkit ? [...MP4, ...WEBM] : [...WEBM, ...MP4]; }
/**
 * Formats this device's recorder refused, or advertised but recorded (almost) nothing with while
 * the camera delivered frames — judged only from a FINISHED recording, never from a mid-recording
 * byte count (Safari may hold its data until the stop). Skipped for a week (localStorage, so a
 * reload keeps the working format; a browser update gets another chance).
 */
const BAD_KEY = 'sjc-bad-mime', BAD_TTL_MS = 7 * 86400000;
const badStore = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(BAD_KEY) || '{}');
    const o = Array.isArray(v) ? Object.fromEntries(v.map((m) => [m, Date.now()])) : v && typeof v === 'object' ? v : {};
    for (const [m, at] of Object.entries(o)) if (!(Date.now() - at < BAD_TTL_MS)) delete o[m];
    return o;
  } catch { return {}; }
})();
const badMimes = new Set(Object.keys(badStore));
export function markBadMime(m) {
  if (!m || badMimes.has(m)) return false;
  badMimes.add(m); badStore[m] = Date.now();
  try { localStorage.setItem(BAD_KEY, JSON.stringify(badStore)); } catch {}
  return true;
}
export function pickMime({ webkit = isWebKit(), supported = null, bad = badMimes } = {}) {
  if (!supported) {
    if (typeof MediaRecorder === 'undefined') return null;
    supported = (m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } };
  }
  const ok = mimeCandidates(webkit).filter(supported);
  // never every format: the last one the device supports is kept even if it failed once
  return ok.find((m) => !bad.has(m)) || ok[0] || '';
}

/**
 * Is a recording really producing video? Looked at ~1.6 s and ~3.2 s after it started and at its
 * stop. Returns the problem in plain words, or null.
 *   live: recorder error · camera ended / muted · page hidden · (nearly) empty chunks while NO
 *         frame arrives (with frames arriving, Safari's MP4 recorder may hand over only the file
 *         header until the stop: that is left to the final check) · no frames and no data at all
 *         · from 3 s on: no frame while the preview is not playing either (`playing` false: the
 *         camera delivers no picture — the recorder may still hand out audio)
 *   final (≥ 1.5 s recorded): no data, or a file under 20 kB
 */
export function recordingProblem({ error = null, trackState = 'live', muted = false, hidden = false, chunks = 0, bytes = 0, frames = 0, rvfc = true, final = false, elapsedMs = 0, playing = true } = {}) {
  const why = [];
  if (error) why.push(/^the recorder /.test(error) ? error : `the recorder failed (${error})`);
  if (trackState === 'ended') why.push('the camera stopped');
  else if (muted) why.push('the camera delivers no picture');
  if (hidden) why.push('the page is in the background (screen locked or another app in front)');
  const small = chunks > 0 && bytes < (final ? 20000 : 4096);
  if (small && (final ? elapsedMs >= 1500 : frames === 0 || !rvfc)) why.push(`the recorder produced only ${bytes} bytes`);
  else if (small) { /* a small first chunk (or a STOP right after the start): looked at again later / not a camera problem */ }
  else if (final && elapsedMs >= 1500 && chunks === 0) why.push('the recorder produced no data');
  else if (rvfc && frames === 0 && chunks === 0 && elapsedMs >= 3000) why.push('no video frames and no data');
  else if (!final && rvfc && frames === 0 && !playing && elapsedMs >= 3000 && trackState !== 'ended' && !muted && !hidden) why.push('this camera is not delivering a picture');
  return why.length ? why.join(' · ') : null;
}

export class WebCamera {
  constructor({ video, clock, onChunk, onState } = {}) {
    Object.assign(this, { video, clock, onChunk, onState });
    this.stream = null; this.track = null; this.cur = null; this.recording = false;
    this.deviceId = null; this.caps = null; this.settings = null; this.ref = null; this.moveWatch = null; this.motionSensor = null;
  }
  static async listCameras() {
    try { const d = await navigator.mediaDevices.enumerateDevices(); return d.filter((x) => x.kind === 'videoinput').map((x) => ({ id: x.deviceId, label: x.label || 'camera' })); } catch { return []; }
  }
  /** Open the camera: the best of WANT the device grants (tries 120 → 60 → 30, keeps what it really got). */
  async open({ deviceId = null, facingMode = 'environment', audio = true, prefer = null } = {}) {
    this.close();
    const base = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode } };
    const ladder = prefer ? [prefer, ...WANT] : WANT;
    let best = null, lastErr = null;
    for (const w of ladder) {
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
          video: { ...base, width: { ideal: w.width }, height: { ideal: w.height }, frameRate: { ideal: w.frameRate } } });
      } catch (e) { lastErr = e; continue; }
      const t = s.getVideoTracks()[0];
      try { await t.applyConstraints({ width: { ideal: w.width }, height: { ideal: w.height }, frameRate: { ideal: w.frameRate } }); } catch {}
      const st = t.getSettings(), fps = st.frameRate || 0, area = (st.width || 0) * (st.height || 0);
      if (!best || fps > best.fps + 0.5 || (Math.abs(fps - best.fps) <= 0.5 && area > best.area)) { best?.stream.getTracks().forEach((x) => x.stop()); best = { stream: s, fps, area }; }
      else s.getTracks().forEach((x) => x.stop());
      if (fps >= w.frameRate - 1) break;                  // this rung is granted in full (the ladder is best-first)
    }
    if (!best) throw lastErr || new Error('camera unavailable');
    const stream = best.stream;
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.settings = this.track.getSettings();
    this.deviceId = this.settings.deviceId || deviceId;
    let c = {};
    try { c = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch {}
    const maxFps = c.frameRate?.max ?? null;
    this.caps = {
      maxFrameRate: maxFps, maxWidth: c.width?.max ?? null, maxHeight: c.height?.max ?? null,
      zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step } : null,
      facingMode: c.facingMode || null, torch: !!c.torch,
      focusMode: c.focusMode || null, exposureMode: c.exposureMode || null,
      reported: !!this.track.getCapabilities,
      // the web path can't reach 120 here: say so (native capture path)
      webLimited: (this.settings.frameRate || 0) < 119,
    };
    // tell the director at once when the camera stops delivering (screen locked, page hidden, taken by another app)
    for (const ev of ['mute', 'unmute', 'ended']) this.track.addEventListener(ev, () => this.emit());
    if (this.video) {
      this.video.srcObject = stream; this.video.muted = true; this.video.playsInline = true;
      if (!this._onPause) { this._onPause = () => { if (this.stream && (typeof document === 'undefined' || document.visibilityState === 'visible')) setTimeout(() => this.keepPlaying(), 100); }; this.video.addEventListener('pause', this._onPause); }
      await this.video.play().catch(() => {});
    }
    this.emit();
    return this.describe();
  }
  describe() {
    const s = this.settings || {};
    const w = s.width || this.video?.videoWidth || null, h = s.height || this.video?.videoHeight || null;
    return { deviceId: this.deviceId, label: this.track?.label || null, width: w, height: h, frameRate: s.frameRate ? +s.frameRate.toFixed(2) : null, facingMode: s.facingMode || null, zoom: s.zoom ?? null, aspectRatio: s.aspectRatio || null,
      orientation: w && h ? (w >= h ? 'landscape' : 'portrait') : null, mime: pickMime(), muted: !!this.track?.muted, ended: this.track?.readyState === 'ended', capabilities: this.caps };
  }
  /** A small JPEG of what the camera sees (the director's live view of this camera). */
  snapshot({ maxW = 320, maxH = 400, quality = 0.6 } = {}) {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const k = Math.min(1, maxW / v.videoWidth, maxH / v.videoHeight);
    const w = Math.max(2, Math.round(v.videoWidth * k)), h = Math.max(2, Math.round(v.videoHeight * k));
    const c = (this._sc ||= document.createElement('canvas')); c.width = w; c.height = h;
    try { c.getContext('2d').drawImage(v, 0, 0, w, h); return { jpg: c.toDataURL('image/jpeg', quality), w, h }; } catch { return null; }
  }
  /** Keep the preview playing (iOS pauses it when the page is hidden; frame times need it running). */
  keepPlaying() {
    const v = this.video;
    if (!v || !this.stream) return;
    if (v.srcObject !== this.stream) v.srcObject = this.stream;
    if (v.paused) v.play().catch(() => {});
  }
  async setZoom(z) { try { await this.track.applyConstraints({ advanced: [{ zoom: z }] }); this.settings = this.track.getSettings(); this.emit(); } catch {} }
  /** Lock focus / exposure / white balance where the platform lets a web page (it often doesn't). */
  async lockExposure() {
    const adv = {};
    if (this.caps?.focusMode?.includes('manual')) adv.focusMode = 'manual';
    if (this.caps?.exposureMode?.includes('manual')) adv.exposureMode = 'manual';
    try { if (Object.keys(adv).length) await this.track.applyConstraints({ advanced: [adv] }); return Object.keys(adv); } catch { return []; }
  }
  emit() { this.onState?.(this.describe()); }

  /**
   * Start recording at local time `atLocal` (performance-aligned Date ms). Chunks go to
   * onChunk(seq, blob, tag, mime) — `tag` is the take this recording belongs to. Each recording
   * keeps its own state: a new start while the previous one is still stopping never takes the
   * previous take's last chunk or leaves its stop hanging.
   */
  start({ atLocal = Date.now(), timesliceMs = 1000, bitsPerSecond = null, tag = null } = {}) {
    if (!this.stream) throw new Error('camera not open');
    const prev = this.cur;
    if (prev && !prev.stopping) this.stop({});             // never two recorders (its data still reaches its own take)
    const fps = this.settings?.frameRate || 30, px = (this.settings?.width || 1280) * (this.settings?.height || 720);
    const bps = bitsPerSecond || Math.round(Math.min(40e6, Math.max(8e6, px * fps * 0.12)));
    const st = { tag, mime: pickMime(), bps, seq: 0, bytes: 0, frameCount: 0, frames: [], mediaTimes: [], streaming: false, rec: null, timer: null, active: false, stopping: false, done: null, error: null, recError: null, health: [] };
    this.cur = st;
    st.go = () => {
      st.timer = null;
      if (st.rec) return;
      this.keepPlaying();
      let rec = null, lastErr = null;
      // a type the recorder refuses outright (it advertised it, then the recorder can't be made
      // or won't start) is skipped from now on: the next one it offers is tried at once, so a
      // device never fails every recording the same way
      for (let i = 0; i < 8 && !rec; i++) {
        let r = null;
        try {
          r = new MediaRecorder(this.stream, { ...(st.mime ? { mimeType: st.mime } : {}), videoBitsPerSecond: bps, audioBitsPerSecond: 128000 });
          r.ondataavailable = (e) => { if (e.data && e.data.size) { st.bytes += e.data.size; this.onChunk?.(st.seq++, e.data, st.tag, st.mime); if (st.active && e.data.size > 4096) st.streaming = true; } };
          r.onstop = () => { st.active = false; this.recording = !!this.cur?.active; st.done?.(); };
          r.onerror = (e) => { st.error = e?.error?.name || e?.error?.message || 'error'; this.flag(st); };
          st.startedLocal = Date.now();
          r.start(timesliceMs);
          rec = r;
        } catch (e) {
          lastErr = e;
          if (r) { r.ondataavailable = r.onstop = r.onerror = null; }
          const next = st.mime && markBadMime(st.mime) ? pickMime() : null;
          if (!next || next === st.mime) break;
          (st.refused ||= []).push(st.mime); st.mime = next;
        }
      }
      if (!rec) { st.error = `the recorder would not start: ${lastErr?.name || lastErr?.message || 'error'}`; st.startedLocal ||= Date.now(); this.flag(st); return; }
      st.rec = rec;
      st.active = true; this.recording = true;
      this.watchFrames(st);
      // is it really recording? told to the director within ~2 s (e.g. an iPhone whose recorder gives 5 bytes)
      st.health = [1600, 3200].map((ms) => setTimeout(() => { if (st.active) this.flag(st); }, ms));
    };
    const wait = atLocal - Date.now();
    if (wait > 4) st.timer = setTimeout(st.go, wait); else st.go();
  }
  /** Check the recording `st`; the first problem found is reported once (onHealth(message, tag)). */
  flag(st, { final = false } = {}) {
    if (st.recError) return st.recError;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden', trackState = this.track?.readyState, muted = !!this.track?.muted;
    const v = this.video, playing = !v || (v.readyState >= 2 && !v.paused);
    let msg = recordingProblem({ error: st.error, trackState, muted, hidden, playing,
      chunks: st.seq, bytes: st.bytes, frames: st.frameCount, rvfc: !!this.video?.requestVideoFrameCallback, final, elapsedMs: (st.stoppedLocal || Date.now()) - (st.startedLocal || Date.now()) });
    if (msg) {
      // the FINISHED recording: frames arrived and the page was in front, yet the recorder made
      // (almost) nothing — this device can't record that format: the next recording uses the next
      // one it offers (never judged mid-recording: Safari may deliver everything at the stop)
      if (final && /recorder produced/.test(msg) && st.frameCount > 0 && !hidden && !muted && trackState !== 'ended' && !st.error && markBadMime(st.mime)) {
        const next = pickMime();
        if (next && next !== st.mime) { st.mimeSwitched = next; msg += ` — the next recording uses ${/mp4/.test(next) ? 'MP4' : 'WebM'} instead`; }
      }
      st.recError = msg; this.onHealth?.(msg, st.tag);
    }
    else if (!final && st.frameCount === 0 && st.bytes > 4096 && this.video?.requestVideoFrameCallback) { st.recWarn = 'no frame times: the preview was paused'; this.keepPlaying(); }
    return msg;
  }
  get streaming() { return !!this.cur?.streaming; }
  get mime() { return this.cur?.mime ?? pickMime(); }
  /** Every frame the device shows while this recording runs: its capture time on the session clock (requestVideoFrameCallback). */
  watchFrames(st) {
    const v = this.video;
    if (!v || !v.requestVideoFrameCallback) return;
    const tick = (now, meta) => {
      if (!st.active) return;
      st.frameCount++;
      // captureTime / receiveTime are on the performance clock (ms); map to wall clock, then to the server
      const perf = meta.captureTime ?? meta.receiveTime ?? meta.expectedDisplayTime ?? now;
      const wall = performance.timeOrigin + perf;
      const server = this.clock?.toServer(wall);
      if (server != null) { st.frames.push(+server.toFixed(2)); st.mediaTimes.push(+meta.mediaTime.toFixed(4)); }
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
  }
  /** Stop the current recording at local time `atLocal`; resolves after its last chunk was handed over. */
  stop({ atLocal = Date.now() } = {}) {
    const st = this.cur;
    if (!st) return Promise.resolve({ chunks: 0, bytes: 0, mime: pickMime(), bps: null, frames: [], mediaTimes: [], startedLocal: null, stoppedLocal: Date.now(), tag: null, recError: null });
    st.stopping = true;
    return (st.stopped ||= new Promise((resolve) => {
      const done = () => {
        st.active = false; st.stoppedLocal = Date.now(); st.health.forEach(clearTimeout);
        if (st.startedLocal) this.flag(st, { final: true });
        resolve({ chunks: st.seq, bytes: st.bytes, mime: st.mime, bps: st.bps, frames: st.frames, mediaTimes: st.mediaTimes, startedLocal: st.startedLocal, stoppedLocal: st.stoppedLocal, streaming: st.streaming, tag: st.tag, recError: st.recError, recWarn: st.recWarn || null,
          rvfc: !!this.video?.requestVideoFrameCallback, mimeSwitched: st.mimeSwitched || null, refused: st.refused || null });
      };
      const go = () => {
        // STOP before the scheduled start: start now and stop at once (a short file, never a recorder left running)
        if (st.timer) { clearTimeout(st.timer); st.go(); }
        if (!st.rec || st.rec.state === 'inactive') return done();
        let finished = false;
        const once = () => { if (!finished) { finished = true; done(); } };
        st.done = once; try { st.rec.stop(); } catch { once(); }
        setTimeout(once, 4000);                             // a recorder that never says "stopped" still finishes the take
      };
      const wait = atLocal - Date.now();
      if (wait > 4) setTimeout(go, wait); else go();
    }));
  }

  // ── camera-moved detection: a small grey thumbnail compared to the calibration reference
  thumb(w = 64, h = 36) {
    if (!this.video || !this.video.videoWidth) return null;
    const c = (this._tc ||= document.createElement('canvas')); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(this.video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
    return { w, h, px: Array.from(out) };
  }
  /**
   * Did the whole picture shift? The best whole-pixel translation (±4 px of 64) between the
   * reference and now, on edge maps (lighting changes and a player moving through the frame change
   * the picture, but a translation does not explain them). `moved` only when a shift explains the
   * difference: the error drops a lot with the shift and the shifted picture matches well.
   */
  static compare(a, b) {
    if (!a || !b || a.w !== b.w) return null;
    const { w, h } = a;
    const edges = (px) => { const e = new Float32Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) e[y * w + x] = Math.abs(px[y * w + x + 1] - px[y * w + x - 1]) + Math.abs(px[(y + 1) * w + x] - px[(y - 1) * w + x]); return e; };
    const ea = edges(a.px), eb = edges(b.px);
    const err = (dx, dy) => { let e = 0, n = 0; for (let y = 6; y < h - 6; y++) for (let x = 6; x < w - 6; x++) { e += Math.abs(ea[y * w + x] - eb[(y + dy) * w + (x + dx)]); n++; } return e / n; };
    let mean = 0; for (let i = 0; i < w * h; i++) mean += ea[i]; mean /= w * h;
    const e0 = err(0, 0);
    let best = { dx: 0, dy: 0, err: e0 };
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { if (!dx && !dy) continue; const e = err(dx, dy); if (e < best.err) best = { dx, dy, err: e }; }
    const explained = e0 > 0 ? (e0 - best.err) / e0 : 0;
    const moved = (Math.abs(best.dx) >= 2 || Math.abs(best.dy) >= 2) && explained > 0.35 && best.err < 0.6 * Math.max(mean, 1) && mean > 2;   // a textured view that a translation explains
    return { ...best, e0: +e0.toFixed(2), explained: +explained.toFixed(2), texture: +mean.toFixed(2), moved };
  }
  setReference() { this.ref = this.thumb(); return this.ref; }
  /** Watch for movement while idle: onMoved(reason) when the view shifted or the phone was bumped. */
  watchMoves(onMoved) {
    clearInterval(this.moveWatch);
    let strikes = 0;
    this.moveWatch = setInterval(() => {
      if (this.recording || !this.ref) return;
      const r = WebCamera.compare(this.ref, this.thumb());
      if (r?.moved) { if (++strikes >= 3) { strikes = 0; onMoved(`view shifted ${r.dx},${r.dy} px (of 64)`); this.ref = null; } } else strikes = 0;
    }, 1500);
    if (typeof DeviceMotionEvent !== 'undefined' && !this.motionSensor) {
      let last = 0;
      this.motionSensor = (e) => {
        const a = e.acceleration; if (!a || this.recording) return;
        const m = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
        if (m > 2.5 && Date.now() - last > 5000 && this.ref) { last = Date.now(); onMoved(`the phone was bumped (${m.toFixed(1)} m/s²)`); this.ref = null; }
      };
      window.addEventListener('devicemotion', this.motionSensor);
    }
  }
  close() {
    clearInterval(this.moveWatch);
    if (this.motionSensor) { window.removeEventListener('devicemotion', this.motionSensor); this.motionSensor = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
  }
}
