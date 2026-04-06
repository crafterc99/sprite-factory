/**
 * Physics.js — Lightweight 2D physics for the Game Tester
 * Handles: gravity, momentum, friction, bounds, ground collision
 */
'use strict';

class PhysicsEngine {
  constructor(opts = {}) {
    this.gravity     = opts.gravity     ?? 0.45;
    this.friction    = opts.friction    ?? 0.82;   // ground friction per frame
    this.airFriction = opts.airFriction ?? 0.96;   // air resistance
    this.maxSpeed    = opts.maxSpeed    ?? 5;
    this.groundY     = opts.groundY     ?? 520;
    this.boundsX     = opts.boundsX     ?? [60, 900];
    this.boundsY     = opts.boundsY     ?? [80, 580];

    this.x = opts.x ?? 480;
    this.y = opts.y ?? this.groundY;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this.facingRight = true;
    this._locked = false; // locked during action animations (crossover, stepback)
  }

  /** Apply a movement burst from AnimationMovementData */
  applyBurst(moveData, facingRight) {
    if (!moveData) return;
    const dir = facingRight ? 1 : -1;

    if (moveData.type === 'vertical' || moveData.type === 'combo') {
      this.vy = moveData.velocityY ?? -10;
      this.grounded = false;
    }
    if (moveData.type === 'horizontal' || moveData.type === 'combo') {
      this.vx += (moveData.velocityX ?? 0) * dir;
    }
  }

  /** Update physics state. Call once per render frame. Returns {x,y,vx,vy,grounded} */
  update(inputX, inputY) {
    // Horizontal input (only when not locked by action anim)
    if (!this._locked && inputX !== 0) {
      const accel = 0.75;
      this.vx += inputX * accel;
      if (inputX !== 0) this.facingRight = inputX > 0;
    }

    // Clamp speed
    this.vx = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, this.vx));

    // Friction
    const fric = this.grounded ? this.friction : this.airFriction;
    if (this._locked || inputX === 0 || Math.sign(this.vx) !== Math.sign(inputX)) {
      this.vx *= fric;
      if (Math.abs(this.vx) < 0.08) this.vx = 0;
    }

    // Gravity
    if (!this.grounded) {
      this.vy += this.gravity;
    }

    // Integrate
    this.x += this.vx;
    this.y += this.vy;

    // Ground
    if (this.y >= this.groundY) {
      this.y = this.groundY;
      this.vy = 0;
      this.grounded = true;
    }

    // Court bounds
    this.x = Math.max(this.boundsX[0], Math.min(this.boundsX[1], this.x));
    this.y = Math.max(this.boundsY[0], Math.min(this.boundsY[1], this.y));

    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy, grounded: this.grounded };
  }

  lock()   { this._locked = true;  }
  unlock() { this._locked = false; }

  reset(x, y) {
    this.x = x ?? 480;
    this.y = y ?? this.groundY;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this._locked = false;
  }
}

if (typeof module !== 'undefined') module.exports = { PhysicsEngine };
