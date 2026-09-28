/**
 * Mannequin renderer — motion frame → pose reference image for any game angle.
 *
 * Deterministic, server-side (SVG → PNG through sharp, no GPU, no browser).
 * The rendered figure is the sizing ground truth for generation: it is drawn
 * at the target character's real stature with one pixels-per-metre for the
 * whole animation, feet on a fixed ground line.
 *
 * Colour code (stated in the generation prompt): character's LEFT limbs blue,
 * RIGHT limbs red, torso/head grey. Eyes/nose are drawn only when the face is
 * toward the viewer, which disambiguates front vs back views.
 */
'use strict';

const sharp = require('sharp');
const S = require('./skeleton');
const { J } = S;

// Game zones (index-v2 COURT_ZONES) + the mirrored right-side angles.
// yaw: rotation applied to the canonical (facing +Z) motion. angleIdx: the
// character's matching body-angle reference ({char}-angle-{idx}.png).
const VIEWS = {
  1: { label: 'Front',       yaw: 0,    angleIdx: 0 },
  2: { label: 'Front Left',  yaw: -45,  angleIdx: 7 },
  3: { label: 'Left',        yaw: -90,  angleIdx: 6 },
  4: { label: 'Back Left',   yaw: -135, angleIdx: 5 },
  5: { label: 'Back',        yaw: 180,  angleIdx: 4 },
  6: { label: 'Front Right', yaw: 45,   angleIdx: 1 },
  7: { label: 'Right',       yaw: 90,   angleIdx: 2 },
  8: { label: 'Back Right',  yaw: 135,  angleIdx: 3 },
};

const CANVAS = { w: 768, h: 1152, ground: 1040 }; // 2:3 — both Gemini and GPT Image support it
const COLORS = { L: [47, 107, 255], R: [235, 52, 88], C: [150, 156, 168], head: [184, 188, 196] };

const hex = (rgb, k = 1) => '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))).toString(16).padStart(2, '0')).join('');

/** Motion frame → posed, retargeted, rotated world points (+ ball). */
function posedFrame(motion, i, { yawDeg = 0, mirror = false, statureM }) {
  const fr = motion.frames[i];
  let P = fr.joints;
  let ball = fr.ball ? fr.ball.p : null;
  if (mirror) {
    P = S.MIRROR_PERM.map((k) => [-P[k][0], P[k][1], P[k][2]]);
    if (ball) ball = [-ball[0], ball[1], ball[2]];
  }
  const s = statureM && motion.statureM ? statureM / motion.statureM : 1;
  const R = S.rotY((yawDeg * Math.PI) / 180);
  const xf = (p) => S.mulMV(R, S.scale(p, s));
  const pts = P.map(xf);
  // Virtual head centre: between the ears, nudged up to the skull centre
  const earMid = S.mid(pts[J['left-ear']], pts[J['right-ear']]);
  const head = S.add(earMid, [0, 0.035 * s, 0]);
  return { pts, head, ball: ball ? xf(ball) : null, ballR: (fr.ball?.r || 0.12) * s, s };
}

/**
 * One pixels-per-metre for a whole render set so every frame and every angle
 * shares the scale. Uses the yaw-invariant horizontal radius.
 */
function fitScale(motion, { statureM, mirror = false } = {}) {
  let maxY = 0, maxR = 0;
  for (let i = 0; i < motion.frames.length; i++) {
    const { pts, head, ball, ballR } = posedFrame(motion, i, { statureM, mirror });
    for (const p of pts.concat([head])) {
      maxY = Math.max(maxY, p[1]);
      maxR = Math.max(maxR, Math.hypot(p[0], p[2]));
    }
    if (ball) { maxY = Math.max(maxY, ball[1] + ballR); maxR = Math.max(maxR, Math.hypot(ball[0], ball[2]) + ballR); }
  }
  maxY += 0.14; // head radius + margin
  maxR += 0.12;
  const byH = (CANVAS.ground - 24) / maxY;
  const byW = (CANVAS.w / 2 - 16) / maxR;
  return Math.min(380, byH, byW);
}

function buildSvg(frame, { ppm, background = '#ffffff', drawBall = false }) {
  const { pts, head, ball, ballR, s } = frame;
  const cx = CANVAS.w / 2, gy = CANVAS.ground;
  const X = (p) => cx + p[0] * ppm;
  const Y = (p) => gy - p[1] * ppm;
  const zs = pts.map((p) => p[2]);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const shade = (z) => 0.72 + 0.34 * ((z - zMin) / Math.max(0.05, zMax - zMin)); // nearer = lighter
  const items = [];
  const line = (a, b, side, wM, z, k = 1) => items.push({
    z, svg:
      `<line x1="${X(a).toFixed(1)}" y1="${Y(a).toFixed(1)}" x2="${X(b).toFixed(1)}" y2="${Y(b).toFixed(1)}" stroke="#1d2027" stroke-width="${(wM * s * ppm + 5).toFixed(1)}" stroke-linecap="round"/>` +
      `<line x1="${X(a).toFixed(1)}" y1="${Y(a).toFixed(1)}" x2="${X(b).toFixed(1)}" y2="${Y(b).toFixed(1)}" stroke="${hex(COLORS[side], shade(z) * k)}" stroke-width="${(wM * s * ppm).toFixed(1)}" stroke-linecap="round"/>`,
  });
  const P = (name) => (name === 'head' ? head : pts[J[name]]);

  // Torso quad + pelvis band
  const ls = P('left-shoulder'), rs = P('right-shoulder'), lh = P('left-hip'), rh = P('right-hip');
  const tz = (ls[2] + rs[2] + lh[2] + rh[2]) / 4;
  // Chest/belly capsule under the quad gives the torso depth in side views,
  // where the shoulder/hip quad collapses to a line
  line(S.mid(lh, rh), S.mid(ls, rs), 'C', 0.25, tz - 0.001);
  const quad = [ls, rs, rh, lh].map((p) => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
  items.push({ z: tz, svg: `<polygon points="${quad}" fill="${hex(COLORS.C, shade(tz))}" stroke="#1d2027" stroke-width="5" stroke-linejoin="round"/>` });
  // Shoulder/hip caps in side colour make the left/right split readable on the torso
  line(ls, S.mid(ls, rs), 'L', 0.11, ls[2] + 0.001, 0.95);
  line(rs, S.mid(ls, rs), 'R', 0.11, rs[2] + 0.001, 0.95);
  line(lh, S.mid(lh, rh), 'L', 0.14, lh[2] + 0.001, 0.95);
  line(rh, S.mid(lh, rh), 'R', 0.14, rh[2] + 0.001, 0.95);

  for (const b of S.BONES) {
    const a = P(b.a), c = P(b.b);
    // The neck always sits just behind the head so it never covers the face marks
    const z = b.part === 'neck' ? Math.min(a[2], c[2]) - 0.02 : (a[2] + c[2]) / 2;
    line(a, c, b.side, b.w, z);
  }
  for (const h of S.HANDS) {
    const w = P(h.wrist), k = P(h.knuckle);
    line(w, S.add(k, S.scale(S.sub(k, w), 0.4)), h.side, 0.085, (w[2] + k[2]) / 2 + 0.001, 1.12);
  }

  // Head + face marks (only when facing the viewer)
  const hr = 0.108 * s * ppm;
  let headSvg = `<circle cx="${X(head).toFixed(1)}" cy="${Y(head).toFixed(1)}" r="${hr.toFixed(1)}" fill="${hex(COLORS.head, shade(head[2]))}" stroke="#1d2027" stroke-width="3"/>`;
  const nose = P('nose');
  const facing = nose[2] - head[2];
  if (facing > 0.02) {
    for (const e of ['left-eye', 'right-eye']) {
      const ep = P(e);
      if (ep[2] - head[2] > 0.0) headSvg += `<circle cx="${X(ep).toFixed(1)}" cy="${Y(ep).toFixed(1)}" r="${(hr * 0.13).toFixed(1)}" fill="#1d2027"/>`;
    }
    headSvg += `<circle cx="${X(nose).toFixed(1)}" cy="${Y(nose).toFixed(1)}" r="${(hr * 0.11).toFixed(1)}" fill="#5b606b"/>`;
  }
  items.push({ z: head[2], svg: headSvg });

  // Ball placement info (+ optional preview draw)
  let ballPx = null;
  if (ball) {
    const bx = X(ball), by = Y(ball), br = ballR * ppm;
    // Behind if any body point overlapping it on screen is nearer to the viewer
    let behind = false;
    for (const p of pts.concat([head])) {
      if (Math.hypot(X(p) - bx, Y(p) - by) < br + 0.06 * ppm && p[2] > ball[2] + 0.03) { behind = true; break; }
    }
    ballPx = { x: bx, y: by, r: br, behind };
    if (drawBall) items.push({ z: ball[2], svg: ballSvg(bx, by, br) });
  }

  items.sort((a, b) => a.z - b.z);
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.w}" height="${CANVAS.h}" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}">${bg}${items.map((i) => i.svg).join('')}</svg>`;
  return { svg, ballPx };
}

/** Canonical basketball (constant colour/seams → the ball never drifts between frames). */
function ballSvg(x, y, r, id = 'bg') {
  const lw = Math.max(1, r * 0.07).toFixed(2);
  return `<defs><radialGradient id="${id}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#f7a25c"/><stop offset="0.55" stop-color="#e06a1f"/><stop offset="1" stop-color="#9c3f0c"/></radialGradient></defs>` +
    `<g><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})" stroke="#3a1a06" stroke-width="${lw}"/>` +
    `<path d="M ${x - r} ${y} L ${x + r} ${y} M ${x} ${y - r} L ${x} ${y + r}" stroke="#2b1204" stroke-width="${lw}" fill="none"/>` +
    `<path d="M ${x - r * 0.62} ${y - r * 0.78} Q ${x - r * 0.18} ${y} ${x - r * 0.62} ${y + r * 0.78} M ${x + r * 0.62} ${y - r * 0.78} Q ${x + r * 0.18} ${y} ${x + r * 0.62} ${y + r * 0.78}" stroke="#2b1204" stroke-width="${lw}" fill="none"/></g>`;
}

async function ballPng(r) {
  const size = Math.ceil(r * 2 + 4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${ballSvg(size / 2, size / 2, r)}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Alpha bbox + centroid of a transparent PNG buffer. */
async function alphaStats(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1, sx = 0, n = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 24) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sx += x; n++;
    }
  }
  if (!n) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, cx: sx / n, area: n };
}

/**
 * Render one frame.
 * @returns {{ png, alphaPng, bbox, ppm, ground, ballPx }}
 */
async function renderFrame(motion, i, { view = 1, mirror = false, statureM, ppm, drawBall = false, background = '#ffffff', previewWidth } = {}) {
  const v = VIEWS[view] || VIEWS[1];
  const fr = posedFrame(motion, i, { yawDeg: v.yaw, mirror, statureM });
  const scalePpm = ppm || fitScale(motion, { statureM, mirror });
  const { svg, ballPx } = buildSvg(fr, { ppm: scalePpm, background, drawBall });
  if (previewWidth) {
    // UI previews: rasterise straight at the small size, skip the alpha/QC pass
    const png = await sharp(Buffer.from(svg), { density: 72 * (previewWidth / CANVAS.w) }).resize({ width: previewWidth }).png().toBuffer();
    return { png, ppm: scalePpm, ground: CANVAS.ground, ballPx };
  }
  const { svg: svgA } = buildSvg(fr, { ppm: scalePpm, background: null, drawBall: false });
  const [png, alphaPng] = await Promise.all([
    sharp(Buffer.from(svg)).png().toBuffer(),
    sharp(Buffer.from(svgA)).png().toBuffer(),
  ]);
  return { png, alphaPng, bbox: await alphaStats(alphaPng), ppm: scalePpm, ground: CANVAS.ground, ballPx };
}

module.exports = { VIEWS, CANVAS, renderFrame, fitScale, posedFrame, ballPng, ballSvg, alphaStats };
