import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';
import { Buildings } from './Buildings';
import { Terrain } from './Terrain';
import { ROADS, LANDMARKS, LADDERS, TUNNEL, nearestRoad, coastX, PLAY_HALF } from './MapLayout';
import { RNG } from '../core/math';

/**
 * Set dressing & cover scattered over the whole map (all merged into the static world, with
 * colliders, so they block bullets and movement and the nav graph routes around them):
 *
 *  house yards   firewood stacks under a plank roof, wheelie bins, a mailbox at the road,
 *                benches, garden table & chairs, flower tubs, a garden shed, laundry poles
 *  roadsides     orange snow poles, road signs, a bus shelter, salt/grit bins, parked trailers
 *  harbour       stacked fish crates, rope coils, buoys, oil drums, cable drums, nets, tarp piles
 *  farmland      wrapped silage bales, a hay trailer, field gates and fences
 *  combat zones  around every landmark (flags spawn here): cover rings of crates, sandbag
 *                walls, concrete pipes, jersey barriers, ammo crate piles and wrecks
 *
 * Everything keeps clear of roads, doorways, ladders, building walls and the shoreline.
 */
export class Details {
  private rng = new RNG(4242);
  private placed: THREE.Vector3[] = [];
  private doors: THREE.Vector3[];

  constructor(private b: GeoBuilder, private bld: Buildings, private terrain: Terrain, private helpers: { sandbags: (x: number, z: number, r: number, l: number) => void; jersey: (x: number, y: number, z: number, r: number) => void; car: (x: number, y: number, z: number, r: number, paint: string, wreck?: boolean) => void }) {
    this.doors = bld.doors.map((d) => d.hinge.clone().addScaledVector(d.along, d.width / 2));
    this.yards();
    this.roadsides();
    this.harbour();
    this.farmland();
    this.poiProps();
    this.combatZones();
    // keep trees from growing through the props
    for (const p of this.placed) {
      if (p.y < 0.9) continue;
      const y = this.h(p.x, p.z);
      this.bld.footprints.push(new THREE.Box3(new THREE.Vector3(p.x - p.y, y - 1, p.z - p.y), new THREE.Vector3(p.x + p.y, y + 0.5, p.z + p.y)));
    }
  }

  private h(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }

  /** Free ground for a prop of radius r: dry, off roads, clear of buildings, doors, ladders and other props. */
  private ok(x: number, z: number, r = 1, roadMargin = 1.2, bldMargin = 1.0) {
    if (Math.abs(x) > PLAY_HALF - 6 || Math.abs(z) > PLAY_HALF - 6) return false;
    const y = this.h(x, z);
    if (y < 1.1 || x < coastX(z) + 2) return false;
    // the tunnel is dressed by Infrastructure (and the terrain under the ridge cap is carved)
    if (Math.abs(x - TUNNEL.x) < TUNNEL.width / 2 + 8 && z > TUNNEL.z0 - 6 && z < TUNNEL.z1 + 6) return false;
    const n = this.terrain.normalAt(x, z);
    if (n.y < 0.9) return false;
    const rd = nearestRoad(x, z);
    if (rd.d < rd.road.width / 2 + roadMargin + r) return false;
    if (this.bld.footprints.some((f) => x > f.min.x - bldMargin - r && x < f.max.x + bldMargin + r && z > f.min.z - bldMargin - r && z < f.max.z + bldMargin + r && y < f.max.y + 1)) return false;
    for (const d of this.doors) if (Math.hypot(d.x - x, d.z - z) < 3 + r) return false;
    for (const l of LADDERS) if (Math.hypot(l.x - x, l.z - z) < 2.2 + r) return false;
    for (const p of this.placed) if (Math.hypot(p.x - x, p.z - z) < r + p.y) return false;
    return true;
  }
  private mark(x: number, z: number, r: number) {
    this.placed.push(new THREE.Vector3(x, r, z)); // y holds the radius
  }

  // ------------------------------------------------------------------ prop builders (local frame)
  private at(x: number, z: number, yaw: number, fn: (y: number) => void) {
    const y = this.h(x, z);
    this.b.push([x, y, z], yaw);
    fn(y);
    this.b.pop();
  }
  private lyingCyl(mat: string, r: number, len: number, x: number, y: number, z: number, collide: 'wood' | 'concrete' | 'metal' | 'fabric' | null, axis: 'x' | 'z' = 'x') {
    const g = new THREE.CylinderGeometry(r, r, len, 14);
    g.rotateZ(Math.PI / 2);
    if (axis === 'z') g.rotateY(Math.PI / 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * len);
    this.b.addGeo(mat, g, new THREE.Matrix4().setPosition(x, y, z));
    if (collide) this.b.box(null, axis === 'x' ? x - len / 2 : x - r, y - r, axis === 'x' ? z - r : z - len / 2, axis === 'x' ? x + len / 2 : x + r, y + r, axis === 'x' ? z + r : z + len / 2, collide);
  }
  private crates(n: number) {
    const sizes = [0.9, 0.75, 1.1];
    for (let i = 0; i < n; i++) {
      const s = this.rng.pick(sizes);
      const x = (i % 2) * 1.05 - 0.5 + this.rng.range(-0.08, 0.08), z = Math.floor(i / 2) * 1.1 + this.rng.range(-0.08, 0.08);
      this.b.box('crate', x - s / 2, 0, z - s / 2, x + s / 2, s, z + s / 2, 'wood');
      if (this.rng.chance(0.45)) {
        const s2 = s * 0.8;
        this.b.box('crate', x - s2 / 2, s, z - s2 / 2, x + s2 / 2, s + s2, z + s2 / 2, 'wood', undefined, new THREE.Euler(0, this.rng.range(-0.3, 0.3), 0));
      }
    }
  }
  private barrels(n: number) {
    const mats = ['redSteel', 'contBlue', 'yellowSteel', 'rust', 'contGreen'];
    const m = this.rng.pick(mats);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.cos(a) * 0.45 * (n > 1 ? 1 : 0), z = Math.sin(a) * 0.45 * (n > 1 ? 1 : 0);
      if (this.rng.chance(0.15)) this.lyingCyl(m, 0.29, 0.88, x, 0.29, z + 0.9, 'metal');
      // standing drums are destructible (Destruction): shot through they topple, red fuel drums burn and blow
      else this.b.destructible('barrel', new THREE.Matrix4().setPosition(x, 0, z), { mat: this.rng.chance(0.7) ? m : this.rng.pick(mats) });
    }
  }
  private fishCrates(piles: number) {
    for (let p = 0; p < piles; p++) {
      const px = (p % 3) * 0.95, pz = Math.floor(p / 3) * 0.7;
      const hgt = this.rng.int(1, 5);
      const mat = this.rng.chance(0.6) ? 'fishCrate' : 'fishCrateRed';
      for (let k = 0; k < hgt; k++) this.b.box(mat, px - 0.4, k * 0.31, pz - 0.27, px + 0.4, k * 0.31 + 0.3, pz + 0.27, k === hgt - 1 ? null : null);
      this.b.box(null, px - 0.4, 0, pz - 0.27, px + 0.4, hgt * 0.31, pz + 0.27, 'wood', { penetrable: 0.8 });
    }
  }
  private firewood() {
    // split logs stacked between posts, with a little plank roof
    this.b.box('woodRaw', -1.3, 0, -0.3, 1.3, 1.25, 0.3, 'wood');
    for (let r = 0; r < 4; r++) for (let i = 0; i < 9; i++) {
      this.b.cyl('bark', -1.15 + i * 0.29 + (r % 2) * 0.12, 0.05 + r * 0.29, 0.31, 0.11, 0.02, 8);
    }
    for (const sx of [-1.4, 1.4]) this.b.box('wood', sx - 0.06, 0, -0.36, sx + 0.06, 1.55, 0.36);
    this.b.obox('planks', [0, 1.6, 0], [3.1, 0.06, 0.95], new THREE.Euler(0.18, 0, 0));
  }
  private bin() {
    const m = this.rng.pick(['contGreen', 'contGrey', 'contBlue']);
    this.b.box(m, -0.3, 0, -0.33, 0.3, 1.0, 0.33, 'metal');
    this.b.box(m, -0.32, 1.0, -0.36, 0.32, 1.06, 0.36);
    this.b.cyl('tyre', -0.22, 0.0, 0.36, 0.08, 0.04, 8);
    this.b.cyl('tyre', 0.22, 0.0, 0.36, 0.08, 0.04, 8);
  }
  private mailbox() {
    this.b.box('woodRaw', -0.04, 0, -0.04, 0.04, 1.05, 0.04);
    this.b.box(this.rng.pick(['redSteel', 'contGreen', 'white']), -0.16, 1.05, -0.22, 0.16, 1.3, 0.22);
    this.b.box('dkgrey', -0.17, 1.28, -0.23, 0.17, 1.32, 0.23);
  }
  private bench() {
    this.b.box('wood', -0.8, 0.42, -0.2, 0.8, 0.47, 0.2, 'wood');
    this.b.box('wood', -0.8, 0.5, 0.17, 0.8, 0.85, 0.22);
    for (const sx of [-0.7, 0.7]) this.b.box('dkgrey', sx - 0.03, 0, -0.2, sx + 0.03, 0.42, 0.2);
  }
  private gardenSet() {
    this.b.cyl('white', 0, 0, 0, 0.04, 0.7, 8);
    this.b.cyl('white', 0, 0.7, 0, 0.45, 0.03, 16, 'wood');
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      this.b.push([Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75], -a + Math.PI / 2);
      this.b.box('white', -0.22, 0.42, -0.22, 0.22, 0.46, 0.22);
      this.b.box('white', -0.22, 0.46, 0.18, 0.22, 0.85, 0.22);
      for (const sx of [-0.19, 0.19]) for (const sz of [-0.19, 0.19]) this.b.box('white', sx - 0.015, 0, sz - 0.015, sx + 0.015, 0.42, sz + 0.015);
      this.b.pop();
    }
  }
  private planter() {
    this.b.box('woodRaw', -0.5, 0, -0.5, 0.5, 0.45, 0.5, 'wood');
    this.b.box('dirtRoad', -0.45, 0.4, -0.45, 0.45, 0.44, 0.45);
    this.b.cyl('plant', 0, 0.44, 0, 0.32, 0.35, 8, null, 0.15);
  }
  private shed() {
    // small garden/boat shed: solid, full cover
    this.b.box(this.rng.pick(['red', 'white', 'ochre']), -1.2, 0, -1.0, 1.2, 2.1, 1.0, 'wood');
    this.b.box('trim', -0.45, 0, 1.0, 0.45, 1.9, 1.04);
    this.b.obox('roofMetal', [0, 2.35, -0.55], [2.7, 0.08, 1.3], new THREE.Euler(-0.42, 0, 0), 'metal');
    this.b.obox('roofMetal', [0, 2.35, 0.55], [2.7, 0.08, 1.3], new THREE.Euler(0.42, 0, 0), 'metal');
    this.b.box('red', -1.2, 2.1, -0.2, 1.2, 2.55, 0.2);
  }
  private laundry() {
    for (const sx of [-1.6, 1.6]) {
      this.b.box('white', sx - 0.03, 0, -0.03, sx + 0.03, 1.8, 0.03);
      this.b.box('white', sx - 0.03, 1.74, -0.5, sx + 0.03, 1.8, 0.5);
    }
    const cols = ['white', 'red', 'signBlue', 'ochre'];
    for (let i = 0; i < 4; i++) this.b.box(this.rng.pick(cols), -1.2 + i * 0.6, 1.2, -0.35 + (i % 2) * 0.7, -0.8 + i * 0.6, 1.75, -0.33 + (i % 2) * 0.7);
  }
  private snowPole() {
    this.b.box('snowPole', -0.02, 0, -0.02, 0.02, 1.7, 0.02);
    this.b.box('white', -0.021, 1.2, -0.021, 0.021, 1.35, 0.021);
  }
  private roadSign() {
    this.b.box('steel', -0.03, 0, -0.03, 0.03, 2.3, 0.03);
    if (this.rng.chance(0.5)) this.b.box('signBlue', -0.35, 1.8, -0.02, 0.35, 2.3, 0.0);
    else {
      const tri = new THREE.CylinderGeometry(0.42, 0.42, 0.02, 3);
      tri.rotateX(Math.PI / 2);
      tri.rotateZ(Math.PI / 2);
      this.b.addGeo('red', tri, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 2.0, 0.0));
    }
  }
  private busShelter() {
    this.b.box('dkgrey', -1.6, 0, -0.65, 1.6, 0.1, 0.65, 'concrete');
    this.b.box('glass', -1.5, 0.1, -0.62, 1.5, 2.2, -0.58, 'glass', { penetrable: 1 });
    for (const sx of [-1.5, 1.5]) this.b.box('glass', sx - 0.02, 0.1, -0.6, sx + 0.02, 2.2, 0.55, 'glass', { penetrable: 1 });
    this.b.box('roofMetal', -1.7, 2.2, -0.75, 1.7, 2.3, 0.75, 'metal');
    this.b.box('wood', -1.2, 0.45, -0.55, 1.2, 0.5, -0.25);
    for (const sx of [-1.5, 1.5]) for (const sz of [-0.6, 0.55]) this.b.box('steel', sx - 0.04, 0.1, sz - 0.04, sx + 0.04, 2.2, sz + 0.04);
  }
  private gritBin() {
    this.b.box('yellowSteel', -0.5, 0, -0.35, 0.5, 0.75, 0.35, 'metal');
    this.b.obox('yellowSteel', [0, 0.82, 0], [1.05, 0.08, 0.75], new THREE.Euler(0.12, 0, 0));
  }
  private trailer() {
    this.b.box(this.rng.pick(['redSteel', 'contGrey', 'contGreen']), -1.3, 0.45, -0.8, 1.3, 0.55, 0.8, 'metal');
    for (const sx of [-1.3, 1.3]) this.b.box('dkgrey', sx - 0.03, 0.55, -0.8, sx + 0.03, 0.95, 0.8, 'metal');
    for (const sz of [-0.8, 0.8]) this.b.box('dkgrey', -1.3, 0.55, sz - 0.03, 1.3, 0.95, sz + 0.03, 'metal');
    for (const sz of [-0.85, 0.85]) this.lyingCyl('tyre', 0.3, 0.18, 0, 0.3, sz, null, 'z');
    this.b.box('dkgrey', 1.3, 0.4, -0.05, 2.2, 0.47, 0.05);
    if (this.rng.chance(0.6)) this.b.box('tarp' in this.b.mats ? 'tarp' : 'fabric', -1.25, 0.55, -0.75, 1.25, 1.1, 0.75);
  }
  private ropeCoil() {
    const g = new THREE.TorusGeometry(0.3, 0.07, 6, 16);
    g.rotateX(Math.PI / 2);
    for (let k = 0; k < 3; k++) this.b.addGeo('rope', g.clone(), new THREE.Matrix4().setPosition(0, 0.07 + k * 0.12, 0));
  }
  private buoys(n: number) {
    for (let i = 0; i < n; i++) {
      const g = new THREE.SphereGeometry(0.28, 12, 8);
      this.b.addGeo('buoy', g, new THREE.Matrix4().setPosition(this.rng.range(-0.6, 0.6), 0.28 + (i > 2 ? 0.45 : 0), this.rng.range(-0.6, 0.6)));
    }
    this.b.box(null, -0.8, 0, -0.8, 0.8, 0.8, 0.8, 'fabric', { penetrable: 1 });
  }
  private netPile() {
    this.b.obox('net', [0, 0.3, 0], [2.0, 0.6, 1.4], new THREE.Euler(0, 0, 0.05), 'fabric');
    this.b.obox('net', [0.3, 0.75, 0.1], [1.2, 0.4, 0.9], new THREE.Euler(0.1, 0.4, 0));
    this.buoysSmall();
  }
  private buoysSmall() {
    for (let i = 0; i < 4; i++) this.b.addGeo('buoy', new THREE.SphereGeometry(0.12, 8, 6), new THREE.Matrix4().setPosition(this.rng.range(-0.9, 0.9), 0.62, this.rng.range(-0.6, 0.6)));
  }
  private cableDrum() {
    this.lyingCyl('woodRaw', 0.75, 0.12, -0.4, 0.75, 0, 'wood');
    this.lyingCyl('woodRaw', 0.75, 0.12, 0.4, 0.75, 0, 'wood');
    this.lyingCyl('dkgrey', 0.45, 0.7, 0, 0.75, 0, 'wood');
  }
  private tarpPile() {
    this.b.obox('fabric', [0, 0.55, 0], [2.2, 1.1, 1.6], new THREE.Euler(0, 0, 0.03), 'fabric');
    this.b.obox('fabric', [0.2, 1.15, -0.1], [1.6, 0.3, 1.2], new THREE.Euler(0.08, 0.2, 0.04));
    for (const sx of [-0.9, 0.9]) this.b.box('rope', sx - 0.02, 0, -0.82, sx + 0.02, 1.15, 0.82);
  }
  private bale(standing: boolean) {
    if (standing) this.b.cyl('wrap', 0, 0, 0, 0.75, 1.2, 16, 'fabric');
    else this.lyingCyl('wrap', 0.75, 1.2, 0, 0.75, 0, 'fabric');
  }
  private fence(len: number) {
    // post-and-rail fence, destructible section by section (Destruction)
    this.b.destructible('fence', new THREE.Matrix4(), { x0: -len / 2, x1: len / 2, z: 0, style: 'rail' });
  }
  private concretePipe() {
    this.lyingCyl('concrete', 0.62, 2.3, 0, 0.62, 0, 'concrete', 'z');
    this.b.cyl('dkgrey', 0, 0.2, 1.16, 0.45, 0.02, 14);
  }
  private ammoCrates() {
    for (let i = 0; i < this.rng.int(2, 5); i++) {
      const x = this.rng.range(-0.6, 0.6), z = this.rng.range(-0.4, 0.4), k = i > 2 ? 0.32 : 0;
      this.b.box('od' in this.b.mats ? 'od' : 'contGreen', x - 0.4, k, z - 0.2, x + 0.4, k + 0.32, z + 0.2, 'wood', undefined, new THREE.Euler(0, this.rng.range(-0.4, 0.4), 0));
    }
  }

  // ------------------------------------------------------------------ placement passes
  private yards() {
    for (const f of this.bld.footprints) {
      const sx = f.max.x - f.min.x, sz = f.max.z - f.min.z;
      if (sx > 30 || sz > 30 || sx < 4) continue; // houses & small buildings only
      const cx = (f.min.x + f.max.x) / 2, cz = (f.min.z + f.max.z) / 2;
      const n = this.rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        // a spot just outside one of the walls
        for (let tries = 0; tries < 8; tries++) {
          const side = this.rng.int(0, 3);
          const off = 2.2 + this.rng.range(0, 3);
          const x = side === 0 ? f.min.x - off : side === 1 ? f.max.x + off : this.rng.range(f.min.x, f.max.x);
          const z = side === 2 ? f.min.z - off : side === 3 ? f.max.z + off : this.rng.range(f.min.z, f.max.z);
          const kind = this.rng.pick(['firewood', 'bin', 'bench', 'garden', 'planter', 'shed', 'laundry', 'bin', 'firewood'] as const);
          const r = kind === 'shed' ? 1.8 : kind === 'firewood' || kind === 'laundry' ? 1.7 : 1;
          if (!this.ok(x, z, r, 1.5, 0.6)) continue;
          // face away from the house wall
          const yaw = Math.atan2(x - cx, z - cz) + (kind === 'firewood' || kind === 'shed' ? Math.PI : 0);
          this.at(x, z, yaw, () => {
            if (kind === 'firewood') this.firewood();
            else if (kind === 'bin') this.bin();
            else if (kind === 'bench') this.bench();
            else if (kind === 'garden') this.gardenSet();
            else if (kind === 'planter') this.planter();
            else if (kind === 'shed') this.shed();
            else this.laundry();
          });
          this.mark(x, z, r);
          if (kind === 'shed') this.bld.footprints.push(new THREE.Box3(new THREE.Vector3(x - 1.5, this.h(x, z) - 1, z - 1.5), new THREE.Vector3(x + 1.5, this.h(x, z) + 3, z + 1.5)));
          break;
        }
      }
      // mailbox at the roadside nearest the house
      const rd = nearestRoad(cx, cz);
      if (rd.d < 30) {
        const r = rd.road, i = rd.seg;
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const px = ax + (bx - ax) * rd.t, pz = az + (bz - az) * rd.t;
        const dx = cx - px, dz = cz - pz, dl = Math.hypot(dx, dz) || 1;
        const mx = px + (dx / dl) * (r.width / 2 + 0.9), mz = pz + (dz / dl) * (r.width / 2 + 0.9);
        if (this.ok(mx, mz, 0.3, -0.2, 0.5)) {
          this.at(mx, mz, Math.atan2(dx, dz), () => this.mailbox());
          this.mark(mx, mz, 0.4);
        }
      }
    }
  }

  private roadsides() {
    for (const r of ROADS) {
      let acc = 0;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        for (let s = 0; s < L; s += 6) {
          acc += 6;
          const x0 = ax + tx * s, z0 = az + tz * s;
          for (const side of [-1, 1]) {
            const nx = -tz * side, nz = tx * side;
            const ex = x0 + nx * (r.width / 2 + 0.7), ez = z0 + nz * (r.width / 2 + 0.7);
            // snow poles every ~24 m on the outside of the road
            if (acc % 24 < 6 && r.kind !== 'dirt' && this.ok(ex, ez, 0.1, -0.5, 0.4)) {
              this.at(ex, ez, 0, () => this.snowPole());
            } else if (this.rng.chance(0.035)) {
              const kind = this.rng.pick(['sign', 'grit', 'trailer', 'shelter', 'barrels', 'crates'] as const);
              const off = kind === 'trailer' || kind === 'shelter' ? 2.4 : kind === 'sign' ? 0.9 : 1.8;
              const px = x0 + nx * (r.width / 2 + off), pz = z0 + nz * (r.width / 2 + off);
              const rad = kind === 'trailer' || kind === 'shelter' ? 2.2 : 1;
              if (!this.ok(px, pz, rad, kind === 'sign' ? -0.6 : 0.2, 0.6)) continue;
              const yaw = Math.atan2(tx, tz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
              this.at(px, pz, yaw, () => {
                if (kind === 'sign') this.roadSign();
                else if (kind === 'grit') this.gritBin();
                else if (kind === 'trailer') this.trailer();
                else if (kind === 'shelter') this.busShelter();
                else if (kind === 'barrels') this.barrels(this.rng.int(2, 4));
                else this.crates(this.rng.int(1, 3));
              });
              this.mark(px, pz, rad);
            }
          }
        }
      }
    }
  }

  private harbour() {
    for (let i = 0; i < 70; i++) {
      const x = this.rng.range(-90, 85), z = this.rng.range(100, 182);
      const kind = this.rng.pick(['fish', 'fish', 'rope', 'buoys', 'barrels', 'drum', 'net', 'tarp', 'crates', 'pallets'] as const);
      const r = kind === 'net' || kind === 'tarp' ? 1.6 : kind === 'fish' || kind === 'crates' ? 1.5 : 1;
      if (!this.ok(x, z, r, 1.2, 1.2)) continue;
      this.at(x, z, this.rng.range(0, Math.PI * 2), () => {
        if (kind === 'fish') this.fishCrates(this.rng.int(2, 6));
        else if (kind === 'rope') this.ropeCoil();
        else if (kind === 'buoys') this.buoys(this.rng.int(3, 6));
        else if (kind === 'barrels') this.barrels(this.rng.int(2, 5));
        else if (kind === 'drum') this.cableDrum();
        else if (kind === 'net') this.netPile();
        else if (kind === 'tarp') this.tarpPile();
        else if (kind === 'crates') this.crates(this.rng.int(2, 4));
        else {
          for (let k = 0; k < this.rng.int(2, 6); k++) this.b.box('pallet', -0.6, k * 0.15, -0.5, 0.6, k * 0.15 + 0.14, 0.5, 'wood');
        }
      });
      this.mark(x, z, r);
    }
  }

  private farmland() {
    // silage bales and fences on the open grass around the farm and the ridge
    const fields: [number, number, number][] = [[104, 18, 40], [70, 80, 45], [130, 60, 35], [60, -20, 35], [120, -30, 30]];
    for (const [fx, fz, R] of fields) {
      for (let i = 0; i < 14; i++) {
        const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(8, R);
        const x = fx + Math.cos(a) * d, z = fz + Math.sin(a) * d;
        if (this.terrain.surfaceAt(x, z) !== 'grass' && this.terrain.surfaceAt(x, z) !== 'snow') continue;
        const kind = this.rng.chance(0.7) ? 'bales' : this.rng.chance(0.5) ? 'fence' : 'trailer';
        const r = kind === 'bales' ? 2.2 : kind === 'fence' ? 4 : 2.4;
        if (!this.ok(x, z, r, 1.5, 2)) continue;
        this.at(x, z, this.rng.range(0, Math.PI), () => {
          if (kind === 'bales') {
            const n = this.rng.int(1, 4);
            for (let k = 0; k < n; k++) {
              this.b.push([k * 1.6 - (n - 1) * 0.8, 0, this.rng.range(-0.3, 0.3)], this.rng.range(-0.2, 0.2));
              this.bale(this.rng.chance(0.4));
              this.b.pop();
            }
          } else if (kind === 'fence') this.fence(8);
          else this.trailer();
        });
        this.mark(x, z, r);
      }
    }
  }


  /** A stack of felled logs (solid cover), lying along the local x axis. */
  private logPile() {
    const len = this.rng.range(4, 6.5);
    const rows = this.rng.int(2, 3);
    let y = 0.22;
    for (let r = 0; r < rows; r++) {
      const n = 4 - r;
      for (let i = 0; i < n; i++) this.lyingCyl('bark', 0.21, len + this.rng.range(-0.3, 0.3), 0, y, (i - (n - 1) / 2) * 0.43, null);
      y += 0.37;
    }
    this.b.box(null, -len / 2, 0, -0.9, len / 2, y - 0.1, 0.9, 'wood');
  }

  /**
   * Themed dressing for each outlying point of interest (on top of the cover ring every landmark
   * gets): what makes the place read as what it is, and gives a fight there real cover.
   */
  private poiProps() {
    const L = (name: string) => LANDMARKS.find((l) => l.name === name);
    const scatter = (name: string, n: number, r0: number, r1: number, place: (x: number, z: number, yaw: number) => boolean) => {
      const l = L(name);
      if (!l) return;
      let placed = 0;
      for (let tries = 0; tries < n * 6 && placed < n; tries++) {
        const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(r0, r1);
        const x = l.x + Math.cos(a) * d, z = l.z + Math.sin(a) * d;
        if (place(x, z, Math.atan2(l.x - x, l.z - z))) placed++;
      }
    };
    // (a wide berth round every building: doorless entrances (barracks, bunkers) stay clear)
    const put = (r: number, fn: () => void) => (x: number, z: number, yaw: number) => {
      if (!this.ok(x, z, r, 1.4, 3.5)) return false;
      this.at(x, z, yaw + this.rng.range(-0.5, 0.5), fn);
      this.mark(x, z, r);
      return true;
    };
    const bags = (r: number) => (x: number, z: number, yaw: number) => {
      if (!this.ok(x, z, r, 1.4, 3.5)) return false;
      this.helpers.sandbags(x, z, yaw + Math.PI / 2, this.rng.int(3, 6));
      this.mark(x, z, r);
      return true;
    };
    // logging camp: log piles, firewood stacks, a cable drum, a trailer
    scatter('Skogen', 9, 6, 30, put(3.6, () => this.logPile()));
    scatter('Skogen', 3, 4, 22, put(1.4, () => this.firewood()));
    scatter('Skogen', 2, 6, 24, put(2.6, () => this.trailer()));
    // army camp: sandbag positions facing out, ammo, barrels, crates, a few barriers
    scatter('Leiren', 8, 10, 30, bags(2.4));
    scatter('Leiren', 5, 4, 24, put(1.6, () => this.ammoCrates()));
    scatter('Leiren', 4, 6, 26, put(1.6, () => this.crates(this.rng.int(2, 4))));
    scatter('Leiren', 3, 8, 26, put(1.4, () => this.barrels(this.rng.int(3, 5))));
    // lighthouse: nets, buoys, fish crates on the rocks
    scatter('Fyret', 3, 4, 18, put(1.6, () => this.netPile()));
    scatter('Fyret', 3, 4, 20, put(1.4, () => this.buoys(this.rng.int(3, 5))));
    scatter('Fyret', 2, 6, 22, put(1.6, () => this.fishCrates(2)));
    // radar station: cable drums, barriers, crates
    scatter('Radaren', 4, 6, 26, put(1.8, () => this.cableDrum()));
    scatter('Radaren', 4, 8, 26, put(1.6, () => this.crates(this.rng.int(2, 3))));
    scatter('Radaren', 4, 10, 28, bags(2.4));
    // holiday cabins: firewood, garden sets, a shed, benches
    scatter('Hyttefeltet', 5, 4, 28, put(1.4, () => this.firewood()));
    scatter('Hyttefeltet', 3, 4, 26, put(2.0, () => this.gardenSet()));
    scatter('Hyttefeltet', 2, 8, 28, put(2.2, () => this.shed()));
    scatter('Hyttefeltet', 3, 4, 28, put(1.4, () => this.bench()));
    // the pass and the ridge: dug-in positions and crates in the rocks
    scatter('Skaret', 5, 6, 22, bags(2.4));
    scatter('Skaret', 3, 4, 18, put(1.6, () => this.crates(2)));
    scatter('Ryggen', 5, 6, 24, bags(2.4));
    scatter('Ryggen', 2, 4, 18, put(1.8, () => this.cableDrum()));
    // farm: more bales and a trailer between the barns
    scatter('Låven', 6, 6, 26, put(1.4, () => this.bale(this.rng.chance(0.4))));
    scatter('Låven', 1, 8, 20, put(2.6, () => this.trailer()));
    // bridge: checkpoints at both ends
    for (const z of [-60, -101]) {
      for (const sx of [-1, 1]) if (this.ok(sx * 5.2, z, 1.6, 0.3, 1)) {
        this.helpers.jersey(sx * 5.2, this.h(sx * 5.2, z), z, 0);
        this.mark(sx * 5.2, z, 1.6);
      }
      if (this.ok(7.5, z + 3, 2.4, 0.5, 1)) {
        this.helpers.sandbags(7.5, z + 3, 0, 4);
        this.mark(7.5, z + 3, 2.4);
      }
    }
  }

  private combatZones() {
    // every landmark (flags are picked from these) gets a ring of hard cover around its centre
    for (const l of LANDMARKS) {
      const n = Math.round(4 + l.r / 10);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
        const d = this.rng.range(8, Math.min(26, l.r * 0.8 + 8));
        const x = l.x + Math.cos(a) * d, z = l.z + Math.sin(a) * d;
        const kind = this.rng.pick(['crates', 'sandbags', 'pipe', 'jersey', 'ammo', 'barrels', 'wreck', 'crates'] as const);
        const r = kind === 'wreck' ? 2.8 : kind === 'sandbags' ? 2.2 : 1.6;
        if (!this.ok(x, z, r, 1.4, 1.2)) continue;
        // face the centre so the cover is useful for fighting over the point
        const yaw = Math.atan2(l.x - x, l.z - z);
        if (kind === 'sandbags') this.helpers.sandbags(x, z, yaw + Math.PI / 2, this.rng.int(3, 5));
        else if (kind === 'jersey') {
          const y = this.h(x, z);
          this.helpers.jersey(x, y, z, yaw + Math.PI / 2);
          if (this.rng.chance(0.5)) this.helpers.jersey(x + Math.cos(yaw) * 2.1, this.h(x + Math.cos(yaw) * 2.1, z - Math.sin(yaw) * 2.1), z - Math.sin(yaw) * 2.1, yaw + Math.PI / 2 + 0.15);
        } else if (kind === 'wreck') this.helpers.car(x, this.h(x, z), z, yaw + 1.3, 'carBurnt', true);
        else
          this.at(x, z, yaw, () => {
            if (kind === 'crates') this.crates(this.rng.int(2, 4));
            else if (kind === 'pipe') this.concretePipe();
            else if (kind === 'ammo') this.ammoCrates();
            else this.barrels(this.rng.int(3, 5));
          });
        this.mark(x, z, r);
      }
    }
  }
}
