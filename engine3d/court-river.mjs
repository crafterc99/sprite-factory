/**
 * The River practice court (court3d.html ?court=river): an overgrown waterfront court at sunset —
 * assets/courts/river.glb + river-layout.json, a replica of the user's painting (assets/court-river/renders/).
 *
 * The GLB is authored in exactly the frame of assets/courts/vantheah.glb (the same court along the same axis, rims
 * at court-x ±12.425 / 3.05 m, regulation boards at ±12.8, the regulation rims / nets / mounts and the sunset dome
 * copied from it), so it is placed by the VANTHEAH court's own transform (engine3d/court-vantheah.mjs: −90° about
 * y, +12.425 m in z — `frame` below is that module): the West rim lands on the game's hoop (0, 3.05, 0) and the
 * game keeps VANTHEAH's hoop physics. Everything else that is solid comes from the layout (glTF axes, like the GLB):
 *   bounds     the walkable rectangle (where the player's centre may go)
 *   colliders  AABBs — the ball's statics (Rapier) and, for what is body high, the player's push-out (the loft's
 *              constrainDisc, engine3d/loft.mjs)
 *   lights     sun (toward the sun; real shadows, the shadow box fitted to the court), a warm frontal "glow"
 *              (no shadow), hemisphere, exposure, AgX
 *   fog        linear fog;  renderCamera: the reference photo's camera (pos, lookAt, vertical fov)
 *
 * Look (the Cycles render replica-cycles.png is the target): the sky dome and the city backdrop unlit; an
 * environment captured from the court's own sky / backdrop / walls (the floor and the player left out) lights
 * and reflects in the wet clearcoat asphalt; on desktop a planar reflection (three's Reflector) over the court
 * adds a Fresnel wet sheen and turns the puddles into near-mirrors (they sample its picture); lite devices: no
 * reflector (the puddles mirror the captured environment), smaller shadow map, smaller environment.
 *
 * Plain math (the layout → game space, the player's world, the ball's boxes) has no three.js in it —
 * tests/river.test.js; THREE, the loaders, Reflector and the frame are passed in to the rest.
 */
import { fetchBuffer, LoftLoadError } from './loft.mjs';

export const RIVER_LAYOUT_URL = '/courts/river-layout.json';
/** Which part of the body the player's push-out cares about (m): a box entirely below or above is walked under / over. */
export const BODY_Y = [0.05, 1.9];
/**
 * The loft's door on this court (game space): a stair-house against the left graffiti wall in the waterfront
 * corner, behind the left end of the West baseline, its door facing the court (+x). Clear of the bleachers, the
 * vines on the barrier and the "DREAMS BUILD REALITY" lettering; at the edge of the 2K camera's view from the
 * start. x / z: the middle of the door's face at the floor; yaw: the way it faces (0 = +z, the game's yaw).
 */
export const RIVER_DOOR = { x: -16.8, z: -6.05, yaw: Math.PI / 2 };

/**
 * The look, calibrated against replica-cycles.png (the same scene path traced in Cycles, from the reference camera;
 * region means compared — the river-court spec's side-by-side). What path tracing gives and direct lights + one
 * captured environment do not — the emissive sky and city lighting every prop from all around, light bouncing off
 * the court — is made up by the props' environment (×1.4), the frontal glow (×1.6) and the hemisphere (×1.15); three's
 * AgX (+ the page's grade) draws the same picture a little brighter than Blender's (exposure ×0.86, the city picture
 * ×0.86). The wet asphalt: its clearcoat's environment (0.85) over a
 * duller base layer (specular ×0.45: its broad lobe spread the sky's blue over the whole court), a faint planar sheen
 * (0.08); the puddles: near-mirrors.
 */
export const LOOK = { envProp: 1.4, envFloor: 0.85, asphaltSpecular: 0.45, sheen: 0.08, puddle: 0.9, glow: 1.6, hemi: 1.15, exposure: 0.86, picture: 0.86 };
/**
 * The layout's light colours are the Cycles scene's linear RGB written as hex: read as such (three reads a hex
 * string as sRGB, which made every light far too saturated — the floor came out magenta against the render).
 */
export function linearHex(THREE, hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return new THREE.Color().setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.LinearSRGBColorSpace);
}

/** A glTF-space AABB → game space (still axis aligned: the frame turns 90°). */
export function aabbToGame(frame, min, max) {
  const a = frame.toGame(min), b = frame.toGame(max);
  return { min: a.map((v, k) => Math.min(v, b[k])), max: a.map((v, k) => Math.max(v, b[k])) };
}
/** A glTF-space direction → game space (the frame's turn, no offset). */
export const dirToGame = (frame, d) => { const o = frame.toGame([0, 0, 0]), p = frame.toGame(d); return p.map((v, k) => v - o[k]); };

/**
 * The layout's colliders in game space: { name, min, max } (min / max: [x, y, z]). `overrides` (game space, by name):
 * boxes measured from the GLB itself that replace a layout box of that name (or are added): the hoop poles.
 */
export function collidersToGame(layout, frame, overrides = {}) {
  const out = (layout.colliders || []).map((c) => (overrides[c.name] ? { name: c.name, ...overrides[c.name] } : { name: c.name, ...aabbToGame(frame, c.min, c.max) }));
  for (const [name, b] of Object.entries(overrides)) if (!out.some((c) => c.name === name)) out.push({ name, ...b });
  return out;
}

/**
 * The player's world in game space, as the loft's constrainDisc takes it: the walkable rectangle and the
 * footprints of what is body high inside (or next to) it — the bleachers, the rubble, the hoop poles, the curb,
 * the floodlight poles. `extra`: more footprints (the loft door's stair-house).
 */
export function riverWorld(layout, frame, { extra = [], overrides = {} } = {}) {
  const B = aabbToGame(frame, layout.bounds.min, layout.bounds.max);
  const bounds = { minX: B.min[0], maxX: B.max[0], minZ: B.min[2], maxZ: B.max[2] };
  const colliders = [];
  for (const c of collidersToGame(layout, frame, overrides)) {
    if (c.max[1] <= BODY_Y[0] || c.min[1] >= BODY_Y[1]) continue;
    // (beyond the walls — the trees across the quay: never reached)
    if (c.max[0] < bounds.minX - 1 || c.min[0] > bounds.maxX + 1 || c.max[2] < bounds.minZ - 1 || c.min[2] > bounds.maxZ + 1) continue;
    colliders.push({ name: c.name, minX: c.min[0], maxX: c.max[0], minZ: c.min[2], maxZ: c.max[2] });
  }
  return { bounds, colliders: colliders.concat(extra) };
}

/** Kind / bounce of a layout collider for the ball. */
export function ballKind(name) {
  if (/fence/.test(name)) return { kind: 'fence', restitution: 0.25 };
  if (/wall|barrier|curb|quay/.test(name)) return { kind: 'wall', restitution: 0.3 };
  if (/hoop-pole/.test(name)) return { kind: 'stanchion', restitution: 0.3 };
  return { kind: 'props', restitution: 0.3 };
}

/**
 * The ball's static boxes (game space, Rapier cuboids): every layout collider that stands above the floor (the
 * quay's top is the floor — the physics' own plane), cut back out of the rims' rings (a box that reaches into
 * a ring — the hoop pole's — must not close the hole a made shot drops through: frame.clipOutOfRings).
 * @returns {{ name, center, half, kind, restitution }[]}
 */
export function riverBallBoxes(layout, frame, overrides = {}) {
  const out = [];
  for (const c of collidersToGame(layout, frame, overrides)) {
    if (c.max[1] <= 0.001) continue;
    const lo = c.min.slice(), hi = c.max.slice();
    lo[1] = Math.max(lo[1], 0);
    frame.clipOutOfRings(lo, hi);
    if (!(hi[0] > lo[0] && hi[1] > lo[1] && hi[2] > lo[2])) continue;
    out.push({ name: c.name, center: lo.map((v, k) => (v + hi[k]) / 2), half: lo.map((v, k) => (hi[k] - v) / 2), ...ballKind(c.name) });
  }
  return out;
}

/** The stair-house footprint (game space) of a door at d = { x, z, yaw } with the house `depth` deep, `width` wide. */
export function doorFootprint(d, { depth = 1.5, width = 2.2 } = {}) {
  const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), rx = fz, rz = -fx;   // facing, and along the face
  const cx = d.x - fx * depth / 2, cz = d.z - fz * depth / 2;
  const hx = Math.abs(rx) * width / 2 + Math.abs(fx) * depth / 2, hz = Math.abs(rz) * width / 2 + Math.abs(fz) * depth / 2;
  return { name: 'loft-door', minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
}

/**
 * The reference photo's camera in game space: { pos, look, fov } (vertical fov, degrees) — the view
 * replica-cycles.png was rendered from.
 */
export function renderCameraToGame(layout, frame) {
  const c = layout.renderCamera;
  return c ? { pos: frame.toGame(c.pos), look: frame.toGame(c.lookAt), fov: c.fovV } : null;
}

// ═══ Loading ═══

/** The layout (no-cache: it names the GLB's current version), then the GLB with real progress. */
export async function fetchRiver({ layoutUrl = RIVER_LAYOUT_URL, onProgress = null, signal = null } = {}) {
  let r, layout;
  try { r = await fetch(layoutUrl, { credentials: 'same-origin', signal, cache: 'no-cache' }); } catch (e) { throw new LoftLoadError(`no connection (${e.message})`); }
  if (!r.ok) throw new LoftLoadError(`the river court's layout is missing (HTTP ${r.status})`);
  try { layout = await r.json(); } catch { throw new LoftLoadError('the river court\'s layout is not valid'); }
  if (!layout?.bounds || !layout?.colliders) throw new LoftLoadError('the river court\'s layout has no bounds / colliders');
  const buffer = await fetchBuffer(layout.glb?.url || '/courts/river.glb', { onProgress, signal, expectBytes: layout.glb?.bytes || 0 });
  return { layout, buffer };
}

/** The floor's layers lie 0–10 mm apart (the ground's top is at 0, the keys on it): a fixed depth priority each. */
const FLOOR_LAYERS = [[/^puddle-/, -8], [/^center-crown/, -6], [/^COURT_Painted_Lines/, -6], [/^Paint_Key/, -2], [/^ground$/, 0]];
const layerOf = (name) => { for (const [re, o] of FLOOR_LAYERS) if (re.test(name)) return o; return null; };
const FLOOR_RE = /^(ground|Paint_Key|COURT_Painted_Lines|COURT_Markings_Decal|center-crown|puddle-)/;
/**
 * Never in a shadow (casting): the sky, the backdrop, the water, the floor, the see-through chain-link, the far
 * blocks — and what is thin: the fence posts, the vine curtains, the weeds. From a sun 2.75° up their shadows ran as
 * hard stripes across the whole court, through the sun's glint on the wet asphalt (a real sun's disc blurs a 10 cm
 * shadow away within ~10 m; the render has none) — and they were most of the shadow pass's triangles.
 */
const NO_CAST_RE = /^(ENV_|backdrop|river|quay|ground|Paint_Key|COURT_|center-crown|puddle-|fence-|Cube|Cylinder|River_Posts|inst-06-vine|inst-03-weeds)/;
/** Many small separate meshes of one material (the fence posts, the bridge's piers): merged, one draw call each material. */
const MERGE_RE = /^(Cylinder|Cube)\.?\d*$/;   // (three's loader drops the dot: Cylinder.001 → Cylinder001)

/**
 * Meshes (non-instanced, same material, same attributes) merged into one per material, in the root's own
 * coordinates (indexed or not, the result indexed). Returns the new meshes.
 */
function mergeByMaterial(THREE, root, test) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), groups = new Map();
  root.traverse((m) => { if (m.isMesh && !m.isInstancedMesh && !Array.isArray(m.material) && test(m.name)) { const k = m.material.uuid + '|' + Object.keys(m.geometry.attributes).sort().join(','); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); } });
  const out = [], M = new THREE.Matrix4(), N = new THREE.Matrix3();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const names = Object.keys(list[0].geometry.attributes);
    let nv = 0, ni = 0;
    for (const m of list) { nv += m.geometry.attributes.position.count; ni += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count; }
    const attrs = Object.fromEntries(names.map((n) => [n, new Float32Array(nv * list[0].geometry.attributes[n].itemSize)]));
    const index = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
    let vo = 0, io = 0;
    for (const m of list) {
      const g = m.geometry, cnt = g.attributes.position.count;
      M.multiplyMatrices(inv, m.matrixWorld); N.getNormalMatrix(M);
      for (const n of names) {
        const a = g.attributes[n], s = a.itemSize, dst = attrs[n], v = new THREE.Vector3();
        for (let i = 0; i < cnt; i++) {
          if (n === 'position') { v.fromBufferAttribute(a, i).applyMatrix4(M); dst.set([v.x, v.y, v.z], (vo + i) * 3); }
          else if (n === 'normal') { v.fromBufferAttribute(a, i).applyMatrix3(N).normalize(); dst.set([v.x, v.y, v.z], (vo + i) * 3); }
          else for (let c = 0; c < s; c++) dst[(vo + i) * s + c] = a.getComponent(i, c);
        }
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) index[io++] = g.index.getX(i) + vo; else for (let i = 0; i < cnt; i++) index[io++] = vo + i;
      vo += cnt;
    }
    const geo = new THREE.BufferGeometry();
    for (const n of names) geo.setAttribute(n, new THREE.BufferAttribute(attrs[n], list[0].geometry.attributes[n].itemSize, list[0].geometry.attributes[n].normalized));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, list[0].material);
    mesh.name = 'River_Posts:' + list[0].material.name;
    for (const m of list) { m.parent.remove(m); m.geometry.dispose(); }
    root.add(mesh);
    out.push(mesh);
  }
  return out;
}
/** Kept out of the planar reflection (small, many, at the walls — the reflection pass is a second full draw). */
const NO_REFLECT_RE = /^inst-03-weeds/;
export const REFLECT_HIDDEN_LAYER = 1;

/** The water of the puddles, desktop: the reflector's picture (a near-mirror) over the dark water, the GLB's alpha shape. */
function puddleMirrorMaterial(THREE, src, reflect) {
  const m = new THREE.MeshBasicMaterial({ map: src.map, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  m.name = src.name + ' (mirror)';
  m.userData.water = true;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tReflect = { value: reflect.texture };
    sh.uniforms.reflMatrix = { value: reflect.worldMatrix };
    sh.uniforms.waterColor = { value: new THREE.Color(0.018, 0.016, 0.03) };
    sh.uniforms.reflAmount = reflect.puddleAmount;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 reflMatrix;\nvarying vec4 vReflUv;\nvarying vec3 vReflWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvec4 rW = modelMatrix * vec4( transformed, 1.0 );\n\tvReflUv = reflMatrix * rW;\n\tvReflWorld = rW.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nuniform vec3 waterColor;\nuniform float reflAmount;\nvarying vec4 vReflUv;\nvarying vec3 vReflWorld;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tvec3 rc = texture2DProj( tReflect, vReflUv ).rgb;\n\tfloat rcos = clamp( normalize( cameraPosition - vReflWorld ).y, 0.0, 1.0 );\n\tfloat rF = 0.02 + 0.98 * pow( 1.0 - rcos, 5.0 );\n\tdiffuseColor.rgb = mix( waterColor, rc, clamp( reflAmount * ( 0.82 + 0.18 * rF ), 0.0, 1.0 ) );');
  };
  m.customProgramCacheKey = () => 'river-puddle-mirror';
  return m;
}
/** The water of the puddles, lite: a near-mirror of the captured environment. */
function puddleEnvMaterial(THREE, src) {
  const m = new THREE.MeshStandardMaterial({ map: src.map, color: new THREE.Color(0.86, 0.8, 0.92), metalness: 1, roughness: 0.035, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1 });
  m.name = src.name + ' (env mirror)';
  m.userData.water = true;
  return m;
}

/**
 * The wet sheen over the court: a planar reflection (three's Reflector) on the walkable rectangle, added (not
 * blended over) and weighted by Fresnel — a little looking down at it, more toward grazing, as a wet film does.
 * Its picture is also the puddles' (puddleMirrorMaterial): `reflect.worldMatrix` maps a world point on the floor
 * to it (the Reflector's texture matrix × its inverse model matrix, updated as it draws). The floor and the puddles
 * are not drawn into it (a texture never samples itself), nor the many small weeds (layer REFLECT_HIDDEN_LAYER).
 */
function addWetReflector(THREE, Reflector, { scene, renderer, bounds, sheen = LOOK.sheen, resolution = 0.5, hideDuring = [] }) {
  const w = bounds.maxX - bounds.minX + 2, d = bounds.maxZ - bounds.minZ + 2;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const tw = Math.max(256, Math.round(size.x * resolution)), th = Math.max(256, Math.round(size.y * resolution));
  const m = new Reflector(new THREE.PlaneGeometry(w, d), { textureWidth: tw, textureHeight: th, clipBias: 0.003, color: 0xffffff, multisample: 0 });
  m.name = 'River_Wet_Reflection';
  m.rotation.x = -Math.PI / 2;
  m.position.set((bounds.minX + bounds.maxX) / 2, 0.002, (bounds.minZ + bounds.maxZ) / 2);
  m.camera.layers.disableAll(); m.camera.layers.enable(0);   // (the reflection's camera: not the weeds' layer)
  const mat = m.material;
  mat.transparent = true; mat.depthWrite = false; mat.blending = THREE.AdditiveBlending; mat.fog = false;
  mat.polygonOffset = true; mat.polygonOffsetFactor = -4; mat.polygonOffsetUnits = -4;
  mat.uniforms.amount = { value: sheen }; mat.uniforms.f0 = { value: 0.025 };
  mat.vertexShader = mat.vertexShader
    .replace('uniform mat4 textureMatrix;', 'uniform mat4 textureMatrix;\nvarying vec3 vMirrorWorld;')
    .replace('vUv = textureMatrix * vec4( position, 1.0 );', 'vUv = textureMatrix * vec4( position, 1.0 );\nvMirrorWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;');
  mat.fragmentShader = mat.fragmentShader
    .replace('uniform vec3 color;', 'uniform vec3 color;\nuniform float amount;\nuniform float f0;\nvarying vec3 vMirrorWorld;')
    .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
      'float c = clamp( normalize( cameraPosition - vMirrorWorld ).y, 0.0, 1.0 );\n\tfloat F = f0 + ( 1.0 - f0 ) * pow( 1.0 - c, 5.0 );\n\tgl_FragColor = vec4( base.rgb * color * F * amount, 1.0 );');
  m.renderOrder = 3;
  scene.add(m);
  m.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(m.matrixWorld).invert();
  const tm = mat.uniforms.textureMatrix.value;
  const reflect = { mesh: m, texture: m.getRenderTarget().texture, worldMatrix: new THREE.Matrix4(), puddleAmount: { value: LOOK.puddle }, sheen: mat.uniforms.amount, frames: 0 };
  const draw = m.onBeforeRender;
  m.onBeforeRender = function (r, s, cam, ...rest) {
    const hid = hideDuring.filter((o) => o.visible);
    for (const o of hid) o.visible = false;
    try { draw.call(this, r, s, cam, ...rest); } finally { for (const o of hid) o.visible = true; }
    reflect.worldMatrix.multiplyMatrices(tm, inv);
    reflect.frames++;
  };
  /** The picture's size follows the canvas (it is sampled in screen space). */
  reflect.resize = () => {
    renderer.getDrawingBufferSize(size);
    m.getRenderTarget().setSize(Math.max(256, Math.round(size.x * resolution)), Math.max(256, Math.round(size.y * resolution)));
  };
  return reflect;
}

/**
 * An ortho shadow box for a directional light, fitted to a world box (the receivers: the court and what stands on
 * it): its sides from the box seen from the light, its near plane `reach` metres further toward the light (the
 * casters between the court and the sun: the floodlights and trees behind the waterfront).
 */
export function fitShadow(THREE, light, box, { reach = 45, pad = 0.5 } = {}) {
  light.updateMatrixWorld(true); light.target.updateMatrixWorld(true);
  const cam = new THREE.OrthographicCamera();   // (a camera: lookAt turns its −z to the target, up = +y — as the light's shadow camera)
  cam.position.setFromMatrixPosition(light.matrixWorld);
  cam.lookAt(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld));
  cam.updateMatrixWorld(true);
  const view = new THREE.Matrix4().copy(cam.matrixWorld).invert(), p = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  // (the camera looks down −z: near = −max z, far = −min z)
  Object.assign(light.shadow.camera, { left: x0 - pad, right: x1 + pad, bottom: y0 - pad, top: y1 + pad, near: Math.max(0.1, -z1 - reach), far: -z0 + pad });
  light.shadow.camera.updateProjectionMatrix();
  return { width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad, depth: z1 - z0 + reach };
}

/**
 * Load the court into the scene (fetch → Draco → the VANTHEAH frame → materials → lights, fog, environment,
 * reflection). Nothing of the old court is touched: the page hides it.
 * @param {object} o { THREE, GLTFLoader, DRACOLoader, Reflector (null: none), frame (court-vantheah.mjs), scene,
 *   renderer, quality: 'desktop'|'mobile', hide: objects kept out of the environment capture (the player, the
 *   ball), onProgress(phase, got, total) }
 */
export async function loadRiverCourt(o) {
  const { THREE, GLTFLoader, DRACOLoader, Reflector = null, frame, scene, renderer, quality = 'desktop', hide = [], onProgress = null } = o;
  const t0 = performance.now();
  const { layout, buffer } = await fetchRiver({ onProgress: (g, t) => onProgress?.('download', g, t) });
  const tDl = performance.now();
  onProgress?.('unpack', buffer.byteLength, buffer.byteLength);
  const draco = new DRACOLoader().setDecoderPath('/vendor/draco/').setDecoderConfig({ type: 'wasm' });
  let gltf;
  try { gltf = await new GLTFLoader().setDRACOLoader(draco).parseAsync(buffer, '/courts/'); }
  catch (e) { throw new LoftLoadError(`the river court file could not be read (${e.message || e})`); }
  finally { draco.dispose(); }
  const tParse = performance.now();
  const lite = quality === 'mobile';
  const root = gltf.scene;
  root.name = 'River_Court';
  // the VANTHEAH court's own placement (court-vantheah.mjs loadVantheahCourt): glb (x, y, z) → game (−z, y, x + offsetZ)
  root.rotation.y = -Math.PI / 2;
  root.position.set(0, 0, frame.VANTHEAH.offsetZ);
  scene.add(root);
  root.updateMatrixWorld(true);
  const merged = mergeByMaterial(THREE, root, (n) => MERGE_RE.test(n));
  const named = {}, floor = [], puddles = [], instanced = [];
  root.traverse((m) => { if (m.name) named[m.name] = m; });
  const overrides = measureHoopPoles(THREE, named['inst-hoop'], frame);
  const aniso = Math.min(lite ? 4 : 16, renderer.capabilities.getMaxAnisotropy());
  const envI = { prop: LOOK.envProp, floor: LOOK.envFloor, water: 1.0 };
  root.traverse((m) => {
    if (!m.isMesh) return;
    if (m.isInstancedMesh) instanced.push(m);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    m.castShadow = !NO_CAST_RE.test(m.name);
    m.receiveShadow = !/^(ENV_|backdrop|river)/.test(m.name);
    if (FLOOR_RE.test(m.name)) floor.push(m);
    if (NO_REFLECT_RE.test(m.name)) m.layers.set(REFLECT_HIDDEN_LAYER);
    for (const mt of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (mt[k]) mt[k].anisotropy = aniso;
      if (mt.isMeshStandardMaterial) mt.envMapIntensity = FLOOR_RE.test(m.name) ? envI.floor : envI.prop;
    }
    const lo = layerOf(m.name);
    if (lo != null) {
      m.material = Array.isArray(m.material) ? m.material.map((q) => q.clone()) : m.material.clone();
      for (const q of Array.isArray(m.material) ? m.material : [m.material]) { q.polygonOffset = lo !== 0; q.polygonOffsetFactor = lo; q.polygonOffsetUnits = lo; }
      m.renderOrder = -lo;
    }
    if (/^puddle-/.test(m.name)) puddles.push(m);
  });
  // the sky and the city: unlit (their pictures are the light), past the fog
  for (const name of ['ENV_Sunset_Dome', 'backdrop']) {
    const m = named[name]; if (!m?.isMesh) continue;
    const src = m.material, map = src.emissiveMap || src.map;
    const e = src.emissive ? Math.max(src.emissive.r, src.emissive.g, src.emissive.b) : 1;
    const k = name === 'backdrop' ? e * LOOK.picture : e;
    m.material = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(k, k, k), side: src.side, fog: false });
    m.material.name = src.name + ' (unlit)';
    m.castShadow = m.receiveShadow = false; m.frustumCulled = false;
    if (name === 'ENV_Sunset_Dome') m.renderOrder = -20;
    src.dispose();
  }
  // the painted city (a flat picture of sky, skyline and water) ends in hard edges against VANTHEAH's sunset dome
  // wherever the game's camera sees past it (higher and wider than the photo's): the picture fades out at its top
  // and sides into a dome painted from its own sky (paintSky)
  if (named.backdrop && named.ENV_Sunset_Dome) paintSky(THREE, named.ENV_Sunset_Dome, named.backdrop, layout.lights?.sun?.towardSun || [-1, 0.05, 0]);
  // the painted lines: thin strips alias along their edges at a distance — baked into one mip-mapped decal (as VANTHEAH's)
  const decal = frame.bakeFloorMarkings ? frame.bakeFloorMarkings(root, renderer, quality, named, /^COURT_Painted_Lines/) : null;
  if (decal) { decal.castShadow = false; floor.push(decal); }
  // the wet asphalt: its clearcoat reflects the sunset (the captured environment)
  const asphalt = named.ground?.material;
  if (asphalt?.isMeshPhysicalMaterial) { asphalt.envMapIntensity = envI.floor; asphalt.specularIntensity = LOOK.asphaltSpecular; }
  const river = named.river?.material;
  if (river) { river.envMapIntensity = envI.water; }

  // ── lights (the layout's: glTF axes → game) ──
  const L = layout.lights || {}, group = new THREE.Group();
  group.name = 'River_Lights';
  const B = aabbToGame(frame, layout.bounds.min, layout.bounds.max);
  const centre = new THREE.Vector3((B.min[0] + B.max[0]) / 2, 0, (B.min[2] + B.max[2]) / 2);
  let sun = null, glow = null, hemi = null;
  if (L.hemisphere) { hemi = new THREE.HemisphereLight(linearHex(THREE, L.hemisphere.sky), linearHex(THREE, L.hemisphere.ground), (L.hemisphere.intensity ?? 1) * LOOK.hemi); hemi.name = 'river-hemisphere'; group.add(hemi); }
  if (L.sun) {
    const d = new THREE.Vector3(...dirToGame(frame, L.sun.towardSun)).normalize();
    sun = new THREE.DirectionalLight(linearHex(THREE, L.sun.color), L.sun.intensity ?? 1);
    sun.name = 'river-sun';
    sun.position.copy(centre).addScaledVector(d, 90); sun.target.position.copy(centre);
    sun.castShadow = true;
    // the shadow box: the walled court and what stands on it, seen from the low sun — wide and flat, so the map is too
    sun.shadow.mapSize.set(lite ? 2048 : 4096, lite ? 512 : 1024);
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.045;
    group.add(sun, sun.target);
    const box = new THREE.Box3(new THREE.Vector3(B.min[0] - 0.8, 0, B.min[2] - 0.8), new THREE.Vector3(B.max[0] + 0.8, 11, B.max[2] + 0.8));
    sun.userData.shadowFit = fitShadow(THREE, sun, box);
  }
  if (L.glow) {
    // (the layout gives the way the light travels)
    const d = new THREE.Vector3(...dirToGame(frame, L.glow.direction)).normalize();
    glow = new THREE.DirectionalLight(linearHex(THREE, L.glow.color), (L.glow.intensity ?? 1) * LOOK.glow);
    glow.name = 'river-glow';
    glow.position.copy(centre).addScaledVector(d, -60); glow.target.position.copy(centre);
    group.add(glow, glow.target);
  }
  scene.add(group);
  if (layout.fog) scene.fog = new THREE.Fog(layout.fog.color, layout.fog.near ?? 60, layout.fog.far ?? 260);

  // ── the environment: the court's own sky, backdrop, walls and props from its middle (no floor, no player, no water) ──
  const capHide = [...floor, ...puddles, named.river, named.quay, ...hide].filter((q) => q && q.visible);
  const env = captureEnvironment(THREE, renderer, scene, { at: [centre.x, 2.2, centre.z], size: lite ? 128 : 256, hide: capHide, background: layout.envBackground || '#4a3550' });
  scene.environment = env;

  // ── the water of the puddles and the wet sheen (desktop: the planar reflection; lite: the environment) ──
  let reflect = null;
  if (Reflector && !lite) {
    const W = { minX: B.min[0], maxX: B.max[0], minZ: B.min[2], maxZ: B.max[2] };
    // (the floor itself is not drawn into it: at grazing angles the clip plane lets the double-sided asphalt through,
    // which then hides the whole reflection)
    reflect = addWetReflector(THREE, Reflector, { scene, renderer, bounds: W, hideDuring: [...new Set([...floor, ...puddles, named.quay].filter(Boolean))] });
  }
  for (const p of puddles) {
    const src = p.material;
    p.material = reflect ? puddleMirrorMaterial(THREE, src, reflect) : puddleEnvMaterial(THREE, src);
    p.material.polygonOffset = true; p.material.polygonOffsetFactor = p.material.polygonOffsetUnits = -8;
    p.renderOrder = 8; p.castShadow = false; p.receiveShadow = false;
    src.dispose();
  }

  /** Game-space bounds of a named part (null if absent). */
  const boundsOf = (name) => { const q = named[name]; if (!q) return null; const b = new THREE.Box3().setFromObject(q); return b.isEmpty() ? null : b; };
  let tris = 0, meshes = 0;
  root.traverse((m) => { if (!m.isMesh) return; meshes++; const g = m.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += n * (m.isInstancedMesh ? m.count : 1); });
  return {
    kind: 'river', root, gltf, group, named, boundsOf, layout, overrides, sun, glow, hemi, env, reflect, floor, puddles, instanced, decal,
    exposure: (L.exposure ?? 1.1) * LOOK.exposure,
    toneMapping: L.toneMapping || 'AgX',
    stats: { bytes: buffer.byteLength, meshes, merged: merged.map((m) => m.name), instanced: instanced.map((m) => ({ name: m.name, count: m.count })), tris: Math.round(tris), shadow: sun?.userData.shadowFit || null, reflector: !!reflect,
      ms: { download: Math.round(tDl - t0), parse: Math.round(tParse - tDl), build: Math.round(performance.now() - tDl) } },
  };
}

/**
 * The hoops' own poles in game space, from the GLB's hoop model (each instance): the layout's hoop-pole boxes are
 * a rough footprint (1.2 m wide, reaching under the rim's back, where the net hangs) — the model's post stands
 * 0.6 m to the side and 1 m behind the rim. Below 1.9 m: base and post (up to 2.2 m); 2.2–2.9 m: the bracket to
 * the board (behind the board's face — addRiverColliders cuts it there).
 * @returns {object} { 'hoop-pole--1': { min, max }, 'hoop-pole--1:bracket': …, 'hoop-pole-1': …, … }
 */
function measureHoopPoles(THREE, ih, frame) {
  if (!ih?.isInstancedMesh) return {};
  const out = {}, m = new THREE.Matrix4(), v = new THREE.Vector3(), pos = ih.geometry.attributes.position;
  ih.updateMatrixWorld(true);
  for (let k = 0; k < ih.count; k++) {
    ih.getMatrixAt(k, m); m.premultiply(ih.matrixWorld);
    const post = new THREE.Box3(), bracket = new THREE.Box3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); if (v.y < 1.9) post.expandByPoint(v); else if (v.y >= 2.2 && v.y < 2.9) bracket.expandByPoint(v); }
    if (post.isEmpty()) continue;
    const name = (post.min.z + post.max.z) / 2 < frame.VANTHEAH.offsetZ ? 'hoop-pole--1' : 'hoop-pole-1';
    out[name] = { min: [post.min.x, 0, post.min.z], max: [post.max.x, 2.2, post.max.z] };
    if (!bracket.isEmpty()) out[name + ':bracket'] = { min: [bracket.min.x, 2.2, bracket.min.z], max: [bracket.max.x, 2.9, bracket.max.z] };
  }
  return out;
}

/** Where the water begins in the city picture (a fraction of its height from the top) and how high its top is seen from the court (rad). */
const PICTURE = { horizon: 0.615, topElev: (14 * Math.PI) / 180 };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * The sky around the painted city: the dome's own sunset (VANTHEAH's, other colours than the picture's) becomes
 * vertex colours taken from the picture's sky, row by row (elevation) — its middle (the sun) toward the sun, its
 * left edge (away from the sun) elsewhere, deepening to a violet zenith — and the picture fades out at its top and
 * its two ends into it. Both drawn as the picture is (unlit, × its strength): seamless where they meet.
 * (The sky is in the court's glTF frame: dome and picture are children of the court's root.)
 */
function paintSky(THREE, dome, backdrop, towardSun) {
  const bm = backdrop.material, im = bm.map?.image;
  if (!im?.width) return false;
  const W = 256, H = Math.max(64, Math.round((256 * im.height) / im.width));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  /** The mean (linear) colour of rows r0…r1 and columns c0…c1 (fractions); near the horizon only the sky (not the bluish towers). */
  const band = (r0, r1, c0, c1) => {
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = Math.max(0, Math.floor(r0 * H)); y <= Math.min(H - 1, Math.floor(r1 * H)); y++) {
      for (let x = Math.floor(c0 * W); x < Math.min(W, Math.ceil(c1 * W)); x++) {
        const i = (y * W + x) * 4, r = px[i], gg = px[i + 1], b = px[i + 2];
        if (y / H > 0.36 && y / H < PICTURE.horizon && b > r * 1.02) continue;
        R += lin(r); G += lin(gg); B += lin(b); n++;
      }
    }
    return n ? [R / n, G / n, B / n] : null;
  };
  const N = 28, warm = [], cool = [];
  for (let k = 0; k <= N; k++) {
    const r = PICTURE.horizon * (1 - k / N);   // (k = 0: the horizon … N: the picture's top)
    warm.push(band(r - 0.025, r + 0.025, 0.3, 0.85) || [0.5, 0.3, 0.3]);
    cool.push(band(r - 0.025, r + 0.025, 0, 0.14) || [0.4, 0.3, 0.5]);
  }
  const water = band(PICTURE.horizon + 0.01, PICTURE.horizon + 0.12, 0, 1) || [0.2, 0.12, 0.2];
  const at = (rows, e) => { const f = Math.min(1, Math.max(0, e / PICTURE.topElev)) * N, i = Math.min(N - 1, Math.floor(f)); return mix3(rows[i], rows[i + 1], f - i); };
  const k = bm.color.r;   // (the picture's strength)
  const zen = (c) => [c[0] * 0.5, c[1] * 0.47, c[2] * 0.72];
  const sky = (rows, e) => {
    if (e < 0) return mix3(mix3(rows[0], water, 0.6), [water[0] * 0.35, water[1] * 0.35, water[2] * 0.4], smooth(0, -0.35, e));
    if (e <= PICTURE.topElev) return at(rows, e);
    return mix3(rows[N], zen(rows[N]), smooth(PICTURE.topElev, 1.35, e));
  };
  const geo = new THREE.SphereGeometry(dome.geometry.boundingSphere?.radius || 120, 128, 64);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), v = new THREE.Vector3();
  const s = new THREE.Vector2(towardSun[0], towardSun[2]).normalize();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const e = Math.asin(Math.max(-1, Math.min(1, v.y))), h = Math.hypot(v.x, v.z);
    const a = h > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, (v.x * s.x + v.z * s.y) / h))) : Math.PI / 2;   // (from the sun's azimuth)
    let c = mix3(sky(cool, e), sky(warm, e), 1 - smooth(0.3, 1.5, a));
    c = mix3(c, [c[0] * 0.86, c[1] * 0.84, c[2] * 1.04], smooth(1.6, 3.1, a));   // (opposite the sun: a little cooler still)
    col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  dome.geometry.dispose(); dome.geometry = geo;
  const old = dome.material;
  dome.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
  dome.material.name = 'River sky (painted from the city picture)';
  old.map?.dispose(); old.dispose();
  // the picture: out at its top (the top 22 % of it) and its two ends (u 0…1.7, mirrored past 1)
  bm.transparent = true; bm.depthWrite = false;
  bm.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.a *= smoothstep( 0.0, 0.22, vMapUv.y ) * smoothstep( 0.0, 0.12, vMapUv.x ) * smoothstep( 1.7, 1.58, vMapUv.x );');
  };
  bm.customProgramCacheKey = () => 'river-backdrop-fade';
  backdrop.renderOrder = -10;
  return true;
}

/** A cube of the scene from one point (floor, player… hidden), prefiltered for the materials. */
function captureEnvironment(THREE, renderer, scene, { at, size = 256, hide = [], background = '#000' }) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.2, 300, rt);
  cube.position.set(...at);
  const bg0 = scene.background, env0 = scene.environment;
  for (const q of hide) q.visible = false;
  scene.background = new THREE.Color(background); scene.environment = null;
  try {
    cube.update(renderer, scene);
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromCubemap(rt.texture).texture;
    pm.dispose();
    return env;
  } finally {
    for (const q of hide) q.visible = true;
    scene.background = bg0; scene.environment = env0;
    rt.dispose();
  }
}

/**
 * The ball's statics: VANTHEAH's hoops (open capsule rims, regulation boards — frame.addVantheahHoops), the rim
 * mounts as measured, and the layout's colliders (riverBallBoxes). The floor is the physics' own plane.
 * @returns {{ count: number, boxes }}
 */
export function addRiverColliders(phys, court, frame) {
  // the boards where this court shows them: the crown boards' faces (|glb x| 12.798 — VANTHEAH's 12.775)
  const W = court.boundsOf?.('board-face--1'), E = court.boundsOf?.('board-face-1'), o = frame.VANTHEAH.offsetZ;
  const faces = [W && o - W.max.z, E && E.min.z - o].filter((x) => x > 12 && x < 13.5);
  const boardFaceX = faces.length ? faces.reduce((a, b) => a + b, 0) / faces.length : 12.775;
  let n = frame.addVantheahHoops(phys, { boardFaceX });
  for (const name of ['Hoop_West_Mount', 'Hoop_East_Mount']) {
    const b = court.boundsOf?.(name);
    if (!b) continue;
    const lo = [b.min.x, b.min.y, b.min.z], hi = [b.max.x, b.max.y, b.max.z];
    frame.clipOutOfRings(lo, hi);
    if (!(hi[0] > lo[0] && hi[1] > lo[1] && hi[2] > lo[2])) continue;
    phys.addStaticBox(lo.map((x, k) => (x + hi[k]) / 2), lo.map((x, k) => (hi[k] - x) / 2), { kind: 'stanchion', restitution: 0.3 });
    n++;
  }
  // (the poles' brackets: behind the boards' faces)
  const ov = {};
  for (const [k, b] of Object.entries(court.overrides || {})) {
    ov[k] = { min: b.min.slice(), max: b.max.slice() };
    if (/:bracket$/.test(k)) { if (b.max[2] < o) ov[k].max[2] = Math.min(b.max[2], o - boardFaceX); else ov[k].min[2] = Math.max(b.min[2], o + boardFaceX); }
  }
  const boxes = riverBallBoxes(court.layout, frame, ov);
  for (const b of boxes) { phys.addStaticBox(b.center, b.half, { kind: b.kind, restitution: b.restitution }); n++; }
  return { count: n, boxes, boardFaceX };
}
