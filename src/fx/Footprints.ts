import * as THREE from 'three';
import type { TextureBaker } from '../render/TextureBaker';

/**
 * Boot prints in snow and wet sand (Update 33): one instanced draw for every print on the map, a
 * ring buffer of the most recent ones, each fading out over a minute. Left / right prints are
 * offset either side of the walking line and follow the mover's heading.
 */
const MAX = 220;
export class Footprints {
  mesh: THREE.InstancedMesh;
  private born = new Float32Array(MAX);
  private aFade: THREE.InstancedBufferAttribute;
  private next = 0;
  private side = new Map<number, number>();
  private o = new THREE.Object3D();
  private t = 0;
  life = 60;

  constructor(scene: THREE.Scene, baker: TextureBaker) {
    // a boot sole: heel and forefoot pads with tread bars, darker at the edges where it is pressed in
    const tex = baker.raw('fx.footprint', `void main(){ vec2 p = vUv * 2.0 - 1.0; p.x *= 2.2;
      float fore = length((p - vec2(0.0, 0.35)) * vec2(1.0, 0.9));
      float heel = length((p - vec2(0.0, -0.55)) * vec2(1.1, 1.3));
      float sole = max(smoothstep(0.62, 0.52, fore), smoothstep(0.46, 0.38, heel));
      float tread = 0.75 + 0.25 * step(0.5, fract(p.y * 5.0));
      float rim = smoothstep(0.35, 0.62, fore) * smoothstep(0.62, 0.55, fore) + smoothstep(0.28, 0.46, heel) * smoothstep(0.46, 0.4, heel);
      gl_FragColor = vec4(vec3(tread), clamp(sole * 0.85 + rim * 0.3, 0.0, 1.0)); }`, 64, false);
    const g = new THREE.PlaneGeometry(0.13, 0.3);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({ map: tex, color: 0x6f7880, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, roughness: 0.9 });
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aFade.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aFade', this.aFade);
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFade; varying float vFade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;').replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vFade;');
    };
    this.mesh = new THREE.InstancedMesh(g, m, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.layers.set(1);
    scene.add(this.mesh);
  }

  /** a print where `id` just stepped (heading yaw, ground point / normal); `tint` darker for sand */
  step(id: number, p: THREE.Vector3, yaw: number, n: THREE.Vector3, sand: boolean) {
    const s = (this.side.get(id) ?? 1) * -1;
    this.side.set(id, s);
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const o = this.o;
    o.position.copy(p).addScaledVector(right, s * 0.11).addScaledVector(n, 0.015);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + (Math.random() - 0.5) * 0.15));
    o.scale.set(s, 1, 1);
    o.updateMatrix();
    this.mesh.setMatrixAt(i, o.matrix);
    this.mesh.setColorAt(i, sand ? new THREE.Color(0.55, 0.47, 0.36) : new THREE.Color(0.62, 0.68, 0.76));
    this.born[i] = this.t;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    this.t += dt;
    const n = this.mesh.count;
    if (!n) return;
    const a = this.aFade.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const age = this.t - this.born[i];
      a[i] = age > this.life ? 0 : Math.min(1, (this.life - age) / 15);
    }
    this.aFade.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
    this.next = 0;
  }
}
