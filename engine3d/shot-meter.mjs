/**
 * Shot meter (NBA 2K style): hold the shot button, let go at the top of the meter.
 *
 * The press starts the shot (the contact system still buffers it to a valid window); the bar is up from the press.
 * It fills in step with the playing shot clip — from the clip's first frame to its release frame, the mark — so the
 * animation itself is the timer; letting go of the button on the mark is the perfect release. Everything is timed in
 * CLIP time (Player.action.t / clip.fps, from the frame the clip was entered at): each clip has its own window (its
 * release frame, its fps) and it scales with the game speed. Above the mark, the late zone runs to the clip's end
 * (at least lateMin): held to its end, the hardest shot.
 *
 *   |e| ≤ green   EXCELLENT        the clean swish — the same flight as a perfect shot
 *   e < 0 (early)  SLIGHTLY EARLY   front rim, short (it can rattle out)
 *                  EARLY            clearly short of the net, the earlier the shorter
 *                  VERY EARLY       an air ball, short (a tap: let go before the shot started)
 *   e > 0 (late)   SLIGHTLY LATE    back rim, a bit long
 *                  LATE             too hard: off the backboard, the later the harder
 *                  VERY LATE        off the glass — held to the end of the late zone: the hardest
 *
 * No roll: the release timing sets the flight's error deterministically (aimOf: how far short / long along the shot,
 * continuous in e). The animation is always the same clip; only the ball's flight changes — launched on the clip's
 * release frame from the hands, its speed / angle what that aim needs under gravity and drag (shot-flight planShot).
 * A release known before the launch (let go early, or within the green window) flies that arc from the launch. Still
 * held at the launch, the ball leaves on the clean arc; held past the green window it is bent toward the late aim of
 * the timing so far (lateNow — later = harder), and to the final one when the button comes up. What the court shows —
 * SWISH / MAKE / MISS / AIR BALL — always comes from the physics (onResult), never from the grade.
 *
 * One press is one shot (shootButton): a button still held after a dropped request or a new ball must come up before
 * it starts another, and so must one pressed with no ball (it never shoots the pass back the moment it arrives); a
 * tap, then held again before the shot started, is the same shot, timed by the hold.
 *
 * Pure: no DOM, no three.js (court3d.html draws view(); the headless tests drive it).
 */

export const SHOT_METER = Object.freeze({
  green: 0.08,      // s either side of the release frame → EXCELLENT (learnable at 1×: ±80 ms)
  slight: 0.16,     // → SLIGHTLY EARLY / LATE (front rim / back rim)
  off: 0.26,        // → EARLY / LATE (short of the net / off the backboard); beyond → VERY EARLY / VERY LATE
  lateMin: 0.3,     // s after the release frame: the late zone runs to the clip's end, at least this long — held to its end: VERY LATE, the hardest
  minRise: 0.15,    // s from the entry frame to the release: shorter → no meter (a plain make)
  mark: 0.8,        // bar height (0…1) at the release frame; the top 20 % is the late zone
  armTimeout: 1.3,  // s: a press whose shot never starts hides the meter (the input buffer drops it at 1.2)
  steerAccel: 14,   // m/s²: how hard a flight still held past the green window is bent to its late flight (a bend, not a kick)
  steerStop: 0.06,  // s: the bend ends this long before the ball reaches the late flight's point short of the glass
  resultHold: 1.4,  // s the result stays up
  fadeOut: 0.4,     // s it fades
});
export const GRADE_COLOR = { green: '#19d27a', slight: '#ffd21a', off: '#ff8a1a', very: '#ff3b4e' };

const LABEL = { slight: 'SLIGHTLY ', off: '', very: 'VERY ' };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, u) => a + (b - a) * clamp(u, 0, 1);

/**
 * The grade of a release e seconds from the release frame (< 0 early). beforeStart: the button
 * came up before the shot even started (a tap) → VERY EARLY.
 * @returns {{ e, grade: 'green'|'slight'|'off'|'very', side: 'early'|'late', label, color }}
 */
export function gradeTiming(e, beforeStart = false, cfg = SHOT_METER) {
  const a = Math.abs(e);
  const grade = beforeStart ? 'very' : a <= cfg.green + 1e-9 ? 'green' : a <= cfg.slight + 1e-9 ? 'slight' : a <= cfg.off + 1e-9 ? 'off' : 'very';
  const side = beforeStart || e < 0 ? 'early' : 'late';
  const label = grade === 'green' ? 'EXCELLENT' : LABEL[grade] + (side === 'late' ? 'LATE' : 'EARLY');
  return { e, grade, side, label, color: GRADE_COLOR[grade] };
}

/**
 * Where a release e seconds off the release frame sends the ball (deterministic, continuous within a band): dz along
 * the shot from the rim's centre where the ball's centre comes down through the aim height (− short / + long, m —
 * engine3d/shot-flight.mjs planShot's dz) and pitch, degrees added to the launch's elevation (a too-hard shot is a
 * flatter, faster one: it hits the glass hard and comes off it). The launch keeps the clean swish's heading.
 * lateEnd: the end of the late zone (s after the release frame: the clip's end, ≥ lateMin) — held there, the hardest.
 * Calibrated on Rapier (tests/shot-meter.test.js, both boards, 1.2–11 m, every angle):
 *   swish       touches nothing, in (the clean swish of today: SHOT_DEFAULTS.miss.swish)
 *   front-rim   the front of the rim first, out                     dz −0.20 … −0.30
 *   short       touches nothing, short of the rim (an air ball)     dz −0.50 … −0.75; very early −0.80 … −1.30
 *   back-rim    the back of the rim first, out                      dz +0.18 … +0.22
 *   off-glass   the backboard first, hard, out                       dz +1.20 … +1.30; very late … +1.45 (pitch −8°)
 *               (from near the baseline the glass is not in its path: it flies long, past the rim)
 * @returns {{ outcome: 'swish'|'front-rim'|'short'|'airball'|'back-rim'|'off-glass', dz: number, pitch: number }}
 */
export function aimOf(e, cfg = SHOT_METER, lateEnd = cfg.lateMin, beforeStart = false) {
  const g = cfg.green, sl = cfg.slight, of = cfg.off;
  if (beforeStart) return { outcome: 'airball', dz: AIM.veryEarly[1], pitch: 0 };
  if (Math.abs(e) <= g + 1e-9) return { outcome: 'swish', dz: AIM.swish, pitch: 0 };
  if (e < 0) {
    const x = -e;
    if (x <= sl + 1e-9) return { outcome: 'front-rim', dz: lerp(...AIM.frontRim, (x - g) / (sl - g)), pitch: 0 };
    if (x <= of + 1e-9) return { outcome: 'short', dz: lerp(...AIM.short, (x - sl) / (of - sl)), pitch: 0 };
    return { outcome: 'airball', dz: lerp(...AIM.veryEarly, (x - of) / 0.3), pitch: 0 };
  }
  if (e <= sl + 1e-9) return { outcome: 'back-rim', dz: lerp(...AIM.backRim, (e - g) / (sl - g)), pitch: 0 };
  if (e <= of + 1e-9) return { outcome: 'off-glass', dz: lerp(...AIM.offGlass, (e - sl) / (of - sl)), pitch: AIM.hardPitch };
  return { outcome: 'off-glass', dz: lerp(...AIM.veryLate, (e - of) / Math.max(1e-3, lateEnd - of)), pitch: AIM.hardPitch };
}
/** aimOf's ranges (m along the shot; see there). */
export const AIM = Object.freeze({ swish: -0.025, frontRim: [-0.2, -0.3], short: [-0.5, -0.75], veryEarly: [-0.8, -1.3], backRim: [0.18, 0.22], offGlass: [1.05, 1.15], veryLate: [1.15, 1.25], hardPitch: -6 });
/** The flight category of an aim's outcome (what the ball does first): short / front-rim / swish / back-rim / off-glass. */
export const flightOf = (outcome) => (outcome === 'airball' ? 'short' : outcome);

export class ShotMeter {
  /** @param {{ cfg?: object, enabled?: boolean }} o  (no seed: the grade is never rolled) */
  constructor({ cfg = {}, enabled = true } = {}) {
    this.cfg = { ...SHOT_METER, ...cfg };
    this.enabled = enabled;
    this.history = [];   // the last 20 shots: { clip, role, e, label, grade, outcome, result }
    this.now = 0;
    this.btn = false;    // the shot button as the meter last saw it (a press needs it up first)
    this.reset();
  }
  /**
   * No shot on the meter (a new possession, a dropped request, a short wind-up). The button keeps
   * its state: still held, it must come up before it can start another shot (no auto-repeat).
   */
  reset() {
    this.phase = 'idle';   // idle → armed (pressed) → rising (the shot plays) → graded → result
    this.pressT = null; this.role = null;
    this.up = null; this.shot = null; this.clipT = null; this.outcome = null; this.launched = null; this.result = null;
  }
  /** A shot the press never started (dropped from the input buffer, no clip for it). */
  cancel() { if (this.phase === 'armed') this.reset(); }
  /**
   * The button is down, but this press was not a shot: it asked for a new ball (the touch SHOOT
   * button doubles as "new ball"). Like a press still held after a new ball, it must come up
   * before it can start a shot.
   */
  notAShot() { if (this.phase === 'idle' || this.phase === 'result') this.btn = true; }

  // ── input ──
  /** The button went down (with the ball): a new shot — the bar is up from now. Ignored while one is on. */
  press(t, role = null) {
    if (!this.enabled || (this.phase !== 'idle' && this.phase !== 'result')) return false;
    this.reset();
    this.phase = 'armed'; this.btn = true; this.pressT = t; this.role = role; this.now = t;
    return true;
  }
  /** Pressed again before the shot even started (a tap, then a hold): the hold times it, not the tap. */
  rearm(t) {
    if (this.phase !== 'armed' || this.btn) return false;
    this.btn = true; this.up = null; this.now = t;
    return true;
  }
  /**
   * The button came up. clipT: the playing shot's clip time then (frames); null → from the meter's
   * own clock (the clip already ended: its time runs on with the game).
   */
  release(t, clipT = null) {
    if (!this.btn) return;
    this.btn = false;
    if (this.phase === 'armed') { this.up = { t, clipT: null, beforeStart: true }; return; }
    if (this.phase === 'rising' && !this.outcome) this.decide(clipT ?? this.clipAt(t), false, t);
  }

  // ── the shot clip ──
  /** The shot's action started (Player 'action' event with a clip that has a release frame). */
  start(action, t) {
    if (this.phase !== 'armed' || !action?.clip?.shot) return;
    const clip = action.clip, rel = clip.shot.releaseFrame, fps = clip.fps || 30, t0 = action.t0 ?? action.t;
    if (!((rel - t0) / fps >= this.cfg.minRise)) { this.reset(); return; }   // (no wind-up to time: a plain make)
    // (the bar fills from the clip's first frame — the frame it was entered at — to the release frame; the late zone
    // runs on to the clip's end, at least lateMin)
    const lateEnd = Math.max(this.cfg.lateMin, (clip.F - 1 - rel) / fps);
    this.shot = { clip, name: clip.name, rel, fps, F: clip.F, t0, riseStart: t0, lateEnd, startT: t, endAt: null };
    this.phase = 'rising'; this.clipT = action.t; this.lastT = t; this.now = t;
    if (!this.btn) this.decide(t0, true, t);   // a tap: up before the shot started
  }
  /** Every tick, after the Player updated: follow the clip; a button held through the whole late zone grades itself. */
  tick(action, t) {
    this.now = t;
    if (this.phase === 'armed' && t - this.pressT > this.cfg.armTimeout) { this.reset(); return; }
    const s = this.shot;
    if (!s) return;
    if (action && action.clip === s.clip) { this.clipT = action.t; this.lastT = t; s.endAt = null; }
    else { s.endAt ||= { t: this.lastT ?? t, clipT: this.clipT }; this.clipT = this.clipAt(t); }
    if (this.phase === 'rising' && this.btn && !this.outcome) {
      const lateAt = s.rel + s.lateEnd * s.fps;
      if (this.clipT >= lateAt - 1e-6) this.decide(lateAt, false, t);   // held through the whole late zone: VERY LATE, the hardest
    }
    if (this.phase === 'result' && t - this.result.at > this.cfg.resultHold + this.cfg.fadeOut) this.phase = 'idle';
    // (graded, but no result ever came: no physics / the shot never left)
    if (this.phase === 'graded' && t - (this.launched?.t ?? this.outcome?.at ?? t) > 8) this.phase = 'idle';
  }
  /** The shot's clip time at game time t — after the clip ended it runs on with the game (a button held past its end). */
  clipAt(t) {
    const s = this.shot, r = s.endAt || { t: this.lastT ?? t, clipT: this.clipT };
    return r.clipT + Math.max(0, t - r.t) * s.fps;
  }

  /** Grade the release at clip time ct (frames): its band, and where it sends the ball (aimOf — no roll). */
  decide(ct, beforeStart = false, t = this.now) {
    const s = this.shot, e = (ct - s.rel) / s.fps;
    const g = gradeTiming(e, beforeStart, this.cfg), A = aimOf(e, this.cfg, s.lateEnd, beforeStart);
    this.outcome = { ...g, outcome: A.outcome, dz: A.dz, pitch: A.pitch, make: A.outcome === 'swish', timing: g.side, clipT: ct, at: t, consumed: false };
    this.up = { t, clipT: beforeStart ? s.t0 : ct, beforeStart };
    this.phase = 'graded';
    this.history.push({ clip: s.name, role: this.role, e: +e.toFixed(4), label: g.label, grade: g.grade, outcome: A.outcome, flight: flightOf(A.outcome), make: A.outcome === 'swish', dz: +A.dz.toFixed(3), result: null });
    if (this.history.length > 20) this.history.shift();
    return this.outcome;
  }

  // ── the ball (engine3d/ball-session.mjs) ──
  /**
   * The ball leaves the hands now. → null (no meter on this shot: a plain make), the graded outcome
   * ({ outcome, dz, timing, … }: fly that arc from the launch), or { provisional: true } (the button is still held:
   * the clean arc — lateNow() bends it if it is held past the green window).
   */
  atLaunch(t) {
    if (!this.shot || this.phase === 'idle' || this.phase === 'armed' || this.launched) return null;
    this.launched = { t, provisional: !this.outcome };
    if (this.outcome) { this.outcome.consumed = true; return { ...this.outcome }; }
    return { provisional: true, outcome: 'swish', dz: AIM.swish, pitch: 0 };
  }
  /**
   * A shot launched with the button still held: where it should go now. Within the green window nothing (the clean
   * arc); held past it, the late aim of the timing so far (it can only get later: harder) — { e, outcome, dz, final:
   * false }; once the button came up (or the late zone ran out), the final grade's, once ({ …, final: true }).
   */
  lateNow(t = this.now) {
    if (!this.launched?.provisional || this.outcome?.consumed) return null;
    if (this.outcome) { this.outcome.consumed = true; return { ...this.outcome, final: true }; }
    const s = this.shot;
    if (!s || !this.btn) return null;
    const e = (this.clipAt(t) - s.rel) / s.fps;
    if (e <= this.cfg.green) return null;
    const A = aimOf(e, this.cfg, s.lateEnd);
    return { e, outcome: A.outcome, dz: A.dz, pitch: A.pitch, final: false };
  }
  /** (compatibility) The final late grade, once — lateNow's final answer. */
  takeLate() { const L = this.lateNow(); return L?.final ? L : null; }
  /**
   * What the ball really did (the physics): SWISH (in, touching neither rim nor board), MAKE, MISS,
   * AIR BALL (touched nothing of the hoop — rim, board or the rim's mount, the 'stanchion' colliders;
   * a made shot may brush the mount under the ring on its way through the net).
   */
  onResult({ made, touched = [] } = {}) {
    if (!this.launched || this.phase === 'result' || this.phase === 'idle') return;
    const T = new Set(touched), rim = T.has('rim'), board = T.has('board');
    const text = made ? (rim || board ? 'MAKE' : 'SWISH') : rim || board || T.has('stanchion') ? 'MISS' : 'AIR BALL';
    this.result = { made: !!made, text, color: made ? GRADE_COLOR.green : GRADE_COLOR.very, at: this.now };
    this.phase = 'result';
    const h = this.history[this.history.length - 1];
    if (h && h.result == null) h.result = text;
  }

  // ── drawing ──
  /**
   * Bar height (0…1) of clip time ct: 0 → mark from the clip's first frame to the release frame; above the mark the
   * same lateMin seconds for every clip (one late scale: the green window looks the same), full from then on.
   */
  fracOf(ct) {
    const s = this.shot, c = this.cfg;
    if (!s || ct == null) return 0;
    if (ct <= s.riseStart) return 0;
    if (ct <= s.rel) return (c.mark * (ct - s.riseStart)) / Math.max(1e-6, s.rel - s.riseStart);
    return Math.min(1, c.mark + ((1 - c.mark) * ((ct - s.rel) / s.fps)) / c.lateMin);
  }
  /**
   * What to draw: { visible, phase, fill, band: [lo, hi], mark, label, color, result, resultColor, grade, fade }.
   * Up from the press (empty until the shot clip starts); the fill stops where the button came up (as in 2K) and takes
   * the grade's colour.
   */
  view(t = this.now) {
    const s = this.shot, c = this.cfg, o = this.outcome;
    const visible = this.enabled && (this.phase === 'armed' || ((this.phase === 'rising' || this.phase === 'graded' || this.phase === 'result') && !!s));
    if (!visible) return { visible: false, phase: this.phase, fill: 0, band: [0, 0], mark: c.mark, label: '', color: '#fff', result: '', resultColor: '#fff', grade: null, fade: 0 };
    const ct = !s ? null : this.up ? (this.up.beforeStart ? s.t0 : this.up.clipT) : this.clipT;
    // (the green window around the mark: before the clip starts, the default one — the bar is up from the press)
    const band = s ? [this.fracOf(s.rel - c.green * s.fps), this.fracOf(s.rel + c.green * s.fps)] : [c.mark - 0.04, c.mark + (1 - c.mark) * (c.green / c.lateMin)];
    const since = this.phase === 'result' ? t - this.result.at : 0;
    const fade = since > c.resultHold ? Math.max(0, 1 - (since - c.resultHold) / c.fadeOut) : 1;
    return {
      visible, phase: this.phase, fill: s ? this.fracOf(ct) : 0, band, mark: c.mark,
      label: o?.label || '', color: o ? GRADE_COLOR[o.grade] : '#ffffff',
      result: this.result?.text || '', resultColor: this.result?.color || '#ffffff', grade: o?.grade || null, fade,
    };
  }
}

/**
 * The shot button, per tick (court3d.html and the headless harness run the same code): the press
 * (with the ball) starts a shot, the release grades it. request(role) queues the shot; roleOf()
 * names it (null: no shot for that). clipT: the playing shot's clip time when the button came up
 * (default: Player.action.t, the frame last drawn).
 */
export function shootButton(meter, { held, t, P, request, roleOf, clipT = null }) {
  if (held && !meter.btn && P.hasBall && !P.ballFree) {
    if (meter.rearm(t)) return;   // (a tap, then held again before the shot started: the same shot)
    const role = roleOf();
    if (role && meter.press(t, role)) request(role);
  } else if (held && !meter.btn) {
    // pressed with no ball (a shot in the air, a lost ball): not a shot — held until the pass back arrives, it
    // must still come up before it shoots
    meter.notAShot();
  } else if (!held && meter.btn) {
    const a = P.mode === 'action' && P.action?.clip?.shot ? P.action : null;
    meter.release(t, a && meter.shot && a.clip === meter.shot.clip ? clipT ?? a.t : null);
  }
}

/**
 * When the shot button moved, between two frames (court3d.html, before shootButton): a key / the touch button came up
 * at upAt (ms, its event time) — `since` the last frame started (frameAt0, ms; it lasted frameRdt s); a controller's
 * button has no event time: halfway through the frame. The moment in GAME time (gameT: the last tick's; speed: the
 * game speed) and the playing shot's clip time then (action: Player.action; null when no shot clip plays — the
 * meter's own clock grades it: shootButton → release → clipAt(t)).
 * @returns {{ since: number, t: number, clipT: number | null }}
 */
export function buttonMoment({ gameT = 0, speed = 1, upAt = null, frameAt0 = 0, frameRdt = 0, action = null }) {
  const since = upAt != null ? Math.max(0, Math.min(frameRdt || 0, (upAt - frameAt0) / 1000)) : (frameRdt || 0) / 2;
  const clipT = action?.clip?.shot ? Math.min(action.clip.F - 1, action.t + since * speed * action.clip.fps) : null;
  // (the moment itself, not the last drawn frame: a release after the clip ended is graded on the meter's clock then)
  return { since, t: gameT + since * speed, clipT };
}

/** After the Player updated (the session calls it): a shot clip starting starts the meter; follow its clock. */
export function meterAfterUpdate(meter, events, P, t) {
  for (const e of events || []) if (e.type === 'action' && P.action?.clip?.shot) meter.start(P.action, t);
  meter.tick(P.mode === 'action' ? P.action : null, t);
}
