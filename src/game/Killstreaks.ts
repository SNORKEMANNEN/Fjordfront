import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { Combatant } from './Combatant';
import { Combat } from './Combat';
import { Physics } from '../core/Physics';
import { Terrain } from '../world/Terrain';
import { Explosives, MORTAR, HELI } from './Explosives';
import { WeaponDef } from '../weapons/WeaponDefs';

/**
 * Killstreaks (kills in a row without dying; earned rewards are kept until used):
 *   3  UAV              — 30 s radar sweep that shows every enemy on your team's mini-map
 *   5  Mortar Strike    — three heavy rounds walk onto the point you are aiming at (2.5 s whistle)
 *   7  Attack Helicopter— 40 s gunship that circles the fight and fires at enemies it can see;
 *                         it can be shot down (≈ 1 magazine and a half of rifle fire)
 * Bots earn and use them too.
 */
export type StreakId = 'uav' | 'mortar' | 'heli';
export const STREAKS: { id: StreakId; name: string; kills: number; key: string }[] = [
  { id: 'uav', name: 'UAV', kills: 3, key: '3' },
  { id: 'mortar', name: 'MORTAR STRIKE', kills: 5, key: '4' },
  { id: 'heli', name: 'ATTACK HELICOPTER', kills: 7, key: '5' },
];

/** Helicopter door-gun: hitscan through Combat with its own falloff. */
const HELI_GUN = {
  ...HELI, damage: [26, 18], range: [40, 140], headMul: 1.3, limbMul: 0.9, penetration: 0.2,
} as unknown as WeaponDef;

interface Shell { at: THREE.Vector3; t: number; owner: Combatant; whistled: boolean }

export interface Heli {
  owner: Combatant;
  team: 0 | 1;
  root: THREE.Group;
  rotor: THREE.Object3D;
  tail: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  health: number;
  life: number;
  ang: number;
  centre: THREE.Vector3;
  fireT: number;
  burst: number;
  target: Combatant | null;
  dying: number;
  /** radio chatter state (leave call made, last hit call) */
  leftCalled?: boolean;
  hitT?: number;
}

export interface StreakHooks {
  earned(c: Combatant, id: StreakId): void;
  used(c: Combatant, id: StreakId): void;
  heliShot(h: Heli, origin: THREE.Vector3, dir: THREE.Vector3, end: THREE.Vector3): void;
  heliDown(h: Heli, by: Combatant | null): void;
  whistle(p: THREE.Vector3): void;
  /** crew chatter: the gunship acquiring a target, getting a kill, taking hits, leaving */
  heliEvent?(h: Heli, kind: 'engage' | 'kill' | 'hit' | 'leave'): void;
  /** a team's UAV sweep ended */
  uavEnd?(team: 0 | 1): void;
  /** the last round of a fire mission landed */
  mortarDone?(owner: Combatant): void;
}

export class Killstreaks {
  streak = new Map<number, number>();
  owned = new Map<number, Set<StreakId>>();
  /** UAV active until (time), per team */
  uavUntil: [number, number] = [0, 0];
  private shells: Shell[] = [];
  helis: Heli[] = [];
  private botUseAt = new Map<number, { id: StreakId; t: number }>();
  private uavWas: [boolean, boolean] = [false, false];

  constructor(
    private scene: THREE.Scene,
    private physics: Physics,
    private terrain: Terrain,
    private combat: Combat,
    private explosives: Explosives,
    private players: () => Combatant[],
    private hooks: StreakHooks,
  ) {}

  reset() {
    this.streak.clear();
    this.owned.clear();
    this.uavUntil = [0, 0];
    this.uavWas = [false, false];
    this.shells.length = 0;
    for (const h of this.helis) this.scene.remove(h.root);
    this.helis.length = 0;
    this.botUseAt.clear();
  }

  has(c: Combatant, id: StreakId) {
    return this.owned.get(c.id)?.has(id) ?? false;
  }
  count(c: Combatant) {
    return this.streak.get(c.id) ?? 0;
  }

  onKill(killer: Combatant, victim: Combatant, viaStreak: boolean) {
    this.streak.set(victim.id, 0);
    if (killer === victim || killer.team === victim.team) return;
    if (viaStreak) return; // streak kills do not chain into more streaks (CoD rule)
    const n = (this.streak.get(killer.id) ?? 0) + 1;
    this.streak.set(killer.id, n);
    for (const s of STREAKS) {
      if (n === s.kills) {
        let set = this.owned.get(killer.id);
        if (!set) this.owned.set(killer.id, (set = new Set()));
        set.add(s.id);
        this.hooks.earned(killer, s.id);
        if (!killer.isPlayer) this.botUseAt.set(killer.id * 10 + STREAKS.indexOf(s), { id: s.id, t: -1 });
      }
    }
  }

  /** Use a streak. `aim` is the mortar target (player: crosshair point). */
  use(c: Combatant, id: StreakId, now: number, aim?: THREE.Vector3) {
    if (!this.has(c, id)) return false;
    if (id === 'heli' && this.helis.some((h) => h.team === c.team)) return false; // one gunship per team
    if (id === 'mortar' && !aim) return false;
    this.owned.get(c.id)!.delete(id);
    this.lastShells = [];
    if (id === 'mortar') {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = i === 0 ? 0 : 3 + Math.random() * 5;
        this.lastShells.push([aim!.x + Math.cos(a) * r, aim!.z + Math.sin(a) * r]);
      }
    }
    this.start(c, id, now, this.lastShells);
    this.hooks.used(c, id);
    return true;
  }
  /** mortar impact points of the last use() (replicated to the other machines) */
  lastShells: [number, number][] = [];
  private start(c: Combatant, id: StreakId, now: number, shells: [number, number][]) {
    if (id === 'uav') this.uavUntil[c.team] = Math.max(this.uavUntil[c.team], now) + 30;
    if (id === 'mortar') shells.forEach(([x, z], i) => this.shells.push({ at: new THREE.Vector3(x, 0, z), t: 2.6 + i * 0.75, owner: c, whistled: false }));
    if (id === 'heli') this.spawnHeli(c);
  }
  /** network: a streak used on another machine (no ownership check, same impact points) */
  replay(c: Combatant, id: StreakId, now: number, shells: [number, number][]) {
    this.start(c, id, now, shells);
    this.hooks.used(c, id);
  }

  update(dt: number, now: number, enemyFocus: (team: 0 | 1) => THREE.Vector3 | null) {
    // ---- bots use what they earn after a short beat
    for (const [k, u] of this.botUseAt) {
      const bot = this.players().find((p) => p.id === Math.floor(k / 10));
      if (!bot || (bot as { netPuppet?: boolean }).netPuppet) {
        this.botUseAt.delete(k);
        continue;
      }
      if (u.t < 0) u.t = now + 2 + Math.random() * 4;
      if (now < u.t || !bot.alive) continue;
      const aim = u.id === 'mortar' ? enemyFocus(bot.team) : undefined;
      if (u.id === 'mortar' && !aim) continue;
      if (this.use(bot, u.id, now, aim ?? undefined) || !this.has(bot, u.id)) this.botUseAt.delete(k);
    }
    // ---- UAV sweeps ending
    for (const t of [0, 1] as const) {
      if (this.uavWas[t] && now >= this.uavUntil[t]) this.hooks.uavEnd?.(t);
      this.uavWas[t] = now < this.uavUntil[t];
    }
    // ---- mortar shells
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t -= dt;
      if (!s.whistled && s.t < 0.6) {
        s.whistled = true;
        s.at.y = this.groundAt(s.at.x, s.at.z);
        this.hooks.whistle(s.at);
      }
      if (s.t <= 0) {
        s.at.y = this.groundAt(s.at.x, s.at.z);
        this.explosives.explode(s.at, s.owner, MORTAR, 11, 220);
        this.shells.splice(i, 1);
        if (!this.shells.some((o) => o.owner === s.owner)) this.hooks.mortarDone?.(s.owner);
      }
    }
    // ---- helicopters
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      if (this.updateHeli(h, dt, enemyFocus)) {
        this.scene.remove(h.root);
        this.helis.splice(i, 1);
      }
    }
  }

  private groundAt(x: number, z: number) {
    const h = this.physics.raycast(new THREE.Vector3(x, this.terrain.heightAt(x, z) + 30, z), new THREE.Vector3(0, -1, 0), 60);
    return h ? h.point.y : this.terrain.heightAt(x, z);
  }

  // ------------------------------------------------------------------ helicopter
  private spawnHeli(owner: Combatant) {
    const root = Killstreaks.heliModel();
    const start = new THREE.Vector3(owner.position().x > 0 ? 260 : -260, 70, owner.position().z * 0.5);
    root.position.copy(start);
    this.scene.add(root);
    this.helis.push({
      owner, team: owner.team, root, rotor: root.getObjectByName('rotor')!, tail: root.getObjectByName('tailRotor')!,
      pos: start.clone(), vel: new THREE.Vector3(), health: 900, life: 40, ang: Math.random() * Math.PI * 2,
      centre: owner.position().clone(), fireT: 2, burst: 0, target: null, dying: 0,
    });
  }

  /** returns true when the helicopter is gone */
  private updateHeli(h: Heli, dt: number, enemyFocus: (team: 0 | 1) => THREE.Vector3 | null) {
    h.rotor.rotation.y += dt * 38;
    h.tail.rotation.x += dt * 60;
    if (h.dying > 0) {
      // shot down: spin and fall, explode on the ground
      h.dying += dt;
      h.vel.y -= 9.81 * dt;
      h.pos.addScaledVector(h.vel, dt);
      h.root.rotation.y += dt * 5;
      h.root.position.copy(h.pos);
      if (h.pos.y < this.groundAt(h.pos.x, h.pos.z) + 1 || h.dying > 6) {
        this.explosives.explode(h.pos, h.owner, HELI, 6, 60);
        return true;
      }
      return false;
    }
    h.life -= dt;
    const focus = enemyFocus(h.team);
    if (focus) h.centre.lerp(focus, 1 - Math.exp(-0.3 * dt));
    // orbit the fight at ~38 m radius, 32–40 m above the ground
    h.ang += dt * 0.42;
    const leaving = h.life <= 0;
    if (leaving && !h.leftCalled) {
      h.leftCalled = true;
      this.hooks.heliEvent?.(h, 'leave');
    }
    const want = leaving
      ? h.pos.clone().add(new THREE.Vector3(Math.sign(h.pos.x || 1) * 80, 10, 0))
      : new THREE.Vector3(h.centre.x + Math.cos(h.ang) * 38, 0, h.centre.z + Math.sin(h.ang) * 38);
    if (!leaving) want.y = Math.max(this.terrain.heightAt(want.x, want.z), 0) + 34 + Math.sin(h.ang * 2) * 4;
    const to = want.sub(h.pos);
    const acc = to.multiplyScalar(0.9).sub(h.vel.clone().multiplyScalar(1.1));
    h.vel.addScaledVector(acc, dt);
    if (h.vel.length() > 26) h.vel.setLength(26);
    h.pos.addScaledVector(h.vel, dt);
    h.root.position.copy(h.pos);
    // nose into the flight direction, bank into turns, pitch with speed
    const yaw = Math.atan2(-h.vel.x, -h.vel.z);
    h.root.rotation.set(0, 0, 0, 'YXZ');
    h.root.rotation.y = yaw;
    h.root.rotation.x = -Math.min(0.3, h.vel.length() * 0.012);
    h.root.rotation.z = THREE.MathUtils.clamp(-acc.dot(new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))) * 0.03, -0.35, 0.35);
    if (leaving && Math.abs(h.pos.x) > 320) return true;
    // ---- door gun
    h.fireT -= dt;
    const gun = h.pos.clone().add(new THREE.Vector3(0, -1.2, 0));
    if (h.fireT <= 0 && !leaving) {
      if (h.burst <= 0) {
        // pick the closest enemy it can see
        let best: Combatant | null = null, bd = 140;
        for (const c of this.players()) {
          if (!c.alive || c.team === h.team) continue;
          const d = c.chest(new THREE.Vector3()).distanceTo(gun);
          if (d < bd && this.physics.lineOfSight(gun, c.chest(new THREE.Vector3()))) {
            bd = d;
            best = c;
          }
        }
        if (best && best !== h.target) this.hooks.heliEvent?.(h, 'engage');
        h.target = best;
        h.burst = best ? 14 : 0;
        h.fireT = best ? 0.35 : 0.5;
      } else if (h.target?.alive) {
        h.burst--;
        h.fireT = h.burst > 0 ? 0.085 : 1.5 + Math.random();
        const aim = h.target.chest(new THREE.Vector3());
        const dir = aim.sub(gun).normalize();
        dir.x += (Math.random() - 0.5) * 0.045;
        dir.y += (Math.random() - 0.5) * 0.045;
        dir.z += (Math.random() - 0.5) * 0.045;
        dir.normalize();
        // every machine flies its own copy of the gunship; each only damages what it owns
        NETF.noRoute++;
        const r = this.combat.fire(h.owner, gun, dir, HELI_GUN, 220);
        NETF.noRoute--;
        this.hooks.heliShot(h, gun, dir, r.end);
        if (r.killed) this.hooks.heliEvent?.(h, 'kill');
      } else {
        h.burst = 0;
      }
    }
    return false;
  }

  /** Ray test used by Combat so bullets can hit (and down) helicopters. */
  hitHeli(o: THREE.Vector3, d: THREE.Vector3, max: number, shooterTeam: number) {
    let best: { h: Heli; dist: number } | null = null;
    for (const h of this.helis) {
      if (h.team === shooterTeam || h.dying > 0) continue;
      const c = h.pos;
      const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const cc = ox * ox + oy * oy + oz * oz - 2.4 * 2.4;
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t <= max && (!best || t < best.dist)) best = { h, dist: t };
    }
    return best;
  }
  damageHeli(h: Heli, amount: number, by: Combatant | null) {
    if (h.dying > 0) return;
    h.health -= amount;
    if (h.health > 0 && h.health < 700) this.hooks.heliEvent?.(h, 'hit');
    if (h.health <= 0) {
      h.dying = 0.001;
      h.vel.y = 2;
      this.hooks.heliDown(h, by);
    }
  }

  static heliModel() {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: 0x3d4436, roughness: 0.6, metalness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f1c, roughness: 0.5, metalness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1218, roughness: 0.08, metalness: 0.9 });
    // fuselage (lathe, nose toward -Z)
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14;
      const r = 1.15 * Math.sin(Math.PI * Math.pow(u, 0.75)) * (u < 0.5 ? 1 : 1 - (u - 0.5) * 0.6) + 0.05;
      prof.push(new THREE.Vector2(r, (u - 0.5) * 5.6));
    }
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 16), paint);
    body.rotation.x = -Math.PI / 2;
    body.scale.set(1, 1, 0.9);
    g.add(body);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    canopy.position.set(0, 0.25, -1.6);
    canopy.scale.set(0.9, 0.7, 1.2);
    g.add(canopy);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.32, 5.2, 10), paint);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0.35, 4.6);
    g.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 0.9), paint);
    fin.position.set(0, 1.0, 7.0);
    fin.rotation.x = -0.35;
    g.add(fin);
    const stab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 0.5), paint);
    stab.position.set(0, 0.4, 6.2);
    g.add(stab);
    for (const sx of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.2, 6), dark);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(sx * 0.95, -1.35, -0.2);
      g.add(skid);
      for (const sz of [-1.2, 0.9]) {
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6), dark);
        strut.position.set(sx * 0.8, -1.0, sz);
        strut.rotation.z = sx * 0.4;
        g.add(strut);
      }
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.4, 10), dark);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(sx * 1.45, -0.4, -0.4);
      g.add(pod);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.6, 8), dark);
    mast.position.set(0, 1.25, -0.2);
    g.add(mast);
    const rotor = new THREE.Group();
    rotor.name = 'rotor';
    rotor.position.set(0, 1.6, -0.2);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 5.6), dark);
      blade.position.z = 2.8;
      const arm = new THREE.Group();
      arm.rotation.y = (i / 4) * Math.PI * 2;
      arm.add(blade);
      rotor.add(arm);
    }
    // motion-blur disc
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.7, 40), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    rotor.add(disc);
    g.add(rotor);
    const tail = new THREE.Group();
    tail.name = 'tailRotor';
    tail.position.set(0.18, 1.1, 7.15);
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.3, 0.12), dark);
      b.rotation.x = (i * Math.PI) / 2;
      tail.add(b);
    }
    g.add(tail);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }
}
