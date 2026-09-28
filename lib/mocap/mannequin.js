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
  return { pts, head, ball: ball ? xf(ball) : null, ballR: (fr.ball?.r || 0.12) * s, ballHeld: fr.ball?.held, s };
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

// Ball proxy for generation: a flat magenta disc the model draws the hands
// gripping; compose swaps it for the canonical ball texture (fingers stay on top)
const PROXY_COLOR = '#FF00FF';
const HELD_DIST_M = 0.22; // ball centre ↔ palm distance that counts as "in hand"

function buildSvg(frame, { ppm, background = '#ffffff', drawBall = false, ballProxy = false }) {
  const { pts, head, ball, ballR, ballHeld, s } = frame;
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
  // Hands: palm + every finger from the SAM 3D hand keypoints (21 per hand)
  for (const side of ['left', 'right']) {
    const sd = side === 'left' ? 'L' : 'R';
    const q = (n) => P(`${side}-${n}`);
    const w = q('wrist');
    const base = ['index', 'middle', 'ring', 'pinky'].map((f) => q(`${f}-third-joint`));
    const pz = (w[2] + base.reduce((a, b) => a + b[2], 0) / 4) / 2;
    const palm = [w, base[0], base[1], base[2], base[3]].map((p) => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
    items.push({ z: pz, svg: `<polygon points="${palm}" fill="${hex(COLORS[sd], shade(pz) * 1.18)}" stroke="#1d2027" stroke-width="2.5" stroke-linejoin="round"/>` });
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const chain = (f === 'thumb' ? [w] : []).concat(['third-joint', 'second-joint', 'first-joint', 'tip'].map((j) => q(`${f}-${j}`)));
      for (let c = 0; c < chain.length - 1; c++) {
        const a = chain[c], b = chain[c + 1];
        line(a, b, sd, f === 'thumb' ? 0.024 : 0.019, (a[2] + b[2]) / 2 + 0.0005, 1.3);
      }
    }
  }

  // Head: skull, jaw toward the chin, and face features on the side facing
  // the camera — nose/eyes/ears come from the measured keypoints, so head
  // turn and tilt are exact (profile, three-quarter, back of head)
  const hr = 0.100 * s * ppm;
  const nose = P('nose');
  const facing = nose[2] - head[2];
  const fwd = S.norm(S.sub(nose, head));
  const chin = S.add(S.add(head, S.scale(fwd, 0.07 * s)), [0, -0.105 * s, 0]);
  const hs = shade(head[2]);
  let headSvg = `<ellipse cx="${X(head).toFixed(1)}" cy="${Y(head).toFixed(1)}" rx="${(hr * 0.92).toFixed(1)}" ry="${(hr * 1.08).toFixed(1)}" fill="${hex(COLORS.head, hs)}" stroke="#1d2027" stroke-width="3"/>`;
  const jaw = [P('left-ear'), chin, P('right-ear')].map((p) => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
  if (facing > -0.03) headSvg += `<polygon points="${jaw}" fill="${hex(COLORS.head, hs * 0.93)}" stroke="#1d2027" stroke-width="2.5" stroke-linejoin="round"/>`;
  for (const e of ['left-ear', 'right-ear']) {
    const ep = P(e);
    if (ep[2] > head[2] - 0.03) headSvg += `<ellipse cx="${X(ep).toFixed(1)}" cy="${Y(ep).toFixed(1)}" rx="${(hr * 0.16).toFixed(1)}" ry="${(hr * 0.26).toFixed(1)}" fill="${hex(COLORS[e.startsWith('left') ? 'L' : 'R'], hs)}" stroke="#1d2027" stroke-width="1.5"/>`;
  }
  if (facing > -0.01) {
    for (const e of ['left-eye', 'right-eye']) {
      const ep = P(e);
      if (ep[2] - head[2] > -0.005) headSvg += `<ellipse cx="${X(ep).toFixed(1)}" cy="${Y(ep).toFixed(1)}" rx="${(hr * 0.15).toFixed(1)}" ry="${(hr * 0.09).toFixed(1)}" fill="#1d2027"/>`;
    }
    // Nose as a wedge pointing where the face points (reads in profile too)
    const nb = S.add(nose, [0, -0.02 * s, 0]);
    const tip = S.add(nose, S.scale(fwd, 0.025 * s));
    headSvg += `<polygon points="${X(nose).toFixed(1)},${Y(nose).toFixed(1)} ${X(tip).toFixed(1)},${Y(tip).toFixed(1)} ${X(nb).toFixed(1)},${Y(nb).toFixed(1)}" fill="#3b3f48" stroke="#1d2027" stroke-width="1.5"/>`;
  }
  items.push({ z: head[2], svg: headSvg });

  // Ball placement info (+ optional preview draw)
  const ballPx = ballInfo(frame, ppm);
  if (ballPx) {
    const bx = ballPx.x, by = ballPx.y, br = ballPx.r;
    if (drawBall) items.push({ z: ball[2], svg: ballSvg(bx, by, br) });
    else if (ballProxy && ballPx.held) items.push({ z: ball[2], svg: `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${br.toFixed(1)}" fill="${PROXY_COLOR}"/>` });
  }

  items.sort((a, b) => a.z - b.z);
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.w}" height="${CANVAS.h}" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}">${bg}${items.map((i) => i.svg).join('')}</svg>`;
  return { svg, ballPx };
}

/** Ball position on the canvas, in front of / behind the body, held or in flight. */
function ballInfo(frame, ppm) {
  const { pts, ball, ballR, ballHeld, s } = frame;
  if (!ball) return null;
  const X = (p) => CANVAS.w / 2 + p[0] * ppm;
  const Y = (p) => CANVAS.ground - p[1] * ppm;
  {
    const bx = X(ball), by = Y(ball), br = ballR * ppm;
    // Behind the body only when it is deeper than the torso AND inside the
    // body's horizontal span — a stable test (the old any-point-in-front test
    // flickered frame to frame, e.g. whenever a hand passed in front)
    const torsoZ = (pts[J['left-hip']][2] + pts[J['right-hip']][2] + pts[J['left-shoulder']][2] + pts[J['right-shoulder']][2]) / 4;
    const xs = [J['left-hip'], J['right-hip'], J['left-shoulder'], J['right-shoulder'], J['left-knee'], J['right-knee']].map((k) => X(pts[k]));
    const within = bx > Math.min(...xs) - br * 0.5 && bx < Math.max(...xs) + br * 0.5;
    const behind = within && ball[2] < torsoZ - 0.06;
    const palm = (side) => S.mid(pts[J[`${side}-wrist`]], pts[J[`${side}-middle-first-joint`]]);
    // Dribble physics decides (in hand vs. travelling); older motions fall
    // back to the palm distance
    const held = typeof ballHeld === 'boolean' ? ballHeld
      : Math.min(S.dist(ball, palm('left')), S.dist(ball, palm('right'))) < HELD_DIST_M * s;
    // which of the character's hands holds it (names are the character's own —
    // a mirrored variant already swapped the joint labels)
    const hand = S.dist(ball, palm('left')) <= S.dist(ball, palm('right')) ? 'left' : 'right';
    return { x: bx, y: by, r: br, behind, held, hand };
  }
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

const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));

/**
 * The performer's SAM 3D Body mesh re-posed on this motion frame and rendered
 * as a shaded clay figure (same canvas/scale/ground as the stick mannequin).
 */
async function renderMeshFrame(motion, i, bind, faces, fr, { view, mirror, statureM, ppm, drawBall, ballProxy, background, previewWidth }) {
  const MG = require('./mesh-guide');
  const v = VIEWS[view] || VIEWS[1];
  const P = motion.frames[i].joints;
  const verts = MG.poseMesh(bind, P);
  // Mesh sole → the floor-snapped foot keypoints (the keypoints sit inside the
  // foot, the scan's sole slightly below them)
  const footKpY = Math.min(...[J['left-heel'], J['right-heel'], J['left-big-toe-tip'], J['right-big-toe-tip'], J['left-small-toe-tip'], J['right-small-toe-tip']].map((k) => P[k][1]));
  let meshFootY = Infinity;
  for (let k = 0; k < bind.n; k++) if (bind.foot[k] && verts[k * 3 + 1] < meshFootY) meshFootY = verts[k * 3 + 1];
  const lift = Number.isFinite(meshFootY) ? footKpY - meshFootY : 0;
  const s = statureM && motion.statureM ? statureM / motion.statureM : 1;
  const R = S.rotY((v.yaw * Math.PI) / 180);
  const k = previewWidth ? previewWidth / CANVAS.w : 1;
  const W = Math.round(CANVAS.w * k), H = Math.round(CANVAS.h * k);
  const pp = ppm * k, cx = W / 2, gy = CANVAS.ground * k;
  const sv = new Float32Array(verts.length);
  for (let q = 0; q < bind.n; q++) {
    let p = [verts[q * 3], verts[q * 3 + 1] + lift, verts[q * 3 + 2]];
    if (mirror) p[0] = -p[0];
    p = S.mulMV(R, S.scale(p, s));
    sv[q * 3] = cx + p[0] * pp; sv[q * 3 + 1] = gy - p[1] * pp; sv[q * 3 + 2] = p[2];
  }
  let side = bind.side;
  if (mirror) side = side.map((c) => (c === 1 ? 2 : c === 2 ? 1 : c));
  const eyes = ['left-eye', 'right-eye'].map((n) => fr.pts[J[n]]).map((p) => [cx + p[0] * pp, gy - p[1] * pp, p[2]]);
  const ballPx = ballInfo(fr, ppm);
  let ball = null;
  if (ballPx && (drawBall || (ballProxy && ballPx.held))) {
    ball = { x: ballPx.x * k, y: ballPx.y * k, r: ballPx.r * k, z: fr.ball[2], rz: fr.ballR, color: drawBall ? 'ball' : 'proxy' };
  }
  const bg = background ? hexRgb(background) : null;
  const { rgba, alpha } = MG.rasterize(sv, faces, side, { W, H, ppm: pp, eyes, eyeR: 0.012 * s * pp, ball, background: bg, outlinePx: previewWidth ? 1 : 2 });
  const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  if (previewWidth) return { png, ppm, ground: CANVAS.ground, ballPx, guide: 'mesh' };
  const a4 = Buffer.alloc(W * H * 4);
  for (let q = 0; q < W * H; q++) { a4[q * 4] = a4[q * 4 + 1] = a4[q * 4 + 2] = 128; a4[q * 4 + 3] = alpha[q]; }
  const alphaPng = await sharp(a4, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { png, alphaPng, bbox: await alphaStats(alphaPng), ppm, ground: CANVAS.ground, ballPx, guide: 'mesh' };
}

/**
 * Render one frame. With `meshCtx` (the motion has SAM 3D Body meshes) the
 * guide is the performer's re-posed body scan; otherwise the stick mannequin.
 * @returns {{ png, alphaPng, bbox, ppm, ground, ballPx, guide }}
 */
async function renderFrame(motion, i, { view = 1, mirror = false, statureM, ppm, drawBall = false, ballProxy = false, background = '#ffffff', previewWidth, meshCtx } = {}) {
  const v = VIEWS[view] || VIEWS[1];
  const fr = posedFrame(motion, i, { yawDeg: v.yaw, mirror, statureM });
  const scalePpm = ppm || fitScale(motion, { statureM, mirror });
  if (meshCtx) {
    const bind = await meshCtx.bindingForFrame(motion, i);
    if (bind) return renderMeshFrame(motion, i, bind, meshCtx.faces, fr, { view, mirror, statureM, ppm: scalePpm, drawBall, ballProxy, background, previewWidth });
  }
  const { svg, ballPx } = buildSvg(fr, { ppm: scalePpm, background, drawBall, ballProxy });
  if (previewWidth) {
    // UI previews: rasterise straight at the small size, skip the alpha/QC pass
    const png = await sharp(Buffer.from(svg), { density: 72 * (previewWidth / CANVAS.w) }).resize({ width: previewWidth }).png().toBuffer();
    return { png, ppm: scalePpm, ground: CANVAS.ground, ballPx, guide: 'mannequin' };
  }
  const { svg: svgA } = buildSvg(fr, { ppm: scalePpm, background: null, drawBall: false });
  const [png, alphaPng] = await Promise.all([
    sharp(Buffer.from(svg)).png().toBuffer(),
    sharp(Buffer.from(svgA)).png().toBuffer(),
  ]);
  return { png, alphaPng, bbox: await alphaStats(alphaPng), ppm: scalePpm, ground: CANVAS.ground, ballPx, guide: 'mannequin' };
}

module.exports = { VIEWS, CANVAS, PROXY_COLOR, ballInfo, renderFrame, fitScale, posedFrame, ballPng, ballSvg, alphaStats };
