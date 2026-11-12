import * as THREE from 'three';
import { HELD_ITEMS } from './SoldierAnim';

/**
 * Small, cheap stand-ins for the equipment in a third-person soldier's hand (Update 31), so you can
 * read what someone is about to throw / place / set off: an olive frag, a black sticky, a pale
 * smoke can, the C4 brick, the clacker with its blinking light... Shared geometry and materials;
 * one prop object per soldier, rebuilt only when the item changes.
 */
const mat = (c: number, r = 0.6, m = 0.2) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
let M: Record<string, THREE.Material> | null = null;
function mats() {
  return (M ??= {
    olive: mat(0x4a5236, 0.55, 0.25), black: mat(0x18191b, 0.5, 0.3), steel: mat(0x8a8d90, 0.35, 0.9), grey: mat(0x3c4046, 0.5, 0.5),
    green: mat(0x2f3a2c, 0.5, 0.4), pale: mat(0x5c6150, 0.5, 0.4), tan: mat(0x9a8a68, 0.7, 0.05), c4: mat(0x5a6040, 0.45, 0.05),
    yellow: mat(0xd8b020, 0.5, 0.1), white: mat(0xe0e0e0, 0.6, 0.1), orange: mat(0xd86a20, 0.5, 0.1),
    led: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.3, 0.2), toneMapped: false }),
    blue: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.8, 2.2), toneMapped: false }),
    spark: new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 3.2, 0.9), toneMapped: false, transparent: true }),
  });
}
const cyl = (r: number, h: number, m: THREE.Material, y = 0) => {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), m);
  o.position.y = y;
  return o;
};
const box = (x: number, y: number, z: number, m: THREE.Material, py = 0) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), m);
  o.position.y = py;
  return o;
};

function build(item: string): THREE.Group {
  const m = mats();
  const g = new THREE.Group();
  switch (item) {
    case 'frag': {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), m.olive);
      b.scale.y = 1.2;
      g.add(b, cyl(0.011, 0.02, m.steel, 0.045));
      break;
    }
    case 'sticky': g.add(cyl(0.026, 0.06, m.black), cyl(0.027, 0.012, m.yellow, 0.006)); break;
    case 'flash': g.add(cyl(0.023, 0.09, m.grey), cyl(0.024, 0.01, m.white, 0.03), cyl(0.01, 0.02, m.steel, 0.055)); break;
    case 'stun': g.add(cyl(0.023, 0.09, m.green), cyl(0.024, 0.01, m.yellow, 0.03), cyl(0.01, 0.02, m.steel, 0.055)); break;
    case 'smoke': g.add(cyl(0.027, 0.115, m.pale), cyl(0.028, 0.03, m.white), cyl(0.01, 0.02, m.steel, 0.068)); break;
    case 'snapshot': g.add(cyl(0.031, 0.05, m.black), cyl(0.032, 0.008, m.blue)); break;
    case 'decoy': g.add(cyl(0.023, 0.1, m.tan), cyl(0.024, 0.006, m.orange, 0.035)); break;
    case 'c4': g.add(box(0.11, 0.035, 0.056, m.c4), box(0.03, 0.014, 0.022, m.grey, 0.024)); break;
    case 'tknife': {
      g.add(box(0.012, 0.09, 0.003, m.steel, 0.05), box(0.016, 0.07, 0.01, m.black, -0.03));
      break;
    }
    case 'claymore': {
      const b = box(0.2, 0.11, 0.035, m.olive);
      g.add(b);
      break;
    }
    case 'stim': g.add(cyl(0.011, 0.13, m.white), cyl(0.012, 0.03, m.orange, 0.03)); break;
    case 'detonator': {
      g.add(box(0.038, 0.1, 0.026, m.black), cyl(0.0025, 0.05, m.black, 0.07));
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 4), m.led);
      l.name = 'led';
      l.position.set(0, 0.04, 0.014);
      g.add(l);
      break;
    }
    case 'trophy': g.add(box(0.2, 0.22, 0.2, m.grey)); break;
  }
  // the fuse spark of a cooking frag
  const sp = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), m.spark);
  sp.name = 'spark';
  sp.position.y = 0.06;
  sp.visible = false;
  g.add(sp);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = false;
  });
  return g;
}

const cache = new Map<string, THREE.Group>();
/** a fresh prop for an item code (HELD_ITEMS index, the cooking bit is ignored) */
export function heldProp(code: number): THREE.Group | null {
  const item = HELD_ITEMS[code & 31];
  if (!item) return null;
  let proto = cache.get(item);
  if (!proto) cache.set(item, (proto = build(item)));
  const g = proto.clone();
  // a touch larger than life so it reads at fighting distances
  g.scale.setScalar(1.3);
  g.userData.item = item;
  return g;
}
