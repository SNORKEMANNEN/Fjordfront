import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { TextureBaker } from '../render/TextureBaker';

/**
 * Smoke-grenade clouds as a small puff simulation (Update 31).
 *
 * Each canister pours out puffs: soft spheres that swell as they age, push each other apart, drift
 * with the wind (unless something roofs them over), rise a little and slide along walls instead of
 * passing through them. The pushing is what makes the smoke behave like a volume: in a room it
 * packs the space wall to wall, and the only way out is the door, so it pours out of doorways and
 * windows. Rain knocks it down faster. Sight lines (bots, the snapshot scan, the player's spotting)
 * test the actual puffs: a line through about a metre and a half of thick smoke is blocked.
 *
 * Drawn as camera-facing soft quads, one instanced draw for every cloud.
 */
interface Puff {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: number;
  rMax: number;
  dens: number;
  age: number;
  rot: number;
  shade: number;
  /** under a roof (no wind) — re-tested now and then */
  roofed: boolean;
  /** ground height under it (re-tested with the roof) */
  floor: number;
  cloud: Cloud;
  k: number;
}
interface Cloud { p: THREE.Vector3; t: number; life: number; acc: number; n: number; wet: boolean; id: number; lo: THREE.Vector3; hi: THREE.Vector3 }

const MAX = 360;
const PER_CLOUD = 90;

export class SmokeVolume {
  mesh: THREE.Mesh;
  private puffs: Puff[] = [];
  private clouds: Cloud[] = [];
  private aOff: Float32Array;
  private aSize: Float32Array;
  private aAlpha: Float32Array;
  private aRot: Float32Array;
  private aShade: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private frame = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  /** wind (m/s, world) and 0..1 rain, set by the game each frame */
  wind = new THREE.Vector3();
  rain = 0;
  /** 0..1 how lit the scene is (night smoke is dark grey, not glowing) */
  light = 1;
  /** puff budget scale from the quality preset */
  quality = 1;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, private physics: Physics, baker: TextureBaker) {
    const tex = baker.raw('fx.smokevol', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float n = tfbm(vUv*3.0, 3.0, 5);
      float a = smoothstep(1.0, 0.15, r) * (0.45 + 0.75*n);
      gl_FragColor = vec4(vec3(0.85 + 0.15*n), clamp(a*a*1.25, 0.0, 1.0)); }`, 128, false);
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    this.aOff = new Float32Array(MAX * 3);
    this.aSize = new Float32Array(MAX);
    this.aAlpha = new Float32Array(MAX);
    this.aRot = new Float32Array(MAX);
    this.aShade = new Float32Array(MAX);
    const ia = (a: Float32Array, n: number) => new THREE.InstancedBufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOff', ia(this.aOff, 3));
    g.setAttribute('aSize', ia(this.aSize, 1));
    g.setAttribute('aAlpha', ia(this.aAlpha, 1));
    g.setAttribute('aRot', ia(this.aRot, 1));
    g.setAttribute('aShade', ia(this.aShade, 1));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: tex }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        attribute vec3 aOff; attribute float aSize; attribute float aAlpha; attribute float aRot; attribute float aShade;
        varying vec2 vUv; varying float vA; varying float vS;
        void main(){
          vUv = uv; vA = aAlpha; vS = aShade;
          vec4 mv = viewMatrix * vec4(aOff, 1.0);
          float c = cos(aRot), s = sin(aRot);
          vec2 q = mat2(c, -s, s, c) * position.xy * aSize;
          mv.xy += q;
          // never a screen-filling quad right at the lens: shrink puffs the camera is inside
          float near = clamp((-mv.z - 0.3) / 1.2, 0.15, 1.0);
          vA *= near;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMap; uniform vec3 uLight;
        varying vec2 vUv; varying float vA; varying float vS;
        void main(){
          vec4 t = texture2D(tMap, vUv);
          float a = t.a * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(t.rgb * uLight * vS, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 16;
    this.mesh.layers.set(1);
    scene.add(this.mesh);
  }

  /** a canister started pouring (lasts `life` s) */
  start(p: THREE.Vector3, life: number, wet = false) {
    const c: Cloud = { p: p.clone(), t: 0, life, acc: 0, n: 0, wet, id: Math.random(), lo: p.clone(), hi: p.clone() };
    this.clouds.push(c);
    return c;
  }

  clear() {
    this.clouds.length = 0;
    this.puffs.length = 0;
    this.geo.instanceCount = 0;
  }

  update(dt: number) {
    this.frame++;
    const rainThin = 1 + this.rain * 2.2;
    // ---- emit
    const budget = Math.max(30, Math.round(PER_CLOUD * this.quality));
    for (let ci = this.clouds.length - 1; ci >= 0; ci--) {
      const c = this.clouds[ci];
      c.t += dt;
      if (c.t > c.life + 14) {
        this.clouds.splice(ci, 1);
        continue;
      }
      if (c.t < c.life) {
        // a hard gush at first, then a steady pour
        c.acc += dt * (c.t < 2.5 ? 26 : 9) * (c.wet ? 0.35 : 1);
        while (c.acc >= 1) {
          c.acc -= 1;
          if (c.n >= budget || this.puffs.length >= MAX) {
            // full: the canister keeps pushing into the cloud instead (pressure drives it out of
            // doorways and windows) rather than spawning more
            c.acc = 0;
            for (const q of this.puffs) {
              if (q.cloud !== c) continue;
              const dx = q.p.x - c.p.x, dz = q.p.z - c.p.z;
              const d = Math.max(0.5, Math.hypot(dx, dz));
              q.v.x += (dx / d) * 0.6 * dt * 9;
              q.v.z += (dz / d) * 0.6 * dt * 9;
            }
            break;
          }
          const a = Math.random() * Math.PI * 2;
          const sp = c.t < 2.5 ? 2.2 + Math.random() * 1.6 : 0.9 + Math.random() * 0.9;
          const p = c.p.clone().add(new THREE.Vector3(Math.cos(a) * 0.15, 0.25 + Math.random() * 0.2, Math.sin(a) * 0.15));
          const g = 0.62 + Math.random() * 0.14;
          this.puffs.push({
            p, v: new THREE.Vector3(Math.cos(a) * sp, 0.5 + Math.random() * 0.7, Math.sin(a) * sp), r: 0.35, rMax: 1.5 + Math.random() * 0.8, dens: 1, age: 0,
            rot: Math.random() * 6.28, shade: g, roofed: false, floor: c.p.y, cloud: c, k: this.puffs.length,
          });
          c.n++;
          this.probe(this.puffs[this.puffs.length - 1]);
        }
      }
    }
    // ---- simulate
    const P = this.puffs;
    const n = P.length;
    for (const c of this.clouds) {
      c.lo.set(1e9, 1e9, 1e9);
      c.hi.set(-1e9, -1e9, -1e9);
    }
    for (let i = n - 1; i >= 0; i--) {
      const q = P[i];
      q.age += dt;
      const c = q.cloud;
      // swell, then thin out after the canister stops (faster in rain and underwater)
      q.r += (q.rMax - q.r) * Math.min(1, dt * 0.45);
      const over = c.t - c.life;
      const fade = over > 0 ? Math.max(0, 1 - over / 12) : 1;
      q.dens = Math.min(1, q.age * 3) * fade * Math.max(0, 1 - Math.max(0, q.age - 24) / 10) * (c.wet ? 0.6 : 1);
      q.dens *= Math.max(0, 1 - this.rain * 0.025 * q.age * rainThin * 0.3);
      if (q.dens <= 0.01 && q.age > 1) {
        P.splice(i, 1);
        c.n--;
        continue;
      }
      // wind (not under a roof), a little buoyancy, drag
      const wk = q.roofed ? 0.05 : 0.28;
      q.v.x += (this.wind.x * wk - q.v.x) * Math.min(1, dt * 0.6);
      q.v.z += (this.wind.z * wk - q.v.z) * Math.min(1, dt * 0.6);
      q.v.y += (0.06 - q.v.y) * Math.min(1, dt * 0.9);
    }
    // spread: overlapping puffs of one cloud push apart (the volume fills its space)
    const m = P.length;
    for (let i = 0; i < m; i++) {
      const a = P[i];
      for (let j = i + 1; j < m; j++) {
        const b = P[j];
        if (a.cloud !== b.cloud) continue;
        const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, dz = b.p.z - a.p.z;
        const want = (a.r + b.r) * (a.roofed ? 0.72 : 0.62);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= want * want || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = ((want - d) / want) * (a.roofed ? 3.4 : 2.4) * dt;
        const ux = dx / d, uy = dy / d * 0.35, uz = dz / d;
        a.v.x -= ux * push; a.v.y -= uy * push; a.v.z -= uz * push;
        b.v.x += ux * push; b.v.y += uy * push; b.v.z += uz * push;
      }
    }
    // move, sliding along walls (each puff checks the world every few frames, looking ahead)
    for (let i = 0; i < m; i++) {
      const q = P[i];
      if ((i + this.frame) % 4 === 0) {
        const sp = q.v.length();
        if (sp > 0.02) {
          const dir = this.tmp.copy(q.v).divideScalar(sp);
          const hit = this.physics.raycast(q.p, dir, sp * dt * 4 + q.r * 0.55);
          if (hit) {
            const nn = hit.normal;
            const into = q.v.dot(nn);
            if (into < 0) q.v.addScaledVector(nn, -into * 1.15);
          }
        }
        if ((i + this.frame) % 40 === 0) this.probe(q);
      }
      q.p.addScaledVector(q.v, dt);
      // keep off the floor / out of the ground
      const fl = q.floor + q.r * 0.45;
      if (q.p.y < fl) {
        q.p.y = fl;
        if (q.v.y < 0) q.v.y = 0;
      }
      q.rot += dt * 0.05 * (q.k % 2 ? 1 : -1);
      const c = q.cloud;
      c.lo.min(this.tmp2.copy(q.p).subScalar(q.r));
      c.hi.max(this.tmp2.copy(q.p).addScalar(q.r));
    }
    // ---- draw
    const L = this.light;
    this.mat.uniforms.uLight.value.setRGB(0.18 + 0.82 * L, 0.18 + 0.82 * L, 0.2 + 0.8 * L);
    for (let i = 0; i < m; i++) {
      const q = P[i];
      this.aOff[i * 3] = q.p.x;
      this.aOff[i * 3 + 1] = q.p.y;
      this.aOff[i * 3 + 2] = q.p.z;
      this.aSize[i] = q.r * 2.5;
      this.aAlpha[i] = q.dens * 0.62;
      this.aRot[i] = q.rot;
      this.aShade[i] = q.shade;
    }
    this.geo.instanceCount = m;
    for (const k of ['aOff', 'aSize', 'aAlpha', 'aRot', 'aShade']) (this.geo.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** roof and floor under a puff */
  private probe(q: Puff) {
    const up = this.physics.raycast(q.p, this.tmp.set(0, 1, 0), 9);
    q.roofed = !!up;
    const down = this.physics.raycast(q.p, this.tmp.set(0, -1, 0), 6);
    q.floor = down ? down.point.y : q.p.y - 6;
  }

  /** optical depth (≈ metres of thick smoke) along a segment */
  depth(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.puffs.length) return 0;
    const d = this.tmp.copy(b).sub(a);
    const len = d.length();
    if (len < 1e-3) return 0;
    d.divideScalar(len);
    let depth = 0;
    for (const c of this.clouds) {
      // skip clouds whose bounds the segment cannot touch
      if (Math.max(a.x, b.x) < c.lo.x || Math.min(a.x, b.x) > c.hi.x || Math.max(a.z, b.z) < c.lo.z || Math.min(a.z, b.z) > c.hi.z) continue;
      for (const q of this.puffs) {
        if (q.cloud !== c || q.dens < 0.05) continue;
        const ox = q.p.x - a.x, oy = q.p.y - a.y, oz = q.p.z - a.z;
        const t = Math.max(0, Math.min(len, ox * d.x + oy * d.y + oz * d.z));
        const mx = ox - d.x * t, my = oy - d.y * t, mz = oz - d.z * t;
        const m2 = mx * mx + my * my + mz * mz;
        const r = q.r * 0.8;
        if (m2 >= r * r) continue;
        depth += 2 * Math.sqrt(r * r - m2) * q.dens * 0.5;
      }
    }
    return depth;
  }

  /** a sight line through about a metre and a half of thick smoke (or standing in it) is blocked */
  blocks(a: THREE.Vector3, b: THREE.Vector3) {
    return this.depth(a, b) > 1.5;
  }

  /** how deep in smoke a point is (0 = clear, 1 = inside a thick cloud) — for the screen tint */
  inside(p: THREE.Vector3) {
    let k = 0;
    for (const q of this.puffs) {
      const d2 = q.p.distanceToSquared(p);
      const r = q.r * 0.9;
      if (d2 < r * r) k += (1 - Math.sqrt(d2) / r) * q.dens;
    }
    return Math.min(1, k * 0.8);
  }
}
