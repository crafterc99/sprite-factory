"""
Rig a generated character mesh (glb_export.py output) on the performer's MHR
skeleton, for the 3D court.

  1. Orient + scale the mesh onto the performer's MHR body (bake_rig.py rig:
     their shape and bone scales): height, floor, centre, best of 4 yaws.
  2. Fit MHR's pose to the mesh (torch, Adam): two-way chamfer between the MHR
     surface and the mesh + a pose prior; bone scales stay the performer's.
  3. Skin weights from the fitted MHR surface (inverse distance, k nearest),
     smoothed over the mesh surface.
  4. Un-pose the mesh into MHR's rest pose (inverse of the blended joint
     transforms), so it binds exactly like the MHR body rig.
  5. Rig JSON (kind 'mhr', parts: [one textured part]) — the base rig's
     skeleton block, floor on the lowest point of the mesh (the soles).

usage: python fit_generated.py <export_dir> <base_rig.json.gz> <out.json.gz> <tex_url_prefix> [--iters 300]
"""
import sys, json, gzip, base64, argparse, warnings
import numpy as np
import torch

warnings.filterwarnings('ignore')
ap = argparse.ArgumentParser()
ap.add_argument('exp'); ap.add_argument('base'); ap.add_argument('out'); ap.add_argument('url')
ap.add_argument('--iters', type=int, default=300)
ap.add_argument('--raw', default=None, help='analysed raw.json (MHR shape + bone scales of the performer)')
ap.add_argument('--bind', choices=['fitted', 'rest'], default='fitted',
                help="fitted: bind the skeleton in the pose fitted to the mesh (mesh used as generated, no un-posing); rest: un-pose into MHR's rest pose")
a = ap.parse_args()
torch.manual_seed(0); np.random.seed(0)

HERE = __file__.rsplit('/', 1)[0]
names = json.load(open(f'{HERE}/joint_names.json'))
m = torch.jit.load(f'{HERE}/assets/mhr_model.pt', map_location='cpu')
ch = m.character_torch
pt = ch.parameter_transform
scaling = torch.tensor(pt.scaling_parameters.numpy()[:204])

# the performer (same inputs as bake_rig.py)
raw = json.load(open(a.raw))
frames = [f for f in raw['frames'] if f.get('mhr') and not f.get('error')]
shape = torch.tensor(np.median(np.array([f['mhr']['shape'] for f in frames], np.float32), 0))[None]
model = np.median(np.array([f['mhr']['model'] for f in frames], np.float32), 0)
p0 = torch.zeros(1, 204)
p0[0, scaling] = torch.tensor(model)[scaling]
expr = torch.zeros(1, 72)

with torch.no_grad():
    V0, S0 = m(shape, p0, expr, False)            # rest (bind) pose, cm
V0 = V0[0]; S0 = S0[0].numpy()
base = json.load(gzip.open(a.base, 'rt'))
bv = np.frombuffer(base64.b64decode(base['verts']), np.float32).reshape(-1, 3)
# model cm → rig metres: rig = k · v + c (bake_rig: /100, floor, height scale)
k = float((bv[:, 1].max() - bv[:, 1].min()) / (V0[:, 1].max() - V0[:, 1].min()))
c = bv.mean(0) - k * V0.numpy().mean(0)
assert np.abs(k * V0.numpy() + c - bv).max() < 1e-3, 'base rig does not match the performer model'
assert np.abs(k * S0[:, :3] + c - np.array(base['mhr']['bindPos'])).max() < 1e-3, 'base rig skeleton does not match'

# ── 1. the mesh onto the MHR body ────────────────────────────────────────────
E = np.load(a.exp + '/mesh.npz')
P = E['pos'].astype(np.float64); UV = E['uv']; T = E['tri']
info = json.load(open(a.exp + '/mesh.json'))
v0 = V0.numpy()
hM = v0[:, 1].max() - v0[:, 1].min()
P = (P - [0, P[:, 1].min(), 0]) * (hM / (P[:, 1].max() - P[:, 1].min())) + [0, v0[:, 1].min(), 0]
P[:, [0, 2]] += v0[:, [0, 2]].mean(0) - P[:, [0, 2]].mean(0)
sub = lambda X, n: X[np.random.choice(len(X), min(n, len(X)), replace=False)]


def chamfer_np(A, B):
    A, B = torch.tensor(sub(A, 4000), dtype=torch.float32), torch.tensor(sub(B, 4000), dtype=torch.float32)
    d = torch.cdist(A, B)
    return float(d.min(1).values.mean() + d.min(0).values.mean())


def yaw(X, ang):
    cth, sth = np.cos(ang), np.sin(ang); cx, cz = v0[:, 0].mean(), v0[:, 2].mean()
    Y = X.copy(); x, z = X[:, 0] - cx, X[:, 2] - cz
    Y[:, 0] = cx + cth * x + sth * z; Y[:, 2] = cz - sth * x + cth * z
    return Y


cands = [(chamfer_np(yaw(P, t), v0), t) for t in (0, np.pi / 2, np.pi, -np.pi / 2)]
best = min(cands)
P = yaw(P, best[1])
print('yaw', round(float(np.degrees(best[1]))), 'initial chamfer cm', round(best[0], 2))

# ── 2. fit MHR's pose (and a small global shift) to the mesh ─────────────────
Pt = torch.tensor(P, dtype=torch.float32)
pose = torch.zeros(1, 204, requires_grad=True)
free = ~scaling
opt = torch.optim.Adam([pose], lr=0.02)
for it in range(a.iters):
    prm = p0 + pose * free
    V, _ = m(shape, prm, expr, False)
    V = V[0]
    A = Pt[torch.randint(len(Pt), (5000,))]
    B = V[torch.randint(len(V), (5000,))]
    d = torch.cdist(A, B)
    # mesh → body is robust (clothes stand off the body); body → mesh pulls limbs into sleeves / legs
    l_mb = torch.nn.functional.huber_loss(d.min(1).values, torch.zeros(len(A)), delta=3.0)
    l_bm = d.min(0).values.mean()
    loss = l_mb + l_bm + 0.02 * (pose[0, free] ** 2).sum()
    opt.zero_grad(); loss.backward(); opt.step()
    if it % 50 == 0 or it == a.iters - 1:
        print(f'it {it} mesh→body {float(d.min(1).values.mean()):.2f} cm  body→mesh {float(l_bm):.2f} cm')
with torch.no_grad():
    Vf, Sf = m(shape, p0 + pose * free, expr, False)
Vf = Vf[0].numpy(); Sf = Sf[0].numpy()

# ── 3. skin weights from the fitted MHR surface ──────────────────────────────
lbs = ch.linear_blend_skinning
NV = v0.shape[0]
Wm = np.zeros((NV, 127), np.float32)
np.add.at(Wm, (lbs.vert_indices_flattened.numpy(), lbs.skin_indices_flattened.numpy()), lbs.skin_weights_flattened.numpy())
Wm /= Wm.sum(1, keepdims=True)
Vft = torch.tensor(Vf)


def vnormals(X, F):
    n = np.zeros_like(X, dtype=np.float64)
    fn = np.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]])
    for q in range(3): np.add.at(n, F[:, q], fn)
    return n / np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))


# normal-aware nearest body points: a vertex takes weights only from body
# surface facing the same way (a thigh's side never takes the palm hanging next
# to it, a torso side never takes the inner arm): 6-D distance [p, λ·n]
LAM = 3.0   # cm per unit of normal difference (opposite normals ≈ 6 cm apart)
nP = vnormals(P, T)
nV = vnormals(Vf.astype(np.float64), ch.mesh.faces.numpy().astype(np.int64))
Vft = torch.tensor(np.c_[Vf, LAM * nV], dtype=torch.float32)
acc = np.zeros((len(P), 127), np.float32)
KN = 6
for s0 in range(0, len(P), 4096):
    d = torch.cdist(torch.tensor(np.c_[P[s0:s0 + 4096], LAM * nP[s0:s0 + 4096]], dtype=torch.float32), Vft)
    dd, ii = d.topk(KN, largest=False)
    w = 1 / (dd.numpy() + 0.4) ** 2; w /= w.sum(1, keepdims=True)
    acc[s0:s0 + 4096] = np.einsum('nk,nkj->nj', w, Wm[ii.numpy()])
# smooth over the surface (UV-seam duplicates count as one vertex)
keyv = np.round(P / 0.05).astype(np.int64)
_, grp = np.unique(keyv, axis=0, return_inverse=True); grp = grp.ravel()
G = grp.max() + 1
g = np.zeros((G, 127), np.float32); np.add.at(g, grp, acc); g /= np.maximum(1e-8, g.sum(1, keepdims=True))
e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]).astype(np.int64)
e = np.unique(np.sort(grp[e], 1), axis=0); e = e[e[:, 0] != e[:, 1]]
deg = np.zeros(G); np.add.at(deg, e[:, 0], 1); np.add.at(deg, e[:, 1], 1)
for _ in range(6):
    nb = np.zeros_like(g); np.add.at(nb, e[:, 0], g[e[:, 1]]); np.add.at(nb, e[:, 1], g[e[:, 0]])
    g = np.where(deg[:, None] > 0, 0.5 * g + 0.5 * nb / np.maximum(1, deg)[:, None], g)
acc = g[grp]
# no surface is driven by both an arm and a leg (a hand hanging by the thigh):
# a vertex keeps whichever of the two chains dominates it
ARM = np.array([any(t in nm for t in ('uparm', 'lowarm', 'wrist', 'thumb', 'index', 'middle', 'ring', 'pinky')) for nm in names])
LEG = np.array([any(t in nm for t in ('upleg', 'lowleg', 'foot', 'ball', 'talocrural', 'subtalar', 'transversetarsal')) for nm in names])
aw, lw = acc[:, ARM].sum(1), acc[:, LEG].sum(1)
both = (aw > 0.02) & (lw > 0.02)
acc[np.ix_(both & (aw >= lw), LEG)] = 0
acc[np.ix_(both & (aw < lw), ARM)] = 0
top = np.argsort(-acc, 1)[:, :4]
sw = np.take_along_axis(acc, top, 1); sw /= np.maximum(1e-8, sw.sum(1, keepdims=True))
si = top


# ── 4. un-pose: x_rest = (Σ w_j A_j)^-1 x,  A_j = G_j(fit) · G_j(bind)^-1 ────
def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def G(s):
    M = np.eye(4); M[:3, :3] = qmat(s[3:7]) * s[7]; M[:3, 3] = s[:3]; return M


Aj = np.array([G(Sf[j]) @ np.linalg.inv(G(S0[j])) for j in range(127)])  # (used by --bind rest)
Mv = np.einsum('nk,nkab->nab', sw, Aj[si])
Ph = np.c_[P, np.ones(len(P))]
Prest = np.einsum('nab,nb->na', np.linalg.inv(Mv), Ph)[:, :3]

# ── 5. rig units + floor on the soles ────────────────────────────────────────
M = base['mhr']
out = {kk: base[kk] for kk in ('version', 'kind', 'restJoints', 'parent', 'boneLen', 'legLen', 'mhr')}
if a.bind == 'fitted':
    # the skeleton binds in the fitted pose: joint positions / rotations from the
    # fit, rest keypoints re-derived from them (the solver measures every pose
    # against these), bone lengths re-measured — the mesh stays as generated
    R = k * P + c
    bindPos = k * Sf[:, :3] + c
    bindQ = Sf[:, 3:7]
    kj, ko = np.array(M['kpJoint']), np.array(M['kpOffset'])
    rest = np.array([bindPos[kj[q]] + qmat(bindQ[kj[q]]) @ ko[q] for q in range(len(kj))])
    PARENT70 = json.load(open(f'{HERE}/parent70.json'))
    MHR70 = json.load(open(f'{HERE}/mhr70.json')); K70 = {n: i for i, n in enumerate(MHR70)}
    pelv = (rest[K70['left-hip']] + rest[K70['right-hip']]) / 2
    bl = [0.0 if p < 0 else float(np.linalg.norm(rest[q] - (rest[p] if p < 70 else pelv))) for q, p in enumerate(PARENT70[:70])]
    out['boneLen'] = bl
    out['legLen'] = (bl[K70['left-knee']] + bl[K70['left-ankle']] + bl[K70['right-knee']] + bl[K70['right-ankle']]) / 2
    M = {**M, 'bindPos': bindPos.tolist(), 'bindRot': bindQ.round(7).tolist()}
    restJ = rest
else:
    R = k * Prest + c
    restJ = np.array(base['restJoints'])
floor = float(R[:, 1].min())
R[:, 1] -= floor
out['mhr'] = {**M, 'bindPos': (np.array(M['bindPos']) - [0, floor, 0]).tolist()}
out['restJoints'] = (restJ - [0, floor, 0]).round(5).tolist()
out['soleOffset'] = round(float(min(out['restJoints'][i][1] for i in (15, 16, 17, 18, 19, 20))), 5)
b64 = lambda x: base64.b64encode(np.ascontiguousarray(x).tobytes()).decode()
tex = info['textures']
part = {'name': 'body', 'vertexCount': int(len(R)), 'verts': b64(R.astype(np.float32)), 'uv': b64(UV.astype(np.float32)),
        'faces': b64(T.astype(np.uint16 if len(R) < 65536 else np.uint32)), 'faces32': len(R) >= 65536,
        'skinIdx': b64(si.astype(np.uint8)), 'skinW': b64(sw.astype(np.float32)),
        'map': (a.url + tex['diffuse'].replace('.png', '.webp')) if tex.get('diffuse') else None,
        'normalMap': (a.url + tex['normal'].replace('.png', '.webp')) if tex.get('normal') else None, 'alpha': False}
out.update({'id': base['id'], 'name': base['name'], 'heightM': round(float(R[:, 1].max()), 3), 'parts': [part],
            'source': {'model': 'generated from the performer\'s video (A-pose views → Hyper3D Rodin), rigged on their MHR body (Apache-2.0)',
                       'fit': {'yawDeg': round(float(np.degrees(best[1]))), 'itersAdam': a.iters, 'bind': a.bind}}})
with gzip.open(a.out, 'wt') as f:
    json.dump(out, f)
# fit quality: mesh ↔ fitted body (cm), rest-pose unposing change
print(json.dumps({'vertices': len(R), 'height': out['heightM'], 'floorShift': round(floor, 3), 'sole': out['soleOffset'],
                  'meshToBodyCm': round(float(torch.cdist(torch.tensor(sub(P, 5000), dtype=torch.float32), torch.tensor(Vf)).min(1).values.mean()), 2),
                  'unposeMoveCm': round(float(np.linalg.norm(Prest - P, axis=1).mean()), 2)}))
