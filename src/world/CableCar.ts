import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Physics } from '../core/Physics';
import type { Terrain } from './Terrain';
import type { CharacterBody } from '../player/CharacterBody';

/**
 * Linbanen (Update 35): an aerial tramway across the sound with two cabins on parallel tracks that
 * run in opposite directions on a fixed timetable — dwell at the station, ride across, dwell at the far
 * end; both ends are open doorways (no doors). There is nothing to press: walk in
 * and stand (or walk about, crouch, shoot out of the open upper windows); anyone inside is carried
 * with the cabin.
 *
 * The track is a polyline over support towers that are placed automatically wherever the terrain
 * would come within CLEAR m of the cabin floor, so the cabin never touches the ground. The cabin's
 * colliders are parentless boxes moved every frame (scene queries refreshed, no physics step).
 */
const HANG = 5.0; // cable above the cabin floor
const CL = 4.6; // cabin length (along the track)
const CW = 2.6; // cabin width
const CH = 2.35; // inside height
const CLEAR = 3.0; // terrain clearance under the cabin floor
const SPEED = 7; // m/s
const DWELL = 11; // s at each station
const TRACK = 2.4; // half the distance between the two tracks

export interface Rider { body: CharacterBody }

interface Cabin {
  group: THREE.Group;
  side: -1 | 1;
  colliders: { c: ReturnType<Physics['addBox']>; lp: THREE.Vector3; door?: 0 | 1 }[];
  pos: THREE.Vector3;
  yaw: number;
  /** progress along the track 0..L, and where it is heading */
  s: number;
  from: 0 | 1;
  t: number;
  moving: boolean;
}

export class CableCar {
  group = new THREE.Group();
  /** cable polyline (centre line between the two tracks), cumulative lengths */
  path: THREE.Vector3[] = [];
  private cum: number[] = [];
  length = 0;
  cabins: Cabin[] = [];
  /** station deck centres (for the map / bots) */
  stations: THREE.Vector3[] = [];
  private time = 0;

  constructor(private physics: Physics, private terrain: Terrain, a: [number, number], b: [number, number], mats: Record<string, THREE.Material>) {
    this.group.name = 'cablecar';
    const top = (x: number, z: number) => terrain.topAt(x, z);
    const A = new THREE.Vector3(a[0], top(a[0], a[1]) + 0.35 + HANG, a[1]);
    const B = new THREE.Vector3(b[0], top(b[0], b[1]) + 0.35 + HANG, b[1]);
    // towers: split any span where the ground (with the cabin and a margin) comes up to the cable
    const need = (x: number, z: number) => top(x, z) + CLEAR + HANG;
    const pts: THREE.Vector3[] = [A, B];
    for (let pass = 0; pass < 8; pass++) {
      let worst = 0, wi = -1, wp: THREE.Vector3 | null = null;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        for (let d = 8; d < L - 8; d += 2) {
          const t = d / L;
          const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
          // check under both tracks
          const nx = -(q.z - p.z) / L, nz = (q.x - p.x) / L;
          const req = Math.max(need(x + nx * TRACK, z + nz * TRACK), need(x - nx * TRACK, z - nz * TRACK), need(x, z));
          const y = p.y + (q.y - p.y) * t;
          if (req - y > worst) {
            worst = req - y;
            wi = i;
            wp = new THREE.Vector3(x, req + 2, z);
          }
        }
      }
      if (!wp || worst < 0.01) break;
      pts.splice(wi + 1, 0, wp);
    }
    this.path = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.length = this.cum[this.cum.length - 1];
    this.buildLine(mats);
    // two cabins: one at each end, counter-running
    for (const side of [-1, 1] as const) this.cabins.push(this.makeCabin(side, side < 0 ? 0 : 1, mats));
    for (const c of this.cabins) this.place(c, c.from === 0 ? 0 : this.length, true);
  }

  /** point on the cable centre line at distance s, and the horizontal travel direction */
  private at(s: number, out = new THREE.Vector3()) {
    s = Math.max(0, Math.min(this.length, s));
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] < s) i++;
    const p = this.path[i], q = this.path[i + 1];
    const t = (s - this.cum[i]) / Math.max(1e-6, this.cum[i + 1] - this.cum[i]);
    out.copy(p).lerp(q, t);
    // a gentle sag between towers
    out.y -= Math.sin(t * Math.PI) * Math.min(2.5, (this.cum[i + 1] - this.cum[i]) * 0.012);
    return out;
  }
  private dirAt(s: number) {
    const a = this.at(s - 1), b = this.at(s + 1);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  private buildLine(mats: Record<string, THREE.Material>) {
    const steel = (mats.steel as THREE.Material) ?? new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.6 });
    const geos: THREE.BufferGeometry[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
      const L = a.distanceTo(b);
      const g = new THREE.BoxGeometry(w, w, L);
      g.applyMatrix4(new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0)).setPosition(a.clone().lerp(b, 0.5)));
      geos.push(g);
    };
    // cables: two per track, sampled so the sag shows
    const N = Math.ceil(this.length / 6);
    for (const side of [-1, 1]) for (const off of [-0.22, 0.22]) {
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * this.length;
        const p = this.at(s), yaw = this.dirAt(s);
        const lat = side * TRACK + off;
        p.x += Math.cos(yaw) * lat;
        p.z -= Math.sin(yaw) * lat;
        if (prev) seg(prev, p, 0.045);
        prev = p;
      }
    }
    // towers (every intermediate point): two tapering legs, a cross-beam and saddles
    for (let i = 1; i < this.path.length - 1; i++) {
      const p = this.path[i];
      const yaw = this.dirAt(this.cum[i]);
      const g = this.terrain.topAt(p.x, p.z) - 0.5;
      for (const side of [-1, 1]) {
        const footX = p.x + Math.cos(yaw) * side * (TRACK + 1.4), footZ = p.z - Math.sin(yaw) * side * (TRACK + 1.4);
        const headX = p.x + Math.cos(yaw) * side * (TRACK + 0.4), headZ = p.z - Math.sin(yaw) * side * (TRACK + 0.4);
        seg(new THREE.Vector3(footX, this.terrain.topAt(footX, footZ) - 0.5, footZ), new THREE.Vector3(headX, p.y + 0.6, headZ), 0.5);
      }
      for (let y = g + 6; y < p.y - 2; y += 7) {
        const k = (y - g) / (p.y - g);
        const w = TRACK + 1.4 - k;
        seg(new THREE.Vector3(p.x - Math.cos(yaw) * w, y, p.z + Math.sin(yaw) * w), new THREE.Vector3(p.x + Math.cos(yaw) * w, y, p.z - Math.sin(yaw) * w), 0.22);
      }
      seg(new THREE.Vector3(p.x - Math.cos(yaw) * (TRACK + 1.2), p.y + 0.5, p.z + Math.sin(yaw) * (TRACK + 1.2)), new THREE.Vector3(p.x + Math.cos(yaw) * (TRACK + 1.2), p.y + 0.5, p.z - Math.sin(yaw) * (TRACK + 1.2)), 0.45);
      this.physics.addBox(new THREE.Vector3(p.x, (g + p.y) / 2, p.z), new THREE.Vector3(0.6, (p.y - g) / 2, 0.6), null, { surface: 'metal' });
    }
    // stations: a deck at cabin-floor level beyond each end, a roof, the bull-wheel frame, railings
    // (geometry gathered per material and merged: one draw call per material, not one per box)
    const stationGeo = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const addStation = (g: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4) => {
      g.applyMatrix4(m);
      if (!stationGeo.has(mat)) stationGeo.set(mat, []);
      stationGeo.get(mat)!.push(g);
    };
    for (const end of [0, 1] as const) {
      const s = end === 0 ? 0 : this.length;
      const c = this.at(s);
      const yaw = this.dirAt(s);
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(end === 0 ? -1 : 1);
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const floorY = c.y - HANG;
      // the deck: from the cabin's door outwards, across both tracks
      const deckC = c.clone().addScaledVector(fwd, CL / 2 + 2.6).setY(floorY - 0.15);
      const ground = this.terrain.topAt(deckC.x, deckC.z);
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const box = (center: THREE.Vector3, sx: number, sy: number, sz: number, mat: THREE.Material, collide = true) => {
        addStation(new THREE.BoxGeometry(sx, sy, sz), mat, new THREE.Matrix4().compose(center, rot, new THREE.Vector3(1, 1, 1)));
        if (collide) this.physics.addBox(center, new THREE.Vector3(sx / 2, sy / 2, sz / 2), rot, { surface: 'metal' });
      };
      const conc = (mats.concrete as THREE.Material) ?? steel;
      box(deckC, TRACK * 2 + CW + 2, 0.3, 5.2, conc);
      // its plinth down to the ground
      const plinthH = Math.max(0.3, floorY - 0.3 - ground + 1);
      box(deckC.clone().setY(floorY - 0.3 - plinthH / 2), TRACK * 2 + CW + 1.6, plinthH, 4.8, (mats.stone as THREE.Material) ?? conc);
      // the cabin berths: a deck under each parked cabin so you can walk round it
      box(c.clone().setY(floorY - 0.45), TRACK * 2 + CW + 2, 0.3, CL + 0.4, conc, false);
      // railings on the outer sides and the far end (open towards the cabins and the land side steps)
      const railM = steel;
      for (const sd of [-1, 1]) box(deckC.clone().addScaledVector(right, sd * (TRACK + CW / 2 + 0.95)).setY(floorY + 0.55), 0.08, 1.1, 5.0, railM);
      // roof on four posts, the bull-wheel frame above the cable ends
      for (const sd of [-1, 1]) for (const fz of [-1, 1]) box(deckC.clone().addScaledVector(right, sd * (TRACK + CW / 2 + 0.8)).addScaledVector(fwd, fz * 2.3).setY(floorY + 1.6), 0.25, 3.2, 0.25, steel);
      box(deckC.clone().setY(floorY + 3.3), TRACK * 2 + CW + 2.4, 0.25, 6.0, (mats.roofMetal as THREE.Material) ?? steel, false);
      addStation(new THREE.CylinderGeometry(TRACK + 0.3, TRACK + 0.3, 0.3, 24), steel, new THREE.Matrix4().setPosition(c.clone().addScaledVector(fwd, 1.5)));
      box(c.clone().addScaledVector(fwd, 1.5).setY(c.y - 1.6), 0.5, 3.4, 0.5, steel, false);
      // steps from the ground up to a raised deck
      if (floorY - ground > 0.5) {
        const n = Math.ceil((floorY - ground) / 0.18);
        for (let k = 0; k < n; k++) {
          const y = floorY - (k + 1) * 0.18;
          box(deckC.clone().addScaledVector(fwd, 2.6 + 0.15 + k * 0.3).setY(y - 0.09), 2.0, 0.18 + (k === n - 1 ? 0.4 : 0), 0.3, conc);
        }
      }
      this.stations.push(deckC.clone().setY(floorY));
    }
    for (const [mat, list] of stationGeo) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    }
    if (geos.length) {
      const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
        for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
        return g;
      }));
      if (merged) {
        const m = new THREE.Mesh(merged, steel);
        m.castShadow = true;
        this.group.add(m);
      }
    }
  }

  private makeCabin(side: -1 | 1, from: 0 | 1, mats: Record<string, THREE.Material>): Cabin {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xc0281e, roughness: 0.4, metalness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.5 });
    const steel = (mats.steel as THREE.Material) ?? dark;
    const glass = new THREE.MeshStandardMaterial({ color: 0x24343c, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.32, depthWrite: false });
    const floorM = (mats.steelGrate as THREE.Material) ?? dark;
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (m: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      geo.translate(x, y, z);
      if (!parts.has(m)) parts.set(m, []);
      parts.get(m)!.push(geo.index ? geo.toNonIndexed() : geo);
    };
    const B = (m: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => add(m, new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const hx = CW / 2, hz = CL / 2;
    // floor, skirt, roof with a rounded crown
    B(floorM, -hx, -0.12, -hz, hx, 0, hz);
    B(red, -hx - 0.05, -0.45, -hz - 0.05, hx + 0.05, -0.12, hz + 0.05);
    B(red, -hx - 0.05, CH, -hz - 0.05, hx + 0.05, CH + 0.14, hz + 0.05);
    const crown = new THREE.CylinderGeometry(hx * 0.9, hx * 0.9, CL, 16, 1, false, -Math.PI / 2, Math.PI);
    crown.rotateX(Math.PI / 2);
    crown.scale(1, 0.32, 1);
    add(red, crown, 0, CH + 0.14, 0);
    // long sides: red waist panels to 1.0 m, corner posts, open window band above (shoot out), glass upper strips
    for (const sx of [-1, 1]) {
      B(red, sx * hx - 0.04, 0, -hz, sx * hx + 0.04, 1.0, hz);
      for (let k = -2; k <= 2; k++) B(red, sx * hx - 0.05, 1.0, k * (CL / 4) - 0.06, sx * hx + 0.05, CH, k * (CL / 4) + 0.06);
      B(glass, sx * hx - 0.01, 1.85, -hz, sx * hx + 0.01, CH, hz);
      B(steel, sx * (hx - 0.12) - 0.02, 0.95, -hz + 0.2, sx * (hx - 0.12) + 0.02, 1.0, hz - 0.2); // inner handrail
    }
    // ends: panels either side of a door opening, a lintel, glass above
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) B(red, sx * 0.65, 0, sz * hz - 0.04, sx * hx, CH, sz * hz + 0.04);
      B(red, -0.65, 2.0, sz * hz - 0.04, 0.65, CH, sz * hz + 0.04);
      B(glass, -hx, 1.2, sz * (hz + 0.02) - 0.01, -0.65, 1.95, sz * (hz + 0.02) + 0.01);
      B(glass, 0.65, 1.2, sz * (hz + 0.02) - 0.01, hx, 1.95, sz * (hz + 0.02) + 0.01);
    }
    // bench along one side, ceiling light
    B(steel, side * (hx - 0.45), 0.42, -hz + 0.5, side * (hx - 0.05), 0.48, hz - 0.5);
    B((mats.bulbCool as THREE.Material) ?? glass, -0.3, CH - 0.04, -0.6, 0.3, CH - 0.01, 0.6);
    // hanger and carriage on the cable
    B(dark, -0.08, CH + 0.4, -0.08, 0.08, HANG - 0.35, 0.08);
    B(dark, -0.6, HANG - 0.35, -0.1, 0.6, HANG - 0.2, 0.1);
    B(dark, -0.15, HANG - 0.3, -1.2, 0.15, HANG - 0.05, 1.2);
    for (const wz of [-0.9, 0.9]) {
      const w = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 14);
      w.rotateZ(Math.PI / 2);
      add(steel, w, 0, HANG - 0.02, wz);
    }
    for (const [m, list] of parts) {
      const mg = mergeGeometries(list, false);
      if (!mg) continue;
      const mesh = new THREE.Mesh(mg, m);
      mesh.castShadow = m !== glass;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    this.group.add(g);
    // colliders in the cabin frame (lp = local centre), door colliders flagged by end
    const cols: Cabin['colliders'] = [];
    const C = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, door?: 0 | 1) => {
      const c = this.physics.addBox(new THREE.Vector3(0, -500, 0), new THREE.Vector3(sx / 2, sy / 2, sz / 2), null, { surface: 'metal' });
      cols.push({ c, lp: new THREE.Vector3(lx, ly, lz), door });
    };
    C(0, -0.1, 0, CW, 0.2, CL);
    C(0, CH + 0.1, 0, CW, 0.25, CL);
    for (const sx of [-1, 1]) C(sx * hx, 0.5, 0, 0.1, 1.0, CL); // waist panels (open above)
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) C(sx * (hx + 0.65) / 2, CH / 2, sz * hz, hx - 0.65, CH, 0.1);
      C(0, 2.0 + (CH - 2.0) / 2, sz * hz, 1.3, CH - 2.0, 0.1);
    }
    return { group: g, side, colliders: cols, pos: new THREE.Vector3(), yaw: 0, s: 0, from, t: Math.random() * 3, moving: false };
  }

  /** set a cabin's pose at s; returns the carry (delta position, delta yaw) */
  private place(c: Cabin, s: number, first = false) {
    const p = this.at(s);
    const yaw = this.dirAt(s);
    p.x += Math.cos(yaw) * c.side * TRACK;
    p.z -= Math.sin(yaw) * c.side * TRACK;
    p.y -= HANG;
    const d = p.clone().sub(c.pos), dyaw = first ? 0 : yaw - c.yaw;
    c.pos.copy(p);
    c.yaw = yaw;
    c.s = s;
    c.group.position.copy(p);
    c.group.rotation.y = yaw;
    c.group.updateMatrixWorld(true);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const col of c.colliders) {
      const w = col.lp.clone().applyQuaternion(q).add(p);
      col.c.setTranslation({ x: w.x, y: w.y, z: w.z });
      col.c.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    return { d, dyaw, center: p };
  }

  /** Is a body standing in a cabin (local box test)? */
  private inside(c: Cabin, pos: THREE.Vector3) {
    const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z, dy = pos.y - c.pos.y;
    const cs = Math.cos(-c.yaw), sn = Math.sin(-c.yaw);
    const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
    return Math.abs(lx) < CW / 2 + 0.15 && Math.abs(lz) < CL / 2 + 0.1 && dy > -0.35 && dy < CH;
  }

  /** Advance the timetable, move the cabins and carry whoever is inside. */
  update(dt: number, riders: Rider[]) {
    this.time += dt;
    const travel = this.length / SPEED + 6;
    for (const c of this.cabins) {
      c.t += dt;
      const was = c.moving;
      let s: number;
      if (c.t < DWELL) {
        c.moving = false;
        s = c.from === 0 ? 0 : this.length;
      } else {
        const u = Math.min(1, (c.t - DWELL) / travel);
        const e = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: gentle start and arrival
        c.moving = u < 1;
        s = c.from === 0 ? e * this.length : (1 - e) * this.length;
        if (u >= 1) {
          c.from = c.from === 0 ? 1 : 0;
          c.t = 0;
          c.moving = false;
        }
      }
      // who is aboard (tested at the old pose), then move and carry them
      const aboard = riders.filter((r) => this.inside(c, r.body.pos));
      const mv = this.place(c, s);
      if (aboard.length && (mv.d.lengthSq() > 0 || mv.dyaw !== 0)) {
        for (const r of aboard) {
          const p = r.body.pos.clone().sub(mv.center).add(mv.d); // relative to the old centre (= new centre − delta)
          p.applyAxisAngle(new THREE.Vector3(0, 1, 0), mv.dyaw);
          r.body.teleport(p.add(mv.center).setY(r.body.pos.y + mv.d.y));
        }
      }
      void was;
    }
    this.physics.world.updateSceneQueries();
  }

  /** riding? (the HUD can show the line name) */
  aboard(pos: THREE.Vector3) {
    return this.cabins.some((c) => this.inside(c, pos));
  }
}
