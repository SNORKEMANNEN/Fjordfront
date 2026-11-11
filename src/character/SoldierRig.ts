import * as THREE from 'three';

/**
 * The soldier's skeleton. Joint names follow the common humanoid convention (Hips, Spine2,
 * LeftForeArm, ...) so the ragdoll, hit boxes, IK and killcam code address bones the same way they
 * always have. Units are metres; the model faces +Z, its left side is +X. Every bone's rest
 * rotation is identity (only offsets), so animation can be written directly as local rotations:
 * a limb's rest direction is simply the offset to its child.
 */
export const JOINTS: [name: string, parent: string | null, pos: [number, number, number]][] = [
  ['Hips', null, [0, 0.98, 0]],
  ['Spine', 'Hips', [0, 1.07, 0.005]],
  ['Spine1', 'Spine', [0, 1.19, 0.01]],
  ['Spine2', 'Spine1', [0, 1.32, 0]],
  ['Neck', 'Spine2', [0, 1.5, -0.005]],
  ['Head', 'Neck', [0, 1.585, 0.01]],
  ['LeftShoulder', 'Spine2', [0.035, 1.455, 0]],
  ['LeftArm', 'LeftShoulder', [0.185, 1.445, -0.01]],
  ['LeftForeArm', 'LeftArm', [0.185, 1.165, -0.01]],
  ['LeftHand', 'LeftForeArm', [0.185, 0.905, 0]],
  ['LeftHandIndex1', 'LeftHand', [0.185, 0.82, 0.02]],
  ['LeftHandThumb1', 'LeftHand', [0.168, 0.875, 0.03]],
  ['RightShoulder', 'Spine2', [-0.035, 1.455, 0]],
  ['RightArm', 'RightShoulder', [-0.185, 1.445, -0.01]],
  ['RightForeArm', 'RightArm', [-0.185, 1.165, -0.01]],
  ['RightHand', 'RightForeArm', [-0.185, 0.905, 0]],
  ['RightHandIndex1', 'RightHand', [-0.185, 0.82, 0.02]],
  ['RightHandThumb1', 'RightHand', [-0.168, 0.875, 0.03]],
  ['LeftUpLeg', 'Hips', [0.095, 0.93, 0]],
  ['LeftLeg', 'LeftUpLeg', [0.095, 0.5, 0.005]],
  ['LeftFoot', 'LeftLeg', [0.095, 0.085, -0.02]],
  ['LeftToeBase', 'LeftFoot', [0.095, 0.02, 0.11]],
  ['RightUpLeg', 'Hips', [-0.095, 0.93, 0]],
  ['RightLeg', 'RightUpLeg', [-0.095, 0.5, 0.005]],
  ['RightFoot', 'RightLeg', [-0.095, 0.085, -0.02]],
  ['RightToeBase', 'RightFoot', [-0.095, 0.02, 0.11]],
];
export const BONE_INDEX: Record<string, number> = Object.fromEntries(JOINTS.map(([n], i) => [n, i]));
export const REST: Record<string, THREE.Vector3> = Object.fromEntries(JOINTS.map(([n, , p]) => [n, new THREE.Vector3(...p)]));

/** Build a fresh skeleton (bones in rest pose) scaled to a soldier's build. */
export function buildSkeleton(height = 1, width = 1) {
  const bones: THREE.Bone[] = [];
  const byName: Record<string, THREE.Bone> = {};
  for (const [name, parent, p] of JOINTS) {
    const b = new THREE.Bone();
    b.name = name;
    const w = new THREE.Vector3(p[0] * width, p[1] * height, p[2]);
    if (parent) {
      const pp = JOINTS[BONE_INDEX[parent]][2];
      b.position.set(w.x - pp[0] * width, w.y - pp[1] * height, w.z - pp[2]);
      byName[parent].add(b);
    } else b.position.copy(w);
    bones.push(b);
    byName[name] = b;
  }
  return { bones, byName, root: byName.Hips };
}
