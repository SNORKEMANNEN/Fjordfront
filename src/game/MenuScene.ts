import * as THREE from 'three';
import { Soldier } from '../character/Soldier';
import { newAnimState, AnimState } from '../character/SoldierAnim';
import { roleFor } from '../character/SoldierMesh';
import { WEAPONS } from '../weapons/WeaponDefs';
import type { WeaponModel, WeaponId } from '../weapons/WeaponModels';
import type { Terrain } from '../world/Terrain';

/**
 * The main menu's live 3D scene: your soldier — our procedural soldier in your side's camo,
 * holding your current primary — standing on the quay at Brygga with the fjord behind, the camera
 * close and slowly breathing. The menu UI sits left and right; the soldier fills the middle.
 */
export class MenuScene {
  root = new THREE.Group();
  private soldier: Soldier | null = null;
  private weapon: WeaponModel | null = null;
  private weaponId = '';
  private team: 0 | 1 = 0;
  private st: AnimState = newAnimState();
  private t = 0;
  private spot = new THREE.Vector3();
  private yaw = 0;
  private camYaw = 0;
  private head = new THREE.Vector3();
  /** clear(a, b): nothing solid between two points (physics line of sight) */
  constructor(private scene: THREE.Scene, private terrain: Terrain, private buildWeapon: (id: WeaponId) => WeaponModel, private clear: (a: THREE.Vector3, b: THREE.Vector3) => boolean) {
    this.root.name = 'menuSoldier';
    this.pickSpot();
  }

  /**
   * Where the soldier stands: searched once over the map — dry, level ground near the shore with
   * open water behind them (the camera looks past them over the fjord), a clear line from the
   * camera, and nothing solid right behind or beside them to fill the frame.
   */
  private pickSpot() {
    const t = this.terrain;
    const cands: { x: number; z: number; yaw: number; s: number }[] = [];
    for (let x = -170; x <= 170; x += 5) {
      for (let z = -170; z <= 170; z += 5) {
        const h = t.heightAt(x, z);
        if (h < 0.7 || h > 9) continue;
        const slope = Math.abs(t.heightAt(x + 1.5, z) - t.heightAt(x - 1.5, z)) + Math.abs(t.heightAt(x, z + 1.5) - t.heightAt(x, z - 1.5));
        if (slope > 0.5) continue;
        for (let k = 0; k < 16; k++) {
          const yaw = (k / 16) * Math.PI * 2;
          const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
          // behind the soldier (away from the camera): how much of it is open water
          let water = 0;
          for (let d = 12; d <= 120; d += 12) if (t.heightAt(x - fx * d, z - fz * d) < 0) water++;
          // the camera stands on dry ground in front
          const cx = x + fx * 6.2, cz = z + fz * 6.2;
          if (t.heightAt(cx, cz) > h + 1.2 || t.heightAt(cx, cz) < 0.2) continue;
          cands.push({ x, z, yaw, s: water * 2 - slope * 4 + (water >= 6 ? 4 : 0) });
        }
      }
    }
    cands.sort((a, b) => b.s - a.s);
    // physics checks on the best few: camera → soldier clear, and the frame behind them open
    let pick = cands[0];
    for (const c of cands.slice(0, 120)) {
      const h = t.heightAt(c.x, c.z);
      const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
      const cam = new THREE.Vector3(c.x + fx * 6.2 + rx * 0.9, h + 1.35, c.z + fz * 6.2 + rz * 0.9);
      const head = new THREE.Vector3(c.x, h + 1.5, c.z);
      if (!this.clear(cam, head) || !this.clear(cam, new THREE.Vector3(c.x, h + 0.6, c.z))) continue;
      const back = new THREE.Vector3(c.x - fx * 30, h + 2, c.z - fz * 30);
      const side = new THREE.Vector3(c.x - fx * 14 + rx * 6, h + 1.5, c.z - fz * 14 + rz * 6);
      if (!this.clear(head, back) || !this.clear(head, side)) continue;
      pick = c;
      break;
    }
    if (!pick) pick = { x: -78, z: 6, yaw: -Math.PI / 2, s: 0 };
    this.spot.set(pick.x, t.heightAt(pick.x, pick.z), pick.z);
    // face the camera, turned a touch for a three-quarter view
    this.yaw = pick.yaw - 0.3;
    this.camYaw = pick.yaw;
  }

  /** dress the soldier: side, primary weapon */
  setKit(team: 0 | 1, primary: WeaponId) {
    if (this.soldier && team === this.team && primary === this.weaponId) return;
    const def = WEAPONS[primary];
    if (!this.soldier || team !== this.team) {
      if (this.soldier) this.root.remove(this.soldier.model);
      this.soldier = new Soldier({ role: roleFor(def.cls, def.id), seed: 4711 }, team, null);
      this.soldier.setLod(0);
      this.root.add(this.soldier.model);
      this.weaponId = '';
    }
    this.team = team;
    if (primary !== this.weaponId) {
      const w = this.buildWeapon(primary);
      w.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      this.soldier.setWeapon(w);
      this.weapon = w;
      this.weaponId = primary;
      this.st.pistol = def.cls === 'Pistol';
    }
  }

  show(v: boolean) {
    if (v && !this.root.parent) this.scene.add(this.root);
    if (!v && this.root.parent) this.scene.remove(this.root);
  }

  /** pose the soldier and frame the camera; returns the screen point above the head (for the name tag) */
  update(dt: number, cam: THREE.PerspectiveCamera, viewW: number, viewH: number) {
    if (!this.soldier) return null;
    this.t += dt;
    const s = this.st;
    // relaxed low ready, now and then glancing about (the animator's idle fidgets do the rest)
    s.ready = false;
    s.calm = true;
    s.vel.set(0, 0, 0);
    s.yaw = this.yaw;
    s.aimYaw = this.yaw + Math.sin(this.t * 0.23) * 0.22 + Math.sin(this.t * 0.61) * 0.06;
    s.aimPitch = -0.12 + Math.sin(this.t * 0.37) * 0.05;
    this.root.position.copy(this.spot);
    this.root.rotation.y = this.yaw + Math.PI;
    this.root.updateMatrixWorld(true);
    this.soldier.pose(s, dt, this.root);
    // camera: in front of the soldier, a little to their left, chest height, slow breathing drift;
    // the soldier stands slightly right of centre (the menu panels own the left)
    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const wide = viewW / Math.max(1, viewH);
    const dist = 6.2 + Math.max(0, 1.6 - wide) * 2.5;
    const p = this.spot.clone().addScaledVector(fwd, dist).addScaledVector(right, 0.9 + Math.sin(this.t * 0.07) * 0.12);
    p.y += 1.35 + Math.sin(this.t * 0.11) * 0.04;
    cam.position.copy(p);
    const look = this.spot.clone().addScaledVector(right, 0.9 + 0.12 * Math.min(1.2, wide / 1.78)).setY(this.spot.y + 1.0);
    cam.lookAt(look);
    cam.fov = 38;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.head.copy(this.spot).y += 2.25;
    const v = this.head.clone().project(cam);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * viewW, y: (-v.y * 0.5 + 0.5) * viewH };
  }
}
