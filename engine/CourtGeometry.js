'use strict';
/**
 * CourtGeometry.js — Polygon zone math for basketball court positioning.
 * Dual-environment: browser globals + Node module exports.
 */

/**
 * Ray-casting point-in-polygon test.
 * @param {number} px
 * @param {number} py
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(px, py, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Check order: specific zones before generic ones, backcourt last
const _ZONE_PRIORITY = ['paint', 'mid-range', '3pt-top', '3pt-left', '3pt-right', 'backcourt'];

/**
 * Return the court area ID for a position using preset polygon zones.
 * @param {number} x
 * @param {number} y
 * @param {object} preset  CourtPreset with .polygonZones
 * @returns {string}       zone id or 'unknown'
 */
function getCourtArea(x, y, preset) {
  if (!preset?.polygonZones) return 'unknown';
  for (const zoneId of _ZONE_PRIORITY) {
    const poly = preset.polygonZones[zoneId];
    if (poly && pointInPolygon(x, y, poly)) return zoneId;
  }
  for (const [zoneId, poly] of Object.entries(preset.polygonZones)) {
    if (!_ZONE_PRIORITY.includes(zoneId) && poly && pointInPolygon(x, y, poly)) return zoneId;
  }
  return 'unknown';
}

/** @returns {boolean} */
function isInPaint(x, y, preset) {
  return getCourtArea(x, y, preset) === 'paint';
}

/** @returns {boolean} */
function isIn3PTZone(x, y, preset) {
  return getCourtArea(x, y, preset).startsWith('3pt');
}

/** @returns {boolean} */
function isInBackcourt(x, y, preset) {
  return getCourtArea(x, y, preset) === 'backcourt';
}

/**
 * Euclidean distance from a point to the rim anchor.
 * @param {number} x
 * @param {number} y
 * @param {object} preset
 * @returns {number} pixels
 */
function distanceToRim(x, y, preset) {
  const rim = preset?.rimAnchor ?? { x: 480, y: 185 };
  return Math.hypot(x - rim.x, y - rim.y);
}

/**
 * Bounding box of a polygon zone (for overlay drawing).
 * @param {string} zoneId
 * @param {object} preset
 * @returns {{x,y,w,h}|null}
 */
function getZonePolygonBounds(zoneId, preset) {
  const poly = preset?.polygonZones?.[zoneId];
  if (!poly || !poly.length) return null;
  const xs = poly.map(p => p.x);
  const ys = poly.map(p => p.y);
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { pointInPolygon, getCourtArea, isInPaint, isIn3PTZone, isInBackcourt, distanceToRim, getZonePolygonBounds };
}
