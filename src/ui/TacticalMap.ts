import { Terrain } from '../world/Terrain';
import { PLAY_HALF, TUNNEL, TUNNEL_EXIT, tunnelShafts, LADDERS, landmarkAt } from '../world/MapLayout';
import type { Input } from '../core/Input';
import { chartRaster, B, INK, FONT, View, drawRoads, drawBuildings, drawSoundings, drawLandmarkLabels, compassRose, scaleBar, inkObjective, inkDiamond, inkFlag, inkArrow, inkLine, inkCircle } from './Chart';

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

const COLS = 'ABCDEFGH';
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
    return chartRaster(this.terrain).canvas;
  }
  private get view(): View {
    return { sx: (x) => this.sx(x), sy: (z) => this.sy(z), ppm: this.ppm };
  }

  // ------------------------------------------------------------------ drawing (Sjøkart)
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
    c.fillStyle = INK.paper;
    c.fillRect(0, 0, W, H);
    if (this.raster) {
      c.imageSmoothingEnabled = true;
      c.drawImage(this.raster, this.sx(-B), this.sy(-B), 2 * B * ppm, 2 * B * ppm);
    }
    // outside the combat area: hatched, the boundary as a red dashed line
    const x0 = this.sx(-PLAY_HALF), y0 = this.sy(-PLAY_HALF), x1 = this.sx(PLAY_HALF), y1 = this.sy(PLAY_HALF);
    c.save();
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(x1, y0, x0 - x1, y1 - y0);
    c.clip('evenodd');
    c.fillStyle = 'rgba(20,33,61,0.16)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(20,33,61,0.18)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = -H; k < W; k += 9) {
      c.moveTo(k, 0);
      c.lineTo(k + H, H);
    }
    c.stroke();
    c.restore();
    c.strokeStyle = INK.red;
    c.lineWidth = 2;
    c.setLineDash([10, 6]);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.setLineDash([]);
    const v = this.view;
    drawSoundings(c, v, W, H, Math.max(46, 64 / Math.sqrt(this.zoom)));
    this.drawGrid(x0, y0, x1, y1);
    drawRoads(c, v, this.zoom);
    this.drawTunnel();
    drawBuildings(c, v);
    this.drawFeatures();
    drawLandmarkLabels(c, v, this.zoom, landmarkAt(s.px, s.pz), s.flags.map((f) => ({ x: this.sx(f.x), y: this.sy(f.z) })));
    this.drawFlags(s);
    this.drawIntel(s);
    this.drawPlayer(s);
    this.drawPanel(s);
    this.drawCursor(s);
  }

  /** lettered graticule; the chart's neat-line border with alternating ticks */
  private drawGrid(x0: number, y0: number, x1: number, y1: number) {
    const c = this.c;
    c.strokeStyle = 'rgba(20,33,61,0.16)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 8; i++) {
      const gx = x0 + ((x1 - x0) * i) / 8, gy = y0 + ((y1 - y0) * i) / 8;
      c.moveTo(gx, y0); c.lineTo(gx, y1);
      c.moveTo(x0, gy); c.lineTo(x1, gy);
    }
    c.stroke();
    c.font = `600 12px ${FONT.mono}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const ty = Math.max(y0 + 12, 86), lx = Math.max(x0 + 14, 16);
    for (let i = 0; i < 8; i++) {
      const gx = x0 + ((x1 - x0) * (i + 0.5)) / 8, gy = y0 + ((y1 - y0) * (i + 0.5)) / 8;
      this.halo(COLS[i], gx, Math.min(ty, y1 - 10), INK.ink2);
      this.halo(String(i + 1), Math.min(lx, x1 - 10), gy, INK.ink2);
    }
  }

  /** text with a paper halo so it reads over contours */
  private halo(text: string, x: number, y: number, color: string, w = 3) {
    const c = this.c;
    c.lineWidth = w;
    c.strokeStyle = 'rgba(237,230,214,0.9)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  /** the road tunnel runs under the ridge: its bore dashed over the road */
  private drawTunnel() {
    const c = this.c;
    const W = TUNNEL.width / 2;
    const tx0 = this.sx(TUNNEL.x - W), tx1 = this.sx(TUNNEL.x + W), tz0 = this.sy(TUNNEL.z0), tz1 = this.sy(TUNNEL.z1);
    c.fillStyle = 'rgba(237,230,214,0.75)';
    c.fillRect(tx0, tz0, tx1 - tx0, tz1 - tz0);
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.4;
    c.setLineDash([5, 4]);
    c.strokeRect(tx0, tz0, tx1 - tx0, tz1 - tz0);
    for (const sx of [-1, 1]) {
      const g0 = this.sx(TUNNEL.x + sx * (W + TUNNEL_EXIT.gx0)), g1 = this.sx(TUNNEL.x + sx * (W + TUNNEL_EXIT.gx1));
      c.strokeRect(Math.min(g0, g1), this.sy(TUNNEL_EXIT.doors[0] - 1.2), Math.abs(g1 - g0), this.sy(TUNNEL_EXIT.doors[1] + 1.2) - this.sy(TUNNEL_EXIT.doors[0] - 1.2));
    }
    c.setLineDash([]);
  }

  private drawFeatures() {
    const c = this.c, z = this.zoom;
    if (z > 1.2) {
      c.strokeStyle = INK.ink2;
      c.lineWidth = 1.2;
      c.setLineDash([2, 3]);
      c.beginPath();
      for (const l of this.ziplines) {
        c.moveTo(this.sx(l.a.x), this.sy(l.a.z));
        c.lineTo(this.sx(l.b.x), this.sy(l.b.z));
      }
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = INK.ink;
      for (const l of this.ziplines) for (const p of [l.a, l.b]) { c.beginPath(); c.arc(this.sx(p.x), this.sy(p.z), 2.2, 0, Math.PI * 2); c.fill(); }
    }
    if (z > 1.9) {
      c.strokeStyle = INK.ink;
      c.lineWidth = 1.3;
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
    // tunnel emergency exits / hatches: green boxes with an arrow (as on real escape signage)
    const ex = (x: number, y: number, label: string) => {
      c.fillStyle = '#3E8E5A';
      c.fillRect(x - 6, y - 6, 12, 12);
      c.strokeStyle = INK.ink;
      c.lineWidth = 1.2;
      c.strokeRect(x - 6, y - 6, 12, 12);
      c.fillStyle = '#fff';
      c.beginPath();
      c.moveTo(x - 3, y - 2.5); c.lineTo(x + 3.5, y); c.lineTo(x - 3, y + 2.5);
      c.fill();
      if (z > 2.2) {
        c.font = `600 10px ${FONT.cond}`;
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        this.halo(label, x + 9, y, '#2E6B44');
      }
    };
    if (z > 1.3) {
      for (const sx of [-1, 1]) for (const dz of TUNNEL_EXIT.doors) ex(this.sx(TUNNEL.x + sx * (TUNNEL.width / 2 + 0.6)), this.sy(dz), 'EXIT');
      for (const sh of tunnelShafts()) ex(this.sx((sh.x0 + sh.x1) / 2), this.sy(TUNNEL_EXIT.shaftZ), 'HATCH');
    }
  }

  private flagColor(css: string) {
    // the HUD hands friend / foe / neutral colours: map them to chart inks
    return /5aa8ff|57a9e6|friend/i.test(css) ? INK.friend : /ff4a3a|f0453c|ff6a5a|foe/i.test(css) ? INK.foe : INK.ink2;
  }

  private drawFlags(s: MapState) {
    const ppm = this.ppm;
    s.flags.forEach((f, i) => {
      const x = this.sx(f.x), y = this.sy(f.z);
      const r = Math.max(14, f.r * ppm);
      const col = this.flagColor(f.color);
      // the capture zone: a faint inked ring
      this.c.save();
      this.c.globalAlpha = 0.5;
      this.c.strokeStyle = col;
      this.c.setLineDash([4, 4]);
      this.c.lineWidth = 1.2;
      this.c.beginPath();
      this.c.arc(x, y, r, 0, Math.PI * 2);
      this.c.stroke();
      this.c.restore();
      inkObjective(this.c, x, y, 15, f.letter, col, f.capColor ? this.flagColor(f.capColor) : null, f.progress, i * 13 + 5, f.contested && Math.sin(this.t * 10) > 0);
    });
  }

  private drawIntel(s: MapState) {
    const c = this.c, ppm = this.ppm;
    // the radius inside which you hear (and see) enemy gunfire
    c.strokeStyle = 'rgba(215,38,46,0.28)';
    c.lineWidth = 1;
    c.setLineDash([3, 6]);
    c.beginPath(); c.arc(this.sx(s.px), this.sy(s.pz), FIRE_REVEAL_RADIUS * ppm, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    if (s.uav > 0) {
      const a = ((this.t % 2) / 2) * Math.PI * 2 - Math.PI / 2;
      const R = Math.hypot(this.W, this.H);
      const g = c.createRadialGradient(this.sx(0), this.sy(0), 0, this.sx(0), this.sy(0), R);
      g.addColorStop(0, 'rgba(215,38,46,0.12)');
      g.addColorStop(1, 'rgba(215,38,46,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(this.sx(0), this.sy(0));
      c.arc(this.sx(0), this.sy(0), R, a - 0.5, a);
      c.closePath();
      c.fill();
    }
    // pings: inked diamonds with the distance; the waypoint: an inked pennant and a course line
    s.pings.forEach((p, i) => {
      const x = this.sx(p.x), y = this.sy(p.z);
      inkDiamond(c, x, y, 8 + Math.sin(this.t * 6) * 1, i * 7 + 1, INK.gold);
      c.font = `500 11px ${FONT.mono}`;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      this.halo(`${Math.round(Math.hypot(p.x - s.px, p.z - s.pz))} m`, x, y + 11, INK.gold);
    });
    if (s.waypoint) {
      const x = this.sx(s.waypoint.x), y = this.sy(s.waypoint.z);
      c.strokeStyle = 'rgba(20,33,61,0.55)';
      c.lineWidth = 1.5;
      c.setLineDash([7, 5]);
      c.beginPath(); c.moveTo(this.sx(s.px), this.sy(s.pz)); c.lineTo(x, y); c.stroke();
      c.setLineDash([]);
      inkFlag(c, x, y, INK.red, 41);
      c.font = `600 11px ${FONT.cond}`;
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      (c as any).letterSpacing = '1.5px';
      this.halo(`WAYPOINT · ${Math.round(Math.hypot(s.waypoint.x - s.px, s.waypoint.z - s.pz))} m`, x + 4, y - 26, INK.red);
      (c as any).letterSpacing = '0px';
    }
    for (const h of s.helis) {
      const x = this.sx(h.x), y = this.sy(h.z);
      c.strokeStyle = h.friendly ? INK.friend : INK.foe;
      c.lineWidth = 2.4;
      c.beginPath();
      c.moveTo(x - 11, y); c.lineTo(x + 11, y);
      c.moveTo(x, y - 11); c.lineTo(x, y + 11);
      c.stroke();
      c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.stroke();
    }
    // enemies: red ink — a cross for spotted, a dot with a ring for gunfire / UAV
    s.enemies.forEach((e, i) => {
      const x = this.sx(e.x), y = this.sy(e.z);
      c.globalAlpha = Math.max(0, Math.min(1, e.alpha));
      c.strokeStyle = INK.foe;
      c.fillStyle = INK.foe;
      if (e.kind === 'spotted') {
        inkLine(c, [[x - 6, y - 6], [x + 6, y + 6]], i * 3, 2.4);
        inkLine(c, [[x + 6, y - 6], [x - 6, y + 6]], i * 3 + 1, 2.4);
      } else {
        c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill();
        inkCircle(c, x, y, 5 + (1 - e.alpha) * 14, i * 5, 1.4);
      }
    });
    c.globalAlpha = 1;
    // squad: blue inked arrowheads
    c.font = `600 11px ${FONT.cond}`;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (const a of s.allies) {
      const x = this.sx(a.x), y = this.sy(a.z);
      inkArrow(c, x, y, a.yaw, 7, INK.friend);
      if (this.zoom > 2.2) this.halo(a.name.toUpperCase(), x + 9, y, INK.sea);
    }
  }

  private drawPlayer(s: MapState) {
    const c = this.c;
    const x = this.sx(s.px), y = this.sy(s.pz);
    // view cone as a pencil wedge
    c.save();
    c.translate(x, y);
    c.rotate(-s.yaw);
    c.fillStyle = 'rgba(215,38,46,0.12)';
    c.strokeStyle = 'rgba(215,38,46,0.45)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 70, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    inkArrow(c, x, y, s.yaw, 11, s.alive ? INK.red : '#8A8A80');
  }

  /** chart furniture: title cartouche, score, legend, compass rose, scale bar */
  private drawPanel(s: MapState) {
    const c = this.c, W = this.W, H = this.H;
    // title cartouche (top left)
    const cw = 330;
    c.fillStyle = 'rgba(246,241,230,0.94)';
    c.fillRect(18, 16, cw, 62);
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.5;
    c.strokeRect(18, 16, cw, 62);
    c.lineWidth = 0.6;
    c.strokeRect(21, 19, cw - 6, 56);
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = INK.ink;
    c.font = `800 26px ${FONT.display}`;
    (c as any).letterSpacing = '3px';
    c.fillText('KVITVIKA', 32, 50);
    c.font = `600 10px ${FONT.cond}`;
    (c as any).letterSpacing = '2.5px';
    c.fillStyle = INK.ink2;
    c.fillText('SJØKART · TACTICAL CHART', 32, 66);
    c.textAlign = 'right';
    c.font = `500 12px ${FONT.mono}`;
    (c as any).letterSpacing = '0px';
    c.fillStyle = INK.red;
    c.fillText(`${gridRef(s.px, s.pz)} · ${landmarkAt(s.px, s.pz).toUpperCase()}`, 18 + cw - 14, 50);
    c.fillStyle = INK.ink2;
    c.fillText(s.uav > 0 ? `UAV ${Math.ceil(s.uav)} s` : `GUNFIRE ≤ ${FIRE_REVEAL_RADIUS} m`, 18 + cw - 14, 66);
    // score (top centre)
    const mine = s.team, foe = 1 - s.team;
    const sw = 300, sx = W / 2 - sw / 2;
    c.fillStyle = 'rgba(246,241,230,0.94)';
    c.fillRect(sx, 16, sw, 40);
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.5;
    c.strokeRect(sx, 16, sw, 40);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `800 20px ${FONT.display}`;
    c.fillStyle = INK.friend;
    c.fillText(`${s.scores[mine]}`, sx + 50, 37);
    c.fillStyle = INK.foe;
    c.fillText(`${s.scores[foe]}`, sx + sw - 50, 37);
    c.font = `600 15px ${FONT.mono}`;
    c.fillStyle = INK.ink;
    c.fillText(s.timeLeft, W / 2, 33);
    c.font = `600 8.5px ${FONT.cond}`;
    (c as any).letterSpacing = '2px';
    c.fillStyle = INK.ink2;
    c.fillText(s.mode.toUpperCase(), W / 2, 48);
    (c as any).letterSpacing = '0px';
    // compass rose (top right)
    compassRose(c, W - 74, 82, 50, 0.95);
    // legend + controls (bottom right, a paper key)
    const kx = W - 214, ky = H - 196;
    c.fillStyle = 'rgba(246,241,230,0.94)';
    c.fillRect(kx - 14, ky - 22, 210, 190);
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.5;
    c.strokeRect(kx - 14, ky - 22, 210, 190);
    c.font = `600 10px ${FONT.cond}`;
    (c as any).letterSpacing = '2.5px';
    c.fillStyle = INK.red;
    c.textAlign = 'left';
    c.fillText('TEGNFORKLARING · KEY', kx - 2, ky - 8);
    (c as any).letterSpacing = '0px';
    const row = (i: number, draw: (x: number, y: number) => void, label: string) => {
      const y = ky + 12 + i * 19;
      draw(kx + 6, y);
      c.fillStyle = INK.ink;
      c.font = `500 12px ${FONT.sans}`;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(label, kx + 24, y + 1);
    };
    row(0, (x, y) => inkArrow(c, x, y, 0, 7, INK.red), 'You');
    row(1, (x, y) => inkArrow(c, x, y, 0, 7, INK.friend), 'Squad');
    row(2, (x, y) => { c.fillStyle = INK.foe; c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill(); }, 'Enemy gunfire / UAV');
    row(3, (x, y) => { c.strokeStyle = INK.foe; inkLine(c, [[x - 5, y - 5], [x + 5, y + 5]], 1, 2.2); inkLine(c, [[x + 5, y - 5], [x - 5, y + 5]], 2, 2.2); }, 'Spotted enemy');
    row(4, (x, y) => inkDiamond(c, x, y, 6, 3, INK.gold), 'Ping');
    row(5, (x, y) => { c.fillStyle = '#3E8E5A'; c.fillRect(x - 5, y - 5, 10, 10); }, 'Tunnel exit / hatch');
    row(6, (x, y) => { c.strokeStyle = '#E2563C'; c.lineWidth = 3; c.beginPath(); c.moveTo(x - 7, y); c.lineTo(x + 7, y); c.stroke(); }, 'Road');
    row(7, (x, y) => { c.fillStyle = INK.sea; c.font = `italic 500 12px ${FONT.serif}`; c.textAlign = 'center'; c.fillText('12', x, y + 1); }, 'Depth (m)');
    // scale bar
    scaleBar(c, W - 214, H - 236, this.ppm, 160);
    // controls strip (bottom left)
    const items: [string, string][] = [['WHEEL', 'ZOOM'], ['DRAG', 'PAN'], ['LMB / X', 'PING'], ['RMB', 'WAYPOINT'], ['R', 'RE-CENTRE'], ['M', 'CLOSE']];
    c.font = `500 11px ${FONT.mono}`;
    let lx = 30;
    const ly = H - 26;
    c.fillStyle = 'rgba(246,241,230,0.94)';
    c.fillRect(16, ly - 16, 560, 32);
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.2;
    c.strokeRect(16, ly - 16, 560, 32);
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (const [k, v] of items) {
      const kw = c.measureText(k).width + 12;
      c.strokeStyle = INK.ink;
      c.lineWidth = 1;
      c.strokeRect(lx, ly - 9, kw, 18);
      c.fillStyle = INK.ink;
      c.fillText(k, lx + 6, ly + 1);
      c.fillStyle = INK.ink2;
      c.fillText(v, lx + kw + 6, ly + 1);
      lx += kw + c.measureText(v).width + 20;
    }
  }

  private drawCursor(s: MapState) {
    const c = this.c, x = this.mx, y = this.my;
    // a navigator's divider point: crosshair + ring
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.4;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.moveTo(x - 16, y); c.lineTo(x - 5, y);
    c.moveTo(x + 5, y); c.lineTo(x + 16, y);
    c.moveTo(x, y - 16); c.lineTo(x, y - 5);
    c.moveTo(x, y + 5); c.lineTo(x, y + 16);
    c.stroke();
    const wx = this.wx(x), wz = this.wz(y);
    if (Math.abs(wx) <= PLAY_HALF && Math.abs(wz) <= PLAY_HALF) {
      c.font = `500 11px ${FONT.mono}`;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      const brg = Math.round(((Math.atan2(wx - s.px, -(wz - s.pz)) * 180) / Math.PI + 360) % 360);
      this.halo(`${gridRef(wx, wz)} · ${landmarkAt(wx, wz).toUpperCase()} · ${Math.round(Math.hypot(wx - s.px, wz - s.pz))} m · ${String(brg).padStart(3, '0')}°`, x + 18, y + 16, INK.ink);
    }
  }
}
