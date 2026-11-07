import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Physics, groups, GROUP_CHARACTER, GROUP_WORLD } from '../core/Physics';

export type Stance = 'stand' | 'crouch' | 'prone' | 'slide';
export const RADIUS = 0.32;
export const STANCE_HEIGHT: Record<Stance, number> = { stand: 1.8, crouch: 1.2, prone: 0.68, slide: 1.0 };
export const EYE_HEIGHT: Record<Stance, number> = { stand: 1.64, crouch: 1.08, prone: 0.42, slide: 0.86 };

const DOWN = new THREE.Vector3(0, -1, 0);
const halfHeight = (s: Stance) => Math.max(0.02, (STANCE_HEIGHT[s] - RADIUS * 2) / 2);

/** Capsule character driven by Rapier's kinematic character controller. Position = feet. */
export class CharacterBody {
  pos = new THREE.Vector3();
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  stance: Stance = 'stand';
  grounded = false;
  groundNormal = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  private probeO = new THREE.Vector3();

  constructor(private physics: Physics, start: THREE.Vector3) {
    const R = Physics.R;
    this.pos.copy(start);
    const desc = R.ColliderDesc.capsule(halfHeight('stand'), RADIUS)
      .setTranslation(start.x, start.y + RADIUS + halfHeight('stand'), start.z)
      // narrow-phase pairs off: the controller does its own shape casts (with explicit filter
      // groups), so generating capsule-vs-world contact manifolds every step was wasted work
      .setCollisionGroups(groups(GROUP_CHARACTER, 0))
      .setActiveCollisionTypes(Physics.R.ActiveCollisionTypes.FIXED_FIXED);
    this.collider = physics.world.createCollider(desc);
    this.kcc = physics.world.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((58 * Math.PI) / 180);
    this.kcc.enableAutostep(0.42, 0.18, false);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }

  private center(stance = this.stance, at = this.pos) {
    return { x: at.x, y: at.y + RADIUS + halfHeight(stance), z: at.z };
  }

  /** Can the character occupy `stance` at its current position? */
  fits(stance: Stance, at = this.pos) {
    const c = this.center(stance, at);
    c.y += 0.04;
    const shape = new Physics.R.Capsule(halfHeight(stance), RADIUS - 0.02);
    const hit = this.physics.world.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, groups(0xffff, GROUP_WORLD), this.collider);
    return hit === null;
  }

  setStance(s: Stance, force = false) {
    if (s === this.stance) return true;
    if (!force && STANCE_HEIGHT[s] > STANCE_HEIGHT[this.stance] && !this.fits(s)) return false;
    this.stance = s;
    this.collider.setHalfHeight(halfHeight(s));
    this.collider.setTranslation(this.center());
    return true;
  }

  private raw(delta: THREE.Vector3, snap: boolean) {
    if (snap) this.kcc.enableSnapToGround(0.35);
    else this.kcc.disableSnapToGround();
    this.kcc.computeColliderMovement(this.collider, { x: delta.x, y: delta.y, z: delta.z }, undefined, groups(0xffff, GROUP_WORLD));
    const m = this.kcc.computedMovement();
    this.pos.x += m.x;
    this.pos.y += m.y;
    this.pos.z += m.z;
    this.grounded = this.kcc.computedGrounded();
    this.collider.setTranslation(this.center());
    return { x: m.x, y: m.y, z: m.z };
  }

  /** Max height the manual step-up will climb (kerbs, door sills, stairs). */
  stepHeight = 0.46;
  /** after a failed step-up, skip the (3 extra shape casts) retry for a few moves */
  private stepSkip = 0;

  /** Move by a desired delta, resolving collisions. Returns the actual movement. */
  move(delta: THREE.Vector3, snap = true): THREE.Vector3 {
    const start = this.pos.clone();
    const wasGrounded = this.grounded;
    // Walk *along* walkable slopes: lift the step so horizontal speed survives uphill
    // (otherwise the controller projects it into the slope and ramps/bridges feel like mud).
    const gn = this.groundNormal;
    const inDy = delta.y;
    if (wasGrounded && delta.y <= 0 && gn.y > 0.6 && gn.y < 0.999) {
      const rise = -(gn.x * delta.x + gn.z * delta.z) / gn.y;
      if (rise > 0) delta = new THREE.Vector3(delta.x, Math.max(delta.y, rise + 0.002), delta.z);
    }
    const m = this.raw(delta, snap);
    const want = Math.hypot(delta.x, delta.z);
    const got = Math.hypot(m.x, m.z);
    // Manual step-up: Rapier's autostep misses low sills and corner edges, so when a grounded
    // character is blocked horizontally, try "up, across, down" and keep it if it got further.
    if (this.stepSkip > 0) this.stepSkip--;
    else if ((wasGrounded || this.grounded) && want > 1e-4 && got < want * 0.6 && inDy <= 0.05) {
      const blockedPos = this.pos.clone();
      const blockedGrounded = this.grounded;
      this.teleport(start);
      const up = this.raw(new THREE.Vector3(0, this.stepHeight, 0), false);
      this.raw(new THREE.Vector3(delta.x, 0, delta.z), false);
      this.raw(new THREE.Vector3(0, -(up.y + 0.1), 0), true);
      const stepped = Math.hypot(this.pos.x - start.x, this.pos.z - start.z);
      const rise = this.pos.y - start.y;
      if (this.grounded && stepped > got + want * 0.3 && rise > -0.05 && rise <= this.stepHeight + 0.02) {
        m.x = this.pos.x - start.x;
        m.y = rise;
        m.z = this.pos.z - start.z;
      } else {
        this.teleport(blockedPos);
        this.grounded = blockedGrounded;
        this.stepSkip = 5;
      }
    }
    // ground normal: probe straight down under the feet (KCC collision lists often omit the floor)
    // (also a grounded fallback: Rapier reports "airborne" while climbing rotated-box ramps)
    this.groundNormal.set(0, 1, 0);
    if (this.grounded || inDy <= 0.05) {
      this.probeO.set(this.pos.x, this.pos.y + 0.25, this.pos.z);
      const h = this.physics.raycast(this.probeO, DOWN, 0.6);
      if (h && h.normal.y > 0.3) {
        if (this.grounded) this.groundNormal.copy(h.normal);
        else if (h.distance < 0.36 && h.normal.y > 0.6) {
          this.grounded = true;
          this.groundNormal.copy(h.normal);
        }
      }
    }
    return this.tmp.set(m.x, m.y, m.z);
  }

  teleport(p: THREE.Vector3) {
    this.pos.copy(p);
    this.collider.setTranslation(this.center());
  }

  setEnabled(e: boolean) {
    this.collider.setEnabled(e);
  }

  dispose() {
    this.physics.world.removeCharacterController(this.kcc);
    this.physics.world.removeCollider(this.collider, false);
  }
}
