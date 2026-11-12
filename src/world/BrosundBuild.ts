import * as THREE from 'three';
import type { GeoBuilder } from './GeoBuilder';
import type { Buildings } from './Buildings';
import type { Terrain } from './Terrain';
import type { Infrastructure } from './Infrastructure';
import { ROADS, roadHeightAt } from './MapLayout';
import { RNG, smoothstep } from '../core/math';
import { brosundSignMaterials } from './Signs';
import {
  canalZ, CANAL_HW, QUAY_Y, CANAL_BRIDGES, FOOTBRIDGES, soundX, soundHW, tunnelPath, TUN, TUN_FEATURES, TunPt, LAKE,
} from './maps/Brosund';

/**
 * Brosund's hand-made structures (Update 34): the canal quays and bridges, the Aksla stairs,
 * Sundtunnelen under the sound (portals, lay-by, niches, pump room, lights, drips) after the
 * reference photos, the cable-stayed Sundbrua, the breakwater, the glacial lake surface and the
 * street furniture. Waterfalls, ziplines and the cable car are built by their own systems.
 */
export class BrosundBuild {
  /** ceiling drip points in the tunnel (Game spawns drips and plinks near the camera) */
  drips: THREE.Vector3[] = [];
  /** points along the tunnel for its acoustics / ambience emitters */
  tunnelAudio: THREE.Vector3[] = [];
  lake: THREE.Mesh | null = null;
  private rng = new RNG(3434);

  constructor(private I: Infrastructure, private b: GeoBuilder, private bld: Buildings, private terrain: Terrain, private parent: THREE.Object3D, mats: Record<string, THREE.Material>) {
    Object.assign(b.mats, brosundSignMaterials());
    void mats;
    this.quays();
    this.canalBridges();
    this.stairs();
    this.tunnel();
    this.portals();
    this.sundbrua();
    this.breakwater();
    this.lakeSurface();
    this.street();
    this.cover();
    this.crossStreetNav();
  }

  private h(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }

  // ------------------------------------------------------------------ quays
  /**
   * Granite quay walls wherever the ground steps from the quay top straight down into the water,
   * traced along the canal banks and the two harbour fronts. Bollards, ladders and mooring rings.
   */
  private quays() {
    const b = this.b;
    const lines: { pts: [number, number][]; water: number }[] = [];
    // canal: north bank (water to +z) and south bank (water to −z)
    for (const side of [-1, 1]) {
      const pts: [number, number][] = [];
      for (let x = -192; x <= 46; x += 2.5) pts.push([x, canalZ(x) + side * CANAL_HW]);
      lines.push({ pts, water: -side });
    }
    // the town front on the sound (water to +x) and Ellingsøya's harbour (water to −x)
    {
      const w: [number, number][] = [], e: [number, number][] = [];
      for (let z = -64; z <= 84; z += 2.5) {
        w.push([soundX(z) - soundHW(z), z]);
        e.push([soundX(z) + soundHW(z), z]);
      }
      lines.push({ pts: w, water: 2 });
      lines.push({ pts: e, water: -2 });
    }
    let bollard = 0;
    for (const L of lines) {
      for (let i = 0; i < L.pts.length - 1; i++) {
        const [ax, az] = L.pts[i], [bx, bz] = L.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const tx = (bx - ax) / len, tz = (bz - az) / len;
        // water side normal
        let nx = -tz, nz = tx;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const sgn = Math.abs(L.water) === 1 ? (nz * L.water > 0 ? 1 : -1) : nx * Math.sign(L.water) > 0 ? 1 : -1;
        nx *= sgn;
        nz *= sgn;
        const land = this.h(mx - nx * 1.8, mz - nz * 1.8), sea = this.h(mx + nx * 1.8, mz + nz * 1.8);
        if (land < QUAY_Y - 0.6 || land > QUAY_Y + 0.7 || sea > -1.5) continue;
        const rot = Math.atan2(tx, tz) - Math.PI / 2;
        // wall: water face exactly on the line, 1 m thick into the land, from the bed up to the quay top
        b.obox('granite', [mx - nx * 0.5, (QUAY_Y - 4.8) / 2, mz - nz * 0.5], [len + 0.08, QUAY_Y + 4.8, 1.0], new THREE.Euler(0, rot, 0), 'rock');
        // coping stones (lighter, a lip over the water)
        b.obox('stucco', [mx - nx * 0.25, QUAY_Y + 0.06, mz - nz * 0.25], [len + 0.08, 0.16, 0.7], new THREE.Euler(0, rot, 0), 'concrete');
        bollard += len;
        if (bollard > 9) {
          bollard = 0;
          const px = mx - nx * 0.45, pz = mz - nz * 0.45;
          b.cyl('iron', px, QUAY_Y + 0.12, pz, 0.16, 0.5, 10, 'metal', 0.13);
          const cap = new THREE.SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
          b.addGeo('iron', cap, new THREE.Matrix4().setPosition(px, QUAY_Y + 0.62, pz));
          if (this.rng.chance(0.25)) {
            // a ladder down to the water
            b.push([mx + nx * 0.02, 0, mz + nz * 0.02], Math.atan2(nx, nz));
            for (const sx of [-1, 1]) b.box('iron', sx * 0.22 - 0.02, -2.5, 0, sx * 0.22 + 0.02, QUAY_Y + 0.9, 0.04);
            for (let y = -2.2; y < QUAY_Y; y += 0.3) b.box('iron', -0.22, y, 0.0, 0.22, y + 0.03, 0.03);
            b.pop();
          }
        }
      }
    }
    // boats moored along the canal: sailing boats with masts, small fishing boats, a white motor launch
    const rng = this.rng;
    for (let x = -176; x < 30; x += rng.range(9, 16)) {
      if (CANAL_BRIDGES.some((c) => Math.abs(c.x - x) < 9) || FOOTBRIDGES.some((c) => Math.abs(c.x - x) < 6)) continue;
      const side = rng.chance(0.5) ? -1 : 1;
      const z = canalZ(x) + side * (CANAL_HW - 1.6);
      const rot = Math.atan2(1, (canalZ(x + 1) - canalZ(x - 1)) / 2) + Math.PI / 2;
      const kind = rng.int(0, 2);
      if (kind === 0) {
        this.bld.boat(x, -0.25, z, rot, 1.5, false, 'white');
        // mast + boom
        const y = 0.6;
        b.cyl('woodRaw', x, y, z, 0.07, 9, 8, null, 0.05);
        b.push([x, y + 1.6, z], rot);
        b.box('woodRaw', -3.0, -0.05, -0.05, 0, 0.05, 0.05);
        b.pop();
      } else if (kind === 1) this.bld.boat(x, -0.25, z, rot, 1.2, true, rng.chance(0.5) ? 'red' : 'white');
      else this.bld.boat(x, -0.3, z, rot, 1.0, false, 'red');
    }
    // fishing boats in Ellingsøya's harbour
    for (const [z, cab, col] of [[-30, true, 'red'], [-6, true, 'white'], [30, false, 'red'], [58, true, 'white']] as const) {
      const x = soundX(z) + soundHW(z) - 3.2;
      this.bld.boat(x, -0.3, z, 0, 2.6, cab, col);
    }
  }

  // ------------------------------------------------------------------ canal bridges
  private canalBridges() {
    const b = this.b;
    for (const br of CANAL_BRIDGES) {
      const x = br.x, w = br.w;
      const zc = canalZ(x);
      const z0 = zc - CANAL_HW - 1.6, z1 = zc + CANAL_HW + 1.6;
      const yA = this.h(x, z0 - 0.6), yB = this.h(x, z1 + 0.6);
      const yAt = (z: number) => {
        const t = (z - z0) / (z1 - z0);
        return yA + (yB - yA) * t + Math.sin(t * Math.PI) * 1.05;
      };
      const N = 10;
      for (let i = 0; i < N; i++) {
        const za = z0 + ((z1 - z0) * i) / N, zb = z0 + ((z1 - z0) * (i + 1)) / N;
        const ya = yAt(za), yb = yAt(zb);
        const ang = Math.atan2(yb - ya, zb - za);
        const len = Math.hypot(zb - za, yb - ya);
        b.obox(br.stone ? 'asphalt' : 'planks', [x, (ya + yb) / 2 - 0.08, (za + zb) / 2], [w, 0.16, len + 0.04], new THREE.Euler(-ang, 0, 0), 'concrete');
        // parapets / railings
        for (const sx of [-1, 1]) {
          if (br.stone) b.obox('granite', [x + sx * (w / 2 + 0.2), (ya + yb) / 2 + 0.45, (za + zb) / 2], [0.4, 1.0, len + 0.04], new THREE.Euler(-ang, 0, 0), 'rock');
          else {
            b.obox('iron', [x + sx * (w / 2 + 0.05), (ya + yb) / 2 + 1.0, (za + zb) / 2], [0.06, 0.06, len + 0.04], new THREE.Euler(-ang, 0, 0));
            b.obox(null, [x + sx * (w / 2 + 0.05), (ya + yb) / 2 + 0.55, (za + zb) / 2], [0.1, 1.0, len + 0.04], new THREE.Euler(-ang, 0, 0), 'metal');
            for (let k = 0; k < 6; k++) {
              const zz = za + ((zb - za) * k) / 6, yy = yAt(zz);
              b.box('iron', x + sx * (w / 2 + 0.05) - 0.015, yy, zz - 0.015, x + sx * (w / 2 + 0.05) + 0.015, yy + 1.0, zz + 0.015);
            }
          }
        }
      }
      if (br.stone) {
        // the stone arch: side elevations extruded across the width
        const s = new THREE.Shape();
        s.moveTo(z0 - 1, -4.4);
        s.lineTo(z0 - 1, yAt(z0) - 0.16);
        for (let i = 1; i <= 16; i++) {
          const z = z0 + ((z1 - z0) * i) / 16;
          s.lineTo(z, yAt(z) - 0.16);
        }
        s.lineTo(z1 + 1, -4.4);
        s.lineTo(zc + CANAL_HW - 0.2, -4.4);
        // arch opening
        for (let i = 0; i <= 16; i++) {
          const a = (i / 16) * Math.PI;
          s.lineTo(zc + Math.cos(a) * (CANAL_HW - 0.2), 0.0 + Math.sin(a) * 2.0);
        }
        s.lineTo(zc - CANAL_HW + 0.2, -4.4);
        s.closePath();
        const g = new THREE.ExtrudeGeometry(s, { depth: w + 0.8, bevelEnabled: false });
        g.rotateY(Math.PI / 2);
        g.translate(x - (w + 0.8) / 2, 0, 0);
        b.addGeo('granite', g);
        // voussoir ring + keystones on both faces
        for (const sx of [-1, 1]) {
          for (let i = 0; i < 14; i++) {
            const a = ((i + 0.5) / 14) * Math.PI;
            b.obox('stucco', [x + sx * (w / 2 + 0.42), Math.sin(a) * 2.25, zc + Math.cos(a) * (CANAL_HW + 0.05)], [0.08, 0.5, 1.2], new THREE.Euler(a - Math.PI / 2, 0, 0));
          }
        }
        // ornamental lamps on the parapet ends
        for (const sx of [-1, 1]) for (const z of [z0 + 0.4, z1 - 0.4]) this.jugendLamp(x + sx * (w / 2 + 0.2), z, yAt(z) + 0.95);
      } else {
        // steel girders and a lattice under the deck, abutments
        for (const sx of [-1, 1]) {
          for (let i = 0; i < 10; i++) {
            const za = z0 + ((z1 - z0) * i) / 10, zb = z0 + ((z1 - z0) * (i + 1)) / 10;
            const ya = yAt(za), yb = yAt(zb);
            b.obox('iron', [x + sx * (w / 2 - 0.4), (ya + yb) / 2 - 0.6, (za + zb) / 2], [0.3, 0.9, Math.hypot(zb - za, yb - ya) + 0.02], new THREE.Euler(-Math.atan2(yb - ya, zb - za), 0, 0));
          }
        }
        for (const z of [z0 + 1.2, z1 - 1.2]) b.box('granite', x - w / 2 - 0.6, -4.4, z - 1.2, x + w / 2 + 0.6, yAt(z) - 0.9, z + 1.2, 'rock');
        for (const sx of [-1, 1]) for (const z of [z0 + 0.3, zc, z1 - 0.3]) this.jugendLamp(x + sx * (w / 2 + 0.05), z, yAt(z));
      }
      this.bld.nav.push({ a: new THREE.Vector3(x, yA + 0.1, z0 - 3), b: new THREE.Vector3(x, yAt(zc) + 0.1, zc) });
      this.bld.nav.push({ a: new THREE.Vector3(x, yAt(zc) + 0.1, zc), b: new THREE.Vector3(x, yB + 0.1, z1 + 3) });
    }
    // light steel footbridges
    for (const fb of FOOTBRIDGES) {
      const x = fb.x, w = fb.w, zc = canalZ(x);
      const z0 = zc - CANAL_HW - 0.8, z1 = zc + CANAL_HW + 0.8;
      const yA = QUAY_Y + 0.05;
      const yAt = (z: number) => yA + Math.sin(((z - z0) / (z1 - z0)) * Math.PI) * 1.5;
      for (let i = 0; i < 12; i++) {
        const za = z0 + ((z1 - z0) * i) / 12, zb = z0 + ((z1 - z0) * (i + 1)) / 12;
        const ya = yAt(za), yb = yAt(zb);
        const ang = Math.atan2(yb - ya, zb - za), len = Math.hypot(zb - za, yb - ya);
        b.obox('planks', [x, (ya + yb) / 2 - 0.06, (za + zb) / 2], [w, 0.12, len + 0.03], new THREE.Euler(-ang, 0, 0), 'wood');
        b.obox('steel', [x, (ya + yb) / 2 - 0.3, (za + zb) / 2], [w * 0.6, 0.35, len + 0.03], new THREE.Euler(-ang, 0, 0));
        for (const sx of [-1, 1]) {
          b.obox('steel', [x + sx * w / 2, (ya + yb) / 2 + 1.0, (za + zb) / 2], [0.05, 0.05, len + 0.03], new THREE.Euler(-ang, 0, 0));
          b.obox(null, [x + sx * w / 2, (ya + yb) / 2 + 0.55, (za + zb) / 2], [0.08, 1.0, len + 0.03], new THREE.Euler(-ang, 0, 0), 'metal');
          b.box('steel', x + sx * w / 2 - 0.02, ya, za - 0.02, x + sx * w / 2 + 0.02, ya + 1.0, za + 0.02);
        }
      }
      this.bld.nav.push({ a: new THREE.Vector3(x, yA + 0.1, z0 - 2.5), b: new THREE.Vector3(x, yAt(zc) + 0.1, zc) });
      this.bld.nav.push({ a: new THREE.Vector3(x, yAt(zc) + 0.1, zc), b: new THREE.Vector3(x, yA + 0.1, z1 + 2.5) });
    }
  }

  /** A Jugend cast-iron street lamp: fluted post, scroll arm, a lantern. */
  jugendLamp(x: number, z: number, y?: number) {
    const b = this.b;
    const gy = y ?? this.h(x, z);
    b.cyl('iron', x, gy, z, 0.11, 0.5, 10, 'metal', 0.16);
    b.cyl('iron', x, gy + 0.5, z, 0.06, 3.4, 8, 'metal', 0.075);
    b.cyl('iron', x, gy + 3.9, z, 0.18, 0.08, 10);
    b.cyl('jglassLit', x, gy + 3.98, z, 0.17, 0.5, 6, null, 0.12);
    const cap = new THREE.ConeGeometry(0.24, 0.3, 6);
    b.addGeo('iron', cap, new THREE.Matrix4().setPosition(x, gy + 4.62, z));
    b.box('lamp', x - 0.06, gy + 4.05, z - 0.06, x + 0.06, gy + 4.35, z + 0.06);
    this.I.lampAnchors.push(new THREE.Vector3(x, gy + 4.2, z));
    this.I.lampHeads.push({ m: new THREE.Matrix4(), min: new THREE.Vector3(x - 0.17, gy + 3.98, z - 0.17), max: new THREE.Vector3(x + 0.17, gy + 4.48, z + 0.17) });
  }

  // ------------------------------------------------------------------ Aksla stairs
  private stairs() {
    const b = this.b;
    const r = ROADS.find((q) => q.kind === 'stairs');
    if (!r) return;
    const s = this.I.resample(r.pts, 0.34);
    const W = r.width / 2;
    const yOf = (i: number) => {
      // height along the stair line from the road profile
      const p = s[i];
      let seg = 0, t = 0;
      let acc = 0;
      for (let k = 0; k < r.pts.length - 1; k++) {
        const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (p.s <= acc + L + 1e-6) {
          seg = k;
          t = (p.s - acc) / L;
          break;
        }
        acc += L;
        seg = k;
        t = 1;
      }
      return roadHeightAt(r, seg, Math.min(1, Math.max(0, t)));
    };
    const ys = s.map((_, i) => yOf(i));
    let last = ys[0];
    for (let i = 0; i < s.length - 1; i++) {
      const p = s[i], q = s[i + 1];
      // quantised treads: each riser ≤ 0.19 m
      let y = ys[i];
      if (Math.abs(y - last) < 0.06) y = last;
      last = y;
      const rot = Math.atan2(p.tx, p.tz);
      b.push([(p.x + q.x) / 2, 0, (p.z + q.z) / 2], rot);
      const g = Math.min(this.h(p.x - p.tz * W, p.z + p.tx * W), this.h(p.x + p.tz * W, p.z - p.tx * W), y) - 0.8;
      b.box('granite', -W, g, -0.18, W, y, 0.18);
      // low retaining walls on both sides
      for (const sx of [-1, 1]) b.box('stone', sx * (W + 0.2) - 0.2, g, -0.19, sx * (W + 0.2) + 0.2, y + 0.45, 0.19);
      b.pop();
    }
    // a smooth ramp collider over the treads, segment by segment; iron handrails
    for (let i = 0; i < s.length - 4; i += 4) {
      const p = s[i], q = s[i + 4];
      const ya = ys[i], yb = ys[i + 4];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const ang = Math.atan2(yb - ya, len);
      const rot = Math.atan2(q.x - p.x, q.z - p.z);
      b.obox(null, [(p.x + q.x) / 2, (ya + yb) / 2 - 0.05, (p.z + q.z) / 2], [W * 2, 0.12, Math.hypot(len, yb - ya) + 0.05], new THREE.Euler(-ang, rot, 0, 'YXZ'), 'rock');
      for (const sx of [-1, 1]) {
        const ox = -p.tz * (W + 0.2) * sx, oz = p.tx * (W + 0.2) * sx;
        b.obox('iron', [(p.x + q.x) / 2 + ox, (ya + yb) / 2 + 1.35, (p.z + q.z) / 2 + oz], [0.05, 0.05, Math.hypot(len, yb - ya)], new THREE.Euler(-ang, rot, 0, 'YXZ'));
        b.box('iron', p.x + ox - 0.02, ya + 0.45, p.z + oz - 0.02, p.x + ox + 0.02, ya + 1.35, p.z + oz + 0.02);
      }
      if (i % 40 === 0) this.bld.nav.push({ a: new THREE.Vector3(p.x, ya + 0.1, p.z), b: new THREE.Vector3(s[Math.min(s.length - 1, i + 40)].x, ys[Math.min(s.length - 1, i + 40)] + 0.1, s[Math.min(s.length - 1, i + 40)].z) });
    }
    // little lamps every ~20 m up the stairs
    for (let i = 20; i < s.length; i += 60) {
      const p = s[i];
      this.jugendLamp(p.x - p.tz * (W + 0.6), p.z + p.tx * (W + 0.6), ys[i] + 0.4);
    }
  }

  // ------------------------------------------------------------------ Sundtunnelen
  /**
   * The bore: rough grey shotcrete walls and arch, a two-lane road with a yellow centre line and
   * white edge lines, raised walkways, fluorescent light strips off-centre in the crown, a
   * turnaround lay-by with yellow chevron hatching and the "Snu og køyr ut" board under a red
   * light, SOS / extinguisher niches, a pump room at the low point and blue light in the lay-by.
   */
  private tunnel() {
    const b = this.b;
    const P = tunnelPath();
    const lay = TUN_FEATURES.layby;
    const hw = TUN.hw, WALL = TUN.wall, ARCH = TUN.crown - TUN.wall;
    // half-widths on each side along the path (the lay-by bay widens one side with tapers)
    const widen = (s: number) => smoothstep(lay.s0 - 6, lay.s0, s) * (1 - smoothstep(lay.s1, lay.s1 + 6, s)) * lay.width;
    const sideW = (s: number, side: number) => hw + (side === lay.side ? widen(s) : 0);
    const STEP = 2;
    const idx: number[] = [];
    for (let i = 0; i < P.length; i += STEP) idx.push(i);
    if (idx[idx.length - 1] !== P.length - 1) idx.push(P.length - 1);
    // cross-section ring (u lateral, v up) for station s
    const ring = (s: number): [number, number][] => {
      const L = sideW(s, -1), R = sideW(s, 1);
      const out: [number, number][] = [[-L, 0.18], [-L, WALL]];
      const cx = (R - L) / 2, a = (R + L) / 2;
      for (let k = 1; k < 12; k++) {
        const t = Math.PI - (k / 12) * Math.PI;
        out.push([cx + Math.cos(t) * a, WALL + Math.sin(t) * ARCH]);
      }
      out.push([R, WALL], [R, 0.18]);
      return out;
    };
    const world = (p: TunPt, u: number, v: number) => new THREE.Vector3(p.x - p.tz * u, p.y + v, p.z + p.tx * u);
    // shell (walls + arch), road, walkways
    const shell: number[] = [], shellUv: number[] = [];
    const road: number[] = [], roadUv: number[] = [];
    const walk: number[] = [], walkUv: number[] = [];
    const quad = (arr: number[], uv: number[], a: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, e: THREE.Vector3, u0: number, u1: number, s0: number, s1: number) => {
      arr.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, c.x, c.y, c.z, e.x, e.y, e.z, d.x, d.y, d.z);
      uv.push(u0, s0, u1, s0, u0, s1, u1, s0, u1, s1, u0, s1);
    };
    for (let k = 0; k < idx.length - 1; k++) {
      const p = P[idx[k]], q = P[idx[k + 1]];
      const ra = ring(p.s), rb = ring(q.s);
      let ua = 0;
      for (let j = 0; j < ra.length - 1; j++) {
        const seg = Math.hypot(ra[j + 1][0] - ra[j][0], ra[j + 1][1] - ra[j][1]);
        // inward-facing: order so the normal points to the axis
        quad(shell, shellUv, world(p, ra[j + 1][0], ra[j + 1][1]), world(p, ra[j][0], ra[j][1]), world(q, rb[j + 1][0], rb[j + 1][1]), world(q, rb[j][0], rb[j][1]), ua + seg, ua, p.s, q.s);
        ua += seg;
      }
      // road surface (between the kerbs) and walkways
      const La = sideW(p.s, -1), Ra = sideW(p.s, 1), Lb = sideW(q.s, -1), Rb = sideW(q.s, 1);
      const kerb = 1.35;
      quad(road, roadUv, world(p, -(La - kerb), 0), world(p, Ra - kerb, 0), world(q, -(Lb - kerb), 0), world(q, Rb - kerb, 0), 0, La + Ra - 2 * kerb, p.s, q.s);
      for (const [u0a, u1a, u0b, u1b] of [[-La, -(La - kerb), -Lb, -(Lb - kerb)], [Ra - kerb, Ra, Rb - kerb, Rb]]) {
        quad(walk, walkUv, world(p, u0a, 0.18), world(p, u1a, 0.18), world(q, u0b, 0.18), world(q, u1b, 0.18), 0, kerb, p.s, q.s);
        // kerb face
        const inner = u0a < 0 ? u1a : u0a, innerB = u0b < 0 ? u1b : u0b;
        if (u0a < 0) quad(walk, walkUv, world(p, inner, 0.18), world(p, inner, 0), world(q, innerB, 0.18), world(q, innerB, 0), 0, 0.18, p.s, q.s);
        else quad(walk, walkUv, world(p, inner, 0), world(p, inner, 0.18), world(q, innerB, 0), world(q, innerB, 0.18), 0, 0.18, p.s, q.s);
      }
      // colliders per segment: walls, crown, floor slab
      const mid = P[Math.round((idx[k] + idx[k + 1]) / 2)];
      const len = Math.hypot(q.x - p.x, q.z - p.z) + 0.1;
      const grade = Math.atan2(q.y - p.y, len);
      const rot = Math.atan2(mid.tx, mid.tz);
      const e = (u: number, v: number) => [mid.x - mid.tz * u, mid.y + v, mid.z + mid.tx * u] as [number, number, number];
      const Lm = sideW(mid.s, -1), Rm = sideW(mid.s, 1);
      b.obox(null, e(-Lm - 0.5, 3.0), [1.0, 6.0, len], new THREE.Euler(-grade, rot, 0, 'YXZ'), 'rock');
      b.obox(null, e(Rm + 0.5, 3.0), [1.0, 6.0, len], new THREE.Euler(-grade, rot, 0, 'YXZ'), 'rock');
      b.obox(null, e((Rm - Lm) / 2, TUN.crown + 0.3), [Lm + Rm, 0.6, len], new THREE.Euler(-grade, rot, 0, 'YXZ'), 'rock');
      b.obox(null, e((Rm - Lm) / 2, -0.25), [Lm + Rm, 0.5, len], new THREE.Euler(-grade, rot, 0, 'YXZ'), 'concrete');
      for (const sx of [-1, 1]) b.obox(null, e(sx * ((sx < 0 ? Lm : Rm) - 0.68), 0.09), [1.36, 0.18, len], new THREE.Euler(-grade, rot, 0, 'YXZ'), 'concrete');
    }
    const add = (mat: string, pos: number[], uv: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      b.addGeo(mat, g);
    };
    add('shotcrete', shell, shellUv);
    add('asphalt', road, roadUv);
    add('concrete', walk, walkUv);
    // ---- markings: yellow centre line (solid + dashed), white edge lines, chevrons at the lay-by
    const strip = (mat: string, u0: number, u1: number, dash?: [number, number], from = 0, to = 1e9) => {
      const pos: number[] = [], uv: number[] = [];
      for (let i = 0; i < P.length - 1; i++) {
        const p = P[i], q = P[i + 1];
        if (p.s < from || p.s > to) continue;
        if (dash && p.s % (dash[0] + dash[1]) > dash[0]) continue;
        quad(pos, uv, world(p, u0, 0.02), world(p, u1, 0.02), world(q, u0, 0.02), world(q, u1, 0.02), 0, u1 - u0, p.s, q.s);
      }
      add(mat, pos, uv);
    };
    strip('lineYellow', -0.2, -0.08);
    strip('lineYellow', 0.08, 0.2, [3, 3]);
    strip('lineWhite', -(hw - 1.35) + 0.1, -(hw - 1.35) + 0.25);
    strip('lineWhite', hw - 1.35 - 0.25, hw - 1.35 - 0.1, [1, 1]);
    // chevron hatching across the lay-by mouth
    for (let s = lay.s0 - 6; s < lay.s0 + 2; s += 1.6) {
      const p = P[Math.round(s)];
      if (!p) continue;
      const q = P[Math.round(s + 1.2)];
      const u0 = lay.side * (hw - 1.4), u1 = lay.side * (hw - 1.4 + widen(s) * 0.9);
      const a = world(p, u0, 0.025), c = world(q, u1, 0.025);
      const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2, my = (a.y + c.y) / 2;
      b.obox('lineYellow', [mx, my, mz], [0.45, 0.01, a.distanceTo(c)], new THREE.Euler(0, Math.atan2(c.x - a.x, c.z - a.z), 0));
    }
    // ---- light fixtures: a line of fluorescent strips right of the crown, every 6 m
    const fix = (s: number, u: number, mat: string) => {
      const p = P[Math.round(s)];
      if (!p) return;
      const a = world(p, u, TUN.crown - 0.5);
      b.push([a.x, a.y, a.z], Math.atan2(p.tx, p.tz));
      b.box('steel', -0.12, 0.0, -0.75, 0.12, 0.1, 0.75);
      b.box(mat, -0.08, -0.03, -0.7, 0.08, 0.0, 0.7);
      b.box('steel', -0.02, 0.1, -0.02, 0.02, 0.55, 0.02);
      b.pop();
    };
    for (let s = 3; s < P[P.length - 1].s - 2; s += 6) fix(s, 1.6, 'bulbCool');
    for (let s = 12; s < P[P.length - 1].s; s += 26) {
      const p = P[Math.round(s)];
      this.I.lights.push({ pos: world(p, 1.2, TUN.crown - 1.2), color: 0xdde8ff, intensity: 9, dist: 20 });
    }
    // ---- the lay-by: blue light strips along the bay, the turn board under a red lamp, SOS sign
    const layMid = P[Math.round((lay.s0 + lay.s1) / 2)];
    for (let s = lay.s0; s <= lay.s1; s += 3) {
      const p = P[Math.round(s)];
      const u = lay.side * (sideW(s, lay.side) - 0.3);
      const a = world(p, u, 2.6);
      b.push([a.x, a.y, a.z], Math.atan2(p.tx, p.tz));
      b.box('blueLight', -0.05, -0.05, -1.2, 0.05, 0.05, 1.2);
      b.pop();
    }
    this.I.lights.push({ pos: world(layMid, lay.side * (hw + lay.width - 1.5), 2.4), color: 0x3a70ff, intensity: 12, dist: 18 });
    {
      const p = P[Math.round(lay.s0 - 10)];
      const a = world(p, 0.6, TUN.crown - 1.4);
      b.push([a.x, a.y, a.z], Math.atan2(-p.tx, -p.tz));
      b.box('steel', -1.3, -0.45, -0.05, 1.3, 0.45, 0.02);
      const g = new THREE.PlaneGeometry(2.5, 0.8);
      b.addGeo('brTurn', g, new THREE.Matrix4().setPosition(0, 0, 0.03));
      for (const sx of [-1, 1]) b.box('steel', sx * 0.9 - 0.02, 0.45, -0.02, sx * 0.9 + 0.02, 1.4, 0.02);
      const lamp = new THREE.SphereGeometry(0.16, 10, 8);
      b.addGeo('redLamp', lamp, new THREE.Matrix4().setPosition(0, 0.75, 0));
      b.pop();
      this.I.lights.push({ pos: a.clone().add(new THREE.Vector3(0, 0.7, 0)), color: 0xff2a1a, intensity: 4, dist: 8 });
    }
    // SOS / extinguisher signs: in the lay-by and the two niches
    const sosAt = (s: number, side: number, niche: boolean) => {
      const p = P[Math.round(s)];
      const u = side * (sideW(s, side) - (niche ? -0.9 : 0.06));
      const a = world(p, u, 2.0);
      b.push([a.x, a.y, a.z], Math.atan2(p.tx, p.tz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
      b.box('steel', -0.6, -0.9, -0.04, 0.6, 0.9, 0.0);
      const g = new THREE.PlaneGeometry(1.1, 1.65);
      b.addGeo('brSOS', g, new THREE.Matrix4().setPosition(0, 0, 0.01));
      b.pop();
      // red extinguisher cabinet under it
      const c = world(p, side * (sideW(s, side) - (niche ? -0.9 : 0.25)), 0.9);
      b.push([c.x, c.y, c.z], Math.atan2(p.tx, p.tz));
      b.box('redSteel', -0.25, -0.5, -0.3, 0.25, 0.5, 0.3, 'metal');
      b.pop();
      this.I.lights.push({ pos: world(p, side * (sideW(s, side) - 1.0), 2.6), color: 0x9ab8ff, intensity: 3, dist: 7 });
    };
    sosAt((lay.s0 + lay.s1) / 2 + 4, lay.side, false);
    for (const n of TUN_FEATURES.niches) {
      // the niche: a recess in the wall with its own little roof
      const p = P[Math.round(n.s)];
      const base = world(p, n.side * (sideW(n.s, n.side) + 0.8), 0);
      b.push([base.x, base.y, base.z], Math.atan2(p.tx, p.tz));
      b.box('shotcrete', -0.9 * n.side - 0.9, 0, -1.5, -0.9 * n.side + 0.9, 0.18, 1.5);
      b.box('shotcrete', -0.9, 2.8, -1.6, 0.9, 3.4, 1.6);
      b.pop();
      sosAt(n.s, n.side, true);
    }
    // ---- the pump room: a steel door at the low point, a chamber with pumps, pipes and a sump
    {
      const pm = TUN_FEATURES.pump;
      const p = P[Math.round(pm.s)];
      const u = pm.side * (hw + 0.25);
      const a = world(p, u, 0.18);
      b.push([a.x, a.y, a.z], Math.atan2(p.tx, p.tz) + (pm.side > 0 ? -Math.PI / 2 : Math.PI / 2));
      // in this frame +z points into the room (away from the road), x along the wall
      b.wall('concrete', -2.5, 2.5, 0, 0.5, 0, 3.0, [{ x: 0, w: 1.2, y0: 0, y1: 2.2 }], 'concrete');
      b.box('hazard', -0.75, 2.25, -0.27, 0.75, 2.45, -0.25);
      b.box('concrete', -3.2, -0.2, 0.25, 3.2, 0.0, 6.5, 'concrete'); // floor
      b.box('shotcrete', -3.2, 3.0, 0.25, 3.2, 3.4, 6.5, 'rock'); // roof
      b.box('shotcrete', -3.6, 0, 0.25, -3.2, 3.0, 6.5, 'rock');
      b.box('shotcrete', 3.2, 0, 0.25, 3.6, 3.0, 6.5, 'rock');
      b.box('shotcrete', -3.2, 0, 6.5, 3.2, 3.0, 6.9, 'rock');
      for (const px of [-1.8, 0, 1.8]) {
        b.cyl('contBlue', px, 0, 4.6, 0.45, 1.2, 14, 'metal');
        b.cyl('steel', px, 1.2, 4.6, 0.12, 1.6, 8);
      }
      b.box('steel', -2.6, 2.75, 4.5, 2.6, 2.95, 4.7);
      b.box('steelGrate', -1.2, 0.0, 1.6, 1.2, 0.02, 3.2);
      b.box('contGrey', 2.4, 0, 1.2, 3.1, 1.8, 2.4, 'metal'); // control cabinet
      b.box('lamp', 2.5, 1.5, 1.18, 2.6, 1.6, 1.2);
      this.bld.fixtures.push({ p: new THREE.Vector3(0, 2.6, 3.4).applyMatrix4(b.m), color: 0xdde8ff, intensity: 4, dist: 8, flicker: 'fluoro' });
      this.pumpPos = new THREE.Vector3(0, 1.2, 4.6).applyMatrix4(b.m);
      b.box('bulbCool', -0.6, 2.95, 3.3, 0.6, 3.0, 3.5);
      this.bld.nav.push({ a: new THREE.Vector3(0, 0.05, -2.2).applyMatrix4(b.m), b: new THREE.Vector3(0, 0.05, 2.5).applyMatrix4(b.m) });
      b.pop();
    }
    // ---- drips (ceiling points) and wet streaks on the walls, puddles along the kerbs
    const rng = this.rng;
    for (let s = 10; s < P[P.length - 1].s - 10; s += rng.range(5, 11)) {
      const p = P[Math.round(s)];
      const u = rng.range(-3.5, 3.5);
      const v = WALL + Math.sqrt(Math.max(0, 1 - Math.pow(u / hw, 2))) * ARCH - 0.05;
      this.drips.push(world(p, u, v));
      if (rng.chance(0.5)) {
        const side = rng.chance(0.5) ? -1 : 1;
        const a = world(p, side * (sideW(s, side) - 0.02), 0.2);
        b.push([a.x, a.y, a.z], Math.atan2(p.tx, p.tz));
        b.box('wetWall', -0.04, 0, -rng.range(0.3, 0.9), 0.04, rng.range(1.6, 4.2), rng.range(0.3, 0.9));
        b.pop();
      }
      if (rng.chance(0.45)) {
        const a = world(p, rng.range(-3, 3), 0.025);
        const g = new THREE.CircleGeometry(rng.range(0.5, 1.4), 12);
        g.rotateX(-Math.PI / 2);
        g.scale(1, 1, rng.range(0.5, 1));
        b.addGeo('puddle', g, new THREE.Matrix4().setPosition(a.x, a.y, a.z));
      }
    }
    for (let s = 0; s < P[P.length - 1].s; s += 30) this.tunnelAudio.push(world(P[Math.round(s)], 0, 2.5));
    // ---- nav: a chain of links down the bore (the nav grid skips everything below sea level)
    for (let s = 0; s < P[P.length - 1].s - 1; s += 8) {
      const p = P[Math.round(s)], q = P[Math.min(P.length - 1, Math.round(s + 8))];
      this.bld.nav.push({ a: new THREE.Vector3(p.x, p.y + 0.05, p.z), b: new THREE.Vector3(q.x, q.y + 0.05, q.z) });
      if (s > 20 && s < P[P.length - 1].s - 20) for (const side of [-1, 1]) {
        const a = world(p, side * 2.6, 0.05), c = world(q, side * 2.6, 0.05);
        this.bld.nav.push({ a, b: c });
      }
    }
    // lay-by nav into the bay
    this.bld.nav.push({ a: world(layMid, 0, 0.05), b: world(layMid, lay.side * (hw + lay.width - 2), 0.05) });
    // portals onto the approach roads
    for (const [p, dir] of [[P[0], -1], [P[P.length - 1], 1]] as const) this.bld.nav.push({ a: new THREE.Vector3(p.x, p.y + 0.05, p.z), b: new THREE.Vector3(p.x + p.tx * dir * 12, p.y + 0.05, p.z + p.tz * dir * 12) });
  }

  /** Portal faces after the photo: a concrete arch collar proud of a dry-stone retaining wall cut into the rock. */
  private portals() {
    const b = this.b;
    const P = tunnelPath();
    const hw = TUN.hw, WALL = TUN.wall, ARCH = TUN.crown - TUN.wall;
    for (const [p, dir] of [[P[0], -1], [P[P.length - 1], 1]] as const) {
      // portal frame: x across the road, +z out of the tunnel (towards the approach road), y up
      const rot = Math.atan2(p.tx * dir, p.tz * dir);
      b.push([p.x, p.y, p.z], rot);
      // headwall: dry-stone slate face with the arch hole
      const face = new THREE.Shape();
      face.moveTo(-15, -1.2);
      face.lineTo(15, -1.2);
      face.lineTo(15, 9.5);
      face.lineTo(9, 11.2);
      face.lineTo(-9, 11.0);
      face.lineTo(-15, 9.2);
      face.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-hw - 0.6, -0.4);
      hole.lineTo(-hw - 0.6, WALL);
      for (let k = 1; k <= 16; k++) {
        const t = Math.PI - (k / 16) * Math.PI;
        hole.lineTo(Math.cos(t) * (hw + 0.6), WALL + Math.sin(t) * (ARCH + 0.6));
      }
      hole.lineTo(hw + 0.6, -0.4);
      hole.closePath();
      face.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(face, { depth: 3.0, bevelEnabled: false, curveSegments: 4 });
      g.translate(0, 0, -1.6);
      b.addGeo('stone', g);
      // its colliders: either side of the opening and over it
      b.box(null, -15, -0.2, -1.6, -hw - 0.6, 9.2, 1.4, 'rock');
      b.box(null, hw + 0.6, -0.2, -1.6, 15, 9.5, 1.4, 'rock');
      b.box(null, -hw - 0.6, TUN.crown + 0.6, -1.6, hw + 0.6, 11.0, 1.4, 'rock');
      // the concrete collar, proud of the wall by 2.2 m, dark grey with a lighter rim
      const collar = (r0: number, r1: number, z0: number, z1: number, mat: string) => {
        const s = new THREE.Shape();
        const n = 18;
        s.moveTo(-hw - r1, -0.2);
        s.lineTo(-hw - r1, WALL);
        for (let k = 1; k <= n; k++) {
          const t = Math.PI - (k / n) * Math.PI;
          s.lineTo(Math.cos(t) * (hw + r1), WALL + Math.sin(t) * (ARCH + r1));
        }
        s.lineTo(hw + r1, -0.2);
        s.lineTo(hw + r0, -0.2);
        for (let k = 0; k <= n; k++) {
          const t = (k / n) * Math.PI;
          s.lineTo(Math.cos(t) * (hw + r0), WALL + Math.sin(t) * (ARCH + r0));
        }
        s.lineTo(-hw - r0, -0.2);
        s.closePath();
        const cg = new THREE.ExtrudeGeometry(s, { depth: z1 - z0, bevelEnabled: false });
        cg.translate(0, 0, z0);
        b.addGeo(mat, cg);
      };
      collar(0, 0.65, -0.5, 2.4, 'chimney');
      collar(0.6, 0.72, 2.3, 2.45, 'concrete');
      for (const sx of [-1, 1]) {
        b.box(null, sx * (hw + 0.32) - 0.33, 0, -0.5, sx * (hw + 0.32) + 0.33, WALL + 1.0, 2.4, 'concrete');
        // footing blocks at the collar's feet (as in the photo)
        b.box('chimney', sx * (hw + 0.3) - 0.5, -0.2, 1.4, sx * (hw + 0.3) + 0.5, 1.1, 2.5, 'concrete');
      }
      // height-limit hazard bar hanging on two rods under the arch
      for (const sx of [-1, 1]) b.box('steel', sx * 2.2 - 0.03, 5.0, 1.4, sx * 2.2 + 0.03, TUN.crown + 0.2, 1.46);
      b.box('hazard', -3.1, 4.75, 1.36, 3.1, 5.05, 1.5);
      // blue name board on a post to the right, red emergency cabinet beyond it
      const bx = hw + 4.2;
      b.cyl('steel', bx, 0, 4.0, 0.07, 2.6, 8, 'metal');
      b.box('steel', bx - 0.95, 2.4, 3.95, bx + 0.95, 4.3, 4.0);
      const ng = new THREE.PlaneGeometry(1.86, 1.86);
      b.addGeo('brTunnelBoard', ng, new THREE.Matrix4().setPosition(bx, 3.35, 4.02));
      b.box('redSteel', bx + 2.3, 0, 3.4, bx + 3.4, 2.0, 4.1, 'metal');
      b.box('white', bx + 2.42, 1.2, 4.1, bx + 3.28, 1.85, 4.12);
      // concrete barriers along both sides of the approach
      for (const sx of [-1, 1]) for (let z = 3; z < 22; z += 3.1) {
        const tAt = new THREE.Vector3(sx * (hw + 0.6), 0, z).applyMatrix4(b.m);
        this.I.jersey(tAt.x, this.h(tAt.x, tAt.z), tAt.z, rot);
      }
      // lights at the portal (bright entry zone)
      this.I.lights.push({ pos: new THREE.Vector3(0, TUN.crown - 1.0, -4).applyMatrix4(b.m), color: 0xfff0d8, intensity: 10, dist: 18 });
      b.pop();
    }
  }

  // ------------------------------------------------------------------ Sundbrua
  /** A cable-stayed bridge over the sound: one H pylon on a caisson, a fan of stays, a box girder deck. */
  private sundbrua() {
    const b = this.b;
    const z = 115, xA = 22, xB = 122, yA = 8.6, yB = 11.6, W = 11;
    const yAt = (x: number) => {
      const t = (x - xA) / (xB - xA);
      return yA + (yB - yA) * t + Math.sin(Math.PI * t) * 1.6;
    };
    const px = 74;
    const N = 25;
    for (let i = 0; i < N; i++) {
      const xa = xA + ((xB - xA) * i) / N, xb = xA + ((xB - xA) * (i + 1)) / N;
      const ya = yAt(xa), yb = yAt(xb);
      const ang = Math.atan2(yb - ya, xb - xa), len = Math.hypot(xb - xa, yb - ya) + 0.03;
      const c: [number, number, number] = [(xa + xb) / 2, (ya + yb) / 2, z];
      const e = new THREE.Euler(0, 0, ang);
      // girder and deck
      b.obox('concreteWhite', [c[0], c[1] - 1.0, z], [len, 1.8, W - 1.6], e);
      b.obox('asphalt', [c[0], c[1] - 0.06, z], [len, 0.12, 8], e, 'concrete');
      for (const sz of [-1, 1]) {
        b.obox('concrete', [c[0], c[1] + 0.06, z + sz * 4.75], [len, 0.24, 1.5], e, 'concrete');
        // railings with a top rail; parapet collider
        b.obox('steel', [c[0], c[1] + 1.25, z + sz * 5.45], [len, 0.07, 0.07], e);
        b.obox('steel', [c[0], c[1] + 0.75, z + sz * 5.45], [len, 0.05, 0.05], e);
        b.obox(null, [c[0], c[1] + 0.7, z + sz * 5.45], [len, 1.3, 0.12], e, 'metal');
        b.box('steel', xa - 0.03, ya + 0.18, z + sz * 5.45 - 0.03, xa + 0.03, ya + 1.3, z + sz * 5.45 + 0.03);
        // fascia edge
        b.obox('concreteWhite', [c[0], c[1] - 0.3, z + sz * 5.5], [len, 0.6, 0.12], e);
      }
      // road lines
      b.obox('lineYellow', [c[0], c[1] + 0.005, z - 0.1], [len, 0.01, 0.1], e);
      b.obox('lineYellow', [c[0], c[1] + 0.005, z + 0.1], [len, 0.01, 0.1], e);
      for (const sz of [-1, 1]) b.obox('lineWhite', [c[0], c[1] + 0.005, z + sz * 3.8], [len, 0.01, 0.15], e);
    }
    // pylon: an H on a caisson in the sound
    const legZ = 7.2, top = 58;
    b.box('concrete', px - 6, -22, z - 11, px + 6, 1.2, z + 11, 'concrete');
    for (const sz of [-1, 1]) {
      // legs taper and lean in slightly
      const n = 6;
      for (let i = 0; i < n; i++) {
        const y0 = 1.2 + ((top - 1.2) * i) / n, y1 = 1.2 + ((top - 1.2) * (i + 1)) / n;
        const t0 = i / n, t1 = (i + 1) / n;
        const zz0 = z + sz * (legZ + 1.2 * (1 - t0)), zz1 = z + sz * (legZ + 1.2 * (1 - t1));
        const wA = 3.2 - 1.4 * t0, wB = 3.2 - 1.4 * t1;
        const lean = Math.atan2(zz1 - zz0, y1 - y0);
        b.obox('concreteWhite', [px, (y0 + y1) / 2, (zz0 + zz1) / 2], [(wA + wB) / 2, y1 - y0 + 0.05, 1.8 - 0.6 * t0], new THREE.Euler(lean * -1, 0, 0), 'concrete');
      }
    }
    // cross beams: under the deck and near the top
    b.box('concreteWhite', px - 1.4, yAt(px) - 3.6, z - legZ - 0.6, px + 1.4, yAt(px) - 1.9, z + legZ + 0.6, 'concrete');
    b.box('concreteWhite', px - 1.0, top - 6, z - legZ + 0.2, px + 1.0, top - 4.2, z + legZ - 0.2, 'concrete');
    b.box('lamp', px - 0.15, top + 0.1, z - legZ - 0.15, px + 0.15, top + 0.4, z - legZ + 0.15);
    b.box('lamp', px - 0.15, top + 0.1, z + legZ - 0.15, px + 0.15, top + 0.4, z + legZ + 0.15);
    // stays: a semi-fan from the upper legs to both deck edges, both directions
    for (const sz of [-1, 1]) {
      for (let k = 0; k < 9; k++) {
        const anchorY = top - 7 - k * 2.6;
        for (const dir of [-1, 1]) {
          const dx = 10 + k * 5.0;
          const x = px + dir * dx;
          if (x < xA + 2 || x > xB - 2) continue;
          const a = new THREE.Vector3(px, anchorY, z + sz * (legZ + 0.2));
          const c = new THREE.Vector3(x, yAt(x) + 0.2, z + sz * 5.35);
          const len = a.distanceTo(c);
          const g = new THREE.CylinderGeometry(0.06, 0.06, len, 6, 1, true);
          const m = new THREE.Matrix4().lookAt(a, c, new THREE.Vector3(0, 1, 0));
          m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
          m.setPosition(a.clone().add(c).multiplyScalar(0.5));
          b.addGeo('stay', g, m);
          b.box('steel', x - 0.15, yAt(x) + 0.1, z + sz * 5.35 - 0.15, x + 0.15, yAt(x) + 0.5, z + sz * 5.35 + 0.15);
        }
      }
    }
    // approach piers near both shores and the abutments
    for (const x of [34, 50, 100, 112]) b.box('concreteWhite', x - 1.0, Math.min(this.h(x, z), 0) - 6, z - 3.2, x + 1.0, yAt(x) - 1.9, z + 3.2, 'concrete');
    for (const [x, sx] of [[xA, -1], [xB, 1]] as const) b.box('concrete', x + sx * 0.0 - 1.2, this.h(x, z) - 4, z - W / 2 - 0.3, x + sx * 0.0 + 1.2, (sx < 0 ? yA : yB) - 0.05, z + W / 2 + 0.3, 'concrete');
    // deck lamps
    for (let x = xA + 8; x < xB - 4; x += 18) {
      for (const sz of [-1, 1]) {
        const y = yAt(x);
        b.cyl('steel', x, y + 0.2, z + sz * 5.2, 0.07, 6.2, 8, 'metal', 0.05);
        b.box('steel', x - 0.05, y + 6.3, z + sz * 5.2 - (sz > 0 ? 1.1 : 0), x + 0.05, y + 6.4, z + sz * 5.2 + (sz > 0 ? 0 : 1.1));
        b.box('lamp', x - 0.15, y + 6.2, z + sz * 4.2 - 0.25, x + 0.15, y + 6.3, z + sz * 4.2 + 0.25);
        this.I.lampAnchors.push(new THREE.Vector3(x, y + 6.0, z + sz * 4.2));
        this.I.lampHeads.push({ m: new THREE.Matrix4(), min: new THREE.Vector3(x - 0.15, y + 6.2, z + sz * 4.2 - 0.25), max: new THREE.Vector3(x + 0.15, y + 6.3, z + sz * 4.2 + 0.25) });
      }
    }
    // abandoned cars on the deck: the bridge is a long, exposed fight
    const cars: [number, number, string, boolean][] = [[40, 2.2, 'carBlue', false], [62, -2.4, 'carWhite', true], [88, 1.6, 'carRed', false], [104, -1.8, 'carGrey', false]];
    for (const [x, dz, paint, wreck] of cars) this.I.car(x, yAt(x), z + dz, Math.PI / 2 + (wreck ? 0.5 : 0.08), paint, wreck);
    this.I.truck(80, yAt(80), z - 1.2, Math.PI / 2 - 0.25);
    // nav down the deck
    for (let x = xA - 6; x < xB + 6; x += 12) {
      const x2 = Math.min(xB + 6, x + 12);
      const ya = x < xA ? yA : x > xB ? yB : yAt(x), yb = x2 > xB ? yB : yAt(x2);
      this.bld.nav.push({ a: new THREE.Vector3(x, ya + 0.1, z), b: new THREE.Vector3(x2, yb + 0.1, z) });
    }
  }

  // ------------------------------------------------------------------ breakwater
  private breakwater() {
    const b = this.b;
    const r = ROADS.find((q) => q.name === 'Molja');
    if (!r) return;
    const s = this.I.resample(r.pts, 2.0);
    // nav along the top (the grid can't see a narrow causeway between water)
    for (let i = 0; i < s.length - 4; i += 4) {
      const p = s[i], q = s[i + 4];
      this.bld.nav.push({ a: new THREE.Vector3(p.x, this.h(p.x, p.z) + 0.05, p.z), b: new THREE.Vector3(q.x, this.h(q.x, q.z) + 0.05, q.z) });
    }
    {
      const p = s[0];
      this.bld.nav.push({ a: new THREE.Vector3(p.x, this.h(p.x, p.z) + 0.05, p.z), b: new THREE.Vector3(p.x + 8, this.h(p.x + 8, p.z + 4) + 0.05, p.z + 4) });
    }
    for (const p of s) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 2; k++) {
          const off = 2.2 + k * 1.6 + this.rng.range(0, 0.6);
          const x = p.x - p.tz * off * side, z = p.z + p.tx * off * side;
          const sz = this.rng.range(0.9, 1.6);
          b.obox('boulder', [x, 1.4 - k * 1.3, z], [sz * 1.5, sz, sz * 1.2], new THREE.Euler(this.rng.range(-0.4, 0.4), this.rng.range(0, 3), this.rng.range(-0.3, 0.3)), 'rock');
        }
      }
    }
  }

  // ------------------------------------------------------------------ the glacial lake
  private lakeSurface() {
    const g = new THREE.CircleGeometry(1, 48);
    g.rotateX(-Math.PI / 2);
    g.scale(LAKE.rx * 1.12, 1, LAKE.rz * 1.12);
    const m = new THREE.MeshStandardMaterial({ color: 0x2fb4a8, roughness: 0.04, metalness: 0.15, envMapIntensity: 1.6, transparent: true, opacity: 0.86, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(LAKE.x, LAKE.y, LAKE.z);
    mesh.name = 'lake';
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    this.parent.add(mesh);
    this.lake = mesh;
  }

  // ------------------------------------------------------------------ street furniture
  private street() {
    // Jugend lamps along both canal promenades, benches and planters; lamps down the main streets
    for (let x = -176; x < 34; x += 18) {
      for (const side of [-1, 1]) {
        const z = canalZ(x) + side * (CANAL_HW + 1.2);
        if (Math.abs(this.h(x, z) - QUAY_Y) > 0.5) continue;
        this.jugendLamp(x, z);
      }
    }
    for (const r of ROADS) {
      if (r.kind !== 'asphalt' || r.name === 'Sundbrua') continue;
      const s = this.I.resample(r.pts, 2);
      for (let i = 6; i < s.length; i += 14) {
        const p = s[i];
        const side = i % 28 === 6 ? 1 : -1;
        const x = p.x - p.tz * (r.width / 2 + 0.7) * side, z = p.z + p.tx * (r.width / 2 + 0.7) * side;
        if (this.bld.footprints.some((f) => x > f.min.x - 0.6 && x < f.max.x + 0.6 && z > f.min.z - 0.6 && z < f.max.z + 0.6)) continue;
        if (this.h(x, z) < 1) continue;
        this.jugendLamp(x, z);
      }
    }
    // Norwegian flags: the church, Fjellstua, the harbour office
    for (const [x, z, hh] of [[14, -60, 12], [-84, -100, 9], [146, 26, 10]] as const) {
      const y = this.h(x, z);
      this.b.cyl('white', x, y, z, 0.07, hh, 8, 'metal', 0.045);
      this.I.flag(new THREE.Vector3(x, y + hh - 0.1, z));
    }
  }

  /** nav up every cross street past the second building row into the upper town on both islands */
  private crossStreetNav() {
    for (const x of [-158, -112, -72, -35, 4]) {
      for (const side of [-1, 1]) {
        let prev: THREE.Vector3 | null = null;
        for (const off of [18, 34, 50, 64]) {
          const z = canalZ(x) + side * off;
          const p = new THREE.Vector3(x, this.h(x, z) + 0.05, z);
          if (p.y < 1) break;
          if (prev && Math.abs(prev.y - p.y) < 6) this.bld.nav.push({ a: prev, b: p });
          prev = p;
        }
      }
    }
  }

  /** Cover across the open ground: stone walls, boulders, wrecks and barriers at the chokepoints. */
  private cover() {
    const I = this.I;
    const walls: [number, number, number, number][] = [
      [-140, 120, -120, 128], [-70, 140, -52, 150], [-30, -110, -12, -118], [-150, -120, -134, -130],
      [160, -30, 172, -24], [176, -80, 192, -74], [196, 40, 210, 46], [150, 70, 160, 84], [-110, 150, -96, 162],
    ];
    for (const [x0, z0, x1, z1] of walls) I.stoneWall(x0, z0, x1, z1);
    const boulders: [number, number, number][] = [
      [-60, -150, 3], [-120, -150, 3], [10, -130, 2], [170, -40, 3], [214, -72, 4], [228, -50, 3], [204, 20, 3],
      [-160, 150, 2], [-30, 120, 2], [184, -30, 2], [-130, -170, 3], [30, -170, 3], [160, 100, 2],
    ];
    for (const [x, z, n] of boulders) I.boulders(x, z, n);
    // checkpoints at both portals and the bridge ends
    I.sandbags(-26, -50, 0.1, 4);
    I.sandbags(-36, -54, -0.3, 3);
    I.sandbags(150, -36, 1.4, 4);
    I.sandbags(140, -40, 1.8, 3);
    I.sandbags(14, 106, 0.3, 4);
    I.sandbags(130, 104, -0.4, 4);
    // cars on the streets
    const paints = ['carRed', 'carBlue', 'carWhite', 'carGrey', 'carGreen', 'carBlack'];
    const spots: [number, number, number][] = [[-90, canalZ(-90) - 34, 0.05], [-130, canalZ(-130) + 34, 3.1], [-50, canalZ(-50) + 34.5, 0.0], [-20, canalZ(-20) - 33, 3.14], [-35, 60, 1.6], [-33, -30, 1.5], [134, -20, 1.55], [136, 34, 1.6], [150, -56, 0.4], [-112, 50, 1.58]];
    for (const [x, z, r] of spots) I.car(x, this.h(x, z), z, r, this.rng.pick(paints), false);
    I.car(-36, this.h(-36, 84), 84, 1.3, 'carBurnt', true);
  }

  pumpPos: THREE.Vector3 | null = null;
  /** falling water drops under the drip points near the camera (an instanced pool) */
  private drops: THREE.InstancedMesh | null = null;
  private dropState: { i: number; t0: number; period: number }[] = [];
  private lastT = 0;
  update(t: number, cam?: THREE.Vector3) {
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (this.lake) {
      const m = this.lake.material as THREE.MeshStandardMaterial;
      m.roughness = 0.03 + 0.02 * Math.sin(t * 0.3);
    }
    if (!cam || !this.drips.length) return;
    if (!this.drops) {
      const g = new THREE.SphereGeometry(0.018, 5, 4);
      g.scale(1, 3.2, 1);
      const m = new THREE.MeshStandardMaterial({ color: 0xbfd8e6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.7 });
      this.drops = new THREE.InstancedMesh(g, m, 24);
      this.drops.frustumCulled = false;
      this.drops.count = 0;
      this.parent.add(this.drops);
      this.dropState = this.drips.map((_, i) => ({ i, t0: (i * 0.73) % 3, period: 1.4 + ((i * 0.37) % 2.2) }));
    }
    void dt;
    // the nearest 24 drip points get a drop each, falling on its own cycle
    const near = this.dropState.filter((d) => this.drips[d.i].distanceToSquared(cam) < 900).slice(0, 24);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (const d of near) {
      const p = this.drips[d.i];
      const ph = ((t - d.t0) % d.period + d.period) % d.period;
      const fall = 0.5 * 9.8 * ph * ph;
      const floorY = p.y - (TUN.crown - 0.2);
      if (p.y - fall < floorY) continue;
      m4.makeTranslation(p.x, p.y - fall, p.z);
      this.drops.setMatrixAt(n++, m4);
    }
    this.drops.count = n;
    this.drops.instanceMatrix.needsUpdate = true;
  }
}
