/**
 * Shot release from the motion (runtime copy of lib/mocap/motion-builder.js inferShotRelease —
 * tests/shot.test.js checks that both give the same answer).
 *
 * A shot filmed close leaves the top of the picture while it is still in the hands; the frame
 * the ball vanished is then not the release. The shooting arm says when it is: the first frame
 * after the last seen hold whose shoulder→wrist distance reaches SHOT_EXT_RELEASE of the arm's
 * length (the shooting arm = the one that extends more; within 0.05 of each other → `hand`).
 * An arm that is already straight (or never straightens in the window) releases at its wrist's
 * highest point. Never later than SHOT_MAX_AFTER_S after `from`, never on the last frame.
 *
 * Engine-agnostic, pure (no three.js).
 */
export const SHOT_EXT_RELEASE = 0.88;
export const SHOT_MAX_AFTER_S = 0.6;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * @param {(i: number, name: string) => number[]} jointAt  frame i, MHR70 keypoint name ('right-wrist') → [x, y, z] (y up)
 * @param {number} F     frame count
 * @param {number} fps
 * @param {object} [o]   { from: the last frame the ball was seen in the hands, hand: tie-break, ext, maxAfterS }
 * @returns {{ frame: number, releaseFrame: number, hand: 'left'|'right', method: 'arm-extension'|'wrist-peak', ext: number } | null}
 */
export function inferShotRelease(jointAt, F, fps, { from = 0, hand = null, ext = SHOT_EXT_RELEASE, maxAfterS = SHOT_MAX_AFTER_S } = {}) {
  if (!(from >= 0) || from >= F) return null;
  const last = Math.min(F - 2, from + Math.round(maxAfterS * fps));
  if (last <= from) return null;
  const armExt = (i, s) => {
    const sh = jointAt(i, `${s}-shoulder`), el = jointAt(i, `${s}-elbow`), wr = jointAt(i, `${s}-wrist`);
    return dist(sh, wr) / ((dist(sh, el) + dist(el, wr)) || 1e-9);
  };
  const gain = (s) => { let m = -Infinity; for (let i = from + 1; i <= last; i++) m = Math.max(m, armExt(i, s)); return m - armExt(from, s); };
  const gL = gain('left'), gR = gain('right');
  const shooter = Math.abs(gL - gR) < 0.05 && (hand === 'left' || hand === 'right') ? hand : gR >= gL ? 'right' : 'left';
  if (armExt(from, shooter) < ext) {
    for (let i = from + 1; i <= last; i++) {
      const b = armExt(i, shooter);
      if (b < ext) continue;
      const a = armExt(i - 1, shooter);
      const frame = i - 1 + (b > a ? Math.min(1, Math.max(0, (ext - a) / (b - a))) : 1);
      return { frame: +frame.toFixed(3), releaseFrame: i, hand: shooter, method: 'arm-extension', ext: +b.toFixed(3) };
    }
  }
  let best = from + 1;
  for (let i = from + 1; i <= last; i++) if (jointAt(i, `${shooter}-wrist`)[1] > jointAt(best, `${shooter}-wrist`)[1]) best = i;
  return { frame: best, releaseFrame: best, hand: shooter, method: 'wrist-peak', ext: +armExt(best, shooter).toFixed(3) };
}
