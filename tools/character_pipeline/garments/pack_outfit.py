"""
Pack built garments (build_garment.py → <dir>/<garment>.npz) into the game's outfit files:

  python pack_outfit.py <rig.json.gz> <garments dir> --rig-id ac-001 [--art <dir>] [--out lib/mocap/mhr-rigs]

writes
  <out>/<rig>-outfits/<id>.json.gz   the garment: mesh, skin, cloth graph, hidden body faces, material
  <out>/<rig>-outfits/index.json     what the court's outfit picker lists
  <out>/<rig>-tex/outfit-<id>-*.webp its textures (served at /chars/<rig>/…)

A garment's colours are chosen in the game (a tint for the fabric, an accent for its prints), so the
textures carry no colour of their own: `detail` is a grey fabric texture multiplied by the tint, and
`print` holds the prints and stripes as grey (white = accent, black = outline) with coverage in alpha.
Prints are placed in 3-D (a front / back projection onto the garment), then baked through its UVs.
"""
import argparse, base64, gzip, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage
import scipy.sparse as sp
from scipy.sparse.csgraph import dijkstra, connected_components

ap = argparse.ArgumentParser()
ap.add_argument('rig')
ap.add_argument('dir')
ap.add_argument('--rig-id', required=True)
ap.add_argument('--art', default=None)
ap.add_argument('--out', default='lib/mocap/mhr-rigs')
ap.add_argument('--garments', default='tee,shorts')
a = ap.parse_args()
ART = a.art or os.path.join(a.dir, 'art')

# what each garment is in the game: name, slot, fabric, the palette offered, and its prints
DEF = {
    'tee': dict(name='Baggy tee', slot='top', roughness=0.92, sheen=0.0, tex=2048,
                palette=[('White', '#eeeeea', '#b8232a'), ('Black', '#1c1c20', '#f2f2f2'), ('Heather', '#8d9097', '#1c1c20'), ('Red', '#a3222a', '#f4f1e8'), ('Royal', '#23449b', '#f4f1e8')],
                prints=[dict(img='front_print.png', firstBlock=True, side='front', center=('chest', 0.0, 0.055), width=0.30),
                        dict(img='back_print.png', side='back', center=('chest', 0.0, 0.0), width=0.30)]),
    'shorts': dict(name='Mesh shorts', slot='bottom', roughness=0.62, sheen=0.35, tex=1024,
                   palette=[('Black', '#18181c', '#f2f2f2'), ('Red', '#a3222a', '#f4f1e8'), ('White', '#ecece8', '#18181c'), ('Navy', '#1b2440', '#f4f1e8'), ('Grey', '#6e7179', '#f4f1e8')],
                   prints=[dict(img='shorts_logo.png', side='front', center=('hem', 0.13, 0.1), width=0.1, x_sign=1)],
                   stripe=dict(width=0.035)),
    'jersey': dict(name='Tank jersey', slot='top', roughness=0.55, sheen=0.3, tex=2048, detail='mesh_fabric.png', detailRepeat=7.0,
                   palette=[('Red', '#a3222a', '#f4f1e8'), ('White', '#ecece8', '#a3222a'), ('Black', '#18181c', '#f2f2f2'), ('Royal', '#23449b', '#f4f1e8')],
                   prints=[dict(img='front_print.png', side='front', center=('chest', 0.0, -0.085), width=0.27),
                           dict(img='back_print.png', side='back', center=('chest', 0.0, -0.03), width=0.28)]),
}


def enc(x):
    return base64.b64encode(np.ascontiguousarray(x).tobytes()).decode()


def raster(UV, F, attrs, size):
    """Per-texel interpolation of per-vertex attributes over the UV triangles (image rows: v down).
    Returns (values (size, size, k), covered mask)."""
    k = attrs.shape[1]
    out = np.zeros((size, size, k), np.float32)
    cov = np.zeros((size, size), bool)
    P = UV * size - 0.5
    for tri in F:
        p = P[tri]
        x0, y0 = np.floor(p.min(0)).astype(int); x1, y1 = np.ceil(p.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0: continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        v0, v1 = p[1] - p[0], p[2] - p[0]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12: continue
        wx, wy = xs - p[0, 0], ys - p[0, 1]
        b1 = (wx * v1[1] - v1[0] * wy) / den
        b2 = (v0[0] * wy - wx * v0[1]) / den
        b0 = 1 - b1 - b2
        m = (b0 >= -0.02) & (b1 >= -0.02) & (b2 >= -0.02)
        if not m.any(): continue
        val = b0[m, None] * attrs[tri[0]] + b1[m, None] * attrs[tri[1]] + b2[m, None] * attrs[tri[2]]
        out[ys[m], xs[m]] = val
        cov[ys[m], xs[m]] = True
    return out, cov


def boundary_info(TV, TF):
    """Each welded vertex: graph distance to the nearest opening and which opening it is."""
    E = np.concatenate([TF[:, [0, 1]], TF[:, [1, 2]], TF[:, [2, 0]]])
    Es = np.sort(E, 1)
    ue, cnt = np.unique(Es, axis=0, return_counts=True)
    bnd = ue[cnt == 1]
    n = len(TV)
    Ab = sp.coo_matrix((np.ones(len(bnd)), (bnd[:, 0], bnd[:, 1])), shape=(n, n))
    _, lab = connected_components(Ab, directed=False)
    bv = np.unique(bnd)
    L = np.linalg.norm(TV[ue[:, 0]] - TV[ue[:, 1]], axis=1)
    G = sp.coo_matrix((np.concatenate([L, L]), (np.concatenate([ue[:, 0], ue[:, 1]]), np.concatenate([ue[:, 1], ue[:, 0]]))), shape=(n, n)).tocsr()
    d, _, src = dijkstra(G, directed=False, indices=bv, min_only=True, return_predecessors=True)
    loops = {}
    for l in np.unique(lab[bv]):
        vs = bv[lab[bv] == l]
        loops[int(l)] = dict(centroid=TV[vs].mean(0), ymax=float(TV[vs, 1].max()), n=len(vs))
    return d, lab[src], loops


R = json.loads(gzip.open(a.rig).read())
names = R['mhr']['names']
J = {nm: np.array(p) for nm, p in zip(names, R['mhr']['bindPos'])}
out_dir = os.path.join(a.out, f'{a.rig_id}-outfits'); os.makedirs(out_dir, exist_ok=True)
tex_dir = os.path.join(a.out, f'{a.rig_id}-tex'); os.makedirs(tex_dir, exist_ok=True)
index = []
for gid in a.garments.split(','):
    D = DEF[gid]
    npz = os.path.join(a.dir, f'{gid}.npz')
    if not os.path.exists(npz):
        print(f'skip {gid}: no {npz}', file=sys.stderr); continue
    g = np.load(npz)
    rep = json.load(open(os.path.join(a.dir, f'{gid}.json')))
    V, UV, F, topo = g['V'], g['UV'], g['F'], g['topo']
    TV, TN = g['TV'].astype(np.float64), g['TN']
    nT = len(TV)
    # welded faces (normals are computed on the welded surface in the game: no seams in the light)
    TF = topo[F]
    first = np.full(nT, -1); first[topo[::-1]] = np.arange(len(topo))[::-1]
    skinIdx, skinW = g['skinIdx'][first], g['skinW'][first]
    clothIdx, clothW = g['clothIdx'][first], g['clothW'][first]
    # trims: distance to the nearest opening; the top opening (neckline / waistband) is ribbed
    dist, which, loops = boundary_info(TV, TF)
    top = max(loops, key=lambda l: loops[l]['ymax'])
    kind = (which == top).astype(np.float32)
    trim = np.stack([dist.astype(np.float32), kind], 1)[topo]
    # ── textures: per-texel position + normal through the UVs, then prints placed in 3-D
    S = D['tex']
    attrs = np.concatenate([V, TN[topo]], 1)
    TX, cov = raster(UV, F, attrs, S)
    pos, nrm = TX[..., :3], TX[..., 3:6]
    lum = np.zeros((S, S), np.float32); alpha = np.zeros((S, S), np.float32)
    y_chest = (J['c_spine2'][1] + J['c_spine3'][1]) / 2 + 0.06
    anchors = {'chest': y_chest, 'hem': rep.get('y_hem', 0.6)}
    for pr in D.get('prints', []):
        img = Image.open(os.path.join(ART, pr['img'])).convert('RGBA')
        if pr.get('firstBlock'):
            # the artwork's first block of lettering only (e.g. the "SOUL JAM" arch above the number):
            # cut at the first fully transparent band below it
            # (by shape: the arch's end letters reach below the top of the number, so no row separates
            # them — keep the letters whose centre is in the upper half of the artwork)
            arr = np.asarray(img).copy()
            al = arr[..., 3] > 8
            lab, nl = ndimage.label(al)
            ys = np.where(al.any(1))[0]; mid = (ys.min() + ys.max()) / 2
            cy = ndimage.center_of_mass(al, lab, range(1, nl + 1))
            keep = [i + 1 for i, c in enumerate(cy) if c[0] < mid]
            arr[..., 3] = np.where(np.isin(lab, keep), arr[..., 3], 0)
            img = Image.fromarray(arr, 'RGBA')
            img = img.crop(img.getbbox())
        elif 'crop' in pr:
            c = pr['crop']; W0, H0 = img.size
            img = img.crop((int(c[0] * W0), int(c[1] * H0), int(c[2] * W0), int(c[3] * H0)))
            img = img.crop(img.getbbox())
        else:
            img = img.crop(img.getbbox())
        im = np.asarray(img).astype(np.float32) / 255
        ih, iw = im.shape[:2]
        wdt = pr['width']; hgt = wdt * ih / iw
        anc, dx, dy = pr['center']
        cx, cy = dx, anchors[anc] + dy
        front = pr['side'] == 'front'
        facing = (nrm[..., 2] > 0.25) if front else (nrm[..., 2] < -0.25)
        if pr.get('x_sign'): facing &= pos[..., 0] * pr['x_sign'] > 0
        u = ((pos[..., 0] - cx) / wdt + 0.5) if front else ((cx - pos[..., 0]) / wdt + 0.5)
        v = (cy + hgt / 2 - pos[..., 1]) / hgt
        m = cov & facing & (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
        px = np.clip((u[m] * iw).astype(int), 0, iw - 1); py = np.clip((v[m] * ih).astype(int), 0, ih - 1)
        sa = im[py, px, 3]
        l_ = im[py, px, :3].mean(1)
        lum[m] = lum[m] * (1 - sa) + l_ * sa
        alpha[m] = np.maximum(alpha[m], sa)
    if D.get('stripe'):
        # a side stripe down each leg: where the fabric faces straight out to the side
        # (per texture row = per height: the rows of the shorts' UVs are levels): centred on the
        # leg's outermost line, a fixed width across the surface
        band = np.zeros((S, S), bool)
        half = D['stripe']['width'] / 2
        for sd in (1, -1):
            outer = cov & (nrm[..., 0] * sd > 0.5) & (pos[..., 0] * sd > 0) & (pos[..., 1] < rep['y_waist'] - 0.04)
            rows = np.where(outer.any(1))[0]
            zc = np.array([pos[r, np.where(outer[r])[0][np.argmax(pos[r, np.where(outer[r])[0], 0] * sd)], 2] for r in rows])
            zc = ndimage.uniform_filter1d(ndimage.median_filter(zc, 31, mode='nearest'), 25, mode='nearest')   # a straight seam line
            for r, z in zip(rows, zc):
                c = np.where(outer[r])[0]
                band[r, c[np.abs(pos[r, c, 2] - z) < half]] = True
        lum[band] = 1.0; alpha[band] = 1.0
    # pad the islands (no dark fringes where texture filtering reaches past a UV edge)
    grow = ndimage.binary_dilation(cov, iterations=4) & ~cov
    if grow.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~cov, return_indices=True)
        lum[grow] = lum[iy[grow], ix[grow]]; alpha[grow] = alpha[iy[grow], ix[grow]]
    rgba = np.dstack([lum, lum, lum, alpha])
    ptex = f'outfit-{a.rig_id}-{gid}-print.webp'
    Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), 'RGBA').save(os.path.join(tex_dir, ptex), 'WEBP', quality=88, method=6)
    mat = dict(roughness=D['roughness'], sheen=D.get('sheen', 0), print=f'/chars/{a.rig_id}/{ptex}',
               palette=[dict(name=n, base=b, accent=ac) for n, b, ac in D['palette']])
    if D.get('detail'):
        dimg = Image.open(os.path.join(ART, D['detail'])).convert('L').resize((512, 512), Image.LANCZOS)
        dtex = f'outfit-{a.rig_id}-{gid}-detail.webp'
        dimg.save(os.path.join(tex_dir, dtex), 'WEBP', quality=85)
        mat.update(detail=f'/chars/{a.rig_id}/{dtex}', detailRepeat=D.get('detailRepeat', 6.0))
    # ── the game file
    Pn = g['proxyPos']
    hide = {k[4:]: enc(g[k].astype(np.uint32)) for k in g.files if k.startswith('hide')}
    garment = dict(
        version=1, id=gid, rig=a.rig_id, name=D['name'], slot=D['slot'], material=mat,
        renderCount=int(len(V)), topoCount=int(nT), faces32=bool(len(V) > 65535),
        verts=enc(V.astype(np.float32)), uv=enc(UV.astype(np.float32)), trim=enc(trim.astype(np.float32)),
        faces=enc(F.astype(np.uint32 if len(V) > 65535 else np.uint16)), topo=enc(topo.astype(np.uint16)),
        topoFaces=enc(TF.astype(np.uint16)), rest=enc(TV.astype(np.float32)),
        skinIdx=enc(skinIdx.astype(np.uint8)), skinW=enc(skinW.astype(np.float32)),
        clothIdx=enc(clothIdx.astype(np.uint16)), clothW=enc(clothW.astype(np.float32)),
        cloth=dict(n=int(len(Pn)), pos=enc(Pn.astype(np.float32)), normal=enc(g['proxyNormal'].astype(np.float32)),
                   skinIdx=enc(g['proxySkinIdx'].astype(np.uint8)), skinW=enc(g['proxySkinW'].astype(np.float32)),
                   edges=enc(g['proxyEdges'].astype(np.uint16)), pin=enc(g['proxyPin'].astype(np.float32)), gap=enc(g['proxyGap'].astype(np.float32)),
                   **({'tether': enc(g['proxyTether'].astype(np.uint16)), 'tetherLen': enc(g['proxyTetherLen'].astype(np.float32))} if 'proxyTether' in g.files else {})),
        limp=bool(rep.get('drape')),
        hide=hide,
        source=dict(builder='tools/character_pipeline/garments/build_garment.py', report={k: rep[k] for k in ('triangles', 'proxyNodes', 'hiddenBodyFaces', 'normalsOutward') if k in rep}),
    )
    raw = json.dumps(garment, separators=(',', ':')).encode()
    with gzip.open(os.path.join(out_dir, f'{gid}.json.gz'), 'wb', compresslevel=9) as f: f.write(raw)
    index.append(dict(id=gid, name=D['name'], slot=D['slot'], palette=mat['palette'], bytes=os.path.getsize(os.path.join(out_dir, f'{gid}.json.gz'))))
    print(json.dumps({'garment': gid, 'render': len(V), 'topo': nT, 'tris': len(F), 'proxy': len(Pn), 'gz': index[-1]['bytes'], 'print': ptex}))
# the body the fabric rests on (build_colliders.py): spheres riding the skeleton
body = None
cp = os.path.join(a.dir, 'colliders.npz')
if os.path.exists(cp):
    c = np.load(cp)
    bj = dict(version=1, rig=a.rig_id, n=int(len(c['R'])), centers=enc(c['C'].astype(np.float32)), radii=enc(c['R'].astype(np.float32)),
              skinIdx=enc(c['skinIdx'].astype(np.uint8)), skinW=enc(c['skinW'].astype(np.float32)))
    with gzip.open(os.path.join(out_dir, 'body.json.gz'), 'wb', compresslevel=9) as f: f.write(json.dumps(bj, separators=(',', ':')).encode())
    body = {'spheres': int(len(c['R']))}
    print(json.dumps({'body colliders': body}))
# merge with what was packed before (packing one garment keeps the others listed)
ip = os.path.join(out_dir, 'index.json')
prev = json.load(open(ip))['garments'] if os.path.exists(ip) else []
done = {g['id'] for g in index}
order = [g for g in DEF if g in done or any(p['id'] == g for p in prev)]
merged = {**{p['id']: p for p in prev if os.path.exists(os.path.join(out_dir, p['id'] + '.json.gz'))}, **{g['id']: g for g in index}}
json.dump({'rig': a.rig_id, 'body': body or (json.load(open(ip)).get('body') if os.path.exists(ip) else None), 'garments': [merged[g] for g in order if g in merged]}, open(ip, 'w'), indent=1)
