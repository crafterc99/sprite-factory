/**
 * Soul Jam Capture — the capture protocol: session order, progress, the next missing animation,
 * take lifecycle, and the real-time messages between the director, the cameras and the server.
 * Shared by the server (lib/capture/*) and the browser (capture.html). A native camera app speaks
 * the same messages over the same WebSocket (see docs/capture.md → Native camera path).
 */
import { STATE_ORDER, HAND_ORDER, DIRECTIONS, SETUPS as SETUP_IDS, startStates } from './schema.mjs';

export const PROTOCOL_VERSION = 1;

/** Device roles in a session. The director usually is camera A too (the phone on the tripod). */
export const ROLES = ['director', 'camA', 'camB'];
export const CAMERAS = ['camA', 'camB'];

/**
 * Real-time messages (JSON over the session WebSocket, `t` = type):
 *   client → server  hello {role, deviceId, device, token} · ping {c} · state {…camera state} · ready {ready}
 *                    arm {animId, takeId} (director) · start {takeId} (director) · stop {takeId} (director)
 *                    uploaded {takeId, cam} · moved {cam, reason}
 *   server → client  welcome {session, you, clock} · pong {c, s} · presence {devices} · session {…}
 *                    armed {takeId, anim} · record {takeId, at} (start at server time `at`) · halt {takeId, at}
 *                    take {take} (upload / validation / saved progress) · calibration {setup, status}
 */
export const MSG = {
  hello: 'hello', ping: 'ping', pong: 'pong', welcome: 'welcome', presence: 'presence', state: 'state',
  arm: 'arm', armed: 'armed', start: 'start', record: 'record', stop: 'stop', halt: 'halt',
  uploaded: 'uploaded', take: 'take', session: 'session', moved: 'moved', calibration: 'calibration', error: 'error',
};

/** Seconds between the start command and the recording start (both cameras start on the same server clock). */
export const START_LEAD_SEC = 0.8;
/** The sync chirp the director plays this long after the start (heard by both cameras' microphones). */
export const CHIRP_AT_SEC = 0.35;

/**
 * Take lifecycle:
 *   armed → recording → stopped → uploading → validating → review → accepted | retake
 * An accepted take is never deleted automatically; the animation's `selectedTake` points at one.
 */
export const TAKE_STATES = ['armed', 'recording', 'stopped', 'uploading', 'validating', 'review', 'accepted', 'rejected'];

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

/** Does moving to `anim` need the cameras moved (a different setup than the current calibration)? */
export function needsSetupChange(session, anim) {
  return !!anim && session.currentSetup && session.currentSetup !== anim.courtSetup;
}

/** Folder / file names of a take in the export (SoulJam_BASIC01/setup_A/cross_RL/take01/camA.mp4). */
export function takeFolder(anim, takeNo) {
  return `setup_${anim.courtSetup}/${anim.key}/take${String(takeNo).padStart(2, '0')}`;
}
