import * as THREE from 'three';
import type { TextureBaker } from '../render/TextureBaker';
import type { WeaponModel } from '../weapons/WeaponModels';
import { buildSkeleton } from './SoldierRig';
import { buildSoldierGeometry, SoldierLook, varietyFor } from './SoldierMesh';
import { AnimState, newUpperOut, SoldierAnimator, UpperOut } from './SoldierAnim';

// ------------------------------------------------------------------ camo + material

/**
 * Fictional faction camouflage, baked once on the GPU (tileable, 512²):
 *  - Kystjegerne: "fjordskog" — organic olive / forest-green / bark-brown / black blotches with
 *    small light specks;
 *  - Nordfront: "berg" — angular rock-splinter shards in coyote, grey-olive, brown and charcoal over
 *    fine vertical rain dashes.
 * Winter versions keep each pattern's character on a snow-white base.
 */
const CAMO: Record<string, string> = {
  kyst: `void main(){ vec2 p = vUv;
    vec2 w = vec2(tfbm(p*3.0+vec2(1.3,7.1), 3.0, 3), tfbm(p*3.0+vec2(5.2,2.8), 3.0, 3)) - 0.5;
    vec2 q = p + w*0.18;
    float a = tfbm(q*4.0, 4.0, 4), b = tfbm(q*5.0+vec2(3.1,1.7), 5.0, 4), c = tfbm(q*6.0+vec2(7.7,4.4), 6.0, 3), d = tnoise(p*48.0, vec2(48.0));
    vec3 col = hex(98.0, 104.0, 66.0);
    col = mix(col, hex(52.0, 70.0, 42.0), smoothstep(0.5, 0.52, a));
    col = mix(col, hex(96.0, 74.0, 50.0), smoothstep(0.56, 0.58, b));
    col = mix(col, hex(24.0, 26.0, 22.0), smoothstep(0.62, 0.64, c));
    col = mix(col, hex(150.0, 142.0, 104.0), step(0.86, d) * 0.7);
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.92 + grain*0.16), 1.0); }`,
  nord: `void main(){ vec2 p = vUv;
    vec3 v = tvoronoi(vec2(p.x*10.0, p.y*6.0) + vec2(tfbm(p*2.0, 2.0, 2)*0.6), vec2(10.0, 6.0));
    float id = fract(v.z * 7.31);
    vec3 col = id < 0.38 ? hex(122.0, 112.0, 88.0) : id < 0.62 ? hex(92.0, 94.0, 74.0) : id < 0.84 ? hex(88.0, 70.0, 52.0) : hex(44.0, 44.0, 40.0);
    col *= 0.85 + 0.15 * smoothstep(0.0, 0.06, v.y - v.x);
    float rain = step(0.78, tnoise(vec2(p.x*90.0, p.y*16.0), vec2(90.0, 16.0)));
    col = mix(col, hex(58.0, 60.0, 46.0), rain * 0.7);
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.92 + grain*0.16), 1.0); }`,
  kystW: `void main(){ vec2 p = vUv;
    vec2 w = vec2(tfbm(p*3.0+vec2(1.3,7.1), 3.0, 3), tfbm(p*3.0+vec2(5.2,2.8), 3.0, 3)) - 0.5;
    vec2 q = p + w*0.18;
    float a = tfbm(q*4.0, 4.0, 4), c = tfbm(q*6.0+vec2(7.7,4.4), 6.0, 3);
    vec3 col = hex(214.0, 218.0, 220.0);
    col = mix(col, hex(150.0, 158.0, 150.0), smoothstep(0.6, 0.62, a));
    col = mix(col, hex(78.0, 84.0, 74.0), smoothstep(0.68, 0.7, c));
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.94 + grain*0.1), 1.0); }`,
  nordW: `void main(){ vec2 p = vUv;
    vec3 v = tvoronoi(vec2(p.x*10.0, p.y*6.0) + vec2(tfbm(p*2.0, 2.0, 2)*0.6), vec2(10.0, 6.0));
    float id = fract(v.z * 7.31);
    vec3 col = id < 0.55 ? hex(222.0, 222.0, 216.0) : id < 0.8 ? hex(176.0, 176.0, 170.0) : hex(120.0, 118.0, 108.0);
    float rain = step(0.82, tnoise(vec2(p.x*90.0, p.y*16.0), vec2(90.0, 16.0)));
    col = mix(col, hex(140.0, 140.0, 132.0), rain * 0.6);
    gl_FragColor = vec4(col, 1.0); }`,
};
const TEAM_COL = [new THREE.Color(0x2a6ad8), new THREE.Color(0xc8281c)];

export const SoldierStyle = {
  textures: null as null | Record<string, THREE.Texture>,
  winter: false,
  live: new Set<THREE.MeshStandardMaterial>(),
  init(baker: TextureBaker) {
    if (this.textures) return;
    this.textures = {};
    for (const [k, src] of Object.entries(CAMO)) this.textures[k] = baker.raw('camo.' + k, src, 512, true);
  },
  camo(team: 0 | 1) {
    const k = (team === 0 ? 'kyst' : 'nord') + (this.winter ? 'W' : '');
    return this.textures?.[k] ?? null;
  },
  setWinter(w: boolean) {
    if (this.winter === w) return;
    this.winter = w;
    for (const m of this.live) m.userData.uCamo.value = this.camo(m.userData.team);
  },
};

function makeMaterial(team: 0 | 1) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.8 });
  m.name = 'soldier';
  m.userData.snow = true; // (no snow-on-top patch for people)
  m.userData.team = team;
  m.userData.uCamo = { value: SoldierStyle.camo(team) };
  m.userData.uTeam = { value: TEAM_COL[team].clone() };
  m.userData.uNVG = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCamo = m.userData.uCamo;
    sh.uniforms.uTeam = m.userData.uTeam;
    sh.uniforms.uNVG = m.userData.uNVG;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMat; varying vec3 vMat; varying vec2 vCamoUv; uniform float uNVG;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vMat = aMat; vCamoUv = uv;
        // goggles: lowered tubes only when worn down, raised ones otherwise (collapsed to a point)
        if ((aMat.x > 2.5 && aMat.x < 3.5 && uNVG < 0.5) || (aMat.x > 3.5 && aMat.x < 4.5 && uNVG > 0.5)) transformed = vec3(0.0, 1.7, 0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMat; varying vec2 vCamoUv; uniform sampler2D uCamo; uniform vec3 uTeam;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float kind = vMat.x;
        if (kind < 0.5) diffuseColor.rgb = texture2D(uCamo, vCamoUv).rgb * vColor.rgb;
        else if (kind < 2.5 && kind > 1.5) diffuseColor.rgb = uTeam;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.z;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vMat.x > 1.5 && vMat.x < 2.5) totalEmissiveRadiance += uTeam * 0.12;`);
  };
  m.customProgramCacheKey = () => 'soldier1';
  SoldierStyle.live.add(m);
  return m;
}

// ------------------------------------------------------------------ the soldier

const vR = new THREE.Vector3(), vA = new THREE.Vector3(), vU = new THREE.Vector3(), vChest = new THREE.Vector3(), vGP = new THREE.Vector3();
const vT1 = new THREE.Vector3(), vT2 = new THREE.Vector3(), vT3 = new THREE.Vector3(), vGrip = new THREE.Vector3(), vTgt = new THREE.Vector3(), vPole = new THREE.Vector3();
const gQ = new THREE.Quaternion(), gQ0 = new THREE.Quaternion();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion(), _q6 = new THREE.Quaternion();
const ARM_BONES = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
const SPINE = ['Spine', 'Spine1', 'Spine2'];
const SIDES = ['Right', 'Left'] as const;
const XV = new THREE.Vector3(1, 0, 0), ZV = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _eu = new THREE.Euler();
const UPV = new THREE.Vector3(0, 1, 0);

/**
 * One soldier: its own skeleton, one skinned mesh (three detail levels), a team camo material,
 * the procedural animator and the weapon held with both hands.
 */
export class Soldier {
  model = new THREE.Group();
  mesh: THREE.SkinnedMesh;
  bones: Record<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
  material: THREE.MeshStandardMaterial;
  anim: SoldierAnimator;
  lods: (THREE.BufferGeometry | null)[] = [null, null, null];
  lod = -1;
  private up: UpperOut = newUpperOut();
  height: number;
  /** anchor points on the body for reload hand paths (model space, rest pose) */
  private pouchL = new THREE.Vector3(0.16, 1.0, 0.12);

  constructor(public look: SoldierLook, public team: 0 | 1, public weapon: WeaponModel | null) {
    const v = varietyFor(look, team);
    this.height = v.height;
    const sk = buildSkeleton(v.height, v.width);
    this.bones = sk.byName;
    this.material = makeMaterial(team);
    this.lods[2] = buildSoldierGeometry(look, team, 2);
    this.mesh = new THREE.SkinnedMesh(this.lods[2], this.material);
    this.mesh.name = 'soldierMesh';
    this.model.add(sk.root);
    this.model.add(this.mesh);
    this.model.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(sk.bones);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // generous fixed bounds (covers crouch, prone, ragdoll flail) so the soldier can be culled
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
    this.anim = new SoldierAnimator(this.bones, v.height);
    this.lod = 2;
    // the nearer detail levels are built in the background (Soldier.idleBuild), not at load
    Soldier.queue.push(this);
    if (weapon) this.model.add(weapon.root);
  }

  /** soldiers still missing detail levels */
  static queue: Soldier[] = [];
  /** build pending detail levels for up to `budgetMs` (call once per frame) */
  static idleBuild(budgetMs: number) {
    const q = Soldier.queue;
    if (!q.length) return;
    const t0 = performance.now();
    while (q.length && performance.now() - t0 < budgetMs) {
      const s = q[0];
      const l = s.lods[1] ? 0 : 1;
      s.lods[l] ??= buildSoldierGeometry(s.look, s.team, l as 0 | 1);
      if (s.lods[0] && s.lods[1]) q.shift();
    }
  }

  /** swap the detail level (geometry built on first use; all share the skeleton) */
  setLod(l: number) {
    if (l === this.lod) return;
    this.lod = l;
    const g = (this.lods[l] ??= buildSoldierGeometry(this.look, this.team, l as 0 | 1 | 2));
    this.mesh.geometry = g;
  }

  setTeam(t: 0 | 1) {
    if (t === this.team) return;
    this.team = t;
    this.material.userData.team = t;
    this.material.userData.uCamo.value = SoldierStyle.camo(t);
    this.material.userData.uTeam.value.copy(TEAM_COL[t]);
    // gear colours follow the faction
    this.lods = [null, null, null];
    const l = this.lod;
    this.lod = -1;
    this.setLod(l);
  }

  setNVG(on: boolean) {
    this.material.userData.uNVG.value = on ? 1 : 0;
  }

  setWeapon(w: WeaponModel | null) {
    if (this.weapon) this.weapon.root.removeFromParent();
    this.weapon = w;
    if (w) this.model.add(w.root);
  }

  /** the anim events raised since the last call (e.g. 'magOut') */
  takeEvents() {
    const e = this.anim.events;
    if (!e.length) return null;
    const out = e.slice();
    e.length = 0;
    return out;
  }

  // ---------------------------------------------------------------- per frame
  /**
   * Pose everything. `root` is the object carrying the soldier's world position / facing
   * (rotation.y = yaw + π); it must already be placed.
   */
  pose(s: AnimState, dt: number, root: THREE.Object3D, flinch?: { axis: THREE.Vector3; body: number; head: number }, legsOnly = false) {
    const k = this.anim.body(s, dt);
    const b = this.bones;
    if (legsOnly) return; // (first-person legs: the upper body is collapsed and never seen)
    // ---- arms back to rest before the IK (they are fully re-solved every frame)
    for (const n of ARM_BONES) b[n].quaternion.identity();
    root.updateMatrixWorld(true);
    // ---- aim: twist and pitch the spine towards the aim (world space)
    const yawRel = THREE.MathUtils.clamp(Math.atan2(Math.sin(s.aimYaw - s.yaw), Math.cos(s.aimYaw - s.yaw)), k.prone > 0.5 ? -0.7 : -1.4, k.prone > 0.5 ? 0.7 : 1.4);
    const R = vR.set(Math.cos(s.aimYaw), 0, -Math.sin(s.aimYaw));
    this.anim.upper(s, k, this.resetUp());
    const up = this.up;
    const twist = yawRel + up.spineTwist;
    const pitch = s.aimPitch * (1 - k.ladder);
    // one combined world rotation per spine bone (yaw about up, then pitch about the aim's right)
    const spineQ = _q4.setFromAxisAngle(UPV, twist / 3).multiply(_q5.setFromAxisAngle(R, -pitch / 3));
    for (const n of SPINE) rotateBoneWorldQ(b[n], spineQ);
    if (flinch && Math.abs(flinch.body) > 1e-3) {
      rotateBoneWorld(b.Spine1, flinch.axis, flinch.body * 0.12);
      rotateBoneWorld(b.Spine2, flinch.axis, flinch.body * 0.16);
    }
    rotateBoneWorld(b.Head, R, -pitch * 0.3);
    // cheek weld: the head cants onto the stock when aiming a long gun
    if (!s.pistol) rotateBoneWorld(b.Head, vT3.set(-Math.sin(s.aimYaw), 0, -Math.cos(s.aimYaw)), 0.16 * k.ready * (1 - k.sprint));
    if (flinch && Math.abs(flinch.head) > 1e-3) rotateBoneWorld(b.Head, flinch.axis, flinch.head * 0.08);
    // ---- weapon placement (world), then into model space
    const w = this.weapon;
    const chest = b.Spine2.getWorldPosition(vChest);
    const cp = Math.cos(s.aimPitch);
    const A = vA.set(-Math.sin(s.aimYaw) * cp, Math.sin(s.aimPitch), -Math.cos(s.aimYaw) * cp);
    const U = vU.crossVectors(R, A).normalize();
    if (w) {
      const g = w.root;
      // base hold: the sight sits in front of the right eye (shouldered rifle / pistol at arm's
      // length) whatever the gun's proportions; the reach comes from the grip, not the sight (a
      // shotgun's sight is its front bead). Holds and actions then rotate the gun about the firing
      // hand — a low ready or a canted reload pivots in the grip, as it does in a real hand.
      _m.makeBasis(R, U, vT1.copy(A).negate());
      const q0 = gQ0.setFromRotationMatrix(_m);
      const eye = b.Head.getWorldPosition(vT2).addScaledVector(U, 0.085).addScaledVector(A, 0.06).addScaledVector(R, s.pistol ? 0 : 0.055);
      const sight = w.sockets.sight, grip = w.sockets.rightHand;
      const gp = vGP.copy(eye).addScaledVector(A, s.pistol ? 0.42 : 0.2).addScaledVector(U, -0.015);
      if (sight) gp.sub(vT1.copy(sight.position).applyQuaternion(q0));
      if (grip) {
        const gA = vT1.copy(grip.position).applyQuaternion(q0).add(gp).sub(eye).dot(A);
        gp.addScaledVector(A, (s.pistol ? 0.4 : 0.06) - gA);
      }
      const gq = gQ.copy(q0).multiply(_q2.setFromEuler(_eu.set(up.gunRot.x, up.gunRot.y, up.gunRot.z, 'YXZ')));
      if (grip) {
        // pivot about the grip
        const hp = vT1.copy(grip.position);
        gp.add(hp.clone().applyQuaternion(q0)).sub(hp.applyQuaternion(gq));
      }
      gp.addScaledVector(R, up.gunPos.x).addScaledVector(U, up.gunPos.y).addScaledVector(A, up.gunPos.z);
      // slung across the back (ladders, dives)
      if (up.slung > 0.01) {
        const sq = b.Spine2.getWorldQuaternion(_q3);
        const back = vT1.set(0.04, -0.02, -0.22).applyQuaternion(sq).add(chest);
        gp.lerp(back, up.slung);
        gq.slerp(sq.multiply(_q2.setFromEuler(_eu.set(-0.2, Math.PI, 0.9))), up.slung);
      }
      // world → model space
      _m.compose(gp, gq, vT1.set(1, 1, 1));
      _m2.copy(this.model.matrixWorld).invert().multiply(_m);
      _m2.decompose(g.position, g.quaternion, vT1);
      g.updateMatrixWorld(true);
    }
    // ---- arm IK
    for (const side of SIDES) {
      const sock = w?.sockets[side === 'Left' ? 'leftHand' : 'rightHand'];
      const gripW = sock ? sock.getWorldPosition(vGrip) : this.model.localToWorld(vGrip.set(side === 'Left' ? 0.2 : -0.2, 0.95, 0.1));
      const target = vTgt.copy(gripW);
      // reload / bolt paths blend the hand between anchors
      if (side === 'Left' && up.leftReload > 0 && w) {
        const [pa, pb, t] = up.leftPhase;
        this.anchor(pa, gripW, vT1);
        this.anchor(pb, gripW, vT2);
        target.lerpVectors(vT1, vT2, t);
      }
      if (side === 'Right' && up.rightBolt > 0 && w) {
        const ej = (w.sockets.eject ?? w.sockets.rightHand).getWorldPosition(vT1);
        ej.addScaledVector(R, 0.05).addScaledVector(A, -0.08 * up.boltBack);
        target.lerp(ej, up.rightBolt);
      }
      const free = side === 'Left' ? up.leftFree : up.rightFree;
      if (free > 0.001) target.lerp(this.model.localToWorld(vT1.copy(side === 'Left' ? up.leftTarget : up.rightTarget)), free);
      const pole = vPole.copy(R).multiplyScalar(side === 'Right' ? 0.7 : -0.8);
      pole.y -= 1;
      solveTwoBone(b[`${side}Arm`], b[`${side}ForeArm`], b[`${side}Hand`], target, pole);
      // hand orientation from the grip socket's frame (fingers = -Z, palm towards the grip = -Y)
      if (sock && free < 0.5 && !(side === 'Left' && up.leftReload > 0.5)) orientHand(b[`${side}Hand`], sock, side === 'Left' ? 1 : -1, this.model);
      // fingers curl round the grip
      const curl = (free > 0.5 ? 0.35 : 1.35) * (side === 'Left' ? -1 : 1);
      b[`${side}HandIndex1`].quaternion.setFromAxisAngle(ZV, curl);
      b[`${side}HandThumb1`].quaternion.setFromAxisAngle(XV, -0.6);
    }
  }

  /** reload anchor points (world) */
  private anchor(name: string, grip: THREE.Vector3, out: THREE.Vector3) {
    const w = this.weapon!;
    if (name === 'well') return (w.sockets.magWell ?? w.sockets.leftHand).getWorldPosition(out).add(vT3.set(0, -0.05, 0));
    if (name === 'port') return (w.sockets.loadPort ?? w.sockets.eject ?? w.sockets.leftHand).getWorldPosition(out);
    if (name === 'pouch') return this.model.localToWorld(out.copy(this.pouchL));
    return out.copy(grip);
  }

  private resetUp() {
    const u = this.up;
    u.spineTwist = 0;
    u.leftReload = 0;
    u.leftPhase = ['grip', 'grip', 0];
    u.rightBolt = 0;
    u.boltBack = 0;
    return u;
  }
}

// ------------------------------------------------------------------ IK helpers

const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3();
// World matrices are refreshed lazily: getWorldPosition / getWorldQuaternion walk up and update
// the parent chain on demand, and the render pass updates the whole scene once per frame — so a
// rotation only touches its own local transform instead of re-deriving the subtree (arms, head,
// gun) every time.
export function rotateBoneWorld(bone: THREE.Object3D, axisWorld: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-5) return;
  rotateBoneWorldQ(bone, _q6.setFromAxisAngle(_h4.copy(axisWorld).normalize(), angle));
}
export function rotateBoneWorldQ(bone: THREE.Object3D, delta: THREE.Quaternion) {
  const parent = bone.parent!;
  parent.getWorldQuaternion(_q3);
  bone.getWorldQuaternion(_q2);
  _q.copy(delta).multiply(_q2);
  bone.quaternion.copy(_q3.invert().multiply(_q));
  bone.updateMatrix();
  bone.matrixWorldNeedsUpdate = true;
}

function aimBone(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  const bp = bone.getWorldPosition(_h1);
  const cur = child.getWorldPosition(_h2).sub(bp).normalize();
  const want = _h3.copy(target).sub(bp).normalize();
  const delta = _q.setFromUnitVectors(cur, want);
  bone.parent!.getWorldQuaternion(_q3);
  bone.getWorldQuaternion(_q2);
  bone.quaternion.copy(_q3.invert().multiply(delta.multiply(_q2)));
  bone.updateMatrix();
}

const _s = new THREE.Vector3(), _el = new THREE.Vector3(), _hd = new THREE.Vector3(), _dir = new THREE.Vector3(), _perp = new THREE.Vector3(), _tgt = new THREE.Vector3();
export function solveTwoBone(upper: THREE.Object3D, fore: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  const s = upper.getWorldPosition(_s);
  const e = fore.getWorldPosition(_el);
  const h = hand.getWorldPosition(_hd);
  const a = s.distanceTo(e), b = e.distanceTo(h);
  const dir = _dir.copy(target).sub(s);
  let d = dir.length();
  dir.divideScalar(Math.max(d, 1e-5));
  d = Math.min(d, (a + b) * 0.999);
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = _perp.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = _tgt.copy(s).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  const sx = s.x, sy = s.y, sz = s.z;
  aimBone(upper, fore, elbow);
  aimBone(fore, hand, _tgt.set(sx, sy, sz).addScaledVector(dir, d));
}

/** turn the hand so its fingers / palm match the grip socket */
const _f0 = new THREE.Vector3(), _n0 = new THREE.Vector3(), _f = new THREE.Vector3(), _n = new THREE.Vector3(), _x = new THREE.Vector3();
const _M0 = new THREE.Matrix4(), _M = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _mq = new THREE.Quaternion();
function orientHand(hand: THREE.Bone, sock: THREE.Object3D, side: 1 | -1, model: THREE.Object3D) {
  sock.getWorldQuaternion(_sq);
  _f.set(0, 0, -1).applyQuaternion(_sq);
  _n.set(0, -1, 0).applyQuaternion(_sq);
  // rest hand (model space): fingers down, palm facing the body's centre line
  model.getWorldQuaternion(_mq);
  _f0.set(0, -1, 0).applyQuaternion(_mq);
  _n0.set(-side, 0, 0).applyQuaternion(_mq);
  _M0.makeBasis(_f0, _n0, _x.crossVectors(_f0, _n0));
  _n.addScaledVector(_f, -_n.dot(_f)).normalize();
  _M.makeBasis(_f, _n, _x.crossVectors(_f, _n).normalize());
  _M.multiply(_M0.transpose());
  const world = _q.setFromRotationMatrix(_M).multiply(_mq);
  hand.parent!.getWorldQuaternion(_q3);
  hand.quaternion.copy(_q3.invert().multiply(world));
  hand.updateMatrix();
}
