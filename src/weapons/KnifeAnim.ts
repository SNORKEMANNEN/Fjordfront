import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { easeInOutCubic } from '../core/math';

/**
 * Combat knife animations (the knife is the "weapon" in the right hand, so pos / rot move the
 * knife in camera space on top of its carry pose; the left hand is driven in camera space).
 *
 *  slash  — wind-up and a flat swipe, alternating right→left / left→right
 *  stab   — pull back and a hard forward thrust
 *  kill   — contextual takedowns, chosen by the game from how and where you reached them:
 *    back   grab the shoulder / cover the mouth with the left hand, knife up into the neck
 *    front  slash across the throat, reverse and drive it into the chest
 *    air    both hands up, the knife comes down overhead as you land on them
 *    down   on a crouched / prone / lower target: tilt and stab downward
 *    slide  low, fast hook across the legs and up as you slide through
 *    side   short hook into the ribs from the flank
 */
export type KnifeKill = 'back' | 'front' | 'air' | 'down' | 'slide' | 'side';
export const KILL_TIMING: Record<KnifeKill, { dur: number; hit: number; lock: number }> = {
  back: { dur: 1.05, hit: 0.42, lock: 0.85 },
  front: { dur: 0.95, hit: 0.52, lock: 0.75 },
  air: { dur: 0.85, hit: 0.34, lock: 0.6 },
  down: { dur: 0.8, hit: 0.36, lock: 0.6 },
  slide: { dur: 0.62, hit: 0.3, lock: 0.35 },
  side: { dur: 0.78, hit: 0.36, lock: 0.55 },
};

type V6 = [number, number, number, number, number, number];
/** eased keyframes of [px, py, pz, rx, ry, rz] */
function track(t: number, keys: [number, V6][], out: number[]) {
  if (t <= keys[0][0]) return keys[0][1].forEach((v, i) => (out[i] = v));
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t <= t1) {
      const u = easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
      for (let j = 0; j < 6; j++) out[j] = a[j] + (b[j] - a[j]) * u;
      return;
    }
  }
  keys[keys.length - 1][1].forEach((v, i) => (out[i] = v));
}
const Z: V6 = [0, 0, 0, 0, 0, 0];

export interface KnifeHands {
  freeL: { b: number; p: THREE.Vector3; q: THREE.Quaternion; pose: FingerPose };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// left-hand frames (camera space): reaching grab (palm forward, fingers up), guard fist
const GRAB_Q = handFrame(V(0.15, 0.85, -0.5), V(0.1, -0.2, -1));
const GUARD_Q = handFrame(V(0.35, 0.6, -0.7), V(1, -0.1, 0.2));
const UP_Q = handFrame(V(0.3, 0.2, -0.95), V(0.2, -1, 0));

/** Carry pose of the knife: blade up and angled in, so it reads at the bottom right. */
export function knifeCarry(pos: THREE.Vector3, rot: THREE.Vector3) {
  rot.x += 0.42;
  rot.y += 0.32;
  rot.z += -0.25;
  void pos;
}

const tmp: number[] = [0, 0, 0, 0, 0, 0];
export function knifeAction(type: string, data: any, t: number, pos: THREE.Vector3, rot: THREE.Vector3, h: KnifeHands) {
  const add = () => {
    pos.x += tmp[0]; pos.y += tmp[1]; pos.z += tmp[2];
    rot.x += tmp[3]; rot.y += tmp[4]; rot.z += tmp[5];
  };
  const guard = (b: number) => {
    h.freeL.b = b;
    h.freeL.p.set(-0.2, -0.17, -0.3);
    h.freeL.q.copy(GUARD_Q);
    h.freeL.pose = POSES.hold;
  };
  if (type === 'knifeSlash') {
    const s = data?.side ?? 1;
    track(t, [
      [0, Z],
      [0.22, [0.1 * s, 0.05, 0.02, 0.15, -0.95 * s, 0.75 * s]],
      [0.42, [-0.16 * s, 0.0, -0.12, -0.05, 1.05 * s, -0.55 * s]],
      [0.55, [-0.19 * s, -0.02, -0.1, -0.1, 1.2 * s, -0.6 * s]],
      [1, Z],
    ], tmp);
    add();
    return;
  }
  if (type === 'knifeStab') {
    track(t, [
      [0, Z],
      [0.24, [0.02, 0.02, 0.09, 0.28, 0.1, -0.15]],
      [0.4, [-0.07, 0.035, -0.26, -0.42, -0.35, 0.2]],
      [0.55, [-0.07, 0.03, -0.24, -0.45, -0.35, 0.22]],
      [1, Z],
    ], tmp);
    add();
    return;
  }
  if (type !== 'knifeKill') return;
  const kind: KnifeKill = data?.kind ?? 'front';
  const hit = KILL_TIMING[kind].hit;
  switch (kind) {
    case 'back': {
      // left hand clamps the shoulder / mouth, the knife is drawn back then punched up into the neck
      track(t, [
        [0, Z],
        [0.18, [0.04, 0.03, 0.05, 0.3, 0.25, -0.2]],
        [hit - 0.04, [0.0, 0.06, 0.07, 0.45, 0.3, -0.3]],
        [hit, [-0.1, 0.1, -0.24, -0.25, -0.55, 0.45]],
        [hit + 0.18, [-0.1, 0.08, -0.22, -0.35, -0.6, 0.65]], // twist
        [0.7, [-0.06, 0.02, -0.12, -0.2, -0.3, 0.3]],
        [1, Z],
      ], tmp);
      add();
      const g = t < 0.1 ? t / 0.1 : t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.22);
      h.freeL.b = easeInOutCubic(g);
      const pull = t > hit ? Math.min(1, (t - hit) / 0.2) : 0;
      h.freeL.p.set(-0.08, 0.02 - 0.03 * pull, -0.5 + 0.08 * pull);
      h.freeL.q.copy(GRAB_Q);
      h.freeL.pose = t < 0.14 ? POSES.open : POSES.hold;
      return;
    }
    case 'front': {
      // backhand slash across the throat, then the point goes in under the ribs
      track(t, [
        [0, Z],
        [0.14, [0.1, 0.08, 0.03, 0.25, -0.9, 0.85]],
        [0.28, [-0.17, 0.09, -0.12, 0.0, 1.05, -0.6]],
        [0.4, [0.0, 0.02, 0.1, 0.35, 0.15, -0.2]],
        [hit, [-0.06, -0.01, -0.28, -0.4, -0.3, 0.25]],
        [hit + 0.14, [-0.06, -0.02, -0.26, -0.48, -0.3, 0.3]],
        [1, Z],
      ], tmp);
      add();
      // the off hand shoves the chest as the stab lands
      const s = t < 0.3 ? 0 : t < hit ? (t - 0.3) / (hit - 0.3) : Math.max(0, 1 - (t - hit) / 0.25);
      h.freeL.b = easeInOutCubic(s);
      h.freeL.p.set(-0.12, -0.08, -0.45);
      h.freeL.q.copy(GRAB_Q);
      h.freeL.pose = POSES.open;
      return;
    }
    case 'air': {
      // dropping onto them: knife raised high in a hammer grip, then driven straight down
      track(t, [
        [0, Z],
        [0.22, [-0.04, 0.26, 0.04, 1.35, 0.1, -0.2]],
        [hit - 0.02, [-0.05, 0.3, 0.02, 1.5, 0.1, -0.2]],
        [hit + 0.06, [-0.07, -0.08, -0.26, -0.7, 0.0, 0.0]],
        [0.62, [-0.07, -0.1, -0.24, -0.8, 0.0, 0.0]],
        [1, Z],
      ], tmp);
      add();
      const u = t < 0.2 ? t / 0.2 : t < 0.5 ? 1 : Math.max(0, 1 - (t - 0.5) / 0.3);
      h.freeL.b = easeInOutCubic(u);
      h.freeL.p.set(-0.2, -0.05 + 0.12 * Math.min(1, t / 0.2) - (t > hit ? 0.18 * Math.min(1, (t - hit) / 0.1) : 0), -0.4);
      h.freeL.q.copy(UP_Q);
      h.freeL.pose = POSES.open;
      return;
    }
    case 'down': {
      track(t, [
        [0, Z],
        [0.2, [0.02, 0.1, 0.06, 0.95, 0.15, -0.3]],
        [hit, [-0.05, -0.14, -0.26, -0.95, -0.15, 0.2]],
        [hit + 0.16, [-0.05, -0.16, -0.25, -1.0, -0.15, 0.25]],
        [1, Z],
      ], tmp);
      add();
      guard(t < 0.8 ? 1 : (1 - t) / 0.2);
      return;
    }
    case 'slide': {
      track(t, [
        [0, Z],
        [0.14, [0.12, -0.08, 0.02, -0.2, -0.85, 0.9]],
        [hit, [-0.18, -0.02, -0.16, 0.25, 1.1, -0.5]],
        [hit + 0.12, [-0.2, 0.02, -0.14, 0.35, 1.2, -0.55]],
        [1, Z],
      ], tmp);
      add();
      guard(1);
      return;
    }
    case 'side': {
      track(t, [
        [0, Z],
        [0.18, [0.12, 0.02, 0.06, 0.1, -0.7, 0.5]],
        [hit, [-0.12, 0.0, -0.22, -0.1, 0.65, -0.25]],
        [hit + 0.14, [-0.12, -0.01, -0.2, -0.15, 0.7, -0.2]],
        [1, Z],
      ], tmp);
      add();
      guard(1);
      return;
    }
  }
}
