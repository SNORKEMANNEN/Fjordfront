import * as THREE from 'three';
import { NavGraph, NavNode } from './NavGraph';
import { LANDMARKS } from '../world/MapLayout';
import { Combatant } from '../game/Combatant';

/**
 * Team-level brain that hands bots *missions* instead of single points, so a squad spreads over
 * the map, takes different lanes and actually goes indoors:
 *
 *  - clear   enter a building and sweep its rooms (indoor nav points, nearest-neighbour tour)
 *  - flank   reach the fight through a side detour 30–60 m off the direct line
 *  - push    move on a recent firefight that fewer than two teammates are already covering
 *  - patrol  hold / roam the landmark area the team currently covers least
 *  - capture (Domination) go to a flag the team does not hold and stand in its zone until it flips;
 *            the approach sometimes swings wide like a flank
 *  - defend  (Domination) hold a flag the team owns, especially one under threat
 *
 * Missions are scored against teammates' claims (their current mission targets) so two bots
 * rarely pick the same building or the same street. Each mission is an itinerary of waypoints;
 * the bot asks for the next one whenever it reaches its goal.
 */
type Kind = 'clear' | 'flank' | 'push' | 'patrol' | 'capture' | 'defend';
export interface FlagInfo { pos: THREE.Vector3; owner: -1 | 0 | 1; radius: number; letter: string; contested: boolean; enemiesNear: number }
interface Mission { kind: Kind; wps: THREE.Vector3[]; target: THREE.Vector3; seed: number; team: number; laps?: number }

interface Ctx { mates: { id: number; pos: THREE.Vector3 }[]; enemies: Combatant[]; hotspots: THREE.Vector3[]; aggro: number; flags?: FlagInfo[] }

interface Room { centre: THREE.Vector3; nodes: NavNode[] }

export class BotDirector {
  private missions = new Map<number, Mission>();
  private rooms: Room[] = [];
  private counter = 0;

  constructor(private nav: NavGraph, private rng: () => number) {
    // group indoor nodes (doorway links, interior points) into buildings / rooms
    const indoor = nav.nodes.filter((n) => n.indoor && n.links.length);
    const used = new Set<number>();
    for (const n of indoor) {
      if (used.has(n.id)) continue;
      const group = indoor.filter((m) => !used.has(m.id) && m.p.distanceTo(n.p) < 14 && Math.abs(m.p.y - n.p.y) < 6);
      group.forEach((m) => used.add(m.id));
      const c = new THREE.Vector3();
      for (const m of group) c.add(m.p);
      c.multiplyScalar(1 / group.length);
      this.rooms.push({ centre: c, nodes: group });
    }
  }

  get roomCount() {
    return this.rooms.length;
  }

  /** Current mission kind for debugging / tests. */
  kindOf(botId: number) {
    return this.missions.get(botId)?.kind ?? null;
  }

  /** Path options so each bot (and each of its missions) gets its own stable lane. */
  pathOpts(botId: number, team: number, all: { id: number; team: number; goal: THREE.Vector3 }[]) {
    const m = this.missions.get(botId);
    const avoid = all.filter((o) => o.team === team && o.id !== botId).map((o) => o.goal);
    return { noise: 0.9, seed: botId * 31 + (m?.seed ?? 0), avoid };
  }

  forget(botId: number) {
    this.missions.delete(botId);
  }

  /** Next waypoint for this bot (plans a new mission when the current one is done). */
  next(bot: { id: number; team: 0 | 1; pos: THREE.Vector3 }, ctx: Ctx) {
    let m = this.missions.get(bot.id);
    // capture missions hold the zone until the flag is ours (a few extra laps inside it)
    if (m && !m.wps.length && m.kind === 'capture' && ctx.flags) {
      const f = ctx.flags.find((x) => flat(x.pos, m!.target) < 1);
      m.laps = (m.laps ?? 0) + 1;
      if (f && f.owner !== bot.team && m.laps < 8) {
        const snap = (p: THREE.Vector3) => this.nav.nearest(p, 40)?.p.clone() ?? p.clone();
        for (let i = 0; i < 2; i++) {
          const a = this.rng() * Math.PI * 2, rr = f.radius * (0.2 + this.rng() * 0.45);
          const p = snap(f.pos.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr)));
          m.wps.push(flat(p, f.pos) < f.radius - 0.8 ? p : f.pos.clone());
        }
      }
    }
    if (!m || !m.wps.length) {
      m = this.plan(bot, ctx);
      this.missions.set(bot.id, m);
    }
    return m.wps.shift()!.clone();
  }

  /** Mission targets currently claimed by teammates. */
  private claims(team: number, except: number) {
    const out: THREE.Vector3[] = [];
    for (const [id, m] of this.missions) if (id !== except && m.team === team) out.push(m.target);
    return out;
  }

  private plan(bot: { id: number; team: 0 | 1; pos: THREE.Vector3 }, ctx: Ctx): Mission {
    const claims = this.claims(bot.team, bot.id);
    const crowd = (p: THREE.Vector3) => {
      let c = 0;
      for (const q of claims) if (flat(p, q) < 28) c++;
      for (const mt of ctx.mates) if (mt.id !== bot.id && flat(p, mt.pos) < 18) c += 0.5;
      return c;
    };
    const seed = ++this.counter;
    const snap = (p: THREE.Vector3) => this.nav.nearest(p, 40)?.p.clone() ?? p.clone();
    const r = this.rng();
    // --- Domination objectives come first most of the time
    // a team that is behind on flags commits far more of its squad to the objectives (keeps
    // 12v12 matches from locking into one 2-1 split for the whole game)
    const fl = ctx.flags ?? [];
    const behind = fl.filter((f) => f.owner === 1 - bot.team).length - fl.filter((f) => f.owner === bot.team).length;
    if (fl.length && this.rng() < (behind > 0 ? 0.9 : behind < 0 ? 0.66 : 0.75)) {
      const m = this.flagMission(bot, ctx, claims, seed, snap);
      if (m) return m;
    }
    // --- push: a firefight that few teammates are already on
    if (ctx.hotspots.length && r < 0.32 * ctx.aggro + 0.1) {
      const h = [...ctx.hotspots].sort((a, b) => crowd(a) + flat(a, bot.pos) / 120 - (crowd(b) + flat(b, bot.pos) / 120))[0];
      if (crowd(h) < 2) {
        const t = snap(h.clone().add(new THREE.Vector3((this.rng() - 0.5) * 24, 0, (this.rng() - 0.5) * 24)));
        return { kind: 'push', wps: [t], target: t, seed, team: bot.team };
      }
    }
    // --- clear: sweep a building the team isn't already in
    if (this.rooms.length && r < 0.75) {
      const ranked = this.rooms
        .map((room) => ({ room, s: crowd(room.centre) * 3 + flat(room.centre, bot.pos) / 90 + this.rng() * 0.8 - (ctx.hotspots.some((h) => flat(h, room.centre) < 60) ? 0.6 : 0) }))
        .sort((a, b) => a.s - b.s);
      const room = ranked[0].room;
      const tour = this.tour(room.nodes, bot.pos);
      return { kind: 'clear', wps: tour.map((n) => n.p.clone()), target: room.centre.clone(), seed, team: bot.team };
    }
    // --- flank: go round the side toward where the enemy is
    const foe = ctx.enemies.length ? centroid(ctx.enemies.map((e) => e.position())) : ctx.hotspots[0];
    if (foe && r < 0.9) {
      const dir = new THREE.Vector3(foe.x - bot.pos.x, 0, foe.z - bot.pos.z);
      const len = dir.length();
      if (len > 40) {
        dir.multiplyScalar(1 / len);
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((this.rng() < 0.5 ? -1 : 1) * (30 + this.rng() * 30));
        const mid = bot.pos.clone().addScaledVector(dir, len * (0.45 + this.rng() * 0.2)).add(side);
        const t = snap(foe.clone().add(new THREE.Vector3((this.rng() - 0.5) * 30, 0, (this.rng() - 0.5) * 30)));
        return { kind: 'flank', wps: [snap(mid), t], target: t, seed, team: bot.team };
      }
    }
    // --- patrol: the landmark area the team covers least
    const lm = [...LANDMARKS].sort((a, b) => crowd(new THREE.Vector3(a.x, 0, a.z)) + this.rng() * 0.9 - (crowd(new THREE.Vector3(b.x, 0, b.z)) + this.rng() * 0.9))[0];
    const t = snap(new THREE.Vector3(lm.x + (this.rng() - 0.5) * lm.r, 0, lm.z + (this.rng() - 0.5) * lm.r));
    return { kind: 'patrol', wps: [t], target: t, seed, team: bot.team };
  }

  private flagMission(bot: { id: number; team: 0 | 1; pos: THREE.Vector3 }, ctx: Ctx, claims: THREE.Vector3[], seed: number, snap: (p: THREE.Vector3) => THREE.Vector3): Mission | null {
    const flags = ctx.flags!;
    const behindN = flags.filter((f) => f.owner === 1 - bot.team).length - flags.filter((f) => f.owner === bot.team).length;
    const claimN = (f: FlagInfo) => claims.filter((c) => flat(c, f.pos) < f.radius + 3).length;
    const ranked = flags
      .map((f) => {
        const mine = f.owner === bot.team;
        // capture targets: closer + fewer teammates already heading there; B is a little more valuable
        let s = flat(f.pos, bot.pos) / 110 + claimN(f) * (mine ? 0.9 : 0.45) + this.rng() * 0.5;
        if (mine) s += f.enemiesNear > 0 || f.contested ? 0.2 : 1.6; // defend only when threatened (mostly)
        if (mine && behindN > 0) s += 0.6; // behind: attack rather than sit on what we have
        if (f.letter === 'B') s -= 0.25;
        if (f.owner === -1) s -= 0.35; // nobody holds it: free points for whoever turns up
        if (!mine && f.owner !== -1) s -= 0.15; // taking theirs swings the score twice
        return { f, s, mine };
      })
      .sort((a, b) => a.s - b.s);
    const pick = ranked[0];
    if (!pick) return null;
    const f = pick.f;
    // up to five on one capture (12-a-side squads), more when that is the only flag left to take
    const cap = flags.filter((x) => x.owner !== bot.team).length === 1 ? 7 : 5;
    if (!pick.mine && claimN(f) >= cap) return null;
    // stand points inside the zone, spread around the centre
    const inside: THREE.Vector3[] = [];
    const n = pick.mine ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2, rr = f.radius * (0.25 + this.rng() * 0.45);
      const p = snap(f.pos.clone().add(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr)));
      inside.push(flat(p, f.pos) < f.radius - 0.8 ? p : f.pos.clone());
    }
    const wps: THREE.Vector3[] = [];
    // long approaches sometimes swing round the side
    const len = flat(f.pos, bot.pos);
    if (!pick.mine && len > 70 && this.rng() < 0.4) {
      const dir = new THREE.Vector3(f.pos.x - bot.pos.x, 0, f.pos.z - bot.pos.z).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((this.rng() < 0.5 ? -1 : 1) * (20 + this.rng() * 20));
      wps.push(snap(bot.pos.clone().addScaledVector(dir, len * 0.55).add(side)));
    }
    wps.push(...inside);
    return { kind: pick.mine ? 'defend' : 'capture', wps, target: f.pos.clone(), seed, team: bot.team };
  }

  /** Nearest-neighbour tour through a building's indoor nodes, starting nearest to the bot. */
  private tour(nodes: NavNode[], from: THREE.Vector3) {
    const left = [...nodes];
    const out: NavNode[] = [];
    let cur = from;
    while (left.length && out.length < 8) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) {
        const d = left[i].p.distanceTo(cur);
        if (d < bd) { bd = d; bi = i; }
      }
      const n = left.splice(bi, 1)[0];
      out.push(n);
      cur = n.p;
    }
    return out;
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function centroid(ps: THREE.Vector3[]) {
  const c = new THREE.Vector3();
  for (const p of ps) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, ps.length));
}
