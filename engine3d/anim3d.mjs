/**
 * anim3d — engine-agnostic 3D animation runtime for the Sprite Factory game
 * clips (lib/mocap/clip-builder.js) on skinned character rigs
 * (lib/mocap/character-rig.js). No three.js in here: court3d.html renders,
 * this module decides every joint, every foot plant and the ball in hand.
 * The same file runs in Node (tests measure world foot slide).
 *
 * Layers, per frame:
 *   1. BASE POSE in capsule space (the player's position + facing):
 *        idle / procedural locomotion  — idle dribble loop for the upper body,
 *                                        a foot planner for the legs
 *        recorded locomotion loops     — direction blend space, phase-synced
 *                                        on foot plants, playback rate =
 *                                        speed / clip speed
 *        actions (moves, shots)        — clip with root motion, entered at the
 *                                        best-matching frame, orientation-warped
 *                                        so shots release facing the hoop
 *   2. RETARGET: every clip is re-projected onto the character's bone lengths
 *      (directions from the clip, lengths from the rig); root motion and
 *      pelvis height scale with leg length — any clip plays on any character
 *   3. INERTIALIZATION on every source switch (offset + velocity decay,
 *      spring half-life ~0.1 s): no pops, no floaty cross-fades
 *   4. FEET: planted feet are locked in the WORLD (planner stance feet or
 *      clip contacts), legs solved by two-bone IK with a pelvis drop when a
 *      foot is out of reach — feet never slide
 *   5. SKINNING: 47 segment matrices [u·L | v | w | a] (mesh-guide.js segFrame)
 *      × rest inverses = linear-blend skinning bone matrices
 *
 * Coordinates: metres, y up. yaw 0 = facing +Z; rot(yaw) = rotY(yaw);
 * a clip's root space has the player at the origin facing +Z, left = +X.
 */

// ── skeleton ────────────────────────────────────────────────────────────────
export const MHR70 = [
  'nose', 'left-eye', 'right-eye', 'left-ear', 'right-ear',
  'left-shoulder', 'right-shoulder', 'left-elbow', 'right-elbow',
  'left-hip', 'right-hip', 'left-knee', 'right-knee', 'left-ankle', 'right-ankle',
  'left-big-toe-tip', 'left-small-toe-tip', 'left-heel',
  'right-big-toe-tip', 'right-small-toe-tip', 'right-heel',
  'right-thumb-tip', 'right-thumb-first-joint', 'right-thumb-second-joint', 'right-thumb-third-joint',
  'right-index-tip', 'right-index-first-joint', 'right-index-second-joint', 'right-index-third-joint',
  'right-middle-tip', 'right-middle-first-joint', 'right-middle-second-joint', 'right-middle-third-joint',
  'right-ring-tip', 'right-ring-first-joint', 'right-ring-second-joint', 'right-ring-third-joint',
  'right-pinky-tip', 'right-pinky-first-joint', 'right-pinky-second-joint', 'right-pinky-third-joint',
  'right-wrist',
  'left-thumb-tip', 'left-thumb-first-joint', 'left-thumb-second-joint', 'left-thumb-third-joint',
  'left-index-tip', 'left-index-first-joint', 'left-index-second-joint', 'left-index-third-joint',
  'left-middle-tip', 'left-middle-first-joint', 'left-middle-second-joint', 'left-middle-third-joint',
  'left-ring-tip', 'left-ring-first-joint', 'left-ring-second-joint', 'left-ring-third-joint',
  'left-pinky-tip', 'left-pinky-first-joint', 'left-pinky-second-joint', 'left-pinky-third-joint',
  'left-wrist',
  'left-olecranon', 'right-olecranon', 'left-cubital-fossa', 'right-cubital-fossa',
  'left-acromion', 'right-acromion', 'neck',
];
export const J = Object.fromEntries(MHR70.map((n, i) => [n, i]));
export const PELVIS = 70;
export const NJ = 71;                 // 70 keypoints + the virtual pelvis
const BALL = NJ;                      // the ball rides along as slot 71 in pose buffers
export const NP = NJ + 1;                    // points per pose buffer
export const MIRROR = MHR70.map((n) => (n.startsWith('left-') ? J['right-' + n.slice(5)] : n.startsWith('right-') ? J['left-' + n.slice(6)] : J[n])).concat([PELVIS]);

const SIDES = ['left', 'right'];
const STEP_TURN = 1.3; // max foot turn in one step (rad)
const SWITCHES_HAND = new Set(['move-crossover', 'move-spin', 'move-btl', 'move-btb']); // roles that end in the other hand
const LEG = Object.fromEntries(SIDES.map((s) => [s, { hip: J[`${s}-hip`], knee: J[`${s}-knee`], ankle: J[`${s}-ankle`], heel: J[`${s}-heel`], big: J[`${s}-big-toe-tip`], small: J[`${s}-small-toe-tip`] }]));
const FOOTPTS = Object.fromEntries(SIDES.map((s) => [s, [LEG[s].ankle, LEG[s].heel, LEG[s].big, LEG[s].small]]));
const PALM = Object.fromEntries(SIDES.map((s) => [s, [J[`${s}-wrist`], J[`${s}-middle-first-joint`]]]));

/** Parents before children, from a parent array (70 entries, PELVIS = 70). */
export function topoOrder(parent) {
  const order = [], seen = new Set([PELVIS]);
  let guard = 0;
  while (order.length < 70 && guard++ < 200) for (let k = 0; k < 70; k++) if (!seen.has(k) && seen.has(parent[k])) { order.push(k); seen.add(k); }
  return order;
}
/** Joints below a joint (inclusive) — e.g. everything that leans with the spine. */
function subtree(parent, root) {
  const out = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (let k = 0; k < 70; k++) if (!out.has(k) && out.has(parent[k])) { out.add(k); grew = true; } }
  return out;
}

// ── small math on flat pose buffers (x,y,z per point) ───────────────────────
const gx = (P, k) => P[k * 3], gy = (P, k) => P[k * 3 + 1], gz = (P, k) => P[k * 3 + 2];
const set3 = (P, k, x, y, z) => { P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z; };
const get3 = (P, k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
const v3 = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], sc: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len: (a) => Math.hypot(a[0], a[1], a[2]) };
v3.norm = (a) => { const l = v3.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
v3.lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
v3.dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
v3.scale = v3.sc;
export const rotY = (yaw, x, z) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [c * x + s * z, -s * x + c * z]; };
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
// critically damped spring toward a target (Holden) — returns [x, v]
const HL = (h) => (4 * 0.69314718) / (h + 1e-5);
function springTo(x, v, goal, halflife, dt) {
  const y = HL(halflife) / 2, j0 = x - goal, j1 = v + j0 * y, e = Math.exp(-y * dt);
  return [e * (j0 + j1 * dt) + goal, e * (v - j1 * y * dt)];
}
const dampAngle = (a, goal, halflife, dt) => a + wrapPi(goal - a) * (1 - Math.exp(-(0.69314718 * dt) / (halflife + 1e-5)));
/**
 * Closed form of springTo: where a spring-driven value will be, and how fast
 * it moves, `t` seconds ahead — used to aim steps at where the body WILL be
 * (a first step that already runs, a braking step at the stop point).
 * Returns [displacement over t, velocity at t].
 */
function springAhead(v, a, goal, halflife, t) {
  const y = HL(halflife) / 2, j0 = v - goal, j1 = a + j0 * y, e = Math.exp(-y * t);
  const disp = goal * t + (j0 * (1 - e)) / y + (j1 * (1 - e * (1 + y * t))) / (y * y);
  return [disp, e * (j0 + j1 * t) + goal];
}

// ── skinning segments (identical to lib/mocap/mesh-guide.js segmentDefs) ────
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
function segmentDefs() {
  const d = [];
  const pt = (n) => [[J[n], 1]];
  const mid = (a, b) => [[J[a], 0.5], [J[b], 0.5]];
  const vec = (a, b) => [J[a], J[b]];
  const hip = mid('left-hip', 'right-hip');
  const belly = [[J['left-hip'], 0.25], [J['right-hip'], 0.25], [J['left-shoulder'], 0.25], [J['right-shoulder'], 0.25]];
  d.push({ a: hip, b: belly, ref: vec('left-hip', 'right-hip') });
  d.push({ a: belly, b: pt('neck'), ref: vec('left-shoulder', 'right-shoulder') });
  d.push({ a: pt('neck'), b: mid('left-ear', 'right-ear'), ref: vec('left-ear', 'right-ear') });
  for (const side of SIDES) {
    const n = (x) => `${side}-${x}`;
    const palmAcross = vec(n('index-third-joint'), n('pinky-third-joint'));
    const footFwd = vec(n('heel'), n('big-toe-tip'));
    d.push({ a: pt(n('shoulder')), b: pt(n('elbow')), ref: vec(n('cubital-fossa'), n('olecranon')) });
    d.push({ a: pt(n('elbow')), b: pt(n('wrist')), ref: palmAcross });
    d.push({ a: pt(n('wrist')), b: pt(n('middle-third-joint')), ref: palmAcross });
    d.push({ a: pt(n('hip')), b: pt(n('knee')), ref: footFwd });
    d.push({ a: pt(n('knee')), b: pt(n('ankle')), ref: footFwd });
    d.push({ a: pt(n('ankle')), b: mid(n('big-toe-tip'), n('small-toe-tip')), ref: vec(n('big-toe-tip'), n('small-toe-tip')) });
    for (const f of ['thumb', ...FINGERS]) {
      const chain = (f === 'thumb' ? ['wrist'] : []).concat(['third-joint', 'second-joint', 'first-joint', 'tip'].map((j) => `${f}-${j}`));
      for (let c = 0; c < chain.length - 1; c++) d.push({ a: pt(n(chain[c])), b: pt(n(chain[c + 1])), ref: palmAcross });
    }
  }
  return d;
}
export const SEGS = segmentDefs();
export const NSEG = SEGS.length; // 47
const combo = (P, c) => { let x = 0, y = 0, z = 0; for (const [k, w] of c) { x += P[k * 3] * w; y += P[k * 3 + 1] * w; z += P[k * 3 + 2] * w; } return [x, y, z]; };

/** Segment frame matrices (column-major 4×4, three.js order) for a pose. */
export function segMatrices(P, out = new Float32Array(NSEG * 16)) {
  const fb = [gx(P, J['right-shoulder']) - gx(P, J['left-shoulder']), gy(P, J['right-shoulder']) - gy(P, J['left-shoulder']), gz(P, J['right-shoulder']) - gz(P, J['left-shoulder'])];
  for (let s = 0; s < NSEG; s++) {
    const g = SEGS[s];
    const a = combo(P, g.a), b = combo(P, g.b);
    const ab = v3.sub(b, a);
    let L = v3.len(ab), u;
    if (L < 1e-6) { L = 1e-6; u = [0, 1, 0]; } else u = v3.sc(ab, 1 / L); // zero-length bone: keep the matrix invertible
    let r = v3.sub(get3(P, g.ref[1]), get3(P, g.ref[0]));
    r = v3.sub(r, v3.sc(u, v3.dot(r, u)));
    if (v3.len(r) < 1e-5) r = v3.sub(fb, v3.sc(u, v3.dot(fb, u)));
    if (v3.len(r) < 1e-5) r = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const v = v3.norm(v3.sub(r, v3.sc(u, v3.dot(r, u))));
    const w = v3.cross(u, v);
    const o = s * 16;
    out[o] = u[0] * L; out[o + 1] = u[1] * L; out[o + 2] = u[2] * L; out[o + 3] = 0;
    out[o + 4] = v[0]; out[o + 5] = v[1]; out[o + 6] = v[2]; out[o + 7] = 0;
    out[o + 8] = w[0]; out[o + 9] = w[1]; out[o + 10] = w[2]; out[o + 11] = 0;
    out[o + 12] = a[0]; out[o + 13] = a[1]; out[o + 14] = a[2]; out[o + 15] = 1;
  }
  return out;
}
/** Inverse of each [u·L | v | w | a] (u, v, w orthonormal) — the rest "bind inverse". */
export function invertSegMatrices(M, out = new Float32Array(M.length)) {
  for (let o = 0; o < M.length; o += 16) {
    const L2 = M[o] * M[o] + M[o + 1] * M[o + 1] + M[o + 2] * M[o + 2] || 1e-12;
    // rows of the inverse linear part: u/L = col0/L², v = col1, w = col2
    const r0 = [M[o] / L2, M[o + 1] / L2, M[o + 2] / L2], r1 = [M[o + 4], M[o + 5], M[o + 6]], r2 = [M[o + 8], M[o + 9], M[o + 10]];
    const t = [M[o + 12], M[o + 13], M[o + 14]];
    // column-major: element (row i, col j) at o + j*4 + i
    out[o] = r0[0]; out[o + 4] = r0[1]; out[o + 8] = r0[2]; out[o + 12] = -v3.dot(r0, t);
    out[o + 1] = r1[0]; out[o + 5] = r1[1]; out[o + 9] = r1[2]; out[o + 13] = -v3.dot(r1, t);
    out[o + 2] = r2[0]; out[o + 6] = r2[1]; out[o + 10] = r2[2]; out[o + 14] = -v3.dot(r2, t);
    out[o + 3] = 0; out[o + 7] = 0; out[o + 11] = 0; out[o + 15] = 1;
  }
  return out;
}
/** Bone (skinning) matrices = M(pose) · M(rest)⁻¹, written into `out`. */
export function boneMatrices(P, restInv, out = new Float32Array(NSEG * 16), tmp = new Float32Array(NSEG * 16)) {
  segMatrices(P, tmp);
  for (let o = 0; o < tmp.length; o += 16) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += tmp[o + k * 4 + r] * restInv[o + c * 4 + k];
      out[o + c * 4 + r] = s;
    }
  }
  return out;
}

// ── base64 ──────────────────────────────────────────────────────────────────
export function b64(s, T) {
  let u8;
  if (typeof atob === 'function') { const bin = atob(s); u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); }
  else u8 = Uint8Array.from(Buffer.from(s, 'base64'));
  return new T(u8.buffer);
}

// ── rig ─────────────────────────────────────────────────────────────────────
/** Decode a character rig (lib/mocap/character-rig.js JSON). */
export function prepareRig(json) {
  const rest = new Float32Array(NJ * 3);
  json.restJoints.forEach((p, k) => set3(rest, k, p[0], p[1], p[2]));
  set3(rest, PELVIS, (gx(rest, J['left-hip']) + gx(rest, J['right-hip'])) / 2, (gy(rest, J['left-hip']) + gy(rest, J['right-hip'])) / 2, (gz(rest, J['left-hip']) + gz(rest, J['right-hip'])) / 2);
  const parent = json.parent;
  const boneLen = Float32Array.from(json.boneLen);
  const legLen = json.legLen || (boneLen[J['left-knee']] + boneLen[J['left-ankle']] + boneLen[J['right-knee']] + boneLen[J['right-ankle']]) / 2;
  return {
    id: json.id, name: json.name, heightM: json.heightM, json,
    parent, topo: topoOrder(parent), boneLen, legLen, ls: legLen / 0.86,
    rest, restInv: invertSegMatrices(segMatrices(rest)),
    soleOffset: json.soleOffset || 0,
    vertexCount: json.vertexCount,
    verts: json.verts ? b64(json.verts, Float32Array) : null,
    faces: json.faces ? b64(json.faces, json.faces32 ? Uint32Array : Uint16Array) : null,
    skin: json.skin ? b64(json.skin, Uint8Array) : null,
    weight: json.weight ? b64(json.weight, Uint8Array) : null,
    colors: json.colors ? b64(json.colors, Uint8Array) : null,
  };
}

/** Re-project a pose onto bone lengths (directions kept), pelvis first. In place. */
export function enforceLengths(P, rig) {
  const { parent, topo, boneLen } = rig;
  // pelvis stays where it is; every bone keeps its direction, takes the rig's length
  const tmp = enforceLengths.tmp || (enforceLengths.tmp = new Float32Array(NJ * 3));
  tmp.set(P.subarray(0, NJ * 3));
  for (const k of topo) {
    const p = parent[k];
    let dx = tmp[k * 3] - tmp[p * 3], dy = tmp[k * 3 + 1] - tmp[p * 3 + 1], dz = tmp[k * 3 + 2] - tmp[p * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1e-6, s = boneLen[k] / l;
    P[k * 3] = P[p * 3] + dx * s; P[k * 3 + 1] = P[p * 3 + 1] + dy * s; P[k * 3 + 2] = P[p * 3 + 2] + dz * s;
  }
  return P;
}

// ── clips ───────────────────────────────────────────────────────────────────
/**
 * Decode + retarget a game clip to a rig. mirror = the other hand (x → −x,
 * left ↔ right, turns and sideways travel flipped).
 */
export function prepareClip(json, rig, { mirror = false } = {}) {
  const F = json.frameCount;
  const raw = b64(json.joints, Float32Array);           // F × 70 × 3
  const rm = b64(json.rootMotion, Float32Array);        // F × 3
  const clipLeg = (json.boneLen[J['left-knee']] + json.boneLen[J['left-ankle']] + json.boneLen[J['right-knee']] + json.boneLen[J['right-ankle']]) / 2 || rig.legLen;
  const k = rig.legLen / clipLeg;                        // root motion + pelvis scale
  const sx = mirror ? -1 : 1;
  const frames = new Float32Array(F * NJ * 3);
  const P = new Float32Array(NJ * 3);
  for (let i = 0; i < F; i++) {
    for (let j = 0; j < 70; j++) {
      const src = mirror ? MIRROR[j] : j;
      const o = (i * 70 + src) * 3;
      set3(P, j, raw[o] * sx, raw[o + 1], raw[o + 2]);
    }
    const px = (gx(P, J['left-hip']) + gx(P, J['right-hip'])) / 2, py = (gy(P, J['left-hip']) + gy(P, J['right-hip'])) / 2, pz = (gz(P, J['left-hip']) + gz(P, J['right-hip'])) / 2;
    set3(P, PELVIS, px * k, py * k + rig.soleOffset, pz * k);
    // directions from the clip, lengths from the rig
    const Q = P.slice();
    set3(Q, PELVIS, px, py, pz);
    for (const kk of rig.topo) {
      const p = rig.parent[kk];
      let dx = gx(Q, kk) - gx(Q, p), dy = gy(Q, kk) - gy(Q, p), dz = gz(Q, kk) - gz(Q, p);
      const l = Math.hypot(dx, dy, dz) || 1e-6, s = rig.boneLen[kk] / l;
      set3(P, kk, gx(P, p) + dx * s, gy(P, p) + dy * s, gz(P, p) + dz * s);
    }
    frames.set(P, i * NJ * 3);
  }
  // cumulative root trajectory (x, z, yaw) at each frame start; traj[F] = one cycle
  const traj = new Float32Array((F + 1) * 3);
  let x = 0, z = 0, yaw = 0;
  for (let i = 0; i < F; i++) {
    traj[i * 3] = x; traj[i * 3 + 1] = z; traj[i * 3 + 2] = yaw;
    const dx = rm[i * 3] * sx * k, dz = rm[i * 3 + 1] * k, dyaw = rm[i * 3 + 2] * sx;
    const d = rotY(yaw, dx, dz);
    x += d[0]; z += d[1]; yaw += dyaw;
  }
  traj[F * 3] = x; traj[F * 3 + 1] = z; traj[F * 3 + 2] = yaw;
  const side = (s) => (mirror ? (s === 'left' ? 'right' : 'left') : s);
  const contacts = {};
  for (const s of SIDES) {
    const c = json.contacts[side(s)];
    contacts[s] = { on: Uint8Array.from(c.on), w: Float32Array.from(c.weight) };
  }
  const markers = { leftPlant: (json.markers?.[`${side('left')}Plant`] || []).slice(), rightPlant: (json.markers?.[`${side('right')}Plant`] || []).slice() };
  const ball = (json.ball || []).map((b) => b && {
    held: !!b.held, hand: side(b.hand),
    p: [b.p[0] * sx * k, b.p[1] * k + rig.soleOffset, b.p[2] * k],
    off: b.off ? [b.off[0] * sx, b.off[1], b.off[2]] : null,
  });
  const handCount = { left: 0, right: 0 };
  ball.slice(0, Math.max(1, Math.ceil(F * 0.3))).forEach((b) => { if (b?.held) handCount[b.hand]++; });
  const hand = handCount.left > handCount.right ? 'left' : 'right';
  const endCount = { left: 0, right: 0 };
  ball.slice(Math.floor(F * 0.7)).forEach((b) => { if (b?.held) endCount[b.hand]++; });
  // no ball seen at the end: a hand-switching move still ends in the other hand
  const switches = json.switchesHand ?? SWITCHES_HAND.has(json.role);
  const endHand = endCount.left + endCount.right === 0 ? (switches ? (hand === 'left' ? 'right' : 'left') : hand) : endCount.left > endCount.right ? 'left' : 'right';
  const shot = json.shot ? { ...json.shot, hand: side(json.shot.hand) } : null;
  const loop = json.type === 'loop';
  const clip = {
    json, name: json.name, role: json.role, type: json.type, loop, mirror, fps: json.fps, F, k,
    // the capture's own joint rotations (MHR, root space, Int16 quats) — the skin layer replays them
    rots: json.rots && json.rotsJoints ? b64(json.rots, Int16Array) : null, rotsJoints: json.rotsJoints || 0,
    frames, traj, contacts, markers, ball, hand, endHand, shot,
    entry: json.entry || { min: 0, max: 0 },
    speed: Math.hypot(x, z) / (F / json.fps),                    // character m/s over one cycle / the clip
    dir: Math.hypot(x, z) > 0.05 * k ? Math.atan2(x, z) : 0,     // travel direction in the clip's start frame
    turnRate: yaw / (F / json.fps),
    duration: F / json.fps,
  };
  clip.feet = restFeetOf(clip);
  clip.phaseMap = phaseMapOf(clip);
  // a free run's recorded positions are the video's ball (tracker, gravity-fitted) only if it
  // really travels (a dribble / cross reaches the floor); synthetic tracks fall back to the arc
  for (let i = 0; i < F; i++) {
    if (!ball[i] || ball[i].held) continue;
    let j = i; while (j + 1 < F && ball[j + 1] && !ball[j + 1].held) j++;
    let minY = Infinity; for (let q = i; q <= j; q++) minY = Math.min(minY, ball[q].p[1]);
    const caught = j + 1 < F ? !!ball[j + 1]?.held : clip.loop && !!ball[0]?.held;
    const ok = !caught || minY < (rig.soleOffset || 0) + 0.12 + 0.07;
    for (let q = i; q <= j; q++) ball[q].rec = ok;
    i = j;
  }
  clip.ballEvents = classifyBallEvents(clip);
  return clip;
}

/**
 * What the ball is doing, frame by frame, from the clip itself (no manual
 * tagging): RIGHT_HAND_DRIBBLE / LEFT_HAND_DRIBBLE (released and caught by
 * the same hand), CROSSOVER / BETWEEN_LEGS / BEHIND_BACK (caught by the other
 * hand — where the ball crosses the body's midline decides which: behind the
 * hips = behind the back; between the feet, below the knees = between the
 * legs; else in front), GATHER (both palms on the ball), HOLD (held > 0.4 s),
 * SHOT (from the release on), PASS (released, never caught, travelling fast),
 * BALL_FREE. Positions are the clip's root space.
 * @returns {{ frames: string[], segments: { from: number, to: number, label: string }[] }}
 */
export function classifyBallEvents(clip) {
  const F = clip.F, fps = clip.fps;
  let out = new Array(F).fill('BALL_FREE');
  if (!clip.ball?.length) return { frames: out, segments: [] };
  // a loop is read from its first held frame (so no run is split by the wrap)
  const h0 = clip.loop ? Math.max(0, clip.ball.findIndex((b) => b?.held)) : 0;
  const rot = (i) => (i + h0) % F;
  const ball = clip.ball.map((_, i) => clip.ball[rot(i)]);
  const P = new Float32Array(NJ * 3);
  const pose = (i) => samplePose(clip, rot(i), P).slice();
  const palm = (Q, hand) => { const [w, m] = PALM[hand]; return [(gx(Q, w) + gx(Q, m)) / 2, (gy(Q, w) + gy(Q, m)) / 2, (gz(Q, w) + gz(Q, m)) / 2]; };
  // held runs
  let i = 0;
  while (i < F) {
    const b = ball[i];
    if (b?.held) {
      let j = i; while (j + 1 < F && ball[j + 1]?.held) j++;
      const T = (j - i + 1) / fps;
      let both = 0;
      for (let k = i; k <= j; k++) {
        const Q = pose(k), bp = ball[k].p;
        if (v3.dist(palm(Q, 'left'), bp) < 0.2 && v3.dist(palm(Q, 'right'), bp) < 0.2) both++;
      }
      const label = both > (j - i + 1) * 0.5 ? 'GATHER' : T > 0.6 && !clip.loop ? 'HOLD' : b.hand === 'left' ? 'LEFT_HAND_DRIBBLE' : 'RIGHT_HAND_DRIBBLE';
      for (let k = i; k <= j; k++) out[k] = label;
      i = j + 1;
      continue;
    }
    // a free run: what happens between the release and the next catch
    let j = i; while (j + 1 < F && !ball[j + 1]?.held) j++;
    // a loop wraps around (its last free frames lead into frame 0)
    const before = i > 0 ? ball[i - 1] : clip.loop ? ball[F - 1] : null;
    const after = j + 1 < F ? ball[j + 1] : clip.loop ? ball[0] : null;
    let label = 'BALL_FREE';
    if (clip.shot && i >= clip.shot.releaseFrame - 1) label = 'SHOT';
    else if (before?.held && after?.held) {
      if (before.hand === after.hand) label = before.hand === 'left' ? 'LEFT_HAND_DRIBBLE' : 'RIGHT_HAND_DRIBBLE';
      else {
        label = 'CROSSOVER';
        // where the ball crosses the midline, in the body's frame at that moment
        for (let k = i; k <= j + 1 && k < F; k++) {
          const Q = pose(k), bp = (ball[k] || ball[k - 1]).p;
          const hl = get3(Q, J['left-hip']), hr = get3(Q, J['right-hip']), pel = v3.lerp(hl, hr, 0.5);
          const ax = v3.norm([hl[0] - hr[0], 0, hl[2] - hr[2]]), fw = [-ax[2], 0, ax[0]]; // forward = across × up
          const side = (p) => (p[0] - pel[0]) * ax[0] + (p[2] - pel[2]) * ax[2];
          const fwd = (p) => (p[0] - pel[0]) * fw[0] + (p[2] - pel[2]) * fw[2];
          const pb = k > i ? (ball[k - 1] || ball[k]).p : bp;
          if (Math.sign(side(pb)) !== Math.sign(side(bp)) || k === j + 1) {
            const f = fwd(bp);
            const fa = [fwd(get3(Q, J['left-ankle'])), fwd(get3(Q, J['right-ankle']))];
            const kneeY = (gy(Q, J['left-knee']) + gy(Q, J['right-knee'])) / 2;
            if (f < -0.12) label = 'BEHIND_BACK';
            else if (f > Math.min(...fa) - 0.08 && f < Math.max(...fa) + 0.08 && bp[1] < kneeY) label = 'BETWEEN_LEGS';
            break;
          }
        }
      }
    } else if (before?.held && !after) {
      const a = ball[Math.min(F - 1, i + 1)]?.p, b0 = ball[Math.min(F - 1, i + 3)]?.p;
      label = a && b0 && v3.dist(a, b0) * fps / 2 > 3 ? 'PASS' : 'BALL_FREE';
    }
    for (let k = i; k <= j; k++) out[k] = label;
    i = j + 1;
  }
  if (h0) out = out.map((_, i) => out[(i - h0 + F) % F]);
  const segments = [];
  for (let k = 0; k < F; k++) {
    if (!segments.length || segments[segments.length - 1].label !== out[k]) segments.push({ from: k, to: k, label: out[k] });
    else segments[segments.length - 1].to = k;
  }
  return { frames: out, segments };
}

/** Average root-space foot geometry of a clip (the stance the planner steps to). */
function restFeetOf(clip) {
  const out = {};
  for (const s of SIDES) {
    const pts = FOOTPTS[s].map(() => [0, 0, 0]);
    let n = 0;
    for (let i = 0; i < clip.F; i++) {
      if (clip.type === 'loop' && !clip.contacts[s].on[i] && n > 0) continue;
      const o = i * NJ * 3;
      FOOTPTS[s].forEach((k, q) => { pts[q][0] += clip.frames[o + k * 3]; pts[q][1] += clip.frames[o + k * 3 + 1]; pts[q][2] += clip.frames[o + k * 3 + 2]; });
      n++;
      if (clip.type !== 'loop') break; // actions: their first frame
    }
    pts.forEach((p) => { p[0] /= n; p[1] /= n; p[2] /= n; });
    const [ankle, heel, big, small] = pts;
    const toe = v3.lerp(big, small, 0.5);
    const yaw = Math.atan2(toe[0] - heel[0], toe[2] - heel[2]);
    // foot-local points (relative to the ankle, foot yaw removed)
    const local = pts.map((p) => { const d = rotY(-yaw, p[0] - ankle[0], p[2] - ankle[2]); return [d[0], p[1], d[1]]; });
    out[s] = { ankle, yaw, local };
  }
  return out;
}

/**
 * Loops: gait cycles from the sync markers — each cycle runs left plant (phase
 * 0) → right plant (0.5) → next left plant (1). A loop may hold several cycles.
 */
function phaseMapOf(clip) {
  if (!clip.loop) return null;
  const F = clip.F;
  const L = [...clip.markers.leftPlant].sort((a, b) => a - b), R = [...clip.markers.rightPlant].sort((a, b) => a - b);
  if (!L.length) return { F, cycles: [{ a: 0, h: F / 2, b: F }] };
  const cycles = L.map((a, i) => {
    const b = i + 1 < L.length ? L[i + 1] : L[0] + F;
    let h = R.find((r) => r > a && r < b);
    if (h == null) { const r2 = R.map((r) => r + F).find((r) => r > a && r < b); h = r2 != null ? r2 : (a + b) / 2; }
    return { a, h, b };
  });
  return { F, cycles };
}
/** Clip time for gait position u (cycles; fraction = phase, integer part = which cycle). */
function phaseToTime(pm, u) {
  const k = pm.cycles.length, ci = ((Math.floor(u) % k) + k) % k, f = u - Math.floor(u), c = pm.cycles[ci];
  const t = f < 0.5 ? c.a + (c.h - c.a) * (f / 0.5) : c.h + (c.b - c.h) * ((f - 0.5) / 0.5);
  return ((t % pm.F) + pm.F) % pm.F;
}

/** Catmull-Rom sample of a clip at time t (frames). Loops wrap; actions clamp. */
export function samplePose(clip, t, out = new Float32Array(NJ * 3)) {
  const F = clip.F, fr = clip.frames, S = NJ * 3;
  let i1 = Math.floor(t), u = t - i1;
  const idx = clip.loop ? (i) => ((i % F) + F) % F : (i) => clamp(i, 0, F - 1);
  if (!clip.loop && i1 >= F - 1) { i1 = F - 1; u = 0; }
  const a = idx(i1 - 1) * S, b = idx(i1) * S, c = idx(i1 + 1) * S, d = idx(i1 + 2) * S;
  const u2 = u * u, u3 = u2 * u;
  const w0 = -0.5 * u3 + u2 - 0.5 * u, w1 = 1.5 * u3 - 2.5 * u2 + 1, w2 = -1.5 * u3 + 2 * u2 + 0.5 * u, w3 = 0.5 * u3 - 0.5 * u2;
  for (let q = 0; q < S; q++) out[q] = fr[a + q] * w0 + fr[b + q] * w1 + fr[c + q] * w2 + fr[d + q] * w3;
  return out;
}
/** Root trajectory at t: [x, z, yaw]. Loops: detrended (returns to 0 each cycle). */
export function sampleTraj(clip, t) {
  const F = clip.F, T = clip.traj;
  if (clip.loop) {
    const tt = ((t % F) + F) % F, i = Math.floor(tt), u = tt - i, j = i + 1;
    const r = [0, 1, 2].map((c) => T[i * 3 + c] + (T[j * 3 + c] - T[i * 3 + c]) * u);
    const f = tt / F;
    return [r[0] - T[F * 3] * f, r[1] - T[F * 3 + 1] * f, r[2] - T[F * 3 + 2] * f];
  }
  const tt = clamp(t, 0, F), i = Math.min(F - 1, Math.floor(tt)), u = tt - i, j = i + 1;
  return [0, 1, 2].map((c) => T[i * 3 + c] + (T[j * 3 + c] - T[i * 3 + c]) * u);
}
function contactAt(clip, side, t) {
  const F = clip.F, w = clip.contacts[side].w;
  const idx = clip.loop ? (i) => ((i % F) + F) % F : (i) => clamp(i, 0, F - 1);
  const i = Math.floor(t), u = t - i;
  return w[idx(i)] * (1 - u) + w[idx(i + 1)] * u;
}

/** Transform a root-space pose by (x, z, yaw) into `out` (points 0..n-1). */
export function placePose(P, x, z, yaw, out, n = NP) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let k = 0; k < n; k++) {
    const px = P[k * 3], pz = P[k * 3 + 2];
    out[k * 3] = c * px + s * pz + x; out[k * 3 + 1] = P[k * 3 + 1]; out[k * 3 + 2] = -s * px + c * pz + z;
  }
  return out;
}

// ── inertialization ─────────────────────────────────────────────────────────
/**
 * Offset inertializer: at a switch the old output minus the new source (and
 * the velocity difference) is kept and decays with a critically damped
 * spring, so a transition carries the motion's momentum instead of freezing.
 */
export class Inertializer {
  constructor(n, halflife = 0.1) { this.n = n; this.x = new Float32Array(n); this.v = new Float32Array(n); this.halflife = halflife; this.active = false; }
  /** prev/prevVel: last output + its velocity; next/nextVel: the new source now. */
  transition(prev, prevVel, next, nextVel, halflife) {
    if (halflife) this.halflife = halflife;
    for (let i = 0; i < this.n; i++) { this.x[i] += prev[i] - (next[i] + this.x[i]); this.v[i] += prevVel[i] - (nextVel[i] + this.v[i]); }
    this.active = true;
  }
  /** Advance by dt and add the offset onto `pose` (in place). */
  apply(pose, dt) {
    if (!this.active) return pose;
    const y = HL(this.halflife) / 2, e = Math.exp(-y * dt);
    let big = 0;
    for (let i = 0; i < this.n; i++) {
      const j1 = this.v[i] + this.x[i] * y;
      this.x[i] = e * (this.x[i] + j1 * dt);
      this.v[i] = e * (this.v[i] - j1 * y * dt);
      pose[i] += this.x[i];
      big = Math.max(big, Math.abs(this.x[i]));
    }
    if (big < 1e-4) { this.x.fill(0); this.v.fill(0); this.active = false; }
    return pose;
  }
}

// ── two-bone leg IK ─────────────────────────────────────────────────────────
/**
 * Solve hip→knee→ankle for an ankle target with a knee hint (bend plane).
 * soft > 0: "soft IK" — near full extension the reach is eased in
 * exponentially, so the knee never snaps straight (feet in the air only; a
 * planted foot must be met exactly).
 */
export function solveLeg(hip, kneeHint, target, L1, L2, soft = 0, stretch = 0) {
  let d = v3.sub(target, hip), L = v3.len(d);
  const reach = L1 + L2 - 1e-4;
  let t = target, kneeL = null;
  if (soft > 0 && L > reach - soft) {
    const ds = reach - soft, Ls = ds + soft * (1 - Math.exp(-(L - ds) / soft));
    if (stretch > 0 && L - Ls <= stretch) kneeL = Ls; // planted: the foot stays exactly, the leg stretches ≤ `stretch`
    else { t = v3.add(hip, v3.sc(d, Ls / L)); d = v3.sub(t, hip); L = Ls; }
  } else if (L > reach) { t = v3.add(hip, v3.sc(d, reach / L)); d = v3.sub(t, hip); L = reach; }
  if (kneeL != null) {
    // knee from the softened distance, scaled so thigh/shin keep their ratio
    const u0 = v3.norm(d), a0 = (L1 * L1 - L2 * L2 + kneeL * kneeL) / (2 * kneeL), h0 = Math.sqrt(Math.max(0, L1 * L1 - a0 * a0));
    let pole0 = v3.sub(kneeHint, hip); pole0 = v3.sub(pole0, v3.sc(u0, v3.dot(pole0, u0)));
    if (v3.len(pole0) < 1e-6) pole0 = [0, 0, 1];
    const k = L / kneeL;
    return { knee: v3.add(hip, v3.add(v3.sc(u0, a0 * k), v3.sc(v3.norm(pole0), h0 * k))), ankle: t, short: false };
  }
  const u = v3.norm(d);
  const a = (L1 * L1 - L2 * L2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  let pole = v3.sub(kneeHint, hip);
  pole = v3.sub(pole, v3.sc(u, v3.dot(pole, u)));
  if (v3.len(pole) < 1e-6) pole = [0, 0, 1];
  return { knee: v3.add(v3.add(hip, v3.sc(u, a)), v3.sc(v3.norm(pole), h)), ankle: t, short: L >= reach };
}

// ── feet ────────────────────────────────────────────────────────────────────
/**
 * Rotate foot points [ankle, heel, big toe, small toe] about the toe line,
 * heel up: the smallest angle (≤ maxA) that brings the ankle within `reach`
 * of `hip`; when no angle does (a sideways lean — a toe pivot adds no
 * sideways reach) the angle that gets closest.
 */
function heelLift(pts, hip, reach, maxA = 1.13) {
  const dist = (P) => v3.len(v3.sub(P[0], hip));
  const ok = (P) => dist(P) <= reach;
  const T = v3.lerp(pts[2], pts[3], 0.5);
  let ax = v3.sub(pts[2], pts[3]); ax[1] = 0; ax = v3.norm(ax);
  const rot = (p, th) => {
    const d = v3.sub(p, T), c = Math.cos(th), sn = Math.sin(th);
    return v3.add(T, v3.add(v3.add(v3.sc(d, c), v3.sc(v3.cross(ax, d), sn)), v3.sc(ax, v3.dot(ax, d) * (1 - c))));
  };
  // the heel sits behind the toes: pick the sign that raises it
  const sg = rot(pts[1], 0.3)[1] > pts[1][1] ? 1 : -1;
  const at = (a) => pts.map((p, q) => (q >= 2 ? p.slice() : rot(p, sg * a)));
  if (!ok(at(maxA))) {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= 10; i++) { const a = (maxA * i) / 10, d = dist(at(a)); if (d < bd - 1e-4) { bd = d; best = a; } }
    return { pts: at(best), angle: best };
  }
  let lo = 0, hi = maxA;
  for (let it = 0; it < 16; it++) { const m = (lo + hi) / 2; if (ok(at(m))) hi = m; else lo = m; }
  return { pts: at(hi), angle: hi };
}

/** Four foot points (ankle, heel, big toe, small toe) for an ankle spot + yaw (+ pitch). */
function footPoints(geo, ax, az, yaw, lift = 0, pitch = 0) {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  return geo.local.map(([lx, ly, lz]) => {
    // pitch about the ankle's lateral axis (toes down = +pitch)
    const ry = geo.local[0][1];
    const dy = ly - ry, dz = lz;
    const ny = ry + dy * c - dz * s, nz = dy * s + dz * c;
    const d = rotY(yaw, lx, nz);
    return [ax + d[0], ny + lift, az + d[1]];
  });
}

/**
 * Procedural foot planner — stance feet are fixed in the world, swing feet
 * fly to a landing spot predicted from the player's velocity (re-aimed every
 * frame), alternating on a speed-dependent cadence. Standing still it only
 * steps to fix stance errors (after a turn, a move, a shot).
 */
class FootPlanner {
  constructor(player) { this.p = player; this.feet = {}; this.lastStep = -1; this.clock = 0; this.lastLand = 0; this.lastSide = 'right'; }
  geo(side) { return this.p.stance[side]; }
  /** Where a foot wants to stand if it landed now (world ankle x,z + yaw). */
  target(side, lead, landIn = lead) {
    const p = this.p, g = this.geo(side), ls = p.rig.ls;
    // where the body WILL be at landing (the velocity spring's closed form, so
    // accelerating and braking steps land right), plus the lead into the stance
    // (capped so a planted foot stays within the crouched leg's reach)
    const [dx, vxL] = p.ahead(0, landIn), [dz, vzL] = p.ahead(1, landIn);
    const [vx, vz] = [vxL, vzL];
    let lx = vx * (lead - landIn), lz = vz * (lead - landIn);
    const ll = Math.hypot(lx, lz), cap = 0.36 * ls;
    if (ll > cap) { lx *= cap / ll; lz *= cap / ll; }
    const ax = p.pos[0] + dx + lx, az = p.pos[1] + dz + lz;
    const yawL = p.yawAhead ? p.yawAhead(landIn) : p.yaw;
    // moving, the feet come in under the body: the idle stance (wide, staggered)
    // blends into a running stance (hip-width, no stagger) with speed
    const sp = Math.hypot(vx, vz);
    const km = clamp(sp / (1.2 * ls), 0, 1);
    const runX = (side === 'left' ? 1 : -1) * 0.12 * ls;
    let off = rotY(yawL, g.ankle[0] + (runX - g.ankle[0]) * km, g.ankle[2] * (1 - km));
    let yaw = yawL + g.yaw * (1 - km * 0.7);
    // running forward: feet point a little more along the travel direction
    if (sp > 1.2 * ls) {
      const travel = Math.atan2(vx, vz), rel = wrapPi(travel - yawL);
      if (Math.abs(rel) < 1.2) yaw += clamp(rel, -0.45, 0.45) * clamp((sp / ls - 1.2) / 2, 0, 0.6);
    }
    let x = ax + off[0], z = az + off[1];
    // within the leg's reach from where the hip will be (a slight crouch allowed)
    const hip = p.hipAt ? p.hipAt(side, landIn) : null;
    if (hip) {
      const L = (p.rig.boneLen[LEG[side].knee] + p.rig.boneLen[LEG[side].ankle]) * 0.97;
      const dy = hip[1] - g.ankle[1] - 0.05 * ls;
      const r = Math.sqrt(Math.max(0.01, L * L - dy * dy));
      const hx = x - hip[0], hz = z - hip[2], hd = Math.hypot(hx, hz);
      if (hd > r && sp > 0.05) { x = hip[0] + (hx * r) / hd; z = hip[2] + (hz * r) / hd; }
    }
    return { x, z, yaw };
  }
  place(side, x, z, yaw) { this.feet[side] = { mode: 'plant', x, z, yaw, since: this.clock }; }
  init(fromPose /* world points or null */) {
    for (const s of SIDES) {
      if (fromPose) {
        const a = get3(fromPose, LEG[s].ankle), h = get3(fromPose, LEG[s].heel), b = get3(fromPose, LEG[s].big), sm = get3(fromPose, LEG[s].small);
        const toe = v3.lerp(b, sm, 0.5);
        this.place(s, a[0], a[2], Math.atan2(toe[0] - h[0], toe[2] - h[2]) - 0 * 0);
        // keep the rest-geometry yaw offset consistent: store the heel→toe yaw minus the local geometry's own
        const g = this.geo(s);
        const lt = v3.lerp(g.local[2], g.local[3], 0.5), lh = g.local[1];
        this.feet[s].yaw -= Math.atan2(lt[0] - lh[0], lt[2] - lh[2]);
      } else {
        const t = this.target(s, 0);
        this.place(s, t.x, t.z, t.yaw);
      }
    }
  }
  swinging() { return SIDES.filter((s) => this.feet[s].mode === 'swing'); }
  update(dt) {
    const p = this.p, ls = p.rig.ls;
    this.clock += dt;
    const sp = Math.hypot(p.vel[0], p.vel[1]) / ls;         // leg-lengths-normalised speed (m/s at 0.86 m legs)
    // moving the moment the stick asks for it (instant response), not when the body has sped up
    const moving = sp > 0.18 || Math.hypot(p.want[0], p.want[1]) / ls > 0.3;
    // quick dribble steps; sideways shuffles quicker still
    const lvp = rotY(-p.yaw, p.vel[0], p.vel[1]), lat = sp > 0.05 ? Math.abs(lvp[0]) / (Math.hypot(lvp[0], lvp[1]) || 1) : 0;
    const cadence = clamp(2.0 + 0.5 * sp, 2.0, 3.9) * (1 + 0.3 * lat) * Math.sqrt(1 / ls); // steps/s
    const Tstep = 1 / cadence;
    const Tsw = moving ? clamp(0.82 * Tstep + 0.02 * sp, 0.2, 0.46) : 0.26;
    const Tstance = Math.max(0.05, 2 * Tstep - Tsw);
    // advance swings (re-aim the landing spot every frame)
    for (const s of SIDES) {
      const f = this.feet[s];
      if (f.mode !== 'swing') continue;
      f.t += dt;
      const remain = Math.max(0, f.T - f.t);
      const tg = this.target(s, remain + (moving ? Tstance / 2 : 0), remain);
      this.clampTarget(s, tg);
      // re-aim, but a swinging foot's goal moves at most ~5 m/s (stick flicks
      // must not teleport a foot in the air)
      const mx = 5 * ls * dt, dxT = tg.x - f.to.x, dzT = tg.z - f.to.z, dT = Math.hypot(dxT, dzT);
      const kk = dT > mx ? mx / dT : 1;
      const ny = f.to.yaw + clamp(wrapPi(tg.yaw - f.to.yaw), -8 * dt, 8 * dt);
      f.to = { x: f.to.x + dxT * kk, z: f.to.z + dzT * kk, yaw: f.from.yaw + clamp(wrapPi(ny - f.from.yaw), -STEP_TURN, STEP_TURN) };
      if (f.t >= f.T) {
        this.place(s, f.to.x, f.to.z, f.to.yaw); this.lastLand = this.clock; p.events.push({ type: 'plant', side: s });
        // hard stop from a run: this plant skids a few cm along the travel (the "slide-in")
        if (p.stopping && p.stopping.skid && !p.stopping.skidDone) {
          const k = p.o.skidFactor;
          this.feet[s].skid = { vx: p.vel[0] * k, vz: p.vel[1] * k, t: 0, T: p.o.skidTime };
          p.stopping.skidDone = true;
          p.events.push({ type: 'skid', side: s });
        }
      }
    }
    // a skidding plant slides with a decaying velocity, then holds
    for (const s of SIDES) {
      const f = this.feet[s];
      if (f.mode !== 'plant' || !f.skid) continue;
      const k = f.skid;
      const w = Math.max(0, 1 - k.t / k.T);
      f.x += k.vx * w * dt; f.z += k.vz * w * dt;
      if (f.pts) for (const q of f.pts) { q[0] += k.vx * w * dt; q[2] += k.vz * w * dt; }
      k.t += dt;
      if (k.t >= k.T) delete f.skid;
    }
    // start a step?
    const sw = this.swinging();
    const canOverlap = sp > 3.6; // sprint: flight phase allowed
    // a planted foot already past its reach may hop off even while the other swings
    const beyond = sw.length === 1 && SIDES.some((sd) => this.feet[sd].mode === 'plant' && this.reachFrac(sd) > 0.92);
    if (sw.length === 0 || beyond || (canOverlap && sw.length === 1 && this.feet[sw[0]].t > this.feet[sw[0]].T * 0.7)) {
      let side = null;
      const err = (s) => {
        const f = this.feet[s];
        if (f.mode !== 'plant') return { d: 0, a: 0 };
        const t = this.target(s, 0);
        return { d: Math.hypot(f.x - t.x, f.z - t.z) / ls, a: Math.abs(wrapPi(f.yaw - t.yaw)) };
      };
      // a planted foot about to fall out of the leg's reach must go now
      const urgent = SIDES.find((sd) => this.feet[sd].mode === 'plant' && this.reachFrac(sd) > 0.8);
      if (urgent) side = urgent;
      else if (moving) {
        if (this.clock - this.lastStep >= Tstep * 0.98 || this.lastStep < 0) {
          side = this.lastSide === 'left' ? 'right' : 'left';
          // the first step goes with the foot that is further from where it must be
          if (this.clock - this.lastStep > Tstep * 2.5) { const eL = err('left'), eR = err('right'); side = this.leadFoot(eL, eR); }
          if (this.feet[side].mode !== 'plant') side = null;
        }
      } else {
        const eL = err('left'), eR = err('right');
        const bad = (e) => e.d > 0.12 || e.a > 0.42;
        const crossed = this.crossed();
        if ((bad(eL) || bad(eR) || crossed) && this.clock - this.lastLand > 0.04) side = (eL.d + eL.a * 0.3 >= eR.d + eR.a * 0.3) ? 'left' : 'right';
      }
      if (side) {
        const f = this.feet[side];
        const T = moving ? Tsw : 0.26;
        const tg = this.target(side, T + (moving ? Tstance / 2 : 0), T);
        this.clampTarget(side, tg);
        const dist = Math.hypot(tg.x - f.x, tg.z - f.z);
        if (moving || dist > 0.02 * ls || Math.abs(wrapPi(tg.yaw - f.yaw)) > 0.05) {
          const shown = p.feetState?.[side]?.pts;
          // one step turns the foot at most ~75° (a U-turn takes steps, never a foot spun half round in the air)
          const to = { ...tg, yaw: f.yaw + clamp(wrapPi(tg.yaw - f.yaw), -STEP_TURN, STEP_TURN) };
          this.feet[side] = { mode: 'swing', from: { x: f.x, z: f.z, yaw: f.yaw, pts: shown ? shown.map((q) => q.slice()) : f.pts || null }, to, t: 0, T, h: clamp(0.055 + 0.03 * sp, 0.05, 0.17) * ls };
          this.lastStep = this.clock; this.lastSide = side;
          p.events.push({ type: 'lift', side });
        }
      }
    }
    this.Tstep = Tstep; this.sp = sp;
  }
  /** How far a planted foot is from its hip, as a fraction of the horizontal reach. */
  reachFrac(side) {
    const p = this.p, f = this.feet[side], hip = p.hipAt(side, 0);
    if (!hip || f.mode !== 'plant') return 0;
    const g = this.geo(side), ls = p.rig.ls;
    const L = (p.rig.boneLen[LEG[side].knee] + p.rig.boneLen[LEG[side].ankle]) * 0.99;
    const dy = hip[1] - g.ankle[1] - 0.1 * ls;
    const r = Math.sqrt(Math.max(0.01, L * L - dy * dy));
    return Math.hypot(f.x - hip[0], f.z - hip[2]) / r;
  }
  leadFoot(eL, eR) {
    // moving toward the left (+x local) → left foot first, and vice versa
    const p = this.p, lv = rotY(-p.yaw, p.vel[0], p.vel[1]);
    if (Math.abs(lv[0]) > Math.abs(lv[1]) * 0.7) return lv[0] > 0 ? 'left' : 'right';
    return eL.d >= eR.d ? 'left' : 'right';
  }
  crossed() {
    const p = this.p, L = this.feet.left, R = this.feet.right;
    const l = rotY(-p.yaw, L.x - p.pos[0], L.z - p.pos[1]), r = rotY(-p.yaw, R.x - p.pos[0], R.z - p.pos[1]);
    return l[0] - r[0] < 0.08 * p.rig.ls;
  }
  /** Keep the landing spot on its own side of the other foot, and within reach. */
  clampTarget(side, tg) {
    const p = this.p, other = this.feet[side === 'left' ? 'right' : 'left'], ls = p.rig.ls;
    const o = rotY(-p.yaw, other.mode === 'plant' ? other.x - p.pos[0] : other.to.x - p.pos[0], other.mode === 'plant' ? other.z - p.pos[1] : other.to.z - p.pos[1]);
    const t = rotY(-p.yaw, tg.x - p.pos[0], tg.z - p.pos[1]);
    const minSep = 0.14 * ls;
    if (side === 'left' && t[0] < o[0] + minSep) t[0] = o[0] + minSep;
    if (side === 'right' && t[0] > o[0] - minSep) t[0] = o[0] - minSep;
    const w = rotY(p.yaw, t[0], t[1]);
    tg.x = p.pos[0] + w[0]; tg.z = p.pos[1] + w[1];
  }
  /** Current world foot points for a side. */
  points(side) {
    const f = this.feet[side], g = this.geo(side);
    if (f.mode === 'plant') return f.pts ? f.pts.map((q) => q.slice()) : footPoints(g, f.x, f.z, f.yaw);
    const s = clamp(f.t / f.T, 0, 1), e = smooth01(s);
    const x = f.from.x + (f.to.x - f.from.x) * e, z = f.from.z + (f.to.z - f.from.z) * e;
    const yaw = f.from.yaw + wrapPi(f.to.yaw - f.from.yaw) * e;
    // C1 curves: zero vertical speed at lift-off and touch-down
    const lift = f.h * (1 - Math.cos(2 * Math.PI * s)) / 2 * (1 + 0.35 * Math.sin(Math.PI * s)) + (f.y0 || 0) * (1 - smooth01(s));
    const pitch = 0.38 * Math.sin(Math.PI * s) ** 2 * (1 - 1.6 * s); // toes down after push-off, heel first at the end
    const pts = footPoints(g, x, z, yaw, lift, pitch);
    // leave the floor from exactly how the foot was shown (heel up at push-off)
    if (f.from.pts) {
      const b = 1 - smooth01(s / 0.4);
      if (b > 0) {
        const d = [x - f.from.x, 0, z - f.from.z], lift0 = f.y0 || 0; // the drawn points already carry the start height
        return pts.map((q, i) => v3.lerp(q, v3.add(f.from.pts[i], [d[0], lift - lift0, d[2]]), b));
      }
    }
    return pts;
  }
}

// ── nearest-pose matcher ────────────────────────────────────────────────────
/**
 * A deliberately small motion matcher: every candidate clip frame is a
 * feature vector (root space, character scale) — both feet (position +
 * height), pelvis height, both wrists, the body's velocity, foot contacts and
 * which hand has the ball. The next move / loop entry is the candidate frame
 * nearest to the current pose (weighted squared distance). Cheap enough to
 * search every candidate frame on every trigger, no GPU, no training.
 */
const NF = 19;
const FW = Float32Array.from([1, 1, 1.5, 1, 1, 1.5, 1.2, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.35, 0.35, 0.2, 0.2, 0.6, 0.3]);
function featuresOf(P, vel, cL, cR, hand, out, o = 0) {
  const g = (k, c) => P[k * 3 + c];
  const A = LEG.left.ankle, B = LEG.right.ankle, WL = J['left-wrist'], WR = J['right-wrist'];
  const f = [g(A, 0), g(A, 2), g(A, 1), g(B, 0), g(B, 2), g(B, 1), g(PELVIS, 1), g(WL, 0), g(WL, 1), g(WL, 2), g(WR, 0), g(WR, 1), g(WR, 2), vel[0], vel[1], cL, cR, hand === 'left' ? -1 : hand === 'right' ? 1 : 0, 0];
  for (let i = 0; i < NF; i++) out[o + i] = f[i] * FW[i];
  return out;
}
/** Per-frame features of a clip (cached on the clip). */
export function clipFeatures(clip) {
  if (clip.feat) return clip.feat;
  const F = clip.F, out = new Float32Array(F * NF), T = clip.traj;
  for (let i = 0; i < F; i++) {
    const j = Math.min(F, i + 1), k = j === i ? 1 : j - i;
    const d = rotY(-T[i * 3 + 2], (T[j * 3] - T[i * 3]) * clip.fps / k, (T[j * 3 + 1] - T[i * 3 + 1]) * clip.fps / k);
    const b = clip.ball[i];
    featuresOf(clip.frames.subarray(i * NJ * 3, (i + 1) * NJ * 3), d, clip.contacts.left.on[i], clip.contacts.right.on[i], b?.held ? b.hand : null, out, i * NF);
  }
  clip.feat = out;
  return out;
}
/**
 * Best candidate frame. cands: [{ clip, from, to, bias? }]; query: features.
 * Later frames in an entry window win ties (a move answers the button sooner).
 */
export function matchPose(cands, query) {
  let best = null;
  for (const c of cands) {
    const feat = clipFeatures(c.clip);
    const to = Math.min(c.clip.F - 1, c.to ?? c.clip.F - 1);
    for (let i = Math.max(0, c.from || 0); i <= to; i++) {
      let d = c.bias || 0;
      for (let q = 0; q < NF; q++) { const e = feat[i * NF + q] - query[q]; d += e * e; }
      if (c.extra) d += c.extra(i);
      d -= 0.02 * (i - (c.from || 0)) / c.clip.fps;
      if (!best || d < best.cost) best = { clip: c.clip, frame: i, cost: d };
    }
  }
  return best;
}
/** Gait position (cycles) of a loop frame — the inverse of phaseToTime. */
function timeToPhase(pm, t) {
  for (let ci = 0; ci < pm.cycles.length; ci++) {
    const c = pm.cycles[ci];
    for (const tt of [t, t + pm.F]) {
      if (tt < c.a || tt >= c.b) continue;
      const f = tt < c.h ? 0.5 * (tt - c.a) / (c.h - c.a || 1) : 0.5 + 0.5 * (tt - c.h) / (c.b - c.h || 1);
      return ci + clamp(f, 0, 0.999);
    }
  }
  return 0;
}

// ── player ──────────────────────────────────────────────────────────────────
const DEFAULT_OPTS = {
  jogSpeed: 3.1,          // m/s at 0.86 m legs
  sprintSpeed: 5.0,
  // stick → velocity: asymmetric springs (standard "responsive but weighty"):
  accelHalflife: 0.05,    // pushing the stick: near-instant
  reverseHalflife: 0.08,  // changing direction (stick against the motion)
  stopHalflife: 0.09,     // letting go: a short slide-in, not a dead stop
  turnHalflife: 0.07,     // facing spring (hoop)
  runTurnHalflife: 0.12,  // facing spring while running (heavier)
  maxTurnRate: 11,        // rad/s
  runFacingSpeed: 1.6,    // m/s (× legs): sprinting above this faces where you run
  blendHalflife: 0.09,    // inertialization
  moveBlendHalflife: 0.06,
  unlockRadius: 0.3,      // × leg scale: a clip foot this far from its lock releases it
  skidStops: true,        // a hard stop from a run skids the braking foot a few cm
  skidSpeed: 3.3,         // m/s (× legs) needed for a skid
  skidFactor: 0.45,       // share of the body's speed the braking foot slides at
  skidTime: 0.16,         // s
  moveCancel: 0.72,       // moves can be cancelled by the stick after this share of the clip
};

/**
 * The ball handler. update(dt, input) → world pose + ball + events.
 *   input { move: [x, z] world direction × 0..1, sprint, face: [x, z] | null,
 *           trigger: role | null }
 */
export class Player {
  constructor(rig, library, opts = {}) {
    this.rig = rig; this.lib = library; this.o = { ...DEFAULT_OPTS, ...opts };
    this.pos = [opts.x || 0, opts.z || 0]; this.yaw = opts.yaw || 0; this.vel = [0, 0];
    this.want = [0, 0]; this.accel = [0, 0]; this.velHalflife = this.o.accelHalflife;
    this.yawVel = 0; this.twist = 0; this.twistV = 0; this.runFace = 0; this.runFaceV = 0;
    this.stopping = null; this.carryVel = [0, 0]; this.crouch = 0; this.crouchV = 0;
    this.idleClip = library.idle;
    if (!this.idleClip) throw new Error('an idle loop is required');
    this.hand = this.idleClip.hand;
    this.hasBall = true;
    this.mode = 'loco'; this.source = 'proc';
    this.dribbleT = 0; this.gaitPhase = 0;
    this.action = null;
    this.events = [];
    this.stance = this.idleClip.feet;
    this.planner = new FootPlanner(this);
    this.planner.init(null);
    this.base = new Float32Array(NP * 3);     // capsule-space base pose (+ ball)
    this.prevBase = new Float32Array(NP * 3); this.prevBaseVel = new Float32Array(NP * 3);
    this.out = new Float32Array(NP * 3);      // capsule-space output after inertialization
    this.world = new Float32Array(NP * 3);    // world pose (+ ball)
    this.prevWorld = null;
    this.inert = new Inertializer(NP * 3, this.o.blendHalflife);
    this.locks = { left: null, right: null }; // clip-mode world foot locks
    this.pelvisDrop = 0; this.pelvisDropV = 0;
    this.lean = [0, 0]; this.leanV = [0, 0];
    this.spine = subtree(rig.parent, J.neck);
    this.metrics = { slideMaxCm: 0, slide: { left: null, right: null }, popMax: 0 };
    this.upperIdx = [...this.spine];
    this.ballFree = false; // true while a released shot is in the page's physics
    this.firstFrame = true;
  }

  clipFor(role) {
    const c = this.lib[role];
    if (!c) return null;
    // moves follow the dribble hand (mirrored); shots keep the recorded shooting hand
    if (c.shot || !this.lib[role + ':mirror']) return c;
    return c.hand === this.hand ? c : this.lib[role + ':mirror'];
  }
  idle() { return this.clipFor('idle') || this.idleClip; }

  /** Predicted [displacement, velocity] of the body on axis c (0 = x, 1 = z) `t` s ahead. */
  ahead(c, t) {
    if (this.mode !== 'loco') return [this.vel[c] * t, this.vel[c]];
    return springAhead(this.vel[c], this.accel[c], this.want[c], this.velHalflife, t);
  }
  /** Facing `t` s ahead (turning at the current rate, easing out). */
  yawAhead(t) { return this.yaw + this.yawVel * Math.min(t, 0.15); }
  /** Facing `t` s ahead for the ball's intent: the facing spring integrated toward where it heads. */
  ballYawAhead(t) {
    const f = this.mode === 'loco' ? this.faceAhead : null;
    if (!f) return this.yawAhead(t);
    // the facing spring (rate-capped) toward where it is heading
    let y = this.yaw;
    for (let u = 0; u < t - 1e-9; u += 0.02) { const h = Math.min(0.02, t - u); const ny = dampAngle(y, f.goal, f.h, h); y += clamp(wrapPi(ny - y), -f.rate * h, f.rate * h); }
    return y;
  }

  /** World hip position predicted `ahead` seconds from now (planner reach checks). */
  hipAt(side, ahead) {
    const B = this.base, k = LEG[side].hip;
    if (!B || this.firstFrame) return null;
    const yaw = this.yawAhead(ahead);
    const d = rotY(yaw, gx(B, k), gz(B, k));
    return [this.pos[0] + this.ahead(0, ahead)[0] + d[0], gy(B, k) - this.pelvisDrop, this.pos[1] + this.ahead(1, ahead)[0] + d[1]];
  }

  /** Switch the dribble hand (mirrored loops); blended like any other switch. */
  setHand(hand) {
    if (hand === this.hand || (hand !== 'left' && hand !== 'right')) return false;
    if (!this.lib['idle:mirror'] && this.idleClip.hand !== hand) return false;
    this.hand = hand;
    this.stance = this.idle().feet;
    this.forceBlend = true;          // inertialize on the next update
    this.prevBaseSource = null;      // and don't read a velocity across the mirror
    return true;
  }

  /** Features of what is on screen now (capsule space) for the matcher. */
  currentFeatures() {
    const P = new Float32Array(NJ * 3), W = this.world, c = Math.cos(-this.yaw), sn = Math.sin(-this.yaw);
    for (let k = 0; k < NJ; k++) {
      const x = W[k * 3] - this.pos[0], z = W[k * 3 + 2] - this.pos[1];
      P[k * 3] = c * x + sn * z; P[k * 3 + 1] = W[k * 3 + 1]; P[k * 3 + 2] = -sn * x + c * z;
    }
    const v = this.mode === 'loco' ? this.vel : this.carryVel;
    const lv = rotY(-this.yaw, v[0], v[1]);
    const fs = this.feetState || {};
    return featuresOf(P, lv, fs.left?.planted ? 1 : 0, fs.right?.planted ? 1 : 0, this.hasBall ? this.hand : null, new Float32Array(NF));
  }

  /** Move the player (tests, resets): the feet re-plant around the new spot. */
  teleport(x, z, yaw = this.yaw) {
    this.pos = [x, z]; this.yaw = yaw; this.vel = [0, 0]; this.accel = [0, 0]; this.want = [0, 0]; this.stopping = null;
    if (this.mode === 'action') { this.mode = 'loco'; this.action = null; }
    this.locks = { left: null, right: null };
    this.planner.init(null);
    this.firstFrame = true;
    this.metrics.slide = { left: null, right: null };
  }

  /** The page gives the ball back (after a shot lands). */
  giveBall() { this.hasBall = true; this.ballFree = false; }
  /**
   * A ball arriving in the hand (a pass caught, a new possession): the standing /
   * procedural dribble continues from its catch frame, so the animation says
   * "in the hand" when the ball physically is.
   */
  syncDribbleToCatch() {
    const idle = this.idle(), B = idle?.ball;
    if (!B?.length || this.mode !== 'loco' || this.source === 'clip-loco') return false;
    const F = idle.F;
    for (let i = 0; i < F; i++) if (B[i]?.held && !B[(i - 1 + F) % F]?.held) { this.dribbleT = i + 0.5; return true; }
    return false;
  }

  // ── main update ──
  update(dt, inp = {}) {
    this.events = [];
    dt = clamp(dt, 0, 0.1);
    if (dt <= 0) return this.result();
    const trig = inp.trigger;
    // combos: a new move may start in the current move's cancel window
    if (trig && this.mode === 'action' && this.action && !this.action.clip.shot && this.action.t >= this.o.moveCancel * (this.action.clip.F - 1)) this.endAction();
    if (trig && this.mode === 'loco' && this.hasBall && !this.ballFree) this.startAction(trig);

    const prevSource = this.source;
    if (this.mode === 'loco') this.updateLoco(dt, inp); else this.updateAction(dt, inp);
    // ── inertialize on a source switch
    if (!this.firstFrame && (this.source !== prevSource || this.forceBlend) && !this.skipBlend) {
      const vel = this.baseVel || this.prevBaseVel;
      this.inert.transition(this.out, this.outVel || this.prevBaseVel, this.base, vel, this.action?.blendHalflife || this.o.blendHalflife);
    }
    this.skipBlend = false; this.forceBlend = false;
    const prevOut = this.out.slice();
    this.out.set(this.base);
    this.inert.apply(this.out, dt);
    enforceLengths(this.out, this.rig);
    this.outVel = new Float32Array(NP * 3);
    for (let i = 0; i < NP * 3; i++) this.outVel[i] = (this.out[i] - prevOut[i]) / dt;
    if (this.firstFrame) this.outVel.fill(0);
    // ── to the world, then feet
    placePose(this.out, this.pos[0], this.pos[1], this.yaw, this.world);
    this.solveFeet(dt);
    this.trackMetrics(dt);
    this.firstFrame = false;
    return this.result();
  }

  /** A capsule-space point in the world, the capsule advanced d seconds at its current velocity / turn rate. */
  toWorldPoint(q, d = 0) {
    // where the body WILL be (the locomotion spring: a start or a stop is still accelerating)
    const yaw = d ? this.ballYawAhead(d) : this.yaw, c = Math.cos(yaw), s = Math.sin(yaw);
    const x = this.pos[0] + (d ? this.ahead(0, d)[0] : 0), z = this.pos[1] + (d ? this.ahead(1, d)[0] : 0);
    return [c * q[0] + s * q[2] + x, q[1], -s * q[0] + c * q[2] + z];
  }

  /**
   * What the animation intends for the ball — the physics system's input (it
   * never places the ball). held / hand: who should control it now; releaseIn,
   * catchIn, catchHand: the next release and catch (s); target / targetVel /
   * targetAhead / catchTarget: where the video says the ball is, moves, will be
   * in `la` s and at the catch (world); event: the clip's ball event label.
   */
  ballIntent(la = 0.15) {
    const src = this.ballSrc;
    if (!this.hasBall || this.ballFree || !src || !src.clip.ball?.length) return { has: false };
    const { clip, t, xf } = src, F = clip.F, fps = clip.fps;
    const idx = clip.loop ? (i) => ((i % F) + F) % F : (i) => clamp(i, 0, F - 1);
    const bAt = (tt) => clip.ball[idx(Math.round(tt))];
    const cur = bAt(t);
    const held = !!cur?.held;
    let releaseIn = null, catchIn = null, catchHand = null, catchT = null;
    const maxK = clip.loop ? F : F - 1 - Math.round(t);
    for (let k = 1; k <= maxK; k++) {
      const b = bAt(t + k);
      if (held && !b?.held && releaseIn == null) { releaseIn = k / fps; continue; }
      if ((!held || releaseIn != null) && b?.held) { catchIn = k / fps; catchHand = b.hand; catchT = t + k; break; }
    }
    const tmp = this.base.slice();
    const xfAt = src.xfAt;
    const fut = new Float32Array(NP * 3);
    const tr0 = src.rootSpace ? sampleTraj(clip, t) : null;
    const pure = src.rootSpace
      // an action: the clip's own pose at tt (its hands) and its own root motion from t to tt
      ? (tt) => {
        samplePose(clip, tt, fut); this.ballFromClip(fut, clip, tt, null, true);
        const q = get3(fut, BALL), tr1 = sampleTraj(clip, tt);
        const cq = rotY(tr1[2], q[0], q[2]), l = rotY(-tr0[2], cq[0] + tr1[0] - tr0[0], cq[1] + tr1[1] - tr0[1]);
        return this.toWorldPoint([l[0], q[1], l[1]], 0);
      }
      : (tt, d) => { this.ballFromClip(tmp, clip, tt, xfAt ? xfAt(d) : xf); return this.toWorldPoint(get3(tmp, BALL), d); };
    const now = pure(t, 0), next = pure(t + fps / 120, 1 / 120);
    const ahead = pure(t + la * fps, la);
    const catchTarget = catchT != null ? pure(catchT, catchIn) : null;
    // the ball's velocity just after the coming release (the first stretch of the free path)
    let releaseVel = null;
    if (held && releaseIn != null) {
      const tr = t + releaseIn * fps, a = pure(tr, releaseIn), b = pure(tr + 0.5, releaseIn + 0.5 / fps);
      releaseVel = v3.scale(v3.sub(b, a), fps / 0.5);
    }
    this.ballSrc = src;
    // the posed (inertialized) ball is the target; the pure samples give its motion
    const target = get3(this.world, BALL);
    const off = v3.sub(target, now);
    return {
      has: true, held, hand: cur?.hand || this.hand, catchHand, catchIn, releaseIn, releaseVel,
      target, targetVel: v3.scale(v3.sub(next, now), 120), targetAhead: v3.add(ahead, off), catchTarget: catchTarget ? v3.add(catchTarget, off) : null,
      event: clip.ballEvents?.frames?.[idx(Math.round(t))] || null, clip: clip.name,
      // where the body will have moved in t s (the locomotion spring) — the physics tests flights against it
      bodyShift: (tt) => [this.ahead(0, tt)[0], 0, this.ahead(1, tt)[0]],
    };
  }

  result() {
    const b = this.hasBall && !this.ballFree ? get3(this.world, BALL) : null;
    return { pose: this.world, ball: b, events: this.events, mode: this.mode, source: this.source, action: this.action?.clip.role || null, rotSrc: this.rotSrc || null };
  }

  // ── locomotion ──
  updateLoco(dt, inp) {
    const o = this.o, ls = this.rig.ls;
    const mv = inp.move || [0, 0];
    // slides and backpedals are slower than running forward (and than a sprint)
    const lm = rotY(-this.yaw, mv[0], mv[1]), lmag = Math.hypot(lm[0], lm[1]) || 1;
    const dirK = 1 - 0.3 * Math.abs(lm[0] / lmag) - 0.3 * Math.max(0, -lm[1] / lmag);
    // running (sprint) faces where it goes, so slides/backpedals don't apply to it
    const running = inp.sprint && this.runFace > 0.5;
    const maxV = (inp.sprint ? o.sprintSpeed : o.jogSpeed) * ls * (running ? 1 : clamp(dirK, 0.62, 1));
    const want = [mv[0] * maxV, mv[1] * maxV];
    this.want = want;
    const spNow = Math.hypot(this.vel[0], this.vel[1]), wantSp = Math.hypot(want[0], want[1]);
    // asymmetric response: instant push, heavier reversal, a short glide into the stop
    const reversing = wantSp > 0.05 && spNow > 0.3 * ls && (want[0] * this.vel[0] + want[1] * this.vel[1]) < 0.2 * wantSp * spNow;
    this.velHalflife = wantSp < 0.05 * ls ? o.stopHalflife : reversing ? o.reverseHalflife : o.accelHalflife;
    // a stop: stick released while moving — remember it (braking step, skid, crouch)
    if (wantSp < 0.05 * ls && spNow > 1.2 * ls) { if (!this.stopping) { this.stopping = { from: spNow, skid: o.skidStops && spNow > o.skidSpeed * ls, skidDone: false }; this.events.push({ type: 'stop', speed: spNow }); } }
    else if (wantSp > 0.05 * ls || spNow < 0.15 * ls) this.stopping = null;
    for (let c = 0; c < 2; c++) [this.vel[c], this.accel[c]] = springTo(this.vel[c], this.accel[c], want[c], this.velHalflife, dt);
    this.pos[0] += this.vel[0] * dt; this.pos[1] += this.vel[1] * dt;
    const sp = Math.hypot(this.vel[0], this.vel[1]);
    // facing: the hoop, blending to the travel direction while sprinting; turns
    // are springs with a rate cap, the chest leads (see leanUpper's twist)
    [this.runFace, this.runFaceV] = springTo(this.runFace, this.runFaceV, inp.sprint && sp > o.runFacingSpeed * ls ? 1 : 0, 0.15, dt);
    this.runFace = clamp(this.runFace, 0, 1);
    if (inp.face || this.runFace > 0.01) {
      const hoop = inp.face ? Math.atan2(inp.face[0] - this.pos[0], inp.face[1] - this.pos[1]) : this.yaw;
      const travel = sp > 0.3 * ls ? Math.atan2(this.vel[0], this.vel[1]) : hoop;
      const goal = hoop + wrapPi(travel - hoop) * this.runFace;
      const h = o.turnHalflife + (o.runTurnHalflife - o.turnHalflife) * this.runFace;
      const y0 = this.yaw;
      let ny = dampAngle(this.yaw, goal, h, dt);
      const maxStep = o.maxTurnRate * dt;
      ny = this.yaw + clamp(wrapPi(ny - this.yaw), -maxStep, maxStep);
      this.yaw = ny;
      this.yawVel = wrapPi(this.yaw - y0) / dt;
      // where the facing is heading (runFace settled at its target): yawAhead() integrates toward it
      const rfT = inp.sprint && sp > o.runFacingSpeed * ls ? 1 : 0;
      this.faceAhead = { goal: hoop + wrapPi(travel - hoop) * rfT, h: o.turnHalflife + (o.runTurnHalflife - o.turnHalflife) * rfT, rate: o.maxTurnRate };
    } else { this.yawVel = 0; this.faceAhead = null; }
    // recorded locomotion loops, if the library covers this direction and speed
    // hysteresis: once on recorded loops, stay until clearly below their range
    const blend = this.locoBlend(sp, inp.sprint, this.source === 'clip-loco');
    if (blend) {
      if (this.source !== 'clip-loco') this.enterClipLoco(blend);
      this.source = 'clip-loco'; this.clipLoco(dt, blend, sp); return;
    }
    if (this.source === 'clip-loco') this.leaveClipLoco();
    this.source = 'proc';
    this.proceduralLoco(dt, sp);
  }

  /** Planner feet → world locks, and the loop frame nearest to the current pose. */
  enterClipLoco(blend) {
    const f = this.planner.feet;
    for (const s of SIDES) this.locks[s] = f[s].mode === 'plant' ? { pts: this.planner.points(s), out: 0, keep: false } : { pts: this.planner.points(s), out: 1e-6, keep: false };
    const main = blend?.items?.[0]?.c;
    if (main && main.phaseMap) {
      const m = matchPose([{ clip: main, extra: this.dribblePhaseCost(main) }], this.currentFeatures());
      const u = timeToPhase(main.phaseMap, m.frame);
      this.gaitCycle = Math.floor(u); this.gaitPhase = u - Math.floor(u);
      this.events.push({ type: 'loopEntry', clip: main.name, frame: m.frame });
      return;
    }
    // no loop: phase 0 = left plant, 0.5 = right plant (sync markers)
    if (f.right.mode === 'swing') this.gaitPhase = 0.1 + 0.35 * clamp(f.right.t / f.right.T, 0, 1);
    else if (f.left.mode === 'swing') this.gaitPhase = 0.6 + 0.35 * clamp(f.left.t / f.left.T, 0, 1);
    else this.gaitPhase = this.planner.lastSide === 'left' ? 0.02 : 0.52;
  }
  /**
   * Entering a dribbling loop mid-dribble: the entry frame must be at the same
   * point of the dribble (ball in the hand vs on its way, time to the next
   * catch / release), not only the same body pose — the ball is a physical body
   * already in flight, the new hand path has to meet it.
   */
  dribblePhaseCost(clip) {
    const I = this.hasBall && !this.ballFree ? this.ballIntent(0) : null;
    const B = clip.ball;
    if (!I?.has || !B?.length) return null;
    const F = clip.F, fps = clip.fps;
    const nextFlip = (i, held) => { for (let k = 1; k < F; k++) if (!!B[(i + k) % F]?.held !== held) return k / fps; return null; };
    const cache = new Map();
    return (i) => {
      if (cache.has(i)) return cache.get(i);
      const held = !!B[i]?.held;
      let d = 0;
      if (held !== I.held) d = 1.8;
      else {
        const want = I.held ? I.releaseIn : I.catchIn, have = nextFlip(i, held);
        if (want != null && have != null) d = 60 * (want - have) ** 2;
      }
      cache.set(i, d);
      return d;
    };
  }
  /** World locks → planner feet (planted stay exactly where they are). */
  leaveClipLoco() {
    this.planner.init(this.world);
    for (const s of SIDES) {
      const L = this.locks[s], fs = this.planner.feet[s];
      const shown = this.feetState?.[s]?.pts;
      if (L && L.out === 0) { fs.x = L.pts[0][0]; fs.z = L.pts[0][2]; fs.pts = (shown || L.pts).map((q) => q.slice()); }
      else {
        const a2 = get3(this.world, LEG[s].ankle);
        this.planner.feet[s] = { mode: 'swing', from: { x: a2[0], z: a2[2], yaw: fs.yaw, pts: shown ? shown.map((q) => q.slice()) : null }, to: ((tg) => ({ ...tg, yaw: fs.yaw + clamp(wrapPi(tg.yaw - fs.yaw), -STEP_TURN, STEP_TURN) }))(this.planner.target(s, 0.2)), t: 0, T: 0.2, h: 0.04 * this.rig.ls, y0: Math.max(0, a2[1] - this.stance[s].ankle[1]) };
      }
    }
    this.locks = { left: null, right: null };
  }

  /** Pick 1–2 recorded loops for the local travel direction (null → procedural). */
  locoBlend(sp, sprint, staying = false) {
    const ls = this.rig.ls;
    const cands = [];
    for (const role of ['loco-fwd', 'loco-left', 'loco-right', 'loco-back', 'loco-sprint']) {
      const c = this.clipFor(role);
      if (c && c.speed > 0.2) cands.push({ role, c });
    }
    if (!cands.length || sp < 0.25 * ls) return null;
    const lv = rotY(-this.yaw, this.vel[0], this.vel[1]);
    const th = Math.atan2(lv[0], lv[1]);
    // the run-dribble is the sprint loop; without a jog loop it also covers running forward
    const hasFwd = cands.some((q) => q.role === 'loco-fwd');
    const pool = cands.filter((q) => (sprint || !hasFwd ? true : q.role !== 'loco-sprint'));
    const scored = pool.map((q) => ({ ...q, d: Math.abs(wrapPi(q.c.dir - th)) + (sprint && q.role === 'loco-sprint' ? -0.3 : 0) + Math.abs(Math.log((q.c.speed || 1) / Math.max(0.1, sp))) * 0.25 }));
    scored.sort((a, b) => a.d - b.d);
    const A = scored[0];
    if (!A || Math.abs(wrapPi(A.c.dir - th)) > 0.9) return null;
    if (sp < A.c.speed * (staying ? 0.45 : 0.55)) return null;
    // a second clip on the other side of the travel angle
    const sA = Math.sign(wrapPi(th - A.c.dir));
    const B = scored.find((q) => q !== A && Math.sign(wrapPi(q.c.dir - A.c.dir)) === sA && Math.abs(wrapPi(q.c.dir - A.c.dir)) >= 0.3 && Math.abs(wrapPi(q.c.dir - A.c.dir)) <= Math.PI / 2 + 0.01);
    if (B) {
      const span = Math.abs(wrapPi(B.c.dir - A.c.dir)), t = clamp(Math.abs(wrapPi(th - A.c.dir)) / span, 0, 1);
      return { items: [{ c: A.c, w: 1 - t }, { c: B.c, w: t }], th };
    }
    return { items: [{ c: A.c, w: 1 }], th };
  }

  clipLoco(dt, blend, sp) {
    const items = blend.items;
    // one gait cycle of each clip (a loop can hold several)
    const cycle = items.reduce((s, q) => s + q.w * (q.c.duration / q.c.phaseMap.cycles.length), 0);
    const clipSp = items.reduce((s, q) => s + q.w * q.c.speed, 0);
    const rate = clamp(sp / clipSp, 0.6, 1.5);
    this.gaitPhase += (dt * rate) / cycle;
    if (this.gaitPhase >= 1) { this.gaitPhase -= 1; this.gaitCycle = (this.gaitCycle || 0) + 1; }
    const P = this.base;
    P.fill(0);
    const tmp = new Float32Array(NJ * 3);
    const cw = { left: 0, right: 0 };
    this.rotSrc = items.map((q) => ({ clip: q.c, t: phaseToTime(q.c.phaseMap, (this.gaitCycle || 0) + this.gaitPhase), w: q.w }));
    let dirS = 0, dirC = 0;
    const u = (this.gaitCycle || 0) + this.gaitPhase;
    for (const q of items) {
      const t = phaseToTime(q.c.phaseMap, u);
      samplePose(q.c, t, tmp);
      const tr = sampleTraj(q.c, t);
      // the loop's in-cycle root wobble, then back to the capsule
      const place = new Float32Array(NJ * 3);
      placePose(tmp, tr[0], tr[1], tr[2], place, NJ);
      for (let i = 0; i < NJ * 3; i++) P[i] += place[i] * q.w;
      for (const s of SIDES) cw[s] += contactAt(q.c, s, t) * q.w;
      dirS += Math.sin(q.c.dir) * q.w; dirC += Math.cos(q.c.dir) * q.w;
    }
    // orientation warp: turn the legs onto the true travel angle, chest stays square
    const blendDir = Math.atan2(dirS, dirC); // circular mean (back + side is −135°, not +45°)
    const warp = clamp(wrapPi(blend.th - blendDir), -0.8, 0.8);
    if (Math.abs(warp) > 1e-3) this.rotateLegs(P, warp);
    this.contactW = cw;
    const top = items.reduce((m, q) => (q.w > m.w ? q : m), items[0]); // the ball follows the clip that shows most
    this.ballFromClip(P, top.c, phaseToTime(top.c.phaseMap, u));
    this.baseVelFrom(P, dt);
  }

  proceduralLoco(dt, sp) {
    const idle = this.idle(), ls = this.rig.ls;
    // dribble tempo rises a little with speed
    const rate = 1 + 0.25 * clamp(sp / (3 * ls), 0, 1.4);
    this.dribbleT = (this.dribbleT + dt * idle.fps * rate) % idle.F;
    const P = this.base;
    const tmp = samplePose(idle, this.dribbleT, new Float32Array(NJ * 3));
    this.rotSrc = [{ clip: idle, t: this.dribbleT, w: 1 }];
    const tr = sampleTraj(idle, this.dribbleT);
    placePose(tmp, tr[0], tr[1], tr[2], P, NJ);
    this.planner.update(dt);
    // lean into the travel (and against braking), bob with the steps
    const lv = rotY(-this.yaw, this.vel[0], this.vel[1]);
    const la = rotY(-this.yaw, (this.accel || [0, 0])[0], (this.accel || [0, 0])[1]);
    // + banking into turns (centripetal: speed × turn rate), stronger when running
    const bank = clamp(-0.018 * sp * this.yawVel / ls, -0.25, 0.25);
    const goal = [clamp(0.075 * lv[0] / ls + 0.03 * la[0] / ls + bank, -0.3, 0.3), clamp(0.085 * lv[1] / ls + 0.028 * la[1] / ls, -0.18, 0.32)];
    for (let c = 0; c < 2; c++) [this.lean[c], this.leanV[c]] = springTo(this.lean[c], this.leanV[c], goal[c], 0.1, dt);
    // chest leads a turn; hips follow (twist of the spine subtree)
    [this.twist, this.twistV] = springTo(this.twist, this.twistV, clamp(this.yawVel * 0.07, -0.45, 0.45), 0.08, dt);
    // braking: the body dips into the stop
    const decel = this.stopping ? Math.max(0, -(la[1] * Math.sign(lv[1] || 1))) + Math.abs(la[0]) * 0.5 : 0;
    [this.crouch, this.crouchV] = springTo(this.crouch, this.crouchV, clamp(decel / (14 * ls), 0, 1) * 0.06 * ls, 0.06, dt);
    const since = this.planner.clock - this.planner.lastLand;
    const phase = clamp(since / (this.planner.Tstep || 0.4), 0, 1);
    // bob with the steps (lowest just after a plant)
    const bob = -0.028 * ls * clamp(sp / (1.5 * ls), 0, 1) * (1 - Math.cos(2 * Math.PI * phase)) / 2 - this.crouch;
    this.leanUpper(P, this.lean, bob);
    this.contactW = null; // the planner owns the feet
    this.ballFromClip(P, idle, this.dribbleT, (q) => this.leanPoint(q, this.lean, bob));
    // the lean `d` s ahead (same goal, from the predicted travel): the upper body — and the
    // dribbling hand — carries forward as the run builds, the ball intent must know where to
    this.ballSrc.xfAt = (d) => {
      const yw = this.ballYawAhead(d), v1 = [this.ahead(0, d)[1], this.ahead(1, d)[1]], v2 = [this.ahead(0, d + 0.02)[1], this.ahead(1, d + 0.02)[1]];
      const lvd = rotY(-yw, v1[0], v1[1]), lad = rotY(-yw, (v2[0] - v1[0]) / 0.02, (v2[1] - v1[1]) / 0.02);
      const gd = [clamp(0.075 * lvd[0] / ls + 0.03 * lad[0] / ls + bank, -0.3, 0.3), clamp(0.085 * lvd[1] / ls + 0.028 * lad[1] / ls, -0.18, 0.32)];
      const k = Math.pow(2, -d / 0.1), ld = [gd[0] + (this.lean[0] - gd[0]) * k, gd[1] + (this.lean[1] - gd[1]) * k];
      return (q) => this.leanPoint(q, ld, bob);
    };
    this.baseVelFrom(P, dt);
  }

  /** Rotate the spine subtree about the pelvis (lean x = sideways, z = forward). */
  leanUpper(P, lean, bob) {
    for (const k of this.spine) { const q = this.leanPoint(get3(P, k), lean, bob, P); set3(P, k, q[0], q[1], q[2]); }
    // hips + pelvis bob with the body
    for (const k of [J['left-hip'], J['right-hip'], PELVIS]) P[k * 3 + 1] += bob;
  }
  leanPoint(q, lean, bob, P = this.base) {
    const px = gx(P, PELVIS), py = gy(P, PELVIS) - (P === this.base ? 0 : 0), pz = gz(P, PELVIS);
    let x = q[0] - px, y = q[1] - py, z = q[2] - pz;
    // turn lead: twist about the vertical axis, then forward lean about +X
    // (y→z) and sideways about −Z (y→x)
    if (this.twist) { const d = rotY(this.twist, x, z); x = d[0]; z = d[1]; }
    const af = lean[1], as = lean[0];
    let c = Math.cos(af), s = Math.sin(af);
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(as); s = Math.sin(as);
    [x, y] = [x * c + y * s, -x * s + y * c];
    return [x + px, y + py + bob, z + pz];
  }
  /** Twist hips + legs about the pelvis vertical axis (orientation warping). */
  rotateLegs(P, a) {
    const px = gx(P, PELVIS), pz = gz(P, PELVIS);
    for (const s of SIDES) for (const k of [LEG[s].hip, LEG[s].knee, ...FOOTPTS[s]]) {
      const d = rotY(a, gx(P, k) - px, gz(P, k) - pz);
      P[k * 3] = px + d[0]; P[k * 3 + 2] = pz + d[1];
    }
  }

  baseVelFrom(P, dt) {
    // velocity of the CURRENT source only — across a switch it is unknown (0),
    // the inertializer then carries the old motion's momentum and decays it
    this.baseVel = this.baseVel || new Float32Array(NP * 3);
    const same = !this.firstFrame && this.source === this.prevBaseSource;
    for (let i = 0; i < NP * 3; i++) this.baseVel[i] = same ? (P[i] - this.prevBase[i]) / dt : 0;
    this.prevBase.set(P);
    this.prevBaseSource = this.source;
  }

  /** Ball in hand (palm + offset) or in a dribble's flight — capsule space, slot BALL. */
  ballFromClip(P, clip, t, xf = null, rootSpace = false) {
    this.ballSrc = { clip, t, xf, rootSpace };
    const F = clip.F;
    const idx = clip.loop ? (i) => ((i % F) + F) % F : (i) => clamp(i, 0, F - 1);
    const i0 = Math.floor(t), u = t - i0;
    const A = clip.ball[idx(i0)], B = clip.ball[idx(i0 + 1)];
    const palmOf = (Q, hand) => { const [w, m] = PALM[hand]; return [(gx(Q, w) + gx(Q, m)) / 2, (gy(Q, w) + gy(Q, m)) / 2, (gz(Q, w) + gz(Q, m)) / 2]; };
    const heldPos = (Q, b) => v3.add(palmOf(Q, b.hand), b.off || [0, 0, 0]);
    if (!A && !B) { set3(P, BALL, 0, -5, 0); return; }
    if (A?.held && (B?.held || (!clip.loop && i0 >= F - 1))) {
      const bb = B?.held ? B : A;
      const off = v3.lerp(A.off || [0, 0, 0], bb.off || [0, 0, 0], u);
      const hand = u < 0.5 ? A.hand : bb.hand;
      const q = v3.add(palmOf(P, hand), off);
      set3(P, BALL, q[0], q[1], q[2]);
      return;
    }
    // free: the recorded path (the tracker's gravity-fitted ball from the video, repaired
    // against the body — BP.repairClipBall). Its ends meet the hands: a held neighbour
    // frame contributes its palm position.
    if (A?.p && B?.p && (!A.held || !B.held) && (A.held || A.rec) && (B.held || B.rec)) {
      let qa = A.held ? heldPos(P, A) : A.p, qb = B.held ? heldPos(P, B) : B.p;
      if (xf) { if (!A.held) qa = xf(qa); if (!B.held) qb = xf(qb); }
      const q = v3.lerp(qa, qb, u);
      set3(P, BALL, q[0], Math.max(this.ballR || 0.12, q[1]), q[2]);
      return;
    }
    // (no recorded free positions) release (last held) → floor bounce → catch (next held), gravity
    let r = i0; while (r > i0 - F && !clip.ball[idx(r)]?.held) r--;
    let c = i0 + 1; while (c < i0 + 1 + F && !clip.ball[idx(c)]?.held) c++;
    const R = clip.ball[idx(r)], C = clip.ball[idx(c)];
    if (!R?.held || !C?.held || (!clip.loop && (r < 0 || c > F - 1))) { const q = (A || B).p; set3(P, BALL, q[0], q[1], q[2]); return; }
    // hand positions at release / catch, from the clip frames (+ the same lean)
    const fr = new Float32Array(NJ * 3);
    // P is in clip space (trajectory included) — or, for an action (rootSpace), in the root
    // space at t: the hands at release / catch are carried there through the clip's root motion
    const trT = rootSpace ? sampleTraj(clip, t) : null;
    const at = (fi) => {
      samplePose(clip, fi, fr);
      const tr = sampleTraj(clip, fi);
      const w = new Float32Array(NJ * 3); placePose(fr, tr[0], tr[1], tr[2], w, NJ);
      return w;
    };
    const toT = (q) => { if (!trT) return q; const l = rotY(-trT[2], q[0] - trT[0], q[2] - trT[1]); return [l[0], q[1], l[1]]; };
    let pr = toT(heldPos(at(r), R)), pc = toT(heldPos(at(c), C));
    if (xf) { pr = xf(pr); pc = xf(pc); }
    const fps = clip.fps, T = (c - r) / fps, tt = (t - r) / fps, rr = this.ballR || 0.12;
    const yr = pr[1], yc = pc[1];
    const T1 = T * clamp((yr - rr) / ((yr - rr) + (yc - rr) || 1), 0.2, 0.8), T2 = T - T1;
    let y;
    if (tt <= T1) { const v0 = (rr - yr + 0.5 * 9.81 * T1 * T1) / T1; y = yr + v0 * tt - 0.5 * 9.81 * tt * tt; }
    else { const w = tt - T1, v1 = (yc - rr + 0.5 * 9.81 * T2 * T2) / T2; y = rr + v1 * w - 0.5 * 9.81 * w * w; }
    const k = clamp(tt / T, 0, 1);
    set3(P, BALL, pr[0] + (pc[0] - pr[0]) * k, Math.max(rr, y), pr[2] + (pc[2] - pr[2]) * k);
  }

  // ── actions ──
  /** All clips that can play a role now: variants (+ mirrors for moves), right hand first. */
  candidatesFor(role) {
    const vs = this.lib[role + ':variants'] || (this.lib[role] ? [this.lib[role]] : []);
    const out = [];
    for (const v of vs) {
      out.push(v);
      if (v.mirrorOf === undefined && v.mirrored) out.push(v.mirrored);
    }
    // a dribble move must start in the hand that has the ball (shots: any)
    // every move and shot starts in the hand that has the ball (the ball is physical: the other hand
    // cannot take it from across the body); the filmed side first, its mirror when that is the ball's hand
    const inHand = out.filter((c) => c.hand === this.hand);
    return inHand.length ? inHand : out;
  }

  startAction(role) {
    const cands = this.candidatesFor(role);
    if (!cands.length) { this.events.push({ type: 'missing', role }); return false; }
    // nearest pose over every candidate's entry window: which variant, which frame
    const q = this.currentFeatures();
    const m = matchPose(cands.map((c) => ({ clip: c, from: c.entry.min, to: c.entry.max })), q);
    const clip = m.clip, best = m.frame;
    const tr0 = sampleTraj(clip, best);
    this.action = {
      clip, role, t: best, t0: best, last: tr0, yaw0: this.yaw, clipYaw0: tr0[2],
      released: false, blendHalflife: clip.shot ? this.o.blendHalflife : this.o.moveBlendHalflife,
      face: null,
    };
    this.mode = 'action';
    this.forceBlend = true; this.prevBaseSource = null;
    // the feet as drawn become the clip's locks: planted stay planted (no slide
    // at the switch), a foot in mid-step blends from where it is into the clip
    for (const s of SIDES) {
      const fs = this.feetState?.[s];
      const pts = fs?.pts ? fs.pts.map((q) => q.slice()) : this.planner.points(s);
      this.locks[s] = fs?.planted ? { pts, out: 0, keep: true } : { pts, out: 1e-6, keep: false, swing: true };
    }
    // momentum: the body keeps moving into the move and it bleeds off; a
    // travelling move already carries its own speed, so only the difference
    const tr1 = sampleTraj(clip, Math.min(clip.F - 1, best + 1));
    const rv = rotY(this.yaw - tr0[2], (tr1[0] - tr0[0]) * clip.fps, (tr1[1] - tr0[1]) * clip.fps);
    this.carryVel = best + 1 <= clip.F - 1 ? [this.vel[0] - rv[0], this.vel[1] - rv[1]] : this.vel.slice();
    this.vel = [0, 0]; this.accel = [0, 0]; this.want = [0, 0]; this.stopping = null;
    this.events.push({ type: 'action', role, entry: best, clip: clip.name, mirror: clip.mirror, cost: +m.cost.toFixed(3), variants: cands.length });
    return true;
  }

  updateAction(dt, inp) {
    const a = this.action, clip = a.clip;
    this.source = 'action:' + clip.role;
    const tPrev = a.t;
    this.rotSrc = null; // set below once a.t has advanced
    a.t = Math.min(clip.F - 1, a.t + dt * clip.fps);
    // root motion (clip start frame → character), scaled already
    const tr = sampleTraj(clip, a.t);
    const d = [tr[0] - a.last[0], tr[1] - a.last[1]];
    // clip-frame → world: rotate by the character yaw relative to the clip's yaw
    const base = this.yaw - (a.last[2] - a.clipYaw0) - a.clipYaw0; // yaw of the clip's frame-0 axes in the world
    const w = rotY(a.yaw0 + (a.warp || 0) - a.clipYaw0, d[0], d[1]);
    void base;
    this.pos[0] += w[0]; this.pos[1] += w[1];
    const kv = Math.exp(-0.69314718 * dt / 0.1);
    this.carryVel[0] *= kv; this.carryVel[1] *= kv;
    this.pos[0] += this.carryVel[0] * dt; this.pos[1] += this.carryVel[1] * dt;
    a.rootVel = [w[0] / dt + this.carryVel[0], w[1] / dt + this.carryVel[1]];
    // orientation warp: shots end square to the target at release
    let warp = 0;
    if (clip.shot && inp.face) {
      const rel = clip.shot.releaseFrame;
      const trRel = sampleTraj(clip, rel);
      const need = wrapPi(Math.atan2(inp.face[0] - this.pos[0], inp.face[1] - this.pos[1]) - (a.yaw0 + (trRel[2] - a.clipYaw0)));
      const s = rel > a.t0 ? smooth01((a.t - a.t0) / (rel - a.t0)) : 1;
      warp = need * s;
      if (a.t >= rel) warp = a.warpHold ?? (a.warpHold = need);
    }
    a.warp = warp;
    this.yaw = a.yaw0 + (tr[2] - a.clipYaw0) + warp;
    a.last = tr;
    // pose (root space at t) — the capsule carries position + yaw
    samplePose(clip, a.t, this.base);
    this.rotSrc = [{ clip, t: a.t, w: 1 }];
    this.contactW = { left: contactAt(clip, 'left', a.t), right: contactAt(clip, 'right', a.t) };
    if (!a.released && this.hasBall) this.ballFromClip(this.base, clip, a.t, null, true);
    else set3(this.base, BALL, gx(this.out, BALL), gy(this.out, BALL), gz(this.out, BALL));
    this.baseVelFrom(this.base, dt);
    // shot release
    if (clip.shot && !a.released && a.t >= clip.shot.releaseFrame && tPrev < clip.shot.releaseFrame + 1e-6) {
      a.released = true;
      this.ballFree = true; this.hasBall = false;
      this.events.push({ type: 'release', role: clip.role });
    }
    // cancel window: a move's recovery gives way to the stick (responsive)
    const mv = inp.move || [0, 0];
    if (!clip.shot && a.t >= this.o.moveCancel * (clip.F - 1) && Math.hypot(mv[0], mv[1]) > 0.3) { this.endAction(); return; }
    // end: back to the idle/locomotion layer (follow-through holds while a shot is in the air)
    if (a.t >= clip.F - 1 && (!clip.shot || !this.ballFree || a.holdDone)) this.endAction();
    else if (a.t >= clip.F - 1 && clip.shot) { a.hold = (a.hold || 0) + dt; if (a.hold > 2.5) a.holdDone = true; }
  }

  endAction() {
    const a = this.action;
    if (!a.clip.shot && a.clip.endHand !== this.hand) { this.hand = a.clip.endHand; this.stance = this.idle().feet; this.forceBlend = true; this.prevBaseSource = null; }
    this.mode = 'loco';
    this.action = null;
    // leave with the move's own speed (no dead stop at the end of a move)
    if (a.rootVel) { this.vel = a.rootVel.slice(); this.accel = [0, 0]; }
    // the planner starts from where the feet are: planted feet stay, a foot
    // in the air lands (a short step from where it is)
    this.planner.init(this.world);
    for (const s of SIDES) {
      const L = this.locks[s], f = this.planner.feet[s];
      if (L && L.out === 0) { f.x = L.pts[0][0]; f.z = L.pts[0][2]; f.pts = (this.feetState?.[s]?.pts || L.pts).map((q) => q.slice()); continue; }
      const g = this.stance[s], a2 = get3(this.world, LEG[s].ankle);
      const tg = this.planner.target(s, 0);
      this.planner.feet[s] = { mode: 'swing', from: { x: a2[0], z: a2[2], yaw: f.yaw }, to: { ...tg, yaw: f.yaw + clamp(wrapPi(tg.yaw - f.yaw), -STEP_TURN, STEP_TURN) }, t: 0, T: 0.22, h: 0.03 * this.rig.ls, y0: Math.max(0, a2[1] - g.ankle[1]) };
    }
    this.locks = { left: null, right: null };
    this.dribbleT = 0;
    this.events.push({ type: 'actionEnd' });
  }

  // ── feet + legs (world space) ──
  solveFeet(dt) {
    const W = this.world, rig = this.rig, ls = rig.ls;
    const targets = {};
    // the planner owns the feet in procedural locomotion (and from the frame an action ends)
    if (this.mode === 'loco' && this.source !== 'clip-loco') {
      for (const s of SIDES) targets[s] = { pts: this.planner.points(s), w: 1, planted: this.planner.feet[s].mode === 'plant' };
    } else {
      // clip contacts → world locks
      for (const s of SIDES) {
        const cw = this.contactW ? this.contactW[s] : 0;
        const anim = FOOTPTS[s].map((k) => get3(W, k));
        let L = this.locks[s];
        const shown = this.feetState?.[s]?.pts;
        const cur = shown ? shown.map((q) => q.slice()) : L && L.out > 0 ? anim.map((p, q) => v3.lerp(p, L.pts[q], 1 - smooth01(L.out))) : anim;
        const low = Math.min(...cur.slice(1).map((p) => p[1]));
        // a foot caught mid-step when the action started blends down first: it
        // re-plants once it is near the floor (never snapped down in one frame)
        const settled = !L || !L.swing || low - rig.soleOffset < 0.03 * ls;
        if (cw >= 0.5 && (!L || L.out > 0) && settled) {
          // plant where the foot is DRAWN (last frame, after IK easing), lowest point on the floor
          L = this.locks[s] = { pts: cur.map((p) => [p[0], p[1] - low + rig.soleOffset, p[2]]), out: 0, keep: false };
        }
        if (L && L.out === 0) {
          const drift = Math.hypot(anim[0][0] - L.pts[0][0], anim[0][2] - L.pts[0][2]);
          // the body has left the foot: crouched as far as allowed, or out of reach sideways
          const hip = get3(W, LEG[s].hip), hz = Math.hypot(L.pts[0][0] - hip[0], L.pts[0][2] - hip[2]);
          const reach = rig.boneLen[LEG[s].knee] + rig.boneLen[LEG[s].ankle];
          const lost = (this.feetState?.[s]?.short && this.pelvisDrop >= 0.18 * ls - 1e-4) || hz > reach;
          if (cw < 0.5 || lost || (!L.keep && drift > this.o.unlockRadius * ls)) L.out = 1e-6; // start releasing
        }
        if (L && L.out > 0) {
          L.out += dt / 0.14;
          if (L.out >= 1) { this.locks[s] = L = null; }
        }
        if (L) {
          const w = L.out > 0 ? 1 - smooth01(L.out) : 1;
          targets[s] = { pts: anim.map((p, q) => v3.lerp(p, L.pts[q], w)), w, planted: L.out === 0 };
        } else targets[s] = { pts: anim, w: 0, planted: false };
      }
    }
    // body height: the drop carried from the last frame first, so the heel
    // lift below sees where the hips really are
    const notLeg = (k) => !(FOOTPTS.left.includes(k) || FOOTPTS.right.includes(k) || k === LEG.left.knee || k === LEG.right.knee);
    const lower = (d) => { if (d > 1e-5) for (let k = 0; k < NP; k++) if (notLeg(k)) W[k * 3 + 1] -= d; };
    lower(this.pelvisDrop);
    // push-off: a planted foot the hip is leaving pivots on its toes (heel up)
    // before the body has to come down — the toes never move
    const reachOf = (s) => rig.boneLen[LEG[s].knee] + rig.boneLen[LEG[s].ankle] - 0.012 * ls;
    for (const s of SIDES) {
      const t = targets[s];
      if (!t || !t.planted) continue;
      const hip = get3(W, LEG[s].hip), reach = reachOf(s);
      if (v3.len(v3.sub(t.pts[0], hip)) <= reach) { t.heel = 0; continue; }
      // rate-limited (≤ 9 rad/s) so the heel never snaps
      this.heelPrev = this.heelPrev || { left: 0, right: 0 };
      const want = heelLift(t.pts, hip, reach).angle;
      const a = clamp(want, this.heelPrev[s] - 9 * dt, this.heelPrev[s] + 9 * dt);
      const r = heelLift(t.pts, hip, reach, Math.max(0, a));
      t.pts = r.pts; t.heel = r.angle;
    }
    for (const s of SIDES) { this.heelPrev = this.heelPrev || { left: 0, right: 0 }; this.heelPrev[s] = targets[s]?.planted ? targets[s].heel || 0 : 0; }
    // still out of reach: the body comes down now (never drag a planted foot);
    // otherwise it rises back on a spring and the heel lift takes over
    let need = 0;
    for (const s of SIDES) {
      const t = targets[s];
      if (!t || !t.planted) continue;
      const hip = get3(W, LEG[s].hip), a = t.pts[0], L = reachOf(s);
      const hz = Math.hypot(a[0] - hip[0], a[2] - hip[2]);
      if (hz < L) need = Math.max(need, (hip[1] - a[1]) - Math.sqrt(L * L - hz * hz));
    }
    const cap = 0.18 * ls;
    if (need > 1e-4 && this.pelvisDrop < cap) {
      const extra = Math.min(need, cap - this.pelvisDrop);
      lower(extra); this.pelvisDrop += extra; this.pelvisDropV = 0;
    } else {
      [this.pelvisDrop, this.pelvisDropV] = springTo(this.pelvisDrop, this.pelvisDropV, 0, 0.12, dt);
      if (this.pelvisDrop < 0) { this.pelvisDrop = 0; this.pelvisDropV = 0; }
    }
    // legs
    for (const s of SIDES) {
      const t = targets[s];
      if (!t) continue;
      const hip = get3(W, LEG[s].hip);
      const L1 = rig.boneLen[LEG[s].knee], L2 = rig.boneLen[LEG[s].ankle];
      // knee bends over the toes
      const toe = v3.lerp(t.pts[2], t.pts[3], 0.5), heel = t.pts[1];
      const fwd = v3.norm([toe[0] - heel[0], 0, toe[2] - heel[2]]);
      // bend plane: the animated knee's own bend direction (off its hip→ankle
      // line, capsule space → world), leaning toward the toes. Taking the
      // knee point itself as the hint flips when it is near the leg line.
      const O = this.out, hC = get3(O, LEG[s].hip), kC = get3(O, LEG[s].knee), aC = get3(O, LEG[s].ankle);
      const u = v3.norm(v3.sub(aC, hC)), kd = v3.sub(kC, hC);
      const pc = v3.sub(kd, v3.sc(u, v3.dot(kd, u)));
      const planner = this.mode === 'loco' && this.source !== 'clip-loco';
      let dir = fwd;
      const bendW = smooth01(v3.len(pc) / (0.08 * ls)); // a straight leg has no bend direction: fade to the toes
      if (bendW > 0) {
        const pw = rotY(this.yaw, pc[0], pc[2]);
        const pd = v3.norm([pw[0], pc[1], pw[1]]);
        // the knee goes over the toes; the animated bend only steers it when they agree
        const agree = smooth01((v3.dot([pd[0], 0, pd[2]], fwd) + 0.2) / 0.6);
        const wA = (planner ? 0.5 : 0.75) * agree;
        const kd2 = v3.norm(v3.add(v3.sc(pd, wA), v3.sc(fwd, 1 - wA)));
        dir = v3.norm(v3.add(v3.sc(fwd, 1 - bendW), v3.sc(kd2, bendW)));
      }
      // rate-limit the bend direction (a knee never swaps sides in one frame)
      this.kneeDir = this.kneeDir || {};
      const kp = this.kneeDir[s];
      if (kp) {
        const ang = Math.acos(clamp(v3.dot(kp, dir), -1, 1)), mx = 10 * dt;
        if (ang > mx) { const k = mx / ang; dir = v3.norm(v3.add(v3.sc(kp, 1 - k), v3.sc(dir, k))); if (v3.len(dir) < 1e-6) dir = kp; }
      }
      this.kneeDir[s] = dir;
      const hint = v3.add(v3.lerp(hip, t.pts[0], 0.5), v3.sc(dir, 0.3));
      const r = solveLeg(hip, hint, t.pts[0], L1, L2, t.planted ? 0.04 * ls : 0.06 * ls, t.planted ? 0.03 * ls : 0);
      set3(W, LEG[s].knee, ...r.knee);
      const shift = v3.sub(r.ankle, t.pts[0]);
      FOOTPTS[s].forEach((k, q) => set3(W, k, t.pts[q][0] + shift[0], t.pts[q][1] + shift[1], t.pts[q][2] + shift[2]));
      t.pts = t.pts.map((q) => v3.add(q, shift));
      t.short = r.short;
    }
    this.feetState = targets;
  }

  trackMetrics(dt) {
    // world slide of planted feet: max distance of the ankle from where it planted
    for (const s of SIDES) {
      const t = this.feetState?.[s];
      const m = this.metrics.slide;
      // a deliberate stop skid is not a slide: tracking restarts after it
      if (this.mode === 'loco' && this.planner.feet[s]?.skid) { m[s] = null; this.metrics.skids = (this.metrics.skids || 0) + dt; continue; }
      if (t?.planted) {
        const a = v3.lerp(get3(this.world, LEG[s].big), get3(this.world, LEG[s].small), 0.5);
        if (!m[s]) m[s] = { x: a[0], z: a[2], max: 0 };
        m[s].max = Math.max(m[s].max, Math.hypot(a[0] - m[s].x, a[2] - m[s].z));
        this.metrics.slideMaxCm = Math.max(this.metrics.slideMaxCm, m[s].max * 100);
      } else m[s] = null;
    }
    // pose pops: joint acceleration spikes (m/s²), ball excluded; uneven
    // frame times are handled (velocities over each frame's own dt)
    if (this.prevWorld && this.prevWorld2 && dt > 0 && this.prevDt > 0) {
      let big = 0;
      const h = (dt + this.prevDt) / 2;
      for (let i = 0; i < NJ * 3; i++) {
        const a = ((this.world[i] - this.prevWorld[i]) / dt - (this.prevWorld[i] - this.prevWorld2[i]) / this.prevDt) / h;
        if (Math.abs(a) > big) big = Math.abs(a);
      }
      this.metrics.accelMax = big;
      this.metrics.popMax = Math.max(this.metrics.popMax, big);
    }
    this.prevWorld2 = this.prevWorld ? this.prevWorld : null;
    this.prevWorld = this.world.slice();
    this.prevDt = dt;
  }
}

/**
 * Build a player library from clips: role → first clip (+ role:mirror), and
 * role:variants → every clip of that role (the matcher picks among them).
 * Pass an existing library to add to it.
 */
export function buildLibrary(clips, rig, lib = {}) {
  for (const json of clips) {
    const role = json.role;
    if (!role) continue;
    const c = prepareClip(json, rig);
    if (json.game?.mirror !== false) { c.mirrored = prepareClip(json, rig, { mirror: true }); c.mirrored.mirrorOf = c; }
    const vs = lib[role + ':variants'] || (lib[role + ':variants'] = []);
    if (vs.some((v) => v.json === json || (json.id && v.json.id === json.id))) continue;
    vs.push(c);
    if (!lib[role]) { lib[role] = c; if (c.mirrored) lib[role + ':mirror'] = c.mirrored; }
  }
  return lib;
}
