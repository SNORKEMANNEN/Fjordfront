import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';

/**
 * Baked ambient occlusion for the static world (Update 33).
 *
 * Every static mesh from the GeoBuilders gets a per-vertex `aWeather` attribute:
 *   x = occlusion 0..1 — how much of the hemisphere above the surface is blocked by other solid
 *       boxes (or the ground) within ~1 m: corners, under tables, wall/floor seams, the foot of walls
 *   y = ground proximity 0..1 — 1 at the terrain, 0 from 1.3 m up (grime / moss splash zone)
 * The world shader (Snow.ts) darkens indirect light by x and uses y for weathering, so the
 * screen-space AO pass can stay cheap. The bake runs in small time slices after the map is up
 * (vertices shared by several triangles are computed once).
 */
type Occ = { inv: THREE.Matrix4; min: THREE.Vector3; max: THREE.Vector3 };
const CELL = 1.5;

export class BakedAO {
  private grid = new Map<number, Occ[]>();
  private queue: THREE.Mesh[] = [];
  private cur: { mesh: THREE.Mesh; i: number; out: Uint8Array; cache: Map<string, number> } | null = null;
  done = false;
  /** vertices baked so far (stats) */
  count = 0;
  private v = new THREE.Vector3();
  private q = new THREE.Vector3();
  private n = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();

  constructor(private heightAt: (x: number, z: number) => number) {
    for (const b of GeoBuilder.registry) {
      for (const o of b.occ) {
        const x0 = Math.floor(o.min.x / CELL), x1 = Math.floor(o.max.x / CELL);
        const y0 = Math.floor(o.min.y / CELL), y1 = Math.floor(o.max.y / CELL);
        const z0 = Math.floor(o.min.z / CELL), z1 = Math.floor(o.max.z / CELL);
        // (huge boxes — foundations, long walls — are still only a few dozen cells)
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) continue;
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          const k = this.key(x, y, z);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(o);
        }
      }
      for (const m of b.meshes) if (!m.geometry.getAttribute('aWeather')) this.queue.push(m);
    }
    if (!this.queue.length) this.done = true;
  }

  private key(x: number, y: number, z: number) {
    return ((x + 1024) * 2048 + (z + 1024)) * 256 + (y + 64);
  }

  private solid(p: THREE.Vector3) {
    if (p.y < this.heightAt(p.x, p.z)) return true;
    const l = this.grid.get(this.key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    if (!l) return false;
    for (const o of l) {
      if (p.x < o.min.x || p.x > o.max.x || p.y < o.min.y || p.y > o.max.y || p.z < o.min.z || p.z > o.max.z) continue;
      const e = o.inv.elements;
      const lx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
      if (lx < -0.5 || lx > 0.5) continue;
      const ly = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
      if (ly < -0.5 || ly > 0.5) continue;
      const lz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
      if (lz < -0.5 || lz > 0.5) continue;
      return true;
    }
    return false;
  }

  /** occlusion (0..255) and ground proximity (0..255) for a surface point */
  private sample(p: THREE.Vector3, n: THREE.Vector3): [number, number] {
    // tangent frame
    this.t1.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    this.t2.crossVectors(n, this.t1);
    let hits = 0, total = 0;
    for (const r of [0.28, 0.75]) {
      for (let k = 0; k < 5; k++) {
        const d = this.q.copy(n);
        if (k === 1) d.addScaledVector(this.t1, 0.9);
        else if (k === 2) d.addScaledVector(this.t1, -0.9);
        else if (k === 3) d.addScaledVector(this.t2, 0.9);
        else if (k === 4) d.addScaledVector(this.t2, -0.9);
        d.normalize().multiplyScalar(r).add(p).addScaledVector(n, 0.04);
        const w = r < 0.5 ? 1.2 : 0.8;
        total += w;
        if (this.solid(d)) hits += w;
      }
    }
    const occ = Math.min(1, (hits / total) * 1.35);
    const dy = p.y - this.heightAt(p.x, p.z);
    const ground = dy < -0.4 ? 0 : 1 - Math.min(1, Math.max(0, dy) / 1.3);
    return [Math.round(occ * 255), Math.round(ground * 255)];
  }

  /** bake for up to `ms` milliseconds; returns true when everything is done */
  step(ms: number) {
    if (this.done) return true;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (!this.cur) {
        const mesh = this.queue.shift();
        if (!mesh) {
          this.done = true;
          this.grid.clear();
          return true;
        }
        const n = mesh.geometry.getAttribute('position').count;
        this.cur = { mesh, i: 0, out: new Uint8Array(n * 2), cache: new Map() };
      }
      const c = this.cur;
      const pos = c.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nor = c.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const end = Math.min(pos.count, c.i + 256);
      for (; c.i < end; c.i++) {
        this.v.fromBufferAttribute(pos, c.i);
        this.n.fromBufferAttribute(nor, c.i);
        const key = `${Math.round(this.v.x * 50)},${Math.round(this.v.y * 50)},${Math.round(this.v.z * 50)},${Math.round(this.n.x * 4)},${Math.round(this.n.y * 4)},${Math.round(this.n.z * 4)}`;
        let r = c.cache.get(key);
        if (r === undefined) {
          const [o, g] = this.sample(this.v, this.n);
          r = o | (g << 8);
          c.cache.set(key, r);
        }
        c.out[c.i * 2] = r & 255;
        c.out[c.i * 2 + 1] = r >> 8;
        this.count++;
      }
      if (c.i >= pos.count) {
        c.mesh.geometry.setAttribute('aWeather', new THREE.BufferAttribute(c.out, 2, true));
        this.cur = null;
      }
    }
    return false;
  }
}

/**
 * Interior ambient "probes" as a top-down map (Update 33): A = inside a building footprint,
 * R = lamp warmth (near interior fixtures), G = window daylight (near windows). The world shader
 * tints the indirect light of surfaces under a roof with it.
 */
export function bakeProbeMap(
  defs: { kind: string; x: number; z: number; rot: number; w?: number; d?: number }[],
  fixtures: { p: THREE.Vector3 }[],
  windows: { c: THREE.Vector3 }[],
  half = 260,
  res = 256,
) {
  const data = new Uint8Array(res * res * 4);
  const cell = (half * 2) / res;
  const toI = (x: number) => Math.floor((x + half) / cell);
  // V is flipped to match the shader (1 - z)
  const idx = (i: number, j: number) => ((res - 1 - j) * res + i) * 4;
  const INTERIOR = new Set(['house', 'rorbu', 'church', 'shop', 'warehouse', 'office', 'barracks', 'bunker', 'barn', 'naust']);
  for (const b of defs) {
    if (!INTERIOR.has(b.kind)) continue;
    const w = (b.w ?? 8) / 2 + 0.3, d = (b.d ?? 7) / 2 + 0.3;
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const r = Math.hypot(w, d);
    for (let i = toI(b.x - r); i <= toI(b.x + r); i++) for (let j = toI(b.z - r); j <= toI(b.z + r); j++) {
      if (i < 0 || j < 0 || i >= res || j >= res) continue;
      const px = -half + (i + 0.5) * cell - b.x, pz = -half + (j + 0.5) * cell - b.z;
      // into building space (rotation about Y)
      const lx = c * px - s * pz, lz = s * px + c * pz;
      if (Math.abs(lx) <= w && Math.abs(lz) <= d) data[idx(i, j) + 3] = 255;
    }
  }
  const splat = (p: THREE.Vector3, rad: number, ch: number, amt: number) => {
    for (let i = toI(p.x - rad); i <= toI(p.x + rad); i++) for (let j = toI(p.z - rad); j <= toI(p.z + rad); j++) {
      if (i < 0 || j < 0 || i >= res || j >= res) continue;
      const px = -half + (i + 0.5) * cell, pz = -half + (j + 0.5) * cell;
      const k = Math.max(0, 1 - Math.hypot(px - p.x, pz - p.z) / rad);
      const o = idx(i, j) + ch;
      data[o] = Math.min(255, data[o] + Math.round(255 * amt * k * k));
    }
  };
  for (const f of fixtures) splat(f.p, 5, 0, 0.75);
  for (const w of windows) splat(w.c, 3.2, 1, 0.45);
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
