import * as THREE from 'three';
import { Settings } from '../game/Settings';
import { MaterialLib } from '../render/Materials';
import { Physics } from '../core/Physics';
import { terrainHeight, forestDensity, nearestRoad, PLAY_HALF, TERRAIN_EXTENT, padsNear, TUNNEL, TUNNEL_EXIT, tunnelCapHeight, tunnelShafts } from './MapLayout';
import { clamp, smoothstep } from '../core/math';

import { INNER, STEP, axisCoords } from './TerrainData';

/** terrain tile LOD distances (full res, half res; quarter beyond) per quality preset */
const LOD_DIST: Record<string, [number, number]> = { low: [30, 130], medium: [45, 190], high: [60, 240], ultra: [80, 300] };

export class Terrain {
  mesh: THREE.Group;
  /** render tiles, each with full / half / quarter resolution index buffers */
  private tiles: { levels: THREE.Mesh[]; box: THREE.Box3; lv: number }[] = [];
  /** the untiled terrain geometry (shared buffers) */
  fullGeometry!: THREE.BufferGeometry;
  cap: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** Dense height grid over the inner region for fast queries. */
  private grid: Float32Array;
  private gridN: number;
  splat: THREE.DataTexture;
  cloudUniforms: Record<string, THREE.IUniform> = {};
  splatData: Uint8Array;

  /** `heights`: the precomputed n×n field over axisCoords() (see TerrainData); computed here if absent */
  constructor(private mats: MaterialLib, physics: Physics, heights?: Float32Array) {
    const t0 = performance.now();
    const ax = axisCoords();
    const n = ax.length;
    const innerStart = ax.findIndex((v) => v >= -INNER - 1e-6);
    this.gridN = Math.round((INNER * 2) / STEP) + 1;
    this.grid = new Float32Array(this.gridN * this.gridN);

    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      const z = ax[j];
      for (let i = 0; i < n; i++) {
        const x = ax[i];
        const h = heights ? heights[j * n + i] : terrainHeight(x, z);
        const k = (j * n + i) * 3;
        positions[k] = x;
        positions[k + 1] = h;
        positions[k + 2] = z;
        const gi = i - innerStart, gj = j - innerStart;
        if (gi >= 0 && gj >= 0 && gi < this.gridN && gj < this.gridN) this.grid[gj * this.gridN + gi] = h;
      }
    }
    const indices = new Uint32Array((n - 1) * (n - 1) * 6);
    let p = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        // alternate diagonal for nicer shading
        if ((i + j) & 1) {
          indices[p++] = a; indices[p++] = c; indices[p++] = b;
          indices[p++] = b; indices[p++] = c; indices[p++] = d;
        } else {
          indices[p++] = a; indices[p++] = c; indices[p++] = d;
          indices[p++] = a; indices[p++] = d; indices[p++] = b;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    this.splatData = this.buildSplat();
    this.splat = new THREE.DataTexture(this.splatData, 512, 512, THREE.RGBAFormat);
    this.splat.magFilter = THREE.LinearFilter;
    this.splat.minFilter = THREE.LinearMipmapLinearFilter;
    this.splat.generateMipmaps = true;
    this.splat.needsUpdate = true;

    this.material = this.makeMaterial();
    // Split into tiles that share the vertex buffers (one index range each) so the renderer can
    // frustum-cull them, and only tiles near the play area cast shadows: the single 870k-triangle
    // mesh was drawn in full for the main view, every shadow cascade and the water reflection.
    this.mesh = new THREE.Group();
    this.mesh.name = 'terrain';
    const TILE = 84; // cells per tile side
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let tj = 0; tj < n - 1; tj += TILE) {
      for (let ti = 0; ti < n - 1; ti += TILE) {
        const j1 = Math.min(n - 1, tj + TILE), i1 = Math.min(n - 1, ti + TILE);
        const idx = new Uint32Array((j1 - tj) * (i1 - ti) * 6);
        let q = 0;
        const box = new THREE.Box3();
        const v = new THREE.Vector3();
        for (let j = tj; j < j1; j++) {
          for (let i = ti; i < i1; i++) {
            const a = j * n + i, b2 = a + 1, c = a + n, d = c + 1;
            if ((i + j) & 1) {
              idx[q++] = a; idx[q++] = c; idx[q++] = b2; idx[q++] = b2; idx[q++] = c; idx[q++] = d;
            } else {
              idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b2;
            }
          }
        }
        for (const j of [tj, j1]) for (let i = ti; i <= i1; i += Math.max(1, (i1 - ti) >> 3)) box.expandByPoint(v.fromBufferAttribute(pos, j * n + i));
        for (let j = tj; j <= j1; j += Math.max(1, (j1 - tj) >> 3)) for (let i = ti; i <= i1; i += Math.max(1, (i1 - ti) >> 3)) box.expandByPoint(v.fromBufferAttribute(pos, j * n + i));
        box.expandByScalar(4);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const c = sphere.center;
        // distant massifs never reach the shadow frustum: skip them in the shadow passes
        const cast = Math.max(Math.abs(c.x), Math.abs(c.z)) < INNER + 160;
        const levels: THREE.Mesh[] = [];
        for (const stride of [1, 2, 4]) {
          const li = stride === 1 ? idx : lodIndices(n, ti, tj, i1, j1, stride);
          if (!li) break;
          const tg = new THREE.BufferGeometry();
          tg.setAttribute('position', pos);
          tg.setAttribute('normal', nor);
          tg.setIndex(new THREE.BufferAttribute(li, 1));
          tg.boundingBox = box.clone();
          tg.boundingSphere = sphere.clone();
          const m = new THREE.Mesh(tg, this.material);
          m.receiveShadow = true;
          m.castShadow = cast;
          m.name = 'terrain';
          m.visible = stride === 1;
          this.mesh.add(m);
          levels.push(m);
        }
        // world-space size of a tile: near the play area 105 m, far out it is kilometres wide
        this.tiles.push({ levels, box: box.clone(), lv: 0 });
      }
    }
    this.fullGeometry = geo;

    // Physics: inner region trimesh
    const N = this.gridN;
    const verts = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 3;
        verts[k] = -INNER + i * STEP;
        verts[k + 1] = this.grid[j * N + i];
        verts[k + 2] = -INNER + j * STEP;
      }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    p = 0;
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        if ((i + j) & 1) {
          idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
        } else {
          idx[p++] = a; idx[p++] = c; idx[p++] = d; idx[p++] = a; idx[p++] = d; idx[p++] = b;
        }
      }
    physics.addTrimesh(verts, idx, { surface: 'grass', tag: 'terrain' });

    // Ridge cap over the tunnel
    this.cap = this.buildTunnelCap(physics);
    console.log(`[terrain] ${n}x${n} verts in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  /**
   * Distance LOD for the render tiles (the physics trimesh is separate and always full detail).
   * Tile borders stay at full resolution in every level, so neighbours never crack.
   */
  updateLod(cam: THREE.Vector3) {
    for (const t of this.tiles) {
      const dx = Math.max(t.box.min.x - cam.x, 0, cam.x - t.box.max.x);
      const dz = Math.max(t.box.min.z - cam.z, 0, cam.z - t.box.max.z);
      const d = Math.hypot(dx, dz);
      const [l0, l1] = LOD_DIST[Settings.data.quality] ?? LOD_DIST.high;
      const want = Math.min(t.levels.length - 1, d < l0 ? 0 : d < l1 ? 1 : 2);
      if (want === t.lv) continue;
      t.levels[t.lv].visible = false;
      t.levels[want].visible = true;
      t.lv = want;
    }
  }

  /**
   * The ridge over the tunnel, its galleries and the rock behind the walls (the terrain is carved to
   * road level there). A non-uniform grid whose lines include the shaft edges, so the two exit
   * shafts are clean rectangular holes.
   */
  private buildTunnelCap(physics: Physics) {
    const W = TUNNEL.width / 2, C = TUNNEL_EXIT.carve + 1;
    const x0 = TUNNEL.x - W - C, x1 = TUNNEL.x + W + C;
    const z0 = TUNNEL.z0 + 1.0, z1 = TUNNEL.z1 - 1.0;
    const shafts = tunnelShafts();
    const lines = (a: number, b: number, step: number, extra: number[]) => {
      const out: number[] = [];
      const n = Math.ceil((b - a) / step);
      for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
      for (const e of extra) if (e > a && e < b) out.push(e);
      out.sort((p, q) => p - q);
      return out.filter((v, i) => i === 0 || v - out[i - 1] > 0.05);
    };
    const xs = lines(x0, x1, 1.0, shafts.flatMap((s) => [s.x0, s.x1]));
    const zs = lines(z0, z1, 1.0, shafts.flatMap((s) => [s.z0, s.z1]));
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      pos[k] = xs[i];
      pos[k + 1] = tunnelCapHeight(xs[i], zs[j]);
      pos[k + 2] = zs[j];
    }
    const idx: number[] = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (shafts.some((s) => cx > s.x0 && cx < s.x1 && cz > s.z0 && cz < s.z1)) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    m.castShadow = true;
    physics.addMeshCollider(g, null, { surface: 'rock' });
    return m;
  }

  private buildSplat(): Uint8Array {
    const S = 512;
    const data = new Uint8Array(S * S * 4);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = -INNER + (i + 0.5) / S * INNER * 2;
        const z = -INNER + (j + 0.5) / S * INNER * 2;
        const h = this.heightAt(x, z);
        const f = forestDensity(x, z, h);
        let gravel = 0, dirt = 0;
        const nr = nearestRoad(x, z);
        const hw = nr.road.width * 0.5;
        if (nr.road.kind === 'asphalt') gravel = Math.max(gravel, 1 - smoothstep(hw + 0.3, hw + 2.2, nr.d));
        else if (nr.road.kind === 'gravel') gravel = Math.max(gravel, 1 - smoothstep(hw - 0.5, hw + 1.5, nr.d));
        else dirt = Math.max(dirt, 1 - smoothstep(hw - 0.6, hw + 1.2, nr.d));
        const pads = padsNear(x, z);
        for (let q = 0; q < pads.length; q++) {
          const p = pads[q];
          const c = p.c, s = p.s;
          const dx = x - p.x, dz = z - p.z;
          const lx = Math.abs(dx * c - dz * s) - p.hw + 1.0;
          const lz = Math.abs(dx * s + dz * c) - p.hd + 1.0;
          const d = Math.max(lx, lz);
          if (d < 3) {
            const harbour = z > 96 && x < 90;
            if (harbour) gravel = Math.max(gravel, 1 - smoothstep(-1, 3, d));
            else dirt = Math.max(dirt, (1 - smoothstep(-1, 2.5, d)) * 0.7);
          }
        }
        // Harbour: concrete/gravel yard
        if (z > 100 && x < 90 && z < 184) gravel = Math.max(gravel, 0.85);
        // Fort plateau: worn dirt
        const fd = Math.hypot(x - 30, z + 142);
        dirt = Math.max(dirt, (1 - smoothstep(10, 40, fd)) * 0.55 * (0.5 + 0.5 * Math.sin(x * 0.3) * Math.sin(z * 0.27)));
        const k = (j * S + i) * 4;
        data[k] = clamp(f * 255, 0, 255);
        data[k + 1] = clamp(gravel * 255, 0, 255);
        data[k + 2] = clamp(dirt * 255, 0, 255);
        data[k + 3] = 255;
      }
    }
    return data;
  }

  /** Sample splat channels at a world position (0..1). */
  splatAt(x: number, z: number): [number, number, number] {
    const S = 512;
    const i = clamp(Math.floor(((x + INNER) / (INNER * 2)) * S), 0, S - 1);
    const j = clamp(Math.floor(((z + INNER) / (INNER * 2)) * S), 0, S - 1);
    const k = (j * S + i) * 4;
    return [this.splatData[k] / 255, this.splatData[k + 1] / 255, this.splatData[k + 2] / 255];
  }

  /** The topmost ground: like heightAt, but over the tunnel it is the ridge cap, not the carved floor. */
  topAt(x: number, z: number): number {
    if (Math.abs(x - TUNNEL.x) < TUNNEL.width / 2 + TUNNEL_EXIT.carve + 1 && z > TUNNEL.z0 - 1 && z < TUNNEL.z1 + 1) return tunnelCapHeight(x, z);
    return this.heightAt(x, z);
  }

  heightAt(x: number, z: number): number {
    const fx = (x + INNER) / STEP, fz = (z + INNER) / STEP;
    const N = this.gridN;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return terrainHeight(x, z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const g = this.grid;
    const a = g[j * N + i], b = g[j * N + i + 1], c = g[(j + 1) * N + i], d = g[(j + 1) * N + i + 1];
    // match triangulation roughly with bilinear (error is tiny at 1.25m)
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()) {
    const e = 0.8;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Surface type for footsteps / impacts. */
  /** winter map: open ground is snow */
  winter = false;
  surfaceAt(x: number, z: number): 'grass' | 'rock' | 'dirt' | 'gravel' | 'sand' | 'water' | 'snow' {
    const h = this.heightAt(x, z);
    if (h < 0.05) return 'water';
    const n = this.normalAt(x, z);
    if (n.y < 0.72) return 'rock';
    if (this.winter && h > 0.6) return 'snow';
    const [f, g, d] = this.splatAt(x, z);
    if (g > 0.5) return 'gravel';
    if (h < 1.3) return 'sand';
    if (f > 0.5 || d > 0.5) return 'dirt';
    return 'grass';
  }

  private makeMaterial() {
    const L = this.mats;
    const grass = L.surface('grass'), rock = L.surface('rock'), forest = L.surface('forest'), gravel = L.surface('gravel');
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const uniforms = {
      tGrassA: { value: grass.albedo }, tGrassN: { value: grass.normal },
      tRockA: { value: rock.albedo }, tRockN: { value: rock.normal },
      tForestA: { value: forest.albedo }, tForestN: { value: forest.normal },
      tGravelA: { value: gravel.albedo }, tGravelN: { value: gravel.normal },
      tSplat: { value: this.splat },
      uInner: { value: INNER },
      uCloudT: { value: 0 },
      uCloudAmt: { value: 0.5 },
    };
    this.cloudUniforms = uniforms;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTN;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed,1.0)).xyz; vTN = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = (Settings.data.quality === 'low' ? '#define TERRAIN_LOW\n' : '') + shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTW; varying vec3 vTN;
          uniform sampler2D tGrassA, tGrassN, tRockA, tRockN, tForestA, tForestN, tGravelA, tGravelN, tSplat;
          uniform float uInner; uniform float uCloudT; uniform float uCloudAmt;
          vec3 tNrm; float tRough;
          float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(hash2(i), hash2(i+vec2(1,0)), f.x), mix(hash2(i+vec2(0,1)), hash2(i+vec2(1,1)), f.x), f.y); }
          // Stochastic-ish anti tiling: blend two rotated/offset samples (one sample on Low)
          vec4 sampleAT(sampler2D t, vec2 uv){
          #ifdef TERRAIN_LOW
            return texture2D(t, uv);
          #endif
            float k = vnoise(uv * 0.11);
            vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv + vec2(0.37, 0.71);
            return mix(texture2D(t, uv), texture2D(t, uv2), smoothstep(0.3, 0.7, k));
          }`,
        )
        .replace(
          '#include <map_fragment>',
          `{
            vec3 wp = vTW; vec3 N = normalize(vTN);
            float camDist = length(wp - cameraPosition);
            float far = smoothstep(120.0, 700.0, camDist);
            vec2 suv = (wp.xz + uInner) / (uInner * 2.0);
            vec4 sp = (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) ? texture2D(tSplat, suv) : vec4(0.0);
            float tile = mix(4.0, 28.0, far);
            vec2 uv = wp.xz / tile;
            float macro = vnoise(wp.xz * 0.02) * 0.6 + vnoise(wp.xz * 0.07) * 0.4;
            vec4 gA = sampleAT(tGrassA, uv);
            vec4 fA = sampleAT(tForestA, uv * 1.3);
            vec4 vA = sampleAT(tGravelA, uv * 1.3);
          #ifdef TERRAIN_LOW
            vec4 gN = vec4(0.5, 0.5, 1.0, 0.5), fN = gN, vN = gN;
          #else
            vec4 gN = sampleAT(tGrassN, uv);
            vec4 fN = sampleAT(tForestN, uv * 1.3);
            vec4 vN = sampleAT(tGravelN, uv * 1.3);
          #endif
            // weights
            float slope = 1.0 - N.y;
            float h = wp.y;
            float rockW = smoothstep(0.24, 0.42, slope + (macro - 0.5) * 0.12);
            rockW = max(rockW, smoothstep(140.0, 260.0, h + macro * 80.0));
            // triplanar rock: only where there is rock (a coherent branch: most flat ground skips 6 reads)
            vec3 bw = pow(abs(N), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
            float rt = mix(6.0, 40.0, far);
            vec4 rA = vec4(0.0); float rH = 0.0;
            vec4 rNx = vec4(0.5, 0.5, 1.0, 0.0), rNy = rNx, rNz = rNx;
            if (rockW > 0.001) {
              vec4 rAx = texture2D(tRockA, wp.zy / rt), rAy = texture2D(tRockA, wp.xz / rt), rAz = texture2D(tRockA, wp.xy / rt);
              rA = rAx * bw.x + rAy * bw.y + rAz * bw.z;
            #ifndef TERRAIN_LOW
              rNx = texture2D(tRockN, wp.zy / rt); rNy = texture2D(tRockN, wp.xz / rt); rNz = texture2D(tRockN, wp.xy / rt);
              rH = rNx.a * bw.x + rNy.a * bw.y + rNz.a * bw.z;
            #else
              rH = 0.5;
            #endif
            }
            float shore = 1.0 - smoothstep(0.9, 2.0, h + (macro - 0.5) * 0.8);
            float gravelW = max(sp.g, shore);
            float forestW = max(sp.r, sp.b);
            float grassW = 1.0;
            // height-based blending
            float wg = grassW * (gN.a + 0.5);
            float wf = forestW * (fN.a + 0.6) * 1.6;
            float wv = gravelW * (vN.a + 0.6) * 1.8;
            float wr = rockW * (rH + 0.5) * 2.5;
            float mx = max(max(wg, wf), max(wv, wr)) - 0.25;
            wg = max(wg - mx, 0.0); wf = max(wf - mx, 0.0); wv = max(wv - mx, 0.0); wr = max(wr - mx, 0.0);
            float ws = wg + wf + wv + wr + 1e-5;
            wg /= ws; wf /= ws; wv /= ws; wr /= ws;
            vec3 dirtTint = mix(vec3(1.0), vec3(0.85, 0.78, 0.7), sp.b * (1.0 - sp.r));
            vec3 alb = gA.rgb * wg + fA.rgb * dirtTint * wf + vA.rgb * wv + rA.rgb * wr;
            // macro colour variation
            alb *= mix(0.82, 1.12, macro);
            alb = mix(alb, alb * vec3(1.08, 1.02, 0.85), smoothstep(0.55, 0.8, macro) * wg * 0.6);
            // snow on high peaks
            float snow = smoothstep(480.0, 620.0, h + macro * 140.0) * smoothstep(0.55, 0.85, N.y + 0.2);
            alb = mix(alb, vec3(0.86, 0.88, 0.92), snow);
            // wet shoreline
            float wet = 1.0 - smoothstep(0.1, 0.9, h);
            alb *= mix(1.0, 0.55, wet);
            diffuseColor.rgb *= alb;
            tRough = gA.a * wg + fA.a * wf + vA.a * wv + rA.a * wr;
            tRough = mix(tRough, 0.25, wet * 0.8);
            tRough = mix(tRough, 0.6, snow);
            // normals: planar (xz) layers + triplanar rock
            vec3 nPl = (gN.xyz * 2.0 - 1.0) * wg + (fN.xyz * 2.0 - 1.0) * wf + (vN.xyz * 2.0 - 1.0) * wv;
            vec3 nX = rNx.xyz * 2.0 - 1.0, nY = rNy.xyz * 2.0 - 1.0, nZ = rNz.xyz * 2.0 - 1.0;
            vec3 rockWorld = (vec3(0.0, nX.y, nX.x) * bw.x + vec3(nY.x, 0.0, nY.y) * bw.y + vec3(nZ.x, nZ.y, 0.0) * bw.z);
            vec3 nW = N + vec3(nPl.x, 0.0, nPl.y) * (1.0 - far * 0.7) + rockWorld * wr * 1.4;
            tNrm = normalize(nW);
          }`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNrm, 0.0)).xyz);')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          {
            // drifting cloud shadows over the landscape and mountains
            vec2 cp = vTW.xz * 0.0028 + vec2(uCloudT * 0.006, uCloudT * 0.0025);
            float cn = vnoise(cp) * 0.6 + vnoise(cp * 2.3 + 7.0) * 0.3 + vnoise(cp * 5.1) * 0.1;
            float shade = mix(1.0, 0.35, smoothstep(0.42, 0.62, cn) * uCloudAmt);
            reflectedLight.directDiffuse *= shade;
            reflectedLight.directSpecular *= shade;
          }`,
        );
    };
    return m;
  }

  inPlayArea(x: number, z: number) {
    return Math.abs(x) < PLAY_HALF && Math.abs(z) < PLAY_HALF;
  }
}

/**
 * Coarse index buffer for one terrain tile: cells of `stride`×`stride` fine cells. Cells on the
 * tile border are fanned from their centre to every fine vertex along the border, so a coarse tile
 * meets any neighbour (fine or coarse) without T-junction cracks. Null if the tile can't be split.
 */
function lodIndices(n: number, ti: number, tj: number, i1: number, j1: number, s: number): Uint32Array | null {
  const w = i1 - ti, h = j1 - tj;
  if (w % s || h % s || w < s * 2 || h < s * 2) return null;
  const out: number[] = [];
  const V = (i: number, j: number) => j * n + i;
  for (let j0 = tj; j0 < j1; j0 += s) {
    for (let i0 = ti; i0 < i1; i0 += s) {
      const border = j0 === tj || i0 === ti || j0 + s === j1 || i0 + s === i1;
      if (!border) {
        const a = V(i0, j0), b = V(i0 + s, j0), c = V(i0, j0 + s), d = V(i0 + s, j0 + s);
        if (((i0 + j0) / s) & 1) out.push(a, c, b, b, c, d);
        else out.push(a, c, d, a, d, b);
        continue;
      }
      // perimeter, counter-clockwise seen from below (emitted reversed below for +Y normals)
      const ring: number[] = [];
      const bottom = j0 === tj, right = i0 + s === i1, top = j0 + s === j1, left = i0 === ti;
      for (let i = i0; i < i0 + s; i += bottom ? 1 : s) ring.push(V(i, j0));
      for (let j = j0; j < j0 + s; j += right ? 1 : s) ring.push(V(i0 + s, j));
      for (let i = i0 + s; i > i0; i -= top ? 1 : s) ring.push(V(i, j0 + s));
      for (let j = j0 + s; j > j0; j -= left ? 1 : s) ring.push(V(i0, j));
      const c = V(i0 + s / 2, j0 + s / 2);
      for (let k = 0; k < ring.length; k++) out.push(c, ring[(k + 1) % ring.length], ring[k]);
    }
  }
  return new Uint32Array(out);
}
