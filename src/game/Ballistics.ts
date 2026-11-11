import * as THREE from 'three';
import { Combat } from './Combat';
import { Combatant } from './Combatant';
import { WeaponDef } from '../weapons/WeaponDefs';
import { Effects } from '../fx/Effects';

interface Bullet {
  shooter: Combatant;
  def: WeaponDef;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  traveled: number;
  life: number;
  tracer: boolean;
  first: boolean;
  ghost: boolean;
  muzzle: THREE.Vector3;
}

/** Muzzle velocities (m/s) by class. */
export const MUZZLE_VELOCITY: Record<string, number> = { LMG: 900, 'Assault Rifle': 880, SMG: 410, Shotgun: 420, Sniper: 910, Pistol: 370, Marksman: 850 };

/** Air drag (1/s) and how strongly the wind pushes each class's bullets sideways (m/s² per m/s). */
const DRAG: Record<string, number> = { LMG: 0.11, 'Assault Rifle': 0.12, SMG: 0.32, Shotgun: 1.1, Sniper: 0.07, Pistol: 0.38, Marksman: 0.09 };
const WIND_K: Record<string, number> = { LMG: 0.45, 'Assault Rifle': 0.45, SMG: 0.5, Shotgun: 0.3, Sniper: 1.35, Pistol: 0.5, Marksman: 0.8 };

/**
 * Projectile bullets for every gun (player and bots): travel time, gravity drop, air drag that
 * bleeds speed over distance, and wind drift (strongest on the .338 — read the wind before a
 * long shot). Each frame the bullet's
 * segment is resolved through Combat.fire (hitboxes, penetration, impacts).
 */
export class Ballistics {
  private bullets: Bullet[] = [];
  gravity = 9.81;
  /** horizontal wind (m/s), set from the weather each frame */
  wind = new THREE.Vector3();
  onEnd: (b: { shooter: Combatant; end: THREE.Vector3; def: WeaponDef }) => void = () => {};

  constructor(private combat: Combat, private fx: Effects) {}

  /** `ghost`: a replayed remote shot (flies, shows impacts and tracers, deals no damage) */
  fire(shooter: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, muzzle: THREE.Vector3, tracer: boolean, ghost = false) {
    const v = MUZZLE_VELOCITY[def.cls] ?? 800;
    this.bullets.push({ shooter, def, pos: origin.clone(), vel: dir.clone().multiplyScalar(v), traveled: 0, life: 1.6, tracer, first: true, muzzle: muzzle.clone(), ghost });
  }

  update(dt: number) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      const drag = DRAG[b.def.cls] ?? 0.15;
      b.vel.multiplyScalar(1 - drag * dt);
      b.vel.addScaledVector(this.wind, (WIND_K[b.def.cls] ?? 0.4) * dt);
      const next = b.pos.clone().addScaledVector(b.vel, dt);
      next.y -= 0.5 * this.gravity * dt * dt;
      b.vel.y -= this.gravity * dt;
      const seg = next.clone().sub(b.pos);
      const len = seg.length();
      const dir = seg.divideScalar(len);
      const r = this.combat.fire(b.shooter, b.pos, dir, b.def, len, b.traveled, b.ghost);
      const done = r.victim !== null || r.damage > 0 || (r.worldHit !== null && r.end.distanceTo(next) > 0.05) || b.life <= 0;
      const end = done ? r.end : next;
      if (b.tracer) this.fx.tracer(b.first ? b.muzzle : b.pos, end, Math.max(400, end.distanceTo(b.first ? b.muzzle : b.pos) / Math.max(dt, 1e-3)));
      b.first = false;
      b.traveled += len;
      b.pos.copy(next);
      if (done) {
        if (!b.ghost) this.onEnd({ shooter: b.shooter, end, def: b.def });
        this.bullets.splice(i, 1);
      }
    }
  }

  get count() {
    return this.bullets.length;
  }
}
