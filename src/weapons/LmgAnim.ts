import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { LMG_COVER_PIVOT } from './WeaponModels';
import { clamp, smoothstep, easeInOutCubic, easeOutBack } from '../core/math';

/**
 * KVL-7 belt-fed reload. One long, deliberate sequence in weapon space (the support hand never
 * teleports, every part it touches moves with it):
 *
 *   roll the gun over → thumb the cover latch and swing the feed cover up → lift the old belt
 *   out of the tray → press the box latch and strip the empty box down and away → into the pouch
 *   → bring the fresh box up, hook its front lip and rock it in → pull the belt end out of the
 *   box and lay it across the feed tray → palm the cover down hard → (empty: reach under to the
 *   charging handle, rip it back, let it slam) → support hand back on the handguard.
 *
 * The tactical reload keeps a round in the chamber, so it skips the charging handle.
 */
type V3 = [number, number, number];
interface HKey { t: number; a: V3; f: V3; n: V3; pose: FingerPose; r?: number }

const COVER_OPEN = -0.98;
/** where a point on the closed cover goes when the cover is at angle th */
function coverPoint(p: THREE.Vector3, th: number) {
  const rel = p.clone().sub(LMG_COVER_PIVOT);
  rel.applyAxisAngle(new THREE.Vector3(1, 0, 0), th);
  return rel.add(LMG_COVER_PIVOT);
}

function kfv(t: number, keys: [number, V3][], out = new THREE.Vector3()) {
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
function sampleHand(t: number, keys: HKey[]) {
  let i = 1;
  while (i < keys.length - 1 && t > keys[i].t) i++;
  const A = keys[i - 1], B = keys[i];
  const u = smoothstep(0, 1, clamp((t - A.t) / Math.max(1e-6, B.t - A.t), 0, 1));
  const lerp3 = (a: V3, b: V3) => new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), u);
  return { a: lerp3(A.a, B.a), f: lerp3(A.f, B.f), n: lerp3(A.n, B.n), pose: u < 0.5 ? A.pose : B.pose, r: (A.r ?? 0.004) * (1 - u) + (B.r ?? 0.004) * u };
}

export interface LmgHands {
  leftTarget: THREE.Vector3;
  leftQ: THREE.Quaternion;
  setLeft: (b: number, p: FingerPose) => void;
}

// the box on the gun: home is its build position; its left face centre (box space) is where the palm goes
const BOX_FACE = new THREE.Vector3(-0.034, -0.065, 0.0);

export function lmgReload(
  t: number, empty: boolean, pos: THREE.Vector3, rot: THREE.Vector3, parts: Record<string, THREE.Object3D | undefined>,
  h: LmgHands, magHome: THREE.Vector3, chargeHome: THREE.Vector3,
  wristFor: (anchor: THREE.Vector3, q: THREE.Quaternion, r: number) => THREE.Vector3,
  ev: (name: string) => void, fired: Set<string>, jolt: (u: number, r: number, b?: number) => void,
) {
  // tactical timeline τ; the empty reload runs it over the first 86 % and charges after
  const tau = empty ? Math.min(1, t / 0.86) : t;
  const ch = empty ? clamp((t - 0.86) / 0.14, 0, 1) : 0;
  const once = (k: string, at: number, f: () => void) => {
    if (tau >= at && !fired.has(k)) {
      fired.add(k);
      f();
    }
  };

  // ---------------- gun: rolled over to show the feed tray and box, lifted toward the face ----------------
  const roll = kf(tau, [[0, 0], [0.07, -0.38], [0.22, -0.4], [0.33, -0.72], [0.48, -0.8], [0.64, -0.74], [0.72, -0.36], [0.82, -0.3], [0.9, -0.22], [1, 0]]);
  const pitch = kf(tau, [[0, 0], [0.07, 0.1], [0.22, 0.16], [0.32, 0.04], [0.48, 0.0], [0.66, 0.06], [0.76, 0.18], [0.86, 0.1], [1, 0]]);
  const yaw = kf(tau, [[0, 0], [0.07, 0.12], [0.5, 0.16], [0.8, 0.1], [1, 0]]);
  rot.z += roll * (1 - ch) + kf(ch, [[0, 0], [0.25, 0.32], [0.75, 0.3], [1, 0]]);
  rot.x += pitch * (1 - ch) + kf(ch, [[0, 0], [0.3, 0.08], [0.7, 0.05], [1, 0]]);
  rot.y += yaw * (1 - ch);
  kfv(tau, [[0, [0, 0, 0]], [0.07, [-0.045, -0.012, -0.075]], [0.3, [-0.055, -0.008, -0.085]], [0.4, [-0.06, 0.045, -0.08]], [0.6, [-0.06, 0.05, -0.08]], [0.76, [-0.05, -0.008, -0.08]], [0.9, [-0.025, -0.012, -0.045]], [1, [0, 0, 0]]], TMP).multiplyScalar(1 - ch);
  pos.add(TMP);
  pos.x += -0.02 * Math.sin(ch * Math.PI);

  // ---------------- feed cover ----------------
  const cover = parts.cover;
  const cv = tau < 0.5 ? COVER_OPEN * easeOutBack(clamp((tau - 0.11) / 0.08, 0, 1)) : COVER_OPEN * (1 - Math.pow(clamp((tau - 0.835) / 0.03, 0, 1), 2));
  if (cover) cover.rotation.x = cv;
  once('cv1', 0.11, () => ev('boltOpen'));
  once('cv2', 0.865, () => {
    ev('boltClose');
    ev('camSeatHard');
    jolt(1.6, -0.5, -0.5);
  });

  // ---------------- the box ----------------
  const box = parts.mag;
  const boxOff = new THREE.Vector3(), boxRot = new THREE.Euler();
  if (box) {
    if (tau < 0.5) {
      // old box: latch, then down and away to the left
      const out = clamp((tau - 0.385) / 0.09, 0, 1);
      kfv(out, [[0, [0, 0, 0]], [0.25, [-0.004, -0.03, 0]], [1, [-0.11, -0.3, 0.06]]], boxOff);
      boxRot.set(0.2 * out, 0, -0.6 * out);
      box.visible = tau < 0.475;
    } else {
      // fresh box: up from the pouch, front lip hooked, rocked in
      const inn = clamp((tau - 0.53) / 0.1, 0, 1);
      kfv(inn, [[0, [-0.12, -0.32, 0.08]], [0.6, [-0.006, -0.04, 0.0]], [0.8, [-0.002, -0.012, 0.0]], [1, [0, 0, 0]]], boxOff);
      boxRot.set(0.25 * (1 - inn), 0, -0.45 * (1 - easeInOutCubic(inn)));
      box.visible = tau > 0.53;
    }
    box.position.copy(magHome).add(boxOff);
    box.quaternion.setFromEuler(boxRot);
  }
  once('bx1', 0.39, () => ev('magTouch'));
  once('bx2', 0.41, () => { ev('magOut'); jolt(0.3, 0.3); });
  once('bx3', 0.5, () => ev('cloth'));
  once('bx4', 0.585, () => ev('magTouch'));
  once('bx5', 0.63, () => { ev('magIn'); ev('camSeat'); jolt(0.9, -0.6, -0.3); });

  // ---------------- the belt ----------------
  const belt = parts.belt;
  if (belt) {
    // old belt: lifted out of the tray and dropped toward the box; new belt: drawn up and laid in
    let off = new THREE.Vector3();
    if (tau < 0.5) {
      const lift = clamp((tau - 0.22) / 0.08, 0, 1);
      off = kfv(lift, [[0, [0, 0, 0]], [0.5, [-0.01, 0.025, 0]], [1, [-0.04, -0.02, 0.0]]]);
      belt.visible = tau < 0.4;
    } else {
      const lay = clamp((tau - 0.68) / 0.09, 0, 1);
      off = kfv(lay, [[0, [-0.02, -0.09, 0]], [0.55, [-0.03, 0.03, 0]], [1, [0, 0, 0]]]);
      belt.visible = tau > 0.66;
    }
    belt.position.copy(off);
  }
  once('bl1', 0.23, () => ev('rattle'));
  once('bl2', 0.7, () => ev('rattle'));
  once('bl3', 0.77, () => { ev('magTouch'); jolt(0.25, 0.2); });

  // ---------------- charging handle (empty) ----------------
  const pull = kf(ch, [[0, 0], [0.35, 0], [0.55, 1], [0.62, 1], [0.7, 0], [1, 0]]);
  if (parts.charge) parts.charge.position.set(chargeHome.x, chargeHome.y, chargeHome.z + 0.11 * pull);
  if (empty) {
    if (ch >= 0.5 && !fired.has('ch1')) { fired.add('ch1'); ev('boltBack'); jolt(0.3, 0.3, 0.4); }
    if (ch >= 0.69 && !fired.has('ch2')) { fired.add('ch2'); ev('boltRelease'); jolt(1.2, -0.5, -0.4); }
  }

  // ---------------- support hand ----------------
  const latch = coverPoint(new THREE.Vector3(0, 0.094, 0.066), cv);
  const coverTop = coverPoint(new THREE.Vector3(-0.004, 0.096, 0.02), cv);
  const beltGrab = new THREE.Vector3(-0.012, 0.064, -0.066).add(belt?.position ?? new THREE.Vector3());
  const boxPalm = BOX_FACE.clone().applyEuler(boxRot).add(magHome).add(boxOff);
  const keys: HKey[] = [
    { t: 0.0, a: [0, 0.0, -0.3], f: [0.5, -0.4, -0.6], n: [0.3, 1, 0], pose: POSES.support },
    // thumb on the latch, fingers over the rear of the cover
    { t: 0.07, a: [latch.x - 0.01, latch.y + 0.004, latch.z - 0.012], f: [0.25, -0.35, -1], n: [0.1, -1, 0.1], pose: POSES.hold },
    { t: 0.11, a: [latch.x - 0.01, latch.y, latch.z - 0.008], f: [0.25, -0.35, -1], n: [0.1, -1, 0.1], pose: POSES.grip },
    // swing it up and let go at the top
    { t: 0.19, a: [latch.x - 0.01, latch.y + 0.01, latch.z], f: [0.2, 0.5, -1], n: [0.1, -0.6, 0.7], pose: POSES.open },
    // pinch the belt in the tray, lift it out to the left
    { t: 0.235, a: [beltGrab.x, beltGrab.y + 0.012, beltGrab.z], f: [1, -0.2, -0.3], n: [0, -1, 0], pose: POSES.pinch, r: 0.006 },
    { t: 0.3, a: [beltGrab.x - 0.01, beltGrab.y + 0.015, beltGrab.z], f: [1, -0.4, -0.3], n: [0.2, -1, 0], pose: POSES.pinch, r: 0.006 },
    // palm on the box, thumb on its latch, strip it
    { t: 0.375, a: [boxPalm.x, boxPalm.y, boxPalm.z], f: [0.15, -0.35, -1], n: [1, 0, 0], pose: POSES.grip, r: 0.006 },
    { t: 0.41, a: [boxPalm.x, boxPalm.y, boxPalm.z], f: [0.15, -0.35, -1], n: [1, 0, 0], pose: POSES.grip, r: 0.006 },
    { t: 0.47, a: [boxPalm.x, boxPalm.y, boxPalm.z], f: [0.15, -0.35, -1], n: [1, 0.2, 0], pose: POSES.grip, r: 0.006 },
    // pouch
    { t: 0.53, a: [-0.2, -0.36, 0.06], f: [0.2, -0.6, -0.7], n: [1, 0, 0], pose: POSES.grip, r: 0.006 },
    // fresh box: up, hooked, seated
    { t: 0.6, a: [boxPalm.x, boxPalm.y, boxPalm.z], f: [0.15, -0.35, -1], n: [1, 0, 0], pose: POSES.grip, r: 0.006 },
    { t: 0.645, a: [boxPalm.x, boxPalm.y, boxPalm.z], f: [0.15, -0.35, -1], n: [1, 0, 0], pose: POSES.grip, r: 0.006 },
    // belt end out of the box and across the tray
    { t: 0.69, a: [beltGrab.x - 0.02, beltGrab.y - 0.01, beltGrab.z], f: [1, 0.2, -0.3], n: [0.2, -1, 0], pose: POSES.pinch, r: 0.006 },
    { t: 0.775, a: [beltGrab.x + 0.012, beltGrab.y + 0.004, beltGrab.z], f: [1, -0.2, -0.3], n: [0, -1, 0], pose: POSES.pinch, r: 0.006 },
    // up over the open cover, then palm it shut
    { t: 0.83, a: [coverTop.x, coverTop.y + 0.02, coverTop.z], f: [0.2, -0.3, -1], n: [0, -1, 0.2], pose: POSES.open },
    { t: 0.868, a: [coverTop.x, coverTop.y + 0.002, coverTop.z], f: [0.2, -0.3, -1], n: [0, -1, 0.1], pose: POSES.open },
    { t: 0.9, a: [coverTop.x, coverTop.y + 0.004, coverTop.z], f: [0.2, -0.3, -1], n: [0, -1, 0.1], pose: POSES.open },
    { t: 1.0, a: [0, 0.0, -0.3], f: [0.5, -0.4, -0.6], n: [0.3, 1, 0], pose: POSES.support },
  ];
  const hs = sampleHand(tau, keys);
  let blend = kf(tau, [[0, 0], [0.06, 1], [0.92, 1], [1, 0]]);
  let anchor = hs.a, fing = hs.f, palm = hs.n, pose = hs.pose, r = hs.r;
  if (empty && ch > 0) {
    // reach under to the right-side charging handle, hook it, rip it back
    const hp = new THREE.Vector3(0.056, 0.038, -0.085 + 0.11 * pull);
    const k = kf(ch, [[0, 0], [0.3, 1], [0.8, 1], [1, 0]]);
    anchor = anchor.clone().lerp(hp, k);
    fing = fing.clone().lerp(new THREE.Vector3(-0.4, 0.3, -1), k);
    palm = palm.clone().lerp(new THREE.Vector3(-1, 0, 0.2), k);
    pose = k > 0.5 ? POSES.hold : pose;
    r = 0.008;
    blend = Math.max(blend, kf(ch, [[0, 1], [0.85, 1], [1, 0]]));
  }
  const q = handFrame(fing, palm);
  h.leftQ.copy(q);
  h.leftTarget.copy(wristFor(anchor, q, r));
  h.setLeft(blend, pose);
  once('cl0', 0.02, () => ev('cloth'));
  once('cl1', 0.96, () => ev('rattle'));
}

const TMP = new THREE.Vector3();
