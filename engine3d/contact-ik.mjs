/**
 * Contact IK — the final, bounded correction of the animated skeleton
 * against the PHYSICAL basketball (render layer, after the physics step).
 *
 * The SAM-driven pose stays the base; physics owns the ball. This only moves
 * the body a little toward the ball — never the ball into the hand:
 *   reachArm    two-bone reach (shoulder, elbow) so the palm meets the ball's surface (≤ ikMax)
 *   aimHand     turn the hand at the wrist so the palm faces the ball (≤ ikAimMax)
 *   conformFingers  every phalanx outside the ball; a controlling hand curls onto its surface
 *   resolveHandBall the hand's own SKIN against the ball (palm on it, fingers out of / onto it)
 *   yieldLeg    the knee moves by the physics system's leg yield (hip + ankle fixed)
 *
 * Works on MHR skinning matrices (M = [Q | p − Q·b], column-major 4×4 per joint)
 * as written by engine3d/mhr-skin.mjs; `rig` is prepareMhr()'s result.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Rotation matrix (rows) about unit axis u by angle a. */
function axisAngle(u, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = u;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}
const mv = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
/** Shortest rotation taking direction a onto b, optionally limited to maxAngle. */
function swing(a, b, maxAngle = Math.PI) {
  const u = norm(a), v = norm(b), c = clamp(dot(u, v), -1, 1);
  let ax = cross(u, v); const s = len(ax);
  if (s < 1e-9) return null;
  ax = sc(ax, 1 / s);
  return axisAngle(ax, Math.min(Math.acos(c), maxAngle));
}

/** Subtree joint lists (joint + descendants), cached on the rig. */
function subtree(rig, j) {
  rig._sub ||= new Map();
  if (rig._sub.has(j)) return rig._sub.get(j);
  const out = [], st = [j];
  while (st.length) { const k = st.pop(); out.push(k); for (const c of rig.children[k]) st.push(c); }
  rig._sub.set(j, out);
  return out;
}

/** World position of joint j (p = Q·b + t). */
export function jointPos(mats, rig, j) {
  const o = j * 16, b = rig.b[j];
  return [mats[o] * b[0] + mats[o + 4] * b[1] + mats[o + 8] * b[2] + mats[o + 12], mats[o + 1] * b[0] + mats[o + 5] * b[1] + mats[o + 9] * b[2] + mats[o + 13], mats[o + 2] * b[0] + mats[o + 6] * b[1] + mats[o + 10] * b[2] + mats[o + 14]];
}
/** Accessor name → world position (for bodySampleFromJoints). */
export function jointAccessor(mats, rig) {
  const cache = new Map();
  return (name) => {
    let p = cache.get(name);
    if (!p) { const j = rig.JI[name]; p = j == null ? [0, 0, 0] : jointPos(mats, rig, j); cache.set(name, p); }
    return p;
  };
}

/** Rotate joint j's subtree by R (rows) about the world point `pivot`. */
export function rotateSubtree(mats, rig, j, R, pivot) {
  for (const k of subtree(rig, j)) {
    const o = k * 16;
    // Q' = R·Q  (columns of Q are mats[o..o+2], [o+4..o+6], [o+8..o+10])
    for (const c of [0, 4, 8]) {
      const col = [mats[o + c], mats[o + c + 1], mats[o + c + 2]], r = mv(R, col);
      mats[o + c] = r[0]; mats[o + c + 1] = r[1]; mats[o + c + 2] = r[2];
    }
    // t' = R·(t − pivot) + pivot
    const t = [mats[o + 12] - pivot[0], mats[o + 13] - pivot[1], mats[o + 14] - pivot[2]], r = mv(R, t);
    mats[o + 12] = r[0] + pivot[0]; mats[o + 13] = r[1] + pivot[1]; mats[o + 14] = r[2] + pivot[2];
  }
}

const J = (rig, name) => rig.JI[name];

/** Palm frame of one hand from the matrices (same construction as the physics body). */
export function palmFrame(mats, rig, s) {
  const P = (n) => jointPos(mats, rig, J(rig, `${s}_${n}`));
  const wr = P('wrist'), m1 = P('middle1'), i1 = P('index1'), p1 = P('pinky1');
  const y = norm(sub(m1, wr));
  let x = sub(i1, p1); x = norm(sub(x, sc(y, dot(x, y))));
  const z = cross(x, y), n = s === 'r' ? z : sc(z, -1);
  return { wr, c: add(add(wr, sc(sub(m1, wr), 0.55)), sc(n, -0.004)), n, x, y };
}

/**
 * Reach: move the wrist by `delta` (world) with a two-bone solve — bend the
 * elbow for the new shoulder–wrist distance, then swing the arm onto it.
 */
export function reachArm(mats, rig, s, delta, lim = {}) {
  const iS = J(rig, `${s}_uparm`), iE = J(rig, `${s}_lowarm`), iW = J(rig, `${s}_wrist`);
  const S = jointPos(mats, rig, iS), E = jointPos(mats, rig, iE), W = jointPos(mats, rig, iW);
  let Wt = add(W, delta);
  const l1 = len(sub(E, S)), l2 = len(sub(W, E));
  // never stretch the arm straight: at most maxExtend of its length (0.97 → a soft elbow)
  const maxD = (lim.maxExtend ?? 1) * (l1 + l2) - 1e-3;
  const cur0 = len(sub(W, S));
  const d = clamp(len(sub(Wt, S)), Math.abs(l1 - l2) + 1e-3, Math.max(Math.min(cur0, l1 + l2 - 1e-3), maxD));
  if (len(sub(Wt, S)) > d) Wt = add(S, sc(norm(sub(Wt, S)), d));
  // elbow: current vs wanted interior angle (the change bounded: maxElbow)
  let axis = cross(sub(E, S), sub(W, E));
  if (len(axis) < 1e-6) axis = cross(sub(E, S), [0, 1, 0]);
  axis = norm(axis);
  const cur = Math.acos(clamp(dot(norm(sub(S, E)), norm(sub(W, E))), -1, 1));
  let want = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  if (lim.maxElbow != null) want = cur + clamp(want - cur, -lim.maxElbow, lim.maxElbow);
  if (Math.abs(want - cur) > 1e-5) rotateSubtree(mats, rig, iE, axisAngle(axis, cur - want), E);
  // swing the whole arm about the shoulder onto the target
  const W2 = jointPos(mats, rig, iW);
  const R = swing(sub(W2, S), sub(Wt, S));
  if (R) rotateSubtree(mats, rig, iS, R, S);
}

/** Aim: turn the hand at the wrist so the palm normal points toward `dir` (≤ maxAngle). */
export function aimHand(mats, rig, s, dir, maxAngle) {
  const f = palmFrame(mats, rig, s);
  const R = swing(f.n, dir, maxAngle);
  if (R) rotateSubtree(mats, rig, J(rig, `${s}_wrist`), R, f.wr);
}

const FINGER_CHAINS = { thumb: ['thumb1', 'thumb2', 'thumb3', 'thumb_null'], index: ['index1', 'index2', 'index3', 'index_null'], middle: ['middle1', 'middle2', 'middle3', 'middle_null'], ring: ['ring1', 'ring2', 'ring3', 'ring_null'], pinky: ['pinky1', 'pinky2', 'pinky3', 'pinky_null'] };

/**
 * Fingers on the outside of the sphere: each phalanx is turned about its base
 * joint so its far end sits at (ball radius + finger radius) from the centre —
 * out of the ball if it had entered it, or (grip) curled onto it when the hand
 * controls the ball and the finger is close. Bounded per joint.
 */
export function conformFingers(mats, rig, s, ball, R, { grip = true, rf = 0.0095, maxAngle = 0.7, maxOut = 1.2, reach = 0.035, passes = 2 } = {}) {
  let moved = 0;
  // (twice: a phalanx its bound left inside is turned out further; the curl onto the ball stays ≤ maxAngle)
  for (let pass = 0; pass < passes; pass++) for (const [f, ch] of Object.entries(FINGER_CHAINS)) {
    const r = f === 'thumb' ? rf * 1.15 : rf;
    for (let k = 0; k < 3; k++) {
      const ja = J(rig, `${s}_${ch[k]}`), jb = J(rig, `${s}_${ch[k + 1]}`);
      if (ja == null || jb == null) continue;
      const a = jointPos(mats, rig, ja), b = jointPos(mats, rig, jb);
      const want = R + r;
      const dist = (p) => len(sub(p, ball));
      const d0 = dist(b);
      const inside = d0 < want - 1e-4;
      const curl = grip && !inside && d0 < want + reach && dist(a) > want;
      if (!inside && !curl) continue;
      // axis that swings the tip toward the centre for +θ
      let ax = cross(sub(b, a), sub(ball, a));
      if (len(ax) < 1e-9) continue;
      ax = norm(ax);
      const tipAt = (th) => add(a, mv(axisAngle(ax, th), sub(b, a)));
      // search the angle that puts the tip on the surface: inside → negative (out, ≤ maxOut), curl → positive (onto it, ≤ maxAngle)
      let lo = inside ? -maxOut : 0, hi = inside ? 0 : maxAngle;
      const f0 = (th) => dist(tipAt(th)) - want;          // > 0 outside
      if (inside && f0(lo) < 0) lo = -maxOut;              // cannot fully clear: take the bound
      for (let it = 0; it < 18; it++) {
        const mid = (lo + hi) / 2;
        if (inside) { if (f0(mid) < 0) hi = mid; else lo = mid; }
        else { if (f0(mid) > 0) lo = mid; else hi = mid; }
      }
      const th = inside ? lo : lo;
      if (Math.abs(th) > 1e-4) { rotateSubtree(mats, rig, ja, axisAngle(ax, th), a); moved++; }
    }
  }
  return moved;
}

/**
 * The hands never inside the ball (render layer, after the ball is placed): the RIGID hand — palm
 * centre, the knuckles, the thumb's base, the wrist — cannot bend around a ball, so a hand whose
 * rigid part is in it is moved out by its arm (two-bone reach, ≤ maxOut a step), then its fingers
 * conform (the holding hand's curl onto the surface: a palm and a grip, never a finger through it).
 * (A swing about the shoulder also turns the hand: re-measured and repeated, up to `iterations`.)
 * @param {Float32Array} mats  bone matrices (modified in place)
 * @param {number[]} ballP     ball centre (world)
 * @param {object} [o]         { holding: 'left'|'right'|'both'|null, rf: finger radius, maxOut: m }
 * @returns {{ moved: number, fingers: number }}
 */
export function clearHandsOfBall(mats, rig, ballP, R, { holding = null, rf = 0.0095, maxOut = 0.08, iterations = 4 } = {}) {
  const out = { moved: 0, fingers: 0 };
  for (const s of ['l', 'r']) {
    for (let it = 0; it < iterations; it++) {
      const P = (n) => jointPos(mats, rig, J(rig, `${s}_${n}`));
      const fr = palmFrame(mats, rig, s);
      const pts = [[fr.c, 0.014], [P('index1'), rf], [P('middle1'), rf], [P('ring1'), rf], [P('pinky1'), rf], [P('thumb1'), rf * 1.15], [P('wrist'), 0.025]];
      let worst = null;
      for (const [q, r] of pts) {
        const v = sub(q, ballP), l = len(v), pe = R + r - l;
        if (pe > 0.002 && (!worst || pe > worst.pe)) worst = { pe, n: l > 1e-9 ? sc(v, 1 / l) : [0, 1, 0] };
      }
      if (!worst) break;
      const d = sc(worst.n, Math.min(maxOut, worst.pe + 0.002));
      reachArm(mats, rig, s, d, { maxExtend: 0.99 });
      out.moved = Math.max(out.moved, len(d));
    }
    out.fingers += conformFingers(mats, rig, s, ballP, R, { grip: holding === 'both' || (!!holding && holding[0] === s), rf });
  }
  return out;
}

// ── the hand's own skin against the ball ─────────────────────────────────────
//
// The joint-based passes above assume a 1 cm palm and 9.5 mm fingers. A real character's palm skin
// is 3–5 cm in front of the palm frame (AC: the heel 53 mm, the thenar up to 67 mm) and its
// fingers are 11–24 mm thick, so a ball placed by those numbers sits 3–4 cm INSIDE the palm and
// the fingers wrap a ball inside the hand. The functions below work on the hand's own LOD0 skin
// (true 4-weight LBS of the matrices): the palm rests ON the ball, every phalanx is turned about
// its anatomical hinge (within its limits) out of the ball or — the holding hand — onto its
// surface, and whatever is still inside moves out with the arm.

/** Tunables of the skin contact (m, rad, s). */
export const HAND = Object.freeze({
  margin: 0.0015,    // skin kept this far outside the ball
  tol: 0.0005,       // depth accepted before the finger / arm fallbacks run
  pushMax: 0.12,     // most the arm moves a hand out of the ball per pass (palm push; the residual has its own): a
                     // capture's two hands can be 15 cm apart around a 24 cm ball — the guide hand needs ~17 cm
  pullMax: 0.04,     // most a holding palm reaches back onto a ball moved off its target (× arm scale)
  pullTol: 0.003,    // a holding palm this far off the ball is resting on it
  outRate: 10,       // rad/s: a free hand's finger turns out of an arriving ball at most this fast (the arm takes the rest)
  armFirst: true,    // a free hand still inside after its fingers: the arm moves it out before the fingers swing sideways
  gripReach: 0.05,   // a holding hand's phalanx this close to the surface curls onto it (+ the palm clearance)
  gripNear: 0.012,   // no touch in the flexion range: the closest approach is taken when this close
  gripTol: 0.001,    // "touching" = within this of the surface
  relaxHalf: 0.04,   // s: a correction the ball no longer needs eases toward its new target with this half-life
  curlRate: 24,      // rad/s: a curl onto the ball grows at most this fast (a hand closes on a ball in ≈ 50 ms)
  gripRate: 30,      // 1/s: a hand's grip weight changes at most this fast (the curl rate and the eased let-go do the smoothing)
  shiftRate: 6,      // rad/s: a joint curls on at most this fast while the next joint of its finger is curled onto the ball
  spreadMax: 0.3,    // rad: a finger whose flexion misses the ball spreads (abducts at its knuckle) at most this far toward it
  spreadRate: 8,     // rad/s: … at most this fast
  preShape: 0,       // s before a catch the receiving hand shapes its grip around where the ball will sit on it (it opens a
                     // finger that is there ahead of the ball, curls the others onto that place — never into the ball's way
                     // in). OFF: tried at 0.12 s — the jog's catches 40 → 3 mm, but on the stock rig the fingertips over-curl
                     // and redistribute when the ball lands (joints 50–80 rad/s); docs/ball-contact-system.md
  preCurl: true,
  jointRate: 0,      // rad/s (0: off): a holding hand's finger correction changing at most this fast either way, the arm
                     // taking the rest — tried at 24: the stock rig's pinky then closes late on a catch (25 mm off)
  far: 0.3,          // m beyond R: a wrist this far from the ball's centre is not near it (skipped)
  maxPerSeg: 24,     // skin samples per phalanx (farthest-point subsample of the bind mesh)
  maxPalm: 72,       // skin samples of the palm
  thenarU: 0.35,     // thumb1 skin this far along thumb1 → thumb2 (bind) is the thenar: palm, not thumb
});
/** Flexion limits (rad) about the anatomical hinge, measured against the parent bone: MCP, PIP, DIP; the thumb's are correction ranges. */
export const FINGER_LIMITS = Object.freeze({ finger: [[-0.5, 1.65], [-0.1, 1.9], [-0.25, 1.5]], thumb: [[-0.8, 0.8], [-0.3, 1.1], [-0.4, 1.4]], thumb0: [-0.6, 0.6] });
const HAND_FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** The palm normal of a bind pose (same construction as palmFrame). */
function bindPalmNormal(rig, s) {
  const B = (n) => rig.b[rig.JI[`${s}_${n}`]];
  const wr = B('wrist'), m1 = B('middle1'), i1 = B('index1'), p1 = B('pinky1');
  const y = norm(sub(m1, wr));
  let x = sub(i1, p1); x = norm(sub(x, sc(y, dot(x, y))));
  const z = cross(x, y);
  return s === 'r' ? z : sc(z, -1);
}

/**
 * The hands' own skin, once per rig: every LOD0 vertex whose strongest bone is a hand bone,
 * sorted into the rigid palm (wrist, wrist twist, pinky0 / thumb0, the pads right under the
 * knuckles and the thenar — thumb1's skin near its base) and each phalanx (thumb0→1, thumb1–3,
 * X1–3 with the fingertip skin on X_null), with its hinge axis (bind space) and flexion limits.
 * @param {object} json   rig JSON: parts[0] (verts / skinIdx / skinW), else json.verts + json.mhr.skinIdx / skinW
 * @param {object} rig    prepareMhr() result
 * @param {(s: string, T: any) => any} b64  base64 decoder (anim3d.b64)
 * @param {object} [o]    { maxPerSeg, maxPalm }: farthest-point subsample (0 = every vertex); thenarU (HAND)
 * @returns {{ l, r } | null}  null: the rig has no mesh (the joint passes stay in charge)
 */
export function buildHandContact(json, rig, b64, { maxPerSeg = 0, maxPalm = 0, thenarU = HAND.thenarU } = {}) {
  try {
    const part = json?.parts?.[0];
    const vs = part ? part.verts : json?.verts, is = part ? part.skinIdx : json?.mhr?.skinIdx, ws = part ? part.skinW : json?.mhr?.skinW;
    if (!vs || !is || !ws) return null;
    const V = b64(vs, Float32Array), SI = b64(is, Uint8Array), SW = b64(ws, Float32Array);
    const nV = V.length / 3, JI = rig.JI;
    if (SI.length < nV * 4 || SW.length < nV * 4) return null;
    const out = {};
    for (const s of ['l', 'r']) {
      const need = ['wrist', 'thumb0', 'index1', 'middle1', 'pinky1', ...HAND_FINGERS.flatMap((f) => [`${f}1`, `${f}2`, `${f}3`, `${f}_null`])];
      if (need.some((n) => JI[`${s}_${n}`] == null)) return null;
      const n0 = bindPalmNormal(rig, s);
      const segs = [], segOf = new Map();
      for (const f of HAND_FINGERS) {
        const ch = [`${f}1`, `${f}2`, `${f}3`, `${f}_null`].map((n) => JI[`${s}_${n}`]);
        // the thumb's root: thumb0 turns thumb1 (the thenar is skinned to thumb1) and everything after it
        if (f === 'thumb') segs.push({ f, k: -1, j: JI[`${s}_thumb0`], jc: ch[0], jp: JI[`${s}_wrist`], hinge0: null, lim: FINGER_LIMITS.thumb0, verts: [] });
        for (let k = 0; k < 3; k++) {
          const j = ch[k], jc = ch[k + 1];
          const hinge0 = f === 'thumb' ? null : norm(cross(sub(rig.b[jc], rig.b[j]), n0));   // +θ flexes toward the palm (both hands)
          const seg = { f, k, j, jc, jp: k === 0 ? JI[`${s}_wrist`] : ch[k - 1], hinge0, lim: FINGER_LIMITS[f === 'thumb' ? 'thumb' : 'finger'][k], verts: [] };
          segs.push(seg); segOf.set(j, seg);
          if (k === 2) segOf.set(jc, seg);   // (the fingertip skin is weighted to *_null)
        }
      }
      const palmBones = new Set(['wrist', 'wrist_twist', 'pinky0', 'thumb0'].map((n) => JI[`${s}_${n}`]).filter((j) => j != null));
      const ids = [], palm = [];
      for (let i = 0; i < nV; i++) {
        let best = -1, bw = 0;
        for (let c = 0; c < 4; c++) if (SW[i * 4 + c] > bw) { bw = SW[i * 4 + c]; best = SI[i * 4 + c]; }
        if (best < 0) continue;
        const seg = segOf.get(best);
        if (!seg && !palmBones.has(best)) continue;
        const li = ids.length; ids.push(i);
        if (seg && seg.k === 0) {
          // the pads right under a knuckle barely move with the finger, and the thenar (the thumb's
          // metacarpal bulge, skinned to thumb1) is the rigid palm too: they are palm — a ball pressing
          // them moves the hand, never swings the thumb off the ball
          const a = rig.b[seg.j], ab = sub(rig.b[seg.jc], a), u = dot(sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], a), ab) / (dot(ab, ab) || 1e-12);
          if (u < (seg.f === 'thumb' ? thenarU : 0.2)) { palm.push(li); continue; }
        }
        (seg ? seg.verts : palm).push(li);
      }
      if (!palm.length) return null;
      const n = ids.length, v0 = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      ids.forEach((i, li) => { for (let d = 0; d < 3; d++) v0[li * 3 + d] = V[i * 3 + d]; for (let c = 0; c < 4; c++) { si[li * 4 + c] = SI[i * 4 + c]; sw[li * 4 + c] = SW[i * 4 + c]; } });
      // farthest-point subsample on the bind positions: a bounded cost whatever the mesh density
      const fps = (list, k) => {
        if (!k || list.length <= k) return list;
        const P = (li) => [v0[li * 3], v0[li * 3 + 1], v0[li * 3 + 2]];
        const pick = [list[0]], dmin = list.map((li) => len(sub(P(li), P(list[0]))));
        while (pick.length < k) {
          let bi = 0; for (let q = 1; q < list.length; q++) if (dmin[q] > dmin[bi]) bi = q;
          pick.push(list[bi]); const pb = P(list[bi]);
          for (let q = 0; q < list.length; q++) dmin[q] = Math.min(dmin[q], len(sub(P(list[q]), pb)));
        }
        return pick;
      };
      for (const sg of segs) sg.verts = Int32Array.from(fps(sg.verts, maxPerSeg));
      const t0 = segs.find((sg) => sg.k === -1), t1 = segs.find((sg) => sg.f === 'thumb' && sg.k === 0);
      t0.verts = t1.verts;
      // each seg's chain: its own skin + every distal seg of the same finger (they turn with it)
      const chain = segs.map((sg) => {
        const L = [];
        for (const q of segs) if (q.f === sg.f && q.k > sg.k && q.verts !== sg.verts) for (const v of q.verts) L.push(v);
        for (const v of sg.verts) L.push(v);
        return Int32Array.from(L);
      });
      out[s] = { n, v0, si, sw, pos: new Float32Array(n * 3), palm: Int32Array.from(fps(palm, maxPalm)), segs, chain, all: Int32Array.from({ length: n }, (_, i) => i), bindN: n0, prevTh: new Float32Array(segs.length) };
    }
    return out;
  } catch { return null; }
}

/** LBS of the listed hand vertices into H.pos (all of them when list is null). */
function skinHand(H, mats, list = null) {
  const { v0, si, sw, pos } = H, N = list ? list.length : H.n;
  for (let q = 0; q < N; q++) {
    const v = list ? list[q] : q, x = v0[v * 3], y = v0[v * 3 + 1], z = v0[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k]; if (!w) continue;
      const o = si[v * 4 + k] * 16;
      ox += w * (mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]);
      oy += w * (mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]);
      oz += w * (mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]);
    }
    pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
  }
}
const vpos = (H, v) => [H.pos[v * 3], H.pos[v * 3 + 1], H.pos[v * 3 + 2]];
/** A bind-space direction in joint j's current frame. */
const Qv = (mats, j, v) => { const o = j * 16; return [mats[o] * v[0] + mats[o + 4] * v[1] + mats[o + 8] * v[2], mats[o + 1] * v[0] + mats[o + 5] * v[1] + mats[o + 9] * v[2], mats[o + 2] * v[0] + mats[o + 6] * v[1] + mats[o + 10] * v[2]]; };
/** Deepest (> 0 inside) of the listed skin into a ball of radius RR at c (H.pos current). */
function skinDepth(H, list, c, RR) {
  let d = -Infinity, at = -1;
  for (const v of list) { const x = RR - Math.hypot(H.pos[v * 3] - c[0], H.pos[v * 3 + 1] - c[1], H.pos[v * 3 + 2] - c[2]); if (x > d) { d = x; at = v; } }
  return { d, at };
}

/**
 * How much further along the palm normal n a ball centred at p must sit so no PALM skin (heel,
 * thenar / hypothenar, the pads under the knuckles) is inside it (+ margin). 0 when clear.
 * @param {object} H  buildHandContact()[s]
 */
export function palmClearance(mats, H, p, n, R, margin = HAND.margin) {
  skinHand(H, mats, H.palm);
  const RR = R + margin;
  let e = 0;
  for (const v of H.palm) {
    const d = sub(vpos(H, v), p), h = dot(d, n), rho2 = dot(d, d) - h * h;
    if (rho2 < RR * RR) e = Math.max(e, h + Math.sqrt(RR * RR - rho2));
  }
  return e;
}

/**
 * The knuckle spread (rotation about sAx, the palm normal at the knuckle) that lets a finger's distal chain
 * (points `all` relative to its knuckle a, flexing about u up to hi) reach the grip sphere (cg, RRg): 0 when its
 * flexion reaches it already or no spread helps; else the smallest spread that touches, or the one that comes
 * closest (≤ max).
 */
function spreadFor(all, a, u, sAx, hi, cg, RRg, tol, max) {
  const reach = (phi) => {
    const Rs = axisAngle(sAx, phi), us = mv(Rs, u), L = phi ? all.map((q) => mv(Rs, q)) : all;
    let best = -Infinity;
    for (let k = 0; k <= 12; k++) {
      const Rm = axisAngle(us, (hi * k) / 12);
      let m = -Infinity; for (const q of L) { const x = RRg - len(sub(add(a, mv(Rm, q)), cg)); if (x > m) m = x; }
      if (m > best) best = m;
      if (m >= -tol) break;
    }
    return best;   // the closest the chain comes over its flexion (≥ −tol: it touches)
  };
  const r0 = reach(0);
  if (r0 >= -tol - 0.002) return 0;
  let bestPhi = 0, bestV = r0;
  for (let k = 1; k <= 6; k++) {
    for (const sgn of [1, -1]) {
      const phi = (sgn * max * k) / 6, v = reach(phi);
      if (v >= -tol) return phi;   // (the smallest spread that touches)
      if (v > bestV) { bestV = v; bestPhi = phi; }
    }
  }
  return bestV > r0 + 0.003 ? bestPhi : 0;
}

/**
 * One hand against the ball, after the animation and IK, before skinning (bone matrices modified
 * in place):
 *   1. the palm rests ON the ball — the arm moves the hand out along the palm normal (≤ pushMax);
 *      a holding palm (pull > 0) that is off the ball reaches back onto it (≤ pullMax)
 *   2. per finger, root → tip, each phalanx turned about its hinge (anatomical limits) by the least
 *      extension that takes its skin out of the ball; the holding hand (grip > 0) flexes each one
 *      until its distal chain — as it was drawn last tick — touches the surface: the fingers wrap the
 *      ball, never flare off it. Smoothed one-sidedly: a correction the ball needs (more extension)
 *      applies at once; anything else eases toward its new target (relaxHalf) — an extension back
 *      into a grip, a curl letting go; a finger closes from the knuckle out at ≤ curlRate (no
 *      reversal); a free hand's finger turns out at ≤ outRate and the arm takes the rest
 *   2b. a phalanx still inside with its joint at its limit (a straight fingertip lying in the ball):
 *      the joints nearer the palm straighten the finger by the least that clears it
 *   3. anything still inside (a joint at its limit, the thumb's root): the arm moves the hand out
 *      along the deepest skin's own outward direction (≤ 3 steps; a free hand first), the fingers
 *      swing straight toward / away from the ball (≤ 0.35 rad)
 * @param {object} H     buildHandContact()[s] (its pos / prevTh are this hand's scratch and smoothing state)
 * @param {'l'|'r'} s
 * @param {{ p: number[], R: number }} ball
 * @param {object} [opt] { grip: 0…1, pull: 0…1, clear: the palm clearance already in the target (m), dt (s; 0 = no smoothing), reachArm,
 *                       gripBall: { p, R } — the sphere the fingers wrap (default: the ball): a hand about to catch shapes its
 *                       grip around where the ball will sit on it (its palm target), so the fingers are on the ball the moment
 *                       it arrives — never into the real ball on the way, …HAND }
 * @returns {{ palmPush, palmPull, fingers, residual, depth: number|null }}  depth: the deepest skin into the real ball (m, > 0 inside), null when the hand is far from it
 */
export function resolveHandBall(mats, rig, H, s, ball, opt = {}) {
  const {
    grip: gripIn = 0, clear = 0, dt = 0, reachArm: reach = reachArm, margin = HAND.margin, tol = HAND.tol, pushMax = HAND.pushMax,
    gripReach = HAND.gripReach, gripNear = HAND.gripNear, gripTol = HAND.gripTol, relaxHalf = HAND.relaxHalf, curlRate = HAND.curlRate, far = HAND.far,
    outRate = HAND.outRate || 0, armFirst = HAND.armFirst ?? true, pull: pullIn = 0, pullMax = HAND.pullMax || 0, pullTol = HAND.pullTol ?? 0.003,
    gripBall = null, spreadMax = HAND.spreadMax ?? 0, spreadRate = HAND.spreadRate ?? 8, jointRate = HAND.jointRate ?? 0,
  } = opt;
  const prevSp = H.prevSp || (H.prevSp = new Float32Array(H.segs.length));
  const thLast = H.prevTh.slice();   // (last tick's corrections: the rate limit of this tick's)
  const gripW = clamp(+gripIn || 0, 0, 1), grip = gripW > 1e-3, pullW = clamp(+pullIn || 0, 0, 1);
  // (a hand that is not holding the ball: an arriving ball turns its fingers out at most outRate, the
  // arm moves the hand out for the rest — a hand pushed aside, not a finger flicked)
  const soft = !grip;
  const c = ball.p, RR = ball.R + margin;
  // the sphere the fingers wrap (the ball, or where it will sit on this palm: a catch about to land)
  // (HAND.preCurl false: an arriving ball only opens the fingers ahead of it; they close on the ball itself)
  const cg = gripBall?.p && HAND.preCurl ? gripBall.p : c, RRg = (gripBall?.R ?? ball.R) + margin;
  const cOpen = gripBall?.p || c;
  const out = { palmPush: 0, palmPull: 0, fingers: 0, residual: 0, depth: null };
  // far from the ball: nothing to do — unless corrections of the last frames are still letting go
  const wr = jointPos(mats, rig, rig.JI[`${s}_wrist`]);
  let busy = false; for (let i = 0; i < H.prevTh.length; i++) if (Math.abs(H.prevTh[i]) > 1e-3 || Math.abs(prevSp[i]) > 1e-3) { busy = true; break; }
  if (len(sub(wr, c)) > ball.R + far && len(sub(wr, cg)) > ball.R + far && !busy) { H.prevTh.fill(0); prevSp.fill(0); return out; }
  // 1. the palm on the ball: the hand moves straight out along its normal by what the palm skin needs
  {
    skinHand(H, mats, H.palm);
    const n = palmFrame(mats, rig, s).n;
    let e = 0;
    for (const v of H.palm) {
      const d = sub(vpos(H, v), c), h = -dot(d, n), rho2 = dot(d, d) - h * h;   // h: how far the skin is on the palm's side of c
      if (rho2 < RR * RR) e = Math.max(e, Math.sqrt(RR * RR - rho2) - h);
    }
    if (e > 1e-4 && reach) { out.palmPush = Math.min(e, pushMax); reach(mats, rig, s, sc(n, -out.palmPush), { maxExtend: 0.995 }); }
    else if (pullW > 1e-3 && pullMax > 0 && reach) {
      // a holding hand whose palm is off the ball (it was moved off the hands' targets: a two-hand
      // fit, a shot's launch pocket) rests on it again: the arm reaches in (≤ pullMax, eased by pull)
      let g = Infinity, at = -1;
      for (const v of H.palm) { const x = len(sub(vpos(H, v), c)) - RR; if (x < g) { g = x; at = v; } }
      if (g > pullTol) {
        out.palmPull = Math.min(g - pullTol / 2, pullMax) * pullW;
        reach(mats, rig, s, sc(norm(sub(c, vpos(H, at))), out.palmPull), { maxExtend: 0.995 });
      }
    }
  }
  // 2. the fingers (pass 0: the anatomical hinge; pass 1: straight toward / away from the ball)
  const fingers = (pass) => {
    let moved = 0, lagging = null;
    for (let si = 0; si < H.segs.length; si++) {
      const sg = H.segs[si];
      if (!sg.verts.length) continue;
      const chainV = H.chain[si];
      skinHand(H, mats, chainV);
      const a = jointPos(mats, rig, sg.j), d = sub(jointPos(mats, rig, sg.jc), a);
      const hinge = sg.hinge0 && pass === 0;
      let u;
      if (hinge) u = norm(Qv(mats, sg.j, sg.hinge0));
      else { const x = cross(d, sub(c, a)); if (len(x) < 1e-9) continue; u = norm(x); }   // +θ: toward the ball
      let lo, hi;
      if (hinge) {
        const dp = sub(a, jointPos(mats, rig, sg.jp));
        const phi = Math.atan2(dot(cross(norm(dp), norm(d)), u), dot(norm(dp), norm(d)));   // the joint's flexion now
        lo = sg.lim[0] - phi; hi = sg.lim[1] - phi;
      } else if (pass === 1) { lo = -0.35; hi = 0.35; }
      else { lo = sg.lim[0]; hi = sg.lim[1]; }
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
      const own = Array.from(sg.verts, (v) => sub(vpos(H, v), a));
      let all = null;
      if (pass === 0 && dt > 0 && sg.hinge0) {
        // the chain as it was drawn last tick: the joints after this one keep their corrections while this
        // one is solved (else it finds its touch with the finger straighter than it is, and the tip is
        // forced open again as it catches up — a reversal)
        const undo = [];
        for (let q = si + 1; q < H.segs.length && H.segs[q].f === sg.f; q++) {
          const sq = H.segs[q], tq = H.prevTh[q];
          if (!sq.hinge0 || Math.abs(tq) < 1e-4) continue;
          const pv = jointPos(mats, rig, sq.j), uq = norm(Qv(mats, sq.j, sq.hinge0));
          rotateSubtree(mats, rig, sq.j, axisAngle(uq, tq), pv); undo.push([sq.j, uq, tq, pv]);
        }
        if (undo.length) {
          skinHand(H, mats, chainV);
          all = Array.from(chainV, (v) => sub(vpos(H, v), a));
          for (let q = undo.length - 1; q >= 0; q--) { const [j, uq, tq, pv] = undo[q]; rotateSubtree(mats, rig, j, axisAngle(uq, -tq), pv); }
        }
      }
      if (!all) all = Array.from(chainV, (v) => sub(vpos(H, v), a));
      // a finger whose flexion arc misses the ball (it is off to the side of the hand: a guide hand, a two-hand
      // set) spreads at its knuckle toward it — the least that lets the fingertip rest on the ball (eased, ≤ spreadRate)
      if (pass === 0 && sg.k === 0 && sg.hinge0 && grip && spreadMax > 0) {
        const sAx = norm(Qv(mats, sg.j, H.bindN));
        const want = spreadFor(all, a, u, sAx, hi, cg, RRg, gripTol, spreadMax);
        let sp = want * gripW;
        if (dt > 0) { const pv = prevSp[si], k = Math.exp((-0.6931 * dt) / relaxHalf); sp = clamp(sp + (pv - sp) * k, pv - spreadRate * dt, pv + spreadRate * dt); }
        prevSp[si] = sp;
        if (Math.abs(sp) > 1e-5) {
          const Rs = axisAngle(sAx, sp);
          rotateSubtree(mats, rig, sg.j, Rs, a);
          for (let q = 0; q < own.length; q++) own[q] = mv(Rs, own[q]);
          for (let q = 0; q < all.length; q++) all[q] = mv(Rs, all[q]);
          u = norm(Qv(mats, sg.j, sg.hinge0));
        }
      } else if (pass === 0 && sg.k === 0) prevSp[si] = 0;
      const penOf = (L, cc = c, RRc = RR) => (th) => { const Rm = axisAngle(u, th); let m = -Infinity; for (const q of L) { const x = RRc - len(sub(add(a, mv(Rm, q)), cc)); if (x > m) m = x; } return m; };
      const pen = penOf(own), penAll = penOf(all), penG = penOf(own, cg, RRg), penAllG = penOf(all, cg, RRg);
      const p0 = pen(0);
      let th = 0, soonOut = false;
      const penO = penOf(own, cOpen, RRg);
      if (p0 <= 0 && gripBall && grip && pass === 0 && hinge && penO(0) > 0) {
        // inside where the arriving ball will sit: opened to that surface ahead of it (eased, ≤ curlRate — the
        // ball is not there yet), so it never has to be flicked out of the ball the tick it lands
        if (penO(lo) <= 0) { let A = lo, B = 0; for (let it = 0; it < 18; it++) { const m = (A + B) / 2; if (penO(m) > 0) B = m; else A = m; } th = A; } else th = lo;
        th *= gripW; soonOut = true;
      } else if (p0 > 0) {
        // out: the least extension that clears this phalanx
        if (pen(lo) <= 0) { let A = lo, B = 0; for (let it = 0; it < 18; it++) { const m = (A + B) / 2; if (pen(m) > 0) B = m; else A = m; } th = A; }
        else if (!hinge) {
          // (no hinge: the other way may clear it, else the least penetrating angle)
          if (pen(hi) <= 0) { let A = 0, B = hi; for (let it = 0; it < 18; it++) { const m = (A + B) / 2; if (pen(m) > 0) A = m; else B = m; } th = B; }
          else { let bv = p0; for (let q = 0; q <= 16; q++) { const t = lo + ((hi - lo) * q) / 16, v = pen(t); if (v < bv) { bv = v; th = t; } } }
        } else th = lo;   // at its limit: the hand moves out below (step 3)
      } else if (grip && pass === 0 && sg.k >= 0 && penAll(0) <= 0 && penAllG(0) <= 0 && Math.max(p0, penG(0)) > -(gripReach + clear)) {
        // grip: flex until the first touch of the distal chain, else as close as it comes — never off it, the
        // grip sphere's surface (the ball, or where it will sit) — and never into the real ball
        const N = 16;
        let best = 0, bv = penAllG(0), first = null;
        for (let q = 1; q <= N; q++) { const t = (hi * q) / N, v = penAllG(t); if (v >= -gripTol) { first = t; break; } if (v > bv) { bv = v; best = t; } }
        if (first != null) { let A = first - hi / N, B = first; for (let it = 0; it < 14; it++) { const m = (A + B) / 2; if (penAllG(m) < -gripTol) A = m; else B = m; } th = A; }
        else if (bv > -Math.max(gripNear, gripReach)) th = best;
        // never into the real ball — nor into where the arriving one still passes on its way in (gripBall.avoid)
        const inWay = (x) => penAll(x) > 0 || (gripBall?.avoid || []).some((q) => penOf(all, q, RR)(x) > 0);
        if (th > 0 && inWay(th)) { let A = 0, B = th; for (let it = 0; it < 14; it++) { const m = (A + B) / 2; if (inWay(m)) B = m; else A = m; } th = A; }
        // (a shape ahead of the ball curls the finger as a hand does — a tip never far ahead of the joint before it:
        // over-curled tips there redistribute in one tick when the ball lands)
        if (gripBall && HAND.preCurl && sg.k >= 1 && H.segs[si - 1]?.f === sg.f) th = Math.min(th, Math.max(0, H.prevTh[si - 1]) + 0.35);
        th *= gripW;
      }
      if (pass === 0 && dt > 0) {
        // one-sided smoothing: a correction the ball needs (more extension) applies at once; anything else
        // eases toward its new target with a half-life — an extension back toward the pose or into a grip,
        // a curl letting go (never into the ball) — and a curl grows ≤ curlRate
        const prev = H.prevTh[si], k = Math.exp((-0.6931 * dt) / relaxHalf);
        if (soonOut && th < prev) th = Math.max(th, prev - curlRate * dt);
        if (prev < -1e-4 && th > prev) th = Math.max(lo, th + (prev - th) * k);
        else if (prev > 1e-4 && th >= 0 && th < prev) { const rl = th + (prev - th) * k; if (penAll(rl) <= 0) th = Math.min(rl, hi); }
        // a finger closes from the knuckle out: while a joint nearer the palm is still closing (its curl
        // rate-limited), this one does not curl further — else it curls ahead to touch, and opens again
        // (a reversal, a flicker) as the knuckle catches up
        if (th > 0 && lagging === sg.f) th = Math.min(th, Math.max(prev, 0));
        // (… and curls on slowly at a joint whose next one is curled onto the ball — the finger already rests on it: a
        // knuckle closing fast under a curled tip straightens the tip in one tick, a 1.2 rad flick, the grip moved from
        // one joint to the other; slowly, the grip moves over)
        if (th > prev && th > 0 && H.segs[si + 1]?.f === sg.f && H.prevTh[si + 1] > 0.3) th = Math.min(th, Math.max(prev, 0) + HAND.shiftRate * dt);
        if (th > 0) { const cap = Math.max(prev, 0) + curlRate * dt; if (th > cap + 1e-6) { th = cap; lagging = sg.f; } }
        // (a free hand's finger turned out of an arriving ball: ≤ outRate — the arm takes the rest this tick)
        if (soft && th < 0 && outRate > 0) th = Math.max(th, Math.min(prev, 0) - outRate * dt);
        // a hand that has the ball (or is about to): no joint turned faster than jointRate either way — what the
        // finger cannot open in time, the arm takes (step 3 moves the hand out by the few mm left)
        if (!soft && jointRate > 0) th = clamp(th, prev - jointRate * dt, prev + jointRate * dt);
      }
      if (pass === 0) H.prevTh[si] = th;   // (dt = 0: a snapped pass — the next tick smooths from it)
      if (Math.abs(th) > 1e-5) { rotateSubtree(mats, rig, sg.j, axisAngle(u, th), a); moved++; }
    }
    return moved;
  };
  out.fingers = fingers(0);
  // 2b. a phalanx still inside with its own joint at its limit (a nearly straight fingertip lying in the
  // ball): the joints nearer the palm straighten the finger by the least that clears it — tip → root,
  // recorded in the smoothing so the same small shape holds every tick (no fallback toggling on and off)
  for (let si = H.segs.length - 1; si >= 0; si--) {
    const sg = H.segs[si];
    if (!sg.hinge0 || !sg.verts.length) continue;
    const chainV = H.chain[si];
    skinHand(H, mats, chainV);
    const a = jointPos(mats, rig, sg.j), d = sub(jointPos(mats, rig, sg.jc), a);
    const all = Array.from(chainV, (v) => sub(vpos(H, v), a));
    let m0 = -Infinity; for (const q of all) { const x = RR - len(sub(add(a, q), c)); if (x > m0) m0 = x; }
    if (m0 <= tol) continue;
    const u = norm(Qv(mats, sg.j, sg.hinge0)), dp = sub(a, jointPos(mats, rig, sg.jp));
    const phi = Math.atan2(dot(cross(norm(dp), norm(d)), u), dot(norm(dp), norm(d)));
    const lo = Math.min(0, sg.lim[0] - phi);
    if (lo > -1e-4) continue;
    const penAll = (th) => { const Rm = axisAngle(u, th); let m = -Infinity; for (const q of all) { const x = RR - len(sub(add(a, mv(Rm, q)), c)); if (x > m) m = x; } return m; };
    let th = lo;
    if (penAll(lo) <= 0) { let A = lo, B = 0; for (let it = 0; it < 16; it++) { const mid = (A + B) / 2; if (penAll(mid) > 0) B = mid; else A = mid; } th = A; }
    // (rate-limited like the rest for a hand that has the ball: the arm takes what is left)
    if (!soft && jointRate > 0 && dt > 0) th = Math.max(th, Math.min(0, thLast[si] - jointRate * dt - H.prevTh[si]));
    if (th > -1e-6) continue;
    rotateSubtree(mats, rig, sg.j, axisAngle(u, th), a);
    H.prevTh[si] += th; out.fingers++;
  }
  // 3. still inside: the fingers swing straight out, then the arm moves the hand out
  skinHand(H, mats);
  let r = skinDepth(H, H.all, c, RR);
  const armOut = () => {
    // along the deepest skin's own outward direction, by its depth
    for (let it = 0; it < 3 && r.d > tol && reach; it++) {
      const k = Math.min(r.d + tol, pushMax - out.residual);
      if (k <= 1e-4) break;
      reach(mats, rig, s, sc(norm(sub(vpos(H, r.at), c)), k), { maxExtend: 0.995 });
      out.residual += k;
      skinHand(H, mats); r = skinDepth(H, H.all, c, RR);
    }
  };
  if (armFirst) armOut();   // (a holding hand too: a hand moved out by a few mm reads better than its fingers flicked straight)
  if (r.d > tol) { out.fingers += fingers(1); skinHand(H, mats); r = skinDepth(H, H.all, c, RR); }
  armOut();
  out.depth = r.d - margin;   // (r.d is against R + margin)
  return out;
}

/** Knee yield: move the knee by `y` (world), hip and ankle fixed (planted feet stay put). */
export function yieldLeg(mats, rig, s, y) {
  if (len(y) < 1e-4) return;
  const iH = J(rig, `${s}_upleg`), iK = J(rig, `${s}_lowleg`), iA = J(rig, `${s}_foot`);
  const H = jointPos(mats, rig, iH), K = jointPos(mats, rig, iK), A = jointPos(mats, rig, iA);
  const Kt = add(K, y);
  const R1 = swing(sub(K, H), sub(Kt, H));
  if (R1) rotateSubtree(mats, rig, iH, R1, H);
  const K2 = jointPos(mats, rig, iK), A2 = jointPos(mats, rig, iA);
  const R2 = swing(sub(A2, K2), sub(A, K2));
  if (R2) rotateSubtree(mats, rig, iK, R2, K2);
}

/**
 * The whole contact pass for one frame.
 * @param {Float32Array} mats  bone matrices (modified in place)
 * @param {object} rig   prepareMhr() result
 * @param {object} ball  { p: [x,y,z], R }
 * @param {object} ctl   { hand: 'left'|'right'|null, weight: 0–1 (contact 1, approach < 1), grip: bool, other: 'left'|'right'|null, otherWeight,
 *                         reachMax / reachLimit: a catch reach (the hand goes to a ball it would miss) }
 * @param {object} cfg   physics config (ikStrength, ikMax, ikAimMax, palmThickness: m | { left, right } (the hand's own palm
 *                       clearance added), radii.finger, skinContact: the fingers are left to resolveHandBall)
 * @param {object} [legYield] { left: [x,y,z], right }
 */
export function contactPass(mats, rig, ball, ctl, cfg, legYield = null) {
  const out = { reach: 0, aim: 0, fingers: 0 };
  if (legYield) for (const [s, side] of [['l', 'left'], ['r', 'right']]) yieldLeg(mats, rig, s, legYield[side]);
  const hands = [];
  if (ctl?.hand) hands.push([ctl.hand, ctl.weight ?? 1]);
  if (ctl?.other) hands.push([ctl.other, ctl.otherWeight ?? 0]);
  for (const [side, w0] of hands) {
    const s = side[0], w = clamp(w0 * (cfg.ikStrength ?? 1), 0, 1);
    if (w <= 0.001) continue;
    // where the palm would touch the ball's surface (same geometry as the physics palm target, inverted)
    const f = palmFrame(mats, rig, s);
    const toBall = norm(sub(ball.p, f.c));
    const pt = typeof cfg.palmThickness === 'object' ? cfg.palmThickness[side] : cfg.palmThickness;
    const want = sub(sub(ball.p, sc(toBall, ball.R + pt)), sc(f.y, 0.012));
    let d = sub(want, f.c);
    const dl = len(d);
    if (dl > (ctl.reachLimit ?? cfg.ikReach ?? 0.3)) continue;   // too far: this is not a contact
    d = sc(d, Math.min(1, ((ctl.reachMax ?? cfg.ikMax) * w) / (dl || 1)) * w);
    reachArm(mats, rig, s, d, { maxElbow: cfg.maxElbow, maxExtend: cfg.maxExtend }); out.reach = Math.max(out.reach, len(d));
    aimHand(mats, rig, s, toBall, cfg.ikAimMax * w); out.aim += 1;
    if (!cfg.skinContact) out.fingers += conformFingers(mats, rig, s, ball.p, ball.R, { grip: ctl.grip !== false && w > 0.5, rf: cfg.radii?.finger ?? 0.0095 });
  }
  // fingers of a hand not in control must still never be inside the ball
  if (!cfg.skinContact) for (const side of ['left', 'right']) if (!hands.some(([h]) => h === side)) out.fingers += conformFingers(mats, rig, side[0], ball.p, ball.R, { grip: false, rf: cfg.radii?.finger ?? 0.0095 });
  return out;
}
