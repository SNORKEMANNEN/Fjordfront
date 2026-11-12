import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';
import { BuildingDef, BUILDINGS, SEA_LEVEL, LADDERS } from './MapLayout';
import { Physics } from '../core/Physics';
import { RNG } from '../core/math';

export interface NavHint { a: THREE.Vector3; b: THREE.Vector3 } // explicit links (doorways)
export interface CoverPoint { p: THREE.Vector3; n: THREE.Vector3 }

type Op = { x: number; w: number; y0: number; y1: number };

export { GlassPanes } from './Glass';
import { GlassPanes } from './Glass';

export class Buildings {
  nav: NavHint[] = [];
  navPoints: THREE.Vector3[] = [];
  /** Every window (world centre, outward normal, size) — used for sun shafts. */
  windows: { c: THREE.Vector3; n: THREE.Vector3; w: number; h: number; pane: number; bars: number[]; broken: boolean }[] = [];
  /** Interior light fixtures (world position, colour, strength). */
  /** light fixtures; `cover` is the emissive part's box (fixture-local min/max under matrix m) for shooting it out */
  /** chimney tops (world) for the ambient smoke */
  chimneys: THREE.Vector3[] = [];
  fixtures: { p: THREE.Vector3; color: number; intensity: number; dist: number; m?: THREE.Matrix4; min?: THREE.Vector3; max?: THREE.Vector3; flicker?: 'fluoro' | 'old' | 'beacon' }[] = [];
  glass: GlassPanes;
  /** Footprints (world space AABB of each building) for vegetation/placement exclusion. */
  footprints: THREE.Box3[] = [];
  private b: GeoBuilder;
  get doors() {
    return this.b.doors;
  }
  get materials() {
    return this.b.mats;
  }

  constructor(private physics: Physics, mats: Record<string, THREE.Material>, private heightAt: (x: number, z: number) => number, parent: THREE.Object3D) {
    this.b = new GeoBuilder(physics, mats);
    this.glass = new GlassPanes(mats.glass);
    this.glass.initFrames(mats.trim ?? mats.glass);
    parent.add(this.glass.mesh);
    for (const def of BUILDINGS) {
      const y = def.padY ?? heightAt(def.x, def.z);
      this.b.push([def.x, y, def.z], def.rot);
      const before = this.navPoints.length;
      switch (def.kind) {
        case 'house': this.house(def); break;
        case 'rorbu': this.rorbu(def); break;
        case 'church': this.church(def); break;
        case 'shop': this.shop(def); break;
        case 'warehouse': this.warehouse(def); break;
        case 'containers': this.containers(def); break;
        case 'crane': this.crane(); break;
        case 'office': this.office(def); break;
        case 'bunker': this.bunker(def); break;
        case 'gunpit': this.gunpit(); break;
        case 'barracks': this.barracks(def); break;
        case 'mast': this.mast(); break;
        case 'barn': this.barn(def); break;
        case 'naust': this.naust(def); break;
        case 'tanks': this.tanks(); break;
        case 'hjell': this.hjell(); break;
        case 'lighthouse': this.lighthouse(); break;
        case 'tower': this.tower(); break;
        case 'radome': this.radome(); break;
      }
      void before;
      this.b.pop();
      const KIND_R: Record<string, number> = { containers: 17, crane: 13, tanks: 20, church: 14, warehouse: 0, mast: 5, gunpit: 7, hjell: 8, lighthouse: 5, tower: 3, radome: 7 };
      const r = KIND_R[def.kind] || Math.max(def.w ?? 8, def.d ?? 8) * 0.75 + 2;
      this.footprints.push(new THREE.Box3(new THREE.Vector3(def.x - r, y - 5, def.z - r), new THREE.Vector3(def.x + r, y + 30, def.z + r)));
    }
  }

  get builder() {
    return this.b;
  }

  /** Record a nav link between two local points (converted to world). */
  private link(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const m = this.b.m;
    const a = new THREE.Vector3(ax, ay, az).applyMatrix4(m);
    const c = new THREE.Vector3(bx, by, bz).applyMatrix4(m);
    this.nav.push({ a, b: c });
  }
  private point(x: number, y: number, z: number) {
    this.navPoints.push(new THREE.Vector3(x, y, z).applyMatrix4(this.b.m));
  }

  // ---------------------------------------------------------------- helpers
  private windowFrame(x: number, y0: number, y1: number, w: number, z: number, outward: number, glass: boolean, mullion = true) {
    const b = this.b;
    const tw = 0.075, td = 0.05;
    const zo = z + outward * 0.02;
    const zz = (a: number, c: number) => [Math.min(zo + a * outward, zo + c * outward), Math.max(zo + a * outward, zo + c * outward)];
    const [za, zb] = zz(0, td);
    b.box('trim', x - w / 2 - tw, y1, za, x + w / 2 + tw, y1 + tw * 1.4, zb); // head
    // drip cap over the head (throws rain clear of the window)
    const [dza, dzb] = zz(0, td + 0.05);
    b.box('trim', x - w / 2 - tw - 0.03, y1 + tw * 1.4, dza, x + w / 2 + tw + 0.03, y1 + tw * 1.4 + 0.035, dzb);
    b.box('trim', x - w / 2 - tw, y0 - tw, za, x + w / 2 + tw, y0, zb + outward * 0.04); // sill
    // reveal: the opening lined through the wall's depth, so windows sit in the wall, not on it
    {
      const [ra, rb] = [Math.min(z, z - outward * 0.15), Math.max(z, z - outward * 0.15)];
      b.box('trim', x - w / 2 - 0.02, y0, ra, x - w / 2, y1, rb);
      b.box('trim', x + w / 2, y0, ra, x + w / 2 + 0.02, y1, rb);
      b.box('trim', x - w / 2, y1 - 0.02, ra, x + w / 2, y1, rb);
      b.box('trim', x - w / 2, y0, ra, x + w / 2, y0 + 0.02, rb);
    }
    b.box('trim', x - w / 2 - tw, y0, za, x - w / 2, y1, zb);
    b.box('trim', x + w / 2, y0, za, x + w / 2 + tw, y1, zb);
    // the cross bars are separate, breakable instances (someone diving through takes them out)
    const bars: number[] = [];
    if (mullion) {
      const bar = (cx: number, cy: number, sx: number, sy: number) =>
        bars.push(this.glass.addFrame(this.b.m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, 0.06)))));
      bar(x, (y0 + y1) / 2, 0.05, y1 - y0);
      bar(x, (y0 + y1) / 2 + 0.1, w, 0.05);
    }
    let pane = -1;
    if (glass) {
      const wm = this.b.m.clone().multiply(new THREE.Matrix4().setPosition(x, (y0 + y1) / 2, z));
      pane = this.glass.add(this.physics, wm, w - 0.02, y1 - y0 - 0.02);
    }
    this.windows.push({
      c: new THREE.Vector3(x, (y0 + y1) / 2, z).applyMatrix4(this.b.m),
      n: new THREE.Vector3(0, 0, outward).transformDirection(this.b.m),
      w, h: y1 - y0, pane, bars: bars.filter((i) => i >= 0), broken: false,
    });
  }

  /** Ceiling lamp: cord, shade and an emissive bulb; registers a light anchor. */
  private fixture(x: number, ceil: number, z: number, kind: 'pendant' | 'strip' | 'bay' | 'bare' = 'pendant') {
    const b = this.b;
    const n0 = this.fixtures.length;
    this.fixtureInner(x, ceil, z, kind);
    // (Update 33) a little life: some tubes stutter, some old bulbs are tired; warm shades vary
    const f = this.fixtures[n0];
    if (f) {
      const hsh = Math.abs(Math.sin(f.p.x * 12.9898 + f.p.z * 78.233) * 43758.5453) % 1;
      if (kind === 'strip' && hsh < 0.3) f.flicker = 'fluoro';
      else if ((kind === 'bare' && hsh < 0.45) || (kind === 'pendant' && hsh < 0.1)) f.flicker = 'old';
      if (kind === 'pendant' || kind === 'bare') f.color = [0xffc58a, 0xffd6a8, 0xffb070, 0xffcf96][Math.floor(hsh * 4)];
    }
    void b;
  }
  private fixtureInner(x: number, ceil: number, z: number, kind: 'pendant' | 'strip' | 'bay' | 'bare') {
    const b = this.b;
    if (kind === 'pendant') {
      b.box('steel', x - 0.006, ceil - 0.55, z - 0.006, x + 0.006, ceil, z + 0.006);
      const shade = new THREE.ConeGeometry(0.22, 0.2, 14, 1, true);
      b.addGeo('lampShade', shade, new THREE.Matrix4().setPosition(x, ceil - 0.62, z));
      b.box('bulb', x - 0.045, ceil - 0.74, z - 0.045, x + 0.045, ceil - 0.66, z + 0.045);
      this.fixtures.push({ p: new THREE.Vector3(x, ceil - 0.8, z).applyMatrix4(b.m), color: 0xffc58a, intensity: 5, dist: 9, m: b.m.clone(), min: new THREE.Vector3(x - 0.045, ceil - 0.74, z - 0.045), max: new THREE.Vector3(x + 0.045, ceil - 0.66, z + 0.045) });
    } else if (kind === 'strip') {
      b.box('steel', x - 0.7, ceil - 0.1, z - 0.08, x + 0.7, ceil - 0.02, z + 0.08);
      b.box('bulbCool', x - 0.66, ceil - 0.12, z - 0.05, x + 0.66, ceil - 0.1, z + 0.05);
      this.fixtures.push({ p: new THREE.Vector3(x, ceil - 0.3, z).applyMatrix4(b.m), color: 0xe8f0ff, intensity: 7, dist: 12, m: b.m.clone(), min: new THREE.Vector3(x - 0.66, ceil - 0.12, z - 0.05), max: new THREE.Vector3(x + 0.66, ceil - 0.1, z + 0.05) });
    } else if (kind === 'bay') {
      b.box('steel', x - 0.01, ceil - 1.2, z - 0.01, x + 0.01, ceil, z + 0.01);
      const shade = new THREE.ConeGeometry(0.45, 0.35, 16, 1, true);
      b.addGeo('steel', shade, new THREE.Matrix4().setPosition(x, ceil - 1.35, z));
      b.box('bulbCool', x - 0.12, ceil - 1.5, z - 0.12, x + 0.12, ceil - 1.45, z + 0.12);
      this.fixtures.push({ p: new THREE.Vector3(x, ceil - 1.7, z).applyMatrix4(b.m), color: 0xfff0d8, intensity: 18, dist: 22, m: b.m.clone(), min: new THREE.Vector3(x - 0.12, ceil - 1.5, z - 0.12), max: new THREE.Vector3(x + 0.12, ceil - 1.45, z + 0.12) });
    } else {
      b.box('bulb', x - 0.04, ceil - 0.12, z - 0.04, x + 0.04, ceil - 0.04, z + 0.04);
      this.fixtures.push({ p: new THREE.Vector3(x, ceil - 0.3, z).applyMatrix4(b.m), color: 0xffb070, intensity: 3, dist: 7, m: b.m.clone(), min: new THREE.Vector3(x - 0.04, ceil - 0.12, z - 0.04), max: new THREE.Vector3(x + 0.04, ceil - 0.04, z + 0.04) });
    }
  }

  private gableRoof(w: number, d: number, top: number, pitch: number, oh: number, mat: string, fascia = true) {
    const b = this.b;
    const half = d / 2 + oh;
    const rise = (d / 2) * Math.tan(pitch);
    const len = half / Math.cos(pitch);
    const th = 0.14;
    for (const s of [1, -1]) {
      const cz = (s * half) / 2;
      const cy = top + rise - (half / 2) * Math.tan(pitch) + th / 2 + 0.02;
      b.obox(mat, [0, cy, cz], [w + oh * 2, th, len], new THREE.Euler(s * pitch, 0, 0), 'wood');
      if (fascia) {
        // white barge boards along the gable edges
        for (const sx of [1, -1]) b.obox('trim', [sx * (w / 2 + oh), cy - 0.04, cz], [0.06, 0.24, len], new THREE.Euler(s * pitch, 0, 0));
        const eaveY = top + rise - half * Math.tan(pitch) + 0.02;
        b.obox('trim', [0, eaveY - 0.04, s * (half + 0.01)], [w + oh * 2 + 0.06, 0.2, 0.05], new THREE.Euler(0, 0, 0));
        // rafter tails under the overhang
        if (oh > 0.25) {
          const n = Math.max(2, Math.round((w + oh) / 0.6));
          for (let i = 0; i <= n; i++) {
            const x = -w / 2 - oh * 0.5 + ((w + oh) * i) / n;
            const zc = s * (d / 2 + oh / 2);
            const yc = top + rise - (d / 2 + oh / 2) * Math.tan(pitch) - 0.06;
            b.obox('trim', [x, yc, zc], [0.06, 0.1, oh + 0.02], new THREE.Euler(s * pitch, 0, 0));
          }
        }
        // gutter along the eave and a downpipe at one end, down the wall to the ground
        b.obox('roofMetal', [0, eaveY - 0.13, s * (half + 0.07)], [w + oh * 2, 0.09, 0.11], new THREE.Euler(0, 0, 0));
        const px = (s > 0 ? 1 : -1) * (w / 2 - 0.2);
        b.obox('roofMetal', [px, eaveY - 0.24, s * (half + 0.07 + d / 2 + 0.07) / 2], [0.08, 0.08, half - d / 2 + 0.04], new THREE.Euler(0, 0, 0));
        b.cyl('roofMetal', px, -0.2, s * (d / 2 + 0.07), 0.04, eaveY - 0.08, 8);
        b.cyl('roofMetal', px, -0.2, s * (d / 2 + 0.07), 0.055, 0.25, 8);
      }
    }
    b.obox('roofMetal', [0, top + rise + 0.12, 0], [w + oh * 2, 0.08, 0.3], new THREE.Euler(0, 0, 0)); // ridge cap
    return rise;
  }

  private furniture(kind: 'living' | 'kitchen' | 'bed' | 'shop' | 'office', x: number, y: number, z: number, rot = 0) {
    const b = this.b;
    b.push([x, y, z], rot);
    switch (kind) {
      case 'living': {
        b.box('rug', -1.3, 0.0, 0.3, 1.3, 0.012, 2.1, 'fabric', { tag: 'rug' });
        b.box('fabric', -1.0, 0, -0.45, 1.0, 0.45, 0.45, 'fabric'); // sofa
        b.box('fabric', -1.0, 0.45, -0.45, 1.0, 0.85, -0.25);
        b.box('fabric', -1.05, 0.45, -0.45, -0.85, 0.65, 0.45);
        b.box('fabric', 0.85, 0.45, -0.45, 1.05, 0.65, 0.45);
        b.box('wood', -0.5, 0.0, 0.9, 0.5, 0.45, 1.5, 'wood'); // coffee table
        b.cyl('ceramic', 0.15, 0.45, 1.1, 0.04, 0.09, 10); // mug
        b.box('books', -0.3, 0.45, 1.2, 0.0, 0.5, 1.4); // magazines
        // bookshelf
        b.box('wood', 1.4, 0, -0.45, 2.3, 1.9, -0.15, 'wood');
        for (let sh = 0; sh < 4; sh++) {
          let bx = 1.44;
          let k = 0;
          while (bx < 2.25) {
            const bw = 0.03 + ((k * 7919) % 5) * 0.008;
            const bh = 0.2 + ((k * 104729) % 7) * 0.015;
            b.box(['books', 'red', 'door', 'ochre'][k % 4], bx, 0.06 + sh * 0.46, -0.42, bx + bw, 0.06 + sh * 0.46 + bh, -0.2);
            bx += bw + 0.004;
            k++;
          }
        }
        // floor lamp & plant
        b.cyl('steel', -1.4, 0, -0.2, 0.015, 1.5, 6);
        b.addGeo('lampShade', new THREE.ConeGeometry(0.18, 0.25, 12, 1, true), new THREE.Matrix4().setPosition(-1.4, 1.55, -0.2));
        b.cyl('pot', 1.6, 0, 0.9, 0.16, 0.3, 10, null, 0.2);
        b.addGeo('plant', new THREE.IcosahedronGeometry(0.32, 1), new THREE.Matrix4().compose(new THREE.Vector3(1.6, 0.6, 0.9), new THREE.Quaternion(), new THREE.Vector3(1, 1.3, 1)));
        break;
      }
      case 'kitchen':
        b.box('white', -1.3, 0, -0.3, 1.3, 0.9, 0.3, 'wood');
        b.box('wood', -1.32, 0.9, -0.32, 1.32, 0.94, 0.32);
        b.box('white', -1.3, 1.5, -0.3, 1.3, 2.1, 0.05);
        b.box('wood', -0.6, 0.71, 1.0, 0.6, 0.75, 1.8, 'wood'); // table top
        for (const [lx, lz] of [[-0.55, 1.05], [0.55, 1.05], [-0.55, 1.75], [0.55, 1.75]]) b.box('wood', lx - 0.03, 0, lz - 0.03, lx + 0.03, 0.71, lz + 0.03);
        for (const cz of [0.75, 2.05]) {
          b.box('wood', -0.22, 0.42, cz - 0.2, 0.22, 0.46, cz + 0.2); // chairs
          b.box('wood', -0.22, 0.46, cz + (cz < 1.4 ? -0.2 : 0.17), 0.22, 0.95, cz + (cz < 1.4 ? -0.17 : 0.2));
          for (const lx of [-0.19, 0.19]) for (const lz of [-0.17, 0.17]) b.box('wood', lx - 0.02, 0, cz + lz - 0.02, lx + 0.02, 0.42, cz + lz + 0.02);
        }
        for (const [px, pz] of [[-0.3, 1.25], [0.3, 1.55]]) {
          b.cyl('ceramic', px, 0.75, pz, 0.11, 0.015, 14); // plates
          b.cyl('ceramic', px + 0.15, 0.75, pz - 0.05, 0.035, 0.08, 10); // cups
        }
        b.cyl('steel', 0.9, 0.94, -0.05, 0.07, 0.2, 10); // coffee pot on the counter
        break;
      case 'bed':
        b.box('rug', -1.2, 0.0, 1.05, 1.2, 0.012, 2.0, 'fabric', { tag: 'rug' });
        b.box('wood', -1.3, 0, -1.0, -0.85, 0.5, -0.55, 'wood'); // nightstand
        b.cyl('ceramic', -1.08, 0.5, -0.78, 0.06, 0.18, 10);
        b.addGeo('lampShade', new THREE.ConeGeometry(0.11, 0.14, 10, 1, true), new THREE.Matrix4().setPosition(-1.08, 0.74, -0.78));
        b.box('wood', -0.8, 0, -1.0, 0.8, 0.45, 1.0, 'wood');
        b.box('fabric', -0.75, 0.45, -0.95, 0.75, 0.6, 0.95);
        b.box('wood', -0.8, 0, -1.05, 0.8, 1.0, -0.95);
        b.box('wood', 1.2, 0, -0.9, 1.8, 1.9, -0.3, 'wood'); // wardrobe
        break;
      case 'shop':
        for (let i = 0; i < 3; i++) {
          b.box('wood', -2.2, 0, i * 2.2 - 0.3, 2.2, 1.6, i * 2.2 + 0.3, 'wood');
          for (let k = 0; k < 3; k++) b.box('crate', -2.1, 0.45 + k * 0.45, i * 2.2 - 0.25, 2.1, 0.6 + k * 0.45, i * 2.2 + 0.25);
        }
        break;
      case 'office':
        b.box('wood', -0.8, 0, -0.4, 0.8, 0.75, 0.4, 'wood');
        b.box('steel', 1.2, 0, -0.3, 1.7, 1.4, 0.3, 'metal');
        break;
    }
    b.pop();
  }

  // ---------------------------------------------------------------- house
  /** Three steps from ground level (local y=0) up to floor height F, leaving the door in direction (dx,dz). */
  /**
   * Entrance stairs from floor height F down to the actual terrain in front of a door.
   * (cx,cz) is the top edge at the threshold, (dx,dz) the outward direction. Steps keep
   * going until they meet the ground, so sloping sites and road cuts never leave a ledge.
   */
  private steps(cx: number, cz: number, dx: number, dz: number, width: number, F: number, _n = 3) {
    void _n;
    const b = this.b;
    const depth = 0.32, riser = 0.18;
    const m = b.m;
    const groundAt = (lx: number, lz: number) => {
      const v = new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
      return this.heightAt(v.x, v.z) - m.elements[13];
    };
    // where along the outward axis is the ground (sample both corners, take the lowest)
    const px = -dz, pz = dx;
    const gAt = (t: number) => Math.min(groundAt(cx + dx * t + px * width * 0.5, cz + dz * t + pz * width * 0.5), groundAt(cx + dx * t - px * width * 0.5, cz + dz * t - pz * width * 0.5));
    for (let i = 0; i < 16; i++) {
      const a = i * depth, c = (i + 1) * depth;
      const top = F - riser * i;
      const g = Math.min(gAt(a), gAt(c));
      if (top < g + 0.06) break;
      const bottom = Math.min(g, top) - 0.6;
      if (dx !== 0) {
        const x0 = cx + dx * a, x1 = cx + dx * c;
        b.box('concrete', Math.min(x0, x1), bottom, cz - width / 2, Math.max(x0, x1), top, cz + width / 2, 'concrete');
      } else {
        const z0 = cz + dz * a, z1 = cz + dz * c;
        b.box('concrete', cx - width / 2, bottom, Math.min(z0, z1), cx + width / 2, top, Math.max(z0, z1), 'concrete');
      }
      if (top - riser < g + 0.06) break;
    }
  }


  private house(def: BuildingDef) {
    const b = this.b;
    const rng = new RNG(def.seed ?? 1);
    const w = def.w ?? 8, d = def.d ?? 7, floors = def.floors ?? 2;
    const col = def.color ?? 'red';
    const F = 0.55, FH = 2.75, T = 0.16;
    const top = F + FH * floors;
    const ix0 = -w / 2 + T, ix1 = w / 2 - T, iz0 = -d / 2 + T, iz1 = d / 2 - T; // interior bounds
    // foundation (extends into the ground to cover slopes) + floorboards
    b.box('stone', -w / 2 - 0.06, -2.0, -d / 2 - 0.06, w / 2 + 0.06, F, d / 2 + 0.06, 'rock');
    b.box('floorInt', ix0, F - 0.02, iz0, ix1, F + 0.01, iz1, 'woodFloor');
    const winW = 0.95, head = 2.1;
    const doorX = rng.range(0.35, Math.min(1.0, w / 2 - 1.9));
    const doorW = 1.1;
    const backDoorX = w / 2 - 1.2; // back door (in house coordinates)
    // stairs along the left wall, bottom near the front door, rising toward the back
    const stairX0 = ix0, stairX1 = ix0 + 1.0;
    const stairBot = iz1 - 1.0, run = 3.4, stairTop = stairBot - run;
    for (let f = 0; f < floors; f++) {
      const y0 = F + f * FH, y1 = y0 + FH;
      const sill = f === 0 ? 0.75 : 0.85;
      const front: Op[] = f === 0
        ? [{ x: doorX, w: doorW, y0, y1: y0 + 2.15 }, { x: -w / 2 + 1.25, w: winW, y0: y0 + sill, y1: y0 + head }, ...(w > 7.5 ? [{ x: w / 2 - 0.85, w: 0.7, y0: y0 + sill, y1: y0 + head }] : [])]
        : [{ x: -w / 2 + 1.3, w: winW, y0: y0 + sill, y1: y0 + head }, { x: doorX, w: winW, y0: y0 + sill, y1: y0 + head }, { x: w / 2 - 1.3, w: winW, y0: y0 + sill, y1: y0 + head }];
      const back: Op[] = f === 0
        ? [{ x: -w / 4, w: winW, y0: y0 + sill, y1: y0 + head }, { x: backDoorX, w: 1.0, y0, y1: y0 + 2.1 }]
        : [{ x: -w / 4, w: winW, y0: y0 + sill, y1: y0 + head }, { x: w / 4, w: winW, y0: y0 + sill, y1: y0 + head }];
      const side: Op[] = [{ x: 0, w: winW, y0: y0 + sill, y1: y0 + head }];
      b.wall(col, -w / 2, w / 2, d / 2 - T / 2, T, y0, y1, front, 'wood', 'wallInt');
      for (const o of front) if (o.y0 > y0 + 0.1) this.windowFrame(o.x, o.y0, o.y1, o.w, d / 2, 1, f > 0 || rng.chance(0.4));
      // back wall is built in a frame rotated by PI: openings are mirrored (x -> -x)
      b.push([0, 0, -d / 2 + T / 2], Math.PI);
      b.wall(col, -w / 2, w / 2, 0, T, y0, y1, back.map((o) => ({ ...o, x: -o.x })), 'wood', 'wallInt');
      for (const o of back) if (o.y0 > y0 + 0.1) this.windowFrame(-o.x, o.y0, o.y1, o.w, T / 2, 1, rng.chance(0.6));
      b.pop();
      for (const sgn of [1, -1]) {
        b.push([sgn * (w / 2 - T / 2), 0, 0], (sgn * Math.PI) / 2);
        b.wall(col, -d / 2 + T, d / 2 - T, 0, T, y0, y1, side, 'wood', 'wallInt');
        for (const o of side) this.windowFrame(o.x, o.y0, o.y1, o.w, T / 2, 1, f > 0 || rng.chance(0.5));
        b.pop();
      }
      if (f > 0) b.box('trim', -w / 2 - 0.03, y0 - 0.06, d / 2, w / 2 + 0.03, y0 + 0.06, d / 2 + 0.04);
    }
    // corner boards
    for (const sx of [1, -1]) for (const sz of [1, -1]) b.box('trim', sx * w / 2 - 0.09, F, sz * d / 2 - 0.09, sx * w / 2 + 0.03 * sx, top, sz * d / 2 + 0.03 * sz);
    // front door: frame, leaf swung open against the inside wall, steps
    b.box('trim', doorX - doorW / 2 - 0.08, F, d / 2, doorX - doorW / 2, F + 2.23, d / 2 + 0.05);
    b.box('trim', doorX + doorW / 2, F, d / 2, doorX + doorW / 2 + 0.08, F + 2.23, d / 2 + 0.05);
    b.box('trim', doorX - doorW / 2 - 0.08, F + 2.15, d / 2, doorX + doorW / 2 + 0.08, F + 2.25, d / 2 + 0.05);
    this.steps(doorX, d / 2 + 0.06, 0, 1, doorW + 0.6, F);
    this.steps(backDoorX, -d / 2 - 0.06, 0, -1, 1.5, F);
    this.link(doorX, F, d / 2 + 2.2, doorX, F, iz1 - 1.3);
    this.link(backDoorX, F, -d / 2 - 2.0, backDoorX, F, iz0 + 1.2);
    this.point(0.6, F, -0.2);
    // ceilings / upper floor with the stair opening
    for (let f = 1; f <= floors; f++) {
      const y = F + f * FH;
      if (f < floors) {
        b.box('floorInt', stairX1, y - 0.22, iz0, ix1, y, iz1, 'woodFloor');
        b.box('floorInt', stairX0, y - 0.22, iz0, stairX1, y, stairTop, 'woodFloor');
        b.box('floorInt', stairX0, y - 0.22, stairBot + 0.25, stairX1, y, iz1, 'woodFloor');
        b.box('wallInt', stairX1, y - 0.24, iz0, ix1, y - 0.22, iz1);
      } else {
        b.box('wallInt', ix0, y - 0.05, iz0, ix1, y, iz1, 'wood');
      }
    }
    if (floors > 1) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const za = stairBot - (i * run) / n, zb = za - run / n;
        b.box('wood', stairX0, F + (i * FH) / n, zb, stairX1, F + ((i + 1) * FH) / n, za);
      }
      // smooth ramp collider over the treads
      const ang = Math.atan2(FH, run);
      b.obox(null, [(stairX0 + stairX1) / 2, F + FH / 2 + 0.02, (stairTop + stairBot) / 2], [0.98, 0.08, Math.hypot(FH, run) + 0.1], new THREE.Euler(ang, 0, 0), 'wood');
      // stringer under the high end so nobody walks into the underside
      b.box(null, stairX0, F, stairTop, stairX1, F + FH * 0.55, stairTop + run * 0.45, 'wood');
      // balustrade around the opening upstairs (leaves the top of the stairs open)
      b.box('wood', stairX1, F + FH, stairTop + 0.6, stairX1 + 0.06, F + FH + 0.95, stairBot + 0.25, 'wood');
      for (let z = stairTop + 0.6; z < stairBot + 0.25; z += 0.4) b.box('wood', stairX1, F + FH, z, stairX1 + 0.05, F + FH + 0.95, z + 0.04);
      b.box('wood', stairX0, F + FH, stairBot + 0.2, stairX1, F + FH + 0.95, stairBot + 0.26, 'wood');
      this.link((stairX0 + stairX1) / 2, F, stairBot + 0.7, (stairX0 + stairX1) / 2, F + FH, stairTop - 0.6);
      this.point(1.2, F + FH, -0.6);
      // upstairs: bed against the right wall, wardrobe, nightstand, rug
      b.box('rug', -0.4, F + FH, -1.4, 2.2, F + FH + 0.012, 0.8, 'fabric', { tag: 'rug' });
      b.box('wood', ix1 - 2.1, F + FH, iz0 + 0.1, ix1 - 0.1, F + FH + 0.45, iz0 + 1.7, 'wood');
      b.box('fabric', ix1 - 2.05, F + FH + 0.45, iz0 + 0.15, ix1 - 0.15, F + FH + 0.6, iz0 + 1.65);
      b.box('wood', ix1 - 0.1, F + FH, iz0 + 0.1, ix1, F + FH + 1.0, iz0 + 1.7);
      b.box('wood', ix1 - 0.6, F + FH, iz1 - 1.7, ix1, F + FH + 1.9, iz1 - 0.6, 'wood');
      b.box('wood', ix1 - 2.6, F + FH, iz0 + 0.1, ix1 - 2.15, F + FH + 0.5, iz0 + 0.55, 'wood');
      b.cyl('ceramic', ix1 - 2.38, F + FH + 0.5, iz0 + 0.32, 0.06, 0.18, 10);
      // (Update 33) every house's upstairs is a different room along the front wall
      const v = rng.int(0, 2);
      const fx0 = stairX1 + 0.3, fz = iz1;
      if (v === 0) {
        // study: desk under the window, chair, lamp, a stack of papers
        b.box('wood', fx0, F + FH + 0.72, fz - 0.6, fx0 + 1.3, F + FH + 0.76, fz - 0.02, 'wood');
        for (const lx of [0.04, 1.26]) b.box('wood', fx0 + lx - 0.03, F + FH, fz - 0.58, fx0 + lx + 0.03, F + FH + 0.72, fz - 0.04);
        b.box('fabric', fx0 + 0.45, F + FH + 0.42, fz - 1.1, fx0 + 0.9, F + FH + 0.48, fz - 0.65, 'fabric');
        b.box('fabric', fx0 + 0.45, F + FH + 0.48, fz - 1.12, fx0 + 0.9, F + FH + 0.95, fz - 1.06);
        b.cyl('steel', fx0 + 1.1, F + FH + 0.76, fz - 0.3, 0.012, 0.4, 6);
        b.cyl('lampShade', fx0 + 1.1, F + FH + 1.12, fz - 0.3, 0.09, 0.12, 10, null, 0.05);
        b.box('white', fx0 + 0.2, F + FH + 0.76, fz - 0.45, fx0 + 0.5, F + FH + 0.8, fz - 0.2);
      } else if (v === 1) {
        // kids' room: a bunk bed along the front wall
        const bx1 = Math.min(fx0 + 2.0, ix1 - 0.7);
        for (const y of [0.35, 1.45]) {
          b.box('wood', fx0, F + FH + y, fz - 0.95, bx1, F + FH + y + 0.08, fz - 0.05, 'wood');
          b.box('fabric', fx0 + 0.05, F + FH + y + 0.08, fz - 0.9, bx1 - 0.05, F + FH + y + 0.22, fz - 0.1);
        }
        for (const lx of [fx0, bx1 - 0.06]) for (const lz of [fz - 0.95, fz - 0.11]) b.box('wood', lx, F + FH, lz, lx + 0.06, F + FH + 1.85, lz + 0.06);
        b.box('rug', fx0, F + FH, fz - 2.0, bx1, F + FH + 0.012, fz - 1.1, 'fabric', { tag: 'rug' });
      } else {
        // box room: stacked moving boxes and an old trunk
        for (let k = 0; k < 4; k++) {
          const x = fx0 + 0.1 + (k % 2) * 0.62, y = Math.floor(k / 2) * 0.48;
          b.box('crate', x, F + FH + y, fz - 0.62, x + 0.58, F + FH + y + 0.46, fz - 0.08, k < 2 ? 'wood' : null);
        }
        b.box('door', fx0 + 1.4, F + FH, fz - 0.6, fx0 + 2.2, F + FH + 0.5, fz - 0.1, 'wood');
        b.box('steel', fx0 + 1.4, F + FH + 0.5, fz - 0.61, fx0 + 2.2, F + FH + 0.53, fz - 0.09);
      }
    }
    // ---- ground floor furnishing (against the walls; the centre and the door/stair paths stay clear)
    const sofaX0 = floors > 1 ? stairX1 + 0.15 : ix0 + 0.1;
    b.box('rug', -1.2, F, -1.6, 1.6, F + 0.012, 0.9, 'fabric', { tag: 'rug' });
    // kitchen run along the back wall (right half)
    b.box('white', 0.4, F, iz0, backDoorX - 0.75, F + 0.9, iz0 + 0.6, 'wood');
    b.box('wood', 0.38, F + 0.9, iz0, backDoorX - 0.73, F + 0.94, iz0 + 0.62);
    b.box('white', 0.4, F + 1.5, iz0, backDoorX - 0.75, F + 2.1, iz0 + 0.35);
    b.cyl('steel', 1.0, F + 0.94, iz0 + 0.3, 0.07, 0.2, 10);
    // sofa corner: back-left (behind / beside the stairs)
    if (floors > 1) {
      b.box('fabric', ix0 + 0.05, F, iz0 + 0.05, stairX1, F + 0.45, stairTop - 0.1, 'fabric');
    }
    b.box('fabric', sofaX0, F, iz0 + 0.05, sofaX0 + 1.8, F + 0.45, iz0 + 0.9, 'fabric');
    b.box('fabric', sofaX0, F + 0.45, iz0 + 0.05, sofaX0 + 1.8, F + 0.85, iz0 + 0.28);
    b.box('wood', sofaX0 + 0.3, F, iz0 + 1.3, sofaX0 + 1.4, F + 0.42, iz0 + 1.9, 'wood');
    b.cyl('ceramic', sofaX0 + 0.6, F + 0.42, iz0 + 1.55, 0.04, 0.09, 10);
    // dining table near the right wall
    const tx = ix1 - 1.0, tz = 0.4;
    b.box('wood', tx - 0.55, F + 0.71, tz - 0.85, tx + 0.55, F + 0.75, tz + 0.85, 'wood');
    for (const [lx, lz] of [[-0.5, -0.8], [0.5, -0.8], [-0.5, 0.8], [0.5, 0.8]]) b.box('wood', tx + lx - 0.03, F, tz + lz - 0.03, tx + lx + 0.03, F + 0.71, tz + lz + 0.03);
    for (const cz of [-0.45, 0.45]) {
      b.box('wood', tx - 0.95, F + 0.42, tz + cz - 0.2, tx - 0.6, F + 0.46, tz + cz + 0.2, 'wood');
      b.box('wood', tx - 0.98, F + 0.46, tz + cz - 0.2, tx - 0.94, F + 0.95, tz + cz + 0.2);
    }
    for (const [px, pz] of [[-0.2, -0.4], [0.15, 0.45]]) {
      b.cyl('ceramic', tx + px, F + 0.75, tz + pz, 0.11, 0.015, 14);
      b.cyl('ceramic', tx + px + 0.15, F + 0.75, tz + pz - 0.05, 0.035, 0.08, 10);
    }
    // bookshelf by the right wall near the front
    b.box('wood', ix1 - 0.32, F, iz1 - 2.2, ix1, F + 1.9, iz1 - 1.3, 'wood');
    for (let sh = 0; sh < 4; sh++) for (let k = 0; k < 9; k++) {
      const z0 = iz1 - 2.17 + k * 0.095;
      b.box(['books', 'red', 'door', 'ochre'][(k + sh) % 4], ix1 - 0.3, F + 0.06 + sh * 0.46, z0, ix1 - 0.06, F + 0.06 + sh * 0.46 + 0.2 + ((k * 7) % 5) * 0.015, z0 + 0.07);
    }
    b.cyl('pot', ix1 - 0.3, F, -1.6, 0.16, 0.3, 10, null, 0.2);
    b.addGeo('plant', new THREE.IcosahedronGeometry(0.32, 1), new THREE.Matrix4().compose(new THREE.Vector3(ix1 - 0.3, F + 0.6, -1.6), new THREE.Quaternion(), new THREE.Vector3(1, 1.3, 1)));
    for (let f = 0; f < floors; f++) this.fixture(0.6, F + (f + 1) * FH - (f === floors - 1 ? 0.05 : 0.24), f === 0 ? 0.2 : -0.8);
    // pictures on the interior walls
    for (const [px, pz] of [[ix0 + 0.02, -1.2], [ix1 - 0.02, -1.0]] as const) {
      const sx = px < 0 ? 1 : -1;
      b.box('frame', px, F + 1.35, pz - 0.3, px + sx * 0.03, F + 1.85, pz + 0.3);
      b.box(rng.chance(0.5) ? 'art1' : 'art2', px + sx * 0.03, F + 1.4, pz - 0.25, px + sx * 0.035, F + 1.8, pz + 0.25);
    }
    // roof
    const pitch = (36 + rng.range(-3, 6)) * (Math.PI / 180);
    const rise = this.gableRoof(w, d, top, pitch, 0.45, rng.chance(0.6) ? 'roof' : 'roofMetal');
    // roof access: a steel ladder on the back wall, clear of the back door and windows, up to the
    // eave; it lets you out a step up the roof slope
    {
      const lx = -w / 2 + 0.75;
      const base = new THREE.Vector3(lx, 0, -d / 2 - 0.16).applyMatrix4(b.m);
      const exit = new THREE.Vector3(lx, top + 0.85 * Math.tan(pitch) + 0.3, -d / 2 + 0.85).applyMatrix4(b.m);
      const n = new THREE.Vector3(0, 0, -1).transformDirection(b.m);
      const gy = this.heightAt(base.x, base.z);
      LADDERS.push({ x: base.x, z: base.z, nx: n.x, nz: n.z, y0: gy, y1: exit.y - 0.25, exit: [exit.x, exit.y, exit.z] });
    }
    for (const sgn of [1, -1]) {
      b.push([sgn * (w / 2 - T / 2), 0, 0], (sgn * Math.PI) / 2);
      b.gable(col, -d / 2, d / 2, 0, T, top, rise, 'wood');
      b.gable('wallInt', -d / 2 + T, d / 2 - T, -T / 2 - 0.003, 0.004, top, rise - 0.15, null);
      this.windowFrame(0, top + 0.5, top + 1.3, 0.6, T / 2, 1, true, false);
      b.pop();
    }
    const cx = rng.range(-w / 4, w / 4);
    b.box('chimney', cx - 0.35, top - 0.2, -0.6, cx + 0.35, top + rise + 0.9, 0.1, 'concrete');
    this.chimneys.push(new THREE.Vector3(cx, top + rise + 1.0, -0.25).applyMatrix4(b.m));
    // white picket fence with a gate gap in front of the door
    if (rng.chance(0.5)) {
      const fz = d / 2 + 3.4;
      // (destructible: built and broken section by section by the Destruction system)
      b.destructible('fence', new THREE.Matrix4(), { x0: -w / 2 - 2, x1: doorX - 1.3, z: fz, style: 'picket' });
      b.destructible('fence', new THREE.Matrix4(), { x0: doorX + 1.3, x1: w / 2 + 2, z: fz, style: 'picket' });
    }
  }

  private rorbu(def: BuildingDef) {
    const b = this.b;
    const rng = new RNG(def.seed ?? 3);
    const w = def.w ?? 7, d = def.d ?? 6;
    const col = def.color ?? 'red';
    const F = 0.0, FH = 2.6, T = 0.15;
    // stilts into the sea + deck (local origin is at padY ≈ 2.2)
    for (let x = -w / 2; x <= w / 2 + 0.01; x += w / 3) for (let z = -d / 2 - 2; z <= d / 2 + 0.01; z += (d + 2) / 3) b.cyl('woodRaw', x, -6, z, 0.14, 6.0, 8, 'wood');
    b.box('planks', -w / 2 - 0.5, -0.25, -d / 2 - 2.5, w / 2 + 0.5, 0.0, d / 2 + 0.3, 'wood');
    b.box('woodRaw', -w / 2 - 0.5, -0.45, -d / 2 - 2.5, w / 2 + 0.5, -0.25, -d / 2 - 2.3);
    // railing on the sea side
    for (let x = -w / 2 - 0.5; x <= w / 2 + 0.5; x += 1.2) b.box('woodRaw', x - 0.05, 0, -d / 2 - 2.5, x + 0.05, 1.0, -d / 2 - 2.4);
    b.box('woodRaw', -w / 2 - 0.5, 0.95, -d / 2 - 2.5, w / 2 + 0.5, 1.05, -d / 2 - 2.4, 'wood');
    const ops: Op[] = [{ x: 0, w: 1.0, y0: F, y1: F + 2.05 }, { x: -w / 3, w: 0.8, y0: 0.9, y1: 1.9 }, { x: w / 3, w: 0.8, y0: 0.9, y1: 1.9 }];
    b.wall(col, -w / 2, w / 2, d / 2 - T / 2, T, F, FH, ops, 'wood', 'wallInt');
    this.windowFrame(-w / 3, 0.9, 1.9, 0.8, d / 2, 1, rng.chance(0.5));
    this.windowFrame(w / 3, 0.9, 1.9, 0.8, d / 2, 1, true);
    b.push([0, 0, -d / 2 + T / 2], Math.PI);
    b.wall(col, -w / 2, w / 2, 0, T, F, FH, [{ x: 0, w: 1.0, y0: F, y1: F + 2.05 }, { x: 2, w: 0.8, y0: 0.9, y1: 1.9 }], 'wood', 'wallInt');
    this.windowFrame(2, 0.9, 1.9, 0.8, T / 2, 1, false);
    b.pop();
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall(col, -d / 2 + T, d / 2 - T, 0, T, F, FH, [{ x: 0, w: 0.8, y0: 0.9, y1: 1.9 }], 'wood', 'wallInt');
      this.windowFrame(0, 0.9, 1.9, 0.8, T / 2, 1, rng.chance(0.6));
      b.pop();
    }
    b.box('floorInt', -w / 2 + T, -0.02, -d / 2 + T, w / 2 - T, 0.01, d / 2 - T, 'woodFloor');
    b.box('wallInt', -w / 2 + T, FH - 0.05, -d / 2 + T, w / 2 - T, FH, d / 2 - T, 'wood');
    for (const sx of [1, -1]) for (const sz of [1, -1]) b.box('trim', sx * w / 2 - 0.08, F, sz * d / 2 - 0.08, sx * w / 2 + 0.03 * sx, FH, sz * d / 2 + 0.03 * sz);
    const rise = this.gableRoof(w, d, FH, 0.72, 0.4, 'roof');
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.gable(col, -d / 2, d / 2, 0, T, FH, rise, 'wood');
      b.pop();
    }
    this.furniture('bed', -w / 4, 0, -0.5, Math.PI / 2);
    this.fixture(0.8, FH - 0.05, 0.2, 'bare');
    // fishing gear inside the cabin
    b.box('net', w / 2 - 1.2, 0, -d / 2 + 0.3, w / 2 - 0.3, 0.5, -d / 2 + 1.4, 'fabric', { penetrable: 2 });
    b.cyl('buoy', w / 2 - 0.6, 0.5, -d / 2 + 0.8, 0.22, 0.4, 12);
    // (Update 33) a lived-in cabin: wood stove and its pipe, a table with stools, oilskins on pegs
    {
      const sx = -w / 2 + T + 0.35, sz = -d / 2 + T + 0.35;
      b.box('tyre', sx - 0.28, 0, sz - 0.25, sx + 0.28, 0.75, sz + 0.25, 'metal');
      b.box('steel', sx - 0.3, 0.75, sz - 0.27, sx + 0.3, 0.79, sz + 0.27);
      b.cyl('tyre', sx, 0.79, sz, 0.07, FH - 0.84, 8);
      if (rng.chance(0.8)) {
        const tx = w / 2 - T - 0.9, tz = d / 2 - T - 0.9;
        b.box('wood', tx - 0.45, 0.72, tz - 0.35, tx + 0.45, 0.76, tz + 0.35, 'wood');
        for (const [lx, lz] of [[-0.4, -0.3], [0.4, -0.3], [-0.4, 0.3], [0.4, 0.3]]) b.box('wood', tx + lx - 0.025, 0, tz + lz - 0.025, tx + lx + 0.025, 0.72, tz + lz + 0.025);
        for (const ox of [-0.62, 0.62]) b.cyl('wood', tx + ox, 0, tz, 0.16, 0.45, 10, 'wood');
        b.cyl('ceramic', tx + 0.1, 0.76, tz, 0.045, 0.1, 10);
      }
      for (let k = 0; k < rng.int(1, 2); k++) {
        const z0 = d / 2 - T - 1.6 - k * 0.55;
        b.box('yellowSteel', w / 2 - T - 0.09, 0.85, z0 - 0.22, w / 2 - T - 0.03, 1.75, z0 + 0.22);
        b.box('steel', w / 2 - T - 0.05, 1.75, z0 - 0.02, w / 2 - T, 1.85, z0 + 0.02);
      }
    }
    this.link(0, 0, d / 2 + 1.5, 0, 0, 0);
    this.link(0, 0, 0, 0, 0, -d / 2 - 1.5);
  }

  private church(def: BuildingDef) {
    const b = this.b;
    const w = 15, d = 9, H = 5.5, T = 0.2, F = 0.5;
    b.box('stone', -w / 2 - 0.1, -2, -d / 2 - 0.1, w / 2 + 4.5, F, d / 2 + 0.1, 'rock');
    b.box('floorInt', -w / 2 + T, F - 0.02, -d / 2 + T, w / 2, F + 0.01, d / 2 - T, 'woodFloor');
    const winOps = (n: number): Op[] => Array.from({ length: n }, (_, i) => ({ x: -w / 2 + 2 + i * ((w - 4) / (n - 1)), w: 1.0, y0: F + 1.4, y1: F + 4.0 }));
    for (const s of [1, -1]) {
      b.push([0, 0, s * (d / 2 - T / 2)], s > 0 ? 0 : Math.PI);
      const ops = winOps(4);
      if (s > 0) ops.push({ x: w / 2 - 3.6, w: 1.4, y0: F, y1: F + 2.4 }); // side door
      b.wall('white', -w / 2, w / 2, 0, T, F, F + H, ops, 'wood', 'wallInt');
      for (const o of ops) if (o.y0 > F + 0.1) this.windowFrame(o.x, o.y0, o.y1, o.w, T / 2, 1, true);
      b.pop();
    }
    // apse end (east, -x) and tower end (+x)
    b.push([-w / 2 + T / 2, 0, 0], -Math.PI / 2);
    b.wall('white', -d / 2 + T, d / 2 - T, 0, T, F, F + H, [{ x: 0, w: 1.2, y0: F + 1.6, y1: F + 4.2 }], 'wood', 'wallInt');
    this.windowFrame(0, F + 1.6, F + 4.2, 1.2, T / 2, 1, true);
    b.pop();
    const rise = this.gableRoof(w, d, F + H, 0.82, 0.5, 'roof');
    b.push([-w / 2 + T / 2, 0, 0], -Math.PI / 2);
    b.gable('white', -d / 2, d / 2, 0, T, F + H, rise, 'wood');
    b.pop();
    // tower
    const tx = w / 2 + 2, ts = 4.2;
    b.push([tx, 0, 0], 0);
    b.wall('white', -ts / 2, ts / 2, ts / 2 - T / 2, T, F, F + 14, [{ x: 0, w: 1.6, y0: F + 10, y1: F + 12.5 }], 'wood', 'wallInt');
    b.push([0, 0, -ts / 2 + T / 2], Math.PI);
    b.wall('white', -ts / 2, ts / 2, 0, T, F, F + 14, [{ x: 0, w: 1.6, y0: F + 10, y1: F + 12.5 }], 'wood', 'wallInt');
    b.pop();
    b.push([ts / 2 - T / 2, 0, 0], Math.PI / 2);
    b.wall('white', -ts / 2 + T, ts / 2 - T, 0, T, F, F + 14, [{ x: 0, w: 1.4, y0: F, y1: F + 2.8 }, { x: 0, w: 1.6, y0: F + 10, y1: F + 12.5 }], 'wood', 'wallInt');
    b.pop();
    // opening between tower and nave
    b.push([-ts / 2 + T / 2, 0, 0], -Math.PI / 2);
    b.wall('white', -ts / 2 + T, ts / 2 - T, 0, T, F + H, F + 14, [{ x: 0, w: 1.6, y0: F + 10, y1: F + 12.5 }], 'wood');
    b.pop();
    // bell louvres
    for (let i = 0; i < 5; i++) b.box('woodRaw', -0.8, F + 10.2 + i * 0.45, ts / 2 - 0.05, 0.8, F + 10.3 + i * 0.45, ts / 2 + 0.05);
    // spire
    const sp = new THREE.ConeGeometry(ts * 0.72, 10, 8);
    sp.rotateY(Math.PI / 8);
    this.b.addGeo('roofMetal', sp, new THREE.Matrix4().setPosition(0, F + 14 + 5, 0));
    b.box('trim', -ts / 2 - 0.1, F + 13.8, -ts / 2 - 0.1, ts / 2 + 0.1, F + 14.1, ts / 2 + 0.1);
    b.box('steel', -0.04, F + 24, -0.04, 0.04, F + 25.6, 0.04);
    b.box('steel', -0.4, F + 25, -0.04, 0.4, F + 25.08, 0.04);
    b.box('woodRaw', -ts / 2 + T, F + 9.8, -ts / 2 + T, ts / 2 - T, F + 10.0, ts / 2 - T, 'wood'); // belfry floor
    b.pop();
    // pews & altar
    for (let i = 0; i < 6; i++) for (const s of [1, -1]) b.box('wood', -w / 2 + 3.5 + i * 1.6, F, s * 1.0, -w / 2 + 3.9 + i * 1.6, F + 0.85, s * 3.6, 'wood');
    b.box('white', -w / 2 + 0.8, F, -1.2, -w / 2 + 1.8, F + 1.0, 1.2, 'wood');
    this.fixture(-2, F + H - 0.1, 0);
    this.fixture(3, F + H - 0.1, 0);
    b.box('rug', -w / 2 + 2.5, F, -0.5, w / 2 - 0.5, F + 0.012, 0.5, 'fabric', { tag: 'rug' });
    // entrance steps: tower door (+x) and side door (+z)
    this.steps(w / 2 + 4.5, 0, 1, 0, 1.9, F);
    this.steps(w / 2 - 3.6, d / 2 + 0.1, 0, 1, 1.9, F);
    this.link(tx + ts / 2 + 2, F, 0, tx, F, 0);
    this.link(tx, F, 0, w / 2 - 3, F, 0);
    this.link(w / 2 - 3.6, F, d / 2 + 2.0, w / 2 - 3.6, F, d / 2 - 1.2);
    this.point(0, F, 0);
    void def;
  }

  private shop(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 14, d = def.d ?? 9, H = 3.6, T = 0.2, F = 0.4;
    b.box('concrete', -w / 2 - 0.1, -2, -d / 2 - 0.1, w / 2 + 0.1, F, d / 2 + 1.8, 'concrete');
    b.box('floorInt', -w / 2 + T, F - 0.02, -d / 2 + T, w / 2 - T, F + 0.01, d / 2 - T, 'woodFloor');
    const front: Op[] = [{ x: 0, w: 1.8, y0: F, y1: F + 2.3 }, { x: -4, w: 3.2, y0: F + 0.6, y1: F + 2.6 }, { x: 4, w: 3.2, y0: F + 0.6, y1: F + 2.6 }];
    b.wall('white', -w / 2, w / 2, d / 2 - T / 2, T, F, F + H, front, 'wood', 'wallInt');
    this.windowFrame(-4, F + 0.6, F + 2.6, 3.2, d / 2, 1, true, false);
    this.windowFrame(4, F + 0.6, F + 2.6, 3.2, d / 2, 1, true, false);
    b.push([0, 0, -d / 2 + T / 2], Math.PI);
    b.wall('white', -w / 2, w / 2, 0, T, F, F + H, [{ x: -4, w: 1.1, y0: F, y1: F + 2.1 }], 'wood', 'wallInt');
    b.pop();
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall('white', -d / 2 + T, d / 2 - T, 0, T, F, F + H, [{ x: 0, w: 1.2, y0: F + 1.0, y1: F + 2.4 }], 'wood', 'wallInt');
      this.windowFrame(0, F + 1.0, F + 2.4, 1.2, T / 2, 1, s > 0);
      b.pop();
    }
    b.box('roofMetal', -w / 2 - 0.4, F + H, -d / 2 - 0.4, w / 2 + 0.4, F + H + 0.3, d / 2 + 1.9, 'metal');
    b.box('trim', -w / 2 - 0.42, F + H - 0.1, d / 2 + 1.7, w / 2 + 0.42, F + H + 0.35, d / 2 + 1.95);
    b.box('wallInt', -w / 2 + T, F + H - 0.05, -d / 2 + T, w / 2 - T, F + H, d / 2 - T);
    // canopy posts
    for (const x of [-w / 2 + 0.3, w / 2 - 0.3]) b.box('steel', x - 0.08, F, d / 2 + 1.6, x + 0.08, F + H, d / 2 + 1.76, 'metal');
    // sign
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const x = c.getContext('2d')!;
    x.fillStyle = '#b8241c'; x.fillRect(0, 0, 512, 96);
    x.fillStyle = '#fff'; x.font = 'bold 54px "Barlow Condensed", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('KVITVIKA HANDEL', 256, 52);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    sign.position.set(0, F + H + 0.75, d / 2 + 1.97);
    sign.applyMatrix4(this.b.m);
    this.extraMeshes.push(sign);
    b.box('steel', -3.05, F + H + 0.15, d / 2 + 1.9, 3.05, F + H + 1.35, d / 2 + 1.95);
    this.furniture('shop', 1.5, F, -2.5, 0);
    this.fixture(-3, F + H - 0.05, 0, 'strip');
    this.fixture(3, F + H - 0.05, 0, 'strip');
    b.box('wood', -5.5, F, -1.5, -3.5, F + 1.0, 0.5, 'wood'); // counter
    this.link(0, F, d / 2 + 3, 0, F, d / 2 - 1.5);
    this.steps(4, -d / 2 - 0.1, 0, -1, 1.6, F, 2);
    this.link(4, F, -d / 2 - 1.8, 4, F, -d / 2 + 1.5);
  }
  extraMeshes: THREE.Object3D[] = [];

  private warehouse(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 40, d = def.d ?? 22, H = 9, T = 0.25;
    const tint = def.name === 'Lager 1' ? 'corrBlue' : 'corrWhite';
    b.box('concrete', -w / 2, -0.3, -d / 2, w / 2, 0.15, d / 2, 'concrete');
    // long walls with high window strips and a side door
    for (const s of [1, -1]) {
      b.push([0, 0, s * (d / 2 - T / 2)], s > 0 ? 0 : Math.PI);
      const ops: Op[] = [{ x: s > 0 ? -6 : 8, w: 4.5, y0: 0.15, y1: 4.8 }, { x: s > 0 ? 10 : -10, w: 1.1, y0: 0.15, y1: 2.3 }];
      for (let i = 0; i < 6; i++) ops.push({ x: -w / 2 + 3.4 + i * ((w - 6.8) / 5), w: 2.2, y0: 6.2, y1: 7.4 });
      const dd = ops.filter((o) => o.y0 > 1).map((o) => o);
      b.wall(tint, -w / 2, w / 2, 0, T, 0.15, H, ops.sort((a, c) => a.x - c.x).filter((o, i, arr) => !(i > 0 && Math.abs(arr[i - 1].x - o.x) < (arr[i - 1].w + o.w) / 2)), 'metal', 'corrInner');
      for (const o of dd) this.windowFrame(o.x, o.y0, o.y1, o.w, T / 2, 1, true, false);
      b.pop();
    }
    // gable ends with big doors
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall(tint, -d / 2 + T, d / 2 - T, 0, T, 0.15, H, [{ x: 0, w: 6.5, y0: 0.15, y1: 5.6 }], 'metal', 'corrInner');
      b.box('steel', -3.6, 5.6, 0.1, 3.6, 6.0, 0.3);
      b.gable(tint, -d / 2, d / 2, 0, T, H, 2.2, 'metal');
      b.pop();
      this.link(s * (w / 2 + 3), 0.15, 0, s * (w / 2 - 3), 0.15, 0);
    }
    // roof (low pitch)
    const pitch = Math.atan2(2.2, d / 2);
    for (const s of [1, -1]) b.obox('roofMetal', [0, H + 1.1 + 0.1, (s * d) / 4], [w + 0.6, 0.12, d / 2 / Math.cos(pitch) + 0.4], new THREE.Euler(s * pitch, 0, 0), 'metal');
    // steel frame columns & trusses
    for (let x = -w / 2 + 4; x < w / 2 - 2; x += 6) {
      for (const s of [1, -1]) b.box('steel', x - 0.15, 0.15, s * (d / 2 - 0.55), x + 0.15, H, s * (d / 2 - 0.25), 'metal');
      b.box('steel', x - 0.1, H - 0.4, -d / 2 + 0.3, x + 0.1, H - 0.1, d / 2 - 0.3);
    }
    // mezzanine catwalk along the back wall with stairs
    const cw = 3.0, ch = 4.2;
    b.box('steelGrate', -w / 2 + 1, ch - 0.12, -d / 2 + T, w / 2 - 1, ch, -d / 2 + T + cw, 'metal');
    const run = 6.5;
    const sx0 = w / 2 - 2 - run;
    const gap0 = sx0 + run - 0.2; // railing opening onto the landing at the stair head
    b.box('steel', -w / 2 + 1, ch, -d / 2 + T + cw - 0.06, gap0, ch + 1.05, -d / 2 + T + cw, 'metal');
    for (let x = -w / 2 + 2; x < w / 2 - 1; x += 6) if (x < gap0 - 0.3) b.box('steel', x - 0.1, 0.15, -d / 2 + T + cw - 0.2, x + 0.1, ch, -d / 2 + T + cw, 'metal');
    b.box('steel', w / 2 - 1.2, 0.15, -d / 2 + T + cw + 1.0, w / 2 - 1.0, ch, -d / 2 + T + cw + 1.2, 'metal'); // landing post
    // top landing beside the stair, flush with the catwalk
    b.box('steelGrate', sx0 + run, ch - 0.12, -d / 2 + T + cw - 0.01, w / 2 - 1, ch, -d / 2 + T + cw + 1.2, 'metal');
    b.box('steel', w / 2 - 1.06, ch, -d / 2 + T, w / 2 - 1, ch + 1.05, -d / 2 + T + cw + 1.2, 'metal'); // end rail
    for (let i = 0; i < 18; i++) b.box('steelGrate', sx0 + (i * run) / 18, (i * ch) / 18, -d / 2 + T + cw, sx0 + ((i + 1) * run) / 18, ((i + 1) * ch) / 18 + 0.04, -d / 2 + T + cw + 1.2);
    b.obox(null, [sx0 + run / 2, ch / 2, -d / 2 + T + cw + 0.6], [Math.hypot(run, ch), 0.1, 1.2], new THREE.Euler(0, 0, Math.atan2(ch, run)), 'metal');
    this.link(sx0 - 1, 0.15, -d / 2 + T + cw + 0.6, sx0 + run + 0.4, ch, -d / 2 + T + cw + 0.6);
    this.link(sx0 + run + 0.4, ch, -d / 2 + T + cw + 0.6, sx0 + run - 0.5, ch, -d / 2 + T + 1.5);
    this.point(0, ch, -d / 2 + T + 1.5);
    // cargo inside: crates & pallets as cover
    const rng = new RNG(77 + Math.round(w));
    for (let i = 0; i < 14; i++) {
      const x = rng.range(-w / 2 + 3, w / 2 - 3), z = rng.range(-d / 2 + cw + 2, d / 2 - 2.5);
      if (Math.abs(z) < 3.5 && Math.abs(x) > w / 2 - 6) continue;
      const sx = rng.range(1.0, 2.4), sz = rng.range(1.0, 2.0), sy = rng.range(0.9, 1.9);
      b.box(rng.chance(0.5) ? 'crate' : 'pallet', x - sx / 2, 0.15, z - sz / 2, x + sx / 2, 0.15 + sy, z + sz / 2, 'wood');
      if (rng.chance(0.35)) b.box('crate', x - sx / 3, 0.15 + sy, z - sz / 3, x + sx / 3, 0.15 + sy + 0.9, z + sz / 3, 'wood');
    }
    for (const fx of [-w / 3, 0, w / 3]) this.fixture(fx, H + 0.9, 2, 'bay');
    this.point(0, 0.15, 3);
  }

  /** Shipping container (6.06 x 2.59 x 2.44), optionally open at the +x end. */
  container(color: string, x: number, y: number, z: number, rot: number, open = false) {
    const b = this.b;
    const L = 6.06, W = 2.44, H = 2.59, t = 0.06;
    b.push([x, y, z], rot);
    if (!open) b.box(color, -L / 2, 0, -W / 2, L / 2, H, W / 2, 'metal');
    else {
      b.box(color, -L / 2, 0, -W / 2, L / 2, t, W / 2, 'metal');
      b.box(color, -L / 2, H - t, -W / 2, L / 2, H, W / 2, 'metal');
      b.box(color, -L / 2, 0, -W / 2, L / 2, H, -W / 2 + t, 'metal');
      b.box(color, -L / 2, 0, W / 2 - t, L / 2, H, W / 2, 'metal');
      b.box(color, -L / 2, 0, -W / 2, -L / 2 + t, H, W / 2, 'metal');
      // open doors swung out
      b.box(color, L / 2, 0.05, W / 2, L / 2 + 0.05, H - 0.05, W / 2 + 1.2, 'metal');
      b.box(color, L / 2, 0.05, -W / 2 - 1.2, L / 2 + 0.05, H - 0.05, -W / 2, 'metal');
      this.link(L / 2 + 1.5, 0.05, 0, 0, 0.05, 0);
    }
    // corner castings & door bars
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0, 1]) b.box('steel', sx * L / 2 - (sx > 0 ? 0.18 : 0), sy * (H - 0.12), sz * W / 2 - (sz > 0 ? 0.18 : 0), sx * L / 2 + (sx > 0 ? 0 : 0.18), sy * (H - 0.12) + 0.12, sz * W / 2 + (sz > 0 ? 0 : 0.18));
    if (!open) for (const zz of [-0.7, -0.3, 0.3, 0.7]) b.box('steel', L / 2, 0.1, zz - 0.02, L / 2 + 0.04, H - 0.1, zz + 0.02);
    b.pop();
  }

  private containers(def: BuildingDef) {
    const rng = new RNG(def.seed ?? 5);
    const colors = ['contRed', 'contBlue', 'contGreen', 'contOrange', 'contGrey', 'contWhite'];
    const rows = def.seed === 31 ? 4 : 3;
    for (let r = 0; r < rows; r++) {
      // decide occupancy first so open containers only face free space (row ends or gaps)
      const occ = Array.from({ length: 4 }, () => !rng.chance(0.18));
      for (let c = 0; c < 4; c++) {
        if (!occ[c]) continue;
        const x = -10 + c * 7.2 + rng.range(-0.3, 0.3), z = -9 + r * 6.2 + rng.range(-0.2, 0.2);
        const stack = rng.int(1, 3);
        const freeE = c === 3 || !occ[c + 1], freeW = c === 0 || !occ[c - 1];
        const wantOpen = rng.chance(0.4) && (freeE || freeW);
        const flip = wantOpen && !freeE; // open end faces -x
        for (let k = 0; k < stack; k++) {
          const isOpen = k === 0 && wantOpen;
          this.container(rng.pick(colors), x + (k ? rng.range(-0.2, 0.2) : 0), k * 2.6, z, (isOpen && flip ? Math.PI : 0) + rng.range(-0.04, 0.04), isOpen);
        }
        this.point(x, 0, z + 3.1);
      }
    }
  }

  private crane() {
    const b = this.b;
    const gw = 10, gd = 8, H = 22;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.box('yellowSteel', sx * gw / 2 - 0.5, 0, sz * gd / 2 - 0.5, sx * gw / 2 + 0.5, H, sz * gd / 2 + 0.5, 'metal');
      b.box('steel', sx * gw / 2 - 0.7, 0, sz * gd / 2 - 1.2, sx * gw / 2 + 0.7, 0.9, sz * gd / 2 + 1.2, 'metal');
    }
    for (const sx of [-1, 1]) {
      b.box('yellowSteel', sx * gw / 2 - 0.5, H - 1.2, -gd / 2 - 0.5, sx * gw / 2 + 0.5, H, gd / 2 + 0.5, 'metal');
      for (let i = 0; i < 4; i++) {
        const y = 3 + i * 4.5;
        b.obox('yellowSteel', [sx * gw / 2, y + 2.2, 0], [0.25, 0.25, Math.hypot(gd, 4.5)], new THREE.Euler(Math.atan2(4.5, gd) * (i % 2 ? 1 : -1), 0, 0));
      }
    }
    for (const sz of [-1, 1]) b.box('yellowSteel', -gw / 2 - 0.5, H - 1.0, sz * gd / 2 - 0.5, gw / 2 + 0.5, H, sz * gd / 2 + 0.5, 'metal');
    // boom over the water (-x) and counter jib
    b.box('yellowSteel', -38, H + 0.5, -1.2, 14, H + 2.4, 1.2, 'metal');
    for (let x = -37; x < 13; x += 3) b.box('redSteel', x, H + 2.4, -1.25, x + 1.5, H + 2.5, 1.25);
    b.box('steel', 8, H + 2.4, -2.5, 14, H + 5.4, 2.5, 'metal'); // counterweight / machinery
    b.box('white', -2, H - 4.5, gd / 2 - 0.6, 2.5, H - 1.0, gd / 2 + 2.2, 'metal'); // cabin
    const wm = this.b.m.clone().multiply(new THREE.Matrix4().setPosition(0.25, H - 2.6, gd / 2 + 2.25));
    this.glass.add(this.physics, wm, 3.8, 1.6);
    // ladder
    for (let y = 0.6; y < H - 1; y += 0.35) b.box('steel', gw / 2 + 0.55, y, gd / 2 - 0.3, gw / 2 + 0.6, y + 0.04, gd / 2 + 0.3);
    b.box(null, gw / 2 + 0.5, 0, gd / 2 - 0.35, gw / 2 + 0.75, H - 1, gd / 2 + 0.35, 'metal');
    // hook & cable
    b.box('steel', -30.05, H - 9, -0.05, -29.95, H + 0.5, 0.05);
    b.box('redSteel', -30.5, H - 10, -0.4, -29.5, H - 9, 0.4, 'metal');
    // rails on the quay
    for (const sz of [-1, 1]) b.box('steel', -30, 0.0, sz * gd / 2 - 0.08, 30, 0.08, sz * gd / 2 + 0.08);
  }

  private office(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 12, d = def.d ?? 9, FH = 3.2, T = 0.25, floors = 2;
    b.box('concrete', -w / 2, -2, -d / 2, w / 2, 0.3, d / 2, 'concrete');
    for (let f = 0; f < floors; f++) {
      const y0 = 0.3 + f * FH, y1 = y0 + FH;
      const ops: Op[] = [-3.6, -1.2, 1.2, 3.6].map((x) => ({ x, w: 1.6, y0: y0 + 0.9, y1: y0 + 2.4 }));
      if (f === 0) ops[1] = { x: -1.2, w: 1.2, y0, y1: y0 + 2.2 };
      b.wall('concreteWhite', -w / 2, w / 2, d / 2 - T / 2, T, y0, y1, ops, 'concrete', 'wallInt');
      for (const o of ops) if (o.y0 > y0 + 0.1) this.windowFrame(o.x, o.y0, o.y1, o.w, d / 2, 1, true, false);
      b.push([0, 0, -d / 2 + T / 2], Math.PI);
      b.wall('concreteWhite', -w / 2, w / 2, 0, T, y0, y1, [{ x: 0, w: 1.6, y0: y0 + 0.9, y1: y0 + 2.4 }], 'concrete', 'wallInt');
      this.windowFrame(0, y0 + 0.9, y0 + 2.4, 1.6, T / 2, 1, true, false);
      b.pop();
      for (const s of [1, -1]) {
        b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
        b.wall('concreteWhite', -d / 2 + T, d / 2 - T, 0, T, y0, y1, [{ x: 0, w: 1.6, y0: y0 + 0.9, y1: y0 + 2.4 }], 'concrete', 'wallInt');
        this.windowFrame(0, y0 + 0.9, y0 + 2.4, 1.6, T / 2, 1, f === 1);
        b.pop();
      }
    }
    // floor 2 slab with stair hole, roof
    b.box('concrete', -w / 2 + T, 0.3 + FH - 0.25, -d / 2 + T, w / 2 - T - 1.4, 0.3 + FH, d / 2 - T, 'concrete');
    b.box('concrete', w / 2 - T - 1.4, 0.3 + FH - 0.25, -d / 2 + T, w / 2 - T, 0.3 + FH, -d / 2 + T + 1.0, 'concrete');
    b.box('concrete', -w / 2 - 0.2, 0.3 + FH * 2, -d / 2 - 0.2, w / 2 + 0.2, 0.3 + FH * 2 + 0.35, d / 2 + 0.2, 'concrete');
    b.box('steel', -w / 2 - 0.2, 0.3 + FH * 2 + 0.35, -d / 2 - 0.2, w / 2 + 0.2, 0.3 + FH * 2 + 0.6, -d / 2, 'metal');
    const run = d - 2 * T - 1.4;
    const ang = Math.atan2(FH, run);
    for (let i = 0; i < 16; i++) b.box('concrete', w / 2 - T - 1.35, 0.3 + (i * FH) / 16, d / 2 - T - ((i + 1) * run) / 16, w / 2 - T, 0.3 + ((i + 1) * FH) / 16, d / 2 - T - (i * run) / 16);
    b.obox(null, [w / 2 - T - 0.68, 0.3 + FH / 2 - 0.05, d / 2 - T - run / 2], [1.3, 0.1, Math.hypot(FH, run)], new THREE.Euler(ang, 0, 0), 'concrete');
    this.furniture('office', -2, 0.3, -1.5);
    this.furniture('office', 2, 0.3 + FH, -1.5);
    this.fixture(-2, 0.3 + FH - 0.26, 0, 'strip');
    this.fixture(2, 0.3 + FH * 2 - 0.02, 0, 'strip');
    this.link(-1.2, 0.3, d / 2 + 2, -1.2, 0.3, d / 2 - 1.5);
    this.link(w / 2 - 1, 0.3, d / 2 - 1, w / 2 - 1, 0.3 + FH, -d / 2 + 1.5);
  }

  private bunker(def: BuildingDef) {
    const b = this.b;
    const w = 9, d = 7, H = 2.6, T = 0.9;
    // floor sits just above the pad: a sunken floor ended up under the terrain mesh
    const fl = 0.15;
    b.box('concrete', -w / 2 - 0.5, fl - 0.6, -d / 2 - 0.5, w / 2 + 0.5, fl, d / 2 + 0.5, 'concrete');
    // front (+z) with embrasure slit
    b.wall('concrete', -w / 2, w / 2, d / 2 - T / 2, T, fl, H, [{ x: 0, w: 4.0, y0: fl + 1.25, y1: fl + 1.85 }], 'concrete');
    b.push([0, 0, -d / 2 + T / 2], Math.PI);
    b.wall('concrete', -w / 2, w / 2, 0, T, fl, H, [{ x: -(w / 2 - 1.8), w: 1.3, y0: fl, y1: fl + 2.1 }], 'concrete');
    b.pop();
    // (Update 33) a red rotating emergency beacon over the door
    {
      const bx = w / 2 - 1.8, by = fl + 2.3, bz = -d / 2 - 0.08;
      b.box('steel', bx - 0.09, by - 0.04, bz - 0.14, bx + 0.09, by, bz);
      b.cyl('tail', bx, by, bz - 0.07, 0.06, 0.12, 10);
      this.fixtures.push({ p: new THREE.Vector3(bx, by + 0.1, bz - 0.4).applyMatrix4(b.m), color: 0xff2a14, intensity: 7, dist: 10, flicker: 'beacon' });
    }
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall('concrete', -d / 2 + T, d / 2 - T, 0, T, fl, H, [], 'concrete');
      b.pop();
    }
    b.box('concrete', -w / 2 - 0.6, H, -d / 2 - 0.6, w / 2 + 0.6, H + 1.0, d / 2 + 1.0, 'concrete'); // roof slab
    // splayed embrasure cheeks
    b.obox('concrete', [-2.6, fl + 1.55, d / 2 + 0.3], [0.5, 1.6, 1.4], new THREE.Euler(0, 0.6, 0), 'concrete');
    b.obox('concrete', [2.6, fl + 1.55, d / 2 + 0.3], [0.5, 1.6, 1.4], new THREE.Euler(0, -0.6, 0), 'concrete');
    // entrance: blast wall flanking the back door, steps down to whatever the ground does
    this.steps(w / 2 - 1.8, -d / 2 - 0.5, 0, -1, 1.6, fl);
    b.box('concrete', w / 2 - 2.9, fl - 0.4, -d / 2 - 2.6, w / 2 - 2.6, fl + 1.4, -d / 2 - 0.5, 'concrete');
    b.box('concrete', w / 2 - 1.0, fl - 0.4, -d / 2 - 2.6, w / 2 - 0.7, fl + 1.4, -d / 2 - 0.5, 'concrete');
    // interior: ammo crates, bench, rusty gun mount
    b.box('crate', -w / 2 + T + 0.2, fl, -d / 2 + T + 0.2, -w / 2 + T + 1.4, fl + 0.7, -d / 2 + T + 1.0, 'wood');
    b.box('crate', -w / 2 + T + 0.2, fl + 0.7, -d / 2 + T + 0.3, -w / 2 + T + 1.2, fl + 1.2, -d / 2 + T + 0.9, 'wood');
    b.cyl('rust', 0, fl, 0.8, 0.5, 0.9, 12, 'metal');
    b.obox('rust', [0, fl + 1.35, 2.2], [0.22, 0.22, 3.2], new THREE.Euler(0.02, 0, 0));
    this.link(w / 2 - 1.8, fl, -d / 2 - 3.6, w / 2 - 1.8, fl, -d / 2 + 1.5);
    this.point(0, fl, 0);
    this.fixture(0, H, -1, 'bare');
    // camo netting slab on top as cover
    b.box('sandbag', -2, H + 1.0, d / 2 - 0.2, 2, H + 1.45, d / 2 + 0.6, 'fabric');
    void def;
  }

  private gunpit() {
    const b = this.b;
    const R = 5, n = 18;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (i === 0 || i === 1) continue; // entrance gap
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      b.obox('concrete', [x, 0.2, z], [0.8, 2.0, 1.9], new THREE.Euler(0, -a, 0), 'concrete');
    }
    b.box('concrete', -R, -0.9, -R, R, -0.7, R, 'concrete');
    b.cyl('rust', 0, -0.7, 0, 1.2, 0.8, 16, 'metal');
    b.box('rust', -1.0, 0.1, -1.0, 1.0, 1.4, 1.0, 'metal'); // gun shield
    b.obox('rust', [0, 1.0, 3.2], [0.32, 0.32, 5.5], new THREE.Euler(-0.08, 0, 0));
    b.obox('rust', [0, 1.15, 5.9], [0.42, 0.42, 0.6], new THREE.Euler(-0.08, 0, 0));
    this.point(0, -0.7, 0);
  }

  private barracks(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 16, d = def.d ?? 8, H = 3.2, T = 0.3;
    const rng = new RNG(88);
    b.box('concrete', -w / 2, -1.5, -d / 2, w / 2, 0.2, d / 2, 'concrete');
    const ruinTop = (x: number) => H - (Math.abs(Math.sin(x * 1.7)) * 1.2 + (x > 2 ? 1.0 : 0));
    for (const s of [1, -1]) {
      b.push([0, 0, s * (d / 2 - T / 2)], s > 0 ? 0 : Math.PI);
      for (let x = -w / 2; x < w / 2; x += 2) {
        const hasWin = Math.round((x + w / 2) / 2) % 2 === 1;
        const yTop = ruinTop(x * s);
        if (hasWin) {
          b.box('concreteWhite', x, 0.2, -T / 2, x + 2, 1.1, T / 2, 'concrete');
          if (yTop > 2.4) b.box('concreteWhite', x, 2.3, -T / 2, x + 2, yTop, T / 2, 'concrete');
          b.box('concreteWhite', x, 1.1, -T / 2, x + 0.4, Math.min(2.3, yTop), T / 2, 'concrete');
          b.box('concreteWhite', x + 1.6, 1.1, -T / 2, x + 2, Math.min(2.3, yTop), T / 2, 'concrete');
        } else if (!(s > 0 && Math.abs(x) < 1)) b.box('concreteWhite', x, 0.2, -T / 2, x + 2, yTop, T / 2, 'concrete');
      }
      b.pop();
    }
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall('concreteWhite', -d / 2 + T, d / 2 - T, 0, T, 0.2, s > 0 ? H : H - 0.8, [{ x: 0, w: 1.0, y0: 0.2, y1: 2.2 }], 'concrete');
      b.pop();
    }
    // partial roof slab & rubble
    b.box('concrete', -w / 2, H, -d / 2, -1, H + 0.25, d / 2, 'concrete');
    for (let i = 0; i < 12; i++) {
      const x = rng.range(-w / 2 + 1, w / 2 - 1), z = rng.range(-d / 2 + 1, d / 2 - 1), s = rng.range(0.3, 0.9);
      b.obox('concrete', [x, 0.2 + s * 0.3, z], [s * 1.6, s * 0.6, s], new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.3, 0.3)), s > 0.6 ? 'concrete' : null);
    }
    this.steps(1, d / 2, 0, 1, 2.2, 0.2);
    for (const s of [1, -1]) this.steps(s * w / 2, 0, s, 0, 1.4, 0.2);
    this.link(1, 0.2, d / 2 + 2, 1, 0.2, 0);
    this.link(w / 2 + 2, 0.2, 0, w / 2 - 2, 0.2, 0);
    this.link(-w / 2 - 2, 0.2, 0, -w / 2 + 2, 0.2, 0);
  }

  private mast() {
    const b = this.b;
    const H = 32, base = 3.2, topW = 0.8;
    const lerpW = (y: number) => base + (topW - base) * (y / H);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p0 = new THREE.Vector3(sx * base / 2, 0, sz * base / 2), p1 = new THREE.Vector3(sx * topW / 2, H, sz * topW / 2);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const dir = p1.clone().sub(p0);
      const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
      b.obox('redSteel', [mid.x, mid.y, mid.z], [0.16, dir.length(), 0.16], e, 'metal');
    }
    for (let y = 2; y < H; y += 3) {
      const ww = lerpW(y);
      for (const s of [1, -1]) {
        b.box(y % 6 < 3 ? 'redSteel' : 'white', -ww / 2, y, s * ww / 2 - 0.05, ww / 2, y + 0.1, s * ww / 2 + 0.05);
        b.box(y % 6 < 3 ? 'redSteel' : 'white', s * ww / 2 - 0.05, y, -ww / 2, s * ww / 2 + 0.05, y + 0.1, ww / 2);
      }
    }
    b.box('white', -0.4, H, -0.4, 0.4, H + 3, 0.4);
    b.box('steel', -1.5, 0, 2.5, 1.5, 2.4, 4.5, 'metal'); // equipment hut
  }


  /**
   * Lighthouse (Fyret): stone plinth, tapered white tower with two red bands, a gallery deck with
   * railings (reached by the ladder on the +z face — the railing has a gap there), and a glazed
   * lantern room with a red cap. The lamp is a light fixture (it can be shot out).
   */
  private lighthouse() {
    const b = this.b;
    b.cyl('stone', 0, -1.2, 0, 3.4, 2.2, 14, 'rock');
    b.cyl('white', 0, 1.0, 0, 2.3, 15.2, 18, 'concrete', 1.7);
    // red bands (a touch proud of the wall; radius follows the taper)
    const rAt = (y: number) => 2.3 + (1.7 - 2.3) * ((y - 1.0) / 15.2);
    for (const [y0, y1] of [[5.6, 7.6], [11.0, 13.0]] as const) b.cyl('red', 0, y0, 0, rAt(y0) + 0.03, y1 - y0, 18, null, rAt(y1) + 0.03);
    // door and two slit windows
    b.box('door', -0.55, 1.0, -2.36, 0.55, 3.0, -2.2);
    for (const y of [7.8, 12.2]) b.box('glass', -0.2, y, -rAt(y) - 0.04, 0.2, y + 0.9, -rAt(y) + 0.1);
    // gallery deck + railings (gap on +z for the ladder)
    const D = 2.9, Y = 16.2;
    // deck with a hatch over the ladder (+z side) so the climber comes up through it
    b.box('concrete', -D, Y, -D, D, Y + 0.25, 1.9, 'concrete');
    b.box('concrete', -D, Y, 1.9, -0.6, Y + 0.25, D, 'concrete');
    b.box('concrete', 0.6, Y, 1.9, D, Y + 0.25, D, 'concrete');
    const rail = (x0: number, z0: number, x1: number, z1: number) => b.box('redSteel', x0, Y + 0.25, z0, x1, Y + 1.25, z1, 'metal');
    rail(-D, -D, D, -D + 0.06);
    rail(-D, -D, -D + 0.06, D);
    rail(D - 0.06, -D, D, D);
    rail(-D, D - 0.06, -0.6, D);
    rail(0.6, D - 0.06, D, D);
    // lantern room and cap
    b.cyl('steel', 0, Y + 0.25, 0, 1.35, 0.5, 14, 'metal');
    b.cyl('glass', 0, Y + 0.75, 0, 1.25, 2.0, 14, 'glass');
    b.cyl('redSteel', 0, Y + 2.75, 0, 1.45, 0.9, 14, null, 0.18);
    b.box('bulb', -0.3, Y + 1.3, -0.3, 0.3, Y + 1.9, 0.3);
    this.fixtures.push({ p: new THREE.Vector3(0, Y + 1.6, 0).applyMatrix4(b.m), color: 0xfff0c8, intensity: 14, dist: 26, m: b.m.clone(), min: new THREE.Vector3(-0.3, Y + 1.3, -0.3), max: new THREE.Vector3(0.3, Y + 1.9, 0.3) });
  }

  /** Wooden watchtower: four braced legs, a plank platform with chest-high walls, a roof. Ladder on +z. */
  private tower() {
    const b = this.b;
    const H = 6.4, A = 1.45;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('woodRaw', sx * A - 0.1, -0.4, sz * A - 0.1, sx * A + 0.1, H + 2.3, sz * A + 0.1, 'wood');
    // cross bracing on all four sides (visual)
    for (const side of [0, 1, 2, 3]) {
      b.push([0, 0, 0], side * (Math.PI / 2));
      for (const [y0, y1] of [[0.3, 3.2], [3.2, 6.1]] as const) {
        const L = Math.hypot(2 * A, y1 - y0);
        b.obox('woodRaw', [0, (y0 + y1) / 2, A], [L, 0.09, 0.06], new THREE.Euler(0, 0, Math.atan2(y1 - y0, 2 * A)));
      }
      b.pop();
    }
    b.box('planks', -A - 0.2, H, -A - 0.2, A + 0.2, H + 0.15, A + 0.2, 'wood');
    // walls: solid planks to chest height on three sides, the ladder side open in the middle
    const wl = (x0: number, z0: number, x1: number, z1: number) => b.box('planks', x0, H + 0.15, z0, x1, H + 1.15, z1, 'wood');
    wl(-A - 0.2, -A - 0.2, A + 0.2, -A - 0.1);
    wl(-A - 0.2, -A - 0.2, -A - 0.1, A + 0.2);
    wl(A + 0.1, -A - 0.2, A + 0.2, A + 0.2);
    wl(-A - 0.2, A + 0.1, -0.5, A + 0.2);
    wl(0.5, A + 0.1, A + 0.2, A + 0.2);
    // roof
    b.box('roof', -A - 0.4, H + 2.3, -A - 0.4, A + 0.4, H + 2.45, A + 0.4, 'wood');
  }

  /** Radar station: concrete equipment building with a walkable roof (ladder on +z), pedestal and dome. */
  private radome() {
    const b = this.b;
    b.box('concrete', -4, -1.5, -4, 4, 3.3, 4, 'concrete');
    b.box('dkgrey', -0.6, 0.0, -4.05, 0.6, 2.2, -3.95);
    for (const sx of [-1, 1]) b.box('concreteWhite', sx * 4 - 0.1, 3.3, -4, sx * 4 + 0.1, 3.9, 4, 'concrete');
    b.box('concreteWhite', -4, 3.3, -4, 4, 3.9, -3.8, 'concrete');
    b.cyl('steel', 0, 3.3, -1.2, 1.6, 2.2, 14, 'metal');
    const dome = new THREE.SphereGeometry(3.3, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
    b.addGeo('white', dome, new THREE.Matrix4().setPosition(0, 6.6, -1.2));
    b.box(null, -2.6, 5.4, -3.8, 2.6, 9.6, 1.4, 'metal');
    b.box('steel', 2.4, 3.3, 1.6, 3.6, 4.4, 3.2, 'metal'); // equipment cabinet on the roof (cover)
  }

  private barn(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 16, d = def.d ?? 11, H = 4.5, T = 0.2;
    b.box('stone', -w / 2, -2, -d / 2, w / 2, 0.3, d / 2, 'rock');
    for (const s of [1, -1]) {
      b.push([0, 0, s * (d / 2 - T / 2)], s > 0 ? 0 : Math.PI);
      b.wall('red', -w / 2, w / 2, 0, T, 0.3, H, [{ x: -4, w: 1.0, y0: 2.4, y1: 3.4 }, { x: 4, w: 1.0, y0: 2.4, y1: 3.4 }, { x: 0, w: 1.2, y0: 0.3, y1: 2.3 }], 'wood', 'wallInt');
      this.windowFrame(-4, 2.4, 3.4, 1.0, T / 2, 1, false);
      this.windowFrame(4, 2.4, 3.4, 1.0, T / 2, 1, false);
      b.pop();
    }
    for (const s of [1, -1]) this.steps(0, s * d / 2, 0, s, 1.8, 0.3);
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall('red', -d / 2 + T, d / 2 - T, 0, T, 0.3, H, [{ x: 0, w: 3.6, y0: 0.3, y1: 3.6 }], 'wood', 'wallInt');
      // white X-braced barn door frame
      b.box('trim', -1.9, 0.3, 0.1, -1.75, 3.7, 0.16);
      b.box('trim', 1.75, 0.3, 0.1, 1.9, 3.7, 0.16);
      b.box('trim', -1.9, 3.6, 0.1, 1.9, 3.75, 0.16);
      b.gable('red', -d / 2, d / 2, 0, T, H, 4.0, 'wood');
      b.pop();
      this.steps(s * w / 2, 0, s, 0, 4.2, 0.3);
      this.link(s * (w / 2 + 2.5), 0.3, 0, s * (w / 2 - 2.5), 0.3, 0);
    }
    // gambrel-ish roof
    for (const s of [1, -1]) {
      b.obox('roofMetal', [0, H + 1.2, s * (d / 4 + 0.3)], [w + 0.8, 0.12, d / 2 + 1.2], new THREE.Euler(s * 0.68, 0, 0), 'metal');
    }
    // hayloft with ladder
    b.box('planks', -w / 2 + T, 2.3, -d / 2 + T, -1.5, 2.45, d / 2 - T, 'wood');
    for (let y = 0.6; y < 2.4; y += 0.32) b.box('woodRaw', -1.4, y, -0.5, -1.35, y + 0.05, 0.5);
    b.obox(null, [-0.6, 1.35, 0], [2.5, 0.08, 1.0], new THREE.Euler(0, 0, -0.95), 'wood');
    // hay bales
    const rng = new RNG(19);
    for (let i = 0; i < 6; i++) b.box('hay', -w / 2 + 1 + i * 1.3, 2.45, -d / 2 + 1, -w / 2 + 2.1 + i * 1.3, 3.25, -d / 2 + 2.4, 'fabric');
    for (let i = 0; i < 5; i++) b.cyl('wrap', 4 + rng.range(-1, 1) + i * 0.1, 0.3, -3 + i * 1.45, 0.75, 1.2, 14, 'fabric');
    this.fixture(2, H - 0.05, 0, 'bare');
    this.point(2, 0.3, 0);
  }

  private naust(def: BuildingDef) {
    const b = this.b;
    const w = def.w ?? 6, d = def.d ?? 9, H = 2.6, T = 0.15;
    b.box('stone', -w / 2, -1.5, -d / 2, w / 2, 0.2, d / 2, 'rock');
    for (const s of [1, -1]) {
      b.push([s * (w / 2 - T / 2), 0, 0], (s * Math.PI) / 2);
      b.wall(def.color ?? 'red', -d / 2, d / 2, 0, T, 0.2, H, [], 'wood');
      b.pop();
    }
    b.push([0, 0, -d / 2 + T / 2], Math.PI);
    b.wall(def.color ?? 'red', -w / 2 + T, w / 2 - T, 0, T, 0.2, H, [{ x: 0, w: 0.9, y0: 0.2, y1: 2.1 }], 'wood');
    b.pop();
    b.wall(def.color ?? 'red', -w / 2 + T, w / 2 - T, d / 2 - T / 2, T, 0.2, H, [{ x: 0, w: 3.2, y0: 0.2, y1: 2.5 }], 'wood');
    // roof ridge along depth
    b.push([0, 0, 0], Math.PI / 2);
    const rise = this.gableRoof(d, w, H, 0.75, 0.3, 'roof');
    b.pop();
    b.gable(def.color ?? 'red', -w / 2, w / 2, d / 2 - T / 2, T, H, rise, 'wood');
    b.gable(def.color ?? 'red', -w / 2, w / 2, -d / 2 + T / 2, T, H, rise, 'wood');
    // boat on its trestles along the left wall, leaving a walkway past the big door
    this.boat(-w / 2 + 1.3, 0.2, -0.3, Math.PI / 2, 0.7);
    this.steps(0, d / 2, 0, 1, 3.4, 0.2);
    this.steps(0, -d / 2, 0, -1, 1.3, 0.2);
    this.link(0.9, 0.2, d / 2 + 2, 0.9, 0.2, 0);
    this.link(0.9, 0.2, 0, 0, 0.2, -d / 2 - 1.6);
  }

  private tanks() {
    const b = this.b;
    for (const [x, z, r, h] of [[-7, 0, 4.5, 9], [5, -1, 4, 8], [14, 1, 3, 6]] as const) {
      b.cyl('tankWhite', x, 0, z, r, h, 28, 'metal');
      b.cyl('steel', x, h, z, r + 0.1, 0.25, 28, null, r * 0.6);
      for (let y = 0.5; y < h; y += 0.4) b.box('steel', x + r + 0.05, y, z - 0.25, x + r + 0.1, y + 0.04, z + 0.25);
      b.box('concrete', x - r - 0.6, -0.5, z - r - 0.6, x + r + 0.6, 0.15, z + r + 0.6, 'concrete');
    }
    b.box('steel', -12, 1.2, 3.6, 18, 1.4, 3.8); // pipe rack
    for (let x = -10; x < 18; x += 5) b.box('steel', x, 0, 3.6, x + 0.15, 1.2, 3.8, 'metal');
  }

  private hjell() {
    const b = this.b;
    const L = 10, H = 3.4;
    for (let x = -L / 2; x <= L / 2 + 0.01; x += 2.5) {
      b.obox('woodRaw', [x, H / 2, -0.9], [0.14, H / Math.cos(0.32), 0.14], new THREE.Euler(0.32, 0, 0), 'wood');
      b.obox('woodRaw', [x, H / 2, 0.9], [0.14, H / Math.cos(0.32), 0.14], new THREE.Euler(-0.32, 0, 0), 'wood');
    }
    for (const y of [1.6, 2.4, 3.2]) {
      const zz = (1 - y / H) * 1.7;
      b.box('woodRaw', -L / 2, y, -zz - 0.05, L / 2, y + 0.08, -zz + 0.05);
      b.box('woodRaw', -L / 2, y, zz - 0.05, L / 2, y + 0.08, zz + 0.05);
    }
    b.box('woodRaw', -L / 2, H - 0.1, -0.1, L / 2, H, 0.1);
    // stockfish (tørrfisk) hanging in pairs
    const rng = new RNG(4);
    for (const y of [1.6, 2.4, 3.2]) {
      const zz = (1 - y / H) * 1.7;
      for (const s of [1, -1]) for (let x = -L / 2 + 0.15; x < L / 2; x += 0.22) {
        const len = rng.range(0.55, 0.8);
        b.obox('fish', [x, y - len / 2, s * zz + s * 0.03], [0.07, len, 0.025], new THREE.Euler(0, 0, rng.range(-0.06, 0.06)));
      }
    }
    // a barrier collider so bots/players treat the rack as cover
    b.box(null, -L / 2, 0, -0.6, L / 2, 1.6, 0.6, 'fabric', { penetrable: 2 });
  }

  /** Simple clinker-built wooden boat (færing) or small fishing boat. */
  boat(x: number, y: number, z: number, rot: number, scale = 1, cabin = false, color = 'white') {
    const b = this.b;
    b.push([x, y, z], rot);
    const L = 5.2 * scale, W = 1.7 * scale, H = 0.75 * scale;
    // hull from a lofted shape
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, H);
    shape.quadraticCurveTo(-L / 2 + 0.3 * scale, 0.1 * scale, 0, 0);
    shape.quadraticCurveTo(L / 2 - 0.3 * scale, 0.1 * scale, L / 2, H * 1.1);
    shape.lineTo(-L / 2, H);
    for (const s of [1, -1]) {
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false });
      // flare the side outward
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i);
        const t = 1 - Math.pow(Math.abs(px) / (L / 2), 2);
        pos.setZ(i, pos.getZ(i) * s + s * (W / 2) * Math.max(0.05, t) * (0.35 + 0.65 * (py / H)));
      }
      g.computeVertexNormals();
      this.b.addGeo(color === 'white' ? 'boatWhite' : 'boatRed', g);
    }
    b.box('planks', -L / 2 + 0.6, 0.05, -W * 0.3, L / 2 - 0.6, 0.12, W * 0.3);
    b.box('woodRaw', -0.2, H * 0.6, -W * 0.38, 0.2, H * 0.68, W * 0.38);
    if (cabin) {
      b.box('white', -L * 0.1, H * 0.5, -W * 0.3, L * 0.15, H * 1.9, W * 0.3, 'metal');
      b.box('roofMetal', -L * 0.12, H * 1.9, -W * 0.33, L * 0.17, H * 2.0, W * 0.33);
      b.box('steel', L * 0.0, H * 2.0, -0.03, L * 0.02, H * 3.4, 0.03);
    }
    b.box(null, -L / 2 + 0.3, 0, -W / 2, L / 2 - 0.3, H, W / 2, 'wood');
    b.pop();
  }

  /** Called after construction to add extra props via the shared builder. */
  finish(parent: THREE.Object3D) {
    this.b.flush(parent);
    for (const m of this.extraMeshes) parent.add(m);
  }
}

export { SEA_LEVEL };
