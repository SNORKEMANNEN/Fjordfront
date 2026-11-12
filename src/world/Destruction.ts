import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Physics } from '../core/Physics';
import { GeoBuilder, metricBox } from './GeoBuilder';
import { Effects } from '../fx/Effects';
import { Combatant } from '../game/Combatant';

/**
 * Environmental destruction (Update 20).
 *
 *  Barrels   all standing drums are one instanced mesh per paint. Each has a collider and a
 *            little health: shot through or caught by a blast, an ordinary drum is knocked over
 *            and rolls away (its collider goes). Red fuel drums spring a burning leak first and
 *            blow up a few seconds later — or at once if a blast hits them — setting off drums
 *            and cars around them.
 *  Fences    picket and post-and-rail fences are built in ~1.6 m sections with their own
 *            colliders. Enough bullets, a blast or a soldier sprinting through snaps a section:
 *            its geometry is collapsed out of the merged fence mesh and splinters / planks fly.
 *  Cars      every intact parked car takes damage from bullets and explosions. Past 55 % it
 *            smokes from the engine bay, past 80 % the engine catches fire (crackling loop, light,
 *            flames and a burn zone around it) and after ~7 s it explodes: a big blast that hurts
 *            and kills, the body is swapped for a burnt-out shell (still cover), and it keeps
 *            burning for a while. Credit goes to whoever did the damage.
 */

interface Barrel { i: number; mat: string; pos: THREE.Vector3; hp: number; collider: RAPIER.Collider | null; leak: number; dead: boolean; red: boolean; by: Combatant | null }
interface Section { pos: THREE.Vector3; hp: number; collider: RAPIER.Collider | null; ranges: { mesh: THREE.Mesh; start: number; count: number }[]; dead: boolean; dir: THREE.Vector3; style: string; len: number; q: THREE.Quaternion }
interface Car { id: string; m: THREE.Matrix4; pos: THREE.Vector3; hp: number; state: 'ok' | 'smoke' | 'fire' | 'dead'; fireT: number; by: Combatant | null; wreck: THREE.Object3D | null; burnT: number }

export interface DestructionHooks {
  sound(name: string, p: THREE.Vector3, o?: { gain?: number; rate?: number; ref?: number }): void;
  explode(p: THREE.Vector3, owner: Combatant | null, radius: number, dmg: number, kind: 'barrel' | 'vehicle'): void;
  /** fire damage to soldiers standing in a burning car's flames */
  burn(p: THREE.Vector3, r: number, dps: number, by: Combatant | null, dt: number): void;
  emitter(key: string, buf: string, gain: number, p: THREE.Vector3): void;
  stopEmitter(key: string): void;
  players(): Combatant[];
}

const BARREL_HP = 60, FENCE_HP = 45, CAR_HP = 320;

export class Destruction {
  barrels: Barrel[] = [];
  sections: Section[] = [];
  cars = new Map<string, Car>();
  private inst = new Map<string, THREE.InstancedMesh>();
  private o = new THREE.Object3D();
  private fireLight: THREE.PointLight;
  private emitT = 0;
  private plankProto: THREE.Mesh;
  private picketProto: THREE.Mesh;
  private barrelProto = new Map<string, THREE.Mesh>();

  constructor(private scene: THREE.Scene, private physics: Physics, private fx: Effects, private mats: Record<string, THREE.Material>, builder: GeoBuilder, cars: { id: string; m: THREE.Matrix4; paint: string }[], private hooks: DestructionHooks) {
    this.plankProto = new THREE.Mesh(metricBox(0.8, 0.08, 0.04), mats.woodRaw ?? mats.wood ?? mats.default);
    this.picketProto = new THREE.Mesh(metricBox(0.08, 0.9, 0.03), mats.trim ?? mats.default);
    this.buildBarrels(builder.destructibles.filter((d) => d.kind === 'barrel'));
    this.buildFences(builder.destructibles.filter((d) => d.kind === 'fence'));
    for (const c of cars) {
      const pos = new THREE.Vector3().setFromMatrixPosition(c.m);
      this.cars.set(c.id, { id: c.id, m: c.m, pos, hp: CAR_HP, state: 'ok', fireT: 0, by: null, wreck: null, burnT: 0 });
    }
    // ranges of each car in the merged static meshes (collapsed when it blows up)
    this.carRanges = builder.ranges;
    GeoBuilder.onCarHit = (id, p, _d, pw, by) => this.damageCar(id, 3 + 3 * pw, (by as Combatant) ?? null, p);
    this.fireLight = new THREE.PointLight(0xff8a3a, 0, 14, 2);
    scene.add(this.fireLight);
  }
  private carRanges: Map<string, { mesh: THREE.Mesh; start: number; count: number }[]>;

  // ------------------------------------------------------------------ barrels
  private buildBarrels(list: GeoBuilder['destructibles']) {
    const byMat = new Map<string, typeof list>();
    for (const d of list) {
      const m = d.data.mat as string;
      if (!byMat.has(m)) byMat.set(m, []);
      byMat.get(m)!.push(d);
    }
    const body = new THREE.CylinderGeometry(0.29, 0.29, 0.9, 14);
    const uv = body.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * 0.29, uv.getY(i) * 0.9);
    body.translate(0, 0.45, 0);
    // two rolling hoops
    const hoops = [0.3, 0.6].map((y) => new THREE.TorusGeometry(0.292, 0.012, 4, 14).rotateX(Math.PI / 2).translate(0, y, 0));
    const geo = mergeGeometries([body, ...hoops.map((h) => { h.deleteAttribute('uv'); h.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(h.getAttribute('position').count * 2), 2)); return h; })], false)!;
    for (const [mat, ds] of byMat) {
      const im = new THREE.InstancedMesh(geo, this.mats[mat] ?? this.mats.default, ds.length);
      im.castShadow = true;
      im.receiveShadow = true;
      im.name = 'barrels:' + mat;
      this.barrelProto.set(mat, new THREE.Mesh(geo, im.material as THREE.Material));
      ds.forEach((d, k) => {
        const pos = new THREE.Vector3().setFromMatrixPosition(d.m);
        im.setMatrixAt(k, new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z));
        const red = mat === 'redSteel';
        const b: Barrel = { i: k, mat, pos, hp: BARREL_HP, collider: null, leak: -1, dead: false, red, by: null };
        b.collider = this.physics.addCylinder(pos.clone().setY(pos.y + 0.45), 0.45, 0.29, {
          surface: 'metal', penetrable: 0.15,
          onHit: (p, _dir, pw, by) => this.hitBarrel(b, 12 * (pw ?? 1), (by as Combatant) ?? null, p),
        });
        this.barrels.push(b);
      });
      im.computeBoundingSphere();
      this.scene.add(im);
      this.inst.set(mat, im);
    }
  }

  private hitBarrel(b: Barrel, dmg: number, by: Combatant | null, p?: THREE.Vector3) {
    if (b.dead) return;
    b.hp -= dmg;
    if (by) b.by = by;
    if (p) for (let i = 0; i < 4; i++) this.fx.sparks.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3), [4, 2.6, 1], 1, 0.02, 0.15, { drag: 0.5, grav: 9.8 });
    if (b.red && b.leak < 0 && b.hp < BARREL_HP * 0.6) {
      // punctured: a burning leak, it goes up in a few seconds
      b.leak = 2.5 + Math.random() * 1.5;
      this.hooks.sound('fireIgnite', b.pos, { gain: 0.8, ref: 4 });
    }
    if (b.hp <= 0) {
      if (b.red) this.blowBarrel(b);
      else this.topple(b, p ? b.pos.clone().sub(p).setY(0).normalize() : new THREE.Vector3(1, 0, 0));
    }
  }

  private hide(b: Barrel) {
    b.dead = true;
    const im = this.inst.get(b.mat)!;
    im.setMatrixAt(b.i, new THREE.Matrix4().makeScale(0, 0, 0));
    im.instanceMatrix.needsUpdate = true;
    if (b.collider) this.physics.remove(b.collider);
    b.collider = null;
  }

  private topple(b: Barrel, dir: THREE.Vector3) {
    this.hide(b);
    const proto = this.barrelProto.get(b.mat)!;
    const v = dir.multiplyScalar(2.5 + Math.random() * 2).setY(1.2);
    this.fx.debris(proto, b.pos.clone(), new THREE.Quaternion(), v, new THREE.Vector3(Math.random() * 3, Math.random() * 2, 6), 'barrel');
    this.hooks.sound('imp_metal_heavy', b.pos, { gain: 0.9, ref: 4 });
    this.hooks.sound('imp_tin', b.pos, { gain: 0.6, rate: 0.7, ref: 4 });
  }

  private blowBarrel(b: Barrel) {
    if (b.dead) return;
    this.hide(b);
    const c = b.pos.clone().setY(b.pos.y + 0.5);
    this.hooks.explode(c, b.by, 6, 150, 'barrel');
    // the lid and shell halves go flying
    const proto = this.barrelProto.get(b.mat)!;
    this.fx.debris(proto, c, new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, 0, 0.4)), new THREE.Vector3((Math.random() - 0.5) * 6, 9 + Math.random() * 4, (Math.random() - 0.5) * 6), new THREE.Vector3(8, 3, 5), 'barrel');
    for (let i = 0; i < 20; i++) this.fx.sparks.spawn(c, new THREE.Vector3((Math.random() - 0.5) * 8, 2 + Math.random() * 7, (Math.random() - 0.5) * 8), [5, 2, 0.5], 1, 0.15 + Math.random() * 0.2, 0.5 + Math.random() * 0.6, { drag: 1.2, grav: 3 });
  }

  // ------------------------------------------------------------------ fences
  private buildFences(list: GeoBuilder['destructibles']) {
    const geos = new Map<string, { g: THREE.BufferGeometry; sec: Section }[]>();
    const add = (mat: string, g: THREE.BufferGeometry, m: THREE.Matrix4, sec: Section) => {
      g.applyMatrix4(m);
      const ng = g.index ? g.toNonIndexed() : g;
      const clean = new THREE.BufferGeometry();
      clean.setAttribute('position', ng.getAttribute('position'));
      clean.setAttribute('normal', ng.getAttribute('normal'));
      clean.setAttribute('uv', ng.getAttribute('uv'));
      if (!geos.has(mat)) geos.set(mat, []);
      geos.get(mat)!.push({ g: clean, sec });
    };
    const local = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    for (const d of list) {
      const { x0, x1, z, style } = d.data as { x0: number; x1: number; z: number; style: string };
      const len = x1 - x0;
      if (len < 0.3) continue;
      const n = Math.max(1, Math.round(len / 1.6));
      const q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
      d.m.decompose(t, q, s);
      for (let k = 0; k < n; k++) {
        const a = x0 + (len * k) / n, bx = x0 + (len * (k + 1)) / n, sl = bx - a;
        const centre = new THREE.Vector3((a + bx) / 2, 0.5, z).applyMatrix4(d.m);
        const sec: Section = { pos: centre, hp: style === 'crates' ? FENCE_HP * 2.6 : FENCE_HP, collider: null, ranges: [], dead: false, dir: new THREE.Vector3(1, 0, 0).applyQuaternion(q), style, len: sl, q };
        if (style === 'crates') {
          // (Update 33) stacked wooden crates: real cover that splinters apart under fire
          const cw = sl / 2 - 0.04;
          const seed = Math.abs(Math.sin((centre.x * 12.9898 + centre.z * 78.233) * 43758.5453)) % 1;
          for (const [cx, base, h] of [[a + sl * 0.25, 0, 0.82], [a + sl * 0.75, 0, 0.82], [a + sl * (seed < 0.5 ? 0.3 : 0.7), 0.82, 0.62]] as const) {
            add('crate', metricBox(base ? cw * 0.85 : cw, h, base ? 0.62 : 0.8), new THREE.Matrix4().multiplyMatrices(d.m, local(cx, base + h / 2, z).multiply(new THREE.Matrix4().makeRotationY(base ? (seed - 0.5) * 0.4 : 0))), sec);
            // slats on the faces
            add('woodRaw', metricBox(base ? cw * 0.85 + 0.02 : cw + 0.02, 0.06, (base ? 0.62 : 0.8) + 0.02), new THREE.Matrix4().multiplyMatrices(d.m, local(cx, base + h * 0.5, z)), sec);
          }
        } else if (style === 'picket') {
          for (let i = a; i < bx - 0.06; i += 0.14) add('trim', metricBox(0.08, 0.9 + 0.08 * ((i * 7) % 1), 0.04), new THREE.Matrix4().multiplyMatrices(d.m, local(i + 0.04, (0.9 + 0.08 * ((i * 7) % 1)) / 2, z + 0.02)), sec);
          add('trim', metricBox(sl, 0.07, 0.05), new THREE.Matrix4().multiplyMatrices(d.m, local((a + bx) / 2, 0.585, z - 0.025)), sec);
        } else {
          add('woodRaw', metricBox(0.1, 1.2, 0.1), new THREE.Matrix4().multiplyMatrices(d.m, local(a + 0.05, 0.6, z)), sec);
          if (k === n - 1) add('woodRaw', metricBox(0.1, 1.2, 0.1), new THREE.Matrix4().multiplyMatrices(d.m, local(bx - 0.05, 0.6, z)), sec);
          for (const y of [0.495, 0.995]) add('woodRaw', metricBox(sl, 0.09, 0.06), new THREE.Matrix4().multiplyMatrices(d.m, local((a + bx) / 2, y, z)), sec);
        }
        const cq = q.clone();
        const half = style === 'crates' ? new THREE.Vector3(sl / 2, 0.72, 0.4) : new THREE.Vector3(sl / 2, style === 'picket' ? 0.47 : 0.6, 0.05);
        const cp = new THREE.Vector3((a + bx) / 2, half.y, z).applyMatrix4(d.m);
        sec.collider = this.physics.addBox(cp, half, cq, {
          surface: 'wood', penetrable: style === 'crates' ? 0.5 : 1,
          onHit: (p, dir, pw) => this.hitSection(sec, 9 * (pw ?? 1), dir, p),
        });
        this.sections.push(sec);
      }
    }
    for (const [mat, list2] of geos) {
      const merged = mergeGeometries(list2.map((e) => e.g), false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.mats[mat] ?? this.mats.default);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'fences:' + mat;
      this.scene.add(mesh);
      let off = 0;
      for (const e of list2) {
        const cnt = e.g.getAttribute('position').count;
        e.sec.ranges.push({ mesh, start: off, count: cnt });
        off += cnt;
      }
    }
  }

  private hitSection(s: Section, dmg: number, dir: THREE.Vector3, p?: THREE.Vector3) {
    if (s.dead) return;
    s.hp -= dmg;
    if (p) for (let i = 0; i < 3; i++) this.fx.dust.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2), [0.45, 0.36, 0.25], 1, 0.03, 0.6, { drag: 0.6, grav: 9.8 });
    if (s.hp <= 0) this.breakSection(s, dir);
  }

  breakSection(s: Section, dir: THREE.Vector3) {
    if (s.dead) return;
    s.dead = true;
    collapse(s.ranges);
    if (s.collider) this.physics.remove(s.collider);
    s.collider = null;
    // planks / pickets fly in the direction of the force, splinters puff
    const proto = s.style === 'picket' ? this.picketProto : this.plankProto;
    const n = s.style === 'picket' ? 4 : s.style === 'crates' ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const at = s.pos.clone().addScaledVector(s.dir, (Math.random() - 0.5) * s.len).setY(s.pos.y + (Math.random() - 0.3) * 0.4);
      const v = dir.clone().setY(0).normalize().multiplyScalar(2 + Math.random() * 3).setY(1.5 + Math.random() * 2);
      this.fx.debris(proto, at, s.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random(), 0, Math.random() - 0.5))), v, new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 4, (Math.random() - 0.5) * 10), 'plank');
    }
    for (let i = 0; i < 14; i++) this.fx.dust.spawn(s.pos, new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4), s.style === 'picket' ? [0.85, 0.85, 0.82] : [0.45, 0.35, 0.24], 1, 0.03 + Math.random() * 0.03, 0.8, { drag: 0.6, grav: 9.8 });
    this.fx.smokePuff(s.pos, new THREE.Vector3(0, 0.3, 0), [0.5, 0.47, 0.42], 0.6, 1.5);
    this.hooks.sound('imp_plank', s.pos, { gain: 1, rate: 0.8, ref: 5 });
    this.hooks.sound('debris', s.pos, { gain: 0.6, ref: 4 });
  }

  // ------------------------------------------------------------------ cars
  damageCar(id: string, dmg: number, by: Combatant | null, p?: THREE.Vector3) {
    const c = this.cars.get(id);
    if (!c || c.state === 'dead') return;
    c.hp -= dmg;
    if (by) c.by = by;
    if (p && Math.random() < 0.5) this.fx.sparks.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3), [4, 2.8, 1.2], 1, 0.02, 0.15, { drag: 0.5, grav: 9.8 });
    if (c.state === 'ok' && c.hp < CAR_HP * 0.45) c.state = 'smoke';
    if (c.state !== 'fire' && c.hp < CAR_HP * 0.2) {
      c.state = 'fire';
      c.fireT = 6.5 + Math.random() * 2;
      this.hooks.sound('fireIgnite', this.engine(c), { gain: 1, ref: 5 });
    }
    if (c.hp < -CAR_HP * 0.4 && c.state === 'fire') c.fireT = Math.min(c.fireT, 0.4); // hammered: goes up now
  }

  /** engine bay (front of the car) */
  private engine(c: Car) {
    return new THREE.Vector3(1.55, 1.0, 0).applyMatrix4(c.m);
  }

  private blowCar(c: Car) {
    c.state = 'dead';
    c.burnT = 18;
    collapse(this.carRanges.get(c.id) ?? []);
    c.wreck = this.buildWreck(c.m);
    this.scene.add(c.wreck);
    const centre = new THREE.Vector3(0, 0.9, 0).applyMatrix4(c.m);
    this.hooks.explode(centre, c.by, 9, 190, 'vehicle');
    // the car jumps on its springs, doors / panels and wheels fly, a mushroom of fire
    for (let i = 0; i < 4; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 10, 7 + Math.random() * 6, (Math.random() - 0.5) * 10);
      this.fx.debris(this.plankProto, centre.clone().add(new THREE.Vector3(0, 0.6, 0)), new THREE.Quaternion(), v, new THREE.Vector3(9, 4, 7), 'barrel');
    }
    for (let i = 0; i < 30; i++) this.fx.sparks.spawn(centre.clone().add(new THREE.Vector3(0, 0.8, 0)), new THREE.Vector3((Math.random() - 0.5) * 5, 4 + Math.random() * 8, (Math.random() - 0.5) * 5), [5, 2.2, 0.6], 1, 0.4 + Math.random() * 0.5, 0.5 + Math.random() * 0.5, { drag: 1.5, grav: -1, grow: 1.8 });
    for (let i = 0; i < 14; i++) this.fx.smoke.spawn(centre.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2)), new THREE.Vector3((Math.random() - 0.5), 2 + Math.random() * 2, (Math.random() - 0.5)), [0.08, 0.075, 0.07], 0.75, 1.6 + Math.random(), 7, { drag: 0.6, grav: -0.3, grow: 1.4 });
  }

  private buildWreck(m: THREE.Matrix4) {
    const g = new THREE.Group();
    const L = 4.6, W = 1.8;
    const burnt = this.mats.carBurnt ?? this.mats.default;
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat = burnt, rz = 0) => {
      const mesh = new THREE.Mesh(metricBox(x1 - x0, y1 - y0, z1 - z0), mat);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      mesh.rotation.z = rz;
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
    };
    // sagging body, crumpled roof, no glass, bonnet popped
    box(-L / 2, 0.22, -W / 2, L / 2, 0.86, W / 2);
    box(-L / 2 + 0.25, 0.86, -W / 2 + 0.12, L / 2 - 1.35, 1.32, W / 2 - 0.12);
    box(-L / 2 + 0.2, 1.3, -W / 2 + 0.1, L / 2 - 1.45, 1.38, W / 2 - 0.1, burnt, 0.04);
    box(L / 2 - 1.2, 0.95, -W / 2 + 0.1, L / 2 - 0.1, 1.0, W / 2 - 0.1, burnt, 0.35);
    const rim = this.mats.dkgrey ?? burnt;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.16, 10).rotateX(Math.PI / 2), rim);
      w.position.set(sx * (L / 2 - 0.8), 0.24, sz * (W / 2 - 0.08));
      g.add(w);
    }
    g.applyMatrix4(m);
    return g;
  }

  // ------------------------------------------------------------------ world reactions
  /** a blast: damages barrels, snaps fences, hurts cars */
  blast(p: THREE.Vector3, r: number, by: Combatant | null) {
    for (const b of this.barrels) {
      if (b.dead) continue;
      const d = b.pos.distanceTo(p);
      if (d > r * 0.7 || d < 0.05) continue;
      const dmg = 140 * (1 - d / (r * 0.7));
      if (b.red && d < r * 0.5) {
        b.by = by ?? b.by;
        // chain: a short delay so the explosions ripple
        window.setTimeout(() => this.blowBarrel(b), 150 + d * 60);
      } else this.hitBarrel(b, dmg, by, undefined);
    }
    for (const s of this.sections) {
      if (s.dead) continue;
      const d = s.pos.distanceTo(p);
      if (d < r * 0.6) this.breakSection(s, s.pos.clone().sub(p).normalize());
    }
    for (const c of this.cars.values()) {
      if (c.state === 'dead') continue;
      const d = c.pos.distanceTo(p);
      if (d < r + 2) this.damageCar(c.id, 260 * Math.max(0, 1 - d / (r + 2)), by);
    }
  }

  /** soldiers running through fences break them */
  bodyPush(p: THREE.Vector3, v: THREE.Vector3) {
    if (v.lengthSq() < 30) return; // only at a sprint
    for (const s of this.sections) {
      if (s.dead || Math.abs(s.pos.y - p.y - 0.5) > 1.2) continue;
      const dx = p.x - s.pos.x, dz = p.z - s.pos.z;
      const along = dx * s.dir.x + dz * s.dir.z;
      const across = -dx * s.dir.z + dz * s.dir.x;
      if (Math.abs(along) < s.len / 2 + 0.2 && Math.abs(across) < 0.55) this.breakSection(s, v.clone().normalize());
    }
  }

  update(dt: number, cam: THREE.Vector3) {
    this.emitT -= dt;
    const emit = this.emitT <= 0;
    if (emit) this.emitT = 0.06;
    let light: THREE.Vector3 | null = null, lightD = 1e9, lightK = 0;
    // leaking fuel drums
    for (const b of this.barrels) {
      if (b.dead || b.leak < 0) continue;
      b.leak -= dt;
      const top = b.pos.clone().setY(b.pos.y + 0.95);
      if (emit) {
        this.fx.sparks.spawn(top, new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.5 + Math.random(), (Math.random() - 0.5) * 0.4), [4, 1.6, 0.4], 1, 0.18, 0.3, { drag: 1, grav: -2, grow: 1.4 });
        if (Math.random() < 0.5) this.fx.smoke.spawn(top, new THREE.Vector3(0, 1.2, 0), [0.1, 0.1, 0.1], 0.5, 0.5, 2.5, { drag: 0.4, grav: -0.2, grow: 1.2 });
      }
      const d = top.distanceTo(cam);
      if (d < lightD) { lightD = d; light = top; lightK = 0.6; }
      this.hooks.emitter('barrelFire' + b.i + b.mat, 'carFire', 0.5, top);
      if (b.leak <= 0) {
        this.hooks.stopEmitter('barrelFire' + b.i + b.mat);
        this.blowBarrel(b);
      }
    }
    for (const c of this.cars.values()) {
      if (c.state === 'ok') continue;
      const eng = this.engine(c);
      const near = eng.distanceTo(cam) < 140;
      if (c.state === 'smoke') {
        if (emit && near && Math.random() < 0.6) this.fx.smoke.spawn(eng, new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2, (Math.random() - 0.5) * 0.4), [0.32, 0.31, 0.3], 0.45, 0.6, 3.5, { drag: 0.4, grav: -0.25, grow: 1.3 });
        continue;
      }
      if (c.state === 'fire') {
        c.fireT -= dt;
        if (emit && near) {
          for (let i = 0; i < 2; i++) this.fx.sparks.spawn(eng.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)), new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.6 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6), [4.5, 1.7, 0.45], 1, 0.25 + Math.random() * 0.2, 0.35, { drag: 1, grav: -2.5, grow: 1.5 });
          this.fx.smoke.spawn(eng.clone().setY(eng.y + 0.8), new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.8, (Math.random() - 0.5) * 0.5), [0.07, 0.07, 0.07], 0.6, 0.8, 4.5, { drag: 0.3, grav: -0.3, grow: 1.4 });
        }
        this.hooks.burn(eng, 2.2, 22, c.by, dt);
        this.hooks.emitter(c.id, 'carFire', 0.9, eng);
        const d = eng.distanceTo(cam);
        if (d < lightD) { lightD = d; light = eng; lightK = 1; }
        // tyres pop and the horn-like warning hiss in the last seconds
        if (c.fireT < 2 && c.fireT + dt >= 2) this.hooks.sound('smokeHiss', eng, { gain: 0.9, ref: 6, rate: 1.4 });
        if (c.fireT <= 0) this.blowCar(c);
        continue;
      }
      // dead: the shell keeps burning for a while, then smoulders
      c.burnT -= dt;
      const centre = new THREE.Vector3(0, 1.0, 0).applyMatrix4(c.m);
      if (c.burnT > 0) {
        if (emit && near) {
          this.fx.sparks.spawn(centre.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 0, (Math.random() - 0.5) * 1.2)), new THREE.Vector3(0, 1.4 + Math.random(), 0), [4, 1.5, 0.4], 1, 0.3, 0.4, { drag: 1, grav: -2, grow: 1.5 });
          this.fx.smoke.spawn(centre.clone().setY(centre.y + 0.8), new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.6, (Math.random() - 0.5) * 0.5), [0.06, 0.06, 0.06], 0.6, 1.0, 5, { drag: 0.3, grav: -0.3, grow: 1.4 });
        }
        this.hooks.burn(centre, 2.4, 15, c.by, dt);
        this.hooks.emitter(c.id, 'carFire', 0.8 * Math.min(1, c.burnT / 4), centre);
        const d = centre.distanceTo(cam);
        if (d < lightD) { lightD = d; light = centre; lightK = Math.min(1, c.burnT / 4); }
      } else {
        this.hooks.emitter(c.id, 'carFire', 0, centre);
        if (emit && near && Math.random() < 0.25 && c.burnT > -60) this.fx.smoke.spawn(centre, new THREE.Vector3(0, 0.8, 0), [0.2, 0.2, 0.2], 0.3, 0.6, 4, { drag: 0.4, grav: -0.2, grow: 1.2 });
      }
    }
    // one flickering fire light for the nearest blaze
    if (light && lightD < 60) {
      this.fireLight.position.copy(light).setY(light.y + 0.6);
      this.fireLight.intensity = lightK * (14 + Math.sin(performance.now() * 0.023) * 4 + Math.random() * 4);
    } else this.fireLight.intensity = 0;
  }

  /** Match reset: everything back up. */
  reset() {
    for (const b of this.barrels) {
      if (!b.dead && b.leak < 0) { b.hp = BARREL_HP; continue; }
      this.hooks.stopEmitter('barrelFire' + b.i + b.mat);
      b.dead = false;
      b.hp = BARREL_HP;
      b.leak = -1;
      const im = this.inst.get(b.mat)!;
      im.setMatrixAt(b.i, new THREE.Matrix4().makeTranslation(b.pos.x, b.pos.y, b.pos.z));
      im.instanceMatrix.needsUpdate = true;
      if (!b.collider) b.collider = this.physics.addCylinder(b.pos.clone().setY(b.pos.y + 0.45), 0.45, 0.29, { surface: 'metal', penetrable: 0.15, onHit: (p, _d, pw, by) => this.hitBarrel(b, 12 * (pw ?? 1), (by as Combatant) ?? null, p) });
    }
    for (const s of this.sections) {
      s.hp = FENCE_HP;
      if (!s.dead) continue;
      s.dead = false;
      restore(s.ranges);
      const half = new THREE.Vector3(s.len / 2, s.style === 'picket' ? 0.47 : 0.6, 0.05);
      s.collider = this.physics.addBox(s.pos.clone().setY(s.pos.y - 0.5 + half.y), half, s.q, { surface: 'wood', penetrable: 1, onHit: (p, dir, pw) => this.hitSection(s, 9 * (pw ?? 1), dir, p) });
    }
    for (const c of this.cars.values()) {
      this.hooks.stopEmitter(c.id);
      if (c.state === 'dead') {
        restore(this.carRanges.get(c.id) ?? []);
        if (c.wreck) this.scene.remove(c.wreck);
        c.wreck = null;
      }
      c.state = 'ok';
      c.hp = CAR_HP;
      c.by = null;
    }
  }
}

/** Collapse vertex ranges of merged meshes (degenerate triangles: the piece disappears). */
function collapse(ranges: { mesh: THREE.Mesh; start: number; count: number }[]) {
  for (const r of ranges) {
    const pos = r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const keep = (r.mesh.userData.orig ??= new Map<number, Float32Array>()) as Map<number, Float32Array>;
    if (!keep.has(r.start)) keep.set(r.start, (pos.array as Float32Array).slice(r.start * 3, (r.start + r.count) * 3));
    const x = pos.getX(r.start), y = pos.getY(r.start), z = pos.getZ(r.start);
    for (let i = r.start; i < r.start + r.count; i++) pos.setXYZ(i, x, y, z);
    pos.addUpdateRange(r.start * 3, r.count * 3);
    pos.needsUpdate = true;
  }
}
function restore(ranges: { mesh: THREE.Mesh; start: number; count: number }[]) {
  for (const r of ranges) {
    const keep = r.mesh.userData.orig as Map<number, Float32Array> | undefined;
    const a = keep?.get(r.start);
    if (!a) continue;
    const pos = r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(a, r.start * 3);
    pos.addUpdateRange(r.start * 3, r.count * 3);
    pos.needsUpdate = true;
  }
}
