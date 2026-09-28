"""
Side-stripe mask for a pair of trousers (track-pant stripes down the outer
side of each leg), in the garment's UV space.

  python stripes.py <export_dir> <part_name> <out.raw> [size=1024]

Every texel of the part's UV layout is placed on the rest-pose garment; its
angle around its own leg's axis (0 = straight out to the side) decides whether
it falls in one of three stripes. Writes size×size uint8 (255 = stripe).
"""
import sys, json
import numpy as np

exp, part, out = sys.argv[1:4]
N = int(sys.argv[4]) if len(sys.argv) > 4 else 1024
E = np.load(exp + '/parts.npz')
P = E[part + '_pos']          # Blender: x side, -y forward, z up
UV = E[part + '_uv']
T = E[part + '_tri']
# the leg axis (x, y centre) per side and height band
side = np.sign(P[:, 0])
zs = np.linspace(P[:, 2].min(), P[:, 2].max(), 40)
def axis(sd, z):
    m = (side == sd) & (np.abs(P[:, 2] - z) < 0.04)
    return P[m, :2].mean(0) if m.sum() > 6 else None
AX = {}
for sd in (-1, 1):
    a = [axis(sd, z) for z in zs]
    ok = [i for i, v in enumerate(a) if v is not None]
    arr = np.array([a[i] for i in ok])
    AX[sd] = np.stack([np.interp(zs, zs[ok], arr[:, 0]), np.interp(zs, zs[ok], arr[:, 1])], 1)
def axis_at(sd, z):
    # linear between height bands (no steps → continuous stripes)
    return np.stack([np.interp(z, zs, AX[sd][:, 0]), np.interp(z, zs, AX[sd][:, 1])], 1)
BANDS = [(-0.23, -0.14), (-0.045, 0.045), (0.14, 0.23)]           # rad around the leg (3 stripes)
mask = np.zeros((N, N), np.uint8)
for tri in T:
    uv = UV[tri] * (N - 1); p3 = P[tri]
    x0, y0 = np.floor(uv.min(0)).astype(int); x1, y1 = np.ceil(uv.max(0)).astype(int)
    if x1 - x0 > N / 2 or y1 - y0 > N / 2: continue
    gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    g = np.stack([gx.ravel(), gy.ravel()], 1).astype(float)
    a, b, c = uv
    M = np.array([b - a, c - a]).T
    if abs(np.linalg.det(M)) < 1e-9: continue
    l = np.linalg.solve(M, (g - a).T).T
    w = np.c_[1 - l.sum(1), l]
    ins = (w >= -0.02).all(1)
    if not ins.any(): continue
    q = w[ins] @ p3
    # the side of the triangle (not per texel: a stripe never splits at the crotch)
    sdt = 1 if p3[:, 0].mean() >= 0 else -1
    d = q[:, :2] - axis_at(sdt, q[:, 2])
    th = np.arctan2(d[:, 1], d[:, 0] * sdt)           # 0 = outward, ± = front / back
    hit = np.zeros(len(q), bool)
    for lo, hi in BANDS: hit |= (th >= lo) & (th <= hi)
    gi = g[ins][hit].astype(int)
    # image rows run top-down, UV v runs bottom-up
    mask[N - 1 - np.clip(gi[:, 1], 0, N - 1), np.clip(gi[:, 0], 0, N - 1)] = 255
open(out, 'wb').write(mask.tobytes())
print(json.dumps({'stripeTexels': int((mask > 0).sum()), 'size': N}))
