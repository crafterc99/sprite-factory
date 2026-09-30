"""
The shape of a loose t-shirt with sleeves, built as a volume around the body instead of a lofted
grid (a grid cannot branch into sleeves):

  1. a signed distance to the body, eased out per region (close on the shoulders, baggy below the
     chest, wide sleeves), limited to the torso and the upper arms;
  2. fabric hangs: below the armpits each horizontal slice of the torso is filled to its convex
     hull and carried straight down to the hem (it falls from the chest and the shoulder blades);
  3. the volume's surface (marching cubes on a smoothed distance field), remeshed into even quads
     by Blender's Quadriflow;
  4. clean openings: the surface is clipped by exact cut functions — a level hem, a cuff plane
     across each upper arm, a crew neckline around the neck.

Used by build_garment.py (--garment tee); returns the welded surface and the cut landmarks.
"""
import json, math, os, re, subprocess, tempfile
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
import scipy.sparse as sp
from scipy.sparse.csgraph import connected_components


def labels_of(names):
    out = []
    for n in names:
        if re.match(r'^[lr]_uparm', n): out.append('uparm_' + n[0])
        elif re.match(r'^[lr]_(lowarm|wrist|thumb|index|middle|ring|pinky)', n): out.append('forearm')
        elif re.match(r'^(c_head|c_jaw|c_teeth|c_tongue|[lr]_eye|c_head_null)', n): out.append('head')
        elif re.match(r'^c_neck', n): out.append('neck')
        elif re.match(r'^[lr]_(upleg|lowleg|foot|talocrural|subtalar|transversetarsal|ball)', n): out.append('leg')
        else: out.append('torso')
    return np.array(out)


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def clip_mesh(V, F, f):
    """Keep the part of a triangle mesh where the per-vertex field f <= 0; crossing edges are cut
    at the linear zero of f (new vertices shared between the two triangles of an edge)."""
    s = f > 1e-9
    keep = ~s[F].any(1)
    mixed = s[F].any(1) & ~s[F].all(1)
    NV = [V]
    nxt = [len(V)]
    cache = {}

    def ev(a, b):
        k = (a, b) if a < b else (b, a)
        if k not in cache:
            t = f[a] / (f[a] - f[b])
            NV.append((V[a] + t * (V[b] - V[a]))[None])
            cache[k] = nxt[0]; nxt[0] += 1
        return cache[k]

    out = [F[keep]]
    for tri in F[mixed]:
        ins = [not s[v] for v in tri]
        if sum(ins) == 1:
            k = ins.index(True)
            a, b, c = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
            out.append(np.array([[a, ev(a, b), ev(a, c)]]))
        else:
            k = ins.index(False)
            c, a, b = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
            p, q = ev(b, c), ev(c, a)
            out.append(np.array([[a, b, p], [a, p, q]]))
    V2 = np.concatenate(NV)
    F2 = np.concatenate(out)
    e1 = V2[F2[:, 1]] - V2[F2[:, 0]]; e2 = V2[F2[:, 2]] - V2[F2[:, 0]]
    F2 = F2[np.linalg.norm(np.cross(e1, e2), axis=1) > 1e-10]
    used = np.unique(F2)
    rm = -np.ones(len(V2), np.int64); rm[used] = np.arange(len(used))
    return V2[used], rm[F2]


def snap_to_cut(V, fn, tol):
    """Vertices within `tol` of a cut move onto it (no sliver triangles at the opening)."""
    f = fn(V)
    m = (np.abs(f) < tol) & (np.abs(f) > 0)
    if not m.any(): return V
    e = 1e-4
    g = np.stack([(fn(V[m] + e * np.eye(3)[k]) - fn(V[m] - e * np.eye(3)[k])) / (2 * e) for k in range(3)], 1)
    V = V.copy()
    V[m] -= (f[m] / np.maximum(1e-12, (g * g).sum(1)))[:, None] * g
    return V


def boundary_loops(F):
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    Es = np.sort(E, 1)
    ue, cnt = np.unique(Es, axis=0, return_counts=True)
    bnd = ue[cnt == 1]
    if not len(bnd): return 0, bnd
    ids = np.unique(bnd)
    rm = {v: i for i, v in enumerate(ids)}
    A = sp.coo_matrix((np.ones(len(bnd)), ([rm[a] for a in bnd[:, 0]], [rm[b] for b in bnd[:, 1]])), shape=(len(ids), len(ids)))
    n, _ = connected_components(A, directed=False)
    return n, bnd


def largest_component(V, F):
    A = sp.coo_matrix((np.ones(len(F) * 3), (np.concatenate([F[:, 0], F[:, 1], F[:, 2]]), np.concatenate([F[:, 1], F[:, 2], F[:, 0]]))), shape=(len(V), len(V)))
    n, lab = connected_components(A, directed=False)
    if n == 1: return V, F
    big = np.bincount(lab[F[:, 0]]).argmax()
    F = F[lab[F[:, 0]] == big]
    used = np.unique(F)
    rm = -np.ones(len(V), np.int64); rm[used] = np.arange(len(used))
    return V[used], rm[F]


def mesh_edges(F):
    E = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1)
    return np.unique(E, axis=0, return_counts=True)


def clean_mesh(V, F, min_edge, relax=4):
    """A mesh a cloth solver can run on: short edges collapsed, degenerate / duplicate faces and
    non-manifold fans removed, then a tangential relaxation (even triangles; openings kept)."""
    V = V.copy(); F = F.copy()
    for _ in range(4):
        ue, cnt = mesh_edges(F)
        L = np.linalg.norm(V[ue[:, 0]] - V[ue[:, 1]], axis=1)
        short = ue[L < min_edge]
        if not len(short): break
        bnd = np.zeros(len(V), bool); bnd[ue[cnt == 1].ravel()] = True
        par = np.arange(len(V))
        def find(x):
            while par[x] != x:
                par[x] = par[par[x]]; x = par[x]
            return x
        for a_, b_ in short:
            ra, rb = find(a_), find(b_)
            if ra != rb: par[max(ra, rb)] = min(ra, rb)
        root = np.array([find(i) for i in range(len(V))])
        for r_ in np.unique(root[short.ravel()]):
            m = root == r_
            mb = m & bnd
            V[r_] = V[mb].mean(0) if mb.any() else V[m].mean(0)
        F = root[F]
        F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
        _, first = np.unique(np.sort(F, 1), axis=0, return_index=True)
        F = F[np.sort(first)]
    # non-manifold edges (3+ faces): keep the two best-shaped faces of the fan
    for _ in range(3):
        E = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1)
        fid = np.tile(np.arange(len(F)), 3)
        ue, inv_, cnt = np.unique(E, axis=0, return_inverse=True, return_counts=True)
        bad = np.where(cnt > 2)[0]
        if not len(bad): break
        area = np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)
        drop = set()
        for e in bad:
            fs = fid[inv_.ravel() == e]
            drop.update(fs[np.argsort(-area[fs])][2:].tolist())
        F = F[[i for i in range(len(F)) if i not in drop]]
    V, F = largest_component(V, F)
    # tangential relaxation (boundary vertices stay: the openings are exact cuts)
    ue, cnt = mesh_edges(F)
    bnd = np.zeros(len(V), bool); bnd[ue[cnt == 1].ravel()] = True
    A_ = sp.coo_matrix((np.ones(2 * len(ue)), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(len(V), len(V))).tocsr()
    deg = np.asarray(A_.sum(1)).ravel()
    for _ in range(relax):
        fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
        vn = np.zeros_like(V)
        for k in range(3): np.add.at(vn, F[:, k], fn)
        vn /= np.maximum(1e-12, np.linalg.norm(vn, axis=1, keepdims=True))
        d = (A_ @ V) / np.maximum(1, deg)[:, None] - V
        d -= np.einsum('ij,ij->i', d, vn)[:, None] * vn
        d[bnd] = 0
        V = V + 0.5 * d
    return V, F


def build_tee_surface(V, F, NB, DN, J, P, blender, log=print):
    """V, F, NB: the rig's bind body (game axes: y up, facing +z); DN: each body vertex's dominant
    joint name; J: joint positions. Returns (TV, TF, info)."""
    h = P.get('voxel', 0.006)
    LAB = labels_of(DN)
    # per-face label: the majority of its vertices (ties: the first)
    FL = LAB[F[:, 0]].copy()
    for k in (1, 2):
        same = LAB[F[:, k]] == LAB[F[:, (k + 1) % 3]]
        FL[same] = LAB[F[same, k]]

    # ── landmarks
    y_neck = J['c_neck'][1]
    y_sh = J['l_uparm'][1] - 0.03
    y_ch = (J['c_spine2'][1] + J['c_spine3'][1]) / 2
    y_hem = P.get('hemY', J['root'][1] - P.get('belowWaist', 0.15))
    arm = {}
    for sd in 'lr':
        S0, E0 = np.array(J[sd + '_uparm']), np.array(J[sd + '_lowarm'])
        L = float(np.linalg.norm(E0 - S0))
        arm[sd] = dict(S=S0, a=(E0 - S0) / L, len=L, cuff=P.get('sleeve', 0.78) * L)
    uv_ = np.isin(LAB, ['uparm_l', 'uparm_r']); tv_ = LAB == 'torso'
    dd, _ = cKDTree(V[tv_]).query(V[uv_])
    y_pit = float(V[uv_][dd < 0.012][:, 1].min())
    # the neck column just above its base
    nk_f = np.isin(FL, ['neck', 'torso'])
    yN = y_neck + P.get('neckMeasureAt', 0.06)          # the neck column, above the trapezius
    T = F[nk_f]; d = V[:, 1] - yN; dt = d[T]
    Q = []
    for i0, i1 in ((0, 1), (1, 2), (2, 0)):
        a0, a1 = dt[:, i0], dt[:, i1]; m = a0 * a1 < 0
        t = a0[m] / (a0[m] - a1[m])
        Q.append(V[T[m, i0]] + t[:, None] * (V[T[m, i1]] - V[T[m, i0]]))
    Q = np.concatenate(Q); Q = Q[np.abs(Q[:, 0]) < 0.11]
    neck = dict(zc=float((Q[:, 2].max() + Q[:, 2].min()) / 2), rx=float(max(Q[:, 0].max(), -Q[:, 0].min())), rz=float((Q[:, 2].max() - Q[:, 2].min()) / 2))
    room = P.get('neckRoom', 0.014)
    neck.update(hx=neck['rx'] + room, hz=neck['rz'] + room * 0.8)

    # ── body surface samples (vertices + 3 points per face) with normals and a per-sample ease
    fa, fb, fc = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(fb - fa, fc - fa); fn /= np.maximum(1e-12, np.linalg.norm(fn, axis=1, keepdims=True))
    SPTS = [V] + [w0 * fa + w1 * fb + w2 * fc for w0, w1, w2 in ((2 / 3, 1 / 6, 1 / 6), (1 / 6, 2 / 3, 1 / 6), (1 / 6, 1 / 6, 2 / 3))]
    SP = np.concatenate(SPTS)
    SN = np.concatenate([NB, fn, fn, fn])
    SL = np.concatenate([LAB, FL, FL, FL])
    e_sh, e_ch, e_hem = P.get('easeShoulder', 0.014), P.get('easeChest', 0.035), P.get('easeHem', 0.07)
    e_arm0, e_arm1 = P.get('easeSleeve', 0.018), P.get('easeCuff', 0.04)
    y = SP[:, 1]
    ease_t = np.where(y >= y_sh, e_sh, np.where(y >= y_ch, e_ch + (e_sh - e_ch) * smoothstep(y_ch, y_sh, y), e_ch + (e_hem - e_ch) * smoothstep(y_ch, y_hem, y)))
    ease = ease_t.copy()
    s_along = np.zeros(len(SP))
    for sd in 'lr':
        m = SL == 'uparm_' + sd
        s = (SP[m] - arm[sd]['S']) @ arm[sd]['a']
        s_along[m] = s
        ease[m] = e_arm0 + (e_arm1 - e_arm0) * smoothstep(0, arm[sd]['cuff'], s)
    ease[SL == 'neck'] = P.get('easeNeck', 0.008)
    # smooth the ease over the body surface (no step where the sleeve meets the torso)
    st = cKDTree(SP)
    _, nb = st.query(SP, k=24)
    for _ in range(6): ease = ease[nb].mean(1)

    # ── the voxel grid over the garment zone
    xs = [abs(arm[sd]['S'][0] + arm[sd]['a'][0] * arm[sd]['cuff']) for sd in 'lr']
    X0 = max(xs) + 0.13
    band = (V[:, 1] > y_hem - 0.05) & (V[:, 1] < y_neck + 0.06) & (np.abs(V[:, 0]) < X0)
    lo = np.array([-X0, y_hem - 0.04, V[band, 2].min() - 0.1])
    hi = np.array([X0, y_neck + 0.085, V[band, 2].max() + 0.1])
    n = np.ceil((hi - lo) / h).astype(int) + 1
    gx, gy, gz = [lo[k] + h * np.arange(n[k]) for k in range(3)]
    log(f'tee voxels {n.tolist()} = {int(np.prod(n))}')
    G = np.stack(np.meshgrid(gx, gy, gz, indexing='ij'), -1).reshape(-1, 3)
    CODES = ['torso', 'leg', 'neck', 'head', 'forearm', 'uparm_l', 'uparm_r']
    SLc = np.array([CODES.index(l) for l in SL], np.int8)
    code = {c: i for i, c in enumerate(CODES)}
    sd_ = np.zeros(len(G), np.float32); ez = np.zeros(len(G), np.float32); lz = np.zeros(len(G), np.int8); dz = np.zeros(len(G), np.float32)
    for s0 in range(0, len(G), 400000):
        g = G[s0:s0 + 400000]
        dk, ik = st.query(g, k=4)
        nm = SN[ik].mean(1)
        sgn = np.sign(np.einsum('ij,ij->i', g - SP[ik[:, 0]], nm))
        sd_[s0:s0 + 400000] = dk[:, 0] * np.where(sgn == 0, 1, sgn)
        dz[s0:s0 + 400000] = dk[:, 0]
        ez[s0:s0 + 400000] = ease[ik[:, 0]]
        lz[s0:s0 + 400000] = SLc[ik[:, 0]]
    zone = (lz != code['head']) & (lz != code['forearm'])
    for sd in 'lr':
        m = lz == code['uparm_' + sd]
        s = (G[m] - arm[sd]['S']) @ arm[sd]['a']
        zone[np.where(m)[0][s > arm[sd]['cuff'] + 0.035]] = False
    # a shell near the skin only (the sign of a far point is unreliable); the inside is filled below
    near = dz < 0.075
    solid = (zone & near & (sd_ < ez)).reshape(n)
    solid = ndimage.binary_fill_holes(solid)
    # ── sleeves hang straight from the deltoid: a tube around the arm axis whose radius never
    # shrinks toward the cuff (the arm's widest section so far + the sleeve's ease)
    Gs = G.reshape(n[0], n[1], n[2], 3)
    for sd in 'lr':
        A = arm[sd]
        m = SL == 'uparm_' + sd
        w = SP[m] - A['S']; s = w @ A['a']
        perp = np.linalg.norm(w - s[:, None] * A['a'], axis=1)
        bins = np.arange(0.0, A['cuff'] + 0.05, 0.01)
        r = np.array([np.percentile(perp[(s >= b) & (s < b + 0.02)], 92) if ((s >= b) & (s < b + 0.02)).sum() > 8 else np.nan for b in bins])
        ok = np.isfinite(r); r = np.interp(bins, bins[ok], r[ok])
        s0 = P.get('sleeveHangFrom', 0.07)
        R = r.copy(); k0 = int(s0 / 0.01)
        R[k0:] = np.maximum.accumulate(r[k0:])
        R += e_arm0 + (e_arm1 - e_arm0) * smoothstep(0, A['cuff'], bins)
        wv = G - A['S']; sv = wv @ A['a']
        pv = np.linalg.norm(wv - sv[:, None] * A['a'], axis=1)
        Rv = np.interp(sv, bins, R)
        tube = (sv > s0 - 0.02) & (sv < A['cuff'] + 0.035) & (pv < Rv) & (G[:, 0] * (1 if sd == 'l' else -1) > 0.1)
        solid |= tube.reshape(n)
        arm[sd]['radius'] = float(R[int(A['cuff'] / 0.01)])
    # ── fabric hangs: below the armpits, the torso slice's convex hull, carried down to the hem
    from skimage.morphology import convex_hull_image
    torso_z = (zone & near & (sd_ < ez) & (lz <= code['neck'])).reshape(n)
    j_pit = int(np.clip(np.floor((y_pit - lo[1]) / h), 0, n[1] - 1))
    cum = np.zeros((n[0], n[2]), bool)
    drape = np.zeros_like(solid)
    for j in range(j_pit, -1, -1):
        sl = ndimage.binary_fill_holes(torso_z[:, j, :])
        if sl.any():
            lab2, nl = ndimage.label(sl)
            if nl > 1: sl = lab2 == (np.bincount(lab2.ravel())[1:].argmax() + 1)
            cum |= convex_hull_image(sl)
        drape[:, j, :] = cum
    dbg = os.environ.get('TEE_DEBUG_DIR')
    if dbg:
        from PIL import Image
        rows = []
        for yy in (1.5, 1.4, 1.3, 1.2, 1.1, 1.0):
            j = int(round((yy - lo[1]) / h))
            if not 0 <= j < n[1]: continue
            im = np.zeros((n[2], n[0], 3), np.uint8)
            im[..., 0] = solid[:, j, :].T * 255; im[..., 1] = torso_z[:, j, :].T * 255; im[..., 2] = drape[:, j, :].T * 255
            rows.append(im[::-1])
        Image.fromarray(np.concatenate(rows, 0)).resize((n[0] * 3, sum(r.shape[0] for r in rows) * 3), 0).save(os.path.join(dbg, 'tee_slices.png'))
    solid |= drape
    solid = ndimage.binary_fill_holes(solid)
    # a closed surface: nothing on the grid's border
    for ax in range(3):
        sl = [slice(None)] * 3
        for e in (slice(0, 3), slice(-3, None)):
            sl[ax] = e; solid[tuple(sl)] = False
    # the smoothed distance field of the volume → its surface
    sdf = (ndimage.distance_transform_edt(~solid) - ndimage.distance_transform_edt(solid)) * h
    sdf = ndimage.gaussian_filter(sdf, P.get('surfaceSmooth', 1.6))
    from skimage.measure import marching_cubes
    MV, MF, _, _ = marching_cubes(sdf, level=0.0, spacing=(h, h, h), gradient_direction='ascent')
    MV = MV + lo
    MV, MF = largest_component(MV, MF)
    # outward winding
    c = MV.mean(0)
    fn_ = np.cross(MV[MF[:, 1]] - MV[MF[:, 0]], MV[MF[:, 2]] - MV[MF[:, 0]])
    if (np.einsum('ij,ij->i', fn_, MV[MF].mean(1) - c) < 0).mean() > 0.5: MF = MF[:, ::-1]
    area = float(np.linalg.norm(fn_, axis=1).sum() / 2)
    edge = P.get('edge', 0.016)
    target = int(area / (edge * edge))
    log(f'tee surface {len(MV)} verts, area {area:.2f} m2 → {target} quads')

    # ── the openings: exact cuts
    def f_hem(X): return y_hem - X[:, 1]

    def f_cuff(sd):
        A = arm[sd]
        def f(X):
            w = X - A['S']
            s = w @ A['a']
            perp = np.linalg.norm(w - s[:, None] * A['a'], axis=1)
            side = X[:, 0] * (1 if sd == 'l' else -1) > 0.05
            return np.where(side & (perp < P.get('cuffZone', 0.13)) & (s > 0.02), s - A['cuff'], -1.0)
        return f

    def f_neck(X):
        q = np.sqrt((X[:, 0] / neck['hx']) ** 2 + ((X[:, 2] - neck['zc']) / neck['hz']) ** 2)
        return np.where(X[:, 1] > y_neck - 0.14, (1 - q) * min(neck['hx'], neck['hz']), -1.0)

    CUTS = (('hem', f_hem), ('cuff_l', f_cuff('l')), ('cuff_r', f_cuff('r')), ('neck', f_neck))

    def cut_all(V_, F_, tol):
        for name, fn_cut in CUTS:
            V_ = snap_to_cut(V_, fn_cut, tol)
            V_, F_ = clip_mesh(V_, F_, fn_cut(V_))
        return largest_component(V_, F_)

    def quads_to_tris(QV, QQ):
        tris = []
        for q in QQ:
            if q[3] < 0: tris.append(q[:3]); continue
            a, b, c_, d_ = q
            if np.linalg.norm(QV[a] - QV[c_]) <= np.linalg.norm(QV[b] - QV[d_]): tris += [[a, b, c_], [a, c_, d_]]
            else: tris += [[a, b, d_], [b, c_, d_]]
        TF_ = np.array(tris, np.int64); TV_ = QV.astype(np.float64)
        fn_ = np.cross(TV_[TF_[:, 1]] - TV_[TF_[:, 0]], TV_[TF_[:, 2]] - TV_[TF_[:, 0]])
        if (np.einsum('ij,ij->i', fn_, TV_[TF_].mean(1) - TV_.mean(0)) < 0).mean() > 0.5: TF_ = TF_[:, ::-1]
        return TV_, TF_

    def quadriflow(V_, F_, tgt, mode):
        with tempfile.TemporaryDirectory() as td:
            np.savez(os.path.join(td, 'in.npz'), V=V_, F=F_)
            script = os.path.join(os.path.dirname(__file__), 'quad_remesh_blender.py')
            r = subprocess.run([blender, '-b', '--factory-startup', '-P', script, '--', os.path.join(td, 'in.npz'), os.path.join(td, 'out.npz'), str(tgt), mode], capture_output=True, text=True)
            msg = ' | '.join(l for l in (r.stdout + r.stderr).splitlines() if 'quadriflow' in l.lower())[-400:]
            if not os.path.exists(os.path.join(td, 'out.npz')): log('quadriflow: ' + msg); return None
            R_ = np.load(os.path.join(td, 'out.npz'))
            if not bool(R_['ok']) or len(R_['Q']) > tgt * 2: log('quadriflow: ' + msg); return None
            return R_['V'], R_['Q']

    # 1. openings cut on the fine surface, then Quadriflow keeps them as its boundary: even quads
    #    right up to the hems (no slivers where a coarse mesh was cut)
    OV, OF = cut_all(MV, MF, 0.35 * h)
    OV, OF = clean_mesh(OV, OF, 0.3 * h, relax=0)
    ue_, c_ = mesh_edges(OF)
    log(f'fine open surface: {len(OF)} tris, non-manifold edges {(c_ > 2).sum()}, openings {boundary_loops(OF)[0]}')
    area_o = float(np.linalg.norm(np.cross(OV[OF[:, 1]] - OV[OF[:, 0]], OV[OF[:, 2]] - OV[OF[:, 0]]), axis=1).sum() / 2)
    got = quadriflow(OV, OF, int(area_o / (edge * edge)), 'open')
    if got is not None:
        TV, TF = quads_to_tris(*got)
        path = 'open'
        QQ = got[1]
    else:
        # 2. fallback: remesh the closed surface, then cut it
        got = quadriflow(MV, MF, target, 'closed')
        if got is None:
            dbg = os.environ.get('TEE_DEBUG_DIR')
            if dbg: np.savez(os.path.join(dbg, 'tee_mc.npz'), V=MV, F=MF)
            raise RuntimeError('quadriflow failed on the tee surface')
        TV, TF = quads_to_tris(*got)
        TV, TF = cut_all(TV, TF, P.get('snap', 0.35) * edge)
        path = 'closed+cut'
        QQ = got[1]
    log(f'tee remesh: {path}, {len(TF)} triangles, openings {boundary_loops(TF)[0]}')
    TV, TF = clean_mesh(TV, TF, 0.3 * edge)
    E_ = np.stack([np.linalg.norm(TV[TF[:, i]] - TV[TF[:, (i + 1) % 3]], axis=1) for i in range(3)], 1)
    log(f'tee cleaned: {len(TF)} tris, openings {boundary_loops(TF)[0]}, shortest edge {E_.min():.4f}')
    nloops, _ = boundary_loops(TF)
    info = dict(y_hem=float(y_hem), y_top=float(TV[:, 1].max()), y_pit=y_pit, y_chest=float(y_ch), y_shoulder=float(y_sh), neck=neck, openings=int(nloops),
                arms={sd: dict(S=arm[sd]['S'].tolist(), a=arm[sd]['a'].tolist(), cuff=arm[sd]['cuff']) for sd in 'lr'}, remeshQuads=int(len(QQ)), remesh=path)
    if nloops != 4:
        log(f'WARNING: tee has {nloops} openings (expected 4: hem, neck, 2 cuffs)')
    return TV, TF, info


def tee_uv(TV, TF, info, zref):
    """Front | back panels (planar, so prints read straight): each face goes to the panel its centre
    is on (zref(p): the body's mid-plane depth at p); vertices on the side seams are split."""
    cen = TV[TF].mean(1)
    front = cen[:, 2] > zref(cen)
    W = np.abs(TV[:, 0]).max() * 1.04
    ytop, yb = info['y_top'] + 0.005, info['y_hem']
    Vt, UV, Ft = [], [], np.zeros_like(TF)
    index = {}
    for fi, tri in enumerate(TF):
        pnl = 0 if front[fi] else 1
        for k, v in enumerate(tri):
            key = (int(v), pnl)
            if key not in index:
                index[key] = len(Vt)
                p = TV[v]
                Vt.append(p)
                u = 0.25 + 0.245 * p[0] / W if pnl == 0 else 0.75 - 0.245 * p[0] / W
                UV.append([u, (ytop - p[1]) / (ytop - yb)])
            Ft[fi, k] = index[key]
    uvinfo = dict(W=float(W), ytop=float(ytop), ybottom=float(yb))
    return np.array(Vt), np.array(UV), Ft, uvinfo
