'use strict';
/**
 * CourtZones.js — 9-region spatial court grid + perspective angle helpers
 *
 * Position zones: 3×3 grid over the 960×640 gameplay canvas
 *   upper-left  | top-key     | upper-right
 *   left-wing   | arc         | right-wing
 *   lower-left  | paint       | lower-right
 *
 * Perspective (angle) zones: 8-directional facing index 0–7
 *   0=Front, 1=Front Right, 2=Right, 3=Back Right,
 *   4=Back, 5=Back Left, 6=Left, 7=Front Left
 */

const CANVAS_W = 960;
const CANVAS_H = 640;

// Column / row thresholds (pixels)
const COL1 = CANVAS_W * 0.33; // ~317
const COL2 = CANVAS_W * 0.67; // ~643
const ROW1 = CANVAS_H * 0.35; // ~224
const ROW2 = CANVAS_H * 0.70; // ~448

const POSITION_ZONES = [
  { id: 'upper-left',  label: 'Upper Left',  col: 0, row: 0 },
  { id: 'top-key',     label: 'Top Key',     col: 1, row: 0 },
  { id: 'upper-right', label: 'Upper Right', col: 2, row: 0 },
  { id: 'left-wing',   label: 'Left Wing',   col: 0, row: 1 },
  { id: 'arc',         label: 'Arc',         col: 1, row: 1 },
  { id: 'right-wing',  label: 'Right Wing',  col: 2, row: 1 },
  { id: 'lower-left',  label: 'Lower Left',  col: 0, row: 2 },
  { id: 'paint',       label: 'Paint',       col: 1, row: 2 },
  { id: 'lower-right', label: 'Lower Right', col: 2, row: 2 },
];

const ZONE_IDS = POSITION_ZONES.map(z => z.id);

/** Map zone id → POSITION_ZONES entry */
const ZONE_BY_ID = Object.fromEntries(POSITION_ZONES.map(z => [z.id, z]));

/** 8-directional angle labels (index = angleIndex) */
const ANGLE_LABELS = ['Front', 'Front Right', 'Right', 'Back Right', 'Back', 'Back Left', 'Left', 'Front Left'];

/**
 * Return the position zone id for a pixel coordinate on the 960×640 canvas.
 * Falls back to 'arc' (center) if out of range.
 */
function getPositionZone(x, y) {
  const col = x < COL1 ? 0 : x < COL2 ? 1 : 2;
  const row = y < ROW1 ? 0 : y < ROW2 ? 1 : 2;
  return POSITION_ZONES.find(z => z.col === col && z.row === row)?.id ?? 'arc';
}

/**
 * Circular angular distance between two 8-direction indices.
 * Returns 0–4 (max half-circle).
 */
function angleDistance(a, b) {
  const diff = Math.abs((a % 8) - (b % 8));
  return Math.min(diff, 8 - diff);
}

/**
 * Returns bounding box {x, y, w, h} for a zone id on the given canvas dimensions.
 * Useful for drawing zone overlays.
 */
function getZoneBounds(zoneId, canvasW = CANVAS_W, canvasH = CANVAS_H) {
  const z = ZONE_BY_ID[zoneId];
  if (!z) return null;
  const cols = [0, canvasW * 0.33, canvasW * 0.67, canvasW];
  const rows = [0, canvasH * 0.35, canvasH * 0.70, canvasH];
  return {
    x: cols[z.col],
    y: rows[z.row],
    w: cols[z.col + 1] - cols[z.col],
    h: rows[z.row + 1] - rows[z.row],
  };
}

if (typeof module !== 'undefined') {
  module.exports = { POSITION_ZONES, ZONE_IDS, ZONE_BY_ID, ANGLE_LABELS, getPositionZone, angleDistance, getZoneBounds, CANVAS_W, CANVAS_H };
}
