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
 * Edge wear, micro detail and finish for the weapon materials (Update 33; Update 46 adds coating
 * mottle, brushed scratches along the gun on metal, settled dust on upward faces, and fades the
 * micro detail with distance), as a shader patch:
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
  sm.customProgramCacheKey = () => (base ?? prevKey.call(sm)) + '|wear2-' + kind;
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
          // detail fades with distance so nothing shimmers (pixel footprint in metres)
          float px = length(fwidth(vObjP));
          float fine = clamp(1.0 - px * 900.0, 0.0, 1.0);
          float midD = clamp(1.0 - px * 120.0, 0.0, 1.0);
          // micro detail
          float mn = wN(vObjP * 900.0);
          ${kind === 'metal' ? 'roughnessFactor *= mix(1.0, 0.88 + 0.24 * mn, fine);' : ''}
          ${kind === 'polymer' || kind === 'rubber' ? 'float st = smoothstep(0.55, 0.8, wN(vObjP * 1400.0)) * fine; diffuseColor.rgb *= 0.9 + 0.2 * st; roughnessFactor = mix(roughnessFactor, 1.0, st * 0.35);' : ''}
          // (Update 46) coating mottle: the finish is never perfectly even over a whole gun
          float mot = wN(vObjP * 28.0) * 0.6 + wN(vObjP * 75.0) * 0.4;
          diffuseColor.rgb *= 0.95 + 0.1 * mot;
          roughnessFactor = clamp(roughnessFactor + (mot - 0.5) * 0.1, 0.04, 1.0);
          ${kind === 'metal'
            ? `// brushed micro-scratches running along the gun (its long axis is z)
          float scr = smoothstep(0.78, 0.95, wN(vec3(vObjP.x * 1600.0, vObjP.y * 1600.0, vObjP.z * 55.0)));
          scr *= smoothstep(0.35, 0.7, wN(vObjP * 60.0)) * fine;
          roughnessFactor = mix(roughnessFactor, 0.18, scr * 0.55);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.44), scr * 0.25);`
            : ''}
          // worn edges (curvature from the screen-space change of the normal), calmer far away
          float curv = clamp(length(fwidth(vNormal)) * 6.0 - 0.15, 0.0, 1.0) * midD;
          float patchy = smoothstep(0.35, 0.75, wN(vObjP * 160.0) * 0.7 + wN(vObjP * 520.0) * 0.3);
          float wear = curv * patchy * (0.35 + 0.65 * vFinish.z);
          ${kind === 'metal'
            ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.56, 0.57), wear * 0.7); roughnessFactor = mix(roughnessFactor, 0.28, wear); metalnessFactor = mix(metalnessFactor, 1.0, wear);'
            : kind === 'wood'
              ? 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5, wear * 0.6); roughnessFactor = mix(roughnessFactor, 0.35, wear);'
              : 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.7 + 0.03, wear * 0.55); roughnessFactor = mix(roughnessFactor, 0.45, wear);'}
          // (Update 46) dust: a faint film settled on the faces that look up
          float up = clamp(dot(normalize(vNormal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)), 0.0, 1.0);
          float dust = smoothstep(0.55, 0.95, up) * (0.4 + 0.6 * wN(vObjP * 45.0)) * (0.25 + 0.5 * vFinish.z);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.39, 0.34), dust * 0.14);
          roughnessFactor = mix(roughnessFactor, 0.95, dust * 0.3);
        }`);
  };
  sm.needsUpdate = true;
}

export class PartBuilder {
  private geos = new Map<string, THREE.BufferGeometry[]>();
  private ironGeos = new Map<string, THREE.BufferGeometry[]>();
  private toIrons = false;
  /** iron sights: geometry added between ironsOn() and ironsOff() is built into a separate child
   *  group named 'irons', so the gunsmith can take the sights off when an optic goes on the rail */
  ironsOn() {
    this.toIrons = true;
    return this;
  }
  ironsOff() {
    this.toIrons = false;
    return this;
  }

  add(mat: string, g: THREE.BufferGeometry) {
    const geos = this.toIrons ? this.ironGeos : this.geos;
    if (!geos.has(mat)) geos.set(mat, []);
    // ensure consistent attributes for merging
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    geos.get(mat)!.push(g.index ? g.toNonIndexed() : g);
    return this;
  }

  /** Build an Object3D with one mesh per material. */
  build(mats: Record<string, THREE.Material>, name = 'part'): THREE.Group {
    const grp = this.buildMap(this.geos, mats, name);
    if (this.ironGeos.size) grp.add(this.buildMap(this.ironGeos, mats, 'irons'));
    return grp;
  }

  private buildMap(geos: Map<string, THREE.BufferGeometry[]>, mats: Record<string, THREE.Material>, name: string): THREE.Group {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [m, list] of geos) {
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

/**
 * Roll-marked engraving (Update 46): lines of text cut into a side face — the bare metal shows
 * lighter and shinier through the coating. A small alpha-textured plane, its texture shared per
 * text, laid a hair off the surface. `side` -1 = the left face (seen in first person), 1 = right.
 * u, v: centre in the gun's authoring space; w: the face; width / height in metres.
 */
const ENGRAVE_TEX = new Map<string, THREE.CanvasTexture>();
const ENGRAVE_MAT = new Map<string, THREE.MeshStandardMaterial>();
export function engraving(lines: string[], u: number, v: number, w: number, width: number, height: number, side: -1 | 1 = -1, tone: 'light' | 'white' = 'light') {
  const key = lines.join('\n') + '|' + width.toFixed(3) + 'x' + height.toFixed(3);
  let tex = ENGRAVE_TEX.get(key);
  if (!tex) {
    const W = 512, H = Math.max(32, Math.round((W * height) / width / 8) * 8);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const lh = H / lines.length;
    lines.forEach((t, i) => {
      const big = i === 0;
      const size = Math.min(lh * (big ? 0.8 : 0.62), (W / Math.max(4, t.length)) * 1.55);
      c.font = `${big ? 700 : 500} ${size.toFixed(0)}px 'JetBrains Mono', ui-monospace, monospace`;
      (c as any).letterSpacing = `${(size * (big ? 0.12 : 0.18)).toFixed(1)}px`;
      c.fillText(t, W / 2, lh * (i + 0.5));
    });
    tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    ENGRAVE_TEX.set(key, tex);
  }
  let mat = ENGRAVE_MAT.get(key + tone);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color: tone === 'white' ? 0xd8d8d0 : 0x8d9096, metalness: tone === 'white' ? 0 : 0.9, roughness: 0.32, alphaMap: tex,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    ENGRAVE_MAT.set(key + tone, mat);
  }
  const g = new THREE.PlaneGeometry(width, height);
  const m = new THREE.Mesh(g, mat);
  m.name = 'engraving';
  m.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
  m.position.set(w + side * 0.0003, v, -u);
  m.castShadow = false;
  m.receiveShadow = false;
  m.renderOrder = 2;
  return m;
}
