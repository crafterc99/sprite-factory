/**
 * Game deploy resolver — which studio strip becomes each Soul Jam slot.
 *
 * Soul Jam plays ONE strip per state and mirrors it (setFlipX) when the
 * player faces left, so its native art must face screen-RIGHT in a ¾-front
 * view (like the existing roster). Candidates, in order:
 *   1. {slot}_game_{hand}     — generated natively at the game angle (mocap view 6, Front Right)
 *   2. {slot}_z2_{hand}       — Front Left, mirrored per frame → Front Right
 *   3. {slot}_z3_{hand}       — Left (side view), mirrored per frame → Right
 *   4. {slot}_z1_{hand}       — Front, as is
 *   5. legacy {char}-{sfAnim}.png (+ animation-contract frame counts)
 * Mirroring swaps the hands, so the mirrored candidates prefer the LEFT-hand
 * variant (it becomes a right-hand dribble in game).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const FRAME = 180;

// Soul Jam slot → studio slot (index-v2 ANIMATION_SLOTS / SOUL_JAM_ANIMATIONS ids)
const STUDIO_SLOT_FOR = {
  idleDribble: 'idle-dribble',
  runDribble: 'jog-dribble',
  jumpshot: 'jumpshot',
  stepback: 'stepback',
  crossover: 'cross',
  steal: 'steal-attempt',
  backpedal: 'backpedal-dribble',
  shuffle: 'slide-def-l',
};

function fileFromUrl(assetsDir, url) {
  if (!url) return null;
  const rel = decodeURIComponent(String(url).split('?')[0].replace(/^\/assets\//, ''));
  const p = path.join(assetsDir, rel);
  return fs.existsSync(p) ? p : null;
}

function resolveGameStrip({ assetsDir, charId, sjSlot, slotDef, saved = {}, contract = {} }) {
  const studio = STUDIO_SLOT_FOR[sjSlot];
  const pick = (prefix, hands, mirror, source) => {
    for (const h of hands) {
      const sa = saved[`${prefix}_${h}`] || (h === '' ? saved[prefix] : null);
      const src = sa && fileFromUrl(assetsDir, sa.spriteUrl);
      if (src) return { srcPath: src, mirror, frames: sa.frameCount || 1, fps: sa.fps || slotDef.fps, source, key: `${prefix}${h ? '_' + h : ''}` };
    }
    return null;
  };
  if (studio) {
    const r = pick(`${studio}_game`, ['right', 'left'], false, 'game-angle')
      || pick(`${studio}_z2`, ['left', 'right', ''], true, 'front-left-mirrored')
      || pick(`${studio}_z3`, ['left', 'right', ''], true, 'side-mirrored')
      || pick(`${studio}_z1`, ['right', 'left', ''], false, 'front');
    if (r) return r;
  }
  const legacy = path.join(assetsDir, `${charId}-${slotDef.sfAnim}.png`);
  if (fs.existsSync(legacy)) {
    const c = contract.animations?.[slotDef.sfAnim] || {};
    return { srcPath: legacy, mirror: false, frames: c.frames || 4, fps: c.fps || slotDef.fps, source: 'legacy', key: slotDef.sfAnim };
  }
  return null;
}

/** Write the strip for the game, mirroring each 180px cell in place (frame order kept). */
async function materialize(res, destPath) {
  if (!res.mirror) { fs.copyFileSync(res.srcPath, destPath); return destPath; }
  const meta = await sharp(res.srcPath).metadata();
  const n = Math.max(1, Math.round(meta.width / FRAME));
  const cells = await Promise.all(Array.from({ length: n }, async (_, i) => ({
    input: await sharp(res.srcPath).extract({ left: i * FRAME, top: 0, width: FRAME, height: Math.min(FRAME, meta.height) }).flop().png().toBuffer(),
    left: i * FRAME, top: 0,
  })));
  await sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(cells).png().toFile(destPath);
  return destPath;
}

module.exports = { resolveGameStrip, materialize, STUDIO_SLOT_FOR };
