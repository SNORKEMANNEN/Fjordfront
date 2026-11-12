import * as THREE from 'three';
import { REST } from './SoldierRig';

/**
 * Procedural animation for the soldier. Nothing is keyframed in a file: every frame the pose is
 * computed from what the soldier is doing, so all movement directions, speeds and stances blend
 * continuously (true 8-way — any angle — locomotion instead of a handful of clips).
 *
 * Legs: feet follow gait trajectories (stance: planted, sliding back under the body; swing: lifted
 * and carried forward) along the actual direction of travel, and an analytic two-bone IK turns the
 * foot targets into hip / knee / ankle rotations — the same IK gives the crouch, the crouch-walk
 * and side-steps. Families of poses (upright, prone, slide, dive, ladder) are computed separately
 * and blended per bone, so dropping prone or launching a slide eases between them.
 *
 * Conventions: the model faces +Z, its left is +X, rest rotations are identity. A rotation about +X
 * swings a downward limb backwards; about +Z tilts +Y towards the soldier's right.
 */

export type ActionKind = 'none' | 'reload' | 'throw' | 'melee' | 'knife' | 'switch' | 'bolt' | 'plant' | 'throwL' | 'stim' | 'detonate' | 'place';
/**
 * What is in the hand (Update 31): shown on bots and online players so an incoming grenade reads
 * before it leaves the hand. +32 = a cooking frag (fuse burning).
 */
export const HELD_ITEMS = ['', 'frag', 'sticky', 'flash', 'stun', 'smoke', 'snapshot', 'decoy', 'c4', 'tknife', 'claymore', 'stim', 'detonator', 'trophy'] as const;
export type HeldItem = (typeof HELD_ITEMS)[number];
export function heldCode(item: string, cooking = false) {
  return Math.max(0, HELD_ITEMS.indexOf(item as HeldItem)) | (cooking ? 32 : 0);
}
export type ReloadStyle = 'mag' | 'shell' | 'bolt' | 'break' | 'box' | 'rev' | 'pistol';

export interface AnimState {
  /** world velocity (m/s) */
  vel: THREE.Vector3;
  /** body yaw (direction the hips face), aim yaw / pitch */
  yaw: number;
  aimYaw: number;
  aimPitch: number;
  /** 0 stand, 1 crouch, 2 prone */
  stance: number;
  sprint: boolean;
  tactical: boolean;
  slide: boolean;
  dive: boolean;
  ladder: boolean;
  /** 0..1 while vaulting / mantling, -1 otherwise */
  mantle: number;
  air: boolean;
  /** -1 left .. 1 right */
  lean: number;
  /** weapon ready (engaged / ADS) vs patrol carry */
  ready: boolean;
  action: ActionKind;
  /** 0..1 progress of the action */
  actionT: number;
  reloadStyle: ReloadStyle;
  pistol: boolean;
  /** fidgets allowed (idle, not engaged) */
  calm: boolean;
  /** held equipment code (HELD_ITEMS index, +32 cooking) */
  item: number;
}

export function newAnimState(): AnimState {
  return {
    vel: new THREE.Vector3(), yaw: 0, aimYaw: 0, aimPitch: 0, stance: 0, sprint: false, tactical: false, slide: false, dive: false,
    ladder: false, mantle: -1, air: false, lean: 0, ready: false, action: 'none', actionT: 0, reloadStyle: 'mag', pistol: false, calm: false, item: 0,
  };
}

const BODY = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'] as const;
type BodyBone = (typeof BODY)[number];
const BI: Record<BodyBone, number> = Object.fromEntries(BODY.map((b, i) => [b, i])) as Record<BodyBone, number>;

class Pose {
  q = BODY.map(() => new THREE.Quaternion());
  hip = new THREE.Vector3();
  reset(h: THREE.Vector3) {
    for (const q of this.q) q.identity();
    this.hip.copy(h);
    return this;
  }
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const qe = (x: number, y: number, z: number, out = new THREE.Quaternion()) => out.setFromEuler(_e.set(x, y, z, 'YXZ'));
const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 0 → 1 → 0 bell over [a, b] */
const bell = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI));
/** piecewise: progress of the segment [a, b], smoothed */
const seg = (t: number, a: number, b: number) => sm((t - a) / (b - a));
const vTmp = new THREE.Vector3();
/** smoothed keyframe track of model-space points */
function keyV(t: number, keys: [number, [number, number, number]][], out: THREE.Vector3) {
  if (t <= keys[0][0]) return out.set(...keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      const u = sm((t - t0) / Math.max(1e-6, t1 - t0));
      return out.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    }
  }
  return out.set(...keys[keys.length - 1][1]);
}

export class SoldierAnimator {
  /** gait phase 0..1 (left foot strike at 0) */
  phase = 0;
  /** running clock (tremble / flinch oscillations) */
  time = 0;
  private sw = { upright: 1, prone: 0, slide: 0, dive: 0, ladder: 0 };
  private crouch = 0;
  private lean = 0;
  private speedS = 0;
  private dirS = 0;
  private hipYawS = 0;
  private sprintS = 0;
  private tacS = 0;
  private readyS = 0;
  private airS = 0;
  private turnStep = 0;
  private lastYaw = 0;
  private pendingTurn = 0;
  private ladderPh = 0;
  private fidget = { kind: 0, t: 0, dur: 0, next: 4 };
  private kick = 0;
  private kickV = 0;
  private P = [new Pose(), new Pose(), new Pose()];
  private a = 0.43;
  private b = 0.415;
  /** events raised by actions (mag out, mag in) — consumed by the owner */
  events: string[] = [];
  private lastActionT = 0;

  constructor(private bones: Record<string, THREE.Bone>, private scaleY = 1) {
    this.a = REST.LeftUpLeg.distanceTo(REST.LeftLeg) * scaleY;
    this.b = REST.LeftLeg.distanceTo(REST.LeftFoot) * scaleY;
  }

  /** a shot was fired: the gun and shoulders kick */
  fire(strength = 1) {
    this.kickV = Math.min(30, this.kickV + 9 * strength);
  }

  // ------------------------------------------------------------------ body
  /**
   * Pose the body bones (everything except the arms) for this frame. Returns the smoothed
   * locomotion values the upper body needs.
   */
  body(s: AnimState, dt: number) {
    this.time += dt;
    dt = Math.min(dt, 0.1);
    // ---- smoothed drivers
    const yawWorld = s.yaw + Math.PI;
    const cy = Math.cos(-yawWorld), sy = Math.sin(-yawWorld);
    const lx = s.vel.x * cy + s.vel.z * sy; // model-local velocity (x left, z forward)
    const lz = -s.vel.x * sy + s.vel.z * cy;
    const speed = Math.hypot(lx, lz);
    this.speedS = damp(this.speedS, speed, 10, dt);
    if (speed > 0.25) this.dirS = this.dirS + wrap(Math.atan2(lx, lz) - this.dirS) * (1 - Math.exp(-12 * dt));
    this.crouch = damp(this.crouch, s.stance === 1 ? 1 : 0, 9, dt);
    this.lean = damp(this.lean, s.lean, 10, dt);
    this.sprintS = damp(this.sprintS, s.sprint ? 1 : 0, 6, dt);
    this.tacS = damp(this.tacS, s.tactical ? 1 : 0, 6, dt);
    this.readyS = damp(this.readyS, s.ready ? 1 : 0, 8, dt);
    this.airS = damp(this.airS, s.air && !s.ladder ? 1 : 0, 10, dt);
    const want = { upright: 1, prone: 0, slide: 0, dive: 0, ladder: 0 };
    if (s.ladder) (want.upright = 0), (want.ladder = 1);
    else if (s.dive) (want.upright = 0), (want.dive = 1);
    else if (s.slide) (want.upright = 0), (want.slide = 1);
    else if (s.stance === 2) (want.upright = 0), (want.prone = 1);
    for (const k of Object.keys(want) as (keyof typeof want)[]) this.sw[k] = damp(this.sw[k], want[k], k === 'slide' || k === 'dive' ? 14 : 7, dt);
    // turn in place: a short shuffle when the body rotates while standing still
    const dYaw = wrap(s.yaw - this.lastYaw);
    this.lastYaw = s.yaw;
    if (this.speedS < 0.4) {
      this.pendingTurn += Math.abs(dYaw);
      if (this.pendingTurn > 0.45 && this.turnStep <= 0) {
        this.turnStep = 1;
        this.pendingTurn = 0;
      }
    } else this.pendingTurn = 0;
    // gait phase: cycle length grows with speed (two steps per cycle)
    const sp = this.speedS;
    const run = sm((sp - 2.4) / 2.2);
    const stride = (1.05 + 1.25 * run + 0.5 * this.sprintS) * (1 - 0.35 * this.crouch);
    if (sp > 0.15) this.phase = (this.phase + (sp * dt) / stride) % 1;
    else if (this.turnStep > 0) {
      this.turnStep -= dt * 2.6;
      this.phase = (this.phase + dt * 1.3) % 1;
    } else this.phase = damp(this.phase, Math.round(this.phase * 2) / 2, 6, dt);
    // fidgets
    const f = this.fidget;
    if (s.calm && sp < 0.3 && s.action === 'none') {
      if (f.kind === 0) {
        f.next -= dt;
        if (f.next <= 0) {
          f.kind = 1 + Math.floor(Math.random() * 4);
          f.t = 0;
          f.dur = f.kind === 1 ? 3 : f.kind === 2 ? 2.4 : f.kind === 3 ? 1.6 : 2.2;
        }
      } else {
        f.t += dt;
        if (f.t >= f.dur) {
          f.kind = 0;
          f.next = 5 + Math.random() * 9;
        }
      }
    } else if (f.kind) {
      f.kind = 0;
      f.next = 3 + Math.random() * 5;
    }
    // recoil spring — sub-stepped: far / off-screen soldiers are posed at a few Hz with one big dt,
    // and a stiff spring integrated in one big explicit step gains energy every step (it wobbled,
    // then blew the gun off to infinity)
    const n = Math.min(40, Math.ceil(dt / (1 / 120)));
    const h = dt / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      this.kickV += (-this.kick * 260 - this.kickV * 22) * h;
      this.kick += this.kickV * h;
    }
    if (!Number.isFinite(this.kick) || !Number.isFinite(this.kickV)) this.kick = this.kickV = 0;
    this.kick = Math.max(-1, Math.min(1, this.kick));

    // ---- compute the pose families that matter and blend them
    const w = this.sw;
    const out = this.P[0];
    this.upright(s, out, dt);
    const blendIn = (k: number, fill: (p: Pose) => void) => {
      if (k < 0.01) return;
      const p = this.P[1];
      fill(p);
      for (let i = 0; i < out.q.length; i++) out.q[i].slerp(p.q[i], k);
      out.hip.lerp(p.hip, k);
    };
    const tot = w.upright + w.prone + w.slide + w.dive + w.ladder || 1;
    // sequential slerp with renormalised weights
    let acc = w.upright / tot;
    const mix = (wk: number, fill: (p: Pose) => void) => {
      const k = wk / tot;
      if (k < 0.01) return;
      acc += k;
      blendIn(k / acc, fill);
    };
    mix(w.prone, (p) => this.prone(s, p));
    mix(w.slide, (p) => this.slidePose(s, p));
    mix(w.dive, (p) => this.divePose(s, p));
    mix(w.ladder, (p) => this.ladderPose(s, p, dt));
    // ---- write
    const b = this.bones;
    b.Hips.position.copy(out.hip);
    for (let i = 0; i < BODY.length; i++) b[BODY[i]].quaternion.copy(out.q[i]);
    return { run, sprint: this.sprintS, tac: this.tacS, crouch: this.crouch, prone: w.prone, slide: w.slide, dive: w.dive, ladder: w.ladder, ready: this.readyS, kick: this.kick, fidget: f.kind ? { kind: f.kind, t: f.t / f.dur } : null, ladderPh: this.ladderPh, lean: this.lean };
  }

  /** standing / crouching locomotion with leg IK */
  private upright(s: AnimState, p: Pose, _dt: number) {
    const sp = this.speedS;
    const run = sm((sp - 2.4) / 2.2);
    const c = this.crouch;
    const moving = sm(sp / 0.6);
    // where the hips face: towards the travel direction for diagonals / strafes (feet lead, the
    // upper body keeps aiming), backwards travel keeps the hips facing forward (backpedal)
    let dir = this.dirS;
    const back = Math.abs(dir) > Math.PI * 0.62;
    const legDir = back ? wrap(dir - Math.PI) : dir;
    const hipYawWant = clamp(legDir, -0.75, 0.75) * moving * (1 - this.sprintS * 0.6);
    this.hipYawS = this.hipYawS + (hipYawWant - this.hipYawS) * 0.15;
    const hy = this.hipYawS;
    // stride geometry
    const stepLen = (0.34 + 0.62 * run + 0.25 * this.sprintS) * moving * (1 - 0.3 * c) * (back ? 0.75 : 1);
    const lift = (0.07 + 0.12 * run) * (1 - 0.3 * c);
    const duty = 0.62 - 0.22 * run;
    // pelvis: height, bob, sway, lean
    const ph = this.phase * Math.PI * 2;
    const bob = (run > 0.5 ? -Math.abs(Math.cos(ph)) * 0.05 + 0.025 : Math.abs(Math.cos(ph)) * 0.025 - 0.02) * moving;
    const sway = Math.sin(ph) * 0.018 * moving * (1 - run * 0.5);
    const hipY = REST.Hips.y * this.scaleY - 0.38 * c - 0.03 * run * moving + bob - this.airS * 0.06;
    p.reset(_v.set(sway, hipY, -0.06 * c));
    const fwdLean = (0.06 * run + 0.22 * this.sprintS + 0.28 * c) * (back ? -0.3 : 1) * moving + 0.18 * c * (1 - moving);
    qe(fwdLean * 0.4 + 0.12 * c, hy, Math.sin(ph) * 0.03 * moving, p.q[BI.Hips]);
    // spine: undo the hip yaw (aim stays), lean forward with speed, counter-twist of the stride
    const twist = Math.sin(ph) * 0.07 * moving * (1 + run);
    const leanR = this.lean * 0.15;
    qe(fwdLean * 0.25, -hy * 0.34 - twist, leanR, p.q[BI.Spine]);
    qe(fwdLean * 0.25 - 0.06 * c, -hy * 0.33 + twist * 0.5, leanR, p.q[BI.Spine1]);
    qe(fwdLean * 0.15 - 0.08 * c, -hy * 0.33 + twist * 0.3, leanR, p.q[BI.Spine2]);
    qe(-fwdLean * 0.3, 0, -this.lean * 0.18, p.q[BI.Neck]);
    // fidget: look around / weight shift
    const f = this.fidget;
    if (f.kind === 1) p.q[BI.Neck].multiply(qe(0, Math.sin((f.t / f.dur) * Math.PI * 2) * 0.55 * bell(f.t / f.dur, 0, 1), 0, _q));
    if (f.kind === 2) p.hip.x += Math.sin((f.t / f.dur) * Math.PI) * 0.03;
    // legs: foot targets in hip-yawed space along the travel direction
    const ca = Math.cos(legDir - hy), sa = Math.sin(legDir - hy);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const q = (this.phase + (side > 0 ? 0 : 0.5)) % 1;
      let along: number, up: number, toe = 0;
      if (q < duty) {
        const t = q / duty;
        along = stepLen * (0.5 - t);
        up = 0;
        toe = sm((t - 0.7) / 0.3) * 0.5 * moving;
      } else {
        const t = (q - duty) / (1 - duty);
        along = stepLen * (-0.5 + sm(t));
        up = Math.sin(t * Math.PI) * lift * moving;
        toe = (1 - t) * 0.3 * moving;
      }
      // turn-in-place shuffle
      if (this.turnStep > 0 && sp < 0.4) up = Math.max(up, Math.sin((q < 0.5 ? q * 2 : (q - 0.5) * 2) * Math.PI) * 0.05 * (side > 0 === q < 0.5 ? 1 : 0));
      if (back) along = -along;
      // crouch: knees out a little, feet a touch apart and forward
      const fx = (0.1 + 0.03 * c) * side * this.scaleY + sa * along * 0.85;
      const fz = ca * along + 0.04 * c;
      const air = this.airS;
      const fy = 0.085 + up + air * (side > 0 ? 0.28 : 0.18);
      this.legIK(p, L, side, _v2.set(fx, fy, fz + air * (side > 0 ? 0.12 : -0.05)), toe);
    }
  }

  /**
   * Two-bone leg IK in model space. `target` is the ankle position (model space, before the hip
   * yaw is applied — it is rotated with the pelvis so the feet move with the hips).
   */
  private legIK(p: Pose, L: 'Left' | 'Right', side: number, target: THREE.Vector3, toe: number) {
    const hipQ = p.q[BI.Hips];
    // hip joint in model space: pelvis position + rotated offset
    const off = _v3.copy(REST[`${L}UpLeg` as const]).sub(REST.Hips);
    off.y *= this.scaleY;
    const hipJ = off.applyQuaternion(hipQ).add(p.hip);
    // foot target follows the pelvis yaw
    const yawOnly = _q2.setFromAxisAngle(Y, this.hipYawS);
    const T = target.applyQuaternion(yawOnly);
    const D = _v4.copy(T).sub(hipJ);
    const a = this.a, b = this.b;
    let d = D.length();
    d = clamp(d, Math.abs(a - b) + 0.01, (a + b) * 0.9995);
    D.normalize();
    const cosK = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
    const knee = Math.PI - Math.acos(cosK);
    const cosB = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const beta = Math.acos(cosB);
    // pole: the knee points forward (along the pelvis' facing), slightly outward
    const pole = _v.set(0.12 * side, 0, 1).applyQuaternion(yawOnly);
    const pp = pole.addScaledVector(D, -pole.dot(D)).normalize();
    const u = D.clone().multiplyScalar(Math.cos(beta)).addScaledVector(pp, Math.sin(beta));
    // thigh frame: Y' = -u (up along the bone), Z' = pole ⟂ u, X' = Y' × Z'
    const Yp = u.clone().negate();
    const Zp = pp.clone().addScaledVector(u, -pp.dot(u)).normalize();
    const Xp = new THREE.Vector3().crossVectors(Yp, Zp);
    _m.makeBasis(Xp, Yp, Zp);
    const thighW = _q3.setFromRotationMatrix(_m);
    // local = inverse(parent world) * world   (parent = Hips)
    const thigh = p.q[BI[`${L}UpLeg` as BodyBone]];
    thigh.copy(hipQ).invert().multiply(thighW);
    p.q[BI[`${L}Leg` as BodyBone]].setFromAxisAngle(X, knee);
    // foot flat on the ground in the pelvis' yaw, then the toe-off
    const shinW = _q.copy(thighW).multiply(p.q[BI[`${L}Leg` as BodyBone]]);
    const footW = _q2.copy(yawOnly).multiply(qe(-toe * 0.6, 0, 0, _q3));
    p.q[BI[`${L}Foot` as BodyBone]].copy(shinW.invert()).multiply(footW);
    p.q[BI[`${L}ToeBase` as BodyBone]].setFromAxisAngle(X, -toe * 0.9);
  }

  private prone(s: AnimState, p: Pose) {
    const sp = this.speedS;
    const crawl = sm(sp / 0.5);
    const ph = this.phase * Math.PI * 2;
    p.reset(_v.set(0, 0.17, -0.25));
    // lying on the belly, head forward; the chest lifts on the elbows to aim
    qe(Math.PI / 2 - 0.05, 0, Math.sin(ph) * 0.06 * crawl, p.q[BI.Hips]);
    const lift = clamp(-0.25 - s.aimPitch * 0.6, -0.7, 0.1);
    qe(lift * 0.3, Math.sin(ph) * 0.06 * crawl, 0, p.q[BI.Spine]);
    qe(lift * 0.35, 0, 0, p.q[BI.Spine1]);
    qe(lift * 0.35, 0, 0, p.q[BI.Spine2]);
    qe(-0.75, 0, 0, p.q[BI.Neck]);
    qe(-0.35 - s.aimPitch * 0.3, 0, 0, p.q[BI.Head]);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const k = Math.max(0, Math.sin(ph + (side > 0 ? 0 : Math.PI))) * crawl;
      // crawling: the knee draws up and out along the ground
      qe(-0.1 - k * 0.6, 0, (0.18 + k * 0.7) * side, p.q[BI[`${L}UpLeg` as BodyBone]]);
      qe(0.15 + k * 1.3, 0, 0, p.q[BI[`${L}Leg` as BodyBone]]);
      qe(1.0, 0, 0, p.q[BI[`${L}Foot` as BodyBone]]);
    }
  }

  private slidePose(s: AnimState, p: Pose) {
    p.reset(_v.set(0, 0.42, -0.1));
    qe(-0.25, 0, 0, p.q[BI.Hips]);
    qe(-0.25, 0, 0, p.q[BI.Spine]);
    qe(0.05, 0, 0, p.q[BI.Spine1]);
    qe(0.1, 0, 0, p.q[BI.Spine2]);
    qe(0.25, 0, 0, p.q[BI.Neck]);
    // lead leg out in front, the other folded under
    qe(-1.35, 0, 0.08, p.q[BI.LeftUpLeg]);
    qe(0.2, 0, 0, p.q[BI.LeftLeg]);
    qe(-0.3, 0, 0, p.q[BI.LeftFoot]);
    qe(-0.4, 0, -0.35, p.q[BI.RightUpLeg]);
    qe(2.1, 0, 0, p.q[BI.RightLeg]);
    qe(0.4, 0, 0, p.q[BI.RightFoot]);
    void s;
  }

  private divePose(s: AnimState, p: Pose) {
    p.reset(_v.set(0, 0.7, 0));
    qe(Math.PI / 2 - 0.25, 0, 0, p.q[BI.Hips]);
    qe(-0.15, 0, 0, p.q[BI.Spine1]);
    qe(-0.2, 0, 0, p.q[BI.Spine2]);
    qe(-0.7, 0, 0, p.q[BI.Neck]);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      qe(0.1, 0, 0.12 * side, p.q[BI[`${L}UpLeg` as BodyBone]]);
      qe(side > 0 ? 0.5 : 0.15, 0, 0, p.q[BI[`${L}Leg` as BodyBone]]);
      qe(0.9, 0, 0, p.q[BI[`${L}Foot` as BodyBone]]);
    }
    void s;
  }

  private ladderPose(s: AnimState, p: Pose, dt: number) {
    this.ladderPh = (this.ladderPh + Math.abs(s.vel.y) * dt / 0.9) % 1;
    const ph = this.ladderPh * Math.PI * 2;
    p.reset(_v.set(0, REST.Hips.y * this.scaleY - 0.04, -0.06));
    qe(0.12, 0, 0, p.q[BI.Hips]);
    qe(-0.08, 0, 0, p.q[BI.Spine1]);
    qe(-0.15, 0, 0, p.q[BI.Neck]);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const k = 0.5 + 0.5 * Math.sin(ph + (side > 0 ? 0 : Math.PI));
      qe(-0.25 - k * 0.9, 0, 0.04 * side, p.q[BI[`${L}UpLeg` as BodyBone]]);
      qe(0.3 + k * 1.3, 0, 0, p.q[BI[`${L}Leg` as BodyBone]]);
      qe(-0.1 - k * 0.3, 0, 0, p.q[BI[`${L}Foot` as BodyBone]]);
    }
  }

  // ------------------------------------------------------------------ upper body
  /**
   * Weapon placement and hand targets (model space) for this frame. The caller places the gun,
   * solves the arm IK onto `left` / `right` and orients the hands.
   */
  upper(s: AnimState, k: ReturnType<SoldierAnimator['body']>, out: UpperOut) {
    const t = s.actionT;
    const act = s.action;
    if (act !== 'none' && t < this.lastActionT - 0.5) this.events.length = 0;
    this.lastActionT = t;
    // ---- hold: aim (ready) / patrol / low ready (sprint) / tac sprint (muzzle up, one hand)
    const ready = k.ready;
    out.gunPos.set(0, 0, 0);
    out.gunRot.set(0, 0, 0);
    // patrol carry: muzzle down a little, closer to the body
    const patrol = 1 - ready;
    out.gunPos.y -= 0.07 * patrol;
    out.gunPos.z -= 0.04 * patrol;
    out.gunRot.x -= 0.42 * patrol;
    out.gunRot.y += 0.22 * patrol;
    // low ready while sprinting: across the chest, muzzle down-left
    const lr = k.sprint * (1 - k.tac);
    out.gunPos.y -= 0.08 * lr;
    out.gunPos.x += 0.07 * lr;
    out.gunRot.x -= 0.5 * lr;
    out.gunRot.y += 0.55 * lr;
    out.gunRot.z += 0.35 * lr;
    // tac sprint: muzzle up, held in the right hand, the left arm pumps
    const ts = k.tac;
    out.gunPos.y += 0.04 * ts;
    out.gunPos.z -= 0.12 * ts;
    out.gunRot.x += 1.25 * ts;
    out.gunRot.z -= 0.3 * ts;
    out.leftFree = ts;
    out.rightFree = 0;
    out.leftTarget.set(0, 0, 0);
    out.rightTarget.set(0, 0, 0);
    if (ts > 0.01) {
      const ph = this.phase * Math.PI * 2;
      out.leftTarget.set(0.2, 1.05 + Math.max(0, Math.sin(ph)) * 0.22, 0.05 + Math.sin(ph) * 0.25);
    }
    // gun on the back: ladder, dive (the hands are busy)
    out.slung = Math.max(k.ladder, k.dive * 0.9);
    // recoil
    out.gunPos.z -= k.kick * 0.04;
    out.gunRot.x += k.kick * 0.12;
    // ---- fidgets
    if (k.fidget) {
      const fk = k.fidget.kind, ft = k.fidget.t;
      if (fk === 3) {
        // check the weapon: roll it over and look at it
        const b = bell(ft, 0, 1);
        out.gunRot.z += 0.7 * b;
        out.gunRot.y -= 0.3 * b;
        out.gunPos.y += 0.04 * b;
      } else if (fk === 4) {
        // adjust the helmet / NVG mount with the support hand
        const b = sm(ft / 0.25) * (1 - sm((ft - 0.7) / 0.3));
        out.leftFree = b;
        out.leftTarget.set(0.06, 1.74, 0.12);
        out.gunRot.x -= 0.5 * b;
      }
    }
    // ---- actions
    out.magOut = false;
    out.flinch = 0;
    // C4 out: the clacker stays up in the left fist (counterplay: you can see it coming)
    if (act === 'none' && (s.item & 31) === 12) {
      out.leftFree = Math.max(out.leftFree, 1);
      out.leftTarget.set(0.14, 1.18, 0.32);
    }
    if (act === 'reload') this.reload(s, t, out);
    else if (act === 'throw') {
      // lethal, right hand (same beats as the first-person throw): the gun drops away, hand to the
      // belt, up to the chest where the left hand rips the pin out sideways, arm cocked high behind
      // the head — held there while cooking — then the throw and the follow-through
      const free = sm(t / 0.1) * (1 - sm((t - 0.8) / 0.18));
      out.rightFree = free;
      const P: [number, [number, number, number]][] = [[0, [-0.2, 1.0, 0.15]], [0.12, [-0.2, 0.95, 0.08]], [0.26, [-0.06, 1.25, 0.3]], [0.4, [-0.06, 1.25, 0.3]],
        [0.52, [-0.24, 1.72, -0.14]], [0.6, [-0.12, 1.55, 0.62]], [0.7, [-0.02, 1.15, 0.55]], [1, [-0.2, 1.0, 0.15]]];
      keyV(t, P, out.rightTarget);
      // cooking: the cocked arm trembles
      if (s.item & 32 && t > 0.48 && t < 0.54) {
        out.rightTarget.x += Math.sin(this.time * 47) * 0.01;
        out.rightTarget.y += Math.sin(this.time * 39) * 0.01;
      }
      // the support hand comes over for the pin, then out front for balance
      const lf = sm((t - 0.2) / 0.06) * (1 - sm((t - 0.66) / 0.14));
      out.leftFree = Math.max(out.leftFree, lf);
      const pull = seg(t, 0.3, 0.4);
      out.leftTarget.set(-0.02 + 0.22 * pull, 1.27 + 0.02 * pull, 0.32 + 0.05 * pull);
      if (t > 0.44) out.leftTarget.lerp(vTmp.set(0.12, 1.45, 0.55), sm((t - 0.44) / 0.08));
      out.gunPos.y -= 0.14 * free;
      out.gunPos.x += 0.08 * free;
      out.gunRot.x -= 0.8 * free;
      out.gunRot.z += 0.35 * free;
      const wind = seg(t, 0.4, 0.52), thr = seg(t, 0.52, 0.62);
      out.spineTwist = (-0.4 * wind + 0.75 * thr) * free;
    } else if (act === 'throwL') {
      // tactical, left hand: the gun stays up in the right hand. Vest → chest (pin out with a
      // twist) → cocked high (or low behind the hip for a bowled snapshot / decoy) → throw
      const code = s.item & 31;
      const bowl = code === 6 || code === 7;
      const free = sm(t / 0.1) * (1 - sm((t - 0.8) / 0.18));
      out.leftFree = Math.max(out.leftFree, free);
      const P: [number, [number, number, number]][] = bowl
        ? [[0, [0.2, 1.0, 0.15]], [0.13, [0.2, 0.95, 0.08]], [0.28, [0.08, 1.2, 0.32]], [0.42, [0.08, 1.2, 0.32]], [0.53, [0.3, 0.72, -0.2]], [0.63, [0.12, 0.62, 0.62]], [0.75, [0.15, 0.85, 0.45]], [1, [0.2, 1.0, 0.15]]]
        : [[0, [0.2, 1.0, 0.15]], [0.13, [0.2, 0.95, 0.08]], [0.27, [0.08, 1.28, 0.32]], [0.42, [0.08, 1.28, 0.32]], [0.5, [0.24, 1.7, -0.08]], [0.6, [0.1, 1.5, 0.62]], [0.72, [0.12, 1.2, 0.5]], [1, [0.2, 1.0, 0.15]]];
      keyV(t, P, out.leftTarget);
      if (t > 0.32 && t < 0.42) out.leftTarget.x += Math.sin(seg(t, 0.32, 0.42) * Math.PI) * 0.05;
      out.gunPos.x -= 0.03 * free;
      out.gunRot.z -= 0.15 * free;
      const thr = seg(t, 0.52, 0.62);
      out.spineTwist = (0.25 * seg(t, 0.4, 0.5) - 0.45 * thr) * free;
      if (bowl) out.gunPos.y -= 0.08 * free;
    } else if (act === 'stim') {
      // stim: left hand up to the chest, thumb flicks the cap, a jab down into the thigh and a
      // flinch through the whole body, then the empty injector is flicked away to the side
      const free = sm(t / 0.12) * (1 - sm((t - 0.82) / 0.16));
      out.leftFree = Math.max(out.leftFree, free);
      keyV(t, [[0, [0.2, 1.0, 0.15]], [0.2, [0.12, 1.22, 0.28]], [0.36, [0.12, 1.24, 0.28]], [0.47, [0.16, 1.34, 0.24]], [0.54, [0.17, 0.78, 0.08]], [0.64, [0.17, 0.8, 0.08]],
        [0.72, [0.5, 1.05, 0.2]], [1, [0.2, 1.0, 0.15]]], out.leftTarget);
      const jolt = bell(t, 0.53, 0.75);
      out.gunRot.x += 0.25 * jolt * Math.sin(t * 90);
      out.gunPos.y -= 0.05 * jolt;
      out.spineTwist = 0.18 * jolt * Math.sin(t * 70);
      out.flinch = jolt;
    } else if (act === 'detonate') {
      // the clacker comes up in the left fist, high in front of the chest — readable — the thumb
      // presses, then it drops back down
      const free = sm(t / 0.2) * (1 - sm((t - 0.75) / 0.2));
      out.leftFree = Math.max(out.leftFree, free);
      const press = bell(t, 0.4, 0.52);
      out.leftTarget.set(0.1, 1.45 - 0.04 * press, 0.4);
    } else if (act === 'place') {
      // claymore / charge placement: down on a knee (the owner sets the crouch), the gun swings
      // away, both hands lower it to the ground in front and press it in
      const b = sm(t / 0.15) * (1 - sm((t - 0.75) / 0.2));
      out.leftFree = Math.max(out.leftFree, b);
      out.rightFree = Math.max(out.rightFree, b);
      const down = seg(t, 0.35, 0.58), press = bell(t, 0.55, 0.66);
      out.leftTarget.set(0.12, 1.15 - 0.75 * down - 0.04 * press, 0.35 + 0.15 * down);
      out.rightTarget.set(-0.12, 1.15 - 0.75 * down - 0.04 * press, 0.35 + 0.15 * down);
      out.gunPos.y -= 0.3 * b;
      out.gunPos.x += 0.12 * b;
      out.gunRot.x -= 1.1 * b;
      out.gunRot.z += 0.5 * b;
    } else if (act === 'melee') {
      // rifle butt-stroke
      const b = bell(t, 0.05, 0.75), hit = seg(t, 0.25, 0.42);
      out.gunPos.z += 0.12 * hit * b;
      out.gunPos.y += 0.06 * b;
      out.gunRot.y += 1.1 * b;
      out.gunRot.x -= 0.3 * b;
      out.spineTwist = (0.25 * b - 0.6 * hit) * b;
    } else if (act === 'knife') {
      const free = bell(t, 0, 1);
      out.rightFree = free;
      const stab = seg(t, 0.3, 0.5);
      out.rightTarget.set(-0.1, 1.3 + 0.05 * stab, 0.15 + 0.4 * stab);
      out.gunPos.y -= 0.12 * free;
      out.gunRot.x -= 0.7 * free;
      out.spineTwist = 0.3 * stab * free;
    } else if (act === 'switch') {
      const b = bell(t, 0, 1);
      out.gunPos.y -= 0.25 * b;
      out.gunRot.x -= 1.0 * b;
    } else if (act === 'bolt') this.boltCycle(t, out, 1);
    else if (act === 'plant') {
      const b = bell(t, 0, 1);
      out.leftFree = b;
      out.leftTarget.set(0.05, 0.45, 0.45);
      out.gunPos.y -= 0.1 * b;
    }
  }

  private boltCycle(t: number, out: UpperOut, w: number) {
    // right hand: grip → bolt → up, back, forward, down → grip
    const free = sm(t / 0.15) * (1 - sm((t - 0.85) / 0.15)) * w;
    out.rightFree = Math.max(out.rightFree, free);
    out.rightBolt = free;
    out.boltBack = seg(t, 0.3, 0.45) * (1 - seg(t, 0.55, 0.72));
    out.gunRot.z += 0.15 * free;
  }

  private reload(s: AnimState, t: number, out: UpperOut) {
    const st = s.reloadStyle;
    // the gun cants and comes in a little for every reload
    const hold = sm(t / 0.12) * (1 - sm((t - 0.85) / 0.15));
    out.gunPos.y -= 0.03 * hold;
    out.gunPos.z -= 0.05 * hold;
    out.gunRot.z += (st === 'shell' ? -0.55 : st === 'rev' ? 0.7 : 0.35) * hold;
    out.gunRot.x += (st === 'break' ? -0.5 : 0.12) * hold;
    out.leftReload = hold;
    if (st === 'mag' || st === 'pistol' || st === 'box' || st === 'rev') {
      // grip → magwell (grab) → pouch (stow / take) → magwell (insert, seat) → grip
      out.leftPhase = t < 0.15 ? ['grip', 'well', seg(t, 0, 0.15)] : t < 0.36 ? ['well', 'pouch', seg(t, 0.15, 0.36)] : t < 0.46 ? ['pouch', 'pouch', 0] : t < 0.66 ? ['pouch', 'well', seg(t, 0.46, 0.66)] : t < 0.76 ? ['well', 'well', 0] : ['well', 'grip', seg(t, 0.76, 0.95)];
      if (t > 0.2 && !this.events.includes('magOut')) this.events.push('magOut');
      if (st === 'box') out.gunPos.y -= 0.06 * hold;
    } else if (st === 'shell' || st === 'break') {
      // shells one at a time: pouch → port, repeated
      const n = st === 'break' ? 2 : 4;
      const u = clamp((t - 0.1) / 0.75, 0, 1) * n;
      const i = Math.min(n - 1, Math.floor(u)), f = u - i;
      out.leftPhase = t < 0.1 ? ['grip', 'pouch', seg(t, 0, 0.1)] : t > 0.85 ? ['port', 'grip', seg(t, 0.85, 1)] : f < 0.5 ? ['pouch', 'port', sm(f * 2)] : ['port', 'pouch', sm((f - 0.5) * 2)];
      void i;
    } else if (st === 'bolt') {
      this.boltCycle(clamp(t / 0.3, 0, 1) * 0.5 + (t > 0.7 ? (t - 0.7) / 0.6 : 0), out, 1);
      out.leftPhase = t < 0.3 || t > 0.8 ? ['grip', 'grip', 0] : t < 0.45 ? ['grip', 'pouch', seg(t, 0.3, 0.45)] : t < 0.65 ? ['pouch', 'port', seg(t, 0.45, 0.65)] : ['port', 'grip', seg(t, 0.65, 0.8)];
    }
  }
}

export interface UpperOut {
  /** gun offset (aim frame: x right, y up, z forward) and rotation (x pitch up, y yaw left, z roll right) */
  gunPos: THREE.Vector3;
  gunRot: THREE.Vector3;
  leftFree: number;
  rightFree: number;
  /** free-hand targets in model space */
  leftTarget: THREE.Vector3;
  rightTarget: THREE.Vector3;
  slung: number;
  spineTwist: number;
  leftReload: number;
  leftPhase: [string, string, number];
  rightBolt: number;
  boltBack: number;
  magOut: boolean;
  /** 0..1 whole-body flinch (stim jab) */
  flinch: number;
}

export function newUpperOut(): UpperOut {
  return { gunPos: new THREE.Vector3(), gunRot: new THREE.Vector3(), leftFree: 0, rightFree: 0, leftTarget: new THREE.Vector3(), rightTarget: new THREE.Vector3(), slung: 0, spineTwist: 0, leftReload: 0, leftPhase: ['grip', 'grip', 0], rightBolt: 0, boltBack: 0, magOut: false, flinch: 0 };
}
