/**
 * Game animation roles — the slots of the 3D animation set.
 *
 * A recorded motion becomes a game clip by being given a ROLE. The runtime
 * (public/js/anim3d.js, used by court3d.html) picks clips by role:
 *   loops   idle hub + locomotion blend space (fwd / back / left / right,
 *           sprint), phase-synced on foot plants, playback matched to the
 *           player's speed
 *   actions moves and shots with root motion, started from the best-matching
 *           frame of their entry window, feet carried over from the stance
 * Directions are in the clip's root frame: 0° = forward, +90° = the player's
 * LEFT, −90° = right, 180° = back.
 */
'use strict';

const ROLES = {
  idle: { type: 'loop', label: 'Idle dribble (hub stance)', group: 'loops', required: true, runtime: true },
  'loco-fwd': { type: 'loop', label: 'Dribble jog forward', group: 'locomotion', dir: 0, runtime: true },
  'loco-back': { type: 'loop', label: 'Backpedal dribble', group: 'locomotion', dir: 180, runtime: true },
  'loco-left': { type: 'loop', label: 'Slide / strafe left', group: 'locomotion', dir: 90, runtime: true },
  'loco-right': { type: 'loop', label: 'Slide / strafe right', group: 'locomotion', dir: -90, runtime: true },
  'loco-sprint': { type: 'loop', label: 'Speed dribble (sprint, R2)', group: 'locomotion', dir: 0, sprint: true, runtime: true },
  'shot-stepback': { type: 'action', label: 'Step-back jumper (move stick + hold □)', group: 'shots', trigger: 'shoot', runtime: true, shot: true },
  'shot-jumper': { type: 'action', label: 'Jump shot (hold □ standing still)', group: 'shots', trigger: 'shoot', runtime: true, shot: true },
  // moves: the right stick (court3d.html pro stick, engine3d/pro-stick.mjs) — a flick relative to his facing and the ball hand.
  // (The triggers in these labels are the DEFAULT bindings: the user sets each move's trigger in the move controls —
  // engine3d/move-controls.mjs, /api/mocap3d/controls; a new 'move-<name>' role needs no entry here, see roleDef.)
  'move-crossover': { type: 'action', label: 'Crossover (RS toward the free hand)', group: 'moves', trigger: 'move1', runtime: true, switchesHand: true },
  // (live on main as "right stick: flick left, then right"; in the pro stick that is the same flick pair seen from
  // the ball hand — the ball in the right hand: left, then right)
  'move-double-cross': { type: 'action', label: 'Double crossover (RS: flick toward the free hand, then straight back — ball in the right hand: left, then right · L)', group: 'moves', trigger: 'rs-left-right', runtime: true, switchesHand: false },
  'move-spin': { type: 'action', label: 'Spin move (RS ¼ or ½ circle)', group: 'moves', trigger: 'move2', runtime: true, switchesHand: true },
  'move-hesi': { type: 'action', label: 'Hesitation (RS forward)', group: 'moves', trigger: 'move3', runtime: true },
  'move-btl': { type: 'action', label: 'Between the legs (RS back-diagonal, free-hand side)', group: 'moves', trigger: 'move4', runtime: true, switchesHand: true },
  'move-btb': { type: 'action', label: 'Behind the back (RS straight back)', group: 'moves', runtime: true, switchesHand: true },
  'move-inout': { type: 'action', label: 'In-and-out (RS toward the ball hand)', group: 'moves', runtime: true },
  'move-stepback': { type: 'action', label: 'Step-back dribble (RS back-diagonal, ball-hand side)', group: 'moves', runtime: true },
  'move-sizeup': { type: 'action', label: 'Size-up (hold RS)', group: 'moves', runtime: true },
  'start-fwd': { type: 'action', label: 'Start (idle → jog)', group: 'transitions', runtime: false },
  stop: { type: 'action', label: 'Stop (jog → idle)', group: 'transitions', runtime: false },
  layup: { type: 'action', label: 'Layup', group: 'shots', runtime: false, shot: true },
};

/**
 * Best-guess role for a motion that was never assigned one. The recording
 * guide's naming convention (<family>-<action>-…) is read first, so
 * "move-crossover-idle-rl" is a crossover, not an idle; families without a
 * runtime role (start/stop/turn/cut/layup/calib) are never guessed into one.
 */
function guessRole(meta) {
  const name = String(meta?.name || '').toLowerCase();
  const fam = name.match(/^(calib|dribble|loco|start|stop|turn|cut|move|shot|layup)-([a-z0-9]+)/);
  if (fam) {
    const [, family, action] = fam;
    if (family === 'dribble') return action === 'idle' ? 'idle' : null;
    if (family === 'loco') return { jog: 'loco-fwd', walk: 'loco-fwd', run: 'loco-fwd', sprint: 'loco-sprint', backpedal: 'loco-back', strafe: /right/.test(name) ? 'loco-right' : 'loco-left', slide: /right/.test(name) ? 'loco-right' : 'loco-left' }[action] || null;
    if (family === 'move') return { crossover: 'move-crossover', cross: 'move-crossover', double: /double-?cross/.test(name) ? 'move-double-cross' : null, spin: 'move-spin', hesi: 'move-hesi', btl: 'move-btl', btb: 'move-btb', inout: 'move-inout', stepback: 'move-stepback', pullback: 'move-stepback', sizeup: 'move-sizeup' }[action] || null;
    if (family === 'shot') return action === 'stepback' ? 'shot-stepback' : 'shot-jumper';
    if (family === 'start') return 'start-fwd';
    if (family === 'stop') return 'stop';
    if (family === 'layup') return 'layup';
    return null; // calib, turn, cut: no game role yet
  }
  if (meta?.report?.shotRelease) return /step/i.test(name) ? 'shot-stepback' : 'shot-jumper';
  if (/double[ -]?cross/i.test(name)) return 'move-double-cross';
  if (/cross|spin|hesi|between|btl|behind/i.test(name)) return /cross/i.test(name) ? 'move-crossover' : /spin/i.test(name) ? 'move-spin' : /hesi/i.test(name) ? 'move-hesi' : /behind/i.test(name) ? 'move-btb' : 'move-btl';
  if (/idle|stance/i.test(name)) return 'idle';
  if (/sprint|speed/i.test(name)) return 'loco-sprint';
  if (/back ?pedal|retreat/i.test(name)) return 'loco-back';
  if (/strafe|slide|shuffle/i.test(name)) return /right/i.test(name) ? 'loco-right' : 'loco-left';
  if (/jog|run|walk|drive/i.test(name)) return 'loco-fwd';
  return null;
}

/**
 * Intended travel for roles whose travel the camera can't measure well
 * (clip units — the performer's metres; the runtime scales to the character).
 * Built from a first, unwarped build of the clip.
 */
function defaultWarps(role, clip) {
  if (role === 'shot-stepback' && clip?.shot?.stepFrame != null) {
    const s = clip.shot.stepFrame, F = clip.frameCount;
    const on = (i) => clip.contacts.left.on[i] || clip.contacts.right.on[i];
    let land = -1;
    for (let i = s + 1; i < F; i++) if (on(i) && !on(i - 1)) { land = i; break; }
    if (land < 0) land = Math.min(F - 1, clip.shot.releaseFrame);
    const hip = clip.stats?.hipHeight || 0.8;
    return [
      { from: s, to: land + 1, dx: 0, dz: -0.95 * (hip / 0.8) }, // the hop straight back
      { from: land + 1, to: F, dx: 0, dz: -0.08 * (hip / 0.8) },  // a slight fade on the jumper
    ];
  }
  return [];
}

/**
 * A new move: any 'move-<name>' role that is not in ROLES (a clip given it on /mocap or with
 * PUT /api/mocap3d/clip/:id { role }) is a runtime action like the built-in moves — the court loads it, the move
 * controls (engine3d/move-controls.mjs, the same rule) list it and bind it to a right-stick trigger.
 */
const CUSTOM_MOVE_RE = /^move-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isCustomMoveRole = (id) => typeof id === 'string' && id.length <= 48 && !Object.hasOwn(ROLES, id) && CUSTOM_MOVE_RE.test(id);
function customLabel(id) { const s = id.replace(/^move-/, '').replace(/-/g, ' '); return s[0].toUpperCase() + s.slice(1); }
/** The role's definition: ROLES', or a new move's; null for an unknown role. */
function roleDef(id) {
  if (Object.hasOwn(ROLES, id)) return ROLES[id];
  if (isCustomMoveRole(id)) return { type: 'action', label: `${customLabel(id)} (new move — set its trigger in the move controls)`, group: 'moves', runtime: true, custom: true };
  return null;
}
/** ROLES plus every new move role the given role ids use (the library's roles table). */
function rolesWith(ids = []) {
  const out = { ...ROLES };
  for (const id of ids) if (id && !out[id] && isCustomMoveRole(id)) out[id] = roleDef(id);
  return out;
}

module.exports = { ROLES, guessRole, defaultWarps, roleDef, rolesWith, isCustomMoveRole };
