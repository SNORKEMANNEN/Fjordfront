import * as THREE from 'three';
import { addLaser } from './Laser';
import { PartBuilder, profile, cyl, lathe, rbox, picatinny, pin, bez, socket, P2 } from './ModelKit';
import { MaterialLib, patchSurfaceMaterial } from '../render/Materials';

export interface WeaponModel {
  root: THREE.Group;
  parts: Record<string, THREE.Object3D>;
  sockets: Record<string, THREE.Object3D>;
  /** distance from eye to the sight point when aiming */
  adsDist: number;
  scopeLens?: THREE.Mesh;
  reticle?: THREE.Object3D;
  /** where the support hand holds a fresh magazine (mag space); default suits AR-style mags */
  magGrip?: THREE.Vector3;
  /** weapon offset/rotation at the peak of a magazine reload (defaults suit AR-style magwells) */
  reloadPose?: { p: [number, number, number]; r: [number, number, number] };
}

export type WeaponMats = Record<string, THREE.Material>;

export function makeWeaponMaterials(L: MaterialLib): WeaponMats {
  const gm = L.surface('gunMetal');
  const poly = L.surface('polymer');
  const metal = L.std('gunMetal', { metalness: 0.72, roughness: 1.0, tile: 0.18, envMapIntensity: 1.1 }, 'w.metal');
  const steel = L.std('gunMetal', { metalness: 0.92, roughness: 0.8, tile: 0.12, color: 0x9a9a9a, envMapIntensity: 1.2 }, 'w.steel');
  const polymer = L.std('polymer', { metalness: 0.0, roughness: 1.0, tile: 0.12, envMapIntensity: 0.9 }, 'w.poly');
  const tan = new THREE.MeshStandardMaterial({ color: 0x8c7a5c, roughness: 0.62, metalness: 0.05, normalMap: poly.normal, envMapIntensity: 0.8 });
  tan.normalScale.set(0.6, 0.6);
  patchSurfaceMaterial(tan, 1 / 0.12);
  const tanMetal = new THREE.MeshStandardMaterial({ color: 0x7d6e55, roughness: 0.48, metalness: 0.35, normalMap: gm.normal, envMapIntensity: 1 });
  patchSurfaceMaterial(tanMetal, 1 / 0.18);
  // matte black glass-filled polymer (MP7 housing)
  const blackPoly = new THREE.MeshStandardMaterial({ color: 0x232527, roughness: 0.72, metalness: 0.06, normalMap: poly.normal, envMapIntensity: 0.75 });
  blackPoly.normalScale.set(0.35, 0.35);
  patchSurfaceMaterial(blackPoly, 1 / 0.3);
  const odGreen = new THREE.MeshStandardMaterial({ color: 0x4a4d3a, roughness: 0.6, metalness: 0.1, normalMap: poly.normal });
  patchSurfaceMaterial(odGreen, 1 / 0.12);
  return {
    default: metal,
    metal,
    steel,
    polymer,
    tan,
    tanMetal,
    od: odGreen,
    blackPoly,
    dark: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, metalness: 0.2 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc29a4e, roughness: 0.28, metalness: 1.0 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xb06a3c, roughness: 0.3, metalness: 1.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, metalness: 0 }),
    walnut: new THREE.MeshStandardMaterial({ color: 0x4a2a17, roughness: 0.48, metalness: 0.0, normalMap: poly.normal, envMapIntensity: 0.9 }),
    blued: new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.32, metalness: 0.9, normalMap: gm.normal, envMapIntensity: 1.3 }),
    stainless: new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.3, metalness: 1.0, normalMap: gm.normal, envMapIntensity: 1.4 }),
    sightOrange: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.55, 0.08), toneMapped: false }),
    shell: new THREE.MeshStandardMaterial({ color: 0x8a1b14, roughness: 0.45, metalness: 0 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x9fd8d0, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.16, envMapIntensity: 2.4,
      iridescence: 0.8, iridescenceIOR: 1.6, depthWrite: false,
    }),
    glassDark: new THREE.MeshPhysicalMaterial({ color: 0x0c1418, roughness: 0.05, metalness: 0.4, envMapIntensity: 2.2, iridescence: 0.6 }),
    reticle: new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.25, 0.12), toneMapped: false, depthWrite: false, transparent: true }),
    tritium: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.4, 0.5), toneMapped: false }),
    white: new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5 }),
  };
}

/** Rotate a geometry around the barrel axis (at height v) by angle a. */
function aroundBore(g: THREE.BufferGeometry, v: number, a: number) {
  g.translate(0, -v, 0);
  g.rotateZ(a);
  g.translate(0, v, 0);
  return g;
}


/**
 * Grip-surface hand sockets. Positions are points on the *grip axis* (pistol-grip centre line,
 * handguard bore axis) and userData.r is that grip's radius toward the palm; the viewmodel puts
 * the palm of the rigged hand on the surface and solves the wrist from there.
 *  right: [u, v, roll, r]   roll tilts the knuckle line with the grip rake
 *  left:  [u, v, r, roll, yaw, pitch]   roll < 0 = hand under the handguard, palm up-right;
 *         yaw < 0 = fingers angled across to the right; pitch < 0 = fingers rising toward the muzzle
 */
function grips(root: THREE.Group, right: [number, number, number, number], left: [number, number, number, number, number, number] | LeftGrip) {
  const rs = new THREE.Object3D();
  rs.name = 'rightHand';
  rs.position.set(0, right[1], -right[0]);
  rs.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), right[2]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2));
  rs.userData.r = right[3];
  root.add(rs);
  const ls = new THREE.Object3D();
  ls.name = 'leftHand';
  if (Array.isArray(left)) {
    ls.position.set(0, left[1], -left[0]);
    ls.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 - left[3]);
    ls.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -left[5]));
    ls.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), left[4]));
    ls.userData.r = left[2];
  } else {
    // explicit frame: fingers direction + palm normal (pointing from the palm toward the grip axis)
    ls.position.set(left.x ?? 0, left.v, -left.u);
    const f = new THREE.Vector3(...left.fingers).normalize();
    const n = new THREE.Vector3(...left.palm);
    n.addScaledVector(f, -n.dot(f)).normalize();
    const Zh = f.clone().negate(), Yh = n.clone().negate();
    const Xh = new THREE.Vector3().crossVectors(Yh, Zh).normalize();
    ls.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xh, Yh, Zh));
    ls.userData.r = left.r;
  }
  root.add(ls);
  return { rs, ls };
}
/** Support-hand grip: point on the handguard axis (u, v), radius r, finger direction & palm normal in weapon space (x right, y up, z back). */
interface LeftGrip { u: number; v: number; r: number; fingers: [number, number, number]; palm: [number, number, number]; x?: number }

function addSockets(root: THREE.Group, list: THREE.Object3D[]) {
  const map: Record<string, THREE.Object3D> = {};
  for (const s of list) {
    root.add(s);
    map[s.name] = s;
  }
  return map;
}

/** Common AR-style pistol grip profile at given offset. */
function pistolGrip(du = 0, dv = 0): P2[] {
  const p: P2[] = [
    [-0.044, -0.008], [-0.05, -0.03], [-0.056, -0.05], [-0.054, -0.062], [-0.06, -0.075], [-0.058, -0.088], [-0.064, -0.1],
    [-0.07, -0.116], [-0.098, -0.122], [-0.104, -0.112], [-0.096, -0.07], [-0.09, -0.035], [-0.084, -0.012], [-0.074, -0.004],
  ];
  return p.map(([u, v]) => [u + du, v + dv] as P2);
}

/**
 * Open mini reflex sight on a riser (the style CoD uses for its default rifle red dots):
 * thin rounded-top hood, big clear window with a faint coating tint, crisp glowing dot inside a
 * thin ring. Returns the optical axis height; the ADS socket goes at the rear of the window.
 */
function reflexSight(b: PartBuilder, u0: number, railTop: number, mats: WeaponMats, root: THREE.Group) {
  const L = 0.044; // housing length
  const winW = 0.0135, winB = railTop + 0.018, winT = railTop + 0.039; // window half-width, bottom, top
  const axis = (winB + winT) / 2;
  // riser mount clamped on the rail, with a cross-bolt
  b.add('metal', rbox(u0 - 0.004, u0 + L + 0.004, railTop, railTop + 0.0095, -0.0125, 0.0125, 0.0015));
  b.add('metal', rbox(u0 + 0.002, u0 + L - 0.002, railTop - 0.003, railTop + 0.002, -0.0128, -0.0108, 0.0008));
  b.add('steel', cyl(0.0022, u0 + 0.012, u0 + 0.014, railTop + 0.004, 0.0132, 10));
  // housing base
  b.add('metal', rbox(u0, u0 + L, railTop + 0.009, winB + 0.001, -winW - 0.0028, winW + 0.0028, 0.0018));
  // hood: rounded-top frame extruded along the axis, front edge chamfered (shorter at the top)
  const frame = new THREE.Shape();
  const fo = 0.0028; // frame thickness
  const W2 = winW + fo, T2 = winT + fo;
  frame.moveTo(-W2, winB);
  frame.lineTo(-W2, T2 - 0.007);
  frame.quadraticCurveTo(-W2, T2, -W2 + 0.007, T2);
  frame.lineTo(W2 - 0.007, T2);
  frame.quadraticCurveTo(W2, T2, W2, T2 - 0.007);
  frame.lineTo(W2, winB);
  frame.lineTo(winW, winB);
  frame.lineTo(winW, winT - 0.0055);
  frame.quadraticCurveTo(winW, winT, winW - 0.0055, winT);
  frame.lineTo(-winW + 0.0055, winT);
  frame.quadraticCurveTo(-winW, winT, -winW, winT - 0.0055);
  frame.lineTo(-winW, winB);
  frame.closePath();
  const hood = new THREE.ExtrudeGeometry(frame, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 10 });
  hood.translate(0, 0, -(u0 + L));
  b.add('metal', hood);
  // rear housing shoulders (low, so the window stays clear) and side buttons, top battery cap
  for (const sgn of [1, -1]) {
    b.add('metal', rbox(u0, u0 + L - 0.012, winB, winB + 0.008, sgn * (winW + 0.0006) - (sgn > 0 ? 0 : 0.0028), sgn * (winW + 0.0006) + (sgn > 0 ? 0.0028 : 0), 0.0012));
    b.add('rubber', rbox(u0 + 0.006, u0 + 0.016, winB - 0.004, winB + 0.003, sgn * (winW + 0.0028) - 0.0012, sgn * (winW + 0.0028) + 0.0012, 0.0008));
  }
  b.add('metal', cyl(0.0045, u0 + 0.004, u0 + 0.016, railTop + 0.012, -winW - 0.004, 16));
  b.add('steel', pin(u0 + 0.03, railTop + 0.013, winW + 0.003, 0.0016));
  // lens: slightly tilted, faint coating; plus a dark rear emitter window
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(winW * 2, winT - winB), mats.glass);
  lens.position.set(0, axis, -(u0 + L - 0.006));
  lens.rotation.x = 0.06;
  root.add(lens);
  // reticle: dot + thin ring (additive, unlit, glows with bloom)
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff';
  x.strokeStyle = '#fff';
  x.beginPath(); x.arc(64, 64, 7, 0, Math.PI * 2); x.fill();
  x.lineWidth = 3.5;
  x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const rm = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(7, 0.35, 0.2), transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
  const ret = new THREE.Mesh(new THREE.PlaneGeometry(0.0075, 0.0075), rm);
  ret.position.set(0, axis, -(u0 + L - 0.0065));
  ret.renderOrder = 10;
  root.add(ret);
  return { axis, rear: u0 };
}

/**
 * Optic glass: almost perfectly clear through the middle (you look *through* it, nothing is
 * painted on it), with an anti-reflection coating that only shows as a faint amber/violet sheen
 * toward the rim and at grazing angles, plus a soft sky reflection.
 */
function coatedGlass(strength = 1) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uK: { value: strength } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uK; varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){
        float ndv = abs(dot(normalize(vN), normalize(vV)));
        float fres = pow(1.0 - ndv, 3.0);
        float r = length(vUv - 0.5) * 2.0;
        float rim = smoothstep(0.55, 1.0, r);
        vec3 coat = mix(vec3(1.0, 0.55, 0.2), vec3(0.55, 0.4, 1.0), smoothstep(0.6, 1.0, r));
        vec3 sky = mix(vec3(0.55, 0.62, 0.7), vec3(0.9), smoothstep(-0.2, 0.8, vN.y));
        float a = (0.015 + fres * 0.45 + rim * 0.06) * uK;
        gl_FragColor = vec4(mix(sky, coat, 0.5 + 0.5 * rim) * (0.6 + fres), a);
      }`,
  });
}

/**
 * Collimated red dot on the rear lens: the dot is drawn where the view ray lines up with the
 * sight axis (it sits "at infinity"), so it stays on target however the head moves, appears only
 * when you look through the sight, and stays a crisp 2 MOA-ish dot with a small glow (it blooms).
 */
function collimatedDot() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: { uCol: { value: new THREE.Color(9.0, 0.35, 0.12) } },
    vertexShader: /* glsl */ `varying vec3 vRay; varying vec3 vAxis; varying vec3 vN; varying vec2 vUv;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vRay = mv.xyz;
        vAxis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz); vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uCol; varying vec3 vRay; varying vec3 vAxis; varying vec3 vN; varying vec2 vUv;
      void main(){
        float c = clamp(dot(normalize(vRay), normalize(vAxis)), -1.0, 1.0);
        float ang = acos(c);
        float core = smoothstep(0.0032, 0.0018, ang);
        float glow = exp(-ang * ang / (0.0075 * 0.0075)) * 0.3;
        float r = length(vUv - 0.5) * 2.0;
        float vign = 1.0 - smoothstep(0.82, 1.0, r);
        // the glass itself: nearly invisible, a touch of coating toward the rim
        float ndv = abs(dot(normalize(vN), -normalize(vRay)));
        float fres = pow(1.0 - ndv, 3.0);
        vec3 coat = mix(vec3(1.0, 0.6, 0.25), vec3(0.6, 0.45, 1.0), r);
        float ga = 0.012 + fres * 0.3 + smoothstep(0.7, 1.0, r) * 0.05;
        vec3 col = coat * 0.5 * ga + uCol * (core + glow);
        gl_FragColor = vec4(col, clamp(ga + (core + glow) * vign, 0.0, 1.0));
      }`,
  });
}

function redDot(b: PartBuilder, u0: number, railTop: number, mats: WeaponMats, root: THREE.Group) {
  const axis = railTop + 0.038;
  b.add('metal', rbox(u0 + 0.002, u0 + 0.05, railTop, railTop + 0.012, -0.012, 0.012, 0.002));
  b.add('metal', rbox(u0 + 0.012, u0 + 0.042, railTop + 0.008, axis - 0.0146, -0.009, 0.009, 0.003));
  // tube body with hood
  b.add('metal', lathe([[u0, 0.0138], [u0, 0.0158], [u0 + 0.004, 0.0165], [u0 + 0.052, 0.0165], [u0 + 0.058, 0.018], [u0 + 0.062, 0.018], [u0 + 0.062, 0.0145], [u0 + 0.004, 0.0138], [u0, 0.0138]], axis, 0, 28));
  // turrets
  b.add('metal', cyl(0.0075, u0 + 0.026, u0 + 0.040, axis + 0.0225, 0, 14));
  b.add('metal', rbox(u0 + 0.024, u0 + 0.042, axis + 0.0148, axis + 0.024, -0.0085, 0.0085, 0.004));
  b.add('metal', rbox(u0 + 0.024, u0 + 0.042, axis - 0.008, axis + 0.008, 0.0148, 0.024, 0.004));
  // lenses: clear coated glass (only a faint tint at grazing angles) and a collimated dot
  const lensR = 0.0138;
  const front = new THREE.Mesh(new THREE.CircleGeometry(lensR, 32), coatedGlass(0.9));
  front.position.set(0, axis, -(u0 + 0.05));
  front.renderOrder = 9;
  const rear = new THREE.Mesh(new THREE.CircleGeometry(lensR, 32), collimatedDot());
  rear.position.set(0, axis, -(u0 + 0.006));
  rear.rotation.y = Math.PI;
  rear.renderOrder = 10;
  root.add(front, rear);
  return axis;
}


// ======================================================================
// K416 carbine (AR platform, 5.56)
// ======================================================================
/** Curved polymer STANAG 30-rounder (K416, KS-17): origin at the feed lips / magwell top. */
function stanagMag(mats: WeaponMats) {
  const mb = new PartBuilder();
  const front = bez([0.1 - 0.066, 0.0], [0.105 - 0.066, -0.09], [0.128 - 0.066, -0.19], 8);
  const rear = bez([0.069 - 0.066, -0.186], [0.044 - 0.066, -0.09], [0.034 - 0.066, 0.0], 8);
  mb.add('polymer', profile([...front, ...rear], 0.024, { round: 0.003, bevel: 0.003 }));
  mb.add('polymer', profile([[0.054, -0.18], [0.068, -0.196], [0.004, -0.2], [-0.004, -0.188]], 0.027, { round: 0.003, bevel: 0.003 }));
  for (let i = 0; i < 4; i++) {
    const t = 0.25 + i * 0.16;
    const v = -0.19 * t;
    const uc = -0.03 + 0.02 * t * t + 0.03 * t;
    mb.add('polymer', rbox(uc, uc + 0.05, v - 0.004, v, 0.0115, 0.0135, 0.001));
    mb.add('polymer', rbox(uc, uc + 0.05, v - 0.004, v, -0.0135, -0.0115, 0.001));
  }
  mb.add('brass', cyl(0.0048, -0.024, 0.02, 0.004, 0.0, 10));
  mb.add('copper', lathe([[0.02, 0.0], [0.02, 0.0048], [0.026, 0.004], [0.034, 0.0]], 0.004, 0, 10));
  return mb.build(mats, 'mag');
}

export function buildCarbine(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'K416';
  const b = new PartBuilder();
  const bore = 0.043;
  // --- upper receiver ---
  b.add('metal', profile([[-0.125, 0.021], [-0.125, 0.061], [-0.119, 0.067], [0.137, 0.067], [0.141, 0.062], [0.141, 0.024], [0.12, 0.021]], 0.03, { bevel: 0.0018, round: 0.002 }));
  // ejection port recess + forward assist + brass deflector
  b.add('dark', rbox(-0.03, 0.062, 0.033, 0.057, 0.0135, 0.0153, 0.001));
  b.add('metal', rbox(-0.036, -0.026, 0.046, 0.066, 0.015, 0.024, 0.002));
  b.add('metal', cyl(0.0065, -0.092, -0.06, 0.049, 0.021, 16));
  b.add('metal', cyl(0.0075, -0.078, -0.064, 0.049, 0.026, 16));
  b.add('metal', rbox(-0.07, -0.04, 0.02, 0.026, -0.0156, 0.0156, 0.001));
  // upper top rail
  for (const g of picatinny(-0.119, 0.137, 0.067)) b.add('metal', g);
  // --- lower receiver ---
  b.add('metal', profile([[-0.106, 0.022], [0.104, 0.022], [0.104, 0.0], [0.1, -0.047], [0.032, -0.047], [0.03, -0.013], [-0.036, -0.013], [-0.062, -0.018], [-0.104, -0.004], [-0.112, 0.012]], 0.028, { bevel: 0.0016, round: 0.002 }));
  b.add('metal', rbox(0.028, 0.106, -0.054, -0.036, -0.0165, 0.0165, 0.003)); // flared magwell
  // trigger guard
  b.add('metal', profile([[-0.04, -0.03], [0.03, -0.03], [0.034, -0.026], [0.034, -0.014], [0.029, -0.014], [0.028, -0.025], [-0.036, -0.025], [-0.04, -0.017]], 0.011, { bevel: 0.0012 }));
  // takedown pins, selector, mag release, bolt catch
  b.add('steel', pin(-0.088, 0.012, 0.0145, 0.0028));
  b.add('steel', pin(0.088, 0.012, 0.0145, 0.0028));
  b.add('steel', pin(-0.088, 0.012, -0.0145, 0.0028));
  b.add('metal', rbox(-0.068, -0.05, 0.004, 0.012, -0.0175, -0.0145, 0.001));
  b.add('metal', cyl(0.0042, -0.06, -0.058, 0.008, -0.016, 10));
  b.add('metal', rbox(0.01, 0.022, -0.008, 0.002, 0.0142, 0.018, 0.0012));
  b.add('metal', rbox(0.036, 0.06, 0.004, 0.016, -0.0172, -0.0142, 0.0012));
  // --- pistol grip ---
  b.add('polymer', profile(pistolGrip(), 0.03, { round: 0.008, bevel: 0.004 }));
  // --- handguard (free-float, octagonal) ---
  {
    const hg = new THREE.CylinderGeometry(0.0255, 0.0255, 0.345, 8, 1, false);
    hg.rotateY(Math.PI / 8);
    hg.rotateX(-Math.PI / 2);
    hg.translate(0, bore, -(0.141 + 0.345 / 2));
    b.add('metal', hg);
    // M-LOK slots on 3 faces
    for (let i = 0; i < 5; i++) {
      const u = 0.17 + i * 0.058;
      for (const a of [Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * 0.75, -Math.PI * 0.75]) {
        const s = rbox(u, u + 0.032, bore + 0.0225, bore + 0.0245, -0.0035, 0.0035, 0.0012);
        b.add('dark', aroundBore(s, bore, a));
      }
    }
    // barrel nut ring + top rail along handguard
    b.add('metal', cyl(0.0225, 0.137, 0.148, bore, 0, 24));
    for (const g of picatinny(0.148, 0.48, bore + 0.0234)) b.add('metal', g);
    // QD sling cup
    b.add('steel', cyl(0.006, 0.16, 0.17, bore - 0.024, -0.016, 12));
  }
  // --- barrel, gas block, flash hider ---
  b.add('steel', cyl(0.0094, 0.14, 0.535, bore, 0, 20));
  b.add('metal', lathe([[0.53, 0.0], [0.53, 0.011], [0.536, 0.0118], [0.588, 0.0118], [0.592, 0.0105], [0.592, 0.006], [0.586, 0.0062], [0.586, 0.0]], bore, 0, 28));
  for (let i = 0; i < 4; i++) {
    const s = rbox(0.55, 0.585, bore + 0.009, bore + 0.0122, -0.0018, 0.0018, 0.0008);
    b.add('dark', aroundBore(s, bore, i * (Math.PI / 2) + Math.PI / 4));
  }
  // --- buffer tube & stock ---
  b.add('metal', cyl(0.0148, -0.33, -0.12, bore + 0.002, 0, 20));
  b.add('steel', cyl(0.0175, -0.132, -0.124, bore + 0.002, 0, 12));
  b.add('polymer', profile([[-0.214, 0.03], [-0.214, 0.064], [-0.236, 0.069], [-0.34, 0.069], [-0.356, 0.077], [-0.364, 0.072], [-0.37, -0.05], [-0.36, -0.058], [-0.336, -0.052], [-0.29, -0.024], [-0.25, 0.006], [-0.226, 0.018]], 0.037, { round: 0.008, bevel: 0.004 }));
  b.add('rubber', rbox(-0.378, -0.364, -0.06, 0.08, -0.0195, 0.0195, 0.004));
  b.add('steel', cyl(0.006, -0.3, -0.29, -0.03, 0.018, 12));
  // --- moving parts ---
  const pb = new PartBuilder();
  pb.add('steel', rbox(-0.02, 0.058, 0.036, 0.055, 0.0105, 0.0142, 0.0012));
  pb.add('steel', cyl(0.0035, 0.04, 0.05, 0.047, 0.0148, 8)); // bolt face cam pin hint
  const bolt = pb.build(mats, 'bolt');
  const cb = new PartBuilder();
  cb.add('metal', rbox(-0.146, -0.11, 0.06, 0.068, -0.006, 0.006, 0.0015));
  cb.add('metal', profile([[-0.146, 0.06], [-0.138, 0.06], [-0.138, 0.07], [-0.146, 0.07]], 0.042, { bevel: 0.0015, round: 0.002 }));
  const charge = cb.build(mats, 'charge');
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.004, 0.0);
  // magazine (polymer STANAG, curved)
  const mag = stanagMag(mats);
  mag.position.set(0, -0.035, -0.066);
  // optic: compact tube red dot (the earlier sight), with clear glass and a collimated dot
  const sightAxis = redDot(b, 0.045, 0.0715, mats, root);
  // back-up iron front sight (folded) on rail
  b.add('metal', rbox(0.44, 0.465, bore + 0.0234, bore + 0.029, -0.009, 0.009, 0.002));

  root.add(b.build(mats, 'body'), bolt, charge, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.594, bore, 0),
    socket('eject', 0.02, 0.046, 0.02),
    socket('sight', 0.051, sightAxis, 0),
    socket('magWell', 0.066, -0.035, 0),
  ]);
  const { rs, ls } = grips(root, [-0.079, -0.058, -0.25, 0.015], { u: 0.25, v: bore - 0.007, r: 0.0255, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  // IR aiming laser at 3 o'clock on the handguard (night-vision canted aim)
  addLaser(root, sockets, mats, 0.335, bore, 0.0262);
  return { root, parts: { bolt, charge, trigger, mag }, sockets, adsDist: 0.15 };
}

// ======================================================================
// MP7-style PDW (4.6x30). Proportions taken from the side reference at 0.95 mm/px
// (calibrated on the 226 mm sight radius; rail-to-grip height comes out at 173 mm,
// matching the real 169.5 mm). Folded foregrip, magazine in the near-vertical grip,
// solid adjustable stock with a tall butt, wide ribbed T charging handle at the rear,
// hexagonal rear end cap with a QD boss, and the flip-up sights:
//   rear — spring-loaded base block (coil spring visible) carrying a flat leaf with a
//          square notch in the top centre;
//   front — thin post on a base, flanked by low protective ears.
// The ADS socket sits on the notch, level with the post tip, so the irons line up exactly.
// ======================================================================
export function buildMP7(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'MP7';
  const b = new PartBuilder();
  const bore = 0.0195;
  const railV = 0.06, railTop = 0.066;
  const sightV = 0.0895; // notch shoulders = front post tip = line of sight
  const W = 0.0225; // receiver half width
  const rearU = -0.091, frontU = 0.135;

  // ---- receiver: front section (nose) and rear section with a moulded step between them ----
  b.add('blackPoly', profile([
    [0.175, 0.006], [0.175, 0.05], [0.168, 0.055], [0.152, 0.056], [0.148, railV], [0.012, railV], [0.012, -0.0005],
    [0.06, -0.0005], [0.168, 0.0], [0.174, 0.003],
  ], W * 2, { round: 0.004, bevel: 0.0025 }));
  b.add('blackPoly', profile([
    [0.0125, railV], [-0.164, railV], [-0.168, 0.056], [-0.168, 0.004], [-0.16, -0.004], [-0.054, -0.005], [-0.02, -0.004], [0.0125, -0.002],
  ], W * 2 - 0.001, { round: 0.004, bevel: 0.0025 }));
  for (const w of [W, -W]) {
    b.add('dark', rbox(0.0095, 0.0125, 0.002, 0.057, w - 0.0006, w + 0.0006, 0.0004)); // section seam
    // top cooling slots
    b.add('dark', rbox(0.106, 0.135, 0.0505, 0.0545, w - 0.0007, w + 0.0007, 0.0012));
    b.add('dark', rbox(0.026, 0.095, 0.0505, 0.0545, w - 0.0007, w + 0.0007, 0.0012));
    // charging-handle track on the rear section
    b.add('blackPoly', rbox(-0.145, -0.085, 0.029, 0.04, w - 0.0012 * Math.sign(w), w + 0.0022 * Math.sign(w), 0.0015));
    // pins
    b.add('steel', pin(-0.138, 0.0095, w + 0.0005 * Math.sign(w), 0.0026));
    b.add('steel', pin(0.05, 0.004, w + 0.0005 * Math.sign(w), 0.0022));
    // ambidextrous selector (round hub + lever)
    b.add('metal', cyl(0.0062, -0.0215, -0.0165, 0.003, w + 0.002 * Math.sign(w), 16).rotateY(0));
    b.add('metal', rbox(-0.03, -0.012, 0.001, 0.005, w + 0.0012 * Math.sign(w), w + 0.0035 * Math.sign(w), 0.001));
    // short side rail on the nose with six slots
    const sgn = Math.sign(w);
    b.add('metal', rbox(0.073, 0.159, 0.011, 0.03, w, w + 0.0035 * sgn, 0.0008));
    for (let i = 0; i < 6; i++) b.add('dark', rbox(0.08 + i * 0.0135, 0.0865 + i * 0.0135, 0.014, 0.027, w + 0.0028 * sgn - 0.0005, w + 0.0038 * sgn, 0.0004));
    // "SAFE / AUTO" marking plates near the selector
    b.add('dark', rbox(0.02, 0.034, 0.006, 0.01, w + 0.0002 * sgn, w + 0.0007 * sgn, 0.0003));
    b.add('dark', rbox(0.025, 0.036, 0.016, 0.02, w + 0.0002 * sgn, w + 0.0007 * sgn, 0.0003));
  }
  // bolt release lever (left side, above the grip, behind the selector)
  b.add('metal', rbox(-0.012, 0.006, 0.006, 0.011, -W - 0.0028, -W + 0.0004, 0.0012));
  b.add('metal', rbox(0.002, 0.009, 0.0035, 0.0115, -W - 0.0034, -W - 0.0012, 0.001));
  // folded vertical foregrip, flush under the nose
  b.add('blackPoly', rbox(0.07, 0.168, -0.009, 0.0005, -0.016, 0.016, 0.003));
  b.add('dark', rbox(0.162, 0.165, -0.0095, -0.002, -0.0165, 0.0165, 0.0005));
  // top rail, full length
  for (const g of picatinny(-0.145, 0.152, railV, 0, 0.021)) b.add('metal', g);

  // ---- rear end cap: hexagonal plate with a QD boss ----
  {
    const sh = new THREE.Shape();
    sh.moveTo(-W, 0.002); sh.lineTo(W, 0.002); sh.lineTo(W, 0.046); sh.lineTo(W - 0.008, 0.057); sh.lineTo(-W + 0.008, 0.057); sh.lineTo(-W, 0.046); sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 1 });
    g.translate(0, 0, 0.166);
    b.add('metal', g);
    b.add('steel', lathe([[-0.176, 0.0], [-0.176, 0.0052], [-0.1745, 0.0068], [-0.172, 0.0068], [-0.172, 0.0]], 0.03, 0, 24));
    b.add('dark', cyl(0.0032, -0.1765, -0.175, 0.03, 0, 16));
  }
  // ---- wide T charging handle with ribbed tabs ----
  const cb = new PartBuilder();
  cb.add('metal', rbox(-0.18, -0.172, 0.046, 0.057, -0.027, 0.027, 0.0018));
  cb.add('metal', rbox(-0.174, -0.162, 0.048, 0.055, -0.006, 0.006, 0.001));
  for (const sgn of [1, -1]) {
    cb.add('metal', rbox(-0.183, -0.17, 0.045, 0.058, sgn * 0.02 - 0.0075, sgn * 0.02 + 0.0075, 0.002));
    for (let i = 0; i < 5; i++) cb.add('dark', rbox(-0.1835, -0.1825, 0.047, 0.056, sgn * 0.02 - 0.006 + i * 0.003, sgn * 0.02 - 0.0048 + i * 0.003, 0.0002));
  }
  const charge = cb.build(mats, 'charge');

  // ---- trigger guard (thin loop) ----
  b.add('blackPoly', profile([[0.058, 0.0], [0.061, -0.024], [0.054, -0.0285], [0.004, -0.0285], [0.001, -0.022], [0.006, -0.022], [0.008, -0.0245], [0.052, -0.0245], [0.056, -0.021], [0.054, 0.0]], 0.009, { round: 0.002, bevel: 0.0012 }));

  // ---- pistol grip (magazine housing) with a moulded side panel and flared base ----
  b.add('blackPoly', profile([[0.0035, -0.004], [0.0025, -0.05], [0.003, -0.08], [0.0045, -0.088], [0.004, -0.093], [-0.055, -0.093], [-0.0555, -0.085], [-0.0505, -0.078], [-0.051, -0.03], [-0.054, -0.004]], 0.031, { round: 0.007, bevel: 0.003 }));
  for (const w of [0.0157, -0.0157]) {
    b.add('rubber', rbox(-0.045, -0.012, -0.08, -0.026, w - 0.0006, w + 0.0006, 0.004));
    b.add('blackPoly', rbox(-0.04, -0.017, -0.075, -0.031, w - 0.0004 * Math.sign(w) * -1, w + 0.0009 * Math.sign(w), 0.004));
  }
  // ---- barrel & flash hider ----
  b.add('steel', cyl(0.0058, 0.17, 0.182, bore, 0, 16));
  b.add('metal', lathe([[0.177, 0.0], [0.177, 0.0068], [0.18, 0.0072], [0.209, 0.0072], [0.212, 0.0062], [0.212, 0.0036], [0.209, 0.0038], [0.209, 0.0]], bore, 0, 24));
  for (let i = 0; i < 4; i++) b.add('dark', aroundBore(rbox(0.188, 0.209, bore + 0.0058, bore + 0.0074, -0.0012, 0.0012, 0.0004), bore, i * (Math.PI / 2) + Math.PI / 4));

  // ---- stock: connector, adjustable arm with lock button, tall butt with a hook cut-out ----
  b.add('metal', rbox(-0.205, -0.168, 0.013, 0.043, -0.0135, 0.0135, 0.003));
  b.add('steel', cyl(0.0045, -0.178, -0.17, 0.0, 0, 16)); // hinge lug under the rear
  b.add('blackPoly', profile([
    [-0.205, 0.0475], [-0.312, 0.0475], [-0.326, 0.044], [-0.329, 0.03], [-0.329, -0.044], [-0.322, -0.05], [-0.3, -0.05],
    [-0.293, -0.044], [-0.293, -0.028], [-0.299, -0.024], [-0.301, -0.008], [-0.293, 0.0], [-0.29, 0.011], [-0.205, 0.011],
  ], 0.034, { round: 0.004, bevel: 0.0025 }));
  b.add('dark', rbox(-0.242, -0.222, 0.035, 0.045, 0.0168, 0.0174, 0.002)); // lock button
  b.add('metal', rbox(-0.24, -0.224, 0.0365, 0.0435, 0.0172, 0.0182, 0.0015));
  b.add('rubber', rbox(-0.333, -0.327, -0.05, 0.047, -0.0182, 0.0182, 0.003));

  // ---- rear sight: spring-loaded base block + flat leaf with a square notch ----
  {
    // base block (chamfered top corners) clamped on the rail
    const bs = new THREE.Shape();
    bs.moveTo(-0.0138, railV); bs.lineTo(0.0138, railV); bs.lineTo(0.0138, 0.07); bs.lineTo(0.0115, 0.0735); bs.lineTo(-0.0115, 0.0735); bs.lineTo(-0.0138, 0.07); bs.closePath();
    const bg = new THREE.ExtrudeGeometry(bs, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1 });
    bg.translate(0, 0, -rearU - 0.0145);
    b.add('metal', bg);
    // spring window on the rear face with the coil visible
    b.add('dark', rbox(rearU - 0.014, rearU - 0.0115, 0.064, 0.0715, -0.0055, 0.0055, 0.0006));
    for (let i = 0; i < 5; i++) {
      const tor = new THREE.TorusGeometry(0.0022, 0.00045, 5, 10);
      tor.rotateY(Math.PI / 2);
      tor.translate(-0.0035 + i * 0.0017, 0.0675, -(rearU - 0.0128));
      b.add('steel', tor);
    }
    // side tabs of the clamp
    for (const sgn of [1, -1]) b.add('metal', rbox(rearU - 0.01, rearU + 0.004, 0.0715, 0.0738, sgn * 0.0105 - 0.0025, sgn * 0.0105 + 0.0025, 0.0008));
    // the leaf: slightly tapered flat plate, square notch in the top centre
    const lh = 0.0058, lb = 0.0062, lt = 0.0052; // half widths at base / top (slim posts)
    const nw = 0.0019, nd = 0.0033; // notch half width, depth
    const ls = new THREE.Shape();
    ls.moveTo(-lb, 0.0725); ls.lineTo(lb, 0.0725); ls.lineTo(lt, sightV); ls.lineTo(nw, sightV); ls.lineTo(nw, sightV - nd); ls.lineTo(-nw, sightV - nd); ls.lineTo(-nw, sightV); ls.lineTo(-lt, sightV); ls.closePath();
    const lg = new THREE.ExtrudeGeometry(ls, { depth: 0.0028, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0003, bevelSegments: 1 });
    lg.translate(0, 0, -rearU - 0.0014);
    b.add('metal', lg);
    void lh;
    // lighter recessed panel in the lower leaf (as on the reference)
    b.add('steel', rbox(rearU - 0.0018, rearU - 0.0012, 0.0745, 0.0805, -0.0028, 0.0028, 0.0005));
  }
  // ---- front sight: base, thin post, low protective ears ----
  b.add('metal', rbox(0.114, 0.1425, railTop - 0.001, 0.0705, -0.0115, 0.0115, 0.0015));
  b.add('metal', rbox(frontU - 0.004, frontU + 0.004, 0.0705, 0.074, -0.0035, 0.0035, 0.001));
  b.add('steel', rbox(frontU - 0.0014, frontU + 0.0014, 0.072, sightV, -0.0009, 0.0009, 0.0003));
  for (const sgn of [1, -1]) b.add('metal', rbox(frontU - 0.0045, frontU + 0.0045, 0.0705, sightV - 0.004, sgn * 0.0075 - 0.0015, sgn * 0.0075 + 0.0015, 0.0007));

  // ---- moving parts ----
  const pb = new PartBuilder();
  pb.add('steel', rbox(-0.03, 0.02, 0.027, 0.04, W - 0.0035, W - 0.0008, 0.0012));
  const bolt = pb.build(mats, 'bolt');
  b.add('dark', rbox(-0.032, 0.022, 0.026, 0.041, W - 0.0006, W + 0.0004, 0.0012)); // ejection port (right)
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, 0.0], [0.006, -0.011], [0.004, -0.019], [-0.002, -0.022], [-0.004, -0.02], [0.0, -0.014], [-0.001, 0.0]], 0.0055, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.001, -0.016);
  // magazine: slim 4.6 mm double stack; the visible part hangs below the grip, foot extends forward
  const mb = new PartBuilder();
  const mF = -0.002, mB = -0.041, mTop = 0.0, mBody = -0.156, mBot = -0.173;
  mb.add('blackPoly', profile([[mF, mTop], [mF, mBody], [mB, mBody], [mB, mTop]], 0.021, { round: 0.003, bevel: 0.0018 }));
  mb.add('blackPoly', profile([[0.014, mBody + 0.004], [0.016, mBody - 0.004], [0.013, mBot], [mB + 0.008, mBot], [mB, mBot + 0.006], [mB, mBody + 0.004]], 0.025, { round: 0.003, bevel: 0.002 }));
  for (let i = 0; i < 3; i++) {
    const v = mBody + 0.016 + i * 0.016;
    for (const w of [0.0107, -0.0107]) mb.add('dark', rbox(mB + 0.007, mF - 0.006, v, v + 0.003, w - 0.0004, w + 0.0004, 0.001));
  }
  mb.add('brass', cyl(0.0028, -0.034, -0.012, 0.0024, 0.0, 10));
  mb.add('copper', lathe([[-0.012, 0.0], [-0.012, 0.0028], [-0.006, 0.0012], [-0.004, 0.0]], 0.0024, 0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.006, 0);

  root.add(b.build(mats, 'body'), bolt, charge, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.213, bore, 0),
    socket('eject', -0.005, 0.034, W),
    socket('sight', rearU, sightV, 0),
    socket('magWell', -0.0215, -0.006, 0),
  ]);
  // right hand on the near-vertical grip; support hand under the nose (foregrip folded)
  const { rs, ls } = grips(root, [-0.026, -0.046, -0.1, 0.0155], { u: 0.122, v: 0.022, r: 0.0245, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.092, 0.045, W);
  return { root, parts: { bolt, charge, trigger, mag }, sockets, adsDist: 0.1, reloadPose: { p: [-0.03, 0.1, -0.16], r: [0.16, 0.02, -0.7] } };
}

// ======================================================================
// Pump-action 12 gauge
// ======================================================================
export function buildShotgun(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'Pump12';
  const b = new PartBuilder();
  const bore = 0.036;
  // receiver: long, rounded top
  b.add('metal', profile([[-0.085, -0.012], [-0.085, 0.045], [-0.07, 0.056], [0.15, 0.056], [0.165, 0.05], [0.165, -0.012]], 0.034, { round: 0.006, bevel: 0.0022 }));
  b.add('dark', rbox(0.0, 0.085, 0.018, 0.046, 0.0165, 0.0175, 0.002)); // ejection port
  b.add('dark', rbox(0.02, 0.11, -0.013, -0.011, -0.012, 0.012, 0.001)); // loading port
  b.add('steel', pin(-0.04, 0.02, 0.0175, 0.003));
  b.add('steel', pin(0.11, 0.02, 0.0175, 0.003));
  b.add('steel', rbox(-0.06, -0.04, 0.056, 0.062, -0.005, 0.005, 0.002)); // ghost ring base
  b.add('steel', lathe([[-0.052, 0.0035], [-0.052, 0.006], [-0.048, 0.006], [-0.048, 0.0035], [-0.052, 0.0035]], 0.068, 0, 16));
  // trigger group
  b.add('metal', profile([[-0.05, -0.012], [0.04, -0.012], [0.036, -0.03], [-0.046, -0.03]], 0.024, { round: 0.004, bevel: 0.0015 }));
  b.add('metal', profile([[-0.046, -0.044], [0.028, -0.044], [0.032, -0.04], [0.032, -0.03], [0.027, -0.03], [0.026, -0.039], [-0.04, -0.039], [-0.046, -0.032]], 0.011, { bevel: 0.001 }));
  // barrel & magazine tube
  b.add('steel', cyl(0.0115, 0.16, 0.56, bore, 0, 22));
  b.add('steel', cyl(0.0085, 0.555, 0.565, bore, 0, 22, 0.0098));
  b.add('metal', cyl(0.0122, 0.16, 0.45, bore - 0.026, 0, 20));
  b.add('metal', lathe([[0.45, 0.0], [0.45, 0.0128], [0.462, 0.0128], [0.468, 0.009], [0.468, 0.0]], bore - 0.026, 0, 20));
  b.add('metal', rbox(0.44, 0.47, bore - 0.03, bore + 0.006, -0.008, 0.008, 0.003)); // barrel clamp
  b.add('tritium', cyl(0.0022, 0.55, 0.556, bore + 0.0135, 0, 8));
  b.add('steel', rbox(0.545, 0.56, bore + 0.009, bore + 0.013, -0.002, 0.002, 0.0008));
  // stock (polymer, pistol-grip style, integral)
  b.add('polymer', profile([[-0.085, 0.048], [-0.12, 0.048], [-0.38, 0.052], [-0.395, 0.06], [-0.405, -0.075], [-0.39, -0.085], [-0.3, -0.05], [-0.16, -0.03], [-0.12, -0.08], [-0.13, -0.12], [-0.105, -0.13], [-0.085, -0.11], [-0.07, -0.04], [-0.05, -0.012], [-0.085, -0.012]], 0.036, { round: 0.01, bevel: 0.004 }));
  b.add('rubber', rbox(-0.418, -0.402, -0.088, 0.063, -0.02, 0.02, 0.005));
  // moving pump (forend, ribbed)
  const fb = new PartBuilder();
  fb.add('polymer', lathe([[0.2, 0.0], [0.2, 0.0185], [0.206, 0.0215], [0.34, 0.0215], [0.346, 0.0185], [0.346, 0.0]], bore - 0.02, 0, 20));
  for (let i = 0; i < 9; i++) fb.add('polymer', cyl(0.0232, 0.215 + i * 0.014, 0.221 + i * 0.014, bore - 0.02, 0, 20));
  fb.add('metal', rbox(0.17, 0.205, bore - 0.034, bore - 0.03, 0.012, 0.016, 0.001)); // action bars
  fb.add('metal', rbox(0.17, 0.205, bore - 0.034, bore - 0.03, -0.016, -0.012, 0.001));
  const pump = fb.build(mats, 'pump');
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, 0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, 0.0]], 0.006, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.016, 0.0);
  // bolt visible in port (moves with pump)
  const pb = new PartBuilder();
  pb.add('steel', rbox(0.005, 0.08, 0.022, 0.042, 0.012, 0.0162, 0.0015));
  const bolt = pb.build(mats, 'bolt');
  // shell (for reload hand)
  const sb = new PartBuilder();
  sb.add('shell', cyl(0.0101, -0.03, 0.035, 0, 0, 16));
  sb.add('brass', cyl(0.0108, -0.042, -0.03, 0, 0, 16));
  sb.add('brass', cyl(0.0112, -0.044, -0.041, 0, 0, 16));
  const shell = sb.build(mats, 'shell');
  shell.visible = false;
  root.add(b.build(mats, 'body'), pump, trigger, bolt, shell);
  const sockets = addSockets(root, [
    socket('muzzle', 0.566, bore, 0),
    socket('eject', 0.05, 0.034, 0.022),
    socket('sight', -0.05, 0.068, 0),
    socket('loadPort', 0.07, -0.015, 0),
  ]);
  const { rs, ls } = grips(root, [-0.1, -0.058, -0.35, 0.018], { u: 0.272, v: bore - 0.02, r: 0.0232, fingers: [0.78, -0.18, -0.6], palm: [0.2, 1, 0] });
  pump.attach(ls); // the support hand rides the forend when racking
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  // left hand rides the pump
  pump.attach(ls);
  // barrel-clamp IR laser ahead of the pump stroke
  addLaser(root, sockets, mats, 0.43, bore, 0.0125);
  return { root, parts: { pump, trigger, bolt, shell }, sockets, adsDist: 0.26 };
}

// ======================================================================
// Bolt-action .338 sniper rifle with variable scope
// ======================================================================
export function buildSniper(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'SKV338';
  const b = new PartBuilder();
  const bore = 0.04;
  // chassis (tan)
  b.add('tanMetal', profile([[-0.11, -0.014], [-0.11, 0.032], [0.36, 0.032], [0.37, 0.024], [0.37, -0.006], [0.34, -0.022], [0.1, -0.022], [0.09, -0.06], [0.03, -0.06], [0.026, -0.016]], 0.05, { round: 0.006, bevel: 0.003 }));
  for (let i = 0; i < 4; i++) {
    b.add('dark', rbox(0.15 + i * 0.05, 0.185 + i * 0.05, -0.008, 0.016, 0.0245, 0.0255, 0.001));
    b.add('dark', rbox(0.15 + i * 0.05, 0.185 + i * 0.05, -0.008, 0.016, -0.0255, -0.0245, 0.001));
  }
  // receiver (round action)
  b.add('steel', cyl(0.0185, -0.11, 0.12, bore, 0, 24));
  b.add('dark', rbox(-0.03, 0.06, bore - 0.004, bore + 0.012, 0.0172, 0.0188, 0.002));
  for (const g of picatinny(-0.11, 0.3, bore + 0.0165, 0, 0.022)) b.add('metal', g);
  // trigger guard + grip
  b.add('tanMetal', profile([[-0.04, -0.034], [0.024, -0.034], [0.028, -0.03], [0.028, -0.016], [0.022, -0.016], [0.021, -0.029], [-0.036, -0.029], [-0.04, -0.02]], 0.012, { bevel: 0.0012 }));
  b.add('polymer', profile(pistolGrip(0.0, -0.004), 0.032, { round: 0.009, bevel: 0.004 }));
  // fluted heavy barrel + brake
  b.add('steel', cyl(0.0135, 0.12, 0.8, bore, 0, 24, 0.011));
  for (let i = 0; i < 6; i++) b.add('dark', aroundBore(rbox(0.4, 0.7, bore + 0.0105, bore + 0.0122, -0.0025, 0.0025, 0.001), bore, (i * Math.PI) / 3));
  b.add('metal', lathe([[0.79, 0.0], [0.79, 0.016], [0.88, 0.016], [0.885, 0.013], [0.885, 0.0]], bore, 0, 24));
  for (let i = 0; i < 3; i++) {
    b.add('dark', rbox(0.81 + i * 0.022, 0.822 + i * 0.022, bore - 0.009, bore + 0.009, 0.0152, 0.0164, 0.001));
    b.add('dark', rbox(0.81 + i * 0.022, 0.822 + i * 0.022, bore - 0.009, bore + 0.009, -0.0164, -0.0152, 0.001));
  }
  // folded bipod
  b.add('metal', rbox(0.33, 0.36, -0.032, -0.022, -0.012, 0.012, 0.002));
  b.add('metal', cyl(0.0045, 0.36, 0.56, -0.03, 0.009, 10));
  b.add('metal', cyl(0.0045, 0.36, 0.56, -0.03, -0.009, 10));
  b.add('rubber', cyl(0.0065, 0.56, 0.58, -0.03, 0.009, 10));
  b.add('rubber', cyl(0.0065, 0.56, 0.58, -0.03, -0.009, 10));
  // folding stock w/ adjustable cheek riser
  b.add('tanMetal', profile([[-0.11, 0.03], [-0.13, 0.028], [-0.4, 0.028], [-0.42, 0.02], [-0.43, -0.085], [-0.41, -0.095], [-0.36, -0.07], [-0.2, -0.04], [-0.13, -0.02], [-0.11, -0.012]], 0.04, { round: 0.008, bevel: 0.003, holes: [[[-0.33, -0.005], [-0.2, -0.005], [-0.2, -0.022], [-0.33, -0.048]]] }));
  b.add('polymer', profile([[-0.36, 0.028], [-0.18, 0.028], [-0.18, 0.056], [-0.2, 0.062], [-0.35, 0.062], [-0.36, 0.055]], 0.036, { round: 0.008, bevel: 0.004 }));
  b.add('rubber', rbox(-0.445, -0.428, -0.098, 0.032, -0.022, 0.022, 0.005));
  // scope: 30mm tube, 50mm objective
  const sAxis = bore + 0.067;
  const SO = 0.15; // scope mounted forward for correct eye relief
  const sc = new PartBuilder();
  sc.add('metal', rbox(-0.06, -0.035, bore + 0.025, sAxis - 0.012, -0.012, 0.012, 0.003));
  sc.add('metal', rbox(0.11, 0.135, bore + 0.025, sAxis - 0.012, -0.012, 0.012, 0.003));
  sc.add('metal', cyl(0.0175, -0.065, -0.03, sAxis, 0, 24));
  sc.add('metal', cyl(0.0175, 0.105, 0.14, sAxis, 0, 24));
  sc.add('metal', lathe([
    [-0.16, 0.0186], [-0.16, 0.0205], [-0.152, 0.0215], [-0.11, 0.0215], [-0.09, 0.016], [-0.09, 0.015], [0.18, 0.015], [0.24, 0.0285],
    [0.29, 0.0285], [0.292, 0.026], [0.292, 0.0],
  ], sAxis, 0, 36));
  sc.add('rubber', lathe([[-0.165, 0.0192], [-0.165, 0.0222], [-0.13, 0.0222], [-0.13, 0.0192], [-0.165, 0.0192]], sAxis, 0, 30));
  sc.add('metal', cyl(0.012, 0.02, 0.05, sAxis + 0.026, 0, 20));
  sc.add('metal', cyl(0.012, 0.02, 0.05, sAxis, 0.026, 20));
  sc.add('metal', rbox(0.015, 0.055, sAxis - 0.012, sAxis + 0.012, -0.018, 0.018, 0.006));
  sc.add('metal', lathe([[-0.075, 0.0187], [-0.075, 0.0208], [-0.06, 0.0208], [-0.06, 0.0187], [-0.075, 0.0187]], sAxis, 0, 28)); // magnification ring
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0185, 36), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  lens.position.set(0, sAxis, -(-0.155));
  // CircleGeometry already faces +Z (toward the shooter)
  lens.name = 'scopeLens';
  const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 36), mats.glassDark);
  objLens.position.set(0, sAxis, -0.288);
  const scope = sc.build(mats, 'scope');
  scope.position.z = -SO;
  lens.position.z -= SO;
  objLens.position.z -= SO;
  root.add(scope, lens, objLens);
  // bolt (handle lifts & draws back)
  const bb = new PartBuilder();
  bb.add('steel', cyl(0.009, -0.12, 0.0, 0, 0, 16));
  bb.add('steel', cyl(0.0035, -0.04, -0.03, 0, 0.0, 8));
  bb.add('steel', profile([[-0.045, 0.004], [-0.035, 0.004], [-0.035, -0.004], [-0.045, -0.004]], 0.062, { bevel: 0.001, wc: 0.031 }));
  const knob = new THREE.SphereGeometry(0.0095, 16, 12);
  knob.translate(0.062, 0, 0.04);
  bb.add('polymer', knob);
  const bolt = bb.build(mats, 'bolt');
  bolt.position.set(0, bore, 0.0);
  const tb = new PartBuilder();
  tb.add('steel', profile([[0.004, 0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, 0.0]], 0.006, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.006, 0);
  const mb = new PartBuilder();
  mb.add('metal', profile([[0.085, 0.0], [0.088, -0.07], [0.032, -0.072], [0.03, 0.0]].map(([u, v]) => [u - 0.06, v] as P2), 0.03, { round: 0.003, bevel: 0.002 }));
  mb.add('polymer', rbox(0.026 - 0.06, 0.092 - 0.06, -0.08, -0.07, -0.017, 0.017, 0.003));
  mb.add('brass', cyl(0.0062, -0.03, 0.02, 0.004, 0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.022, -0.06);
  root.add(b.build(mats, 'body'), bolt, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.886, bore, 0),
    socket('eject', 0.02, bore + 0.006, 0.024),
    socket('sight', -0.16 + SO, sAxis, 0),
    socket('magWell', 0.06, -0.022, 0),
  ]);
  const { rs, ls } = grips(root, [-0.079, -0.062, -0.25, 0.016], { u: 0.22, v: 0.004, r: 0.027, fingers: [0.78, -0.18, -0.6], palm: [0.2, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { bolt, trigger, mag }, sockets, adsDist: 0.042, scopeLens: lens };
}

// ======================================================================
// P80 service pistol (9mm, striker fired)
// ======================================================================
export function buildPistol(mats: WeaponMats): WeaponModel {
  // Modern striker-fired 9 mm compact (Glock 19 / P320 class proportions: ~187 mm long,
  // ~128 mm tall, slide 25 mm wide). 3-dot sights: dovetailed notch rear with two dots,
  // front post with one dot; tops flush on the line of sight.
  const root = new THREE.Group();
  root.name = 'P80';
  const b = new PartBuilder();
  const bore = 0.032;
  const sightTop = 0.0565;
  // ---- frame: dust cover with accessory rail, frame rails, trigger guard, raked grip, beavertail ----
  b.add('blackPoly', profile([[-0.07, 0.0165], [0.112, 0.0165], [0.114, 0.012], [0.112, 0.0], [0.072, -0.002], [0.05, -0.004], [0.046, -0.012], [-0.028, -0.012], [-0.04, -0.006], [-0.066, 0.006], [-0.086, 0.01], [-0.09, 0.015], [-0.08, 0.0165]], 0.0262, { round: 0.003, bevel: 0.002 }));
  for (let i = 0; i < 3; i++) b.add('dark', rbox(0.072 + i * 0.012, 0.0765 + i * 0.012, -0.0025, 0.002, -0.0128, 0.0128, 0.0006)); // rail slots
  // trigger guard: square, slightly hooked front, undercut where it meets the grip
  b.add('blackPoly', profile([[-0.03, -0.012], [0.046, -0.012], [0.05, -0.016], [0.05, -0.031], [0.045, -0.035], [-0.022, -0.035], [-0.028, -0.03], [-0.026, -0.027], [-0.02, -0.03], [0.042, -0.03], [0.045, -0.027], [0.045, -0.016], [0.042, -0.016], [-0.025, -0.016]], 0.011, { round: 0.0015, bevel: 0.001 }));
  // grip: ~22° rake, slight front-strap palm swell, flared magazine well
  const rk = Math.tan(0.38);
  const gu = (u: number, v: number) => u + rk * v;
  b.add('blackPoly', profile([
    [-0.03, -0.012], [gu(-0.026, -0.03), -0.03], [gu(-0.029, -0.048), -0.048], [gu(-0.026, -0.066), -0.066], [gu(-0.029, -0.086), -0.086], [gu(-0.027, -0.106), -0.106], [gu(-0.025, -0.114), -0.114],
    [gu(-0.068, -0.114), -0.114], [gu(-0.066, -0.104), -0.104], [gu(-0.064, -0.06), -0.06], [gu(-0.062, -0.02), -0.02], [-0.07, 0.004], [-0.086, 0.01],
  ], 0.0292, { round: 0.008, bevel: 0.004 }));
  // stippled grip panels and the recessed thumb rest
  for (const w of [0.0148, -0.0148]) {
    for (let i = 0; i < 6; i++) {
      const v = -0.032 - i * 0.012;
      b.add('blackPoly', rbox(gu(-0.058, v), gu(-0.033, v), v - 0.0085, v - 0.0015, w - 0.0002, w + 0.0006 * Math.sign(w), 0.0025));
    }
    b.add('dark', rbox(-0.03, 0.01, 0.004, 0.012, w - 0.0003 * Math.sign(w), w + 0.0002 * Math.sign(w), 0.002)); // frame rail line
  }
  // controls: slide stop (left), takedown lever (both), reversible mag release
  b.add('metal', rbox(-0.004, 0.022, 0.011, 0.0165, -0.0145, -0.0128, 0.0008));
  b.add('metal', rbox(0.006, 0.014, 0.008, 0.016, -0.0152, -0.0128, 0.001));
  for (const w of [0.0136, -0.0136]) b.add('metal', rbox(0.034, 0.044, 0.007, 0.013, w - 0.0008, w + 0.0008, 0.0008));
  b.add('blackPoly', rbox(-0.036, -0.027, -0.02, -0.011, -0.0158, -0.0138, 0.002));
  // ---- slide (moving): bevelled top, serrations, port, extractor, striker plate, 3-dot sights ----
  const sb = new PartBuilder();
  sb.add('metal', profile([[-0.074, 0.0165], [-0.074, 0.046], [0.112, 0.046], [0.1155, 0.043], [0.1155, 0.0165]], 0.0245, { round: 0.0015, bevel: 0.0016 }));
  sb.add('metal', profile([[-0.073, 0.045], [-0.073, 0.0485], [-0.07, 0.0505], [0.109, 0.0505], [0.1135, 0.0475], [0.1135, 0.045]], 0.0196, { round: 0.0015, bevel: 0.0022 }));
  for (let i = 0; i < 8; i++) {
    const u = -0.0705 + i * 0.0034;
    for (const w of [0.01235, -0.01235]) sb.add('dark', rbox(u, u + 0.0013, 0.02, 0.0445, w - 0.0005, w + 0.0005, 0.0004));
  }
  for (let i = 0; i < 6; i++) {
    const u = 0.078 + i * 0.0034;
    for (const w of [0.01235, -0.01235]) sb.add('dark', rbox(u, u + 0.0013, 0.024, 0.0445, w - 0.0005, w + 0.0005, 0.0004));
  }
  sb.add('dark', rbox(0.0, 0.05, 0.03, 0.0498, 0.0112, 0.0124, 0.0008)); // ejection port
  sb.add('steel', rbox(0.004, 0.047, 0.04, 0.0496, 0.0068, 0.0116, 0.0008)); // barrel hood in the port
  sb.add('steel', rbox(0.035, 0.058, 0.0375, 0.0415, 0.0122, 0.0132, 0.0006)); // extractor
  sb.add('dark', rbox(-0.0748, -0.0738, 0.021, 0.044, -0.0085, 0.0085, 0.0012)); // striker cover plate
  // rear sight: dovetail block with a square notch; two dots either side of it
  sb.add('steel', rbox(-0.0712, -0.0598, 0.0505, sightTop - 0.003, -0.0088, 0.0088, 0.0008));
  for (const sgn of [1, -1]) sb.add('steel', rbox(-0.0712, -0.0598, sightTop - 0.0032, sightTop, sgn * 0.0017, sgn * 0.0088, 0.0006));
  // front sight: post with a dot on its rear face, top flush with the rear notch shoulders
  sb.add('steel', rbox(0.1005, 0.1075, 0.0505, sightTop, -0.0017, 0.0017, 0.0005));
  // muzzle: barrel crown & recoil-spring guide rod in the slide nose
  sb.add('steel', cyl(0.0056, 0.112, 0.1158, bore, 0, 18));
  sb.add('dark', cyl(0.0046, 0.1158, 0.1162, bore, 0, 18));
  sb.add('steel', cyl(0.0036, 0.111, 0.1158, 0.0205, 0, 12));
  const slide = sb.build(mats, 'slide');
  for (const sgn of [1, -1]) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 14), mats.tritium);
    dot.position.set(sgn * 0.0052, sightTop - 0.0018, 0.0713);
    dot.rotation.y = Math.PI;
    slide.add(dot);
  }
  const fdot = new THREE.Mesh(new THREE.CircleGeometry(0.0012, 14), mats.tritium);
  fdot.position.set(0, sightTop - 0.0018, -0.1004);
  fdot.rotation.y = Math.PI;
  slide.add(fdot);
  // ---- trigger with safety blade ----
  const tb = new PartBuilder();
  tb.add('blackPoly', profile([[0.004, 0.0], [0.006, -0.01], [0.004, -0.019], [-0.002, -0.023], [-0.004, -0.021], [0.0, -0.014], [-0.001, 0.0]], 0.0058, { bevel: 0.0008 }));
  tb.add('dark', profile([[0.0035, -0.006], [0.0045, -0.012], [0.0025, -0.017], [0.0005, -0.016], [0.002, -0.011], [0.0015, -0.006]], 0.0018, { bevel: 0.0003 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.006, -0.012);
  // ---- magazine: steel body, polymer baseplate with a small extension ----
  const mb = new PartBuilder();
  mb.add('metal', profile([[0.006, 0.0], [-0.002, -0.04], [-0.01, -0.09], [-0.036, -0.092], [-0.03, -0.04], [-0.022, 0.0]], 0.02, { round: 0.002, bevel: 0.0015 }));
  mb.add('blackPoly', profile([[-0.006, -0.088], [-0.008, -0.1], [-0.012, -0.104], [-0.044, -0.104], [-0.046, -0.1], [-0.04, -0.088]], 0.026, { round: 0.003, bevel: 0.002 }));
  mb.add('brass', cyl(0.0045, -0.016, 0.004, 0.003, 0, 10));
  mb.add('copper', lathe([[0.004, 0.0], [0.004, 0.0045], [0.01, 0.002], [0.012, 0.0]], 0.003, 0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.004, 0.048);
  root.add(b.build(mats, 'body'), slide, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.117, bore, 0),
    socket('eject', 0.024, 0.044, 0.014),
    socket('sight', -0.0712, sightTop, 0),
    socket('magWell', -0.048, -0.004, 0),
  ]);
  // modern two-hand grip: firing hand high under the beavertail on the raked grip; support hand
  // fills the left side, fingers wrapping the front strap over the firing hand, thumb forward
  const { rs, ls } = grips(root, [-0.068, -0.046, -0.38, 0.0146], { u: -0.058, v: -0.072, r: 0.027, fingers: [0.1, -0.85, -0.5], palm: [1, 0, 0.12] });
  ls.userData.fist = true;
  ls.userData.pose = 'pistolSupport';
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { slide, trigger, mag }, sockets, adsDist: 0.36 };
}

// ======================================================================
// R357 revolver: 4" full-lug double-action .357 Magnum, six-shot swing-out cylinder.
// Blued frame, stainless cylinder, walnut grip. Moving parts for the animations:
//   hammer  — cocks back / falls on every shot (pivot behind the frame window)
//   crane   — swings the cylinder out to the left (pivot axis parallel to the bore)
//   cylinder— indexes 60° per shot, spins on inspect
//   ejector — star + rod: drives the six cases out of the chambers
//   rounds  — the six cartridges (children of the ejector star)
//   loader  — a speedloader with six rounds (held in the hand during reloads)
// ======================================================================
export function buildRevolver(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'R357';
  // all visible geometry hangs off `spin` (pivoting near the trigger) so it can be twirled on
  // the trigger finger without the hand sockets moving
  const spin = new THREE.Group();
  spin.name = 'spin';
  const SP = new THREE.Vector3(0, -0.012, 0.01); // pivot (root space): trigger guard
  spin.position.copy(SP);
  root.add(spin);
  const inner = new THREE.Group();
  inner.position.copy(SP).negate();
  spin.add(inner);
  const b = new PartBuilder();
  const bore = 0.036;
  const vC = bore - 0.0145; // cylinder axis height
  const cu0 = -0.008, cu1 = 0.036; // cylinder rear / front
  const cR = 0.0212;
  const sightTop = 0.0585;
  // ---- frame: recoil shield, top strap, front frame, bottom strap with a cut-out window for the cylinder ----
  b.add('blued', profile([
    [-0.046, 0.034], [-0.03, 0.05], [-0.01, 0.0515], [0.052, 0.0515], [0.054, 0.046], [0.054, -0.002], [0.044, -0.006], [0.03, -0.006], [-0.008, -0.006],
    [-0.024, -0.008], [-0.036, -0.004], [-0.048, 0.004], [-0.052, 0.018],
  ], 0.026, { round: 0.004, bevel: 0.0018, holes: [[[cu0 - 0.0005, vC - cR - 0.0016], [cu1 + 0.0005, vC - cR - 0.0016], [cu1 + 0.0005, vC + cR + 0.0012], [cu0 - 0.0005, vC + cR + 0.0012]]] }));
  // side-plate screws, cylinder release latch (left), frame flats
  for (const [u, v] of [[-0.028, 0.012], [-0.004, -0.001], [-0.038, 0.03]] as const) b.add('steel', pin(u, v, -0.0136, 0.0016, 0.001));
  b.add('steel', profile([[-0.022, 0.028], [-0.01, 0.028], [-0.008, 0.032], [-0.012, 0.036], [-0.022, 0.035]], 0.003, { bevel: 0.0006, wc: -0.0145 }));
  // ---- barrel: 4" with a vent-style top rib and a full-length underlug that houses the ejector rod ----
  b.add('blued', cyl(0.0098, 0.054, 0.156, bore, 0, 24));
  b.add('blued', rbox(0.054, 0.156, bore + 0.004, bore + 0.0112, -0.0056, 0.0056, 0.0018));
  b.add('blued', rbox(0.054, 0.156, vC - 0.011, bore - 0.004, -0.0085, 0.0085, 0.0035));
  b.add('dark', cyl(0.0036, 0.1556, 0.1564, bore, 0, 16)); // bore
  b.add('steel', cyl(0.0058, 0.1555, 0.1562, bore, 0, 16, 0.0062)); // crown
  b.add('dark', cyl(0.0034, 0.155, 0.1562, vC, 0, 10)); // ejector rod channel
  // front sight: ramped blade with an orange insert
  b.add('blued', profile([[0.135, bore + 0.011], [0.153, bore + 0.011], [0.153, sightTop - 0.0005], [0.149, sightTop], [0.145, sightTop]], 0.0034, { bevel: 0.0004 }));
  // rear sight: adjustable blade on the top strap, square notch
  b.add('blued', rbox(-0.012, 0.004, 0.0505, 0.0545, -0.0058, 0.0058, 0.0012));
  for (const sg of [1, -1]) b.add('blued', rbox(-0.012, -0.004, 0.054, sightTop, sg * 0.0019, sg * 0.0074, 0.0006));
  b.add('steel', pin(-0.008, 0.052, 0.0062, 0.0011, 0.0008));
  // ---- trigger guard (round, polished) ----
  b.add('blued', profile([[-0.02, -0.006], [0.03, -0.006], [0.033, -0.012], [0.03, -0.026], [0.018, -0.034], [0.0, -0.035], [-0.012, -0.03], [-0.018, -0.02], [-0.013, -0.016], [-0.008, -0.027], [0.002, -0.031], [0.016, -0.03], [0.026, -0.022], [0.027, -0.012], [0.024, -0.01], [-0.016, -0.01]], 0.0085, { round: 0.002, bevel: 0.0012 }));
  // ---- grip: walnut target grip with finger grooves, rounded butt ----
  const rk = Math.tan(0.24);
  const gu = (u: number, v: number) => u + rk * v;
  b.add('walnut', profile([
    [-0.024, -0.008], [gu(-0.022, -0.03), -0.03], [gu(-0.026, -0.042), -0.042], [gu(-0.022, -0.054), -0.054], [gu(-0.026, -0.068), -0.068], [gu(-0.022, -0.08), -0.08], [gu(-0.026, -0.094), -0.094],
    [gu(-0.034, -0.104), -0.104], [gu(-0.06, -0.106), -0.106], [gu(-0.07, -0.096), -0.096], [gu(-0.066, -0.06), -0.06], [gu(-0.062, -0.026), -0.026], [-0.054, 0.006], [-0.048, 0.014], [-0.04, 0.012], [-0.03, -0.002],
  ], 0.032, { round: 0.009, bevel: 0.005 }));
  b.add('steel', pin(gu(-0.045, -0.06), -0.06, 0.0162, 0.0022, 0.001));
  b.add('steel', pin(gu(-0.045, -0.06), -0.06, -0.0162, 0.0022, 0.001));
  inner.add(b.build(mats, 'body'));

  // ---- hammer (pivots at the back of the frame window) ----
  const HP = new THREE.Vector3(0, 0.03, 0.03); // root space (u = -0.03)
  const hb = new PartBuilder();
  hb.add('stainless', profile([[-0.026, 0.024], [-0.034, 0.024], [-0.04, 0.032], [-0.05, 0.049], [-0.058, 0.055], [-0.06, 0.052], [-0.052, 0.04], [-0.044, 0.026], [-0.036, 0.018]], 0.0075, { round: 0.0015, bevel: 0.0008 }));
  for (let i = 0; i < 4; i++) hb.add('dark', rbox(-0.06 + i * 0.003, -0.0588 + i * 0.003, 0.051 - i * 0.003, 0.0545 - i * 0.003, -0.0038, 0.0038, 0.0003));
  const hm = hb.build(mats, 'hammerMesh');
  const hammer = new THREE.Group();
  hammer.name = 'hammer';
  hammer.position.copy(HP);
  hm.position.copy(HP).negate();
  hammer.add(hm);
  inner.add(hammer);
  // ---- trigger (smooth combat trigger) ----
  const tb = new PartBuilder();
  tb.add('stainless', profile([[0.006, 0.0], [0.008, -0.01], [0.006, -0.02], [0.0, -0.025], [-0.003, -0.023], [0.002, -0.014], [0.001, 0.0]], 0.0062, { bevel: 0.0008, round: 0.0018 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.004, -0.008);
  inner.add(trigger);

  // ---- crane / cylinder / ejector / rounds ----
  const CP = new THREE.Vector3(-0.0115, vC - 0.0135, 0); // crane pivot (root space), axis along z
  const crane = new THREE.Group();
  crane.name = 'crane';
  crane.position.copy(CP);
  inner.add(crane);
  const yb = new PartBuilder();
  yb.add('blued', rbox(cu1, cu1 + 0.012, -0.004, 0.004, -0.004, 0.004, 0.0015)); // yoke arm (pivot side)
  yb.add('blued', rbox(cu1 + 0.002, cu1 + 0.01, 0.0, 0.0135, 0.0, 0.0115, 0.002)); // yoke reaches the cylinder axis
  yb.add('steel', cyl(0.0042, cu1, cu1 + 0.012, 0.0135, 0.0115, 14)); // yoke barrel (cylinder arbor)
  const yoke = yb.build(mats, 'yoke');
  crane.add(yoke);
  const cylinder = new THREE.Group();
  cylinder.name = 'cylinder';
  cylinder.position.set(-CP.x, vC - CP.y, 0); // cylinder axis relative to the crane pivot
  crane.add(cylinder);
  const cb = new PartBuilder();
  cb.add('stainless', lathe([[cu0, 0.004], [cu0, cR - 0.0015], [cu0 + 0.0015, cR], [cu1 - 0.003, cR], [cu1, cR - 0.003], [cu1, 0.004]], 0, 0, 36));
  const chamberR = bore - vC; // 0.0145
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    // chamber mouths at the front, flutes between the chambers
    cb.add('dark', cyl(0.0047, cu1 - 0.0005, cu1 + 0.0004, chamberR * ca, chamberR * sa, 14));
    // flutes sit between the chambers, stop notches over them
    const flute = rbox(cu0 + 0.01, cu1 - 0.006, -0.0025, 0.0025, -0.0012, 0.0012, 0.0012);
    flute.translate(0, cR, 0);
    flute.rotateZ(-a - Math.PI / 6);
    cb.add('dark', flute);
    const notch = rbox(cu0 + 0.012, cu0 + 0.019, -0.0012, 0.0012, -0.0009, 0.0009, 0.0003);
    notch.translate(0, cR, 0);
    notch.rotateZ(-a);
    cb.add('dark', notch);
  }
  cylinder.add(cb.build(mats, 'cylBody'));
  // ejector: star at the rear face + rod forward along the axis; the rounds ride on the star
  const ejector = new THREE.Group();
  ejector.name = 'ejector';
  cylinder.add(ejector);
  const eb = new PartBuilder();
  eb.add('stainless', lathe([[cu0 - 0.0005, 0.0], [cu0 - 0.0005, 0.0085], [cu0 + 0.002, 0.0085], [cu0 + 0.002, 0.0]], 0, 0, 6));
  eb.add('steel', cyl(0.0027, cu0, cu1 + 0.036, 0, 0, 12));
  eb.add('steel', cyl(0.0036, cu1 + 0.032, cu1 + 0.04, 0, 0, 12)); // knurled rod head
  ejector.add(eb.build(mats, 'ejectorMesh'));
  const rounds = new THREE.Group();
  rounds.name = 'rounds';
  ejector.add(rounds);
  const roundGeo = (pbx: PartBuilder, x: number, y: number, u0: number) => {
    pbx.add('brass', cyl(0.0048, u0, u0 + 0.031, y, x, 12));
    pbx.add('brass', cyl(0.0058, u0 - 0.0012, u0, y, x, 14)); // rim
    pbx.add('steel', cyl(0.0019, u0 - 0.0014, u0 - 0.0011, y, x, 8)); // primer
  };
  const rb = new PartBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    roundGeo(rb, chamberR * Math.sin(a), chamberR * Math.cos(a), cu0);
  }
  rounds.add(rb.build(mats, 'roundsMesh'));
  // the cartridge rims must line up with the chamber circle used for the mouths (angle 0 = up)
  rounds.rotation.z = 0;
  // ---- speedloader (separate; held by the support hand) ----
  const loader = new THREE.Group();
  loader.name = 'loader';
  const lb = new PartBuilder();
  lb.add('rubber', lathe([[0.0, 0.0], [0.0, 0.0175], [-0.009, 0.0175], [-0.011, 0.012], [-0.011, 0.0]], 0, 0, 28));
  lb.add('metal', lathe([[-0.011, 0.0], [-0.011, 0.0065], [-0.026, 0.0065], [-0.028, 0.004], [-0.028, 0.0]], 0, 0, 16)); // knob
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    lb.add('dark', rbox(-0.026, -0.013, Math.cos(a) * 0.0063, Math.cos(a) * 0.0063 + 0.0008, Math.sin(a) * 0.0063 - 0.0004, Math.sin(a) * 0.0063 + 0.0004, 0.0002));
  }
  const loaderBody = lb.build(mats, 'loaderBody');
  loader.add(loaderBody);
  const loaderRounds = new THREE.Group();
  loaderRounds.name = 'loaderRounds';
  const lrb = new PartBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = chamberR * Math.sin(a), y = chamberR * Math.cos(a);
    lrb.add('brass', cyl(0.0048, 0.001, 0.032, y, x, 12));
    lrb.add('brass', cyl(0.0058, 0.0, 0.0012, y, x, 14));
    lrb.add('copper', lathe([[0.032, 0.0], [0.032, 0.0046], [0.039, 0.0032], [0.042, 0.0]], y, x, 10));
  }
  loaderRounds.add(lrb.build(mats, 'loaderRoundsMesh'));
  loader.add(loaderRounds);
  loader.visible = false;

  const sockets = addSockets(root, [
    socket('muzzle', 0.157, bore, 0),
    socket('eject', 0.0, vC, -0.025),
    socket('sight', -0.008, sightTop, 0),
    socket('magWell', 0.014, vC, -0.024),
  ]);
  // firing hand high on the grip under the hammer; support hand wraps the firing hand (thumbs forward)
  const { rs, ls } = grips(root, [-0.06, -0.044, -0.3, 0.0158], { u: -0.05, v: -0.07, r: 0.028, fingers: [0.1, -0.85, -0.5], palm: [1, 0, 0.12] });
  ls.userData.fist = true;
  ls.userData.pose = 'pistolSupport';
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  root.userData.rev = { vC, cu0, cu1, chamberR, CP: CP.clone(), SP: SP.clone(), HP: HP.clone() };
  return { root, parts: { spin, hammer, trigger, crane, cylinder, ejector, rounds, loader, loaderRounds }, sockets, adsDist: 0.36 };
}


// ======================================================================
// FJ-14 marksman rifle (7.62 semi-auto, synthetic stock, side-mounted 2.5x scope)
// ======================================================================
export function buildDMR(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'FJ14';
  const b = new PartBuilder();
  const bore = 0.036;
  // ---- one-piece synthetic stock: butt, straight wrist, long forend under the barrel ----
  b.add('blackPoly', profile([
    [-0.462, 0.03], [-0.462, -0.104], [-0.44, -0.106], [-0.3, -0.066], [-0.2, -0.042], [-0.13, -0.03], [-0.085, -0.028],
    [-0.06, -0.02], [0.0, -0.016], [0.07, -0.014], [0.3, -0.008], [0.425, -0.002], [0.44, 0.01], [0.44, 0.026],
    [0.135, 0.026], [0.13, 0.014], [-0.12, 0.014], [-0.16, 0.02], [-0.3, 0.026], [-0.44, 0.032],
  ], 0.042, { round: 0.012, bevel: 0.005 }));
  // butt plate + sling swivels
  b.add('metal', rbox(-0.472, -0.46, -0.106, 0.034, -0.0205, 0.0205, 0.004));
  b.add('steel', new THREE.TorusGeometry(0.008, 0.0016, 6, 14).rotateY(Math.PI / 2).translate(0, -0.088, 0.33));
  b.add('steel', new THREE.TorusGeometry(0.008, 0.0016, 6, 14).rotateY(Math.PI / 2).translate(0, -0.018, -0.36));
  // ---- receiver ----
  b.add('metal', profile([[-0.125, 0.014], [-0.125, 0.05], [-0.1, 0.06], [0.06, 0.06], [0.07, 0.052], [0.13, 0.052], [0.135, 0.04], [0.135, 0.014]], 0.03, { round: 0.004, bevel: 0.0018 }));
  b.add('dark', rbox(-0.06, 0.05, 0.055, 0.0605, -0.0095, 0.0095, 0.001)); // bolt channel
  // rear aperture sight (folded under the scope mount)
  b.add('steel', rbox(-0.118, -0.09, 0.06, 0.072, -0.008, 0.008, 0.002));
  b.add('steel', cyl(0.006, -0.11, -0.1, 0.066, 0.014, 12));
  b.add('steel', cyl(0.006, -0.11, -0.1, 0.066, -0.014, 12));
  // trigger guard
  b.add('metal', profile([[-0.06, -0.016], [0.01, -0.016], [0.014, -0.022], [0.012, -0.046], [-0.006, -0.05], [-0.05, -0.05], [-0.062, -0.04]], 0.012, { bevel: 0.0012, holes: [[[-0.05, -0.022], [0.004, -0.022], [0.002, -0.042], [-0.044, -0.044]]] }));
  // ---- ventilated upper handguard ----
  b.add('blackPoly', profile([[0.135, 0.04], [0.135, 0.052], [0.15, 0.058], [0.39, 0.058], [0.405, 0.05], [0.405, 0.04]], 0.034, { round: 0.006, bevel: 0.003 }));
  for (let i = 0; i < 4; i++) b.add('dark', rbox(0.17 + i * 0.055, 0.205 + i * 0.055, 0.056, 0.0595, -0.009, 0.009, 0.002));
  // ---- barrel, gas system, front band, flash suppressor, front sight ----
  b.add('steel', cyl(0.0098, 0.135, 0.62, bore, 0, 22, 0.0082));
  b.add('steel', cyl(0.0085, 0.43, 0.52, bore - 0.019, 0, 16)); // gas cylinder
  b.add('steel', rbox(0.43, 0.455, bore - 0.03, bore + 0.012, -0.012, 0.012, 0.003)); // front band
  b.add('steel', rbox(0.5, 0.52, bore - 0.03, bore + 0.01, -0.011, 0.011, 0.002)); // gas lock
  b.add('metal', lathe([[0.6, 0.0], [0.6, 0.0118], [0.665, 0.0108], [0.668, 0.008], [0.668, 0.0]], bore, 0, 24));
  for (let i = 0; i < 5; i++) b.add('dark', aroundBore(rbox(0.618, 0.664, bore + 0.0085, bore + 0.0112, -0.0016, 0.0016, 0.0006), bore, (i * Math.PI * 2) / 5 + 0.3));
  b.add('steel', rbox(0.596, 0.606, bore + 0.009, bore + 0.034, -0.0024, 0.0024, 0.0008)); // front sight post
  for (const w of [-1, 1]) b.add('steel', rbox(0.594, 0.608, bore + 0.009, bore + 0.03, w * 0.006 - 0.0016, w * 0.006 + 0.0016, 0.0008)); // ears
  // ---- side scope mount + 1-4x scope (set to 2.5x) ----
  const sAxis = bore + 0.082;
  const sm = new PartBuilder();
  sm.add('metal', rbox(-0.1, 0.06, 0.03, 0.05, -0.034, -0.02, 0.003)); // side plate on the left of the receiver
  sm.add('metal', rbox(-0.09, 0.05, 0.05, sAxis - 0.018, -0.03, 0.022, 0.004)); // bridge over the receiver
  for (const u of [-0.06, 0.035]) {
    sm.add('metal', rbox(u - 0.012, u + 0.012, sAxis - 0.02, sAxis - 0.008, -0.013, 0.013, 0.003));
    sm.add('metal', cyl(0.0175, u - 0.011, u + 0.011, sAxis, 0, 24));
    sm.add('steel', pin(u, sAxis - 0.014, 0.016, 0.0026, 0.006));
  }
  sm.add('metal', lathe([
    [-0.15, 0.0178], [-0.15, 0.0198], [-0.142, 0.0206], [-0.105, 0.0206], [-0.09, 0.0152], [0.09, 0.0152], [0.13, 0.0225],
    [0.168, 0.0225], [0.17, 0.0205], [0.17, 0.0],
  ], sAxis, 0, 36));
  sm.add('rubber', lathe([[-0.155, 0.0185], [-0.155, 0.0214], [-0.128, 0.0214], [-0.128, 0.0185], [-0.155, 0.0185]], sAxis, 0, 30));
  sm.add('metal', lathe([[-0.085, 0.0153], [-0.085, 0.0172], [-0.068, 0.0172], [-0.068, 0.0153], [-0.085, 0.0153]], sAxis, 0, 28)); // power ring
  sm.add('metal', rbox(-0.08, -0.072, sAxis + 0.012, sAxis + 0.026, -0.002, 0.002, 0.001)); // throw lever
  sm.add('metal', cyl(0.0105, 0.0, 0.026, sAxis + 0.024, 0, 18));
  sm.add('metal', cyl(0.0105, 0.0, 0.026, sAxis, 0.024, 18));
  sm.add('metal', rbox(-0.004, 0.03, sAxis - 0.011, sAxis + 0.011, -0.016, 0.016, 0.005)); // turret housing
  root.add(sm.build(mats, 'scope'));
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0165, 36), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  lens.position.set(0, sAxis, 0.148);
  lens.name = 'scopeLens';
  const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.021, 36), mats.glassDark);
  objLens.position.set(0, sAxis, -0.1705);
  root.add(lens, objLens);
  // ---- op rod + charging handle (right side) + visible bolt: cycles on every shot, locks back empty ----
  const ob = new PartBuilder();
  ob.add('steel', cyl(0.0042, 0.1, 0.42, bore - 0.008, 0.019, 10));
  ob.add('steel', rbox(0.07, 0.11, bore - 0.016, bore + 0.004, 0.016, 0.024, 0.0015));
  ob.add('steel', rbox(0.078, 0.096, bore - 0.008, bore + 0.004, 0.024, 0.042, 0.002)); // charging handle
  ob.add('steel', rbox(0.078, 0.084, bore - 0.008, bore + 0.012, 0.036, 0.042, 0.0015));
  ob.add('steel', rbox(-0.055, 0.045, 0.048, 0.058, -0.0085, 0.0085, 0.002)); // bolt
  ob.add('steel', cyl(0.0035, -0.05, -0.035, 0.056, 0.0, 10));
  const bolt = ob.build(mats, 'bolt');
  // ---- trigger + magazine ----
  const tb = new PartBuilder();
  tb.add('steel', profile([[0.004, 0.0], [0.006, -0.012], [0.004, -0.02], [-0.002, -0.025], [-0.004, -0.023], [0.0, -0.015], [-0.001, 0.0]], 0.006, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.018, 0.02);
  const mb = new PartBuilder();
  mb.add('metal', profile([[-0.034, 0.008], [0.034, 0.008], [0.036, -0.004], [0.044, -0.098], [0.04, -0.104], [-0.018, -0.104], [-0.022, -0.098], [-0.034, -0.004]], 0.029, { round: 0.003, bevel: 0.0018 }));
  for (const w of [-1, 1]) mb.add('dark', profile([[-0.022, -0.012], [0.024, -0.012], [0.03, -0.09], [-0.012, -0.09]], 0.0008, { wc: w * 0.0148 }));
  mb.add('brass', cyl(0.0058, -0.026, 0.026, 0.006, 0.0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.012, -0.03);
  root.add(b.build(mats, 'body'), bolt, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.668, bore, 0),
    socket('eject', 0.0, 0.06, 0.012),
    socket('sight', -0.148, sAxis, 0),
    socket('magWell', 0.03, -0.012, 0),
  ]);
  // straight-wrist stock: the firing hand wraps the sloped wrist, support hand under the forend
  const { rs, ls } = grips(root, [-0.104, -0.02, -0.92, 0.0175], { u: 0.27, v: 0.004, r: 0.024, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { bolt, trigger, mag }, sockets, adsDist: 0.05, scopeLens: lens };
}


// ======================================================================
// AS-20 "Storm" — semi-automatic 12 gauge, 8-round box magazine
// (long boxy receiver with a full-length top rail, ventilated barrel shroud, box mag ahead of the
// trigger guard, pistol grip and a fixed straight stock; charging handle on the left)
// ======================================================================
export function buildAutoShotgun(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'AS20';
  const b = new PartBuilder();
  const bore = 0.03;
  // ---- receiver: tall slab-sided box, chamfered top edges ----
  b.add('blackPoly', profile([
    [-0.13, -0.016], [-0.13, 0.058], [-0.118, 0.07], [0.31, 0.07], [0.322, 0.06], [0.322, 0.004], [0.3, -0.016],
  ], 0.054, { round: 0.006, bevel: 0.003 }));
  // side panels / ribs so the slab reads as moulded
  for (const w of [-1, 1]) {
    b.add('metal', profile([[-0.1, 0.012], [0.28, 0.012], [0.28, 0.048], [-0.1, 0.048]], 0.0016, { wc: w * 0.0276 }));
    for (let i = 0; i < 5; i++) b.add('dark', rbox(0.12 + i * 0.03, 0.135 + i * 0.03, 0.018, 0.042, w * 0.0284 - 0.0006, w * 0.0284 + 0.0006, 0.0005));
  }
  b.add('dark', rbox(-0.02, 0.06, 0.03, 0.056, 0.026, 0.0282, 0.001)); // ejection port (right)
  // full-length top rail, low rear sight and a tall front post on the shroud
  for (const g of picatinny(-0.118, 0.3, 0.07, 0, 0.021)) b.add('metal', g);
  // carry-handle style rear sight: two ears on a raised block, aperture between them
  b.add('metal', rbox(-0.112, -0.076, 0.077, 0.096, -0.013, 0.013, 0.003));
  for (const w of [-1, 1]) b.add('metal', rbox(-0.104, -0.088, 0.096, 0.112, w * 0.0085 - 0.003, w * 0.0085 + 0.003, 0.0015));
  b.add('dark', rbox(-0.1, -0.092, 0.096, 0.1, -0.0055, 0.0055, 0.0008));
  // ---- barrel shroud with vents, barrel and a squared muzzle device ----
  b.add('metal', cyl(0.021, 0.32, 0.52, bore, 0, 24));
  for (let i = 0; i < 6; i++) for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    b.add('dark', aroundBore(rbox(0.34 + i * 0.028, 0.356 + i * 0.028, bore + 0.0195, bore + 0.0214, -0.004, 0.004, 0.001), bore, a));
  }
  b.add('steel', cyl(0.0112, 0.52, 0.575, bore, 0, 20, 0.0104));
  b.add('metal', rbox(0.548, 0.582, bore - 0.014, bore + 0.014, -0.014, 0.014, 0.004));
  for (const w of [-1, 1]) b.add('dark', rbox(0.556, 0.574, bore - 0.006, bore + 0.006, w * 0.0142 - 0.001, w * 0.0142 + 0.001, 0.001));
  b.add('metal', rbox(0.47, 0.49, bore + 0.018, bore + 0.064, -0.006, 0.006, 0.002)); // front sight tower
  for (const w of [-1, 1]) b.add('metal', rbox(0.472, 0.488, bore + 0.058, bore + 0.084, w * 0.009 - 0.0018, w * 0.009 + 0.0018, 0.0008)); // post guards
  b.add('steel', rbox(0.476, 0.484, bore + 0.06, bore + 0.077, -0.0016, 0.0016, 0.0006));
  b.add('tritium', cyl(0.0016, 0.476, 0.482, bore + 0.0775, 0, 8));
  // ---- under-barrel handguard (support hand) ----
  b.add('blackPoly', profile([[0.15, -0.016], [0.15, -0.042], [0.165, -0.05], [0.31, -0.05], [0.322, -0.04], [0.322, -0.016]], 0.05, { round: 0.008, bevel: 0.003 }));
  for (let i = 0; i < 6; i++) b.add('dark', rbox(0.18 + i * 0.022, 0.19 + i * 0.022, -0.052, -0.049, -0.016, 0.016, 0.0008));
  // ---- mag well, trigger guard, pistol grip ----
  b.add('blackPoly', profile([[0.035, -0.016], [0.035, -0.03], [0.125, -0.03], [0.125, -0.016]], 0.058, { round: 0.003, bevel: 0.002 }));
  b.add('metal', profile([[-0.04, -0.016], [0.02, -0.016], [0.026, -0.022], [0.024, -0.05], [0.005, -0.054], [-0.034, -0.054], [-0.046, -0.044]], 0.012, { bevel: 0.0012, holes: [[[-0.034, -0.022], [0.014, -0.022], [0.012, -0.046], [-0.03, -0.047]]] }));
  b.add('polymer', profile(pistolGrip(0.0, 0.0), 0.031, { round: 0.008, bevel: 0.004 }));
  // ---- fixed straight stock with a raised comb and a thick pad ----
  b.add('blackPoly', profile([
    [-0.13, 0.056], [-0.18, 0.062], [-0.4, 0.066], [-0.41, 0.058], [-0.42, -0.09], [-0.405, -0.098], [-0.33, -0.07], [-0.2, -0.04], [-0.13, -0.016],
  ], 0.042, { round: 0.012, bevel: 0.004, holes: [[[-0.33, 0.035], [-0.2, 0.035], [-0.2, -0.018], [-0.33, -0.044]]] }));
  b.add('rubber', rbox(-0.438, -0.418, -0.1, 0.068, -0.024, 0.024, 0.006));
  b.add('steel', pin(-0.02, 0.0, 0.028, 0.0028));
  b.add('steel', pin(0.1, 0.05, 0.028, 0.0028));
  // ---- charging handle (left, rides in a slot at the front of the receiver) ----
  const cb = new PartBuilder();
  cb.add('steel', rbox(0.2, 0.226, 0.046, 0.06, -0.0285, -0.026, 0.001));
  cb.add('steel', rbox(0.204, 0.222, 0.044, 0.062, -0.046, -0.028, 0.003));
  cb.add('rubber', rbox(0.202, 0.224, 0.042, 0.064, -0.05, -0.044, 0.003));
  const charge = cb.build(mats, 'charge');
  b.add('dark', rbox(0.16, 0.26, 0.048, 0.058, -0.0282, -0.0272, 0.001)); // charging slot
  // ---- trigger + magazine (8-round box, slightly canted forward) ----
  const tb = new PartBuilder();
  tb.add('steel', profile([[0.004, 0.0], [0.006, -0.012], [0.004, -0.02], [-0.002, -0.025], [-0.004, -0.023], [0.0, -0.015], [-0.001, 0.0]], 0.006, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.02, 0.008);
  const mb = new PartBuilder();
  mb.add('blackPoly', profile([[-0.042, 0.012], [0.042, 0.012], [0.046, -0.004], [0.05, -0.116], [0.044, -0.124], [-0.034, -0.124], [-0.04, -0.116], [-0.042, -0.004]], 0.052, { round: 0.005, bevel: 0.0025 }));
  for (const w of [-1, 1]) for (let i = 0; i < 3; i++) mb.add('dark', rbox(-0.03 + i * 0.026, -0.016 + i * 0.026, -0.1, -0.02, w * 0.0262 - 0.0006, w * 0.0262 + 0.0006, 0.0006));
  mb.add('shell', cyl(0.0098, -0.03, 0.03, 0.0, 0.0, 14));
  mb.add('brass', cyl(0.0104, 0.03, 0.04, 0.0, 0.0, 14));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.022, -0.08);
  root.add(b.build(mats, 'body'), charge, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.582, bore, 0),
    socket('eject', 0.02, 0.044, 0.028),
    socket('sight', -0.096, 0.108, 0),
    socket('magWell', 0.08, -0.022, 0),
  ]);
  const { rs, ls } = grips(root, [-0.079, -0.058, -0.25, 0.015], { u: 0.25, v: -0.033, r: 0.026, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { charge, trigger, mag }, sockets, adsDist: 0.26 };
}

// ======================================================================
// "Tvilling" side-by-side double barrel 12 gauge: blued action and barrels, walnut stock and
// beavertail forend. The barrels (with forend and both chambered shells) hinge on the action
// pin: parts.barrels is the pivot (rotation.x < 0 opens), shellL/R ride in the chambers,
// handShells is the pair the support hand feeds in, lever is the top lever.
// ======================================================================
export const DB_W = 0.0108; // barrel centre offset (left / right)
export const DB_HINGE = new THREE.Vector3(0, 0.006, -0.07);
export function buildDoubleBarrel(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'DB12';
  const bore = 0.03;
  const W = DB_W;
  const b = new PartBuilder();
  // ---- action: standing breech up to the rib, bar forward under the barrels to the hinge ----
  b.add('blued', profile([
    [-0.075, -0.012], [-0.075, 0.03], [-0.06, 0.04], [-0.004, 0.043], [0.0, 0.04], [0.0, 0.006], [0.078, 0.006], [0.084, -0.004],
    [0.078, -0.022], [0.05, -0.028], [-0.02, -0.028], [-0.05, -0.022],
  ], 0.046, { round: 0.007, bevel: 0.0022 }));
  // fences (the rounded shoulders behind each barrel) + engraving lines + hinge pin
  for (const w of [-1, 1]) {
    b.add('blued', lathe([[-0.012, 0.0], [-0.012, 0.0108], [-0.004, 0.0122], [0.0, 0.0115], [0.0, 0.0]], bore, w * W, 20));
    b.add('dark', profile([[0.008, -0.018], [0.07, -0.018], [0.07, -0.0168], [0.008, -0.0168]], 0.0006, { wc: w * 0.0234 }));
    b.add('dark', profile([[-0.06, 0.02], [-0.01, 0.026], [-0.01, 0.0272], [-0.06, 0.0212]], 0.0006, { wc: w * 0.0234 }));
  }
  b.add('stainless', pin(0.07, 0.006, 0.0234, 0.0042, 0.002));
  b.add('stainless', pin(0.07, 0.006, -0.0234, 0.0042, 0.002));
  // tang safety
  b.add('blued', rbox(-0.075, -0.05, 0.03, 0.036, -0.006, 0.006, 0.002));
  b.add('stainless', rbox(-0.07, -0.058, 0.035, 0.04, -0.0035, 0.0035, 0.0012));
  // ---- trigger guard + two triggers (front fires the right barrel, rear the left) ----
  b.add('blued', profile([[-0.07, -0.022], [0.02, -0.022], [0.026, -0.03], [0.018, -0.052], [-0.012, -0.058], [-0.05, -0.056], [-0.09, -0.04]], 0.01, { bevel: 0.001, holes: [[[-0.05, -0.028], [0.012, -0.028], [0.008, -0.046], [-0.012, -0.05], [-0.046, -0.049]]] }));
  for (const [u, s] of [[0.0, 1], [-0.022, 0.92]] as const) {
    b.add('stainless', profile([[u + 0.004, -0.022], [u + 0.006, -0.032], [u + 0.004, -0.04 * s], [u - 0.002, -0.045 * s], [u - 0.004, -0.043 * s], [u, -0.035], [u - 0.001, -0.022]], 0.005, { bevel: 0.0007 }));
  }
  // ---- walnut stock: slim wrist with a semi-pistol grip, comb, butt ----
  b.add('walnut', profile([
    [-0.075, 0.03], [-0.12, 0.02], [-0.2, 0.012], [-0.42, 0.006], [-0.432, 0.0], [-0.44, -0.098], [-0.428, -0.106],
    [-0.3, -0.078], [-0.2, -0.062], [-0.16, -0.07], [-0.135, -0.072], [-0.11, -0.052], [-0.085, -0.03], [-0.075, -0.012],
  ], 0.038, { round: 0.012, bevel: 0.004 }));
  // chequering panels on the grip and a grip cap
  for (const w of [-1, 1]) b.add('dark', profile([[-0.1, -0.02], [-0.135, -0.05], [-0.12, -0.062], [-0.09, -0.03]], 0.0006, { wc: w * 0.0186 }));
  b.add('blued', rbox(-0.162, -0.132, -0.078, -0.07, -0.012, 0.012, 0.003));
  b.add('rubber', rbox(-0.456, -0.438, -0.108, 0.01, -0.021, 0.021, 0.006));
  // ---- top lever (part, pivots about the vertical on the tang) ----
  const lb = new PartBuilder();
  lb.add('blued', profile([[-0.004, 0.0], [-0.004, 0.006], [-0.03, 0.007], [-0.046, 0.004], [-0.05, -0.0015], [-0.03, -0.001]], 0.012, { round: 0.003, bevel: 0.001 }));
  lb.add('blued', cyl(0.006, -0.004, 0.004, 0.003, 0, 12));
  const lever = lb.build(mats, 'lever');
  const leverPivot = new THREE.Group();
  leverPivot.name = 'leverPivot';
  leverPivot.position.set(0, 0.04, 0.008);
  lever.rotation.x = 0;
  leverPivot.add(lever);
  // ---- the hinged assembly: barrels, rib, bead, lumps, forend, chambered shells ----
  const bb = new PartBuilder();
  for (const w of [-1, 1]) {
    bb.add('blued', cyl(0.0112, 0.0, 0.56, bore, w * W, 22, 0.0099));
    bb.add('dark', cyl(0.0094, 0.556, 0.5605, bore, w * W, 18)); // muzzle bore shadow
  }
  bb.add('blued', rbox(0.0, 0.56, bore + 0.006, bore + 0.0118, -0.0045, 0.0045, 0.0012)); // top rib
  for (let i = 0; i < 16; i++) bb.add('dark', rbox(0.02 + i * 0.034, 0.024 + i * 0.034, bore + 0.0116, bore + 0.0121, -0.004, 0.004, 0.0003));
  bb.add('blued', rbox(0.0, 0.56, bore - 0.0118, bore - 0.006, -0.004, 0.004, 0.0012)); // bottom rib
  bb.add('brass', cyl(0.0019, 0.545, 0.549, bore + 0.0138, 0, 10));
  bb.add('blued', profile([[0.0, 0.006], [0.072, 0.006], [0.072, 0.017], [0.0, 0.019]], 0.03, { round: 0.003, bevel: 0.0015 })); // lumps
  // beavertail forend + its iron
  bb.add('walnut', profile([[0.082, 0.004], [0.082, -0.014], [0.1, -0.024], [0.29, -0.022], [0.305, -0.012], [0.305, 0.012], [0.29, 0.016], [0.082, 0.016]], 0.05, { round: 0.012, bevel: 0.004 }));
  bb.add('blued', profile([[0.078, 0.006], [0.078, -0.016], [0.11, -0.022], [0.11, 0.008]], 0.044, { round: 0.004, bevel: 0.0015 }));
  for (const w of [-1, 1]) bb.add('dark', profile([[0.15, -0.012], [0.26, -0.012], [0.26, 0.004], [0.15, 0.004]], 0.0006, { wc: w * 0.0252 }));
  const barrelBody = bb.build(mats, 'barrels');
  const shellPart = (name: string, w: number) => {
    const sb = new PartBuilder();
    sb.add('shell', cyl(0.0099, 0.004, 0.07, 0, 0, 16));
    sb.add('brass', cyl(0.0104, -0.002, 0.012, 0, 0, 16));
    sb.add('brass', cyl(0.0113, -0.0036, -0.0016, 0, 0, 16));
    const o = sb.build(mats, name);
    o.position.set(w, bore, 0);
    return o;
  };
  const shellL = shellPart('shellL', -W), shellR = shellPart('shellR', W);
  const abs = new THREE.Group(); // barrels built in action coordinates, shifted so the pivot is the hinge
  abs.position.copy(DB_HINGE).negate();
  abs.add(barrelBody, shellL, shellR);
  const barrels = new THREE.Group();
  barrels.name = 'barrelPivot';
  barrels.position.copy(DB_HINGE);
  barrels.add(abs);
  // the support hand's pair of fresh shells (and a single one): fed in from the hand
  const handShells = new THREE.Group();
  handShells.name = 'handShells';
  const hsL = shellPart('hsL', -W), hsR = shellPart('hsR', W);
  hsL.position.y = hsR.position.y = 0;
  handShells.add(hsL, hsR);
  handShells.visible = false;
  root.add(b.build(mats, 'body'), leverPivot, barrels, handShells);
  const sockets = addSockets(root, [
    socket('muzzle', 0.562, bore, W),
    socket('eject', -0.01, bore + 0.01, 0),
    socket('sight', -0.06, bore + 0.0185, 0),
    socket('loadPort', 0.0, bore + 0.01, 0),
  ]);
  const { rs, ls } = grips(root, [-0.112, -0.034, -0.62, 0.0168], { u: 0.2, v: -0.002, r: 0.026, fingers: [0.78, -0.18, -0.6], palm: [0.2, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  barrels.attach(ls); // the support hand rides the forend when the gun breaks
  return { root, parts: { barrels, lever: leverPivot, shellL, shellR, handShells, hsL, hsR }, sockets, adsDist: 0.22 };
}


// ======================================================================
// Combat knife (dedicated melee): clip-point blade with a fuller and a false edge, steel guard,
// ribbed rubber handle, pommel. Held forward-grip in the right hand; the left hand rides as a
// loose guard fist (socket only). The tip socket is where the kills land.
// ======================================================================
export function buildKnife(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'Knife';
  const b = new PartBuilder();
  // blade: profile in the (u, v) plane, thin in w
  b.add('stainless', profile([
    [0.0, -0.012], [0.12, -0.011], [0.16, -0.006], [0.185, 0.004], [0.15, 0.009], [0.11, 0.011], [0.0, 0.013],
  ], 0.0042, { bevel: 0.0014 }));
  b.add('dark', profile([[0.02, 0.002], [0.1, 0.003], [0.1, 0.0055], [0.02, 0.0055]], 0.0046)); // fuller
  b.add('steel', profile([[0.11, 0.0105], [0.15, 0.0085], [0.15, 0.0095], [0.11, 0.0118]], 0.0046)); // false edge
  // guard + handle + pommel
  b.add('steel', rbox(-0.008, 0.0, -0.022, 0.024, -0.009, 0.009, 0.002));
  b.add('rubber', cyl(0.0118, -0.105, -0.008, 0.0, 0, 16, 0.0128));
  for (let i = 0; i < 6; i++) b.add('dark', cyl(0.0131, -0.094 + i * 0.015, -0.089 + i * 0.015, 0.0, 0, 16));
  b.add('steel', lathe([[-0.122, 0.0], [-0.122, 0.009], [-0.112, 0.0135], [-0.105, 0.0128], [-0.105, 0.0]], 0.0, 0, 16));
  b.add('steel', pin(-0.116, 0.0, 0.0, 0.0028, 0.004));
  const blade = b.build(mats, 'knife');
  root.add(blade);
  const sockets = addSockets(root, [
    socket('muzzle', 0.185, 0.004, 0),
    socket('eject', 0.0, 0.0, 0),
    socket('sight', 0.0, 0.03, 0),
  ]);
  // forward grip: the fist closes round the handle (axis along the blade), thumb on the guard
  const { rs, ls } = grips(root, [-0.06, -0.004, -1.5, 0.0125], { u: 0.14, v: -0.035, r: 0.012, fingers: [0.4, 0.3, -0.9], palm: [1, 0.2, 0], x: -0.27 });
  ls.userData.pose = 'hold';
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { blade }, sockets, adsDist: 0.3 };
}

/** Throwing knife: one-piece skeletonised steel with a cord wrap (world projectile + held item). */
export function makeThrowingKnife(mats: WeaponMats) {
  const b = new PartBuilder();
  b.add('blued', profile([[0.0, -0.007], [0.1, -0.006], [0.135, 0.0], [0.1, 0.006], [0.0, 0.008], [-0.012, 0.004], [-0.012, -0.004]], 0.003, { bevel: 0.001 }));
  b.add('stainless', profile([[0.07, -0.0066], [0.13, -0.0012], [0.13, 0.0012], [0.07, 0.0066]], 0.0034));
  b.add('rubber', cyl(0.0068, -0.075, 0.0, 0.0, 0, 10, 0.0074));
  b.add('blued', cyl(0.004, -0.095, -0.075, 0.0, 0, 10));
  b.add('blued', new THREE.TorusGeometry(0.008, 0.0022, 6, 12).rotateY(Math.PI / 2).translate(0, 0, 0.102));
  return b.build(mats, 'tknife');
}


// ======================================================================
// KS-17 Modular Carbine (5.56, SCAR-L-style): long monolithic aluminium upper with a full-length
// top rail that runs out over the barrel, side and bottom rails up front with ribbed polymer
// covers, short polymer lower with an AR magwell, folding side-hinged stock with a stepped cheek
// piece and a tall butt, and a reciprocating charging handle on the LEFT.
// Iron sights in the chunky protected style: rear — a ring aperture between two thick rounded
// ears on a tall base; front — a hooded post in a protective ring on the front of the rail.
// The ADS socket sits in the aperture centre, level with the post tip.
// ======================================================================
export function buildKS17(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'KS17';
  const b = new PartBuilder();
  const bore = 0.043;
  const railTop = 0.0745;
  const aim = 0.1;
  // ---- upper receiver: tall, flat-sided, chamfered, running forward to u = 0.31 ----
  b.add('metal', profile([
    [-0.142, 0.02], [-0.142, 0.064], [-0.134, 0.068], [0.3, 0.068], [0.312, 0.062], [0.312, 0.022], [0.3, 0.016],
    [0.13, 0.016], [0.13, 0.02],
  ], 0.034, { bevel: 0.002, round: 0.003 }));
  // under-barrel part of the upper (the "handguard" is the upper itself)
  b.add('metal', profile([[0.13, 0.024], [0.13, 0.008], [0.14, 0.002], [0.3, 0.002], [0.312, 0.01], [0.312, 0.024]], 0.036, { bevel: 0.002, round: 0.004 }));
  // full-length top rail
  for (const g of picatinny(-0.134, 0.306, 0.068, 0, 0.022)) b.add('metal', g);
  // side rails (3 and 9 o'clock) with ribbed polymer ladder covers, bottom rail
  for (const w of [-1, 1]) {
    b.add('metal', rbox(0.165, 0.3, bore - 0.01, bore + 0.006, w * 0.018 - 0.002, w * 0.018 + 0.002, 0.001));
    for (let i = 0; i < 4; i++) {
      const u0 = 0.17 + i * 0.032;
      b.add('blackPoly', rbox(u0, u0 + 0.028, bore - 0.009, bore + 0.005, w * 0.0205 - 0.0025, w * 0.0205 + 0.0025, 0.0018));
      for (let k = 0; k < 3; k++) b.add('dark', rbox(u0 + 0.006 + k * 0.008, u0 + 0.008 + k * 0.008, bore - 0.008, bore + 0.004, w * 0.023 - 0.0004, w * 0.023 + 0.0004, 0.0003));
    }
  }
  for (const g of picatinny(0.17, 0.3, 0.002, 0, 0.018)) b.add('metal', g.rotateZ(Math.PI).translate(0, 0.004, 0));
  // receiver details: ejection port, slot for the charging handle (left), bolt catch, pins, screws
  b.add('dark', rbox(-0.03, 0.06, 0.03, 0.054, 0.0172, 0.0182, 0.001));
  b.add('dark', rbox(-0.06, 0.19, 0.046, 0.054, -0.0182, -0.0172, 0.001));
  for (const [u, v] of [[-0.11, 0.034], [0.0, 0.06], [0.09, 0.06], [0.2, 0.06], [0.27, 0.028]] as const) {
    b.add('steel', pin(u, v, 0.0175, 0.0026, 0.002));
    b.add('steel', pin(u, v, -0.0175, 0.0026, 0.002));
  }
  b.add('dark', rbox(0.02, 0.12, 0.059, 0.0605, 0.0172, 0.018, 0.0006)); // panel line
  // ---- barrel + flash hider (exposed past the upper) ----
  b.add('steel', cyl(0.0096, 0.31, 0.5, bore, 0, 20));
  b.add('steel', cyl(0.0122, 0.312, 0.328, bore, 0, 20)); // barrel nut
  b.add('metal', lathe([[0.495, 0.0], [0.495, 0.0108], [0.5, 0.0118], [0.555, 0.0118], [0.558, 0.0105], [0.558, 0.0055], [0.552, 0.0058], [0.552, 0.0]], bore, 0, 26));
  for (let i = 0; i < 4; i++) b.add('dark', aroundBore(rbox(0.51, 0.55, bore + 0.009, bore + 0.0122, -0.0018, 0.0018, 0.0008), bore, i * (Math.PI / 2) + Math.PI / 4));
  // ---- polymer lower (short: ends at the magwell), trigger guard, grip ----
  b.add('blackPoly', profile([[-0.118, 0.022], [0.112, 0.022], [0.112, 0.0], [0.104, -0.05], [0.03, -0.05], [0.028, -0.013], [-0.036, -0.013], [-0.064, -0.02], [-0.108, -0.006], [-0.12, 0.012]], 0.031, { bevel: 0.0018, round: 0.003 }));
  b.add('blackPoly', rbox(0.026, 0.108, -0.057, -0.038, -0.0172, 0.0172, 0.003)); // flared magwell
  b.add('blackPoly', profile([[-0.04, -0.03], [0.03, -0.03], [0.034, -0.026], [0.034, -0.014], [0.029, -0.014], [0.028, -0.025], [-0.036, -0.025], [-0.04, -0.017]], 0.012, { bevel: 0.0012 }));
  b.add('steel', pin(-0.094, 0.012, 0.0158, 0.0028));
  b.add('steel', pin(0.094, 0.012, 0.0158, 0.0028));
  // ambi selector, mag-release paddle behind the well, bolt catch
  for (const w of [-1, 1]) b.add('metal', rbox(-0.07, -0.05, 0.004, 0.012, w * 0.0158 - 0.0015, w * 0.0158 + 0.0015, 0.001));
  b.add('metal', rbox(0.014, 0.028, -0.024, -0.016, -0.009, 0.009, 0.0015));
  b.add('metal', rbox(0.04, 0.066, 0.004, 0.016, -0.0182, -0.0152, 0.0012));
  b.add('polymer', profile(pistolGrip(), 0.03, { round: 0.008, bevel: 0.004 }));
  // ---- folding stock: hinge block, stepped cheek piece, tall butt with a toe ----
  b.add('blackPoly', rbox(-0.168, -0.142, 0.004, 0.066, -0.019, 0.019, 0.004)); // hinge block
  b.add('steel', cyl(0.004, -0.158, -0.152, 0.035, 0.02, 10)); // hinge pin head
  b.add('blackPoly', profile([
    [-0.168, 0.064], [-0.3, 0.064], [-0.31, 0.074], [-0.405, 0.074], [-0.418, 0.068], [-0.425, -0.1], [-0.414, -0.11], [-0.395, -0.106],
    [-0.39, -0.05], [-0.3, -0.03], [-0.2, -0.004], [-0.168, 0.006],
  ], 0.036, { round: 0.008, bevel: 0.004 }));
  for (let i = 0; i < 4; i++) b.add('dark', rbox(-0.29 + i * 0.03, -0.272 + i * 0.03, 0.04, 0.05, 0.0182, 0.0188, 0.0008)); // adjustment ribs
  b.add('rubber', rbox(-0.44, -0.424, -0.11, 0.076, -0.021, 0.021, 0.005));
  b.add('steel', cyl(0.005, -0.41, -0.4, -0.09, 0.02, 10)); // QD cup
  // ---- iron sights (protected style): the eye looks OVER a low, wide rear block whose two chunky
  // ears frame the bottom of the view, at a slim front tower carrying a small ring hood around
  // the post — the hood centred on the crosshair, the post tip level with the sight line ----
  b.add('metal', rbox(-0.122, -0.08, railTop, railTop + 0.007, -0.0175, 0.0175, 0.0025)); // clamp base
  b.add('metal', rbox(-0.114, -0.09, railTop + 0.006, aim - 0.017, -0.0155, 0.0155, 0.0025)); // body
  for (const w of [-1, 1]) {
    // ears: tall, thin blades either side with rounded tops, still below the sight line
    b.add('metal', profile([[-0.116, 0.0], [-0.088, 0.0], [-0.088, 0.013], [-0.092, 0.019], [-0.112, 0.019], [-0.116, 0.013]].map(([u, v]) => [u, v + aim - 0.0225] as P2), 0.0034, { wc: w * 0.0152, round: 0.002, bevel: 0.0007 }));
  }
  // thin aperture leaf between the ears: a wide shallow notch the front sight sits in
  b.add('metal', profile([[-0.103, 0.0], [-0.1, 0.0], [-0.1, 0.0045], [-0.103, 0.0045]].map(([u, v]) => [u, v + aim - 0.0175] as P2), 0.012, { round: 0.0006 }));
  // front: clamp on the end of the rail, a thin blade tower, a large thin ring hood, a fine post
  b.add('metal', rbox(0.272, 0.294, railTop, railTop + 0.007, -0.0095, 0.0095, 0.002));
  b.add('metal', profile([[0.278, 0.0], [0.288, 0.0], [0.2865, 0.012], [0.2855, aim - railTop - 0.0175], [0.2805, aim - railTop - 0.0175], [0.2795, 0.012]].map(([u, v]) => [u, v + railTop + 0.006] as P2), 0.003, { round: 0.0008, bevel: 0.0004 }));
  b.add('metal', new THREE.TorusGeometry(0.0088, 0.00062, 6, 40).translate(0, aim, -0.283));
  b.add('metal', rbox(0.2815, 0.2845, aim - 0.0115, aim - 0.0088, -0.0009, 0.0009, 0.0003)); // hood foot
  b.add('steel', rbox(0.2822, 0.2838, aim - 0.0075, aim, -0.00055, 0.00055, 0.0002)); // post
  // ---- moving parts ----
  const pb = new PartBuilder();
  pb.add('steel', rbox(-0.02, 0.055, 0.032, 0.052, 0.0128, 0.0168, 0.0012));
  const bolt = pb.build(mats, 'bolt');
  const cb = new PartBuilder();
  cb.add('steel', rbox(0.09, 0.104, 0.046, 0.054, -0.026, -0.017, 0.0012));
  cb.add('metal', cyl(0.0058, 0.088, 0.106, 0.05, -0.034, 14).rotateZ(0));
  cb.add('rubber', rbox(0.086, 0.108, 0.043, 0.057, -0.044, -0.03, 0.004));
  const charge = cb.build(mats, 'charge');
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.004, 0.0);
  const mag = stanagMag(mats);
  mag.position.set(0, -0.035, -0.066);
  root.add(b.build(mats, 'body'), bolt, charge, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.558, bore, 0),
    socket('eject', 0.02, 0.044, 0.02),
    socket('sight', -0.101, aim, 0),
    socket('magWell', 0.066, -0.035, 0),
  ]);
  const { rs, ls } = grips(root, [-0.079, -0.058, -0.25, 0.015], { u: 0.235, v: bore - 0.008, r: 0.0265, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.27, bore + 0.002, 0.0235);
  return { root, parts: { bolt, charge, trigger, mag }, sockets, adsDist: 0.08 };
}


/**
 * Collimated reticle (any pattern): the texture is projected at infinity — each pixel is looked up
 * by the angle between the view ray and the sight axis — so the reticle stays on target however
 * the head moves and is only seen through the window. `half` = angular half-size of the texture.
 */
function collimatedReticle(tex: THREE.Texture, color: THREE.Color, half: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: { uTex: { value: tex }, uCol: { value: color }, uHalf: { value: half } },
    vertexShader: /* glsl */ `varying vec3 vRay; varying vec3 vAx; varying vec3 vRt; varying vec3 vUp; varying vec2 vUv; varying vec3 vN;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vRay = mv.xyz;
        vAx = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vRt = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        vUp = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform sampler2D uTex; uniform vec3 uCol; uniform float uHalf;
      varying vec3 vRay; varying vec3 vAx; varying vec3 vRt; varying vec3 vUp; varying vec2 vUv; varying vec3 vN;
      void main(){
        vec3 r = normalize(vRay);
        float a = dot(r, vAx);
        vec2 ang = vec2(dot(r, vRt), dot(r, vUp)) / max(a, 1e-3);
        vec2 st = 0.5 + ang / (2.0 * uHalf);
        float m = (a > 0.0 && st.x > 0.0 && st.x < 1.0 && st.y > 0.0 && st.y < 1.0) ? texture2D(uTex, st).a : 0.0;
        float ndv = abs(dot(normalize(vN), -r));
        float fres = pow(1.0 - ndv, 3.0);
        float edge = smoothstep(0.75, 1.0, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
        float ga = 0.014 + fres * 0.3 + edge * 0.05;
        vec3 col = mix(vec3(0.5, 0.85, 0.7), vec3(1.0, 0.6, 0.3), edge) * 0.45 * ga + uCol * m;
        gl_FragColor = vec4(col, clamp(ga + m, 0.0, 1.0));
      }`,
  });
}

/**
 * "Kestrel" box reflex: a squared, armoured housing with a full hood over a tall rectangular window
 * (thick front frame, a slanted top shroud), side-mounted brightness buttons and a battery
 * cylinder on the right. Reticle: a 2-MOA dot inside a broken 50-MOA circle with four inner ticks,
 * collimated. Returns the optical axis height and the rear edge (for the ADS socket).
 */
function boxReflex(b: PartBuilder, u0: number, railTop: number, mats: WeaponMats, root: THREE.Group) {
  const L = 0.058, W = 0.0155, B = railTop + 0.016, Tp = railTop + 0.044;
  const axis = (B + Tp) / 2 + 0.001;
  // quick-detach mount with a throw lever
  b.add('metal', rbox(u0 - 0.002, u0 + L - 0.004, railTop, railTop + 0.009, -0.0135, 0.0135, 0.0018));
  b.add('metal', rbox(u0 + 0.012, u0 + 0.034, railTop + 0.001, railTop + 0.006, -0.019, -0.0135, 0.0015));
  // base housing
  b.add('metal', rbox(u0, u0 + L, railTop + 0.008, B, -W - 0.004, W + 0.004, 0.0025));
  // hood: side walls + top roof, front frame thicker, rear walls cut low at the top corners
  for (const sgn of [-1, 1]) {
    b.add('metal', profile([[u0 + 0.004, B], [u0 + L, B], [u0 + L, Tp + 0.002], [u0 + 0.024, Tp + 0.002], [u0 + 0.004, B + 0.012]], 0.004, { wc: sgn * (W + 0.002), bevel: 0.0009 }));
  }
  b.add('metal', profile([[u0 + 0.02, Tp], [u0 + L, Tp], [u0 + L + 0.002, Tp + 0.006], [u0 + 0.026, Tp + 0.0045]], W * 2 + 0.008, { bevel: 0.0012 }));
  b.add('metal', rbox(u0 + L - 0.006, u0 + L, B - 0.001, B + 0.004, -W - 0.003, W + 0.003, 0.001)); // front sill
  // controls: rubber buttons on the left, battery tube on the right, windage screw on top
  for (const i of [0, 1]) b.add('rubber', rbox(u0 + 0.008 + i * 0.012, u0 + 0.016 + i * 0.012, railTop + 0.01, B - 0.002, -W - 0.0055, -W - 0.0035, 0.0012));
  b.add('metal', cyl(0.0058, u0 + 0.006, u0 + 0.03, railTop + 0.014, W + 0.0075, 16));
  b.add('steel', cyl(0.0046, u0 + 0.004, u0 + 0.008, railTop + 0.014, W + 0.0075, 14));
  b.add('steel', pin(u0 + 0.04, Tp + 0.005, 0, 0.0022, 0.0024, 'y'));
  // front glass (faint coating) and the rear collimated reticle window
  const ww = W * 2, wh = Tp - B;
  const front = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), coatedGlass(0.8));
  front.position.set(0, (B + Tp) / 2, -(u0 + L - 0.003));
  front.renderOrder = 9;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.strokeStyle = x.fillStyle = '#fff';
  x.lineWidth = 7;
  for (let i = 0; i < 4; i++) {
    const a0 = i * (Math.PI / 2) + 0.2, a1 = (i + 1) * (Math.PI / 2) - 0.2;
    x.beginPath(); x.arc(128, 128, 96, a0, a1); x.stroke();
  }
  x.lineWidth = 5;
  for (let i = 0; i < 4; i++) {
    const a = i * (Math.PI / 2);
    x.beginPath(); x.moveTo(128 + Math.cos(a) * 70, 128 + Math.sin(a) * 70); x.lineTo(128 + Math.cos(a) * 86, 128 + Math.sin(a) * 86); x.stroke();
  }
  x.beginPath(); x.arc(128, 128, 8, 0, Math.PI * 2); x.fill();
  const tex = new THREE.CanvasTexture(c);
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), collimatedReticle(tex, new THREE.Color(8.5, 0.5, 0.18), 0.052));
  rear.position.set(0, axis, -(u0 + 0.008));
  rear.rotation.y = Math.PI;
  rear.renderOrder = 10;
  root.add(front, rear);
  return { axis, rear: u0 };
}

// ======================================================================
// UMS-45 submachine gun (.45, UMP-style): long slab-sided polymer receiver with a full-length top
// rail and a short side rail up front, stubby barrel with a thread protector, straight 25-round
// box, pistol grip with a paddle mag release behind the well, side-folding skeleton stock, and
// the non-reciprocating charging handle forward on the LEFT (the empty reload pulls and slaps it).
// Carries the Kestrel box reflex instead of irons.
// ======================================================================
export function buildUMS45(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'UMS45';
  const b = new PartBuilder();
  const bore = 0.036;
  const railTop = 0.07;
  // ---- receiver: one long polymer slab, chamfered top edges, tapering nose ----
  b.add('blackPoly', profile([
    [-0.145, -0.002], [-0.145, 0.058], [-0.138, 0.064], [0.218, 0.064], [0.232, 0.054], [0.236, 0.03], [0.232, 0.004], [0.2, -0.004],
    [0.11, -0.004], [0.1, -0.012], [0.036, -0.012], [0.03, -0.004],
  ], 0.042, { round: 0.004, bevel: 0.0025 }));
  for (const w of [-1, 1]) {
    // moulded side panel lines, screws, the side rail up front
    b.add('dark', rbox(-0.12, 0.2, 0.034, 0.0355, w * 0.0212 - 0.0004, w * 0.0212 + 0.0004, 0.0004));
    for (const u of [-0.1, 0.0, 0.11, 0.21]) b.add('steel', pin(u, 0.046, w * 0.021, 0.0028, 0.002));
    if (w < 0) continue;
  }
  b.add('metal', rbox(0.12, 0.218, 0.012, 0.03, 0.021, 0.0245, 0.0012));
  for (let i = 0; i < 9; i++) b.add('dark', rbox(0.124 + i * 0.0105, 0.1285 + i * 0.0105, 0.012, 0.03, 0.0242, 0.0252, 0.0004));
  b.add('steel', pin(0.13, 0.021, 0.026, 0.004, 0.002));
  b.add('steel', pin(0.21, 0.021, 0.026, 0.004, 0.002));
  b.add('dark', rbox(-0.03, 0.05, 0.03, 0.052, 0.0205, 0.0215, 0.001)); // ejection port (right)
  b.add('dark', rbox(0.07, 0.2, 0.048, 0.056, -0.0215, -0.0205, 0.0008)); // charging-handle slot (left)
  // full-length top rail
  for (const g of picatinny(-0.132, 0.214, 0.064, 0, 0.021)) b.add('metal', g);
  // ---- barrel stub + thread protector ----
  b.add('steel', cyl(0.009, 0.232, 0.262, bore, 0, 18));
  b.add('metal', cyl(0.0105, 0.255, 0.278, bore, 0, 20));
  for (let i = 0; i < 6; i++) b.add('dark', cyl(0.0108, 0.258 + i * 0.003, 0.2595 + i * 0.003, bore, 0, 20));
  // ---- magwell, paddle release, trigger guard, grip, selector ----
  b.add('blackPoly', rbox(0.034, 0.108, -0.03, -0.004, -0.0185, 0.0185, 0.003));
  b.add('blackPoly', rbox(0.02, 0.034, -0.028, -0.014, -0.012, 0.012, 0.002)); // paddle
  b.add('blackPoly', profile([[-0.05, -0.004], [0.022, -0.004], [0.026, -0.012], [0.024, -0.04], [0.004, -0.046], [-0.044, -0.046], [-0.054, -0.036]], 0.013, { bevel: 0.0012, holes: [[[-0.042, -0.012], [0.016, -0.012], [0.014, -0.038], [-0.038, -0.04]]] }));
  b.add('polymer', profile(pistolGrip(-0.01, 0.006), 0.031, { round: 0.009, bevel: 0.004 }));
  for (let i = 0; i < 4; i++) b.add('dark', rbox(-0.1 + i * 0.006, -0.096 + i * 0.006, -0.1, -0.05, 0.0158, 0.0164, 0.0004)); // grip texture
  for (const w of [-1, 1]) {
    b.add('metal', cyl(0.007, -0.046, -0.042, 0.02, w * 0.0218, 14));
    b.add('metal', rbox(-0.05, -0.038, 0.018, 0.022, w * 0.0225 - 0.0012, w * 0.0225 + 0.0012, 0.0006));
  }
  // ---- side-folding skeleton stock: hinge block, triangular frame, butt plate ----
  b.add('blackPoly', rbox(-0.17, -0.145, -0.002, 0.06, -0.018, 0.018, 0.004));
  b.add('steel', cyl(0.0042, -0.162, -0.155, 0.03, -0.019, 10));
  b.add('blackPoly', profile([
    [-0.17, 0.056], [-0.4, 0.056], [-0.418, 0.06], [-0.426, 0.05], [-0.428, -0.098], [-0.414, -0.108], [-0.4, -0.1], [-0.392, -0.06],
    [-0.2, -0.006], [-0.17, 0.0],
  ], 0.03, { round: 0.006, bevel: 0.003, holes: [
    [[-0.19, 0.04], [-0.39, 0.04], [-0.39, -0.035], [-0.21, 0.006]],
    [[-0.405, 0.036], [-0.415, 0.036], [-0.414, -0.08], [-0.405, -0.072]],
  ] }));
  b.add('rubber', rbox(-0.442, -0.426, -0.108, 0.062, -0.017, 0.017, 0.004));
  // ---- Kestrel box reflex on the rail ----
  const sight = boxReflex(b, -0.06, railTop - 0.006, mats, root);
  // ---- moving parts ----
  const cb = new PartBuilder();
  cb.add('steel', rbox(0.17, 0.184, 0.05, 0.056, -0.028, -0.02, 0.0012));
  cb.add('blackPoly', cyl(0.0058, 0.168, 0.19, 0.053, -0.036, 14));
  cb.add('blackPoly', rbox(0.17, 0.188, 0.049, 0.06, -0.046, -0.036, 0.003));
  const charge = cb.build(mats, 'charge');
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.01, 0.0);
  const mb = new PartBuilder();
  mb.add('blackPoly', profile([[-0.028, 0.006], [0.028, 0.006], [0.03, -0.004], [0.032, -0.165], [0.026, -0.176], [-0.024, -0.176], [-0.03, -0.165], [-0.03, -0.004]], 0.026, { round: 0.003, bevel: 0.002 }));
  mb.add('blackPoly', rbox(-0.03, 0.033, -0.186, -0.17, -0.0145, 0.0145, 0.003)); // base plate
  for (const w of [-1, 1]) {
    for (const u of [-0.016, 0.016]) mb.add('dark', rbox(u - 0.0012, u + 0.0012, -0.15, -0.03, w * 0.0131 - 0.0004, w * 0.0131 + 0.0004, 0.0003));
    for (let i = 0; i < 3; i++) mb.add('dark', cyl(0.0022, -0.006 + i * 0.006, -0.004 + i * 0.006, -0.06, w * 0.0133, 8));
  }
  mb.add('brass', cyl(0.0058, -0.018, 0.012, 0.006, 0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.012, -0.071);
  root.add(b.build(mats, 'body'), charge, trigger, mag);
  const sockets = addSockets(root, [
    socket('muzzle', 0.278, bore, 0),
    socket('eject', 0.01, 0.042, 0.022),
    socket('sight', sight.rear, sight.axis, 0),
    socket('magWell', 0.071, -0.012, 0),
  ]);
  const { rs, ls } = grips(root, [-0.089, -0.052, -0.25, 0.0155], { u: 0.17, v: 0.012, r: 0.024, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.135, 0.021, 0.0262);
  return { root, parts: { charge, trigger, mag }, sockets, adsDist: 0.2 };
}


// ======================================================================
// KVL-7 "Bjørn" light machine gun (5.56, belt-fed from a 100-round box). Wide square receiver
// with a feed cover hinged at the front (the optic rides on it), a soft-sided ammo box hanging
// under the left side with the belt running up into the feed tray, heavy barrel under a
// perforated heat shield, folding carry handle, gas tube, and a folding bipod under the front.
// Moving parts: cover (pivot), belt, mag (the box), charge, trigger, bipodL / bipodR (pivots).
// ======================================================================
export const LMG_COVER_PIVOT = new THREE.Vector3(0, 0.077, -0.168);
export function buildLMG(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'KVL7';
  const b = new PartBuilder();
  const bore = 0.046;
  // ---- receiver: wide, squared, with a raised feed tray block ----
  b.add('metal', profile([[-0.15, 0.0], [-0.15, 0.062], [-0.142, 0.07], [0.168, 0.07], [0.176, 0.06], [0.176, 0.008], [0.16, -0.004], [0.12, -0.004], [0.112, -0.014], [-0.03, -0.014], [-0.05, -0.006], [-0.14, -0.004]], 0.05, { bevel: 0.002, round: 0.002 }));
  // side plates, rivets, the ejection chute underneath
  for (const w of [-1, 1]) {
    b.add('metal', rbox(-0.13, 0.16, 0.008, 0.06, w * 0.025 - 0.0012, w * 0.025 + 0.0012, 0.0008));
    for (const u of [-0.11, -0.06, 0.0, 0.06, 0.12]) for (const v of [0.016, 0.052]) b.add('steel', pin(u, v, w * 0.0262, 0.0022, 0.0012));
  }
  b.add('dark', rbox(-0.01, 0.07, -0.02, -0.012, -0.012, 0.012, 0.002)); // ejection port (down)
  // feed tray mouth on the left, belt guide lip
  b.add('metal', rbox(0.03, 0.115, 0.042, 0.068, -0.044, -0.025, 0.003));
  b.add('dark', rbox(0.036, 0.109, 0.046, 0.064, -0.0445, -0.03, 0.002));
  // box latch housing under the receiver (left)
  b.add('metal', rbox(0.016, 0.134, -0.016, -0.004, -0.058, -0.008, 0.003));
  // trigger group, guard and pistol grip
  b.add('metal', profile([[-0.06, -0.014], [0.03, -0.014], [0.034, -0.03], [0.03, -0.044], [-0.04, -0.044], [-0.062, -0.03]], 0.024, { bevel: 0.0015, round: 0.002 }));
  b.add('metal', profile([[-0.044, -0.04], [0.03, -0.04], [0.034, -0.036], [0.034, -0.026], [0.029, -0.026], [0.028, -0.035], [-0.04, -0.035], [-0.044, -0.03]], 0.012, { bevel: 0.0012 }));
  b.add('polymer', profile(pistolGrip(0, -0.012), 0.032, { round: 0.008, bevel: 0.004 }));
  b.add('metal', rbox(-0.075, -0.055, -0.006, 0.006, 0.026, 0.031, 0.0015)); // selector
  // ---- stock: fixed polymer with a cheek rest and a butt plate ----
  b.add('polymer', profile([[-0.15, 0.058], [-0.2, 0.06], [-0.43, 0.066], [-0.45, 0.07], [-0.462, 0.062], [-0.466, -0.06], [-0.452, -0.074], [-0.43, -0.07], [-0.36, -0.04], [-0.24, -0.012], [-0.15, -0.004]], 0.042, { round: 0.008, bevel: 0.004, holes: [[[-0.25, 0.034], [-0.4, 0.04], [-0.41, -0.024], [-0.37, -0.026], [-0.27, 0.006]]] }));
  b.add('polymer', rbox(-0.38, -0.24, 0.058, 0.078, -0.021, 0.021, 0.008)); // cheek rest
  b.add('rubber', rbox(-0.48, -0.464, -0.078, 0.074, -0.023, 0.023, 0.005));
  b.add('steel', cyl(0.006, -0.41, -0.4, -0.05, 0.024, 12)); // sling swivel
  // ---- barrel, heat shield, gas tube, handguard ----
  b.add('steel', cyl(0.0125, 0.176, 0.62, bore, 0, 22));
  b.add('metal', cyl(0.0175, 0.176, 0.215, bore, 0, 20)); // trunnion collar
  b.add('metal', lathe([[0.61, 0.0], [0.61, 0.0135], [0.62, 0.0145], [0.67, 0.0145], [0.676, 0.012], [0.676, 0.007], [0.67, 0.0072], [0.67, 0.0]], bore, 0, 28));
  for (let i = 0; i < 5; i++) b.add('dark', aroundBore(rbox(0.628, 0.668, bore + 0.0115, bore + 0.0148, -0.0018, 0.0018, 0.0008), bore, i * (Math.PI * 2 / 5)));
  // heat shield over the barrel (top half), with vent slots
  {
    const hs = new THREE.CylinderGeometry(0.02, 0.02, 0.22, 16, 1, true, -Math.PI / 2, Math.PI);
    hs.rotateX(-Math.PI / 2);
    hs.translate(0, bore, -(0.22 + 0.11));
    b.add('metal', hs);
    for (let i = 0; i < 8; i++) for (const a of [-0.6, 0, 0.6]) b.add('dark', aroundBore(rbox(0.232 + i * 0.026, 0.248 + i * 0.026, bore + 0.0195, bore + 0.0205, -0.0028, 0.0028, 0.0008), bore, a));
  }
  b.add('steel', cyl(0.0068, 0.176, 0.5, bore - 0.029, 0, 14)); // gas tube
  b.add('metal', rbox(0.485, 0.515, bore - 0.04, bore + 0.012, -0.013, 0.013, 0.004)); // gas block
  // lower handguard with rail underneath (for the support hand) and side scallops
  b.add('polymer', profile([[0.176, bore - 0.012], [0.44, bore - 0.012], [0.452, bore - 0.02], [0.452, bore - 0.05], [0.44, bore - 0.058], [0.176, bore - 0.058]], 0.052, { round: 0.006, bevel: 0.003 }));
  for (let i = 0; i < 5; i++) for (const w of [-1, 1]) b.add('dark', rbox(0.2 + i * 0.045, 0.232 + i * 0.045, bore - 0.045, bore - 0.025, w * 0.0262 - 0.0006, w * 0.0262 + 0.0006, 0.002));
  for (const g of picatinny(0.21, 0.43, bore - 0.0625, 0, 0.021)) b.add('metal', aroundBore(g, bore - 0.06, Math.PI));
  // folding carry handle on the barrel collar
  b.add('metal', rbox(0.25, 0.27, bore + 0.018, bore + 0.03, -0.006, 0.006, 0.002));
  b.add('polymer', rbox(0.21, 0.33, bore + 0.028, bore + 0.04, -0.008, 0.008, 0.005));
  // bipod mount clamp
  b.add('metal', cyl(0.017, 0.455, 0.48, bore - 0.004, 0, 18));
  // ---- feed cover (hinged at its front edge, lifts at the rear) with rail + red dot ----
  const coverPivot = new THREE.Group();
  coverPivot.name = 'cover';
  coverPivot.position.copy(LMG_COVER_PIVOT);
  const coverInner = new THREE.Group();
  coverInner.position.copy(LMG_COVER_PIVOT).negate();
  coverPivot.add(coverInner);
  const cb = new PartBuilder();
  cb.add('metal', profile([[-0.06, 0.07], [-0.06, 0.088], [-0.052, 0.094], [0.16, 0.094], [0.17, 0.086], [0.17, 0.07]], 0.054, { bevel: 0.002, round: 0.003 }));
  cb.add('metal', rbox(-0.075, -0.058, 0.074, 0.09, -0.012, 0.012, 0.003)); // rear latch tab
  cb.add('steel', cyl(0.0045, 0.162, 0.17, 0.077, 0, 12));
  for (const g of picatinny(-0.05, 0.16, 0.094)) cb.add('metal', g);
  const sightAxis = redDot(cb, 0.02, 0.0985, mats, coverInner);
  coverInner.add(cb.build(mats, 'coverBody'));
  // feed tray under the cover: visible when it is open
  b.add('steel', rbox(0.03, 0.115, 0.066, 0.07, -0.026, 0.024, 0.001));
  for (let i = 0; i < 3; i++) b.add('dark', rbox(0.036, 0.109, 0.0695, 0.0705, -0.02 + i * 0.016, -0.016 + i * 0.016, 0.0004));
  // ---- the belt: rounds side by side (pointing forward) from the box up into the tray ----
  const bb = new PartBuilder();
  const path: [number, number][] = [];
  for (let i = 0; i < 6; i++) path.push([-0.05 + i * 0.002, -0.015 + i * 0.012]); // up the left side
  for (let i = 0; i < 5; i++) path.push([-0.04 + i * 0.0112, 0.058]); // across the feed tray
  for (const [w, v] of path) {
    bb.add('brass', cyl(0.0029, 0.042, 0.088, v, w, 8));
    bb.add('copper', lathe([[0.088, 0.0029], [0.094, 0.0024], [0.101, 0.0], [0.088, 0.0]], v, w, 8));
    bb.add('steel', rbox(0.05, 0.062, v - 0.0035, v + 0.0035, w - 0.0034, w + 0.0034, 0.0008)); // link
  }
  const belt = bb.build(mats, 'belt');
  // ---- 100-round box: soft OD case on a rigid frame, strap, window ----
  const mb = new PartBuilder();
  mb.add('od', rbox(-0.055, 0.055, -0.13, 0.0, -0.033, 0.033, 0.009));
  mb.add('od', rbox(-0.058, 0.058, -0.135, -0.118, -0.035, 0.035, 0.006));
  mb.add('rubber', rbox(-0.012, 0.012, -0.132, 0.002, -0.0345, 0.0345, 0.002)); // strap
  mb.add('steel', rbox(-0.045, 0.045, -0.006, 0.004, -0.031, 0.031, 0.002)); // latch frame
  mb.add('dark', rbox(-0.03, 0.03, -0.05, -0.02, -0.0335, -0.032, 0.002)); // window
  mb.add('brass', rbox(-0.026, 0.026, -0.046, -0.024, -0.0332, -0.031, 0.001));
  const mag = mb.build(mats, 'mag');
  mag.position.set(-0.026, -0.006, -0.075);
  // ---- charging handle (right side) and trigger ----
  const chb = new PartBuilder();
  chb.add('metal', rbox(0.07, 0.1, 0.03, 0.044, 0.025, 0.03, 0.002));
  chb.add('polymer', rbox(0.076, 0.094, 0.026, 0.048, 0.03, 0.05, 0.004));
  const charge = chb.build(mats, 'charge');
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.026], [-0.004, -0.024], [0.0, -0.016], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.016, 0.0);
  // ---- bipod: two legs on pivots under the front, folded forward along the barrel ----
  const bipod: THREE.Group[] = [];
  for (const w of [-1, 1]) {
    const piv = new THREE.Group();
    piv.name = w < 0 ? 'bipodL' : 'bipodR';
    piv.position.set(w * 0.012, bore - 0.02, -0.468);
    const lb = new PartBuilder();
    lb.add('metal', rbox(-0.008, 0.008, -0.11, 0.0, -0.005, 0.005, 0.003));
    lb.add('steel', cyl(0.0042, -0.004, 0.004, -0.115, 0, 10));
    lb.add('steel', rbox(-0.005, 0.005, -0.19, -0.1, -0.0035, 0.0035, 0.002)); // extension
    lb.add('rubber', lathe([[-0.012, 0.0], [-0.012, 0.007], [0.006, 0.006], [0.006, 0.0]], -0.195, 0, 10)); // foot
    lb.add('steel', cyl(0.005, -0.006, 0.006, 0, 0, 10)); // pivot pin
    const leg = lb.build(mats, 'leg');
    // the lathe foot is built along the bore axis: stand it up
    piv.add(leg);
    piv.userData.w = w;
    bipod.push(piv);
  }
  const setBipod = (k: number) => {
    for (const piv of bipod) {
      // folded: legs swung forward under the barrel; deployed: straight down, splayed out
      piv.rotation.set((1 - k) * (Math.PI / 2 - 0.08), 0, (piv.userData.w as number) * 0.22 * k);
    }
  };
  setBipod(0);
  root.userData.setBipod = setBipod;
  root.add(b.build(mats, 'body'), coverPivot, belt, mag, charge, trigger, ...bipod);
  const sockets = addSockets(root, [
    socket('muzzle', 0.676, bore, 0),
    socket('eject', 0.03, -0.02, 0.0),
    socket('sight', 0.026, sightAxis, 0),
    socket('magWell', 0.075, -0.006, -0.026),
  ]);
  const { rs, ls } = grips(root, [-0.079, -0.07, -0.25, 0.0155], { u: 0.3, v: bore - 0.034, r: 0.027, fingers: [0.75, -0.4, -0.5], palm: [0.3, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.4, bore - 0.034, 0.0262);
  return { root, parts: { cover: coverPivot, belt, mag, charge, trigger, bipodL: bipod[0], bipodR: bipod[1] }, sockets, adsDist: 0.2 };
}


// ======================================================================
// Stille-9 integrally suppressed 9 mm SMG (roller-delayed, MP5SD pattern). Proportions from a
// side reference at ~1.5 mm/px: rounded-top stamped receiver with the cocking tube running
// forward over the suppressor, front sight = hooded ring with a post on the end of the tube,
// rear sight = rotary diopter drum sitting low between two tall knurled ears (looking down the
// sights the hooded post sits in the notch between the ears — the classic sight picture),
// polymer trigger group with an enclosed guard and a fat finger-grooved grip, curved 30-round
// magazine with a paddle release behind the well, collapsible twin-rail stock.
// Moving parts: charge (HK slap cocking handle on a pivot at the tube axis), trigger, mag, mag2.
// ======================================================================
export const SD9 = { tubeV: 0.032, sightV: 0.061, handleU: 0.255 };
export function buildStille9(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'Stille9';
  const b = new PartBuilder();
  const bore = 0.0;
  const sv = SD9.sightV;
  // ---- receiver: flat-sided box with a fully rounded top, front tapering into the tube ----
  b.add('metal', rbox(-0.165, 0.128, -0.032, 0.014, -0.0205, 0.0205, 0.002));
  b.add('metal', cyl(0.0205, -0.165, 0.128, 0.014, 0, 24));
  // stamped side ribs and the long indentation, cross pins
  for (const w of [-1, 1]) {
    b.add('dark', rbox(-0.13, 0.09, -0.006, -0.003, w * 0.0207 - 0.0004, w * 0.0207 + 0.0004, 0.0004));
    b.add('metal', rbox(-0.12, 0.08, 0.004, 0.012, w * 0.0206, w * 0.0218, 0.002));
    for (const u of [-0.135, 0.095]) b.add('steel', pin(u, -0.022, w * 0.021, 0.0026, 0.0012));
  }
  // claw-mount dimples on top
  for (const u of [-0.095, -0.03, 0.05]) b.add('dark', rbox(u, u + 0.008, 0.033, 0.0345, -0.007, 0.007, 0.001));
  // ejection port (right) with the brass deflector bump behind it, the bolt face in the port
  b.add('dark', rbox(-0.02, 0.045, -0.006, 0.02, 0.0198, 0.0212, 0.001));
  b.add('steel', rbox(-0.018, 0.043, -0.002, 0.016, 0.0185, 0.0196, 0.0008));
  b.add('metal', rbox(-0.04, -0.022, 0.0, 0.016, 0.0205, 0.0245, 0.003));
  // rear end cap and stock housing block
  b.add('metal', rbox(-0.18, -0.162, -0.034, 0.03, -0.022, 0.022, 0.003));
  // ---- cocking tube forward over the suppressor, slot + notch on the left ----
  const tv = SD9.tubeV;
  b.add('metal', cyl(0.0118, 0.12, 0.3, tv, 0, 20));
  b.add('metal', cyl(0.0128, 0.288, 0.302, tv, 0, 20));
  b.add('dark', rbox(0.19, 0.27, tv - 0.0035, tv + 0.0035, -0.0124, -0.0112, 0.0006));
  b.add('dark', rbox(0.19, 0.2, tv - 0.0035, tv + 0.009, -0.0122, -0.0108, 0.0006)); // the notch at the rear of the slot
  // ---- front sight: base on the tube end, hood ring with a post ----
  b.add('metal', rbox(0.272, 0.302, tv + 0.006, tv + 0.018, -0.008, 0.008, 0.002));
  b.add('metal', lathe([[0.276, 0.0128], [0.276, 0.0158], [0.298, 0.0158], [0.298, 0.0128], [0.276, 0.0128]], sv, 0, 32));
  for (const w of [-1, 1]) b.add('metal', rbox(0.278, 0.296, tv + 0.012, sv - 0.009, w * 0.0112 - 0.0024, w * 0.0112 + 0.0024, 0.001));
  b.add('steel', rbox(0.285, 0.289, tv + 0.012, sv, -0.0009, 0.0009, 0.0003));
  // ---- rear sight: base block, two tall knurled ears, the diopter drum low between them ----
  b.add('metal', rbox(-0.138, -0.096, 0.03, 0.043, -0.019, 0.019, 0.003));
  for (const w of [-1, 1]) {
    // low knurled wedges: tops just under the sight line, inner faces slanting out
    b.add('metal', profile([[-0.136, 0.042], [-0.136, sv - 0.004], [-0.128, sv + 0.003], [-0.106, sv + 0.003], [-0.098, sv - 0.003], [-0.098, 0.042]], 0.0092, { round: 0.003, bevel: 0.0014, wc: w * 0.0142 }));
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) b.add('dark', rbox(-0.133 + i * 0.006, -0.1302 + i * 0.006, 0.046 + j * 0.0055, 0.0482 + j * 0.0055, w * 0.0189 - 0.0004, w * 0.0189 + 0.0004, 0.0004));
    for (let i = 0; i < 5; i++) b.add('dark', rbox(-0.133 + i * 0.006, -0.1302 + i * 0.006, sv + 0.0028, sv + 0.0034, w * 0.0142 - 0.0035, w * 0.0142 + 0.0035, 0.0003));
  }
  b.add('steel', cyl(0.0115, -0.124, -0.11, 0.045, 0, 20)); // drum (axis fore-aft, top just under the sight line)
  b.add('dark', cyl(0.0035, -0.11, -0.109, 0.045, 0, 10));
  b.add('steel', cyl(0.0022, -0.118, -0.116, 0.058, 0.0, 8)); // windage screw head
  // ---- polymer trigger group: enclosed guard, finger-grooved grip, selector ----
  b.add('blackPoly', profile([[-0.15, -0.032], [0.03, -0.032], [0.034, -0.04], [0.03, -0.044], [-0.03, -0.044], [-0.15, -0.04]], 0.038, { round: 0.003, bevel: 0.002 }));
  b.add('blackPoly', profile([[-0.034, -0.044], [0.032, -0.044], [0.036, -0.05], [0.032, -0.074], [0.024, -0.08], [-0.016, -0.08], [-0.03, -0.072]], 0.014, { round: 0.003, bevel: 0.0015, holes: [[[-0.022, -0.048], [0.026, -0.048], [0.026, -0.07], [0.018, -0.074], [-0.012, -0.074], [-0.02, -0.066]]] }));
  b.add('blackPoly', profile([
    [-0.03, -0.044], [-0.03, -0.075], [-0.036, -0.088], [-0.034, -0.104], [-0.04, -0.118], [-0.038, -0.134], [-0.046, -0.15], [-0.05, -0.158],
    [-0.09, -0.158], [-0.094, -0.15], [-0.088, -0.11], [-0.084, -0.07], [-0.09, -0.048], [-0.1, -0.044],
  ], 0.034, { round: 0.009, bevel: 0.004 }));
  for (let i = 0; i < 5; i++) for (const w of [-1, 1]) b.add('dark', rbox(-0.08 + i * 0.002, -0.048 + i * 0.001, -0.09 - i * 0.012, -0.084 - i * 0.012, w * 0.0168 - 0.0004, w * 0.0168 + 0.0004, 0.0004));
  b.add('metal', rbox(-0.098, -0.07, -0.036, -0.028, -0.024, -0.0195, 0.002)); // selector lever (left)
  b.add('metal', cyl(0.004, -0.088, -0.084, -0.032, -0.0215, 10));
  // ---- magazine well and paddle release ----
  b.add('metal', rbox(0.046, 0.098, -0.046, -0.028, -0.016, 0.016, 0.002));
  b.add('metal', profile([[0.034, -0.044], [0.046, -0.044], [0.046, -0.06], [0.036, -0.064], [0.03, -0.058]], 0.012, { round: 0.002, bevel: 0.001 }));
  // ---- integral suppressor (barrel shroud) with a ribbed handguard sleeve ----
  b.add('metal', cyl(0.0215, 0.12, 0.47, bore, 0, 28));
  b.add('metal', lathe([[0.462, 0.0], [0.462, 0.0222], [0.474, 0.0222], [0.478, 0.019], [0.478, 0.006], [0.476, 0.0045], [0.476, 0.0]], bore, 0, 28));
  b.add('dark', cyl(0.0045, 0.477, 0.479, bore, 0, 14));
  b.add('polymer', cyl(0.0265, 0.13, 0.31, bore, 0, 24));
  for (let i = 0; i < 10; i++) b.add('dark', cyl(0.0268, 0.142 + i * 0.016, 0.146 + i * 0.016, bore, 0, 24));
  b.add('metal', cyl(0.0235, 0.118, 0.132, bore, 0, 24)); // locking collar
  // ---- collapsible stock: twin curved rails each side and a butt plate ----
  for (const w of [-1, 1]) for (const v of [0.012, -0.022]) {
    b.add('steel', cyl(0.0035, -0.34, -0.17, v, w * 0.0195, 10));
  }
  b.add('metal', profile([[-0.33, 0.028], [-0.346, 0.034], [-0.352, 0.0], [-0.352, -0.07], [-0.344, -0.08], [-0.33, -0.04]], 0.046, { round: 0.004, bevel: 0.002 }));
  b.add('rubber', rbox(-0.36, -0.35, -0.082, 0.036, -0.023, 0.023, 0.004));
  b.add('steel', rbox(-0.19, -0.172, 0.022, 0.032, -0.006, 0.006, 0.002)); // stock latch
  // ---- moving parts ----
  // cocking handle: built around the tube axis so it can be pulled back and rotated up into the notch
  const ch = new PartBuilder();
  ch.add('metal', rbox(SD9.handleU - 0.006, SD9.handleU + 0.006, -0.003, 0.003, -0.034, -0.011, 0.0015));
  ch.add('blackPoly', cyl(0.0058, SD9.handleU - 0.012, SD9.handleU + 0.002, 0.0, -0.036, 14));
  const chg = ch.build(mats, 'chargeBody');
  const charge = new THREE.Group();
  charge.name = 'charge';
  charge.position.set(0, tv, 0);
  charge.add(chg);
  const tb = new PartBuilder();
  tb.add('metal', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.024], [-0.004, -0.022], [0.0, -0.014], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.046, -0.005);
  // the curved 9 mm thirty: strongly curved, ribbed sides, small base plate
  const magBuild = () => {
    const mb = new PartBuilder();
    const front = bez([0.016, 0.0], [0.02, -0.09], [0.052, -0.19], 10);
    const rear = bez([0.022, -0.188], [-0.008, -0.095], [-0.014, 0.0], 10);
    mb.add('metal', profile([...front, ...rear], 0.0215, { round: 0.003, bevel: 0.002 }));
    mb.add('metal', profile([[0.056, -0.186], [0.06, -0.198], [0.018, -0.2], [0.016, -0.19]], 0.025, { round: 0.002, bevel: 0.002 }));
    for (let i = 0; i < 3; i++) {
      const t = 0.25 + i * 0.22;
      const v = -0.19 * t, uc = -0.006 + 0.04 * t * t;
      for (const w of [-1, 1]) mb.add('dark', rbox(uc, uc + 0.022, v - 0.03, v, w * 0.0109 - 0.0004, w * 0.0109 + 0.0004, 0.0004));
    }
    mb.add('brass', cyl(0.0048, -0.008, 0.012, 0.002, 0, 10));
    mb.add('copper', lathe([[0.012, 0.0], [0.012, 0.0048], [0.019, 0.003], [0.021, 0.0]], 0.002, 0, 10));
    return mb.build(mats, 'mag');
  };
  const mag = magBuild();
  mag.position.set(0, -0.032, -0.07);
  const mag2 = magBuild();
  mag2.name = 'mag2';
  mag2.visible = false;
  root.add(b.build(mats, 'body'), charge, trigger, mag, mag2);
  const sockets = addSockets(root, [
    socket('muzzle', 0.479, bore, 0),
    socket('eject', 0.012, 0.006, 0.022),
    socket('sight', -0.118, sv, 0),
    socket('magWell', 0.07, -0.032, 0),
  ]);
  const { rs, ls } = grips(root, [-0.066, -0.098, -0.18, 0.0168], { u: 0.22, v: bore - 0.004, r: 0.0265, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.3, bore, 0.027);
  return { root, parts: { charge, trigger, mag, mag2 }, sockets, adsDist: 0.22 };
}

// ======================================================================
// MP-18 machine pistol (9 mm, select fire): long-slide polymer pistol with a ported slide nose,
// a selector on the slide's rear left, a 33-round extended magazine and a folding wire stock
// hinged on the right of the frame tail. Folded, the stock lies forward along the right flank;
// it flicks out round to the right and locks behind the grip when you aim.
// Moving parts: slide, trigger, mag, stock (pivot), selector.
// ======================================================================
export function buildMP18(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'MP18';
  const b = new PartBuilder();
  const bore = 0.032;
  const sightTop = 0.0575;
  // ---- frame: longer dust cover with a rail, squared guard, raked grip, magwell flare ----
  b.add('blackPoly', profile([[-0.07, 0.0165], [0.128, 0.0165], [0.13, 0.012], [0.128, 0.0], [0.086, -0.002], [0.05, -0.004], [0.046, -0.012], [-0.028, -0.012], [-0.04, -0.006], [-0.066, 0.006], [-0.09, 0.01], [-0.095, 0.015], [-0.08, 0.0165]], 0.027, { round: 0.003, bevel: 0.002 }));
  for (let i = 0; i < 4; i++) b.add('dark', rbox(0.078 + i * 0.012, 0.0825 + i * 0.012, -0.0025, 0.002, -0.0132, 0.0132, 0.0006));
  b.add('blackPoly', profile([[-0.03, -0.012], [0.046, -0.012], [0.052, -0.016], [0.052, -0.033], [0.046, -0.037], [-0.022, -0.037], [-0.028, -0.032], [-0.026, -0.029], [-0.02, -0.032], [0.043, -0.032], [0.047, -0.029], [0.047, -0.016], [0.043, -0.016], [-0.025, -0.016]], 0.012, { round: 0.0015, bevel: 0.001 }));
  const rk = Math.tan(0.36);
  const gu = (u: number, v: number) => u + rk * v;
  b.add('blackPoly', profile([
    [-0.03, -0.012], [gu(-0.026, -0.03), -0.03], [gu(-0.03, -0.05), -0.05], [gu(-0.026, -0.07), -0.07], [gu(-0.03, -0.09), -0.09], [gu(-0.026, -0.112), -0.112], [gu(-0.022, -0.12), -0.12],
    [gu(-0.072, -0.12), -0.12], [gu(-0.068, -0.108), -0.108], [gu(-0.066, -0.06), -0.06], [gu(-0.064, -0.02), -0.02], [-0.072, 0.004], [-0.09, 0.01],
  ], 0.03, { round: 0.008, bevel: 0.004 }));
  for (const w of [0.0152, -0.0152]) for (let i = 0; i < 7; i++) {
    const v = -0.03 - i * 0.012;
    b.add('dark', rbox(gu(-0.06, v), gu(-0.034, v), v - 0.007, v - 0.004, w - 0.0003, w + 0.0003, 0.001));
  }
  // flared magwell funnel at the grip base
  b.add('blackPoly', rbox(gu(-0.078, -0.12), gu(-0.018, -0.12), -0.128, -0.118, -0.018, 0.018, 0.003));
  // stock hinge lug on the right of the frame tail
  b.add('metal', rbox(-0.092, -0.076, -0.004, 0.012, 0.012, 0.02, 0.002));
  b.add('steel', cyl(0.0036, -0.088, -0.08, 0.004, 0.0165, 10));
  b.add('metal', rbox(-0.004, 0.022, 0.011, 0.0165, -0.0148, -0.013, 0.0008)); // slide stop
  b.add('blackPoly', rbox(-0.036, -0.027, -0.02, -0.011, -0.016, -0.014, 0.002)); // mag release
  // ---- slide: long, with a three-port compensator nose and the selector at the back ----
  const sb = new PartBuilder();
  sb.add('metal', profile([[-0.074, 0.0165], [-0.074, 0.046], [0.128, 0.046], [0.132, 0.043], [0.132, 0.0165]], 0.025, { round: 0.0015, bevel: 0.0016 }));
  sb.add('metal', profile([[-0.073, 0.045], [-0.073, 0.0485], [-0.07, 0.0505], [0.125, 0.0505], [0.13, 0.0475], [0.13, 0.045]], 0.02, { round: 0.0015, bevel: 0.0022 }));
  for (let i = 0; i < 3; i++) sb.add('dark', rbox(0.1 + i * 0.009, 0.106 + i * 0.009, 0.049, 0.051, -0.005, 0.005, 0.002)); // comp ports on top
  for (let i = 0; i < 7; i++) for (const w of [0.0126, -0.0126]) sb.add('dark', rbox(-0.07 + i * 0.0036, -0.0688 + i * 0.0036, 0.02, 0.0445, w - 0.0005, w + 0.0005, 0.0004));
  sb.add('dark', rbox(0.0, 0.05, 0.03, 0.0498, 0.0115, 0.0127, 0.0008));
  sb.add('steel', rbox(0.004, 0.047, 0.04, 0.0496, 0.007, 0.012, 0.0008));
  sb.add('steel', rbox(-0.0712, -0.06, 0.0505, sightTop - 0.003, -0.009, 0.009, 0.0008));
  for (const sgn of [1, -1]) sb.add('steel', rbox(-0.0712, -0.06, sightTop - 0.0032, sightTop, sgn * 0.0018, sgn * 0.009, 0.0006));
  sb.add('steel', rbox(0.088, 0.095, 0.0505, sightTop, -0.0017, 0.0017, 0.0005));
  sb.add('steel', cyl(0.0056, 0.128, 0.1325, bore, 0, 18));
  sb.add('dark', cyl(0.0046, 0.1325, 0.133, bore, 0, 18));
  // selector: a small rotary lever on the slide's rear left
  sb.add('metal', cyl(0.005, -0.066, -0.06, 0.036, -0.0135, 12));
  sb.add('metal', rbox(-0.068, -0.058, 0.03, 0.046, -0.016, -0.0135, 0.0012));
  const slide = sb.build(mats, 'slide');
  const fdot = new THREE.Mesh(new THREE.CircleGeometry(0.0012, 14), mats.tritium);
  fdot.position.set(0, sightTop - 0.0018, -0.0878);
  fdot.rotation.y = Math.PI;
  slide.add(fdot);
  for (const sgn of [1, -1]) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 14), mats.tritium);
    dot.position.set(sgn * 0.0054, sightTop - 0.0018, 0.0713);
    dot.rotation.y = Math.PI;
    slide.add(dot);
  }
  const tb = new PartBuilder();
  tb.add('blackPoly', profile([[0.004, 0.0], [0.006, -0.01], [0.004, -0.019], [-0.002, -0.023], [-0.004, -0.021], [0.0, -0.014], [-0.001, 0.0]], 0.0058, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.006, -0.012);
  // ---- 33-round extended magazine: long steel body, grippy polymer extension ----
  const mb = new PartBuilder();
  mb.add('metal', profile([[0.006, 0.0], [-0.002, -0.04], [-0.012, -0.1], [-0.02, -0.165], [-0.048, -0.168], [-0.04, -0.1], [-0.03, -0.04], [-0.022, 0.0]], 0.0205, { round: 0.002, bevel: 0.0015 }));
  mb.add('blackPoly', profile([[-0.014, -0.15], [-0.018, -0.176], [-0.022, -0.182], [-0.056, -0.182], [-0.058, -0.176], [-0.05, -0.15]], 0.025, { round: 0.003, bevel: 0.002 }));
  for (let i = 0; i < 4; i++) for (const w of [-1, 1]) mb.add('dark', rbox(-0.052 + i * 0.008, -0.048 + i * 0.008, -0.178, -0.154, w * 0.0126 - 0.0004, w * 0.0126 + 0.0004, 0.0004));
  mb.add('brass', cyl(0.0045, -0.016, 0.004, 0.003, 0, 10));
  mb.add('copper', lathe([[0.004, 0.0], [0.004, 0.0045], [0.01, 0.002], [0.012, 0.0]], 0.003, 0, 10));
  const mag = mb.build(mats, 'mag');
  mag.position.set(0, -0.004, 0.048);
  // ---- folding stock: built deployed (pointing back from the hinge), folded = turned forward ----
  const stb = new PartBuilder();
  const L = 0.2;
  for (const v of [0.0, -0.034]) stb.add('steel', cyl(0.0032, -L, 0.0, v, 0.0, 10));
  stb.add('steel', rbox(-0.012, 0.004, -0.036, 0.004, -0.004, 0.004, 0.002)); // hinge knuckle
  stb.add('blackPoly', profile([[-L + 0.01, 0.012], [-L - 0.008, 0.016], [-L - 0.016, 0.0], [-L - 0.016, -0.05], [-L - 0.006, -0.058], [-L + 0.01, -0.044]], 0.034, { round: 0.004, bevel: 0.002 }));
  const stockBody = stb.build(mats, 'stockBody');
  const stock = new THREE.Group();
  stock.name = 'stock';
  stock.position.set(0.0165, 0.004, 0.084);
  stock.add(stockBody);
  stock.rotation.y = Math.PI; // folded
  root.add(b.build(mats, 'body'), slide, trigger, mag, stock);
  const sockets = addSockets(root, [
    socket('muzzle', 0.134, bore, 0),
    socket('eject', 0.024, 0.044, 0.014),
    socket('sight', -0.0712, sightTop, 0),
    socket('magWell', -0.048, -0.004, 0),
  ]);
  const { rs, ls } = grips(root, [-0.068, -0.048, -0.36, 0.0148], { u: -0.058, v: -0.074, r: 0.027, fingers: [0.1, -0.85, -0.5], palm: [1, 0, 0.12] });
  ls.userData.fist = true;
  ls.userData.pose = 'pistolSupport';
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { slide, trigger, mag, stock }, sockets, adsDist: 0.3 };
}


// ======================================================================
// HVAL-47 assault rifle (7.62x39, AKM pattern): stamped receiver with a ribbed dust cover, the
// tangent rear sight on the trunnion block, gas tube under a wooden upper guard, flared lower
// handguard, slant muzzle brake, big right-side safety lever, laminated wood stock and grip and a
// strongly curved steel thirty with a front locking lug (it rocks in and out around that lug).
// Moving parts: charge (carrier handle, right side), trigger, mag, mag2.
// ======================================================================
export const AK = { bore: 0.03, sightV: 0.064, pivot: new THREE.Vector3(0, 0.0, -0.034) };
export function buildHval47(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'HVAL47';
  const b = new PartBuilder();
  const bore = AK.bore;
  const sv = AK.sightV;
  // ---- receiver + ribbed dust cover ----
  b.add('metal', rbox(-0.16, 0.17, -0.032, 0.032, -0.0165, 0.0165, 0.002));
  b.add('metal', cyl(0.0168, -0.158, 0.118, 0.034, 0, 20));
  for (let i = 0; i < 3; i++) b.add('metal', rbox(-0.13 + i * 0.07, -0.11 + i * 0.07, 0.049, 0.0515, -0.004, 0.004, 0.0015));
  b.add('steel', rbox(-0.166, -0.156, 0.026, 0.044, -0.004, 0.004, 0.002)); // cover latch button
  for (const w of [-1, 1]) {
    b.add('dark', rbox(-0.14, 0.15, -0.012, -0.009, w * 0.0167 - 0.0004, w * 0.0167 + 0.0004, 0.0004));
    for (const u of [-0.14, -0.05, 0.03, 0.14]) b.add('steel', pin(u, -0.022, w * 0.0168, 0.0022, 0.001));
  }
  b.add('dark', rbox(0.0, 0.1, 0.008, 0.03, 0.0158, 0.0172, 0.001)); // ejection / handle slot (right)
  // safety lever: the long plate on the right with its finger tab
  b.add('steel', profile([[-0.12, 0.006], [0.06, 0.018], [0.064, 0.012], [-0.115, -0.002], [-0.124, -0.008], [-0.13, 0.0]], 0.003, { bevel: 0.0006, wc: 0.0182 }));
  // ---- trunnion block + rear tangent sight (leaf with a notch at the sight line) ----
  b.add('metal', rbox(0.112, 0.175, 0.026, 0.052, -0.0135, 0.0135, 0.003));
  b.add('metal', rbox(0.118, 0.17, 0.052, 0.056, -0.009, 0.009, 0.0015)); // leaf
  for (const w of [-1, 1]) b.add('metal', rbox(0.118, 0.126, 0.056, sv, w * 0.0018, w * 0.0075, 0.0006)); // notch shoulders
  b.add('steel', rbox(0.15, 0.158, 0.05, 0.059, -0.0105, 0.0105, 0.0012)); // range slider
  // ---- barrel, gas block, gas tube, front sight, slant brake ----
  b.add('steel', cyl(0.0088, 0.17, 0.52, bore, 0, 18));
  b.add('metal', rbox(0.4, 0.43, bore - 0.012, sv - 0.008, -0.011, 0.011, 0.003)); // gas block
  b.add('metal', cyl(0.0098, 0.17, 0.41, bore + 0.026, 0, 16)); // gas tube
  b.add('metal', rbox(0.47, 0.505, bore - 0.012, bore + 0.016, -0.0105, 0.0105, 0.003)); // front sight base
  b.add('metal', lathe([[0.478, 0.009], [0.478, 0.0115], [0.498, 0.0115], [0.498, 0.009], [0.478, 0.009]], sv - 0.004, 0, 20)); // hood ring (open-topped look via the post)
  b.add('steel', rbox(0.486, 0.49, bore + 0.012, sv, -0.001, 0.001, 0.0003)); // post
  b.add('metal', lathe([[0.515, 0.0], [0.515, 0.012], [0.556, 0.012], [0.556, 0.0]], bore, 0, 18)); // slant brake
  b.add('dark', rbox(0.53, 0.55, bore + 0.006, bore + 0.0125, -0.006, 0.006, 0.002)); // brake cut (top-left)
  b.add('steel', cyl(0.003, 0.2, 0.47, bore - 0.016, 0.0, 8)); // cleaning rod
  // ---- wood: upper guard over the gas tube, flared lower handguard, grip, stock ----
  b.add('walnut', rbox(0.19, 0.38, bore + 0.016, bore + 0.04, -0.0145, 0.0145, 0.008));
  b.add('walnut', profile([[0.18, bore + 0.014], [0.38, bore + 0.014], [0.39, bore + 0.006], [0.39, bore - 0.03], [0.37, bore - 0.04], [0.2, bore - 0.04], [0.18, bore - 0.034]], 0.044, { round: 0.006, bevel: 0.004 }));
  for (const w of [-1, 1]) b.add('walnut', rbox(0.23, 0.36, bore - 0.02, bore - 0.004, w * 0.0225 - 0.003, w * 0.0225 + 0.002, 0.003)); // finger swells
  b.add('steel', rbox(0.168, 0.182, bore - 0.04, bore + 0.018, -0.0225, 0.0225, 0.002)); // retainer
  // trigger guard + pistol grip
  b.add('steel', profile([[-0.05, -0.032], [0.04, -0.032], [0.044, -0.036], [0.044, -0.052], [0.04, -0.056], [-0.042, -0.056], [-0.05, -0.05], [-0.046, -0.046], [-0.04, -0.05], [0.038, -0.05], [0.04, -0.046], [0.04, -0.036], [-0.046, -0.036]], 0.012, { round: 0.0015, bevel: 0.001 }));
  b.add('walnut', profile([[-0.046, -0.032], [-0.05, -0.06], [-0.06, -0.1], [-0.068, -0.13], [-0.1, -0.13], [-0.096, -0.1], [-0.088, -0.06], [-0.086, -0.032]], 0.03, { round: 0.008, bevel: 0.004 }));
  b.add('walnut', profile([[-0.16, 0.026], [-0.53, 0.004], [-0.545, 0.004], [-0.548, -0.118], [-0.53, -0.12], [-0.3, -0.07], [-0.2, -0.04], [-0.16, -0.032]], 0.036, { round: 0.008, bevel: 0.004 }));
  b.add('steel', rbox(-0.556, -0.545, -0.12, 0.006, -0.018, 0.018, 0.002)); // butt plate
  b.add('steel', cyl(0.005, -0.44, -0.43, -0.092, 0.018, 10)); // sling loop
  // magwell + paddle release
  b.add('metal', rbox(0.055, 0.12, -0.042, -0.03, -0.0155, 0.0155, 0.002));
  b.add('steel', profile([[0.044, -0.034], [0.054, -0.034], [0.056, -0.05], [0.05, -0.054], [0.044, -0.05]], 0.012, { round: 0.002, bevel: 0.001 }));
  // ---- moving parts ----
  const cb = new PartBuilder();
  cb.add('steel', rbox(0.11, 0.135, 0.012, 0.024, 0.016, 0.03, 0.002));
  cb.add('steel', cyl(0.0065, 0.112, 0.134, 0.018, 0.034, 12));
  const charge = cb.build(mats, 'charge');
  const tb = new PartBuilder();
  tb.add('steel', profile([[0.004, -0.0], [0.006, -0.012], [0.004, -0.021], [-0.002, -0.024], [-0.004, -0.022], [0.0, -0.014], [-0.001, -0.0]], 0.006, { bevel: 0.0008, round: 0.0015 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.034, -0.0);
  const magBuild = () => {
    const mb = new PartBuilder();
    const front = bez([0.034, 0.0], [0.044, -0.12], [0.112, -0.22], 12);
    const rear = bez([0.072, -0.236], [0.0, -0.13], [-0.03, 0.0], 12);
    mb.add('metal', profile([...front, ...rear], 0.023, { round: 0.003, bevel: 0.002 }));
    mb.add('metal', profile([[0.112, -0.214], [0.12, -0.226], [0.078, -0.246], [0.07, -0.234]], 0.026, { round: 0.002, bevel: 0.002 })); // floorplate
    for (let i = 0; i < 4; i++) {
      const t = 0.18 + i * 0.19;
      const v = -0.22 * t, uc = -0.02 + 0.07 * t * t + 0.02 * t;
      for (const w of [-1, 1]) mb.add('dark', rbox(uc, uc + 0.045, v - 0.004, v, w * 0.0116 - 0.0005, w * 0.0116 + 0.0005, 0.0004));
    }
    mb.add('steel', rbox(0.03, 0.04, -0.004, 0.004, -0.006, 0.006, 0.001)); // front lug
    mb.add('brass', cyl(0.0056, -0.02, 0.016, 0.002, 0, 10));
    mb.add('copper', lathe([[0.016, 0.0], [0.016, 0.0056], [0.026, 0.0035], [0.029, 0.0]], 0.002, 0, 10));
    return mb.build(mats, 'mag');
  };
  const mag = magBuild();
  mag.position.set(0, -0.032, -0.07);
  const mag2 = magBuild();
  mag2.name = 'mag2';
  mag2.visible = false;
  root.add(b.build(mats, 'body'), charge, trigger, mag, mag2);
  const sockets = addSockets(root, [
    socket('muzzle', 0.556, bore, 0),
    socket('eject', 0.05, 0.02, 0.018),
    socket('sight', 0.122, sv, 0),
    socket('magWell', 0.07, -0.032, 0),
  ]);
  const { rs, ls } = grips(root, [-0.072, -0.072, -0.3, 0.0155], { u: 0.29, v: bore - 0.014, r: 0.024, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  addLaser(root, sockets, mats, 0.34, bore - 0.014, 0.025);
  return { root, parts: { charge, trigger, mag, mag2 }, sockets, adsDist: 0.24 };
}

// ======================================================================
// KR-98k bolt-action carbine (7.92 mm, Mauser pattern): full-length walnut stock with a
// semi-pistol wrist, two barrel bands, a cleaning rod, tangent rear sight with a V-notch and a
// hooded front post, a controlled-feed bolt with a turned-down handle, a five-round internal
// magazine under a floorplate and stripper-clip guides on the receiver bridge.
// Moving parts: bolt (lifts & draws back on the bore axis; knob at the same place as the other
// bolt guns so the cycling hand finds it), trigger, magRounds (five cartridges in the magazine,
// shown through the open action), clip (a loaded stripper clip), hround (one cartridge in hand).
// ======================================================================
export const KAR = { bore: 0.04, sightV: 0.071, guideU: -0.045, knob: new THREE.Vector3(0.05, -0.03, 0.046) };
function cartridge(b: PartBuilder, u0: number, v: number, w: number) {
  // 7.92x57: rimless bottleneck case ~57 mm, spitzer bullet; pointing forward from u0
  b.add('brass', lathe([[u0, 0.0], [u0, 0.0058], [u0 + 0.004, 0.0058], [u0 + 0.0045, 0.0052], [u0 + 0.046, 0.0056], [u0 + 0.05, 0.0044], [u0 + 0.057, 0.0042], [u0 + 0.057, 0.0]], v, w, 10));
  b.add('copper', lathe([[u0 + 0.057, 0.0], [u0 + 0.057, 0.0041], [u0 + 0.066, 0.0036], [u0 + 0.078, 0.0], [u0 + 0.057, 0.0]], v, w, 10));
}
export function buildKR98(mats: WeaponMats): WeaponModel {
  const root = new THREE.Group();
  root.name = 'KR98';
  const b = new PartBuilder();
  const bore = KAR.bore;
  const sv = KAR.sightV;
  // ---- receiver: round action with the bridge, the open loading port on top, clip guides ----
  b.add('blued', cyl(0.0168, -0.09, -0.04, bore, 0, 22)); // rear bridge
  b.add('blued', cyl(0.0175, 0.04, 0.13, bore, 0, 22)); // front ring
  for (const w of [-1, 1]) b.add('blued', rbox(-0.04, 0.04, bore - 0.0165, bore + 0.006, w * 0.0148 - 0.002, w * 0.0148 + 0.002, 0.001)); // port walls
  b.add('blued', rbox(-0.04, 0.04, bore - 0.02, bore - 0.0155, -0.0165, 0.0165, 0.001)); // magazine well floor line
  for (const w of [-1, 1]) b.add('blued', rbox(KAR.guideU - 0.008, KAR.guideU + 0.006, bore + 0.014, bore + 0.022, w * 0.0085 - 0.0018, w * 0.0085 + 0.0018, 0.0006)); // stripper guides
  b.add('blued', rbox(-0.075, -0.035, bore - 0.002, bore + 0.006, 0.016, 0.022, 0.002)); // bolt stop
  // ---- barrel, bands, front sight with hood, rear tangent sight ----
  b.add('blued', lathe([[0.13, 0.0], [0.13, 0.0135], [0.2, 0.0118], [0.3, 0.0105], [0.62, 0.0088], [0.64, 0.0088], [0.64, 0.0]], bore, 0, 20));
  b.add('blued', rbox(0.17, 0.235, bore + 0.008, bore + 0.018, -0.0105, 0.0105, 0.003)); // sight base
  b.add('blued', rbox(0.185, 0.23, bore + 0.018, bore + 0.024, -0.0085, 0.0085, 0.0015)); // leaf
  for (const w of [-1, 1]) b.add('blued', profile([[0.186, bore + 0.022], [0.186, sv + 0.002], [0.194, sv + 0.002], [0.194, bore + 0.022]], 0.0055, { bevel: 0.0005, wc: w * 0.0038 }));
  b.add('dark', rbox(0.186, 0.194, sv - 0.004, sv + 0.0025, -0.0012, 0.0012, 0.0004)); // the V
  b.add('steel', rbox(0.205, 0.215, bore + 0.016, bore + 0.026, -0.011, 0.011, 0.0015)); // slider
  b.add('blued', rbox(0.6, 0.64, bore + 0.006, bore + 0.016, -0.0075, 0.0075, 0.002)); // front base
  b.add('steel', rbox(0.617, 0.621, bore + 0.012, sv, -0.0011, 0.0011, 0.0003)); // post
  b.add('blued', lathe([[0.605, 0.0095], [0.605, 0.0118], [0.635, 0.0118], [0.635, 0.0095], [0.605, 0.0095]], sv - 0.003, 0, 20)); // hood
  for (const u of [0.33, 0.5]) b.add('blued', lathe([[u, 0.0], [u, 0.0215], [u + 0.022, 0.0215], [u + 0.022, 0.0]], bore - 0.008, 0, 18)); // bands
  b.add('steel', cyl(0.0032, 0.42, 0.64, bore - 0.022, 0, 8)); // cleaning rod
  b.add('steel', cyl(0.0042, 0.635, 0.645, bore - 0.022, 0, 8));
  // ---- stock: full-length walnut, semi-pistol wrist, upper handguard ----
  b.add('walnut', profile([
    [0.6, bore - 0.004], [0.6, bore - 0.028], [0.13, bore - 0.034], [0.09, bore - 0.04], [0.09, -0.012], [0.02, -0.012], [-0.04, -0.012],
    [-0.08, -0.03], [-0.1, -0.075], [-0.135, -0.085], [-0.16, -0.06], [-0.5, -0.12], [-0.6, -0.128], [-0.62, -0.122], [-0.62, 0.032],
    [-0.6, 0.036], [-0.32, 0.03], [-0.13, 0.022], [-0.1, bore - 0.004], [0.13, bore - 0.006], [0.13, bore + 0.004],
  ], 0.042, { round: 0.006, bevel: 0.004, holes: [] }));
  b.add('walnut', rbox(0.2, 0.33, bore + 0.006, bore + 0.018, -0.0125, 0.0125, 0.005)); // upper handguard
  b.add('dark', rbox(-0.4, -0.34, -0.06, -0.04, 0.0205, 0.0215, 0.003)); // disc / marking
  b.add('steel', rbox(-0.63, -0.62, -0.126, 0.034, -0.02, 0.02, 0.002)); // butt plate
  // trigger guard + floorplate
  b.add('blued', profile([[-0.04, -0.012], [0.085, -0.012], [0.085, -0.022], [0.0, -0.022], [-0.02, -0.03], [-0.04, -0.034], [-0.05, -0.028], [-0.044, -0.018]], 0.012, { round: 0.002, bevel: 0.001, holes: [[[-0.036, -0.02], [-0.022, -0.024], [-0.012, -0.018]]] }));
  b.add('blued', rbox(-0.02, 0.085, -0.016, -0.011, -0.0125, 0.0125, 0.002));
  // ---- bolt: body on the bore axis, turned-down handle with a pear knob, cocking piece & flag ----
  const bb = new PartBuilder();
  bb.add('steel', cyl(0.0088, -0.06, 0.08, 0, 0, 16));
  bb.add('steel', cyl(0.0105, -0.105, -0.06, 0, 0, 14)); // shroud / cocking piece
  bb.add('steel', rbox(-0.1, -0.09, 0.006, 0.016, -0.003, 0.003, 0.001)); // safety flag
  // turned-down handle: root at the bolt body, swept down and back to the pear knob
  {
    const a = new THREE.Vector3(0.008, 0.0, 0.04), k = KAR.knob.clone();
    const len = a.distanceTo(k);
    const arm = new THREE.CylinderGeometry(0.0038, 0.0042, len, 8);
    arm.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), k.clone().sub(a).normalize()));
    arm.translate((a.x + k.x) / 2, (a.y + k.y) / 2, (a.z + k.z) / 2);
    bb.add('steel', arm);
  }
  const knob = new THREE.SphereGeometry(0.0092, 14, 10);
  knob.scale(1, 1.25, 1.05);
  knob.translate(KAR.knob.x, KAR.knob.y, KAR.knob.z);
  bb.add('steel', knob);
  const bolt = bb.build(mats, 'bolt');
  bolt.position.set(0, bore, 0.0);
  // ---- the five rounds in the magazine (top first), staggered; shown through the open port ----
  const magRounds = new THREE.Group();
  magRounds.name = 'magRounds';
  for (let i = 0; i < 5; i++) {
    const rb = new PartBuilder();
    cartridge(rb, -0.03, bore - 0.009 - i * 0.0085, (i % 2 ? 1 : -1) * 0.0042);
    const r = rb.build(mats, 'r' + i);
    magRounds.add(r);
  }
  magRounds.visible = false;
  // ---- a loaded stripper clip: steel strip with five rounds stacked in it ----
  const cl = new PartBuilder();
  cl.add('steel', rbox(-0.006, 0.0, -0.046, 0.002, -0.0072, 0.0072, 0.0006));
  for (const w of [-1, 1]) cl.add('steel', rbox(-0.006, 0.004, -0.046, 0.002, w * 0.0072 - 0.0007, w * 0.0072, 0.0004));
  const clip = new THREE.Group();
  clip.name = 'clip';
  clip.add(cl.build(mats, 'strip'));
  for (let i = 0; i < 5; i++) {
    const rb = new PartBuilder();
    cartridge(rb, -0.003, -0.004 - i * 0.0088, 0);
    const r = rb.build(mats, 'c' + i);
    clip.add(r);
  }
  clip.visible = false;
  // a single cartridge for hand loading
  const hb = new PartBuilder();
  cartridge(hb, -0.039, 0, 0);
  const hround = hb.build(mats, 'hround');
  hround.visible = false;
  const tb = new PartBuilder();
  tb.add('steel', profile([[0.004, 0.0], [0.006, -0.012], [0.004, -0.02], [-0.002, -0.024], [-0.004, -0.022], [0.0, -0.014], [-0.001, 0.0]], 0.006, { bevel: 0.0008 }));
  const trigger = tb.build(mats, 'trigger');
  trigger.position.set(0, -0.012, 0.024);
  root.add(b.build(mats, 'body'), bolt, magRounds, clip, hround, trigger);
  const sockets = addSockets(root, [
    socket('muzzle', 0.645, bore, 0),
    socket('eject', 0.0, bore + 0.016, 0.012),
    socket('sight', 0.19, sv, 0),
    socket('magWell', 0.0, bore, 0),
  ]);
  const { rs, ls } = grips(root, [-0.115, -0.045, -0.75, 0.018], { u: 0.36, v: bore - 0.022, r: 0.023, fingers: [0.7, -0.5, -0.5], palm: [0.32, 1, 0] });
  sockets.rightHand = rs;
  sockets.leftHand = ls;
  return { root, parts: { bolt, trigger, magRounds, clip, hround }, sockets, adsDist: 0.34 };
}

export const WEAPON_BUILDERS = {
  k416: buildCarbine,
  mp7: buildMP7,
  pump12: buildShotgun,
  skv338: buildSniper,
  p80: buildPistol,
  rv357: buildRevolver,
  dmr14: buildDMR,
  as20: buildAutoShotgun,
  db12: buildDoubleBarrel,
  knife: buildKnife,
  ks17: buildKS17,
  ums45: buildUMS45,
  lmg: buildLMG,
  stille9: buildStille9,
  mp18: buildMP18,
  hval47: buildHval47,
  kr98: buildKR98,
} as const;
export type WeaponId = keyof typeof WEAPON_BUILDERS;
