import * as THREE from 'three';
import type { Combatant } from './Combatant';
import { WEAPONS, WeaponDef } from '../weapons/WeaponDefs';
import type { WeaponId } from '../weapons/WeaponModels';
import { SV_SITES, Rect } from '../world/maps/Solvik';

/**
 * Sabotasje (Update 42): round-based 6v6 on Solvik, after the classic defusal format.
 *
 * One side attacks: one attacker carries the demolition charge and plants it on site A or B
 * (hold F for 3.2 s inside the zone). The defenders stop the plant, or defuse the charge (hold F
 * by it: 10 s, 5 s with wire cutters) before its 40 s fuse runs out. No respawns: a round ends
 * when a side is wiped out, the charge goes off, it is defused, or the clock runs out (the
 * defenders hold). Money (kroner) is earned from kills, round wins and losses, plants and
 * defuses, and spent in the buy phase. First to 7 rounds; sides swap after round 6; at 6–6,
 * overtime in blocks of four rounds with 10 000 kr each.
 *
 * Twists: the wire gamble (cut one of three wires instead of finishing the defuse: the right one
 * defuses at once, a wrong one sets it off; cutters rule one wrong wire out), bounties on players
 * who keep winning their fights round after round, and a clutch bonus for the last soldier
 * standing who wins against two or more.
 *
 * Pure game state (no rendering): the game wires it to the world, the HUD and the bots, and the
 * host replicates it online.
 */
export type SabPhase = 'warmup' | 'buy' | 'live' | 'planted' | 'post' | 'ended';
export type Nade = 'he' | 'flash' | 'smoke' | 'fire' | 'decoy';
export const NADES: Nade[] = ['he', 'fire', 'flash', 'smoke', 'decoy'];
export type EndReason = 'elim' | 'time' | 'exploded' | 'defused';

export interface Kit {
  primary: WeaponId | null;
  secondary: WeaponId;
  armor: number;
  helmet: boolean;
  cutters: boolean;
  nades: Record<Nade, number>;
}
export interface SabStats {
  kills: number;
  deaths: number;
  assists: number;
  dmg: number;
  openings: number;
  clutches: number;
  mvps: number;
  plants: number;
  defuses: number;
  /** consecutive rounds with at least one kill (bounty) */
  hotRounds: number;
  /** this round */
  rk: number;
  rdmg: number;
}
export interface Seat {
  c: Combatant;
  money: number;
  kit: Kit;
  st: SabStats;
  /** the last round's purchases (for "rebuy") */
  last: string[];
}

export interface ShopItem {
  id: string;
  name: string;
  price: number;
  cat: 'pistol' | 'smg' | 'heavy' | 'rifle' | 'gear' | 'nade';
  /** only one side can buy it */
  side?: 'atk' | 'def';
  weapon?: WeaponId;
  nade?: Nade;
  desc: string;
}
/** the buy menu (prices in kroner; the guns keep their fictional names) */
export const SHOP: ShopItem[] = [
  { id: 'p80', name: 'P80', price: 200, cat: 'pistol', weapon: 'p80', desc: 'Standard sidearm. Free on spawn.' },
  { id: 'mp18', name: 'MP-18', price: 500, cat: 'pistol', weapon: 'mp18', desc: 'Machine pistol. Eco-round spray.' },
  { id: 'rv357', name: 'R357', price: 700, cat: 'pistol', weapon: 'rv357', desc: 'Revolver. One to the head ends it.' },
  { id: 'ums45', name: 'UMS-45', price: 1200, cat: 'smg', weapon: 'ums45', desc: 'Slow, heavy SMG. 600 kr per kill.' },
  { id: 'stille9', name: 'STILLE-9', price: 1300, cat: 'smg', weapon: 'stille9', desc: 'Suppressed SMG. Quiet lurker.' },
  { id: 'mp7', name: 'MP7', price: 1500, cat: 'smg', weapon: 'mp7', desc: 'Fast PDW. 600 kr per kill.' },
  { id: 'db12', name: 'TVILLING', price: 1050, cat: 'heavy', weapon: 'db12', desc: 'Double barrel. Two shells, close only.' },
  { id: 'pump12', name: 'PUMP-12', price: 1200, cat: 'heavy', weapon: 'pump12', desc: 'Pump shotgun. 900 kr per kill.' },
  { id: 'as20', name: 'STORM-20', price: 1800, cat: 'heavy', weapon: 'as20', desc: 'Auto shotgun.' },
  { id: 'lmg', name: 'KVL-7', price: 5200, cat: 'heavy', weapon: 'lmg', desc: 'Belt-fed LMG. Hold a lane alone.' },
  { id: 'ks17', name: 'KS-17', price: 2050, cat: 'rifle', weapon: 'ks17', desc: 'Budget rifle. Force-buy favourite.' },
  { id: 'hval47', name: 'HVAL-47', price: 2700, cat: 'rifle', weapon: 'hval47', desc: 'Hard-hitting rifle. Headshot kills through a helmet.' },
  { id: 'k416', name: 'K416', price: 3100, cat: 'rifle', weapon: 'k416', desc: 'Accurate carbine.' },
  { id: 'kr98', name: 'KR-98k', price: 1700, cat: 'rifle', weapon: 'kr98', desc: 'Light bolt carbine. Cheap long range.' },
  { id: 'dmr14', name: 'FJ-14', price: 3600, cat: 'rifle', weapon: 'dmr14', desc: 'Marksman rifle, 4× scope.' },
  { id: 'skv338', name: 'SKV .338', price: 4750, cat: 'rifle', weapon: 'skv338', desc: 'Bolt sniper. One shot to the body. 100 kr per kill.' },
  { id: 'vest', name: 'VEST', price: 650, cat: 'gear', desc: 'Body armour: much less damage to the body.' },
  { id: 'vesthelm', name: 'VEST + HELMET', price: 1000, cat: 'gear', desc: 'Armour and a helmet (headshots hurt less).' },
  { id: 'cutters', name: 'WIRE CUTTERS', price: 400, cat: 'gear', side: 'def', desc: 'Defuse in 5 s instead of 10. Rules out one wrong wire.' },
  { id: 'he', name: 'HE GRENADE', price: 300, cat: 'nade', nade: 'he', desc: 'Explosive grenade.' },
  { id: 'fire', name: 'FIREBOMB', price: 450, cat: 'nade', nade: 'fire', desc: 'Bursts into a pool of fire on impact. Smoke puts it out.' },
  { id: 'flash', name: 'FLASHBANG', price: 200, cat: 'nade', nade: 'flash', desc: 'Blinds anyone facing it. Carry two.' },
  { id: 'smoke', name: 'SMOKE', price: 300, cat: 'nade', nade: 'smoke', desc: 'Blocks sight lines for 18 s.' },
  { id: 'decoy', name: 'DECOY', price: 50, cat: 'nade', nade: 'decoy', desc: 'Fake gunfire on the radar and in their ears.' },
];
export const NADE_MAX: Record<Nade, number> = { he: 1, fire: 1, flash: 2, smoke: 1, decoy: 1 };
export const NADE_TOTAL = 4;

export const START_MONEY = 800;
export const OT_MONEY = 10000;
export const MAX_MONEY = 16000;
export const BUY_TIME = 12;
/** extra seconds after the buy phase while you may still buy inside your spawn */
export const BUY_GRACE = 18;
export const ROUND_TIME = 115;
export const FUSE = 40;
export const PLANT_TIME = 3.2;
export const DEFUSE_TIME = 10;
export const DEFUSE_KIT = 5;
/** the wire panel opens this far into a defuse */
export const WIRE_OPEN = 1.2;
export const POST_TIME = 6;
export const WIN_AT = 7;
export const HALF = 6;

/** kill reward by weapon class (the classic numbers) */
export function killReward(def: WeaponDef | null, weaponName: string): number {
  if (!def) return /knife/i.test(weaponName) ? 1500 : 300;
  if (def.cls === 'Melee') return 1500;
  if (def.cls === 'SMG') return 600;
  if (def.cls === 'Shotgun') return def.id === 'as20' ? 600 : 900;
  if (def.cls === 'Sniper') return 100;
  return 300;
}
const BOUNTY_FROM = 3;
export const bountyFor = (hot: number) => (hot < BOUNTY_FROM ? 0 : Math.min(3000, 1000 + 500 * (hot - BOUNTY_FROM)));

export function defaultKit(): Kit {
  return { primary: null, secondary: 'p80', armor: 0, helmet: false, cutters: false, nades: { he: 0, fire: 0, flash: 0, smoke: 0, decoy: 0 } };
}
const newStats = (): SabStats => ({ kills: 0, deaths: 0, assists: 0, dmg: 0, openings: 0, clutches: 0, mvps: 0, plants: 0, defuses: 0, hotRounds: 0, rk: 0, rdmg: 0 });
export const nadeCount = (k: Kit) => NADES.reduce((a, n) => a + k.nades[n], 0);

export interface Charge {
  state: 'none' | 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  holder: Combatant | null;
  pos: THREE.Vector3;
  site: 'A' | 'B' | null;
  /** the live wire (0..2) chosen at the plant */
  wire: number;
  planter: Combatant | null;
}
export interface RoundEnd {
  winner: 0 | 1;
  reason: EndReason;
  mvp: Combatant | null;
  mvpWhy: string;
  clutch: { c: Combatant; vs: number } | null;
  money: Map<number, number>;
  /** the round that just ended */
  round: number;
}

export interface SabHooks {
  /** a round begins: respawn everyone, hand out kits, clean the world */
  roundStart(attackers: 0 | 1): void;
  /** the buy phase is over: release the freeze */
  goLive(): void;
  roundEnd(e: RoundEnd): void;
  planted(c: Combatant, site: 'A' | 'B', pos: THREE.Vector3): void;
  defused(c: Combatant, gamble: boolean): void;
  /** the charge goes off (blast at pos) */
  exploded(pos: THREE.Vector3, planter: Combatant | null): void;
  /** a wire was cut wrong: the charge goes off at once (then exploded()) */
  badWire(c: Combatant): void;
  /** the charge changed hands / was dropped / picked up */
  chargeMoved(state: Charge['state'], c: Combatant | null): void;
  /** halftime / overtime: sides swap */
  swap(half: 'half' | 'ot'): void;
  matchEnd(winner: 0 | 1 | -1): void;
  /** bounty paid / placed, clutch alert, last alive (announcements) */
  callout(kind: 'bounty' | 'bountyPaid' | 'clutch' | 'lastAlive' | 'matchPoint' | 'lastRoundHalf' | 'tenSec', c: Combatant | null, n?: number): void;
}

export class Sabotage {
  phase: SabPhase = 'warmup';
  timer = 0;
  round = 1;
  score: [number, number] = [0, 0];
  /** which team attacks this round */
  atk: 0 | 1 = 1;
  seats: Seat[] = [];
  lossStreak: [number, number] = [0, 0];
  charge: Charge = { state: 'none', holder: null, pos: new THREE.Vector3(), site: null, wire: 0, planter: null };
  /** plant / defuse in progress (one each at a time) */
  planting: { c: Combatant; t: number } | null = null;
  defusing: { c: Combatant; t: number; kit: boolean; ruled: number } | null = null;
  /** seconds since the round went live (buy grace, bot timing) */
  liveT = 0;
  /** the team that has had its first kill this round */
  private firstKill = false;
  private clutch: [{ c: Combatant; vs: number } | null, { c: Combatant; vs: number } | null] = [null, null];
  private lastAliveCalled: [boolean, boolean] = [false, false];
  /** the last result (for the HUD card) */
  last: RoundEnd | null = null;
  winner: 0 | 1 | -1 = -1;
  /** overtime blocks played */
  ot = 0;
  private tenCalled = false;

  constructor(private hooks: SabHooks) {}

  seat(c: Combatant) {
    return this.seats.find((s) => s.c === c) ?? null;
  }
  side(team: 0 | 1): 'atk' | 'def' {
    return team === this.atk ? 'atk' : 'def';
  }
  alive(team: 0 | 1) {
    return this.seats.filter((s) => s.c.team === team && s.c.alive).length;
  }
  get roundsPlayed() {
    return this.score[0] + this.score[1];
  }
  /** rounds to win right now (7, or the overtime target) */
  get target() {
    return this.ot > 0 ? HALF + 3 * this.ot : WIN_AT;
  }
  get liveOrPlanted() {
    return this.phase === 'live' || this.phase === 'planted';
  }
  /** buying is allowed: the buy phase, or early in the round (the game checks the spawn zone) */
  canBuy() {
    return this.phase === 'buy' || (this.phase === 'live' && this.liveT < BUY_GRACE);
  }

  start(players: Combatant[], firstAttackers: 0 | 1) {
    this.seats = players.map((c) => ({ c, money: START_MONEY, kit: defaultKit(), st: newStats(), last: [] }));
    this.score = [0, 0];
    this.round = 1;
    this.ot = 0;
    this.atk = firstAttackers;
    this.lossStreak = [0, 0];
    this.winner = -1;
    this.last = null;
    this.beginRound();
  }
  /** a player joined mid-match (online): sits out until the next round */
  addSeat(c: Combatant) {
    if (this.seat(c)) return;
    this.seats.push({ c, money: this.ot ? OT_MONEY : START_MONEY, kit: defaultKit(), st: newStats(), last: [] });
  }
  removeSeat(c: Combatant) {
    this.seats = this.seats.filter((s) => s.c !== c);
  }

  beginRound() {
    this.phase = 'buy';
    this.timer = BUY_TIME;
    this.liveT = 0;
    this.planting = this.defusing = null;
    this.firstKill = false;
    this.clutch = [null, null];
    this.lastAliveCalled = [false, false];
    this.tenCalled = false;
    for (const s of this.seats) {
      s.st.rk = 0;
      s.st.rdmg = 0;
    }
    this.charge = { state: 'none', holder: null, pos: new THREE.Vector3(), site: null, wire: Math.floor(Math.random() * 3), planter: null };
    this.hooks.roundStart(this.atk);
    // the charge goes to an attacker (the game may hand it to someone else after the respawn)
    const atk = this.seats.filter((s) => s.c.team === this.atk && s.c.alive);
    if (atk.length) this.giveCharge(atk[Math.floor(Math.random() * atk.length)].c);
    const half = this.ot === 0 && this.roundsPlayed === HALF - 1;
    if (half) this.hooks.callout('lastRoundHalf', null);
    if (this.score[0] === this.target - 1 || this.score[1] === this.target - 1) this.hooks.callout('matchPoint', null);
  }
  giveCharge(c: Combatant) {
    this.charge.state = 'carried';
    this.charge.holder = c;
    this.charge.pos.copy(c.position());
    this.hooks.chargeMoved('carried', c);
  }

  update(dt: number) {
    if (this.phase === 'warmup' || this.phase === 'ended') return;
    this.timer -= dt;
    if (this.phase === 'buy') {
      if (this.timer <= 0) {
        this.phase = 'live';
        this.timer = ROUND_TIME;
        this.hooks.goLive();
      }
      return;
    }
    if (this.phase === 'post') {
      if (this.timer <= 0) this.next();
      return;
    }
    this.liveT += dt;
    // the charge follows its carrier
    const ch = this.charge;
    if (ch.state === 'carried' && ch.holder) {
      if (!ch.holder.alive) this.dropCharge(ch.holder);
      else ch.pos.copy(ch.holder.position());
    }
    // a plant / defuse that lost its soldier stops
    if (this.planting && !this.planting.c.alive) this.planting = null;
    if (this.defusing && !this.defusing.c.alive) this.defusing = null;
    // last alive / clutch tracking
    for (const t of [0, 1] as const) {
      const mine = this.seats.filter((s) => s.c.team === t && s.c.alive);
      if (mine.length === 1 && !this.lastAliveCalled[t]) {
        this.lastAliveCalled[t] = true;
        const vs = this.alive((1 - t) as 0 | 1);
        if (vs >= 2) this.clutch[t] = { c: mine[0].c, vs };
        this.hooks.callout(vs >= 2 ? 'clutch' : 'lastAlive', mine[0].c, vs);
      }
    }
    // win conditions
    const aA = this.alive(this.atk), dA = this.alive((1 - this.atk) as 0 | 1);
    if (this.phase === 'live') {
      if (this.timer <= 10 && !this.tenCalled) {
        this.tenCalled = true;
        this.hooks.callout('tenSec', null);
      }
      if (dA === 0 && aA > 0) return this.endRound(this.atk, 'elim');
      if (aA === 0) return this.endRound((1 - this.atk) as 0 | 1, 'elim');
      if (this.timer <= 0) return this.endRound((1 - this.atk) as 0 | 1, 'time');
    } else if (this.phase === 'planted') {
      if (dA === 0) return this.endRound(this.atk, 'elim');
      if (this.defusing) {
        const need = this.defusing.kit ? DEFUSE_KIT : DEFUSE_TIME;
        if (this.defusing.t >= need) return this.finishDefuse(this.defusing.c, false);
      }
      if (this.timer <= 0) {
        this.charge.state = 'exploded';
        this.hooks.exploded(this.charge.pos.clone(), this.charge.planter);
        return this.endRound(this.atk, 'exploded');
      }
    }
  }

  dropCharge(c: Combatant, at?: THREE.Vector3) {
    if (this.charge.holder !== c) return;
    this.charge.state = 'dropped';
    this.charge.holder = null;
    this.charge.pos.copy(at ?? c.position());
    this.hooks.chargeMoved('dropped', c);
  }
  /** an attacker walks over the dropped charge */
  tryPickup(c: Combatant) {
    if (this.charge.state !== 'dropped' || c.team !== this.atk || !c.alive || !this.liveOrPlanted && this.phase !== 'buy') return false;
    const p = c.position();
    if (Math.hypot(p.x - this.charge.pos.x, p.z - this.charge.pos.z) > 1.4 || Math.abs(p.y - this.charge.pos.y) > 1.8) return false;
    this.giveCharge(c);
    return true;
  }

  /** the plant zone a point is in */
  siteAt(p: THREE.Vector3): 'A' | 'B' | null {
    for (const s of SV_SITES) if (inRect(s.zone, p.x, p.z)) return s.letter;
    return null;
  }

  /**
   * Hold-to-use for one soldier this frame: plant (the carrier inside a zone) or defuse (a
   * defender by the planted charge). `holding` false cancels. Returns what is happening.
   */
  use(c: Combatant, holding: boolean, dt: number, moving: boolean): 'plant' | 'defuse' | null {
    if (!c.alive) return null;
    if (this.phase === 'live' && this.charge.state === 'carried' && this.charge.holder === c) {
      const site = this.siteAt(c.position());
      if (!holding || !site || moving) {
        if (this.planting?.c === c) this.planting = null;
        return null;
      }
      if (!this.planting || this.planting.c !== c) this.planting = { c, t: 0 };
      this.planting.t += dt;
      if (this.planting.t >= PLANT_TIME) this.finishPlant(c, site);
      return 'plant';
    }
    if (this.phase === 'planted' && c.team !== this.atk) {
      const p = c.position();
      const near = Math.hypot(p.x - this.charge.pos.x, p.z - this.charge.pos.z) < 1.7 && Math.abs(p.y - this.charge.pos.y) < 2;
      if (!holding || !near) {
        if (this.defusing?.c === c) this.defusing = null;
        return null;
      }
      if (this.defusing && this.defusing.c !== c) return null; // someone else is on it
      if (!this.defusing) {
        const kit = !!this.seat(c)?.kit.cutters;
        // cutters rule out one wrong wire
        const wrong = [0, 1, 2].filter((w) => w !== this.charge.wire);
        this.defusing = { c, t: 0, kit, ruled: kit ? wrong[Math.floor(Math.random() * 2)] : -1 };
      }
      this.defusing.t += dt;
      return 'defuse';
    }
    return null;
  }
  /** the planter chooses the live wire (the player picks in the wire panel; bots at random) */
  setWire(w: number) {
    this.charge.wire = Math.max(0, Math.min(2, w | 0));
  }
  private finishPlant(c: Combatant, site: 'A' | 'B') {
    this.planting = null;
    this.phase = 'planted';
    this.timer = FUSE;
    this.charge.state = 'planted';
    this.charge.holder = null;
    this.charge.site = site;
    this.charge.planter = c;
    this.charge.pos.copy(c.position());
    const s = this.seat(c);
    if (s) {
      s.money = Math.min(MAX_MONEY, s.money + 300);
      s.st.plants++;
    }
    this.hooks.planted(c, site, this.charge.pos.clone());
  }
  /** the wire gamble: cut wire w (0..2) during a defuse that has the panel open */
  cut(c: Combatant, w: number) {
    const d = this.defusing;
    if (!d || d.c !== c || d.t < WIRE_OPEN || this.phase !== 'planted') return false;
    if (w === this.charge.wire) {
      this.finishDefuse(c, true);
      return true;
    }
    // wrong: it goes off in their hands
    this.defusing = null;
    this.hooks.badWire(c);
    this.charge.state = 'exploded';
    this.hooks.exploded(this.charge.pos.clone(), this.charge.planter);
    this.endRound(this.atk, 'exploded');
    return true;
  }
  private finishDefuse(c: Combatant, gamble: boolean) {
    this.defusing = null;
    this.charge.state = 'defused';
    const s = this.seat(c);
    if (s) {
      s.money = Math.min(MAX_MONEY, s.money + 300);
      s.st.defuses++;
    }
    this.hooks.defused(c, gamble);
    this.endRound((1 - this.atk) as 0 | 1, 'defused');
  }

  // ---------------------------------------------------------------- kills & damage
  onDamage(victim: Combatant, attacker: Combatant | null, amount: number, before: number) {
    if (!attacker || attacker === victim || attacker.team === victim.team) return;
    const s = this.seat(attacker);
    if (!s) return;
    const real = Math.max(0, Math.min(amount, before));
    s.st.dmg += real;
    s.st.rdmg += real;
  }
  onKill(killer: Combatant, victim: Combatant, def: WeaponDef | null, weaponName: string) {
    const vs = this.seat(victim);
    if (vs) vs.st.deaths++;
    if (this.charge.holder === victim) this.dropCharge(victim);
    if (this.planting?.c === victim) this.planting = null;
    if (this.defusing?.c === victim) this.defusing = null;
    if (!this.liveOrPlanted) return;
    if (killer === victim || killer.team === victim.team) return;
    const ks = this.seat(killer);
    if (!ks) return;
    ks.st.kills++;
    ks.st.rk++;
    let pay = killReward(def, weaponName);
    if (!this.firstKill) {
      this.firstKill = true;
      ks.st.openings++;
    }
    // a bounty on the victim is paid to the killer
    const b = vs ? bountyFor(vs.st.hotRounds) : 0;
    if (b > 0) {
      pay += b;
      vs!.st.hotRounds = 0;
      this.hooks.callout('bountyPaid', killer, b);
    }
    ks.money = Math.min(MAX_MONEY, ks.money + pay);
  }
  onAssist(c: Combatant) {
    const s = this.seat(c);
    if (s) s.st.assists++;
  }

  // ---------------------------------------------------------------- round end
  endRound(winner: 0 | 1, reason: EndReason) {
    if (this.phase === 'post' || this.phase === 'ended') return;
    this.planting = this.defusing = null;
    this.phase = 'post';
    this.timer = POST_TIME;
    this.score[winner]++;
    const loser = (1 - winner) as 0 | 1;
    const money = new Map<number, number>();
    const planted = this.charge.state === 'planted' || this.charge.state === 'exploded' || this.charge.state === 'defused';
    const winPay = reason === 'exploded' || reason === 'defused' ? 3500 : 3250;
    const lossPay = 1400 + 500 * Math.min(this.lossStreak[loser], 4);
    for (const s of this.seats) {
      let pay = 0;
      if (s.c.team === winner) pay = winPay;
      else {
        pay = lossPay;
        // attackers who planted and still lost get a little extra
        if (s.c.team === this.atk && planted) pay += 800;
        // attackers alive when the time runs out (no plant) get nothing: they should have gone in
        if (reason === 'time' && s.c.team === this.atk && s.c.alive) pay = 0;
      }
      s.money = Math.min(MAX_MONEY, s.money + pay);
      money.set(s.c.id, pay);
    }
    this.lossStreak[winner] = Math.max(0, this.lossStreak[winner] - 1);
    this.lossStreak[loser] = Math.min(4, this.lossStreak[loser] + 1);
    // the clutch bonus
    let clutch: RoundEnd['clutch'] = null;
    const cl = this.clutch[winner];
    if (cl && cl.c.alive) {
      clutch = cl;
      const s = this.seat(cl.c);
      if (s) {
        const bonus = 500 * cl.vs;
        s.money = Math.min(MAX_MONEY, s.money + bonus);
        s.st.clutches++;
        money.set(cl.c.id, (money.get(cl.c.id) ?? 0) + bonus);
      }
    }
    // bounties: a kill this round keeps the run going; three rounds running puts a price on you
    for (const s of this.seats) {
      if (s.st.rk > 0) {
        s.st.hotRounds++;
        if (s.st.hotRounds === BOUNTY_FROM) this.hooks.callout('bounty', s.c, bountyFor(s.st.hotRounds));
      } else s.st.hotRounds = 0;
    }
    // MVP: the defuser / the planter of a charge that went off; else the winner with most kills (then damage)
    let mvp: Combatant | null = null;
    let why = '';
    if (reason === 'defused') {
      mvp = this.seats.find((s) => s.c.team === winner && s.st.defuses > 0 && s.c.alive)?.c ?? null;
      why = 'DEFUSED THE CHARGE';
    }
    if (reason === 'exploded' && this.charge.planter) {
      mvp = this.charge.planter;
      why = 'PLANTED THE CHARGE';
    }
    if (clutch) {
      mvp = clutch.c;
      why = `CLUTCH 1v${clutch.vs}`;
    }
    if (!mvp) {
      const best = this.seats.filter((s) => s.c.team === winner).sort((a, b) => b.st.rk - a.st.rk || b.st.rdmg - a.st.rdmg)[0];
      if (best && (best.st.rk > 0 || best.st.rdmg > 0)) {
        mvp = best.c;
        why = best.st.rk > 1 ? `${best.st.rk} ELIMINATIONS` : 'MOST DAMAGE';
      }
    }
    if (mvp) {
      const s = this.seat(mvp);
      if (s) s.st.mvps++;
    }
    // what the survivors keep / the dead lose
    for (const s of this.seats) if (!s.c.alive) s.kit = defaultKit();
    this.last = { winner, reason, mvp, mvpWhy: why, clutch, money, round: this.round };
    this.hooks.roundEnd(this.last);
    if (this.score[winner] >= this.target) {
      // match point reached; in overtime the other side may still level the block
      this.phase = 'post';
      this.winner = winner;
    }
  }

  private next() {
    if (this.winner !== -1) {
      this.phase = 'ended';
      this.hooks.matchEnd(this.winner);
      return;
    }
    this.round++;
    const played = this.roundsPlayed;
    // halftime: swap sides, reset the economy
    if (this.ot === 0 && played === HALF) {
      this.swapSides('half', START_MONEY);
    } else if (this.ot === 0 && played === HALF * 2) {
      // 6–6: overtime
      this.ot = 1;
      this.swapSides('ot', OT_MONEY);
    } else if (this.ot > 0) {
      const into = played - HALF * 2 - (this.ot - 1) * 4;
      if (into === 2) this.swapSides('ot', -1);
      else if (into === 4) {
        // a drawn block: another one
        this.ot++;
        this.swapSides('ot', OT_MONEY);
      }
    }
    this.beginRound();
  }
  private swapSides(kind: 'half' | 'ot', money: number) {
    this.atk = (1 - this.atk) as 0 | 1;
    this.lossStreak = [0, 0];
    if (money >= 0)
      for (const s of this.seats) {
        s.money = money;
        s.kit = defaultKit();
      }
    else for (const s of this.seats) s.kit = defaultKit();
    this.hooks.swap(kind);
  }

  // ---------------------------------------------------------------- shop
  /** price of an item for this seat (0 = can't buy) */
  canAfford(s: Seat, it: ShopItem) {
    return s.money >= it.price;
  }
  /** why an item can't be bought right now ('' = it can) */
  blocked(s: Seat, it: ShopItem): string {
    const side = this.side(s.c.team);
    if (it.side && it.side !== side) return side === 'atk' ? 'DEFENDERS ONLY' : 'ATTACKERS ONLY';
    if (it.weapon) {
      const w = WEAPONS[it.weapon];
      if (w.slot === 'primary' ? s.kit.primary === it.weapon : s.kit.secondary === it.weapon) return 'OWNED';
    }
    if (it.id === 'vest' && s.kit.armor >= 100) return 'OWNED';
    if (it.id === 'vesthelm' && s.kit.armor >= 100 && s.kit.helmet) return 'OWNED';
    if (it.id === 'cutters' && s.kit.cutters) return 'OWNED';
    if (it.nade) {
      if (s.kit.nades[it.nade] >= NADE_MAX[it.nade]) return 'FULL';
      if (nadeCount(s.kit) >= NADE_TOTAL) return 'FULL';
    }
    const price = this.price(s, it);
    if (s.money < price) return 'NO MONEY';
    return '';
  }
  price(s: Seat, it: ShopItem) {
    // a helmet on armour you already wear costs only the difference
    if (it.id === 'vesthelm' && s.kit.armor >= 100) return 350;
    return it.price;
  }
  buy(c: Combatant, id: string): string {
    const s = this.seat(c);
    const it = SHOP.find((x) => x.id === id);
    if (!s || !it) return 'NO';
    const why = this.blocked(s, it);
    if (why) return why;
    s.money -= this.price(s, it);
    if (it.weapon) {
      if (WEAPONS[it.weapon].slot === 'primary') s.kit.primary = it.weapon;
      else s.kit.secondary = it.weapon;
    } else if (it.id === 'vest') s.kit.armor = 100;
    else if (it.id === 'vesthelm') {
      s.kit.armor = 100;
      s.kit.helmet = true;
    } else if (it.id === 'cutters') s.kit.cutters = true;
    else if (it.nade) s.kit.nades[it.nade]++;
    s.last.push(id);
    return '';
  }
  /** sell back an item bought this buy window (full refund) — keeps misclicks cheap */
  refund(c: Combatant, id: string) {
    const s = this.seat(c);
    const it = SHOP.find((x) => x.id === id);
    if (!s || !it || !this.canBuy()) return false;
    const i = s.last.lastIndexOf(id);
    if (i < 0) return false;
    s.last.splice(i, 1);
    s.money += it.price;
    if (it.weapon) {
      if (WEAPONS[it.weapon].slot === 'primary') s.kit.primary = null;
      else s.kit.secondary = 'p80';
    } else if (it.id === 'vest' || it.id === 'vesthelm') {
      s.kit.armor = 0;
      s.kit.helmet = false;
    } else if (it.id === 'cutters') s.kit.cutters = false;
    else if (it.nade) s.kit.nades[it.nade] = Math.max(0, s.kit.nades[it.nade] - 1);
    return true;
  }
}

export function inRect(r: Rect, x: number, z: number) {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}
