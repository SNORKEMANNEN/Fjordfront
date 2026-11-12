import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { Physics } from '../core/Physics';
import { Combatant } from './Combatant';
import { WeaponDef } from '../weapons/WeaponDefs';
import { Effects } from '../fx/Effects';
import { Viewmodel } from '../weapons/Viewmodel';
import { Surface, RayHit } from '../core/Physics';
import { EQUIP_BUILDERS, setLed } from '../weapons/EquipmentModels';

/** Kill-feed / damage identities for things that are not guns. */
export const FRAG = { id: 'frag', name: 'Frag Grenade', cls: 'Explosive' } as unknown as WeaponDef;
export const MORTAR = { id: 'mortar', name: 'Mortar Strike', cls: 'Explosive' } as unknown as WeaponDef;
export const MELEE = { id: 'melee', name: 'Melee', cls: 'Melee' } as unknown as WeaponDef;
export const HELI = { id: 'heli', name: 'Attack Helicopter', cls: 'Explosive' } as unknown as WeaponDef;
export const STUN = { id: 'stun', name: 'Stun Grenade', cls: 'Explosive' } as unknown as WeaponDef;
export const STICKY = { id: 'sticky', name: 'Sticky Grenade', cls: 'Explosive' } as unknown as WeaponDef;
export const C4 = { id: 'c4', name: 'C4', cls: 'Explosive' } as unknown as WeaponDef;
export const CLAYMORE = { id: 'claymore', name: 'Claymore', cls: 'Explosive' } as unknown as WeaponDef;
export const BARREL = { id: 'barrel', name: 'Explosive Barrel', cls: 'Explosive' } as unknown as WeaponDef;
export const VEHICLE = { id: 'vehicle', name: 'Vehicle Explosion', cls: 'Explosive' } as unknown as WeaponDef;

export type GrenadeKind = 'frag' | 'flash' | 'stun' | 'smoke' | 'sticky' | 'snapshot' | 'decoy' | 'c4';
/** fuse per kind (s): flash/stun pop fast, smoke after a short roll, C4 waits for its detonator */
export const FUSE: Record<GrenadeKind, number> = { frag: 3.5, flash: 1.6, stun: 1.6, smoke: 1.3, sticky: 2.3, snapshot: 1.15, decoy: 1.1, c4: 1e9 };
/** kinds that stick to what they hit */
const STICKS: Partial<Record<GrenadeKind, 'all' | 'world'>> = { sticky: 'all', c4: 'world' };

/** A decoy lying on the ground playing fake gunfire. */
export interface Decoy { p: THREE.Vector3; owner: Combatant; mesh: THREE.Object3D; t: number; life: number; next: number; burst: number; gun: number }

export interface SmokeCloud { p: THREE.Vector3; t: number; life: number; r: number; mesh: THREE.Object3D; wet?: boolean; id?: number }

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
  /**
   * sticky / C4: what it is stuck to (null = the world) and where on it. `obj` is a moving thing
   * it rides on (a door leaf, the helicopter): `local` / `localQ` are its pose in that object's frame.
   */
  stuck?: { to: Combatant | null; off: THREE.Vector3; obj?: THREE.Object3D; local?: THREE.Vector3; localQ?: THREE.Quaternion; what?: string };
  /** a trophy shot it down */
  dead?: boolean;
  /** seconds since it left the hand, and how long it was cooked before that */
  age: number;
  cooked: number;
  /** snapshot / decoy: bowled along the ground rather than thrown */
  roll: boolean;
  /** sank into water (slow, dark, quiet) */
  wet: boolean;
  /** last surface it touched (for sounds / the blast's dust) */
  surface?: Surface;
  /** ids for the fuse-hiss / roll audio emitters */
  id: number;
}

/**
 * How things bounce off each surface: e = how much of the speed into the surface comes back,
 * f = how much of the speed along it survives the contact, mu = how steep a slope it rests on.
 * Soft on grass and snow, lively on concrete and metal, dead on mud / soft dirt.
 */
export const BOUNCE: Partial<Record<Surface, { e: number; f: number; mu: number; snd: string }>> = {
  grass: { e: 0.2, f: 0.5, mu: 0.35, snd: 'bounce_soft' },
  snow: { e: 0.1, f: 0.35, mu: 0.45, snd: 'bounce_soft' },
  sand: { e: 0.12, f: 0.4, mu: 0.45, snd: 'bounce_soft' },
  fabric: { e: 0.12, f: 0.4, mu: 0.5, snd: 'bounce_soft' },
  flesh: { e: 0.15, f: 0.4, mu: 0.5, snd: 'bounce_soft' },
  dirt: { e: 0.1, f: 0.42, mu: 0.42, snd: 'bounce_mud' },
  gravel: { e: 0.28, f: 0.55, mu: 0.3, snd: 'bounce_gravel' },
  rock: { e: 0.45, f: 0.7, mu: 0.2, snd: 'bounce_hard' },
  concrete: { e: 0.5, f: 0.74, mu: 0.18, snd: 'bounce_hard' },
  asphalt: { e: 0.46, f: 0.72, mu: 0.2, snd: 'bounce_hard' },
  glass: { e: 0.42, f: 0.7, mu: 0.18, snd: 'bounce_hard' },
  wood: { e: 0.38, f: 0.68, mu: 0.22, snd: 'bounce_wood' },
  woodFloor: { e: 0.38, f: 0.7, mu: 0.2, snd: 'bounce_wood' },
  metal: { e: 0.52, f: 0.76, mu: 0.15, snd: 'bounce_metal' },
};
const DEFAULT_BOUNCE = { e: 0.33, f: 0.62, mu: 0.4, snd: 'bounce_hard' };
let NEXT_ID = 1;

export interface ExplosionHooks {
  /** damage dealt to a combatant (for hit markers, flinch, kill attribution) */
  damage(victim: Combatant, attacker: Combatant, amount: number, dir: THREE.Vector3, def: WeaponDef): void;
  kill(attacker: Combatant, victim: Combatant, def: WeaponDef): void;
  /** audio-visual: position, distance-based shake etc. */
  blast(p: THREE.Vector3, n: THREE.Vector3, scale: number, surface: Surface, def: WeaponDef): void;
  bounce(p: THREE.Vector3, speed: number, surface?: Surface, g?: Grenade): void;
  /** fell into water */
  splash?(p: THREE.Vector3, g: Grenade): void;
  /** every frame for every live grenade (fuse hiss, roll sound) */
  tick?(g: Grenade, dt: number): void;
  /** gone (exploded / popped / removed): stop its emitters */
  gone?(g: Grenade): void;
  /** the real surface of a hit (terrain colliders → the terrain's material map) */
  surface?(hit: RayHit): Surface;
  /** is this point in open water (sea)? */
  isWater?(p: THREE.Vector3): boolean;
  /** a moving object a sticky can ride on: door leaves (by collider), the helicopter (by sweep) */
  stickObj?(hit: RayHit | null, from: THREE.Vector3, dir: THREE.Vector3, len: number): { obj: THREE.Object3D; point: THREE.Vector3; normal: THREE.Vector3; what: string } | null;
  /** tacticals */
  flash(p: THREE.Vector3, owner: Combatant, g?: Grenade): void;
  stun(p: THREE.Vector3, owner: Combatant, g?: Grenade): void;
  smokeStart(p: THREE.Vector3, c?: SmokeCloud): void;
  smokeEmit(c: SmokeCloud, dt: number): void;
  /** sticky / C4 landed and stuck (victim = the soldier it stuck to) */
  stick?(g: Grenade, victim: Combatant | null): void;
  snapshot?(p: THREE.Vector3, owner: Combatant): void;
  decoyStart?(d: Decoy): void;
  /** a decoy's fake fire: called for each fake shot */
  decoyShot?(d: Decoy): void;
  /** active-protection systems: return true to shoot this grenade down */
  intercept?(g: Grenade): boolean;
}

/**
 * Frag grenades (cookable, bouncing, 3.5 s fuse) and the shared explosion model used by the
 * mortar killstreak: damage falls off with distance, walls between the blast and the target
 * absorb most of it, and teammates are safe (you are not, from your own grenade).
 */
export class Explosives {
  grenades: Grenade[] = [];
  smokes: SmokeCloud[] = [];
  decoys: Decoy[] = [];
  readonly fuseTime = 3.5;
  /** sight-line test against the smoke volume (set by the game) */
  smokeTest?: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  /** the grenade whose blast is being resolved right now (cook-kill attribution) */
  lastGrenade: Grenade | null = null;
  private protos: Record<GrenadeKind, THREE.Group> = {
    frag: Viewmodel.makeGrenade('frag'), flash: Viewmodel.makeGrenade('flash'), stun: Viewmodel.makeGrenade('stun'), smoke: Viewmodel.makeGrenade('smoke'),
    sticky: EQUIP_BUILDERS.sticky(), snapshot: EQUIP_BUILDERS.snapshot(), decoy: EQUIP_BUILDERS.decoy(), c4: EQUIP_BUILDERS.c4(),
  };

  constructor(private scene: THREE.Scene, private physics: Physics, private fx: Effects, private hooks: ExplosionHooks, private players: () => Combatant[]) {
    for (const pr of Object.values(this.protos)) {
      pr.scale.setScalar(1.15);
      pr.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
    }
  }

  throw(owner: Combatant, from: THREE.Vector3, vel: THREE.Vector3, fuse = this.fuseTime, kind: GrenadeKind = 'frag', cooked = 0) {
    const mesh = this.protos[kind].clone();
    const ring = mesh.getObjectByName('ring');
    if (ring) ring.visible = false;
    mesh.position.copy(from);
    this.scene.add(mesh);
    const spoon = mesh.getObjectByName('spoon');
    if (spoon) spoon.visible = false;
    const liner = mesh.getObjectByName('liner');
    if (liner) liner.visible = false;
    // C4 leaves the wrist with backspin (tumbling end over end about its long axis, face up);
    // snapshot / decoy are bowled and roll; frags tumble
    const right = new THREE.Vector3(vel.z, 0, -vel.x).normalize();
    const roll = kind === 'snapshot' || kind === 'decoy';
    const spin = kind === 'c4' ? right.clone().multiplyScalar(-14 - Math.random() * 4).add(new THREE.Vector3(0, (Math.random() - 0.5) * 1.5, 0))
      : roll ? right.clone().multiplyScalar(-12)
      : new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 8 - 4, Math.random() * 12 - 6);
    if (kind === 'c4') mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), right);
    const g: Grenade = { kind, owner, mesh, pos: from.clone(), vel: vel.clone(), spin, fuse, resting: false, bounces: 0, age: 0, cooked, roll, wet: false, id: NEXT_ID++ };
    // fresh clones share LED materials with the proto: give the blinking ones their own
    const led = mesh.getObjectByName('led') as THREE.Mesh | undefined;
    if (led) led.material = (led.material as THREE.Material).clone();
    const ring2 = mesh.getObjectByName('ring') as THREE.Mesh | undefined;
    if (ring2 && kind === 'snapshot') ring2.material = (ring2.material as THREE.Material).clone();
    this.grenades.push(g);
    return g;
  }

  update(dt: number) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.age += dt;
      if (g.dead || this.hooks.intercept?.(g)) {
        // shot down by a trophy system: gone without going off
        this.grenades.splice(i, 1);
        this.scene.remove(g.mesh);
        this.hooks.gone?.(g);
        continue;
      }
      if (g.stuck) {
        // riding on a soldier: follow them (dropping off when they die)
        const st = g.stuck;
        const to = st.to;
        if (to) {
          if (to.alive) g.pos.copy(to.position()).add(st.off);
          else st.to = null;
        } else if (st.obj && st.local) {
          // on a door leaf / the helicopter: ride with it (a swinging door carries it round)
          st.obj.updateWorldMatrix(true, false);
          g.pos.copy(st.local).applyMatrix4(st.obj.matrixWorld);
          if (st.localQ) g.mesh.quaternion.copy(st.obj.getWorldQuaternion(new THREE.Quaternion()).multiply(st.localQ));
          if (!st.obj.parent) {
            // its carrier is gone (the helicopter went down): fall
            g.stuck = undefined;
            g.resting = false;
          }
        }
      } else if (!g.resting) {
        // sub-steps keep fast throws from tunnelling through thin walls
        const n = g.vel.lengthSq() > 64 ? 3 : 2;
        for (let s = 0; s < n; s++) if (!g.stuck && !g.resting) this.integrate(g, dt / n);
      }
      g.mesh.position.copy(g.pos);
      if (!g.stuck && g.spin.lengthSq() > 1e-4) {
        // spin about world axes (keeps the C4's backspin and a rolling canister's roll true)
        const w = g.spin.length();
        g.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(g.spin.clone().divideScalar(w), w * dt));
      }
      this.hooks.tick?.(g, dt);
      // armed LEDs: sticky races faster as it runs out, C4 blinks slowly, decoy/snapshot pulse
      const led = g.mesh.getObjectByName('led');
      if (led) {
        const rate = g.kind === 'sticky' ? 6 + 18 * Math.max(0, 1 - g.fuse / FUSE.sticky) : g.kind === 'c4' ? 1.4 : 3;
        g.mesh.userData.blink = (g.mesh.userData.blink ?? 0) + dt * rate;
        setLed(led, (g.mesh.userData.blink % 1) < 0.35 ? 1 : 0.05);
      }
      if (g.kind === 'snapshot') {
        const ring = g.mesh.getObjectByName('ring') as THREE.Mesh | undefined;
        if (ring) (ring.material as THREE.MeshBasicMaterial).color.setRGB(0.15, 0.45, 0.9).multiplyScalar(1.5 + 3 * (0.5 + 0.5 * Math.sin(g.fuse * 30)));
      }
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this.hooks.gone?.(g);
        if (g.kind === 'decoy') {
          const d: Decoy = { p: g.pos.clone(), owner: g.owner, mesh: g.mesh, t: 0, life: 12, next: 0.3, burst: 0, gun: Math.floor(Math.random() * 1000) };
          this.decoys.push(d);
          this.hooks.decoyStart?.(d);
          continue;
        }
        if (g.kind === 'smoke') {
          // the canister stays where it lies and pours smoke for ~20 s
          const c: SmokeCloud = { p: g.pos.clone(), t: 0, life: 20, r: 0, mesh: g.mesh };
          this.smokes.push(c);
          c.wet = g.wet;
          this.hooks.smokeStart(c.p, c);
          continue;
        }
        this.scene.remove(g.mesh);
        this.lastGrenade = g;
        if (g.kind === 'frag') this.explode(g.pos, g.owner, FRAG, g.wet ? 5.5 : 8.5, g.wet ? 110 : 160);
        else if (g.kind === 'sticky') this.explode(g.pos, g.owner, STICKY, 7.5, 170, g.stuck?.to ?? null);
        else if (g.kind === 'snapshot') this.hooks.snapshot?.(g.pos.clone(), g.owner);
        else if (g.kind === 'flash') this.hooks.flash(g.pos.clone(), g.owner, g);
        else this.hooks.stun(g.pos.clone(), g.owner, g);
        this.lastGrenade = null;
      }
    }
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.t += dt;
      d.next -= dt;
      // bursts of 3-9 rounds with irregular gaps, like someone fighting from cover
      if (d.next <= 0 && d.t < d.life - 0.5) {
        this.hooks.decoyShot?.(d);
        if (d.burst > 0) {
          d.burst--;
          d.next = 0.075 + Math.random() * 0.03;
        } else {
          d.burst = 2 + Math.floor(Math.random() * 7);
          d.next = 0.5 + Math.random() * 1.6;
        }
      }
      const led = d.mesh.getObjectByName('led');
      if (led) setLed(led, d.next < 0.1 ? 1 : 0.15);
      if (d.t >= d.life) {
        this.scene.remove(d.mesh);
        this.decoys.splice(i, 1);
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
    if (this.smokeTest) return this.smokeTest(a, b);
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
    if (g.wet) {
      // sinking: heavy drag, slow fall, a little drift
      g.vel.multiplyScalar(Math.max(0, 1 - 3.2 * dt));
      g.vel.y -= 1.6 * dt;
      g.spin.multiplyScalar(Math.max(0, 1 - 2 * dt));
    } else {
      g.vel.y -= 9.81 * dt;
      g.vel.multiplyScalar(1 - 0.05 * dt); // a little air drag
    }
    const step = g.vel.clone().multiplyScalar(dt);
    const len = step.length();
    if (len < 1e-5) return;
    const dir = step.clone().divideScalar(len);
    const hit = this.physics.raycast(g.pos, dir, len + 0.045);
    const sticks = STICKS[g.kind];
    if (sticks === 'all') {
      // a sticky thrown at someone sticks to them
      let best: { c: Combatant; d: number; p: THREE.Vector3 } | null = null;
      for (const c of this.players()) {
        if (!c.alive || c === g.owner) continue;
        if (c.position().distanceToSquared(g.pos) > 9) continue;
        const h = c.hitTest(g.pos, dir, hit ? hit.distance : len + 0.05);
        if (h && (!best || h.dist < best.d)) best = { c, d: h.dist, p: h.point };
      }
      if (best) {
        g.pos.copy(best.p);
        g.stuck = { to: best.c, off: best.p.clone().sub(best.c.position()), what: 'player' };
        g.vel.set(0, 0, 0);
        this.hooks.stick?.(g, best.c);
        return;
      }
    }
    if (sticks) {
      // doors (rides the swing) and the helicopter
      const mv = this.hooks.stickObj?.(hit, g.pos, dir, len + 0.05);
      if (mv) {
        const n = mv.normal.clone();
        if (n.dot(dir) > 0) n.negate();
        g.pos.copy(mv.point).addScaledVector(n, 0.014);
        g.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        mv.obj.updateWorldMatrix(true, false);
        const inv = mv.obj.matrixWorld.clone().invert();
        const wq = mv.obj.getWorldQuaternion(new THREE.Quaternion());
        g.stuck = { to: null, off: new THREE.Vector3(), obj: mv.obj, local: g.pos.clone().applyMatrix4(inv), localQ: wq.invert().multiply(g.mesh.quaternion), what: mv.what };
        g.vel.set(0, 0, 0);
        g.spin.set(0, 0, 0);
        g.resting = true;
        this.hooks.stick?.(g, null);
        return;
      }
    }
    // into the sea: a splash, then it sinks (and goes off underwater, muffled)
    if (!g.wet && g.vel.y < 0 && this.hooks.isWater?.(g.pos.clone().add(step))) {
      g.wet = true;
      g.vel.multiplyScalar(0.25);
      this.hooks.splash?.(g.pos.clone().add(step).setY(0.02), g);
      if (sticks) g.resting = false;
    }
    if (!hit) {
      g.pos.add(step);
      return;
    }
    const surf = this.hooks.surface?.(hit) ?? hit.info.surface;
    g.surface = surf;
    if (sticks && !g.wet) {
      // stick flat against the surface, the gel / back side down
      const n = hit.normal.clone();
      if (n.dot(dir) > 0) n.negate();
      g.pos.copy(hit.point).addScaledVector(n, g.kind === 'c4' ? 0.018 : 0.012);
      g.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      if (g.kind === 'c4') g.mesh.rotateY(Math.random() * Math.PI * 2);
      g.vel.set(0, 0, 0);
      g.spin.set(0, 0, 0);
      g.stuck = { to: null, off: new THREE.Vector3(), what: hit.info.tag === 'car' ? 'car' : 'world' };
      g.resting = true;
      this.hooks.stick?.(g, null);
      return;
    }
    // bounce: per surface, a rolling canister keeps more of its speed along the ground
    const B = BOUNCE[surf] ?? DEFAULT_BOUNCE;
    const n = hit.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    g.pos.copy(hit.point).addScaledVector(n, 0.046);
    const vIn = g.vel.dot(n);
    const vn = n.clone().multiplyScalar(vIn);
    const vt = g.vel.clone().sub(vn);
    const speed = g.vel.length();
    const ground = n.y > 0.5;
    const keep = g.roll && ground ? Math.min(0.96, B.f + 0.25) : B.f;
    const e = g.wet ? 0.05 : g.roll && ground ? B.e * 0.5 : B.e;
    g.vel.copy(vt.multiplyScalar(keep)).addScaledVector(vn, -e);
    if (ground && g.vel.length() < 4) {
      // in contact with the ground: rolling — gravity along the slope keeps it going downhill
      // (and down stairs), rolling resistance slows it on the flat
      const along = new THREE.Vector3(0, -9.81, 0).addScaledVector(n, 9.81 * n.y);
      g.vel.addScaledVector(along, dt);
      const rr = g.roll ? 0.9 : g.kind === 'frag' ? 2.4 : 2.0;
      g.vel.multiplyScalar(Math.max(0, 1 - rr * dt));
      // the roll: spin about the axis across the motion
      const vh = g.vel.clone().addScaledVector(n, -g.vel.dot(n));
      const r = g.kind === 'c4' ? 0 : 0.03;
      if (r > 0 && vh.lengthSq() > 0.01) g.spin.crossVectors(n, vh).multiplyScalar(1 / r * 0.9);
      else g.spin.multiplyScalar(0.5);
    } else g.spin.multiplyScalar(0.6);
    g.bounces++;
    if (-vIn > 1.0 || (speed > 2.5 && g.bounces < 3)) this.hooks.bounce(g.pos, Math.max(-vIn, speed * 0.5), surf, g);
    // comes to rest where the slope is gentle enough for its friction
    const slope = Math.sqrt(Math.max(0, 1 - n.y * n.y)) / Math.max(0.05, n.y);
    const mu = g.roll ? B.mu * 0.4 : B.mu;
    if (n.y > 0.65 && g.vel.length() < (g.roll ? 0.18 : 0.35) && slope < mu) {
      g.resting = true;
      g.vel.set(0, 0, 0);
      g.spin.set(0, 0, 0);
    }
  }

  /** Blast at p; returns the number of kills. */
  /**
   * Blast at p. `stuckTo` takes the full blast whatever the cover; `cone` makes it directional
   * (claymore: full damage inside the cone, only a little behind it).
   */
  explode(p: THREE.Vector3, owner: Combatant, def: WeaponDef, radius: number, maxDmg: number, stuckTo: Combatant | null = null, cone?: { dir: THREE.Vector3; cos: number }) {
    // area damage is simulated on every machine; each only damages what it owns (see NetFlags)
    NETF.noRoute++;
    try {
      this.explodeInner(p, owner, def, radius, maxDmg, stuckTo, cone);
    } finally {
      NETF.noRoute--;
    }
    this.onExplode?.(p, radius, owner, def);
  }
  /** world reaction to any blast (destructibles, deployables, chained explosives) */
  onExplode?: (p: THREE.Vector3, radius: number, owner: Combatant, def: WeaponDef) => void;
  /** set off a C4 charge now */
  detonate(g: Grenade) {
    const i = this.grenades.indexOf(g);
    if (i < 0) return;
    this.grenades.splice(i, 1);
    this.scene.remove(g.mesh);
    this.hooks.gone?.(g);
    this.explode(g.pos, g.owner, C4, g.wet ? 5.5 : 8, g.wet ? 150 : 230, g.stuck?.to ?? null);
  }
  private explodeInner(p: THREE.Vector3, owner: Combatant, def: WeaponDef, radius: number, maxDmg: number, stuckTo: Combatant | null, cone?: { dir: THREE.Vector3; cos: number }) {
    // surface underneath for the debris colour
    const down = this.physics.raycast(p.clone().setY(p.y + 0.5), new THREE.Vector3(0, -1, 0), 2.5);
    const n = down && down.distance < 1.6 ? down.normal.clone() : new THREE.Vector3(0, 1, 0);
    const surface: Surface = down ? (this.hooks.surface?.(down) ?? down.info.surface) : 'dirt';
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
      if (c === stuckTo) k = 1;
      else if (cone) {
        const to = chest.clone().sub(p).setY(0).normalize();
        if (to.dot(cone.dir) < cone.cos) {
          // behind / beside a directional mine: only the back-blast up close
          if (d > 2) continue;
          k *= 0.3;
        }
      }
      // cover: walls between blast and body soak most of it
      if (c !== stuckTo && !this.physics.lineOfSight(origin, chest) && !this.physics.lineOfSight(origin, feet.clone().setY(feet.y + 0.3))) {
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
    for (const d of this.decoys) this.scene.remove(d.mesh);
    this.grenades.length = 0;
    this.smokes.length = 0;
    this.decoys.length = 0;
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
