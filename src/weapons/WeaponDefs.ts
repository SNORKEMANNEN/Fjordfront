import { WeaponId } from './WeaponModels';

export type FireMode = 'auto' | 'semi' | 'burst' | 'pump' | 'bolt';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  short: string;
  cls: 'Assault Rifle' | 'SMG' | 'Shotgun' | 'Sniper' | 'Pistol' | 'Marksman' | 'Melee';
  slot: 'primary' | 'secondary' | 'melee';
  desc: string;
  rpm: number;
  modes: FireMode[];
  damage: [number, number]; // close, far
  range: [number, number]; // falloff start, end (m)
  headMul: number;
  limbMul: number;
  pellets: number;
  pelletSpread: number; // degrees
  mag: number;
  reserve: number;
  reload: number; // tactical reload duration (s)
  reloadEmpty: number;
  /** shotgun: time per shell, sniper/pump: cycle time */
  perShell?: number;
  cycle?: number;
  adsTime: number;
  adsZoom: number;
  sprintToFire: number;
  hipSpread: number; // degrees
  adsSpread: number;
  moveSpread: number;
  bloomPerShot: number;
  bloomMax: number;
  recoil: {
    v: number; // vertical per shot (deg)
    h: number; // horizontal random (deg)
    drift: number; // horizontal pattern bias (deg, sign)
    firstShotMul: number;
    adsMul: number;
    recover: number; // fraction recovered when stopping
    kickZ: number; // viewmodel push-back (m)
    kickPitch: number; // viewmodel rotation (rad)
    roll: number;
    shake: number; // camera visual kick
  };
  speedMul: number;
  adsSpeedMul: number;
  penetration: number; // metres of wood-equivalent
  swaySpeed: number;
  weight: number; // affects sway/inertia 0.6..1.6
  /** hip-fire pose as an offset from the ADS pose (camera space) */
  hip: [number, number, number];
  tracerEvery: number;
  sound: { body: number; crack: number; low: number; tail: number; pitch: number; suppressed?: boolean };
  /** PiP scope: magnification and reticle style (mil-dot by default, 'cross' = clean full-width cross) */
  scope?: { zoom: number; reticle?: 'mildot' | 'cross' };
  /** authored magazine reload to use (default: by class) */
  reloadKind?: 'rifle' | 'pdw' | 'pistol' | 'sniper' | 'dmr' | 'boxsg' | 'scar' | 'ump';
  /** break action: shells are fed into the chambers by hand, spent hulls stay until reload */
  action?: 'break';
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  k416: {
    id: 'k416', name: 'K416 Carbine', short: 'K416', cls: 'Assault Rifle', slot: 'primary',
    desc: '5.56 mm carbine with free-float rail and a compact red dot. Controlled, accurate, dependable.',
    rpm: 780, modes: ['auto', 'burst', 'semi'], damage: [30, 22], range: [32, 70], headMul: 1.5, limbMul: 0.85, pellets: 1, pelletSpread: 0,
    mag: 30, reserve: 150, reload: 2.15, reloadEmpty: 2.75, adsTime: 0.22, adsZoom: 1.3, sprintToFire: 0.2,
    hipSpread: 2.6, adsSpread: 0.05, moveSpread: 2.2, bloomPerShot: 0.35, bloomMax: 2.6,
    recoil: { v: 0.62, h: 0.22, drift: 0.12, firstShotMul: 1.4, adsMul: 0.75, recover: 0.45, kickZ: 0.028, kickPitch: 0.035, roll: 0.02, shake: 0.0035 },
    speedMul: 0.97, adsSpeedMul: 0.6, penetration: 0.45, swaySpeed: 1, weight: 1.0, hip: [0.098, -0.054, -0.075], tracerEvery: 2,
    sound: { body: 1.0, crack: 1.0, low: 0.9, tail: 1.0, pitch: 1.0 },
  },
  ks17: {
    id: 'ks17', name: 'KS-17 Modular Carbine', short: 'KS-17', cls: 'Assault Rifle', slot: 'primary',
    desc: '5.56 mm battle carbine with a monolithic upper and protected iron sights. A steady, heavy-hitting 625 rpm — and a mag-to-mag reload that never leaves the gun empty.',
    rpm: 625, modes: ['auto', 'burst', 'semi'], damage: [32, 23], range: [34, 75], headMul: 1.5, limbMul: 0.85, pellets: 1, pelletSpread: 0,
    mag: 30, reserve: 150, reload: 2.05, reloadEmpty: 2.8, adsTime: 0.23, adsZoom: 1.25, sprintToFire: 0.21,
    hipSpread: 2.7, adsSpread: 0.05, moveSpread: 2.3, bloomPerShot: 0.38, bloomMax: 2.7,
    recoil: { v: 0.72, h: 0.25, drift: -0.1, firstShotMul: 1.35, adsMul: 0.75, recover: 0.45, kickZ: 0.032, kickPitch: 0.04, roll: 0.022, shake: 0.004 },
    speedMul: 0.96, adsSpeedMul: 0.6, penetration: 0.5, swaySpeed: 1, weight: 1.05, hip: [0.098, -0.056, -0.075], tracerEvery: 2,
    sound: { body: 1.1, crack: 1.0, low: 1.0, tail: 1.05, pitch: 0.95 },
    reloadKind: 'scar',
  },
  ums45: {
    id: 'ums45', name: 'UMS-45 Submachine Gun', short: 'UMS-45', cls: 'SMG', slot: 'primary',
    desc: '.45 polymer SMG with a Kestrel box reflex. A slow, thumping 650 rpm that drops people in five at close range.',
    rpm: 650, modes: ['auto', 'semi'], damage: [27, 17], range: [14, 34], headMul: 1.45, limbMul: 0.9, pellets: 1, pelletSpread: 0,
    mag: 25, reserve: 150, reload: 2.15, reloadEmpty: 2.75, adsTime: 0.19, adsZoom: 1.18, sprintToFire: 0.14,
    hipSpread: 2.0, adsSpread: 0.12, moveSpread: 1.5, bloomPerShot: 0.32, bloomMax: 2.3,
    recoil: { v: 0.62, h: 0.3, drift: 0.06, firstShotMul: 1.25, adsMul: 0.78, recover: 0.5, kickZ: 0.03, kickPitch: 0.042, roll: 0.026, shake: 0.0042 },
    speedMul: 1.02, adsSpeedMul: 0.72, penetration: 0.3, swaySpeed: 1.1, weight: 0.85, hip: [0.094, -0.05, -0.04], tracerEvery: 3,
    sound: { body: 1.15, crack: 0.8, low: 1.2, tail: 0.9, pitch: 0.85 },
    reloadKind: 'ump',
  },
  mp7: {
    id: 'mp7', name: 'MP7 PDW', short: 'MP7', cls: 'SMG', slot: 'primary',
    desc: 'Compact 4.6 mm PDW with flip-up irons and a folding foregrip. Blistering fire rate, razor-fast handling.',
    rpm: 950, modes: ['auto', 'semi'], damage: [24, 15], range: [15, 40], headMul: 1.45, limbMul: 0.9, pellets: 1, pelletSpread: 0,
    mag: 40, reserve: 160, reload: 1.85, reloadEmpty: 2.3, adsTime: 0.16, adsZoom: 1.18, sprintToFire: 0.13,
    hipSpread: 1.7, adsSpread: 0.11, moveSpread: 1.15, bloomPerShot: 0.2, bloomMax: 2.1,
    recoil: { v: 0.4, h: 0.28, drift: -0.04, firstShotMul: 1.2, adsMul: 0.8, recover: 0.5, kickZ: 0.019, kickPitch: 0.022, roll: 0.024, shake: 0.0024 },
    speedMul: 1.04, adsSpeedMul: 0.74, penetration: 0.3, swaySpeed: 1.25, weight: 0.75, hip: [0.1, -0.058, -0.11], tracerEvery: 3,
    sound: { body: 0.85, crack: 0.9, low: 0.55, tail: 0.75, pitch: 1.22 },
  },
  pump12: {
    id: 'pump12', name: 'Pump-12 Shotgun', short: 'PUMP-12', cls: 'Shotgun', slot: 'primary',
    desc: '12 gauge pump action. Devastating inside houses, warehouses and bunkers.',
    rpm: 72, modes: ['pump'], damage: [19, 6], range: [8, 24], headMul: 1.25, limbMul: 0.9, pellets: 9, pelletSpread: 4.8,
    mag: 7, reserve: 35, reload: 0.55, reloadEmpty: 0.55, perShell: 0.5, cycle: 0.62, adsTime: 0.26, adsZoom: 1.12, sprintToFire: 0.22,
    hipSpread: 1.2, adsSpread: 0.6, moveSpread: 0.8, bloomPerShot: 0, bloomMax: 0,
    recoil: { v: 3.6, h: 0.8, drift: 0.2, firstShotMul: 1, adsMul: 0.85, recover: 0.75, kickZ: 0.07, kickPitch: 0.16, roll: 0.06, shake: 0.012 },
    speedMul: 0.95, adsSpeedMul: 0.6, penetration: 0.12, swaySpeed: 0.9, weight: 1.2, hip: [0.1, -0.05, -0.085], tracerEvery: 3,
    sound: { body: 1.4, crack: 0.7, low: 1.6, tail: 1.4, pitch: 0.72 },
  },
  skv338: {
    id: 'skv338', name: 'SKV .338 Bolt Rifle', short: 'SKV .338', cls: 'Sniper', slot: 'primary',
    desc: '.338 Lapua bolt-action with 6x scope. One shot from the fort to the harbour.',
    rpm: 48, modes: ['bolt'], damage: [105, 95], range: [80, 300], headMul: 2.0, limbMul: 0.85, pellets: 1, pelletSpread: 0,
    mag: 5, reserve: 25, reload: 2.9, reloadEmpty: 3.5, cycle: 1.05, adsTime: 0.38, adsZoom: 1.25, sprintToFire: 0.35,
    hipSpread: 6, adsSpread: 0.0, moveSpread: 4, bloomPerShot: 0, bloomMax: 0,
    recoil: { v: 5.5, h: 0.8, drift: 0.3, firstShotMul: 1, adsMul: 0.6, recover: 0.85, kickZ: 0.09, kickPitch: 0.13, roll: 0.05, shake: 0.015 },
    speedMul: 0.9, adsSpeedMul: 0.45, penetration: 1.2, swaySpeed: 0.8, weight: 1.5, hip: [0.1, -0.058, -0.075], tracerEvery: 1,
    sound: { body: 1.6, crack: 1.4, low: 1.5, tail: 1.8, pitch: 0.8 },
    scope: { zoom: 6 },
  },
  dmr14: {
    id: 'dmr14', name: 'FJ-14 Marksman Rifle', short: 'FJ-14', cls: 'Marksman', slot: 'primary',
    desc: '7.62 mm semi-automatic marksman rifle with a 2.5x scope. Every trigger pull hits like a hammer: two to the chest, one to the head up close.',
    rpm: 360, modes: ['semi'], damage: [62, 50], range: [45, 160], headMul: 1.65, limbMul: 0.9, pellets: 1, pelletSpread: 0,
    mag: 20, reserve: 80, reload: 2.55, reloadEmpty: 3.15, adsTime: 0.28, adsZoom: 1.1, sprintToFire: 0.26,
    hipSpread: 4.2, adsSpread: 0.02, moveSpread: 2.6, bloomPerShot: 0.6, bloomMax: 2.4,
    recoil: { v: 0.95, h: 0.22, drift: 0.05, firstShotMul: 1, adsMul: 0.65, recover: 0.92, kickZ: 0.05, kickPitch: 0.07, roll: 0.025, shake: 0.006 },
    speedMul: 0.93, adsSpeedMul: 0.6, penetration: 0.95, swaySpeed: 0.95, weight: 1.3, hip: [0.096, -0.06, -0.035], tracerEvery: 1,
    sound: { body: 1.4, crack: 1.3, low: 1.3, tail: 1.5, pitch: 0.92 },
    scope: { zoom: 2.5, reticle: 'cross' },
  },
  as20: {
    id: 'as20', name: 'AS-20 Storm Auto Shotgun', short: 'STORM-20', cls: 'Shotgun', slot: 'primary',
    desc: 'Semi-automatic 12 gauge fed from an 8-round box. The gas action soaks up the kick, so it empties as fast as you can pull the trigger.',
    rpm: 290, modes: ['semi'], damage: [15, 5], range: [7, 20], headMul: 1.2, limbMul: 0.9, pellets: 8, pelletSpread: 5.2,
    mag: 8, reserve: 40, reload: 2.5, reloadEmpty: 3.0, adsTime: 0.27, adsZoom: 1.12, sprintToFire: 0.24,
    hipSpread: 1.4, adsSpread: 0.8, moveSpread: 0.9, bloomPerShot: 0.5, bloomMax: 2.0,
    recoil: { v: 2.1, h: 0.7, drift: 0.12, firstShotMul: 1, adsMul: 0.8, recover: 0.8, kickZ: 0.058, kickPitch: 0.11, roll: 0.05, shake: 0.009 },
    speedMul: 0.93, adsSpeedMul: 0.6, penetration: 0.12, swaySpeed: 0.9, weight: 1.3, hip: [0.1, -0.05, -0.08], tracerEvery: 3,
    sound: { body: 1.3, crack: 0.7, low: 1.4, tail: 1.3, pitch: 0.8 },
    reloadKind: 'boxsg',
  },
  db12: {
    id: 'db12', name: 'Tvilling Double Barrel', short: 'TVILLING', cls: 'Shotgun', slot: 'primary',
    desc: 'Side-by-side 12 gauge in blued steel and walnut. Two triggers, two shots that clear any room — then break it open and feed it by hand.',
    rpm: 420, modes: ['semi'], damage: [23, 6], range: [7, 18], headMul: 1.25, limbMul: 0.9, pellets: 10, pelletSpread: 4.6,
    mag: 2, reserve: 24, reload: 1.75, reloadEmpty: 2.25, adsTime: 0.24, adsZoom: 1.1, sprintToFire: 0.2,
    hipSpread: 1.1, adsSpread: 0.5, moveSpread: 0.7, bloomPerShot: 0, bloomMax: 0,
    recoil: { v: 4.8, h: 1.0, drift: 0.3, firstShotMul: 1, adsMul: 0.85, recover: 0.72, kickZ: 0.09, kickPitch: 0.21, roll: 0.08, shake: 0.017 },
    speedMul: 0.97, adsSpeedMul: 0.65, penetration: 0.12, swaySpeed: 1.0, weight: 1.15, hip: [0.1, -0.05, -0.07], tracerEvery: 3,
    sound: { body: 1.6, crack: 0.8, low: 1.8, tail: 1.5, pitch: 0.66 },
    action: 'break',
  },
  knife: {
    id: 'knife', name: 'Combat Knife', short: 'KNIFE', cls: 'Melee', slot: 'melee',
    desc: 'Hold [V] to draw it. One hit takes them down, and how you get there decides how it ends.',
    rpm: 120, modes: ['semi'], damage: [200, 200], range: [2, 3], headMul: 1, limbMul: 1, pellets: 1, pelletSpread: 0,
    mag: 0, reserve: 0, reload: 1, reloadEmpty: 1, adsTime: 0.2, adsZoom: 1, sprintToFire: 0.05,
    hipSpread: 0, adsSpread: 0, moveSpread: 0, bloomPerShot: 0, bloomMax: 0,
    recoil: { v: 0, h: 0, drift: 0, firstShotMul: 1, adsMul: 1, recover: 1, kickZ: 0, kickPitch: 0, roll: 0, shake: 0 },
    speedMul: 1.1, adsSpeedMul: 1, penetration: 0, swaySpeed: 1.2, weight: 0.45, hip: [0.13, -0.075, 0.07], tracerEvery: 1,
    sound: { body: 0, crack: 0, low: 0, tail: 0, pitch: 1 },
  },
  p80: {
    id: 'p80', name: 'P80 Pistol', short: 'P80', cls: 'Pistol', slot: 'secondary',
    desc: '9 mm service pistol. Quick to draw when the rifle runs dry.',
    rpm: 420, modes: ['semi'], damage: [32, 20], range: [12, 30], headMul: 1.5, limbMul: 0.9, pellets: 1, pelletSpread: 0,
    mag: 17, reserve: 68, reload: 1.45, reloadEmpty: 1.75, adsTime: 0.14, adsZoom: 1.15, sprintToFire: 0.1,
    hipSpread: 1.6, adsSpread: 0.2, moveSpread: 1.0, bloomPerShot: 0.4, bloomMax: 2.5,
    recoil: { v: 1.2, h: 0.4, drift: 0.0, firstShotMul: 1, adsMul: 0.85, recover: 0.7, kickZ: 0.03, kickPitch: 0.09, roll: 0.03, shake: 0.004 },
    speedMul: 1.06, adsSpeedMul: 0.8, penetration: 0.15, swaySpeed: 1.3, weight: 0.6, hip: [0.07, -0.06, 0.04], tracerEvery: 3,
    sound: { body: 0.8, crack: 0.9, low: 0.6, tail: 0.8, pitch: 1.15 },
  },
  rv357: {
    id: 'rv357', name: 'R357 Revolver', short: 'R357', cls: 'Pistol', slot: 'secondary',
    desc: '.357 Magnum six-shooter. Hits like a truck, a headshot kill at any sane range — make every round count.',
    rpm: 150, modes: ['semi'], damage: [64, 42], range: [18, 45], headMul: 1.8, limbMul: 0.9, pellets: 1, pelletSpread: 0,
    mag: 6, reserve: 36, reload: 3.2, reloadEmpty: 2.9, adsTime: 0.19, adsZoom: 1.18, sprintToFire: 0.15,
    hipSpread: 2.1, adsSpread: 0.08, moveSpread: 1.5, bloomPerShot: 1.3, bloomMax: 3.2,
    recoil: { v: 4.2, h: 0.8, drift: 0.25, firstShotMul: 1, adsMul: 0.8, recover: 0.82, kickZ: 0.065, kickPitch: 0.26, roll: 0.06, shake: 0.013 },
    speedMul: 1.03, adsSpeedMul: 0.78, penetration: 0.55, swaySpeed: 1.1, weight: 0.7, hip: [0.072, -0.058, 0.02], tracerEvery: 1,
    sound: { body: 1.3, crack: 1.2, low: 1.2, tail: 1.3, pitch: 0.85 },
  },
};

export const PRIMARIES: WeaponId[] = ['k416', 'ks17', 'mp7', 'ums45', 'pump12', 'as20', 'db12', 'dmr14', 'skv338'];
export const SECONDARIES: WeaponId[] = ['p80', 'rv357'];
