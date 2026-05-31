'use strict';
/**
 * CourtPreset.js — Court asset registry and preset management.
 * Dual-environment: browser globals + Node module exports.
 */

const DEFAULT_PRESET = {
  id: 'default',
  name: 'Main Court',
  courtImage: '/assets/court.webp',
  hoopImage: null,
  foregroundImage: null,
  canvasW: 960,
  canvasH: 640,
  rimAnchor: { x: 480, y: 185 },
  polygonZones: {
    'paint': [
      { x: 380, y: 178 }, { x: 580, y: 178 },
      { x: 600, y: 400 }, { x: 360, y: 400 }
    ],
    '3pt-left': [
      { x: 88,  y: 175 }, { x: 380, y: 178 },
      { x: 360, y: 400 }, { x: 88,  y: 465 }
    ],
    '3pt-right': [
      { x: 580, y: 178 }, { x: 955, y: 175 },
      { x: 955, y: 465 }, { x: 600, y: 400 }
    ],
    'mid-range': [
      { x: 88,  y: 465 }, { x: 360, y: 400 },
      { x: 600, y: 400 }, { x: 955, y: 465 },
      { x: 955, y: 530 }, { x: 88,  y: 530 }
    ],
    'backcourt': [
      { x: 88,  y: 530 }, { x: 955, y: 530 },
      { x: 955, y: 628 }, { x: 88,  y: 628 }
    ]
  }
};

if (typeof window !== 'undefined') {
  window.COURT_PRESET_DEFAULT = DEFAULT_PRESET;
}

/**
 * Fetch a court preset from the server by ID.
 * Falls back to DEFAULT_PRESET on error.
 * @param {string} presetId
 * @returns {Promise<object>}
 */
async function loadCourtPreset(presetId) {
  try {
    const r = await fetch(`/api/court-presets/${encodeURIComponent(presetId)}`);
    if (!r.ok) return JSON.parse(JSON.stringify(DEFAULT_PRESET));
    return await r.json();
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PRESET));
  }
}

/**
 * List all available court presets from the server.
 * @returns {Promise<object[]>}
 */
async function listCourtPresets() {
  try {
    const r = await fetch('/api/court-presets');
    if (!r.ok) return [JSON.parse(JSON.stringify(DEFAULT_PRESET))];
    const d = await r.json();
    return d.presets ?? [JSON.parse(JSON.stringify(DEFAULT_PRESET))];
  } catch {
    return [JSON.parse(JSON.stringify(DEFAULT_PRESET))];
  }
}

/**
 * Persist a court preset to the server.
 * @param {object} preset
 * @returns {Promise<void>}
 */
async function saveCourtPreset(preset) {
  try {
    await fetch(`/api/court-presets/${encodeURIComponent(preset.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preset),
    });
  } catch {}
}

/**
 * Apply a preset to the TESTING state object.
 * Reloads court + hoop images; updates polygonZones + rimAnchor.
 * @param {object} preset
 * @param {object} TESTING
 */
function applyPresetToTESTING(preset, TESTING) {
  TESTING.courtPreset = preset;

  // Keep direction overlay net synced to rim anchor
  if (preset.rimAnchor && TESTING.dirConfig) {
    TESTING.dirConfig.net = { x: preset.rimAnchor.x, y: preset.rimAnchor.y };
  }

  if (preset.courtImage) {
    TESTING.courtImg = new Image();
    TESTING.courtLoaded = false;
    TESTING.courtImg.onload = () => { TESTING.courtLoaded = true; };
    TESTING.courtImg.src = preset.courtImage;
  }

  if (preset.foregroundImage) {
    TESTING.hoopImg = new Image();
    TESTING.hoopLoaded = false;
    TESTING.hoopImg.onload = () => { TESTING.hoopLoaded = true; };
    TESTING.hoopImg.src = preset.foregroundImage;
  } else {
    TESTING.hoopImg = null;
    TESTING.hoopLoaded = false;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { loadCourtPreset, listCourtPresets, saveCourtPreset, applyPresetToTESTING, DEFAULT_PRESET };
}
