/**
 * Garment tests (engine3d/garments.mjs + the outfit files of lib/mocap/mhr-rigs/<char>-outfits/).
 *
 * Files: every index in range, skin weights normalized, the hidden body faces exist on each LOD.
 * Bind pose: skinning reproduces the garment exactly. Drape pose (the game's idle, held still): the
 * limp fabric stays near its drape.
 * Game: AC's court game tick run headless (tests/helpers/ball-harness.mjs — the real Player, MHR
 * skinning, ball session and IK) wearing the tee + shorts: idle, jog, sprint, stop, crossover,
 * spin, jump shot — every tick checked (NaN, the fabric within its limits, no reset mid-play),
 * sampled ticks checked against the skinned body (cloth inside the drawn skin), the limp fabric
 * sways when moving and settles when standing, 30 vs 120 fps agree, and the cost per frame.
 *
 * Game scenarios need the clip library (data/mocap: npm run clips:pull) and skip without it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CHAR = 'ac-001';
const DIR = path.join(ROOT, 'lib', 'mocap', 'mhr-rigs', `${CHAR}-outfits`);
const HAVE = fs.existsSync(path.join(DIR, 'index.json'));
const HAVE_CLIPS = fs.existsSync(path.join(ROOT, 'data', 'mocap'));
const GA = import('../engine3d/garments.mjs');
const AN = import('../engine3d/anim3d.mjs');
const H = HAVE_CLIPS ? import('./helpers/ball-harness.mjs') : null;

const loadJson = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
async function garment(id) {
  const [{ decodeGarment }, A] = await Promise.all([GA, AN]);
  return decodeGarment(loadJson(path.join(DIR, `${id}.json.gz`)), A.b64);
}
const rigJson = () => loadJson(path.join(ROOT, 'lib', 'mocap', 'mhr-rigs', `${CHAR}.json.gz`));

module.exports = { wearAndPlay };

test('outfit files: indices in range, weights normalized, hidden faces on every LOD', { skip: HAVE ? false : 'no outfit files' }, async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
  assert.ok(idx.garments.some((g) => g.id === 'tee' && g.slot === 'top'), 'a tee');
  assert.ok(idx.garments.some((g) => g.id === 'shorts' && g.slot === 'bottom'), 'shorts');
  const A = await AN, R = rigJson();
  const bodyFaces = { 0: A.b64(R.parts[0].faces, R.parts[0].faces32 ? Uint32Array : Uint16Array).length / 3 };
  for (const lv of R.lods || []) bodyFaces[lv.level] = A.b64(lv.parts[0].faces, lv.parts[0].faces32 ? Uint32Array : Uint16Array).length / 3;
  for (const e of idx.garments) {
    const g = await garment(e.id);
    assert.ok(g.palette === undefined && g.material.palette.length >= 3, `${e.id}: a palette`);
    assert.ok(Math.max(...g.faces) < g.n && Math.max(...g.topo) < g.nt && Math.max(...g.topoFaces) < g.nt, `${e.id}: mesh indices`);
    assert.ok(Math.max(...g.clothIdx) < g.cloth.n && Math.max(...g.cloth.edges) < g.cloth.n, `${e.id}: cloth indices`);
    for (let i = 0; i < g.nt; i++) {
      const s = g.skinW[i * 4] + g.skinW[i * 4 + 1] + g.skinW[i * 4 + 2] + g.skinW[i * 4 + 3];
      const c = g.clothW[i * 4] + g.clothW[i * 4 + 1] + g.clothW[i * 4 + 2] + g.clothW[i * 4 + 3];
      assert.ok(Math.abs(s - 1) < 1e-3 && Math.abs(c - 1) < 1e-3, `${e.id}: weights of vertex ${i} (${s}, ${c})`);
    }
    for (const [lv, n] of Object.entries(bodyFaces)) {
      const h = g.hide[lv];
      assert.ok(h && h.length > 50, `${e.id}: hides body faces on LOD ${lv}`);
      assert.ok(Math.max(...h) < n, `${e.id}: LOD ${lv} hidden faces in range`);
    }
  }
});

test('bind pose: skinning reproduces the garment exactly', { skip: HAVE ? false : 'no outfit files' }, async () => {
  const G = await GA;
  const R = rigJson(), nb = R.mhr.names.length;
  const I = new Float32Array(nb * 16);
  for (let b = 0; b < nb; b++) { I[b * 16] = I[b * 16 + 5] = I[b * 16 + 10] = I[b * 16 + 15] = 1; }
  for (const id of ['tee', 'shorts']) {
    const g = await garment(id), cloth = new G.GarmentCloth(g), skin = new G.GarmentSkin(g);
    cloth.reset(I);
    skin.update(I, cloth.off);
    let err = 0; for (let i = 0; i < g.n * 3; i++) err = Math.max(err, Math.abs(skin.pos[i] - g.verts[i]));
    assert.ok(err < 1e-4, `${id}: bind-pose skinning is exact (${err})`);
  }
});

test('drape pose: the limp fabric stays on its drape when the body holds still', { skip: HAVE && HAVE_CLIPS ? false : 'no outfit files or clip library' }, async () => {
  // the pose the garments were draped in (export_pose.mjs: the idle dribble at 1.4 s)
  const [G, A, h] = await Promise.all([GA, AN, H]);
  const game = await h.makeGame({ rig: CHAR, fps: 60 });
  let mats = null;
  game.run([[0, 1.4, {}]], { onTick: ({ mats: m }) => { mats = Float32Array.from(m); } });
  const body = new G.BodyColliders(loadJson(path.join(DIR, 'body.json.gz')), A.b64);
  const W = [];
  for (const id of ['shorts', 'tee']) { const g = await garment(id); const c = new G.GarmentCloth(g); c.reset(mats); W.push({ id, c }); }
  for (let k = 0; k < 150; k++) { body.update(mats); body.build(); for (const w of W) { w.c.step(1 / 60, mats, body); if (w.id === 'shorts') body.addExtra(w.c.x, w.c.n, 0.02); } }
  for (const { id, c } of W) {
    let off = 0, mean = 0; for (let i = 0; i < c.n; i++) { const d = Math.hypot(c.off[i * 3], c.off[i * 3 + 1], c.off[i * 3 + 2]); off = Math.max(off, d); mean += d / c.n; }
    console.log(`  ${id}: held still in its drape pose, the fabric settles ${(mean * 100).toFixed(2)} cm on average (max ${(off * 100).toFixed(1)} cm) from its drape`);
    // (full gravity on the coarse cloth graph: it settles a little below the finer Blender drape)
    assert.ok(mean < 0.03, `${id}: stays close to its drape (${(mean * 100).toFixed(2)} cm)`);
  }
});

// ── the court game, headless, wearing the outfit
const SCRIPT = [
  [0, 2.0, {}],                                   // idle dribble
  [2.0, 4.2, { move: 'toHoop' }],                 // jog
  [4.2, 5.4, { move: 'sideHoop', sprint: true }], // sprint across
  [5.4, 6.6, {}],                                 // stop + settle
  [6.6, 8.6, { trig: 'move-crossover' }],
  [8.6, 10.6, { trig: 'move-spin' }],
  [10.6, 13.0, { trig: 'shot-jumper' }],
];
const phaseOf = (t) => (t < 2 ? 'idle' : t < 4.2 ? 'jog' : t < 5.4 ? 'sprint' : t < 6.6 ? 'stop' : t < 8.6 ? 'crossover' : t < 10.6 ? 'spin' : 'shot');

/** Skinned body (LOD 0) → a spatial hash for "how far inside the skin is this point". */
function bodyProbe(R, A, visible = null) {
  const p = R.parts[0], V = A.b64(p.verts, Float32Array), N = A.b64(p.normals, Float32Array), SI = A.b64(p.skinIdx, Uint8Array), SW = A.b64(p.skinW, Float32Array);
  const n = V.length / 3, X = new Float32Array(n * 3), XN = new Float32Array(n * 3), C = 0.03;
  let grid = new Map();
  return {
    update(m) {
      for (let i = 0; i < n; i++) {
        let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
        for (let k = 0; k < 4; k++) {
          const w = SW[i * 4 + k]; if (!w) continue; const o = SI[i * 4 + k] * 16, vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
          x += w * (m[o] * vx + m[o + 4] * vy + m[o + 8] * vz + m[o + 12]); y += w * (m[o + 1] * vx + m[o + 5] * vy + m[o + 9] * vz + m[o + 13]); z += w * (m[o + 2] * vx + m[o + 6] * vy + m[o + 10] * vz + m[o + 14]);
          a += w * (m[o] * nx + m[o + 4] * ny + m[o + 8] * nz); b += w * (m[o + 1] * nx + m[o + 5] * ny + m[o + 9] * nz); c += w * (m[o + 2] * nx + m[o + 6] * ny + m[o + 10] * nz);
        }
        const l = Math.hypot(a, b, c) || 1;
        X[i * 3] = x; X[i * 3 + 1] = y; X[i * 3 + 2] = z; XN[i * 3] = a / l; XN[i * 3 + 1] = b / l; XN[i * 3 + 2] = c / l;
      }
      grid = new Map();
      for (let i = 0; i < n; i++) { if (visible && !visible[i]) continue; const k = `${Math.floor(X[i * 3] / C)},${Math.floor(X[i * 3 + 1] / C)},${Math.floor(X[i * 3 + 2] / C)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    },
    /** signed distance to the nearest skin vertex along its normal (< 0: inside), or null if > 3 cm */
    depth(x, y, z) {
      const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(z / C);
      let best = Infinity, bi = -1;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const L = grid.get(`${cx + a},${cy + b},${cz + c}`); if (!L) continue;
        for (const i of L) { const d = (X[i * 3] - x) ** 2 + (X[i * 3 + 1] - y) ** 2 + (X[i * 3 + 2] - z) ** 2; if (d < best) { best = d; bi = i; } }
      }
      if (bi < 0 || best > 0.03 ** 2) return null;
      return (x - X[bi * 3]) * XN[bi * 3] + (y - X[bi * 3 + 1]) * XN[bi * 3 + 1] + (z - X[bi * 3 + 2]) * XN[bi * 3 + 2];
    },
  };
}

async function wearAndPlay(fps, { sample = 0, cfg = {} } = {}) {
  const [G, A, h] = await Promise.all([GA, AN, H]);
  const game = await h.makeGame({ rig: CHAR, fps });
  const worn = [];
  for (const id of ['shorts', 'tee']) { const g = await garment(id); worn.push({ id, g, cloth: new G.GarmentCloth(g, cfg), skin: new G.GarmentSkin(g), prev: null }); }
  for (const w of worn) w.cloth.reset(game.mats);
  const body = new G.BodyColliders(loadJson(path.join(DIR, 'body.json.gz')), A.b64);
  const m = { nan: 0, overLimit: 0, resets: {}, offsets: {}, sway: {}, series: [], inside: {}, samples: 0, ms: 0, frames: 0 };
  // the skin that is drawn (a body vertex on any face the garments do not hide)
  const R0 = game.rigJson, BF = A.b64(R0.parts[0].faces, R0.parts[0].faces32 ? Uint32Array : Uint16Array);
  const hidden = new Set(); for (const w of worn) for (const f of w.g.hide[0]) hidden.add(f);
  const visible = new Uint8Array(BF.length / 3 ? A.b64(R0.parts[0].verts, Float32Array).length / 3 : 0);
  for (let f = 0; f < BF.length / 3; f++) if (!hidden.has(f)) { visible[BF[f * 3]] = visible[BF[f * 3 + 1]] = visible[BF[f * 3 + 2]] = 1; }
  const probe = sample ? bodyProbe(game.rigJson, A, visible) : null;
  let k = 0;
  game.run(SCRIPT, {
    onTick: ({ t, mats }) => {
      const t0 = process.hrtime.bigint();
      body.update(mats); body.build();
      for (const w of worn) {
        w.cloth.step(1 / fps, mats, body);
        if (w.id === 'shorts') body.addExtra(w.cloth.x, w.cloth.n, 0.02);
        w.skin.update(mats, w.cloth.off);
      }
      m.ms += Number(process.hrtime.bigint() - t0) / 1e6; m.frames++;
      const ph = phaseOf(t);
      const row = { t, ph };
      for (const w of worn) {
        const c = w.cloth, o = c.off;
        let mx = 0, mean = 0;
        for (let i = 0; i < c.n; i++) {
          const d = Math.hypot(o[i * 3], o[i * 3 + 1], o[i * 3 + 2]);
          if (!Number.isFinite(d)) m.nan++;
          if (d > c.maxD[i] + 1e-4) m.overLimit++;
          mx = Math.max(mx, d); mean += d;
        }
        mean /= c.n;
        row[w.id] = mean;
        // sway: how fast the fabric moves relative to the body (m/s, mean over the nodes)
        if (w.prev) { let v = 0; for (let i = 0; i < c.n * 3; i += 3) v += Math.hypot(o[i] - w.prev[i], o[i + 1] - w.prev[i + 1], o[i + 2] - w.prev[i + 2]); (m.sway[`${w.id}:${ph}`] ||= []).push(v / c.n * fps); }
        w.prev = Float32Array.from(o);
        const key = `${w.id}:${ph}`;
        m.offsets[key] = Math.max(m.offsets[key] || 0, mx);
        (m.offsets[key + ':mean'] ||= []).push(mean);
        m.resets[w.id] = c.stats.resets;
        for (const v of w.skin.pos) if (!Number.isFinite(v)) { m.nan++; break; }
      }
      m.series.push(row);
      if (probe && k++ % sample === 0) {
        probe.update(mats);
        m.samples++;
        for (const w of worn) {
          let deep = 0, n = 0;
          for (let i = 0; i < w.g.nt; i++) { const d = probe.depth(w.skin.tp[i * 3], w.skin.tp[i * 3 + 1], w.skin.tp[i * 3 + 2]); if (d == null) continue; n++; if (d < -0.012) deep++; }
          const key = `${w.id}:${ph}`;
          m.inside[key] = Math.max(m.inside[key] || 0, deep / Math.max(1, w.g.nt));
        }
      }
    },
  });
  for (const k2 of Object.keys(m.offsets)) if (k2.endsWith(':mean')) { const a = m.offsets[k2]; m.offsets[k2] = a.reduce((x, y) => x + y, 0) / a.length; }
  for (const k2 of Object.keys(m.sway)) { const a = m.sway[k2]; m.sway[k2] = a.reduce((x, y) => x + y, 0) / a.length; }
  m.msPerFrame = m.ms / m.frames;
  return m;
}

test('game (AC, 60 fps): limp fabric on every move — stable, within its limits, sways, never through the drawn skin', { skip: HAVE && HAVE_CLIPS ? false : 'no outfit files or clip library' }, async () => {
  const m = await wearAndPlay(60, { sample: 6 });
  const r = (x) => +(x * 100).toFixed(1);
  console.log('  offset from the draped shape (cm, max / mean per phase):', Object.fromEntries(Object.entries(m.offsets).filter(([k]) => !k.endsWith(':mean')).map(([k, v]) => [k, `${r(v)} / ${r(m.offsets[k + ':mean'])}`])));
  console.log('  sway (cm/s, mean fabric speed relative to the body):', Object.fromEntries(Object.entries(m.sway).map(([k, v]) => [k, r(v)])));
  console.log('  cloth vertices > 1.2 cm inside the drawn skin (worst sampled frame per phase, %):', Object.fromEntries(Object.entries(m.inside).map(([k, v]) => [k, +(v * 100).toFixed(2)])));
  console.log(`  cost: ${m.msPerFrame.toFixed(2)} ms per frame (tee + shorts: fabric + body spheres + skinning + normals)`);
  assert.strictEqual(m.nan, 0, 'no NaN');
  assert.strictEqual(m.overLimit, 0, 'no node beyond its distance from the body');
  for (const [id, n] of Object.entries(m.resets)) assert.ok(n <= 2, `${id}: the fabric never resets mid-play (${n})`);
  // it sways: moving makes the fabric move relative to the body, standing lets it settle
  for (const id of ['tee', 'shorts']) {
    assert.ok(m.sway[`${id}:sprint`] > 1.5 * m.sway[`${id}:idle`], `${id} sways more sprinting (${r(m.sway[id + ':sprint'])}) than standing (${r(m.sway[id + ':idle'])}) cm/s`);
    assert.ok(m.offsets[`${id}:sprint`] > 0.02, `${id} moves off its draped shape when sprinting (${r(m.offsets[id + ':sprint'])} cm)`);
  }
  for (const [k, v] of Object.entries(m.inside)) assert.ok(v < 0.02, `${k}: ${(v * 100).toFixed(1)} % of the cloth inside the drawn skin`);
  assert.ok(m.msPerFrame < 5, `cheap enough for a frame (${m.msPerFrame.toFixed(2)} ms)`);
});

test('game: frame-rate independent — 30 and 120 fps give the same fabric', { skip: HAVE && HAVE_CLIPS ? false : 'no outfit files or clip library' }, async () => {
  const [a, b] = [await wearAndPlay(30), await wearAndPlay(120)];
  // mean offset per phase (the animation itself differs by a frame or so between rates)
  for (const k of ['tee:jog:mean', 'tee:sprint:mean', 'shorts:sprint:mean', 'tee:crossover:mean', 'shorts:shot:mean']) {
    const d = Math.abs(a.offsets[k] - b.offsets[k]);
    console.log(`  ${k}: 30 fps ${(a.offsets[k] * 100).toFixed(2)} cm · 120 fps ${(b.offsets[k] * 100).toFixed(2)} cm`);
    assert.ok(d < 0.006 + 0.25 * Math.max(a.offsets[k], b.offsets[k]), `${k}: 30 vs 120 fps differ by ${(d * 100).toFixed(2)} cm`);
  }
  assert.strictEqual(a.nan + b.nan, 0);
});
