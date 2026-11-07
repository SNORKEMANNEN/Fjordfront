import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { Physics } from '../core/Physics';
import { Combatant } from './Combatant';
import { WeaponDef } from '../weapons/WeaponDefs';
import { Effects } from '../fx/Effects';
import { Viewmodel } from '../weapons/Viewmodel';
import { Surface } from '../core/Physics';

/** Kill-feed / damage identities for things that are not guns. */
export const FRAG = { id: 'frag', name: 'Frag Grenade', cls: 'Explosive' } as unknown as WeaponDef;
export const MORTAR = { id: 'mortar', name: 'Mortar Strike', cls: 'Explosive' } as unknown as WeaponDef;
export const MELEE = { id: 'melee', name: 'Melee', cls: 'Melee' } as unknown as WeaponDef;
export const HELI = { id: 'heli', name: 'Attack Helicopter', cls: 'Explosive' } as unknown as WeaponDef;
export const STUN = { id: 'stun', name: 'Stun Grenade', cls: 'Explosive' } as unknown as WeaponDef;

export type GrenadeKind = 'frag' | 'flash' | 'stun' | 'smoke';
/** fuse per kind (s): flash/stun pop fast, smoke after a short roll */
export const FUSE: Record<GrenadeKind, number> = { frag: 3.5, flash: 1.6, stun: 1.6, smoke: 1.3 };

export interface SmokeCloud { p: THREE.Vector3; t: number; life: number; r: number; mesh: THREE.Object3D }

export interface Grenade {
  kind: GrenadeKind;
  owner: Combatant;
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  fuse: number;
  resting: boolean;
  bounces: number;
}

export interface ExplosionHooks {
  /** damage dealt to a combatant (for hit markers, flinch, kill attribution) */
  damage(victim: Combatant, attacker: Combatant, amount: number, dir: THREE.Vector3, def: WeaponDef): void;
  kill(attacker: Combatant, victim: Combatant, def: WeaponDef): void;
  /** audio-visual: position, distance-based shake etc. */
  blast(p: THREE.Vector3, n: THREE.Vector3, scale: number, surface: Surface, def: WeaponDef): void;
  bounce(p: THREE.Vector3, speed: number): void;
  /** tacticals */
  flash(p: THREE.Vector3, owner: Combatant): void;
  stun(p: THREE.Vector3, owner: Combatant): void;
  smokeStart(p: THREE.Vector3): void;
  smokeEmit(c: SmokeCloud, dt: number): void;
}

/**
 * Frag grenades (cookable, bouncing, 3.5 s fuse) and the shared explosion model used by the
 * mortar killstreak: damage falls off with distance, walls between the blast and the target
 * absorb most of it, and teammates are safe (you are not, from your own grenade).
 */
export class Explosives {
  grenades: Grenade[] = [];
  smokes: SmokeCloud[] = [];
  readonly fuseTime = 3.5;
  private protos: Record<GrenadeKind, THREE.Group> = { frag: Viewmodel.makeGrenade('frag'), flash: Viewmodel.makeGrenade('flash'), stun: Viewmodel.makeGrenade('stun'), smoke: Viewmodel.makeGrenade('smoke') };

  constructor(private scene: THREE.Scene, private physics: Physics, private fx: Effects, private hooks: ExplosionHooks, private players: () => Combatant[]) {
    for (const pr of Object.values(this.protos)) {
      pr.scale.setScalar(1.15);
      pr.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
    }
  }

  throw(owner: Combatant, from: THREE.Vector3, vel: THREE.Vector3, fuse = this.fuseTime, kind: GrenadeKind = 'frag') {
    const mesh = this.protos[kind].clone();
    const ring = mesh.getObjectByName('ring');
    if (ring) ring.visible = false;
    mesh.position.copy(from);
    this.scene.add(mesh);
    const g: Grenade = { kind, owner, mesh, pos: from.clone(), vel: vel.clone(), spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 8 - 4, Math.random() * 12 - 6), fuse, resting: false, bounces: 0 };
    this.grenades.push(g);
    return g;
  }

  update(dt: number) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      if (!g.resting) {
        // two sub-steps keep fast throws from tunnelling through thin walls
        for (let s = 0; s < 2; s++) this.integrate(g, dt / 2);
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        if (g.kind === 'smoke') {
          // the canister stays where it lies and pours smoke for ~20 s
          const c: SmokeCloud = { p: g.pos.clone(), t: 0, life: 20, r: 0, mesh: g.mesh };
          this.smokes.push(c);
          this.hooks.smokeStart(c.p);
          continue;
        }
        this.scene.remove(g.mesh);
        if (g.kind === 'frag') this.explode(g.pos, g.owner, FRAG, 8.5, 160);
        else if (g.kind === 'flash') this.hooks.flash(g.pos.clone(), g.owner);
        else this.hooks.stun(g.pos.clone(), g.owner);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const c = this.smokes[i];
      c.t += dt;
      // the cloud swells over ~3 s, holds, then thins out
      c.r = 6.5 * Math.min(1, c.t / 3) * (c.t > c.life - 4 ? Math.max(0, (c.life - c.t) / 4) : 1);
      if (c.t < c.life - 3) this.hooks.smokeEmit(c, dt);
      if (c.t >= c.life) {
        this.scene.remove(c.mesh);
        this.smokes.splice(i, 1);
      }
    }
  }

  /** True when a sight line passes through a thick part of a smoke cloud. */
  smokeBlocks(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.smokes.length) return false;
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-3) return false;
    d.divideScalar(len);
    for (const c of this.smokes) {
      const r = c.r * 0.85;
      if (r < 1) continue;
      const centre = c.p.clone().setY(c.p.y + Math.min(2.2, r * 0.4));
      const t = THREE.MathUtils.clamp(centre.clone().sub(a).dot(d), 0, len);
      const miss = a.clone().addScaledVector(d, t).distanceTo(centre);
      if (miss < r) {
        const chord = 2 * Math.sqrt(r * r - miss * miss);
        // inside the cloud, or looking through more than ~1.5 m of it
        if (chord > 1.5 || a.distanceTo(centre) < r || b.distanceTo(centre) < r) return true;
      }
    }
    return false;
  }

  private integrate(g: Grenade, dt: number) {
    g.vel.y -= 9.81 * dt;
    g.vel.multiplyScalar(1 - 0.05 * dt); // a little air drag
    const step = g.vel.clone().multiplyScalar(dt);
    const len = step.length();
    if (len < 1e-5) return;
    const dir = step.clone().divideScalar(len);
    const hit = this.physics.raycast(g.pos, dir, len + 0.045);
    if (!hit) {
      g.pos.add(step);
      return;
    }
    // bounce: lose most of the normal speed and some tangential speed
    const n = hit.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    g.pos.copy(hit.point).addScaledVector(n, 0.046);
    const vn = n.clone().multiplyScalar(g.vel.dot(n));
    const vt = g.vel.clone().sub(vn);
    const speed = g.vel.length();
    g.vel.copy(vt.multiplyScalar(0.62)).addScaledVector(vn, -0.33);
    g.spin.multiplyScalar(0.6);
    g.bounces++;
    if (speed > 1.2) this.hooks.bounce(g.pos, speed);
    if (n.y > 0.65 && g.vel.length() < 0.9) {
      g.resting = true;
      g.vel.set(0, 0, 0);
      g.spin.set(0, 0, 0);
    }
  }

  /** Blast at p; returns the number of kills. */
  explode(p: THREE.Vector3, owner: Combatant, def: WeaponDef, radius: number, maxDmg: number) {
    // area damage is simulated on every machine; each only damages what it owns (see NetFlags)
    NETF.noRoute++;
    try {
      this.explodeInner(p, owner, def, radius, maxDmg);
    } finally {
      NETF.noRoute--;
    }
  }
  private explodeInner(p: THREE.Vector3, owner: Combatant, def: WeaponDef, radius: number, maxDmg: number) {
    // surface underneath for the debris colour
    const down = this.physics.raycast(p.clone().setY(p.y + 0.5), new THREE.Vector3(0, -1, 0), 2.5);
    const n = down && down.distance < 1.6 ? down.normal.clone() : new THREE.Vector3(0, 1, 0);
    const surface: Surface = down ? down.info.surface : 'dirt';
    const origin = p.clone().addScaledVector(n, 0.25);
    this.hooks.blast(origin, n, def === MORTAR ? 1.5 : 1, surface, def);
    let kills = 0;
    for (const c of this.players()) {
      if (!c.alive) continue;
      if (c.team === owner.team && c !== owner) continue;
      const chest = c.chest(new THREE.Vector3());
      const feet = c.position();
      const d = Math.min(chest.distanceTo(origin), feet.distanceTo(origin) + 0.4);
      if (d > radius) continue;
      let k = 1 - Math.pow(d / radius, 1.25);
      // cover: walls between blast and body soak most of it
      if (!this.physics.lineOfSight(origin, chest) && !this.physics.lineOfSight(origin, feet.clone().setY(feet.y + 0.3))) {
        if (d > 2.2) continue;
        k *= 0.25;
      }
      const dmg = maxDmg * k;
      if (dmg < 2) continue;
      const before = c.health;
      c.health = Math.max(0, c.health - dmg);
      const dir = chest.clone().sub(origin).normalize();
      c.onDamaged(owner, dmg, dir);
      this.hooks.damage(c, owner, dmg, dir, def);
      if (before > 0 && c.health <= 0) {
        c.alive = false;
        kills++;
        this.hooks.kill(owner, c, def);
      }
    }
    // knock loose glass etc. is handled by the world's onHit for bullets; explosions shake the fx only
    void this.fx;
    return kills;
  }

  clear() {
    for (const g of this.grenades) this.scene.remove(g.mesh);
    for (const c of this.smokes) this.scene.remove(c.mesh);
    this.grenades.length = 0;
    this.smokes.length = 0;
  }
}

/** Launch velocity that lands a lob at `to` from `from` (fixed 38° arc, clamped speed). */
export function lobVelocity(from: THREE.Vector3, to: THREE.Vector3, angle = 0.66, maxSpeed = 21) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  const h = to.y - from.y;
  const g = 9.81;
  const c = Math.cos(angle), s = Math.sin(angle);
  const denom = 2 * c * c * (d * Math.tan(angle) - h);
  let v = denom > 0 ? Math.sqrt((g * d * d) / denom) : maxSpeed;
  v = Math.min(maxSpeed, v);
  return new THREE.Vector3((dx / Math.max(d, 1e-3)) * c * v, s * v, (dz / Math.max(d, 1e-3)) * c * v);
}
