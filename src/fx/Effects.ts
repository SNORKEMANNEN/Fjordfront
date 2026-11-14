import * as THREE from 'three';
import { Settings } from '../game/Settings';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TextureBaker } from '../render/TextureBaker';
import { Surface } from '../core/Physics';

const MAX_P = 3000;

/** CPU-simulated particle pool rendered as one Points draw call. */
/** largest particle on screen in px, by quality (overdraw in smoke is the cost) */
const MAX_PX = ({ low: 220, medium: 320, high: 420, ultra: 512 } as Record<string, number>)[Settings.data.quality] ?? 420;

class ParticlePool {
  points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private grow: Float32Array;
  private baseA: Float32Array;
  private rot: Float32Array;
  private next = 0;
  alive = 0;

  constructor(tex: THREE.Texture, additive: boolean, softness = 1) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_P * 3);
    this.col = new Float32Array(MAX_P * 4);
    this.size = new Float32Array(MAX_P);
    this.rot = new Float32Array(MAX_P);
    this.vel = new Float32Array(MAX_P * 3);
    this.life = new Float32Array(MAX_P);
    this.maxLife = new Float32Array(MAX_P);
    this.drag = new Float32Array(MAX_P);
    this.grav = new Float32Array(MAX_P);
    this.grow = new Float32Array(MAX_P);
    this.baseA = new Float32Array(MAX_P);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: tex }, uScale: { value: 600 }, uMaxPx: { value: MAX_PX }, fogColor: { value: new THREE.Color() }, fogNear: { value: 0 }, fogFar: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 color; attribute float size; attribute float rot;
        varying vec4 vC; varying float vR;
        uniform float uScale; uniform float uMaxPx;
        void main(){
          vC = color; vR = rot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // (capped: a smoke puff right at the camera would otherwise be a screen-sized quad of overdraw)
          gl_PointSize = clamp(size * uScale / -mv.z, 0.0, uMaxPx);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMap; varying vec4 vC; varying float vR;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vR), s = sin(vR);
          p = mat2(c, -s, s, c) * p + 0.5;
          vec4 t = texture2D(tMap, p);
          gl_FragColor = vec4(vC.rgb * t.rgb, vC.a * t.a);
          if (gl_FragColor.a < 0.004) discard;
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    void softness;
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 15;
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color | [number, number, number], alpha: number, size: number, life: number, opts: { drag?: number; grav?: number; grow?: number } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_P;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    const c = Array.isArray(color) ? color : [color.r, color.g, color.b];
    this.col[i * 4] = c[0]; this.col[i * 4 + 1] = c[1]; this.col[i * 4 + 2] = c[2]; this.col[i * 4 + 3] = alpha;
    this.baseA[i] = alpha;
    this.size[i] = size;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = opts.drag ?? 1;
    this.grav[i] = opts.grav ?? 0;
    this.grow[i] = opts.grow ?? 0;
  }

  update(dt: number) {
    let alive = 0;
    for (let i = 0; i < MAX_P; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.rot[i] += dt * 0.4;
      const k = this.life[i] / this.maxLife[i];
      this.col[i * 4 + 3] = this.baseA[i] * Math.min(1, k * 2.5) * Math.min(1, (1 - k) * 12 + 0.2);
    }
    this.alive = alive;
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('rot') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const Z_NEG = new THREE.Vector3(0, 0, -1);
interface Tracer { idx: number; from: THREE.Vector3; dir: THREE.Vector3; dist: number; maxDist: number; speed: number; alive: boolean }
interface Shell { mesh: THREE.Mesh; vel: THREE.Vector3; ang: THREE.Vector3; life: number; bounced: number; alive: boolean }

export class Effects {
  smoke: ParticlePool;
  sparks: ParticlePool;
  dust: ParticlePool;
  private tracers: Tracer[] = [];
  private tracerMesh!: THREE.InstancedMesh;
  private tracerO = new THREE.Object3D();
  private shells: Shell[] = [];
  /** every bullet hole / scorch mark in ONE instanced draw (was up to 160 transparent meshes,
   *  each drawn in the main and the AO transparency passes) */
  private decals!: THREE.InstancedMesh;
  private decalIdx = 0;
  private decalN = 0;
  private decalCols: Record<string, THREE.Color> = {};
  private decalO = new THREE.Object3D();
  private shellGeo: Record<string, THREE.BufferGeometry> = {};
  private shellMat: THREE.Material;
  private shotgunShellMat: THREE.Material;
  muzzleTex: THREE.Texture;
  private worldFlashLight: THREE.PointLight;
  private worldFlashT = 0;
  groundHeight: (x: number, z: number) => number = () => 0;
  onShellBounce: (p: THREE.Vector3, kind: string) => void = () => {};

  constructor(private scene: THREE.Scene, baker: TextureBaker) {
    const soft = baker.raw('fx.soft', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float n = tfbm(vUv*4.0, 4.0, 4);
      float a = smoothstep(1.0, 0.0, r) * (0.55 + 0.6*n);
      gl_FragColor = vec4(vec3(1.0), clamp(a*a*1.4, 0.0, 1.0)); }`, 128, false);
    const spark = baker.raw('fx.spark', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float a = exp(-r*r*14.0) + exp(-r*4.0)*0.25;
      gl_FragColor = vec4(vec3(1.0), clamp(a, 0.0, 1.0)); }`, 64, false);
    this.muzzleTex = baker.raw('fx.muzzle', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y, p.x);
      float spikes = pow(abs(cos(a*3.0 + 0.3)), 18.0) * 0.8 + pow(abs(cos(a*5.0+1.1)), 30.0)*0.5;
      float n = tnoise(vec2(a*3.0, r*6.0), vec2(100.0));
      float core = exp(-r*r*18.0);
      float petals = smoothstep(1.0, 0.0, r / (0.35 + spikes*0.65)) * (0.6 + 0.4*n);
      float v = max(core, petals);
      vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.7), core);
      gl_FragColor = vec4(col * v, v); }`, 256, false);
    this.smoke = new ParticlePool(soft, false);
    this.dust = new ParticlePool(soft, false);
    this.sparks = new ParticlePool(spark, true);
    scene.add(this.smoke.points, this.dust.points, this.sparks.points);
    for (const p of [this.smoke.points, this.dust.points, this.sparks.points]) p.layers.set(1);

    // bullet hole decals
    const hole = baker.raw('fx.hole', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y,p.x);
      float n = tnoise(vec2(a*2.0, r*3.0), vec2(1000.0));
      float core = smoothstep(0.2, 0.12, r);
      float ring = smoothstep(0.75 + n*0.25, 0.25, r);
      float alpha = max(core, ring*0.55);
      vec3 c = mix(vec3(0.35), vec3(0.0), core);
      gl_FragColor = vec4(c, alpha); }`, 128, false);
    const dg = new THREE.PlaneGeometry(1, 1);
    const dm = new THREE.MeshStandardMaterial({ map: hole, color: 0xffffff, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.9 });
    this.decals = new THREE.InstancedMesh(dg, dm, 200);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 5;
    this.decals.layers.set(1);
    this.decals.setColorAt(0, new THREE.Color(1, 1, 1));
    scene.add(this.decals);
    this.decalCols = {
      default: new THREE.Color(0x2a2622), metal: new THREE.Color(0x777777), wood: new THREE.Color(0x3a2a1c), glass: new THREE.Color(0x9a9a9a), flesh: new THREE.Color(0x3a0505), scorch: new THREE.Color(0x0c0a08),
    };
    // tracers: stretched additive quads (cross)
    const tg = new THREE.PlaneGeometry(1, 1);
    tg.translate(0, 0.5, 0);
    tg.rotateX(Math.PI / 2); // along -Z after rotation? we orient manually
    // slim, short and dim: a faint warm streak you notice, not a laser show (barely blooms, and
    // only a little brighter at night than by day); every tracer is one instance of ONE draw
    const tg2 = tg.clone().rotateZ(Math.PI / 2);
    const cross = mergeGeometries([tg.toNonIndexed(), tg2.toNonIndexed()])!;
    const tm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.05, 0.78, 0.45), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.tracerMesh = new THREE.InstancedMesh(cross, tm, 64);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.tracerMesh.layers.set(1);
    scene.add(this.tracerMesh);
    for (let i = 0; i < 64; i++) this.tracers.push({ idx: i, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, maxDist: 0, speed: 0, alive: false });
    // shell casings
    this.shellMat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.3 });
    this.shotgunShellMat = new THREE.MeshStandardMaterial({ color: 0x8a1b14, roughness: 0.5 });
    const rifle = new THREE.CylinderGeometry(0.0048, 0.0048, 0.045, 8);
    rifle.rotateZ(Math.PI / 2);
    const pistol = new THREE.CylinderGeometry(0.0048, 0.0048, 0.019, 8);
    pistol.rotateZ(Math.PI / 2);
    const big = new THREE.CylinderGeometry(0.0072, 0.0072, 0.07, 8);
    big.rotateZ(Math.PI / 2);
    const sg = new THREE.CylinderGeometry(0.0105, 0.0105, 0.07, 10);
    sg.rotateZ(Math.PI / 2);
    this.shellGeo = { rifle, pistol, big, shotgun: sg };
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(rifle, this.shellMat);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this.shells.push({ mesh: m, vel: new THREE.Vector3(), ang: new THREE.Vector3(), life: 0, bounced: 0, alive: false });
    }
    this.worldFlashLight = new THREE.PointLight(0xffa850, 0, 9, 2);
    scene.add(this.worldFlashLight);
  }

  muzzleWorld(p: THREE.Vector3, dir: THREE.Vector3, suppressed: boolean, scale = 1, indoor = 0) {
    if (!suppressed) {
      this.worldFlashLight.position.copy(p).addScaledVector(dir, 0.3);
      // indoors the flash lights up the walls of the room (Update 33)
      this.worldFlashLight.intensity = (5 + 22 * indoor) * scale;
      this.worldFlashLight.distance = 6 + 5 * indoor;
      this.worldFlashT = 0.05;
    }
    // a faint wisp drifting from the muzzle (one puff; two for the big guns)
    for (let i = 0; i < (scale > 1.2 && !suppressed ? 2 : 1); i++) {
      const v = dir.clone().multiplyScalar(0.5 + Math.random() * 0.6).add(new THREE.Vector3((Math.random() - 0.5) * 0.25, 0.2 + Math.random() * 0.15, (Math.random() - 0.5) * 0.25));
      this.smoke.spawn(p.clone().addScaledVector(dir, 0.15 + i * 0.1), v, [0.66, 0.66, 0.64], (suppressed ? 0.03 : 0.055) * scale, 0.09 + Math.random() * 0.05, 0.9 + Math.random() * 0.6, { drag: 1.8, grav: -0.12, grow: 0.45 });
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, speed = 650) {
    const t = this.tracers.find((x) => !x.alive);
    if (!t) return;
    t.from.copy(from);
    t.dir.subVectors(to, from);
    t.maxDist = t.dir.length();
    t.dir.normalize();
    t.dist = 0;
    t.speed = speed;
    t.alive = true;
  }

  impact(p: THREE.Vector3, n: THREE.Vector3, surface: Surface, dir: THREE.Vector3, big = false) {
    const k = big ? 1.6 : 1;
    const refl = dir.clone().reflect(n);
    const rnd = (s: number) => new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    switch (surface) {
      case 'water':
        for (let i = 0; i < 14 * k; i++) this.dust.spawn(p, new THREE.Vector3(0, 3 + Math.random() * 4, 0).add(rnd(2)), [0.8, 0.86, 0.9], 0.6, 0.05 + Math.random() * 0.08, 0.6 + Math.random() * 0.4, { drag: 1.2, grav: 9.8 });
        this.dust.spawn(p, new THREE.Vector3(0, 0.3, 0), [0.85, 0.9, 0.92], 0.45, 0.25, 0.8, { grow: 0.8, drag: 2 });
        return;
      case 'flesh':
        for (let i = 0; i < 8 * k; i++) this.dust.spawn(p, dir.clone().multiplyScalar(1.5).add(rnd(2.5)), [0.32, 0.02, 0.02], 0.85, 0.04 + Math.random() * 0.06, 0.35 + Math.random() * 0.3, { drag: 3, grav: 6 });
        this.dust.spawn(p, dir.clone().multiplyScalar(0.4), [0.38, 0.03, 0.03], 0.55, 0.18, 0.5, { grow: 0.6, drag: 3 });
        return;
      case 'metal':
        for (let i = 0; i < 10 * k; i++) this.sparks.spawn(p, refl.clone().multiplyScalar(4 + Math.random() * 6).add(rnd(5)), [4, 2.2, 0.8], 1, 0.025 + Math.random() * 0.02, 0.15 + Math.random() * 0.25, { drag: 1.5, grav: 9.8 });
        // the ricochet: a couple of fast, bright fragments along the reflection
        for (let i = 0; i < 2; i++) this.sparks.spawn(p, refl.clone().multiplyScalar(14 + Math.random() * 8).add(rnd(2)), [6, 4, 2], 1, 0.018, 0.08, { drag: 0.4, grav: 4 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.3), [0.4, 0.4, 0.4], 0.3, 0.12, 0.6, { grow: 0.5, drag: 2 });
        break;
      case 'wood':
        for (let i = 0; i < 9 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(2 + Math.random() * 3).add(rnd(3)), [0.42, 0.3, 0.18], 1, 0.02 + Math.random() * 0.03, 0.6 + Math.random() * 0.5, { drag: 1.2, grav: 9.8 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.5), [0.55, 0.45, 0.35], 0.4, 0.15, 0.8, { grow: 0.6, drag: 2.5 });
        break;
      case 'glass':
        for (let i = 0; i < 16 * k; i++) this.sparks.spawn(p, dir.clone().multiplyScalar(2).add(rnd(3)), [0.9, 1, 1], 0.6, 0.012, 0.7, { drag: 0.5, grav: 9.8 });
        break;
      case 'snow':
        for (let i = 0; i < 12 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(1.5 + Math.random() * 2.5).add(rnd(2)), [0.88, 0.9, 0.94], 0.9, 0.03 + Math.random() * 0.04, 0.8 + Math.random() * 0.4, { drag: 1.6, grav: 6 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.5), [0.9, 0.92, 0.95], 0.6, 0.28 * k, 1.4, { grow: 1.1, drag: 2.5, grav: 0.3 });
        return;
      case 'grass':
      case 'dirt':
      case 'sand': {
        // soft ground: clods and a dust puff, coloured by what is there (no decal)
        const col: [number, number, number] = surface === 'grass' ? [0.22, 0.27, 0.13] : surface === 'sand' ? [0.55, 0.49, 0.38] : [0.26, 0.21, 0.15];
        const puff: [number, number, number] = surface === 'sand' ? [0.66, 0.6, 0.5] : [0.45, 0.4, 0.33];
        for (let i = 0; i < (surface === 'sand' ? 7 : 10) * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(2 + Math.random() * 3).add(rnd(2.5)), col, 1, (surface === 'sand' ? 0.015 : 0.03) + Math.random() * 0.04, 0.7 + Math.random() * 0.3, { drag: 1, grav: 9.8 });
        if (surface === 'grass') for (let i = 0; i < 4; i++) this.dust.spawn(p, n.clone().multiplyScalar(1.5).add(rnd(2)), [0.18, 0.3, 0.1], 1, 0.025, 0.9, { drag: 2.5, grav: 4 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.7), puff, surface === 'sand' ? 0.7 : 0.55, (surface === 'sand' ? 0.3 : 0.2) * k, 1.4, { grow: 0.9, drag: 2.5, grav: -0.1 });
        return;
      }
      case 'fabric':
        // a soft fibre puff, no chips
        for (let i = 0; i < 6 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(1 + Math.random() * 1.5).add(rnd(1.5)), [0.5, 0.47, 0.42], 0.8, 0.012 + Math.random() * 0.01, 0.9, { drag: 3.5, grav: 1.5 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.3), [0.55, 0.52, 0.48], 0.35, 0.12, 0.9, { grow: 0.6, drag: 3 });
        break;
      case 'woodFloor':
        for (let i = 0; i < 8 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(2 + Math.random() * 3).add(rnd(3)), [0.46, 0.34, 0.2], 1, 0.018 + Math.random() * 0.03, 0.6 + Math.random() * 0.4, { drag: 1.2, grav: 9.8 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.4), [0.55, 0.47, 0.37], 0.35, 0.12, 0.7, { grow: 0.6, drag: 2.5 });
        break;
      case 'gravel':
        // stones bounce away; a low grey cloud
        for (let i = 0; i < 12 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(2.5 + Math.random() * 4).add(rnd(4)), [0.4, 0.39, 0.37], 1, 0.02 + Math.random() * 0.03, 0.6 + Math.random() * 0.4, { drag: 0.8, grav: 9.8 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.4), [0.55, 0.53, 0.5], 0.45, 0.2 * k, 1.1, { grow: 0.8, drag: 2.5 });
        return;
      default: {
        // concrete, rock, asphalt: chips, a dust puff, and sparks off the hard stone
        const dark = surface === 'asphalt';
        const chip: [number, number, number] = dark ? [0.2, 0.2, 0.21] : surface === 'rock' ? [0.38, 0.38, 0.4] : [0.42, 0.41, 0.4];
        for (let i = 0; i < 9 * k; i++) this.dust.spawn(p, n.clone().multiplyScalar(2 + Math.random() * 4).add(rnd(3)), chip, 1, 0.015 + Math.random() * 0.025, 0.5 + Math.random() * 0.4, { drag: 1, grav: 9.8 });
        this.dust.spawn(p, n.clone().multiplyScalar(0.6), dark ? [0.38, 0.37, 0.36] : [0.62, 0.6, 0.57], 0.5, 0.18 * k, 1.2, { grow: 0.8, drag: 2.5 });
        if (Math.random() < (surface === 'rock' ? 0.7 : 0.4)) this.sparks.spawn(p, refl.clone().multiplyScalar(5).add(rnd(4)), [3, 1.8, 0.7], 1, 0.02, 0.12, { drag: 1, grav: 9.8 });
      }
    }
    this.decal(p, n, surface, big ? 0.08 : 0.05);
  }

  /** Frag / mortar explosion: flash, fireball, shock dust ring, debris, rising smoke and a scorch mark. */
  explosion(p: THREE.Vector3, n: THREE.Vector3, scale = 1, surface: Surface = 'dirt') {
    const rnd = (s: number) => new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    this.worldFlashLight.position.copy(p).addScaledVector(n, 0.8);
    this.worldFlashLight.intensity = 260 * scale;
    this.worldFlashLight.distance = 30 * scale;
    this.worldFlashT = 0.12;
    // fireball: hot core then orange billows
    for (let i = 0; i < 26 * scale; i++) this.sparks.spawn(p.clone().addScaledVector(n, 0.3), rnd(9 * scale).addScaledVector(n, 3), [5, 2.2 + Math.random(), 0.6], 1, 0.35 + Math.random() * 0.5 * scale, 0.16 + Math.random() * 0.14, { drag: 6, grav: -1, grow: 2.2 });
    for (let i = 0; i < 8; i++) this.sparks.spawn(p.clone().addScaledVector(n, 0.5), rnd(4), [9, 6, 3], 1, 0.9 * scale, 0.07, { drag: 4, grow: 3 });
    // glowing fragments
    for (let i = 0; i < 40 * scale; i++) this.sparks.spawn(p.clone().addScaledVector(n, 0.2), rnd(28).addScaledVector(n, 6), [4, 1.8, 0.5], 1, 0.03 + Math.random() * 0.03, 0.3 + Math.random() * 0.4, { drag: 0.6, grav: 9.8 });
    // earth / debris thrown up
    const soft = surface === 'grass' || surface === 'dirt' || surface === 'sand' || surface === 'snow';
    const dc: [number, number, number] = surface === 'snow' ? [0.85, 0.87, 0.9] : soft ? [0.27, 0.22, 0.16] : [0.45, 0.44, 0.42];
    for (let i = 0; i < 36 * scale; i++) this.dust.spawn(p, rnd(9).addScaledVector(n, 7 + Math.random() * 7), dc, 1, 0.05 + Math.random() * 0.08, 0.9 + Math.random() * 0.8, { drag: 0.8, grav: 9.8 });
    // ground shock ring
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.dust.spawn(p.clone().addScaledVector(n, 0.2), new THREE.Vector3(Math.cos(a) * 9, 0.4, Math.sin(a) * 9), [dc[0] + 0.15, dc[1] + 0.15, dc[2] + 0.15], 0.5, 0.6 * scale, 1.6, { drag: 3.2, grow: 1.6 });
    }
    // smoke column
    for (let i = 0; i < 16 * scale; i++) this.smoke.spawn(p.clone().addScaledVector(n, 0.5 + Math.random()).add(rnd(1.5)), rnd(2).addScaledVector(n, 1.2 + Math.random() * 2), [0.18, 0.17, 0.16], 0.55, 1.0 + Math.random() * 0.8 * scale, 4 + Math.random() * 3, { drag: 1.2, grav: -0.35, grow: 1.1 });
    this.decal(p.clone().addScaledVector(n, 0.02), n, 'flesh' as Surface, 2.2 * scale);
    const last = (this.decalIdx + this.decals.instanceMatrix.count - 1) % this.decals.instanceMatrix.count;
    this.decals.setColorAt(last, this.decalCols.scorch);
    this.decals.instanceColor!.needsUpdate = true;
  }

  /** Flashbang: an extremely bright, very short white flash and a spray of sparks. */
  flashPop(p: THREE.Vector3) {
    this.worldFlashLight.position.copy(p).setY(p.y + 0.4);
    this.worldFlashLight.intensity = 900;
    this.worldFlashLight.distance = 45;
    this.worldFlashT = 0.07;
    const rnd = (s: number) => new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    for (let i = 0; i < 8; i++) this.sparks.spawn(p.clone().setY(p.y + 0.2), rnd(3), [14, 14, 13], 1, 1.4, 0.06, { drag: 4, grow: 4 });
    for (let i = 0; i < 30; i++) this.sparks.spawn(p.clone().setY(p.y + 0.2), rnd(20).setY(Math.random() * 8), [6, 5.5, 4], 1, 0.03, 0.25 + Math.random() * 0.3, { drag: 0.8, grav: 9.8 });
  }

  /** One smoke-screen puff (large, slow, long-lived). */
  smokePuff(p: THREE.Vector3, v: THREE.Vector3, col: [number, number, number], size: number, life: number) {
    this.smoke.spawn(p, v, col, 0.85, size, life, { drag: 0.9, grav: -0.05, grow: 0.35 });
  }

  /** Hit on a soldier, read from where you stand: a small dark entry puff back toward the
   *  shooter, a fast cone of droplets out the far side along the bullet, and a fine red mist that
   *  hangs and drifts with the shot. Scales with the damage; a headshot sprays harder and higher. */
  fleshHit(p: THREE.Vector3, dir: THREE.Vector3, head: boolean, amount: number) {
    const k = Math.min(1.6, 0.55 + amount / 45) * (head ? 1.35 : 1);
    const rnd = (s: number) => new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    const back = dir.clone().negate();
    // entry: a short spit back toward the shooter
    for (let i = 0; i < Math.round(4 * k); i++) this.dust.spawn(p, back.clone().multiplyScalar(0.8 + Math.random() * 1.2).add(rnd(1.4)), [0.3, 0.02, 0.02], 0.85, 0.025 + Math.random() * 0.03, 0.25 + Math.random() * 0.2, { drag: 3.5, grav: 5 });
    this.dust.spawn(p, back.clone().multiplyScalar(0.35), [0.34, 0.03, 0.03], 0.5, 0.1 * k, 0.32, { grow: 0.9, drag: 4 });
    // exit: the directional spray (a tight cone along the shot, heavy droplets falling out of it)
    const out = p.clone().addScaledVector(dir, 0.18);
    for (let i = 0; i < Math.round(11 * k); i++) {
      const v = dir.clone().multiplyScalar(3.2 + Math.random() * 3.5 * k).add(rnd(1.8)).setY(dir.y * 3 + 0.4 + Math.random() * (head ? 1.6 : 0.9));
      this.dust.spawn(out, v, [0.28 + Math.random() * 0.06, 0.012, 0.012], 0.92, 0.022 + Math.random() * 0.04, 0.4 + Math.random() * 0.35, { drag: 2.2, grav: 9 });
    }
    // the mist: two soft puffs carried a little way down the shot line, then hanging
    this.dust.spawn(out, dir.clone().multiplyScalar(1.6), [0.36, 0.03, 0.03], 0.42, 0.16 * k, 0.75, { grow: 1.3, drag: 3, grav: 0.4 });
    this.dust.spawn(out.clone().addScaledVector(dir, 0.15), dir.clone().multiplyScalar(2.4).add(rnd(0.5)), [0.3, 0.025, 0.025], 0.28, 0.12 * k, 1.0, { grow: 1.6, drag: 2.6, grav: 0.3 });
  }

  /** Elimination burst at the victim: heavier mist, a few droplets and a dust kick at the feet. */
  killBurst(chest: THREE.Vector3, dir: THREE.Vector3, headshot: boolean, feetY: number) {
    const rnd = (s: number) => new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    const at = chest.clone();
    if (headshot) at.y += 0.42;
    for (let i = 0; i < (headshot ? 22 : 14); i++) this.dust.spawn(at, dir.clone().multiplyScalar(2.2 + Math.random() * 2).add(rnd(2.8)), [0.3, 0.015, 0.015], 0.9, 0.035 + Math.random() * 0.05, 0.45 + Math.random() * 0.35, { drag: 2.4, grav: 7 });
    this.dust.spawn(at, dir.clone().multiplyScalar(0.8), [0.36, 0.03, 0.03], 0.6, headshot ? 0.32 : 0.26, 0.7, { grow: 1.1, drag: 3 });
    this.dust.spawn(at.clone().addScaledVector(dir, 0.25), dir.clone().multiplyScalar(1.4), [0.3, 0.02, 0.02], 0.35, 0.2, 0.9, { grow: 1.4, drag: 2.2, grav: 0.6 });
    const feet = new THREE.Vector3(chest.x, feetY + 0.05, chest.z);
    for (let i = 0; i < 3; i++) this.dust.spawn(feet, new THREE.Vector3(0, 0.25, 0).add(rnd(1.2)).setY(0.2 + Math.random() * 0.3), [0.45, 0.41, 0.35], 0.32, 0.3, 1.3, { grow: 1.0, drag: 2.4, grav: -0.05 });
  }

  decal(p: THREE.Vector3, n: THREE.Vector3, surface: Surface, size: number) {
    const cap = this.decals.instanceMatrix.count;
    const i = this.decalIdx;
    this.decalIdx = (this.decalIdx + 1) % cap;
    const d = this.decalO;
    d.position.copy(p).addScaledVector(n, 0.004);
    d.lookAt(p.clone().add(n));
    d.rotateZ(Math.random() * Math.PI * 2);
    d.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    d.updateMatrix();
    this.decals.setMatrixAt(i, d.matrix);
    this.decals.setColorAt(i, this.decalCols[surface === 'metal' ? 'metal' : surface === 'wood' ? 'wood' : surface === 'glass' ? 'glass' : surface === 'flesh' ? 'flesh' : 'default']);
    this.decals.instanceMatrix.needsUpdate = true;
    this.decals.instanceColor!.needsUpdate = true;
    this.decalN = Math.min(cap, this.decalN + 1);
    this.decals.count = this.decalN;
  }

  shell(p: THREE.Vector3, v: THREE.Vector3, kind: 'rifle' | 'pistol' | 'big' | 'shotgun') {
    const s = this.shells.find((x) => !x.alive) ?? this.shells[0];
    s.mesh.geometry = this.shellGeo[kind];
    s.mesh.material = kind === 'shotgun' ? this.shotgunShellMat : this.shellMat;
    s.mesh.position.copy(p);
    s.mesh.rotation.set(Math.random(), Math.random() * 6, Math.random());
    s.vel.copy(v);
    s.ang.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    s.life = 4;
    s.bounced = 0;
    s.alive = true;
    s.mesh.visible = true;
    s.mesh.userData.kind = kind;
  }

  private debrisList: { obj: THREE.Object3D; vel: THREE.Vector3; ang: THREE.Vector3; life: number; bounced: number; kind: string; resting: boolean }[] = [];

  /** Spawn a world-space copy of an object (e.g. a dropped magazine) with simple rigid-body motion. */
  debris(src: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, ang: THREE.Vector3, kind: string) {
    const obj = src.clone(true);
    obj.visible = true;
    obj.position.copy(pos);
    obj.quaternion.copy(quat);
    obj.scale.setScalar(1);
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = true;
      }
    });
    this.scene.add(obj);
    this.debrisList.push({ obj, vel: vel.clone(), ang: ang.clone(), life: 25, bounced: 0, kind, resting: false });
    if (this.debrisList.length > 10) {
      const old = this.debrisList.shift()!;
      this.scene.remove(old.obj);
    }
  }

  update(dt: number) {
    for (let i = this.debrisList.length - 1; i >= 0; i--) {
      const d = this.debrisList[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.obj);
        this.debrisList.splice(i, 1);
        continue;
      }
      if (d.resting) continue;
      d.vel.y -= 9.8 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotateX(d.ang.x * dt);
      d.obj.rotateY(d.ang.y * dt);
      d.obj.rotateZ(d.ang.z * dt);
      const g = this.groundHeight(d.obj.position.x, d.obj.position.z) + 0.015;
      if (d.obj.position.y < g) {
        d.obj.position.y = g;
        if (d.vel.y < -0.8 && d.bounced < 3) {
          this.onShellBounce(d.obj.position, d.kind);
          d.bounced++;
        }
        d.vel.y = Math.abs(d.vel.y) * 0.25;
        d.vel.x *= 0.4;
        d.vel.z *= 0.4;
        d.ang.multiplyScalar(0.4);
        if (Math.abs(d.vel.y) < 0.35) {
          // settle flat on its side
          d.resting = true;
          const e = new THREE.Euler().setFromQuaternion(d.obj.quaternion, 'YXZ');
          d.obj.rotation.set(0, e.y, Math.PI / 2, 'YXZ');
          d.obj.position.y = g + 0.005;
        }
      }
    }
    this.smoke.update(dt);
    this.dust.update(dt);
    this.sparks.update(dt);
    this.worldFlashT -= dt;
    if (this.worldFlashT <= 0) this.worldFlashLight.intensity = 0;
    let tn = 0;
    const to = this.tracerO;
    for (const t of this.tracers) {
      if (!t.alive) continue;
      t.dist += t.speed * dt;
      const len = Math.min(1.1, t.maxDist - t.dist, t.dist);
      if (t.dist >= t.maxDist || len <= 0) {
        t.alive = false;
        continue;
      }
      to.position.copy(t.from).addScaledVector(t.dir, t.dist);
      to.quaternion.setFromUnitVectors(Z_NEG, t.dir);
      to.scale.set(0.0045, 1, len);
      to.updateMatrix();
      this.tracerMesh.setMatrixAt(tn++, to.matrix);
    }
    this.tracerMesh.count = tn;
    if (tn) this.tracerMesh.instanceMatrix.needsUpdate = true;
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.alive = false;
        s.mesh.visible = false;
        continue;
      }
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.ang.x * dt;
      s.mesh.rotation.y += s.ang.y * dt;
      s.mesh.rotation.z += s.ang.z * dt;
      const g = this.groundHeight(s.mesh.position.x, s.mesh.position.z) + 0.006;
      if (s.mesh.position.y < g) {
        s.mesh.position.y = g;
        if (s.vel.y < -0.6 && s.bounced < 3) {
          this.onShellBounce(s.mesh.position, s.mesh.userData.kind);
          s.bounced++;
        }
        s.vel.y = Math.abs(s.vel.y) * 0.35;
        s.vel.x *= 0.5;
        s.vel.z *= 0.5;
        s.ang.multiplyScalar(0.5);
        if (Math.abs(s.vel.y) < 0.3) {
          s.vel.set(0, 0, 0);
          s.ang.set(0, 0, 0);
        }
      }
    }
  }
}

/** Muzzle flash billboards in the viewmodel scene. */
export class MuzzleFlash {
  group = new THREE.Group();
  private planes: THREE.Mesh[] = [];
  private t = 0;
  constructor(tex: THREE.Texture) {
    // subtle: barely above white, so it reads as a quick flicker at the muzzle, not a bloom flare
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.35, 1.0, 0.68), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    // side-on petals
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(0.055, 0.13);
      g.translate(0, 0.052, 0);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.rotation.z = (i * Math.PI) / 3;
      this.group.add(m);
      this.planes.push(m);
    }
    // front star
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.075), mat);
    this.group.add(f);
    this.planes.push(f);
    this.group.visible = false;
  }
  fire(scale: number) {
    this.t = 0.032;
    this.group.visible = true;
    this.group.rotation.z = Math.random() * Math.PI;
    const s = scale * (0.8 + Math.random() * 0.45);
    this.group.scale.set(s, s, s * (0.8 + Math.random() * 0.5));
  }
  update(dt: number) {
    this.t -= dt;
    if (this.t <= 0) this.group.visible = false;
  }
}
