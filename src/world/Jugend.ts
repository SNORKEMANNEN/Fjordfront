import * as THREE from 'three';
import type { Buildings } from './Buildings';
import type { BuildingDef } from './MapLayout';
import { RNG } from '../core/math';

/**
 * Brosund's Jugendstil (Art Nouveau) town houses, after the rebuilt centre of Ålesund: 3–5 storey
 * stucco blocks in ochre, salmon, mint, white, deep red, yellow and pale blue; a granite ground
 * floor with shop fronts; string courses and a heavy cornice; arched top-floor windows; wrought-iron
 * balconies; a steep slate or green-copper mansard roof with dormers; a curved or stepped front
 * gable; and on many corners a round turret with a spire or a bell dome.
 *
 * Built in the building's local frame: +X along the street, +Z out of the front (canal side), y = 0
 * at the pad. Most blocks are solid (one collider for the volume) with an open, enterable shop on
 * the ground floor in about half of the quay-front ones — those run through to the street behind.
 */
type Op = { x: number; w: number; y0: number; y1: number };

const P = 0.45; // granite plinth
const G = 3.7; // ground floor (shops)
const FH = 3.15; // upper floors

/** Extrude a closed 2D outline (local XY) into a slab of depth t at z (front face at z + t/2). */
function slab(B: Buildings, mat: string, pts: [number, number][], z: number, t: number) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 3 });
  g.translate(0, 0, z - t / 2);
  B.b.addGeo(mat, g);
}

/** Half-annulus (an arch moulding) in the XY plane at z: centre (x, y), inner radius r, width k. */
function archTrim(B: Buildings, mat: string, x: number, y: number, r: number, k: number, z: number, t: number) {
  const pts: [number, number][] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * i) / n;
    pts.push([x + Math.cos(a) * (r + k), y + Math.sin(a) * (r + k)]);
  }
  for (let i = n; i >= 0; i--) {
    const a = (Math.PI * i) / n;
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  slab(B, mat, pts, z, t);
}
/** Half disc (the glazed fan light of an arched window). */
function halfDisc(B: Buildings, mat: string, x: number, y: number, r: number, z: number, t: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI * i) / 6;
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  slab(B, mat, pts, z, t);
}

/**
 * One window on a facade at z (outward +Z in the current frame): a recessed glass pane in a
 * stucco surround with a sill, optionally arched, with a hood moulding.
 */
function win(B: Buildings, x: number, y0: number, wW: number, wH: number, z: number, lit: boolean, style: 'plain' | 'arch' | 'hood' | 'pediment', trim: string) {
  const b = B.b;
  const glass = lit ? 'jglassLit' : 'jglass';
  b.box(trim, x - wW / 2 - 0.14, y0 - 0.08, z - 0.02, x + wW / 2 + 0.14, y0 + wH + 0.1, z + 0.05);
  b.box(glass, x - wW / 2, y0, z + 0.04, x + wW / 2, y0 + wH, z + 0.07);
  // mullion and transom
  b.box(trim, x - 0.035, y0, z + 0.07, x + 0.035, y0 + wH, z + 0.1);
  b.box(trim, x - wW / 2, y0 + wH * 0.68, z + 0.07, x + wW / 2, y0 + wH * 0.68 + 0.06, z + 0.1);
  b.box(trim, x - wW / 2 - 0.2, y0 - 0.16, z - 0.02, x + wW / 2 + 0.2, y0 - 0.04, z + 0.16); // sill
  if (style === 'arch') {
    halfDisc(B, trim, x, y0 + wH, wW / 2 + 0.14, z + 0.015, 0.07);
    halfDisc(B, glass, x, y0 + wH + 0.02, wW / 2 - 0.02, z + 0.055, 0.03);
    archTrim(B, trim, x, y0 + wH, wW / 2 + 0.1, 0.16, z + 0.08, 0.1);
    b.box(trim, x - 0.09, y0 + wH + wW / 2 + 0.1, z + 0.05, x + 0.09, y0 + wH + wW / 2 + 0.38, z + 0.16); // keystone
  } else if (style === 'hood') {
    b.box(trim, x - wW / 2 - 0.26, y0 + wH + 0.14, z - 0.02, x + wW / 2 + 0.26, y0 + wH + 0.3, z + 0.2);
  } else if (style === 'pediment') {
    slab(B, trim, [[x - wW / 2 - 0.3, y0 + wH + 0.14], [x + wW / 2 + 0.3, y0 + wH + 0.14], [x, y0 + wH + 0.62]], z + 0.07, 0.18);
  }
}

/** Wrought-iron balcony in front of a window at floor level y. */
function balcony(B: Buildings, x: number, y: number, w: number, z: number) {
  const b = B.b;
  b.box('stucco', x - w / 2, y - 0.16, z, x + w / 2, y, z + 0.9, 'concrete');
  // consoles under the slab
  for (const sx of [-1, 1]) b.box('stucco', x + sx * (w / 2 - 0.2) - 0.08, y - 0.5, z, x + sx * (w / 2 - 0.2) + 0.08, y - 0.16, z + 0.6);
  // railing: posts, balusters with a curl, top rail
  const n = Math.max(4, Math.round(w / 0.14));
  for (let i = 0; i <= n; i++) {
    const bx = x - w / 2 + 0.04 + ((w - 0.08) * i) / n;
    b.box('iron', bx - 0.012, y, z + 0.84, bx + 0.012, y + 1.0, z + 0.87);
  }
  for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) b.box('iron', x + sx * (w / 2 - 0.03) - 0.012, y, z + 0.08 + k * 0.15, x + sx * (w / 2 - 0.03) + 0.012, y + 1.0, z + 0.1 + k * 0.15);
  b.box('iron', x - w / 2, y + 1.0, z + 0.82, x + w / 2, y + 1.05, z + 0.89);
  b.box('iron', x - w / 2, y + 0.18, z + 0.84, x + w / 2, y + 0.21, z + 0.87);
  for (const sx of [-1, 1]) b.box('iron', x + sx * (w / 2 - 0.02) - 0.02, y + 1.0, z, x + sx * (w / 2 - 0.02) + 0.02, y + 1.05, z + 0.89);
  // a little Art Nouveau curl in the middle (two rings)
  for (const k of [0.4, 0.7]) {
    const ring = new THREE.TorusGeometry(0.13, 0.012, 3, 10);
    B.b.addGeo('iron', ring, new THREE.Matrix4().setPosition(x, y + k, z + 0.86));
  }
  // railing collider
  b.box(null, x - w / 2, y, z + 0.8, x + w / 2, y + 1.05, z + 0.92, 'metal');
  for (const sx of [-1, 1]) b.box(null, x + sx * w / 2 - 0.05, y, z, x + sx * w / 2 + 0.05, y + 1.05, z + 0.9, 'metal');
}

/** A round corner turret at (cx, cz): shaft to `top`, cornice, a spire or a bell dome. */
function turret(B: Buildings, rng: RNG, cx: number, cz: number, R: number, y0: number, top: number, col: string, roofMat: string, floorYs: number[]) {
  const b = B.b;
  b.cyl(col, cx, y0, cz, R, top - y0, 18, 'concrete');
  // string courses round the turret at every floor
  for (const fy of floorYs) if (fy > y0 + 0.5 && fy < top - 0.4) b.cyl('stucco', cx, fy - 0.09, cz, R + 0.07, 0.18, 18);
  b.cyl('stucco', cx, top - 0.35, cz, R + 0.18, 0.42, 18);
  // windows: three per floor round the outside (glass panels set into the shaft)
  for (let i = 0; i < floorYs.length; i++) {
    const fy = floorYs[i];
    if (fy < y0 || fy + 2 > top) continue;
    for (const a of [-0.9, 0, 0.9]) {
      const ang = Math.atan2(cx, cz) + a; // face away from the building centre
      b.push([cx, 0, cz], ang);
      const lit = rng.chance(0.4);
      b.box('stucco', -0.55, fy + 0.62, R - 0.05, 0.55, fy + 2.5, R + 0.04);
      b.box(lit ? 'jglassLit' : 'jglass', -0.42, fy + 0.72, R + 0.02, 0.42, fy + 2.38, R + 0.07);
      b.box('stucco', -0.6, fy + 0.56, R - 0.02, 0.6, fy + 0.68, R + 0.14);
      b.pop();
    }
  }
  if (rng.chance(0.65)) {
    // tall spire with a finial
    const h = R * rng.range(2.6, 3.4);
    const sp = new THREE.ConeGeometry(R + 0.2, h, 16);
    b.addGeo(roofMat, sp, new THREE.Matrix4().setPosition(cx, top + h / 2 + 0.05, cz));
    b.cyl('copper', cx, top + h, cz, 0.05, 1.3, 6);
    const ball = new THREE.SphereGeometry(0.16, 10, 8);
    b.addGeo('copper', ball, new THREE.Matrix4().setPosition(cx, top + h + 0.7, cz));
  } else {
    // bell dome (Jugend "løkkuppel") with a lantern spike
    const prof: THREE.Vector2[] = [];
    const hh = R * 2.1;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const r = (R + 0.22) * (t < 0.35 ? 1 + 0.12 * Math.sin((t / 0.35) * Math.PI) : Math.pow(Math.cos(((t - 0.35) / 0.65) * Math.PI * 0.5), 0.8));
      prof.push(new THREE.Vector2(Math.max(0.02, r), t * hh));
    }
    const dome = new THREE.LatheGeometry(prof, 16);
    b.addGeo(roofMat, dome, new THREE.Matrix4().setPosition(cx, top + 0.05, cz));
    b.cyl('copper', cx, top + hh, cz, 0.06, 1.6, 6);
  }
  B.footprints.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(cx, 0, cz).applyMatrix4(b.m), new THREE.Vector3(R * 2.4, 60, R * 2.4)));
}

/** Mansard roof over the block (ridge along X), with end caps, dormers and chimneys. */
function mansard(B: Buildings, rng: RNG, w: number, d: number, eave: number, roofMat: string, col: string, gableW: number) {
  const b = B.b;
  const inset = 0.95, low = 2.5, pitchUp = 0.5;
  const upperHalf = d / 2 - inset;
  const rise = upperHalf * Math.tan(pitchUp);
  // eave cornice runs round the block
  b.box('stucco', -w / 2 - 0.05, eave - 0.45, d / 2 - 0.05, w / 2 + 0.05, eave, d / 2 + 0.38);
  b.box('stucco', -w / 2 - 0.05, eave - 0.45, -d / 2 - 0.38, w / 2 + 0.05, eave, -d / 2 + 0.05);
  b.box('stucco', -w / 2 - 0.05, eave - 0.75, d / 2 - 0.05, w / 2 + 0.05, eave - 0.45, d / 2 + 0.18);
  b.box('stucco', -w / 2 - 0.05, eave - 0.75, -d / 2 - 0.18, w / 2 + 0.05, eave - 0.45, -d / 2 + 0.05);
  const lowLen = Math.hypot(inset, low), lowAng = Math.atan2(inset, low);
  const upLen = upperHalf / Math.cos(pitchUp);
  for (const s of [1, -1]) {
    // lower steep slope
    b.obox(roofMat, [0, eave + low / 2, s * (d / 2 - inset / 2)], [w, 0.16, lowLen], new THREE.Euler(s * (Math.PI / 2 - lowAng), 0, 0), 'metal');
    // upper slope
    b.obox(roofMat, [0, eave + low + rise / 2 + 0.06, (s * upperHalf) / 2], [w, 0.14, upLen], new THREE.Euler(s * pitchUp, 0, 0), 'metal');
    // the kink trim
    b.box('stucco', -w / 2, eave + low - 0.05, s * upperHalf - 0.08, w / 2, eave + low + 0.08, s * upperHalf + 0.08);
  }
  // end caps (fire walls) on both ends: the roof profile in stucco
  const prof: [number, number][] = [[-d / 2, eave], [d / 2, eave], [d / 2 - inset, eave + low], [0, eave + low + rise], [-(d / 2 - inset), eave + low]];
  for (const sx of [-1, 1]) {
    b.push([sx * (w / 2 - 0.12), 0, 0], Math.PI / 2);
    slab(B, col, prof.map(([z, y]) => [-z, y]), 0, 0.24);
    b.pop();
    // fire-wall coping
    b.box('stucco', sx * w / 2 - 0.2, eave + low + rise - 0.1, -0.25, sx * w / 2 + 0.05, eave + low + rise + 0.25, 0.25);
  }
  // dormers on both lower slopes, clear of the front gable
  const nD = Math.max(1, Math.floor(w / 4.2));
  for (const s of [1, -1]) {
    for (let i = 0; i < nD; i++) {
      const x = -w / 2 + (w / nD) * (i + 0.5);
      if (s > 0 && Math.abs(x) < gableW / 2 + 0.9) continue;
      if (!rng.chance(0.8)) continue;
      const z0 = s * (d / 2 - inset * 0.35), y0 = eave + 0.45;
      b.push([x, 0, z0], s > 0 ? 0 : Math.PI);
      b.box(col, -0.7, y0, -1.1, 0.7, y0 + 1.6, 0.0, 'concrete');
      b.box('stucco', -0.78, y0 + 1.6, -1.15, 0.78, y0 + 1.72, 0.08);
      b.box(rng.chance(0.35) ? 'jglassLit' : 'jglass', -0.42, y0 + 0.25, 0.0, 0.42, y0 + 1.35, 0.04);
      b.box('stucco', -0.5, y0 + 0.17, 0.0, 0.5, y0 + 0.25, 0.1);
      slab(B, roofMat, [[-0.9, y0 + 1.72], [0.9, y0 + 1.72], [0, y0 + 2.45]], -0.5, 1.3);
      b.pop();
    }
  }
  // chimneys
  for (let i = 0; i < rng.int(1, 2); i++) {
    const x = rng.range(-w / 2 + 1, w / 2 - 1), z = rng.range(-1.2, 1.2);
    b.box('chimney', x - 0.35, eave + low, z - 0.45, x + 0.35, eave + low + rise + 1.4, z + 0.45);
    b.box('stucco', x - 0.42, eave + low + rise + 1.3, z - 0.52, x + 0.42, eave + low + rise + 1.45, z + 0.52);
    B.chimneys.push(new THREE.Vector3(x, eave + low + rise + 1.5, z).applyMatrix4(b.m));
  }
  return low + rise;
}

/** Front gable over the facade centre: curved (Jugend scrolls) or stepped. */
function frontGable(B: Buildings, rng: RNG, kind: 'curved' | 'stepped', gw: number, gh: number, eave: number, z: number, col: string) {
  const b = B.b;
  if (kind === 'stepped') {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const ww = gw * (1 - i / n), y0 = eave + (gh * i) / n, y1 = eave + (gh * (i + 1)) / n;
      b.box(col, -ww / 2, y0, z - 0.45, ww / 2, y1, z, 'concrete');
      b.box('stucco', -ww / 2 - 0.08, y1 - 0.02, z - 0.5, ww / 2 + 0.08, y1 + 0.14, z + 0.06);
    }
    b.cyl('stucco', 0, eave + gh + 0.1, z - 0.2, 0.14, 0.6, 8);
  } else {
    // a bell-shaped outline with scrolls at the shoulders
    const pts: [number, number][] = [];
    const half = gw / 2;
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const t = i / N; // 0 at the left foot → 1 at the top centre
      const x = -half + half * (t < 0.45 ? t * 0.9 / 0.45 * 0.62 : 0.56 + (t - 0.45) / 0.55 * 0.44);
      const y = t < 0.45 ? gh * 0.55 * Math.sin((t / 0.45) * Math.PI * 0.5) + gh * 0.05 * Math.sin((t / 0.45) * Math.PI * 2) : gh * (0.55 + 0.45 * Math.sin(((t - 0.45) / 0.55) * Math.PI * 0.5));
      pts.push([x, eave + y]);
    }
    for (let i = N - 1; i >= 0; i--) pts.push([-pts[i][0], pts[i][1]]);
    slab(B, col, pts, z - 0.22, 0.45);
    // coping following the outline (short boxes along each edge)
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      b.obox('stucco', [(x0 + x1) / 2, (y0 + y1) / 2, z - 0.2], [len + 0.04, 0.14, 0.58], new THREE.Euler(0, 0, Math.atan2(y1 - y0, x1 - x0)));
    }
    // a solid core behind it for collisions
    b.box(null, -gw * 0.35, eave, z - 0.45, gw * 0.35, eave + gh * 0.9, z, 'concrete');
  }
  // round window (oculus) or a small arched pair in the gable
  if (rng.chance(0.5)) {
    const ring = new THREE.TorusGeometry(0.5, 0.1, 6, 18);
    b.addGeo('stucco', ring, new THREE.Matrix4().setPosition(0, eave + gh * 0.5, z + 0.03));
    const disc = new THREE.CircleGeometry(0.46, 18);
    b.addGeo(rng.chance(0.4) ? 'jglassLit' : 'jglass', disc, new THREE.Matrix4().setPosition(0, eave + gh * 0.5, z + 0.02));
  } else {
    for (const sx of [-1, 1]) win(B, sx * 0.55, eave + gh * 0.22, 0.6, 1.0, z, rng.chance(0.3), 'arch', 'stucco');
  }
  // a stucco motif: a medallion with a sun-burst
  b.cyl('stucco', 0, eave + gh * 0.82, z - 0.1, 0.22, 0.14, 12);
}

export function jugend(B: Buildings, def: BuildingDef) {
  const b = B.b;
  const rng = new RNG(def.seed ?? 1);
  const w = def.w ?? 12, d = def.d ?? 12, floors = def.floors ?? 4;
  const col = 'j_' + (def.jcolor ?? 'ochre');
  const roofMat = def.roofMat === 'copper' ? 'copper' : 'slate';
  const enter = !!def.enter;
  const eave = P + G + FH * (floors - 1);
  const floorYs = [P, ...Array.from({ length: floors - 1 }, (_, i) => P + G + FH * i)];
  // granite footing (down into the slope)
  b.box('granite', -w / 2 - 0.06, -2.5, -d / 2 - 0.06, w / 2 + 0.06, P, d / 2 + 0.06, 'rock');
  const T = 0.32;
  if (enter) {
    // ---- an enterable shop on the ground floor that runs through to the street behind ----
    const ix0 = -w / 2 + T, ix1 = w / 2 - T, iz0 = -d / 2 + T, iz1 = d / 2 - T;
    b.box('floorInt', ix0, P - 0.02, iz0, ix1, P + 0.01, iz1, 'woodFloor');
    const doorX = rng.range(-w / 2 + 2, w / 2 - 2.2);
    const shopWins: Op[] = [];
    for (let x = -w / 2 + 1.3; x < w / 2 - 1.2; x += 2.4) if (Math.abs(x - doorX) > 1.6) shopWins.push({ x, w: 1.7, y0: P + 0.6, y1: P + 2.75 });
    const front: Op[] = [{ x: doorX, w: 1.2, y0: P, y1: P + 2.4 }, ...shopWins];
    const backDoor = -doorX * 0.6;
    const back: Op[] = [{ x: backDoor, w: 1.2, y0: P, y1: P + 2.3 }, { x: backDoor - 2.4, w: 1.0, y0: P + 1.0, y1: P + 2.3 }];
    b.wall('granite', -w / 2, w / 2, d / 2 - T / 2, T, P, P + G, front, 'concrete', 'wallInt');
    for (const o of shopWins) B.windowFrame(o.x, o.y0, o.y1, o.w, d / 2, 1, true, false);
    b.push([0, 0, -d / 2 + T / 2], Math.PI);
    b.wall('granite', -w / 2, w / 2, 0, T, P, P + G, back.map((o) => ({ ...o, x: -o.x })), 'concrete', 'wallInt');
    B.windowFrame(-(backDoor - 2.4), P + 1.0, P + 2.3, 1.0, T / 2, 1, true, true);
    b.pop();
    for (const sx of [-1, 1]) {
      const open = sx < 0 ? (def.open ?? 0) & 1 : (def.open ?? 0) & 2;
      b.push([sx * (w / 2 - T / 2), 0, 0], (sx * Math.PI) / 2);
      const ops: Op[] = open ? [{ x: 0, w: 1.4, y0: P + 0.8, y1: P + 2.6 }] : [];
      b.wall('granite', -d / 2 + T, d / 2 - T, 0, T, P, P + G, ops, 'concrete', 'wallInt');
      for (const o of ops) B.windowFrame(o.x, o.y0, o.y1, o.w, T / 2, 1, true, true);
      b.pop();
    }
    // ceiling + the solid upper block
    b.box('wallInt', ix0, P + G - 0.06, iz0, ix1, P + G, iz1);
    b.box(col, -w / 2, P + G, -d / 2, w / 2, eave, d / 2, 'concrete');
    // a counter, shelves, a table or two, a pendant lamp
    b.box('wood', ix0 + 0.2, P, iz0 + 1.2, ix0 + 0.8, P + 1.05, iz1 - 2.0, 'wood');
    b.box('wood', ix1 - 0.45, P, iz0 + 0.6, ix1 - 0.05, P + 2.0, iz0 + 3.2, 'wood');
    for (let k = 0; k < 2; k++) {
      const tx = rng.range(ix0 + 2, ix1 - 1.5), tz = rng.range(iz0 + 2, iz1 - 2);
      b.box('wood', tx - 0.45, P + 0.72, tz - 0.45, tx + 0.45, P + 0.76, tz + 0.45, 'wood');
      b.box('wood', tx - 0.04, P, tz - 0.04, tx + 0.04, P + 0.72, tz + 0.04);
    }
    B.fixture(0, P + G - 0.06, 0, 'pendant');
    B.steps(doorX, d / 2 + 0.05, 0, 1, 1.8, P);
    B.steps(-backDoor, -d / 2 - 0.05, 0, -1, 1.8, P);
    B.link(doorX, P, d / 2 + 2.0, doorX, P, iz1 - 1.0);
    B.link(doorX, P, iz1 - 1.0, backDoor, P, iz0 + 1.0);
    B.link(-(-backDoor), P, iz0 + 1.0, -(-backDoor), P, -d / 2 - 2.0);
    B.point(0, P, 0);
  } else {
    // ---- solid block: one collider, ground floor shop fronts in granite ----
    b.box(col, -w / 2, P, -d / 2, w / 2, eave, d / 2, 'concrete');
    b.box('granite', -w / 2 - 0.04, P, d / 2 - 0.1, w / 2 + 0.04, P + G - 0.1, d / 2 + 0.06);
    b.box('granite', -w / 2 - 0.04, P, -d / 2 - 0.06, w / 2 + 0.04, P + G - 0.1, -d / 2 + 0.1);
    for (const sz of [1, -1]) {
      b.push([0, 0, 0], sz > 0 ? 0 : Math.PI);
      const doorX = rng.range(-w / 2 + 1.6, w / 2 - 1.6);
      b.box('door', doorX - 0.6, P, d / 2 + 0.06, doorX + 0.6, P + 2.4, d / 2 + 0.1);
      b.box('stucco', doorX - 0.75, P + 2.4, d / 2 + 0.04, doorX + 0.75, P + 2.6, d / 2 + 0.14);
      halfDisc(B, 'jglass', doorX, P + 2.6, 0.55, d / 2 + 0.09, 0.03);
      for (let x = -w / 2 + 1.3; x < w / 2 - 1.2; x += 2.5) {
        if (Math.abs(x - doorX) < 1.5) continue;
        b.box('stucco', x - 0.95, P + 0.55, d / 2 + 0.04, x + 0.95, P + 2.85, d / 2 + 0.1);
        b.box(rng.chance(0.5) ? 'jglassLit' : 'jglass', x - 0.82, P + 0.65, d / 2 + 0.09, x + 0.82, P + 2.75, d / 2 + 0.13);
        if (rng.chance(0.4)) archTrim(B, 'stucco', x, P + 2.85, 0.75, 0.15, d / 2 + 0.1, 0.08);
      }
      b.pop();
    }
  }
  // the facade colour band over the granite
  b.box(col, -w / 2 - 0.02, P + G - 0.1, d / 2 - 0.05, w / 2 + 0.02, eave - 0.4, d / 2 + 0.02);
  b.box(col, -w / 2 - 0.02, P + G - 0.1, -d / 2 - 0.02, w / 2 + 0.02, eave - 0.4, -d / 2 + 0.05);
  // ---- upper floors: windows, string courses, balconies, ornaments (front + back) ----
  const nWin = Math.max(2, Math.floor((w - 1.4) / 2.0));
  const sp = (w - 1.4) / nWin;
  const styleOf = (f: number): 'plain' | 'arch' | 'hood' | 'pediment' => (f === floors - 1 ? 'arch' : f === 1 ? (rng.chance(0.5) ? 'pediment' : 'hood') : rng.chance(0.4) ? 'hood' : 'plain');
  const styles = Array.from({ length: floors }, (_, f) => styleOf(f));
  const balF = floors >= 3 ? rng.int(1, Math.min(2, floors - 1)) : -1;
  const balWide = rng.chance(0.4);
  for (const sz of [1, -1]) {
    b.push([0, 0, 0], sz > 0 ? 0 : Math.PI);
    const z = d / 2;
    for (let f = 1; f < floors; f++) {
      const y = P + G + FH * (f - 1);
      // string course at each floor line
      b.box('stucco', -w / 2 - 0.04, y - 0.1, z - 0.02, w / 2 + 0.04, y + 0.1, z + 0.12);
      for (let i = 0; i < nWin; i++) {
        const x = -w / 2 + 0.7 + sp * (i + 0.5);
        const st = sz > 0 ? styles[f] : 'plain';
        win(B, x, y + 0.85, 1.0, f === floors - 1 ? 1.55 : 1.85, z, rng.chance(0.38), st, 'stucco');
      }
      if (sz > 0 && f === balF) {
        if (balWide) balcony(B, 0, y, Math.min(w - 2, sp * 2 + 0.6), z);
        else balcony(B, -w / 2 + 0.7 + sp * (Math.floor(nWin / 2) + 0.5), y, 1.6, z);
      }
    }
    // corner pilasters (quoins)
    for (const sx of [-1, 1]) b.box('stucco', sx * w / 2 - 0.3 * (sx > 0 ? 1 : 0) - (sx < 0 ? 0 : 0), P + G - 0.1, z - 0.02, sx * w / 2 + (sx < 0 ? 0.3 : 0) - (sx > 0 ? 0 : 0), eave - 0.45, z + 0.1);
    // floral ornaments between the top windows
    if (sz > 0) for (let i = 0; i < nWin - 1; i++) {
      const x = -w / 2 + 0.7 + sp * (i + 1);
      const y = eave - 1.1;
      for (const [ox, oy] of [[0, 0], [-0.16, -0.14], [0.16, -0.14]] as const) {
        const g = new THREE.SphereGeometry(0.11, 5, 3);
        g.scale(1, 1, 0.5);
        b.addGeo('stucco', g, new THREE.Matrix4().setPosition(x + ox, y + oy, z + 0.06));
      }
    }
    b.pop();
  }
  // exposed side walls get windows too
  for (const sx of [-1, 1]) {
    const open = sx < 0 ? (def.open ?? 0) & 1 : (def.open ?? 0) & 2;
    if (!open) continue;
    b.push([sx * w / 2, 0, 0], (sx * Math.PI) / 2);
    const n2 = Math.max(1, Math.floor((d - 1.4) / 2.4));
    const sp2 = (d - 1.4) / n2;
    for (let f = 1; f < floors; f++) {
      const y = P + G + FH * (f - 1);
      b.box('stucco', -d / 2, y - 0.1, -0.02, d / 2, y + 0.1, 0.1);
      for (let i = 0; i < n2; i++) win(B, -d / 2 + 0.7 + sp2 * (i + 0.5), y + 0.85, 0.95, f === floors - 1 ? 1.5 : 1.8, 0, rng.chance(0.35), f === floors - 1 ? 'arch' : 'plain', 'stucco');
    }
    b.box(col, -d / 2, P + G - 0.1, -0.03, d / 2, eave - 0.4, 0.02);
    b.pop();
  }
  // ---- roof, front gable, turret ----
  const gk = def.gable ?? 'none';
  const gw = gk === 'none' ? 0 : Math.min(w * 0.55, 7.5);
  mansard(B, rng, w, d, eave, roofMat, col, gw);
  if (gk !== 'none') frontGable(B, rng, gk, gw, rng.range(3.4, 4.8), eave, d / 2 + 0.02, col);
  if (def.tower) {
    const sx = def.tower === 'L' ? -1 : 1;
    const R = Math.min(2.0, w * 0.16);
    turret(B, rng, sx * (w / 2 - R * 0.35), d / 2 - R * 0.35 + 0.3, R, P + (enter ? G : 0), eave + 2.8, col, roofMat, floorYs);
  }
}

/** Sundkyrkja: a grey granite church with a tall square tower and a slate pyramid spire. */
export function stoneChurch(B: Buildings, def: BuildingDef) {
  const b = B.b;
  const w = 26, d = 13, H = 9, T = 0.6, F = 0.6;
  b.box('granite', -w / 2 - 0.2, -3, -d / 2 - 0.2, w / 2 + 0.2, F, d / 2 + 0.2, 'rock');
  b.box('floorInt', -w / 2 + T, F - 0.02, -d / 2 + T, w / 2 - T, F + 0.01, d / 2 - T, 'woodFloor');
  const winOps = (n: number): Op[] => Array.from({ length: n }, (_, i) => ({ x: -w / 2 + 3 + i * ((w - 6) / (n - 1)), w: 1.3, y0: F + 2.4, y1: F + 6.4 }));
  for (const s of [1, -1]) {
    b.push([0, 0, s * (d / 2 - T / 2)], s > 0 ? 0 : Math.PI);
    const ops = winOps(5);
    if (s > 0) ops.push({ x: -w / 2 + 3 + 2 * ((w - 6) / 4) + 2.4, w: 1.4, y0: F, y1: F + 2.6 });
    b.wall('stone', -w / 2, w / 2, 0, T, F, F + H, ops, 'concrete', 'wallInt');
    for (const o of ops) if (o.y0 > F + 0.1) {
      B.windowFrame(o.x, o.y0, o.y1, o.w, T / 2, 1, true, true);
      archTrim(B, 'granite', o.x, o.y1, o.w / 2 + 0.05, 0.28, T / 2 + 0.05, 0.12);
      halfDisc(B, 'jglass', o.x, o.y1, o.w / 2, T / 2 - 0.05, 0.04);
    }
    // buttresses
    for (let i = 0; i < 6; i++) b.box('granite', -w / 2 + 0.5 + i * ((w - 1) / 5) - 0.35, F, T / 2, -w / 2 + 0.5 + i * ((w - 1) / 5) + 0.35, F + H * 0.7, T / 2 + 0.7, 'concrete');
    b.pop();
  }
  // apse end
  b.push([-w / 2 + T / 2, 0, 0], -Math.PI / 2);
  b.wall('stone', -d / 2 + T, d / 2 - T, 0, T, F, F + H, [{ x: 0, w: 2.0, y0: F + 3, y1: F + 7.5 }], 'concrete', 'wallInt');
  B.windowFrame(0, F + 3, F + 7.5, 2.0, T / 2, 1, true, true);
  archTrim(B, 'granite', 0, F + 7.5, 1.05, 0.3, T / 2 + 0.05, 0.12);
  b.pop();
  // steep slate roof + gable over the apse
  const rise = B.gableRoof(w, d, F + H, 0.95, 0.4, 'slate', false);
  b.push([-w / 2 + T / 2, 0, 0], -Math.PI / 2);
  b.gable('stone', -d / 2, d / 2, 0, T, F + H, rise, 'concrete');
  b.pop();
  // tower at the +x end: square, 30 m, belfry openings, pyramid spire
  const ts = 7, TH = 30, tx = w / 2 + ts / 2 - T;
  b.push([tx, 0, 0], 0);
  const bell = (y: number): Op[] => [{ x: 0, w: 1.6, y0: y, y1: y + 3.4 }];
  for (const [ox, oz, r] of [[0, ts / 2 - T / 2, 0], [0, -ts / 2 + T / 2, Math.PI], [ts / 2 - T / 2, 0, Math.PI / 2]] as const) {
    b.push([ox, 0, oz], r);
    const ops = [...bell(F + TH - 6)];
    if (r === Math.PI / 2) ops.push({ x: 0, w: 1.6, y0: F, y1: F + 3.2 });
    b.wall('stone', r === Math.PI / 2 ? -ts / 2 + T : -ts / 2, r === Math.PI / 2 ? ts / 2 - T : ts / 2, 0, T, F, F + TH, ops, 'concrete', 'wallInt');
    archTrim(B, 'granite', 0, F + TH - 6 + 3.4, 0.85, 0.3, T / 2 + 0.05, 0.12);
    for (let i = 0; i < 6; i++) b.box('woodRaw', -0.8, F + TH - 5.8 + i * 0.55, -0.08, 0.8, F + TH - 5.7 + i * 0.55, 0.08);
    // clock face
    const clock = new THREE.CircleGeometry(1.1, 24);
    b.addGeo('stucco', clock, new THREE.Matrix4().setPosition(0, F + TH - 9, T / 2 + 0.03));
    b.box('iron', -0.04, F + TH - 9, T / 2 + 0.05, 0.04, F + TH - 8.2, T / 2 + 0.08);
    b.box('iron', -0.04, F + TH - 9.04, T / 2 + 0.05, 0.6, F + TH - 8.96, T / 2 + 0.08);
    b.pop();
  }
  b.push([-ts / 2 + T / 2, 0, 0], -Math.PI / 2);
  b.wall('stone', -ts / 2 + T, ts / 2 - T, 0, T, F + H, F + TH, [], 'concrete');
  b.pop();
  b.box('stucco', -ts / 2 - 0.25, F + TH - 0.2, -ts / 2 - 0.25, ts / 2 + 0.25, F + TH + 0.3, ts / 2 + 0.25);
  const sp = new THREE.ConeGeometry(ts * 0.74, 12, 4);
  sp.rotateY(Math.PI / 4);
  b.addGeo('slate', sp, new THREE.Matrix4().setPosition(0, F + TH + 6.3, 0));
  b.cyl('copper', 0, F + TH + 12, 0, 0.06, 2.2, 6);
  b.box('copper', -0.6, F + TH + 13.4, -0.05, 0.6, F + TH + 13.5, 0.05);
  b.box('woodRaw', -ts / 2 + T, F + TH - 6.2, -ts / 2 + T, ts / 2 - T, F + TH - 6, ts / 2 - T, 'wood');
  b.pop();
  // pews, altar, lamps
  for (let i = 0; i < 8; i++) for (const s of [1, -1]) b.box('wood', -w / 2 + 4 + i * 2, F, s * 1.1, -w / 2 + 4.45 + i * 2, F + 0.9, s * 4.8, 'wood');
  b.box('stucco', -w / 2 + 1.2, F, -1.4, -w / 2 + 2.4, F + 1.05, 1.4, 'concrete');
  B.fixture(-5, F + H - 0.2, 0, 'pendant');
  B.fixture(5, F + H - 0.2, 0, 'pendant');
  B.steps(tx + ts / 2, 0, 1, 0, 2.2, F);
  B.steps(-w / 2 + 3 + 2 * ((w - 6) / 4) + 2.4, d / 2 + 0.1, 0, 1, 2.0, F);
  B.link(tx + ts / 2 + 2, F, 0, tx, F, 0);
  B.link(tx, F, 0, w / 2 - 3, F, 0);
  B.point(0, F, 0);
  void def;
}

/** Fjellstua: the summit café, glazed on the view side, with a terrace and railings. */
export function cafe(B: Buildings, def: BuildingDef) {
  const b = B.b;
  const w = def.w ?? 20, d = def.d ?? 10, H = 3.6, T = 0.25, F = 0.5;
  b.box('granite', -w / 2 - 0.1, -3, -d / 2 - 0.1, w / 2 + 0.1, F, d / 2 + 0.1, 'rock');
  b.box('floorInt', -w / 2 + T, F - 0.02, -d / 2 + T, w / 2 - T, F + 0.01, d / 2 - T, 'woodFloor');
  // the view side (+z): floor-to-ceiling glazing in a timber frame
  const glaze: Op[] = [];
  for (let x = -w / 2 + 1.6; x < w / 2 - 1.4; x += 2.2) glaze.push({ x, w: 1.9, y0: F + 0.5, y1: F + 3.1 });
  const door = { x: w / 2 - 1.6, w: 1.2, y0: F, y1: F + 2.4 };
  const front = glaze.filter((g) => Math.abs(g.x - door.x) > 1.6).concat([door]);
  b.wall('woodRaw', -w / 2, w / 2, d / 2 - T / 2, T, F, F + H, front, 'wood', 'wallInt');
  for (const o of front) if (o.y0 > F + 0.1) B.windowFrame(o.x, o.y0, o.y1, o.w, d / 2, 1, true, false);
  b.push([0, 0, -d / 2 + T / 2], Math.PI);
  const back: Op[] = [{ x: 3, w: 1.1, y0: F, y1: F + 2.3 }, { x: -3, w: 1.2, y0: F + 1.0, y1: F + 2.3 }];
  b.wall('woodRaw', -w / 2, w / 2, 0, T, F, F + H, back, 'wood', 'wallInt');
  B.windowFrame(3, F + 1.0, F + 2.3, 1.2, T / 2, 1, true, true);
  b.pop();
  for (const sx of [-1, 1]) {
    b.push([sx * (w / 2 - T / 2), 0, 0], (sx * Math.PI) / 2);
    b.wall('woodRaw', -d / 2 + T, d / 2 - T, 0, T, F, F + H, [{ x: 0, w: 1.6, y0: F + 0.9, y1: F + 2.6 }], 'wood', 'wallInt');
    B.windowFrame(0, F + 0.9, F + 2.6, 1.6, T / 2, 1, true, true);
    b.pop();
  }
  // flat roof with a deep overhang over the terrace
  b.box('roofMetal', -w / 2 - 0.6, F + H, -d / 2 - 0.6, w / 2 + 0.6, F + H + 0.35, d / 2 + 2.6, 'metal');
  b.box('wallInt', -w / 2 + T, F + H - 0.05, -d / 2 + T, w / 2 - T, F + H, d / 2 - T);
  for (const x of [-w / 2 - 0.3, -w / 4, 0, w / 4, w / 2 + 0.3]) b.cyl('steel', x, F, d / 2 + 2.3, 0.08, H, 8, 'metal');
  // terrace deck and railing on the view side
  b.box('planks', -w / 2 - 1, F - 0.12, d / 2, w / 2 + 1, F, d / 2 + 6, 'wood');
  b.box('stone', -w / 2 - 1, -3, d / 2 + 0.2, w / 2 + 1, F - 0.12, d / 2 + 6, 'rock');
  for (let x = -w / 2 - 1; x <= w / 2 + 1 + 1e-3; x += 1.4) b.box('steel', x - 0.03, F, d / 2 + 5.9, x + 0.03, F + 1.05, d / 2 + 5.96);
  b.box('wood', -w / 2 - 1, F + 1.0, d / 2 + 5.85, w / 2 + 1, F + 1.08, d / 2 + 6.02, 'wood');
  b.box(null, -w / 2 - 1, F, d / 2 + 5.85, w / 2 + 1, F + 1.1, d / 2 + 6.02, 'metal');
  // tables and chairs on the terrace; coin binoculars at the rail
  for (let i = 0; i < 5; i++) {
    const x = -w / 2 + 2 + i * (w - 3) / 4, z = d / 2 + 3.6;
    b.cyl('steel', x, F, z, 0.05, 0.72, 6);
    b.cyl('white', x, F + 0.72, z, 0.45, 0.04, 14, 'metal');
    for (const s of [-1, 1]) b.box('steel', x + s * 0.75 - 0.2, F, z - 0.2, x + s * 0.75 + 0.2, F + 0.45, z + 0.2);
  }
  for (const x of [-4, 6]) {
    b.cyl('steel', x, F, d / 2 + 5.4, 0.07, 1.1, 8, 'metal');
    b.box('yellowSteel', x - 0.25, F + 1.1, d / 2 + 5.2, x + 0.25, F + 1.4, d / 2 + 5.6);
  }
  // inside: counter and tables
  b.box('wood', -w / 2 + 0.6, F, -d / 2 + 0.6, -w / 2 + 6, F + 1.05, -d / 2 + 1.3, 'wood');
  for (let i = 0; i < 4; i++) b.box('wood', -4 + i * 3.2 - 0.5, F + 0.72, 1.2 - 0.5, -4 + i * 3.2 + 0.5, F + 0.76, 1.2 + 0.5, 'wood');
  B.fixture(-4, F + H - 0.05, 0, 'pendant');
  B.fixture(4, F + H - 0.05, 0, 'pendant');
  B.link(door.x, F, d / 2 + 2.5, door.x, F, d / 2 - 1.2);
  B.link(3, F, -d / 2 - 2.0, 3, F, -d / 2 + 1.2);
  B.point(0, F, 0);
  B.point(0, F, d / 2 + 3);
}

/** Molja: the little red lighthouse at the end of the breakwater. */
export function molja(B: Buildings) {
  const b = B.b;
  b.cyl('concrete', 0, -6, 0, 3.4, 6.4, 16, 'concrete');
  b.cyl('j_deepred', 0, 0.4, 0, 1.5, 7.5, 16, 'concrete', 1.3);
  b.cyl('stucco', 0, 3.6, 0, 1.48, 0.35, 16);
  b.box('door', -0.45, 0.4, 1.38, 0.45, 2.4, 1.5);
  b.cyl('iron', 0, 7.9, 0, 1.9, 0.12, 16, 'metal');
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    b.box('iron', Math.cos(a) * 1.8 - 0.02, 8.0, Math.sin(a) * 1.8 - 0.02, Math.cos(a) * 1.8 + 0.02, 9.0, Math.sin(a) * 1.8 + 0.02);
  }
  b.cyl('jglassLit', 0, 8.0, 0, 0.9, 1.4, 12);
  b.cyl('j_deepred', 0, 9.4, 0, 1.1, 0.2, 12);
  const cap = new THREE.ConeGeometry(1.1, 0.9, 12);
  b.addGeo('j_deepred', cap, new THREE.Matrix4().setPosition(0, 10.05, 0));
  b.cyl('iron', 0, 10.5, 0, 0.04, 0.8, 6);
  B.fixtures.push({ p: new THREE.Vector3(0, 8.7, 0).applyMatrix4(b.m), color: 0xff4030, intensity: 14, dist: 30, flicker: 'beacon' });
}
