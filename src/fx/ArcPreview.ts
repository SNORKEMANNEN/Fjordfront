import * as THREE from 'three';
import type { Physics } from '../core/Physics';

/**
 * Optional throw-arc preview (Settings → Gameplay, off by default): while a throwable is held
 * ready, a dotted arc shows where it will fly and a ring marks where it first lands. The arc is
 * stepped with the same gravity and drag as the real grenade and stops at the first surface.
 */
const N = 48;
export class ArcPreview {
  private dots: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private o = new THREE.Object3D();
  private p = new THREE.Vector3();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();

  constructor(scene: THREE.Scene, private physics: Physics) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.5, 1.2), transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 6, 4), m, N);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 30;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.8), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 30;
    this.dots.layers.set(1);
    this.ring.layers.set(1);
    scene.add(this.dots, this.ring);
  }

  hide() {
    this.dots.count = 0;
    this.ring.visible = false;
  }

  /** draw the arc from `from` with launch velocity `vel` */
  show(from: THREE.Vector3, vel: THREE.Vector3, time: number) {
    const p = this.p.copy(from), v = this.v.copy(vel);
    const dt = 1 / 30;
    let n = 0;
    let landed = false;
    for (let i = 0; i < 120 && n < N; i++) {
      v.y -= 9.81 * dt;
      v.multiplyScalar(1 - 0.05 * dt);
      const step = this.d.copy(v).multiplyScalar(dt);
      const len = step.length();
      const hit = this.physics.raycast(p, step.divideScalar(len), len);
      if (hit) {
        p.copy(hit.point);
        this.ring.position.copy(hit.point).addScaledVector(hit.normal, 0.03);
        this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
        this.ring.scale.setScalar(1 + 0.08 * Math.sin(time * 6));
        landed = true;
        break;
      }
      p.addScaledVector(v, dt);
      // every other step, skipping the first few right in front of the face
      if (i > 1 && i % 2 === 0) {
        this.o.position.copy(p);
        this.o.scale.setScalar(1 - (n / N) * 0.4);
        this.o.updateMatrix();
        this.dots.setMatrixAt(n++, this.o.matrix);
      }
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    this.ring.visible = landed;
  }
}
