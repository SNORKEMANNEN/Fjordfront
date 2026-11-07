import { Terrain } from '../world/Terrain';
import { ROADS, BUILDINGS, LANDMARKS, PLAY_HALF, TUNNEL, TUNNEL_EXIT, tunnelShafts, tunnelCapHeight, LADDERS, landmarkAt, BuildingDef } from '../world/MapLayout';
import type { Input } from '../core/Input';

/**
 * Full-screen tactical map [M], in the spirit of the big battle-royale maps: the whole play area
 * with hill shading and contours, every point of interest by name, a lettered grid, the flags,
 * your squad, pings and a waypoint. Scroll to zoom at the cursor, drag to pan, click to ping,
 * right-click for a waypoint. The player keeps moving while it is open but cannot shoot or aim.
 *
 * Intel rules: allies always; spotted / pinged enemies anywhere (that is team intel); enemies
 * firing unsuppressed only inside FIRE_REVEAL_RADIUS of you (you hear them, you don't see the
 * whole map light up); an active UAV sweeps every enemy on the map.
 */
export const FIRE_REVEAL_RADIUS = 100;

export interface MapEnemy { x: number; z: number; kind: 'spotted' | 'fire' | 'uav'; alpha: number }
export interface MapState {
  px: number;
  pz: number;
  yaw: number;
  alive: boolean;
  allies: { x: number; z: number; yaw: number; name: string }[];
  enemies: MapEnemy[];
  flags: { x: number; z: number; r: number; letter: string; color: string; capColor: string | null; progress: number; contested: boolean }[];
  helis: { x: number; z: number; friendly: boolean }[];
  pings: { x: number; z: number; t: number }[];
  waypoint: { x: number; z: number } | null;
  uav: number;
  scores: [number, number];
  teamNames: [string, string];
  team: number;
  timeLeft: string;
  mode: string;
}

const B = PLAY_HALF + 14; // raster covers [-B, B]
const COLS = 'ABCDEFGH';
const FOOT: Partial<Record<string, [number, number]>> = {
  church: [18, 8], shop: [12, 7], warehouse: [40, 22], office: [10, 7], bunker: [10, 8], gunpit: [10, 10],
  barracks: [14, 6], mast: [4, 4], barn: [14, 9], naust: [5, 7], crane: [12, 12], tanks: [20, 10],
  hjell: [10, 2], containers: [32, 22], rorbu: [6, 5], lighthouse: [7, 7], tower: [3.6, 3.6], radome: [9, 9],
};
function footprint(b: BuildingDef): [number, number] {
  return [b.w ?? FOOT[b.kind]?.[0] ?? 8, b.d ?? FOOT[b.kind]?.[1] ?? 7];
}
function gridRef(x: number, z: number) {
  const c = Math.floor(((x + PLAY_HALF) / (2 * PLAY_HALF)) * 8), r = Math.floor(((z + PLAY_HALF) / (2 * PLAY_HALF)) * 8);
  if (c < 0 || c > 7 || r < 0 || r > 7) return '--';
  return `${COLS[c]}${r + 1}`;
}

export class TacticalMap {
  el: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private c: CanvasRenderingContext2D;
  private raster: HTMLCanvasElement | null = null;
  open = false;
  /** view centre (world) and zoom (1 = the whole play area fits the screen height) */
  cx = 0;
  cz = 0;
  zoom = 1;
  /** virtual cursor in CSS px */
  mx = 0;
  my = 0;
  private drag: { x: number; y: number; moved: number } | null = null;
  private dpr = 1;
  private t = 0;
  private drawT = 0;
  private last: MapState | null = null;
  onPing: (x: number, z: number) => void = () => {};
  onWaypoint: (p: { x: number; z: number } | null) => void = () => {};
  ziplines: { a: { x: number; z: number }; b: { x: number; z: number } }[] = [];

  constructor(parent: HTMLElement, private terrain: Terrain) {
    this.el = document.createElement('div');
    this.el.className = 'tmap hidden';
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    parent.appendChild(this.el);
    this.c = this.cv.getContext('2d')!;
  }

  // ------------------------------------------------------------------ view
  private get W() { return this.cv.width / this.dpr; }
  private get H() { return this.cv.height / this.dpr; }
  private get ppm() { return ((this.H * 0.92) / (2 * PLAY_HALF)) * this.zoom; }
  sx(x: number) { return this.W / 2 + (x - this.cx) * this.ppm; }
  sy(z: number) { return this.H / 2 + (z - this.cz) * this.ppm; }
  wx(sx: number) { return this.cx + (sx - this.W / 2) / this.ppm; }
  wz(sy: number) { return this.cz + (sy - this.H / 2) / this.ppm; }
  private clampView() {
    this.zoom = Math.min(7, Math.max(0.85, this.zoom));
    const lim = PLAY_HALF + 10;
    this.cx = Math.min(lim, Math.max(-lim, this.cx));
    this.cz = Math.min(lim, Math.max(-lim, this.cz));
  }
  zoomAt(sx: number, sy: number, f: number) {
    const ax = this.wx(sx), az = this.wz(sy);
    this.zoom *= f;
    this.clampView();
    // keep the point under the cursor fixed
    this.cx += ax - this.wx(sx);
    this.cz += az - this.wz(sy);
    this.clampView();
  }

  setOpen(v: boolean, px = 0, pz = 0) {
    if (v === this.open) return;
    this.open = v;
    this.el.classList.toggle('hidden', !v);
    if (v) {
      this.resize();
      if (!this.raster) this.raster = this.buildRaster();
      this.zoom = 1.5;
      this.cx = px;
      this.cz = pz;
      this.clampView();
      this.mx = this.W / 2;
      this.my = this.H / 2;
      this.drag = null;
      this.drawT = 0;
    }
  }

  private resize() {
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.round(window.innerWidth * this.dpr), h = Math.round(window.innerHeight * this.dpr);
    if (this.cv.width !== w || this.cv.height !== h) {
      this.cv.width = w;
      this.cv.height = h;
    }
  }

  // ------------------------------------------------------------------ input (pointer stays locked: a virtual cursor)
  handleInput(inp: Input) {
    if (!this.open) return;
    const W = this.W, H = this.H;
    const dx = inp.mouseDX, dy = inp.mouseDY;
    const held = inp.rawDown('fire');
    if (inp.rawPressed('fire')) this.drag = { x: this.mx, y: this.my, moved: 0 };
    if (this.drag && held) {
      // drag pans the map (the cursor stays under the grabbed point)
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.drag.moved > 5) {
        this.cx -= dx / this.ppm;
        this.cz -= dy / this.ppm;
        this.clampView();
      } else {
        this.mx += dx;
        this.my += dy;
      }
    } else {
      this.mx = Math.min(W - 4, Math.max(4, this.mx + dx));
      this.my = Math.min(H - 4, Math.max(4, this.my + dy));
    }
    if (inp.rawReleased('fire') && this.drag) {
      if (this.drag.moved <= 5) this.click(this.mx, this.my);
      this.drag = null;
    }
    if (inp.rawPressed('ads')) this.rightClick(this.mx, this.my);
    if (inp.rawPressed('ping')) this.click(this.mx, this.my);
    if (inp.wheel) this.zoomAt(this.mx, this.my, Math.pow(1.25, -inp.wheel));
    if (inp.rawPressed('reload') && this.last) {
      this.cx = this.last.px;
      this.cz = this.last.pz;
      this.clampView();
    }
  }
  click(sx: number, sy: number) {
    const x = this.wx(sx), z = this.wz(sy);
    if (Math.abs(x) > PLAY_HALF + 5 || Math.abs(z) > PLAY_HALF + 5) return;
    this.onPing(x, z);
  }
  rightClick(sx: number, sy: number) {
    const w = this.last?.waypoint;
    if (w && Math.hypot(this.sx(w.x) - sx, this.sy(w.z) - sy) < 16) return this.onWaypoint(null);
    const x = this.wx(sx), z = this.wz(sy);
    if (Math.abs(x) > PLAY_HALF + 5 || Math.abs(z) > PLAY_HALF + 5) return;
    this.onWaypoint({ x, z });
  }

  // ------------------------------------------------------------------ raster (terrain shading, contours, water)
  private buildRaster() {
    const S = 1024, t = this.terrain;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const x = cv.getContext('2d')!;
    const img = x.createImageData(S, S);
    const hs = new Float32Array(S * S);
    const capW = TUNNEL.width / 2 + TUNNEL_EXIT.carve + 1;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = -B + ((i + 0.5) / S) * 2 * B, z = -B + ((j + 0.5) / S) * 2 * B;
      // over the tunnel the map shows the ridge, not the carved floor under it
      const capped = Math.abs(x - TUNNEL.x) < capW && z > TUNNEL.z0 - 1 && z < TUNNEL.z1 + 1;
      hs[j * S + i] = capped ? tunnelCapHeight(x, z) : t.heightAt(x, z);
    }
    const m = (2 * B) / S;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const k = j * S + i, o = k * 4;
        const h = hs[k];
        const wx = -B + ((i + 0.5) / S) * 2 * B, wz = -B + ((j + 0.5) / S) * 2 * B;
        let r: number, g: number, b: number;
        if (h < 0) {
          const d = Math.min(1, -h / 14);
          r = 26 - d * 12; g = 50 - d * 18; b = 66 - d * 16;
          // shallow rim
          if (h > -0.8) { r += 14; g += 18; b += 16; }
        } else {
          const hx = hs[j * S + Math.min(S - 1, i + 1)] - hs[j * S + Math.max(0, i - 1)];
          const hz = hs[Math.min(S - 1, j + 1) * S + i] - hs[Math.max(0, j - 1) * S + i];
          // light from the north-west
          const shade = Math.max(0.5, Math.min(1.35, 1 - (hx * 0.9 + hz * 0.7) / (2 * m) * 0.42));
          const [f, gr, dirt] = t.splatAt(wx, wz);
          r = 86; g = 98; b = 72;
          r = r * (1 - f * 0.42); g = g * (1 - f * 0.22); b = b * (1 - f * 0.4);
          r += gr * 34 + dirt * 22; g += gr * 26 + dirt * 14; b += gr * 26 + dirt * 6;
          const elev = Math.min(1, h / 45);
          r = r * shade + elev * 34; g = g * shade + elev * 30; b = b * shade + elev * 30;
          // contours every 5 m (index every 25 m)
          const c0 = Math.floor(h / 5), cR = Math.floor(hs[j * S + Math.min(S - 1, i + 1)] / 5), cD = Math.floor(hs[Math.min(S - 1, j + 1) * S + i] / 5);
          if (c0 !== cR || c0 !== cD) {
            const idx = Math.max(c0, cR, cD) % 5 === 0;
            const k2 = idx ? 0.72 : 0.86;
            r *= k2; g *= k2; b *= k2;
          }
          // coastline
          if (h < 0.35) { r = r * 0.6 + 60; g = g * 0.6 + 64; b = b * 0.6 + 56; }
        }
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    return cv;
  }

  // ------------------------------------------------------------------ drawing
  draw(s: MapState, dt: number) {
    this.last = s;
    if (!this.open) return;
    this.t += dt;
    this.drawT -= dt;
    if (this.drawT > 0) return;
    this.drawT = 1 / 40;
    this.resize();
    const c = this.c, W = this.W, H = this.H, ppm = this.ppm;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#0b1114';
    c.fillRect(0, 0, W, H);
    // terrain raster
    if (this.raster) {
      c.imageSmoothingEnabled = true;
      c.drawImage(this.raster, this.sx(-B), this.sy(-B), 2 * B * ppm, 2 * B * ppm);
    }
    // out of bounds
    const x0 = this.sx(-PLAY_HALF), y0 = this.sy(-PLAY_HALF), x1 = this.sx(PLAY_HALF), y1 = this.sy(PLAY_HALF);
    c.fillStyle = 'rgba(8,10,12,0.55)';
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(x1, y0, x0 - x1, y1 - y0);
    c.fill('evenodd');
    c.strokeStyle = 'rgba(255,90,70,0.75)';
    c.lineWidth = 2;
    c.setLineDash([10, 7]);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.setLineDash([]);
    this.drawGrid(x0, y0, x1, y1);
    this.drawRoads();
    this.drawBuildings();
    this.drawFeatures();
    this.drawLabels(s);
    this.drawFlags(s);
    this.drawIntel(s);
    this.drawPlayer(s);
    this.drawPanel(s);
    this.drawCursor(s);
  }

  private drawGrid(x0: number, y0: number, x1: number, y1: number) {
    const c = this.c;
    c.strokeStyle = 'rgba(255,255,255,0.11)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 8; i++) {
      const gx = x0 + ((x1 - x0) * i) / 8, gy = y0 + ((y1 - y0) * i) / 8;
      c.moveTo(gx, y0); c.lineTo(gx, y1);
      c.moveTo(x0, gy); c.lineTo(x1, gy);
    }
    c.stroke();
    c.font = '600 13px Barlow Condensed, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const ty = Math.max(y0 + 12, 74), lx = Math.max(x0 + 12, 14);
    for (let i = 0; i < 8; i++) {
      const gx = x0 + ((x1 - x0) * (i + 0.5)) / 8, gy = y0 + ((y1 - y0) * (i + 0.5)) / 8;
      this.halo(COLS[i], gx, Math.min(ty, y1 - 10), 'rgba(255,255,255,0.55)');
      this.halo(String(i + 1), Math.min(lx, x1 - 10), gy, 'rgba(255,255,255,0.55)');
    }
  }

  private halo(text: string, x: number, y: number, color: string, w = 3) {
    const c = this.c;
    c.lineWidth = w;
    c.strokeStyle = 'rgba(0,0,0,0.65)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  private drawRoads() {
    const c = this.c, ppm = this.ppm;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const r of ROADS) {
        const w = Math.max(r.kind === 'dirt' ? 1.2 : 2, r.width * ppm);
        if (pass === 0) {
          c.strokeStyle = 'rgba(20,22,22,0.55)';
          c.lineWidth = w + 2;
        } else {
          c.strokeStyle = r.kind === 'asphalt' ? 'rgba(214,212,200,0.92)' : r.kind === 'gravel' ? 'rgba(196,178,140,0.85)' : 'rgba(170,140,100,0.8)';
          c.lineWidth = w;
          if (r.kind === 'dirt') c.setLineDash([Math.max(3, 4 * this.zoom), Math.max(2, 2.5 * this.zoom)]);
        }
        c.beginPath();
        r.pts.forEach(([x, z], i) => (i ? c.lineTo(this.sx(x), this.sy(z)) : c.moveTo(this.sx(x), this.sy(z))));
        c.stroke();
        c.setLineDash([]);
      }
    }
    // the tunnel runs under the ridge: draw its bore as a dashed outline over the road
    const W = TUNNEL.width / 2;
    const tx0 = this.sx(TUNNEL.x - W), tx1 = this.sx(TUNNEL.x + W), tz0 = this.sy(TUNNEL.z0), tz1 = this.sy(TUNNEL.z1);
    c.fillStyle = 'rgba(30,32,34,0.75)';
    c.fillRect(tx0, tz0, tx1 - tx0, tz1 - tz0);
    c.strokeStyle = 'rgba(230,230,220,0.85)';
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.strokeRect(tx0, tz0, tx1 - tx0, tz1 - tz0);
    // service galleries
    for (const sx of [-1, 1]) {
      const g0 = this.sx(TUNNEL.x + sx * (W + TUNNEL_EXIT.gx0)), g1 = this.sx(TUNNEL.x + sx * (W + TUNNEL_EXIT.gx1));
      c.strokeRect(Math.min(g0, g1), this.sy(TUNNEL_EXIT.doors[0] - 1.2), Math.abs(g1 - g0), this.sy(TUNNEL_EXIT.doors[1] + 1.2) - this.sy(TUNNEL_EXIT.doors[0] - 1.2));
    }
    c.setLineDash([]);
  }

  private drawBuildings() {
    const c = this.c, ppm = this.ppm;
    for (const b of BUILDINGS) {
      const [w, d] = footprint(b);
      c.save();
      c.translate(this.sx(b.x), this.sy(b.z));
      c.rotate(-b.rot);
      const pw = Math.max(3, w * ppm), pd = Math.max(3, d * ppm);
      c.fillStyle = b.kind === 'containers' ? 'rgba(126,112,92,0.95)' : b.kind === 'tower' || b.kind === 'mast' ? 'rgba(70,74,78,0.95)' : 'rgba(34,37,40,0.95)';
      c.fillRect(-pw / 2, -pd / 2, pw, pd);
      c.strokeStyle = 'rgba(232,230,220,0.55)';
      c.lineWidth = 1;
      c.strokeRect(-pw / 2, -pd / 2, pw, pd);
      c.restore();
    }
  }

  private drawFeatures() {
    const c = this.c, z = this.zoom;
    // ziplines
    if (z > 1.2) {
      c.strokeStyle = 'rgba(210,220,230,0.75)';
      c.lineWidth = 1.2;
      c.setLineDash([2, 3]);
      c.beginPath();
      for (const l of this.ziplines) {
        c.moveTo(this.sx(l.a.x), this.sy(l.a.z));
        c.lineTo(this.sx(l.b.x), this.sy(l.b.z));
      }
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = 'rgba(210,220,230,0.9)';
      for (const l of this.ziplines) for (const p of [l.a, l.b]) { c.beginPath(); c.arc(this.sx(p.x), this.sy(p.z), 2.2, 0, Math.PI * 2); c.fill(); }
    }
    // ladders
    if (z > 1.9) {
      c.strokeStyle = 'rgba(240,190,40,0.95)';
      c.lineWidth = 1.4;
      for (const l of LADDERS) {
        const x = this.sx(l.x), y = this.sy(l.z);
        c.beginPath();
        c.moveTo(x - 3, y - 4); c.lineTo(x - 3, y + 4);
        c.moveTo(x + 3, y - 4); c.lineTo(x + 3, y + 4);
        c.moveTo(x - 3, y - 1.5); c.lineTo(x + 3, y - 1.5);
        c.moveTo(x - 3, y + 1.5); c.lineTo(x + 3, y + 1.5);
        c.stroke();
      }
    }
    // tunnel emergency exits: doors in the bore, hatches on the crest
    const ex = (x: number, y: number, label: string) => {
      c.fillStyle = '#1f9a52';
      c.fillRect(x - 6, y - 6, 12, 12);
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = 1.2;
      c.strokeRect(x - 6, y - 6, 12, 12);
      c.fillStyle = '#fff';
      c.beginPath();
      c.moveTo(x - 3, y - 2.5); c.lineTo(x + 3.5, y); c.lineTo(x - 3, y + 2.5);
      c.fill();
      if (z > 2.2) {
        c.font = '600 11px Barlow Condensed, sans-serif';
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        this.halo(label, x + 9, y, '#7dffb0');
      }
    };
    if (z > 1.3) {
      for (const sx of [-1, 1]) for (const dz of TUNNEL_EXIT.doors) ex(this.sx(TUNNEL.x + sx * (TUNNEL.width / 2 + 0.6)), this.sy(dz), 'EXIT');
      for (const sh of tunnelShafts()) ex(this.sx((sh.x0 + sh.x1) / 2), this.sy(TUNNEL_EXIT.shaftZ), 'HATCH');
    }
  }

  private drawLabels(s: MapState) {
    const c = this.c, z = this.zoom;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const l of LANDMARKS) {
      const big = l.r >= 35;
      if (!big && z < 0.95) continue;
      const size = Math.round(Math.min(30, (big ? 15 : 12.5) * Math.pow(z, 0.42)));
      c.font = `700 ${size}px Barlow Condensed, sans-serif`;
      (c as any).letterSpacing = `${Math.round(size * 0.14)}px`;
      const here = landmarkAt(s.px, s.pz) === l.name;
      const lx = this.sx(l.x);
      let ly = this.sy(l.z);
      // keep the name clear of a flag sitting on the same spot
      for (const f of s.flags) if (Math.abs(this.sx(f.x) - lx) < 60 && Math.abs(this.sy(f.z) - ly) < 22) ly = this.sy(f.z) - 28;
      this.halo(l.name.toUpperCase(), lx, ly, here ? '#ffe27a' : 'rgba(255,255,255,0.94)', 4);
    }
    (c as any).letterSpacing = '0px';
  }

  private drawFlags(s: MapState) {
    const c = this.c, ppm = this.ppm;
    for (const f of s.flags) {
      const x = this.sx(f.x), y = this.sy(f.z);
      const r = Math.max(13, f.r * ppm);
      c.fillStyle = 'rgba(10,14,18,0.35)';
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = f.color;
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
      if (f.capColor && f.progress > 0) {
        c.strokeStyle = f.capColor;
        c.lineWidth = 4;
        c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + f.progress * Math.PI * 2); c.stroke();
      }
      const bs = 13;
      c.fillStyle = 'rgba(10,14,18,0.85)';
      c.fillRect(x - bs, y - bs, bs * 2, bs * 2);
      c.strokeStyle = f.contested ? (Math.sin(this.t * 10) > 0 ? '#ffffff' : f.color) : f.color;
      c.lineWidth = 2;
      c.strokeRect(x - bs, y - bs, bs * 2, bs * 2);
      c.font = '700 18px Barlow Condensed, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = f.color;
      c.fillText(f.letter, x, y + 1);
    }
  }

  private drawIntel(s: MapState) {
    const c = this.c, ppm = this.ppm;
    // the radius inside which you hear (and see) enemy gunfire
    c.strokeStyle = 'rgba(255,120,90,0.22)';
    c.lineWidth = 1;
    c.setLineDash([4, 6]);
    c.beginPath(); c.arc(this.sx(s.px), this.sy(s.pz), FIRE_REVEAL_RADIUS * ppm, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    // UAV sweep
    if (s.uav > 0) {
      const a = (this.t % 2) / 2 * Math.PI * 2 - Math.PI / 2;
      const R = Math.hypot(this.W, this.H);
      const g = c.createRadialGradient(this.sx(0), this.sy(0), 0, this.sx(0), this.sy(0), R);
      g.addColorStop(0, 'rgba(255,80,60,0.10)');
      g.addColorStop(1, 'rgba(255,80,60,0.0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(this.sx(0), this.sy(0));
      c.arc(this.sx(0), this.sy(0), R, a - 0.5, a);
      c.closePath();
      c.fill();
    }
    // pings and waypoint
    for (const p of s.pings) {
      const x = this.sx(p.x), y = this.sy(p.z);
      const k = 1 + 0.25 * Math.sin(this.t * 6);
      c.save();
      c.translate(x, y);
      c.rotate(Math.PI / 4);
      c.strokeStyle = '#ffd25a';
      c.fillStyle = 'rgba(255,210,90,0.25)';
      c.lineWidth = 2;
      c.fillRect(-6 * k, -6 * k, 12 * k, 12 * k);
      c.strokeRect(-6 * k, -6 * k, 12 * k, 12 * k);
      c.restore();
      c.font = '600 12px Barlow Condensed, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      this.halo(`${Math.round(Math.hypot(p.x - s.px, p.z - s.pz))} m`, x, y + 11, '#ffd25a');
    }
    if (s.waypoint) {
      const x = this.sx(s.waypoint.x), y = this.sy(s.waypoint.z);
      c.fillStyle = '#ffd25a';
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x - 8, y - 14);
      c.arc(x, y - 17, 8, Math.PI * 0.83, Math.PI * 0.17);
      c.closePath();
      c.stroke();
      c.fill();
      c.fillStyle = '#1a1a10';
      c.beginPath(); c.arc(x, y - 17, 3, 0, Math.PI * 2); c.fill();
      c.font = '700 12px Barlow Condensed, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      this.halo(`WAYPOINT ${Math.round(Math.hypot(s.waypoint.x - s.px, s.waypoint.z - s.pz))} m`, x, y - 28, '#ffd25a');
      // a line from you to it
      c.strokeStyle = 'rgba(255,210,90,0.35)';
      c.lineWidth = 1.5;
      c.setLineDash([6, 6]);
      c.beginPath(); c.moveTo(this.sx(s.px), this.sy(s.pz)); c.lineTo(x, y); c.stroke();
      c.setLineDash([]);
    }
    // helicopters
    for (const h of s.helis) {
      const x = this.sx(h.x), y = this.sy(h.z);
      c.fillStyle = h.friendly ? '#5aa8ff' : '#ff4a3a';
      c.fillRect(x - 11, y - 2, 22, 4);
      c.fillRect(x - 2, y - 11, 4, 22);
      c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
    }
    // enemies
    for (const e of s.enemies) {
      const x = this.sx(e.x), y = this.sy(e.z);
      c.globalAlpha = Math.max(0, Math.min(1, e.alpha));
      if (e.kind === 'spotted') {
        c.save();
        c.translate(x, y);
        c.rotate(Math.PI / 4);
        c.fillStyle = '#ff4a3a';
        c.strokeStyle = 'rgba(0,0,0,0.6)';
        c.lineWidth = 1.5;
        c.fillRect(-5.5, -5.5, 11, 11);
        c.strokeRect(-5.5, -5.5, 11, 11);
        c.restore();
      } else {
        c.fillStyle = '#ff4a3a';
        c.beginPath(); c.arc(x, y, 5.5, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(255,74,58,0.55)';
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(x, y, 5.5 + (1 - e.alpha) * 14, 0, Math.PI * 2); c.stroke();
      }
    }
    c.globalAlpha = 1;
    // squad
    c.font = '600 12px Barlow Condensed, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (const a of s.allies) {
      const x = this.sx(a.x), y = this.sy(a.z);
      c.save();
      c.translate(x, y);
      c.rotate(-a.yaw);
      c.fillStyle = '#5aa8ff';
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, -7); c.lineTo(5, 5); c.lineTo(0, 2.5); c.lineTo(-5, 5);
      c.closePath();
      c.stroke();
      c.fill();
      c.restore();
      if (this.zoom > 2.2) this.halo(a.name.toUpperCase(), x + 8, y, '#9ccbff');
    }
  }

  private drawPlayer(s: MapState) {
    const c = this.c;
    const x = this.sx(s.px), y = this.sy(s.pz);
    c.save();
    c.translate(x, y);
    c.rotate(-s.yaw);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 70);
    g.addColorStop(0, 'rgba(255,226,122,0.35)');
    g.addColorStop(1, 'rgba(255,226,122,0)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 70, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    c.closePath();
    c.fill();
    c.fillStyle = s.alive ? '#ffe27a' : '#8a8a80';
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -11); c.lineTo(8, 8); c.lineTo(0, 4); c.lineTo(-8, 8);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();
  }

  private drawPanel(s: MapState) {
    const c = this.c, W = this.W, H = this.H;
    // top bar
    const grd = c.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, 'rgba(6,9,11,0.92)');
    grd.addColorStop(1, 'rgba(6,9,11,0)');
    c.fillStyle = grd;
    c.fillRect(0, 0, W, 64);
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = '700 22px Barlow Condensed, sans-serif';
    (c as any).letterSpacing = '4px';
    c.fillStyle = '#ffffff';
    c.fillText('TACTICAL MAP', 28, 26);
    c.font = '600 15px Barlow Condensed, sans-serif';
    (c as any).letterSpacing = '2px';
    c.fillStyle = '#ffe27a';
    c.fillText(`${landmarkAt(s.px, s.pz).toUpperCase()}  ·  ${gridRef(s.px, s.pz)}`, 30, 48);
    // score / mode / time
    c.textAlign = 'center';
    c.font = '700 20px Barlow Condensed, sans-serif';
    const mine = s.team, foe = 1 - s.team;
    c.fillStyle = '#5aa8ff';
    c.fillText(`${s.teamNames[mine].toUpperCase()}  ${s.scores[mine]}`, W / 2 - 110, 26);
    c.fillStyle = '#ffffff';
    c.fillText(s.timeLeft, W / 2, 26);
    c.fillStyle = '#ff6a5a';
    c.fillText(`${s.scores[foe]}  ${s.teamNames[foe].toUpperCase()}`, W / 2 + 110, 26);
    c.font = '600 13px Barlow Condensed, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillText(s.mode.toUpperCase(), W / 2, 48);
    // intel status (right; drops to a second line on narrow screens)
    c.textAlign = 'right';
    c.font = '700 15px Barlow Condensed, sans-serif';
    const sy = W > 1250 ? 26 : 78;
    if (s.uav > 0) {
      c.fillStyle = Math.sin(this.t * 6) > -0.3 ? '#ff6a5a' : '#ffb0a0';
      this.halo(`UAV ONLINE  ${Math.ceil(s.uav)}s  ·  ALL ENEMIES TRACKED`, W - 28, sy, c.fillStyle as string);
    } else {
      this.halo(`ENEMY GUNFIRE SHOWN WITHIN ${FIRE_REVEAL_RADIUS} m`, W - 28, sy, 'rgba(255,255,255,0.7)');
    }
    (c as any).letterSpacing = '0px';
    // legend (bottom)
    const items: [string, string][] = [['WHEEL', 'ZOOM'], ['DRAG', 'PAN'], ['LMB / X', 'PING'], ['RMB', 'WAYPOINT'], ['R', 'RE-CENTRE'], ['M', 'CLOSE']];
    c.font = '600 13px Barlow Condensed, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    let lx = 28;
    const ly = H - 24;
    c.fillStyle = 'rgba(6,9,11,0.7)';
    c.fillRect(16, ly - 16, 600, 32);
    for (const [k, v] of items) {
      const kw = c.measureText(k).width + 12;
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = 1;
      c.strokeRect(lx, ly - 10, kw, 20);
      c.fillStyle = '#ffffff';
      c.fillText(k, lx + 6, ly + 1);
      c.fillStyle = 'rgba(255,255,255,0.65)';
      c.fillText(v, lx + kw + 6, ly + 1);
      lx += kw + c.measureText(v).width + 22;
    }
    // key (bottom right): what the symbols mean
    const kx = W - 196, ky = H - 132;
    c.fillStyle = 'rgba(6,9,11,0.7)';
    c.fillRect(kx - 12, ky - 14, 192, 124);
    const row = (i: number, draw: (x: number, y: number) => void, label: string) => {
      const y = ky + i * 19;
      draw(kx + 6, y);
      c.fillStyle = 'rgba(255,255,255,0.8)';
      c.font = '600 12px Barlow Condensed, sans-serif';
      c.textAlign = 'left';
      c.fillText(label, kx + 22, y + 1);
    };
    row(0, (x, y) => { c.fillStyle = '#ffe27a'; c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 5, y + 5); c.lineTo(x - 5, y + 5); c.fill(); }, 'YOU');
    row(1, (x, y) => { c.fillStyle = '#5aa8ff'; c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 5, y + 5); c.lineTo(x - 5, y + 5); c.fill(); }, 'SQUAD');
    row(2, (x, y) => { c.fillStyle = '#ff4a3a'; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); }, 'ENEMY GUNFIRE / UAV');
    row(3, (x, y) => { c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillStyle = '#ff4a3a'; c.fillRect(-4, -4, 8, 8); c.restore(); }, 'SPOTTED ENEMY');
    row(4, (x, y) => { c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.strokeStyle = '#ffd25a'; c.lineWidth = 2; c.strokeRect(-4, -4, 8, 8); c.restore(); }, 'PING');
    row(5, (x, y) => { c.fillStyle = '#1f9a52'; c.fillRect(x - 5, y - 5, 10, 10); }, 'TUNNEL EXIT / HATCH');
    // scale bar
    const ppm = this.ppm;
    const len = [200, 100, 50, 25, 10, 5].find((m) => m * ppm <= 150) ?? 5;
    const bx = W - 196, by = ky - 34;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(bx, by); c.lineTo(bx + len * ppm, by);
    c.moveTo(bx, by - 4); c.lineTo(bx, by + 4);
    c.moveTo(bx + len * ppm, by - 4); c.lineTo(bx + len * ppm, by + 4);
    c.stroke();
    c.textAlign = 'left';
    this.halo(`${len} m`, bx + len * ppm + 8, by, '#ffffff');
  }

  private drawCursor(s: MapState) {
    const c = this.c, x = this.mx, y = this.my;
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.moveTo(x - 15, y); c.lineTo(x - 5, y);
    c.moveTo(x + 5, y); c.lineTo(x + 15, y);
    c.moveTo(x, y - 15); c.lineTo(x, y - 5);
    c.moveTo(x, y + 5); c.lineTo(x, y + 15);
    c.stroke();
    const wx = this.wx(x), wz = this.wz(y);
    if (Math.abs(wx) <= PLAY_HALF && Math.abs(wz) <= PLAY_HALF) {
      c.font = '600 12px Barlow Condensed, sans-serif';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      const name = landmarkAt(wx, wz);
      this.halo(`${gridRef(wx, wz)} · ${name.toUpperCase()} · ${Math.round(Math.hypot(wx - s.px, wz - s.pz))} m`, x + 18, y + 16, 'rgba(255,255,255,0.9)');
    }
  }
}
