/**
 * SoulJamCharacterMaterial: the standard PBR material (base colour, normal, roughness, metallic,
 * AO — lit by the court like everything else) plus optional illustrated-look controls:
 *
 *   ramp          0…1  direct light follows a soft two-tone ramp instead of plain N·L
 *   rampLo/rampHi      the ramp's edge (N·L range)
 *   keyTint       rgb  warm multiplier on direct (key) light
 *   shadowTint    rgb  cool multiplier on indirect (shadow-side) light
 *   rim / rimColor / rimPower   fresnel rim light
 *   normalStrength     normal-map strength
 *   planar        0…1  blend toward flat facet normals (the painted "polygon" planes)
 *
 * The baked textures carry colour only (no baked light), so the court's lights still model the
 * figure; these controls only restyle the response. Defaults ("souljam-illustrated") are subtle.
 */
export const PRESETS = {
  'souljam-illustrated': { ramp: 0.35, rampLo: 0.02, rampHi: 0.5, keyTint: [1.04, 1.0, 0.95], shadowTint: [0.93, 0.97, 1.07], rim: 0.18, rimColor: [1.0, 0.93, 0.85], rimPower: 3.0, normalStrength: 1.0, planar: 0.0 },
  pbr: { ramp: 0, keyTint: [1, 1, 1], shadowTint: [1, 1, 1], rim: 0, normalStrength: 1, planar: 0 },
};

export function characterMaterial(THREE, params = {}, style = {}) {
  const S = { ...PRESETS['souljam-illustrated'], ...(PRESETS[style.preset] || {}), ...style };
  const mat = new THREE.MeshStandardMaterial(params);
  if (mat.normalMap) mat.normalScale.set(S.normalStrength, S.normalStrength);
  const U = {
    uRamp: { value: S.ramp }, uRampLo: { value: S.rampLo ?? 0.02 }, uRampHi: { value: S.rampHi ?? 0.5 },
    uKeyTint: { value: new THREE.Color(...S.keyTint) }, uShadowTint: { value: new THREE.Color(...S.shadowTint) },
    uRim: { value: S.rim }, uRimColor: { value: new THREE.Color(...(S.rimColor || [1, 1, 1])) }, uRimPower: { value: S.rimPower ?? 3 },
    uPlanar: { value: S.planar },
  };
  mat.userData.soulJam = { style: S, uniforms: U };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    const decl = 'uniform float uRamp, uRampLo, uRampHi, uRim, uRimPower, uPlanar; uniform vec3 uKeyTint, uShadowTint, uRimColor;\n';
    sh.fragmentShader = decl + sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment.replace(
        'vec3 irradiance = dotNL * directLight.color;',
        'float rNL = mix( dotNL, smoothstep( uRampLo, uRampHi, dotNL ), uRamp );\n\tvec3 irradiance = rNL * directLight.color * uKeyTint;'))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if ( uPlanar > 0.0 ) { vec3 fn = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) ); normal = normalize( mix( normal, fn, uPlanar ) ); }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse *= uShadowTint;`)
      .replace('#include <opaque_fragment>', `{ float fr = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), uRimPower );
        outgoingLight += uRimColor * fr * uRim * diffuseColor.rgb; }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'souljam-char';
  return mat;
}
