"""
The body the garments rest on, as spheres: a set of spheres inscribed in the rig's bind body
(torso, pelvis, neck base, arms, thighs, knees) that together cover its surface to ~1 cm. Each
sphere rides the skeleton (skin weights of the surface it covers), so the game can collide the
fabric with the moving body cheaply (a few hundred spheres, hashed per frame).

  python build_colliders.py <rig.json.gz> --out <dir>      → <dir>/colliders.npz (+ colliders.json report)

Method: the body's inside on a voxel grid → distance to the skin per inside voxel → candidate
centres on the medial ridge → greedy set cover of the skin samples (a sphere covers a skin point
within its radius + the tolerance), largest coverage first.
"""
import argparse, json, os, re, sys
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
import scipy.sparse as sp

sys.path.insert(0, os.path.dirname(__file__))
from rigio import load_rig, part_arrays, joints

ap = argparse.ArgumentParser()
ap.add_argument('rig')
ap.add_argument('--out', required=True)
ap.add_argument('--voxel', type=float, default=0.008)
ap.add_argument('--tol', type=float, default=0.012)
ap.add_argument('--max', type=int, default=320)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)

R = load_rig(a.rig)
NAMES, J, PARENTS = joints(R)
B = part_arrays(R['parts'][0])
V, F, N = B['V'].astype(np.float64), B['F'], B['N'].astype(np.float64)
DOM = B['SI'][np.arange(len(V)), B['SW'].argmax(1)]
DN = np.array(NAMES)[DOM]
# where clothes can touch: everything but the head, hands and feet (and the shins below the knee)
skip = np.array([bool(re.match(r'^(c_head|c_jaw|c_teeth|c_tongue|[lr]_eye|c_head_null|[lr]_(wrist|thumb|index|middle|ring|pinky|foot|talocrural|subtalar|transversetarsal|ball))', n)) for n in DN])
knee_y = (J['l_lowleg'][1] + J['r_lowleg'][1]) / 2
skip |= np.array([n.startswith(('l_lowleg', 'r_lowleg')) for n in DN]) & (V[:, 1] < knee_y - 0.12)
keep = ~skip

# ── inside of the body on a grid (sign from the nearest surface normals, holes filled)
fa, fb, fc = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
fn = np.cross(fb - fa, fc - fa); fn /= np.maximum(1e-12, np.linalg.norm(fn, axis=1, keepdims=True))
SP = np.concatenate([V, (fa + fb + fc) / 3]); SN = np.concatenate([N, fn])
st = cKDTree(SP)
h = a.voxel
lo, hi = V.min(0) - 2 * h, V.max(0) + 2 * h
n = np.ceil((hi - lo) / h).astype(int) + 1
G = np.stack(np.meshgrid(*[lo[k] + h * np.arange(n[k]) for k in range(3)], indexing='ij'), -1).reshape(-1, 3)
inside = np.zeros(len(G), bool)
for s0 in range(0, len(G), 500000):
    g = G[s0:s0 + 500000]
    d, i = st.query(g, k=4)
    nm = SN[i].mean(1)
    inside[s0:s0 + 500000] = (np.einsum('ij,ij->i', g - SP[i[:, 0]], nm) < 0) & (d[:, 0] < 0.2)
inside = ndimage.binary_fill_holes(ndimage.binary_opening(inside.reshape(n), iterations=1))
dist = ndimage.distance_transform_edt(inside) * h            # distance to the skin
# candidate centres: the medial ridge (local maxima of the distance), at least 1.2 cm deep
ridge = inside & (dist >= ndimage.maximum_filter(dist, size=3) - h * 0.5) & (dist >= 0.008)
ci = np.argwhere(ridge)
C = lo + ci * h
Rr = dist[tuple(ci.T)]
# only centres near the parts clothes touch
_, near = cKDTree(V).query(C)
ok = keep[near]
C, Rr = C[ok], Rr[ok]
print(f'voxels {n.tolist()}, candidates {len(C)}', file=sys.stderr)

# ── greedy cover of the skin samples
S = V[keep][::2]
tree = cKDTree(S)
rows, cols = [], []
for k, (c, r) in enumerate(zip(C, Rr)):
    idx = tree.query_ball_point(c, r + a.tol)
    rows += [k] * len(idx); cols += idx
M = sp.csr_matrix((np.ones(len(rows), bool), (rows, cols)), shape=(len(C), len(S)))
covered = np.zeros(len(S), bool)
MC = M.tocsc()
chosen = []
gain = np.asarray(M.sum(1)).ravel().astype(float)
while len(chosen) < a.max:
    k = int(np.argmax(gain))
    if gain[k] < 2: break
    chosen.append(k)
    new = M[k].indices[~covered[M[k].indices]]
    covered[new] = True
    # the gains drop by the points just covered
    if len(new):
        dec = np.asarray(MC[:, new].sum(1)).ravel()
        gain -= dec
    gain[k] = -1
C, Rr = C[chosen], Rr[chosen]
cover = float(covered.mean())
# skinning of each sphere: the weights of the skin it covers
Wd = np.zeros((len(C), len(NAMES)))
for k, (c, r) in enumerate(zip(C, Rr)):
    idx = cKDTree(V).query_ball_point(c, r + a.tol)
    if not idx: idx = [int(cKDTree(V).query(c)[1])]
    for j in range(4): np.add.at(Wd[k], B['SI'][idx, j], B['SW'][idx, j])
Wd /= np.maximum(1e-12, Wd.sum(1, keepdims=True))
top4 = np.argsort(-Wd, 1)[:, :4]
tw = np.take_along_axis(Wd, top4, 1); tw /= np.maximum(1e-12, tw.sum(1, keepdims=True))
np.savez(os.path.join(a.out, 'colliders.npz'), C=C.astype(np.float32), R=Rr.astype(np.float32), skinIdx=top4.astype(np.int32), skinW=tw.astype(np.float32))
rep = {'spheres': int(len(C)), 'skinCovered': round(cover, 4), 'tolerance': a.tol, 'radius': [round(float(Rr.min()), 4), round(float(Rr.max()), 4)]}
json.dump(rep, open(os.path.join(a.out, 'colliders.json'), 'w'), indent=1)
print(json.dumps(rep))
