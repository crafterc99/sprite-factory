"""Shared helpers for the headless Blender stages (run as: blender -b -P <script> -- <json args>).

Conventions inside every stage: metres, +Y up, the character faces +Z, its left is +X
(glTF / three.js) — `import_model` turns Blender's Z-up import back to these axes and
`export_glb` writes them unconverted. Tripo exports face +X by default; `normalize_orientation`
turns them to +Z.
"""
import bpy, bmesh, json, math, sys, os, time
import numpy as np
from mathutils import Vector, Matrix, kdtree


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return json.loads(a[0]) if a else {}


def log(*m):
    print('[cf]', *m, flush=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path, name=None):
    """Imports a GLB / FBX / OBJ; returns (mesh objects, armature or None)."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise RuntimeError('unsupported model: ' + path)
    new = [o for o in bpy.data.objects if o not in before]
    # Blender is Z-up: the importers turn Y-up files into it. Turn back, so every stage works in
    # the game's axes (Y up, facing +Z); exports then skip the axis conversion (export_yup=False).
    if ext in ('.glb', '.gltf', '.fbx', '.obj'):
        R = Matrix.Rotation(-math.pi / 2, 4, 'X')
        for o in new:
            if o.parent is None:
                o.matrix_world = R @ o.matrix_world
        bpy.context.view_layer.update()
    meshes = [o for o in new if o.type == 'MESH']
    arm = next((o for o in new if o.type == 'ARMATURE'), None)
    if name:
        for i, o in enumerate(meshes):
            o.name = f'{name}' if len(meshes) == 1 else f'{name}_{i}'
    return meshes, arm


def apply_transforms(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join(objs, name):
    """Joins meshes (unparented, transforms applied) into one object."""
    for o in objs:
        if o.parent:
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    apply_transforms(objs)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def verts_np(o):
    n = len(o.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    o.data.vertices.foreach_get('co', a)
    a = a.reshape(n, 3)
    mw = np.array(o.matrix_world)
    return a @ mw[:3, :3].T + mw[:3, 3]


def set_verts_np(o, a):
    mw_inv = np.array(o.matrix_world.inverted())
    loc = a @ mw_inv[:3, :3].T + mw_inv[:3, 3]
    o.data.vertices.foreach_set('co', loc.astype(np.float64).ravel())
    o.data.update()


def transform_obj(o, M):
    """Applies a 4×4 (numpy) to the object's world matrix."""
    o.matrix_world = Matrix(M.tolist()) @ o.matrix_world


def normalize_orientation(objs, forward='+x'):
    """Rotates so the model faces +Z (Tripo's default export faces +X)."""
    ang = {'+x': -math.pi / 2, '-x': math.pi / 2, '+z': 0.0, '-z': math.pi, '+y': 0.0, '-y': 0.0}[forward]
    R = Matrix.Rotation(ang, 4, 'Y')
    for o in objs:
        if o.parent is None:
            o.matrix_world = R @ o.matrix_world


def floor_and_scale(objs, height=None):
    """Feet on y = 0, centred on x / z; scaled to `height` metres if given. Returns the height."""
    pts = np.concatenate([verts_np(o) for o in objs])
    lo, hi = pts.min(0), pts.max(0)
    s = (height / (hi[1] - lo[1])) if height else 1.0
    c = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    M = np.eye(4); M[:3, :3] *= s; M[:3, 3] = -c * s
    for o in objs:
        if o.parent is None:
            transform_obj(o, M)
    return (hi[1] - lo[1]) * s


def kd(points):
    t = kdtree.KDTree(len(points))
    for i, p in enumerate(points):
        t.insert(p, i)
    t.balance()
    return t


def umeyama(P, Q, scale=True):
    """Similarity transform (s, R, t) with s·R·p + t ≈ q (least squares)."""
    P, Q = np.asarray(P, float), np.asarray(Q, float)
    mp, mq = P.mean(0), Q.mean(0)
    X, Y = P - mp, Q - mq
    U, S, Vt = np.linalg.svd(Y.T @ X / len(P))
    D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    s = (np.trace(np.diag(S) @ D) / (X ** 2).sum(1).mean()) if scale else 1.0
    t = mq - s * R @ mp
    M = np.eye(4); M[:3, :3] = s * R; M[:3, 3] = t
    return M


def icp(src, dst, iters=30, scale=True, trim=0.8, max_step_scale=0.03):
    """Trimmed ICP (similarity): aligns point set src onto dst. Returns (4×4, rms)."""
    tree = kd([Vector(p) for p in dst])
    M = np.eye(4)
    cur = np.asarray(src, float).copy()
    rms = None
    for _ in range(iters):
        pairs = [tree.find(Vector(p)) for p in cur]
        d = np.array([x[2] for x in pairs])
        q = np.array([x[0] for x in pairs])
        keep = d <= np.quantile(d, trim)
        step = umeyama(cur[keep], q[keep], scale=scale)
        s = np.cbrt(abs(np.linalg.det(step[:3, :3])))
        if abs(s - 1) > max_step_scale:          # no runaway shrink / growth per step
            step[:3, :3] /= s; step[:3, :3] *= 1 + np.clip(s - 1, -max_step_scale, max_step_scale)
        cur = cur @ step[:3, :3].T + step[:3, 3]
        M = step @ M
        new = float(np.sqrt((d[keep] ** 2).mean()))
        if rms is not None and abs(rms - new) < 1e-6:
            rms = new; break
        rms = new
    return M, rms


def pca(P):
    P = np.asarray(P, float)
    c = P.mean(0)
    w, V = np.linalg.eigh(np.cov((P - c).T))
    order = np.argsort(w)[::-1]
    return c, V[:, order], w[order]


def section_width(P, axis_pt, axis_dir, t, band):
    """Mean radius of the points within ±band of the plane at axis_pt + t·axis_dir."""
    d = (P - axis_pt) @ axis_dir
    sel = P[np.abs(d - t) < band]
    if len(sel) < 12:
        return None, None
    c = sel.mean(0)
    r = np.linalg.norm((sel - c) - np.outer((sel - c) @ axis_dir, axis_dir), axis=1)
    return float(np.median(r)), c


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1, default=lambda x: x.tolist() if hasattr(x, 'tolist') else str(x))


def export_glb(path, objs, with_armature=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    if with_armature:
        with_armature.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_skins=bool(with_armature),
                              export_animations=False, export_yup=False, export_apply=False)


def save_blend(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)
