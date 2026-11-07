import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export type Surface =
  | 'grass' | 'dirt' | 'rock' | 'wood' | 'metal' | 'concrete' | 'asphalt'
  | 'water' | 'gravel' | 'flesh' | 'snow' | 'glass' | 'sand' | 'fabric' | 'woodFloor';

export interface ColliderInfo {
  surface: Surface;
  /** Bullets can pass through if the hit thickness along the ray is < this (m). */
  penetrable?: number;
  /** Called when hit by a bullet. */
  onHit?: (point: THREE.Vector3, dir: THREE.Vector3, power?: number) => void;
  tag?: string;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
  info: ColliderInfo;
}

// Collision groups: membership (high 16 bits) / filter (low 16 bits)
export const GROUP_WORLD = 0x0001;
export const GROUP_CHARACTER = 0x0002;
export const GROUP_BULLET_ONLY = 0x0004; // e.g. foliage that stops nothing but is hittable — unused
export const groups = (member: number, filter: number) => (member << 16) | filter;

export class Physics {
  static R = RAPIER;
  world!: RAPIER.World;
  info = new Map<number, ColliderInfo>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  static async create() {
    await RAPIER.init();
    const p = new Physics();
    p.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    return p;
  }

  /** set whenever the static world changes; the scene-query structures only need a step then */
  private dirty = true;
  register(c: RAPIER.Collider, info: ColliderInfo) {
    this.dirty = true;
    this.info.set(c.handle, info);
    return c;
  }

  addBox(center: THREE.Vector3, half: THREE.Vector3, rot: THREE.Quaternion | null, info: ColliderInfo) {
    const d = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    if (rot) d.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    return this.register(this.world.createCollider(d), info);
  }

  addCylinder(center: THREE.Vector3, halfH: number, radius: number, info: ColliderInfo) {
    const d = RAPIER.ColliderDesc.cylinder(halfH, radius)
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    return this.register(this.world.createCollider(d), info);
  }

  addTrimesh(vertices: Float32Array, indices: Uint32Array, info: ColliderInfo) {
    const d = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    return this.register(this.world.createCollider(d), info);
  }

  /** Add a trimesh collider from a three.js mesh / geometry already in world space. */
  addMeshCollider(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, info: ColliderInfo) {
    const g = matrix ? geo.clone().applyMatrix4(matrix) : geo;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const verts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      verts[i * 3] = pos.getX(i);
      verts[i * 3 + 1] = pos.getY(i);
      verts[i * 3 + 2] = pos.getZ(i);
    }
    let idx: Uint32Array;
    if (g.index) idx = new Uint32Array(g.index.array as ArrayLike<number>);
    else {
      idx = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) idx[i] = i;
    }
    return this.addTrimesh(verts, idx, info);
  }

  remove(c: RAPIER.Collider) {
    this.info.delete(c.handle);
    this.world.removeCollider(c, false);
    this.dirty = true;
  }

  /** Raycast against world geometry. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, exclude?: RAPIER.Collider, filter = GROUP_WORLD): RayHit | null {
    this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    const hit = this.world.castRayAndGetNormal(this.ray, maxDist, true, undefined, groups(0xffff, filter), exclude);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    const info = this.info.get(hit.collider.handle) ?? { surface: 'concrete' as Surface };
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: t,
      collider: hit.collider,
      info,
    };
  }

  /** True if the segment a→b is unobstructed by world geometry. */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    return this.raycast(a, d, len - 0.05) === null;
  }

  /**
   * The game has no simulated rigid bodies: characters use kinematic shape casts and debris is
   * custom. Stepping a world of ~3500 parentless static colliders still cost ~2.8 ms per frame,
   * so only step when the static world changed (scene queries must see added/removed colliders)
   * or if dynamic bodies ever exist.
   */
  step() {
    if (this.dirty || this.world.bodies.len() > 0) {
      this.world.step();
      this.dirty = false;
    }
  }
}
