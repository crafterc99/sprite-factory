/**
 * PromptModule — typed prompt blocks for the composition pipeline.
 *
 * Each module targets one concern in the pipeline:
 *   identity  → character lock (who)
 *   base      → generic motion structure (what action)
 *   variant   → specific move details only (dribble-low vs dribble-high)
 *   angle     → camera direction (from where)
 *   outfit    → clothing rules (wearing what)
 *   style     → pixel / render rules (how it looks)
 *   post      → cleanup, corrections, size anchoring (final polish)
 *
 * Identity is a singleton — injected once at runtime, never repeated per module.
 * Variants are NOT full prompts — they only add movement constraints on top of base.
 */

'use strict';

const MODULE_TYPES = ['identity', 'base', 'variant', 'angle', 'outfit', 'style', 'post'];

/**
 * Create a validated module object.
 * @param {object} data
 * @returns {object}
 */
function createModule(data) {
  if (!data.id) throw new Error('Module requires id');
  if (!MODULE_TYPES.includes(data.type)) throw new Error(`Invalid module type: ${data.type}. Must be one of: ${MODULE_TYPES.join(', ')}`);

  return {
    id: String(data.id),
    type: data.type,
    title: String(data.title || data.id),
    content: String(data.content || ''),
    enabled: data.enabled !== false,
    order: typeof data.order === 'number' ? data.order : 50,
    // Optional scoping — if set, module only applies to specific animation or angle
    animationId: data.animationId || null,
    angleId: data.angleId || null,
    // Metadata
    isDefault: data.isDefault === true,
    isCustom: data.isCustom === true,
    updatedAt: data.updatedAt || null,
  };
}

/**
 * The canonical default module library.
 * These ship with the system and represent the migrated form of the original PROMPT_SECTIONS.
 * Grouped by type, ordered by their pipeline position.
 */
const DEFAULT_MODULES = [

  // ── IDENTITY (order 10) ───────────────────────────────────────────────
  createModule({
    id: 'identity-char',
    type: 'identity',
    title: 'Character Lock',
    order: 10,
    isDefault: true,
    content: [
      'CHARACTER IDENTITY: Use Image 2 as the sole character reference.',
      '- Match their exact face, skin tone, hairstyle, body proportions, outfit, colors, and shoes in every frame',
      '- Do NOT alter their appearance, lighten/darken their skin, or change clothing between frames',
      '- Every frame is the same person — treat Image 2 as an identity anchor, not a pose reference',
    ].join('\n'),
  }),

  // ── BASE (order 20-29) ────────────────────────────────────────────────
  createModule({
    id: 'base-pose-transfer',
    type: 'base',
    title: 'Pose Transfer',
    order: 20,
    isDefault: true,
    content: [
      'POSE TRANSFER: REPLICATE Image 1 EXACTLY.',
      'Keep every body position, pose, limb placement, and composition identical.',
      'ONLY replace the character\'s identity and appearance with Image 2.',
      '',
      'Image 1 is the motion reference — treat it as motion-capture data.',
      'Copy it frame-for-frame: same poses, same spacing, same layout.',
    ].join('\n'),
  }),

  createModule({
    id: 'base-body-rules',
    type: 'base',
    title: 'Body Position Rules',
    order: 25,
    isDefault: true,
    content: [
      'BODY POSITION RULES:',
      '- Match Image 1\'s body pose EXACTLY — same arm angles, leg positions, weight distribution',
      '- Treat Image 1 as motion capture — do NOT reinterpret or improve the poses',
      '- Copy the exact body angle, lean, and center of gravity',
      '- Same ball position and hand placement in each frame',
      '- Do NOT add or remove frames — output exactly the number shown in Image 1',
    ].join('\n'),
  }),

  createModule({
    id: 'base-text-only',
    type: 'base',
    title: 'Text-Only Generation',
    order: 21,
    enabled: false,   // disabled by default — activated when no pose reference exists
    isDefault: true,
    content: [
      'TASK: Generate a {{frames}}-frame horizontal sprite strip showing this character performing: {{animation_type}}',
      '',
      'ANIMATION BREAKDOWN (one pose per frame, left to right):',
      '{{frame_breakdown}}',
    ].join('\n'),
  }),

  // ── VARIANT (order 30-39) ─────────────────────────────────────────────
  // Variants are sparse — only define what's unique about this specific move.
  // Everything else flows from base + identity.

  createModule({
    id: 'variant-static-dribble',
    type: 'variant',
    title: 'Static Dribble',
    order: 30,
    animationId: 'static-dribble',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Stationary Dribble:',
      '- 6-frame loop: ball bouncing at right side while standing in place',
      '- Ball path: hip → pushing down → ground contact → rising → waist height → back to hip',
      '- Knees stay bent throughout; slight body bob on frames 3–4',
      '- Feet planted — this is NOT a running dribble',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-dribble-run',
    type: 'variant',
    title: 'Running Dribble',
    order: 30,
    animationId: 'dribble',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Running Dribble:',
      '- 8-frame loop: full run cycle with ball',
      '- Ball alternates high (right foot forward) → low (left foot forward)',
      '- Body leans forward into stride; weight shifts with each step',
      '- Ball stays at dribbling side — never crosses body',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-jumpshot',
    type: 'variant',
    title: 'Jump Shot',
    order: 30,
    animationId: 'jumpshot',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Jump Shot:',
      '- 7-frame sequence: gather → rise → peak → cock → release → follow-through → land',
      '- Ball moves from chest → overhead → cocked → released → gone after frame 5',
      '- Body goes from low crouch to fully extended at peak',
      '- Follow-through: shooting arm fully extended, wrist snapped downward',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-crossover',
    type: 'variant',
    title: 'Crossover',
    order: 30,
    animationId: 'crossover',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Crossover Dribble:',
      '- 4-frame move: right hand → crossing low → left hand → explosion past',
      '- Ball crosses at knee height or below — low and quick',
      '- Hips drive in opposite direction after crossover (sell the fake)',
      '- Frame 4: explosive push into new direction with ball in left hand',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-stepback',
    type: 'variant',
    title: 'Stepback',
    order: 30,
    animationId: 'stepback',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Stepback Jumper:',
      '- 4-frame move: dribbling forward → hard plant → step back creating space → fading shot',
      '- Key: frame 2 plant foot is aggressive — sudden direction reversal',
      '- Frame 3: clear separation from defender, ball in both hands ready to shoot',
      '- Frame 4: body fading backward, feet leaving ground, arms rising to shoot',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-defense-backpedal',
    type: 'variant',
    title: 'Defense Backpedal',
    order: 30,
    animationId: 'defense-backpedal',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Defensive Backpedal:',
      '- 4-frame loop: wide stance → right step back → left slide → reset stance',
      '- Arms stay spread LOW — active hands at waist height',
      '- Low center of gravity throughout — knees bent, hips back',
      '- NO basketball — this is defensive movement only',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-defense-shuffle',
    type: 'variant',
    title: 'Defensive Shuffle',
    order: 30,
    animationId: 'defense-shuffle',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Defensive Lateral Shuffle:',
      '- 2-frame loop: wide athletic stance → weight shifted mid-shuffle',
      '- Arms spread wide and low — active defensive hands',
      '- Knees deeply bent, eyes forward, hips square',
      '- Feet never cross — pure lateral slide movement',
    ].join('\n'),
  }),

  createModule({
    id: 'variant-steal',
    type: 'variant',
    title: 'Steal Attempt',
    order: 30,
    animationId: 'steal',
    isDefault: true,
    content: [
      'ANIMATION SPECIFICS — Steal Attempt:',
      '- 3-frame sequence: defensive ready → lunging reach → full extension',
      '- Frame 2: explosive forward lunge, one arm fully extended toward ball',
      '- Frame 3: arm at maximum reach, body extended off-balance from effort',
      '- Urgency in the motion — this is a risky reach, not a casual swipe',
    ].join('\n'),
  }),

  // ── ANGLE (order 40) ──────────────────────────────────────────────────
  createModule({
    id: 'angle-default',
    type: 'angle',
    title: 'Standard 3/4 View',
    order: 40,
    isDefault: true,
    content: [
      'CAMERA ANGLE: 3/4 front view — character faces slightly right and forward.',
      'This angle is consistent across all frames.',
      'Do not rotate or shift the camera angle between frames.',
    ].join('\n'),
  }),

  createModule({
    id: 'angle-side-profile',
    type: 'angle',
    title: 'Side Profile',
    order: 40,
    enabled: false,
    isDefault: true,
    content: [
      'CAMERA ANGLE: Pure side profile — character faces exactly left.',
      'This is used for run, walk, and sprint animations.',
      'Consistent left-facing profile across all frames.',
    ].join('\n'),
  }),

  createModule({
    id: 'angle-front-facing',
    type: 'angle',
    title: 'Front Facing',
    order: 40,
    enabled: false,
    isDefault: true,
    content: [
      'CAMERA ANGLE: Full front-facing view — character faces the camera directly.',
      'Used for idle and stationary animations.',
      'Maintain this exact orientation in every frame.',
    ].join('\n'),
  }),

  // ── OUTFIT (order 50) ─────────────────────────────────────────────────
  createModule({
    id: 'outfit-reference',
    type: 'outfit',
    title: 'Outfit Lock from Reference',
    order: 50,
    isDefault: true,
    content: [
      'OUTFIT: Replicate exact clothing from Image 2 in every frame.',
      '- Same jersey, shorts, shoes, accessories — no changes',
      '- Same clothing colors and team colors',
      '- If a seam, pattern, or number is visible, keep it consistent',
      '- Do NOT simplify or redesign the outfit',
    ].join('\n'),
  }),

  // ── STYLE (order 60) ──────────────────────────────────────────────────
  createModule({
    id: 'style-16bit-strip',
    type: 'style',
    title: '16-bit Strip Output',
    order: 60,
    isDefault: true,
    content: [
      'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines around the character.',
      'OUTPUT: Single horizontal strip, EXACTLY {{frames}} equally-sized frames, no gaps, no borders.',
      'BACKGROUND: Solid bright green (#00FF00) — NO green on the character, NO anti-aliasing, NO gradients.',
      'Characters must be LARGE — fill most of each frame.',
    ].join('\n'),
  }),

  createModule({
    id: 'style-16bit-single',
    type: 'style',
    title: '16-bit Single Frame',
    order: 60,
    enabled: false,
    isDefault: true,
    content: [
      'STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines.',
      'OUTPUT: Single character frame — NOT a strip, ONE frame only.',
      'BACKGROUND: Solid green (#00FF00), NO green on character, NO anti-aliasing.',
    ].join('\n'),
  }),

  // ── POST-PROCESSING (order 70) ────────────────────────────────────────
  createModule({
    id: 'post-size-anchoring',
    type: 'post',
    title: 'Size Anchoring',
    order: 70,
    isDefault: true,
    content: [
      'SIZE CONSISTENCY:',
      '- Same character size in every frame — locked proportions',
      '- Feet on the same baseline across all frames',
      '- Character fills ~85% of frame height',
      '- Do NOT stretch, squash, or resize the character between frames',
    ].join('\n'),
  }),

  createModule({
    id: 'post-ball-size',
    type: 'post',
    title: 'Ball Size Lock',
    order: 75,
    enabled: false, // enabled per-animation when ball is present
    isDefault: true,
    content: [
      'BALL SIZE: Basketball must be proportional to character (~12px diameter relative to character height).',
      'Ball size stays consistent across frames — do NOT vary it.',
      'Ball is an NBA regulation basketball — orange with black seams.',
    ].join('\n'),
  }),

  createModule({
    id: 'post-frame-count',
    type: 'post',
    title: 'Frame Count Lock',
    order: 72,
    isDefault: true,
    content: [
      'FRAME COUNT: Output EXACTLY {{frames}} frames — no more, no fewer.',
      'Each frame must be equally sized. Do not add blank frames.',
      'Read frames LEFT TO RIGHT from Image 1.',
    ].join('\n'),
  }),

];

/**
 * Get a module from the default library by id.
 */
function getDefaultModule(id) {
  return DEFAULT_MODULES.find(m => m.id === id) || null;
}

/**
 * Get all default modules of a specific type.
 */
function getDefaultModulesByType(type) {
  return DEFAULT_MODULES.filter(m => m.type === type);
}

/**
 * Get the default pipeline for an animation — filters to relevant modules only.
 * Returns the base set of modules that apply to this animation.
 * @param {string} animationId
 * @param {boolean} hasBall - whether this animation includes a basketball
 * @param {boolean} hasPoseRef - whether a pose reference image exists
 */
function getDefaultPipeline(animationId, { hasBall = false, hasPoseRef = true } = {}) {
  return DEFAULT_MODULES
    .filter(m => {
      // Exclude modules scoped to OTHER animations
      if (m.animationId && m.animationId !== animationId) return false;

      // Variant: only include if it matches this animation, or if it's not animation-specific
      if (m.type === 'variant' && m.animationId !== animationId) return false;

      // If no pose reference, disable pose-transfer base and enable text-only
      if (m.id === 'base-pose-transfer' && !hasPoseRef) return false;
      if (m.id === 'base-text-only' && hasPoseRef) return false;

      // Enable ball-size module only when ball is in animation
      if (m.id === 'post-ball-size' && !hasBall) return false;

      return true;
    })
    .map(m => ({
      ...m,
      // Activate text-only base when no pose ref
      enabled: m.id === 'base-text-only' ? !hasPoseRef : m.enabled,
    }));
}

module.exports = {
  MODULE_TYPES,
  DEFAULT_MODULES,
  createModule,
  getDefaultModule,
  getDefaultModulesByType,
  getDefaultPipeline,
};
