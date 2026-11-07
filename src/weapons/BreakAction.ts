import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { Pose, mul, inv, handFrame } from './ReloadClips';
import { DB_HINGE, DB_W, WeaponModel } from './WeaponModels';
import { clamp, easeInOutCubic, easeOutBack } from '../core/math';

/**
 * Break-action reload for the side-by-side ("Tvilling").
 *
 * The reload is chosen from the gun's state each time:
 *  - one barrel fired  → break it open just far enough, the ejector flicks the spent hull out,
 *    the unfired shell only lifts on the extractor; one fresh shell goes into the empty chamber
 *  - both fired, variant "dual"  → snap it open with a downward flick so both hulls fly, feed a
 *    pair of shells pinched between the fingers in one push, then flick the stock up to close
 *  - both fired, variant "flip"  → open, tip the muzzle high so the hulls pop over the shoulder,
 *    feed the shells one after the other, then close by palming the barrels up
 * Closing is either the stock flicked up to meet the barrels (right hand) or the support hand
 * lifting the forend; both slam with a jolt and the top lever snaps back.
 *
 * The support hand holding shells is driven from the shell pose (hand = shells ∘ grip), so the
 * shells line up with the chambers and enter along the bore axis of the (tilted) barrels.
 */
export interface BreakData {
  /** chambers to fill, in order */
  slots: ('L' | 'R')[];
  /** chambers whose hull is ejected */
  spent: ('L' | 'R')[];
  variant: 'single' | 'dual' | 'flip';
  palmClose: boolean;
  /** closed support-hand pose (weapon space), filled in on the first frame */
  S?: Pose;
}

export interface BreakHands {
  leftTarget: THREE.Vector3;
  leftQ: THREE.Quaternion;
  setLeft: (b: number, p: FingerPose) => void;
}

const OPEN = -0.66;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const E = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
const bore = 0.03;

type Key<T> = [number, T];
function seq(t: number, keys: Key<number>[]) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
  }
  return keys[keys.length - 1][1];
}
/** pose keys, eased between neighbours (positions lerped, rotations slerped) */
function poseSeq(t: number, keys: Key<Pose>[], out: Pose) {
  if (t <= keys[0][0]) return copyPose(out, keys[0][1]);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t <= t1) {
      const u = easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
      out.p.lerpVectors(a.p, b.p, u);
      out.q.slerpQuaternions(a.q, b.q, u);
      return out;
    }
  }
  return copyPose(out, keys[keys.length - 1][1]);
}
function copyPose(o: Pose, p: Pose) {
  o.p.copy(p.p);
  o.q.copy(p.q);
  return o;
}

/** Barrel pivot pose (weapon space) for an opening angle. */
function pivotPose(angle: number): Pose {
  return { p: DB_HINGE.clone(), q: new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), angle) };
}
/** A point/pose given in closed (action) coordinates, carried by the barrels at `angle`. */
function onBarrels(angle: number, p: Pose): Pose {
  return mul(pivotPose(angle), { p: p.p.clone().sub(DB_HINGE), q: p.q.clone() });
}

// support hand pinching shells by their brass heads, from above and behind, fingers forward-down
const PINCH_Q = handFrame(V(0.15, 0.45, -0.88), V(1, 0.2, 0)); // fingers up-forward, palm toward the gun: the hand feeds from the left and below
const PINCH_AT = V(0, -0.024, -0.082); // pinch point in hand space
/** hand (wrist) pose in shell-pair space */
const GRIP: Pose = { p: V(0, 0.006, 0.004).sub(PINCH_AT.clone().applyQuaternion(PINCH_Q)), q: PINCH_Q };
const GRIP_INV = inv(GRIP);

export function breakAction(
  model: WeaponModel, d: BreakData, t: number, pos: THREE.Vector3, rot: THREE.Vector3, h: BreakHands,
  onEvent: (e: string) => void, fired: Set<string>, jolt: (up: number, roll: number, back?: number) => void,
) {
  const parts = model.parts;
  const S = d.S!;
  const fire = (k: string, at: number, f: () => void) => {
    if (t >= at && !fired.has(k)) {
      fired.add(k);
      f();
    }
  };
  // ---------------- timeline per variant ----------------
  const v = d.variant;
  const T = v === 'single'
    ? { o0: 0.05, o1: 0.17, ej: 0.16, p0: 0.25, p1: 0.33, ins: [[0.43, 0.56]] as [number, number][], c0: 0.68, c1: 0.76 }
    : v === 'dual'
      ? { o0: 0.04, o1: 0.14, ej: 0.13, p0: 0.23, p1: 0.31, ins: [[0.42, 0.55]] as [number, number][], c0: 0.68, c1: 0.75 }
      : { o0: 0.04, o1: 0.14, ej: 0.24, p0: 0.32, p1: 0.39, ins: [[0.45, 0.53], [0.57, 0.66]] as [number, number][], c0: 0.75, c1: 0.85 };
  const lastIns = T.ins[T.ins.length - 1][1];
  const openK = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : easeOutBack(x, 1.8));
  let angle = OPEN * openK((t - T.o0) / (T.o1 - T.o0));
  if (t > T.c0) {
    const k = clamp((t - T.c0) / (T.c1 - T.c0), 0, 1);
    angle = OPEN * (1 - k * k * k); // accelerates shut: it slams
  }
  if (parts.barrels) parts.barrels.rotation.x = angle;
  // top lever: thumbed over before the barrels drop, snaps back as they lock
  const lever = t < T.o0 ? clamp((t - (T.o0 - 0.04)) / 0.04, 0, 1) : t < T.c1 ? 1 : Math.max(0, 1 - (t - T.c1) / 0.025);
  if (parts.lever) parts.lever.rotation.y = -0.55 * lever;
  fire('lever', T.o0 - 0.04, () => onEvent('fireMode'));
  fire('open', T.o0 + 0.02, () => {
    onEvent('boltOpen');
    jolt(0.35, 0.4, 0.2);
  });
  // ---------------- chambers: ejector throws spent hulls, extractor lifts the rest ----------------
  const ext = clamp((t - T.o0) / (T.o1 - T.o0), 0, 1) * (t < T.c0 ? 1 : 0);
  for (const side of ['L', 'R'] as const) {
    const sh = parts[side === 'L' ? 'shellL' : 'shellR'];
    if (!sh) continue;
    const spent = d.spent.includes(side);
    const filled = d.slots.indexOf(side);
    const insEnd = filled >= 0 ? T.ins[Math.min(filled, T.ins.length - 1)][1] : -1;
    sh.visible = spent ? t < T.ej || (insEnd > 0 && t >= insEnd) : true;
    sh.position.z = (spent && t >= insEnd && insEnd > 0 ? 0 : 0.006 * ext) + 0; // extractor lift (closed: flush)
  }
  for (const side of d.spent) fire('eject' + side, T.ej, () => onEvent(side === 'L' ? 'hullL' : 'hullR'));
  // ---------------- gun motion (camera-space offsets on top of the hip pose) ----------------
  // held low and pushed out, muzzle tipped up so the open barrels hang level: the breech sits in
  // the lower middle of the view and the feeding hand stays below the line of sight
  const base = { p: V(-0.06, -0.035, -0.25), r: V(0.68, 0.4, -0.32) };
  const tilt = seq(t, [[0, 0], [T.o0, 0.55], [T.o1 + 0.04, 1], [T.c0 - 0.04, 1], [T.c1 + 0.08, 0.35], [1, 0]]);
  pos.addScaledVector(base.p, tilt);
  rot.addScaledVector(base.r, tilt);
  if (v === 'dual' || v === 'single') {
    // the flick that throws the hulls: muzzle snapped down, then recovered
    const flick = seq(t, [[0, 0], [T.o1 - 0.05, 0], [T.o1 - 0.005, 1], [T.o1 + 0.07, 0]]);
    rot.x -= 0.42 * flick * (v === 'single' ? 0.6 : 1);
    pos.y -= 0.03 * flick;
    pos.z += 0.03 * flick;
  } else {
    // flip: muzzle tipped high so the hulls pop out back over the shoulder
    const up = seq(t, [[0, 0], [T.o1, 0], [T.ej - 0.02, 1], [T.ej + 0.03, 1.08], [T.p0 + 0.02, 0]]);
    rot.x += 0.5 * up;
    rot.y -= 0.1 * up;
    pos.y += 0.04 * up;
    pos.z += 0.03 * up;
  }
  // while feeding: present the breech to the hand, follow each push
  for (const [i0, i1] of T.ins) {
    const push = seq(t, [[0, 0], [i0, 0], [i1 - 0.03, 1], [i1 + 0.04, 0]]);
    rot.x -= 0.06 * push;
    pos.z -= 0.008 * push;
  }
  if (!d.palmClose) {
    // stock flicked up to meet the hanging barrels: the action pitches nose-down about the hinge
    // (a short wind-up first), the barrels' inertia does the rest
    const snap = seq(t, [[0, 0], [T.c0 - 0.06, 0], [T.c0, -0.25], [T.c1 - 0.01, 1], [T.c1 + 0.09, 0]]);
    rot.x -= 0.26 * snap;
    pos.y += 0.02 * snap;
  }
  fire('close', T.c1, () => {
    onEvent('boltClose');
    jolt(1.6, -0.8, -0.6);
  });
  // ---------------- shells in the support hand ----------------
  const hs = parts.handShells, hsL = parts.hsL, hsR = parts.hsR;
  const dual = v === 'dual' && d.slots.length === 2;
  const pick = T.p1 - 0.02;
  let holding = 0; // shells in hand
  if (t >= pick && t < lastIns) {
    holding = dual ? 2 : 1;
    if (!dual && T.ins.length > 1 && t >= T.ins[0][1]) holding = 1;
  }
  // which insert is current
  let cur = 0;
  for (let i = 0; i < T.ins.length; i++) if (t >= T.ins[i][1]) cur = Math.min(T.ins.length - 1, i + 1);
  const slot = d.slots[Math.min(cur, d.slots.length - 1)] ?? 'R';
  if (hs && hsL && hsR) {
    hs.visible = holding > 0;
    hsL.visible = dual;
    hsR.visible = holding > 0;
    hsL.position.x = -DB_W;
    hsR.position.x = dual ? DB_W : 0;
  }
  /** pose of the shell pair (or single shell) `back` metres out of the chamber(s) along the bore */
  const shellsAt = (back: number, up: number, side: 'L' | 'R' | 'C', a = angle): Pose => {
    const x = side === 'C' ? 0 : side === 'L' ? -DB_W : DB_W;
    return onBarrels(a, { p: V(x, bore + up, back), q: new THREE.Quaternion() });
  };
  const handFor = (sp: Pose) => mul(sp, GRIP);
  const pouch: Pose = { p: V(-0.17, -0.48, 0.14), q: S.q.clone().multiply(E(0.6, 0.2, 0.4)) };
  const below: Pose = { p: S.p.clone().add(V(-0.05, -0.08, 0.03)), q: S.q.clone() };
  const forend = (a: number) => onBarrels(a, S);
  const hk: Key<Pose>[] = [];
  hk.push([0, forend(0)]);
  hk.push([T.o0, forend(0)]);
  hk.push([T.o1, forend(OPEN)]);
  hk.push([T.o1 + 0.05, { p: forend(OPEN).p.add(V(-0.03, -0.06, 0.03)), q: S.q.clone() }]);
  hk.push([T.p0, pouch]);
  hk.push([T.p1, { p: pouch.p.clone().add(V(0.01, 0.015, -0.01)), q: pouch.q.clone() }]);
  T.ins.forEach(([i0, i1], i) => {
    const sd: 'L' | 'R' | 'C' = dual ? 'C' : d.slots[Math.min(i, d.slots.length - 1)] ?? 'R';
    if (i > 0) hk.push([i0 - 0.03, handFor(shellsAt(0.07, 0.04, sd, OPEN))]);
    hk.push([i0, handFor(shellsAt(0.07, 0.025, sd, OPEN))]);
    hk.push([i0 + (i1 - i0) * 0.55, handFor(shellsAt(0.03, 0.003, sd, OPEN))]);
    hk.push([i1 - 0.012, handFor(shellsAt(0.0, 0, sd, OPEN))]);
    hk.push([i1, handFor(shellsAt(-0.004, 0, sd, OPEN))]); // thumb press: seated
    if (i < T.ins.length - 1) hk.push([i1 + 0.03, handFor(shellsAt(0.05, 0.03, sd, OPEN))]);
  });
  if (d.palmClose) {
    hk.push([lastIns + 0.05, { p: forend(OPEN).p.add(V(-0.02, -0.05, 0.02)), q: S.q.clone() }]);
    hk.push([T.c0, forend(OPEN)]);
    hk.push([T.c1, forend(0)]);
  } else {
    hk.push([lastIns + 0.05, { p: below.p.clone().add(V(0.0, -0.02, 0.06)), q: S.q.clone() }]);
    hk.push([T.c1 + 0.02, below]);
  }
  hk.push([0.92, forend(0)]);
  hk.push([1, forend(0)]);
  hk.sort((a, b) => a[0] - b[0]);
  // during the close the hand rides the forend exactly (it is what pushes the barrels up)
  const out: Pose = { p: V(), q: new THREE.Quaternion() };
  if (d.palmClose && t >= T.c0 && t <= T.c1) copyPose(out, forend(angle));
  else if (t >= T.o0 && t <= T.o1) copyPose(out, forend(angle));
  else poseSeq(t, hk, out);
  h.leftTarget.copy(out.p);
  h.leftQ.copy(out.q);
  const onForend = t < T.o1 + 0.02 || t > 0.9 || (d.palmClose && t > T.c0 - 0.02 && t < T.c1 + 0.04);
  h.setLeft(1, onForend ? POSES.support : holding > 0 ? POSES.pinch : POSES.open);
  // shells follow the hand
  if (hs && holding > 0) {
    const sh = mul(out, GRIP_INV);
    hs.position.copy(sh.p);
    hs.quaternion.copy(sh.q);
  }
  for (let i = 0; i < T.ins.length; i++) {
    fire('touch' + i, T.ins[i][0] + (T.ins[i][1] - T.ins[i][0]) * 0.55, () => onEvent('magTouch'));
    fire('in' + i, T.ins[i][1] - 0.01, () => {
      onEvent('shellIn');
      jolt(0.3, -0.2);
    });
  }
  fire('pouch', T.p0, () => onEvent('cloth'));
  if (t > 0.94) fire('end', 0.94, () => onEvent('rattle'));
}

/** Choose the reload for the current chamber state. */
export function planBreak(loaded: number, cap: number, reserve: number): BreakData {
  // right barrel fires first: with one loaded, the right chamber is the spent one
  const spent: ('L' | 'R')[] = loaded >= cap ? [] : loaded === 1 ? ['R'] : ['R', 'L'];
  const n = Math.min(spent.length, reserve);
  const slots = spent.slice(0, n);
  const variant: BreakData['variant'] = n < 2 ? 'single' : Math.random() < 0.6 ? 'dual' : 'flip';
  return { slots, spent, variant, palmClose: variant === 'flip' ? true : variant === 'dual' ? false : Math.random() < 0.5 };
}
