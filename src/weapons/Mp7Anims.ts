import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { clamp, smoothstep } from '../core/math';
import { AnimCtx, Pose, kf, kv, samplePose, mul, inv, place, handOn, once } from './SmgAnims';

/**
 * MP7 PDW handling (rebuilt). Everything is keyed in weapon space and the support hand is always
 * attached to something it holds or touches (a magazine, the receiver, the T-handle).
 *
 * The magazine lives in the pistol grip, so the firing hand never lets go: the gun is tipped
 * muzzle-up and rolled so the base of the grip swings toward the support hand.
 *
 * Tactical — two mags in one hand: the fresh mag comes up off the rig and is held alongside the
 *   one in the gun; the thumb presses the paddle and the hand strips the old mag down out of the
 *   grip, shifts across a mag's width, drives the fresh one up into the grip and seats it with the
 *   heel of the hand, then carries the old one away down out of view.
 * Empty — paddle, the empty drops free; fresh mag in with a palm push; the gun levels, the hand
 *   goes over the top to the T charging handle at the rear, hooks both tabs, rips it back and lets
 *   it fly home (the bolt runs forward off the hold-open).
 * Inspect — the gun comes up and rolls over to show its left side while the fingers run along the
 *   receiver to the rear sight; then it rolls back the other way, the support hand comes over the
 *   top and holds it while you look at the right side and down the top; back to the ready.
 */
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const lerpPose = (a: Pose, b: Pose, u: number): Pose => ({ p: a.p.clone().lerp(b.p, u), q: a.q.clone().slerp(b.q, u) });

/** support hand holding a magazine (mag space): palm on its left flat, fingers round the front */
const MAG_GRIP: Pose = { p: V(-0.0125, -0.122, 0.006), q: handFrame(V(0.2, -0.35, -1), V(1, 0, 0)) };
/** pinching the protruding base of the mag still in the grip (mag space) */
const MAG_BASE: Pose = { p: V(-0.0125, -0.14, 0.012), q: handFrame(V(0.25, -0.5, -1), V(1, 0.15, 0)) };
/** the T-handle stem in weapon space (at rest) */
const KNOB = V(0, 0.0515, 0.176);

// ================================================================== reloads
export function mp7Reload(t: number, empty: boolean, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  if (empty) return mp7Empty(t, pos, rot, c);
  const { parts } = c;
  const home: Pose = { p: c.magHome.clone(), q: new THREE.Quaternion() };
  // ---- the gun: tipped muzzle-up and rolled right so the grip base comes across to the hand
  rot.x += kf(t, [[0, 0], [0.16, 0.22], [0.36, 0.2], [0.5, 0.26], [0.6, 0.3], [0.64, 0.2], [0.8, 0.08], [1, 0]]);
  rot.z += kf(t, [[0, 0], [0.16, 0.62], [0.46, 0.68], [0.6, 0.6], [0.64, 0.52], [0.82, 0.14], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.16, 0.3], [0.64, 0.28], [1, 0]]);
  // brought up and in toward the centre so the grip base and both hands are in view
  pos.add(kv(t, [[0, [0, 0, 0]], [0.16, [-0.05, 0.15, -0.13]], [0.46, [-0.055, 0.155, -0.135]], [0.6, [-0.05, 0.15, -0.135]], [0.64, [-0.045, 0.14, -0.13]], [0.84, [-0.015, 0.03, -0.03]], [1, [0, 0, 0]]]));
  // ---- G: the hand group = the NEW mag's pose (the hand is rigidly attached to it). It starts a
  // mag's width to the left of the well (held alongside the old one), strips down, shifts across,
  // drives up.
  const ALONG = 0.024;
  const G = samplePose(t, [
    { t: 0.0, p: [-0.2, -0.36, 0.06], e: [0.5, 0.1, 0.4] },
    { t: 0.1, p: [-0.2, -0.36, 0.06], e: [0.5, 0.1, 0.4] },
    { t: 0.24, p: [-0.06, -0.12, 0.02], e: [0.12, 0, 0.06] },
    { t: 0.3, p: [-ALONG, -0.012, 0.0], e: [0, 0, 0] },
    { t: 0.335, p: [-ALONG, -0.008, 0.0], e: [0, 0, 0] },
    // strip the old one out of the grip
    { t: 0.45, p: [-ALONG, -0.19, 0.004], e: [0.05, 0, 0] },
    // shift across: the fresh mag now sits under the well
    { t: 0.52, p: [0.0, -0.19, 0.004], e: [0.02, 0, 0] },
    { t: 0.58, p: [0.0, -0.06, 0.002], e: [0, 0, 0] },
    { t: 0.615, p: [0.0, -0.006, 0.0], e: [0, 0, 0] },
    // the fresh mag stays; the hand (with the old mag) goes away down the same group
    { t: 0.68, p: [-0.03, -0.1, 0.03], e: [0.2, 0.1, -0.15] },
    { t: 0.84, p: [-0.2, -0.38, 0.06], e: [0.6, 0.2, -0.5] },
    { t: 1.0, p: [-0.24, -0.44, 0.07], e: [0.6, 0.2, -0.5] },
  ]);
  const seated = t >= 0.615;
  const newMag = seated ? home : G;
  // the old mag is caught as the fingers close on it, then rides the hand
  if (t >= 0.335 && !c.mem.old) c.mem.old = mul(inv(G), home);
  const oldMag = c.mem.old ? mul(G, c.mem.old) : home;
  if (t > 0.31 && t < 0.335) oldMag.p.y -= 0.0015; // the paddle pressed: a hair of play
  place(parts.mag, oldMag);
  place(parts.mag2, newMag);
  if (parts.mag) parts.mag.visible = t < 0.9;
  if (parts.mag2) parts.mag2.visible = t > 0.09;
  // ---- the hand rides the group (palm heel pushes on the seat)
  const grip = mul(G, MAG_GRIP);
  const heel = kf(t, [[0.6, 0], [0.62, 1], [0.66, 0]]);
  grip.p.y += 0.004 * heel;
  const blend = kf(t, [[0, 0], [0.1, 1], [0.88, 1], [1, 0]]);
  handOn(c, grip, blend, t > 0.28 && t < 0.62 ? POSES.grip : POSES.hold, 0.004);
  once(c, 'a', t, 0.02, () => c.ev('cloth'));
  once(c, 'b', t, 0.29, () => c.ev('magTouch'));
  once(c, 'c', t, 0.34, () => { c.ev('magOut'); c.jolt(0.35, 0.25); });
  once(c, 'd', t, 0.57, () => c.ev('magTouch'));
  once(c, 'e', t, 0.612, () => { c.ev('magIn'); c.ev('camSeat'); c.jolt(0.9, -0.7, -0.25); });
  once(c, 'f', t, 0.72, () => c.ev('cloth'));
  once(c, 'g', t, 0.96, () => c.ev('rattle'));
}

function mp7Empty(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  const { parts } = c;
  const home: Pose = { p: c.magHome.clone(), q: new THREE.Quaternion() };
  // ---- the gun: tipped for the mag change, then levelled and turned in for the charging handle
  // for the T-handle the muzzle goes up and to the right and the rear comes round to the left,
  // to the support hand
  rot.x += kf(t, [[0, 0], [0.12, 0.2], [0.5, 0.26], [0.56, 0.3], [0.6, 0.32], [0.68, 0.42], [0.8, 0.4], [0.83, 0.48], [0.88, 0.3], [1, 0]]);
  rot.z += kf(t, [[0, 0], [0.12, 0.6], [0.52, 0.66], [0.58, 0.56], [0.68, -0.3], [0.8, -0.32], [0.9, -0.1], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.12, 0.28], [0.56, 0.28], [0.68, -0.55], [0.8, -0.58], [0.9, -0.15], [1, 0]]);
  pos.add(kv(t, [[0, [0, 0, 0]], [0.12, [-0.05, 0.145, -0.125]], [0.56, [-0.055, 0.152, -0.13]], [0.68, [-0.03, 0.12, -0.25]], [0.8, [-0.03, 0.12, -0.25]], [0.9, [-0.01, 0.03, -0.06]], [1, [0, 0, 0]]]));
  // ---- the empty: paddle, it drops free (tumbling out of view)
  const fall = clamp((t - 0.15) / 0.13, 0, 1);
  if (parts.mag) {
    parts.mag.position.copy(c.magHome).add(V(-0.015 * fall, -0.38 * fall * fall - 0.004 * Math.min(1, fall * 8), 0.04 * fall));
    parts.mag.rotation.set(0.6 * fall, 0, -0.3 * fall);
    parts.mag.visible = fall < 1;
  }
  once(c, 'm1', t, 0.13, () => c.ev('magTouch'));
  once(c, 'm2', t, 0.15, () => { c.ev('magOut'); c.ev('magDrop'); c.jolt(0.3, 0.3); });
  // ---- the fresh mag off the rig, up under the grip, driven home
  const M = samplePose(t, [
    { t: 0.2, p: [-0.2, -0.36, 0.06], e: [0.5, 0.1, 0.4] },
    { t: 0.36, p: [-0.04, -0.16, 0.02], e: [0.1, 0, 0.08] },
    { t: 0.44, p: [0.0, -0.075, 0.004], e: [0.02, 0, 0] },
    { t: 0.5, p: [0.0, -0.03, 0.001], e: [0, 0, 0] },
    { t: 0.535, p: [0.0, -0.006, 0.0], e: [0, 0, 0] },
  ]);
  const seated = t >= 0.535;
  if (parts.mag2) {
    place(parts.mag2, seated ? home : M);
    parts.mag2.visible = t > 0.22;
  }
  once(c, 'n1', t, 0.47, () => c.ev('magTouch'));
  once(c, 'n2', t, 0.533, () => { c.ev('magIn'); c.ev('camSeat'); c.jolt(0.95, -0.7, -0.25); });
  // ---- T charging handle: hooked at the rear, ripped back, released — it flies home
  const back = kf(t, [[0, 0], [0.71, 0], [0.76, 1], [0.79, 1], [0.805, 0]]);
  const ch = parts.charge;
  if (ch) ch.position.set(c.chargeHome.x, c.chargeHome.y, c.chargeHome.z + 0.062 * back);
  once(c, 'k1', t, 0.755, () => { c.ev('boltBack'); c.jolt(0.35, 0.3, 0.4); });
  once(c, 'k2', t, 0.8, () => { c.ev('chargeFwd'); c.ev('camSlap'); c.jolt(1.4, -0.9, -0.5); });
  const knob = KNOB.clone().add(V(0, 0, 0.062 * back));
  // ---- support hand: mag base (paddle) → rig / fresh mag → up over the top to the T-handle → back
  const onBase: Pose = mul(home, MAG_BASE);
  const onNew: Pose = mul(seated ? home : M, MAG_GRIP);
  // over the top, index and middle finger either side of the stem, curled down in front of the bar
  const hook: Pose = { p: knob.clone().add(V(-0.004, 0.022, -0.012)), q: handFrame(V(0.05, -0.75, 0.6), V(0.1, -0.55, -0.85)) };
  const reach: Pose = { p: hook.p.clone().add(V(-0.03, 0.05, -0.06)), q: hook.q.clone() };
  // after the release the open hand flies up off the handle
  const off: Pose = { p: hook.p.clone().add(V(-0.07, -0.07, -0.02)), q: handFrame(V(0.2, -0.3, -0.9), V(0.2, -0.9, 0.3)) };
  let target: Pose, pose: FingerPose = POSES.hold, r = 0.004;
  if (t < 0.17) {
    target = onBase;
    pose = t > 0.1 ? POSES.grip : POSES.hold;
  } else if (t < 0.56) target = t < 0.24 ? lerpPose(onBase, onNew, smoothstep(0.17, 0.24, t)) : onNew, (pose = POSES.grip);
  else if (t < 0.7) {
    target = lerpPose(onNew, reach, smoothstep(0.56, 0.66, t));
    if (t > 0.66) target = lerpPose(reach, hook, smoothstep(0.66, 0.7, t));
    pose = POSES.open;
  } else if (t < 0.8) {
    target = hook;
    pose = POSES.grip;
    r = 0.006;
  } else {
    target = lerpPose(hook, off, smoothstep(0.8, 0.86, t));
    pose = POSES.open;
  }
  const blend = kf(t, [[0, 0], [0.08, 1], [0.88, 1], [1, 0]]);
  handOn(c, target, blend, pose, r);
  once(c, 'z0', t, 0.02, () => c.ev('cloth'));
  once(c, 'z1', t, 0.22, () => c.ev('cloth'));
  once(c, 'z2', t, 0.62, () => c.ev('cloth'));
  once(c, 'z3', t, 0.95, () => c.ev('rattle'));
}

// ================================================================== inspect
export function mp7Inspect(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: AnimCtx) {
  // ---- the gun: up and rolled over to the left side → back across to the right side, held from
  // the top → a look down the top → back to the ready
  rot.x += kf(t, [[0, 0], [0.14, 0.12], [0.38, 0.16], [0.5, 0.14], [0.56, 0.12], [0.72, 0.14], [0.8, 0.42], [0.88, 0.4], [1, 0]]);
  rot.y += kf(t, [[0, 0], [0.14, 0.85], [0.38, 0.9], [0.56, -0.62], [0.72, -0.66], [0.8, 0.1], [0.88, 0.08], [1, 0]]);
  rot.z += kf(t, [[0, 0], [0.14, -0.45], [0.38, -0.5], [0.56, 0.42], [0.72, 0.46], [0.8, -0.1], [0.88, -0.1], [1, 0]]);
  pos.add(kv(t, [[0, [0, 0, 0]], [0.14, [-0.055, 0.06, -0.07]], [0.38, [-0.06, 0.065, -0.075]], [0.56, [-0.045, 0.085, -0.12]], [0.72, [-0.045, 0.088, -0.12]], [0.8, [-0.02, 0.03, -0.1]], [0.88, [-0.02, 0.03, -0.09]], [1, [0, 0, 0]]]));
  // a slow breath while it is being looked at
  pos.y += Math.sin(t * Math.PI * 6) * 0.0012;
  // ---- support hand: fingertips along the left side of the receiver, nose → rear sight; then over
  // the top, palm on the rail, fingers down the right side
  // palm up under the nose, fingers splayed round the far side; it slides back under the receiver
  const side0: Pose = { p: V(0.002, -0.018, -0.115), q: handFrame(V(1, 0.2, -0.25), V(0.05, 1, 0)) };
  const side1: Pose = { p: V(0.002, -0.016, -0.07), q: handFrame(V(1, 0.25, -0.1), V(0.05, 1, 0)) };
  // second side: the hand stays under it, now cradling the receiver just ahead of the grip
  const top: Pose = { p: V(0.002, -0.014, -0.045), q: handFrame(V(1, 0.3, 0.05), V(0.05, 1, 0)) };
  const rest: Pose = { p: V(-0.04, -0.06, -0.12), q: handFrame(V(0.2, 0.2, -1), V(0.9, 0.3, 0)) };
  let target: Pose, pose: FingerPose = POSES.open;
  if (t < 0.18) target = lerpPose(rest, side0, smoothstep(0.04, 0.18, t));
  else if (t < 0.4) {
    target = lerpPose(side0, side1, smoothstep(0.2, 0.38, t));
    pose = POSES.hold;
  } else if (t < 0.58) {
    target = lerpPose(side1, top, smoothstep(0.44, 0.56, t));
    pose = POSES.hold;
  } else if (t < 0.82) {
    target = top;
    pose = POSES.hold;
  } else target = lerpPose(top, rest, smoothstep(0.82, 0.95, t));
  const blend = kf(t, [[0, 0], [0.06, 1], [0.92, 1], [1, 0]]);
  handOn(c, target, blend, pose, 0.006);
  once(c, 'a', t, 0.03, () => c.ev('cloth'));
  once(c, 'b', t, 0.3, () => c.ev('magTouch'));
  once(c, 'c', t, 0.5, () => c.ev('cloth'));
  once(c, 'd', t, 0.57, () => c.ev('rattle'));
  once(c, 'e', t, 0.9, () => c.ev('cloth'));
}
