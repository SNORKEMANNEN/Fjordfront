import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { smoothstep, easeInOutCubic, easeOutCubic } from '../core/math';

/**
 * R357 revolver choreography (the revolver has no magazine, so it gets its own animation set).
 *
 *  fire          hammer falls, then thumbs back over ~0.12 s while the cylinder indexes 60°
 *  draw          a quick twirl on the trigger finger as it comes up
 *  reload        (tactical) roll the gun, fingers push the cylinder out, muzzle up, palm the
 *                ejector rod — six cases fall — muzzle down, speedloader from the belt, line it
 *                up with the chambers, push in, twist the knob, pull the empty loader away
 *                and drop it, then the support hand pushes the cylinder closed
 *  reloadEmpty   same opening but faster, and it ends with a wrist flick that snaps the
 *                cylinder shut by itself
 *  inspect       two twirls on the trigger finger, flick the cylinder open, spin it with the
 *                support hand, look, flick it closed
 *  inspectMag    push the cylinder out, tilt to look at the rims, turn it one chamber by hand,
 *                push it closed
 *
 * Support-hand targets are anchored to the crane (so they follow the swinging cylinder) or to
 * fixed points in camera space (the belt pouch), and blended in sequence. Everything else is
 * keyframed per action.
 */

type V3 = [number, number, number];
type Target = 'grip' | 'under' | 'rod' | 'belt' | 'loaderPre' | 'knob' | 'away' | 'closeSide' | 'rest' | 'swipe' | 'turn';
interface Plan { keys: [number, Target][]; loader: 'hidden' | 'palm' | 'gun'; loaderD: number; t: number }

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();

function kf(t: number, keys: [number, number][]) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      return a + (b - a) * smoothstep(0, 1, (t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}
function kv(t: number, keys: [number, V3][], out = new THREE.Vector3()) {
  if (t <= keys[0][0]) return out.set(...keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      const u = smoothstep(0, 1, (t - t0) / Math.max(1e-6, t1 - t0));
      return out.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    }
  }
  return out.set(...keys[keys.length - 1][1]);
}
function handQ(f: THREE.Vector3, n: THREE.Vector3) {
  f = f.clone().normalize();
  n = n.clone().addScaledVector(f, -n.dot(f)).normalize();
  const Zh = f.clone().negate(), Yh = n.clone().negate();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(Yh, Zh), Yh, Zh));
}

export interface RevState {
  /** seconds since the last shot (hammer / index animation) */
  shotT: number;
  /** chamber index the cylinder rests on (fractional while turning) */
  idx: number;
  idxFrom: number;
  /** free-spin velocity (inspect) */
  spinV: number;
  spinA: number;
  plan: Plan | null;
  fired: Set<string>;
}

export function newRevState(): RevState {
  return { shotT: 9, idx: 0, idxFrom: 0, spinV: 0, spinA: 0, plan: null, fired: new Set() };
}

/** Called on every shot. */
export function revolverShot(s: RevState) {
  s.shotT = 0;
  s.idxFrom = Math.round(s.idx);
}

/** Per-frame: hammer and cylinder indexing outside of actions. */
export function revolverIdle(s: RevState, parts: Record<string, THREE.Object3D>, dt: number, emit: (e: string) => void) {
  s.shotT += dt;
  const ham = parts.hammer, cyl = parts.cylinder;
  // hammer: falls on the shot, thumbed back from 60–180 ms
  let cock = 1;
  if (s.shotT < 0.06) cock = 0;
  else if (s.shotT < 0.18) cock = easeInOutCubic((s.shotT - 0.06) / 0.12);
  if (ham) ham.rotation.x = 0.62 * cock;
  if (s.shotT > 0.06 && s.shotT - dt <= 0.06) emit('hammer');
  // index 60° while the hammer comes back
  if (s.shotT < 0.2) s.idx = s.idxFrom + easeInOutCubic(Math.min(1, Math.max(0, (s.shotT - 0.06) / 0.12)));
  // free spin (inspect)
  if (Math.abs(s.spinV) > 0.01) {
    s.spinA += s.spinV * dt;
    s.spinV *= Math.exp(-dt * 1.6);
    if (Math.abs(s.spinV) < 0.6) {
      // settle into the nearest chamber
      const target = Math.round(s.spinA / (Math.PI / 3)) * (Math.PI / 3);
      s.spinA += (target - s.spinA) * Math.min(1, dt * 12);
      if (Math.abs(target - s.spinA) < 0.002) s.spinV = 0;
    }
  }
  if (cyl) cyl.rotation.z = -s.idx * (Math.PI / 3) + s.spinA;
}

/** Reset the action-driven parts. */
export function revolverReset(parts: Record<string, THREE.Object3D>) {
  if (parts.crane) parts.crane.rotation.z = 0;
  if (parts.ejector) parts.ejector.position.z = 0;
  if (parts.rounds) parts.rounds.visible = true;
  if (parts.loader) parts.loader.visible = false;
  if (parts.loaderRounds) parts.loaderRounds.visible = true;
  if (parts.spin) parts.spin.rotation.set(0, 0, 0);
}

const OPEN = 1.35;

/**
 * Animate one action. Returns false when the action is not one the revolver overrides.
 * Writes weapon motion into pos/rot and part states, and leaves a hand plan for revolverLate().
 */
export function revolverAction(s: RevState, type: string, t: number, pos: THREE.Vector3, rot: THREE.Vector3, parts: Record<string, THREE.Object3D>, emit: (e: string) => void, vm: { jolt: (a: number, b: number, c?: number) => void }): boolean {
  const once = (key: string, at: number) => {
    if (t >= at && !s.fired.has(key)) {
      s.fired.add(key);
      emit(key);
    }
  };
  const crane = parts.crane, ej = parts.ejector, rounds = parts.rounds, loader = parts.loader, lr = parts.loaderRounds, spin = parts.spin;
  switch (type) {
    case 'draw': {
      // twirl up into the hand
      const e = 1 - easeInOutCubic(t);
      pos.y -= 0.2 * e;
      pos.x += 0.03 * e;
      rot.x -= 0.5 * e;
      if (spin) spin.rotation.x = -Math.PI * 2 * easeOutCubic(Math.min(1, t * 1.15));
      s.plan = null;
      return true;
    }
    case 'reload':
    case 'reloadEmpty': {
      const empty = type === 'reloadEmpty';
      if (t < 0.02) s.fired.clear();
      pos.add(kv(t, [[0, [0, 0, 0]], [0.08, [-0.045, 0.06, -0.04]], [0.2, [0.01, 0.05, -0.08]], [0.34, [0.01, 0.05, -0.08]], [0.44, [-0.05, 0.065, -0.06]], [empty ? 0.8 : 0.84, [-0.05, 0.065, -0.06]], [0.92, [-0.02, 0.02, -0.02]], [1, [0, 0, 0]]]));
      const rk: [number, V3][] = empty
        ? [[0, [0, 0, 0]], [0.08, [0.12, 0.05, 0.6]], [0.2, [1.0, -0.25, 0.2]], [0.34, [1.05, -0.25, 0.2]], [0.44, [-0.35, 0.3, 0.7]], [0.78, [-0.32, 0.3, 0.68]], [0.83, [-0.3, 0.1, 0.95]], [0.855, [-0.2, 0.05, -0.4]], [0.9, [-0.08, 0.02, 0.06]], [1, [0, 0, 0]]]
        : [[0, [0, 0, 0]], [0.08, [0.12, 0.05, 0.6]], [0.2, [1.0, -0.25, 0.2]], [0.34, [1.05, -0.25, 0.2]], [0.44, [-0.35, 0.3, 0.7]], [0.84, [-0.32, 0.3, 0.68]], [0.92, [-0.05, 0.05, 0.25]], [1, [0, 0, 0]]];
      rot.add(kv(t, rk));
      if (crane) crane.rotation.z = OPEN * (empty ? kf(t, [[0.07, 0], [0.14, 1], [0.835, 1], [0.86, 0]]) : kf(t, [[0.08, 0], [0.16, 1], [0.84, 1], [0.9, 0]]));
      if (ej) ej.position.z = 0.03 * kf(t, [[0.27, 0], [0.31, 1], [0.36, 1], [0.4, 0]]);
      if (rounds) rounds.visible = t < 0.345 || t > 0.69;
      const loaderOn = t > 0.46 && t < (empty ? 0.79 : 0.8);
      if (loader) loader.visible = loaderOn;
      if (lr) lr.visible = t < 0.69;
      const d = kf(t, [[0.58, 0.06], [0.62, 0.045], [0.68, 0.0]]);
      const mode: Plan['loader'] = !loaderOn ? 'hidden' : t > 0.59 && t < 0.745 ? 'gun' : 'palm';
      const keys: [number, Target][] = empty
        ? [[0, 'grip'], [0.06, 'under'], [0.15, 'under'], [0.22, 'rod'], [0.37, 'rod'], [0.43, 'belt'], [0.5, 'belt'], [0.58, 'loaderPre'], [0.6, 'knob'], [0.74, 'knob'], [0.79, 'away'], [0.86, 'grip']]
        : [[0, 'grip'], [0.07, 'under'], [0.16, 'under'], [0.22, 'rod'], [0.37, 'rod'], [0.43, 'belt'], [0.5, 'belt'], [0.58, 'loaderPre'], [0.6, 'knob'], [0.74, 'knob'], [0.79, 'away'], [0.83, 'closeSide'], [0.9, 'closeSide'], [0.97, 'grip']];
      s.plan = { keys, loader: mode, loaderD: d, t };
      once('cylOpen', empty ? 0.07 : 0.08);
      once('ejectRod', 0.29);
      once('eject6', 0.34);
      once('cloth', 0.45);
      once('insert', 0.62);
      once('shellIn', 0.69);
      once('loaderDrop', empty ? 0.78 : 0.79);
      if (empty) {
        if (t >= 0.85 && !s.fired.has('cylFlipClose')) {
          s.fired.add('cylFlipClose');
          emit('cylFlipClose');
          vm.jolt(1.2, 0.5, -0.6);
        }
      } else once('cylClose', 0.88);
      return true;
    }
    case 'inspect': {
      if (t < 0.02) s.fired.clear();
      pos.add(kv(t, [[0, [0, 0, 0]], [0.06, [-0.02, 0.03, -0.02]], [0.32, [-0.02, 0.035, -0.02]], [0.4, [-0.03, 0.045, -0.04]], [0.5, [-0.04, 0.05, -0.05]], [0.76, [-0.04, 0.05, -0.05]], [0.86, [-0.02, 0.02, -0.02]], [1, [0, 0, 0]]]));
      rot.add(kv(t, [[0, [0, 0, 0]], [0.06, [0.1, 0, 0]], [0.32, [0.1, 0, 0]], [0.44, [0.05, 0.25, 0.1]], [0.455, [0.05, 0.25, 0.85]], [0.5, [0.15, 0.45, 0.55]], [0.74, [0.2, 0.5, 0.55]], [0.785, [0.1, 0.3, 0.7]], [0.8, [0.05, 0.2, -0.3]], [0.86, [0.02, 0.05, 0.05]], [1, [0, 0, 0]]]));
      // two twirls on the trigger finger
      const tw = Math.min(1, Math.max(0, (t - 0.07) / 0.24));
      if (spin) spin.rotation.x = -Math.PI * 4 * easeInOutCubic(tw);
      if (crane) crane.rotation.z = OPEN * kf(t, [[0.45, 0], [0.47, 1], [0.79, 1], [0.805, 0]]);
      if (t >= 0.565 && !s.fired.has('spinv')) {
        s.fired.add('spinv');
        s.spinV = 26;
      }
      s.plan = { keys: [[0, 'grip'], [0.05, 'rest'], [0.44, 'rest'], [0.53, 'swipe'], [0.58, 'swipe'], [0.66, 'rest'], [0.86, 'rest'], [0.95, 'grip']], loader: 'hidden', loaderD: 0, t };
      once('inspect1', 0.07);
      once('cylFlipOpen', 0.452);
      once('spin', 0.565);
      if (t >= 0.8 && !s.fired.has('cylFlipClose')) {
        s.fired.add('cylFlipClose');
        emit('cylFlipClose');
        vm.jolt(1.0, 0.4, -0.5);
      }
      return true;
    }
    case 'inspectMag': {
      if (t < 0.02) s.fired.clear();
      pos.add(kv(t, [[0, [0, 0, 0]], [0.12, [-0.03, 0.04, -0.03]], [0.85, [-0.03, 0.045, -0.035]], [1, [0, 0, 0]]]));
      rot.add(kv(t, [[0, [0, 0, 0]], [0.12, [0.15, 0.05, 0.55]], [0.3, [0.35, 0.35, 0.45]], [0.7, [0.35, 0.35, 0.45]], [0.85, [0.1, 0.05, 0.35]], [1, [0, 0, 0]]]));
      if (crane) crane.rotation.z = OPEN * kf(t, [[0.1, 0], [0.2, 1], [0.76, 1], [0.84, 0]]);
      if (t >= 0.48 && !s.fired.has('turn')) {
        s.fired.add('turn');
        s.spinV = 0;
        s.idxFrom = Math.round(s.idx);
      }
      if (t > 0.48 && t < 0.6) s.idx = s.idxFrom + easeInOutCubic((t - 0.48) / 0.12);
      s.plan = { keys: [[0, 'grip'], [0.09, 'under'], [0.22, 'under'], [0.4, 'turn'], [0.6, 'turn'], [0.72, 'closeSide'], [0.84, 'closeSide'], [0.95, 'grip']], loader: 'hidden', loaderD: 0, t };
      once('cylOpen', 0.1);
      once('rattle', 0.5);
      once('cylClose', 0.82);
      return true;
    }
  }
  return false;
}

/**
 * After the weapon transform is final: support-hand target (camera/root space) and the loader.
 * `wristFor(anchor, q, r)` converts a palm-centre anchor to a wrist target; `palm` gives the
 * palm centre for a wrist pose (for loader-in-palm).
 */
export function revolverLate(
  s: RevState, parts: Record<string, THREE.Object3D>, rootInv: THREE.Matrix4, rev: { vC: number; cu0: number; cu1: number },
  wristFor: (a: THREE.Vector3, q: THREE.Quaternion, r: number) => THREE.Vector3,
  palmOf: (wrist: THREE.Vector3, q: THREE.Quaternion) => THREE.Vector3,
  out: { b: number; p: THREE.Vector3; q: THREE.Quaternion; pose: FingerPose },
  loaderRoot: THREE.Object3D,
) {
  const plan = s.plan;
  const loader = parts.loader;
  if (!plan) {
    if (loader) loader.visible = false;
    return;
  }
  const crane = parts.crane, cyl = parts.cylinder, ej = parts.ejector;
  // crane frame in root space
  tmpM.multiplyMatrices(rootInv, crane.matrixWorld);
  const craneQ = new THREE.Quaternion().setFromRotationMatrix(tmpM);
  const inCrane = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(tmpM);
  const axis = cyl.position; // cylinder axis in crane space
  const cR = 0.0212;
  const midZ = -(rev.cu0 + rev.cu1) / 2;
  const target = (name: Target): { p: THREE.Vector3; q: THREE.Quaternion; pose: FingerPose; b: number } => {
    switch (name) {
      case 'grip':
        return { p: new THREE.Vector3(), q: new THREE.Quaternion(), pose: POSES.support, b: 0 };
      case 'under': {
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(1, 0.25, 0), new THREE.Vector3(0, 1, 0)));
        return { p: wristFor(inCrane(axis.x + 0.004, axis.y - cR - 0.004, midZ), q, 0.004), q, pose: POSES.support, b: 1 };
      }
      case 'rod': {
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(1, -0.15, 0.25), new THREE.Vector3(0, 0, 1)));
        const tipZ = -(rev.cu1 + 0.04) + (ej?.position.z ?? 0) - 0.002;
        return { p: wristFor(inCrane(axis.x, axis.y, tipZ), q, 0.003), q, pose: POSES.open, b: 1 };
      }
      case 'knob':
      case 'loaderPre': {
        const d = name === 'loaderPre' ? 0.06 : plan.loaderD;
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(0, 1, 0.15), new THREE.Vector3(0, 0, -1)));
        const z = -rev.cu0 + 0.0013 + d + 0.028;
        return { p: wristFor(inCrane(axis.x, axis.y, z), q, 0.006), q, pose: POSES.pinch, b: 1 };
      }
      case 'closeSide': {
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(0, 0.3, -1), new THREE.Vector3(1, 0, 0)));
        return { p: wristFor(inCrane(axis.x - cR - 0.004, axis.y, midZ), q, 0.003), q, pose: POSES.open, b: 1 };
      }
      case 'swipe': {
        // fingers drag across the top of the open cylinder
        const k = Math.min(1, Math.max(0, (plan.t - 0.53) / 0.05));
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(0.2, 0, -1), new THREE.Vector3(0, -1, 0)));
        return { p: wristFor(inCrane(axis.x + 0.012 - 0.03 * k, axis.y + cR + 0.004, midZ), q, 0.002), q, pose: POSES.open, b: 1 };
      }
      case 'turn': {
        // thumb on the rims, turning the cylinder a click
        const q = craneQ.clone().multiply(handQ(new THREE.Vector3(1, 0.2, 0.2), new THREE.Vector3(0, 0.5, -1)));
        return { p: wristFor(inCrane(axis.x - 0.006, axis.y - cR * 0.6, -rev.cu0 + 0.006), q, 0.004), q, pose: POSES.pinch, b: 1 };
      }
      case 'belt':
        return { p: new THREE.Vector3(-0.13, -0.38, -0.2), q: handQ(new THREE.Vector3(0.1, -1, -0.3), new THREE.Vector3(1, 0, 0)), pose: POSES.hold, b: 1 };
      case 'away':
        return { p: new THREE.Vector3(-0.17, -0.27, -0.32), q: handQ(new THREE.Vector3(0.1, -0.6, -1), new THREE.Vector3(1, 0.2, 0)), pose: POSES.hold, b: 1 };
      case 'rest':
        return { p: new THREE.Vector3(-0.16, -0.3, -0.26), q: handQ(new THREE.Vector3(0.2, -0.5, -1), new THREE.Vector3(1, 0.3, 0)), pose: POSES.hold, b: 1 };
    }
  };
  // blend between the two keys around t
  const keys = plan.keys;
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < plan.t) i++;
  const [t0, n0] = keys[i - 1], [t1, n1] = keys[i];
  const u = plan.t <= t0 ? 0 : plan.t >= t1 ? 1 : smoothstep(0, 1, (plan.t - t0) / Math.max(1e-6, t1 - t0));
  const A = target(n0), B = target(n1);
  if (A.b === 0 && B.b === 0) out.b = 0;
  else if (A.b === 0) {
    out.p.copy(B.p); out.q.copy(B.q); out.pose = B.pose; out.b = u;
  } else if (B.b === 0) {
    out.p.copy(A.p); out.q.copy(A.q); out.pose = A.pose; out.b = 1 - u;
  } else {
    out.p.copy(A.p).lerp(B.p, u); out.q.copy(A.q).slerp(B.q, u); out.pose = u < 0.5 ? A.pose : B.pose; out.b = 1;
  }
  // the speedloader: in the palm while fetching, locked to the cylinder axis while loading
  if (!loader) return;
  if (loader.parent !== loaderRoot) loaderRoot.add(loader);
  loader.visible = plan.loader !== 'hidden';
  if (plan.loader === 'gun') {
    loader.position.copy(inCrane(axis.x, axis.y, -rev.cu0 + 0.0013 + plan.loaderD));
    loader.quaternion.copy(craneQ);
    // a small twist of the knob releases the rounds
    const tw = Math.min(1, Math.max(0, (plan.t - 0.68) / 0.04));
    loader.quaternion.multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), 0.35 * tw));
  } else if (plan.loader === 'palm') {
    // knob in the palm, rounds pointing along the fingers
    const palm = palmOf(out.p, out.q);
    loader.quaternion.copy(out.q);
    loader.position.copy(palm).add(new THREE.Vector3(0, 0, -0.03).applyQuaternion(out.q));
  }
}
