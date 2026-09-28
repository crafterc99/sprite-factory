"""
Export a generated character GLB (e.g. Hyper3D Rodin) to arrays for
fit_generated.py: positions (glTF axes: y up), UVs (one vertex per
(vertex, uv) pair), triangles, and the base-colour / normal textures.

Run with Blender's Python (bpy): python glb_export.py <model.glb> <out_dir>
Output: <out_dir>/mesh.npz (pos, uv, tri) + <out_dir>/tex/{diffuse,normal}.png + mesh.json
"""
import bpy, sys, os, json
import numpy as np

glb, out = sys.argv[-2], sys.argv[-1]
os.makedirs(out + '/tex', exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
dg = bpy.context.evaluated_depsgraph_get()
pos, uv, tris, key2i = [], [], [], {}
tex = {'diffuse': None, 'normal': None}
for o in meshes:
    me = o.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    uvl = me.uv_layers.active
    base = len(pos)
    M = o.matrix_world
    for t in me.loop_triangles:
        tri = []
        for li in t.loops:
            vi = me.loops[li].vertex_index
            u = tuple(round(x, 6) for x in uvl.data[li].uv) if uvl else (0.0, 0.0)
            k = (o.name, vi, u)
            if k not in key2i:
                key2i[k] = len(pos)
                # Blender imports glTF y-up as z-up: back to glTF axes (x, z, −y)
                p = M @ me.vertices[vi].co
                pos.append([p.x, p.z, -p.y])
                uv.append(u)
            tri.append(key2i[k])
        tris.append(tri)
    for slot in o.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for n in mat.node_tree.nodes:
            if n.type != 'TEX_IMAGE' or not n.image:
                continue
            dest = [l.to_socket.name for l in n.outputs['Color'].links] + [l.to_node.type for l in n.outputs['Color'].links]
            kind = 'normal' if 'NORMAL_MAP' in dest or 'Normal' in dest else 'diffuse' if 'Base Color' in dest else None
            if kind and not tex[kind]:
                img = n.image
                fn = f'{kind}.png'
                img.filepath_raw = out + '/tex/' + fn
                img.file_format = 'PNG'
                img.save()
                tex[kind] = fn
    o.evaluated_get(dg).to_mesh_clear()
np.savez(out + '/mesh.npz', pos=np.array(pos, np.float32), uv=np.array(uv, np.float32), tri=np.array(tris, np.int32))
info = {'vertices': len(pos), 'triangles': len(tris), 'textures': tex, 'objects': [o.name for o in meshes]}
json.dump(info, open(out + '/mesh.json', 'w'), indent=1)
print(json.dumps(info))
