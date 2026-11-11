import * as THREE from 'three';
import { Physics } from '../core/Physics';
import type { Environment } from '../world/Environment';

/**
 * Night-vision goggles: the image-intensifier look and its power cycle.
 *
 * The goggles themselves (the hand flipping them down / up) are a viewmodel action; when the
 * tubes reach the eyes `engage()` starts the power-up, `disengage()` the power-down.
 *
 *  - Image: the grade pass converts the scene's linear luminance (red / near-IR weighted, like a
 *    photocathode) through an intensifier curve with automatic gain — bright at night, compressed
 *    in daylight — tints it phosphor green, adds the sparkly scintillation noise of a tube that is
 *    working hard, slight tube flicker and the binocular eyepiece mask
 *  - Power-up: a beat of black, the tubes flare (bright green bloom) and settle; power-down
 *    collapses to black and the normal view fades back in
 *  - IR: a head-mounted IR illuminator lights what you look at (invisible without goggles),
 *    people glow (body heat / IR reflective kit), and the IR aiming lasers on the K416, MP7 and
 *    pump become visible as a beam with a dot on whatever they touch
 */
type Phase = 'off' | 'up' | 'on' | 'down';

export class NightVision {
  phase: Phase = 'off';
  private t = 0;
  /** 0..1 how much of the screen is the NVG image (1 while on, blends at the end of power-down) */
  vis = 0;
  /** tube brightness 0..~1.2 */
  power = 0;
  flash = 0;
  /** smoothed automatic gain */
  gain = 10;
  /** IR illuminator strength for the grade shader (screen-space cone lit by depth) */
  illum = 0;
  private beam: THREE.Mesh;
  private dot: THREE.Sprite;
  private irMats = new Map<THREE.MeshStandardMaterial, { c: THREE.Color; i: number }>();
  private irK = 0;

  constructor(private scene: THREE.Scene, private physics: Physics) {
    const bm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uA: { value: 0 }, uT: { value: 0 } },
      vertexShader: `varying float vV; void main(){ vV = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uA; uniform float uT; varying float vV;
        void main(){
          float f = pow(1.0 - clamp(vV, 0.0, 1.0), 0.55);
          float shimmer = 0.85 + 0.15 * sin(vV * 140.0 - uT * 40.0);
          gl_FragColor = vec4(vec3(0.85, 1.0, 0.9) * uA * f * shimmer, 1.0);
        }`,
    });
    // unit-length beam along +Y (scaled & aimed each frame)
    const g = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    g.translate(0, 0.5, 0);
    this.beam = new THREE.Mesh(g, bm);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.beam.renderOrder = 6;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    this.dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xd8ffe0 }));
    this.dot.visible = false;
    this.dot.renderOrder = 7;
    scene.add(this.beam, this.dot);
  }

  get active() {
    return this.phase === 'up' || this.phase === 'on';
  }

  engage() {
    if (this.active) return;
    this.phase = 'up';
    this.t = 0;
  }
  disengage() {
    if (!this.active) return;
    this.phase = 'down';
    this.t = 0;
  }
  /** instant off (death, new match) */
  reset() {
    this.phase = 'off';
    this.vis = this.power = this.flash = 0;
    this.t = 0;
  }

  /** Materials that read hot / IR-bright under the goggles (the soldiers). */
  addIRTargets(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (sm.isMeshStandardMaterial && !this.irMats.has(sm)) this.irMats.set(sm, { c: sm.emissive.clone(), i: sm.emissiveIntensity });
      }
    });
  }

  update(dt: number, env: Environment, camera: THREE.Camera, laser: { from: THREE.Vector3; dir: THREE.Vector3 } | null) {
    this.t += dt;
    const t = this.t;
    // ---- power cycle ----
    if (this.phase === 'up') {
      this.vis = 1;
      // a beat of black, then the tubes flare up and settle
      this.power = t < 0.07 ? 0 : t < 0.32 ? 1.35 * smooth((t - 0.07) / 0.25) * (0.75 + 0.25 * Math.sin(t * 90)) : 1 + 0.35 * Math.exp(-(t - 0.32) * 7);
      this.flash = t < 0.07 ? 0 : 0.55 * Math.exp(-(t - 0.07) * 6);
      if (t > 1.0) this.phase = 'on';
    } else if (this.phase === 'on') {
      this.vis = 1;
      this.power = 1;
      this.flash = 0;
    } else if (this.phase === 'down') {
      // collapse to black, then the naked-eye view fades back in
      this.power = t < 0.14 ? 1 - smooth(t / 0.14) : 0;
      this.flash = t < 0.05 ? 0.25 * (1 - t / 0.05) : 0;
      this.vis = t < 0.16 ? 1 : 1 - smooth((t - 0.16) / 0.32);
      if (t > 0.5) this.phase = 'off';
    } else {
      this.vis = this.power = this.flash = 0;
    }
    // ---- automatic gain: lots at night, compressed in daylight ----
    const want = THREE.MathUtils.lerp(72, 2.6, Math.pow(THREE.MathUtils.clamp(env.day, 0, 1), 0.6));
    this.gain += (want - this.gain) * (1 - Math.exp(-dt * 2.5));
    // ---- IR illuminator on the goggles ----
    const on = this.active ? Math.min(1, this.power) : 0;
    const cam = camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    // (done in the grade shader: lights the near scene in a cone around the view centre, by depth;
    // no real light in the scene, so it costs nothing to every other shader)
    this.illum = 1.35 * on * (1 - env.day * 0.85);
    void cam;
    void fwd;
    // ---- people glow ----
    const ir = on * (1 - env.day * 0.6);
    if (Math.abs(ir - this.irK) > 0.01) {
      this.irK = ir;
      for (const [m, o] of this.irMats) {
        m.emissive.copy(o.c).lerp(new THREE.Color(0.55, 0.55, 0.55), Math.min(1, ir * 0.5));
        m.emissiveIntensity = o.i + ir * 0.12;
      }
    }
    // ---- IR aiming laser ----
    const showLaser = !!laser && this.vis > 0.5 && this.power > 0.3;
    this.beam.visible = this.dot.visible = showLaser;
    if (showLaser && laser) {
      const hit = this.physics.raycast(laser.from, laser.dir, 160);
      const len = hit ? hit.distance : 160;
      this.beam.position.copy(laser.from);
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), laser.dir);
      this.beam.scale.set(0.0035, len, 0.0035);
      const bu = (this.beam.material as THREE.ShaderMaterial).uniforms;
      bu.uA.value = 0.55 * Math.min(1, this.power);
      bu.uT.value += dt;
      if (hit) {
        this.dot.visible = true;
        this.dot.position.copy(hit.point).addScaledVector(hit.normal, 0.01);
        const d = hit.point.distanceTo(cam);
        this.dot.scale.setScalar(0.035 + d * 0.0045);
        this.dot.material.opacity = 0.9 * Math.min(1, this.power);
      } else this.dot.visible = false;
    }
  }
}

function smooth(x: number) {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}
