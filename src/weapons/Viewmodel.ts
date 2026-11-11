import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as THREE from 'three';
import { Arm, POSES, FingerPose } from './Arms';
import { RiggedArms } from './RiggedArms';
import { ReloadClip, ReloadKind, buildReloadClip, SPECS } from './ReloadClips';
import { breakAction, BreakData } from './BreakAction';
import { lmgReload } from './LmgAnim';
import { sd9Reload, mp18Reload, AnimCtx } from './SmgAnims';
import { knifeAction, knifeCarry } from './KnifeAnim';
import { WeaponModel } from './WeaponModels';
import { WeaponDef } from './WeaponDefs';
import { newRevState, revolverAction, revolverIdle, revolverLate, revolverReset, revolverShot } from './RevolverAnim';
import { EQUIP_BUILDERS, setLed } from './EquipmentModels';
import { Spring3, Spring, clamp, damp, smoothstep, lerp, easeInOutCubic, easeOutCubic, easeOutBack } from '../core/math';

/** Keyframes: [t, value] pairs (t normalized 0..1), smooth cubic interpolation. */
type K = [number, number][];
/** Vector keyframes (smooth between keys). */
function kv(t: number, keys: [number, [number, number, number]][], out = new THREE.Vector3()) {
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
type V3 = [number, number, number];
interface InspectSpec {
  pos: [number, V3][];
  rot: [number, V3][];
  extra?: (t: number, parts: Record<string, THREE.Object3D | undefined | null>, vm: any, h: any, magWell: THREE.Vector3) => void;
}
/**
 * Inspect choreography per weapon class (position / rotation keys in weapon space, t = 0..1).
 *  rifle   — tip it to show the right side and the rail, roll over to the ejection port, raise to
 *            eye the optic, a mag tap to finish
 *  SMG     — quick flick and spin onto its side, underside look, snap back
 *  pistol  — roll right, roll left, press-check the slide
 *  shotgun — show the receiver, tilt to the loading port, half-rack the pump
 *  sniper  — raise and look along the scope, show the bolt side, flick the bolt handle
 */
const INSPECT: Record<string, InspectSpec> = {
  'Assault Rifle': {
    pos: [[0, [0, 0, 0]], [0.12, [-0.07, 0.05, -0.08]], [0.38, [-0.075, 0.055, -0.085]], [0.5, [-0.03, 0.07, -0.05]], [0.72, [-0.03, 0.075, -0.05]], [0.84, [-0.05, 0.035, -0.07]], [0.92, [-0.04, 0.03, -0.06]], [1, [0, 0, 0]]],
    rot: [[0, [0, 0, 0]], [0.12, [0.15, 0.8, -0.5]], [0.38, [0.2, 0.86, -0.56]], [0.5, [0.1, -0.3, 0.62]], [0.72, [0.05, -0.36, 0.68]], [0.84, [0.32, 0.18, 0.08]], [0.92, [0.3, 0.16, 0.06]], [1, [0, 0, 0]]],
    extra: (t, parts, vm) => {
      if (parts.mag) parts.mag.position.y = vm.magHome.y - 0.006 * win(t, 0.9, 0.93) * (1 - win(t, 0.93, 0.97));
      if (t > 0.905 && t < 0.915) vm.onEvent('magTap');
    },
  },
  SMG: {
    pos: [[0, [0, 0, 0]], [0.1, [-0.05, 0.06, -0.06]], [0.32, [-0.06, 0.065, -0.07]], [0.42, [-0.04, 0.08, -0.05]], [0.62, [-0.04, 0.085, -0.05]], [0.75, [-0.02, 0.03, -0.09]], [0.86, [-0.02, 0.03, -0.09]], [1, [0, 0, 0]]],
    rot: [[0, [0, 0, 0]], [0.1, [0.1, 0.9, -0.4]], [0.32, [0.15, 0.95, -0.45]], [0.42, [0.2, -0.2, 1.25]], [0.62, [0.25, -0.25, 1.3]], [0.75, [0.55, 0.1, -0.15]], [0.86, [0.5, 0.1, -0.12]], [1, [0, 0, 0]]],
  },
  Pistol: {
    pos: [[0, [0, 0, 0]], [0.12, [-0.06, 0.07, -0.04]], [0.36, [-0.065, 0.07, -0.045]], [0.48, [-0.05, 0.08, -0.04]], [0.66, [-0.05, 0.08, -0.04]], [0.76, [-0.04, 0.05, -0.05]], [0.9, [-0.04, 0.05, -0.05]], [1, [0, 0, 0]]],
    rot: [[0, [0, 0, 0]], [0.12, [0.1, 0.7, -0.95]], [0.36, [0.12, 0.75, -1.0]], [0.48, [0.05, -0.45, 1.05]], [0.66, [0.05, -0.5, 1.1]], [0.76, [0.1, 0.3, -0.35]], [0.9, [0.1, 0.3, -0.35]], [1, [0, 0, 0]]],
    extra: (t, parts, vm) => {
      // press-check: ease the slide back a few millimetres to see brass, let it go
      const pc = kf(t, [[0.76, 0], [0.8, 1], [0.86, 1], [0.89, 0]]);
      if (parts.slide) parts.slide.position.z = vm.slideHome.z + 0.012 * pc;
      if (t > 0.765 && t < 0.775) vm.onEvent('slideBack');
      if (t > 0.885 && t < 0.895) vm.onEvent('slideRelease');
    },
  },
  Shotgun: {
    pos: [[0, [0, 0, 0]], [0.14, [-0.06, 0.05, -0.07]], [0.4, [-0.065, 0.055, -0.075]], [0.52, [-0.03, 0.06, -0.05]], [0.74, [-0.03, 0.065, -0.05]], [0.88, [-0.02, 0.02, -0.03]], [1, [0, 0, 0]]],
    rot: [[0, [0, 0, 0]], [0.14, [0.1, 0.7, -0.45]], [0.4, [0.12, 0.75, -0.5]], [0.52, [0.15, -0.2, -1.0]], [0.74, [0.18, -0.25, -1.05]], [0.88, [0.05, 0.05, 0.1]], [1, [0, 0, 0]]],
    extra: (t, parts, vm) => {
      const back = kf(t, [[0.82, 0], [0.88, 1], [0.94, 0]]);
      if (parts.pump) parts.pump.position.z = vm.pumpHome.z + 0.03 * back;
      if (t > 0.82 && t < 0.83) vm.onEvent('pumpBack');
      if (t > 0.93 && t < 0.94) vm.onEvent('pumpForward');
    },
  },
  Sniper: {
    pos: [[0, [0, 0, 0]], [0.16, [-0.04, 0.09, -0.04]], [0.42, [-0.045, 0.095, -0.045]], [0.54, [-0.06, 0.05, -0.08]], [0.76, [-0.065, 0.05, -0.085]], [0.88, [-0.03, 0.02, -0.03]], [1, [0, 0, 0]]],
    rot: [[0, [0, 0, 0]], [0.16, [0.45, 0.25, 0.05]], [0.42, [0.48, 0.28, 0.06]], [0.54, [0.1, 0.75, -0.5]], [0.76, [0.12, 0.8, -0.55]], [0.88, [0.05, 0.1, 0.15]], [1, [0, 0, 0]]],
    extra: (t, parts, vm) => {
      const lift = kf(t, [[0.78, 0], [0.83, 1], [0.88, 1], [0.92, 0]]);
      if (parts.bolt) parts.bolt.rotation.z = lift * 0.9;
      if (t > 0.78 && t < 0.79) vm.onEvent('boltOpen');
      if (t > 0.915 && t < 0.925) vm.onEvent('boltClose');
    },
  },
};

/** Hand orientation from a finger direction and the palm normal (palm → held object). */
function handQ(f: THREE.Vector3, n: THREE.Vector3) {
  f = f.clone().normalize();
  n = n.clone().addScaledVector(f, -n.dot(f)).normalize();
  const Zh = f.clone().negate(), Yh = n.clone().negate();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(Yh, Zh), Yh, Zh));
}

function kf(t: number, keys: K): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * easeInOutCubic(u);
    }
  }
  return keys[keys.length - 1][1];
}
const win = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

// ---- contact surfaces for the finger wrap (world-space signed distance functions) ----
/** A grip socket: a cylinder along the hand frame's X axis through the socket, radius userData.r. */
function gripSDF(sock: THREE.Object3D) {
  sock.updateMatrixWorld(true);
  const c = sock.getWorldPosition(new THREE.Vector3());
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(sock.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const r = (sock.userData.r as number | undefined) ?? 0.016;
  const d = new THREE.Vector3();
  return (p: THREE.Vector3) => {
    d.subVectors(p, c);
    d.addScaledVector(ax, -d.dot(ax));
    return d.length() - r;
  };
}
function sphereSDF(c: THREE.Vector3, r: number) {
  return (p: THREE.Vector3) => p.distanceTo(c) - r;
}
/** Capped cylinder along the object's local Y axis. */
function cylSDF(m: THREE.Matrix4, r: number, halfH: number, off = new THREE.Vector3()) {
  const inv = m.clone().invert();
  const q = new THREE.Vector3();
  return (p: THREE.Vector3) => {
    q.copy(p).applyMatrix4(inv).sub(off);
    const dx = Math.hypot(q.x, q.z) - r, dy = Math.abs(q.y) - halfH;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  };
}
function boxSDF(m: THREE.Matrix4, centre: THREE.Vector3, half: THREE.Vector3) {
  const inv = m.clone().invert();
  const q = new THREE.Vector3();
  return (p: THREE.Vector3) => {
    q.copy(p).applyMatrix4(inv).sub(centre);
    const x = Math.abs(q.x) - half.x, y = Math.abs(q.y) - half.y, z = Math.abs(q.z) - half.z;
    return Math.hypot(Math.max(x, 0), Math.max(y, 0), Math.max(z, 0)) + Math.min(Math.max(x, y, z), 0);
  };
}
/** Bounding box of an object's meshes in its own local space. */
const MAG_BOX = new WeakMap<THREE.Object3D, THREE.Box3>();
function localBox(o: THREE.Object3D) {
  const box = new THREE.Box3();
  o.updateMatrixWorld(true);
  const inv = o.matrixWorld.clone().invert();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    box.union(b);
  });
  return box;
}

export type ActionType = 'reload' | 'reloadEmpty' | 'inspect' | 'inspectMag' | 'draw' | 'holster' | 'pump' | 'bolt' | 'shellStart' | 'shell' | 'shellEnd' | 'melee' | 'throw' | 'stim' | 'uav' | 'designate' | 'nvg' | 'breakReload' | 'knifeSlash' | 'knifeStab' | 'knifeKill'
  | 'claymore' | 'c4Throw' | 'detonate' | 'stickyThrow' | 'snapshotThrow' | 'decoyThrow' | 'trophy';

export interface Action {
  type: ActionType;
  t: number; // 0..1
  dur: number;
  events: [number, string][];
  fired: Set<number>;
  onDone?: () => void;
  data?: any;
}

/** Things the viewmodel needs each frame from the player. */
export interface VMContext {
  ads: number;
  sprint: number;
  tactical: number;
  slide: number;
  crouch: number;
  air: number;
  speed01: number;
  stepPhase: number;
  foot: number;
  lookDX: number;
  lookDY: number;
  strafe: number;
  vy: number;
  indoor: number;
  firing: boolean;
  /** 0..1 on a ladder, with the climbed height driving the hand-over-hand cycle */
  ladder?: number;
  climb?: number;
  /** mantle progress 0..1 (-1 when not mantling) */
  mantle?: number;
  vault?: boolean;
  /** 0..1 night-vision laser aim: ADS cants the gun over and aims with the IR laser */
  cant?: number;
  /** -1..1 door peek: leaning round a door edge while aiming (sign = lean direction) */
  peek?: number;
  /** -1..1 Q/E lean (the view rolls with it; the gun counter-settles so the sights stay put) */
  lean?: number;
}

/** Hand orientation (camera space) while holding the UAV tablet: fingers right and a little up, palm to the camera. */
const PHONE_HAND = handQ(new THREE.Vector3(1, 0.1, -0.08), new THREE.Vector3(-0.05, 0.22, 1));

export class Viewmodel {
  root = new THREE.Group(); // in camera space
  weaponPivot = new THREE.Group();
  right: Arm;
  left: Arm;
  model: WeaponModel | null = null;
  def: WeaponDef | null = null;
  action: Action | null = null;
  onEvent: (name: string) => void = () => {};

  private swayP = new Spring3(90, 11);
  private swayR = new Spring3(110, 12);
  private recoilP = new Spring3(900, 38);
  private recoilR = new Spring3(820, 34);
  private driftP = new Spring3(70, 15);
  private driftR = new Spring3(60, 14);
  private land = new Spring(150, 12);
  private t = 0;
  private bobP = new THREE.Vector3();
  private bobR = new THREE.Vector3();
  private shoulderR = new THREE.Vector3(0.17, -0.25, 0.1);
  private shoulderL = new THREE.Vector3(-0.21, -0.29, 0.07);
  private magHome = new THREE.Vector3();
  private magHomeQ = new THREE.Quaternion();
  private magParent: THREE.Object3D | null = null;
  private boltHome = new THREE.Vector3();
  private slideHome = new THREE.Vector3();
  private chargeHome = new THREE.Vector3();
  private pumpHome = new THREE.Vector3();
  boltLocked = false;
  /** 0..1 recoil-driven extras */
  private boltCycle = 0;
  muzzleFlashT = 0;
  lighting: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  flashLight: THREE.PointLight;
  private leftPoseBlend = 0;
  rig: RiggedArms | null = null;
  sprayShake = 0;
  /** 0..1 key-light strength from the environment (moonlight at night) */
  daylight = 1;
  private shake = 0;
  private lastKickT = -1;
  private settled = true;
  private tacArm = 0;
  /** finger pose table (exposed for tuning tools) */
  poses = POSES;
  private cantBlend = 0;
  private peekBlend = 0;
  private animMem: AnimCtx['mem'] = {};
  /** MP-18 folding stock: flicks out round to the right when you aim, folds back at the hip */
  private stockBlend = 0;
  private stockOut = false;
  private stockSpring = new Spring(260, 16);
  /** LMG bipod: target set by the weapon system (0 folded, 1 deployed); bipodBlend animates */
  bipod = 0;
  private bipodBlend = 0;
  private bipodSettle = new Spring(160, 11);
  private leanBlend = 0;
  /** lean swing: the gun lags the body as it swings out and overshoots a touch on arrival */
  private leanSwing = new Spring(150, 13);
  leanKick(dir: number) {
    this.leanSwing.impulse(dir * 0.9);
  }
  /** authored pose offsets (exposed for live tuning) */
  pose = {
    hipR: [0.025, 0.14, -0.07],
    tacP: [0.035, 0.03, 0.02], tacR: [1.0, 0.55, -0.55],
    tacPistolP: [0.015, -0.06, 0.05], tacPistolR: [0.95, 0.25, -0.35],
    slideP: [-0.045, 0.01, 0.0], slideR: [0.0, 0.2, 0.62],
  };

  constructor(vmScene: THREE.Scene, mats: { sleeve: THREE.Material; glove: THREE.Material; gloveSide: THREE.Material }) {
    this.right = new Arm(mats.sleeve, mats.glove, mats.gloveSide, false);
    this.left = new Arm(mats.sleeve, mats.glove, mats.gloveSide, true);
    this.root.add(this.weaponPivot, this.right.root, this.left.root);
    vmScene.add(this.root);
    this.lighting = new THREE.DirectionalLight(0xfff0dd, 2.5);
    this.lighting.position.set(-0.4, 1, 0.3);
    this.ambient = new THREE.HemisphereLight(0xc8d4e0, 0x3a3830, 0.5);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 2.5, 2);
    vmScene.add(this.lighting, this.ambient, this.flashLight);
    for (const k of ['frag', 'flash', 'stun', 'smoke'] as const) this.items[k] = Viewmodel.makeGrenade(k);
    this.items.stim = Viewmodel.makeInjector();
    this.items.phone = Viewmodel.makePhone();
    this.items.laser = Viewmodel.makeDesignator();
    for (const [k, build] of Object.entries(EQUIP_BUILDERS)) this.items[k] = build();
    this.items.claymore.userData.twoHand = true;
    this.items.trophy.userData.twoHand = true;
    for (const it of Object.values(this.items)) {
      it.visible = false;
      this.root.add(it);
    }
    this.grenade = this.items.frag;
    this.goggles = Viewmodel.makeGoggles();
    this.goggles.visible = false;
    this.root.add(this.goggles);
  }

  /** Night-vision goggles (camera space) — only drawn while the hand flips them up / down. */
  goggles: THREE.Group;
  /** hinge above the brow and the swing from the hinge down to the eyepieces */
  private static GOG_HINGE = new THREE.Vector3(0, 0.105, -0.17);
  private static GOG_ARM = new THREE.Vector3(0, -0.105, 0);
  /** where the support hand takes hold of the goggles (left housing, goggle space) */
  private static GOG_GRIP = new THREE.Vector3(-0.062, 0.006, 0.004);
  /** `a` = hinge angle (0 = down over the eyes), `near` 0..1 = pulled in onto the face */
  private gogglePose(a: number, near = 0) {
    const g = this.goggles;
    g.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    g.position.copy(Viewmodel.GOG_ARM).applyQuaternion(g.quaternion).add(Viewmodel.GOG_HINGE);
    g.position.z += near * 0.105;
    g.position.y -= near * 0.004;
    g.updateMatrix();
    return Viewmodel.GOG_GRIP.clone().applyMatrix4(g.matrix);
  }

  /** Generic dual-tube night-vision goggle on a flip-up mount arm. Tubes look down -Z. */
  static makeGoggles() {
    const g = new THREE.Group();
    g.name = 'goggles';
    const body = new THREE.MeshStandardMaterial({ color: 0x2a2d2b, roughness: 0.62, metalness: 0.15 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x111312, roughness: 0.95 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x3b3f40, roughness: 0.4, metalness: 0.8 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x0a1a12, roughness: 0.05, metalness: 0.9, emissive: new THREE.Color(0x0a3018), emissiveIntensity: 0.6 });
    const ipd = 0.032;
    for (const sx of [-1, 1]) {
      const x = sx * ipd;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.0175, 0.0165, 0.07, 24, 1, true).rotateX(Math.PI / 2), body);
      tube.position.set(x, 0, -0.008);
      g.add(tube);
      // ribbed focus ring + objective bell
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0195, 0.0195, 0.014, 24).rotateX(Math.PI / 2), rubber);
      ring.position.set(x, 0, -0.038);
      g.add(ring);
      const obj = new THREE.Mesh(new THREE.CircleGeometry(0.0155, 24), lens);
      obj.position.set(x, 0, -0.0452);
      obj.rotation.y = Math.PI;
      g.add(obj);
      // eyecup facing the wearer
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.0205, 0.017, 0.016, 24, 1, true).rotateX(Math.PI / 2), rubber);
      cup.position.set(x, 0, 0.034);
      g.add(cup);
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.0145, 24), lens);
      eye.position.set(x, 0, 0.0295);
      g.add(eye);
    }
    // bridge housing (battery + power knob) and the mount arm up to the hinge
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.026, 0.05), body);
    bridge.position.set(0, 0.004, -0.004);
    g.add(bridge);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.008, 14), metal);
    knob.position.set(0, 0.021, 0.002);
    g.add(knob);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.09, 0.012), metal);
    arm.position.set(0, 0.06, 0.004);
    g.add(arm);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 14).rotateZ(Math.PI / 2), metal);
    hinge.position.set(0, 0.1, 0.004);
    g.add(hinge);
    // side grip pads the support hand uses
    for (const sx of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.022, 0.04), rubber);
      pad.position.set(sx * (ipd + 0.0195), 0.002, -0.006);
      g.add(pad);
    }
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = false;
    });
    return g;
  }

  /** Items the support hand can hold (grenades, stim, UAV phone, laser designator). */
  items: Record<string, THREE.Group> = {};
  /** the held item currently in play; set by the action that uses it */
  grenade: THREE.Group;
  /** palm offset (local) and orientation fix per held item */
  private static HOLD: Record<string, { off: number; e: [number, number, number]; q?: THREE.Quaternion; p?: THREE.Vector3 }> = {
    // throwing knife pinched by the handle, blade pointing forward past the fingertips
    tknife: { off: 0.008, e: [0, Math.PI, 0.2], p: new THREE.Vector3(0, 0, -0.02) },
    frag: { off: 0.02, e: [Math.PI / 2, 0, 0.3] }, flash: { off: 0.02, e: [Math.PI / 2, 0, 0.3] }, stun: { off: 0.02, e: [Math.PI / 2, 0, 0.3] }, smoke: { off: 0.022, e: [Math.PI / 2, 0, 0.3] },
    // autoinjector in a fist, plunger end up past the thumb
    stim: { off: 0.015, e: [0, 0, Math.PI / 2], p: new THREE.Vector3(-0.012, 0, 0.022) },
    // rugged UAV tablet cradled from behind: palm on the back of its lower-left quarter, fingers
    // across the back and round the right edge, thumb by the LAUNCH button (see PHONE_HAND)
    phone: Viewmodel.phoneHold(),
    // designator rests across the palm (palm up), lens forward, held like a flashlight
    // C4 brick lying along the palm, receiver on top; the detonator in a fist, button up past the thumb
    c4: { off: 0.017, e: [0, Math.PI / 2, 0] },
    detonator: { off: 0.016, e: [0, 0, -Math.PI / 2], p: new THREE.Vector3(0.004, 0, 0.026) },
    // sticky: cupped like a canister; snapshot puck flat in the palm, cap out; decoy like a smoke can
    sticky: { off: 0.022, e: [Math.PI / 2, 0, 0.3] }, snapshot: { off: 0.025, e: [Math.PI, 0, 0] }, decoy: { off: 0.021, e: [Math.PI / 2, 0, 0.3] },
    laser: { off: 0.024, e: [0, 0, 0], q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0))) },
  };
  static PHONE_HAND = PHONE_HAND;
  private static phoneHold() {
    const qh = PHONE_HAND;
    const inv = qh.clone().invert();
    // the tablet upright, screen to the eye, top leaned away a touch and rolled slightly inward
    const qp = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.32, 0.1, 0.1, 'YXZ'));
    return { off: 0.0075, e: [0, 0, 0] as [number, number, number], q: inv.clone().multiply(qp), p: new THREE.Vector3(0.05, 0.03, 0).applyQuaternion(inv) };
  }
  /** Register an extra held item built elsewhere (needs the weapon materials). */
  addItem(name: string, obj: THREE.Group) {
    obj.visible = false;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.frustumCulled = false;
      }
    });
    this.items[name] = obj;
    this.root.add(obj);
  }
  holdItem(name: string) {
    for (const it of Object.values(this.items)) it.visible = false;
    this.grenade = this.items[name] ?? this.items.frag;
    this.grenade.userData.kind = name;
  }
  /** UAV phone screen (canvas texture) */
  private static phoneTex: THREE.CanvasTexture | null = null;
  static phoneScreen(pressed = false) {
    // a dark green tactical map: grid, contour rings, friendlies, the drone icon and a big LAUNCH key
    const W = 192, H = 336;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d')!;
    const bg = x.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1a12');
    bg.addColorStop(1, '#06110b');
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(120,220,140,.16)';
    x.lineWidth = 1;
    for (let gx = 0; gx <= W; gx += 32) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, 260); x.stroke(); }
    for (let gy = 0; gy <= 260; gy += 32) { x.beginPath(); x.moveTo(0, gy); x.lineTo(W, gy); x.stroke(); }
    // terrain contours
    x.strokeStyle = 'rgba(150,240,150,.5)';
    x.lineWidth = 1.4;
    for (let k = 0; k < 4; k++) {
      x.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const r = 26 + k * 13 + Math.sin(a * 3 + k) * 6 + Math.cos(a * 5 - k * 2) * 3;
        const px = 96 + Math.cos(a) * r * 1.15, py = 128 + Math.sin(a) * r * 0.9;
        if (i) x.lineTo(px, py); else x.moveTo(px, py);
      }
      x.stroke();
    }
    // friendly markers + enemy pings
    x.fillStyle = '#6cff8a';
    for (const [a, b] of [[60, 92], [132, 104], [118, 168], [72, 150], [150, 70]]) { x.beginPath(); x.arc(a, b, 3.2, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = '#ff5a48';
    for (const [a, b] of [[44, 60], [160, 150]]) { x.beginPath(); x.arc(a, b, 3, 0, Math.PI * 2); x.fill(); }
    // drone icon
    x.fillStyle = '#f2f6f0';
    x.save();
    x.translate(98, 132);
    x.rotate(-0.4);
    x.beginPath();
    x.moveTo(-26, -4); x.lineTo(26, -4); x.lineTo(26, 2); x.lineTo(4, 4); x.lineTo(2, 16); x.lineTo(-2, 16); x.lineTo(-4, 4); x.lineTo(-26, 2);
    x.closePath();
    x.fill();
    x.restore();
    // header + LAUNCH key
    x.fillStyle = 'rgba(0,0,0,.45)';
    x.fillRect(0, 0, W, 22);
    x.fillStyle = '#a6f5b4';
    x.font = 'bold 12px sans-serif';
    x.textAlign = 'left';
    x.fillText('RECON UPLINK', 8, 15);
    x.textAlign = 'right';
    x.fillText('SAT 4/4', W - 8, 15);
    x.textAlign = 'center';
    x.fillStyle = '#eaf3ea';
    x.font = 'bold 15px sans-serif';
    x.fillText('ADVANCED UAV', W / 2, 282);
    x.fillStyle = pressed ? '#c8ff5a' : '#2cff4a';
    x.fillRect(10, 292, W - 20, 38);
    x.fillStyle = '#062010';
    x.font = 'bold 22px sans-serif';
    x.fillText(pressed ? 'LAUNCHED' : 'LAUNCH', W / 2, 319);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  static phoneTexPressed: THREE.CanvasTexture | null = null;
  static makePhone() {
    // rugged tactical tablet: olive polymer shell, raised bumper frame, thick corner guards
    const g = new THREE.Group();
    g.name = 'UAV_Tablet';
    const shell = new THREE.MeshStandardMaterial({ color: 0x4a4c3e, roughness: 0.78, metalness: 0.05 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x5c5e4c, roughness: 0.7, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c1a, roughness: 0.55, metalness: 0.2 });
    const W = 0.078, H = 0.14, D = 0.013;
    const body = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 3, 0.006), shell);
    body.name = 'body';
    g.add(body);
    // bezel ring around the glass (four bars standing proud of the face)
    for (const [w, h, x, y, nm] of [[W - 0.004, 0.009, 0, H / 2 - 0.006, 'top'], [W - 0.004, 0.016, 0, -H / 2 + 0.009, 'bottom'], [0.007, H - 0.02, -W / 2 + 0.0045, 0, 'left'], [0.007, H - 0.02, W / 2 - 0.0045, 0, 'right']] as const) {
      const bar = new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.004, 2, 0.0015), frame);
      bar.name = `bezel_${nm}`;
      bar.position.set(x, y, D / 2 + 0.0008);
      g.add(bar);
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const b = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.018, D + 0.005, 2, 0.004), dark);
      b.name = `corner_guard_${sy > 0 ? 'top' : 'bottom'}_${sx > 0 ? 'right' : 'left'}`;
      b.position.set(sx * (W / 2 - 0.006), sy * (H / 2 - 0.006), 0);
      g.add(b);
    }
    // antenna nub + side keys
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.005, 0.018, 10), dark);
    ant.name = 'antenna';
    ant.position.set(W / 2 - 0.016, H / 2 + 0.008, -0.002);
    g.add(ant);
    for (const ky of [0.02, 0.035]) {
      const key = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.01, 0.005), dark);
      key.name = ky < 0.03 ? 'side_key_lower' : 'side_key_upper';
      key.position.set(-W / 2 - 0.001, ky, 0);
      g.add(key);
    }
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.015, H - 0.03), new THREE.MeshBasicMaterial({ map: (Viewmodel.phoneTex ??= Viewmodel.phoneScreen()), toneMapped: false }));
    scr.position.set(0, -0.0015, D / 2 + 0.0004);
    scr.name = 'screen';
    g.add(scr);
    Viewmodel.phoneTexPressed ??= Viewmodel.phoneScreen(true);
    g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    return g;
  }
  static makeInjector() {
    // olive autoinjector with a clear window over the drive spring, black safety cap, grey nose
    const g = new THREE.Group();
    const olive = new THREE.MeshStandardMaterial({ color: 0x55603a, roughness: 0.55, metalness: 0.08 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.118, 18), olive);
    g.add(body);
    // ribbed grip band
    for (let i = 0; i < 5; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.0127, 0.0011, 6, 18), new THREE.MeshStandardMaterial({ color: 0x3e4629, roughness: 0.8 }));
      r.rotation.x = Math.PI / 2;
      r.position.y = -0.028 + i * 0.006;
      g.add(r);
    }
    // window + spring
    const win = new THREE.Mesh(new THREE.CylinderGeometry(0.0129, 0.0129, 0.046, 18, 1, true, -0.9, 1.8), new THREE.MeshStandardMaterial({ color: 0x9fb4b0, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.45 }));
    win.position.y = 0.02;
    g.add(win);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 120; i++) { const a = i * 0.55; pts.push(new THREE.Vector3(Math.cos(a) * 0.008, -0.002 + i * 0.00038, Math.sin(a) * 0.008)); }
    const spring = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.0011, 5), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.25, metalness: 1 }));
    g.add(spring);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0118, 0.0128, 0.026, 16), new THREE.MeshStandardMaterial({ color: 0x18191a, roughness: 0.5 }));
    cap.position.y = 0.071;
    cap.name = 'cap';
    g.add(cap);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0118, 0.014, 16), new THREE.MeshStandardMaterial({ color: 0x8a8d90, metalness: 0.7, roughness: 0.35 }));
    nose.position.y = -0.065;
    g.add(nose);
    // red cross marking
    const plus = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.0035, 0.001), new THREE.MeshBasicMaterial({ color: 0xc0201a }));
    plus.position.set(0, -0.045, 0.0128);
    const plus2 = plus.clone();
    plus2.rotation.z = Math.PI / 2;
    g.add(plus, plus2);
    g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    return g;
  }
  static makeDesignator() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x3d3f34, roughness: 0.6, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.12), mat);
    g.add(body);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 14), new THREE.MeshStandardMaterial({ color: 0x1c1d1e, roughness: 0.4, metalness: 0.6 }));
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0.006, 0.004, -0.07);
    g.add(tube);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.011, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.1), toneMapped: false }));
    lens.position.set(0.006, 0.004, -0.0855);
    lens.rotation.y = Math.PI;
    lens.name = 'lens';
    g.add(lens);
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.014), new THREE.MeshStandardMaterial({ color: 0xb02018, roughness: 0.5 }));
    btn.position.set(0, 0.025, -0.01);
    g.add(btn);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.05, 0.03), mat);
    grip.position.set(0, -0.04, 0.02);
    grip.rotation.x = 0.25;
    g.add(grip);
    g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    return g;
  }
  static makeGrenade(kind: 'frag' | 'flash' | 'stun' | 'smoke' = 'frag') {
    if (kind !== 'frag') return Viewmodel.makeCanister(kind);
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.55, metalness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.9 });
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      prof.push(new THREE.Vector2(Math.sin(a) * 0.029 * (1 - 0.08 * Math.cos(a)), -Math.cos(a) * 0.036));
    }
    const shell = new THREE.Mesh(new THREE.LatheGeometry(prof, 14), body);
    g.add(shell);
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.02, 10), steel);
    fuse.position.y = 0.043;
    g.add(fuse);
    const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.062, 0.004), steel);
    spoon.position.set(0, 0.02, 0.03);
    spoon.rotation.x = -0.18;
    g.add(spoon);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0016, 6, 16), steel);
    ring.position.set(0.016, 0.05, 0);
    ring.rotation.y = Math.PI / 2;
    ring.name = 'ring';
    g.add(ring);
    g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    return g;
  }
  /** Cylindrical tacticals: perforated flashbang, banded stun grenade, smoke canister. */
  static makeCanister(kind: 'flash' | 'stun' | 'smoke') {
    const g = new THREE.Group();
    const col = kind === 'flash' ? 0x3c4046 : kind === 'stun' ? 0x2f3a2c : 0x5c6150;
    const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.5 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.9 });
    const h = kind === 'smoke' ? 0.11 : 0.085, r = kind === 'smoke' ? 0.026 : 0.022;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 18), body);
    g.add(shell);
    if (kind === 'flash') {
      const holeMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
      for (let row = 0; row < 3; row++) for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + row * 0.4;
        const hole = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), holeMat);
        hole.position.set(Math.cos(a) * (r + 0.0003), -0.022 + row * 0.022, Math.sin(a) * (r + 0.0003));
        hole.lookAt(hole.position.clone().multiplyScalar(2).setY(hole.position.y));
        g.add(hole);
      }
    }
    const bandCol = kind === 'flash' ? 0xd8d8d0 : kind === 'stun' ? 0xd8b020 : 0xe8e8e8;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.0006, r + 0.0006, kind === 'smoke' ? 0.03 : 0.008, 18), new THREE.MeshStandardMaterial({ color: bandCol, roughness: 0.6 }));
    band.position.y = kind === 'smoke' ? 0.0 : h / 2 - 0.012;
    g.add(band);
    if (kind === 'smoke') {
      for (let i = 0; i < 4; i++) {
        const hole = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0x0a0a0a }));
        hole.rotation.x = -Math.PI / 2;
        hole.position.set(Math.cos(i * 1.57) * 0.013, h / 2 + 0.0005, Math.sin(i * 1.57) * 0.013);
        g.add(hole);
      }
    }
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.018, 10), steel);
    fuse.position.y = h / 2 + 0.008;
    g.add(fuse);
    const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.012, h * 0.85, 0.004), steel);
    spoon.position.set(0, h * 0.1, r + 0.003);
    g.add(spoon);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0016, 6, 16), steel);
    ring.position.set(0.016, h / 2 + 0.014, 0);
    ring.rotation.y = Math.PI / 2;
    ring.name = 'ring';
    g.add(ring);
    g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    return g;
  }
  /** free firing-hand target (ladders) */
  private freeR = { b: 0, p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private freeRPose: FingerPose = POSES.hold;
  /** Wrist pose that puts a palm on `anchor` (root space) with orientation q, r off the surface. */
  private wristAt(side: 'L' | 'R', anchor: THREE.Vector3, q: THREE.Quaternion, r: number) {
    const palm = this.rig ? this.rig.palmOffset(side, new THREE.Vector3()) : new THREE.Vector3(side === 'R' ? -0.003 : 0.003, -0.007, -0.072);
    palm.y -= (this.rig ? this.rig.palmDepth(side) : 0.014) + r;
    return anchor.clone().sub(palm.applyQuaternion(q));
  }
  /**
   * Two-handed item (claymore, trophy): put a hand on one of the item's grip markers. Finger and
   * palm directions are given in item space so the grip turns with the item.
   */
  private gripItem(side: 'L' | 'R', item: THREE.Object3D, markerName: string, fingers: THREE.Vector3, palmN: THREE.Vector3, r: number, pose: FingerPose, slide = new THREE.Vector3()) {
    item.updateMatrix();
    const mk = item.getObjectByName(markerName);
    if (!mk) return;
    const anchor = mk.position.clone().add(slide).applyMatrix4(item.matrix);
    const q = handQ(fingers.clone().applyQuaternion(item.quaternion), palmN.clone().applyQuaternion(item.quaternion));
    const f = side === 'L' ? this.freeL : this.freeR;
    f.p.copy(this.wristAt(side, anchor, q, r));
    f.q.copy(q);
    if (side === 'L') this.freeL.pose = pose;
    else this.freeRPose = pose;
  }
  private climbBlend = 0;
  /** free support hand target in root (camera) space, set by actions that leave the gun */
  private freeL = { b: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), pose: POSES.hold as FingerPose };

  /** The hand never moves relative to its grip socket, so the on-gun wrap is solved once per grip
   *  (and refreshed now and then) instead of every frame. */
  private wrapCache = new Map<string, { pose: FingerPose; age: number }>();
  private cachedWrap(side: 'R' | 'L', sock: THREE.Object3D, base: FingerPose, skip: ('index' | 'thumb')[] = []) {
    const key = side + sock.uuid;
    let c = this.wrapCache.get(key);
    if (!c || c.age++ > 90) {
      c = { pose: this.rig!.wrapPose(side, gripSDF(sock), base, skip), age: 0 };
      this.wrapCache.set(key, c);
    }
    return c.pose;
  }

  /**
   * Surface the support hand is currently holding (world-space signed distance), if any:
   * a thrown item / injector / phone / designator, the speedloader, or a magazine near the palm.
   */
  private heldSDF(): ((p: THREE.Vector3) => number) | null {
    const g = this.grenade;
    if (g.visible) {
      const k = g.userData.kind ?? 'frag';
      g.updateMatrixWorld(true);
      if (k === 'frag') return sphereSDF(g.getWorldPosition(new THREE.Vector3()), 0.031);
      const dims: Record<string, [number, number, number]> = {
        flash: [0.022, 0.0425, 0], stun: [0.022, 0.0425, 0], smoke: [0.026, 0.055, 0], stim: [0.011, 0.055, 0],
        sticky: [0.025, 0.032, 0], snapshot: [0.03, 0.025, 0], decoy: [0.022, 0.05, 0],
      };
      if (dims[k]) return cylSDF(g.matrixWorld, dims[k][0], dims[k][1]);
      const boxes: Record<string, [number, number, number, number]> = {
        c4: [0, 0.055, 0.017, 0.028], detonator: [0, 0.018, 0.046, 0.012], claymore: [0, 0.108, 0.042, 0.022], trophy: [0.04, 0.085, 0.04, 0.085],
      };
      const bx = boxes[k];
      if (bx) return boxSDF(g.matrixWorld, new THREE.Vector3(0, bx[0], 0), new THREE.Vector3(bx[1], bx[2], bx[3]));
      if (k === 'phone') return boxSDF(g.matrixWorld, new THREE.Vector3(), new THREE.Vector3(0.039, 0.07, 0.0068));
      if (k === 'laser') return boxSDF(g.matrixWorld, new THREE.Vector3(0, -0.01, 0), new THREE.Vector3(0.025, 0.03, 0.06));
    }
    const loader = this.model?.parts.loader;
    if (loader?.visible) {
      loader.updateMatrixWorld(true);
      return cylSDF(loader.matrixWorld.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0.016, 0.02, new THREE.Vector3(0, 0.012, 0));
    }
    // magazines (the one in the gun when stripped, or the fresh one) when the palm is on them
    if (this.rig && this.action && (this.action.type === 'reload' || this.action.type === 'reloadEmpty' || this.action.type === 'inspectMag')) {
      const palm = this.rig.palmWorld('L');
      let best: THREE.Object3D | null = null, bd = 0.09;
      for (const m of [this.model?.parts.mag, this.spareMag]) {
        if (!m || !m.visible) continue;
        const d = m.getWorldPosition(new THREE.Vector3()).distanceTo(palm);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      if (best) {
        best.updateMatrixWorld(true);
        // (cached in a WeakMap, not userData: Object3D.clone() deep-copies userData through JSON, so
        // the spare magazine cloned from the gun's mag inherited a dead {min,max} object and every
        // reload near it threw — the game froze mid-reload)
        let bb = MAG_BOX.get(best);
        if (!bb) MAG_BOX.set(best, (bb = localBox(best)));
        return boxSDF(best.matrixWorld, bb.getCenter(new THREE.Vector3()), bb.getSize(new THREE.Vector3()).multiplyScalar(0.5));
      }
    }
    return null;
  }

  /** Swap the procedural capsule arms for the skinned arm rig. */
  useRig(rig: RiggedArms) {
    this.rig = rig;
    this.root.add(rig.root);
    this.right.root.visible = false;
    this.left.root.visible = false;
  }

  /** revolver state (hammer, cylinder index, hand plan) */
  rev = newRevState();
  get isRevolver() {
    return this.def?.id === 'rv357';
  }
  /** The speedloader's pose in camera space (for dropping it into the world). */
  loaderTransform() {
    const l = this.model?.parts.loader;
    if (!l || !l.visible) return null;
    l.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    l.matrixWorld.decompose(p, q, sc);
    return { p, q, mesh: l };
  }

  setWeapon(model: WeaponModel, def: WeaponDef) {
    if (this.model) this.weaponPivot.remove(this.model.root);
    this.model?.parts.loader?.removeFromParent();
    this.rev = newRevState();
    this.model = model;
    this.def = def;
    this.weaponPivot.add(model.root);
    const p = model.parts;
    if (this.spareMag) this.spareMag.removeFromParent();
    this.spareMag = null;
    if (p.mag) {
      this.magHome.copy(p.mag.position);
      this.magHomeQ.copy(p.mag.quaternion);
      this.magParent = p.mag.parent;
      // a second magazine for reloads (the fresh one), sharing geometry with the gun's
      this.spareMag = p.mag.clone();
      this.spareMag.visible = false;
      p.mag.parent!.add(this.spareMag);
    }
    // weapon inertia: heavier guns sit on softer, slower springs — they lag further behind a
    // flick and settle later; light guns snap after the view
    const wgt = def.weight;
    this.swayR.stiffness = 150 / Math.pow(wgt, 1.25);
    this.swayR.damping = 13 / Math.pow(wgt, 0.45);
    this.swayP.stiffness = 120 / Math.pow(wgt, 1.25);
    this.swayP.damping = 12 / Math.pow(wgt, 0.45);
    this.land.stiffness = 160 / wgt;
    if (p.bolt) this.boltHome.copy(p.bolt.position);
    if (p.slide) this.slideHome.copy(p.slide.position);
    if (p.charge) this.chargeHome.copy(p.charge.position);
    if (p.pump) this.pumpHome.copy(p.pump.position);
    this.boltLocked = false;
    this.action = null;
    model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;
      }
    });
  }

  play(type: ActionType, dur: number, events: [number, string][] = [], onDone?: () => void, data?: any) {
    this.resetParts();
    for (const it of Object.values(this.items)) it.visible = false;
    this.action = { type, t: 0, dur, events, fired: new Set(), onDone, data };
    this.clip = null;
    this.clipFired.clear();
    this.reloadFired.clear();
    if ((type === 'reload' || type === 'reloadEmpty') && this.model && this.def) {
      const kind = this.def.reloadKind ?? ({ 'Assault Rifle': 'rifle', SMG: 'pdw', Pistol: 'pistol', Sniper: 'sniper', Marksman: 'dmr' } as Record<string, ReloadKind>)[this.def.cls];
      if (kind && this.model.parts.mag) this.clip = this.buildClip(kind, type === 'reloadEmpty');
    }
    if (type === 'inspectMag' && this.model && this.def && this.model.parts.mag) {
      // the mag check reuses the authored tactical reload: play its opening (hand to the mag,
      // release, slide it out a few centimetres), hold, then run it back in reverse
      let kind = this.def.reloadKind ?? ({ 'Assault Rifle': 'rifle', SMG: 'pdw', Pistol: 'pistol', Marksman: 'dmr' } as Record<string, ReloadKind>)[this.def.cls];
      if (kind === 'scar') kind = 'rifle'; // the mag check is one magazine only
      if (kind) {
        this.clip = this.buildClip(kind, false);
        const want = this.def.cls === 'Pistol' ? 0.03 : 0.05;
        this.magCheckT = 0.3;
        for (let ct = 0.02; ct < 0.7; ct += 0.005) {
          const f = this.clip.sample(ct);
          if (f.mags.old.pose && f.mags.old.pose.p.distanceTo(this.magHome) > want) {
            this.magCheckT = ct;
            break;
          }
        }
      }
    }
  }

  private clip: ReloadClip | null = null;
  private magCheckT = 0.3;
  /** per-weapon reload framing (exposed for tuning tools) */
  reloadSpecs = SPECS;
  private clipFired = new Set<number>();
  private spareMag: THREE.Object3D | null = null;

  /** Wrist position for a palm (or fist) anchor on a surface axis, for the support hand. */
  private wristFor(anchor: THREE.Vector3, q: THREE.Quaternion, r: number, fist = false) {
    const palm = this.rig ? this.rig.palmOffset('L', new THREE.Vector3()) : new THREE.Vector3(0.003, -0.007, -0.072);
    const depth = this.rig ? this.rig.palmDepth('L') : 0.014;
    if (fist) palm.multiplyScalar(1.38);
    palm.y -= depth + r;
    return anchor.clone().sub(palm.applyQuaternion(q));
  }

  /** Closed support-hand wrist pose in weapon space (from the left-hand grip socket). */
  private supportPose() {
    const m = this.model!;
    const sock = m.sockets.leftHand;
    m.root.updateMatrixWorld(true);
    const rel = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(sock.matrixWorld);
    const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
    rel.decompose(sp, sq, ss);
    this.anchorWrist('L', sock, sp, sq);
    return { p: sp, q: sq };
  }

  private buildClip(kind: ReloadKind, empty: boolean) {
    const m = this.model!;
    const sock = m.sockets.leftHand;
    m.root.updateMatrixWorld(true);
    const rel = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(sock.matrixWorld);
    const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
    rel.decompose(sp, sq, ss);
    this.anchorWrist('L', sock, sp, sq);
    return buildReloadClip({
      kind, empty,
      magHome: { p: this.magHome.clone(), q: this.magHomeQ.clone() },
      support: { p: sp, q: sq },
      wristFor: (a, q, r, fist) => this.wristFor(a, q, r, fist),
    });
  }

  /** Sample the authored clip: weapon motion, support hand, both magazines, parts and events. */
  private animateClip(
    t: number, pos: THREE.Vector3, rot: THREE.Vector3,
    h: { leftTarget: THREE.Vector3; leftQ: THREE.Quaternion; setLeft: (b: number, p: FingerPose) => void; setRight: (b: number) => void; rightTarget: THREE.Vector3; rightQ: THREE.Quaternion },
  ) {
    const clip = this.clip!;
    const parts = this.model!.parts;
    const f = clip.sample(t);
    pos.add(f.gunP);
    rot.add(f.gunR);
    this.camRoll = f.gunR.z * 0.045 + f.gunR.y * 0.015;
    h.leftTarget.copy(f.hand.p);
    h.leftQ.copy(f.hand.q);
    h.setLeft(1, f.fingers);
    const place = (o: THREE.Object3D | null | undefined, st: { visible: boolean; pose: { p: THREE.Vector3; q: THREE.Quaternion } | null }) => {
      if (!o) return;
      o.visible = st.visible;
      if (st.pose) {
        o.position.copy(st.pose.p);
        o.quaternion.copy(st.pose.q);
      }
    };
    place(parts.mag, f.mags.old);
    place(this.spareMag, f.mags.fresh);
    if (parts.charge && clip.charge) parts.charge.position.z = this.chargeHome.z + f.charge;
    if (parts.slide && clip.slide) parts.slide.position.z = this.slideHome.z + (this.boltLocked ? Math.max(0.026, f.slide) : f.slide);
    if (parts.bolt && clip.bolt) {
      parts.bolt.rotation.z = f.boltLift * 1.2;
      parts.bolt.position.z = this.boltHome.z + 0.095 * f.boltDraw;
      const knob = new THREE.Vector3(0.062, 0, 0.04).applyEuler(new THREE.Euler(0, 0, f.boltLift * 1.2)).add(new THREE.Vector3(0, 0.04, this.boltHome.z + 0.095 * f.boltDraw));
      h.rightTarget.copy(knob).add(new THREE.Vector3(0.035, -0.01, 0.07));
      h.rightQ.setFromEuler(new THREE.Euler(-0.4, 0.4, -1.2, 'YXZ'));
      h.setRight(f.rightBolt);
    }
    clip.events.forEach(([et, name], i) => {
      if (t < et || this.clipFired.has(i)) return;
      this.clipFired.add(i);
      this.clipEvent(name);
    });
    if (t > 0.92) this.once('end', () => this.onEvent('rattle'));
  }

  private clipEvent(name: string) {
    switch (name) {
      case 'release': this.onEvent('magOut'); this.jolt(0.3, 0.25); break;
      case 'drop': this.onEvent('magOut'); this.onEvent('magDrop'); this.magDropped = true; this.jolt(0.25, 0.3); break;
      case 'pouch': this.onEvent('cloth'); break;
      case 'touch': this.onEvent('magTouch'); break;
      case 'seat': this.onEvent('magIn'); this.jolt(0.75, -0.8, -0.25); this.magDropped = false; break;
      case 'tap': this.onEvent('magTap'); this.jolt(0.55, -0.3); break;
      case 'boltRelease': this.boltLocked = false; this.onEvent('boltRelease'); this.jolt(1.4, -0.9, -0.6); break;
      case 'chargeBack': this.onEvent('boltBack'); this.jolt(0.3, 0.2, 0.3); break;
      case 'slideBack': this.onEvent('slideBack'); this.jolt(0.2, 0.1, 0.25); break;
      case 'chargeFwd': this.boltLocked = false; this.onEvent('boltRelease'); this.jolt(1.1, -0.6, -0.4); break;
      case 'slideRelease': this.boltLocked = false; this.onEvent('slideRelease'); this.jolt(1.2, 0.6, -0.4); break;
      case 'boltOpen': this.onEvent('boltOpen'); this.jolt(0.3, 0.3); break;
      case 'boltClose': this.boltLocked = false; this.onEvent('boltClose'); this.jolt(0.6, 0.3); break;
      case 'chargeLock': this.onEvent('fireMode'); this.jolt(0.2, 0.1); break;
      // camera: the view reacts to the heavy beats of a reload (visual kick springs, in rad/s)
      case 'camSeat': this.camKick.add(new THREE.Vector3(-0.09, 0.02, 0.05)); break;
      case 'camSeatHard': this.camKick.add(new THREE.Vector3(-0.16, 0.03, 0.09)); break;
      case 'camTap': this.camKick.add(new THREE.Vector3(-0.05, 0, 0.03)); break;
      case 'camDrop': this.camKick.add(new THREE.Vector3(0.03, -0.02, -0.1)); break;
      case 'camSlap': this.camKick.add(new THREE.Vector3(-0.2, 0.05, 0.13)); break;
    }
  }
  /** camera impulses queued by reload beats (read and cleared by the game each frame) */
  camKick = new THREE.Vector3();
  /** camera roll that follows the gun's roll during authored reloads */
  camRoll = 0;

  cancelAction() {
    this.action = null;
    this.resetParts();
  }

  private resetParts() {
    const p = this.model?.parts;
    if (!p) return;
    if (p.mag && this.magParent && p.mag.parent !== this.magParent) {
      this.magParent.add(p.mag);
    }
    if (p.mag) {
      p.mag.position.copy(this.magHome);
      p.mag.quaternion.copy(this.magHomeQ);
      p.mag.visible = true;
    }
    if (p.shell) p.shell.visible = false;
    if (this.spareMag) this.spareMag.visible = false;
    if (p.charge) p.charge.position.copy(this.chargeHome);
    if (p.cover) p.cover.rotation.x = 0;
    if (p.mag2) p.mag2.visible = false;
    if (p.charge) p.charge.rotation.set(0, 0, 0);
    if (p.belt) {
      p.belt.visible = true;
      p.belt.position.set(0, 0, 0);
    }
    if (p.barrels) p.barrels.rotation.x = 0;
    if (p.lever) p.lever.rotation.y = 0;
    if (p.handShells) p.handShells.visible = false;
    for (const k of ['shellL', 'shellR']) if (p[k]) {
      p[k].visible = true;
      p[k].position.z = 0;
    }
    if (this.isRevolver) revolverReset(p);
  }

  private rollSign = 1;
  /**
   * Weapon kick. Units are real (m/s, rad/s impulses on springs read back directly):
   *  fast layer  — snaps back toward the shoulder in ~80 ms with a little overshoot
   *  slow layer  — builds up during sustained fire (the gun creeps up/back) and settles after
   * In ADS the translation is reduced more than the rotation so the sight picture visibly
   * jumps and recentres instead of the gun sliding around the screen.
   */
  kick(def: WeaponDef, adsAmt: number) {
    if (def.id === 'rv357') revolverShot(this.rev);
    const r = def.recoil;
    const tm = lerp(1, 0.42, adsAmt), rm = lerp(1, 0.42, adsAmt), dm = lerp(1, 0.18, adsAmt);
    const rnd = () => Math.random() * 2 - 1;
    const heavy = def.cls === 'Sniper' || def.cls === 'Shotgun' ? 1.25 : def.cls === 'Marksman' ? 1.18 : 1;
    this.rollSign = Math.random() < 0.7 ? -this.rollSign : this.rollSign; // alternating wobble
    this.recoilP.impulse(rnd() * 0.08 * tm, (0.05 + Math.random() * 0.04) * tm, r.kickZ * 52 * tm * heavy);
    this.recoilR.impulse(r.kickPitch * 52 * rm * heavy, rnd() * r.kickPitch * 16 * rm, this.rollSign * r.roll * (40 + Math.random() * 25) * rm);
    this.driftP.impulse(rnd() * 0.003 * dm, 0.004 * dm, r.kickZ * 3.2 * tm);
    this.driftR.impulse(r.kickPitch * 3.4 * dm, rnd() * r.kickPitch * 2.2 * dm, rnd() * r.roll * 4 * dm);
    this.muzzleFlashT = 1;
    this.boltCycle = 1;
    this.lastKickT = this.t;
    this.settled = false;
  }

  landImpulse(speed: number) {
    // the gun drops with the body and settles back up (heavier guns dip deeper and take longer)
    this.land.impulse(-clamp(speed / 10, 0, 1.5) * 1.6 * (0.7 + 0.35 * (this.def?.weight ?? 1)));
  }

  /** slide entry: the gun dips and kicks toward the body as you drop */
  slideImpulse() {
    this.land.impulse(-1.4);
    this.recoilR.impulse(-0.008, 0.005, 0.02);
    this.recoilP.impulse(-0.0025, -0.004, 0.006);
  }

  jumpImpulse() {
    this.land.impulse(0.6);
  }

  /** Returns the camera-space transform of the ADS pose. */
  private adsPose(out: THREE.Vector3) {
    const s = this.model!.sockets.sight.position;
    return out.set(-s.x, -s.y, -this.model!.adsDist - s.z);
  }

  update(dt: number, c: VMContext) {
    if (!this.model || !this.def) return;
    this.t += dt;
    const def = this.def;
    const ads = easeInOutCubic(c.ads);
    const nonAds = 1 - ads;
    const w = def.weight;

    // ---------------- base pose ----------------
    const adsP = this.adsPose(new THREE.Vector3());
    const hip = new THREE.Vector3(...def.hip).add(adsP);
    const pos = hip.clone().lerp(adsP, ads);
    const rot = new THREE.Vector3(this.pose.hipR[0] * nonAds, this.pose.hipR[1] * nonAds, this.pose.hipR[2] * nonAds);
    // crouch: tuck slightly
    pos.y -= 0.008 * c.crouch * nonAds;
    rot.z += 0.05 * c.crouch * nonAds;
    // sprint: weapon angled down/left across body
    const sp = c.sprint * (1 - c.tactical);
    // sprint: carried low and angled across the chest so it stays out of the line of sight
    pos.add(new THREE.Vector3(0.008, -0.028, 0.012).multiplyScalar(sp));
    rot.add(new THREE.Vector3(-0.2, 0.45, 0.3).multiplyScalar(sp));
    // tactical sprint (one-handed, MW-style): the right hand swings the gun up beside the face,
    // muzzle high and across to the left, canted over; the support arm leaves the gun and pumps
    const tc = easeInOutCubic(clamp(c.tactical, 0, 1));
    const tcSwing = Math.sin(c.stepPhase * Math.PI) * (c.foot === 0 ? 1 : -1);
    const pistolCls = def.cls === 'Pistol';
    // long guns sit further out and lower so the receiver does not fill the screen
    const longGun = def.cls === 'Assault Rifle' || def.cls === 'Sniper' || def.cls === 'Shotgun' || def.cls === 'Marksman' || def.cls === 'LMG';
    const tp = pistolCls ? this.pose.tacPistolP : longGun ? [0.1, -0.03, -0.12] : this.pose.tacP;
    const tr = pistolCls ? this.pose.tacPistolR : longGun ? [0.85, 0.28, -0.75] : this.pose.tacR;
    pos.x += tp[0] * tc; pos.y += tp[1] * tc; pos.z += tp[2] * tc;
    rot.x += tr[0] * tc; rot.y += tr[1] * tc; rot.z += tr[2] * tc;
    // the one-handed carry bounces & rocks with each stride
    pos.y += Math.abs(tcSwing) * 0.012 * tc;
    pos.x += tcSwing * 0.008 * tc;
    rot.x += Math.abs(tcSwing) * 0.06 * tc;
    rot.z += tcSwing * 0.07 * tc;
    // slide: canted hard to the left, pulled in and lowered, slight muzzle dip
    const sl = easeInOutCubic(clamp(c.slide, 0, 1)) * nonAds;
    pos.x += this.pose.slideP[0] * sl; pos.y += this.pose.slideP[1] * sl; pos.z += this.pose.slideP[2] * sl;
    rot.x += this.pose.slideR[0] * sl; rot.y += this.pose.slideR[1] * sl; rot.z += this.pose.slideR[2] * sl;
    // in-air: weapon lifts slightly
    // in-air: the gun dips a touch and lags the jump instead of rising into view
    pos.y += -c.air * 0.012 * nonAds - clamp(c.vy * 0.0025, -0.012, 0.018) * nonAds;
    rot.x += -c.air * 0.05 * nonAds;

    // ---------------- bob ----------------
    const s = c.stepPhase;
    const side = c.foot === 0 ? 1 : -1;
    const bobAmt = clamp(c.speed01 * 1.3, 0, 1.3) * (1 - c.air) * (1 - c.slide);
    const bobScale = lerp(1, 0.12, ads);
    const intensity = c.sprint > 0.5 ? (c.tactical > 0.5 ? 1.8 : 1.5) : 1;
    const bx = Math.sin(s * Math.PI) * side * 0.011 * bobAmt * intensity;
    const by = (Math.cos(s * Math.PI * 2) * 0.5 - 0.5) * 0.009 * bobAmt * intensity;
    this.bobP.x = damp(this.bobP.x, bx * bobScale, 18, dt);
    this.bobP.y = damp(this.bobP.y, by * bobScale, 18, dt);
    this.bobR.z = damp(this.bobR.z, bx * 1.6 * bobScale, 18, dt);
    this.bobR.x = damp(this.bobR.x, by * 1.2 * bobScale, 18, dt);
    this.bobR.y = damp(this.bobR.y, -bx * 0.8 * bobScale, 18, dt);
    // idle breathing
    const br = Math.sin(this.t * 1.3) * 0.0018 + Math.sin(this.t * 0.71) * 0.0011;
    // LMG on its bipod: legs swing down, the gun settles onto them and stops breathing around
    const bipT = def.id === 'lmg' ? this.bipod : 0;
    if (Math.abs(bipT - this.bipodBlend) > 0.001 || bipT > 0) {
      const prev = this.bipodBlend;
      this.bipodBlend = damp(this.bipodBlend, bipT, bipT > prev ? 7 : 9, dt);
      if (prev < 0.85 && this.bipodBlend >= 0.85) this.bipodSettle.impulse(-1.2);
    }
    this.bipodSettle.update(dt);
    const bip = easeInOutCubic(clamp(this.bipodBlend, 0, 1));
    (this.model.root.userData.setBipod as ((k: number) => void) | undefined)?.(easeOutBack(clamp(this.bipodBlend * 1.15, 0, 1)));
    pos.y += -0.006 * bip * nonAds + this.bipodSettle.value * 0.004;
    rot.x += this.bipodSettle.value * 0.01;
    // the LMG is heavy: it hangs lower at the hip and sags with each step
    if (def.cls === 'LMG') {
      pos.y -= 0.006 * nonAds * (1 - bip);
      rot.z += 0.03 * nonAds * (1 - bip);
    }
    const breathe = lerp(1, c.ads > 0.9 && def.scope ? 0.35 : 0.25, ads) * (1 - 0.85 * bip);
    pos.y += br * breathe;
    rot.x += Math.sin(this.t * 1.1) * 0.004 * breathe;
    rot.y += Math.sin(this.t * 0.6) * 0.003 * breathe;

    // ---------------- sway (mouse) ----------------
    // heavier guns swing further when you whip the view (the spring above makes them lag); aiming
    // braces it down
    const swayK = lerp(1, 0.3, ads) * (0.55 + 0.5 * w);
    this.swayR.target.set(clamp(c.lookDY * 1.6, -0.08, 0.08) * swayK, clamp(c.lookDX * 1.8, -0.1, 0.1) * swayK, clamp(c.lookDX * 1.4, -0.08, 0.08) * swayK);
    this.swayP.target.set(clamp(c.lookDX * 0.12, -0.012, 0.012) * swayK, clamp(-c.lookDY * 0.1, -0.012, 0.012) * swayK, 0);
    this.swayR.update(dt);
    this.swayP.update(dt);
    // strafe lean
    rot.z += -c.strafe * 0.012 * nonAds;
    pos.x += -c.strafe * 0.0015;

    // ---------------- night vision: canted IR-laser aim ----------------
    // goggles stop you getting a cheek weld behind the optic, so aiming rolls the gun over
    // (~36°, top to the left), drops it below the eye and pulls it in; the 3 o'clock laser
    // comes up into view and does the aiming
    this.cantBlend = damp(this.cantBlend, c.cant ?? 0, 7, dt);
    const ct = easeInOutCubic(clamp(this.cantBlend, 0, 1)) * ads;
    if (ct > 1e-4) {
      // a little overshoot on the roll as it comes in, like a real cant-over
      const over = Math.sin(clamp(c.ads, 0, 1) * Math.PI) * 0.06 * this.cantBlend;
      // guns aimed very close to the eye (short ADS distance) drop further out of the line of sight
      const close = clamp((0.26 - (this.model.adsDist ?? 0.2)) / 0.16, 0, 1);
      pos.x += (0.034 + 0.02 * close) * ct;
      pos.y -= (0.05 + 0.03 * close) * ct;
      pos.z += (0.03 - 0.03 * close) * ct;
      rot.z += (0.58 + over) * ct;
      rot.y += 0.035 * ct;
      rot.x += 0.02 * ct;
    }
    // ---------------- door peek: lean round the edge, gun tucked in tight ----------------
    this.peekBlend = damp(this.peekBlend, c.peek ?? 0, 6, dt);
    const pk = this.peekBlend * ads;
    if (Math.abs(pk) > 1e-4) {
      rot.z += -0.16 * pk;
      pos.x += 0.006 * pk;
      pos.y -= 0.005 * Math.abs(pk);
      pos.z += 0.016 * Math.abs(pk);
      rot.y += -0.02 * pk;
    }

    // ---------------- MP-18 stock flick ----------------
    const stock = this.model.parts.stock;
    if (stock) {
      const want = c.ads > 0.25 && !this.action;
      if (want !== this.stockOut) {
        this.stockOut = want;
        this.onEvent(want ? 'stockOut' : 'stockIn');
        this.stockSpring.impulse(want ? 2.2 : -1.2);
      }
      this.stockBlend = damp(this.stockBlend, want ? 1 : 0, want ? 16 : 9, dt);
      this.stockSpring.update(dt);
      const k = clamp(this.stockBlend + this.stockSpring.value * 0.06, 0, 1.08);
      stock.rotation.y = Math.PI * (1 - k);
      // deployed it drops toward the shoulder pocket instead of running straight back at the eye
      stock.rotation.x = 0.38 * Math.min(1, k);
      // the flick rocks the gun a touch as the stock swings and locks
      rot.z += this.stockSpring.value * 0.012;
      rot.y += this.stockSpring.value * 0.006;
    }

    // ---------------- Q/E lean: weight rolls onto one leg, the gun rides the shoulder ----------------
    this.leanBlend = damp(this.leanBlend, c.lean ?? 0, 9, dt);
    this.leanSwing.update(dt);
    const ln = this.leanBlend, lsw = this.leanSwing.value;
    if (Math.abs(ln) > 1e-4 || Math.abs(lsw) > 1e-4) {
      const hipK = 1 - ads * 0.8;
      // hip: the gun tips further into the lean and draws in toward the chest; ADS keeps the sight on axis
      rot.z += (-0.07 * ln - 0.05 * lsw) * hipK;
      rot.y += -0.025 * ln * hipK + 0.012 * lsw;
      pos.x += (0.008 * ln - 0.01 * lsw) * hipK;
      pos.y += -0.006 * Math.abs(ln) * hipK - 0.004 * Math.abs(lsw);
      pos.z += 0.01 * Math.abs(ln) * hipK;
    }

    // ---------------- weapon life: full-auto shake & post-burst settle ----------------
    this.shake = damp(this.shake, this.sprayShake, 14, dt);
    if (this.shake > 0.01) {
      const sk = this.shake * lerp(1, 0.4, ads);
      const n1 = Math.sin(this.t * 91.0) * Math.sin(this.t * 53.0), n2 = Math.sin(this.t * 77.0 + 1.3), n3 = Math.cos(this.t * 63.0 + 0.7);
      pos.x += n1 * 0.0018 * sk;
      pos.y += n2 * 0.0014 * sk;
      rot.z += n3 * 0.012 * sk;
      rot.y += n1 * 0.005 * sk;
    }
    if (!this.settled && this.t - this.lastKickT > 0.1) {
      this.settled = true;
      // the gun relaxes back onto the shoulder after the trigger is released
      this.recoilR.impulse(-0.0055, 0, (Math.random() - 0.5) * 0.005);
      this.recoilP.impulse(0, -0.0015, -0.004);
    }
    // positional inertia when turning (heavier guns lag more)
    pos.x += -clamp(c.lookDX * 0.06, -0.01, 0.01) * w * nonAds;
    pos.y += clamp(c.lookDY * 0.05, -0.008, 0.008) * w * nonAds;

    // ---------------- springs ----------------
    this.recoilP.update(dt);
    this.recoilR.update(dt);
    this.land.update(dt);
    this.driftP.update(dt);
    this.driftR.update(dt);
    pos.add(this.recoilP.value).add(this.driftP.value);
    rot.x += this.recoilR.value.x + this.driftR.value.x;
    rot.y += this.recoilR.value.y + this.driftR.value.y;
    rot.z += this.recoilR.value.z + this.driftR.value.z;
    pos.y += this.land.value * 0.012 * lerp(1, 0.4, ads);
    rot.x += this.land.value * 0.012 * lerp(1, 0.4, ads);
    {
      // a bipod-mounted gun barely moves with the body (bob and mouse sway mostly soaked up)
      const still = 1 - 0.8 * easeInOutCubic(clamp(this.bipodBlend, 0, 1));
      const heavyBob = def.cls === 'LMG' ? 1.3 : 1;
      pos.addScaledVector(this.bobP, still * heavyBob).addScaledVector(this.swayP.value, still);
      if (still < 1) {
        rot.addScaledVector(this.bobR, still * heavyBob - 1);
        rot.addScaledVector(this.swayR.value, still - 1);
      }
    }
    rot.add(this.bobR).add(this.swayR.value);

    // ---------------- ladder & mantle: the gun drops away, the hands do the climbing ----------------
    this.freeR.b = 0;
    const lad = c.ladder ?? 0;
    this.climbBlend = damp(this.climbBlend, lad, lad > this.climbBlend ? 7 : 9, dt);
    const mant = c.mantle ?? -1;
    if (this.climbBlend > 0.002) {
      const k = easeInOutCubic(this.climbBlend);
      pos.y -= 0.42 * k;
      pos.x += 0.08 * k;
      rot.x -= 1.15 * k;
      const phase = (c.climb ?? 0) * 2.6;
      const rung = (u: number) => (u < 0.72 ? 0.07 - 0.36 * (u / 0.72) : -0.29 + 0.36 * smoothstep(0, 1, (u - 0.72) / 0.28));
      const reach = (u: number) => (u < 0.72 ? 0 : Math.sin(((u - 0.72) / 0.28) * Math.PI));
      const uL = ((phase % 1) + 1) % 1, uR = ((phase + 0.5) % 1 + 1) % 1;
      this.freeL.p.set(-0.13, rung(uL), -0.37 + 0.05 * reach(uL));
      this.freeL.q.copy(handQ(new THREE.Vector3(0.1, 1, -0.25), new THREE.Vector3(0, -0.2, -1)));
      this.freeL.pose = POSES.hold;
      this.freeL.b = k;
      this.freeR.p.set(0.13, rung(uR), -0.37 + 0.05 * reach(uR));
      this.freeR.q.copy(handQ(new THREE.Vector3(-0.1, 1, -0.25), new THREE.Vector3(0, -0.2, -1)));
      this.freeR.b = k;
    }
    if (mant >= 0) {
      // plant the support hand on the ledge and push up past it
      const k = kf(mant, [[0, 0], [0.1, 1], [0.72, 1], [1, 0]]);
      const rise = smoothstep(0.05, 0.75, mant);
      pos.y -= 0.14 * k;
      pos.x += 0.06 * k;
      rot.x -= 0.45 * k;
      rot.z -= 0.3 * k;
      const v = c.vault ? 1 : 0;
      this.freeL.p.set(-0.14 + 0.03 * v, -0.04 - 0.42 * rise - 0.05 * v, -0.44 + 0.12 * rise);
      this.freeL.q.copy(handQ(new THREE.Vector3(0.25, -0.1, -1), new THREE.Vector3(0, -1, 0.1)));
      this.freeL.pose = POSES.open;
      this.freeL.b = Math.max(this.freeL.b, k);
    }

    // ---------------- actions ----------------
    let leftMode: 'grip' | 'free' = 'grip';
    let leftBlend = 0;
    const leftTarget = new THREE.Vector3();
    const leftQ = new THREE.Quaternion();
    let leftPose: FingerPose = POSES.support;
    let rightFree = 0;
    const rightTarget = new THREE.Vector3();
    const rightQ = new THREE.Quaternion();
    const parts = this.model.parts;
    // per-frame part defaults
    if (parts.bolt && !this.model.parts.pump) {
      const travel = def.cls === 'Sniper' ? 0 : -0.032;
      this.boltCycle = Math.max(0, this.boltCycle - dt * (def.rpm / 60) * 1.0);
      const bc = this.boltLocked ? 1 : Math.sin(this.boltCycle * Math.PI);
      if (def.cls !== 'Sniper') parts.bolt.position.set(this.boltHome.x, this.boltHome.y, this.boltHome.z - travel * bc);
    }
    if (parts.slide) {
      this.boltCycle = Math.max(0, this.boltCycle - dt * 14);
      const sc = this.boltLocked ? 1 : Math.sin(this.boltCycle * Math.PI);
      parts.slide.position.set(this.slideHome.x, this.slideHome.y, this.slideHome.z + 0.026 * sc);
    }
    if (parts.trigger) parts.trigger.rotation.x = c.firing ? -0.25 : 0;

    if (this.climbBlend <= 0.002 && mant < 0) this.freeL.b = 0;
    if (this.isRevolver) {
      this.rev.plan = null;
      revolverIdle(this.rev, parts, dt, (e) => this.onEvent(e));
    }
    const a = this.action;
    if (!a || a.type !== 'nvg') this.goggles.visible = false;
    this.camRoll = 0;
    if (def.cls === 'Melee') {
      knifeCarry(pos, rot);
      if (a && (a.type === 'knifeSlash' || a.type === 'knifeStab' || a.type === 'knifeKill')) knifeAction(a.type, a.data, clamp(a.t + dt / a.dur, 0, 1), pos, rot, { freeL: this.freeL });
    }
    if (a) {
      // actions can pause at a point while a button is held (cooking a grenade)
      const holdAt = a.data?.holdAt as number | undefined;
      if (holdAt !== undefined && a.t >= holdAt && a.data.hold?.()) a.t = holdAt;
      else a.t += dt / a.dur;
      const t = clamp(a.t, 0, 1);
      for (let i = 0; i < a.events.length; i++) {
        if (!a.fired.has(i) && t >= a.events[i][0]) {
          a.fired.add(i);
          this.onEvent(a.events[i][1]);
        }
      }
      const r = this.animate(a, t, pos, rot, { leftTarget, leftQ, setLeft: (b: number, pose: FingerPose) => { leftBlend = b; leftPose = pose; leftMode = b > 0 ? 'free' : 'grip'; }, setRight: (b: number) => { rightFree = b; }, rightTarget, rightQ });
      void r;
      if (a.t >= 1) {
        const done = a.onDone;
        this.action = null;
        this.resetParts();
        done?.();
      }
    }

    // ---------------- apply weapon transform ----------------
    this.weaponPivot.position.copy(pos);
    this.weaponPivot.rotation.set(rot.x, rot.y, rot.z, 'YXZ');
    this.weaponPivot.updateMatrixWorld(true);

    // ---------------- hands (IK) ----------------
    const toRoot = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const sockR = this.model.sockets.rightHand;
    const sockL = this.model.sockets.leftHand;
    const wr = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    const local = (o: THREE.Object3D, p: THREE.Vector3, q: THREE.Quaternion) => {
      const m = new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
      m.decompose(p, q, ws);
    };
    local(sockR, wr, wq);
    this.anchorWrist('R', sockR, wr, wq);
    if (rightFree > 0) {
      // rightTarget/rightQ are given in weapon space
      const p2 = rightTarget.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, this.weaponPivot.matrixWorld));
      const q2 = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(toRoot, this.weaponPivot.matrixWorld)).multiply(rightQ);
      wr.lerp(p2, rightFree);
      wq.slerp(q2, rightFree);
    }
    if (this.freeR.b > 0) {
      wr.lerp(this.freeR.p, this.freeR.b);
      wq.slerp(this.freeR.q, this.freeR.b);
    }
    const poleR = new THREE.Vector3(1, -0.55, 0.1).normalize();
    const poseR = this.freeR.b > 0.5 ? POSES.hold : c.firing ? POSES.trigger : POSES.grip;
    if (this.rig) {
      this.rig.solve('R', wr.distanceTo(this.shoulderR) > 0.56 ? this.shoulderR.clone().lerp(wr, (wr.distanceTo(this.shoulderR) - 0.56) / wr.distanceTo(this.shoulderR)) : this.shoulderR, wr, wq, poleR);
      // fingers wrap the actual grip; the trigger finger keeps its authored place
      const heldR = this.freeR.b > 0.5 && this.grenade.visible && this.grenade.userData.twoHand ? this.heldSDF() : null;
      const wrapR = this.freeR.b > 0.5 ? (heldR ? this.rig.wrapPose('R', heldR, this.freeRPose) : poseR) : { ...this.cachedWrap('R', sockR, poseR, ['index']), index: poseR.index };
      this.rig.pose('R', wrapR, rightFree > 0 ? POSES.pinch : undefined, rightFree);
    } else {
      this.right.solve(this.shoulderR, wr, wq, poleR);
      this.right.hand.setPose(poseR, rightFree > 0 ? POSES.pinch : undefined, rightFree);
    }

    const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
    local(sockL, lp, lq);
    this.anchorWrist('L', sockL, lp, lq);
    if (leftBlend > 0) {
      const wm = new THREE.Matrix4().multiplyMatrices(toRoot, this.weaponPivot.matrixWorld);
      const p2 = leftTarget.clone().applyMatrix4(wm);
      const q2 = new THREE.Quaternion().setFromRotationMatrix(wm).multiply(leftQ);
      lp.lerp(p2, leftBlend);
      lq.slerp(q2, leftBlend);
    }
    if (this.isRevolver && this.rev.plan) {
      revolverLate(
        this.rev, parts, toRoot, this.model.root.userData.rev,
        (an, q, r) => this.wristFor(an, q, r),
        (wr, q) => {
          const palm = this.rig ? this.rig.palmOffset('L', new THREE.Vector3()) : new THREE.Vector3(0.003, -0.007, -0.072);
          palm.y -= this.rig ? this.rig.palmDepth('L') : 0.014;
          return wr.clone().add(palm.applyQuaternion(q));
        },
        this.freeL, this.root,
      );
    } else if (this.isRevolver && parts.loader) parts.loader.visible = false;
    if (this.freeL.b > 0) {
      lp.lerp(this.freeL.p, this.freeL.b);
      lq.slerp(this.freeL.q, this.freeL.b);
      if (this.freeL.b > leftBlend) {
        leftBlend = this.freeL.b;
        leftPose = this.freeL.pose;
      }
    }
    // grenade sits in the left palm
    if (this.grenade.visible && !this.grenade.userData.twoHand) {
      const hold = Viewmodel.HOLD[this.grenade.userData.kind ?? 'frag'] ?? Viewmodel.HOLD.frag;
      const palm = this.rig ? this.rig.palmOffset('L', new THREE.Vector3()) : new THREE.Vector3(0.003, -0.007, -0.072);
      palm.y -= (this.rig ? this.rig.palmDepth('L') : 0.014) + hold.off;
      if (hold.p) palm.add(hold.p);
      this.grenade.position.copy(lp).add(palm.applyQuaternion(lq));
      this.grenade.quaternion.copy(lq).multiply(hold.q ?? new THREE.Quaternion().setFromEuler(new THREE.Euler(...hold.e)));
    }
    // tactical sprint: support arm off the gun, pumping in time with the stride
    const tacTarget = this.action ? 0 : clamp(c.tactical, 0, 1) * (1 - leftBlend);
    this.tacArm = damp(this.tacArm, tacTarget, tacTarget > this.tacArm ? 9 : 14, dt);
    if (this.tacArm > 0.002) {
      const sw = Math.sin(c.stepPhase * Math.PI) * (c.foot === 0 ? 1 : -1);
      const fp = new THREE.Vector3(-0.2 + 0.02 * sw, -0.3 + 0.045 * Math.abs(sw) + 0.03 * sw, -0.2 - 0.11 * sw);
      const f = new THREE.Vector3(0.25, -0.35 + 0.25 * sw, -0.9).normalize();
      const n = new THREE.Vector3(1, 0.1, 0);
      n.addScaledVector(f, -n.dot(f)).normalize();
      const Zh = f.clone().negate(), Yh = n.clone().negate();
      const fq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(Yh, Zh), Yh, Zh));
      const k = easeInOutCubic(this.tacArm);
      lp.lerp(fp, k);
      lq.slerp(fq, k);
      if (k > leftBlend) {
        leftBlend = k;
        leftPose = POSES.hold;
      }
    }
    this.leftPoseBlend = damp(this.leftPoseBlend, leftBlend, 20, dt);
    const poleL = new THREE.Vector3(-1, -0.4, 0.15).normalize();
    // the body leans into far reaches (reloads, racking): slide the shoulder toward the hand
    // instead of letting the IK fall short and leave the hand off the magazine
    const reach = (sh: THREE.Vector3, target: THREE.Vector3, max: number) => {
      const d = target.distanceTo(sh);
      return d > max ? sh.clone().lerp(target, (d - max) / d) : sh;
    };
    const armMax = 0.56;
    if (this.rig) {
      this.rig.solve('L', reach(this.shoulderL, lp, armMax), lp, lq, poleL);
      const baseL = POSES[sockL.userData.pose as string] ?? POSES.support;
      // on the gun: wrap the handguard / grip; off the gun: wrap whatever the hand is holding
      const onGun = this.leftPoseBlend < 0.98 ? this.cachedWrap('L', sockL, baseL) : baseL;
      const held = this.heldSDF();
      const offGun = held && this.leftPoseBlend > 0.02 ? this.rig.wrapPose('L', held, leftPose) : leftPose;
      this.rig.pose('L', onGun, offGun, this.leftPoseBlend);
    } else {
      this.left.solve(this.shoulderL, lp, lq, poleL);
      this.left.hand.setPose(POSES[sockL.userData.pose as string] ?? POSES.support, leftPose, this.leftPoseBlend);
    }

    // attached magazine follows the left hand
    if (parts.mag && parts.mag.parent === this.left.hand.root) {
      /* positioned in animate() */
    }

    // muzzle flash light
    this.muzzleFlashT = Math.max(0, this.muzzleFlashT - dt * 22);
    const muz = new THREE.Vector3();
    this.model.sockets.muzzle.getWorldPosition(muz);
    this.flashLight.position.copy(muz);
    this.flashLight.intensity = this.muzzleFlashT > 0 && !def.sound.suppressed ? 2.4 * this.muzzleFlashT : 0;
    // indoor dims sunlight on the viewmodel
    this.lighting.intensity = lerp(2.6, 0.35, c.indoor) * this.daylight;
    this.ambient.intensity = lerp(0.55, 0.3, c.indoor) * (0.35 + 0.65 * this.daylight);
  }

  /**
   * Grip-surface sockets (userData.r) mark a point on the grip axis: put the palm centre on the
   * grip surface and solve back to the wrist joint the IK drives.
   */
  private anchorWrist(side: 'R' | 'L', sock: THREE.Object3D, wrist: THREE.Vector3, q: THREE.Quaternion) {
    const r = sock.userData.r as number | undefined;
    if (r === undefined) return;
    const palm = this.rig ? this.rig.palmOffset(side, this.tmpPalm) : this.tmpPalm.set(side === 'R' ? -0.003 : 0.003, -0.007, -0.072);
    const depth = this.rig ? this.rig.palmDepth(side) : 0.014;
    // power grip (vertical foregrip): the grip sits in the curled fingers, just behind the knuckles
    if (sock.userData.fist) palm.multiplyScalar(1.38);
    palm.y -= depth + r;
    wrist.sub(palm.applyQuaternion(q));
  }
  private tmpPalm = new THREE.Vector3();

  /** Procedural animation per action. Mutates pose; sets hand targets (in weapon space). */
  private animate(
    a: Action, t: number, pos: THREE.Vector3, rot: THREE.Vector3,
    h: { leftTarget: THREE.Vector3; leftQ: THREE.Quaternion; setLeft: (b: number, p: FingerPose) => void; setRight: (b: number) => void; rightTarget: THREE.Vector3; rightQ: THREE.Quaternion },
  ) {
    const m = this.model!;
    const def = this.def!;
    const parts = m.parts;
    if (def.id === 'rv357' && revolverAction(this.rev, a.type, t, pos, rot, parts, (e) => this.onEvent(e), this)) return;
    const magWell = m.sockets.magWell?.position ?? new THREE.Vector3();
    const qMag = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.0, Math.PI / 2 + 0.3, 'YXZ')); // hand gripping a mag from the left side
    const handOnMag = (dv: number, du: number, dw: number) => h.leftTarget.set(magWell.x - 0.045 + dw, magWell.y - 0.06 + dv, magWell.z + du);

    switch (a.type) {
      case 'draw': {
        const e = 1 - easeInOutCubic(t);
        pos.y -= 0.22 * e;
        pos.x += 0.04 * e;
        rot.x -= 0.9 * e;
        rot.y += 0.3 * e;
        rot.z += 0.2 * Math.sin(t * Math.PI) * 0.5;
        break;
      }
      case 'holster': {
        const e = easeInOutCubic(t);
        pos.y -= 0.24 * e;
        rot.x -= 0.8 * e;
        rot.z -= 0.3 * e;
        break;
      }
      case 'inspect': {
        // per-weapon inspect: each class shows itself off differently (see INSPECT below)
        const spec = INSPECT[def.cls] ?? INSPECT['Assault Rifle'];
        pos.add(kv(t, spec.pos));
        rot.add(kv(t, spec.rot));
        spec.extra?.(t, parts, this, h, magWell);
        break;
      }
      case 'inspectMag': {
        // magazine / chamber check
        const cls = def.cls;
        const k = kf(t, [[0, 0], [0.16, 1], [0.84, 1], [1, 0]]);
        if (cls === 'Shotgun') {
          // press-check: ease the pump back to see the shell, then close
          rot.z += -0.55 * k;
          rot.y += 0.2 * k;
          rot.x += 0.1 * k;
          pos.add(new THREE.Vector3(-0.03, 0.04, -0.04).multiplyScalar(k));
          const back = kf(t, [[0.3, 0], [0.45, 1], [0.65, 1], [0.78, 0]]);
          if (parts.pump) parts.pump.position.z = this.pumpHome.z + 0.035 * back;
          if (parts.bolt) parts.bolt.position.z = 0.035 * back;
          break;
        }
        if (cls === 'Sniper') {
          // lift the bolt, draw it a little to see the round, close it
          rot.z += 0.24 * k;
          rot.y += 0.16 * k;
          rot.x += 0.06 * k;
          pos.add(new THREE.Vector3(-0.025, 0.01, -0.01).multiplyScalar(k));
          const lift = kf(t, [[0.2, 0], [0.32, 1], [0.7, 1], [0.8, 0]]);
          const draw = kf(t, [[0.32, 0], [0.42, 1], [0.6, 1], [0.7, 0]]);
          if (parts.bolt) {
            parts.bolt.rotation.z = lift * 1.2;
            parts.bolt.position.z = this.boltHome.z + 0.03 * draw;
          }
          const knob = new THREE.Vector3(0.062, 0, 0.04).applyEuler(new THREE.Euler(0, 0, lift * 1.2)).add(new THREE.Vector3(0, 0.04, this.boltHome.z + 0.03 * draw));
          h.rightTarget.copy(knob).add(new THREE.Vector3(0.035, -0.01, 0.07));
          h.rightQ.setFromEuler(new THREE.Euler(-0.4, 0.4, -1.2, 'YXZ'));
          h.setRight(kf(t, [[0.12, 0], [0.22, 1], [0.8, 1], [0.9, 0]]));
          if (t > 0.3 && t < 0.31) this.onEvent('boltOpen');
          if (t > 0.72 && t < 0.73) this.onEvent('boltClose');
          break;
        }
        if (this.clip) {
          const ct = kf(t, [[0, 0], [0.42, 1], [0.66, 1], [0.92, 0]]) * this.magCheckT;
          this.animateClip(ct, pos, rot, h);
          const look = kf(t, [[0.38, 0], [0.48, 1], [0.62, 1], [0.72, 0]]);
          rot.x += 0.14 * look;
          rot.z += -0.12 * look;
          if (t > 0.76 && t < 0.775) this.onEvent('magIn');
          if (t > 0.86 && t < 0.875) this.onEvent('magTap');
          break;
        }
        // box magazines: roll the gun, thumb the release, slide the mag out, look at the top round, seat it
        const pistol = cls === 'Pistol';
        rot.z += (pistol ? -0.7 : -0.6) * k;
        rot.y += 0.28 * k;
        rot.x += 0.12 * k + 0.12 * kf(t, [[0.4, 0], [0.5, 1], [0.66, 1], [0.74, 0]]);
        pos.add(new THREE.Vector3(-0.035, 0.05, -0.05).multiplyScalar(k));
        const drop = kf(t, [[0.3, 0], [0.42, 1], [0.66, 1], [0.76, 0]]) * (pistol ? 0.032 : 0.058);
        const reach = kf(t, [[0.08, 0], [0.26, 1], [0.82, 1], [0.95, 0]]);
        if (parts.mag) parts.mag.position.y = this.magHome.y - drop;
        handOnMag(-drop, 0, 0);
        h.leftQ.copy(qMag);
        h.setLeft(reach, POSES.pinch);
        if (t > 0.3 && t < 0.315) this.onEvent('magOut');
        if (t > 0.74 && t < 0.755) this.onEvent('magIn');
        if (t > 0.8 && t < 0.815) this.onEvent('magTap');
        break;
      }
      case 'melee': {
        // rifle / pistol bash: short wind-up, a hard shove forward-left with a roll, recover
        const wind = kf(t, [[0, 0], [0.16, 1], [0.24, 0]]);
        const hit = kf(t, [[0.16, 0], [0.3, 1], [0.42, 1], [1, 0]]);
        const pistol = def.cls === 'Pistol';
        pos.x += 0.03 * wind - (pistol ? 0.06 : 0.1) * hit;
        pos.y += -0.01 * wind + 0.03 * hit;
        pos.z += 0.05 * wind - 0.15 * hit;
        rot.y += 0.28 * wind - (pistol ? 0.4 : 0.6) * hit;
        rot.z += 0.18 * wind - (pistol ? 0.9 : 0.55) * hit;
        rot.x += -0.05 * wind + 0.12 * hit;
        break;
      }
      case 'throw': {
        // lower the gun, bring the grenade up, pull the pin, wind up (holds here while cooking), throw
        const away = kf(t, [[0, 0], [0.12, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.06 * away;
        pos.y -= 0.12 * away;
        pos.z += 0.04 * away;
        rot.x -= 0.4 * away;
        rot.z -= 0.35 * away;
        const fb = kf(t, [[0, 0], [0.14, 1], [0.84, 1], [1, 0]]);
        this.freeL.b = fb;
        kv(t, [[0, [-0.08, -0.3, -0.3]], [0.18, [-0.12, -0.15, -0.34]], [0.3, [-0.11, -0.13, -0.33]], [0.5, [-0.17, 0.0, -0.2]], [0.55, [-0.18, 0.02, -0.18]], [0.68, [-0.03, 0.02, -0.6]], [0.82, [-0.07, -0.22, -0.42]], [1, [-0.08, -0.3, -0.3]]], this.freeL.p);
        const fdir = kv(t, [[0, [0.3, 0.2, -1]], [0.3, [0.3, 0.3, -1]], [0.55, [0.4, 0.6, -0.4]], [0.68, [0.15, 0.1, -1]], [1, [0.2, -0.3, -1]]]);
        const nrm = kv(t, [[0, [0.7, 0.6, 0]], [0.3, [0.8, 0.5, 0.2]], [0.55, [0.6, 0, 0.8]], [0.68, [0.2, 0.4, -1]], [1, [0.6, 0.6, 0]]]);
        this.freeL.q.copy(handQ(fdir, nrm));
        this.freeL.pose = POSES.hold;
        this.grenade.visible = t > 0.06 && t < 0.66;
        const ring = this.grenade.getObjectByName('ring');
        if (t < 0.02 && !this.grenade.userData.kind) this.grenade.userData.kind = 'frag';
        if (ring) ring.visible = t < 0.27;
        // pin pull jerk
        const jerk = win(t, 0.24, 0.3) * (1 - win(t, 0.3, 0.36));
        this.freeL.p.x -= 0.02 * jerk;
        break;
      }
      case 'stim': {
        // one-handed: the left hand brings the injector up low on the left, thumb flicks the cap,
        // a short wind-up and a jab down into the thigh, then back to the gun. The right hand keeps
        // the gun up and can fire throughout.
        const away = kf(t, [[0, 0], [0.12, 1], [0.84, 1], [1, 0]]);
        pos.x += 0.012 * away;
        pos.y -= 0.01 * away;
        rot.z -= 0.05 * away;
        this.freeL.b = kf(t, [[0, 0], [0.13, 1], [0.86, 1], [1, 0]]);
        kv(t, [
          [0, [-0.17, -0.34, -0.28]], [0.2, [-0.152, -0.142, -0.27]], [0.34, [-0.148, -0.132, -0.27]], [0.38, [-0.146, -0.127, -0.268]],
          [0.47, [-0.148, -0.115, -0.262]], [0.55, [-0.16, -0.37, -0.22]], [0.7, [-0.16, -0.36, -0.22]], [1, [-0.17, -0.34, -0.28]],
        ], this.freeL.p);
        // fist upright, knuckles out to the left, injector pointing down past the little finger
        const fd = kv(t, [[0, [0.3, -0.2, -1]], [0.2, [0.25, 0.05, -1]], [0.47, [0.2, 0.25, -1]], [0.55, [0.25, -0.35, -1]], [1, [0.3, -0.2, -1]]]);
        this.freeL.q.copy(handQ(fd, new THREE.Vector3(1, 0.05, 0.25)));
        this.freeL.pose = POSES.grip;
        this.grenade.visible = t > 0.05 && t < 0.8;
        const cap = this.grenade.getObjectByName('cap');
        if (cap) cap.visible = t < 0.38;
        if (t > 0.36 && t < 0.41) this.freeL.p.y += 0.008; // cap flick
        break;
      }
      case 'uav': {
        // one-handed: the tablet comes up on the left, thumb on LAUNCH; the gun stays up in the right
        const away = kf(t, [[0, 0], [0.15, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.015 * away;
        pos.y -= 0.012 * away;
        rot.z -= 0.05 * away;
        this.freeL.b = kf(t, [[0, 0], [0.18, 1], [0.84, 1], [1, 0]]);
        const press = kf(t, [[0, 0], [0.48, 0], [0.53, 1], [0.6, 0]]);
        kv(t, [[0, [-0.18, -0.34, -0.2]], [0.22, [-0.146, -0.076, -0.236]], [0.46, [-0.144, -0.073, -0.236]], [0.8, [-0.145, -0.075, -0.236]], [1, [-0.18, -0.34, -0.2]]], this.freeL.p);
        // the press: a small dip of the whole tablet toward the thumb
        this.freeL.p.x += 0.002 * press;
        this.freeL.p.y -= 0.005 * press;
        this.freeL.p.z -= 0.004 * press;
        this.freeL.q.copy(Viewmodel.PHONE_HAND);
        this.freeL.pose = POSES.open;
        this.grenade.visible = t > 0.06 && t < 0.92;
        const scr = this.grenade.getObjectByName('screen') as THREE.Mesh | undefined;
        if (scr) (scr.material as THREE.MeshBasicMaterial).map = t > 0.53 ? Viewmodel.phoneTexPressed : Viewmodel.phoneTex;
        break;
      }
      case 'nvg': {
        // left hand up to the goggle mount, swing the tubes down over the eyes (or flip them up)
        const on = !!a.data?.on;
        const away = kf(t, [[0, 0], [0.18, 1], [0.76, 1], [1, 0]]);
        pos.x += 0.035 * away;
        pos.y -= 0.03 * away;
        pos.z += 0.01 * away;
        rot.z -= 0.14 * away;
        rot.x -= 0.06 * away;
        const UP = -1.62;
        const sw = on
          ? UP + (0 - UP) * easeInOutCubic(smoothstep(0.3, 0.6, t))
          : UP * easeInOutCubic(smoothstep(0.27, 0.58, t));
        // the last part of the swing seats them on the face (the image cuts to the tubes there)
        const near = on ? easeInOutCubic(smoothstep(0.5, 0.585, t)) : 1 - easeInOutCubic(smoothstep(0.27, 0.36, t));
        const grip = this.gogglePose(sw, near);
        this.goggles.visible = on ? t > 0.3 && t < 0.578 : t > 0.3 && t < 0.7;
        // reach (gun -> mount), hold while it swings, back to the gun
        this.freeL.b = on ? kf(t, [[0, 0], [0.26, 1], [0.66, 1], [0.92, 0]]) : kf(t, [[0, 0], [0.24, 1], [0.64, 1], [0.92, 0]]);
        const hold = on ? (t < 0.3 ? this.gogglePose(UP) : grip) : t < 0.27 ? this.gogglePose(0, 1) : grip;
        this.gogglePose(sw, near);
        // slight lag + squeeze toward the face so the hand reads as pulling on the mount
        this.freeL.p.copy(hold).add(new THREE.Vector3(-0.012, -0.008, -0.01));
        this.freeL.q.copy(handQ(new THREE.Vector3(0.15, 0.45 + sw * 0.25, -1), new THREE.Vector3(1, -0.15, 0.1)));
        this.freeL.pose = POSES.grip;
        break;
      }
      case 'designate': {
        // laser designator raised in the left hand and pointed downrange (held until you confirm)
        const away = kf(t, [[0, 0], [0.2, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.06 * away;
        pos.y -= 0.08 * away;
        rot.x -= 0.25 * away;
        rot.z -= 0.25 * away;
        this.freeL.b = kf(t, [[0, 0], [0.2, 1], [0.85, 1], [1, 0]]);
        kv(t, [[0, [-0.1, -0.3, -0.3]], [0.3, [-0.07, -0.13, -0.3]], [0.5, [-0.07, -0.125, -0.3]], [0.56, [-0.07, -0.125, -0.31]], [0.7, [-0.07, -0.13, -0.3]], [1, [-0.1, -0.3, -0.3]]], this.freeL.p);
        this.freeL.q.copy(handQ(new THREE.Vector3(1, 0.05, 0.1), new THREE.Vector3(0, 1, 0)));
        this.freeL.pose = POSES.grip;
        this.grenade.visible = t > 0.05 && t < 0.92;
        break;
      }
      case 'claymore': {
        // Two hands: the gun drops away, the mine comes up off the vest and is held out at chest
        // height (thumbs flick the scissor legs out, the tripwire module wakes up). It holds there
        // while [G] is held; on release you crouch into it, set it down on its legs, press it into
        // the ground and the hands come back to the gun.
        const it = this.grenade;
        const away = kf(t, [[0, 0], [0.14, 1], [0.78, 1], [0.97, 0]]);
        pos.y -= 0.36 * away;
        pos.x += 0.1 * away;
        pos.z += 0.05 * away;
        rot.x -= 0.95 * away;
        rot.z -= 0.5 * away;
        rot.y += 0.25 * away;
        const hb = kf(t, [[0, 0], [0.15, 1], [0.7, 1], [0.86, 0]]);
        this.freeL.b = hb;
        this.freeR.b = hb;
        const ip = kv(t, [[0, [0.02, -0.42, -0.26]], [0.16, [0, -0.108, -0.33]], [0.3, [0, -0.1, -0.335]], [0.36, [0, -0.103, -0.34]], [0.46, [0, -0.18, -0.41]], [0.57, [0, -0.36, -0.5]], [0.64, [0, -0.38, -0.5]], [1, [0, -0.38, -0.5]]]);
        // breathing while it is held out, and the little settle as the legs snap open
        const holding = win(t, 0.3, 0.34) * (1 - win(t, 0.36, 0.4));
        ip.y += Math.sin(this.t * 2.1) * 0.0035 * holding;
        ip.x += Math.sin(this.t * 1.3) * 0.002 * holding;
        const snap = win(t, 0.27, 0.29) * (1 - win(t, 0.29, 0.34));
        ip.y -= 0.006 * snap;
        it.position.copy(ip);
        const rx = kf(t, [[0, 0.55], [0.16, 0.14], [0.36, 0.1], [0.5, -0.06], [0.6, 0], [1, 0]]);
        const ry = kf(t, [[0, -0.45], [0.16, 0.05], [0.3, 0], [1, 0]]);
        const rz = kf(t, [[0, 0.4], [0.16, -0.04], [0.3, 0], [1, 0]]);
        it.quaternion.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
        (it.userData.setLegs as (k: number) => void)(kf(t, [[0, 0], [0.18, 0], [0.29, 1], [1, 1]]));
        it.visible = t > 0.02 && t < 0.7;
        setLed(it.getObjectByName('led'), t > 0.33 ? (Math.sin(this.t * 12) > 0 ? 1 : 0.15) : 0);
        // palms on the ends, fingers over the front face, thumbs on top; the thumbs squeeze in to
        // kick the legs out, both hands press down on the plant, then open and lift off
        const press = win(t, 0.55, 0.59) * (1 - win(t, 0.61, 0.66));
        const squeeze = win(t, 0.19, 0.23) * (1 - win(t, 0.27, 0.3));
        const rel = win(t, 0.63, 0.72);
        const pose = rel > 0.3 ? POSES.open : POSES.hold;
        this.gripItem('L', it, 'gripL', new THREE.Vector3(0.12, -0.3, -1), new THREE.Vector3(1, 0, 0), 0, pose, new THREE.Vector3(-0.01 * rel + 0.004 * squeeze, 0.012 * press, 0));
        this.gripItem('R', it, 'gripR', new THREE.Vector3(-0.12, -0.3, -1), new THREE.Vector3(-1, 0, 0), 0, pose, new THREE.Vector3(0.01 * rel - 0.004 * squeeze, 0.012 * press, 0));
        this.freeL.p.y += 0.05 * rel;
        this.freeR.p.y += 0.05 * rel;
        this.freeL.p.z += 0.03 * rel;
        this.freeR.p.z += 0.03 * rel;
        break;
      }
      case 'c4Throw': {
        // One hand: the brick comes up off the chest rig face-up, the thumb presses the receiver
        // (LED goes from blinking to solid), the hand drops back for an underhand swing and lets it
        // go flat and spinning. The gun just tips out of the way.
        const away = kf(t, [[0, 0], [0.12, 1], [0.78, 1], [1, 0]]);
        pos.x += 0.03 * away;
        pos.y -= 0.03 * away;
        rot.z -= 0.12 * away;
        rot.x -= 0.06 * away;
        this.freeL.b = kf(t, [[0, 0], [0.13, 1], [0.84, 1], [1, 0]]);
        kv(t, [
          [0, [-0.14, -0.34, -0.24]], [0.2, [-0.11, -0.15, -0.3]], [0.36, [-0.105, -0.145, -0.305]],
          [0.47, [-0.13, -0.27, -0.2]], [0.53, [-0.13, -0.3, -0.17]], [0.64, [-0.06, -0.09, -0.5]], [0.76, [-0.08, -0.2, -0.44]], [1, [-0.14, -0.34, -0.24]],
        ], this.freeL.p);
        const press = win(t, 0.28, 0.31) * (1 - win(t, 0.32, 0.36));
        this.freeL.p.y -= 0.006 * press;
        // palm up, fingers forward; it rolls to palm-forward through the underhand swing
        const fd = kv(t, [[0, [0.3, -0.3, -1]], [0.2, [0.25, 0.15, -1]], [0.36, [0.25, 0.15, -1]], [0.53, [0.3, -0.7, -0.6]], [0.64, [0.1, 0.45, -1]], [1, [0.3, -0.3, -1]]]);
        const nr = kv(t, [[0, [0.5, 0.8, 0]], [0.2, [0.15, 1, 0.1]], [0.36, [0.15, 1, 0.1]], [0.53, [0.3, 0.4, -0.8]], [0.64, [0.1, 0.5, -1]], [1, [0.5, 0.8, 0]]]);
        this.freeL.q.copy(handQ(fd, nr));
        this.freeL.pose = t > 0.62 ? POSES.open : POSES.hold;
        this.grenade.visible = t > 0.05 && t < 0.64;
        setLed(this.grenade.getObjectByName('led'), t < 0.3 ? (Math.sin(this.t * 18) > 0.4 ? 1 : 0) : 1);
        break;
      }
      case 'detonate': {
        // Remote up in the left fist, thumb flips the safety cover, clacks the button twice
        // (the second one is the shot), then the hand drops away.
        const away = kf(t, [[0, 0], [0.15, 1], [0.75, 1], [1, 0]]);
        pos.x += 0.012 * away;
        pos.y -= 0.012 * away;
        rot.z -= 0.05 * away;
        this.freeL.b = kf(t, [[0, 0], [0.16, 1], [0.8, 1], [1, 0]]);
        kv(t, [[0, [-0.16, -0.36, -0.22]], [0.2, [-0.12, -0.125, -0.29]], [0.5, [-0.118, -0.122, -0.29]], [0.62, [-0.12, -0.13, -0.29]], [1, [-0.16, -0.36, -0.22]]], this.freeL.p);
        const clack = win(t, 0.4, 0.43) * (1 - win(t, 0.44, 0.5));
        this.freeL.p.y -= 0.007 * clack;
        this.freeL.p.z += 0.004 * clack;
        this.freeL.q.copy(handQ(new THREE.Vector3(0.35, 0.2, -1), new THREE.Vector3(1, 0.1, 0.35)));
        this.freeL.pose = POSES.grip;
        const it = this.grenade;
        it.visible = t > 0.05 && t < 0.9;
        const cover = it.getObjectByName('cover');
        if (cover) cover.rotation.x = 1.9 * easeOutBack(win(t, 0.24, 0.32));
        const btn = it.getObjectByName('button');
        if (btn) btn.position.y = 0.0485 - 0.003 * clack;
        setLed(it.getObjectByName('led'), t > 0.42 ? 1 : 0.4);
        if (t > 0.24 && t < 0.28) this.freeL.p.x += 0.004; // thumb flick
        break;
      }
      case 'stickyThrow': {
        // Thumb arms it (button sinks, LED starts racing), a quick look at the gel side, then a
        // high over-the-shoulder wind-up (holds here while [G] is held to aim) and a snappy
        // overhand throw with a wrist flick.
        const away = kf(t, [[0, 0], [0.12, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.07 * away;
        pos.y -= 0.12 * away;
        pos.z += 0.03 * away;
        rot.x -= 0.42 * away;
        rot.z -= 0.3 * away;
        this.freeL.b = kf(t, [[0, 0], [0.14, 1], [0.84, 1], [1, 0]]);
        kv(t, [
          [0, [-0.08, -0.3, -0.3]], [0.18, [-0.1, -0.13, -0.32]], [0.28, [-0.1, -0.125, -0.32]], [0.38, [-0.13, -0.14, -0.3]],
          [0.5, [-0.2, 0.05, -0.12]], [0.55, [-0.21, 0.07, -0.1]], [0.66, [-0.02, 0.0, -0.62]], [0.8, [-0.06, -0.24, -0.42]], [1, [-0.08, -0.3, -0.3]],
        ], this.freeL.p);
        const fdir = kv(t, [[0, [0.3, 0.2, -1]], [0.28, [0.2, 0.4, -1]], [0.38, [0.6, 0.2, -0.8]], [0.55, [0.3, 0.9, -0.2]], [0.66, [0.1, -0.2, -1]], [1, [0.2, -0.3, -1]]]);
        const nrm = kv(t, [[0, [0.7, 0.6, 0]], [0.28, [0.6, 0.7, 0.2]], [0.38, [0.3, 0.9, 0.3]], [0.55, [0.7, 0, 0.7]], [0.66, [0.1, 0.5, -1]], [1, [0.6, 0.6, 0]]]);
        this.freeL.q.copy(handQ(fdir, nrm));
        this.freeL.pose = POSES.hold;
        const press = win(t, 0.22, 0.25) * (1 - win(t, 0.26, 0.3));
        this.freeL.p.y -= 0.005 * press;
        const it = this.grenade;
        it.visible = t > 0.06 && t < 0.66;
        const btn = it.getObjectByName('btn');
        if (btn) btn.position.y = 0.046 - 0.003 * press;
        setLed(it.getObjectByName('led'), t > 0.24 ? (Math.sin(this.t * 30) > 0 ? 1 : 0.1) : 0);
        break;
      }
      case 'snapshotThrow': {
        // Puck flat in the palm: a firm wrist roll twists the cap a quarter turn (detent clicks,
        // the sensor band lights up and pulses), then a low underhand bowl along the ground.
        const away = kf(t, [[0, 0], [0.12, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.04 * away;
        pos.y -= 0.06 * away;
        rot.z -= 0.18 * away;
        rot.x -= 0.15 * away;
        this.freeL.b = kf(t, [[0, 0], [0.13, 1], [0.84, 1], [1, 0]]);
        kv(t, [
          [0, [-0.12, -0.34, -0.26]], [0.18, [-0.1, -0.15, -0.31]], [0.42, [-0.1, -0.15, -0.31]],
          [0.52, [-0.14, -0.3, -0.16]], [0.57, [-0.13, -0.33, -0.14]], [0.67, [-0.05, -0.18, -0.55]], [0.8, [-0.08, -0.24, -0.42]], [1, [-0.12, -0.34, -0.26]],
        ], this.freeL.p);
        // the twist: the hand rolls ~60° outward and back while the cap turns 90°
        const tw = win(t, 0.22, 0.36);
        const roll = Math.sin(tw * Math.PI) * 1.0;
        const fd = kv(t, [[0, [0.3, -0.2, -1]], [0.18, [0.2, 0.1, -1]], [0.42, [0.2, 0.1, -1]], [0.57, [0.2, -0.8, -0.4]], [0.67, [0.05, 0.3, -1]], [1, [0.3, -0.2, -1]]]);
        const nr = kv(t, [[0, [0.4, 0.9, 0]], [0.18, [0.1, 1, 0.1]], [0.42, [0.1, 1, 0.1]], [0.57, [0.2, 0.3, -1]], [0.67, [0.0, 0.4, -1]], [1, [0.4, 0.9, 0]]]);
        nr.applyAxisAngle(fd.clone().normalize(), roll);
        this.freeL.q.copy(handQ(fd, nr));
        this.freeL.pose = t > 0.66 ? POSES.open : POSES.hold;
        const it = this.grenade;
        it.visible = t > 0.06 && t < 0.67;
        const cap = it.getObjectByName('cap');
        if (cap) cap.rotation.y = -Math.PI / 2 * easeInOutCubic(tw);
        const ring = it.getObjectByName('ring') as THREE.Mesh | undefined;
        if (ring) (ring.material as THREE.MeshBasicMaterial).color.setRGB(0.15, 0.45, 0.9).multiplyScalar(t > 0.34 ? 1.5 + 2.5 * (0.5 + 0.5 * Math.sin(this.t * 14)) : 0.4);
        break;
      }
      case 'decoyThrow': {
        // Thumb taps the program button three times (LED blinks each time), a glance, then a flat
        // side-arm flick across the body.
        const away = kf(t, [[0, 0], [0.12, 1], [0.8, 1], [1, 0]]);
        pos.x += 0.05 * away;
        pos.y -= 0.07 * away;
        rot.z -= 0.22 * away;
        rot.x -= 0.12 * away;
        this.freeL.b = kf(t, [[0, 0], [0.13, 1], [0.84, 1], [1, 0]]);
        kv(t, [
          [0, [-0.1, -0.32, -0.28]], [0.18, [-0.1, -0.13, -0.31]], [0.42, [-0.1, -0.13, -0.31]],
          [0.5, [-0.24, -0.1, -0.22]], [0.54, [-0.25, -0.1, -0.21]], [0.62, [0.02, -0.08, -0.5]], [0.78, [-0.06, -0.22, -0.42]], [1, [-0.1, -0.32, -0.28]],
        ], this.freeL.p);
        let tap = 0;
        for (const tt of [0.22, 0.29, 0.36]) tap = Math.max(tap, win(t, tt, tt + 0.02) * (1 - win(t, tt + 0.025, tt + 0.05)));
        this.freeL.p.y -= 0.004 * tap;
        const fd = kv(t, [[0, [0.3, 0.2, -1]], [0.18, [0.25, 0.35, -1]], [0.42, [0.25, 0.35, -1]], [0.54, [-0.5, 0.3, -0.8]], [0.62, [1, 0.1, -0.6]], [1, [0.2, -0.3, -1]]]);
        const nr = kv(t, [[0, [0.7, 0.6, 0]], [0.18, [0.8, 0.5, 0.2]], [0.42, [0.8, 0.5, 0.2]], [0.54, [0.6, 0.2, 0.7]], [0.62, [0.2, 0.3, -1]], [1, [0.6, 0.6, 0]]]);
        this.freeL.q.copy(handQ(fd, nr));
        this.freeL.pose = t > 0.6 ? POSES.open : POSES.hold;
        const it = this.grenade;
        it.visible = t > 0.06 && t < 0.6;
        const btn = it.getObjectByName('btn');
        if (btn) btn.position.y = 0.064 - 0.0025 * tap;
        setLed(it.getObjectByName('led'), tap > 0.2 ? 1 : t > 0.4 ? 0.6 : 0);
        break;
      }
      case 'trophy': {
        // Heavy two-handed deploy: the gun swings down out of the way, both hands haul the trophy
        // up by its side handles (the weight drags it down on arrival), legs snap out, then both
        // arms shove it forward and down onto the ground in front; arms recover, gun comes back.
        const it = this.grenade;
        const away = kf(t, [[0, 0], [0.13, 1], [0.76, 1], [0.97, 0]]);
        pos.y -= 0.4 * away;
        pos.x += 0.12 * away;
        pos.z += 0.06 * away;
        rot.x -= 1.05 * away;
        rot.z -= 0.55 * away;
        rot.y += 0.3 * away;
        const hb = kf(t, [[0, 0], [0.13, 1], [0.66, 1], [0.84, 0]]);
        this.freeL.b = hb;
        this.freeR.b = hb;
        const ip = kv(t, [
          [0, [0, -0.55, -0.3]], [0.2, [0, -0.2, -0.42]], [0.25, [0, -0.222, -0.425]], [0.3, [0, -0.207, -0.425]], [0.42, [0, -0.21, -0.43]],
          [0.5, [0, -0.25, -0.36]], [0.6, [0, -0.32, -0.78]], [0.68, [0, -0.5, -0.95]], [1, [0, -0.5, -0.95]],
        ]);
        // weight: a dip as it arrives, a slow heave while held
        ip.y += Math.sin(this.t * 1.8) * 0.002 * win(t, 0.3, 0.34) * (1 - win(t, 0.42, 0.46));
        it.position.copy(ip);
        const rx = kf(t, [[0, 0.3], [0.2, -0.42], [0.3, -0.45], [0.42, -0.45], [0.5, -0.2], [0.6, -0.6], [1, -0.6]]);
        const ry = kf(t, [[0, 0.5], [0.2, -0.04], [0.3, 0], [1, 0]]);
        const rz = kf(t, [[0, -0.3], [0.2, 0.03], [0.3, 0], [1, 0]]);
        it.quaternion.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
        (it.userData.setLegs as (k: number) => void)(easeOutBack(win(t, 0.32, 0.42)));
        const head = it.getObjectByName('head');
        if (head) head.rotation.y = t > 0.4 ? (t - 0.4) * 9 : 0;
        setLed(it.getObjectByName('lamp'), t > 0.42 ? (Math.sin(this.t * 10) > 0 ? 1 : 0.2) : 0);
        it.visible = t > 0.02 && t < 0.64;
        // palms on the side handles, fingers hooked under and forward; on the shove the palms
        // flatten behind it, then open and pull back
        const shove = win(t, 0.5, 0.6);
        const rel = win(t, 0.6, 0.7);
        const pose = rel > 0.3 ? POSES.open : POSES.hold;
        const fL = new THREE.Vector3(0.1, -0.6, -1).lerp(new THREE.Vector3(0.2, 0.5, -1), shove);
        const fR = new THREE.Vector3(-0.1, -0.6, -1).lerp(new THREE.Vector3(-0.2, 0.5, -1), shove);
        this.gripItem('L', it, 'gripL', fL, new THREE.Vector3(1, 0.1 * shove, 0.3 * shove), 0.004, pose);
        this.gripItem('R', it, 'gripR', fR, new THREE.Vector3(-1, 0.1 * shove, 0.3 * shove), 0.004, pose);
        this.freeL.p.z += 0.08 * rel;
        this.freeR.p.z += 0.08 * rel;
        this.freeL.p.y += 0.12 * rel;
        this.freeR.p.y += 0.12 * rel;
        break;
      }
      case 'pump': {
        const back = kf(t, [[0, 0], [0.42, 1], [0.55, 1], [1, 0]]);
        if (parts.pump) parts.pump.position.z = this.pumpHome.z + 0.085 * back;
        if (parts.bolt) parts.bolt.position.z = 0.085 * back;
        rot.z += 0.08 * back;
        rot.x += 0.05 * back;
        pos.z += 0.012 * back;
        break;
      }
      case 'bolt': {
        // lift handle, draw back, push, lock down — right hand follows the knob
        const lift = kf(t, [[0, 0], [0.15, 0], [0.3, 1], [0.75, 1], [0.88, 0]]);
        const draw = kf(t, [[0, 0], [0.3, 0], [0.48, 1], [0.6, 1], [0.76, 0]]);
        const reach = kf(t, [[0, 0], [0.15, 1], [0.9, 1], [1, 0]]);
        if (parts.bolt) {
          parts.bolt.rotation.z = lift * 1.2;
          parts.bolt.position.z = this.boltHome.z + 0.095 * draw;
        }
        rot.z += 0.18 * reach;
        rot.y += 0.12 * reach;
        pos.x -= 0.02 * reach;
        pos.y -= 0.01 * reach;
        // knob position in weapon space
        const knob = new THREE.Vector3(0.062, 0, 0.04).applyEuler(new THREE.Euler(0, 0, lift * 1.2)).add(new THREE.Vector3(0, 0.04, this.boltHome.z + 0.095 * draw));
        h.rightTarget.copy(knob).add(new THREE.Vector3(0.035, -0.01, 0.07));
        h.rightQ.setFromEuler(new THREE.Euler(-0.4, 0.4, -1.2, 'YXZ'));
        h.setRight(reach);
        break;
      }
      case 'reload':
      case 'reloadEmpty': {
        if (t < 0.02) {
          this.reloadFired.clear();
          this.animMem = {};
        }
        if (def.id === 'stille9' || def.id === 'mp18') {
          const ctx: AnimCtx = {
            parts, h, magHome: this.magHome, chargeHome: this.chargeHome, slideHome: this.slideHome,
            wristFor: (an, q, r) => this.wristFor(an, q, r),
            ev: (n) => (n.startsWith('cam') ? this.clipEvent(n) : this.onEvent(n)),
            fired: this.reloadFired, jolt: (u, r, b) => this.jolt(u, r, b), mem: this.animMem,
          };
          (def.id === 'stille9' ? sd9Reload : mp18Reload)(t, a.type === 'reloadEmpty', pos, rot, ctx);
          this.camRoll = rot.z * 0.035;
        } else if (def.id === 'lmg') {
          lmgReload(t, a.type === 'reloadEmpty', pos, rot, parts, h, this.magHome, this.chargeHome, (an, q, r) => this.wristFor(an, q, r),
            (n) => (n.startsWith('cam') ? this.clipEvent(n) : this.onEvent(n)), this.reloadFired, (u, r, b) => this.jolt(u, r, b));
          this.camRoll = rot.z * 0.03;
        } else if (this.clip) this.animateClip(t, pos, rot, h);
        else this.animateReload(a, t, pos, rot, h);
        break;
      }
      case 'breakReload': {
        const bd = a.data as BreakData;
        if (!bd.S) {
          if (parts.barrels) parts.barrels.rotation.x = 0;
          bd.S = this.supportPose();
        }
        breakAction(m, bd, t, pos, rot, h, (e) => this.onEvent(e), this.reloadFired, (u, r, b) => this.jolt(u, r, b));
        break;
      }
      case 'shellStart': {
        const k = easeInOutCubic(t);
        rot.z += -0.55 * k;
        rot.x += 0.12 * k;
        pos.add(new THREE.Vector3(-0.02, 0.05, -0.03).multiplyScalar(k));
        h.setLeft(k, POSES.pinch);
        const lp = m.sockets.loadPort.position;
        h.leftTarget.set(lp.x - 0.04, lp.y - 0.1, lp.z + 0.04);
        h.leftQ.setFromEuler(new THREE.Euler(0.8, 0, Math.PI / 2, 'YXZ'));
        break;
      }
      case 'shell': {
        rot.z += -0.55;
        rot.x += 0.12 + 0.03 * Math.sin(win(t, 0.55, 0.7) * Math.PI);
        pos.add(new THREE.Vector3(-0.02, 0.05, -0.03));
        const lp = m.sockets.loadPort.position;
        const up = kf(t, [[0, 0], [0.45, 1], [0.62, 1.15], [0.75, 0.2], [1, 0]]);
        const fwd = kf(t, [[0, 0], [0.5, 0], [0.65, 1], [1, 1]]);
        h.setLeft(1, POSES.pinch);
        h.leftTarget.set(lp.x - 0.04 + 0.02 * up, lp.y - 0.1 + 0.075 * up, lp.z + 0.04 - 0.04 * fwd);
        h.leftQ.setFromEuler(new THREE.Euler(0.8, 0, Math.PI / 2, 'YXZ'));
        if (parts.shell) {
          parts.shell.visible = t < 0.66;
          parts.shell.position.copy(h.leftTarget).add(new THREE.Vector3(0.03, 0.03, -0.02));
          parts.shell.rotation.set(0, 0, 0);
        }
        break;
      }
      case 'shellEnd': {
        const k = 1 - easeInOutCubic(t);
        rot.z += -0.55 * k;
        rot.x += 0.12 * k;
        pos.add(new THREE.Vector3(-0.02, 0.05, -0.03).multiplyScalar(k));
        h.setLeft(k, POSES.pinch);
        const lp = m.sockets.loadPort.position;
        h.leftTarget.set(lp.x - 0.04, lp.y - 0.1, lp.z + 0.04);
        h.leftQ.setFromEuler(new THREE.Euler(0.8, 0, Math.PI / 2, 'YXZ'));
        if (a.data?.pump) {
          const back = kf(t, [[0.3, 0], [0.62, 1], [0.7, 1], [1, 0]]);
          if (parts.pump) parts.pump.position.z = this.pumpHome.z + 0.085 * back;
          if (parts.bolt) parts.bolt.position.z = 0.085 * back;
        }
        break;
      }
    }
    void smoothstep;
  }


  /** Mag drop state: the old magazine leaves the gun as a world-space physics object. */
  magDropped = false;
  private magTmp = new THREE.Matrix4();

  /** Current magazine transform in viewmodel space (for spawning a world copy). */
  magTransform() {
    const mag = this.model?.parts.mag;
    if (!mag) return null;
    mag.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    this.magTmp.copy(mag.matrixWorld).decompose(p, q, sc);
    return { p, q, mesh: mag };
  }

  /** Spring jolt used when parts seat (mag in, bolt home). */
  jolt(up: number, roll: number, back = 0) {
    // (impulses are in real units since the recoil rework: m/s and rad/s)
    this.recoilP.impulse(0, up * 0.012, back * 0.012);
    this.recoilR.impulse(up * 0.008, 0, roll * 0.012);
  }

  private reloadFired = new Set<string>();
  private once(key: string, f: () => void) {
    if (!this.reloadFired.has(key)) {
      this.reloadFired.add(key);
      f();
    }
  }

  /**
   * Authored reloads. The magazine path is animated in weapon space; the support hand
   * follows the magazine while holding it, otherwise it moves between anchors.
   */
  private animateReload(
    a: Action, t: number, pos: THREE.Vector3, rot: THREE.Vector3,
    h: { leftTarget: THREE.Vector3; leftQ: THREE.Quaternion; setLeft: (b: number, p: FingerPose) => void; setRight: (b: number) => void; rightTarget: THREE.Vector3; rightQ: THREE.Quaternion },
  ) {
    const m = this.model!;
    const def = this.def!;
    const parts = m.parts;
    const mag = parts.mag;
    const empty = a.type === 'reloadEmpty';
    const pistol = def.cls === 'Pistol';
    const sniper = def.cls === 'Sniper';
    if (t < 0.02) this.reloadFired.clear();
    const seg = (a0: number, b0: number, e: (x: number) => number = easeInOutCubic) => e(clamp((t - a0) / (b0 - a0), 0, 1));
    const outBack = (x: number) => easeOutBack(x, 1.4);
    const inQuad = (x: number) => x * x;
    const hold = (a0: number, a1: number, b0: number, b1: number, e: (x: number) => number = easeInOutCubic) => seg(a0, a1, e) * (1 - seg(b0, b1, e));
    const home = this.magHome;
    // grip on a magazine: palm on its left face, fingers wrap the front
    const magGripPos = m.magGrip ? m.magGrip.clone() : new THREE.Vector3(-0.042, -0.075, 0.05);
    const magGripQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, Math.PI / 2, 'YXZ'));
    const belt = new THREE.Vector3(-0.06, -0.5, 0.02);
    const magPos = new THREE.Vector3().copy(home);
    const magRot = new THREE.Euler(0, 0, 0);
    let magVisible = true;
    let handOnMag = 0; // hand follows the magazine
    let handBlend = 0; // hand away from the grip socket
    const free = new THREE.Vector3();
    const freeQ = new THREE.Quaternion().copy(magGripQ);
    let pose: FingerPose = POSES.hold;

    // ------------------------------------------------ timeline
    const T = pistol
      ? empty
        ? { tilt0: 0, tilt1: 0.12, drop: 0.08, fetch0: 0.1, fetch1: 0.38, ins0: 0.38, ins1: 0.48, rel0: 0.54, rel1: 0.7, ret0: 0.72, ret1: 0.92 }
        : { tilt0: 0, tilt1: 0.14, drop: 0.1, fetch0: 0.12, fetch1: 0.5, ins0: 0.5, ins1: 0.62, rel0: 0.62, rel1: 0.62, ret0: 0.66, ret1: 0.9 }
      : empty
        ? { tilt0: 0, tilt1: 0.12, drop: 0.07, fetch0: 0.06, fetch1: 0.38, ins0: 0.38, ins1: 0.52, rel0: 0.56, rel1: 0.68, ret0: 0.7, ret1: 0.92 }
        : { tilt0: 0, tilt1: 0.14, reach0: 0.08, reach1: 0.2, out0: 0.21, out1: 0.33, fetch0: 0.33, fetch1: 0.56, ins0: 0.56, ins1: 0.7, slap0: 0.72, slap1: 0.8, ret0: 0.78, ret1: 0.94, drop: 99, rel0: 1, rel1: 1 };

    // ------------------------------------------------ weapon motion
    const tilt = seg(T.tilt0, T.tilt1, outBack) * (1 - seg(T.ret0 + 0.04, 1.0, outBack));
    if (pistol) {
      pos.add(new THREE.Vector3(-0.04, 0.08, -0.12).multiplyScalar(tilt));
      rot.z += 0.42 * tilt;
      rot.x += 0.3 * tilt;
      rot.y += -0.12 * tilt;
    } else if (m.reloadPose) {
      const rp = m.reloadPose;
      pos.add(new THREE.Vector3(...rp.p).multiplyScalar(tilt));
      rot.x += rp.r[0] * tilt;
      rot.y += rp.r[1] * tilt;
      rot.z += rp.r[2] * tilt;
    } else {
      pos.add(new THREE.Vector3(-0.06, 0.15, -0.21).multiplyScalar(tilt));
      rot.z += -0.7 * tilt;
      rot.x += 0.3 * tilt;
      rot.y += 0.18 * tilt;
    }
    // the weapon leans into the incoming magazine and rocks with the pull
    if (!pistol && !empty) {
      const pull = hold(T.out0!, T.out0! + 0.04, T.out1!, T.out1! + 0.06);
      rot.x += 0.04 * pull;
      rot.z += -0.06 * pull;
    }
    const lean = hold(T.ins0 - 0.08, T.ins0, T.ins1, T.ins1 + 0.08);
    rot.x += 0.05 * lean;
    pos.y += 0.006 * lean;

    // ------------------------------------------------ magazine & support hand
    if (mag) {
      if (!empty && !pistol) {
        // tactical: reach to the mag, unlatch, pull and stow
        const reach = seg(T.reach0!, T.reach1!);
        handBlend = reach;
        handOnMag = reach;
        const unl = seg(T.out0!, T.out0! + 0.03);
        const pull = seg(T.out0! + 0.03, T.out1!, inQuad);
        const stow = seg(T.out1!, T.out1! + 0.1);
        if (t < T.fetch0) {
          magPos.y -= 0.008 * unl + 0.1 * pull + 0.28 * stow;
          magPos.z += 0.03 * pull + 0.08 * stow;
          magPos.x -= 0.05 * pull + 0.12 * stow;
          magRot.x = -0.35 * pull - 0.4 * stow;
          magRot.z = 0.4 * pull + 0.6 * stow;
          if (unl > 0) this.once('magOut', () => this.onEvent('magOut'));
          magVisible = stow < 0.9;
        }
      } else {
        // empty / pistol: magazine falls free, hand goes to the belt
        if (t >= T.drop) {
          this.once('drop', () => {
            this.onEvent('magOut');
            this.onEvent('magDrop');
            this.magDropped = true;
          });
        }
        if (t >= T.drop && t < T.fetch1 - 0.05) magVisible = false;
        handBlend = seg(T.fetch0, T.fetch0 + 0.12);
        handOnMag = seg(T.fetch1 - 0.16, T.fetch1 - 0.1);
        free.copy(belt);
      }
      // fetch: new magazine comes up from below-left, lip tilted back
      if (t >= T.fetch0 && t < T.ins1 + 0.02) {
        const f = seg(T.fetch0 + (empty || pistol ? 0.12 : 0), T.fetch1, easeOutCubic);
        const pre = new THREE.Vector3(home.x, home.y - (pistol ? 0.06 : 0.04), home.z + (pistol ? 0 : 0.006));
        const start = new THREE.Vector3(home.x - 0.12, home.y - 0.3, home.z + 0.05);
        if (t >= T.fetch0 + (empty || pistol ? 0.12 : 0) - 0.001) {
          magPos.copy(start.lerp(pre, f));
          magRot.x = pistol ? 0 : -0.38 * (1 - f * 0.25);
          magRot.z = 0.5 * (1 - f);
          magVisible = f > 0.05 || (!empty && !pistol);
          if (empty || pistol) magVisible = f > 0.02;
        }
        if (f > 0.6) this.once('touch', () => this.onEvent('magTouch'));
        // insert: hook the front lip, then rock it home
        const hook = seg(T.ins0, T.ins0 + (T.ins1 - T.ins0) * 0.45);
        const rock = seg(T.ins0 + (T.ins1 - T.ins0) * 0.45, T.ins1, outBack);
        if (t >= T.ins0) {
          magPos.copy(pre).lerp(new THREE.Vector3(home.x, home.y - 0.007, home.z), hook);
          magRot.x = (pistol ? 0 : -0.29) * (1 - rock) + (pistol ? 0 : -0.29 * 0.0);
          if (rock > 0) magPos.lerp(home, rock);
          if (rock > 0.98) {
            this.once('seat', () => {
              this.onEvent('magIn');
              this.jolt(pistol ? 0.9 : 0.7, pistol ? 0.5 : -0.8, -0.2);
            });
          }
        }
      }
      if (t >= T.ins1) {
        magPos.copy(home);
        magRot.x = 0;
        magVisible = true;
        if (this.magDropped) this.magDropped = false;
      }
      mag.position.copy(magPos);
      mag.rotation.copy(magRot);
      mag.visible = magVisible;
    }

    // hand target: on the magazine or at the free anchor
    const magQ = new THREE.Quaternion().setFromEuler(magRot);
    const onMagP = magGripPos.clone().applyQuaternion(magQ).add(magPos);
    const onMagQ = magQ.clone().multiply(magGripQ);
    if (pistol) {
      // support hand cups the bottom of the grip / magazine
      onMagP.copy(magPos).add(new THREE.Vector3(-0.03, -0.11, 0.035));
      onMagQ.setFromEuler(new THREE.Euler(0.7, 0, Math.PI / 2 + 0.15, 'YXZ'));
    }
    h.leftTarget.copy(free).lerp(onMagP, handOnMag);
    h.leftQ.copy(freeQ).slerp(onMagQ, handOnMag);

    // tactical: palm slap on the magazine floorplate
    if (!empty && !pistol && t >= T.ins1) {
      const slap = hold(T.ins1, T.slap0!, T.slap1!, T.ret1);
      const hit = seg(T.slap0!, T.slap0! + 0.03) * (1 - seg(T.slap0! + 0.03, T.slap1!));
      const base = new THREE.Vector3(home.x - 0.01, home.y - 0.24 + 0.035 * hit, home.z + 0.02);
      h.leftTarget.lerp(base, slap);
      h.leftQ.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, 0, Math.PI / 2, 'YXZ')), slap);
      pose = POSES.open;
      if (hit > 0.9) this.once('slap', () => {
        this.onEvent('magTap');
        this.jolt(0.8, -0.3);
      });
      handBlend = 1 - seg(T.ret0, T.ret1);
    }

    // empty: bolt release / slide slingshot / sniper bolt cycle
    if (empty && t >= T.ins1) {
      const k = hold(T.ins1, T.rel0, T.rel1, T.ret1);
      if (pistol && parts.slide) {
        const grab = new THREE.Vector3(0.0, 0.07, 0.07);
        const pull = seg(T.rel0, T.rel0 + 0.08, easeOutCubic) * (1 - seg(T.rel0 + 0.08, T.rel0 + 0.1));
        grab.z += 0.03 * pull;
        h.leftTarget.lerp(grab, k);
        h.leftQ.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0, 'YXZ')), k);
        pose = POSES.pinch;
        parts.slide.position.z = this.slideHome.z + 0.026 * (t < T.rel0 + 0.1 ? Math.max(pull, t < T.rel0 ? 1 : 0) : 0);
        rot.z += 0.15 * k;
        if (t >= T.rel0 + 0.1) this.once('release', () => {
          this.boltLocked = false;
          this.onEvent('slideRelease');
          this.jolt(1.2, 0.6, -0.4);
        });
      } else if (sniper && parts.bolt) {
        const lift = hold(T.rel0, T.rel0 + 0.03, T.rel1 - 0.03, T.rel1);
        const draw = hold(T.rel0 + 0.03, T.rel0 + 0.06, T.rel1 - 0.06, T.rel1 - 0.03);
        parts.bolt.rotation.z = lift * 1.2;
        parts.bolt.position.z = this.boltHome.z + 0.095 * draw;
        const knob = new THREE.Vector3(0.062, 0, 0.04).applyEuler(new THREE.Euler(0, 0, lift * 1.2)).add(new THREE.Vector3(0, 0.04, this.boltHome.z + 0.095 * draw));
        h.rightTarget.copy(knob).add(new THREE.Vector3(0.035, -0.01, 0.07));
        h.rightQ.setFromEuler(new THREE.Euler(-0.4, 0.4, -1.2, 'YXZ'));
        h.setRight(hold(T.ins1, T.rel0, T.rel1, T.ret0 + 0.05));
        if (t >= T.rel0) this.once('bo', () => this.onEvent('boltOpen'));
        if (t >= T.rel1 - 0.03) this.once('bc', () => {
          this.onEvent('boltClose');
          this.jolt(0.5, 0.3);
        });
      } else {
        // palm the bolt catch on the left of the receiver
        const press = seg(T.rel0, T.rel0 + 0.03) * (1 - seg(T.rel0 + 0.05, T.rel1));
        const c = new THREE.Vector3(-0.055 + 0.012 * press, 0.008, -0.045);
        h.leftTarget.lerp(c, k);
        h.leftQ.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.25, Math.PI / 2 - 0.15, 'YXZ')), k);
        pose = POSES.open;
        rot.z += 0.22 * k;
        rot.y += 0.12 * k;
        if (press > 0.9) this.once('release', () => {
          this.boltLocked = false;
          this.onEvent('boltRelease');
          this.jolt(1.4, -0.9, -0.6);
        });
      }
      handBlend = 1 - seg(T.ret0, T.ret1);
    }
    if (t >= T.ret0 && !(empty && t < T.ret1 && !pistol && !sniper)) handBlend = Math.min(handBlend, 1 - seg(T.ret0, T.ret1));
    h.setLeft(handBlend, pose);
    if (t > 0.9) this.once('end', () => this.onEvent('rattle'));
  }

  /** World-ish helpers for FX: socket position in viewmodel camera space. */
  /** A weapon part's position in viewmodel camera space (for spawning its world copy). */
  partCameraSpace(name: string, out = new THREE.Vector3()) {
    const s = this.model?.parts[name];
    if (!s) return out.set(0, 0, -0.5);
    s.updateWorldMatrix(true, false);
    s.getWorldPosition(out);
    return out.applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert());
  }

  socketCameraSpace(name: string, out = new THREE.Vector3()) {
    const s = this.model?.sockets[name];
    if (!s) return out.set(0, 0, -0.5);
    s.updateWorldMatrix(true, false);
    s.getWorldPosition(out);
    return out.applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert());
  }
}
