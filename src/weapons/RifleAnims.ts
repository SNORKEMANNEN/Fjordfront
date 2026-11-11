import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { AK, KAR } from './WeaponModels';
import { clamp, smoothstep, easeInOutCubic, easeOutBack } from '../core/math';
import { Pose, kf, kv, mul, place, once, AnimCtx } from './SmgAnims';

/**
 * Authored animations for the HVAL-47 (AK pattern) and the KR-98k (Mauser pattern). Nothing here
 * is shared with any other weapon: each gun has its own timing, hand paths and part motion.
 *
 * HVAL-47 tactical — mag-on-mag: right hand stays on the grip; the left fetches a fresh mag, brings
 *   it up behind the old one, drives its nose into the old mag's spine so the old one rocks
 *   forward off its lug and drops away, and in the same motion hooks the new mag's front lug and
 *   rocks it back until it clicks. Hand back to the handguard.
 * HVAL-47 empty — the same idea, but punched: the fresh mag smashes the empty out (it spins away),
 *   is slammed home hard, then the left hand reaches over the top to the carrier handle, rips it
 *   back and lets it fly, and the gun gets a little settling roll before it comes back up.
 *
 * KR-98k reload — plans itself from the rounds left (see WeaponSystem): one or two missing → the
 *   bolt opens and the left hand thumbs single cartridges in through the open action; three or
 *   four → a stripper clip in the guides, rounds pressed down, empty clip pulled out; empty → the
 *   clip routine done more deliberately, then the bolt is driven home to chamber the first round.
 * KR-98k cycle — its own bolt throw after each shot.
 */
export interface RifleHands {
  leftTarget: THREE.Vector3;
  leftQ: THREE.Quaternion;
  setLeft: (b: number, p: FingerPose) => void;
  rightTarget: THREE.Vector3;
  rightQ: THREE.Quaternion;
  setRight: (b: number) => void;
}
export interface RifleCtx extends AnimCtx {
  hr: RifleHands;
  boltHome: THREE.Vector3;
  wristForR: (anchor: THREE.Vector3, q: THREE.Quaternion, r: number) => THREE.Vector3;
}

const lerpPose = (a: Pose, b: Pose, u: number): Pose => ({ p: a.p.clone().lerp(b.p, u), q: a.q.clone().slerp(b.q, u) });
const E = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
const P = (x: number, y: number, z: number, q = new THREE.Quaternion()): Pose => ({ p: new THREE.Vector3(x, y, z), q });
/** piecewise pose track with eased segments */
function track(t: number, keys: [number, Pose][]): Pose {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      return lerpPose(a, b, smoothstep(0, 1, (t - t0) / Math.max(1e-6, t1 - t0)));
    }
  }
  return keys[keys.length - 1][1];
}
function leftOn(c: AnimCtx, grip: Pose, blend: number, pose: FingerPose, r = 0.004) {
  c.h.leftQ.copy(grip.q);
  c.h.leftTarget.copy(c.wristFor(grip.p, grip.q, r));
  c.h.setLeft(blend, pose);
}

// ================================================================== HVAL-47
/** magazine rocked about its front lug by th (positive = bottom swings forward, out) */
function rocked(home: THREE.Vector3, th: number): Pose {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), th);
  const piv = AK.pivot.clone();
  return { p: home.clone().add(piv).sub(piv.clone().applyQuaternion(q)), q };
}
/** the support hand on an AK mag: palm on the left face low on the curve, fingers round the front */
const AK_GRIP: Pose = { p: new THREE.Vector3(-0.0122, -0.105, -0.046), q: handFrame(new THREE.Vector3(0.2, -0.35, -1), new THREE.Vector3(1, 0, 0.05)) };

export function akReload(t: number, empty: boolean, pos: THREE.Vector3, rot: THREE.Vector3, c: RifleCtx) {
  const { parts } = c;
  const home = c.magHome.clone();
  // the mag work happens in the first part; the empty reload compresses it and adds the rack
  const S = empty ? 0.58 : 1;
  const m = Math.min(1, t / S);
  const punch = empty ? 1.6 : 1;
  // ---- gun: lifted and rolled to present the well; on the empty, the punch knocks it up
  const rz = kf(m, [[0, 0], [0.16, -0.36], [0.34, -0.4], [0.4, -0.32 - 0.08 * punch], [0.52, -0.36], [0.6, -0.3], [0.72, -0.22], [0.9, -0.08], [1, 0]]);
  const rx = kf(m, [[0, 0], [0.16, 0.2], [0.34, 0.2], [0.38, 0.2 + 0.07 * punch], [0.5, 0.22], [0.55, 0.12], [0.72, 0.1], [1, 0]]);
  let lift = kv(m, [[0, [0, 0, 0]], [0.16, [-0.05, 0.03, -0.09]], [0.5, [-0.052, 0.034, -0.095]], [0.56, [-0.045, 0.026, -0.085]], [0.8, [-0.02, 0.01, -0.03]], [1, [0, 0, 0]]]);
  if (empty) {
    // the rack: rolled the other way to show the right side, then a settling flourish
    const r = clamp((t - S) / (1 - S), 0, 1);
    const k = kf(r, [[0, 0], [0.18, 1], [0.62, 1], [0.78, 0.4], [1, 0]]);
    rot.z += rz * (1 - k) + 0.42 * k + kf(r, [[0.6, 0], [0.74, -0.14], [0.86, 0.05], [1, 0]]);
    rot.x += rx * (1 - k) + 0.08 * k + kf(r, [[0.4, 0], [0.48, 0.05], [0.56, -0.03], [0.62, 0]]);
    rot.y += 0.08 * k;
    lift = lift.multiplyScalar(1 - k).add(new THREE.Vector3(-0.01, -0.03, -0.11).multiplyScalar(k));
  } else {
    rot.z += rz;
    rot.x += rx;
    rot.y += kf(m, [[0, 0], [0.16, 0.14], [0.6, 0.12], [1, 0]]);
  }
  pos.add(lift);
  // ---- the old mag: shoved forward off its lug by the new mag's nose, then gone
  const shove = clamp((m - 0.3) / 0.08, 0, 1);
  const fall = clamp((m - 0.36) / (empty ? 0.09 : 0.12), 0, 1);
  const oth = 0.38 * shove + (empty ? 1.5 : 0.7) * fall;
  const old = rocked(home, oth);
  old.p.add(new THREE.Vector3(empty ? 0.04 * fall : -0.01 * fall, -(empty ? 0.34 : 0.3) * fall * fall, -(empty ? 0.14 : 0.06) * fall));
  if (empty) old.q.multiply(E(0, 0, 1.2 * fall));
  place(parts.mag, old);
  if (parts.mag) parts.mag.visible = fall < 0.98;
  // ---- the new mag: pouch → behind the old one → shove → hook the lug → rock home
  const hook = rocked(home, 0.5);
  const seat = rocked(home, 0);
  const NM = track(m, [
    [0.06, P(-0.2, -0.34, 0.05, E(0.5, 0.2, 0.4))],
    [0.24, P(-0.03, -0.12, -0.0, E(0.6, 0, 0.1))],
    [0.3, P(-0.004, -0.072, -0.006, E(0.56, 0, 0))],
    [0.38, P(-0.002, -0.058, -0.034, E(0.52, 0, 0))],
    [0.44, hook],
    [0.5, seat],
  ]);
  const newMag = m < 0.5 ? NM : seat;
  // a seat that clicks: tiny overshoot up into the well
  if (m > 0.49 && m < 0.55) newMag.p.y += 0.003 * Math.sin(((m - 0.49) / 0.06) * Math.PI) * punch;
  place(parts.mag2, newMag);
  if (parts.mag2) parts.mag2.visible = m > 0.07;
  // ---- left hand: on the new mag until it is seated, then back to the guard (or up to the rack)
  const onMag = mul(newMag, AK_GRIP);
  let target = onMag, pose: FingerPose = POSES.grip, blend: number;
  if (empty && t > S) {
    const r = (t - S) / (1 - S);
    const pull = kf(r, [[0, 0], [0.3, 0], [0.44, 1], [0.5, 1], [0.54, 0]]);
    if (parts.charge) parts.charge.position.set(c.chargeHome.x, c.chargeHome.y, c.chargeHome.z + 0.11 * pull);
    // over the top: palm down on the receiver, fingers hooking the handle on the far side
    const knob = new THREE.Vector3(0.034, 0.018, -0.123 + 0.11 * pull);
    const over: Pose = { p: knob.clone().add(new THREE.Vector3(-0.012, 0.012, 0.0)), q: handFrame(new THREE.Vector3(0.55, -0.75, -0.25), new THREE.Vector3(0.75, -0.55, 0.1)) };
    const away: Pose = { p: over.p.clone().add(new THREE.Vector3(-0.06, 0.05, 0.04)), q: over.q };
    target = r < 0.24 ? lerpPose(onMag, over, smoothstep(0, 0.24, r)) : r < 0.54 ? over : lerpPose(over, away, smoothstep(0.54, 0.66, r));
    pose = r > 0.2 && r < 0.54 ? POSES.grip : POSES.open;
    blend = kf(r, [[0, 1], [0.7, 1], [0.92, 0]]);
    once(c, 'r1', r, 0.43, () => { c.ev('boltBack'); c.jolt(0.35, 0.3, 0.45); });
    once(c, 'r2', r, 0.53, () => { c.ev('boltRelease'); c.jolt(1.5, 0.7, -0.5); });
    once(c, 'r3', r, 0.76, () => c.ev('rattle'));
  } else {
    blend = kf(m, [[0, 0], [0.08, 1], empty ? [1, 1] : [0.6, 1], empty ? [1, 1] : [0.82, 0]]);
    pose = m > 0.52 ? POSES.open : POSES.grip;
  }
  leftOn(c, target, blend, pose, 0.004);
  // ---- sound & feel
  once(c, 'a', m, 0.02, () => c.ev('cloth'));
  once(c, 'b', m, 0.29, () => c.ev('magTouch'));
  once(c, 'c', m, 0.33, () => { c.ev('magOut'); if (empty) c.ev('magDrop'); c.jolt(0.4 * punch, 0.4 * punch, 0.2); if (empty) c.ev('camTap'); });
  once(c, 'd', m, 0.43, () => c.ev('magTouch'));
  once(c, 'e', m, 0.495, () => { c.ev('magIn'); c.ev(empty ? 'camSeatHard' : 'camSeat'); c.jolt(0.9 * punch, -0.8, -0.3); });
  if (!empty) once(c, 'f', m, 0.85, () => c.ev('rattle'));
}

// ================================================================== KR-98k
export interface KarPlan { kind: 'single' | 'clip' | 'empty'; n: number; start: number }

/** the bolt, by lift (0..1, handle up) and draw (0..1, back) */
function setBolt(c: RifleCtx, lift: number, draw: number) {
  const b = c.parts.bolt;
  if (!b) return;
  b.rotation.z = 1.05 * lift;
  b.position.set(c.boltHome.x, c.boltHome.y, c.boltHome.z + 0.1 * draw);
}
function knobAt(c: RifleCtx, lift: number, draw: number) {
  return KAR.knob.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), 1.05 * lift).add(new THREE.Vector3(0, KAR.bore, c.boltHome.z + 0.1 * draw));
}
/** right hand on the bolt knob: cupped under it, fingers curling over from the outside */
function rightOnKnob(c: RifleCtx, knob: THREE.Vector3, blend: number, lift: number) {
  const q = handFrame(new THREE.Vector3(-0.35, 0.25 + 0.35 * lift, -0.9), new THREE.Vector3(-0.55, 0.8, 0.05));
  c.hr.rightQ.copy(q);
  c.hr.rightTarget.copy(c.wristForR(knob, q, 0.0095));
  c.hr.setRight(blend);
}

/** Per-shot bolt throw: up, rip back (the case flies), drive forward, slap down. */
export function karCycle(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: RifleCtx) {
  const lift = kf(t, [[0, 0], [0.16, 0], [0.27, 1], [0.7, 1], [0.8, 0]]);
  const draw = kf(t, [[0, 0], [0.27, 0], [0.42, 1], [0.52, 1], [0.68, 0]]);
  setBolt(c, lift, draw);
  const reach = kf(t, [[0, 0], [0.14, 1], [0.84, 1], [1, 0]]);
  rightOnKnob(c, knobAt(c, lift, draw), reach, lift);
  // the gun rolls a touch toward the bolt side, kicks back with the pull, settles on the push
  rot.z += 0.12 * reach + 0.05 * Math.sin(draw * Math.PI);
  rot.x += 0.06 * reach - 0.03 * kf(t, [[0.66, 0], [0.7, 1], [0.8, 0]]);
  rot.y += 0.1 * reach;
  pos.x -= 0.035 * reach;
  pos.z += 0.012 * draw - 0.085 * reach;
  pos.y -= 0.045 * reach;
  once(c, 'k1', t, 0.2, () => c.ev('boltOpen'));
  once(c, 'k2', t, 0.4, () => { c.ev('boltBack'); c.jolt(0.2, 0.25, 0.35); });
  once(c, 'k3', t, 0.44, () => c.ev('eject'));
  once(c, 'k4', t, 0.66, () => c.ev('boltClose'));
  once(c, 'k5', t, 0.79, () => { c.ev('fireMode'); c.jolt(0.5, -0.3, -0.1); });
}

const ROUND_GRIP: Pose = { p: new THREE.Vector3(0, 0.0055, 0.03), q: handFrame(new THREE.Vector3(0.15, -0.55, -1), new THREE.Vector3(0.45, -0.9, 0)) };

export function karReload(t: number, plan: KarPlan, pos: THREE.Vector3, rot: THREE.Vector3, c: RifleCtx) {
  const { parts } = c;
  const deliberate = plan.kind === 'empty';
  // bolt open / close windows (normalised)
  const [o0, o1] = deliberate ? [0.02, 0.13] : [0.0, plan.kind === 'clip' ? 0.15 : 0.18];
  const [c0, c1] = deliberate ? [0.72, 0.9] : plan.kind === 'clip' ? [0.74, 0.88] : [0.8, 0.94];
  const lift = kf(t, [[o0, 0], [o0 + (o1 - o0) * 0.4, 1], [c0 + (c1 - c0) * 0.55, 1], [c1, 0]]);
  const draw = kf(t, [[o0 + (o1 - o0) * 0.4, 0], [o1, 1], [c0, 1], [c0 + (c1 - c0) * 0.5, 0]]);
  setBolt(c, lift, draw);
  // right hand: on the knob while it opens / closes, back on the wrist in between
  const rb = Math.max(kf(t, [[o0, 0], [o0 + 0.04, 1], [o1, 1], [o1 + 0.06, 0]]), kf(t, [[c0 - 0.06, 0], [c0, 1], [c1, 1], [c1 + 0.06, 0]]));
  rightOnKnob(c, knobAt(c, lift, draw), rb, lift);
  once(c, 'b1', t, o0 + (o1 - o0) * 0.3, () => c.ev('boltOpen'));
  once(c, 'b2', t, o1 - 0.02, () => { c.ev('boltBack'); c.jolt(0.2, 0.2, 0.3); });
  once(c, 'b3', t, c0 + (c1 - c0) * 0.42, () => { c.ev('boltClose'); if (deliberate) c.jolt(0.8, -0.4, -0.3); });
  once(c, 'b4', t, c1 - 0.01, () => { c.ev('fireMode'); c.jolt(deliberate ? 0.9 : 0.5, -0.3, -0.1); if (deliberate) c.ev('camSeat'); });
  // ---- gun: canted over so the open action faces the left hand, lifted to the chest
  const cant = kf(t, [[0, 0], [o1 * 0.6, 0.42], [c0, 0.42], [c1, 0.1], [1, 0]]);
  rot.z += cant - 0.06 * rb;
  rot.x += kf(t, [[0, 0], [o1 * 0.6, 0.24], [c0, 0.22], [c1, 0.06], [1, 0]]) + (deliberate ? 0.05 * Math.sin(clamp((t - c1) / (1 - c1), 0, 1) * Math.PI) : 0);
  rot.y += 0.55 * cant;
  pos.add(kv(t, [[0, [0, 0, 0]], [o1 * 0.6, [-0.02, -0.06, -0.19]], [c0, [-0.02, -0.058, -0.19]], [c1, [-0.01, -0.04, -0.1]], [1, [0, 0, 0]]]));
  // ---- the rounds the magazine holds (visible through the open action): bottom-up stack
  const showMag = (n: number) => {
    const g = parts.magRounds;
    if (!g) return;
    g.visible = draw > 0.5;
    n = clamp(Math.round(n), 0, 5);
    g.children.forEach((r, i) => (r.visible = i >= 5 - n));
  };
  const work0 = o1 + 0.03, work1 = c0 - 0.03;
  const w = clamp((t - work0) / (work1 - work0), 0, 1);
  if (plan.kind === 'single') {
    // ---- thumb single cartridges in: fetch, line up over the port, press down and forward
    const n = Math.max(1, plan.n);
    const slot = Math.min(n - 1, Math.floor(w * n));
    const u = w * n - slot; // 0..1 within this round
    const loaded = plan.start + slot + (u > 0.72 ? 1 : 0);
    showMag(Math.min(5, loaded));
    const port = P(0.0, KAR.bore + 0.006, 0.006, E(-0.05, 0, 0));
    const above = P(-0.012, KAR.bore + 0.05, 0.03, E(-0.5, 0.15, 0.25));
    const belt = P(-0.2, -0.3, 0.08, E(0.4, 0.6, 0.8));
    const pressed = P(0.0, KAR.bore - 0.007, -0.002, E(0, 0, 0));
    const rp = u < 0.32 ? lerpPose(belt, above, smoothstep(0, 0.32, u)) : u < 0.52 ? lerpPose(above, port, smoothstep(0.32, 0.52, u)) : u < 0.72 ? lerpPose(port, pressed, easeInOutCubic((u - 0.52) / 0.2)) : lerpPose(pressed, belt, smoothstep(0.72, 1, u));
    if (parts.hround) {
      place(parts.hround, rp);
      parts.hround.visible = w > 0 && w < 1 && u > 0.05 && u < 0.72;
    }
    const grip = mul(rp, ROUND_GRIP);
    if (u > 0.72) grip.p.add(new THREE.Vector3(-0.01, 0.02, 0.0).multiplyScalar(smoothstep(0.72, 0.85, u)));
    const blend = kf(t, [[o0, 0], [work0, 1], [work1, 1], [work1 + 0.08, 0]]);
    leftOn(c, grip, blend, u > 0.72 ? POSES.open : POSES.pinch, 0.003);
    for (let i = 0; i < n; i++) {
      once(c, 's' + i, w, (i + 0.6) / n, () => c.ev('insert'));
      once(c, 'p' + i, w, (i + 0.71) / n, () => { c.ev('shellIn'); c.jolt(0.25, -0.15); });
    }
  } else {
    // ---- stripper clip: fetch, drop into the guides, thumb the stack down, pull the empty clip
    const fetchE = 0.24, seatE = 0.34, pressE = 0.72, pullE = 0.88;
    const guide = P(0, KAR.bore + 0.052, KAR.guideU * -1, E(0, 0, 0));
    const lifted = P(-0.03, KAR.bore + 0.11, 0.06, E(-0.4, 0.2, 0.3));
    const belt = P(-0.2, -0.3, 0.08, E(0.6, 0.5, 0.9));
    const gone = P(-0.22, KAR.bore + 0.14, 0.1, E(-0.6, 0.6, 1.2));
    const clipPose = w < fetchE ? lerpPose(belt, lifted, smoothstep(0, fetchE, w)) : w < seatE ? lerpPose(lifted, guide, easeOutBack(clamp((w - fetchE) / (seatE - fetchE), 0, 1))) : w < pressE ? guide : lerpPose(guide, gone, smoothstep(pressE + 0.02, pullE, w));
    const clip = parts.clip;
    const press = smoothstep(seatE + 0.04, pressE - 0.04, w);
    if (clip) {
      place(clip, clipPose);
      clip.visible = w > 0.02 && w < pullE + 0.02;
      // the stack slides down out of the clip; the bottom rounds enter the magazine one by one
      // (topping off: only as many go in as there is room for, the rest stay in the clip)
      const room = plan.kind === 'empty' ? 5 : 5 - plan.start;
      const entered = Math.floor(press * room + 1e-3);
      clip.children.forEach((ch, i) => {
        if (ch.name === 'strip') return;
        const k = i - 1; // 0 = top round in the clip
        ch.position.y = -Math.min(press, room / 5) * 0.048;
        ch.visible = k < 5 - entered;
      });
    }
    const loadedNow = plan.kind === 'empty' ? 5 * press : plan.start + (5 - plan.start) * press;
    showMag(loadedNow);
    // hand: carries the clip in, then the thumb presses on the top round, then pinches the clip out
    let grip: Pose;
    if (w < seatE) grip = mul(clipPose, { p: new THREE.Vector3(-0.009, -0.012, -0.03), q: handFrame(new THREE.Vector3(0.3, -0.5, -1), new THREE.Vector3(1, -0.15, 0)) });
    else if (w < pressE) grip = { p: new THREE.Vector3(-0.006, KAR.bore + 0.054 - press * 0.046, 0.012), q: handFrame(new THREE.Vector3(0.35, -0.6, -0.8), new THREE.Vector3(0.15, -1, 0.1)) };
    else grip = mul(clipPose, { p: new THREE.Vector3(-0.004, 0.006, -0.002), q: handFrame(new THREE.Vector3(0.25, -0.8, -0.5), new THREE.Vector3(0.9, -0.3, 0)) });
    const blend = kf(t, [[o0, 0], [work0, 1], [work1, 1], [work1 + 0.08, 0]]);
    leftOn(c, grip, blend, w < seatE ? POSES.pinch : w < pressE ? POSES.hold : POSES.pinch, 0.004);
    once(c, 'q1', w, seatE - 0.01, () => { c.ev('magTouch'); c.jolt(0.2, -0.1); });
    once(c, 'q2', w, seatE + 0.12, () => c.ev('insert'));
    once(c, 'q3', w, pressE - 0.06, () => { c.ev('magIn'); c.jolt(0.5, -0.3, -0.1); });
    once(c, 'q4', w, pressE + 0.05, () => c.ev('magOut'));
  }
  once(c, 'z0', t, 0.01, () => c.ev('cloth'));
  once(c, 'z1', t, 0.97, () => c.ev('rattle'));
}
