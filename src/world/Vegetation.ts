import * as THREE from 'three';
import { Settings } from '../game/Settings';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MaterialLib } from '../render/Materials';
import { Physics } from '../core/Physics';
import { RNG, clamp, smoothstep, fbm2 } from '../core/math';
import { forestDensity, nearestRoad, PLAY_HALF, TUNNEL, MAP_ID, shoreDist, capHeightAt, isWater, inTunnel } from './MapLayout';
import { Terrain } from './Terrain';

const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWindAmp;
attribute float aWind;
vec3 windOffset(vec3 p, float w, vec3 ip){
  float ph = dot(ip.xz, vec2(0.11, 0.07));
  float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.01);
  float s1 = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
  float s2 = sin(uTime * 4.1 + p.y * 1.3 + ph) * 0.15;
  return vec3(s1 + s2, 0.0, (s1 * 0.6 - s2)) * w * gust * uWindAmp;
}`;

export const windUniform = { value: 0 };
/** foliage sway strength: follows the weather's wind (gusty rain and storms bend everything harder) */
export const windAmpUniform = { value: 1 };

function patchWind(m: THREE.Material, strength: number) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => prevKey.call(m) + '|wind' + strength;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uTime = windUniform;
    sh.uniforms.uWindAmp = windAmpUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_GLSL)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 ip = vec3(0.0);
        #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
        #endif
        #ifdef USE_BATCHING
          ip = batchingMatrix[3].xyz;
        #endif
        transformed += windOffset(transformed, aWind * ${strength.toFixed(3)}, ip);`,
      );
  };
}

interface TreeVariant {
  trunk: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  trunkR: number;
  height: number;
  kind: 'spruce' | 'pine' | 'birch';
}

function addWindAttr(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const a = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    a[i] = fn(v);
  }
  g.setAttribute('aWind', new THREE.BufferAttribute(a, 1));
}

/** Card quad from root outward along dir, bent downward. Normals point away from the tree axis (soft canopy lighting). */
function branchCard(root: THREE.Vector3, yaw: number, droop: number, len: number, width: number, centerY: number, segs = 3): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const bend = droop + t * t * 0.5;
    const p = root.clone().addScaledVector(dir, len * t * Math.cos(bend * 0.6)).add(new THREE.Vector3(0, -len * t * Math.sin(bend), 0));
    for (const s of [-1, 1]) {
      const q = p.clone().addScaledVector(side, (s * width) / 2 * (0.6 + 0.4 * Math.sin(t * Math.PI + 0.3)));
      pos.push(q.x, q.y, q.z);
      const n = new THREE.Vector3(q.x, (q.y - centerY) * 0.6 + 0.5, q.z).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(s < 0 ? 0 : 1, t);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function trunkGeo(h: number, r0: number, r1: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 4);
  g.translate(0, h / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * h * 0.5);
  return g;
}

function makeSpruce(rng: RNG, h: number, lod: 0 | 1): TreeVariant {
  const baseR = h * 0.24;
  const tiers = lod === 0 ? Math.round(h * 0.95) : Math.round(h * 0.45);
  const cards: THREE.BufferGeometry[] = [];
  const startY = h * 0.12;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const y = startY + (h - startY) * t;
    const r = baseR * Math.pow(1 - t, 0.95) + 0.25;
    const k = lod === 0 ? Math.max(4, Math.round(7 - t * 3)) : 4;
    const off = rng.range(0, Math.PI * 2);
    for (let j = 0; j < k; j++) {
      const yaw = off + (j / k) * Math.PI * 2 + rng.range(-0.2, 0.2);
      cards.push(branchCard(new THREE.Vector3(0, y, 0), yaw, rng.range(0.25, 0.45), r * rng.range(1.0, 1.25), r * 0.95 + 0.35, h * 0.5));
    }
  }
  // top spire
  for (let j = 0; j < 3; j++) {
    const g = new THREE.PlaneGeometry(0.9, 1.8);
    g.rotateY((j * Math.PI) / 3);
    g.translate(0, h + 0.5, 0);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i));
    cards.push(g);
  }
  const foliage = mergeGeometries(cards.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  addWindAttr(foliage, (p) => clamp(Math.hypot(p.x, p.z) * 0.08 + (p.y / h) * 0.12, 0, 0.5));
  const trunk = trunkGeo(h * 0.95, h * 0.022 + 0.08, 0.04, lod === 0 ? 8 : 5);
  addWindAttr(trunk, (p) => (p.y / h) * 0.06);
  return { trunk, foliage, trunkR: h * 0.022 + 0.08, height: h, kind: 'spruce' };
}

function makePine(rng: RNG, h: number): TreeVariant {
  const crownY = h * 0.62;
  const cards: THREE.BufferGeometry[] = [];
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = rng.next();
    const y = crownY + (h - crownY) * t;
    const r = (1 - Math.abs(t - 0.4) * 1.3) * h * 0.18 + 0.6;
    cards.push(branchCard(new THREE.Vector3(rng.range(-0.3, 0.3), y, rng.range(-0.3, 0.3)), rng.range(0, Math.PI * 2), rng.range(-0.3, 0.15), r, r * 1.1, crownY + (h - crownY) * 0.5));
  }
  const foliage = mergeGeometries(cards.map((g) => g.toNonIndexed()))!;
  addWindAttr(foliage, (p) => clamp((p.y / h) * 0.25, 0, 0.4));
  const trunk = trunkGeo(h * 0.97, h * 0.02 + 0.1, 0.06);
  addWindAttr(trunk, (p) => (p.y / h) * 0.07);
  return { trunk, foliage, trunkR: h * 0.02 + 0.1, height: h, kind: 'pine' };
}

function makeBirch(rng: RNG, h: number): TreeVariant {
  const cards: THREE.BufferGeometry[] = [];
  const crownY = h * 0.35;
  for (let i = 0; i < 40; i++) {
    const t = rng.next();
    const y = crownY + (h - crownY) * t;
    const rr = Math.sin(t * Math.PI) * h * 0.2 + 0.4;
    const a = rng.range(0, Math.PI * 2);
    const g = new THREE.PlaneGeometry(rr * 1.2, rr * 1.2);
    g.rotateY(rng.range(0, Math.PI));
    g.rotateX(rng.range(-0.5, 0.5));
    g.translate(Math.cos(a) * rr * 0.5, y, Math.sin(a) * rr * 0.5);
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < nor.count; k++) {
      const n = new THREE.Vector3(pos.getX(k), pos.getY(k) - (crownY + h) / 2, pos.getZ(k)).normalize();
      nor.setXYZ(k, n.x, n.y, n.z);
    }
    cards.push(g.toNonIndexed());
  }
  const foliage = mergeGeometries(cards)!;
  addWindAttr(foliage, (p) => clamp((p.y / h) * 0.35, 0, 0.5));
  const trunk = trunkGeo(h * 0.9, 0.12, 0.04, 7);
  addWindAttr(trunk, (p) => (p.y / h) * 0.12);
  return { trunk, foliage, trunkR: 0.12, height: h, kind: 'birch' };
}

function rockGeo(rng: RNG): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const sx = rng.range(0.8, 1.5), sy = rng.range(0.45, 0.8), sz = rng.range(0.8, 1.3);
  const seed = rng.range(0, 100);
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const n = fbm2(v.x * 1.3 + seed, v.z * 1.3 + v.y * 0.7, 4) * 0.35 + fbm2(v.y * 3 + seed, v.x * 3, 2) * 0.08;
    v.multiplyScalar(1 + n);
    // flatten bottom
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3;
    pos.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) * 0.5 + pos.getZ(i) * 0.3, pos.getY(i) * 0.5 + pos.getZ(i) * 0.2);
  return g;
}

export class Vegetation {
  /** set by the game once the renderer exists: WEBGL_multi_draw lets a BatchedMesh draw every
   *  tree of one material in a single call with per-tree culling */
  static multiDraw = false;
  group = new THREE.Group();
  /** streamed grass: 12 m tiles of instanced clumps around the camera (see updateGrass) */
  grass = new THREE.Group();
  private grassRadius = 28;
  private grassGeo!: THREE.BufferGeometry;
  private grassMat!: THREE.MeshStandardMaterial;
  private grassTiles = new Map<string, THREE.InstancedMesh>();
  private grassPool: THREE.InstancedMesh[] = [];
  private grassDensity = 1;
  private rng = new RNG(4242);
  treeCount = 0;
  rockPositions: THREE.Vector3[] = [];
  /** Positions of trees in the play area (for AI cover and bot vision checks). */
  trees: { x: number; z: number; r: number }[] = [];

  /**
   * All trees as BatchedMeshes, one per material (bark, birch bark, needles, birch leaves): ~4
   * draw calls (+4 shadow) for the whole forest instead of ~250, each tree culled on its own.
   * Pine shares the spruce needle material with a per-instance tint; far trees skip the trunk.
   */
  private buildBatched(
    chunks: Map<string, { v: number; m: THREE.Matrix4; far: boolean }[]>,
    variants: TreeVariant[],
    farVariants: TreeVariant[],
    matsFor: (v: TreeVariant) => THREE.Material[],
    pineMat: THREE.Material,
    spruceMat: THREE.Material,
  ) {
    type Item = { geo: THREE.BufferGeometry; m: THREE.Matrix4; tint: THREE.Color | null };
    const byMat = new Map<THREE.Material, Item[]>();
    const pineTint = (pineMat as THREE.MeshStandardMaterial).color.clone();
    const push = (mat: THREE.Material, it: Item) => {
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat)!.push(it);
    };
    for (const [, list] of chunks) {
      for (const it of list) {
        const v = (it.far ? farVariants : variants)[it.v];
        const [tm, fm] = matsFor(v);
        if (!it.far) push(tm, { geo: v.trunk, m: it.m, tint: null });
        if (fm === pineMat) push(spruceMat, { geo: v.foliage, m: it.m, tint: pineTint });
        else push(fm, { geo: v.foliage, m: it.m, tint: fm === spruceMat ? new THREE.Color(1, 1, 1) : null });
      }
    }
    for (const [mat, items] of byMat) {
      const geos = [...new Set(items.map((i) => i.geo))];
      // every geometry in one batch needs the same attribute set and index-ness
      const norm = geos.map((g) => {
        let h = g.index ? g : g;
        if (!h.getAttribute('aWind')) {
          h = h.clone();
          h.setAttribute('aWind', new THREE.BufferAttribute(new Float32Array(h.getAttribute('position').count), 1));
        }
        if (!h.getAttribute('uv')) {
          h = h === g ? h.clone() : h;
          h.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(h.getAttribute('position').count * 2), 2));
        }
        return h;
      });
      const anyIndexed = norm.some((g) => !!g.index);
      const ready = norm.map((g) => {
        if (anyIndexed && !g.index) {
          const c = g.clone();
          c.setIndex(Array.from({ length: c.getAttribute('position').count }, (_, i) => i));
          return c;
        }
        return g;
      });
      const names = Object.keys(ready[0].attributes);
      for (const g of ready) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
      for (const g of ready) for (const n of names) if (!g.getAttribute(n)) {
        const a = ready[0].getAttribute(n) as THREE.BufferAttribute;
        g.setAttribute(n, new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * a.itemSize), a.itemSize));
      }
      const vCount = ready.reduce((a, g) => a + g.getAttribute('position').count, 0);
      const iCount = anyIndexed ? ready.reduce((a, g) => a + g.index!.count, 0) : 0;
      const bm = new THREE.BatchedMesh(items.length, vCount, iCount || undefined, mat);
      const ids = new Map<THREE.BufferGeometry, number>();
      geos.forEach((g, i) => ids.set(g, bm.addGeometry(ready[i])));
      const tinted = items.some((i) => i.tint);
      for (const it of items) {
        const id = bm.addInstance(ids.get(it.geo)!);
        bm.setMatrixAt(id, it.m);
        if (tinted) bm.setColorAt(id, it.tint ?? new THREE.Color(1, 1, 1));
      }
      bm.sortObjects = false;
      bm.perObjectFrustumCulled = true;
      bm.castShadow = true;
      bm.receiveShadow = true;
      bm.computeBoundingSphere();
      bm.name = 'trees';
      this.group.add(bm);
    }
  }

  constructor(private L: MaterialLib, private physics: Physics, private terrain: Terrain, private exclude: THREE.Box3[], density = 1) {
    const baker = L.baker;
    const spruceTex = baker.raw('veg.spruce', `
      float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
      void main(){
        vec2 p = vUv; // x across (0..1), y along branch (0 at trunk)
        float d = seg(p, vec2(0.5, 0.0), vec2(0.5, 1.0));
        float twig = 1e3; float needles = 0.0;
        for (int i = 0; i < 9; i++) {
          float t = 0.08 + float(i) * 0.1;
          float L = 0.42 * (1.0 - t * 0.6);
          for (int s = -1; s <= 1; s += 2) {
            vec2 a = vec2(0.5, t);
            vec2 b = a + vec2(float(s) * L, L * 0.55);
            float dd = seg(p, a, b);
            twig = min(twig, dd);
            // needles: dense fuzz around twigs
            float n = tnoise(p * vec2(220.0, 260.0) + float(i) * 13.0, vec2(1000.0));
            needles = max(needles, smoothstep(0.07, 0.0, dd) * smoothstep(0.35, 0.75, n));
          }
        }
        needles = max(needles, smoothstep(0.09, 0.0, d) * smoothstep(0.3, 0.7, tnoise(p * vec2(240.0, 300.0), vec2(1000.0))));
        float stem = smoothstep(0.012, 0.004, d) + smoothstep(0.008, 0.002, twig);
        float a = clamp(max(needles, stem), 0.0, 1.0);
        float tipFade = smoothstep(1.0, 0.85, p.y) * smoothstep(0.0, 0.04, p.y);
        a *= tipFade;
        vec3 col = mix(hex(24., 38., 22.), hex(52., 70., 36.), tnoise(p * 40.0, vec2(1000.0)) * 0.6 + p.y * 0.4);
        col = mix(col, hex(70., 52., 36.), stem * 0.8);
        gl_FragColor = vec4(col, a);
      }`, 512, true);
    const birchTex = baker.raw('veg.birch', `void main(){
        vec2 p = vUv;
        vec3 v = tvoronoi(p * 7.0, vec2(7.0));
        float leaf = smoothstep(0.42, 0.25, v.x);
        float hole = step(0.82, hash12(floor(p * 7.0) + 3.0));
        float r = length(p - 0.5);
        float a = leaf * (1.0 - hole) * smoothstep(0.52, 0.32, r);
        vec3 col = mix(hex(86., 112., 40.), hex(150., 150., 52.), v.z);
        col = mix(col, hex(196., 160., 50.), step(0.78, v.z));
        gl_FragColor = vec4(col * (0.75 + v.x * 0.5), a);
      }`, 256, true);
    const birchBark = baker.surface('birchBark', `
      void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
        float marks = smoothstep(0.62, 0.7, tnoise(vec2(uv.x * 6.0, uv.y * 30.0), vec2(6.0, 30.0)));
        float marks2 = smoothstep(0.75, 0.8, tnoise(vec2(uv.x * 3.0, uv.y * 10.0) + 4.0, vec2(3.0, 10.0)));
        al = mix(hex(222., 218., 206.), hex(28., 26., 24.), max(marks, marks2));
        h = 1.0 - max(marks, marks2) * 0.5; r = 0.7; ao = 1.0;
      }`, 256, 2);

    const foliageMat = (tex: THREE.Texture, tint = 0xffffff) => {
      const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, color: tint, envMapIntensity: 0.6 });
      patchWind(m, 1);
      return m;
    };
    const spruceMat = foliageMat(spruceTex);
    const pineMat = foliageMat(spruceTex, 0xb8c8a8);
    const birchMat = foliageMat(birchTex);
    const brosund = MAP_ID === 'brosund';
    // Brosund is high summer: the birches are fresh green, not turning
    if (brosund) birchMat.color.setRGB(0.72, 1.0, 0.62);
    const barkMat = L.std('bark', { tile: 1, roughness: 1 }, 'treeBark');
    const birchBarkMat = new THREE.MeshStandardMaterial({ map: birchBark.albedo, normalMap: birchBark.normal, roughness: 0.75 });
    patchWind(barkMat, 1);
    patchWind(birchBarkMat, 1);

    const variants: TreeVariant[] = [
      makeSpruce(this.rng, 14, 0), makeSpruce(this.rng, 18, 0), makeSpruce(this.rng, 10, 0),
      makePine(this.rng, 17), makeBirch(this.rng, 9), makeBirch(this.rng, 12),
    ];
    const farVariants: TreeVariant[] = [makeSpruce(this.rng, 16, 1), makeSpruce(this.rng, 12, 1)];
    const matsFor = (v: TreeVariant) => (v.kind === 'birch' ? [birchBarkMat, birchMat] : v.kind === 'pine' ? [barkMat, pineMat] : [barkMat, spruceMat]);

    // ---------------- placement ----------------
    type Inst = { v: number; m: THREE.Matrix4; far: boolean };
    const chunks = new Map<string, Inst[]>();
    const chunkSize = 150; // bigger tiles: far fewer draw calls, the trees are in view anyway
    const addInst = (x: number, z: number, v: number, s: number, far: boolean) => {
      const h = terrain.heightAt(x, z);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.2, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rng.range(-0.04, 0.04), this.rng.range(0, 6.28), this.rng.range(-0.04, 0.04))), new THREE.Vector3(s, s * this.rng.range(0.9, 1.15), s));
      // far forest (no collisions, no shadows) in big tiles: the hills read as one mass anyway
      const cs = far ? 300 : chunkSize;
      const key = `${Math.floor(x / cs)},${Math.floor(z / cs)},${far ? 1 : 0}`;
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key)!.push({ v, m, far });
    };
    const blocked = (x: number, z: number, margin: number) => {
      const nr = nearestRoad(x, z);
      if (nr.d < nr.road.width * 0.5 + margin) return true;
      const p = new THREE.Vector3(x, 0, z);
      for (const b of this.exclude) if (x > b.min.x - margin && x < b.max.x + margin && z > b.min.z - margin && z < b.max.z + margin) return true;
      if (MAP_ID === 'kvitvika' && Math.abs(x - TUNNEL.x) < TUNNEL.width / 2 + 9 && z > TUNNEL.z0 - 10 && z < TUNNEL.z1 + 10) return true;
      // over a tunnel bore the ground is the cap mesh, not the carved terrain: nothing grows there
      if (MAP_ID !== 'kvitvika' && capHeightAt(x, z) !== null) return true;
      void p;
      return false;
    };
    // inner play area: detailed trees with colliders
    const step = 4.2 / Math.sqrt(density);
    for (let x = -PLAY_HALF - 25; x < PLAY_HALF + 25; x += step) {
      for (let z = -PLAY_HALF - 25; z < PLAY_HALF + 25; z += step) {
        const jx = x + this.rng.range(-step * 0.45, step * 0.45), jz = z + this.rng.range(-step * 0.45, step * 0.45);
        const h = terrain.heightAt(jx, jz);
        const f = forestDensity(jx, jz, h);
        if (f <= 0 || this.rng.next() > f * 0.85) continue;
        const n = terrain.normalAt(jx, jz);
        if (n.y < 0.8 || h < 1.5) continue;
        if (blocked(jx, jz, 3)) continue;
        const birchy = smoothstep(0.3, 0.7, 0.5 + 0.5 * fbm2(jx * 0.02 + 40, jz * 0.02, 3));
        let v: number;
        const r = this.rng.next();
        if (brosund) {
          // Sunnmøre: birch woods with white trunks, pine on the rocky knolls, a little spruce
          if (r < 0.55 + birchy * 0.25) v = 4 + (this.rng.chance(0.5) ? 1 : 0);
          else if (r < 0.88) v = 3;
          else v = this.rng.int(0, 2);
        } else if (r < birchy * 0.35) v = 4 + (this.rng.chance(0.5) ? 1 : 0);
        else if (r < 0.15 + birchy * 0.35) v = 3;
        else v = this.rng.int(0, 2);
        const s = this.rng.range(0.75, 1.2);
        addInst(jx, jz, v, s, false);
        const tr = variants[v].trunkR * s;
        if (Math.abs(jx) < PLAY_HALF + 2 && Math.abs(jz) < PLAY_HALF + 2) {
          physics.addCylinder(new THREE.Vector3(jx, h + 2, jz), 2.5, tr + 0.04, { surface: 'wood', penetrable: 0.25 });
          this.trees.push({ x: jx, z: jz, r: tr });
        }
        this.treeCount++;
      }
    }
    // scattered trees in the village / along shore & roads
    for (let i = 0; i < (brosund ? 260 : 70); i++) {
      const x = brosund ? this.rng.range(-185, 230) : this.rng.range(-80, 70), z = brosund ? this.rng.range(-200, 190) : this.rng.range(-70, 95);
      const h = terrain.heightAt(x, z);
      if (h < 1.6 || blocked(x, z, 4) || shoreDist(x, z) < 8) continue;
      if (brosund && (forestDensity(x, z, h) > 0.2 || terrain.normalAt(x, z).y < 0.85)) continue;
      const v = brosund || this.rng.chance(0.6) ? 4 + this.rng.int(0, 1) : this.rng.int(0, 2);
      const s = this.rng.range(0.7, 1.0);
      addInst(x, z, v, s, false);
      physics.addCylinder(new THREE.Vector3(x, h + 2, z), 2.5, variants[v].trunkR * s + 0.04, { surface: 'wood', penetrable: 0.25 });
      this.trees.push({ x, z, r: variants[v].trunkR * s });
    }
    // far forest on the surrounding slopes (no colliders, cheaper geometry)
    for (let i = 0; i < 9000; i++) {
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(PLAY_HALF + 20, 900);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (Math.abs(x) < PLAY_HALF + 15 && Math.abs(z) < PLAY_HALF + 15) continue;
      const h = terrain.heightAt(x, z);
      if (h < 3 || h > 260 + fbm2(x * 0.01, z * 0.01, 2) * 80) continue;
      const n = terrain.normalAt(x, z);
      if (n.y < 0.72) continue;
      if (0.5 + 0.5 * fbm2(x * 0.006 + 9, z * 0.006, 3) < 0.42) continue;
      addInst(x, z, this.rng.int(0, 1), this.rng.range(0.9, 1.5), true);
      this.treeCount++;
    }
    if (Vegetation.multiDraw) this.buildBatched(chunks, variants, farVariants, matsFor, pineMat, spruceMat);
    else for (const [, list] of chunks) {
      const far = list[0].far;
      const vs = far ? farVariants : variants;
      for (let v = 0; v < vs.length; v++) {
        const items = list.filter((i) => i.v === v);
        if (!items.length) continue;
        const [tm, fm] = matsFor(vs[v]);
        for (const [geo, mat] of [[vs[v].trunk, tm], [vs[v].foliage, fm]] as const) {
          const im = new THREE.InstancedMesh(geo, mat, items.length);
          items.forEach((it, i) => im.setMatrixAt(i, it.m));
          im.castShadow = !far;
          im.receiveShadow = true;
          im.computeBoundingSphere();
          if (far) im.layers.set(1);
          this.group.add(im);
        }
      }
    }

    // ---------------- rocks ----------------
    const rockMat = L.std('rock', { tile: 3 }, 'boulder');
    const rocks = [rockGeo(this.rng), rockGeo(this.rng), rockGeo(this.rng)];
    const rockLists: THREE.Matrix4[][] = [[], [], []];
    const rockR = brosund ? PLAY_HALF + 15 : PLAY_HALF + 60; // (beyond the dense terrain the coarse mesh would leave rocks floating)
    for (let i = 0; i < (brosund ? 900 : 520); i++) {
      const x = this.rng.range(-rockR, rockR), z = this.rng.range(-rockR, rockR);
      const h = terrain.heightAt(x, z);
      const n = terrain.normalAt(x, z);
      const f = forestDensity(x, z, h);
      const shore = shoreDist(x, z) < 12 && h > -1.5;
      if (brosund && n.y < 0.62) continue; // (a rock on a cliff face hangs in the air)
      if (isWater(x, z, h + 0.6) && !shore) continue;
      const chance = (1 - n.y) * 3 + f * (brosund ? 0.6 : 0.25) + (shore ? 0.5 : 0);
      if (this.rng.next() > chance || blocked(x, z, 2.5)) continue;
      const s = this.rng.range(0.4, 2.2) * (shore ? 1.2 : 1);
      const v = this.rng.int(0, 2);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rng.range(-0.3, 0.3), this.rng.range(0, 6.3), this.rng.range(-0.3, 0.3)));
      const p = new THREE.Vector3(x, h + s * 0.1, z);
      rockLists[v].push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s)));
      if (Math.abs(x) < PLAY_HALF && Math.abs(z) < PLAY_HALF && s > 0.6) {
        const g = rocks[v].clone().applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s)));
        const pts = g.getAttribute('position').array as Float32Array;
        const desc = Physics.R.ColliderDesc.convexHull(new Float32Array(pts));
        if (desc) physics.register(physics.world.createCollider(desc), { surface: 'rock' });
        this.rockPositions.push(p);
      }
    }
    rockLists.forEach((list, v) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(rocks[v], rockMat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      im.layers.set(1);
      this.group.add(im);
    });

    // ---------------- bushes (juniper/heather) ----------------
    const bushGeo = (() => {
      const cards: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 8; i++) cards.push(branchCard(new THREE.Vector3(0, 0.15, 0), (i / 8) * Math.PI * 2, -0.6, 0.9, 0.9, 0.4, 2).toNonIndexed());
      const g = mergeGeometries(cards)!;
      addWindAttr(g, (p) => clamp(p.y * 0.12, 0, 0.1));
      return g;
    })();
    const bushMat = foliageMat(spruceTex, 0x9aa080);
    const bushes: THREE.Matrix4[] = [];
    for (let i = 0; i < 1400; i++) {
      const x = this.rng.range(-PLAY_HALF, PLAY_HALF), z = this.rng.range(-PLAY_HALF, PLAY_HALF);
      const h = terrain.heightAt(x, z);
      if (h < 1.2 || blocked(x, z, 1.5)) continue;
      const f = forestDensity(x, z, h);
      if (this.rng.next() > 0.12 + f * 0.6) continue;
      const s = this.rng.range(0.6, 1.4);
      bushes.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.1, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng.range(0, 6)), new THREE.Vector3(s, s * 0.8, s)));
    }
    const bim = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length);
    bushes.forEach((m, i) => bim.setMatrixAt(i, m));
    bim.castShadow = true;
    bim.receiveShadow = true;
    this.group.add(bim);

    // ---------------- Brosund: heather tufts and wildflower meadows (blue and purple) ----------------
    if (brosund) {
      const flowerTex = baker.raw('veg.flowers', `void main(){
          vec2 p = vUv;
          // stems
          float stem = 0.0;
          for (int i = 0; i < 7; i++) {
            float x = 0.1 + float(i) * 0.13 + (hash12(vec2(float(i), 3.0)) - 0.5) * 0.06;
            float top = 0.55 + hash12(vec2(float(i), 7.0)) * 0.35;
            stem = max(stem, smoothstep(0.012, 0.0, abs(p.x - x - (p.y * 0.05))) * step(p.y, top));
          }
          // flower heads: blue harebells / violet cranesbill / purple clover
          vec3 v = tvoronoi(p * vec2(6.0, 5.0) + vec2(0.0, 0.3), vec2(6.0, 5.0));
          float head = smoothstep(0.24, 0.12, v.x) * step(0.45, p.y);
          vec3 c1 = hex(92., 110., 222.), c2 = hex(156., 84., 196.), c3 = hex(206., 120., 200.);
          vec3 fc = v.z < 0.45 ? c1 : v.z < 0.8 ? c2 : c3;
          vec3 col = mix(hex(60., 96., 40.), fc, head);
          float a = max(stem, head);
          gl_FragColor = vec4(col, a);
        }`, 256, true);
      const heatherTex = baker.raw('veg.heather', `void main(){
          vec2 p = vUv;
          vec3 v = tvoronoi(p * 9.0, vec2(9.0));
          float r = length((p - vec2(0.5, 0.0)) * vec2(1.0, 0.9));
          float a = smoothstep(0.32, 0.1, v.x) * smoothstep(0.75, 0.45, r);
          vec3 col = mix(hex(120., 60., 120.), hex(186., 98., 170.), v.z);
          col = mix(col, hex(64., 84., 44.), smoothstep(0.55, 0.85, hash12(floor(p * 9.0))));
          gl_FragColor = vec4(col, a);
        }`, 256, true);
      const cross = (w: number, hgt: number) => {
        const g1 = new THREE.PlaneGeometry(w, hgt);
        g1.translate(0, hgt / 2, 0);
        const g2 = g1.clone().rotateY(Math.PI / 2);
        const g3 = g1.clone().rotateY(Math.PI / 4);
        const g = mergeGeometries([g1, g2, g3])!;
        addWindAttr(g, (p) => clamp(p.y * 0.35, 0, 0.25));
        return g;
      };
      const flowerMat = foliageMat(flowerTex);
      const heatherMat = foliageMat(heatherTex);
      for (const [geo, mat, count, near] of [[cross(0.9, 0.55), flowerMat, 5200, 0.0], [cross(1.1, 0.5), heatherMat, 3800, 1.0]] as const) {
        const list: THREE.Matrix4[] = [];
        for (let i = 0; i < count * 3 && list.length < count; i++) {
          const x = this.rng.range(-PLAY_HALF, PLAY_HALF), z = this.rng.range(-PLAY_HALF, PLAY_HALF);
          const h = terrain.heightAt(x, z);
          if (h < 2.2 || blocked(x, z, 1.2)) continue;
          const n = terrain.normalAt(x, z);
          if (n.y < 0.8) continue;
          const f = forestDensity(x, z, h);
          if (f > 0.55) continue;
          // flowers in the meadows low down, heather on the open slopes higher up
          const want = near ? smoothstep(10, 30, h) : 1 - smoothstep(25, 60, h);
          if (this.rng.next() > want * (0.4 + 0.6 * smoothstep(0.35, 0.65, 0.5 + 0.5 * fbm2(x * 0.03 + (near ? 7 : 0), z * 0.03, 2)))) continue;
          // clumps: a few instances together
          for (let k = 0; k < 3 && list.length < count; k++) {
            const cx = x + this.rng.range(-1.2, 1.2), cz = z + this.rng.range(-1.2, 1.2);
            const s = this.rng.range(0.7, 1.3);
            list.push(new THREE.Matrix4().compose(new THREE.Vector3(cx, terrain.heightAt(cx, cz) - 0.04, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng.range(0, 6.3)), new THREE.Vector3(s, s * this.rng.range(0.8, 1.2), s)));
          }
        }
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((m, i) => im.setMatrixAt(i, m));
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    }

    // ---------------- grass field near the camera ----------------
    const blades: THREE.BufferGeometry[] = [];
    // (blade count and grass range scale with the quality preset; two segments per blade is
    // enough for the bend at this size)
    const q = Settings.data.quality;
    const nBlades = q === 'low' ? 10 : q === 'medium' ? 12 : 16;
    this.grassRadius = q === 'low' ? 18 : q === 'medium' ? 23 : q === 'ultra' ? 32 : 28;
    for (let i = 0; i < nBlades; i++) {
      const g = new THREE.PlaneGeometry(0.05, 0.24, 1, 2);
      g.translate(0, 0.12, 0);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const lean = this.rng.range(0.1, 0.35);
      for (let k = 0; k < pos.count; k++) {
        const y = pos.getY(k);
        const t = y / 0.5;
        pos.setX(k, pos.getX(k) * (1 - t * 0.85));
        pos.setZ(k, t * t * lean);
      }
      g.rotateY(this.rng.range(0, Math.PI * 2));
      g.translate(this.rng.range(-0.2, 0.2), 0, this.rng.range(-0.2, 0.2));
      g.scale(1, this.rng.range(0.6, 1.3), 1);
      blades.push(g.toNonIndexed());
    }
    const grassGeo = mergeGeometries(blades)!;
    {
      const pos = grassGeo.getAttribute('position') as THREE.BufferAttribute;
      const nor = grassGeo.getAttribute('normal') as THREE.BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) {
        const t = clamp(pos.getY(k) / 0.3, 0, 1);
        col[k * 3] = 0.2 + 0.32 * t;
        col[k * 3 + 1] = 0.28 + 0.34 * t;
        col[k * 3 + 2] = 0.12 + 0.1 * t;
        nor.setXYZ(k, 0, 1, 0);
      }
      grassGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      addWindAttr(grassGeo, (p) => clamp(p.y * 0.35, 0, 0.25));
    }
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, color: 0xb0b48a, envMapIntensity: 0.55 });
    patchWind(grassMat, 0.7);
    patchGrassFade(grassMat);
    this.grassGeo = grassGeo;
    this.grassMat = grassMat;
    this.grassDensity = density;
    this.grass.name = 'grass';
    this.group.add(this.grass);
    bim.layers.set(1);
  }

  /**
   * Streamed grass. The field is cut into 12 m tiles on the same 0.5 m grid (and the same stable
   * per-cell hash) the old ring used, so the clumps are identical; tiles entering the 28 m ring
   * are built a couple per frame (nearest first) instead of rebuilding ~10k clumps in one frame
   * every 7 m — that rebuild was a periodic hitch while moving. Each tile is its own frustum-
   * culled InstancedMesh, so grass behind the camera is no longer drawn; the distance fade moved
   * into the vertex shader and now follows the camera continuously.
   */
  updateGrass(cam: THREE.Vector3) {
    windUniform.value = performance.now() / 1000;
    grassCam.value.copy(cam);
    grassR.value = this.grassRadius;
    const T = GRASS_TILE, R = this.grassRadius;
    const tx0 = Math.floor((cam.x - R) / T), tx1 = Math.floor((cam.x + R) / T);
    const tz0 = Math.floor((cam.z - R) / T), tz1 = Math.floor((cam.z + R) / T);
    // drop tiles that left the ring (with a margin so walking back and forth does not churn)
    for (const [k, m] of this.grassTiles) {
      const [tx, tz] = k.split(',').map(Number);
      const cx = (tx + 0.5) * T, cz = (tz + 0.5) * T;
      if (Math.hypot(cx - cam.x, cz - cam.z) > R + T * 1.2) {
        this.grass.remove(m);
        this.grassPool.push(m);
        this.grassTiles.delete(k);
      }
    }
    // distance thinning: the far tiles draw a random subset of their clumps (instances are
    // shuffled at build time, so a shorter count thins evenly); the shrink-fade hides the rest
    for (const [k, m] of this.grassTiles) {
      const [tx, tz] = k.split(',').map(Number);
      const d = Math.hypot((tx + 0.5) * T - cam.x, (tz + 0.5) * T - cam.z);
      const f = d < 13 ? 1 : d < R * 0.65 ? 0.55 : 0.3;
      const full = m.userData.full as number;
      m.count = Math.max(1, Math.round(full * f));
    }
    // build the nearest missing tiles (a small, steady amount of work per frame)
    const want: [number, number, number][] = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
      if (this.grassTiles.has(`${tx},${tz}`)) continue;
      // nearest point of the tile to the camera
      const nx = Math.max(tx * T, Math.min(cam.x, (tx + 1) * T)), nz = Math.max(tz * T, Math.min(cam.z, (tz + 1) * T));
      const d = Math.hypot(nx - cam.x, nz - cam.z);
      if (d < R) want.push([d, tx, tz]);
    }
    want.sort((a, b) => a[0] - b[0]);
    const budget = this.grassTiles.size === 0 ? want.length : 3;
    for (let i = 0; i < Math.min(budget, want.length); i++) this.buildGrassTile(want[i][1], want[i][2]);
  }

  private buildGrassTile(tx: number, tz: number) {
    const T = GRASS_TILE;
    const spacing = 0.5;
    const cap = Math.ceil(T / spacing) ** 2;
    let mesh = this.grassPool.pop();
    if (!mesh) {
      mesh = new THREE.InstancedMesh(this.grassGeo, this.grassMat, cap);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.layers.set(1);
      mesh.setColorAt(0, new THREE.Color());
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let n = 0;
    for (let ix = 0; ix < T / spacing; ix++) {
      const x = tx * T + ix * spacing;
      for (let iz = 0; iz < T / spacing; iz++) {
        const z = tz * T + iz * spacing;
        // stable per-cell jitter
        const hsh = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
        const j = hsh - Math.floor(hsh);
        if (this.grassDensity < 1 && ((j * 17.31) % 1) > this.grassDensity + 0.05) continue;
        const jx = x + (j - 0.5) * spacing, jz = z + (((j * 7.13) % 1) - 0.5) * spacing;
        const h = this.terrain.heightAt(jx, jz);
        if (h < 1.0) continue;
        // never inside the tunnel bore / galleries (the terrain there is carved under the rock cap)
        if (Math.abs(jx - TUNNEL.x) < TUNNEL.width / 2 + 7 && jz > TUNNEL.z0 - 1.5 && jz < TUNNEL.z1 + 1.5) continue;
        if (inTunnel(jx, h + 0.5, jz)) continue;
        const [f, g, dirt] = this.terrain.splatAt(jx, jz);
        const grassy = 1 - Math.max(g, dirt * 0.8, f * 0.6);
        if (grassy < 0.35 || j > grassy + 0.2) continue;
        const nrm = this.terrain.normalAt(jx, jz);
        if (nrm.y < 0.78) continue;
        let inside = false;
        for (const b of this.exclude) if (jx > b.min.x + 2 && jx < b.max.x - 2 && jz > b.min.z + 2 && jz < b.max.z - 2) { inside = true; break; }
        if (inside) continue;
        const patch = 0.5 + 0.5 * Math.sin(jx * 0.37 + Math.sin(jz * 0.21) * 2) * Math.cos(jz * 0.29);
        const sc = (0.55 + j * 0.6) * (0.5 + grassy * 0.4) * (0.6 + patch * 0.7);
        p.set(jx, h - 0.02, jz);
        q.setFromAxisAngle(up, j * 6.28);
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(n, m);
        const dry = patch * 0.25;
        col.setRGB(0.8 + j * 0.25 + dry, 0.85 + ((j * 3.7) % 1) * 0.15, 0.75 - dry * 0.5);
        mesh.setColorAt(n, col);
        n++;
      }
    }
    // shuffle so that drawing the first N instances is an even, random thinning
    const ma = mesh.instanceMatrix.array as Float32Array, ca = mesh.instanceColor?.array as Float32Array | undefined;
    let seed = (tx * 73856093) ^ (tz * 19349663);
    for (let i = n - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      for (let e = 0; e < 16; e++) { const t = ma[i * 16 + e]; ma[i * 16 + e] = ma[j * 16 + e]; ma[j * 16 + e] = t; }
      if (ca) for (let e = 0; e < 3; e++) { const t = ca[i * 3 + e]; ca[i * 3 + e] = ca[j * 3 + e]; ca[j * 3 + e] = t; }
    }
    mesh.userData.full = n;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    this.grass.add(mesh);
    this.grassTiles.set(`${tx},${tz}`, mesh);
  }
}

const GRASS_TILE = 12;
const grassCam = { value: new THREE.Vector3() };
const grassR = { value: 28 };
/** Grass clumps shrink away toward the ring edge, measured from the camera every frame. */
function patchGrassFade(m: THREE.Material) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => prevKey.call(m) + '|grassfade';
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uGrassCam = grassCam;
    sh.uniforms.uGrassR = grassR;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGrassCam; uniform float uGrassR;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float gd = distance(instanceMatrix[3].xz, uGrassCam.xz);
          transformed *= 1.0 - smoothstep(uGrassR * 0.7, uGrassR, gd);
        }
        #endif`,
      );
  };
}
