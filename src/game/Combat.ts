import * as THREE from 'three';
import { Physics, RayHit } from '../core/Physics';
import { Combatant, HitPart } from './Combatant';
import { WeaponDef } from '../weapons/WeaponDefs';
import { Effects } from '../fx/Effects';
import { lerp, smoothstep } from '../core/math';

export interface HitResult {
  victim: Combatant | null;
  part: HitPart | null;
  point: THREE.Vector3;
  killed: boolean;
  damage: number;
  worldHit: RayHit | null;
  end: THREE.Vector3;
}

export interface CombatEvents {
  onKill(killer: Combatant, victim: Combatant, def: WeaponDef, headshot: boolean, wallbang: boolean): void;
  onDamage(victim: Combatant, attacker: Combatant, amount: number, part: HitPart, dir: THREE.Vector3, through?: boolean): void;
  onImpact(hit: RayHit, def: WeaponDef, shooter: Combatant): void;
  onBulletPass(from: THREE.Vector3, to: THREE.Vector3, shooter: Combatant): void;
}

/** Hitscan resolution shared by player and bots. */
export class Combat {
  combatants: Combatant[] = [];
  friendlyFire = false;
  /** vehicles (killstreak helicopters): ray test + damage, checked alongside combatants */
  vehicleHit: ((o: THREE.Vector3, d: THREE.Vector3, max: number, shooter: Combatant) => { dist: number; apply: (dmg: number) => void } | null) | null = null;
  constructor(private physics: Physics, private fx: Effects, private ev: CombatEvents) {}

  /**
   * Fire one ray. Handles hitboxes, world impacts and thin-material penetration.
   * Returns where the bullet ended (for tracers).
   */
  fire(shooter: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, maxDist = 900, startDist = 0, visualOnly = false): HitResult {
    let o = origin.clone();
    let remaining = maxDist;
    let traveled = startDist;
    let dmgMul = 1;
    let penetrations = 0;
    let lastWorld: RayHit | null = null;
    for (let iter = 0; iter < 3; iter++) {
      const wh = this.physics.raycast(o, dir, remaining);
      const wDist = wh ? wh.distance : remaining;
      // nearest combatant before the wall
      let best: { c: Combatant; dist: number; part: HitPart; point: THREE.Vector3 } | null = null;
      for (const c of this.combatants) {
        if (c === shooter || !c.alive) continue;
        if (!this.friendlyFire && c.team === shooter.team) continue;
        const h = c.hitTest(o, dir, wDist);
        if (h && (!best || h.dist < best.dist)) best = { c, ...h };
      }
      // a replayed remote shot: looks the same, deals nothing (its owner already resolved it)
      if (visualOnly && best) {
        if (best.c.isPlayer) this.fx.impact(best.point, dir.clone().negate(), 'flesh', dir, best.part === 'head');
        else this.fx.fleshHit(best.point, dir, best.part === 'head', def.damage[0]);
        return { victim: null, part: null, point: best.point, killed: false, damage: 0, worldHit: null, end: best.point };
      }
      const veh = visualOnly ? null : this.vehicleHit?.(o, dir, best ? best.dist : wDist, shooter);
      if (veh) {
        const dist = traveled + veh.dist;
        const dmg = lerp(def.damage[0], def.damage[1], smoothstep(def.range[0], def.range[1], dist)) * dmgMul;
        veh.apply(dmg);
        const pt = o.clone().addScaledVector(dir, veh.dist);
        this.fx.impact(pt, dir.clone().negate(), 'metal', dir, false);
        return { victim: null, part: null, point: pt, killed: false, damage: dmg, worldHit: null, end: pt };
      }
      if (best) {
        const dist = traveled + best.dist;
        const fall = smoothstep(def.range[0], def.range[1], dist);
        let dmg = lerp(def.damage[0], def.damage[1], fall) * dmgMul;
        if (best.part === 'head') dmg *= def.headMul;
        else if (best.part === 'limb') dmg *= def.limbMul;
        const before = best.c.health;
        best.c.health = Math.max(0, best.c.health - dmg);
        best.c.onDamaged(shooter, dmg, dir, best.part);
        this.ev.onDamage(best.c, shooter, dmg, best.part, dir, penetrations > 0);
        // (a full directional spray on everyone else; your own hits stay a small puff that
        // never clouds your view)
        if (best.c.isPlayer) this.fx.impact(best.point, dir.clone().negate(), 'flesh', dir, best.part === 'head');
        else this.fx.fleshHit(best.point, dir, best.part === 'head', dmg);
        const killed = before > 0 && best.c.health <= 0;
        if (killed) {
          best.c.alive = false;
          this.ev.onKill(shooter, best.c, def, best.part === 'head', penetrations > 0);
        }
        return { victim: best.c, part: best.part, point: best.point, killed, damage: dmg, worldHit: null, end: best.point };
      }
      if (!wh) return { victim: null, part: null, point: o.clone().addScaledVector(dir, remaining), killed: false, damage: 0, worldHit: lastWorld, end: o.clone().addScaledVector(dir, remaining) };
      lastWorld = wh;
      if (!visualOnly) this.ev.onImpact(wh, def, shooter);
      // power: how hard the round hits (shotgun pellets and the .338 shatter glass outright)
      wh.info.onHit?.(wh.point, dir, def.cls === 'Sniper' ? 3 : def.cls === 'Shotgun' || def.cls === 'Marksman' ? 2 : 1, shooter);
      // penetration through thin/soft materials
      const pen = wh.info.penetrable ?? (wh.info.surface === 'wood' ? 0.35 : wh.info.surface === 'glass' ? 1 : wh.info.surface === 'metal' ? 0.1 : wh.info.surface === 'fabric' ? 0.8 : 0);
      if (pen <= 0 || def.penetration <= 0) return { victim: null, part: null, point: wh.point, killed: false, damage: 0, worldHit: wh, end: wh.point };
      // find exit: cast backward from a point ahead
      const probeLen = Math.min(def.penetration * (pen / 0.35) + 0.05, 2.5);
      const ahead = wh.point.clone().addScaledVector(dir, probeLen);
      const back = this.physics.raycast(ahead, dir.clone().negate(), probeLen);
      if (back && back.collider !== wh.collider) return { victim: null, part: null, point: wh.point, killed: false, damage: 0, worldHit: wh, end: wh.point };
      const exit = back ? back.point : ahead;
      const thickness = exit.distanceTo(wh.point);
      if (thickness > probeLen - 0.02 && back === null && wh.info.surface !== 'glass' && wh.info.surface !== 'fabric') {
        // solid deeper than we can penetrate
        return { victim: null, part: null, point: wh.point, killed: false, damage: 0, worldHit: wh, end: wh.point };
      }
      if (back) this.fx.impact(exit, back.normal, wh.info.surface, dir, false);
      penetrations++;
      dmgMul *= wh.info.surface === 'glass' ? 0.9 : 0.6;
      traveled += wh.distance + thickness;
      remaining -= wh.distance + thickness;
      o = exit.clone().addScaledVector(dir, 0.02);
      if (remaining <= 0) break;
    }
    return { victim: null, part: null, point: o, killed: false, damage: 0, worldHit: lastWorld, end: o };
  }
}
