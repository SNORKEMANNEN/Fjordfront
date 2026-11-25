import * as THREE from 'three';
import { Bot } from './Bot';
import { Combatant } from '../game/Combatant';

/**
 * Adaptive commander (Update 47): one per side, above the BotDirector's missions. Every ~18 s it
 * reads the battle and picks a posture, which reshapes how the director hands out missions:
 *
 *  balanced  the director's normal mix
 *  assault   behind on flags or points: everyone who can commits to ONE enemy flag (the one with
 *            the fewest defenders), approaching from more than one side
 *  hold      ahead: dig in on owned flags, defend the most threatened one
 *  counter   the other side is pushing one of our flags with three or more: converge on it
 *  flank     a killzone (four or more of ours died around one spot in 45 s): stop feeding it,
 *            go round — paths avoid the spot and approaches swing wide
 *
 * It also adapts to the player: someone on a streak of four or more on the other side gets a
 * two-soldier hunter team sent to where they were last seen. Your own side's commander tells you
 * what it is doing on the radio (and the enemy's big moves leak as intel).
 */

type G = any;
export type Posture = 'balanced' | 'assault' | 'hold' | 'counter' | 'flank';

export interface Command { posture: Posture; focus: THREE.Vector3 | null; letter: string; avoid: THREE.Vector3[] }

export class Commander {
  cmd: Command = { posture: 'balanced', focus: null, letter: '', avoid: [] };
  private t = 6 + Math.random() * 4;
  private deaths: { p: THREE.Vector3; t: number }[] = [];
  private hunted: Combatant | null = null;
  private huntT = 0;

  constructor(private g: G, public team: 0 | 1) {}

  /** one of ours died here */
  noteDeath(p: THREE.Vector3) {
    this.deaths.push({ p: p.clone(), t: this.g.time });
    if (this.deaths.length > 60) this.deaths.shift();
  }

  update(dt: number) {
    const g = this.g;
    this.t -= dt;
    this.huntT -= dt;
    if (this.t > 0) return;
    this.t = 16 + Math.random() * 6;
    const now = g.time as number;
    this.deaths = this.deaths.filter((d) => now - d.t < 45);
    const flags = (g.dom?.flags ?? []) as { pos: THREE.Vector3; owner: number; letter: string; radius: number }[];
    const foes = (g.match.players as Combatant[]).filter((p) => p.alive && p.team !== this.team);
    const mine = flags.filter((f) => f.owner === this.team).length;
    const theirs = flags.filter((f) => f.owner === 1 - this.team).length;
    const sc = g.match.scores as [number, number];
    const behind = theirs - mine + (sc[1 - this.team] - sc[this.team]) / 60;
    const near = (p: THREE.Vector3, list: Combatant[], r: number) => list.filter((c) => c.position().distanceTo(p) < r).length;
    const prev = this.cmd.posture + this.cmd.letter;
    // a killzone: deaths clustered round one spot
    let kz: THREE.Vector3 | null = null;
    for (const d of this.deaths) {
      const n = this.deaths.filter((e) => e.p.distanceTo(d.p) < 14).length;
      if (n >= 4) {
        kz = d.p;
        break;
      }
    }
    const pushed = flags.filter((f) => f.owner === this.team).map((f) => ({ f, n: near(f.pos, foes, f.radius + 18) })).sort((a, b) => b.n - a.n)[0];
    const avoid = kz ? [kz.clone()] : [];
    if (pushed && pushed.n >= 3) this.cmd = { posture: 'counter', focus: pushed.f.pos.clone(), letter: pushed.f.letter, avoid };
    else if (kz) this.cmd = { posture: 'flank', focus: this.cmd.focus, letter: this.cmd.letter, avoid };
    else if (behind > 0.4) {
      const target = flags.filter((f) => f.owner !== this.team).map((f) => ({ f, n: near(f.pos, foes, f.radius + 20) })).sort((a, b) => a.n - b.n)[0];
      this.cmd = target ? { posture: 'assault', focus: target.f.pos.clone(), letter: target.f.letter, avoid } : { posture: 'balanced', focus: null, letter: '', avoid };
    } else if (mine >= 2) {
      const threatened = flags.filter((f) => f.owner === this.team).map((f) => ({ f, n: near(f.pos, foes, f.radius + 30) })).sort((a, b) => b.n - a.n)[0];
      this.cmd = { posture: 'hold', focus: threatened?.f.pos.clone() ?? null, letter: threatened?.f.letter ?? '', avoid };
    } else this.cmd = { posture: 'balanced', focus: null, letter: '', avoid };
    if (prev !== this.cmd.posture + this.cmd.letter) this.announce();
    // retask a third of the side when the posture changes (the rest pick it up as they finish)
    if (prev !== this.cmd.posture + this.cmd.letter) {
      const mates = (g.bots as Bot[]).filter((b) => b.team === this.team && b.alive && !b.downed && !b.netPuppet && !b.order);
      for (const b of mates) if (Math.random() < 0.35) g.director.forget(b.id);
    }
    this.hunt(foes);
  }

  /** someone on a streak: two soldiers go looking for them */
  private hunt(foes: Combatant[]) {
    const g = this.g;
    if (this.huntT > 0) return;
    const ace = foes.find((c) => c === g.avatar && (g.killStreak ?? 0) >= 4) ?? null;
    if (!ace) return;
    this.huntT = 40;
    this.hunted = ace;
    const pos = ace.position().clone();
    const hunters = (g.bots as Bot[])
      .filter((b) => b.team === this.team && b.alive && !b.downed && !b.order && !b.netPuppet)
      .sort((a, b) => a.position().distanceTo(pos) - b.position().distanceTo(pos))
      .slice(0, 2);
    for (const b of hunters) b.order = { kind: 'attack', pos: g.nav.nearest(pos, 10, false)?.p.clone() ?? pos, until: g.time + 35 };
    if (hunters.length && this.team !== g.avatar.team) g.ui.notify('INTEL', 'A HUNTER TEAM IS COMING FOR YOU');
  }

  private announce() {
    const g = this.g;
    const c = this.cmd;
    const ours = this.team === g.avatar.team;
    const what: Record<Posture, string> = {
      balanced: 'HOLD THE LINE, TAKE WHAT YOU CAN',
      assault: `EVERYONE ON ${c.letter}`,
      hold: `DIG IN${c.letter ? ` · DEFEND ${c.letter}` : ''}`,
      counter: `COUNTER-ATTACK ${c.letter}`,
      flank: 'THEY HAVE A KILLZONE · GO ROUND',
    };
    if (ours) {
      g.ui.notify('HQ · ORDERS', what[c.posture]);
      g.audio.play('radio', { gain: 0.25, bus: 'ui', reverb: 0, rate: 1.1 });
    } else if (c.posture === 'assault' || c.posture === 'counter') {
      g.ui.notify('INTEL', `ENEMY MASSING ON ${c.letter}`);
    }
  }

  reset() {
    this.cmd = { posture: 'balanced', focus: null, letter: '', avoid: [] };
    this.deaths = [];
    this.t = 8;
    this.huntT = 0;
    this.hunted = null;
  }
}
