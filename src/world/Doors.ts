import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../core/Physics';
import { DoorSpec } from './GeoBuilder';

/**
 * Hinged doors in every doorway the buildings leave (front/back doors, interior doors, bunker
 * doors). Walk into a closed door and it swings open away from you; hit it while sprinting and
 * you kick it open — it slams round fast, with a bang, and knocks anyone standing behind it.
 * Bots open doors the same way by walking through them. Doors stay where they are left.
 *
 * The leaf has a collider while it is at rest (closed or open). While it swings the collider is
 * switched off, so a moving door never traps a character inside it.
 */
export interface Door {
  spec: DoorSpec;
  pivot: THREE.Group;
  leaf: THREE.Mesh;
  /** current / target swing angle (rad, + opens toward the wall normal) */
  angle: number;
  target: number;
  vel: number;
  kicked: boolean;
  collider: RAPIER.Collider | null;
  normal: THREE.Vector3;
  centre: THREE.Vector3;
  restT: number;
  byBot?: boolean;
  /** eased open by hand (E / door peek): slow, quiet spring */
  soft?: boolean;
}

export interface Mover {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  sprint: boolean;
  id: number;
  /** how far ahead this mover opens doors (bots reach further so they never stall at one) */
  reach?: number;
}

const OPEN = 1.62; // ~93°

export class Doors {
  doors: Door[] = [];
  onOpen: (d: Door, kicked: boolean, by: Mover) => void = () => {};
  /** a kicked door hits the wall */
  onSlam: (d: Door, speed: number) => void = () => {};
  private tmp = new THREE.Vector3();
  /** every door's knob in one instanced draw (was one draw per door) */
  private knobs: THREE.InstancedMesh;
  private knobLocal = new THREE.Matrix4();
  private knobM = new THREE.Matrix4();
  private leafS = new THREE.Matrix4();
  private leafWood!: THREE.InstancedMesh;
  private leafMetal!: THREE.InstancedMesh;
  private leafSlot: { im: THREE.InstancedMesh; i: number }[] = [];

  constructor(specs: DoorSpec[], private physics: Physics, scene: THREE.Scene, mats: Record<string, THREE.Material>) {
    const wood = mats.door ?? new THREE.MeshStandardMaterial({ color: 0x3d5f6e });
    const metal = mats.steel ?? new THREE.MeshStandardMaterial({ color: 0x5a6066, metalness: 0.7, roughness: 0.5 });
    const knobMat = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, metalness: 0.9, roughness: 0.3 });
    this.knobs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.022, 0.022, 0.13, 10).rotateX(Math.PI / 2), knobMat, Math.max(1, specs.length));
    this.knobs.count = specs.length;
    this.knobs.frustumCulled = false;
    this.knobs.layers.set(1);
    // every leaf is an instance of a unit leaf (scaled to the door): two instanced draws (wood,
    // metal) for all the doors in the village instead of one draw (+ one shadow draw) per door
    const unit = (panels: boolean) => {
      const g = new THREE.BoxGeometry(1, 1, 0.045);
      g.translate(0.5, 0.5, 0);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.8, uv.getY(i) * 0.9);
      if (!panels) return g;
      const parts: THREE.BufferGeometry[] = [g.toNonIndexed()];
      for (const py of [0.55, 1.45]) {
        const pg = new THREE.BoxGeometry(0.69, 0.333, 0.056).toNonIndexed();
        pg.translate(0.5, py / 2.1, 0);
        parts.push(pg);
      }
      return mergeGeometries(parts) ?? g;
    };
    const nWood = specs.filter((sp) => !sp.metal).length, nMetal = specs.length - nWood;
    this.leafWood = new THREE.InstancedMesh(unit(true), wood, Math.max(1, nWood));
    this.leafMetal = new THREE.InstancedMesh(unit(false), metal, Math.max(1, nMetal));
    for (const im of [this.leafWood, this.leafMetal]) {
      im.count = 0;
      im.castShadow = im.receiveShadow = true;
      im.frustumCulled = false;
      im.layers.set(1);
      scene.add(im);
    }
    for (const spec of specs) {
      const pivot = new THREE.Group();
      pivot.position.copy(spec.hinge);
      const yaw = Math.atan2(-spec.along.z, spec.along.x);
      pivot.rotation.y = yaw;
      const g = new THREE.BoxGeometry(spec.width, spec.height, 0.045);
      g.translate(spec.width / 2, spec.height / 2, 0);
      // metric UVs so the door texture is not stretched
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * spec.width / 1.2, uv.getY(i) * spec.height / 2.4);
      // raised panels are merged into the leaf (one draw call per door instead of three)
      let leafGeo: THREE.BufferGeometry = g;
      if (!spec.metal) {
        const parts: THREE.BufferGeometry[] = [g.index ? g.toNonIndexed() : g];
        for (const py of [0.55, 1.45]) {
          const pg = new THREE.BoxGeometry(spec.width - 0.28, 0.7, 0.056).toNonIndexed();
          pg.translate(spec.width / 2, py * (spec.height / 2.1), 0);
          parts.push(pg);
        }
        leafGeo = mergeGeometries(parts) ?? g;
      }
      const leaf = new THREE.Mesh(leafGeo, spec.metal ? metal : wood); // (not drawn: see the instanced leaves)
      leafGeo.dispose();
      const im = spec.metal ? this.leafMetal : this.leafWood;
      this.leafSlot.push({ im, i: im.count++ });
      pivot.traverse((o) => o.layers.set(1));
      scene.add(pivot);
      const normal = new THREE.Vector3(-spec.along.z, 0, spec.along.x).normalize();
      const centre = spec.hinge.clone().addScaledVector(spec.along, spec.width / 2).setY(spec.hinge.y + 1);
      const d: Door = { spec, pivot, leaf, angle: 0, target: 0, vel: 0, kicked: false, collider: null, normal, centre, restT: 0 };
      this.doors.push(d);
      this.rebuildCollider(d);
      this.placeKnob(this.doors.length - 1);
    }
    scene.add(this.knobs);
  }

  private placeKnob(i: number) {
    const d = this.doors[i];
    d.pivot.updateMatrix();
    d.pivot.updateMatrixWorld(true);
    const ls = this.leafSlot[i];
    ls.im.setMatrixAt(ls.i, this.knobM.copy(d.pivot.matrixWorld).multiply(this.leafS.makeScale(d.spec.width, d.spec.height, 1)));
    ls.im.instanceMatrix.needsUpdate = true;
    this.knobLocal.makeTranslation(d.spec.width - 0.08, 1.0, 0);
    this.knobs.setMatrixAt(i, this.knobM.multiplyMatrices(d.pivot.matrixWorld, this.knobLocal));
    this.knobs.instanceMatrix.needsUpdate = true;
  }

  private rebuildCollider(d: Door) {
    if (d.collider) this.physics.remove(d.collider);
    d.collider = null;
    d.pivot.updateMatrixWorld(true);
    const c = new THREE.Vector3(d.spec.width / 2, d.spec.height / 2, 0).applyMatrix4(d.pivot.matrixWorld);
    const q = d.pivot.getWorldQuaternion(new THREE.Quaternion());
    d.collider = this.physics.addBox(c, new THREE.Vector3(d.spec.width / 2, d.spec.height / 2, 0.03), q, { surface: d.spec.metal ? 'metal' : 'wood', penetrable: d.spec.metal ? 0.1 : 0.6, tag: 'door' } as any);
  }

  /** Open doors that characters walk into. Returns doors that were kicked this frame. */
  update(dt: number, movers: Mover[]) {
    for (let di = 0; di < this.doors.length; di++) {
      const d = this.doors[di];
      if (Math.abs(d.target) < 0.5 && Math.abs(d.angle) < 0.5) {
        // closed (or only cracked open by a peek): anyone pushing into it?
        for (const m of movers) {
          this.tmp.subVectors(m.pos, d.centre).setY(0);
          const side = this.tmp.dot(d.normal);
          const along = this.tmp.dot(d.spec.along);
          const reach = m.reach ?? 1.0;
          if (Math.abs(side) > reach || Math.abs(along) > d.spec.width / 2 + 0.25 + (reach - 1) * 0.3 || Math.abs(m.pos.y + 0.9 - d.centre.y) > 1.6) continue;
          const into = -Math.sign(side) * m.vel.dot(d.normal);
          if (into < (m.reach ? 0.2 : 0.4) && Math.abs(side) > 0.55) continue;
          // swing away from the pusher (a cracked door keeps going the way it already opened)
          d.target = Math.abs(d.target) > 0.05 ? Math.sign(d.target) * OPEN : side > 0 ? OPEN : -OPEN;
          d.soft = false;
          d.kicked = m.sprint && into > 3;
          d.byBot = m.id !== 0;
          d.vel = d.kicked ? d.target * 9 : d.target * 1.2;
          if (d.collider) {
            this.physics.remove(d.collider);
            d.collider = null;
          }
          this.onOpen(d, d.kicked, m);
          break;
        }
      }
      if (Math.abs(d.angle - d.target) > 0.002 || Math.abs(d.vel) > 0.01) {
        // a heavy spring: pushed doors ease open, kicked doors slam and bounce off the stop
        const k = d.kicked ? 60 : d.soft ? 9 : d.byBot ? 26 : 16, c = d.kicked ? 6 : d.soft ? 6.5 : d.byBot ? 9 : 7.5;
        d.vel += ((d.target - d.angle) * k - d.vel * c) * dt;
        d.angle += d.vel * dt;
        if (Math.abs(d.angle) > OPEN) {
          if (d.kicked && Math.abs(d.vel) > 4) this.onSlam(d, Math.abs(d.vel));
          d.angle = Math.sign(d.angle) * OPEN;
          d.vel *= -0.35;
        }
        d.pivot.rotation.y = Math.atan2(-d.spec.along.z, d.spec.along.x) + d.angle;
        this.placeKnob(di);
        d.restT = 0;
      } else if (!d.collider) {
        d.restT += dt;
        // never drop a collider onto someone standing in the leaf's way
        if (d.restT > 0.1 && !movers.some((m) => this.inLeaf(d, m.pos))) this.rebuildCollider(d);
      }
    }
  }

  /** Is a point inside the space the leaf occupies at its current angle? */
  private inLeaf(d: Door, p: THREE.Vector3) {
    const yaw = Math.atan2(-d.spec.along.z, d.spec.along.x) + d.angle;
    const ax = Math.cos(yaw), az = -Math.sin(yaw);
    const rx = p.x - d.spec.hinge.x, rz = p.z - d.spec.hinge.z;
    const u = rx * ax + rz * az; // along the leaf from the hinge
    const v = -rx * az + rz * ax; // across it
    return u > -0.3 && u < d.spec.width + 0.3 && Math.abs(v) < 0.42 && p.y > d.spec.hinge.y - 1 && p.y < d.spec.hinge.y + d.spec.height;
  }

  /** Open a closed door away from `from`, or close an open one (the E key). */
  toggle(d: Door, from: THREE.Vector3) {
    if (Math.abs(d.target) > 0.5) {
      d.target = 0;
      d.vel = -Math.sign(d.angle) * 0.6;
    } else {
      const side = this.tmp.subVectors(from, d.centre).setY(0).dot(d.normal);
      d.target = side > 0 ? OPEN : -OPEN;
      d.vel = d.target * 0.5;
      this.onOpen(d, false, { pos: from, vel: new THREE.Vector3(), sprint: false, id: 0 });
    }
    d.kicked = false;
    d.byBot = false;
    d.soft = false;
    if (d.collider) {
      this.physics.remove(d.collider);
      d.collider = null;
    }
  }

  /** Ease a closed door open a crack, away from `from` (door peek). Returns the swing sign. */
  crack(d: Door, from: THREE.Vector3, angle: number) {
    let sign = Math.sign(d.target);
    if (!sign) sign = this.tmp.subVectors(from, d.centre).setY(0).dot(d.normal) > 0 ? 1 : -1;
    const want = sign * angle;
    if (Math.abs(want - d.target) < 0.004) return sign;
    d.target = want;
    d.soft = true;
    d.kicked = false;
    d.byBot = false;
    if (d.collider) {
      this.physics.remove(d.collider);
      d.collider = null;
    }
    return sign;
  }

  /** Signed distance of `p` in front of the doorway (+ = the side the normal points to). */
  side(d: Door, p: THREE.Vector3) {
    return this.tmp.subVectors(p, d.centre).setY(0).dot(d.normal);
  }

  /** Doors near a point (for bots: a closed door on the path ahead). */
  nearestClosed(p: THREE.Vector3, r: number) {
    let best: Door | null = null, bd = r;
    for (const d of this.doors) {
      if (Math.abs(d.target) > 0.01) continue;
      const dist = d.centre.distanceTo(p);
      if (dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  }
}
