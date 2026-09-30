"""LOD meshes from a finished, textured model: collapse-decimated copies that keep the UVs and the
materials (the textures are shared with LOD 0, never re-baked).

  blender -b -P lods.py -- '{"input": "model.glb", "ratios": [0.5, 0.25, 0.1], "out_dir": "…/lods", "report": "…/lods.json"}'

The UV seams are protected: vertices on a seam are welded for the decimation (so the surface can't
crack) and the UV layout is carried by the collapse interpolation.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import *

A = args()
reset()
ms, arm = import_model(A['input'], 'SRC')
for o in ms:
    for mod in [x for x in o.modifiers if x.type == 'ARMATURE']:
        o.modifiers.remove(mod)
if arm:
    for o in ms:
        if o.parent is arm:
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    bpy.data.objects.remove(arm, do_unlink=True)
# every parent (the armature, a GLB's scene-root empty) is cleared keeping the world transform:
# the LOD must sit exactly where LOD 0 sits (a lost root offset put AC's LODs 1.13 m under the floor)
for o in ms:
    if o.parent is not None:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
src = join(ms, 'SRC') if len(ms) > 1 else ms[0]
apply_transforms([src])
# weld the UV-seam splits (UVs live on the face corners, so they survive): decimation can't open cracks
bm = bmesh.new(); bm.from_mesh(src.data); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6); bm.to_mesh(src.data); bm.free()
base = tri_count(src)
report = {'source_triangles': base, 'lods': []}
os.makedirs(A['out_dir'], exist_ok=True)
for i, r in enumerate(A['ratios'], start=1):
    o = src.copy(); o.data = src.data.copy(); bpy.context.collection.objects.link(o)
    o.name = f'LOD{i}'
    d = o.modifiers.new('lod', 'DECIMATE'); d.decimate_type = 'COLLAPSE'; d.ratio = float(r); d.use_collapse_triangulate = True
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier='lod')
    path = os.path.join(A['out_dir'], f'lod{i}.glb')
    export_glb(path, [o])
    report['lods'].append({'lod': i, 'ratio': r, 'triangles': tri_count(o), 'file': path})
    log(f'LOD{i}: {tri_count(o)} tris')
    bpy.data.objects.remove(o, do_unlink=True)
write_json(A['report'], report)
