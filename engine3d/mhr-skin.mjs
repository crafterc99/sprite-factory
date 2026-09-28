/**
 * MHR skinning for the 3D court: drive the Momentum Human Rig skeleton (127
 * joints, the body model SAM 3D Body fits) from an MHR70 keypoint pose, and
 * produce rigid linear-blend-skinning matrices for its own mesh + weights.
 *
 * Why: skinning straight from keypoints (one frame per bone, twist guessed
 * from noisy points, 2 influences, no shoulder/twist joints) folds elbows and
 * knees, candy-wraps twisting limbs and collapses shoulders. MHR has a real
 * skeleton (clavicles, 4 spine joints, twist joints along every limb) and
 * artist skin weights; this solver fills it with rigid rotations:
 *
 *   pelvis / chest / head  full frames from hips, shoulders, ears + nose
 *   limbs                  bend-plane frames (elbow / knee hinge), the hand or
 *                          foot's own frame when the limb is straight
 *   twist joints           the limb's twist spread exactly like MHR's rig
 *                          (upper arm / thigh 0 → 100 %, forearm / shin 20–80 %)
 *   hands, fingers, feet   frames and aims from their keypoints
 *
 * Skinning matrix of joint j: M = [Q | p − Q·b] (Q = world rotation from the
 * bind pose, b / p = bind / posed joint position) — no scale, no shear, so
 * volume is kept and nothing folds through itself.
 *
 * Engine-agnostic, no dependencies; runs in the browser and in Node.
 */

// ── small 3×3 / vector helpers (row-major nested arrays) ─────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mv = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const mm = (a, b) => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c]));
const tr = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
const smooth = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function quatToMat([x, y, z, w]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
function matToQuat(m) {
  const t = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); w = 0.25 / s; x = (m[2][1] - m[1][2]) * s; y = (m[0][2] - m[2][0]) * s; z = (m[1][0] - m[0][1]) * s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]); w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]); w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s; }
  else { const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]); w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}
function slerpQ(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  if (d > 0.9995) { const q = a.map((v, i) => v + (s * b[i] - v) * t); const l = Math.hypot(...q); return q.map((v) => v / l); }
  const th = Math.acos(d), sa = Math.sin(th);
  const k0 = Math.sin((1 - t) * th) / sa, k1 = (s * Math.sin(t * th)) / sa;
  return a.map((v, i) => k0 * v + k1 * b[i]);
}
const slerpM = (A, B, t) => (t <= 0 ? A : t >= 1 ? B : quatToMat(slerpQ(matToQuat(A), matToQuat(B), t)));
/** Rotation about unit axis u by angle a. */
function axisAngle(u, a) {
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c, [x, y, z] = u;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
/** Shortest rotation taking direction a onto b. */
function swing(a, b) {
  a = norm(a); b = norm(b);
  const v = cross(a, b), c = dot(a, b);
  if (c > 0.999999) return I3();
  if (c < -0.999999) { const p = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])); return axisAngle(p, Math.PI); }
  const k = 1 / (1 + c);
  return [[v[0] * v[0] * k + c, v[1] * v[0] * k - v[2], v[2] * v[0] * k + v[1]],
    [v[0] * v[1] * k + v[2], v[1] * v[1] * k + c, v[2] * v[1] * k - v[0]],
    [v[0] * v[2] * k - v[1], v[1] * v[2] * k + v[0], v[2] * v[2] * k + c]];
}
/** Orthonormal frame (columns) from a primary and a secondary direction. */
function basis(a, b) {
  const e1 = norm(a);
  let e2 = sub(b, sc(e1, dot(e1, b)));
  if (len(e2) < 1e-8) e2 = Math.abs(e1[1]) < 0.9 ? cross(e1, [0, 1, 0]) : cross(e1, [1, 0, 0]);
  e2 = norm(e2);
  const e3 = cross(e1, e2);
  return [[e1[0], e2[0], e3[0]], [e1[1], e2[1], e3[1]], [e1[2], e2[2], e3[2]]];
}
/** Rotation taking the rest frame (a0, b0) onto the pose frame (a, b). */
const frameRot = (a, b, a0, b0) => mm(basis(a, b), tr(basis(a0, b0)));
/** Signed twist of rotation R about unit axis u (swing–twist split). */
function twistAngle(R, u) {
  const q = matToQuat(R);
  const p = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
  return 2 * Math.atan2(p, q[3]);
}

// ── rig ──────────────────────────────────────────────────────────────────────
const KP = ['nose', 'left-eye', 'right-eye', 'left-ear', 'right-ear', 'left-shoulder', 'right-shoulder', 'left-elbow', 'right-elbow', 'left-hip', 'right-hip', 'left-knee', 'right-knee', 'left-ankle', 'right-ankle', 'left-big-toe-tip', 'left-small-toe-tip', 'left-heel', 'right-big-toe-tip', 'right-small-toe-tip', 'right-heel'];

/**
 * Prepare an MHR rig (rig JSON v4 `mhr` block + restJoints) for the solver.
 * @param {object} json   rig JSON (kind 'mhr')
 * @param {string[]} kpNames MHR70 keypoint names (runtime order)
 */
export function prepareMhr(json, kpNames) {
  const m = json.mhr;
  const names = m.names, parents = m.parents, n = names.length;
  const JI = Object.fromEntries(names.map((nm, i) => [nm, i]));
  const K = Object.fromEntries(kpNames.map((nm, i) => [nm, i]));
  const b = m.bindPos.map((p) => p.slice());
  const R0 = m.bindRot.map(quatToMat);
  const K0 = json.restJoints.map((p) => p.slice());
  const children = names.map(() => []);
  parents.forEach((p, i) => { if (p >= 0) children[p].push(i); });
  // keypoints that sit on a joint (joint target positions): offset < 1.5 cm
  const target = new Int16Array(n).fill(-1);
  m.kpJoint.forEach((j, k) => { const o = m.kpOffset[k]; if (Math.hypot(o[0], o[1], o[2]) < 0.015 && target[j] < 0) target[j] = k; });
  return { names, parents, children, JI, K, b, R0, K0, n, target, kpJoint: m.kpJoint, kpOffset: m.kpOffset };
}

/**
 * Solve the MHR skeleton for one keypoint pose.
 * @param {ArrayLike<number>} P flat keypoints (x,y,z per MHR70 keypoint, world, metres; extra points ignored)
 * @param {object} rig prepared by prepareMhr
 * @returns {{ Q: number[][][], p: number[][] }} world rotation from bind + world position per joint
 */
export function solveMhr(P, rig) {
  const { JI, K, b, R0, K0, n, parents } = rig;
  const O = { clav: 0.6, pelvisThigh: 0, elbowLm: 0, fingerPlane: 0, spine: [0.15, 0.4, 0.7], ...(rig.tune || {}) };
  const kp = (name) => { const i = K[name] * 3; return [P[i], P[i + 1], P[i + 2]]; };
  const k0 = (name) => K0[K[name]];
  const Q = new Array(n), pos = new Array(n);
  const j = (nm) => JI[nm];
  const set = (nm, q) => { Q[j(nm)] = q; };

  // torso: pelvis from the hips, chest from the shoulders (shared "up")
  const hipM = mid(kp('left-hip'), kp('right-hip')), hipM0 = mid(k0('left-hip'), k0('right-hip'));
  const shoM = mid(kp('left-shoulder'), kp('right-shoulder')), shoM0 = mid(k0('left-shoulder'), k0('right-shoulder'));
  const up = sub(shoM, hipM), up0 = sub(shoM0, hipM0);
  // pelvis tilt: follows the thighs part-way (hips alone can't show it)
  const thM = norm(sub(hipM, mid(kp('left-knee'), kp('right-knee')))), thM0 = norm(sub(hipM0, mid(k0('left-knee'), k0('right-knee'))));
  const upP = lerp(norm(up), thM, O.pelvisThigh), upP0 = lerp(norm(up0), thM0, O.pelvisThigh);
  const Qp = frameRot(sub(kp('left-hip'), kp('right-hip')), upP, sub(k0('left-hip'), k0('right-hip')), upP0);
  const Qc = frameRot(sub(kp('left-shoulder'), kp('right-shoulder')), up, sub(k0('left-shoulder'), k0('right-shoulder')), up0);
  for (const nm of ['body_world', 'root']) set(nm, Qp);
  [['c_spine0', O.spine[0]], ['c_spine1', O.spine[1]], ['c_spine2', O.spine[2]], ['c_spine3', 1]].forEach(([nm, t]) => set(nm, slerpM(Qp, Qc, t)));
  // head: ears across, nose forward
  const earM = mid(kp('left-ear'), kp('right-ear')), earM0 = mid(k0('left-ear'), k0('right-ear'));
  const Qh = frameRot(sub(kp('left-ear'), kp('right-ear')), sub(kp('nose'), earM), sub(k0('left-ear'), k0('right-ear')), sub(k0('nose'), earM0));
  set('c_neck', slerpM(Qc, Qh, 0.45)); set('c_neck_twist0_proc', slerpM(Qc, Qh, 0.3)); set('c_neck_twist1_proc', slerpM(Qc, Qh, 0.7));
  set('c_head', Qh);

  for (const s of ['l', 'r']) {
    const side = s === 'l' ? 'left' : 'right';
    const J_ = (x) => `${s}_${x}`, k = (x) => kp(`${side}-${x}`), r = (x) => k0(`${side}-${x}`);
    // clavicle: aims the shoulder joint at the shoulder keypoint (partly: clavicles move less than arms)
    const clavAim = mm(swing(mv(Qc, sub(b[j(J_('uparm'))], b[j(J_('clavicle'))])), sub(k('shoulder'), add(mv(Qc, sub(b[j(J_('clavicle'))], hipM0)), hipM))), Qc);
    const Qcl = slerpM(Qc, clavAim, O.clav);
    set(J_('clavicle'), Qcl);
    // arm: bend plane when the elbow bends, the hand's own frame when it is straight
    const ua = sub(k('elbow'), k('shoulder')), la = sub(k('wrist'), k('elbow'));
    const ua0 = sub(r('elbow'), r('shoulder')), la0 = sub(r('wrist'), r('elbow'));
    const hand = sub(k('middle-third-joint'), k('wrist')), hand0 = sub(r('middle-third-joint'), r('wrist'));
    const acr = sub(k('index-third-joint'), k('pinky-third-joint')), acr0 = sub(r('index-third-joint'), r('pinky-third-joint'));
    const nA = cross(ua, la), nA0 = cross(ua0, la0);
    const bentA = smooth(len(nA) / (len(ua) * len(la) || 1), 0.12, 0.35);
    const QuSw = mm(swing(mv(Qcl, ua0), ua), Qcl);                       // swing only (no twist)
    const QuBend = frameRot(ua, nA, ua0, nA0);
    const QuHand = frameRot(ua, acr, ua0, acr0);
    // straight arm: the elbow's own landmarks (front crease → point of the elbow) give the twist
    const elb = sub(k('olecranon'), k('cubital-fossa')), elb0 = sub(r('olecranon'), r('cubital-fossa'));
    const QuStraight = O.elbowLm ? slerpM(QuHand, frameRot(ua, elb, ua0, elb0), O.elbowLm) : QuHand;
    const Qu = len(nA0) > 1e-6 ? slerpM(QuStraight, QuBend, bentA) : QuStraight;
    set(J_('uparm'), Qu);
    for (let t = 0; t <= 4; t++) set(J_(`uparm_twist${t}_proc`), slerpM(QuSw, Qu, t / 4));
    const QlBend = frameRot(la, nA, la0, nA0);
    const QlFollow = mm(swing(mv(Qu, la0), la), Qu);
    const Ql = slerpM(QlFollow, QlBend, bentA);
    set(J_('lowarm'), Ql);
    // hand frame; forearm pronation spread over the forearm twist joints (20–80 %)
    const Qw = frameRot(hand, acr, hand0, acr0);
    const u = norm(la);
    const th = twistAngle(mm(Qw, tr(Ql)), u);
    for (let t = 1; t <= 4; t++) set(J_(`lowarm_twist${t}_proc`), mm(axisAngle(u, 0.2 * t * th), Ql));
    set(J_('wrist_twist'), mm(axisAngle(u, th), Ql));
    set(J_('wrist'), Qw);
    // fingers: each bone aimed along its keypoints (parent frame keeps the roll)
    const FING = { index: ['index1', 'index2', 'index3', 'index_null'], middle: ['middle1', 'middle2', 'middle3', 'middle_null'], ring: ['ring1', 'ring2', 'ring3', 'ring_null'], pinky: ['pinky1', 'pinky2', 'pinky3', 'pinky_null'], thumb: ['thumb1', 'thumb2', 'thumb3', 'thumb_null'] };
    const KPN = ['third-joint', 'second-joint', 'first-joint', 'tip'];
    for (const [f, chain] of Object.entries(FING)) {
      let Qpar = Qw;
      if (f === 'pinky') set(J_('pinky0'), Qw);
      if (f === 'thumb') {
        // thumb base: from the wrist toward the thumb's first keypoint
        const d = sub(k('thumb-third-joint'), k('wrist')), d0 = sub(r('thumb-third-joint'), r('wrist'));
        Qpar = mm(swing(mv(Qw, d0), d), Qw); set(J_('thumb0'), Qpar);
      }
      // the finger's curl plane fixes its roll (swing alone loses it)
      const fp = KPN.map((x) => k(`${f}-${x}`)), fp0 = KPN.map((x) => r(`${f}-${x}`));
      const nf = add(cross(sub(fp[1], fp[0]), sub(fp[2], fp[1])), cross(sub(fp[2], fp[1]), sub(fp[3], fp[2])));
      const nf0 = add(cross(sub(fp0[1], fp0[0]), sub(fp0[2], fp0[1])), cross(sub(fp0[2], fp0[1]), sub(fp0[3], fp0[2])));
      const curl = smooth(len(nf) / (len(sub(fp[1], fp[0])) * len(sub(fp[2], fp[1])) + 1e-9), 0.15, 0.45) * (len(nf0) > 1e-7 ? 1 : 0) * O.fingerPlane;
      for (let c = 0; c < 3; c++) {
        const d = sub(fp[c + 1], fp[c]), d0 = sub(fp0[c + 1], fp0[c]);
        const aim = mm(swing(mv(Qpar, d0), d), Qpar);
        Qpar = curl > 0 ? slerpM(aim, frameRot(d, nf, d0, nf0), curl) : aim;
        set(J_(chain[c]), Qpar);
      }
      set(J_(chain[3]), Qpar);
    }
    // leg: knee hinge plane when bent, the foot's axis when straight
    const th0 = sub(r('knee'), r('hip')), sh0 = sub(r('ankle'), r('knee'));
    const thg = sub(k('knee'), k('hip')), shn = sub(k('ankle'), k('knee'));
    const fwd = sub(mid(k('big-toe-tip'), k('small-toe-tip')), k('heel')), fwd0 = sub(mid(r('big-toe-tip'), r('small-toe-tip')), r('heel'));
    const nL = cross(thg, shn);
    // straight-leg reference: the knee points where the foot points
    const nFoot = cross(thg, fwd), nFoot0 = cross(th0, fwd0);
    const bentL = smooth(len(nL) / (len(thg) * len(shn) || 1), 0.1, 0.3);
    // the bend normal points the same way as the foot's (knees bend forward)
    const nLs = dot(nL, nFoot) < 0 ? sc(nL, -1) : nL;
    const axis = lerp(norm(nFoot), norm(nLs), bentL);
    const QtSw = mm(swing(mv(Qp, th0), thg), Qp);
    const Qt = frameRot(thg, axis, th0, nFoot0);
    set(J_('upleg'), Qt);
    for (let t = 0; t <= 4; t++) set(J_(`upleg_twist${t}_proc`), slerpM(QtSw, Qt, t / 4));
    const Qs = frameRot(shn, axis, sh0, nFoot0);
    set(J_('lowleg'), Qs);
    const acrF = sub(k('big-toe-tip'), k('small-toe-tip')), acrF0 = sub(r('big-toe-tip'), r('small-toe-tip'));
    const Qf = frameRot(fwd, acrF, fwd0, acrF0);
    const us = norm(shn);
    const tf = twistAngle(mm(Qf, tr(Qs)), us);
    for (let t = 1; t <= 4; t++) set(J_(`lowleg_twist${t}_proc`), mm(axisAngle(us, 0.2 * t * tf), Qs));
    for (const nm of ['foot', 'talocrural', 'subtalar', 'transversetarsal', 'ball']) set(J_(nm), Qf);
  }
  // everything else follows its parent
  for (let i = 0; i < n; i++) if (!Q[i]) Q[i] = parents[i] >= 0 ? Q[parents[i]] : I3();

  // positions: FK from the pelvis, snapped to the keypoints a joint sits on
  const root = j('root');
  const hipRest = hipM0;
  for (let i = 0; i < n; i++) {
    const pi = parents[i];
    let p;
    if (i === root || pi < 0) p = add(hipM, mv(Qp, sub(b[i], hipRest)));
    else p = add(pos[pi], mv(Q[pi], sub(b[i], b[pi])));
    const t = rig.target[i];
    if (t >= 0) { const q = [P[t * 3], P[t * 3 + 1], P[t * 3 + 2]]; p = q; }
    pos[i] = p;
  }
  return { Q, p: pos };
}

/**
 * Skinning matrices (column-major 4×4 per joint, for a GPU skinned mesh with
 * identity bind / bone inverses): M = [Q | p − Q·b].
 */
export function mhrBoneMatrices(P, rig, out = new Float32Array(rig.n * 16)) {
  const { Q, p } = solveMhr(P, rig);
  for (let i = 0; i < rig.n; i++) {
    const q = Q[i], t = sub(p[i], mv(q, rig.b[i])), o = i * 16;
    out[o] = q[0][0]; out[o + 1] = q[1][0]; out[o + 2] = q[2][0]; out[o + 3] = 0;
    out[o + 4] = q[0][1]; out[o + 5] = q[1][1]; out[o + 6] = q[2][1]; out[o + 7] = 0;
    out[o + 8] = q[0][2]; out[o + 9] = q[1][2]; out[o + 10] = q[2][2]; out[o + 11] = 0;
    out[o + 12] = t[0]; out[o + 13] = t[1]; out[o + 14] = t[2]; out[o + 15] = 1;
  }
  return out;
}

/** CPU skinning (tests / previews): rest verts + skin (4 idx/weights) → posed verts. */
export function skinVerts(verts, skinIdx, skinW, mats, out = new Float32Array(verts.length)) {
  const n = verts.length / 3;
  for (let v = 0; v < n; v++) {
    const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinW[v * 4 + k];
      if (!w) continue;
      const o = skinIdx[v * 4 + k] * 16;
      ox += w * (mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]);
      oy += w * (mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]);
      oz += w * (mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]);
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
  return out;
}

export const _internal = { quatToMat, matToQuat, frameRot, swing, twistAngle, slerpM };
