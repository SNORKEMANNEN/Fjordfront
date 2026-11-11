import { WeaponDef } from './WeaponDefs';

/**
 * Recoil model (three layers, each with its own job):
 *
 *  1. Aim recoil  — moves where the bullets go. A learnable, weapon-specific spray pattern:
 *     a strong first-shot kick, a climb that builds over the first rounds and then settles,
 *     and a smooth horizontal S-drift with a little per-shot noise on top. Applied by the
 *     weapon system over a few frames, partly recovered when the trigger is released.
 *  2. View kick   — the camera punches (pitch/yaw/roll, a small shove back and a tiny FOV
 *     punch) and springs back; it never changes the aim point.
 *  3. Weapon kick — the viewmodel: a fast, slightly under-damped spring per shot plus a slow
 *     drift spring that builds up during sustained fire (see Viewmodel.kick).
 */

/** Deterministic smooth noise so a weapon's pattern is the same every spray (learnable). */
function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x: number, seed: number) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u) * 2 - 1;
}
function seedOf(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 997) + 1;
}

export interface AimKick {
  v: number; // degrees up
  h: number; // degrees right
}

/**
 * Authored spray patterns: per shot [horizontal (× recoil.h), vertical (× recoil.v)]. They are the
 * same every spray (only a little noise on top), so they can be learned and pulled against.
 * Past the end the last eight shots loop: the climb has settled into a steady wobble.
 */
const PATTERNS: Record<string, [number, number][]> = {
  // K416: straight up, a right hook, then a long S back to the left
  k416: [[0, 1.35], [0.25, 1.1], [0.5, 1.15], [0.7, 1.2], [0.6, 1.18], [0.3, 1.12], [-0.15, 1.08], [-0.6, 1.0], [-0.95, 0.95], [-1.05, 0.9],
    [-0.8, 0.86], [-0.3, 0.82], [0.3, 0.8], [0.8, 0.78], [1.0, 0.76], [0.7, 0.74], [0.1, 0.72], [-0.5, 0.72], [-0.8, 0.7], [-0.4, 0.7]],
  // KS-17: steady up-left, a sharp kick right at shot 8, then back left
  ks17: [[0, 1.3], [-0.3, 1.15], [-0.55, 1.18], [-0.75, 1.2], [-0.85, 1.16], [-0.9, 1.1], [-0.6, 1.04], [1.7, 1.15], [0.6, 0.98], [-0.3, 0.94],
    [-0.8, 0.9], [-1.0, 0.86], [-0.9, 0.82], [-0.5, 0.8], [0.1, 0.78], [0.5, 0.76], [0.2, 0.74], [-0.4, 0.74], [-0.7, 0.72], [-0.3, 0.72]],
  // MP7: fast, light, a tight vertical zig-zag
  mp7: [[0, 1.2], [0.55, 1.0], [-0.55, 1.0], [0.6, 0.98], [-0.6, 0.98], [0.5, 0.95], [-0.4, 0.94], [0.65, 0.92], [-0.7, 0.9], [0.4, 0.88],
    [-0.3, 0.86], [0.6, 0.84], [-0.6, 0.84], [0.5, 0.82], [-0.5, 0.82], [0.3, 0.8]],
  // UMS-45: slow and heavy, it bounces: big lift, small lift, drifting a touch right
  ums45: [[0, 1.4], [0.15, 0.75], [0.2, 1.35], [0.3, 0.72], [0.15, 1.3], [0.35, 0.7], [0.0, 1.25], [0.4, 0.68], [0.2, 1.2], [-0.1, 0.66],
    [0.3, 1.15], [0.5, 0.64], [0.2, 1.1], [0.0, 0.62]],
  // KVL-7: a hard first kick, a steady climb that walks right, then a slow heavy wander that
  // settles low (the weight soaks it up once you are into the belt)
  lmg: [[0, 1.45], [0.2, 1.2], [0.4, 1.15], [0.55, 1.1], [0.7, 1.05], [0.8, 0.98], [0.7, 0.92], [0.45, 0.86], [0.1, 0.8], [-0.25, 0.76],
    [-0.5, 0.72], [-0.6, 0.68], [-0.45, 0.64], [-0.1, 0.62], [0.3, 0.6], [0.55, 0.6], [0.4, 0.58], [0.0, 0.58], [-0.4, 0.58], [-0.3, 0.58]],
};

/** Aim recoil of shot n (1-based) in a spray, before stance / ADS multipliers. */
export function aimKick(def: WeaponDef, n: number): AimKick {
  const r = def.recoil;
  const auto = def.modes.includes('auto');
  const seed = seedOf(def.id);
  if (!auto) {
    // semi / pump / bolt: every shot is a "first shot"; small random horizontal
    return { v: r.v * (n === 1 ? r.firstShotMul : 1), h: (Math.random() * 2 - 1) * r.h * 0.6 + r.drift * 0.3 };
  }
  const pat = PATTERNS[def.id];
  if (pat) {
    const i = n <= pat.length ? n - 1 : pat.length - 8 + ((n - pat.length - 1) % 8);
    const [ph, pv] = pat[Math.max(0, i)];
    const noise = (Math.random() * 2 - 1) * 0.14;
    return { v: r.v * pv * (n === 1 ? r.firstShotMul / 1.35 : 1), h: (ph + noise) * r.h * 1.6 + r.drift * Math.min(1, n / 6) * 0.5 };
  }
  // fallback (procedural): first-shot kick, then a climb that peaks around shot 6–10 and eases off
  const climb = n === 1 ? r.firstShotMul : 0.85 + 0.35 * Math.sin(Math.min(1, (n - 1) / 9) * Math.PI * 0.75) - (n > 14 ? 0.12 : 0);
  const pattern = smoothNoise(n * 0.42, seed) * 1.0 + smoothNoise(n * 0.13, seed + 17) * 0.6;
  const bias = r.drift * Math.min(1, n / 6);
  const noise = (Math.random() * 2 - 1) * 0.25;
  return { v: r.v * climb, h: (pattern + noise) * r.h + bias };
}

/** How fast the climb settles during sustained fire (fraction of the built-up climb pulled back per second). */
export function settleRate(def: WeaponDef) {
  return def.cls === 'SMG' ? 1.1 : def.cls === 'Assault Rifle' ? 0.8 : def.cls === 'LMG' ? 0.9 : 0.35;
}

/** View-kick magnitudes for one shot (radians / metres / fraction). */
export function viewKick(def: WeaponDef, ads: number) {
  const r = def.recoil;
  const k = 1 - ads * 0.35;
  const pitch = Math.min(0.045, ((r.v * 0.32 + 0.22) * Math.PI) / 180) * k;
  return {
    pitch,
    yaw: (Math.random() * 2 - 1) * pitch * 0.35,
    roll: (Math.random() * 2 - 1) * r.roll * 0.9 * k,
    back: Math.min(0.03, r.kickZ * 0.28) * k,
    fov: Math.min(0.03, 0.004 + r.kickPitch * 0.08) * k,
  };
}
