import * as THREE from 'three';
import { Physics } from '../core/Physics';

/**
 * Destructible window panes.
 *
 *  - the first ordinary round stars the pane: a spider-web crack decal (radial fractures plus
 *    concentric rings, procedurally drawn) at the impact point; the pane stays in the frame
 *  - the next round (or any shotgun / .338 hit, or an explosion nearby) shatters it: the pane
 *    vanishes, a burst of glass shards falls — mostly in the bullet's direction — tumbling and
 *    settling flat on whatever floor is below each side, and a few jagged pieces stay stuck in
 *    the frame corners
 *  - colliders go with the glass, so a shattered window can be shot and seen through cleanly
 *
 * All panes, cracks and shards are three InstancedMeshes (one draw call each).
 */
interface Pane { world: THREE.Matrix4; w: number; h: number; c: THREE.Vector3; n: THREE.Vector3; hits: number; collider: any; cracks: number[]; broken: boolean }
interface Shard { i: number; p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; axis: THREE.Vector3; spin: number; s: number; floor: number; life: number; rest: boolean; fixed: boolean }

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function crackTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  x.lineCap = 'round';
  // radial fractures, jagged, thinning outward
  const rays: [number, number][][] = [];
  const n = 13;
  for (let i = 0; i < n; i++) {
    let a = (i / n) * Math.PI * 2 + rnd() * 0.35;
    let r = 3;
    let px = cx, py = cy;
    const pts: [number, number][] = [[px, py]];
    const len = S * (0.3 + rnd() * 0.2);
    while (r < len) {
      r += 8 + rnd() * 12;
      a += (rnd() - 0.5) * 0.35;
      px = cx + Math.cos(a) * r;
      py = cy + Math.sin(a) * r;
      pts.push([px, py]);
    }
    rays.push(pts);
    for (let k = 1; k < pts.length; k++) {
      const t = k / pts.length;
      x.strokeStyle = `rgba(255,255,255,${0.95 - t * 0.55})`;
      x.lineWidth = 2.2 - t * 1.6;
      x.beginPath();
      x.moveTo(pts[k - 1][0], pts[k - 1][1]);
      x.lineTo(pts[k][0], pts[k][1]);
      x.stroke();
      // little side splinters
      if (rnd() < 0.3) {
        const sa = Math.atan2(pts[k][1] - cy, pts[k][0] - cx) + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.6);
        x.lineWidth = 0.8;
        x.beginPath();
        x.moveTo(pts[k][0], pts[k][1]);
        x.lineTo(pts[k][0] + Math.cos(sa) * (6 + rnd() * 10), pts[k][1] + Math.sin(sa) * (6 + rnd() * 10));
        x.stroke();
      }
    }
  }
  // concentric rings connecting neighbouring rays
  for (const ring of [2, 4, 6]) {
    for (let i = 0; i < rays.length; i++) {
      const a = rays[i], b = rays[(i + 1) % rays.length];
      if (a.length <= ring || b.length <= ring || rnd() < 0.3) continue;
      x.strokeStyle = `rgba(255,255,255,${0.75 - ring * 0.08})`;
      x.lineWidth = 1.1;
      x.beginPath();
      x.moveTo(a[ring][0], a[ring][1]);
      x.quadraticCurveTo((a[ring][0] + b[ring][0]) / 2 + (rnd() - 0.5) * 6, (a[ring][1] + b[ring][1]) / 2 + (rnd() - 0.5) * 6, b[ring][0], b[ring][1]);
      x.stroke();
    }
  }
  // crushed centre + the hole
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, 16);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(cx, cy, 16, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = 'rgba(20,24,26,0.9)';
  x.beginPath();
  x.arc(cx, cy, 3.2, 0, Math.PI * 2);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class GlassPanes {
  mesh: THREE.InstancedMesh;
  cracks: THREE.InstancedMesh;
  shards: THREE.InstancedMesh;
  private count = 0;
  private panes: Pane[] = [];
  private crackN = 0;
  private freeShards: number[] = [];
  private live: Shard[] = [];
  private physics!: Physics;
  onCrack: (p: THREE.Vector3) => void = () => {};
  onBreak: (p: THREE.Vector3) => void = () => {};

  constructor(mat: THREE.Material, max = 600) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    const cm = new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide, fog: true });
    this.cracks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), cm, 256);
    this.cracks.count = 256;
    for (let i = 0; i < 256; i++) this.cracks.setMatrixAt(i, ZERO);
    this.cracks.frustumCulled = false;
    this.cracks.renderOrder = 3;
    // a shard: an irregular sliver (two triangles), double sided
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.5, 0, -0.3, -0.35, 0, 0.42, -0.2, 0, 0.42, -0.2, 0, -0.3, -0.35, 0, 0.1, -0.55, 0], 3));
    sg.computeVertexNormals();
    const shardMat = new THREE.MeshStandardMaterial({ color: 0xd8ecf2, roughness: 0.04, metalness: 0.4, transparent: true, opacity: 0.6, side: THREE.DoubleSide, envMapIntensity: 1.6 });
    this.shards = new THREE.InstancedMesh(sg, shardMat, 700);
    this.shards.count = 700;
    for (let i = 0; i < 700; i++) {
      this.shards.setMatrixAt(i, ZERO);
      this.freeShards.push(699 - i);
    }
    this.shards.frustumCulled = false;
    this.shards.castShadow = false;
    this.mesh.add(this.cracks, this.shards);
  }

  add(physics: Physics, world: THREE.Matrix4, w: number, h: number): number {
    if (this.count >= this.mesh.instanceMatrix.count) return -1;
    this.physics = physics;
    const i = this.count++;
    const m = world.clone().multiply(new THREE.Matrix4().makeScale(w, h, 0.012));
    this.mesh.setMatrixAt(i, m);
    this.mesh.count = this.count;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    world.decompose(p, q, s);
    const pane: Pane = { world: world.clone(), w, h, c: p.clone(), n: new THREE.Vector3(0, 0, 1).applyQuaternion(q), hits: 0, collider: null, cracks: [], broken: false };
    pane.collider = physics.addBox(p, new THREE.Vector3(w / 2, h / 2, 0.02), q, {
      surface: 'glass',
      penetrable: 1,
      onHit: (pt, dir, power) => this.hit(i, pt, dir, power ?? 1),
    });
    this.panes[i] = pane;
    return i;
  }

  // ---------------- window frames (the cross bars), broken out when someone dives through
  frames: THREE.InstancedMesh | null = null;
  private frameN = 0;
  private frameM: THREE.Matrix4[] = [];
  private frameBase: THREE.Matrix4[] = [];
  private splinters: THREE.InstancedMesh | null = null;
  private freeSplinters: number[] = [];
  initFrames(mat: THREE.Material, max = 900) {
    this.frames = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.frames.count = 0;
    this.frames.castShadow = true;
    this.frames.receiveShadow = true;
    this.frames.frustumCulled = false;
    this.splinters = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 400);
    this.splinters.count = 400;
    for (let i = 0; i < 400; i++) {
      this.splinters.setMatrixAt(i, ZERO);
      this.freeSplinters.push(399 - i);
    }
    this.splinters.frustumCulled = false;
    this.mesh.add(this.frames, this.splinters);
  }
  /** A frame bar (world matrix of a unit box already scaled). Returns its index. */
  addFrame(m: THREE.Matrix4) {
    if (!this.frames || this.frameN >= this.frames.instanceMatrix.count) return -1;
    const i = this.frameN++;
    this.frames.setMatrixAt(i, m);
    this.frames.count = this.frameN;
    this.frameM[i] = m.clone();
    this.frameBase[i] = m.clone();
    return i;
  }
  /** Rip a window out: the glass shatters, its bars break into tumbling pieces and splinters. */
  breakFrame(bars: number[], pane: number, from: THREE.Vector3, dir: THREE.Vector3) {
    if (pane >= 0) this.shatter(pane, from, dir);
    if (!this.frames) return;
    for (const i of bars) {
      const m = this.frameM[i];
      if (!m) continue;
      this.frameM[i] = undefined as any;
      this.frames.setMatrixAt(i, ZERO);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      const floor = (() => {
        const h = this.physics.raycast(p.clone().addScaledVector(dir, 0.8).setY(p.y + 0.5), new THREE.Vector3(0, -1, 0), 6);
        return h ? h.point.y : p.y - 1.5;
      })();
      // each bar snaps in two; the halves and a handful of splinters fly in the push direction
      const long = s.x > s.y ? new THREE.Vector3(1, 0, 0).applyQuaternion(q) : new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const len = Math.max(s.x, s.y);
      for (const k of [-0.25, 0.25]) {
        const pp = p.clone().addScaledVector(long, k * len);
        const v = dir.clone().multiplyScalar(2 + Math.random() * 2.5).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5));
        this.spawnSplinter(pp, v, q, new THREE.Vector3(s.x > s.y ? len * 0.48 : s.x, s.x > s.y ? s.y : len * 0.48, s.z), floor);
      }
      for (let k = 0; k < 6; k++) {
        const pp = p.clone().addScaledVector(long, (Math.random() - 0.5) * len);
        const v = dir.clone().multiplyScalar(1.5 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 2.5, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 2.5));
        const sl = 0.03 + Math.random() * 0.08;
        this.spawnSplinter(pp, v, new THREE.Quaternion().random(), new THREE.Vector3(0.012, 0.012, sl), floor);
      }
    }
    this.frames.instanceMatrix.needsUpdate = true;
    this.onFrameBreak(from.clone());
  }
  onFrameBreak: (p: THREE.Vector3) => void = () => {};
  private wood: { i: number; p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; axis: THREE.Vector3; spin: number; s: THREE.Vector3; floor: number; life: number; rest: boolean }[] = [];
  private spawnSplinter(p: THREE.Vector3, v: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, floor: number) {
    if (!this.splinters) return;
    let i = this.freeSplinters.pop();
    if (i === undefined) {
      const old = this.wood.shift();
      if (!old) return;
      i = old.i;
    }
    this.wood.push({ i, p: p.clone(), v: v.clone(), q: q.clone(), axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), spin: 5 + Math.random() * 10, s: s.clone(), floor: floor + Math.min(s.x, s.y, s.z) * 0.5, life: 30 + Math.random() * 10, rest: false });
  }
  private updateWood(dt: number) {
    if (!this.splinters || !this.wood.length) return;
    for (let k = this.wood.length - 1; k >= 0; k--) {
      const w = this.wood[k];
      w.life -= dt;
      if (w.life <= 0) {
        this.splinters.setMatrixAt(w.i, ZERO);
        this.freeSplinters.push(w.i);
        this.wood.splice(k, 1);
        continue;
      }
      if (!w.rest) {
        w.v.y -= 9.81 * dt;
        w.p.addScaledVector(w.v, dt);
        w.q.premultiply(tmpQ.setFromAxisAngle(w.axis, w.spin * dt));
        if (w.p.y <= w.floor) {
          w.p.y = w.floor;
          if (w.v.y < -2) {
            w.v.set(w.v.x * 0.4, -w.v.y * 0.25, w.v.z * 0.4);
            w.spin *= 0.5;
          } else {
            w.rest = true;
            // lie flat on the floor (long axis horizontal)
            const yaw = Math.random() * Math.PI * 2;
            w.q.setFromEuler(new THREE.Euler(w.s.z > w.s.y ? 0 : Math.PI / 2, yaw, 0, 'YXZ'));
          }
        }
      }
      this.splinters.setMatrixAt(w.i, tmpM.compose(w.p, w.q, w.s));
    }
    this.splinters.instanceMatrix.needsUpdate = true;
  }

  /** A round hits pane `i`. */
  hit(i: number, pt: THREE.Vector3, dir: THREE.Vector3, power = 1) {
    const pane = this.panes[i];
    if (!pane || pane.broken) return;
    pane.hits += power;
    // big panes go sooner (more stress), small ones can take an extra round
    const strength = pane.w * pane.h > 3 ? 1.5 : 2;
    if (pane.hits >= strength) this.shatter(i, pt, dir);
    else this.crack(pane, pt);
  }

  private crack(pane: Pane, pt: THREE.Vector3) {
    const k = this.crackN++ % 256;
    const q = tmpQ.setFromRotationMatrix(tmpM.extractRotation(pane.world));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2));
    const size = Math.min(0.42 + Math.random() * 0.2, Math.min(pane.w, pane.h) * 1.1);
    // just in front of the glass on both faces (the plane is double sided, centred on the pane)
    const p = tmpP.copy(pt).addScaledVector(pane.n, pane.n.dot(tmpS.subVectors(pane.c, pt)));
    this.cracks.setMatrixAt(k, tmpM.compose(p, q, tmpS.set(size, size, 1)));
    this.cracks.instanceMatrix.needsUpdate = true;
    pane.cracks.push(k);
    this.onCrack(pt.clone());
  }

  /** Shatter pane `i`; `dir` is where the force came from (bullet direction / blast outward). */
  shatter(i: number, from: THREE.Vector3, dir: THREE.Vector3) {
    const pane = this.panes[i];
    if (!pane || pane.broken) return;
    pane.broken = true;
    if (pane.collider) this.physics.remove(pane.collider);
    pane.collider = null;
    this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const k of pane.cracks) this.cracks.setMatrixAt(k, ZERO);
    this.cracks.instanceMatrix.needsUpdate = true;
    // floors on both sides of the window
    const side = Math.sign(dir.dot(pane.n)) || 1;
    const floorAt = (s: number) => {
      const o = pane.c.clone().addScaledVector(pane.n, s * 0.7);
      const hit = this.physics.raycast(o, new THREE.Vector3(0, -1, 0), 8);
      return hit ? hit.point.y : pane.c.y - pane.h / 2 - 1;
    };
    const fFwd = floorAt(side), fBack = floorAt(-side);
    const rot = tmpQ.setFromRotationMatrix(tmpM.extractRotation(pane.world)).clone();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rot);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
    const local = from.clone().sub(pane.c);
    const hx = THREE.MathUtils.clamp(local.dot(right), -pane.w / 2, pane.w / 2);
    const hy = THREE.MathUtils.clamp(local.dot(up), -pane.h / 2, pane.h / 2);
    const n = Math.round(THREE.MathUtils.clamp(pane.w * pane.h * 14, 10, 34));
    for (let k = 0; k < n; k++) {
      // denser around the impact
      const u = Math.random() < 0.55 ? hx + (Math.random() - 0.5) * pane.w * 0.4 : (Math.random() - 0.5) * pane.w;
      const v = Math.random() < 0.55 ? hy + (Math.random() - 0.5) * pane.h * 0.4 : (Math.random() - 0.5) * pane.h;
      const p = pane.c.clone().addScaledVector(right, THREE.MathUtils.clamp(u, -pane.w / 2, pane.w / 2)).addScaledVector(up, THREE.MathUtils.clamp(v, -pane.h / 2, pane.h / 2));
      const near = 1 - Math.min(1, Math.hypot(u - hx, v - hy) / 0.6);
      const fwd = Math.random() < 0.8 ? side : -side;
      const vel = pane.n.clone().multiplyScalar(fwd * (0.4 + Math.random() * 1.2 + near * 2.2)).addScaledVector(right, (Math.random() - 0.5) * 1.2).addScaledVector(up, (Math.random() - 0.3) * 0.9);
      this.spawnShard(p, vel, rot, 0.03 + Math.random() * 0.09 * (1 - near * 0.5), fwd === side ? fFwd : fBack, false);
    }
    // jagged remnants left in the frame corners
    for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (Math.random() < 0.3) continue;
      const p = pane.c.clone().addScaledVector(right, cx * (pane.w / 2 - 0.04)).addScaledVector(up, cy * (pane.h / 2 - 0.05));
      const q = rot.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(-cy, -cx) - Math.PI / 2 + (Math.random() - 0.5) * 0.6));
      this.spawnShard(p, new THREE.Vector3(), q, 0.07 + Math.random() * 0.08, 0, true);
    }
    this.onBreak(from.clone());
  }

  /** Explosion: shatter every pane close enough, blown away from the blast. */
  blast(p: THREE.Vector3, r: number) {
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      if (pane.broken) continue;
      const d = pane.c.distanceTo(p);
      if (d < r * (0.6 + Math.random() * 0.4)) this.shatter(i, pane.c, pane.c.clone().sub(p).normalize());
    }
  }

  private spawnShard(p: THREE.Vector3, v: THREE.Vector3, q: THREE.Quaternion, s: number, floor: number, fixed: boolean) {
    let i = this.freeShards.pop();
    if (i === undefined) {
      // recycle the oldest loose shard
      const old = this.live.findIndex((x) => !x.fixed);
      if (old < 0) return;
      i = this.live[old].i;
      this.live.splice(old, 1);
    }
    const sh: Shard = { i, p: p.clone(), v: v.clone(), q: q.clone(), axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), spin: fixed ? 0 : 6 + Math.random() * 14, s, floor: floor + 0.004, life: fixed ? Infinity : 22 + Math.random() * 8, rest: fixed, fixed };
    this.live.push(sh);
    this.shards.setMatrixAt(i, tmpM.compose(sh.p, sh.q, tmpS.setScalar(s)));
    this.shards.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    this.updateWood(dt);
    if (!this.live.length) return;
    let dirty = false;
    for (let k = this.live.length - 1; k >= 0; k--) {
      const sh = this.live[k];
      sh.life -= dt;
      if (sh.life <= 0) {
        this.shards.setMatrixAt(sh.i, ZERO);
        this.freeShards.push(sh.i);
        this.live.splice(k, 1);
        dirty = true;
        continue;
      }
      if (sh.rest) {
        if (sh.life < 1.5) {
          this.shards.setMatrixAt(sh.i, tmpM.compose(sh.p, sh.q, tmpS.setScalar(sh.s * (sh.life / 1.5))));
          dirty = true;
        }
        continue;
      }
      sh.v.y -= 9.81 * dt;
      sh.v.multiplyScalar(1 - 0.6 * dt);
      sh.p.addScaledVector(sh.v, dt);
      sh.q.premultiply(tmpQ.setFromAxisAngle(sh.axis, sh.spin * dt));
      if (sh.p.y <= sh.floor) {
        sh.p.y = sh.floor;
        if (sh.v.y < -1.6) {
          // small skip off the floor, then lie flat
          sh.v.set(sh.v.x * 0.35, -sh.v.y * 0.18, sh.v.z * 0.35);
          sh.spin *= 0.5;
        } else {
          sh.rest = true;
          const yaw = Math.random() * Math.PI * 2;
          sh.q.setFromEuler(new THREE.Euler(-Math.PI / 2 + (Math.random() - 0.5) * 0.12, 0, yaw, 'YXZ'));
        }
      }
      this.shards.setMatrixAt(sh.i, tmpM.compose(sh.p, sh.q, tmpS.setScalar(sh.s)));
      dirty = true;
    }
    if (dirty) this.shards.instanceMatrix.needsUpdate = true;
  }

  /** New match: every window back in its frame. */
  reset() {
    if (this.frames) {
      for (let i = 0; i < this.frameN; i++) {
        if (!this.frameM[i]) this.frameM[i] = this.frameBase[i];
        this.frames.setMatrixAt(i, this.frameM[i]);
      }
      this.frames.instanceMatrix.needsUpdate = true;
      for (const w of this.wood) {
        this.splinters!.setMatrixAt(w.i, ZERO);
        this.freeSplinters.push(w.i);
      }
      this.wood.length = 0;
      this.splinters!.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      for (const k of pane.cracks) this.cracks.setMatrixAt(k, ZERO);
      pane.cracks = [];
      pane.hits = 0;
      if (!pane.broken) continue;
      pane.broken = false;
      this.mesh.setMatrixAt(i, pane.world.clone().multiply(new THREE.Matrix4().makeScale(pane.w, pane.h, 0.012)));
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      pane.world.decompose(p, q, s);
      pane.collider = this.physics.addBox(p, new THREE.Vector3(pane.w / 2, pane.h / 2, 0.02), q, { surface: 'glass', penetrable: 1, onHit: (pt, dir, power) => this.hit(i, pt, dir, power ?? 1) });
    }
    for (const sh of this.live) {
      this.shards.setMatrixAt(sh.i, ZERO);
      this.freeShards.push(sh.i);
    }
    this.live.length = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cracks.instanceMatrix.needsUpdate = true;
    this.shards.instanceMatrix.needsUpdate = true;
  }
}
