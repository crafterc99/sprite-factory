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

export function pickMime() {
  // WebM first: it streams real 1 s chunks while recording (Chromium's MP4 recorder holds everything
  // until stop); H.264 inside WebM where the browser offers it. Safari records MP4.
  const cands = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
  if (typeof MediaRecorder === 'undefined') return null;
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || '';
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
    if (this.video) { this.video.srcObject = stream; this.video.muted = true; this.video.playsInline = true; await this.video.play().catch(() => {}); }
    this.emit();
    return this.describe();
  }
  describe() {
    const s = this.settings || {};
    return { deviceId: this.deviceId, label: this.track?.label || null, width: s.width || null, height: s.height || null, frameRate: s.frameRate ? +s.frameRate.toFixed(2) : null, facingMode: s.facingMode || null, zoom: s.zoom ?? null, aspectRatio: s.aspectRatio || null, mime: pickMime(), capabilities: this.caps };
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
    const mime = pickMime();
    const fps = this.settings?.frameRate || 30, px = (this.settings?.width || 1280) * (this.settings?.height || 720);
    const bps = bitsPerSecond || Math.round(Math.min(40e6, Math.max(8e6, px * fps * 0.12)));
    const st = { tag, mime, bps, seq: 0, frames: [], mediaTimes: [], streaming: false, rec: null, timer: null, active: false, stopping: false, done: null };
    this.cur = st;
    st.go = () => {
      st.timer = null;
      if (st.rec) return;
      const rec = (st.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bps, audioBitsPerSecond: 128000 }));
      rec.ondataavailable = (e) => { if (e.data && e.data.size) { this.onChunk?.(st.seq++, e.data, st.tag, st.mime); if (st.active && e.data.size > 4096) st.streaming = true; } };
      rec.onstop = () => { st.active = false; this.recording = !!this.cur?.active; st.done?.(); };
      st.startedLocal = Date.now();
      rec.start(timesliceMs);
      st.active = true; this.recording = true;
      this.watchFrames(st);
    };
    const wait = atLocal - Date.now();
    if (wait > 4) st.timer = setTimeout(st.go, wait); else st.go();
  }
  get streaming() { return !!this.cur?.streaming; }
  get mime() { return this.cur?.mime ?? pickMime(); }
  /** Every frame the device shows while this recording runs: its capture time on the session clock (requestVideoFrameCallback). */
  watchFrames(st) {
    const v = this.video;
    if (!v || !v.requestVideoFrameCallback) return;
    const tick = (now, meta) => {
      if (!st.active) return;
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
    if (!st) return Promise.resolve({ chunks: 0, mime: pickMime(), bps: null, frames: [], mediaTimes: [], startedLocal: null, stoppedLocal: Date.now(), tag: null });
    st.stopping = true;
    return (st.stopped ||= new Promise((resolve) => {
      const done = () => { st.active = false; st.stoppedLocal = Date.now(); resolve({ chunks: st.seq, mime: st.mime, bps: st.bps, frames: st.frames, mediaTimes: st.mediaTimes, startedLocal: st.startedLocal, stoppedLocal: st.stoppedLocal, streaming: st.streaming, tag: st.tag }); };
      const go = () => {
        // STOP before the scheduled start: start now and stop at once (a short file, never a recorder left running)
        if (st.timer) { clearTimeout(st.timer); st.go(); }
        if (!st.rec || st.rec.state === 'inactive') return done();
        st.done = done; st.rec.stop();
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
