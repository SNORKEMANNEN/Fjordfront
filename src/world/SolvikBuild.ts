import * as THREE from 'three';
import type { GeoBuilder } from './GeoBuilder';
import type { Buildings } from './Buildings';
import type { Terrain } from './Terrain';
import type { Infrastructure } from './Infrastructure';
import type { Surface } from '../core/Physics';
import { RNG } from '../core/math';
import { Vegetation } from './Vegetation';
import { AREA, LV, Rect, SV_BLOCKS, SV_PALACE, SV_LOFT, SV_KJELLER, SV_CHURCH, SV_GRASS, SvBlock, bShortY } from './maps/Solvik';

/**
 * Solvik's hand-built town (Update 42). Everything is built in world space from the layout in
 * maps/Solvik: paving draped over the designed floor levels, the street blocks with dressed
 * facades (sandstone, stucco, painted timber), the fortress around A with its gate and rampart
 * platform, the palace route, the vaulted underpass, the wharf lofts with their balcony over B,
 * the stave church, the boathouses, the sea wall and the promenade at the waterline, the station,
 * and the set dressing and cover for a round-based mode.
 */
type V3 = [number, number, number];

export class SolvikBuild {
  /** solid footprints (blocks, walls, interiors) for facade probes */
  private solids: Rect[] = [];
  private rng = new RNG(4242);
  /** world points for the game: lantern glows and the far fjord ambience */
  lanterns: THREE.Vector3[] = [];
  private flagMeshes: THREE.Mesh[] = [];

  constructor(private I: Infrastructure, private b: GeoBuilder, private bld: Buildings, private terrain: Terrain, private parent: THREE.Object3D, private mats: Record<string, THREE.Material>) {
    void this.I;
    for (const k of SV_BLOCKS) this.solids.push(k);
    this.solids.push(SV_PALACE, SV_LOFT, SV_KJELLER, SV_CHURCH);
    this.fortress();
    this.paving();
    for (const k of SV_BLOCKS) this.block(k);
    this.palace();
    this.kjelleren();
    this.loft();
    this.church();
    this.vinduet();
    this.seaWall();
    this.promenade();
    this.quay();
    this.streetWalls();
    this.dressing();
    this.trees();
    this.navLinks();
  }

  h(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }
  private solidAt(x: number, z: number) {
    if (x < -74 || x > 75 || z < -82 || z > 78) return true;
    for (const r of this.solids) if (x > r.x0 + 0.05 && x < r.x1 - 0.05 && z > r.z0 + 0.05 && z < r.z1 - 0.05) return true;
    return false;
  }

  // ================================================================ geometry helpers
  /** quad p0 p1 p2 p3 (counter-clockwise seen from the front) with metric UVs */
  private quad(mat: string, p0: V3, p1: V3, p2: V3, p3: V3) {
    const v = (a: V3) => new THREE.Vector3(...a);
    const a = v(p0), b = v(p1), c = v(p2), d = v(p3);
    const u = b.distanceTo(a), w = d.distanceTo(a);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p0, ...p2, ...p3], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, w, 0, 0, u, w, 0, w], 2));
    g.computeVertexNormals();
    this.b.addGeo(mat, g);
  }
  private tri(mat: string, p0: V3, p1: V3, p2: V3) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2], 3));
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, L, 0, L / 2, Math.abs(p2[1] - p0[1])], 2));
    g.computeVertexNormals();
    this.b.addGeo(mat, g);
  }
  /** a 2D outline (local XY) extruded t deep at z (in the current frame) */
  private slab(mat: string, pts: [number, number][], z: number, t: number) {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 4 });
    g.translate(0, 0, z);
    this.b.addGeo(mat, g);
  }
  /** half annulus (arch ring) centred at (x, y) in the frame's XY plane */
  private arch(mat: string, x: number, y: number, r: number, k: number, z: number, t: number, n = 10) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) pts.push([x + Math.cos((Math.PI * i) / n) * (r + k), y + Math.sin((Math.PI * i) / n) * (r + k)]);
    for (let i = n; i >= 0; i--) pts.push([x + Math.cos((Math.PI * i) / n) * r, y + Math.sin((Math.PI * i) / n) * r]);
    this.slab(mat, pts, z, t);
  }
  /** the solid wall above an arched opening (spandrels): from the springing line up to `top` */
  private spandrel(mat: string, x: number, y: number, r: number, top: number, z: number, t: number, n = 10) {
    const pts: [number, number][] = [[x - r, y], [x - r, top], [x + r, top], [x + r, y]];
    for (let i = 0; i <= n; i++) pts.push([x + Math.cos((Math.PI * i) / n) * r, y + Math.sin((Math.PI * i) / n) * r]);
    this.slab(mat, pts, z, t);
  }
  private halfDisc(mat: string, x: number, y: number, r: number, z: number, t: number) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) pts.push([x + Math.cos((Math.PI * i) / 8) * r, y + Math.sin((Math.PI * i) / 8) * r]);
    this.slab(mat, pts, z, t);
  }
  /** world-space box */
  private box(mat: string | null, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, surf: Surface | null = null) {
    return this.b.box(mat, Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1), surf);
  }
  /** draw in a facade frame: origin at (cx, y, cz), local +Z = the outward normal (nx, nz) */
  private frame(cx: number, y: number, cz: number, nx: number, nz: number, fn: () => void) {
    this.b.push([cx, y, cz], Math.atan2(nx, nz));
    fn();
    this.b.pop();
  }
  /** terrain-following mesh over a rectangle (paving), on the terrain grid */
  private drape(mat: string, r: Rect, lift = 0.035, skip?: (x: number, z: number) => boolean) {
    const S = 1.25;
    const xs: number[] = [r.x0], zs: number[] = [r.z0];
    for (let x = Math.ceil(r.x0 / S) * S; x < r.x1 - 0.05; x += S) if (x > r.x0 + 0.05) xs.push(x);
    xs.push(r.x1);
    for (let z = Math.ceil(r.z0 / S) * S; z < r.z1 - 0.05; z += S) if (z > r.z0 + 0.05) zs.push(z);
    zs.push(r.z1);
    const pos: number[] = [], uv: number[] = [];
    for (let i = 0; i < xs.length - 1; i++)
      for (let j = 0; j < zs.length - 1; j++) {
        const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
        if (skip && skip((x0 + x1) / 2, (z0 + z1) / 2)) continue;
        const p = (x: number, z: number) => [x, this.h(x, z) + lift, z];
        const a = p(x0, z0), b = p(x1, z0), c = p(x1, z1), d = p(x0, z1);
        // two triangles, front faces up
        pos.push(...a, ...d, ...c, ...a, ...c, ...b);
        uv.push(x0, z0, x0, z1, x1, z1, x0, z0, x1, z1, x1, z0);
      }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.b.addGeo(mat, g);
  }
  private minMaxGround(r: Rect) {
    let lo = Infinity, hi = -Infinity;
    for (let x = r.x0; x <= r.x1 + 1e-6; x += Math.max(1, (r.x1 - r.x0) / 8))
      for (let z = r.z0; z <= r.z1 + 1e-6; z += Math.max(1, (r.z1 - r.z0) / 8)) {
        const y = this.h(x, z);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    return [lo, hi];
  }

  // ================================================================ roofs
  /**
   * Pitched roof over a rectangle: ridge along the long axis, gables in the wall material, eaves
   * overhang; tile, slate or turf (a sod layer with a timber fascia). 'flat' gets a parapet.
   */
  private roof(r: Rect, y: number, kind: 'tile' | 'turf' | 'slate' | 'flat', wallMat: string, oh = 0.55) {
    if (kind === 'flat') {
      this.box(wallMat, r.x0 - 0.1, y, r.z0 - 0.1, r.x1 + 0.1, y + 0.9, r.z0 + 0.3);
      this.box(wallMat, r.x0 - 0.1, y, r.z1 - 0.3, r.x1 + 0.1, y + 0.9, r.z1 + 0.1);
      this.box(wallMat, r.x0 - 0.1, y, r.z0, r.x0 + 0.3, y + 0.9, r.z1);
      this.box(wallMat, r.x1 - 0.3, y, r.z0, r.x1 + 0.1, y + 0.9, r.z1);
      return;
    }
    const along = r.x1 - r.x0 >= r.z1 - r.z0;
    const span = along ? r.z1 - r.z0 : r.x1 - r.x0;
    const pitch = kind === 'turf' ? 0.36 : kind === 'slate' ? 0.5 : 0.42;
    const rise = (span / 2) * pitch * 2;
    const mat = kind === 'turf' ? 'sod' : kind === 'slate' ? 'slate' : 'roofRed';
    const top = y + rise;
    if (along) {
      const zc = (r.z0 + r.z1) / 2, x0 = r.x0 - oh, x1 = r.x1 + oh;
      const za = r.z0 - oh, zb = r.z1 + oh, ya = y - oh * pitch * 2 * 0.5;
      this.quad(mat, [x0, ya, za], [x0, top, zc], [x1, top, zc], [x1, ya, za]);
      this.quad(mat, [x1, ya, zb], [x1, top, zc], [x0, top, zc], [x0, ya, zb]);
      // undersides (seen from the street below the eaves)
      this.quad('woodRaw', [x1, ya - 0.01, za], [x1, top - 0.2, zc], [x0, top - 0.2, zc], [x0, ya - 0.01, za]);
      this.quad('woodRaw', [x0, ya - 0.01, zb], [x0, top - 0.2, zc], [x1, top - 0.2, zc], [x1, ya - 0.01, zb]);
      this.tri(wallMat, [r.x0, y, r.z1], [r.x0, y, r.z0], [r.x0, top - 0.05, zc]);
      this.tri(wallMat, [r.x1, y, r.z0], [r.x1, y, r.z1], [r.x1, top - 0.05, zc]);
      if (kind === 'turf') {
        // timber fascia boards and the birch-bark edge
        this.box('tarWood', x0, ya - 0.25, za - 0.05, x1, ya + 0.1, za + 0.12);
        this.box('tarWood', x0, ya - 0.25, zb - 0.12, x1, ya + 0.1, zb + 0.05);
      } else {
        this.box(kind === 'slate' ? 'iron' : 'roofRed', x0, top - 0.06, zc - 0.16, x1, top + 0.12, zc + 0.16);
      }
    } else {
      const xc = (r.x0 + r.x1) / 2, z0 = r.z0 - oh, z1 = r.z1 + oh;
      const xa = r.x0 - oh, xb = r.x1 + oh, ya = y - oh * pitch * 2 * 0.5;
      this.quad(mat, [xa, ya, z1], [xc, top, z1], [xc, top, z0], [xa, ya, z0]);
      this.quad(mat, [xb, ya, z0], [xc, top, z0], [xc, top, z1], [xb, ya, z1]);
      this.quad('woodRaw', [xa, ya - 0.01, z0], [xc, top - 0.2, z0], [xc, top - 0.2, z1], [xa, ya - 0.01, z1]);
      this.quad('woodRaw', [xb, ya - 0.01, z1], [xc, top - 0.2, z1], [xc, top - 0.2, z0], [xb, ya - 0.01, z0]);
      this.tri(wallMat, [r.x0, y, r.z0], [r.x1, y, r.z0], [xc, top - 0.05, r.z0]);
      this.tri(wallMat, [r.x1, y, r.z1], [r.x0, y, r.z1], [xc, top - 0.05, r.z1]);
      if (kind === 'turf') {
        this.box('tarWood', xa - 0.05, ya - 0.25, z0, xa + 0.12, ya + 0.1, z1);
        this.box('tarWood', xb - 0.12, ya - 0.25, z0, xb + 0.05, ya + 0.1, z1);
      } else {
        this.box(kind === 'slate' ? 'iron' : 'roofRed', xc - 0.16, top - 0.06, z0, xc + 0.16, top + 0.12, z1);
      }
    }
    // chimneys
    const n = Math.max(1, Math.round(Math.max(r.x1 - r.x0, r.z1 - r.z0) / 14));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const cx = along ? r.x0 + (r.x1 - r.x0) * t : (r.x0 + r.x1) / 2 + 1.2;
      const cz = along ? (r.z0 + r.z1) / 2 + 1.2 : r.z0 + (r.z1 - r.z0) * t;
      this.box(kind === 'turf' ? 'stone' : 'chimney', cx - 0.45, top - 1.2, cz - 0.45, cx + 0.45, top + 1.0, cz + 0.45);
      this.box('concrete', cx - 0.55, top + 1.0, cz - 0.55, cx + 0.55, top + 1.12, cz + 0.55);
      this.bld.chimneys.push(new THREE.Vector3(cx, top + 1.2, cz));
    }
  }

  // ================================================================ facades
  private wallMat(k: SvBlock) {
    if (k.style === 'stone' || k.style === 'fort' || k.style === 'hall') return 'sandstone';
    if (k.style === 'stucco') return k.color ?? 'stucco';
    if (k.style === 'timber' || k.style === 'boathouse') return k.color ?? 'red';
    if (k.style === 'station') return 'sandstone';
    return 'stucco';
  }

  /** One window in a facade frame (local x, sill y, size); style per building. */
  private window(x: number, y: number, w: number, hgt: number, style: SvBlock['style'], seed: number, upper: boolean) {
    const b = this.b;
    const r = this.rng;
    const timber = style === 'timber' || style === 'boathouse';
    const trim = timber ? 'trim' : style === 'stucco' ? 'trim' : 'sandstoneDk';
    const lit = r.chance(0.18);
    // surround, glass, glazing bars, sill
    b.box(trim, x - w / 2 - 0.12, y - 0.06, -0.01, x + w / 2 + 0.12, y + hgt + 0.1, 0.07);
    b.box(lit ? 'jglassLit' : 'jglass', x - w / 2, y, 0.05, x + w / 2, y + hgt, 0.08);
    b.box('trim', x - 0.03, y, 0.08, x + 0.03, y + hgt, 0.1);
    b.box('trim', x - w / 2, y + hgt * 0.62, 0.08, x + w / 2, y + hgt * 0.62 + 0.05, 0.1);
    if (timber) b.box('trim', x - w / 2, y + hgt * 0.3, 0.08, x + w / 2, y + hgt * 0.3 + 0.04, 0.1);
    b.box(trim, x - w / 2 - 0.18, y - 0.14, -0.01, x + w / 2 + 0.18, y - 0.04, 0.16);
    if (style === 'stone' || style === 'station') {
      // a round-arched head with a keystone (the warm-town look)
      this.halfDisc(trim, x, y + hgt + 0.1, w / 2 + 0.12, -0.01, 0.08);
      this.halfDisc('jglass', x, y + hgt + 0.1, w / 2 - 0.02, 0.05, 0.03);
      b.box(trim, x - 0.1, y + hgt + w / 2 + 0.1, 0.0, x + 0.1, y + hgt + w / 2 + 0.42, 0.12);
    } else if (style === 'stucco') {
      b.box(trim, x - w / 2 - 0.26, y + hgt + 0.12, -0.01, x + w / 2 + 0.26, y + hgt + 0.28, 0.2);
    } else {
      // timber: a small pediment
      b.box('trim', x - w / 2 - 0.2, y + hgt + 0.1, -0.01, x + w / 2 + 0.2, y + hgt + 0.2, 0.14);
    }
    // painted shutters, folded open
    if (style !== 'station' && r.chance(timber ? 0.35 : 0.65)) {
      const sm = ['shutterGreen', 'shutterBlue', 'shutterRed'][(seed + Math.floor(x)) % 3];
      b.box(sm, x - w / 2 - 0.16 - w / 2, y - 0.02, 0.02, x - w / 2 - 0.16, y + hgt + 0.02, 0.07);
      b.box(sm, x + w / 2 + 0.16, y - 0.02, 0.02, x + w / 2 + 0.16 + w / 2, y + hgt + 0.02, 0.07);
    }
    // flower boxes on the upper floors
    if (upper && r.chance(0.4)) {
      b.box('tarWood', x - w / 2, y - 0.38, 0.12, x + w / 2, y - 0.14, 0.38);
      const fm = ['flowerRed', 'flowerPink', 'flowerWhite'][(seed + Math.floor(x * 3)) % 3];
      for (let i = 0; i < 5; i++) {
        const fx = x - w / 2 + 0.12 + (i / 4) * (w - 0.24);
        b.box('leaf', fx - 0.1, y - 0.16, 0.16, fx + 0.1, y + 0.02, 0.36);
        b.box(fm, fx - 0.07, y + 0.0, 0.18, fx + 0.07, y + 0.12, 0.32);
      }
    }
  }

  /** Ground-floor openings: a recessed door, a shop front with an awning, or a blind arch. */
  private groundBay(x: number, y: number, w: number, k: SvBlock, i: number) {
    const b = this.b;
    const r = this.rng;
    const kind = r.next();
    const awn = ['awnRed', 'awnBlue', 'awnGreen', 'awnOchre'][(k.seed + i) % 4];
    if (kind < 0.35) {
      // door: frame, panels, step, a lantern beside it
      b.box('trim', x - 0.75, y, -0.01, x + 0.75, y + 2.45, 0.08);
      b.box('door', x - 0.6, y, 0.04, x + 0.6, y + 2.3, 0.1);
      b.box('trim', x - 0.5, y + 1.25, 0.1, x + 0.5, y + 1.3, 0.13);
      b.box('trim', x - 0.03, y + 0.1, 0.1, x + 0.03, y + 2.2, 0.13);
      b.box('stone', x - 0.85, y - 0.3, 0.0, x + 0.85, y + 0.06, 0.5);
      if (r.chance(0.6)) this.lantern(x + 1.0, y + 2.3, 0.14, false);
    } else if (kind < 0.7 && w > 2.4) {
      // shop front: big glazing over a stall board, an awning
      b.box('trim', x - w / 2 + 0.15, y, -0.01, x + w / 2 - 0.15, y + 2.7, 0.06);
      b.box('jglassLit', x - w / 2 + 0.3, y + 0.75, 0.05, x + w / 2 - 0.3, y + 2.5, 0.08);
      b.box('tarWood', x - w / 2 + 0.3, y, 0.05, x + w / 2 - 0.3, y + 0.75, 0.1);
      // the awning: a sloped canvas with a valance
      const aw = w - 0.4, ay = y + 3.0, d = 1.5;
      this.quad(awn, [x + aw / 2, ay, 0.05], [x + aw / 2, ay - 0.55, d], [x - aw / 2, ay - 0.55, d], [x - aw / 2, ay, 0.05]);
      this.quad(awn, [x - aw / 2, ay - 0.55, d], [x - aw / 2, ay - 0.85, d], [x + aw / 2, ay - 0.85, d], [x + aw / 2, ay - 0.55, d]);
      b.box('iron', x - aw / 2, ay - 0.6, d - 0.03, x - aw / 2 + 0.04, ay - 0.55, 0.05);
      b.box('iron', x + aw / 2 - 0.04, ay - 0.6, d - 0.03, x + aw / 2, ay - 0.55, 0.05);
    } else {
      // a blind arch (the warm-stone arcade rhythm)
      const rr = Math.min(1.1, w / 2 - 0.3);
      b.box('sandstoneDk', x - rr - 0.2, y, -0.01, x - rr, y + 2.2, 0.12);
      b.box('sandstoneDk', x + rr, y, -0.01, x + rr + 0.2, y + 2.2, 0.12);
      this.arch('sandstoneDk', x, y + 2.2, rr, 0.2, -0.01, 0.13);
      b.box('tarWood', x - rr, y, 0.02, x + rr, y + 2.2, 0.05);
      this.halfDisc('tarWood', x, y + 2.2, rr, 0.02, 0.03);
    }
  }

  /** A wall lantern (iron box, warm glass); registers a light. */
  private lantern(lx: number, ly: number, lz: number, local = true) {
    const b = this.b;
    b.box('iron', lx - 0.04, ly + 0.15, lz - 0.02, lx + 0.04, ly + 0.2, lz + 0.32);
    b.box('iron', lx - 0.13, ly - 0.3, lz + 0.18, lx + 0.13, ly - 0.26, lz + 0.44);
    b.box('bulbWarm', lx - 0.1, ly - 0.26, lz + 0.21, lx + 0.1, ly + 0.08, lz + 0.41);
    b.box('iron', lx - 0.15, ly + 0.08, lz + 0.16, lx + 0.15, ly + 0.15, lz + 0.46);
    const p = new THREE.Vector3(lx, ly - 0.1, lz + 0.6).applyMatrix4(b.m);
    this.bld.fixtures.push({ p, color: 0xffb468, intensity: 6, dist: 10 });
    this.lanterns.push(p);
    void local;
  }

  /** dress one face of a block (a frame where +Z is outward and x runs along the face) */
  private facade(k: SvBlock, cx: number, cz: number, nx: number, nz: number, L: number, base: number, top: number) {
    // which way is "along": local +X = (nz, -nx)
    const tx = nz, tz = -nx;
    const open = (s: number) => !this.solidAt(cx + tx * s + nx * 1.6, cz + tz * s + nz * 1.6);
    // ground level along the face: the highest point of the street in front (no door sunk into a ramp)
    let gHi = -Infinity, gLo = Infinity;
    for (let s = -L / 2 + 0.5; s <= L / 2 - 0.5; s += 1) {
      if (!open(s)) continue;
      const y = this.h(cx + tx * s + nx * 1.2, cz + tz * s + nz * 1.2);
      gHi = Math.max(gHi, y);
      gLo = Math.min(gLo, y);
    }
    if (!isFinite(gHi)) return;
    const flat = gHi - gLo < 0.35;
    const g = gHi;
    const floors = Math.max(1, Math.floor((top - g - 0.8) / 3.3));
    const bay = k.style === 'timber' || k.style === 'boathouse' ? 2.6 : 3.2;
    const n = Math.max(1, Math.floor((L - 1.6) / bay));
    const step = (L - 1.6) / n;
    const wm = this.wallMat(k);
    this.frame(cx, 0, cz, nx, nz, () => {
      const b = this.b;
      // plinth and string courses
      if (k.style !== 'timber' && k.style !== 'boathouse') {
        b.box('sandstoneDk', -L / 2, base, -0.02, L / 2, g + 0.55, 0.12);
        for (let f = 1; f <= floors; f++) b.box(k.style === 'stucco' ? 'trim' : 'sandstoneDk', -L / 2, g + f * 3.3 - 0.1, -0.02, L / 2, g + f * 3.3 + 0.06, 0.1);
        // cornice
        b.box(k.style === 'stucco' ? 'trim' : 'sandstoneDk', -L / 2 - 0.05, top - 0.35, -0.02, L / 2 + 0.05, top - 0.12, 0.28);
        b.box(k.style === 'stucco' ? 'trim' : 'sandstoneDk', -L / 2 - 0.05, top - 0.12, -0.02, L / 2 + 0.05, top, 0.36);
        // stucco: sandstone quoins at the corners
        if (k.style === 'stucco')
          for (let y = g + 0.55, i = 0; y < top - 0.6; y += 0.55, i++) {
            const w = i % 2 ? 0.45 : 0.75;
            b.box('sandstone', -L / 2, y, -0.02, -L / 2 + w, y + 0.5, 0.06);
            b.box('sandstone', L / 2 - w, y, -0.02, L / 2, y + 0.5, 0.06);
          }
      } else {
        // timber: corner boards, a base board on a stone footing
        b.box('trim', -L / 2, g, -0.02, -L / 2 + 0.18, top, 0.08);
        b.box('trim', L / 2 - 0.18, g, -0.02, L / 2, top, 0.08);
        b.box('stone', -L / 2, base, -0.04, L / 2, g + 0.35, 0.1);
        b.box('trim', -L / 2, top - 0.25, -0.02, L / 2, top, 0.1);
      }
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + 0.8 + step * (i + 0.5);
        if (!open(x)) continue;
        // ground floor
        if (flat) this.groundBay(x, g, step, k, i);
        else this.window(x, g + 1.2, 1.0, 1.3, k.style, k.seed, false);
        for (let f = 1; f <= floors; f++) {
          const y = g + f * 3.3 + 0.75;
          if (y + 1.6 > top - 0.4) break;
          this.window(x, y, k.style === 'timber' ? 0.95 : 1.1, 1.65, k.style, k.seed, true);
          // a wrought-iron balcony now and then on stucco fronts
          if (k.style === 'stucco' && f === 1 && this.rng.chance(0.18)) {
            b.box('sandstoneDk', x - 1.0, y - 0.32, 0, x + 1.0, y - 0.16, 0.9);
            b.box('iron', x - 1.0, y + 0.75, 0.86, x + 1.0, y + 0.8, 0.9);
            for (let q = -1; q <= 1.001; q += 0.25) b.box('iron', x + q - 0.012, y - 0.16, 0.86, x + q + 0.012, y + 0.78, 0.89);
          }
        }
      }
      void wm;
    });
  }

  /** a solid block: one collider, dressed faces, a roof */
  private block(k: SvBlock) {
    if (k.style === 'church' || k.style === 'fort') return;
    const [lo, hi] = this.minMaxGround(k);
    const base = lo - 1.2;
    const top = hi + k.h;
    const wm = this.wallMat(k);
    if (k.style === 'boathouse') return this.boathouses(k, LV.B, LV.B);
    if (k.style === 'station') return this.station(k, lo, hi);
    this.box(wm, k.x0, base, k.z0, k.x1, top, k.z1, k.style === 'timber' ? 'wood' : 'concrete');
    const cx = (k.x0 + k.x1) / 2, cz = (k.z0 + k.z1) / 2, W = k.x1 - k.x0, D = k.z1 - k.z0;
    this.facade(k, cx, k.z0, 0, -1, W, base, top);
    this.facade(k, cx, k.z1, 0, 1, W, base, top);
    this.facade(k, k.x0, cz, -1, 0, D, base, top);
    this.facade(k, k.x1, cz, 1, 0, D, base, top);
    this.roof(k, top, k.roof ?? 'tile', wm);
  }

  // ================================================================ paving
  private paving() {
    const A = AREA;
    const skipSolid = (x: number, z: number) => this.solidAt(x, z) || SV_GRASS.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
    // flagstones on the squares, setts in the streets and lanes
    for (const r of [A.tspawn, A.tspawnE, A.ct, A.ctBack, A.topMid, A.topMidE]) this.drape('flags', r, 0.035, skipSolid);
    this.drape('flags', A.aSite, 0.035, skipSolid);
    for (const r of [A.aLane, A.aRamp, A.mid, A.midRamp, A.conn, A.connN, A.bShort, A.bLane, A.bLaneRamp, A.yard, A.ctStairs]) this.drape('cobbles', r, 0.035, skipSolid);
    this.drape('cobbles', { x0: 16, z0: 30, x1: 24, z1: 38 }, 0.035);
    this.drape('cobbles', A.kjNorth, 0.035);
    this.drape('flags', A.kjHall, 0.035);
    // the wharf: planks on the quay front, granite setts behind
    this.drape('deck', { x0: 56, z0: -60, x1: 72, z1: -18 }, 0.04, skipSolid);
    this.drape('cobbles', { x0: 26, z0: -60, x1: 56, z1: -4 }, 0.035, skipSolid);
    this.drape('cobbles', { x0: 56, z0: -18, x1: 64, z1: -4 }, 0.035, skipSolid);
    // kerb-like gutter strips down the middle of the lanes (the setts' drainage channel)
    for (const r of [A.mid, A.aLane, A.bLane]) {
      const cx = (r.x0 + r.x1) / 2;
      this.drape('flags', { x0: cx - 0.35, z0: r.z0, x1: cx + 0.35, z1: r.z1 }, 0.045);
    }
  }

  // ================================================================ the fortress (A)
  private fortress() {
    const y = LV.A;
    const W = (x0: number, z0: number, x1: number, z1: number, top: number, crenel = true) => {
      this.box('sandstone', x0, y - 3, z0, x1, top, z1, 'rock');
      this.solids.push({ x0, z0, x1, z1 });
      // a sandstone coping, with merlons along the top
      this.box('sandstoneDk', x0 - 0.15, top - 0.3, z0 - 0.15, x1 + 0.15, top, z1 + 0.15);
      if (crenel) {
        const along = x1 - x0 > z1 - z0;
        const L = along ? x1 - x0 : z1 - z0;
        for (let s = 0.4; s < L - 0.6; s += 2.2) {
          if (along) {
            this.box('sandstone', x0 + s, top, z0, x0 + s + 1.2, top + 0.9, z0 + 0.6);
            this.box('sandstone', x0 + s, top, z1 - 0.6, x0 + s + 1.2, top + 0.9, z1);
          } else {
            this.box('sandstone', x0, top, z0 + s, x0 + 0.6, top + 0.9, z0 + s + 1.2);
            this.box('sandstone', x1 - 0.6, top, z0 + s, x1, top + 0.9, z0 + s + 1.2);
          }
        }
      }
    };
    // west curtain, the south-west bastion beside the gate passage, the north curtain
    W(-76, -70, -70, -22, y + 7.5);
    W(-76, -22, -64, -12, LV.T + 7.0);
    W(-74, -76, -21, -66, y + 8.0);
    // north-east corner by CT: a short wall with a gate opening to the church square
    W(-24, -66, -20, -56, y + 6.5);
    W(-24, -50, -20, -46, y + 6.5);
    // the gate wall: two piers and a great arch over the passage ("Porten")
    W(-70, -22.5, -60.5, -18.5, y + 6.5);
    W(-53.5, -22.5, -50, -18.5, y + 6.5);
    {
      const gx = -57, half = 3.5, spring = y + 3.6;
      this.box(null, -60.5, spring + half, -22.5, -53.5, y + 6.5, -18.5, 'rock');
      this.frame(gx, 0, -18.5, 0, 1, () => {
        this.spandrel('sandstone', 0, spring, half, y + 6.5, -4.0, 4.0);
        this.arch('sandstoneDk', 0, spring, half, 0.45, 0.0, 0.16, 14);
        this.b.box('sandstoneDk', -half - 0.45, spring - 0.3, 0, -half, spring, 0.18);
        this.b.box('sandstoneDk', half, spring - 0.3, 0, half + 0.45, spring, 0.18);
        this.lantern(-half - 1.2, spring + 1.4, 0.1);
        this.lantern(half + 1.2, spring + 1.4, 0.1);
      });
      this.frame(gx, 0, -22.5, 0, -1, () => this.arch('sandstoneDk', 0, spring, half, 0.45, 0.0, 0.16, 14));
      // the barrel vault's soffit
      for (let i = 0; i <= 10; i++) {
        const a0 = (Math.PI * i) / 10;
        if (i < 10) {
          const a1 = (Math.PI * (i + 1)) / 10;
          this.quad('sandstoneDk', [gx + Math.cos(a1) * half, spring + Math.sin(a1) * half, -18.5], [gx + Math.cos(a0) * half, spring + Math.sin(a0) * half, -18.5],
            [gx + Math.cos(a0) * half, spring + Math.sin(a0) * half, -22.5], [gx + Math.cos(a1) * half, spring + Math.sin(a1) * half, -22.5]);
        }
      }
      // the iron-bound gate leaves, swung open against the passage walls
      this.box('tarWood', -60.5, LV.T, -22.4, -60.2, spring + 1.5, -20.0);
      this.box('tarWood', -53.8, LV.T, -22.4, -53.5, spring + 1.5, -20.0);
      for (const zz of [-21.8, -20.6]) {
        this.box('iron', -60.55, LV.T + 0.6, zz, -60.15, LV.T + 0.7, zz + 0.4);
        this.box('iron', -53.85, LV.T + 0.6, zz, -53.45, LV.T + 0.7, zz + 0.4);
      }
    }
    // the round north-west tower with a conical shingle roof
    {
      const tx = -71, tz = -69, r = 5.6, top = y + 15;
      this.b.cyl('sandstone', tx, y - 3, tz, r, top - y + 3, 20, 'rock');
      this.b.cyl('sandstoneDk', tx, top - 0.4, tz, r + 0.35, 0.6, 20);
      const g = new THREE.ConeGeometry(r + 0.9, 7.5, 20, 1, true);
      g.translate(tx, top + 3.75, tz);
      this.b.addGeo('shingles', g);
      this.b.cyl('gold', tx, top + 7.3, tz, 0.08, 2.0, 6);
      this.flag(tx, top + 9.3, tz, 1.6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3, wx = tx + Math.cos(a) * (r - 0.02), wz = tz + Math.sin(a) * (r - 0.02);
        this.frame(wx, 0, wz, Math.cos(a), Math.sin(a), () => {
          this.b.box('tarWood', -0.25, y + 8, 0.0, 0.25, y + 9.6, 0.06);
          this.halfDisc('sandstoneDk', 0, y + 9.6, 0.38, -0.02, 0.06);
        });
      }
    }
    // the rampart platform along the north wall ("Borgmuren"): stairs up at both ends
    {
      const py = y + 1.8, z0 = -66, z1 = -61.5;
      this.box('sandstone', -62, y - 1, z0, -36, py, z1, 'rock');
      this.box('sandstoneDk', -62, py - 0.12, z1 - 0.05, -36, py, z1 + 0.15);
      this.solids.push({ x0: -62, z0, x1: -36, z1 });
      this.drape('flags', { x0: -62, z0, x1: -36, z1 }, 0.035);
      // a parapet on the courtyard side with gaps to shoot through
      for (let x = -61.5; x < -37; x += 3.2) this.box('sandstone', x, py, z1 - 0.45, x + 1.8, py + 0.95, z1, 'rock');
      // stairs (rotated ramp collider + visible steps) down to the courtyard at each end
      for (const [x0, x1, dir] of [[-67.2, -62, 1], [-36, -30.8, -1]] as const) {
        const len = Math.hypot(5.2, py - y), ang = Math.atan2(py - y, 5.2) * dir;
        this.b.obox(null, [(x0 + x1) / 2, (y + py) / 2 - 0.15, (z0 + z1) / 2], [len, 0.3, z1 - z0], new THREE.Euler(0, 0, ang), 'rock');
        for (let i = 0; i < 9; i++) {
          const t = (i + 0.5) / 9, x = dir > 0 ? x0 + t * 5.2 : x1 - t * 5.2, yy = y + t * (py - y);
          this.box('sandstoneDk', x - 0.29, y - 0.3, z0 + 0.05, x + 0.29, yy + 0.02, z1);
        }
      }
      // a bronze cannon on its carriage, pointing over the courtyard at the gate
      this.cannon(-52, py, -64.9, Math.PI * 0.95);
      this.cannon(-44, py, -64.9, Math.PI * 1.05);
    }
  }
  private cannon(x: number, y: number, z: number, yaw: number) {
    this.b.push([x, y, z], yaw);
    this.b.box('tarWood', -0.5, 0, -0.9, 0.5, 0.55, 0.9, 'wood');
    this.b.box('iron', -0.65, 0.05, 0.3, -0.5, 0.75, 0.8);
    this.b.box('iron', 0.5, 0.05, 0.3, 0.65, 0.75, 0.8);
    const g = new THREE.CylinderGeometry(0.16, 0.24, 2.4, 12);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0.78, 0.6);
    this.b.addGeo('gold', g);
    this.b.pop();
  }
  /** a red pennant on a pole top (animated by update) */
  private flag(x: number, y: number, z: number, len: number) {
    const g = new THREE.PlaneGeometry(len, len * 0.22, 8, 1);
    g.translate(len / 2, 0, 0);
    const m = new THREE.Mesh(g, this.mats.pennant ?? new THREE.MeshStandardMaterial({ color: 0xc8202a, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.castShadow = true;
    this.parent.add(m);
    this.flagMeshes.push(m);
  }

  // ================================================================ the palace (A's second entrance)
  private palace() {
    const P = SV_PALACE, y = LV.T, ceil = y + 4.4, top = y + 9.5;
    const hall = { x0: -49.4, z0: -3, x1: -33, z1: 9.4 };
    const cor = { x0: -37, z0: -20, x1: -33, z1: -3 };
    const t = 0.6;
    const S: Surface = 'concrete';
    // outer walls with the three openings: the lane door (west), the courtyard arch (north)
    this.box('sandstone', P.x0, y - 1, P.z0, P.x0 + t, top, 0.8, S); // west wall, south of the door
    this.box('sandstone', P.x0, y - 1, 7.2, P.x0 + t, top, P.z1, S);
    this.box('sandstone', P.x0, ceil - 0.2, 0.8, P.x0 + t, top, 7.2, S);
    this.box('sandstone', P.x0, y - 1, P.z1 - t, P.x1, top, P.z1, S); // south wall
    this.box('sandstone', P.x1 - t, y - 1, P.z0, P.x1, top, P.z1, S); // east wall
    this.box('sandstone', P.x0, LV.A - 1, P.z0, cor.x0, top, P.z0 + t, S); // north wall west of the corridor exit
    this.box('sandstone', cor.x1, LV.A - 1, P.z0, P.x1, top, P.z0 + t, S);
    this.box('sandstone', cor.x0, ceil + 0.9, P.z0, cor.x1, top, P.z0 + t, S);
    // solid masses beside the corridor
    this.box('wallInt', P.x0 + t, y - 1, P.z0 + t, cor.x0, top, hall.z0, S);
    this.box('wallInt', cor.x1, y - 1, P.z0 + t, P.x1 - t, top, hall.z0, S);
    this.box('wallInt', hall.x1, y - 1, hall.z0, P.x1 - t, top, P.z1 - t, S);
    // ceilings: a coffered hall ceiling, the corridor's barrel vault, the roof mass above
    this.box('wallInt', hall.x0, ceil, hall.z0, hall.x1, top, hall.z1, S);
    this.box('wallInt', cor.x0, ceil + 0.9, cor.z0, cor.x1, top, cor.z1, S);
    for (let x = hall.x0 + 2; x < hall.x1 - 1; x += 3.2) this.box('tarWood', x - 0.15, ceil - 0.35, hall.z0, x + 0.15, ceil, hall.z1);
    for (let i = 0; i < 8; i++) {
      const a0 = (Math.PI * i) / 8, a1 = (Math.PI * (i + 1)) / 8;
      const xc = (cor.x0 + cor.x1) / 2, r = 2, yb = ceil - 1.1;
      this.quad('sandstoneDk', [xc + Math.cos(a1) * r, yb + Math.sin(a1) * 2, cor.z0], [xc + Math.cos(a0) * r, yb + Math.sin(a0) * 2, cor.z0],
        [xc + Math.cos(a0) * r, yb + Math.sin(a0) * 2, cor.z1], [xc + Math.cos(a1) * r, yb + Math.sin(a1) * 2, cor.z1]);
    }
    // floors: polished flagstones, a long red runner down the hall
    this.drape('flags', hall, 0.035);
    this.drape('flags', cor, 0.035);
    this.drape('rug', { x0: -46, z0: 2.4, x1: -36, z1: 4.4 }, 0.05);
    // the hall: two rows of columns (cover), a long table, tapestries, chandeliers
    for (const cx of [-45.5, -41, -36.5]) {
      for (const cz of [0.4, 6.4]) {
        this.b.cyl('sandstone', cx, y, cz, 0.42, ceil - y, 12, 'rock');
        this.box('sandstoneDk', cx - 0.6, y, cz - 0.6, cx + 0.6, y + 0.3, cz + 0.6);
        this.box('sandstoneDk', cx - 0.6, ceil - 0.4, cz - 0.6, cx + 0.6, ceil, cz + 0.6);
      }
    }
    this.box('tarWood', -46.5, y + 0.72, 3.0, -38.5, y + 0.82, 4.0, 'wood');
    for (const lx of [-46, -39]) this.box('tarWood', lx, y, 3.2, lx + 0.5, y + 0.72, 3.8);
    for (const tx of [-47, -43, -39]) {
      this.box('art1', tx - 1, y + 1.6, hall.z1 - 0.06, tx + 1, y + 3.6, hall.z1);
      this.box('gold', tx - 1.05, y + 3.6, hall.z1 - 0.1, tx + 1.05, y + 3.68, hall.z1);
    }
    this.b.push([0, 0, 0]);
    for (const fx of [-44, -38]) this.bld.fixture(fx, ceil, 3.4, 'pendant');
    this.bld.fixture(-35, ceil + 0.9, -12, 'bare');
    this.b.pop();
    // an arched door frame on the lane side and the arch out into the courtyard
    this.frame(P.x0, 0, 4, -1, 0, () => {
      this.arch('sandstoneDk', 0, ceil - 0.2 - 3.2, 3.2, 0.4, 0, 0.18);
      this.b.box('sandstoneDk', -3.6, y, 0, -3.2, ceil - 0.2 - 3.2, 0.18);
      this.b.box('sandstoneDk', 3.2, y, 0, 3.6, ceil - 0.2 - 3.2, 0.18);
    });
    this.frame((cor.x0 + cor.x1) / 2, 0, P.z0, 0, -1, () => {
      this.b.box('sandstoneDk', -2.4, LV.A, 0, -2.0, ceil + 0.9, 0.18);
      this.b.box('sandstoneDk', 2.0, LV.A, 0, 2.4, ceil + 0.9, 0.18);
      this.b.box('sandstoneDk', -2.4, ceil + 0.9, 0, 2.4, ceil + 1.3, 0.2);
    });
    // exterior: facades on the lane and the courtyard, a roof
    const k: SvBlock = { ...P, h: 9.5, style: 'stone', seed: 21 };
    this.facadeAbove(k, (P.x0 + P.x1) / 2, P.z0, 0, -1, P.x1 - P.x0, ceil + 1.3, top);
    this.facadeAbove(k, P.x0, (P.z0 + P.z1) / 2, -1, 0, P.z1 - P.z0, ceil + 0.2, top);
    this.roof(P, top, 'tile', 'sandstone');
    // nav: through the door, down the hall, along the corridor, out under the arch
    const L = (a: V3, c: V3) => this.bld.link(a[0], a[1], a[2], c[0], c[1], c[2]);
    L([-52, y, 4], [-47.5, y, 4]);
    L([-47.5, y, 4], [-35, y, 3.4]);
    L([-35, y, 3.4], [-35, y, -3]);
    L([-35, y, -3], [-35, y, -12]);
    L([-35, y, -12], [-35, LV.A, -19.5]);
    L([-35, LV.A, -19.5], [-35, LV.A, -24]);
  }
  /** upper-storey windows only (above an opening or a lower roofline) */
  private facadeAbove(k: SvBlock, cx: number, cz: number, nx: number, nz: number, L: number, y0: number, top: number) {
    this.frame(cx, 0, cz, nx, nz, () => {
      const n = Math.floor((L - 1.6) / 3.2);
      const step = (L - 1.6) / n;
      this.b.box('sandstoneDk', -L / 2 - 0.05, top - 0.35, -0.02, L / 2 + 0.05, top, 0.3);
      this.b.box('sandstoneDk', -L / 2, y0, -0.02, L / 2, y0 + 0.16, 0.1);
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + 0.8 + step * (i + 0.5);
        if (y0 + 0.9 + 1.7 < top - 0.5) this.window(x, y0 + 0.9, 1.1, 1.7, k.style, k.seed, true);
      }
    });
  }

  // ================================================================ the underpass ("Kjelleren")
  private kjelleren() {
    const K = SV_KJELLER, fl = LV.KJ, ceil = fl + 3.4, top = LV.T + 8.5;
    const S: Surface = 'concrete';
    // the hall's walls (the bakery block is the west wall above the hall floor) and the vault
    this.box('stone', 24, fl - 1, -12, 26, LV.T + 1.0, -2, S); // north ramp, east retaining wall
    this.box('stone', 24, fl - 1, -2, 26, top, 30, S);
    this.box('stone', 14, fl - 1, -2, 16.08, ceil, 30, S);
    this.box('stone', 23.92, fl - 1, -2, 24.0, ceil, 30);
    this.box('stone', 24, fl - 1, 30, 26, LV.T + 1.0, 38, S); // stairwell retaining wall
    this.solids.push({ x0: 24, z0: -12, x1: 26, z1: 38 });
    // ceiling slab (the building above), cross ribs, the barrel vault's look
    this.box('wallInt', 16, ceil, -2, 24, top, 30, S);
    for (let z = 0; z < 30; z += 4) {
      this.box('sandstoneDk', 16, fl, z - 0.3, 16.5, ceil, z + 0.3, S);
      this.box('sandstoneDk', 23.5, fl, z - 0.3, 24, ceil, z + 0.3, S);
      this.box('sandstoneDk', 16, ceil - 0.45, z - 0.3, 24, ceil, z + 0.3);
    }
    // the building above the underpass (shares the bakery's roofline)
    this.box('j_ochre', 14, ceil + 0.05, -2, 26, top, 30);
    const k: SvBlock = { x0: 14, z0: -2, x1: 26, z1: 30, h: 8, style: 'stucco', color: 'j_ochre', seed: 31 };
    this.facadeAbove(k, 20, -2, 0, -1, 12, LV.T + 1.6, top);
    this.facadeAbove(k, 20, 30, 0, 1, 12, LV.T + 1.6, top);
    this.roof(K, top, 'tile', 'j_ochre');
    // arch portals at both ends of the hall
    for (const [zz, nz] of [[-2, -1], [30, 1]] as const) {
      this.frame(20, 0, zz, 0, nz, () => {
        this.b.box('sandstoneDk', -4.1, fl, 0, -3.6, ceil, 0.25);
        this.b.box('sandstoneDk', 3.6, fl, 0, 4.1, ceil, 0.25);
        this.b.box('sandstoneDk', -4.1, ceil - 0.5, 0, 4.1, ceil + 0.3, 0.3);
      });
    }
    // lanterns, barrels and wine casks along the walls (cover), a drain channel
    this.b.push([0, 0, 0]);
    for (const z of [4, 14, 24]) this.bld.fixture(20, ceil - 0.45, z, 'bare');
    this.b.pop();
    for (const [x, z] of [[16.9, 6], [16.9, 7.1], [23.1, 18], [23.1, 19.1], [16.9, 22.5]] as const) {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 12);
      g.rotateZ(Math.PI / 2);
      g.translate(x, fl + 0.5, z);
      this.b.addGeo('tarWood', g);
      this.box(null, x - 0.5, fl, z - 0.5, x + 0.5, fl + 1.0, z + 0.5, 'wood');
    }
    this.crates(22.6, fl, 9, 2, 0.1);
    // stair treads down from top mid and up into B short (the ramps carry the colliders: terrain)
    for (let i = 0; i < 14; i++) {
      const z = 30 + (8 * (i + 0.5)) / 14, yy = this.h(20, z);
      this.box('sandstoneDk', 16.05, yy - 0.06, z - 0.08, 23.95, yy + 0.04, z + 0.08);
    }
    for (let i = 0; i < 12; i++) {
      const z = -12 + (10 * (i + 0.5)) / 12, yy = this.h(20, z);
      this.box('sandstoneDk', 16.05, yy - 0.06, z - 0.08, 23.95, yy + 0.04, z + 0.08);
    }
    // iron handrails
    this.box('iron', 16.1, LV.KJ + 1.0, 30, 16.16, LV.T + 1.0, 38);
    this.box('iron', 23.84, LV.KJ + 1.0, 30, 23.9, LV.T + 1.0, 38);
  }

  // ================================================================ the wharf lofts ("Loftet")
  private loft() {
    const P = SV_LOFT, y = LV.T, up = y + 3.4, ceil = up + 3.0, top = ceil + 0.6;
    const S: Surface = 'wood';
    const hall = { x0: 26.6, z0: 10, x1: 49.4, z1: 29.4 };
    const cor = { x0: 44.5, z0: -3.4, x1: 49.4, z1: 10 };
    // outer walls: painted timber, with the yard door (south) and the balcony door (north)
    this.box('red', P.x0, y - 1, P.z1 - 0.6, 36, top, P.z1, S);
    this.box('red', 40, y - 1, P.z1 - 0.6, P.x1, top, P.z1, S);
    this.box('red', 36, y + 2.8, P.z1 - 0.6, 40, top, P.z1, S);
    this.box('red', P.x0, LV.B - 1, P.z0, P.x0 + 0.6, top, P.z1, S);
    this.box('red', P.x1 - 0.6, y - 1, P.z0, P.x1, top, P.z1, S);
    this.box('red', P.x0, LV.B - 1, P.z0, 45.2, top, P.z0 + 0.6, S);
    this.box('red', 48.6, LV.B - 1, P.z0, P.x1, top, P.z0 + 0.6, S);
    this.box('red', 45.2, LV.B - 1, P.z0, 48.6, up, P.z0 + 0.6, S);
    this.box('red', 45.2, up + 2.5, P.z0, 48.6, top, P.z0 + 0.6, S);
    // the solid store rooms (not enterable) and the floor under the upper corridor
    this.box('wallInt', P.x0 + 0.6, LV.B - 1, P.z0 + 0.6, cor.x0, top, hall.z0, S);
    this.box('wallInt', cor.x0, LV.B - 1, P.z0 + 0.6, cor.x1, up, hall.z0, S);
    this.box('floorInt', cor.x0, up - 0.02, cor.z0, cor.x1, up + 0.02, hall.z0);
    this.box('wallInt', hall.x0, up, hall.z0, cor.x0, top, hall.z1, S); // the ground-floor hall's ceiling
    this.box('wallInt', cor.x0, ceil, cor.z0, cor.x1, top, hall.z0, S);
    // a beam ceiling over the stair
    this.box('wallInt', cor.x0, ceil, hall.z0, cor.x1, top, hall.z1, S);
    this.drape('floorInt', hall, 0.035);
    // the stair: from the hall floor (south, z 20) up to the corridor (z 10)
    {
      const x0 = 45, x1 = 49.2, z0 = 10, z1 = 20, len = Math.hypot(z1 - z0, up - y);
      const ang = Math.atan2(up - y, z1 - z0);
      this.b.obox(null, [(x0 + x1) / 2, (y + up) / 2 - 0.12, (z0 + z1) / 2], [x1 - x0, 0.24, len], new THREE.Euler(ang, 0, 0), 'woodFloor');
      for (let i = 0; i < 18; i++) {
        const t = (i + 0.5) / 18, z = z1 - t * (z1 - z0), yy = y + t * (up - y);
        this.box('floorInt', x0, yy - 0.25, z - 0.3, x1, yy + 0.02, z + 0.3);
      }
      // the stair's inner wall and handrail
      this.box('wallInt', 44.5, y, 10, 45, up + 1.0, 20, S);
      this.box('iron', 44.95, y + 1.0, 10, 45.0, up + 1.0, 20);
      // fill under the stair's high end so nothing walks under it
      this.box('wallInt', x0, y, 10, x1, up - 0.6, 14, S);
    }
    // the upper corridor: lanterns, fish nets and floats on the walls, a crate stack
    this.b.push([0, 0, 0]);
    for (const z of [-0.5, 6]) this.bld.fixture(47, ceil, z, 'bare');
    this.bld.fixture(36, up, 20, 'bare');
    this.bld.fixture(30, up, 24, 'bare');
    this.b.pop();
    this.box('net', 49.3, up + 0.4, -2.8, 49.36, ceil - 0.2, 7);
    for (let i = 0; i < 5; i++) this.b.cyl('buoy', 49.15, up + 1.2 + (i % 2) * 0.4, -2 + i * 2, 0.18, 0.36, 8);
    this.crates(44.9, up, 3.4, 1, 0.0);
    // the ground-floor hall: nets, crates, a work bench, barrels (cover)
    this.crates(30, y, 14, 3, 0.2);
    this.crates(36, y, 22, 2, -0.3);
    this.box('tarWood', 27.2, y + 0.85, 24, 31, y + 0.95, 27, 'wood');
    this.box('tarWood', 27.4, y, 24.2, 27.6, y + 0.85, 26.8);
    this.box('tarWood', 30.6, y, 24.2, 30.8, y + 0.85, 26.8);
    this.box('net', 26.66, y + 0.6, 12, 26.72, y + 2.6, 22);
    // the balcony over B and the outside stair down to the quay
    {
      const bz0 = -8, bz1 = -4, bx0 = 40, bx1 = 49.5;
      this.box('deck', bx0, up - 0.3, bz0, bx1, up, bz1, 'woodFloor');
      for (const px of [bx0 + 0.2, 44.6, bx1 - 0.2]) this.box('tarWood', px - 0.14, LV.B, bz0 + 0.06, px + 0.14, up - 0.3, bz0 + 0.34, 'wood');
      // railing (waist high, open to shoot through)
      this.box('tarWood', bx0, up + 0.95, bz0, bx1, up + 1.05, bz0 + 0.08);
      for (let x = bx0 + 0.3; x < bx1; x += 0.5) this.box('tarWood', x - 0.03, up, bz0, x + 0.03, up + 0.95, bz0 + 0.06);
      this.box('tarWood', bx1 - 0.08, up, bz0, bx1, up + 1.05, bz1);
      this.box(null, bx0, up, bz0 - 0.05, bx1, up + 1.05, bz0 + 0.1, 'wood');
      // stair: from the balcony's west end (x 40) down westward to the quay (x 28)
      const sx0 = 28, sx1 = 40, len = Math.hypot(sx1 - sx0, up - LV.B), ang = Math.atan2(up - LV.B, sx1 - sx0);
      this.b.obox(null, [(sx0 + sx1) / 2, (LV.B + up) / 2 - 0.12, -6], [len, 0.24, 2.4], new THREE.Euler(0, 0, ang), 'woodFloor');
      for (let i = 0; i < 20; i++) {
        const t = (i + 0.5) / 20, x = sx0 + t * (sx1 - sx0), yy = LV.B + t * (up - LV.B);
        this.box('deck', x - 0.3, yy - 0.2, -7.2, x + 0.3, yy + 0.02, -4.8);
      }
      this.box('tarWood', sx0, LV.B, -7.3, sx1, LV.B + 0.4, -7.2);
      // the space under the stair is boarded up (solid)
      for (let i = 0; i < 6; i++) {
        const xa = sx0 + 2 + i * 1.7, yy = LV.B + ((xa + 1.7 - sx0) / (sx1 - sx0)) * (up - LV.B) - 0.5;
        this.box('tarWood', xa, LV.B - 0.2, -7.2, xa + 1.7, Math.max(LV.B + 0.2, yy), -4.8, 'wood');
      }
      this.box('tarWood', sx0, up + 0.9, -7.25, sx1, up + 0.98 - 0, -7.18);
      this.frame(44, 0, P.z0, 0, -1, () => this.lantern(-2.5, up + 2.0, 0.0));
    }
    // exterior dressing: windows on the yard side and the B side, the turf roof
    const k: SvBlock = { ...P, h: 7, style: 'timber', color: 'red', seed: 41 };
    this.facadeAbove(k, (P.x0 + P.x1) / 2, P.z1, 0, 1, P.x1 - P.x0, up, top);
    this.facadeAbove(k, (P.x0 + P.x1) / 2, P.z0, 0, -1, P.x1 - P.x0, up + 2.6, top);
    this.facadeAbove(k, P.x1, (P.z0 + P.z1) / 2, 1, 0, P.z1 - P.z0, y + 0.6, top);
    this.roof(P, top, 'turf', 'red', 0.7);
    // a hoist beam over the yard door (the loft's working front)
    this.box('tarWood', 37.6, top - 0.6, P.z1, 38.4, top - 0.2, P.z1 + 1.6);
    this.box('rope', 38.0, y + 3.4, P.z1 + 1.4, 38.04, top - 0.6, P.z1 + 1.44);
    // nav: yard door → hall → stair → corridor → balcony → stair → quay
    const L = (a: V3, c: V3) => this.bld.link(a[0], a[1], a[2], c[0], c[1], c[2]);
    L([38, y, 33], [38, y, 27]);
    L([38, y, 27], [47, y, 21.5]);
    L([47, y, 21.5], [47, (y + up) / 2, 15]);
    L([47, (y + up) / 2, 15], [47, up, 9]);
    L([47, up, 9], [47, up, 2]);
    L([47, up, 2], [47, up, -3]);
    L([47, up, -3], [46, up, -6]);
    L([46, up, -6], [41, up, -6]);
    L([41, up, -6], [34, (up + LV.B) / 2, -6]);
    L([34, (up + LV.B) / 2, -6], [27, LV.B, -6]);
    L([27, LV.B, -6], [27, LV.B, -10]);
  }

  // ================================================================ the stave church
  private church() {
    const C = SV_CHURCH, y = LV.T;
    // the churchyard wall (too high to vault), a lychgate facing mid (closed)
    const wy = y + 3.2;
    this.box('stone', C.x0, y - 1, C.z0, C.x1, wy, C.z0 + 0.6, 'rock');
    this.box('stone', C.x0, y - 1, C.z1 - 0.6, C.x1, wy, C.z1, 'rock');
    this.box('stone', C.x0, y - 1, C.z0, C.x0 + 0.6, wy, C.z1, 'rock');
    this.box('stone', C.x1 - 0.6, y - 1, C.z0, C.x1, wy, C.z1, 'rock');
    for (const [x0, z0, x1, z1] of [[C.x0, C.z0, C.x1, C.z0 + 0.6], [C.x0, C.z1 - 0.6, C.x1, C.z1], [C.x0, C.z0, C.x0 + 0.6, C.z1], [C.x1 - 0.6, C.z0, C.x1, C.z1]])
      this.box('sod', x0 - 0.05, wy, z0 - 0.05, x1 + 0.05, wy + 0.12, z1 + 0.05);
    this.frame(C.x0, 0, -35, -1, 0, () => {
      this.b.box('tarWood', -1.6, y, 0, -1.3, y + 3.6, 0.3);
      this.b.box('tarWood', 1.3, y, 0, 1.6, y + 3.6, 0.3);
      this.b.box('shingles', -1.9, y + 3.6, -0.6, 1.9, y + 3.75, 0.9);
      this.b.box('tarWood', -1.3, y, 0.05, 1.3, y + 2.6, 0.12);
    });
    // gravestones in the grass
    for (let i = 0; i < 12; i++) {
      const gx = C.x0 + 1.4 + (i % 4) * 2.9, gz = C.z0 + 1.6 + Math.floor(i / 4) * 7.5 + (i % 2) * 0.6;
      if (gx > 8.5 && gx < 18.5 && gz > -42 && gz < -28) continue;
      this.box('stone', gx - 0.3, y - 0.2, gz - 0.08, gx + 0.3, y + 0.8, gz + 0.08);
    }
    // the church itself: a tarred-timber nave in three stacked tiers, a gallery round the base,
    // dragon heads on the gable ends, a spire (the town's landmark, seen from mid and both sites)
    const cx = 13.5, cz = -35;
    const T = (hw: number, hd: number, y0: number, y1: number, mat = 'tarWood') => this.box(mat, cx - hw, y0, cz - hd, cx + hw, y1, cz + hd);
    T(3.4, 5.2, y - 0.5, y + 4.5);
    // the gallery: a low shingled roof around the base on posts
    T(4.6, 6.4, y - 0.5, y + 0.25, 'stone');
    for (let px = cx - 4.3; px <= cx + 4.31; px += 1.43)
      for (const pz of [cz - 6.1, cz + 6.1]) this.box('tarWood', px - 0.1, y + 0.25, pz - 0.1, px + 0.1, y + 2.4, pz + 0.1);
    for (let pz = cz - 4.6; pz <= cz + 4.61; pz += 1.53)
      for (const px of [cx - 4.3, cx + 4.3]) this.box('tarWood', px - 0.1, y + 0.25, pz - 0.1, px + 0.1, y + 2.4, pz + 0.1);
    this.pyramidRoof(cx, cz, 4.8, 6.6, y + 2.4, y + 3.6, 3.4, 5.2);
    T(2.6, 4.2, y + 4.5, y + 7.6);
    this.pyramidRoof(cx, cz, 3.6, 5.4, y + 4.5, y + 6.0, 2.6, 4.2);
    this.gableRoof(cx, cz, 2.6, 4.2, y + 7.6, 3.4);
    T(1.5, 1.5, y + 9.8, y + 12.6);
    this.pyramidRoof(cx, cz, 2.3, 2.3, y + 11.0, y + 11.9, 1.5, 1.5);
    {
      const g = new THREE.ConeGeometry(1.6, 8.5, 4, 1, true);
      g.rotateY(Math.PI / 4);
      g.translate(cx, y + 12.6 + 4.25, cz);
      this.b.addGeo('shingles', g);
      this.b.cyl('gold', cx, y + 21.0, cz, 0.06, 1.2, 6);
      this.box('gold', cx - 0.35, y + 21.7, cz - 0.04, cx + 0.35, y + 21.78, cz + 0.04);
    }
    // dragon heads: curved necks off the gable ends of the upper roof
    for (const s of [-1, 1]) {
      const pts: [number, number][] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push([t * 1.8, Math.sin(t * Math.PI * 0.9) * 0.9 + t * 0.8]);
      }
      for (let i = 8; i >= 0; i--) {
        const t = i / 8;
        pts.push([t * 1.8 + 0.1, Math.sin(t * Math.PI * 0.9) * 0.9 + t * 0.8 - 0.28]);
      }
      this.b.push([cx, y + 7.6 + 3.4 - 0.3, cz + s * 4.2], s > 0 ? -Math.PI / 2 : Math.PI / 2);
      this.slab('tarWood', pts, -0.06, 0.12);
      this.b.pop();
    }
    // west door with carved posts
    this.frame(cx, 0, cz + 5.2, 0, 1, () => {
      this.b.box('gold', -0.9, y, 0, -0.7, y + 2.8, 0.12);
      this.b.box('gold', 0.7, y, 0, 0.9, y + 2.8, 0.12);
      this.halfDisc('tarWood', 0, y + 2.4, 0.7, 0.01, 0.08);
      this.b.box('door', -0.7, y, 0.02, 0.7, y + 2.4, 0.08);
    });
    this.box(null, cx - 3.4, y, cz - 5.2, cx + 3.4, y + 12, cz + 5.2, 'wood');
  }
  private pyramidRoof(cx: number, cz: number, hw: number, hd: number, y0: number, y1: number, ihw: number, ihd: number) {
    const m = 'shingles';
    const o: V3[] = [[cx - hw, y0, cz - hd], [cx + hw, y0, cz - hd], [cx + hw, y0, cz + hd], [cx - hw, y0, cz + hd]];
    const i: V3[] = [[cx - ihw, y1, cz - ihd], [cx + ihw, y1, cz - ihd], [cx + ihw, y1, cz + ihd], [cx - ihw, y1, cz + ihd]];
    for (let k = 0; k < 4; k++) {
      const a = o[k], b = o[(k + 1) % 4], c = i[(k + 1) % 4], d = i[k];
      this.quad(m, b, a, d, c);
    }
  }
  private gableRoof(cx: number, cz: number, hw: number, hd: number, y: number, rise: number) {
    const oh = 0.5;
    const top = y + rise;
    this.quad('shingles', [cx - hw - oh, y - 0.3, cz + hd + oh], [cx, top, cz + hd + oh], [cx, top, cz - hd - oh], [cx - hw - oh, y - 0.3, cz - hd - oh]);
    this.quad('shingles', [cx + hw + oh, y - 0.3, cz - hd - oh], [cx, top, cz - hd - oh], [cx, top, cz + hd + oh], [cx + hw + oh, y - 0.3, cz + hd + oh]);
    this.tri('tarWood', [cx + hw, y, cz - hd], [cx - hw, y, cz - hd], [cx, top, cz - hd]);
    this.tri('tarWood', [cx - hw, y, cz + hd], [cx + hw, y, cz + hd], [cx, top, cz + hd]);
  }

  // ================================================================ "Vinduet": the window over mid
  private vinduet() {
    // the CT building (block 12) is solid; a room is cut into its front at the first floor with a
    // big window looking straight down mid, reached by an outside stair from the church square
    const y = LV.CT, fl = y + 3.6, ceil = fl + 3.0;
    const z0 = -70, z1 = -62;
    // the room: carve by building it as a box inside the block's footprint... the block is one
    // solid box, so the room is built in front of it as a projecting oriel (bay) on corbels
    const x0 = -5, x1 = 5;
    this.box('j_jwhite', x0, fl - 0.3, z1, x1, fl, z1 + 4.2, 'concrete'); // floor
    this.box('j_jwhite', x0, ceil, z1, x1, ceil + 0.5, z1 + 4.2, 'concrete'); // ceiling
    this.box('j_jwhite', x0, fl, z1, x0 + 0.4, ceil, z1 + 4.2, 'concrete'); // west wall
    this.box('j_jwhite', x1 - 0.4, fl, z1, x1, ceil, z1 + 1.2, 'concrete'); // east wall (door gap 1.2..2.6)
    this.box('j_jwhite', x1 - 0.4, fl + 2.3, z1 + 1.2, x1, ceil, z1 + 2.6, 'concrete');
    this.box('j_jwhite', x1 - 0.4, fl, z1 + 2.6, x1, ceil, z1 + 4.2, 'concrete');
    // the front wall with the window (sill 1.0 m, 1.5 m high, 3 m wide)
    const fz0 = z1 + 3.8, fz1 = z1 + 4.2;
    this.box('j_jwhite', x0, fl, fz0, x1, fl + 1.0, fz1, 'concrete');
    this.box('j_jwhite', x0, fl + 2.5, fz0, x1, ceil, fz1, 'concrete');
    this.box('j_jwhite', x0, fl + 1.0, fz0, -1.5, fl + 2.5, fz1, 'concrete');
    this.box('j_jwhite', 1.5, fl + 1.0, fz0, x1, fl + 2.5, fz1, 'concrete');
    this.box('trim', -1.7, fl + 0.85, fz1, 1.7, fl + 1.0, fz1 + 0.18);
    this.box('trim', -1.7, fl + 2.5, fz1, 1.7, fl + 2.7, fz1 + 0.12);
    this.box('shutterBlue', -2.9, fl + 1.0, fz1, -1.7, fl + 2.5, fz1 + 0.06);
    this.box('shutterBlue', 1.7, fl + 1.0, fz1, 2.9, fl + 2.5, fz1 + 0.06);
    this.box('floorInt', x0 + 0.4, fl - 0.02, z1, x1 - 0.4, fl + 0.02, fz0);
    // corbels under the bay
    for (const cxx of [x0 + 0.5, 0, x1 - 0.5]) this.box('sandstoneDk', cxx - 0.25, fl - 1.4, z1, cxx + 0.25, fl - 0.3, z1 + 3.6);
    // a roof over the bay
    this.quad('roofRed', [x1 + 0.3, ceil + 0.5, z1 + 4.7], [x1 + 0.3, ceil + 1.6, z1], [x0 - 0.3, ceil + 1.6, z1], [x0 - 0.3, ceil + 0.5, z1 + 4.7]);
    this.b.push([0, 0, 0]);
    this.bld.fixture(0, ceil, z1 + 2, 'pendant');
    this.b.pop();
    // the outside stair: from the square (east, x 15) up westward to a landing at the bay's door
    {
      const sx0 = 5, sx1 = 15, sz0 = -61.8, sz1 = -59.6;
      const len = Math.hypot(sx1 - sx0, fl - y), ang = -Math.atan2(fl - y, sx1 - sx0);
      this.b.obox(null, [(sx0 + sx1) / 2, (y + fl) / 2 - 0.15, (sz0 + sz1) / 2], [len, 0.3, sz1 - sz0], new THREE.Euler(0, 0, ang), 'rock');
      for (let i = 0; i < 18; i++) {
        const t = (i + 0.5) / 18, x = sx1 - t * (sx1 - sx0), yy = y + t * (fl - y);
        this.box('sandstoneDk', x - 0.3, y - 0.2, sz0, x + 0.3, yy + 0.02, sz1, null);
      }
      this.box(null, sx0, y, sz0, sx1 - 4, fl - 1.2, sz1, 'rock');
      // landing in front of the door
      this.box('iron', sx0, fl + 0.95, sz1 - 0.06, sx1, fl + 1.0, sz1);
      this.solids.push({ x0: sx0 - 0.5, z0: sz0, x1: sx1, z1: sz1 });
      const L = (a: V3, c: V3) => this.bld.link(a[0], a[1], a[2], c[0], c[1], c[2]);
      L([17, y, -59], [14, y + 0.4, -60.6]);
      L([14, y + 0.4, -60.6], [6, fl, -60.6]);
      L([6, fl, -60.6], [3.8, fl, -60.1]);
      L([3.8, fl, -60.1], [0, fl, -59.6]);
    }
    void z0;
  }

  // ================================================================ boathouses (north of B)
  private boathouses(k: SvBlock, lo: number, hi: number) {
    void hi;
    const n = 6, w = (k.x1 - k.x0) / n;
    for (let i = 0; i < n; i++) {
      const x0 = k.x0 + i * w + 0.25, x1 = x0 + w - 0.5;
      const mat = ['red', 'red', 'ochre', 'red', 'white', 'red'][i];
      const top = lo + 5.5 + (i % 2) * 0.8;
      this.box(mat, x0, lo - 1, k.z0, x1, top, k.z1, 'wood');
      this.box('stone', x0 - 0.05, lo - 1, k.z1 - 0.3, x1 + 0.05, lo + 0.5, k.z1 + 0.05);
      // gable front facing the quay, double doors, a hay hatch, a hanging lantern
      this.frame((x0 + x1) / 2, 0, k.z1, 0, 1, () => {
        const hw = (x1 - x0) / 2;
        this.b.box('trim', -hw, lo, -0.02, -hw + 0.16, top, 0.06);
        this.b.box('trim', hw - 0.16, lo, -0.02, hw, top, 0.06);
        this.b.box('tarWood', -1.6, lo, 0.0, 1.6, lo + 3.2, 0.08);
        this.b.box('trim', -1.7, lo + 3.2, -0.02, 1.7, lo + 3.35, 0.1);
        this.b.box('tarWood', -0.04, lo, 0.08, 0.04, lo + 3.2, 0.11);
        this.b.box('tarWood', -0.6, top - 1.6, 0.0, 0.6, top - 0.6, 0.08);
        this.b.box('trim', -0.7, top - 1.7, -0.02, 0.7, top - 0.5, 0.05);
        if (i % 2 === 0) this.lantern(1.9, lo + 3.0, 0.05);
      });
      this.roof({ x0, z0: k.z0, x1, z1: k.z1 }, top, i % 3 === 1 ? 'turf' : 'slate', mat, 0.4);
    }
    // fishing gear along the fronts: nets on racks, floats, fish crates
    for (let i = 0; i < 4; i++) {
      const x = k.x0 + 6 + i * 12;
      this.box('tarWood', x - 1.5, lo, k.z1 + 0.4, x - 1.35, lo + 2.2, k.z1 + 0.55);
      this.box('tarWood', x + 1.35, lo, k.z1 + 0.4, x + 1.5, lo + 2.2, k.z1 + 0.55);
      this.box('tarWood', x - 1.5, lo + 2.1, k.z1 + 0.4, x + 1.5, lo + 2.2, k.z1 + 0.55);
      this.box('net', x - 1.4, lo + 0.6, k.z1 + 0.46, x + 1.4, lo + 2.1, k.z1 + 0.5);
    }
  }

  // ================================================================ the station (behind T spawn)
  private station(k: SvBlock, lo: number, hi: number) {
    void lo;
    const y = LV.T, top = y + 9;
    // the hall behind an open arcade: 11 arches facing the square
    const az0 = k.z0, az1 = k.z0 + 4.5;
    this.box('sandstone', k.x0, y - 1.5, az1, k.x1, top, k.z1, 'concrete');
    this.box('sandstone', k.x0, y + 4.6, az0, k.x1, top, az1, 'concrete');
    const n = 22, span = (k.x1 - k.x0) / n;
    for (let i = 0; i <= n; i++) {
      const x = k.x0 + i * span;
      this.box('sandstone', x - 0.45, y - 0.2, az0, x + 0.45, y + 4.6, az0 + 0.9, 'concrete');
      this.box('sandstoneDk', x - 0.6, y - 0.2, az0 - 0.1, x + 0.6, y + 0.35, az0 + 1.0);
      if (i < n) this.frame(x + span / 2, 0, az0, 0, -1, () => {
        this.spandrel('sandstone', 0, y + 2.9, span / 2 - 0.45, y + 4.6, -0.9, 0.9);
        this.arch('sandstoneDk', 0, y + 2.9, span / 2 - 0.45, 0.2, 0.0, 0.08);
      });
    }
    this.drape('flags', { x0: k.x0, z0: az0, x1: k.x1, z1: az1 }, 0.035);
    this.solids.push({ x0: k.x0, z0: az1, x1: k.x1, z1: k.z1 });
    // doors and timetable boards along the back wall of the arcade
    for (let i = 0; i < n; i += 2) {
      const x = k.x0 + (i + 0.5) * span;
      this.frame(x, 0, az1, 0, -1, () => {
        this.b.box('door', -0.8, y, 0, 0.8, y + 2.6, 0.08);
        this.b.box('trim', -0.95, y + 2.6, -0.02, 0.95, y + 2.8, 0.1);
        if (i % 4 === 2) this.b.box('signBlue', -0.7, y + 3.0, 0, 0.7, y + 3.7, 0.06);
      });
    }
    this.b.push([0, 0, 0]);
    for (let i = 1; i < n; i += 3) this.bld.fixture(k.x0 + i * span, y + 4.6, az0 + 2.3, 'pendant');
    this.b.pop();
    // upper floor windows and the clock tower over the middle
    const kk: SvBlock = { ...k, style: 'station' };
    this.facadeAbove(kk, (k.x0 + k.x1) / 2, az0, 0, -1, k.x1 - k.x0, y + 4.9, top);
    this.roof({ x0: k.x0, z0: az0, x1: k.x1, z1: k.z1 }, top, 'tile', 'sandstone');
    const tx = 0, tz = az0 + 3;
    this.box('sandstone', tx - 2.6, top - 1, tz - 2.6, tx + 2.6, top + 9, tz + 2.6, 'concrete');
    this.box('sandstoneDk', tx - 2.9, top + 9, tz - 2.9, tx + 2.9, top + 9.5, tz + 2.9);
    {
      const g = new THREE.ConeGeometry(3.3, 6, 4, 1, true);
      g.rotateY(Math.PI / 4);
      g.translate(tx, top + 12.5, tz);
      this.b.addGeo('copper', g);
    }
    this.frame(tx, 0, tz - 2.6, 0, -1, () => {
      const g = new THREE.CylinderGeometry(1.35, 1.35, 0.1, 24);
      g.rotateX(Math.PI / 2);
      g.translate(0, top + 6.3, 0.06);
      this.b.addGeo('ceramic', g);
      const r = new THREE.TorusGeometry(1.4, 0.09, 6, 24);
      r.translate(0, top + 6.3, 0.1);
      this.b.addGeo('gold', r);
      this.b.box('iron', -0.04, top + 6.3, 0.12, 0.04, top + 7.3, 0.16);
      this.b.box('iron', -0.04, top + 6.26, 0.12, 0.7, top + 6.34, 0.16);
    });
    this.flag(tx, top + 16.5, tz, 2.4);
    this.b.cyl('gold', tx, top + 15.3, tz, 0.07, 1.4, 6);
    void hi;
  }

  // ================================================================ sea wall, promenade, quay
  private seaWall() {
    // the wall between the B lane / spawn and the drop to the promenade
    this.box('granite', 64, 0.3, -18, 65, LV.B + 1.1, -4, 'rock');
    this.box('granite', 64, 0.3, -4, 65, LV.T + 1.1, 52, 'rock');
    this.box('sandstoneDk', 63.9, LV.T + 1.1, -4, 65.1, LV.T + 1.22, 52);
    this.box('sandstoneDk', 63.9, LV.B + 1.1, -18, 65.1, LV.B + 1.22, -4);
    this.solids.push({ x0: 64, z0: -18, x1: 65, z1: 52 });
    // the spawn's quay edge and railing (the ferry berth)
    this.box('granite', 72.5, -2, 52, 74, LV.T, 90, 'rock');
    this.rail(72.6, 52, 72.6, 76, LV.T);
    // mooring bollards
    for (let z = 56; z < 76; z += 6) this.b.cyl('iron', 73.3, LV.T, z, 0.22, 0.6, 10, 'metal');
  }
  /** a waist-high iron railing from (x0,z0) to (x1,z1) at floor y */
  private rail(x0: number, z0: number, x1: number, z1: number, y: number) {
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 1.6);
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      this.box('iron', x - 0.04, y, z - 0.04, x + 0.04, y + 1.05, z + 0.04);
    }
    const ax = Math.min(x0, x1) - 0.03, bx = Math.max(x0, x1) + 0.03, az = Math.min(z0, z1) - 0.03, bz = Math.max(z0, z1) + 0.03;
    this.box('iron', ax, y + 1.0, az, bx, y + 1.06, bz);
    this.box('iron', ax, y + 0.5, az, bx, y + 0.54, bz);
    this.box(null, ax, y, az, bx, y + 1.06, bz, 'metal');
  }
  private promenade() {
    const d = LV.DECK;
    // the deck on piles along the shore
    const R0 = AREA.deck;
    this.box('deck', R0.x0, d - 0.25, R0.z0, R0.x1, d, R0.z1, 'woodFloor');
    for (let z = R0.z0 + 1; z < R0.z1; z += 3) for (const x of [R0.x0 + 0.4, R0.x1 - 0.4]) this.b.cyl('tarWood', x, -3, z, 0.16, d + 2.8, 8);
    this.rail(R0.x1 - 0.1, R0.z0, R0.x1 - 0.1, R0.z1, d);
    // stairs down from the spawn (z 52 → 34) and up into B (z -6 → -18)
    const stair = (z0: number, z1: number, y0: number, y1: number) => {
      const len = Math.hypot(z1 - z0, y1 - y0), ang = Math.atan2(y1 - y0, z1 - z0);
      this.b.obox(null, [68.5, (y0 + y1) / 2 - 0.14, (z0 + z1) / 2], [7, 0.28, len], new THREE.Euler(-ang, 0, 0), 'woodFloor');
      const n = Math.ceil(Math.abs(z1 - z0) / 0.55);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, z = z0 + t * (z1 - z0), yy = y0 + t * (y1 - y0);
        this.box('deck', 65.1, yy - 0.22, z - 0.3, 71.9, yy + 0.02, z + 0.3);
      }
      for (let z = Math.min(z0, z1) + 1; z < Math.max(z0, z1); z += 3) {
        const yy = y0 + ((z - z0) / (z1 - z0)) * (y1 - y0);
        this.b.cyl('tarWood', 71.6, -3, z, 0.16, yy + 2.8, 8);
      }
      this.rail(71.9, z0, 71.9, z1, Math.min(y0, y1));
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      this.box('iron', 71.86, hi + 1.0, Math.min(z0, z1), 71.94, hi + 1.06, Math.max(z0, z1));
      void lo;
    };
    stair(AREA.deckStairs.z0, AREA.deckStairs.z1, d, LV.T);
    stair(-6, -18, d, LV.B);
    // the shore rocks below
    for (let i = 0; i < 26; i++) {
      const z = -6 + i * 2.2 + this.rng.range(-0.6, 0.6);
      const g = new THREE.DodecahedronGeometry(this.rng.range(0.6, 1.3), 0);
      g.scale(1, 0.55, 1);
      g.translate(this.rng.range(66, 73), this.rng.range(0.1, 0.5), z);
      this.b.addGeo('boulder', g);
    }
    // benches and lamp posts along the promenade, a moored boat or two
    for (const z of [2, 14, 26]) {
      this.box('tarWood', 65.4, d + 0.45, z - 1, 66.0, d + 0.52, z + 1, 'wood');
      this.box('iron', 65.4, d, z - 0.9, 65.5, d + 0.45, z - 0.8);
      this.box('iron', 65.4, d, z + 0.8, 65.5, d + 0.45, z + 0.9);
    }
    for (const z of [8, 20, 32]) this.lampPost(71.4, d, z);
    this.boat(76.5, 12, Math.PI * 0.5, 'boatRed');
    this.boat(77.5, 28, Math.PI * 0.52, 'boatWhite');
  }
  private lampPost(x: number, y: number, z: number) {
    this.b.cyl('iron', x, y, z, 0.07, 3.4, 8, 'metal');
    this.box('iron', x - 0.2, y + 3.4, z - 0.2, x + 0.2, y + 3.48, z + 0.2);
    this.box('bulbWarm', x - 0.14, y + 3.48, z - 0.14, x + 0.14, y + 3.82, z + 0.14);
    this.box('iron', x - 0.22, y + 3.82, z - 0.22, x + 0.22, y + 3.9, z + 0.22);
    const p = new THREE.Vector3(x, y + 3.6, z);
    this.bld.fixtures.push({ p, color: 0xffb468, intensity: 8, dist: 12 });
    this.lanterns.push(p);
  }
  private boat(x: number, z: number, yaw: number, mat: string) {
    this.b.push([x, 0, z], yaw);
    const hull: [number, number][] = [[-3.4, 0.9], [-3.0, 0.1], [-1.2, -0.35], [1.6, -0.35], [3.2, 0.2], [3.6, 1.0]];
    this.b.push([0, 0, 0], 0);
    this.slab(mat, hull.concat([[3.6, 1.0]]).map(([a, c]) => [a, c] as [number, number]), -1.0, 2.0);
    this.b.pop();
    this.b.box('deck', -3.0, 0.75, -0.95, 3.2, 0.85, 0.95);
    this.b.box('white', -1.6, 0.85, -0.7, 0.4, 2.0, 0.7);
    this.b.box('jglass', -1.62, 1.4, -0.6, -1.58, 1.85, 0.6);
    this.b.box('red', -1.7, 2.0, -0.8, 0.5, 2.1, 0.8);
    this.b.cyl('white', -0.6, 2.1, 0, 0.05, 2.4, 6);
    this.b.pop();
  }
  private quay() {
    const y = LV.B;
    // the quay edge at the fjord: granite face, coping, railing, bollards, a ladder
    this.box('granite', 72, -3, -62, 74, y, -18, 'rock');
    this.box('sandstoneDk', 71.8, y, -62, 74.1, y + 0.12, -18);
    this.rail(72.2, -62, 72.2, -18, y + 0.12);
    for (let z = -58; z < -18; z += 7) this.b.cyl('iron', 73.3, y + 0.12, z, 0.22, 0.55, 10, 'metal');
    // the retaining wall between the church stairs and the quay, and the stair's side wall to the B houses
    for (let i = 0; i < 7; i++) {
      const x0 = 26 + i * (8 / 7), x1 = x0 + 8 / 7;
      const yy = this.h(Math.min(33.5, x1), -55);
      this.box('stone', x0, y - 1, -50.6, x1, yy + 1.0, -49.6, 'rock');
    }
    this.solids.push({ x0: 26, z0: -50.6, x1: 34, z1: -49.6 });
    // boats in the water off the quay
    this.boat(79, -48, Math.PI * 0.48, 'boatWhite');
    this.boat(80, -30, Math.PI * 0.55, 'boatRed');
    this.boat(86, -60, Math.PI * 0.3, 'boatWhite');
  }

  // ================================================================ walls between areas
  private streetWalls() {
    const W = (x0: number, z0: number, x1: number, z1: number, top: number, mat = 'stone') => {
      this.box(mat, x0, Math.min(this.h(x0, z0), this.h(x1, z1)) - 1, z0, x1, top, z1, 'rock');
      this.box('sandstoneDk', x0 - 0.08, top, z0 - 0.08, x1 + 0.08, top + 0.15, z1 + 0.08);
      this.solids.push({ x0, z0, x1, z1 });
    };
    // the yard: walls to top mid (west) and the B lane (east), with gates closed
    W(25.5, 30, 26.5, 46, LV.T + 3.2);
    W(49.5, 30, 50.5, 46, LV.T + 3.2);
    // CT back: west and north walls
    W(-24, -80, -21, -66, LV.CT + 5);
    W(-24, -82, -8, -78, LV.CT + 5);
  }

  // ================================================================ props and cover
  /** a stack of wooden crates (n high) with one collider */
  private crates(x: number, y: number, z: number, n: number, yaw: number, s = 1.1) {
    this.b.push([x, y, z], yaw);
    for (let i = 0; i < n; i++) {
      const o = (i % 2) * 0.08;
      this.b.box('crate', -s / 2 + o, i * s, -s / 2, s / 2 + o, (i + 1) * s - 0.02, s / 2);
      this.b.box('tarWood', -s / 2 + o - 0.01, i * s + s * 0.45, -s / 2 - 0.01, s / 2 + o + 0.01, i * s + s * 0.55, s / 2 + 0.01);
    }
    this.b.box(null, -s / 2, 0, -s / 2, s / 2 + 0.08, n * s, s / 2, 'wood');
    this.b.pop();
  }
  /** a big two-by-two crate block (a site's main cover) */
  private crateBlock(x: number, y: number, z: number, yaw: number, high: boolean) {
    this.b.push([x, y, z], yaw);
    const s = 1.2;
    for (const [ox, oz] of [[0, 0], [s, 0], [0, s], [s, s]]) this.b.box('crate', ox - s / 2, 0, oz - s / 2, ox + s / 2 - 0.02, s - 0.02, oz + s / 2 - 0.02);
    if (high) for (const [ox, oz] of [[0, 0], [s, 0]]) this.b.box('crate', ox - s / 2, s, oz - s / 2, ox + s / 2 - 0.02, 2 * s - 0.02, oz + s / 2 - 0.02);
    this.b.box(null, -s / 2, 0, -s / 2, s * 1.5, s, s * 1.5, 'wood');
    if (high) this.b.box(null, -s / 2, s, -s / 2, s * 1.5, 2 * s, s / 2, 'wood');
    this.b.pop();
  }
  private barrel(x: number, y: number, z: number) {
    this.b.push([x, y, z]);
    this.b.destructible('barrel', new THREE.Matrix4(), { mat: this.rng.pick(['contBlue', 'rust', 'contGreen']) });
    this.b.pop();
  }
  /** a two-wheeled hand cart (low cover) */
  private cart(x: number, y: number, z: number, yaw: number) {
    this.b.push([x, y, z], yaw);
    this.b.box('woodRaw', -1.0, 0.55, -0.7, 1.0, 0.65, 0.7);
    this.b.box('woodRaw', -1.0, 0.65, -0.72, 1.0, 1.15, -0.62);
    this.b.box('woodRaw', -1.0, 0.65, 0.62, 1.0, 1.15, 0.72);
    this.b.box('woodRaw', 0.9, 0.65, -0.7, 1.0, 1.15, 0.7);
    this.b.box('woodRaw', -2.2, 0.5, -0.5, -1.0, 0.58, -0.42);
    this.b.box('woodRaw', -2.2, 0.5, 0.42, -1.0, 0.58, 0.5);
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 14);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0.5, s * 0.78);
      this.b.addGeo('tarWood', g);
    }
    this.b.box('hay', -0.9, 0.65, -0.6, 0.85, 1.25, 0.6);
    this.b.box(null, -1.0, 0, -0.75, 1.0, 1.2, 0.75, 'wood');
    this.b.pop();
  }
  /** a market stall: four posts, a striped awning, a counter with produce (cover) */
  private stall(x: number, y: number, z: number, yaw: number, awn: string, goods: 'fish' | 'fruit' | 'flowers') {
    this.b.push([x, y, z], yaw);
    for (const [px, pz] of [[-1.3, -0.8], [1.3, -0.8], [-1.3, 0.8], [1.3, 0.8]]) this.b.box('woodRaw', px - 0.05, 0, pz - 0.05, px + 0.05, 2.4, pz + 0.05);
    this.quad(awn, [1.5, 2.55, -1.0], [1.5, 2.3, 1.1], [-1.5, 2.3, 1.1], [-1.5, 2.55, -1.0]);
    this.quad(awn, [-1.5, 2.3, 1.1], [-1.5, 2.0, 1.1], [1.5, 2.0, 1.1], [1.5, 2.3, 1.1]);
    this.b.box('woodRaw', -1.3, 0, 0.5, 1.3, 0.95, 0.8);
    this.b.box('woodRaw', -1.35, 0.95, 0.2, 1.35, 1.02, 0.85);
    const gm = goods === 'fish' ? ['fishCrate', 'fishCrateRed'] : goods === 'fruit' ? ['flowerRed', 'awnOchre'] : ['flowerPink', 'flowerWhite'];
    for (let i = 0; i < 5; i++) {
      const gx = -1.1 + i * 0.55;
      this.b.box(goods === 'fish' ? gm[i % 2] : 'woodRaw', gx - 0.24, 1.02, 0.25, gx + 0.24, 1.18, 0.8);
      if (goods !== 'fish') this.b.box(gm[i % 2], gx - 0.2, 1.18, 0.3, gx + 0.2, 1.3, 0.75);
      else this.b.box('fish', gx - 0.2, 1.18, 0.3, gx + 0.2, 1.24, 0.75);
    }
    this.b.box(null, -1.35, 0, 0.2, 1.35, 1.1, 0.85, 'wood');
    this.b.pop();
  }
  /** strings of festoon bulbs across a street (between two facades) */
  private festoon(x0: number, z0: number, x1: number, z1: number, y: number) {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.9);
    for (let i = 0; i <= n; i++) {
      const t = i / n, sag = Math.sin(t * Math.PI) * 0.9;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, yy = y - sag;
      this.box('bulbWarm', x - 0.05, yy - 0.12, z - 0.05, x + 0.05, yy - 0.02, z + 0.05);
    }
  }
  /** a washing line with laundry over an alley */
  private laundry(x0: number, z0: number, x1: number, z1: number, y: number) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, yy = y - Math.sin(t * Math.PI) * 0.5;
      const along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const w = 0.35 + (i % 3) * 0.15, hh = 0.5 + (i % 2) * 0.35;
      const m = i % 3 === 1 ? 'clothBlue' : i % 4 === 3 ? 'awnRed' : 'cloth';
      if (along) this.box(m, x - w, yy - hh, z - 0.01, x + w, yy, z + 0.01);
      else this.box(m, x - 0.01, yy - hh, z - w, x + 0.01, yy, z + w);
    }
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    this.b.obox('rope', [mx, y - 0.25, mz], [0.02, 0.02, Math.hypot(x1 - x0, z1 - z0)], new THREE.Euler(0, Math.atan2(x1 - x0, z1 - z0), 0));
  }
  private planter(x: number, y: number, z: number, w: number, d: number) {
    this.box('sandstone', x - w / 2, y - 0.3, z - d / 2, x + w / 2, y + 0.55, z + d / 2, 'rock');
    this.box('sandstoneDk', x - w / 2 - 0.08, y + 0.55, z - d / 2 - 0.08, x + w / 2 + 0.08, y + 0.65, z + d / 2 + 0.08);
    this.box('sod', x - w / 2 + 0.1, y + 0.5, z - d / 2 + 0.1, x + w / 2 - 0.1, y + 0.58, z + d / 2 - 0.1);
  }
  private fountain(x: number, y: number, z: number) {
    this.b.cyl('sandstone', x, y - 0.2, z, 2.6, 0.62, 20, 'rock');
    const rim = new THREE.TorusGeometry(2.55, 0.17, 6, 28);
    rim.rotateX(Math.PI / 2);
    rim.translate(x, y + 0.62, z);
    this.b.addGeo('sandstoneDk', rim);
    const g = new THREE.CylinderGeometry(2.45, 2.45, 0.02, 24);
    g.translate(x, y + 0.6, z);
    this.b.addGeo('water2', g);
    this.b.cyl('sandstone', x, y + 0.4, z, 0.45, 1.6, 10);
    this.b.cyl('sandstoneDk', x, y + 2.0, z, 1.0, 0.2, 14);
    this.b.cyl('gold', x, y + 2.2, z, 0.15, 0.9, 8);
    this.box(null, x - 0.5, y, z - 0.5, x + 0.5, y + 2.2, z + 0.5, 'rock');
  }

  private dressing() {
    const T = LV.T;
    // ---- T spawn: a fountain, benches, planters, a ticket kiosk, a ferry at the berth ----
    this.fountain(-4, T, 58);
    for (const [x, z] of [[-35, 67], [35, 67]]) this.planter(x, T, z, 10, 6);
    for (const x of [-20, 14, 28]) {
      this.box('tarWood', x - 1, T + 0.45, 70, x + 1, T + 0.52, 70.5, 'wood');
      this.box('iron', x - 0.9, T, 70.1, x - 0.8, T + 0.45, 70.4);
      this.box('iron', x + 0.8, T, 70.1, x + 0.9, T + 0.45, 70.4);
    }
    this.box('ochre', 52, T, 60, 56, T + 2.8, 64, 'wood');
    this.box('roofRed', 51.6, T + 2.8, 59.6, 56.4, T + 3.1, 64.4);
    this.box('jglassLit', 51.98, T + 1.1, 61, 52.0, T + 2.2, 63);
    this.ferry(84, 66);
    this.cart(-48, T, 52, 0.4);
    this.crates(60, T, 50, 2, 0.2);
    this.crates(61.2, T, 50.4, 1, -0.3);
    // ---- A lane: carts, barrels, a festoon of lights, laundry from the upper windows ----
    this.cart(-60.5, T, 30, Math.PI / 2 + 0.1);
    this.barrel(-63.2, T, 12);
    this.barrel(-63.2, T, 12.9);
    this.crates(-51.3, T, -4, 2, 0.1);
    this.crates(-62.7, T, -8, 1, 0.3);
    for (const z of [4, 20, 36]) this.festoon(-64, z, -50, z + 2, T + 6.4);
    // ---- the A courtyard: the site's cover ----
    const A = LV.A;
    this.crateBlock(-48, A, -42, 0, true); // "default" box
    this.crateBlock(-38, A, -32, 0.25, false);
    this.crates(-56, A, -30, 2, 0.1);
    this.crates(-55, A, -31.2, 1, -0.2);
    this.cart(-34, A, -48, 0.6);
    this.well(-58, A, -48);
    this.crates(-27, A, -26, 1, 0.3);
    this.crates(-27.5, A, -24.8, 2, -0.1);
    for (const [x, z] of [[-64, -40], [-28, -40]]) this.planter(x, A, z, 4, 8);
    this.b.cyl('iron', -46, A, -54, 0.06, 9, 6);
    this.flag(-46, A + 8.7, -54, 2.2);
    // ---- mid: low cover, awnings, festoons, a hay cart by the connector ----
    this.cart(-4, T, 4, 0.15);
    this.crates(5.6, T, -8, 1, 0.1);
    this.crates(-5.6, T, 18, 2, -0.2);
    this.crates(5.5, T, 22, 1, 0.3);
    for (const z of [-28, -12, 6, 20]) this.festoon(-7, z, 7, z - 1.5, T + 6.2);
    this.barrel(-6.2, T, -20);
    // top mid: market stalls round the square
    this.stall(-9, T, 32, Math.PI / 2, 'awnRed', 'fruit');
    this.stall(-9, T, 39, Math.PI / 2, 'awnGreen', 'flowers');
    this.stall(9, T, 30, -Math.PI / 2, 'awnBlue', 'fish');
    this.stall(2, T, 43.5, Math.PI, 'awnOchre', 'fruit');
    // the connector: narrow, laundry overhead, barrels
    this.laundry(-24, -16, -24, -11, T + 5.5);
    this.laundry(-14, -16, -14, -11, T + 5.0);
    this.barrel(-8.3, T, -15.3);
    this.crates(-22, T, -12, 1, 0.2);
    // ---- B short and the B lane: fish market stalls, crates, nets ----
    this.stall(52, T, 20, -Math.PI / 2, 'awnBlue', 'fish');
    this.stall(52, T, 30, -Math.PI / 2, 'awnRed', 'fish');
    this.crates(62.6, T, 38, 2, 0.15);
    this.crates(62.6, T, 12, 1, -0.1);
    this.barrel(51, T, 40);
    for (const z of [16, 34]) this.festoon(50, z, 64, z + 1.5, T + 6.0);
    this.crates(10, bShortY(10), -22.6, 1, 0.2);
    this.barrel(25, bShortY(25), -13);
    // ---- B site: the quay ----
    const By = LV.B;
    this.crateBlock(46, By, -34, 0.0, true);
    this.crateBlock(56, By, -26, 0.4, false);
    this.boatOnTrestles(38, By, -44, 0.15);
    this.crates(62, By, -46, 2, 0.0);
    this.crates(63.2, By, -45.6, 1, 0.3);
    for (let i = 0; i < 4; i++) this.barrel(30 + i * 0.95, By, -57.5);
    this.crates(66, By, -40, 1, 0.2);
    this.crates(36, By, -12, 2, -0.1);
    this.davit(70.5, By, -30);
    // fish crates in piles
    for (const [x, z] of [[52, -54], [44, -56], [68, -54]]) this.fishPile(x, By, z);
    // ---- CT: benches, a cart, a lamp post, the flagpole ----
    this.cart(-14, LV.CT, -50, -0.4);
    this.crates(14, LV.CT, -48, 1, 0.2);
    this.lampPost(-10, LV.CT, -60);
    this.lampPost(12, LV.CT, -48);
    this.lampPost(-30, T, 50);
    this.lampPost(40, T, 50);
    this.lampPost(0, T, 72);
  }
  private well(x: number, y: number, z: number) {
    this.b.cyl('sandstone', x, y - 0.2, z, 1.2, 1.1, 16, 'rock');
    this.b.cyl('sandstoneDk', x, y + 0.9, z, 1.3, 0.12, 16);
    this.box('tarWood', x - 1.1, y + 0.9, z - 0.1, x - 0.95, y + 2.6, z + 0.1);
    this.box('tarWood', x + 0.95, y + 0.9, z - 0.1, x + 1.1, y + 2.6, z + 0.1);
    this.box('tarWood', x - 1.2, y + 2.5, z - 0.08, x + 1.2, y + 2.62, z + 0.08);
    this.quad('shingles', [x + 1.4, y + 2.6, z - 0.9], [x + 1.4, y + 3.3, z], [x - 1.4, y + 3.3, z], [x - 1.4, y + 2.6, z - 0.9]);
    this.quad('shingles', [x - 1.4, y + 2.6, z + 0.9], [x - 1.4, y + 3.3, z], [x + 1.4, y + 3.3, z], [x + 1.4, y + 2.6, z + 0.9]);
    this.b.cyl('iron', x, y + 1.6, z, 0.18, 0.3, 8);
  }
  private boatOnTrestles(x: number, y: number, z: number, yaw: number) {
    this.b.push([x, y, z], yaw);
    for (const tx of [-1.6, 1.6]) this.b.box('tarWood', tx - 0.12, 0, -0.9, tx + 0.12, 0.9, 0.9);
    this.b.push([0, 0.9, 0], 0);
    const hull: [number, number][] = [[-3.0, 0.9], [-2.6, 0.15], [-1.0, -0.15], [1.4, -0.15], [2.8, 0.25], [3.2, 1.0]];
    this.slab('boatWhite', hull, -0.85, 1.7);
    this.b.box('red', -2.9, 0.75, -0.87, 3.1, 0.92, -0.83);
    this.b.box('red', -2.9, 0.75, 0.83, 3.1, 0.92, 0.87);
    this.b.pop();
    this.b.box(null, -3.0, 0, -0.9, 3.2, 1.9, 0.9, 'wood');
    this.b.pop();
  }
  private davit(x: number, y: number, z: number) {
    this.b.cyl('yellowSteel', x, y, z, 0.15, 4.2, 10, 'metal');
    this.box('yellowSteel', x - 0.1, y + 4.0, z - 0.1, x + 2.6, y + 4.25, z + 0.1);
    this.box('rope', x + 2.45, y + 1.8, z - 0.02, x + 2.49, y + 4.0, z + 0.02);
    this.box('yellowSteel', x + 2.3, y + 1.6, z - 0.15, x + 2.65, y + 1.8, z + 0.15);
  }
  private fishPile(x: number, y: number, z: number) {
    for (let p = 0; p < 4; p++) {
      const px = x + (p % 2) * 0.85, pz = z + Math.floor(p / 2) * 0.62;
      const hgt = 1 + ((p * 7 + Math.floor(x)) % 4);
      const mat = p % 3 ? 'fishCrate' : 'fishCrateRed';
      for (let k = 0; k < hgt; k++) this.box(mat, px - 0.4, y + k * 0.31, pz - 0.27, px + 0.4, y + k * 0.31 + 0.3, pz + 0.27);
      this.box(null, px - 0.4, y, pz - 0.27, px + 0.4, y + hgt * 0.31, pz + 0.27, 'wood');
    }
  }
  /** the fjord ferry at the berth beside the spawn (backdrop) */
  private ferry(x: number, z: number) {
    this.b.push([x, 0, z], 0);
    this.box('white', -5.5, -1, -16, 5.5, 2.8, 16);
    this.box('red', -5.55, -1, -16, 5.55, 0.6, 16);
    this.box('white', -4.2, 2.8, -9, 4.2, 6.2, 9);
    this.box('jglass', -4.25, 4.4, -8.5, 4.25, 5.6, 8.5);
    this.box('white', -2.6, 6.2, -3, 2.6, 8.4, 3);
    this.box('jglass', -2.65, 7.2, -2.8, 2.65, 8.0, 2.8);
    this.b.cyl('red', 0, 8.4, 1.5, 0.9, 2.8, 12);
    this.b.cyl('iron', 0, 11.2, 1.5, 0.92, 0.4, 12);
    this.box('iron', -5.3, 2.8, -16, 5.3, 3.8, -15.8);
    this.b.pop();
  }

  // ================================================================ trees
  private trees() {
    const T = Vegetation.extraTrees;
    T.length = 0;
    const add = (x: number, z: number, s: number, kind: 'birch' | 'pine' = 'birch') => T.push({ x, z, s, kind });
    // churchyard birches, fortress planters, the station square
    add(9.5, -43, 1.1); add(18, -27, 0.95); add(9.4, -27.5, 0.85);
    add(-64, -38, 0.9); add(-28, -42, 0.95);
    add(-35, 67, 1.05); add(-32, 66, 0.8); add(35, 67, 1.0); add(38, 68.5, 0.85);
  }

  // ================================================================ nav help
  private navLinks() {
    const L = (a: V3, c: V3) => this.bld.link(a[0], a[1], a[2], c[0], c[1], c[2]);
    // the rampart platform's stairs
    const py = LV.A + 1.8;
    L([-69, LV.A, -63.5], [-60.5, py, -63.2]);
    L([-60.5, py, -63.2], [-49, py, -62.6]);
    L([-49, py, -62.6], [-37.5, py, -63.2]);
    L([-37.5, py, -63.2], [-29, LV.A, -63.5]);
    // the promenade stairs
    L([68.5, LV.T, 54], [68.5, (LV.T + LV.DECK) / 2, 43]);
    L([68.5, (LV.T + LV.DECK) / 2, 43], [68.5, LV.DECK, 32]);
    L([68.5, LV.DECK, 32], [68.5, LV.DECK, 14]);
    L([68.5, LV.DECK, 14], [68.5, LV.DECK, -4]);
    L([68.5, LV.DECK, -4], [68.5, (LV.DECK + LV.B) / 2, -12]);
    L([68.5, (LV.DECK + LV.B) / 2, -12], [68.5, LV.B, -20]);
  }

  // ================================================================ per frame
  update(t: number, cam?: THREE.Vector3) {
    void cam;
    // pennants flutter in the evening breeze
    for (const m of this.flagMeshes) {
      const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        p.setZ(i, Math.sin(t * 6 + x * 2.4) * 0.12 * x);
      }
      p.needsUpdate = true;
    }
  }
}
