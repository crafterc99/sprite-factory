"""Tripo auto-rig → our GAME_MESH, then the LOD chain.

  blender -b -P rigmerge.py -- '{"game": "game/lod0.glb", "rig": "rigs/tripo_rig.glb", "lods": [70000, 36000, 16000, 6000],
                                  "out_dir": "rigs/", "report": ...}'

Tripo's rigs give the bone placement and skin weights: rig v1.0 (spec mixamo) the Mixamo-named body,
rig v2.5 the fingers (its own `tripo::` names, 1–3 bones per finger), grafted onto the Mixamo
armature as mixamorig:*Hand<Finger>1–4 (thumb = the chain starting nearest the wrist, then index →
pinky across the hand). The weights are transferred onto
our own baked game mesh (nearest-surface interpolation), so the topology, UVs and textures we
baked are exactly what ships — whatever Tripo does to materials during rigging. The Tripo
armature is only an intermediate: the importer maps it onto SOUL_JAM_MASTER_SKELETON.
LODs are collapse-decimated from the rigged LOD0: weights and UVs carry over, the textures are
shared.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import *

A = args()
reset()
report = {'warnings': []}
gm, _ = import_model(A['game'], 'GAME')
game = join(gm, 'GAME') if len(gm) > 1 else gm[0]
apply_transforms([game])
Pg = verts_np(game)
tree = kd([Vector(p) for p in Pg[np.random.default_rng(0).choice(len(Pg), min(len(Pg), 40000), replace=False)]])


def load_rig(path, tag):
    """Imports a Tripo rig output, lines its mesh up with ours (four turns about Y + scale), applies
    the armature transform. Returns (armature, rig mesh)."""
    rm, arm = import_model(path, tag)
    if not arm:
        raise RuntimeError(f'{os.path.basename(path)} has no armature')
    for o in rm:
        o.modifiers.clear() if len(rm) > 1 else None
    mesh = rm[0] if len(rm) == 1 else join(rm, tag)
    Pr0 = verts_np(mesh)
    sub = Pr0[np.random.default_rng(1).choice(len(Pr0), min(len(Pr0), 4000), replace=False)]
    best = None
    for k in range(4):
        R = np.array(Matrix.Rotation(k * math.pi / 2, 3, 'Y'))
        q = sub @ R.T
        sc_ = np.ptp(Pg[:, 1]) / max(1e-6, np.ptp(q[:, 1])); q = q * sc_
        q += np.array([Pg[:, 0].mean(), Pg[:, 1].min(), Pg[:, 2].mean()]) - np.array([q[:, 0].mean(), q[:, 1].min(), q[:, 2].mean()])
        d = np.mean([tree.find(Vector(p))[2] for p in q])
        if best is None or d < best[0]:
            best = (d, k, sc_)
    d, k, sc_ = best
    if k or abs(sc_ - 1) > 1e-3:
        arm.matrix_world = Matrix.Rotation(k * math.pi / 2, 4, 'Y') @ Matrix.Scale(sc_, 4) @ arm.matrix_world
        bpy.context.view_layer.update()
        Pr = verts_np(mesh)
        off = np.array([Pg[:, 0].mean(), Pg[:, 1].min(), Pg[:, 2].mean()]) - np.array([Pr[:, 0].mean(), Pr[:, 1].min(), Pr[:, 2].mean()])
        arm.matrix_world = Matrix.Translation(Vector(off)) @ arm.matrix_world
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    log(f'{tag}: {len(arm.data.bones)} bones; aligned with {k} quarter turns, gap {d * 100:.2f} cm')
    return arm, mesh, {'bones': len(arm.data.bones), 'turns_about_y': k, 'scale': sc_, 'mean_gap_cm': d * 100}


def transfer(src_mesh, prefix=''):
    """Skin weights of the rig mesh onto our game mesh (nearest surface, interpolated)."""
    names = [vg.name for vg in src_mesh.vertex_groups]
    if prefix:
        for vg in src_mesh.vertex_groups:
            vg.name = prefix + vg.name
    for vg in src_mesh.vertex_groups:
        if vg.name not in game.vertex_groups:
            game.vertex_groups.new(name=vg.name)
    dt = game.modifiers.new('weights', 'DATA_TRANSFER')
    dt.object = src_mesh; dt.use_vert_data = True; dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'; dt.layers_vgroup_select_src = 'ALL'; dt.layers_vgroup_select_dst = 'NAME'
    bpy.ops.object.select_all(action='DESELECT'); game.select_set(True); bpy.context.view_layer.objects.active = game
    bpy.ops.object.modifier_apply(modifier=dt.name)
    return names


# the Mixamo-named rig (body: names, placement, weights) — and optionally Tripo's finger rig
arm, rigmesh, info = load_rig(A['rig'], 'RIG')
report['rig'] = info
if game.parent:
    mw = game.matrix_world.copy(); game.parent = None; game.matrix_world = mw
transfer(rigmesh)
report['bones'] = len(arm.data.bones)

# ── fingers from Tripo's finger rig, grafted onto the Mixamo armature ──
if A.get('finger_rig'):
    farm, fmesh, finfo = load_rig(A['finger_rig'], 'FINGERS')
    report['finger_rig'] = finfo
    transfer(fmesh, prefix='F:')
    fw = {b.name: (np.array(farm.matrix_world @ b.head_local), np.array(farm.matrix_world @ b.tail_local)) for b in farm.data.bones}
    kids = {b.name: [c.name for c in b.children] for b in farm.data.bones}
    mix = lambda n: 'mixamorig:' + n
    hands = {s: np.array(arm.matrix_world @ arm.data.bones[mix(s + 'Hand')].head_local) for s in ('Left', 'Right') if mix(s + 'Hand') in arm.data.bones}
    grafted = {}
    for side, hpos in hands.items():
        # the finger rig's wrist: the bone whose head is nearest the Mixamo hand and that has ≥ 4 child chains
        cands = [n for n in fw if len(kids[n]) >= 4]
        if not cands:
            report['warnings'].append('finger rig: no hand bone with finger chains'); break
        wrist = min(cands, key=lambda n: np.linalg.norm(fw[n][0] - hpos))
        chains = []
        for c in kids[wrist]:
            ch = [c]
            while len(kids[ch[-1]]) == 1:
                ch.append(kids[ch[-1]][0])
            chains.append(ch)
        chains = [c for c in chains if c][:5]
        if len(chains) != 5:
            report['warnings'].append(f'finger rig: {side} hand has {len(chains)} chains, not 5 — fingers not grafted'); continue
        W = fw[wrist][0]
        # thumb: the chain starting nearest the wrist; then index → pinky by distance from the thumb's base
        thumb = min(chains, key=lambda c: np.linalg.norm(fw[c[0]][0] - W))
        rest = sorted([c for c in chains if c is not thumb], key=lambda c: np.linalg.norm(fw[c[0]][0] - fw[thumb[0]][0]))
        order = dict(zip(['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'], [thumb] + rest))
        # the finger's tip: the farthest game-mesh vertex weighted to its last bone, along the finger
        pts_by_finger = {}
        for f, ch in order.items():
            pl = [fw[n][0] for n in ch] + [fw[ch[-1]][1]]
            # (only vertices near the last joint count: hands resting on the shorts carry fingertip
            # weight onto the thigh, and the farthest of those is not a fingertip)
            last = game.vertex_groups.get('F:' + ch[-1])
            prev_len = np.linalg.norm(pl[-2] - pl[-3]) if len(pl) >= 3 else np.linalg.norm(pl[-1] - pl[-2])
            reach = min(0.05, 2.5 * max(prev_len, 0.01))
            if last is not None:
                vs = np.array([Pg[v.index] for v in game.data.vertices if any(g.group == last.index and g.weight > 0.5 for g in v.groups)])
                vs = vs[np.linalg.norm(vs - pl[-2], axis=1) < reach] if len(vs) else vs
                if len(vs):
                    dirv = pl[-1] - pl[-2]; dirv /= (np.linalg.norm(dirv) or 1)
                    tip = vs[np.argmax((vs - pl[-2]) @ dirv)]
                    pl[-1] = tip
            seglen = np.linalg.norm(pl[-1] - pl[-2]); cap = 1.3 * max(prev_len, 0.012)
            if seglen > cap:
                pl[-1] = pl[-2] + (pl[-1] - pl[-2]) * (cap / seglen)
            # resample to 4 joints (1–3 + tip) at the knuckle fractions of a Mixamo finger
            seg = np.cumsum([0] + [np.linalg.norm(pl[i + 1] - pl[i]) for i in range(len(pl) - 1)])
            fr = [0.0, 0.42, 0.72, 1.0] if f != 'Thumb' else [0.0, 0.4, 0.72, 1.0]
            pts = [np.array([np.interp(t * seg[-1], seg, [p[k] for p in pl]) for k in range(3)]) for t in fr]
            pts_by_finger[f] = pts
        bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode='EDIT')
        eb = arm.data.edit_bones
        for f, pts in pts_by_finger.items():
            parent = eb[mix(side + 'Hand')]
            for k in range(4):
                name = mix(f'{side}Hand{f}{k + 1}')
                b = eb.get(name) or eb.new(name)
                b.head = Vector(pts[k]); b.tail = Vector(pts[k] + (pts[k] - pts[k - 1] if k else pts[1] - pts[0]) * (0.6 if k == 3 else 1.0))
                b.parent = parent; b.use_connect = False; parent = b
        bpy.ops.object.mode_set(mode='OBJECT')
        # weights: each vertex's Mixamo hand weight is split between the palm and the fingers in the
        # finger rig's proportions (the importer then re-rigs the fingers one finger per vertex)
        gi = {vg.name: vg.index for vg in game.vertex_groups}
        hand_g = game.vertex_groups[mix(side + 'Hand')]
        fin_groups = {f: [gi['F:' + n] for n in ch if 'F:' + n in gi] for f, ch in order.items()}
        wrist_g = gi.get('F:' + wrist)
        for f in order:
            for k in range(3):
                n = mix(f'{side}Hand{f}{k + 1}')
                if n not in game.vertex_groups: game.vertex_groups.new(name=n)
        moved = 0
        for v in game.data.vertices:
            gw = {g.group: g.weight for g in v.groups}
            hw = gw.get(hand_g.index, 0.0)
            if hw <= 0:
                continue
            fwt = {f: sum(gw.get(i, 0.0) for i in idx) for f, idx in fin_groups.items()}
            tot = sum(fwt.values()) + gw.get(wrist_g, 0.0)
            if tot <= 1e-4 or sum(fwt.values()) <= 1e-4:
                continue
            p = Pg[v.index]
            hand_g.add([v.index], hw * gw.get(wrist_g, 0.0) / tot, 'REPLACE')
            for f, w in fwt.items():
                if w <= 0: continue
                pts = pts_by_finger[f]
                k = int(np.argmin([np.linalg.norm(p - (pts[i] + pts[i + 1]) / 2) for i in range(3)]))
                game.vertex_groups[mix(f'{side}Hand{f}{k + 1}')].add([v.index], hw * w / tot, 'ADD')
            moved += 1
        grafted[side] = {'wrist_bone': wrist, 'chains': {f: len(ch) for f, ch in order.items()}, 'hand_vertices_split': moved}
        log(f'{side} fingers grafted from {wrist}: ' + ', '.join(f'{f} {len(ch)} bones' for f, ch in order.items()) + f'; {moved} hand vertices split')
    report['fingers'] = grafted
    for vg in [g for g in game.vertex_groups if g.name.startswith('F:')]:
        game.vertex_groups.remove(vg)
    bpy.data.objects.remove(fmesh, do_unlink=True)
    bpy.data.objects.remove(farm, do_unlink=True)
report['bone_names'] = [b.name for b in arm.data.bones]
report['bones'] = len(arm.data.bones)

# normalise, limit to 4 influences (the renderer's limit), drop orphans
bpy.ops.object.select_all(action='DESELECT'); game.select_set(True); bpy.context.view_layer.objects.active = game
bpy.ops.object.vertex_group_clean(group_select_mode='ALL', limit=0.01)
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
unweighted = sum(1 for v in game.data.vertices if not v.groups)
report['unweighted_vertices'] = unweighted
if unweighted:
    report['warnings'].append(f'{unweighted} vertices without weights')
game.parent = arm
am = game.modifiers.new('Armature', 'ARMATURE'); am.object = arm
for o in [x for x in bpy.data.objects if x.type == 'MESH' and x is not game]:
    bpy.data.objects.remove(o, do_unlink=True)          # Tripo's rigged copies of our mesh

os.makedirs(A['out_dir'], exist_ok=True)
outs = []
lods = A.get('lods') or [tri_count(game)]
base_tris = tri_count(game)
for i, target in enumerate(lods):
    if i == 0:
        o = game
    else:
        o = game.copy(); o.data = game.data.copy(); bpy.context.collection.objects.link(o)
        o.name = f'GAME_LOD{i}'
        d = o.modifiers.new('lod', 'DECIMATE'); d.decimate_type = 'COLLAPSE'; d.ratio = min(1, target / base_tris); d.use_collapse_triangulate = True
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        # the decimate must run before the armature modifier
        bpy.ops.object.modifier_move_to_index(modifier='lod', index=0)
        bpy.ops.object.modifier_apply(modifier='lod')
    path = os.path.join(A['out_dir'], f'rigged_lod{i}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for x in bpy.data.objects:
        x.hide_set(x.type == 'MESH' and x is not o)
    export_glb(path, [o], with_armature=arm)
    outs.append({'lod': i, 'file': path, 'triangles': tri_count(o)})
    log(f'LOD{i}: {tri_count(o)} tris → {os.path.basename(path)}')
for x in bpy.data.objects:
    x.hide_set(False)
save_blend(os.path.join(A['out_dir'], 'rigged.blend'))
report['lods'] = outs
write_json(A['report'], report)
