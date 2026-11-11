import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { SD9 } from './WeaponModels';
import { clamp, smoothstep, easeInOutCubic, easeOutBack } from '../core/math';

/**
 * Authored reloads for the Stille-9 (MP5SD pattern) and the MP-18 machine pistol.
 * Everything is in weapon space; the support hand is always attached to something it holds or
 * touches (a magazine, the cocking handle, the slide), so hands and parts never drift apart.
 *
 * Stille-9 tactical — the MW-style mag swap with two magazines in one hand:
 *   fetch the fresh mag and carry it sideways under the gun (lips to the left, palm under it) →
 *   come up under the old mag and clamp its base against the new one → thumb the paddle and pull
 *   the old mag out → roll the hand a quarter turn so the new mag stands upright → hook the front
 *   lip and rock it home → take the old mag away and down out of view.
 * Stille-9 empty — the HK slap:
 *   cocking handle back and up into its notch → paddle, the empty falls free → fresh mag in →
 *   palm slaps the handle out of the notch and it slams forward.
 *
 * MP-18 tactical — cant and strip: the gun cants over toward the support hand, the hand pinches
 *   the extended base pad and strips the stick out, pockets it, brings the fresh one up by its
 *   base, starts it and heels it home; the gun snaps back upright.
 * MP-18 empty — flick and rack: a hard wrist flick throws the empty mag clear while the support
 *   hand is already at the belt; fresh mag in, then the hand comes over the top, grabs the rear
 *   of the locked slide and slingshots it.
 */
export type V3 = [number, number, number];
export type Pose = { p: THREE.Vector3; q: THREE.Quaternion };
interface PKey { t: number; p: V3; e: V3 }

export const Q = (e: V3) => new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));
export function samplePose(t: number, keys: PKey[]): Pose {
  if (t <= keys[0].t) return { p: new THREE.Vector3(...keys[0].p), q: Q(keys[0].e) };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const A = keys[i - 1], B = keys[i];
      const u = smoothstep(0, 1, (t - A.t) / Math.max(1e-6, B.t - A.t));
      return { p: new THREE.Vector3(...A.p).lerp(new THREE.Vector3(...B.p), u), q: Q(A.e).slerp(Q(B.e), u) };
    }
  }
  const L = keys[keys.length - 1];
  return { p: new THREE.Vector3(...L.p), q: Q(L.e) };
}
export function kf(t: number, keys: [number, number][]) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      return a + (b - a) * easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}
export function kv(t: number, keys: [number, V3][], out = new THREE.Vector3()) {
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
export const mul = (a: Pose, b: Pose): Pose => ({ p: b.p.clone().applyQuaternion(a.q).add(a.p), q: a.q.clone().multiply(b.q) });
export const inv = (a: Pose): Pose => {
  const qi = a.q.clone().invert();
  return { p: a.p.clone().negate().applyQuaternion(qi), q: qi };
};
export const place = (o: THREE.Object3D | undefined, ps: Pose) => {
  if (!o) return;
  o.position.copy(ps.p);
  o.quaternion.copy(ps.q);
};

export interface AnimHands {
  leftTarget: THREE.Vector3;
  leftQ: THREE.Quaternion;
  setLeft: (b: number, p: FingerPose) => void;
}
export interface AnimCtx {
  parts: Record<string, THREE.Object3D | undefined>;
  h: AnimHands;
  magHome: THREE.Vector3;
  chargeHome: THREE.Vector3;
  slideHome: THREE.Vector3;
  wristFor: (anchor: THREE.Vector3, q: THREE.Quaternion, r: number) => THREE.Vector3;
  ev: (name: string) => void;
  fired: Set<string>;
  jolt: (u: number, r: number, b?: number) => void;
  /** per-reload scratch (captured transforms) */
  mem: Record<string, Pose>;
}
export const once = (c: AnimCtx, key: string, t: number, at: number, f: () => void) => {
  if (t >= at && !c.fired.has(key)) {
    c.fired.add(key);
    f();
  }
};

/** Hand that holds a magazine by its left face (mag space): palm on the flat, fingers round the front. */
const MAG_GRIP: Pose = (() => {
  const q = handFrame(new THREE.Vector3(0.15, -0.45, -1), new THREE.Vector3(1, 0, 0));
  return { p: new THREE.Vector3(-0.0118, -0.085, -0.01), q };
})();
/** put the support hand on a held pose (anchor + orientation in weapon space) */
export function handOn(c: AnimCtx, grip: Pose, blend: number, pose: FingerPose, r = 0.004) {
  c.h.leftQ.copy(grip.q);
  c.h.leftTarget.copy(c.wristFor(grip.p, grip.q, r));
  c.h.setLeft(blend, pose);
}

// ================================================================== Stille-9
export function sd9Reload(t: number, empty: boolean, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  if (empty) return sd9Empty(t, pos, rot, c);
  const { parts } = c;
  const home: Pose = { p: c.magHome.clone(), q: new THREE.Quaternion() };
  // ---- the gun: rolled to its right so the well and the left side face the hand, muzzle up a touch
  rot.z += kf(t, [[0, 0], [0.18, -0.6], [0.5, -0.66], [0.66, -0.56], [0.7, -0.5], [0.86, -0.2], [1, 0]]);
  rot.x += kf(t, [[0, 0], [0.18, 0.22], [0.45, 0.18], [0.67, 0.26], [0.7, 0.16], [0.86, 0.06], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.18, 0.2], [0.7, 0.18], [1, 0]]);
  pos.add(kv(t, [[0, [0, 0, 0]], [0.18, [-0.065, 0.07, -0.03]], [0.6, [-0.062, 0.074, -0.03]], [0.7, [-0.055, 0.062, -0.028]], [0.86, [-0.02, 0.02, -0.01]], [1, [0, 0, 0]]]));
  // ---- G: the hand group = the NEW mag's pose (the hand is rigidly attached to it)
  const SIDE: V3 = [0, 0, Math.PI / 2];
  const G = samplePose(t, [
    { t: 0.0, p: [-0.22, -0.34, 0.05], e: [0.4, 0, Math.PI / 2] },
    { t: 0.1, p: [-0.22, -0.34, 0.05], e: [0.4, 0, Math.PI / 2] },
    { t: 0.24, p: [-0.13, -0.27, -0.07], e: SIDE },
    { t: 0.32, p: [-0.088, -0.254, -0.092], e: SIDE },
    { t: 0.37, p: [-0.088, -0.25, -0.092], e: SIDE },
    { t: 0.47, p: [-0.1, -0.37, -0.085], e: [0.1, 0, Math.PI / 2] },
    { t: 0.57, p: [-0.02, -0.15, -0.074], e: [-0.3, 0, 0.05] },
    { t: 0.62, p: [0, -0.072, -0.074], e: [-0.22, 0, 0] },
    { t: 0.66, p: [0, -0.042, -0.071], e: [-0.05, 0, 0] },
    { t: 0.69, p: [0, -0.032, -0.07], e: [0, 0, 0] },
    // the new mag stays in the gun from here; the hand (with the old mag) leaves on the same group
    { t: 0.74, p: [-0.03, -0.1, -0.06], e: [0.15, 0.1, -0.2] },
    { t: 0.86, p: [-0.2, -0.36, 0.04], e: [0.5, 0.2, -0.6] },
    { t: 1.0, p: [-0.24, -0.42, 0.05], e: [0.5, 0.2, -0.6] },
  ]);
  const newMag = t < 0.69 ? G : home;
  // capture the old mag into the hand when the fingers close on it
  if (t >= 0.345 && !c.mem.old) c.mem.old = mul(inv(G), home);
  const oldMag = c.mem.old ? mul(G, c.mem.old) : home;
  if (t < 0.345 && t > 0.33) oldMag.p.y -= 0.001; // the paddle being pressed: a hair of play
  place(parts.mag, oldMag);
  place(parts.mag2, newMag);
  if (parts.mag) parts.mag.visible = t < 0.9;
  if (parts.mag2) parts.mag2.visible = t > 0.09;
  // the hand rides the group; it keeps hold of the old mag after the new one seats
  const grip = mul(G, MAG_GRIP);
  const blend = kf(t, [[0, 0], [0.1, 1], [0.9, 1], [1, 0]]);
  handOn(c, grip, blend, t > 0.3 && t < 0.69 ? POSES.grip : POSES.hold, 0.004);
  once(c, 'a', t, 0.02, () => c.ev('cloth'));
  once(c, 'b', t, 0.3, () => c.ev('magTouch'));
  once(c, 'c', t, 0.38, () => { c.ev('magOut'); c.jolt(0.3, 0.25); });
  once(c, 'd', t, 0.6, () => c.ev('magTouch'));
  once(c, 'e', t, 0.685, () => { c.ev('magIn'); c.ev('camSeat'); c.jolt(0.85, -0.7, -0.25); });
  once(c, 'f', t, 0.8, () => c.ev('cloth'));
  once(c, 'g', t, 0.97, () => c.ev('rattle'));
}

function sd9Empty(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  const { parts } = c;
  const home: Pose = { p: c.magHome.clone(), q: new THREE.Quaternion() };
  // ---- gun
  rot.z += kf(t, [[0, 0], [0.1, -0.3], [0.24, -0.34], [0.32, -0.62], [0.6, -0.58], [0.68, -0.3], [0.76, -0.32], [0.8, -0.12], [1, 0]]);
  rot.x += kf(t, [[0, 0], [0.1, 0.12], [0.2, 0.16], [0.32, 0.22], [0.6, 0.24], [0.74, 0.14], [0.775, 0.0], [0.82, 0.05], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.1, 0.16], [0.62, 0.18], [0.8, 0.05], [1, 0]]);
  pos.add(kv(t, [[0, [0, 0, 0]], [0.1, [-0.04, 0.035, -0.02]], [0.28, [-0.045, 0.045, -0.025]], [0.34, [-0.065, 0.07, -0.03]], [0.6, [-0.062, 0.072, -0.03]], [0.68, [-0.04, 0.045, -0.025]], [0.74, [-0.04, 0.045, -0.025]], [0.78, [-0.03, 0.025, -0.015]], [1, [0, 0, 0]]]));
  // ---- cocking handle: back, up into the notch; slapped out and slammed home
  const back = kf(t, [[0, 0], [0.11, 0], [0.17, 1], [0.765, 1], [0.79, 0]]);
  const up = kf(t, [[0, 0], [0.17, 0], [0.22, 1], [0.765, 1], [0.775, 0]]);
  const ch = parts.charge;
  if (ch) {
    ch.position.set(c.chargeHome.x, c.chargeHome.y, c.chargeHome.z + 0.06 * back);
    ch.rotation.z = -0.55 * up;
  }
  once(c, 'k1', t, 0.165, () => { c.ev('boltBack'); c.jolt(0.3, 0.25, 0.35); });
  once(c, 'k2', t, 0.22, () => c.ev('fireMode'));
  once(c, 'k3', t, 0.77, () => { c.ev('boltRelease'); c.ev('camSlap'); c.jolt(1.6, -1.1, -0.6); });
  // the knob in weapon space (follows the handle)
  const knob = new THREE.Vector3(-0.036, 0, -SD9.handleU + 0.005).applyAxisAngle(new THREE.Vector3(0, 0, 1), -0.55 * up).add(new THREE.Vector3(0, SD9.tubeV, 0.06 * back));
  // ---- old mag: paddle, falls free (tumbling out of view)
  const fall = clamp((t - 0.3) / 0.12, 0, 1);
  if (parts.mag) {
    parts.mag.position.copy(c.magHome).add(new THREE.Vector3(-0.02 * fall, -0.36 * fall * fall - 0.004 * Math.min(1, fall * 8), 0.03 * fall));
    parts.mag.rotation.set(0.5 * fall, 0, -0.3 * fall);
    parts.mag.visible = fall < 1;
  }
  once(c, 'm1', t, 0.29, () => c.ev('magTouch'));
  once(c, 'm2', t, 0.305, () => { c.ev('magOut'); c.ev('magDrop'); c.jolt(0.3, 0.3); });
  // ---- fresh mag (mag2) from the pouch, hooked, rocked in
  const M = samplePose(t, [
    { t: 0.34, p: [-0.22, -0.34, 0.05], e: [0.5, 0.2, 0.3] },
    { t: 0.48, p: [-0.06, -0.17, -0.06], e: [-0.35, 0.05, 0.12] },
    { t: 0.55, p: [0, -0.074, -0.074], e: [-0.24, 0, 0] },
    { t: 0.59, p: [0, -0.042, -0.071], e: [-0.06, 0, 0] },
    { t: 0.62, p: [0, -0.032, -0.07], e: [0, 0, 0] },
  ]);
  if (parts.mag2) {
    place(parts.mag2, t < 0.62 ? M : home);
    parts.mag2.visible = t > 0.36;
  }
  once(c, 'n1', t, 0.53, () => c.ev('magTouch'));
  once(c, 'n2', t, 0.615, () => { c.ev('magIn'); c.ev('camSeat'); c.jolt(0.9, -0.7, -0.25); });
  // ---- support hand: handle → mag paddle → pouch / fresh mag → up over the handle → slap
  const onKnob: Pose = { p: knob.clone().add(new THREE.Vector3(-0.004, 0.006, -0.004)), q: handFrame(new THREE.Vector3(0.55, -0.55, -0.4), new THREE.Vector3(0.45, -0.25, -1)) };
  const onOld: Pose = mul({ p: parts.mag?.position.clone() ?? c.magHome.clone(), q: parts.mag?.quaternion.clone() ?? new THREE.Quaternion() }, MAG_GRIP);
  const onNew: Pose = mul(t < 0.62 ? M : home, MAG_GRIP);
  // open palm hovering over the notched handle, then driving down through it
  const slapK = kf(t, [[0.66, 0], [0.74, 0], [0.77, 1], [0.84, 1.5]]);
  const slapPose: Pose = {
    p: knob.clone().add(new THREE.Vector3(-0.012, 0.032 - 0.04 * slapK, 0.012 - 0.03 * slapK)),
    q: handFrame(new THREE.Vector3(0.25, -0.2, -1), new THREE.Vector3(0.3, -1, 0.15)),
  };
  let target: Pose, pose: FingerPose = POSES.hold, r = 0.004;
  const lerpPose = (a: Pose, b: Pose, u: number): Pose => ({ p: a.p.clone().lerp(b.p, u), q: a.q.clone().slerp(b.q, u) });
  if (t < 0.24) {
    target = onKnob;
    pose = t > 0.1 ? POSES.grip : POSES.hold;
    r = 0.007;
  } else if (t < 0.34) target = lerpPose(onKnob, onOld, smoothstep(0.24, 0.29, t));
  else if (t < 0.64) {
    target = t < 0.38 ? lerpPose(onOld, onNew, smoothstep(0.34, 0.38, t)) : onNew;
    pose = POSES.grip;
  } else {
    target = lerpPose(onNew, slapPose, smoothstep(0.62, 0.72, t));
    pose = POSES.open;
  }
  const blend = kf(t, [[0, 0], [0.09, 1], [0.86, 1], [1, 0]]);
  handOn(c, target, blend, pose, r);
  once(c, 'z0', t, 0.02, () => c.ev('cloth'));
  once(c, 'z1', t, 0.4, () => c.ev('cloth'));
}

// ================================================================== MP-18
const PISTOL_MAG_GRIP: Pose = (() => {
  // pinching the extended base pad: palm under/behind it, fingers round the front
  const q = handFrame(new THREE.Vector3(0.1, 0.35, -1), new THREE.Vector3(0.6, 0.8, 0.0));
  return { p: new THREE.Vector3(-0.012, -0.178, -0.036), q };
})();

export function mp18Reload(t: number, empty: boolean, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  const { parts } = c;
  const home: Pose = { p: c.magHome.clone(), q: new THREE.Quaternion() };
  // magazine axis follows the grip rake: "down the well" in weapon space
  const rake = new THREE.Vector3(0, -Math.cos(0.36), Math.sin(0.36));
  const lerpPose = (a: Pose, b: Pose, u: number): Pose => ({ p: a.p.clone().lerp(b.p, u), q: a.q.clone().slerp(b.q, u) });
  if (!empty) {
    // ---- gun: canted over toward the support hand, then snapped back upright
    rot.z += kf(t, [[0, 0], [0.1, 0.5], [0.58, 0.48], [0.64, 0.36], [0.72, -0.06], [0.8, 0.02], [1, 0]]);
    rot.x += kf(t, [[0, 0], [0.1, 0.16], [0.6, 0.14], [0.66, 0.2], [0.74, 0.0], [1, 0]]);
    rot.y += kf(t, [[0, 0], [0.1, -0.12], [0.62, -0.1], [0.74, 0], [1, 0]]);
    pos.add(kv(t, [[0, [0, 0, 0]], [0.1, [-0.04, 0.055, -0.03]], [0.62, [-0.04, 0.06, -0.032]], [0.74, [-0.006, 0.01, -0.004]], [1, [0, 0, 0]]]));
    // old stick: stripped out along the rake, then pocketed with the hand
    const strip = clamp((t - 0.2) / 0.1, 0, 1);
    const oldOut: Pose = { p: c.magHome.clone().addScaledVector(rake, 0.15 * easeInOutCubic(strip)), q: new THREE.Quaternion() };
    const pocket: Pose = { p: new THREE.Vector3(-0.2, -0.38, 0.08), q: Q([0.6, 0.3, 0.8]) };
    const oldMag = t < 0.3 ? oldOut : lerpPose(oldOut, pocket, smoothstep(0.3, 0.42, t));
    // fresh stick: up from the pocket by its base pad, started into the well, heeled home
    const start: Pose = { p: c.magHome.clone().addScaledVector(rake, 0.05), q: Q([0.05, 0, 0]) };
    const newMag = t < 0.44 ? pocket : t < 0.56 ? lerpPose(pocket, start, smoothstep(0.44, 0.56, t)) : lerpPose(start, home, easeOutBack(clamp((t - 0.58) / 0.05, 0, 1)));
    if (parts.mag) {
      // parts.mag plays the old stick until it is pocketed, then the fresh one
      place(parts.mag, t < 0.42 ? oldMag : newMag);
      parts.mag.visible = t < 0.41 || t > 0.45;
    }
    const held = t < 0.42 ? oldMag : newMag;
    const grip = mul(held, PISTOL_MAG_GRIP);
    // the heel strike: the palm pushes up through the base
    if (t > 0.58 && t < 0.66) grip.p.addScaledVector(rake, -0.006 * Math.sin(((t - 0.58) / 0.08) * Math.PI));
    handOn(c, grip, kf(t, [[0, 0], [0.12, 1], [0.7, 1], [0.86, 0]]), t > 0.6 ? POSES.open : POSES.pinch, 0.004);
    once(c, 'a', t, 0.02, () => c.ev('cloth'));
    once(c, 'b', t, 0.17, () => c.ev('magTouch'));
    once(c, 'c', t, 0.21, () => { c.ev('magOut'); c.jolt(0.2, 0.2); });
    once(c, 'd', t, 0.36, () => c.ev('cloth'));
    once(c, 'e', t, 0.55, () => c.ev('magTouch'));
    once(c, 'f', t, 0.625, () => { c.ev('magIn'); c.ev('camTap'); c.jolt(1.0, 0.5, -0.2); });
    once(c, 'g', t, 0.72, () => c.ev('rattle'));
    return;
  }
  // ================= empty: flick, fresh stick, overhand rack
  rot.z += kf(t, [[0, 0], [0.06, -0.55], [0.14, -0.2], [0.24, 0.4], [0.5, 0.38], [0.58, 0.42], [0.66, 0.5], [0.76, 0.46], [0.84, 0.1], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.06, -0.3], [0.14, -0.05], [0.24, -0.1], [0.56, -0.1], [0.66, 0.15], [0.76, 0.12], [1, 0]]);
  rot.x += kf(t, [[0, 0], [0.06, 0.05], [0.24, 0.15], [0.54, 0.16], [0.6, 0.22], [0.68, 0.1], [0.75, 0.05], [0.79, -0.04], [1, 0]]);
  pos.add(kv(t, [[0, [0, 0, 0]], [0.06, [0.02, 0.01, 0]], [0.24, [-0.04, 0.05, -0.03]], [0.56, [-0.038, 0.055, -0.03]], [0.66, [0.02, 0.03, -0.1]], [0.76, [0.02, 0.028, -0.1]], [0.84, [0.0, 0.01, -0.03]], [1, [0, 0, 0]]]));
  // slide: locked back until the rack, pulled a little further, then slams home
  const slide = parts.slide;
  const rack = kf(t, [[0, 1], [0.7, 1], [0.735, 1.25], [0.745, 1.25], [0.765, 0]]);
  if (slide) slide.position.set(c.slideHome.x, c.slideHome.y, c.slideHome.z + 0.026 * rack);
  // old stick: thrown clear by the flick, spinning out down-right
  const fly = clamp((t - 0.05) / 0.12, 0, 1);
  if (parts.mag && t < 0.3) {
    parts.mag.position.copy(c.magHome).addScaledVector(rake, 0.06 * Math.min(1, fly * 3)).add(new THREE.Vector3(0.14 * fly, -0.3 * fly * fly, 0.04 * fly));
    parts.mag.rotation.set(0.8 * fly, 0, -1.6 * fly);
    parts.mag.visible = fly < 1;
  }
  once(c, 'x0', t, 0.02, () => c.ev('cloth'));
  once(c, 'x1', t, 0.055, () => { c.ev('magOut'); c.ev('magDrop'); c.jolt(0.4, -0.6); });
  // fresh stick (parts.mag again once the old one is gone)
  const pocket: Pose = { p: new THREE.Vector3(-0.2, -0.38, 0.08), q: Q([0.6, 0.3, 0.8]) };
  const start: Pose = { p: c.magHome.clone().addScaledVector(rake, 0.05), q: Q([0.05, 0, 0]) };
  const newMag = t < 0.42 ? lerpPose(pocket, start, smoothstep(0.26, 0.42, t)) : lerpPose(start, home, easeOutBack(clamp((t - 0.44) / 0.05, 0, 1)));
  if (parts.mag && t >= 0.3) {
    place(parts.mag, newMag);
    parts.mag.visible = true;
  }
  once(c, 'y1', t, 0.41, () => c.ev('magTouch'));
  once(c, 'y2', t, 0.485, () => { c.ev('magIn'); c.ev('camTap'); c.jolt(1.0, 0.5, -0.2); });
  // support hand: belt → fresh stick → over the top onto the slide's rear serrations → rack → away
  const onMag = mul(t < 0.3 ? pocket : newMag, PISTOL_MAG_GRIP);
  const slideGrip = (k: number): Pose => ({
    p: new THREE.Vector3(-0.004, 0.058, 0.055 + 0.026 * k + (c.slideHome.z ?? 0)),
    q: handFrame(new THREE.Vector3(0.9, -0.35, 0.15), new THREE.Vector3(0.1, -1, 0.05)),
  });
  let target: Pose, pose: FingerPose = POSES.pinch;
  if (t < 0.52) target = onMag;
  else if (t < 0.765) {
    target = lerpPose(onMag, slideGrip(rack), smoothstep(0.52, 0.66, t));
    pose = t > 0.62 ? POSES.grip : POSES.open;
  } else {
    // let go: the hand springs off up and back, slingshot style
    const off = slideGrip(0);
    off.p.add(new THREE.Vector3(-0.07, 0.015, -0.02).multiplyScalar(smoothstep(0.765, 0.82, t)));
    target = off;
    pose = POSES.open;
  }
  const blend = kf(t, [[0, 0], [0.08, 1], [0.82, 1], [0.96, 0]]);
  handOn(c, target, blend, pose, t > 0.6 && t < 0.765 ? 0.006 : 0.004);
  once(c, 'r1', t, 0.715, () => { c.ev('slideBack'); c.jolt(0.2, 0.2, 0.3); });
  once(c, 'r2', t, 0.755, () => { c.ev('slideRelease'); c.jolt(1.3, 0.6, -0.4); });
}
