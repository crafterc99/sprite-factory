/**
 * ControllerInput.js — Unified keyboard + Gamepad API input manager
 *
 * Keyboard mappings:
 *   WASD / Arrows   → movement
 *   I / Shift       → Jumpshot   (Y / Triangle)
 *   J / Space       → Dribble    (A / Cross)
 *   K               → Crossover  (B / Circle)
 *   U               → Stepback   (X / Square)
 *
 * Gamepad (Xbox/PS5 layout):
 *   Left stick / D-pad → movement
 *   Button 0 (A/Cross)    → dribble action
 *   Button 1 (B/Circle)   → crossover
 *   Button 2 (X/Square)   → stepback
 *   Button 3 (Y/Triangle) → jumpshot
 *   R1 / L1               → sprint modifier
 */
'use strict';

class ControllerInput {
  constructor() {
    this._keys = new Set();
    this._prev = {};
    this._state = this._blank();
    this._bound = false;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
  }

  _blank() {
    return {
      moveX: 0, moveY: 0,
      btnA: false, btnB: false, btnX: false, btnY: false,
      sprint: false,
      justA: false, justB: false, justX: false, justY: false,
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
    // Don't steal input from text fields
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    this._keys.add(e.code);
    // Prevent page scroll on game keys
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  }

  _onKeyUp(e) { this._keys.delete(e.code); }

  /**
   * Call once per animation frame. Returns fresh input state snapshot.
   * justA/B/X/Y = true only on the frame the button was first pressed.
   */
  poll() {
    const prev = { ...this._state };
    const s = this._blank();
    const k = this._keys;

    // ── Keyboard movement ──────────────────────────────────────────────────
    if (k.has('ArrowLeft')  || k.has('KeyA')) s.moveX -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) s.moveX += 1;
    if (k.has('ArrowUp')    || k.has('KeyW')) s.moveY -= 1;
    if (k.has('ArrowDown')  || k.has('KeyS')) s.moveY += 1;

    // ── Keyboard action buttons ─────────────────────────────────────────────
    s.btnA = k.has('KeyJ') || k.has('Space');         // dribble / action
    s.btnB = k.has('KeyK');                            // crossover
    s.btnX = k.has('KeyU');                            // stepback
    s.btnY = k.has('KeyI') || k.has('ShiftLeft') || k.has('ShiftRight'); // jumpshot
    s.sprint = k.has('ShiftLeft') || k.has('ShiftRight');

    // ── Gamepad ──────────────────────────────────────────────────────────────
    const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    for (const gp of gamepads) {
      if (!gp || !gp.connected) continue;
      s.gamepadConnected = true;

      // Left analog stick (axes 0-1)
      const lx = gp.axes[0] ?? 0;
      const ly = gp.axes[1] ?? 0;
      if (Math.abs(lx) > 0.15) s.moveX += lx;
      if (Math.abs(ly) > 0.15) s.moveY += ly;

      // D-pad (buttons 12-15 standard layout)
      if (gp.buttons[12]?.pressed) s.moveY -= 1;   // up
      if (gp.buttons[13]?.pressed) s.moveY += 1;   // down
      if (gp.buttons[14]?.pressed) s.moveX -= 1;   // left
      if (gp.buttons[15]?.pressed) s.moveX += 1;   // right

      // Face buttons
      s.btnA = s.btnA || !!gp.buttons[0]?.pressed;  // A / Cross    → dribble
      s.btnB = s.btnB || !!gp.buttons[1]?.pressed;  // B / Circle   → crossover
      s.btnX = s.btnX || !!gp.buttons[2]?.pressed;  // X / Square   → stepback
      s.btnY = s.btnY || !!gp.buttons[3]?.pressed;  // Y / Triangle → jumpshot

      // Sprint: R1 (button 5) or L1 (button 4)
      s.sprint = s.sprint || !!gp.buttons[4]?.pressed || !!gp.buttons[5]?.pressed;
    }

    // Normalize axes to [-1, 1]
    s.moveX = Math.max(-1, Math.min(1, s.moveX));
    s.moveY = Math.max(-1, Math.min(1, s.moveY));

    // Rising edge detection (just-pressed this frame)
    s.justA = s.btnA && !prev.btnA;
    s.justB = s.btnB && !prev.btnB;
    s.justX = s.btnX && !prev.btnX;
    s.justY = s.btnY && !prev.btnY;

    this._state = s;
    return { ...s };
  }

  /** Current raw state without re-polling (safe to call multiple times per frame) */
  get state() { return { ...this._state }; }
}

if (typeof module !== 'undefined') module.exports = { ControllerInput };
