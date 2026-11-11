import * as THREE from 'three';

/**
 * Procedural models for the Update 20 equipment. All are built at real size (metres) with
 * X right, Y up, -Z forward ("front"). The same builders serve the first-person hands and the
 * world objects; moving parts are named so animations can drive them:
 *  claymore  legs (setLegs 0..1 via userData), laser, led
 *  c4        led
 *  detonator cover (hinged), button, led
 *  sticky    btn, led, gel
 *  snapshot  cap (twists), ring (sensor band, emissive)
 *  decoy     btn, led
 *  trophy    leg0..leg2 (fold), head (spins), lamp, panels
 * Grip markers (empty Object3Ds) "gripL" / "gripR" mark where the palms go for two-handed items.
 */

const M = {
  olive: () => new THREE.MeshStandardMaterial({ color: 0x4b5232, roughness: 0.78, metalness: 0.05 }),
  darkOlive: () => new THREE.MeshStandardMaterial({ color: 0x343a22, roughness: 0.85, metalness: 0.05 }),
  black: () => new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.55, metalness: 0.25 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.9 }),
  gunmetal: () => new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.45, metalness: 0.75 }),
  tan: () => new THREE.MeshStandardMaterial({ color: 0x9a8a68, roughness: 0.7, metalness: 0.05 }),
  led: (c: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.25), toneMapped: false }),
};

function finish(g: THREE.Group) {
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false;
  });
  return g;
}
function marker(g: THREE.Object3D, name: string, x: number, y: number, z: number) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  g.add(o);
  return o;
}
/** LED helper: an emissive bead whose colour/brightness is driven by userData.lit (0..1). */
function led(color: number, r = 0.0022) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), M.led(color));
  m.name = 'led';
  m.userData.base = new THREE.Color(color);
  return m;
}
export function setLed(o: THREE.Object3D | undefined | null, lit: number) {
  if (!o) return;
  const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
  m.color.copy(o.userData.base as THREE.Color).multiplyScalar(0.25 + lit * 3.5);
}

let stencilTex: THREE.CanvasTexture | null = null;
function stencil() {
  if (stencilTex) return stencilTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const x = c.getContext('2d')!;
  x.fillStyle = '#4b5232';
  x.fillRect(0, 0, 256, 96);
  // worn paint
  for (let i = 0; i < 400; i++) {
    x.fillStyle = `rgba(${30 + Math.random() * 30},${34 + Math.random() * 30},${20 + Math.random() * 20},${Math.random() * 0.25})`;
    x.fillRect(Math.random() * 256, Math.random() * 96, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  x.fillStyle = '#d8d2b8';
  x.font = 'bold 22px monospace';
  x.textAlign = 'center';
  x.fillText('▲  FRONT  ▲', 128, 40);
  x.font = '13px monospace';
  x.fillText('RETTET MOT FIENDEN', 128, 62);
  x.fillText('PM-7 KL', 128, 80);
  stencilTex = new THREE.CanvasTexture(c);
  stencilTex.colorSpace = THREE.SRGBColorSpace;
  return stencilTex;
}

/** Directional mine on folding scissor legs, with a tripwire laser module on top. */
export function makeClaymore() {
  const g = new THREE.Group();
  const W = 0.216, H = 0.083, D = 0.036;
  const geo = new THREE.BoxGeometry(W, H, D, 16, 2, 1);
  // bow the body: the ends sweep back so the front face is convex
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, p.getZ(i) + (x * x) * 2.3);
  }
  geo.computeVertexNormals();
  const olive = M.olive();
  const front = new THREE.MeshStandardMaterial({ map: stencil(), roughness: 0.8, metalness: 0.05 });
  // material groups of a BoxGeometry: +x, -x, +y, -y, +z, -z  → the stencil on the front (-z)
  const body = new THREE.Mesh(geo, [olive, olive, olive, olive, olive, front]);
  g.add(body);
  // rim seam
  const seam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.002, 0.004, D * 0.5), M.darkOlive());
  seam.position.set(0, -H / 2 + 0.006, 0.004);
  g.add(seam);
  // peep sight slit on top
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.01, 0.014), M.darkOlive());
  sight.position.set(0, H / 2 + 0.005, 0.0);
  g.add(sight);
  // two detonator wells
  for (const sx of [-0.06, 0.06]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0095, 0.012, 12), M.darkOlive());
    well.position.set(sx, H / 2 + 0.005, sx * sx * 2.3);
    g.add(well);
    const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.006, 10), M.black());
    plug.position.set(sx, H / 2 + 0.013, sx * sx * 2.3);
    g.add(plug);
  }
  // tripwire laser module clipped to the top right well
  const laser = new THREE.Group();
  laser.name = 'laser';
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.016, 0.03), M.black());
  laser.add(box);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.004, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 0.12, 0.08), toneMapped: false }));
  lens.rotation.x = Math.PI / 2;
  lens.position.set(-0.005, 0.0, -0.016);
  lens.name = 'lens';
  laser.add(lens);
  const lens2 = lens.clone();
  lens2.position.x = 0.005;
  lens2.name = 'lens2';
  laser.add(lens2);
  const l = led(0x30ff40, 0.0018);
  l.position.set(0.008, 0.0085, 0.008);
  laser.add(l);
  laser.position.set(0.035, H / 2 + 0.012, 0.01);
  g.add(laser);
  // scissor legs: two pairs at the bottom, folded flat under the body until deployed
  const legs = new THREE.Group();
  legs.name = 'legs';
  const legGeo = new THREE.BoxGeometry(0.0045, 0.075, 0.006);
  legGeo.translate(0, -0.0375, 0);
  const steel = M.gunmetal();
  const legObjs: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const piv = new THREE.Group();
    piv.position.set(sx * 0.072, -H / 2 + 0.002, 0.008 + 0.072 * 0.072 * 2.3);
    piv.userData = { sx, sz };
    const leg = new THREE.Mesh(legGeo, steel);
    piv.add(leg);
    const foot = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.012, 6), steel);
    foot.rotation.x = Math.PI;
    foot.position.y = -0.078;
    piv.add(foot);
    legs.add(piv);
    legObjs.push(piv);
  }
  g.add(legs);
  g.userData.setLegs = (k: number) => {
    for (const piv of legObjs) {
      const { sx, sz } = piv.userData as { sx: number; sz: number };
      // folded: swung up along the body's underside; deployed: splayed out and forward/back
      piv.rotation.set(sz * 0.38 * k, 0, sx * (1.5 - 1.2 * k));
    }
  };
  (g.userData.setLegs as (k: number) => void)(0);
  marker(g, 'gripL', -W / 2 - 0.004, 0.0, W * W * 0.575);
  marker(g, 'gripR', W / 2 + 0.004, 0.0, W * W * 0.575);
  return finish(g);
}

/** Plastic-explosive brick with a radio detonator cap and a status LED. */
export function makeC4() {
  const g = new THREE.Group();
  const film = new THREE.MeshStandardMaterial({ color: 0x5a6040, roughness: 0.45, metalness: 0.05 });
  const brick = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.034, 0.056), film);
  g.add(brick);
  const tape = new THREE.MeshStandardMaterial({ color: 0x2c2d2a, roughness: 0.9 });
  for (const x of [-0.035, 0.035]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0355, 0.0575), tape);
    t.position.x = x;
    g.add(t);
  }
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.0005, 0.03), new THREE.MeshStandardMaterial({ color: 0xc8c4a8, roughness: 0.9 }));
  label.position.set(0, 0.0173, 0.004);
  g.add(label);
  // detonator: grey receiver box pressed into the top with a stub antenna
  const rx = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.022), M.gunmetal());
  rx.position.set(-0.012, 0.024, -0.008);
  g.add(rx);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.0013, 0.0013, 0.035, 6), M.black());
  ant.position.set(-0.022, 0.045, -0.014);
  ant.rotation.z = 0.25;
  g.add(ant);
  const l = led(0xff2a1a, 0.0024);
  l.position.set(-0.002, 0.0318, -0.002);
  g.add(l);
  // where the palms go when it is carried in both hands (the brick's ends)
  marker(g, 'gripL', -0.057, 0.0, 0.0);
  marker(g, 'gripR', 0.057, 0.0, 0.0);
  return finish(g);
}

/** Handheld clacker remote for the C4: flip cover over a red button, antenna, LED. */
export function makeDetonator() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.092, 0.024), M.darkOlive());
  g.add(body);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.05, 0.026), M.black());
  grip.position.y = -0.022;
  g.add(grip);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.002, 0.05, 8), M.black());
  ant.position.set(0.011, 0.07, 0);
  g.add(ant);
  // big red button on the top end, under a hinged yellow safety cover (hinge at the back edge)
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 14), new THREE.MeshStandardMaterial({ color: 0xc01810, roughness: 0.4 }));
  btn.position.set(0, 0.0485, 0.0);
  btn.name = 'button';
  g.add(btn);
  const cover = new THREE.Group();
  cover.name = 'cover';
  cover.position.set(0, 0.0535, 0.012);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.003, 0.024), new THREE.MeshStandardMaterial({ color: 0xd8b020, roughness: 0.5 }));
  lid.position.z = -0.012;
  cover.add(lid);
  g.add(cover);
  const l = led(0x30ff40, 0.0022);
  l.position.set(-0.009, 0.032, 0.0125);
  g.add(l);
  return finish(g);
}

/** Sticky grenade: short body, arming button with an LED on top, adhesive gel pad below. */
export function makeSticky() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.026, 0.06, 18), M.black());
  g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0265, 0.0265, 0.012, 18), new THREE.MeshStandardMaterial({ color: 0x4a6a8a, roughness: 0.5 }));
  band.position.y = 0.006;
  g.add(band);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.014, 16), M.gunmetal());
  cap.position.y = 0.037;
  g.add(cap);
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.006, 12), new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.4 }));
  btn.position.y = 0.046;
  btn.name = 'btn';
  g.add(btn);
  const l = led(0xff2010, 0.003);
  l.position.set(0.012, 0.042, 0);
  g.add(l);
  // gel: a squashed translucent blob
  const gel = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9aa860, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.85 }));
  gel.scale.y = 0.5;
  gel.position.y = -0.03;
  gel.name = 'gel';
  g.add(gel);
  return finish(g);
}

/** Snapshot grenade: puck with a sensor band and a ribbed twist cap. */
export function makeSnapshot() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 20), M.black());
  g.add(body);
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 0.45, 0.9), toneMapped: false });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0305, 0.0305, 0.008, 20, 1, true), ringMat);
  ring.name = 'ring';
  g.add(ring);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0045, 10), new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.05, metalness: 0.6 }));
    lens.position.set(Math.cos(a) * 0.0308, -0.014, Math.sin(a) * 0.0308);
    lens.lookAt(lens.position.clone().multiplyScalar(2));
    g.add(lens);
  }
  const cap = new THREE.Group();
  cap.name = 'cap';
  cap.position.y = 0.03;
  const capM = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.027, 0.014, 20), M.gunmetal());
  cap.add(capM);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.012, 0.004), M.black());
    rib.position.set(Math.cos(a) * 0.026, 0, Math.sin(a) * 0.026);
    rib.rotation.y = -a;
    cap.add(rib);
  }
  const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0006, 0.003), new THREE.MeshBasicMaterial({ color: 0xe0e0e0 }));
  arrow.position.y = 0.0075;
  cap.add(arrow);
  g.add(cap);
  return finish(g);
}

/** Decoy grenade: tan canister with a speaker grille, a push button and an LED. */
export function makeDecoy() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 18), M.tan());
  g.add(body);
  const grill = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0223, 0.0223, 0.003, 18, 1, true, -0.9, 1.8), grill);
    s.position.y = -0.03 + i * 0.008;
    g.add(s);
  }
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.012, 16), M.gunmetal());
  top.position.y = 0.056;
  g.add(top);
  const btn = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.005, 0.01), new THREE.MeshStandardMaterial({ color: 0xd0a020, roughness: 0.5 }));
  btn.position.set(0, 0.064, 0);
  btn.name = 'btn';
  g.add(btn);
  const l = led(0xffa020, 0.0022);
  l.position.set(0.0, 0.02, 0.0225);
  g.add(l);
  // safety pin ring through the top cap
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0016, 6, 16), M.steel());
  ring.position.set(0.016, 0.066, 0);
  ring.rotation.y = Math.PI / 2;
  ring.name = 'ring';
  g.add(ring);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.0222, 0.0222, 0.006, 18, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a6ad8, roughness: 0.6 }));
  stripe.position.y = 0.035;
  g.add(stripe);
  return finish(g);
}

/**
 * Trophy system: squat base with three folding legs, a mast and a rotating sensor head with four
 * radar panels and twin interceptor tubes. Side handles (gripL / gripR) for the two-handed deploy.
 */
export function makeTrophy() {
  const g = new THREE.Group();
  const body = M.darkOlive();
  const metal = M.gunmetal();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.07, 6), body);
  base.position.y = 0.035;
  g.add(base);
  const baseTop = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.012, 6), metal);
  baseTop.position.y = 0.076;
  g.add(baseTop);
  // side handles
  for (const sx of [-1, 1]) {
    const hdl = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0045, 6, 12, Math.PI), M.black());
    hdl.position.set(sx * 0.088, 0.04, 0);
    hdl.rotation.set(0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI / 2);
    g.add(hdl);
  }
  marker(g, 'gripL', -0.112, 0.04, 0.0);
  marker(g, 'gripR', 0.112, 0.04, 0.0);
  // legs: hinge at the base rim, folded up against the body until deployed
  const legGeo = new THREE.BoxGeometry(0.012, 0.11, 0.006);
  legGeo.translate(0, -0.055, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const piv = new THREE.Group();
    piv.name = 'leg' + i;
    piv.position.set(Math.cos(a) * 0.07, 0.03, Math.sin(a) * 0.07);
    piv.rotation.y = -a + Math.PI / 2;
    const inner = new THREE.Group();
    inner.name = 'fold';
    piv.add(inner);
    const leg = new THREE.Mesh(legGeo, metal);
    inner.add(leg);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, 0.005, 8), M.black());
    pad.position.y = -0.11;
    inner.add(pad);
    g.add(piv);
  }
  g.userData.setLegs = (k: number) => {
    for (let i = 0; i < 3; i++) {
      const f = g.getObjectByName('leg' + i)!.getObjectByName('fold')!;
      // folded: pointing straight up along the body; deployed: splayed out and down
      f.rotation.x = -(Math.PI - 0.15) * (1 - k) - 0.55 * k;
    }
  };
  (g.userData.setLegs as (k: number) => void)(0);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.07, 10), metal);
  mast.position.y = 0.115;
  g.add(mast);
  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = 0.17;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.05, 8), body);
  head.add(hub);
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x23272a, roughness: 0.3, metalness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.038, 0.006), panelMat);
    panel.position.set(Math.sin(a) * 0.055, 0.002, Math.cos(a) * 0.055);
    panel.rotation.y = a;
    panel.rotation.x = -0.12;
    head.add(panel);
  }
  for (const sx of [-0.018, 0.018]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.06, 10), metal);
    tube.rotation.x = Math.PI / 2 - 0.5;
    tube.position.set(sx, 0.038, -0.01);
    head.add(tube);
  }
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.black());
  dome.position.y = 0.025;
  head.add(dome);
  const lamp = led(0x40ff60, 0.006);
  lamp.name = 'lamp';
  lamp.position.y = 0.056;
  head.add(lamp);
  g.add(head);
  return finish(g);
}

export const EQUIP_BUILDERS = {
  claymore: makeClaymore, c4: makeC4, detonator: makeDetonator, sticky: makeSticky, snapshot: makeSnapshot, decoy: makeDecoy, trophy: makeTrophy,
};
