/**
 * BASIC-01 — Soul Jam's first capture library (82 animations). The ONE source of truth: the
 * director UI, the session order, the export and the processing all read this file.
 *
 * Court setups (capture/court-layout.mjs): A = stationary / dribble / locomotion / defense at the
 * top of the key · B = drives and pull-ups toward the basket · C = rim finishing.
 */
import { validateLibrary } from './schema.mjs';

const HAND = { R: 'right', L: 'left' };
const TITLE_DIR = { forward: 'FORWARD', backward: 'BACKWARD', right: 'RIGHT', left: 'LEFT', 'forward-right': 'FORWARD-RIGHT', 'forward-left': 'FORWARD-LEFT', 'back-right': 'BACK-RIGHT', 'back-left': 'BACK-LEFT' };

// a one-shot (hold → move → hold) or a loop
const one = (id, key, title, subtitle, category, startState, endState, durationSec, ballHand, direction, courtSetup, cues, extra = {}) =>
  ({ id, key, title, subtitle, category, startState, endState, durationSec, loop: false, ballHand, direction, courtSetup, cues, ...extra });
const loop = (id, key, title, subtitle, category, state, durationSec, ballHand, direction, courtSetup, cues, extra = {}) =>
  ({ id, key, title, subtitle, category, startState: state, endState: state, durationSec, loop: true, ballHand, direction, courtSetup, cues, ...extra });

const A = [];
// ── FOUNDATION
A.push(loop('001', 'neutral_idle', 'NEUTRAL IDLE', 'athletic stance', 'FOUNDATION', 'N', 8, 'none', 'none', 'A', ['Athletic stance, ball held loosely or no ball', 'Small natural weight shifts, breathing, look around'], { gameRoles: [] }));
A.push(loop('002', 'triple_threat_idle_R', 'TRIPLE THREAT', 'RIGHT', 'FOUNDATION', 'TR', 8, 'R', 'none', 'A', ['Triple threat, ball on the right hip', 'Small live movements: ball chinned/ripped slightly, eyes up']));
A.push(loop('003', 'triple_threat_idle_L', 'TRIPLE THREAT', 'LEFT', 'FOUNDATION', 'TL', 8, 'L', 'none', 'A', ['Triple threat, ball on the left hip', 'Small live movements, eyes up']));
A.push(loop('004', 'stationary_dribble_R', 'STATIONARY DRIBBLE', 'RIGHT HAND', 'FOUNDATION', 'DR', 8, 'R', 'none', 'A', ['Natural right-hand dribble in place, game rhythm', 'Stay in the marked spot'], { gameRoles: ['idle'] }));
A.push(loop('005', 'stationary_dribble_L', 'STATIONARY DRIBBLE', 'LEFT HAND', 'FOUNDATION', 'DL', 8, 'L', 'none', 'A', ['Natural left-hand dribble in place, game rhythm', 'Stay in the marked spot'], { gameRoles: ['idle'] }));
A.push(loop('006', 'protected_dribble_R', 'PROTECTED DRIBBLE', 'RIGHT HAND', 'FOUNDATION', 'DR', 8, 'R', 'none', 'A', ['Low protected dribble, right hand, off arm up as a bar', 'Body between the ball and an imaginary defender']));
A.push(loop('007', 'protected_dribble_L', 'PROTECTED DRIBBLE', 'LEFT HAND', 'FOUNDATION', 'DL', 8, 'L', 'none', 'A', ['Low protected dribble, left hand, off arm up as a bar', 'Body between the ball and an imaginary defender']));
// ── 360 DRIBBLE LOCOMOTION (008–023): right hand then left hand, eight directions each
const DIRS8 = ['forward', 'backward', 'right', 'left', 'forward-right', 'forward-left', 'back-right', 'back-left'];
const LOCO_ROLE = { forward: 'loco-fwd', backward: 'loco-back', right: 'loco-right', left: 'loco-left' };
let n = 8;
for (const h of ['R', 'L']) {
  for (const d of DIRS8) {
    const id = String(n++).padStart(3, '0');
    A.push(loop(id, `dribble_${d.replace('-', '_')}_${h}`, `DRIBBLE ${TITLE_DIR[d]}`, `${HAND[h].toUpperCase()} HAND`, 'LOCOMOTION', h === 'R' ? 'MR' : 'ML', 8, h, d, 'A',
      [`Jog-dribble ${d.replace('-', ' ')} with the ${HAND[h]} hand along the travel lane, facing the basket the whole time`, 'Walk back to the start outside the lane and repeat until the timer ends'],
      { gameRoles: LOCO_ROLE[d] ? [LOCO_ROLE[d]] : [] }));
  }
}
A.push(one('024', 'stationary_to_forward_R', 'START DRIBBLE', 'STATIONARY → FORWARD · RIGHT', 'LOCOMOTION', 'DR', 'MR', 5, 'R', 'forward', 'A', ['Stationary right dribble', 'Explode into a forward dribble jog, 3–4 steps'], { gameRoles: ['start-fwd'] }));
A.push(one('025', 'stationary_to_forward_L', 'START DRIBBLE', 'STATIONARY → FORWARD · LEFT', 'LOCOMOTION', 'DL', 'ML', 5, 'L', 'forward', 'A', ['Stationary left dribble', 'Explode into a forward dribble jog, 3–4 steps'], { gameRoles: ['start-fwd'] }));
A.push(one('026', 'forward_to_stationary_R', 'STOP DRIBBLE', 'FORWARD → STATIONARY · RIGHT', 'LOCOMOTION', 'MR', 'DR', 5, 'R', 'forward', 'A', ['Forward dribble jog, right hand', 'Plant and settle into a stationary right dribble'], { gameRoles: ['stop'] }));
A.push(one('027', 'forward_to_stationary_L', 'STOP DRIBBLE', 'FORWARD → STATIONARY · LEFT', 'LOCOMOTION', 'ML', 'DL', 5, 'L', 'forward', 'A', ['Forward dribble jog, left hand', 'Plant and settle into a stationary left dribble'], { gameRoles: ['stop'] }));
// ── TRIPLE THREAT
A.push(one('028', 'jab_R', 'JAB', 'RIGHT FOOT', 'TRIPLE_THREAT', 'TR', 'TR', 4, 'R', 'none', 'A', ['Triple threat right', 'Quick right-foot jab step, recover to triple threat']));
A.push(one('029', 'jab_L', 'JAB', 'LEFT FOOT', 'TRIPLE_THREAT', 'TR', 'TR', 4, 'R', 'none', 'A', ['Triple threat right', 'Quick left-foot jab step, recover to triple threat']));
A.push(one('030', 'hard_jab_R', 'HARD JAB', 'RIGHT FOOT', 'TRIPLE_THREAT', 'TR', 'TR', 4, 'R', 'none', 'A', ['Triple threat right', 'Long, sold right-foot jab (shoulders + ball), recover']));
A.push(one('031', 'hard_jab_L', 'HARD JAB', 'LEFT FOOT', 'TRIPLE_THREAT', 'TR', 'TR', 4, 'R', 'none', 'A', ['Triple threat right', 'Long, sold left-foot jab, recover']));
A.push(one('032', 'pump_fake', 'PUMP FAKE', 'TRIPLE THREAT', 'TRIPLE_THREAT', 'TR', 'TR', 4, 'both', 'none', 'A', ['Triple threat', 'Sell a shot: ball up to the forehead, heels down, back to triple threat']));
A.push(one('033', 'sweep_attack_R', 'SWEEP ATTACK', 'RIGHT', 'TRIPLE_THREAT', 'TR', 'MR', 5, 'R', 'to-basket', 'B', ['Triple threat', 'Sweep the ball low across, attack right with a right-hand dribble toward the basket']));
A.push(one('034', 'sweep_attack_L', 'SWEEP ATTACK', 'LEFT', 'TRIPLE_THREAT', 'TR', 'ML', 5, 'L', 'to-basket', 'B', ['Triple threat', 'Sweep the ball low across, attack left with a left-hand dribble toward the basket']));
A.push(one('035', 'jab_drive_R', 'JAB DRIVE', 'RIGHT', 'TRIPLE_THREAT', 'TR', 'MR', 5, 'R', 'to-basket', 'B', ['Triple threat', 'Jab right, then drive right with a right-hand dribble toward the basket']));
A.push(one('036', 'jab_drive_L', 'JAB DRIVE', 'LEFT', 'TRIPLE_THREAT', 'TR', 'ML', 5, 'L', 'to-basket', 'B', ['Triple threat', 'Jab, then cross-step drive left with a left-hand dribble toward the basket']));
// ── HANDLES
const hx = (id, key, title, sub, s, e, dur, hand, roles, cue) => one(id, key, title, sub, 'HANDLES', s, e, dur, hand, 'none', 'A', [`Stationary ${s === 'DR' ? 'right' : 'left'}-hand dribble`, cue, `Settle into the ${e === 'DR' ? 'right' : 'left'}-hand dribble`], { gameRoles: roles });
A.push(hx('037', 'cross_RL', 'CROSSOVER', 'RIGHT → LEFT', 'DR', 'DL', 4, 'R', ['move-crossover'], 'One hard crossover right → left at game speed'));
A.push(hx('038', 'cross_LR', 'CROSSOVER', 'LEFT → RIGHT', 'DL', 'DR', 4, 'L', ['move-crossover'], 'One hard crossover left → right at game speed'));
A.push(hx('039', 'tween_RL', 'BETWEEN THE LEGS', 'RIGHT → LEFT', 'DR', 'DL', 4, 'R', ['move-btl'], 'One between-the-legs right → left'));
A.push(hx('040', 'tween_LR', 'BETWEEN THE LEGS', 'LEFT → RIGHT', 'DL', 'DR', 4, 'L', ['move-btl'], 'One between-the-legs left → right'));
A.push(hx('041', 'behind_RL', 'BEHIND THE BACK', 'RIGHT → LEFT', 'DR', 'DL', 4, 'R', ['move-btb'], 'One behind-the-back right → left'));
A.push(hx('042', 'behind_LR', 'BEHIND THE BACK', 'LEFT → RIGHT', 'DL', 'DR', 4, 'L', ['move-btb'], 'One behind-the-back left → right'));
A.push(hx('043', 'hesi_R', 'HESITATION', 'RIGHT', 'DR', 'DR', 4, 'R', ['move-hesi'], 'One hesitation: freeze high, then go again'));
A.push(hx('044', 'hesi_L', 'HESITATION', 'LEFT', 'DL', 'DL', 4, 'L', ['move-hesi'], 'One hesitation: freeze high, then go again'));
A.push(hx('045', 'in_out_R', 'IN & OUT', 'RIGHT', 'DR', 'DR', 4, 'R', [], 'One in-and-out with the right hand'));
A.push(hx('046', 'in_out_L', 'IN & OUT', 'LEFT', 'DL', 'DL', 4, 'L', [], 'One in-and-out with the left hand'));
A.push(hx('047', 'hesi_cross_RL', 'HESI CROSS', 'RIGHT → LEFT', 'DR', 'DL', 5, 'R', ['move-crossover'], 'Hesitation, then a crossover right → left'));
A.push(hx('048', 'hesi_cross_LR', 'HESI CROSS', 'LEFT → RIGHT', 'DL', 'DR', 5, 'L', ['move-crossover'], 'Hesitation, then a crossover left → right'));
A.push(one('049', 'pullback_R', 'PULLBACK', 'RIGHT', 'HANDLES', 'MR', 'DR', 5, 'R', 'backward', 'A', ['Forward dribble jog, right hand', 'Two-step pull-back dribble, settle stationary right'], { gameRoles: [] }));
A.push(one('050', 'pullback_L', 'PULLBACK', 'LEFT', 'HANDLES', 'ML', 'DL', 5, 'L', 'backward', 'A', ['Forward dribble jog, left hand', 'Two-step pull-back dribble, settle stationary left'], { gameRoles: [] }));
A.push(one('051', 'stepback_R', 'STEP-BACK', 'RIGHT', 'HANDLES', 'DR', 'DR', 5, 'R', 'backward', 'A', ['Stationary right dribble', 'One hard step-back, keep dribbling right']));
A.push(one('052', 'stepback_L', 'STEP-BACK', 'LEFT', 'HANDLES', 'DL', 'DL', 5, 'L', 'backward', 'A', ['Stationary left dribble', 'One hard step-back, keep dribbling left']));
// ── SHOOTING
A.push(one('053', 'gather_R', 'GATHER', 'FROM RIGHT DRIBBLE', 'SHOOTING', 'DR', 'G', 4, 'R', 'none', 'A', ['Stationary right dribble', 'Gather into the two-hand shooting pocket and hold']));
A.push(one('054', 'gather_L', 'GATHER', 'FROM LEFT DRIBBLE', 'SHOOTING', 'DL', 'G', 4, 'L', 'none', 'A', ['Stationary left dribble', 'Gather into the two-hand shooting pocket and hold']));
A.push(one('055', 'moving_gather_R', 'MOVING GATHER', 'RIGHT', 'SHOOTING', 'MR', 'G', 4, 'R', 'to-basket', 'B', ['Dribble jog toward the basket, right hand', 'Gather into the shooting pocket on a 1-2 stop and hold']));
A.push(one('056', 'moving_gather_L', 'MOVING GATHER', 'LEFT', 'SHOOTING', 'ML', 'G', 4, 'L', 'to-basket', 'B', ['Dribble jog toward the basket, left hand', 'Gather into the shooting pocket on a 1-2 stop and hold']));
A.push(one('057', 'jumpshot', 'JUMP SHOT', 'FROM THE POCKET', 'SHOOTING', 'G', 'LAND', 6, 'both', 'up', 'A', ['Ball in the shooting pocket', 'Full jump shot at game speed, land balanced and hold'], { endResolves: 'N', gameRoles: ['shot-jumper'] }));
A.push(one('058', 'catch_jumpshot', 'CATCH & SHOOT', 'JUMP SHOT', 'SHOOTING', 'N', 'LAND', 6, 'both', 'up', 'A', ['Neutral stance, hands ready', 'A partner passes; catch, jump shot, land balanced and hold'], { endResolves: 'N', gameRoles: ['shot-jumper'] }));
A.push(one('059', 'pullup_R', 'PULL-UP', 'GOING RIGHT', 'SHOOTING', 'MR', 'LAND', 6, 'R', 'to-basket', 'B', ['Dribble jog toward the basket, right hand', 'Pull up into a jump shot, land balanced and hold'], { endResolves: 'N', gameRoles: ['shot-jumper'] }));
A.push(one('060', 'pullup_L', 'PULL-UP', 'GOING LEFT', 'SHOOTING', 'ML', 'LAND', 6, 'L', 'to-basket', 'B', ['Dribble jog toward the basket, left hand', 'Pull up into a jump shot, land balanced and hold'], { endResolves: 'N', gameRoles: ['shot-jumper'] }));
A.push(one('061', 'stepback_jumper', 'STEP-BACK JUMPER', 'RIGHT HAND', 'SHOOTING', 'DR', 'LAND', 6, 'R', 'backward', 'A', ['Stationary right dribble', 'Step back into a jump shot, land balanced and hold'], { endResolves: 'N', gameRoles: ['shot-stepback'] }));
// ── FINISHING
A.push(one('062', 'layup_R', 'LAYUP', 'RIGHT HAND', 'FINISHING', 'MR', 'LAND', 7, 'R', 'to-basket', 'C', ['Drive from the wing with the right hand', 'Right-hand layup off the left foot, land balanced and hold'], { endResolves: 'N', gameRoles: ['layup'] }));
A.push(one('063', 'layup_L', 'LAYUP', 'LEFT HAND', 'FINISHING', 'ML', 'LAND', 7, 'L', 'to-basket', 'C', ['Drive from the wing with the left hand', 'Left-hand layup off the right foot, land balanced and hold'], { endResolves: 'N', gameRoles: ['layup'] }));
A.push(one('064', 'drive_gather_R', 'DRIVE GATHER', 'RIGHT', 'FINISHING', 'MR', 'G', 5, 'R', 'to-basket', 'C', ['Drive toward the rim with the right hand', 'Gather two hands at the finish spot and hold']));
A.push(one('065', 'drive_gather_L', 'DRIVE GATHER', 'LEFT', 'FINISHING', 'ML', 'G', 5, 'L', 'to-basket', 'C', ['Drive toward the rim with the left hand', 'Gather two hands at the finish spot and hold']));
A.push(one('066', 'two_foot_finish', 'TWO-FOOT FINISH', 'POWER', 'FINISHING', ['G', 'MR', 'ML'], 'LAND', 7, 'both', 'to-basket', 'C', ['From a gather (or the drive)', 'Two-foot power jump finish at the rim, land balanced and hold'], { endResolves: 'N', gameRoles: ['layup'] }));
A.push(one('067', 'floater_R', 'FLOATER', 'RIGHT HAND', 'FINISHING', 'MR', 'LAND', 6, 'R', 'to-basket', 'C', ['Drive with the right hand', 'One-hand floater over an imaginary big, land balanced and hold'], { endResolves: 'N' }));
A.push(one('068', 'floater_L', 'FLOATER', 'LEFT HAND', 'FINISHING', 'ML', 'LAND', 6, 'L', 'to-basket', 'C', ['Drive with the left hand', 'One-hand floater, land balanced and hold'], { endResolves: 'N' }));
// ── DEFENSE
A.push(loop('069', 'defense_idle', 'DEFENSE', 'STANCE', 'DEFENSE', 'DEF', 8, 'none', 'none', 'A', ['Defensive stance: low, active hands, stay on the spot']));
const DEF_DIRS = ['right', 'left', 'forward', 'backward', 'forward-right', 'forward-left', 'back-right', 'back-left'];
n = 70;
for (const d of DEF_DIRS) {
  const id = String(n++).padStart(3, '0');
  A.push(loop(id, `defense_${d.replace('-', '_')}`, `DEFENSE ${TITLE_DIR[d]}`, 'SLIDE', 'DEFENSE', 'DEF_M', 8, 'none', d, 'A', [`Defensive ${d === 'forward' || d === 'backward' ? 'shuffle' : 'slide'} ${d.replace('-', ' ')} along the lane, stay low, never cross the feet`, 'Reset outside the lane and repeat until the timer ends']));
}
A.push(one('078', 'defense_to_sprint', 'DEFENSE → SPRINT', 'OPEN AND GO', 'DEFENSE', 'DEF', 'N_SPRINT', 5, 'none', 'forward', 'A', ['Defensive stance', 'Open the hips and sprint out 3–4 steps']));
A.push(one('079', 'sprint_to_defense', 'SPRINT → DEFENSE', 'BREAK DOWN', 'DEFENSE', 'N_SPRINT', 'DEF', 5, 'none', 'forward', 'A', ['Sprint in', 'Break down into a defensive stance and hold']));
A.push(one('080', 'closeout', 'CLOSEOUT', 'CHOP FEET', 'DEFENSE', 'N_SPRINT', 'DEF', 6, 'none', 'forward', 'A', ['Sprint toward a shooter', 'Chop the feet, hand high, settle in stance']));
A.push(one('081', 'hands_up_contest', 'HANDS-UP CONTEST', 'VERTICAL', 'DEFENSE', 'DEF', 'DEF', 5, 'none', 'none', 'A', ['Defensive stance', 'Both hands straight up, no jump, back to stance']));
A.push(one('082', 'jump_contest', 'JUMP CONTEST', 'VERTICAL', 'DEFENSE', 'DEF', 'DEF', 6, 'none', 'up', 'A', ['Defensive stance', 'Vertical jump contest, land balanced, back to stance']));

export const BASIC01 = Object.freeze({
  id: 'BASIC-01',
  name: 'Soul Jam BASIC-01',
  version: 1,
  description: 'The foundation library: stances, stationary + 360° dribble locomotion, triple threat, handles, shooting, finishing and defense (82 animations).',
  animations: A,
});

const problems = validateLibrary(BASIC01);
if (problems.length) throw new Error('BASIC-01 is invalid: ' + problems.join('; '));

export const LIBRARIES = { 'BASIC-01': BASIC01 };
