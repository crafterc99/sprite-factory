/**
 * AnimationPlayer.js — Animation state machine + frame timing
 *
 * States:
 *   IDLE         → loop idle/dribble animation, no movement
 *   MOVING       → loop walk/dribble animation while player moves
 *   ACTION       → one-shot action animation (jumpshot, crossover, stepback)
 *                  returns to IDLE/MOVING when done
 *
 * On entering an ACTION state, the player's movement burst is applied
 * via physics.applyBurst() using the animation's movement data.
 */
'use strict';

const PLAYER_STATES = {
  IDLE:    'IDLE',
  MOVING:  'MOVING',
  ACTION:  'ACTION',
};

// Map player action → preferred animation names (priority order)
const ACTION_ANIMS = {
  jumpshot:  ['jumpshot', 'ac-jumpshot', 'tween-tween'],
  crossover: ['crossover', 'tween-cross', 'ac-cgs'],
  stepback:  ['stepback'],
  dribble:   ['static-dribble', 'dribble'],
};

const IDLE_ANIMS    = ['static-dribble', 'dribble'];
const MOVING_ANIMS  = ['dribble', 'static-dribble'];

class AnimationPlayer {
  /**
   * @param {object} opts
   *   availableAnims  - array of {name, fps, loop, frameCount, movementData}
   *   physics         - PhysicsEngine instance
   *   onAnimChange    - callback(animName) when active animation changes
   */
  constructor(opts = {}) {
    this.availableAnims = opts.availableAnims ?? [];
    this.physics        = opts.physics ?? null;
    this.onAnimChange   = opts.onAnimChange ?? null;

    this.state          = PLAYER_STATES.IDLE;
    this.currentAnim    = null;   // name of currently playing animation
    this.currentFrame   = 0;
    this.lastFrameTime  = 0;
    this.actionTimer    = 0;      // ms remaining in current action
    this._pendingAction = null;   // queued action name
  }

  /** Update available animations (call when character changes) */
  setAnimations(anims) {
    this.availableAnims = anims ?? [];
    // If current anim no longer available, reset
    if (this.currentAnim && !this._findAnim(this.currentAnim)) {
      this.currentAnim = null;
      this.currentFrame = 0;
    }
  }

  /** Trigger an action animation by key: 'jumpshot' | 'crossover' | 'stepback' | 'dribble' */
  triggerAction(actionKey, movementData) {
    if (this.state === PLAYER_STATES.ACTION) return; // busy — ignore
    const candidates = ACTION_ANIMS[actionKey] ?? [];
    const anim = this._findFirstMatch(candidates);
    if (!anim) return;

    this._setAnim(anim.name);
    this.state = PLAYER_STATES.ACTION;
    this.actionTimer = movementData?.duration ?? (anim.frameCount / anim.fps) * 1000;

    // Apply physics burst
    if (this.physics && movementData) {
      this.physics.applyBurst(movementData, this.physics.facingRight);
      if (movementData.lockMovement) this.physics.lock();
    }
  }

  /**
   * Main update — call every animation frame.
   * @param {number}  timestamp  performance.now() / rAF timestamp
   * @param {object}  input      from ControllerInput.poll()
   * @param {number}  dt         ms since last frame
   * @returns {object} { animName, frame, facingRight, state }
   */
  update(timestamp, input, dt) {
    // ── Action timer ────────────────────────────────────────────────────────
    if (this.state === PLAYER_STATES.ACTION) {
      this.actionTimer -= dt;
      if (this.actionTimer <= 0) {
        this.physics?.unlock();
        this.state = PLAYER_STATES.IDLE;
        this._pendingAction = null;
      }
    }

    // ── State transitions ────────────────────────────────────────────────────
    if (this.state !== PLAYER_STATES.ACTION) {
      const moving = Math.abs(input?.moveX ?? 0) > 0.1 || Math.abs(input?.moveY ?? 0) > 0.1;
      this.state = moving ? PLAYER_STATES.MOVING : PLAYER_STATES.IDLE;

      const candidates = this.state === PLAYER_STATES.MOVING ? MOVING_ANIMS : IDLE_ANIMS;
      const desired = this._findFirstMatch(candidates) ?? this.availableAnims[0];
      if (desired && desired.name !== this.currentAnim) {
        this._setAnim(desired.name);
      }
    }

    // ── Frame advance ────────────────────────────────────────────────────────
    const anim = this._findAnim(this.currentAnim);
    if (anim && timestamp) {
      const fps  = anim.fps ?? 8;
      const loop = this.state !== PLAYER_STATES.ACTION ? true : (anim.loop ?? false);
      const frameDuration = 1000 / fps;
      if (!this.lastFrameTime) this.lastFrameTime = timestamp;
      if (timestamp - this.lastFrameTime >= frameDuration) {
        const next = this.currentFrame + 1;
        if (next >= anim.frameCount) {
          this.currentFrame = loop ? 0 : anim.frameCount - 1;
        } else {
          this.currentFrame = next;
        }
        this.lastFrameTime = timestamp;
      }
    }

    return {
      animName:    this.currentAnim,
      frame:       this.currentFrame,
      frameCount:  anim?.frameCount ?? 1,
      fps:         anim?.fps ?? 8,
      facingRight: this.physics?.facingRight ?? true,
      state:       this.state,
    };
  }

  /** Force-play a specific animation (for manual selection in testing UI) */
  forceAnim(animName) {
    if (animName !== this.currentAnim) this._setAnim(animName);
    this.state = PLAYER_STATES.IDLE;
    this.physics?.unlock();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _setAnim(name) {
    if (name === this.currentAnim) return;
    this.currentAnim   = name;
    this.currentFrame  = 0;
    this.lastFrameTime = 0;
    this.onAnimChange?.(name);
  }

  _findAnim(name) {
    return this.availableAnims.find(a => a.name === name) ?? null;
  }

  _findFirstMatch(candidates) {
    for (const name of candidates) {
      const found = this._findAnim(name);
      if (found) return found;
    }
    return null;
  }
}

if (typeof module !== 'undefined') module.exports = { AnimationPlayer, PLAYER_STATES, ACTION_ANIMS };
