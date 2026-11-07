import * as THREE from 'three';
import { TextureBaker, SurfaceTextures } from './TextureBaker';
import { SURF } from './Surfaces';

export interface StdOpts {
  color?: THREE.ColorRepresentation;
  tile?: number; // meters per texture tile (geometry UVs are in meters)
  metalness?: number;
  roughness?: number;
  normalScale?: number;
  envMapIntensity?: number;
  side?: THREE.Side;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
}

/**
 * Central material library. Surfaces are baked lazily on first use and shared.
 * All "surface" materials read roughness from albedo alpha and scale UVs by 1/tile.
 */
export class MaterialLib {
  baker: TextureBaker;
  private surfaces = new Map<string, SurfaceTextures>();
  private mats = new Map<string, THREE.Material>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.baker = new TextureBaker(renderer);
  }

  surface(name: string): SurfaceTextures {
    let s = this.surfaces.get(name);
    if (s) return s;
    const def = (SURF as any)[name];
    const defs: Record<string, [string, number, number]> = {
      red: [SURF.paintedWood([128, 32, 24], 0.45), 1024, 3],
      white: [SURF.paintedWood([226, 224, 214], 0.8), 1024, 3],
      ochre: [SURF.paintedWood([196, 146, 62], 0.55), 1024, 3],
      dkgrey: [SURF.paintedWood([62, 64, 62], 0.6), 1024, 3],
    };
    if (defs[name]) {
      const [g, size, hs] = defs[name];
      s = this.baker.surface(name, g, size, hs);
    } else if (typeof def === 'string') {
      const size = ['polymer', 'gunMetal', 'glove', 'camoFabric'].includes(name) ? 512 : 1024;
      const hs: Record<string, number> = { rock: 6, corrugated: 2.5, polymer: 0.7, gunMetal: 0.6, glove: 1.6, camoFabric: 2.5 };
      s = this.baker.surface(name, def, size, hs[name] ?? 4);
    } else {
      throw new Error('unknown surface ' + name);
    }
    this.surfaces.set(name, s);
    return s;
  }

  /** A PBR material using a baked surface. Cached by key. */
  std(surface: string, opts: StdOpts = {}, key?: string): THREE.MeshStandardMaterial {
    const k = key ?? surface + JSON.stringify(opts);
    const hit = this.mats.get(k);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const s = this.surface(surface);
    const m = new THREE.MeshStandardMaterial({
      map: s.albedo,
      normalMap: s.normal,
      color: opts.color ?? 0xffffff,
      metalness: opts.metalness ?? 0,
      roughness: opts.roughness ?? 1,
      envMapIntensity: opts.envMapIntensity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    const ns = opts.normalScale ?? 1;
    m.normalScale.set(ns, ns);
    patchSurfaceMaterial(m, 1 / (opts.tile ?? 2));
    this.mats.set(k, m);
    return m;
  }

  plain(key: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const hit = this.mats.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial(params);
    this.mats.set(key, m);
    return m;
  }

  physical(key: string, params: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
    const hit = this.mats.get(key);
    if (hit) return hit as THREE.MeshPhysicalMaterial;
    const m = new THREE.MeshPhysicalMaterial(params);
    this.mats.set(key, m);
    return m;
  }
}

export function patchSurfaceMaterial(m: THREE.MeshStandardMaterial, uvScale: number) {
  m.userData.uTile = { value: uvScale };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTile = m.userData.uTile;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTile;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv *= uTile;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv *= uTile;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          diffuseColor.rgb *= sampledDiffuseColor.rgb;
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        #ifdef USE_MAP
          roughnessFactor *= sampledDiffuseColor.a;
        #endif`,
      );
  };
  m.customProgramCacheKey = () => 'surf';
}
