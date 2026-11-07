import * as THREE from 'three';
import { Combatant } from './Combatant';
import { NavGraph } from '../ai/NavGraph';
import { Terrain } from '../world/Terrain';
import { LANDMARKS } from '../world/MapLayout';

/**
 * Domination: three flags (A, B, C). Standing in a flag's zone captures it — a neutral flag
 * takes 7 s for one player, an enemy flag 10 s (it turns neutral at the halfway point). More
 * teammates capture faster (up to ×1.6), any enemy in the zone contests it and freezes progress.
 * Every 5 s each team scores one point per flag it holds; first to 200 wins.
 *
 * The flag sites are picked per match from the map's landmark areas so that B sits between the
 * two team anchors and A / C are on each team's side (the spawn layout changes every match).
 */
export type Owner = -1 | 0 | 1;

export interface Flag {
  letter: 'A' | 'B' | 'C';
  name: string;
  pos: THREE.Vector3;
  radius: number;
  owner: Owner;
  /** team currently capturing, -1 when nobody is */
  capTeam: Owner;
  /** 0..1 capture progress for capTeam */
  progress: number;
  contested: boolean;
  /** who is inside right now (alive) */
  inside: [number, number];
  /** world visuals */
  group: THREE.Group;
  ring: THREE.Mesh;
  banner: THREE.Mesh;
  fill: THREE.Mesh;
}

export interface FlagEvent {
  kind: 'captured' | 'neutralized';
  flag: Flag;
  team: 0 | 1;
  /** players that were in the zone when it happened */
  by: Combatant[];
}

const SITES = ['Kirka', 'Sentrum', 'Brygga', 'Tunnelen', 'Låven', 'Hjellene', 'Brua', 'Ryggen', 'Kystfortet', 'Havna', 'Skaret', 'Skogen', 'Kranen', 'Fyret', 'Leiren', 'Radaren', 'Hyttefeltet'];
/** the village core: fine for a flag now and then, but not every match */
const VILLAGE = ['Sentrum', 'Kirka', 'Brua', 'Tunnelen'];
const TEAM_COL = [new THREE.Color(0x3d8bff), new THREE.Color(0xff4a3a)];
const NEUTRAL = new THREE.Color(0xe8e8e8);

export class Domination {
  flags: Flag[] = [];
  tickT = 0;
  readonly tickEvery = 5;
  onEvent: (e: FlagEvent) => void = () => {};
  private root = new THREE.Group();

  constructor(private scene: THREE.Scene, private nav: NavGraph, private terrain: Terrain) {
    scene.add(this.root);
  }

  /** Choose the three flag sites for this match from the two team anchors. */
  setup(home0: THREE.Vector3, home1: THREE.Vector3) {
    for (const f of this.flags) this.root.remove(f.group);
    this.flags = [];
    // about two matches in three keep the flags out of the village core entirely, so the fight
    // happens at the fort, the camp, the forest, the radar station, the cabins …
    const village = Math.random() < 0.25;
    const sites = LANDMARKS.filter((l) => SITES.includes(l.name) && (village || !VILLAGE.includes(l.name))).map((l) => {
      // snap to an outdoor nav node near the landmark centre (flags sit on walkable, reachable ground)
      const c = new THREE.Vector3(l.x, this.terrain.heightAt(l.x, l.z), l.z);
      const out = this.nav.near(c, 26).filter((n) => !n.indoor && n.links.length >= 2).sort((a, b) => a.p.distanceToSquared(c) - b.p.distanceToSquared(c));
      const n = out[0] ?? this.nav.nearest(c, 60);
      return { name: l.name, p: n ? n.p.clone() : new THREE.Vector3(l.x, this.terrain.heightAt(l.x, l.z), l.z) };
    });
    const d0 = (p: THREE.Vector3) => flat(p, home0), d1 = (p: THREE.Vector3) => flat(p, home1);
    const span = flat(home0, home1);
    // B: balanced between both anchors and close to the line joining them
    const mid = home0.clone().lerp(home1, 0.5);
    // (a random jitter per site so the same pair of homes doesn't always produce the same B)
    const jit = new Map(sites.map((x) => [x, Math.random() * 45]));
    const bScore = (x: { p: THREE.Vector3; name?: string }) => Math.abs(d0(x.p) - d1(x.p)) + flat(x.p, mid) * 0.6 + (jit.get(x as never) ?? 0) + (VILLAGE.includes(x.name ?? '') ? 50 : 0);
    const b = [...sites].sort((x, y) => bScore(x) - bScore(y))[0];
    const rest = sites.filter((s) => s !== b && flat(s.p, b.p) > 55);
    // A on team 0's side, C on team 1's side — roughly a third of the way out, not on top of the spawn
    const sideScore = (s: { p: THREE.Vector3 }, home: THREE.Vector3, other: THREE.Vector3) => {
      const dh = flat(s.p, home), dot = flat(s.p, other);
      return Math.abs(dh - span * 0.3) + (dot < dh ? 400 : 0) + (jit.get(s as never) ?? 0) * 0.6;
    };
    const a = [...rest].sort((x, y) => sideScore(x, home0, home1) - sideScore(y, home0, home1))[0] ?? rest[0];
    const c = [...rest.filter((s) => s !== a && flat(s.p, a.p) > 60)].sort((x, y) => sideScore(x, home1, home0) - sideScore(y, home1, home0))[0] ?? rest.find((s) => s !== a)!;
    const list: [Flag['letter'], { name: string; p: THREE.Vector3 }][] = [['A', a], ['B', b], ['C', c]];
    for (const [letter, s] of list) this.flags.push(this.makeFlag(letter, s.name, s.p));
    this.tickT = 0;
  }

  /** network client: use exactly the host's flags */
  setupFixed(list: { letter: Flag['letter']; name: string; p: [number, number, number] }[]) {
    for (const f of this.flags) this.root.remove(f.group);
    this.flags = list.map((l) => this.makeFlag(l.letter, l.name, new THREE.Vector3(...l.p)));
    this.tickT = 0;
  }
  /** network client: mirror the host's capture state (raising the same events locally on changes) */
  applyRemote(st: [number, number, number, number][], time: number, players: Combatant[]) {
    this.flags.forEach((f, i) => {
      const r = st[i];
      if (!r) return;
      const owner = r[0] as Owner;
      if (owner !== f.owner) {
        const by = players.filter((p) => p.alive && this.inZone(f, p.position()));
        if (owner === -1) this.onEvent({ kind: 'neutralized', flag: f, team: (1 - (f.owner as number)) as 0 | 1, by });
        else this.onEvent({ kind: 'captured', flag: f, team: owner as 0 | 1, by });
      }
      f.owner = owner;
      f.capTeam = r[1] as Owner;
      f.progress = r[2];
      f.contested = r[3] > 0;
      f.inside = [0, 0];
      for (const p of players) if (p.alive && this.inZone(f, p.position())) f.inside[p.team]++;
      this.visual(f, time);
    });
  }

  private makeFlag(letter: Flag['letter'], name: string, p: THREE.Vector3): Flag {
    const radius = 6;
    const g = new THREE.Group();
    g.position.copy(p);
    // ground ring: a soft glowing band that follows the terrain only loosely (zones are mostly flat)
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { col: { value: NEUTRAL.clone() }, t: { value: 0 }, prog: { value: 0 }, pcol: { value: NEUTRAL.clone() } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 col; uniform vec3 pcol; uniform float t; uniform float prog; varying vec2 vUv;
        void main(){
          vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y,p.x)/6.2831853+0.5;
          float band = smoothstep(0.86,0.93,r)*(1.0-smoothstep(0.96,1.0,r));
          float dash = step(0.5, fract(a*36.0 - t*0.15));
          float inner = smoothstep(1.0,0.0,r)*0.06;
          vec3 c = mix(col, pcol, step(a, prog) * step(0.001, prog));
          float alpha = band*(0.55+0.35*dash) + inner;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(c*1.6, alpha);
        }`,
    });
    const ring = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    ring.renderOrder = 5;
    g.add(ring);
    // pole + banner
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.7, roughness: 0.4 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 4.2, 8), poleMat);
    pole.position.y = 2.1;
    pole.castShadow = true;
    g.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.18, 10), poleMat);
    base.position.y = 0.09;
    g.add(base);
    const bannerGeo = new THREE.PlaneGeometry(1.25, 0.8, 10, 4);
    bannerGeo.translate(0.625, 0, 0);
    const bannerMat = new THREE.MeshStandardMaterial({ color: NEUTRAL.clone(), side: THREE.DoubleSide, roughness: 0.85, emissive: NEUTRAL.clone(), emissiveIntensity: 0.12 });
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(0.04, 3.7, 0);
    banner.castShadow = true;
    g.add(banner);
    // vertical capture "fill" column so you can read progress from afar
    const fillMat = new THREE.MeshBasicMaterial({ color: NEUTRAL.clone(), transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.98, radius * 0.98, 1, 48, 1, true), fillMat);
    fill.position.y = 0.5;
    fill.visible = false;
    g.add(fill);
    this.root.add(g);
    return { letter, name, pos: p.clone(), radius, owner: -1, capTeam: -1, progress: 0, contested: false, inside: [0, 0], group: g, ring, banner, fill };
  }

  reset() {
    for (const f of this.flags) {
      f.owner = -1;
      f.capTeam = -1;
      f.progress = 0;
      f.contested = false;
    }
    this.tickT = 0;
  }

  inZone(f: Flag, p: THREE.Vector3) {
    return flat(p, f.pos) < f.radius && Math.abs(p.y - f.pos.y) < 4.5;
  }

  flagAt(p: THREE.Vector3) {
    return this.flags.find((f) => this.inZone(f, p)) ?? null;
  }

  /** Advance captures; returns points earned this frame per team. */
  update(dt: number, players: Combatant[], time: number): [number, number] {
    for (const f of this.flags) {
      const by: Combatant[] = [];
      f.inside = [0, 0];
      for (const p of players) {
        if (!p.alive || !this.inZone(f, p.position())) continue;
        f.inside[p.team]++;
        by.push(p);
      }
      const [n0, n1] = f.inside;
      f.contested = n0 > 0 && n1 > 0;
      const team: Owner = f.contested ? -1 : n0 > 0 ? 0 : n1 > 0 ? 1 : -1;
      if (f.contested) {
        // frozen
      } else if (team !== -1 && team !== f.owner) {
        const n = team === 0 ? n0 : n1;
        const rate = (1 / (f.owner === -1 ? 7 : 10)) * Math.min(1.6, 1 + (n - 1) * 0.3);
        if (f.capTeam !== team) {
          // someone else had progress here: wind it back first (twice as fast)
          f.progress -= dt * rate * 2;
          if (f.progress <= 0) {
            f.progress = 0;
            f.capTeam = team;
          }
        } else {
          const before = f.progress;
          f.progress = Math.min(1, f.progress + dt * rate);
          if (f.owner !== -1 && before < 0.5 && f.progress >= 0.5) {
            const was = f.owner;
            f.owner = -1;
            this.onEvent({ kind: 'neutralized', flag: f, team: team as 0 | 1, by });
            void was;
          }
          if (f.progress >= 1) {
            f.owner = team;
            f.capTeam = -1;
            f.progress = 0;
            this.onEvent({ kind: 'captured', flag: f, team: team as 0 | 1, by });
          }
        }
      } else if (team === -1 || team === f.owner) {
        // nobody (or only owners) inside: progress bleeds away
        if (f.progress > 0) {
          f.progress = Math.max(0, f.progress - dt * (team === f.owner && team !== -1 ? 0.25 : 0.06));
          if (f.progress === 0) f.capTeam = -1;
        }
      }
      this.visual(f, time);
    }
    this.tickT += dt;
    const pts: [number, number] = [0, 0];
    if (this.tickT >= this.tickEvery) {
      this.tickT -= this.tickEvery;
      for (const f of this.flags) if (f.owner !== -1) pts[f.owner]++;
    }
    return pts;
  }

  /** Colour relative to the local player's team: friendly blue, enemy red, neutral white. */
  myTeam: 0 | 1 = 0;
  colourOf(o: Owner) {
    if (o === -1) return NEUTRAL;
    return o === this.myTeam ? TEAM_COL[0] : TEAM_COL[1];
  }

  private visual(f: Flag, time: number) {
    const col = this.colourOf(f.owner);
    const rm = f.ring.material as THREE.ShaderMaterial;
    rm.uniforms.col.value.copy(col);
    rm.uniforms.t.value = time;
    rm.uniforms.prog.value = f.capTeam === -1 ? 0 : f.progress;
    rm.uniforms.pcol.value.copy(this.colourOf(f.capTeam));
    const bm = f.banner.material as THREE.MeshStandardMaterial;
    bm.color.copy(col);
    bm.emissive.copy(col);
    // banner flutter
    const pos = (f.banner.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, Math.sin(x * 4 - time * 5 + f.pos.x) * 0.08 * x);
    }
    pos.needsUpdate = true;
    // capture column rises with progress
    const fm = f.fill.material as THREE.MeshBasicMaterial;
    f.fill.visible = f.capTeam !== -1 && f.progress > 0.01;
    if (f.fill.visible) {
      const h = 0.2 + f.progress * 3.2;
      f.fill.scale.y = h;
      f.fill.position.y = h / 2;
      fm.color.copy(this.colourOf(f.capTeam));
      fm.opacity = f.contested ? 0.06 + 0.06 * Math.sin(time * 10) : 0.1;
    }
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
