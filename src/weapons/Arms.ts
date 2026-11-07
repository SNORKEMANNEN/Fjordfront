import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MaterialLib } from '../render/Materials';

/**
 * Hand frame: wrist at origin, fingers along -Z, palm faces -Y, thumb on -X (right hand).
 * The left hand is a mirrored build (thumb on +X).
 */
export interface FingerPose {
  index: [number, number, number];
  middle: [number, number, number];
  ring: [number, number, number];
  pinky: [number, number, number];
  thumb: [number, number, number, number]; // yaw, curl1, curl2, curl3
  spread?: number;
}

export const POSES: Record<string, FingerPose> = {
  grip: { index: [-0.3, -0.6, -0.4], middle: [-1.3, -1.35, -0.85], ring: [-1.35, -1.35, -0.85], pinky: [-1.4, -1.3, -0.85], thumb: [0.4, -1.8, -0.4, -0.2] },
  trigger: { index: [-0.6, -1.05, -0.65], middle: [-1.3, -1.35, -0.85], ring: [-1.35, -1.35, -0.85], pinky: [-1.4, -1.3, -0.85], thumb: [0.4, -1.8, -0.4, -0.2] },
  support: { index: [-0.85, -0.6, -0.3], middle: [-0.95, -0.65, -0.32], ring: [-1.0, -0.7, -0.35], pinky: [-1.05, -0.72, -0.35], thumb: [-0.1, -0.15, -0.25, -0.15], spread: 0.03 },
  vgrip: { index: [-1.15, -1.2, -0.75], middle: [-1.25, -1.3, -0.8], ring: [-1.3, -1.3, -0.8], pinky: [-1.35, -1.25, -0.8], thumb: [-1.0, -0.7, -0.5, -0.3], spread: 0.02 },
  pistolSupport: { index: [-1.1, -1.15, -0.7], middle: [-1.2, -1.25, -0.75], ring: [-1.25, -1.25, -0.75], pinky: [-1.3, -1.2, -0.75], thumb: [0.35, 0.05, -0.05, 0.0], spread: 0.02 },
  open: { index: [-0.15, -0.2, -0.1], middle: [-0.2, -0.25, -0.12], ring: [-0.25, -0.3, -0.15], pinky: [-0.3, -0.35, -0.15], thumb: [0.6, 0.0, -0.1, -0.05], spread: 0.12 },
  hold: { index: [-0.9, -1.0, -0.6], middle: [-1.0, -1.1, -0.6], ring: [-1.05, -1.1, -0.6], pinky: [-1.1, -1.1, -0.6], thumb: [0.4, -0.4, -0.5, -0.3] },
  pinch: { index: [-0.6, -0.8, -0.5], middle: [-0.7, -0.9, -0.55], ring: [-0.95, -1.1, -0.7], pinky: [-1.05, -1.15, -0.7], thumb: [0.2, -0.6, -0.5, -0.3] },
};

interface Finger {
  joints: THREE.Object3D[];
}

export class Hand {
  root = new THREE.Group();
  private fingers: Record<string, Finger> = {};
  private thumbBase!: THREE.Object3D;
  private thumbJoints: THREE.Object3D[] = [];
  current: FingerPose;

  constructor(private mat: THREE.Material, private sideMat: THREE.Material, public mirror: boolean) {
    const sx = mirror ? -1 : 1;
    // palm: slightly tapered box
    const palm = new RoundedBoxGeometry(0.082, 0.026, 0.092, 3, 0.011);
    palm.translate(0, 0.0, -0.05);
    const pm = new THREE.Mesh(palm, mat);
    this.root.add(pm);
    // back-of-hand knuckle armour
    const knuck = new RoundedBoxGeometry(0.07, 0.008, 0.026, 2, 0.003);
    knuck.translate(0, 0.016, -0.083);
    this.root.add(new THREE.Mesh(knuck, sideMat));
    // cuff
    const cuff = new THREE.CylinderGeometry(0.036, 0.04, 0.06, 18);
    cuff.rotateX(Math.PI / 2);
    cuff.scale(1.12, 0.78, 1);
    cuff.translate(0, 0.002, 0.018);
    this.root.add(new THREE.Mesh(cuff, sideMat));
    const strap = new RoundedBoxGeometry(0.05, 0.006, 0.022, 2, 0.002);
    strap.translate(0, 0.018, 0.012);
    this.root.add(new THREE.Mesh(strap, mat));
    // fingers
    const defs: [string, number, number, number[]][] = [
      ['index', -0.03, 0.0098, [0.045, 0.027, 0.022]],
      ['middle', -0.0105, 0.0102, [0.049, 0.03, 0.023]],
      ['ring', 0.0095, 0.0098, [0.046, 0.028, 0.022]],
      ['pinky', 0.028, 0.0088, [0.036, 0.022, 0.019]],
    ];
    for (const [name, x, r, lens] of defs) {
      const joints: THREE.Object3D[] = [];
      let parent: THREE.Object3D = this.root;
      let z = -0.094;
      for (let i = 0; i < 3; i++) {
        const j = new THREE.Object3D();
        j.position.set(i === 0 ? x * sx : 0, i === 0 ? 0.002 : 0, i === 0 ? z : -lens[i - 1]);
        parent.add(j);
        const seg = new THREE.CapsuleGeometry(r * (1 - i * 0.08), Math.max(0.001, lens[i] - r * 1.6), 3, 8);
        seg.rotateX(Math.PI / 2);
        seg.translate(0, 0, -lens[i] / 2);
        seg.scale(1, 0.92, 1);
        const m = new THREE.Mesh(seg, i === 0 ? mat : mat);
        j.add(m);
        joints.push(j);
        parent = j;
      }
      this.fingers[name] = { joints };
    }
    // thumb
    this.thumbBase = new THREE.Object3D();
    this.thumbBase.position.set(-0.034 * sx, -0.006, -0.02);
    this.root.add(this.thumbBase);
    const tl = [0.04, 0.032, 0.026];
    let parent: THREE.Object3D = this.thumbBase;
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Object3D();
      j.position.set(0, 0, i === 0 ? 0 : -tl[i - 1]);
      parent.add(j);
      const rr = i === 0 ? 0.014 : 0.0105;
      const seg = new THREE.CapsuleGeometry(rr, Math.max(0.001, tl[i] - rr * 1.6), 3, 8);
      seg.rotateX(Math.PI / 2);
      seg.translate(0, 0, -tl[i] / 2);
      j.add(new THREE.Mesh(seg, mat));
      this.thumbJoints.push(j);
      parent = j;
    }
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    this.current = { ...POSES.grip };
    this.setPose(POSES.grip);
  }

  /** Apply (optionally blended) finger pose. */
  setPose(p: FingerPose, blendTo?: FingerPose, t = 0) {
    const sx = this.mirror ? -1 : 1;
    const lerp3 = (a: number[], b: number[] | undefined) => (b ? a.map((v, i) => v + (b[i] - v) * t) : a);
    for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
      const c = lerp3(p[name], blendTo?.[name]);
      const f = this.fingers[name];
      const spread = (p.spread ?? 0.02) * ({ index: -1.2, middle: -0.3, ring: 0.4, pinky: 1.2 }[name]) * sx;
      for (let i = 0; i < 3; i++) {
        f.joints[i].rotation.set(c[i], i === 0 ? spread : 0, 0);
      }
    }
    const th = lerp3(p.thumb, blendTo?.thumb);
    // thumb base points diagonally forward/inward
    this.thumbBase.rotation.set(-0.25 + th[1] * 0.4, (0.75 + th[0]) * sx, (-0.6 + th[1]) * sx, 'YXZ');
    this.thumbJoints[1].rotation.set(th[2], 0, 0);
    this.thumbJoints[2].rotation.set(th[3], 0, 0);
  }
}

export class Arm {
  root = new THREE.Group();
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  hand: Hand;
  upperLen = 0.32;
  foreLen = 0.3;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(sleeve: THREE.Material, glove: THREE.Material, gloveSide: THREE.Material, public left: boolean) {
    const ug = new THREE.CylinderGeometry(0.058, 0.05, this.upperLen, 16, 1);
    ug.rotateX(-Math.PI / 2);
    ug.translate(0, 0, -this.upperLen / 2);
    this.upper = new THREE.Mesh(ug, sleeve);
    const fg = new THREE.CylinderGeometry(0.049, 0.039, this.foreLen, 18, 4);
    // cloth bunching: perturb radius
    const pos = fg.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.06 * Math.sin(a * 3 + y * 30) * Math.sin(y * 18) + (y < -0.1 ? 0.08 : 0);
      pos.setXYZ(i, x * k, y, z * k);
    }
    fg.computeVertexNormals();
    fg.rotateX(-Math.PI / 2);
    fg.translate(0, 0, -this.foreLen / 2);
    this.fore = new THREE.Mesh(fg, sleeve);
    // rolled cuff near wrist
    const cuff = new THREE.TorusGeometry(0.041, 0.012, 8, 20);
    cuff.translate(0, 0, 0);
    const cm = new THREE.Mesh(cuff, sleeve);
    cm.position.z = -this.foreLen + 0.03;
    this.fore.add(cm);
    this.hand = new Hand(glove, gloveSide, left);
    this.root.add(this.upper, this.fore, this.hand.root);
    for (const m of [this.upper, this.fore, cm]) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
  }

  /**
   * Solve two-bone IK. All inputs in the parent (camera) space.
   * wristPos/wristQuat: desired hand frame. pole: preferred elbow direction.
   */
  solve(shoulder: THREE.Vector3, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion, pole: THREE.Vector3) {
    const a = this.upperLen, b = this.foreLen;
    const toT = this.tmpA.subVectors(wristPos, shoulder);
    let d = toT.length();
    const dir = toT.clone().divideScalar(Math.max(d, 1e-5));
    d = Math.min(d, (a + b) * 0.999);
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const perp = this.tmpB.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbow = shoulder.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    const wrist = shoulder.clone().addScaledVector(dir, d);
    // orient segments: local -Z along the bone, keep "up" roughly toward pole-opposite
    const orient = (obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, up: THREE.Vector3) => {
      const m = new THREE.Matrix4();
      const z = from.clone().sub(to).normalize(); // +Z points back (bone along -Z)
      const x = new THREE.Vector3().crossVectors(up, z).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      m.makeBasis(x, y, z);
      obj.position.copy(from);
      obj.quaternion.setFromRotationMatrix(m);
    };
    const handUp = new THREE.Vector3(0, 1, 0).applyQuaternion(wristQuat);
    orient(this.upper, shoulder, elbow, perp.clone().negate());
    orient(this.fore, elbow, wrist, handUp.lerp(perp.clone().negate(), 0.5).normalize());
    this.hand.root.position.copy(wristPos);
    this.hand.root.quaternion.copy(wristQuat);
  }
}

export function makeArmMaterials(L: MaterialLib) {
  return {
    sleeve: L.std('camoFabric', { tile: 0.35, roughness: 1, normalScale: 1.2 }, 'arm.sleeve'),
    glove: L.std('glove', { tile: 0.12, roughness: 1, normalScale: 0.8 }, 'arm.glove'),
    gloveSide: L.std('glove', { tile: 0.12, roughness: 0.9, color: 0x7a7468, normalScale: 0.8 }, 'arm.glove2'),
  };
}
