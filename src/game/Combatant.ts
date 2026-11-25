import * as THREE from 'three';

export type HitPart = 'head' | 'body' | 'limb';

/** Anything that can shoot and be shot: the local player, bots, and (later) remote players. */
export interface Combatant {
  id: number;
  name: string;
  team: 0 | 1;
  isPlayer: boolean;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  score: number;
  assists: number;
  position(): THREE.Vector3;
  eye(out?: THREE.Vector3): THREE.Vector3;
  /** where this combatant is looking (used by spawn view-cone checks) */
  lookDir?(out?: THREE.Vector3): THREE.Vector3;
  chest(out?: THREE.Vector3): THREE.Vector3;
  hitTest(o: THREE.Vector3, d: THREE.Vector3, max: number): { dist: number; part: HitPart; point: THREE.Vector3 } | null;
  onDamaged(from: Combatant | null, amount: number, dir: THREE.Vector3, part?: HitPart): void;
  /** body armour 0..100 and a helmet (Sabotasje) */
  armor?: number;
  helmet?: boolean;
  /** (Update 47) incapacitated: on the ground, waiting for a revive or bleeding out */
  downed?: boolean;
  /** (Update 47) armour plates in the carrier: hit points each (0 = broken), and spares carried */
  plates?: number[];
  spare?: number;
}

/**
 * Armour plates (Update 47): a torso hit lands on the carrier's plates first. A plate soaks the
 * whole hit up to what it has left (rifle rounds chew through it in a few hits, a .338 shatters it
 * outright); the rest carries through to the soldier. Head and limb hits skip the plates.
 * Returns the damage that reaches the soldier and which plate broke (-1: none).
 */
export function plateAbsorb(c: Combatant, dmg: number, part: HitPart, cls: string): { through: number; broke: number; hitPlate: boolean } {
  const pl = c.plates;
  if (!pl || part !== 'body' || dmg <= 0 || c.downed) return { through: dmg, broke: -1, hitPlate: false };
  // the front plate takes it first; the back plate when the front is gone
  const i = pl.findIndex((h) => h > 0);
  if (i < 0) return { through: dmg, broke: -1, hitPlate: false };
  const mul = cls === 'Sniper' ? 2.2 : cls === 'Marksman' ? 1.5 : cls === 'Shotgun' ? 0.8 : cls === 'Pistol' || cls === 'SMG' ? 0.9 : cls === 'Explosive' ? 1.4 : 1;
  const want = dmg * mul;
  if (want < pl[i]) {
    pl[i] -= want;
    return { through: 0, broke: -1, hitPlate: true };
  }
  const left = (want - pl[i]) / mul;
  pl[i] = 0;
  return { through: left, broke: i, hitPlate: true };
}

/** armour penetration by weapon class: the share of the damage that still goes through */
const ARMOR_PEN: Record<string, number> = { Pistol: 0.55, SMG: 0.6, Shotgun: 0.7, 'Assault Rifle': 0.74, Marksman: 0.85, Sniper: 0.95, LMG: 0.78, Melee: 0.85 };
/**
 * Body armour (Sabotasje): a vest takes a share of body / limb damage, a helmet of head damage;
 * the armour wears down by half of what it stopped. Returns the damage that reaches the soldier.
 */
export function armorAbsorb(c: Combatant, dmg: number, part: HitPart, cls: string): number {
  const a = c.armor ?? 0;
  if (a <= 0 || dmg <= 0) return dmg;
  if (part === 'head' && !c.helmet) return dmg;
  const pen = ARMOR_PEN[cls] ?? 0.75;
  const through = dmg * pen;
  const stopped = dmg - through;
  const wear = stopped * 0.5;
  if (wear > a) {
    // the vest gives out partway
    const k = a / wear;
    c.armor = 0;
    return through + stopped * (1 - k);
  }
  c.armor = a - wear;
  return through;
}

/** Serializable snapshot used by the scoreboard and future network replication. */
export interface CombatantState {
  id: number;
  name: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  score: number;
  alive: boolean;
  isPlayer: boolean;
}
