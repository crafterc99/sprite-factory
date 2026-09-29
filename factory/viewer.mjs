/**
 * 3D viewer: three.js r160 + GLTFLoader + OrbitControls, loaded only when a model is opened.
 * One model at a time; switching or leaving disposes geometry, materials, textures and the WebGL
 * context. Counts (triangles, vertices, materials, textures, bounding size, bones) are read from the
 * loaded scene. Big files are gated behind an explicit Load button that shows the download size.
 */
import { html, useState, useEffect, useRef } from '/factory/ui/preact-htm.mjs';
import { fmtBytes, fmtNum, fmtK } from '/factory/ui/lib.mjs';

let libs = null;
async function three() {
  if (libs) return libs;
  const [THREE, { GLTFLoader }, { OrbitControls }, CM] = await Promise.all([
    import('/vendor/three.module.min.js'), import('/vendor/three-addons/GLTFLoader.js'), import('/vendor/three-addons/OrbitControls.js'), import('/js/souljam-material.mjs'),
  ]);
  libs = { THREE, GLTFLoader, OrbitControls, CM };
  return libs;
}
export const MODES = [['textured', 'Textured'], ['clay', 'Clay'], ['wire', 'Wireframe'], ['normals', 'Normals'], ['skeleton', 'Skeleton']];
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
const SLOT_NAME = { map: 'baseColor', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metallic', aoMap: 'ao', emissiveMap: 'emissive' };

/** Applies Soul Jam material style values to a characterMaterial (live). */
function applyStyle(m, S) {
  const U = m.userData.soulJam?.uniforms; if (!U) return;
  U.uRamp.value = S.ramp; U.uRim.value = S.rim; U.uPlanar.value = S.planar;
  if (S.rampLo != null) U.uRampLo.value = S.rampLo;
  if (S.rampHi != null) U.uRampHi.value = S.rampHi;
  if (S.rimPower != null) U.uRimPower.value = S.rimPower;
  U.uKeyTint.value.setRGB(...S.keyTint); U.uShadowTint.value.setRGB(...S.shadowTint);
  if (S.rimColor) U.uRimColor.value.setRGB(...S.rimColor);
  if (m.normalMap) m.normalScale.set(S.normalStrength, S.normalStrength);
}

export function Viewer({ title = '3D viewer', badge, models = [], initial, autoLoadBelow = 25e6, warn, styleParams = null, onStats, testid = 'viewer' }) {
  const [sel, setSel] = useState(initial || models[0]?.key);
  const [phase, setPhase] = useState('idle');       // idle | loading | parsing | ready | error
  const [prog, setProg] = useState(null);
  const [err, setErr] = useState(null);
  const [stats, setStats] = useState(null);
  const [mode, setMode] = useState('textured');
  const host = useRef(), ctx = useRef(null), token = useRef(0), styleRef = useRef(styleParams);
  const model = models.find((m) => m.key === sel) || models[0];
  styleRef.current = styleParams;

  // teardown on unmount
  useEffect(() => () => { token.current++; teardown(ctx.current); ctx.current = null; }, []);
  // a model that disappeared from the list (e.g. rebuilt) → fall back
  useEffect(() => { if (models.length && !models.find((m) => m.key === sel)) setSel(models[0].key); }, [models.map((m) => m.key).join()]);
  // auto-load small models; big ones wait for the Load button
  useEffect(() => {
    if (!model) return;
    if (model.bytes != null && model.bytes < autoLoadBelow) load(model);
    else { unloadModel(); setPhase('idle'); }
  }, [model?.url]);
  // live material style
  useEffect(() => {
    const c = ctx.current; if (!c || !c.root || !styleParams) return;
    c.root.traverse((o) => { if (o.isMesh && o.userData.styled) applyStyle(o.userData.styled, styleParams); });
    c.render();
  }, [styleParams && JSON.stringify(styleParams)]);
  useEffect(() => { applyMode(ctx.current, mode); }, [mode, stats]);

  function unloadModel() {
    const c = ctx.current; if (!c || !c.root) return;
    c.scene.remove(c.root); disposeRoot(c.root); c.root = null;
    if (c.helper) { c.scene.remove(c.helper); c.helper.dispose?.(); c.helper = null; }
    if (c.grid) { c.scene.remove(c.grid); c.grid.geometry.dispose(); c.grid.material.dispose(); c.grid = null; }
    setStats(null); c.render();
  }

  async function init() {
    if (ctx.current) return ctx.current;
    const { THREE, OrbitControls } = await three();
    const el = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, el.clientWidth / Math.max(1, el.clientHeight), 0.01, 100);
    scene.add(new THREE.HemisphereLight(0xfff3e4, 0x2b2432, 1.1));
    const key = new THREE.DirectionalLight(0xffe8d0, 2.2); key.position.set(2.2, 3.2, 2.6); scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfd8ff, 0.7); fill.position.set(-2.5, 1.6, 1.2); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.0); rim.position.set(0, 2.5, -3); scene.add(rim);
    const controls = new OrbitControls(camera, renderer.domElement);
    const c = { THREE, renderer, scene, camera, controls, root: null, helper: null, grid: null, mats: {}, frame: null };
    let queued = false;
    c.render = () => { if (queued || !ctx.current) return; queued = true; requestAnimationFrame(() => { queued = false; if (ctx.current) renderer.render(scene, camera); }); };
    controls.addEventListener('change', c.render);
    c.ro = new ResizeObserver(() => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); c.render(); });
    c.ro.observe(el);
    c.mats = { clay: new THREE.MeshStandardMaterial({ color: 0xc9c1ae, roughness: 0.82, metalness: 0 }), wire: new THREE.MeshBasicMaterial({ color: 0xff8a4e, wireframe: true }), normals: new THREE.MeshNormalMaterial() };
    ctx.current = c;
    return c;
  }

  async function load(m) {
    const my = ++token.current;
    setErr(null); setProg(null); setPhase('loading');
    let c;
    try { c = await init(); } catch (e) { setErr('WebGL / three.js could not start: ' + e.message); setPhase('error'); return; }
    if (my !== token.current) return;
    unloadModel();
    const { THREE, GLTFLoader, CM } = libs;
    const t0 = performance.now();
    new GLTFLoader().load(m.url, (gltf) => {
      if (my !== token.current || !ctx.current) { disposeRoot(gltf.scene); return; }
      setPhase('parsing');
      const root = gltf.scene;
      // counts from the loaded geometry
      let tris = 0, verts = 0, meshes = 0, bones = 0, skinned = null;
      const mats = new Set(), texs = new Map();
      root.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        const g = o.geometry, n = g.attributes.position?.count || 0;
        verts += n; tris += g.index ? g.index.count / 3 : n / 3;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        o.userData.orig = o.material;
        for (const mt of list) { mats.add(mt); for (const k of TEX_SLOTS) { const t = mt[k]; if (t && t.image && !texs.has(t.uuid)) texs.set(t.uuid, { slot: SLOT_NAME[k], w: t.image.width, h: t.image.height, cs: t.colorSpace === THREE.SRGBColorSpace ? 'sRGB' : 'non-color' }); } }
        if (o.isSkinnedMesh && o.skeleton) { skinned = skinned || o; bones = Math.max(bones, o.skeleton.bones.length); }
        // Soul Jam material on the game model (Appearance)
        if (styleRef.current && !Array.isArray(o.material) && o.material.isMeshStandardMaterial) {
          const s = o.material, p = {};
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'color', 'emissive', 'roughness', 'metalness', 'side', 'transparent', 'alphaTest', 'opacity']) if (s[k] != null) p[k] = s[k];
          const sm = CM.characterMaterial(THREE, p, { preset: 'souljam-illustrated', ...styleRef.current });
          applyStyle(sm, styleRef.current);
          o.userData.styled = sm;
        }
      });
      const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      c.root = root; c.scene.add(root);
      if (skinned) { c.helper = new THREE.SkeletonHelper(root); c.helper.visible = false; c.scene.add(c.helper); }
      const span = Math.max(size.x, size.y, size.z) || 1;
      c.grid = new THREE.GridHelper(Math.max(2, Math.ceil(span * 2)), Math.max(4, Math.ceil(span * 2) * 4), 0x6a2aa6, 0x3a3444);
      c.grid.position.set(center.x, box.min.y, center.z); c.scene.add(c.grid);
      c.frame = () => {
        const r = Math.max(size.length() / 2, 0.05), dist = (r / Math.sin((c.camera.fov * Math.PI) / 360)) * 1.05;
        c.camera.near = Math.max(0.001, dist / 200); c.camera.far = dist * 20; c.camera.updateProjectionMatrix();
        c.camera.position.set(center.x + dist * 0.35, center.y + r * 0.25, center.z + dist * 0.94);
        c.controls.target.copy(center); c.controls.update(); c.render();
      };
      c.frame();
      const st = { triangles: Math.round(tris), vertices: verts, meshes, materials: mats.size, textures: [...texs.values()], bones, skinned: !!skinned, size: [size.x, size.y, size.z], seconds: (performance.now() - t0) / 1000, animations: gltf.animations?.length || 0 };
      setStats(st); setPhase('ready'); onStats && onStats(st);
      applyMode(c, mode);
    }, (e) => { if (my === token.current) { setProg({ loaded: e.loaded, total: e.lengthComputable ? e.total : m.bytes || 0 }); if (e.lengthComputable && e.loaded >= e.total) setPhase('parsing'); } },
    (e) => { if (my === token.current) { setErr((e && (e.message || e.target?.statusText)) || 'the model could not be loaded'); setPhase('error'); } });
  }

  const pct = prog && prog.total ? Math.min(100, (prog.loaded / prog.total) * 100) : null;
  const sizeTxt = model?.bytes != null ? fmtBytes(model.bytes) : 'size unknown';
  return html`<div class="viewer fade" data-t=${testid}>
    <div class="vh">
      <span class="d">${title}</span>${badge}
      <span class="sp"></span>
      ${models.length > 1 && html`<div class="modes" role="tablist" aria-label="Model">${models.map((m) => html`<button class=${m.key === sel ? 'on' : ''} onClick=${() => setSel(m.key)} data-t=${'vsel-' + m.key} title=${m.bytes != null ? fmtBytes(m.bytes) : ''}>${m.label}</button>`)}</div>`}
      ${model?.url && html`<a class="btn xs" href=${model.url} download title=${'Download ' + sizeTxt}>Download · ${sizeTxt}</a>`}
    </div>
    <div class="stage" ref=${host}>
      ${phase !== 'ready' && html`<div class="gate">
        ${phase === 'idle' && html`<span class="d">${model ? model.label : 'No model'}</span>
          <span class="u">${model ? `${sizeTxt}${model.triangles ? ` · ~${fmtK(model.triangles)} triangles` : ''}. Not loaded yet — it downloads only when you ask.` : 'Nothing to show yet.'}</span>
          ${warn && html`<span class="u" style="color:#f5d9a4">${warn}</span>`}
          ${model && html`<button class="btn pri" onClick=${() => load(model)} data-t="viewer-load">Load ${sizeTxt}</button>`}`}
        ${phase === 'loading' && html`<span class="d">Downloading</span><div class="bar"><i style=${{ width: (pct ?? 0) + '%' }}></i></div><span class="u">${prog ? `${fmtBytes(prog.loaded)} of ${fmtBytes(prog.total || model?.bytes)}` : 'connecting…'}</span>`}
        ${phase === 'parsing' && html`<span class="d">Parsing the model</span><span class="u">downloaded ${fmtBytes(prog?.loaded || model?.bytes)} · building the scene on the GPU (no progress reported for this step)</span>`}
        ${phase === 'error' && html`<span class="d" style="color:var(--p2)">Could not load</span><span class="u">${err}</span>${model && html`<button class="btn" onClick=${() => load(model)}>Retry</button>`}`}
      </div>`}
      ${phase === 'ready' && html`<span class="hud">drag orbit · right-drag / two-finger pan · wheel / pinch zoom</span>`}
    </div>
    ${phase === 'ready' && stats && html`
      <div class="vtb">
        <div class="modes" role="tablist" aria-label="Display mode">${MODES.map(([k, l]) => html`<button class=${mode === k ? 'on' : ''} disabled=${k === 'skeleton' && !stats.skinned} title=${k === 'skeleton' && !stats.skinned ? 'no skin / armature in this file' : ''} onClick=${() => setMode(k)} data-t=${'mode-' + k}>${l}</button>`)}</div>
        <span class="sp"></span>
        <button class="btn xs" onClick=${() => ctx.current?.frame?.()} data-t="viewer-reset">Reset view</button>
        <button class="btn xs" onClick=${() => { token.current++; unloadModel(); setPhase('idle'); }} data-t="viewer-unload" title="Free the GPU memory">Unload</button>
      </div>
      <div class="vstats">
        <div><div class="v">${fmtNum(stats.triangles)}</div><div class="k">triangles</div></div>
        <div><div class="v">${fmtNum(stats.vertices)}</div><div class="k">vertices</div></div>
        <div><div class="v">${stats.meshes}</div><div class="k">meshes</div></div>
        <div><div class="v">${stats.materials}</div><div class="k">materials</div></div>
        <div><div class="v">${stats.textures.length}</div><div class="k">textures</div></div>
        <div><div class="v" style="font-size:15px;line-height:1.4">${stats.size.map((x) => x.toFixed(2)).join(' × ')}</div><div class="k">bounds m (x × y × z)</div></div>
        <div><div class="v">${stats.skinned ? stats.bones : '—'}</div><div class="k">${stats.skinned ? 'bones (skin)' : 'no skin'}</div></div>
        <div><div class="v">${stats.seconds.toFixed(1)} s</div><div class="k">load time</div></div>
      </div>
      ${stats.textures.length > 0 && html`<div class="texlist">${stats.textures.map((t) => html`<div>${t.slot} · ${t.w}×${t.h} · ${t.cs}</div>`)}</div>`}`}
  </div>`;
}

function applyMode(c, mode) {
  if (!c || !c.root) return;
  c.root.traverse((o) => {
    if (!o.isMesh) return;
    const base = o.userData.styled || o.userData.orig;
    o.material = mode === 'clay' ? c.mats.clay : mode === 'wire' ? c.mats.wire : mode === 'normals' ? c.mats.normals : base;
  });
  if (c.helper) c.helper.visible = mode === 'skeleton';
  c.render();
}
function disposeMaterial(m) {
  if (!m) return;
  for (const k of TEX_SLOTS) if (m[k]) m[k].dispose();
  m.dispose();
}
function disposeRoot(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = [o.userData?.orig, o.userData?.styled, ...(Array.isArray(o.material) ? o.material : [o.material])].flat().filter(Boolean);
    for (const m of new Set(ms)) disposeMaterial(m);
    if (o.skeleton?.boneTexture) o.skeleton.boneTexture.dispose();
  });
}
function teardown(c) {
  if (!c) return;
  try {
    if (c.root) disposeRoot(c.root);
    if (c.helper) c.helper.dispose?.();
    if (c.grid) { c.grid.geometry.dispose(); c.grid.material.dispose(); }
    Object.values(c.mats).forEach((m) => m.dispose());
    c.controls.dispose(); c.ro.disconnect();
    c.renderer.dispose(); c.renderer.forceContextLoss(); c.renderer.domElement.remove();
  } catch (e) { console.warn('viewer teardown', e); }
}
