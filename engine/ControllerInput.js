/**
 * ControllerInput.js — Unified keyboard + Gamepad API input manager
 *
 * PS4/PS5/Xbox controller layout:
 *   Left stick            → movement (walk/run) — 8-way facing for locomotion
 *   Right stick flick L   → Crossover (to the left)
 *   Right stick flick R   → Crossover (to the right)
 *   Right stick flick Up  → Behind Back
 *   Right stick flick Down→ Between Legs / Tween
 *   Square  (btn 2)       → Jumpshot (offense) / Steal (when L2 held = defense)
 *   Cross   (btn 0)       → Dribble action
 *   Circle  (btn 1)       → Stepback
 *   L2      (btn 6)       → Defense mode — hold for defensive sliding
 *   R2      (btn 7)       → (legacy) dribble-moves modifier — still works as a fallback
 *   L1      (btn 4)       → Sprint
 *   R1      (btn 5)       → Sprint
 *   D-pad                 → movement fallback
 *
 * Keyboard equivalents (no second stick — moves stay on the R-held modifier):
 *   WASD / Arrows    → movement
 *   Q / E            → crossover left / right (flick)
 *   I / Shift        → Jumpshot / Steal (when F held)
 *   J / Space        → Dribble / Crossover (when R held)
 *   T                → Between Legs / Tween (when R held)
 *   B                → Behind Back (when R held)
 *   L                → Stepback
 *   R (hold)         → Dribble moves mode (R2)
 *   F (hold)         → Defense mode
 *   Z                → Defensive slide (while F held)
 */
'use strict';

// Crossover flick: stick must cross this threshold within FLICK_WINDOW ms
const FLICK_THRESHOLD = 0.65;
const FLICK_WINDOW    = 180; // ms

// Right-stick dribble-move flick: magnitude must reach this, then re-center
const RS_FLICK_THRESHOLD = 0.7;
const RS_REARM_THRESHOLD = 0.3; // stick must return below this to allow the next flick

class ControllerInput {
  constructor() {
    this._keys      = new Set();
    this._state     = this._blank();
    this._bound     = false;

    // Crossover flick tracking
    this._prevLX         = 0;
    this._flickStartTime = 0;
    this._flickStartX    = 0;

    // Right-stick dribble-move flick: armed when centered, fires once on flick
    this._rsArmed        = true;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
  }

  _blank() {
    return {
      // Movement
      moveX: 0, moveY: 0,
      stickLX: 0, stickLY: 0,
      stickRX: 0, stickRY: 0,

      // Right-stick dribble-move flicks (one-shot per flick)
      rsCrossLeft:  false,  // → crossover left
      rsCrossRight: false,  // → crossover right
      rsBehind:     false,  // → behind back (flick up)
      rsTween:      false,  // → between legs (flick down)

      // Buttons (current frame state)
      btnSquare:   false,   // Jumpshot (offense) or Steal (defense)
      btnCross:    false,   // Dribble / Crossover (when R2)
      btnCircle:   false,   // Stepback
      btnTriangle: false,   // Between Legs / Tween (when R2)
      btnBehind:   false,   // Behind Back (keyboard B, no dedicated gamepad btn)
      l2:          false,   // Defense mode (hold)
      l2Value:     0,       // Analog value 0–1
      r2:          false,   // Dribble moves mode (hold)
      r2Value:     0,       // Analog value 0–1
      sprint:      false,

      // Crossover flick (detected from stick velocity)
      crossoverLeft:  false,
      crossoverRight: false,

      // Rising edges (just-pressed this frame)
      justSquare:   false,
      justCross:    false,
      justCircle:   false,
      justTriangle: false,
      justBehind:   false,
      justL2:       false,
      justR2:       false,
      justCrossoverLeft:  false,
      justCrossoverRight: false,

      // Meta
      defenseMode:      false,  // true while L2/F is held
      dribbleMode:      false,  // true while R2/R is held
      gamepadConnected: false,
    };
  }

  start() {
    if (this._bound) return;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    this._bound = true;
  }

  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this._keys.clear();
    this._bound = false;
  }

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    this._keys.add(e.code);
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  }

  _onKeyUp(e) { this._keys.delete(e.code); }

  /**
   * Call once per animation frame.
   * Returns complete input snapshot including rising-edge events.
   */
  poll(timestamp) {
    const prev  = { ...this._state };
    const s     = this._blank();
    const k     = this._keys;
    const now   = timestamp || performance.now();

    // ── Keyboard movement ────────────────────────────────────────────────
    if (k.has('ArrowLeft')  || k.has('KeyA')) s.moveX -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) s.moveX += 1;
    if (k.has('ArrowUp')    || k.has('KeyW')) s.moveY -= 1;
    if (k.has('ArrowDown')  || k.has('KeyS')) s.moveY += 1;
    s.stickLX = s.moveX;
    s.stickLY = s.moveY;

    // ── Keyboard action buttons ──────────────────────────────────────────
    s.btnSquare   = k.has('KeyI');                                               // Jumpshot / Steal (I key)
    s.btnCross    = k.has('KeyJ') || k.has('Space');                             // Dribble / Crossover (R2 mode)
    s.btnCircle   = k.has('KeyL');                                               // Stepback
    s.btnTriangle = k.has('KeyT');                                               // Between Legs / Tween (R2 mode)
    s.btnBehind   = k.has('KeyB');                                               // Behind Back (R2 mode)
    s.l2          = k.has('KeyF');                                               // Defense mode (hold)
    s.l2Value     = s.l2 ? 1 : 0;
    s.r2          = k.has('KeyR');                                               // Dribble moves mode (hold)
    s.r2Value     = s.r2 ? 1 : 0;
    s.sprint      = k.has('ShiftLeft') || k.has('ShiftRight');                   // Sprint (hold)

    // Keyboard crossover flick: Q = left, E = right
    s.crossoverLeft  = k.has('KeyQ');
    s.crossoverRight = k.has('KeyE');

    // ── Gamepad ──────────────────────────────────────────────────────────
    const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    for (const gp of gamepads) {
      if (!gp || !gp.connected) continue;
      s.gamepadConnected = true;

      // Left stick
      const lx = gp.axes[0] ?? 0;
      const ly = gp.axes[1] ?? 0;
      s.stickLX = lx;
      s.stickLY = ly;
      if (Math.abs(lx) > 0.15) s.moveX += lx;
      if (Math.abs(ly) > 0.15) s.moveY += ly;

      // ── Right stick — dribble-move flicks (replaces holding R2) ──────────
      // axes[2]/[3] = right stick on the standard gamepad mapping. A flick is
      // one move: the stick must reach RS_FLICK_THRESHOLD, then return to
      // center before another can fire. The dominant axis picks the move.
      const rx = gp.axes[2] ?? 0;
      const ry = gp.axes[3] ?? 0;
      s.stickRX = rx;
      s.stickRY = ry;
      const rsMag = Math.hypot(rx, ry);
      if (rsMag < RS_REARM_THRESHOLD) this._rsArmed = true;
      if (this._rsArmed && rsMag >= RS_FLICK_THRESHOLD) {
        this._rsArmed = false;
        if (Math.abs(rx) >= Math.abs(ry)) {
          if (rx < 0) s.rsCrossLeft = true; else s.rsCrossRight = true;
        } else {
          if (ry < 0) s.rsBehind = true; else s.rsTween = true; // ry+ = down
        }
      }

      // D-pad fallback
      if (gp.buttons[12]?.pressed) s.moveY -= 1;
      if (gp.buttons[13]?.pressed) s.moveY += 1;
      if (gp.buttons[14]?.pressed) s.moveX -= 1;
      if (gp.buttons[15]?.pressed) s.moveX += 1;

      // Face buttons (PS4/PS5 layout)
      s.btnCross    = s.btnCross    || !!gp.buttons[0]?.pressed;  // Cross    → dribble
      s.btnCircle   = s.btnCircle   || !!gp.buttons[1]?.pressed;  // Circle   → stepback
      s.btnSquare   = s.btnSquare   || !!gp.buttons[2]?.pressed;  // Square   → jumpshot / steal
      s.btnTriangle = s.btnTriangle || !!gp.buttons[3]?.pressed;  // Triangle → reserved

      // Shoulder / trigger buttons
      s.sprint = s.sprint || !!gp.buttons[4]?.pressed || !!gp.buttons[5]?.pressed; // L1 / R1

      // L2 analog trigger (button 6) — defense mode
      const l2Raw = gp.buttons[6]?.value ?? (gp.buttons[6]?.pressed ? 1 : 0);
      if (l2Raw > s.l2Value) {
        s.l2Value = l2Raw;
        s.l2 = l2Raw > 0.3; // threshold for "held"
      }

      // R2 analog trigger (button 7) — dribble moves mode
      const r2Raw = gp.buttons[7]?.value ?? (gp.buttons[7]?.pressed ? 1 : 0);
      if (r2Raw > s.r2Value) {
        s.r2Value = r2Raw;
        s.r2 = r2Raw > 0.3;
      }

      // Triangle (btn 3) → tween / between-legs (when R2 held)
      s.btnTriangle = s.btnTriangle || !!gp.buttons[3]?.pressed;

      // ── Left-stick crossover flick detection ────────────────────────────
      // A flick is: axis crosses FLICK_THRESHOLD quickly (within FLICK_WINDOW ms)
      const absLX = Math.abs(lx);
      const prevAbsLX = Math.abs(this._prevLX);

      if (prevAbsLX < 0.3 && absLX >= FLICK_THRESHOLD) {
        // Stick just crossed threshold — start tracking
        this._flickStartTime = now;
        this._flickStartX    = lx;
      } else if (absLX >= FLICK_THRESHOLD && this._flickStartTime > 0) {
        const elapsed = now - this._flickStartTime;
        if (elapsed <= FLICK_WINDOW) {
          if (lx < -FLICK_THRESHOLD) s.crossoverLeft  = true;
          if (lx >  FLICK_THRESHOLD) s.crossoverRight = true;
        }
        if (absLX < 0.2) this._flickStartTime = 0; // reset once stick returns
      }
      this._prevLX = lx;
    }

    // Normalize movement axes
    s.moveX = Math.max(-1, Math.min(1, s.moveX));
    s.moveY = Math.max(-1, Math.min(1, s.moveY));

    // Defense mode = L2 held (or F key)
    s.defenseMode = s.l2;
    // Dribble moves mode = R2 held (or R key)
    s.dribbleMode = s.r2;

    // ── Rising edge detection ────────────────────────────────────────────
    s.justSquare         = s.btnSquare   && !prev.btnSquare;
    s.justCross          = s.btnCross    && !prev.btnCross;
    s.justCircle         = s.btnCircle   && !prev.btnCircle;
    s.justTriangle       = s.btnTriangle && !prev.btnTriangle;
    s.justBehind         = s.btnBehind   && !prev.btnBehind;
    s.justL2             = s.l2          && !prev.l2;
    s.justR2             = s.r2          && !prev.r2;
    s.justCrossoverLeft  = s.crossoverLeft  && !prev.crossoverLeft;
    s.justCrossoverRight = s.crossoverRight && !prev.crossoverRight;

    this._state = s;
    return { ...s };
  }

  get state() { return { ...this._state }; }
}

if (typeof module !== 'undefined') module.exports = { ControllerInput };
