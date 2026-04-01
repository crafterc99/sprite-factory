/**
 * Sprite Prompt System — Strict Pose Transfer + Prompt Training
 *
 * Two prompt modes:
 * 1. POSE TRANSFER (primary): Image 1 = pose ref, Image 2 = character ref
 *    Recreates Image 1 exactly but replaces character with Image 2
 * 2. TEXT-ONLY: No reference images, pure prompt-based generation
 *
 * Prompts are trainable — feedback adjusts prompt templates over time.
 */
const fs = require('fs');
const path = require('path');

const TRAINING_FILE = path.resolve(__dirname, '../../.training-data/prompt-training.json');

const CHARACTERS = {
  breezy: {
    description: 'a female basketball player with brown skin, long dark braids, athletic build — wearing a white JMU jersey (#11) with pink/magenta trim, white shorts with pink trim, purple sneakers — smiling expression, 16-bit pixel art style',
    style: '16-bit pixel art, GBA style',
    heightInches: 72, weightLbs: 185, build: 'athletic',
    jerseyNumber: '11', teamColors: { primary: '#FFFFFF', secondary: '#CC44AA', accent: '#6633CC' },
  },
  '99': {
    description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
    style: '16-bit pixel art, GBA style',
    heightInches: 72, weightLbs: 185, build: 'athletic',
    jerseyNumber: '99', teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
  },
};

const ANIMATIONS = {
  'idle': {
    frames: 4, fps: 6, loop: true,
    action: 'standing idle, subtle weight shift and breathing',
    frameBreakdown: '(1) neutral upright stance, weight centered, arms relaxed at sides (2) slight weight shift to right foot, right shoulder dips slightly (3) back to center, minimal movement, knees soft (4) slight weight shift to left foot, left shoulder dips slightly',
    angleIndex: 0, // front
  },
  'walk': {
    frames: 8, fps: 10, loop: true,
    action: 'standard walk cycle, no basketball',
    frameBreakdown: '(1) right foot heel strike, left arm forward (2) right foot flat, weight transferring (3) right foot toe push-off, body rising (4) both feet briefly off ground, mid-stride (5) left foot heel strike, right arm forward (6) left foot flat, weight transferring (7) left foot toe push-off, body rising (8) both feet briefly off ground completing stride',
    angleIndex: 0,
  },
  'jump': {
    frames: 5, fps: 8, loop: false,
    action: 'vertical jump, no basketball — character leaves the ground and returns',
    frameBreakdown: '(1) deep crouch preparation — knees sharply bent, torso forward, both feet on ground, arms pulled back (2) explosive launch — legs fully extended pushing off ground, arms driving upward, toes leaving floor (3) PEAK of jump — both feet clearly off ground, body at maximum height, arms high, legs slightly tucked (4) descent — body dropping, legs beginning to extend downward toward ground (5) landing — knees bent absorbing impact, both feet on ground, arms out for balance',
    angleIndex: 0,
  },
  'static-dribble': {
    frames: 6, fps: 8, loop: true,
    breezyFile: 'breezy-static-dribble.png',
    action: 'stationary dribble, ball bouncing at side',
    frameBreakdown: '(1) ball at hip right hand (2) pushing ball down (3) ball hitting ground (4) ball bouncing up (5) ball rising to waist (6) ball back at hip, slight body bob on frames 3-4, knees bent',
    angleIndex: 0, // front
  },
  'dribble': {
    frames: 8, fps: 10, loop: true,
    breezyFile: 'breezy-dribble.png',
    action: 'running dribble, full run cycle with basketball',
    frameBreakdown: '(1) right foot forward ball high (2) pushing off ball going down (3) mid-stride ball bouncing (4) left foot forward ball low (5) left foot planted ball rising (6) pushing off left ball up (7) airborne mid-stride (8) right foot landing, body leaning forward',
    angleIndex: 1, // front-3/4-R
  },
  'jumpshot': {
    frames: 7, fps: 8, loop: false,
    breezyFile: 'breezy-jumpshot.png',
    action: 'basketball jump shot sequence',
    frameBreakdown: '(1) crouching ball at chest (2) beginning jump knees extending (3) rising ball overhead (4) peak of jump ball cocked back (5) release point ball leaving hands (6) follow through arm extended (7) landing arms up',
    angleIndex: 0, // front
  },
  'stepback': {
    frames: 4, fps: 8, loop: false,
    breezyFile: 'breezy-stepback.png',
    action: 'stepback jumper creating space',
    frameBreakdown: '(1) dribbling forward (2) planting front foot hard (3) pushing back creating space ball in hands (4) fading back in shooting position',
    angleIndex: 1, // front-3/4-R
  },
  'crossover': {
    frames: 4, fps: 13, loop: false,
    breezyFile: 'breezy-crossover.png',
    action: 'crossover dribble move',
    frameBreakdown: '(1) ball in right hand approaching (2) ball crossing low in front of body (3) ball now in left hand pushing past (4) exploding past with ball in left hand',
    angleIndex: 0, // front
  },
  'defense-backpedal': {
    frames: 4, fps: 8, loop: true,
    breezyFile: 'breezy-defense-backpedal.png',
    action: 'defensive backpedal, no basketball',
    frameBreakdown: '(1) wide stance arms out low (2) right foot stepping back (3) left foot sliding back (4) resetting stance, low center of gravity hands active',
    angleIndex: 4, // back
  },
  'defense-shuffle': {
    frames: 2, fps: 6, loop: true,
    breezyFile: 'breezy-defense-shuffle.png',
    action: 'defensive lateral shuffle, no basketball',
    frameBreakdown: '(1) wide athletic stance arms spread low (2) weight shifted to one side mid-shuffle, knees bent eyes forward',
    angleIndex: 0, // front
  },
  'steal': {
    frames: 3, fps: 8, loop: false,
    breezyFile: 'breezy-steal.png',
    action: 'steal attempt reaching for ball',
    frameBreakdown: '(1) defensive stance ready (2) lunging forward arm reaching out to swipe (3) follow through arm fully extended',
    angleIndex: 0, // front
  },
  'idle_ball': {
    frames: 4, fps: 6, loop: true,
    action: 'standing idle holding basketball, stationary — no dribbling, ball stays in hands',
    frameBreakdown: '(1) upright stance, ball held at hip in right hand, weight centered, knees soft (2) slight weight shift right, ball raised slightly to waist, right elbow out (3) back to neutral, ball lowered, minimal sway (4) slight weight shift left, ball at hip left side, body returning to center',
    angleIndex: 0, // front
  },
  'run': {
    frames: 8, fps: 10, loop: true,
    action: 'full run cycle, no basketball — side-profile view, character faces left',
    frameBreakdown: '(1) right foot heel strike, left arm drives forward, body leaning into stride (2) right foot flat, weight fully on right, left leg swinging (3) right toe push-off, left knee high, body rising slightly (4) airborne — both feet off ground, peak of stride (5) left foot heel strike, right arm forward, body momentum forward (6) left foot flat, right leg swinging past (7) left toe push-off, right knee driving high (8) airborne again — completing full stride cycle',
    angleIndex: 6, // side-L (profile, character faces left)
  },
  'sprint': {
    frames: 6, fps: 12, loop: true,
    action: 'max-speed sprint, no basketball — side-profile, aggressive lean forward',
    frameBreakdown: '(1) aggressive forward lean, right foot strike, arms pumping high (2) explosive push-off right foot, left knee drives up hard (3) fully airborne, maximum stretch — front leg extended, back leg trailing (4) left foot plant, body low, momentum carrying forward (5) explosive push-off left, right knee churning high (6) fully airborne, maximum stretch again — stride at peak extension',
    angleIndex: 6, // side-L
  },
  'stop': {
    frames: 4, fps: 8, loop: false,
    action: 'hard stop from full run — plant both feet and brake sharply',
    frameBreakdown: '(1) full speed, leaning forward mid-stride (2) plant foot hits ground, body still forward from momentum, arms begin to pull back (3) hard brake — both feet planted, knees deeply bent, torso upright, arms out for balance, visible deceleration in posture (4) settled stop — feet set, stance wide, knees bent, weight balanced, ready position',
    angleIndex: 0, // front
  },
  'turn': {
    frames: 4, fps: 8, loop: false,
    action: '180-degree pivot turn while running — character reverses direction',
    frameBreakdown: '(1) running hard, full stride, leaning in original direction (2) plant foot digs in, body begins pivot — torso twisting, arms crossing (3) mid-turn — body 90 degrees from start, hips rotating, head already looking new direction (4) launching into opposite direction — first stride out of turn, explosive push',
    angleIndex: 2, // side-R
  },
  'pivot': {
    frames: 3, fps: 8, loop: false,
    action: 'stationary pivot on one foot — basketball pivot move',
    frameBreakdown: '(1) both feet set, pivot foot (right) planted, ball of foot on ground, left foot raised and ready to step (2) body rotating around pivot foot — left foot swinging through mid-arc, torso twisting, arms out for balance (3) pivot complete — body now facing new direction, pivot foot still anchored, left foot setting down in new stance',
    angleIndex: 0, // front
  },
  'defensive-slide-left': {
    frames: 6, fps: 8, loop: true,
    action: 'lateral defensive shuffle sliding left — low stance, arms wide, feet never crossing',
    frameBreakdown: '(1) starting defensive stance — feet shoulder-width apart, knees deeply bent, arms spread low and wide, weight centered (2) left foot pushes out to the left, body shifting weight leftward, low center of gravity maintained (3) right foot follows, sliding toward left foot — mid-shuffle, feet momentarily closer together (4) left foot pushes out again, reaching maximum lateral extension to the left, deep crouch, arm spread wide (5) right foot continues sliding left, body fully committed to lateral movement, hands active at waist height (6) recovery stance — feet reset to shoulder-width, knees still bent, arms resetting to wide defensive position, ready for next shuffle',
    angleIndex: 0, // front
  },
  'defensive-slide-right': {
    frames: 6, fps: 8, loop: true,
    action: 'lateral defensive shuffle sliding right — low stance, arms wide, feet never crossing',
    frameBreakdown: '(1) starting defensive stance — feet shoulder-width apart, knees deeply bent, arms spread low and wide, weight centered (2) right foot pushes out to the right, body shifting weight rightward, low center of gravity maintained (3) left foot follows, sliding toward right foot — mid-shuffle, feet momentarily closer together (4) right foot pushes out again, reaching maximum lateral extension to the right, deep crouch, arms spread wide (5) left foot continues sliding right, body fully committed to lateral movement, hands active at waist height (6) recovery stance — feet reset to shoulder-width, knees still bent, arms resetting to wide defensive position, ready for next shuffle',
    angleIndex: 0, // front
  },
  'idle-dribble': {
    frames: 6, fps: 8, loop: true,
    action: 'stationary standing dribble — not running, ball bouncing at right side while character stands in place',
    frameBreakdown: '(1) standing upright, ball held at right hip height in right hand, knees slightly bent, left arm relaxed at side (2) right hand pushing ball downward, body dipping slightly with the push, ball below hip (3) ball at its lowest point near the ground, right arm fully extended downward, slight forward lean (4) ball bouncing upward from ground, right hand rising to meet it, body starting to recover upright (5) ball rising to waist height, right hand guiding it up, slight upward body bob (6) ball back at hip height, right hand cradling it loosely, body returning to relaxed standing pose — completing one dribble cycle',
    angleIndex: 0, // front
  },
};

// ─── Structured Prompt Sections ──────────────────────────────────────────

/**
 * Each section defines a toggleable prompt block with a buildDefault function.
 * When frameIndex is provided, builds for single-frame mode (FBF).
 * Otherwise builds for strip mode.
 */
// ANGLE_NAMES for reference — index maps to body angle file suffix
// 0=front, 1=front-3/4-R, 2=side-R, 3=back-3/4-R, 4=back, 5=back-3/4-L, 6=side-L, 7=front-3/4-L
const ANGLE_LABEL_MAP = ['front','front-3/4-R','side-R','back-3/4-R','back','back-3/4-L','side-L','front-3/4-L'];

const PROMPT_SECTIONS = [
  {
    key: 'poseReplication',
    label: 'Pose Replication',
    buildDefault(char, anim, frameIndex, totalFrames) {
      if (frameIndex !== undefined) {
        // FBF mode: Image 1 = character angle ref, Image 2 = pose frame
        return [
          `Keep the exact character from Image 1. Copy only the exact pose from Image 2.`,
          `Do not mix faces or identities. Make sure the character's face does not change at all.`,
          `Do not change body shape, skin tone, hairstyle, or facial structure.`,
          `Match Image 2's full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing.`,
          `Natural anatomy, no distortions.`,
          ``,
          `This is frame ${frameIndex + 1} of ${totalFrames} in a ${anim.action} animation.`,
        ].join('\n');
      }
      // Strip mode: Image 1 = pose strip, Image 2 = character
      return `REPLICATE Image 1 EXACTLY. Keep every body position, pose, limb placement, and composition identical. ONLY replace the character's identity and appearance with Image 2.\n\nImage 1 is a ${anim.frames}-frame sprite sheet. Copy it frame-for-frame — same poses, same spacing, same layout — but with Image 2's character instead.`;
    },
  },
  {
    key: 'imageDescription',
    label: 'Image Description',
    buildDefault(char, anim, frameIndex, totalFrames) {
      const descriptions = parseFrameDescriptions(anim.frameBreakdown);
      if (frameIndex !== undefined) {
        const desc = descriptions[frameIndex] || `frame ${frameIndex + 1} of ${anim.action}`;
        return `Image 2 (pose to copy) shows: ${desc}`;
      }
      return `Animation: ${anim.action}\nFrame breakdown: ${anim.frameBreakdown || 'N/A'}`;
    },
  },
  {
    key: 'bodyPosition',
    label: 'Body Position Rules',
    buildDefault(char, anim, frameIndex) {
      if (frameIndex !== undefined) {
        return [
          'POSE RULES:',
          "- Match Image 2's full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing",
          '- Treat Image 2 as motion capture — do NOT reinterpret',
          '- Copy the exact body angle, lean, and center of gravity from Image 2',
        ].join('\n');
      }
      return [
        'CRITICAL — BODY POSITION:',
        '- The body position, pose, and composition in EVERY frame must match Image 1 EXACTLY',
        '- Same arm positions, same leg positions, same body angle, same weight distribution',
        '- Same ball position and hand placement in each frame',
        '- Do NOT reinterpret the poses — treat Image 1 as motion capture data',
      ].join('\n');
    },
  },
  {
    key: 'characterSwap',
    label: 'Character Identity',
    buildDefault(char, anim, frameIndex) {
      if (frameIndex !== undefined) {
        return [
          'CHARACTER IDENTITY:',
          '- Keep Image 1\'s exact character — do not change face, identity, skin tone, hairstyle, or facial structure',
          '- Do not mix faces or identities between Image 1 and Image 2',
          '- Maintain Image 1\'s exact proportions and clothing colors',
        ].join('\n');
      }
      return [
        'CHARACTER SWAP:',
        '- Replace ONLY the character identity with Image 2 — face, skin tone, hair, outfit',
        "- Keep Image 2's exact appearance, clothing colors, and proportions",
      ].join('\n');
    },
  },
  {
    key: 'outputStyle',
    label: 'Output / Style',
    buildDefault(char, anim, frameIndex) {
      if (frameIndex !== undefined) {
        return [
          `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
          `OUTPUT: Single character, ONE frame only (NOT a strip)`,
          `Background: solid green (#00FF00), NO green on character`,
        ].join('\n');
      }
      return [
        'OUTPUT:',
        `- Single horizontal strip, EXACTLY ${anim.frames} frames, equally-sized, no gaps, no borders`,
        '- Characters must be LARGE and fill most of each frame — not tiny',
        `- Style: ${char.style || '16-bit pixel art, GBA style'}, bold BLACK pixel outlines around the character`,
        '- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds',
        '- NO green (#00FF00) on the character itself',
      ].join('\n');
    },
  },
  {
    key: 'sizeAnchoring',
    label: 'Size Consistency',
    buildDefault(char, anim, frameIndex) {
      // Height-aware sizing: compute fill percentage from character height
      const heightInches = char.heightInches || 72;
      const fillPct = Math.round((111.6 * heightInches / 72) / 180 * 100);
      const ballSize = Math.round(12 * (heightInches / 72)); // proportional ball

      if (frameIndex !== undefined) {
        const lines = [
          'SIZE ANCHORING:',
          `- Character should fill ~${fillPct}% of frame height`,
          '- Lock proportions — do NOT stretch or squash',
          '- Feet on the baseline, consistent ground plane',
        ];
        if (anim.action.includes('dribble') || anim.action.includes('shot') || anim.action.includes('crossover')) {
          lines.push(`- Basketball should be ~${ballSize}px diameter relative to character`);
        }
        return lines.join('\n');
      }
      const lines = [
        `- Same character size in every frame, feet on same baseline`,
        `- Characters should fill ~${fillPct}% of frame height, locked proportions`,
      ];
      if (anim.action.includes('dribble') || anim.action.includes('shot') || anim.action.includes('crossover')) {
        lines.push(`- Basketball should be proportional to character (~${ballSize}px diameter)`);
      }
      return lines.join('\n');
    },
  },
];

/**
 * Build a prompt by merging default sections with custom overrides.
 * customSections: { [key]: { enabled: bool, text: string } }
 */
function buildSectionedPrompt(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);
  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const { frameIndex, totalFrames, customSections } = opts;

  // If a full assembled override exists, use it directly
  if (customSections?.full_assembled?.enabled !== false && customSections?.full_assembled?.text) {
    return customSections.full_assembled.text;
  }

  const parts = [];

  for (const section of PROMPT_SECTIONS) {
    const custom = customSections?.[section.key];
    const enabled = custom ? custom.enabled !== false : true;
    if (!enabled) continue;

    const text = (custom && custom.text != null && custom.text !== '')
      ? custom.text
      : section.buildDefault(char, anim, frameIndex, totalFrames || anim.frames);
    parts.push(text);
  }

  return parts.join('\n\n');
}

/**
 * Return all sections with their default text for the UI to populate.
 */
function getDefaultSections(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}`);
  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}`);

  const { frameIndex, totalFrames } = opts;
  const sections = {};

  for (const section of PROMPT_SECTIONS) {
    sections[section.key] = {
      label: section.label,
      text: section.buildDefault(char, anim, frameIndex, totalFrames || anim.frames),
      enabled: true,
    };
  }

  return sections;
}

// ─── Frame Description Parser ────────────────────────────────────────────

/**
 * Parse "(1) desc (2) desc (3) desc..." into an array of descriptions.
 * Returns ['desc1', 'desc2', ...] indexed from 0.
 */
function parseFrameDescriptions(breakdown) {
  if (!breakdown) return [];
  const matches = breakdown.match(/\(\d+\)\s*([^(]*)/g);
  if (!matches) return [breakdown.trim()];
  return matches.map(m => m.replace(/^\(\d+\)\s*/, '').trim()).filter(Boolean);
}

/**
 * Build a prompt for generating a SINGLE frame (not a strip).
 * Used by the frame-by-frame pipeline for dramatically better quality.
 *
 * @param {string} characterName - Character to generate
 * @param {string} animationName - Animation name (for frame descriptions)
 * @param {number} frameIndex - 0-based frame index
 * @param {number} totalFrames - Total frames in the animation
 */
const UNIVERSAL_FRAME_PROMPT =
`Keep the exact pixelated character from Image 1. Copy only the exact pose and limb/body position from Image 2.
Do not mix faces or identities. make sure the characters face does not change at all.
Do not change body shape, skin tone, hairstyle, or facial structure.
Match Image 2's full-body position exactly: head tilt, shoulders, arms, torso, hips, legs, feet, and camera framing.
natural anatomy, no distortions.
Pure green (#00FF00) background. with correct character angle body depending on the animation angle, and the individual frame thats being replicated.`;

function buildSingleFramePrompt(characterName, animationName, frameIndex, totalFrames) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const descriptions = parseFrameDescriptions(anim.frameBreakdown);
  const frameDesc = descriptions[frameIndex] || `frame ${frameIndex + 1} of ${anim.action}`;

  const prompt = UNIVERSAL_FRAME_PROMPT;

  return {
    prompt,
    frameIndex,
    totalFrames,
    frameDescription: frameDesc,
    animationName,
    characterName,
  };
}

// ─── Strict Pose Transfer Prompt ────────────────────────────────────────

/**
 * Build the strict pose-transfer prompt.
 * This is the primary prompt mode — treats Image 1 as motion-capture reference.
 */
function buildPoseTransferPrompt(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const frames = opts.frames || anim.frames;
  const training = loadTraining();
  const overrides = training.promptOverrides?.[animationName] || {};

  const prompt = [
    `REPLICATE Image 1 EXACTLY. Keep every body position, pose, limb placement, and composition identical. ONLY replace the character's identity and appearance with Image 2.`,
    ``,
    `Image 1 is a ${frames}-frame sprite sheet. Copy it frame-for-frame — same poses, same spacing, same layout — but with Image 2's character instead.`,
    ``,
    `CRITICAL — BODY POSITION:`,
    `- The body position, pose, and composition in EVERY frame must match Image 1 EXACTLY`,
    `- Same arm positions, same leg positions, same body angle, same weight distribution`,
    `- Same ball position and hand placement in each frame`,
    `- Do NOT reinterpret the poses — treat Image 1 as motion capture data`,
    ``,
    `CHARACTER SWAP:`,
    `- Replace ONLY the character identity with Image 2 — face, skin tone, hair, outfit`,
    `- Keep Image 2's exact appearance, clothing colors, and proportions`,
    ``,
    `OUTPUT:`,
    `- Single horizontal strip, EXACTLY ${frames} frames, equally-sized, no gaps, no borders`,
    `- Characters must be LARGE and fill most of each frame — not tiny`,
    `- Style: ${overrides.style || char.style}, bold BLACK pixel outlines around the character`,
    `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
    `- NO green (#00FF00) on the character itself`,
    `- Same character size in every frame, feet on same baseline`,
  ].join('\n');

  return {
    prompt,
    frames,
    fps: anim.fps,
    loop: anim.loop,
    breezyFile: anim.breezyFile,
    outputName: `${characterName}-${animationName}`,
    mode: 'pose-transfer',
  };
}

/**
 * Build a film-to-sprite prompt (real footage → pixel art).
 * Similar to pose transfer but the reference is real video frames.
 */
function buildFilmToSpritePrompt(characterName, animDescription, frameCount, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}`);

  const prompt = [
    `STRICT POSE AND COMPOSITION TRANSFER — FILM TO SPRITE`,
    ``,
    `Use the uploaded images in the following roles:`,
    `Image 1 = real video frame reference strip showing the exact poses to replicate`,
    `Image 2 = character appearance reference`,
    ``,
    `Your task is to convert the real-world poses from Image 1 into a pixel art sprite sheet, using the character from Image 2.`,
    ``,
    `OUTPUT FORMAT: A single horizontal sprite sheet with EXACTLY ${frameCount} equally-sized square frames in a row. Each frame must be the EXACT same width and height.`,
    ``,
    `POSE RULES:`,
    `- Each frame in the output must match the corresponding frame in Image 1`,
    `- Copy the exact body pose, limb positions, and weight distribution`,
    `- The animation shows: ${animDescription}`,
    `- Read the poses LEFT TO RIGHT from Image 1`,
    ``,
    `CHARACTER RULES:`,
    `- Use the character from Image 2: ${char.description}`,
    `- Preserve face, hairstyle, clothing, colors from Image 2`,
    ``,
    `STYLE: ${char.style}, bold BLACK pixel outlines around the character`,
    ``,
    `BACKGROUND: Pure solid green (#00FF00). NO green on the character. NO anti-aliasing, NO gradients, NO shadows.`,
    ``,
    `Consistent character size across all frames, same baseline.`,
  ].join('\n');

  return {
    prompt,
    frames: frameCount,
    outputName: `${characterName}-custom`,
    mode: 'film-to-sprite',
  };
}

/**
 * Build a prompt for generating a SINGLE frame from a video reference frame.
 * Used by the video FBF pipeline — each video frame becomes a pose reference.
 *
 * @param {string} characterName - Character to generate
 * @param {string} animDescription - Description of the animation action
 * @param {number} frameIndex - 0-based frame index
 * @param {number} totalFrames - Total frames in the animation
 */
function buildFilmToSingleFramePrompt(characterName, animDescription, frameIndex, totalFrames) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const prompt = [
    `STRICT POSE TRANSFER — FILM TO SINGLE SPRITE FRAME`,
    ``,
    `Image 1 = real video frame showing the exact pose to replicate`,
    `Image 2 = character appearance reference`,
    ``,
    `This is frame ${frameIndex + 1} of ${totalFrames} in a "${animDescription}" animation.`,
    ``,
    `POSE RULES:`,
    `- Match Image 1's body pose EXACTLY — same arm angles, leg positions, weight distribution`,
    `- Treat Image 1 as motion capture — do NOT reinterpret the pose`,
    `- Copy the exact body angle, lean, and center of gravity`,
    ``,
    `CHARACTER:`,
    `- Use Image 2's face, skin tone, hairstyle, outfit: ${char.description}`,
    `- Maintain Image 2's exact proportions and clothing colors`,
    `- Character should fill ~85% of frame height`,
    ``,
    `STYLE: ${char.style || '16-bit pixel art, GBA style'}, bold BLACK pixel outlines`,
    `OUTPUT: Single character, ONE frame only (NOT a strip)`,
    `Background: solid green (#00FF00), NO green on character`,
    `NO anti-aliasing, NO gradients, NO shadows on background.`,
  ].join('\n');

  return {
    prompt,
    frameIndex,
    totalFrames,
    animDescription,
    characterName,
    mode: 'film-to-single-frame',
  };
}

// ─── Text-Only Animation Prompt ─────────────────────────────────────────

/**
 * Build a prompt for generating an animation strip with NO pose reference.
 * Image 1 = character portrait (identity anchor only — NOT a pose to replicate).
 * Used when anim.breezyFile is absent and no external reference strip is available.
 */
function buildTextOnlyAnimPrompt(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);
  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const frames = opts.frames || anim.frames;
  const heightInches = char.heightInches || 72;
  const fillPct = Math.round((111.6 * heightInches / 72) / 180 * 100);

  const prompt = [
    `IDENTITY REFERENCE: Image 1 shows the exact character to animate. You must match their appearance in every single frame — same face, skin tone, hairstyle, body proportions, outfit, colors, and shoes.`,
    ``,
    `TASK: Generate a ${frames}-frame horizontal sprite strip showing this character performing: ${anim.action}`,
    ``,
    `ANIMATION BREAKDOWN (one pose per frame, left to right):`,
    anim.frameBreakdown,
    ``,
    `CHARACTER (must match Image 1 exactly in every frame):`,
    `- ${char.description}`,
    ``,
    `OUTPUT FORMAT:`,
    `- Single horizontal strip, EXACTLY ${frames} equally-sized square frames in a row`,
    `- Characters must be LARGE — fill most of each frame`,
    `- Style: ${char.style || '16-bit pixel art, GBA style'}, bold BLACK pixel outlines`,
    `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
    `- NO green (#00FF00) on the character itself`,
    `- Same character size in every frame, feet on the same baseline`,
    `- Character should fill ~${fillPct}% of frame height`,
    ``,
    `CRITICAL IDENTITY RULE: The character must look identical to Image 1 across all ${frames} frames. Do NOT change skin tone, hair, outfit, colors, or body proportions between frames. Every frame is the same person.`,
  ].join('\n');

  return {
    prompt,
    frames,
    fps: anim.fps,
    loop: anim.loop,
    outputName: `${characterName}-${animationName}`,
    mode: 'text-only',
  };
}

// ─── Legacy prompt (backward compat) ────────────────────────────────────

function buildPrompt(characterName, animationName, opts = {}) {
  return buildPoseTransferPrompt(characterName, animationName, opts);
}

function buildCustomPrompt(characterName, description, frameCount) {
  return buildFilmToSpritePrompt(characterName, description, frameCount);
}

// ─── Prompt Training System ─────────────────────────────────────────────

function loadTraining() {
  const dir = path.dirname(TRAINING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TRAINING_FILE)) {
    return { promptOverrides: {}, history: [], totalIterations: 0 };
  }
  return JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8'));
}

function saveTraining(data) {
  const dir = path.dirname(TRAINING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRAINING_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record prompt feedback and adjust future prompts.
 *
 * @param {string} animName - Animation that was generated
 * @param {number} rating - 1-5 quality rating
 * @param {string} notes - What was wrong/right
 * @param {object} details - { betterFrameBreakdown, betterStyle, promptUsed }
 */
function trainPrompt(animName, rating, notes, details = {}) {
  const training = loadTraining();

  training.history.push({
    animation: animName,
    rating,
    notes,
    timestamp: new Date().toISOString(),
    promptUsed: details.promptUsed,
  });
  training.totalIterations++;

  // If user provided better descriptions, save as overrides
  if (details.betterFrameBreakdown) {
    if (!training.promptOverrides[animName]) training.promptOverrides[animName] = {};
    training.promptOverrides[animName].frameBreakdown = details.betterFrameBreakdown;
  }
  if (details.betterStyle) {
    if (!training.promptOverrides[animName]) training.promptOverrides[animName] = {};
    training.promptOverrides[animName].style = details.betterStyle;
  }

  saveTraining(training);
  return training;
}

function listAnimations() {
  return Object.entries(ANIMATIONS).map(([name, anim]) => ({
    name, frames: anim.frames, fps: anim.fps, loop: anim.loop,
    hasBreezyRef: !!anim.breezyFile,
  }));
}

// ─── Prompt Override Persistence ─────────────────────────────────────────

const OVERRIDES_FILE = path.resolve(__dirname, '../../data/.prompt-overrides.json');

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) {
    return { sectionOverrides: {}, history: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch {
    return { sectionOverrides: {}, history: [] };
  }
}

function saveOverrides(data) {
  const dir = path.dirname(OVERRIDES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(data, null, 2));
}

function setPromptOverride(promptType, context, section, text) {
  const data = loadOverrides();
  const key = `${promptType}:${context}`;
  if (!data.sectionOverrides[key]) data.sectionOverrides[key] = {};

  const prev = data.sectionOverrides[key][section];
  const previousText = prev ? prev.text : null;

  data.sectionOverrides[key][section] = {
    text,
    updatedAt: new Date().toISOString(),
    isCustom: true,
  };

  data.history.push({
    key,
    section,
    previousText,
    newText: text,
    timestamp: new Date().toISOString(),
  });
  // Cap history at 200 entries
  if (data.history.length > 200) data.history = data.history.slice(-200);

  saveOverrides(data);
  return data;
}

function getPromptOverride(promptType, context, section) {
  const data = loadOverrides();
  const key = `${promptType}:${context}`;
  const entry = data.sectionOverrides[key]?.[section];
  return entry ? entry.text : null;
}

function getOverrideHistory(promptType, context) {
  const data = loadOverrides();
  const key = `${promptType}:${context}`;
  return data.history.filter(h => h.key === key);
}

function clearPromptOverride(promptType, context, section) {
  const data = loadOverrides();
  const key = `${promptType}:${context}`;
  if (data.sectionOverrides[key]) {
    delete data.sectionOverrides[key][section];
    if (Object.keys(data.sectionOverrides[key]).length === 0) {
      delete data.sectionOverrides[key];
    }
  }
  saveOverrides(data);
  return data;
}

/**
 * Get sections with saved overrides merged on top of defaults.
 * Returns a customSections-shaped object ready for buildSectionedPrompt.
 */
function getActiveSections(characterName, animationName, opts = {}) {
  const defaults = getDefaultSections(characterName, animationName, opts);
  const data = loadOverrides();
  const mode = opts.frameIndex !== undefined ? 'fbf' : 'strip';
  const key = `${mode}:${animationName}`;
  const overrides = data.sectionOverrides[key];

  const sections = {};
  for (const [sKey, sec] of Object.entries(defaults)) {
    const override = overrides?.[sKey];
    sections[sKey] = {
      enabled: true,
      text: override ? override.text : sec.text,
      isCustom: !!override,
      label: sec.label,
      defaultText: sec.text,
    };
  }
  return sections;
}

/**
 * For non-sectioned prompts (angle/ball/headshot/clothes/video).
 * Returns override text if saved, otherwise calls the builder.
 */
function getActivePrompt(promptType, context, builderFn, ...builderArgs) {
  const data = loadOverrides();
  const key = `${promptType}:${context}`;
  const override = data.sectionOverrides[key]?.['full'];
  if (override) return override.text;
  const result = builderFn(...builderArgs);
  return typeof result === 'string' ? result : result.prompt;
}

// ─── Anchor System Prompts ──────────────────────────────────────────────

const ANGLE_NAMES = [
  'front', 'front-3/4-L', 'side-L', 'back-3/4-L',
  'back', 'back-3/4-R', 'side-R', 'front-3/4-R',
];

const BALL_VARIANTS = [
  'dribble-low', 'dribble-high', 'carry-hip',
  'shoot-release', 'two-hand-chest', 'palming',
];

/**
 * Build a prompt for generating a canonical angle reference for a character.
 * Uses the character portrait as identity reference + requests a specific viewing angle.
 * Standardized: brown shirt, black baggy pants, basketball in hand.
 */
function buildAnglePrompt(charName, angleName, angleIndex, totalAngles) {
  const angleDescriptions = {
    'front':        'facing directly toward the camera, head-on front view',
    'front-3/4-L':  'turned roughly 45 degrees to the left, three-quarter front view from the left side',
    'side-L':       'turned 90 degrees to the left, full left-side profile view',
    'back-3/4-L':   'turned roughly 135 degrees to the left, three-quarter rear view from the left side',
    'back':         'facing directly away from the camera, full rear view',
    'back-3/4-R':   'turned roughly 135 degrees to the right, three-quarter rear view from the right side',
    'side-R':       'turned 90 degrees to the right, full right-side profile view',
    'front-3/4-R':  'turned roughly 45 degrees to the right, three-quarter front view from the right side',
  };

  const angleDesc = angleDescriptions[angleName] || `angle ${angleIndex + 1} of ${totalAngles}`;

  const prompt = [
    `IDENTITY REFERENCE: Image 1 is the character's portrait. Keep their exact face, skin tone, hairstyle, and body proportions.`,
    ``,
    `TASK: Generate this character ${angleDesc}.`,
    `This is angle ${angleIndex + 1} of ${totalAngles} in a full turnaround sheet.`,
    ``,
    `OUTFIT — STANDARDIZED:`,
    `- Plain brown t-shirt (solid #8B4513 / saddle brown)`,
    `- Black baggy basketball pants/shorts`,
    `- Basketball held casually in the right hand at hip level`,
    `- Same shoes/sneakers as the portrait`,
    ``,
    `POSE:`,
    `- Standing upright in a relaxed neutral stance`,
    `- Weight evenly distributed, arms relaxed`,
    `- Basketball held in right hand at hip height`,
    `- Full body from head to shoes, NO cropping`,
    ``,
    `CONSISTENCY:`,
    `- Match the exact same proportions and height as Image 1`,
    `- Same pixel art style, same level of detail`,
    `- Same outline thickness and color palette`,
    `- Character should fill ~85% of frame height`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Single character, full body, ONE frame only`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');

  return {
    prompt,
    angleName,
    angleIndex,
    totalAngles,
    characterName: charName,
    mode: 'angle-reference',
  };
}

/**
 * Build a prompt for generating a headshot-only angle reference for a character.
 * Head and neck only — no body, no clothing. Used for head turnaround sheets.
 */
function buildHeadshotAnglePrompt(charName, angleName, angleIndex, totalAngles) {
  const angleDescriptions = {
    'front':        'facing directly toward the camera, head-on front view',
    'front-3/4-L':  'turned roughly 45 degrees to the left, three-quarter front view from the left side',
    'side-L':       'turned 90 degrees to the left, full left-side profile view',
    'back-3/4-L':   'turned roughly 135 degrees to the left, three-quarter rear view from the left side',
    'back':         'facing directly away from the camera, full rear view',
    'back-3/4-R':   'turned roughly 135 degrees to the right, three-quarter rear view from the right side',
    'side-R':       'turned 90 degrees to the right, full right-side profile view',
    'front-3/4-R':  'turned roughly 45 degrees to the right, three-quarter front view from the right side',
  };
  const angleDesc = angleDescriptions[angleName] || `angle ${angleIndex + 1} of ${totalAngles}`;
  const prompt = [
    `IDENTITY REFERENCE: Image 1 is the character's portrait. Keep their exact face, skin tone, hairstyle, and all facial features.`,
    ``,
    `TASK: Generate a HEADSHOT ONLY of this character ${angleDesc}.`,
    `This is headshot angle ${angleIndex + 1} of ${totalAngles} in a full head turnaround sheet.`,
    ``,
    `CROP: Head and neck only — crop tightly just below the chin/neck. NO shoulders. NO body. NO clothing visible.`,
    ``,
    `FOCUS:`,
    `- Face, hairstyle, skin tone must exactly match the reference portrait`,
    `- Show ears where visible at this angle`,
    `- Neck visible but cropped cleanly at the base`,
    `- NO body, NO torso, NO shoulders, NO clothing`,
    ``,
    `CONSISTENCY:`,
    `- Same pixel art style, same level of detail as the reference`,
    `- Same outline thickness and color palette`,
    `- Head should fill ~80% of frame height`,
    `- Centered in frame`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Head and neck only, ONE frame only`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');
  return {
    prompt,
    angleName,
    angleIndex,
    totalAngles,
    characterName: charName,
    mode: 'headshot-angle-reference',
  };
}

/**
 * Build a prompt for generating a headless clothing/outfit angle reference for a character.
 * Collar to shoes — NO head. Transparent background. Used for outfit turnaround sheets.
 */
function buildClothesAnglePrompt(charName, angleName, angleIndex, totalAngles) {
  const angleDescriptions = {
    'front':        'facing directly toward the camera, head-on front view',
    'front-3/4-L':  'turned roughly 45 degrees to the left, three-quarter front view from the left side',
    'side-L':       'turned 90 degrees to the left, full left-side profile view',
    'back-3/4-L':   'turned roughly 135 degrees to the left, three-quarter rear view from the left side',
    'back':         'facing directly away from the camera, full rear view',
    'back-3/4-R':   'turned roughly 135 degrees to the right, three-quarter rear view from the right side',
    'side-R':       'turned 90 degrees to the right, full right-side profile view',
    'front-3/4-R':  'turned roughly 45 degrees to the right, three-quarter front view from the right side',
  };
  const angleDesc = angleDescriptions[angleName] || `angle ${angleIndex + 1} of ${totalAngles}`;
  const prompt = [
    `CLOTHING REFERENCE: Image 1 is the character's portrait. Match their exact outfit, clothing colors, and body proportions.`,
    ``,
    `TASK: Generate a HEADLESS OUTFIT REFERENCE of this character ${angleDesc}.`,
    `This is clothing angle ${angleIndex + 1} of ${totalAngles} in a full outfit turnaround sheet.`,
    ``,
    `CROP: Collar/neck down to shoes — NO HEAD. The figure is cropped cleanly at the neck/collar line. Head is completely absent from the frame.`,
    ``,
    `FOCUS — CLOTHING ONLY:`,
    `- Shirt, jersey, or top — match exact colors, logos, numbers, and details from the reference`,
    `- Shorts or pants — match exact cut, color, and any stripes or markings`,
    `- Shoes — match exact style, color, and sole from the reference`,
    `- Show all garment details visible at this angle (stitching, logos, waistband, shoe laces)`,
    `- NO face, NO head, NO hair — the crop starts at the collar`,
    ``,
    `CONSISTENCY:`,
    `- Same pixel art style and level of detail as the reference`,
    `- Same outline thickness and clothing color palette`,
    `- Figure should fill ~85% of frame height (collar at top, shoes at baseline)`,
    `- Centered in frame, feet on baseline`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Headless full body (collar to shoes), ONE frame only`,
    `Background: transparent — NO background color, NO green, NO fill`,
  ].join('\n');
  return {
    prompt,
    angleName,
    angleIndex,
    totalAngles,
    characterName: charName,
    mode: 'clothes-angle-reference',
  };
}

/**
 * Build a prompt for generating a ball-holding variant reference.
 * Uses character portrait + front angle as refs.
 */
function buildBallRefPrompt(charName, variant, variantIndex) {
  const variantDescriptions = {
    'dribble-low':     'dribbling the basketball low near the ground, knees bent, ball below knee height, right hand on top of ball pushing down',
    'dribble-high':    'dribbling the basketball high at waist level, standing more upright, right hand bouncing ball at hip height',
    'carry-hip':       'carrying the basketball casually tucked against the right hip with one hand, standing upright relaxed',
    'shoot-release':   'in a jump shot release position — ball above head in both hands, arms extended upward, wrists flicking, at the peak of a shot',
    'two-hand-chest':  'holding the basketball with both hands at chest height, elbows out, in a triple-threat or pass-ready position',
    'palming':         'palming the basketball in the right hand with arm extended to the side at shoulder height, showing off ball control',
  };

  const variantDesc = variantDescriptions[variant] || variant;

  const prompt = [
    `IDENTITY REFERENCE: Image 1 is the character's portrait. Match their exact face, skin tone, hairstyle, body proportions.`,
    `If Image 2 is provided, it shows the character's front angle reference — match the outfit and proportions exactly.`,
    ``,
    `TASK: Generate this character ${variantDesc}.`,
    `This is ball variant "${variant}" (${variantIndex + 1} of 6).`,
    ``,
    `OUTFIT — STANDARDIZED:`,
    `- Plain brown t-shirt (solid #8B4513 / saddle brown)`,
    `- Black baggy basketball pants/shorts`,
    `- Same shoes/sneakers as the portrait`,
    ``,
    `POSE:`,
    `- Character facing front (toward camera)`,
    `- ${variantDesc}`,
    `- Full body from head to shoes, NO cropping`,
    ``,
    `BALL:`,
    `- Standard orange basketball with black lines`,
    `- Ball size proportional to character (~12px diameter at character scale)`,
    `- Ball interaction must look natural and physically correct`,
    ``,
    `CONSISTENCY:`,
    `- Match the exact same proportions and height as Image 1`,
    `- Same pixel art style, same level of detail, same outline thickness`,
    `- Character should fill ~85% of frame height`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Single character, full body, ONE frame only`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');

  return {
    prompt,
    variant,
    variantIndex,
    characterName: charName,
    mode: 'ball-reference',
  };
}

module.exports = {
  CHARACTERS,
  ANIMATIONS,
  PROMPT_SECTIONS,
  ANGLE_NAMES,
  BALL_VARIANTS,
  buildPrompt,
  buildPoseTransferPrompt,
  buildTextOnlyAnimPrompt,
  buildFilmToSpritePrompt,
  buildFilmToSingleFramePrompt,
  buildCustomPrompt,
  buildSingleFramePrompt,
  buildSectionedPrompt,
  getDefaultSections,
  parseFrameDescriptions,
  listAnimations,
  buildAnglePrompt,
  buildHeadshotAnglePrompt,
  buildClothesAnglePrompt,
  buildBallRefPrompt,
  trainPrompt,
  loadTraining,
  // Prompt override persistence
  loadOverrides,
  saveOverrides,
  setPromptOverride,
  getPromptOverride,
  getOverrideHistory,
  clearPromptOverride,
  getActiveSections,
  getActivePrompt,
};
