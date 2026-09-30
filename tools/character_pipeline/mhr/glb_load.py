"""
Minimal GLB reader (numpy only, no Blender): one or more mesh primitives → arrays.

  python glb_load.py <model.glb> <out_dir>

Writes <out_dir>/mesh.npz with
  pos  (N,3) float32  glTF axes (y up, +z forward, metres), node transforms applied
  nrm  (N,3) float32  vertex normals (if present)
  uv   (N,2) float32  UV with v UP (Blender / rig convention: v = 1 - v_gltf)
  tri  (T,3) int32
and <out_dir>/tex/{baseColor,normal,metallicRoughness,occlusion}.<ext> + mesh.json.
"""
import json, os, struct, sys
import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'glTF'
    off = 12
    J = BIN = None
    while off < len(b):
        ln, typ = struct.unpack_from('<II', b, off)
        chunk = b[off + 8: off + 8 + ln]
        if typ == 0x4E4F534A:
            J = json.loads(chunk)
        elif typ == 0x004E4942:
            BIN = chunk
        off += 8 + ln
    return J, BIN


def accessor(J, BIN, i):
    a = J['accessors'][i]
    bv = J['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']])
    n = NC[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0)
    if stride and stride != dt.itemsize * n:
        rows = [np.frombuffer(BIN, dt, n, start + r * stride) for r in range(a['count'])]
        arr = np.stack(rows)
    else:
        arr = np.frombuffer(BIN, dt, a['count'] * n, start).reshape(a['count'], n)
    if a.get('normalized'):
        arr = arr.astype(np.float32) / np.iinfo(dt).max
    return arr.copy()


def node_mats(J):
    """World matrix per node (TRS or matrix)."""
    def local(nd):
        if 'matrix' in nd:
            return np.array(nd['matrix'], np.float64).reshape(4, 4).T
        t = np.array(nd.get('translation', [0, 0, 0]), np.float64)
        x, y, z, w = nd.get('rotation', [0, 0, 0, 1])
        s = np.array(nd.get('scale', [1, 1, 1]), np.float64)
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t
        return M
    W = {}
    def walk(i, P):
        W[i] = P @ local(J['nodes'][i])
        for c in J['nodes'][i].get('children', []):
            walk(c, W[i])
    for sc in J.get('scenes', [{'nodes': list(range(len(J['nodes'])))}]):
        for r in sc['nodes']:
            walk(r, np.eye(4))
    return W


def load(path):
    J, BIN = read_glb(path)
    W = node_mats(J)
    pos, nrm, uv, tri, mats = [], [], [], [], []
    base = 0
    for ni, nd in enumerate(J['nodes']):
        if 'mesh' not in nd or ni not in W:
            continue
        M = W[ni]
        for pr in J['meshes'][nd['mesh']]['primitives']:
            at = pr['attributes']
            P = accessor(J, BIN, at['POSITION']).astype(np.float64)
            P = P @ M[:3, :3].T + M[:3, 3]
            pos.append(P)
            if 'NORMAL' in at:
                Nn = accessor(J, BIN, at['NORMAL']).astype(np.float64) @ np.linalg.inv(M[:3, :3])
                nrm.append(Nn / np.maximum(1e-12, np.linalg.norm(Nn, axis=1, keepdims=True)))
            else:
                nrm.append(np.zeros_like(P))
            if 'TEXCOORD_0' in at:
                U = accessor(J, BIN, at['TEXCOORD_0']).astype(np.float64)
                U[:, 1] = 1 - U[:, 1]          # glTF v runs down the image; rigs store v up
            else:
                U = np.zeros((len(P), 2))
            uv.append(U)
            I = accessor(J, BIN, pr['indices']).reshape(-1, 3).astype(np.int64) if 'indices' in pr else np.arange(len(P)).reshape(-1, 3)
            tri.append(I + base)
            mats.append(pr.get('material'))
            base += len(P)
    return J, BIN, np.concatenate(pos), np.concatenate(nrm), np.concatenate(uv), np.concatenate(tri), mats


def save_textures(J, BIN, mat_index, out):
    os.makedirs(out, exist_ok=True)
    m = J['materials'][mat_index] if mat_index is not None else {}
    slots = {'baseColor': m.get('pbrMetallicRoughness', {}).get('baseColorTexture'),
             'metallicRoughness': m.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture'),
             'normal': m.get('normalTexture'), 'occlusion': m.get('occlusionTexture')}
    got = {}
    for k, t in slots.items():
        if not t:
            continue
        img = J['images'][J['textures'][t['index']]['source']]
        bv = J['bufferViews'][img['bufferView']]
        data = BIN[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
        ext = 'png' if img.get('mimeType', 'image/png') == 'image/png' else 'jpg'
        fn = f'{k}.{ext}'
        open(os.path.join(out, fn), 'wb').write(data)
        got[k] = fn
    return got


if __name__ == '__main__':
    # python glb_load.py <model.glb> <out_dir> [--height H | --scale S]
    #   --height: uniform scale so the model is H metres tall (a Tripo export is ~1 unit tall);
    #   --scale: an explicit factor (LODs reuse LOD 0's factor so every LOD lines up)
    #   --align <LOD 0's mesh.json>: translate so the bounding box centre matches LOD 0's (a
    #     decimated copy exported by Blender can come back shifted: a skinned GLB's mesh-node offset
    #     is applied differently by Blender's importer than by this loader)
    src, out = sys.argv[1], sys.argv[2]
    rest = sys.argv[3:]
    opt = {rest[i]: rest[i + 1] for i in range(0, len(rest) - 1, 2)}
    os.makedirs(out, exist_ok=True)
    J, BIN, P, N, U, T, mats = load(src)
    src_h = float(P[:, 1].max() - P[:, 1].min())
    s = float(opt['--scale']) if '--scale' in opt else (float(opt['--height']) / src_h if '--height' in opt else 1.0)
    P = P * s
    shift = [0.0, 0.0, 0.0]
    if '--align' in opt:
        b0 = np.array(json.load(open(opt['--align']))['bbox'], np.float64)
        d = (b0[0] + b0[1]) / 2 - (P.min(0) + P.max(0)) / 2
        P = P + d
        shift = d.round(5).tolist()
    tex = save_textures(J, BIN, mats[0], os.path.join(out, 'tex'))
    np.savez(os.path.join(out, 'mesh.npz'), pos=P.astype(np.float32), nrm=N.astype(np.float32), uv=U.astype(np.float32), tri=T.astype(np.int32))
    info = {'source': src, 'vertices': int(len(P)), 'triangles': int(len(T)), 'textures': tex, 'scale': s, 'sourceHeight': round(src_h, 4), 'alignShift': shift,
            'bbox': [P.min(0).round(4).tolist(), P.max(0).round(4).tolist()], 'materials': mats}
    json.dump(info, open(os.path.join(out, 'mesh.json'), 'w'), indent=1)
    print(json.dumps(info))
