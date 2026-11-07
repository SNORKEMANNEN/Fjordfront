import type * as THREE from 'three';
import type { Combatant, HitPart } from '../game/Combatant';

/**
 * Shared switches between the game code and the network layer (kept tiny so gameplay files only
 * need this import).
 *
 * Ownership rule: every combatant is owned by exactly one machine (the host owns the bots and its
 * own player; each client owns its own player). Only the owner applies damage and decides deaths.
 * A combatant owned elsewhere is a *puppet* here: it is posed from the network, and direct hits on
 * it (bullets, melee, knives) are routed to its owner instead of being applied locally.
 * Area damage (grenades, mortar, helicopter) is simulated on every machine and each machine only
 * damages what it owns, so those never route (`noRoute`).
 */
export const NETF = {
  /** a network session is running */
  active: false,
  /** > 0 while area / replicated damage is being applied (puppets ignore it, nothing is routed) */
  noRoute: 0,
  /** while > 0, puppets may die locally (applying a death the owner already decided) */
  allowPuppetDeath: 0,
  /** name of the weapon of the direct attack being resolved (for kill feeds on the owner's side) */
  weapon: '',
  /** a direct hit landed on a puppet: send it to its owner */
  route: null as null | ((victim: Combatant, from: Combatant, amount: number, dir: THREE.Vector3, part: HitPart, weapon: string) => void),
};
