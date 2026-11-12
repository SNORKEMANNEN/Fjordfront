import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Weapon modelling kit. Authoring convention (metres):
 *   u = distance toward the muzzle (forward), v = up, w = right.
 * Output geometry is in weapon space: +X right, +Y up, -Z forward (muzzle).
 */
export type P2 = [number, number];

/**
 * Per-weapon finish (Update 33): set before a weapon is built; every PartBuilder mesh gets it as
 * an `aFinish` vertex attribute (tint, roughness offset, wear amount, each -1..1 / 0..1) so all
 * guns share their materials (no extra draws) but each has its own anodising shade and wear.
 */
let FINISH: [number, number, number] = [0, 0, 0.5];
export function setFinish(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const r = (k: number) => (((h >>> (k * 8)) & 255) / 255);
  FINISH = [r(0) * 2 - 1, r(1) * 2 - 1, 0.3 + r(2) * 0.7];
}

/**
 * Edge wear, micro detail and finish for the weapon materials (Update 33), as a shader patch:
 *  - worn edges: where the surface curves (bevels, rounded corners — found from the screen-space
 *    change of the normal) the coating is rubbed through to lighter, shinier base material, in
 *    patches; metal parts show bare steel
 *  - anodised micro-noise on metal (fine roughness variation), stipple on polymer grips
 *  - the per-weapon finish (tint / roughness) from `aFinish`
 */
export function patchWeaponMaterial(m: THREE.Material, kind: 'metal' | 'polymer' | 'rubber' | 'wood') {
  const sm = m as THREE.MeshStandardMaterial;
  if (!sm.isMeshStandardMaterial || sm.userData.wear) return;
  sm.userData.wear = kind;
  const prev = sm.onBeforeCompile;
  const prevKey = sm.customProgramCacheKey;
  const base = prevKey === THREE.Material.prototype.customProgramCacheKey ? prev.toString() : null;
  sm.customProgramCacheKey = () => (base ?? prevKey.call(sm)) + '|wear-' + kind;
  sm.onBeforeCompile = (sh, r) => {
    prev.call(sm, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFinish; varying vec3 vFinish; varying vec3 vObjP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinish = aFinish; vObjP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFinish; varying vec3 vObjP;
        float wH(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float wN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(wH(i), wH(i+vec3(1,0,0)), f.x), mix(wH(i+vec3(0,1,0)), wH(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(wH(i+vec3(0,0,1)), wH(i+vec3(1,0,1)), f.x), mix(wH(i+vec3(0,1,1)), wH(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        {
          // finish
          diffuseColor.rgb *= 1.0 + vFinish.x * 0.1;
          roughnessFactor = clamp(roughnessFactor + vFinish.y * 0.08, 0.04, 1.0);
          // micro detail
          float mn = wN(vObjP * 900.0);
          ${kind === 'metal' ? 'roughnessFactor *= 0.88 + 0.24 * mn;' : ''}
          ${kind === 'polymer' || kind === 'rubber' ? 'float st = smoothstep(0.55, 0.8, wN(vObjP * 1400.0)); diffuseColor.rgb *= 0.9 + 0.2 * st; roughnessFactor = mix(roughnessFactor, 1.0, st * 0.35);' : ''}
          // worn edges (curvature from the screen-space change of the normal)
          float curv = clamp(length(fwidth(vNormal)) * 6.0 - 0.15, 0.0, 1.0);
          float patchy = smoothstep(0.35, 0.75, wN(vObjP * 160.0) * 0.7 + wN(vObjP * 520.0) * 0.3);
          float wear = curv * patchy * (0.35 + 0.65 * vFinish.z);
          ${kind === 'metal'
            ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.56, 0.57), wear * 0.7); roughnessFactor = mix(roughnessFactor, 0.28, wear); metalnessFactor = mix(metalnessFactor, 1.0, wear);'
            : kind === 'wood'
              ? 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5, wear * 0.6); roughnessFactor = mix(roughnessFactor, 0.35, wear);'
              : 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.7 + 0.03, wear * 0.55); roughnessFactor = mix(roughnessFactor, 0.45, wear);'}
        }`);
  };
  sm.needsUpdate = true;
}

export class PartBuilder {
  private geos = new Map<string, THREE.BufferGeometry[]>();

  add(mat: string, g: THREE.BufferGeometry) {
    if (!this.geos.has(mat)) this.geos.set(mat, []);
    // ensure consistent attributes for merging
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    this.geos.get(mat)!.push(g.index ? g.toNonIndexed() : g);
    return this;
  }

  /** Build an Object3D with one mesh per material. */
  build(mats: Record<string, THREE.Material>, name = 'part'): THREE.Group {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [m, list] of this.geos) {
      const clean = list.map((g) => {
        const c = new THREE.BufferGeometry();
        c.setAttribute('position', g.getAttribute('position'));
        c.setAttribute('normal', g.getAttribute('normal'));
        c.setAttribute('uv', g.getAttribute('uv'));
        const n = c.getAttribute('position').count;
        const f = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) f.set(FINISH, i * 3);
        c.setAttribute('aFinish', new THREE.BufferAttribute(f, 3));
        return c;
      });
      const merged = mergeGeometries(clean, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[m] ?? mats.default);
      mesh.name = `${name}:${m}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    return grp;
  }
}

/** Shape from a polyline profile (u,v) with optional rounded corners. */
export function shapeFromProfile(pts: P2[], round = 0): THREE.Shape {
  const s = new THREE.Shape();
  const n = pts.length;
  if (round <= 0) {
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    return s;
  }
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const d0 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const d1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r = Math.min(round, d0 * 0.45, d1 * 0.45);
    const a: P2 = [p1[0] + ((p0[0] - p1[0]) / d0) * r, p1[1] + ((p0[1] - p1[1]) / d0) * r];
    const b: P2 = [p1[0] + ((p2[0] - p1[0]) / d1) * r, p1[1] + ((p2[1] - p1[1]) / d1) * r];
    if (i === 0) s.moveTo(a[0], a[1]);
    else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(p1[0], p1[1], b[0], b[1]);
  }
  s.closePath();
  return s;
}

/** Extrude a side profile to a given width (centered on w=wc). */
export function extrude(shape: THREE.Shape, width: number, bevel = 0.0015, wc = 0, curveSegs = 6): THREE.BufferGeometry {
  const b = Math.min(bevel, width * 0.3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, width - b * 2),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 3,
    curveSegments: curveSegs,
  });
  g.translate(0, 0, -(width - b * 2) / 2 + wc);
  // (u,v,w) -> (w, v, -u)
  g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

export function profile(pts: P2[], width: number, opts: { round?: number; bevel?: number; wc?: number; holes?: P2[][] } = {}) {
  const s = shapeFromProfile(pts, opts.round ?? 0);
  if (opts.holes) for (const h of opts.holes) s.holes.push(shapeFromProfile(h, (opts.round ?? 0) * 0.6) as unknown as THREE.Path);
  return extrude(s, width, opts.bevel ?? 0.0015, opts.wc ?? 0);
}

/** Cylinder along the barrel axis, from u0 to u1, centered at (v, w). */
export function cyl(r: number, u0: number, u1: number, v = 0, w = 0, seg = 20, r1?: number): THREE.BufferGeometry {
  const len = u1 - u0;
  const g = new THREE.CylinderGeometry(r1 ?? r, r, len, seg, 1, false);
  g.rotateX(-Math.PI / 2); // axis -> -Z
  g.translate(w, v, -(u0 + len / 2));
  return g;
}

/** Lathe a radial profile [u, r][] around the barrel axis at height v. */
export function lathe(pts: P2[], v = 0, w = 0, seg = 24): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(pts.map(([u, r]) => new THREE.Vector2(r, u)), seg);
  // lathe axis is +Y; map Y -> -Z
  g.rotateX(-Math.PI / 2);
  g.translate(w, v, 0);
  g.computeVertexNormals();
  return g;
}

/** Rounded box from u0..u1, v0..v1, w0..w1. */
export function rbox(u0: number, u1: number, v0: number, v1: number, w0: number, w1: number, r = 0.002, seg = 2): THREE.BufferGeometry {
  const lu = u1 - u0, lv = v1 - v0, lw = w1 - w0;
  const rr = Math.min(r, lu / 2.01, lv / 2.01, lw / 2.01);
  const g = rr > 0.0002 ? new RoundedBoxGeometry(lw, lv, lu, seg, rr) : new THREE.BoxGeometry(lw, lv, lu);
  g.translate((w0 + w1) / 2, (v0 + v1) / 2, -(u0 + u1) / 2);
  return g;
}

/** Picatinny rail from u0..u1 on top at height v (base bottom), width w. */
export function picatinny(u0: number, u1: number, v: number, wc = 0, width = 0.021, out: THREE.BufferGeometry[] = []) {
  out.push(rbox(u0, u1, v, v + 0.0045, wc - width / 2, wc + width / 2, 0.0008));
  const pitch = 0.01;
  for (let u = u0 + 0.003; u < u1 - 0.004; u += pitch) {
    const tooth = rbox(u, u + 0.0052, v + 0.0045, v + 0.0085, wc - width / 2, wc + width / 2, 0.0007, 1);
    out.push(tooth);
  }
  return out;
}

/** Simple screw head / pin on a side face. */
export function pin(u: number, v: number, w: number, r = 0.0022, len = 0.003, axis: 'x' | 'y' = 'x') {
  const g = new THREE.CylinderGeometry(r, r, len, 10);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(w, v, -u);
  return g;
}

/** Quadratic bezier sampled polyline from a->b with control c. */
export function bez(a: P2, c: P2, b: P2, n = 8): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0];
    const v = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1];
    out.push([u, v]);
  }
  return out;
}

export function socket(name: string, u: number, v: number, w: number, rx = 0, ry = 0, rz = 0): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(w, v, -u);
  o.rotation.set(rx, ry, rz, 'YXZ');
  return o;
}
