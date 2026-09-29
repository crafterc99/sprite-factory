"""Preview renders of a character file (.blend or .glb): full body front / 3/4 / side / back and
close-ups (face, neck seam, both hands), textured (Workbench, texture colour, studio light).

  blender -b -P render_preview.py -- '{"input": "assembled/high.blend", "out_dir": "previews/assembled", "size": 1024,
                                        "mode": "textured|clay|wire", "hide": ["BODY_HIGH"]?}'
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import *

A = args()
if A['input'].endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=A['input'])
else:
    reset(); import_model(A['input'])
objs = [o for o in bpy.data.objects if o.type == 'MESH' and not o.hide_render and o.name not in A.get('hide', [])]
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.hide_render = o not in objs
P = np.concatenate([verts_np(o) for o in objs])
lo, hi = P.min(0), P.max(0); H = hi[1] - lo[1]; c = (lo + hi) / 2
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'TEXTURE' if A.get('mode', 'textured') == 'textured' else 'SINGLE'
sh.show_cavity = False
if A.get('mode') == 'wire':
    sh.show_xray = False; scene.display.shading.show_object_outline = False
scene.render.resolution_x = scene.render.resolution_y = int(A.get('size', 1024))
scene.render.film_transparent = False
scene.world = scene.world or bpy.data.worlds.new('w')
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam); scene.camera = cam
os.makedirs(A['out_dir'], exist_ok=True)


def shot(name, target, direction, dist, lens=50):
    # the files are Y-up; Blender's camera "up" is its local Y
    t = Vector(target); d = Vector(direction).normalized()
    cam.location = t + d * dist
    look = (t - cam.location).normalized()
    up = Vector((0, 1, 0))
    right = look.cross(up).normalized(); up2 = right.cross(look)
    M = Matrix((right, up2, -look)).transposed()
    cam.matrix_world = Matrix.Translation(cam.location) @ M.to_4x4()
    cam_data.lens = lens; cam_data.clip_start = 0.01; cam_data.clip_end = 100
    scene.render.filepath = os.path.join(A['out_dir'], name + '.png')
    bpy.ops.render.render(write_still=True)
    return scene.render.filepath


out = {}
mid = (float(c[0]), float(lo[1] + H * 0.5), float(c[2]))
for name, d in (('front', (0, 0.05, 1)), ('three_quarter', (0.7, 0.1, 0.7)), ('side', (1, 0.05, 0)), ('back', (0, 0.05, -1))):
    out[name] = shot(name, mid, d, H * 1.55, 50)
for k, (tgt, d, dist) in (A.get('closeups') or {}).items():
    out[k] = shot(k, tgt, d, dist, 60)
write_json(os.path.join(A['out_dir'], 'renders.json'), out)
log('rendered', ', '.join(out))
