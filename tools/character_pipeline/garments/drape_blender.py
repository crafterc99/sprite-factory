"""Drape a garment on the body with Blender's cloth simulation (run inside Blender):

  blender -b -P drape_blender.py -- '{"body": "body.npz", "garment": "in.npz", "out": "out.npz",
                                      "under": ["shorts_draped.npz"], "frames": 90}'

body.npz: V, F (the rig's bind body, game axes: y up). garment in.npz: V, F (welded), pin (0…1 per
vertex: 1 = held where it is, e.g. an elastic waistband). under: garments already draped, worn
under this one (they collide too). Gravity is -y (game axes, no conversion). The fabric is limp
cotton: it falls from its cut shape onto the body, rests on the shoulders / hips and hangs.
out.npz: V (draped), motion (the largest vertex move over the last 10 frames: settled if small).
"""
import sys, json
import bpy
import numpy as np

A = json.loads(sys.argv[sys.argv.index('--') + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.gravity = (0.0, -9.81, 0.0)
sc.render.fps = 30


def mesh_obj(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata(np.asarray(V, float).tolist(), [], np.asarray(F, int).tolist())
    me.update()
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    return ob


def collider(ob, thickness):
    m = ob.modifiers.new('col', 'COLLISION')
    ob.collision.thickness_outer = thickness
    ob.collision.thickness_inner = 0.01
    ob.collision.cloth_friction = A.get('friction', 8.0)
    ob.collision.damping = 0.2
    return m


b = np.load(A['body'])
collider(mesh_obj('body', b['V'], b['F']), A.get('bodyThickness', 0.004))
for i, u in enumerate(A.get('under', [])):
    d = np.load(u)
    collider(mesh_obj(f'under{i}', d['V'], d['F']), A.get('underThickness', 0.004))

g = np.load(A['garment'])
ob = mesh_obj('garment', g['V'], g['F'])
pin = g['pin'] if 'pin' in g.files else None
cl = ob.modifiers.new('cloth', 'CLOTH')
s = cl.settings
s.quality = A.get('quality', 8)
s.mass = A.get('mass', 0.15)
s.air_damping = A.get('airDamping', 2.0)
# limp cotton: resists stretching, not compression (it buckles into folds instead of holding a shape)
s.tension_stiffness = A.get('stiffness', 20.0)
s.compression_stiffness = A.get('compression', 0.5)
s.shear_stiffness = A.get('shear', 1.0)
s.bending_stiffness = A.get('bending', 0.05)
s.tension_damping = s.compression_damping = s.shear_damping = 5.0
if pin is not None and pin.max() > 0:
    vg = ob.vertex_groups.new(name='pin')
    for i, w in enumerate(pin):
        if w > 1e-3: vg.add([i], float(w), 'REPLACE')
    s.vertex_group_mass = 'pin'
    s.pin_stiffness = 1.0
c = cl.collision_settings
c.use_collision = True
c.distance_min = A.get('distance', 0.004)
c.collision_quality = A.get('collisionQuality', 4)
c.use_self_collision = A.get('selfCollision', True)
c.self_distance_min = 0.003
c.self_friction = 5.0
N = A.get('frames', 90)
cl.point_cache.frame_start = 1
cl.point_cache.frame_end = N
sc.frame_start, sc.frame_end = 1, N
hist = []
for f in range(1, N + 1):
    sc.frame_set(f)
    if f > N - 11:
        dg = bpy.context.evaluated_depsgraph_get()
        me = ob.evaluated_get(dg).to_mesh()
        P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P)
        hist.append(P.reshape(-1, 3))
        ob.evaluated_get(dg).to_mesh_clear()
motion = float(np.linalg.norm(hist[-1] - hist[0], axis=1).max()) if len(hist) > 1 else 0.0
np.savez(A['out'], V=hist[-1], motion=np.array([motion]))
print(json.dumps({'draped': A['garment'], 'frames': N, 'settleMotion': round(motion, 4)}))
