/**
 * MovementEngine.js — Animation movement data definitions and utilities
 *
 * AnimationMovementData shape:
 *   type:         "stationary" | "vertical" | "horizontal" | "combo"
 *   velocityX:    number  (pixels/frame on trigger, direction-relative)
 *   velocityY:    number  (pixels/frame on trigger, negative = up)
 *   acceleration: number  (additional vX ramp during action, optional)
 *   duration:     number  (ms the action animation lasts)
 *   curve:        "linear" | "ease-in" | "ease-out" | "arc"
 *   lockMovement: boolean (prevent player input during action)
 */
'use strict';

const MOVEMENT_PRESETS = {
  // ── Stationary ──────────────────────────────────────────────────────────
  'dribble':         { type: 'stationary', velocityX: 0,  velocityY: 0,   acceleration: 0,   duration: 0,   curve: 'linear',   lockMovement: false },
  'static-dribble':  { type: 'stationary', velocityX: 0,  velocityY: 0,   acceleration: 0,   duration: 0,   curve: 'linear',   lockMovement: false },
  // L2 hold = defense sliding — lateral shuffle, slower maxSpeed, lower center of gravity
  'defense-shuffle':   { type: 'horizontal', velocityX: 2,  velocityY: 0,   acceleration: 0.3, duration: 200, curve: 'ease-out', lockMovement: false, isDefense: true },
  'defense-backpedal': { type: 'horizontal', velocityX: -2, velocityY: 0,   acceleration: 0,   duration: 350, curve: 'ease-out', lockMovement: false, isDefense: true },

  // ── Vertical (jumps) ─────────────────────────────────────────────────────
  'jumpshot':        { type: 'vertical',   velocityX: 0,  velocityY: -10, acceleration: 0,   duration: 750, curve: 'arc',      lockMovement: true  },
  'ac-jumpshot':     { type: 'vertical',   velocityX: 0,  velocityY: -10, acceleration: 0,   duration: 750, curve: 'arc',      lockMovement: true  },
  'tween-tween':     { type: 'vertical',   velocityX: 0,  velocityY: -6,  acceleration: 0,   duration: 500, curve: 'arc',      lockMovement: true  },

  // ── Horizontal (lateral moves) ───────────────────────────────────────────
  // Soul Jam separation moves (Constants.ts / SeparationModel.ts):
  // CROSSOVER_DURATION 0.3s, STEPBACK_DURATION 0.35s, peak burst velocity
  // ≈ (separation / 0.3) * 1.5 px/s ≈ 7 px/frame for default ratings.
  // curve 'burst' = velocity decays linearly to zero (speedCurve = 1 - progress).
  'crossover':       { type: 'horizontal', velocityX: 7,  velocityY: 0,   acceleration: 0,   duration: 300, curve: 'burst',    lockMovement: true  },
  'cross':           { type: 'horizontal', velocityX: 7,  velocityY: 0,   acceleration: 0,   duration: 300, curve: 'burst',    lockMovement: true  },
  'tween-cross':     { type: 'horizontal', velocityX: 5,  velocityY: 0,   acceleration: 0.5, duration: 400, curve: 'ease-out', lockMovement: true  },
  'ac-cgs':          { type: 'horizontal', velocityX: 3,  velocityY: 0,   acceleration: 0.3, duration: 480, curve: 'ease-out', lockMovement: false },
  'steal':           { type: 'horizontal', velocityX: 2,  velocityY: 0,   acceleration: 0.2, duration: 300, curve: 'ease-in',  lockMovement: true  },

  // ── Combo (multi-axis) ───────────────────────────────────────────────────
  'stepback':        { type: 'combo',      velocityX: 7,  velocityY: 0,   acceleration: 0,   duration: 350, curve: 'burst',    lockMovement: true  },
};

/** Get movement preset by animation name (normalised key lookup) */
function getMovementPreset(animName) {
  if (!animName) return null;
  const key = animName.toLowerCase().replace(/\s+/g, '-');
  return MOVEMENT_PRESETS[key] ?? null;
}

/** Easing functions for visual curve (t: 0→1, returns 0→1) */
function applyCurve(t, curve) {
  t = Math.max(0, Math.min(1, t));
  switch (curve) {
    case 'ease-in':  return t * t;
    case 'ease-out': return t * (2 - t);
    case 'arc':      return 4 * t * (1 - t);  // peaks at t=0.5
    case 'burst':    return t * (2 - t);       // ∫(1-t)dt — linear velocity decay
    default:         return t;                  // linear
  }
}

/**
 * Port of Soul Jam's SeparationModel.calculate (simulation/models/SeparationModel.ts).
 * Returns the separation distance and peak burst velocity for a stepback/crossover.
 * @param {number} handleRating  offense ball-handling rating 0–100 (steal stat)
 * @param {number} defenseRating defender lateral-quickness rating 0–100
 * @param {number} speedPxSec    offense speed at trigger time in px/s
 */
function calcSeparationBurst(handleRating = 70, defenseRating = 50, speedPxSec = 0) {
  const baseSeparation = 50 + (handleRating / 100) * 70;          // STEPBACK_DISTANCE + handle * 70
  const separation = baseSeparation * (1 - (defenseRating / 100) * 0.5);
  const movementBonus = Math.max(0, Math.min(0.3, speedPxSec / 300));
  const finalSeparation = separation * (1 + movementBonus);
  return {
    separation: finalSeparation,
    burstVelocity: (finalSeparation / 0.3) * 1.5,                  // px/s — cover distance in ~0.3s
    burstVelocityPerFrame: ((finalSeparation / 0.3) * 1.5) / 60,   // px/frame at 60fps
  };
}

/**
 * Merge saved custom movement data with the built-in preset.
 * Custom data (from the editor) takes priority.
 */
function resolveMovementData(animName, customData) {
  const preset = getMovementPreset(animName);
  if (!customData && !preset) return null;
  return Object.assign({}, preset ?? {}, customData ?? {});
}

if (typeof module !== 'undefined') module.exports = { MOVEMENT_PRESETS, getMovementPreset, applyCurve, resolveMovementData, calcSeparationBurst };
