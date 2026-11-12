import * as THREE from 'three';
import { Combatant } from './Combatant';
import { Physics } from '../core/Physics';
import { Terrain } from '../world/Terrain';
import { NavGraph } from '../ai/NavGraph';
import { SPAWNS, PLAY_HALF, MAP_ID } from '../world/MapLayout';

interface Candidate {
  p: THREE.Vector3;
  /** curated spawns carry a team preference (-1 = neutral / generated) */
  team: -1 | 0 | 1;
  curated: boolean;
  yaw: number;
}

interface Mark { p: THREE.Vector3; t: number; team?: 0 | 1 }

/** Team "home" anchors: the side each team starts on. Influence fades as the match flows. */
const DEFAULT_HOME: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(20, 0, 160), new THREE.Vector3(50, 0, -150)];

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpD = new THREE.Vector3();

/**
 * Dynamic spawn selection in the spirit of modern CoD TDM:
 *  - a large pool of candidates (curated team spawns + safe nav nodes all over the map)
 *  - hard rejects for anything an enemy is standing on, looking at or can see
 *  - soft scoring that pulls you toward teammates and the "friendly side" of the current
 *    front line (enemy centroid vs friendly centroid), near — but not inside — the action
 *  - memory of recent deaths & spawns so the same spot is not farmed (anti spawn-trap)
 *  - spawns flip naturally: when the enemy pushes into your half, your candidates there score
 *    badly and the system starts using the other side of the map
 *  - the spawn yaw faces the fight while avoiding walls
 */
export class SpawnSystem {
  candidates: Candidate[] = [];
  private deaths: Mark[] = [];
  private used: Mark[] = [];
  private action: Mark[] = [];
  /** debugging: last evaluated scores */
  lastPick: { p: THREE.Vector3; score: number; reason: string } | null = null;

  constructor(private physics: Physics, private terrain: Terrain, nav: NavGraph, private now: () => number) {
    for (const s of SPAWNS) {
      this.candidates.push({ p: new THREE.Vector3(s.x, terrain.heightAt(s.x, s.z), s.z), team: s.team as -1 | 0 | 1, curated: true, yaw: s.yaw });
    }
    // generated candidates: outdoor nav nodes with some shelter, on dry land, away from the edge
    const keep: THREE.Vector3[] = [];
    for (const n of nav.nodes) {
      if (n.indoor || n.links.length < 2) continue;
      if (n.p.y < 1.2) continue; // shoreline / docks: too exposed
      if (Math.abs(n.p.x) > PLAY_HALF - 14 || Math.abs(n.p.z) > PLAY_HALF - 14) continue;
      if (n.cover > 0.92) continue; // wide-open fields make you a free kill
      if (keep.some((k) => k.distanceToSquared(n.p) < 13 * 13)) continue;
      keep.push(n.p);
      this.candidates.push({ p: n.p.clone(), team: -1, curated: false, yaw: 0 });
    }
  }

  noteDeath(p: THREE.Vector3, team: 0 | 1) {
    this.deaths.push({ p: p.clone(), t: this.now(), team });
    if (this.deaths.length > 40) this.deaths.shift();
  }

  noteAction(p: THREE.Vector3) {
    const t = this.now();
    const last = this.action[this.action.length - 1];
    if (last && t - last.t < 0.5 && last.p.distanceToSquared(p) < 64) return;
    this.action.push({ p: p.clone(), t });
    if (this.action.length > 50) this.action.shift();
  }

  reset() {
    this.deaths.length = 0;
    this.used.length = 0;
    this.action.length = 0;
    this.layout = null;
  }

  /**
   * Per-match spawn layout: two team anchors chosen at random among all safe candidates, far
   * apart (≥ 170 m) and on opposite halves of a randomly oriented split of the map. Every match
   * starts somewhere different — harbour vs fort, village vs farm, shore vs ridge … — and the
   * dynamic spawn logic afterwards treats these anchors as each team's "home".
   */
  private layout: { home: [THREE.Vector3, THREE.Vector3]; taken: THREE.Vector3[] } | null = null;
  /** Domination: extra score for spawning at a position (held flags pull, enemy flags push away). */
  bias: ((p: THREE.Vector3, team: 0 | 1) => number) | null = null;
  ensureLayout() {
    if (!this.layout) this.makeLayout();
    return this.layout!.home;
  }
  homes(): [THREE.Vector3, THREE.Vector3] {
    return this.layout?.home ?? DEFAULT_HOME;
  }
  private makeLayout() {
    if (MAP_ID === 'brosund') {
      // Brosund: the sound splits the map — one team starts on the town islands (west), the other
      // on Ellingsøya (east); which side and which corner of it varies per match
      const west = [new THREE.Vector3(-165, 0, 75), new THREE.Vector3(-150, 0, -70), new THREE.Vector3(-110, 0, 140)];
      const east = [new THREE.Vector3(186, 0, 66), new THREE.Vector3(200, 0, -20), new THREE.Vector3(160, 0, 30)];
      const w = west[Math.floor(Math.random() * west.length)], e = east[Math.floor(Math.random() * east.length)];
      // snap to the nearest real candidate so the squad has ground to stand on
      const snap = (p: THREE.Vector3) => this.candidates.reduce((bst, c) => (flat(c.p, p) < flat(bst.p, p) ? c : bst), this.candidates[0]).p.clone();
      const pw = snap(w), pe = snap(e);
      this.layout = { home: Math.random() < 0.5 ? [pw, pe] : [pe, pw], taken: [] };
      return;
    }
    const pool = this.candidates.filter((c) => !c.curated || Math.random() < 0.6);
    for (let attempt = 0; attempt < 60; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const ax = Math.cos(ang), az = Math.sin(ang);
      const side = (p: THREE.Vector3) => p.x * ax + p.z * az;
      const a = pool[Math.floor(Math.random() * pool.length)];
      if (side(a.p) > -40) continue; // team 0 on the negative half of this split
      const far = pool.filter((c) => side(c.p) > 40 && flat(c.p, a.p) > 170);
      if (!far.length) continue;
      const b = far[Math.floor(Math.random() * far.length)];
      // both anchors need room for a squad: several candidates nearby
      const room = (p: THREE.Vector3) => this.candidates.filter((c) => flat(c.p, p) < 50).length;
      if (room(a.p) < 6 || room(b.p) < 6) continue;
      const swap = Math.random() < 0.5;
      this.layout = { home: swap ? [b.p.clone(), a.p.clone()] : [a.p.clone(), b.p.clone()], taken: [] };
      return;
    }
    this.layout = { home: [DEFAULT_HOME[0].clone(), DEFAULT_HOME[1].clone()], taken: [] };
  }

  /** Opening spawn: a spread-out squad position around this team's anchor, facing the enemy anchor. */
  private initialPick(team: 0 | 1) {
    if (!this.layout) this.makeLayout();
    const L = this.layout!;
    const home = L.home[team], away = L.home[1 - team];
    // 12-player squads: spread over the anchor's neighbourhood, at least 7 m apart; once the
    // nearby candidates are used up, fan out around them (clear line, solid ground) instead of
    // stacking everyone on the same point
    const near = this.candidates
      .filter((c) => flat(c.p, home) < 70 && !L.taken.some((t) => flat(t, c.p) < 7))
      .map((c) => ({ c, s: flat(c.p, home) + Math.random() * 25 }))
      .sort((x, y) => x.s - y.s);
    let p: THREE.Vector3;
    if (near[0]) p = near[0].c.p.clone();
    else {
      const base = L.taken.length ? L.taken[Math.floor(Math.random() * L.taken.length)] : home;
      p = base.clone();
      for (let k = 0; k < 16; k++) {
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 3.5;
        const dir = tmpA.set(Math.cos(a), 0, Math.sin(a));
        const chest = tmpB.copy(base).setY(base.y + 1.1);
        if (this.physics.raycast(chest, dir, r + 0.6)) continue;
        const q = base.clone().addScaledVector(dir, r);
        const g = this.physics.raycast(tmpD.copy(q).setY(q.y + 2), new THREE.Vector3(0, -1, 0), 4);
        if (!g || Math.abs(g.point.y - base.y) > 1.2) continue;
        if (L.taken.some((t) => flat(t, q) < 2.5)) continue;
        p = q.setY(g.point.y);
        break;
      }
    }
    p.y += 0.3;
    L.taken.push(p.clone());
    this.used.push({ p: p.clone(), t: this.now() });
    this.lastPick = { p, score: 0, reason: `opening ${team} @ ${home.x.toFixed(0)},${home.z.toFixed(0)}` };
    return { pos: p, yaw: this.faceYaw(p, away) };
  }

  pick(team: 0 | 1, players: Combatant[], initial = false): { pos: THREE.Vector3; yaw: number } {
    if (initial) return this.initialPick(team);
    const t = this.now();
    const enemies = players.filter((p) => p.alive && p.team !== team);
    const friends = players.filter((p) => p.alive && p.team === team);
    const ePos = enemies.map((e) => e.position());
    const fPos = friends.map((f) => f.position());
    const centroid = (ps: THREE.Vector3[], fb: THREE.Vector3) => {
      if (!ps.length) return fb.clone();
      const c = new THREE.Vector3();
      for (const p of ps) c.add(p);
      return c.multiplyScalar(1 / ps.length);
    };
    const hs = this.homes();
    const home = hs[team], away = hs[1 - team];
    const Fc = centroid(fPos, home);
    const Ec = centroid(ePos, away);
    const recentAction = this.action.filter((a) => t - a.t < 12);
    const recentDeaths = this.deaths.filter((d) => t - d.t < 12);
    const recentUsed = this.used.filter((u) => t - u.t < 6);

    // ---- pass 1: cheap distance-based scoring over the whole pool ----
    const scored: { c: Candidate; s: number; why: string }[] = [];
    for (const c of this.candidates) {
      if (initial) {
        // match start: only this team's curated spawns, spread out between teammates
        if (!c.curated || c.team !== team) continue;
      } else if (!this.layout && c.curated && c.team !== -1 && c.team !== team) {
        // the enemy's curated base spawns are only usable once that side is clearly ours
        if (ePos.some((e) => flat(e, c.p) < 70)) continue;
      }
      let s = 0;
      let why = '';
      let minE = 1e9;
      for (const e of ePos) {
        const d = flat(e, c.p);
        minE = Math.min(minE, d);
        const k = Math.max(0, 1 - d / 60);
        s -= 150 * k * k;
      }
      if (minE < 18) continue; // never spawn on top of an enemy
      // friendly support: close enough to regroup, not stacked in one spot
      let minF = 1e9;
      for (const f of fPos) minF = Math.min(minF, flat(f, c.p));
      if (fPos.length) {
        s += 45 * Math.exp(-Math.pow((minF - 24) / 22, 2));
        if (minF < 5) s -= 25;
      }
      // front line: prefer the friendly side of the line between both teams
      const side = flat(c.p, Ec) - flat(c.p, Fc);
      s += THREE.MathUtils.clamp(side, -70, 70) * 0.65;
      // home side bias (fades as the map opens up, never fully)
      s += 26 * (1 - Math.min(1, flat(c.p, home) / 260));
      if (!this.layout && c.curated && c.team === team) s += 10;
      // near the action but never inside it
      let nearAct = 1e9;
      for (const a of recentAction) nearAct = Math.min(nearAct, flat(a.p, c.p));
      if (nearAct < 24) s -= 70 * (1 - nearAct / 24);
      else if (nearAct < 85) s += 16;
      // spawn-trap memory
      for (const d of recentDeaths) {
        const dd = flat(d.p, c.p);
        if (dd < 22) s -= d.team === team ? 90 * (1 - dd / 22) : 25 * (1 - dd / 22);
      }
      for (const u of recentUsed) if (flat(u.p, c.p) < 9) s -= 60;
      s += Math.random() * 14;
      if (this.bias) s += this.bias(c.p, team);
      if (initial) s = Math.random() * 10 - recentUsed.filter((u) => flat(u.p, c.p) < 9).length * 50;
      why = `minE ${minE.toFixed(0)} minF ${minF > 1e8 ? '-' : minF.toFixed(0)} side ${side.toFixed(0)}`;
      scored.push({ c, s, why });
    }
    scored.sort((a, b) => b.s - a.s);

    // ---- pass 2: line-of-sight & view-cone rejection on the best few ----
    let chosen: { c: Candidate; s: number; why: string } | null = null;
    let seenBest: { c: Candidate; s: number; why: string } | null = null;
    const eyes = enemies.map((e) => e.eye(new THREE.Vector3()));
    const looks = enemies.map((e) => (e.lookDir ? e.lookDir(new THREE.Vector3()) : null));
    // (12 enemies see a lot of the map: search deeper for a spot none of them can see)
    for (const cand of scored.slice(0, 150)) {
      const head = tmpA.copy(cand.c.p).setY(cand.c.p.y + 1.6);
      let pen = 0;
      let hardReject = false;
      for (let i = 0; i < eyes.length; i++) {
        const d = eyes[i].distanceTo(head);
        if (d > 180) continue;
        if (!this.physics.lineOfSight(eyes[i], head)) continue;
        // seen: close + in view = reject, otherwise heavy penalty
        const lk = looks[i];
        const facing = lk ? lk.dot(tmpD.subVectors(head, eyes[i]).normalize()) : 0.5;
        if (d < 55 || facing > 0.72) hardReject = true;
        pen += 220 * (1 - d / 160) + (facing > 0.5 ? 120 : 0);
      }
      if (hardReject) continue;
      if (pen === 0) {
        chosen = { c: cand.c, s: cand.s, why: cand.why };
        break; // the best unseen candidate always wins
      }
      const total = cand.s - pen;
      if (!seenBest || total > seenBest.s) seenBest = { c: cand.c, s: total, why: cand.why + ` seen-pen ${pen.toFixed(0)}` };
    }
    if (!chosen) chosen = seenBest ?? scored[0] ?? { c: this.candidates[0], s: -1e9, why: 'fallback' };

    const p = chosen.c.p.clone();
    // tiny jitter for curated spawns so squads do not stack in the exact same spot
    if (chosen.c.curated) {
      const jx = (Math.random() - 0.5) * 3, jz = (Math.random() - 0.5) * 3;
      p.x += jx;
      p.z += jz;
      p.y = this.terrain.heightAt(p.x, p.z);
    }
    p.y += 0.3;
    this.used.push({ p: p.clone(), t });
    if (this.used.length > 48) this.used.shift();
    const yaw = this.faceYaw(p, recentAction.length ? centroid(recentAction.map((a) => a.p), Ec) : Ec);
    this.lastPick = { p, score: chosen.s, reason: chosen.why };
    return { pos: p, yaw };
  }

  /** Face the fight, but pick a direction with room to move (no staring into a wall). */
  private faceYaw(p: THREE.Vector3, toward: THREE.Vector3) {
    const want = Math.atan2(-(toward.x - p.x), -(toward.z - p.z));
    const eye = tmpB.copy(p).setY(p.y + 1.5);
    let best = want, bs = -1e9;
    for (let i = 0; i < 12; i++) {
      const yaw = want + (i < 1 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6));
      const dir = tmpD.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = this.physics.raycast(eye, dir, 14);
      const open = hit ? hit.distance : 14;
      const s = Math.cos(yaw - want) * 1.0 + Math.min(open, 10) / 10 * 1.4;
      if (s > bs) {
        bs = s;
        best = yaw;
      }
    }
    return best;
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
