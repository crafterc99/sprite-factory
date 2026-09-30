"""
Build a loose garment for a game rig (MHR kind): a separate skinned part that fits the rig's bind
body, with real openings, UVs, skin weights from the body, a hidden-body face list and a coarse
grid for the in-game cloth motion.

  python build_garment.py <rig.json.gz> --garment shorts|jersey|tee --out <dir> [--params '{...}']

The garment is lofted from the body's own cross-sections (so it fits any character built on the
game skeleton), eased out by a looseness profile and hung straight below its widest point, as
fabric falls. Output: <out>/<garment>.npz (the grid mesh) + <out>/<garment>.json (report); the
game file is written by pack_outfit.py after texturing.
"""
import argparse, json, math, os, re, sys
import numpy as np
from scipy.spatial import cKDTree, ConvexHull

sys.path.insert(0, os.path.dirname(__file__))
from rigio import load_rig, part_arrays, joints
import tee_shape

ap = argparse.ArgumentParser()
ap.add_argument('rig')
ap.add_argument('--garment', required=True, choices=['shorts', 'jersey', 'tee'])
ap.add_argument('--pose', default=None, help='a game pose (export_pose.mjs): drape in it, not in the A-pose')
ap.add_argument('--blender', default=os.environ.get('BLENDER_BIN', '/Applications/Blender.app/Contents/MacOS/Blender'))
ap.add_argument('--out', required=True)
ap.add_argument('--params', default='{}')
ap.add_argument('--over', default=None, help='npz of a garment this one is worn over')
a = ap.parse_args()
PRM = json.loads(a.params)
os.makedirs(a.out, exist_ok=True)

R = load_rig(a.rig)
NAMES, J, PARENTS = joints(R)
BODY = part_arrays(R['parts'][0])
V = BODY['V'].astype(np.float64)
F = BODY['F']
NB = BODY['N'].astype(np.float64) if BODY['N'] is not None else None
DOM = BODY['SI'][np.arange(len(V)), BODY['SW'].argmax(1)]
DN = np.array(NAMES)[DOM]


def region_of(n):
    if re.match(r'^[lr]_(uparm|lowarm|wrist|thumb|index|middle|ring|pinky)', n): return 'arm_' + n[0]
    if re.match(r'^[lr]_(upleg|lowleg|foot|talocrural|subtalar|transversetarsal|ball)', n): return 'leg_' + n[0]
    if re.match(r'^[lr]_clavicle', n): return 'clav_' + n[0]
    if re.match(r'^c_neck', n): return 'neck'
    if re.match(r'^(c_head|c_jaw|c_teeth|c_tongue|[lr]_eye|c_head_null)', n): return 'head'
    return 'torso'


VREG = np.array([region_of(n) for n in DN])
# a triangle's region: its vertices' majority (ties: the first vertex)
TREG = VREG[F[:, 0]].copy()
for k in (1, 2):
    same = VREG[F[:, k]] == VREG[F[:, (k + 1) % 3]]
    TREG[same] = VREG[F[same, k]]

if NB is None:
    NB = np.zeros_like(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    for k in range(3): np.add.at(NB, F[:, k], fn)
NB /= np.maximum(1e-12, np.linalg.norm(NB, axis=1, keepdims=True))
BODY_TREE = cKDTree(V)
# garments collide with the body, not the hair / head (dreads lie on top of a jersey)
NOHEAD = np.where(VREG != 'head')[0]
COLL_TREE = cKDTree(V[NOHEAD])


def tri_mask(regs):
    return np.isin(TREG, list(regs))


def cut(p0, n, mask):
    """Points where the plane (p0, n) crosses the masked body triangles."""
    d = (V - p0) @ n
    T = F[mask]
    dt = d[T]
    out = []
    for i0, i1 in ((0, 1), (1, 2), (2, 0)):
        a0, a1 = dt[:, i0], dt[:, i1]
        m = a0 * a1 < 0
        t = a0[m] / (a0[m] - a1[m])
        out.append(V[T[m, i0]] + t[:, None] * (V[T[m, i1]] - V[T[m, i0]]))
    return np.concatenate(out) if out else np.zeros((0, 3))


def radial(P2, c, phis):
    """Distance from c to the convex hull of the 2-D points along each direction phi."""
    h = ConvexHull(P2)
    poly = P2[h.vertices]
    E0, E1 = poly, np.roll(poly, -1, 0)
    e = E1 - E0
    w = E0 - c
    d = np.stack([np.cos(phis), np.sin(phis)], 1)
    den = -d[:, None, 0] * e[None, :, 1] + d[:, None, 1] * e[None, :, 0]
    den = np.where(np.abs(den) < 1e-12, 1e-12, den)
    t = (-w[None, :, 0] * e[None, :, 1] + w[None, :, 1] * e[None, :, 0]) / den
    u = (d[:, None, 0] * w[None, :, 1] - d[:, None, 1] * w[None, :, 0]) / den
    ok = (u >= -1e-9) & (u <= 1 + 1e-9) & (t > 0)
    return np.where(ok, t, np.inf).min(1)


def hull_poly(P2):
    """The convex hull of 2-D points as a counter-clockwise polygon."""
    return P2[ConvexHull(P2).vertices]


def bparam(poly, p):
    """Arc-length coordinate of the boundary point nearest p (counter-clockwise from vertex 0)."""
    E0, E1 = poly, np.roll(poly, -1, 0)
    e = E1 - E0
    L = np.linalg.norm(e, axis=1)
    t = np.clip(np.einsum('ij,ij->i', p - E0, e) / np.maximum(1e-12, L ** 2), 0, 1)
    d = np.linalg.norm(E0 + t[:, None] * e - p, axis=1)
    k = int(np.argmin(d))
    return float(np.concatenate([[0], np.cumsum(L)])[k] + t[k] * L[k])


def at_param(poly, s):
    E0, E1 = poly, np.roll(poly, -1, 0)
    L = np.linalg.norm(E1 - E0, axis=1)
    S = np.concatenate([[0], np.cumsum(L)])
    s = np.mod(s, S[-1])
    k = np.clip(np.searchsorted(S, s, 'right') - 1, 0, len(L) - 1)
    t = (s - S[k]) / np.maximum(1e-12, L[k])
    return E0[k] + t[:, None] * (E1[k] - E0[k])


def ray_hit(poly, c, phi):
    return float(radial(poly, c, np.array([phi]))[0])


def offset_path(poly, s0, s1, n, ease, taper=0.0):
    """n points along the boundary from s0 to s1 (counter-clockwise), pushed out by `ease` along the
    outward normal (tapered to 0 over the first / last `taper` fraction), resampled evenly."""
    per = np.linalg.norm(np.roll(poly, -1, 0) - poly, axis=1).sum()
    if s1 <= s0 + 1e-9: s1 += per
    ss = np.linspace(s0, s1, 480)
    P = at_param(poly, ss)
    tg = np.gradient(P, axis=0)
    tg /= np.maximum(1e-12, np.linalg.norm(tg, axis=1, keepdims=True))
    nr = np.stack([tg[:, 1], -tg[:, 0]], 1)
    f = np.linspace(0, 1, len(ss))
    w = np.ones_like(f) if taper <= 0 else np.clip(np.minimum(f, 1 - f) / taper, 0, 1)
    P = P + nr * (ease * w)[:, None]
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    S = np.concatenate([[0], np.cumsum(seg)])
    st = np.linspace(0, S[-1], n)
    return np.stack([np.interp(st, S, P[:, 0]), np.interp(st, S, P[:, 1])], 1)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def push_out(P, clearance, iters=2):
    """Move garment points that sit inside the body (or closer than `clearance`) out along the body normal."""
    for _ in range(iters):
        d, i = COLL_TREE.query(P, k=4); i = NOHEAD[i]
        # the body surface near p: the nearest vertices' points and normals
        n = NB[i].mean(1); n /= np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))
        s = np.einsum('ij,ij->i', P - V[i[:, 0]], n)
        m = s < clearance
        P[m] += (clearance - s[m])[:, None] * n[m]
    return P


def winding(P):
    """Generalized winding number of points w.r.t. the body surface (> 0.5: inside)."""
    out = np.zeros(len(P))
    A_, B_, C_ = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    for s in range(0, len(P), 48):
        p = P[s:s + 48, None, :]
        a_, b_, c_ = A_[None] - p, B_[None] - p, C_[None] - p
        la, lb, lc = np.linalg.norm(a_, axis=2), np.linalg.norm(b_, axis=2), np.linalg.norm(c_, axis=2)
        det = np.einsum('ijk,ijk->ij', a_, np.cross(b_, c_))
        den = la * lb * lc + np.einsum('ijk,ijk->ij', a_, b_) * lc + np.einsum('ijk,ijk->ij', b_, c_) * la + np.einsum('ijk,ijk->ij', c_, a_) * lb
        out[s:s + 48] = np.arctan2(det, den).sum(1) / (2 * np.pi)
    return out


def resolve_faces(TV, TF, clearance, iters=6):
    """Faces (not just vertices) must stay clear of the body: sample each face (centroid + edge
    midpoints); a sample confirmed inside the body (winding number), or outside but closer than
    `clearance`, pushes that face's vertices out along the body normal."""
    T0 = TV.copy()
    for _ in range(iters):
        A, B, Cc = TV[TF[:, 0]], TV[TF[:, 1]], TV[TF[:, 2]]
        moved = 0
        for S in ((A + B + Cc) / 3, (A + B) / 2, (B + Cc) / 2, (Cc + A) / 2):
            d, i = COLL_TREE.query(S, k=4); i = NOHEAD[i]
            n = NB[i].mean(1); n /= np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))
            sd = np.einsum('ij,ij->i', S - V[i[:, 0]], n)
            cand = np.where((sd < clearance) & (d[:, 0] < 0.05))[0]
            if not len(cand): continue
            inside = winding(S[cand]) > 0.5
            amt = np.where(inside, clearance - sd[cand], np.maximum(0, clearance - d[cand, 0]))
            keep = amt > 1e-4
            cand, amt = cand[keep], amt[keep]
            if not len(cand): continue
            push = np.zeros_like(TV); cnt = np.zeros(len(TV))
            for k in range(3):
                np.add.at(push, TF[cand, k], amt[:, None] * n[cand])
                np.add.at(cnt, TF[cand, k], 1)
            nz = cnt > 0
            TV[nz] += push[nz] / cnt[nz, None]
            moved += len(cand)
        # a face pass only nudges (a large move means a bad reading, not a real penetration)
        dv = TV - T0; L = np.linalg.norm(dv, axis=1); cap = 0.025
        big = L > cap
        TV[big] = T0[big] + dv[big] * (cap / L[big])[:, None]
        if not moved: break
    return TV

def grid_smooth(G, fixed, iters, lam=0.35, wrap=True):
    """Laplacian smoothing on a (rows, cols, 3) grid; `fixed` (rows, cols) nodes stay put."""
    for _ in range(iters):
        A = G.copy()
        up = np.roll(G, 1, 0); dn = np.roll(G, -1, 0)
        up[0] = G[0]; dn[-1] = G[-1]
        lf = np.roll(G, 1, 1); rt = np.roll(G, -1, 1)
        if not wrap:
            lf[:, 0] = G[:, 0]; rt[:, -1] = G[:, -1]
        avg = (up + dn + lf + rt) / 4
        A = G + lam * (avg - G)
        # the first / last rows (hems) smooth along the row only
        A[0] = G[0] + lam * ((lf[0] + rt[0]) / 2 - G[0])
        A[-1] = G[-1] + lam * ((lf[-1] + rt[-1]) / 2 - G[-1])
        A[fixed] = G[fixed]
        G = A
    return G


PROXY_STEP = 3


# ═══ shorts: two leg pieces joined at the centre-front / centre-back seams above the crotch ═══
def build_shorts(P):
    s_ = PROXY_STEP
    y_w = J['root'][1] + P.get('waist', 0.035)                   # waistband top (sits on the hips)
    y_h = J['l_lowleg'][1] - P.get('belowKnee', 0.025)            # hem: just below the knee
    mid = np.abs(V[:, 0]) < 0.015
    y_cb = V[mid & (V[:, 1] > J['l_lowleg'][1] + 0.1) & (V[:, 1] < J['root'][1] + 0.1), 1].min()   # body crotch
    y_c = y_cb - P.get('crotchDrop', 0.045)                       # the garment's crotch hangs lower
    y_r = y_cb + 0.10
    ease_w, ease_hip, ease_crotch, ease_hem = P.get('easeWaist', 0.008), P.get('easeHip', 0.03), P.get('easeCrotch', 0.04), P.get('easeHem', 0.075)
    M = P.get('halfCols', 30)                                     # columns across the outer half (multiple of the proxy step)
    dy = P.get('rowStep', 0.012)
    n_u = max(2, int(round((y_w - y_c) / dy / s_))) * s_          # rows (as proxy multiples) waist → crotch
    n_l = max(2, int(round((y_c - y_h) / dy / s_))) * s_          #                       crotch → hem
    ys = np.concatenate([np.linspace(y_w, y_c, n_u + 1), np.linspace(y_c, y_h, n_l + 1)[1:]])
    iu_last = n_u                                                 # the crotch row (last U row)
    trunk = tri_mask({'torso', 'leg_l', 'leg_r'})
    # centre-front / centre-back seam curves (x = 0), eased, converging on the crotch point
    def midline(y):
        Q = cut(np.array([0, y, 0.]), np.array([0, 1., 0]), trunk)
        Q = Q[np.abs(Q[:, 0]) < 0.02]
        return (Q[:, 2].max(), Q[:, 2].min()) if len(Q) else (None, None)
    zf_r, zb_r = midline(y_r)
    z_c = (zf_r + zb_r) / 2
    def ease_at(y):
        if y >= y_c:
            t = (y_w - y) / max(1e-6, y_w - y_c)
            return ease_w + (ease_hip - ease_w) * smoothstep(0, 0.35, t) + (ease_crotch - ease_hip) * smoothstep(0.5, 1, t)
        return ease_crotch + (ease_hem - ease_crotch) * smoothstep(0, 1, (y_c - y) / (y_c - y_h))
    def seams(y):
        if y >= y_r:
            zf, zb = midline(y)
            e = ease_at(y)
            return zf + e, zb - e
        t = np.clip((y - y_c) / (y_r - y_c), 0, 1)
        k = math.sqrt(max(0.0, 1 - (1 - t) ** 2))
        e = ease_at(y_r)
        return z_c + (zf_r + e - z_c) * k, z_c + (zb_r - e - z_c) * k

    def piece(side):
        leg = tri_mask({'leg_' + ('l' if side > 0 else 'r'), 'torso'})
        G = np.zeros((len(ys), 2 * M + 1, 3))
        prev, prev_c = None, None
        for i, y in enumerate(ys):
            Q = cut(np.array([0, y, 0.]), np.array([0, 1., 0]), leg if y < y_cb - 0.005 else trunk)
            Q = Q[Q[:, 0] * side > -0.002]
            X = np.stack([Q[:, 0] * side, Q[:, 2]], 1)                 # this side, mirrored to +x
            if i <= iu_last:
                zf, zb = seams(y)
                pts = np.concatenate([X[X[:, 0] > 0.0005], [[0, zf], [0, zb]]])
                poly = hull_poly(pts)
                s0, s1 = bparam(poly, np.array([0, zb])), bparam(poly, np.array([0, zf]))
                O = offset_path(poly, s0, s1, M + 1, ease_at(y), taper=0.12)
                O[0] = [0, zb]; O[-1] = [0, zf]
                # inner half: on the midline between the seams (inside the trunk; its faces are dropped)
                tt = np.linspace(0, 1, M + 1)[1:-1]
                I = np.stack([np.zeros(M - 1), zf + (zb - zf) * tt], 1)
                row = np.concatenate([O, I, O[:1]])
                prev = None
            else:
                Xl = X[X[:, 0] > 0.0]
                poly = hull_poly(Xl)
                c = poly.mean(0)
                sb = bparam(poly, c + ray_hit(poly, c, -np.pi / 2) * np.array([0, -1.]))
                sf = bparam(poly, c + ray_hit(poly, c, np.pi / 2) * np.array([0, 1.]))
                O = offset_path(poly, sb, sf, M + 1, ease_at(y))
                In = offset_path(poly, sf, sb, M + 1, ease_at(y))[1:-1]
                row = np.concatenate([O, In, O[:1]])
                if prev is not None:                                        # fabric hangs: no narrowing below
                    r0 = np.linalg.norm(prev - prev_c, axis=1); r1 = np.linalg.norm(row - c, axis=1)
                    need = r0 - 0.002
                    k = r1 < need
                    row[k] = c + (row[k] - c) * (need[k] / np.maximum(1e-9, r1[k]))[:, None]
                prev, prev_c = row.copy(), c
                row[:, 0] = np.maximum(row[:, 0], 0.004)                    # never across the midline
            if not np.all(np.isfinite(row)):
                raise RuntimeError(f'non-finite garment row {i} at y={y:.3f}')
            G[i, :, 0] = row[:, 0] * side
            G[i, :, 1] = y
            G[i, :, 2] = row[:, 1]
        return G

    pieces = []
    for side in (1, -1):
        G = piece(side)
        fixed = np.zeros(G.shape[:2], bool)
        fixed[:iu_last + 1, 0] = True; fixed[:iu_last + 1, M] = True          # the seams
        fixed[:iu_last + 1, M:] = True                                        # the dropped inner half
        fixed[0] = True
        body = G[:, :-1]
        fb = fixed[:, :-1]
        body = grid_smooth(body, fb, 6)
        # a loose leg's silhouette is smooth top to bottom: extra smoothing along the columns
        for _ in range(PRM.get('verticalSmooth', 30)):
            up, dn = body[:-2], body[2:]
            mid = body[1:-1] + 0.45 * ((up + dn) / 2 - body[1:-1])
            keep = fb[1:-1]
            body[1:-1] = np.where(keep[..., None], body[1:-1], mid)
        G = np.concatenate([body, body[:, :1]], 1)
        pieces.append(G)
    info = {'y_waist': y_w, 'y_hem': y_h, 'y_crotchBody': float(y_cb), 'y_crotch': y_c, 'rows': len(ys), 'halfCols': M, 'crotchRow': iu_last}
    return pieces, iu_last, M, info


# ═══ jersey: one tube around the torso, lofted along meridians from the hem over the shoulders ═══
def build_jersey(P):
    s_ = PROXY_STEP
    y_top = J['c_neck'][1] - 0.005                                  # neck base
    y_hem = P.get('hemY', J['root'][1] - P.get('belowWaist', 0.075))   # over the hips
    C = P.get('cols', 96)
    Rn = P.get('rows', 72)
    torso = tri_mask({'torso', 'clav_l', 'clav_r', 'leg_l', 'leg_r'})
    chest = cut(np.array([0, (J['c_spine2'][1] + J['c_spine3'][1]) / 2, 0.]), np.array([0, 1., 0]), tri_mask({'torso'}))
    z_ax = float((chest[:, 2].max() + chest[:, 2].min()) / 2)
    c3 = np.array([0, 0, z_ax])
    phis = np.linspace(0, 2 * np.pi, C + 1)[:-1]
    ease_sh, ease_ch, ease_hem = P.get('easeShoulder', 0.006), P.get('easeChest', 0.022), P.get('easeHem', 0.055)
    y_sh = J['l_uparm'][1] - 0.03
    y_ch = (J['c_spine2'][1] + J['c_spine3'][1]) / 2
    def ease(y):
        if y >= y_sh: return ease_sh
        if y >= y_ch: return ease_ch + (ease_sh - ease_ch) * smoothstep(y_ch, y_sh, y)
        return ease_ch + (ease_hem - ease_ch) * smoothstep(y_ch, y_hem, y)
    G = np.zeros((Rn, C, 3))
    for k, ph in enumerate(phis):
        d = np.array([math.cos(ph), 0, math.sin(ph)])
        n = np.array([-math.sin(ph), 0, math.cos(ph)])
        Q = cut(c3, n, torso)
        rr = (Q - c3) @ d
        m = (rr > 0) & (Q[:, 1] >= y_hem) & (Q[:, 1] <= y_top)
        pts = np.stack([rr[m], Q[m, 1]], 1)
        pts = np.concatenate([pts, [[0, y_hem], [0, y_top]]])
        h = ConvexHull(pts)
        hv = list(h.vertices)                                        # counter-clockwise
        i0 = next(i for i, v in enumerate(hv) if np.allclose(pts[v], [0, y_hem]))
        hv = hv[i0:] + hv[:i0]
        path = [pts[v] for v in hv]
        i1 = next(i for i, p in enumerate(path) if np.allclose(p, [0, y_top]))
        # the cloth runs from the hem corner (the hull's bottom edge along the axis is not cloth) up
        # over the shoulder to the axis; below the corner it drops straight to a level hem
        path = np.array(path[1:i1 + 1])
        if path[0, 1] > y_hem + 1e-4:
            path = np.concatenate([[[path[0, 0], y_hem]], path])
        seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
        s = np.concatenate([[0], np.cumsum(seg)])
        ss = np.linspace(0, s[-1], 400)
        dp = np.stack([np.interp(ss, s, path[:, 0]), np.interp(ss, s, path[:, 1])], 1)
        tg = np.gradient(dp, axis=0); tg /= np.maximum(1e-12, np.linalg.norm(tg, axis=1, keepdims=True))
        tg[0] = tg[1]
        nr = np.stack([tg[:, 1], -tg[:, 0]], 1)                         # outward (ccw hull)
        e = np.array([ease(y) for y in dp[:, 1]])
        off = dp + nr * e[:, None]
        off[:, 1] = np.maximum(off[:, 1], y_hem)                           # nothing below the hem
        off[0, 1] = y_hem
        # (a monotone climb below the chest: the hem region never folds back down)
        lo = off[:, 1] < y_ch
        off[lo, 1] = np.maximum.accumulate(off[:, 1])[lo]
        seg = np.linalg.norm(np.diff(off, axis=0), axis=1)
        s = np.concatenate([[0], np.cumsum(seg)])
        st = np.linspace(0, s[-1], Rn)
        r_ = np.interp(st, s, off[:, 0]); y_ = np.interp(st, s, off[:, 1])
        G[:, k] = c3 + r_[:, None] * d[None] + np.stack([np.zeros(Rn), y_, np.zeros(Rn)], 1) - np.array([0, 0, 0])
        G[:, k, 1] = y_
    fixed = np.zeros(G.shape[:2], bool); fixed[0] = False
    G = grid_smooth(G, fixed, 4)
    info = {'y_hem': y_hem, 'y_top': y_top, 'axisZ': z_ax, 'rows': Rn, 'cols': C}
    return G, info


def jersey_holes(G):
    """Per-face (quad) hole mask for a jersey grid: neck opening + armholes, from body landmarks."""
    Rn, C = G.shape[:2]
    Qc = (G[:-1, :] + G[1:, :] + np.roll(G[:-1, :], -1, 1) + np.roll(G[1:, :], -1, 1)) / 4   # quad centres
    x, y, z = Qc[..., 0], Qc[..., 1], Qc[..., 2]
    # neck: the neck's own radius just above its base, plus room; a U scoop at the front, a
    # shallow curve at the back; the straps run between the neckline and the armholes
    # (the neck column above the trapezius slope, below the jaw)
    nk = cut(np.array([0, J['c_neck'][1] + 0.06, 0]), np.array([0, 1., 0]), tri_mask({'neck', 'torso', 'clav_l', 'clav_r'}))
    nk = nk[np.abs(nk[:, 0]) < 0.11]
    zc = (nk[:, 2].max() + nk[:, 2].min()) / 2
    r_neck = max(nk[:, 0].max(), -nk[:, 0].min())
    r_nh = r_neck + PRM.get('neckRoom', 0.015)
    w = PRM.get('necklineHalfWidth', r_nh + 0.005)
    y0 = J['c_neck'][1]
    y_front = y0 - PRM.get('frontScoop', 0.10)
    y_back = y0 - PRM.get('backScoop', 0.025)
    ux = np.clip(np.abs(x) / w, 0, 1)
    rxz = np.hypot(x, (z - zc) / 1.1)
    frontside = z > zc
    y_nl = np.where(frontside, y_front + (y0 + 0.02 - y_front) * ux ** 2.2, y_back + (y0 + 0.02 - y_back) * ux ** 2.2)
    neck = (rxz < r_nh) | ((np.abs(x) < w) & (y > y_nl))
    # armholes: the side of the torso around the arm root, reaching in to leave shoulder straps
    holes = neck.copy()
    arm_pit = PRM.get('armpitY')
    for sd in ('l', 'r'):
        S = J[sd + '_uparm']
        armv = np.isin(VREG, ['arm_' + sd]); torv = np.isin(VREG, ['torso', 'clav_' + sd])
        dd, _ = cKDTree(V[torv]).query(V[armv])
        junction = V[armv][dd < 0.012]
        pit = arm_pit or float(junction[:, 1].min())
        bottom = pit - PRM.get('armholeDrop', 0.075)
        Cy, ay = S[1] + 0.02, S[1] + 0.02 - bottom
        cz = cut(np.array([0, pit, 0]), np.array([0, 1., 0]), tri_mask({'torso'}))
        Cz = (cz[:, 2].max() + cz[:, 2].min()) / 2
        az = PRM.get('armholeDepth', 0.125)
        xref, ax = abs(S[0]) - 0.004, PRM.get('armholeIn', 0.026)
        sx = x * (1 if sd == 'l' else -1)
        q = ((y - Cy) / ay) ** 2 + ((z - Cz) / az) ** 2 + (np.maximum(0, xref - sx) / ax) ** 2
        holes |= (q < 1) & (sx > 0.02)
    return holes


def build():
    P = PRM
    if a.garment == 'tee':
        TV0, TF0, info = tee_shape.build_tee_surface(V, F, NB, DN, J, P, a.blender, log=lambda m: print(m, file=sys.stderr))
        # the side seam follows the body's mid-plane: the torso's (per height) or the arm's axis
        tz = VREG == 'torso'
        ybins = np.linspace(V[:, 1].min(), V[:, 1].max(), 120)
        zmid = np.array([np.median(V[tz & (np.abs(V[:, 1] - yb) < 0.02), 2]) if (tz & (np.abs(V[:, 1] - yb) < 0.02)).any() else np.nan for yb in ybins])
        ok = np.isfinite(zmid)
        zmid = np.interp(ybins, ybins[ok], zmid[ok])
        lab = tee_shape.labels_of(DN)
        def zref(X):
            _, i = BODY_TREE.query(X)
            z = np.interp(X[:, 1], ybins, zmid)
            for sd in 'lr':
                m = lab[i] == 'uparm_' + sd
                A_ = info['arms'][sd]
                s = (X[m] - A_['S']) @ np.array(A_['a'])
                z[m] = A_['S'][2] + s * A_['a'][2]
            return z
        Vt, UV, Ft, uvinfo = tee_shape.tee_uv(TV0, TF0, info, zref)
        info['uv'] = uvinfo
        return Vt, UV, Ft, None, None, info, {}
    if a.garment == 'shorts':
        pieces, iu, M, info = build_shorts(P)
        # faces per piece: drop the inner half above the crotch
        verts, faces, uvs, gid = [], [], [], []
        for pi, G in enumerate(pieces):
            rows, cols = G.shape[:2]
            base = sum(len(v) for v in verts)
            verts.append(G.reshape(-1, 3))
            u = np.tile(np.linspace(0, 1, cols), (rows, 1)) * 0.5 + 0.5 * pi
            yy = G[:, :, 1]
            v = (info['y_waist'] - yy) / (info['y_waist'] - info['y_hem'])
            uvs.append(np.stack([u, v], -1).reshape(-1, 2))
            ii, jj = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
            gid.append(np.stack([np.full(rows * cols, pi), ii.ravel(), jj.ravel() % (cols - 1)], 1))
            for i in range(rows - 1):
                for j in range(cols - 1):
                    if i + 1 <= iu and j >= M: continue
                    a0, a1, b0, b1 = base + i * cols + j, base + i * cols + j + 1, base + (i + 1) * cols + j, base + (i + 1) * cols + j + 1
                    # outward winding (the right piece is mirrored)
                    if pi == 0: faces += [[a0, a1, b0], [a1, b1, b0]]
                    else: faces += [[a0, b0, a1], [a1, b0, b1]]
        grids = [dict(rows=G.shape[0], C=G.shape[1] - 1) for G in pieces]
        pin_rows = {'top': 0, 'crotch': iu}
    else:
        G, info = build_jersey(P)
        holes = jersey_holes(G)
        rows, C = G.shape[:2]
        half = C // 2
        # two UV panels (front | back), planar-projected so prints read straight; the side columns
        # (0 and C/2) exist in both panels with that panel's UV
        x, y, z = G[..., 0], G[..., 1], G[..., 2]
        W = np.abs(x).max() * 1.04
        ytop, yb = y.max() + 0.005, info['y_hem']
        verts, uvs, gid = [], [], []
        index = {}
        def rv(i, j, panel):
            jj = j % C
            k = (i, jj, panel)
            if k not in index:
                index[k] = len(verts)
                p = G[i, jj]
                verts.append(p)
                u = 0.25 + 0.245 * p[0] / W if panel == 0 else 0.75 - 0.245 * p[0] / W
                uvs.append([u, (ytop - p[1]) / (ytop - yb)])
                gid.append([0, i, jj])
            return index[k]
        faces = []
        for i in range(rows - 1):
            for j in range(C):
                if holes[i, j]: continue
                panel = 0 if j < half else 1
                a0, a1, b0, b1 = rv(i, j, panel), rv(i, j + 1, panel), rv(i + 1, j, panel), rv(i + 1, j + 1, panel)
                faces += [[a0, b0, a1], [a1, b0, b1]]          # outward (columns run +x → +z, rows up)
        verts, uvs, gid = [np.array(verts)], [np.array(uvs)], [np.array(gid)]
        grids = [dict(rows=rows, C=C)]
        pin_rows = {}
        info['holes'] = int(holes.sum())
    Vt = np.concatenate(verts)
    UV = np.concatenate(uvs)
    GID = np.concatenate(gid)
    Ft = np.array(faces, np.int64)
    return Vt, UV, Ft, GID, grids, info, pin_rows


Vt, UV, Ft, GID, GRIDS, INFO, PIN_ROWS = build()

# ── clean: drop degenerate faces and unused vertices; topology welds (same position) for normals /
# weights / cloth, while the render mesh keeps its UV splits
e1 = Vt[Ft[:, 1]] - Vt[Ft[:, 0]]; e2 = Vt[Ft[:, 2]] - Vt[Ft[:, 0]]
area = np.linalg.norm(np.cross(e1, e2), axis=1) / 2
Ft = Ft[area > 1e-9]
used = np.unique(Ft)
remap = -np.ones(len(Vt), np.int64); remap[used] = np.arange(len(used))
Vt, UV, Ft = Vt[used], UV[used], remap[Ft]
if GID is not None: GID = GID[used]

key = np.round(Vt / 1e-6).astype(np.int64)
_, topo, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
inv = inv.ravel()
TV = Vt[topo]                                   # topology vertices (welded)
TF = inv[Ft]

# push out of the body, then a light smoothing on the welded surface (no crack at seams)
TV = push_out(TV, PRM.get('clearance', 0.007), 3)

def vnormals(Vx, Fx):
    fn = np.cross(Vx[Fx[:, 1]] - Vx[Fx[:, 0]], Vx[Fx[:, 2]] - Vx[Fx[:, 0]])
    n = np.zeros_like(Vx)
    for k in range(3): np.add.at(n, Fx[:, k], fn)
    return n / np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))

# boundary loops (openings) on the welded surface: smooth them (no grid staircase), mark trims
E = np.concatenate([TF[:, [0, 1]], TF[:, [1, 2]], TF[:, [2, 0]]])
Es = np.sort(E, 1)
ue, cnt = np.unique(Es, axis=0, return_counts=True)
bnd = ue[cnt == 1]
isb = np.zeros(len(TV), bool); isb[bnd.ravel()] = True
nb = [[] for _ in range(len(TV))]
for p, q in bnd: nb[p].append(q); nb[q].append(p)
for _ in range(PRM.get('edgeSmooth', 12)):
    NV = TV.copy()
    for vtx in np.where(isb)[0]:
        if len(nb[vtx]) == 2:
            NV[vtx] = TV[vtx] + 0.5 * ((TV[nb[vtx][0]] + TV[nb[vtx][1]]) / 2 - TV[vtx])
    # keep the hems level for the shorts (their rows are level already)
    TV = NV
# the first ring of interior vertices follows the smoothed edge (no kink behind the hem)
adj = [[] for _ in range(len(TV))]
for p, q in ue: adj[p].append(q); adj[q].append(p)
for _ in range(3):
    NV = TV.copy()
    for vtx in range(len(TV)):
        if not isb[vtx] and any(isb[w] for w in adj[vtx]):
            NV[vtx] = TV[vtx] + 0.4 * (TV[adj[vtx]].mean(0) - TV[vtx])
    TV = NV
TV = push_out(TV, PRM.get('clearance', 0.007), 2)
if PRM.get('resolveFaces', True):
    _pre = TV.copy()
    TV = resolve_faces(TV, TF, PRM.get('clearance', 0.007) * 0.7)
    RESOLVE_MAX = float(np.linalg.norm(TV - _pre, axis=1).max())
else:
    RESOLVE_MAX = 0.0
if a.over:
    # layering: this garment is worn over another one (a jersey untucked over the shorts). The push
    # out of that garment is a smooth field (dilated, then blurred over this garment's surface), so
    # a hem stays a clean line instead of following the other garment's vertices one by one.
    import scipy.sparse as sp
    U = np.load(a.over)
    UT, UN_ = U['TV'].astype(np.float64), U['TN'].astype(np.float64)
    ut = cKDTree(UT)
    ii_ = np.concatenate([TF[:, 0], TF[:, 1], TF[:, 2], TF[:, 1], TF[:, 2], TF[:, 0]])
    jj_ = np.concatenate([TF[:, 1], TF[:, 2], TF[:, 0], TF[:, 0], TF[:, 1], TF[:, 2]])
    Adj = sp.csr_matrix((np.ones(len(ii_)), (ii_, jj_)), shape=(len(TV), len(TV)))
    Adj.data[:] = 1
    deg = np.asarray(Adj.sum(1)).ravel()
    gap = PRM.get('layerGap', 0.009)
    for _ in range(4):
        dd, ii = ut.query(TV, k=4)
        n = UN_[ii].mean(1); n /= np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))
        sgn = np.einsum('ij,ij->i', TV - UT[ii[:, 0]], n)
        need = np.where((dd[:, 0] < 0.08) & (sgn < gap), gap - sgn, 0.0)
        if need.max() < 5e-4: break
        m = need.copy()
        for _k in range(3):                                   # dilate
            m = np.maximum(m, np.asarray(Adj.multiply(m[None, :]).max(1).todense()).ravel())
        for _k in range(6):                                   # blur
            m = 0.5 * m + 0.5 * (Adj @ m) / np.maximum(1, deg)
        m = np.maximum(m, need)
        nd = n.copy()
        for _k in range(4):
            nd = 0.5 * nd + 0.5 * (Adj @ nd) / np.maximum(1, deg)[:, None]
        nd /= np.maximum(1e-12, np.linalg.norm(nd, axis=1, keepdims=True))
        TV = TV + m[:, None] * nd
    dd, ii = ut.query(TV, k=4)
    n = UN_[ii].mean(1); n /= np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))
    sgn = np.einsum('ij,ij->i', TV - UT[ii[:, 0]], n)
    LAYER_VIOL = int(((dd[:, 0] < 0.08) & (sgn < 0)).sum())
# ── skin weights from the body: nearest body vertices (normal-aware), restricted to the bones
# this garment may follow, then smoothed over the garment so loose cloth does not crease
ALLOWED = {
    'shorts': lambda n: bool(re.match(r'^(root|c_spine0|[lr]_upleg(_twist[0-4]_proc)?)$', n)),
    'jersey': lambda n: bool(re.match(r'^(root|c_spine[0-3]|[lr]_clavicle)$', n)),
    'tee': lambda n: bool(re.match(r'^(root|c_spine[0-3]|[lr]_clavicle|[lr]_uparm(_twist[0-4]_proc)?)$', n)),
}[a.garment]
def remap_bone(bi):
    n = NAMES[bi]
    while not ALLOWED(n):
        bi = PARENTS[bi]
        if bi < 0: return NAMES.index('root')
        n = NAMES[bi]
    return bi
BONE_MAP = np.array([remap_bone(i) for i in range(len(NAMES))])
if a.garment == 'shorts':
    # the lower leg must not steer the shorts' hem: map knee bones to the upper-leg twist nearest the knee
    for sd in 'lr':
        for i, n in enumerate(NAMES):
            if re.match(rf'^{sd}_(lowleg|foot|talocrural|subtalar|transversetarsal|ball)', n): BONE_MAP[i] = NAMES.index(f'{sd}_upleg_twist4_proc') if f'{sd}_upleg_twist4_proc' in NAMES else NAMES.index(f'{sd}_upleg')
def skin_weights(TVx, TNx):
    """Skin weights of a garment surface from the body (normal-aware nearest body vertices,
    restricted to the bones this garment follows, smoothed over the garment)."""
    import scipy.sparse as sp
    K = 12
    d, idx = BODY_TREE.query(TVx, k=K)
    cosn = np.einsum('ijk,ik->ij', NB[idx], TNx)
    w = np.exp(-(d / (d[:, :1] + 0.02)) ** 2) * np.clip(0.3 + 0.7 * cosn, 0.05, 1)
    Wd = np.zeros((len(TVx), len(NAMES)))
    SI, SW = BODY['SI'], BODY['SW']
    for k in range(K):
        for c in range(4):
            np.add.at(Wd, (np.arange(len(TVx)), BONE_MAP[SI[idx[:, k], c]]), w[:, k] * SW[idx[:, k], c])
    Wd /= np.maximum(1e-12, Wd.sum(1, keepdims=True))
    _A = sp.coo_matrix((np.ones(2 * len(ue)), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(len(TVx), len(TVx))).tocsr()
    _A.data[:] = 1
    ADJN = sp.diags(1 / np.maximum(1, np.asarray(_A.sum(1)).ravel())) @ _A          # neighbour mean
    for _ in range(PRM.get('weightSmooth', 25)):
        Wd = 0.5 * Wd + 0.5 * (ADJN @ Wd)
    top4 = np.argsort(-Wd, 1)[:, :4]
    tw = np.take_along_axis(Wd, top4, 1)
    tw /= np.maximum(1e-12, tw.sum(1, keepdims=True))
    return top4, tw


# ── drape: the cut shape falls onto the body as limp cloth (Blender's cloth simulation, gravity -y,
# the body and any garment worn under it as colliders). Shorts keep their waistband (elastic).
DRAPE_INFO = None
if PRM.get('drape', True):
    import subprocess, tempfile
    import scipy.sparse as sp
    from scipy.sparse.csgraph import dijkstra as _dij, connected_components as _cc
    pin_reach = PRM.get('pinTop', 0.03 if a.garment == 'shorts' else 0.0)
    pinw = np.zeros(len(TV))
    if pin_reach > 0:
        _Ab = sp.coo_matrix((np.ones(len(bnd)), (bnd[:, 0], bnd[:, 1])), shape=(len(TV), len(TV)))
        _, _lab = _cc(_Ab, directed=False)
        _bv = np.unique(bnd)
        top_l = max(np.unique(_lab[_bv]), key=lambda l: TV[_bv[_lab[_bv] == l], 1].mean())
        _L = np.linalg.norm(TV[ue[:, 0]] - TV[ue[:, 1]], axis=1)
        _G = sp.coo_matrix((np.concatenate([_L, _L]), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(len(TV), len(TV))).tocsr()
        _d = _dij(_G, directed=False, indices=_bv[_lab[_bv] == top_l], min_only=True)
        pinw = 1 - smoothstep(pin_reach, pin_reach + 0.03, _d)
    # the pose it hangs in: the game's (arms down, the dribble stance) — the garment is posed with
    # provisional weights, draped on the posed body, then un-posed back to the bind pose; the fabric
    # then rests on the body the way the game shows it, not the way the A-pose would
    POSE = None
    if a.pose:
        POSE = np.array(json.load(open(a.pose))['mats'], np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    def lbs_mats(SIx, SWx):
        return np.einsum('nk,nkij->nij', SWx, POSE[SIx])
    def apply(Mv, P_):
        return np.einsum('nij,nj->ni', Mv[:, :3, :3], P_) + Mv[:, :3, 3]
    Vp, Gp, Mg = V, TV, None
    if POSE is not None:
        Vp = apply(lbs_mats(BODY['SI'], BODY['SW']), V)
        p4, pw = skin_weights(TV, vnormals(TV, TF))
        POSE_WEIGHTS = (p4, pw)
        Mg = lbs_mats(p4, pw)
        Gp = apply(Mg, TV)
        # clear of the posed body before the cloth starts (skinning can fold it into an armpit)
        NBp = vnormals(Vp, F)
        pt = cKDTree(Vp[NOHEAD])
        for _ in range(3):
            dd_, ii_ = pt.query(Gp, k=4); ii_ = NOHEAD[ii_]
            nn_ = NBp[ii_].mean(1); nn_ /= np.maximum(1e-12, np.linalg.norm(nn_, axis=1, keepdims=True))
            sd_ = np.einsum('ij,ij->i', Gp - Vp[ii_[:, 0]], nn_)
            m_ = sd_ < 0.006
            Gp[m_] += (0.006 - sd_[m_])[:, None] * nn_[m_]
    with tempfile.TemporaryDirectory() as td:
        # the head and its hair are not colliders (dreads lie over a collar; a collar inside them explodes)
        # nor are the hands and forearms (a hand resting at the hem in the pose would crease it for good)
        _fl = tee_shape.labels_of(DN)[F]
        _skipf = (TREG == 'head') | ((_fl == 'forearm').sum(1) >= 2)
        np.savez(os.path.join(td, 'body.npz'), V=Vp, F=F[~_skipf])
        np.savez(os.path.join(td, 'g.npz'), V=Gp, F=TF, pin=pinw)
        under = []
        if a.over:
            U_ = np.load(a.over)
            UV_ = U_['V'].astype(np.float64)
            if POSE is not None: UV_ = apply(lbs_mats(U_['skinIdx'], U_['skinW']), UV_)
            np.savez(os.path.join(td, 'u.npz'), V=UV_, F=U_['F']); under.append(os.path.join(td, 'u.npz'))
        args = {'body': os.path.join(td, 'body.npz'), 'garment': os.path.join(td, 'g.npz'), 'out': os.path.join(td, 'out.npz'), 'under': under,
                'frames': PRM.get('drapeFrames', 150), 'bending': PRM.get('bending', 0.05), 'compression': PRM.get('compression', 0.5), 'shear': PRM.get('shear', 1.0), 'mass': PRM.get('mass', 0.15), 'airDamping': PRM.get('airDamping', 4.0), 'quality': PRM.get('drapeQuality', 10), 'selfCollision': PRM.get('selfCollision', True)}
        r = subprocess.run([a.blender, '-b', '--factory-startup', '-P', os.path.join(os.path.dirname(__file__), 'drape_blender.py'), '--', json.dumps(args)], capture_output=True, text=True)
        if not os.path.exists(os.path.join(td, 'out.npz')):
            raise RuntimeError('drape failed: ' + (r.stderr or r.stdout)[-1500:])
        D_ = np.load(os.path.join(td, 'out.npz'))
        Dv = D_['V'].astype(np.float64)
        moved = np.linalg.norm(Dv - Gp, axis=1)
        DRAPE_INFO = {'settleMotion': round(float(D_['motion'][0]), 4), 'meanMove': round(float(moved.mean()), 4), 'maxMove': round(float(moved.max()), 4), 'pinned': int((pinw > 0.5).sum()), 'pose': os.path.basename(a.pose) if a.pose else 'bind'}
        if Mg is not None:
            Dv = apply(np.linalg.inv(Mg), Dv)            # back to the bind pose
            dbg = os.environ.get('GARMENT_DEBUG_DIR')
            if dbg: np.savez(os.path.join(dbg, f'{a.garment}_posed.npz'), V=D_['V'], F=TF, body=Vp, bodyF=F)
        TV = Dv
    TV = push_out(TV, PRM.get('clearance', 0.007) * 0.5, 2)
    print('drape', json.dumps(DRAPE_INFO), file=sys.stderr)
TN = vnormals(TV, TF)
Vt = TV[inv]                                    # render vertices follow the welded surface

# geodesic-ish distance to the nearest opening (graph distance) — trims, pinning, hidden body
import heapq
dist = np.full(len(TV), np.inf)
hq = []
for vtx in np.where(isb)[0]: dist[vtx] = 0; hq.append((0.0, vtx))
heapq.heapify(hq)
while hq:
    d0, vtx = heapq.heappop(hq)
    if d0 > dist[vtx]: continue
    for w in adj[vtx]:
        nd = d0 + np.linalg.norm(TV[w] - TV[vtx])
        if nd < dist[w]: dist[w] = nd; heapq.heappush(hq, (nd, w))

# (draped in a game pose: the weights it was un-posed with, so the game's pose puts it back exactly
# where it hung — recomputing them from the un-posed shape would move a hanging hem by its new
# nearest bones)
if DRAPE_INFO is not None and DRAPE_INFO.get('pose') not in (None, 'bind'):
    top4, tw = POSE_WEIGHTS
else:
    top4, tw = skin_weights(TV, TN)


def generic_proxy(spacing):
    """A coarse cloth graph on any surface: nodes Poisson-sampled over the welded vertices (the
    openings' edges first, so hems and cuffs carry nodes), cells by multi-source graph distance,
    edges between touching cells; every render vertex blends its cell's node and the neighbours'."""
    from scipy.sparse.csgraph import dijkstra
    tree = cKDTree(TV)
    blocked = np.zeros(len(TV), bool)
    order = np.concatenate([np.where(isb)[0], np.random.RandomState(7).permutation(np.where(~isb)[0])])
    nodes = []
    for v in order:
        if blocked[v]: continue
        # a node on an opening blocks along the edge at the full spacing, inside at 0.8
        nodes.append(v)
        blocked[tree.query_ball_point(TV[v], spacing * (1.0 if isb[v] else 0.9))] = True
    nodes = np.array(nodes)
    L = np.linalg.norm(TV[ue[:, 0]] - TV[ue[:, 1]], axis=1)
    Gw = sp.coo_matrix((np.concatenate([L, L]), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(len(TV), len(TV))).tocsr()
    dist_, _, src = dijkstra(Gw, directed=False, indices=nodes, min_only=True, return_predecessors=True)
    pos_of = {int(n): i for i, n in enumerate(nodes)}
    if (src < 0).any(): raise RuntimeError('cloth graph: unreachable vertices')
    cell = np.array([pos_of[int(s)] for s in src])
    ca, cb = cell[ue[:, 0]], cell[ue[:, 1]]
    m = ca != cb
    E_ = np.unique(np.sort(np.stack([ca[m], cb[m]], 1), 1), axis=0)
    nbrs = [[i] for i in range(len(nodes))]
    for p_, q_ in E_: nbrs[p_].append(q_); nbrs[q_].append(p_)
    idx4 = np.zeros((len(TV), 4), np.int64); w4 = np.zeros((len(TV), 4))
    for v in range(len(TV)):
        cand = np.array(nbrs[cell[v]])
        d_ = np.linalg.norm(TV[nodes[cand]] - TV[v], axis=1)
        w_ = np.exp(-2.0 * (d_ / spacing) ** 2)
        o = np.argsort(-w_)[:4]
        idx4[v, :len(o)] = cand[o]; w4[v, :len(o)] = w_[o]
        w4[v] /= max(1e-12, w4[v].sum())
    return nodes, E_, idx4, w4


# ── cloth grid (coarse proxy): every PROXY_STEP-th row / column of each piece's grid
s_ = PROXY_STEP
gkey = {tuple(g): t for g, t in zip(map(tuple, GID), inv)} if GID is not None else {}          # (piece, row, col) → topology vertex
proxy_of = {}
proxy_nodes = []
def node(pc, i, j, register=False):
    k = gkey.get((pc, i, j))
    if k is None: return None
    if k not in proxy_of:
        if not register: return None
        proxy_of[k] = len(proxy_nodes); proxy_nodes.append(k)
    return proxy_of[k]
def rl(rows):
    return np.array(list(range(0, rows, s_)) + ([rows - 1] if (rows - 1) % s_ else []))
def cl(C):
    return np.arange(0, C, s_)            # C is a multiple of the proxy step (wraps)
if GRIDS is not None:
  for pc, g in enumerate(GRIDS):
    for i in rl(g['rows']):
        for j in cl(g['C']): node(pc, i, j, register=True)
# every render vertex: bilinear weights to the 4 surrounding proxy nodes of its grid cell
cloth_idx = np.zeros((len(Vt), 4), np.int64); cloth_w = np.zeros((len(Vt), 4))
if GRIDS is None:
    _nodes, _E, _i4, _w4 = generic_proxy(PRM.get('proxySpacing', 0.045))
    proxy_nodes = list(_nodes)
    cloth_idx[:], cloth_w[:] = _i4[inv], _w4[inv]
for vi, (pc, i, j) in enumerate(GID if GRIDS is not None else []):
    g = GRIDS[pc]
    RL, CL = rl(g['rows']), cl(g['C'])
    a_ = max(0, np.searchsorted(RL, i, 'right') - 1); b_ = min(len(RL) - 1, a_ + 1)
    c_ = j // s_; d_ = (c_ + 1) % len(CL)
    fi = 0 if RL[b_] == RL[a_] else (i - RL[a_]) / (RL[b_] - RL[a_])
    fj = (j - CL[c_]) / s_
    corners = [(RL[a_], CL[c_], (1 - fi) * (1 - fj)), (RL[a_], CL[d_], (1 - fi) * fj), (RL[b_], CL[c_], fi * (1 - fj)), (RL[b_], CL[d_], fi * fj)]
    own = None
    tot = 0
    for k, (ri, cj, wt) in enumerate(corners):
        n_ = node(pc, ri, cj)
        if n_ is None:           # a dropped node (inner half above the crotch): no weight
            n_, wt = 0, 0.0
        cloth_idx[vi, k] = n_; cloth_w[vi, k] = wt; tot += wt
    if tot < 1e-9: cloth_w[vi, 0] = -1   # resolved below (nearest node)
    else: cloth_w[vi] /= tot
PN = TV[np.array(proxy_nodes)]
lost = np.where(cloth_w[:, 0] < 0)[0]
if len(lost):
    _, nn = cKDTree(PN).query(TV[inv[lost]])
    cloth_idx[lost] = nn[:, None]; cloth_w[lost] = [1, 0, 0, 0]
# proxy edges: grid neighbours (structure) + diagonals (shear)
pedges = set() if GRIDS is not None else set(map(tuple, _E.tolist()))
for pc, g in enumerate(GRIDS or []):
    RL, CL = rl(g['rows']), cl(g['C'])
    for a_ in range(len(RL)):
        for c_ in range(len(CL)):
            p0 = gkey.get((pc, RL[a_], CL[c_]))
            if p0 is None or p0 not in proxy_of: continue
            for da, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                b_, d_ = a_ + da, (c_ + dc) % len(CL)
                if not (0 <= b_ < len(RL)): continue
                p1 = gkey.get((pc, RL[b_], CL[d_]))
                if p1 is None or p1 not in proxy_of or p1 == p0: continue
                pedges.add(tuple(sorted((proxy_of[p0], proxy_of[p1]))))
pedges = np.array(sorted(pedges), np.int64)
# drop proxy edges whose nodes are far apart through the removed regions (inner half)
if len(pedges):
    L = np.linalg.norm(PN[pedges[:, 0]] - PN[pedges[:, 1]], axis=1)
    pedges = pedges[L < 0.2]
# pin (how firmly a node follows the body): hems free, waistband / shoulders held
yN = PN[:, 1]
if a.garment == 'shorts':
    y_w, y_h, y_c = INFO['y_waist'], INFO['y_hem'], INFO['y_crotch']
    pin = np.where(yN > y_c, 0.35 + 0.65 * smoothstep(y_c + 0.06, y_w - 0.02, yN), 0.35 * (1 - smoothstep(y_c, y_h, yN)) + 0.06)
elif a.garment == 'tee':
    # torso: held on the shoulders, free toward the hem; sleeves: held at the shoulder, free at the cuff
    y_top, y_hem, y_ch = INFO['y_top'], INFO['y_hem'], INFO['y_chest']
    pin = np.where(yN > y_ch, 0.5 + 0.5 * smoothstep(y_ch, y_top - 0.06, yN), 0.06 + 0.44 * smoothstep(y_hem, y_ch, yN))
    _, bi_ = BODY_TREE.query(PN)
    labN = tee_shape.labels_of(DN[bi_])
    for sd in 'lr':
        A_ = INFO['arms'][sd]
        m = (labN == 'uparm_' + sd) | ((PN - A_['S']) @ np.array(A_['a']) > 0.04) & (PN[:, 0] * (1 if sd == 'l' else -1) > 0.12)
        s = (PN[m] - A_['S']) @ np.array(A_['a'])
        pin[m] = np.minimum(pin[m], 0.1 + 0.5 * (1 - smoothstep(0.0, A_['cuff'], s)))
    # smooth over the cloth graph (no seam in stiffness where the sleeve meets the body)
    for _ in range(3):
        acc = pin.copy(); cnt_ = np.ones(len(pin))
        np.add.at(acc, pedges[:, 0], pin[pedges[:, 1]]); np.add.at(cnt_, pedges[:, 0], 1)
        np.add.at(acc, pedges[:, 1], pin[pedges[:, 0]]); np.add.at(cnt_, pedges[:, 1], 1)
        pin = acc / cnt_
else:
    y_top, y_hem = INFO['y_top'], INFO['y_hem']
    y_ch = (J['c_spine2'][1] + J['c_spine3'][1]) / 2
    pin = np.where(yN > y_ch, 0.55 + 0.45 * smoothstep(y_ch, y_top - 0.08, yN), 0.08 + 0.47 * smoothstep(y_hem, y_ch, yN))
# limp fabric (a draped garment): nothing holds it but where it rests, except an elastic waistband
# (the drape's pinned ring) and, lightly, a collar; the rest hangs and sways
if DRAPE_INFO is not None:
    from scipy.sparse.csgraph import dijkstra as _dij2, connected_components as _cc2
    _pn = np.array(proxy_nodes)
    if a.garment == 'shorts':
        pin = np.clip(pinw[_pn], 0, 1)
    else:
        _Ab = sp.coo_matrix((np.ones(len(bnd)), (bnd[:, 0], bnd[:, 1])), shape=(len(TV), len(TV)))
        _, _lab = _cc2(_Ab, directed=False)
        _bv = np.unique(bnd)
        top_l = max(np.unique(_lab[_bv]), key=lambda l: TV[_bv[_lab[_bv] == l], 1].mean())
        _L = np.linalg.norm(TV[ue[:, 0]] - TV[ue[:, 1]], axis=1)
        _G = sp.coo_matrix((np.concatenate([_L, _L]), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(len(TV), len(TV))).tocsr()
        _dn = _dij2(_G, directed=False, indices=_bv[_lab[_bv] == top_l], min_only=True)
        pin = PRM.get('collarHold', 0.75) * (1 - smoothstep(0.025, 0.07, _dn[_pn]))
# tethers (long-range attachments): each node may not get further from its nearest held node than
# along the cloth — hanging fabric does not stretch however few solver iterations run
from scipy.sparse.csgraph import dijkstra as _dij3
_sup = np.where(pin >= 0.3)[0]
if not len(_sup): _sup = np.array([int(np.argmax(PN[:, 1]))])
_Lp = np.linalg.norm(PN[pedges[:, 0]] - PN[pedges[:, 1]], axis=1)
_Gp = sp.coo_matrix((np.concatenate([_Lp, _Lp]), (np.concatenate([pedges[:, 0], pedges[:, 1]]), np.concatenate([pedges[:, 1], pedges[:, 0]]))), shape=(len(PN), len(PN))).tocsr()
_td, _, _ts = _dij3(_Gp, directed=False, indices=_sup, min_only=True, return_predecessors=True)
tether_idx = np.where(np.isfinite(_td) & (_ts >= 0), _ts, np.arange(len(PN)))
tether_len = np.where(np.isfinite(_td), _td, 0.0)

# proxy skinning: the topology vertex's weights; its normal; its gap to the body (the backstop:
# how far in the cloth may move before it would touch the skin)
pw_idx, pw_w = top4[np.array(proxy_nodes)], tw[np.array(proxy_nodes)]
PNN = TN[np.array(proxy_nodes)]
_gd, _gi = COLL_TREE.query(PN, k=4); _gi = NOHEAD[_gi]
_gn = NB[_gi].mean(1); _gn /= np.maximum(1e-12, np.linalg.norm(_gn, axis=1, keepdims=True))
proxy_gap = np.maximum(0.0, np.einsum('ij,ij->i', PN - V[_gi[:, 0]], _gn))

# ── hidden body faces: covered by the garment along the body normal and away from its openings
def hidden_faces(Vb, Fb, Nb_face):
    cen = Vb[Fb].mean(1)
    gt = cKDTree(TV)
    hit = np.zeros(len(Fb), bool)
    for t in np.linspace(0.0, PRM.get('hideReach', 0.13), 27):
        dd, ii = gt.query(cen + Nb_face * t, k=1)
        hit |= dd < 0.011
    d_open, ii = gt.query(cen, k=1)
    far = dist[ii] > PRM.get('hideMargin', 0.04 if a.garment == 'tee' else 0.06)
    return np.where(hit & far)[0]

def body_face_normals(Vb, Fb):
    fn = np.cross(Vb[Fb[:, 1]] - Vb[Fb[:, 0]], Vb[Fb[:, 2]] - Vb[Fb[:, 0]])
    return fn / np.maximum(1e-12, np.linalg.norm(fn, axis=1, keepdims=True))

hide = {0: hidden_faces(V, F, body_face_normals(V, F))}
for lv in R.get('lods', []):
    pb = part_arrays(lv['parts'][0])
    hide[lv['level']] = hidden_faces(pb['V'].astype(np.float64), pb['F'], body_face_normals(pb['V'].astype(np.float64), pb['F']))

np.savez(os.path.join(a.out, f'{a.garment}.npz'),
         V=Vt.astype(np.float32), topo=inv.astype(np.int32), TV=TV.astype(np.float32), TN=TN.astype(np.float32), UV=UV.astype(np.float32), F=Ft.astype(np.int32),
         skinIdx=top4[inv].astype(np.int32), skinW=tw[inv].astype(np.float32), edgeDist=dist[inv].astype(np.float32),
         clothIdx=cloth_idx.astype(np.int32), clothW=cloth_w.astype(np.float32),
         proxyPos=PN.astype(np.float32), proxyEdges=pedges.astype(np.int32), proxyPin=pin.astype(np.float32),
         proxySkinIdx=pw_idx.astype(np.int32), proxySkinW=pw_w.astype(np.float32), proxyNormal=PNN.astype(np.float32), proxyGap=proxy_gap.astype(np.float32),
         proxyTether=tether_idx.astype(np.int32), proxyTetherLen=tether_len.astype(np.float32),
         **({'gid': GID.astype(np.int32)} if GID is not None else {}),
         **{f'hide{k}': v.astype(np.int32) for k, v in hide.items()})
_, _bi = BODY_TREE.query(TV)
_o = TV - V[_bi]; _o /= np.maximum(1e-12, np.linalg.norm(_o, axis=1, keepdims=True))
OUTWARD = float((np.einsum('ij,ij->i', _o, TN) > 0).mean())
rep = {'garment': a.garment, 'normalsOutward': round(OUTWARD, 3), 'rig': os.path.basename(a.rig), 'renderVertices': int(len(Vt)), 'topoVertices': int(len(TV)), 'triangles': int(len(Ft)),
       'drape': DRAPE_INFO, 'proxyNodes': int(len(PN)), 'proxyGapMean': round(float(proxy_gap.mean()), 4), 'layerViolations': (LAYER_VIOL if a.over else None), 'resolveMaxMove': round(RESOLVE_MAX, 4), 'proxyEdges': int(len(pedges)), 'openings': int(isb.sum()), 'hiddenBodyFaces': {int(k): int(len(v)) for k, v in hide.items()},
       'bones': sorted({NAMES[b] for b in np.unique(top4[tw > 0.01])}), **{k: (round(float(v), 4) if isinstance(v, (float, np.floating)) else v) for k, v in INFO.items()}}
json.dump(rep, open(os.path.join(a.out, f'{a.garment}.json'), 'w'), indent=1)
print(json.dumps(rep))
