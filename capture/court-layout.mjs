/**
 * Soul Jam Capture — court layouts: where the player starts and travels and where the two cameras
 * stand, per capture setup, in real court coordinates (so a later calibration / reconstruction
 * step can use them as priors), plus a top-down SVG diagram for the director UI.
 *
 * Court frame (metres, half court): origin = centre of the baseline, +x = to the right when you
 * stand at the baseline looking up the court, +y = from the baseline toward half court, up = +z.
 * NBA dimensions (the lane and arc are drawn; FIBA differs by a few cm).
 *
 * Every instruction says "right / left" as you FACE THE HOOP (standing up court, looking at the
 * basket) — the athlete's own right and left when he faces it. In court coordinates: right = −x,
 * left = +x.
 *
 * Camera STATIONS: one placement of the two cameras = one calibration. Setups A and B share
 * station A (the cameras do not move between them); setup C (the rim) has its own. Each station's
 * cameras see its whole area with a phone's normal (1×) lens: the nearest corner ≥ 4.5 m away (head
 * to feet fits the frame) and the area within ~60° across (tests/capture.test.js checks both).
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

const r2 = (v) => +(+v).toFixed(2);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; };
const m1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)} m`;

/** A locomotion loop runs along a lane this long, centred on the setup's spot. */
export const LOOP_LANE_M = 3;
/** The calibration walk's pace: an easy walk (m/s). */
export const WALK_SPEED = 1.3;
const WALK_HOLD_START = 2, WALK_HOLD_END = 2;

/**
 * A spot in words, from the court lines (right / left as you face the hoop):
 * "1.1 m inside the right sideline, 2.0 m up from the baseline".
 */
export function spotWords([x, y]) {
  const L = COURT.lane.halfWidth, FT = COURT.lane.ftLineY, SL = COURT.width / 2;
  const side = x < 0 ? 'right' : 'left', ax = Math.abs(x);
  let lat;
  if (ax < 0.25) lat = 'in the middle';
  else if (ax < L - 0.15) lat = `${m1(ax)} ${side} of the middle`;
  else if (ax <= L + 0.15) lat = `on the ${side} lane line`;
  else if (ax < SL - 1.6) lat = `${m1(ax - L)} outside the ${side} lane line`;
  else if (ax <= SL) lat = `${m1(SL - ax)} inside the ${side} sideline`;
  else lat = `${m1(ax - SL)} outside the ${side} sideline`;
  let dep;
  if (y < -0.05) dep = `${m1(-y)} behind the baseline`;
  else if (y <= 3.0) dep = `${m1(y)} up from the baseline`;
  else if (Math.abs(y - FT) < 0.15) dep = 'on the free-throw line';
  else if (y < FT) dep = `${m1(FT - y)} from the free-throw line toward the hoop`;
  else dep = `${m1(y - FT)} behind the free-throw line`;
  return `${lat}, ${dep}`;
}

const middleOf = (ar) => [r2((ar.x[0] + ar.x[1]) / 2), r2((ar.y[0] + ar.y[1]) / 2)];
/** A camera of a station: where it stands (court metres + lens height), where it aims, in plain words. */
function camera(pos, area, label) {
  const mid = middleOf(area);
  return {
    pos, lookAt: [mid[0], mid[1], 1.0], label,
    note: `${spotWords(pos)} — about ${Math.round(dist(pos, mid))} m from ✕. Lens ${pos[2].toFixed(1)} m high (chest height), phone sideways (landscape), aimed at ✕.`,
  };
}

/**
 * Camera stations. `area`: what both cameras must see (every path of its setups with ~0.6 m to
 * spare). Cameras at chest height, far enough that a 1× lens takes in the whole area head to feet.
 */
export const STATIONS = (() => {
  const areaA = { x: [-2.1, 2.1], y: [3.3, 8.95] };     // setup A (4.25–8.95) and setup B (3.3–8.2) together
  const areaC = { x: [-2.8, 2.8], y: [1.0, 5.6] };      // both sides of the lane, up to the rim
  return {
    A: {
      id: 'A', setups: ['A', 'B'], name: 'TOP OF KEY + DRIVE LANE', area: areaA, middle: middleOf(areaA), facing: [0, -1],
      camA: camera([-6.5, 2.0, 1.1], areaA, 'right side, near the baseline'),
      camB: camera([6.5, 2.0, 1.1], areaA, 'left side, near the baseline'),
    },
    C: {
      id: 'C', setups: ['C'], name: 'RIM', area: areaC, middle: middleOf(areaC), facing: [0, -1], top: 3.4,
      camA: camera([-7.0, -1.0, 1.2], areaC, 'right baseline corner'),
      camB: camera([7.0, -1.0, 1.2], areaC, 'left baseline corner'),
    },
  };
})();
/** The camera station of a setup (or of a station id): A and B → 'A', C → 'C'. */
export function stationOf(id) {
  if (!id) return null;
  if (STATIONS[id]) return id;
  for (const st of Object.values(STATIONS)) if (st.setups.includes(id)) return st.id;
  return id;
}
/** Do two setups use the same camera placement (no camera move, one calibration)? */
export const sameStation = (a, b) => !!a && !!b && stationOf(a) === stationOf(b);

/**
 * Capture setups. `player.spot` = where stationary moves happen (travelling ones are centred on
 * it); `player.drive` = the path toward the basket for the RIGHT hand (the left hand mirrors it to
 * the other side of the lane); `area` = the setup's own travel rectangle; cameras = its station's.
 */
export const SETUPS = {
  A: (() => {
    const spot = [0, 6.6], face = [0, -1];               // just behind the free-throw line, facing the basket
    return {
      id: 'A', name: 'TOP OF KEY', purpose: 'Stationary · dribble · locomotion · defense', station: 'A',
      player: { spot, start: spot, end: spot, facing: face, area: { x: [-2.1, 2.1], y: [4.25, 8.95] } },
      camA: STATIONS.A.camA, camB: STATIONS.A.camB,
      framing: ['Whole athlete head to feet at every corner of the area', 'Hands, ball and both feet visible for the whole travel lane', 'The floor under his feet in frame (foot contacts)', 'Landscape, lens at chest height (~1.1 m), locked exposure / focus'],
      travelNote: 'Locomotion and defense clips run along a 3 m lane centred on the spot; walk back outside it between reps',
    };
  })(),
  B: (() => {
    const face = [0, -1], drive = { start: [-0.3, 7.6], end: [-1.0, 3.9] };
    return {
      id: 'B', name: 'DRIVE LANE', purpose: 'Drives · pull-ups · moving gathers', station: 'A',
      player: { spot: drive.start, start: drive.start, end: drive.end, drive, facing: face, area: { x: [-1.6, 1.6], y: [3.3, 8.2] } },
      camA: STATIONS.A.camA, camB: STATIONS.A.camB,
      framing: ['The whole drive: from the top of the key to the pull-up / gather spot', 'Player, ball, both feet, the approach and the take-off', 'Wide enough that a jump does not leave the top of the frame'],
      travelNote: 'Same camera spots as setup A. Start at the top of the key facing the basket; drive to the FINISH mark (right hand: the right side of the lane, left hand: the left side)',
    };
  })(),
  C: (() => {
    const face = [0, -1], drive = { start: [-2.2, 5.0], end: [-0.7, 1.9] }, middle = { start: [0, 4.8], end: [0, 2.1] };
    return {
      id: 'C', name: 'RIM', purpose: 'Layups · floaters · finishes at the rim', station: 'C',
      player: { spot: drive.start, start: drive.start, end: drive.end, drive, middleDrive: middle, facing: face, area: { x: [-2.8, 2.8], y: [1.0, 5.6] } },
      camA: STATIONS.C.camA, camB: STATIONS.C.camB,
      framing: ['Approach, gather, take-off, the rim (3.05 m), the ball and the landing all in frame', 'Wide: the top of the frame above the rim', 'Neither camera behind the backboard'],
      travelNote: 'Right hand: drive in from the right side of the lane; left hand: from the left side; two-foot finishes straight down the middle',
    };
  })(),
};

/**
 * Per-animation player path in court metres: { start, end, facing, lengthM }. Travelling moves are
 * centred on the setup's spot (loops: a 3 m lane, one-shots: their `travelM`); moves toward the
 * basket follow the setup's drive, on the side of the ball hand.
 */
export function playerPath(anim, setup = SETUPS[anim.courtSetup]) {
  const pl = setup.player;
  if (anim.direction === 'to-basket' && pl.drive) {
    const mid = (anim.ballHand === 'both' || anim.ballHand === 'none') && pl.middleDrive;
    const d = mid || pl.drive, sx = !mid && anim.ballHand === 'L' ? -1 : 1;   // the left hand mirrors the right-hand drive
    const start = [r2(d.start[0] * sx), d.start[1]], end = [r2(d.end[0] * sx), d.end[1]];
    return { start, end, facing: unit([end[0] - start[0], end[1] - start[1]]).map(r2), lengthM: r2(dist(start, end)) };
  }
  const s = pl.spot, f = pl.facing, left = [-f[1], f[0]];                    // his left (as he faces the hoop)
  const DIR = { forward: [0, 1], backward: [0, -1], left: [1, 0], right: [-1, 0], 'forward-right': [-1, 1], 'forward-left': [1, 1], 'back-right': [-1, -1], 'back-left': [1, -1] };
  const d = DIR[anim.direction];
  if (!d) return { start: s, end: s, facing: f, lengthM: 0 };
  const len = anim.loop ? LOOP_LANE_M : (anim.travelM || 2);
  const v = unit([f[0] * d[1] + left[0] * d[0], f[1] * d[1] + left[1] * d[0]]);
  const a = [s[0] - (v[0] * len) / 2, s[1] - (v[1] * len) / 2];             // centred on the spot
  return { start: a.map(r2), end: [r2(a[0] + v[0] * len), r2(a[1] + v[1] * len)], facing: f, lengthM: len };
}

/**
 * The calibration walk of a station (or of a setup: its station): the area's four corners,
 * numbered in the order the athlete walks them (1 = front-left, then front-right, back-right,
 * back-left — "front" is toward the hoop, left / right as he faces it), and the middle (✕); with
 * the timing at an easy walk: 2 s on ✕ arms up, ✕ → 1 → 2 → 3 → 4 → ✕ at 1.3 m/s, 2 s arms up.
 * @returns {{ station, corners: {n, name, pos, words}[], middle, middleWords, legs: {to, metres, at, until}[], totalSec, speed }}
 */
export function calibrationWalk(id) {
  const st = STATIONS[stationOf(id)], ar = st.area, f = st.facing, left = [-f[1], f[0]];
  const c = st.middle;
  const pts = [[ar.x[0], ar.y[0]], [ar.x[1], ar.y[0]], [ar.x[1], ar.y[1]], [ar.x[0], ar.y[1]]];
  // the angle of each corner seen from the middle, measured from his facing (+ = to his left)
  const ang = (p) => { const d = [p[0] - c[0], p[1] - c[1]]; return Math.atan2(d[0] * left[0] + d[1] * left[1], d[0] * f[0] + d[1] * f[1]); };
  const withA = pts.map((p) => ({ pos: p, a: ang(p) }));
  const start = withA.reduce((b, x) => (Math.abs(x.a - Math.PI / 4) < Math.abs(b.a - Math.PI / 4) ? x : b));
  const rel = (x) => { let d = start.a - x.a; while (d < 0) d += 2 * Math.PI; return d; };
  const NAMES = ['front-left', 'front-right', 'back-right', 'back-left'];
  const corners = withA.sort((p, q) => rel(p) - rel(q)).map((x, i) => ({ n: i + 1, name: NAMES[i], pos: x.pos.map(r2), words: spotWords(x.pos) }));
  const legs = [];
  let t = WALK_HOLD_START, from = c;
  for (const p of [...corners, { n: 0, pos: c }]) {
    const m = dist(from, p.pos), dur = m / WALK_SPEED;
    legs.push({ to: p.n, metres: r2(m), at: r2(t), until: r2(t + dur) });
    t += dur; from = p.pos;
  }
  return { station: st.id, corners, middle: c, middleWords: spotWords(c), legs, totalSec: Math.ceil(t + WALK_HOLD_END), speed: WALK_SPEED };
}
/** How long a station's calibration recording runs (it stops by itself). */
export const calibrationSec = (id) => calibrationWalk(id).totalSec;
/**
 * Where the athlete should be `t` seconds into the calibration recording:
 * { target: 1–4 (a corner) | 0 (✕), phase: 'start' | 'walk' | 'end', leg }.
 */
export function walkStep(walk, t) {
  if (t == null || t < walk.legs[0].at) return { target: 0, phase: 'start' };
  const leg = walk.legs.find((l) => t < l.until);
  return leg ? { target: leg.to, phase: 'walk', leg } : { target: 0, phase: 'end' };
}

/**
 * Framing of a camera over an area: how wide the area is in the picture (degrees across), the
 * nearest and farthest corner (m), and the vertical angle from the floor at the nearest corner to
 * `top` metres above it (head room; the rim for setup C).
 */
export function framing(cam, area, { top = 2.5 } = {}) {
  const cs = [[area.x[0], area.y[0]], [area.x[1], area.y[0]], [area.x[1], area.y[1]], [area.x[0], area.y[1]]];
  const [x, y, h] = cam.pos;
  const ang = cs.map((p) => Math.atan2(p[1] - y, p[0] - x));
  let span = Infinity;
  for (const ref of ang) span = Math.min(span, Math.max(...ang.map((v) => { let d = v - ref; while (d < 0) d += 2 * Math.PI; return d; })));
  const ds = cs.map((p) => dist(p, [x, y]));
  const near = Math.min(...ds);
  const deg = (r) => (r * 180) / Math.PI;
  return { acrossDeg: +deg(span).toFixed(1), nearM: r2(near), farM: r2(Math.max(...ds)), verticalDeg: +deg(Math.atan(h / near) + Math.atan((top - h) / near)).toFixed(1) };
}

/**
 * Top-down SVG of the half court with the setup (and optionally one animation's path): the
 * cameras, the capture area (dashed), and the athlete's START (green ring) and FINISH (orange
 * square) with the path between them and the way he faces at the start. The START label sits
 * behind START (against the travel), the FINISH label beyond FINISH, so they never overlap.
 * @param opts.focus        zoom to the capture area, the path and the basket (bigger markers)
 * @param opts.cameras      draw the two cameras (default true)
 * @param opts.calibration  the calibration walk instead of START / FINISH: the station's area,
 *                          its corners numbered 1–4 and its middle; `highlight` (1–4, or 0 = the
 *                          middle) marks where the athlete goes now
 * @returns {string} an <svg> element (scaled to its container)
 */
export function courtSVG(setupId, anim = null, { width = 360, focus = false, cameras = true, calibration = false, highlight = null } = {}) {
  const st = SETUPS[setupId] || SETUPS.A, station = STATIONS[stationOf(setupId)] || STATIONS.A;
  // court metres → svg units (1 m = 20 u), y flipped so the baseline is at the bottom
  const X0 = -8.6, Y0 = -1.9, W = 17.2, H = 11.9, S = 20;
  const tx = (x) => ((x - X0) * S).toFixed(1), ty = (y) => ((Y0 + H - y) * S).toFixed(1);
  const L = COURT.lane, B = COURT.basket;
  const arc = (() => {
    // the corner lines up to where they meet the arc, then the arc around the basket
    const r = COURT.threePoint.radius, cx = COURT.threePoint.cornerX, a0 = Math.acos(cx / r);
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = Math.PI - a0 - (Math.PI - 2 * a0) * (i / 40); pts.push(`${tx(B[0] + r * Math.cos(t))} ${ty(B[1] + r * Math.sin(t))}`); }
    return `M ${tx(-cx)} ${ty(0)} L ${pts.join(' L ')} L ${tx(cx)} ${ty(0)}`;
  })();
  const path = anim ? playerPath(anim, st) : { start: st.player.start, end: st.player.end, facing: st.player.facing };
  const moving = dist(path.start, path.end) > 0.1;
  const ar = calibration ? station.area : st.player.area;
  const k = focus ? 0.8 : 1;                                  // marker / text scale (a focused view is already magnified)
  const START = '#3ddc84', FINISH = '#ff8a3d', PATH = '#ffd166';
  const startR = 9 * k, sq = 15 * k;
  const marks = !calibration && anim ? pathMarks(path, { k, tx, ty }) : null;
  // the view: the whole half court, or (focus) the area + path + labels + basket with a margin
  let vb = [0, 0, W * S, H * S];
  if (focus) {
    const xs = [ar.x[0], ar.x[1], path.start[0], path.end[0], B[0] - 1, B[0] + 1], ys = [ar.y[0], ar.y[1], path.start[1], path.end[1], B[1] - 0.6];
    let x0 = Math.min(...xs) - 1.2, x1 = Math.max(...xs) + 1.2, y0 = Math.min(...ys) - 0.8, y1 = Math.max(...ys) + 1.2;
    if (x1 - x0 < 8) { const c = (x0 + x1) / 2; x0 = c - 4; x1 = c + 4; }
    let v = [(x0 - X0) * S, (Y0 + H - y1) * S, (x1 - x0) * S, (y1 - y0) * S];
    for (const r of marks?.rects || []) {                       // the labels always fit
      const vx1 = Math.max(v[0] + v[2], r.x + r.w + 6), vy1 = Math.max(v[1] + v[3], r.y + r.h + 6);
      v[0] = Math.min(v[0], r.x - 6); v[1] = Math.min(v[1], r.y - 6); v[2] = vx1 - v[0]; v[3] = vy1 - v[1];
    }
    v[0] = Math.max(0, v[0]); v[1] = Math.max(0, v[1]); v[2] = Math.min(W * S - v[0], v[2]); v[3] = Math.min(H * S - v[1], v[3]);
    vb = v.map((x) => +x.toFixed(1));
  }
  const cam = (c, name, col) => {
    const [x, y] = c.pos, [lx, ly] = c.lookAt, a = Math.atan2(ly - y, lx - x), fov = (28 * Math.PI) / 180, r = 2.2;
    const p1 = [x + Math.cos(a - fov) * r, y + Math.sin(a - fov) * r], p2 = [x + Math.cos(a + fov) * r, y + Math.sin(a + fov) * r];
    return `<path d="M ${tx(x)} ${ty(y)} L ${tx(p1[0])} ${ty(p1[1])} L ${tx(p2[0])} ${ty(p2[1])} Z" fill="${col}" opacity="0.22"/>`
      + `<rect x="${(+tx(x) - 14).toFixed(1)}" y="${(+ty(y) - 9).toFixed(1)}" width="28" height="18" rx="4" fill="${col}"/>`
      + `<text x="${tx(x)}" y="${(+ty(y) + 4.5).toFixed(1)}" font-size="12" font-weight="800" text-anchor="middle" fill="#fff">${name}</text>`;
  };
  const label = (r, text, col) => `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="${(4 * k).toFixed(1)}" fill="${col}"/>`
    + `<text x="${(r.x + r.w / 2).toFixed(1)}" y="${(r.y + r.h / 2 + 4.2 * k).toFixed(1)}" font-size="${(12 * k).toFixed(1)}" font-weight="800" text-anchor="middle" fill="#0b0b12" letter-spacing="0.5">${text}</text>`;
  // which way he faces at the start (a short arrow from the START marker)
  const f = path.facing || st.player.facing, fl = 1.1;
  const facing = `<line x1="${tx(path.start[0])}" y1="${ty(path.start[1])}" x2="${tx(path.start[0] + f[0] * fl)}" y2="${ty(path.start[1] + f[1] * fl)}" stroke="#e9dccb" stroke-width="${(2.5 * k).toFixed(1)}" stroke-dasharray="3 3" marker-end="url(#fa${setupId})"/>`;
  const walk = calibration ? (() => {
    const w = calibrationWalk(station.id), HL = '#ffd166';
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
      + (marks ? label(marks.start, 'START', START) + label(marks.finish, 'FINISH', FINISH) : '')
    : `<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="${(startR * 1.5).toFixed(1)}" fill="none" stroke="${FINISH}" stroke-width="${(3.5 * k).toFixed(1)}"/>`
      + `<circle cx="${tx(path.start[0])}" cy="${ty(path.start[1])}" r="${startR.toFixed(1)}" fill="${START}" stroke="#08210f" stroke-width="2.5"/>`
      + (marks ? label(marks.start, 'START + FINISH', START) : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${width}" style="max-width:100%;height:auto;display:block" role="img" aria-label="Setup ${setupId} court diagram${calibration ? ': the calibration walk, corners 1 to 4 and the middle' : anim ? `: ${moving ? 'start and finish' : 'start and finish on the same spot'}` : ''}">
<defs>
  <marker id="ah${setupId}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${PATH}"/></marker>
  <marker id="fa${setupId}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#e9dccb"/></marker>
</defs>
<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#2b1d14"/>
<g fill="none" stroke="#e9dccb" stroke-width="2" opacity="0.8">
  <line x1="${tx(-7.62)}" y1="${ty(0)}" x2="${tx(7.62)}" y2="${ty(0)}"/>
  <line x1="${tx(-7.62)}" y1="${ty(0)}" x2="${tx(-7.62)}" y2="${ty(10)}" opacity="0.5"/>
  <line x1="${tx(7.62)}" y1="${ty(0)}" x2="${tx(7.62)}" y2="${ty(10)}" opacity="0.5"/>
  <rect x="${tx(-L.halfWidth)}" y="${ty(L.ftLineY)}" width="${(2 * L.halfWidth * S).toFixed(1)}" height="${(L.ftLineY * S).toFixed(1)}"/>
  <circle cx="${tx(0)}" cy="${ty(L.ftLineY)}" r="${(L.ftCircleR * S).toFixed(1)}"/>
  <path d="${arc}"/>
  <line x1="${tx(-COURT.backboard.halfWidth)}" y1="${ty(COURT.backboard.y)}" x2="${tx(COURT.backboard.halfWidth)}" y2="${ty(COURT.backboard.y)}" stroke-width="3"/>
  <circle cx="${tx(B[0])}" cy="${ty(B[1])}" r="${(COURT.rimRadius * S).toFixed(1)}" stroke="#ff6a1a" stroke-width="2.5"/>
</g>
<text x="${tx(0)}" y="${(+ty(B[1]) + 24).toFixed(1)}" font-size="${(11 * k).toFixed(1)}" font-weight="700" text-anchor="middle" fill="#e9dccb" opacity="0.85">HOOP</text>
<rect x="${tx(ar.x[0])}" y="${ty(ar.y[1])}" width="${((ar.x[1] - ar.x[0]) * S).toFixed(1)}" height="${((ar.y[1] - ar.y[0]) * S).toFixed(1)}" fill="#7fd1ff" fill-opacity="0.05" stroke="#7fd1ff" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.85"/>
${cameras ? cam(station.camA, 'A', '#3d7bff') + cam(station.camB, 'B', '#b04dff') : ''}
${calibration ? '' : facing}
${markers}
</svg>`;
}

/**
 * Where the START and FINISH labels go (svg units): START behind its marker (against the travel
 * direction — or beside it when that is where the facing arrow points), FINISH beyond its marker.
 * Exported for the tests (the two labels never overlap).
 */
export function pathMarks(path, { k = 1, tx = (x) => x * 20, ty = (y) => -y * 20 } = {}) {
  const box = (text) => ({ w: text.length * 7.4 * k + 12 * k, h: 17 * k });
  const S = [+tx(path.start[0]), +ty(path.start[1])], E = [+tx(path.end[0]), +ty(path.end[1])];
  const at = (c, b) => ({ x: c[0] - b.w / 2, y: c[1] - b.h / 2, w: b.w, h: b.h });
  if (Math.hypot(E[0] - S[0], E[1] - S[1]) < 2) {
    const b = box('START + FINISH');
    const r = at([S[0], S[1] - 26 * k], b);
    return { start: r, finish: null, rects: [r] };
  }
  const u = unit([E[0] - S[0], E[1] - S[1]]);
  const reach = (b, r) => Math.abs(u[0]) * (b.w / 2) + Math.abs(u[1]) * (b.h / 2) + r + 5 * k;
  const bs = box('START'), bf = box('FINISH');
  // against the travel — unless the facing arrow points that way (a backward move): then to the side
  const fs = path.facing ? unit([+tx(path.start[0] + path.facing[0]) - S[0], +ty(path.start[1] + path.facing[1]) - S[1]]) : [0, 0];
  let dirS = [-u[0], -u[1]];
  if (dirS[0] * fs[0] + dirS[1] * fs[1] > 0.5) dirS = [-u[1], u[0]];
  const reachS = Math.abs(dirS[0]) * (bs.w / 2) + Math.abs(dirS[1]) * (bs.h / 2) + 9 * k + 5 * k;
  const start = at([S[0] + dirS[0] * reachS, S[1] + dirS[1] * reachS], bs);
  const finish = at([E[0] + u[0] * reach(bf, 7.5 * k), E[1] + u[1] * reach(bf, 7.5 * k)], bf);
  return { start, finish, rects: [start, finish] };
}
