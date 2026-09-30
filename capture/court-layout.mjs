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
 * Top-down SVG of the half court with the setup (and optionally one animation's path).
 * @returns {string} an <svg> element (scaled to its container)
 */
export function courtSVG(setupId, anim = null, { width = 360 } = {}) {
  const st = SETUPS[setupId];
  // view: x −7.6…7.6, y −0.6…9.4 (metres) → svg units (1 m = 20 u), y flipped so the baseline is at the bottom
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
  const cam = (c, name, col) => {
    const [x, y] = c.pos, [lx, ly] = c.lookAt, a = Math.atan2(ly - y, lx - x), fov = deg(28), r = 2.2;
    const p1 = [x + Math.cos(a - fov) * r, y + Math.sin(a - fov) * r], p2 = [x + Math.cos(a + fov) * r, y + Math.sin(a + fov) * r];
    return `<path d="M ${tx(x)} ${ty(y)} L ${tx(p1[0])} ${ty(p1[1])} L ${tx(p2[0])} ${ty(p2[1])} Z" fill="${col}" opacity="0.18"/>`
      + `<rect x="${(+tx(x) - 9).toFixed(1)}" y="${(+ty(y) - 7).toFixed(1)}" width="18" height="14" rx="3" fill="${col}"/>`
      + `<text x="${tx(x)}" y="${(+ty(y) + 4).toFixed(1)}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${name}</text>`;
  };
  const ar = st.player.area;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * S} ${H * S}" width="${width}" style="max-width:100%;height:auto;display:block" role="img" aria-label="Setup ${setupId} court diagram">
<rect width="${W * S}" height="${H * S}" fill="#2b1d14"/>
<g fill="none" stroke="#e9dccb" stroke-width="2" opacity="0.85">
  <line x1="${tx(-7.62)}" y1="${ty(0)}" x2="${tx(7.62)}" y2="${ty(0)}"/>
  <rect x="${tx(-L.halfWidth)}" y="${ty(L.ftLineY)}" width="${(2 * L.halfWidth * S).toFixed(1)}" height="${(L.ftLineY * S).toFixed(1)}"/>
  <circle cx="${tx(0)}" cy="${ty(L.ftLineY)}" r="${(L.ftCircleR * S).toFixed(1)}"/>
  <path d="${arc}"/>
  <line x1="${tx(-COURT.backboard.halfWidth)}" y1="${ty(COURT.backboard.y)}" x2="${tx(COURT.backboard.halfWidth)}" y2="${ty(COURT.backboard.y)}" stroke-width="3"/>
  <circle cx="${tx(B[0])}" cy="${ty(B[1])}" r="${(COURT.rimRadius * S).toFixed(1)}" stroke="#ff6a1a" stroke-width="2.5"/>
</g>
<rect x="${tx(ar.x[0])}" y="${ty(ar.y[1])}" width="${((ar.x[1] - ar.x[0]) * S).toFixed(1)}" height="${((ar.y[1] - ar.y[0]) * S).toFixed(1)}" fill="none" stroke="#7fd1ff" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.8"/>
${cam(st.camA, 'A', '#3d7bff')}${cam(st.camB, 'B', '#b04dff')}
${moving ? `<defs><marker id="ah${setupId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#ffd166"/></marker></defs>
<line x1="${tx(path.start[0])}" y1="${ty(path.start[1])}" x2="${tx(path.end[0])}" y2="${ty(path.end[1])}" stroke="#ffd166" stroke-width="4" marker-end="url(#ah${setupId})"/>` : ''}
<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="8" fill="#ffd166" stroke="#1b1208" stroke-width="2"/>
<text x="${tx(path.start[0])}" y="${(+ty(path.start[1]) - 12).toFixed(1)}" font-size="11" font-weight="700" text-anchor="middle" fill="#ffd166">START</text>
${moving ? `<text x="${tx(path.end[0])}" y="${(+ty(path.end[1]) + 20).toFixed(1)}" font-size="11" font-weight="700" text-anchor="middle" fill="#ffd166">END</text>` : ''}
<text x="${tx(0)}" y="${(+ty(B[1]) + 26).toFixed(1)}" font-size="10" text-anchor="middle" fill="#e9dccb" opacity="0.8">BASKET</text>
</svg>`;
}
