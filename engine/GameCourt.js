'use strict';
/**
 * GameCourt.js — Soul Jam court geometry + perspective zones for the Testing court.
 *
 * The Testing canvas (960×540) is exactly 0.75× the game (1280×720), and the
 * court image is stretched to the full canvas exactly like the game's
 * CourtRenderer does, so game coordinates map 1:1 with TEST_SCALE.
 *
 * Perspective zone = which body angle the camera sees. The ball handler faces
 * the hoop, so the zone comes from the direction player → hoop, measured on
 * the floor (screen y is foreshortened depth: DEPTH_K ≈ 2.2 from the court's
 * proportions — ~86 px/m along the court vs ~39 px/m across it in the game):
 *
 *   angle 0°  (hoop toward the camera)   → Z1 Front
 *   angle 45°                             → Z2 Front Left
 *   angle 90° (hoop to the side)          → Z3 Left     (side view — the game's default)
 *   angle 135°                            → Z4 Back Left
 *   angle 180° (hoop away from camera)    → Z5 Back
 *   flip = hoop is to the player's right (mirror of the left-side art)
 */

const GAME_COURT = {
  width: 1280, height: 720,               // soul-jam src/config/Constants.ts
  hoop: { x: 265, y: 228 },               // HOOP_X / HOOP_Y
  bounds: { left: 65, right: 1270, top: 88, bottom: 678 }, // COURT_LEFT/RIGHT/TOP/BOTTOM
};
const TEST_SCALE = 0.75;                   // 960×540 testing canvas
const DEPTH_K = 2.2;

const TEST_COURT = {
  width: GAME_COURT.width * TEST_SCALE,
  height: GAME_COURT.height * TEST_SCALE,
  hoop: { x: GAME_COURT.hoop.x * TEST_SCALE, y: GAME_COURT.hoop.y * TEST_SCALE },
  bounds: {
    left: GAME_COURT.bounds.left * TEST_SCALE, right: GAME_COURT.bounds.right * TEST_SCALE,
    top: GAME_COURT.bounds.top * TEST_SCALE, bottom: GAME_COURT.bounds.bottom * TEST_SCALE,
  },
};

/**
 * @returns {{ id: 1..5, flip: boolean, angle: number }} zone for a player at (x, y)
 */
function perspectiveZone(x, y, hoop = TEST_COURT.hoop, k = DEPTH_K) {
  const fx = hoop.x - x;
  const fy = (hoop.y - y) * k;             // + = hoop is nearer the camera
  if (Math.abs(fx) < 1e-6 && Math.abs(fy) < 1e-6) return { id: 3, flip: false, angle: 90 };
  const angle = (Math.atan2(Math.abs(fx), fy) * 180) / Math.PI; // 0 = toward camera … 180 = away
  const id = Math.max(1, Math.min(5, Math.round(angle / 45) + 1));
  return { id, flip: fx > 0, angle };
}

if (typeof module !== 'undefined') module.exports = { GAME_COURT, TEST_COURT, TEST_SCALE, DEPTH_K, perspectiveZone };
