/**
 * Soul Jam Capture — the animation-definition schema (one source of truth for what a capture
 * library contains). Shared by the server (Node) and the browser (served at /capture/js/*.mjs).
 *
 * An animation is a clip the game will play. Every clip starts in one canonical body state and
 * ends in one (`startState` → `endState`): the library forms a state graph, so gameplay can chain
 * any clip that ends in X with any clip that starts in X.
 *
 * Types (JSDoc — checked at runtime by validateAnimation / validateLibrary):
 *
 * @typedef {'N'|'TR'|'TL'|'DR'|'DL'|'MR'|'ML'|'G'|'DEF'|'DEF_M'|'LAND'|'N_SPRINT'} StateId
 * @typedef {'R'|'L'|'both'|'none'} BallHand
 * @typedef {'none'|'forward'|'backward'|'right'|'left'|'forward-right'|'forward-left'|'back-right'|'back-left'|'to-basket'|'up'} Direction
 * @typedef {'A'|'B'|'C'} SetupId
 *
 * @typedef {object} AnimationDef
 * @property {string} id            three-digit id, stable forever ('037')
 * @property {string} key           machine name ('cross_RL') — folder names in exports
 * @property {string} title         big UI line ('CROSSOVER')
 * @property {string} [subtitle]    second UI line ('RIGHT → LEFT')
 * @property {string} category      FOUNDATION | LOCOMOTION | TRIPLE_THREAT | HANDLES | SHOOTING | FINISHING | DEFENSE
 * @property {StateId|StateId[]} startState   any of these (an array: "G/M")
 * @property {StateId} endState
 * @property {StateId} [endResolves]          a landing that settles into another state (LAND → N)
 * @property {number} durationSec   the take's target length, holds included
 * @property {boolean} loop         a looping clip (several natural cycles, no holds)
 * @property {BallHand} ballHand
 * @property {Direction} direction  the player's travel direction relative to where he faces
 * @property {SetupId} courtSetup
 * @property {string[]} cues        what the athlete does (shown to the operator)
 * @property {string[]} [gameRoles] the court runtime roles it can feed (lib/mocap/game-roles.js)
 */

export const SCHEMA_VERSION = 1;

/** Canonical body states. */
export const STATES = {
  N: { name: 'Neutral athletic stance', short: 'Stance', group: 'neutral' },
  TR: { name: 'Triple threat, ball right', short: 'Triple threat R', group: 'triple', hand: 'R' },
  TL: { name: 'Triple threat, ball left', short: 'Triple threat L', group: 'triple', hand: 'L' },
  DR: { name: 'Stationary dribble, right hand', short: 'Dribble R', group: 'dribble', hand: 'R' },
  DL: { name: 'Stationary dribble, left hand', short: 'Dribble L', group: 'dribble', hand: 'L' },
  MR: { name: 'Moving dribble, right hand', short: 'Moving dribble R', group: 'moving', hand: 'R' },
  ML: { name: 'Moving dribble, left hand', short: 'Moving dribble L', group: 'moving', hand: 'L' },
  G: { name: 'Two-hand gather / shooting pocket', short: 'Gather', group: 'gather', hand: 'both' },
  DEF: { name: 'Defensive stance', short: 'Defense stance', group: 'defense' },
  DEF_M: { name: 'Defensive locomotion', short: 'Defensive slide', group: 'defense' },
  LAND: { name: 'Balanced landing (resolves to N)', short: 'Landing', group: 'landing', resolves: 'N' },
  N_SPRINT: { name: 'Sprinting, no ball', short: 'Sprint', group: 'neutral' },
};
/** "Triple threat R → Dribble L" — an animation's start → finish pose in a few words (lists). */
export const poseRoute = (a) => `${[].concat(a.startState).map((s) => STATES[s]?.short || s).join(' / ')} → ${STATES[a.endState]?.short || a.endState}`;
/** Each state in plain words (the director's START / FINISH instructions). */
export const POSES = {
  N: 'Athletic stance: feet shoulder-width apart, knees soft, hands relaxed, facing the hoop.',
  TR: 'Triple threat: ball on the right hip in both hands, knees bent, facing the hoop.',
  TL: 'Triple threat: ball on the left hip in both hands, knees bent, facing the hoop.',
  DR: 'Dribbling in place with the right hand, knees bent, eyes up, facing the hoop.',
  DL: 'Dribbling in place with the left hand, knees bent, eyes up, facing the hoop.',
  MR: 'Jogging while dribbling with the right hand.',
  ML: 'Jogging while dribbling with the left hand.',
  G: 'Ball in both hands in the shooting pocket, knees bent, ready to shoot.',
  DEF: 'Defensive stance: low, feet wide, hands up and active, no ball.',
  DEF_M: 'Sliding in a low defensive stance, feet never crossing.',
  LAND: 'Landed on both feet, balanced and still — then stand relaxed.',
  N_SPRINT: 'Running at full speed, no ball.',
};

/** Order the operator works through body states in (camera setup first, then this). */
export const STATE_ORDER = ['N', 'TR', 'TL', 'DR', 'DL', 'MR', 'ML', 'G', 'DEF', 'DEF_M', 'N_SPRINT', 'LAND'];
export const HAND_ORDER = ['R', 'L', 'both', 'none'];
export const DIRECTIONS = ['none', 'forward', 'backward', 'right', 'left', 'forward-right', 'forward-left', 'back-right', 'back-left', 'to-basket', 'up'];
export const CATEGORIES = ['FOUNDATION', 'LOCOMOTION', 'TRIPLE_THREAT', 'HANDLES', 'SHOOTING', 'FINISHING', 'DEFENSE'];
export const SETUPS = ['A', 'B', 'C'];

/** Capture protocol per clip kind (the holds are capture handles, never part of the game clip). */
export const CAPTURE_PROTOCOL = {
  oneShot: { startHoldSec: 1, endHoldSec: 1, note: 'hold the start state ~1 s → the move at game speed → hold the end state ~1 s' },
  loop: { cycles: 'several natural cycles', note: 'natural repeated cycles for the whole take — no holds' },
  preferredFps: 120,
  minFps: 60,
  realSpeed: 'always at game speed — high fps is for analysis, never slow motion',
};

const isState = (s) => Object.hasOwn(STATES, s);
export const startStates = (a) => (Array.isArray(a.startState) ? a.startState : [a.startState]);
export const stateLabel = (s) => (Array.isArray(s) ? s.join('/') : s);

/** Problems with one animation definition ([] = valid). */
export function validateAnimation(a) {
  const e = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (!/^\d{3}$/.test(a.id || '')) e.push(`id "${a.id}" must be three digits`);
  if (!/^[a-z0-9]+(_[a-zA-Z0-9]+)*$/.test(a.key || '')) e.push(`${a.id}: key "${a.key}" must be snake_case`);
  if (!a.title) e.push(`${a.id}: title missing`);
  if (!CATEGORIES.includes(a.category)) e.push(`${a.id}: category "${a.category}"`);
  if (!startStates(a).length || !startStates(a).every(isState)) e.push(`${a.id}: startState "${stateLabel(a.startState)}"`);
  if (!isState(a.endState)) e.push(`${a.id}: endState "${a.endState}"`);
  if (a.endResolves != null && !isState(a.endResolves)) e.push(`${a.id}: endResolves "${a.endResolves}"`);
  if (!(a.durationSec > 0 && a.durationSec <= 30)) e.push(`${a.id}: durationSec ${a.durationSec}`);
  if (typeof a.loop !== 'boolean') e.push(`${a.id}: loop must be boolean`);
  if (!HAND_ORDER.includes(a.ballHand)) e.push(`${a.id}: ballHand "${a.ballHand}"`);
  if (!DIRECTIONS.includes(a.direction)) e.push(`${a.id}: direction "${a.direction}"`);
  if (!SETUPS.includes(a.courtSetup)) e.push(`${a.id}: courtSetup "${a.courtSetup}"`);
  if (!Array.isArray(a.cues) || !a.cues.length) e.push(`${a.id}: cues missing`);
  if (a.loop && startStates(a).some((s) => s !== a.endState)) e.push(`${a.id}: a loop must start and end in the same state`);
  return e;
}

/** Problems with a whole library ([] = valid): every animation valid, ids and keys unique. */
export function validateLibrary(lib) {
  const e = [];
  if (!lib?.id || !Array.isArray(lib.animations)) return ['library needs id + animations'];
  const ids = new Set(), keys = new Set();
  for (const a of lib.animations) {
    e.push(...validateAnimation(a));
    if (ids.has(a.id)) e.push(`duplicate id ${a.id}`); ids.add(a.id);
    if (keys.has(a.key)) e.push(`duplicate key ${a.key}`); keys.add(a.key);
  }
  return e;
}

/** The state graph of a library: nodes = states, edges = animations (start → end). */
export function stateGraph(lib) {
  const edges = [];
  for (const a of lib.animations) for (const s of startStates(a)) edges.push({ from: s, to: a.endState, via: a.key, id: a.id, resolves: a.endResolves || null });
  const nodes = [...new Set(edges.flatMap((x) => [x.from, x.to]))];
  return { nodes, edges };
}
