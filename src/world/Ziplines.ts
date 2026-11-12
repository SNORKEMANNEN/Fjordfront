import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Physics } from '../core/Physics';
import { LADDERS, MAP_ID } from './MapLayout';
import { BR_ZIPS, BR_CABLECAR } from './maps/Brosund';

/**
 * Ziplines: motorised two-way cables (a powered trolley pulls you either way) strung between the
 * flat roofs you can reach by ladder and from the hillsides down into the village. Press [F] at
 * either end, or while looking at the cable within reach, to clip on; the trolley carries you at
 * speed and the harness takes your weight, so both hands stay on the gun and you can shoot. Jump
 * to let go (you keep the momentum), or ride to the end and you're set down on the platform.
 *
 * Every candidate line is checked against the world at build time (several rays under the cable),
 * so a cable never runs through a roof, a hill or a crane.
 */
export interface Zipline {
  a: THREE.Vector3; // cable attachment points (the trolley runs between them)
  b: THREE.Vector3;
  /** where you are set down at each end (on the roof / ground beside the post) */
  landA: THREE.Vector3;
  landB: THREE.Vector3;
  len: number;
  dir: THREE.Vector3; // a → b, unit
  /** Brosund's cable car: slower, the rider stands in a gondola that hangs further below */
  speed?: number;
  hang?: number;
  cabin?: THREE.Object3D;
}

const HANG = 1.75; // feet below the cable while riding
const SPEED = 11; // m/s

export class Ziplines {
  lines: Zipline[] = [];
  mesh: THREE.Mesh | null = null;
  /** active ride */
  ride: { line: Zipline; s: number; sign: 1 | -1; v: number } | null = null;

  constructor(private physics: Physics, heightAt: (x: number, z: number) => number, group: THREE.Object3D, mats: Record<string, THREE.Material>) {
    const roof = (i: number) => {
      const l = LADDERS[i];
      return new THREE.Vector3(l.exit[0], l.exit[1], l.exit[2]);
    };
    const ground = (x: number, z: number) => new THREE.Vector3(x, heightAt(x, z), z);
    // roof network (Lager 1, harbour office, fuel tank, crane) + hillside runs into the village
    const cands: [THREE.Vector3, THREE.Vector3][] = MAP_ID === 'brosund' ? this.searchLines(ground) : [
      [roof(3), roof(0)],
      [roof(0), roof(1)],
      [roof(1), roof(2)],
      [ground(-60, -8), ground(-20, 6)],
      [ground(112, -22), ground(60, 4)],
      [ground(-2, -128), ground(-14, -60)],
      [ground(121, 58), ground(80, 60)],
      [ground(-88, 40), ground(-40, 60)],
    ];
    const geos: THREE.BufferGeometry[] = [];
    for (const [p0, p1] of cands) {
      if (!Number.isFinite(p0.y) || !Number.isFinite(p1.y)) continue;
      const a = p0.clone().setY(p0.y + HANG + 0.9);
      const b = p1.clone().setY(p1.y + HANG + 0.9);
      const len = a.distanceTo(b);
      if (len < 15 || len > 130) continue;
      // clearance: rays from the cable down-ish and along it must not hit anything mid-span
      const dir = b.clone().sub(a).normalize();
      if (!this.clear(a, b)) continue;
      const line: Zipline = { a, b, landA: p0.clone().addScaledVector(dir, 1.6).setY(p0.y + 0.1), landB: p1.clone().addScaledVector(dir, -1.6).setY(p1.y + 0.1), len, dir };
      this.lines.push(line);
      // cable (thin box along the span, slight sag drawn as two segments) + end posts
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= Math.min(1.2, len * 0.012);
      for (const [s, e] of [[a, mid], [mid, b]] as const) {
        const L = s.distanceTo(e);
        const g = new THREE.BoxGeometry(0.022, 0.022, L);
        g.applyMatrix4(new THREE.Matrix4().lookAt(s, e, new THREE.Vector3(0, 1, 0)).setPosition(s.clone().lerp(e, 0.5)));
        geos.push(g);
      }
      for (const [top, foot] of [[a, p0], [b, p1]] as const) {
        const h = top.y - foot.y + 0.4;
        const post = new THREE.BoxGeometry(0.16, h, 0.16);
        post.translate(foot.x, foot.y + h / 2, foot.z);
        geos.push(post);
        const arm = new THREE.BoxGeometry(0.4, 0.12, 0.12);
        arm.translate(top.x, top.y + 0.06, top.z);
        geos.push(arm);
        const wheel = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 12).rotateZ(Math.PI / 2);
        wheel.translate(top.x, top.y, top.z);
        geos.push(wheel);
      }
    }
    if (MAP_ID === 'brosund') this.cableCar(geos, ground, group, mats);
    if (geos.length) {
      const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
        for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
        return g;
      }));
      if (merged) {
        this.mesh = new THREE.Mesh(merged, mats.steel ?? new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8, roughness: 0.4 }));
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = true;
        this.mesh.name = 'ziplines';
        group.add(this.mesh);
      }
    }
  }

  /**
   * Linbanen: a gondola line across the sound. Stations on the two hilltops (a steel frame with a
   * deck), a single span, two cabins. Board at either station with [F]; the cabin carries you across
   * (you can shoot out of its open sides) and sets you down on the far deck.
   */
  private cableCar(geos: THREE.BufferGeometry[], ground: (x: number, z: number) => THREE.Vector3, group: THREE.Object3D, mats: Record<string, THREE.Material>) {
    const HC = 4.4;
    const p0 = ground(BR_CABLECAR.a[0], BR_CABLECAR.a[1]), p1 = ground(BR_CABLECAR.b[0], BR_CABLECAR.b[1]);
    const a = p0.clone().setY(p0.y + HC + 0.4), b = p1.clone().setY(p1.y + HC + 0.4);
    const len = a.distanceTo(b);
    const dir = b.clone().sub(a).normalize();
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    // cabin (shared look): floor, posts, roof, windows; the hanger arm up to the trolley
    const makeCabin = () => {
      const g = new THREE.Group();
      const red = new THREE.MeshStandardMaterial({ color: 0xb8261c, roughness: 0.45, metalness: 0.3 });
      const steel = (mats.steel as THREE.Material) ?? new THREE.MeshStandardMaterial({ color: 0x666666 });
      const glass = new THREE.MeshStandardMaterial({ color: 0x223038, roughness: 0.05, metalness: 0.5, transparent: true, opacity: 0.35 });
      const box = (m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
        const me = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
        me.position.set(x, y, z);
        me.castShadow = true;
        g.add(me);
      };
      box(red, 0, 0.05, 0, 2.4, 0.12, 2.0); // floor
      box(red, 0, 2.3, 0, 2.5, 0.16, 2.1); // roof
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(red, sx * 1.15, 1.15, sz * 0.95, 0.1, 2.2, 0.1);
      box(red, 0, 0.5, 0.97, 2.3, 0.8, 0.05); // waist panels front/back
      box(red, 0, 0.5, -0.97, 2.3, 0.8, 0.05);
      box(glass, 0, 1.55, 0.97, 2.2, 1.2, 0.03);
      box(glass, 0, 1.55, -0.97, 2.2, 1.2, 0.03);
      box(steel, 0, 3.3, 0, 0.1, 2.0, 0.1); // hanger
      box(steel, 0, 4.35, 0, 0.6, 0.18, 0.25); // trolley
      // merge the parts per material: one draw call per material instead of one per box
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const c of [...g.children] as THREE.Mesh[]) {
        c.updateMatrix();
        const geo = (c.geometry as THREE.BufferGeometry).clone().applyMatrix4(c.matrix);
        const m = c.material as THREE.Material;
        if (!byMat.has(m)) byMat.set(m, []);
        byMat.get(m)!.push(geo);
        g.remove(c);
      }
      for (const [m, list] of byMat) {
        const mg = mergeGeometries(list, false);
        if (!mg) continue;
        const me = new THREE.Mesh(mg, m);
        me.castShadow = true;
        g.add(me);
      }
      return g;
    };
    const cabin = makeCabin();
    cabin.position.copy(a).setY(a.y - HC);
    cabin.rotation.y = Math.atan2(flat.x, flat.z) + Math.PI / 2;
    group.add(cabin);
    const parked = makeCabin();
    parked.position.copy(b).setY(b.y - HC);
    parked.rotation.y = cabin.rotation.y;
    group.add(parked);
    this.lines.push({ a, b, landA: p0.clone().addScaledVector(flat, -2.2).setY(p0.y + 0.1), landB: p1.clone().addScaledVector(flat, 2.2).setY(p1.y + 0.1), len, dir, speed: 9, hang: HC, cabin });
    // two cables
    for (const off of [-0.18, 0.18]) {
      const side = new THREE.Vector3(-flat.z, 0, flat.x).multiplyScalar(off);
      const s = a.clone().add(side), e = b.clone().add(side);
      const g = new THREE.BoxGeometry(0.035, 0.035, len);
      g.applyMatrix4(new THREE.Matrix4().lookAt(s, e, new THREE.Vector3(0, 1, 0)).setPosition(s.clone().lerp(e, 0.5)));
      geos.push(g);
    }
    // stations: four legs, a head frame with the bull wheel, and a deck
    for (const [top, foot] of [[a, p0], [b, p1]] as const) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const h = top.y - foot.y + 0.8;
        const leg = new THREE.BoxGeometry(0.22, h, 0.22);
        leg.translate(foot.x + sx * 1.6, foot.y + h / 2, foot.z + sz * 1.6);
        geos.push(leg);
      }
      const head = new THREE.BoxGeometry(3.6, 0.3, 3.6);
      head.translate(top.x, top.y + 0.6, top.z);
      geos.push(head);
      const wheel = new THREE.CylinderGeometry(1.5, 1.5, 0.2, 20);
      wheel.translate(top.x, top.y + 0.25, top.z);
      geos.push(wheel);
      const deck = new THREE.BoxGeometry(5, 0.2, 5);
      deck.translate(foot.x, foot.y + 0.1, foot.z);
      geos.push(deck);
    }
    void group;
  }

  /**
   * Brosund: each planned line is only roughly placed (over hills and rooftops); look around both
   * ends for the nearest pair of anchors whose cable and rider clear everything.
   */
  private searchLines(ground: (x: number, z: number) => THREE.Vector3): [THREE.Vector3, THREE.Vector3][] {
    const out: [THREE.Vector3, THREE.Vector3][] = [];
    const lift = HANG + 0.9;
    for (const [p, q] of BR_ZIPS) {
      let best: { a: THREE.Vector3; b: THREE.Vector3; d: number } | null = null;
      for (let dxa = -9; dxa <= 9; dxa += 4.5) for (let dza = -9; dza <= 9; dza += 4.5) {
        const A = ground(p[0] + dxa, p[1] + dza);
        if (!Number.isFinite(A.y) || A.y < 1) continue;
        for (let dxb = -12; dxb <= 12; dxb += 4) for (let dzb = -12; dzb <= 12; dzb += 4) {
          const B = ground(q[0] + dxb, q[1] + dzb);
          if (!Number.isFinite(B.y) || B.y < 1) continue;
          const d = Math.hypot(dxa, dza) + Math.hypot(dxb, dzb);
          if (best && d >= best.d) continue;
          const a = A.clone().setY(A.y + lift), c = B.clone().setY(B.y + lift);
          const len = a.distanceTo(c);
          if (len < 15 || len > 130) continue;
          if (!this.clear(a, c)) continue;
          best = { a: A, b: B, d };
        }
      }
      if (best) out.push([best.a, best.b]);
    }
    return out;
  }

  private clear(a: THREE.Vector3, b: THREE.Vector3) {
    const d = b.clone().sub(a);
    const len = d.length();
    d.normalize();
    // the cable itself
    const h = this.physics.raycast(a.clone().addScaledVector(d, 1.2), d, len - 2.4);
    if (h) return false;
    // the body hanging under it
    const lo = a.clone().addScaledVector(d, 2).setY(a.y - HANG);
    const hb = this.physics.raycast(lo, d, len - 4.5);
    return !hb;
  }

  /** The line (and the position along it) the player could clip onto from here, if any. */
  reachable(eye: THREE.Vector3, look: THREE.Vector3) {
    let best: { line: Zipline; s: number; d: number } | null = null;
    const v = new THREE.Vector3();
    for (const L of this.lines) {
      // closest point on the cable to the eye
      v.subVectors(eye, L.a);
      const s = THREE.MathUtils.clamp(v.dot(L.dir), 0, L.len);
      const p = L.a.clone().addScaledVector(L.dir, s);
      // the gondola: measured from the cabin floor, and only at the stations
      if (L.cabin) {
        if (s > 3 && s < L.len - 3) continue;
        p.y -= (L.hang ?? HANG) - 1.5;
      }
      const d = p.distanceTo(eye);
      if (d > (L.cabin ? 3.2 : 2.6)) continue;
      // at an end you just walk up to it; mid-span you have to look at the cable
      const atEnd = s < 2.5 || s > L.len - 2.5;
      if (!atEnd && p.clone().sub(eye).normalize().dot(look) < 0.55) continue;
      if (!best || d < best.d) best = { line: L, s, d };
    }
    return best;
  }

  /** Clip on. The trolley heads toward the far end you're facing (or the far end from where you are). */
  attach(line: Zipline, s: number, look: THREE.Vector3, vel: THREE.Vector3) {
    let sign: 1 | -1 = look.dot(line.dir) >= 0 ? 1 : -1;
    if (s < 2.5) sign = 1;
    else if (s > line.len - 2.5) sign = -1;
    const v0 = line.cabin ? 0.5 : Math.max(2, vel.dot(line.dir) * sign);
    this.ride = { line, s, sign, v: v0 };
  }

  /** Advance the ride. Returns the rider's feet position, or null once the end is reached (and `ended` set). */
  update(dt: number): { feet: THREE.Vector3; vel: THREE.Vector3; ended: THREE.Vector3 | null } | null {
    const r = this.ride;
    if (!r) return null;
    r.v += ((r.line.speed ?? SPEED) - r.v) * (1 - Math.exp(-dt * 1.8));
    r.s += r.v * r.sign * dt;
    const L = r.line;
    const end = r.sign > 0 ? r.s >= L.len - 1.2 : r.s <= 1.2;
    const cl = THREE.MathUtils.clamp(r.s, 0, L.len);
    const p = L.a.clone().addScaledVector(L.dir, cl);
    // sag: the rider pulls the cable down mid-span
    const sag = Math.sin((cl / L.len) * Math.PI) * Math.min(L.cabin ? 3 : 1.4, L.len * 0.014);
    p.y -= (L.hang ?? HANG) + sag;
    if (L.cabin) {
      L.cabin.position.copy(p);
      L.cabin.position.y -= 0.05;
    }
    const vel = L.dir.clone().multiplyScalar(r.v * r.sign);
    if (end) {
      this.ride = null;
      return { feet: p, vel, ended: r.sign > 0 ? L.landB : L.landA };
    }
    return { feet: p, vel, ended: null };
  }
}
