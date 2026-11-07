import { Terrain } from '../world/Terrain';
import { ROADS, BUILDINGS, PLAY_HALF } from '../world/MapLayout';

export interface RadarBlip { x: number; z: number; kind: 'ally' | 'enemy' | 'spotted' | 'ping' | 'flag' | 'heli' | 'heliFoe'; alpha: number; label?: string; color?: string }

/** Rotating radar minimap (CoD-style): allies always, enemies when they fire unsuppressed or are spotted. */
export class Radar {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: HTMLCanvasElement;
  private half = 200;
  private range = 85; // metres from centre to edge

  constructor(parent: HTMLElement, terrain: Terrain) {
    this.el = document.createElement('canvas');
    this.el.className = 'radar';
    this.el.width = this.el.height = 360;
    parent.appendChild(this.el);
    this.ctx = this.el.getContext('2d')!;
    this.map = this.buildMap(terrain);
  }

  private buildMap(terrain: Terrain) {
    const S = 512, H = this.half;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d')!;
    const img = x.createImageData(S, S);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const wx = -H + (i / S) * 2 * H, wz = -H + (j / S) * 2 * H;
        const h = terrain.heightAt(wx, wz);
        const k = (j * S + i) * 4;
        if (h < 0) {
          const d = Math.min(1, -h / 12);
          img.data[k] = 22 - d * 10; img.data[k + 1] = 40 - d * 14; img.data[k + 2] = 52 - d * 12;
        } else {
          const hx = terrain.heightAt(wx + 1.5, wz) - h, hz = terrain.heightAt(wx, wz + 1.5) - h;
          const shade = Math.max(0.55, Math.min(1.25, 1 - hx * 0.35 - hz * 0.25));
          const [f, g] = terrain.splatAt(wx, wz);
          let r = 72, gg = 84, b = 64;
          r = r * (1 - f * 0.4); gg = gg * (1 - f * 0.25); b = b * (1 - f * 0.4);
          r += g * 30; gg += g * 22; b += g * 22;
          const elev = Math.min(1, h / 40);
          img.data[k] = r * shade + elev * 25; img.data[k + 1] = gg * shade + elev * 22; img.data[k + 2] = b * shade + elev * 20;
        }
        img.data[k + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    const toPx = (v: number) => ((v + H) / (2 * H)) * S;
    x.lineCap = 'round';
    for (const r of ROADS) {
      x.strokeStyle = r.kind === 'asphalt' ? 'rgba(200,200,190,0.75)' : 'rgba(170,160,140,0.55)';
      x.lineWidth = Math.max(1.5, (r.width / (2 * H)) * S);
      x.beginPath();
      r.pts.forEach(([px, pz], n) => (n ? x.lineTo(toPx(px), toPx(pz)) : x.moveTo(toPx(px), toPx(pz))));
      x.stroke();
    }
    for (const b of BUILDINGS) {
      const w = b.w ?? ({ church: 19, warehouse: 40, containers: 30, crane: 12, tanks: 26, hjell: 10, bunker: 9, gunpit: 10, barracks: 16, mast: 4 } as Record<string, number>)[b.kind] ?? 8;
      const d = b.d ?? ({ church: 9, warehouse: 22, containers: 20, crane: 9, tanks: 10, hjell: 3, bunker: 7, gunpit: 10, barracks: 8, mast: 4 } as Record<string, number>)[b.kind] ?? 7;
      x.save();
      x.translate(toPx(b.x), toPx(b.z));
      x.rotate(-b.rot);
      x.fillStyle = b.kind === 'containers' ? 'rgba(120,110,95,0.85)' : 'rgba(30,32,34,0.9)';
      x.strokeStyle = 'rgba(220,220,210,0.35)';
      x.lineWidth = 1;
      const pw = (w / (2 * H)) * S, pd = (d / (2 * H)) * S;
      x.fillRect(-pw / 2, -pd / 2, pw, pd);
      x.strokeRect(-pw / 2, -pd / 2, pw, pd);
      x.restore();
    }
    // play-area boundary
    x.strokeStyle = 'rgba(255,80,60,0.5)';
    x.setLineDash([6, 6]);
    x.strokeRect(toPx(-PLAY_HALF), toPx(-PLAY_HALF), toPx(PLAY_HALF) - toPx(-PLAY_HALF), toPx(PLAY_HALF) - toPx(-PLAY_HALF));
    return c;
  }

  draw(px: number, pz: number, yaw: number, blips: RadarBlip[]) {
    const c = this.ctx, W = this.el.width, R = W / 2;
    const scale = R / this.range; // px per metre
    const mapScale = (2 * this.half) / this.map.width; // metres per map px
    c.clearRect(0, 0, W, W);
    c.save();
    c.beginPath();
    c.arc(R, R, R - 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#0c1214';
    c.fillRect(0, 0, W, W);
    c.translate(R, R);
    c.rotate(yaw);
    c.globalAlpha = 0.92;
    const mpx = ((px + this.half) / (2 * this.half)) * this.map.width, mpz = ((pz + this.half) / (2 * this.half)) * this.map.width;
    c.drawImage(this.map, -mpx * mapScale * scale, -mpz * mapScale * scale, this.map.width * mapScale * scale, this.map.height * mapScale * scale);
    c.globalAlpha = 1;
    // range rings
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    for (const r of [0.33, 0.66]) {
      c.beginPath();
      c.arc(0, 0, R * r, 0, Math.PI * 2);
      c.stroke();
    }
    for (const b of blips) {
      const dx = (b.x - px) * scale, dz = (b.z - pz) * scale;
      const dist = Math.hypot(dx, dz);
      let x = dx, z = dz;
      if (dist > R - 10) {
        x = (dx / dist) * (R - 10);
        z = (dz / dist) * (R - 10);
      }
      c.globalAlpha = b.alpha;
      if (b.kind === 'flag') {
        c.save();
        c.translate(x, z);
        c.rotate(-yaw);
        c.strokeStyle = b.color ?? '#ddd';
        c.lineWidth = 3;
        c.fillStyle = 'rgba(10,14,18,0.6)';
        c.beginPath();
        c.arc(0, 0, 13, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        c.fillStyle = b.color ?? '#ddd';
        c.font = 'bold 16px Barlow Condensed, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(b.label ?? '', 0, 1);
        c.restore();
        continue;
      }
      if (b.kind === 'heli' || b.kind === 'heliFoe') {
        c.save();
        c.translate(x, z);
        c.rotate(-yaw);
        c.fillStyle = b.kind === 'heli' ? '#5aa8ff' : '#ff4a3a';
        c.fillRect(-11, -2, 22, 4);
        c.fillRect(-2, -11, 4, 22);
        c.beginPath();
        c.arc(0, 0, 5, 0, Math.PI * 2);
        c.fill();
        c.restore();
        continue;
      }
      if (b.kind === 'ally') {
        c.fillStyle = '#5aa8ff';
        c.beginPath();
        c.arc(x, z, 7, 0, Math.PI * 2);
        c.fill();
      } else if (b.kind === 'spotted') {
        c.fillStyle = '#ff4a3a';
        c.save();
        c.translate(x, z);
        c.rotate(Math.PI / 4 - yaw);
        c.fillRect(-7, -7, 14, 14);
        c.restore();
      } else {
        c.fillStyle = '#ff4a3a';
        c.beginPath();
        c.arc(x, z, 8, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = 'rgba(255,74,58,0.5)';
        c.beginPath();
        c.arc(x, z, 8 + (1 - b.alpha) * 16, 0, Math.PI * 2);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
    c.restore();
    // player arrow and view cone (fixed, pointing up)
    c.fillStyle = 'rgba(232,197,71,0.12)';
    c.beginPath();
    c.moveTo(R, R);
    c.arc(R, R, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    c.fill();
    c.fillStyle = '#e8c547';
    c.beginPath();
    c.moveTo(R, R - 13);
    c.lineTo(R + 9, R + 9);
    c.lineTo(R, R + 4);
    c.lineTo(R - 9, R + 9);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(232,197,71,0.5)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(R, R, R - 2, 0, Math.PI * 2);
    c.stroke();
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
