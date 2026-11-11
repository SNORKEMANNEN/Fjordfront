import * as THREE from 'three';
import { Soldier } from './Soldier';
import { newAnimState } from './SoldierAnim';
import type { WeaponModel } from '../weapons/WeaponModels';

/**
 * Far soldiers as billboards. Past ~150 m a soldier is a handful of pixels tall: drawing a skinned
 * mesh (plus its gun) for it is wasted work. At load each faction's soldier is rendered once into a
 * small atlas — 8 view angles × 3 frames (standing, two running strides) — and every far soldier
 * becomes one instance of a single camera-facing quad (one draw call for all of them), picking the
 * cell for its facing relative to the camera and its stride. Lit like the scene's daylight, darkened
 * by the scene exposure / night, fogged like everything else.
 */
const ANG = 8, FR = 3, CW = 64, CH = 128;
const COLS = ANG * FR; // per team row
export class Impostors {
  mesh: THREE.InstancedMesh;
  private cell: THREE.InstancedBufferAttribute;
  private rt: THREE.WebGLRenderTarget;
  private n = 0;
  private max: number;
  private mat: THREE.MeshBasicMaterial;
  private dummy = new THREE.Object3D();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, weapons: [WeaponModel, WeaponModel], max = 32) {
    this.max = max;
    this.rt = new THREE.WebGLRenderTarget(COLS * CW, 2 * CH, { colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.bake(renderer, weapons);
    this.mat = new THREE.MeshBasicMaterial({ map: this.rt.texture, alphaTest: 0.45, side: THREE.DoubleSide, color: 0xffffff });
    this.mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCell;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = vec2((mod(aCell, ${COLS.toFixed(1)}) + uv.x) / ${COLS.toFixed(1)}, (floor(aCell / ${COLS.toFixed(1)}) + uv.y) / 2.0);`);
    };
    this.mat.customProgramCacheKey = () => 'impostor1';
    const quad = new THREE.PlaneGeometry(0.9, 1.8).translate(0, 0.9, 0);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    quad.setAttribute('aCell', this.cell);
    this.mesh = new THREE.InstancedMesh(quad, this.mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);
    this.mesh.name = 'impostors';
    scene.add(this.mesh);
  }

  /** render the atlas: per team, 8 angles × (stand, stride A, stride B) */
  private bake(renderer: THREE.WebGLRenderer, weapons: [WeaponModel, WeaponModel]) {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a3428, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    sun.position.set(0.6, 1, 0.8);
    scene.add(sun);
    const cam = new THREE.OrthographicCamera(-0.45, 0.45, 1.85, -0.05, 0.1, 10);
    const prev = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.autoClear = true;
    for (const team of [0, 1] as const) {
      const sol = new Soldier({ role: 'rifleman', seed: 77 + team }, team, weapons[team]);
      sol.setLod(1);
      const root = new THREE.Group();
      root.add(sol.model);
      scene.add(root);
      for (let f = 0; f < FR; f++) {
        // fresh animator per frame type, run long enough to settle into the stride
        const st = newAnimState();
        st.ready = false;
        if (f > 0) st.vel.set(0, 0, -4.2);
        for (let k = 0; k < 40; k++) sol.pose(st, 1 / 60, root);
        // step to the wanted stride phase
        if (f > 0) for (let k = 0; k < 60 && Math.abs(sol.anim.phase - (f === 1 ? 0.25 : 0.75)) > 0.03; k++) sol.pose(st, 1 / 60, root);
        for (let a = 0; a < ANG; a++) {
          // camera orbits the soldier (who faces world -Z, yaw 0)
          const ang = (a / ANG) * Math.PI * 2;
          cam.position.set(-Math.sin(ang) * 4, 0, -Math.cos(ang) * 4);
          cam.lookAt(0, 0, 0);
          cam.updateMatrixWorld();
          root.rotation.y = Math.PI;
          root.updateMatrixWorld(true);
          const col = a * FR + f;
          // (a render target's viewport / scissor live on the target itself)
          this.rt.viewport.set(col * CW, team * CH, CW, CH);
          this.rt.scissor.set(col * CW, team * CH, CW, CH);
          this.rt.scissorTest = true;
          renderer.setRenderTarget(this.rt);
          renderer.render(scene, cam);
        }
      }
      scene.remove(root);
      sol.setWeapon(null);
    }
    this.rt.scissorTest = false;
    this.rt.viewport.set(0, 0, this.rt.width, this.rt.height);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
  }

  begin() {
    this.n = 0;
  }
  /**
   * Add a far soldier. `rel` = soldier yaw minus the camera's bearing to it; `moving` picks a
   * stride frame by gait phase.
   */
  add(pos: THREE.Vector3, camPos: THREE.Vector3, yaw: number, team: number, moving: boolean, phase: number) {
    if (this.n >= this.max) return false;
    const toCam = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
    // which side of the soldier faces the camera (soldier forward at yaw is (-sin, -cos))
    const rel = Math.atan2(Math.sin(toCam - (yaw + Math.PI)), Math.cos(toCam - (yaw + Math.PI)));
    let a = Math.round((rel / (Math.PI * 2)) * ANG) % ANG;
    if (a < 0) a += ANG;
    const f = moving ? (phase % 1 < 0.5 ? 1 : 2) : 0;
    this.cell.setX(this.n, team * COLS + a * FR + f);
    const d = this.dummy;
    d.position.copy(pos);
    d.rotation.set(0, toCam, 0);
    d.updateMatrix();
    this.mesh.setMatrixAt(this.n, d.matrix);
    this.n++;
    return true;
  }
  end(tint: number) {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.mat.color.setScalar(tint);
  }
}
