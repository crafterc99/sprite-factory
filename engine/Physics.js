/**
 * Physics.js — Lightweight 2D physics for the Game Tester
 * Handles: gravity, momentum, friction, bounds, ground collision
 *
 * Speed tiers (matching Soul Jam):
 *   walk   — stick < walkThreshold → maxSpeed * walkMult
 *   run    — full stick, no sprint  → maxSpeed
 *   sprint — L1/R1 held             → maxSpeed * sprintMult
 *   defense — L2 held               → maxSpeed * defenseMult
 */
'use strict';

class PhysicsEngine {
  constructor(opts = {}) {
    this.gravity     = opts.gravity     ?? 0.5;
    this.friction    = opts.friction    ?? 0.78;   // ground friction per frame (snappier stops)
    this.airFriction = opts.airFriction ?? 0.97;   // air resistance
    this.maxSpeed    = opts.maxSpeed    ?? 5;
    this.groundY     = opts.groundY     ?? 520;
    this.boundsX     = opts.boundsX     ?? [60, 900];
    this.boundsY     = opts.boundsY     ?? [80, 580];

    // Speed tier multipliers
    this.sprintMult  = opts.sprintMult  ?? 1.6;    // L1/R1 sprint boost
    this.walkMult    = opts.walkMult    ?? 0.52;    // slow stick = walk speed
    this.walkThresh  = opts.walkThresh  ?? 0.4;     // stick magnitude below this = walk
    this.defenseMult = opts.defenseMult ?? 0.55;    // L2 defense speed cap

    this.x = opts.x ?? 480;
    this.y = opts.y ?? this.groundY;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this.facingRight = true;
    this._locked = false; // locked during action animations (crossover, stepback)
    this._burst = null;   // active Soul Jam separation burst {vx, vy, duration, elapsed}

    // Track current speed tier for AnimationPlayer
    this.speedTier = 'idle'; // 'idle' | 'walk' | 'run' | 'sprint'
  }

  /**
   * Apply a movement burst from AnimationMovementData.
   *
   * curve: 'burst' replicates Soul Jam's separation moves (PlayerStates.ts):
   * the burst velocity decays linearly to zero over `duration`
   * (speedCurve = 1 - progress) and displaces position directly, so run
   * friction can't eat the move. velocityX/velocityY are the peak speed in
   * px/frame; an explicit unit direction can be given via dirX/dirY
   * (e.g. stepback = away from hoop, crossover = lateral to hoop).
   */
  applyBurst(moveData, facingRight) {
    if (!moveData) return;
    const dir = facingRight ? 1 : -1;

    if (moveData.curve === 'burst') {
      let bvx, bvy;
      if (moveData.dirX !== undefined || moveData.dirY !== undefined) {
        const speed = Math.hypot(moveData.velocityX ?? 0, moveData.velocityY ?? 0);
        bvx = (moveData.dirX ?? 0) * speed;
        bvy = (moveData.dirY ?? 0) * speed;
      } else {
        bvx = (moveData.velocityX ?? 0) * dir;
        bvy = moveData.velocityY ?? 0;
      }
      this._burst = { vx: bvx, vy: bvy, duration: Math.max(1, moveData.duration ?? 300), elapsed: 0 };
      return;
    }

    if (moveData.type === 'vertical' || moveData.type === 'combo') {
      this.vy = moveData.velocityY ?? -10;
      this.grounded = false;
    }
    if (moveData.type === 'horizontal' || moveData.type === 'combo') {
      this.vx += (moveData.velocityX ?? 0) * dir;
    }
  }

  /**
   * Update physics state. Call once per render frame.
   * @param {number}  inputX       -1..1
   * @param {number}  inputY       -1..1
   * @param {boolean} defenseMode  L2 held — slower speed, no jumping, shuffle stance
   * @param {boolean} sprint       L1/R1 held — faster speed
   * @param {number}  dt           ms since last frame (default one 60fps frame)
   * Returns {x, y, vx, vy, grounded, speedTier}
   */
  update(inputX, inputY, defenseMode, sprint, dt = 16.67) {
    // Determine effective max speed and acceleration based on speed tier
    const stickMag = Math.sqrt(inputX * inputX + inputY * inputY);
    const isWalking = !defenseMode && !sprint && stickMag > 0 && stickMag < this.walkThresh;

    let effectiveMax, accel;
    if (defenseMode) {
      effectiveMax = this.maxSpeed * this.defenseMult;
      accel        = 0.45;
      this.speedTier = stickMag > 0.1 ? 'walk' : 'idle';
    } else if (sprint) {
      effectiveMax = this.maxSpeed * this.sprintMult;
      accel        = 1.0;
      this.speedTier = stickMag > 0.1 ? 'sprint' : 'idle';
    } else if (isWalking) {
      effectiveMax = this.maxSpeed * this.walkMult;
      accel        = 0.55;
      this.speedTier = 'walk';
    } else {
      effectiveMax = this.maxSpeed;
      accel        = 0.82;
      this.speedTier = stickMag > 0.1 ? 'run' : 'idle';
    }

    // Horizontal input (only when not locked by action anim)
    if (!this._locked && inputX !== 0) {
      this.vx += inputX * accel;
      this.facingRight = inputX > 0;
    }

    // Clamp speed
    this.vx = Math.max(-effectiveMax, Math.min(effectiveMax, this.vx));

    // Friction — apply when locked, no input, or decelerating
    const fric = this.grounded ? this.friction : this.airFriction;
    if (this._locked || inputX === 0 || Math.sign(this.vx) !== Math.sign(inputX)) {
      this.vx *= fric;
      if (Math.abs(this.vx) < 0.08) this.vx = 0;
    }

    // Vertical input (only for non-defense movement on Y axis)
    if (!this._locked && !defenseMode && inputY !== 0) {
      // Y-axis movement: up/down on court
      this.y += inputY * (effectiveMax * 0.6);
    }

    // Gravity
    if (!this.grounded) {
      this.vy += this.gravity;
    }

    // Integrate position
    this.x += this.vx;
    this.y += this.vy;

    // Soul Jam separation burst — decelerating displacement on top of the
    // regular integration: position += burstVel * (1 - progress) * dt
    if (this._burst) {
      const b = this._burst;
      b.elapsed += dt;
      const progress = Math.min(1, b.elapsed / b.duration);
      const speedCurve = 1 - progress;
      const frames = dt / 16.67; // burst velocities are px/frame at 60fps
      this.x += b.vx * speedCurve * frames;
      this.y += b.vy * speedCurve * frames;
      if (progress >= 1) this._burst = null;
    }

    // Ground collision
    if (this.y >= this.groundY) {
      this.y = this.groundY;
      this.vy = 0;
      this.grounded = true;
    }

    // Court bounds
    this.x = Math.max(this.boundsX[0], Math.min(this.boundsX[1], this.x));
    this.y = Math.max(this.boundsY[0], Math.min(this.boundsY[1], this.y));

    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy, grounded: this.grounded, speedTier: this.speedTier };
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
    this._burst = null;
    this.speedTier = 'idle';
  }
}

if (typeof module !== 'undefined') module.exports = { PhysicsEngine };
