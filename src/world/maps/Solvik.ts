import { clamp, fbm2, ridged2, smoothstep, lerp } from '../../core/math';
import type { Landmark, SpawnPoint } from '../MapLayout';

/**
 * "Solvik" (Update 42) — a compact, three-lane town for the 6v6 Sabotasje mode: a warm sandstone
 * and timber trading town on a terrace above a deep fjord, in the evening sun. The layout reads
 * like a classic bomb-defusal map (two sites, a long open mid, connectors and an underpass) but
 * the place is Norwegian: a fortress courtyard, a stave church, wharf lofts, boathouses, a quay
 * promenade at the waterline, and a fjord wall with waterfalls across the water.
 *
 *            N (−z)            the fjord (east, +x)
 *   A  Borggården ─ Kirketorget (CT) ─ Kirketrappa ─ B  Brygga
 *   │ Porten   Smuget   │ Vinduet looks down mid    │ balcony · Kortgata · Kjelleren
 *   Steinsmauet  Palasset  Allmenningen (mid)   Loftet   Fiskarbuene   Kaipromenaden
 *            Toppen (top mid) ─ Stasjonen (T)
 *
 * Pure data and height functions (no three.js): the terrain workers import it.
 * Coordinates: +X east, +Z south, +Y up. Sea level y = 0.
 */
export const SV_PLAY = 80;
export const SV_INNER = 112;

// ---------------- levels ----------------
export const LV = { T: 8, A: 9.2, CT: 9.6, B: 5, KJ: 4.6, DECK: 1.9 };

/** walkable rectangles (x0, z0, x1, z1) used by the builder for paving and by the game for callouts */
export interface Rect { x0: number; z0: number; x1: number; z1: number }
const R = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });

/** the town's areas (keys used by the builder) */
export const AREA = {
  tspawn: R(-66, 46, 64, 76),
  tspawnE: R(64, 52, 72, 76),
  aLane: R(-64, -12, -50, 46),
  aRamp: R(-64, -20, -50, -12),
  aSite: R(-70, -62, -21, -20),
  topMid: R(-12, 26, 12, 46),
  topMidE: R(12, 38, 26, 46),
  mid: R(-7, -36, 7, 26),
  midRamp: R(-7, -46, 7, -36),
  conn: R(-26, -16, -7, -11),
  connN: R(-26, -20, -21, -11),
  ct: R(-21, -62, 20, -46),
  ctBack: R(-21, -78, -8, -62),
  ctStairs: R(20, -62, 34, -50),
  bShort: R(7, -24, 26, -12),
  kjHall: R(16, -2, 24, 30),
  kjSouth: R(16, 30, 24, 38),
  kjNorth: R(16, -12, 24, -2),
  yard: R(26, 30, 50, 46),
  bLane: R(50, 8, 64, 46),
  bLaneRamp: R(50, -4, 64, 8),
  bSite: R(26, -60, 72, -4),
  deck: R(65, -6, 72, 34),
  deckStairs: R(65, 34, 72, 52),
  deckUp: R(65, -16, 72, -6),
};

/** the two charge sites: centre, and the plant zone */
export const SV_SITES: { letter: 'A' | 'B'; name: string; x: number; z: number; zone: Rect }[] = [
  { letter: 'A', name: 'Borggården', x: -46, z: -42, zone: R(-60, -56, -30, -26) },
  { letter: 'B', name: 'Brygga', x: 47, z: -34, zone: R(34, -50, 62, -18) },
];

const inR = (r: Rect, x: number, z: number, m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;
/** distance outside a rectangle (0 inside) */
const outR = (r: Rect, x: number, z: number) => Math.max(0, r.x0 - x, x - r.x1, r.z0 - z, z - r.z1);

/** B short's floor: down from the town level at its mid end to the quay at B */
export const bShortY = (x: number) => lerp(LV.T, LV.B, smoothstep(12, 26, x));

/** The town floor (designed levels and ramps) at a point inside the town. */
function townY(x: number, z: number): number {
  let y = LV.T;
  // the rocky foreshore under the quay promenade (the sea wall stands at x 64–65)
  if (x > 64.5 && z > -18 && z < 52) return 1.0;
  const ramp = (r: Rect, axis: 'x' | 'z', y0: number, y1: number) => {
    if (!inR(r, x, z)) return false;
    const t = axis === 'x' ? (x - r.x0) / (r.x1 - r.x0) : (z - r.z0) / (r.z1 - r.z0);
    y = lerp(y0, y1, clamp(t, 0, 1));
    return true;
  };
  // the raised fortress courtyard and the church square
  if (inR(AREA.aSite, x, z, 1)) y = LV.A;
  if (inR(AREA.ct, x, z, 1) || inR(AREA.ctBack, x, z, 1) || (x > -24 && x < 22 && z < -46)) y = LV.CT;
  // the quay (B) and everything north / east of the boathouses
  if (x > 25 && z < -3) y = LV.B;
  // ramps
  ramp(AREA.aRamp, 'z', LV.A, LV.T);
  ramp(R(-37, -20, -33, -12), 'z', LV.A, LV.T); // the palace corridor's last stretch
  ramp(AREA.connN, 'z', LV.A, LV.T);
  ramp(AREA.midRamp, 'z', LV.CT, LV.T);
  ramp(AREA.ctStairs, 'x', LV.CT, LV.B);
  ramp(AREA.bLaneRamp, 'z', LV.B, LV.T);
  if (inR(AREA.bShort, x, z)) y = bShortY(x);
  // the underpass: a stairwell down from top mid, the vaulted hall, a ramp up into B short
  // (carved 1.4 m wider than the passage each side: the terrain grid's slope stays inside the walls)
  const W0 = AREA.kjHall.x0 - 1.4, W1 = AREA.kjHall.x1 + 1.4;
  if (inR(R(W0, AREA.kjHall.z0, W1, AREA.kjHall.z1), x, z)) y = LV.KJ;
  ramp(R(W0, AREA.kjSouth.z0, W1, AREA.kjSouth.z1), 'z', LV.KJ, LV.T);
  if (inR(R(W0, AREA.kjNorth.z0, W1, AREA.kjNorth.z1), x, z)) y = lerp(bShortY(Math.min(Math.max(x, AREA.kjNorth.x0), AREA.kjNorth.x1)), LV.KJ, clamp((z - AREA.kjNorth.z0) / (AREA.kjNorth.z1 - AREA.kjNorth.z0), 0, 1));
  return y;
}

/** fjord shoreline (the town's sea wall / quay edge is at x ≈ 72–74) */
export const shoreX = (z: number) => 74.5 + 0.4 * Math.sin(z * 0.03) + (z > 80 ? (z - 80) * 0.35 + 6 * Math.sin(z * 0.05) : 0) + (z < -80 ? (-80 - z) * 0.12 + 5 * Math.sin(z * 0.04) : 0);
/** the far fjord wall (east bank) */
const farX = (z: number) => 640 + 60 * Math.sin(z * 0.003 + 1) + 40 * fbm2(z * 0.003, 4.0, 3);

/** Signed distance to the fjord (positive on land). */
export function svSeaDist(x: number, z: number): number {
  return Math.max(shoreX(z) - x, x - farX(z));
}

/** Natural terrain (the town floor inside, hills / cliffs / the fjord around it). */
export function svNatural(x: number, z: number): number {
  const town = x > -74 && x < 78 && z > -82 && z < 80;
  const sd = shoreX(z) - x; // > 0 west of the shore
  if (town && sd > 1.2) return townY(x, z);
  // ---- the fjord ----
  const far = farX(z);
  if (x > far) {
    // the far side: a sea cliff, a steep wooded slope with ledges and gullies, then the massif
    // stepping back to snowy summits (~1100 m) a kilometre and more away
    const d = x - far;
    const n = fbm2(x * 0.004, z * 0.004, 5);
    const gully = ridged2(z * 0.011 + 3, x * 0.0025, 3);
    let h = 950 * (1 - Math.exp(-d / 360)) + Math.min(d, 40) * 2.2;
    h -= gully * 70 * smoothstep(30, 260, d);
    const ledge = Math.floor(h / 70) * 70 + Math.pow((h % 70) / 70, 2.5) * 70;
    h = lerp(h, ledge, 0.55);
    h += ridged2(x * 0.0028, z * 0.0028, 4) * 300 * smoothstep(250, 900, d) + n * 60;
    h += fbm2(x * 0.02, z * 0.02, 3) * 10;
    return h;
  }
  if (sd < 0) {
    // water: shallow along the quay foot, then very deep
    const dw = Math.min(-sd, x - far < 0 ? far - x : 0);
    return lerp(0.6, -60, smoothstep(0, 40, dw)) + (dw < 3 ? -0.8 * (dw / 3) : 0);
  }
  // ---- the land around the town (west bank) ----
  const ex = Math.max(-74 - x, 0), ez = Math.max(-82 - z, 0), es = Math.max(z - 80, 0);
  const n = fbm2(x * 0.01, z * 0.01, 5);
  let h = LV.T + 2;
  // west: a forested hillside rising gently (the low evening sun from the west-south-west clears it)
  h += ex * 0.08 + Math.pow(ex / 300, 2) * 60;
  // north behind the church: a rock slope, then the mountains at the head of the fjord
  h += ez * 0.3 + Math.pow(ez / 140, 2) * 70 + ridged2(x * 0.004, z * 0.004, 5) * 320 * smoothstep(150, 700, ez);
  // south: hills behind the station
  h += es * 0.12 + Math.pow(es / 250, 2) * 50;
  h += n * 6 * smoothstep(0, 30, ex + ez + es);
  // along the shore outside the town: a rocky bank
  if (sd < 24) h = lerp(0.8, h, smoothstep(0, 24, sd));
  return h;
}

/** after roads / pads: nothing (the town floor is already exact) */
export function svTerrainPost(_x: number, _z: number, h: number) {
  return h;
}

export function svForest(x: number, z: number, h: number): number {
  if (h < 2) return 0;
  if (x > farX(z) + 30) return clamp((0.5 + 0.5 * fbm2(x * 0.02, z * 0.02, 3) - 0.3) * 2 * (1 - smoothstep(220, 420, h)), 0, 1);
  if (x > -76 && x < 80 && z > -84 && z < 82) return 0;
  if (x > shoreX(z) - 6) return 0;
  const f = 0.5 + 0.5 * fbm2(x * 0.02 + 11, z * 0.02 - 5, 4);
  // birch and pine on the hillsides, thinning to bare rock up high
  const zone = 1 - smoothstep(180, 340, h);
  const edge = smoothstep(84, 100, Math.max(-x, Math.abs(z)));
  return clamp((f * zone * edge - 0.2) * 2.1, 0, 1);
}

// ---------------- buildings (solid masses: the builder dresses them) ----------------
export type SvStyle = 'stone' | 'stucco' | 'timber' | 'fort' | 'church' | 'boathouse' | 'station' | 'hall';
export interface SvBlock { x0: number; z0: number; x1: number; z1: number; h: number; style: SvStyle; color?: string; seed: number; name?: string; roof?: 'tile' | 'turf' | 'slate' | 'flat' }
const B = (x0: number, z0: number, x1: number, z1: number, h: number, style: SvStyle, seed: number, extra: Partial<SvBlock> = {}): SvBlock => ({ x0, z0, x1, z1, h, style, seed, ...extra });
/** street-facing blocks between the lanes (heights are wall heights above the local floor) */
export const SV_BLOCKS: SvBlock[] = [
  // west edge: the A lane's outer row (backs onto the hillside) and the spawn's west end
  B(-78, -12, -64, 8, 10, 'stucco', 1, { color: 'j_cream', roof: 'tile' }),
  B(-78, 8, -64, 26, 8, 'timber', 2, { color: 'red', roof: 'turf' }),
  B(-78, 26, -64, 46, 11, 'stucco', 3, { color: 'j_ochre', roof: 'tile' }),
  B(-82, 46, -66, 76, 9, 'timber', 14, { color: 'white', roof: 'slate' }),
  // between the A lane and mid
  B(-50, 10, -7, 26, 9, 'stone', 4, { roof: 'tile', name: 'Lagerhuset' }),
  B(-50, 26, -12, 46, 10, 'stucco', 5, { color: 'j_salmon', roof: 'tile' }),
  B(-26, -11, -7, 10, 9, 'timber', 6, { color: 'white', roof: 'slate' }),
  B(-21, -46, -7, -16, 11, 'stone', 7, { roof: 'tile', name: 'Rådhuset' }),
  // between mid and the B side
  B(7, -12, 16, 26, 9, 'stucco', 8, { color: 'j_yellow', roof: 'tile', name: 'Bakeriet' }),
  B(12, 26, 16, 38, 8, 'timber', 13, { color: 'ochre', roof: 'turf' }),
  B(20, -50, 26, -24, 7, 'timber', 15, { color: 'red', roof: 'turf' }),
  // the station row behind the attackers' spawn
  B(-66, 76, 76, 90, 9, 'station', 10, { name: 'Stasjonen' }),
  // north: the boathouses along the quay behind B, the CT buildings
  B(26, -78, 72, -62, 8, 'boathouse', 11),
  B(-8, -84, 22, -62, 12, 'stucco', 12, { color: 'j_jwhite', roof: 'tile', name: 'Vinduet' }),
  B(22, -84, 26, -62, 9, 'stone', 16, { roof: 'tile' }),
];
/** the walled churchyard (not walkable; the stave church stands in it) */
export const SV_CHURCH = R(7, -46, 20, -24);

/** planted grass (no paving): the churchyard, beds in the fortress courtyard and the station square */
export const SV_GRASS: Rect[] = [R(7.6, -45.4, 19.4, -24.6)];

/** Interior buildings with routes through them (built by hand in SolvikBuild). */
export const SV_PALACE = R(-50, -20, -26, 10);
export const SV_LOFT = R(26, -4, 50, 30);
export const SV_KJELLER = R(14, -2, 26, 30);
/** the fortress walls around A (outer box) */
export const SV_FORT = R(-78, -72, -21, -20);

export const SV_LANDMARKS: Landmark[] = [
  { name: 'A · Borggården', x: -46, z: -42, r: 20 },
  { name: 'A · Porten', x: -57, z: -18, r: 7 },
  { name: 'Borgmuren', x: -46, z: -64, r: 8 },
  { name: 'Steinsmauet', x: -57, z: 18, r: 26 },
  { name: 'Palasset', x: -40, z: -4, r: 14 },
  { name: 'Smuget', x: -16, z: -14, r: 9 },
  { name: 'Allmenningen', x: 0, z: -6, r: 28 },
  { name: 'Toppen', x: 4, z: 38, r: 14 },
  { name: 'Kirketorget', x: 0, z: -54, r: 16 },
  { name: 'Vinduet', x: 6, z: -68, r: 8 },
  { name: 'Kirketrappa', x: 27, z: -56, r: 8 },
  { name: 'Kortgata', x: 16, z: -18, r: 9 },
  { name: 'Kjelleren', x: 20, z: 14, r: 18 },
  { name: 'Loftet', x: 38, z: 12, r: 16 },
  { name: 'Bakgården', x: 38, z: 38, r: 10 },
  { name: 'Fiskarbuene', x: 57, z: 22, r: 22 },
  { name: 'Kaipromenaden', x: 68, z: 14, r: 26 },
  { name: 'B · Brygga', x: 47, z: -34, r: 22 },
  { name: 'Stasjonen', x: 0, z: 62, r: 40 },
];

/** Spawns per side: team 0 entries are the attackers' (south), team 1 the defenders' (north). */
export const SV_SPAWNS: SpawnPoint[] = [
  { x: -14, z: 60, yaw: 0, team: 0 }, { x: -6, z: 64, yaw: 0, team: 0 }, { x: 2, z: 60, yaw: 0, team: 0 },
  { x: 10, z: 64, yaw: 0, team: 0 }, { x: 18, z: 60, yaw: 0, team: 0 }, { x: -22, z: 64, yaw: 0, team: 0 },
  { x: -4, z: -56, yaw: Math.PI, team: 1 }, { x: 4, z: -52, yaw: Math.PI, team: 1 }, { x: -12, z: -52, yaw: Math.PI, team: 1 },
  { x: 12, z: -56, yaw: Math.PI, team: 1 }, { x: -14, z: -66, yaw: Math.PI, team: 1 }, { x: -16, z: -72, yaw: Math.PI, team: 1 },
];

/** menu soldier: on the B quay by the railing, the camera inland (west), the fjord wall behind */
export const SV_MENU = { x: 68, z: -38, yaw: Math.PI / 2 };

/** the far wall's waterfalls (Seven Sisters style) and the river falling into the fjord's head */
export const SV_FAR_FALLS: [number, number, number][] = [
  [700, -150, 9], [704, -105, 6], [708, -60, 10], [712, -20, 6], [716, 22, 8], [718, 64, 6], [720, 104, 9],
  [690, 260, 10], [660, -420, 12], [240, -820, 10],
];
