"""GAME_MESH from the assembled SOURCE_HIGH: one welded surface at the game budget, with the high
master's look baked onto it.

  blender -b -P gamemesh.py -- '{"blend": "assembled/high.blend", "tris": 70000, "bake_size": 4096,
                                  "voxel": 0.0028, "out_glb": ..., "out_blend": ..., "tex_dir": ..., "report": ...}'

1. Fuse: copies of every part welded, joined and voxel remeshed → one watertight surface; the
   neck and wrist seam bands are then smoothed (±2.5 cm) so no lip survives.
2. Budget: collapse decimation to the LOD0 triangle target, weighted by a detail map: the face and
   the hands keep ~4× the density of flat cloth, the elbow / knee / shoulder / hip bands ~2×.
3. UVs: smart projection, margins for 4K mips.
4. Bake (Cycles, selected → active, cage extrusion): base colour (no lighting: the illustrated
   colour design stays, the court lights it), tangent-space normal, roughness, metallic, AO.
5. Export: GLB with a PBR material; textures also written as PNG (sRGB base colour; normal /
   roughness / metallic / AO non-colour).
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import *

A = args()
report = {'warnings': []}
t0 = time.time()
# the fused + decimated surface is cached next to the output (same assembly + budget → reused), so
# UV / bake changes don't redo the fusion
CACHE = os.path.join(os.path.dirname(A['out_blend']), f"fused-{int(A['tris'])}.blend")
if os.path.exists(CACHE) and os.path.getmtime(CACHE) > os.path.getmtime(A['blend']) and not A.get('refuse'):
    bpy.ops.wm.open_mainfile(filepath=CACHE)
    g = bpy.data.objects['GAME_MESH']
    high = [o for o in bpy.data.objects if o.type == 'MESH' and o is not g]
    H = max(verts_np(o)[:, 1].max() for o in high)
    report.update(json.loads(g.get('cf_report', '{}')))
    log(f'fused mesh from cache: {tri_count(g)} tris')
    FUSED = True
else:
    bpy.ops.wm.open_mainfile(filepath=A['blend'])
    high = [o for o in bpy.data.objects if o.type == 'MESH']
    H = max(verts_np(o)[:, 1].max() for o in high)
    FUSED = False
if not FUSED:

    # ── 1. fuse ──
    bpy.ops.object.select_all(action='DESELECT')
    copies = []
    for o in high:
        c = o.copy(); c.data = o.data.copy(); bpy.context.collection.objects.link(c); copies.append(c)
    # glTF import splits vertices at every UV seam: weld them first (else the surface is a patchwork of
    # open islands the voxel fill cannot close)
    for c in copies:
        bm = bmesh.new(); bm.from_mesh(c.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        # cap the cut openings (neck, wrists): the voxel fill needs closed parts, else it wraps open
        # regions in thin double sheets (folded faces, and decimation stalls on them)
        be = [e for e in bm.edges if e.is_boundary]
        if be:
            r = bmesh.ops.holes_fill(bm, edges=be, sides=0)
            bmesh.ops.triangulate(bm, faces=r['faces'])
        bm.to_mesh(c.data); bm.free()
    g = join(copies, 'GAME_MESH')
    g.data.materials.clear()
    voxel = float(A.get('voxel') or 0.0028 * H / 1.9)
    # (the voxel_remesh operator: the Remesh modifier ignores voxel_size in Blender 5.1)
    bpy.ops.object.select_all(action='DESELECT'); g.select_set(True); bpy.context.view_layer.objects.active = g
    g.data.remesh_voxel_size = voxel; g.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()
    # floating fragments of the fill (earring bits, hair strands thinner than a voxel) are dropped
    bm = bmesh.new(); bm.from_mesh(g.data)
    par = list(range(len(bm.verts)))
    def _f(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for e in bm.edges:
        par[_f(e.verts[0].index)] = _f(e.verts[1].index)
    from collections import Counter
    cnt = Counter(_f(v.index) for v in bm.verts)
    keep = {r for r, n in cnt.items() if n >= max(200, 0.001 * len(bm.verts))}
    drop = [v for v in bm.verts if _f(v.index) not in keep]
    bmesh.ops.delete(bm, geom=drop, context='VERTS'); bm.to_mesh(g.data); bm.free()
    report['fragments_removed'] = {'components': len(cnt) - len(keep), 'vertices': len(drop)}
    report['fused_triangles'] = tri_count(g)
    log(f'fused (voxel {voxel * 1000:.1f} mm): {tri_count(g)} tris in {time.time() - t0:.0f}s')

    # ── 1b. seam bands: the neck and wrist seams (from the assembly report) are smoothed over ±2.5 cm
    # on the welded surface, so no lip or step survives the fusion
    seams = []
    if A.get('assemble_report') and os.path.exists(A['assemble_report']):
        ar = json.load(open(A['assemble_report']))
        if 'neck' in ar and ar.get('head'):
            seams.append((np.array([0, ar['neck']['y'], 0.0]), np.array([0, 1.0, 0]), None))
        for k in ('hand_left', 'hand_right'):
            if ar.get(k, {}).get('wrist') is not None and ar[k].get('donor_triangles'):
                seams.append((np.array(ar[k]['wrist'], float), np.array(ar[k]['arm_axis'], float), 0.09))
    if seams:
        P = verts_np(g)
        wgt = np.zeros(len(P))
        for c, ax, rad in seams:
            d = np.abs((P - c) @ ax)
            m = d < 0.025
            if rad is not None:
                m &= np.linalg.norm(P - c, axis=1) < rad
            wgt[m] = np.maximum(wgt[m], 1 - d[m] / 0.025)
        vg0 = g.vertex_groups.new(name='seams')
        for i in np.where(wgt > 0)[0]:
            vg0.add([int(i)], float(wgt[i]), 'REPLACE')
        sm = g.modifiers.new('seam_smooth', 'LAPLACIANSMOOTH'); sm.vertex_group = 'seams'; sm.iterations = 12; sm.lambda_factor = 0.8; sm.use_volume_preserve = True
        bpy.ops.object.modifier_apply(modifier=sm.name)
        g.vertex_groups.remove(g.vertex_groups['seams'])
        report['seams_smoothed'] = {'seams': len(seams), 'vertices': int((wgt > 0).sum())}
        log(f'seam bands smoothed: {len(seams)} seams, {int((wgt > 0).sum())} vertices')

    # ── 2. detail-weighted decimation ──
    P = verts_np(g)
    w = np.ones(len(P))
    # head (above the shoulders) and hands (below the hips, beside the body) keep density
    # head (above the neck seam) and hands (beyond the wrists) from the assembly report
    ar0 = json.load(open(A['assemble_report'])) if A.get('assemble_report') and os.path.exists(A['assemble_report']) else {}
    neck_y = ar0.get('neck', {}).get('y', 0.86 * H)
    headm = P[:, 1] > neck_y - 0.02
    hands = np.zeros(len(P), bool)
    for k in ('hand_left', 'hand_right'):
        hk = ar0.get(k, {})
        if hk.get('wrist') is not None:
            c = np.array(hk['wrist']); ax = np.array(hk['arm_axis'])
            hands |= (((P - c) @ ax) > -0.02) & (np.linalg.norm(P - c, axis=1) < 0.24 * H / 1.9)
    w[headm] = 0.3
    w[hands] = 0.3
    for y in (0.28, 0.5, 0.63, 0.8):                    # knees, hips, elbows, shoulders
        w[np.abs(P[:, 1] - y * H) < 0.035 * H] = np.minimum(w[np.abs(P[:, 1] - y * H) < 0.035 * H], 0.55)
    vg = g.vertex_groups.new(name='decimate')
    for i, x in enumerate(w):
        vg.add([i], float(x), 'REPLACE')
    target = int(A['tris'])
    # weighted collapse: the weights skew the count, so the ratio is searched (evaluated, not applied)
    lo, hi = 0.0, 1.0
    ratio = min(1.0, target / max(1, tri_count(g)))
    for it in range(8):
        d = g.modifiers.new('budget', 'DECIMATE'); d.decimate_type = 'COLLAPSE'; d.ratio = ratio
        d.vertex_group = 'decimate'; d.vertex_group_factor = 0.8; d.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get(); ev = g.evaluated_get(dg)
        got = sum(len(p.vertices) - 2 for p in ev.data.polygons)
        if abs(got - target) / target < 0.05 or it == 7:
            bpy.ops.object.modifier_apply(modifier=d.name); break
        g.modifiers.remove(d)
        if got > target: hi = ratio
        else: lo = ratio
        ratio = (lo + hi) / 2 if hi < 1.0 or lo > 0 else ratio * target / got
    g.vertex_groups.remove(g.vertex_groups['decimate'])
    bpy.ops.object.shade_smooth()
    report['triangles'] = tri_count(g)
    Pd = verts_np(g)
    _hm = np.zeros(len(Pd), bool)
    for k in ('hand_left', 'hand_right'):
        hk = ar0.get(k, {})
        if hk.get('wrist') is not None:
            c = np.array(hk['wrist']); ax = np.array(hk['arm_axis']); _hm |= (((Pd - c) @ ax) > -0.02) & (np.linalg.norm(Pd - c, axis=1) < 0.24 * H / 1.9)
    report['density'] = {'head_share': float((Pd[:, 1] > neck_y - 0.02).mean()), 'hands_share': float(_hm.mean())}
    log(f'game mesh: {tri_count(g)} tris (target {target}); head {report["density"]["head_share"]:.0%} / hands {report["density"]["hands_share"]:.0%} of vertices')
    g['cf_report'] = json.dumps({k: report[k] for k in report if k != 'warnings'})
    save_blend(CACHE)

if A.get('fuse_only'):
    log('fuse only: cached', CACHE); sys.exit(0)

# ── 3. UVs ──
bpy.ops.object.select_all(action='DESELECT'); g.select_set(True); bpy.context.view_layer.objects.active = g
# projected on a smoothed copy (same topology): the fused surface's millimetre relief otherwise
# splits the projection into thousands of islands; UVs copied back, islands scaled evenly, packed
_sm = g.copy(); _sm.data = g.data.copy(); bpy.context.collection.objects.link(_sm)
_m = _sm.modifiers.new('s', 'SMOOTH'); _m.factor = 1.0; _m.iterations = 20
bpy.ops.object.select_all(action='DESELECT'); _sm.select_set(True); bpy.context.view_layer.objects.active = _sm
bpy.ops.object.modifier_apply(modifier='s')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0)
bpy.ops.object.mode_set(mode='OBJECT')
_uv = np.empty(len(_sm.data.loops) * 2); _sm.data.uv_layers.active.data.foreach_get('uv', _uv)
if not g.data.uv_layers: g.data.uv_layers.new(name='UVMap')
g.data.uv_layers.active.data.foreach_set('uv', _uv)
bpy.data.objects.remove(_sm, do_unlink=True)
bpy.ops.object.select_all(action='DESELECT'); g.select_set(True); bpy.context.view_layer.objects.active = g
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.select_all(action='SELECT')
bpy.ops.uv.average_islands_scale()
bpy.ops.uv.pack_islands(margin=0.0015, rotate=True, shape_method='CONCAVE')
bpy.ops.object.mode_set(mode='OBJECT')
_bm = bmesh.new(); _bm.from_mesh(g.data); _l = _bm.loops.layers.uv.active
report['uv_coverage'] = round(sum(abs((f.loops[1][_l].uv - f.loops[0][_l].uv).cross(f.loops[2][_l].uv - f.loops[0][_l].uv)) / 2 for f in _bm.faces), 3); _bm.free()
log(f'UVs: coverage {report["uv_coverage"]:.0%} of the texture')

# ── 4. bake ──
size = int(A.get('bake_size') or 2048)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for dv in prefs.devices: dv.use = True
    scene.cycles.device = 'GPU'
except Exception as e:
    log('GPU bake unavailable, CPU:', e)
scene.cycles.samples = int(A.get('samples') or 16)
bk = scene.render.bake
bk.use_selected_to_active = True; bk.use_cage = False
bk.cage_extrusion = float(A.get('extrusion') or 0.012); bk.max_ray_distance = float(A.get('ray') or 0.03); bk.margin = 16

mat = bpy.data.materials.new('SoulJamCharacter'); mat.use_nodes = True
g.data.materials.append(mat)
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
os.makedirs(A['tex_dir'], exist_ok=True)


def new_image(name, noncolor):
    im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    if noncolor:
        im.colorspace_settings.name = 'Non-Color'
    return im


def bake(kind, name, noncolor, **kw):
    path = os.path.join(A['tex_dir'], name + '.png')
    # a map already baked for this same fused mesh (and these UVs) is reused
    if not A.get('rebake') and os.path.exists(path) and os.path.exists(CACHE) and os.path.getmtime(path) > os.path.getmtime(CACHE) and A.get('uv_seed') == report.get('uv_seed'):
        im = bpy.data.images.load(path)
        if noncolor:
            im.colorspace_settings.name = 'Non-Color'
        node = nt.nodes.new('ShaderNodeTexImage'); node.image = im
        log(f'{name}: reused the baked map')
        return node, path
    im = new_image(name, noncolor)
    node = nt.nodes.new('ShaderNodeTexImage'); node.image = im
    for n in nt.nodes: n.select = False
    node.select = True; nt.nodes.active = node
    bpy.ops.object.select_all(action='DESELECT')
    if bk.use_selected_to_active:
        for o in high: o.select_set(True)
    g.select_set(True); bpy.context.view_layer.objects.active = g
    t = time.time()
    bpy.ops.object.bake(type=kind, **kw)
    im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    log(f'baked {name} ({kind}, {size}px) in {time.time() - t:.0f}s')
    return node, path


# metallic has no bake pass: each high material shows its metallic as emission for one bake
def with_emission_from(input_name, fn):
    saved = []
    for o in high:
        for slot in o.material_slots:
            m = slot.material
            if not m or not m.use_nodes: continue
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if not b: continue
            e = b.inputs.get('Emission Color') or b.inputs.get('Emission')
            s = b.inputs.get('Emission Strength')
            src = b.inputs[input_name]
            saved.append((m, e, s, e.default_value[:] if e else None, s.default_value if s else None, [l.from_socket for l in e.links] if e else []))
            if src.links:
                m.node_tree.links.new(src.links[0].from_socket, e)
            else:
                v = src.default_value; e.default_value = (v, v, v, 1)
            if s: s.default_value = 1.0
    try:
        return fn()
    finally:
        for m, e, s, dv, sv, links in saved:
            for l in list(e.links): m.node_tree.links.remove(l)
            for fs in links: m.node_tree.links.new(fs, e)
            if dv: e.default_value = dv
            if s is not None and sv is not None: s.default_value = sv


maps = {}
n_col, maps['baseColor'] = bake('DIFFUSE', 'baseColor', False, pass_filter={'COLOR'})
n_nrm, maps['normal'] = bake('NORMAL', 'normal', True, normal_space='TANGENT')
n_rgh, maps['roughness'] = bake('ROUGHNESS', 'roughness', True)
n_met, maps['metallic'] = with_emission_from('Metallic', lambda: bake('EMIT', 'metallic', True))
if A.get('ao', True):
    scene.cycles.samples = int(A.get('ao_samples') or 16)
    bk.use_selected_to_active = False
    for o in high:                                   # AO of the game mesh alone (the 7M-triangle sources made it take > 40 min)
        o.hide_render = True
    n_ao, maps['ao'] = bake('AO', 'ao', True)
report['textures'] = maps

# wire the baked maps into the game material
L = nt.links
L.new(n_col.outputs['Color'], bsdf.inputs['Base Color'])
nm = nt.nodes.new('ShaderNodeNormalMap'); L.new(n_nrm.outputs['Color'], nm.inputs['Color']); L.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
L.new(n_rgh.outputs['Color'], bsdf.inputs['Roughness'])
L.new(n_met.outputs['Color'], bsdf.inputs['Metallic'])

# SOURCE_HIGH stays in the file, hidden from the export
for o in high:
    o.hide_render = True
save_blend(A['out_blend'])
export_glb(A['out_glb'], [g])
report['seconds'] = round(time.time() - t0)
write_json(A['report'], report)
log(f'game mesh exported: {A["out_glb"]}')
