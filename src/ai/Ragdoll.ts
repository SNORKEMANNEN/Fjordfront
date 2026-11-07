import * as THREE from 'three';
import { Physics } from '../core/Physics';

/**
 * Verlet ragdoll for death falls.
 *
 * Fifteen point masses sit on the skeleton's joints (pelvis, chest, head, shoulders, elbows,
 * hands, hips, knees, feet), held together by distance constraints along the bones plus a few
 * cross braces that keep the torso from folding flat. Every particle is swept against the
 * static world with a ray each sub-step, so bodies slump against walls, tumble down stairs and
 * slide down slopes until friction stops them. The skinned skeleton is then aimed at the
 * particles each frame (pelvis placed, every limb bone pointed at its child joint).
 */
type J = 'Hips' | 'Spine2' | 'Head' | 'LeftArm' | 'LeftForeArm' | 'LeftHand' | 'RightArm' | 'RightForeArm' | 'RightHand' | 'LeftUpLeg' | 'LeftLeg' | 'LeftFoot' | 'RightUpLeg' | 'RightLeg' | 'RightFoot';
const JOINTS: J[] = ['Hips', 'Spine2', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const LINKS: [J, J, number][] = [
  // bones (stiff)
  ['Hips', 'Spine2', 1], ['Spine2', 'Head', 1],
  ['Spine2', 'LeftArm', 1], ['LeftArm', 'LeftForeArm', 1], ['LeftForeArm', 'LeftHand', 1],
  ['Spine2', 'RightArm', 1], ['RightArm', 'RightForeArm', 1], ['RightForeArm', 'RightHand', 1],
  ['Hips', 'LeftUpLeg', 1], ['LeftUpLeg', 'LeftLeg', 1], ['LeftLeg', 'LeftFoot', 1],
  ['Hips', 'RightUpLeg', 1], ['RightUpLeg', 'RightLeg', 1], ['RightLeg', 'RightFoot', 1],
  // braces (softer): torso box, shoulder line, hip line
  ['LeftArm', 'RightArm', 1], ['LeftUpLeg', 'RightUpLeg', 1], ['LeftArm', 'LeftUpLeg', 0.7], ['RightArm', 'RightUpLeg', 0.7],
  ['LeftArm', 'RightUpLeg', 0.5], ['RightArm', 'LeftUpLeg', 0.5], ['Head', 'LeftArm', 0.6], ['Head', 'RightArm', 0.6],
];
// minimum distances (no knees bending forward through the shins, heels not through the backside)
const MINS: [J, J, number][] = [['LeftUpLeg', 'LeftFoot', 0.55], ['RightUpLeg', 'RightFoot', 0.55], ['LeftArm', 'LeftHand', 0.35], ['RightArm', 'RightHand', 0.35], ['Head', 'Hips', 0.85]];
const AIM: [J, J][] = [['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand']];

const R = 0.07; // particle radius
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

export class Ragdoll {
  p: THREE.Vector3[] = [];
  prev: THREE.Vector3[] = [];
  private rest: number[] = [];
  private idx: Record<string, number> = {};
  t = 0;
  asleep = false;
  private sleepT = 0;

  constructor(private bones: Record<string, THREE.Bone>, private physics: Physics) {}

  get ok() {
    return JOINTS.every((j) => this.bones[j]);
  }

  /** Start from the current pose, with an initial body velocity and a hit impulse. */
  start(vel: THREE.Vector3, hitDir: THREE.Vector3, hitPart: 'head' | 'body' | 'limb', dt = 1 / 60) {
    this.p = [];
    this.prev = [];
    JOINTS.forEach((j, i) => {
      this.idx[j] = i;
      const w = this.bones[j].getWorldPosition(new THREE.Vector3());
      this.p.push(w);
      // impulse: strongest where the round hit, a little everywhere
      const hitJ = hitPart === 'head' ? (j === 'Head' ? 1 : j === 'Spine2' ? 0.6 : 0.15) : hitPart === 'body' ? (j === 'Spine2' || j === 'Hips' ? 1 : j.includes('Arm') ? 0.5 : 0.25) : j.includes('Leg') || j.includes('Foot') ? 0.8 : 0.3;
      const v = vel.clone().addScaledVector(hitDir, 1.4 + 2.6 * hitJ);
      v.y += j.includes('Foot') ? 0.4 : 0;
      this.prev.push(w.clone().addScaledVector(v, -dt));
    });
    this.rest = LINKS.map(([a, b]) => this.p[this.idx[a]].distanceTo(this.p[this.idx[b]]));
    this.t = 0;
    this.asleep = false;
    this.sleepT = 0;
  }

  update(dt: number) {
    if (this.asleep) return;
    this.t += dt;
    const sub = 2;
    const h = dt / sub;
    const g = 9.81;
    for (let s = 0; s < sub; s++) {
      // integrate
      for (let i = 0; i < this.p.length; i++) {
        const p = this.p[i], q = this.prev[i];
        tmpA.subVectors(p, q).multiplyScalar(0.985); // air drag
        q.copy(p);
        p.add(tmpA);
        p.y -= g * h * h;
      }
      // constraints
      for (let it = 0; it < 6; it++) {
        LINKS.forEach(([a, b, k], li) => {
          const pa = this.p[this.idx[a]], pb = this.p[this.idx[b]];
          tmpA.subVectors(pb, pa);
          const d = tmpA.length() || 1e-6;
          const diff = ((d - this.rest[li]) / d) * 0.5 * k;
          pa.addScaledVector(tmpA, diff);
          pb.addScaledVector(tmpA, -diff);
        });
        for (const [a, b, m] of MINS) {
          const pa = this.p[this.idx[a]], pb = this.p[this.idx[b]];
          tmpA.subVectors(pb, pa);
          const d = tmpA.length() || 1e-6;
          if (d < m) {
            const diff = ((d - m) / d) * 0.5;
            pa.addScaledVector(tmpA, diff);
            pb.addScaledVector(tmpA, -diff);
          }
        }
      }
      // world collision: sweep each particle from where it was to where it is going
      for (let i = 0; i < this.p.length; i++) {
        const p = this.p[i], q = this.prev[i];
        tmpA.subVectors(p, q);
        const len = tmpA.length();
        if (len > 1e-5) {
          tmpB.copy(tmpA).divideScalar(len);
          const hit = this.physics.raycast(q, tmpB, len + R);
          if (hit) {
            const n = hit.normal;
            p.copy(hit.point).addScaledVector(n, R);
            // friction: kill most of the tangential motion, no bounce
            const v = tmpA.subVectors(p, q);
            const vn = n.clone().multiplyScalar(v.dot(n));
            const vt = v.sub(vn).multiplyScalar(0.55);
            q.copy(p).sub(vt);
          }
        }
        // resting contact (and anything that tunnelled): stay above the surface below
        const down = this.physics.raycast(tmpA.copy(p).setY(p.y + 0.5), tmpB.set(0, -1, 0), 0.5 + R);
        if (down && p.y < down.point.y + R) {
          p.y = down.point.y + R;
          const vx = p.x - q.x, vz = p.z - q.z;
          q.set(p.x - vx * 0.6, p.y, p.z - vz * 0.6);
        }
      }
    }
    // go to sleep once settled (or after a while)
    let maxV = 0;
    for (let i = 0; i < this.p.length; i++) maxV = Math.max(maxV, this.p[i].distanceTo(this.prev[i]) / (dt / 2));
    this.sleepT = maxV < 0.08 ? this.sleepT + dt : 0;
    if (this.sleepT > 0.6 || this.t > 6) this.asleep = true;
  }

  /** Drive the skeleton: place the pelvis, orient the torso, aim every limb at its child joint. */
  apply(root: THREE.Object3D, model: THREE.Object3D) {
    const P = (j: J) => this.p[this.idx[j]];
    const hips = this.bones.Hips;
    // 1) torso frame from the particles: up = pelvis→chest, right = left hip→right hip
    const up = tmpA.subVectors(P('Spine2'), P('Hips')).normalize();
    const right = tmpB.subVectors(P('RightUpLeg'), P('LeftUpLeg'));
    right.addScaledVector(up, -right.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
    // the rest-pose torso frame of the hips bone in world space, measured from the bones themselves
    hips.updateWorldMatrix(true, true);
    const curUp = this.bones.Spine2.getWorldPosition(new THREE.Vector3()).sub(hips.getWorldPosition(new THREE.Vector3())).normalize();
    const curRight = this.bones.RightUpLeg.getWorldPosition(new THREE.Vector3()).sub(this.bones.LeftUpLeg.getWorldPosition(new THREE.Vector3()));
    curRight.addScaledVector(curUp, -curRight.dot(curUp)).normalize();
    const curFwd = new THREE.Vector3().crossVectors(curRight, curUp).normalize();
    const mCur = new THREE.Matrix4().makeBasis(curRight, curUp, curFwd);
    const mWant = new THREE.Matrix4().makeBasis(right, up, fwd);
    const delta = tmpQ.setFromRotationMatrix(mWant.multiply(mCur.transpose()));
    hips.getWorldQuaternion(tmpQ2);
    const parentQ = hips.parent!.getWorldQuaternion(new THREE.Quaternion());
    hips.quaternion.copy(parentQ.invert().multiply(delta.multiply(tmpQ2)));
    hips.updateMatrixWorld(true);
    // 2) translate the whole model so the pelvis sits on its particle
    const hp = hips.getWorldPosition(new THREE.Vector3());
    root.position.add(P('Hips').clone().sub(hp));
    root.updateMatrixWorld(true);
    void model;
    // 3) spine & head, then limbs
    aimAt(this.bones.Spine2, this.bones.Head, P('Head'));
    for (const [a, b] of AIM) aimAt(this.bones[a], this.bones[b], P(b));
  }
}

function aimAt(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  bone.updateWorldMatrix(true, false);
  const bp = bone.getWorldPosition(new THREE.Vector3());
  const cp = child.getWorldPosition(new THREE.Vector3());
  const cur = cp.sub(bp).normalize();
  const want = target.clone().sub(bp).normalize();
  if (cur.lengthSq() < 1e-6 || want.lengthSq() < 1e-6) return;
  const delta = new THREE.Quaternion().setFromUnitVectors(cur, want);
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  const bq = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pq.invert().multiply(delta.multiply(bq)));
  bone.updateMatrixWorld(true);
}
