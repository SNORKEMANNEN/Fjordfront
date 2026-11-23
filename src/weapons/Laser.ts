import * as THREE from 'three';
import { rbox } from './ModelKit';

/**
 * Rail-mounted IR aiming laser / illuminator (a generic boxy aiming module, coyote tan) for the
 * night-vision loadouts. Mounted at 3 o'clock so the gun can be canted over to aim with it under
 * goggles. Adds a `laser` socket at the aiming aperture, pointing down the bore (-Z).
 *
 * u = metres forward of the receiver origin, v = up, w = right (weapon space, as ModelKit).
 */
let tan: THREE.MeshStandardMaterial | null = null;
let lensMat: THREE.MeshStandardMaterial | null = null;

export function addLaser(root: THREE.Group, sockets: Record<string, THREE.Object3D>, mats: Record<string, THREE.Material>, u0: number, v: number, w0: number) {
  tan ??= new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.72, metalness: 0.05 });
  lensMat ??= new THREE.MeshStandardMaterial({ color: 0x0c1012, roughness: 0.06, metalness: 0.6, emissive: new THREE.Color(0x0a0f0c), emissiveIntensity: 1 });
  const g = new THREE.Group();
  g.name = 'irLaser';
  const L = 0.088, H = 0.03, Wd = 0.03;
  const u1 = u0 + L;
  const wc = w0 + Wd / 2 + 0.004;
  const add = (geo: THREE.BufferGeometry, m: THREE.Material) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  // rail clamp + thumb screw against the gun
  add(rbox(u0 + 0.02, u0 + 0.06, v - 0.011, v + 0.011, w0 - 0.002, w0 + 0.006, 0.0015), mats.metal ?? tan);
  add(new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 12).rotateZ(Math.PI / 2).translate(w0 + 0.003, v - 0.013, -(u0 + 0.04)), mats.steel ?? tan);
  // body: rounded box with a shallow top ridge and a rear cable port
  add(rbox(u0, u1, v - H / 2, v + H / 2, w0 + 0.004, w0 + 0.004 + Wd, 0.0045), tan);
  add(rbox(u0 + 0.012, u1 - 0.016, v + H / 2 - 0.001, v + H / 2 + 0.003, wc - 0.008, wc + 0.008, 0.0015), tan);
  add(rbox(u0 - 0.006, u0 + 0.002, v - 0.006, v + 0.004, wc - 0.005, wc + 0.005, 0.002), mats.rubber ?? tan);
  // activation buttons + mode selector on top
  for (const du of [0.026, 0.044]) add(rbox(u0 + du, u0 + du + 0.012, v + H / 2 + 0.003, v + H / 2 + 0.0055, wc - 0.004, wc + 0.004, 0.0012), mats.rubber ?? tan);
  add(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 16).translate(wc, v + H / 2 + 0.004, -(u0 + 0.066)), mats.dark ?? tan);
  // front face: big illuminator lens (with focus ring) above the small aiming aperture
  add(new THREE.CylinderGeometry(0.0085, 0.0085, 0.008, 20).rotateX(Math.PI / 2).translate(wc, v + 0.005, -(u1 + 0.002)), mats.dark ?? tan);
  const big = add(new THREE.CylinderGeometry(0.007, 0.007, 0.002, 20).rotateX(Math.PI / 2).translate(wc, v + 0.005, -(u1 + 0.0065)), lensMat);
  const small = add(new THREE.CylinderGeometry(0.0038, 0.0038, 0.004, 16).rotateX(Math.PI / 2).translate(wc, v - 0.008, -(u1 + 0.003)), lensMat);
  big.name = 'irLens';
  small.name = 'irAperture';
  root.add(g);
  const s = new THREE.Object3D();
  s.name = 'laser';
  s.position.set(wc, v - 0.008, -(u1 + 0.005));
  root.add(s);
  sockets.laser = s;
  return g;
}

/**
 * Weapon light (Update 46): a compact LED flashlight on the left of the handguard, opposite the
 * IR laser — the side you see in first person. Tail cap with a pressure switch, a knurled bezel,
 * a reflector and the lens (named 'wlLens', its material swapped per viewmodel so only your own
 * light glows). Adds a `light` socket on the lens, pointing down the bore. Guns without the laser
 * rail (the pistols, the knife) get none.
 */
let wlBody: THREE.MeshStandardMaterial | null = null;
let wlLens: THREE.MeshStandardMaterial | null = null;
export function addWeaponLight(root: THREE.Group, sockets: Record<string, THREE.Object3D>, mats: Record<string, THREE.Material>) {
  const ls = sockets.laser;
  if (!ls || sockets.light) return null;
  wlBody ??= new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.42, metalness: 0.7 });
  wlLens ??= new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.05, metalness: 0.2, emissive: new THREE.Color(0xfff4e0), emissiveIntensity: 0, envMapIntensity: 2 });
  const u1 = -ls.position.z - 0.005;
  const u0 = u1 - 0.092;
  const v = ls.position.y + 0.008;
  const wc = -(ls.position.x - 0.004);
  const g = new THREE.Group();
  g.name = 'weaponLight';
  const along = (r0: number, r1: number, a: number, b: number, seg = 18) => new THREE.CylinderGeometry(r1, r0, b - a, seg).rotateX(-Math.PI / 2).translate(wc, v, -(a + (b - a) / 2));
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, name = '') => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    if (name) mesh.name = name;
    g.add(mesh);
    return mesh;
  };
  // mount: a clamp from the body to the handguard
  add(new THREE.BoxGeometry(0.012, 0.012, 0.03).translate(wc + 0.012, v, -(u0 + 0.045)), mats.metal ?? wlBody);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.005, 10).rotateZ(Math.PI / 2).translate(wc + 0.016, v - 0.009, -(u0 + 0.045)), mats.steel ?? wlBody);
  // tail cap + rubber switch, body, cooling fins, bezel, reflector ring, lens
  add(along(0.0098, 0.0104, u0, u0 + 0.012), wlBody);
  add(along(0.0062, 0.0062, u0 - 0.004, u0, 14), mats.rubber ?? wlBody);
  add(along(0.0108, 0.0108, u0 + 0.012, u0 + 0.07), wlBody);
  for (let i = 0; i < 4; i++) add(along(0.0119, 0.0119, u0 + 0.05 + i * 0.006, u0 + 0.053 + i * 0.006), wlBody);
  add(along(0.0118, 0.0142, u0 + 0.07, u0 + 0.088, 22), wlBody);
  add(along(0.0142, 0.0142, u0 + 0.088, u0 + 0.096, 22), wlBody);
  add(along(0.0122, 0.0122, u0 + 0.0955, u0 + 0.0965, 22), mats.steel ?? wlBody);
  add(along(0.0116, 0.0116, u0 + 0.0962, u0 + 0.0968, 22), wlLens, 'wlLens');
  root.add(g);
  const s = new THREE.Object3D();
  s.name = 'light';
  s.position.set(wc, v, -(u0 + 0.098));
  root.add(s);
  sockets.light = s;
  return g;
}
