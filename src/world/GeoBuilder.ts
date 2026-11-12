import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Physics, Surface, ColliderInfo } from '../core/Physics';

/**
 * Accumulates static world geometry per material (merged into few draw calls)
 * and creates matching Rapier colliders. Uses a transform stack so building
 * generators can work in local coordinates.
 */
export interface DoorSpec { hinge: THREE.Vector3; along: THREE.Vector3; width: number; height: number; metal: boolean }

export class GeoBuilder {
  private geos = new Map<string, THREE.BufferGeometry[]>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  meshes: THREE.Mesh[] = [];
  /** doorways found in walls (full-height openings 0.8–1.45 m wide); real doors are hung later */
  doors: DoorSpec[] = [];

  /**
   * Destructibles (Update 20). While `tag` is set, every geometry added is remembered so the
   * merged vertex range can be collapsed later (a car that blows up leaves the merged mesh); while
   * `hitHook` is set, every collider gets it as onHit. Free-standing props (barrels, fence runs)
   * are not merged at all: they are recorded in `destructibles` with their world transform and
   * built as their own instanced pieces by the Destruction system.
   */
  tag: string | null = null;
  /** set by the game: a bullet hit a tagged car */
  static onCarHit: ((id: string, p: THREE.Vector3, d: THREE.Vector3, power: number, by: unknown) => void) | null = null;
  hitHook: ColliderInfo['onHit'] | null = null;
  private tagged: { tag: string; mat: string; idx: number }[] = [];
  ranges = new Map<string, { mesh: THREE.Mesh; start: number; count: number }[]>();
  destructibles: { kind: 'barrel' | 'fence'; m: THREE.Matrix4; data: Record<string, unknown> }[] = [];
  destructible(kind: 'barrel' | 'fence', local: THREE.Matrix4, data: Record<string, unknown>) {
    this.destructibles.push({ kind, m: this.m.clone().multiply(local), data });
  }

  /**
   * Solid boxes for the baked ambient occlusion (Update 33): world matrix of a unit box scaled to
   * the size, inverted, plus a world AABB. Recorded for every visual box.
   */
  occ: { inv: THREE.Matrix4; min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  /** every builder that made static world geometry (for the AO bake) */
  static registry: GeoBuilder[] = [];

  constructor(public physics: Physics, public mats: Record<string, THREE.Material>) {
    GeoBuilder.registry.push(this);
  }

  get m() {
    return this.stack[this.stack.length - 1];
  }
  push(pos: THREE.Vector3 | [number, number, number], rotY = 0) {
    const p = Array.isArray(pos) ? new THREE.Vector3(...pos) : pos;
    const local = new THREE.Matrix4().makeRotationY(rotY).setPosition(p);
    this.stack.push(this.m.clone().multiply(local));
  }
  pop() {
    this.stack.pop();
  }

  addGeo(mat: string, g: THREE.BufferGeometry, local?: THREE.Matrix4) {
    const mm = local ? this.m.clone().multiply(local) : this.m;
    g.applyMatrix4(mm);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const ng = g.index ? g.toNonIndexed() : g;
    const clean = new THREE.BufferGeometry();
    clean.setAttribute('position', ng.getAttribute('position'));
    clean.setAttribute('normal', ng.getAttribute('normal'));
    clean.setAttribute('uv', ng.getAttribute('uv'));
    if (!this.geos.has(mat)) this.geos.set(mat, []);
    this.geos.get(mat)!.push(clean);
    if (this.tag) this.tagged.push({ tag: this.tag, mat, idx: this.geos.get(mat)!.length - 1 });
  }

  /**
   * Axis-aligned box in local space from min/max corners, with UVs in metres.
   * `collide` adds a matching cuboid collider. Returns the collider (if any).
   */
  box(mat: string | null, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, collide: Surface | null = null, extra?: Partial<ColliderInfo>, rot?: THREE.Euler) {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const local = new THREE.Matrix4();
    if (rot) local.makeRotationFromEuler(rot);
    local.setPosition(cx, cy, cz);
    if (mat) {
      this.addGeo(mat, metricBox(w, h, d), local);
      // occluder for the AO bake (skip paper-thin decals: rugs, pictures, lines)
      if (Math.min(w, h, d) > 0.025 && !mat.startsWith('glass')) {
        const world = this.m.clone().multiply(local).multiply(new THREE.Matrix4().makeScale(w, h, d));
        const box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(world);
        this.occ.push({ inv: world.clone().invert(), min: box.min, max: box.max });
      }
    }
    if (collide) return this.collider(local, w / 2, h / 2, d / 2, collide, extra);
    return null;
  }

  collider(local: THREE.Matrix4, hx: number, hy: number, hz: number, surface: Surface, extra?: Partial<ColliderInfo>) {
    const world = this.m.clone().multiply(local);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    world.decompose(p, q, s);
    const hook = this.hitHook && !extra?.onHit ? { onHit: this.hitHook } : {};
    return this.physics.addBox(p, new THREE.Vector3(Math.max(hx, 0.01), Math.max(hy, 0.01), Math.max(hz, 0.01)), q, { surface, ...extra, ...hook });
  }

  /** A box rotated around an arbitrary euler, defined by centre & size. */
  obox(mat: string | null, c: [number, number, number], size: [number, number, number], rot: THREE.Euler, collide: Surface | null = null) {
    return this.box(mat, c[0] - size[0] / 2, c[1] - size[1] / 2, c[2] - size[2] / 2, c[0] + size[0] / 2, c[1] + size[1] / 2, c[2] + size[2] / 2, collide, undefined, rot);
  }

  cyl(mat: string, x: number, y0: number, z: number, r: number, h: number, seg = 10, collide: Surface | null = null, r1?: number) {
    const g = new THREE.CylinderGeometry(r1 ?? r, r, h, seg);
    // metric uv around circumference
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * h);
    const local = new THREE.Matrix4().setPosition(x, y0 + h / 2, z);
    this.addGeo(mat, g, local);
    if (collide) {
      const world = this.m.clone().multiply(local);
      const p = new THREE.Vector3().setFromMatrixPosition(world);
      this.physics.addCylinder(p, h / 2, Math.max(r, r1 ?? 0), { surface: collide });
    }
  }

  /**
   * Wall segment along local X from x0..x1 at z (thickness t) between y0..y1,
   * with rectangular openings [{x, w, y0, y1}] (x = opening centre).
   */
  wall(mat: string, x0: number, x1: number, z: number, t: number, y0: number, y1: number, openings: { x: number; w: number; y0: number; y1: number }[], surface: Surface, inner?: string, extra?: Partial<ColliderInfo>) {
    // Split the wall into vertical strips at every opening edge; inside each strip emit the
    // solid spans between the openings that cover it (supports doors with windows above, etc.).
    const xs = new Set<number>([x0, x1]);
    for (const o of openings) {
      xs.add(Math.max(x0, Math.min(x1, o.x - o.w / 2)));
      xs.add(Math.max(x0, Math.min(x1, o.x + o.w / 2)));
    }
    for (const o of openings) {
      const h = Math.min(y1, o.y1) - o.y0;
      if (o.y0 <= y0 + 0.06 && h >= 1.9 && o.w >= 0.8 && o.w <= 1.45) {
        const hinge = new THREE.Vector3(o.x - o.w / 2 + 0.02, o.y0 + 0.01, z).applyMatrix4(this.m);
        const along = new THREE.Vector3(1, 0, 0).transformDirection(this.m);
        this.doors.push({ hinge, along, width: o.w - 0.04, height: h - 0.04, metal: surface === 'concrete' || surface === 'metal' });
      }
    }
    const cuts = [...xs].sort((a, b) => a - b);
    const seg = (a: number, b: number, ya: number, yb: number) => {
      if (b - a < 0.01 || yb - ya < 0.01) return;
      this.box(mat, a, ya, z - t / 2, b, yb, z + t / 2, surface, extra);
      if (inner) this.box(inner, a, ya, z - t / 2 - 0.005, b, yb, z - t / 2 + 0.001);
    };
    // merge adjacent strips with identical solid spans to keep collider count low
    let runStart = cuts[0];
    let runKey = '';
    let runSpans: [number, number][] = [];
    const flush = (endX: number) => {
      for (const [ya, yb] of runSpans) seg(runStart, endX, ya, yb);
    };
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < 1e-4) continue;
      const mid = (a + b) / 2;
      const holes = openings.filter((o) => mid > o.x - o.w / 2 && mid < o.x + o.w / 2).map((o) => [Math.max(y0, o.y0), Math.min(y1, o.y1)] as [number, number]).sort((p, q) => p[0] - q[0]);
      const spans: [number, number][] = [];
      let cy = y0;
      for (const [ha, hb] of holes) {
        if (ha > cy) spans.push([cy, ha]);
        cy = Math.max(cy, hb);
      }
      if (cy < y1) spans.push([cy, y1]);
      const key = spans.map((sp) => sp.map((v) => v.toFixed(3)).join('-')).join('|');
      if (i === 0) {
        runKey = key;
        runSpans = spans;
        runStart = a;
      } else if (key !== runKey) {
        flush(a);
        runStart = a;
        runKey = key;
        runSpans = spans;
      }
    }
    flush(cuts[cuts.length - 1]);
  }

  /** Triangular gable infill (in local XY plane at z), base x0..x1 at y0, apex height h. */
  gable(mat: string, x0: number, x1: number, z: number, t: number, y0: number, h: number, surface: Surface | null) {
    const s = new THREE.Shape();
    s.moveTo(x0, y0);
    s.lineTo(x1, y0);
    s.lineTo((x0 + x1) / 2, y0 + h);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
    g.translate(0, 0, z - t / 2);
    // metric UVs: ExtrudeGeometry uses shape coords already (metres)
    this.addGeo(mat, g);
    if (surface) {
      // approximate with stacked boxes for collision
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const ya = y0 + (h * i) / steps, yb = y0 + (h * (i + 1)) / steps;
        const half = ((x1 - x0) / 2) * (1 - (i + 0.5) / steps);
        const cx = (x0 + x1) / 2;
        this.box(null, cx - half, ya, z - t / 2, cx + half, yb, z + t / 2, surface);
      }
    }
  }

  /** Flush accumulated geometry into meshes and add to a parent. */
  flush(parent: THREE.Object3D, castShadow = true) {
    // where each tagged geometry ends up: (material, index) -> tag
    const tagAt = new Map<string, string>();
    for (const t of this.tagged) tagAt.set(t.mat + '#' + t.idx, t.tag);
    this.tagged.length = 0;
    for (const [mat, list] of this.geos) {
      // merge in chunks to keep buffers reasonable
      for (let i = 0; i < list.length; i += 4000) {
        const chunk = list.slice(i, i + 4000);
        const spans: { tag: string; start: number; count: number }[] = [];
        if (tagAt.size) {
          let off = 0;
          chunk.forEach((g, k) => {
            const n = g.getAttribute('position').count;
            const tg = tagAt.get(mat + '#' + (i + k));
            if (tg) spans.push({ tag: tg, start: off, count: n });
            off += n;
          });
        }
        const merged = mergeGeometries(chunk, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        const mesh = new THREE.Mesh(merged, this.mats[mat] ?? this.mats.default);
        mesh.castShadow = castShadow && !mat.startsWith('glass');
        mesh.receiveShadow = true;
        mesh.name = 'static:' + mat;
        parent.add(mesh);
        for (const sp of spans) {
          if (!this.ranges.has(sp.tag)) this.ranges.set(sp.tag, []);
          this.ranges.get(sp.tag)!.push({ mesh, start: sp.start, count: sp.count });
        }
        this.meshes.push(mesh);
      }
    }
    this.geos.clear();
  }
}

/** Box geometry whose UVs are in metres for each face. */
export function metricBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    let su = w, sv = h;
    if (nx > 0.5) { su = d; sv = h; } else if (ny > 0.5) { su = w; sv = d; }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return g;
}
