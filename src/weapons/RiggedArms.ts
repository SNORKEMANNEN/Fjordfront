import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FingerPose } from './Arms';

/**
 * Skinned first-person arms ("fps arms" by DJMaesen, CC BY 4.0) driven by
 * two-bone IK. Wrist frames and finger curl axes are derived automatically
 * from the bind pose so the same hand convention as the procedural rig applies:
 *   hand frame: fingers along -Z, palm faces -Y, thumb on -X (right) / +X (left).
 */
export type Side = 'R' | 'L';
const FINGERS = ['index', 'middle', 'ring', 'pinky', 'thumb'] as const;
export type Finger = (typeof FINGERS)[number];

interface Joint {
  bone: THREE.Bone;
  bindQ: THREE.Quaternion;
  curlAxis: THREE.Vector3; // local
  spreadAxis: THREE.Vector3; // local
  bindCurl: number; // curl already present in the bind pose (rad, + = toward palm)
}

interface ArmRig {
  arm: THREE.Bone;
  elbow: THREE.Bone;
  wrist: THREE.Bone;
  upperLen: number;
  foreLen: number;
  wristOffset: THREE.Quaternion; // wristWorld = handFrame * offset
  fingers: Record<Finger, Joint[]>;
  armBindQ: THREE.Quaternion;
  elbowBindQ: THREE.Quaternion;
  wristBindQ: THREE.Quaternion;
  /** wrist -> palm centre, in the hand frame (metres) */
  palm: THREE.Vector3;
  /** palm thickness from the centre line to the skin on the palm side */
  palmDepth: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class RiggedArms {
  root: THREE.Object3D;
  private rigs: Record<Side, ArmRig>;
  mesh: THREE.SkinnedMesh | null = null;

  /** xy scale for arm vertices near the camera (1 = same FOV as the weapon); see prepareMaterial. */
  static armWarp = { value: 1 };

  static async prepareMaterial(gltf: GLTF, sleeveTint = 0xffffff): Promise<THREE.Material> {
    // The source uses KHR_materials_pbrSpecularGlossiness (not supported by three r170): rebuild as metal/rough.
    const json = gltf.parser.json;
    const ext = json.materials?.[0]?.extensions?.KHR_materials_pbrSpecularGlossiness;
    let map: THREE.Texture | null = null;
    if (ext?.diffuseTexture) map = (await gltf.parser.getDependency('texture', ext.diffuseTexture.index)) as THREE.Texture;
    let normalMap: THREE.Texture | null = null;
    const nIdx = json.materials?.[0]?.normalTexture?.index;
    if (nIdx !== undefined) normalMap = (await gltf.parser.getDependency('texture', nIdx)) as THREE.Texture;
    let aoMap: THREE.Texture | null = null;
    const aoIdx = json.materials?.[0]?.occlusionTexture?.index;
    if (aoIdx !== undefined) aoMap = (await gltf.parser.getDependency('texture', aoIdx)) as THREE.Texture;
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshStandardMaterial({ map, normalMap, aoMap, aoMapIntensity: 0.8, roughness: 0.78, metalness: 0.0, color: sleeveTint, envMapIntensity: 0.9 });
    // Arms FOV: the arms get their own field of view without detaching from the weapon. Vertices are
    // re-projected in view space with a depth-dependent factor: at the hands (≈0.3 m and beyond) the
    // factor is 1 so the grip stays glued to the gun; toward the camera (forearms, elbows) it blends to
    // tan(weaponFov/2) / tan(armsFov/2), so a wider arms FOV pushes the forearms out and makes them smaller.
    m.onBeforeCompile = (sh) => {
      sh.uniforms.armWarp = RiggedArms.armWarp;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float armWarp;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          {
            float dz = -mvPosition.z;
            float wgt = 1.0 - smoothstep(0.08, 0.32, dz);
            mvPosition.xy *= mix(1.0, armWarp, wgt);
            gl_Position = projectionMatrix * mvPosition;
          }`,
        );
    };
    return m;
  }

  constructor(gltf: GLTF, material: THREE.Material, upperTarget = 0.3) {
    this.root = gltf.scene;
    this.root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        sm.material = material;
        sm.frustumCulled = false;
        sm.castShadow = false;
        sm.receiveShadow = false;
        this.mesh = sm;
      }
    });
    // normalise scale so the upper arm is ~upperTarget metres
    this.root.updateMatrixWorld(true);
    const find = (n: string) => {
      let b: THREE.Bone | null = null;
      this.root.traverse((o) => {
        if (!b && (o as THREE.Bone).isBone && o.name.startsWith(n)) b = o as THREE.Bone;
      });
      if (!b) throw new Error('arm bone missing: ' + n);
      return b as THREE.Bone;
    };
    const measure = (a: THREE.Object3D, b: THREE.Object3D) => a.getWorldPosition(_v1).distanceTo(b.getWorldPosition(_v2));
    const u0 = measure(find('R_arm'), find('R_elbow'));
    this.root.scale.multiplyScalar(upperTarget / u0);
    this.root.updateMatrixWorld(true);
    const build = (s: Side): ArmRig => {
      const arm = find(`${s}_arm`), elbow = find(`${s}_elbow`), wrist = find(`${s}_wrist`);
      const names: Record<Finger, string> = { index: 'point', middle: 'middle', ring: 'ring', pinky: 'pink', thumb: 'thumb' };
      const chain = (f: Finger) => [1, 2, 3, 4].map((i) => find(`${s}_${names[f]}${i}`));
      const wp = wrist.getWorldPosition(new THREE.Vector3());
      const fDir = chain('middle')[0].getWorldPosition(new THREE.Vector3()).sub(wp).normalize();
      const tRaw = chain('thumb')[0].getWorldPosition(new THREE.Vector3()).sub(wp);
      const tDir = tRaw.addScaledVector(fDir, -tRaw.dot(fDir)).normalize();
      const Zh = fDir.clone().negate();
      const Xh = s === 'R' ? tDir.clone().negate() : tDir.clone();
      const Yh = new THREE.Vector3().crossVectors(Zh, Xh).normalize();
      const Hq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xh, Yh, Zh));
      const wq = wrist.getWorldQuaternion(new THREE.Quaternion());
      const wristOffset = Hq.clone().invert().multiply(wq);
      const palm = Yh.clone().negate();
      const fingers = {} as Record<Finger, Joint[]>;
      for (const f of FINGERS) {
        const bones = chain(f);
        const segs = bones.slice(0, 3).map((bone, i) => bones[i + 1].getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize());
        fingers[f] = bones.slice(0, 3).map((bone, i) => {
          const seg = segs[i];
          // straight reference: the palm direction for the first knuckle, the previous segment after that
          const ref = i === 0 ? (f === 'thumb' ? seg.clone() : fDir.clone()) : segs[i - 1].clone();
          const axisW = new THREE.Vector3().crossVectors(ref, palm);
          if (axisW.lengthSq() < 1e-6) axisW.crossVectors(seg, palm);
          axisW.normalize();
          const bindCurl = Math.atan2(new THREE.Vector3().crossVectors(ref, seg).dot(axisW), ref.dot(seg));
          const bq = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
          return {
            bone,
            bindQ: bone.quaternion.clone(),
            curlAxis: axisW.clone().applyQuaternion(bq).normalize(),
            spreadAxis: palm.clone().applyQuaternion(bq).normalize(),
            bindCurl,
          };
        });
      }
      // palm centre: a bit over half-way from the wrist joint to the middle knuckle, on the palm side
      const m1 = chain('middle')[0].getWorldPosition(new THREE.Vector3());
      const i1 = chain('index')[0].getWorldPosition(new THREE.Vector3());
      const p1 = chain('pinky')[0].getWorldPosition(new THREE.Vector3());
      const knuckles = m1.clone().add(i1).add(p1).multiplyScalar(1 / 3);
      const palmW = wp.clone().lerp(knuckles, 0.62).sub(wp);
      const HqI = Hq.clone().invert();
      const palmLocal = palmW.applyQuaternion(HqI);
      const palmDepth = 0.014 * (this.root.scale.x / this.root.scale.x);
      return {
        palm: palmLocal,
        palmDepth,
        arm, elbow, wrist,
        upperLen: measure(arm, elbow),
        foreLen: measure(elbow, wrist),
        wristOffset, fingers,
        armBindQ: arm.quaternion.clone(),
        elbowBindQ: elbow.quaternion.clone(),
        wristBindQ: wrist.quaternion.clone(),
      };
    };
    this.rigs = { R: build('R'), L: build('L') };
  }

  /** Hand-frame offset from the wrist joint to the palm centre (for grip anchoring). */
  palmOffset(side: Side, out = new THREE.Vector3()) {
    return out.copy(this.rigs[side].palm);
  }
  palmDepth(side: Side) {
    return this.rigs[side].palmDepth;
  }

  /** Two-bone IK. All vectors are in the parent (viewmodel root) space, which is world space for the vm scene. */
  solve(side: Side, shoulder: THREE.Vector3, wristPos: THREE.Vector3, handQ: THREE.Quaternion, pole: THREE.Vector3) {
    const r = this.rigs[side];
    // place the shoulder joint
    const parent = r.arm.parent!;
    parent.updateWorldMatrix(true, false);
    r.arm.position.copy(parent.worldToLocal(shoulder.clone()));
    r.arm.quaternion.copy(r.armBindQ);
    r.elbow.quaternion.copy(r.elbowBindQ);
    r.arm.updateMatrixWorld(true);
    const a = r.upperLen, b = r.foreLen;
    const toT = wristPos.clone().sub(shoulder);
    let d = toT.length();
    const dir = toT.divideScalar(Math.max(d, 1e-5));
    d = Math.min(d, (a + b) * 0.998);
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbowP = shoulder.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    aim(r.arm, r.elbow, elbowP);
    const wristP = shoulder.clone().addScaledVector(dir, d);
    aim(r.elbow, r.wrist, wristP);
    // wrist orientation
    const want = handQ.clone().multiply(r.wristOffset);
    // Forearm twist: in a real arm the radius rolls over the ulna, so most of the hand's roll about
    // the forearm axis happens along the forearm, not in the wrist. Putting all of it on the wrist
    // joint is what collapsed the skin into a thin twisted "candy wrapper". Split it: ~65 % rolls
    // the forearm bone about its own axis, the rest stays in the wrist (clamped).
    {
      const axis = wristP.clone().sub(elbowP).normalize();
      r.wrist.quaternion.copy(r.wristBindQ);
      r.wrist.updateMatrixWorld(true);
      const restW = r.wrist.getWorldQuaternion(new THREE.Quaternion());
      const delta = want.clone().multiply(restW.invert()); // world rotation still needed at the wrist
      const twist = twistAbout(delta, axis);
      const share = THREE.MathUtils.clamp(twist * 0.65, -1.9, 1.9);
      const roll = new THREE.Quaternion().setFromAxisAngle(axis, share);
      const eq = r.elbow.getWorldQuaternion(new THREE.Quaternion());
      const pq = r.elbow.parent!.getWorldQuaternion(new THREE.Quaternion());
      r.elbow.quaternion.copy(pq.invert().multiply(roll.multiply(eq)));
      r.elbow.updateMatrixWorld(true);
    }
    r.wrist.parent!.getWorldQuaternion(_q1);
    r.wrist.quaternion.copy(_q1.invert().multiply(want));
    r.wrist.updateMatrixWorld(true);
  }

  /**
   * Contact finger wrap: curl every joint of every finger just until it touches the surface it is
   * holding (a grip, a handguard, a magazine, a grenade ...), described as a world-space signed
   * distance function. Fingers that cannot reach the surface settle into a relaxed curl. Returns a
   * FingerPose (in the same units as POSES) so it blends with the authored poses as usual.
   *  skip — fingers to leave at the base pose (e.g. the trigger finger)
   */
  wrapPose(side: Side, sdf: (p: THREE.Vector3) => number, base: FingerPose, skip: Finger[] = [], gain = 0.85): FingerPose {
    const r = this.rigs[side];
    const out: FingerPose = { index: [...base.index], middle: [...base.middle], ring: [...base.ring], pinky: [...base.pinky], thumb: [...base.thumb], spread: base.spread };
    const pad = 0.0085, tipPad = 0.0072;
    const MAX = [1.55, 1.75, 1.35];
    const scale = this.root.scale.x;
    void scale;
    const end = (j: number, chain: Joint[], tip: THREE.Object3D) => (j < 2 ? chain[j + 1].bone : tip).getWorldPosition(_v1);
    const mid = (j: number, chain: Joint[], tip: THREE.Object3D) => {
      const a = chain[j].bone.getWorldPosition(_v2);
      return a.lerp((j < 2 ? chain[j + 1].bone : tip).getWorldPosition(_v1), 0.5);
    };
    for (const f of ['index', 'middle', 'ring', 'pinky'] as const) {
      if (skip.includes(f)) continue;
      const chain = r.fingers[f];
      const tip = chain[2].bone.children.find((c) => (c as THREE.Bone).isBone) ?? chain[2].bone;
      const spread = (base.spread ?? 0.02) * ({ index: -1.2, middle: -0.3, ring: 0.4, pinky: 1.2 }[f]) * (side === 'R' ? 1 : -1);
      for (let j = 0; j < 3; j++) {
        const jt = chain[j];
        const set = (m: number) => {
          jt.bone.quaternion.copy(jt.bindQ).multiply(_q2.setFromAxisAngle(jt.curlAxis, m - jt.bindCurl));
          if (j === 0) jt.bone.quaternion.multiply(_q2.setFromAxisAngle(jt.spreadAxis, spread));
          jt.bone.updateMatrixWorld(true);
        };
        const touching = (m: number) => {
          set(m);
          const e = sdf(end(j, chain, tip)) - (j === 2 ? tipPad : pad);
          const c = sdf(mid(j, chain, tip)) - pad;
          return Math.min(e, c) <= 0;
        };
        let m = -0.05;
        if (touching(m)) {
          // already in contact straight out (the object sits deep in the hand): keep the authored curl
          m = Math.max(0, -base[f][j] * gain);
        } else {
          // sweep the curl until contact, then refine
          let lo = m, hi = -1, steps = 7;
          for (let k = 1; k <= steps; k++) {
            const t = (k / steps) * MAX[j];
            if (touching(t)) {
              hi = t;
              break;
            }
            lo = t;
          }
          if (hi < 0) m = MAX[j] * (j === 0 ? 0.62 : 0.72); // nothing to hold here: relaxed curl
          else {
            for (let k = 0; k < 3; k++) {
              const t = (lo + hi) / 2;
              if (touching(t)) hi = t;
              else lo = t;
            }
            m = lo;
          }
        }
        set(m);
        out[f][j] = -m / gain;
      }
    }
    // thumb: keep the authored yaw, wrap the two outer joints
    if (!skip.includes('thumb')) {
      const chain = r.fingers.thumb;
      const tip = chain[2].bone.children.find((c) => (c as THREE.Bone).isBone) ?? chain[2].bone;
      const th = out.thumb;
      chain[0].bone.quaternion.copy(chain[0].bindQ).multiply(_q2.setFromAxisAngle(chain[0].curlAxis, -th[1] * 0.6 * gain)).multiply(_q1.setFromAxisAngle(chain[0].spreadAxis, th[0] * 0.5 * (side === 'R' ? 1 : -1)));
      chain[0].bone.updateMatrixWorld(true);
      for (let j = 1; j < 3; j++) {
        const jt = chain[j];
        const set = (m: number) => {
          jt.bone.quaternion.copy(jt.bindQ).multiply(_q2.setFromAxisAngle(jt.curlAxis, m - jt.bindCurl));
          jt.bone.updateMatrixWorld(true);
        };
        let m = 0, found = false;
        for (let k = 0; k <= 8; k++) {
          const t = (k / 8) * 1.2;
          set(t);
          if (sdf(end(j, chain, tip)) - pad <= 0) {
            m = Math.max(0, t - 0.08);
            found = true;
            break;
          }
        }
        if (!found) m = -th[j + 1] * gain;
        set(m);
        th[j + 1] = -m / gain;
      }
    }
    return out;
  }

  /** Palm centre in world space (for "is this hand near that surface" tests). */
  palmWorld(side: Side, out = new THREE.Vector3()) {
    const r = this.rigs[side];
    r.wrist.updateMatrixWorld(true);
    const hq = r.wrist.getWorldQuaternion(_q1).multiply(_q2.copy(r.wristOffset).invert());
    return out.copy(r.palm).applyQuaternion(hq).add(r.wrist.getWorldPosition(_v2));
  }

  /** Finger pose (same convention as procedural hands: negative values curl toward the palm). */
  pose(side: Side, p: FingerPose, blendTo?: FingerPose, t = 0, gain = 0.85) {
    const r = this.rigs[side];
    const lerp3 = (x: number[], y?: number[]) => (y ? x.map((v, i) => v + (y[i] - v) * t) : x);
    for (const f of ['index', 'middle', 'ring', 'pinky'] as const) {
      const c = lerp3(p[f], blendTo?.[f]);
      const spread = (p.spread ?? 0.02) * ({ index: -1.2, middle: -0.3, ring: 0.4, pinky: 1.2 }[f]) * (side === 'R' ? 1 : -1);
      r.fingers[f].forEach((j, i) => {
        j.bone.quaternion.copy(j.bindQ).multiply(_q2.setFromAxisAngle(j.curlAxis, -c[i] * gain - j.bindCurl));
        if (i === 0) j.bone.quaternion.multiply(_q2.setFromAxisAngle(j.spreadAxis, spread));
      });
    }
    const th = lerp3(p.thumb, blendTo?.thumb);
    r.fingers.thumb.forEach((j, i) => {
      const curl = i === 0 ? th[1] * 0.6 : th[i + 1];
      j.bone.quaternion.copy(j.bindQ).multiply(_q2.setFromAxisAngle(j.curlAxis, -curl * gain - (i === 0 ? 0 : j.bindCurl)));
      if (i === 0) j.bone.quaternion.multiply(_q2.setFromAxisAngle(j.spreadAxis, th[0] * 0.5 * (side === 'R' ? 1 : -1)));
    });
  }
}

/** Signed angle of the twist part of q about a unit axis (swing-twist decomposition). */
function twistAbout(q: THREE.Quaternion, axis: THREE.Vector3) {
  const proj = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let a = 2 * Math.atan2(proj, q.w);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function aim(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  bone.updateMatrixWorld(true);
  const bp = bone.getWorldPosition(new THREE.Vector3());
  const cur = child.getWorldPosition(new THREE.Vector3()).sub(bp).normalize();
  const want = target.clone().sub(bp).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(cur, want);
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  const bq = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pq.invert().multiply(delta.multiply(bq)));
  bone.updateMatrixWorld(true);
}
