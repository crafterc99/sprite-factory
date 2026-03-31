/**
 * PromptPipeline — core composition engine.
 *
 * Takes an ordered array of PromptModules + a PromptState and
 * returns a single compiled prompt string.
 *
 * Pipeline contract:
 *   1. Identity is injected once — never duplicated
 *   2. Modules sorted by .order
 *   3. Only enabled modules are included
 *   4. State variables are interpolated into each module's content
 *   5. Output is one contiguous string, sections separated by double newline
 *
 * Future hooks:
 *   - video_reference: prepend a video-as-motion-input preamble
 *   - batch_angles: generate multiple angle variants in parallel
 *   - auto_variants: enumerate all variants for an animation type
 */

'use strict';

const { interpolate } = require('./PromptState');

/**
 * Build the final prompt from modules + state.
 *
 * @param {object[]} modules  - Array of PromptModule objects
 * @param {object}   state    - PromptState from buildState()
 * @returns {string}          - Compiled prompt string
 */
function buildFinalPrompt(modules, state) {
  // 1. Filter enabled modules
  const enabled = modules.filter(m => m.enabled !== false);

  // 2. Deduplicate identity — only keep the first identity module
  const seen = new Set();
  const deduped = enabled.filter(m => {
    if (m.type === 'identity') {
      if (seen.has('identity')) return false;
      seen.add('identity');
    }
    return true;
  });

  // 3. Sort by order
  const sorted = [...deduped].sort((a, b) => a.order - b.order);

  // 4. Inject video reference preamble if present (future support)
  const parts = [];
  if (state.video_reference) {
    parts.push(buildVideoPreamble(state));
  }

  // 5. Interpolate state into each module's content
  for (const module of sorted) {
    const text = interpolate(module.content, state).trim();
    if (text) parts.push(text);
  }

  return parts.join('\n\n');
}

/**
 * Validate a pipeline — check for required module types and warn about missing ones.
 * Returns { valid: bool, warnings: string[] }
 */
function validatePipeline(modules) {
  const warnings = [];
  const enabledTypes = new Set(modules.filter(m => m.enabled).map(m => m.type));

  const required = ['identity', 'base', 'style'];
  for (const type of required) {
    if (!enabledTypes.has(type)) {
      warnings.push(`Missing required module type: "${type}"`);
    }
  }

  if (!enabledTypes.has('variant')) {
    warnings.push('No variant module active — animation specifics may be generic');
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Get the pipeline summary — list of enabled modules in order with types.
 */
function getPipelineSummary(modules) {
  return modules
    .filter(m => m.enabled)
    .sort((a, b) => a.order - b.order)
    .map(m => ({ id: m.id, type: m.type, title: m.title, order: m.order }));
}

/**
 * Build a video-as-motion-input preamble (future support hook).
 * When video_reference is set, prepend instructions for treating video as motion data.
 */
function buildVideoPreamble(state) {
  return [
    'VIDEO MOTION INPUT: The reference images are extracted frames from a real video.',
    `Animation: ${state.animation_type}`,
    'Treat these frames as motion-capture data — extract the exact body movement and replicate it in pixel art.',
  ].join('\n');
}

/**
 * Auto-generate pipeline variants for batch angle generation (future support).
 * Returns one pipeline per angle, each with the angle module swapped.
 */
function buildAngleBatch(basePipeline, angles) {
  return angles.map(angleId => {
    const withAngle = basePipeline.map(m => {
      if (m.type === 'angle') {
        return { ...m, enabled: m.id === `angle-${angleId}` };
      }
      return m;
    });
    return { angleId, pipeline: withAngle };
  });
}

module.exports = { buildFinalPrompt, validatePipeline, getPipelineSummary, buildAngleBatch };
