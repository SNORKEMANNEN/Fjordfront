import * as THREE from 'three';

/** flicker: 'fluoro' tube that stutters now and then, 'old' tired bulb, 'beacon' rotating emergency light (Update 33) */
export interface Anchor { p: THREE.Vector3; color: number; intensity: number; dist: number; night: boolean; broken?: boolean; flicker?: 'fluoro' | 'old' | 'beacon'; phase?: number }

/**
 * A small pool of point lights is re-assigned to the light fixtures nearest the camera,
 * so hundreds of lamps can exist without hundreds of forward-lit lights.
 * Interior fixtures are always on (warmer and stronger at night); street lamps only at night.
 */
export class LightPool {
  private lights: THREE.PointLight[] = [];
  private anchors: Anchor[] = [];
  private timer = 0;
  private t = 0;
  private assigned: (Anchor | null)[] = [];

  constructor(parent: THREE.Object3D, n = 6) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffc080, 0, 10, 2);
      l.castShadow = false;
      parent.add(l);
      this.lights.push(l);
      this.assigned.push(null);
    }
  }

  add(p: THREE.Vector3, color: number, intensity: number, dist: number, night = false) {
    const a: Anchor = { p, color, intensity, dist, night };
    this.anchors.push(a);
    return a;
  }
  /** a shot-out light goes dark now (not at the next 0.35 s reassignment) */
  kill(a: Anchor) {
    a.broken = true;
    this.timer = 0;
  }
  /** all lights back on (new match) */
  repairAll() {
    for (const a of this.anchors) a.broken = false;
    this.timer = 0;
  }

  /** brightness multiplier for a flickering fixture */
  private flick(a: Anchor) {
    const t = this.t, ph = a.phase ?? 0;
    if (a.flicker === 'fluoro') {
      // steady, then every so often a burst of stuttering
      const burst = Math.sin(t * 0.31 + ph) * Math.sin(t * 1.07 + ph * 3.1);
      return burst > 0.9 ? (Math.sin(t * 57 + ph) > 0.2 ? 1 : 0.12) : 1;
    }
    if (a.flicker === 'old') {
      const w = 0.92 + 0.08 * Math.sin(t * 7.3 + ph) * Math.sin(t * 3.1 + ph * 2);
      const dip = Math.sin(t * 0.53 + ph) > 0.97 ? 0.35 : 1;
      return w * dip;
    }
    if (a.flicker === 'beacon') return 0.12 + 0.88 * Math.pow(Math.max(0, Math.sin(t * 3.6 + ph)), 5);
    return 1;
  }

  update(dt: number, cam: THREE.Vector3, nightAmt: number, dayDim: number) {
    this.t += dt;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.35;
      const scored = this.anchors
        .filter((a) => !a.broken && (!a.night || nightAmt > 0.2))
        .map((a) => ({ a, d: a.p.distanceToSquared(cam) / (a.dist * a.dist) }))
        .filter((x) => x.d < 9)
        .sort((x, y) => x.d - y.d)
        .slice(0, this.lights.length);
      for (let i = 0; i < this.lights.length; i++) this.assigned[i] = scored[i]?.a ?? null;
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const a = this.assigned[i];
      if (!a) {
        l.intensity = Math.max(0, l.intensity - dt * 20);
        continue;
      }
      l.position.copy(a.p);
      l.color.setHex(a.color);
      l.distance = a.dist;
      const want = a.intensity * (a.night ? nightAmt : 0.55 + nightAmt * 0.6 + (1 - dayDim) * 0.3);
      if (a.flicker) l.intensity = want * this.flick(a);
      else l.intensity += (want - l.intensity) * Math.min(1, dt * 6);
    }
  }
}

/** Volumetric-looking light shafts streaming through sun-facing windows. */
export class SunShafts {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private lastDir = new THREE.Vector3();

  constructor(parent: THREE.Object3D, private windows: { c: THREE.Vector3; n: THREE.Vector3; w: number; h: number }[]) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new THREE.Color(1, 0.85, 0.65) } },
      vertexShader: /* glsl */ `
        attribute float aLen; varying float vLen; varying vec3 vW;
        void main(){ vLen = aLen; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uStrength; uniform vec3 uColor;
        varying float vLen; varying vec3 vW;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(h(i), h(i+vec3(1,0,0)), f.x), mix(h(i+vec3(0,1,0)), h(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(h(i+vec3(0,0,1)), h(i+vec3(1,0,1)), f.x), mix(h(i+vec3(0,1,1)), h(i+vec3(1,1,1)), f.x), f.y), f.z); }
        void main(){
          float dust = 0.55 + 0.45 * n3(vW * 3.0 + vec3(0.0, uTime * 0.15, uTime * 0.05));
          float fade = (1.0 - vLen) * smoothstep(0.0, 0.08, vLen);
          float camFade = smoothstep(0.4, 1.6, length(vW - cameraPosition));
          gl_FragColor = vec4(uColor * dust * fade * camFade * uStrength * 0.16, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.layers.set(1);
    parent.add(this.mesh);
  }

  /** Rebuild beam volumes for the current sun direction (only windows the sun shines into). */
  rebuild(sunDir: THREE.Vector3) {
    if (sunDir.angleTo(this.lastDir) < 0.03) return;
    this.lastDir.copy(sunDir);
    const pos: number[] = [], len: number[] = [];
    const travel = sunDir.clone().negate();
    for (const wnd of this.windows) {
      const facing = wnd.n.dot(sunDir);
      if (facing < 0.12) continue;
      const right = new THREE.Vector3().crossVectors(wnd.n, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const L = 4.5;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => wnd.c.clone().addScaledVector(right, (a * wnd.w) / 2).addScaledVector(up, (b * wnd.h) / 2).addScaledVector(wnd.n, -0.05));
      const far = corners.map((c) => c.clone().addScaledVector(travel, L));
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4], c = far[(i + 1) % 4], d = far[i];
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
        len.push(0, 0, 1, 0, 1, 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  update(dt: number, strength: number, color: THREE.Color) {
    this.mat.uniforms.uTime.value += dt;
    this.mat.uniforms.uStrength.value = strength;
    this.mat.uniforms.uColor.value.copy(color);
    this.mesh.visible = strength > 0.01;
  }
}

/**
 * Lights you can shoot out: every interior fixture and street lamp is a small target box around
 * its glowing part. A round through it kills the pooled light and drops a dark, cracked cover
 * over the emissive geometry (one instanced draw for all of them).
 */
export class ShootableLights {
  items: { m: THREE.Matrix4; inv: THREE.Matrix4; min: THREE.Vector3; max: THREE.Vector3; c: THREE.Vector3; r: number; anchor: Anchor; broken: boolean; street: boolean }[] = [];
  private covers: THREE.InstancedMesh;
  private n = 0;
  constructor(parent: THREE.Object3D, private pool: LightPool) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.35, metalness: 0.4 });
    this.covers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 512);
    this.covers.count = 0;
    this.covers.frustumCulled = false;
    this.covers.layers.set(1);
    parent.add(this.covers);
  }
  add(m: THREE.Matrix4, min: THREE.Vector3, max: THREE.Vector3, anchor: Anchor, street: boolean) {
    const c = min.clone().add(max).multiplyScalar(0.5).applyMatrix4(m);
    const r = max.clone().sub(min).length() * 0.5;
    this.items.push({ m, inv: m.clone().invert(), min, max, c, r, anchor, broken: false, street });
  }
  /** First intact light hit by the ray before `maxDist`, if any. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number) {
    let best: (typeof this.items)[number] | null = null, bt = maxDist;
    const lo = new THREE.Vector3(), ld = new THREE.Vector3(), tmp = new THREE.Vector3();
    const ray = new THREE.Ray();
    const box = new THREE.Box3();
    for (const it of this.items) {
      if (it.broken) continue;
      // cheap sphere reject, then the exact (slightly padded) box in fixture space
      tmp.subVectors(it.c, o);
      const t = tmp.dot(d);
      if (t < 0 || t > bt + it.r) continue;
      if (tmp.lengthSq() - t * t > (it.r + 0.05) * (it.r + 0.05)) continue;
      lo.copy(o).applyMatrix4(it.inv);
      ld.copy(o).add(d).applyMatrix4(it.inv).sub(lo).normalize();
      ray.set(lo, ld);
      box.min.copy(it.min).subScalar(0.03);
      box.max.copy(it.max).addScalar(0.03);
      const hit = ray.intersectBox(box, tmp);
      if (!hit) continue;
      const dist = hit.applyMatrix4(it.m).distanceTo(o);
      if (dist < bt) {
        bt = dist;
        best = it;
      }
    }
    return best ? { item: best, dist: bt } : null;
  }
  breakLight(it: (typeof this.items)[number]) {
    if (it.broken) return;
    it.broken = true;
    this.pool.kill(it.anchor);
    if (this.n < 512) {
      const size = it.max.clone().sub(it.min).addScalar(0.012);
      const ctr = it.min.clone().add(it.max).multiplyScalar(0.5);
      this.covers.setMatrixAt(this.n++, it.m.clone().multiply(new THREE.Matrix4().compose(ctr, new THREE.Quaternion(), size)));
      this.covers.count = this.n;
      this.covers.instanceMatrix.needsUpdate = true;
    }
  }
  repairAll() {
    for (const it of this.items) it.broken = false;
    this.n = 0;
    this.covers.count = 0;
    this.pool.repairAll();
  }
}
