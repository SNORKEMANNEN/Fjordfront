import * as THREE from 'three';
import type { Buildings } from './Buildings';
import type { GeoBuilder } from './GeoBuilder';
import { RNG } from '../core/math';

/**
 * Brosund's street life (Update 35): every shop has its own trade, name board, neon and interior —
 * cafés, a barber, bakeries, a pharmacy, kiosks, bookshops, florists, boutiques, restaurants, a pub,
 * a sports shop, a jeweller, an optician — plus Norwegian road signs on the streets. All names are
 * made up. Signs are drawn into three shared canvas atlases (boards, neon, road signs) so the
 * whole town costs three materials, not one per sign.
 */
export type ShopType = 'cafe' | 'barber' | 'bakery' | 'pharmacy' | 'kiosk' | 'books' | 'florist' | 'clothes' | 'restaurant' | 'pub' | 'sports' | 'jeweller' | 'optician' | 'pizza' | 'fish' | 'gallery';
const SHOPS: { type: ShopType; names: string[]; neon?: string; bg: string; fg: string }[] = [
  { type: 'cafe', names: ['Kafé Jugend', 'Kaffebrenneriet Sundet', 'Kafé Tårnet', 'Kaffehuset'], neon: 'KAFFE', bg: '#20402f', fg: '#e8d9a8' },
  { type: 'barber', names: ['Frisørsalongen', 'Barber Bølgen', 'Saks & Kam'], neon: 'BARBER', bg: '#141414', fg: '#f2f2ee' },
  { type: 'bakery', names: ['Brosund Bakeri', 'Konditoriet', 'Bakeriet på Hjørnet'], neon: 'BAKERI', bg: '#6b2a20', fg: '#f6e4c4' },
  { type: 'pharmacy', names: ['Apoteket Måken', 'Svaneapoteket'], neon: '+', bg: '#0f5a3a', fg: '#ffffff' },
  { type: 'kiosk', names: ['Kiosken', 'Narvik Kiosk', 'Hjørnekiosken'], neon: 'ÅPENT', bg: '#b0201c', fg: '#ffffff' },
  { type: 'books', names: ['Bokhandel Aksla', 'Antikvariatet'], bg: '#1d2b4a', fg: '#e6d8b0' },
  { type: 'florist', names: ['Blomsterbua', 'Lyng & Lilje'], bg: '#3d5a2a', fg: '#f4eedc' },
  { type: 'clothes', names: ['Moteloftet', 'Strikk & Stil', 'Kystmote'], neon: 'SALG', bg: '#e8e0d0', fg: '#222222' },
  { type: 'restaurant', names: ['Restaurant Fjordstua', 'Spiseriet', 'Jugendkjelleren'], bg: '#3a1f2a', fg: '#e9cf8a' },
  { type: 'pub', names: ['Puben Ankeret', 'Sjøbua Bar', 'Fyrlykta Pub'], neon: 'PUB', bg: '#1a1a12', fg: '#e8c060' },
  { type: 'sports', names: ['Fjellsport', 'Tind & Turi'], neon: 'SPORT', bg: '#0e3c70', fg: '#ffffff' },
  { type: 'jeweller', names: ['Gullsmed Berg', 'Sølvsmia'], bg: '#101418', fg: '#d8b860' },
  { type: 'optician', names: ['Optiker Klarsyn'], bg: '#f2f2f2', fg: '#123b6b' },
  { type: 'pizza', names: ['Pizzeria Brygga', 'Pizza Sundet'], neon: 'PIZZA', bg: '#1a3f1f', fg: '#ffe9a0' },
  { type: 'fish', names: ['Fiskebrygga', 'Sjømathallen'], neon: 'FISK', bg: '#18456a', fg: '#ffffff' },
  { type: 'gallery', names: ['Galleri Lyset', 'Kunsthandel Nord'], bg: '#ffffff', fg: '#111111' },
];

/** a canvas atlas of equal slots; add() draws into the next slot and returns its UV rectangle */
class Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  private n = 0;
  constructor(public W: number, public H: number, public sw: number, public sh: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
  }
  add(draw: (c: CanvasRenderingContext2D, w: number, h: number) => void) {
    const cols = Math.floor(this.W / this.sw), rows = Math.floor(this.H / this.sh);
    const i = this.n++ % (cols * rows);
    const x = (i % cols) * this.sw, y = Math.floor(i / cols) * this.sh;
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(x, y, this.sw, this.sh);
    c.clip();
    c.translate(x, y);
    c.clearRect(0, 0, this.sw, this.sh);
    draw(c, this.sw, this.sh);
    c.restore();
    this.tex.needsUpdate = true;
    // UV rect (v flipped: canvas y down)
    return { u0: x / this.W, u1: (x + this.sw) / this.W, v0: 1 - (y + this.sh) / this.H, v1: 1 - y / this.H };
  }
}

let atlases: { board: Atlas; neon: Atlas; road: Atlas } | null = null;
const roadCache = new Map<string, ReturnType<Atlas['add']>>();
const FONT = 'Georgia, "DejaVu Serif", serif';
const SANS = '"Arial Narrow", "DejaVu Sans Condensed", Arial, sans-serif';

/** the three sign materials, registered on the builder (created once per page) */
let signMats: Record<string, THREE.Material> | null = null;
export function townSignMaterials(): Record<string, THREE.Material> {
  if (signMats) return signMats;
  if (!atlases) atlases = { board: new Atlas(2048, 4096, 512, 128), neon: new Atlas(2048, 4096, 512, 128), road: new Atlas(1024, 1024, 256, 256) };
  return (signMats = {
    signBoard: new THREE.MeshStandardMaterial({ map: atlases.board.tex, roughness: 0.55, emissive: 0xffffff, emissiveMap: atlases.board.tex, emissiveIntensity: 0.08 }),
    signNeon: new THREE.MeshBasicMaterial({ map: atlases.neon.tex, transparent: true, depthWrite: false, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6), blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    signRoad: new THREE.MeshStandardMaterial({ map: atlases.road.tex, roughness: 0.4, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: atlases.road.tex, emissiveIntensity: 0.06 }),
    signBack: new THREE.MeshStandardMaterial({ color: 0x8a8e90, roughness: 0.5, metalness: 0.6 }),
  });
}

/** a plane in the current builder frame using an atlas rectangle */
function plane(b: GeoBuilder, mat: string, uv: { u0: number; u1: number; v0: number; v1: number }, w: number, h: number, m: THREE.Matrix4) {
  const g = new THREE.PlaneGeometry(w, h);
  const a = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) < 0.5 ? uv.u0 : uv.u1, a.getY(i) < 0.5 ? uv.v0 : uv.v1);
  b.addGeo(mat, g, m);
}

export interface Shop { type: ShopType; name: string; neon?: string; bg: string; fg: string; awning: string | null }
/** a shop for a building (stable per seed) */
export function shopFor(seed: number): Shop {
  const rng = new RNG(seed * 7 + 13);
  const s = SHOPS[rng.int(0, SHOPS.length - 1)];
  const awn = ['#2d5a3d', '#7a1f1f', '#1f3b6b', '#d9b24a', null, null][rng.int(0, 5)];
  return { type: s.type, name: s.names[rng.int(0, s.names.length - 1)], neon: s.neon, bg: s.bg, fg: s.fg, awning: awn };
}

const boardCache = new Map<string, ReturnType<Atlas['add']>>();
const neonCache = new Map<string, ReturnType<Atlas['add']>>();
function boardUV(s: Shop) {
  const hit = boardCache.get(s.name);
  if (hit) return hit;
  const uv = boardDraw(s);
  boardCache.set(s.name, uv);
  return uv;
}
function boardDraw(s: Shop) {
  return atlases!.board.add((c, w, h) => {
    c.fillStyle = s.bg;
    c.fillRect(0, 0, w, h);
    // Jugend frame: double line with rounded corner ornaments
    c.strokeStyle = s.fg;
    c.lineWidth = 4;
    c.strokeRect(8, 8, w - 16, h - 16);
    c.lineWidth = 1.5;
    c.strokeRect(16, 16, w - 32, h - 32);
    for (const [x, y] of [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16]]) {
      c.beginPath();
      c.arc(x, y, 7, 0, Math.PI * 2);
      c.fillStyle = s.fg;
      c.fill();
    }
    c.fillStyle = s.fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let size = 60;
    c.font = `bold ${size}px ${FONT}`;
    while (c.measureText(s.name).width > w - 60 && size > 26) {
      size -= 2;
      c.font = `bold ${size}px ${FONT}`;
    }
    c.fillText(s.name, w / 2, h / 2 + 2);
  });
}
function neonUV(text: string, color: string) {
  const k = text + color;
  const hit = neonCache.get(k);
  if (hit) return hit;
  const uv = neonDraw(text, color);
  neonCache.set(k, uv);
  return uv;
}
/** a soft elliptical wash of the neon's colour, laid on the wall behind the tubes */
function haloUV(color: string) {
  const k = '#halo' + color;
  const hit = neonCache.get(k);
  if (hit) return hit;
  const uv = atlases!.neon.add((c, w, h) => {
    c.save();
    c.translate(w / 2, h / 2);
    c.scale(w / h, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, h / 2);
    g.addColorStop(0, color + '20');
    g.addColorStop(0.3, color + '14');
    g.addColorStop(0.6, color + '08');
    g.addColorStop(1, color + '00');
    c.fillStyle = g;
    c.fillRect(-h / 2, -h / 2, h, h);
    c.restore();
  });
  neonCache.set(k, uv);
  return uv;
}
function neonDraw(text: string, color: string) {
  return atlases!.neon.add((c, w, h) => {
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let size = 78;
    c.font = `bold ${size}px ${SANS}`;
    while (c.measureText(text).width > w - 50 && size > 30) {
      size -= 2;
      c.font = `bold ${size}px ${SANS}`;
    }
    // glow: several blurred passes, then the bright tube core
    c.shadowColor = color;
    for (const blur of [26, 14, 6]) {
      c.shadowBlur = blur;
      c.strokeStyle = color;
      c.lineWidth = 5;
      c.strokeText(text, w / 2, h / 2);
    }
    c.shadowBlur = 4;
    c.fillStyle = '#ffffff';
    c.globalAlpha = 0.85;
    c.fillText(text, w / 2, h / 2);
  });
}

/**
 * The shop front on a building's facade (building frame, +Z out of the front): the name board over
 * the windows, a blade sign on a bracket, neon in a window, a striped awning.
 */
export function shopFront(B: Buildings, s: Shop, w: number, z: number, P: number, G: number, doorX: number, rng: RNG) {
  const b = B.b;
  // board 4:1 (the atlas slot), above the shop windows (their heads are at P + 2.75)
  const bh = 0.66, bw = Math.min(w - 1.2, bh * 4);
  const y = P + G - 0.12 - bh / 2;
  const uv = boardUV(s);
  b.box('iron', -bw / 2 - 0.06, y - bh / 2 - 0.06, z, bw / 2 + 0.06, y + bh / 2 + 0.06, z + 0.06);
  plane(b, 'signBoard', uv, bw, bh, new THREE.Matrix4().setPosition(0, y, z + 0.065));
  // blade sign sticking out over the pavement on an iron bracket (both faces)
  const bx = doorX > 0 ? -w / 2 + 0.8 : w / 2 - 0.8;
  b.box('iron', bx - 0.03, P + 2.9, z, bx + 0.03, P + 2.96, z + 1.05);
  for (const f of [1, -1]) plane(b, 'signBoard', uv, 0.95, 0.24, new THREE.Matrix4().makeRotationY(f > 0 ? Math.PI / 2 : -Math.PI / 2).setPosition(bx + f * 0.015, P + 2.7, z + 0.62));
  b.box('iron', bx - 0.01, P + 2.55, z + 0.1, bx + 0.01, P + 2.86, z + 1.12);
  // neon in the shop window (glows at night)
  if (s.neon || s.type === 'barber') {
    const col = ['#ff3c8c', '#3cf0ff', '#ffd03c', '#ff4a3a', '#7cff6a'][rng.int(0, 4)];
    const nuv = neonUV(s.neon ?? 'BARBER', s.type === 'pharmacy' ? '#3cff7a' : col);
    // on the facade between the shop front and the first-floor windows, on a dark backing rail
    const nx = doorX > 0 ? -w / 4 : w / 4;
    const ncol = s.type === 'pharmacy' ? '#3cff7a' : col;
    const nw = Math.min(2.5, w / 2 - 0.3);
    b.box('iron', nx - nw / 2, P + G + 0.1, z, nx + nw / 2, P + G + 0.14, z + 0.08);
    plane(b, 'signNeon', haloUV(ncol), nw * 1.9, nw * 0.9, new THREE.Matrix4().setPosition(nx, P + G + 0.42, z + 0.03));
    plane(b, 'signNeon', nuv, nw, nw / 4, new THREE.Matrix4().setPosition(nx, P + G + 0.42, z + 0.1));
  }
  if (rng.chance(0.6)) {
    // a small ÅPENT over the door
    const onuv = neonUV('ÅPENT', '#ff3a3a');
    plane(b, 'signNeon', haloUV('#ff3a3a'), 1.8, 0.7, new THREE.Matrix4().setPosition(doorX, P + 2.62, z + 0.03));
    plane(b, 'signNeon', onuv, 0.9, 0.22, new THREE.Matrix4().setPosition(doorX, P + 2.62, z + 0.1));
  }
  // barber pole by the door
  if (s.type === 'barber') {
    const pole = new THREE.CylinderGeometry(0.09, 0.09, 0.8, 12);
    b.addGeo('barberPole', pole, new THREE.Matrix4().setPosition(doorX + 0.95, P + 1.9, z + 0.2));
    b.box('iron', doorX + 0.88, P + 1.48, z, doorX + 1.02, P + 1.52, z + 0.25);
    b.box('iron', doorX + 0.88, P + 2.28, z, doorX + 1.02, P + 2.32, z + 0.25);
  }
  // striped canvas awning over the windows
  if (s.awning) {
    // under the board, over the windows: sloping out and down 1.3 m
    const aw = w - 1.2;
    const m = new THREE.Matrix4().makeRotationX(0.42).setPosition(0, P + 2.58, z + 0.62);
    b.addGeo(`awning_${s.awning}`, new THREE.BoxGeometry(aw, 0.04, 1.35), m);
    b.box(`awning_${s.awning}`, -aw / 2, P + 2.12, z + 1.18, aw / 2, P + 2.32, z + 1.24);
  }
  return awningMats(s);
}
function awningMats(s: Shop): Record<string, THREE.Material> {
  if (!s.awning) return {};
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const x = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    x.fillStyle = i % 2 ? '#f2eee4' : s.awning;
    x.fillRect(i * 8, 0, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(0.8, 1);
  return { [`awning_${s.awning}`]: new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, side: THREE.DoubleSide }) };
}
export function barberPoleMat() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 64, 64);
  for (let i = -2; i < 6; i++) {
    for (const [col, off] of [['#c8102e', 0], ['#1d3f9a', 16]] as const) {
      x.fillStyle = col;
      x.beginPath();
      x.moveTo(i * 32 + off, 64);
      x.lineTo(i * 32 + off + 10, 64);
      x.lineTo(i * 32 + off + 42, 0);
      x.lineTo(i * 32 + off + 32, 0);
      x.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.3, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.25 });
}

/**
 * The shop floor, by trade (building frame; the interior box ix0..ix1 × iz0..iz1 at floor F,
 * ceiling C). The door side is +Z.
 */
export function shopInterior(B: Buildings, s: Shop, ix0: number, ix1: number, iz0: number, iz1: number, F: number, C: number, rng: RNG) {
  const b = B.b;
  const W = ix1 - ix0, D = iz1 - iz0;
  const cx = (ix0 + ix1) / 2;
  const counter = (x0: number, z0: number, x1: number, z1: number, mat = 'wood') => {
    b.box(mat, x0, F, z0, x1, F + 1.0, z1, 'wood');
    b.box('stucco', x0 - 0.03, F + 1.0, z0 - 0.03, x1 + 0.03, F + 1.05, z1 + 0.03);
  };
  const table = (x: number, z: number, r = 0.4, cloth = false) => {
    b.cyl(cloth ? 'white' : 'wood', x, F + 0.72, z, r, 0.04, 14, 'wood');
    b.cyl('iron', x, F, z, 0.04, 0.72, 6);
    for (const a of [0, Math.PI]) {
      const sx = x + Math.cos(a) * (r + 0.35), sz = z + Math.sin(a) * (r + 0.35);
      b.box('wood', sx - 0.2, F + 0.44, sz - 0.2, sx + 0.2, F + 0.48, sz + 0.2, 'wood');
      for (const [ox, oz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) b.box('iron', sx + ox - 0.015, F, sz + oz - 0.015, sx + ox + 0.015, F + 0.44, sz + oz + 0.015);
      b.box('wood', sx + Math.cos(a) * 0.19 - 0.2 * Math.abs(Math.sin(a)) - 0.02, F + 0.48, sz - 0.2 * Math.abs(Math.cos(a)), sx + Math.cos(a) * 0.19 + 0.2 * Math.abs(Math.sin(a)) + 0.02, F + 0.95, sz + 0.2 * Math.abs(Math.cos(a)));
    }
  };
  const shelves = (x0: number, z0: number, x1: number, z1: number, h: number, goods: string) => {
    b.box('wood', x0, F, z0, x1, F + h, z1, 'wood');
    const along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (let y = F + 0.4; y < F + h - 0.2; y += 0.42) {
      for (let t = 0.1; t < 0.95; t += rng.range(0.12, 0.3)) {
        const gx = along ? x0 + (x1 - x0) * t : (x0 + x1) / 2, gz = along ? (z0 + z1) / 2 : z0 + (z1 - z0) * t;
        const sz = rng.range(0.12, 0.26);
        b.box(goods, gx - sz / 2, y + 0.02, gz - sz / 2, gx + sz / 2, y + 0.02 + rng.range(0.15, 0.32), gz + sz / 2);
      }
    }
  };
  const back = iz0 + 0.3;
  switch (s.type) {
    case 'cafe':
    case 'bakery': {
      counter(ix0 + 0.3, back + 0.6, ix0 + 0.3 + Math.min(4.5, W * 0.5), back + 1.3);
      b.box('glass', ix0 + 0.5, F + 1.05, back + 0.7, ix0 + 0.3 + Math.min(4.5, W * 0.5) - 0.2, F + 1.4, back + 1.2);
      b.box('steel', ix0 + 0.6, F + 1.05, back + 0.75, ix0 + 1.2, F + 1.5, back + 1.2); // coffee machine
      shelves(ix0 + 0.3, back - 0.25, ix0 + 0.3 + Math.min(4.5, W * 0.5), back + 0.1, 2.0, s.type === 'bakery' ? 'bread' : 'ceramic');
      for (let k = 0; k < 4; k++) {
        const x = cx + (k % 2 ? 1.6 : -0.6) + rng.range(-0.3, 0.3), z = iz0 + 3.6 + Math.floor(k / 2) * 2.6;
        if (z < iz1 - 1.6) table(x, z);
      }
      // menu board over the counter
      b.box('rubberBlack', ix0 + 0.5, F + 2.2, back - 0.28, ix0 + 2.6, F + 2.9, back - 0.25);
      break;
    }
    case 'restaurant':
    case 'pizza':
    case 'fish': {
      counter(ix1 - 3.5, back + 0.4, ix1 - 0.3, back + 1.1);
      shelves(ix1 - 3.5, back - 0.25, ix1 - 0.3, back + 0.1, 2.1, 'books');
      for (let k = 0; k < 6; k++) {
        const x = ix0 + 1.3 + (k % 3) * Math.max(1.6, (W - 4) / 3), z = iz0 + 3.2 + Math.floor(k / 3) * 2.8;
        if (x < ix1 - 1 && z < iz1 - 1.5) table(x, z, 0.45, true);
      }
      if (s.type === 'pizza') b.cyl('stone', ix0 + 1.0, F, back + 0.9, 0.7, 1.6, 12, 'concrete', 0.4);
      break;
    }
    case 'pub': {
      counter(ix0 + 0.3, back + 0.8, ix1 - 1.2, back + 1.5);
      for (let x = ix0 + 0.6; x < ix1 - 1.4; x += 0.5) b.cyl('steel', x, F + 1.05, back + 1.15, 0.02, 0.35, 6); // taps
      shelves(ix0 + 0.3, back - 0.25, ix1 - 1.2, back + 0.1, 2.2, 'bottle');
      for (let x = ix0 + 0.8; x < ix1 - 1.4; x += 1.1) {
        b.cyl('iron', x, F, back + 2.0, 0.03, 0.75, 6);
        b.cyl('rug', x, F + 0.75, back + 2.0, 0.2, 0.06, 10, 'wood');
      }
      // booths along the front windows
      for (let x = ix0 + 0.6; x < ix1 - 1.6; x += 2.4) {
        b.box('rug', x, F, iz1 - 1.6, x + 0.5, F + 1.1, iz1 - 0.2, 'wood');
        b.box('wood', x + 0.6, F + 0.72, iz1 - 1.5, x + 1.5, F + 0.76, iz1 - 0.3, 'wood');
        b.box('wood', x + 1.0, F, iz1 - 1.0, x + 1.1, F + 0.72, iz1 - 0.8);
      }
      break;
    }
    case 'barber': {
      for (let k = 0; k < Math.min(3, Math.floor(W / 2.2)); k++) {
        const x = ix0 + 1.2 + k * 2.2;
        b.box('mirror', x - 0.6, F + 1.0, back - 0.27, x + 0.6, F + 2.2, back - 0.24);
        b.box('white', x - 0.45, F + 0.8, back - 0.24, x + 0.45, F + 0.9, back + 0.15); // basin shelf
        b.cyl('iron', x, F, back + 1.0, 0.25, 0.45, 12, 'metal');
        b.box('rug', x - 0.3, F + 0.45, back + 0.75, x + 0.3, F + 0.6, back + 1.3, 'fabric');
        b.box('rug', x - 0.3, F + 0.6, back + 1.25, x + 0.3, F + 1.25, back + 1.35);
      }
      b.box('rug', ix1 - 0.8, F, iz1 - 3.4, ix1 - 0.2, F + 0.45, iz1 - 0.6, 'fabric'); // waiting bench
      b.box('books', ix1 - 1.4, F, iz1 - 3.6, ix1 - 0.95, F + 0.5, iz1 - 3.0);
      break;
    }
    case 'pharmacy':
    case 'optician':
    case 'jeweller': {
      counter(cx - 1.6, back + 1.2, cx + 1.6, back + 1.8, 'white');
      shelves(ix0 + 0.3, back - 0.25, ix1 - 0.3, back + 0.1, 2.2, s.type === 'pharmacy' ? 'white' : 'glass');
      for (const x of [ix0 + 0.6, ix1 - 0.9]) shelves(x, back + 2.2, x + 0.3, iz1 - 1.8, 1.8, s.type === 'pharmacy' ? 'fishCrate' : 'steel');
      if (s.type === 'jeweller') for (let k = 0; k < 2; k++) {
        const z = iz0 + 3.5 + k * 2.4;
        b.box('wood', cx - 1.2, F, z, cx + 1.2, F + 0.9, z + 0.6, 'wood');
        b.box('glass', cx - 1.15, F + 0.9, z + 0.05, cx + 1.15, F + 1.2, z + 0.55);
      }
      break;
    }
    case 'kiosk': {
      counter(cx - 1.0, iz1 - 2.4, cx + 1.5, iz1 - 1.8);
      b.box('steel', cx + 0.6, F + 1.05, iz1 - 2.3, cx + 1.1, F + 1.3, iz1 - 1.9); // till
      for (let x = ix0 + 0.4; x < ix1 - 1.4; x += 1.4) {
        b.box('steel', x, F, back - 0.25, x + 1.3, F + 2.0, back + 0.55, 'metal'); // fridges
        b.box('jglassLit', x + 0.05, F + 0.1, back + 0.55, x + 1.25, F + 1.9, back + 0.58);
      }
      shelves(ix0 + 0.4, back + 2.4, ix0 + 0.7, iz1 - 3, 1.6, 'fishCrateRed');
      shelves(ix1 - 0.7, back + 2.4, ix1 - 0.4, iz1 - 3, 1.6, 'books');
      break;
    }
    case 'books':
    case 'gallery': {
      for (const x of [ix0 + 0.3, ix1 - 0.6]) shelves(x, back, x + 0.3, iz1 - 1.2, 2.4, s.type === 'books' ? 'books' : 'art1');
      shelves(ix0 + 0.9, back - 0.25, ix1 - 0.9, back + 0.1, 2.4, s.type === 'books' ? 'books' : 'art2');
      b.box('wood', cx - 1.0, F, iz0 + 3.2, cx + 1.0, F + 0.8, iz0 + 4.2, 'wood');
      for (let k = 0; k < 5; k++) b.box('books', cx - 0.9 + k * 0.38, F + 0.8, iz0 + 3.4, cx - 0.62 + k * 0.38, F + 0.8 + rng.range(0.1, 0.3), iz0 + 3.9);
      counter(ix1 - 2.6, iz1 - 2.0, ix1 - 0.8, iz1 - 1.4);
      break;
    }
    case 'florist': {
      counter(ix1 - 2.8, back + 0.4, ix1 - 0.4, back + 1.0);
      for (let k = 0; k < 12; k++) {
        const x = ix0 + 0.8 + (k % 4) * Math.max(0.9, (W - 3.5) / 4), z = iz0 + 2.6 + Math.floor(k / 4) * 1.4;
        if (x > ix1 - 1 || z > iz1 - 1) continue;
        b.cyl('steel', x, F, z, 0.18, 0.4, 10, 'metal');
        for (let f = 0; f < 4; f++) {
          const g = new THREE.SphereGeometry(0.1, 6, 4);
          b.addGeo(['flowerA', 'flowerB', 'flowerC'][(k + f) % 3], g, new THREE.Matrix4().setPosition(x + rng.range(-0.1, 0.1), F + rng.range(0.55, 0.8), z + rng.range(-0.1, 0.1)));
        }
        b.cyl('plant', x, F + 0.4, z, 0.12, 0.25, 6);
      }
      break;
    }
    case 'clothes':
    case 'sports': {
      for (let r = 0; r < 3; r++) {
        const z = iz0 + 2.4 + r * 2.4;
        if (z > iz1 - 1.6) break;
        b.box('steel', ix0 + 1.0, F + 1.45, z - 0.02, ix1 - 1.4, F + 1.5, z + 0.02);
        for (const x of [ix0 + 1.0, ix1 - 1.4]) b.box('steel', x - 0.02, F, z - 0.02, x + 0.02, F + 1.5, z + 0.02);
        for (let x = ix0 + 1.2; x < ix1 - 1.5; x += 0.22) b.box(s.type === 'sports' ? ['contRed', 'contBlue', 'contGreen'][Math.floor(x * 7) % 3] : ['rug', 'fabric', 'white', 'books'][Math.floor(x * 5) % 4], x, F + 0.55, z - 0.25, x + 0.12, F + 1.42, z + 0.25);
      }
      if (s.type === 'sports') for (let x = ix0 + 0.4; x < ix1 - 0.4; x += 0.35) b.box(['redSteel', 'yellowSteel', 'contBlue'][Math.floor(x * 3) % 3], x, F, back - 0.2, x + 0.08, F + 1.9, back - 0.1); // skis
      else for (const x of [cx - 1.5, cx + 1.5]) {
        b.cyl('white', x, F, iz1 - 1.4, 0.18, 1.0, 10);
        b.cyl('white', x, F + 1.0, iz1 - 1.4, 0.22, 0.55, 10);
        b.cyl('white', x, F + 1.55, iz1 - 1.4, 0.1, 0.25, 8);
      }
      counter(ix0 + 0.3, back + 0.3, ix0 + 2.4, back + 0.9);
      break;
    }
  }
  // a rug or tiled floor patch, a ceiling lamp or two
  b.box(s.type === 'barber' || s.type === 'pharmacy' ? 'white' : 'rug', cx - Math.min(1.6, W / 3), F + 0.012, iz0 + D * 0.45, cx + Math.min(1.6, W / 3), F + 0.022, iz0 + D * 0.45 + 1.8, null, { tag: 'rug' });
  B.fixture(cx - W / 4, C, iz0 + D * 0.35, s.type === 'kiosk' || s.type === 'pharmacy' ? 'strip' : 'pendant');
  B.fixture(cx + W / 4, C, iz0 + D * 0.7, s.type === 'kiosk' || s.type === 'pharmacy' ? 'strip' : 'pendant');
}

export function shopMaterials(L: { std: (s: string, o: Record<string, unknown>, k?: string) => THREE.Material }): Record<string, THREE.Material> {
  void L;
  return {
    mirror: new THREE.MeshStandardMaterial({ color: 0xcfd6da, roughness: 0.02, metalness: 1.0, envMapIntensity: 1.4 }),
    bread: new THREE.MeshStandardMaterial({ color: 0xb8803e, roughness: 0.8 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0x3f6a3a, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85 }),
    flowerA: new THREE.MeshStandardMaterial({ color: 0xd8486a, roughness: 0.7 }),
    flowerB: new THREE.MeshStandardMaterial({ color: 0xf2d24a, roughness: 0.7 }),
    flowerC: new THREE.MeshStandardMaterial({ color: 0x7a5ac8, roughness: 0.7 }),
    barberPole: barberPoleMat(),
  };
}

// ---------------------------------------------------------------- Norwegian road signs
export type RoadSign = 'speed30' | 'speed40' | 'speed50' | 'priority' | 'crossing' | 'pedestrian' | 'parking' | 'bus' | 'yield' | 'stop' | 'tunnel' | 'deadend' | 'bump' | 'noentry' | 'oneway' | 'children';
function roadUV(kind: RoadSign) {
  const hit = roadCache.get(kind);
  if (hit) return hit;
  const uv = atlases!.road.add((c, w, h) => {
    const cx = w / 2, cy = h / 2, R = w * 0.45;
    c.lineJoin = 'round';
    const blueSq = () => {
      c.fillStyle = '#1d4fa8';
      c.beginPath();
      c.roundRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88, 14);
      c.fill();
      c.strokeStyle = '#fff';
      c.lineWidth = 7;
      c.beginPath();
      c.roundRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8, 10);
      c.stroke();
    };
    const tri = (down: boolean) => {
      c.beginPath();
      if (down) {
        c.moveTo(cx - R, cy - R * 0.75);
        c.lineTo(cx + R, cy - R * 0.75);
        c.lineTo(cx, cy + R * 0.95);
      } else {
        c.moveTo(cx, cy - R * 0.95);
        c.lineTo(cx + R, cy + R * 0.75);
        c.lineTo(cx - R, cy + R * 0.75);
      }
      c.closePath();
      // Norwegian warning signs: yellow field, red border
      c.fillStyle = '#f6c21c';
      c.fill();
      c.strokeStyle = '#c8102e';
      c.lineWidth = 16;
      c.stroke();
    };
    const fig = (x: number, y: number, s: number, color = '#fff') => {
      c.fillStyle = color;
      c.strokeStyle = color;
      c.lineWidth = 6 * s;
      c.lineCap = 'round';
      c.beginPath();
      c.arc(x, y - 30 * s, 7 * s, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(x, y - 20 * s);
      c.lineTo(x - 2 * s, y + 4 * s);
      c.moveTo(x - 2 * s, y + 4 * s);
      c.lineTo(x - 12 * s, y + 26 * s);
      c.moveTo(x - 2 * s, y + 4 * s);
      c.lineTo(x + 10 * s, y + 26 * s);
      c.moveTo(x - 1 * s, y - 14 * s);
      c.lineTo(x + 12 * s, y - 2 * s);
      c.moveTo(x - 1 * s, y - 14 * s);
      c.lineTo(x - 12 * s, y - 2 * s);
      c.stroke();
    };
    switch (kind) {
      case 'speed30':
      case 'speed40':
      case 'speed50': {
        c.fillStyle = '#fff';
        c.beginPath();
        c.arc(cx, cy, R, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#c8102e';
        c.lineWidth = 22;
        c.beginPath();
        c.arc(cx, cy, R - 11, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = '#111';
        c.font = `bold 96px ${SANS}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(kind.slice(5), cx, cy + 4);
        break;
      }
      case 'priority': {
        c.save();
        c.translate(cx, cy);
        c.rotate(Math.PI / 4);
        c.fillStyle = '#fff';
        c.fillRect(-R * 0.7, -R * 0.7, R * 1.4, R * 1.4);
        c.fillStyle = '#f6c21c';
        c.fillRect(-R * 0.48, -R * 0.48, R * 0.96, R * 0.96);
        c.strokeStyle = '#222';
        c.lineWidth = 3;
        c.strokeRect(-R * 0.7, -R * 0.7, R * 1.4, R * 1.4);
        c.restore();
        break;
      }
      case 'crossing': {
        blueSq();
        c.fillStyle = '#fff';
        c.beginPath();
        c.moveTo(cx, h * 0.18);
        c.lineTo(w * 0.82, h * 0.8);
        c.lineTo(w * 0.18, h * 0.8);
        c.closePath();
        c.fill();
        fig(cx, cy + 22, 1.0, '#111');
        break;
      }
      case 'pedestrian': {
        blueSq();
        fig(cx - 18, cy + 8, 1.5);
        fig(cx + 26, cy + 18, 1.0);
        break;
      }
      case 'parking': {
        blueSq();
        c.fillStyle = '#fff';
        c.font = `bold 150px ${SANS}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('P', cx, cy + 8);
        break;
      }
      case 'bus': {
        blueSq();
        c.fillStyle = '#fff';
        c.beginPath();
        c.roundRect(cx - 62, cy - 48, 124, 80, 12);
        c.fill();
        c.fillStyle = '#1d4fa8';
        c.fillRect(cx - 50, cy - 38, 100, 32);
        c.beginPath();
        c.arc(cx - 34, cy + 36, 12, 0, Math.PI * 2);
        c.arc(cx + 34, cy + 36, 12, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
        break;
      }
      case 'yield':
        tri(true);
        break;
      case 'stop': {
        c.fillStyle = '#c8102e';
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        }
        c.closePath();
        c.fill();
        c.strokeStyle = '#fff';
        c.lineWidth = 6;
        c.stroke();
        c.fillStyle = '#fff';
        c.font = `bold 66px ${SANS}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('STOP', cx, cy + 3);
        break;
      }
      case 'tunnel': {
        tri(false);
        c.fillStyle = '#111';
        c.beginPath();
        c.moveTo(cx - 44, cy + 44);
        c.lineTo(cx - 44, cy + 6);
        c.quadraticCurveTo(cx, cy - 46, cx + 44, cy + 6);
        c.lineTo(cx + 44, cy + 44);
        c.closePath();
        c.fill();
        c.fillStyle = '#f6c21c';
        c.beginPath();
        c.moveTo(cx - 26, cy + 44);
        c.lineTo(cx - 26, cy + 14);
        c.quadraticCurveTo(cx, cy - 18, cx + 26, cy + 14);
        c.lineTo(cx + 26, cy + 44);
        c.closePath();
        c.fill();
        break;
      }
      case 'bump': {
        tri(false);
        c.fillStyle = '#111';
        c.beginPath();
        c.moveTo(cx - 50, cy + 38);
        c.quadraticCurveTo(cx, cy - 30, cx + 50, cy + 38);
        c.closePath();
        c.fill();
        break;
      }
      case 'children': {
        tri(false);
        fig(cx - 16, cy + 18, 0.8, '#111');
        fig(cx + 18, cy + 24, 0.62, '#111');
        break;
      }
      case 'deadend': {
        blueSq();
        c.fillStyle = '#fff';
        c.fillRect(cx - 12, cy - 10, 24, 80);
        c.fillStyle = '#c8102e';
        c.fillRect(cx - 50, cy - 46, 100, 30);
        break;
      }
      case 'noentry': {
        c.fillStyle = '#c8102e';
        c.beginPath();
        c.arc(cx, cy, R, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#fff';
        c.fillRect(cx - R * 0.68, cy - 16, R * 1.36, 32);
        break;
      }
      case 'oneway': {
        blueSq();
        c.fillStyle = '#fff';
        c.beginPath();
        c.moveTo(cx, h * 0.2);
        c.lineTo(cx + 46, cy - 14);
        c.lineTo(cx + 16, cy - 14);
        c.lineTo(cx + 16, h * 0.8);
        c.lineTo(cx - 16, h * 0.8);
        c.lineTo(cx - 16, cy - 14);
        c.lineTo(cx - 46, cy - 14);
        c.closePath();
        c.fill();
        break;
      }
    }
  });
  roadCache.set(kind, uv);
  return uv;
}

/** A road sign on a grey post at (x, ground, z), facing yaw (the sign's face looks along +Z after yaw). */
export function roadSign(b: GeoBuilder, kind: RoadSign, x: number, y: number, z: number, yaw: number, under?: RoadSign) {
  b.push([x, y, z], yaw);
  b.cyl('steel', 0, 0, 0, 0.04, under ? 2.95 : 2.55, 8, 'metal');
  const uv = roadUV(kind);
  plane(b, 'signRoad', uv, 0.7, 0.7, new THREE.Matrix4().setPosition(0, (under ? 2.6 : 2.2), 0.05));
  plane(b, 'signBack', { u0: 0, u1: 1, v0: 0, v1: 1 }, 0.62, 0.62, new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, (under ? 2.6 : 2.2), 0.04));
  if (under) {
    plane(b, 'signRoad', roadUV(under), 0.5, 0.5, new THREE.Matrix4().setPosition(0, 1.95, 0.05));
    plane(b, 'signBack', { u0: 0, u1: 1, v0: 0, v1: 1 }, 0.45, 0.45, new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.95, 0.04));
  }
  b.pop();
}
