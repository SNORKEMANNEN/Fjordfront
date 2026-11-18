import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { EqCtx } from './EquipAnims';
import { setLed } from './EquipmentModels';
import { clamp, smoothstep, easeInOutCubic } from '../core/math';

/**
 * First-person Sabotasje charge work (Update 43). Both actions are driven by the real progress of
 * the plant / defuse (action t = progress 0..1, so the hands are always exactly where the timer
 * is), while the way in and the way out run on the clock:
 *
 *  plant   the gun drops away; the left hand brings the charge up by its end. The right hand
 *          hooks the lid lip and flips it open, then the index finger types the 7-digit code on the
 *          keypad — it travels key to key, each key really goes down under the fingertip and the
 *          LCD fills in digit by digit — flips the orange guard up and presses the red arm button
 *          (LED goes solid, ARMED). The right hand takes the other end, and when the plant lands
 *          both hands lower the charge to the ground before the gun comes back.
 *  defuse  the view tips down onto the charge on the ground (lid open, countdown on the LCD, LED
 *          blinking with the beeps). The left hand steadies the case; the right hand pinches each
 *          detonator cap in turn, works it loose and draws it out of the brick, then thumbs the
 *          arm button to cut the circuit. A wire gamble takes the cutters out: they open on the
 *          chosen wire, and the snip itself is the moment the cut is decided.
 *
 * The fingertip targets are exact: the viewmodel measures where the index tip / pinch point of
 * the posed hand actually is (in the wrist frame) and the wrist is placed so that point lands on
 * the key, the lid lip or the cap.
 *
 * data (set by the game): p (progress), code, done, abort, timer() (fuse s left), cut {w, t0},
 * onSnip(), sfx(name), kit. data.finished is set here when the way out has played.
 */
export interface ChargeCtx extends EqCtx {
  tip: (which: 'index' | 'pinch') => THREE.Vector3;
  grip: (side: 'L' | 'R', item: THREE.Object3D, mk: string, f: THREE.Vector3, n: THREE.Vector3, r: number, p: FingerPose, slide?: THREE.Vector3) => void;
  items: Record<string, THREE.Group>;
}

type Pose = { p: THREE.Vector3; q: THREE.Quaternion };
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const H = 0.072;
const PY = H + 0.002;
const CAP_Z = [-0.058, 0, 0.058];
const FP_POINT: FingerPose = { index: [-0.12, -0.2, -0.12], middle: [-1.25, -1.35, -0.85], ring: [-1.3, -1.35, -0.85], pinky: [-1.35, -1.3, -0.8], thumb: [0.3, -0.7, -0.6, -0.35] };
const FP_PINCH: FingerPose = { index: [-0.45, -0.7, -0.45], middle: [-0.9, -1.1, -0.7], ring: [-1.15, -1.25, -0.8], pinky: [-1.25, -1.25, -0.8], thumb: [0.15, -0.55, -0.45, -0.25], spread: 0.02 };
const FP_HOOK: FingerPose = { index: [-0.55, -0.9, -0.6], middle: [-0.6, -0.95, -0.6], ring: [-0.7, -1.0, -0.6], pinky: [-0.8, -1.0, -0.6], thumb: [0.3, -0.4, -0.4, -0.2] };
const FP_CUT: FingerPose = { index: [-1.0, -1.1, -0.7], middle: [-1.1, -1.2, -0.75], ring: [-1.15, -1.2, -0.75], pinky: [-1.2, -1.2, -0.75], thumb: [-0.2, -0.9, -0.6, -0.4] };

function handQ(f: THREE.Vector3, n: THREE.Vector3) {
  f = f.clone().normalize();
  n = n.clone().addScaledVector(f, -n.dot(f)).normalize();
  const Zh = f.clone().negate(), Yh = n.clone().negate();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(Yh, Zh), Yh, Zh));
}
const qE = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const ease = easeInOutCubic;
const win = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
function once(c: EqCtx, key: string, f: () => void) {
  const fired = (c.data.fired ??= new Set<string>()) as Set<string>;
  if (!fired.has(key)) {
    fired.add(key);
    f();
  }
}
function sfx(c: EqCtx, name: string) {
  const f = c.data.sfx as ((n: string) => void) | undefined;
  f?.(name);
}
function gunAway(pos: THREE.Vector3, rot: THREE.Vector3, a: number) {
  pos.y -= 0.38 * a;
  pos.x += 0.1 * a;
  pos.z += 0.05 * a;
  rot.x -= 1.0 * a;
  rot.z -= 0.45 * a;
  rot.y += 0.22 * a;
}
function mixPose(a: Pose, b: Pose, u: number): Pose {
  return { p: a.p.clone().lerp(b.p, u), q: a.q.clone().slerp(b.q, u) };
}
/** clock-driven way in / way out (the way out starts on done or abort) */
function presence(c: EqCtx, outDone: number) {
  const d = c.data as Record<string, any>;
  d.t0 ??= c.time;
  const kin = ease(clamp((c.time - d.t0) / 0.3, 0, 1));
  let kout = 0;
  if (d.done || d.abort) {
    d.tEnd ??= c.time;
    kout = clamp((c.time - d.tEnd) / (d.done ? outDone : 0.32), 0, 1);
    if (kout >= 1) d.finished = true;
  }
  return { kin, kout, done: !!d.done };
}
/** item-space point → root space for the item's current pose */
function toRoot(item: THREE.Object3D, p: THREE.Vector3) {
  return p.clone().applyQuaternion(item.quaternion).add(item.position);
}
/** wrist pose that puts a fingertip (or the pinch point) on a root-space point */
function tipPose(c: ChargeCtx, which: 'index' | 'pinch', at: THREE.Vector3, q: THREE.Quaternion): Pose {
  return { p: at.clone().sub(c.tip(which).applyQuaternion(q)), q };
}
/** a hand orientation given in item space */
function itemQ(item: THREE.Object3D, f: THREE.Vector3, n: THREE.Vector3) {
  return handQ(f.clone().applyQuaternion(item.quaternion), n.clone().applyQuaternion(item.quaternion));
}
function gripPose(c: ChargeCtx, side: 'L' | 'R', item: THREE.Object3D, mk: string, f: THREE.Vector3, n: THREE.Vector3, pose: FingerPose): Pose {
  c.grip(side, item, mk, f, n, 0.003, pose);
  const h = side === 'L' ? c.freeL : c.freeR;
  return { p: h.p.clone(), q: h.q.clone() };
}
/**
 * A track of right-hand segments [t0, t1, pose(u)]; between two segments the hand blends from
 * the end of one to the start of the next.
 */
type Seg = [number, number, (u: number) => { pose: Pose; fp: FingerPose }];
function track(t: number, segs: Seg[]) {
  for (let i = 0; i < segs.length; i++) {
    const [a, b, f] = segs[i];
    if (t <= b || i === segs.length - 1) {
      if (t >= a || i === 0) return f(win(t, a, b));
      const prev = segs[i - 1][2](1), next = f(0);
      const u = ease(win(t, segs[i - 1][1], a));
      return { pose: mixPose(prev.pose, next.pose, u), fp: u < 0.5 ? prev.fp : next.fp };
    }
  }
  return segs[segs.length - 1][2](1);
}
function keyAt(item: THREE.Object3D, i: number) {
  const r = Math.floor(i / 3), col = i % 3;
  return V(-0.165 + col * 0.026, PY + 0.0085, -0.02 + r * 0.023);
}
const digitKey = (d: string) => (d === '0' ? 10 : Number(d) - 1);
function ledColor(led: THREE.Object3D | undefined, green: boolean) {
  if (!led) return;
  led.userData.red ??= (led.userData.base as THREE.Color).clone();
  led.userData.base = green ? new THREE.Color(0.4, 4.5, 0.8) : led.userData.red;
}
function fmt(s: number) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = Math.floor(s % 60), cs = Math.floor((s * 100) % 100);
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${String(r).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// =============================================================================== plant
export function chargePlant(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: ChargeCtx) {
  const d = c.data as Record<string, any>;
  const item = c.items.charge;
  if (!d.init) {
    d.init = true;
    c.hold('charge');
    item.userData.reset?.();
    ledColor(item.getObjectByName('led'), false);
  }
  const { kin, kout, done } = presence(c, 0.75);
  const code: string = d.code ?? '4170923';
  // ---- the charge: up from the belt into the left hand, lowered to the ground at the end
  const OFF: Pose = { p: V(0.16, -0.62, -0.28), q: qE(0.1, 0.5, 0.35) };
  const HOLD: Pose = { p: V(0.11, -0.27, -0.52), q: qE(0.72, -0.16, 0.03) };
  const LOW: Pose = { p: V(0.03, -0.78, -0.66), q: qE(0.3, -0.05, 0) };
  let ps = mixPose(OFF, HOLD, kin);
  // weight: it settles a touch after each key press, breathes
  ps.p.y += Math.sin(c.time * 1.6) * 0.0025;
  if (done) ps = mixPose(ps, LOW, ease(win(kout, 0, 0.62)));
  else if (kout > 0) ps = mixPose(ps, OFF, ease(kout));
  item.visible = kin > 0.02 && !(done && kout > 0.62);
  item.userData.twoHand = true;

  // ---- parts: lid, keys, guard, arm button, LCD, LED
  const lid = item.getObjectByName('lid')!;
  const lidA = 1.2 * smoothstep(0.045, 0.13, t) + 1.05 * smoothstep(0.13, 0.19, t) - 0.06 * Math.sin(win(t, 0.19, 0.24) * Math.PI);
  lid.rotation.z = lidA;
  const slot = 0.48 / code.length;
  let typed = 0;
  let press = 0;
  for (let i = 0; i < 12; i++) {
    const k = item.getObjectByName('key' + i);
    if (k) k.position.y = k.userData.rest;
  }
  for (let i = 0; i < code.length; i++) {
    const u = (t - 0.22 - i * slot) / slot;
    if (u >= 0.55) typed = i + 1;
    if (u > 0.42 && u < 0.8) {
      const dn = smoothstep(0.42, 0.56, u) * (1 - smoothstep(0.62, 0.8, u));
      const k = item.getObjectByName('key' + digitKey(code[i]));
      if (k) k.position.y = k.userData.rest - 0.0026 * dn;
      press = Math.max(press, dn);
    }
    if (u >= 0.55) once(c, 'k' + i, () => sfx(c, 'keyBeep'));
  }
  ps.p.y -= 0.0025 * press;
  item.position.copy(ps.p);
  item.quaternion.copy(ps.q);
  item.userData.posed = true;
  item.updateMatrix();
  const guard = item.getObjectByName('armGuard')!;
  const gA = -1.95 * smoothstep(0.735, 0.775, t);
  guard.rotation.x = gA;
  const armDn = smoothstep(0.8, 0.825, t) * (1 - smoothstep(0.84, 0.87, t));
  const armBtn = item.getObjectByName('arm');
  if (armBtn) armBtn.position.y = armBtn.userData.rest - 0.0045 * armDn;
  const armed = t >= 0.825;
  if (armed) once(c, 'arm', () => sfx(c, 'armChirp'));
  if (t > 0.05) once(c, 'lid', () => sfx(c, 'lidOpen'));
  if (t > 0.75) once(c, 'guard', () => sfx(c, 'guardFlip'));
  const disp = item.userData.setDisplay as (s: string, m: string) => void;
  if (armed) disp('ARMERT', 'armed');
  else if (t > 0.18) disp(code.slice(0, typed).padEnd(code.length, '-'), 'type');
  else disp('KODE?', 'idle');
  const led = item.getObjectByName('led');
  setLed(led, armed ? 1 : typed > 0 && Math.sin(c.time * 14) > 0.3 ? 0.6 : 0.05);

  // ---- the gun
  const handsOut = done ? ease(win(kout, 0.6, 1)) : ease(kout);
  gunAway(pos, rot, kin * (1 - handsOut));

  // ---- left hand: holds the left end the whole time
  c.freeL.b = kin * (1 - handsOut);
  const lp = gripPose(c, 'L', item, 'gripL', V(0.15, -0.3, -1), V(1, 0.05, 0), POSES.hold);
  c.freeL.p.copy(lp.p);
  c.freeL.q.copy(lp.q);
  c.freeL.pose = POSES.hold;

  // ---- right hand
  const typeQ = itemQ(item, V(-0.85, -0.5, -0.35), V(0.1, -0.9, 0.4));
  const lipQ = itemQ(item, V(-0.8, -0.65, -0.25), V(0.1, -1, 0.1));
  const n = V(0, 1, 0).applyQuaternion(item.quaternion); // the panel normal (root space)
  const lidEdge = (a: number) => toRoot(item, V(-0.196, H, 0.02).add(V(0.224, 0.002, 0).applyAxisAngle(V(0, 0, 1), a)));
  const guardEdge = (a: number) => toRoot(item, V(-0.04, PY + 0.007, 0.032).add(V(0, 0.01, 0.038).applyAxisAngle(V(1, 0, 0), a)));
  const keyRoot = (i: number) => toRoot(item, keyAt(item, i));
  const segs: Seg[] = [
    // hook the lid lip and lift it until it tips over
    [0.0, 0.045, (u) => ({ pose: tipPose(c, 'index', lidEdge(0).addScaledVector(n, 0.03 * (1 - u)).add(V(0.015 * (1 - u), 0, 0).applyQuaternion(item.quaternion)), lipQ), fp: FP_HOOK })],
    [0.045, 0.13, (u) => ({ pose: tipPose(c, 'index', lidEdge(1.2 * smoothstep(0, 1, u)), lipQ), fp: FP_HOOK })],
    // type the code, key to key
    [0.22, 0.7, (u) => {
      const tt = 0.22 + u * 0.48;
      const i = clamp(Math.floor((tt - 0.22) / slot), 0, code.length - 1);
      const uu = (tt - 0.22 - i * slot) / slot;
      const from = keyRoot(digitKey(code[Math.max(0, i - 1)]));
      const to = keyRoot(digitKey(code[i]));
      const travel = ease(clamp(uu / 0.42, 0, 1));
      const at = from.lerp(to, travel);
      // a little arc between keys, down onto the key, back up
      const lift = 0.014 + 0.008 * Math.sin(travel * Math.PI) * (i > 0 ? 1 : 0);
      const dip = smoothstep(0.42, 0.56, uu) * (1 - smoothstep(0.62, 0.82, uu));
      at.addScaledVector(n, lift * (1 - dip) - 0.0026 * dip);
      return { pose: tipPose(c, 'index', at, typeQ), fp: FP_POINT };
    }],
    // the guard: fingertip under its front edge, flick it up
    [0.715, 0.735, (u) => ({ pose: tipPose(c, 'index', guardEdge(0).addScaledVector(n, 0.012 * (1 - u)).add(V(0, -0.004, 0.012).applyQuaternion(item.quaternion)), lipQ), fp: FP_HOOK })],
    [0.735, 0.765, (u) => ({ pose: tipPose(c, 'index', guardEdge(-1.4 * u).add(V(0, -0.004, 0.012).applyQuaternion(item.quaternion)), lipQ), fp: FP_HOOK })],
    // press the arm button
    [0.79, 0.88, (u) => {
      const at = toRoot(item, V(-0.04, PY + 0.014, 0.05));
      const dn = smoothstep(0.1, 0.38, u) * (1 - smoothstep(0.55, 0.85, u));
      at.addScaledVector(n, 0.018 * (1 - dn) - 0.004 * dn);
      return { pose: tipPose(c, 'index', at, typeQ), fp: FP_POINT };
    }],
    // the right end: both hands on it to lower it
    [0.95, 1.0, () => ({ pose: gripPose(c, 'R', item, 'gripR', V(-0.15, -0.3, -1), V(-1, 0.05, 0), POSES.hold), fp: POSES.hold })],
  ];
  const r = track(t, segs);
  d.noWrapR = r.fp !== POSES.hold;
  c.freeR.b = clamp((kin - 0.15) / 0.85, 0, 1) * (1 - handsOut);
  c.freeR.p.copy(r.pose.p);
  c.freeR.q.copy(r.pose.q);
  c.setRPose(r.fp);
  // the press goes through the arm into the camera, just
  pos.y -= 0.001 * press;
  if (armDn > 0.5) once(c, 'jolt', () => c.jolt(0.06, 0.03));
  if (done) once(c, 'down', () => sfx(c, 'placeDown'));
  if (d.finished) item.visible = false;
}

// =============================================================================== defuse
export function chargeDefuse(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: ChargeCtx) {
  const d = c.data as Record<string, any>;
  const item = c.items.charge;
  const cutters = c.items.cutters;
  if (!d.init) {
    d.init = true;
    c.hold('charge');
    item.userData.reset?.();
    ledColor(item.getObjectByName('led'), false);
    (item.getObjectByName('lid') as THREE.Object3D).rotation.z = 2.0;
    (item.getObjectByName('armGuard') as THREE.Object3D).rotation.x = -1.95;
  }
  const { kin, kout, done } = presence(c, 0.9);
  // the charge lies on the ground in front; the view tips down onto it as it comes in
  const OFF: Pose = { p: V(-0.06, -0.8, -0.6), q: qE(0.95, 0.22, 0) };
  const ON: Pose = { p: V(-0.05, -0.235, -0.56), q: qE(0.95, 0.22, 0) };
  const ps = mixPose(OFF, ON, kin);
  if (kout > 0 && !done) ps.p.lerp(OFF.p, ease(kout));
  if (done) ps.p.lerp(OFF.p, ease(win(kout, 0.55, 1)));
  item.position.copy(ps.p);
  item.quaternion.copy(ps.q);
  item.userData.posed = true;
  item.userData.twoHand = true;
  item.visible = true;
  item.updateMatrix();
  const n = V(0, 1, 0).applyQuaternion(item.quaternion);

  // ---- display + LED: the live fuse, then the result
  const disp = item.userData.setDisplay as (s: string, m: string) => void;
  const led = item.getObjectByName('led');
  const left = typeof d.timer === 'function' ? (d.timer as () => number)() : 30;
  const disarmed = t >= 0.93 || (done && !d.cut);
  if (done) {
    ledColor(led, true);
    setLed(led, 1);
    disp('DESARMERT', 'defused');
  } else {
    const period = left > 20 ? 1 : left > 10 ? 0.6 : left > 5 ? 0.32 : 0.17;
    setLed(led, (c.time % period) < 0.08 ? 1 : 0.05);
    disp(disarmed ? '--.--' : fmt(left), 'armed');
  }

  // ---- caps: pinched, worked loose, drawn out
  const W: [number, number][] = [[0.07, 0.33], [0.36, 0.6], [0.63, 0.86]];
  for (let i = 0; i < 3; i++) {
    const cap = item.getObjectByName('cap' + i)!;
    const rest = cap.userData.rest as THREE.Vector3;
    const u = win(t, W[i][0], W[i][1]);
    const wig = smoothstep(0.3, 0.38, u) * (1 - smoothstep(0.56, 0.62, u));
    const out = ease(win(u, 0.6, 0.86));
    cap.position.copy(rest).add(V(0.012 * out, 0.055 * out, 0));
    cap.rotation.set(0.14 * wig * Math.sin(c.time * 31 + i), 0, -0.1 * wig * Math.sin(c.time * 23) - 0.35 * ease(win(u, 0.88, 1)));
    if (u > 0.62) once(c, 'cap' + i, () => sfx(c, 'capPull'));
  }
  const armBtn = item.getObjectByName('arm');
  const armDn = smoothstep(0.9, 0.925, t) * (1 - smoothstep(0.94, 0.97, t));
  if (armBtn) armBtn.position.y = armBtn.userData.rest - 0.0045 * armDn;
  if (t > 0.925) once(c, 'disarm', () => sfx(c, 'armChirp'));

  const handsOut = done ? ease(win(kout, 0.5, 1)) : ease(kout);
  gunAway(pos, rot, kin * (1 - handsOut));

  // ---- left hand steadies the case by its end
  c.freeL.b = kin * (1 - handsOut);
  const lp = gripPose(c, 'L', item, 'gripL', V(0.2, -0.45, -1), V(1, 0.1, 0), POSES.hold);
  c.freeL.p.copy(lp.p);
  c.freeL.q.copy(lp.q);
  c.freeL.pose = POSES.hold;

  // ---- right hand
  const pinchQ = itemQ(item, V(-0.2, -0.85, -0.45), V(-1, 0, 0.15));
  const pokeQ = itemQ(item, V(-0.25, -0.8, -0.5), V(0.05, -0.55, 0.85));
  const capTop = (i: number) => toRoot(item, (item.getObjectByName('cap' + i)!.position).clone().add(V(0, 0.024, 0)));
  const segs: Seg[] = [];
  for (let i = 0; i < 3; i++) {
    segs.push([W[i][0], W[i][1], (u) => {
      const at = capTop(i);
      at.addScaledVector(n, 0.03 * (1 - ease(win(u, 0, 0.3))) + 0.02 * ease(win(u, 0.88, 1)));
      if (u > 0.3 && u < 0.62) at.add(V(0.002 * Math.sin(c.time * 31 + i), 0, 0.002 * Math.sin(c.time * 23)).applyQuaternion(item.quaternion));
      return { pose: tipPose(c, 'pinch', at, pinchQ), fp: u > 0.22 && u < 0.92 ? FP_PINCH : POSES.open };
    }]);
  }
  segs.push([0.89, 0.98, (u) => {
    const at = toRoot(item, V(-0.04, PY + 0.014, 0.05));
    const dn = smoothstep(0.15, 0.4, u) * (1 - smoothstep(0.55, 0.85, u));
    at.addScaledVector(n, 0.02 * (1 - dn) - 0.004 * dn);
    return { pose: tipPose(c, 'index', at, pokeQ), fp: FP_POINT };
  }]);
  let r = track(t, segs);

  // ---- the wire gamble: cutters out, jaws on the wire, snip
  cutters.visible = false;
  const cut = d.cut as { w: number; t0?: number } | undefined;
  if (cut) {
    cut.t0 ??= c.time;
    const u = clamp((c.time - cut.t0) / 0.62, 0, 1);
    const mid = toRoot(item, item.getObjectByName('wmid' + cut.w)!.position);
    // the jaws come down onto the wire across it
    const into = V(-0.25, -0.85, -0.45).applyQuaternion(item.quaternion).normalize();
    const along = V(1, 0, 0).applyQuaternion(item.quaternion);
    const Zc = into.clone().negate();
    const Yc = along.clone().addScaledVector(Zc, -along.dot(Zc)).normalize();
    const Xc = new THREE.Vector3().crossVectors(Yc, Zc);
    const cq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xc, Yc, Zc));
    const reach = ease(win(u, 0, 0.5));
    const bite = V(0, 0, -0.018).applyQuaternion(cq);
    const ready = mid.clone().addScaledVector(n, 0.07).add(V(0.06, -0.02, 0.06));
    const cp = ready.lerp(mid, reach).sub(bite).addScaledVector(n, 0.03 * ease(win(u, 0.7, 1)));
    cutters.position.copy(cp);
    cutters.quaternion.copy(cq);
    cutters.visible = true;
    const shut = smoothstep(0.5, 0.6, u);
    (cutters.userData.setOpen as (k: number) => void)((1 - shut) * smoothstep(0.1, 0.4, u));
    if (u >= 0.6 && !d.snipped) {
      d.snipped = true;
      (item.userData.cut as (i: number) => void)(cut.w);
      sfx(c, 'snip');
      c.jolt(0.12, 0.05);
      (d.onSnip as (() => void) | undefined)?.();
    }
    cutters.updateMatrix();
    const hp = gripPose(c, 'R', cutters, 'grip', V(0, -1, 0.1), V(-1, 0, 0), FP_CUT);
    const k = ease(win(u, 0, 0.18));
    r = { pose: mixPose(r.pose, hp, k), fp: k > 0.5 ? FP_CUT : r.fp };
  }
  d.noWrapR = r.fp !== FP_CUT;
  c.freeR.b = clamp((kin - 0.15) / 0.85, 0, 1) * (1 - handsOut);
  c.freeR.p.copy(r.pose.p);
  c.freeR.q.copy(r.pose.q);
  c.setRPose(r.fp);
  if (d.finished) {
    item.visible = false;
    cutters.visible = false;
  }
}
