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
  'crossover':       { type: 'horizontal', velocityX: 5,  velocityY: 0,   acceleration: 0.5, duration: 380, curve: 'ease-out', lockMovement: true  },
  'tween-cross':     { type: 'horizontal', velocityX: 5,  velocityY: 0,   acceleration: 0.5, duration: 400, curve: 'ease-out', lockMovement: true  },
  'ac-cgs':          { type: 'horizontal', velocityX: 3,  velocityY: 0,   acceleration: 0.3, duration: 480, curve: 'ease-out', lockMovement: false },
  'steal':           { type: 'horizontal', velocityX: 2,  velocityY: 0,   acceleration: 0.2, duration: 300, curve: 'ease-in',  lockMovement: true  },

  // ── Combo (multi-axis) ───────────────────────────────────────────────────
  'stepback':        { type: 'combo',      velocityX: -4, velocityY: -3,  acceleration: 0,   duration: 380, curve: 'ease-in',  lockMovement: true  },
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
    default:         return t;                  // linear
  }
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

if (typeof module !== 'undefined') module.exports = { MOVEMENT_PRESETS, getMovementPreset, applyCurve, resolveMovementData };
