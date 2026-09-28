"""
Bake an MHR character rig for the 3D court (rig v4).

Inputs: the MHR TorchScript model (Apache-2.0, facebookresearch/MHR) and one
or more analysed motions whose frames carry SAM 3D Body's MHR output
(rec.mhr: rots, joints, shape, model).  Output: a gz JSON the runtime loads:

  restJoints (70 MHR70 keypoints, rest pose), boneLen/parent (MHR70 tree),
  legLen, soleOffset, heightM, verts/faces/colors (rest mesh, metres, y-up,
  +Z forward, feet on y=0), and mhr { names, parents, bindPos, bindRot,
  skinIdx, skinW, kpJoint, kpOffset } — MHR's own skeleton + skin weights.

usage: python bake_rig.py <raw.json> <out.json.gz> [--id ankh --name "..."
        --height 1.83 --leg 1.0 --arm 1.0 --torso 1.0 --palette '{...}']
"""
import argparse, base64, gzip, json, sys, warnings
import numpy as np
import torch

warnings.filterwarnings('ignore')
ap = argparse.ArgumentParser()
ap.add_argument('raw', nargs='+')
ap.add_argument('--out', required=True)
ap.add_argument('--id', default='ankh')
ap.add_argument('--name', default='Ankh · 6\'0"')
ap.add_argument('--height', type=float, default=0)
ap.add_argument('--leg', type=float, default=1.0)
ap.add_argument('--arm', type=float, default=1.0)
ap.add_argument('--torso', type=float, default=1.0)
ap.add_argument('--palette', default='{}')
a = ap.parse_args()

HERE = __file__.rsplit('/', 1)[0]
names = json.load(open(f'{HERE}/joint_names.json'))
MHR70 = json.load(open(f'{HERE}/mhr70.json'))
PARENT70 = json.load(open(f'{HERE}/parent70.json'))
K = {n: i for i, n in enumerate(MHR70)}
JI = {n: i for i, n in enumerate(names)}
m = torch.jit.load(f'{HERE}/assets/mhr_model.pt', map_location='cpu')
ch = m.character_torch
F = np.diag([1.0, -1.0, -1.0])  # camera (y down, z forward) → MHR world (y up)

# ── the performer: MHR frames from every raw given ───────────────────────────
frames = []
for p in a.raw:
    raw = json.load(open(p))
    frames += [f for f in raw['frames'] if f.get('mhr') and f.get('kp3d') and not f.get('error')]
if len(frames) < 3:
    sys.exit('need frames with MHR params')
shape = np.median(np.array([f['mhr']['shape'] for f in frames], np.float32), 0)
model = np.median(np.array([f['mhr']['model'] for f in frames], np.float32), 0)
pt = ch.parameter_transform
scaling = pt.scaling_parameters.numpy()[:204]
params = np.zeros(204, np.float32)
params[scaling] = model[scaling]            # the performer's bone scales, zero pose

# proportions for presets: MHR scale params add 10 cm per unit to a bone (see compact_v6_1.model)
# parameter names in model order: the [ParameterTransform] right-hand sides, in first-seen order
order = []
for l in open(f'{HERE}/assets/compact_v6_1.model'):
    if l.startswith('[ParameterSets]'):
        break
    if '=' in l and not l.lstrip().startswith('#'):
        for tok in l.split('=')[1].replace('+', ' ').split():
            if tok[0].isalpha() and tok not in order:
                order.append(tok)
PI = {n: i for i, n in enumerate(order)}
assert all(scaling[PI[n]] for n in ('scale_uplegs', 'scale_lowlegs', 'scale_uparms', 'scale_lowarms', 'scale_spine_length')), 'parameter order'


def bump(pname, cm):
    if pname in PI and PI[pname] < 204:
        params[PI[pname]] += cm / 10.0


def bone_cm(j):
    return float(np.linalg.norm(ch.skeleton.joint_translation_offsets[JI[j]].numpy()))


if a.leg != 1:
    bump('scale_uplegs', (a.leg - 1) * bone_cm('l_lowleg'))
    bump('scale_lowlegs', (a.leg - 1) * bone_cm('l_foot'))
if a.arm != 1:
    bump('scale_uparms', (a.arm - 1) * bone_cm('l_lowarm'))
    bump('scale_lowarms', (a.arm - 1) * bone_cm('l_wrist_twist'))
if a.torso != 1:
    bump('scale_spine_length', (a.torso - 1) * 10.0 * 5.0)

with torch.no_grad():
    v, st = m(torch.tensor(shape)[None], torch.tensor(params)[None], torch.zeros(1, 72), False)
verts = v[0].numpy().astype(np.float64) / 100.0
st = st[0].numpy().astype(np.float64)
bindPos = st[:, :3] / 100.0
bindQ = st[:, 3:7]  # x y z w


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


bindR = np.array([qmat(q) for q in bindQ])

# ── skin weights (≤ 4 per vertex) ────────────────────────────────────────────
lbs = ch.linear_blend_skinning
N = verts.shape[0]
skinIdx = np.zeros((N, 4), np.uint8)
skinW = np.zeros((N, 4), np.float32)
cnt = np.zeros(N, np.int32)
for vi, ji, w in zip(lbs.vert_indices_flattened.numpy(), lbs.skin_indices_flattened.numpy(), lbs.skin_weights_flattened.numpy()):
    k = cnt[vi]
    skinIdx[vi, k] = ji
    skinW[vi, k] = w
    cnt[vi] += 1
skinW /= skinW.sum(1, keepdims=True)
faces = ch.mesh.faces.numpy().astype(np.uint16)

# ── rest keypoints: each MHR70 keypoint rides one MHR joint (offset learnt
#    from the capture: o = R_j^T (kp − p_j), stable over frames) ──────────────
skinned = set(np.unique(skinIdx[skinW > 0]).tolist())
cand = [j for j in range(127) if j in skinned or names[j].endswith('_null') or names[j] in ('l_wrist', 'r_wrist', 'l_ball', 'r_ball')]
KP = np.array([[F @ np.array(p) for p in f['kp3d']] for f in frames])            # frames × 70 × 3
JP = np.array([(F @ np.array(f['mhr']['joints']).reshape(127, 3).T).T for f in frames])
JR = np.array([np.array(f['mhr']['rots']).reshape(127, 3, 3) for f in frames])
kpJoint = np.zeros(70, np.int32)
kpOff = np.zeros((70, 3))
for k in range(70):
    d = np.linalg.norm(KP[:, k, None, :] - JP[:, cand, :], axis=2).mean(0)
    best = None
    for c in np.argsort(d)[:4]:
        j = cand[c]
        o = np.einsum('fji,fj->fi', JR[:, j], KP[:, k] - JP[:, j])   # R^T (kp − p)
        spread = np.linalg.norm(o - np.median(o, 0), axis=1).mean()
        score = spread + 0.15 * d[c]
        if best is None or score < best[0]:
            best = (score, j, np.median(o, 0))
    kpJoint[k] = best[1]
    kpOff[k] = best[2]
rest = np.array([bindPos[kpJoint[k]] + bindR[kpJoint[k]] @ kpOff[k] for k in range(70)])

# feet on the floor, then the requested height (uniform)
floor = verts[:, 1].min()
verts[:, 1] -= floor
bindPos[:, 1] -= floor
rest[:, 1] -= floor
h0 = verts[:, 1].max()
s = a.height / h0 if a.height else 1.0
verts *= s
bindPos *= s
rest *= s
kpOff *= s

# ── outfit colours by body part (rest pose) ──────────────────────────────────
PAL = {'skin': [112, 72, 48], 'hair': [26, 18, 12], 'shirt': [22, 22, 26], 'shorts': [206, 30, 36],
       'sock': [236, 236, 236], 'shoe': [245, 245, 245]}
PAL.update(json.loads(a.palette))
dom = skinIdx[np.arange(N), skinW.argmax(1)]
jn = np.array(names)[dom]
y = verts[:, 1]
kneeY = (rest[K['left-knee'], 1] + rest[K['right-knee'], 1]) / 2
hipY = (rest[K['left-hip'], 1] + rest[K['right-hip'], 1]) / 2
ankY = (rest[K['left-ankle'], 1] + rest[K['right-ankle'], 1]) / 2
eyeY = (rest[K['left-eye'], 1] + rest[K['right-eye'], 1]) / 2
earZ = (rest[K['left-ear'], 2] + rest[K['right-ear'], 2]) / 2
waistY = hipY + 0.07  # one waistline for shirt / shorts (no jagged band where joints meet)
col = np.zeros((N, 3), np.uint8)
for i in range(N):
    n = jn[i]
    if n in ('c_head', 'c_jaw', 'c_head_null') or 'eye' in n or 'tongue' in n or 'teeth' in n:
        c = 'hair' if (y[i] > eyeY + 0.035 or (y[i] > eyeY - 0.04 and verts[i, 2] < earZ - 0.02)) else 'skin'
    elif n.startswith('c_neck'):
        c = 'skin'
    elif n.startswith('c_spine') or 'clavicle' in n:
        c = 'shirt' if y[i] > waistY else 'shorts'
    elif 'uparm' in n:
        # short sleeve: the upper half of the upper arm
        j0, j1 = bindPos[JI[n[:2] + 'uparm']], bindPos[JI[n[:2] + 'lowarm']]
        t = np.dot(verts[i] - j0, j1 - j0) / np.dot(j1 - j0, j1 - j0)
        c = 'shirt' if t < 0.5 else 'skin'
    elif n in ('root', 'body_world') or 'upleg' in n:
        c = 'shirt' if y[i] > waistY else 'shorts' if y[i] > kneeY + 0.03 else 'skin'
    elif 'lowleg' in n:
        c = 'sock' if y[i] < ankY + 0.1 else ('shorts' if y[i] > kneeY + 0.03 else 'skin')
    elif any(t in n for t in ('foot', 'talocrural', 'subtalar', 'transversetarsal', 'ball')):
        c = 'sock' if y[i] > ankY + 0.02 else 'shoe'
    else:
        c = 'skin'
    col[i] = PAL[c]

# ── MHR70 bone lengths / leg length / sole offset (runtime retargeting) ──────
bl = [0.0 if p < 0 else float(np.linalg.norm(rest[k] - (rest[p] if p < 70 else (rest[K['left-hip']] + rest[K['right-hip']]) / 2))) for k, p in enumerate(PARENT70[:70])]
legLen = (bl[K['left-knee']] + bl[K['left-ankle']] + bl[K['right-knee']] + bl[K['right-ankle']]) / 2
sole = float(min(rest[K[n], 1] for n in ('left-heel', 'right-heel', 'left-big-toe-tip', 'right-big-toe-tip')))


def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode()


out = {
    'version': 4, 'kind': 'mhr', 'id': a.id, 'name': a.name, 'heightM': round(float(verts[:, 1].max()), 3),
    'source': {'model': 'MHR (Momentum Human Rig) LOD1, Apache-2.0', 'frames': len(frames), 'proportions': {'leg': a.leg, 'arm': a.arm, 'torso': a.torso}},
    'restJoints': np.round(rest, 5).tolist(), 'parent': PARENT70, 'boneLen': [round(x, 5) for x in bl],
    'legLen': round(legLen, 5), 'soleOffset': round(sole, 5), 'vertexCount': int(N),
    'verts': b64(verts.astype(np.float32)), 'faces': b64(faces), 'colors': b64(col),
    'mhr': {
        'names': names, 'parents': ch.skeleton.joint_parents.numpy().tolist(),
        'bindPos': np.round(bindPos, 6).tolist(), 'bindRot': np.round(bindQ, 7).tolist(),
        'skinIdx': b64(skinIdx), 'skinW': b64(skinW.astype(np.float32)),
        'kpJoint': kpJoint.tolist(), 'kpOffset': np.round(kpOff, 6).tolist(),
    },
}
with gzip.open(a.out, 'wt') as fh:
    json.dump(out, fh)
print(json.dumps({'id': a.id, 'height': out['heightM'], 'legLen': out['legLen'], 'sole': out['soleOffset'], 'frames': len(frames),
                  'kp->joint': {MHR70[k]: names[kpJoint[k]] for k in (K['left-hip'], K['left-knee'], K['left-ankle'], K['left-heel'], K['left-wrist'], K['nose'], K['neck'], K['left-shoulder'])}}))
