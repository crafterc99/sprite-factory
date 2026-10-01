/**
 * The loft behind the court's door (court3d.html): assets/courts/loft.glb + loft-layout.json.
 *
 * The room is authored in its own three.js coordinates (metres, y up, floor at y = 0, its front door on the
 * wall at z ≈ +1.6). In the game world it stands at LOFT_ORIGIN — on the ball physics' floor (a ±40 m slab)
 * and clear of every court collider of both court kinds: the court's hoops, fences and stands never touch the
 * ball in here, the room's walls never touch it on the court. Nothing else moves: the player, his ball and the
 * camera simply live at other coordinates while he is inside.
 *
 * The layout (in the room's coordinates): bounds (where the player's centre may go), colliders (furniture
 * footprints, x / z boxes he walks around), spawn { pos, faceDeg } (just inside the door), exit { pos, radius }
 * (at the door), camera { minX…maxZ, maxY } (where the camera may be), lights (hemisphere, a low sun, point
 * lights in physically correct units — the GLB has none), background.
 *
 * Materials: a glTF material with extras.lm_scale is lightmapped — its emissive map is the baked lighting (on
 * UV channel 1); it becomes an unlit MeshBasicMaterial with that map as its light map (the scene lights then
 * only light the character and the ball). Every other material is left as glTF made it (real emissives:
 * skyline, TV, LED strip, bulbs, the exit sign).
 *
 * Plain math (collision, the camera's box) has no three.js in it — tests/loft.test.js; THREE and the loaders
 * are passed in to the rest.
 */

/** Where the room's origin stands in the game world (x, y, z). */
export const LOFT_ORIGIN = [26, 0, 12];
/** The player's capsule radius (m) against the furniture. */
export const PLAYER_R = 0.3;
/** Inside: AgX (the render was AgX Punchy at +0.35 EV) at this exposure, unless the layout says otherwise. */
export const LOFT_EXPOSURE = 1.27;
/** The exposure inside: the layout's (its bake's tone settings), else LOFT_EXPOSURE. */
export const loftExposure = (L) => L?.exposure ?? L?.baked?.exposure ?? LOFT_EXPOSURE;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** The layout in game-world coordinates (boxes and points moved by the origin; the spawn's facing as a yaw). */
export function worldLayout(L, O = LOFT_ORIGIN) {
  const box = (b) => ({ name: b.name, minX: b.minX + O[0], maxX: b.maxX + O[0], minZ: b.minZ + O[2], maxZ: b.maxZ + O[2] });
  const sp = L.spawn?.pos || [0, 0, 0], ex = L.exit?.pos || sp;
  return {
    bounds: box(L.bounds),
    colliders: (L.colliders || []).map(box),
    // (yaw: the game's facing angle — facing vector [sin, cos]; faceDeg 180 = facing −z)
    spawn: { x: sp[0] + O[0], z: sp[2] + O[2], yaw: ((L.spawn?.faceDeg ?? 180) * Math.PI) / 180 },
    exit: { x: ex[0] + O[0], z: ex[2] + O[2], r: L.exit?.radius ?? 1 },
    camera: { ...box(L.camera || L.bounds), maxY: L.camera?.maxY ?? 4 },
  };
}

/**
 * The player's capsule (a disc of radius r seen from above) kept out of the furniture and inside the bounds.
 * Each box pushes the centre out along the line from its closest point (it slides along the sides and rounds
 * the corners: no jitter), a few passes for boxes that touch. A spot no pass can clear (a gap narrower than the
 * capsule) keeps the last valid position instead.
 * @param {number[]} p     [x, z] — moved in place
 * @param {number[]} prev  [x, z] — the last valid position (or null)
 * @returns {number[][]} the contact normals [nx, nz] (pointing out of what he touched)
 */
export function constrainDisc(p, prev, r, W, iters = 4) {
  let x = p[0], z = p[1];
  const normals = [], B = W.bounds;
  const inBounds = () => {
    const bx = clamp(x, B.minX, B.maxX), bz = clamp(z, B.minZ, B.maxZ);
    if (bx !== x) normals.push([Math.sign(bx - x), 0]);
    if (bz !== z) normals.push([0, Math.sign(bz - z)]);
    x = bx; z = bz;
  };
  inBounds();
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (const b of W.colliders) {
      const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      if (d >= r - 1e-7) continue;
      let nx, nz, push;
      if (d > 1e-7) { nx = dx / d; nz = dz / d; push = r - d; }
      else {
        // the centre inside the box: out through its nearest side
        const sides = [[x - b.minX, -1, 0], [b.maxX - x, 1, 0], [z - b.minZ, 0, -1], [b.maxZ - z, 0, 1]];
        let s = sides[0]; for (const q of sides) if (q[0] < s[0]) s = q;
        nx = s[1]; nz = s[2]; push = s[0] + r;
      }
      x += nx * push; z += nz * push;
      normals.push([nx, nz]); moved = true;
    }
    inBounds();
    if (!moved) break;
  }
  if (prev && penetration(x, z, r, W) > 0.01) { x = prev[0]; z = prev[1]; }
  p[0] = x; p[1] = z;
  return normals;
}
/** How deep (m) a disc at (x, z) is inside the deepest collider (0: clear). */
export function penetration(x, z, r, W) {
  let worst = 0;
  for (const b of W.colliders) {
    const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ), d = Math.hypot(x - cx, z - cz);
    const inside = x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
    const depth = inside ? r + Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z) : r - d;
    if (depth > worst) worst = depth;
  }
  return worst;
}
/** Velocity [vx, vz] with its part into each contact normal taken out (slides along a wall instead of pushing it). */
export function slideVelocity(v, normals) {
  for (const [nx, nz] of normals) { const d = v[0] * nx + v[1] * nz; if (d < 0) { v[0] -= d * nx; v[1] -= d * nz; } }
  return v;
}
/** A camera position {x, y, z} kept inside the layout's camera box (and above the floor). */
export function clampCamera(c, W, minY = 0.25) {
  const C = W.camera;
  c.x = clamp(c.x, C.minX, C.maxX); c.z = clamp(c.z, C.minZ, C.maxZ); c.y = clamp(c.y, minY, C.maxY);
  return c;
}
/** Smallest signed angle a → b (rad). */
export const angleTo = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

// ═══ Loading ═══

export class LoftLoadError extends Error {}

/**
 * A large binary download with real progress (bytes so far / Content-Length), a deadline for the first byte
 * and a stall timer that resets on every chunk; non-2xx and HTML (a sign-in page) are errors.
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchBuffer(url, { onProgress = null, headerMs = 30000, idleMs = 30000, signal = null, expectBytes = 0 } = {}) {
  const ctl = new AbortController();
  let timer = null, why = null;
  const arm = (ms, w) => { clearTimeout(timer); timer = setTimeout(() => { why = w; ctl.abort(); }, ms); };
  const onAbort = () => { why = 'cancelled'; ctl.abort(); };
  signal?.addEventListener('abort', onAbort);
  try {
    arm(headerMs, 'the server did not answer');
    const r = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
    if (!r.ok) throw new LoftLoadError(`the server answered HTTP ${r.status}`);
    if ((r.headers.get('content-type') || '').includes('text/html')) throw new LoftLoadError('the server sent a web page instead of the loft (signed out?)');
    const enc = r.headers.get('content-encoding');
    const total = (!enc || enc === 'identity' ? +(r.headers.get('content-length') || 0) : 0) || expectBytes;
    arm(idleMs, 'the download stalled');
    let got = 0, buf = total ? new Uint8Array(total) : null;
    const chunks = [];
    onProgress?.(0, total);
    if (r.body?.getReader) {
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        arm(idleMs, 'the download stalled');
        if (buf && got + value.length <= buf.length) buf.set(value, got);
        else { if (buf) { chunks.push(buf.subarray(0, got)); buf = null; } chunks.push(value); }
        got += value.length;
        onProgress?.(got, total);
      }
    } else { const ab = new Uint8Array(await r.arrayBuffer()); chunks.push(ab); got = ab.length; onProgress?.(got, total); }
    if (buf && got < buf.length) throw new LoftLoadError(`the download was cut short (${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB)`);
    if (!buf) { buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; } }
    return buf.buffer;
  } catch (e) {
    if (e.name === 'AbortError') throw new LoftLoadError(why || 'the download was interrupted');
    if (e instanceof TypeError) throw new LoftLoadError(`no connection (${e.message})`);
    throw e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

/**
 * Baked materials → unlit MeshBasicMaterial (the scene's lights then only light the player and the ball). Two kinds:
 *   extras.lm_scale  the baked lighting is the emissive map (UV channel 1): it becomes the light map, × lm_scale · π
 *   extras.vc_scale  the baked lighting is in the mesh's vertex colours (COLOR_0, linear 0…1, divided by vc_scale):
 *                    vertex colours on, the colour factor × vc_scale (above 1 on purpose)
 * Shared materials are converted once. Materials with neither (real emissives: skyline, TV, LED, bulbs, the exit
 * sign) are left as they are.
 * @returns {number} how many materials were converted
 */
export function convertLightmapped(THREE, root) {
  const done = new Map();
  const conv = (m) => {
    if (!m) return m;
    const lm = m.userData?.lm_scale, vc = m.userData?.vc_scale;
    if (lm == null && vc == null) return m;
    if (done.has(m)) return done.get(m);
    const common = { map: m.map, side: m.side, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest };
    let b;
    if (lm != null && m.emissiveMap) {
      b = new THREE.MeshBasicMaterial({ ...common, color: m.color, lightMap: m.emissiveMap, lightMapIntensity: lm * Math.PI });
      b.userData = { ...m.userData, lightmapped: true, baked: 'lightmap' };
    } else if (vc != null) {
      b = new THREE.MeshBasicMaterial({ ...common, color: new THREE.Color(vc * m.color.r, vc * m.color.g, vc * m.color.b), vertexColors: true });
      b.userData = { ...m.userData, lightmapped: true, baked: 'vertex' };
    } else return m;   // (lm_scale without its emissive map: left as it is)
    b.name = m.name;
    done.set(m, b);
    return b;
  };
  root.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material); });
  for (const m of done.keys()) m.dispose();   // (the textures live on in the new materials)
  return done.size;
}

/** Every texture of the room's materials (unique). */
function texturesOf(root) {
  const set = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) for (const k in m) { const t = m[k]; if (t && t.isTexture) set.add(t); }
  });
  return set;
}

/**
 * Textures larger than `max` px drawn down to it (lite devices: GPU memory) — the data maps (normal, roughness,
 * occlusion: not sRGB) to half of it — the full-size image released.
 */
function capTextures(THREE, textures, max) {
  let n = 0;
  for (const t of textures) {
    const im = t.image, w = im?.width, h = im?.height;
    const cap = t.colorSpace === THREE.SRGBColorSpace ? max : Math.max(256, max / 2);
    if (!w || !h || Math.max(w, h) <= cap) continue;
    const k = cap / Math.max(w, h), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    im.close?.();
    t.image = c; t.needsUpdate = true; n++;
  }
  return n;
}

/**
 * The room's lights from the layout, in the room's coordinates (they ride the group): a hemisphere, the low
 * sun (its shadow box over the whole room — the walls keep it to the window's patch), point lights.
 */
export function buildLights(THREE, layout, { quality = 'desktop' } = {}) {
  const L = layout.lights || {}, out = [];
  if (L.hemisphere) { const h = new THREE.HemisphereLight(L.hemisphere.sky, L.hemisphere.ground, L.hemisphere.intensity ?? 1); h.name = 'loft-hemisphere'; out.push(h); }
  let sun = null;
  if (L.sun) {
    sun = new THREE.DirectionalLight(L.sun.color, L.sun.intensity ?? 1);
    sun.name = 'loft-sun';
    sun.position.set(...L.sun.from); sun.target.position.set(...(L.sun.to || [0, 0, 0]));
    // the shadow box: the room's bounds seen from the sun
    const b = layout.camera || layout.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2, cy = (b.maxY || 4) / 2;
    const rad = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ, b.maxY || 6) / 2 + 0.5;
    const d = Math.hypot(L.sun.from[0] - cx, L.sun.from[1] - cy, L.sun.from[2] - cz);
    sun.castShadow = true;
    const s = quality === 'mobile' ? 1024 : 2048;
    sun.shadow.mapSize.set(s, s);
    Object.assign(sun.shadow.camera, { left: -rad, right: rad, top: rad, bottom: -rad, near: Math.max(0.1, d - rad - 1), far: d + rad + 1 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    sun.shadow.autoUpdate = false;   // the room does not move: its shadow is drawn once (the page, without the player)
    out.push(sun, sun.target);
  }
  for (const p of L.points || []) {
    const l = new THREE.PointLight(p.color, p.intensity ?? 1, p.distance ?? 0, p.decay ?? 2);
    l.position.set(...p.pos); l.name = 'loft-point ' + (p.what || ''); out.push(l);
  }
  return { lights: out, sun };
}

/**
 * The loft's bytes: the layout (no-cache: it names the GLB's current version), then the GLB with real progress.
 * Cheap to hold (the file's size) — the page fetches them ahead while the player is elsewhere.
 * @returns {Promise<{ layout, buffer: ArrayBuffer, ms: number }>}
 */
export async function fetchLoft({ layoutUrl = '/courts/loft-layout.json', onProgress = null, signal = null } = {}) {
  const t0 = performance.now();
  onProgress?.('layout', 0, 0);
  let layout;
  {
    let r;
    try { r = await fetch(layoutUrl, { credentials: 'same-origin', signal, cache: 'no-cache' }); } catch (e) { throw new LoftLoadError(`no connection (${e.message})`); }
    if (!r.ok) throw new LoftLoadError(`the loft's layout is missing (HTTP ${r.status})`);
    try { layout = await r.json(); } catch { throw new LoftLoadError('the loft\'s layout is not valid'); }
    if (!layout?.bounds || !layout?.spawn) throw new LoftLoadError('the loft\'s layout has no bounds / spawn');
  }
  const glbUrl = layout.glb?.url || '/courts/loft.glb';
  const buffer = await fetchBuffer(glbUrl, { onProgress: (g, t) => onProgress?.('download', g, t), signal, expectBytes: layout.glb?.bytes || 0 });
  return { layout, buffer, ms: Math.round(performance.now() - t0) };
}

/**
 * The loft from its bytes: Draco-decoded, materials prepared (lightmaps, shadows, anisotropy, a texture cap on
 * lite devices), lights built. Nothing is added to any scene: the page swaps it in when it is complete. This is
 * where the textures are decoded (~1.1 GB for the full-size set until they are on the GPU: releaseCpuImages).
 * @param {object} o { THREE, GLTFLoader, DRACOLoader, renderer, layout, buffer, onProgress(phase, got, total), maxTexture, quality }
 */
export async function buildLoft(o) {
  const { THREE, GLTFLoader, DRACOLoader, renderer, layout, buffer, onProgress = null, maxTexture = Infinity, quality = 'desktop' } = o;
  const tDl = performance.now();
  onProgress?.('unpack', buffer.byteLength, buffer.byteLength);
  const magic = new Uint8Array(buffer, 0, 4);
  if (String.fromCharCode(...magic) !== 'glTF') throw new LoftLoadError('the loft file is not a GLB');
  const draco = new DRACOLoader().setDecoderPath('/vendor/draco/').setDecoderConfig({ type: 'wasm' });
  let gltf;
  try {
    gltf = await new GLTFLoader().setDRACOLoader(draco).parseAsync(buffer, '/courts/');
  } catch (e) { throw new LoftLoadError(`the loft file could not be read (${e.message || e})`); }
  finally { draco.dispose(); }
  const tParse = performance.now();
  const root = gltf.scene;
  root.name = 'Loft';
  const before = texturesOf(root);
  const lightmapped = convertLightmapped(THREE, root);
  const baked = { lightmap: 0, vertex: 0 };
  { const seen = new Set(); root.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.userData?.baked && !seen.has(m)) { seen.add(m); baked[m.userData.baked]++; } }); }
  // the room's own captured environment (the page's captureEnvironment) is one point's view of it: its
  // reflections have no parallax — a near-mirror coat (the floor's: roughness 0.04) would show the window
  // as a sharp patch in the wrong place, so coats are kept a little satin; how much of it lights the room's
  // surfaces (three r160 has no scene-wide environment intensity: per material)
  const envI = layout.environmentIntensity ?? 0.8;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.isMeshStandardMaterial) continue;
      m.envMapIntensity = envI;
      if (m.clearcoat > 0) m.clearcoatRoughness = Math.max(m.clearcoatRoughness, 0.22);
    }
  });
  const textures = texturesOf(root);
  // (the baked materials are unlit: the GLB's normal / roughness maps they had are never drawn — let them go now)
  // (a texture shares its image with its clones — another transform of the same picture: only an image no used
  // texture shows is closed)
  let unusedMB = 0;
  const usedSrc = new Set([...textures].map((t) => t.source));
  for (const t of before) if (!textures.has(t)) {
    const im = t.image;
    if (!usedSrc.has(t.source) && typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap && im.width) { unusedMB += (im.width * im.height * 4) / 1e6; im.close(); }
    t.dispose();
  }
  const capped = Number.isFinite(maxTexture) ? capTextures(THREE, textures, maxTexture) : 0;
  const aniso = Math.min(quality === 'mobile' ? 4 : 16, renderer.capabilities.getMaxAnisotropy());
  for (const t of textures) t.anisotropy = aniso;
  let tris = 0, meshes = 0;
  const occluders = [], boxes = [];
  root.updateMatrixWorld(true);
  root.traverse((m) => {
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry, n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    tris += n;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const glow = mats.every((q) => q.userData?.lightmapped ? false : (q.emissive && q.emissive.getHex() !== 0 && (q.emissiveIntensity ?? 1) > 0 && !q.map));
    const bb = new THREE.Box3().setFromObject(m), size = bb.getSize(new THREE.Vector3());
    const huge = Math.max(size.x, size.z) > 40;   // (the skyline backdrop far outside)
    m.castShadow = !glow && !huge && size.y > 0.02;
    m.receiveShadow = !huge;
    // the camera stays out of solid things: the room's shell and big low-poly parts (mesh tests) and the
    // dense scanned furniture (its box)
    // (thin posts, cables and balusters would make it jump as they pass)
    const mid = [size.x, size.y, size.z].sort((a, b) => a - b)[1];
    if (huge || Math.max(size.x, size.y, size.z) < 0.35 || size.y < 0.05 || mid < 0.12) return;
    if (n <= 3000) occluders.push(m); else boxes.push(bb);
  });
  const sky = addSkyDome(THREE, { layout, root });
  if (sky) { sky.castShadow = false; sky.receiveShadow = false; }
  const { lights, sun } = buildLights(THREE, layout, { quality });
  const group = new THREE.Group();
  group.name = 'LoftWorld';
  group.add(root, ...lights);
  // (the GLB's bytes are not kept: the parser holds them — only the scene it made)
  return {
    layout, root, group, lights, sun, occluders, boxes, textures,
    stats: { bytes: buffer.byteLength, meshes, tris: Math.round(tris), textures: textures.size, capped, lightmapped, baked, unusedMB: Math.round(unusedMB), gpuMB: Math.round([...textures].reduce((a, t) => a + (t.image?.width || 0) * (t.image?.height || 0) * 4 * 1.33, 0) / 1e6), occluders: occluders.length, boxes: boxes.length,
      ms: { download: o.fetchMs ?? null, parse: Math.round(tParse - tDl), build: Math.round(performance.now() - tDl) } },
  };
}

/** Both: fetch, then build. */
export async function loadLoft(o) {
  const f = await fetchLoft(o);
  return buildLoft({ ...o, layout: f.layout, buffer: f.buffer, fetchMs: f.ms });
}

/**
 * The sky past the city backdrop: a dome from the layout's water colour at the horizon to its sky colour
 * (background) overhead — vertex colours, unlit, not tone mapped (the colours show as given), behind
 * everything. In the room's coordinates (it rides the group).
 * @returns {THREE.Mesh|null}
 */
export function addSkyDome(THREE, loft, { radius = 180 } = {}) {
  const L = loft.layout;
  if (!L.background || !L.water) return null;
  const g = new THREE.SphereGeometry(radius, 48, 24), pos = g.attributes.position;
  const top = new THREE.Color(L.background), low = new THREE.Color(L.water), c = new THREE.Color();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / radius / 0.45));   // (0 at the horizon and below, 1 from ~27° up)
    c.copy(low).lerp(top, t * t * (3 - 2 * t));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, toneMapped: false, fog: false }));
  m.name = 'loft-sky'; m.renderOrder = -10; m.frustumCulled = false;
  const b = L.bounds; m.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  loft.root.add(m);
  return m;
}

/**
 * Once every texture of the room is on the GPU, the decoded copies in memory are let go (ImageBitmaps: about
 * 1.1 GB for the full-size set; a lite device's canvases). The room's textures never change, so they are never
 * uploaded again (a lost WebGL context would need a reload).
 * @returns {number} MB released
 */
export function releaseCpuImages(renderer, loft) {
  let bytes = 0;
  for (const t of loft.textures || []) renderer.initTexture(t);   // (uploads any not drawn yet)
  for (const t of loft.textures || []) {
    const im = t.image;
    if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap && im.width) { bytes += im.width * im.height * 4; im.close(); }
    // (a lite device's drawn-down copies: their canvases shrunk to nothing)
    else if (typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement && im.width > 1) { bytes += im.width * im.height * 4; im.width = im.height = 1; }
  }
  return Math.round(bytes / 1e6);
}

/**
 * The polished floor's gloss: a planar reflection (three's Reflector) laid over the mesh named "floor" ("lm-floor"),
 * added (not blended over) and weighted by Fresnel — a few percent looking down at it, more toward grazing,
 * as a coated concrete floor does. Everything on the floor (the rug, furniture feet) stays in front of it.
 * Desktop only (it draws the room a second time per frame).
 * @returns {THREE.Mesh|null}
 */
export function addFloorMirror(THREE, Reflector, loft, { resolution = 1024, amount = 1, f0 = 0.04 } = {}) {
  let floor = null;
  loft.root.traverse((o) => { if (!floor && o.isMesh && /^(lm-)?floor$/.test(o.name)) floor = o; });   // (the baked file: "lm-floor")
  if (!floor) return null;
  // (the floor's box in the room's own coordinates — the group may already stand at its place in the world)
  loft.root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(loft.root.matrixWorld).invert().multiply(floor.matrixWorld);
  if (!floor.geometry.boundingBox) floor.geometry.computeBoundingBox();
  const bb = floor.geometry.boundingBox.clone().applyMatrix4(toRoot);
  const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z;
  const k = resolution / Math.max(w, d);
  const m = new Reflector(new THREE.PlaneGeometry(w, d), { textureWidth: Math.round(w * k), textureHeight: Math.round(d * k), clipBias: 0.003, color: 0xffffff });
  m.name = 'loft-floor-mirror';
  m.rotation.x = -Math.PI / 2;
  m.position.set((bb.min.x + bb.max.x) / 2, bb.max.y + 0.001, (bb.min.z + bb.max.z) / 2);
  const mat = m.material;
  mat.transparent = true; mat.depthWrite = false; mat.blending = THREE.AdditiveBlending;
  mat.polygonOffset = true; mat.polygonOffsetFactor = -4; mat.polygonOffsetUnits = -4;
  mat.uniforms.amount = { value: amount }; mat.uniforms.f0 = { value: f0 };
  mat.vertexShader = mat.vertexShader
    .replace('uniform mat4 textureMatrix;', 'uniform mat4 textureMatrix;\nvarying vec3 vMirrorWorld;')
    .replace('vUv = textureMatrix * vec4( position, 1.0 );', 'vUv = textureMatrix * vec4( position, 1.0 );\nvMirrorWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;');
  mat.fragmentShader = mat.fragmentShader
    .replace('uniform vec3 color;', 'uniform vec3 color;\nuniform float amount;\nuniform float f0;\nvarying vec3 vMirrorWorld;')
    .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
      'float c = clamp( normalize( cameraPosition - vMirrorWorld ).y, 0.0, 1.0 );\n\tfloat F = f0 + ( 1.0 - f0 ) * pow( 1.0 - c, 5.0 );\n\tgl_FragColor = vec4( base.rgb * color * F * amount, 1.0 );');
  m.renderOrder = 2;
  loft.root.add(m);
  return m;
}

/**
 * The room's own environment (reflections, the character's ambient light): a cube captured inside it with
 * its lights, prefiltered. Rendered in a scene of its own — the game's scene is never touched.
 * @returns {THREE.Texture}
 */
export function captureEnvironment(THREE, renderer, loft, { at = [1.5, 1.7, -3.5], size = 256, background = null } = {}) {
  const tmp = new THREE.Scene();
  if (background) tmp.background = new THREE.Color(background);
  const parent = loft.group.parent;
  tmp.add(loft.group);
  const p0 = loft.group.position.clone();
  loft.group.position.set(0, 0, 0);
  loft.group.updateMatrixWorld(true);
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.05, 200, rt);
  cube.position.set(...at);
  tmp.add(cube);
  const tm = renderer.toneMapping;
  try {
    if (loft.sun) loft.sun.shadow.needsUpdate = true;
    cube.update(renderer, tmp);
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromCubemap(rt.texture).texture;
    pm.dispose();
    return env;
  } finally {
    renderer.toneMapping = tm;
    rt.dispose();
    tmp.remove(loft.group);
    loft.group.position.copy(p0);
    if (parent) parent.add(loft.group);
    loft.group.updateMatrixWorld(true);
    if (loft.sun) loft.sun.shadow.needsUpdate = true;   // (drawn again at its place in the game world)
  }
}
