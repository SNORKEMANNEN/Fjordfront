import * as THREE from 'three';
import { Settings } from '../game/Settings';

/**
 * Atmospheric motes (Update 45): dust, pollen and sea-salt specks hanging in the air around you.
 * They are only really seen against the light — looking toward a low sun they glint warm, in the
 * shade they are barely there — which is what makes air read as air. At night a few cold specks
 * catch the moonlight; rain and snow showers wash them out (the weather layer takes over).
 *
 * Entirely on the GPU: one Points draw, every mote wrapped in a box that travels with the camera
 * (positions = fract(seed + drift·t − camera) in the vertex shader), so the CPU cost is a handful
 * of uniforms a frame.
 */
const COUNT = ({ low: 90, medium: 180, high: 280, ultra: 380 } as Record<string, number>)[Settings.data.quality] ?? 220;
const BOX = new THREE.Vector3(26, 11, 26);

export class Motes {
  points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private t = 0;

  constructor(scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(COUNT * 3);
    const rnd = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = Math.random();
      seed[i * 3 + 2] = Math.random();
      rnd[i * 2] = Math.random();
      rnd[i * 2 + 1] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: BOX.clone() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uCol: { value: new THREE.Color(1, 0.9, 0.72) },
        uAmount: { value: 0 },
        uWind: { value: new THREE.Vector3(0.35, 0.02, 0.18) },
        uScale: { value: 600 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 rnd;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec3 uSunDir; uniform vec3 uWind; uniform float uScale;
        varying float vA; varying float vPhase;
        void main(){
          // drift with the wind plus a slow personal wander, wrapped into a box round the camera
          vec3 wander = vec3(sin(uTime * (0.3 + rnd.x * 0.4) + rnd.y * 6.28), sin(uTime * (0.21 + rnd.y * 0.3) + rnd.x * 9.0) * 0.6, cos(uTime * (0.27 + rnd.x * 0.3) + rnd.y * 4.0)) * 0.35;
          vec3 p = position * uBox + uWind * uTime * (0.6 + rnd.x * 0.8) + wander - (uCam - uBox * 0.5);
          p = mod(p, uBox) + uCam - uBox * 0.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          // forward scattering: specks glint when you look toward the light
          vec3 view = normalize(p - uCam);
          vPhase = pow(max(dot(view, uSunDir), 0.0), 6.0) * 2.6 + 0.22;
          // near / far fade (never a blob on the lens, gone before the box edge shows)
          vA = smoothstep(0.5, 1.6, d) * (1.0 - smoothstep(8.0, 12.5, d)) * (0.55 + 0.45 * sin(uTime * (1.3 + rnd.y * 2.0) + rnd.x * 30.0));
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((0.012 + rnd.y * 0.018) * uScale / max(d, 0.1), 1.0, 6.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; uniform float uAmount;
        varying float vA; varying float vPhase;
        void main(){
          vec2 q = gl_PointCoord - 0.5;
          float r = dot(q, q) * 4.0;
          float a = exp(-r * 3.5) * vA * vPhase * uAmount;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uCol * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 18;
    scene.add(this.points);
  }

  /**
   * cam: camera position; sunDir: the key light; day / night / golden: 0..1 from the environment;
   * weather: wet or snowy air hides them; fov: for the point scale.
   */
  update(dt: number, cam: THREE.Vector3, sunDir: THREE.Vector3, day: number, night: number, golden: number, weather: string, viewH: number, fov: number) {
    if (Settings.data.motes === false) {
      this.points.visible = false;
      return;
    }
    this.t += dt;
    const u = this.mat.uniforms;
    u.uTime.value = this.t;
    u.uCam.value.copy(cam);
    u.uSunDir.value.copy(sunDir);
    const wet = weather === 'rain' || weather === 'snow' || weather === 'storm' ? 0.15 : 1;
    // warm specks in the day (gold at golden hour), a few cold ones by moonlight
    u.uCol.value.setRGB(1.0, 0.9 - 0.12 * golden, 0.74 - 0.22 * golden).lerp(new THREE.Color(0.55, 0.75, 1.0), night);
    u.uAmount.value = (0.5 * day + 0.6 * golden + 0.18 * night) * wet;
    u.uScale.value = viewH / (2 * Math.tan((fov * Math.PI) / 360));
    this.points.visible = u.uAmount.value > 0.01;
  }
}
