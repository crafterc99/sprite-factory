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
  'move-crossover': { type: 'action', label: 'Crossover (○)', group: 'moves', trigger: 'move1', runtime: true, switchesHand: true },
  'move-spin': { type: 'action', label: 'Spin move (△)', group: 'moves', trigger: 'move2', runtime: true, switchesHand: true },
  'move-hesi': { type: 'action', label: 'Hesitation (✕)', group: 'moves', trigger: 'move3', runtime: true },
  'move-btl': { type: 'action', label: 'Between the legs (R1)', group: 'moves', trigger: 'move4', runtime: true, switchesHand: true },
  'move-double-cross': { type: 'action', label: 'Double crossover (right stick: flick left, then right)', group: 'moves', trigger: 'rs-left-right', runtime: true, switchesHand: false },
  'move-btb': { type: 'action', label: 'Behind the back', group: 'moves', runtime: false, switchesHand: true },
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
    if (family === 'move') return { crossover: 'move-crossover', cross: 'move-crossover', spin: 'move-spin', hesi: 'move-hesi', btl: 'move-btl', btb: 'move-btb' }[action] || null;
    if (family === 'shot') return action === 'stepback' ? 'shot-stepback' : 'shot-jumper';
    if (family === 'start') return 'start-fwd';
    if (family === 'stop') return 'stop';
    if (family === 'layup') return 'layup';
    return null; // calib, turn, cut: no game role yet
  }
  if (meta?.report?.shotRelease) return /step/i.test(name) ? 'shot-stepback' : 'shot-jumper';
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

module.exports = { ROLES, guessRole, defaultWarps };
