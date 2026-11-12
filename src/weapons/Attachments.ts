import * as THREE from 'three';
import { PartBuilder, cyl, rbox, lathe, picatinny } from './ModelKit';
import { WeaponModel, WeaponMats, WeaponId, reflexSight, redDot, boxReflex, coatedGlass } from './WeaponModels';
import type { WeaponDef } from './WeaponDefs';

/**
 * Gunsmith (Update 36): five attachment slots per gun — optic, muzzle, underbarrel grip, magazine
 * and stock. Every attachment is a set of stat multipliers with a clear upside and a clear cost,
 * applied to a copy of the gun's definition (applyBuild), and a part modelled here from scratch and
 * mounted on the gun (attachVisuals): optics on the top rail (the aim point moves onto the optic's
 * axis), muzzle devices on the muzzle (the flash moves to the new end), grips under the handguard
 * (the support hand moves onto the grip), magazines resized, stocks fitted with pads and risers.
 */
export type AttSlot = 'optic' | 'muzzle' | 'grip' | 'mag' | 'stock';
export const ATT_SLOTS: AttSlot[] = ['optic', 'muzzle', 'grip', 'mag', 'stock'];
export const SLOT_LABEL: Record<AttSlot, string> = { optic: 'Optic', muzzle: 'Muzzle', grip: 'Underbarrel', mag: 'Magazine', stock: 'Stock' };
export type Build = Partial<Record<AttSlot, string>>;

/** stat multipliers (1 = unchanged) and switches */
export interface Mods {
  range?: number;
  recoilV?: number;
  recoilH?: number;
  ads?: number; // ADS time
  move?: number; // movement speed
  adsMove?: number; // speed while aiming
  sprintFire?: number; // sprint-to-fire time
  hip?: number; // hip-fire spread
  mag?: number; // magazine size
  magAdd?: number;
  reload?: number;
  zoom?: number; // ADS zoom (absolute)
  pellet?: number; // shotgun pellet spread
  flash?: number; // muzzle flash size
  suppressed?: boolean;
}

export interface Attachment {
  id: string;
  slot: AttSlot;
  name: string;
  desc: string;
  mods: Mods;
  /** which guns can take it (by mount kind) */
  fits?: (m: Mount, d: WeaponDef) => boolean;
}

/** where things go on each gun (weapon space: u forward along the bore, v up) */
export interface Mount {
  /** the top rail: optic rear at u, mount base height (rail top) */
  rail?: { u: number; top: number; riser?: number; len?: number };
  /** optic built into the model as parts.optic (its attachment id) */
  factoryOptic?: string;
  /** integrated scope / no rail: why the optic slot is locked */
  opticLock?: string;
  /** barrel radius at the muzzle; null = integral suppressor / not threaded */
  muzzle?: { r: number } | null;
  muzzleLock?: string;
  /** top of the grip mount under the handguard */
  under?: { u: number; v: number } | null;
  /** butt of the stock (u) and the stock's top / bottom there */
  stock?: { u: number; top: number; bot: number } | null;
  mag?: 'box' | 'tube' | 'belt' | null;
}

export const MOUNTS: Partial<Record<WeaponId, Mount>> = {
  k416: { rail: { u: 0.03, top: 0.0715 }, factoryOptic: 'reddot', muzzle: { r: 0.011 }, under: { u: 0.3, v: 0.011 }, stock: { u: -0.374, top: 0.034, bot: -0.072 }, mag: 'box' },
  ks17: { rail: { u: 0.0, top: 0.0725 }, muzzle: { r: 0.011 }, under: { u: 0.29, v: 0.009 }, stock: { u: -0.436, top: 0.04, bot: -0.07 }, mag: 'box' },
  hval47: { rail: { u: -0.1, top: 0.072, riser: 0.05, len: 0.13 }, muzzle: { r: 0.0095 }, under: { u: 0.3, v: -0.008 }, stock: { u: -0.558, top: 0.02, bot: -0.1 }, mag: 'box' },
  kr98: { opticLock: 'Iron sights only — a stripper-clip action has no room for a scope mount', muzzle: { r: 0.0085 }, stock: { u: -0.626, top: 0.02, bot: -0.11 }, mag: null },
  mp7: { rail: { u: -0.03, top: 0.066 }, muzzle: { r: 0.0075 }, stock: { u: -0.33, top: 0.03, bot: -0.03 }, mag: 'box' },
  ums45: { rail: { u: -0.06, top: 0.0685 }, factoryOptic: 'kestrel', muzzle: { r: 0.0105 }, under: { u: 0.19, v: -0.012 }, stock: { u: -0.44, top: 0.06, bot: -0.105 }, mag: 'box' },
  stille9: { rail: { u: -0.06, top: 0.066, riser: 0.04, len: 0.1 }, muzzle: null, muzzleLock: 'Integral suppressor', stock: { u: -0.356, top: 0.03, bot: -0.08 }, mag: 'box' },
  as20: { rail: { u: 0.0, top: 0.0745 }, muzzle: { r: 0.0125 }, under: { u: 0.28, v: -0.058 }, stock: { u: -0.434, top: 0.04, bot: -0.09 }, mag: 'box' },
  pump12: { rail: { u: -0.08, top: 0.066, riser: 0.05, len: 0.12 }, muzzle: { r: 0.0115 }, stock: { u: -0.414, top: 0.03, bot: -0.1 }, mag: 'tube' },
  db12: { opticLock: 'Bead sight only', muzzle: null, muzzleLock: 'Twin barrels', stock: { u: -0.452, top: 0.02, bot: -0.09 }, mag: null },
  skv338: { opticLock: 'Integrated precision scope', muzzle: { r: 0.0115 }, stock: { u: -0.44, top: 0.06, bot: -0.11 }, mag: 'box' },
  dmr14: { opticLock: 'Integrated 4× scope', muzzle: { r: 0.0105 }, stock: { u: -0.468, top: 0.05, bot: -0.1 }, mag: 'box' },
  lmg: { opticLock: 'Optic rides on the feed cover', muzzle: { r: 0.0125 }, stock: { u: -0.476, top: 0.05, bot: -0.1 }, mag: 'belt' },
  p80: { opticLock: 'Fixed pistol sights', muzzle: { r: 0.0075 }, mag: 'box' },
  mp18: { opticLock: 'Fixed pistol sights', muzzle: { r: 0.0075 }, mag: 'box' },
};

const isPistol = (d: WeaponDef) => d.cls === 'Pistol';
const isShotgun = (d: WeaponDef) => d.cls === 'Shotgun';
const autoGun = (d: WeaponDef) => d.cls === 'Assault Rifle' || d.cls === 'SMG';

export const ATTACHMENTS: Attachment[] = [
  // ---------------- optics ----------------
  { id: 'iron', slot: 'optic', name: 'Iron Sights', desc: 'The gun’s own sights. Fastest to aim, nothing in the way.', mods: {}, fits: (m) => !m.factoryOptic },
  { id: 'reflex', slot: 'optic', name: 'Vind Mini Reflex', desc: 'Open reflex window with a fine dot and ring. Barely slows aiming.', mods: { ads: 1.03, zoom: 1.08 }, fits: (m) => !!m.rail },
  { id: 'reddot', slot: 'optic', name: 'Fjord Tube Red Dot', desc: 'Enclosed tube with a crisp 2 MOA dot. A touch of magnification.', mods: { ads: 1.05, zoom: 1.12 }, fits: (m) => !!m.rail },
  { id: 'kestrel', slot: 'optic', name: 'Kestrel Box Reflex', desc: 'Wide square window, quick to pick up targets on the move.', mods: { ads: 1.04, zoom: 1.08, adsMove: 1.02 }, fits: (m) => !!m.rail },
  { id: 'holo', slot: 'optic', name: 'Nordlys Holographic', desc: 'Big ring-and-dot reticle for close fights. Bulkier to bring up.', mods: { ads: 1.07, zoom: 1.12, hip: 0.95 }, fits: (m) => !!m.rail },
  { id: 'prism3', slot: 'optic', name: 'Fjell 3× Prism', desc: '3× magnified prism with a chevron. For mid and long range; slow to aim, heavy to carry.', mods: { ads: 1.25, zoom: 2.1, adsMove: 0.88, move: 0.985 }, fits: (m) => !!m.rail },
  // ---------------- muzzles ----------------
  { id: 'none', slot: 'muzzle', name: 'Standard Muzzle', desc: 'Factory muzzle device.', mods: {} },
  { id: 'suppressor', slot: 'muzzle', name: 'Stille Suppressor', desc: 'Quiet shots that stay off the enemy radar, with a small muzzle flash. Longer and heavier.', mods: { suppressed: true, range: 1.06, ads: 1.08, recoilV: 0.95, flash: 0.25, move: 0.99 }, fits: (m) => !!m.muzzle },
  { id: 'comp', slot: 'muzzle', name: 'Kompensator', desc: 'Ports gas upward to fight muzzle climb. The gun dances sideways a bit more.', mods: { recoilV: 0.82, recoilH: 1.12, ads: 1.03, flash: 1.25 }, fits: (m, d) => !!m.muzzle && !isShotgun(d) },
  { id: 'brake', slot: 'muzzle', name: 'Muzzle Brake', desc: 'Side baffles tame the sideways shake and the kick. Loud and bright.', mods: { recoilH: 0.78, recoilV: 0.93, ads: 1.04, flash: 1.4 }, fits: (m, d) => !!m.muzzle && !isShotgun(d) && !isPistol(d) },
  { id: 'hider', slot: 'muzzle', name: 'Flash Hider', desc: 'Three-prong hider: almost no flash to give you away. Slightly shorter reach.', mods: { flash: 0.35, recoilV: 0.96, range: 0.96 }, fits: (m, d) => !!m.muzzle && !isShotgun(d) },
  { id: 'choke', slot: 'muzzle', name: 'Full Choke', desc: 'Tighter pellet pattern that reaches further. Less forgiving from the hip.', mods: { pellet: 0.68, range: 1.22, hip: 1.12 }, fits: (m, d) => !!m.muzzle && isShotgun(d) },
  // ---------------- underbarrel ----------------
  { id: 'none', slot: 'grip', name: 'No Grip', desc: 'Bare handguard.', mods: {} },
  { id: 'vgrip', slot: 'grip', name: 'Vertical Foregrip', desc: 'Firm hold against sideways recoil. Slower to aim.', mods: { recoilH: 0.78, recoilV: 0.93, ads: 1.06, move: 0.995 }, fits: (m) => !!m.under },
  { id: 'agrip', slot: 'grip', name: 'Angled Grip', desc: 'Swings the gun up faster and holds the first shots down. A little more side-to-side.', mods: { ads: 0.9, recoilV: 0.95, recoilH: 1.06 }, fits: (m) => !!m.under },
  { id: 'stop', slot: 'grip', name: 'Handstop', desc: 'Light and quick: faster out of a sprint and tighter from the hip. Slightly more kick.', mods: { sprintFire: 0.85, hip: 0.88, ads: 0.95, recoilV: 1.05 }, fits: (m) => !!m.under },
  // ---------------- magazines ----------------
  { id: 'std', slot: 'mag', name: 'Standard Mag', desc: 'Factory magazine.', mods: {} },
  { id: 'ext', slot: 'mag', name: 'Extended Mag', desc: 'Half again the rounds. Heavier: slower to aim and reload.', mods: { mag: 1.5, reload: 1.12, ads: 1.05, move: 0.99 }, fits: (m) => m.mag === 'box' || m.mag === 'belt' },
  { id: 'fast', slot: 'mag', name: 'Fast Mag', desc: 'Pull-tab mag that comes out quick: much faster reloads, a few rounds fewer.', mods: { reload: 0.76, mag: 0.85 }, fits: (m) => m.mag === 'box' || m.mag === 'belt' },
  { id: 'drum', slot: 'mag', name: 'Drum Mag', desc: 'Twice the rounds. Very heavy: slow to aim, reload and sprint-fire.', mods: { mag: 2, reload: 1.38, ads: 1.16, move: 0.96, sprintFire: 1.15 }, fits: (m, d) => m.mag === 'box' && autoGun(d) },
  { id: 'tube', slot: 'mag', name: 'Extended Tube', desc: 'Two more shells in the tube. A little front-heavy.', mods: { magAdd: 2, ads: 1.05, move: 0.99 }, fits: (m) => m.mag === 'tube' },
  // ---------------- stocks ----------------
  { id: 'std', slot: 'stock', name: 'Standard Stock', desc: 'Factory stock.', mods: {} },
  { id: 'light', slot: 'stock', name: 'Lightweight Stock', desc: 'Skeleton butt plate: move and aim faster, but the gun kicks harder.', mods: { move: 1.035, adsMove: 1.1, ads: 0.92, recoilV: 1.12, recoilH: 1.08 }, fits: (m) => !!m.stock },
  { id: 'heavy', slot: 'stock', name: 'Tactical Stock', desc: 'Cheek riser and thick recoil pad: steadier shots, slower handling.', mods: { recoilV: 0.87, recoilH: 0.9, ads: 1.08, move: 0.975, adsMove: 0.92 }, fits: (m) => !!m.stock },
];

export const attById = (slot: AttSlot, id: string | undefined) => ATTACHMENTS.find((a) => a.slot === slot && a.id === id);

/** the attachments a gun can take in a slot (empty: slot locked) */
export function options(wid: WeaponId, d: WeaponDef, slot: AttSlot): Attachment[] {
  const m = MOUNTS[wid];
  if (!m) return [];
  if (slot === 'optic' && m.opticLock) return [];
  if (slot === 'muzzle' && !m.muzzle) return [];
  if (slot === 'grip' && !m.under) return [];
  if (slot === 'mag' && !m.mag) return [];
  if (slot === 'stock' && !m.stock) return [];
  return ATTACHMENTS.filter((a) => a.slot === slot && (!a.fits || a.fits(m, d)));
}
export function lockReason(wid: WeaponId, slot: AttSlot): string {
  const m = MOUNTS[wid];
  if (!m) return 'No attachments';
  if (slot === 'optic') return m.opticLock ?? 'No optic rail';
  if (slot === 'muzzle') return m.muzzleLock ?? 'Not threaded';
  if (slot === 'grip') return 'No underbarrel rail';
  if (slot === 'mag') return 'Internal magazine';
  return 'No stock';
}
export function defaultAtt(wid: WeaponId, slot: AttSlot): string {
  const m = MOUNTS[wid];
  if (slot === 'optic') return m?.factoryOptic ?? 'iron';
  return slot === 'mag' ? 'std' : slot === 'stock' ? 'std' : 'none';
}
/** a build with every slot valid for the gun (unknown / unfitting ids fall back to the default) */
export function cleanBuild(wid: WeaponId, d: WeaponDef, b: Build | undefined): Build {
  const out: Build = {};
  for (const s of ATT_SLOTS) {
    const opts = options(wid, d, s);
    const want = b?.[s];
    out[s] = opts.some((a) => a.id === want) ? want! : defaultAtt(wid, s);
  }
  return out;
}
export const isDefaultBuild = (wid: WeaponId, b: Build) => ATT_SLOTS.every((s) => (b[s] ?? defaultAtt(wid, s)) === defaultAtt(wid, s));
export const buildCount = (wid: WeaponId, b: Build) => ATT_SLOTS.filter((s) => b[s] && b[s] !== defaultAtt(wid, s)).length;

function combined(wid: WeaponId, d: WeaponDef, b: Build): Mods {
  const out: Mods = {};
  const mul = (k: keyof Mods, v: number | undefined) => {
    if (v === undefined) return;
    (out as any)[k] = ((out as any)[k] ?? 1) * v;
  };
  const cb = cleanBuild(wid, d, b);
  for (const s of ATT_SLOTS) {
    const a = attById(s, cb[s]);
    if (!a) continue;
    // the factory optic is already part of the gun's numbers
    if (s === 'optic' && a.id === MOUNTS[wid]?.factoryOptic) continue;
    const m = a.mods;
    for (const k of ['range', 'recoilV', 'recoilH', 'ads', 'move', 'adsMove', 'sprintFire', 'hip', 'mag', 'reload', 'pellet', 'flash'] as const) mul(k, m[k]);
    if (m.magAdd) out.magAdd = (out.magAdd ?? 0) + m.magAdd;
    if (m.zoom) out.zoom = m.zoom;
    if (m.suppressed) out.suppressed = true;
  }
  return out;
}

/** a copy of the gun's definition with the build's attachments applied */
export function applyBuild(d: WeaponDef, b: Build | undefined): WeaponDef {
  const wid = d.id as WeaponId;
  if (!b || !MOUNTS[wid]) return d;
  const m = combined(wid, d, b);
  if (!Object.keys(m).length) return d;
  const r = (v: number, k = 1) => v * k;
  const mag = Math.max(1, Math.round(d.mag * (m.mag ?? 1)) + (m.magAdd ?? 0));
  const out: WeaponDef = {
    ...d,
    range: [r(d.range[0], m.range), r(d.range[1], m.range)],
    mag,
    reserve: Math.round(d.reserve * Math.max(1, mag / d.mag)),
    reload: r(d.reload, m.reload),
    reloadEmpty: r(d.reloadEmpty, m.reload),
    perShell: d.perShell ? r(d.perShell, m.reload) : d.perShell,
    adsTime: r(d.adsTime, m.ads),
    adsZoom: m.zoom ? Math.max(d.adsZoom, m.zoom) : d.adsZoom,
    sprintToFire: r(d.sprintToFire, m.sprintFire),
    hipSpread: r(d.hipSpread, m.hip),
    pelletSpread: r(d.pelletSpread, m.pellet),
    speedMul: Math.min(1.05, r(d.speedMul, m.move)),
    adsSpeedMul: Math.min(1, r(d.adsSpeedMul, m.adsMove)),
    recoil: { ...d.recoil, v: r(d.recoil.v, m.recoilV), h: r(d.recoil.h, m.recoilH), kickPitch: r(d.recoil.kickPitch, m.recoilV), shake: r(d.recoil.shake, m.recoilV) },
    sound: m.suppressed && !d.sound.suppressed ? { ...d.sound, body: d.sound.body * 0.6, crack: d.sound.crack * 0.35, low: d.sound.low * 0.4, tail: d.sound.tail * 0.3, suppressed: true } : d.sound,
  };
  (out as any).flashMul = m.flash ?? 1;
  return out;
}

/** pros and cons of one attachment as short lines ("+18% ADS speed") */
export function prosCons(a: Attachment): { pro: string[]; con: string[] } {
  const pro: string[] = [], con: string[] = [];
  const pct = (v: number) => `${Math.round(Math.abs(v - 1) * 100)}%`;
  const m = a.mods;
  // lower is better for these
  const lower: [keyof Mods, string][] = [['recoilV', 'vertical recoil'], ['recoilH', 'horizontal recoil'], ['ads', 'ADS time'], ['sprintFire', 'sprint-to-fire time'], ['hip', 'hip-fire spread'], ['reload', 'reload time'], ['pellet', 'pellet spread'], ['flash', 'muzzle flash']];
  const higher: [keyof Mods, string][] = [['range', 'damage range'], ['move', 'movement speed'], ['adsMove', 'aim walking speed'], ['mag', 'magazine size']];
  for (const [k, label] of lower) {
    const v = m[k] as number | undefined;
    if (v === undefined || v === 1) continue;
    (v < 1 ? pro : con).push(`${v < 1 ? '−' : '+'}${pct(v)} ${label}`);
  }
  for (const [k, label] of higher) {
    const v = m[k] as number | undefined;
    if (v === undefined || v === 1) continue;
    (v > 1 ? pro : con).push(`${v > 1 ? '+' : '−'}${pct(v)} ${label}`);
  }
  if (m.magAdd) pro.push(`+${m.magAdd} shells`);
  if (m.zoom && m.zoom > 1.5) pro.push(`${m.zoom >= 2 ? '3×' : m.zoom.toFixed(1) + '×'} magnification`);
  if (m.suppressed) pro.push('Off the enemy radar when firing', 'Quieter shots');
  return { pro, con };
}

// =====================================================================================
// visuals
// =====================================================================================

/**
 * Collimated reticle on an optic's rear lens, drawn where the view ray lines up with the optic
 * axis (it sits at infinity like a real reflex / prism sight): 'holo' a 65 MOA ring with a centre
 * dot, 'chevron' an inverted V with its tip on the aim point and a short stadia line.
 */
function collimatedReticle(kind: 'holo' | 'chevron', col: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: { uCol: { value: col } },
    vertexShader: /* glsl */ `varying vec3 vRay; varying vec3 vAxis; varying vec3 vUp; varying vec3 vN; varying vec2 vUv;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vRay = mv.xyz;
        vAxis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vUp = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uCol; varying vec3 vRay; varying vec3 vAxis; varying vec3 vUp; varying vec3 vN; varying vec2 vUv;
      void main(){
        vec3 r = normalize(vRay), a = normalize(vAxis);
        vec3 up = normalize(vUp - a * dot(vUp, a));
        vec3 rt = cross(a, up);
        float c = max(dot(r, a), 1e-3);
        vec2 p = vec2(dot(r, rt), dot(r, up)) / c;
        float lit = 0.0;
        ${kind === 'holo'
          ? `float d = length(p);
        lit = smoothstep(0.0016, 0.0009, d) + smoothstep(0.0011, 0.0005, abs(d - 0.0175)) * 0.85;
        // four short ticks on the ring
        lit += (step(abs(p.x), 0.0005) + step(abs(p.y), 0.0005)) * step(0.0175, d) * step(d, 0.022) * 0.85;`
          : `// chevron: two strokes from the tip (aim point) down and out
        float ax = abs(p.x);
        float yl = -ax * 1.35;
        lit = smoothstep(0.0017, 0.0008, abs(p.y - yl)) * step(ax, 0.009) * step(p.y, 0.0006);
        // stadia line below
        lit += smoothstep(0.0014, 0.0006, abs(p.x)) * step(p.y, -0.018) * step(-0.034, p.y) * 0.9;`}
        float glow = exp(-dot(p, p) / (0.006 * 0.006)) * 0.06;
        float rr = length(vUv - 0.5) * 2.0;
        float vign = 1.0 - smoothstep(0.85, 1.0, rr);
        float ndv = abs(dot(normalize(vN), -r));
        float fres = pow(1.0 - ndv, 3.0);
        float ga = 0.012 + fres * 0.3 + smoothstep(0.7, 1.0, rr) * 0.05;
        vec3 coat = mix(vec3(1.0, 0.6, 0.25), vec3(0.6, 0.45, 1.0), rr);
        gl_FragColor = vec4(coat * 0.5 * ga + uCol * (lit + glow), clamp(ga + (lit + glow) * vign, 0.0, 1.0));
      }`,
  });
}

/** holographic sight: squared hood on a QD base, battery box at the front, big window */
function holoSight(b: PartBuilder, u0: number, top: number, root: THREE.Group) {
  const L = 0.07, W = 0.017, B = top + 0.017, T = top + 0.05;
  const axis = (B + T) / 2;
  b.add('metal', rbox(u0 - 0.004, u0 + L, top, top + 0.012, -0.015, 0.015, 0.002)); // base
  b.add('metal', rbox(u0 + 0.04, u0 + L + 0.006, top + 0.008, B + 0.004, -0.016, 0.016, 0.003)); // battery box
  b.add('rubber', rbox(u0 + 0.046, u0 + 0.06, B - 0.004, B + 0.003, 0.016, 0.02, 0.001)); // buttons
  b.add('rubber', rbox(u0 + 0.046, u0 + 0.06, B - 0.004, B + 0.003, -0.02, -0.016, 0.001));
  // hood: two side walls and a roof, open front and back
  for (const s of [-1, 1]) b.add('metal', rbox(u0, u0 + L - 0.004, B - 0.002, T, s * W - (s > 0 ? 0 : 0.003), s * W + (s > 0 ? 0.003 : 0), 0.0012));
  b.add('metal', rbox(u0, u0 + L - 0.004, T, T + 0.003, -W - 0.003, W + 0.003, 0.0015));
  b.add('steel', cyl(0.0025, u0 + 0.02, u0 + 0.026, top + 0.006, -0.017, 10)); // throw lever pin
  const front = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, T - B), coatedGlass(0.9));
  front.position.set(0, axis, -(u0 + L - 0.01));
  front.renderOrder = 9;
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, T - B), collimatedReticle('holo', new THREE.Color(8, 0.35, 0.15)));
  rear.position.set(0, axis, -(u0 + 0.004));
  rear.rotation.y = Math.PI;
  rear.renderOrder = 10;
  root.add(front, rear);
  return { axis, rear: u0 };
}

/** 3× prism: squat body on an integral mount, objective bell in front, ocular at the back */
function prismSight(b: PartBuilder, u0: number, top: number, root: THREE.Group) {
  const axis = top + 0.042;
  b.add('metal', rbox(u0 + 0.01, u0 + 0.085, top, top + 0.012, -0.014, 0.014, 0.002)); // mount
  b.add('metal', rbox(u0 + 0.02, u0 + 0.075, top + 0.01, axis - 0.008, -0.017, 0.017, 0.004)); // prism housing
  // hollow tube (you look through it): open rings at both ends
  b.add('metal', lathe([[u0, 0.0148], [u0, 0.0165], [u0 + 0.022, 0.0165], [u0 + 0.03, 0.0145], [u0 + 0.07, 0.0145], [u0 + 0.082, 0.019], [u0 + 0.1, 0.0195], [u0 + 0.1, 0.0176]], axis, 0, 28));
  b.add('rubber', lathe([[u0 - 0.008, 0.0152], [u0 - 0.008, 0.0172], [u0 + 0.004, 0.0172], [u0 + 0.004, 0.0158]], axis, 0, 24)); // eye guard
  // blackened inner wall (both windings, so it shows from inside the tube)
  b.add('dark', lathe([[u0 - 0.008, 0.0147], [u0 + 0.1, 0.0147]], axis, 0, 28));
  b.add('dark', lathe([[u0 + 0.1, 0.0147], [u0 - 0.008, 0.0147]], axis, 0, 28));
  b.add('metal', cyl(0.008, u0 + 0.04, u0 + 0.054, axis + 0.021, 0, 14)); // elevation turret
  b.add('metal', rbox(u0 + 0.04, u0 + 0.054, axis - 0.007, axis + 0.007, 0.014, 0.024, 0.003)); // windage
  const front = new THREE.Mesh(new THREE.CircleGeometry(0.0175, 32), coatedGlass(1.1));
  front.position.set(0, axis, -(u0 + 0.098));
  front.renderOrder = 9;
  const rear = new THREE.Mesh(new THREE.CircleGeometry(0.0148, 32), collimatedReticle('chevron', new THREE.Color(7, 0.4, 0.12)));
  rear.position.set(0, axis, -(u0 - 0.006));
  rear.rotation.y = Math.PI;
  rear.renderOrder = 10;
  root.add(front, rear);
  return { axis, rear: u0 - 0.008 };
}

/** muzzle devices from the muzzle forward; returns their length (the flash moves to the end) */
function muzzleDevice(b: PartBuilder, id: string, u: number, v: number, r: number): number {
  if (id === 'suppressor') {
    const R = Math.max(0.0165, r * 1.65), L = 0.17;
    b.add('metal', lathe([[u - 0.002, r * 0.95], [u + 0.012, R * 0.85], [u + 0.02, R], [u + L - 0.008, R], [u + L, R * 0.8], [u + L, r * 0.6]], v, 0, 28));
    for (let i = 0; i < 5; i++) b.add('dark', cyl(R + 0.0003, u + 0.03 + i * 0.008, u + 0.0315 + i * 0.008, v, 0, 28));
    return L;
  }
  if (id === 'comp') {
    const L = 0.06, R = r * 1.25;
    b.add('steel', cyl(R, u, u + L, v, 0, 20));
    // gas ports on top
    for (let i = 0; i < 3; i++) b.add('dark', rbox(u + 0.014 + i * 0.013, u + 0.021 + i * 0.013, v + R * 0.6, v + R + 0.0005, -R * 0.45, R * 0.45, 0.0008));
    b.add('steel', cyl(R * 1.05, u + L - 0.006, u + L, v, 0, 20));
    return L;
  }
  if (id === 'brake') {
    const L = 0.07, R = r * 1.35;
    b.add('steel', rbox(u, u + L, v - R, v + R, -R * 1.25, R * 1.25, 0.003));
    // side baffles: through-slots both sides
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) b.add('dark', rbox(u + 0.012 + i * 0.017, u + 0.022 + i * 0.017, v - R * 0.75, v + R * 0.75, s * R * 1.25 - 0.0006, s * R * 1.25 + 0.0006, 0.0006));
    return L;
  }
  if (id === 'hider') {
    const L = 0.055;
    b.add('steel', cyl(r * 1.15, u, u + 0.018, v, 0, 18));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      const g = rbox(u + 0.016, u + L, -0.0028, 0.0028, -0.0028, 0.0028, 0.0008);
      g.translate(Math.cos(a) * r * 1.0, v + Math.sin(a) * r * 1.0, 0);
      b.add('steel', g);
    }
    return L;
  }
  if (id === 'choke') {
    const L = 0.045;
    b.add('steel', lathe([[u, r * 1.05], [u + L - 0.006, r * 1.12], [u + L, r * 1.0], [u + L, r * 0.7]], v, 0, 24));
    for (let i = 0; i < 6; i++) b.add('dark', cyl(r * 1.13, u + 0.008 + i * 0.004, u + 0.0095 + i * 0.004, v, 0, 24));
    return L;
  }
  return 0;
}

function gripPart(b: PartBuilder, id: string, u: number, v: number) {
  // rail clamp
  b.add('metal', rbox(u - 0.022, u + 0.022, v - 0.008, v + 0.002, -0.012, 0.012, 0.002));
  if (id === 'vgrip') {
    const g = new THREE.CylinderGeometry(0.0135, 0.0118, 0.085, 18);
    g.translate(0, v - 0.05, -u);
    b.add('polymer', g);
    for (let i = 0; i < 5; i++) {
      const rg = new THREE.TorusGeometry(0.0132 - i * 0.0003, 0.0011, 6, 18);
      rg.rotateX(Math.PI / 2);
      rg.translate(0, v - 0.025 - i * 0.012, -u);
      b.add('rubber', rg);
    }
    const cap = new THREE.CylinderGeometry(0.0125, 0.0125, 0.005, 18);
    cap.translate(0, v - 0.094, -u);
    b.add('metal', cap);
  } else if (id === 'agrip') {
    // a swept wedge sloping back toward the magazine
    const s = new THREE.Shape();
    s.moveTo(0.03, 0);
    s.lineTo(-0.035, 0);
    s.quadraticCurveTo(-0.04, -0.004, -0.032, -0.012);
    s.lineTo(0.016, -0.04);
    s.quadraticCurveTo(0.024, -0.043, 0.028, -0.036);
    s.lineTo(0.032, -0.006);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 8 });
    g.translate(0, 0, -0.011);
    g.rotateY(Math.PI / 2);
    g.translate(0, v - 0.006, -u);
    b.add('polymer', g);
  } else if (id === 'stop') {
    const s = new THREE.Shape();
    s.moveTo(0.012, 0);
    s.lineTo(-0.012, 0);
    s.lineTo(-0.006, -0.02);
    s.quadraticCurveTo(0.004, -0.024, 0.012, -0.014);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 6 });
    g.translate(0, 0, -0.009);
    g.rotateY(Math.PI / 2);
    g.translate(0, v - 0.006, -u);
    b.add('polymer', g);
  }
}

function stockPart(b: PartBuilder, id: string, s: { u: number; top: number; bot: number }) {
  const h = s.top - s.bot;
  if (id === 'heavy') {
    b.add('rubber', rbox(s.u - 0.02, s.u + 0.004, s.bot - 0.006, s.top + 0.006, -0.02, 0.02, 0.005)); // thick pad
    b.add('polymer', rbox(s.u + 0.03, s.u + 0.15, s.top - 0.004, s.top + 0.018, -0.016, 0.016, 0.006)); // cheek riser
    b.add('steel', cyl(0.003, s.u + 0.05, s.u + 0.056, s.top + 0.004, 0.0165, 8));
    b.add('steel', cyl(0.003, s.u + 0.12, s.u + 0.126, s.top + 0.004, 0.0165, 8));
  } else if (id === 'light') {
    // skeleton butt plate: thin aluminium frame with a cut-out
    b.add('metal', rbox(s.u - 0.008, s.u + 0.002, s.bot, s.bot + h * 0.22, -0.016, 0.016, 0.002));
    b.add('metal', rbox(s.u - 0.008, s.u + 0.002, s.top - h * 0.22, s.top, -0.016, 0.016, 0.002));
    b.add('metal', rbox(s.u - 0.008, s.u + 0.002, s.bot, s.top, -0.016, -0.011, 0.0015));
    b.add('metal', rbox(s.u - 0.008, s.u + 0.002, s.bot, s.top, 0.011, 0.016, 0.0015));
  }
}

/** local bounds of a part (its own frame) */
function localBox(o: THREE.Object3D) {
  const c = o.clone(true);
  c.position.set(0, 0, 0);
  c.rotation.set(0, 0, 0);
  c.scale.set(1, 1, 1);
  c.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(c);
}

/** mount a build's attachments on a freshly built (cloned) gun model */
export function attachVisuals(model: WeaponModel, wid: WeaponId, d: WeaponDef, build: Build | undefined, mats: WeaponMats) {
  const mount = MOUNTS[wid];
  if (!mount || !build) return;
  const cb = cleanBuild(wid, d, build);
  const root = model.root;
  const b = new PartBuilder();
  const extra = new THREE.Group();
  extra.name = 'attachments';
  // ---- optic
  const optic = cb.optic!;
  if (mount.rail && optic !== (mount.factoryOptic ?? 'iron')) {
    if (model.parts.optic) model.parts.optic.visible = false;
    if (optic !== 'iron') {
      const r = mount.rail;
      if (r.riser !== undefined) {
        // a riser block with a short rail section (guns without a rail of their own)
        const L = r.len ?? 0.12;
        b.add('metal', rbox(r.u - 0.012, r.u + L, r.riser, r.top - 0.0045, -0.012, 0.012, 0.002));
        for (const g of picatinny(r.u - 0.01, r.u + L - 0.002, r.top - 0.0045)) b.add('metal', g);
      }
      let s: { axis: number; rear: number } = { axis: 0, rear: 0 };
      let ads = model.adsDist;
      if (optic === 'reflex') { s = reflexSight(b, r.u, r.top, mats, extra); ads = 0.13; }
      else if (optic === 'reddot') { s = { axis: redDot(b, r.u, r.top, mats, extra), rear: r.u + 0.006 }; ads = 0.14; }
      else if (optic === 'kestrel') { s = boxReflex(b, r.u, r.top - 0.0045, mats, extra); ads = 0.15; }
      else if (optic === 'holo') { s = holoSight(b, r.u, r.top, extra); ads = 0.17; }
      else if (optic === 'prism3') { s = prismSight(b, r.u, r.top, extra); ads = 0.085; }
      model.sockets.sight.position.set(0, s.axis, -s.rear);
      model.adsDist = ads;
    } else if (model.parts.optic) {
      // irons on a gun that came with an optic: put the factory optic back (no irons to use)
      model.parts.optic.visible = true;
    }
  }
  // ---- muzzle
  if (mount.muzzle && cb.muzzle && cb.muzzle !== 'none') {
    const ms = model.sockets.muzzle;
    const u = -ms.position.z, v = ms.position.y;
    const L = muzzleDevice(b, cb.muzzle, u - 0.004, v, mount.muzzle.r);
    ms.position.z -= L - 0.004;
  }
  // ---- grip (the support hand moves onto it)
  if (mount.under && cb.grip && cb.grip !== 'none') {
    const g = mount.under;
    gripPart(b, cb.grip, g.u, g.v);
    const lh = model.sockets.leftHand;
    if (lh && cb.grip === 'vgrip') {
      lh.position.set(0, g.v - 0.045, -g.u);
      // hand frame as in WeaponModels' grips(): fingers wrap round the front, palm on the left side
      const f = new THREE.Vector3(0.35, -0.2, -1).normalize();
      const n = new THREE.Vector3(1, 0, 0.25);
      n.addScaledVector(f, -n.dot(f)).normalize();
      const Zh = f.clone().negate(), Yh = n.clone().negate();
      const Xh = new THREE.Vector3().crossVectors(Yh, Zh).normalize();
      lh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xh, Yh, Zh));
      lh.userData.r = 0.0135;
    } else if (lh && cb.grip === 'agrip') {
      lh.position.set(lh.position.x, lh.position.y - 0.006, -(g.u - 0.01));
    } else if (lh && cb.grip === 'stop') {
      lh.position.set(lh.position.x, lh.position.y, -(g.u - 0.035));
    }
  }
  // ---- stock
  if (mount.stock && cb.stock && cb.stock !== 'std') stockPart(b, cb.stock, mount.stock);
  // ---- magazine
  const mag = model.parts.mag;
  if (mag && cb.mag && cb.mag !== 'std' && cb.mag !== 'tube') {
    const bx = localBox(mag);
    if (cb.mag === 'ext') mag.scale.y = 1.32;
    else if (cb.mag === 'drum') {
      mag.scale.y = 0.55;
      const mb = new PartBuilder();
      const R = Math.min(0.06, Math.max(0.045, (bx.max.z - bx.min.z) * 0.7));
      const cy = bx.min.y * 0.55 - R * 0.6;
      // a lathe-turned drum (rounded rims), its axis across the gun
      const drum = lathe([[-0.026, 0.0], [-0.026, R * 0.9], [-0.022, R], [0.022, R], [0.026, R * 0.9], [0.026, 0.0]], 0, 0, 40);
      drum.rotateY(Math.PI / 2);
      drum.translate(0, cy, (bx.min.z + bx.max.z) / 2);
      mb.add('blackPoly', drum);
      // feed neck from the short magazine into the drum
      mb.add('blackPoly', rbox(-(bx.max.z) , -(bx.min.z), cy + R * 0.3, bx.min.y * 0.55 + 0.006, -0.012, 0.012, 0.003));
      for (const s of [-1, 1]) {
        const cap = new THREE.CylinderGeometry(R * 0.55, R * 0.55, 0.006, 24);
        cap.rotateZ(Math.PI / 2);
        cap.translate(s * 0.027, cy, (bx.min.z + bx.max.z) / 2);
        mb.add('metal', cap);
      }
      const dg = mb.build(mats, 'drum');
      dg.scale.y = 1 / 0.55;
      mag.add(dg);
    } else if (cb.mag === 'fast') {
      // twin-mag look: a pull tab loop on the base plate
      const mb = new PartBuilder();
      const loop = new THREE.TorusGeometry(0.011, 0.0022, 6, 16, Math.PI);
      loop.rotateZ(Math.PI);
      loop.translate(0, bx.min.y - 0.001, (bx.min.z + bx.max.z) / 2);
      mb.add('rubber', loop);
      mag.add(mb.build(mats, 'pulltab'));
    }
  }
  const g = b.build(mats, 'attach');
  extra.add(g);
  root.add(extra);
  model.parts.attachments = extra;
}

/** short tag for a build ("4 attachments") */
export function buildSummary(wid: WeaponId, b: Build | undefined) {
  if (!b) return '';
  const n = buildCount(wid, b);
  return n ? `${n} attachment${n > 1 ? 's' : ''}` : '';
}

export type { WeaponId };
