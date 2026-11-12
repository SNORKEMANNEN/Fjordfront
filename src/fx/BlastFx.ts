import * as THREE from 'three';
import type { Physics, Surface } from '../core/Physics';
import type { TextureBaker } from '../render/TextureBaker';
import type { Effects } from './Effects';

/**
 * The extra layers of an explosion (Update 31), on top of Effects.explosion's fireball and smoke:
 *  - a shockwave ring racing out along the ground (tinted by what it runs over)
 *  - dust kicked up from the actual surface: powder snow, grey gravel grit, pale sand, dark soil
 *  - debris from the props nearby: the blast is traced outwards and whatever it reaches throws
 *    chips of itself (splinters off timber, flecks off concrete, glints off metal, glass)
 *  - a scorch mark under it and a dirt-spray pattern on the walls around it
 *  - a heat shimmer over the spot for a second or two (screen-space, see Pipeline uHeat)
 */
const DUST: Partial<Record<Surface, [number, number, number]>> = {
  snow: [0.9, 0.92, 0.96], sand: [0.72, 0.64, 0.48], gravel: [0.5, 0.49, 0.47], rock: [0.46, 0.45, 0.44],
  dirt: [0.3, 0.24, 0.17], grass: [0.3, 0.27, 0.18], concrete: [0.6, 0.59, 0.57], asphalt: [0.32, 0.32, 0.33],
  wood: [0.42, 0.32, 0.2], woodFloor: [0.42, 0.32, 0.2], metal: [0.45, 0.45, 0.46], water: [0.8, 0.85, 0.88],
};
const CHIP: Partial<Record<Surface, [number, number, number]>> = {
  wood: [0.36, 0.25, 0.14], woodFloor: [0.4, 0.28, 0.16], concrete: [0.55, 0.54, 0.52], rock: [0.42, 0.41, 0.4],
  metal: [0.6, 0.6, 0.62], glass: [0.7, 0.8, 0.85], asphalt: [0.2, 0.2, 0.21], gravel: [0.45, 0.44, 0.42],
};

export class BlastFx {
  private rings: { mesh: THREE.Mesh; t: number; life: number; r: number }[] = [];
  private scorch: THREE.InstancedMesh;
  private spray: THREE.InstancedMesh;
  private scorchI = 0;
  private sprayI = 0;
  private o = new THREE.Object3D();
  /** live heat-shimmer spots (world); the game projects them for the grade pass */
  heat: { p: THREE.Vector3; t: number; life: number; r: number }[] = [];

  constructor(private scene: THREE.Scene, private physics: Physics, private fx: Effects, baker: TextureBaker) {
    const ringTex = baker.raw('fx.shockring', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float n = tnoise(vec2(atan(p.y,p.x)*4.0, r*8.0), vec2(100.0));
      float band = smoothstep(0.62, 0.9, r) * smoothstep(1.0, 0.92, r);
      gl_FragColor = vec4(vec3(1.0), clamp(band * (0.6 + 0.5*n), 0.0, 1.0)); }`, 256, false);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -6 }));
      m.visible = false;
      m.renderOrder = 6;
      m.layers.set(1);
      scene.add(m);
      this.rings.push({ mesh: m, t: 1, life: 1, r: 1 });
    }
    // scorch: a burnt core with streaks flung outwards
    const scorchTex = baker.raw('fx.scorch', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y,p.x);
      float rays = pow(tnoise(vec2(a*6.0, 0.5), vec2(37.7, 100.0)), 2.0);
      float n = tfbm(vUv*5.0, 5.0, 4);
      float core = smoothstep(0.55, 0.0, r) * (0.75 + 0.3*n);
      float streak = smoothstep(1.0, 0.3, r / (0.45 + 0.6*rays)) * (0.5 + 0.5*n);
      float al = clamp(max(core, streak*0.85), 0.0, 1.0);
      gl_FragColor = vec4(vec3(0.05 + 0.08*n), al * 0.92); }`, 256, false);
    // dirt spray on walls: a sparse fan of streaks and specks, hollow in the middle
    const sprayTex = baker.raw('fx.dirtspray', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y,p.x);
      float rays = pow(tnoise(vec2(a*9.0, 0.3), vec2(56.5, 100.0)), 3.0);
      float specks = step(0.78, tnoise(vUv*40.0, vec2(40.0))) * smoothstep(1.0, 0.3, r);
      float streak = smoothstep(1.0, 0.2, r / (0.3 + 0.8*rays)) * smoothstep(0.05, 0.3, r);
      float al = clamp(streak*0.8 + specks*0.6, 0.0, 1.0);
      gl_FragColor = vec4(vec3(1.0), al); }`, 256, false);
    const mk = (tex: THREE.Texture, n: number) => {
      const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, roughness: 1 }), n);
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.layers.set(1);
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      return m;
    };
    this.scorch = mk(scorchTex, 24);
    this.spray = mk(sprayTex, 60);
  }

  dustColour(s: Surface): [number, number, number] {
    return DUST[s] ?? [0.4, 0.38, 0.35];
  }

  /** everything for one blast */
  blast(p: THREE.Vector3, n: THREE.Vector3, scale: number, surface: Surface, opts: { water?: boolean; small?: boolean } = {}) {
    const dc = this.dustColour(opts.water ? 'water' : surface);
    const big = !opts.small;
    // shockwave ring (on the ground under it)
    const ground = n.y > 0.5 ? p.clone().addScaledVector(n, -0.2) : null;
    if (ground) {
      const r = this.rings.find((x) => x.t >= x.life) ?? this.rings[0];
      r.mesh.position.copy(ground).addScaledVector(n, 0.06);
      r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      (r.mesh.material as THREE.MeshBasicMaterial).color.setRGB(dc[0] * 1.3 + 0.15, dc[1] * 1.3 + 0.15, dc[2] * 1.3 + 0.15);
      r.t = 0;
      r.life = big ? 0.45 : 0.3;
      r.r = (big ? 9 : 4.5) * scale;
      r.mesh.visible = true;
    }
    // surface dust: a low, wide skirt of the ground material + a slow cloud of it
    const skirt = opts.water ? 10 : big ? 16 : 8;
    for (let i = 0; i < skirt; i++) {
      const a = (i / skirt) * Math.PI * 2 + Math.random() * 0.3;
      const sp = (opts.water ? 5 : 8) + Math.random() * 4;
      const v = new THREE.Vector3(Math.cos(a) * sp, 0.6 + Math.random() * (surface === 'snow' ? 2.5 : 1), Math.sin(a) * sp);
      this.fx.dust.spawn(p.clone().addScaledVector(n, 0.25), v, dc, surface === 'snow' ? 0.6 : 0.38, (0.55 + Math.random() * 0.4) * scale, 1.3 + Math.random() * 0.6, { drag: 2.8, grow: 1.4, grav: -0.1 });
    }
    if (surface === 'snow' || opts.water) {
      // powder / spray thrown high and drifting down
      for (let i = 0; i < 18 * scale; i++) this.fx.dust.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 7, 6 + Math.random() * 9, (Math.random() - 0.5) * 7), dc, 0.8, 0.12 + Math.random() * 0.2, 1.6 + Math.random(), { drag: 1.4, grav: 6, grow: 1.4 });
    } else if (surface === 'gravel' || surface === 'rock') {
      for (let i = 0; i < 26 * scale; i++) this.fx.dust.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 16, 4 + Math.random() * 10, (Math.random() - 0.5) * 16), [dc[0] * 0.8, dc[1] * 0.8, dc[2] * 0.8], 1, 0.03 + Math.random() * 0.04, 1.2 + Math.random() * 0.6, { drag: 0.5, grav: 9.8 });
    } else if (surface === 'sand') {
      for (let i = 0; i < 10; i++) this.fx.dust.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4), dc, 0.45, 1.2 * scale, 3 + Math.random() * 2, { drag: 1.2, grow: 1.2, grav: -0.05 });
    }
    if (opts.water) return;
    // scorch under it
    if (ground || big) this.decal(this.scorch, this.scorchI++, p.clone().addScaledVector(n, -0.2), n, 2.6 * scale * (big ? 1 : 0.6), new THREE.Color(1, 1, 1), Math.random() * Math.PI * 2);
    // trace outwards: props and walls nearby throw chips, walls get a dirt-spray pattern
    const rays = big ? 14 : 8;
    const reach = (big ? 5.5 : 3) * scale;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + Math.random() * 0.2;
      const dir = new THREE.Vector3(Math.cos(a), (Math.random() - 0.2) * 0.45, Math.sin(a)).normalize();
      const o = p.clone().addScaledVector(n, 0.35);
      const hit = this.physics.raycast(o, dir, reach);
      if (!hit) continue;
      const k = 1 - hit.distance / reach;
      const chip = CHIP[hit.info.surface] ?? dc;
      const out = hit.normal.clone();
      if (out.dot(dir) > 0) out.negate();
      const cnt = Math.round(3 + 7 * k);
      for (let j = 0; j < cnt; j++) {
        const v = out.clone().multiplyScalar(2 + Math.random() * 5 * k).add(dir.clone().multiplyScalar(2 + Math.random() * 3)).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 4, (Math.random() - 0.5) * 3));
        this.fx.dust.spawn(hit.point.clone().addScaledVector(out, 0.05), v, chip, 1, 0.025 + Math.random() * 0.045, 0.8 + Math.random() * 0.7, { drag: 0.6, grav: 9.8 });
      }
      if (hit.info.surface === 'metal' && Math.random() < 0.7) for (let j = 0; j < 4; j++) this.fx.sparks.spawn(hit.point, out.clone().multiplyScalar(4).add(new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5)), [4, 2.4, 1], 1, 0.02, 0.2, { drag: 1, grav: 9.8 });
      // the puff of the wall's own dust
      this.fx.dust.spawn(hit.point.clone().addScaledVector(out, 0.2), out.clone().multiplyScalar(1.2), CHIP[hit.info.surface] ?? dc, 0.35, 0.5 + k * 0.6, 1.4, { drag: 2, grow: 1.4 });
      // walls (not the floor) get the dirt fan, centred where the blast hit them most directly
      if (Math.abs(hit.normal.y) < 0.5) {
        const sz = (1.4 + 1.8 * k) * scale;
        const c = new THREE.Color(dc[0] * 0.55, dc[1] * 0.55, dc[2] * 0.55);
        this.decal(this.spray, this.sprayI++, hit.point, out, sz, c, Math.random() * Math.PI * 2);
      }
    }
    // heat shimmer over the spot
    this.heat.push({ p: p.clone().addScaledVector(n, 1.0), t: 0, life: big ? 2.2 : 1.2, r: big ? 3.2 * scale : 1.8 });
    if (this.heat.length > 4) this.heat.shift();
  }

  private decal(m: THREE.InstancedMesh, idx: number, p: THREE.Vector3, n: THREE.Vector3, size: number, col: THREE.Color, rot: number) {
    const cap = m.instanceMatrix.count;
    const i = idx % cap;
    const o = this.o;
    o.position.copy(p).addScaledVector(n, 0.012);
    o.lookAt(p.clone().add(n));
    o.rotateZ(rot);
    o.scale.setScalar(size);
    o.updateMatrix();
    m.setMatrixAt(i, o.matrix);
    m.setColorAt(i, col);
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.needsUpdate = true;
    m.count = Math.min(cap, Math.max(m.count, i + 1));
  }

  update(dt: number) {
    for (const r of this.rings) {
      if (r.t >= r.life) {
        r.mesh.visible = false;
        continue;
      }
      r.t += dt;
      const u = Math.min(1, r.t / r.life);
      const e = 1 - Math.pow(1 - u, 3);
      r.mesh.scale.setScalar(0.4 + r.r * e);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * 0.85;
    }
    for (let i = this.heat.length - 1; i >= 0; i--) {
      const h = this.heat[i];
      h.t += dt;
      h.p.y += dt * 0.6;
      if (h.t >= h.life) this.heat.splice(i, 1);
    }
  }

  clear() {
    this.scorch.count = 0;
    this.spray.count = 0;
    this.heat.length = 0;
    for (const r of this.rings) {
      r.t = r.life;
      r.mesh.visible = false;
    }
  }
}
