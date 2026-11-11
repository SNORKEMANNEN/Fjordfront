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
  face: 'bare' | 'beard' | 'balaclava' | 'paint' | 'scarf';
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
  const face = role === 'sniper' ? r.pick(['paint', 'paint', 'scarf'] as const) : role === 'breacher' ? r.pick(['balaclava', 'balaclava', 'beard'] as const) : r.pick(['bare', 'bare', 'beard', 'balaclava', 'scarf', 'paint'] as const);
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
    eyes: role === 'sniper' ? 'none' : r.pick(['none', 'none', 'glasses', 'goggles'] as const),
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
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    const fixed = typeof weights === 'function' ? null : this.resolve(weights);
    let last: Weights | null = null, lastR: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      this.pos.push(x, y, z);
      this.nor.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      this.uv.push(UV ? UV[i * 2] * uvScale : 0, UV ? UV[i * 2 + 1] * uvScale : 0);
      this.col.push(color.r, color.g, color.b);
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
    if (v.kneePads && mid) B.rigid(rbox(0.1, 0.12, 0.05, 0.02), `${L}Leg`, [x, 0.5, 0.075], shade(gear, 0.8), K_FLAT, { rough: 0.6, rot: [0.15, 0, 0] });
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
    B.rigid(rbox(0.032, 0.09, 0.085, 0.014), `${L}Hand`, [x, 0.86, 0.008], v.gloves, K_FLAT, { rough: 0.7 });
    B.rigid(rbox(0.028, 0.085, 0.078, 0.012), `${L}HandIndex1`, [x - 0.002 * s, 0.775, 0.016], v.gloves, K_FLAT, { rough: 0.7 });
    B.rigid(rbox(0.024, 0.06, 0.024, 0.01), `${L}HandThumb1`, [x - 0.018 * s, 0.85, 0.05], v.gloves, K_FLAT, { rough: 0.7, rot: [0.3, 0, 0.2 * s] });
    if (detail && role === 'breacher') B.rigid(rbox(0.08, 0.1, 0.06, 0.02), `${L}ForeArm`, [x, 1.14, -0.05], shade(gear, 0.8), K_FLAT, { rough: 0.6 });
  }
  // ---- head
  const skin = v.skin;
  const headW: Weights = [['Head', 1]];
  const balaclava = v.face === 'balaclava';
  const headCol = balaclava ? C(0x24251f) : skin;
  // skull (back of the head is fuller), face, jaw and cheekbones
  B.rigid(ell(0.079, 0.1, 0.094, q === 2 ? 8 : 14, q === 2 ? 6 : 10), headW, [0, 1.7, -0.004], headCol, K_FLAT, { rough: balaclava ? 0.95 : 0.6 });
  B.rigid(ell(0.07, 0.075, 0.07, q === 2 ? 6 : 12, 8), headW, [0, 1.655, 0.03], headCol, K_FLAT, { rough: balaclava ? 0.95 : 0.6 });
  if (mid) {
    B.rigid(rbox(0.1, 0.05, 0.07, 0.024), headW, [0, 1.612, 0.04], headCol, K_FLAT, { rough: balaclava ? 0.95 : 0.6, rot: [0.25, 0, 0] }); // jaw
    for (const s of [1, -1]) B.rigid(ell(0.024, 0.02, 0.03, 6, 5), headW, [0.045 * s, 1.664, 0.072], headCol, K_FLAT, { rough: 0.6 }); // cheekbones
  }
  if (mid) {
    // nose, brow, ears, eyes
    B.rigid(ell(0.014, 0.024, 0.02, 6, 5), headW, [0, 1.668, 0.094], balaclava ? headCol : shade(skin, 0.96), K_FLAT, { rough: 0.55 });
    if (detail) {
      for (const s of [1, -1]) {
        B.rigid(ell(0.012, 0.024, 0.018, 6, 5), headW, [0.079 * s, 1.675, -0.004], balaclava ? headCol : shade(skin, 0.94), K_FLAT, { rough: 0.6 });
        B.rigid(ell(0.012, 0.007, 0.006, 6, 4), headW, [0.03 * s, 1.692, 0.085], C(0x15120f), K_FLAT, { rough: 0.3 });
      }
      B.rigid(rbox(0.095, 0.012, 0.02, 0.005), headW, [0, 1.706, 0.082], balaclava ? C(0x15120f) : shade(v.hair, 1), K_FLAT, { rough: 0.9 });
    }
    if (balaclava) B.rigid(rbox(0.1, 0.032, 0.026, 0.012), headW, [0, 1.69, 0.08], skin, K_FLAT, { rough: 0.55 });
    if (v.face === 'beard') B.rigid(ell(0.066, 0.05, 0.066, 10, 7), headW, [0, 1.618, 0.045], shade(v.hair, 0.9), K_FLAT, { rough: 1 });
    if (v.face === 'paint') {
      B.rigid(rbox(0.13, 0.02, 0.03, 0.008), headW, [0, 1.67, 0.088], C(0x2c3420), K_FLAT, { rough: 0.8 });
      B.rigid(rbox(0.1, 0.018, 0.03, 0.008), headW, [0, 1.64, 0.085], C(0x3a3020), K_FLAT, { rough: 0.8 });
    }
    if (v.face === 'scarf') B.tube([{ c: V(0, 1.6, 0.012), rx: 0.08, rz: 0.08, w: [['Neck', 0.5], ['Head', 0.5]] }, { c: V(0, 1.53, 0.0), rx: 0.085, rz: 0.083, w: [['Neck', 1]] }, { c: V(0, 1.47, -0.005), rx: 0.11, rz: 0.09, w: [['Spine2', 1]] }], segs, C(0xb8ac88), K_FLAT, { rough: 1 });
  }
  // ---- headgear by role
  const helmetCol = v.helmetCover === 'camo' ? C(0xf2f2f2) : shade(gear, 1.05);
  const helmetKind = v.helmetCover === 'camo' ? K_CAMO : K_FLAT;
  const helmet = role === 'rifleman' || role === 'gunner' || role === 'breacher' || (role === 'cqb' && look.seed % 3 !== 0);
  if (helmet) {
    // ballistic helmet: a shell lathe with a high cut over the ears
    const prof: THREE.Vector2[] = [];
    const n = q === 2 ? 6 : 10;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 0.53;
      prof.push(new THREE.Vector2(Math.sin(a) * 0.125, Math.cos(a) * 0.118));
    }
    prof.push(new THREE.Vector2(0.128, -0.005));
    const shell = new THREE.LatheGeometry(prof, q === 2 ? 10 : 18);
    shell.scale(0.98, 1, 1.08);
    B.rigid(shell, headW, [0, 1.705, 0.004], helmetCol, helmetKind, { rough: 0.8, uv: 0.4 });
    if (mid) {
      // front NVG shroud, side rails
      B.rigid(rbox(0.05, 0.035, 0.025, 0.008), headW, [0, 1.79, 0.118], metal, K_FLAT, { rough: 0.5, metal: 0.4, rot: [-0.45, 0, 0] });
      for (const s of [1, -1]) B.rigid(rbox(0.012, 0.03, 0.09, 0.005), headW, [0.122 * s, 1.72, 0.01], shade(gear, 0.7), K_FLAT, { rough: 0.6 });
      // NVG: raised (on the helmet) and lowered (in front of the eyes) — the shader shows one
      const nvgDown = (dx: number) => B.rigid(cyl(0.017, 0.016, 0.075, 8).rotateX(Math.PI / 2), headW, [dx, 1.69, 0.145], C(0x1c1d1f), K_NVG_DOWN, { rough: 0.4, metal: 0.3 });
      const nvgUp = (dx: number) => B.rigid(cyl(0.017, 0.016, 0.07, 8), headW, [dx, 1.805, 0.13], C(0x1c1d1f), K_NVG_UP, { rough: 0.4, metal: 0.3, rot: [1.15, 0, 0] });
      for (const dx of [0.032, -0.032]) {
        nvgDown(dx);
        nvgUp(dx);
      }
      B.rigid(rbox(0.04, 0.05, 0.03, 0.008), headW, [0, 1.73, 0.13], C(0x1c1d1f), K_NVG_DOWN, { rough: 0.5 });
      if (v.eyes === 'goggles') {
        B.rigid(rbox(0.15, 0.04, 0.03, 0.012), headW, [0, 1.79, 0.09], C(0x2a2c2c), K_FLAT, { rough: 0.6, rot: [-0.5, 0, 0] });
        B.rigid(rbox(0.12, 0.03, 0.01, 0.008), headW, [0, 1.795, 0.105], C(0x6a7c80), K_GLASS, { rough: 0.15, rot: [-0.5, 0, 0] });
      }
      if (detail && look.seed % 2 === 0) B.rigid(rbox(0.05, 0.03, 0.06, 0.008), headW, [-0.07, 1.8, -0.08], shade(gear2, 0.9), K_FLAT, { rough: 0.8, rot: [0.4, 0, 0.3] }); // counterweight pouch
    }
  } else if (role === 'sniper') {
    // ghillie hood: a hood shell and loose burlap strands over head and shoulders
    const hood = new THREE.LatheGeometry([0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.7].map((a) => new THREE.Vector2(Math.sin(a) * 0.135, Math.cos(a) * 0.13)), q === 2 ? 8 : 14);
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
  if (v.earPro && mid && role !== 'sniper') for (const s of [1, -1]) B.rigid(cyl(0.036, 0.036, 0.03, 10).rotateZ(Math.PI / 2), headW, [0.1 * s, 1.67, 0.0], C(0x2e302c), K_FLAT, { rough: 0.6 });
  if (v.eyes === 'glasses' && mid) B.rigid(rbox(0.13, 0.026, 0.012, 0.006), headW, [0, 1.69, 0.1], C(0x111215), K_GLASS, { rough: 0.1, metal: 0.2 });

  // ---- load-bearing kit by role
  const plates = role === 'rifleman' || role === 'breacher' || role === 'gunner';
  const S2: Weights = [['Spine2', 1]];
  const S1: Weights = [['Spine1', 1]];
  if (plates) {
    // plate carrier: front / back plates, cummerbund, shoulder straps, mag pouches
    const thick = role === 'breacher' ? 0.055 : 0.045;
    B.rigid(rbox(0.31, 0.32, thick, 0.02), [['Spine2', 0.75], ['Spine1', 0.25]], [0, 1.255, 0.142], gear, K_FLAT, { rough: 0.85 });
    B.rigid(rbox(0.3, 0.33, thick, 0.02), [['Spine2', 0.8], ['Spine1', 0.2]], [0, 1.27, -0.135], gear, K_FLAT, { rough: 0.85 });
    B.tube([{ c: V(0, 1.2, 0.0), rx: 0.188, rz: 0.142, w: S1 }, { c: V(0, 1.1, 0.0), rx: 0.178, rz: 0.134, w: [['Spine1', 0.5], ['Spine', 0.5]] }], segs, gear, K_FLAT, { rough: 0.85, ex: 2.6 });
    for (const s of [1, -1]) B.rigid(rbox(0.065, 0.025, 0.28, 0.01), S2, [0.1 * s, 1.445, 0.0], gear, K_FLAT, { rough: 0.85 });
    const n = v.pouches;
    for (let i = 0; i < n; i++) {
      const px = (i - (n - 1) / 2) * 0.072;
      B.rigid(rbox(0.064, 0.12, 0.05, 0.012), [['Spine1', 0.6], ['Spine2', 0.4]], [px, 1.15, 0.185], gear2, K_FLAT, { rough: 0.9 });
      if (detail) B.rigid(box(0.06, 0.012, 0.054), [['Spine1', 0.6], ['Spine2', 0.4]], [px, 1.214, 0.186], shade(gear2, 0.85), K_FLAT, { rough: 0.9 });
    }
    if (mid) B.rigid(rbox(0.14, 0.08, 0.03, 0.01), S2, [0, 1.36, 0.172], shade(gear2, 0.9), K_FLAT, { rough: 0.9 }); // admin pouch
    if (role === 'breacher') {
      // shell bandolier across the chest + shells
      B.rigid(rbox(0.06, 0.5, 0.02, 0.008), S2, [0, 1.27, 0.175], C(0x3a3428), K_FLAT, { rough: 0.9, rot: [0, 0, 0.75] });
      if (detail) for (let i = 0; i < 9; i++) B.rigid(cyl(0.009, 0.009, 0.045, 6), S2, [-0.15 + i * 0.037, 1.14 + i * 0.033, 0.19], C(i % 2 ? 0xa02a20 : 0x8a2018), K_FLAT, { rough: 0.5, rot: [0, 0, 0.75] });
      // breaching bar on the back
      B.rigid(cyl(0.012, 0.012, 0.6, 6), S2, [0.08, 1.3, -0.18], C(0x3a3a3a), K_FLAT, { rough: 0.5, metal: 0.6, rot: [0, 0, 0.35] });
    }
  } else {
    // chest rig: a lighter harness with pouches across the stomach
    B.tube([{ c: V(0, 1.26, 0.0), rx: 0.185, rz: 0.128, w: S2 }, { c: V(0, 1.12, 0.0), rx: 0.172, rz: 0.124, w: S1 }], segs, shade(gear, 0.95), K_FLAT, { rough: 0.9, ex: 2.6 });
    for (const s of [1, -1]) B.rigid(rbox(0.05, 0.02, 0.27, 0.008), S2, [0.1 * s, 1.44, 0.0], shade(gear, 0.9), K_FLAT, { rough: 0.9 });
    const n = role === 'sniper' ? 2 : 3;
    for (let i = 0; i < n; i++) B.rigid(rbox(0.07, 0.1, 0.045, 0.012), [['Spine1', 0.7], ['Spine', 0.3]], [(i - (n - 1) / 2) * 0.078, 1.13, 0.155], gear2, K_FLAT, { rough: 0.9 });
    if (role === 'marksman' || role === 'sniper') B.rigid(rbox(0.06, 0.09, 0.05, 0.012), S2, [-0.1, 1.3, 0.15], shade(gear2, 0.85), K_FLAT, { rough: 0.9 }); // rangefinder / data book
  }
  // belt with pouches, thigh holster
  B.tube([{ c: V(0, 1.035, 0), rx: 0.172, rz: 0.124, w: [['Hips', 0.7], ['Spine', 0.3]] }, { c: V(0, 0.985, 0), rx: 0.172, rz: 0.124, w: [['Hips', 1]] }], segs, shade(gear, 0.8), K_FLAT, { rough: 0.8, ex: 2.6 });
  if (mid) {
    B.rigid(rbox(0.06, 0.08, 0.05, 0.012), [['Hips', 1]], [0.16, 0.99, 0.06], gear2, K_FLAT, { rough: 0.9, rot: [0, 0.6, 0] });
    B.rigid(rbox(0.07, 0.08, 0.05, 0.012), [['Hips', 1]], [0.12, 0.99, -0.12], gear2, K_FLAT, { rough: 0.9, rot: [0, -0.5, 0] });
    B.rigid(rbox(0.05, 0.16, 0.06, 0.012), 'RightUpLeg', [-0.175, 0.83, 0.01], C(0x222222), K_FLAT, { rough: 0.6 });
    if (detail) B.rigid(rbox(0.04, 0.12, 0.035, 0.01), 'RightUpLeg', [-0.17, 0.8, 0.045], C(0x1a1a1a), K_FLAT, { rough: 0.4 }); // pistol grip in the holster
  }
  // packs
  if (role === 'gunner') {
    B.rigid(rbox(0.3, 0.38, 0.17, 0.03), S2, [0, 1.22, -0.235], shade(gear, 0.92), K_FLAT, { rough: 0.95 });
    B.rigid(rbox(0.17, 0.12, 0.1, 0.02), [['Hips', 1]], [0.19, 0.98, 0.04], shade(gear2, 0.9), K_FLAT, { rough: 0.9, rot: [0, 0.4, 0] }); // ammo pouch
    if (mid) B.rigid(rbox(0.28, 0.05, 0.03, 0.01), S2, [0, 1.4, -0.33], C(0x3a3a30), K_FLAT, { rough: 0.9 });
  } else if (v.pack === 'assault' && plates) {
    B.rigid(rbox(0.26, 0.32, 0.12, 0.03), S2, [0, 1.23, -0.215], shade(gear2, 0.95), K_FLAT, { rough: 0.95 });
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
