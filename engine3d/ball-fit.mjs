/**
 * Ball fit — a held ball clear of the player's own hands, arms, head and chest.
 *
 * A capture's hands can be closer together than a ball is wide (SAM guesses hands that left the
 * picture), and a palm target can face into the other hand: the ball on the targets would sit
 * inside the palms, knuckles, thumbs, forearms or head. This finds the nearest place that is
 * clear (and, as a shot's release nears, the nearest clear place on the side it will be thrown),
 * and a straight line out of the body for a launch. The fingers of a holding hand are not
 * obstacles (they conform to the ball: contact-ik), everything rigid is. The legs are not here
 * (the controller's leg push / knee yield own them).
 *
 * Pure, engine-agnostic (no three.js). Body = BasketballPhysicsSystem bodySampleFromJoints().
 */
import { sdBox } from './basketball-physics.mjs';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const FINGER = /^(thumb|index|middle|ring|pinky)(\d)_([lr])$/;
const UP = [0, 1, 0];
const DIRS26 = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) DIRS26.push(norm([x, y, z]));

/**
 * The rigid obstacles of a held ball.
 * @param {object} body     bodySampleFromJoints() result ({ caps, boxes, palms })
 * @param {'left'|'right'|'both'|null} holding  the hand(s) holding the ball (their fingers conform, not collide)
 * @returns {object[]} colliders: { kind: 'cap', a, b, r } | { kind: 'slab', c, n, x, y, h } | { kind: 'box', c, q, h }, each with a name `id`
 */
export function handColliders(body, holding = null, { holdingRigid = true } = {}) {
  const out = [];
  if (!body) return out;
  const C = body.caps || {};
  for (const id of ['head', 'upperarm_l', 'upperarm_r', 'forearm_l', 'forearm_r']) if (C[id]) out.push({ kind: 'cap', id, a: C[id].a, b: C[id].b, r: C[id].r });
  if (body.boxes?.chest) out.push({ kind: 'box', id: 'chest', ...body.boxes.chest });
  const holds = (s) => holding === 'both' || (holding && holding[0] === s);
  for (const [side, pl] of Object.entries(body.palms || {})) {
    const s = side[0];
    // (a holding hand with its own skin contact — contact-ik resolveHandBall — rests its palm ON the ball and is
    // moved out of it by the arm: it is no obstacle to fit the ball away from)
    if (!holdingRigid && holds(s)) continue;
    out.push({ kind: 'slab', id: `palm_${s}`, c: pl.c, n: pl.n, x: pl.x, y: pl.y, h: pl.h });
    // the knuckles (every finger's base) are the rigid hand, holding or not
    const i1 = C[`index1_${s}`], p1 = C[`pinky1_${s}`];
    if (i1 && p1) out.push({ kind: 'cap', id: `knuckles_${s}`, a: i1.a, b: p1.a, r: i1.r });
    if (C[`thumb1_${s}`]) out.push({ kind: 'cap', id: `thumb1_${s}`, ...C[`thumb1_${s}`] });
  }
  // a hand that is not holding the ball: every finger is an obstacle
  for (const [id, c] of Object.entries(C)) {
    const m = id.match(FINGER);
    if (!m || (m[1] === 'thumb' && m[2] === '1') || holds(m[3])) continue;
    out.push({ kind: 'cap', id, a: c.a, b: c.b, r: c.r });
  }
  return out;
}

/** Signed clearance of a ball (centre p, radius R) from one collider (< 0 = inside) and the way out. */
export function penetration(p, col, R) {
  if (col.kind === 'cap') {
    const ab = sub(col.b, col.a), t = clamp(dot(sub(p, col.a), ab) / (dot(ab, ab) || 1e-12), 0, 1);
    const v = sub(p, add(col.a, sc(ab, t))), l = len(v);
    return { d: l - col.r - R, n: l > 1e-9 ? sc(v, 1 / l) : UP };
  }
  if (col.kind === 'slab') {
    // the palm: a thin plate — only a ball over its face can touch it; it leaves by the side it is on
    const v = sub(p, col.c), ln = dot(v, col.n), lx = dot(v, col.x), ly = dot(v, col.y);
    if (Math.abs(lx) > col.h[0] + R || Math.abs(ly) > col.h[1] + R) return { d: 1, n: col.n };
    return { d: Math.abs(ln) - col.h[2] - R, n: ln >= 0 ? col.n : sc(col.n, -1) };
  }
  const r = sdBox(p, col.c, col.q, col.h), v = sub(p, r.q), l = len(v);
  return { d: r.d - R, n: l > 1e-9 && r.d > 0 ? sc(v, 1 / l) : norm(sub(p, col.c)) };
}

/** The smallest clearance over colliders (Infinity: none). */
export function clearance(p, cols, R) {
  let m = Infinity;
  for (const c of cols) m = Math.min(m, penetration(p, c, R).d);
  return m;
}

/** The first clear point from p0 along unit d (5 mm steps, ≤ maxMove), or null. */
function march(p0, d, cols, R, margin, maxMove, step = 0.005) {
  for (let s = 0; s <= maxMove + 1e-9; s += step) {
    const q = add(p0, sc(d, s));
    if (clearance(q, cols, R) >= margin) return { q, s };
  }
  return null;
}

/**
 * A held ball out of the rigid hand, arms, head and chest: the smallest move that clears it; as
 * a shot's release nears (preferWeight ≥ 0.5), the nearest clear place on the side it will be
 * thrown (the ball rolls onto the shooting fingers, never back through the hands).
 * @param {number[]} p   the ball where the hands would put it
 * @param {object} body  bodySampleFromJoints()
 * @param {number} R     ball radius
 * @param {object} [o]   { holding, prefer: unit launch direction | null, preferWeight 0…1, margin, maxMove, holdingRigid (default
 *                        true; false: the holding hands' palms / knuckles / thumbs are not obstacles — their skin contact moves them) }
 * @returns {{ p: number[], moved: number, clearance: number, ok: boolean }}
 */
export function fitBallToHands(p, body, R, { holding = null, prefer = null, preferWeight = 0, margin = 0.002, maxMove = 0.3, cols = null, holdingRigid = true } = {}) {
  cols = cols || handColliders(body, holding, { holdingRigid });
  if (!cols.length) return { p: p.slice(), moved: 0, clearance: Infinity, ok: true };
  const c0 = clearance(p, cols, R);
  if (c0 >= margin && !(prefer && preferWeight >= 0.5)) return { p: p.slice(), moved: 0, clearance: c0, ok: true };
  let q = p.slice();
  if (c0 < margin) {
    // (a) out along the deepest overlap, repeatedly
    for (let it = 0; it < 20; it++) {
      let worst = null;
      for (const c of cols) { const r = penetration(q, c, R); if (r.d < margin && (!worst || r.d < worst.d)) worst = r; }
      if (!worst) break;
      q = add(q, sc(worst.n, margin - worst.d));
    }
    // (b) it did not settle (hands closer together than the ball is wide): the nearest clear point
    if (clearance(q, cols, R) < 0 || len(sub(q, p)) > maxMove) {
      const ref = prefer || UP;
      let best = null;
      for (const d of DIRS26) {
        const r = march(p, d, cols, R, margin, maxMove);
        if (!r) continue;
        const cost = r.s * (1.25 - 0.25 * dot(d, ref));
        if (!best || cost < best.cost) best = { q: r.q, cost };
      }
      if (best) q = best.q;
    }
  }
  // (c) the release is near: the nearest clear place on the launch side (not an interpolation —
  // a point between two clear places can be inside a hand)
  if (prefer && preferWeight >= 0.5) {
    const side = norm([prefer[2], 0, -prefer[0]]);
    let best = null;
    for (const d of [prefer, norm(add(prefer, sc(UP, 0.5))), norm(add(prefer, sc(side, 0.4))), norm(add(prefer, sc(side, -0.4)))]) {
      const r = march(p, d, cols, R, margin, maxMove);
      if (r && (!best || r.s < best.s)) best = r;
    }
    if (best) q = best.q;
  }
  // (d) never further than maxMove
  let dq = sub(q, p);
  const m = len(dq);
  if (m > maxMove) { dq = sc(dq, maxMove / m); q = add(p, dq); }
  const cl = clearance(q, cols, R);
  return { p: q, moved: Math.min(m, maxMove), clearance: cl, ok: cl >= -0.001 };
}

/**
 * A launch that starts inside the body (a palm, a forearm, the head) moves along its direction
 * until the ball is clear — the physics then never starts it inside the thrower.
 * @returns {{ p: number[], moved: number, clearance: number }}
 */
export function sweepClear(p, dir, body, R, { holding = null, maxDist = 0.3, step = 0.005, cols = null } = {}) {
  cols = cols || handColliders(body, holding);
  const d = norm(dir);
  let s = 0, q = p.slice(), cl = clearance(q, cols, R);
  while (cl < 0 && s < maxDist) { s += step; q = add(p, sc(d, s)); cl = clearance(q, cols, R); }
  return { p: q, moved: s, clearance: cl };
}
