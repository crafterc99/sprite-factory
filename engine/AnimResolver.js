'use strict';
/**
 * AnimResolver.js — Court-aware, angle-aware animation selection
 *
 * resolveAnimation(action, availableAnims, positionZoneId, perspectiveAngle, opts)
 *   Scores each candidate animation by:
 *     1. Zone blocking (hard reject if zone in blockedZones)
 *     2. Zone preference (bonus if zone in preferredZones)
 *     3. Angle proximity (penalty = angleDistance * 10)
 *     4. Legacy animations (no zone data) are always valid
 *   Returns the highest-scoring animation, or null.
 */

// Node: pull from CourtZones module. Browser: angleDistance is already a global.
const _angleDistance = (typeof require !== 'undefined' && typeof window === 'undefined')
  ? require('./CourtZones').angleDistance
  : (a, b) => { const d = Math.abs((a % 8) - (b % 8)); return Math.min(d, 8 - d); };

/**
 * Resolve the best animation for the given context.
 *
 * @param {string}   action          - Animation category/type (e.g. 'jumpshot', 'crossover')
 * @param {object[]} availableAnims  - Array of AnimationDef entries from anim-lib
 * @param {string}   positionZoneId  - Current court position zone id (e.g. 'arc')
 * @param {number}   perspectiveAngle - Current facing angle index 0–7
 * @param {object}   [opts]
 * @param {boolean}  [opts.strict]   - If true, only return anims that explicitly list the zone as valid
 * @returns {object|null}            - Best AnimationDef, or null
 */
function resolveAnimation(action, availableAnims, positionZoneId, perspectiveAngle, opts = {}) {
  if (!availableAnims?.length) return null;

  // Filter by action/category match (name contains action OR tags includes action OR category matches)
  const actionLower = (action ?? '').toLowerCase();
  const candidates = availableAnims.filter(a => {
    const nameMatch = a.name?.toLowerCase().includes(actionLower);
    const tagMatch  = a.tags?.some(t => t.toLowerCase().includes(actionLower));
    const catMatch  = a.category?.toLowerCase() === actionLower;
    return nameMatch || tagMatch || catMatch;
  });

  if (!candidates.length) return null;

  const scored = candidates.map(anim => {
    let score = 100;

    const hasZoneData = Array.isArray(anim.validZones) && anim.validZones.length > 0;
    const blockedZones   = anim.blockedZones   ?? [];
    const preferredZones = anim.preferredZones ?? [];
    const validZones     = anim.validZones     ?? [];

    // Hard reject — zone is explicitly blocked
    if (blockedZones.includes(positionZoneId)) return null;

    if (hasZoneData && opts.strict) {
      // Strict mode: only pass if zone is explicitly valid
      if (!validZones.includes(positionZoneId)) return null;
    }

    // Preferred zone bonus
    if (preferredZones.includes(positionZoneId)) score += 30;

    // Valid zone score (vs generic valid-everywhere)
    if (hasZoneData && validZones.includes(positionZoneId)) score += 20;

    // Angle proximity (lower distance = higher score)
    if (perspectiveAngle != null && anim.angleIndex != null) {
      const dist = _angleDistance(perspectiveAngle, anim.angleIndex);
      score -= dist * 10; // 0–40 penalty
    }

    // Legacy animations (no zone constraints) are fine but deprioritized slightly
    if (anim.legacy) score -= 5;

    return { anim, score };
  }).filter(Boolean);

  if (!scored.length) return null;

  // Sort descending by score; on tie, prefer lower angleDistance
  scored.sort((a, b) => b.score - a.score);
  return scored[0].anim;
}

/**
 * Return all valid animations for a zone, sorted by score.
 * Useful for building a filtered list in the UI.
 */
function listValidForZone(availableAnims, positionZoneId, perspectiveAngle) {
  if (!availableAnims?.length) return [];
  return availableAnims.map(anim => {
    const blockedZones = anim.blockedZones ?? [];
    if (blockedZones.includes(positionZoneId)) return null;

    let score = 0;
    const preferredZones = anim.preferredZones ?? [];
    const validZones = anim.validZones ?? [];
    if (preferredZones.includes(positionZoneId)) score += 30;
    if (validZones.includes(positionZoneId)) score += 20;
    if (perspectiveAngle != null && anim.angleIndex != null) {
      score -= _angleDistance(perspectiveAngle, anim.angleIndex) * 10;
    }
    return { anim, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).map(x => x.anim);
}

if (typeof module !== 'undefined') module.exports = { resolveAnimation, listValidForZone };
