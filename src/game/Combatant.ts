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
