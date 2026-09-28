"""
Put an exported MPFB character (export_mpfb.py) on the court's MHR skeleton.

  1. MPFB (Blender z-up, −y forward) → MHR space (y up, +z forward, +x left), scaled.
  2. Re-pose the rest pose onto MHR's: every MPFB bone gets a rigid transform
     taking its head onto the matching MHR joint and its direction onto MHR's
     (hands: full palm frame; fingers relative to the hand), blended with the
     MPFB weights — the character now stands exactly in MHR's rest pose.
  3. Skin weights from the nearest MHR body vertices (MHR's own weights,
     including the limb twist joints), heads' parts rigid on the head.
  4. Rig JSON (kind 'mhr', with `parts`): the MHR skeleton block of the base
     rig + one textured part per MPFB mesh.

usage: python fit_to_mhr.py <export_dir> <base_mhr_rig.json.gz> <out.json.gz> <tex_url_prefix>
"""
import sys, json, gzip, base64
import numpy as np

exp, base_path, out_path, url = sys.argv[1:5]
E = np.load(exp + '/parts.npz')
meta = json.load(open(exp + '/parts.json'))
base = json.load(gzip.open(base_path, 'rt'))
M = base['mhr']
JI = {n: i for i, n in enumerate(M['names'])}
bind = np.array(M['bindPos'])
B = {n: i for i, n in enumerate(meta['bones'])}
b2m = lambda p: np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)   # blender → MHR axes
heads, tails = b2m(E['heads']), b2m(E['tails'])

# ── scale: hip + neck heights (MPFB vs MHR) ──────────────────────────────────
def hjoint(n): return bind[JI[n]]
s = np.mean([hjoint('l_upleg')[1] / heads[B['thigh_l'], 1], hjoint('c_neck')[1] / heads[B['neck_01'], 1]])
heads *= s; tails *= s

# ── bone → MHR (head joint, tail joint) ──────────────────────────────────────
MAP = {'pelvis': ('root', 'c_spine1'), 'spine_01': ('c_spine1', 'c_spine2'), 'spine_02': ('c_spine2', 'c_spine3'), 'spine_03': ('c_spine3', 'c_neck'),
       'neck_01': ('c_neck', 'c_head'), 'head': ('c_head', 'c_head_null'), 'Root': None}
for sd in 'lr':
    MAP.update({f'clavicle_{sd}': (f'{sd}_clavicle', f'{sd}_uparm'), f'upperarm_{sd}': (f'{sd}_uparm', f'{sd}_lowarm'), f'lowerarm_{sd}': (f'{sd}_lowarm', f'{sd}_wrist'),
                f'hand_{sd}': (f'{sd}_wrist', f'{sd}_middle1'), f'thigh_{sd}': (f'{sd}_upleg', f'{sd}_lowleg'), f'calf_{sd}': (f'{sd}_lowleg', f'{sd}_foot'),
                f'foot_{sd}': (f'{sd}_foot', f'{sd}_ball'), f'ball_{sd}': (f'{sd}_ball', None)})
    for f in ('index', 'middle', 'ring', 'pinky'):
        MAP.update({f'{f}_01_{sd}': (f'{sd}_{f}1', f'{sd}_{f}2'), f'{f}_02_{sd}': (f'{sd}_{f}2', f'{sd}_{f}3'), f'{f}_03_{sd}': (f'{sd}_{f}3', f'{sd}_{f}_null')})
    MAP.update({f'thumb_01_{sd}': (f'{sd}_thumb1', f'{sd}_thumb2'), f'thumb_02_{sd}': (f'{sd}_thumb2', f'{sd}_thumb3'), f'thumb_03_{sd}': (f'{sd}_thumb3', f'{sd}_thumb_null')})


def unit(v): return v / (np.linalg.norm(v) + 1e-12)


def swing(a, b):
    a, b = unit(a), unit(b)
    v, c = np.cross(a, b), np.dot(a, b)
    if c < -0.9999:
        p = unit(np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0])); return 2 * np.outer(p, p) - np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def frame(a, b):
    e1 = unit(a); e2 = unit(b - e1 * np.dot(e1, b)); return np.stack([e1, e2, np.cross(e1, e2)], 1)


R = {}
parent = {n: p for n, p in zip(meta['bones'], meta['parents'])}
for n in meta['bones']:                       # parents come first in Blender's bone order
    m = MAP.get(n)
    if not m:
        R[n] = R.get(parent[n], np.eye(3)) if parent[n] else np.eye(3); continue
    h0, t0 = heads[B[n]], tails[B[n]]
    H = hjoint(m[0])
    T = hjoint(m[1]) if m[1] else H + (R[parent[n]] @ (t0 - h0))
    if n.startswith('hand_'):
        sd = n[-1]
        a0, c0 = t0 - h0, heads[B[f'index_01_{sd}']] - heads[B[f'pinky_01_{sd}']]
        a1, c1 = hjoint(f'{sd}_middle1') - hjoint(f'{sd}_wrist'), hjoint(f'{sd}_index1') - hjoint(f'{sd}_pinky1')
        R[n] = frame(a1, c1) @ frame(a0, c0).T
    elif any(n.startswith(f) for f in ('index', 'middle', 'ring', 'pinky', 'thumb')):
        Rp = R[parent[n]]
        R[n] = swing(Rp @ (t0 - h0), T - H) @ Rp
    else:
        R[n] = swing(t0 - h0, T - H)
# The torso chain moves onto MHR's joints by translation only: both rigs stand
# upright, and the large spine / clavicle swings (30°+) only reflect how the two
# rigs place those bones — blending them shears the chest and shoulders.
for n in ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r'):
    R[n] = np.eye(3)
T_of = {n: (R[n], (hjoint(MAP[n][0]) if MAP.get(n) else heads[B[n]]), heads[B[n]]) for n in meta['bones']}
# The two rigs split the spine differently (MPFB's upper spine joint sits ~25 cm
# below MHR's): pinning each spine joint onto its MHR namesake stretches the
# chest. Spine joints take the displacement interpolated by height between the
# pelvis and neck anchors — the character keeps its own torso proportions.
d_pel, d_neck = hjoint('root') - heads[B['pelvis']], hjoint('c_neck') - heads[B['neck_01']]
z_pel, z_neck = heads[B['pelvis'], 1], heads[B['neck_01'], 1]
for n in ('spine_01', 'spine_02', 'spine_03'):
    h = heads[B[n]]; t = np.clip((h[1] - z_pel) / (z_neck - z_pel), 0, 1)
    T_of[n] = (R[n], h + (1 - t) * d_pel + t * d_neck, h)


def refit(pos0, bi, bw):
    """Rest pose onto MHR's: blend of per-bone rigid transforms (MPFB weights)."""
    pos = np.zeros_like(pos0)
    for k in range(4):
        for bn, (Rb, Hb, hb) in T_of.items():
            sel = (bi[:, k] == B[bn]) & (bw[:, k] > 0)
            if sel.any():
                pos[sel] += bw[sel, k, None] * ((pos0[sel] - hb) @ Rb.T + Hb)
    return pos

base_verts = np.frombuffer(base64.b64decode(base['verts']), np.float32).reshape(-1, 3)
base_idx = np.frombuffer(base64.b64decode(M['skinIdx']), np.uint8).reshape(-1, 4)
base_w = np.frombuffer(base64.b64decode(M['skinW']), np.float32).reshape(-1, 4)
body_pos0 = b2m(E['body_pos']) * s
body_bi, body_bw = E['body_bi'], E['body_bw']


def nearest(points, ref, k=1):
    out_i = np.zeros((len(points), k), np.int64); out_d = np.zeros((len(points), k))
    for a in range(0, len(points), 2048):
        d = ((points[a:a + 2048, None, :] - ref[None, :, :]) ** 2).sum(-1)
        idx = np.argpartition(d, k, 1)[:, :k] if k < d.shape[1] else np.argsort(d, 1)[:, :k]
        out_i[a:a + 2048] = idx; out_d[a:a + 2048] = np.sqrt(np.take_along_axis(d, idx, 1))
    return out_i, out_d


body_disp = refit(body_pos0, body_bi, body_bw / np.maximum(1e-8, body_bw.sum(1, keepdims=True))) - body_pos0
HEAD_PARTS = ('high-poly', 'eyebrow', 'eyelash')   # + hair: rigid on the head
HEAD_J = [JI[n] for n in ('c_head', 'c_jaw', 'c_jaw_null', 'r_eye', 'r_eye_null', 'l_eye', 'l_eye_null', 'c_head_null')]
parts_out = []
all_pos = []
for p in meta['parts']:
    nm = p['name']
    pos0 = b2m(E[nm + '_pos']) * s
    bi, bw = E[nm + '_bi'].copy(), E[nm + '_bw'].copy()
    bw = bw / np.maximum(1e-8, bw.sum(1, keepdims=True))
    # 2. onto MHR's rest pose. Parts with their own rig weights (body, eyes…):
    # the bone blend. Parts without (MPFB clothes carry none): they follow the
    # fitted body — the inverse-distance mean displacement of the 8 nearest
    # body vertices, a smooth field (per-vertex borrowed bone weights tear cloth
    # that stands off the body, e.g. a hood)
    miss = bw.sum(1) < 1e-4
    pos = refit(pos0, bi, bw)
    if miss.any():
        ii, dd = nearest(pos0[miss], body_pos0, 8)
        wv = 1 / (dd + 0.005) ** 2; wv /= wv.sum(1, keepdims=True)
        pos[miss] = pos0[miss] + (wv[:, :, None] * body_disp[ii]).sum(1)
    # 3. MHR weights from the nearest MHR body vertices (inverse distance, k=4)
    if nm.startswith(HEAD_PARTS) or 'hair' in nm:   # rigid on the head
        si = np.zeros((len(pos), 4), np.uint8); si[:, 0] = JI['c_head']; sw = np.zeros((len(pos), 4), np.float32); sw[:, 0] = 1
    else:
        ii, dd = nearest(pos, base_verts, 4)
        wv = 1 / (dd + 0.004) ** 2
        acc = np.zeros((len(pos), 127), np.float32)
        for k in range(4):
            for c in range(4):
                np.add.at(acc, (np.arange(len(pos)), base_idx[ii[:, k], c]), wv[:, k] * base_w[ii[:, k], c])
        # smooth the weights over the garment's surface (vertices sharing a
        # position — UV seams — count as one): nearest-body weights are noisy on
        # cloth that stands off the body (hoods, collars), and neighbouring
        # vertices with different weights pull the fabric into spikes
        if nm != 'body':
            key = np.round(pos / 0.002).astype(np.int64)
            _, grp = np.unique(key, axis=0, return_inverse=True); grp = grp.ravel()
            tri = E[nm + '_tri'].astype(np.int64)
            e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
            e = np.unique(np.sort(grp[e], 1), axis=0)
            G = grp.max() + 1
            g_acc = np.zeros((G, acc.shape[1]), np.float32); np.add.at(g_acc, grp, acc)
            g_acc /= np.maximum(1e-8, g_acc.sum(1, keepdims=True))
            deg = np.zeros(G); np.add.at(deg, e[:, 0], 1); np.add.at(deg, e[:, 1], 1)
            for _ in range(8):
                nb = np.zeros_like(g_acc); np.add.at(nb, e[:, 0], g_acc[e[:, 1]]); np.add.at(nb, e[:, 1], g_acc[e[:, 0]])
                g_acc = np.where(deg[:, None] > 0, 0.5 * g_acc + 0.5 * nb / np.maximum(1, deg)[:, None], g_acc)
            acc = g_acc[grp]
        # garments never follow the head (a hood or collar taking head weights
        # tears away from the torso when the head turns): head joints → neck
        acc[:, JI['c_neck']] += acc[:, HEAD_J].sum(1); acc[:, HEAD_J] = 0
        top = np.argsort(-acc, 1)[:, :4]
        sw = np.take_along_axis(acc, top, 1); sw /= np.maximum(1e-8, sw.sum(1, keepdims=True))
        si = top.astype(np.uint8)
    all_pos.append(pos)
    tri = E[nm + '_tri']
    parts_out.append({
        'name': nm, 'vertexCount': int(len(pos)),
        'verts': base64.b64encode(pos.astype(np.float32).tobytes()).decode(),
        'uv': base64.b64encode(E[nm + '_uv'].astype(np.float32).tobytes()).decode(),
        'faces': base64.b64encode(tri.astype(np.uint16 if len(pos) < 65536 else np.uint32).tobytes()).decode(), 'faces32': len(pos) >= 65536,
        'skinIdx': base64.b64encode(si.tobytes()).decode(), 'skinW': base64.b64encode(sw.astype(np.float32).tobytes()).decode(),
        'map': (url + p['diffuse']) if p['diffuse'] else None, 'normalMap': (url + p['normal']) if p['normal'] else None, 'alpha': p['alpha'],
    })
allp = np.concatenate(all_pos)
floor = allp[:, 1].min()
for po in parts_out:   # the lowest point (shoe sole) on the floor
    v = np.frombuffer(base64.b64decode(po['verts']), np.float32).reshape(-1, 3).copy(); v[:, 1] -= floor
    po['verts'] = base64.b64encode(v.tobytes()).decode()
rest = np.array(base['restJoints'])
out = {k: base[k] for k in ('version', 'kind', 'restJoints', 'parent', 'boneLen', 'legLen', 'mhr')}
bindPos = (np.array(M['bindPos']) - [0, floor, 0]).tolist()
out['mhr'] = {**M, 'bindPos': bindPos}
out['restJoints'] = (rest - [0, floor, 0]).round(5).tolist()
out['soleOffset'] = round(float(min(out['restJoints'][i][1] for i in (15, 16, 17, 18, 19, 20))), 5)
out.update({'id': base['id'], 'name': base['name'], 'heightM': round(float(allp[:, 1].max() - floor), 3), 'parts': parts_out,
            'source': {'model': 'MPFB (MakeHuman for Blender) character, CC0 output; MHR skeleton + weights (Apache-2.0)', 'scale': round(float(s), 4)}})
with gzip.open(out_path, 'wt') as f:
    json.dump(out, f)
print(json.dumps({'scale': round(float(s), 3), 'height': out['heightM'], 'sole': out['soleOffset'], 'floorShift': round(float(floor), 3), 'parts': [(p['name'], p['vertexCount']) for p in parts_out]}))
