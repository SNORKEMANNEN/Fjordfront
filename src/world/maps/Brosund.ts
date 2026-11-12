import { clamp, fbm2, ridged2, smoothstep, simplex2, lerp, RNG } from '../../core/math';
import type { Road, BuildingDef, Landmark, SpawnPoint, V2 } from '../MapLayout';

/**
 * "Brosund" (Update 34) — a fictional Jugendstil harbour town on three islands, after Ålesund and
 * the Sunnmøre Alps. Pure data and height functions (no three.js): the terrain workers import it.
 *
 *   West: the open Atlantic. Nørvøya (north-west island, "A") with the town's north half and the
 *   viewpoint hill Aksla; the canal Brosundet; Aspøya ("B", south-west) with the town's south half,
 *   the breakwater lighthouse and a beach with turquoise shallows.
 *   Middle: the sound, crossed by the cable-stayed Sundbrua (south) and the undersea Sundtunnelen
 *   (north). East: Ellingsøya ("C") — harbour, an alpine valley with a glacial lake and a snowfield,
 *   a mountain shelf farm, cliffs and waterfalls into the deep fjord south of it, and the peaks.
 *
 * Coordinates: +X east, +Z south, +Y up. Sea level y = 0. Play area ±BR_PLAY.
 */
export const BR_PLAY = 225;
export const BR_INNER = 245;

// ---------------- water bodies ----------------
export const CANAL_HW = 11;
export const QUAY_Y = 2.3;
export const canalZ = (x: number) => 4 + 6 * Math.sin((x + 40) * 0.017);
export const canalSlope = (x: number) => 6 * 0.017 * Math.cos((x + 40) * 0.017);
export const soundX = (z: number) => 70 + 5 * Math.sin(z * 0.011 + 0.5);
export const soundHW = (z: number) => 34 + 3 * Math.sin(z * 0.02 + 1) - 4 * Math.exp(-Math.pow((z + 140) / 40, 2));
const atlanticX = (z: number) => -186 + 6 * Math.sin(z * 0.023 + 1) + 4 * simplex2(z * 0.012, 2.0);
const northZ = (x: number) => -204 + 7 * Math.sin(x * 0.02) + 3 * simplex2(x * 0.015, 7);
const bSouthZ = (x: number) => 186 + 7 * Math.sin(x * 0.025 + 2) + 3 * simplex2(x * 0.02, 3);
const cSouthZ = (x: number) => 150 + 6 * Math.sin(x * 0.03) + 4 * simplex2(x * 0.01, 5);
const fjordSouthZ = (x: number) => 300 + 20 * Math.sin(x * 0.004) + 12 * simplex2(x * 0.006, 9);
/** the glacial lake in the valley (its own water surface) */
export const LAKE = { x: 200, z: -50, rx: 17, rz: 11, y: 19 };

/** Signed distance to the sea (positive on land), and which body is nearest. */
export function seaDist(x: number, z: number): number {
  let d = x - atlanticX(z);
  // north sea (Nørvøya's and Ellingsøya's north coast); the north-east is mountains
  d = Math.min(d, Math.max(z - northZ(x), x - (250 + Math.max(0, -z - 204) * 0.8)));
  if (x > -240 && x < 60) d = Math.min(d, Math.abs(z - canalZ(x)) - CANAL_HW);
  d = Math.min(d, Math.abs(x - soundX(z)) - soundHW(z));
  // south: B's beach coast west of the sound, C's fjord coast east of it, the fjord's south wall
  const south = x < soundX(z) ? bSouthZ(x) : cSouthZ(x);
  const massif = Math.min(z - fjordSouthZ(x), x + 60 + (z - 300) * 0.5);
  d = Math.min(d, Math.max(south - z, massif));
  return d;
}

/** Shore kind at a coastal point: quays (vertical walls) along the canal and the two harbours. */
function quayShore(x: number, z: number) {
  if (x > -240 && x < 52 && Math.abs(z - canalZ(x)) < CANAL_HW + 30) return true; // the canal (incl. both ends)
  const sx = soundX(z);
  if (x < sx && z > -60 && z < 80 && x > 10) return true; // town waterfront on the sound
  if (x > sx && z > -60 && z < 82 && x < 135) return true; // Ellingsøya harbour
  return false;
}

// ---------------- the undersea tunnel ----------------
/** Sundtunnelen: centre line, floor profile and cross-section. */
export const TUN = { hw: 5.0, wall: 3.3, crown: 6.6, carve: 3.2, capBand: 6.5, floorW: 2.2, floorE: 2.2, bottom: -11 };
export interface TunPt { x: number; z: number; s: number; tx: number; tz: number; y: number }
let tunPath: TunPt[] | null = null;
/** Sampled centre line every 1 m from the west portal (Nørvøya, facing south) to the east portal (Ellingsøya, facing south). */
export function tunnelPath(): TunPt[] {
  if (tunPath) return tunPath;
  const pts: { x: number; z: number; tx: number; tz: number }[] = [];
  const straight = (x0: number, z0: number, x1: number, z1: number) => {
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L);
    for (let i = 0; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, z: z0 + ((z1 - z0) * i) / n, tx: (x1 - x0) / L, tz: (z1 - z0) / L });
  };
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
    const L = Math.abs(a1 - a0) * r, n = Math.ceil(L), sg = Math.sign(a1 - a0);
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, tx: -Math.sin(a) * sg, tz: Math.cos(a) * sg });
    }
  };
  // west portal (-30,-75) heading north, sweeping right to head east under the sound,
  // then right again to come up heading south into the harbour on Ellingsøya
  straight(-30, -75, -30, -95);
  arc(20, -95, 50, Math.PI, Math.PI * 1.5);
  straight(20, -145, 95, -145);
  arc(95, -95, 50, -Math.PI / 2, 0);
  straight(145, -95, 145, -70);
  pts.push({ x: 145, z: -70, tx: 0, tz: 1 });
  let s = 0;
  const out: TunPt[] = [];
  pts.forEach((p, i) => {
    if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    out.push({ ...p, s, y: 0 });
  });
  const total = s;
  const down = (TUN.floorW - TUN.bottom) / 0.13;
  const up = (TUN.floorE - TUN.bottom) / 0.12;
  for (const p of out) {
    const t = p.s;
    p.y = t < down ? TUN.floorW - 0.13 * t : t > total - up ? TUN.bottom + 0.12 * (t - (total - up)) : TUN.bottom;
  }
  // vertical curves: a short moving average over the profile
  const ys = out.map((p) => p.y);
  for (let i = 0; i < out.length; i++) {
    let a = 0, n = 0;
    for (let k = -8; k <= 8; k++) {
      const j = clamp(i + k, 0, out.length - 1);
      a += ys[j];
      n++;
    }
    out[i].y = i < 3 ? TUN.floorW : i > out.length - 4 ? TUN.floorE : a / n;
  }
  tunPath = out;
  return out;
}
export function tunnelLength() {
  const p = tunnelPath();
  return p[p.length - 1].s;
}
/** Emergency features along the tunnel (path distance s, side +1 = right going east). */
export const TUN_FEATURES = {
  /** turnaround lay-by (the photo's "Snu og køyr ut"): widened bay on the left, blue light, SOS */
  layby: { s0: 128, s1: 152, side: -1 as 1 | -1, width: 6.5 },
  /** red emergency telephone booths ("NØDTELEFON") — odd stations: each fills one 2 m wall segment */
  phones: [{ s: 47, side: 1 as 1 | -1 }, { s: 111, side: 1 as 1 | -1 }, { s: 197, side: -1 as 1 | -1 }, { s: 249, side: 1 as 1 | -1 }],
  /** green-lit emergency exit niches */
  exits: [{ s: 85, side: -1 as 1 | -1 }, { s: 225, side: 1 as 1 | -1 }],
  /** pump station: a steel door into a side chamber at the low point */
  pump: { s: 169, side: 1 as 1 | -1 },
  /** kept for compatibility (old SOS niches) */
  niches: [] as { s: number; side: 1 | -1 }[],
};

/** Grid bucket of path samples for fast nearest-point queries (terrain workers call this a lot). */
let tunGrid: Map<number, number[]> | null = null;
const TG = 16;
function tunBuckets() {
  if (tunGrid) return tunGrid;
  tunGrid = new Map();
  const P = tunnelPath();
  const R = TUN.hw + TUN.carve + TUN.capBand + 30;
  P.forEach((p, i) => {
    for (let gi = Math.floor((p.x - R) / TG); gi <= Math.floor((p.x + R) / TG); gi++)
      for (let gj = Math.floor((p.z - R) / TG); gj <= Math.floor((p.z + R) / TG); gj++) {
        const k = (gi + 256) * 512 + gj + 256;
        let l = tunGrid!.get(k);
        if (!l) tunGrid!.set(k, (l = []));
        l.push(i);
      }
  });
  return tunGrid;
}
/** Nearest tunnel centre-line sample: lateral distance d (signed, + = right of travel east), index, along offset. */
export function tunnelNearest(x: number, z: number): { d: number; i: number; along: number } | null {
  const l = tunBuckets().get((Math.floor(x / TG) + 256) * 512 + Math.floor(z / TG) + 256);
  if (!l) return null;
  const P = tunnelPath();
  let best = 1e9, bi = -1;
  for (const i of l) {
    const p = P[i];
    const dd = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
    if (dd < best) {
      best = dd;
      bi = i;
    }
  }
  if (bi < 0) return null;
  const p = P[bi];
  const along = (x - p.x) * p.tx + (z - p.z) * p.tz;
  // signed lateral offset: + = right of travel (travelling east, right is south / +z)
  const d = -(x - p.x) * p.tz + (z - p.z) * p.tx;
  return { d, i: bi, along };
}
/** Is (x,z) beyond the portal ends of the bore (in front of a portal)? */
function pastEnd(t: { i: number; along: number }) {
  const P = tunnelPath();
  return (t.i === 0 && t.along < -0.3) || (t.i === P.length - 1 && t.along > 0.3);
}
/** Floor height of the bore at (x,z) if inside its footprint (|d| < hw + extra), else null. */
export function tunnelFloorAt(x: number, z: number, extra = 0): number | null {
  const t = tunnelNearest(x, z);
  if (!t || pastEnd(t) || Math.abs(t.d) > TUN.hw + extra) return null;
  return tunnelPath()[t.i].y;
}
/** Inside the bore volume (for acoustics, the underwater filter, splashes). */
export function inBrosundTunnel(x: number, y: number, z: number, margin = 0.5) {
  const t = tunnelNearest(x, z);
  if (!t || pastEnd(t)) return false;
  const P = tunnelPath()[t.i];
  const lay = TUN_FEATURES.layby;
  let hw = TUN.hw + margin;
  if (P.s > lay.s0 - 4 && P.s < lay.s1 + 4 && Math.sign(t.d) === lay.side) hw += lay.width;
  if (Math.abs(t.d) > hw + 3.5) return false;
  return y > P.y - 1.5 && y < P.y + TUN.crown + 1;
}

// ---------------- terrain ----------------
const AKSLA = { x: -100, z: -112, h: 68 };

function landHeight(x: number, z: number, sd: number): number {
  let h = 3.2 + fbm2(x * 0.012, z * 0.012, 3) * 2.2 + fbm2(x * 0.05 + 3, z * 0.05, 2) * 0.6;
  const west = x < soundX(z);
  // ---- the town on both sides of the canal: a gentle rise away from the water ----
  if (west) {
    const dc = z - canalZ(x);
    const a = Math.abs(dc);
    const town = 2.4 + Math.max(0, a - 17) * (dc < 0 ? 0.075 : 0.05);
    const tm = (1 - smoothstep(dc < 0 ? 72 : 95, dc < 0 ? 92 : 115, a)) * smoothstep(-200, -180, x) * (1 - smoothstep(30, 48, x));
    h = lerp(h, town, tm);
    // a rock knoll over the west portal (the portal face is cut into it)
    h += 12 * Math.exp(-(Math.pow((x + 26) / 22, 2) + Math.pow((z + 100) / 20, 2)));
    // Nørvøya's north-east hills over the tunnel
    h += 13 * Math.exp(-(Math.pow((x - 5) / 48, 2) + Math.pow((z + 140) / 42, 2))) + 6 * fbm2(x * 0.03, z * 0.03, 2) * smoothstep(-70, -110, z);
    // Aksla: steep to the town (south / east), long slope west and north; a summit plateau
    {
      const dx = x - AKSLA.x, dz = z - AKSLA.z;
      const r2 = Math.pow(dx / (dx > 0 ? 44 : 62), 2) + Math.pow(dz / (dz > 0 ? 46 : 70), 2);
      let a2 = AKSLA.h * Math.exp(-r2 * 1.5);
      a2 += ridged2(x * 0.045, z * 0.045, 3) * 5 * Math.exp(-r2);
      a2 = Math.min(a2, 56.8 + fbm2(x * 0.05, z * 0.05, 2) * 0.6);
      h = Math.max(h, h * 0.4 + a2);
    }
    // Aspøya's hill and the beach behind the south shore
    h += 17 * Math.exp(-(Math.pow((x + 92) / 46, 2) + Math.pow((z - 135) / 34, 2)));
    // the bridge approach embankment area east of town is lower
  } else {
    // ---- Ellingsøya ----
    // valley centre line from the harbour north-east into the mountains
    const vz = -46 - (x - 150) * 0.12;
    const floor = 2.6 + Math.max(0, Math.min(x, 290) - 150) * 0.36 + 3 * smoothstep(165, 178, x);
    const dv = Math.abs(z - vz);
    const half = 26 + 6 * Math.sin(x * 0.05);
    let wall = 62 * Math.pow(smoothstep(half, half + 75, dv), 1.15) + 9 * ridged2(x * 0.03 + 4, z * 0.03, 3) * smoothstep(half, half + 30, dv);
    // the south side is a long ridge falling to the fjord; north side rises into the massif
    if (z > vz) wall = wall * (1 - 0.3 * smoothstep(110, 150, z)) + 18 * smoothstep(half + 40, half + 110, dv);
    let c = floor + wall + fbm2(x * 0.04, z * 0.04, 2) * 1.2;
    // harbour flats along the sound
    const harb = (1 - smoothstep(128, 146, x)) * smoothstep(-74, -60, z) * (1 - smoothstep(82, 96, z));
    c = lerp(c, QUAY_Y + 0.15 + fbm2(x * 0.08, z * 0.08, 2) * 0.15, harb);
    // portal plaza in front of the east portal
    const pz = 1 - smoothstep(10, 24, Math.hypot((x - 146) * 0.9, z + 52));
    c = lerp(c, 2.6, pz);
    // a coastal shelf from the harbour up to the bridgehead (the road climbs along it)
    {
      const m = (1 - smoothstep(140, 156, x)) * smoothstep(52, 66, z) * (1 - smoothstep(122, 134, z));
      c = lerp(c, 3.0 + Math.max(0, z - 62) * 0.16 + fbm2(x * 0.06, z * 0.06, 2) * 0.5, m);
    }
    // a grassy saddle from the valley floor up to the shelf farm
    {
      const m = Math.exp(-Math.pow((x - 186) / 24, 2)) * smoothstep(-34, -12, z) * (1 - smoothstep(64, 84, z));
      const t = clamp((z - vz) / (68 - vz), 0, 1);
      c = lerp(c, lerp(floor + 2, 30, t) + fbm2(x * 0.05, z * 0.05, 2) * 1.2, m * 0.9);
    }
    // the mountain shelf farm ("Setra")
    const sh = 1 - smoothstep(0.7, 1.1, Math.hypot((x - 182) / 36, (z - 68) / 24));
    c = lerp(c, 30 + fbm2(x * 0.05, z * 0.05, 2) * 1.5, sh);
    // the glacial lake basin
    const lk = Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
    if (lk < 1.6) c = lerp(c, LAKE.y - 1.25 * (1 - lk * lk), 1 - smoothstep(1.0, 1.6, lk));
    // bridgehead shoulder (the Sundbrua deck lands here)
    const bh = 1 - smoothstep(10, 26, Math.hypot(x - 120, z - 115));
    c = lerp(c, 12.2, bh);
    c += 46 * Math.pow(smoothstep(200, 290, x), 1.3);
    h = Math.max(1.0, c);
  }
  // ---- the Sunnmøre Alps: sharp peaks all round the east and south, rising steeply out of the sea ----
  const east = smoothstep(235, 780, x + 40 * simplex2(z * 0.004, 1.3));
  const southWall = smoothstep(0, 520, z - fjordSouthZ(x)) * smoothstep(-300, -40, x + (z - 300) * 0.5);
  const ne = smoothstep(-230, -700, z) * smoothstep(100, 420, x);
  const M = Math.max(east, southWall, ne);
  if (M > 0) {
    const massif = 0.5 + 0.5 * fbm2(x * 0.0016 + 4, z * 0.0016 - 2, 4);
    const ridge = ridged2(x * 0.0042, z * 0.0042, 4);
    const crag = ridged2(x * 0.016 + 3, z * 0.016 - 7, 3);
    let mt = Math.pow(M, 1.15) * (200 + 900 * massif + 420 * ridge) + M * crag * 70;
    // straight out of the sea, but not a slab: buttresses and gullies break the face, the slope
    // eases with height (green lower slopes, bare rock and snow above)
    const g = ridged2(x * 0.009 + 1.7, z * 0.009 - 3.1, 3);
    const sdE = Math.max(0, sd + 70 * (g - 0.45) + 25 * fbm2(x * 0.02, z * 0.02, 2));
    mt = Math.min(mt, 1500 * (1 - Math.exp(-sdE / 500)) + sdE * 0.2 + 6);
    h += mt;
  }
  // far north: low skerry islands (Giske / Vigra) on the horizon
  if (z < -700) h = Math.max(h, (fbm2(x * 0.0025, z * 0.0025, 3) - 0.18) * 280);
  // coast blend
  void sd;
  return h;
}

/** Natural terrain (before roads and pads). */
export function brNatural(x: number, z: number): number {
  const sd = seaDist(x, z) + 2.5 * fbm2(x * 0.06, z * 0.06, 2);
  const quay = quayShore(x, z);
  if (sd < 0) {
    if (quay) {
      // vertical quay walls: deep right away (the canal is a flat -4.2 m channel)
      const inCanal = x > -240 && x < 52 && Math.abs(z - canalZ(x)) < CANAL_HW + 0.5;
      return inCanal ? -4.2 : -4.2 - 14 * smoothstep(8, 60, -sd);
    }
    const west = x < soundX(z);
    // shallow sandy shelf off Aspøya's beach (turquoise) and around the skerries; deep sound and fjord
    const beach = west && z > 150 && x > -170 ? 1 : 0;
    const shelf = beach ? 60 : 14;
    let h = lerp(0.4, -1.2 - (beach ? 2.0 : 12) * smoothstep(0, shelf, -sd) - (beach ? 24 : 16) * smoothstep(shelf, shelf + 200, -sd), smoothstep(0, 6, -sd));
    // the open Atlantic gets deep; the fjord is very deep between the walls
    if (x < -200) h -= 30 * smoothstep(-200, -600, x);
    if (!west && z > 140) h -= 40 * smoothstep(150, 220, z) * smoothstep(0, 40, -sd);
    // skerries in the Atlantic and north of Nørvøya
    if ((x < -195 || z < -215) && x > -620 && x < 80 && z > -560) {
      const sk = fbm2(x * 0.013 + 3.3, z * 0.013 - 1.7, 4);
      h = Math.max(h, (sk - 0.52) * 44 - 1.8);
    }
    return h;
  }
  let L = landHeight(x, z, sd);
  if (quay) return lerp(QUAY_Y, L, smoothstep(5, 26, sd));
  // nothing steeper than a sea cliff: at most ~65° up from the waterline
  // (buttresses, gullies and ledges break the face up so it never reads as a wall)
  const sdN = Math.max(0, sd + 14 * (ridged2(x * 0.035 + 2, z * 0.035 - 5, 3) - 0.5) + 8 * fbm2(x * 0.08, z * 0.08, 2));
  const ledge = Math.floor(sdN / 9) * 9 + Math.pow((sdN % 9) / 9, 3) * 9;
  L = Math.min(L, ledge * 1.9 + 12 + Math.pow(Math.max(0, sdN - 40), 2) * 0.05);
  // natural shore: a beach / rock rising from the waterline; C's fjord coast is a cliff
  const cliff = x > soundX(z) + 20 && z > 100;
  if (cliff) return lerp(0.6, L, Math.pow(smoothstep(0, 9, sd), 0.6));
  return lerp(0.55 + sd * 0.1, L, smoothstep(0, 24, sd));
}

/** Map-specific shaping after roads and pads: the tunnel bore and portal cuttings. */
export function brTerrainPost(x: number, z: number, h: number): number {
  const t = tunnelNearest(x, z);
  if (!t) return h;
  const P = tunnelPath();
  const p = P[t.i];
  const ad = Math.abs(t.d);
  if (!pastEnd(t)) {
    // carve the bore (plus the rock behind the walls and the lay-by bay) to the floor; the cap mesh rebuilds the ground above
    let w = TUN.hw + TUN.carve;
    const lay = TUN_FEATURES.layby;
    if (p.s > lay.s0 - 6 && p.s < lay.s1 + 6 && Math.sign(t.d) === lay.side) w += lay.width;
    if (ad < w) return Math.min(h, p.y - 0.06);
    return h;
  }
  // portal cuttings: a flat road bed as wide as the bore, flaring out over 26 m
  const along = Math.abs(t.along);
  if (along < 34 && ad < TUN.hw + 10) {
    // a flat bed wide enough for the barriers, signal and cabinets, then the rock cut
    const m = (1 - smoothstep(TUN.hw + 3.6, TUN.hw + 9, ad)) * (1 - smoothstep(18, 34, along));
    return lerp(h, p.y - 0.06, m);
  }
  return h;
}

/** The ground over the bore (the cap mesh): it clears the arch and meets the hillside / seabed at the edge. */
export function brCapHeight(x: number, z: number, natural: number): number {
  const t = tunnelNearest(x, z);
  if (!t || pastEnd(t)) return natural;
  const p = tunnelPath()[t.i];
  const lay = TUN_FEATURES.layby;
  let hw = TUN.hw;
  if (p.s > lay.s0 - 6 && p.s < lay.s1 + 6 && Math.sign(t.d) === lay.side) hw += lay.width;
  const ad = Math.abs(t.d) - hw;
  const crown = p.y + TUN.crown + 1.3, fill = p.y + TUN.wall + 1.3;
  let need = ad < 1.2 ? crown : lerp(crown, fill, smoothstep(1.2, 3.0, ad));
  if (ad > TUN.carve) need = lerp(fill, -1e3, smoothstep(TUN.carve, TUN.carve + 2, ad));
  return Math.max(natural, need);
}
/** Beyond a portal end of the bore (the cap mesh must not hang a curtain down over the opening). */
export function brPastPortal(x: number, z: number) {
  const t = tunnelNearest(x, z);
  return !!t && pastEnd(t) && Math.abs(t.d) < TUN.hw + TUN.carve + 8;
}
/** Cap-mesh footprint test. */
export function brCapCovers(x: number, z: number) {
  const t = tunnelNearest(x, z);
  if (!t || pastEnd(t)) return false;
  const p = tunnelPath()[t.i];
  const lay = TUN_FEATURES.layby;
  let hw = TUN.hw;
  if (p.s > lay.s0 - 6 && p.s < lay.s1 + 6 && Math.sign(t.d) === lay.side) hw += lay.width;
  return Math.abs(t.d) < hw + TUN.carve + 1.5 && p.s > 0.8 && p.s < tunnelLength() - 0.8;
}

export function brForest(x: number, z: number, h: number): number {
  if (h < 1.4) return 0;
  const sd = seaDist(x, z);
  if (sd < 4) return 0;
  let f = 0.5 + 0.5 * fbm2(x * 0.02 + 11, z * 0.02 - 5, 4);
  const west = x < soundX(z);
  let zone: number;
  if (west) {
    // the town is clear; Aksla's slopes and the northern hills are birch woods; Aspøya's hill too
    const dc = Math.abs(z - canalZ(x));
    const town = (1 - smoothstep(z < canalZ(x) ? 64 : 86, z < canalZ(x) ? 80 : 100, dc)) * smoothstep(-196, -178, x);
    const aksla = 1 - smoothstep(30, 90, Math.hypot(x - AKSLA.x, z - AKSLA.z));
    zone = Math.max(aksla * 0.9, smoothstep(-80, -130, z) * 0.85, smoothstep(105, 140, z) * 0.6) * (1 - town);
    // the summit plateau stays open
    zone *= smoothstep(10, 22, Math.hypot(x - AKSLA.x, z - AKSLA.z + 4));
  } else {
    const harb = (1 - smoothstep(130, 150, x)) * smoothstep(-80, -60, z) * (1 - smoothstep(80, 100, z));
    const lake = 1 - smoothstep(1.2, 2.2, Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz));
    const shelf = 1 - smoothstep(0.8, 1.2, Math.hypot((x - 182) / 36, (z - 68) / 24));
    // trees thin out with height: birch to ~45 m, then heather and rock
    zone = (1 - harb) * (1 - lake) * (1 - shelf * 0.9) * (1 - smoothstep(40, 70, h));
  }
  // far slopes: forest up to the tree line
  if (Math.max(Math.abs(x), Math.abs(z)) > BR_PLAY + 10) zone = Math.max(zone, 1 - smoothstep(140, 260, h));
  f *= zone;
  return clamp((f - 0.26) * 2.0, 0, 1);
}

/** Snowfield / glacier mask in the valley head (0..1), for the terrain shader and footsteps. */
export const GLACIER = { x: 236, z: -66, rx: 44, rz: 40 };
export function glacierMask(x: number, z: number, h: number) {
  const r = Math.hypot((x - GLACIER.x) / GLACIER.rx, (z - GLACIER.z) / GLACIER.rz) + fbm2(x * 0.05, z * 0.05, 2) * 0.25;
  return (1 - smoothstep(0.75, 1.0, r)) * smoothstep(24, 34, h);
}

// ---------------- layout ----------------
const R90 = Math.PI / 2;
/** Rotation that turns a building's local +X along the canal at x (front +Z faces south). */
const canalRot = (x: number) => -Math.atan(canalSlope(x));

export type JugendColor = 'ochre' | 'salmon' | 'mint' | 'jwhite' | 'deepred' | 'yellow' | 'skyblue' | 'cream';
const PALETTE: JugendColor[] = ['ochre', 'salmon', 'mint', 'jwhite', 'deepred', 'yellow', 'skyblue', 'cream', 'jwhite', 'yellow'];

/** Cross streets (x of the street centre) cutting through the quay rows, and the two canal bridges. */
export const CROSS_STREETS = [-158, -112, -72, -35, 4];
export const CANAL_BRIDGES = [
  { x: -112, w: 8, name: 'Brosundbrua', stone: false },
  { x: -35, w: 9, name: 'Steinbrua', stone: true },
];
export const FOOTBRIDGES = [{ x: -158, w: 2.6 }];

function townBuildings(): BuildingDef[] {
  const rng = new RNG(3401);
  const out: BuildingDef[] = [];
  let last: JugendColor = 'jwhite';
  const pick = () => {
    let c: JugendColor;
    do c = PALETTE[rng.int(0, PALETTE.length - 1)];
    while (c === last);
    last = c;
    return c;
  };
  // rows parallel to the canal: [side, depth offset of the building centre from the canal centre, x0, x1, floors range]
  const rows: [number, number, number, number, number, number][] = [
    [-1, 23.5, -176, 34, 3, 5], // Nørvøya quay front
    [1, 23.5, -176, 30, 3, 5], // Aspøya quay front
    [-1, 45.5, -170, 22, 3, 4], // behind Kongens gate
    [1, 45.5, -170, 18, 3, 4],
    [1, 70, -160, 6, 2, 3], // Aspøya upper street
  ];
  for (const [side, off, x0, x1, f0, f1] of rows) {
    let x = x0;
    let blockStart = true;
    while (x < x1) {
      // skip cross streets (10 m wide)
      const cs = CROSS_STREETS.find((c) => x + 4 > c - 5.5 && x < c + 5.5);
      if (cs !== undefined) {
        x = cs + 5.5;
        blockStart = true;
        continue;
      }
      const w = rng.range(9.5, 15.5);
      const nextCs = CROSS_STREETS.find((c) => c - 5.5 > x && c - 5.5 < x + w + 0.5);
      const ww = nextCs !== undefined ? Math.max(7.5, nextCs - 5.5 - x) : w;
      if (x + ww > x1 + 2) break;
      const cx = x + ww / 2;
      const cz = canalZ(cx) + side * off;
      const corner = blockStart || nextCs !== undefined;
      void corner;
      const d = off > 60 ? 10 : 12;
      const floors = rng.int(f0, f1);
      const rot = canalRot(cx) + (side > 0 ? Math.PI : 0);
      out.push({
        kind: 'jugend', x: cx, z: cz, rot, w: ww - 0.15, d, floors, jcolor: pick(), seed: rng.int(1, 1e6),
        tower: corner && rng.chance(0.75) ? (blockStart ? (side > 0 ? 'R' : 'L') : side > 0 ? 'L' : 'R') : undefined,
        gable: rng.chance(0.55) ? (rng.chance(0.5) ? 'curved' : 'stepped') : 'none',
        roofMat: rng.chance(0.22) ? 'copper' : 'slate',
        enter: off < 50 ? rng.chance(0.85) : rng.chance(0.35),
        open: 0,
      });
      const me = out[out.length - 1];
      if (blockStart) me.open! |= side > 0 ? 2 : 1;
      // occasional alley between buildings (rows stay mostly continuous, like the real canal)
      const alley = rng.chance(0.3);
      if (alley || nextCs !== undefined || x + ww + 9.5 > x1 + 2) me.open! |= side > 0 ? 1 : 2;
      blockStart = alley;
      x += ww + (alley ? 3.2 : 0.0);
    }
  }
  return out;
}

const SITES: BuildingDef[] = [
  // the stone church (its tower is a landmark from everywhere) on Nørvøya's upper street
  { kind: 'stonechurch', x: -2, z: -62, rot: -0.05, name: 'Sundkyrkja' },
  // Fjellstua — the café on Aksla's summit plateau, terrace facing the town
  { kind: 'cafe', x: -98, z: -108, rot: 0.15, w: 20, d: 10, name: 'Fjellstua', padY: 55.5 },
  // Molja: the red breakwater lighthouse at the canal's Atlantic mouth
  { kind: 'molja', x: -214, z: 10, rot: 0, name: 'Molja', padY: 2.6 },
  // Ellingsøya harbour: tall wooden sea houses on the quay
  { kind: 'house', x: 122, z: -38, rot: R90, w: 14, d: 10, floors: 3, color: 'red', seed: 301, name: 'Sjøhusa' },
  { kind: 'house', x: 122, z: -16, rot: R90, w: 12, d: 10, floors: 3, color: 'ochre', seed: 302 },
  { kind: 'house', x: 123, z: 8, rot: R90, w: 14, d: 9, floors: 2, color: 'white', seed: 303 },
  { kind: 'warehouse', x: 126, z: 40, rot: R90, w: 26, d: 16, name: 'Fiskehallen', padY: 2.6 },
  { kind: 'crane', x: 112, z: 64, rot: 0, padY: 2.5 },
  { kind: 'office', x: 140, z: 18, rot: -R90, w: 11, d: 9, padY: 2.7, name: 'Havnekontoret' },
  { kind: 'containers', x: 140, z: 60, rot: R90, padY: 2.6, seed: 311 },
  // the shelf farm with turf roofs
  { kind: 'house', x: 176, z: 62, rot: -0.3, w: 9, d: 7, floors: 2, color: 'red', seed: 321, turf: true, name: 'Setra' },
  { kind: 'barn', x: 192, z: 76, rot: -0.3, w: 14, d: 10, color: 'red', turf: true },
  { kind: 'naust', x: 168, z: 80, rot: 0.6, w: 5, d: 6, color: 'red', seed: 322, turf: true },
  // cabins in the valley by the lake
  { kind: 'house', x: 186, z: -66, rot: 0.3, w: 6.5, d: 5.5, floors: 1, color: 'red', seed: 331, turf: true },
  { kind: 'house', x: 214, z: -36, rot: -0.5, w: 6.5, d: 5.5, floors: 1, color: 'ochre', seed: 332, turf: true },
  { kind: 'naust', x: 197, z: -38, rot: Math.PI - 0.2, w: 5, d: 6, color: 'red', seed: 333, turf: true },
  // Aspøya: wooden villas on the hill, a lookout tower on the hill top
  { kind: 'house', x: -130, z: 112, rot: 0.2, w: 9, d: 7.5, floors: 2, color: 'white', seed: 341 },
  { kind: 'house', x: -64, z: 118, rot: -0.15, w: 8.5, d: 7, floors: 2, color: 'ochre', seed: 342 },
  { kind: 'house', x: -110, z: 152, rot: 0.4, w: 8, d: 7, floors: 2, color: 'red', seed: 343 },
  { kind: 'house', x: -40, z: 150, rot: -0.4, w: 8, d: 6.5, floors: 1, color: 'white', seed: 344 },
  { kind: 'house', x: -150, z: 140, rot: 0.6, w: 8, d: 6.5, floors: 2, color: 'dkgrey', seed: 345 },
  { kind: 'tower', x: -92, z: 133, rot: 0.3 },
  { kind: 'naust', x: -20, z: 178, rot: Math.PI + 0.1, w: 6, d: 9, color: 'red', seed: 346 },
  { kind: 'naust', x: -150, z: 176, rot: Math.PI - 0.15, w: 6, d: 8, color: 'white', seed: 347 },
  // Nørvøya: villas north of town and a watch tower on the tunnel hill
  { kind: 'house', x: -150, z: -96, rot: 0.3, w: 8.5, d: 7, floors: 2, color: 'white', seed: 351 },
  { kind: 'house', x: -168, z: -60, rot: 0.1, w: 8, d: 6.5, floors: 2, color: 'ochre', seed: 352 },
  { kind: 'house', x: 18, z: -98, rot: -0.4, w: 8, d: 7, floors: 2, color: 'red', seed: 353 },
  { kind: 'tower', x: 2, z: -150, rot: 0.2 },
  { kind: 'bunker', x: -170, z: -150, rot: 2.4, seed: 354, name: 'Kanonen' },
];

export function brBuildings(): BuildingDef[] {
  return [...townBuildings(), ...SITES];
}

const lineAlongCanal = (off: number, x0: number, x1: number, step = 12): V2[] => {
  const pts: V2[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += step) pts.push([x, canalZ(x) + off]);
  return pts;
};

/** fixed heights rising evenly along a road (index → y), so a hill road keeps one gentle grade */
function ramp(pts: V2[], y0: number, y1: number): Record<number, number> {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const out: Record<number, number> = {};
  pts.forEach((_, i) => (out[i] = y0 + ((y1 - y0) * L[i]) / L[L.length - 1]));
  return out;
}
/** the Aksla stairs: switchback flights up the east face, landing on Fjellstua's terrace */
const STAIRS: V2[] = [[-67, -51], [-82, -66], [-76, -72], [-94, -72], [-85, -81], [-94, -81], [-88, -87], [-94, -87], [-83.4, -99.4]];
/**
 * Heights for a stair with flat landings (each `landing` m long) at every turn: the rise is shared
 * by the flights in proportion to their length, so every flight has the same grade.
 */
function flightRamp(pts: V2[], y0: number, y1: number, landing: number): Record<number, number> {
  const legs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const trim = (i > 1 ? landing / 2 : landing / 2) + (i < pts.length - 1 ? landing / 2 : 0);
    legs.push(Math.max(0.5, L - trim));
  }
  const total = legs.reduce((a, b) => a + b, 0);
  const out: Record<number, number> = { 0: y0 };
  let acc = 0;
  legs.forEach((l, i) => {
    acc += l;
    out[i + 1] = y0 + ((y1 - y0) * acc) / total;
  });
  return out;
}
/** the road up Aksla's long western slope, looping round the north side to the summit */
const FJELLVEGEN: V2[] = [[-150, -38], [-170, -60], [-172, -92], [-160, -118], [-140, -140], [-116, -150], [-92, -142], [-82, -128], [-92, -116]];

export function brRoads(): Road[] {
  return [
    // the north street behind the quay row, and the south one
    { name: 'Kongens gate', kind: 'asphalt', width: 7, lines: false, pts: lineAlongCanal(-34.5, -176, 34) },
    { name: 'Kipervikgata', kind: 'asphalt', width: 7, lines: false, pts: lineAlongCanal(34.5, -176, 30) },
    { name: 'Øvre gate', kind: 'asphalt', width: 6, lines: false, pts: lineAlongCanal(57.5, -166, 10) },
    // Steinbrua's street: Aspøya → canal → Nørvøya → the tunnel's west portal
    { name: 'Tunnelvegen', kind: 'asphalt', width: 8, lines: true, pts: [[-35, 98], [-35, 70], [-35, 40], [-35, canalZ(-35) + 16], [-35, canalZ(-35) - 16], [-34, -36], [-31, -55], [-30, -66], [-30, -72]], fixed: { 8: TUN.floorW, 7: TUN.floorW + 0.05 } },
    // Brosundbrua's street
    { name: 'Apotekergata', kind: 'asphalt', width: 7, lines: false, pts: [[-112, 70], [-112, canalZ(-112) + 16], [-112, canalZ(-112) - 16], [-112, -46], [-118, -64]] },
    // cross streets
    { name: 'Molovegen', kind: 'asphalt', width: 6, lines: false, pts: [[-158, 70], [-158, canalZ(-158) + 16], [-170, canalZ(-170) + 18], [-186, 22]] },
    { name: 'Rådhusgata', kind: 'asphalt', width: 6, lines: false, pts: [[-72, 70], [-72, canalZ(-72) + 17]] },
    { name: 'Torget', kind: 'asphalt', width: 6, lines: false, pts: [[-72, canalZ(-72) - 17], [-72, -48], [-66, -58]] },
    { name: 'Sundgata', kind: 'asphalt', width: 6, lines: false, pts: [[4, 70], [4, canalZ(4) + 17]] },
    { name: 'Kaivegen', kind: 'asphalt', width: 6, lines: false, pts: [[4, canalZ(4) - 17], [6, -50], [-2, -80]] },
    // Sundbrua approach on Aspøya: from the town up the embankment to the deck
    { name: 'Sundbrua', kind: 'asphalt', width: 8, lines: true, pts: [[-35, 98], [-15, 104], [5, 110], [16, 114], [22, 115]], fixed: { 4: 8.6, 3: 8.0 } },
    // Ellingsøya: from the bridgehead down to the harbour, along the quay to the east portal
    { name: 'Hamnevegen', kind: 'asphalt', width: 8, lines: true, pts: [[122, 115], [130, 111], [134, 100], [135, 86], [135, 72], [134, 50], [134, 20], [134, -10], [138, -34], [145, -50], [145, -60], [145, -66]], fixed: { 0: 11.6, 1: 10.6, 2: 8.2, 3: 5.6, 4: 3.2, 11: TUN.floorE, 10: TUN.floorE + 0.05 } },
    // up the valley to the lake and the snowfield
    { name: 'Dalvegen', kind: 'gravel', width: 4, pts: [[145, -50], [160, -50], [176, -56], [190, -64], [206, -66], [222, -62], [232, -58]] },
    // up to the shelf farm
    { name: 'Setervegen', kind: 'gravel', width: 3.6, pts: [[176, -52], [184, -30], [188, -6], [188, 20], [186, 44], [182, 60], [194, 72]] },
    // Aksla: a gravel road up the long western slope, and the stairs up the steep east face
    { name: 'Fjellvegen', kind: 'gravel', width: 4, pts: FJELLVEGEN, fixed: ramp(FJELLVEGEN, 4.6, 57.4) },
    // (switchback flights found by a grade-limited path search over the hillside: ~25–35° each;
    // the last flight lands on Fjellstua's terrace through the gap in its railing)
    { name: 'Trappene', kind: 'stairs', width: 2.6, pts: STAIRS, fixed: flightRamp(STAIRS, 4.7, 56.0, 2.8) },
    // Aspøya: the hill road and the beach path; the breakwater
    { name: 'Bakkevegen', kind: 'gravel', width: 3.6, pts: [[-112, 70], [-118, 96], [-104, 120], [-92, 128], [-70, 124], [-44, 140], [-24, 160], [-18, 172]] },
    { name: 'Molja', kind: 'gravel', width: 3, pts: [[-186, 22], [-198, 16], [-208, 11]], fixed: { 0: 2.6, 1: 2.6, 2: 2.6 } },
    { name: 'Strandstien', kind: 'dirt', width: 2.2, pts: [[-150, 140], [-130, 168], [-96, 176], [-60, 172], [-24, 160]] },
    // Nørvøya: the coastal path round the north to the gun battery
    { name: 'Nordstien', kind: 'dirt', width: 2.2, pts: [[-150, -38], [-174, -70], [-180, -110], [-172, -146], [-150, -170], [-110, -180], [-60, -172], [-20, -160], [8, -150]] },
  ];
}

export const BR_LANDMARKS: Landmark[] = [
  { name: 'Brosundet', x: -60, z: 6, r: 44 },
  { name: 'Fjellstua', x: -98, z: -106, r: 30 },
  { name: 'Trappene', x: -70, z: -78, r: 22 },
  { name: 'Kyrkja', x: -2, z: -62, r: 20 },
  { name: 'Torget', x: -72, z: -40, r: 22 },
  { name: 'Molja', x: -200, z: 14, r: 22 },
  { name: 'Aspøya', x: -92, z: 130, r: 46 },
  { name: 'Stranda', x: -80, z: 178, r: 40 },
  { name: 'Sundtunnelen', x: 60, z: -145, r: 60 },
  { name: 'Tunnelmunningen', x: -30, z: -66, r: 18 },
  { name: 'Sundbrua', x: 72, z: 115, r: 50 },
  { name: 'Kaia', x: 128, z: 0, r: 46 },
  { name: 'Portalen', x: 146, z: -52, r: 20 },
  { name: 'Dalen', x: 200, z: -50, r: 36 },
  { name: 'Snøfonna', x: 226, z: -76, r: 26 },
  { name: 'Setra', x: 182, z: 68, r: 34 },
  { name: 'Kanonen', x: -170, z: -150, r: 26 },
];

/** Five fixed Domination sites (west → east): two per side and the tunnel in the middle. */
export const BR_FLAGS: { letter: 'A' | 'B' | 'C' | 'D' | 'E'; name: string; x: number; z: number; y?: number }[] = [
  { letter: 'A', name: 'Fjellstua', x: -94, z: -98 },
  { letter: 'B', name: 'Brosundet', x: -72, z: canalZ(-72) - 14 },
  { letter: 'C', name: 'Sundtunnelen', x: 0, z: 0 }, // set from the lay-by (see brFlagSites)
  { letter: 'D', name: 'Kaia', x: 130, z: 2 },
  { letter: 'E', name: 'Dalen', x: 192, z: -56 },
];
export function brFlagSites() {
  const P = tunnelPath();
  const lay = TUN_FEATURES.layby;
  const mid = P[Math.round((lay.s0 + lay.s1) / 2)];
  return BR_FLAGS.map((f) => (f.letter === 'C' ? { ...f, x: mid.x, z: mid.z, y: mid.y } : f));
}

export const BR_SPAWNS: SpawnPoint[] = [
  // team 0 — west: Aspøya by the breakwater and the beach
  { x: -170, z: 60, yaw: -R90, team: 0 }, { x: -176, z: 90, yaw: -R90, team: 0 }, { x: -150, z: 70, yaw: -R90, team: 0 },
  { x: -160, z: 110, yaw: -R90, team: 0 }, { x: -136, z: 86, yaw: -R90, team: 0 }, { x: -182, z: 40, yaw: -R90, team: 0 },
  // team 1 — east: Ellingsøya's shelf farm
  { x: 186, z: 60, yaw: R90, team: 1 }, { x: 172, z: 70, yaw: R90, team: 1 }, { x: 196, z: 66, yaw: R90, team: 1 },
  { x: 180, z: 80, yaw: R90, team: 1 }, { x: 168, z: 58, yaw: R90, team: 1 }, { x: 202, z: 82, yaw: R90, team: 1 },
  // neutral
  { x: -120, z: -80, yaw: 0, team: -1 }, { x: -60, z: 150, yaw: Math.PI, team: -1 }, { x: 150, z: -40, yaw: R90, team: -1 },
  { x: 10, z: -110, yaw: 0, team: -1 }, { x: -20, z: 90, yaw: Math.PI, team: -1 }, { x: 214, z: -50, yaw: R90, team: -1 },
];

/** The menu camera: on Fjellstua's terrace looking over the town, the canal, the sound and the peaks. */
export const BR_MENU = { x: -92, z: -100, yaw: Math.PI / 4 };

/** Water-surface tint hint for the shader: the Atlantic side (west) has swells. */
export const BR_SWELL = { x0: -150, x1: -260 };

/** Waterfalls: [top x, z], width, big (landmark) or a cliff stream. Paths follow the terrain downhill. */
export const BR_FALLS: { x: number; z: number; w: number; big?: boolean }[] = [
  { x: 192, z: 136, w: 7, big: true }, // Brudesløret: off the ridge into the fjord
  { x: 214, z: 120, w: 3 },
  { x: 160, z: 140, w: 2.2 },
  { x: 168, z: -50, w: 3.5, big: true }, // the lake's outflow over the valley lip
  { x: 182, z: -96, w: 1.6 },
  { x: 222, z: -100, w: 2 },
  { x: 238, z: -30, w: 2.2 },
  { x: -84, z: -128, w: 1.4 }, // Aksla's north crag
  { x: -120, z: -96, w: 1.2 },
];
/** The far fjord wall waterfalls (backdrop "seven sisters") and other distant falls. */
export const BR_FAR_FALLS: [number, number, number][] = [
  [420, 330, 6], [445, 334, 5], [470, 338, 7], [495, 340, 5], [520, 343, 6], [545, 346, 5], [570, 348, 6],
  [300, 330, 8], [700, 380, 9], [330, -300, 7], [600, -120, 8], [380, 120, 7],
];

/** Ziplines [from, to] (ground points; the posts and heights are worked out at build time) and the cable car. */
export const BR_ZIPS: [V2, V2][] = [
  [[-104, -100], [-120, -30]], // Fjellstua → down into the upper town
  [[-86, -96], [-48, -30]], // Fjellstua → Torget
  [[164, 62], [136, 20]], // Setra → the harbour
  [[178, -74], [150, -40]], // valley wall → the portal plaza
  [[-90, 128], [-60, 72]], // Aspøya hill → the upper street
];
/** Linbanen: a cable car across the sound from Aksla's summit to the valley wall above the lake on Ellingsøya. */
export const BR_CABLECAR = { a: [-92, -116] as V2, b: [186, -92] as V2 };
