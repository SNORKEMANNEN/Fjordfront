import { Terrain } from '../world/Terrain';
import { PLAY_HALF } from '../world/MapLayout';
import { chartRaster, B, INK, FONT, View, drawRoads, drawBuildings, inkObjective, inkLine, inkCircle, inkArrow } from './Chart';

export interface RadarBlip { x: number; z: number; kind: 'ally' | 'enemy' | 'spotted' | 'ping' | 'flag' | 'heli' | 'heliFoe'; alpha: number; label?: string; color?: string }

/**
 * Rotating minimap, drawn as a cut-out of the paper chart: the same raster as the tactical map,
 * a bearing ring around the edge (it turns with you, north marked in red), allies as blue ink
 * arrows, enemies in red ink when they fire unsuppressed or are spotted, flags as inked rings.
 */
export class Radar {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: HTMLCanvasElement;
  private range = 85; // metres from centre to edge

  constructor(parent: HTMLElement, terrain: Terrain) {
    this.el = document.createElement('canvas');
    this.el.className = 'radar';
    this.el.width = this.el.height = 372;
    parent.appendChild(this.el);
    this.ctx = this.el.getContext('2d')!;
    // the chart raster (roads and buildings baked onto a copy once)
    const r = chartRaster(terrain).canvas;
    const c = document.createElement('canvas');
    c.width = c.height = r.width;
    const x = c.getContext('2d')!;
    x.drawImage(r, 0, 0);
    const ppm = r.width / (2 * B);
    const v: View = { ppm, sx: (wx) => (wx + B) * ppm, sy: (wz) => (wz + B) * ppm };
    drawRoads(x, v, 0.6);
    drawBuildings(x, v);
    x.strokeStyle = INK.red;
    x.lineWidth = 2;
    x.setLineDash([8, 6]);
    x.strokeRect(v.sx(-PLAY_HALF), v.sy(-PLAY_HALF), 2 * PLAY_HALF * ppm, 2 * PLAY_HALF * ppm);
    this.map = c;
  }

  draw(px: number, pz: number, yaw: number, blips: RadarBlip[]) {
    const c = this.ctx, W = this.el.width, R = W / 2, Ri = R - 16;
    const scale = Ri / this.range; // px per metre
    const mapScale = (2 * B) / this.map.width; // metres per map px
    c.clearRect(0, 0, W, W);
    // paper disc
    c.save();
    c.beginPath();
    c.arc(R, R, Ri, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = INK.paper;
    c.fillRect(0, 0, W, W);
    c.translate(R, R);
    c.rotate(yaw);
    const mpx = ((px + B) / (2 * B)) * this.map.width, mpz = ((pz + B) / (2 * B)) * this.map.width;
    c.drawImage(this.map, -mpx * mapScale * scale, -mpz * mapScale * scale, this.map.width * mapScale * scale, this.map.height * mapScale * scale);
    // range rings
    c.strokeStyle = 'rgba(20,33,61,0.16)';
    c.lineWidth = 1;
    for (const k of [0.33, 0.66]) {
      c.beginPath();
      c.arc(0, 0, Ri * k, 0, Math.PI * 2);
      c.stroke();
    }
    let seed = 0;
    for (const b of blips) {
      const dx = (b.x - px) * scale, dz = (b.z - pz) * scale;
      const dist = Math.hypot(dx, dz);
      let x = dx, z = dz;
      if (dist > Ri - 12) {
        x = (dx / dist) * (Ri - 12);
        z = (dz / dist) * (Ri - 12);
      }
      c.globalAlpha = b.alpha;
      seed++;
      if (b.kind === 'flag') {
        c.save();
        c.translate(x, z);
        c.rotate(-yaw);
        const col = /5aa8ff/i.test(b.color ?? '') ? INK.friend : /ff4a3a/i.test(b.color ?? '') ? INK.foe : INK.ink2;
        inkObjective(c, 0, 0, 14, b.label ?? '', col, null, 0, seed * 7);
        c.restore();
        continue;
      }
      if (b.kind === 'heli' || b.kind === 'heliFoe') {
        c.save();
        c.translate(x, z);
        c.rotate(-yaw);
        c.strokeStyle = b.kind === 'heli' ? INK.friend : INK.foe;
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(-12, 0); c.lineTo(12, 0); c.moveTo(0, -12); c.lineTo(0, 12);
        c.stroke();
        c.beginPath(); c.arc(0, 0, 5, 0, Math.PI * 2); c.stroke();
        c.restore();
        continue;
      }
      if (b.kind === 'ally') {
        c.fillStyle = INK.friend;
        c.strokeStyle = INK.ink;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, z, 7, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      } else if (b.kind === 'spotted') {
        c.save();
        c.translate(x, z);
        c.rotate(-yaw);
        c.strokeStyle = INK.foe;
        inkLine(c, [[-7, -7], [7, 7]], seed, 3.2);
        inkLine(c, [[7, -7], [-7, 7]], seed + 1, 3.2);
        c.restore();
      } else {
        c.fillStyle = INK.foe;
        c.beginPath();
        c.arc(x, z, 7.5, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = INK.foe;
        inkCircle(c, x, z, 8 + (1 - b.alpha) * 16, seed, 1.6);
      }
    }
    c.globalAlpha = 1;
    c.restore();
    // view wedge + you (fixed, pointing up)
    c.fillStyle = 'rgba(215,38,46,0.12)';
    c.beginPath();
    c.moveTo(R, R);
    c.arc(R, R, Ri, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    c.fill();
    inkArrow(c, R, R, 0, 13, INK.red);
    // bearing ring (turns with the map; N in red)
    c.save();
    c.translate(R, R);
    c.fillStyle = 'rgba(20,33,61,0.86)';
    c.beginPath();
    c.arc(0, 0, R - 1, 0, Math.PI * 2);
    c.arc(0, 0, Ri, 0, Math.PI * 2, true);
    c.fill('evenodd');
    c.rotate(yaw);
    c.strokeStyle = 'rgba(237,230,214,0.7)';
    c.lineWidth = 1.2;
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180;
      const l = d % 90 === 0 ? 0 : d % 30 === 0 ? 5 : 3;
      if (!l) continue;
      c.beginPath();
      c.moveTo(Math.sin(a) * Ri, -Math.cos(a) * Ri);
      c.lineTo(Math.sin(a) * (Ri + l), -Math.cos(a) * (Ri + l));
      c.stroke();
    }
    c.font = `800 15px ${FONT.display}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const [lab, d] of [['N', 0], ['Ø', 90], ['S', 180], ['V', 270]] as [string, number][]) {
      const a = (d * Math.PI) / 180;
      c.save();
      c.translate(Math.sin(a) * (R - 9), -Math.cos(a) * (R - 9));
      c.rotate(-yaw);
      c.fillStyle = d === 0 ? '#FF5A52' : INK.paper;
      c.fillText(lab, 0, 1);
      c.restore();
    }
    c.restore();
  }
}

/** Floating 3D-anchored labels: teammate nameplates and spotted-enemy diamonds. */
export class Markers {
  private pool: HTMLDivElement[] = [];
  constructor(private parent: HTMLElement) {}
  update(items: { x: number; y: number; text: string; cls: string; alpha: number }[]) {
    while (this.pool.length < items.length) {
      const d = document.createElement('div');
      this.parent.appendChild(d);
      this.pool.push(d);
    }
    this.pool.forEach((d, i) => {
      const it = items[i];
      const m = d as any;
      if (!it) {
        if (m._on !== false) {
          m._on = false;
          d.style.display = 'none';
        }
        return;
      }
      if (m._on !== true) {
        m._on = true;
        d.style.display = 'block';
      }
      const cls = `marker ${it.cls}`;
      if (m._c !== cls) {
        m._c = cls;
        d.className = cls;
      }
      if (d.dataset.t !== it.text) {
        d.dataset.t = it.text;
        d.innerHTML = it.cls === 'spotted' ? '<i></i>' : `<span>${it.text}</span><i></i>`;
      }
      const tf = `translate(${it.x.toFixed(0)}px, ${it.y.toFixed(0)}px) translate(-50%, -100%)`;
      if (m._tf !== tf) {
        m._tf = tf;
        d.style.transform = tf;
      }
      const op = it.alpha.toFixed(2);
      if (m._op !== op) {
        m._op = op;
        d.style.opacity = op;
      }
    });
  }
}
