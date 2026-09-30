"""Fit preview: the rig's bind body + garment meshes (npz), rendered front / side / back / 3-4.

  blender -b -P preview_blender.py -- '{"body": "body.npz", "garments": ["shorts.npz"], "out": "fit.png",
                                        "texture": {"shorts.npz": "shorts_color.png"}, "size": 700}'

The body npz holds V (bind pose, game axes: y up, facing +z) and F; a garment npz holds V, F and UV.
"""
import bpy, json, math, sys, os
import numpy as np
from mathutils import Vector

A = json.loads(sys.argv[sys.argv.index('--') + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def to_blender(V):
    V = np.asarray(V, np.float64)
    return np.stack([V[:, 0], -V[:, 2], V[:, 1]], 1)     # game (y up, +z front) → Blender (z up, -y front)


def add_mesh(name, V, F, color, uv=None, tex=None, rough=0.8):
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_blender(V).tolist(), [], np.asarray(F).tolist())
    me.update()
    for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    mat = bpy.data.materials.new(name + '_m'); mat.use_nodes = True
    bs = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = rough
    if uv is not None:
        ul = me.uv_layers.new(name='UVMap')
        loops = np.asarray(F).ravel()
        ul.data.foreach_set('uv', np.asarray(uv)[loops].ravel())
        if tex and os.path.exists(tex):
            im = bpy.data.images.load(tex)
            tn = mat.node_tree.nodes.new('ShaderNodeTexImage'); tn.image = im
            mat.node_tree.links.new(tn.outputs['Color'], bs.inputs['Base Color'])
    mat.use_backface_culling = False
    ob.data.materials.append(mat)
    return ob


b = np.load(A['body'])
add_mesh('body', b['V'], b['F'], (0.42, 0.28, 0.2), rough=0.6)
cols = [(0.85, 0.12, 0.1), (0.95, 0.95, 0.97), (0.1, 0.3, 0.85), (0.2, 0.8, 0.3)]
for i, g in enumerate(A.get('garments', [])):
    d = np.load(g)
    add_mesh(os.path.basename(g), d['V'], d['F'], cols[i % len(cols)], d['UV'] if 'UV' in d else None, (A.get('texture') or {}).get(g))

# light + camera
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.77, 0.8, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun)
sun.data.energy = 3.2; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'
zc = A.get('centerZ', 1.0); cam.data.ortho_scale = A.get('orthoScale', 1.3)
S = A.get('size', 640)
sc.render.resolution_x, sc.render.resolution_y = S, int(S * 1.1)
sc.render.film_transparent = False
views = A.get('views', [('front', 0), ('side', 90), ('back', 180), ('34', 35)])
outs = []
for nm, deg in views:
    a = math.radians(deg)
    # the character faces -Y in Blender: the front camera sits at -Y
    cam.location = (3.5 * math.sin(a), -3.5 * math.cos(a), zc)
    cam.rotation_euler = (math.radians(90), 0, a)
    f = A['out'].replace('.png', f'_{nm}.png')
    sc.render.filepath = f
    bpy.ops.render.render(write_still=True)
    outs.append(f)
print(json.dumps({'renders': outs}))
