/**
 * VANTHEAH Sunset Practice Court (assets/courts/vantheah.glb) in the 3D court.
 *
 * The pack's GLB is metres, Y up, full court along X with the baskets at
 * X = ±12.425. The game plays at a hoop on the origin with the court along +Z,
 * so the court is turned −90° about Y and moved +12.425 m in Z: the West basket
 * lands exactly on the game's hoop (rim centre (0, 3.05, 0)), the East one at
 * Z = 24.85. glb (x, y, z) → game (−z, y, x + 12.425).
 *
 * Lighting follows the pack's loader (loadVantheahCourt.js): its own sun and
 * floodlights, a captured environment map, a live planar reflection on desktop
 * (the static environment only on mobile / lite). Collision uses the pack's
 * dimensions (open capsule rims, backboards, fences, walls) plus the measured
 * bounds of the hoop supports and the courtside props.
 */
import * as THREE from '/vendor/three.module.min.js';
import { GLTFLoader } from '/vendor/three-addons/GLTFLoader.js';
import { Reflector } from '/vendor/three-addons/Reflector.js';

export const VANTHEAH = {
  url: '/courts/vantheah.glb',
  offsetZ: 12.425,
  rimY: 3.05, rimR: 0.2286, tube: 0.0095, segments: 32,
  // playable court in game space: x ±7.5, z from the West baseline (−1.575) to the East one (26.425)
  bounds: { minX: -7.5, maxX: 7.5, minZ: -1.575, maxZ: 26.425 },
  goals: [[0, 3.05, 0], [0, 3.05, 24.85]],
};

/** A glb-space point → game space. */
/**
 * Floor layers of the pack lie 0–12 mm apart and the roof slab's top is exactly
 * coplanar with the court surface (y = 0): on a depth buffer they fight (flicker
 * as the camera moves). Each layer gets a fixed depth priority instead
 * (polygon offset, negative = drawn in front): markings > wet reflection > key
 * paint > court surface > roof slab. Depth-independent, so it holds at any
 * distance and grazing angle.
 */
const FLOOR_LAYERS = [
  [/^(COURT_Painted_Lines|Court_Baseline|Court_Wordmark|Brand_Motifs_Floor)/, -6],
  [/^Paint_Key/, -2],
  [/^COURT_Surface/, 0],
  [/^Roof_Slab/, 4],
];
export const REFLECTION_OFFSET = -4;
function layerOffset(name) { for (const [re, o] of FLOOR_LAYERS) if (re.test(name)) return o; return null; }

export const toGame = ([x, y, z]) => [-z, y, x + VANTHEAH.offsetZ];
/** A glb-space axis-aligned box (centre, half extents) → game space (still axis aligned: a 90° turn). */
export const boxToGame = (c, h) => ({ center: toGame(c), half: [h[2], h[1], h[0]] });

/**
 * Load the court into the scene.
 * @param {{ scene, renderer, quality: 'desktop'|'mobile', hide?: THREE.Object3D[] }} o
 *   hide: objects kept out of the environment capture (the character)
 */
export async function loadVantheahCourt({ scene, renderer, quality = 'desktop', hide = [], onProgress = null }) {
  const gltf = await new GLTFLoader().loadAsync(VANTHEAH.url, onProgress ? (e) => onProgress(e.loaded, e.total) : undefined);
  const root = gltf.scene;
  root.name = 'VANTHEAH_Sunset_Court';
  root.rotation.y = -Math.PI / 2;
  root.position.set(0, 0, VANTHEAH.offsetZ);
  scene.add(root);
  const floorMeshes = [], lights = [], named = {};
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  root.traverse((o) => {
    if (o.name) named[o.name] = o;
    if (o.isMesh) {
      const background = /^(ENV_|Skyline|Near_)/.test(o.name);
      o.castShadow = !background && !/COURT|Paint_|Brand_Motifs_Floor/.test(o.name);
      o.receiveShadow = !/^ENV_/.test(o.name);
      if (/^ENV_/.test(o.name)) o.frustumCulled = false;
      if (/COURT_Surface|Paint_Key|COURT_Painted|Court_|Brand_Motifs_Floor/.test(o.name)) floorMeshes.push(o);
      const lo = layerOffset(o.name);
      if (lo != null) {
        // a material of its own (the paint material is shared with non-floor parts)
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.polygonOffset = lo !== 0; m.polygonOffsetFactor = lo; m.polygonOffsetUnits = lo;
        }
        o.renderOrder = -lo;   // lower layers first, markings last
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const p of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (m[p]) m[p].anisotropy = aniso;
        if (/glass/i.test(m.name)) { m.transparent = true; m.opacity = 0.26; m.transmission = 0; m.depthWrite = false; }
      }
    }
    if (o.isLight) {
      lights.push(o);
      o.castShadow = o.isDirectionalLight && /Sunset/.test(o.name);
      if (o.castShadow) {
        const s = quality === 'mobile' ? 1024 : 2048;
        o.shadow.mapSize.set(s, s);
        Object.assign(o.shadow.camera, { left: -24, right: 24, top: 20, bottom: -20, near: 0.1, far: 160 });
        o.shadow.bias = -0.00025; o.shadow.normalBias = 0.025;
      }
    }
  });
  const fill = new THREE.HemisphereLight(0xa08ad3, 0x543138, 0.45);
  scene.add(fill);
  root.updateMatrixWorld(true);
  // captured environment (the court's own sky, city and lights), floor and character left out
  const capture = new THREE.WebGLCubeRenderTarget(quality === 'mobile' ? 128 : 256, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.2, 280, capture);
  cube.position.set(0, 3, VANTHEAH.offsetZ);
  const hidden = [...floorMeshes, ...hide].filter((o) => o.visible);
  hidden.forEach((o) => { o.visible = false; });
  const bg0 = scene.background;
  scene.background = new THREE.Color(0x9e4862);
  cube.update(renderer, scene);
  hidden.forEach((o) => { o.visible = true; });
  scene.background = bg0;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromCubemap(capture.texture);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose(); capture.dispose();
  // live wet-floor reflection (desktop)
  let reflection = null;
  if (quality !== 'mobile') {
    reflection = new Reflector(new THREE.PlaneGeometry(34, 22), { color: 0xa28aab, textureWidth: 1024, textureHeight: 1024, clipBias: 0.002 });
    reflection.name = 'VANTHEAH_Live_Wet_Reflection';
    reflection.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
    reflection.position.set(0, 0.004, VANTHEAH.offsetZ);
    reflection.material.transparent = true; reflection.material.depthWrite = false;
    reflection.material.polygonOffset = true; reflection.material.polygonOffsetFactor = REFLECTION_OFFSET; reflection.material.polygonOffsetUnits = REFLECTION_OFFSET;
    reflection.position.y = 0.001;         // just above the surface; the offset (not the height) keeps it in front
    reflection.renderOrder = 5;
    reflection.material.uniforms.reflectionAmount = { value: 0.32 };
    reflection.material.vertexShader = reflection.material.vertexShader
      .replace('uniform mat4 textureMatrix;', 'uniform mat4 textureMatrix;\nvarying vec3 vReflectionWorld;')
      .replace('vUv = textureMatrix * vec4( position, 1.0 );', 'vUv = textureMatrix * vec4( position, 1.0 );\nvReflectionWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    reflection.material.fragmentShader = reflection.material.fragmentShader
      .replace('uniform vec3 color;', 'uniform vec3 color;\nuniform float reflectionAmount;\nvarying vec3 vReflectionWorld;')
      .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
        'float puddle = 0.5 + 0.5*sin(vReflectionWorld.z*0.81 + sin(vReflectionWorld.x*1.3))*sin(vReflectionWorld.x*1.1);\n gl_FragColor = vec4(blendOverlay(base.rgb,color), reflectionAmount*(0.35+0.65*puddle));');
    scene.add(reflection);
  }
  /** Game-space bounds of a named part (null if absent). */
  const boundsOf = (name) => { const o = named[name]; if (!o) return null; const b = new THREE.Box3().setFromObject(o); return b.isEmpty() ? null : b; };
  return {
    root, gltf, lights, fill, reflection, named, boundsOf,
    setWetness(v) { if (reflection) reflection.material.uniforms.reflectionAmount.value = THREE.MathUtils.clamp(v, 0, 1) * 0.42; },
  };
}

/**
 * Static collision for the physics system (BP.BasketballPhysicsSystem):
 * both hoops (open 32-capsule rims + backboards), the pack's fences, walls and
 * hoop bases, and the measured bounds of the hoop supports and courtside props.
 * The floor is the system's own plane at y = 0. Sky, city, banners, nets, foliage
 * and the decorative balls get no collision (as the pack specifies).
 * @returns {{ count: number }}
 */
export function addVantheahColliders(phys, court) {
  let n = 0;
  const box = (c, h, opts) => { const g = boxToGame(c, h); phys.addStaticBox(g.center, g.half, opts); n++; };
  for (const sign of [-1, 1]) {
    const g = toGame([sign * 12.425, VANTHEAH.rimY, 0]);
    const board = boxToGame([sign * 12.8, 3.425, 0], [0.025, 0.525, 0.9]);
    phys.addHoop({ center: g, rimR: VANTHEAH.rimR, tube: VANTHEAH.tube, segments: VANTHEAH.segments, board });
    n += VANTHEAH.segments + 1;
    box([sign * 14.65, 0.74, 0], [0.36, 0.74, 0.4], { kind: 'stanchion' });           // padded base
    box([sign * 16.6, 3.275, 0], [0.025, 2.525, 10.4], { kind: 'fence', restitution: 0.25 });
    box([sign * 16.8, 0.35, 0], [0.2, 0.35, 11], { kind: 'wall', restitution: 0.3 });
  }
  box([0, 4.35, -10.4], [16.6, 1.45, 0.025], { kind: 'fence', restitution: 0.25 });
  box([0, 0.35, 10.7], [17, 0.35, 0.2], { kind: 'wall', restitution: 0.3 });
  box([0, 1.05, -10.7], [17, 1.05, 0.275], { kind: 'wall', restitution: 0.3 });
  // measured parts: supports / mounts between the base and the board, courtside furniture
  if (court?.boundsOf) {
    for (const name of ['Hoop_West_Support', 'Hoop_East_Support', 'Hoop_West_Mount', 'Hoop_East_Mount', 'Bleachers_Frame', 'Bleachers_Step', 'Bench_Seat', 'Bench_Seat.001', 'Ball_Rack', 'Duffel_Bag']) {
      const b = court.boundsOf(name);
      if (!b) continue;
      const c = b.getCenter(new THREE.Vector3()), h = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      if (Math.max(h.x, h.y, h.z) > 12) continue; // not a prop
      phys.addStaticBox([c.x, c.y, c.z], [h.x, h.y, h.z], { kind: /Hoop/.test(name) ? 'stanchion' : 'props', restitution: 0.3 });
      n++;
    }
  }
  return { count: n };
}
