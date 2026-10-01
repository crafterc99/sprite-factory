/**
 * Soul Jam Capture — court layouts: where the player starts and travels and where the two cameras
 * stand, per capture setup, in real court coordinates (so a later calibration / reconstruction
 * step can use them as priors), plus a top-down SVG diagram for the director UI.
 *
 * Court frame (metres, half court): origin = centre of the baseline, +x = to the right when you
 * stand at the baseline looking up the court, +y = from the baseline toward half court, up = +z.
 * NBA dimensions (the lane and arc are drawn; FIBA differs by a few cm).
 */

export const COURT = {
  units: 'm',
  frame: 'origin = centre of the baseline; +x right (looking up court from the baseline); +y toward half court; +z up',
  halfLength: 14.33, width: 15.24,
  basket: [0, 1.575, 3.05],            // rim centre
  rimRadius: 0.2286,
  backboard: { y: 1.22, halfWidth: 0.915, bottom: 2.9, top: 3.97 },
  lane: { halfWidth: 2.44, ftLineY: 5.79, ftCircleR: 1.83 },
  threePoint: { radius: 7.24, cornerX: 6.71, cornerEndY: 4.27 },
  // named landmarks a calibration can click / detect (court floor unless z given)
  landmarks: {
    ft_left: [-2.44, 5.79, 0], ft_right: [2.44, 5.79, 0],
    lane_base_left: [-2.44, 0, 0], lane_base_right: [2.44, 0, 0],
    ft_centre: [0, 5.79, 0], top_of_key: [0, 7.62, 0],
    rim_centre: [0, 1.575, 3.05], backboard_bottom_left: [-0.915, 1.22, 2.9], backboard_bottom_right: [0.915, 1.22, 2.9],
    corner_three_left: [-6.71, 0, 0], corner_three_right: [6.71, 0, 0],
  },
};

const deg = (d) => (d * Math.PI) / 180;
/** a camera `dist` metres from `target`, at `angleDeg` measured from the player's facing direction (+ = to his left) */
function camAt(target, facing, angleDeg, dist, height) {
  const f = Math.atan2(facing[1], facing[0]) + deg(angleDeg);
  return { pos: [+(target[0] + Math.cos(f) * dist).toFixed(2), +(target[1] + Math.sin(f) * dist).toFixed(2), height], lookAt: [target[0], target[1], 1.0] };
}

/**
 * Capture setups. `player` = start → end (a travel arrow) in court metres; `area` = the travel
 * rectangle both cameras must see; cameras with height (lens at chest height), the angle to the
 * player's facing, distance, and what the frame must contain.
 */
export const SETUPS = {
  A: (() => {
    const p = [0, 6.6], face = [0, -1];                  // just above the free-throw line, facing the basket
    return {
      id: 'A', name: 'TOP OF KEY', purpose: 'Stationary · dribble · locomotion · defense',
      player: { start: p, end: p, facing: face, area: { x: [-2.6, 2.6], y: [4.4, 8.8] } },
      camA: { ...camAt(p, face, 45, 5.2, 1.1), label: 'front-left 45°', note: 'In front of the player, 45° to his left, ~5 m away' },
      camB: { ...camAt(p, face, -65, 5.2, 1.1), label: 'front-right ~65°', note: 'In front-right / side of the player, ~65° to his right, ~5 m away' },
      framing: ['Whole athlete head to feet with ~1 m spare above the head', 'Hands, ball and both feet visible for the whole travel lane (the dashed box)', 'The floor under his feet in frame (foot contacts)', 'Landscape, lens at chest height (~1.1 m), locked exposure / focus'],
      travelNote: 'Locomotion and defense clips: move along the lane inside the dashed box, reset outside it',
    };
  })(),
  B: (() => {
    const p = [0, 7.9], end = [0.6, 3.4], face = [0, -1];
    return {
      id: 'B', name: 'DRIVE LANE', purpose: 'Drives · pull-ups · moving gathers',
      player: { start: p, end, facing: face, area: { x: [-2.2, 2.8], y: [2.6, 8.6] } },
      camA: { pos: [5.6, 5.6, 1.1], lookAt: [0.3, 5.6, 1.0], label: 'side (right wing)', note: 'Right side of the lane, square to the drive, ~5.5 m away' },
      camB: { pos: [-4.2, 1.3, 1.1], lookAt: [0.3, 5.6, 1.0], label: 'baseline-left corner', note: 'Near the left baseline corner looking up the lane at the drive' },
      framing: ['The whole drive: start at the top of the key to the pull-up / gather spot', 'Player, ball, both feet, the approach and the take-off', 'Wide enough that a jump does not leave the top of the frame'],
      travelNote: 'Start at the top of the key facing the basket; drive down the lane to the marked spot',
    };
  })(),
  C: (() => {
    const p = [3.4, 6.8], end = [0.7, 1.9], face = [-0.45, -0.89];
    return {
      id: 'C', name: 'RIM', purpose: 'Layups · floaters · finishes at the rim',
      player: { start: p, end, facing: face, area: { x: [-1.8, 4.2], y: [0.8, 7.4] } },
      camA: { pos: [-5.6, 2.2, 1.2], lookAt: [1.2, 3.6, 1.6], label: 'left block, wide', note: 'Opposite side of the lane, level with the rim area, ~6.5 m from the rim' },
      camB: { pos: [6.4, 1.2, 1.2], lookAt: [1.2, 3.6, 1.6], label: 'right baseline corner, wide', note: 'Right baseline corner looking back up the drive' },
      framing: ['Approach, gather, take-off, the rim (3.05 m), the ball and the landing all in frame', 'Wide: the top of the frame above the rim', 'Neither camera behind the backboard'],
      travelNote: 'Start at the right wing; drive to the rim and finish; walk back outside the lane',
    };
  })(),
};

/** Per-animation player path in the setup (start, end) — travel direction relative to his facing. */
export function playerPath(anim, setup = SETUPS[anim.courtSetup]) {
  const s = setup.player.start, f = setup.player.facing;
  const left = [-f[1], f[0]];                               // his left
  const DIR = { forward: [0, 1], backward: [0, -1], left: [1, 0], right: [-1, 0], 'forward-right': [-0.7, 0.7], 'forward-left': [0.7, 0.7], 'back-right': [-0.7, -0.7], 'back-left': [0.7, -0.7] };
  if (anim.direction === 'to-basket' && setup.player.end) return { start: s, end: setup.player.end };
  const d = DIR[anim.direction];
  if (!d) return { start: s, end: s };
  const len = anim.loop ? 3.6 : 2.2;
  const v = [f[0] * d[1] + left[0] * d[0], f[1] * d[1] + left[1] * d[0]];
  // loops run along a lane centred on the spot; one-shots start at the spot
  const a = anim.loop ? [s[0] - v[0] * len / 2, s[1] - v[1] * len / 2] : s;
  return { start: a.map((x) => +x.toFixed(2)), end: [+(a[0] + v[0] * len).toFixed(2), +(a[1] + v[1] * len).toFixed(2)] };
}

/**
 * The calibration walk of a setup: the capture area's four corners, numbered in the order the
 * athlete walks them (1 = front-left, then front-right, back-right, back-left — "front" is toward
 * the hoop, left / right as he faces it), and the middle of the area.
 * @returns {{ corners: {n:number, name:string, pos:[number, number]}[], middle: [number, number] }}
 */
export function calibrationWalk(setupId) {
  const st = SETUPS[setupId], ar = st.player.area, f = st.player.facing, left = [-f[1], f[0]];
  const c = [(ar.x[0] + ar.x[1]) / 2, (ar.y[0] + ar.y[1]) / 2];
  const pts = [[ar.x[0], ar.y[0]], [ar.x[1], ar.y[0]], [ar.x[1], ar.y[1]], [ar.x[0], ar.y[1]]];
  // the angle of each corner seen from the middle, measured from his facing (+ = to his left)
  const ang = (p) => { const d = [p[0] - c[0], p[1] - c[1]]; return Math.atan2(d[0] * left[0] + d[1] * left[1], d[0] * f[0] + d[1] * f[1]); };
  const withA = pts.map((p) => ({ pos: p, a: ang(p) }));
  // start at the corner nearest "front-left" (+45°), then around: front-right, back-right, back-left
  const start = withA.reduce((b, x) => (Math.abs(x.a - Math.PI / 4) < Math.abs(b.a - Math.PI / 4) ? x : b));
  const rel = (x) => { let d = start.a - x.a; while (d < 0) d += 2 * Math.PI; return d; };
  const NAMES = ['front-left', 'front-right', 'back-right', 'back-left'];
  const corners = withA.sort((p, q) => rel(p) - rel(q)).map((x, i) => ({ n: i + 1, name: NAMES[i], pos: x.pos.map((v) => +v.toFixed(2)) }));
  return { corners, middle: c.map((v) => +v.toFixed(2)) };
}

/**
 * Top-down SVG of the half court with the setup (and optionally one animation's path): the
 * cameras, the capture area (dashed), and the athlete's START (green ring) and FINISH (orange
 * square) with the path between them and the way he faces at the start.
 * @param opts.focus        zoom to the capture area, the path and the basket (bigger markers)
 * @param opts.cameras      draw the two cameras (default true)
 * @param opts.calibration  the calibration walk instead of START / FINISH: the area's corners
 *                          numbered 1–4 and its middle; `highlight` (1–4, or 0 = the middle) marks
 *                          where the athlete goes now
 * @returns {string} an <svg> element (scaled to its container)
 */
export function courtSVG(setupId, anim = null, { width = 360, focus = false, cameras = true, calibration = false, highlight = null } = {}) {
  const st = SETUPS[setupId];
  // court metres → svg units (1 m = 20 u), y flipped so the baseline is at the bottom
  const X0 = -7.9, Y0 = -0.9, W = 15.8, H = 10.6, S = 20;
  const tx = (x) => ((x - X0) * S).toFixed(1), ty = (y) => ((Y0 + H - y) * S).toFixed(1);
  const L = COURT.lane, B = COURT.basket;
  const arc = (() => {
    // the corner lines up to where they meet the arc, then the arc around the basket
    const r = COURT.threePoint.radius, cx = COURT.threePoint.cornerX, a0 = Math.acos(cx / r);
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = Math.PI - a0 - (Math.PI - 2 * a0) * (i / 40); pts.push(`${tx(B[0] + r * Math.cos(t))} ${ty(B[1] + r * Math.sin(t))}`); }
    return `M ${tx(-cx)} ${ty(0)} L ${pts.join(' L ')} L ${tx(cx)} ${ty(0)}`;
  })();
  const path = anim ? playerPath(anim, st) : { start: st.player.start, end: st.player.end };
  const moving = Math.hypot(path.end[0] - path.start[0], path.end[1] - path.start[1]) > 0.1;
  const ar = st.player.area;
  // the view: the whole half court, or (focus) the area + path + basket with a margin
  let vb = [0, 0, W * S, H * S];
  if (focus) {
    const xs = [ar.x[0], ar.x[1], path.start[0], path.end[0], B[0] - 1], ys = [ar.y[0], ar.y[1], path.start[1], path.end[1], B[1] - 0.6];
    let x0 = Math.min(...xs) - 1.2, x1 = Math.max(...xs) + 1.2, y0 = Math.min(...ys) - 0.8, y1 = Math.max(...ys) + 1.2;
    if (x1 - x0 < 8) { const c = (x0 + x1) / 2; x0 = c - 4; x1 = c + 4; }
    x0 = Math.max(X0, x0); x1 = Math.min(X0 + W, x1); y0 = Math.max(Y0, y0); y1 = Math.min(Y0 + H, y1);
    vb = [(x0 - X0) * S, (Y0 + H - y1) * S, (x1 - x0) * S, (y1 - y0) * S].map((v) => +v.toFixed(1));
  }
  const k = focus ? 0.8 : 1;                                  // marker / text scale (a focused view is already magnified)
  const cam = (c, name, col) => {
    const [x, y] = c.pos, [lx, ly] = c.lookAt, a = Math.atan2(ly - y, lx - x), fov = deg(28), r = 2.2;
    const p1 = [x + Math.cos(a - fov) * r, y + Math.sin(a - fov) * r], p2 = [x + Math.cos(a + fov) * r, y + Math.sin(a + fov) * r];
    return `<path d="M ${tx(x)} ${ty(y)} L ${tx(p1[0])} ${ty(p1[1])} L ${tx(p2[0])} ${ty(p2[1])} Z" fill="${col}" opacity="0.2"/>`
      + `<rect x="${(+tx(x) - 14).toFixed(1)}" y="${(+ty(y) - 9).toFixed(1)}" width="28" height="18" rx="4" fill="${col}"/>`
      + `<text x="${tx(x)}" y="${(+ty(y) + 4.5).toFixed(1)}" font-size="12" font-weight="800" text-anchor="middle" fill="#fff">${name}</text>`;
  };
  const label = (x, y, text, col, dy) => {
    const w = text.length * 7.4 * k + 12 * k, h = 17 * k, cx = +tx(x), cy = +ty(y) + dy * k;
    return `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(4 * k).toFixed(1)}" fill="${col}"/>`
      + `<text x="${cx.toFixed(1)}" y="${(cy + 4.2 * k).toFixed(1)}" font-size="${(12 * k).toFixed(1)}" font-weight="800" text-anchor="middle" fill="#0b0b12" letter-spacing="0.5">${text}</text>`;
  };
  // which way he faces at the start (a short arrow from the START marker)
  const f = st.player.facing, fl = 1.1;
  const facing = `<line x1="${tx(path.start[0])}" y1="${ty(path.start[1])}" x2="${tx(path.start[0] + f[0] * fl)}" y2="${ty(path.start[1] + f[1] * fl)}" stroke="#e9dccb" stroke-width="${(2.5 * k).toFixed(1)}" stroke-dasharray="3 3" marker-end="url(#fa${setupId})"/>`;
  const START = '#3ddc84', FINISH = '#ff8a3d', PATH = '#ffd166';
  const startR = 9 * k, sq = 15 * k;
  const walk = calibration ? (() => {
    const w = calibrationWalk(setupId), HL = '#ffd166';
    const r = 11 * k, on = (n) => highlight === n;
    const dot = ([x, y], text, active, base) => `<circle cx="${tx(x)}" cy="${ty(y)}" r="${(active ? r * 1.35 : r).toFixed(1)}" fill="${active ? HL : base}" stroke="#0b0b12" stroke-width="2.5"/>`
      + `<text x="${tx(x)}" y="${(+ty(y) + 4.6 * k).toFixed(1)}" font-size="${(13 * k).toFixed(1)}" font-weight="900" text-anchor="middle" fill="#0b0b12">${text}</text>`;
    const ring = w.corners.map((c) => `${tx(c.pos[0])} ${ty(c.pos[1])}`);
    return `<path d="M ${ring.join(' L ')} Z" fill="none" stroke="${HL}" stroke-width="${(2 * k).toFixed(1)}" stroke-dasharray="2 6" opacity="0.7"/>`
      + w.corners.map((c) => dot(c.pos, String(c.n), on(c.n), '#7fd1ff')).join('')
      + dot(w.middle, '✕', on(0), '#e9dccb');
  })() : '';
  const markers = calibration ? walk : moving
    ? `<line x1="${tx(path.start[0])}" y1="${ty(path.start[1])}" x2="${tx(path.end[0])}" y2="${ty(path.end[1])}" stroke="${PATH}" stroke-width="${(5 * k).toFixed(1)}" stroke-linecap="round" marker-end="url(#ah${setupId})" opacity="0.95"/>`
      + `<rect x="${(+tx(path.end[0]) - sq / 2).toFixed(1)}" y="${(+ty(path.end[1]) - sq / 2).toFixed(1)}" width="${sq.toFixed(1)}" height="${sq.toFixed(1)}" rx="2" fill="${FINISH}" stroke="#1b1208" stroke-width="2"/>`
      + `<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="${startR.toFixed(1)}" fill="${START}" stroke="#08210f" stroke-width="2.5"/>`
      + label(path.start[0], path.start[1], 'START', START, -22) + label(path.end[0], path.end[1], 'FINISH', FINISH, 24)
    : `<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="${(startR * 1.5).toFixed(1)}" fill="none" stroke="${FINISH}" stroke-width="${(3.5 * k).toFixed(1)}"/>`
      + `<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="${startR.toFixed(1)}" fill="${START}" stroke="#08210f" stroke-width="2.5"/>`
      + label(path.start[0], path.start[1], 'START + FINISH', START, -26);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${width}" style="max-width:100%;height:auto;display:block" role="img" aria-label="Setup ${setupId} court diagram${calibration ? ': the calibration walk, corners 1 to 4 and the middle' : anim ? `: ${moving ? 'start and finish' : 'start and finish on the same spot'}` : ''}">
<defs>
  <marker id="ah${setupId}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${PATH}"/></marker>
  <marker id="fa${setupId}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#e9dccb"/></marker>
</defs>
<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#2b1d14"/>
<g fill="none" stroke="#e9dccb" stroke-width="2" opacity="0.8">
  <line x1="${tx(-7.62)}" y1="${ty(0)}" x2="${tx(7.62)}" y2="${ty(0)}"/>
  <rect x="${tx(-L.halfWidth)}" y="${ty(L.ftLineY)}" width="${(2 * L.halfWidth * S).toFixed(1)}" height="${(L.ftLineY * S).toFixed(1)}"/>
  <circle cx="${tx(0)}" cy="${ty(L.ftLineY)}" r="${(L.ftCircleR * S).toFixed(1)}"/>
  <path d="${arc}"/>
  <line x1="${tx(-COURT.backboard.halfWidth)}" y1="${ty(COURT.backboard.y)}" x2="${tx(COURT.backboard.halfWidth)}" y2="${ty(COURT.backboard.y)}" stroke-width="3"/>
  <circle cx="${tx(B[0])}" cy="${ty(B[1])}" r="${(COURT.rimRadius * S).toFixed(1)}" stroke="#ff6a1a" stroke-width="2.5"/>
</g>
<text x="${tx(0)}" y="${(+ty(B[1]) + 24).toFixed(1)}" font-size="${(11 * k).toFixed(1)}" font-weight="700" text-anchor="middle" fill="#e9dccb" opacity="0.85">HOOP</text>
<rect x="${tx(ar.x[0])}" y="${ty(ar.y[1])}" width="${((ar.x[1] - ar.x[0]) * S).toFixed(1)}" height="${((ar.y[1] - ar.y[0]) * S).toFixed(1)}" fill="#7fd1ff" fill-opacity="0.05" stroke="#7fd1ff" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.85"/>
${cameras ? cam(st.camA, 'A', '#3d7bff') + cam(st.camB, 'B', '#b04dff') : ''}
${calibration ? '' : facing}
${markers}
</svg>`;
}
