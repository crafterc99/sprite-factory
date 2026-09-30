"""
Fit MHR's parametric body (shape 45 + bone scales + pose, incl. fingers) to a character mesh.

  python fit_mhr.py <export_dir: mesh.npz from glb_load.py> <out_dir> [--iters-a 250 --iters-b 250 --iters-c 150]

The mesh: y up, facing +Z, metres, any pose (T / A). MHR has no global scale, so the fit also
solves a uniform scale g (MHR cm → mesh cm) and a translation.

Loss: two-way chamfer between the MHR LBS surface (no pose correctives: the game skins with plain
LBS) and the mesh, correspondences searched in 6-D [p, λ·n] (a surface only matches surface facing
the same way), Huber-robust (clothes stand off the body); + fingertip / head-top landmarks
(stage A only, to get the arms and height in range); + priors: pose L2 (per group), MHR's own
parameter limits as hinge penalties (the "flexible" length DOFs are pinned to 0 as MHR's limits
say), bone-scale L2, left/right hand-scale symmetry, shape L2.

Stages: A body (no fingers) + landmarks · B everything, hands weighted up · C hands only (local
chamfer between the MHR hand and the mesh's hand region).
Output: <out_dir>/fit.npz (+ fit.json report, diagnostic PNGs).
"""
import argparse, json, os, sys, time, warnings, re
import numpy as np
import torch
from scipy.spatial import cKDTree

warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ap = argparse.ArgumentParser()
ap.add_argument('exp'); ap.add_argument('out')
ap.add_argument('--model', default=os.environ.get('MHR_MODEL') or f'{REPO}/assets/_models/mhr/assets/mhr_model.pt')
ap.add_argument('--modeldef', default=os.environ.get('MHR_MODELDEF') or f'{REPO}/assets/_models/mhr/assets/compact_v6_1.model')
ap.add_argument('--iters-a', type=int, default=250)
ap.add_argument('--iters-b', type=int, default=250)
ap.add_argument('--iters-c', type=int, default=150)
ap.add_argument('--samples', type=int, default=40000)
ap.add_argument('--hand-weight', type=float, default=4.0)
ap.add_argument('--no-plots', action='store_true')
ap.add_argument('--cloth', type=int, default=1, help='1: tight/loose surface from the texture (clothes only bound the body)')
ap.add_argument('--loose-w', type=float, default=0.1, help='weight of loose-cloth surface in the two-way terms')
ap.add_argument('--freeze', default='', help='comma-separated MHR parameters held at 0 (e.g. l_knee_bend,r_knee_bend: straight rest knees)')
ap.add_argument('--threads', type=int, default=0)
ap.add_argument('--sole-cm', type=float, default=0.0, help='shoes: the body\'s soles stand this far above the mesh floor (insole height); 0 = off')
ap.add_argument('--leg-ratio-w', type=float, default=0.0, help='prior keeping thigh/shin (scale_uplegs − scale_lowlegs) at MHR\'s ratio')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
torch.manual_seed(0); np.random.seed(0)
torch.set_num_threads(a.threads or max(1, os.cpu_count() - 1))
T0 = time.time()

# ── MHR ─────────────────────────────────────────────────────────────────────
m = torch.jit.load(a.model, map_location='cpu')
ch = m.character_torch
names = json.load(open(f'{REPO}/scripts/mhr/joint_names.json'))
JI = {n: i for i, n in enumerate(names)}
PN = []
LIM = {}
sect = None
for l in open(a.modeldef):
    if l.startswith('['):
        sect = l.strip()
        continue
    body = l.split('#')[0]
    if sect == '[ParameterTransform]' and '=' in body:
        for tok in body.split('=')[1].replace('+', ' ').split():
            if tok[0].isalpha() and tok not in PN:
                PN.append(tok)
    if sect == '[Limits]' and body.strip().startswith('limit'):
        mm = re.match(r'\s*limit\s+(\S+)\s+minmax\s+\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]', body)
        if mm:
            LIM[mm.group(1)] = (float(mm.group(2)), float(mm.group(3)))
assert len(PN) == 204, len(PN)
PI = {n: i for i, n in enumerate(PN)}
SCALE = ch.parameter_transform.scaling_parameters.numpy()[:204].astype(bool)
PINNED = np.array([(n in LIM and LIM[n][0] == 0 and LIM[n][1] == 0) or n in a.freeze.split(',') for n in PN])   # MHR says: keep 0 (+ --freeze)
FINGER = np.array([bool(re.match(r'^[lr]_(thumb|index|middle|ring|pinky)\d', n)) for n in PN])
FINGER_SCALE = np.array([bool(re.match(r'^scale_[lr]_(thumb|index|middle|ring|pinky)', n)) for n in PN])
lo = torch.tensor([LIM.get(n, (-1e9, 1e9))[0] for n in PN]); hi = torch.tensor([LIM.get(n, (-1e9, 1e9))[1] for n in PN])
HASLIM = torch.tensor([n in LIM and not PINNED[i] for i, n in enumerate(PN)])

lbs = ch.linear_blend_skinning
NVB = int(lbs.vert_indices_flattened.max()) + 1
Wm = np.zeros((NVB, 127), np.float32)
np.add.at(Wm, (lbs.vert_indices_flattened.numpy(), lbs.skin_indices_flattened.numpy()), lbs.skin_weights_flattened.numpy())
Wm /= Wm.sum(1, keepdims=True)
FB = ch.mesh.faces.numpy().astype(np.int64)
isfinger_j = np.array([bool(re.search(r'(thumb|index|middle|ring|pinky)', n)) for n in names])
ishand_j = isfinger_j | np.array([n in ('l_wrist', 'r_wrist') for n in names])
HANDV = {s: (Wm[:, [j for j in range(127) if ishand_j[j] and names[j].startswith(s + '_')]].sum(1) > 0.5) for s in 'lr'}
HANDV_ANY = HANDV['l'] | HANDV['r']
HEADV = Wm[:, [JI[n] for n in names if n.startswith('c_head') or 'eye' in n or 'jaw' in n or 'teeth' in n or 'tongue' in n]].sum(1) > 0.5


def vnormals_t(X, F):
    fn = torch.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]], dim=1)
    n = torch.zeros_like(X)
    for q in range(3):
        n = n.index_add(0, torch.as_tensor(F[:, q]), fn)
    return n / n.norm(dim=1, keepdim=True).clamp_min(1e-9)


def vnormals(X, F):
    return vnormals_t(torch.as_tensor(X, dtype=torch.float64), F).numpy()


def varea(X, F):
    A = 0.5 * np.linalg.norm(np.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]]), axis=1)
    out = np.zeros(len(X))
    for q in range(3):
        np.add.at(out, F[:, q], A / 3)
    return out


# ── the character mesh (cm) ─────────────────────────────────────────────────
E = np.load(os.path.join(a.exp, 'mesh.npz'))
P = E['pos'].astype(np.float64) * 100.0
T = E['tri'].astype(np.int64)
# weld on position (UV seams) for the surface
key = np.round(P * 1e3).astype(np.int64)
_, weld, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
inv = inv.ravel()
PW = P[weld]; TW = inv[T]; TW = TW[(TW[:, 0] != TW[:, 1]) & (TW[:, 1] != TW[:, 2]) & (TW[:, 0] != TW[:, 2])]
NW = vnormals(PW, TW)
# area-uniform samples + their face normals
fa = 0.5 * np.linalg.norm(np.cross(PW[TW[:, 1]] - PW[TW[:, 0]], PW[TW[:, 2]] - PW[TW[:, 0]]), axis=1)
fi = np.random.choice(len(TW), a.samples, p=fa / fa.sum())
r1, r2 = np.random.rand(a.samples, 1), np.random.rand(a.samples, 1)
s1 = np.sqrt(r1)
X = (1 - s1) * PW[TW[fi, 0]] + s1 * (1 - r2) * PW[TW[fi, 1]] + s1 * r2 * PW[TW[fi, 2]]
fnrm = np.cross(PW[TW[fi, 1]] - PW[TW[fi, 0]], PW[TW[fi, 2]] - PW[TW[fi, 0]]); fnrm /= np.maximum(1e-12, np.linalg.norm(fnrm, axis=1, keepdims=True))
XN = fnrm
# tight vs loose surface: skin (by the baked texture's colour), the head (hair is on the skull)
# and the socks (below the shorts, above the shoes) are tight; shirt, shorts, shoes are loose —
# the body fits tight surface both ways, and only has to stay inside loose clothing
H = P[:, 1].max() - P[:, 1].min()
TIGHT_W = np.ones(len(PW), bool)
if a.cloth and os.path.exists(os.path.join(a.exp, 'tex', 'baseColor.png')):
    from PIL import Image
    import colorsys
    Image.MAX_IMAGE_PIXELS = None
    im = np.asarray(Image.open(os.path.join(a.exp, 'tex', 'baseColor.png')).convert('RGB')).astype(np.float32) / 255
    UVw = E['uv'][weld]
    px = np.clip((UVw[:, 0] * (im.shape[1] - 1)).astype(int), 0, im.shape[1] - 1)
    py = np.clip(((1 - UVw[:, 1]) * (im.shape[0] - 1)).astype(int), 0, im.shape[0] - 1)
    c = im[py, px]
    mx, mn = c.max(1), c.min(1)
    sat = (mx - mn) / np.maximum(1e-6, mx)
    hue = np.array([colorsys.rgb_to_hsv(*x)[0] for x in c])
    skin = (hue > 0.005) & (hue < 0.12) & (sat > 0.3) & (mx > 0.2) & (mx < 0.85)
    y0 = P[:, 1].min()
    yr = (PW[:, 1] - y0) / H
    head = yr > 0.84                       # above the neck (1.92 m: > 161 cm)
    socks = (yr > 0.11) & (yr < 0.225)     # 21–43 cm: between the shoe collars and the shorts' hem
    TIGHT_W = skin | head | socks
    print(f'tight surface: {TIGHT_W.mean() * 100:.1f} % of vertices (skin {skin.mean() * 100:.1f} %)')
tight_s = TIGHT_W[TW[fi]].sum(1) >= 2
# plus the vertices (dense detail where the mesh has it: hands, face)
X = np.r_[X, PW]; XN = np.r_[XN, NW]
TIGHT = np.r_[tight_s, TIGHT_W]
Xt = torch.tensor(X, dtype=torch.float32)
XNt = torch.tensor(XN, dtype=torch.float32)
print(f'mesh: {len(P)} verts ({len(PW)} welded), {len(T)} tris, height {H:.1f} cm, samples {len(X)}')

# mesh landmarks: fingertips (extreme ±x), head top, toe tips / heels
iL, iR = np.argmax(PW[:, 0]), np.argmin(PW[:, 0])
iTop = np.argmax(PW[:, 1])
LMK_mesh = {'l_tip': PW[iL], 'r_tip': PW[iR], 'top': PW[iTop]}
print('landmarks', {k: v.round(1).tolist() for k, v in LMK_mesh.items()})

# ── parameters ──────────────────────────────────────────────────────────────
Z = torch.zeros
with torch.no_grad():
    V0, S0 = m(Z(1, 45), Z(1, 204), Z(1, 72), False)
V0 = V0[0].numpy(); S0 = S0[0].numpy()
iTopB = int(np.argmax(np.where(HEADV, V0[:, 1], -1e9)))
AREA_B = torch.tensor(varea(V0, FB), dtype=torch.float32); AREA_B /= AREA_B.mean()
SOLEV = torch.tensor(np.where(V0[:, 1] < V0[:, 1].min() + 1.0)[0])      # MHR's plantar surface (rest)
FLOOR = float(P[:, 1].min())

beta = Z(1, 45, requires_grad=True)
theta = Z(1, 204)
theta[0, PI['l_uparm_ry']] = 0.8; theta[0, PI['r_uparm_ry']] = 0.8     # MHR's A-pose → T-pose (arms up ~46°)
theta.requires_grad_(True)
g = torch.tensor(H / (V0[:, 1].max() - V0[:, 1].min()), requires_grad=True)       # uniform scale MHR → mesh
tr = torch.tensor(((P.max(0) + P.min(0)) / 2 - (V0.max(0) + V0.min(0)) / 2 * float(g)).astype(np.float32), requires_grad=True)
tr.data[1] = float(P[:, 1].min() - V0[:, 1].min() * float(g))
FREE = torch.tensor(~PINNED)


def fwd(th, be):
    V, S = m(be, th * FREE, Z(1, 72), False)
    return V[0] * g + tr, S[0]


def huber(d, delta):
    return torch.where(d < delta, 0.5 * d * d / delta, d - 0.5 * delta)


LAM = 3.0   # cm per unit normal difference in the 6-D correspondence search
treeX = cKDTree(np.c_[X, LAM * XN])
w_x = np.ones(len(X), np.float32)
W_X = torch.tensor(w_x)
HAND_X = np.zeros(len(X), bool)


def chamfer(V, only_hands=False, hand_w=1.0):
    Vd = V.detach().numpy().astype(np.float64)
    Nb = vnormals(Vd, FB)
    # body → mesh (every body vertex finds the mesh surface facing its way)
    selB = np.where(HANDV_ANY)[0] if only_hands else np.arange(len(Vd))
    _, jb = treeX.query(np.c_[Vd[selB], LAM * Nb[selB]], k=1)
    dv = V[selB] - Xt[jb]
    dbm = dv.norm(dim=1)
    # tight surface: the body lies on it; loose cloth: the body must not poke out (signed
    # distance along the cloth's normal > 0), a weak pull otherwise
    tb = torch.tensor(TIGHT[jb])
    out = torch.relu((dv * XNt[jb]).sum(1))
    per_b = torch.where(tb, huber(dbm, 3.0), 2.0 * huber(out, 1.0) + a.loose_w * huber(dbm, 3.0))
    wb = AREA_B[selB] * torch.tensor(np.where(HANDV_ANY[selB], hand_w, 1.0), dtype=torch.float32)
    l_bm = (per_b * wb).sum() / wb.sum()
    # mesh → body
    treeB = cKDTree(np.c_[Vd[selB], LAM * Nb[selB]])
    selX = np.where(HAND_X)[0] if only_hands else np.arange(len(X))
    _, jx = treeB.query(np.c_[X[selX], LAM * XN[selX]], k=1)
    dmb = (Xt[selX] - V[selB][jx]).norm(dim=1)
    wx = torch.tensor(np.where(HAND_X[selX], hand_w, 1.0) * np.where(TIGHT[selX], 1.0, a.loose_w), dtype=torch.float32)
    l_mb = (huber(dmb, 1.5) * wx).sum() / wx.sum()
    tm = torch.tensor(TIGHT[selX])
    return l_mb, l_bm, float(dmb[tm].mean()) if tm.any() else float(dmb.mean()), float(dbm[tb].mean()) if tb.any() else float(dbm.mean())


PRIOR_W = np.full(204, 0.02)
for i, n in enumerate(PN):
    if re.match(r'^[lr]_(uparm|clavicle|elbow|lowarm|wrist)', n): PRIOR_W[i] = 0.002
    if re.match(r'^(root_)', n): PRIOR_W[i] = 0.0
    if FINGER[i]: PRIOR_W[i] = 0.01
    if re.match(r'^(spine|neck|head)', n): PRIOR_W[i] = 0.05
    if 'flexible' in n: PRIOR_W[i] = 0.2
    if SCALE[i]: PRIOR_W[i] = 0.002 if not FINGER_SCALE[i] else 0.02
PRIOR_W = torch.tensor(PRIOR_W, dtype=torch.float32)
theta0 = theta.detach().clone()
PAIRS = [(PI[n], PI['scale_r' + n[7:]]) for n in PN if n.startswith('scale_l_')]


def priors(th, be):
    d = (th[0] - theta0[0]) * FREE
    lp = (PRIOR_W * d * d).sum()
    lim = (torch.relu(lo - th[0]) + torch.relu(th[0] - hi)) * HASLIM
    ll = 10.0 * (lim * lim).sum()
    sym = sum((th[0, i] - th[0, j]) ** 2 for i, j in PAIRS) * 0.05
    lb = 0.002 * (be * be).sum()
    lr = a.leg_ratio_w * (th[0, PI['scale_uplegs']] - th[0, PI['scale_lowlegs']]) ** 2
    return lp + ll + sym + lb + lr


def run(stage, iters, mask, lr, lmk_w=0.0, only_hands=False, hand_w=1.0, lr_beta=0.03, lr_g=0.0005, lr_t=0.1):
    maskt = torch.tensor(mask)
    params = [{'params': [theta], 'lr': lr}]
    if lr_beta: params.append({'params': [beta], 'lr': lr_beta})
    if lr_g: params.append({'params': [g], 'lr': lr_g})
    if lr_t: params.append({'params': [tr], 'lr': lr_t})
    opt = torch.optim.Adam(params)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, iters, eta_min=lr * 0.1)
    for it in range(iters):
        V, S = fwd(theta, beta)
        l_mb, l_bm, dmb, dbm = chamfer(V, only_hands, hand_w)
        loss = l_mb + l_bm + priors(theta, beta)
        if a.sole_cm > 0:
            loss = loss + 0.5 * torch.relu(FLOOR + a.sole_cm - V[SOLEV, 1]).pow(2).mean()
        if lmk_w:
            J = S[:, :3] * g + tr
            lm = ((J[JI['l_middle_null']] - torch.tensor(LMK_mesh['l_tip'], dtype=torch.float32)).norm()
                  + (J[JI['r_middle_null']] - torch.tensor(LMK_mesh['r_tip'], dtype=torch.float32)).norm()
                  + (V[iTopB, 1] - float(LMK_mesh['top'][1])).abs())
            loss = loss + lmk_w * lm
        opt.zero_grad(); loss.backward()
        theta.grad *= maskt
        opt.step(); sched.step()
        with torch.no_grad():
            g.clamp_(0.5, 2.0)
        if it % 25 == 0 or it == iters - 1:
            print(f'[{stage}] it {it:4d} loss {float(loss):.3f}  mesh→body {dmb:.2f} cm  body→mesh {dbm:.2f} cm  g {float(g):.4f}  t {time.time() - T0:.0f}s', flush=True)


# ── stage A: body, no fingers, + landmarks ───────────────────────────────────
maskA = ~FINGER & ~FINGER_SCALE & ~PINNED
run('A', a.iters_a, maskA, lr=0.02, lmk_w=0.3, lr_t=0.2)

# the mesh's hand region: mesh samples whose nearest fitted body point is on a hand
with torch.no_grad():
    V, S = fwd(theta, beta)
Vd = V.numpy().astype(np.float64)
_, jj = cKDTree(Vd).query(X, k=1)
HAND_X[:] = HANDV_ANY[jj]
# (and anything beyond the wrists along the arm: fingertips never go astray)
for s, sg in (('l', 1), ('r', -1)):
    wr = (S[JI[f'{s}_wrist'], :3] * g + tr).detach().numpy()
    HAND_X |= (sg * (X[:, 0] - wr[0]) > 0) & (np.abs(X[:, 1] - wr[1]) < 15)
print('hand-region mesh samples', int(HAND_X.sum()))

# ── stage B: everything, hands weighted up ───────────────────────────────────
maskB = ~PINNED
run('B', a.iters_b, maskB, lr=0.01, lmk_w=0.0, hand_w=a.hand_weight, lr_beta=0.02, lr_g=0.0002, lr_t=0.05)

# ── stage C: hands only (wrist, fingers, hand scales) ────────────────────────
maskC = FINGER | FINGER_SCALE | np.array([bool(re.match(r'^([lr]_(wrist|lowarm_twist)|scale_[lr]_hands)', n)) for n in PN])
run('C', a.iters_c, maskC & ~PINNED, lr=0.01, only_hands=True, hand_w=1.0, lr_beta=0, lr_g=0, lr_t=0)

# ── results ─────────────────────────────────────────────────────────────────
with torch.no_grad():
    Vf, Sf = fwd(theta, beta)
    thr = (theta * FREE).clone(); thr[0, ~torch.tensor(SCALE)] = 0      # same body, zero pose (MHR rest)
    Vr, Sr = m(beta, thr, Z(1, 72), False)
Vf = Vf.detach().numpy(); Sf = Sf.detach().numpy(); Vr = (Vr[0] * g + tr).detach().numpy(); Sr = Sr[0].detach().numpy()
gg, tt = float(g), tr.detach().numpy()


def to_mesh(S):     # skeleton state (MHR cm) → mesh cm
    o = S.copy(); o[:, :3] = S[:, :3] * gg + tt; return o


Sf_m, Sr_m = to_mesh(Sf), to_mesh(Sr)
# residuals (cm): plain 3-D nearest distances both ways, all / by region
dmb, _ = cKDTree(Vf).query(PW, k=1)
dbm, _ = cKDTree(PW).query(Vf, k=1)
_, jj = cKDTree(Vf).query(PW, k=1)
hand_m = HANDV_ANY[jj]; head_m = HEADV[jj]
Jm = Sf_m[:, :3]
jd = lambda p, q: round(float(np.linalg.norm(Jm[JI[p]] - Jm[JI[q]])), 1)
y0m = P[:, 1].min()
rep = {
    'meshToBodyCm': {'mean': round(float(dmb.mean()), 2), 'median': round(float(np.median(dmb)), 2), 'p95': round(float(np.percentile(dmb, 95)), 2),
                     'tight': round(float(dmb[TIGHT_W].mean()), 2), 'loose': round(float(dmb[~TIGHT_W].mean()), 2) if (~TIGHT_W).any() else None,
                     'hands': round(float(dmb[hand_m].mean()), 2), 'head': round(float(dmb[head_m].mean()), 2), 'rest': round(float(dmb[~hand_m & ~head_m].mean()), 2)},
    'segmentsCm': {'thigh': [jd('l_upleg', 'l_lowleg'), jd('r_upleg', 'r_lowleg')], 'shin': [jd('l_lowleg', 'l_foot'), jd('r_lowleg', 'r_foot')],
                   'upperArm': [jd('l_uparm', 'l_lowarm'), jd('r_uparm', 'r_lowarm')], 'forearm': [jd('l_lowarm', 'l_wrist'), jd('r_lowarm', 'r_wrist')],
                   'hand': [jd('l_wrist', 'l_middle_null'), jd('r_wrist', 'r_middle_null')], 'hipJoints': jd('l_upleg', 'r_upleg'), 'shoulderJoints': jd('l_uparm', 'r_uparm'),
                   'kneeHeight': round(float((Jm[JI['l_lowleg'], 1] + Jm[JI['r_lowleg'], 1]) / 2 - y0m), 1), 'hipHeight': round(float((Jm[JI['l_upleg'], 1] + Jm[JI['r_upleg'], 1]) / 2 - y0m), 1),
                   'ankleHeight': round(float((Jm[JI['l_foot'], 1] + Jm[JI['r_foot'], 1]) / 2 - y0m), 1), 'neckHeight': round(float(Jm[JI['c_neck'], 1] - y0m), 1), 'heightCm': round(float(H), 1)},
    'bodyToMeshCm': {'mean': round(float(dbm.mean()), 2), 'median': round(float(np.median(dbm)), 2), 'p95': round(float(np.percentile(dbm, 95)), 2),
                     'hands': round(float(dbm[HANDV_ANY].mean()), 2), 'head': round(float(dbm[HEADV].mean()), 2)},
    'chamferCm': round(float(dmb.mean() + dbm.mean()) / 2, 2),
    'globalScale': round(gg, 4), 'shapeNorm': round(float(beta.norm()), 3),
    'scales': {n: round(float(theta[0, i]), 3) for i, n in enumerate(PN) if SCALE[i] and not FINGER_SCALE[i]},
    'pose': {n: round(float(theta[0, i]), 3) for i, n in enumerate(PN) if not SCALE[i] and not FINGER[i] and not PINNED[i] and abs(float(theta[0, i])) > 0.02},
    'seconds': round(time.time() - T0, 1),
}
np.savez(os.path.join(a.out, 'fit.npz'), beta=beta.detach().numpy(), theta=(theta * FREE).detach().numpy(), g=gg, t=tt,
         Vf=Vf, Sf=Sf_m, Vr=Vr, Sr=Sr_m, Wm=Wm, FB=FB, S0=S0)
json.dump(rep, open(os.path.join(a.out, 'fit.json'), 'w'), indent=1)
print(json.dumps(rep, indent=1))

if not a.no_plots:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    parents = ch.skeleton.joint_parents.numpy()
    def plot(ax, i0, i1, sel=None, title=''):
        Q = PW if sel is None else PW[sel]
        B = Vf if sel is None else Vf
        ax.scatter(Q[:, i0], Q[:, i1], s=0.05, c='#999')
        ax.scatter(Vf[:, i0], Vf[:, i1], s=0.05, c='#e33', alpha=0.4)
        J = Sf_m[:, :3]
        for j in range(127):
            if parents[j] >= 0:
                ax.plot([J[j, i0], J[parents[j], i0]], [J[j, i1], J[parents[j], i1]], c='#03c', lw=0.8)
        ax.scatter(J[:, i0], J[:, i1], s=3, c='#03c')
        ax.set_aspect('equal'); ax.set_title(title)
    fig, axs = plt.subplots(1, 2, figsize=(22, 12))
    plot(axs[0], 0, 1, title='front (x,y): mesh grey, MHR fit red, skeleton blue')
    plot(axs[1], 2, 1, title='side (z,y)')
    fig.savefig(os.path.join(a.out, 'fit_body.png'), dpi=90, bbox_inches='tight')
    for s in 'lr':
        w = Sf_m[JI[f'{s}_wrist'], :3]
        fig, axs = plt.subplots(1, 2, figsize=(18, 9))
        for ax, (i0, i1, ttl) in zip(axs, [(0, 2, 'top (x,z)'), (0, 1, 'front (x,y)')]):
            selP = np.linalg.norm(PW - w, axis=1) < 25; selV = np.linalg.norm(Vf - w, axis=1) < 25
            ax.scatter(PW[selP, i0], PW[selP, i1], s=0.5, c='#888')
            ax.scatter(Vf[selV, i0], Vf[selV, i1], s=0.5, c='#e33', alpha=0.5)
            J = Sf_m[:, :3]
            for j in range(127):
                if parents[j] >= 0 and np.linalg.norm(J[j] - w) < 25:
                    ax.plot([J[j, i0], J[parents[j], i0]], [J[j, i1], J[parents[j], i1]], c='#03c', lw=1)
            ax.set_aspect('equal'); ax.set_title(f'{s} hand {ttl}')
        fig.savefig(os.path.join(a.out, f'fit_hand_{s}.png'), dpi=90, bbox_inches='tight')
    print('plots written')
