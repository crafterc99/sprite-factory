/**
 * PromptState — shared context object injected into every module at build time.
 *
 * Module content can reference any state property with {{variable}} syntax.
 * The state is immutable per generation call — set once, interpolated into all modules.
 *
 * Future extensions: video_reference, motion_input, batch_angles, etc.
 */

'use strict';

const BALL_ANIMATIONS = new Set([
  'static-dribble', 'dribble', 'idle-dribble', 'idle_ball',
  'jumpshot', 'stepback', 'crossover', 'steal',
]);

/**
 * Build a PromptState from generation context.
 *
 * @param {object} ctx
 * @param {string} ctx.character_name     - e.g. '99', 'breezy'
 * @param {string} ctx.animation_type     - e.g. 'static-dribble', 'jumpshot'
 * @param {string} ctx.angle              - e.g. 'default', 'side-profile', 'front'
 * @param {string} ctx.outfit             - e.g. 'reference', 'custom'
 * @param {string} ctx.style              - e.g. '16bit-gba', 'custom'
 * @param {number} ctx.frames             - total frames in animation
 * @param {number} ctx.fps                - frames per second
 * @param {string} ctx.mode               - 'strip' | 'fbf'
 * @param {number|null} ctx.frameIndex    - current frame (FBF mode only)
 * @param {string|null} ctx.frame_breakdown - animation frame descriptions
 * @param {string|null} ctx.character_description - character appearance text
 * @param {boolean} ctx.has_ball          - whether animation includes basketball
 * @param {boolean} ctx.has_pose_ref      - whether a pose reference image exists
 * @param {string|null} ctx.video_reference - future: video input path
 * @param {string|null} ctx.motion_input  - future: motion data path
 */
function buildState(ctx = {}) {
  const animId = ctx.animation_type || '';
  const hasBall = ctx.has_ball !== undefined ? ctx.has_ball : BALL_ANIMATIONS.has(animId);

  return {
    character_name: ctx.character_name || '99',
    animation_type: animId,
    angle: ctx.angle || 'default',
    outfit: ctx.outfit || 'reference',
    style: ctx.style || '16bit-gba',
    frames: ctx.frames || 6,
    fps: ctx.fps || 8,
    mode: ctx.mode || 'strip',
    frame_index: ctx.frameIndex != null ? ctx.frameIndex : null,
    frame_breakdown: ctx.frame_breakdown || '',
    character_description: ctx.character_description || 'the character shown in Image 2',
    has_ball: hasBall,
    has_pose_ref: ctx.has_pose_ref !== undefined ? ctx.has_pose_ref : true,
    // Future support
    video_reference: ctx.video_reference || null,
    motion_input: ctx.motion_input || null,
    batch_angles: ctx.batch_angles || null,
  };
}

/**
 * Interpolate {{variable}} tokens in a string using state values.
 * Unknown tokens are left as-is.
 */
function interpolate(text, state) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = state[key];
    return val !== null && val !== undefined ? String(val) : match;
  });
}

module.exports = { buildState, interpolate, BALL_ANIMATIONS };
