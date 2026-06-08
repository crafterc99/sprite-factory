/**
 * AnimationPlayer.js — Animation state machine + frame timing
 *
 * States:
 *   IDLE         → loop idle/dribble animation, no movement
 *   MOVING       → loop walk/dribble animation while player moves
 *   ACTION       → one-shot action animation (jumpshot, crossover, stepback)
 *                  returns to IDLE/MOVING when done
 *
 * Speed tiers (from PhysicsEngine.speedTier):
 *   idle   → static-dribble / idle
 *   walk   → walk / dribble (slower)
 *   run    → dribble (normal speed)
 *   sprint → dribble (1.4x fps boost)
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
  steal:     ['steal'],
  dribble:   ['hand-switch', 'static-dribble', 'dribble'],
  defense:   ['defense-shuffle', 'defense-backpedal'],
};

// Animation candidates by movement state (slot IDs first, legacy names as fallback)
const IDLE_ANIMS         = ['idle-dribble', 'static-dribble', 'idle_ball', 'dribble', 'idle'];
const WALK_ANIMS         = ['jog-dribble', 'dribble', 'walk', 'static-dribble'];
const MOVING_ANIMS       = ['jog-dribble', 'dribble', 'static-dribble'];
const SPRINT_ANIMS       = ['jog-dribble', 'dribble'];
const DEFENSE_IDLE_ANIMS = ['defense-shuffle', 'defense-backpedal'];
const DEFENSE_MOVE_ANIMS = ['defense-shuffle', 'defense-backpedal'];

// Sprint fps multiplier applied on top of the animation's base fps
const SPRINT_FPS_MULT = 1.4;

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
    this._sprintActive  = false;  // sprint fps boost flag
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

  /** Trigger an action animation by key: 'jumpshot' | 'crossover' | 'stepback' | 'dribble' | 'steal' */
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
   * @param {number}  timestamp     performance.now() / rAF timestamp
   * @param {object}  input         from ControllerInput.poll()
   * @param {number}  dt            ms since last frame
   * @param {boolean} defenseMode   L2 held
   * @param {string}  positionZone  current court zone id (e.g. 'arc', 'paint')
   * @returns {object} { animName, frame, facingRight, state, speedTier }
   */
  update(timestamp, input, dt, defenseMode, positionZone = null) {
    const sprint    = input?.sprint ?? false;
    const speedTier = this.physics?.speedTier ?? (sprint ? 'sprint' : 'idle');

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
      this._sprintActive = sprint && moving;

      // Pick animation pool based on defense mode and speed tier
      let candidates;
      if (defenseMode) {
        const moveY = input?.moveY ?? 0;
        if (moving && moveY < -0.3) {
          candidates = ['defense-backpedal', 'defense-shuffle'];
        } else {
          candidates = DEFENSE_MOVE_ANIMS;
        }
        if (!moving) candidates = DEFENSE_IDLE_ANIMS;
      } else if (speedTier === 'walk') {
        candidates = moving ? WALK_ANIMS : IDLE_ANIMS;
      } else {
        candidates = moving ? MOVING_ANIMS : IDLE_ANIMS;
      }
      // Zone-aware pick: prefer anims valid for this zone, exclude blocked ones.
      // Falls back to zone-agnostic anims, then first available.
      const desired = this._findBestForZone(candidates, positionZone) ?? this.availableAnims[0];
      if (desired && desired.name !== this.currentAnim) {
        this._setAnim(desired.name);
      }
    }

    // ── Frame advance ────────────────────────────────────────────────────────
    const anim = this._findAnim(this.currentAnim);
    if (anim && timestamp) {
      let fps  = anim.fps ?? 8;
      // Sprint fps boost for locomotion animations
      if (this._sprintActive && (anim.name === 'dribble' || anim.name === 'walk')) {
        fps = fps * SPRINT_FPS_MULT;
      }
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
      speedTier,
      sprint:      this._sprintActive,
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

  /**
   * Zone-aware animation picker.
   * 1. Filter candidates to what's actually available.
   * 2. Remove any explicitly blocked for this zone.
   * 3. Prefer anims that list this zone in validZones.
   * 4. Fall back to zone-agnostic anims (no validZones set).
   * 5. Fall back to first available candidate regardless of zone.
   */
  _findBestForZone(candidates, positionZone) {
    const available = candidates
      .map(name => this._findAnim(name))
      .filter(Boolean);

    if (!available.length) return null;
    if (!positionZone) return available[0];

    // Filter out blocked anims for this zone
    const notBlocked = available.filter(a => {
      const blocked = a.blockedZones;
      return !blocked || !blocked.includes(positionZone);
    });

    if (!notBlocked.length) return available[0]; // all blocked? fall back

    // Prefer anims that explicitly include this zone
    const preferred = notBlocked.filter(a => {
      const valid = a.validZones;
      return valid && valid.includes(positionZone);
    });
    if (preferred.length) return preferred[0];

    // Fall back to zone-agnostic anims (no validZones restriction)
    const agnostic = notBlocked.filter(a => !a.validZones || !a.validZones.length);
    return agnostic[0] ?? notBlocked[0];
  }
}

if (typeof module !== 'undefined') module.exports = { AnimationPlayer, PLAYER_STATES, ACTION_ANIMS };
