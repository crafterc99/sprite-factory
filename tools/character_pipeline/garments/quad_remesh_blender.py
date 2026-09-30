"""Quad remesh of a closed surface (Quadriflow), run inside Blender:

  blender -b -P quad_remesh_blender.py -- in.npz out.npz <target_faces>

in.npz holds V (n, 3) and F (m, 3) of a closed, manifold surface; out.npz gets V and Q (quads,
-1 in the 4th slot for a triangle). Coordinates pass through untouched.

Quadriflow's own manifold check is fussy (it can refuse a surface bmesh calls manifold), so this
tries the surface as given, then after voxel remeshes of a few sizes, until one finishes.
"""
import sys
import bpy
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
inp, out, target = argv[:3]
MODE = argv[3] if len(argv) > 3 else 'closed'      # open: the surface has boundaries (kept; no voxel remesh)
d = np.load(inp)


def attempt(voxel, seed=0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    me = bpy.data.meshes.new('s')
    me.from_pydata(d['V'].astype(float).tolist(), [], d['F'].astype(int).tolist())
    me.update()
    ob = bpy.data.objects.new('s', me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    if voxel:
        me.remesh_voxel_size = voxel
        bpy.ops.object.voxel_remesh()
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    try:
        r = bpy.ops.object.quadriflow_remesh(target_faces=int(target), use_mesh_symmetry=False, use_preserve_sharp=False,
                                             use_preserve_boundary=MODE == 'open', smooth_normals=False, mode='FACES', seed=seed)
    except Exception as e:  # noqa: BLE001
        r = {'CANCELLED', str(e)}
    ok = 'FINISHED' in r and len(ob.data.polygons) < int(target) * 2
    print('quadriflow attempt', MODE, voxel, seed, r, len(ob.data.polygons))
    return ok, ob


tries = [(None, s) for s in range(4)] if MODE == 'open' else [(v, 0) for v in (None, 0.006, 0.007, 0.008, 0.005, 0.01)]
for vox, seed in tries:
    ok, ob = attempt(vox, seed)
    if ok: break
me = ob.data
nv, nf = len(me.vertices), len(me.polygons)
V = np.zeros(nv * 3); me.vertices.foreach_get('co', V)
Q = -np.ones((nf, 4), np.int64)
for i, p in enumerate(me.polygons):
    vs = list(p.vertices)
    if len(vs) > 4:
        raise SystemExit(f'polygon with {len(vs)} sides')
    Q[i, :len(vs)] = vs
np.savez(out, V=V.reshape(-1, 3), Q=Q, ok=np.array([ok]))
