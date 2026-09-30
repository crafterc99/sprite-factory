"""
The game's basketball from the Spalding model (OBJ, 3ds Max, inches, no texture).

    blender -b --factory-startup -P tools/ball/build_ball.py -- <basketball spalding.obj> assets/models/basketball.glb

The model's seams are raised ribs. They are found on the mesh (a vertex standing above its
neighbourhood), widened into the seam stripe and baked as vertex colours: orange leather, black
seams. The ball is centred and scaled to radius 1 (the game scales it to the physics radius,
BALL_R = 0.12 m), with no UVs (nothing samples a texture).
"""
import bpy, math, sys
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
OBJ, OUT = args[0], args[1]
RINGS, DIL = 3, 2
ORANGE, SEAM = np.array([0.80, 0.26, 0.05]), np.array([0.02, 0.018, 0.016])   # linear RGB

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=OBJ)
ob = bpy.context.selected_objects[0]; me = ob.data
bpy.context.view_layer.objects.active = ob
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
P = np.array([v.co[:] for v in me.vertices]); n = len(P)

# centre + radius: least-squares sphere
A = np.c_[2 * P, np.ones(n)]; b = (P ** 2).sum(1)
x = np.linalg.lstsq(A, b, rcond=None)[0]; c = x[:3]; R = math.sqrt(x[3] + c @ c)
r = np.linalg.norm(P - c, axis=1)

# seams: vertices standing above their neighbourhood (the ribs), widened into stripes
E = np.array([e.vertices[:] for e in me.edges]); deg = np.bincount(E.ravel(), minlength=n).astype(float)
def smooth(f):
    s = np.zeros(n); np.add.at(s, E[:, 0], f[E[:, 1]]); np.add.at(s, E[:, 1], f[E[:, 0]]); return (s + f) / (deg + 1)
m = r.copy()
for _ in range(RINGS * 3): m = smooth(m)
conv = (r - m) / R
t0, t1 = np.percentile(conv, 88), np.percentile(conv, 96)
seam = np.clip((conv - t0) / max(1e-9, t1 - t0), 0, 1)
for _ in range(DIL):
    s2 = seam.copy(); np.maximum.at(s2, E[:, 0], seam[E[:, 1]]); np.maximum.at(s2, E[:, 1], seam[E[:, 0]]); seam = s2
seam = smooth(seam)

col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
rgb = ORANGE[None] * (1 - seam[:, None]) + SEAM[None] * seam[:, None]
col.data.foreach_set('color', np.c_[rgb, np.ones(n)].ravel().astype(np.float32))

# radius 1 at the origin
for i, v in enumerate(me.vertices): v.co = (P[i] - c) / R
for uv in list(me.uv_layers): me.uv_layers.remove(uv)
me.materials.clear()
mat = bpy.data.materials.new('basketball')
mat.use_nodes = True
nt = mat.node_tree; bs = next(k for k in nt.nodes if k.type == 'BSDF_PRINCIPLED')
va = nt.nodes.new('ShaderNodeVertexColor'); va.layer_name = 'Col'; nt.links.new(va.outputs[0], bs.inputs['Base Color'])
bs.inputs['Roughness'].default_value = 0.62
me.materials.append(mat)
me.shade_smooth()

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=False, export_texcoords=False, export_normals=True,
                          export_materials='EXPORT', export_yup=True, export_apply=True)
print(f'ball: {n} vertices, {len(me.polygons)} faces, R {R:.3f} (model units), seams {float((seam > 0.5).mean()):.2f} of vertices -> {OUT}')
