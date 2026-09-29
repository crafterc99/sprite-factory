"""Assembly: BODY master + HEAD / HAND detail donors → the high-detail unified character.

  blender -b -P assemble.py -- '{"body": ".../body.glb", "head": ".../head.glb", "hand_left": ..., "hand_right": ...,
                                  "height": 1.93, "forward": "+x", "out_blend": ..., "out_glb": ..., "report": ...}'

1. Body: faces +Z, feet on the floor, scaled to the character height.
2. Neck seam: the narrowest horizontal section between the shoulders and the jaw. Head landmarks
   (crown, nose tip, chin, ear extremes, back of the skull, neck centre) on both the body's head
   and the donor → similarity fit (Umeyama), refined by trimmed ICP. The donor keeps its own
   proportions: one uniform scale, fitted to the landmarks as a whole, never a bounding-box fit.
3. Wrists: each arm is traced down its slices (the outermost cluster beside the torso); the
   wrist is the narrowest forearm section. The donor hand's wrist (narrowest section along its
   long axis) is mapped onto it: wrist centre, arm direction, back-of-hand normal, wrist radius.
4. Cuts at the seam planes with 3 mm of overlap (the donor's rim ring-fitted to the body's): body below the neck / above the wrists,
   donors beyond the seam. The parts stay separate objects in the master (SOURCE_HIGH is never
   destroyed); the game-mesh stage fuses them into one welded surface (voxel remesh) and bakes.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import *

A = args()
reset()
report = {'inputs': {k: A.get(k) for k in ('body', 'head', 'hand_left', 'hand_right')}, 'warnings': []}
H = float(A.get('height') or 1.9)


def load(path, name, forward):
    ms, arm = import_model(path, name)
    if arm:                                     # a source master is geometry only
        for o in ms:
            for mod in list(o.modifiers):
                if mod.type == 'ARMATURE':
                    o.modifiers.remove(mod)
    o = join(ms, name)
    if arm:
        bpy.data.objects.remove(arm, do_unlink=True)
    normalize_orientation([o], forward)
    apply_transforms([o])
    return o


def sample(P, n=60000, seed=0):
    if len(P) <= n:
        return P
    return P[np.random.default_rng(seed).choice(len(P), n, replace=False)]


def ring_fit(obj, body_pts, center, axis, blend, band, rlim, bins=36):
    """Seam fitting: the donor's cross-section near the seam plane is reshaped, angle by angle, to
    the body's ring there (centre and per-angle radius), fading out over `blend` metres into the
    donor, so the two surfaces meet without a step. Returns the mean ring mismatch before / after (cm)."""
    axis = axis / np.linalg.norm(axis)
    e1 = np.cross(axis, [0, 0, 1.0] if abs(axis[2]) < 0.9 else [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(axis, e1)
    def ring(P):
        d = (P - center) @ axis
        rel = P - center - np.outer(d, axis)
        sel = (np.abs(d) < band) & (np.linalg.norm(rel, axis=1) < rlim)
        R = rel[sel]
        if len(R) < 30:
            return None, None
        c = R.mean(0); R = R - c
        th = np.arctan2(R @ e2, R @ e1); r = np.linalg.norm(R, axis=1)
        b = ((th + np.pi) / (2 * np.pi) * bins).astype(int) % bins
        rad = np.array([np.median(r[b == i]) if (b == i).sum() > 2 else np.nan for i in range(bins)])
        ok = ~np.isnan(rad)
        if ok.sum() < bins // 3:
            return None, None
        idx = np.arange(bins); rad = np.interp(idx, idx[ok], rad[ok], period=bins)
        # robust: a bin reaching another surface (the shirt hem beside a wrist, a braid beside the
        # neck) is pulled back to the ring's typical radius
        m = np.median(rad); rad = np.clip(rad, 0.7 * m, 1.3 * m)
        return c, rad
    V = verts_np(obj)
    cb, rb = ring(body_pts); cd, rd = ring(V)
    if cb is None or cd is None:
        return None
    before = float(np.mean(np.abs(rb - rd)) * 100 + np.linalg.norm(cb - cd) * 100)
    d = (V - center) @ axis
    zone = (d > -band * 2) & (d < blend)
    rel = V[zone] - center - np.outer(d[zone], axis) - cd
    r = np.linalg.norm(rel, axis=1)
    th = np.arctan2(rel @ e2, rel @ e1)
    x = (th + np.pi) / (2 * np.pi) * bins - 0.5
    k = np.clip(np.interp(x, np.arange(bins), rb / np.maximum(rd, 1e-5), period=bins), 0.8, 1.25)
    t = np.clip(d[zone] / blend, 0, 1); w = 1 - t * t * (3 - 2 * t)
    # the donor's cut edge tucks just inside the body (5 %), reaching full size 2 cm in: the fused
    # surface shows the body up to the seam and the donor after it, with no lip
    u = np.clip((d[zone] + 0.003) / 0.02, 0, 1); k = k * (0.985 + 0.015 * u * u * (3 - 2 * u))
    near = r < rlim * 1.3                                   # only the limb / neck surface, not hanging hair
    shift = (cb - cd)[None, :] + rel * (k - 1)[:, None]
    V[np.where(zone)[0][near]] += (w[near][:, None] * shift[near])
    set_verts_np(obj, V)
    _, rd2 = ring(V)
    after = float(np.mean(np.abs(rb - rd2)) * 100) if rd2 is not None else None
    return {'ring_mismatch_before_cm': round(before, 2), 'ring_mismatch_after_cm': round(after, 2) if after is not None else None}


# ── body ──
body = load(A['body'], 'BODY_HIGH', A.get('forward', '+x'))
floor_and_scale([body], H)
apply_transforms([body])
PB = verts_np(body)
# arms out (T-pose) when the figure is about as wide as it is tall
T_POSE_W = float(np.ptp(PB[:, 0]))
report['body'] = {'vertices': len(PB), 'triangles': tri_count(body), 'height': H, 'width': T_POSE_W}


def radius_profile(P, lo, hi, step, xlim=None):
    out = []
    for y in np.arange(lo, hi, step):
        sel = P[np.abs(P[:, 1] - y) < step * 0.75]
        if xlim is not None:
            sel = sel[np.abs(sel[:, 0] - np.median(sel[:, 0]) if len(sel) else 0) < xlim] if len(sel) else sel
        if len(sel) < 20:
            out.append((y, None, None)); continue
        c = np.median(sel, 0)
        r = np.median(np.hypot(sel[:, 0] - c[0], sel[:, 2] - c[2]))
        out.append((y, r, c))
    return out


def find_neck(P, lo, hi, xlim):
    prof = [(y, r, c) for y, r, c in radius_profile(P, lo, hi, (hi - lo) / 60, xlim) if r]
    y, r, c = min(prof, key=lambda t: t[1])
    return y, r, c


def head_landmarks(P, ys):
    """Crown, nose tip, chin, ears, back of skull, neck centre — in a +Z facing head above y = ys."""
    Hh = P[P[:, 1] > ys]
    top = Hh[:, 1].max(); hh = top - ys
    cx = np.median(Hh[:, 0])
    mid = Hh[np.abs(Hh[:, 0] - cx) < 0.025]
    def band(a, b): return mid[(mid[:, 1] > ys + a * hh) & (mid[:, 1] < ys + b * hh)]
    face = band(0.35, 0.75); nose = face[face[:, 2].argmax()]
    low = band(0.02, 0.35); chin = low[low[:, 2].argmax()]
    crown = Hh[Hh[:, 1].argmax()]
    eye = Hh[np.abs(Hh[:, 1] - nose[1]) < 0.06 * hh]
    earL = eye[eye[:, 0].argmax()]; earR = eye[eye[:, 0].argmin()]
    back = eye[eye[:, 2].argmin()]
    neck = np.median(P[np.abs(P[:, 1] - ys) < 0.02 * hh], 0)
    return np.array([crown, nose, chin, earL, earR, back, neck]), hh


# ── head ──
neck_y, neck_r, neck_c = find_neck(PB, 0.76 * H, 0.9 * H, 0.14 * H / 1.9)
# the narrowest section sits just under the jaw: the seam goes 2.5 cm lower, mid-neck, off the jawline
neck_y -= 0.025 * H / 1.9
report['neck'] = {'y': neck_y, 'radius': neck_r}
log(f'neck seam at y={neck_y:.3f} (radius {neck_r * 100:.1f} cm)')
parts = [body]
if A.get('head'):
    head = load(A['head'], 'HEAD_DONOR', A.get('forward', '+x'))
    PH = verts_np(head)
    lo, hi = PH[:, 1].min(), PH[:, 1].max()
    dy, dr, _ = find_neck(PH, lo + 0.04 * (hi - lo), lo + 0.6 * (hi - lo), None)
    Lb, hb = head_landmarks(PB, neck_y)
    Ld, hd = head_landmarks(PH, dy)
    M0 = umeyama(Ld, Lb)
    s0 = np.cbrt(np.linalg.det(M0[:3, :3]))
    # refine on the head surfaces (trimmed: hair and the donor's extra braids differ)
    src = sample(PH[PH[:, 1] > dy + 0.1 * hd], 8000) @ M0[:3, :3].T + M0[:3, 3]
    dst = sample(PB[PB[:, 1] > neck_y + 0.1 * hb])
    M1, rms = icp(src, dst, iters=40, scale=True, trim=0.7)
    M = M1 @ M0
    land_err = np.linalg.norm((Ld @ M[:3, :3].T + M[:3, 3]) - Lb, axis=1)
    transform_obj(head, M); apply_transforms([head])
    report['head'] = {'scale': float(np.cbrt(np.linalg.det(M[:3, :3]))), 'landmark_scale': float(s0), 'icp_rms_cm': rms * 100,
                      'landmark_error_cm': dict(zip(['crown', 'nose', 'chin', 'earL', 'earR', 'back', 'neck'], (land_err * 100).round(2).tolist())),
                      'donor_triangles': tri_count(head)}
    log(f'head: scale {report["head"]["scale"]:.3f}, ICP rms {rms * 100:.2f} cm, landmark error (cm) {report["head"]["landmark_error_cm"]}')
    if rms > 0.02:
        report['warnings'].append(f'head fit rms {rms * 100:.1f} cm: check the neck seam in the preview')
    # cuts: body keeps up to 1 cm above the seam, the donor from 1 cm below it
    def cut(o, keep):
        bm = bmesh.new(); bm.from_mesh(o.data)
        kill = [v for v in bm.verts if not keep(np.array(o.matrix_world @ v.co))]
        bmesh.ops.delete(bm, geom=kill, context='VERTS'); bm.to_mesh(o.data); bm.free(); o.data.update()
        return len(kill)
    hr = 0.14 * H / 1.9
    rb = cut(body, lambda p: not (p[1] > neck_y + 0.003 and abs(p[0] - neck_c[0]) < hr * 1.6))
    rh = cut(head, lambda p: p[1] > neck_y - 0.003)
    report['head']['cut'] = {'body_vertices_removed': rb, 'donor_vertices_removed': rh}
    report['head']['neck_ring'] = ring_fit(head, PB, np.array([neck_c[0], neck_y, neck_c[2]]), np.array([0, 1.0, 0]), 0.045, 0.004, neck_r * 1.8)
    log(f'neck ring fit: {report["head"]["neck_ring"]}')
    parts.append(head)
else:
    report['warnings'].append('no head donor: the body master\'s own head is used')


# ── hands ──
T_POSE = T_POSE_W > 0.7 * H
report['pose'] = 'T-pose' if T_POSE else 'arms down'
log('body pose:', report['pose'])
def trace_arm(P, side):
    """The arm as a chain of cross-sections from the shoulder outward: [(t, centre, radius, n)].
    A-pose / hanging arms: horizontal slices, the outermost x-cluster beside the torso. T-pose
    (arms out): slices across x beyond the shoulders, where only the arm is."""
    out = []
    if T_POSE:
        top = P[:, 1] > 0.55 * H
        far = P[:, 0].max() if side > 0 else -P[:, 0].min()
        for x in np.arange(0.14 * H, far, 0.006 * H):
            sl = P[top & (np.abs(side * P[:, 0] - x) < 0.004 * H)]
            if len(sl) < 8:
                continue
            c = sl.mean(0)
            r = float(np.percentile(np.linalg.norm((sl - c)[:, [1, 2]], axis=1), 90))
            out.append((x, c, r, len(sl)))
        return out
    for y in np.arange(0.78 * H, 0.36 * H, -0.006 * H):
        sl = P[(np.abs(P[:, 1] - y) < 0.004 * H) & (side * P[:, 0] > 0.02)]
        if len(sl) < 10:
            continue
        xs = np.sort(side * sl[:, 0])
        gaps = np.where(np.diff(xs) > 0.012)[0]
        start_ = xs[gaps[-1] + 1] if len(gaps) else None
        if start_ is None:
            if out:
                break
            continue
        arm = sl[side * sl[:, 0] >= start_]
        if len(arm) < 6:
            continue
        c = arm.mean(0)
        r = float(np.percentile(np.linalg.norm((arm - c)[:, [0, 2]], axis=1), 90))
        out.append((y, c, r, len(arm)))
    return out


def find_wrist(tr):
    """Narrowest section past the elbow, before the section widens into the hand (> 1.35× the
    narrowest so far): fingertips narrow again, so the minimum is not searched beyond the hand."""
    i0 = int(len(tr) * 0.45)
    best = i0
    for i in range(i0, len(tr)):
        if tr[i][2] < tr[best][2]:
            best = i
        elif tr[i][2] > 1.35 * tr[best][2] and i > best + 1:
            break
    return best


def hand_frame(P, wrist, axis, side):
    """Hand points beyond the wrist; palm normal = least-variance axis (sign resolved by the fit)."""
    d = (P - wrist) @ axis
    hp = P[(d > 0) & (d < 0.2 * H / 1.9) & (np.linalg.norm(P - wrist, axis=1) < 0.22 * H / 1.9) & ((side * (P[:, 0] - wrist[0]) > -0.05) | T_POSE)]
    if len(hp) < 30:
        return hp, None
    c, V, w = pca(hp)
    n = V[:, 2]; n = n - axis * (n @ axis); n /= np.linalg.norm(n)
    if n[0] * side < 0:
        n = -n
    return hp, n


for key, side in (('hand_left', 1), ('hand_right', -1)):
    tr = trace_arm(PB, side)
    info = {'traced_slices': len(tr)}
    report[key] = info
    if len(tr) < 8:
        report['warnings'].append(f'{key}: the arm could not be traced (touching the body?) — body hand kept')
        continue
    wi = find_wrist(tr)
    y_w, wrist, rw, _ = tr[wi]
    above = tr[max(0, wi - 6)][1]
    axis = wrist - above; axis /= np.linalg.norm(axis)
    info.update({'wrist': wrist, 'wrist_radius_cm': rw * 100, 'arm_axis': axis})
    log(f'{key}: wrist at {np.round(wrist, 3).tolist()}, radius {rw * 100:.1f} cm')
    if not A.get(key):
        report['warnings'].append(f'{key}: no donor — the body master\'s own hand is used')
        continue
    hand = load(A[key], key.upper() + '_DONOR', A.get('forward', '+x'))
    PHd = verts_np(hand)
    c, V, w = pca(PHd)
    ax = V[:, 0] if V[1, 0] < 0 else -V[:, 0]          # forearm (up) → fingers (down) in the reference
    t = (PHd - c) @ ax
    prof = []
    for tt in np.linspace(t.min() + 0.05 * np.ptp(t), t.min() + 0.55 * np.ptp(t), 40):
        r, cc = section_width(PHd, c, ax, tt, 0.012 * np.ptp(t))
        if r:
            prof.append((tt, r, cc))
    tw, rd, wd = min(prof, key=lambda p: p[1])
    hpd, nd = hand_frame(PHd, wd, ax, 1)
    nd = V[:, 2] - ax * (V[:, 2] @ ax); nd /= np.linalg.norm(nd)
    if nd[2] < 0:                                       # the reference shows the back of the hand (+Z after facing)
        nd = -nd
    hpb, nb = hand_frame(PB, wrist, axis, side)
    if nb is None:
        report['warnings'].append(f'{key}: body hand region not found — donor placed by the wrist only')
        nb = np.array([side, 0, 0.0]); nb -= axis * (nb @ axis); nb /= np.linalg.norm(nb)
    # scale: the hand's length (wrist → fingertips) matches the body's own hand; the wrist ring is
    # matched afterwards by the seam fit (a wrist-radius scale made the hands too big)
    Lb = float(((hpb - wrist) @ axis).max()) if len(hpb) > 50 else None
    Ld = float(((PHd - wd) @ ax).max())
    s_wrist = rw / rd
    s = float(np.clip(Lb / Ld, 0.75 * s_wrist, 1.25 * s_wrist)) if Lb else s_wrist
    info.update({'scale_from_length': (Lb / Ld) if Lb else None, 'scale_from_wrist': s_wrist, 'body_hand_length_cm': Lb * 100 if Lb else None})
    # the back-of-hand normal's sign is ambiguous on the body: both are tried, the one the ICP fits
    # best wins (a wrong choice would put the thumb on the wrong side)
    trials = []
    for sgn in (1, -1):
        nb2 = nb * sgn
        Fd = np.stack([ax, nd, np.cross(ax, nd)], 1); Fb = np.stack([axis, nb2, np.cross(axis, nb2)], 1)
        R = Fb @ Fd.T
        M = np.eye(4); M[:3, :3] = s * R; M[:3, 3] = wrist - s * R @ wd
        moved = PHd @ M[:3, :3].T + M[:3, 3]
        donor_hand = moved[((moved - wrist) @ axis) > 0]
        rms, ang, used = None, 0.0, False
        if len(hpb) > 50 and len(donor_hand) > 50:
            M1, rms = icp(sample(donor_hand, 6000), sample(hpb, 40000), iters=25, scale=False, trim=0.6)
            ang = float(np.degrees(np.arccos(np.clip((np.trace(M1[:3, :3]) - 1) / 2, -1, 1))))
            if ang < 20 and np.linalg.norm(M1[:3, 3]) < 0.03:
                M = M1 @ M; used = True
        trials.append((rms if rms is not None else 1e9, M, sgn, ang, used))
    rms, M, sgn, ang, used = min(trials, key=lambda x: x[0])
    info.update({'icp_rms_cm': rms * 100, 'icp_rotation_deg': ang, 'icp_used': used, 'palm_sign': sgn, 'palm_sign_rms_cm': [round(t[0] * 100, 2) for t in trials]})
    info.update({'scale': float(s), 'donor_wrist_radius_cm': rd / (1 if s == 0 else 1) * 100, 'donor_triangles': tri_count(hand)})
    transform_obj(hand, M); apply_transforms([hand])
    Pw = np.array(wrist)

    def cut(o, keep):
        bm = bmesh.new(); bm.from_mesh(o.data)
        kill = [v for v in bm.verts if not keep(np.array(o.matrix_world @ v.co))]
        bmesh.ops.delete(bm, geom=kill, context='VERTS'); bm.to_mesh(o.data); bm.free(); o.data.update()
        return len(kill)
    reach = 0.26 * H / 1.9
    info['body_vertices_removed'] = cut(body, lambda p: not (((p - Pw) @ axis) > 0.003 and np.linalg.norm(p - Pw) < reach and side * (p[0] - Pw[0]) > -0.045))
    info['donor_vertices_removed'] = cut(hand, lambda p: ((p - Pw) @ axis) > -0.003)
    info['wrist_ring'] = ring_fit(hand, PB, Pw, axis, 0.05, 0.004, rw * 1.6)
    log(f'{key}: wrist ring fit {info["wrist_ring"]}')
    parts.append(hand)
    log(f'{key}: donor scale {s:.3f}, ICP {info.get("icp_rms_cm", 0):.2f} cm')

for o in parts:
    report.setdefault('triangles', {})[o.name] = tri_count(o)
save_blend(A['out_blend'])
export_glb(A['out_glb'], parts)
write_json(A['report'], report)
log('assembled:', ', '.join(f'{o.name} {tri_count(o)} tris' for o in parts))
