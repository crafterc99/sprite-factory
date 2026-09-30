"""
Build a court rig (kind 'mhr', rig v4, one textured part) from an MHR fit (fit_mhr.py) of a mesh.

  python build_rig.py <export_dir> <fit_dir> --id zz-mg-mhrfit --name "..." [--bind fitted|rest] [--register]

  skeleton   bindPos / bindRot = the fitted MHR skeleton (bind=fitted: in the pose fitted to the
             mesh, the mesh as generated) or MHR's rest pose with the fitted body (bind=rest: the
             mesh un-posed by inverse LBS); metres, feet (lowest mesh point) on y = 0
  keypoints  kpJoint = the MHR70 → joint table of the bake_rig rigs (ankh); kpOffset re-derived
             for THIS body: keypoints that sit on a joint (< 1.5 cm) stay on it, the others
             (nose, ears, hips, heels, toes, olecranon, cubital fossa, acromion, neck) are carried
             by their MHR surface neighbourhood from ankh's MHR body onto the fitted MHR body,
             then expressed in their joint's frame. restJoints = bindPos + R·kpOffset,
             boneLen / legLen / soleOffset from those (as bake_rig / the importer)
  weights    MHR's own weights (≤ 4, twist joints, fingers) from the fitted MHR surface: k nearest
             body points in 6-D [p, λ·n], smoothed over the welded mesh (not across fingers), one
             finger per vertex (neighbour vote), no arm+leg mix, top 4
  parts      one 'body' part: render vertices (UV seams kept), UV (v up), welded normals,
             base colour / normal / roughness-metalness textures as webp under <id>-tex/
"""
import argparse, base64, gzip, json, os, re, time
import numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import nnls

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
RIGS = f'{REPO}/lib/mocap/mhr-rigs'
ap = argparse.ArgumentParser()
ap.add_argument('exp'); ap.add_argument('fit')
ap.add_argument('--id', required=True); ap.add_argument('--name', default=None)
ap.add_argument('--bind', choices=['fitted', 'rest'], default='fitted')
ap.add_argument('--kref', default=f'{RIGS}/ankh.json.gz', help='bake_rig rig (MHR body verts) for the keypoint table')
ap.add_argument('--knn', type=int, default=6)
ap.add_argument('--smooth', type=int, default=4)
ap.add_argument('--register', action='store_true')
ap.add_argument('--out', default=None)
ap.add_argument('--tex-max', type=int, default=0, help='longest texture side in the game (0 = the source size: nothing downscaled)')
ap.add_argument('--lod', type=int, default=0, help='N > 0: append this mesh as LOD N of the existing rig <id> (same skeleton and textures)')
ap.add_argument('--lod-dist', type=float, default=0.0)
ap.add_argument('--material', default=None, help='JSON material block for the rig (default: souljam-illustrated)')
a = ap.parse_args()
assert re.match(r'^[a-z0-9-]+$', a.id)
T0 = time.time()
names = json.load(open(f'{REPO}/scripts/mhr/joint_names.json'))
JI = {n: i for i, n in enumerate(names)}
MHR70 = json.load(open(f'{REPO}/scripts/mhr/mhr70.json')); K70 = {n: i for i, n in enumerate(MHR70)}
PARENT70 = json.load(open(f'{REPO}/scripts/mhr/parent70.json'))


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def vnormals(X, F):
    fn = np.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]])
    n = np.zeros_like(X)
    for q in range(3):
        np.add.at(n, F[:, q], fn)
    return n / np.maximum(1e-12, np.linalg.norm(n, axis=1, keepdims=True))


# ── inputs ──────────────────────────────────────────────────────────────────
E = np.load(f'{a.exp}/mesh.npz'); info = json.load(open(f'{a.exp}/mesh.json'))
P = E['pos'].astype(np.float64); UV = E['uv'].astype(np.float32); T = E['tri'].astype(np.int64)
F = np.load(f'{a.fit}/fit.npz')
Vf, Sf, Vr, Sr, Wm, FB = F['Vf'] / 100, F['Sf'].copy(), F['Vr'] / 100, F['Sr'].copy(), F['Wm'], F['FB']
Sf[:, :3] /= 100; Sr[:, :3] /= 100
fitrep = json.load(open(f'{a.fit}/fit.json'))
kref = json.load(gzip.open(a.kref, 'rt'))
KM = kref['mhr']

# weld on position (the rig works on the welded surface; render vertices keep their UVs)
key = np.round(P * 1e5).astype(np.int64)
_, weld, inv = np.unique(key, axis=0, return_index=True, return_inverse=True); inv = inv.ravel()
PW = P[weld]; NWV = len(PW)
TW = inv[T]; TW = TW[(TW[:, 0] != TW[:, 1]) & (TW[:, 1] != TW[:, 2]) & (TW[:, 0] != TW[:, 2])]
NW = vnormals(PW, TW)
edges = np.unique(np.sort(np.concatenate([TW[:, [0, 1]], TW[:, [1, 2]], TW[:, [2, 0]]]), 1), axis=0)
deg = np.zeros(NWV); np.add.at(deg, edges[:, 0], 1); np.add.at(deg, edges[:, 1], 1)

# ── 1. weights from the fitted MHR surface ──────────────────────────────────
LAM = 0.03   # m per unit normal difference
nVf = vnormals(Vf, FB)
tree = cKDTree(np.c_[Vf, LAM * nVf])
dd, ii = tree.query(np.c_[PW, LAM * NW], k=a.knn)
w = 1 / (dd + 0.004) ** 2; w /= w.sum(1, keepdims=True)
acc = np.einsum('nk,nkj->nj', w, Wm[ii])
d3, _ = cKDTree(Vf).query(PW, k=1)
# smooth over the welded surface
for _ in range(a.smooth):
    nb = np.zeros_like(acc); np.add.at(nb, edges[:, 0], acc[edges[:, 1]]); np.add.at(nb, edges[:, 1], acc[edges[:, 0]])
    acc = np.where(deg[:, None] > 0, 0.5 * acc + 0.5 * nb / np.maximum(1, deg)[:, None], acc)
# one finger per vertex: the dominant finger (neighbour vote), other fingers' joints dropped
FING = ['thumb', 'index', 'middle', 'ring', 'pinky']
fj = {f: [j for j, n in enumerate(names) if re.match(rf'^[lr]_{f}(\d|_null)', n) and not n.endswith('pinky0')] for f in FING}
fsum = np.stack([acc[:, fj[f]].sum(1) for f in FING], 1)
label = np.where(fsum.max(1) > 0.25, fsum.argmax(1), -1)
for _ in range(3):
    votes = np.zeros((NWV, 5))
    for k in range(5):
        v = (label == k).astype(float)
        nbv = np.zeros(NWV); np.add.at(nbv, edges[:, 0], v[edges[:, 1]]); np.add.at(nbv, edges[:, 1], v[edges[:, 0]])
        votes[:, k] = nbv + 1.5 * v
    label = np.where(label >= 0, votes.argmax(1), -1)
cross_before = int(((fsum > 0.02).sum(1) > 1).sum())
for k, f in enumerate(FING):
    others = [j for g, js in fj.items() if g != f for j in js]
    sel = label == k
    acc[np.ix_(sel, others)] = 0
# no surface is driven by both an arm and a leg
ARM = np.array([any(t in n for t in ('uparm', 'lowarm', 'wrist', 'thumb', 'index', 'middle', 'ring', 'pinky')) for n in names])
LEG = np.array([any(t in n for t in ('upleg', 'lowleg', 'foot', 'ball', 'talocrural', 'subtalar', 'transversetarsal')) for n in names])
aw, lw = acc[:, ARM].sum(1), acc[:, LEG].sum(1)
both = (aw > 0.02) & (lw > 0.02)
acc[np.ix_(both & (aw >= lw), LEG)] = 0; acc[np.ix_(both & (aw < lw), ARM)] = 0
top = np.argsort(-acc, 1)[:, :4]
sw = np.take_along_axis(acc, top, 1); sw /= np.maximum(1e-8, sw.sum(1, keepdims=True))
si = top.astype(np.uint8)
dropped = float((1 - np.take_along_axis(acc, top, 1).sum(1) / np.maximum(1e-8, acc.sum(1))).mean())

# ── 2. bind pose ────────────────────────────────────────────────────────────
def G(s):
    M = np.eye(4); M[:3, :3] = qmat(s[3:7]) * s[7]; M[:3, 3] = s[:3]; return M


if a.bind == 'fitted':
    PB, SB, VB = PW, Sf, Vf
    unpose_move = 0.0
else:
    # x_rest = (Σ w_j A_j)^-1 x,  A_j = G_j(fitted) · G_j(rest)^-1
    Aj = np.array([G(Sf[j]) @ np.linalg.inv(G(Sr[j])) for j in range(127)])
    Mv = np.einsum('nk,nkab->nab', sw, Aj[si])
    PB = np.einsum('nab,nb->na', np.linalg.inv(Mv), np.c_[PW, np.ones(NWV)])[:, :3]
    SB, VB = Sr, Vr
    unpose_move = float(np.linalg.norm(PB - PW, axis=1).mean())
floor = float(PB[:, 1].min())
if a.lod:
    # the LOD stands on LOD 0's floor (its own lowest vertex may differ by a few mm)
    _base = json.load(gzip.open(a.out or f'{RIGS}/{a.id}.json.gz', 'rt'))
    floor = float(_base['source']['fit'].get('floor', floor))
PB = PB - [0, floor, 0]
bindPos = SB[:, :3] - [0, floor, 0]
bindQ = SB[:, 3:7] / np.linalg.norm(SB[:, 3:7], axis=1, keepdims=True)
VBf = VB - [0, floor, 0]

# ── 3. keypoints: joint + offset in the joint's frame ───────────────────────
kpJoint = np.array(KM['kpJoint'])
kref_off = np.array(KM['kpOffset'])
kv = np.frombuffer(base64.b64decode(kref['verts']), np.float32).reshape(-1, 3).astype(np.float64)
krest = np.array(kref['restJoints'])
assert len(kv) == len(Vf), 'reference rig must carry the MHR body mesh'
ktree = cKDTree(kv)
kpOffset = np.zeros((70, 3)); rest = np.zeros((70, 3)); how = {}
for k in range(70):
    j = kpJoint[k]; Rj = qmat(bindQ[j])
    if np.linalg.norm(kref_off[k]) < 0.015:
        # rides a joint: stays on it (the runtime snaps that joint to this keypoint)
        kpOffset[k] = kref_off[k]
        how[MHR70[k]] = 'joint'
    else:
        # carried by its surface neighbourhood: a convex combination (w ≥ 0, Σw = 1) of the 96
        # nearest ankh body vertices — no extrapolation, so keypoints inside the body (hips,
        # neck) transfer as stably as surface ones (nose, ears, heels, toes)
        KN = 96
        d, nn = ktree.query(krest[k], k=KN)
        Q = kv[nn] - krest[k]
        rho, ridge = 10.0, 1e-3
        Aq = np.r_[Q.T, rho * np.ones((1, KN)), ridge * np.eye(KN)]
        bq = np.r_[np.zeros(3), rho, ridge * np.ones(KN) / KN]
        wk, _ = nnls(Aq, bq)
        wk /= wk.sum()
        repro = float(np.linalg.norm(wk @ Q))
        if repro < 0.005:
            kp = wk @ (VBf[nn])
            kpOffset[k] = Rj.T @ (kp - bindPos[j])
            mode = 'surface'
        else:
            # outside its surface neighbourhood's hull: the reference offset, scaled by the local
            # bone length (this joint to its MHR parent chain's next real bone)
            kb = np.array(KM['bindPos']); pj = KM['parents'][j]
            while pj >= 0 and np.linalg.norm(kb[j] - kb[pj]) < 0.02:
                pj = KM['parents'][pj]
            ratio = np.linalg.norm(bindPos[j] - bindPos[pj]) / np.linalg.norm(kb[j] - kb[pj])
            kpOffset[k] = kref_off[k] * ratio
            mode = f'scaled x{ratio:.3f}'
        how[MHR70[k]] = {'mode': mode, 'reproMm': round(repro * 1000, 2),
                         'offCm': round(float(np.linalg.norm(kpOffset[k])) * 100, 2), 'refOffCm': round(float(np.linalg.norm(kref_off[k])) * 100, 2)}
    rest[k] = bindPos[j] + Rj @ kpOffset[k]
pelv = (rest[K70['left-hip']] + rest[K70['right-hip']]) / 2
bl = [0.0 if p < 0 else float(np.linalg.norm(rest[q] - (rest[p] if p < 70 else pelv))) for q, p in enumerate(PARENT70[:70])]
legLen = (bl[K70['left-knee']] + bl[K70['left-ankle']] + bl[K70['right-knee']] + bl[K70['right-ankle']]) / 2
sole = float(min(rest[i][1] for i in (15, 16, 17, 18, 19, 20)))

# ── 4. part ─────────────────────────────────────────────────────────────────
tex = info['textures']
texdir = f'{RIGS}/{a.id}-tex'
os.makedirs(texdir, exist_ok=True)
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
urls = {}
for kind, fn, q in (('color', tex.get('baseColor'), 88), ('normal', tex.get('normal'), 92), ('rough', tex.get('metallicRoughness'), 92)):
    if not fn:
        continue
    im = Image.open(f'{a.exp}/tex/{fn}')
    im = im.convert('RGBA' if im.mode in ('RGBA', 'LA') else 'RGB')
    if a.tex_max and max(im.size) > a.tex_max:
        im.thumbnail((a.tex_max, a.tex_max), Image.LANCZOS)
    out = f'{kind}.webp'
    if a.lod and os.path.exists(f'{texdir}/{out}'):
        urls[kind] = f'/chars/{a.id}/{out}'; continue          # LODs share LOD 0's textures
    # near-lossless: the game shows the source texture at its own resolution
    im.save(f'{texdir}/{out}', 'WEBP', quality=min(100, q + 7), method=6)
    urls[kind] = f'/chars/{a.id}/{out}'
R = PB[inv].astype(np.float32)                           # render vertices take their welded position
NR = vnormals(PB, TW)[inv].astype(np.float32)             # welded normals: no lighting seam at UV seams
b64 = lambda x: base64.b64encode(np.ascontiguousarray(x).tobytes()).decode()
nv = len(R)
part = {'name': 'body', 'vertexCount': int(nv), 'verts': b64(R), 'uv': b64(UV),
        'faces': b64(T.astype(np.uint32 if nv > 65535 else np.uint16)), 'faces32': nv > 65535,
        'skinIdx': b64(si[inv]), 'skinW': b64(sw[inv].astype(np.float32)),
        'map': urls.get('color'), 'normalMap': urls.get('normal'),
        **({'roughnessMap': urls['rough'], 'metalnessMap': urls['rough']} if 'rough' in urls else {}),
        'alpha': False, 'color': None, 'normals': b64(NR)}
rig = {
    'version': 4, 'kind': 'mhr', 'id': a.id, 'name': a.name or a.id,
    'heightM': round(float(PB[:, 1].max()), 3),
    'restJoints': np.round(rest, 5).tolist(), 'parent': PARENT70, 'boneLen': [round(x, 5) for x in bl],
    'legLen': round(legLen, 5), 'soleOffset': round(sole, 5),
    'mhr': {'names': KM['names'], 'parents': KM['parents'], 'bindPos': np.round(bindPos, 6).tolist(), 'bindRot': np.round(bindQ, 7).tolist(),
            'skinIdx': KM['skinIdx'], 'skinW': KM['skinW'], 'kpJoint': kpJoint.tolist(), 'kpOffset': np.round(kpOffset, 6).tolist()},
    'parts': [part], 'material': {'preset': 'souljam-illustrated'},
    'source': {'model': os.path.basename(info['source']), 'rig': 'MHR body fitted to the mesh (shape + bone scales + pose), MHR skeleton + MHR skin weights (Apache-2.0)',
               'fit': {'bind': a.bind, 'chamferCm': fitrep['chamferCm'], 'globalScale': fitrep['globalScale'], 'floor': floor}},
}
if a.material:
    rig['material'] = json.loads(a.material)
out = a.out or f'{RIGS}/{a.id}.json.gz'
if a.lod:
    # LOD N: the base rig keeps its skeleton; this mesh (same fit, same bind) joins its lods
    base = json.load(gzip.open(out, 'rt'))
    assert np.allclose(np.array(base['mhr']['bindPos']), np.round(bindPos, 6), atol=2e-3), 'LOD mesh was bound to a different skeleton'
    part['name'] = 'body'
    base['lods'] = [l for l in base.get('lods', []) if l['level'] != a.lod] + [{'level': a.lod, 'dist': a.lod_dist, 'parts': [part]}]
    base['lods'].sort(key=lambda l: l['level'])
    rig = base
elif os.path.exists(out):
    pass                                                     # (re-build of LOD 0 drops old LODs: they are rebuilt after it)
with gzip.open(out, 'wt', compresslevel=9) as fh:
    json.dump(rig, fh)
if a.register and not a.lod:
    reg_path = f'{RIGS}/custom.json'
    reg = json.load(open(reg_path)) if os.path.exists(reg_path) else {}
    reg[a.id] = {'name': rig['name'], 'heightM': rig['heightM']}
    tmp = reg_path + f'.tmp{os.getpid()}'
    json.dump(reg, open(tmp, 'w'), indent=1); os.replace(tmp, reg_path)

# ── report ──────────────────────────────────────────────────────────────────
fingerCross = int(sum(1 for r in range(NWV) if len({re.match(r'^[lr]_([a-z]+)', names[j]).group(1) for j in top[r] if any(f in names[j] for f in FING) and sw[r][list(top[r]).index(j)] > 0.01}) > 1))
rep = {'id': a.id, 'bind': a.bind, 'out': out, 'vertices': nv, 'welded': NWV, 'triangles': len(T), 'heightM': rig['heightM'], 'floorShift': round(floor, 4),
       'legLen': rig['legLen'], 'soleOffset': rig['soleOffset'], 'unposeMoveCm': round(unpose_move * 100, 2),
       'meshToFittedBodyCm': {'mean': round(float(d3.mean() * 100), 2), 'p95': round(float(np.percentile(d3, 95) * 100), 2)},
       'weightMassDroppedByTop4': round(dropped, 4), 'verticesOnTwoFingersBeforeClean': cross_before, 'verticesOnTwoFingersAfter': fingerCross,
       'keypoints': how, 'textures': urls, 'seconds': round(time.time() - T0, 1)}
json.dump(rep, open(f'{a.fit}/build-{a.id}.json', 'w'), indent=1)
print(json.dumps({k: v for k, v in rep.items() if k != 'keypoints'}, indent=1))
