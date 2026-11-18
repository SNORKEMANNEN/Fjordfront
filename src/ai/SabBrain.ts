import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { SabMode } from '../game/SabMode';
import type { Combatant } from '../game/Combatant';
import { Bot } from './Bot';
import { SHOP, Seat, PLANT_TIME, DEFUSE_TIME, DEFUSE_KIT, WIRE_OPEN, NADE_MAX, nadeCount, NADE_TOTAL } from '../game/Sabotage';
import { SV_SITES } from '../world/maps/Solvik';
import { LV } from '../world/maps/Solvik';
import { WEAPONS } from '../weapons/WeaponDefs';
import type { WeaponId } from '../weapons/WeaponModels';

/**
 * Sabotasje bots (Update 42): a team brain on top of the soldiers' own combat AI.
 *
 *  Economy — each round the team decides: full buy (rifles, armour, grenades, cutters for two
 *  defenders, one sniper when rich), force buy (SMGs / budget rifles, a vest) or eco (save, pistols
 *  only), from the team's average money and the round (pistol rounds buy armour or a pistol).
 *
 *  Attackers — pick a site and a plan: a rush (all in, fast), a default (spread over the three
 *  lanes, stage at the last corner, then collapse on the site together), a split (two lanes into
 *  the same site, timed) or a fake (two show themselves at the other site, the rest execute).
 *  The carrier goes with the main group and plants behind cover once the site is quiet; then the
 *  team takes post-plant spots watching the charge. A dropped charge is picked back up.
 *
 *  Defenders — spread 2 A / 1 mid / 2 B / 1 flex over watch spots that look at the entrances,
 *  rotate when a site is hit (the flex and one from the far site), retake a planted site
 *  together, and one defuses while the others cover (cutting a wire when there is no time left).
 *
 * Bots are steered through their order intent (move here / hold this angle); their own AI still
 * fights whenever an enemy shows up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;
export type { Game };
type P = [number, number];
const R = (pts: P[]) => pts;

/** lanes from the attackers' spawn: [name, site, waypoints (the last 2 are: staging, entry)] */
const ROUTES: { name: string; site: 'A' | 'B'; pts: P[] }[] = [
  { name: 'aMain', site: 'A', pts: R([[-20, 56], [-57, 44], [-57, 22], [-57, 2], [-57, -9], [-56, -24]]) },
  { name: 'aPalace', site: 'A', pts: R([[-24, 52], [-57, 40], [-57, 8], [-47, 4], [-35, 2], [-35, -9], [-35, -24]]) },
  { name: 'aConn', site: 'A', pts: R([[0, 44], [0, 22], [0, 2], [-3, -13], [-16, -13.5], [-23.5, -16], [-24, -26]]) },
  { name: 'bLane', site: 'B', pts: R([[24, 56], [57, 44], [57, 26], [57, 12], [57, 4], [56, -12]]) },
  { name: 'bLoft', site: 'B', pts: R([[30, 50], [38, 38], [38, 27], [47, 21.5], [47, 9], [47, 0], [41, -6]]) },
  { name: 'bUnder', site: 'B', pts: R([[6, 46], [20, 41], [20, 32], [20, 16], [20, 4], [20, -9], [28, -18]]) },
  { name: 'bShort', site: 'B', pts: R([[0, 44], [0, 20], [0, -6], [4, -17], [12, -18], [24, -18]]) },
  { name: 'bDeck', site: 'B', pts: R([[50, 58], [68.5, 54], [68.5, 34], [68.5, 16], [68.5, 0], [68.5, -6], [68.5, -20]]) },
];
/** plant spots (behind the site cover) and post-plant watch spots [pos, look] */
const PLANT: Record<'A' | 'B', P[]> = {
  A: [[-45, -40.8], [-57.2, -34], [-40.4, -35.6]],
  B: [[49.4, -35], [57.6, -30.4], [40.5, -41.2]],
};
const POST: Record<'A' | 'B', [P, P][]> = {
  A: [[[-46, -63.4], [-46, -40]], [[-59, -47], [-46, -41]], [[-27.5, -27], [-44, -40]], [[-64, -24], [-48, -40]], [[-30, -48], [-46, -41]]],
  B: [[[46, -6.2], [47, -33]], [[62.5, -46.5], [48, -34]], [[36.5, -12], [47, -34]], [[66, -38], [48, -34]], [[34, -54], [47, -34]]],
};
/** defender watch spots: [pos, look, group] — 'A' / 'B' sites, 'mid', 'flex' */
const WATCH: { p: P; look: P; g: 'A' | 'B' | 'mid' | 'flex'; w: number; high?: number }[] = [
  { p: [-48, -45], look: [-57, -20], g: 'A', w: 1 },
  { p: [-46, -63.3], look: [-56, -22], g: 'A', w: 1, high: LV.A + 1.8 },
  { p: [-30, -28], look: [-35, -18], g: 'A', w: 0.8 },
  { p: [-62, -31], look: [-57, -18], g: 'A', w: 0.7 },
  { p: [0, -59.8], look: [0, 10], g: 'mid', w: 1, high: LV.CT + 3.6 },
  { p: [-4, -45], look: [0, 10], g: 'mid', w: 0.7 },
  { p: [-19, -13.5], look: [0, -10], g: 'flex', w: 0.6 },
  { p: [46, -37], look: [56, -6], g: 'B', w: 1 },
  { p: [64, -38], look: [68.5, -12], g: 'B', w: 0.9 },
  { p: [36, -14], look: [41, -6], g: 'B', w: 0.8 },
  { p: [30, -26], look: [20, -10], g: 'B', w: 0.8 },
  { p: [39, -46], look: [56, -10], g: 'B', w: 0.7 },
  { p: [22, -54], look: [8, -46], g: 'flex', w: 0.7 },
  { p: [10, -50], look: [0, -30], g: 'flex', w: 0.6 },
];
/** retake staging (where defenders gather before pushing a planted site) */
const RETAKE: Record<'A' | 'B', P[]> = {
  A: [[-24, -53], [-23.5, -18], [-35, -14]],
  B: [[24, -56], [20, -16], [56, -2]],
};

interface AtkState { route: P[]; i: number; stage: number; role: 'main' | 'fake' | 'lurk'; held: boolean }
type Plan = 'rush' | 'default' | 'split' | 'fake';

export class SabBrain {
  private atk = new Map<number, AtkState>();
  private def = new Map<number, { p: P; look: P; g: string; high?: number }>();
  private plan: Plan = 'default';
  private site: 'A' | 'B' = 'A';
  private execute = false;
  private executeAt = 40;
  private tickT = 0;
  private rotated = false;
  private plantSpot: THREE.Vector3 | null = null;
  private post = new Map<number, [P, P]>();
  private save: [boolean, boolean] = [false, false];
  /** the player told the team where to go / to hold (until this time) */
  private callT = -1;
  private lastAttackSite: 'A' | 'B' | null = null;

  constructor(private g: G, private mode: SabMode) {}

  private get sab() {
    return this.mode.sab;
  }
  private bots() {
    return this.mode.players.filter((c): c is Bot => c instanceof Bot && !c.netPuppet && c.alive);
  }
  private v(p: P, y?: number) {
    const x = p[0], z = p[1];
    const yy = y ?? this.g.terrain.heightAt(x, z);
    const n = this.g.nav.nearest(new THREE.Vector3(x, yy + 0.1, z), 6, false);
    return n && Math.abs(n.p.y - yy) < 1.5 ? n.p.clone() : new THREE.Vector3(x, yy, z);
  }

  // ================================================================ buying
  buyRound() {
    const sab = this.sab;
    for (const team of [0, 1] as const) {
      const seats = sab.seats.filter((s) => s.c.team === team && s.c instanceof Bot && !(s.c as Bot).netPuppet);
      if (!seats.length) continue;
      const all = sab.seats.filter((s) => s.c.team === team);
      const avg = all.reduce((a, s) => a + s.money, 0) / all.length;
      const side = sab.side(team);
      const pistolRound = sab.roundsPlayed === 0 || (sab.ot === 0 && sab.roundsPlayed === 6);
      const lastRound = sab.score[0] === sab.target - 1 || sab.score[1] === sab.target - 1 || (sab.ot === 0 && sab.roundsPlayed === 5);
      let style: 'full' | 'force' | 'eco' | 'pistol' = pistolRound ? 'pistol' : avg >= 3900 ? 'full' : avg >= 2300 || lastRound ? 'force' : 'eco';
      if (this.save[team]) style = 'eco';
      this.save[team] = false;
      let cutters = 0, sniper = false;
      seats.forEach((s, i) => {
        const b = s.c as Bot;
        const buy = (id: string) => sab.buy(b, id) === '';
        const hasPrim = !!s.kit.primary;
        if (style === 'pistol') {
          if (i % 3 === 0) buy('vest');
          else if (i % 3 === 1) buy(side === 'atk' ? 'mp18' : 'rv357');
          else {
            buy('flash');
            buy('smoke');
          }
          return;
        }
        if (style === 'eco') {
          // save: maybe a cheap pistol and a flash if there is change to spare
          if (s.money > 1600 && !hasPrim) buy(['mp18', 'rv357'][i % 2]);
          return;
        }
        if (!hasPrim) {
          const rich = s.money > 6200;
          if (style === 'full' && rich && !sniper && (b.id % 4 === 0 || i === seats.length - 1)) {
            sniper = buy('skv338');
          }
          if (!s.kit.primary) {
            const opts = style === 'full' ? (side === 'atk' ? ['hval47', 'k416', 'hval47'] : ['k416', 'hval47', 'k416']) : ['ks17', 'mp7', 'ums45', 'pump12'];
            for (const id of opts.slice(i % 2)) if (buy(id)) break;
            if (!s.kit.primary) for (const id of ['ks17', 'mp7', 'stille9', 'ums45', 'pump12', 'db12']) if (buy(id)) break;
          }
        }
        if (s.kit.armor < 100 || !s.kit.helmet) buy(s.money > 1600 ? 'vesthelm' : 'vest');
        if (side === 'def' && cutters < 2 && !s.kit.cutters && buy('cutters')) cutters++;
        // grenades: smoke + flash for most, HE / fire for some
        const want = ['smoke', 'flash', i % 2 ? 'fire' : 'he', 'flash'];
        for (const n of want) if (s.money > 300 && nadeCount(s.kit) < NADE_TOTAL) buy(n);
      });
    }
    void SHOP;
    void NADE_MAX;
  }

  // ================================================================ round plans
  newRound(atk: 0 | 1) {
    this.atk.clear();
    this.def.clear();
    this.post.clear();
    this.execute = false;
    this.rotated = false;
    this.plantSpot = null;
    this.callT = -1;
    const sab = this.sab;
    const attackers = this.bots().filter((b) => b.team === atk);
    const defenders = this.bots().filter((b) => b.team !== atk);
    // ---- attackers: a site and a plan (varies; avoids hitting the same site every round)
    const r = Math.random();
    this.site = this.lastAttackSite && Math.random() < 0.6 ? (this.lastAttackSite === 'A' ? 'B' : 'A') : Math.random() < 0.5 ? 'A' : 'B';
    this.lastAttackSite = this.site;
    const econ = attackers.every((b) => !sab.seat(b)?.kit.primary);
    this.plan = econ ? 'rush' : r < 0.18 ? 'rush' : r < 0.55 ? 'default' : r < 0.8 ? 'split' : 'fake';
    this.executeAt = this.plan === 'rush' ? 0 : this.plan === 'default' ? 38 + Math.random() * 22 : 30 + Math.random() * 16;
    const lanes = ROUTES.filter((x) => x.site === this.site);
    const other = ROUTES.filter((x) => x.site !== this.site);
    const carrier = sab.charge.holder;
    attackers.forEach((b, i) => {
      let route = lanes[i % lanes.length];
      let role: AtkState['role'] = 'main';
      if (this.plan === 'rush') route = lanes[i % Math.min(2, lanes.length)];
      else if (this.plan === 'default' && i % 3 === 2) {
        // one lurks a lane of the other site, joining late
        route = other[i % other.length];
        role = 'lurk';
      } else if (this.plan === 'fake' && i < 2 && b !== carrier) {
        route = other[i % other.length];
        role = 'fake';
      }
      // the carrier goes with the main group, on the most direct lane
      if (b === carrier) {
        route = lanes[0];
        role = 'main';
      }
      this.atk.set(b.id, { route: route.pts, i: 0, stage: route.pts.length - 2, role, held: false });
    });
    // ---- defenders: 2 A, 1 mid, 2 B, 1 flex (random spots in each group)
    const pick = (g: string, n: number, used: Set<string>) => {
      const opts = WATCH.filter((w) => w.g === g && !used.has(w.p.join())).sort(() => Math.random() - 0.5).sort((a, b) => b.w * Math.random() - a.w * Math.random());
      return opts.slice(0, n);
    };
    const used = new Set<string>();
    const order: string[] = ['A', 'B', 'mid', 'A', 'B', 'flex'];
    // defenders on an eco stack one site instead
    const defEco = defenders.every((b) => !sab.seat(b)?.kit.primary) && sab.roundsPlayed > 0 && Math.random() < 0.5;
    const stack = Math.random() < 0.5 ? 'A' : 'B';
    defenders.forEach((b, i) => {
      const g = defEco ? (i === 0 ? 'mid' : stack) : order[i % order.length];
      const w = pick(g, 1, used)[0] ?? pick('flex', 1, used)[0] ?? WATCH[i % WATCH.length];
      used.add(w.p.join());
      this.def.set(b.id, { p: w.p, look: w.look, g, high: w.high });
    });
  }

  onPlanted(site: 'A' | 'B', p: THREE.Vector3) {
    this.site = site;
    // attackers: post-plant spots; defenders: retake
    const opts = [...POST[site]].sort(() => Math.random() - 0.5);
    let k = 0;
    for (const b of this.bots()) if (b.team === this.sab.atk) this.post.set(b.id, opts[k++ % opts.length]);
    void p;

  }
  onKill(killer: Combatant, victim: Combatant) {
    void killer;
    if (victim instanceof Bot) victim.busy = false;
  }

  // ================================================================ per tick
  update(dt: number) {
    const sab = this.sab;
    if (!sab.liveOrPlanted && sab.phase !== 'buy') return;
    // plant / defuse run every frame (they are timed)
    this.channel(dt);
    this.tickT -= dt;
    if (this.tickT > 0) return;
    this.tickT = 0.3;
    if (sab.phase === 'buy') return;
    const now = this.g.time;
    for (const b of this.bots()) {
      if (b.team === sab.atk) this.attacker(b, now);
      else this.defender(b, now);
      this.scavenge(b);
    }
    this.watchContacts();
  }

  /** sightings near a site make the defence rotate; noise makes the attack execute early */
  private watchContacts() {
    const sab = this.sab;
    if (sab.phase !== 'live') return;
    const atkAlive = this.mode.players.filter((c) => c.alive && c.team === sab.atk);
    const defBots = this.bots().filter((b) => b.team !== sab.atk);
    for (const st of SV_SITES) {
      const near = atkAlive.filter((c) => Math.hypot(c.position().x - st.x, c.position().z - st.z) < 26);
      const seen = near.filter((c) => defBots.some((d) => d.target === c));
      if (!this.rotated && (seen.length >= 2 || near.length >= 3)) {
        this.rotated = true;
        // the flex and one from the other site rotate in
        const flex = defBots.filter((d) => this.def.get(d.id)?.g === 'flex' || this.def.get(d.id)?.g === 'mid');
        const far = defBots.filter((d) => this.def.get(d.id)?.g === (st.letter === 'A' ? 'B' : 'A')).slice(0, 1);
        for (const d of [...flex, ...far]) {
          const spots = WATCH.filter((w) => w.g === st.letter);
          const w = spots[Math.floor(Math.random() * spots.length)];
          this.def.set(d.id, { p: w.p, look: w.look, g: st.letter, high: w.high });
        }
        const caller = defBots.find((d) => seen.some((c) => d.target === c)) ?? defBots[0];
        if (caller) this.g.botVoice?.(caller, st.letter === 'A' ? 'onA' : 'onB');
        const rot = [...flex, ...far][0];
        if (rot) this.g.later(1.4, () => rot.alive && this.g.botVoice?.(rot, st.letter === 'A' ? 'rotA' : 'rotB'));
      }
    }
    // attackers in contact anywhere: go now
    if (!this.execute && this.bots().some((b) => b.team === sab.atk && b.target && b.position().distanceTo(b.target.position()) < 40)) {
      if (sab.liveT > 12) this.execute = true;
    }
  }

  private order(b: Bot, kind: 'attack' | 'defend' | 'hold', p: THREE.Vector3, look?: THREE.Vector3, arrive = 2.2, walk = false) {
    const o = b.order;
    if (o && o.kind === kind && o.pos.distanceToSquared(p) < 0.25 && (!look || (o.look && o.look.distanceToSquared(look) < 1))) {
      o.until = this.g.time + 20;
      return;
    }
    b.order = { kind, pos: p, until: this.g.time + 20, look, arrive, walk };
  }

  private attacker(b: Bot, now: number) {
    const sab = this.sab;
    const ch = sab.charge;
    void now;
    // a dropped charge: the nearest attacker fetches it
    if (ch.state === 'dropped') {
      const mates = this.bots().filter((x) => x.team === sab.atk);
      const nearest = mates.sort((a, c) => a.position().distanceTo(ch.pos) - c.position().distanceTo(ch.pos))[0];
      if (nearest === b) {
        this.order(b, 'attack', ch.pos.clone(), undefined, 0.8);
        sab.tryPickup(b);
        return;
      }
    }
    if (sab.phase === 'planted') {
      const post = this.post.get(b.id);
      if (post) this.order(b, 'defend', this.v(post[0], post[0] === POST.A[0][0] ? LV.A + 1.8 : undefined), this.v(post[1]), 1.6);
      return;
    }
    const st = this.atk.get(b.id);
    if (!st) return;
    // the carrier on site: go to the plant spot
    if (ch.holder === b && sab.siteAt(b.position())) {
      if (!this.plantSpot || sab.siteAt(this.plantSpot) !== sab.siteAt(b.position())) {
        const s = sab.siteAt(b.position())!;
        const spots = PLANT[s].map((p) => this.v(p));
        this.plantSpot = spots.sort((a, c) => a.distanceTo(b.position()) - c.distanceTo(b.position()))[0];
      }
      this.order(b, 'attack', this.plantSpot!, undefined, 0.9);
      return;
    }
    // time is running out: everyone goes
    if (sab.timer < 45 || sab.liveT > this.executeAt) this.execute = true;
    // the plan has gone to pieces (few left): stick together on the carrier / the site
    const alive = this.bots().filter((x) => x.team === sab.atk).length + (this.g.avatar.alive && this.g.avatar.team === sab.atk ? 1 : 0);
    if (alive <= 2 && sab.liveT > 20) this.execute = true;
    const pts = st.route;
    // fakers turn round to join the main site once the execute starts (from their position)
    if (st.role !== 'main' && this.execute && !st.held) {
      st.held = true;
      const lanes = ROUTES.filter((x) => x.site === this.site);
      const lane = lanes.sort((a, c) => this.v(a.pts[a.pts.length - 2]).distanceTo(b.position()) - this.v(c.pts[c.pts.length - 2]).distanceTo(b.position()))[0];
      st.route = lane.pts;
      st.i = Math.max(0, lane.pts.length - 3);
      st.stage = lane.pts.length - 2;
    }
    // advance along the lane
    const wp = this.v(st.route[Math.min(st.i, st.route.length - 1)]);
    if (b.position().distanceTo(wp) < 3.2 && st.i < st.route.length - 1) {
      // wait at the staging point until the execute
      if (st.i >= st.stage && !this.execute) {
        this.order(b, 'hold', wp, this.v(st.route[st.route.length - 1]), 2);
        return;
      }
      st.i++;
    }
    const goal = this.v(st.route[Math.min(st.i, st.route.length - 1)]);
    if (st.i >= st.route.length - 1) {
      // on site: spread over the plant / post spots and clear
      const s = this.site;
      const opts = POST[s];
      const k = Math.abs(b.id) % opts.length;
      this.order(b, 'defend', this.v(opts[k][0], k === 0 && s === 'A' ? LV.A + 1.8 : undefined), this.v(opts[k][1]), 2);
    } else this.order(b, 'attack', goal, undefined, 2.5, !this.execute && st.role === 'lurk');
  }

  private defender(b: Bot, now: number) {
    const sab = this.sab;
    void now;
    if (sab.phase === 'planted') {
      // retake: gather at the staging point, then push the charge; the nearest defuses
      const site = sab.charge.site ?? this.site;
      const alive = this.bots().filter((x) => x.team !== sab.atk);
      const atkLeft = this.mode.players.filter((c) => c.alive && c.team === sab.atk).length;
      const defuser = alive.sort((a, c) => a.position().distanceTo(sab.charge.pos) - c.position().distanceTo(sab.charge.pos))[0];
      const go = sab.timer < 22 || atkLeft <= 1 || alive.filter((x) => x.position().distanceTo(sab.charge.pos) < 30).length >= Math.min(3, alive.length);
      if (b === defuser && (go || atkLeft === 0)) {
        this.order(b, 'attack', sab.charge.pos.clone(), undefined, 0.7);
        return;
      }
      if (!go) {
        const st = RETAKE[site];
        const p = st[Math.abs(b.id) % st.length];
        this.order(b, 'hold', this.v(p), sab.charge.pos.clone(), 2.5);
      } else this.order(b, 'attack', sab.charge.pos.clone().add(new THREE.Vector3(Math.sin(b.id) * 4, 0, Math.cos(b.id) * 4)), undefined, 2.5);
      return;
    }
    const d = this.def.get(b.id);
    if (!d) return;
    this.order(b, 'defend', this.v(d.p, d.high), this.v(d.look), 1.6);
  }

  /** a bot with no primary walks over to a gun lying close by */
  private scavenge(b: Bot) {
    const s = this.sab.seat(b);
    if (!s || s.kit.primary || b.target) return;
    for (const d of this.mode.groundGuns()) {
      if (WEAPONS[d.id].slot !== 'primary' || d.t < 1) continue;
      const dd = d.pos.distanceTo(b.position());
      if (dd < 1.4) {
        this.mode.botTake(b, d);
        return;
      }
      if (dd < 9) {
        this.order(b, 'attack', d.pos.clone(), undefined, 0.6);
        return;
      }
    }
  }

  /** plant / defuse for bots (every frame) */
  private channel(dt: number) {
    const sab = this.sab;
    for (const b of this.bots()) {
      let busy = false;
      const threat = !!b.target && b.lastDamageT < 2;
      if (sab.phase === 'live' && sab.charge.holder === b && this.plantSpot && b.position().distanceTo(this.plantSpot) < 1.3 && sab.siteAt(b.position())) {
        // plant unless someone is shooting at them (with little time left, plant anyway)
        if (!threat || sab.timer < PLANT_TIME + 3) {
          busy = true;
          sab.use(b, true, dt, false);
          if (!b.busy) this.g.botVoice?.(b, 'planting');
          if ((sab.phase as string) === 'planted') {
            sab.setWire(Math.floor(Math.random() * 3));
          }
        } else sab.use(b, false, dt, false);
      } else if (sab.phase === 'planted' && b.team !== sab.atk && b.position().distanceTo(sab.charge.pos) < 1.5) {
        const need = sab.seat(b)?.kit.cutters ? DEFUSE_KIT : DEFUSE_TIME;
        const left = need - (sab.defusing?.c === b ? sab.defusing.t : 0);
        const atkLeft = this.mode.players.filter((c) => c.alive && c.team === sab.atk).length;
        // defuse when it is quiet, or when there is no other choice
        if (!threat || sab.timer < left + 1 || atkLeft === 0) {
          if (!b.busy) this.g.botVoice?.(b, 'defusing');
          busy = true;
          const r = sab.use(b, true, dt, false);
          // the wire gamble: not enough time left to finish → cut one (never the ruled-out wire)
          const dd = sab.defusing;
          if (r === 'defuse' && dd && dd.c === b && dd.t >= WIRE_OPEN && sab.timer < need - dd.t) {
            const opts = [0, 1, 2].filter((w) => w !== dd.ruled);
            sab.cut(b, opts[Math.floor(Math.random() * opts.length)]);
          }
        } else sab.use(b, false, dt, false);
      }
      b.busy = busy || (sab.phase as string) === 'buy';
    }
  }

  // ================================================================ the player's squad orders
  static ORDERS: { kind: string; label: string; sub: string }[] = [
    { kind: 'goA', label: 'GÅ A', sub: 'everyone to A' },
    { kind: 'goB', label: 'GÅ B', sub: 'everyone to B' },
    { kind: 'hold', label: 'HOLD', sub: 'stay on your angles' },
    { kind: 'rotate', label: 'ROTÉR', sub: 'switch sites' },
    { kind: 'save', label: 'SPAR', sub: 'save: hide, keep guns' },
    { kind: 'drop', label: 'GI MEG ET VÅPEN', sub: 'drop me a gun' },
    { kind: 'follow', label: 'FØLG MEG', sub: 'stay with you' },
  ];
  playerOrder(kind: string): string {
    const g = this.g;
    const sab = this.sab;
    const me = g.avatar.team;
    const mates = this.bots().filter((b) => b.team === me);
    if (!mates.length) return 'NOBODY LEFT';
    const attacking = sab.atk === me;
    if (kind === 'goA' || kind === 'goB') {
      const s = kind === 'goA' ? 'A' : 'B';
      if (attacking) {
        this.site = s;
        this.execute = true;
        const lanes = ROUTES.filter((x) => x.site === s);
        mates.forEach((b, i) => {
          const lane = lanes[i % lanes.length];
          const near = lane.pts.reduce((bi, p, k) => (this.v(p).distanceTo(b.position()) < this.v(lane.pts[bi]).distanceTo(b.position()) ? k : bi), 0);
          this.atk.set(b.id, { route: lane.pts, i: near, stage: lane.pts.length - 2, role: 'main', held: true });
        });
      } else {
        for (const b of mates) {
          const spots = WATCH.filter((w) => w.g === s);
          const w = spots[Math.floor(Math.random() * spots.length)];
          this.def.set(b.id, { p: w.p, look: w.look, g: s, high: w.high });
        }
      }
      return s === 'A' ? 'ALLE TIL A' : 'ALLE TIL B';
    }
    if (kind === 'rotate') {
      if (attacking) {
        this.site = this.site === 'A' ? 'B' : 'A';
        return this.playerOrder(this.site === 'A' ? 'goA' : 'goB');
      }
      for (const b of mates) {
        const d = this.def.get(b.id);
        const to = d?.g === 'A' ? 'B' : d?.g === 'B' ? 'A' : Math.random() < 0.5 ? 'A' : 'B';
        const spots = WATCH.filter((w) => w.g === to);
        const w = spots[Math.floor(Math.random() * spots.length)];
        this.def.set(b.id, { p: w.p, look: w.look, g: to, high: w.high });
      }
      return 'ROTERER';
    }
    if (kind === 'hold') {
      for (const b of mates) {
        const p = b.position();
        this.def.set(b.id, { p: [p.x, p.z], look: [p.x - Math.sin(b.yaw) * 10, p.z - Math.cos(b.yaw) * 10], g: 'flex' });
        const st = this.atk.get(b.id);
        if (st) st.held = true;
      }
      this.execute = false;
      this.executeAt = Math.max(this.executeAt, sab.liveT + 25);
      return 'HOLDER';
    }
    if (kind === 'save') {
      this.save[me as 0 | 1] = true;
      // hide: back towards spawn, out of the fight
      for (const b of mates) {
        const home = me === sab.atk ? [0, 64] : [-14, -70];
        this.def.set(b.id, { p: [home[0] + (b.id % 3) * 4 - 4, home[1]], look: [0, 0], g: 'flex' });
        this.atk.delete(b.id);
      }
      return 'SPARER RUNDEN';
    }
    if (kind === 'drop') return this.dropForPlayer();
    if (kind === 'follow') {
      for (const b of mates) b.order = { kind: 'follow', pos: g.player.pos.clone(), until: g.time + 40, who: g.avatar };
      return 'FØLGER DEG';
    }
    return '';
  }
  /** a rich teammate buys a rifle and drops it for you (in the buy window), or hands over theirs */
  private dropForPlayer() {
    const g = this.g;
    const sab = this.sab;
    const mine = sab.seat(g.avatar);
    if (!mine) return '';
    if (mine.kit.primary) return 'DU HAR ET VÅPEN';
    const me = g.avatar.team;
    const mates = sab.seats.filter((s) => s.c.team === me && s.c instanceof Bot && s.c.alive && !(s.c as Bot).netPuppet).sort((a, b) => b.money - a.money);
    const pref: WeaponId[] = sab.side(me) === 'atk' ? ['hval47', 'k416', 'ks17', 'mp7'] : ['k416', 'hval47', 'ks17', 'mp7'];
    const at = g.player.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    if (sab.canBuy()) {
      for (const s of mates) {
        for (const id of pref) {
          const it = SHOP.find((x) => x.id === id)!;
          if (s.money >= it.price + 1000) {
            s.money -= it.price;
            this.mode.dropGun(s.c, id, at, new THREE.Vector3(0, 0.5, 0));
            return `${s.c.name.toUpperCase()} KJØPTE ${WEAPONS[id].short} TIL DEG`;
          }
        }
      }
    }
    // hand over a gun: the teammate with the most money left keeps theirs, the poorest gives
    const giver = [...mates].reverse().find((s) => s.kit.primary);
    if (giver && giver.kit.primary) {
      const id = giver.kit.primary;
      giver.kit.primary = null;
      this.mode.applyKit(giver.c, false);
      this.mode.dropGun(giver.c, id, (giver.c as Bot).position().clone().setY((giver.c as Bot).position().y + 1.2), new THREE.Vector3(0, 0.5, 0));
      return `${giver.c.name.toUpperCase()} SLIPPER ${WEAPONS[id].short}`;
    }
    return 'INGEN HAR RÅD · NOBODY CAN AFFORD IT';
  }
}
export type { Seat };
