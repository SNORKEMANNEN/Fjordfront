import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * The demolition charge, "Sprengladning M/42" (Update 43), built from scratch at real size
 * (metres). Frame: origin at the middle of the base, +X right, +Y up, +Z toward the person
 * working on it (the panel side).
 *
 * An olive hard case (40 × 26 cm) with a hinged lid on its left half. Under the lid: a control
 * panel with an LCD (live text from a canvas), a 3 × 4 keypad with keys that press in, a red
 * arming button under a flip-up guard and a status lamp. On the right half: four bricks of plastic
 * explosive taped together and strapped down, with three detonator caps pushed into them; a red,
 * a blue and a yellow wire loop from the panel terminals to the caps (the wire gamble). A carry
 * handle and a stub antenna. Every moving part is named for the animations:
 *
 *   lid (hinge on the left edge, rotation.z 0 → 2 open), key0..key11 (press: position.y),
 *   arm (button), armGuard (rotation.x), led, disp (the LCD; userData.setDisplay(text, mode)),
 *   cap0..cap2 (lift: position.y; wireB_i rides with its cap), wireA0..2 / wireB0..2 (the halves
 *   of each wire; userData.cut(i) opens the gap), wmid0..2 (where a cutter bites),
 *   gripL / gripR (palm markers on the ends), padTip (keypad centre, for the typing hand).
 */
export const WIRE_HEX = [0xc8202a, 0x2a5ad0, 0xe0b018];

const mat = (c: number, r = 0.7, m = 0.05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });

export function makeCharge() {
  const g = new THREE.Group();
  g.name = 'charge';
  const olive = mat(0x46512f, 0.62, 0.1);
  const oliveDk = mat(0x313a20, 0.7, 0.1);
  const rubber = mat(0x1a1b1c, 0.85, 0);
  const steel = mat(0x9a9ea2, 0.35, 0.85);
  const brick = mat(0xd8cba0, 0.92, 0);
  const tape = mat(0x2f3b26, 0.6, 0.02);
  const panelM = mat(0x23272a, 0.55, 0.3);
  const keyM = mat(0x3c4146, 0.6, 0.1);
  const keyTop = mat(0xd9d6cc, 0.5, 0);
  const web = mat(0x2e3324, 0.95, 0);
  const add = (o: THREE.Object3D, name?: string) => {
    if (name) o.name = name;
    g.add(o);
    return o;
  };
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, r = 0) => {
    const geo = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
    const me = new THREE.Mesh(geo, m);
    me.position.set(x, y, z);
    return me;
  };
  // ---- the case: base tub, rubber corner bumpers, latches, a moulded rib round the waist
  const H = 0.072;
  add(box(0.4, H, 0.26, olive, 0, H / 2, 0, 0.012));
  add(box(0.404, 0.008, 0.264, oliveDk, 0, H - 0.02, 0, 0.003));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box(0.03, 0.05, 0.03, rubber, sx * 0.192, 0.028, sz * 0.122, 0.006));
  // carry handle on the front edge
  {
    const hc = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.007, 6, 14, Math.PI), rubber);
    hc.rotation.set(-Math.PI / 2, 0, 0);
    hc.position.set(0.11, H - 0.012, 0.132);
    add(hc);
  }
  // stencilled case number (a strip with a canvas label)
  {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 40;
    const x = c.getContext('2d')!;
    x.fillStyle = '#46512f';
    x.fillRect(0, 0, 256, 40);
    x.fillStyle = '#e8e2c8';
    x.font = 'bold 26px monospace';
    x.fillText('SPR M/42 · 4 KG', 10, 29);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.025), new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }));
    lab.position.set(0.08, 0.034, 0.1305);
    add(lab);
  }
  // ---- the control panel (left half, under the lid)
  const PY = H + 0.002;
  add(box(0.215, 0.006, 0.225, panelM, -0.085, PY - 0.003, 0));
  // LCD
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 80;
  const ctx = cv.getContext('2d')!;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const dispMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.04), dispMat);
  disp.rotation.x = -Math.PI / 2;
  disp.position.set(-0.1, PY + 0.0032, -0.07);
  add(disp, 'disp');
  add(box(0.142, 0.004, 0.052, rubber, -0.1, PY, -0.07));
  let lastText = '';
  const setDisplay = (text: string, mode: 'idle' | 'type' | 'armed' | 'defused' | 'dead' = 'idle') => {
    const key = text + mode;
    if (key === lastText) return;
    lastText = key;
    const bg = mode === 'armed' ? '#2a0606' : mode === 'defused' ? '#062a10' : mode === 'dead' ? '#050505' : '#0b1a0e';
    const fg = mode === 'armed' ? '#ff4030' : mode === 'defused' ? '#50ff80' : '#9cf0a0';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 256, 80);
    if (mode !== 'dead') {
      ctx.fillStyle = fg;
      ctx.font = 'bold 54px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 44);
      // scan lines
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let y = 0; y < 80; y += 4) ctx.fillRect(0, y, 256, 1);
    }
    tex.needsUpdate = true;
    dispMat.color.setScalar(mode === 'dead' ? 0.2 : 1.6);
  };
  setDisplay('-------');
  g.userData.setDisplay = setDisplay;
  // keypad: 3 columns × 4 rows (1-9, *, 0, #)
  const keyGeo = new RoundedBoxGeometry(0.02, 0.008, 0.017, 2, 0.003);
  const capGeo = new THREE.BoxGeometry(0.016, 0.001, 0.013);
  const keys: THREE.Object3D[] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      const k = new THREE.Group();
      k.add(new THREE.Mesh(keyGeo, keyM));
      const top = new THREE.Mesh(capGeo, r === 3 && c !== 1 ? mat(0xb8b090, 0.5) : keyTop);
      top.position.y = 0.0041;
      k.add(top);
      k.position.set(-0.165 + c * 0.026, PY + 0.004, -0.02 + r * 0.023);
      k.userData.rest = k.position.y;
      add(k, 'key' + (r * 3 + c));
      keys.push(k);
    }
  const pad = new THREE.Object3D();
  pad.position.set(-0.139, PY + 0.008, 0.0145);
  add(pad, 'padTip');
  // arming button under a hinged guard, status lamp
  const armBase = add(box(0.036, 0.006, 0.036, rubber, -0.04, PY + 0.003, 0.05));
  void armBase;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 16), mat(0xc81e1e, 0.4, 0.1));
  arm.position.set(-0.04, PY + 0.009, 0.05);
  arm.userData.rest = arm.position.y;
  add(arm, 'arm');
  const guard = new THREE.Group();
  guard.position.set(-0.04, PY + 0.007, 0.032);
  const gm = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.016, 0.036), new THREE.MeshStandardMaterial({ color: 0xff7a20, roughness: 0.2, transparent: true, opacity: 0.55 }));
  gm.position.set(0, 0.008, 0.018);
  guard.add(gm);
  add(guard, 'armGuard');
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.005, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.05, 0.03), toneMapped: false }));
  led.position.set(-0.01, PY + 0.004, -0.07);
  led.userData.base = new THREE.Color(5, 0.6, 0.3);
  add(led, 'led');
  // terminal strip the wires leave from
  add(box(0.012, 0.012, 0.09, steel, 0.012, PY + 0.006, 0));
  // ---- the lid (hinged along the left edge: it swings over to the side, rotation.z 0 → 2 open)
  const lid = new THREE.Group();
  lid.position.set(-0.196, H, 0);
  const lidIn = new THREE.Group();
  lidIn.position.set(0.111, 0, -0.118);
  lid.add(lidIn);
  const lidShell = new THREE.Mesh(new RoundedBoxGeometry(0.222, 0.016, 0.238, 2, 0.006), olive);
  lidShell.position.set(0, 0.008, 0.118);
  lidIn.add(lidShell);
  const lidRib = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.004, 0.2), oliveDk);
  lidRib.position.set(0, 0.018, 0.118);
  lidIn.add(lidRib);
  // a warning placard on the lid
  {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#e8b416';
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#141414';
    x.beginPath();
    x.moveTo(64, 14);
    x.lineTo(118, 112);
    x.lineTo(10, 112);
    x.closePath();
    x.fill();
    x.fillStyle = '#e8b416';
    x.font = 'bold 64px sans-serif';
    x.textAlign = 'center';
    x.fillText('!', 64, 100);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    pl.rotation.x = -Math.PI / 2;
    pl.position.set(0.04, 0.0205, 0.13);
    lidIn.add(pl);
  }
  // latch
  const latch = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.008), steel);
  latch.position.set(0.113, 0.0, 0.118);
  latch.rotation.y = Math.PI / 2;
  lidIn.add(latch);
  add(lid, 'lid');
  // ---- the explosive: four bricks, taped, strapped down
  const bricks = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new RoundedBoxGeometry(0.135, 0.05, 0.054, 2, 0.006), brick);
    b.position.set(0.11, H + 0.026, -0.087 + i * 0.058);
    bricks.add(b);
  }
  for (const x of [0.07, 0.15]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.054, 0.236), tape);
    t.position.set(x, H + 0.026, 0);
    bricks.add(t);
  }
  // webbing straps over the top and down the sides to the case
  for (const x of [0.045, 0.175]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.004, 0.25), web);
    s.position.set(x, H + 0.054, 0);
    bricks.add(s);
    for (const z of [-0.125, 0.125]) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.004), web);
      d.position.set(x, H + 0.024, z);
      bricks.add(d);
      const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.012, 0.006), steel);
      buckle.position.set(x, H + 0.03, z + Math.sign(z) * 0.003);
      bricks.add(buckle);
    }
  }
  add(bricks, 'bricks');
  // ---- detonator caps (aluminium tubes in the bricks) and the three wires
  const capM = mat(0xb8bcc0, 0.3, 0.9);
  const caps: THREE.Object3D[] = [];
  const capZ = [-0.058, 0, 0.058];
  for (let i = 0; i < 3; i++) {
    const cap = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.05, 10), capM);
    tube.position.y = 0.0;
    cap.add(tube);
    const crimp = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.008, 10), steel);
    crimp.position.y = 0.022;
    cap.add(crimp);
    cap.position.set(0.13, H + 0.05, capZ[i]);
    cap.userData.rest = cap.position.clone();
    add(cap, 'cap' + i);
    caps.push(cap);
  }
  const wires: { a: THREE.Mesh; b: THREE.Mesh; mid: THREE.Object3D }[] = [];
  for (let i = 0; i < 3; i++) {
    const z = capZ[i];
    const p0 = new THREE.Vector3(0.012, PY + 0.012, z * 0.7);
    const p3 = new THREE.Vector3(0.13, H + 0.077, z);
    const c1 = new THREE.Vector3(0.03, PY + 0.07 + i * 0.006, z * 0.8);
    const c2 = new THREE.Vector3(0.11, H + 0.12 + i * 0.006, z);
    const curve = new THREE.CubicBezierCurve3(p0, c1, c2, p3);
    const wm = mat(WIRE_HEX[i], 0.45, 0.05);
    // two halves meeting at the middle of the curve; the cap half is parented to the cap
    const pts = curve.getPoints(24);
    const half = (ps: THREE.Vector3[]) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ps), 12, 0.0022, 6), wm);
    const a = half(pts.slice(0, 13));
    add(a, 'wireA' + i);
    const bPts = pts.slice(12).map((p) => p.clone().sub(caps[i].position));
    const b = half(bPts);
    b.name = 'wireB' + i;
    caps[i].add(b);
    const mid = new THREE.Object3D();
    mid.position.copy(pts[12]);
    add(mid, 'wmid' + i);
    // copper ends shown once cut
    const cu = mat(0xd08040, 0.3, 0.9);
    const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 6, 4), cu);
    const e2 = e1.clone();
    e1.position.copy(pts[12]);
    e2.position.copy(pts[12]).sub(caps[i].position);
    e1.visible = e2.visible = false;
    a.add(e1);
    b.add(e2);
    a.userData.end = e1;
    b.userData.end = e2;
    wires.push({ a, b, mid });
  }
  /** snip wire i: the halves spring apart */
  g.userData.cut = (i: number) => {
    const w = wires[i];
    if (!w || w.a.userData.isCut) return;
    w.a.userData.isCut = true;
    // each half swings down about its own end (the panel terminal / the top of the cap)
    const pa = new THREE.Vector3(0.012, PY + 0.012, capZ[i] * 0.7), ra = new THREE.Euler(0, 0, -0.2);
    w.a.rotation.copy(ra);
    w.a.position.copy(pa).sub(pa.clone().applyEuler(ra));
    const pb = new THREE.Vector3(0, 0.027, 0), rb = new THREE.Euler(0, 0, 0.32);
    w.b.rotation.copy(rb);
    w.b.position.copy(pb).sub(pb.clone().applyEuler(rb));
    (w.a.userData.end as THREE.Object3D).visible = true;
    (w.b.userData.end as THREE.Object3D).visible = true;
  };
  /** back to new: lid shut, keys up, caps in, wires whole, display blank */
  g.userData.reset = () => {
    lid.rotation.z = 0;
    guard.rotation.x = 0;
    arm.position.y = arm.userData.rest;
    for (const k of keys) k.position.y = k.userData.rest;
    caps.forEach((c) => {
      c.position.copy(c.userData.rest);
      c.rotation.set(0, 0, 0);
      c.visible = true;
    });
    wires.forEach((w) => {
      w.a.userData.isCut = false;
      w.a.position.set(0, 0, 0);
      w.a.rotation.set(0, 0, 0);
      w.b.rotation.set(0, 0, 0);
      w.b.position.set(0, 0, 0);
      (w.a.userData.end as THREE.Object3D).visible = false;
      (w.b.userData.end as THREE.Object3D).visible = false;
    });
    setDisplay('-------');
  };
  // antenna stub and a cable gland
  {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.004, 0.09, 6), rubber);
    ant.position.set(0.185, H + 0.045, -0.112);
    add(ant);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 4), rubber);
    tip.position.set(0.185, H + 0.09, -0.112);
    add(tip);
  }
  // palm markers on the two ends
  const gl = new THREE.Object3D();
  gl.position.set(-0.2, 0.04, 0.0);
  add(gl, 'gripL');
  const gr = new THREE.Object3D();
  gr.position.set(0.2, 0.04, 0.0);
  add(gr, 'gripR');
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.frustumCulled = false;
    }
  });
  return g;
}

/**
 * Wire cutters (Update 43): two crossed steel arms on a pivot bolt, red dipped grips, short
 * angled jaws. −Z = the jaws' direction. userData.setOpen(0..1) opens the jaws / handles.
 */
export function makeCutters() {
  const g = new THREE.Group();
  g.name = 'cutters';
  const steel = mat(0x8e9296, 0.32, 0.9);
  const grip = mat(0xb0221c, 0.5, 0.05);
  const arms: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const a = new THREE.Group();
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.006, 0.028), steel);
    jaw.position.set(-s * 0.003, 0, -0.016);
    jaw.rotation.y = s * 0.12;
    a.add(jaw);
    const shank = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.006, 0.05), steel);
    shank.position.set(s * 0.006, 0, 0.025);
    shank.rotation.y = -s * 0.12;
    a.add(shank);
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0045, 0.07, 8), grip);
    h.rotation.x = Math.PI / 2;
    h.position.set(s * 0.012, 0, 0.083);
    h.rotation.z = -s * 0.1;
    a.add(h);
    g.add(a);
    arms.push(a);
  }
  const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.012, 10), steel);
  bolt.rotation.x = Math.PI / 2;
  bolt.rotation.z = Math.PI / 2;
  bolt.rotation.set(0, 0, 0);
  bolt.position.set(0, 0, 0.0);
  g.add(bolt);
  // the palm marker: the hand closes round both handles here
  const gp = new THREE.Object3D();
  gp.name = 'grip';
  gp.position.set(0, 0, 0.088);
  g.add(gp);
  // where the jaws bite
  const bite = new THREE.Object3D();
  bite.name = 'bite';
  bite.position.set(0, 0, -0.018);
  g.add(bite);
  g.userData.setOpen = (k: number) => {
    arms[0].rotation.y = -0.22 * k;
    arms[1].rotation.y = 0.22 * k;
  };
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.frustumCulled = false;
  });
  return g;
}
