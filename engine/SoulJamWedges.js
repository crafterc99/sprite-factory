'use strict';
/**
 * SoulJamWedges.js — Fan-wedge position classifier for directional sprite selection.
 * Dual-environment: browser globals + Node module exports.
 *
 * Wedges radiate from an apex point (baseline center) and tile the full court with no gaps.
 * getAnimationAngle(x, y) returns the wedge id (1..count) to use as the sprite angle suffix.
 * Sprite naming: {char}_{action}_a{id}   e.g. pdot_dribble_a3
 */

const WEDGE_DEFAULTS = {
  // apex in canvas pixels: near baseline center (above rim)
  apex: { x: 480, y: 165 },
  startAngle: 0,          // radians — toward far right of court
  endAngle: Math.PI,      // radians — toward far left of court
  count: 5,
  numberingFrom: 'end',   // 'end' → wedge at startAngle gets id=count (Far Right=5), endAngle gets id=1
  labels: null,           // optional string[] in angle-sweep order (index 0 = startAngle side)
};

function buildWedgeConfig(partial) {
  return Object.assign({}, WEDGE_DEFAULTS, partial ?? {});
}

// Internal: return 0-based index of the wedge containing this canvas point
function _getWedgeIndex(x, y, config) {
  const { apex, startAngle, endAngle, count, boundaries } = config;
  const raw = Math.atan2(y - apex.y, x - apex.x);
  const angle = Math.max(startAngle, Math.min(endAngle - 1e-9, raw));

  if (boundaries && boundaries.length >= count - 1) {
    let idx = 0;
    for (let i = 0; i < boundaries.length; i++) {
      if (angle > boundaries[i]) idx = i + 1;
    }
    return Math.min(idx, count - 1);
  }
  const span = (endAngle - startAngle) / count;
  return Math.min(Math.floor((angle - startAngle) / span), count - 1);
}

/**
 * Return the wedge id (1..count) for a canvas-pixel position.
 * @param {number} x  canvas pixels
 * @param {number} y  canvas pixels
 * @param {object} config  WedgeConfig
 * @returns {number} wedge id 1..count
 */
function getAnimationAngle(x, y, config) {
  const cfg = config ?? (typeof getWedgeConfig === 'function' ? getWedgeConfig() : WEDGE_DEFAULTS);
  const idx = _getWedgeIndex(x, y, cfg);
  const from = cfg.numberingFrom ?? 'end';
  return from === 'start' ? idx + 1 : cfg.count - idx;
}

/**
 * Get display label for a wedge id.
 * @param {number} id  1..count
 * @param {object} config
 * @returns {string|null}
 */
function getWedgeLabel(id, config) {
  if (!config?.labels) return null;
  const idx = (config.numberingFrom ?? 'end') === 'start' ? id - 1 : config.count - id;
  return config.labels[idx] ?? null;
}

/**
 * Build array of boundary angles [startAngle, b1, b2, ..., endAngle] for count+1 values.
 */
function _buildBoundaryAngles(config) {
  const { startAngle, endAngle, count, boundaries } = config;
  if (boundaries && boundaries.length === count - 1) {
    return [startAngle, ...boundaries, endAngle];
  }
  const span = (endAngle - startAngle) / count;
  return Array.from({ length: count + 1 }, (_, i) => startAngle + i * span);
}

/**
 * Compute wedge metadata (id, index, label, boundary angles) for each wedge.
 * Points are NOT included — use canvas arc drawing instead.
 * @param {object} config  WedgeConfig
 * @returns {Array<{id, index, label, startAngle, endAngle}>}
 */
function buildWedgePolygons(config) {
  const cfg = config ?? WEDGE_DEFAULTS;
  const bounds = _buildBoundaryAngles(cfg);
  const from = cfg.numberingFrom ?? 'end';
  return Array.from({ length: cfg.count }, (_, i) => {
    const id = from === 'start' ? i + 1 : cfg.count - i;
    return {
      id,
      index: i,
      label: getWedgeLabel(id, cfg) ?? `a${id}`,
      startAngle: bounds[i],
      endAngle: bounds[i + 1],
    };
  });
}

// ── Module-level state (browser) ────────────────────────────────────────────

let _config = buildWedgeConfig({});

function setWedgeConfig(cfg) {
  _config = buildWedgeConfig(cfg);
  return _config;
}

function getWedgeConfig() {
  return _config;
}

// ── Exports ─────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.SoulJamWedges   = { getAnimationAngle, buildWedgePolygons, setWedgeConfig, getWedgeConfig, buildWedgeConfig, getWedgeLabel, WEDGE_DEFAULTS };
  window.getAnimationAngle  = getAnimationAngle;
  window.buildWedgePolygons = buildWedgePolygons;
  window.setWedgeConfig     = setWedgeConfig;
  window.getWedgeConfig     = getWedgeConfig;
  window.getWedgeLabel      = getWedgeLabel;
  window.buildWedgeConfig   = buildWedgeConfig;
}

if (typeof module !== 'undefined') {
  module.exports = { getAnimationAngle, buildWedgePolygons, setWedgeConfig, getWedgeConfig, buildWedgeConfig, getWedgeLabel, WEDGE_DEFAULTS };
}
