import * as THREE from 'three';
import { FingerPose, POSES } from './Arms';

/**
 * Authored reload clips.
 *
 * Every clip is a set of keyframed tracks in weapon space:
 *   - the support-hand wrist pose (position + orientation) and its finger pose
 *   - the weapon offset (position / euler) on top of the hip pose
 *   - the old and the new magazine: each is either in the gun, attached to the hand
 *     (rigidly, with an authored in-hand transform), dropped, or hidden
 *   - moving parts (charging handle travel, slide travel, bolt lift/draw) and the right hand
 *   - timed events (foley, jolts, bolt release …)
 *
 * Hand keys that touch a magazine are derived from the magazine pose and the in-hand grip
 * (hand = magPose ∘ grip), so a held magazine always sits exactly where the hand is and seats
 * exactly in the magazine well — no drifting, no clipping through the receiver.
 * Positions are interpolated with non-uniform Catmull-Rom (C1 continuous, no robotic stops
 * between keys); keys flagged `stop` come to rest (grabs, seats, presses).
 */

export interface Pose { p: THREE.Vector3; q: THREE.Quaternion }
interface PKey extends Pose { t: number; stop?: boolean }
interface VKey { t: number; v: THREE.Vector3; stop?: boolean }
type MagMode = { t: number; mode: 'gun' | 'hidden' | 'drop' } | { t: number; mode: 'hand'; k: Pose };

const pose = (p: THREE.Vector3, q: THREE.Quaternion): Pose => ({ p: p.clone(), q: q.clone() });
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const E = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
/** a ∘ b (apply b in a's frame) */
export function mul(a: Pose, b: Pose): Pose {
  return { p: b.p.clone().applyQuaternion(a.q).add(a.p), q: a.q.clone().multiply(b.q) };
}
export function inv(a: Pose): Pose {
  const qi = a.q.clone().invert();
  return { p: a.p.clone().negate().applyQuaternion(qi), q: qi };
}
const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Pose => ({ p: V(x, y, z), q: E(rx, ry, rz) });

/** Hand frame from a finger direction and a palm normal (pointing from the palm into the object). */
export function handFrame(fingers: THREE.Vector3, palm: THREE.Vector3) {
  const f = fingers.clone().normalize();
  const n = palm.clone().addScaledVector(f, -palm.dot(f)).normalize();
  const Zh = f.clone().negate(), Yh = n.clone().negate();
  const Xh = new THREE.Vector3().crossVectors(Yh, Zh).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xh, Yh, Zh));
}

// ---------------------------------------------------------------- spline sampling
function tangents<T extends { t: number; stop?: boolean }>(keys: T[], get: (k: T) => number[], i: number): number[] {
  const n = get(keys[i]).length;
  if (keys[i].stop || i === 0 || i === keys.length - 1) return new Array(n).fill(0);
  const a = get(keys[i - 1]), c = get(keys[i + 1]);
  const dt = keys[i + 1].t - keys[i - 1].t;
  return a.map((v, j) => (c[j] - v) / dt);
}
function sampleArr<T extends { t: number; stop?: boolean }>(keys: T[], get: (k: T) => number[], t: number): number[] {
  if (t <= keys[0].t) return get(keys[0]).slice();
  const last = keys[keys.length - 1];
  if (t >= last.t) return get(last).slice();
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[i], k1 = keys[i + 1];
  const h = k1.t - k0.t;
  const u = (t - k0.t) / h;
  const p0 = get(k0), p1 = get(k1);
  const m0 = tangents(keys, get, i), m1 = tangents(keys, get, i + 1);
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return p0.map((v, j) => h00 * v + h10 * h * m0[j] + h01 * p1[j] + h11 * h * m1[j]);
}

class PoseTrack {
  constructor(public keys: PKey[]) {
    // keep quaternions in one hemisphere so component-wise interpolation is the short way round
    for (let i = 1; i < keys.length; i++) if (keys[i].q.dot(keys[i - 1].q) < 0) keys[i].q.set(-keys[i].q.x, -keys[i].q.y, -keys[i].q.z, -keys[i].q.w);
  }
  sample(t: number, out: Pose) {
    const p = sampleArr(this.keys, (k) => [k.p.x, k.p.y, k.p.z], t);
    const q = sampleArr(this.keys, (k) => [k.q.x, k.q.y, k.q.z, k.q.w], t);
    out.p.set(p[0], p[1], p[2]);
    out.q.set(q[0], q[1], q[2], q[3]).normalize();
    return out;
  }
}
class VecTrack {
  constructor(public keys: VKey[]) {}
  sample(t: number, out = new THREE.Vector3()) {
    const v = sampleArr(this.keys, (k) => [k.v.x, k.v.y, k.v.z], t);
    return out.set(v[0], v[1], v[2]);
  }
}
class FingerTrack {
  constructor(public keys: [number, string][]) {}
  sample(t: number): FingerPose {
    const k = this.keys;
    let i = 0;
    while (i < k.length - 1 && t > k[i + 1][0]) i++;
    const a = POSES[k[i][1]], b = POSES[k[Math.min(i + 1, k.length - 1)][1]];
    const t0 = k[i][0], t1 = k[Math.min(i + 1, k.length - 1)][0];
    let u = t1 > t0 ? THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1) : 1;
    u = u * u * (3 - 2 * u);
    const L = (x: number[], y: number[]) => x.map((v, j) => v + (y[j] - v) * u);
    return {
      index: L(a.index, b.index) as [number, number, number],
      middle: L(a.middle, b.middle) as [number, number, number],
      ring: L(a.ring, b.ring) as [number, number, number],
      pinky: L(a.pinky, b.pinky) as [number, number, number],
      thumb: L(a.thumb, b.thumb) as [number, number, number, number],
      spread: (a.spread ?? 0.02) + ((b.spread ?? 0.02) - (a.spread ?? 0.02)) * u,
    };
  }
}

export interface ClipFrame {
  gunP: THREE.Vector3;
  gunR: THREE.Vector3;
  hand: Pose;
  fingers: FingerPose;
  mags: { old: { visible: boolean; pose: Pose | null }; fresh: { visible: boolean; pose: Pose | null } };
  /** extra travel of moving parts */
  charge: number;
  slide: number;
  boltLift: number;
  boltDraw: number;
  /** right hand: 0 = on the grip, 1 = on the bolt knob */
  rightBolt: number;
}

export class ReloadClip {
  hand!: PoseTrack;
  gunP!: VecTrack;
  gunR!: VecTrack;
  fingers!: FingerTrack;
  oldMag: MagMode[] = [{ t: 0, mode: 'gun' }];
  newMag: MagMode[] = [{ t: 0, mode: 'hidden' }];
  charge: VecTrack | null = null; // x = travel (m)
  slide: VecTrack | null = null;
  bolt: VecTrack | null = null; // x = lift (0..1), y = draw (0..1), z = right-hand weight
  events: [number, string][] = [];
  private frame: ClipFrame = {
    gunP: V(), gunR: V(), hand: { p: V(), q: new THREE.Quaternion() }, fingers: POSES.support,
    mags: { old: { visible: true, pose: null }, fresh: { visible: false, pose: null } },
    charge: 0, slide: 0, boltLift: 0, boltDraw: 0, rightBolt: 0,
  };
  constructor(public magHome: Pose) {}

  private magAt(list: MagMode[], t: number, hand: Pose, out: { visible: boolean; pose: Pose | null }) {
    let m = list[0];
    for (const x of list) if (t >= x.t) m = x;
    if (m.mode === 'gun') {
      out.visible = true;
      out.pose = this.magHome;
    } else if (m.mode === 'hand') {
      out.visible = true;
      out.pose = mul(hand, m.k);
    } else {
      out.visible = false;
      out.pose = null;
    }
  }

  sample(t: number): ClipFrame {
    const f = this.frame;
    this.gunP.sample(t, f.gunP);
    this.gunR.sample(t, f.gunR);
    this.hand.sample(t, f.hand);
    f.fingers = this.fingers.sample(t);
    this.magAt(this.oldMag, t, f.hand, f.mags.old);
    this.magAt(this.newMag, t, f.hand, f.mags.fresh);
    f.charge = this.charge ? this.charge.sample(t).x : 0;
    f.slide = this.slide ? this.slide.sample(t).x : 0;
    if (this.bolt) {
      const b = this.bolt.sample(t);
      f.boltLift = b.x;
      f.boltDraw = b.y;
      f.rightBolt = b.z;
    } else f.boltLift = f.boltDraw = f.rightBolt = 0;
    return f;
  }
}

// ---------------------------------------------------------------- per-weapon authoring
export type ReloadKind = 'rifle' | 'pdw' | 'pistol' | 'sniper' | 'dmr' | 'boxsg' | 'scar' | 'ump';

export interface ClipContext {
  kind: ReloadKind;
  empty: boolean;
  /** magazine pose in the gun (weapon space) */
  magHome: Pose;
  /** support-hand wrist pose on the weapon (weapon space) */
  support: Pose;
  /** wrist pose for a palm/fist anchor: point on a surface axis, hand frame, radius */
  wristFor: (anchor: THREE.Vector3, q: THREE.Quaternion, r: number, fist?: boolean) => THREE.Vector3;
}

interface Spec {
  /** in-hand grip on a magazine, in magazine space: anchor on the mag axis, radius */
  magGrip: { a: THREE.Vector3; r: number; fingers: THREE.Vector3; palm: THREE.Vector3 };
  /** direction the magazine leaves the well (magazine space, unit) */
  out: THREE.Vector3;
  pull: number;
  /** AR-style hook: tilt (rad about x) while the front lip catches before rocking home */
  hook: number;
  /** pouch (weapon space) */
  pouch: THREE.Vector3;
  gunTilt: { p: THREE.Vector3; r: THREE.Vector3 };
  /** empty reload: charging handle (weapon space anchor, hand frame, travel) and the roll that presents it */
  charge?: { a: THREE.Vector3; fingers: THREE.Vector3; palm: THREE.Vector3; travel: number; roll: THREE.Vector3; approach: THREE.Vector3 };
}

export const SPECS: Record<ReloadKind, Spec> = {
  rifle: {
    magGrip: { a: V(0, -0.165, -0.027), r: 0.0125, fingers: V(0.2, 0.12, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, 0.06).normalize(),
    pull: 0.11,
    hook: -0.22,
    pouch: V(-0.16, -0.5, 0.14),
    gunTilt: { p: V(-0.07, 0.15, -0.24), r: V(0.3, 0.3, -0.35) },
  },
  pdw: {
    magGrip: { a: V(0, -0.142, 0.0215), r: 0.0105, fingers: V(0.2, 0.1, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, 0.01).normalize(),
    pull: 0.11,
    hook: 0,
    pouch: V(-0.16, -0.52, 0.16),
    gunTilt: { p: V(-0.08, 0.12, -0.28), r: V(0.2, 0.45, -0.5) },
  },
  pistol: {
    magGrip: { a: V(0, -0.1, 0.024), r: 0.0, fingers: V(0.35, 0.1, -0.93), palm: V(0, 1, 0.12) },
    out: V(0, -1, 0.18).normalize(),
    pull: 0.1,
    hook: 0,
    pouch: V(-0.16, -0.42, 0.18),
    gunTilt: { p: V(-0.04, 0.1, -0.06), r: V(0.25, 0.75, 0.35) },
  },
  dmr: {
    // 20-round box: rocked in front-first (catch the front lip, swing the back up until it clicks)
    magGrip: { a: V(0, -0.062, -0.004), r: 0.0145, fingers: V(0.2, 0.12, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, -0.1).normalize(),
    pull: 0.12,
    hook: -0.34,
    pouch: V(-0.16, -0.5, 0.14),
    // long gun with a high scope: kept further out and rolled less, so the stock never sweeps the eye
    gunTilt: { p: V(-0.05, 0.08, -0.3), r: V(0.14, 0.24, -0.3) },
    charge: { a: V(0.033, 0.034, -0.055), fingers: V(0.35, -0.5, -0.8), palm: V(0.75, -0.6, 0.1), travel: 0.03, roll: V(0.04, -0.12, 0.32), approach: V(-0.02, 0.05, -0.02) },
  },
  scar: {
    // STANAG mags as on the rifle; the charging handle is forward on the LEFT of the upper
    magGrip: { a: V(0, -0.165, -0.027), r: 0.0125, fingers: V(0.2, 0.12, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, 0.06).normalize(),
    pull: 0.11,
    hook: -0.22,
    pouch: V(-0.16, -0.5, 0.14),
    gunTilt: { p: V(-0.065, 0.13, -0.24), r: V(0.26, 0.3, -0.34) },
    charge: { a: V(-0.04, 0.05, -0.097), fingers: V(0.1, -0.35, -0.93), palm: V(1, -0.2, 0), travel: 0.07, roll: V(0.03, 0.16, -0.16), approach: V(-0.05, 0.03, -0.03) },
  },
  ump: {
    // straight .45 box: palm on its left face, fingers round the front; it goes in straight up
    magGrip: { a: V(0, -0.1, 0.0), r: 0.0135, fingers: V(0.2, 0.12, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, 0.03).normalize(),
    pull: 0.13,
    hook: -0.06,
    pouch: V(-0.16, -0.5, 0.15),
    gunTilt: { p: V(-0.06, 0.1, -0.22), r: V(0.2, 0.42, -0.5) },
    // charging handle forward on the LEFT of the receiver (knob centre)
    charge: { a: V(-0.042, 0.055, -0.179), fingers: V(0.25, 0.5, -0.83), palm: V(1, 0.15, 0.1), travel: 0.075, roll: V(0.06, 0.08, 0.1), approach: V(-0.03, -0.045, 0.02) },
  },
  boxsg: {
    // 8-round 12 ga box: fat, so the palm sits further out; rocked in front-first like the DMR's,
    // charging handle on the LEFT, so the support hand reaches it without crossing over
    magGrip: { a: V(0, -0.07, 0.0), r: 0.026, fingers: V(0.2, 0.12, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, -0.08).normalize(),
    pull: 0.15,
    hook: -0.26,
    pouch: V(-0.16, -0.5, 0.12),
    gunTilt: { p: V(-0.05, 0.1, -0.26), r: V(0.18, 0.28, -0.36) },
    charge: { a: V(-0.047, 0.053, -0.213), fingers: V(0.1, -0.35, -0.93), palm: V(1, -0.2, 0), travel: 0.05, roll: V(0.02, 0.18, -0.12), approach: V(-0.05, 0.02, -0.02) },
  },
  sniper: {
    magGrip: { a: V(0, -0.058, 0.0), r: 0.015, fingers: V(0.2, 0.1, -0.97), palm: V(1, 0, 0) },
    out: V(0, -1, 0).normalize(),
    pull: 0.09,
    hook: 0,
    pouch: V(-0.16, -0.48, 0.16),
    gunTilt: { p: V(-0.08, 0.11, -0.22), r: V(0.18, 0.35, -0.45) },
  },
};

/** Build the clip for one weapon kind (tactical or empty). Times are normalised 0..1. */
export function buildReloadClip(c: ClipContext): ReloadClip {
  const s = SPECS[c.kind];
  const clip = new ReloadClip(c.magHome);
  const home = c.magHome;
  const gq = handFrame(s.magGrip.fingers, s.magGrip.palm);
  const gp = c.wristFor(s.magGrip.a, gq, s.magGrip.r, false);
  const G: Pose = { p: gp, q: gq }; // hand (wrist) pose in magazine space
  const K = inv(G); // magazine pose in hand space
  /** hand pose that puts the held magazine at magazine pose m */
  const handFor = (m: Pose) => mul(m, G);
  const along = (d: number) => ({ p: s.out.clone().multiplyScalar(d), q: new THREE.Quaternion() });
  const magOut = (d: number, extra: Pose = T(0, 0, 0)) => mul(mul(home, along(d)), extra);
  const pouch = (dx = 0, dy = 0, dz = 0, r = 0): Pose => ({ p: s.pouch.clone().add(V(dx, dy, dz)), q: c.support.q.clone().multiply(E(0.6, 0.2, 0.4 + r)) });
  const S = c.support;
  const below = (dx: number, dy: number, dz: number): Pose => ({ p: S.p.clone().add(V(dx, dy, dz)), q: S.q.clone() });
  const tilt = s.gunTilt;
  const g = (k: number, dp = V(), dr = V()) => ({ p: tilt.p.clone().multiplyScalar(k).add(dp), r: tilt.r.clone().multiplyScalar(k).add(dr) });

  const hk: PKey[] = [];
  const key = (t: number, p: Pose, stop = false) => hk.push({ t, p: p.p.clone(), q: p.q.clone(), stop });
  const gk: { t: number; p: THREE.Vector3; r: THREE.Vector3; stop?: boolean }[] = [];
  const gkey = (t: number, v: { p: THREE.Vector3; r: THREE.Vector3 }, stop = false) => gk.push({ t, p: v.p, r: v.r, stop });
  let fk: [number, string][] = [];
  const ev = (t: number, n: string) => clip.events.push([t, n]);

  // carried old magazine: tucked under the fresh one, pinched by the little fingers, canted back
  const carry: Pose = mul(K, T(-0.004, -(c.kind === 'pdw' ? 0.186 : 0.212), 0.018, 0.42, 0, 0.05));

  const rifleLike = c.kind === 'rifle' || c.kind === 'pdw';
  const hook = s.hook;
  // insertion: approach under the well, (hook the front lip,) rock / push home
  const insert = (t0: number, t1: number) => {
    const dt = t1 - t0;
    key(t0, handFor(magOut(0.09, T(-0.012, 0, 0.006, hook * 1.3))));
    if (hook) {
      key(t0 + dt * 0.55, handFor(magOut(0.014, T(0, 0, -0.004, hook))));
      key(t0 + dt * 0.78, handFor(magOut(0.004, T(0, 0, 0, hook * 0.4))));
    } else key(t0 + dt * 0.6, handFor(magOut(0.028)));
    key(t1, handFor(home), true);
    ev(t0 + dt * 0.55, 'touch');
    ev(t1, 'seat');
  };

  if (!c.empty && rifleLike) {
    // ---------------- tactical, mag-to-mag: pull & keep the old mag, fetch a fresh one, insert, stow the old one
    gkey(0, g(0));
    gkey(0.1, g(1));
    gkey(0.17, g(1, V(0.0, 0.004, 0), V(0.02, 0, -0.03)));
    gkey(0.25, g(1, V(0, 0.012, 0.004), V(0.06, 0, 0.02))); // the gun lifts as the mag is stripped
    gkey(0.34, g(0.88));
    gkey(0.5, g(0.92));
    gkey(0.6, g(1.05, V(0, 0.006, 0), V(0.03, 0, -0.04))); // lean into the insert
    gkey(0.66, g(1, V(0, -0.004, 0.004), V(-0.03, 0, 0.02)));
    gkey(0.78, g(0.95));
    gkey(0.92, g(0.2));
    gkey(1, g(0));
    key(0, S);
    key(0.08, handFor(magOut(0.045, T(-0.03, 0, 0.01))));
    key(0.15, handFor(home), true);
    ev(0.16, 'release');
    key(0.19, handFor(magOut(0.012)));
    key(0.26, handFor(magOut(s.pull, T(0, 0, 0, 0.08))));
    key(0.33, pouch(0.04, 0.12, -0.05));
    key(0.38, pouch(), true);
    ev(0.37, 'pouch');
    key(0.45, handFor(magOut(0.2, T(-0.05, 0, 0.02, hook * 1.5))));
    insert(0.5, 0.64);
    key(0.68, handFor(magOut(-0.004)));
    ev(0.68, 'tap');
    key(0.72, handFor(magOut(0.035, T(-0.025, 0, 0.0))));
    key(0.84, pouch(0.02, 0.05, 0), true);
    ev(0.83, 'pouch');
    key(0.93, below(-0.03, -0.07, 0.04));
    key(1, S);
    clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.15, mode: 'hand', k: K }, { t: 0.355, mode: 'hidden' }, { t: 0.41, mode: 'hand', k: carry }, { t: 0.8, mode: 'hidden' }];
    clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.4, mode: 'hand', k: K }, { t: 0.64, mode: 'gun' }];
    fk = [[0, 'support'], [0.07, 'open'], [0.15, 'hold'], [0.36, 'hold'], [0.42, 'hold'], [0.64, 'hold'], [0.7, 'open'], [0.76, 'hold'], [0.9, 'open'], [1, 'support']];
  } else if (c.empty && rifleLike) {
    // ---------------- empty: mag drops free, fresh mag in, then bolt catch (rifle) / charging handle (PDW)
    gkey(0, g(0));
    gkey(0.08, g(1));
    gkey(0.12, g(1, V(0, 0.008, 0), V(0.04, 0, 0)));
    gkey(0.3, g(0.9));
    gkey(0.44, g(1.05, V(0, 0.006, 0), V(0.03, 0, -0.04)));
    gkey(0.5, g(1, V(0, -0.004, 0.004), V(-0.03, 0, 0.02)));
    key(0, S);
    key(0.06, below(-0.05, -0.09, 0.03));
    ev(0.07, 'drop');
    key(0.16, pouch(0.04, 0.12, -0.04));
    key(0.24, pouch(), true);
    ev(0.23, 'pouch');
    key(0.31, handFor(magOut(0.2, T(-0.05, 0, 0.02, hook * 1.5))));
    insert(0.36, 0.5);
    ev(0.54, 'tap');
    key(0.54, handFor(magOut(-0.004)));
    if (c.kind === 'rifle') {
      // palm the bolt catch on the left of the lower receiver
      // palm the bolt catch (left side, above the magwell): hand comes up from below, presses in
      const catchQ = handFrame(V(0.05, 0.55, -0.83), V(1, 0, 0));
      const at = (press: number) => c.wristFor(V(0, 0.01, -0.048), catchQ, 0.0172 - press, false);
      key(0.58, { p: at(0).add(V(-0.03, -0.035, 0.01)), q: catchQ });
      key(0.63, { p: at(0), q: catchQ }, true);
      key(0.66, { p: at(0.004), q: catchQ }, true);
      ev(0.655, 'boltRelease');
      key(0.72, { p: at(0).add(V(-0.035, -0.04, 0.0)), q: catchQ });
      gkey(0.58, g(0.85, V(0, 0, 0), V(0, 0.12, 0.18)));
      gkey(0.655, g(0.85, V(0, 0.006, 0.004), V(0.04, 0.13, 0.22)));
      gkey(0.75, g(0.6));
      fk = [[0, 'support'], [0.05, 'open'], [0.1, 'open'], [0.24, 'hold'], [0.5, 'hold'], [0.56, 'open'], [0.72, 'open'], [0.9, 'open'], [1, 'support']];
    } else {
      // PDW: thumb the bolt release lever on the left above the grip; the gun rolls to present it
      const relQ = handFrame(V(0.25, 0.35, -0.9), V(1, -0.1, 0.0));
      const rel = (press: number) => c.wristFor(V(0, 0.008, 0.0), relQ, 0.0245 - press, false);
      key(0.58, { p: rel(0).add(V(-0.03, -0.04, 0.02)), q: relQ });
      key(0.63, { p: rel(0), q: relQ }, true);
      key(0.665, { p: rel(0.004), q: relQ }, true);
      ev(0.66, 'boltRelease');
      key(0.72, { p: rel(0).add(V(-0.035, -0.045, 0.01)), q: relQ });
      gkey(0.58, g(0.85, V(0, 0, 0), V(0.0, 0.1, 0.22)));
      gkey(0.66, g(0.85, V(0, 0.006, 0.004), V(0.04, 0.11, 0.26)));
      gkey(0.75, g(0.6));
      fk = [[0, 'support'], [0.05, 'open'], [0.1, 'open'], [0.24, 'hold'], [0.5, 'hold'], [0.56, 'open'], [0.72, 'open'], [0.9, 'open'], [1, 'support']];
    }
    gkey(0.92, g(0.15));
    gkey(1, g(0));
    key(0.9, below(-0.03, -0.06, 0.03));
    key(1, S);
    clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.07, mode: 'hidden' }];
    clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.25, mode: 'hand', k: K }, { t: 0.5, mode: 'gun' }];
  } else if (c.kind === 'pistol') {
    const slideQ = handFrame(V(0.95, -0.05, -0.3), V(0, -1, 0));
    const slideAt = (back: number) => c.wristFor(V(0, 0.034, 0.055 + back), slideQ, 0.017, false);
    if (!c.empty) {
      // retention: thumb drops the mag into the support palm, stow it, fresh mag, palm seat
      gkey(0, g(0));
      gkey(0.12, g(1));
      gkey(0.2, g(1, V(0, 0.006, 0), V(0.05, 0, 0)));
      gkey(0.5, g(1.05));
      gkey(0.6, g(1, V(0, -0.006, 0), V(-0.06, 0, 0)));
      gkey(0.66, g(1, V(0, 0.008, 0), V(0.04, 0, 0)));
      gkey(0.88, g(0.2));
      gkey(1, g(0));
      key(0, S);
      key(0.1, handFor(magOut(0.06)));
      key(0.15, handFor(magOut(0.035)), true);
      ev(0.16, 'release');
      key(0.24, handFor(magOut(s.pull + 0.02)));
      key(0.34, pouch(0.04, 0.1, -0.04));
      key(0.42, pouch(), true);
      ev(0.4, 'pouch');
      key(0.5, handFor(magOut(0.12, T(-0.03, 0, 0))));
      key(0.56, handFor(magOut(0.03)));
      key(0.6, handFor(home), true);
      ev(0.6, 'seat');
      key(0.63, handFor(magOut(0.018)));
      key(0.66, handFor(magOut(-0.004)), true);
      ev(0.66, 'tap');
      key(0.78, below(-0.02, -0.05, 0.02));
      key(1, S);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.15, mode: 'hand', k: K }, { t: 0.395, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.43, mode: 'hand', k: K }, { t: 0.6, mode: 'gun' }];
      fk = [[0, 'support'], [0.08, 'open'], [0.16, 'hold'], [0.4, 'hold'], [0.62, 'open'], [0.66, 'open'], [0.8, 'open'], [1, 'support']];
    } else {
      // empty: mag drops free, fresh mag, overhand slingshot on the slide
      gkey(0, g(0));
      gkey(0.08, g(1));
      gkey(0.3, g(0.95));
      gkey(0.4, g(1.05, V(0, 0.004, 0), V(0.03, 0, 0)));
      gkey(0.46, g(1, V(0, -0.005, 0), V(-0.05, 0, 0)));
      // rack low and pushed out so the overhand arm stays below the line of sight
      gkey(0.54, g(0.6, V(0.02, -0.06, -0.07), V(-0.12, 0.3, -0.35)));
      gkey(0.64, g(0.6, V(0.02, -0.056, -0.064), V(-0.06, 0.33, -0.4)));
      gkey(0.68, g(0.6, V(0.02, -0.064, -0.07), V(-0.14, 0.29, -0.33)));
      gkey(0.86, g(0.15));
      gkey(1, g(0));
      key(0, S);
      key(0.06, below(-0.04, -0.08, 0.04));
      ev(0.06, 'drop');
      key(0.16, pouch(0.04, 0.1, -0.04));
      key(0.24, pouch(), true);
      ev(0.22, 'pouch');
      key(0.34, handFor(magOut(0.12, T(-0.03, 0, 0))));
      key(0.41, handFor(magOut(0.03)));
      key(0.46, handFor(home), true);
      ev(0.46, 'seat');
      key(0.53, { p: slideAt(0).add(V(-0.03, 0.04, 0.02)), q: slideQ });
      key(0.58, { p: slideAt(0), q: slideQ }, true);
      key(0.64, { p: slideAt(0.028), q: slideQ }, true);
      ev(0.6, 'slideBack');
      ev(0.655, 'slideRelease');
      key(0.7, { p: slideAt(0.05).add(V(-0.04, 0.03, 0.02)), q: slideQ });
      key(0.86, below(-0.02, -0.05, 0.02));
      key(1, S);
      clip.slide = new VecTrack([{ t: 0, v: V() }, { t: 0.58, v: V(), stop: true }, { t: 0.64, v: V(0.028), stop: true }, { t: 0.655, v: V() }]);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.06, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.25, mode: 'hand', k: K }, { t: 0.46, mode: 'gun' }];
      fk = [[0, 'support'], [0.05, 'open'], [0.22, 'hold'], [0.46, 'hold'], [0.53, 'open'], [0.58, 'pinch'], [0.64, 'pinch'], [0.7, 'open'], [1, 'support']];
    }
  } else if (c.kind === 'ump') {
    // ---------------- UMS-45 (Striker-style). Tactical and empty are two separately authored
    // performances: the tactical is a calm, confident swap held up in front of you; the empty
    // dumps the mag with a flick, slams the fresh one home and finishes with the charging handle —
    // pulled back, locked up in its notch and slapped down.
    const e = c.empty;
    const ch = s.charge!;
    key(0, S);
    if (!e) {
      gkey(0, g(0));
      gkey(0.12, g(1, V(0, 0.004, 0), V(0.02, 0, -0.02)));
      gkey(0.17, g(1.03, V(0, 0.009, 0.003), V(0.05, 0, 0.02))); // pops up off the release
      gkey(0.26, g(0.95, V(0, 0.002, 0), V(0.01, 0, -0.01)));
      gkey(0.42, g(0.9));
      gkey(0.5, g(1, V(0, 0.004, 0), V(0.03, 0, -0.03))); // lean into the insert
      gkey(0.575, g(1.04, V(0, -0.009, 0.004), V(-0.05, 0, 0.03))); // the push drives it down
      gkey(0.625, g(1, V(0, 0.006, 0), V(0.03, 0, -0.01))); // slap rebound
      gkey(0.72, g(0.82));
      gkey(0.88, g(0.1, V(0, -0.003, 0), V(-0.012, 0, 0.006))); // a touch past rest, then settle
      gkey(1, g(0));
      key(0.07, handFor(magOut(0.035, T(-0.02, 0, 0.012))));
      key(0.13, handFor(home), true);
      ev(0.145, 'release');
      ev(0.15, 'camTap');
      key(0.2, handFor(magOut(0.03, T(0, 0, 0, 0.05))));
      key(0.27, handFor(magOut(s.pull + 0.02, T(-0.01, 0, 0.01, 0.12))));
      key(0.33, pouch(0.04, 0.1, -0.03));
      key(0.38, pouch(), true);
      ev(0.355, 'pouch');
      key(0.45, handFor(magOut(0.14, T(-0.03, 0, 0.02, hook * 2))));
      key(0.5, handFor(magOut(0.055, T(0, 0, 0, hook))));
      key(0.545, handFor(magOut(0.012)));
      key(0.575, handFor(home), true);
      ev(0.52, 'touch');
      ev(0.575, 'seat');
      ev(0.575, 'camSeat');
      key(0.6, handFor(magOut(0.024)));
      key(0.625, handFor(magOut(-0.003)), true);
      ev(0.625, 'tap');
      ev(0.625, 'camTap');
      key(0.7, below(-0.03, -0.06, 0.03));
      key(0.86, S, true);
      key(1, S);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.13, mode: 'hand', k: K }, { t: 0.345, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.37, mode: 'hand', k: K }, { t: 0.575, mode: 'gun' }];
      fk = [[0, 'support'], [0.06, 'open'], [0.13, 'hold'], [0.34, 'hold'], [0.36, 'open'], [0.38, 'hold'], [0.575, 'hold'], [0.6, 'open'], [0.8, 'open'], [0.88, 'support'], [1, 'support']];
    } else {
      gkey(0, g(0));
      gkey(0.06, g(1.1, V(0, 0.006, 0), V(0.0, 0, -0.14))); // the flick that throws the mag out
      gkey(0.1, g(1.05, V(0, 0.012, 0), V(0.06, 0, -0.05)));
      gkey(0.24, g(0.9));
      gkey(0.32, g(1, V(0, 0.004, 0), V(0.03, 0, -0.03)));
      gkey(0.37, g(1.07, V(0, -0.013, 0.006), V(-0.075, 0, 0.045))); // slammed home
      gkey(0.415, g(1, V(0, 0.007, 0), V(0.035, 0, -0.02)));
      // present the left side and bring it in for the charging handle
      const R = ch.roll;
      // muzzle swung right so the left side (and the handle) turns to face you, held low: the arm
      // comes in from the lower left instead of reaching over the top of the gun
      // the handle sits just above where the support hand lives: the gun comes up and in a little,
      // rolls to show its left side, and the hand rises from underneath to pinch the knob
      gkey(0.48, g(0.55, V(0.01, 0.012, 0.02), R));
      gkey(0.545, g(0.55, V(0.012, 0.016, 0.028), R.clone().multiplyScalar(1.1)));
      gkey(0.6, g(0.55, V(0.016, 0.02, 0.05), R.clone().multiplyScalar(1.25))); // follows the pull back
      gkey(0.665, g(0.55, V(0.014, 0.022, 0.044), R.clone().multiplyScalar(1.2)));
      gkey(0.695, g(0.5, V(0.008, -0.004, -0.008), R.clone().add(V(-0.1, 0, 0.03)))); // the slap jolts it down
      gkey(0.74, g(0.42, V(0.006, 0.01, 0.012), R.clone().multiplyScalar(0.8)));
      gkey(0.88, g(0.08, V(0, -0.003, 0), V(-0.01, 0, 0.006)));
      gkey(1, g(0));
      key(0.05, handFor(magOut(0.02, T(-0.03, -0.01, 0.015))));
      ev(0.065, 'drop');
      ev(0.07, 'camDrop');
      key(0.1, below(-0.04, -0.1, 0.04));
      key(0.17, pouch(0.04, 0.12, -0.04));
      key(0.22, pouch(), true);
      ev(0.2, 'pouch');
      key(0.28, handFor(magOut(0.15, T(-0.03, 0, 0.02, hook * 2))));
      key(0.31, handFor(magOut(0.06, T(0, 0, 0, hook))));
      key(0.345, handFor(magOut(0.014)));
      key(0.37, handFor(home), true);
      ev(0.33, 'touch');
      ev(0.37, 'seat');
      ev(0.37, 'camSeatHard');
      key(0.395, handFor(magOut(0.024)));
      key(0.415, handFor(magOut(-0.003)), true);
      ev(0.415, 'tap');
      ev(0.415, 'camTap');
      // charging handle: pinch the knob, pull it fully back, lock it up into the notch, slap it down
      const chQ = handFrame(ch.fingers, ch.palm);
      const at = (back: number, up = 0) => c.wristFor(ch.a.clone().add(V(0, up, back)), chQ, 0.009, false);
      const slapQ = handFrame(V(0.15, -0.25, -0.95), V(0.35, -1, 0));
      const slapAt = (back: number) => c.wristFor(ch.a.clone().add(V(0.004, 0.004, back)), slapQ, 0.012, false);
      key(0.48, { p: at(0).add(ch.approach), q: chQ });
      key(0.535, { p: at(0), q: chQ }, true);
      key(0.6, { p: at(ch.travel), q: chQ }, true);
      key(0.655, { p: at(ch.travel, 0.006), q: chQ }, true);
      key(0.675, { p: slapAt(ch.travel).add(V(-0.006, 0.034, 0.01)), q: slapQ });
      key(0.695, { p: slapAt(ch.travel), q: slapQ }, true);
      key(0.73, { p: slapAt(0.01).add(V(-0.02, -0.035, 0.0)), q: slapQ });
      key(0.86, S, true);
      key(1, S);
      ev(0.53, 'touch');
      ev(0.575, 'chargeBack');
      ev(0.645, 'chargeLock');
      ev(0.695, 'chargeFwd');
      ev(0.695, 'camSlap');
      clip.charge = new VecTrack([{ t: 0, v: V() }, { t: 0.535, v: V(), stop: true }, { t: 0.6, v: V(ch.travel), stop: true }, { t: 0.665, v: V(ch.travel), stop: true }, { t: 0.695, v: V(ch.travel * 0.96) }, { t: 0.712, v: V() }]);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.065, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.21, mode: 'hand', k: K }, { t: 0.37, mode: 'gun' }];
      fk = [[0, 'support'], [0.04, 'open'], [0.21, 'hold'], [0.37, 'hold'], [0.4, 'open'], [0.47, 'open'], [0.53, 'pinch'], [0.66, 'pinch'], [0.675, 'open'], [0.73, 'open'], [0.86, 'support'], [1, 'support']];
    }
  } else if (c.kind === 'scar' && !c.empty) {
    // ---------------- mag-to-mag: the fresh mag is brought straight up beside the seated one and
    // gripped together with it; the old one is released and stripped, the hand slides across and
    // the fresh one goes home in the same motion; the old mag rides out in the fingers to the pouch
    const SIDE: Pose = T(-0.032, -0.004, 0.002); // fresh mag: just left of (and level with) the old one
    const both = (d: number) => mul(mul(home, along(d)), SIDE); // fresh mag pose while holding both
    gkey(0, g(0));
    gkey(0.1, g(0.75));
    gkey(0.3, g(1));
    gkey(0.37, g(1, V(0, -0.004, 0), V(-0.02, 0, 0.02))); // the hand presses the pair: a small dip
    gkey(0.44, g(1.04, V(0, 0.01, 0.004), V(0.05, 0, -0.02))); // the old mag strips: the gun lifts off it
    gkey(0.56, g(1.04, V(0, 0.006, 0), V(0.03, 0, -0.04)));
    gkey(0.63, g(1, V(0, -0.006, 0.004), V(-0.04, 0, 0.03))); // drive the fresh one home
    gkey(0.7, g(0.95));
    gkey(0.9, g(0.2));
    gkey(1, g(0));
    key(0, S);
    key(0.06, below(-0.04, -0.08, 0.04));
    key(0.15, pouch(0.04, 0.12, -0.04));
    key(0.21, pouch(), true);
    ev(0.2, 'pouch');
    // straight up to the seated magazine, fresh mag parallel to it
    key(0.29, handFor(both(0.075)));
    key(0.335, handFor(both(0.012)));
    key(0.37, handFor(both(0)), true);
    ev(0.36, 'touch');
    ev(0.385, 'release');
    // strip both down out of the well in one pull
    key(0.4, handFor(both(0.012)));
    key(0.47, handFor(both(s.pull)));
    // slide across under the well so the fresh one lines up, then up and home
    key(0.52, handFor(magOut(0.06, T(-0.008, 0, 0.004, hook * 1.1))));
    key(0.575, handFor(magOut(0.014, T(0, 0, -0.004, hook))));
    key(0.61, handFor(magOut(0.004, T(0, 0, 0, hook * 0.4))));
    key(0.64, handFor(home), true);
    ev(0.56, 'touch');
    ev(0.64, 'seat');
    key(0.68, handFor(magOut(-0.004)));
    ev(0.68, 'tap');
    key(0.73, handFor(magOut(0.04, T(-0.02, 0, 0.0))));
    key(0.84, pouch(0.02, 0.05, 0), true);
    ev(0.83, 'pouch');
    key(0.93, below(-0.03, -0.07, 0.04));
    key(1, S);
    clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.385, mode: 'hand', k: mul(K, inv(SIDE)) }, { t: 0.825, mode: 'hidden' }];
    clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.205, mode: 'hand', k: K }, { t: 0.64, mode: 'gun' }];
    fk = [[0, 'support'], [0.05, 'open'], [0.2, 'hold'], [0.36, 'hold'], [0.64, 'hold'], [0.7, 'open'], [0.75, 'hold'], [0.9, 'open'], [1, 'support']];
  } else if (c.kind === 'dmr' || c.kind === 'boxsg' || c.kind === 'scar') {
    // ---------------- marksman rifle: box mag rocked in front-first; empty adds the op-rod charge
    const e = c.empty;
    gkey(0, g(0));
    gkey(0.1, g(1));
    key(0, S);
    if (!e) {
      // retention: thumb the release behind the mag, rock it forward and out, stow it, fresh one in
      gkey(0.16, g(1, V(0, 0.004, 0), V(0.03, 0, -0.03)));
      gkey(0.24, g(1, V(0, 0.01, 0.004), V(0.06, 0, 0.02)));
      gkey(0.36, g(0.9));
      gkey(0.6, g(1.05, V(0, 0.006, 0), V(0.03, 0, -0.04)));
      gkey(0.66, g(1, V(0, -0.004, 0.004), V(-0.03, 0, 0.02)));
      gkey(0.9, g(0.2));
      gkey(1, g(0));
      key(0.09, handFor(magOut(0.04, T(-0.03, 0, 0.01))));
      key(0.15, handFor(home), true);
      ev(0.16, 'release');
      key(0.2, handFor(magOut(0.01, T(0, 0, 0, hook * 0.6))));
      key(0.28, handFor(magOut(s.pull, T(0, 0, 0, hook))));
      key(0.37, pouch(0.04, 0.12, -0.05));
      key(0.44, pouch(), true);
      ev(0.42, 'pouch');
      key(0.52, handFor(magOut(0.16, T(-0.04, 0, 0.02, hook * 1.4))));
      insert(0.56, 0.68);
      key(0.71, handFor(magOut(-0.004)));
      ev(0.71, 'tap');
      key(0.78, handFor(magOut(0.04, T(-0.03, 0, 0))));
      key(0.92, below(-0.03, -0.06, 0.03));
      key(1, S);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.15, mode: 'hand', k: K }, { t: 0.43, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.45, mode: 'hand', k: K }, { t: 0.68, mode: 'gun' }];
      fk = [[0, 'support'], [0.07, 'open'], [0.15, 'hold'], [0.68, 'hold'], [0.74, 'open'], [0.9, 'open'], [1, 'support']];
    } else {
      gkey(0.3, g(0.9));
      gkey(0.42, g(1.05, V(0, 0.006, 0), V(0.03, 0, -0.04)));
      gkey(0.48, g(1, V(0, -0.004, 0.004), V(-0.03, 0, 0.02)));
      key(0.06, below(-0.04, -0.08, 0.04));
      ev(0.07, 'drop');
      key(0.16, pouch(0.04, 0.12, -0.04));
      key(0.24, pouch(), true);
      ev(0.23, 'pouch');
      key(0.31, handFor(magOut(0.16, T(-0.04, 0, 0.02, hook * 1.4))));
      insert(0.35, 0.48);
      key(0.51, handFor(magOut(-0.004)));
      ev(0.51, 'tap');
      // over the top to the op-rod handle on the right (locked back): pull it, let it slam home
      const ch = s.charge!;
      const chQ = handFrame(ch.fingers, ch.palm);
      const at = (back: number) => c.wristFor(ch.a.clone().add(V(0, 0, back)), chQ, 0.009, false);
      key(0.57, { p: at(0).add(ch.approach), q: chQ });
      key(0.62, { p: at(0), q: chQ }, true);
      key(0.66, { p: at(ch.travel * 0.4), q: chQ }, true);
      ev(0.63, 'chargeBack');
      ev(0.665, 'chargeFwd');
      key(0.72, { p: at(ch.travel).add(V(-0.03, 0.04, 0.02)), q: chQ });
      // the gun rolls to present the handle's side to the reaching hand
      const R = ch.roll;
      gkey(0.56, g(0.8, V(0, 0, 0), R));
      gkey(0.64, g(0.8, V(0.004, 0.004, 0.006), R.clone().multiplyScalar(1.12)));
      gkey(0.7, g(0.75, V(0, -0.004, -0.004), R.clone().multiplyScalar(0.88)));
      if (c.kind === 'boxsg' || c.kind === 'scar') clip.charge = new VecTrack([{ t: 0, v: V() }, { t: 0.62, v: V(), stop: true }, { t: 0.66, v: V(ch.travel), stop: true }, { t: 0.68, v: V() }]);
      gkey(0.9, g(0.15));
      gkey(1, g(0));
      key(0.9, below(-0.03, -0.06, 0.03));
      key(1, S);
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.07, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.25, mode: 'hand', k: K }, { t: 0.48, mode: 'gun' }];
      fk = [[0, 'support'], [0.05, 'open'], [0.24, 'hold'], [0.48, 'hold'], [0.54, 'open'], [0.6, 'pinch'], [0.67, 'pinch'], [0.74, 'open'], [1, 'support']];
    }
  } else {
    // ---------------- sniper: strip & stow the old box mag, fresh mag, palm it home; empty adds a bolt cycle
    const e = c.empty;
    gkey(0, g(0));
    gkey(0.1, g(1));
    gkey(e ? 0.3 : 0.38, g(0.9));
    gkey(e ? 0.44 : 0.62, g(1.05, V(0, 0.006, 0), V(0.03, 0, -0.03)));
    gkey(e ? 0.5 : 0.68, g(1, V(0, -0.004, 0.003), V(-0.03, 0, 0.02)));
    key(0, S);
    if (!e) {
      key(0.09, handFor(magOut(0.04, T(-0.03, 0, 0.01))));
      key(0.15, handFor(home), true);
      ev(0.16, 'release');
      key(0.2, handFor(magOut(0.012)));
      key(0.28, handFor(magOut(s.pull, T(0, 0, 0, 0.06))));
      key(0.38, pouch(0.04, 0.12, -0.05));
      key(0.46, pouch(), true);
      ev(0.44, 'pouch');
      key(0.54, handFor(magOut(0.14, T(-0.04, 0, 0.02))));
      insert(0.58, 0.7);
      key(0.73, handFor(magOut(-0.004)));
      ev(0.73, 'tap');
      key(0.8, handFor(magOut(0.04, T(-0.03, 0, 0))));
      key(0.92, below(-0.03, -0.06, 0.03));
      key(1, S);
      gkey(0.9, g(0.2));
      gkey(1, g(0));
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.15, mode: 'hand', k: K }, { t: 0.44, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.47, mode: 'hand', k: K }, { t: 0.7, mode: 'gun' }];
      fk = [[0, 'support'], [0.07, 'open'], [0.15, 'hold'], [0.7, 'hold'], [0.76, 'open'], [0.9, 'open'], [1, 'support']];
    } else {
      key(0.06, below(-0.04, -0.08, 0.04));
      ev(0.07, 'drop');
      key(0.16, pouch(0.04, 0.12, -0.04));
      key(0.24, pouch(), true);
      ev(0.23, 'pouch');
      key(0.31, handFor(magOut(0.14, T(-0.04, 0, 0.02))));
      insert(0.36, 0.5);
      key(0.54, handFor(magOut(-0.004)));
      ev(0.54, 'tap');
      key(0.6, below(-0.02, -0.04, 0.02));
      key(0.66, S, true);
      key(1, S);
      // the right hand works the bolt while the support hand holds the forend
      clip.bolt = new VecTrack([
        { t: 0, v: V() }, { t: 0.6, v: V(0, 0, 0) }, { t: 0.66, v: V(0, 0, 1), stop: true },
        { t: 0.7, v: V(1, 0, 1), stop: true }, { t: 0.76, v: V(1, 1, 1), stop: true }, { t: 0.8, v: V(1, 0, 1) },
        { t: 0.84, v: V(0, 0, 1), stop: true }, { t: 0.92, v: V(0, 0, 0) }, { t: 1, v: V() },
      ]);
      ev(0.7, 'boltOpen');
      ev(0.84, 'boltClose');
      gkey(0.62, g(0.6, V(0, 0, 0), V(0, 0.08, 0.16)));
      gkey(0.76, g(0.6, V(0, 0.004, 0.012), V(0.03, 0.1, 0.2)));
      gkey(0.84, g(0.6, V(0, -0.004, 0), V(-0.03, 0.08, 0.14)));
      gkey(0.93, g(0.15));
      gkey(1, g(0));
      clip.oldMag = [{ t: 0, mode: 'gun' }, { t: 0.07, mode: 'hidden' }];
      clip.newMag = [{ t: 0, mode: 'hidden' }, { t: 0.25, mode: 'hand', k: K }, { t: 0.5, mode: 'gun' }];
      fk = [[0, 'support'], [0.05, 'open'], [0.24, 'hold'], [0.5, 'hold'], [0.56, 'open'], [0.66, 'support'], [1, 'support']];
    }
  }
  hk.sort((a, b) => a.t - b.t);
  gk.sort((a, b) => a.t - b.t);
  clip.hand = new PoseTrack(hk);
  clip.gunP = new VecTrack(gk.map((k) => ({ t: k.t, v: k.p, stop: k.stop })));
  clip.gunR = new VecTrack(gk.map((k) => ({ t: k.t, v: k.r, stop: k.stop })));
  clip.fingers = new FingerTrack(fk);
  clip.events.sort((a, b) => a[0] - b[0]);
  void pose;
  return clip;
}
