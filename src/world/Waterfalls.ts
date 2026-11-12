import * as THREE from 'three';
import { RNG } from '../core/math';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Terrain } from './Terrain';

/**
 * Waterfalls (Update 34, Brosund): every fall is a ribbon traced downhill over the terrain from
 * its lip (steepest descent), raised a little off the rock, with a scrolling streaked water texture
 * (one shared material, its UV offset animated), mist puffs rising where it lands and a sound
 * source there. Big landmark falls, small streams down the cliffs round the play area, and the
 * long white threads on the far fjord walls.
 */
export interface Fall { pts: THREE.Vector3[]; w: number; big: boolean; base: THREE.Vector3; far: boolean }

function streakTexture() {
  const W = 128, H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  const img = x.createImageData(W, H);
  const rng = new RNG(77);
  // vertical streaks of varying brightness and alpha, broken up along their length
  const cols: { a: number; b: number; ph: number; f: number }[] = [];
  for (let i = 0; i < W; i++) cols.push({ a: rng.range(0.45, 1), b: rng.range(0.75, 1), ph: rng.range(0, 6.28), f: rng.range(2, 7) });
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const cl = cols[i], cn = cols[(i + 1) % W], cp = cols[(i + W - 1) % W];
      const s = (cl.a * 0.5 + cn.a * 0.25 + cp.a * 0.25) * (0.65 + 0.35 * Math.sin((j / H) * Math.PI * 2 * cl.f + cl.ph));
      const edge = Math.min(1, Math.min(i, W - 1 - i) / 14);
      const k = (j * W + i) * 4;
      const v = Math.round(255 * Math.min(1, 0.72 + 0.28 * s * cl.b));
      img.data[k] = v;
      img.data[k + 1] = Math.min(255, v + 4);
      img.data[k + 2] = Math.min(255, v + 10);
      img.data[k + 3] = Math.round(255 * Math.min(1, s * 0.95 + 0.1) * edge);
    }
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mistTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.5, 'rgba(240,246,250,0.28)');
  g.addColorStop(1, 'rgba(240,246,250,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Waterfalls {
  falls: Fall[] = [];
  group = new THREE.Group();
  private mat: THREE.MeshStandardMaterial;
  private farMat: THREE.MeshStandardMaterial;
  private mist: { p: THREE.Vector3; fall: number; t: number; life: number; v: THREE.Vector3 }[] = [];
  private mistPts!: THREE.Points;
  private rng = new RNG(9191);

  constructor(private terrain: Terrain, near: { x: number; z: number; w: number; big?: boolean }[], far: [number, number, number][], autoStreams: number) {
    this.group.name = 'waterfalls';
    const tex = streakTexture();
    this.mat = new THREE.MeshStandardMaterial({ map: tex, alphaMap: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.25, metalness: 0, color: 0xe8f2f4, emissive: 0x4a5a60, emissiveIntensity: 0.6, envMapIntensity: 0.6 });
    const farTex = tex.clone();
    farTex.needsUpdate = true;
    this.farMat = this.mat.clone();
    this.farMat.map = farTex;
    this.farMat.alphaMap = farTex;
    this.farMat.emissiveIntensity = 0.9;
    for (const f of near) this.add(f.x, f.z, f.w, !!f.big, false);
    for (const [x, z, w] of far) this.add(x, z, w, true, true);
    // small streams down the cliffs: find steep faces with a lip above them
    let made = 0;
    for (let i = 0; i < 1600 && made < autoStreams; i++) {
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(120, 720);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = terrain.heightAt(x, z);
      if (h < 40 || h > 520) continue;
      const n = terrain.normalAt(x, z);
      if (n.y > 0.55 || n.y < 0.2) continue;
      if (this.add(x, z, this.rng.range(1.2, 3.2), false, d > 260)) made++;
    }
    const geos = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const f of this.falls) {
      const g = this.ribbon(f);
      if (!g) continue;
      const m = f.far ? this.farMat : this.mat;
      if (!geos.has(m)) geos.set(m, []);
      geos.get(m)!.push(g);
    }
    // one mesh per material (each fall was its own draw call)
    for (const [m, list] of geos) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, m);
      mesh.renderOrder = 3;
      this.group.add(mesh);
    }
    // mist at the near falls: one additive point cloud (a sprite each was a draw call each)
    const mt = mistTexture();
    this.falls.forEach((f, i) => {
      if (f.far) return;
      const n = f.big ? 9 : 4;
      for (let k = 0; k < n; k++) this.mist.push({ p: new THREE.Vector3(0, -1e4, 0), fall: i, t: this.rng.range(0, 4), life: this.rng.range(2.5, 4.5), v: new THREE.Vector3() });
    });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.mist.length * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.mist.length * 3), 3));
    this.mistPts = new THREE.Points(pg, new THREE.PointsMaterial({ map: mt, size: 4.5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, fog: true }));
    this.mistPts.frustumCulled = false;
    this.mistPts.renderOrder = 4;
    this.group.add(this.mistPts);
  }

  /** Trace a fall downhill from its lip. Returns false if it doesn't make a proper fall. */
  private add(x: number, z: number, w: number, big: boolean, far: boolean) {
    const t = this.terrain;
    const pts: THREE.Vector3[] = [];
    let px = x, pz = z;
    let flat = 0;
    const step = far ? 6 : 1.4;
    for (let i = 0; i < (far ? 160 : 260); i++) {
      const h = t.heightAt(px, pz);
      pts.push(new THREE.Vector3(px, h, pz));
      if (h < 0.15) break;
      const e = far ? 4 : 0.8;
      const gx = t.heightAt(px + e, pz) - t.heightAt(px - e, pz);
      const gz = t.heightAt(px, pz + e) - t.heightAt(px, pz - e);
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-4) break;
      const slope = gl / (2 * e);
      if (slope < 0.18) {
        flat += step;
        if (flat > (far ? 24 : 7)) break;
      } else flat = 0;
      // a little meander so streams aren't ruler-straight
      const wob = Math.sin(i * 0.7 + x) * 0.18;
      const dx = -gx / gl, dz = -gz / gl;
      px += (dx - dz * wob) * step;
      pz += (dz + dx * wob) * step;
    }
    if (pts.length < 6) return false;
    const drop = pts[0].y - pts[pts.length - 1].y;
    if (drop < (far ? 60 : 6)) return false;
    this.falls.push({ pts, w, big, base: pts[pts.length - 1].clone(), far });
    return true;
  }

  private ribbon(f: Fall): THREE.BufferGeometry | null {
    const P = f.pts;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let v = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const sx = -dz / l, sz = dx / l;
      // spread wider as it falls; lift clear of the rock (more for the big ones)
      const t = i / (P.length - 1);
      const w = f.w * (0.7 + 0.6 * t) * (f.big ? 1.15 : 1);
      const lift = f.far ? 3 : f.big ? 0.6 : 0.3;
      const p = P[i];
      if (i > 0) v += p.distanceTo(P[i - 1]);
      pos.push(p.x - sx * w / 2, p.y + lift, p.z - sz * w / 2, p.x + sx * w / 2, p.y + lift, p.z + sz * w / 2);
      uv.push(0, v / 7, 1, v / 7);
      if (i > 0) {
        const k = i * 2;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  update(dt: number, cam: THREE.Vector3) {
    // water runs down (texture scroll); far threads crawl slowly
    if (this.mat.map) this.mat.map.offset.y += dt * 0.9;
    if (this.mat.alphaMap && this.mat.alphaMap !== this.mat.map) this.mat.alphaMap.offset.y += dt * 0.9;
    if (this.farMat.map) this.farMat.map.offset.y += dt * 0.15;
    const pos = this.mistPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.mistPts.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.mist.forEach((m, i) => {
      const f = this.falls[m.fall];
      const d = f.base.distanceTo(cam);
      if (d > 220) {
        pos.setXYZ(i, 0, -1e4, 0);
        return;
      }
      m.t += dt;
      if (m.t > m.life) {
        m.t = 0;
        m.life = this.rng.range(2.5, 4.5);
        m.p.copy(f.base).add(new THREE.Vector3(this.rng.range(-1, 1) * f.w, this.rng.range(0, 0.6), this.rng.range(-1, 1) * f.w));
        m.v.set(this.rng.range(-0.4, 0.4), this.rng.range(0.6, 1.4) * (f.big ? 1.6 : 0.8), this.rng.range(-0.4, 0.4));
      }
      const k = m.t / m.life;
      m.p.addScaledVector(m.v, dt);
      pos.setXYZ(i, m.p.x, m.p.y, m.p.z);
      const a = Math.sin(k * Math.PI) * (f.big ? 0.22 : 0.12);
      col.setXYZ(i, a, a * 1.02, a * 1.05);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}
