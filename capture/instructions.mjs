/**
 * Soul Jam Capture — what the director tells the athlete for one animation: where to start and
 * finish (court marks and plain words), the start / finish pose, the protocol, and the cue (and
 * spoken word) for each second of the recording.
 *
 * A clip that starts in a MOVING state (moving dribble, sprint, defensive slide) begins with the
 * athlete already moving: he starts 2–3 steps before START and crosses it at speed — never "hold
 * the start pose". A clip that ends in a moving state keeps going through FINISH — never "hold the
 * finish pose". Only still states (stance, triple threat, stationary dribble, gather, defensive
 * stance, landing) get the 1 s holds.
 */
import { STATES, POSES, isMovingState, startStates } from './schema.mjs';
import { playerPath, spotWords } from './court-layout.mjs';
import { autoStopSec } from './protocol.mjs';

const DIR_WORDS = {
  none: 'on the spot', forward: 'toward the hoop', backward: 'backward (away from the hoop)', right: 'to your right', left: 'to your left',
  'forward-right': 'forward-right (toward the hoop, to your right)', 'forward-left': 'forward-left (toward the hoop, to your left)',
  'back-right': 'back-right (away from the hoop, to your right)', 'back-left': 'back-left (away from the hoop, to your left)',
  'to-basket': 'toward the hoop', up: 'straight up',
};
/** What "moving" is in a state, in words. */
const RUN = { MR: 'jog-dribbling with the right hand', ML: 'jog-dribbling with the left hand', N_SPRINT: 'sprinting', DEF_M: 'sliding' };

/** Does this clip begin with the athlete already moving (any of its start states is a moving one)? */
export const startsMoving = (a) => !a.loop && startStates(a).some(isMovingState);
/** Does this clip end with the athlete still moving (he keeps going through FINISH)? */
export const endsMoving = (a) => !a.loop && isMovingState(a.endState);

export const poseName = (s) => [].concat(s).map((x) => (STATES[x]?.name || x).replace(/\s*\(.*\)$/, '')).join(' — or — ');
export const poseDesc = (s) => [].concat(s).map((x) => POSES[x]).filter(Boolean).join(' Or: ');
const short = (s) => [].concat(s).map((x) => STATES[x]?.short || x).join(' / ');
const m1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)} m`;

/**
 * Everything the Record step and the recording overlay say about one animation.
 * @returns {{ path, moving, startMoving, endMoving, startWhere, startMarks, move, finishWhere, finishMarks,
 *             protocol, compact, prep, prepSub, phases: {at, cue, say}[] }}
 */
export function takeScript(a) {
  const path = playerPath(a), moving = path.lengthM > 0.1;
  const sm = startsMoving(a), em = endsMoving(a);
  const runIn = RUN[startStates(a).find(isMovingState)] || 'moving';
  const runOut = RUN[a.endState] || 'moving';
  const dir = DIR_WORDS[a.direction] || a.direction;
  const startMarks = spotWords(path.start), finishMarks = spotWords(path.end);
  let startWhere, move, finishWhere;
  if (a.loop) {
    startWhere = moving ? 'at the green START mark' : 'on the marked spot (START + FINISH)';
    move = moving ? `repeat ${dir}, START → FINISH (${m1(path.lengthM)}); walk back outside the lane and go again` : 'repeat on the spot at game speed';
    finishWhere = moving ? 'the last rep ends at the orange FINISH mark' : 'the same spot';
  } else {
    startWhere = sm ? `already ${runIn} as you cross START — begin 2–3 steps before it (away from the hoop)` : moving ? 'at the green START mark' : 'on the marked spot (START + FINISH)';
    move = moving ? `${dir}, along the arrow — about ${m1(path.lengthM)}` : 'on the spot';
    finishWhere = !moving ? (em ? `keep ${runOut} — don't stop` : 'the same spot')
      : em ? `keep ${runOut} through the orange FINISH mark for 1 s — don't stop (about ${m1(path.lengthM)} ${dir} from START)`
        : `at the orange FINISH mark — about ${m1(path.lengthM)} ${dir} from START`;
  }
  const d = a.durationSec;
  const protocol = a.loop
    ? `Loop: keep repeating the movement at game speed for ${d} s — no holds. It stops by itself.`
    : `${sm ? 'Cross START already moving' : 'Hold the start pose 1 s'} → do the move at game speed → ${em ? 'keep going through FINISH for 1 s (don\'t stop)' : 'hold the finish pose 1 s'}. It stops by itself after ${autoStopSec(a)} s.`;
  const endS = a.endResolves ? [a.endState] : a.endState;
  const compact = `START: ${short(a.startState)} → FINISH: ${short(endS)} · ${a.loop ? `repeat ${d} s` : `${sm ? 'moving in' : 'hold 1 s'} → move → ${em ? 'keep going' : 'hold 1 s'}`}`;
  const prep = a.loop ? (moving ? 'Get ready at START' : 'Get ready on the spot') : sm ? `Stand 2–3 steps before START` : 'Get into the start pose at START';
  const prepSub = a.loop ? `Then repeat at game speed for ${d} s.`
    : sm ? `Start ${runIn} on the last beep — cross START already moving, then the move${em ? ', and keep going through FINISH' : ', then hold the finish 1 s'}.`
      : `Then: hold 1 s → the move at game speed → ${em ? 'keep going through FINISH' : 'hold the finish 1 s'}.`;
  // the recording, second by second (`say` is spoken by the director device; never in the first
  // 0.6 s, where the sync chirp plays)
  let phases;
  if (a.loop) phases = [{ at: 0, cue: 'KEEP REPEATING — game speed', say: null }, { at: 0.6, cue: 'KEEP REPEATING — game speed', say: 'Go' }];
  else {
    phases = [
      { at: 0, cue: sm ? 'ALREADY MOVING → cross START' : 'HOLD THE START POSE', say: null },
      { at: 1, cue: 'GO — the move at game speed', say: sm ? null : 'Go' },
      { at: Math.max(1.5, d - 1), cue: em ? 'KEEP GOING through FINISH — don\'t stop' : 'HOLD THE FINISH POSE', say: em ? 'Keep going' : 'Hold' },
      { at: d, cue: em ? 'keep going… stopping' : 'hold… stopping', say: null },
    ];
  }
  return { path, moving, startMoving: sm, endMoving: em, startWhere, startMarks, move, finishWhere, finishMarks, protocol, compact, prep, prepSub, phases };
}
/** The phase of a recording `t` seconds in. */
export const phaseAt = (script, t) => [...script.phases].reverse().find((p) => t >= p.at) || script.phases[0];
