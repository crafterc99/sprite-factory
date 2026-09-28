"""
Export an MPFB (MakeHuman for Blender, CC0 output) character for the 3D court:
rest-pose geometry of every part (body, clothes, hair, eyes, brows, lashes),
UVs, the MPFB rig's bone weights and bone heads/tails, and the textures.

Run inside Blender's Python (bpy): python export_mpfb.py <human.blend> <out_dir>
Output: <out_dir>/parts.npz + <out_dir>/tex/*.png + <out_dir>/parts.json
"""
import bpy, sys, os, json
import numpy as np

blend, out = sys.argv[-2], sys.argv[-1]
os.makedirs(out + '/tex', exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=blend)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
bones = [b.name for b in rig.data.bones]
BI = {n: i for i, n in enumerate(bones)}
heads = np.array([list(rig.matrix_world @ b.head_local) for b in rig.data.bones])
tails = np.array([list(rig.matrix_world @ b.tail_local) for b in rig.data.bones])
# rest pose: armature to REST so evaluated meshes are undeformed
rig.data.pose_position = 'REST'
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()


def images_of(mat):
    """(diffuse, normal) image of a material, by node links."""
    diff = norm = None
    if not mat or not mat.use_nodes:
        return diff, norm
    for n in mat.node_tree.nodes:
        if n.type != 'TEX_IMAGE' or not n.image:
            continue
        to = [l.to_socket.name.lower() for l in n.outputs['Color'].links]
        to += [l.to_node.type for l in n.outputs['Color'].links]
        nm = (n.image.name + ' ' + n.label + ' ' + n.name).lower()
        if 'normal' in nm or 'NORMAL_MAP' in to or 'norm' in nm:
            norm = norm or n.image
        elif 'rough' in nm or 'spec' in nm or 'ao' in nm.split() or 'bump' in nm:
            continue
        else:
            diff = diff or n.image
    return diff, norm


def save_img(img, name):
    """Copy the texture's source file (MPFB asset folder) next to the export."""
    if img is None:
        return None
    import shutil
    srcp = bpy.path.abspath(img.filepath)
    if not os.path.exists(srcp):
        print('missing texture file', img.name, srcp)
        return None
    fn = name + os.path.splitext(srcp)[1].lower()
    shutil.copy(srcp, out + '/tex/' + fn)
    return fn


parts, arrays = [], {}
for o in bpy.data.objects:
    if o.type != 'MESH' or not (o.name == 'Human' or o.name.startswith('Human.')):
        continue
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    uvl = me.uv_layers.active
    # split vertices at UV seams: one output vertex per (vertex, uv) pair
    key2i, pos, uv, src = {}, [], [], []
    tris = []
    matidx = []
    for t in me.loop_triangles:
        tri = []
        for li in t.loops:
            vi = me.loops[li].vertex_index
            u = tuple(round(x, 6) for x in uvl.data[li].uv) if uvl else (0.0, 0.0)
            k = (vi, u)
            if k not in key2i:
                key2i[k] = len(pos)
                pos.append(list(o.matrix_world @ me.vertices[vi].co))
                uv.append(u)
                src.append(vi)
            tri.append(key2i[k])
        tris.append(tri)
        matidx.append(t.material_index)
    # bone weights (top 4) from the evaluated mesh's vertex groups
    gnames = [g.name for g in o.vertex_groups]
    W = np.zeros((len(pos), 4), np.float32)
    I = np.zeros((len(pos), 4), np.int32)
    for k, vi in enumerate(src):
        gs = [(BI[gnames[g.group]], g.weight) for g in me.vertices[vi].groups if g.group < len(gnames) and gnames[g.group] in BI and g.weight > 1e-4]
        gs.sort(key=lambda x: -x[1])
        for s, (b, w) in enumerate(gs[:4]):
            I[k, s] = b
            W[k, s] = w
    # one material per part (the first used)
    mi = max(set(matidx), key=matidx.count) if matidx else 0
    mat = o.material_slots[mi].material if o.material_slots else None
    d, n = images_of(mat)
    name = o.name.replace('Human.', '').replace('Human', 'body')
    parts.append({'name': name, 'n': len(pos), 'tris': len(tris), 'diffuse': save_img(d, name + '_diffuse'), 'normal': save_img(n, name + '_normal'),
                  'alpha': name != 'body' and (name.startswith('eyebrow') or name.startswith('eyelash') or 'hair' in name)})
    arrays[name + '_pos'] = np.array(pos, np.float32)
    arrays[name + '_uv'] = np.array(uv, np.float32)
    arrays[name + '_tri'] = np.array(tris, np.int32)
    arrays[name + '_bi'] = I
    arrays[name + '_bw'] = W
    ev.to_mesh_clear()
np.savez(out + '/parts.npz', heads=heads, tails=tails, **arrays)
json.dump({'bones': bones, 'parents': [b.parent.name if b.parent else None for b in rig.data.bones], 'parts': parts}, open(out + '/parts.json', 'w'), indent=1)
print(json.dumps([(p['name'], p['n'], p['diffuse'], p['normal'], p['alpha']) for p in parts]))
