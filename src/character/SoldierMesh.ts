import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BONE_INDEX, REST } from './SoldierRig';

/**
 * Procedural soldier mesh: a skinned body (torso, limbs, hands, head) plus a gear kit chosen by
 * role (plate carrier or chest rig, helmet / boonie / ghillie hood, packs, pouches, pads, ammo) and
 * varied per soldier (skin tone, beard, balaclava, glasses, glove and boot colours, rolled sleeves,
 * pouch layout, build). Everything is merged into ONE skinned geometry — one draw call and one
 * shadow draw per soldier — with three detail levels sharing the same skeleton.
 *
 * Per-vertex attributes besides the usual skinning ones:
 *   color  — garment tint (multiplies the camo) or the flat colour of non-cloth parts
 *   aMat   — x: kind (0 camo cloth, 1 flat, 2 team accent, 3 NVG lowered, 4 NVG raised, 5 glass,
 *            6 weapon light / laser emitter), y: roughness, z: metalness
 * uv is metric (1 unit = 0.6 m) so the camo keeps the same scale on every garment.
 */

export type Role = 'rifleman' | 'cqb' | 'breacher' | 'marksman' | 'sniper' | 'gunner';
export function roleFor(cls: string, id?: string): Role {
  if (cls === 'SMG' || cls === 'Pistol') return 'cqb';
  if (cls === 'Shotgun') return 'breacher';
  if (cls === 'Sniper') return 'sniper';
  if (cls === 'Marksman') return id === 'kr98' ? 'marksman' : 'marksman';
  if (cls === 'LMG') return 'gunner';
  return 'rifleman';
}

export interface SoldierLook {
  role: Role;
  seed: number;
}

/** Fixed per-soldier choices derived from the seed (shared by all LODs). */
export interface Variety {
  height: number;
  width: number;
  skin: THREE.Color;
  hair: THREE.Color;
  gloves: THREE.Color;
  boots: THREE.Color;
  gear: THREE.Color;
  gear2: THREE.Color;
  face: 'bare' | 'beard' | 'balaclava' | 'paint' | 'scarf' | 'gaiter';
  eyes: 'none' | 'glasses' | 'goggles';
  rolledSleeves: boolean;
  helmetCover: 'camo' | 'plain';
  pack: 'none' | 'assault' | 'radio';
  pouches: number;
  kneePads: boolean;
  earPro: boolean;
}

class RNG {
  constructor(private s: number) {}
  next() {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length) % a.length];
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  chance(p: number) {
    return this.next() < p;
  }
}

const SKINS = [0xe2bfa6, 0xd2a88c, 0xbb9073, 0x9a6e52, 0x6e4a36, 0xcca088, 0xdcb49c];
const HAIRS = [0x2a1c12, 0x4a3220, 0x6b4a2c, 0x8c6a3e, 0x1a1512, 0xa08060];
const GLOVES = [0x222222, 0x3a3a34, 0x6a5e44, 0x4a4c38, 0x2c2a26];
const BOOTS = [0x2a2420, 0x4a3a2a, 0x6a5a42, 0x2a2a2a];
const GEAR_TEAM: [number[], number[]] = [
  [0x4c5336, 0x5a5e3c, 0x3f4530, 0x666a48], // Kystjegerne: olive / ranger green
  [0x6a6250, 0x5c5a4e, 0x7a705a, 0x4e4c44], // Nordfront: coyote / grey
];

export function varietyFor(look: SoldierLook, team: 0 | 1): Variety {
  const r = new RNG(look.seed * 2654435761 + 97);
  const role = look.role;
  // (Update 46) most operators cover up: balaclavas, neck gaiters pulled over the nose, a beard
  const face = role === 'sniper' ? r.pick(['paint', 'paint', 'gaiter'] as const) : role === 'breacher' ? r.pick(['balaclava', 'balaclava', 'gaiter', 'beard'] as const) : r.pick(['bare', 'beard', 'beard', 'balaclava', 'balaclava', 'gaiter', 'gaiter', 'scarf', 'paint'] as const);
  const gt = GEAR_TEAM[team];
  return {
    height: r.range(0.965, 1.04) * (role === 'gunner' ? 1.02 : 1),
    width: r.range(0.96, 1.05) * (role === 'gunner' ? 1.04 : role === 'cqb' ? 0.98 : 1),
    skin: new THREE.Color(r.pick(SKINS)),
    hair: new THREE.Color(r.pick(HAIRS)),
    gloves: new THREE.Color(r.pick(GLOVES)),
    boots: new THREE.Color(r.pick(BOOTS)),
    gear: new THREE.Color(r.pick(gt)),
    gear2: new THREE.Color(r.pick(gt)),
    face,
    eyes: role === 'sniper' ? 'none' : r.pick(['none', 'glasses', 'glasses', 'goggles'] as const),
    rolledSleeves: role !== 'sniper' && r.chance(0.25),
    helmetCover: r.chance(0.65) ? 'camo' : 'plain',
    pack: role === 'gunner' ? 'assault' : role === 'sniper' ? 'none' : r.pick(['none', 'assault', 'radio', 'none'] as const),
    pouches: r.pick([2, 3, 3, 4]),
    kneePads: role === 'breacher' || r.chance(0.55),
    earPro: role !== 'sniper' && role !== 'marksman' && r.chance(0.6),
  };
}

// ------------------------------------------------------------------ builder

type Weights = [string, number][];
const K_CAMO = 0, K_FLAT = 1, K_TEAM = 2, K_NVG_DOWN = 3, K_NVG_UP = 4, K_GLASS = 5;
/** Update 46 kinds: 7 nylon webbing (MOLLE rows), 8 skin, 9 helmet strobe (blinks under NVG),
 *  10 the shoulder flag patch, 11 knit (balaclava, beanie), 12 rubberised / hard plastic */
const K_WEB = 7, K_SKIN = 8, K_STROBE = 9, K_PATCH = 10, K_KNIT = 11, K_HARD = 12;
const TILE = 0.3;

class SkinBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  mat: number[] = [];
  idx: number[] = [];

  /** weights → 4 bone indices + normalised weights (resolved once per weight set) */
  private resolve(w: Weights) {
    const list = w.filter((e) => e[1] > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((a, e) => a + e[1], 0) || 1;
    const out = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const e = list[i];
      out[i] = e ? BONE_INDEX[e[0]] : 0;
      out[4 + i] = e ? e[1] / sum : 0;
    }
    return out;
  }

  /** append an indexed geometry already in model space */
  add(g: THREE.BufferGeometry, weights: Weights | ((p: THREE.Vector3) => Weights), color: THREE.Color, kind: number, rough = 0.85, metal = 0, uvScale = 1) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const P = p.array as ArrayLike<number>, N = n.array as ArrayLike<number>, UV = uv ? (uv.array as ArrayLike<number>) : null;
    // (Update 46) an optional per-vertex colour multiplies the part colour (sculpted head: lips,
    // eye sockets, stubble)
    const vc = g.getAttribute('color');
    const VC = vc ? (vc.array as ArrayLike<number>) : null;
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    const fixed = typeof weights === 'function' ? null : this.resolve(weights);
    let last: Weights | null = null, lastR: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      this.pos.push(x, y, z);
      this.nor.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      this.uv.push(UV ? UV[i * 2] * uvScale : 0, UV ? UV[i * 2 + 1] * uvScale : 0);
      if (VC) this.col.push(color.r * VC[i * 3], color.g * VC[i * 3 + 1], color.b * VC[i * 3 + 2]);
      else this.col.push(color.r, color.g, color.b);
      this.mat.push(kind, rough, metal);
      let r = fixed;
      if (!r) {
        const w = (weights as (p: THREE.Vector3) => Weights)(v.set(x, y, z));
        if (w !== last) {
          last = w;
          lastR = this.resolve(w);
        }
        r = lastR;
      }
      this.si.push(r[0], r[1], r[2], r[3]);
      this.sw.push(r[4], r[5], r[6], r[7]);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  /**
   * A skinned tube through rings (vertical in the rest pose: each ring lies in the XZ plane).
   * `ex` is the superellipse exponent (2 = ellipse, higher = boxier).
   */
  tube(rings: { c: THREE.Vector3; rx: number; rz: number; w: Weights }[], segs: number, color: THREE.Color, kind: number, opts: { rough?: number; ex?: number; capA?: boolean; capB?: boolean; flip?: boolean } = {}) {
    const ex = opts.ex ?? 2;
    const g = new THREE.BufferGeometry();
    const P: number[] = [], U: number[] = [], I: number[] = [];
    const W: Weights[] = [];
    let len = 0;
    rings.forEach((r, j) => {
      if (j > 0) len += r.c.distanceTo(rings[j - 1].c);
      const per = Math.PI * (3 * (r.rx + r.rz) - Math.sqrt((3 * r.rx + r.rz) * (r.rx + 3 * r.rz)));
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / ex) * r.rx;
        const z = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / ex) * r.rz;
        P.push(r.c.x + x, r.c.y, r.c.z + z);
        U.push(((i / segs) * per) / TILE, len / TILE);
        W.push(r.w);
      }
    });
    const row = segs + 1;
    for (let j = 0; j < rings.length - 1; j++)
      for (let i = 0; i < segs; i++) {
        const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
        // rings go downwards (decreasing y) in most limbs: wind so normals face out
        if (opts.flip) I.push(a, b, c, b, d, c);
        else I.push(a, c, b, b, c, d);
      }
    const cap = (j: number, top: boolean) => {
      const r = rings[j];
      const ci = P.length / 3;
      P.push(r.c.x, r.c.y + (top ? 1 : -1) * Math.min(r.rx, r.rz) * 0.35, r.c.z);
      U.push(0, 0);
      W.push(r.w);
      for (let i = 0; i < segs; i++) {
        const a = j * row + i, b = a + 1;
        const up = top !== !!opts.flip;
        if (up) I.push(ci, b, a);
        else I.push(ci, a, b);
      }
    };
    if (opts.capA) cap(0, rings[0].c.y > rings[rings.length - 1].c.y);
    if (opts.capB) cap(rings.length - 1, rings[rings.length - 1].c.y > rings[0].c.y);
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    let k = 0;
    this.add(g, () => W[k++], color, kind, opts.rough ?? 0.88);
  }

  /** rigid part on one bone: geometry built at the origin, placed by position / rotation */
  rigid(g: THREE.BufferGeometry, bone: string | Weights, at: [number, number, number], color: THREE.Color, kind: number, opts: { rot?: [number, number, number]; rough?: number; metal?: number; uv?: number } = {}) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(opts.rot ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    this.add(g, typeof bone === 'string' ? [[bone, 1]] : bone, color, kind, opts.rough ?? 0.8, opts.metal ?? 0, opts.uv ?? 1);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx.length > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ helpers

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number | THREE.Color) => (hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex));
const shade = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** weights along the spine by height */
function spineW(y: number): Weights {
  const k = [
    ['Hips', 0.94, 1.04],
    ['Spine', 1.04, 1.14],
    ['Spine1', 1.14, 1.27],
    ['Spine2', 1.27, 1.47],
    ['Neck', 1.47, 1.56],
    ['Head', 1.56, 9],
  ] as const;
  const out: Weights = [];
  for (let i = 0; i < k.length; i++) {
    const [n, a, b] = k[i];
    const fadeIn = i === 0 ? 1 : sstep(a - 0.04, a + 0.04, y);
    const fadeOut = i === k.length - 1 ? 1 : 1 - sstep(b - 0.04, b + 0.04, y);
    const w = fadeIn * fadeOut;
    if (w > 0.001) out.push([n, w]);
  }
  return out.length ? out : [['Hips', 1]];
}
const SHAPES = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = SHAPES.get(key);
  if (!g) {
    const made = make();
    if (!made.getAttribute('normal')) made.computeVertexNormals();
    // stored as a plain BufferGeometry: clone() on a parametric geometry (RoundedBoxGeometry,
    // SphereGeometry) re-runs its constructor first — the slow part we're caching
    g = new THREE.BufferGeometry().copy(made);
    made.dispose();
    SHAPES.set(key, g);
  }
  return g.clone();
}
const rbox = (w: number, h: number, d: number, r = 0.012, seg = 2) => cached(`rb${w},${h},${d},${r},${seg}`, () => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.1, h / 2.1, d / 2.1)));
const box = (w: number, h: number, d: number) => cached(`bx${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (r0: number, r1: number, h: number, s = 10) => cached(`cy${r0},${r1},${h},${s}`, () => new THREE.CylinderGeometry(r1, r0, h, s));
const sph = (r: number, ws = 12, hs = 8) => cached(`sp${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
/** sphere scaled to an ellipsoid */
const ell = (rx: number, ry: number, rz: number, ws = 12, hs = 9) => sph(1, ws, hs).scale(rx, ry, rz);

// ------------------------------------------------------------------ the head (Update 46)

const HEAD_C = new THREE.Vector3(0, 1.69, 0);
const gs = (dx: number, dy: number, s: number) => Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
/**
 * The sculpted head: a unit-sphere direction d (x right, y up, z out of the face) → a point on
 * the head surface, relative to HEAD_C. An ellipsoid skull (fuller behind and above), a flatter
 * face, the jaw tapering to the chin, then the features as smooth bumps and dents along d: brow
 * ridge, eye sockets, the nose (bridge, tip and wings), cheekbones, lips and the mouth line.
 */
function headPoint(x: number, y: number, z: number, out = new THREE.Vector3()) {
  const f = sstep(0.3, 0.8, z); // the face (front)
  let rx = 0.07, ry = 0.097, rz = 0.091;
  rx *= 1 + 0.05 * Math.max(0, y) - 0.05 * Math.max(0, -z);
  rz *= 1 + 0.06 * Math.max(0, -z) * Math.max(0, y + 0.3);
  // jaw: narrows toward the chin, a little more at the front
  const jaw = sstep(-0.15, -0.95, y);
  rx *= 1 - 0.26 * jaw * (0.45 + 0.55 * f);
  // temples: the skull narrows a little above and in front of the ears
  rx *= 1 - 0.05 * gs(z - 0.45, y - 0.3, 0.25);
  // flatter face plane
  rz *= 1 - 0.08 * f * (1 - Math.abs(y) * 0.6);
  out.set(x * rx, y * ry, z * rz);
  // features: offsets along the surface direction (metres)
  const ax = Math.abs(x);
  let off = 0;
  off += 0.0075 * gs(x, y - 0.29, 0.09) * f * sstep(0.66, 0.3, ax); // brow ridge
  off -= 0.0145 * gs(ax - 0.33, y - 0.12, 0.09) * f; // eye sockets
  // nose: bridge rising from the brow to the tip, then tucking under
  const nt = sstep(0.24, -0.16, y) * sstep(-0.3, -0.17, y);
  off += (0.005 + 0.027 * sstep(0.22, -0.16, y)) * Math.exp(-(x * x) / (2 * Math.pow(0.048 + 0.05 * sstep(0.1, -0.18, y), 2))) * nt * f;
  off += 0.0085 * gs(ax - 0.11, y + 0.2, 0.045) * f; // nostril wings
  off += 0.0065 * gs(ax - 0.5, y - 0.02, 0.12) * f; // cheekbones
  off += 0.006 * gs(ax - 0.68, y + 0.55, 0.14) * sstep(0.0, 0.5, z); // the angle of the jaw
  off -= 0.004 * gs(ax - 0.42, y + 0.2, 0.12) * f; // under the cheekbone
  off -= 0.0022 * gs(ax - 0.2, y + 0.28, 0.035) * f; // nasolabial folds
  off += 0.0018 * gs(ax - 0.33, y + 0.02, 0.05) * f; // under-eye
  off += 0.0062 * gs(x / 1.7, y + 0.36, 0.035) * f; // upper lip
  off += 0.0068 * gs(x / 1.6, y + 0.455, 0.04) * f; // lower lip
  off -= 0.0034 * gs(x / 2.4, y + 0.405, 0.012) * f * sstep(0.3, 0.15, ax); // mouth line
  off -= 0.003 * gs(x / 1.4, y + 0.58, 0.05) * f; // the dip above the chin
  off += 0.012 * gs(x / 1.3, y + 0.86, 0.2) * f; // chin
  out.addScaledVector(out.clone().normalize(), off);
  return out;
}
/** colour multipliers on the skin: socket shade, lips, mouth line, nostrils, stubble, short hair */
function headTint(x: number, y: number, z: number, skin: THREE.Color, hair: THREE.Color, beard: number, hairCap: boolean): [number, number, number] {
  const f = sstep(0.3, 0.8, z), ax = Math.abs(x);
  let r = 1, g = 1, b = 1;
  const sock = gs(ax - 0.33, y - 0.13, 0.11) * f;
  r -= 0.22 * sock; g -= 0.26 * sock; b -= 0.22 * sock;
  const lips = (gs(x / 1.7, y + 0.36, 0.03) + gs(x / 1.6, y + 0.455, 0.035)) * f;
  r += 0.04 * lips; g -= 0.2 * lips; b -= 0.15 * lips;
  const line = gs(x / 2.4, y + 0.405, 0.012) * f * sstep(0.3, 0.15, ax);
  r -= 0.6 * line; g -= 0.62 * line; b -= 0.6 * line;
  const nos = gs(ax - 0.07, y + 0.235, 0.025) * f;
  r -= 0.4 * nos; g -= 0.42 * nos; b -= 0.42 * nos;
  const fold = gs(ax - 0.2, y + 0.28, 0.035) * f;
  r -= 0.12 * fold; g -= 0.14 * fold; b -= 0.12 * fold;
  // cheeks and nose tip a touch warmer
  const warm = (gs(ax - 0.45, y + 0.08, 0.14) * 0.6 + gs(x, y + 0.14, 0.05)) * f;
  r += 0.03 * warm; g -= 0.02 * warm; b -= 0.02 * warm;
  // stubble / beard: jaw, chin, upper lip and the lower cheeks
  if (beard > 0) {
    const zone = sstep(-0.12, -0.32, y) * sstep(-0.15, 0.25, z + 0.1) * (1 - 0.8 * lips) * (1 - line);
    const k = zone * beard;
    const hr = hair.r / Math.max(0.05, skin.r), hg = hair.g / Math.max(0.05, skin.g), hb = hair.b / Math.max(0.05, skin.b);
    r = r * (1 - k) + hr * k; g = g * (1 - k) + hg * k; b = b * (1 - k) + hb * k;
  }
  // short cropped hair (only seen without a helmet): the crown, back and above the ears
  if (hairCap) {
    const cap = sstep(0.05, 0.3, y + 0.55 * Math.max(0, -z) - 0.45 * Math.max(0, z - 0.55)) * sstep(0.02, 0.2, y + 0.35);
    const hr = hair.r / Math.max(0.05, skin.r), hg = hair.g / Math.max(0.05, skin.g), hb = hair.b / Math.max(0.05, skin.b);
    r = r * (1 - cap) + hr * cap * 0.9; g = g * (1 - cap) + hg * cap * 0.9; b = b * (1 - cap) + hb * cap * 0.9;
  }
  return [r, g, b];
}
function sculptHead(q: 0 | 1 | 2, skin: THREE.Color, hair: THREE.Color, beard: number, hairCap: boolean, knit: THREE.Color | null) {
  const ws = q === 0 ? 40 : q === 1 ? 22 : 10, hs = q === 0 ? 30 : q === 1 ? 16 : 8;
  const g = new THREE.SphereGeometry(1, ws, hs);
  const P = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(P.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    headPoint(x, y, z, v);
    P.setXYZ(i, v.x + HEAD_C.x, v.y + HEAD_C.y, v.z + HEAD_C.z);
    let t: [number, number, number];
    if (knit) {
      // balaclava: knit everywhere but an eye opening (skin there, as a multiplier on the knit)
      const open = sstep(0.55, 0.75, z) * sstep(-0.03, 0.05, y) * sstep(0.27, 0.2, y) * sstep(0.7, 0.55, Math.abs(x));
      const sk = headTint(x, y, z, skin, hair, 0, false);
      t = [1 + (skin.r / knit.r * sk[0] - 1) * open, 1 + (skin.g / knit.g * sk[1] - 1) * open, 1 + (skin.b / knit.b * sk[2] - 1) * open];
    } else t = headTint(x, y, z, skin, hair, beard, hairCap);
    col[i * 3] = t[0]; col[i * 3 + 1] = t[1]; col[i * 3 + 2] = t[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
/** a point on the head for a face direction (placing eyes, brows, glasses) — world-rest space */
function onHead(x: number, y: number, inset = 0) {
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const p = headPoint(x, y, z);
  p.addScaledVector(p.clone().normalize(), -inset);
  return p.add(HEAD_C);
}

// ------------------------------------------------------------------ the soldier

/**
 * Build one detail level. q: 0 full (≈7-9k triangles), 1 medium (≈2.5k), 2 far (≈900).
 */
export function buildSoldierGeometry(look: SoldierLook, team: 0 | 1, q: 0 | 1 | 2): THREE.BufferGeometry {
  const v = varietyFor(look, team);
  const role = look.role;
  const B = new SkinBuilder();
  const segs = q === 0 ? 14 : q === 1 ? 9 : 6;
  const segL = q === 0 ? 12 : q === 1 ? 8 : 5;
  const detail = q === 0, mid = q <= 1;
  const cloth = C(0xffffff);
  const pants = C(0xe8e8e8);
  const sleeves = C(0xf6f6f6);
  const gear = v.gear, gear2 = v.gear2;
  const black = C(0x1d1d1d);
  const metal = C(0x2c2e30);

  // ---- torso (jacket / combat shirt), skinned along the spine
  const T: [number, number, number, number][] = [
    [0.86, 0.15, 0.105, 0],
    [0.93, 0.165, 0.115, 0],
    [1.0, 0.161, 0.112, 0],
    [1.08, 0.152, 0.106, 0.004],
    [1.18, 0.162, 0.112, 0.01],
    [1.28, 0.176, 0.118, 0.01],
    [1.36, 0.183, 0.118, 0],
    [1.42, 0.172, 0.106, -0.01],
    [1.465, 0.105, 0.08, -0.01],
    [1.5, 0.064, 0.062, -0.006],
    [1.58, 0.058, 0.06, 0.004],
  ];
  B.tube(T.slice().reverse().map(([y, rx, rz, z]) => ({ c: V(0, y, z), rx, rz, w: spineW(y) })), segs + 2, y0Tint(cloth), K_CAMO, { ex: 2.6, capB: true });
  // ---- legs (trousers), knees, boots
  for (const s of [1, -1]) {
    const L = s > 0 ? 'Left' : 'Right';
    const x = 0.095 * s;
    const legRings: [number, number, number, number][] = [
      [0.99, 0.1, 0.104, 0],
      [0.88, 0.091, 0.095, 0.004],
      [0.74, 0.08, 0.083, 0.006],
      [0.61, 0.068, 0.072, 0.008],
      [0.53, 0.063, 0.068, 0.012],
      [0.46, 0.061, 0.066, 0.004],
      [0.36, 0.06, 0.066, -0.01],
      [0.24, 0.052, 0.054, -0.01],
      [0.15, 0.057, 0.06, -0.012],
    ];
    B.tube(legRings.map(([y, rx, rz, z]) => {
      const w: Weights = y > 0.9 ? [['Hips', sstep(0.93, 1.0, y) * 0.6], [`${L}UpLeg`, 1 - sstep(0.93, 1.0, y) * 0.6]] : y > 0.48 ? [[`${L}UpLeg`, sstep(0.49, 0.57, y)], [`${L}Leg`, 1 - sstep(0.49, 0.57, y)]] : [[`${L}Leg`, 1]];
      return { c: V(x + (y > 0.9 ? 0.012 * s : 0), y, z), rx, rz, w };
    }), segL, pants, K_CAMO, { ex: 2.2 });
    // boot: upper + foot + sole
    B.tube([
      { c: V(x, 0.2, -0.012), rx: 0.058, rz: 0.062, w: [[`${L}Leg`, 1]] },
      { c: V(x, 0.1, -0.01), rx: 0.058, rz: 0.066, w: [[`${L}Leg`, 0.3], [`${L}Foot`, 0.7]] },
      { c: V(x, 0.05, -0.006), rx: 0.056, rz: 0.07, w: [[`${L}Foot`, 1]] },
    ], segL, v.boots, K_FLAT, { rough: 0.75, capB: true });
    B.rigid(rbox(0.095, 0.07, 0.17, 0.03, mid ? 2 : 1), [[`${L}Foot`, 0.55], [`${L}ToeBase`, 0.45]], [x, 0.045, 0.06], v.boots, K_FLAT, { rough: 0.7 });
    B.rigid(rbox(0.1, 0.022, 0.26, 0.008, 1), [[`${L}Foot`, 0.5], [`${L}ToeBase`, 0.5]], [x, 0.011, 0.04], shade(v.boots, 0.5), K_FLAT, { rough: 0.95 });
    if (v.kneePads && mid) {
      B.rigid(rbox(0.1, 0.12, 0.05, 0.022), `${L}Leg`, [x, 0.5, 0.075], shade(gear, 0.8), K_HARD, { rough: 0.55, rot: [0.15, 0, 0] });
      if (detail) B.tube([{ c: V(x, 0.47, 0.0), rx: 0.068, rz: 0.074, w: [[`${L}Leg`, 1]] }, { c: V(x, 0.455, 0.0), rx: 0.068, rz: 0.074, w: [[`${L}Leg`, 1]] }], segL, C(0x1c1c1a), K_WEB, { rough: 0.9 });
    }
    // cargo pocket on the thigh
    if (detail) B.rigid(rbox(0.035, 0.15, 0.12, 0.012), `${L}UpLeg`, [x + 0.085 * s, 0.7, 0.005], shade(pants, 0.94), K_CAMO, { uv: 0.4 });
  }
  // ---- arms (sleeves), gloves
  for (const s of [1, -1]) {
    const L = s > 0 ? 'Left' : 'Right';
    const x = 0.185 * s;
    const rolled = v.rolledSleeves;
    const upper: [number, number, number][] = [
      [1.48, 0.06, 0.068],
      [1.43, 0.066, 0.068],
      [1.33, 0.06, 0.06],
      [1.22, 0.053, 0.054],
      [1.16, 0.05, 0.052],
    ];
    B.tube(upper.map(([y, rx, rz]) => ({
      c: V(x - 0.006 * s, y, -0.01),
      rx,
      rz,
      w: y > 1.4 ? [['Spine2', sstep(1.42, 1.5, y) * 0.7], [`${L}Shoulder`, sstep(1.42, 1.5, y) * 0.3], [`${L}Arm`, 1 - sstep(1.42, 1.5, y)]] : y > 1.15 ? [[`${L}Arm`, sstep(1.13, 1.2, y)], [`${L}ForeArm`, 1 - sstep(1.13, 1.2, y)]] : [[`${L}ForeArm`, 1]],
    })), segL, sleeves, K_CAMO, { capA: true });
    const fore: [number, number, number][] = [
      [1.16, 0.05, 0.052],
      [1.06, 0.047, 0.049],
      [0.97, 0.04, 0.042],
      [0.915, 0.036, 0.038],
    ];
    B.tube(fore.map(([y, rx, rz]) => ({ c: V(x, y, -0.006), rx, rz, w: y > 1.12 ? [[`${L}Arm`, 0.3], [`${L}ForeArm`, 0.7]] : y > 0.93 ? [[`${L}ForeArm`, 1]] : [[`${L}ForeArm`, 0.5], [`${L}Hand`, 0.5]] })), segL, rolled ? v.skin : sleeves, rolled ? K_FLAT : K_CAMO, { rough: rolled ? 0.6 : 0.88 });
    if (rolled) B.tube([{ c: V(x, 1.175, -0.008), rx: 0.056, rz: 0.058, w: [[`${L}Arm`, 0.4], [`${L}ForeArm`, 0.6]] }, { c: V(x, 1.135, -0.008), rx: 0.054, rz: 0.056, w: [[`${L}ForeArm`, 1]] }], segL, shade(sleeves, 0.9), K_CAMO);
    // team armband
    B.tube([{ c: V(x - 0.006 * s, 1.37, -0.01), rx: 0.066, rz: 0.066, w: [[`${L}Arm`, 1]] }, { c: V(x - 0.006 * s, 1.32, -0.01), rx: 0.063, rz: 0.063, w: [[`${L}Arm`, 1]] }], segL, C(0xffffff), K_TEAM, { rough: 0.6 });
    // glove: cuff, palm, finger block, thumb
    B.tube([{ c: V(x, 0.95, -0.004), rx: 0.042, rz: 0.044, w: [[`${L}ForeArm`, 1]] }, { c: V(x, 0.9, 0), rx: 0.04, rz: 0.042, w: [[`${L}Hand`, 1]] }], segL, v.gloves, K_FLAT, { rough: 0.7 });
    // glove (Update 46): a shaped palm, a hard knuckle guard, four fingers (one block far away)
    B.rigid(rbox(0.03, 0.088, 0.08, 0.013), `${L}Hand`, [x, 0.86, 0.008], v.gloves, K_FLAT, { rough: 0.72 });
    if (mid) B.rigid(rbox(0.012, 0.03, 0.07, 0.005), `${L}Hand`, [x + 0.016 * s, 0.832, 0.01], shade(v.gloves, 0.6), K_HARD, { rough: 0.45 });
    if (detail) {
      for (let f = 0; f < 4; f++) {
        const fz = 0.042 - f * 0.022;
        B.rigid(rbox(0.017, 0.078 - Math.abs(f - 1.2) * 0.008, 0.019, 0.008), `${L}HandIndex1`, [x - 0.002 * s, 0.776, 0.016 + fz - 0.016], v.gloves, K_FLAT, { rough: 0.72 });
      }
    } else B.rigid(rbox(0.028, 0.085, 0.078, 0.012), `${L}HandIndex1`, [x - 0.002 * s, 0.775, 0.016], v.gloves, K_FLAT, { rough: 0.7 });
    B.rigid(rbox(0.022, 0.06, 0.024, 0.01), `${L}HandThumb1`, [x - 0.018 * s, 0.85, 0.05], v.gloves, K_FLAT, { rough: 0.72, rot: [0.3, 0, 0.2 * s] });
    if (detail && role === 'breacher') B.rigid(rbox(0.08, 0.1, 0.06, 0.02), `${L}ForeArm`, [x, 1.14, -0.05], shade(gear, 0.8), K_FLAT, { rough: 0.6 });
  }
  // ---- head (Update 46: one sculpted mesh with the features in it, real eyes, brows and ears)
  const skin = v.skin;
  const headW: Weights = [['Head', 1]];
  const balaclava = v.face === 'balaclava';
  const knitCol = C(0x24251f);
  const helmeted = role === 'rifleman' || role === 'gunner' || role === 'breacher' || (role === 'cqb' && look.seed % 3 !== 0);
  const beard = v.face === 'beard' ? 0.85 : v.face === 'paint' ? 0 : look.seed % 3 === 0 ? 0.35 : 0.12;
  B.add(sculptHead(q, balaclava ? knitCol : skin, v.hair, beard, !helmeted && role !== 'sniper', balaclava ? knitCol : null), headW, balaclava ? knitCol : skin, balaclava ? K_KNIT : K_SKIN, balaclava ? 0.95 : 0.55);
  if (mid) {
    for (const s of [1, -1]) {
      // eyes: a white set back in the socket with a dark iris; a heavy upper lid shadows them
      const e = onHead(0.33 * s, 0.12, 0.0075);
      B.rigid(sph(0.0112, q === 0 ? 12 : 8, q === 0 ? 8 : 6), headW, [e.x, e.y, e.z], C(0xe4ded4), K_FLAT, { rough: 0.2 });
      B.rigid(sph(0.0058, 8, 6), headW, [e.x - 0.0008 * s, e.y + 0.0004, e.z + 0.0083], C(look.seed % 4 === 0 ? 0x3c5262 : 0x2a1d14), K_FLAT, { rough: 0.12 });
      const lid = onHead(0.33 * s, 0.165, 0.0005);
      B.rigid(ell(0.013, 0.0045, 0.006, 8, 5), headW, [lid.x, lid.y, lid.z], balaclava ? knitCol : shade(skin, 0.86), balaclava ? K_KNIT : K_SKIN, { rough: 0.6, rot: [0.35, 0, 0] });
      // brows
      if (!balaclava || detail) {
        const bw = onHead(0.34 * s, 0.27, -0.0012);
        B.rigid(rbox(0.03, 0.0065, 0.008, 0.0025, 1), headW, [bw.x, bw.y, bw.z], balaclava ? knitCol : shade(v.hair, 0.75), K_FLAT, { rough: 0.95, rot: [0.25, 0.18 * s, -0.1 * s] });
      }
      // ears: an outer rim and a darker bowl
      B.rigid(ell(0.0085, 0.027, 0.017, 8, 6), headW, [0.0735 * s, 1.684, -0.006], balaclava ? knitCol : shade(skin, 0.97), balaclava ? K_KNIT : K_SKIN, { rough: 0.6, rot: [0, 0.25 * s, 0.08 * s] });
      if (detail && !balaclava) B.rigid(ell(0.004, 0.017, 0.01, 6, 5), headW, [0.0785 * s, 1.684, -0.002], shade(skin, 0.7), K_SKIN, { rough: 0.7, rot: [0, 0.25 * s, 0.08 * s] });
    }
    if (v.face === 'paint') {
      // face paint: dark loam bands across the eyes and the cheeks
      const a = onHead(0, 0.13, -0.001), b2 = onHead(0, -0.12, -0.002);
      B.rigid(rbox(0.13, 0.016, 0.03, 0.006), headW, [0, a.y, a.z - 0.012], C(0x2c3420), K_FLAT, { rough: 0.85 });
      B.rigid(rbox(0.11, 0.014, 0.03, 0.006), headW, [0, b2.y, b2.z - 0.016], C(0x3a3020), K_FLAT, { rough: 0.85 });
    }
    if (v.face === 'gaiter') {
      // neck gaiter pulled up over the nose: follows the face down to the collar
      const gc = v.helmetCover === 'camo' ? C(0xf0f0f0) : shade(gear, 0.95);
      const ring = (dirY: number, inset: number) => {
        const p = onHead(0, dirY, -inset);
        return p;
      };
      const n0 = ring(-0.02, 0.006), m0 = ring(-0.4, 0.007), c0 = ring(-0.85, 0.006);
      B.tube([
        { c: V(0, n0.y, 0.006), rx: 0.078, rz: n0.z + 0.001, w: headW },
        { c: V(0, m0.y, 0.004), rx: 0.071, rz: m0.z, w: headW },
        { c: V(0, c0.y, 0.0), rx: 0.064, rz: c0.z - 0.004, w: [['Head', 0.6], ['Neck', 0.4]] },
        { c: V(0, 1.55, -0.004), rx: 0.068, rz: 0.07, w: [['Neck', 1]] },
        { c: V(0, 1.49, -0.008), rx: 0.085, rz: 0.08, w: [['Neck', 0.4], ['Spine2', 0.6]] },
      ], segs, gc, v.helmetCover === 'camo' ? K_CAMO : K_KNIT, { rough: 0.95 });
    }
    if (v.face === 'scarf') B.tube([{ c: V(0, 1.6, 0.012), rx: 0.08, rz: 0.08, w: [['Neck', 0.5], ['Head', 0.5]] }, { c: V(0, 1.53, 0.0), rx: 0.085, rz: 0.083, w: [['Neck', 1]] }, { c: V(0, 1.47, -0.005), rx: 0.11, rz: 0.09, w: [['Spine2', 1]] }], segs, C(0xb8ac88), K_KNIT, { rough: 1 });
  }
  // ---- headgear by role
  const helmetCol = v.helmetCover === 'camo' ? C(0xf2f2f2) : shade(gear, 1.05);
  const helmetKind = v.helmetCover === 'camo' ? K_CAMO : K_HARD;
  const helmet = helmeted;
  if (helmet) {
    // ballistic helmet (Update 46): a high-cut shell built bottom-up (normals out — the old one
    // faced inward and only its far rim showed), cut high over the ears, with a dark liner inside,
    // an edge trim, the NVG shroud, side rails, a counterweight pouch, a chinstrap and an IR strobe
    const shellGeo = (rad: number, hgt: number, n: number, rs: number) => {
      const prof: THREE.Vector2[] = [new THREE.Vector2(rad * 1.02, -0.012)];
      for (let i = 0; i <= n; i++) {
        const a = Math.PI * 0.53 * (1 - i / n);
        prof.push(new THREE.Vector2(Math.max(1e-4, Math.sin(a) * rad), Math.cos(a) * hgt));
      }
      const g = new THREE.LatheGeometry(prof, rs);
      g.scale(0.97, 1, 1.09);
      // the high cut: the rim rises over the ears, and the front edge sits up off the brow
      const P = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        const side = sstep(0.45, 0.85, Math.abs(x) / rad) * sstep(-0.6, 0.1, z / rad);
        const front = sstep(0.6, 0.95, z / (rad * 1.09));
        const floor = -0.012 + 0.045 * side + 0.012 * front;
        if (y < floor) P.setY(i, floor);
      }
      g.computeVertexNormals();
      return g;
    };
    const rs = q === 2 ? 10 : q === 1 ? 18 : 28, n = q === 2 ? 5 : q === 1 ? 8 : 12;
    B.rigid(shellGeo(0.126, 0.118, n, rs), headW, [0, 1.705, 0.004], helmetCol, helmetKind, { rough: v.helmetCover === 'camo' ? 0.9 : 0.62, uv: 0.4 });
    if (mid) {
      // liner: the same shell shrunk and turned inside out
      const liner = shellGeo(0.118, 0.11, n, rs);
      const ix = liner.getIndex()!;
      for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i); ix.setX(i, ix.getX(i + 2)); ix.setX(i + 2, t); }
      liner.computeVertexNormals();
      B.rigid(liner, headW, [0, 1.705, 0.004], C(0x1a1b18), K_FLAT, { rough: 0.95 });
      // NVG shroud on the front, the mount arm, side rails, the edge trim at the brow
      B.rigid(rbox(0.048, 0.034, 0.018, 0.007), headW, [0, 1.775, 0.132], C(0x2a2c2e), K_HARD, { rough: 0.45, metal: 0.35, rot: [-0.5, 0, 0] });
      for (const s of [1, -1]) {
        B.rigid(rbox(0.011, 0.028, 0.095, 0.004), headW, [0.121 * s, 1.722, 0.008], shade(gear, 0.6), K_HARD, { rough: 0.55, rot: [0, 0, -0.12 * s] });
        for (let k = 0; k < (detail ? 4 : 0); k++) B.rigid(box(0.004, 0.022, 0.006), headW, [0.127 * s, 1.722, -0.028 + k * 0.022], shade(gear, 0.45), K_HARD, { rough: 0.6 });
        // chinstrap down to the jaw
        if (detail) B.tube([{ c: V(0.104 * s, 1.705, 0.03), rx: 0.006, rz: 0.003, w: headW }, { c: V(0.08 * s, 1.63, 0.05), rx: 0.006, rz: 0.003, w: headW }, { c: V(0.045 * s, 1.585, 0.065), rx: 0.006, rz: 0.003, w: headW }], 4, C(0x1e1f1c), K_WEB, { rough: 0.9 });
      }
      // NVG: lowered (in front of the eyes) and raised (flipped up above the brow) — the shader shows one
      const nvgDown = (dx: number) => B.rigid(cyl(0.0165, 0.016, 0.07, 10).rotateX(Math.PI / 2), headW, [dx, 1.69, 0.148], C(0x1c1d1f), K_NVG_DOWN, { rough: 0.4, metal: 0.3 });
      const nvgUp = (dx: number) => B.rigid(cyl(0.0165, 0.015, 0.058, 10), headW, [dx, 1.79, 0.15], C(0x1c1d1f), K_NVG_UP, { rough: 0.4, metal: 0.3, rot: [1.05, 0, 0] });
      for (const dx of [0.032, -0.032]) {
        nvgDown(dx);
        nvgUp(dx);
      }
      B.rigid(rbox(0.04, 0.046, 0.03, 0.008), headW, [0, 1.73, 0.135], C(0x1c1d1f), K_NVG_DOWN, { rough: 0.5 });
      B.rigid(rbox(0.05, 0.022, 0.028, 0.006), headW, [0, 1.785, 0.14], C(0x1c1d1f), K_NVG_UP, { rough: 0.5, rot: [1.05, 0, 0] });
      if (v.eyes === 'goggles') {
        B.rigid(rbox(0.15, 0.04, 0.03, 0.012), headW, [0, 1.79, 0.1], C(0x2a2c2c), K_HARD, { rough: 0.6, rot: [-0.5, 0, 0] });
        B.rigid(rbox(0.12, 0.03, 0.01, 0.008), headW, [0, 1.795, 0.115], C(0x6a7c80), K_GLASS, { rough: 0.15, rot: [-0.5, 0, 0] });
      }
      // counterweight / battery pouch on the back, an IR strobe on top
      B.rigid(rbox(0.06, 0.034, 0.03, 0.008), headW, [0, 1.75, -0.122], shade(gear2, 0.9), K_WEB, { rough: 0.9, rot: [-0.6, 0, 0] });
      if (look.seed % 2 === 0) {
        B.rigid(rbox(0.022, 0.014, 0.03, 0.005), headW, [0.03, 1.818, -0.04], C(0x1d1e1c), K_HARD, { rough: 0.5, rot: [0.3, 0, 0.12] });
        B.rigid(sph(0.0055, 6, 4), headW, [0.03, 1.828, -0.04], C(0x9adfb0), K_STROBE, { rough: 0.3 });
      }
    }
  } else if (role === 'sniper') {
    // ghillie hood: a hood shell and loose burlap strands over head and shoulders
    const hood = new THREE.LatheGeometry([1.7, 1.5, 1.2, 0.9, 0.6, 0.3, 0].map((a) => new THREE.Vector2(Math.max(1e-4, Math.sin(a) * 0.135), Math.cos(a) * 0.13)), q === 2 ? 8 : 14);
    hood.scale(1, 1, 1.12);
    B.rigid(hood, headW, [0, 1.7, -0.01], C(0x5a5a3c), K_FLAT, { rough: 1 });
    const r = new RNG(look.seed + 11);
    const strands = q === 0 ? 70 : q === 1 ? 26 : 8;
    const cols = [0x4a5030, 0x6a6a40, 0x5a4a30, 0x3a4228, 0x7a7048];
    for (let i = 0; i < strands; i++) {
      const onHead = i < strands * 0.55;
      const a = r.range(-Math.PI * 0.95, Math.PI * 0.95);
      const len = r.range(0.08, 0.2);
      const at: [number, number, number] = onHead ? [Math.sin(a) * 0.12, r.range(1.64, 1.82), Math.cos(a) * 0.12 - 0.02] : [r.range(-0.22, 0.22), r.range(1.3, 1.46), r.range(-0.15, 0.08)];
      B.rigid(box(r.range(0.012, 0.03), len, 0.006), onHead ? headW : [['Spine2', 1]], at, C(r.pick(cols)), K_FLAT, { rough: 1, rot: [r.range(-0.6, 0.6), a, r.range(-0.5, 0.5)] });
    }
  } else {
    // boonie hat (marksman / light CQB)
    const crown = new THREE.CylinderGeometry(0.098, 0.108, 0.08, q === 2 ? 8 : 16, 1, false);
    B.rigid(crown, headW, [0, 1.77, 0.004], shade(cloth, 1), K_CAMO, { rough: 0.95, uv: 0.4 });
    const brim = new THREE.CylinderGeometry(0.17, 0.175, 0.012, q === 2 ? 8 : 18);
    B.rigid(brim, headW, [0, 1.735, 0.006], shade(cloth, 0.95), K_CAMO, { rough: 0.95, uv: 0.6, rot: [0.08, 0, 0] });
    if (role === 'cqb' && mid) B.rigid(rbox(0.16, 0.024, 0.028, 0.01), headW, [0, 1.7, 0.02], C(0x2a2a2a), K_FLAT, { rough: 0.5 }); // headset band
  }
  if (v.earPro && mid && role !== 'sniper') {
    // electronic ear defenders: cups over the ears, a mic boom on the left
    for (const s of [1, -1]) {
      B.rigid(cyl(0.034, 0.036, 0.028, 14).rotateZ(Math.PI / 2), headW, [0.091 * s, 1.678, -0.004], C(0x2e302c), K_HARD, { rough: 0.55 });
      if (detail) B.rigid(cyl(0.03, 0.03, 0.006, 14).rotateZ(Math.PI / 2), headW, [0.106 * s, 1.678, -0.004], C(0x1c1d1b), K_HARD, { rough: 0.7 });
    }
    if (detail) B.rigid(cyl(0.0022, 0.0022, 0.075, 5), headW, [-0.085, 1.645, 0.055], C(0x151515), K_HARD, { rough: 0.5, rot: [Math.PI / 2, 0.55, 0] });
  }
  if (v.eyes === 'glasses' && mid) {
    // ballistic glasses: a wrap lens in front of the eyes and arms back to the ears
    const g0 = onHead(0, 0.13, -0.012);
    B.rigid(rbox(0.128, 0.03, 0.006, 0.006), headW, [0, g0.y, g0.z], C(0x15181c), K_GLASS, { rough: 0.08, metal: 0.3 });
    for (const s of [1, -1]) B.rigid(box(0.004, 0.006, 0.085), headW, [0.069 * s, g0.y + 0.004, g0.z - 0.05], C(0x111214), K_HARD, { rough: 0.4 });
  }

  // ---- load-bearing kit by role (Update 46: nylon webbing with MOLLE rows, real pouch contents)
  const plates = role === 'rifleman' || role === 'breacher' || role === 'gunner';
  const S2: Weights = [['Spine2', 1]];
  const S1: Weights = [['Spine1', 1]];
  const magCol = C(0x1f2022), magTop = C(0x8a6a3a);
  /** a rifle magazine standing in its pouch: the body, the floorplate and a pull tab */
  const magInPouch = (x: number, y: number, z: number, w: Weights) => {
    B.rigid(rbox(0.028, 0.05, 0.022, 0.004), w, [x, y, z], magCol, K_HARD, { rough: 0.55 });
    if (detail) {
      B.rigid(rbox(0.032, 0.008, 0.026, 0.003), w, [x, y + 0.028, z], shade(magCol, 0.8), K_HARD, { rough: 0.6 });
      B.rigid(rbox(0.012, 0.016, 0.004, 0.002), w, [x, y + 0.036, z + 0.006], magTop, K_WEB, { rough: 0.9 });
    }
  };
  if (plates) {
    // plate carrier: shaped front / back plates (chamfered upper corners), cummerbund, padded
    // shoulder straps, a mag pouch row with the magazines in it, admin panel, radio, tourniquet
    const thick = role === 'breacher' ? 0.055 : 0.045;
    const plate = (w: number, h: number) => {
      const sh = new THREE.Shape();
      const c = 0.06;
      sh.moveTo(-w / 2, -h / 2); sh.lineTo(w / 2, -h / 2); sh.lineTo(w / 2, h / 2 - c); sh.lineTo(w / 2 - c * 0.8, h / 2); sh.lineTo(-w / 2 + c * 0.8, h / 2); sh.lineTo(-w / 2, h / 2 - c); sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: thick - 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.008, bevelSegments: 2, curveSegments: 2 });
      g.translate(0, 0, -(thick - 0.012) / 2);
      g.computeVertexNormals();
      return g;
    };
    B.rigid(plate(0.3, 0.32), [['Spine2', 0.75], ['Spine1', 0.25]], [0, 1.255, 0.142], gear, K_WEB, { rough: 0.88 });
    B.rigid(plate(0.3, 0.33), [['Spine2', 0.8], ['Spine1', 0.2]], [0, 1.27, -0.135], gear, K_WEB, { rough: 0.88 });
    B.tube([{ c: V(0, 1.2, 0.0), rx: 0.188, rz: 0.142, w: S1 }, { c: V(0, 1.1, 0.0), rx: 0.178, rz: 0.134, w: [['Spine1', 0.5], ['Spine', 0.5]] }], segs, gear, K_WEB, { rough: 0.88, ex: 2.6 });
    for (const s of [1, -1]) {
      B.rigid(rbox(0.065, 0.025, 0.28, 0.01), S2, [0.1 * s, 1.445, 0.0], gear, K_WEB, { rough: 0.88 });
      if (mid) B.rigid(rbox(0.07, 0.03, 0.12, 0.012), S2, [0.1 * s, 1.462, 0.02], shade(gear, 0.92), K_WEB, { rough: 0.95 }); // shoulder pads
    }
    const n = v.pouches;
    for (let i = 0; i < n; i++) {
      const px = (i - (n - 1) / 2) * 0.072;
      const w: Weights = [['Spine1', 0.6], ['Spine2', 0.4]];
      B.rigid(rbox(0.064, 0.1, 0.05, 0.01), w, [px, 1.14, 0.185], gear2, K_WEB, { rough: 0.9 });
      if (mid) magInPouch(px, 1.205, 0.185, w);
      if (detail) B.rigid(box(0.066, 0.006, 0.052), w, [px, 1.188, 0.186], shade(gear2, 0.8), K_WEB, { rough: 0.95 }); // elastic retention band
    }
    if (mid) {
      B.rigid(rbox(0.14, 0.08, 0.026, 0.01), S2, [0, 1.36, 0.172], shade(gear2, 0.9), K_WEB, { rough: 0.9 }); // admin pouch
      // velcro ID patch on the admin pouch, in the team colour
      if (detail) B.rigid(rbox(0.05, 0.025, 0.004, 0.002), S2, [0.03, 1.372, 0.186], C(0xffffff), K_TEAM, { rough: 0.8 });
      // radio on the left side of the cummerbund with its antenna
      B.rigid(rbox(0.035, 0.11, 0.06, 0.008), S1, [-0.19, 1.17, 0.03], C(0x2a2c28), K_HARD, { rough: 0.6 });
      B.rigid(cyl(0.004, 0.0025, 0.16, 5), S1, [-0.2, 1.3, 0.03], C(0x111111), K_HARD, { rough: 0.5, rot: [0, 0, 0.12] });
      // tourniquet in its pouch on the right shoulder strap
      B.rigid(rbox(0.03, 0.06, 0.03, 0.006), S2, [0.1, 1.38, 0.15], C(0x1b1b1b), K_WEB, { rough: 0.9 });
      if (detail) B.rigid(rbox(0.012, 0.03, 0.02, 0.003), S2, [0.1, 1.42, 0.15], C(0xb02018), K_HARD, { rough: 0.6 });
    }
    if (role === 'breacher') {
      // shell bandolier across the chest + shells
      B.rigid(rbox(0.06, 0.5, 0.02, 0.008), S2, [0, 1.27, 0.175], C(0x3a3428), K_WEB, { rough: 0.9, rot: [0, 0, 0.75] });
      if (detail) for (let i = 0; i < 9; i++) B.rigid(cyl(0.009, 0.009, 0.045, 6), S2, [-0.15 + i * 0.037, 1.14 + i * 0.033, 0.19], C(i % 2 ? 0xa02a20 : 0x8a2018), K_HARD, { rough: 0.5, rot: [0, 0, 0.75] });
      // breaching bar on the back
      B.rigid(cyl(0.012, 0.012, 0.6, 6), S2, [0.08, 1.3, -0.18], C(0x3a3a3a), K_FLAT, { rough: 0.5, metal: 0.6, rot: [0, 0, 0.35] });
    }
  } else {
    // chest rig: a lighter harness with pouches across the stomach
    B.tube([{ c: V(0, 1.26, 0.0), rx: 0.185, rz: 0.128, w: S2 }, { c: V(0, 1.12, 0.0), rx: 0.172, rz: 0.124, w: S1 }], segs, shade(gear, 0.95), K_WEB, { rough: 0.9, ex: 2.6 });
    for (const s of [1, -1]) B.rigid(rbox(0.05, 0.02, 0.27, 0.008), S2, [0.1 * s, 1.44, 0.0], shade(gear, 0.9), K_WEB, { rough: 0.9 });
    const n = role === 'sniper' ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const px = (i - (n - 1) / 2) * 0.078;
      const w: Weights = [['Spine1', 0.7], ['Spine', 0.3]];
      B.rigid(rbox(0.07, 0.09, 0.045, 0.01), w, [px, 1.125, 0.155], gear2, K_WEB, { rough: 0.9 });
      if (mid) magInPouch(px, 1.18, 0.155, w);
    }
    if (role === 'marksman' || role === 'sniper') B.rigid(rbox(0.06, 0.09, 0.05, 0.012), S2, [-0.1, 1.3, 0.15], shade(gear2, 0.85), K_WEB, { rough: 0.9 }); // rangefinder / data book
  }
  // shoulder flag patch on the left upper arm (Norway / Nordfront), sewn on, subdued
  if (mid) B.rigid(rbox(0.004, 0.045, 0.062, 0.0015), [['LeftArm', 1]], [0.243, 1.36, -0.008], C(0xffffff), K_PATCH, { rough: 0.85, rot: [0, 0, -0.1] });
  // belt with pouches, thigh holster
  B.tube([{ c: V(0, 1.035, 0), rx: 0.172, rz: 0.124, w: [['Hips', 0.7], ['Spine', 0.3]] }, { c: V(0, 0.985, 0), rx: 0.172, rz: 0.124, w: [['Hips', 1]] }], segs, shade(gear, 0.8), K_WEB, { rough: 0.85, ex: 2.6 });
  if (mid) {
    B.rigid(rbox(0.06, 0.08, 0.05, 0.012), [['Hips', 1]], [0.16, 0.99, 0.06], gear2, K_WEB, { rough: 0.9, rot: [0, 0.6, 0] });
    B.rigid(rbox(0.07, 0.08, 0.05, 0.012), [['Hips', 1]], [0.12, 0.99, -0.12], gear2, K_WEB, { rough: 0.9, rot: [0, -0.5, 0] });
    // buckle
    if (detail) B.rigid(rbox(0.045, 0.03, 0.012, 0.004), [['Hips', 1]], [0, 1.01, 0.128], C(0x1a1a1a), K_HARD, { rough: 0.45, metal: 0.3 });
    B.rigid(rbox(0.05, 0.16, 0.06, 0.012), 'RightUpLeg', [-0.175, 0.83, 0.01], C(0x222222), K_HARD, { rough: 0.6 });
    if (detail) B.rigid(rbox(0.04, 0.12, 0.035, 0.01), 'RightUpLeg', [-0.17, 0.8, 0.045], C(0x1a1a1a), K_HARD, { rough: 0.4 }); // pistol grip in the holster
    // leg strap of the holster
    if (detail) B.tube([{ c: V(-0.105, 0.78, 0.0), rx: 0.098, rz: 0.1, w: [['RightUpLeg', 1]] }, { c: V(-0.105, 0.765, 0.0), rx: 0.098, rz: 0.1, w: [['RightUpLeg', 1]] }], segL, C(0x1c1c1a), K_WEB, { rough: 0.9 });
  }
  // packs
  if (role === 'gunner') {
    B.rigid(rbox(0.3, 0.38, 0.17, 0.03), S2, [0, 1.22, -0.235], shade(gear, 0.92), K_WEB, { rough: 0.95 });
    B.rigid(rbox(0.17, 0.12, 0.1, 0.02), [['Hips', 1]], [0.19, 0.98, 0.04], shade(gear2, 0.9), K_WEB, { rough: 0.9, rot: [0, 0.4, 0] }); // ammo pouch
    if (mid) B.rigid(rbox(0.28, 0.05, 0.03, 0.01), S2, [0, 1.4, -0.33], C(0x3a3a30), K_FLAT, { rough: 0.9 });
  } else if (v.pack === 'assault' && plates) {
    B.rigid(rbox(0.26, 0.32, 0.12, 0.03), S2, [0, 1.23, -0.215], shade(gear2, 0.95), K_WEB, { rough: 0.95 });
    if (mid) for (const s of [1, -1]) B.rigid(rbox(0.03, 0.3, 0.02, 0.006), S2, [0.1 * s, 1.24, -0.15], shade(gear2, 0.8), K_WEB, { rough: 0.95 }); // pack straps
  } else if (v.pack === 'radio' || (role === 'rifleman' && look.seed % 4 === 1)) {
    B.rigid(rbox(0.12, 0.2, 0.08, 0.015), S2, [0.07, 1.28, -0.195], C(0x30322c), K_FLAT, { rough: 0.7 });
    if (mid) B.rigid(cyl(0.004, 0.006, 0.42, 5), S2, [0.1, 1.55, -0.2], C(0x111111), K_FLAT, { rough: 0.5, rot: [-0.08, 0, -0.06] });
  }
  if (role === 'sniper' && mid) {
    // drag bag across the back
    B.rigid(rbox(0.12, 0.62, 0.08, 0.03), S2, [-0.05, 1.18, -0.17], shade(gear, 0.9), K_FLAT, { rough: 0.95, rot: [0, 0, -0.5] });
  }
  const g = B.build();
  // build: scale the mesh like the skeleton (buildSkeleton(height, width))
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setXY(i, p.getX(i) * v.width, p.getY(i) * v.height);
  g.computeBoundingSphere();
  return g;
}

/** jacket tint (slightly lighter than the trousers so the silhouette reads in two tones) */
function y0Tint(c: THREE.Color) {
  return c.clone();
}

export { REST };
