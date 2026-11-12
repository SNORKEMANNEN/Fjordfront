import * as THREE from 'three';
import { Combatant, CombatantState } from './Combatant';
import { SPAWNS, SpawnPoint } from '../world/MapLayout';
import { Physics } from '../core/Physics';
import { Terrain } from '../world/Terrain';
import { SpawnSystem } from './SpawnSystem';

export interface KillEvent {
  killer: string;
  killerTeam: 0 | 1;
  victim: string;
  victimTeam: 0 | 1;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  t: number;
}

export type MatchPhase = 'warmup' | 'live' | 'ended';

/** Domination rules (flag logic in Domination.ts). Pure game state — rendering/UI read from it. */
export class Match {
  readonly mode = 'dom';
  scoreLimit = 200;
  duration = 10 * 60;
  timeLeft = this.duration;
  scores: [number, number] = [0, 0];
  phase: MatchPhase = 'live';
  feed: KillEvent[] = [];
  winner: 0 | 1 | -1 = -1;
  teamNames: [string, string] = ['KYSTJEGERNE', 'NORDFRONT'];
  onEnd: (winner: 0 | 1 | -1) => void = () => {};
  /** dynamic spawn logic (set once the nav graph exists) */
  spawns: SpawnSystem | null = null;
  /** true while handing out the opening spawns of a match */
  initialSpawns = false;

  constructor(public players: Combatant[], private physics: Physics, private terrain: Terrain) {}

  reset() {
    this.scores = [0, 0];
    this.timeLeft = this.duration;
    this.phase = 'live';
    this.feed = [];
    this.winner = -1;
    this.spawns?.reset();
    for (const p of this.players) {
      p.kills = p.deaths = p.score = p.assists = 0;
      (p as { captures?: number }).captures = 0;
    }
  }

  update(dt: number) {
    if (this.phase !== 'live') return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.end(this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1);
    }
  }

  registerKill(killer: Combatant, victim: Combatant, weapon: string, headshot: boolean, wallbang: boolean, t: number) {
    victim.deaths++;
    if (killer !== victim && killer.team !== victim.team) {
      killer.kills++;
      killer.score += 100 + (headshot ? 50 : 0) + (wallbang ? 25 : 0);
    }
    this.feed.unshift({ killer: killer.name, killerTeam: killer.team, victim: victim.name, victimTeam: victim.team, weapon, headshot, wallbang, t });
    if (this.feed.length > 6) this.feed.pop();
  }

  /** Flag points (Domination ticks). */
  addPoints(pts: [number, number]) {
    if (this.phase !== 'live' || (!pts[0] && !pts[1])) return;
    this.scores[0] = Math.min(this.scoreLimit, this.scores[0] + pts[0]);
    this.scores[1] = Math.min(this.scoreLimit, this.scores[1] + pts[1]);
    if (this.scores[0] >= this.scoreLimit || this.scores[1] >= this.scoreLimit) this.end(this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1);
  }

  private end(w: 0 | 1 | -1) {
    this.phase = 'ended';
    this.winner = w;
    this.onEnd(w);
  }

  /** Choose a spawn that keeps distance from living enemies and is out of their sight. */
  pickSpawn(team: 0 | 1): { pos: THREE.Vector3; yaw: number } {
    if (this.spawns) return this.spawns.pick(team, this.players, this.initialSpawns);
    const enemies = this.players.filter((p) => p.alive && p.team !== team);
    const friends = this.players.filter((p) => p.alive && p.team === team);
    let best: SpawnPoint = SPAWNS[0];
    let bs = -Infinity;
    for (const s of SPAWNS) {
      if (s.team !== -1 && s.team !== team) continue;
      const p = new THREE.Vector3(s.x, this.terrain.heightAt(s.x, s.z) + 1.6, s.z);
      let minE = 400;
      let seen = 0;
      for (const e of enemies) {
        const d = e.position().distanceTo(p);
        minE = Math.min(minE, d);
        if (d < 90 && this.physics.lineOfSight(p, e.eye(new THREE.Vector3()))) seen++;
      }
      let nearF = 0;
      for (const f of friends) if (f.position().distanceTo(p) < 40) nearF++;
      const score = Math.min(minE, 120) - seen * 60 + nearF * 6 + (s.team === team ? 25 : 0) + Math.random() * 15;
      if (score > bs) {
        bs = score;
        best = s;
      }
    }
    const jx = (Math.random() - 0.5) * 4, jz = (Math.random() - 0.5) * 4;
    return { pos: new THREE.Vector3(best.x + jx, this.terrain.heightAt(best.x + jx, best.z + jz) + 0.3, best.z + jz), yaw: best.yaw };
  }

  snapshot(): CombatantState[] {
    return this.players.map((p) => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score, alive: p.alive, isPlayer: p.isPlayer }));
  }
}
