/**
 * Soul Jam Capture — the capture protocol: session order, progress, the next missing animation,
 * take lifecycle, and the real-time messages between the director, the cameras and the server.
 * Shared by the server (lib/capture/*) and the browser (capture.html). A native camera app speaks
 * the same messages over the same WebSocket (see docs/capture.md → Native camera path).
 */
import { STATE_ORDER, HAND_ORDER, DIRECTIONS, SETUPS as SETUP_IDS, startStates } from './schema.mjs';
import { stationOf, calibrationSec } from './court-layout.mjs';

export const PROTOCOL_VERSION = 1;

/** Device roles in a session. The director usually is camera A too (the phone on the tripod). */
export const ROLES = ['director', 'camA', 'camB'];
export const CAMERAS = ['camA', 'camB'];

/**
 * Real-time messages (JSON over the session WebSocket, `t` = type):
 *   client → server  hello {role, deviceId, device, token} · ping {c} · state {…camera state} · ready {ready}
 *                    arm {animId, takeId} (director) · start {takeId} (director) · stop {takeId} (director)
 *                    uploaded {takeId, cam} · moved {cam, reason}
 *                    snap {jpg, w, h} (camera: a small live JPEG every ~1.5 s while idle — relayed to the director only)
 *                    camera state includes take (the take it records now) and lastTake (the last one it
 *                    started): the hub tells from them whether an expected camera really started
 *   server → client  welcome {session, you, clock} · pong {c, s} · presence {devices} · session {…}
 *                    armed {takeId, anim} · record {takeId, at} (start at server time `at`) · halt {takeId, at}
 *                    take {take, event} (uploaded / checked / saved / failed / analysis) · calibration {setup, status}
 *                    snap {role, jpg, at} (director) · analysis {takeId, progress} (director) · setref {setup} (cameras)
 *                    notrecording {takeId, cams} (director: an expected camera never started) · zoom {zoom} (a camera)
 *                    error {msg, takeId?} (e.g. a start refused: "no camera is ready")
 */
export const MSG = {
  hello: 'hello', ping: 'ping', pong: 'pong', welcome: 'welcome', presence: 'presence', state: 'state',
  arm: 'arm', armed: 'armed', start: 'start', record: 'record', stop: 'stop', halt: 'halt',
  uploaded: 'uploaded', take: 'take', session: 'session', moved: 'moved', calibration: 'calibration', error: 'error',
  snap: 'snap', analysis: 'analysis', setref: 'setref', notrecording: 'notrecording', zoom: 'zoom',
};

/** Seconds between the start command and the recording start (both cameras start on the same server clock). */
export const START_LEAD_SEC = 0.8;
/** The sync chirp the director plays this long after the start (heard by both cameras' microphones). */
export const CHIRP_AT_SEC = 0.35;

/**
 * Take lifecycle (nobody reviews a take; it moves on by itself):
 *   armed → recording → uploading → validating → (review: checked) → accepted   — saved, and selected when newest
 *                                              ↘ failed                          — a camera produced no usable video: needs redo
 *   rejected: discarded by the operator (footage kept)
 * A camera check (kind 'check'): armed → recording → uploading → validating → checked.
 * A take is never deleted automatically; the animation's `selectedTake` points at one.
 */
export const TAKE_STATES = ['armed', 'recording', 'stopped', 'uploading', 'validating', 'review', 'accepted', 'failed', 'rejected', 'checked'];

/** How long a recording runs before it stops by itself: one-shots get a 1 s margin, loops stop on time. */
export const autoStopSec = (anim) => (anim.loop ? anim.durationSec : anim.durationSec + 1);
/** A calibration recording's length: the station's walk at an easy pace (court-layout calibrationWalk), ~20 s. */
export { calibrationSec };
export const CHECK_SEC = 2;
/** Countdown choices before a recording (seconds; remembered on the device). */
export const COUNTDOWNS = [3, 5, 10];

/**
 * An animation slot's status (the animation list): missing · uploading (its newest take is still
 * on its way / being checked) · recorded · failed (needs redo: a camera produced no usable video)
 * · analysed · skipped.  { status, takeId, reason, takes, warn, note }
 *   warn: the selected take's first check warning (e.g. "CAM A: 3.0 s — shorter than half the target")
 *   note: about a newer take that is not the selected one (it failed, or it is short)
 */
export function slotStatus(session, animId) {
  const e = session?.animations?.[animId];
  const takes = e?.takes || [];
  const latest = takes[takes.length - 1] || null, sel = e?.selectedTake || null;
  const res = (id) => e?.results?.[id] || null;
  const base = { takes: takes.length, takeId: sel || latest, selectedTake: sel, latest, analysis: e?.analysis || null };
  if (latest && !res(latest) && latest !== sel) return { ...base, status: 'uploading', takeId: latest, redo: !!sel };
  if (sel) {
    const done = e.analysis?.state === 'done' && e.analysis.takeId === sel;
    const lr = res(latest), sr = res(sel);
    const note = latest === sel ? null : lr?.state === 'failed' ? `the newest take failed: ${lr.reason}`
      : lr?.passedOver ? `the newest take (${takes.indexOf(latest) + 1}) is short and was not selected: ${lr.warnings?.[0] || 'too short'}` : null;
    return { ...base, status: done ? 'analysed' : 'recorded', takeId: sel, ...(sr?.warnings?.length ? { warn: sr.warnings[0], short: !!sr.short } : {}), ...(note ? { note } : {}) };
  }
  if (latest && res(latest)?.state === 'failed') return { ...base, status: 'failed', takeId: latest, reason: res(latest).reason };
  // a take checked before the automatic flow that nobody accepted: it needs a decision (keep it or redo)
  if (latest && res(latest)?.state === 'review') return { ...base, status: 'failed', takeId: latest, reason: res(latest).reason || 'recorded but never saved — keep it (Use it anyway) or record it again', review: true };
  if (e?.skipped) return { ...base, status: 'skipped' };
  return { ...base, status: 'missing' };
}
/** Totals of the animation list. */
export function slotCounts(lib, session) {
  const n = { total: lib.animations.length, missing: 0, uploading: 0, recorded: 0, failed: 0, analysed: 0, skipped: 0 };
  for (const a of lib.animations) n[slotStatus(session, a.id).status]++;
  n.done = n.recorded + n.analysed;
  n.toRecord = n.missing + n.failed;
  return n;
}
/**
 * The next animation to record: missing or needing a redo. The cameras' current placement first
 * (session.currentSetup — its station): in capture order after `after`, wrapping within it; only
 * when nothing is left there, the other setups (forward in capture order, then wrapping). Slots
 * still uploading or recorded are passed over.
 */
export function nextToRecord(lib, session, { after = null } = {}) {
  const order = captureOrder(lib);
  const todo = order.filter((a) => ['missing', 'failed'].includes(slotStatus(session, a.id).status));
  if (!todo.length) return null;
  const i = after ? order.findIndex((a) => a.id === after) : -1;
  const pick = (list) => (list.length ? (i >= 0 && list.find((a) => order.indexOf(a) > i)) || list[0] : null);
  const here = session?.currentSetup ? stationOf(session.currentSetup) : null;
  return (here && pick(todo.filter((a) => stationOf(a.courtSetup) === here))) || pick(todo);
}
/** What is left at one camera placement: { toRecord: [anims missing / failed], uploading: [anims], total }. */
export function stationTodo(lib, session, station) {
  const st = stationOf(station);
  const list = captureOrder(lib).filter((a) => stationOf(a.courtSetup) === st);
  const of = (k) => list.filter((a) => k.includes(slotStatus(session, a.id).status));
  return { toRecord: of(['missing', 'failed']), uploading: of(['uploading']), total: list.length };
}

const idx = (arr, v) => { const i = arr.indexOf(v); return i < 0 ? arr.length : i; };

/**
 * The recording order of a library: by court setup (never move the cameras back), then by body
 * state, ball hand and movement direction, then by id — so the athlete flows from one state to the
 * next and the operator never repositions a camera mid-setup.
 */
export function captureOrder(lib) {
  return [...lib.animations].sort((a, b) =>
    idx(SETUP_IDS, a.courtSetup) - idx(SETUP_IDS, b.courtSetup)
    || idx(STATE_ORDER, startStates(a)[0]) - idx(STATE_ORDER, startStates(b)[0])
    || (b.loop - a.loop)                                  // a state's loops (its idle) before the moves out of it
    || idx(HAND_ORDER, a.ballHand) - idx(HAND_ORDER, b.ballHand)
    || idx(DIRECTIONS, a.direction) - idx(DIRECTIONS, b.direction)
    || a.id.localeCompare(b.id));
}

/** Is this animation done in the session (has an accepted, selected take)? */
export const isComplete = (session, animId) => !!session.animations?.[animId]?.selectedTake;

/** Progress: totals, per setup, and the next missing animation in capture order. */
export function progress(lib, session, { after = null } = {}) {
  const order = captureOrder(lib);
  const perSetup = {};
  for (const s of SETUP_IDS) perSetup[s] = { total: 0, complete: 0 };
  let complete = 0;
  for (const a of order) {
    perSetup[a.courtSetup].total++;
    if (isComplete(session, a.id)) { perSetup[a.courtSetup].complete++; complete++; }
  }
  return { total: order.length, complete, missing: order.length - complete, perSetup, next: nextMissing(lib, session, { after }) };
}

/**
 * The next missing animation in capture order. `after` (an animation id): continue after it
 * (wrapping to the start), so ACCEPT + NEXT walks forward instead of jumping back to a skipped one.
 */
export function nextMissing(lib, session, { after = null } = {}) {
  const order = captureOrder(lib);
  const missing = order.filter((a) => !isComplete(session, a.id) && !session.animations?.[a.id]?.skipped);
  if (!missing.length) return null;
  if (after) {
    const i = order.findIndex((a) => a.id === after);
    const later = missing.find((a) => order.indexOf(a) > i);
    if (later) return later;
  }
  return missing[0];
}

/** Does moving to `anim` need the cameras moved (a different camera placement than the current one)? */
export function needsSetupChange(session, anim) {
  return !!anim && !!session.currentSetup && stationOf(session.currentSetup) !== stationOf(anim.courtSetup);
}

/** Folder / file names of a take in the export (SoulJam_BASIC01/setup_A/cross_RL/take01/camA.mp4). */
export function takeFolder(anim, takeNo) {
  return `setup_${anim.courtSetup}/${anim.key}/take${String(takeNo).padStart(2, '0')}`;
}
