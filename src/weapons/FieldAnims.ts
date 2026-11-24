import * as THREE from 'three';
import { POSES } from './Arms';
import { handFrame } from './ReloadClips';
import { smoothstep, easeInOutCubic } from '../core/math';
import { EqCtx } from './EquipAnims';

/**
 * First-person field work (Update 47), in the EquipAnims style: positions in viewmodel space
 * (x right, y up, -z forward, metres from the eye), hand orientation from a finger direction and
 * the palm normal, items placed exactly by the animation.
 *
 *  plate     the gun dips and cants in the right hand; the left hand reaches down to the pouch on
 *            the left hip, brings a plate up into view (you see the cover, the stencil), tips it
 *            flat and drives it down into the carrier under your chin, then slaps it home
 *  revive    the gun swings away; you kneel (the view dips), the left palm presses the wound, the
 *            right brings the stim up, flicks the cap and jabs; while you hold, two-handed
 *            compressions; then back to the gun
 *  dragBody  the gun one-handed and low; the left fist hooked into the casualty's drag strap,
 *            pulling, the arm swaying with every backward step
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
type K3 = [number, [number, number, number]][];
function kv(t: number, keys: K3, out = new THREE.Vector3()) {
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
function kf(t: number, keys: [number, number][]) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      return a + (b - a) * easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}
function handTrack(t: number, f: K3, n: K3) {
  return handFrame(kv(t, f), kv(t, n));
}
const once = (c: EqCtx, key: string, t: number, at: number, f: () => void) => {
  const fired = (c.data.fired ??= new Set<string>()) as Set<string>;
  if (t >= at && !fired.has(key)) {
    fired.add(key);
    f();
  }
};
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));

/** the gun dropped out of the way (amount 0..1 from keys) */
function gunAway(t: number, pos: THREE.Vector3, rot: THREE.Vector3, keys: [number, number][], k = 1) {
  const a = kf(t, keys) * k;
  pos.y -= 0.38 * a;
  pos.x += 0.1 * a;
  pos.z += 0.05 * a;
  rot.x -= 1.0 * a;
  rot.z -= 0.45 * a;
  rot.y += 0.22 * a;
  return a;
}

// ============================================================================ plate
export function plateInsert(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  // the gun stays in the right hand, dipped and canted out of the way
  const g = kf(t, [[0, 0], [0.12, 1], [0.8, 1], [1, 0]]);
  pos.y -= 0.03 * g;
  pos.x += 0.018 * g;
  rot.z -= 0.1 * g;
  rot.x -= 0.05 * g;
  // the slap jolts the view
  const slap = kf(t, [[0, 0], [0.62, 0], [0.66, 1], [0.74, 0]]);
  pos.y -= 0.012 * slap;
  rot.x -= 0.02 * slap;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.1, 1], [0.84, 1], [1, 0]]);
  kv(t, [
    [0, [-0.17, -0.32, -0.3]], [0.16, [-0.25, -0.48, -0.2]], [0.22, [-0.25, -0.49, -0.2]],
    [0.36, [-0.17, -0.15, -0.45]], [0.46, [-0.155, -0.14, -0.46]],
    [0.58, [-0.08, -0.34, -0.34]], [0.62, [-0.07, -0.38, -0.31]],
    [0.66, [-0.06, -0.21, -0.36]], [0.7, [-0.06, -0.23, -0.35]], [1, [-0.17, -0.32, -0.3]],
  ], fl.p);
  // gripping the plate's left edge, palm towards it (right); fingers up the edge
  fl.q.copy(handTrack(t,
    [[0, [0.3, -0.2, -1]], [0.16, [0.1, -1, 0]], [0.36, [0.25, 0.9, -0.3]], [0.44, [0.3, 0.9, -0.3]], [0.58, [0.1, 0.2, -1]], [0.66, [0.1, -0.1, -1]], [1, [0.3, -0.2, -1]]],
    [[0, [1, 0.05, 0.25]], [0.16, [1, 0, 0]], [0.36, [1, 0, 0.15]], [0.58, [0.6, -0.8, 0]], [0.66, [0, -1, 0.1]], [1, [1, 0.05, 0.25]]]));
  fl.pose = t > 0.63 && t < 0.74 ? POSES.open : t > 0.14 && t < 0.63 ? POSES.hold : POSES.grip;
  c.noWrapL();
  // the plate rides on the hand: its left edge in the palm; it tips from upright (face to you,
  // turned a little to show the stencil) to flat as it goes down into the carrier
  const tip = smoothstep(0.44, 0.6, t);
  const q = euler(-0.15 - 1.25 * tip, 0.42 - 0.35 * tip, 0.08);
  const off = V(0.115, 0.02 - 0.02 * tip, -0.015).applyQuaternion(q);
  item.position.copy(fl.p).add(off);
  item.quaternion.copy(q);
  item.userData.posed = true;
  item.visible = t > 0.2 && t < 0.63;
  // the stencil side faces the eye; the crack overlay is for spent plates on the ground
  const cr = item.getObjectByName('cracks');
  if (cr) cr.visible = false;
  once(c, 'a', t, 0.02, () => c.ev('cloth'));
  once(c, 'o', t, 0.2, () => c.ev('plateOut'));
  once(c, 'i', t, 0.62, () => {
    c.ev('plateIn');
    c.jolt(0.4, 0.2, 0.15);
  });
  once(c, 'v', t, 0.7, () => c.ev('velcro'));
}

// ============================================================================ revive
export function reviveHands(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  gunAway(t, pos, rot, [[0, 0], [0.14, 1], [0.86, 1], [1, 0]]);
  // (the gun swings down out of frame)
  // kneeling: the whole view dips and leans in over them
  const kneel = kf(t, [[0, 0], [0.2, 1], [0.86, 1], [1, 0]]);
  pos.y += 0.03 * kneel;
  rot.x += 0.04 * kneel;
  const held = c.held;
  // compressions while the key is held (at the hold point)
  const pump = t >= 0.8 ? Math.max(0, Math.sin(held * 10)) : 0;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.14, 1], [0.86, 1], [1, 0]]);
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.2, [-0.075, -0.205, -0.44]], [0.8, [-0.07, -0.21, -0.44]], [1, [-0.17, -0.32, -0.3]]], fl.p);
  fl.p.y -= 0.035 * pump;
  // palm flat on the chest, fingers forward
  fl.q.copy(handFrame(V(0.1, -0.35, -1), V(0, -1, -0.1)));
  fl.pose = POSES.open;
  c.noWrapL();
  const fr = c.freeR;
  fr.b = kf(t, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]);
  kv(t, [
    [0, [0.14, -0.3, -0.2]], [0.22, [0.12, -0.22, -0.34]], [0.44, [0.1, -0.17, -0.36]], [0.5, [0.09, -0.14, -0.37]],
    [0.56, [0.035, -0.21, -0.46]], [0.62, [0.035, -0.205, -0.46]], [0.74, [0.05, -0.2, -0.44]], [0.8, [0.04, -0.215, -0.44]], [1, [0.14, -0.3, -0.2]],
  ], fr.p);
  fr.p.y -= 0.035 * pump;
  // fist round the injector, nose down for the jab; after the jab the palm joins the left on the chest
  fr.q.copy(handTrack(t,
    [[0, [-0.2, 0.3, -1]], [0.22, [-0.3, 0.1, -1]], [0.5, [-0.3, 0.25, -1]], [0.56, [-0.2, -0.3, -1]], [0.7, [-0.2, -0.3, -1]], [0.78, [-0.1, -0.35, -1]], [1, [-0.2, 0.3, -1]]],
    [[0, [-0.7, 0.4, -0.2]], [0.22, [-1, 0.05, 0.25]], [0.56, [-1, 0.05, 0.2]], [0.7, [-1, 0.05, 0.2]], [0.78, [0, -1, -0.1]], [1, [-0.7, 0.4, -0.2]]]));
  c.setRPose(t > 0.76 ? POSES.open : POSES.grip);
  // the injector in the right fist until it is spent
  if (item) {
    const hq = fr.q.clone();
    const ip = c.palmAt('R', fr.p, hq, 0.015);
    item.position.copy(ip);
    item.quaternion.copy(hq).multiply(euler(0, 0, -Math.PI / 2));
    item.userData.posed = true;
    item.visible = t > 0.12 && t < 0.74;
    const cap = item.getObjectByName('cap');
    if (cap) cap.visible = t < 0.47;
  }
  once(c, 'a', t, 0.04, () => c.ev('cloth'));
  once(c, 'k', t, 0.22, () => c.ev('kneel'));
  once(c, 'c', t, 0.47, () => c.ev('reviveCap'));
  once(c, 'j', t, 0.56, () => {
    c.ev('reviveJab');
    c.jolt(0.5, 0.2, 0.2);
  });
  if (t >= 0.8 && pump > 0.95) once(c, 'p' + Math.floor(held * 10 / (Math.PI * 2)), 1, 0, () => c.ev('compress'));
}

// ============================================================================ drag
export function dragBody(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const held = c.held;
  // the gun one-handed, low on the right, canted
  const g = kf(t, [[0, 0], [0.2, 1], [0.8, 1], [1, 0]]);
  pos.y -= 0.05 * g;
  pos.x += 0.03 * g;
  pos.z += 0.02 * g;
  rot.x -= 0.12 * g;
  rot.z -= 0.16 * g;
  rot.y += 0.05 * g;
  // the haul: every backward step tugs the arm
  const tug = Math.sin(held * 6.2) * 0.5 + 0.5;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.2, 1], [0.84, 1], [1, 0]]);
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.3, [-0.11, -0.23, -0.5]], [0.5, [-0.1, -0.22, -0.49]], [1, [-0.17, -0.32, -0.3]]], fl.p);
  fl.p.z += 0.03 * tug * g;
  fl.p.y += 0.012 * tug * g;
  fl.p.x += Math.sin(held * 3.1) * 0.012 * g;
  pos.y += Math.sin(held * 6.2) * 0.006 * g;
  // a fist hooked into the strap, knuckles forward
  fl.q.copy(handFrame(V(0.05, -0.7, -0.7), V(0.1, 0.4, 1)));
  fl.pose = t > 0.25 ? POSES.grip : POSES.open;
  c.noWrapL();
  once(c, 'g', t, 0.3, () => c.ev('grab'));
}

// ============================================================================ door wedge
/** down to the floor in front, the wedge shoved under the door's edge with the heel of the hand */
export function wedgePlace(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  const g = kf(t, [[0, 0], [0.15, 1], [0.8, 1], [1, 0]]);
  pos.y -= 0.03 * g;
  rot.z -= 0.08 * g;
  // crouching down to the floor
  const dip = kf(t, [[0, 0], [0.3, 1], [0.7, 1], [1, 0]]);
  pos.y += 0.025 * dip;
  rot.x += 0.05 * dip;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.1, 1], [0.84, 1], [1, 0]]);
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.18, [-0.24, -0.45, -0.18]], [0.38, [-0.08, -0.2, -0.5]], [0.5, [-0.06, -0.21, -0.56]], [0.56, [-0.05, -0.22, -0.6]], [0.66, [-0.06, -0.2, -0.55]], [1, [-0.17, -0.32, -0.3]]], fl.p);
  fl.q.copy(handTrack(t,
    [[0, [0.3, -0.2, -1]], [0.18, [0.1, -1, 0]], [0.38, [0.1, -0.4, -1]], [0.56, [0.1, -0.2, -1]], [1, [0.3, -0.2, -1]]],
    [[0, [1, 0.05, 0.25]], [0.18, [1, 0, 0]], [0.38, [0.2, -1, 0]], [0.56, [0.1, -0.6, -0.8]], [1, [1, 0.05, 0.25]]]));
  fl.pose = t > 0.55 && t < 0.7 ? POSES.open : POSES.hold;
  c.noWrapL();
  const ps = { p: c.palmAt('L', fl.p, fl.q, 0.012), q: fl.q.clone().multiply(euler(0, Math.PI / 2, 0)) };
  item.position.copy(ps.p);
  item.quaternion.copy(ps.q);
  item.userData.posed = true;
  item.visible = t > 0.18 && t < 0.56;
  once(c, 'a', t, 0.05, () => c.ev('cloth'));
  once(c, 'w', t, 0.55, () => {
    c.ev('wedgeIn');
    c.jolt(0.3, 0.1, 0.1);
  });
}

// ============================================================================ climbing
/** hanging from a ledge: the gun swings onto the sling, both hands over the edge at the top of
 *  the view, fingers hooked; shimmying walks the hands along it */
export function ledgeHands(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  gunAway(t, pos, rot, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]);
  const held = c.held;
  const shimmy = (c.data.shimmy as number | undefined) ?? 0;
  const strain = Math.sin(held * 2.1) * 0.004;
  const fl = c.freeL, fr = c.freeR;
  const b = kf(t, [[0, 0], [0.1, 1], [0.86, 1], [1, 0]]);
  fl.b = b;
  fr.b = b;
  const stepL = Math.max(0, Math.sin(shimmy * 7)) * 0.03, stepR = Math.max(0, Math.sin(shimmy * 7 + Math.PI)) * 0.03;
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.12, [-0.2, 0.06, -0.4]], [1, [-0.2, 0.06, -0.4]]], fl.p);
  kv(t, [[0, [0.14, -0.3, -0.2]], [0.12, [0.19, 0.055, -0.41]], [1, [0.19, 0.055, -0.41]]], fr.p);
  fl.p.y += stepL + strain;
  fr.p.y += stepR + strain;
  // palms down on the top, fingers curled over the far side
  fl.q.copy(handFrame(V(0.1, -0.25, -1), V(0, -1, 0.15)));
  fr.q.copy(handFrame(V(-0.1, -0.25, -1), V(0, -1, 0.15)));
  fl.pose = POSES.hold;
  c.setRPose(POSES.hold);
  c.noWrapL();
  pos.y += Math.sin(held * 2.1) * 0.006;
  once(c, 'g', t, 0.1, () => c.ev('grabLedge'));
}

/** on the rope: the left fist high on it, the right low as the brake, the gun slung; the hands
 *  slide while you descend, a jolt on the kick-off */
export function rappelHands(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  gunAway(t, pos, rot, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]], 0.9);
  const held = c.held;
  const slide = (c.data.slide as number | undefined) ?? 0;
  const fl = c.freeL, fr = c.freeR;
  const b = kf(t, [[0, 0], [0.1, 1], [0.86, 1], [1, 0]]);
  fl.b = b;
  fr.b = b;
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.12, [-0.03, -0.02, -0.33]], [1, [-0.03, -0.02, -0.33]]], fl.p);
  kv(t, [[0, [0.14, -0.3, -0.2]], [0.12, [0.03, -0.24, -0.29]], [1, [0.03, -0.24, -0.29]]], fr.p);
  // the brake hand feeds rope as you go down
  fr.p.y += Math.sin(held * 9) * 0.015 * slide;
  fl.p.y += Math.sin(held * 9 + 1.5) * 0.008 * slide;
  fl.q.copy(handFrame(V(1, 0, -0.2), V(0.1, 0, -1)));
  fr.q.copy(handFrame(V(-1, 0.1, -0.2), V(-0.1, 0, -1)));
  fl.pose = POSES.grip;
  c.setRPose(POSES.grip);
  c.noWrapL();
  pos.x += Math.sin(held * 1.3) * 0.004;
}

/** the grapple launcher on the left: up into view, aimed, the shot (the hook leaves, the arm
 *  kicks), then held out straight while the line reels you in */
export function grappleArm(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  const g = kf(t, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]);
  pos.x += 0.03 * g;
  pos.y -= 0.04 * g;
  rot.z -= 0.12 * g;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]);
  const kick = kf(t, [[0, 0], [0.3, 0], [0.33, 1], [0.45, 0]]);
  kv(t, [[0, [-0.17, -0.32, -0.3]], [0.2, [-0.12, -0.13, -0.42]], [0.86, [-0.12, -0.13, -0.42]], [1, [-0.17, -0.32, -0.3]]], fl.p);
  fl.p.z += 0.05 * kick;
  fl.p.y += 0.02 * kick;
  // a fist round the pistol grip, the launcher pointing down the line of sight
  fl.q.copy(handFrame(V(0.05, 0.1, -1), V(1, 0, 0)));
  fl.pose = POSES.grip;
  c.noWrapL();
  const ps = c.palmAt('L', fl.p, fl.q, 0.012);
  item.position.copy(ps).add(V(0.0, 0.035, -0.03).applyQuaternion(fl.q));
  item.quaternion.copy(fl.q).multiply(euler(-0.1, 0, 0));
  item.userData.posed = true;
  item.visible = t > 0.05 && t < 0.92;
  const hook = item.getObjectByName('hook');
  if (hook) hook.visible = t < 0.32;
  (item.userData.setProngs as ((k: number) => void) | undefined)?.(t < 0.32 ? 0 : 1);
  once(c, 'f', t, 0.32, () => {
    c.ev('grappleFire');
    c.jolt(0.8, 0.6, 0.3);
  });
}
