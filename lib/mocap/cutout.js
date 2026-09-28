/**
 * Pixel-true player cutout for the Video tab (replaces the Gemini "extract the
 * player" redraw when FAL_KEY is set).
 *
 * The old path asked an image model to redraw the player and "scale them to
 * ~60% of the image" independently per frame — limbs/ball drifted and every
 * frame got a different zoom. Here SAM 3 masks the real pixels (player + ball),
 * and ONE scale per video session (fixed by the first frame cut) is reused for
 * every frame, with the feet kept at their true height — so crouches and jumps
 * survive into the reference frames.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const providers = require('./providers');

const OUT_W = 768, OUT_H = 1024, FEET_Y = Math.round(OUT_H * 0.93);

function sessionScalePath(subjectsDir) {
  return path.join(subjectsDir, 'cutout-scale.json');
}

async function samCutout(framePath, subjectsDir, frameIndex) {
  const seg = await providers.segmentFrame(framePath);
  const W = seg.imgW, H = seg.imgH;
  const { mask } = await providers.decodeMask(seg.personMaskPng, W, H);
  // Include the ball (it is part of the move) by OR-ing a disc into the mask
  if (seg.ball) {
    const { u, v, r } = seg.ball;
    for (let y = Math.max(0, Math.floor(v - r)); y < Math.min(H, Math.ceil(v + r)); y++) {
      for (let x = Math.max(0, Math.floor(u - r)); x < Math.min(W, Math.ceil(u + r)); x++) {
        if ((x - u) ** 2 + (y - v) ** 2 <= r * r) mask[y * W + x] = 1;
      }
    }
  }
  const st = providers.maskStats(mask, W, H);
  if (!st) throw new Error('SAM 3 found no player in this frame');

  // Session-wide scale/anchor, fixed by the first frame that gets cut
  const sp = sessionScalePath(subjectsDir);
  let ref = null;
  try { ref = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch {}
  if (!ref || ref.W !== W || ref.H !== H) {
    const personH = st.bbox[3] - st.bbox[1] + 1;
    ref = { W, H, scale: Math.min(4, (OUT_H * 0.62) / personH), feetY: st.bbox[3] };
    fs.writeFileSync(sp, JSON.stringify(ref));
  }

  // Alpha-cut the real frame
  const { data } = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < W * H; i++) data[i * 4 + 3] = mask[i] ? 255 : 0;
  const cut = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: st.bbox[0], top: st.bbox[1], width: st.bbox[2] - st.bbox[0] + 1, height: st.bbox[3] - st.bbox[1] + 1 })
    .png().toBuffer();
  const cw = Math.max(1, Math.round((st.bbox[2] - st.bbox[0] + 1) * ref.scale));
  const ch = Math.max(1, Math.round((st.bbox[3] - st.bbox[1] + 1) * ref.scale));
  const scaled = await sharp(cut).resize(cw, ch, { kernel: 'lanczos3' }).png().toBuffer();

  // Horizontal: centred (in place). Vertical: true height relative to the
  // reference frame's feet, so a jump stays a jump.
  const left = Math.round(OUT_W / 2 - cw / 2);
  const top = Math.round(FEET_Y - (ref.feetY - st.bbox[1]) * ref.scale);
  const pad = Math.max(cw, ch);
  const big = await sharp({ create: { width: OUT_W + 2 * pad, height: OUT_H + 2 * pad, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } })
    .composite([{ input: scaled, left: left + pad, top: top + pad }]).png().toBuffer();
  const outFile = `subject-${frameIndex}.png`;
  await sharp(big).extract({ left: pad, top: pad, width: OUT_W, height: OUT_H }).png().toFile(path.join(subjectsDir, outFile));
  return { outFile, cost: seg.cost || 0 };
}

module.exports = { samCutout };
