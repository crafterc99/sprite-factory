/**
 * Soul Jam Capture — what the director's toast says about the take just recorded (a pure function,
 * so the wording is unit-tested: tests/capture.test.js). Exactly one state wins, in this order:
 * failed (needs redo) · saved but short / with a warning · saved · a camera never started (while
 * the take is still on its way) · recorded, uploading.
 */

/** A check's wording for the operator: "camB: …" → "CAM B: …". */
export const human = (s) => String(s ?? '').replace(/\bcam([AB])\b/g, 'CAM $1');
const CAM = { camA: 'CAM A', camB: 'CAM B' };

/**
 * The warning worth a "Redo?" next to a saved take: it was cut short (or ran far too long), a
 * camera said it was not recording, or (two cameras) only one of them recorded it. Not the device
 * limits every take has (30 fps) nor the motion heuristics (a possibly cropped athlete) — those
 * stay in the take's checks.
 */
const IMPORTANT = /shorter than half|much longer than|said while recording|never started|one view: no 3-D/;
export const importantWarning = (res) => (res?.warnings || []).find((w) => IMPORTANT.test(w)) || null;

/**
 * @param toast  { anim, takeId, state }   (state: what the page heard — 'uploading' | 'saved' | 'failed' …)
 * @param entry  session.animations[anim.id] (its results / selectedTake / takes)
 * @param notRec { cams } when the hub said an expected camera never started this take, else null
 * @returns {{ msg, cls: '' | 'warn' | 'bad', saved, failed }}
 */
export function takeToast(toast, entry, notRec = null) {
  const res = entry?.results?.[toast.takeId];
  const failed = res?.state === 'failed' || toast.state === 'failed';
  const saved = !failed && (res?.state === 'recorded' || toast.state === 'saved');
  const a = toast.anim, name = `${a.title}${a.subtitle ? ' ' + a.subtitle : ''}`;
  const warn = saved && res ? importantWarning(res) : null;
  let msg, cls = '';
  if (failed) { msg = `✗ ${name}: the check failed — ${human(res?.reason || 'a camera produced no usable video')}. Record it again.`; cls = 'bad'; }
  else if (saved && res?.short && entry?.selectedTake && entry.selectedTake !== toast.takeId) { msg = `✓ ${name} saved — but it is short (${human(warn || 'stopped early')}), so take ${entry.takes.indexOf(entry.selectedTake) + 1} stays the selected one. Redo?`; cls = 'warn'; }
  else if (saved && warn) { msg = `✓ ${name} saved — but ${human(warn)}. Redo?`; cls = 'warn'; }
  else if (saved) msg = `✓ ${name} — saved.`;
  // a camera never started: said while the take is on its way (once it is saved or failed, that says it)
  else if (notRec) { msg = `✗ ${notRec.cams.map((c) => CAM[c] || c).join(' + ')} did not start recording ${name} — it will need a redo. Keep that phone's screen on and the page in front.`; cls = 'bad'; }
  else msg = `✓ ${name} recorded — uploading in the background…`;
  return { msg, cls, saved, failed };
}
