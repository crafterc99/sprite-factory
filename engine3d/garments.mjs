/**
 * Garments on a court character: loose clothes (a baggy tee, mesh shorts, a tank jersey) that ride
 * the character's skeleton and move like fabric.
 *
 * A garment (tools/character_pipeline/garments → lib/mocap/mhr-rigs/<char>-outfits/<id>.json.gz) is
 * built for one rig: its mesh in the rig's bind pose, skin weights on the rig's bones, a coarse
 * cloth graph (~450 nodes) and the body faces it covers.
 *
 * Every frame (after the pose, IK and finger contact are final):
 *   1. anchors — each cloth node skinned with the bone matrices: where the garment would be if it
 *      were rigid on the body (plus that node's normal and "up");
 *   2. fabric — the nodes are simulated (Verlet, fixed 1/120 s substeps: the same at 30, 60 or 120
 *      fps) around their anchors: a part of the body's motion is kept as momentum (the cloth lags,
 *      swings and settles), gravity pulls the free parts when the body leans, stretch is limited
 *      along the graph's edges, limbs push the cloth away (capsules), and every node stays within
 *      its own distance of the anchor (a few mm at the shoulders and waistband, ~10 cm at a hem)
 *      and never goes into the body (a backstop along the anchor normal);
 *   3. the mesh — every vertex skinned on the CPU plus the offset of its cloth nodes, normals from
 *      the welded surface (no seams in the light).
 *
 * The cloth only moves relative to the body, so a teleport, a respawn or a very long frame simply
 * resets it; nothing here depends on the frame rate.
 */

export const GARMENT_VERSION = 1;

export const CLOTH_DEFAULTS = {
  substep: 1 / 120,
  maxSubsteps: 6,
  inertia: 0.85,          // share of the body's motion the cloth keeps as its own momentum (1 = world space)
  damping: 1.6,           // 1/s — air drag
  gravity: 9.8,           // m/s² — full gravity: the fabric hangs and rests on the body
  maxDist: [0.004, 0.14], // m it may ever get from its skinned anchor: pin 1 → 4 mm, free → 14 cm
  pull: [1.0, 60],        // 1/s memory of the draped shape: free → faint (a 1 s time constant), pin 1 → elastic waistband
  stretch: 1.0,           // edge stiffness when longer than at rest (fabric barely stretches)
  compress: 0.02,         // … and when shorter: almost none (it buckles into folds)
  tetherSlack: 1.02,      // a node's distance to its held node, along the cloth, may grow by 2 %
  iterations: 6,
  thickness: 0.01,        // m the fabric keeps from the body's spheres (they sit up to ~1 cm inside the skin)
  friction: 0.55,         // 0…1 of the sliding motion removed where it rests on the body
  backstop: 0.004,        // m of the rest gap to the skin the cloth may not use
  teleport: 0.5,          // m an anchor may jump in one frame before the cloth resets
};

// (Math.hypot is several times slower than this in V8's hot loops)
const len3 = (a, b, c) => Math.sqrt(a * a + b * b + c * c);

const b64dec = (s, T) => {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new T(u8.buffer);
};

/** The garment file → typed arrays. */
export function decodeGarment(j, b64 = b64dec) {
  const c = j.cloth;
  const hide = {};
  for (const [lv, s] of Object.entries(j.hide || {})) hide[lv] = b64(s, Uint32Array);
  return {
    id: j.id, name: j.name, slot: j.slot, rig: j.rig, material: j.material || {}, limp: !!j.limp,
    n: j.renderCount, nt: j.topoCount,
    verts: b64(j.verts, Float32Array), uv: b64(j.uv, Float32Array), trim: b64(j.trim, Float32Array),
    faces: b64(j.faces, j.faces32 ? Uint32Array : Uint16Array), topo: b64(j.topo, Uint16Array), topoFaces: b64(j.topoFaces, Uint16Array),
    rest: b64(j.rest, Float32Array), skinIdx: b64(j.skinIdx, Uint8Array), skinW: b64(j.skinW, Float32Array),
    clothIdx: b64(j.clothIdx, Uint16Array), clothW: b64(j.clothW, Float32Array),
    cloth: { n: c.n, pos: b64(c.pos, Float32Array), normal: b64(c.normal, Float32Array), skinIdx: b64(c.skinIdx, Uint8Array), skinW: b64(c.skinW, Float32Array),
      edges: b64(c.edges, Uint16Array), pin: b64(c.pin, Float32Array), gap: b64(c.gap, Float32Array),
      tether: c.tether ? b64(c.tether, Uint16Array) : null, tetherLen: c.tetherLen ? b64(c.tetherLen, Float32Array) : null },
    hide,
  };
}

// the 3×4 blend of up to 4 bone matrices (column-major 4×4 in `mats`), applied to a point / vector
function blend(mats, si, sw, o, M) {
  M.fill(0);
  for (let c = 0; c < 4; c++) {
    const w = sw[o + c]; if (!w) continue;
    const b = si[o + c] * 16;
    for (let k = 0; k < 12; k++) M[k] += w * mats[b + (k < 3 ? k : k < 6 ? k + 1 : k < 9 ? k + 2 : k + 3)];
  }
  // M = [m0 m1 m2 | m4 m5 m6 | m8 m9 m10 | m12 m13 m14] (the rotation-scale columns, then the translation)
}

/**
 * The body the fabric rests on: spheres inscribed in the character's body (build_colliders.py),
 * each skinned like the body, hashed on a grid every frame so a cloth node only tests its
 * neighbourhood. Extra spheres (a garment worn underneath) can be added per frame.
 */
export class BodyColliders {
  constructor(b, b64 = b64dec) {
    this.n = b.n;
    this.c0 = b64(b.centers, Float32Array); this.r = b64(b.radii, Float32Array);
    this.si = b64(b.skinIdx, Uint8Array); this.sw = b64(b.skinW, Float32Array);
    this.c = new Float32Array(this.n * 3); this.cp = new Float32Array(this.n * 3);
    this.M = new Float32Array(12);
    this.cell = 0.08;
    this.grid = new Map();
    this.ready = false;
  }
  /** Skinned centres for this frame (the previous frame's kept for substeps). */
  update(mats) {
    const { n, c0, si, sw, M } = this;
    if (this.ready) this.cp.set(this.c);
    for (let i = 0; i < n; i++) {
      blend(mats, si, sw, i * 4, M);
      const x = c0[i * 3], y = c0[i * 3 + 1], z = c0[i * 3 + 2];
      this.c[i * 3] = M[0] * x + M[3] * y + M[6] * z + M[9];
      this.c[i * 3 + 1] = M[1] * x + M[4] * y + M[7] * z + M[10];
      this.c[i * 3 + 2] = M[2] * x + M[5] * y + M[8] * z + M[11];
    }
    if (!this.ready) { this.cp.set(this.c); this.ready = true; }
  }
  /** The hash of the body spheres for this frame (call after update; extras via addExtra). */
  build(pad = 0.03) {
    const g = this.grid, C = this.cell; g.clear();
    this.pad = pad;
    const add = (this.add = (id, x, y, z, r) => {
      const R = r + pad;
      for (let i = Math.floor((x - R) / C); i <= Math.floor((x + R) / C); i++)
        for (let j = Math.floor((y - R) / C); j <= Math.floor((y + R) / C); j++)
          for (let k = Math.floor((z - R) / C); k <= Math.floor((z + R) / C); k++) {
            const key = ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
            const L = g.get(key); if (L) L.push(id); else g.set(key, [id]);
          }
    });
    const { n, c, r } = this;
    this.cx = c;
    for (let i = 0; i < n; i++) add(i, c[i * 3], c[i * 3 + 1], c[i * 3 + 2], r[i]);
    this.ex = [];
  }
  /** More spheres for the rest of this frame: a garment worn underneath (its current nodes). */
  addExtra(x, count, r) {
    let id = this.n + this.ex.length / 3;
    for (let i = 0; i < count; i++, id++) { this.ex.push(x, i * 3, r); this.add(id, x[i * 3], x[i * 3 + 1], x[i * 3 + 2], r); }
  }
  /** Push a point out of every sphere near it; returns 1 if it touched (normal in out[0..2]). */
  collide(x, o, thick, out) {
    const C = this.cell, key = ((Math.floor(x[o] / C) + 512) * 1024 + (Math.floor(x[o + 1] / C) + 512)) * 1024 + (Math.floor(x[o + 2] / C) + 512);
    const L = this.grid.get(key); if (!L) return 0;
    let hit = 0;
    for (const id of L) {
      let cx, cy, cz, R;
      if (id < this.n) { cx = this.cx[id * 3]; cy = this.cx[id * 3 + 1]; cz = this.cx[id * 3 + 2]; R = this.r[id] + thick; }
      else { const k = (id - this.n) * 3, a = this.ex[k], b = this.ex[k + 1]; cx = a[b]; cy = a[b + 1]; cz = a[b + 2]; R = this.ex[k + 2] + thick; }
      const dx = x[o] - cx, dy = x[o + 1] - cy, dz = x[o + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2) || 1e-6, k = (R - d) / d;
      x[o] += dx * k; x[o + 1] += dy * k; x[o + 2] += dz * k;
      out[0] = dx / d; out[1] = dy / d; out[2] = dz / d; hit = 1;
    }
    return hit;
  }
}

/**
 * The fabric of one garment: its cloth graph as limp cloth. Every node carries world-space momentum
 * (the cloth lags, swings and settles), falls under gravity onto the body (its spheres; friction
 * where it rests), cannot stretch along the graph (edges + tethers to the held nodes) but buckles
 * freely, and remembers its draped shape only faintly. A node's pin (0 = free … 1 = an elastic
 * waistband) sets how firmly it stays put and how far it may ever get from its skinned anchor.
 */
export class GarmentCloth {
  constructor(g, cfg = {}) {
    this.g = g;
    this.cfg = { ...CLOTH_DEFAULTS, ...cfg };
    const n = (this.n = g.cloth.n);
    this.x = new Float32Array(n * 3); this.xp = new Float32Array(n * 3);
    this.A = new Float32Array(n * 3); this.A0 = new Float32Array(n * 3); this.As = new Float32Array(n * 3); this.Ap = new Float32Array(n * 3);
    this.N = new Float32Array(n * 3); this.U = new Float32Array(n * 3);
    this.off = new Float32Array(n * 3);
    this.touch = new Uint8Array(n); this.tn = new Float32Array(n * 3);
    const E = g.cloth.edges, P = g.cloth.pos;
    this.rest = new Float32Array(E.length / 2);
    for (let e = 0; e < E.length / 2; e++) { const i = E[e * 2] * 3, j = E[e * 2 + 1] * 3; this.rest[e] = len3(P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]); }
    this.setPins();
    this.ready = false;
    this.M = new Float32Array(12);
    this.tmp = new Float32Array(3);
    this.stats = { resets: 0, maxOffset: 0, steps: 0, contacts: 0 };
  }
  setPins() {
    const { pin, gap } = this.g.cloth, c = this.cfg, n = this.n;
    this.maxD = new Float32Array(n); this.pullK = new Float32Array(n); this.back = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = Math.min(1, Math.max(0, pin[i]));
      this.maxD[i] = c.maxDist[1] + (c.maxDist[0] - c.maxDist[1]) * Math.pow(p, 0.6);
      this.pullK[i] = c.pull[0] + (c.pull[1] - c.pull[0]) * p * p;
      this.back[i] = Math.max(0, gap[i] - c.backstop);
    }
  }
  /** Anchors (A), normals (N), up vectors (U) from the bone matrices. */
  anchors(mats, A = this.A) {
    const { pos, normal, skinIdx, skinW } = this.g.cloth, M = this.M, N = this.N, U = this.U;
    for (let i = 0; i < this.n; i++) {
      blend(mats, skinIdx, skinW, i * 4, M);
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      A[i * 3] = M[0] * x + M[3] * y + M[6] * z + M[9];
      A[i * 3 + 1] = M[1] * x + M[4] * y + M[7] * z + M[10];
      A[i * 3 + 2] = M[2] * x + M[5] * y + M[8] * z + M[11];
      const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
      let a = M[0] * nx + M[3] * ny + M[6] * nz, b = M[1] * nx + M[4] * ny + M[7] * nz, c = M[2] * nx + M[5] * ny + M[8] * nz;
      let l = len3(a, b, c) || 1; N[i * 3] = a / l; N[i * 3 + 1] = b / l; N[i * 3 + 2] = c / l;
      a = M[3]; b = M[4]; c = M[5]; l = len3(a, b, c) || 1;
      U[i * 3] = a / l; U[i * 3 + 1] = b / l; U[i * 3 + 2] = c / l;
    }
  }
  reset(mats) {
    this.anchors(mats);
    this.x.set(this.A); this.xp.set(this.A); this.A0.set(this.A); this.off.fill(0);
    this.ready = true; this.stats.resets++;
  }
  /**
   * @param dt game seconds since the last step
   * @param mats bone matrices (final: after IK)
   * @param body BodyColliders (updated for this frame) or null
   */
  step(dt, mats, body = null) {
    if (!this.ready || !(dt > 0)) { this.reset(mats); return; }
    const c = this.cfg, n = this.n, A = this.A, A0 = this.A0, As = this.As, Ap = this.Ap, x = this.x, xp = this.xp;
    this.anchors(mats);
    let jump = 0;
    for (let i = 0; i < n * 3; i += 3) jump = Math.max(jump, len3(A[i] - A0[i], A[i + 1] - A0[i + 1], A[i + 2] - A0[i + 2]));
    if (jump > c.teleport || dt > 0.25) { this.reset(mats); return; }
    const sub = Math.min(c.maxSubsteps, Math.max(1, Math.ceil(dt / c.substep - 1e-6))), h = dt / sub;
    const carry = 1 - c.inertia, damp = Math.exp(-c.damping * h), gy = -c.gravity * h * h;
    const E = this.g.cloth.edges, R = this.rest, nE = R.length;
    const T = this.g.cloth.tether, TL = this.g.cloth.tetherLen, slack = c.tetherSlack;
    const touch = this.touch, tn = this.tn, tmp = this.tmp, mu = c.friction;
    Ap.set(A0);
    let contacts = 0;
    for (let s = 1; s <= sub; s++) {
      const f = s / sub;
      for (let k = 0; k < n * 3; k++) As[k] = A0[k] + (A[k] - A0[k]) * f;
      for (let i = 0; i < n; i++) {
        const o = i * 3, kp = 1 - Math.exp(-this.pullK[i] * h);
        for (let d = 0; d < 3; d++) {
          const cv = carry * (As[o + d] - Ap[o + d]);           // the body's motion the cloth is dragged by
          const xi = x[o + d] + cv, pi = xp[o + d] + cv;
          let nx = xi + (xi - pi) * damp + (d === 1 ? gy : 0);   // momentum + gravity
          nx += (As[o + d] - nx) * kp;                            // a faint memory of the draped shape
          xp[o + d] = xi; x[o + d] = nx;
        }
      }
      touch.fill(0);
      for (let it = 0; it < c.iterations; it++) {
        for (let e = 0; e < nE; e++) {
          const i = E[e * 2] * 3, j = E[e * 2 + 1] * 3;
          const dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
          const L = len3(dx, dy, dz); if (L < 1e-9) continue;
          const k = (L > R[e] ? c.stretch : c.compress) * 0.5 * (L - R[e]) / L;
          x[i] += dx * k; x[i + 1] += dy * k; x[i + 2] += dz * k;
          x[j] -= dx * k; x[j + 1] -= dy * k; x[j + 2] -= dz * k;
        }
        if (T) for (let i = 0; i < n; i++) {
          const t = T[i]; if (t === i) continue;
          const o = i * 3, q = t * 3, dx = x[o] - x[q], dy = x[o + 1] - x[q + 1], dz = x[o + 2] - x[q + 2], L = len3(dx, dy, dz), lim = TL[i] * slack;
          if (L > lim) { const k = lim / L; x[o] = x[q] + dx * k; x[o + 1] = x[q + 1] + dy * k; x[o + 2] = x[q + 2] + dz * k; }
        }
        if (body && (it & 1 || it === c.iterations - 1)) for (let i = 0; i < n; i++) if (body.collide(x, i * 3, c.thickness, tmp)) { touch[i] = 1; tn[i * 3] = tmp[0]; tn[i * 3 + 1] = tmp[1]; tn[i * 3 + 2] = tmp[2]; }
        this.limit(As);
      }
      // friction where the fabric rests on the body: it sticks instead of sliding off
      for (let i = 0; i < n; i++) {
        if (!touch[i]) continue;
        contacts++;
        const o = i * 3, vx = x[o] - xp[o], vy = x[o + 1] - xp[o + 1], vz = x[o + 2] - xp[o + 2];
        const vn = vx * tn[o] + vy * tn[o + 1] + vz * tn[o + 2];
        const tx = vx - vn * tn[o], ty = vy - vn * tn[o + 1], tz = vz - vn * tn[o + 2];
        xp[o] = x[o] - tx * (1 - mu) - Math.max(0, vn) * tn[o]; xp[o + 1] = x[o + 1] - ty * (1 - mu) - Math.max(0, vn) * tn[o + 1]; xp[o + 2] = x[o + 2] - tz * (1 - mu) - Math.max(0, vn) * tn[o + 2];
      }
      Ap.set(As);
    }
    A0.set(A);
    let mo = 0;
    for (let k = 0; k < n * 3; k += 3) {
      this.off[k] = x[k] - A[k]; this.off[k + 1] = x[k + 1] - A[k + 1]; this.off[k + 2] = x[k + 2] - A[k + 2];
      mo = Math.max(mo, len3(this.off[k], this.off[k + 1], this.off[k + 2]));
    }
    this.stats.maxOffset = mo; this.stats.steps++; this.stats.contacts = contacts / sub;
  }
  /** Hard limits last: never into the body (backstop), never further than the node's distance. */
  limit(As) {
    const x = this.x, N = this.N, n = this.n;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let ox = x[o] - As[o], oy = x[o + 1] - As[o + 1], oz = x[o + 2] - As[o + 2];
      const dn = ox * N[o] + oy * N[o + 1] + oz * N[o + 2], lim = -this.back[i];
      if (dn < lim) { const k = lim - dn; ox += k * N[o]; oy += k * N[o + 1]; oz += k * N[o + 2]; }
      const L = len3(ox, oy, oz), m = this.maxD[i];
      if (L > m) { const k = m / L; ox *= k; oy *= k; oz *= k; }
      x[o] = As[o] + ox; x[o + 1] = As[o + 1] + oy; x[o + 2] = As[o + 2] + oz;
    }
  }
}

/** CPU skinning of a garment's mesh + its cloth offsets → positions and normals of the render mesh. */
export class GarmentSkin {
  constructor(g) {
    this.g = g;
    this.tp = new Float32Array(g.nt * 3); this.tn = new Float32Array(g.nt * 3);
    this.pos = new Float32Array(g.n * 3); this.nrm = new Float32Array(g.n * 3);
    this.M = new Float32Array(12);
  }
  update(mats, off) {
    const g = this.g, tp = this.tp, tn = this.tn, M = this.M, R = g.rest, ci = g.clothIdx, cw = g.clothW;
    const SI = g.skinIdx, SW = g.skinW;
    for (let i = 0; i < g.nt; i++) {
      const x = R[i * 3], y = R[i * 3 + 1], z = R[i * 3 + 2];
      let px = 0, py = 0, pz = 0;
      for (let c = 0; c < 4; c++) {
        const w = SW[i * 4 + c]; if (!w) continue;
        const b = SI[i * 4 + c] * 16;
        px += w * (mats[b] * x + mats[b + 4] * y + mats[b + 8] * z + mats[b + 12]);
        py += w * (mats[b + 1] * x + mats[b + 5] * y + mats[b + 9] * z + mats[b + 13]);
        pz += w * (mats[b + 2] * x + mats[b + 6] * y + mats[b + 10] * z + mats[b + 14]);
      }
      if (off) for (let c = 0; c < 4; c++) { const w = cw[i * 4 + c]; if (!w) continue; const k = ci[i * 4 + c] * 3; px += w * off[k]; py += w * off[k + 1]; pz += w * off[k + 2]; }
      tp[i * 3] = px; tp[i * 3 + 1] = py; tp[i * 3 + 2] = pz;
    }
    // area-weighted normals on the welded surface
    tn.fill(0);
    const F = g.topoFaces;
    for (let f = 0; f < F.length; f += 3) {
      const a = F[f] * 3, b = F[f + 1] * 3, c = F[f + 2] * 3;
      const e1x = tp[b] - tp[a], e1y = tp[b + 1] - tp[a + 1], e1z = tp[b + 2] - tp[a + 2];
      const e2x = tp[c] - tp[a], e2y = tp[c + 1] - tp[a + 1], e2z = tp[c + 2] - tp[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      tn[a] += nx; tn[a + 1] += ny; tn[a + 2] += nz; tn[b] += nx; tn[b + 1] += ny; tn[b + 2] += nz; tn[c] += nx; tn[c + 1] += ny; tn[c + 2] += nz;
    }
    const T = g.topo, pos = this.pos, nrm = this.nrm;
    for (let i = 0; i < g.n; i++) {
      const k = T[i] * 3, l = len3(tn[k], tn[k + 1], tn[k + 2]) || 1;
      pos[i * 3] = tp[k]; pos[i * 3 + 1] = tp[k + 1]; pos[i * 3 + 2] = tp[k + 2];
      nrm[i * 3] = tn[k] / l; nrm[i * 3 + 1] = tn[k + 1] / l; nrm[i * 3 + 2] = tn[k + 2] / l;
    }
  }
}

/**
 * The garment material: the fabric (tint × optional detail texture), a ribbed band at the
 * neckline / waistband, a stitch line along the hems, and the prints (accent fill, dark outline).
 */
export function garmentMaterial(THREE, g, { print, detail, base = '#eeeeee', accent = '#b8232a' } = {}) {
  const m = g.material || {};
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(base), roughness: m.roughness ?? 0.85, metalness: 0, side: THREE.DoubleSide });
  const U = {
    uPrint: { value: print || null }, uHasPrint: { value: print ? 1 : 0 },
    uDetail: { value: detail || null }, uHasDetail: { value: detail ? 1 : 0 }, uDetailRepeat: { value: m.detailRepeat || 6 },
    uAccent: { value: new THREE.Color(accent) }, uOutline: { value: new THREE.Color('#141417') },
    uRibW: { value: g.slot === 'bottom' ? 0.035 : 0.018 },
  };
  mat.userData.garment = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'attribute vec2 trim;\nvarying vec2 vTrim;\nvarying vec2 vGUv;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTrim = trim; vGUv = uv;');
    sh.fragmentShader = 'uniform sampler2D uPrint, uDetail; uniform float uHasPrint, uHasDetail, uDetailRepeat, uRibW; uniform vec3 uAccent, uOutline;\nvarying vec2 vTrim;\nvarying vec2 vGUv;\n'
      + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          float fab = 1.0;
          if ( uHasDetail > 0.5 ) fab = mix( 1.0, texture2D( uDetail, vGUv * uDetailRepeat ).r * 1.18, 0.75 );
          float d = vTrim.x;
          float rib = vTrim.y > 0.5 ? 1.0 - smoothstep( uRibW - 0.002, uRibW, d ) : 0.0;
          float ribLines = rib * ( 0.5 + 0.5 * sin( vGUv.x * 2600.0 ) );
          float stitch = vTrim.y > 0.5 ? ( 1.0 - smoothstep( 0.0, 0.0015, abs( d - uRibW - 0.004 ) ) ) : ( 1.0 - smoothstep( 0.0, 0.0012, abs( d - 0.02 ) ) ) + ( 1.0 - smoothstep( 0.0, 0.0012, abs( d - 0.026 ) ) );
          vec3 base = diffuseColor.rgb * fab * ( 1.0 - 0.07 * rib - 0.05 * ribLines ) * ( 1.0 - 0.28 * clamp( stitch, 0.0, 1.0 ) );
          if ( uHasPrint > 0.5 ) { vec4 pr = texture2D( uPrint, vGUv ); base = mix( base, mix( uOutline, uAccent, pr.r ), pr.a ); }
          diffuseColor.rgb = base;
        }`);
  };
  mat.customProgramCacheKey = () => 'souljam-garment';
  return mat;
}

/** Limb capsules (world) from the bone matrices: thighs, shins, upper arms, forearms. */
export function limbCapsules(mats, mrig, radii) {
  if (!radii) return [];
  const J = (nm) => { const j = mrig.JI[nm], p = mrig.b[j], b = j * 16; return [mats[b] * p[0] + mats[b + 4] * p[1] + mats[b + 8] * p[2] + mats[b + 12], mats[b + 1] * p[0] + mats[b + 5] * p[1] + mats[b + 9] * p[2] + mats[b + 13], mats[b + 2] * p[0] + mats[b + 6] * p[1] + mats[b + 10] * p[2] + mats[b + 14]]; };
  const out = [];
  const segs = [['thigh', 'upleg', 'lowleg'], ['shin', 'lowleg', 'foot'], ['upperArm', 'uparm', 'lowarm'], ['forearm', 'lowarm', 'wrist']];
  for (const s of ['l', 'r']) for (const [k, a, b] of segs) if (radii[k] && mrig.JI[`${s}_${a}`] != null && mrig.JI[`${s}_${b}`] != null) out.push({ a: J(`${s}_${a}`), b: J(`${s}_${b}`), r: radii[k], kind: k });
  return out;
}

/**
 * The outfit a character wears: garments by slot (one top, one bottom), their meshes in the scene,
 * their fabric, and the body faces they cover (hidden per LOD via `onHide`).
 */
export class Outfit {
  constructor({ THREE, scene, mrig, radii, loadTexture, onHide, cfg }) {
    Object.assign(this, { THREE, scene, mrig, radii, loadTexture, onHide, cfg });
    this.worn = new Map();       // slot → { g, cloth, skin, mesh, color }
    this.sim = true;
    this.dirty = false;
  }
  wear(g, colorIndex = 0) {
    this.remove(g.slot);
    const THREE = this.THREE, m = g.material || {};
    const pal = (m.palette || [])[colorIndex] || (m.palette || [])[0] || { base: '#eeeeee', accent: '#b8232a' };
    const geo = new THREE.BufferGeometry();
    const skin = new GarmentSkin(g);
    geo.setAttribute('position', new THREE.BufferAttribute(skin.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(skin.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    geo.setAttribute('trim', new THREE.BufferAttribute(g.trim, 2));
    geo.setIndex(new THREE.BufferAttribute(g.faces, 1));
    const print = m.print ? this.loadTexture(m.print, false) : null;
    const detail = m.detail ? this.loadTexture(m.detail, false, true) : null;
    const mat = garmentMaterial(THREE, g, { print, detail, base: pal.base, accent: pal.accent });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.garment = g.id;
    this.scene.add(mesh);
    const cloth = new GarmentCloth(g, this.cfg);
    this.worn.set(g.slot, { g, cloth, skin, mesh, color: colorIndex, fresh: true });
    this.updateHide();
    return this.worn.get(g.slot);
  }
  setColor(slot, colorIndex) {
    const w = this.worn.get(slot); if (!w) return;
    const pal = (w.g.material.palette || [])[colorIndex]; if (!pal) return;
    w.color = colorIndex;
    w.mesh.material.color.set(pal.base);
    w.mesh.material.userData.garment.uAccent.value.set(pal.accent);
  }
  remove(slot) {
    const w = this.worn.get(slot); if (!w) return;
    this.scene.remove(w.mesh); w.mesh.geometry.dispose(); w.mesh.material.dispose();
    this.worn.delete(slot);
    this.updateHide();
  }
  clear() { for (const s of [...this.worn.keys()]) this.remove(s); }
  updateHide() {
    const by = {};
    for (const { g } of this.worn.values()) for (const [lv, faces] of Object.entries(g.hide)) (by[lv] ||= new Set()) && faces.forEach((f) => by[lv].add(f));
    this.onHide?.(by);
  }
  /** The body the fabric rests on (the character's collision spheres: <char>-outfits/body.json). */
  setBody(json) { this.body = json ? new BodyColliders(json) : null; }
  /** Every game tick, after the pose is final (IK, fingers): the fabric. (sim off: rigid on the body) */
  step(dt, mats) {
    if (!this.worn.size) return;
    const body = this.sim === false ? null : this.body;
    if (body) { body.update(mats); body.build(); }
    // the bottom first: a top hangs over it (the shorts' fabric is a collider for the top)
    for (const slot of ['bottom', 'top']) {
      const w = this.worn.get(slot); if (!w) continue;
      if (w.fresh || this.sim === false) { w.cloth.reset(mats); w.fresh = false; } else w.cloth.step(dt, mats, body);
      if (body && slot === 'bottom') body.addExtra(w.cloth.x, w.cloth.n, 0.02);
    }
    this.dirty = true;
  }
  /** Once per rendered frame: the meshes (CPU skinning + the fabric's offsets, normals). */
  draw(mats) {
    if (!this.worn.size || !this.dirty) return;
    for (const w of this.worn.values()) {
      w.skin.update(mats, w.cloth.off);
      const geo = w.mesh.geometry;
      geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
    }
    this.dirty = false;
  }
  /** Pose without simulation (a held test pose, a replay scrub): the garments ride rigidly. */
  pose(mats) {
    for (const w of this.worn.values()) { w.cloth.reset(mats); w.fresh = false; }
    this.dirty = true; this.draw(mats);
  }
  resetCloth() { for (const w of this.worn.values()) w.fresh = true; }
  state() {
    return [...this.worn.values()].map((w) => ({ slot: w.g.slot, id: w.g.id, color: w.color, maxOffset: +w.cloth.stats.maxOffset.toFixed(4), resets: w.cloth.stats.resets, steps: w.cloth.stats.steps }));
  }
}
