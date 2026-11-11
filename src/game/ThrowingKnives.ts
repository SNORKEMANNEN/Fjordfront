import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Combatant, HitPart } from './Combatant';

/**
 * Throwing knives (lethal): fast, flat-ish arc, spinning end over end. A hit on a soldier is a
 * one-hit kill; anything else and the knife sticks where it lands (walls, floors, trees) and can
 * be picked up again by walking over it.
 */
interface Flying {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: number;
  axis: THREE.Vector3;
  owner: Combatant;
  t: number;
  stuck: boolean;
  /** stuck knives fade after a while if nobody collects them */
  life: number;
  /** shot down by a trophy system */
  dead?: boolean;
}

export class ThrowingKnives {
  knives: Flying[] = [];
  private pool: THREE.Object3D[] = [];
  constructor(
    private scene: THREE.Scene,
    private proto: THREE.Object3D,
    private physics: Physics,
    private combatants: () => Combatant[],
    private onHit: (victim: Combatant, by: Combatant, point: THREE.Vector3, dir: THREE.Vector3, part: HitPart) => void,
    private onStick: (point: THREE.Vector3, normal: THREE.Vector3, surface: string) => void,
  ) {}

  private take() {
    const m = this.pool.pop() ?? this.proto.clone();
    m.visible = true;
    this.scene.add(m);
    return m;
  }

  throw(owner: Combatant, from: THREE.Vector3, vel: THREE.Vector3) {
    const right = new THREE.Vector3(vel.z, 0, -vel.x).normalize();
    const mesh = this.take();
    mesh.position.copy(from);
    this.knives.push({ mesh, pos: from.clone(), vel: vel.clone(), spin: -26, axis: right, owner, t: 0, stuck: false, life: 45 });
  }

  /** Returns how many knives the collector picked up. */
  update(dt: number, collector: { pos: THREE.Vector3; team: number; owner: Combatant } | null) {
    let picked = 0;
    const dir = new THREE.Vector3();
    for (let i = this.knives.length - 1; i >= 0; i--) {
      const k = this.knives[i];
      k.t += dt;
      if (k.dead) {
        this.remove(i);
        continue;
      }
      if (k.stuck) {
        k.life -= dt;
        const near = collector && collector.owner === k.owner && k.pos.distanceTo(collector.pos) < 1.4;
        if (near || k.life <= 0) {
          if (near) picked++;
          this.remove(i);
        }
        continue;
      }
      k.vel.y -= 9.8 * 0.55 * dt;
      const step = k.vel.length() * dt;
      dir.copy(k.vel).normalize();
      // soldiers first (closest along the step), then the world
      let best: { c: Combatant; dist: number; part: HitPart; point: THREE.Vector3 } | null = null;
      for (const c of this.combatants()) {
        if (c === k.owner || !c.alive || c.team === k.owner.team) continue;
        const h = c.hitTest(k.pos, dir, step + 0.08);
        if (h && (!best || h.dist < best.dist)) best = { c, ...h };
      }
      const wh = this.physics.raycast(k.pos, dir, step + 0.05);
      if (best && (!wh || best.dist < wh.distance)) {
        this.onHit(best.c, k.owner, best.point, dir.clone(), best.part);
        // drops at the victim's feet, collectable
        k.stuck = true;
        k.pos.copy(best.point).setY(best.c.position().y + 0.05);
        k.mesh.position.copy(k.pos);
        k.mesh.rotation.set(Math.PI / 2, Math.random() * 6.28, 0);
        continue;
      }
      if (wh) {
        k.stuck = true;
        // blade into the surface, handle out along the flight direction
        k.pos.copy(wh.point).addScaledVector(dir, -0.04);
        k.mesh.position.copy(k.pos);
        k.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
        this.onStick(wh.point, wh.normal, wh.info.surface);
        continue;
      }
      k.pos.addScaledVector(k.vel, dt);
      k.mesh.position.copy(k.pos);
      // end over end around the throw's right axis, blade leading the arc
      k.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
      k.mesh.rotateX(k.spin * k.t);
      if (k.t > 6) this.remove(i);
    }
    return picked;
  }

  private remove(i: number) {
    const k = this.knives[i];
    k.mesh.removeFromParent();
    this.pool.push(k.mesh);
    this.knives.splice(i, 1);
  }

  clear() {
    for (let i = this.knives.length - 1; i >= 0; i--) this.remove(i);
  }
}
