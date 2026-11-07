import * as THREE from 'three';

/**
 * Ambient life, cheap by construction (one instanced draw for every bird, wings flapped in the
 * vertex shader, CPU work ~O(birds) at 30 Hz):
 *  - a flock of gulls wheeling over the harbour, gliding with the odd lazy flap
 *  - crows feeding in small groups on the fields and the shore: gunfire or an explosion nearby
 *    and they burst up with fast wingbeats, scatter, circle, and settle somewhere else
 *  - wood smoke curling from the chimneys nearest you, leaning with the wind
 */
interface Bird {
  p: THREE.Vector3;
  v: THREE.Vector3;
  flock: number;
  phase: number;
  /** wingbeat rate (0 = folded, sitting) */
  rate: number;
  off: THREE.Vector3;
}
interface Flock {
  kind: 'gull' | 'crow';
  center: THREE.Vector3;
  state: 'circle' | 'sit' | 'flee' | 'land';
  t: number;
  home: THREE.Vector3;
  target: THREE.Vector3;
  r: number;
}

export class Ambient {
  private birds: Bird[] = [];
  private flocks: Flock[] = [];
  private mesh: THREE.InstancedMesh;
  private rates: THREE.InstancedBufferAttribute;
  private phases: THREE.InstancedBufferAttribute;
  private uTime = { value: 0 };
  private acc = 0;
  private o = new THREE.Object3D();
  private smokeT = 0;
  private nearChimneys: THREE.Vector3[] = [];
  private chimneyScanT = 0;
  /** played by the game when a flock takes off near the listener */
  onTakeoff: (p: THREE.Vector3) => void = () => {};

  constructor(scene: THREE.Scene, private heightAt: (x: number, z: number) => number, private chimneys: THREE.Vector3[], crowSpots: THREE.Vector3[]) {
    // a bird: a small body and two wings (V), wing tips flap by |x| in the shader
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([
      // left wing
      0, 0, 0.05, -0.38, 0.02, -0.02, 0, 0, -0.08,
      // right wing
      0, 0, 0.05, 0, 0, -0.08, 0.38, 0.02, -0.02,
      // body (thin wedge)
      0, 0.012, 0.16, -0.025, 0, -0.14, 0.025, 0, -0.14,
      0, -0.012, 0.16, 0.025, 0, -0.14, -0.025, 0, -0.14,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    const N = 14 + 3 * 9;
    this.rates = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.phases = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    g.setAttribute('aRate', this.rates);
    g.setAttribute('aPhase', this.phases);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRate; attribute float aPhase; uniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float flap = sin(uTime * aRate + aPhase);
          transformed.y += flap * abs(position.x) * (aRate > 0.5 ? 0.9 : 0.0) - (aRate > 0.5 ? 0.0 : abs(position.x) * 0.5);
          transformed.x *= aRate > 0.5 ? 1.0 : 0.35;`);
    };
    mat.customProgramCacheKey = () => 'birds';
    this.mesh = new THREE.InstancedMesh(g, mat, N);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);
    this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    // gulls (white-ish) over the harbour
    const gulls: Flock = { kind: 'gull', center: new THREE.Vector3(0, 30, 135), state: 'circle', t: 0, home: new THREE.Vector3(0, 30, 135), target: new THREE.Vector3(), r: 45 };
    this.flocks.push(gulls);
    for (let i = 0; i < 14; i++) this.birds.push({ p: gulls.center.clone().add(new THREE.Vector3(Math.random() * 30 - 15, Math.random() * 8, Math.random() * 30 - 15)), v: new THREE.Vector3(), flock: 0, phase: Math.random() * 6.28, rate: 0, off: new THREE.Vector3(Math.random() * 18 - 9, Math.random() * 6 - 3, Math.random() * 18 - 9) });
    // three crow groups on the ground
    for (let f = 0; f < 3; f++) {
      const spot = crowSpots[f % Math.max(1, crowSpots.length)] ?? new THREE.Vector3(f * 30 - 30, 0, 40);
      const home = spot.clone().setY(this.heightAt(spot.x, spot.z));
      const fl: Flock = { kind: 'crow', center: home.clone(), state: 'sit', t: Math.random() * 10, home, target: home.clone(), r: 3 };
      this.flocks.push(fl);
      for (let i = 0; i < 9; i++) {
        const off = new THREE.Vector3(Math.random() * 6 - 3, 0, Math.random() * 6 - 3);
        const p = home.clone().add(off);
        p.y = this.heightAt(p.x, p.z) + 0.06;
        this.birds.push({ p, v: new THREE.Vector3(), flock: f + 1, phase: Math.random() * 6.28, rate: 0, off });
      }
    }
    const gullC = new THREE.Color(0.86, 0.87, 0.88), crowC = new THREE.Color(0.06, 0.06, 0.07);
    for (let i = 0; i < this.birds.length; i++) {
      this.phases.setX(i, this.birds[i].phase);
      this.mesh.setColorAt(i, this.birds[i].flock === 0 ? gullC : crowC);
    }
  }

  /** A shot / bang at p: sitting flocks within range take off. */
  scare(p: THREE.Vector3, range = 45) {
    for (const f of this.flocks) {
      if (f.kind !== 'crow' || (f.state !== 'sit' && f.state !== 'land')) continue;
      if (f.center.distanceToSquared(p) > range * range) continue;
      f.state = 'flee';
      f.t = 0;
      // somewhere 60–110 m away, away from the noise
      const away = f.center.clone().sub(p).setY(0);
      if (away.lengthSq() < 1) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      away.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 1.4);
      const d = 60 + Math.random() * 50;
      const t = f.center.clone().addScaledVector(away, d);
      t.x = THREE.MathUtils.clamp(t.x, -170, 170);
      t.z = THREE.MathUtils.clamp(t.z, -170, 170);
      t.y = this.heightAt(t.x, t.z);
      if (t.y < 1.2) t.copy(f.home); // not into the water: go home instead
      f.target.copy(t);
      for (const b of this.birds) if (b.flock === this.flocks.indexOf(f)) {
        b.v.set((Math.random() - 0.5) * 4, 5 + Math.random() * 3, (Math.random() - 0.5) * 4).addScaledVector(away, 3);
      }
      this.onTakeoff(f.center);
    }
  }

  update(dt: number, cam: THREE.Vector3, wind: THREE.Vector3, smoke: (p: THREE.Vector3, v: THREE.Vector3) => void) {
    this.uTime.value += dt;
    // ---- chimney smoke (nearest few, a puff every ~0.4 s each)
    this.chimneyScanT -= dt;
    if (this.chimneyScanT <= 0) {
      this.chimneyScanT = 2;
      this.nearChimneys = this.chimneys
        .map((c) => ({ c, d: c.distanceToSquared(cam) }))
        .filter((x) => x.d < 160 * 160)
        .sort((a, b) => a.d - b.d)
        .slice(0, 6)
        .map((x) => x.c);
    }
    this.smokeT -= dt;
    if (this.smokeT <= 0 && this.nearChimneys.length) {
      this.smokeT = 0.4 / this.nearChimneys.length;
      const c = this.nearChimneys[Math.floor(Math.random() * this.nearChimneys.length)];
      smoke(c, new THREE.Vector3(wind.x * 0.25 + (Math.random() - 0.5) * 0.2, 0.7 + Math.random() * 0.3, wind.z * 0.25 + (Math.random() - 0.5) * 0.2));
    }
    // ---- birds at 30 Hz
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const h = this.acc;
    this.acc = 0;
    const T = this.uTime.value;
    for (let fi = 0; fi < this.flocks.length; fi++) {
      const f = this.flocks[fi];
      f.t += h;
      if (f.kind === 'gull') {
        // the flock centre wanders round the harbour
        f.center.set(f.home.x + Math.cos(T * 0.05) * f.r, f.home.y + Math.sin(T * 0.13) * 4, f.home.z + Math.sin(T * 0.05) * f.r * 0.6);
      } else if (f.state === 'flee') {
        const to = f.target.clone().sub(f.center);
        const d = to.length();
        f.center.addScaledVector(to.normalize(), Math.min(d, 9 * h));
        f.center.y = Math.max(f.center.y, this.heightAt(f.center.x, f.center.z) + 12 + Math.sin(f.t * 0.8) * 3);
        if (f.t > 6 && d < 12) {
          f.state = 'land';
          f.t = 0;
        }
      } else if (f.state === 'land') {
        f.center.lerp(f.target, 1 - Math.exp(-h * 1.2));
        if (f.t > 4) {
          f.state = 'sit';
          f.center.copy(f.target);
        }
      }
    }
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const f = this.flocks[b.flock];
      let want: THREE.Vector3;
      let rate = 0;
      if (f.kind === 'gull') {
        want = f.center.clone().add(new THREE.Vector3(Math.cos(T * 0.3 + b.phase) * b.off.x, b.off.y + Math.sin(T * 0.4 + b.phase) * 2, Math.sin(T * 0.3 + b.phase) * b.off.z));
        // mostly gliding, the odd few beats
        rate = Math.sin(T * 0.7 + b.phase * 3) > 0.6 ? 9 : 0.9;
      } else if (f.state === 'sit') {
        want = f.center.clone().add(b.off);
        want.y = this.heightAt(want.x, want.z) + 0.06;
        // a hop now and then
        if (Math.random() < h * 0.15) b.off.add(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.8)).clampLength(0, 4);
        rate = 0;
      } else {
        want = f.center.clone().add(new THREE.Vector3(b.off.x * 1.5, Math.sin(T + b.phase) * 1.5 + 2, b.off.z * 1.5));
        rate = f.state === 'flee' ? 20 : 11;
        if (f.state === 'land' && f.t > 2.5) {
          want = f.target.clone().add(b.off);
          want.y = this.heightAt(want.x, want.z) + 0.06;
        }
      }
      const stiff = f.state === 'sit' ? 8 : 1.6;
      b.v.lerp(want.clone().sub(b.p).multiplyScalar(stiff), 1 - Math.exp(-h * 2.5));
      b.p.addScaledVector(b.v, h);
      b.rate = rate;
      this.rates.setX(i, rate);
      // orient along the flight direction (sitting birds face their last heading, level)
      const o = this.o;
      o.position.copy(b.p);
      const hv = b.v.lengthSq() > 0.04 ? b.v : null;
      if (hv && rate > 0.5) o.lookAt(b.p.clone().add(hv));
      else o.rotation.set(0, b.phase, 0);
      o.scale.setScalar(f.kind === 'gull' ? 1.25 : 0.8);
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rates.needsUpdate = true;
  }
}
