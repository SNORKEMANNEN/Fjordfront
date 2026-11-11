import * as THREE from 'three';
import type { NavGraph, NavNode } from './NavGraph';
import type { Physics } from '../core/Physics';
import type { Combatant } from '../game/Combatant';

/**
 * Shared pieces of the bots' brains:
 *  - CoverMap: per nav node, which of 8 directions are blocked at crouch height (low cover) and at
 *    standing head height (full cover), so a bot can pick a spot that actually shields it from
 *    where the threat is — and knows whether to duck behind it or lean out of it;
 *  - visibility: how easy a target is to notice (stance, movement, muzzle flash, light, foliage);
 *  - AimController: human-like aim — reaction time, a sprung acquisition that overshoots and
 *    settles, tracking lag on moving targets, recoil climb and recovery;
 *  - Fireteams + player orders, and local avoidance between soldiers.
 */

// ------------------------------------------------------------------ cover
export interface CoverInfo {
  /** bit i: direction i (i·45°, 0 = +Z… see dirAt) blocked at crouch height */
  low: number;
  /** bit i: blocked at standing head height */
  high: number;
}
const DIRS = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(Math.sin((i / 8) * Math.PI * 2), 0, Math.cos((i / 8) * Math.PI * 2)));
export function dirIndex(dx: number, dz: number) {
  let a = Math.atan2(dx, dz) / (Math.PI * 2);
  if (a < 0) a += 1;
  return Math.round(a * 8) % 8;
}

export class CoverMap {
  info: CoverInfo[] = [];
  constructor(private nav: NavGraph, physics: Physics) {
    const o = new THREE.Vector3();
    for (const n of nav.nodes) {
      let low = 0, high = 0;
      for (let i = 0; i < 8; i++) {
        o.set(n.p.x, n.p.y + 0.85, n.p.z);
        if (physics.raycast(o, DIRS[i], 2.2)) low |= 1 << i;
        o.y = n.p.y + 1.55;
        if (physics.raycast(o, DIRS[i], 2.2)) high |= 1 << i;
      }
      this.info[n.id] = { low, high };
    }
  }
  /** cover quality of a node against a threat position: 0 none, 1 low (duck), 2 full (lean out) */
  quality(n: NavNode, threat: THREE.Vector3) {
    const c = this.info[n.id];
    if (!c) return 0;
    const d = dirIndex(threat.x - n.p.x, threat.z - n.p.z);
    // the direction and its neighbours
    const m = (1 << d) | (1 << ((d + 1) % 8)) | (1 << ((d + 7) % 8));
    const lowHits = popcount(c.low & m), highHits = popcount(c.high & m);
    if (highHits >= 2) return 2;
    if (lowHits >= 2 || (c.low & (1 << d))) return 1;
    return 0;
  }
  /** which side to lean out of full cover (towards the open neighbour direction): -1 left / 1 right */
  leanSide(n: NavNode, threat: THREE.Vector3) {
    const c = this.info[n.id];
    if (!c) return 1;
    const d = dirIndex(threat.x - n.p.x, threat.z - n.p.z);
    const l = (c.high >> ((d + 1) % 8)) & 1, r = (c.high >> ((d + 7) % 8)) & 1;
    // directions increase counter-clockwise seen from above; facing the threat, +1 is to the left
    if (l && !r) return 1;
    if (r && !l) return -1;
    return n.id % 2 ? 1 : -1;
  }
  /**
   * Best cover node near `from` against `threat`: shielded, close, not too close to the threat,
   * not claimed by a teammate.
   */
  find(from: THREE.Vector3, threat: THREE.Vector3, radius: number, claimed: Set<number>, minThreat = 8): { node: NavNode; q: number } | null {
    let best: NavNode | null = null, bs = -Infinity, bq = 0;
    for (const n of this.nav.near(from, radius)) {
      if (!n.links.length || claimed.has(n.id)) continue;
      const q = this.quality(n, threat);
      if (!q) continue;
      const dt = n.p.distanceTo(threat);
      if (dt < minThreat) continue;
      const s = q * 6 - n.p.distanceTo(from) * 0.35 - Math.max(0, dt - 45) * 0.08 + (q === 1 ? 1 : 0);
      if (s > bs) {
        bs = s;
        best = n;
        bq = q;
      }
    }
    return best ? { node: best, q: bq } : null;
  }
}
function popcount(x: number) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// ------------------------------------------------------------------ visibility
/** what a soldier exposes: stance, motion, muzzle flash (filled by the game for the player and by bots) */
export interface Exposure {
  stance: 'stand' | 'crouch' | 'prone';
  speed: number;
  /** seconds since this combatant last fired (muzzle flash and noise) */
  sinceFire: number;
  suppressed: boolean;
  /** standing in thick vegetation */
  foliage: number;
  /** lit by a light / weapon light at night */
  lit: boolean;
}

/**
 * Detection rate (per second) of a target by an observer. 1.0 accumulated awareness = spotted.
 * Close, moving, standing, shooting targets are spotted in a blink; a still, prone soldier in
 * grass 80 m away may take many seconds — or never be noticed in the periphery.
 */
export function detectRate(dist: number, viewDist: number, cosOff: number, e: Exposure, night: boolean) {
  // focal (±35°) vs peripheral (to ±100°) vs behind
  let fov = cosOff > 0.82 ? 1 : cosOff > -0.17 ? 0.32 : 0;
  if (dist < 4) fov = Math.max(fov, 0.6); // you sense someone right next to you
  if (!fov) return 0;
  const stance = e.stance === 'prone' ? 0.3 : e.stance === 'crouch' ? 0.62 : 1;
  const motion = e.speed > 4 ? 1.6 : e.speed > 1.2 ? 1.2 : 0.7;
  const flash = e.sinceFire < 1.2 ? (e.suppressed ? 1.6 : 3.2) : 1;
  const foliage = 1 - Math.min(0.6, e.foliage * (dist > 15 ? 0.7 : 0.2));
  // at night the soldiers wear goggles: still a little worse than daylight, unless the target is lit
  const light = night && !e.lit ? 0.75 : 1;
  const range = dist < 12 ? 7 : 55 / dist;
  const fall = Math.max(0, 1 - dist / viewDist);
  return fov * stance * motion * flash * foliage * light * range * (0.35 + 0.65 * fall);
}

// ------------------------------------------------------------------ aim
export interface AimSkill {
  /** seconds before the first reaction to a new target */
  reaction: number;
  /** spring stiffness (higher = snappier), damping ratio (<1 overshoots) */
  stiff: number;
  damp: number;
  /** initial acquisition error (radians at 10 m, grows with distance less than linearly) */
  acquire: number;
  /** tracking lag on a moving target (0 = perfect lead, 1 = no lead at all) */
  lag: number;
  /** fraction of recoil climb the soldier pulls down */
  control: number;
  /** extra random sway (radians) */
  sway: number;
}
export const SKILL: AimSkill[] = [
  { reaction: 0.62, stiff: 26, damp: 0.5, acquire: 0.14, lag: 0.85, control: 0.35, sway: 0.012 },
  { reaction: 0.4, stiff: 42, damp: 0.58, acquire: 0.1, lag: 0.55, control: 0.6, sway: 0.008 },
  { reaction: 0.25, stiff: 64, damp: 0.66, acquire: 0.07, lag: 0.25, control: 0.82, sway: 0.005 },
];

/** Sprung aim: overshoots and settles on a new target, lags a moving one, climbs with recoil. */
export class AimController {
  yawVel = 0;
  pitchVel = 0;
  /** error offset that decays (acquisition) */
  errYaw = 0;
  errPitch = 0;
  recoil = 0;
  private swayT = Math.random() * 100;
  /** called when a new target is acquired */
  acquire(skill: AimSkill, dist: number, rnd: () => number) {
    const s = skill.acquire * (0.6 + 0.4 * Math.min(3, Math.sqrt(dist / 10)));
    this.errYaw = (rnd() - 0.5) * 2 * s;
    this.errPitch = (rnd() - 0.5) * 1.4 * s;
  }
  kick(amount: number, skill: AimSkill) {
    this.recoil += amount * (1 - skill.control);
  }
  /** integrate towards (wantYaw, wantPitch); returns the current aim error to the ideal */
  step(cur: { yaw: number; pitch: number }, wantYaw: number, wantPitch: number, skill: AimSkill, dt: number, stunned: boolean) {
    this.swayT += dt;
    const sway = skill.sway * (stunned ? 4 : 1);
    const ty = wantYaw + this.errYaw + Math.sin(this.swayT * 1.3) * sway;
    const tp = wantPitch + this.errPitch + this.recoil + Math.sin(this.swayT * 1.7 + 1) * sway * 0.7;
    // the acquisition error and recoil wear off as the soldier settles
    const k = Math.exp(-dt * 2.4);
    this.errYaw *= k;
    this.errPitch *= k;
    this.recoil *= Math.exp(-dt * 5);
    const w = Math.sqrt(skill.stiff) * (stunned ? 0.5 : 1);
    const z = skill.damp;
    let dy = ty - cur.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    // critically / under-damped spring per axis
    this.yawVel += (w * w * dy - 2 * z * w * this.yawVel) * dt;
    this.pitchVel += (w * w * (tp - cur.pitch) - 2 * z * w * this.pitchVel) * dt;
    cur.yaw += this.yawVel * dt;
    cur.pitch = THREE.MathUtils.clamp(cur.pitch + this.pitchVel * dt, -1.3, 1.3);
    let ey = wantYaw - cur.yaw;
    ey = Math.atan2(Math.sin(ey), Math.cos(ey));
    return Math.hypot(ey, wantPitch - cur.pitch);
  }
}

// ------------------------------------------------------------------ squads & orders
export type OrderKind = 'attack' | 'defend' | 'follow' | 'regroup' | 'hold';
export interface Order {
  kind: OrderKind;
  pos: THREE.Vector3;
  until: number;
  /** follow / regroup: whom to follow */
  who?: Combatant;
}

export interface Fireteam {
  id: number;
  team: 0 | 1;
  members: { id: number }[];
  /** the player leads this fireteam (orders) */
  player: boolean;
}

// ------------------------------------------------------------------ avoidance
/**
 * Steering separation between soldiers: anyone inside 1.6 m pushes the others away (stronger the
 * closer), and someone right ahead in the walking direction makes a soldier step aside to a
 * consistent side, so two bots in a corridor pass instead of shoving. O(n²) over ~25 bodies.
 */
export function avoidance(agents: { pos: THREE.Vector3; vel: THREE.Vector3; out: THREE.Vector3; id: number; alive: boolean }[]) {
  for (const a of agents) a.out.set(0, 0, 0);
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j];
      if (!b.alive) continue;
      const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
      if (Math.abs(a.pos.y - b.pos.y) > 1.6) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > 6.25 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      if (d < 1.6) {
        const f = (1.6 - d) / 1.6;
        a.out.x += (dx / d) * f * 1.6;
        a.out.z += (dz / d) * f * 1.6;
        b.out.x -= (dx / d) * f * 1.6;
        b.out.z -= (dz / d) * f * 1.6;
      }
      // b right ahead of a (in a's walking direction): a sidesteps to its right; and vice versa
      for (const [p, q, s] of [[a, b, -1], [b, a, 1]] as const) {
        const sp = Math.hypot(p.vel.x, p.vel.z);
        if (sp < 0.8) continue;
        const fx = p.vel.x / sp, fz = p.vel.z / sp;
        const ox = q.pos.x - p.pos.x, oz = q.pos.z - p.pos.z;
        const ahead = ox * fx + oz * fz;
        const side = ox * -fz + oz * fx;
        if (ahead > 0 && ahead < 2.5 && Math.abs(side) < 0.9) {
          const k = (1 - ahead / 2.5) * 1.2;
          const dir = side > 0.05 ? -1 : side < -0.05 ? 1 : s * (p.id % 2 ? 1 : -1);
          p.out.x += -fz * dir * k;
          p.out.z += fx * dir * k;
        }
      }
    }
  }
}
