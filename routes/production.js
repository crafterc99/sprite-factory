/**
 * Production Overview Routes — Canonical Soul Jam production data
 *
 * Full production manifest covering:
 * - 141 canonical animations across 10 families
 * - Character production records (source ref, portrait, turnaround, etc.)
 * - Court slot coverage (14 slots per court)
 * - Screen/UI slot coverage (7 screens)
 * - Skin slot coverage (SkinBundle slots)
 * - Priority 1 flags for core gameplay animations
 * - Realistic status tracking seeded from disk state
 */
const fs = require('fs');
const path = require('path');

// ─── Paths ──────────────────────────────────────────────────────────
const SOUL_JAM_DIR = path.resolve(__dirname, '../../../../soul-jam');
const ASSETS_DIR = path.resolve(SOUL_JAM_DIR, 'public/assets/images');
const RAW_DIR = path.resolve(__dirname, '../../../raw-sprites');
const CHARACTERS_FILE = path.resolve(__dirname, '../../../.characters.json');
const PRODUCTION_DB = path.resolve(__dirname, '../../../.production-db.json');

// ─── Priority 1 Animation IDs ──────────────────────────────────────
const PRIORITY_1 = new Set([
  'idle_no_ball', 'idle_with_ball', 'defensive_stance',
  'walk_8dir', 'run_8dir', 'sprint_8dir',
  'stationary_dribble_right', 'walk_dribble_8dir', 'run_dribble_8dir', 'hesitation_dribble',
  'crossover_left_to_right', 'crossover_right_to_left', 'first_step_burst_left', 'first_step_burst_right',
  'stand_shot', 'pullup_shot_left', 'pullup_shot_right',
  'layup_right', 'layup_left',
  'defensive_slide_left', 'defensive_slide_right', 'backpedal',
  'contest_high_left', 'contest_high_right', 'steal_low',
  'stumble_small_left', 'stumble_small_right',
  'hips_open_left', 'hips_open_right',
  'spin_reach_lost_left', 'spin_reach_lost_right',
]);

// ─── Canonical Animation Manifest (141 animations, 10 families) ─────
const ANIMATION_MANIFEST = {
  neutral: {
    label: 'Neutral / Stance',
    anims: [
      { id: 'idle_no_ball', label: 'Idle (No Ball)' },
      { id: 'idle_with_ball', label: 'Idle (With Ball)' },
      { id: 'triple_threat', label: 'Triple Threat' },
      { id: 'defensive_stance', label: 'Defensive Stance' },
      { id: 'protect_ball_stance', label: 'Protect Ball Stance' },
      { id: 'live_ball_probe_stance', label: 'Live Ball Probe Stance' },
    ],
  },
  locomotion: {
    label: 'Locomotion',
    anims: [
      { id: 'walk_8dir', label: 'Walk (8-dir)' },
      { id: 'run_8dir', label: 'Run (8-dir)' },
      { id: 'sprint_8dir', label: 'Sprint (8-dir)' },
      { id: 'stop_short', label: 'Stop Short' },
      { id: 'stop_hard', label: 'Stop Hard' },
      { id: 'pivot_left', label: 'Pivot Left' },
      { id: 'pivot_right', label: 'Pivot Right' },
      { id: 'turn_left', label: 'Turn Left' },
      { id: 'turn_right', label: 'Turn Right' },
      { id: 'idle_to_run', label: 'Idle → Run' },
      { id: 'run_to_stop', label: 'Run → Stop' },
    ],
  },
  ball_control: {
    label: 'Ball Control',
    anims: [
      { id: 'stationary_dribble_right', label: 'Stationary Dribble (R)', gameKey: 'static-dribble' },
      { id: 'stationary_dribble_left', label: 'Stationary Dribble (L)' },
      { id: 'pound_dribble', label: 'Pound Dribble' },
      { id: 'low_control_dribble', label: 'Low Control Dribble' },
      { id: 'walk_dribble_8dir', label: 'Walk Dribble (8-dir)' },
      { id: 'run_dribble_8dir', label: 'Run Dribble (8-dir)', gameKey: 'dribble' },
      { id: 'sprint_dribble_8dir', label: 'Sprint Dribble (8-dir)' },
      { id: 'protect_dribble_left', label: 'Protect Dribble (L)' },
      { id: 'protect_dribble_right', label: 'Protect Dribble (R)' },
      { id: 'retreat_dribble', label: 'Retreat Dribble' },
      { id: 'hesitation_dribble', label: 'Hesitation Dribble' },
      { id: 'hang_dribble', label: 'Hang Dribble' },
      { id: 'live_ball_reset', label: 'Live Ball Reset' },
      { id: 'hand_switch_stationary', label: 'Hand Switch (Stationary)' },
    ],
  },
  attack_moves: {
    label: 'Attack Moves',
    anims: [
      { id: 'jab_step', label: 'Jab Step' },
      { id: 'shot_fake', label: 'Shot Fake' },
      { id: 'crossover_left_to_right', label: 'Crossover (L→R)', gameKey: 'crossover' },
      { id: 'crossover_right_to_left', label: 'Crossover (R→L)' },
      { id: 'between_legs_left_to_right', label: 'Between Legs (L→R)' },
      { id: 'between_legs_right_to_left', label: 'Between Legs (R→L)' },
      { id: 'behind_back_left_to_right', label: 'Behind Back (L→R)' },
      { id: 'behind_back_right_to_left', label: 'Behind Back (R→L)' },
      { id: 'in_and_out_left', label: 'In & Out (L)' },
      { id: 'in_and_out_right', label: 'In & Out (R)' },
      { id: 'spin_left', label: 'Spin (L)' },
      { id: 'spin_right', label: 'Spin (R)' },
      { id: 'snatchback', label: 'Snatchback' },
      { id: 'stepback', label: 'Stepback', gameKey: 'stepback' },
      { id: 'first_step_burst_left', label: 'First Step Burst (L)' },
      { id: 'first_step_burst_right', label: 'First Step Burst (R)' },
      { id: 'drive_launch_left', label: 'Drive Launch (L)' },
      { id: 'drive_launch_right', label: 'Drive Launch (R)' },
      { id: 'escape_dribble_left', label: 'Escape Dribble (L)' },
      { id: 'escape_dribble_right', label: 'Escape Dribble (R)' },
    ],
  },
  shooting: {
    label: 'Shooting',
    anims: [
      { id: 'stand_shot', label: 'Standing Shot', gameKey: 'jumpshot' },
      { id: 'catch_shot', label: 'Catch & Shoot' },
      { id: 'pullup_shot_left', label: 'Pull-up Shot (L)' },
      { id: 'pullup_shot_right', label: 'Pull-up Shot (R)' },
      { id: 'stepback_shot', label: 'Stepback Shot' },
      { id: 'fadeaway_left', label: 'Fadeaway (L)' },
      { id: 'fadeaway_right', label: 'Fadeaway (R)' },
      { id: 'turnaround_shot_left', label: 'Turnaround Shot (L)' },
      { id: 'turnaround_shot_right', label: 'Turnaround Shot (R)' },
      { id: 'release_followthrough', label: 'Release Follow-through' },
      { id: 'contested_release', label: 'Contested Release' },
      { id: 'rushed_release', label: 'Rushed Release' },
      { id: 'blocked_shot_reaction', label: 'Blocked Shot Reaction' },
    ],
  },
  finishing: {
    label: 'Finishing',
    anims: [
      { id: 'gather_one_step_left', label: 'Gather 1-Step (L)' },
      { id: 'gather_one_step_right', label: 'Gather 1-Step (R)' },
      { id: 'gather_two_step_left', label: 'Gather 2-Step (L)' },
      { id: 'gather_two_step_right', label: 'Gather 2-Step (R)' },
      { id: 'euro_gather_left', label: 'Euro Gather (L)' },
      { id: 'euro_gather_right', label: 'Euro Gather (R)' },
      { id: 'hop_gather', label: 'Hop Gather' },
      { id: 'spin_gather_left', label: 'Spin Gather (L)' },
      { id: 'spin_gather_right', label: 'Spin Gather (R)' },
      { id: 'layup_right', label: 'Layup (R)' },
      { id: 'layup_left', label: 'Layup (L)' },
      { id: 'reverse_layup_right', label: 'Reverse Layup (R)' },
      { id: 'reverse_layup_left', label: 'Reverse Layup (L)' },
      { id: 'floater', label: 'Floater' },
      { id: 'scoop_finish', label: 'Scoop Finish' },
      { id: 'dunk_one_hand', label: 'Dunk (1-Hand)' },
      { id: 'dunk_two_hand', label: 'Dunk (2-Hand)' },
      { id: 'finish_land_recover', label: 'Finish Land / Recover' },
    ],
  },
  defense: {
    label: 'Defense',
    anims: [
      { id: 'defensive_slide_left', label: 'Defensive Slide (L)', gameKey: 'defense-shuffle' },
      { id: 'defensive_slide_right', label: 'Defensive Slide (R)' },
      { id: 'backpedal', label: 'Backpedal', gameKey: 'defense-backpedal' },
      { id: 'forward_closeout', label: 'Forward Closeout' },
      { id: 'sprint_recover', label: 'Sprint Recover' },
      { id: 'hard_plant_recover_left', label: 'Hard Plant Recover (L)' },
      { id: 'hard_plant_recover_right', label: 'Hard Plant Recover (R)' },
      { id: 'contest_high_left', label: 'Contest High (L)' },
      { id: 'contest_high_right', label: 'Contest High (R)' },
      { id: 'contest_low_left', label: 'Contest Low (L)' },
      { id: 'contest_low_right', label: 'Contest Low (R)' },
      { id: 'steal_high', label: 'Steal High', gameKey: 'steal' },
      { id: 'steal_low', label: 'Steal Low' },
      { id: 'poke_attempt', label: 'Poke Attempt' },
      { id: 'block_attempt', label: 'Block Attempt' },
      { id: 'chase_contest', label: 'Chase Contest' },
    ],
  },
  defensive_reactions: {
    label: 'Defensive Reactions / Getting Crossed',
    anims: [
      { id: 'lean_wrong_left', label: 'Lean Wrong (L)' },
      { id: 'lean_wrong_right', label: 'Lean Wrong (R)' },
      { id: 'lean_back_left', label: 'Lean Back (L)' },
      { id: 'lean_back_right', label: 'Lean Back (R)' },
      { id: 'reach_shift_left', label: 'Reach Shift (L)' },
      { id: 'reach_shift_right', label: 'Reach Shift (R)' },
      { id: 'reach_high_miss_left', label: 'Reach High Miss (L)' },
      { id: 'reach_high_miss_right', label: 'Reach High Miss (R)' },
      { id: 'reach_low_miss_left', label: 'Reach Low Miss (L)' },
      { id: 'reach_low_miss_right', label: 'Reach Low Miss (R)' },
      { id: 'hips_open_left', label: 'Hips Open (L)' },
      { id: 'hips_open_right', label: 'Hips Open (R)' },
      { id: 'late_turn_chase_left', label: 'Late Turn Chase (L)' },
      { id: 'late_turn_chase_right', label: 'Late Turn Chase (R)' },
      { id: 'spin_reach_lost_left', label: 'Spin Reach Lost (L)' },
      { id: 'spin_reach_lost_right', label: 'Spin Reach Lost (R)' },
      { id: 'spin_body_sealed_left', label: 'Spin Body Sealed (L)' },
      { id: 'spin_body_sealed_right', label: 'Spin Body Sealed (R)' },
      { id: 'stumble_small_left', label: 'Stumble Small (L)' },
      { id: 'stumble_small_right', label: 'Stumble Small (R)' },
      { id: 'stumble_hard_left', label: 'Stumble Hard (L)' },
      { id: 'stumble_hard_right', label: 'Stumble Hard (R)' },
      { id: 'catch_balance_recover', label: 'Catch Balance Recover' },
      { id: 'rear_hip_beat_left', label: 'Rear Hip Beat (L)' },
      { id: 'rear_hip_beat_right', label: 'Rear Hip Beat (R)' },
    ],
  },
  contact: {
    label: 'Contact / Disruption',
    anims: [
      { id: 'bump_absorb_offense', label: 'Bump Absorb (Offense)' },
      { id: 'bump_absorb_defense', label: 'Bump Absorb (Defense)' },
      { id: 'stripped_reaction', label: 'Stripped Reaction' },
      { id: 'dribble_knock_loose', label: 'Dribble Knock Loose' },
      { id: 'body_up_stop', label: 'Body Up / Stop' },
      { id: 'interrupted_gather', label: 'Interrupted Gather' },
      { id: 'blocked_at_rim', label: 'Blocked at Rim' },
      { id: 'loose_ball_reach', label: 'Loose Ball Reach' },
      { id: 'rebound_secure', label: 'Rebound Secure' },
      { id: 'rebound_tip', label: 'Rebound Tip' },
      { id: 'rebound_land', label: 'Rebound Land' },
    ],
  },
  presentation: {
    label: 'Presentation',
    anims: [
      { id: 'intro', label: 'Intro' },
      { id: 'matchup_pose', label: 'Matchup Pose' },
      { id: 'win_celebration', label: 'Win Celebration' },
      { id: 'loss_reaction', label: 'Loss Reaction' },
      { id: 'taunt', label: 'Taunt' },
      { id: 'player_select_idle', label: 'Player Select Idle' },
      { id: 'result_pose', label: 'Result Pose' },
    ],
  },
};

// Inject priority flags
for (const family of Object.values(ANIMATION_MANIFEST)) {
  for (const anim of family.anims) {
    anim.priority = PRIORITY_1.has(anim.id) ? 1 : 2;
  }
}

// Current in-game animation keys
const GAME_ANIMATIONS = [
  'static-dribble', 'dribble', 'jumpshot', 'stepback',
  'crossover', 'defense-backpedal', 'defense-shuffle', 'steal',
];

// Build flat manifest list for counting
function flatManifest() {
  const all = [];
  for (const [familyId, family] of Object.entries(ANIMATION_MANIFEST)) {
    for (const anim of family.anims) {
      all.push({ ...anim, family: familyId, familyLabel: family.label });
    }
  }
  return all;
}

// ─── Character Production Asset Definitions ─────────────────────────
const CHARACTER_PRODUCTION_ASSETS = [
  { id: 'source_reference', label: 'Source Reference Photo', category: 'reference' },
  { id: 'portrait_crop', label: 'Portrait Crop', category: 'reference' },
  { id: 'standing_full_body', label: 'Standing Full-Body Reference', category: 'reference' },
  { id: 'turnaround_8angle', label: '8-Angle Turnaround', category: 'reference' },
  { id: 'with_ball_ref', label: 'With-Ball Canonical Reference', category: 'reference' },
  { id: 'without_ball_ref', label: 'Without-Ball Canonical Reference', category: 'reference' },
  { id: 'in_game_spritesheet', label: 'In-Game Sprite Sheet', category: 'export' },
  { id: 'select_card_portrait', label: 'Select Card Portrait', category: 'ui' },
  { id: 'matchup_portrait', label: 'Matchup Portrait', category: 'ui' },
  { id: 'result_portrait', label: 'Result Portrait', category: 'ui' },
];

// ─── Court Slot Definitions (14 per court) ──────────────────────────
const COURT_SLOTS = [
  { id: 'floor_base', label: 'Floor Base', category: 'surface' },
  { id: 'paint_overlay', label: 'Paint Overlay', category: 'surface' },
  { id: 'line_overlay', label: 'Line Overlay', category: 'surface' },
  { id: 'center_logo', label: 'Center Logo', category: 'surface' },
  { id: 'rim', label: 'Rim', category: 'hoop' },
  { id: 'net', label: 'Net', category: 'hoop' },
  { id: 'backboard', label: 'Backboard', category: 'hoop' },
  { id: 'stanchion', label: 'Stanchion', category: 'hoop' },
  { id: 'arena_background', label: 'Arena Background', category: 'environment' },
  { id: 'crowd_layer', label: 'Crowd / Background Layer', category: 'environment' },
  { id: 'court_thumbnail', label: 'Court Thumbnail', category: 'ui' },
  { id: 'court_intro_overlay', label: 'Court Intro Overlay', category: 'ui' },
  { id: 'scoreboard_compat', label: 'Scoreboard Compatibility', category: 'compat' },
  { id: 'feedback_banner_compat', label: 'Feedback Banner Compatibility', category: 'compat' },
];

// ─── Court Definitions ──────────────────────────────────────────────
const COURTS = {
  'soul-jam-arena': { id: 'soul-jam-arena', name: 'Soul Jam Arena', unlocked: true },
  'street': { id: 'street', name: 'The Street', unlocked: false },
};

// ─── Screen/UI Slot Definitions ─────────────────────────────────────
const SCREEN_SLOTS = {
  'title_screen': {
    id: 'title_screen', name: 'Title Screen',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'logo', label: 'Game Logo' },
      { id: 'title_overlay', label: 'Title Text Overlay' },
    ],
  },
  'main_menu': {
    id: 'main_menu', name: 'Main Menu',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'button_style', label: 'Button Style Assets' },
      { id: 'menu_overlay', label: 'Menu Overlay' },
    ],
  },
  'character_select': {
    id: 'character_select', name: 'Character Select',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'card_frame', label: 'Card Frame' },
      { id: 'selection_highlight', label: 'Selection Highlight' },
      { id: 'name_plate', label: 'Name Plate' },
    ],
  },
  'court_select': {
    id: 'court_select', name: 'Court Select',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'card_frame', label: 'Court Card Frame' },
      { id: 'lock_overlay', label: 'Lock Overlay' },
    ],
  },
  'gameplay_hud': {
    id: 'gameplay_hud', name: 'Gameplay HUD',
    slots: [
      { id: 'scoreboard', label: 'Scoreboard Panel' },
      { id: 'feedback_bar', label: 'Feedback Bar' },
      { id: 'timing_meter', label: 'Timing Meter' },
      { id: 'controls_hint', label: 'Controls Hint' },
      { id: 'pause_overlay', label: 'Pause Overlay' },
    ],
  },
  'result_screen': {
    id: 'result_screen', name: 'Result Screen',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'result_banner', label: 'Result Banner' },
      { id: 'stat_panel', label: 'Stat Panel' },
    ],
  },
  'leaderboard': {
    id: 'leaderboard', name: 'Leaderboard',
    slots: [
      { id: 'bg_image', label: 'Background Image' },
      { id: 'table_style', label: 'Table Style' },
      { id: 'rank_badge', label: 'Rank Badge' },
    ],
  },
};

// ─── Skin Slot Definitions (SkinBundle integration) ─────────────────
const SKIN_SLOTS = {
  screens: {
    label: 'Screen / UI Art',
    slots: [
      { id: 'screen.boot.bg', label: 'Boot Screen BG', category: 'screen' },
      { id: 'screen.menu.bg', label: 'Menu BG', category: 'screen' },
      { id: 'screen.characterSelect.bg', label: 'Character Select BG', category: 'screen' },
      { id: 'screen.courtSelect.bg', label: 'Court Select BG', category: 'screen' },
      { id: 'screen.result.bg', label: 'Result Screen BG', category: 'screen' },
      { id: 'screen.leaderboard.bg', label: 'Leaderboard BG', category: 'screen' },
      { id: 'screen.pause.bg', label: 'Pause Overlay', category: 'screen' },
    ],
  },
  court: {
    label: 'Court Visual Components',
    slots: [
      { id: 'court.floor', label: 'Floor Base', category: 'court' },
      { id: 'court.paintOverlay', label: 'Paint Overlay', category: 'court' },
      { id: 'court.lineOverlay', label: 'Line Overlay', category: 'court' },
      { id: 'court.centerLogo', label: 'Center Logo', category: 'court' },
      { id: 'court.arenaBg', label: 'Arena Background', category: 'court' },
    ],
  },
  hoop: {
    label: 'Hoop Components',
    slots: [
      { id: 'hoop.rim', label: 'Rim', category: 'hoop' },
      { id: 'hoop.net', label: 'Net', category: 'hoop' },
      { id: 'hoop.backboard', label: 'Backboard', category: 'hoop' },
      { id: 'hoop.stanchion', label: 'Stanchion', category: 'hoop' },
    ],
  },
  ball: {
    label: 'Ball',
    slots: [
      { id: 'ball', label: 'Basketball Texture', category: 'ball' },
    ],
  },
  cards: {
    label: 'Card / Panel Components',
    slots: [
      { id: 'characterCard.frame', label: 'Player Select Card Frame', category: 'card' },
      { id: 'courtCard.frame', label: 'Court Card Frame', category: 'card' },
    ],
  },
};

// ─── Production DB ──────────────────────────────────────────────────

function loadProductionDB() {
  try {
    if (fs.existsSync(PRODUCTION_DB)) return JSON.parse(fs.readFileSync(PRODUCTION_DB, 'utf8'));
  } catch {}
  return { assets: {}, overrides: {}, characters: {}, courts: {}, screens: {} };
}

function saveProductionDB(db) {
  fs.writeFileSync(PRODUCTION_DB, JSON.stringify(db, null, 2));
}

// ─── Asset Discovery ────────────────────────────────────────────────

function discoverAssets(dir) {
  const assets = {};
  if (!fs.existsSync(dir)) return assets;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fullPath = path.join(dir, f);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) continue;
      const ext = path.extname(f).toLowerCase();
      if (!['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) continue;
      assets[f] = { filename: f, path: fullPath, size: stat.size, updatedAt: stat.mtime.toISOString(), ext };
    } catch {}
  }
  return assets;
}

function loadCharacterRegistry() {
  try {
    if (fs.existsSync(CHARACTERS_FILE)) return JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
  } catch {}
  return {};
}

function countFramesDir(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.endsWith('.png')).length;
  } catch { return 0; }
}

// ─── Build Character Overview ───────────────────────────────────────

function buildCharacterOverview(charId, charData, assetFiles, db) {
  const portraitFile = charId === '99' ? '99full.png' : `${charId}full.png`;
  const portraitWebp = charId === '99' ? '99full.webp' : `${charId}full.webp`;
  const selectFile = `${charId}-player-select.webp`;
  const sheetFile = `${charId}-spritesheet.png`;

  const hasPortrait = !!(assetFiles[portraitFile] || assetFiles[portraitWebp]);
  const hasSelect = !!assetFiles[selectFile];
  const hasSheet = !!assetFiles[sheetFile];

  // Game animation coverage
  const animations = {};
  let completedAnims = 0;
  for (const gameKey of GAME_ANIMATIONS) {
    const stripFile = `${charId}-${gameKey}.png`;
    const framesDir = path.join(ASSETS_DIR, `${charId}-${gameKey}-frames`);
    const frameCount = countFramesDir(framesDir);
    const exists = !!assetFiles[stripFile];
    if (exists) completedAnims++;
    animations[gameKey] = {
      exists,
      stripFile,
      frameCount,
      status: exists ? 'exported' : 'missing',
    };
  }

  // Character production assets from DB or auto-detect
  const charDb = db.characters?.[charId] || {};
  const productionAssets = {};
  for (const assetDef of CHARACTER_PRODUCTION_ASSETS) {
    const dbStatus = charDb[assetDef.id];
    let status = dbStatus?.status || 'missing';
    let file = dbStatus?.file || null;

    // Auto-detect from disk if not in DB
    if (!dbStatus) {
      if (assetDef.id === 'portrait_crop' && hasPortrait) { status = 'done'; file = portraitFile; }
      else if (assetDef.id === 'standing_full_body' && hasPortrait) { status = 'done'; file = portraitFile; }
      else if (assetDef.id === 'source_reference' && charData?.originalPhotoPath) { status = 'done'; file = charData.originalPhotoPath; }
      else if (assetDef.id === 'in_game_spritesheet' && hasSheet) { status = 'done'; file = sheetFile; }
      else if (assetDef.id === 'select_card_portrait' && hasSelect) { status = 'done'; file = selectFile; }
    }

    productionAssets[assetDef.id] = {
      id: assetDef.id,
      label: assetDef.label,
      category: assetDef.category,
      status,
      file,
    };
  }

  const prodDone = Object.values(productionAssets).filter(a => a.status === 'done').length;
  const prodTotal = CHARACTER_PRODUCTION_ASSETS.length;

  return {
    id: charId,
    name: charData?.name || charId,
    portrait: `/assets/${portraitFile}`,
    hasPortrait,
    hasSelect,
    hasGrid: hasSheet,
    completedAnims,
    totalAnims: GAME_ANIMATIONS.length,
    animations,
    productionAssets,
    productionProgress: { done: prodDone, total: prodTotal },
    heightInches: charData?.heightInches,
    weightLbs: charData?.weightLbs,
    build: charData?.build,
    jerseyNumber: charData?.jerseyNumber,
    teamColors: charData?.teamColors,
    scaleMultiplier: charData?.scaleMultiplier,
    exportReadiness: completedAnims === GAME_ANIMATIONS.length && hasSheet ? 'ready' : completedAnims > 0 ? 'partial' : 'not_started',
    status: charData?.status || 'unknown',
  };
}

// ─── Build Court Overview ───────────────────────────────────────────

function buildCourtOverview(courtId, courtDef, assetFiles, db) {
  const courtDb = db.courts?.[courtId] || {};
  const slots = {};
  let filled = 0;

  for (const slotDef of COURT_SLOTS) {
    const key = `${courtId}.${slotDef.id}`;
    const dbSlot = courtDb[slotDef.id];
    let status = dbSlot?.status || 'missing';
    let file = dbSlot?.file || null;

    // Auto-detect known files
    if (!dbSlot) {
      if (slotDef.id === 'floor_base' && assetFiles['court.webp']) { status = 'exported'; file = 'court.webp'; }
    }

    if (status !== 'missing') filled++;

    slots[slotDef.id] = {
      id: key,
      slotId: slotDef.id,
      label: slotDef.label,
      category: slotDef.category,
      status,
      file,
      notes: dbSlot?.notes || '',
    };
  }

  return {
    id: courtId,
    name: courtDef.name,
    unlocked: courtDef.unlocked,
    slots,
    filledSlots: filled,
    totalSlots: COURT_SLOTS.length,
  };
}

// ─── Build Screen Overview ──────────────────────────────────────────

function buildScreenOverview(screenId, screenDef, assetFiles, db) {
  const screenDb = db.screens?.[screenId] || {};
  const slots = {};
  let filled = 0;

  for (const slotDef of screenDef.slots) {
    const key = `${screenId}.${slotDef.id}`;
    const dbSlot = screenDb[slotDef.id];
    let status = dbSlot?.status || 'missing';
    let file = dbSlot?.file || null;

    // Auto-detect known screen files
    if (!dbSlot) {
      if (screenId === 'title_screen' && slotDef.id === 'bg_image' && assetFiles['loading-screen.webp']) {
        status = 'exported'; file = 'loading-screen.webp';
      } else if (screenId === 'main_menu' && slotDef.id === 'bg_image' && assetFiles['loading-screen.webp']) {
        status = 'exported'; file = 'loading-screen.webp';
      } else if (screenId === 'character_select' && slotDef.id === 'bg_image' && assetFiles['playerselect.jpg']) {
        status = 'exported'; file = 'playerselect.jpg';
      }
    }

    if (status !== 'missing') filled++;

    slots[slotDef.id] = {
      id: key,
      slotId: slotDef.id,
      label: slotDef.label,
      status,
      file,
      notes: dbSlot?.notes || '',
    };
  }

  return {
    id: screenId,
    name: screenDef.name,
    slots,
    filledSlots: filled,
    totalSlots: screenDef.slots.length,
  };
}

// ─── Build Skin Slot Coverage ───────────────────────────────────────

function buildSlotCoverage(assetFiles, db) {
  const coverage = [];
  const autoMap = {
    'court.floor': 'court.webp',
    'ball': 'basketball.png',
    'screen.boot.bg': 'loading-screen.webp',
    'screen.menu.bg': 'loading-screen.webp',
    'screen.characterSelect.bg': 'playerselect.jpg',
  };

  for (const [groupId, group] of Object.entries(SKIN_SLOTS)) {
    for (const slot of group.slots) {
      const override = db.overrides?.[slot.id];
      const resolvedFile = override?.assignedFile || autoMap[slot.id] || null;
      const fileExists = resolvedFile ? !!assetFiles[resolvedFile] : false;

      let status = 'missing';
      if (override?.status) status = override.status;
      else if (fileExists) status = 'exported';

      coverage.push({
        id: slot.id,
        label: slot.label,
        groupId,
        groupLabel: group.label,
        category: slot.category,
        assignedFile: resolvedFile,
        fileExists,
        status,
        notes: override?.notes || '',
      });
    }
  }
  return coverage;
}

// ─── Build Animation Matrix ─────────────────────────────────────────

function buildAnimationMatrix(charRegistry, assetFiles) {
  const charIds = Object.keys(charRegistry);
  const characters = charIds.map(id => ({
    id,
    name: charRegistry[id]?.name || id,
    animations: {},
  }));

  // Build per-character animation status
  for (const char of characters) {
    for (const gameKey of GAME_ANIMATIONS) {
      const stripFile = `${char.id}-${gameKey}.png`;
      char.animations[gameKey] = {
        exists: !!assetFiles[stripFile],
        frameCount: countFramesDir(path.join(ASSETS_DIR, `${char.id}-${gameKey}-frames`)),
      };
    }
  }

  // Build flat manifest with per-character statuses
  const manifest = flatManifest().map(anim => {
    const charStatuses = {};
    for (const char of characters) {
      if (anim.gameKey) {
        charStatuses[char.id] = char.animations[anim.gameKey]?.exists ? 'exported' : 'missing';
      } else {
        charStatuses[char.id] = 'missing';
      }
    }
    return {
      ...anim,
      inGame: !!anim.gameKey,
      characterStatuses: charStatuses,
    };
  });

  return { characters, manifest };
}

// ─── Route Registration ─────────────────────────────────────────────

function register(router, ctx) {
  const { json, parseBody } = ctx;

  // GET /api/production/overview — Full production overview
  router.get('/api/production/overview', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();
      const db = loadProductionDB();
      const allAnims = flatManifest();

      // Characters
      const characters = [];
      for (const [charId, charData] of Object.entries(charRegistry)) {
        characters.push(buildCharacterOverview(charId, charData, assetFiles, db));
      }

      // Courts
      const courts = [];
      for (const [courtId, courtDef] of Object.entries(COURTS)) {
        courts.push(buildCourtOverview(courtId, courtDef, assetFiles, db));
      }

      // Screens
      const screens = [];
      for (const [screenId, screenDef] of Object.entries(SCREEN_SLOTS)) {
        screens.push(buildScreenOverview(screenId, screenDef, assetFiles, db));
      }

      // Skin slot coverage
      const slotCoverage = buildSlotCoverage(assetFiles, db);

      // Summary
      const totalCharAssets = characters.length * CHARACTER_PRODUCTION_ASSETS.length;
      const doneCharAssets = characters.reduce((sum, c) => sum + c.productionProgress.done, 0);
      const totalAnimSlots = characters.length * GAME_ANIMATIONS.length;
      const doneAnimSlots = characters.reduce((sum, c) => sum + c.completedAnims, 0);
      const totalCourtSlots = courts.reduce((sum, c) => sum + c.totalSlots, 0);
      const doneCourtSlots = courts.reduce((sum, c) => sum + c.filledSlots, 0);
      const totalScreenSlots = screens.reduce((sum, s) => sum + s.totalSlots, 0);
      const doneScreenSlots = screens.reduce((sum, s) => sum + s.filledSlots, 0);
      const totalSkinSlots = slotCoverage.length;
      const doneSkinSlots = slotCoverage.filter(s => s.status !== 'missing').length;

      const totalAssets = totalCharAssets + totalAnimSlots + totalCourtSlots + totalScreenSlots + totalSkinSlots;
      const completedAssets = doneCharAssets + doneAnimSlots + doneCourtSlots + doneScreenSlots + doneSkinSlots;

      // Priority 1 coverage
      const p1Anims = allAnims.filter(a => a.priority === 1);
      let p1Done = 0;
      for (const a of p1Anims) {
        if (!a.gameKey) continue;
        // Check if at least one character has it
        for (const char of characters) {
          if (char.animations[a.gameKey]?.exists) { p1Done++; break; }
        }
      }

      return json(res, {
        summary: {
          totalCharacters: characters.length,
          totalAnimations: allAnims.length,
          totalAssets,
          completedAssets,
          gameAnimCoverage: { done: doneAnimSlots, total: totalAnimSlots },
          characterAssetCoverage: { done: doneCharAssets, total: totalCharAssets },
          courtSlotCoverage: { done: doneCourtSlots, total: totalCourtSlots },
          screenSlotCoverage: { done: doneScreenSlots, total: totalScreenSlots },
          skinSlotCoverage: { done: doneSkinSlots, total: totalSkinSlots },
          priority1: { done: p1Done, total: p1Anims.length, animIds: [...PRIORITY_1] },
          assetFileCount: Object.keys(assetFiles).length,
        },
        characters,
        courts,
        screens,
        slotCoverage,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/animation-matrix
  router.get('/api/production/animation-matrix', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();
      const result = buildAnimationMatrix(charRegistry, assetFiles);
      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/missing
  router.get('/api/production/missing', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();
      const db = loadProductionDB();

      const missing = { characters: [], courts: [], screens: [], slots: [], priority1: [] };

      // Character missing work
      for (const [charId, charData] of Object.entries(charRegistry)) {
        const overview = buildCharacterOverview(charId, charData, assetFiles, db);
        const missingAnims = Object.entries(overview.animations)
          .filter(([, v]) => v.status === 'missing').map(([k]) => k);
        const missingProd = Object.values(overview.productionAssets)
          .filter(a => a.status === 'missing');
        if (missingAnims.length > 0 || missingProd.length > 0) {
          missing.characters.push({
            id: charId, name: overview.name,
            missingAnims, missingProductionAssets: missingProd,
            coveragePercent: Math.round((overview.completedAnims / overview.totalAnims) * 100),
          });
        }
      }

      // Court missing
      for (const [courtId, courtDef] of Object.entries(COURTS)) {
        const overview = buildCourtOverview(courtId, courtDef, assetFiles, db);
        const missingSlots = Object.values(overview.slots).filter(s => s.status === 'missing');
        if (missingSlots.length > 0) {
          missing.courts.push({ id: courtId, name: overview.name, missingSlots });
        }
      }

      // Screen missing
      for (const [screenId, screenDef] of Object.entries(SCREEN_SLOTS)) {
        const overview = buildScreenOverview(screenId, screenDef, assetFiles, db);
        const missingSlots = Object.values(overview.slots).filter(s => s.status === 'missing');
        if (missingSlots.length > 0) {
          missing.screens.push({ id: screenId, name: overview.name, missingSlots });
        }
      }

      // Skin slot missing
      const slotCoverage = buildSlotCoverage(assetFiles, db);
      missing.slots = slotCoverage.filter(s => s.status === 'missing');

      // Priority 1 missing
      const allAnims = flatManifest();
      for (const a of allAnims) {
        if (a.priority !== 1) continue;
        if (!a.gameKey) {
          missing.priority1.push({ animId: a.id, label: a.label, family: a.familyLabel, reason: 'no game key mapping yet' });
        }
      }

      return json(res, { missing });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/status
  router.post('/api/production/status', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { assetId, status, notes } = body;
      if (!assetId || !status) return json(res, { error: 'assetId and status required' }, 400);
      const db = loadProductionDB();
      if (!db.assets) db.assets = {};
      db.assets[assetId] = {
        ...(db.assets[assetId] || {}),
        status, notes: notes || '', updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/slot
  router.post('/api/production/slot', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { slotId, assignedFile, status, notes } = body;
      if (!slotId) return json(res, { error: 'slotId required' }, 400);
      const db = loadProductionDB();
      if (!db.overrides) db.overrides = {};
      db.overrides[slotId] = {
        ...(db.overrides[slotId] || {}),
        assignedFile: assignedFile !== undefined ? assignedFile : db.overrides[slotId]?.assignedFile,
        status: status || 'placeholder',
        notes: notes !== undefined ? notes : db.overrides[slotId]?.notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/character-asset — Update character production asset
  router.post('/api/production/character-asset', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { characterId, assetId, status, file, notes } = body;
      if (!characterId || !assetId) return json(res, { error: 'characterId and assetId required' }, 400);
      const db = loadProductionDB();
      if (!db.characters) db.characters = {};
      if (!db.characters[characterId]) db.characters[characterId] = {};
      db.characters[characterId][assetId] = {
        status: status || 'missing', file: file || null, notes: notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/court-slot — Update court slot
  router.post('/api/production/court-slot', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { courtId, slotId, status, file, notes } = body;
      if (!courtId || !slotId) return json(res, { error: 'courtId and slotId required' }, 400);
      const db = loadProductionDB();
      if (!db.courts) db.courts = {};
      if (!db.courts[courtId]) db.courts[courtId] = {};
      db.courts[courtId][slotId] = {
        status: status || 'missing', file: file || null, notes: notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/screen-slot — Update screen slot
  router.post('/api/production/screen-slot', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { screenId, slotId, status, file, notes } = body;
      if (!screenId || !slotId) return json(res, { error: 'screenId and slotId required' }, 400);
      const db = loadProductionDB();
      if (!db.screens) db.screens = {};
      if (!db.screens[screenId]) db.screens[screenId] = {};
      db.screens[screenId][slotId] = {
        status: status || 'missing', file: file || null, notes: notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);
      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/manifest
  router.get('/api/production/manifest', (req, res) => {
    return json(res, { manifest: ANIMATION_MANIFEST, gameAnimations: GAME_ANIMATIONS, priority1: [...PRIORITY_1] });
  });

  // GET /api/production/skin-slots
  router.get('/api/production/skin-slots', (req, res) => {
    return json(res, { slots: SKIN_SLOTS });
  });
}

module.exports = { register, ANIMATION_MANIFEST, GAME_ANIMATIONS, SKIN_SLOTS, PRIORITY_1 };
