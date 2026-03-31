/**
 * PromptRenderer — bridges the pipeline system with the existing sprite generator.
 *
 * Responsibilities:
 *  1. Load active pipeline for a given (character, animation) context
 *  2. Apply saved overrides from disk on top of defaults
 *  3. Expose buildFromPipeline() as a drop-in replacement for buildSectionedPrompt()
 *  4. Persist pipeline configurations to data/.prompt-pipelines.json
 *
 * Backward compat: falls back to legacy buildSectionedPrompt() if no pipeline defined.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { getDefaultPipeline, createModule, DEFAULT_MODULES } = require('./PromptModule');
const { buildState, BALL_ANIMATIONS } = require('./PromptState');
const { buildFinalPrompt, validatePipeline, getPipelineSummary } = require('./PromptPipeline');

const PIPELINES_FILE = path.resolve(__dirname, '../data/.prompt-pipelines.json');

// ─── Persistence ───────────────────────────────────────────────────────────

function loadPipelines() {
  if (!fs.existsSync(PIPELINES_FILE)) return { overrides: {}, customModules: [] };
  try {
    return JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf8'));
  } catch {
    return { overrides: {}, customModules: [] };
  }
}

function savePipelines(data) {
  const dir = path.dirname(PIPELINES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PIPELINES_FILE, JSON.stringify(data, null, 2));
}

// ─── Pipeline Resolution ───────────────────────────────────────────────────

/**
 * Get the active pipeline for a given animation context.
 * Merges defaults with any saved overrides.
 *
 * @param {string} animationId   - animation name (e.g. 'static-dribble')
 * @param {object} animData      - animation definition from ANIMATIONS
 * @returns {object[]}           - ordered array of PromptModule objects
 */
function getActivePipeline(animationId, animData = {}) {
  const hasBall = BALL_ANIMATIONS.has(animationId);
  const hasPoseRef = !!animData.breezyFile;

  // Get defaults filtered for this animation
  const defaults = getDefaultPipeline(animationId, { hasBall, hasPoseRef });

  // Load saved overrides
  const store = loadPipelines();
  const overrides = store.overrides[animationId] || {};

  // Apply overrides: { moduleId: { enabled, content, order } }
  const pipeline = defaults.map(mod => {
    const ov = overrides[mod.id];
    if (!ov) return mod;
    return {
      ...mod,
      ...(ov.enabled !== undefined ? { enabled: ov.enabled } : {}),
      ...(ov.content !== undefined ? { content: ov.content, isCustom: true } : {}),
      ...(ov.order !== undefined ? { order: ov.order } : {}),
      ...(ov.title !== undefined ? { title: ov.title } : {}),
    };
  });

  // Add any custom modules saved for this animation
  const customMods = (store.customModules || []).filter(m => m.animationId === animationId || m.animationId === null);
  for (const cm of customMods) {
    pipeline.push(createModule({ ...cm, isCustom: true }));
  }

  return pipeline;
}

// ─── Save Operations ───────────────────────────────────────────────────────

/**
 * Save a module override for a specific animation.
 * @param {string} animationId
 * @param {string} moduleId
 * @param {object} patch  - { enabled?, content?, order?, title? }
 */
function saveModuleOverride(animationId, moduleId, patch) {
  const store = loadPipelines();
  if (!store.overrides[animationId]) store.overrides[animationId] = {};
  const existing = store.overrides[animationId][moduleId] || {};
  store.overrides[animationId][moduleId] = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  savePipelines(store);
}

/**
 * Clear all overrides for a module, reverting to default.
 */
function clearModuleOverride(animationId, moduleId) {
  const store = loadPipelines();
  if (store.overrides[animationId]) {
    delete store.overrides[animationId][moduleId];
    if (Object.keys(store.overrides[animationId]).length === 0) {
      delete store.overrides[animationId];
    }
  }
  savePipelines(store);
}

/**
 * Save an entirely custom module (not in the default library).
 */
function saveCustomModule(module) {
  const store = loadPipelines();
  if (!store.customModules) store.customModules = [];
  const idx = store.customModules.findIndex(m => m.id === module.id);
  if (idx >= 0) {
    store.customModules[idx] = { ...module, updatedAt: new Date().toISOString() };
  } else {
    store.customModules.push({ ...module, updatedAt: new Date().toISOString() });
  }
  savePipelines(store);
}

/**
 * Delete a custom module.
 */
function deleteCustomModule(moduleId) {
  const store = loadPipelines();
  store.customModules = (store.customModules || []).filter(m => m.id !== moduleId);
  savePipelines(store);
}

// ─── Main Build Entry Point ────────────────────────────────────────────────

/**
 * Build the final prompt for a generation call using the pipeline system.
 * This is the primary entry point — replaces buildSectionedPrompt for new calls.
 *
 * @param {string} characterName
 * @param {string} animationId
 * @param {object} animData       - from ANIMATIONS[animationId]
 * @param {object} charData       - from CHARACTERS[characterName]
 * @param {object} opts
 * @param {number} opts.frameIndex     - for FBF mode
 * @param {number} opts.totalFrames
 * @param {string} opts.mode           - 'strip' | 'fbf'
 * @param {object} opts.moduleOverrides - inline module overrides from request
 * @returns {string}
 */
function buildFromPipeline(characterName, animationId, animData, charData, opts = {}) {
  const pipeline = getActivePipeline(animationId, animData);

  // Apply any inline overrides from the request
  const resolvedPipeline = opts.moduleOverrides
    ? applyInlineOverrides(pipeline, opts.moduleOverrides)
    : pipeline;

  const state = buildState({
    character_name: characterName,
    animation_type: animData.action || animationId,
    frames: opts.totalFrames || animData.frames || 6,
    fps: animData.fps || 8,
    mode: opts.mode || 'strip',
    frameIndex: opts.frameIndex,
    frame_breakdown: animData.frameBreakdown || '',
    character_description: charData?.description || 'the character shown in Image 2',
    has_pose_ref: !!animData.breezyFile,
    video_reference: opts.video_reference || null,
  });

  return buildFinalPrompt(resolvedPipeline, state);
}

/**
 * Apply inline module overrides from a UI request without persisting.
 */
function applyInlineOverrides(pipeline, overrides) {
  return pipeline.map(mod => {
    const ov = overrides[mod.id];
    if (!ov) return mod;
    return {
      ...mod,
      ...(ov.enabled !== undefined ? { enabled: ov.enabled } : {}),
      ...(ov.content !== undefined ? { content: ov.content } : {}),
      ...(ov.order !== undefined ? { order: ov.order } : {}),
    };
  });
}

// ─── UI Data Helpers ───────────────────────────────────────────────────────

/**
 * Get pipeline data formatted for the UI.
 * Returns modules with their current content + override status.
 */
function getPipelineForUI(animationId, animData = {}) {
  const pipeline = getActivePipeline(animationId, animData);
  const sorted = [...pipeline].sort((a, b) => a.order - b.order);

  const { valid, warnings } = validatePipeline(sorted);
  const summary = getPipelineSummary(sorted);

  return {
    animationId,
    modules: sorted,
    summary,
    valid,
    warnings,
    hasCustom: sorted.some(m => m.isCustom),
  };
}

/**
 * Get all available modules from the default library, grouped by type.
 * Used to populate the module library panel.
 */
function getModuleLibrary() {
  const library = {};
  for (const mod of DEFAULT_MODULES) {
    if (!library[mod.type]) library[mod.type] = [];
    library[mod.type].push(mod);
  }

  // Add any saved custom modules
  const store = loadPipelines();
  for (const cm of (store.customModules || [])) {
    if (!library[cm.type]) library[cm.type] = [];
    library[cm.type].push({ ...cm, isCustom: true });
  }

  return library;
}

module.exports = {
  getActivePipeline,
  buildFromPipeline,
  getPipelineForUI,
  getModuleLibrary,
  saveModuleOverride,
  clearModuleOverride,
  saveCustomModule,
  deleteCustomModule,
  loadPipelines,
};
