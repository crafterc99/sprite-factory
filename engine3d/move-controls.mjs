/**
 * Move controls — the data model of the right-stick move bindings (the user's "move control setting"): which
 * stick gesture, or sequence of gestures, plays which move. Pure JS with no imports: the court (as
 * /js/move-controls.mjs), the recognizer (engine3d/pro-stick.mjs MoveControls), the node tests and the server
 * (routes/mocap.js /api/mocap3d/controls: validation, defaults, conflicts, the move registry) share it.
 *
 * Stored as compact JSON (data/move-controls.json, mirrored to the bucket as _meta/move-controls.json):
 *
 *   { "version": 1, "bindings": [
 *       { "role": "move-crossover", "steps": [{ "flick": 270 }] },
 *       { "role": "move-pullback-cross", "steps": [{ "flick": 225 }, { "flick": 90 }], "mode": "wait" } ] }
 *
 * A binding: { role, steps: [1 … MAX_STEPS], mirror?: false, mode?: 'wait', fallback?: [role …] }
 *   role      the move (a game role, 'move-…'; a custom 'move-<name>' role works the same — a clip given it on
 *             /mocap or with PUT /api/mocap3d/clip/:id { role } is a new move)
 *   mirror    true (default, left out): read relative to the ball hand — 90 is toward the ball hand, 270 toward the
 *             free hand, with the ball in the left hand the whole trigger is mirrored (2K). false: his own left /
 *             right whatever the hand (90 = his right).
 *   mode      a combo's first steps may be a move of their own: 'upgrade' (default, left out) plays that move at once
 *             and upgrades to the combo when the next step completes it in time (as the double crossover always
 *             did from the crossover); 'wait' plays nothing until the combo is complete or can no longer be.
 *   fallback  roles to play, best first, when this move has no clip ('#handSwitch' = the crossover dribble);
 *             default ROLE_FALLBACKS.
 * A step (one gesture) has exactly one of
 *   { flick: deg }                     out and back toward deg
 *   { hold: deg | 'any', ms? }         held out (at the rim, steady) toward deg / anywhere, for ≥ ms (default 220)
 *   { spin: 'cw' | 'ccw' | 'any', turn? }   a circle: ≥ a quarter (turn 90, default) or a half (180) …
 *   { release: true }                  let go back to the centre (after a hold or a circle)
 * and optionally gap (ms: the longest wait for the NEXT step, default 350) and tol (deg: how far a flick / hold
 * may be off its angle and still be this step, default 22.5).
 *
 * Angles: degrees in the player's own frame AS IF THE BALL WERE IN HIS RIGHT HAND — 0 = forward (stick up behind
 * him), 90 = right (the ball hand), 180 = back, 270 = left (the free hand); stored at 45° (22.5° allowed). cw =
 * from forward toward the ball hand (right).
 */

export const CONTROLS_VERSION = 1;
export const ANGLE_RES = 22.5;          // the finest stored angle (45° is the usual)
export const DEFAULT_TOL = 22.5;        // a flick / hold within this of a step's angle is that step
export const DEFAULT_GAP = 350;         // ms from a step to the next, at most (a step's gap overrides)
export const DEFAULT_HOLD_MS = 220;     // the recognizer's hold (engine3d/pro-stick.mjs PRO_STICK_DEFAULTS.holdMs)
export const MAX_STEPS = 6;
export const MAX_BINDINGS = 64;
export const KINDS = ['flick', 'hold', 'spin', 'release'];
export const SPIN_TURNS = [90, 180, 270, 360];
/** The crossover dribble (the idle's mirror) — the last fallback of a hand-changing move with no clip. */
export const HAND_SWITCH = '#handSwitch';
/** A move role: the game's ('move-crossover') or a new one ('move-pullback-cross'). (lib/mocap/game-roles.js has the same rule.) */
export const MOVE_ROLE_RE = /^move-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isMoveRole = (r) => typeof r === 'string' && r.length <= 48 && MOVE_ROLE_RE.test(r);

/**
 * The defaults: exactly the pro stick's fixed mapping before bindings (engine3d/pro-stick.mjs), at 45°. The order
 * breaks exact ties (an exact diagonal between two moves goes to the one listed first: the lateral moves, as the old
 * sectors did).
 */
export const DEFAULT_BINDINGS = deepFreeze([
  { role: 'move-crossover', steps: [{ flick: 270 }] },                               // toward the free hand
  { role: 'move-inout', steps: [{ flick: 90 }] },                                    // toward the ball hand
  { role: 'move-btl', steps: [{ flick: 225 }] },                                     // back-diagonal, free side
  { role: 'move-stepback', steps: [{ flick: 135 }] },                                // back-diagonal, ball side
  { role: 'move-btb', steps: [{ flick: 180 }] },                                     // straight back
  { role: 'move-hesi', steps: [{ flick: 0 }] },                                      // forward
  { role: 'move-spin', steps: [{ spin: 'any' }] },                                   // a ¼ or ½ circle
  { role: 'move-sizeup', steps: [{ hold: 'any' }] },                                 // held anywhere
  // the double crossover: a crossover flick, then within 0.5 s a flick straight back (≥ 120° from it: 90 ± 60) — ball in
  // the right hand: left, then right. The crossover plays at once and upgrades.
  { role: 'move-double-cross', steps: [{ flick: 270, gap: 500 }, { flick: 90, tol: 60 }] },
]);
/** What a move with no clip plays instead, best first (the pro stick's old chains). A binding's own fallback overrides. */
export const ROLE_FALLBACKS = deepFreeze({
  'move-inout': ['move-hesi'],
  'move-crossover': [HAND_SWITCH],
  'move-btl': ['move-crossover', HAND_SWITCH],
  'move-btb': ['move-btl', 'move-crossover', HAND_SWITCH],
});
/** The game's moves under the names the pro stick always logged them by (court3d.html window.__stick, the tests). */
export const ROLE_GESTURE = deepFreeze({ 'move-hesi': 'hesi', 'move-inout': 'inout', 'move-crossover': 'crossover', 'move-btl': 'btl', 'move-btb': 'btb', 'move-stepback': 'stepback', 'move-spin': 'spin', 'move-sizeup': 'sizeup', 'move-double-cross': 'doublecross' });
export const GESTURE_NAMES = deepFreeze({ hesi: 'Hesitation', inout: 'In-and-out', crossover: 'Crossover', btl: 'Between the legs', btb: 'Behind the back', stepback: 'Step-back', spin: 'Spin', sizeup: 'Size-up', doublecross: 'Double crossover' });

function deepFreeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }
const clone = (o) => JSON.parse(JSON.stringify(o));
export const norm360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
export const angDist = (a, b) => Math.abs(wrap180(a - b));
/** An angle to the stored resolution (45°, or 22.5° with fine). */
export const quantizeAngle = (a, res = 45) => norm360(Math.round(norm360(a) / res) * res);

/** A fresh copy of the default controls. */
export function defaultControls() { return { version: CONTROLS_VERSION, bindings: clone(DEFAULT_BINDINGS) }; }

/**
 * A move's name: the game's moves by their names, others by the roles table's label without its parenthesis (the
 * roles' labels carry their old fixed triggers), a new role from its id: 'move-pullback-cross' → 'Pullback cross'.
 */
export function roleLabel(role, roles = null) {
  const n = ROLE_GESTURE[role];
  if (n) return GESTURE_NAMES[n];
  const def = roles?.[role];
  if (def?.label) return String(def.label).replace(/\s*\(.*\)\s*$/, '') || String(def.label);
  const s = String(role || '').replace(/^move-/, '').replace(/-/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : String(role);
}

// ── validation ────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const angleOf = (v) => (isNum(v) ? norm360(Math.round(norm360(v) / ANGLE_RES) * ANGLE_RES) : null);
const STEP_KEYS = new Set([...KINDS, 'gap', 'tol', 'ms', 'turn']);

/** One step → { ok, step (clean, in the stored key order), error }. Angles are rounded to 22.5°. */
export function normalizeStep(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'a step must be an object' };
  const kinds = KINDS.filter((k) => k in s);
  if (kinds.length !== 1) return { ok: false, error: `a step needs exactly one of ${KINDS.join(' / ')}` };
  for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) return { ok: false, error: `unknown step key "${k}"` };
  const kind = kinds[0], v = s[kind], out = {};
  if (kind === 'flick') { const a = angleOf(v); if (a == null) return { ok: false, error: 'flick: an angle in degrees (0 forward, 90 the ball hand, 180 back, 270 the free hand)' }; out.flick = a; }
  if (kind === 'hold') {
    if (v === 'any' || v === true) out.hold = 'any';
    else { const a = angleOf(v); if (a == null) return { ok: false, error: 'hold: an angle in degrees or "any"' }; out.hold = a; }
    if ('ms' in s) { if (!(Number.isInteger(s.ms) && s.ms >= 100 && s.ms <= 3000)) return { ok: false, error: 'hold ms: a whole number of milliseconds, 100…3000' }; if (s.ms > DEFAULT_HOLD_MS) out.ms = s.ms; }
  } else if ('ms' in s) return { ok: false, error: 'ms is for a hold' };
  if (kind === 'spin') {
    if (!['cw', 'ccw', 'any'].includes(v)) return { ok: false, error: 'spin: "cw", "ccw" or "any"' };
    out.spin = v;
    if ('turn' in s) { if (!SPIN_TURNS.includes(s.turn)) return { ok: false, error: `spin turn: one of ${SPIN_TURNS.join(', ')} (degrees)` }; if (s.turn > 90) out.turn = s.turn; }
  } else if ('turn' in s) return { ok: false, error: 'turn is for a spin' };
  if (kind === 'release') { if (v !== true) return { ok: false, error: 'release: true' }; out.release = true; }
  if ('tol' in s) {
    if (kind !== 'flick' && kind !== 'hold') return { ok: false, error: 'tol is for a flick or a hold' };
    if (!(isNum(s.tol) && s.tol >= 5 && s.tol <= 90)) return { ok: false, error: 'tol: 5…90 degrees' };
    if (s.tol !== DEFAULT_TOL) out.tol = +s.tol.toFixed(1);
  }
  if ('gap' in s) { if (!(Number.isInteger(s.gap) && s.gap >= 80 && s.gap <= 2000)) return { ok: false, error: 'gap: a whole number of milliseconds, 80…2000' }; if (s.gap !== DEFAULT_GAP) out.gap = s.gap; }
  return { ok: true, step: out };
}

/** One binding → { ok, binding (clean, compact), errors }. */
export function normalizeBinding(b, { roleOk = isMoveRole } = {}) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['a binding must be an object'] };
  const role = b.role;
  if (!roleOk(role)) errors.push(`role "${String(role).slice(0, 60)}": a move role (move-…; shots are on the shot button)`);
  const steps = [];
  if (!Array.isArray(b.steps) || !b.steps.length) errors.push('steps: 1 or more gestures');
  else if (b.steps.length > MAX_STEPS) errors.push(`steps: at most ${MAX_STEPS}`);
  else b.steps.forEach((s, i) => { const r = normalizeStep(s); if (!r.ok) errors.push(`step ${i + 1}: ${r.error}`); else steps.push(r.step); });
  if (steps.length === b.steps?.length) {
    steps.forEach((s, i) => {
      if ('release' in s && (i === 0 || !('hold' in steps[i - 1] || 'spin' in steps[i - 1]))) errors.push(`step ${i + 1}: a release follows a hold or a circle`);
    });
    if (steps.length && 'gap' in steps[steps.length - 1]) delete steps[steps.length - 1].gap;   // (nothing follows the last step)
  }
  if ('mirror' in b && typeof b.mirror !== 'boolean') errors.push('mirror: true or false');
  if ('mode' in b && !['upgrade', 'wait'].includes(b.mode)) errors.push('mode: "upgrade" or "wait"');
  let fallback;
  if ('fallback' in b && b.fallback != null) {
    if (!Array.isArray(b.fallback) || b.fallback.length > 4 || !b.fallback.every((r) => r === HAND_SWITCH || isMoveRole(r))) errors.push(`fallback: up to 4 move roles (or "${HAND_SWITCH}")`);
    else fallback = b.fallback.slice();
  }
  for (const k of Object.keys(b)) if (!['role', 'steps', 'mirror', 'mode', 'fallback'].includes(k)) errors.push(`unknown binding key "${k}"`);
  if (errors.length) return { ok: false, errors };
  const out = { role, steps };
  if (b.mirror === false) out.mirror = false;
  if (b.mode === 'wait' && steps.length > 1) out.mode = 'wait';
  if (fallback) out.fallback = fallback;
  return { ok: true, binding: out, errors: [] };
}

/**
 * The controls (an object { bindings } or the bindings array) → { ok, errors, clean: { version, bindings }, conflicts }.
 * Two bindings with the same trigger are an error (only one of them could ever play); prefix overlaps (a single
 * move that a combo starts with) are fine — they are what upgrades are — and come back in conflicts.
 */
export function validateControls(o) {
  const list = Array.isArray(o) ? o : o && typeof o === 'object' ? o.bindings : null;
  if (!Array.isArray(list)) return { ok: false, errors: ['bindings: an array'] };
  if (list.length > MAX_BINDINGS) return { ok: false, errors: [`bindings: at most ${MAX_BINDINGS}`] };
  const errors = [], bindings = [];
  list.forEach((b, i) => { const r = normalizeBinding(b); if (!r.ok) errors.push(...r.errors.map((e) => `binding ${i + 1}${b?.role ? ` (${String(b.role).slice(0, 40)})` : ''}: ${e}`)); else bindings.push(r.binding); });
  if (errors.length) return { ok: false, errors };
  const conflicts = allConflicts(bindings);
  for (const c of conflicts) if (c.type === 'same') errors.push(`${c.a} and ${c.b} have the same trigger (${describeBinding(bindings.find((x) => x.role === c.a))}${c.hand ? `, ball in the ${c.hand} hand` : ''})`);
  if (errors.length) return { ok: false, errors, conflicts };
  return { ok: true, errors: [], clean: { version: CONTROLS_VERSION, bindings }, conflicts };
}

// ── conflicts ─────────────────────────────────────────────────────────────
const mirrorA = (a) => (a === 'any' ? a : norm360(360 - a));
const mirrorSense = (s) => (s === 'cw' ? 'ccw' : s === 'ccw' ? 'cw' : s);
/** A binding's steps as they read with the ball in `hand`, in his own frame (90 = his right): mirrored ones flip in the left hand. */
export function stepsInHand(b, hand) {
  const flip = hand === 'left' && b.mirror !== false;
  return b.steps.map((s) => {
    if ('flick' in s) return { ...s, flick: flip ? mirrorA(s.flick) : s.flick };
    if ('hold' in s) return { ...s, hold: flip ? mirrorA(s.hold) : s.hold };
    if ('spin' in s) return { ...s, spin: flip ? mirrorSense(s.spin) : s.spin };
    return { ...s };
  });
}
const kindOf = (s) => KINDS.find((k) => k in s);
/** Two steps (same frame): 'same' (one trigger), 'overlap' (some gesture is both), or null. */
export function stepRelation(p, q) {
  const k = kindOf(p);
  if (k !== kindOf(q)) return null;
  if (k === 'release') return 'same';
  if (k === 'spin') {
    const tp = p.turn || 90, tq = q.turn || 90;
    if (p.spin === q.spin && tp === tq) return 'same';
    return p.spin === 'any' || q.spin === 'any' || p.spin === q.spin ? 'overlap' : null;
  }
  const v = k === 'flick' ? 'flick' : 'hold', a = p[v], b = q[v];
  if (k === 'hold' && (p.ms || 0) !== (q.ms || 0)) return a === 'any' || b === 'any' || angDist(a, b) < (p.tol ?? DEFAULT_TOL) + (q.tol ?? DEFAULT_TOL) ? 'overlap' : null;
  if (a === b) return 'same';
  if (a === 'any' || b === 'any') return 'overlap';
  return angDist(a, b) < (p.tol ?? DEFAULT_TOL) + (q.tol ?? DEFAULT_TOL) ? 'overlap' : null;
}
/**
 * How binding x relates to binding y: 'same' (the same trigger), 'prefix' (x is how y starts: x plays first, y
 * upgrades / waits), 'extends' (y is how x starts), 'overlap' (some gesture sequence is both) — or null.
 * Checked with the ball in either hand (a mirrored and an unmirrored binding can meet in one hand only).
 */
export function relation(x, y) {
  let best = null, hand = null;
  const rank = { same: 4, prefix: 3, extends: 3, overlap: 1 };
  for (const h of ['right', 'left']) {
    const a = stepsInHand(x, h), b = stepsInHand(y, h), n = Math.min(a.length, b.length);
    let r = 'same';
    for (let i = 0; i < n && r; i++) { const s = stepRelation(a[i], b[i]); r = !s ? null : s === 'overlap' || r === 'overlap' ? 'overlap' : 'same'; }
    if (!r) continue;
    const t = a.length === b.length ? r : r === 'same' ? (a.length < b.length ? 'prefix' : 'extends') : 'overlap';
    if (!best || rank[t] > rank[best]) { best = t; hand = h; }
  }
  if (!best) return null;
  // (the same in one hand only: name it)
  const both = best === 'same' && ['right', 'left'].every((h) => { const a = stepsInHand(x, h), b = stepsInHand(y, h); return a.length === b.length && a.every((s, i) => stepRelation(s, b[i]) === 'same'); });
  return { type: best, hand: best === 'same' && !both ? hand : null };
}
/** Every binding x conflicts with (y ≠ x by identity): [{ role, type, hand, steps, text }]. */
export function conflictsOf(x, bindings) {
  const out = [];
  for (const y of bindings) {
    if (y === x) continue;
    const r = relation(x, y);
    if (r) out.push({ role: y.role, type: r.type, hand: r.hand, steps: y.steps, text: conflictText(x, y, r) });
  }
  return out;
}
function conflictText(x, y, r) {
  const yn = roleLabel(y.role);
  if (r.type === 'same') return `${yn} already has this trigger${r.hand ? ` (ball in the ${r.hand} hand)` : ''}`;
  if (r.type === 'prefix') return `${yn} starts with this trigger: ${roleLabel(x.role)} plays first, then ${y.mode === 'wait' ? 'waits for' : 'upgrades to'} ${yn}`;
  if (r.type === 'extends') return `starts with ${yn}'s trigger: ${yn} plays first, then ${x.mode === 'wait' ? 'waits for' : 'upgrades to'} this`;
  return `overlaps ${yn} (some gestures read as both — the nearer wins)`;
}
/** Every pair of bindings that relate: [{ a, b, type, hand }]. */
export function allConflicts(bindings) {
  const out = [];
  for (let i = 0; i < bindings.length; i++) for (let j = i + 1; j < bindings.length; j++) {
    const r = relation(bindings[i], bindings[j]);
    if (r) out.push({ a: bindings[i].role, b: bindings[j].role, type: r.type, hand: r.hand });
  }
  return out;
}

// ── words (the UI, notes, the debug panel) ────────────────────────────────
const DIRS = { 0: 'forward', 45: 'forward, ball-hand side', 90: 'toward the ball hand', 135: 'back, ball-hand side', 180: 'back', 225: 'back, free-hand side', 270: 'toward the free hand', 315: 'forward, free-hand side' };
const DIRS_ABS = { 0: 'forward', 45: 'forward right', 90: 'right', 135: 'back right', 180: 'back', 225: 'back left', 270: 'left', 315: 'forward left' };
const ARROWS = { 0: '↑', 45: '↗', 90: '→', 135: '↘', 180: '↓', 225: '↙', 270: '←', 315: '↖' };
/** The stick arrow for an angle (ball in the right hand behind him): 270 → ←. */
export const arrowOf = (a) => (a === 'any' ? '•' : ARROWS[a] || `${a}°`);
/** One step in words: { flick: 225 } → 'flick back, free-hand side (225°)'. */
export function describeStep(s, { mirror = true } = {}) {
  const dir = (a) => (a === 'any' ? 'anywhere' : `${(mirror ? DIRS : DIRS_ABS)[a] || 'at'} (${a}°)`);
  if ('flick' in s) return `flick ${dir(s.flick)}`;
  if ('hold' in s) return `hold ${dir(s.hold)}${s.ms ? ` ≥ ${s.ms} ms` : ''}`;
  if ('spin' in s) { const t = s.turn || 90, f = { 90: '¼', 180: '½', 270: '¾', 360: 'full' }[t]; return `${f} circle${s.spin === 'any' ? '' : s.spin === 'cw' ? (mirror ? ' toward the ball hand' : ' clockwise') : mirror ? ' toward the free hand' : ' counter-clockwise'}`; }
  return 'let go';
}
/** A binding in words: 'flick toward the free hand (270°) → within 500 ms flick toward the ball hand (90°)'. */
export function describeBinding(b) {
  if (!b) return '—';
  const mirror = b.mirror !== false;
  return b.steps.map((s, i) => (i ? `${b.steps[i - 1].gap && b.steps[i - 1].gap !== DEFAULT_GAP ? `within ${b.steps[i - 1].gap} ms ` : ''}` : '') + describeStep(s, { mirror })).join(' → ')
    + (b.mode === 'wait' ? ' (waits)' : '') + (mirror ? '' : ' (not mirrored)');
}
/** A binding as stick arrows (ball in the right hand): '← →'. */
export function arrowsOf(b) {
  return (b?.steps || []).map((s) => ('flick' in s ? arrowOf(s.flick) : 'hold' in s ? `hold ${arrowOf(s.hold)}` : 'spin' in s ? `${s.spin === 'ccw' ? '↺' : s.spin === 'cw' ? '↻' : '⟳'}${s.turn > 90 ? s.turn : ''}` : '◦')).join(' ');
}

// ── the move registry ────────────────────────────────────────────────────
/**
 * Every move the game can play, derived at run time (never a fixed list): the action roles of the roles table
 * (lib/mocap/game-roles.js ROLES, as /api/mocap3d/library sends it — custom move roles included), every move role a
 * clip has, every role a binding names.
 * @param {object} o
 *   roles     { role: { type, label, group, runtime, switchesHand?, shot?, custom? } }
 *   clips     { role: [{ id?, name, hand?, endHand?, mirror? }] }  the clips the court plays for each role
 *   bindings  the bindings
 * @returns {Array<{ role, label, group, custom, input: 'stick'|'shoot', bindable, clips, available, switchesHand,
 *                   triggers, describe, arrows }>}  moves first (the roles table's order, then new ones by name), shots last
 */
export function moveRegistry({ roles = {}, clips = {}, bindings = [] } = {}) {
  const ids = [];
  const add = (r) => { if (r && !ids.includes(r)) ids.push(r); };
  for (const [r, d] of Object.entries(roles)) if (d?.type === 'action' && d.runtime !== false && (isMoveRole(r) || d.shot)) add(r);
  const extra = [...Object.keys(clips), ...bindings.map((b) => b.role)].filter((r) => isMoveRole(r) && !ids.includes(r)).sort();
  extra.forEach(add);
  const out = ids.map((role) => {
    const d = roles[role] || {};
    const cs = (clips[role] || []).map((c) => ({ id: c.id ?? null, name: c.name ?? String(c.id ?? role), ...(c.hand ? { hand: c.hand } : {}), ...(c.endHand ? { endHand: c.endHand } : {}) }));
    const sw = d.switchesHand != null ? !!d.switchesHand : cs.some((c) => c.hand && c.endHand) ? cs.some((c) => c.hand && c.endHand && c.hand !== c.endHand) : null;
    const shot = !!d.shot || /^shot-/.test(role);
    const triggers = shot ? [] : bindings.filter((b) => b.role === role);
    return {
      role, label: roleLabel(role, roles), group: d.group || 'moves', custom: !!d.custom || !roles[role],
      input: shot ? 'shoot' : 'stick', bindable: !shot && isMoveRole(role),
      clips: cs, available: cs.length > 0, switchesHand: sw,
      triggers, describe: triggers.map(describeBinding), arrows: triggers.map(arrowsOf),
    };
  });
  return [...out.filter((m) => m.input === 'stick'), ...out.filter((m) => m.input !== 'stick')];
}
