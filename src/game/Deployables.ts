import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../core/Physics';
import { Combatant } from './Combatant';
import { Explosives, Grenade, CLAYMORE } from './Explosives';
import { Effects } from '../fx/Effects';
import { makeClaymore, makeTrophy, setLed } from '../weapons/EquipmentModels';

/**
 * World-side equipment that stays put after you place it:
 *
 *  Claymore — directional mine on scissor legs with two visible red tripwire beams fanning out
 *    from its laser module. An enemy crossing the fan (inside ~3.4 m, in front, in sight of it)
 *    sets it off after a short click; the blast is directional (full damage forward, very little
 *    behind). Shooting it or a nearby explosion destroys it (a nearby blast sets it off).
 *
 *  Trophy system — active protection. Once its legs are down and it has spun up, it shoots down
 *    enemy grenades, sticky grenades, C4, snapshot/decoy grenades and throwing knives that come
 *    within ~7.5 m (line of sight), three charges, then it burns out. It can be shot (4 hits).
 */
export interface Claymore {
  id: number;
  owner: Combatant;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  yaw: number;
  mesh: THREE.Group;
  beams: THREE.Mesh[];
  t: number;
  trip: number;
  collider: RAPIER.Collider | null;
  dead: boolean;
}
export interface Trophy {
  id: number;
  owner: Combatant;
  pos: THREE.Vector3;
  mesh: THREE.Group;
  t: number;
  charges: number;
  cd: number;
  hp: number;
  life: number;
  collider: RAPIER.Collider | null;
  dead: boolean;
  /** drop-in animation: it lands from the shove */
  fall: number;
  y0: number;
}

export interface DeployHooks {
  sound(name: string, p: THREE.Vector3, opts?: { gain?: number; rate?: number; ref?: number }): void;
  /** a trophy shot something down (for HUD feedback, score) */
  intercepted(t: Trophy, what: string): void;
  /** a claymore went off or a deployable was destroyed */
  destroyed(kind: 'claymore' | 'trophy', owner: Combatant, by: Combatant | null): void;
  /** enemy throwing knives in flight (the trophy shoots those down too) */
  knives(): { pos: THREE.Vector3; owner: Combatant; stuck: boolean; dead?: boolean }[];
}

const TRIP_R = 3.4;
const TRIP_COS = Math.cos(THREE.MathUtils.degToRad(52));
const TROPHY_R = 7.5;

export class Deployables {
  claymores: Claymore[] = [];
  trophies: Trophy[] = [];
  private nextId = 1;
  private beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.12, 0.06), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private beamGeo: THREE.CylinderGeometry;
  private zaps: { mesh: THREE.Mesh; t: number }[] = [];
  private scanT = 0;

  constructor(private scene: THREE.Scene, private physics: Physics, private explosives: Explosives, private fx: Effects, private players: () => Combatant[], private hooks: DeployHooks) {
    this.beamGeo = new THREE.CylinderGeometry(0.0025, 0.0025, 1, 4, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.beamGeo.rotateX(-Math.PI / 2); // along -Z
    const zm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 3.5, 6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const zg = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    zg.translate(0, 0.5, 0);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(zg, zm);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.zaps.push({ mesh: m, t: 0 });
    }
  }

  // ------------------------------------------------------------------ claymore
  placeClaymore(owner: Combatant, pos: THREE.Vector3, yaw: number, id = this.nextId++) {
    const mesh = makeClaymore();
    (mesh.userData.setLegs as (k: number) => void)(1);
    // the legs stand it ~5 cm off the ground; tip it to the slope it stands on
    const down = this.physics.raycast(pos.clone().setY(pos.y + 0.6), new THREE.Vector3(0, -1, 0), 2);
    const p = down ? down.point.clone() : pos.clone();
    const n = down ? down.normal.clone() : new THREE.Vector3(0, 1, 0);
    mesh.position.copy(p).setY(p.y + 0.083);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        (o as THREE.Mesh).frustumCulled = true;
      }
    });
    const led = mesh.getObjectByName('led') as THREE.Mesh | undefined;
    if (led) led.material = (led.material as THREE.Material).clone();
    this.scene.add(mesh);
    const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    // two tripwire beams fanning ±24° from the lenses
    const beams: THREE.Mesh[] = [];
    mesh.updateMatrixWorld(true);
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(this.beamGeo, this.beamMat);
      const lens = mesh.getObjectByName(side < 0 ? 'lens' : 'lens2')!;
      lens.getWorldPosition(b.position);
      const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), side * 0.42);
      d.y = -0.012;
      // stop the beam on whatever it runs into
      const hit = this.physics.raycast(b.position, d.clone().normalize(), TRIP_R);
      b.scale.set(1, 1, hit ? hit.distance : TRIP_R);
      b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), d.normalize());
      b.visible = false;
      b.frustumCulled = false;
      this.scene.add(b);
      beams.push(b);
    }
    const c: Claymore = { id, owner, pos: mesh.position.clone(), dir, yaw, mesh, beams, t: 0, trip: -1, collider: null, dead: false };
    c.collider = this.physics.addBox(c.pos.clone(), new THREE.Vector3(0.11, 0.045, 0.03), mesh.quaternion, {
      surface: 'metal', penetrable: 0,
      onHit: (_p, _d, _pw, by) => this.destroyClaymore(c, (by as Combatant) ?? null, false),
    });
    this.claymores.push(c);
    // a player can only have two out: the oldest goes
    const mine = this.claymores.filter((o) => o.owner === owner && !o.dead);
    if (mine.length > 2) this.removeClaymore(mine[0]);
    return c;
  }

  private removeClaymore(c: Claymore) {
    c.dead = true;
    this.scene.remove(c.mesh);
    for (const b of c.beams) this.scene.remove(b);
    if (c.collider) this.physics.remove(c.collider);
    c.collider = null;
    const i = this.claymores.indexOf(c);
    if (i >= 0) this.claymores.splice(i, 1);
  }

  /** shot (pops harmlessly in a shower of sparks) or caught in a blast (goes off) */
  destroyClaymore(c: Claymore, by: Combatant | null, detonate: boolean) {
    if (c.dead) return;
    if (by && by !== c.owner && by.team === c.owner.team) return; // friendly fire does nothing
    if (detonate) {
      this.fire(c);
      return;
    }
    this.removeClaymore(c);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 14; i++) this.fx.sparks.spawn(c.pos, new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 5, (Math.random() - 0.5) * 6), [5, 3, 1], 1, 0.03, 0.3 + Math.random() * 0.3, { drag: 0.6, grav: 9.8 });
    this.fx.smokePuff(c.pos.clone().addScaledVector(up, 0.2), new THREE.Vector3(0, 0.6, 0), [0.25, 0.25, 0.24], 0.6, 2);
    this.hooks.sound('imp_metal', c.pos, { gain: 0.8, rate: 0.8 });
    this.hooks.destroyed('claymore', c.owner, by);
  }

  private fire(c: Claymore) {
    if (c.dead) return;
    this.removeClaymore(c);
    this.explosives.explode(c.pos.clone().addScaledVector(c.dir, 0.15), c.owner, CLAYMORE, 7, 230, null, { dir: c.dir, cos: Math.cos(THREE.MathUtils.degToRad(62)) });
    // the pellet fan: a cone of sparks forward
    for (let i = 0; i < 40; i++) {
      const d = c.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 1.6);
      d.y = (Math.random() - 0.3) * 0.35;
      this.fx.sparks.spawn(c.pos.clone().setY(c.pos.y + 0.1), d.multiplyScalar(30 + Math.random() * 25), [4, 2.4, 1], 1, 0.025, 0.12 + Math.random() * 0.12, { drag: 0.5 });
    }
  }

  // ------------------------------------------------------------------ trophy
  deployTrophy(owner: Combatant, pos: THREE.Vector3, yaw: number, id = this.nextId++) {
    const mesh = makeTrophy();
    mesh.scale.setScalar(1.55); // the field unit is bigger than the hand-carried model reads
    const down = this.physics.raycast(pos.clone().setY(pos.y + 0.8), new THREE.Vector3(0, -1, 0), 3);
    const p = down ? down.point.clone() : pos.clone();
    mesh.position.copy(p).setY(p.y + 0.17);
    mesh.rotation.y = yaw;
    mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        (o as THREE.Mesh).frustumCulled = true;
      }
    });
    const lamp = mesh.getObjectByName('lamp') as THREE.Mesh | undefined;
    if (lamp) lamp.material = (lamp.material as THREE.Material).clone();
    this.scene.add(mesh);
    const t: Trophy = { id, owner, pos: mesh.position.clone(), mesh, t: 0, charges: 3, cd: 0, hp: 4, life: 60, collider: null, dead: false, fall: 0, y0: mesh.position.y };
    t.collider = this.physics.addCylinder(t.pos.clone().setY(t.pos.y + 0.1), 0.2, 0.14, {
      surface: 'metal', penetrable: 0,
      onHit: (_p, _d, pw, by) => {
        const b = (by as Combatant) ?? null;
        if (b && b.team === t.owner.team && b !== t.owner) return;
        t.hp -= pw ?? 1;
        this.fx.sparks.spawn(t.pos.clone().setY(t.pos.y + 0.3), new THREE.Vector3((Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3), [5, 3, 1], 1, 0.025, 0.25, { drag: 0.6, grav: 9.8 });
        if (t.hp <= 0) this.destroyTrophy(t, b);
      },
    });
    this.trophies.push(t);
    for (const o of this.trophies.filter((x) => x.owner === owner && x !== t)) this.destroyTrophy(o, null, true);
    this.hooks.sound('trophyDeploy', t.pos, { gain: 1, ref: 5 });
    return t;
  }

  destroyTrophy(t: Trophy, by: Combatant | null, quiet = false) {
    if (t.dead) return;
    t.dead = true;
    this.scene.remove(t.mesh);
    if (t.collider) this.physics.remove(t.collider);
    t.collider = null;
    const i = this.trophies.indexOf(t);
    if (i >= 0) this.trophies.splice(i, 1);
    if (quiet) return;
    const c = t.pos.clone().setY(t.pos.y + 0.25);
    for (let k = 0; k < 24; k++) this.fx.sparks.spawn(c, new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 6, (Math.random() - 0.5) * 7), [5, 3, 1.2], 1, 0.03, 0.3 + Math.random() * 0.4, { drag: 0.6, grav: 9.8 });
    for (let k = 0; k < 5; k++) this.fx.smokePuff(c.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(0.4)), new THREE.Vector3(0, 0.8, 0), [0.2, 0.2, 0.2], 0.8, 3);
    this.hooks.sound('zap', c, { gain: 1, rate: 0.7 });
    this.hooks.sound('imp_metal_heavy', c, { gain: 0.9 });
    this.hooks.destroyed('trophy', t.owner, by);
  }

  /** called by the explosives every frame per grenade: shoot it down if a trophy covers it */
  intercept(g: Grenade) {
    if (!this.trophies.length) return false;
    for (const t of this.trophies) {
      if (t.dead || t.t < 1.1 || t.charges <= 0 || t.cd > 0) continue;
      if (g.owner.team === t.owner.team) continue;
      if (g.pos.distanceToSquared(t.pos) > TROPHY_R * TROPHY_R) continue;
      const head = this.headPos(t);
      if (!this.physics.lineOfSight(head, g.pos)) continue;
      this.zap(t, g.pos, g.kind);
      return true;
    }
    return false;
  }

  /** the sensor head (just above the trophy's own collider, so its sight lines start in the open) */
  private headPos(t: Trophy) {
    return t.pos.clone().setY(t.pos.y + 0.42);
  }

  private zap(t: Trophy, at: THREE.Vector3, what: string) {
    t.charges--;
    t.cd = 0.4;
    const head = this.headPos(t);
    const z = this.zaps.find((x) => x.t <= 0) ?? this.zaps[0];
    z.t = 0.13;
    z.mesh.visible = true;
    z.mesh.position.copy(head);
    z.mesh.scale.set(1, head.distanceTo(at), 1);
    z.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), at.clone().sub(head).normalize());
    // the round pops in the air: flash, a puff and falling bits
    for (let i = 0; i < 18; i++) this.fx.sparks.spawn(at, new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6), [3, 5, 8], 1, 0.03, 0.2 + Math.random() * 0.3, { drag: 0.6, grav: 9.8 });
    this.fx.sparks.spawn(at, new THREE.Vector3(), [6, 8, 12], 1, 0.6, 0.08, { grow: 2 });
    this.fx.smokePuff(at, new THREE.Vector3(0, 0.4, 0), [0.32, 0.32, 0.33], 0.7, 2.2);
    for (let i = 0; i < 3; i++) this.fx.sparks.spawn(head, new THREE.Vector3((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2), [2, 4, 7], 1, 0.02, 0.25, { drag: 0.5, grav: 9.8 });
    this.hooks.sound('zap', at, { gain: 1.1, ref: 6 });
    this.hooks.intercepted(t, what);
    // head snaps toward the threat
    const head3 = t.mesh.getObjectByName('head');
    if (head3) head3.rotation.y = Math.atan2(at.x - t.pos.x, at.z - t.pos.z) - t.mesh.rotation.y;
  }

  /** a blast nearby: set off claymores, wreck trophies */
  blast(p: THREE.Vector3, radius: number, by: Combatant) {
    for (const c of this.claymores.slice()) {
      const d = c.pos.distanceTo(p);
      if (d < Math.min(3.2, radius * 0.45) && d > 0.3) {
        // chain reaction, a beat later
        window.setTimeout(() => this.destroyClaymore(c, by, true), 120 + d * 40);
      }
    }
    for (const t of this.trophies.slice()) if (t.pos.distanceTo(p) < Math.min(3, radius * 0.4)) this.destroyTrophy(t, by);
  }

  update(dt: number, camPos: THREE.Vector3) {
    for (const z of this.zaps) {
      if (z.t <= 0) continue;
      z.t -= dt;
      if (z.t <= 0) z.mesh.visible = false;
    }
    // ---- claymores (proximity scan ~20 Hz)
    this.scanT -= dt;
    const scan = this.scanT <= 0;
    if (scan) this.scanT = 0.05;
    for (const c of this.claymores.slice()) {
      c.t += dt;
      const armed = c.t > 0.9;
      const near = c.pos.distanceToSquared(camPos) < 60 * 60;
      for (const b of c.beams) b.visible = armed && near;
      setLed(c.mesh.getObjectByName('led'), armed ? ((c.t * 1.3) % 1 < 0.12 ? 1 : 0.1) : 0.5);
      if (c.trip >= 0) {
        c.trip -= dt;
        if (c.trip < 0) this.fire(c);
        continue;
      }
      if (!armed || !scan) continue;
      for (const e of this.players()) {
        if (!e.alive || e.team === c.owner.team) continue;
        const ep = e.position();
        const dx = ep.x - c.pos.x, dz = ep.z - c.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > TRIP_R * TRIP_R || Math.abs(ep.y - c.pos.y) > 1.6) continue;
        const d = Math.sqrt(d2);
        if ((dx * c.dir.x + dz * c.dir.z) / Math.max(d, 1e-3) < TRIP_COS) continue;
        if (!this.physics.lineOfSight(c.pos.clone().setY(c.pos.y + 0.12), ep.clone().setY(ep.y + 0.5))) continue;
        c.trip = 0.24;
        this.hooks.sound('claymoreClick', c.pos, { gain: 1, ref: 3 });
        break;
      }
    }
    // ---- trophies: settle, spin, blink, time out; knives are shot down here too
    for (const t of this.trophies.slice()) {
      t.t += dt;
      t.cd = Math.max(0, t.cd - dt);
      t.life -= dt;
      const legs = Math.min(1, t.t / 0.45);
      (t.mesh.userData.setLegs as (k: number) => void)(1 - Math.pow(1 - legs, 3));
      const head = t.mesh.getObjectByName('head');
      if (head && t.t > 0.6 && t.cd <= 0) head.rotation.y += dt * (t.t < 1.1 ? (t.t - 0.6) * 8 : 4);
      setLed(t.mesh.getObjectByName('lamp'), t.charges > 0 ? (t.t < 1.1 ? 0.5 : (t.t * 1.5) % 1 < 0.15 ? 1 : 0.15) : 0);
      if (t.t > 1.1 && Math.floor((t.t - dt) * 0.5) !== Math.floor(t.t * 0.5)) this.hooks.sound('beepLow', t.pos, { gain: 0.25, rate: 1.4, ref: 2 });
      if (t.t > 1.1 && t.charges > 0 && t.cd <= 0) {
        for (const k of this.hooks.knives()) {
          if (k.stuck || k.dead || k.owner.team === t.owner.team) continue;
          if (k.pos.distanceToSquared(t.pos) > TROPHY_R * TROPHY_R) continue;
          if (!this.physics.lineOfSight(this.headPos(t), k.pos)) continue;
          k.dead = true;
          this.zap(t, k.pos.clone(), 'knife');
          break;
        }
      }
      if (t.charges <= 0 && t.cd <= 0) this.destroyTrophy(t, null);
      else if (t.life <= 0) this.destroyTrophy(t, null);
    }
  }

  /** Remove everything belonging to one soldier (team change / leave), or all of it (match reset). */
  clear(owner?: Combatant) {
    for (const c of this.claymores.slice()) if (!owner || c.owner === owner) this.removeClaymore(c);
    for (const t of this.trophies.slice()) if (!owner || t.owner === owner) this.destroyTrophy(t, null, true);
  }
}
