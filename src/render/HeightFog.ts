import * as THREE from 'three';

/**
 * Exponential height fog with sun in-scattering, injected into every built-in material
 * by overriding three's fog shader chunks.
 *
 * three only refreshes fogColor/fogNear/fogFar per frame, so the dynamic sun is packed
 * into those floats:  fogNear = floor(sunAzimuthDeg) + density   (density < 1)
 *                     fogFar  = floor(sunElevDeg+100) + falloff  (falloff < 1)
 * and the scatter strength rides in the integer part of nothing — it is folded into
 * the elevation (scatter fades as the sun sets).
 */
export class HeightFog extends THREE.Fog {
  sunAz = 220;
  sunEl = 15;
  scatter = 1;
  constructor(color: THREE.ColorRepresentation, public density = 0.0016, public falloff = 0.035) {
    super(color, density, falloff);
  }
  sync() {
    const az = ((Math.round(this.sunAz) % 360) + 360) % 360;
    const el = Math.round(THREE.MathUtils.clamp(this.sunEl, -89, 89) + 100);
    this.near = az + Math.min(this.density, 0.0999);
    // scatter (0..2) is stored in the first decimal of the falloff slot: falloff ∈ [0, 0.1)
    this.far = el + Math.min(this.falloff, 0.0999) + Math.round(THREE.MathUtils.clamp(this.scatter, 0, 1.8) * 4) * 0.1 + 0.0001;
  }
}

export function installHeightFog() {
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorldPos;
  #endif`;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorldPos = transpose(mat3(viewMatrix)) * mvPosition.xyz + cameraPosition;
  #endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorldPos;
    uniform float fogNear;
    uniform float fogFar;
    vec3 fogApply(vec3 col){
      float az = radians(floor(fogNear));
      float dens = fract(fogNear);
      float elRaw = floor(fogFar);
      float rest = fract(fogFar);
      float scatter = floor(rest * 10.0 + 0.001) / 4.0;
      float fall = rest - floor(rest * 10.0 + 0.001) / 10.0;
      float el = radians(elRaw - 100.0);
      vec3 sunDir = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
      vec3 ray = vFogWorldPos - cameraPosition;
      float dist = length(ray);
      vec3 dir = ray / max(dist, 1e-4);
      float camH = max(cameraPosition.y, -2.0);
      float ib = dens * exp(-fall * camH);
      float t = fall * ray.y;
      float fh = abs(t) > 1e-3 ? (1.0 - exp(-t)) / t : 1.0 - 0.5 * t;
      float f = 1.0 - exp(-ib * fh * dist);
      f = max(f, 1.0 - exp(-dist * dens * 0.12));
      f = clamp(f, 0.0, 0.985);
      float sun = pow(max(dot(dir, sunDir), 0.0), 5.0);
      vec3 warm = mix(vec3(1.0, 0.86, 0.7), vec3(1.0, 0.55, 0.28), smoothstep(12.0, 2.0, elRaw - 100.0));
      vec3 fc = fogColor + warm * sun * 0.45 * scatter;
      return mix(col, fc, f);
    }
  #endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
    gl_FragColor.rgb = fogApply(gl_FragColor.rgb);
  #endif`;
}
