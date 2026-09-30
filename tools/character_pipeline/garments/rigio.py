"""Read / write the game's MHR rig JSON (lib/mocap/mhr-rigs/<id>.json.gz) as numpy arrays."""
import base64, gzip, json
import numpy as np


def b64(s, dt):
    return np.frombuffer(base64.b64decode(s), dt).copy()


def enc(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def load_rig(path):
    r = json.loads(gzip.open(path).read())
    return r


def part_arrays(p):
    V = b64(p['verts'], np.float32).reshape(-1, 3)
    F = b64(p['faces'], np.uint32 if p.get('faces32') else np.uint16).reshape(-1, 3).astype(np.int64)
    UV = b64(p['uv'], np.float32).reshape(-1, 2) if p.get('uv') else None
    SI = b64(p['skinIdx'], np.uint8).reshape(-1, 4).astype(np.int64)
    SW = b64(p['skinW'], np.float32).reshape(-1, 4)
    N = b64(p['normals'], np.float32).reshape(-1, 3) if p.get('normals') else None
    return dict(V=V, F=F, UV=UV, SI=SI, SW=SW, N=N)


def joints(r):
    m = r['mhr']
    names = m['names']
    P = np.array(m['bindPos'], np.float64)
    return names, {n: P[i] for i, n in enumerate(names)}, np.array(m['parents'])
