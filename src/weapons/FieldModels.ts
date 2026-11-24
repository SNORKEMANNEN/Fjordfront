import * as THREE from 'three';

/**
 * Procedural models for the Update 47 field kit. Real size (metres), X right, Y up, -Z front, like
 * EquipmentModels. The same builders serve the first-person hands, the third-person props and the
 * world objects. Moving / glowing parts are named so the game can drive them:
 *  plate      cracks (overlay, scale.y 0..1 hides / shows), tab
 *  ammoCrate  lid (hinge, rotation.x), led
 *  medkit     lid (hinge), lamp (green cross, pulses), mast
 *  beacon     leg0..leg2 (setLegs), head (spins), lamp (team strobe), antenna
 *  thermite / gasGren / cluster  ring, spoon (like the frags)
 *  glowstick  glow (emissive tube; colour via userData.setColor)
 *  sensor     led, fins
 *  wedge      —
 *  breach     led, strip
 *  grapple    hook (the head that leaves), prong0..2, spool
 * Grip markers "gripL" / "gripR" mark the palms for the two-handed deploys.
 */

const mat = {
  olive: () => new THREE.MeshStandardMaterial({ color: 0x4b5232, roughness: 0.74, metalness: 0.08 }),
  darkOlive: () => new THREE.MeshStandardMaterial({ color: 0x30361f, roughness: 0.82, metalness: 0.06 }),
  black: () => new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.58, metalness: 0.22 }),
  rubber: () => new THREE.MeshStandardMaterial({ color: 0x0f1011, roughness: 0.95, metalness: 0 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0x8d9093, roughness: 0.32, metalness: 0.92 }),
  gunmetal: () => new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.45, metalness: 0.75 }),
  coyote: () => new THREE.MeshStandardMaterial({ color: 0x7d6b4c, roughness: 0.96, metalness: 0 }),
  brass: () => new THREE.MeshStandardMaterial({ color: 0xc29a4e, roughness: 0.3, metalness: 1 }),
  white: () => new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.8, metalness: 0 }),
  red: () => new THREE.MeshStandardMaterial({ color: 0xb0221c, roughness: 0.6, metalness: 0 }),
  glow: (c: THREE.ColorRepresentation, k = 3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false }),
};

function done(g: THREE.Group) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.frustumCulled = false;
      m.castShadow = true;
    }
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
function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, name?: string) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  if (name) o.name = name;
  return o;
}
/** LED bead driven by setLed (EquipmentModels convention: userData.base colour) */
function led(color: number, r = 0.0025) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.25), toneMapped: false }));
  m.name = 'led';
  m.userData.base = new THREE.Color(color);
  return m;
}

/** a rounded box (bevelled extrusion), centred */
function rbox(w: number, h: number, d: number, r = 0.004) {
  const s = new THREE.Shape();
  const x = w / 2 - r, y = h / 2 - r;
  s.moveTo(-x, -h / 2);
  s.lineTo(x, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -y);
  s.lineTo(w / 2, y);
  s.quadraticCurveTo(w / 2, h / 2, x, h / 2);
  s.lineTo(-x, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, y);
  s.lineTo(-w / 2, -y);
  s.quadraticCurveTo(-w / 2, -h / 2, -x, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - r * 2, bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 2, curveSegments: 3 });
  g.translate(0, 0, -(d - r * 2) / 2);
  g.computeVertexNormals();
  return g;
}

const texCache = new Map<string, THREE.CanvasTexture>();
/** a stencilled label (canvas): background colour, lines of text, worn paint */
function label(key: string, w: number, h: number, bg: string, fg: string, lines: [string, number][], extra?: (x: CanvasRenderingContext2D) => void) {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < (w * h) / 160; i++) {
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    x.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 3, 1 + Math.random() * 2);
  }
  extra?.(x);
  x.fillStyle = fg;
  x.textAlign = 'center';
  let y = h * 0.18;
  for (const [t, size] of lines) {
    x.font = `bold ${size}px "JetBrains Mono", monospace`;
    y += size * 1.05;
    x.fillText(t, w / 2, y);
  }
  // scuffs through the paint
  for (let i = 0; i < 26; i++) {
    x.strokeStyle = `rgba(200,200,190,${Math.random() * 0.18})`;
    x.lineWidth = 0.5 + Math.random();
    x.beginPath();
    const sx = Math.random() * w, sy = Math.random() * h;
    x.moveTo(sx, sy);
    x.lineTo(sx + (Math.random() - 0.5) * 30, sy + (Math.random() - 0.5) * 8);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

// =================================================================== armour plate
/**
 * A ceramic armour plate in its cordura cover: the single-curve torso shape with the top corners
 * cut for the arms, a pull tab and a velcro strip. A crack overlay (named 'cracks') shows the
 * damage when the plate is spent (the game scales it in).
 */
export function makePlate() {
  const g = new THREE.Group();
  const W = 0.25, H = 0.32, T = 0.022;
  const s = new THREE.Shape();
  const c = 0.06;
  s.moveTo(-W / 2, -H / 2 + 0.02);
  s.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + 0.02, -H / 2);
  s.lineTo(W / 2 - 0.02, -H / 2);
  s.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + 0.02);
  s.lineTo(W / 2, H / 2 - c);
  s.lineTo(W / 2 - c, H / 2);
  s.lineTo(-W / 2 + c, H / 2);
  s.lineTo(-W / 2, H / 2 - c);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: T - 0.008, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 4 });
  geo.translate(0, 0, -(T - 0.008) / 2);
  // single curve across the width (the plate wraps the chest)
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + 1.6 * p.getX(i) * p.getX(i));
  geo.computeVertexNormals();
  const cover = new THREE.MeshStandardMaterial({ color: 0x6a5b40, roughness: 0.97, metalness: 0, map: label('plateCover', 256, 320, '#6a5b40', 'rgba(25,22,16,0.75)', [['NIJ IV', 30], ['SAPI M', 22], ['', 30], ['KERAMISK', 18], ['PLATE 25×32', 18], ['MOT VEST ▲', 16]]) });
  // planar UVs across the face
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / W + 0.5, p.getY(i) / H + 0.5);
  const plate = mesh(geo, cover);
  plate.name = 'plate';
  g.add(plate);
  // pull tab and velcro strip
  const tab = mesh(new THREE.BoxGeometry(0.035, 0.05, 0.003), new THREE.MeshStandardMaterial({ color: 0x2a2a24, roughness: 1 }), 0, H / 2 + 0.018, 0.004, 'tab');
  g.add(tab);
  g.add(mesh(new THREE.BoxGeometry(0.16, 0.03, 0.002), new THREE.MeshStandardMaterial({ color: 0x3a3528, roughness: 1 }), 0, -0.06, -T / 2 - 0.001 + 0.02));
  // crack overlay: thin bright spider lines on the strike face (shown when the plate is spent)
  const cc = document.createElement('canvas');
  cc.width = cc.height = 256;
  const x = cc.getContext('2d')!;
  x.strokeStyle = 'rgba(230,225,210,0.95)';
  for (let k = 0; k < 3; k++) {
    const cx = 70 + Math.random() * 120, cy = 80 + Math.random() * 110;
    for (let i = 0; i < 9; i++) {
      let px = cx, py = cy, a = Math.random() * Math.PI * 2;
      x.lineWidth = 2.2;
      x.beginPath();
      x.moveTo(px, py);
      for (let j = 0; j < 7; j++) {
        a += (Math.random() - 0.5) * 0.8;
        px += Math.cos(a) * 14;
        py += Math.sin(a) * 14;
        x.lineTo(px, py);
        x.lineWidth *= 0.85;
      }
      x.stroke();
    }
    x.fillStyle = 'rgba(240,235,220,0.8)';
    x.beginPath();
    x.arc(cx, cy, 6, 0, Math.PI * 2);
    x.fill();
  }
  const ct = new THREE.CanvasTexture(cc);
  ct.colorSpace = THREE.SRGBColorSpace;
  const cracks = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.92, H * 0.88), new THREE.MeshBasicMaterial({ map: ct, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  cracks.position.z = T / 2 + 0.002;
  cracks.name = 'cracks';
  cracks.visible = false;
  g.add(cracks);
  return done(g);
}

// =================================================================== ammo crate
/** Ruggedised resupply crate: olive steel case, hinged lid, side handles, stencils; magazines, a
 *  belt and grenades inside, an amber status light. Opens when it lands. */
export function makeAmmoCrate() {
  const g = new THREE.Group();
  const W = 0.52, H = 0.24, D = 0.3;
  const olive = new THREE.MeshStandardMaterial({ color: 0x4a5130, roughness: 0.62, metalness: 0.35, map: label('crateSide', 512, 256, '#4a5130', '#e0dac2', [['AMMUNISJON', 46], ['5,56 · 7,62 · 9 MM · 40 MM', 22], ['FORSYNING  ▲  TOPP', 22]]) });
  const dark = mat.darkOlive();
  const body = mesh(rbox(W, H, D, 0.008), olive, 0, H / 2, 0);
  g.add(body);
  // ribs along the sides
  for (const z of [-D / 2 - 0.004, D / 2 + 0.004]) for (const x of [-0.18, 0, 0.18]) g.add(mesh(new THREE.BoxGeometry(0.02, H * 0.9, 0.008), dark, x, H / 2, z));
  // inner tray: rows of magazines, a belt box, two grenades
  const inner = new THREE.Group();
  inner.position.y = H - 0.012;
  const magMat = mat.black();
  for (let i = 0; i < 7; i++) inner.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.075), magMat, -0.2 + i * 0.034, 0, -0.06));
  for (let i = 0; i < 7; i++) {
    const r = mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.012, 6), mat.brass(), -0.2 + i * 0.034, 0.018, -0.07);
    inner.add(r);
  }
  inner.add(mesh(new THREE.BoxGeometry(0.16, 0.05, 0.1), dark, 0.12, 0, 0.06));
  for (let i = 0; i < 10; i++) inner.add(mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.03, 6), mat.brass(), 0.05 + i * 0.014, 0.03, 0.06).rotateZ(Math.PI / 2));
  for (const x of [-0.14, -0.08]) inner.add(mesh(new THREE.SphereGeometry(0.026, 12, 8), new THREE.MeshStandardMaterial({ color: 0x3c4530, roughness: 0.6 }), x, 0.008, 0.07));
  g.add(inner);
  // lid on a hinge at the back edge
  const hinge = new THREE.Group();
  hinge.name = 'lid';
  hinge.position.set(0, H, D / 2);
  const lid = mesh(rbox(W + 0.006, 0.03, D + 0.006, 0.006), olive, 0, 0.012, -D / 2);
  hinge.add(lid);
  hinge.add(mesh(new THREE.BoxGeometry(0.12, 0.012, 0.05), dark, 0, 0.032, -D / 2));
  g.add(hinge);
  // latches
  for (const x of [-0.17, 0.17]) g.add(mesh(new THREE.BoxGeometry(0.04, 0.05, 0.012), mat.steel(), x, H - 0.03, -D / 2 - 0.008));
  // side handles
  for (const sx of [-1, 1]) {
    const hd = mesh(new THREE.TorusGeometry(0.04, 0.007, 6, 14, Math.PI), mat.black(), sx * (W / 2 + 0.012), H * 0.62, 0);
    hd.rotation.set(0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    g.add(hd);
  }
  marker(g, 'gripL', -W / 2 - 0.03, H * 0.62, 0);
  marker(g, 'gripR', W / 2 + 0.03, H * 0.62, 0);
  // feet
  for (const x of [-0.22, 0.22]) for (const z of [-0.12, 0.12]) g.add(mesh(new THREE.BoxGeometry(0.04, 0.012, 0.04), mat.rubber(), x, 0.006, z));
  const l = led(0xffb030, 0.006);
  l.position.set(W / 2 - 0.04, H + 0.006, -D / 2 + 0.03);
  g.add(l);
  g.userData.setLid = (k: number) => {
    hinge.rotation.x = -1.9 * k;
  };
  return done(g);
}

// =================================================================== medkit station
/** Trauma kit station: an olive hard case with a white panel and red cross, a lid that opens
 *  onto bandages, tourniquets and injectors, and a short mast with a pulsing green cross. */
export function makeMedkit() {
  const g = new THREE.Group();
  const W = 0.46, H = 0.2, D = 0.3;
  const olive = mat.olive();
  const crossTex = label('medPanel', 256, 256, '#e8e4d8', '#b0221c', [], (x) => {
    x.fillStyle = '#b0221c';
    x.fillRect(98, 40, 60, 176);
    x.fillRect(40, 98, 176, 60);
    x.fillStyle = '#1c1c18';
    x.font = 'bold 22px monospace';
    x.textAlign = 'center';
    x.fillText('SANITET', 128, 246);
  });
  g.add(mesh(rbox(W, H, D, 0.01), olive, 0, H / 2, 0));
  const panel = mesh(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshStandardMaterial({ map: crossTex, roughness: 0.8 }), 0, H / 2, -D / 2 - 0.002);
  panel.rotation.y = Math.PI;
  g.add(panel);
  const panel2 = panel.clone();
  panel2.position.z = D / 2 + 0.002;
  panel2.rotation.y = 0;
  g.add(panel2);
  // contents
  const inner = new THREE.Group();
  inner.position.y = H - 0.01;
  for (let i = 0; i < 4; i++) inner.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 14).rotateZ(Math.PI / 2), mat.white(), -0.14 + i * 0.075, 0.01, -0.07));
  for (let i = 0; i < 3; i++) inner.add(mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.11, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x55603a, roughness: 0.55 }), 0.06 + i * 0.03, 0.01, 0.06));
  inner.add(mesh(new THREE.BoxGeometry(0.09, 0.03, 0.06), new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.7 }), -0.12, 0.01, 0.07));
  g.add(inner);
  const hinge = new THREE.Group();
  hinge.name = 'lid';
  hinge.position.set(0, H, D / 2);
  hinge.add(mesh(rbox(W + 0.006, 0.03, D + 0.006, 0.008), olive, 0, 0.012, -D / 2));
  const top = mesh(new THREE.PlaneGeometry(0.14, 0.14), new THREE.MeshStandardMaterial({ map: crossTex, roughness: 0.8 }), 0, 0.03, -D / 2);
  top.rotation.x = -Math.PI / 2;
  hinge.add(top);
  g.add(hinge);
  // mast with the green cross lamp
  const mast = new THREE.Group();
  mast.name = 'mast';
  mast.position.set(W / 2 - 0.05, H, -D / 2 + 0.05);
  mast.add(mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.26, 8), mat.black(), 0, 0.13, 0));
  const lampMat = mat.glow(0x40ff80, 0.4);
  const lamp = new THREE.Group();
  lamp.name = 'lamp';
  lamp.position.y = 0.28;
  lamp.add(mesh(new THREE.BoxGeometry(0.05, 0.014, 0.014), lampMat));
  lamp.add(mesh(new THREE.BoxGeometry(0.014, 0.05, 0.014), lampMat));
  lamp.userData.mat = lampMat;
  mast.add(lamp);
  mast.scale.y = 0.001;
  g.add(mast);
  for (const sx of [-1, 1]) {
    const hd = mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 14, Math.PI), mat.black(), sx * (W / 2 + 0.012), H * 0.6, 0);
    hd.rotation.set(0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    g.add(hd);
  }
  marker(g, 'gripL', -W / 2 - 0.028, H * 0.6, 0);
  marker(g, 'gripR', W / 2 + 0.028, H * 0.6, 0);
  g.userData.setLid = (k: number) => {
    hinge.rotation.x = -1.95 * k;
    mast.scale.y = Math.max(0.001, k);
  };
  return done(g);
}

// =================================================================== spawn beacon
/** Tactical insertion beacon: three folding legs, a ruggedised radio body, a whip antenna and a
 *  strobe head that spins in the team colour. */
export function makeBeacon() {
  const g = new THREE.Group();
  const body = mat.darkOlive();
  const metal = mat.gunmetal();
  g.add(mesh(rbox(0.12, 0.16, 0.08, 0.008), body, 0, 0.12, 0));
  g.add(mesh(new THREE.BoxGeometry(0.06, 0.03, 0.002), new THREE.MeshStandardMaterial({ color: 0x0a1a10, roughness: 0.2, emissive: new THREE.Color(0x20ff70), emissiveIntensity: 0.6 }), 0, 0.16, -0.041));
  for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 10).rotateX(Math.PI / 2), mat.black(), -0.03 + i * 0.03, 0.105, -0.042));
  const legGeo = new THREE.BoxGeometry(0.012, 0.16, 0.008);
  legGeo.translate(0, -0.08, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const piv = new THREE.Group();
    piv.name = 'leg' + i;
    piv.position.set(Math.cos(a) * 0.045, 0.07, Math.sin(a) * 0.045);
    piv.rotation.y = -a + Math.PI / 2;
    const fold = new THREE.Group();
    fold.name = 'fold';
    piv.add(fold);
    fold.add(new THREE.Mesh(legGeo, metal));
    fold.add(mesh(new THREE.SphereGeometry(0.01, 8, 6), mat.rubber(), 0, -0.16, 0));
    g.add(piv);
  }
  g.userData.setLegs = (k: number) => {
    for (let i = 0; i < 3; i++) {
      const f = g.getObjectByName('leg' + i)!.getObjectByName('fold')!;
      f.rotation.x = -(Math.PI - 0.2) * (1 - k) - 0.5 * k;
    }
  };
  (g.userData.setLegs as (k: number) => void)(0);
  const ant = mesh(new THREE.CylinderGeometry(0.0015, 0.003, 0.42, 6), mat.black(), 0.04, 0.41, 0.02, 'antenna');
  g.add(ant);
  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = 0.215;
  head.add(mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 12), metal));
  const dome = mesh(new THREE.SphereGeometry(0.027, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.1, transparent: true, opacity: 0.35 }), 0, 0.015, 0);
  head.add(dome);
  const lampMat = mat.glow(0x40c0ff, 0.3);
  const lamp = mesh(new THREE.BoxGeometry(0.03, 0.014, 0.008), lampMat, 0.0, 0.025, -0.012, 'lamp');
  lamp.userData.mat = lampMat;
  head.add(lamp);
  g.add(head);
  marker(g, 'gripL', -0.075, 0.12, 0);
  marker(g, 'gripR', 0.075, 0.12, 0);
  g.userData.setColor = (c: THREE.Color, k: number) => lampMat.color.copy(c).multiplyScalar(0.2 + k * 6);
  return done(g);
}

// =================================================================== grenades
function spoonRing(g: THREE.Group, y: number, r: number) {
  const spoon = mesh(new THREE.BoxGeometry(0.012, 0.075, 0.004), mat.steel(), r + 0.002, y - 0.03, 0, 'spoon');
  spoon.rotation.z = -0.08;
  g.add(spoon);
  const ring = mesh(new THREE.TorusGeometry(0.011, 0.0016, 6, 16), mat.steel(), 0.016, y + 0.006, 0, 'ring');
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  g.add(mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.016, 12), mat.gunmetal(), 0, y, 0));
}

/** Thermite grenade: a grey canister with a yellow band and stencil; burns white-hot through
 *  whatever it sticks to. */
export function makeThermite() {
  const g = new THREE.Group();
  const tex = label('thermite', 256, 128, '#5a5c58', '#151515', [['TH3', 40], ['BRANN', 22]], (x) => {
    x.fillStyle = '#d8b020';
    x.fillRect(0, 96, 256, 18);
  });
  g.add(mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.11, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.4 })));
  g.add(mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.01, 18), mat.gunmetal(), 0, -0.058, 0));
  // vent holes round the top
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add(mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.004, 6).rotateZ(Math.PI / 2), mat.black(), Math.cos(a) * 0.0235, 0.04, Math.sin(a) * 0.0235).rotateY(-a));
  }
  spoonRing(g, 0.064, 0.024);
  return done(g);
}

/** Gas grenade: a yellow canister with black bands, "CS" and a perforated top cap. */
export function makeGasGrenade() {
  const g = new THREE.Group();
  const tex = label('gas', 256, 128, '#c8a828', '#111111', [['CS', 46], ['TÅREGASS', 20]], (x) => {
    x.fillStyle = '#111';
    x.fillRect(0, 0, 256, 10);
    x.fillRect(0, 118, 256, 10);
  });
  g.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.11, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.2 })));
  const cap = mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.012, 18), mat.gunmetal(), 0, 0.06, 0);
  g.add(cap);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.003, 6), mat.black(), Math.cos(a) * 0.012, 0.0665, Math.sin(a) * 0.012));
  }
  spoonRing(g, 0.072, 0.025);
  return done(g);
}

/** Cluster grenade: a ribbed core with six bomblets clipped round it; they scatter on the pop. */
export function makeCluster() {
  const g = new THREE.Group();
  const olive = new THREE.MeshStandardMaterial({ color: 0x3e4a2c, roughness: 0.6, metalness: 0.15 });
  g.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 14), mat.gunmetal()));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = mesh(new THREE.SphereGeometry(0.016, 12, 8), olive, Math.cos(a) * 0.026, (i % 2 ? 0.018 : -0.018), Math.sin(a) * 0.026, 'bomblet' + i);
    b.scale.y = 1.25;
    g.add(b);
    g.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 6), new THREE.MeshStandardMaterial({ color: 0xd8b020 }), Math.cos(a) * 0.026, (i % 2 ? 0.018 : -0.018) + 0.02, Math.sin(a) * 0.026));
  }
  g.add(mesh(new THREE.TorusGeometry(0.044, 0.003, 6, 24).rotateX(Math.PI / 2), mat.black(), 0, 0, 0));
  spoonRing(g, 0.058, 0.02);
  return done(g);
}

/** Chemical light stick: a translucent tube with a glowing core, a hang loop. */
export function makeGlowstick() {
  const g = new THREE.Group();
  const coreMat = mat.glow(0x60ff70, 2.4);
  const core = mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.13, 10), coreMat, 0, 0, 0, 'glow');
  g.add(core);
  g.add(mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.15, 12), new THREE.MeshPhysicalMaterial({ color: 0xc8ffd0, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false })));
  for (const y of [-0.075, 0.075]) g.add(mesh(new THREE.CylinderGeometry(0.0078, 0.0078, 0.01, 12), new THREE.MeshStandardMaterial({ color: 0x1a2a1c, roughness: 0.6 }), 0, y, 0));
  const loop = mesh(new THREE.TorusGeometry(0.008, 0.0012, 5, 12), mat.black(), 0, 0.088, 0);
  g.add(loop);
  g.userData.setColor = (c: THREE.Color, k: number) => coreMat.color.copy(c).multiplyScalar(k);
  return done(g);
}

/** Motion sensor dart: a barbed spike, a sensor puck with a radar window and an LED, tail fins. */
export function makeSensor() {
  const g = new THREE.Group();
  const spike = mesh(new THREE.ConeGeometry(0.004, 0.05, 8), mat.steel(), 0, -0.045, 0);
  spike.rotation.x = Math.PI;
  g.add(spike);
  g.add(mesh(new THREE.CylinderGeometry(0.016, 0.014, 0.028, 16), mat.black(), 0, -0.006, 0));
  const win = mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.01, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x103040, roughness: 0.15, metalness: 0.3, emissive: new THREE.Color(0x2080ff), emissiveIntensity: 0.25 }), 0, 0.002, 0);
  g.add(win);
  const l = led(0xff3030, 0.003);
  l.position.set(0, 0.012, 0);
  g.add(l);
  const fins = new THREE.Group();
  fins.name = 'fins';
  for (let i = 0; i < 3; i++) {
    const f = mesh(new THREE.BoxGeometry(0.002, 0.03, 0.018), new THREE.MeshStandardMaterial({ color: 0xc83020, roughness: 0.6 }), 0, 0.03, 0.01);
    const p = new THREE.Group();
    p.rotation.y = (i / 3) * Math.PI * 2;
    p.add(f);
    fins.add(p);
  }
  fins.add(mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.04, 6), mat.black(), 0, 0.03, 0));
  g.add(fins);
  return done(g);
}

/** Door wedge: a steel wedge with a toothed underside and a fold-out lever arm. */
export function makeWedge() {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  s.moveTo(-0.06, 0);
  s.lineTo(0.06, 0);
  s.lineTo(0.06, 0.006);
  s.lineTo(-0.06, 0.035);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.045, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.002, bevelSegments: 1 });
  geo.translate(0, 0, -0.0225);
  g.add(mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2d2f30, roughness: 0.5, metalness: 0.7 })));
  for (let i = 0; i < 6; i++) g.add(mesh(new THREE.BoxGeometry(0.004, 0.004, 0.044), mat.steel(), -0.05 + i * 0.02, 0.0, 0));
  g.add(mesh(new THREE.BoxGeometry(0.03, 0.012, 0.03), new THREE.MeshStandardMaterial({ color: 0xc86418, roughness: 0.6 }), -0.045, 0.04, 0));
  return done(g);
}

/** Breaching charge: a flexible linear charge in an orange sleeve on a foam backer, a detonator
 *  block with an LED, and a tail of det cord. */
export function makeBreach() {
  const g = new THREE.Group();
  const sleeve = new THREE.MeshStandardMaterial({ color: 0xc85a18, roughness: 0.7, map: label('breach', 64, 256, '#c85a18', '#1a1a1a', [['', 10], ['S', 22], ['P', 22], ['R', 22], ['E', 22], ['N', 22], ['G', 22]]) });
  const strip = mesh(new THREE.BoxGeometry(0.035, 0.34, 0.016), sleeve, 0, 0, 0, 'strip');
  g.add(strip);
  g.add(mesh(new THREE.BoxGeometry(0.06, 0.36, 0.008), new THREE.MeshStandardMaterial({ color: 0x2a2a24, roughness: 1 }), 0, 0, 0.012));
  g.add(mesh(rbox(0.05, 0.05, 0.03, 0.004), mat.black(), 0, 0.2, -0.004));
  const l = led(0xff2020, 0.004);
  l.position.set(0.012, 0.21, -0.02);
  g.add(l);
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.22, -0.01), new THREE.Vector3(0.05, 0.25, -0.02), new THREE.Vector3(0.09, 0.2, -0.015), new THREE.Vector3(0.1, 0.12, 0)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.003, 6), new THREE.MeshStandardMaterial({ color: 0x40a020, roughness: 0.6 })));
  marker(g, 'gripL', -0.03, 0.0, -0.01);
  marker(g, 'gripR', 0.03, 0.12, -0.01);
  return done(g);
}

/** Grapple launcher: a short pistol-gripped tube on the left forearm, a three-pronged hook in the
 *  muzzle and a line spool under the barrel. */
export function makeGrapple() {
  const g = new THREE.Group();
  const body = mat.black();
  g.add(mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.2, 14).rotateX(Math.PI / 2), mat.darkOlive(), 0, 0, -0.06));
  g.add(mesh(rbox(0.03, 0.09, 0.04, 0.006), body, 0, -0.05, 0.02).rotateX(0.25));
  g.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 16).rotateZ(Math.PI / 2), mat.gunmetal(), 0, -0.03, -0.08, 'spool'));
  const hook = new THREE.Group();
  hook.name = 'hook';
  hook.position.z = -0.17;
  hook.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8).rotateX(Math.PI / 2), mat.steel()));
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Group();
    p.name = 'prong' + i;
    p.rotation.z = (i / 3) * Math.PI * 2;
    const arm = new THREE.Group();
    arm.position.z = -0.022;
    const pr = mesh(new THREE.CylinderGeometry(0.0035, 0.0028, 0.05, 6), mat.steel(), 0, 0.025, 0);
    arm.add(pr);
    const tip = mesh(new THREE.ConeGeometry(0.0045, 0.016, 6), mat.steel(), 0, 0.05, 0.006);
    tip.rotation.x = 1.9;
    arm.add(tip);
    arm.rotation.x = 0.25;
    p.add(arm);
    hook.add(p);
  }
  g.add(hook);
  g.userData.setProngs = (k: number) => {
    for (let i = 0; i < 3; i++) {
      const arm = hook.getObjectByName('prong' + i)!.children[0];
      arm.rotation.x = 0.25 + 1.0 * k;
    }
  };
  return done(g);
}

/** world copy of the hook alone (what flies out and bites) */
export function makeHook() {
  const g = makeGrapple();
  const h = g.getObjectByName('hook')!;
  const out = new THREE.Group();
  h.position.set(0, 0, 0);
  out.add(h);
  out.userData.setProngs = g.userData.setProngs;
  return out;
}

export const FIELD_BUILDERS = {
  plate: makePlate, ammoCrate: makeAmmoCrate, medkit: makeMedkit, beacon: makeBeacon, thermite: makeThermite, gasGren: makeGasGrenade,
  cluster: makeCluster, glowstick: makeGlowstick, sensor: makeSensor, wedge: makeWedge, breach: makeBreach, grapple: makeGrapple,
};
