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
    description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
    style: '16-bit pixel art, GBA style',
    heightInches: 72, weightLbs: 185, build: 'athletic',
    jerseyNumber: '', teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
  },
  '99': {
    description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
    style: '16-bit pixel art, GBA style',
    heightInches: 72, weightLbs: 185, build: 'athletic',
    jerseyNumber: '99', teamColors: { primary: '#FF4400', secondary: '#FFFFFF', accent: '#000000' },
  },
};

const ANIMATIONS = {
  'static-dribble': {
    frames: 6, fps: 8, loop: true,
    breezyFile: 'breezy-static-dribble.png',
    action: 'stationary dribble, ball bouncing at side',
    frameBreakdown: '(1) ball at hip right hand (2) pushing ball down (3) ball hitting ground (4) ball bouncing up (5) ball rising to waist (6) ball back at hip, slight body bob on frames 3-4, knees bent',
  },
  'dribble': {
    frames: 8, fps: 10, loop: true,
    breezyFile: 'breezy-dribble.png',
    action: 'running dribble, full run cycle with basketball',
    frameBreakdown: '(1) right foot forward ball high (2) pushing off ball going down (3) mid-stride ball bouncing (4) left foot forward ball low (5) left foot planted ball rising (6) pushing off left ball up (7) airborne mid-stride (8) right foot landing, body leaning forward',
  },
  'jumpshot': {
    frames: 7, fps: 8, loop: false,
    breezyFile: 'breezy-jumpshot.png',
    action: 'basketball jump shot sequence',
    frameBreakdown: '(1) crouching ball at chest (2) beginning jump knees extending (3) rising ball overhead (4) peak of jump ball cocked back (5) release point ball leaving hands (6) follow through arm extended (7) landing arms up',
  },
  'stepback': {
    frames: 4, fps: 8, loop: false,
    breezyFile: 'breezy-stepback.png',
    action: 'stepback jumper creating space',
    frameBreakdown: '(1) dribbling forward (2) planting front foot hard (3) pushing back creating space ball in hands (4) fading back in shooting position',
  },
  'crossover': {
    frames: 4, fps: 13, loop: false,
    breezyFile: 'breezy-crossover.png',
    action: 'crossover dribble move',
    frameBreakdown: '(1) ball in right hand approaching (2) ball crossing low in front of body (3) ball now in left hand pushing past (4) exploding past with ball in left hand',
  },
  'defense-backpedal': {
    frames: 4, fps: 8, loop: true,
    breezyFile: 'breezy-defense-backpedal.png',
    action: 'defensive backpedal, no basketball',
    frameBreakdown: '(1) wide stance arms out low (2) right foot stepping back (3) left foot sliding back (4) resetting stance, low center of gravity hands active',
  },
  'defense-shuffle': {
    frames: 2, fps: 6, loop: true,
    breezyFile: 'breezy-defense-shuffle.png',
    action: 'defensive lateral shuffle, no basketball',
    frameBreakdown: '(1) wide athletic stance arms spread low (2) weight shifted to one side mid-shuffle, knees bent eyes forward',
  },
  'steal': {
    frames: 3, fps: 8, loop: false,
    breezyFile: 'breezy-steal.png',
    action: 'steal attempt reaching for ball',
    frameBreakdown: '(1) defensive stance ready (2) lunging forward arm reaching out to swipe (3) follow through arm fully extended',
  },
};

// ─── Structured Prompt Sections ──────────────────────────────────────────

/**
 * Each section defines a toggleable prompt block with a buildDefault function.
 * When frameIndex is provided, builds for single-frame mode (FBF).
 * Otherwise builds for strip mode.
 */
const PROMPT_SECTIONS = [
  {
    key: 'poseReplication',
    label: 'Pose Replication',
    buildDefault(char, anim, frameIndex, totalFrames) {
      if (frameIndex !== undefined) {
        return `REPLICATE the exact pose from Image 1. Copy the body position, limb placement, and composition EXACTLY. ONLY change the character's identity to match Image 2.\n\nThis is frame ${frameIndex + 1} of ${totalFrames} in a ${anim.action} animation.`;
      }
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
        return `Image 1 shows: ${desc}`;
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
          "- Match Image 1's body pose EXACTLY — same arm angles, leg positions, weight distribution",
          '- Treat Image 1 as motion capture — do NOT reinterpret',
          '- Copy the exact body angle, lean, and center of gravity',
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
    label: 'Character Swap',
    buildDefault(char, anim, frameIndex) {
      if (frameIndex !== undefined) {
        return [
          'CHARACTER:',
          "- Use Image 2's face, skin tone, hairstyle, outfit",
          "- Maintain Image 2's exact proportions and clothing colors",
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
function buildSingleFramePrompt(characterName, animationName, frameIndex, totalFrames) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const descriptions = parseFrameDescriptions(anim.frameBreakdown);
  const frameDesc = descriptions[frameIndex] || `frame ${frameIndex + 1} of ${anim.action}`;

  const prompt = [
    `REPLICATE the exact pose from Image 1. Copy the body position, limb placement, and composition EXACTLY. ONLY change the character's identity to match Image 2.`,
    ``,
    `Image 1 shows: ${frameDesc}`,
    `This is frame ${frameIndex + 1} of ${totalFrames} in a ${anim.action} animation.`,
    ``,
    `POSE RULES:`,
    `- Match Image 1's body pose EXACTLY — same arm angles, leg positions, weight distribution`,
    `- Treat Image 1 as motion capture — do NOT reinterpret`,
    `- Copy the exact body angle, lean, and center of gravity`,
    ``,
    `CHARACTER:`,
    `- Use Image 2's face, skin tone, hairstyle, outfit`,
    `- Character should fill ~85% of frame height`,
    `- Maintain Image 2's exact proportions and clothing colors`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Single character, ONE frame only (NOT a strip)`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');

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
  buildFilmToSpritePrompt,
  buildFilmToSingleFramePrompt,
  buildCustomPrompt,
  buildSingleFramePrompt,
  buildSectionedPrompt,
  getDefaultSections,
  parseFrameDescriptions,
  listAnimations,
  buildAnglePrompt,
  buildBallRefPrompt,
  trainPrompt,
  loadTraining,
};
