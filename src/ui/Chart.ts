import type { Terrain } from '../world/Terrain';
import { ROADS, BUILDINGS, LANDMARKS, PLAY_HALF, TUNNEL, TUNNEL_EXIT, tunnelCapHeight, BuildingDef } from '../world/MapLayout';

/**
 * Sjøkart: the map drawn the way a Norwegian nautical chart is — cream paper land with brown
 * contour lines and pale woodland tint, the sea in depth bands (darkest blue in the shallows,
 * fading to white in deep water) with blue isobaths and italic depth soundings, an inked
 * coastline, red roads, black buildings, cartographic names, a compass rose and a scale bar.
 * One raster of the whole area is built once and shared by the tactical map, the minimap, the
 * menu's operation brief and the room-browser thumbnails.
 */
export const INK = {
  paper: '#EDE6D6',
  paperDark: '#E0D5BD',
  ink: '#14213D',
  ink2: '#2B3A55',
  sea: '#3E7CB1',
  red: '#D7262E',
  contour: 'rgba(132, 92, 52, 0.55)',
  friend: '#2F7DC4',
  foe: '#D7262E',
  gold: '#C98A12',
};
/** fonts (self-hosted, OFL): display, condensed labels, italic serif for water names, mono numbers */
export const FONT = {
  display: "'Big Shoulders Display', 'Arial Narrow', sans-serif",
  cond: "'IBM Plex Sans Condensed', 'Arial Narrow', sans-serif",
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  serif: "'IBM Plex Serif', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
};
/** the raster covers [-B, B] in both axes */
export const B = PLAY_HALF + 14;

const FOOT: Partial<Record<string, [number, number]>> = {
  church: [18, 8], shop: [12, 7], warehouse: [40, 22], office: [10, 7], bunker: [10, 8], gunpit: [10, 10],
  barracks: [14, 6], mast: [4, 4], barn: [14, 9], naust: [5, 7], crane: [12, 12], tanks: [20, 10],
  hjell: [10, 2], containers: [32, 22], rorbu: [6, 5], lighthouse: [7, 7], tower: [3.6, 3.6], radome: [9, 9],
};
export function footprint(b: BuildingDef): [number, number] {
  return [b.w ?? FOOT[b.kind]?.[0] ?? 8, b.d ?? FOOT[b.kind]?.[1] ?? 7];
}

/** sea names (placed only where it really is water) */
export const WATER_NAMES: { name: string; x: number; z: number; size: number }[] = [
  { name: 'Kvitvikfjorden', x: -160, z: -20, size: 1 },
  { name: 'Hamnbukta', x: -60, z: 172, size: 0.8 },
  { name: 'Fyrsundet', x: -150, z: -160, size: 0.75 },
];

let shared: { canvas: HTMLCanvasElement; heights: Float32Array; S: number } | null = null;

/** height for the chart: over the road tunnel the map shows the ridge, not the carved bore */
function chartHeight(t: Terrain, x: number, z: number) {
  const capW = TUNNEL.width / 2 + TUNNEL_EXIT.carve + 1;
  const capped = Math.abs(x - TUNNEL.x) < capW && z > TUNNEL.z0 - 1 && z < TUNNEL.z1 + 1;
  return capped ? tunnelCapHeight(x, z) : t.heightAt(x, z);
}

/** the shared chart raster (built on first use, ~1024²) */
export function chartRaster(t: Terrain) {
  if (shared) return shared;
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const img = x.createImageData(S, S);
  const hs = new Float32Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) hs[j * S + i] = chartHeight(t, -B + ((i + 0.5) / S) * 2 * B, -B + ((j + 0.5) / S) * 2 * B);
  const m = (2 * B) / S;
  const P = [237, 230, 214]; // paper
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const k = j * S + i, o = k * 4;
      const h = hs[k];
      const hR = hs[j * S + Math.min(S - 1, i + 1)], hD = hs[Math.min(S - 1, j + 1) * S + i];
      let r: number, g: number, b: number;
      if (h < 0) {
        // depth bands: 0–2 m darkest, 2–5, 5–10, deeper = near white (chart convention)
        const d = -h;
        const band = d < 2 ? [150, 190, 219] : d < 5 ? [178, 208, 228] : d < 10 ? [204, 223, 236] : [226, 236, 242];
        [r, g, b] = band;
        // isobaths at 2, 5, 10 m
        for (const iso of [2, 5, 10]) {
          if ((-h < iso) !== (-hR < iso) || (-h < iso) !== (-hD < iso)) {
            r = 92; g = 140; b = 182;
          }
        }
      } else {
        // paper, very gentle hill shading from the north-west + pale green woodland
        const hx = hs[j * S + Math.min(S - 1, i + 1)] - hs[j * S + Math.max(0, i - 1)];
        const hz = hs[Math.min(S - 1, j + 1) * S + i] - hs[Math.max(0, j - 1) * S + i];
        const shade = Math.max(0.84, Math.min(1.04, 1 - ((hx * 0.9 + hz * 0.7) / (2 * m)) * 0.16));
        const wx = -B + ((i + 0.5) / S) * 2 * B, wz = -B + ((j + 0.5) / S) * 2 * B;
        const [forest] = t.splatAt(wx, wz);
        r = P[0] - forest * 26; g = P[1] - forest * 10; b = P[2] - forest * 34;
        // hypsometric tint: higher ground a touch warmer
        const elev = Math.min(1, h / 50);
        r = (r - elev * 6) * shade; g = (g - elev * 12) * shade; b = (b - elev * 22) * shade;
        // contours every 5 m, index contour every 25 m
        const c0 = Math.floor(h / 5), cR = Math.floor(hR / 5), cD = Math.floor(hD / 5);
        if (c0 !== cR || c0 !== cD) {
          const idx = Math.max(c0, cR, cD) % 5 === 0;
          const a = idx ? 0.62 : 0.34;
          r = r * (1 - a) + 132 * a; g = g * (1 - a) + 92 * a; b = b * (1 - a) + 52 * a;
        }
      }
      // coastline in ink
      if ((h < 0) !== (hR < 0) || (h < 0) !== (hD < 0)) {
        r = 20; g = 33; b = 61;
      }
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  shared = { canvas: cv, heights: hs, S };
  return shared;
}
/** height from the shared raster's samples (fast, for soundings) */
export function rasterHeight(x: number, z: number) {
  if (!shared) return 0;
  const S = shared.S;
  const i = Math.max(0, Math.min(S - 1, Math.floor(((x + B) / (2 * B)) * S)));
  const j = Math.max(0, Math.min(S - 1, Math.floor(((z + B) / (2 * B)) * S)));
  return shared.heights[j * S + i];
}

export interface View { sx(x: number): number; sy(z: number): number; ppm: number }

/** red roads (asphalt), brown gravel, dashed dirt tracks — chart / topo style */
export function drawRoads(c: CanvasRenderingContext2D, v: View, zoom = 1) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const pass of [0, 1]) {
    for (const r of ROADS) {
      const w = Math.max(r.kind === 'dirt' ? 1 : 1.6, r.width * v.ppm * 0.8);
      if (pass === 0) {
        if (r.kind === 'dirt') continue;
        c.strokeStyle = INK.ink;
        c.lineWidth = w + 1.6;
      } else {
        c.strokeStyle = r.kind === 'asphalt' ? '#E2563C' : r.kind === 'gravel' ? '#E9C98F' : 'rgba(20,33,61,0.75)';
        c.lineWidth = r.kind === 'dirt' ? Math.max(1, 1.1 * Math.min(2, zoom)) : w;
        if (r.kind === 'dirt') c.setLineDash([Math.max(3, 4 * zoom), Math.max(2.5, 3 * zoom)]);
      }
      c.beginPath();
      r.pts.forEach(([x, z], i) => (i ? c.lineTo(v.sx(x), v.sy(z)) : c.moveTo(v.sx(x), v.sy(z))));
      c.stroke();
      c.setLineDash([]);
    }
  }
}

/** buildings as solid ink blocks (containers hatched) */
export function drawBuildings(c: CanvasRenderingContext2D, v: View) {
  for (const b of BUILDINGS) {
    const [w, d] = footprint(b);
    c.save();
    c.translate(v.sx(b.x), v.sy(b.z));
    c.rotate(-b.rot);
    const pw = Math.max(2.2, w * v.ppm), pd = Math.max(2.2, d * v.ppm);
    if (b.kind === 'containers') {
      c.strokeStyle = INK.ink;
      c.lineWidth = 1;
      c.strokeRect(-pw / 2, -pd / 2, pw, pd);
      c.beginPath();
      for (let k = -pw / 2 + 3; k < pw / 2; k += 3) {
        c.moveTo(k, -pd / 2);
        c.lineTo(k, pd / 2);
      }
      c.globalAlpha = 0.5;
      c.stroke();
      c.globalAlpha = 1;
    } else {
      c.fillStyle = b.kind === 'tower' || b.kind === 'mast' || b.kind === 'lighthouse' ? INK.red : INK.ink;
      c.fillRect(-pw / 2, -pd / 2, pw, pd);
    }
    c.restore();
  }
}

/** italic depth soundings scattered over the water, spaced on a screen grid */
export function drawSoundings(c: CanvasRenderingContext2D, v: View, W: number, H: number, step = 54) {
  c.font = `italic 500 ${Math.round(Math.max(9, Math.min(13, step / 5)))}px ${FONT.serif}`;
  c.fillStyle = 'rgba(43,58,85,0.78)';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const inv = (sx: number, sy: number) => {
    // screen → world through the view (linear)
    const x0 = v.sx(0), y0 = v.sy(0);
    return [(sx - x0) / v.ppm, (sy - y0) / v.ppm];
  };
  // positions jittered per world cell (stable while panning), and a depth equal to the one just
  // printed is skipped — a real chart samples where the depth changes, not on a grid
  const hash = (a: number, b: number) => {
    const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let gy = Math.floor(-v.sy(0) / step) - 1, y0 = 0; y0 < H + step; gy++) {
    y0 = v.sy(0) + gy * step;
    let lastTxt = '';
    for (let gx = Math.floor(-v.sx(0) / step) - 1, x0 = 0; x0 < W + step; gx++) {
      x0 = v.sx(0) + gx * step;
      const x = x0 + (hash(gx, gy) - 0.5) * step * 0.7, y = y0 + (hash(gy, gx + 9) - 0.5) * step * 0.7;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const [wx, wz] = inv(x, y);
      if (Math.abs(wx) > B - 4 || Math.abs(wz) > B - 4) continue;
      const h = rasterHeight(wx, wz);
      if (h > -0.6) continue;
      // keep clear of the coast
      if (rasterHeight(wx + 6, wz) >= 0 || rasterHeight(wx - 6, wz) >= 0 || rasterHeight(wx, wz + 6) >= 0 || rasterHeight(wx, wz - 6) >= 0) continue;
      const d = -h;
      // chart style: metres with a subscript decimetre
      const m = Math.floor(d), dm = Math.round((d - m) * 10) % 10;
      const txt = `${m}.${dm}`;
      if (txt === lastTxt || hash(gx + 3, gy - 5) < 0.3) continue;
      lastTxt = txt;
      c.fillText(dm && d < 20 ? `${m}` : `${Math.round(d)}`, x, y);
      if (dm && d < 20) {
        c.save();
        c.font = `italic 500 ${Math.round(Math.max(7, Math.min(10, step / 7)))}px ${FONT.serif}`;
        c.fillText(`${dm}`, x + 6, y + 3);
        c.restore();
      }
    }
  }
}

/** a place name: settlements in spaced condensed capitals, water names in blue italic serif */
export function placeLabel(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, kind: 'land' | 'water' | 'here' = 'land') {
  c.save();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (kind === 'water') {
    c.font = `italic 500 ${size}px ${FONT.serif}`;
    (c as any).letterSpacing = `${Math.round(size * 0.18)}px`;
    c.fillStyle = INK.sea;
    c.fillText(text, x, y);
  } else {
    c.font = `600 ${size}px ${FONT.cond}`;
    (c as any).letterSpacing = `${Math.round(size * 0.22)}px`;
    c.lineWidth = 3.2;
    c.strokeStyle = 'rgba(237,230,214,0.92)';
    c.strokeText(text.toUpperCase(), x, y);
    c.fillStyle = kind === 'here' ? INK.red : INK.ink;
    c.fillText(text.toUpperCase(), x, y);
  }
  c.restore();
}

export function drawLandmarkLabels(c: CanvasRenderingContext2D, v: View, zoom: number, here = '', avoid: { x: number; y: number }[] = []) {
  for (const l of LANDMARKS) {
    const big = l.r >= 35;
    if (!big && zoom < 0.95) continue;
    const size = Math.round(Math.min(26, (big ? 13 : 11) * Math.pow(zoom, 0.42)));
    let y = v.sy(l.z);
    const x = v.sx(l.x);
    for (const a of avoid) if (Math.abs(a.x - x) < 60 && Math.abs(a.y - y) < 24) y = a.y - 30;
    placeLabel(c, l.name, x, y, size, l.name === here ? 'here' : 'land');
  }
  for (const w of WATER_NAMES) {
    if (rasterHeight(w.x, w.z) > -0.5) continue;
    placeLabel(c, w.name, v.sx(w.x), v.sy(w.z), Math.round(Math.min(24, 13 * w.size * Math.pow(zoom, 0.4))), 'water');
  }
}

/** compass rose: 32 points, true north star, degree ring (magnetic-style inner ring omitted) */
export function compassRose(c: CanvasRenderingContext2D, x: number, y: number, r: number, alpha = 1) {
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y);
  c.strokeStyle = INK.ink2;
  c.fillStyle = INK.ink2;
  c.lineWidth = 1;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  c.stroke();
  // degree ticks
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180;
    const l = d % 30 === 0 ? 0.1 : d % 10 === 0 ? 0.07 : 0.04;
    c.beginPath();
    c.moveTo(Math.sin(a) * r * 0.86, -Math.cos(a) * r * 0.86);
    c.lineTo(Math.sin(a) * r * (0.86 + l), -Math.cos(a) * r * (0.86 + l));
    c.stroke();
  }
  // points: 8 long, 8 short
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const len = k % 4 === 0 ? 0.82 : k % 2 === 0 ? 0.55 : 0.36;
    const wdt = k % 4 === 0 ? 0.1 : 0.07;
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.sin(a) * r * len, -Math.cos(a) * r * len);
      c.lineTo(Math.sin(a + side * wdt * 2.2) * r * wdt * 2, -Math.cos(a + side * wdt * 2.2) * r * wdt * 2);
      c.closePath();
      c.fillStyle = side < 0 ? INK.ink2 : 'rgba(237,230,214,0.95)';
      c.fill();
      c.stroke();
    }
  }
  // north: red star point + N
  c.fillStyle = INK.red;
  c.beginPath();
  c.moveTo(0, -r * 0.82);
  c.lineTo(r * 0.08, -r * 0.2);
  c.lineTo(0, -r * 0.3);
  c.closePath();
  c.fill();
  c.font = `700 ${Math.round(r * 0.26)}px ${FONT.display}`;
  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  c.fillStyle = INK.ink;
  c.fillText('N', 0, -r * 1.02);
  c.restore();
}

/** alternating black / white scale bar in metres */
export function scaleBar(c: CanvasRenderingContext2D, x: number, y: number, ppm: number, maxPx = 160) {
  const len = [500, 200, 100, 50, 25, 10, 5].find((m) => m * ppm <= maxPx) ?? 5;
  const seg = 4;
  const w = len * ppm;
  c.save();
  for (let i = 0; i < seg; i++) {
    c.fillStyle = i % 2 ? INK.paper : INK.ink;
    c.fillRect(x + (w / seg) * i, y, w / seg, 5);
  }
  c.strokeStyle = INK.ink;
  c.lineWidth = 1;
  c.strokeRect(x, y, w, 5);
  c.font = `500 11px ${FONT.mono}`;
  c.fillStyle = INK.ink;
  c.textBaseline = 'top';
  c.textAlign = 'center';
  c.fillText('0', x, y + 8);
  c.fillText(`${len} m`, x + w, y + 8);
  c.textAlign = 'left';
  c.font = `600 10px ${FONT.cond}`;
  (c as any).letterSpacing = '2px';
  c.fillText('MÅLESTOKK', x, y - 14);
  c.restore();
}

// ------------------------------------------------------------------ hand-inked markers
/** deterministic wobble so a marker is drawn the same way every frame (not jittering) */
function wob(seed: number, i: number) {
  const s = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}
/** a hand-drawn circle: slightly irregular radius, overshooting its start */
export function inkCircle(c: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number, lw = 2) {
  c.lineWidth = lw;
  c.beginPath();
  const n = 28;
  for (let i = 0; i <= n + 3; i++) {
    const a = (i / n) * Math.PI * 2 - 0.4;
    const rr = r * (1 + wob(seed, i) * 0.07) + (i > n ? 1.5 : 0);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) c.lineTo(px, py);
    else c.moveTo(px, py);
  }
  c.stroke();
}
/** a hand-drawn polyline with a little wobble along its length */
export function inkLine(c: CanvasRenderingContext2D, pts: [number, number][], seed: number, lw = 2) {
  c.lineWidth = lw;
  c.beginPath();
  pts.forEach(([x, y], i) => {
    const jx = wob(seed, i * 2) * 1.2, jy = wob(seed, i * 2 + 1) * 1.2;
    if (i) c.lineTo(x + jx, y + jy);
    else c.moveTo(x + jx, y + jy);
  });
  c.stroke();
}
/** ping: an inked diamond with a dot */
export function inkDiamond(c: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number, color: string) {
  c.strokeStyle = color;
  c.fillStyle = color;
  inkLine(c, [[x, y - s], [x + s, y], [x, y + s], [x - s, y], [x, y - s - 1]], seed, 2);
  c.beginPath();
  c.arc(x, y, 1.8, 0, Math.PI * 2);
  c.fill();
}
/** waypoint: an inked pennant on a staff */
export function inkFlag(c: CanvasRenderingContext2D, x: number, y: number, color: string, seed: number) {
  c.strokeStyle = color;
  inkLine(c, [[x, y], [x, y - 22]], seed, 2.2);
  c.fillStyle = color;
  c.globalAlpha *= 0.3;
  c.beginPath();
  c.moveTo(x, y - 22);
  c.lineTo(x + 13, y - 18);
  c.lineTo(x, y - 13);
  c.fill();
  c.globalAlpha /= 0.3;
  inkLine(c, [[x, y - 22], [x + 13, y - 18], [x, y - 13]], seed + 3, 1.8);
  c.beginPath();
  c.moveTo(x - 4, y);
  c.lineTo(x + 4, y);
  c.stroke();
}
/** squad / player: an inked arrowhead pointing along `yaw` (0 = up / north) */
export function inkArrow(c: CanvasRenderingContext2D, x: number, y: number, yaw: number, s: number, fill: string, stroke = INK.ink) {
  c.save();
  c.translate(x, y);
  c.rotate(-yaw);
  c.fillStyle = fill;
  c.strokeStyle = stroke;
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(0, -s);
  c.lineTo(s * 0.72, s * 0.75);
  c.lineTo(0, s * 0.35);
  c.lineTo(-s * 0.72, s * 0.75);
  c.closePath();
  c.fill();
  c.stroke();
  c.restore();
}
/** objective: a letter inside a double inked ring, with the capture progress as a heavy arc */
export function inkObjective(c: CanvasRenderingContext2D, x: number, y: number, r: number, letter: string, color: string, capColor: string | null, progress: number, seed: number, blink = false) {
  c.save();
  c.fillStyle = 'rgba(237,230,214,0.82)';
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = blink ? INK.gold : color;
  inkCircle(c, x, y, r, seed, 2.2);
  inkCircle(c, x, y, r - 4, seed + 7, 1);
  if (capColor && progress > 0) {
    c.strokeStyle = capColor;
    c.lineWidth = 4;
    c.beginPath();
    c.arc(x, y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    c.stroke();
  }
  c.font = `800 ${Math.round(r * 1.05)}px ${FONT.display}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(letter, x, y + 1);
  c.restore();
}

// ------------------------------------------------------------------ thumbnails
/**
 * A small finished chart of the whole area (operation brief card, room cards): raster, roads,
 * buildings, names, flags. `flags` in world units.
 */
export function chartThumb(t: Terrain, w: number, h: number, flags: { x: number; z: number; letter: string }[] = [], opts: { rose?: boolean; names?: boolean; cover?: boolean } = {}) {
  const r = chartRaster(t);
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d')!;
  c.scale(dpr, dpr);
  c.fillStyle = INK.paper;
  c.fillRect(0, 0, w, h);
  // fit the play area, north up
  const ppm = (opts.cover ? Math.max(w, h) : Math.min(w, h)) / (2 * PLAY_HALF) * (opts.cover ? 0.98 : 1.04);
  const v: View = { ppm, sx: (x) => w / 2 + x * ppm, sy: (z) => h / 2 + z * ppm };
  c.drawImage(r.canvas, v.sx(-B), v.sy(-B), 2 * B * ppm, 2 * B * ppm);
  drawRoads(c, v, 0.5);
  drawBuildings(c, v);
  if (opts.names !== false) {
    for (const l of LANDMARKS) if (l.r >= 40) placeLabel(c, l.name, v.sx(l.x), v.sy(l.z) - 10, Math.max(8, Math.round(w / 34)), 'land');
  }
  flags.forEach((f, i) => inkObjective(c, v.sx(f.x), v.sy(f.z), Math.max(8, w / 30), f.letter, INK.red, null, 0, i * 11 + 3));
  if (opts.rose) compassRose(c, w - Math.min(w, h) * 0.13, Math.min(w, h) * 0.15, Math.min(w, h) * 0.09, 0.9);
  // neat line (chart border)
  c.strokeStyle = INK.ink;
  c.lineWidth = 1.5;
  c.strokeRect(3, 3, w - 6, h - 6);
  c.lineWidth = 0.6;
  c.strokeRect(6, 6, w - 12, h - 12);
  return cv;
}
