'use strict';
/**
 * NetAnchorDirection.js — Direction classifier using net-anchor system.
 * Replaces SoulJamWedges.js — dual-environment: browser globals + Node module exports.
 *
 * Computes direction FROM player TOWARD net: Math.atan2(net.y - player.y, net.x - player.x)
 * 8 directions: d1=Front (facing net), going clockwise:
 *   d2=Front-Right, d3=Right, d4=Back-Right, d5=Back, d6=Back-Left, d7=Left, d8=Front-Left
 * Sprite key suffix: _d{id}   e.g. pdot_dribble_d3
 */

const NET_DEFAULT = { x: 480, y: 185 }; // canvas pixels — rimAnchor from CourtPreset

const DIRECTION_LABELS = [
  null,            // 0 unused
  'Front',         // d1 — facing net
  'Front-Right',   // d2
  'Right',         // d3
  'Back-Right',    // d4
  'Back',          // d5 — facing away from net
  'Back-Left',     // d6
  'Left',          // d7
  'Front-Left',    // d8
];

/**
 * Return 1-based direction id (1..dirCount) for a canvas-pixel position.
 * d1 = Front (player below net, angle ≈ -π/2). Directions go clockwise.
 *
 * @param {number} playerX canvas pixels
 * @param {number} playerY canvas pixels
 * @param {number} [netX=480] canvas pixels
 * @param {number} [netY=185] canvas pixels
 * @param {number} [dirCount=8] number of directions (1–8)
 * @returns {number} direction id 1..dirCount
 */
function getDirectionId(playerX, playerY, netX, netY, dirCount) {
  const nx = (netX != null) ? netX : NET_DEFAULT.x;
  const ny = (netY != null) ? netY : NET_DEFAULT.y;
  const count = Math.max(1, Math.min(8, dirCount || 8));

  const angle = Math.atan2(ny - playerY, nx - playerX);
  // Shift so FRONT (angle = -π/2) maps to sector 0.
  // Sector 0 spans: [-π/2 - sectorSize/2, -π/2 + sectorSize/2]
  // Shift needed: π/2 + sectorSize/2
  const sectorSize = (2 * Math.PI) / count;
  const shift = Math.PI / 2 + sectorSize / 2;
  const normalized = ((angle + shift) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return Math.min(Math.floor(normalized / sectorSize) + 1, count);
}

/**
 * Get display label for a direction id.
 * @param {number} id 1..8
 * @param {number} [count=8]
 * @returns {string}
 */
function getDirectionLabel(id, count) {
  if (count && count !== 8) return `d${id}`;
  return DIRECTION_LABELS[id] ?? `d${id}`;
}

/**
 * Build sector metadata for each direction (used by overlay drawing).
 * Sectors radiate from the net position. Each {id, label, startAngle, endAngle} in radians.
 *
 * @param {number} [count=8]
 * @returns {Array<{id, label, startAngle, endAngle}>}
 */
function buildDirectionSectors(count) {
  const n = Math.max(1, Math.min(8, count || 8));
  const sectorSize = (2 * Math.PI) / n;
  // d1 FRONT centered at -π/2 (pointing up = toward net from baseline)
  const frontCenter = -Math.PI / 2;

  return Array.from({ length: n }, (_, i) => {
    const center = frontCenter + i * sectorSize;
    return {
      id: i + 1,
      label: DIRECTION_LABELS[i + 1] ?? `d${i + 1}`,
      startAngle: center - sectorSize / 2,
      endAngle: center + sectorSize / 2,
    };
  });
}

// ── Module-level state (browser) ────────────────────────────────────────────

let _dirConfig = { net: { x: NET_DEFAULT.x, y: NET_DEFAULT.y }, count: 8 };

function setDirectionConfig(cfg) {
  _dirConfig = Object.assign({}, _dirConfig, cfg ?? {});
  return _dirConfig;
}

function getDirectionConfig() {
  return _dirConfig;
}

// ── Exports ─────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.NetAnchorDirection    = { getDirectionId, buildDirectionSectors, getDirectionLabel, setDirectionConfig, getDirectionConfig, NET_DEFAULT, DIRECTION_LABELS };
  window.getDirectionId        = getDirectionId;
  window.buildDirectionSectors = buildDirectionSectors;
  window.getDirectionLabel     = getDirectionLabel;
  window.setDirectionConfig    = setDirectionConfig;
  window.getDirectionConfig    = getDirectionConfig;
}

if (typeof module !== 'undefined') {
  module.exports = { getDirectionId, buildDirectionSectors, getDirectionLabel, setDirectionConfig, getDirectionConfig, NET_DEFAULT, DIRECTION_LABELS };
}
