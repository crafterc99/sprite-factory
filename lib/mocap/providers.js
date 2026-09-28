/**
 * Mocap providers — measurement, not generation.
 *
 *   segmentFrame(framePath)  → SAM 3 (fal-ai/sam-3/image): pixel-true person mask
 *                              + basketball circle. Nothing is redrawn.
 *   bodyFrame(framePath, maskPath) → SAM 3D Body (fal-ai/sam-3/3d-body): MHR70
 *                              2D/3D keypoints + camera for one frame.
 *
 * MOCAP_MOCK=1 swaps both for a deterministic synthetic dribble so the whole
 * pipeline/UI can be exercised without API keys (local dev + tests only).
 */
'use strict';

const fs = require('fs');
const sharp = require('sharp');
const fal = require('./fal-client');
const mock = require('./mock');

const SAM3_IMAGE = 'fal-ai/sam-3/image';
const SAM3D_BODY = 'fal-ai/sam-3/3d-body';

const isMock = () => process.env.MOCAP_MOCK === '1';

function status() {
  return { fal: fal.isConfigured(), mock: isMock() };
}

// fal accepts inline images; keep payloads small and fast.
async function frameDataUri(framePath, maxEdge = 1280) {
  const buf = await sharp(framePath)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  return fal.toDataUri(buf, 'image/jpeg');
}

/** Decode a mask image (binary PNG, or alpha cut-out) to a 0/1 Uint8Array at w×h. */
async function decodeMask(buf, w, h) {
  const { data, info } = await sharp(buf).resize(w, h, { fit: 'fill' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(w * h);
  // Masks come back either as white-on-black or as alpha cut-outs — accept both.
  let alphaVaries = false;
  for (let i = 0; i < w * h; i += 97) if (data[i * 4 + 3] < 250) { alphaVaries = true; break; }
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    out[i] = alphaVaries ? (a > 127 ? 1 : 0) : ((r + g + b) / 3 > 127 ? 1 : 0);
  }
  return { mask: out, w: info.width, h: info.height };
}

function maskStats(mask, w, h) {
  let area = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    area++; sx += x; sy += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!area) return null;
  return { area, cx: sx / area, cy: sy / area, bbox: [minX, minY, maxX, maxY] };
}

async function maskToPng(mask, w, h) {
  const px = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) px[i] = mask[i] ? 255 : 0;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

/**
 * Segment the player and the ball in one frame.
 * @returns {{ personMaskPng: Buffer, person: stats, ball: {u,v,r,score}|null, imgW, imgH, cost }}
 */
async function segmentFrame(framePath, { hintCenter } = {}) {
  const meta = await sharp(framePath).metadata();
  const W = meta.width, H = meta.height;
  if (isMock()) return mock.segmentFrame(framePath, W, H);

  const image_url = await frameDataUri(framePath);
  const common = { image_url, apply_mask: false, return_multiple_masks: true, include_scores: true, include_boxes: true, output_format: 'png' };
  const [personRes, ballRes] = await Promise.all([
    fal.run(SAM3_IMAGE, { ...common, prompt: 'person', max_masks: 4 }),
    fal.run(SAM3_IMAGE, { ...common, prompt: 'basketball', max_masks: 2 }).catch(() => null),
  ]);

  // Person: the recorded player is the biggest person in frame (or the one
  // closest to a hint from the previous frame when several people are visible).
  let best = null;
  for (let i = 0; i < (personRes.masks || []).length; i++) {
    const buf = await fal.download(personRes.masks[i].url);
    const { mask } = await decodeMask(buf, W, H);
    const st = maskStats(mask, W, H);
    if (!st) continue;
    let score = st.area;
    if (hintCenter) score /= 1 + Math.hypot(st.cx - hintCenter[0], st.cy - hintCenter[1]) / (0.25 * W);
    if (!best || score > best.score) best = { score, mask, st };
  }
  if (!best) throw new Error('SAM 3 found no person in this frame');

  let ball = null;
  const ballMasks = ballRes?.masks || [];
  for (let i = 0; i < ballMasks.length; i++) {
    const sc = ballRes.scores?.[i] ?? ballRes.metadata?.[i]?.score ?? 1;
    if (sc < 0.3) continue;
    const buf = await fal.download(ballMasks[i].url);
    const { mask } = await decodeMask(buf, W, H);
    const st = maskStats(mask, W, H);
    if (!st) continue;
    const bw = st.bbox[2] - st.bbox[0] + 1, bh = st.bbox[3] - st.bbox[1] + 1;
    // A hand over the ball shrinks the mask, rarely its longest extent
    const r = Math.max(bw, bh) / 2;
    const cand = { u: (st.bbox[0] + st.bbox[2]) / 2, v: (st.bbox[1] + st.bbox[3]) / 2, r, score: sc };
    if (!ball || cand.score > ball.score) ball = cand;
  }

  return {
    personMaskPng: await maskToPng(best.mask, W, H),
    person: best.st,
    ball,
    imgW: W, imgH: H,
    cost: 0.005 * (ballRes ? 2 : 1),
  };
}

/**
 * 3D body for one frame. Uses the SAM 3 mask so the right person is lifted.
 * @returns {{ kp2d, kp3d, camT, focal, bbox, imgW, imgH, cost }}
 */
async function bodyFrame(framePath, maskPath) {
  const meta = await sharp(framePath).metadata();
  const W = meta.width, H = meta.height;
  if (isMock()) return mock.bodyFrame(framePath, W, H);

  // Send the frame at native size so returned 2D keypoints are in frame pixels
  const image_url = fal.toDataUri(await sharp(framePath).jpeg({ quality: 92 }).toBuffer(), 'image/jpeg');
  const input = { image_url, export_meshes: false, include_3d_keypoints: false, include_mhr_params: false };
  if (maskPath && fs.existsSync(maskPath)) input.mask_url = fal.toDataUri(maskPath, 'image/png');
  const out = await fal.run(SAM3D_BODY, input);
  const people = out?.metadata?.people || [];
  if (!people.length) throw new Error('SAM 3D Body found no person');
  const p = people[0];
  if (!p.keypoints_3d) throw new Error('SAM 3D Body returned no 3D keypoints');
  return {
    kp2d: p.keypoints_2d, kp3d: p.keypoints_3d, camT: p.pred_cam_t, focal: p.focal_length,
    bbox: p.bbox, imgW: W, imgH: H, visualizationUrl: out.visualization?.url || null, cost: 0.02,
  };
}

module.exports = { status, segmentFrame, bodyFrame, decodeMask, maskStats, maskToPng, isMock };
