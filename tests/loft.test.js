/**
 * The loft behind the court's door (engine3d/loft.mjs):
 *
 *   layout      the room's layout in game-world coordinates (origin, spawn facing, exit)
 *   walking     the capsule kept in the bounds and out of the furniture: slides along a side, rounds a corner,
 *               never jitters walking into a box, a gap narrower than the capsule keeps the last valid spot
 *   camera      the camera kept inside the room's box and under its ceiling
 *   bakes       extras.lm_scale → unlit MeshBasicMaterial with its emissive map as the light map; extras.vc_scale →
 *               unlit with vertex colours, the colour × vc_scale (shared materials once, real emissives untouched)
 *   fetch       the GLB download: progress, HTTP errors, a stall, a short body
 *   the file    assets/courts/loft-layout.json against the GLB (spawn / exit inside the bounds, clear of
 *               the furniture, the spawn outside the exit's trigger)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LM = import('../engine3d/loft.mjs');
const THREE = import('../vendor/three.module.min.js');   // the three the game ships (r160), not an undeclared node_modules copy

const L0 = {
  bounds: { minX: -4, maxX: 8, minZ: -9, maxZ: 1 },
  colliders: [{ name: 'sofa', minX: -1, maxX: 3, minZ: -5, maxZ: -3 }, { name: 'a', minX: 5, maxX: 6, minZ: -2, maxZ: -1 }, { name: 'b', minX: 6.4, maxX: 7, minZ: -2, maxZ: -1 }],
  spawn: { pos: [1, 0, -0.5], faceDeg: 180 }, exit: { pos: [1, 0, 1.2], radius: 1 },
  camera: { minX: -4.05, maxX: 8.05, minZ: -9.05, maxZ: 1.05, maxY: 5.5 },
};

test('layout: the room in game-world coordinates', async () => {
  const { worldLayout, LOFT_ORIGIN: O } = await LM;
  const W = worldLayout(L0);
  assert.deepStrictEqual([W.bounds.minX, W.bounds.maxZ], [-4 + O[0], 1 + O[2]]);
  assert.strictEqual(W.colliders[0].minX, -1 + O[0]);
  assert.strictEqual(W.spawn.x, 1 + O[0]); assert.strictEqual(W.spawn.z, -0.5 + O[2]);
  // faceDeg 180 = facing −z: the game's facing vector [sin yaw, cos yaw]
  assert.ok(Math.abs(Math.sin(W.spawn.yaw)) < 1e-9 && Math.abs(Math.cos(W.spawn.yaw) + 1) < 1e-9);
  assert.deepStrictEqual([W.exit.x, W.exit.z, W.exit.r], [1 + O[0], 1.2 + O[2], 1]);
  assert.strictEqual(W.camera.maxY, 5.5);
  // the origin keeps the room on the physics floor (a ±40 m slab) and clear of both courts (|x| ≤ 15.7)
  assert.ok(W.bounds.minX - 1 > 15.7 && W.bounds.maxX + 1 < 40 && W.bounds.minZ > -40 && W.bounds.maxZ < 40);
});

test('walking: inside the bounds, out of the furniture, sliding along it', async () => {
  const { worldLayout, constrainDisc, slideVelocity, penetration } = await LM;
  const W = worldLayout(L0, [0, 0, 0]), r = 0.3;
  // outside the bounds → on its edge, the normal points back in
  let p = [9, 2]; let n = constrainDisc(p, null, r, W);
  assert.deepStrictEqual(p, [8, 1]); assert.ok(n.some(([x]) => x === -1) && n.some(([, z]) => z === -1));
  // walking straight into the sofa's front (+z side) from z = -2: stopped one radius away, never inside
  p = [1, -2.6]; let prev = [1, -2.6];
  for (let i = 0; i < 30; i++) { p[1] -= 0.05; constrainDisc(p, prev, r, W); prev = p.slice(); assert.ok(penetration(p[0], p[1], r, W) < 1e-6); }
  assert.ok(Math.abs(p[1] - (-3 + r)) < 1e-9, `stopped at ${p[1]}`);
  // no jitter: pushing on in place leaves him exactly there
  const still = p.slice(); for (let i = 0; i < 10; i++) { p[1] -= 0.05; constrainDisc(p, prev, r, W); }
  assert.ok(Math.abs(p[0] - still[0]) < 1e-9 && Math.abs(p[1] - still[1]) < 1e-9);
  // diagonally into the side: the along-side part of the motion survives (slides)
  p = [1, -2.75]; constrainDisc(p, null, r, W); p[0] += 0.1; p[1] -= 0.1; n = constrainDisc(p, null, r, W);
  assert.ok(Math.abs(p[0] - 1.1) < 1e-9 && Math.abs(p[1] - (-2.7)) < 1e-9);
  const v = slideVelocity([2, -2], n); assert.ok(Math.abs(v[0] - 2) < 1e-9 && Math.abs(v[1]) < 1e-9);
  // the corner is round: at 45° off the corner he is exactly r from it
  p = [3.1, -2.9]; constrainDisc(p, null, r, W);
  assert.ok(Math.abs(Math.hypot(p[0] - 3, p[1] + 3) - r) < 1e-9);
  // the centre deep inside a box: out through the nearest side
  p = [2.8, -4]; constrainDisc(p, null, r, W); assert.ok(Math.abs(p[0] - 3.3) < 1e-9);
  // a gap narrower than the capsule (0.4 m between a and b): he keeps the last valid spot
  prev = [6.2, -0.4]; p = [6.2, -1.5]; constrainDisc(p, prev, r, W);
  assert.deepStrictEqual(p, prev);
});

test('camera: inside the room, under the ceiling, above the floor', async () => {
  const { worldLayout, clampCamera } = await LM;
  const W = worldLayout(L0, [0, 0, 0]);
  assert.deepStrictEqual(clampCamera({ x: 20, y: 9, z: 4 }, W), { x: 8.05, y: 5.5, z: 1.05 });
  assert.deepStrictEqual(clampCamera({ x: -20, y: -1, z: -40 }, W), { x: -4.05, y: 0.25, z: -9.05 });
  const c = { x: 1, y: 2, z: -3 }; assert.deepStrictEqual(clampCamera(c, W), { x: 1, y: 2, z: -3 });
});

test('bakes: lm_scale → unlit + light map, vc_scale → unlit + vertex colours; others stay', async () => {
  const T = await THREE, { convertLightmapped } = await LM;
  const lmTex = new T.Texture(); lmTex.channel = 1;
  const base = new T.Texture();
  const baked = new T.MeshStandardMaterial({ map: base, emissiveMap: lmTex, color: 0xff8800, side: T.DoubleSide, transparent: true, opacity: 0.8, alphaTest: 0.1 });
  baked.userData.lm_scale = 2.5; baked.name = 'plaster';
  const glow = new T.MeshStandardMaterial({ emissive: 0xffaa55, emissiveMap: new T.Texture() });   // a real emissive (no lm_scale)
  const root = new T.Group();
  const a = new T.Mesh(new T.BoxGeometry(), baked), b = new T.Mesh(new T.BoxGeometry(), baked), c = new T.Mesh(new T.BoxGeometry(), glow);
  const d = new T.Mesh(new T.BoxGeometry(), [baked, glow]);
  root.add(a, b, c, d);
  assert.strictEqual(convertLightmapped(T, root), 1);
  const m = a.material;
  assert.ok(m.isMeshBasicMaterial && m === b.material && m === d.material[0], 'one shared conversion');
  assert.strictEqual(m.lightMap, lmTex); assert.strictEqual(m.lightMap.channel, 1); assert.strictEqual(m.map, base);
  assert.ok(Math.abs(m.lightMapIntensity - 2.5 * Math.PI) < 1e-9);
  assert.strictEqual(m.color.getHex(), 0xff8800);
  assert.deepStrictEqual([m.side, m.transparent, m.opacity, m.alphaTest], [T.DoubleSide, true, 0.8, 0.1]);
  assert.strictEqual(m.name, 'plaster'); assert.ok(m.userData.lightmapped);
  assert.strictEqual(c.material, glow); assert.strictEqual(d.material[1], glow);
  // vertex-colour bakes (extras.vc_scale): vertex colours on, the colour factor × vc_scale (above 1 on purpose)
  const vcMat = new T.MeshStandardMaterial({ map: base, color: new T.Color(0.5, 0.25, 1), side: T.DoubleSide, alphaTest: 0.2 });
  vcMat.userData.vc_scale = 3.2; vcMat.name = 'island';
  const lmNoMap = new T.MeshStandardMaterial(); lmNoMap.userData.lm_scale = 2;   // (no emissive map: left alone)
  const g2 = new T.BoxGeometry(); g2.setAttribute('color', new T.BufferAttribute(new Float32Array(g2.attributes.position.count * 3).fill(0.3), 3));
  const r3 = new T.Group(); const e = new T.Mesh(g2, vcMat), f = new T.Mesh(new T.BoxGeometry(), vcMat), h = new T.Mesh(new T.BoxGeometry(), lmNoMap);
  r3.add(e, f, h);
  assert.strictEqual(convertLightmapped(T, r3), 1);
  const v = e.material;
  assert.ok(v.isMeshBasicMaterial && v === f.material && v.vertexColors === true && v.map === base && !v.lightMap);
  assert.ok(Math.abs(v.color.r - 1.6) < 1e-6 && Math.abs(v.color.g - 0.8) < 1e-6 && Math.abs(v.color.b - 3.2) < 1e-6, 'colour × vc_scale, above 1');
  assert.deepStrictEqual([v.side, v.alphaTest, v.name, v.userData.baked], [T.DoubleSide, 0.2, 'island', 'vertex']);
  assert.strictEqual(h.material, lmNoMap);
  assert.strictEqual(m.userData.baked, 'lightmap');
  // the current GLB (no lm_scale anywhere): nothing changes
  const r2 = new T.Group(); const s = new T.MeshStandardMaterial(); r2.add(new T.Mesh(new T.BoxGeometry(), s));
  assert.strictEqual(convertLightmapped(T, r2), 0); assert.strictEqual(r2.children[0].material, s);
});

test('fetch: progress, HTTP errors, a stall, a short body', async () => {
  const { fetchBuffer, LoftLoadError } = await LM;
  const http = require('http');
  const body = Buffer.alloc(300000, 7);
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'model/gltf-binary' }); res.write(body.subarray(0, 100000)); setTimeout(() => res.end(body.subarray(100000)), 20); }
    else if (req.url === '/500') { res.writeHead(500); res.end('no'); }
    else if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); }
    else if (req.url === '/stall') { res.writeHead(200, { 'Content-Length': body.length }); res.write(body.subarray(0, 1000)); }
    else if (req.url === '/short') { res.writeHead(200, { 'Content-Length': body.length }); res.write(body.subarray(0, 1000)); setTimeout(() => res.destroy(), 30); }
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const prog = [];
    const ab = await fetchBuffer(base + '/ok', { onProgress: (g, t) => prog.push([g, t]) });
    assert.strictEqual(ab.byteLength, body.length);
    assert.ok(prog.length >= 2 && prog.at(-1)[0] === body.length && prog.every(([, t]) => t === body.length));
    await assert.rejects(fetchBuffer(base + '/500'), (e) => e instanceof LoftLoadError && /HTTP 500/.test(e.message));
    await assert.rejects(fetchBuffer(base + '/html'), (e) => e instanceof LoftLoadError && /web page/.test(e.message));
    await assert.rejects(fetchBuffer(base + '/stall', { idleMs: 150 }), (e) => e instanceof LoftLoadError && /stalled/.test(e.message));
    await assert.rejects(fetchBuffer(base + '/short'), (e) => e instanceof LoftLoadError);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('the file: the layout fits the room', async () => {
  const { worldLayout, penetration, PLAYER_R } = await LM;
  const fp = path.join(__dirname, '..', 'assets', 'courts', 'loft-layout.json');
  if (!fs.existsSync(fp)) return;   // (the asset is generated separately)
  const L = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const W = worldLayout(L, [0, 0, 0]), b = W.bounds;
  for (const [name, q] of [['spawn', W.spawn], ['exit', W.exit]]) {
    assert.ok(q.x >= b.minX && q.x <= b.maxX && q.z >= b.minZ && q.z <= b.maxZ, `${name} inside the bounds`);
  }
  assert.ok(penetration(W.spawn.x, W.spawn.z, PLAYER_R, W) === 0, 'the spawn is clear of the furniture');
  assert.ok(Math.hypot(W.spawn.x - W.exit.x, W.spawn.z - W.exit.z) > W.exit.r, 'the spawn is outside the exit trigger');
  // the exit can be reached (a spot inside its radius and the bounds, clear of the furniture)
  let ok = false;
  for (let a = 0; a < 64 && !ok; a++) for (const k of [0, 0.3, 0.6, 0.9]) {
    const x = W.exit.x + Math.cos(a) * W.exit.r * k, z = W.exit.z + Math.sin(a) * W.exit.r * k;
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && penetration(x, z, PLAYER_R, W) === 0) { ok = true; break; }
  }
  assert.ok(ok, 'the exit is reachable');
  assert.ok(W.camera.maxY > 2.5 && L.lights && (L.lights.points || []).length, 'a camera ceiling and lights');
});
