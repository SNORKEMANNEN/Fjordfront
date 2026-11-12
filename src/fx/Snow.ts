import * as THREE from 'three';

/**
 * Snow that settles on surfaces.
 *
 * Every lit world material (MeshStandard/Physical with fog, including the terrain splat shader)
 * gets a small fragment patch that whitens upward-facing surfaces by a global `uSnow` amount
 * (0 = none, 1 = deep winter cover). Where snow can actually land is decided by a top-down
 * "sky occlusion" height map baked once from the static world: a surface only collects snow
 * if nothing solid is above it, so floors under roofs, the tunnel and the ground under the
 * eaves stay clear while roofs, window sills, car tops and the ground fill in. During a snow
 * shower uSnow creeps up (patchy first, then full cover); it melts slowly afterwards.
 */
export const SNOW = {
  uSnow: { value: 0 },
  uSnowMap: { value: null as THREE.Texture | null },
  /** x0, z0, size, enabled */
  uSnowBox: { value: new THREE.Vector4(-260, -260, 520, 0) },
};

/**
 * Weathering (Update 33), in the same patch: moss on north faces and roofs, grime at the base of
 * walls, rain wetness + puddles where the sky can reach, winter frost on metal, the baked per-vertex
 * occlusion (`aWeather.x`, see BakedAO) and the interior ambient probes (warm by the lamps at
 * night, cool daylight near windows).
 * Material flags (material.userData.wx): 'moss' | 'grime' | 'metal' (any combination).
 */
export const WX = {
  uWet: { value: 0 },
  uFrost: { value: 0 },
  uProbeMap: { value: null as THREE.Texture | null },
  /** x0, z0, size, enabled */
  uProbeBox: { value: new THREE.Vector4(-260, -260, 520, 0) },
  uProbeNight: { value: 0 },
};

const COMMON = /* glsl */ `
uniform float uWet; uniform float uFrost; uniform sampler2D uProbeMap; uniform vec4 uProbeBox; uniform float uProbeNight;
varying vec2 vWeather;
uniform float uSnow;
uniform sampler2D uSnowMap;
uniform vec4 uSnowBox;
float snH(vec2 p){ return fract(sin(dot(p, vec2(41.31, 289.17))) * 43758.5453); }
float snN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(snH(i), snH(i+vec2(1,0)), f.x), mix(snH(i+vec2(0,1)), snH(i+vec2(1,1)), f.x), f.y); }
// 1 = open to the sky at p, 0 = something solid well above it (from the snow cover height map)
float wxSky(vec3 p){
  if (uSnowBox.w < 0.5) return 1.0;
  vec2 suv = vec2((p.x - uSnowBox.x) / uSnowBox.z, 1.0 - (p.z - uSnowBox.y) / uSnowBox.z);
  if (suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0) return 1.0;
  float top = texture2D(uSnowMap, suv).r;
  return smoothstep(top - 1.4, top - 0.35, p.y);
}
`;

const APPLY_WX = /* glsl */ `
#ifdef USE_FOG
{
  vec3 wxp = vFogWorldPos;
  vec3 wxn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  float wxz = snN(wxp.xz * 0.9 + wxp.y * 0.7);
  // exposure of this face: sample the sky a little out along its normal (eaves, porches count)
  float wxs = wxSky(wxp + wxn * 0.8);
  #ifdef WX_GRIME
  {
    float g = vWeather.y * (1.0 - abs(wxn.y)) * wxs;
    float gm = g * smoothstep(0.25, 0.85, wxz + g * 0.7 - 0.25);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.58, 0.55, 0.5), gm * 0.85);
    roughnessFactor = mix(roughnessFactor, 1.0, gm * 0.4);
  }
  #endif
  #ifdef WX_MOSS
  {
    float north = smoothstep(0.05, 0.75, -wxn.z);
    float up = smoothstep(0.3, 0.85, wxn.y);
    float patchy = smoothstep(0.48, 0.72, snN(wxp.xz * 0.55 + wxp.y * 0.35) * 0.7 + wxz * 0.3);
    float m = patchy * (north * (0.3 + 0.7 * vWeather.y) + up * north * 0.8) * wxs;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.19, 0.07) * (0.75 + 0.5 * wxz), clamp(m, 0.0, 1.0) * 0.72);
    roughnessFactor = mix(roughnessFactor, 0.95, clamp(m, 0.0, 1.0) * 0.5);
  }
  #endif
  if (uWet > 0.001) {
    float w = uWet * wxSky(wxp + vec3(0.0, 0.2, 0.0));
    float porous = 1.0 - metalnessFactor;
  #ifdef WX_TERRAIN
    // soil and grass soak it up: darker, only a faint sheen (puddles are rarer)
    diffuseColor.rgb *= mix(1.0, 0.72, w);
    roughnessFactor = mix(roughnessFactor, 0.55, w * 0.6);
    w *= 0.45;
  #else
    diffuseColor.rgb *= mix(1.0, 0.6, w * porous);
    roughnessFactor = mix(roughnessFactor, 0.16, w * 0.85);
  #endif
    // puddles: flat ground, in the dips of a broad noise
    float flatG = smoothstep(0.965, 0.995, wxn.y);
    float pm = smoothstep(0.6, 0.7, snN(wxp.xz * 0.33) * 0.75 + snN(wxp.xz * 1.4) * 0.25);
    float pud = flatG * pm * w;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5, pud);
    roughnessFactor = mix(roughnessFactor, 0.02, pud);
    metalnessFactor = mix(metalnessFactor, 0.0, pud);
  }
  #ifdef WX_METAL
  if (uFrost > 0.001) {
    float f = uFrost * wxs * smoothstep(0.32, 0.72, snN(wxp.xz * 3.1 + wxp.y * 2.3) * 0.7 + wxz * 0.3);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.86, 0.93), f * 0.6);
    roughnessFactor = mix(roughnessFactor, 0.7, f);
    metalnessFactor = mix(metalnessFactor, 0.05, f);
  }
  #endif
}
#endif
`;

const APPLY_AO = /* glsl */ `
#ifdef USE_FOG
{
  float occ = vWeather.x;
  reflectedLight.indirectDiffuse *= 1.0 - occ * 0.8;
  reflectedLight.indirectSpecular *= 1.0 - occ * 0.6;
  reflectedLight.directDiffuse *= 1.0 - occ * 0.2;
  // interiors: the ambient takes the room's colour (lamps at night, window light by day)
  if (uProbeBox.w > 0.5) {
    float inside = 1.0 - wxSky(vFogWorldPos + vec3(0.0, 0.3, 0.0));
    if (inside > 0.01) {
      vec2 puv = vec2((vFogWorldPos.x - uProbeBox.x) / uProbeBox.z, 1.0 - (vFogWorldPos.z - uProbeBox.y) / uProbeBox.z);
      vec4 pr = texture2D(uProbeMap, puv);
      inside *= pr.a; // only inside building footprints (not under trees)
      vec3 dayT = mix(vec3(0.68, 0.76, 0.92), vec3(1.1, 1.05, 0.98), pr.g);
      vec3 nightT = vec3(1.0, 0.8, 0.56) * (0.55 + 1.9 * pr.r);
      vec3 tint = mix(dayT, nightT, uProbeNight);
      reflectedLight.indirectDiffuse *= mix(vec3(1.0), tint, inside);
    }
  }
}
#endif
`;

const APPLY = /* glsl */ `
#ifdef USE_FOG
if (uSnow > 0.001) {
  vec3 swp = vFogWorldPos;
  vec3 swn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  float sn = snN(swp.xz * 1.7) * 0.6 + snN(swp.xz * 0.23) * 0.4;
  float thr = mix(0.97, 0.42, uSnow);
  float cover = smoothstep(thr, thr + 0.16, swn.y + (sn - 0.5) * 0.3);
  // patchy while it is still settling
  cover *= smoothstep(0.42, 0.62, sn + uSnow * 0.8 - 0.25);
  // sky occlusion: only where nothing is above
  if (uSnowBox.w > 0.5) {
    vec2 suv = vec2((swp.x - uSnowBox.x) / uSnowBox.z, 1.0 - (swp.z - uSnowBox.y) / uSnowBox.z);
    if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
      float top = texture2D(uSnowMap, suv).r;
      cover *= smoothstep(top - 0.9, top - 0.35, swp.y);
    }
  }
  cover *= smoothstep(0.1, 0.6, swp.y); // the tide line stays wet
  vec3 snowCol = vec3(0.83, 0.86, 0.91) * (0.92 + 0.08 * sn);
  diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, cover);
  roughnessFactor = mix(roughnessFactor, 0.62, cover);
  metalnessFactor = mix(metalnessFactor, 0.0, cover);
}
#endif
`;

/** Add the snow patch to every lit world material below `root` (idempotent). */
export function patchSnow(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) patchMaterial(m);
  });
}

export function patchMaterial(m: THREE.Material) {
  const sm = m as THREE.MeshStandardMaterial;
  if (!sm || !(sm as any).isMeshStandardMaterial || sm.userData.snow || sm.fog === false || sm.transparent) return;
  sm.userData.snow = true;
  const prev = sm.onBeforeCompile;
  const prevKey = sm.customProgramCacheKey;
  // The default key is `onBeforeCompile.toString()`, which after wrapping would be this wrapper's
  // source for EVERY material: plain materials and ones with their own shader hook (the terrain)
  // would then share one compiled program. Key on the original hook's source instead.
  const base = prevKey === THREE.Material.prototype.customProgramCacheKey ? prev.toString() : null;
  const wx: string[] = (sm.userData.wx as string[] | undefined) ?? [];
  sm.customProgramCacheKey = () => (base ?? prevKey.call(sm)) + '|snow|' + wx.join(',');
  sm.onBeforeCompile = (sh, r) => {
    prev.call(sm, sh, r);
    sh.uniforms.uSnow = SNOW.uSnow;
    sh.uniforms.uSnowMap = SNOW.uSnowMap;
    sh.uniforms.uSnowBox = SNOW.uSnowBox;
    sh.uniforms.uWet = WX.uWet;
    sh.uniforms.uFrost = WX.uFrost;
    sh.uniforms.uProbeMap = WX.uProbeMap;
    sh.uniforms.uProbeBox = WX.uProbeBox;
    sh.uniforms.uProbeNight = WX.uProbeNight;
    for (const f of wx) sh.defines = { ...(sh.defines ?? {}), ['WX_' + f.toUpperCase()]: '' };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWeather;\nvarying vec2 vWeather;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWeather = aWeather;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON)
      .replace('#include <emissivemap_fragment>', APPLY + APPLY_WX + '\n#include <emissivemap_fragment>')
      .replace('#include <aomap_fragment>', APPLY_AO + '\n#include <aomap_fragment>');
  };
  sm.needsUpdate = true;
}

/** Bake the top-down height of the highest solid surface over the play area. */
export function bakeSnowCover(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D[], half = 260, res = 1024) {
  const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 1200);
  cam.position.set(0, 600, 0);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const mat = new THREE.ShaderMaterial({
    vertexShader: `varying float vY; void main(){ vec4 p = vec4(position, 1.0);
      #ifdef USE_INSTANCING
        p = instanceMatrix * p;
      #endif
      vec4 wp = modelMatrix * p; vY = wp.y; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `varying float vY; void main(){ gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }`,
    side: THREE.DoubleSide,
  });
  const vis = hide.map((o) => o.visible);
  hide.forEach((o) => (o.visible = false));
  const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevFog = scene.fog;
  scene.overrideMaterial = mat;
  scene.background = null;
  scene.fog = null;
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const tm = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new THREE.Color(-50, 0, 0), 1);
  renderer.clear();
  // render all layers (fine detail lives on layer 1)
  cam.layers.enableAll();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = tm;
  scene.overrideMaterial = prevOverride;
  scene.background = prevBg;
  scene.fog = prevFog;
  hide.forEach((o, i) => (o.visible = vis[i]));
  mat.dispose();
  SNOW.uSnowMap.value = rt.texture;
  SNOW.uSnowBox.value.set(-half, -half, half * 2, 1);
  return rt;
}

/** Falling snowflakes wrapped around the camera, drifting with the wind. */
export class Snowfall {
  points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private offset = new THREE.Vector3();
  intensity = 0;
  private n = 0;
  /** draw only a fraction of the flakes (quality preset) */
  setBudget(f: number) {
    this.points.geometry.setDrawRange(0, Math.round(this.n * f));
  }

  constructor(scene: THREE.Scene) {
    const N = 7000;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos.set([Math.random() * 40 - 20, Math.random() * 24, Math.random() * 40 - 20], i * 3);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uOff: { value: this.offset }, uCam: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uTime: { value: 0 }, uScale: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute float seed; uniform vec3 uOff; uniform vec3 uCam; uniform float uTime; uniform float uScale; uniform float uAlpha;
        varying float vA;
        void main(){
          vec3 box = vec3(40.0, 24.0, 40.0);
          vec3 p = position + uOff * (0.75 + seed * 0.5);
          p.x += sin(uTime * (0.8 + seed) + seed * 40.0) * 0.4;
          p.z += cos(uTime * (0.7 + seed) + seed * 17.0) * 0.4;
          vec3 wp = uCam + mod(p - uCam + box * 0.5, box) - box * 0.5;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          // only a fraction of the flakes in light showers
          vA = step(seed, uAlpha) * smoothstep(0.3, 2.5, -mv.z) * (1.0 - smoothstep(14.0, 20.0, -mv.z));
          gl_PointSize = (0.045 + seed * 0.035) * uScale / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c);
          float a = smoothstep(0.5, 0.15, d) * vA; if (a < 0.02) discard;
          gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a * 0.9); }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.n = N;
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
    this.points.visible = false;
    this.points.layers.set(1);
    scene.add(this.points);
  }

  update(dt: number, t: number, cam: THREE.Vector3, wind: THREE.Vector3, heightPx: number) {
    this.points.visible = this.intensity > 0.01;
    if (!this.points.visible) return;
    // fall at ~1.1 m/s, carried by the wind
    this.offset.x += wind.x * 0.8 * dt;
    this.offset.z += wind.z * 0.8 * dt;
    this.offset.y -= 1.1 * dt;
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam);
    u.uAlpha.value = this.intensity;
    u.uTime.value = t;
    u.uScale.value = heightPx * 0.9;
  }
}
