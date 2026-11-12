import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

/**
 * Nordic sky: gradient, low sun with glow, layered fbm clouds, and by night
 * stars, a moon and animated aurora borealis curtains. Output is linear HDR.
 */
export class Sky {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;

  constructor(sunDir: THREE.Vector3, sunColor: THREE.Color) {
    this.uniforms = {
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: sunColor.clone() },
      uMoonDir: { value: new THREE.Vector3(0.3, 0.5, 0.8).normalize() },
      uTime: { value: 0 },
      uCover: { value: 0.55 },
      uNight: { value: 0 },
      uAurora: { value: 0 },
      uZenith: { value: new THREE.Color(0.16, 0.27, 0.44) },
      uHorizon: { value: new THREE.Color(0.62, 0.68, 0.73) },
      uFogColor: { value: new THREE.Color(0.55, 0.6, 0.64) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        ${GLSL_NOISE}
        uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uMoonDir; uniform float uTime; uniform float uCover;
        uniform float uNight; uniform float uAurora;
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uFogColor;
        varying vec3 vDir;
        float cloudDensity(vec2 p){
          if (uCover < 0.02) return 0.0;
          vec2 w = vec2(uTime * 0.004, uTime * 0.0015);
          float base = fbm2(p * 0.55 + w);
          float detail = fbm2(p * 2.3 - w * 2.0);
          float d = base * 0.78 + detail * 0.32;
          return smoothstep(1.0 - uCover - 0.1, 1.0 - uCover + 0.32, d);
        }
        // aurora: vertical curtains folded by low-frequency noise, sampled through a thin shell
        vec3 aurora(vec3 d){
          if (d.y < 0.02) return vec3(0.0);
          vec3 acc = vec3(0.0);
          for (int i = 0; i < 10; i++) {
            float hgt = 1.0 + float(i) * 0.06;
            vec2 p = d.xz / (d.y + 0.05) * hgt * 0.9;
            float fold = fbm2(vec2(p.x * 0.35 + uTime * 0.012, p.y * 0.12));
            float band = abs(p.y * 0.55 + sin(p.x * 0.9 + uTime * 0.05) * 0.8 + fold * 2.6 - 1.6);
            float curtain = smoothstep(0.32, 0.0, band) * (0.6 + 0.4 * noise2(vec2(p.x * 3.0 + uTime * 0.2, float(i))));
            float rays = 0.65 + 0.35 * sin(p.x * 18.0 + fold * 9.0 + uTime * 0.3);
            vec3 col = mix(vec3(0.15, 1.0, 0.45), vec3(0.75, 0.25, 0.9), float(i) / 10.0);
            acc += col * curtain * rays * (1.0 - float(i) / 11.0);
          }
          // brighter toward the northern sky
          float north = smoothstep(0.4, -0.6, d.z);
          return acc * 0.07 * north * smoothstep(0.02, 0.25, d.y);
        }
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          float sd = max(dot(d, uSunDir), 0.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.5));
          col += uSunColor * (pow(sd, 6.0) * 0.22 + pow(sd, 48.0) * 0.55);
          col += uSunColor * smoothstep(0.99955, 0.99975, sd) * 40.0;
          // night: stars, moon, aurora
          if (uNight > 0.01) {
            vec2 sc = vec2(atan(d.z, d.x) * 120.0, asin(clamp(d.y, -1.0, 1.0)) * 120.0);
            vec2 cell = floor(sc);
            float r = hash12(cell);
            vec2 off = hash22(cell) - 0.5;
            float star = smoothstep(0.18, 0.0, length(fract(sc) - 0.5 - off * 0.6)) * step(0.985, r);
            float tw = 0.6 + 0.4 * sin(uTime * (2.0 + r * 6.0) + r * 40.0);
            col += vec3(0.85, 0.9, 1.0) * star * tw * 1.6 * uNight * smoothstep(0.0, 0.15, h);
            float md = max(dot(d, uMoonDir), 0.0);
            col += vec3(0.75, 0.8, 0.9) * (smoothstep(0.99965, 0.99985, md) * 5.0 + pow(md, 80.0) * 0.08) * uNight;
            col += aurora(d) * uAurora;
          }
          if (h > 0.0) {
            vec2 cp = d.xz / (h + 0.12) * 1.6;
            float c = cloudDensity(cp);
            vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.12;
            float cs = cloudDensity(cp + toSun);
            float lit = clamp(1.0 - (cs - c) * 2.5 - cs * 0.55, 0.0, 1.0);
            vec3 dark = mix(vec3(0.30, 0.33, 0.37), vec3(0.012, 0.015, 0.025), uNight);
            vec3 bright = mix(vec3(0.86, 0.87, 0.88), vec3(0.05, 0.06, 0.08), uNight) + uSunColor * 0.45 * pow(sd, 3.0);
            vec3 cc = mix(dark, bright, lit);
            cc += uSunColor * pow(sd, 12.0) * (1.0 - c) * 1.6;
            // underlit cloud bases at sunset
            cc += uSunColor * 0.35 * (1.0 - lit) * smoothstep(0.25, 0.0, h) * (1.0 - uNight);
            float fade = smoothstep(0.0, 0.18, h);
            col = mix(col, cc, c * fade * 0.96);
          }
          float hz = 1.0 - smoothstep(-0.02, 0.22, h);
          col = mix(col, uFogColor + uSunColor * pow(sd, 5.0) * 0.45, hz * 0.85);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(dt: number, camPos: THREE.Vector3) {
    this.uniforms.uTime.value += dt;
    this.mesh.position.copy(camPos);
  }
}
