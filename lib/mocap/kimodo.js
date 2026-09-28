/**
 * Motions from NVIDIA Kimodo (text-to-motion) and other generators → MHR70.
 *
 * Input: { skeleton: 'mhr70' | 'soma' | 'smplx', jointNames?, frames: [[x,y,z] per joint] per frame,
 *          upAxis: 'y' | 'z', units: 'm' | 'cm', forward: '+z' | '+y' | … }
 * Output: frames of 70 MHR70 joints, metres, y-up, feet on the floor.
 * Skeleton maps live in SKELETONS (filled from the Kimodo model's skeleton).
 */
'use strict';

const S = require('./skeleton');
const { J } = S;
const V = { add: S.add, sub: S.sub, sc: S.scale, norm: S.norm, cross: S.cross, dot: S.dot, len: S.len };

/**
 * Source skeletons: joint names → the common set this module understands
 * (left_hip, left_knee, left_ankle, left_toe, neck, head, left_shoulder,
 * left_elbow, left_wrist, left_hand, left_<finger>_<third|second|first|tip>).
 * SOMA = Kimodo-SOMA ("somaskel77": 30 fps, metres, y-up, starts facing +Z, +X = the character's left).
 */
const SOMA_ALIAS = { Hips: 'pelvis', Neck1: 'neck', Head: 'head' };
for (const [S2, s] of [['Left', 'left'], ['Right', 'right']]) {
  Object.assign(SOMA_ALIAS, {
    [`${S2}Leg`]: `${s}_hip`, [`${S2}Shin`]: `${s}_knee`, [`${S2}Foot`]: `${s}_ankle`, [`${S2}ToeEnd`]: `${s}_toe`, [`${S2}ToeBase`]: `${s}_toebase`,
    [`${S2}Arm`]: `${s}_shoulder`, [`${S2}ForeArm`]: `${s}_elbow`, [`${S2}Hand`]: `${s}_wrist`, [`${S2}HandMiddle1`]: `${s}_hand`,
    [`${S2}HandThumb1`]: `${s}_thumb_third`, [`${S2}HandThumb2`]: `${s}_thumb_second`, [`${S2}HandThumb3`]: `${s}_thumb_first`, [`${S2}HandThumbEnd`]: `${s}_thumb_tip`,
  });
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const l = f.toLowerCase();
    Object.assign(SOMA_ALIAS, { [`${S2}Hand${f}2`]: `${s}_${l}_third`, [`${S2}Hand${f}3`]: `${s}_${l}_second`, [`${S2}Hand${f}4`]: `${s}_${l}_first`, [`${S2}Hand${f}End`]: `${s}_${l}_tip` });
  }
}
// Kimodo SOMASkeleton77 joint order (kimodo/skeleton/definitions.py) = posed_joints axis 1
const SOMA77 = ["Hips","Spine1","Spine2","Chest","Neck1","Neck2","Head","HeadEnd","Jaw","LeftEye","RightEye","LeftShoulder","LeftArm","LeftForeArm","LeftHand","LeftHandThumb1","LeftHandThumb2","LeftHandThumb3","LeftHandThumbEnd","LeftHandIndex1","LeftHandIndex2","LeftHandIndex3","LeftHandIndex4","LeftHandIndexEnd","LeftHandMiddle1","LeftHandMiddle2","LeftHandMiddle3","LeftHandMiddle4","LeftHandMiddleEnd","LeftHandRing1","LeftHandRing2","LeftHandRing3","LeftHandRing4","LeftHandRingEnd","LeftHandPinky1","LeftHandPinky2","LeftHandPinky3","LeftHandPinky4","LeftHandPinkyEnd","RightShoulder","RightArm","RightForeArm","RightHand","RightHandThumb1","RightHandThumb2","RightHandThumb3","RightHandThumbEnd","RightHandIndex1","RightHandIndex2","RightHandIndex3","RightHandIndex4","RightHandIndexEnd","RightHandMiddle1","RightHandMiddle2","RightHandMiddle3","RightHandMiddle4","RightHandMiddleEnd","RightHandRing1","RightHandRing2","RightHandRing3","RightHandRing4","RightHandRingEnd","RightHandPinky1","RightHandPinky2","RightHandPinky3","RightHandPinky4","RightHandPinkyEnd","LeftLeg","LeftShin","LeftFoot","LeftToeBase","LeftToeEnd","RightLeg","RightShin","RightFoot","RightToeBase","RightToeEnd"];
const SKELETONS = { soma: { names: SOMA77, alias: SOMA_ALIAS }, somaskel77: { names: SOMA77, alias: SOMA_ALIAS } };

// ── NPZ (numpy zip) reader: Kimodo's "Download → NPZ" ──────────────────────
const zlib = require('zlib');
/** { name: { shape, data: Float32Array | Uint8Array … } } for the arrays in an .npz buffer. */
function readNpz(buf) {
  // end of central directory
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not an .npz (zip) file');
  const n = buf.readUInt16LE(e + 10);
  let c = buf.readUInt32LE(e + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(c) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(c + 10), csize = buf.readUInt32LE(c + 20), nlen = buf.readUInt16LE(c + 28), xlen = buf.readUInt16LE(c + 30), clen = buf.readUInt16LE(c + 32), off = buf.readUInt32LE(c + 42);
    const name = buf.toString('utf8', c + 46, c + 46 + nlen).replace(/\.npy$/, '');
    c += 46 + nlen + xlen + clen;
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    const npy = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!npy) continue;
    out[name] = readNpy(npy);
  }
  return out;
}
function readNpy(b) {
  if (b.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('bad .npy');
  const major = b[6], hl = major >= 2 ? b.readUInt32LE(8) : b.readUInt16LE(8), h0 = major >= 2 ? 12 : 10;
  const header = b.toString('latin1', h0, h0 + hl);
  const descr = (header.match(/'descr':\s*'([^']+)'/) || [])[1];
  const shape = ((header.match(/'shape':\s*\(([^)]*)\)/) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  if (/True/.test((header.match(/'fortran_order':\s*(\w+)/) || [])[1] || '')) throw new Error('fortran-order arrays not supported');
  const body = Uint8Array.from(b.subarray(h0 + hl));
  const T = { '<f4': Float32Array, '<f8': Float64Array, '|b1': Uint8Array, '|u1': Uint8Array, '<i4': Int32Array, '<i8': null }[descr];
  if (!T) return { shape, descr, data: null };
  return { shape, descr, data: new T(body.buffer, 0, body.byteLength / T.BYTES_PER_ELEMENT) };
}
/** Kimodo NPZ → { frames (SOMA77 × [x,y,z]), footContacts } */
function kimodoFrames(buf) {
  const a = readNpz(buf);
  const pj = a.posed_joints;
  if (!pj || !pj.data || pj.shape.length !== 3 || pj.shape[2] !== 3) throw new Error('this .npz has no posed_joints (F × J × 3) — is it a Kimodo export?');
  const [F, NJ] = pj.shape;
  if (NJ !== 77 && NJ !== 30) throw new Error(`expected a SOMA skeleton (77 or 30 joints), got ${NJ} joints (use Kimodo-SOMA)`);
  const frames = [];
  for (let i = 0; i < F; i++) { const P = []; for (let j = 0; j < NJ; j++) { const o = (i * NJ + j) * 3; P.push([pj.data[o], pj.data[o + 1], pj.data[o + 2]]); } frames.push(P); }
  // global rotations (F × J × 3 × 3) make the keypoints exact; positions alone also work
  const gr = a.global_rot_mats;
  let rotations = null;
  if (gr?.data && gr.shape.length === 4 && gr.shape[0] === F && gr.shape[1] === NJ && gr.shape[2] === 3 && gr.shape[3] === 3) {
    rotations = [];
    for (let i = 0; i < F; i++) { const Rf = []; for (let j = 0; j < NJ; j++) { const o = (i * NJ + j) * 9; Rf.push([[gr.data[o], gr.data[o + 1], gr.data[o + 2]], [gr.data[o + 3], gr.data[o + 4], gr.data[o + 5]], [gr.data[o + 6], gr.data[o + 7], gr.data[o + 8]]]); } rotations.push(Rf); }
  }
  return { frames, rotations, jointNames: NJ === 77 ? SOMA77 : SOMA_MAP.soma30.names, footContacts: a.foot_contacts?.data ? Array.from(a.foot_contacts.data) : null };
}

/** Re-orient to y-up metres. */
function orient(frames, { upAxis = 'y', units = 'm' } = {}) {
  const k = units === 'cm' ? 0.01 : units === 'mm' ? 0.001 : 1;
  return frames.map((P) => P.map((p) => (upAxis === 'z' ? [p[0] * k, p[2] * k, -p[1] * k] : [p[0] * k, p[1] * k, p[2] * k])));
}

/**
 * Build MHR70 keypoints from a named joint set (pelvis, hips, knees, ankles,
 * feet/toes, spine, neck, head, shoulders, elbows, wrists, optional fingers).
 * Missing surface points are derived with fixed offsets in the bone frames.
 */
function fromNamed(get) {
  const need = (n) => { const p = get(n); if (!p) throw new Error(`source skeleton lacks "${n}"`); return p; };
  const P = new Array(70);
  const set = (n, p) => { P[J[n]] = p; };
  const lh = need('left_hip'), rh = need('right_hip'), neck = get('neck') || S.mid(need('left_shoulder'), need('right_shoulder'));
  const up = V.norm(V.sub(neck, S.mid(lh, rh)));
  const left = V.norm(V.sub(lh, rh));
  const fwd = V.norm(V.cross(left, up));
  set('left-hip', lh); set('right-hip', rh); set('neck', neck);
  const head = get('head') || V.add(neck, V.sc(up, 0.16));
  set('nose', V.add(V.add(head, V.sc(fwd, 0.1)), V.sc(up, -0.02)));
  set('left-eye', V.add(V.add(head, V.sc(fwd, 0.08)), V.add(V.sc(left, 0.033), V.sc(up, 0.02))));
  set('right-eye', V.add(V.add(head, V.sc(fwd, 0.08)), V.add(V.sc(left, -0.033), V.sc(up, 0.02))));
  set('left-ear', V.add(head, V.sc(left, 0.075))); set('right-ear', V.add(head, V.sc(left, -0.075)));
  for (const [s, sx] of [['left', 1], ['right', -1]]) {
    const hip = need(`${s}_hip`), knee = need(`${s}_knee`), ankle = need(`${s}_ankle`);
    set(`${s}-knee`, knee); set(`${s}-ankle`, ankle);
    const toe = get(`${s}_toe`) || get(`${s}_foot`) || V.add(ankle, V.sc(fwd, 0.14));
    let ffwd = V.sub(toe, ankle); ffwd[1] = 0; ffwd = V.norm(V.len(ffwd) > 1e-4 ? ffwd : fwd);
    const flat = V.norm(V.cross([0, 1, 0], ffwd)); // foot's left
    const sole = ankle[1] - 0.065;
    set(`${s}-heel`, [ankle[0] - ffwd[0] * 0.065, sole, ankle[2] - ffwd[2] * 0.065]);
    const tip = V.add(ankle, V.sc(ffwd, 0.17));
    set(`${s}-big-toe-tip`, [tip[0] - flat[0] * sx * 0.02, Math.min(toe[1], sole + 0.01), tip[2] - flat[2] * sx * 0.02]);
    set(`${s}-small-toe-tip`, [tip[0] + flat[0] * sx * 0.045 - ffwd[0] * 0.03, Math.min(toe[1], sole + 0.01), tip[2] + flat[2] * sx * 0.045 - ffwd[2] * 0.03]);
    const sh = need(`${s}_shoulder`), el = need(`${s}_elbow`), wr = need(`${s}_wrist`);
    set(`${s}-shoulder`, sh); set(`${s}-acromion`, V.add(sh, V.add(V.sc(left, sx * 0.02), V.sc(up, 0.02))));
    set(`${s}-elbow`, el); set(`${s}-wrist`, wr);
    const back = V.norm(V.add(V.norm(V.sub(sh, el)), V.norm(V.sub(wr, el))));
    set(`${s}-olecranon`, V.sub(el, V.sc(back, 0.03))); set(`${s}-cubital-fossa`, V.add(el, V.sc(back, 0.03)));
    // fingers: from the source if present, else a relaxed hand along the forearm
    const fore = V.norm(V.sub(wr, el));
    const handFwd = get(`${s}_hand`) ? V.norm(V.sub(get(`${s}_hand`), wr)) : fore;
    const palmN = V.norm(V.cross(handFwd, V.len(V.cross(handFwd, up)) > 1e-3 ? V.cross(handFwd, up) : left));
    const across = V.norm(V.cross(palmN, handFwd));
    for (const [f, off] of [['thumb', 0.03], ['index', 0.022], ['middle', 0.004], ['ring', -0.014], ['pinky', -0.03]]) {
      const src = ['third-joint', 'second-joint', 'first-joint', 'tip'].map((jn) => get(`${s}_${f}_${jn.replace('-joint', '')}`));
      if (src.every(Boolean)) { ['third-joint', 'second-joint', 'first-joint', 'tip'].forEach((jn, q) => set(`${s}-${f}-${jn}`, src[q])); continue; }
      let p = V.add(V.add(wr, V.sc(handFwd, f === 'thumb' ? 0.03 : 0.085)), V.sc(across, off * sx));
      let d = f === 'thumb' ? V.norm(V.add(handFwd, V.sc(across, 0.8 * sx))) : handFwd;
      set(`${s}-${f}-third-joint`, p);
      for (const [jn, len] of [['second-joint', 0.04], ['first-joint', 0.026], ['tip', 0.022]]) {
        d = V.norm(V.add(V.sc(d, 0.94), V.sc(palmN, 0.34)));
        p = V.add(p, V.sc(d, len)); set(`${s}-${f}-${jn}`, p);
      }
    }
  }
  return P;
}

/**
 * SOMA (Kimodo 77- or 30-joint) → MHR70 with the fitted map in kimodo-mhr70.json:
 * every keypoint is a weighted sum of joint positions + offsets turned by the
 * joint's global rotation, p = Σ w · (P[j] + R[j] · o). Fitted to Kimodo's own
 * skinned SOMA mesh through SAM 3D Body's keypoint regression: < 2 mm with the
 * exported rotations (global_rot_mats), ~0.5 cm (2 cm worst) from positions only.
 */
const SOMA_MAP = require('./kimodo-mhr70.json');
const SOMA_HINGE = { LeftArm: [0, -1, 0], RightArm: [0, 1, 0], LeftLeg: [1, 0, 0], RightLeg: [1, 0, 0] }; // elbow/knee axes in the bone frame
for (const k of ['soma77', 'soma30']) {
  const m = SOMA_MAP[k];
  m.children = m.names.map(() => []);
  m.parents.forEach((q, i) => { if (q >= 0) m.children[q].push(i); });
  m.hinge = m.names.map((n) => SOMA_HINGE[n] || null);
}
const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mulMV = (m, v) => [V.dot(m[0], v), V.dot(m[1], v), V.dot(m[2], v)];
const mulMM = (a, b) => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c]));
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function axisAngle(u, ang) {
  const cs = Math.cos(ang), si = Math.sin(ang), [x, y, z] = u, C = 1 - cs;
  return [[cs + x * x * C, x * y * C - z * si, x * z * C + y * si], [y * x * C + z * si, cs + y * y * C, y * z * C - x * si], [z * x * C - y * si, z * y * C + x * si, cs + z * z * C]];
}
/** Rotation taking direction a onto b. */
function rotBetween(a, b) {
  a = unit(a); b = unit(b);
  const v = V.cross(a, b), c = V.dot(a, b);
  if (c > 0.999999) return I3();
  if (c < -0.999999) { const p = unit(Math.abs(a[0]) < 0.9 ? V.cross(a, [1, 0, 0]) : V.cross(a, [0, 1, 0])); return [0, 1, 2].map((r) => [0, 1, 2].map((q) => 2 * p[r] * p[q] - (r === q ? 1 : 0))); }
  const k = 1 / (1 + c);
  return [[v[0] * v[0] * k + c, v[1] * v[0] * k - v[2], v[2] * v[0] * k + v[1]], [v[0] * v[1] * k + v[2], v[1] * v[1] * k + c, v[2] * v[1] * k - v[0]], [v[0] * v[2] * k - v[1], v[1] * v[2] * k + v[0], v[2] * v[2] * k + c]];
}
/** Best rotation R with R·a_i ≈ b_i (Horn's quaternion method, Jacobi eigen solve). */
function kabsch(A, B) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < A.length; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += A[i][r] * B[i][c];
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = M;
  const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz], [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
  const E = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += N[p][q] * N[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(N[p][q]) < 1e-15) continue;
      const th = (N[q][q] - N[p][p]) / (2 * N[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 4; k++) { const a = N[k][p], b = N[k][q]; N[k][p] = c * a - sn * b; N[k][q] = sn * a + c * b; }
      for (let k = 0; k < 4; k++) { const a = N[p][k], b = N[q][k]; N[p][k] = c * a - sn * b; N[q][k] = sn * a + c * b; }
      for (let k = 0; k < 4; k++) { const a = E[k][p], b = E[k][q]; E[k][p] = c * a - sn * b; E[k][q] = sn * a + c * b; }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (N[i][i] > N[best][best]) best = i;
  const [w, x, y, z] = [E[0][best], E[1][best], E[2][best], E[3][best]];
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
}
/** Global joint rotations from positions only (bone twist from the elbow/knee hinge plane). */
function estimateRots(P, m) {
  const R = new Array(P.length);
  for (let j = 0; j < P.length; j++) {
    const Rp = m.parents[j] >= 0 ? R[m.parents[j]] : I3();
    const kids = m.children[j].filter((c) => V.len(V.sub(m.rest[c], m.rest[j])) > 1e-4);
    if (kids.length >= 2) {
      const A = kids.map((c) => V.sub(m.rest[c], m.rest[j])), B = kids.map((c) => V.sub(P[c], P[j]));
      if (V.len(V.cross(unit(A[0]), unit(A[A.length - 1]))) > 0.05 || kids.length > 2) { R[j] = kabsch(A, B); continue; }
    }
    if (!kids.length) { R[j] = Rp; continue; }
    const c = kids[0];
    R[j] = mulMM(rotBetween(mulMV(Rp, V.sub(m.rest[c], m.rest[j])), V.sub(P[c], P[j])), Rp);
    const hinge = m.hinge[j], g = m.children[c][0];
    if (hinge && g != null) {
      const u = unit(V.sub(P[c], P[j])), f = unit(V.sub(P[g], P[c]));
      const n = V.cross(u, f), sn = V.len(n);
      if (sn > 0.1) {
        const want = unit(n), have = mulMV(R[j], hinge);
        const hp = unit(V.sub(have, V.sc(u, V.dot(have, u)))), wp = unit(V.sub(want, V.sc(u, V.dot(want, u))));
        const ang = Math.atan2(V.dot(V.cross(hp, wp), u), V.dot(hp, wp)) * Math.min(1, (sn - 0.1) / 0.15);
        R[j] = mulMM(axisAngle(u, ang), R[j]);
      }
    }
  }
  return R;
}
/** One SOMA frame (77 or 30 joints, + optional global rotations) → 70 MHR70 points. */
function somaToMHR70(P, R = null) {
  const m = P.length === 77 ? SOMA_MAP.soma77 : P.length === 30 ? SOMA_MAP.soma30 : null;
  if (!m) throw new Error(`SOMA frames need 77 or 30 joints, got ${P.length}`);
  const Rg = R ? R.map((r) => (r.length === 9 ? [r.slice(0, 3), r.slice(3, 6), r.slice(6, 9)] : r)) : estimateRots(P, m);
  return m.terms.map((terms) => {
    const out = [0, 0, 0];
    for (const [j, w, ox, oy, oz] of terms) {
      const q = mulMV(Rg[j], [ox, oy, oz]);
      out[0] += w * (P[j][0] + q[0]); out[1] += w * (P[j][1] + q[1]); out[2] += w * (P[j][2] + q[2]);
    }
    return out;
  });
}

function toMHR70(body) {
  if (!Array.isArray(body.frames) || body.frames.length < 4) throw new Error('frames: need at least 4');
  let frames = orient(body.frames, body);
  const skel = String(body.skeleton || 'mhr70').toLowerCase();
  if (skel === 'mhr70') {
    if (!frames.every((P) => P.length === 70)) throw new Error('mhr70 frames need 70 joints');
  } else if ((skel === 'soma' || skel === 'somaskel77' || skel === 'somaskel30') && frames.every((P) => P.length === 77 || P.length === 30)
    && (!body.jointNames || body.jointNames.join() === SOMA_MAP[frames[0].length === 77 ? 'soma77' : 'soma30'].names.join())) {
    // Kimodo's own joint order: the fitted map (rotations when given and y-up, else estimated)
    const rots = Array.isArray(body.rotations) && body.rotations.length === frames.length && (body.upAxis || 'y') === 'y' ? body.rotations : null;
    frames = frames.map((P, i) => somaToMHR70(P, rots ? rots[i] : null));
  } else {
    const names = body.jointNames || SKELETONS[skel]?.names;
    if (!names) throw new Error(`unknown skeleton "${skel}" — send jointNames`);
    const alias = SKELETONS[skel]?.alias || {};
    const idx = new Map(names.map((n, i) => [String(alias[n] || n).toLowerCase(), i]));
    frames = frames.map((P) => fromNamed((n) => { const i = idx.get(n); return i != null ? P[i] : null; }));
  }
  // feet on the floor (lowest heel/toe over the clip at y = 0)
  const low = Math.min(...frames.map((P) => Math.min(...['left-heel', 'right-heel', 'left-big-toe-tip', 'right-big-toe-tip'].map((n) => P[J[n]][1]))));
  return frames.map((P) => P.map((p) => [+p[0].toFixed(5), +(p[1] - low).toFixed(5), +p[2].toFixed(5)]));
}

module.exports = { toMHR70, somaToMHR70, fromNamed, orient, SKELETONS, SOMA77, readNpz, kimodoFrames };
