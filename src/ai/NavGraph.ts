import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Terrain } from '../world/Terrain';
import { NavHint } from '../world/Buildings';
import { PLAY_HALF } from '../world/MapLayout';

export interface NavNode {
  id: number;
  p: THREE.Vector3;
  links: number[];
  /** exposure: how open the node is (0 = sheltered, 1 = exposed); used for cover search */
  cover: number;
  indoor: boolean;
}

/** Waypoint graph over the playable area with A* search. */
export class NavGraph {
  nodes: NavNode[] = [];
  private grid = new Map<number, number[]>();
  private cell = 12;
  // A* scratch (see path)
  private sG = new Float64Array(0);
  private sCame = new Int32Array(0);
  private sSeen = new Uint32Array(0);
  private sClosed = new Uint32Array(0);
  private sGen = 0;
  private hF = new Float64Array(256);
  private hI = new Int32Array(256);

  constructor(private physics: Physics, private terrain: Terrain, hints: NavHint[], points: THREE.Vector3[]) {
    const t0 = performance.now();
    const step = 7;
    const capsule = new Physics.R.Capsule(0.5, 0.3);
    const free = (p: THREE.Vector3) => !physics.overlaps({ x: p.x, y: p.y + 0.9, z: p.z }, capsule);
    // surface height: highest walkable surface below terrain+3 (docks, bridges) — else terrain
    const surface = (x: number, z: number) => {
      const th = terrain.heightAt(x, z);
      const hit = physics.raycast(new THREE.Vector3(x, th + 2.6, z), new THREE.Vector3(0, -1, 0), 12);
      return hit && hit.normal.y > 0.7 ? hit.point.y : th;
    };
    for (let x = -PLAY_HALF + 3; x <= PLAY_HALF - 3; x += step) {
      for (let z = -PLAY_HALF + 3; z <= PLAY_HALF - 3; z += step) {
        const y = surface(x, z);
        if (y < 0.3) continue; // water
        const n = terrain.normalAt(x, z);
        if (n.y < 0.72 && Math.abs(y - terrain.heightAt(x, z)) < 0.2) continue;
        const p = new THREE.Vector3(x, y + 0.05, z);
        if (!free(p)) {
          // try small offsets
          let ok = false;
          for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
            const q = new THREE.Vector3(x + ox, surface(x + ox, z + oz) + 0.05, z + oz);
            if (q.y > 0.3 && free(q)) {
              p.copy(q);
              ok = true;
              break;
            }
          }
          if (!ok) continue;
        }
        this.add(p, false);
      }
    }
    for (const pt of points) if (free(pt)) this.add(pt.clone().setY(pt.y + 0.05), true);
    const hintIds: [number, number][] = [];
    for (const h of hints) {
      const a = this.add(h.a.clone().setY(h.a.y + 0.05), true);
      const b = this.add(h.b.clone().setY(h.b.y + 0.05), true);
      hintIds.push([a, b]);
      this.connect(a, b);
    }
    // connect neighbours with line-of-sight + walkability checks
    const up1 = new THREE.Vector3(0, 0.6, 0), up2 = new THREE.Vector3(0, 1.4, 0);
    for (const n of this.nodes) {
      for (const m of this.near(n.p, 11)) {
        if (m.id <= n.id || n.links.includes(m.id)) continue;
        const d = n.p.distanceTo(m.p);
        const dy = Math.abs(n.p.y - m.p.y);
        if (dy > Math.max(1.2, d * 0.6)) continue;
        if (!physics.lineOfSight(n.p.clone().add(up1), m.p.clone().add(up1))) continue;
        if (!physics.lineOfSight(n.p.clone().add(up2), m.p.clone().add(up2))) continue;
        // ground continuity: no water / big drops in between
        let ok = true;
        for (const t of [0.25, 0.5, 0.75]) {
          const q = n.p.clone().lerp(m.p, t);
          const s = surface(q.x, q.z);
          if (s < 0.25 || Math.abs(s - q.y) > 1.6) { ok = false; break; }
        }
        if (ok) this.connect(n.id, m.id);
      }
    }
    // cover estimation: count blocked directions
    for (const n of this.nodes) {
      let blocked = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        if (physics.raycast(n.p.clone().add(up2), dir, 6)) blocked++;
      }
      n.cover = 1 - blocked / 8;
    }
    // prune isolated nodes from the search set (keep ids stable)
    console.log(`[nav] ${this.nodes.length} nodes, ${this.nodes.reduce((a, n) => a + n.links.length, 0) / 2} links in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  /** numeric cell key (string keys allocated a string per lookup, thousands per frame) */
  private key(x: number, z: number) {
    return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096);
  }

  private add(p: THREE.Vector3, indoor: boolean) {
    // merge with very close nodes
    for (const m of this.near(p, 1.2)) if (Math.abs(m.p.y - p.y) < 0.6) return m.id;
    const id = this.nodes.length;
    this.nodes.push({ id, p, links: [], cover: 1, indoor });
    const k = this.key(p.x, p.z);
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k)!.push(id);
    return id;
  }

  private connect(a: number, b: number) {
    if (a === b) return;
    if (!this.nodes[a].links.includes(b)) this.nodes[a].links.push(b);
    if (!this.nodes[b].links.includes(a)) this.nodes[b].links.push(a);
  }

  near(p: THREE.Vector3, r: number): NavNode[] {
    const out: NavNode[] = [];
    const c = this.cell;
    const x0 = Math.floor((p.x - r) / c), x1 = Math.floor((p.x + r) / c);
    const z0 = Math.floor((p.z - r) / c), z1 = Math.floor((p.z + r) / c);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const ids = this.grid.get((x + 4096) * 8192 + (z + 4096));
        if (!ids) continue;
        const r2 = r * r;
        for (let k = 0; k < ids.length; k++) {
          const n = this.nodes[ids[k]];
          if (n.p.distanceToSquared(p) <= r2) out.push(n);
        }
      }
    return out;
  }

  nearest(p: THREE.Vector3, maxR = 30, requireLinks = true): NavNode | null {
    let best: NavNode | null = null;
    let bd = Infinity;
    for (let ri = 0; ri < 3; ri++) {
      const r = ri === 0 ? 8 : ri === 1 ? 16 : maxR;
      for (const n of this.near(p, r)) {
        if (requireLinks && n.links.length === 0) continue;
        const d = n.p.distanceToSquared(p) + Math.abs(n.p.y - p.y) * 20;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      if (best) return best;
    }
    return best;
  }

  randomNode(rng: () => number = Math.random): NavNode {
    for (let i = 0; i < 50; i++) {
      const n = this.nodes[Math.floor(rng() * this.nodes.length)];
      if (n.links.length > 1) return n;
    }
    return this.nodes[0];
  }

  /**
   * A* search; returns list of positions (excluding start).
   * Binary-heap open set (the old linear scan was O(n²) on long routes).
   * opts.noise / opts.seed: deterministic per-node cost jitter so different bots (and different
   * missions of the same bot) pick different but stable lanes; opts.avoid: soft repulsion points
   * (teammates' routes) to spread a squad over parallel paths.
   */
  path(from: THREE.Vector3, to: THREE.Vector3, maxIter = 6000, opts: { noise?: number; seed?: number; avoid?: THREE.Vector3[] } = {}): THREE.Vector3[] | null {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    if (s.id === g.id) return [to.clone()];
    const noise = opts.noise ?? 0, seed = opts.seed ?? 0, avoid = opts.avoid ?? [];
    const jitter = (id: number) => {
      if (!noise) return 1;
      const h = Math.sin(id * 12.9898 + seed * 78.233) * 43758.5453;
      return 1 + noise * (h - Math.floor(h));
    };
    // scratch state reused across searches (sized to the graph; a generation stamp marks which
    // entries belong to this search) — no Maps / Sets / swap arrays allocated per call: with 24
    // bots re-planning, A* was ~45 % of all garbage the game produced (→ GC pauses mid-fight)
    const N = this.nodes.length;
    if (this.sG.length < N) {
      this.sG = new Float64Array(N);
      this.sCame = new Int32Array(N);
      this.sSeen = new Uint32Array(N);
      this.sClosed = new Uint32Array(N);
    }
    const gen = ++this.sGen;
    const G = this.sG, came = this.sCame, seen = this.sSeen, closedA = this.sClosed;
    seen[s.id] = gen;
    G[s.id] = 0;
    came[s.id] = -1;
    // binary min-heap of (f, id) in growable typed arrays
    let heapF = this.hF, heapI = this.hI;
    let hn = 0;
    const push = (f: number, id: number) => {
      if (hn === heapF.length) {
        const nf = new Float64Array(hn * 2), ni = new Int32Array(hn * 2);
        nf.set(heapF);
        ni.set(heapI);
        heapF = this.hF = nf;
        heapI = this.hI = ni;
      }
      let i = hn++;
      heapF[i] = f;
      heapI[i] = id;
      while (i > 0) {
        const pnt = (i - 1) >> 1;
        if (heapF[pnt] <= heapF[i]) break;
        const tf = heapF[pnt], ti = heapI[pnt];
        heapF[pnt] = heapF[i]; heapI[pnt] = heapI[i];
        heapF[i] = tf; heapI[i] = ti;
        i = pnt;
      }
    };
    const pop = () => {
      const id = heapI[0];
      hn--;
      const lf = heapF[hn], li = heapI[hn];
      if (hn > 0) {
        heapF[0] = lf; heapI[0] = li;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < hn && heapF[l] < heapF[m]) m = l;
          if (r < hn && heapF[r] < heapF[m]) m = r;
          if (m === i) break;
          const tf = heapF[m], ti = heapI[m];
          heapF[m] = heapF[i]; heapI[m] = heapI[i];
          heapF[i] = tf; heapI[i] = ti;
          i = m;
        }
      }
      return id;
    };
    const gp = g.p;
    push(s.p.distanceTo(gp), s.id);
    let iter = 0;
    while (hn > 0 && iter++ < maxIter) {
      const cur = pop();
      if (closedA[cur] === gen) continue;
      if (cur === g.id) {
        const out: THREE.Vector3[] = [];
        let c = cur;
        while (c !== -1 && c !== s.id) {
          out.push(this.nodes[c].p.clone());
          c = came[c];
        }
        out.reverse();
        return out;
      }
      closedA[cur] = gen;
      const cn = this.nodes[cur];
      const cg = G[cur];
      const links = cn.links;
      for (let li = 0; li < links.length; li++) {
        const nid = links[li];
        if (closedA[nid] === gen) continue;
        const nn = this.nodes[nid];
        let cost = cn.p.distanceTo(nn.p) * (1 + nn.cover * 0.3) * jitter(nid);
        for (let ai = 0; ai < avoid.length; ai++) {
          const a = avoid[ai];
          const d2 = (a.x - nn.p.x) ** 2 + (a.z - nn.p.z) ** 2;
          if (d2 < 144) cost *= 1 + 0.8 * (1 - d2 / 144);
        }
        const tg = cg + cost;
        if (seen[nid] !== gen || tg < G[nid]) {
          seen[nid] = gen;
          came[nid] = cur;
          G[nid] = tg;
          push(tg + nn.p.distanceTo(gp), nid);
        }
      }
    }
    return null;
  }
}
