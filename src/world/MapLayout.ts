import { clamp, distToSegment2, fbm2, ridged2, smoothstep, simplex2, lerp } from '../core/math';

/**
 * "Kvitvika" — a fictional settlement on the Norwegian coast combining a Lofoten
 * fishing village, a Nordfjord-style inlet and a WW2-era coastal fort.
 *
 * Coordinates: +X east, +Z south, +Y up. Sea level y = 0. Play area ±185 m.
 */
export const SEA_LEVEL = 0;
export const PLAY_HALF = 185;
export const TERRAIN_EXTENT = 3200;

export type V2 = [number, number];

export interface Road {
  name: string;
  pts: V2[];
  width: number;
  kind: 'asphalt' | 'gravel' | 'dirt';
  lines?: boolean;
}

export const ROADS: Road[] = [
  {
    name: 'Fv. 812', kind: 'asphalt', width: 6.5, lines: true,
    pts: [[44, -128], [30, -118], [14, -108], [2, -97], [0, -80], [0, -60], [-1, -30], [0, 0], [1, 30], [0, 55], [0, 64], [0, 98], [2, 108], [10, 125], [24, 138], [40, 150]],
  },
  { name: 'Strandvegen', kind: 'asphalt', width: 5.5, lines: true, pts: [[-92, 6], [-60, 7], [-30, 6], [0, 5], [30, 3], [62, 2], [96, 6], [140, 18], [184, 26]] },
  { name: 'Kaia', kind: 'asphalt', width: 7, pts: [[-86, 112], [-40, 111], [0, 111], [40, 112], [75, 118]] },
  { name: 'Brygga', kind: 'gravel', width: 4, pts: [[-92, 6], [-92, -20], [-88, -48], [-74, -60]] },
  { name: 'Saddle track', kind: 'gravel', width: 3.5, pts: [[96, 6], [110, 30], [121, 58], [123, 82], [112, 104], [80, 120]] },
  { name: 'Fort track', kind: 'dirt', width: 3, pts: [[44, -128], [58, -140], [66, -152], [52, -165], [30, -160], [16, -146], [14, -128]] },
  { name: 'Farm track', kind: 'dirt', width: 3, pts: [[96, 6], [104, -8], [112, -20]] },
  { name: 'Shore path', kind: 'dirt', width: 2.2, pts: [[-92, 40], [-90, 70], [-86, 92], [-86, 112]] },
  { name: 'Klippestien', kind: 'dirt', width: 2.2, pts: [[-44, -95], [-34, -104], [-22, -112], [-12, -121], [-2, -128]] },
  { name: 'Elvestien', kind: 'dirt', width: 2.2, pts: [[30, -30], [36, -52], [38, -63]] },
  { name: 'Elvestien nord', kind: 'dirt', width: 2.2, pts: [[38, -99], [45, -110], [44, -126]] },
];

export type BuildingKind =
  | 'house' | 'rorbu' | 'church' | 'shop' | 'warehouse' | 'office' | 'bunker' | 'gunpit'
  | 'barracks' | 'mast' | 'barn' | 'naust' | 'crane' | 'tanks' | 'hjell' | 'containers' | 'boathouse'
  | 'lighthouse' | 'tower' | 'radome';

export interface BuildingDef {
  kind: BuildingKind;
  x: number;
  z: number;
  rot: number; // radians, around Y
  w?: number;
  d?: number;
  floors?: number;
  color?: 'red' | 'white' | 'ochre' | 'dkgrey';
  /** terrain pad height override (absolute). If undefined pad uses natural height at center. */
  padY?: number;
  seed?: number;
  name?: string;
}

const R90 = Math.PI / 2;
export const BUILDINGS: BuildingDef[] = [
  // --- Village centre ---
  { kind: 'church', x: 22, z: -36, rot: R90, name: 'Kvitvika kirke' },
  { kind: 'house', x: -15, z: -44, rot: R90, w: 9, d: 7, floors: 2, color: 'white', seed: 1 },
  { kind: 'house', x: -16, z: -22, rot: R90, w: 8, d: 7, floors: 2, color: 'red', seed: 2 },
  { kind: 'shop', x: -17, z: 20, rot: R90, w: 14, d: 9, name: 'Butikken' },
  { kind: 'house', x: 16, z: 18, rot: -R90, w: 9, d: 7, floors: 2, color: 'ochre', seed: 3 },
  { kind: 'house', x: 17, z: -8, rot: -R90, w: 8, d: 6.5, floors: 1, color: 'red', seed: 4 },
  { kind: 'house', x: -16, z: 40, rot: R90, w: 8.5, d: 7, floors: 2, color: 'white', seed: 5 },
  { kind: 'house', x: 16, z: 42, rot: -R90, w: 8, d: 7, floors: 2, color: 'red', seed: 6 },
  { kind: 'house', x: -38, z: -10, rot: 0.15, w: 8, d: 6.5, floors: 2, color: 'white', seed: 7 },
  { kind: 'house', x: -42, z: 24, rot: -0.1, w: 7.5, d: 6, floors: 1, color: 'red', seed: 8 },
  { kind: 'house', x: 40, z: -14, rot: 0.08, w: 8, d: 6.5, floors: 2, color: 'white', seed: 9 },
  { kind: 'house', x: 42, z: 28, rot: -0.12, w: 9, d: 7, floors: 2, color: 'dkgrey', seed: 10 },
  { kind: 'house', x: -40, z: -40, rot: 0.3, w: 7, d: 6, floors: 1, color: 'ochre', seed: 11 },
  { kind: 'house', x: 46, z: 52, rot: 0.2, w: 7.5, d: 6, floors: 2, color: 'red', seed: 12 },
  // --- Waterfront: rorbuer on stilts + boathouses ---
  { kind: 'rorbu', x: -104, z: -34, rot: R90, w: 7, d: 6, color: 'red', padY: 2.2, seed: 21 },
  { kind: 'rorbu', x: -106, z: -18, rot: R90, w: 7, d: 6, color: 'red', padY: 2.2, seed: 22 },
  { kind: 'rorbu', x: -105, z: 20, rot: R90, w: 8, d: 6, color: 'red', padY: 2.2, seed: 23 },
  { kind: 'rorbu', x: -107, z: 36, rot: R90, w: 7, d: 6, color: 'ochre', padY: 2.2, seed: 24 },
  { kind: 'naust', x: -96, z: -64, rot: 0.6, w: 6, d: 9, color: 'red', seed: 25 },
  { kind: 'hjell', x: -66, z: -48, rot: 0.1, name: 'Hjellene' },
  { kind: 'hjell', x: -60, z: -36, rot: 0.1 },
  // --- Harbour ---
  { kind: 'warehouse', x: -42, z: 136, rot: 0, w: 40, d: 22, name: 'Lager 1', padY: 2.4 },
  { kind: 'warehouse', x: 34, z: 156, rot: R90, w: 30, d: 18, name: 'Lager 2', padY: 2.4 },
  { kind: 'containers', x: -2, z: 130, rot: 0, padY: 2.4, seed: 31 },
  { kind: 'containers', x: -58, z: 160, rot: 0.0, padY: 2.4, seed: 32 },
  { kind: 'crane', x: -84, z: 150, rot: 0, name: 'Kranen', padY: 2.4 },
  { kind: 'office', x: 62, z: 128, rot: -R90, w: 12, d: 9, padY: 2.4, name: 'Havnekontoret' },
  { kind: 'tanks', x: 74, z: 168, rot: 0, padY: 2.4 },
  // --- Coastal fort ---
  { kind: 'bunker', x: 8, z: -142, rot: -R90, name: 'Kystfortet', seed: 41 },
  { kind: 'bunker', x: 22, z: -166, rot: -2.3, seed: 42 },
  { kind: 'gunpit', x: 16, z: -122, rot: -R90 },
  { kind: 'barracks', x: 56, z: -150, rot: 0.1, w: 16, d: 8 },
  { kind: 'mast', x: 74, z: -128, rot: 0, name: 'Radiomasta' },
  // --- Farm east ---
  { kind: 'barn', x: 104, z: 22, rot: 0.25, w: 16, d: 11, color: 'red', name: 'Låven' },
  { kind: 'house', x: 116, z: -16, rot: 0.25, w: 9, d: 7, floors: 2, color: 'white', seed: 51 },
  { kind: 'barn', x: 82, z: 44, rot: -0.3, w: 16, d: 11, color: 'red' },
  { kind: 'naust', x: 128, z: 40, rot: 0.5, w: 5, d: 6, color: 'red', seed: 52 },
  // --- Hjellene: a third rack row ---
  { kind: 'hjell', x: -80, z: -22, rot: 0.15 },
  // --- Fyret: lighthouse on the south-west point, keeper's house, boathouse ---
  { kind: 'lighthouse', x: -104, z: -146, rot: 0, name: 'Fyret' },
  { kind: 'house', x: -90, z: -138, rot: 0.4, w: 8, d: 6.5, floors: 2, color: 'white', seed: 61 },
  { kind: 'naust', x: -100, z: -124, rot: -1.2, w: 6, d: 9, color: 'red', seed: 62 },
  // --- Leiren: army camp on the south-west plain ---
  { kind: 'barracks', x: -66, z: -158, rot: 0.05, w: 16, d: 8 },
  { kind: 'barracks', x: -42, z: -166, rot: -0.12, w: 16, d: 8 },
  { kind: 'office', x: -58, z: -136, rot: 0, w: 12, d: 9, name: 'Leiren' },
  { kind: 'gunpit', x: -78, z: -142, rot: R90 },
  { kind: 'tower', x: -40, z: -134, rot: 0.3 },
  // --- Radaren: radar station on the south-east hills ---
  { kind: 'radome', x: 140, z: -152, rot: 0.2, name: 'Radaren' },
  { kind: 'office', x: 126, z: -138, rot: 0.2, w: 10, d: 8 },
  { kind: 'bunker', x: 154, z: -134, rot: -0.6, seed: 71 },
  { kind: 'tower', x: 158, z: -162, rot: 0.8 },
  // --- Hyttefeltet: holiday cabins on the north-east hills ---
  { kind: 'house', x: 126, z: 140, rot: 0.3, w: 6.5, d: 5.5, floors: 1, color: 'red', seed: 81 },
  { kind: 'house', x: 146, z: 134, rot: -0.2, w: 6.5, d: 5.5, floors: 1, color: 'ochre', seed: 82 },
  { kind: 'house', x: 158, z: 156, rot: 0.5, w: 7, d: 5.5, floors: 2, color: 'white', seed: 83 },
  { kind: 'house', x: 132, z: 162, rot: -0.4, w: 6.5, d: 5.5, floors: 1, color: 'dkgrey', seed: 84 },
  { kind: 'house', x: 152, z: 176, rot: 0.1, w: 6, d: 5, floors: 1, color: 'red', seed: 85 },
  { kind: 'naust', x: 116, z: 158, rot: 0.9, w: 5, d: 6, color: 'red', seed: 86 },
  // --- Skogen: logging camp in the eastern forest ---
  { kind: 'barn', x: 138, z: -56, rot: 0.15, w: 14, d: 9, color: 'red', name: 'Sagbruket' },
  { kind: 'house', x: 154, z: -42, rot: -0.3, w: 7, d: 5.5, floors: 1, color: 'red', seed: 91 },
  { kind: 'house', x: 122, z: -74, rot: 0.6, w: 6.5, d: 5.5, floors: 1, color: 'ochre', seed: 92 },
  { kind: 'tower', x: 158, z: -78, rot: -0.4 },
  // --- Skaret: a lookout tower in the pass ---
  { kind: 'tower', x: 124, z: 80, rot: 0 },
  // --- Kystfortet: an observation tower over the trenches; a lookout on the waterfront ---
  { kind: 'tower', x: 46, z: -134, rot: -0.3 },
  { kind: 'tower', x: -86, z: -4, rot: R90 },
  // --- Ryggen: dug-in pillbox on the ridge ---
  { kind: 'bunker', x: 62, z: 80, rot: Math.PI, seed: 97 },
];

export interface TrenchDef { pts: V2[]; depth: number; width: number }
export const TRENCHES: TrenchDef[] = [
  { pts: [[4, -128], [2, -136], [-2, -150], [6, -158], [12, -170]], depth: 1.7, width: 2.2 },
  { pts: [[30, -122], [42, -118], [54, -124], [62, -136]], depth: 1.6, width: 2.0 },
];

export interface Landmark { name: string; x: number; z: number; r: number }
export const LANDMARKS: Landmark[] = [
  { name: 'Kystfortet', x: 30, z: -142, r: 45 },
  { name: 'Brua', x: 0, z: -80, r: 18 },
  { name: 'Kirka', x: 22, z: -36, r: 18 },
  { name: 'Sentrum', x: 0, z: 10, r: 40 },
  { name: 'Brygga', x: -95, z: 0, r: 40 },
  { name: 'Hjellene', x: -64, z: -44, r: 22 },
  { name: 'Tunnelen', x: 0, z: 80, r: 22 },
  { name: 'Havna', x: -10, z: 140, r: 70 },
  { name: 'Kranen', x: -84, z: 150, r: 20 },
  { name: 'Låven', x: 104, z: 18, r: 28 },
  { name: 'Skogen', x: 140, z: -60, r: 42 },
  { name: 'Skaret', x: 122, z: 86, r: 28 },
  { name: 'Ryggen', x: 58, z: 80, r: 32 },
  { name: 'Fyret', x: -96, z: -138, r: 30 },
  { name: 'Leiren', x: -58, z: -148, r: 36 },
  { name: 'Radaren', x: 142, z: -148, r: 32 },
  { name: 'Hyttefeltet', x: 140, z: 154, r: 36 },
];

export interface SpawnPoint { x: number; z: number; yaw: number; team: 0 | 1 | -1 }
export const SPAWNS: SpawnPoint[] = [
  // team 0 (Kystjegerne) — harbour side
  { x: 60, z: 177, yaw: 0, team: 0 }, { x: 10, z: 170, yaw: 0, team: 0 }, { x: -20, z: 172, yaw: 0, team: 0 },
  { x: 58, z: 146, yaw: 0, team: 0 }, { x: -60, z: 118, yaw: 0, team: 0 }, { x: 85, z: 140, yaw: 0, team: 0 },
  // team 1 (Nordfront) — fort side
  { x: 44, z: -162, yaw: Math.PI, team: 1 }, { x: 64, z: -168, yaw: Math.PI, team: 1 }, { x: 30, z: -176, yaw: Math.PI, team: 1 },
  { x: 80, z: -150, yaw: Math.PI, team: 1 }, { x: 70, z: -112, yaw: Math.PI, team: 1 }, { x: 96, z: -140, yaw: Math.PI, team: 1 },
  // neutral (used mid-match when safe)
  { x: 140, z: -40, yaw: -R90, team: -1 }, { x: 150, z: 40, yaw: -R90, team: -1 }, { x: -70, z: 60, yaw: 0, team: -1 },
  { x: -50, z: -60, yaw: R90, team: -1 }, { x: 90, z: 90, yaw: Math.PI, team: -1 }, { x: 80, z: -60, yaw: 0, team: -1 },
];

/** Road tunnel through the ridge: two lanes + shoulders, `wall` = height of the vertical walls (the arch rises above). */
export const TUNNEL = { x: 0, z0: 62, z1: 99, width: 16, height: 8, wall: 4.8 };
/**
 * Emergency exits: behind each tunnel wall runs a service gallery (x = W+gx0 .. W+gx1 from the axis)
 * with two exit doors into the tunnel; from the gallery a shaft with a ladder climbs to the crest.
 */
export const TUNNEL_EXIT = { doors: [72.5, 89.5], shaftZ: 82, gx0: 1.2, gx1: 3.6, gh: 3.0, carve: 6.5, floor: 3.94 };
export interface TunnelShaft { sx: 1 | -1; x0: number; x1: number; z0: number; z1: number; top: number; base: number; px0: number; px1: number; pz0: number; pz1: number }
let shaftCache: TunnelShaft[] | null = null;
/** The two exit shafts (west, east): interior footprint, the top of the concrete platform at the crest. */
export function tunnelShafts(): TunnelShaft[] {
  if (shaftCache) return shaftCache;
  const W = TUNNEL.width / 2, E = TUNNEL_EXIT;
  shaftCache = ([-1, 1] as const).map((sx) => {
    const a = TUNNEL.x + sx * (W + E.gx0), b = TUNNEL.x + sx * (W + E.gx1);
    const x0 = Math.min(a, b), x1 = Math.max(a, b), z0 = E.shaftZ - 1.2, z1 = E.shaftZ + 1.2;
    // platform: the hatch plus a walkable apron, mostly on the outer (ladder) side
    const px0 = sx > 0 ? x0 - 1.0 : x0 - 2.4, px1 = sx > 0 ? x1 + 2.4 : x1 + 1.0;
    const pz0 = z0 - 1.6, pz1 = z1 + 1.6;
    let top = -1e9, base = 1e9;
    for (let x = px0; x <= px1 + 1e-6; x += 0.5) for (let z = pz0; z <= pz1 + 1e-6; z += 0.5) {
      const h = tunnelCapHeight(x, z);
      top = Math.max(top, h);
      base = Math.min(base, h);
    }
    return { sx, x0, x1, z0, z1, top: top + 0.05, base: base - 0.5, px0, px1, pz0, pz1 };
  });
  return shaftCache;
}
export const BRIDGE = { x: 0, z0: -96, z1: -64, deckY: 5.2, width: 8 };
export const FOOTBRIDGE = { x: -56, z0: -100, z1: -69, deckY: 3.4, width: 2.4 };
/** Second crossing over the inlet (east), and climbable ladders: base position, outward normal, top height. */
export const PLANK_BRIDGE = { x: 38, z0: -96, z1: -65, width: 2.0 };
export interface LadderDef { x: number; z: number; nx: number; nz: number; y0: number; y1: number; exit: [number, number, number]; /** climb speed m/s (default 3.4) */ speed?: number }
export const LADDERS: LadderDef[] = [
  { x: -27, z: 147.1, nx: 0, nz: 1, y0: 2.55, y1: 11.5, exit: [-27, 11.9, 145.6] }, // Lager 1 roof
  { x: 66.65, z: 125, nx: 1, nz: 0, y0: 2.7, y1: 9.75, exit: [65.2, 10.0, 125] }, // harbour office roof
  { x: 71.65, z: 168, nx: 1, nz: 0, y0: 2.9, y1: 11.4, exit: [69.5, 11.7, 168] }, // fuel tank
  { x: -78.35, z: 154, nx: 1, nz: 0, y0: 2.5, y1: 24.3, exit: [-79, 24.7, 153.4] }, // harbour crane
];

// ---------------- Terrain shaping ----------------

export function coastX(z: number) {
  return -98 + 7 * Math.sin(z * 0.021 + 1.0) + 4 * Math.sin(z * 0.057 + 0.3) + 3 * simplex2(z * 0.01, 4.2);
}
export function southCoastZ(x: number) {
  return 184 + 4 * Math.sin(x * 0.03);
}
export function inletZ(x: number) {
  return -80 + 4 * Math.sin(x * 0.035 + 0.6);
}

export interface Pad { x: number; z: number; hw: number; hd: number; rot: number; y: number | null; feather: number; c: number; s: number; r: number; fy: number }
let PADS: Pad[] | null = null;

function padFor(b: BuildingDef): Pad {
  const sizes: Partial<Record<BuildingKind, [number, number]>> = {
    church: [22, 12], shop: [16, 11], warehouse: [44, 26], office: [14, 11], bunker: [14, 12], gunpit: [14, 14],
    barracks: [18, 10], mast: [8, 8], barn: [18, 13], naust: [8, 11], crane: [16, 16], tanks: [24, 14],
    hjell: [12, 5], containers: [36, 26], rorbu: [9, 8], lighthouse: [11, 11], tower: [6, 6], radome: [12, 12],
  };
  const s = sizes[b.kind] ?? [(b.w ?? 8) + 4, (b.d ?? 7) + 4];
  const hw = s[0] / 2 + 1.5, hd = s[1] / 2 + 1.5, feather = 7;
  // (rotation, bounding radius and the pad height are fixed: precomputed once instead of per sample)
  return { x: b.x, z: b.z, hw, hd, rot: b.rot, y: b.padY ?? null, feather, c: Math.cos(-b.rot), s: Math.sin(-b.rot), r: Math.hypot(hw + feather, hd + feather), fy: 0 };
}

/** Natural terrain before roads/pads. */
export function naturalHeight(x: number, z: number): number {
  let h = 4.2 + fbm2(x * 0.007, z * 0.007, 4) * 3.2 + fbm2(x * 0.03 + 7, z * 0.03, 3) * 0.9;
  // East forest hills
  h += smoothstep(40, 130, x) * (5 + 7 * (0.5 + 0.5 * fbm2(x * 0.012 + 3, z * 0.012 - 2, 4)));
  // North fort hill with a plateau
  {
    const d = Math.hypot((x - 38) * 1.0, (z + 142) * 1.15);
    const hill = 1 - smoothstep(30, 95, d);
    h += 17 * Math.pow(hill, 1.3);
  }
  // South ridge (with saddle at x≈122)
  {
    const g = Math.exp(-Math.pow((z - 80) / 15, 2));
    const along = smoothstep(-92, -50, x);
    let rh = 25 + 5 * fbm2(x * 0.02, 3.3, 3);
    rh -= 15 * Math.exp(-Math.pow((x - 122) / 16, 2));
    h += g * along * rh;
    // rocky crown
    h += g * along * ridged2(x * 0.04, z * 0.04, 3) * 3.5;
  }
  // Village bowl: soften around centre
  h = lerp(h, 4.6 + fbm2(x * 0.02, z * 0.02, 2) * 0.8, (1 - smoothstep(30, 70, Math.hypot(x * 0.9, z * 0.75))) * 0.8);
  // Harbour flats
  {
    const m = smoothstep(96, 106, z) * (1 - smoothstep(86, 100, x));
    h = lerp(h, 2.4, m);
  }
  // Outer mountains (east / north / south of play area on land) — steep Lofoten-style massifs
  {
    // the south-east massif rises gradually eastward from the sea instead of as a sheer wall
    const out = Math.max(-z - 195, x - 192, x > 110 ? Math.min(z - 200, (x - 120) * 1.2) : -1e9);
    if (out > 0) {
      const m = smoothstep(30, 620, out);
      const massif = 0.5 + 0.5 * fbm2(x * 0.0011 + 4, z * 0.0011, 4);
      const ridge = ridged2(x * 0.0032, z * 0.0032, 4);
      const crag = ridged2(x * 0.012 + 3, z * 0.012 - 7, 3);
      h += Math.pow(m, 1.25) * (600 * massif + 160 * ridge) + m * crag * 45 + smoothstep(0, 90, out) * (8 + fbm2(x * 0.02, z * 0.02, 3) * 10);
    }
  }
  // Coastline & fjord
  const harbourMask = smoothstep(96, 106, z) * (1 - smoothstep(86, 100, x));
  {
    const d = x - coastX(z);
    if (harbourMask > 0.5 && d < 28) {
      // vertical concrete quay
      if (d < -0.6) h = -6 - 10 * smoothstep(-5, -80, d);
    } else if (d < 28) {
      // shore: bring land down to ~1.2m approaching the waterline
      const s = smoothstep(0, 28, d);
      const shoreH = lerp(0.7, h, s);
      if (d >= 0) h = shoreH;
      else {
        // seabed
        const sb = -2 - 16 * smoothstep(0, -60, d) - 30 * smoothstep(-60, -300, d);
        h = lerp(0.7, sb, smoothstep(0, -12, d));
        // rounded skerries ("holmer")
        if (d < -25 && d > -260) {
          const sk = fbm2(x * 0.011 + 3.3, z * 0.011 - 1.7, 4);
          h = Math.max(h, (sk - 0.42) * 50 - 1.5);
        }
      }
    }
    // far shore mountains across the fjord
    const fx = x + 110 * simplex2(z * 0.0016, 1.0);
    if (fx < -860) {
      const far = smoothstep(-860, -1750, fx);
      const massif = 0.5 + 0.5 * fbm2(x * 0.0012 - 7, z * 0.0012 + 2, 4);
      const ridge = ridged2(x * 0.0026 + 1, z * 0.0026 + 9, 4);
      const land = 4 + Math.pow(far, 1.15) * (560 * massif + 150 * ridge);
      h = lerp(h, land, smoothstep(0, 0.16, far));
    }
  }
  // South sea (harbour opens to the south-west)
  {
    const sc = southCoastZ(x);
    const west = 1 - smoothstep(100, 140, x);
    if (harbourMask > 0.5 && z > sc + 0.6) h = Math.min(h, -6 - 8 * smoothstep(0, 60, z - sc));
    else if (z > sc - 2 && west > 0) {
      const d = z - sc;
      const sb = -3 - 14 * smoothstep(0, 60, d);
      h = lerp(h, sb, smoothstep(-2, 3, d) * west);
    }
    if (z > 950) {
      const m = smoothstep(950, 1400, z);
      h = lerp(h, 6 + Math.pow(m, 1.15) * (520 * (0.5 + 0.5 * fbm2(x * 0.0012, z * 0.0012, 4)) + 140 * ridged2(x * 0.0026, z * 0.0026, 4)), smoothstep(0, 0.16, m));
    }
  }
  // Inlet (river mouth) north of the village
  {
    if (x < 80) {
      const iz = inletZ(x);
      const w = lerp(12, 4, smoothstep(-60, 70, x));
      const dz = Math.abs(z - iz);
      const depth = lerp(-4.5, 0.6, smoothstep(30, 76, x));
      const bank = 1 - smoothstep(w, w + 9, dz);
      h = lerp(h, depth, bank * (1 - smoothstep(70, 80, x)));
    }
  }
  return h;
}

/** Pads bucketed on a coarse grid: a height sample only tests the few pads whose feathered
 *  footprint can reach it (it used to test every building, with trig and an fbm call each). */
const PAD_CELL = 32;
let padGrid: Map<number, Pad[]> | null = null;
const EMPTY_PADS: Pad[] = [];
function buildPads() {
  PADS = BUILDINGS.map(padFor);
  padGrid = new Map();
  for (const p of PADS) {
    p.fy = p.y ?? Math.max(naturalHeight(p.x, p.z), 1.6);
    const i0 = Math.floor((p.x - p.r) / PAD_CELL), i1 = Math.floor((p.x + p.r) / PAD_CELL);
    const j0 = Math.floor((p.z - p.r) / PAD_CELL), j1 = Math.floor((p.z + p.r) / PAD_CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = (i + 512) * 1024 + (j + 512);
      let l = padGrid.get(k);
      if (!l) padGrid.set(k, (l = []));
      l.push(p);
    }
  }
}
export function padsNear(x: number, z: number): Pad[] {
  if (!padGrid) buildPads();
  const i = Math.floor(x / PAD_CELL), j = Math.floor(z / PAD_CELL);
  if (i < -512 || i > 511 || j < -512 || j > 511) return EMPTY_PADS;
  return padGrid!.get((i + 512) * 1024 + (j + 512)) ?? EMPTY_PADS;
}

function padInfluence(p: Pad, x: number, z: number) {
  const dx = x - p.x, dz = z - p.z;
  if (dx > p.r || dx < -p.r || dz > p.r || dz < -p.r) return 0;
  const lx = Math.abs(dx * p.c - dz * p.s) - p.hw;
  const lz = Math.abs(dx * p.s + dz * p.c) - p.hd;
  const d = Math.max(lx, lz);
  return d >= p.feather ? 0 : 1 - smoothstep(0, p.feather, d);
}

const roadCache: { r: Road; ys: number[] }[] = [];
function roadHeights() {
  if (roadCache.length) return roadCache;
  // the tunnel floor constraint applies BEFORE smoothing so the
  // approaches ramp into them instead of leaving raised berms / cut walls at the portals
  const constrain = (r: Road, x: number, z: number, y: number) => {
    if (r !== ROADS[0]) return y;
    // (bridge deck heights are applied after smoothing only: the approaches are built from the terrain)
    if (z >= TUNNEL.z0 - 6 && z <= TUNNEL.z1 + 6 && Math.abs(x) < 3) return 4.0;
    return y;
  };
  for (const r of ROADS) {
    const raw = r.pts.map(([x, z]) => constrain(r, x, z, naturalWithPads(x, z)));
    // smooth along road
    const ys = raw.map((_, i) => {
      let s = 0, n = 0;
      for (let k = -1; k <= 1; k++) {
        const j = clamp(i + k, 0, raw.length - 1);
        s += raw[j];
        n++;
      }
      return s / n;
    });
    roadCache.push({ r, ys });
  }
  // Tunnel/bridge constraints on the main road
  const main = roadCache[0];
  main.r.pts.forEach(([x, z], i) => {
    if (z >= TUNNEL.z0 - 6 && z <= TUNNEL.z1 + 6 && Math.abs(x) < 3) main.ys[i] = 4.0;
    if (z >= BRIDGE.z0 && z <= BRIDGE.z1) main.ys[i] = BRIDGE.deckY;
  });
  return roadCache;
}

function naturalWithPads(x: number, z: number) {
  let h = naturalHeight(x, z);
  const pads = padsNear(x, z);
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const inf = padInfluence(p, x, z);
    if (inf > 0) h = lerp(h, p.fy, inf);
  }
  return h;
}

/** Road segments bucketed on a grid (each segment listed in every cell its 30 m-padded box
 *  touches, in road order): a lookup tests a handful of segments instead of all of them. */
interface RoadSeg { ys: number[]; r: Road; i: number; ax: number; az: number; bx: number; bz: number; x0: number; x1: number; z0: number; z1: number }
const SEG_CELL = 32;
let segGrid: Map<number, RoadSeg[]> | null = null;
const NO_SEGS: RoadSeg[] = [];
function roadSegs(x: number, z: number) {
  if (!segGrid) {
    segGrid = new Map();
    for (const { r, ys } of roadHeights()) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i];
        const [bx, bz] = r.pts[i + 1];
        const sg: RoadSeg = { ys, r, i, ax, az, bx, bz, x0: Math.min(ax, bx) - 30, x1: Math.max(ax, bx) + 30, z0: Math.min(az, bz) - 30, z1: Math.max(az, bz) + 30 };
        for (let ci = Math.floor(sg.x0 / SEG_CELL); ci <= Math.floor(sg.x1 / SEG_CELL); ci++)
          for (let cj = Math.floor(sg.z0 / SEG_CELL); cj <= Math.floor(sg.z1 / SEG_CELL); cj++) {
            const k = (ci + 512) * 1024 + (cj + 512);
            let l = segGrid.get(k);
            if (!l) segGrid.set(k, (l = []));
            l.push(sg);
          }
      }
    }
  }
  const ci = Math.floor(x / SEG_CELL), cj = Math.floor(z / SEG_CELL);
  if (ci < -512 || ci > 511 || cj < -512 || cj > 511) return NO_SEGS;
  return segGrid.get((ci + 512) * 1024 + (cj + 512)) ?? NO_SEGS;
}

/** Returns {d, y, t, road} for the nearest road to (x,z). */
export function nearestRoad(x: number, z: number) {
  const segs = roadSegs(x, z);
  let bd = 1e9, bs: RoadSeg | null = null, bt = 0;
  for (let k = 0; k < segs.length; k++) {
    const sg = segs[k];
    if (x < sg.x0 || x > sg.x1 || z < sg.z0 || z > sg.z1) continue;
    const dx = sg.bx - sg.ax, dz = sg.bz - sg.az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - sg.ax) * dx + (z - sg.az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (sg.ax + dx * t), z - (sg.az + dz * t));
    if (d < bd) {
      bd = d;
      bs = sg;
      bt = t;
    }
  }
  if (!bs) return { d: 1e9, y: 0, road: ROADS[0], seg: 0, t: 0 };
  return { d: bd, y: lerp(bs.ys[bs.i], bs.ys[bs.i + 1], bt), road: bs.r, seg: bs.i, t: bt };
}

export function roadHeightAt(r: Road, i: number, t: number) {
  const rc = roadHeights().find((c) => c.r === r)!;
  return lerp(rc.ys[i], rc.ys[i + 1], t);
}

let bridgeEndsCache: [number, number] | null = null;
function bridgeEnds(): [number, number] {
  if (!bridgeEndsCache) bridgeEndsCache = [nearestRoad(BRIDGE.x, BRIDGE.z0 - 1.5).y, nearestRoad(BRIDGE.x, BRIDGE.z1 + 1.5).y];
  return bridgeEndsCache;
}

/** Final terrain height used for mesh + collisions. */
export function terrainHeight(x: number, z: number): number {
  let h = naturalWithPads(x, z);
  // Roads
  const nr = nearestRoad(x, z);
  const onSpan = nr.road === ROADS[0] && ((z > BRIDGE.z0 - 1 && z < BRIDGE.z1 + 1) || (z > TUNNEL.z0 && z < TUNNEL.z1));
  if (!onSpan && nr.d < nr.road.width * 0.5 + 8) {
    const hw = nr.road.width * 0.5;
    const m = 1 - smoothstep(hw + 0.6, hw + 7, nr.d);
    h = lerp(h, nr.y - (nr.d < hw + 0.3 ? 0.06 : 0), m);
  }
  // Trenches
  for (const t of TRENCHES) {
    for (let i = 0; i < t.pts.length - 1; i++) {
      const { d } = distToSegment2(x, z, t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]);
      if (d < t.width) {
        const m = 1 - smoothstep(t.width * 0.45, t.width, d);
        h = Math.min(h, lerp(h, h - t.depth, m));
      }
    }
  }
  // Road bridge: the natural hillside must never rise through the deck near the abutments
  if (Math.abs(x - BRIDGE.x) < BRIDGE.width / 2 + 5 && z > BRIDGE.z0 - 1 && z < BRIDGE.z1 + 1) {
    const t = clamp((z - BRIDGE.z0) / (BRIDGE.z1 - BRIDGE.z0), 0, 1);
    const ends = bridgeEnds();
    const deck = lerp(ends[0], ends[1], t) + Math.sin(t * Math.PI) * 1.2;
    const side = smoothstep(BRIDGE.width / 2 + 1, BRIDGE.width / 2 + 5, Math.abs(x - BRIDGE.x));
    const into = smoothstep(0, 2.5, Math.min(z - BRIDGE.z0, BRIDGE.z1 - z)); // 0 at the abutments
    h = Math.min(h, deck - 1.1 * into + side * 30);
  }
  // Tunnel corridor (+ the galleries / rock behind the walls): carve to road level (the ridge above is rebuilt as a cap mesh)
  const tdx = Math.abs(x - TUNNEL.x) - TUNNEL.width * 0.5;
  if (tdx < TUNNEL_EXIT.carve && z > TUNNEL.z0 - 1 && z < TUNNEL.z1 + 1) h = Math.min(h, 3.94);
  // portal aprons: the cutting in front of each portal is as wide as the tunnel, flattening out over ~15 m
  else if (tdx < 5 && ((z > TUNNEL.z0 - 16 && z <= TUNNEL.z0 - 1) || (z >= TUNNEL.z1 + 1 && z < TUNNEL.z1 + 16))) {
    const along = z < TUNNEL.z0 ? TUNNEL.z0 - z : z - TUNNEL.z1;
    const m = (1 - smoothstep(0.5, 5, tdx)) * (1 - smoothstep(6, 15, along));
    h = Math.min(h, lerp(h, 3.94, m));
  }
  return h;
}

/** Height of the ridge surface over the tunnel (for the cap mesh). */
export function tunnelCapHeight(x: number, z: number) {
  // over the bore it clears the arch; over the rock behind the walls / the galleries it only has to
  // clear their roofs; at the cap's outer edge it meets the natural hillside
  const dx = Math.abs(x - TUNNEL.x) - TUNNEL.width / 2;
  const crown = 4 + TUNNEL.height + 1.2, fill = 4 + TUNNEL.wall + 1.2;
  let need = dx < 1.2 ? crown : lerp(crown, fill, smoothstep(1.2, 3.0, dx));
  if (dx > TUNNEL_EXIT.carve) need = lerp(fill, 0, smoothstep(TUNNEL_EXIT.carve, TUNNEL_EXIT.carve + 1, dx));
  return Math.max(naturalWithPads(x, z), need);
}

export function isWater(x: number, z: number, h: number) {
  return h < SEA_LEVEL - 0.05;
}

/** Forest density 0..1 used for trees and forest-floor texturing. */
export function forestDensity(x: number, z: number, h: number): number {
  if (h < 1.6) return 0;
  let f = 0.5 + 0.5 * fbm2(x * 0.018 + 11, z * 0.018 - 5, 4);
  // zones
  const east = smoothstep(60, 110, x);
  const north = 1 - smoothstep(20, 50, Math.hypot(x - 38, (z + 142) * 1.1)); // fort plateau clear
  const hillSlopes = (1 - smoothstep(60, 100, Math.hypot(x - 38, z + 142))) * (1 - north);
  const ridge = Math.exp(-Math.pow((z - 80) / 20, 2)) * smoothstep(-70, -30, x);
  const outer = smoothstep(180, 230, Math.max(Math.abs(x), Math.abs(z)));
  let zone = Math.max(east * 0.95, hillSlopes * 0.7, ridge * 0.65, outer);
  // village and harbour clear
  zone *= smoothstep(40, 70, Math.hypot(x * 0.9, z * 0.8));
  zone *= 1 - (smoothstep(96, 106, z) * (1 - smoothstep(86, 100, x)));
  f = f * zone;
  return clamp((f - 0.28) * 1.9, 0, 1);
}

export function landmarkAt(x: number, z: number): string {
  let best = 'Kvitvika';
  let bd = 1e9;
  for (const l of LANDMARKS) {
    const d = Math.hypot(x - l.x, z - l.z) / l.r;
    if (d < 1 && d < bd) {
      bd = d;
      best = l.name;
    }
  }
  return best;
}

export function getPads() {
  if (!PADS) buildPads();
  return PADS!;
}


// ---------------- ladders on the towers / lighthouse / radar station (from their placement) ----------------
{
  const L: Record<string, { lx: number; lz: number; y0: number; y1: number; ex: [number, number, number] }> = {
    tower: { lx: 0, lz: 1.78, y0: 0.05, y1: 6.45, ex: [0, 6.75, 0.2] },
    lighthouse: { lx: 0, lz: 2.38, y0: 1.05, y1: 16.3, ex: [0, 16.55, 1.4] },
    radome: { lx: 0, lz: 4.1, y0: 0.35, y1: 3.3, ex: [0, 3.6, 2.6] },
  };
  for (const b of BUILDINGS) {
    const d = L[b.kind];
    if (!d) continue;
    const c = Math.cos(b.rot), s2 = Math.sin(b.rot);
    const wx = (lx: number, lz: number) => b.x + lx * c + lz * s2;
    const wz = (lx: number, lz: number) => b.z - lx * s2 + lz * c;
    const y = b.padY ?? terrainHeight(b.x, b.z);
    LADDERS.push({
      x: wx(d.lx, d.lz), z: wz(d.lx, d.lz), nx: s2, nz: c, y0: y + d.y0, y1: y + d.y1,
      exit: [wx(d.ex[0], d.ex[2]), y + d.ex[1], wz(d.ex[0], d.ex[2])],
    });
  }
}

// ---------------- tunnel exit shafts: a ladder up the outer wall of each shaft to the crest ----------------
for (const sh of tunnelShafts()) {
  const lx = sh.sx > 0 ? sh.x1 : sh.x0; // the outer wall's inner face
  LADDERS.push({
    x: lx, z: TUNNEL_EXIT.shaftZ, nx: -sh.sx, nz: 0, y0: TUNNEL_EXIT.floor + 0.05, y1: sh.top - 0.3, speed: 5.2,
    exit: [lx + sh.sx * 1.0, sh.top + 0.05, TUNNEL_EXIT.shaftZ],
  });
}
