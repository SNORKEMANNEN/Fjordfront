import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { MaterialLib } from '../render/Materials';
import { Terrain } from './Terrain';
import { Buildings } from './Buildings';
import { Infrastructure } from './Infrastructure';
import { Vegetation } from './Vegetation';
import { makeWorldMaterials } from './WorldMaterials';
import { Settings } from '../game/Settings';
import { LightPool, SunShafts, ShootableLights } from './Lighting';
import { Ziplines } from './Ziplines';
import { LADDERS } from './MapLayout';
import type { Environment } from './Environment';

/** Builds and owns all static map content for "Kvitvika". */
export class World {
  group = new THREE.Group();
  /** every climbable ladder (roofs, towers, tunnel shafts) */
  ladders = LADDERS;
  terrain: Terrain;
  buildings: Buildings;
  infra: Infrastructure;
  veg: Vegetation;
  mats: Record<string, THREE.Material>;
  lights: THREE.PointLight[] = [];
  pool: LightPool;
  shootable!: ShootableLights;
  zips!: Ziplines;
  shafts: SunShafts;

  constructor(L: MaterialLib, physics: Physics, scene: THREE.Scene, onProgress: (s: string) => void = () => {}) {
    this.group.name = 'world';
    scene.add(this.group);
    onProgress('Shaping terrain');
    this.terrain = new Terrain(L, physics);
    this.group.add(this.terrain.mesh, this.terrain.cap);
    onProgress('Building Kvitvika');
    this.mats = makeWorldMaterials(L);
    this.buildings = new Buildings(physics, this.mats, (x, z) => this.terrain.heightAt(x, z), this.group);
    this.infra = new Infrastructure(this.buildings.builder, this.buildings, this.terrain, this.group, this.mats);
    this.buildings.finish(this.group);
    // Forward lighting: every lit pixel loops over every point light in the scene, so the map's
    // fixtures (interiors, street lamps, the tunnel) share a small pool of real lights that is
    // handed to the fixtures nearest the camera. (Low quality: two; the count is fixed at load,
    // changing it would recompile every shader.)
    this.pool = new LightPool(this.group, Settings.data.quality === 'low' ? 2 : 4);
    for (const l of this.infra.lights) this.pool.add(l.pos, l.color, l.intensity, l.dist, false);
    this.shootable = new ShootableLights(this.group, this.pool);
    for (const f of this.buildings.fixtures) {
      const a = this.pool.add(f.p, f.color, f.intensity, f.dist, false);
      if (f.m && f.min && f.max) this.shootable.add(f.m, f.min, f.max, a, false);
    }
    this.infra.lampAnchors.forEach((p, i) => {
      const a = this.pool.add(p, 0xffb060, 30, 22, true);
      const h = this.infra.lampHeads[i];
      if (h) this.shootable.add(h.m, h.min, h.max, a, true);
    });
    this.shafts = new SunShafts(this.group, this.buildings.windows);
    onProgress('Growing forests');
    this.veg = new Vegetation(L, physics, this.terrain, this.buildings.footprints, Settings.data.grassDensity);
    this.group.add(this.veg.group);
    // ziplines are validated with ray casts: let the query pipeline see everything built so far
    physics.step();
    this.zips = new Ziplines(physics, (x, z) => this.terrain.heightAt(x, z), this.group, this.mats);
  }

  private lastT = 0;
  update(t: number, cam: THREE.Vector3, env?: Environment) {
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.veg.updateGrass(cam);
    this.infra.update(t);
    if (env) {
      const night = env.night;
      this.pool.update(dt, cam, night, env.day);
      // lamps & windows glow after dark; cloud shadows drift over the terrain
      const lamp = this.mats.lamp as THREE.MeshBasicMaterial;
      lamp.color.setRGB(4, 3, 1.8).multiplyScalar(0.15 + night * 1.0);
      const sodium = this.mats.sodium as THREE.MeshBasicMaterial;
      sodium.color.setRGB(5, 2.6, 0.7).multiplyScalar(0.5 + night * 0.8);
      const glass = this.mats.glass as THREE.MeshPhysicalMaterial;
      glass.emissive.setRGB(1.0, 0.62, 0.3);
      glass.emissiveIntensity = night * 0.9 + env.golden * 0.05;
      glass.opacity = 0.45 + night * 0.4;
      const cu = this.terrain.cloudUniforms;
      if (cu.uCloudT) {
        cu.uCloudT.value = t;
        cu.uCloudAmt.value = env.cloudShadow;
      }
      if (env.day > 0.05 && env.elevation > 0.5) this.shafts.rebuild(env.sunDir);
      this.shafts.update(dt, env.rays * (env.weather === 'clear' ? 1 : 0.4), env.sunColor);
    }
  }
}
