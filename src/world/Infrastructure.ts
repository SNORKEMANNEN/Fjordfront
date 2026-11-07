import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';
import { Buildings } from './Buildings';
import { ROADS, BRIDGE, TUNNEL, TUNNEL_EXIT, tunnelShafts, FOOTBRIDGE, PLANK_BRIDGE, LADDERS, coastX, southCoastZ, Road, nearestRoad } from './MapLayout';
import { Details } from './Details';
import { signMaterials } from './Signs';
import { RNG } from '../core/math';
import { Terrain } from './Terrain';

export interface LightSpot { pos: THREE.Vector3; color: number; intensity: number; dist: number }

/** Roads, bridges, tunnel, docks, quay and street furniture. */
export class Infrastructure {
  lights: LightSpot[] = [];
  flags: THREE.Mesh[] = [];
  coverPoints: THREE.Vector3[] = [];
  private rng = new RNG(808);
  carCount = 0;

  constructor(private b: GeoBuilder, private bld: Buildings, private terrain: Terrain, private parent: THREE.Object3D, mats: Record<string, THREE.Material>) {
    Object.assign(b.mats, signMaterials());
    for (const r of ROADS) this.road(r);
    this.bridge();
    this.footbridge();
    this.plankBridge();
    this.ladders();
    this.tunnel();
    this.docks();
    this.quay();
    this.props(mats);
    // set dressing & extra cover over the whole map
    new Details(this.b, this.bld, this.terrain, {
      sandbags: (x, z, r, l) => this.sandbags(x, z, r, l),
      jersey: (x, y, z, r) => this.jersey(x, y, z, r),
      car: (x, y, z, r, paint, wreck) => this.car(x, y, z, r, paint, wreck),
    });
  }

  private h(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }

  private resample(pts: [number, number][], step: number) {
    const out: { x: number; z: number; tx: number; tz: number; s: number }[] = [];
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / L, tz: (bz - az) / L, s: acc + L * t });
      }
      acc += L;
    }
    const [lx, lz] = pts[pts.length - 1];
    const prev = out[out.length - 1];
    out.push({ x: lx, z: lz, tx: prev.tx, tz: prev.tz, s: acc });
    // smooth tangents at corners
    for (let i = 1; i < out.length - 1; i++) {
      const tx = out[i - 1].tx + out[i + 1].tx, tz = out[i - 1].tz + out[i + 1].tz;
      const l = Math.hypot(tx, tz) || 1;
      out[i].tx = tx / l;
      out[i].tz = tz / l;
    }
    return out;
  }

  /** Ribbon strip following the terrain. offsets: [left, right] lateral offsets. */
  private ribbon(mat: string, samples: ReturnType<Infrastructure['resample']>, o0: number, o1: number, lift: number, skip?: (x: number, z: number) => boolean, dash?: [number, number]) {
    const pos: number[] = [], uv: number[] = [], nor: number[] = [];
    const lo = Math.min(o0, o1), hi = Math.max(o0, o1);
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i], c = samples[i + 1];
      if (skip && (skip(a.x, a.z) || skip(c.x, c.z))) continue;
      if (dash) {
        const ph = a.s % (dash[0] + dash[1]);
        if (ph > dash[0]) continue;
      }
      const corner = (p: typeof a, o: number) => {
        const x = p.x - p.tz * o, z = p.z + p.tx * o;
        return [x, this.h(x, z) + lift, z];
      };
      const p0 = corner(a, lo), p1 = corner(a, hi), p2 = corner(c, lo), p3 = corner(c, hi);
      // wound counter-clockwise seen from above (front faces up)
      pos.push(...p0, ...p1, ...p2, ...p1, ...p3, ...p2);
      const w = hi - lo;
      uv.push(0, a.s, w, a.s, 0, c.s, w, a.s, w, c.s, 0, c.s);
      for (let k = 0; k < 6; k++) nor.push(0, 1, 0);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.computeVertexNormals();
    this.b.addGeo(mat, g);
  }

  private road(r: Road) {
    const s = this.resample(r.pts, 1.6);
    const hw = r.width / 2;
    const main = r === ROADS[0];
    // (inside the tunnel the main road is drawn full-width by tunnel())
    const skip = main ? (x: number, z: number) => (z > BRIDGE.z0 + 1 && z < BRIDGE.z1 - 1) || (z > TUNNEL.z0 - 3 && z < TUNNEL.z1 + 3) : undefined;
    const mat = r.kind === 'asphalt' ? 'asphalt' : r.kind === 'gravel' ? 'gravelRoad' : 'dirtRoad';
    this.ribbon(mat, s, -hw, hw, r.kind === 'dirt' ? 0.025 : 0.05, skip);
    if (r.lines) {
      this.ribbon('lineWhite', s, -hw + 0.18, -hw + 0.3, 0.07, skip);
      this.ribbon('lineWhite', s, hw - 0.3, hw - 0.18, 0.07, skip);
      this.ribbon('lineYellow', s, -0.06, 0.06, 0.07, skip, [3, 6]);
    }
    if (r.kind === 'asphalt') {
      // snow poles (brøytestikker) & occasional guard rails outside the village
      for (let i = 0; i < s.length; i += 12) {
        const p = s[i];
        const inVillage = Math.hypot(p.x, p.z) < 60 || p.z > 100;
        if (inVillage || (main && p.z > TUNNEL.z0 - 4 && p.z < TUNNEL.z1 + 4) || (main && p.z > BRIDGE.z0 - 2 && p.z < BRIDGE.z1 + 2)) continue;
        for (const side of [-1, 1]) {
          const x = p.x - p.tz * (hw + 0.6) * side, z = p.z + p.tx * (hw + 0.6) * side;
          const y = this.h(x, z);
          this.b.box('snowPole', x - 0.02, y, z - 0.02, x + 0.02, y + 1.9, z + 0.02);
          this.b.box('lamp', x - 0.025, y + 1.6, z - 0.025, x + 0.025, y + 1.7, z + 0.025);
        }
      }
    }
  }

  private bridge() {
    const b = this.b;
    const { x, z0, z1, width } = BRIDGE;
    const hN = this.h(x + 1, z0 - 1.5), hS = this.h(x, z1 + 1.5);
    const n = 16;
    const yAt = (t: number) => hN + (hS - hN) * t + Math.sin(t * Math.PI) * 1.2;
    for (let i = 0; i < n; i++) {
      const ta = i / n, tb = (i + 1) / n;
      const za = z0 + (z1 - z0) * ta, zb = z0 + (z1 - z0) * tb;
      const ya = yAt(ta), yb = yAt(tb);
      const L = Math.hypot(zb - za, yb - ya);
      const ang = Math.atan2(yb - ya, zb - za);
      b.obox('asphalt', [x, (ya + yb) / 2 - 0.15, (za + zb) / 2], [width, 0.3, L + 0.05], new THREE.Euler(-ang, 0, 0), 'asphalt');
      b.obox('concrete', [x, (ya + yb) / 2 - 0.65, (za + zb) / 2], [width + 0.6, 0.7, L + 0.05], new THREE.Euler(-ang, 0, 0), 'concrete');
      for (const sx of [-1, 1]) {
        b.obox('concrete', [x + sx * (width / 2 + 0.15), (ya + yb) / 2 + 0.05, (za + zb) / 2], [0.4, 0.5, L + 0.05], new THREE.Euler(-ang, 0, 0), 'concrete');
        // railing posts & rails
        b.box('steel', x + sx * (width / 2 + 0.1) - 0.04, ya + 0.3, za - 0.04, x + sx * (width / 2 + 0.1) + 0.04, ya + 1.3, za + 0.04, 'metal');
        b.obox('steel', [x + sx * (width / 2 + 0.1), (ya + yb) / 2 + 1.25, (za + zb) / 2], [0.08, 0.1, L + 0.05], new THREE.Euler(-ang, 0, 0), 'metal');
        b.obox('steel', [x + sx * (width / 2 + 0.1), (ya + yb) / 2 + 0.85, (za + zb) / 2], [0.05, 0.05, L + 0.05], new THREE.Euler(-ang, 0, 0));
      }
      // centre line
      if (i % 2 === 0) b.obox('lineYellow', [x, (ya + yb) / 2 + 0.005, (za + zb) / 2], [0.12, 0.01, L * 0.6], new THREE.Euler(-ang, 0, 0));
    }
    // piers
    for (const t of [0.3, 0.7]) {
      const zz = z0 + (z1 - z0) * t;
      b.box('concrete', x - 2.5, -6, zz - 0.9, x + 2.5, yAt(t) - 0.9, zz + 0.9, 'concrete');
      b.box('concrete', x - 3.2, yAt(t) - 1.2, zz - 1.2, x + 3.2, yAt(t) - 0.85, zz + 1.2);
    }
    this.bld.nav.push({ a: new THREE.Vector3(x, hN + 0.1, z0 - 3), b: new THREE.Vector3(x, yAt(0.5) + 0.1, (z0 + z1) / 2) });
    this.bld.nav.push({ a: new THREE.Vector3(x, yAt(0.5) + 0.1, (z0 + z1) / 2), b: new THREE.Vector3(x, hS + 0.1, z1 + 3) });
    // wrecked car for cover on the bridge
    this.car(x - 1.8, yAt(0.45) + 0.02, z0 + (z1 - z0) * 0.45, 0.5, 'carBurnt', true);
  }

  private footbridge() {
    const b = this.b;
    const { x, z0, z1, deckY, width } = FOOTBRIDGE;
    b.box('planks', x - width / 2, deckY - 0.12, z0 - 1, x + width / 2, deckY, z1 + 1, 'wood');
    for (let z = z0; z <= z1 + 0.01; z += 4) {
      for (const sx of [-1, 1]) {
        b.cyl('woodRaw', x + sx * (width / 2 - 0.1), -5, z, 0.12, deckY + 5 - 0.12, 8, 'wood');
        b.box('woodRaw', x + sx * (width / 2) - 0.05, deckY, z - 0.05, x + sx * (width / 2) + 0.05, deckY + 1.05, z + 0.05, 'wood');
      }
    }
    for (const sx of [-1, 1]) b.box('woodRaw', x + sx * (width / 2) - 0.05, deckY + 0.95, z0 - 1, x + sx * (width / 2) + 0.05, deckY + 1.05, z1 + 1, 'wood');
    // ramps to banks
    for (const [zEnd, dir] of [[z0 - 1, -1], [z1 + 1, 1]] as const) {
      const gy = this.h(x, zEnd + dir * 4);
      const L = Math.hypot(4, deckY - gy);
      b.obox('planks', [x, (deckY + gy) / 2 - 0.06, zEnd + dir * 2], [width, 0.12, L], new THREE.Euler(-Math.atan2(gy - deckY, 4) * dir, 0, 0), 'wood');
      this.bld.nav.push({ a: new THREE.Vector3(x, gy, zEnd + dir * 5), b: new THREE.Vector3(x, deckY, (z0 + z1) / 2) });
    }
  }

  /** Narrow plank bridge over the inlet east of the road bridge (alternate route to the fort). */
  private plankBridge() {
    const b = this.b;
    const { x, z0, z1, width } = PLANK_BRIDGE;
    const y0 = this.h(x, z0) + 0.15, y1 = this.h(x, z1) + 0.15;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const ta = i / n, tb = (i + 1) / n;
      const za = z0 + (z1 - z0) * ta, zb = z0 + (z1 - z0) * tb;
      const ya = y0 + (y1 - y0) * ta + Math.sin(ta * Math.PI) * 0.6, yb = y0 + (y1 - y0) * tb + Math.sin(tb * Math.PI) * 0.6;
      const L = Math.hypot(zb - za, yb - ya);
      b.obox('planks', [x, (ya + yb) / 2, (za + zb) / 2], [width, 0.1, L + 0.04], new THREE.Euler(-Math.atan2(yb - ya, zb - za), 0, 0), 'wood');
      for (const sx of [-1, 1]) {
        b.box('woodRaw', x + sx * width / 2 - 0.05, ya, za - 0.05, x + sx * width / 2 + 0.05, ya + 0.95, za + 0.05);
        // invisible side guard following the rope so nobody walks off the deck by accident
        b.obox(null, [x + sx * (width / 2 + 0.03), (ya + yb) / 2 + 0.55, (za + zb) / 2], [0.08, 1.0, L + 0.04], new THREE.Euler(-Math.atan2(yb - ya, zb - za), 0, 0), 'wood');
      }
    }
    for (const sx of [-1, 1]) {
      const L = Math.hypot(z1 - z0, y1 - y0);
      b.obox('rope', [x + sx * width / 2, (y0 + y1) / 2 + 0.9 + 0.3, (z0 + z1) / 2], [0.04, 0.04, L], new THREE.Euler(-Math.atan2(y1 - y0, z1 - z0), 0, 0));
    }
    for (const zz of [z0 + 7, z1 - 7]) for (const sx of [-1, 1]) b.cyl('woodRaw', x + sx * (width / 2 - 0.1), -4, zz, 0.12, 4 + (y0 + y1) / 2, 8, 'wood');
    this.bld.nav.push({ a: new THREE.Vector3(x, y0, z0 - 3), b: new THREE.Vector3(x, (y0 + y1) / 2 + 0.6, (z0 + z1) / 2) });
    this.bld.nav.push({ a: new THREE.Vector3(x, (y0 + y1) / 2 + 0.6, (z0 + z1) / 2), b: new THREE.Vector3(x, y1, z1 + 3) });
  }

  private ladders() {
    const b = this.b;
    for (const l of LADDERS) {
      // build in the ladder's own frame (x across, z out from the wall) so rotated walls work too
      b.push([l.x, 0, l.z], Math.atan2(l.nx, l.nz));
      for (const sx of [-1, 1]) b.box('yellowSteel', sx * 0.24 - 0.025, l.y0, -0.025, sx * 0.24 + 0.025, l.y1 + 1.0, 0.025);
      for (let y = l.y0 + 0.3; y < l.y1 + 0.1; y += 0.3) b.box('steel', -0.24, y, -0.015, 0.24, y + 0.03, 0.015);
      // wall brackets
      for (let y = l.y0 + 0.6; y < l.y1; y += 2.2) for (const sx of [-1, 1]) b.box('steel', sx * 0.24 - 0.02, y, -0.16, sx * 0.24 + 0.02, y + 0.04, 0);
      b.pop();
    }
  }

  /**
   * Kvitviktunnelen: a two-lane road tunnel (16 m wide, 8 m high) with wrecks and barriers for
   * cover. Behind each wall a service gallery runs between two emergency-exit doors (green exit
   * signs over them, blade signs down the bore); from the gallery a shaft with a ladder climbs to a
   * hatch platform on the crest of the ridge.
   */
  private tunnel() {
    const b = this.b;
    const { x, z0, z1, height } = TUNNEL;
    const E = TUNNEL_EXIT;
    const y0 = E.floor;
    const W = TUNNEL.width / 2, WH = TUNNEL.wall, RY = height - WH;
    const gz0 = E.doors[0] - 1.2, gz1 = E.doors[1] + 1.2;
    const sz0 = E.shaftZ - 1.2, sz1 = E.shaftZ + 1.2;
    // a box given as distances from the tunnel axis on side sx (order-free)
    const bx = (mat: string | null, sx: number, a0: number, ya: number, za: number, a1: number, yb: number, zb: number, collide: 'concrete' | 'rock' | 'metal' | null = null) =>
      b.box(mat, x + sx * a0, ya, za, x + sx * a1, yb, zb, collide);
    // invisible floor collider (concrete footsteps, sits a hair above the carved terrain)
    b.box(null, x - W - 0.2, y0 - 0.6, z0 - 1, x + W + 0.2, y0 + 0.01, z1 + 1, 'concrete');
    for (const sx of [-1, 1]) {
      // ---- the wall with its two exit doors (doorways get real hinged steel doors)
      b.push([x, 0, 0], -Math.PI / 2);
      const holes = E.doors.map((dz) => ({ x: dz, w: 1.4, y0, y1: y0 + 2.3 }));
      b.wall('concrete', z0, z1, -sx * (W + 0.6), 1.2, y0, y0 + WH, holes, 'concrete');
      // light wall cladding along the lower wall (Norwegian tunnels), framed openings at the doors
      b.wall('cladding', z0 + 0.6, z1 - 0.6, -sx * (W - 0.05), 0.1, y0 + 0.2, y0 + 3.4, E.doors.map((dz) => ({ x: dz, w: 1.9, y0: y0 + 0.2, y1: y0 + 2.75 })), 'concrete');
      b.pop();
      bx('concrete', sx, W, y0 - 0.6, z0, W + 1.2, y0 + 0.02, z1); // footing under the wall (the doorway floor)
      // ---- rock behind the gallery and solid fill where there is no gallery
      bx('concrete', sx, W + E.gx1, y0 - 0.6, z0, W + E.carve, y0 + WH, z1, 'rock');
      bx('concrete', sx, W + E.gx0, y0 - 0.6, z0, W + E.gx1, y0 + WH, gz0, 'rock');
      bx('concrete', sx, W + E.gx0, y0 - 0.6, gz1, W + E.gx1, y0 + WH, z1, 'rock');
      // gallery roof (open over the shaft) and a concrete floor
      bx('concrete', sx, W + E.gx0, y0 + E.gh, gz0, W + E.gx1, y0 + WH, sz0, 'concrete');
      bx('concrete', sx, W + E.gx0, y0 + E.gh, sz1, W + E.gx1, y0 + WH, gz1, 'concrete');
      bx('concrete', sx, W + E.gx0, y0 - 0.2, gz0, W + E.gx1, y0 + 0.03, gz1, 'concrete');
      // gallery lamps (cool white strips)
      for (const lz of [E.doors[0], (E.doors[0] + E.shaftZ) / 2 - 1, (E.doors[1] + E.shaftZ) / 2 + 1, E.doors[1]]) {
        bx('bulbCool', sx, W + 2.2, y0 + E.gh - 0.08, lz - 0.5, W + 2.6, y0 + E.gh, lz + 0.5);
      }
      this.lights.push({ pos: new THREE.Vector3(x + sx * (W + 2.4), y0 + E.gh - 0.4, (gz0 + E.shaftZ) / 2), color: 0xd8e8ff, intensity: 5, dist: 9 });
      this.lights.push({ pos: new THREE.Vector3(x + sx * (W + 2.4), y0 + E.gh - 0.4, (gz1 + E.shaftZ) / 2), color: 0xd8e8ff, intensity: 5, dist: 9 });
      // ---- exits: frame, sign over the door, blade sign, green lamp, nav links through the doorway
      for (const dz of E.doors) {
        const face = W - 0.11;
        bx('exitGreen', sx, face, y0, dz - 0.95, W + 0.02, y0 + 2.42, dz - 0.7);
        bx('exitGreen', sx, face, y0, dz + 0.7, W + 0.02, y0 + 2.42, dz + 0.95);
        bx('exitGreen', sx, face, y0 + 2.3, dz - 0.95, W + 0.02, y0 + 2.48, dz + 0.95);
        // wall sign (lit) above the door, facing the road
        bx('exitGreen', sx, face - 0.04, y0 + 2.66, dz - 0.98, face, y0 + 3.3, dz + 0.98);
        const g = new THREE.PlaneGeometry(1.86, 0.6);
        b.addGeo('signExit', g, new THREE.Matrix4().makeRotationY(-sx * Math.PI / 2).setPosition(x + sx * (face - 0.05), y0 + 2.98, dz));
        // blade sign out from the wall high up, readable from both ends of the bore
        bx('steel', sx, W - 0.15, y0 + 3.95, dz - 0.03, W - 1.15, y0 + 4.0, dz + 0.03);
        bx('exitGreen', sx, W - 0.2, y0 + 3.3, dz - 0.025, W - 1.1, y0 + 3.96, dz + 0.025);
        for (const f of [1, -1]) {
          const bg = new THREE.PlaneGeometry(0.84, 0.62);
          b.addGeo('signExitBlade', bg, new THREE.Matrix4().makeRotationY(f > 0 ? 0 : Math.PI).setPosition(x + sx * (W - 0.65), y0 + 3.63, dz + f * 0.03));
        }
        // green exit lamp + light
        bx('exitLamp', sx, face - 0.06, y0 + 3.36, dz - 0.3, face, y0 + 3.46, dz + 0.3);
        this.lights.push({ pos: new THREE.Vector3(x + sx * (W - 0.8), y0 + 2.9, dz), color: 0x40ff90, intensity: 4, dist: 7 });
        // inside the gallery: a lamp over the door and an exit sign pointing at the shaft
        bx('exitLamp', sx, W + E.gx0, y0 + 2.4, dz - 0.3, W + E.gx0 + 0.06, y0 + 2.5, dz + 0.3);
        const tn = this.bld.nav;
        tn.push({ a: new THREE.Vector3(x + sx * (W - 1.6), y0, dz), b: new THREE.Vector3(x + sx * (W + 2.4), y0 + 0.03, dz) });
        tn.push({ a: new THREE.Vector3(x + sx * (W + 2.4), y0 + 0.03, dz), b: new THREE.Vector3(x + sx * (W + 2.4), y0 + 0.03, E.shaftZ + (dz < E.shaftZ ? -2.6 : 2.6)) });
        this.coverPoints.push(new THREE.Vector3(x + sx * (W + 2.4), y0, dz));
      }
      this.bld.nav.push({ a: new THREE.Vector3(x + sx * (W + 2.4), y0 + 0.03, E.shaftZ - 2.6), b: new THREE.Vector3(x + sx * (W + 2.4), y0 + 0.03, E.shaftZ + 2.6) });
      // the ladder sign at the shaft foot (on the gallery's inner wall, facing the ladder)
      const ug = new THREE.PlaneGeometry(0.7, 0.7);
      b.addGeo('signExitUp', ug, new THREE.Matrix4().makeRotationY(sx * Math.PI / 2).setPosition(x + sx * (W + E.gx0 + 0.02), y0 + 1.9, E.shaftZ - 1.7 * Math.sign(E.shaftZ - E.doors[0])));
      // ---- the shaft up to the crest
      const sh = tunnelShafts().find((t) => t.sx === sx)!;
      const T = 0.25;
      bx('concrete', sx, W + E.gx0 - T, y0 + WH, sz0 - T, W + E.gx0, sh.top, sz1 + T, 'concrete');
      bx('concrete', sx, W + E.gx1, y0 + WH, sz0 - T, W + E.gx1 + T, sh.top, sz1 + T, 'concrete');
      bx('concrete', sx, W + E.gx0, y0 + WH, sz0 - T, W + E.gx1, sh.top, sz0, 'concrete');
      bx('concrete', sx, W + E.gx0, y0 + WH, sz1, W + E.gx1, sh.top, sz1 + T, 'concrete');
      // shaft lamps every few metres
      for (let ly = y0 + 6; ly < sh.top - 2; ly += 6) bx('bulbCool', sx, W + E.gx0, ly, E.shaftZ - 0.25, W + E.gx0 + 0.05, ly + 0.12, E.shaftZ + 0.25);
      this.lights.push({ pos: new THREE.Vector3(x + sx * (W + 2.4), (y0 + sh.top) / 2, E.shaftZ), color: 0xd8e8ff, intensity: 5, dist: 14 });
      // hatch platform on the crest: slab around the hole, railings on three sides, a sign and a lamp
      const ax0 = W + E.gx0 - T, ax1 = W + E.gx1 + T;
      const pa0 = Math.abs(sh.px0 - x) < Math.abs(sh.px1 - x) ? Math.abs(sh.px0 - x) : Math.abs(sh.px1 - x);
      const pa1 = Math.max(Math.abs(sh.px0 - x), Math.abs(sh.px1 - x));
      bx('concrete', sx, pa0, sh.base, sh.pz0, ax0, sh.top, sh.pz1, 'concrete');
      bx('concrete', sx, ax1, sh.base, sh.pz0, pa1, sh.top, sh.pz1, 'concrete');
      bx('concrete', sx, ax0, sh.base, sh.pz0, ax1, sh.top, sz0 - T, 'concrete');
      bx('concrete', sx, ax0, sh.base, sz1 + T, ax1, sh.top, sh.pz1, 'concrete');
      const ry = sh.top;
      // rails: inner side (towards the bore) and both ends; the ladder (outer) side stays open
      const rail = (a0: number, za: number, a1: number, zb: number) => {
        bx('yellowSteel', sx, a0, ry + 1.0, za, a1, ry + 1.06, zb);
        bx('yellowSteel', sx, a0, ry + 0.5, za, a1, ry + 0.55, zb);
        bx(null, sx, a0, ry, za, a1, ry + 1.06, zb, 'metal');
      };
      rail(W + E.gx0 - 0.15, sz0 - 0.15, W + E.gx0 - 0.1, sz1 + 0.15);
      rail(W + E.gx0 - 0.15, sz0 - 0.15, W + E.gx1 + 0.1, sz0 - 0.1);
      rail(W + E.gx0 - 0.15, sz1 + 0.1, W + E.gx1 + 0.1, sz1 + 0.15);
      for (const [pa, pz] of [[W + E.gx0 - 0.12, sz0 - 0.12], [W + E.gx0 - 0.12, sz1 + 0.12], [W + E.gx1 + 0.08, sz0 - 0.12], [W + E.gx1 + 0.08, sz1 + 0.12], [W + E.gx0 - 0.12, E.shaftZ]] as const) {
        bx('yellowSteel', sx, pa - 0.03, ry, pz - 0.03, pa + 0.03, ry + 1.06, pz + 0.03);
      }
      // sign post on the platform corner: EXIT board facing outwards, a green lamp on top
      const sa = W + E.gx1 + 1.3, szp = sz1 + 1.0;
      bx('steel', sx, sa - 0.04, ry, szp - 0.04, sa + 0.04, ry + 2.3, szp + 0.04);
      bx('exitGreen', sx, sa - 0.02, ry + 1.5, szp - 0.42, sa + 0.02, ry + 2.15, szp + 0.42);
      for (const f of [1, -1]) {
        const pg = new THREE.PlaneGeometry(0.8, 0.6);
        b.addGeo('signExitBlade', pg, new THREE.Matrix4().makeRotationY(f > 0 ? Math.PI / 2 : -Math.PI / 2).setPosition(x + sx * sa + f * 0.03, ry + 1.82, szp));
      }
      bx('exitLamp', sx, sa - 0.08, ry + 2.3, szp - 0.08, sa + 0.08, ry + 2.42, szp + 0.08);
      this.lights.push({ pos: new THREE.Vector3(x + sx * sa, ry + 2.6, szp), color: 0x50ff9a, intensity: 3, dist: 8 });
    }
    // ---- arched ceiling (rock), a light every few metres down both sides of the crown
    const segs = 10;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
      const p0 = [Math.cos(a0) * W, Math.sin(a0) * RY], p1 = [Math.cos(a1) * W, Math.sin(a1) * RY];
      const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      b.obox('tunnel', [x + cx, y0 + WH + cy + 0.4, (z0 + z1) / 2], [L + 0.1, 0.8, z1 - z0], new THREE.Euler(0, 0, ang), 'rock');
    }
    const lampX = 4.4, lampY = y0 + WH + RY * Math.sqrt(1 - (lampX / W) ** 2) - 0.05;
    for (let zz = z0 + 3; zz < z1 - 1; zz += 4.5) for (const sx of [-1, 1]) b.box('sodium', x + sx * lampX - 0.22, lampY - 0.12, zz - 0.7, x + sx * lampX + 0.22, lampY, zz + 0.7);
    for (const zz of [z0 + 8, (z0 + z1) / 2, z1 - 8]) this.lights.push({ pos: new THREE.Vector3(x, y0 + height - 1.2, zz), color: 0xff9a3a, intensity: 26, dist: 22 });
    // jet fans hanging under the crown
    for (const zz of [z0 + 12, z1 - 12]) for (const sx of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.55, 0.55, 2.6, 14).rotateX(Math.PI / 2);
      b.addGeo('steel', g, new THREE.Matrix4().setPosition(x + sx * 1.6, y0 + height - 0.95, zz));
      b.box('steel', x + sx * 1.6 - 0.05, y0 + height - 0.45, zz - 0.6, x + sx * 1.6 + 0.05, y0 + height + 0.2, zz + 0.6);
    }
    // ---- road: full-width asphalt, two lanes (4 m each) with a double centre line, shoulders, kerbed walkways
    const main = this.resample(ROADS[0].pts, 1.6);
    const inside = (p: { z: number }) => p.z > z0 - 3 && p.z < z1 + 3;
    let i0 = -1, i1 = -1;
    for (let i = 0; i < main.length - 1; i++) if (inside(main[i]) || inside(main[i + 1])) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 >= 0) {
      const seg = main.slice(i0, i1 + 2);
      this.ribbon('asphalt', seg, -(W - 0.9), W - 0.9, 0.05);
      this.ribbon('lineYellow', seg, -0.2, -0.08, 0.07);
      this.ribbon('lineYellow', seg, 0.08, 0.2, 0.07);
      for (const sx of [-1, 1]) {
        this.ribbon('lineWhite', seg, sx * 3.9, sx * 4.05, 0.07);
        this.ribbon('lineWhite', seg, sx * (W - 1.25), sx * (W - 1.1), 0.07, undefined, [2, 2]);
      }
    }
    for (const sx of [-1, 1]) {
      b.box('concrete', x + sx * (W - 1.0), y0, z0, x + sx * W, y0 + 0.2, z1, 'concrete');
      b.box('cladding', x + sx * (W - 1.0) - 0.01, y0 + 0.2, z0, x + sx * (W - 0.98), y0 + 0.21, z1);
    }
    // ---- portals: wide concrete faces with an arched opening, name boards, barriers in front
    const psegs = 16;
    for (const zz of [z0, z1]) {
      const face = zz === z0 ? -1 : 1;
      b.push([x, 0, zz - face * 0.1], 0);
      const top = y0 + height + 3.2;
      b.wall('concrete', -W - 8, W + 8, 0, 2.2, y0 - 1, top, [{ x: 0, w: TUNNEL.width, y0: y0 - 1, y1: y0 + WH }], 'concrete');
      for (let i = 0; i < psegs; i++) {
        const a = ((i + 0.5) / psegs) * Math.PI;
        const xx = Math.cos(a) * W, yy = Math.sin(a) * RY;
        b.box('concrete', xx - W / psegs - 0.05, y0 + WH + yy, -1.1, xx + W / psegs + 0.05, top, 1.1, 'concrete');
      }
      b.box('concrete', -W - 8.5, top, -1.4, W + 8.5, top + 0.5, 1.4, 'concrete');
      // name board on the outer face
      b.box('signBlue', -3.6, top - 2.2, face * 1.1, 3.6, top - 0.6, face * 1.16);
      b.addGeo('signTunnel', new THREE.PlaneGeometry(7.0, 1.4), new THREE.Matrix4().makeRotationY(face > 0 ? 0 : Math.PI).setPosition(0, top - 1.4, face * 1.17));
      b.pop();
      for (const sx of [-1, 1]) this.jersey(x + sx * 4.5, y0, zz + face * 7, 0.12 * sx);
      this.jersey(x + 9.5 * (face > 0 ? 1 : -1), y0, zz + face * 10, Math.PI / 2 + 0.3);
      this.lights.push({ pos: new THREE.Vector3(x, y0 + WH, zz - face * 3), color: 0xffa040, intensity: 18, dist: 18 });
    }
    // ---- cover in the bore: a broken median of barriers, abandoned and wrecked vehicles, roadworks
    for (const [zz, ox] of [[66.5, 0], [75.5, 0.25], [85.5, -0.25], [94.5, 0]] as const) this.jersey(x + ox, y0, zz, Math.PI / 2);
    this.car(x - 2.3, y0, 69.5, Math.PI / 2 + 0.42, 'carBurnt', true);
    this.car(x + 5.4, y0, 72.8, -Math.PI / 2 + 0.06, 'carRed');
    this.truck(x + 2.6, y0, 79.0, -Math.PI / 2 + 0.62);
    this.car(x - 5.5, y0, 88.6, Math.PI / 2 - 0.15, 'carBurnt', true);
    this.car(x + 2.1, y0, 92.6, -Math.PI / 2 - 0.3, 'carBlue');
    // roadworks on the west shoulder: barrier blocks and a pallet of cable drums
    for (const [zz, ox] of [[81.5, -5.8], [83.3, -5.6]] as const) {
      b.box('concrete', x + ox - 0.4, y0, zz - 0.8, x + ox + 0.4, y0 + 0.9, zz + 0.8, 'concrete');
      this.coverPoints.push(new THREE.Vector3(x + ox, y0, zz));
    }
    b.box('pallet', x - 4.7, y0, 77.0, x - 3.5, y0 + 0.15, 78.2, 'wood');
    b.cyl('woodRaw', x - 4.1, y0 + 0.15, 77.6, 0.55, 0.9, 14, 'wood');
    // traffic cones round the wreck
    for (const [cx, cz] of [[-0.8, 66.2], [-1.6, 67.0], [-2.4, 67.8], [3.2, 76.0], [4.0, 75.3], [-3.6, 84.6]] as const) {
      b.cyl('snowPole', x + cx, y0, cz, 0.17, 0.72, 10, null, 0.03);
      b.box('tyre', x + cx - 0.2, y0, cz - 0.2, x + cx + 0.2, y0 + 0.04, cz + 0.2);
    }
  }

  /** Box van / small lorry (cab + box body), for cover. */
  truck(x: number, y: number, z: number, rot: number) {
    const b = this.b;
    b.push([x, y, z], rot);
    b.box('steel', -3.4, 0.45, -1.05, 3.4, 0.7, 1.05, 'metal');
    b.box('contWhite', -3.4, 0.7, -1.2, 1.6, 3.3, 1.2, 'metal');
    b.box('carWhite', 1.75, 0.7, -1.15, 3.6, 2.3, 1.15, 'metal');
    b.box('carGlass', 3.1, 1.55, -1.05, 3.62, 2.2, 1.05);
    b.box('carWhite', 1.75, 2.3, -1.12, 3.0, 2.55, 1.12);
    for (const sx of [-2.4, -1.2, 2.7]) for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.48, 0.48, 0.3, 14);
      g.rotateX(Math.PI / 2);
      b.addGeo('tyre', g, new THREE.Matrix4().setPosition(sx, 0.48, sz * 0.98));
    }
    b.pop();
    this.coverPoints.push(new THREE.Vector3(x, y, z));
  }

  jersey(x: number, y: number, z: number, rot: number) {
    const b = this.b;
    b.push([x, y, z], rot);
    b.box('concrete', -1.6, 0, -0.32, 1.6, 0.25, 0.32, 'concrete');
    b.box('concrete', -1.6, 0.25, -0.2, 1.6, 0.85, 0.2, 'concrete');
    b.box('concrete', -1.6, 0.85, -0.12, 1.6, 0.95, 0.12, 'concrete');
    b.pop();
    this.coverPoints.push(new THREE.Vector3(x, y, z));
  }

  private docks() {
    const b = this.b;
    // boardwalk along the village shore
    const zs = [-46, 46];
    for (let z = zs[0]; z < zs[1]; z += 4) {
      const cx = coastX(z + 2);
      b.box('planks', cx - 2.5, 1.85, z, cx + 2.5, 2.0, z + 4, 'wood');
      for (const ox of [-2.3, 2.3]) b.cyl('woodRaw', cx + ox, -4, z + 2, 0.13, 5.85, 8, 'wood');
    }
    // piers with moored boats
    for (const pz of [-26, 2, 28]) {
      const cx = coastX(pz);
      b.box('planks', cx - 20, 1.75, pz - 1.5, cx - 2.5, 1.9, pz + 1.5, 'wood');
      for (let x = cx - 20; x < cx - 2; x += 3.5) for (const sz of [-1, 1]) b.cyl('woodRaw', x, -5, pz + sz * 1.4, 0.12, 6.9, 8, 'wood');
      for (let x = cx - 19; x < cx - 3; x += 6) b.cyl('steel', x, 1.9, pz + 1.3, 0.1, 0.35, 8);
      this.bld.boat(cx - 12, -0.3, pz + 4.2, Math.PI / 2 + 0.05, 2.2, true, this.rng.chance(0.5) ? 'white' : 'red');
      if (this.rng.chance(0.7)) this.bld.boat(cx - 9, -0.15, pz - 3.6, Math.PI / 2 - 0.08, 1.0, false, 'white');
      this.bld.nav.push({ a: new THREE.Vector3(cx + 3, 2.0, pz), b: new THREE.Vector3(cx - 16, 1.9, pz) });
      // crates, fish boxes, buoys, nets and rope on the piers
      b.box('crate', cx - 15, 1.9, pz - 1.2, cx - 14, 2.6, pz - 0.4, 'wood');
      for (let k = 0; k < 3; k++) b.box(k % 2 ? 'fishCrate' : 'fishCrateRed', cx - 8, 1.9 + k * 0.32, pz + 0.3, cx - 7.2, 2.2 + k * 0.32, pz + 1.1, k === 0 ? 'metal' : null);
      b.cyl('buoy', cx - 11, 1.9, pz - 1.0, 0.2, 0.42, 12);
      b.cyl('buoy', cx - 10.5, 1.9, pz - 0.95, 0.16, 0.34, 12);
      b.box('net', cx - 18.5, 1.9, pz - 1.3, cx - 16.4, 2.15, pz + 0.2, 'fabric', { penetrable: 2 });
      const coil = new THREE.TorusGeometry(0.3, 0.05, 6, 14);
      coil.rotateX(Math.PI / 2);
      b.addGeo('rope', coil, new THREE.Matrix4().setPosition(cx - 5, 1.95, pz - 0.8));
      b.addGeo('rope', coil.clone(), new THREE.Matrix4().setPosition(cx - 5, 2.02, pz - 0.8));
    }
    // beached rowboats
    for (const [x, z, r] of [[-93, 52, 0.4], [-95, 60, -0.2], [-94, -56, 1.2]] as const) this.bld.boat(x, this.h(x, z) + 0.05, z, r, 0.85, false, 'red');
  }

  private quay() {
    const b = this.b;
    // west quay face
    for (let z = 98; z < 184; z += 4) {
      const xa = coastX(z), xb = coastX(z + 4);
      const cx = (xa + xb) / 2;
      b.box('concrete', cx - 1.0, -4, z, cx + 0.3, 2.45, z + 4.05, 'concrete');
      if (Math.round(z) % 12 === 2) b.cyl('steel', cx - 0.4, 2.45, z + 2, 0.18, 0.5, 10, 'metal');
      if (Math.round(z) % 8 === 2) b.cyl('tyre', cx - 1.15, 0.6, z + 1, 0.4, 0.3, 12);
    }
    // south quay face
    for (let x = coastX(184) + 0.5; x < 96; x += 4) {
      const za = southCoastZ(x), zb = southCoastZ(x + 4);
      const cz = (za + zb) / 2;
      b.box('concrete', x, -4, cz - 0.3, x + 4.05, 2.45, cz + 1.0, 'concrete');
      if (Math.round(x) % 12 === 0) b.cyl('steel', x + 2, 2.45, cz + 0.4, 0.18, 0.5, 10, 'metal');
    }
    // trawler at the quay
    this.bld.boat(coastX(126) - 6.5, -1.6, 126, Math.PI / 2, 4.2, true, 'red');
  }

  car(x: number, y: number, z: number, rot: number, paint: string, wreck = false) {
    const b = this.b;
    this.carCount++;
    b.push([x, y, z], rot);
    const L = 4.6, W = 1.8;
    // body
    b.box(paint, -L / 2, 0.32, -W / 2, L / 2, 0.95, W / 2, 'metal');
    b.box(paint, -L / 2 + 0.25, 0.95, -W / 2 + 0.08, L / 2 - 1.25, 1.02, W / 2 - 0.08);
    // cabin (estate shape) with glass
    b.box(wreck ? 'carBurnt' : 'carGlass', -L / 2 + 0.25, 1.0, -W / 2 + 0.12, L / 2 - 1.35, 1.48, W / 2 - 0.12, 'metal');
    b.box(paint, -L / 2 + 0.2, 1.48, -W / 2 + 0.1, L / 2 - 1.45, 1.55, W / 2 - 0.1);
    b.obox(wreck ? 'carBurnt' : 'carGlass', [L / 2 - 1.1, 1.22, 0], [0.62, 0.05, W - 0.3], new THREE.Euler(0, 0, -0.85));
    // wheels
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14);
      g.rotateX(Math.PI / 2);
      b.addGeo('tyre', g, new THREE.Matrix4().setPosition(sx * (L / 2 - 0.8), 0.34, sz * (W / 2 - 0.05)));
    }
    // lights
    if (!wreck) {
      for (const sz of [-1, 1]) {
        b.box('lamp', L / 2 - 0.02, 0.72, sz * 0.62 - 0.14, L / 2 + 0.01, 0.84, sz * 0.62 + 0.14);
        b.box('tail', -L / 2 - 0.01, 0.75, sz * 0.66 - 0.12, -L / 2 + 0.02, 0.88, sz * 0.66 + 0.12);
      }
    }
    b.pop();
    this.coverPoints.push(new THREE.Vector3(x, y, z));
  }

  sandbags(x: number, z: number, rot: number, len: number, rows = 3) {
    const b = this.b;
    const y = this.h(x, z);
    b.push([x, y - 0.05, z], rot);
    for (let r = 0; r < rows; r++) {
      for (let i = -len / 2; i < len / 2 - 0.3; i += 0.55) {
        const o = (r % 2) * 0.27;
        b.box('sandbag', i + o, r * 0.24, -0.25, i + o + 0.52, r * 0.24 + 0.24, 0.25);
      }
    }
    b.box(null, -len / 2, 0, -0.3, len / 2, rows * 0.24, 0.3, 'fabric', { penetrable: 0.6 });
    b.pop();
    this.coverPoints.push(new THREE.Vector3(x, y, z));
  }

  lampAnchors: THREE.Vector3[] = [];
  /** street lamp heads (the emissive panel) for shooting them out */
  lampHeads: { m: THREE.Matrix4; min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  private lamp(x: number, z: number, rot: number) {
    const b = this.b;
    const y = this.h(x, z);
    b.cyl('steel', x, y, z, 0.09, 6.5, 8, 'metal', 0.06);
    b.push([x, y + 6.4, z], rot);
    this.lampAnchors.push(new THREE.Vector3(1.45, -0.35, 0).applyMatrix4(b.m));
    b.box('steel', 0, -0.05, -0.04, 1.5, 0.05, 0.04);
    b.box('steel', 1.2, -0.12, -0.15, 1.7, 0.0, 0.15);
    b.box('lamp', 1.25, -0.14, -0.12, 1.65, -0.12, 0.12);
    this.lampHeads.push({ m: b.m.clone(), min: new THREE.Vector3(1.22, -0.16, -0.15), max: new THREE.Vector3(1.68, 0.0, 0.15) });
    b.pop();
  }

  /** Is (x,z) a sensible spot for static cover (dry land, off roads, outside buildings)? */
  private pendingFootprints: THREE.Box3[] = [];
  private coverOk(x: number, z: number, margin = 1.5) {
    if (this.h(x, z) < 1.0) return false;
    const r = nearestRoad(x, z);
    if (r.d < r.road.width / 2 + margin) return false;
    return !this.bld.footprints.some((f) => x > f.min.x - margin && x < f.max.x + margin && z > f.min.z - margin && z < f.max.z + margin);
  }

  /** Low dry-stone wall following the ground in short sections (gaps where it meets a road/building). */
  private stoneWall(x0: number, z0: number, x1: number, z1: number) {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(L / 1.6));
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (!this.coverOk(x, z) || this.rng.chance(0.06)) continue; // tumbled gaps
      const y = this.h(x, z);
      const hgt = 0.95 + this.rng.range(-0.12, 0.12);
      this.b.obox('stone', [x, y + hgt / 2 - 0.15, z], [0.75, hgt + 0.3, L / n + 0.06], new THREE.Euler(0, yaw, 0), 'rock');
      // capstones
      if (this.rng.chance(0.7)) this.b.obox('stone', [x + this.rng.range(-0.1, 0.1), y + hgt + 0.08, z], [0.6, 0.18, L / n * this.rng.range(0.5, 0.9)], new THREE.Euler(0, yaw + this.rng.range(-0.2, 0.2), 0));
    }
  }

  /** A cluster of glacial erratics: chest-high cover with a full-height block in the middle. */
  private boulders(cx: number, cz: number, n: number) {
    // keep trees from growing through the rocks (vegetation skips building footprints)
    const y0 = this.h(cx, cz);
    this.pendingFootprints.push(new THREE.Box3(new THREE.Vector3(cx - 5, y0 - 5, cz - 5), new THREE.Vector3(cx + 5, y0 + 10, cz + 5)));
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2), r = i === 0 ? 0 : this.rng.range(1.8, 3.6);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!this.coverOk(x, z, 2)) continue;
      const y = this.h(x, z);
      const s = i === 0 ? this.rng.range(1.6, 2.2) : this.rng.range(0.9, 1.4);
      const g = new THREE.DodecahedronGeometry(s, 1);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        const vx = pos.getX(k), vy = pos.getY(k), vz = pos.getZ(k);
        const j = 1 + 0.12 * Math.sin(vx * 3.1 + vz * 2.3 + i) * Math.cos(vy * 2.7);
        pos.setXYZ(k, vx * j * 1.15, vy * j * 0.72, vz * j);
      }
      g.computeVertexNormals();
      const rot = this.rng.range(0, Math.PI);
      this.b.addGeo('boulder', g, new THREE.Matrix4().makeRotationY(rot).setPosition(x, y + s * 0.45, z));
      this.b.obox(null, [x, y + s * 0.4, z], [s * 1.7, s * 1.15, s * 1.5], new THREE.Euler(0, rot, 0), 'rock');
    }
  }

  private props(mats: Record<string, THREE.Material>) {
    // cars
    const paints = ['carRed', 'carBlue', 'carWhite', 'carGrey', 'carGreen', 'carBlack'];
    const carSpots: [number, number, number][] = [
      [-8, 31, 0.0], [-8, 35, 0.05], [5, 12, Math.PI / 2 + 0.1], [-4, -14, -Math.PI / 2], [26, -20, 1.4], [-30, 2, 0.02],
      [52, 112, 0.0], [56, 115, 0.03], [-20, 113, 3.12], [12, 146, 0.8], [38, -10, 0.4], [-45, 8, 3.1], [104, -2, 1.1], [3, 104, -1.45],
    ];
    for (const [x, z, r] of carSpots) this.car(x, this.h(x, z), z, r, this.rng.pick(paints));
    this.car(-2.2, this.h(-2.2, 50), 50, 1.2, 'carBurnt', true);
    // checkpoint near the bridge & tunnel
    this.sandbags(5, -60, 0.1, 4);
    this.sandbags(-5, -58, -0.2, 3);
    this.jersey(-3, this.h(-3, -100), -100, 0.3);
    this.jersey(3.5, this.h(3.5, -102), -102, -0.2);
    // fort perimeter: sandbag nests
    for (const [x, z, r, l] of [[20, -128, 0.5, 4], [44, -122, -0.2, 5], [62, -142, 1.2, 4], [28, -150, 1.6, 3], [40, -168, 0.1, 5], [-2, -120, 1.3, 3]] as const) this.sandbags(x, z, r, l);
    // field cover: dry-stone walls (steingarder) and boulder clusters across the open ground
    // between village, farm and fort so long sightlines always have something to move between
    const walls: [number, number, number, number][] = [
      [52, -40, 78, -34], [60, -10, 62, 18], [70, 30, 92, 40], [128, -2, 132, 34], [100, -48, 126, -40],
      [22, -60, 30, -84], [50, -66, 66, -88], [-30, -70, -12, -78], [-62, -20, -64, 8], [-60, 40, -44, 62],
      [80, -100, 96, -118], [-20, -100, -8, -112], [30, 70, 52, 78], [-36, 82, -20, 96], [110, 60, 118, 84],
    ];
    for (const [x0, z0, x1, z1] of walls) this.stoneWall(x0, z0, x1, z1);
    const boulders: [number, number, number][] = [
      [70, -20, 3], [88, -60, 4], [40, -100, 3], [6, -112, 3], [-38, -88, 2], [-50, 24, 3], [64, 62, 3], [92, 70, 2],
      [118, 10, 3], [140, -70, 3], [-70, -76, 2], [26, -96, 2], [72, -84, 3], [104, 46, 2], [-28, 66, 2],
    ];
    for (const [x, z, n] of boulders) this.boulders(x, z, n);
    this.bld.footprints.push(...this.pendingFootprints);
    // village lamps
    for (let z = -55; z <= 55; z += 22) this.lamp(-4.5, z, 0);
    for (let x = -60; x <= 60; x += 24) this.lamp(x, 1, -Math.PI / 2);
    // harbour lamps (tall)
    for (const [x, z] of [[-60, 120], [-20, 120], [20, 125], [-70, 175], [10, 178]] as const) this.lamp(x, z, Math.PI / 4);
    // pallets & barrels around the harbour
    for (let i = 0; i < 30; i++) {
      const x = this.rng.range(-85, 80), z = this.rng.range(104, 178);
      // keep clutter out of every building footprint (+ a doorway margin) so it never plugs an entrance
      if (this.bld.footprints.some((f) => x > f.min.x - 2 && x < f.max.x + 2 && z > f.min.z - 2 && z < f.max.z + 2)) continue;
      const y = this.h(x, z);
      if (this.rng.chance(0.5)) this.b.box('pallet', x - 0.6, y, z - 0.6, x + 0.6, y + 0.15 + this.rng.range(0.2, 1.2), z + 0.6, 'wood');
      else for (let k = 0; k < this.rng.int(1, 4); k++) this.b.cyl(this.rng.chance(0.5) ? 'redSteel' : 'contBlue', x + k * 0.65, y, z, 0.3, 0.9, 12, 'metal');
    }
    // power line poles along Strandvegen
    const poles: THREE.Vector3[] = [];
    for (let x = -88; x < 180; x += 38) {
      const z = 12 + Math.sin(x * 0.05) * 2;
      const y = this.h(x, z);
      this.b.cyl('woodRaw', x, y, z, 0.13, 9, 8, 'wood', 0.1);
      this.b.box('woodRaw', x - 0.9, y + 8.3, z - 0.06, x + 0.9, y + 8.45, z + 0.06);
      poles.push(new THREE.Vector3(x, y + 8.4, z));
    }
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
    for (const off of [-0.8, 0, 0.8]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < poles.length - 1; i++) {
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          const p = poles[i].clone().lerp(poles[i + 1], t);
          p.x += off;
          p.y -= Math.sin(t * Math.PI) * 0.9;
          pts.push(p);
        }
      }
      this.parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
    // Norwegian flags (church & fort)
    for (const [x, z, h] of [[34, -28, 11], [44, -136, 9], [60, 134, 10]] as const) {
      const y = this.h(x, z);
      this.b.cyl('white', x, y, z, 0.07, h, 8, 'metal', 0.045);
      this.flag(new THREE.Vector3(x, y + h - 0.1, z));
    }
    void mats;
  }

  private flag(top: THREE.Vector3) {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 160;
    const x = c.getContext('2d')!;
    x.fillStyle = '#ba0c2f'; x.fillRect(0, 0, 220, 160);
    x.fillStyle = '#fff'; x.fillRect(60, 0, 40, 160); x.fillRect(0, 60, 220, 40);
    x.fillStyle = '#00205b'; x.fillRect(70, 0, 20, 160); x.fillRect(0, 70, 220, 20);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.PlaneGeometry(2.2, 1.6, 16, 8);
    g.translate(1.1, -0.8, 0);
    const m = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = { value: 0 };
      m.userData.shader = sh;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float k = position.x / 2.2;
        transformed.z += sin(position.x * 3.0 - uTime * 6.0) * 0.18 * k + sin(position.y * 2.0 + uTime * 3.0) * 0.06 * k;
        transformed.y -= k * k * 0.15;`,
      );
    };
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(top);
    mesh.rotation.y = -0.6;
    mesh.castShadow = true;
    this.parent.add(mesh);
    this.flags.push(mesh);
  }

  update(t: number) {
    for (const f of this.flags) {
      const sh = (f.material as THREE.Material).userData.shader;
      if (sh) sh.uniforms.uTime.value = t;
    }
  }
}
