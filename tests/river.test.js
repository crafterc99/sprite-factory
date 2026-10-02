/**
 * The River practice court (engine3d/court-river.mjs) — its plain math, on the real layout
 * (assets/courts/river-layout.json) and the real VANTHEAH frame (engine3d/court-vantheah.mjs: its browser imports
 * '/vendor/…' resolved to the repo's vendor/ by a loader hook):
 *
 *   frame       the layout in game space by VANTHEAH's own transform: the walkable rectangle, the reference camera
 *   player      the footprints the player is kept out of (body high, inside the walls): bleachers, rubble, hoop
 *               posts, curb, floodlight poles — not the fence above the wall, the quay, the trees across the water
 *   ball        the ball's boxes: above the floor, none closes a rim's hole (cut out of the rings), kinds / bounce
 *   door        the loft's door on this court: against the left wall, clear of everything, its prompt / way out on
 *               the walkable court; the stair-house footprint turns with the door (VANTHEAH's: unchanged)
 *   look        the layout's light colours read as linear (as the Cycles scene had them)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// the game's modules import '/vendor/…' and '/js/…' (the server's paths): map them onto the repo
const ROOT = pathToFileURL(path.join(__dirname, '..') + '/').href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/vendor/')) return next(${JSON.stringify(ROOT)} + spec.slice(1), ctx);
  if (spec.startsWith('/js/')) return next(${JSON.stringify(ROOT)} + 'engine3d/' + spec.slice(4), ctx);
  return next(spec, ctx);
}`));

const RC = import('../engine3d/court-river.mjs');
const VCp = import('../engine3d/court-vantheah.mjs');
const LM = import('../engine3d/loft.mjs');
const THREE = import('../vendor/three.module.min.js');
const LAYOUT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'courts', 'river-layout.json'), 'utf8'));

test('frame: the layout in game space by VANTHEAH\'s transform', async () => {
  const R = await RC, VC = await VCp;
  const W = R.riverWorld(LAYOUT, VC);
  // glb (x, y, z) → game (−z, y, x + 12.425)
  assert.deepStrictEqual([W.bounds.minX, W.bounds.maxX], [-17.9, 13.6]);
  assert.ok(Math.abs(W.bounds.minZ - (-19.6 + 12.425)) < 1e-9 && Math.abs(W.bounds.maxZ - (19.5 + 12.425)) < 1e-9);
  // the game's hoop (the West rim) and the start spot are on the walkable court
  for (const [x, z] of [[0, 1], [1.8, 5.2], [0, 24]]) assert.ok(x > W.bounds.minX && x < W.bounds.maxX && z > W.bounds.minZ && z < W.bounds.maxZ);
  const cam = R.renderCameraToGame(LAYOUT, VC);
  assert.deepStrictEqual(cam.pos.map((v) => +v.toFixed(3)), [9.467, 2.029, 38.313]);
  assert.strictEqual(cam.fov, LAYOUT.renderCamera.fovV);
  // a direction turns without the offset
  assert.deepStrictEqual(R.dirToGame(VC, [1, 0, 0]).map((v) => v + 0), [0, 0, 1]);
});

test('player: what is body high inside the walls', async () => {
  const R = await RC, VC = await VCp;
  const W = R.riverWorld(LAYOUT, VC), names = W.colliders.map((c) => c.name);
  for (const n of ['01-bleachers#0', '01-bleachers#1', '05-rubble#0', '05-rubble#3', 'hoop-pole--1', 'hoop-pole-1', 'curb-near-left']) assert.ok(names.includes(n), n);
  for (const n of ['fence-left', 'quay', '04-tree#3', '04-tree#8']) assert.ok(!names.includes(n), n);   // (above the wall / under the floor / across the water)
  // the hoop posts from the GLB replace the layout's rough box; extra footprints are added
  const ov = { 'hoop-pole--1': { min: [-0.97, 0, -1.34], max: [-0.22, 2.2, -0.6] } };
  const W2 = R.riverWorld(LAYOUT, VC, { overrides: ov, extra: [{ name: 'x', minX: 0, maxX: 1, minZ: 0, maxZ: 1 }] });
  const p = W2.colliders.find((c) => c.name === 'hoop-pole--1');
  assert.deepStrictEqual([p.minX, p.maxX, p.minZ, p.maxZ], [-0.97, -0.22, -1.34, -0.6]);
  assert.ok(W2.colliders.some((c) => c.name === 'x'));
  // the start spot is clear
  const L = await LM;
  assert.strictEqual(L.penetration(1.8, 5.2, L.PLAYER_R, W), 0);
});

test('ball: boxes above the floor, none closing a rim\'s hole', async () => {
  const R = await RC, VC = await VCp;
  const B = R.riverBallBoxes(LAYOUT, VC);
  assert.ok(!B.some((b) => b.name === 'quay'), 'the quay\'s top is the floor');
  assert.ok(B.length >= 30);
  for (const b of B) {
    assert.ok(b.half.every((h) => h > 0) && b.center[1] - b.half[1] >= -1e-9, b.name);
    for (const g of VC.VANTHEAH.goals) {
      // the ring's hole at the rim's height: no box reaches inside the ring
      const lo = b.center.map((c, k) => c - b.half[k]), hi = b.center.map((c, k) => c + b.half[k]);
      if (hi[1] < g[1] - 0.3 || lo[1] > g[1] + 0.3) continue;
      const cx = Math.max(lo[0], Math.min(g[0], hi[0])), cz = Math.max(lo[2], Math.min(g[2], hi[2]));
      assert.ok(Math.hypot(cx - g[0], cz - g[2]) >= VC.VANTHEAH.rimR - 1e-6, `${b.name} inside the ring at ${g}`);
    }
  }
  assert.deepStrictEqual([R.ballKind('fence-far').kind, R.ballKind('barrier-back').kind, R.ballKind('hoop-pole-1').kind, R.ballKind('01-bleachers#0').kind], ['fence', 'wall', 'stanchion', 'props']);
});

test('door: in the waterfront corner, clear, its way out on the court', async () => {
  const R = await RC, VC = await VCp, L = await LM;
  const d = R.RIVER_DOOR, fp = R.doorFootprint(d);
  // facing +x: the house behind the face, against the left wall (x −18.3)
  assert.ok(Math.abs(fp.maxX - d.x) < 1e-9 && Math.abs(fp.minX - (d.x - 1.5)) < 1e-9 && Math.abs(fp.maxZ - fp.minZ - 2.2) < 1e-9);
  assert.ok(fp.minX >= -18.3 - 1e-9, 'inside the wall');
  const W = R.riverWorld(LAYOUT, VC);
  // (the wall it stands against: the house's back on the wall's face, inside the wall's thick collider)
  for (const c of W.colliders) if (!/^wall-/.test(c.name)) assert.ok(c.maxX <= fp.minX || c.minX >= fp.maxX || c.maxZ <= fp.minZ || c.minZ >= fp.maxZ, `clear of ${c.name}`);
  // where he comes out (0.95 m in front) and the prompt point (0.15 m): on the court, clear of everything (the house too)
  const out = [d.x + Math.sin(d.yaw) * 0.95, d.z + Math.cos(d.yaw) * 0.95];
  const Wd = R.riverWorld(LAYOUT, VC, { extra: [fp] });
  assert.ok(out[0] > W.bounds.minX && out[1] > W.bounds.minZ);
  assert.strictEqual(L.penetration(out[0], out[1], L.PLAYER_R, Wd), 0);
  // VANTHEAH's door (yaw 0): the same box as before (x ± 1.1, from the face 1.5 m back)
  const v = R.doorFootprint({ x: -5.2, z: -1.925, yaw: 0 });
  assert.deepStrictEqual([v.minX, v.maxX, v.minZ, v.maxZ].map((x) => +x.toFixed(9)), [-6.3, -4.1, -3.425, -1.925]);
});

test('look: the layout\'s light colours are linear RGB', async () => {
  const R = await RC, T = await THREE;
  const c = R.linearHex(T, '#ff8c47');
  assert.deepStrictEqual([c.r, c.g, c.b].map((x) => +x.toFixed(4)), [1, +(0x8c / 255).toFixed(4), +(0x47 / 255).toFixed(4)]);
  assert.ok(R.LOOK.exposure > 0 && R.LOOK.exposure <= 1 && R.LOOK.sheen < 0.5);
});
