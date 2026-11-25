import * as THREE from 'three';
import { Combatant } from './Combatant';
import { Grenade } from './Explosives';
import { Bot, PLATE_HP } from '../ai/Bot';
import { EQUIP_BUILDERS, setLed } from '../weapons/EquipmentModels';
import { Anchor } from '../world/Lighting';
import { Door } from '../world/Doors';

/**
 * Update 47 — the new field kit, world side.
 *
 * Lethal
 *  thermite      sticks to whatever it hits (people too) and burns white-hot for 5 s: a fountain
 *                of sparks and molten drips, blinding glare, a roaring hiss; burns anyone within
 *                2 m, cuts through door wedges and breachable walls it sits on
 *  fire bottle   a pool of burning fuel (3.4 m, 7 s): flames, black smoke, heat
 *  cluster       a pop that scatters six bomblets; they go off one after another (Explosives)
 * Tactical
 *  sensor dart   a barbed dart: sticks in a wall or the ground and pings anything moving within
 *                16 m every 1.2 s for 30 s (red blips on the radar and in the world)
 *  glow stick    snapped and thrown: a coloured light that lasts 90 s (marks a room, lights a stair)
 *  gas           a CS canister: a yellow-green cloud (6 m, 14 s); inside you cough, your eyes
 *                stream, aim shakes, it hurts a little; bots in it break off and run
 *  door wedge    jammed under a closed door you are facing: nobody opens it — pushing only
 *                rattles it, until enough force (or a blast) breaks the wedge
 *  breaching     a linear charge slapped on a door or a wall: beeps, then blows the door in (wedge
 *                or not), shatters glass, stuns and blinds whoever is just behind it
 * Field upgrades ([H] when charged)
 *  trophy        (existing)
 *  ammo crate    deployed with both hands: the lid opens; teammates who come within 2.5 m get
 *                ammunition, a lethal, a tactical and a plate (once every 15 s each), 60 s
 *  medkit        heals teammates within 4.5 m quickly, its mast cross pulsing, 45 s
 *  spawn beacon  a tripod radio with a strobe in your colour: your team can deploy on it (the
 *                spawn picker), until it is shot (3 hits) or after 3 minutes
 *  radar pulse   a sweep out to 55 m: every enemy in range shows through walls for 4 s
 */

type G = any;

export type FieldId = 'trophy' | 'ammo' | 'medkit' | 'beacon' | 'radar';
export const FIELDS: { id: FieldId; name: string; desc: string; charge: number }[] = [
  { id: 'trophy', name: 'TROPHY SYSTEM', desc: 'Shoots down enemy grenades, C4 and throwing knives within 7.5 m. Three charges.', charge: 75 },
  { id: 'ammo', name: 'AMMO CRATE', desc: 'Teammates nearby get ammunition, a lethal, a tactical and a spare plate. Lasts 60 s.', charge: 70 },
  { id: 'medkit', name: 'MEDKIT STATION', desc: 'Heals teammates within 4.5 m quickly. Lasts 45 s.', charge: 80 },
  { id: 'beacon', name: 'SPAWN BEACON', desc: 'Your team can deploy on it. Three hits destroy it.', charge: 60 },
  { id: 'radar', name: 'RADAR PULSE', desc: 'A sweep out to 55 m: every enemy in range shows through walls for 4 s.', charge: 50 },
];

interface Fire { p: THREE.Vector3; r: number; t: number; life: number; owner: Combatant; key: string; anchor: Anchor | null; kind: 'fire' | 'thermite'; mesh?: THREE.Object3D; follow?: Combatant | null; off?: THREE.Vector3 }
interface Gas { p: THREE.Vector3; r: number; t: number; life: number; owner: Combatant; mesh: THREE.Object3D; key: string }
interface Station { kind: 'ammo' | 'medkit'; mesh: THREE.Group; p: THREE.Vector3; owner: Combatant; team: 0 | 1; t: number; life: number; cd: Map<Combatant, number>; deploy: number; anchor: Anchor | null; fx: number }
export interface Beacon { mesh: THREE.Group; p: THREE.Vector3; owner: Combatant; team: 0 | 1; t: number; life: number; hp: number; deploy: number; anchor: Anchor | null; collider: unknown }
interface Pulse { mesh: THREE.Mesh; t: number; p: THREE.Vector3; R: number }
interface Blip { mesh: THREE.Sprite; t: number }

const TEAM_GLOW: [number, number] = [0x40c0ff, 0xff5040];

export class Gear {
  fires: Fire[] = [];
  gases: Gas[] = [];
  stations: Station[] = [];
  beacons: Beacon[] = [];
  private pulses: Pulse[] = [];
  private blips: Blip[] = [];
  private glows = new Map<Grenade, Anchor>();
  private sensors = new Map<Grenade, number>();
  /** seconds of gas in your lungs (the screen and the cough) */
  gasT = 0;
  private coughT = 0;
  private pulseMat: THREE.ShaderMaterial | null = null;
  private blipMat: THREE.SpriteMaterial;

  constructor(private g: G) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255,90,80,1)');
    gr.addColorStop(0.3, 'rgba(255,60,50,0.7)');
    gr.addColorStop(1, 'rgba(255,40,30,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    x.strokeStyle = 'rgba(255,200,190,0.9)';
    x.lineWidth = 3;
    x.beginPath();
    x.arc(32, 32, 14, 0, Math.PI * 2);
    x.stroke();
    this.blipMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  private get pool() {
    return this.g.world.pool;
  }
  private light(p: THREE.Vector3, color: number, intensity: number, dist: number) {
    const a = this.pool.add(p.clone(), color, intensity, dist, false) as Anchor;
    this.pool.refresh();
    return a;
  }
  private unlight(a: Anchor | null) {
    if (a) this.pool.remove(a);
  }

  // ================================================================ fire / thermite
  /** a fire bottle burst (outside Sabotasje, which has its own) */
  fire(p: THREE.Vector3, owner: Combatant) {
    const g = this.g;
    const key = 'gfire' + Math.floor(Math.random() * 1e6);
    this.fires.push({ p: p.clone(), r: 0, t: 0, life: 7, owner, key, anchor: this.light(p.clone().setY(p.y + 0.6), 0xff8a3a, 26, 12), kind: 'fire' });
    g.audio.play(g.audio.has('glassShatter') ? 'glassShatter' : 'imp_glass', { pos: p, gain: 0.7, ref: 4 });
    g.audio.play('fireIgnite', { pos: p, gain: 1.0, ref: 6 });
    g.alertBots?.(p, 25, owner.team);
  }
  thermite(gr: Grenade) {
    const g = this.g;
    const key = 'therm' + gr.id;
    const st = gr.stuck;
    const f: Fire = {
      p: gr.pos.clone(), r: 1.9, t: 0, life: 5.2, owner: gr.owner, key, anchor: this.light(gr.pos, 0xffd2a0, 60, 11), kind: 'thermite', mesh: gr.mesh,
      follow: st?.to ?? null, off: st?.to ? st.off.clone() : undefined,
    };
    this.fires.push(f);
    g.audio.play('fireIgnite', { pos: gr.pos, gain: 1.0, ref: 5, rate: 1.4 });
    g.audio.play('heatHiss', { pos: gr.pos, gain: 0.9, ref: 5 });
    // it burns through the wedge of a door it is stuck near, and eats into breachable walls
    for (const d of g.doors.doors as Door[]) if (d.jammed && d.centre.distanceTo(gr.pos) < 1.6) this.wedgeBroken(d);
    g.destruction?.breachAt?.(gr.pos, 1.0, gr.owner);
  }
  private updateFires(dt: number) {
    const g = this.g;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      if (f.follow && f.follow.alive && f.off) f.p.copy(f.follow.position()).add(f.off);
      if (f.mesh) f.mesh.position.copy(f.p);
      if (f.kind === 'fire') f.r = 3.4 * Math.min(1, f.t / 0.6);
      const doused = g.explosives.smokes.some((c: { p: THREE.Vector3; r: number }) => c.r > 1 && c.p.distanceTo(f.p) < c.r + f.r * 0.6);
      if (doused && f.t > 0.2 && f.kind === 'fire') f.life = Math.min(f.life, f.t + 0.4);
      if (f.t >= f.life) {
        g.audio.stopEmitter(f.key);
        this.unlight(f.anchor);
        if (f.mesh) {
          // the spent canister: blackened, a wisp of smoke
          f.mesh.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
            if (m && m.color) {
              const mm = m.clone();
              mm.color.multiplyScalar(0.25);
              (o as THREE.Mesh).material = mm;
            }
          });
          const mesh = f.mesh;
          g.later?.(20, () => g.scene.remove(mesh));
        }
        g.audio.play('smokeHiss', { pos: f.p, gain: 0.5, ref: 4 });
        this.fires.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, (f.life - f.t) / 1.2);
      const near = f.p.distanceTo(g.camera.position) < 120;
      if (f.anchor) {
        f.anchor.p.copy(f.p).setY(f.p.y + (f.kind === 'thermite' ? 0.25 : 0.6));
        const fl = 0.75 + 0.25 * Math.sin(g.time * 31 + i) * Math.sin(g.time * 17.3);
        f.anchor.intensity = (f.kind === 'thermite' ? 60 : 26) * fade * fl;
      }
      if (near && f.kind === 'fire') {
        const n = Math.ceil(5 * fade);
        for (let k = 0; k < n; k++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * f.r;
          const pp = new THREE.Vector3(f.p.x + Math.cos(a) * r, f.p.y + 0.05, f.p.z + Math.sin(a) * r);
          g.fx.sparks.spawn(pp, new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.5), [4.6, 1.6 + Math.random() * 0.6, 0.35], 1, 0.28 + Math.random() * 0.25, 0.35 + Math.random() * 0.2, { drag: 1, grav: -2.2, grow: 1.6 });
        }
        if (Math.random() < 0.5) g.fx.smoke.spawn(f.p.clone().add(new THREE.Vector3((Math.random() - 0.5) * f.r, 1.2, (Math.random() - 0.5) * f.r)), new THREE.Vector3(0, 1.6, 0), [0.08, 0.075, 0.07], 0.55, 0.9, 4, { drag: 0.3, grav: -0.3, grow: 1.5 });
      } else if (near) {
        // thermite: a white-hot core spitting sparks in every direction, molten drips, a plume
        const core = 1 + 0.3 * Math.sin(g.time * 40);
        g.fx.sparks.spawn(f.p.clone(), new THREE.Vector3(), [9 * core, 7 * core, 4.5 * core], 1, 0.12 * fade, 0.06, { grow: 1 });
        for (let k = 0; k < Math.ceil(9 * fade); k++) {
          const v = new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 6.5 + 1, (Math.random() - 0.5) * 7);
          g.fx.sparks.spawn(f.p.clone(), v, [7, 3.6 + Math.random() * 1.5, 1.2], 1, 0.018 + Math.random() * 0.02, 0.4 + Math.random() * 0.6, { drag: 0.6, grav: 9.8 });
        }
        if (Math.random() < dt * 12) g.fx.sparks.spawn(f.p.clone(), new THREE.Vector3((Math.random() - 0.5) * 0.4, -0.5, (Math.random() - 0.5) * 0.4), [6, 2.6, 0.6], 1, 0.035, 1.2, { drag: 0.2, grav: 9.8 });
        if (Math.random() < 0.6) g.fx.smoke.spawn(f.p.clone().setY(f.p.y + 0.3), new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.9, (Math.random() - 0.5) * 0.4), [0.78, 0.76, 0.72], 0.45, 0.35, 3.2, { drag: 0.3, grav: -0.5, grow: 1.4 });
        // the glare blinds a little if you look straight at it
        if (f.p.distanceTo(g.camera.position) < 18) {
          const to = f.p.clone().sub(g.camera.position).normalize();
          const look = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion).dot(to);
          if (look > 0.9 && g.physics.lineOfSight(g.camera.position, f.p)) g.flashFx = Math.max(g.flashFx ?? 0, (look - 0.9) * 2.5 * fade);
        }
      }
      g.audio.emitter(f.key, f.kind === 'thermite' ? (g.audio.has('thermiteBurn') ? 'thermiteBurn' : 'heatHiss') : 'carFire', (f.kind === 'thermite' ? 1 : 0.8) * fade, f.p, { ref: 5, bus: 'sfx' });
      g.burnAt(f.p, f.r, f.kind === 'thermite' ? 70 : 38, f.owner, dt, (c: Combatant) => c.team !== f.owner.team || c === f.owner, f.kind === 'thermite' ? 2 : 1.6, f.kind === 'thermite' ? 'Thermite' : 'Fire Bottle');
      // deployables in the fire burn out
      if (f.kind === 'thermite') {
        for (const s of this.stations) if (s.p.distanceTo(f.p) < 1.5) s.life = Math.min(s.life, s.t + 0.3);
        for (const b of this.beacons) if (b.p.distanceTo(f.p) < 1.5) b.hp = 0;
      }
    }
  }

  // ================================================================ gas
  gas(gr: Grenade) {
    const g = this.g;
    this.gases.push({ p: gr.pos.clone(), r: 0, t: 0, life: 14, owner: gr.owner, mesh: gr.mesh, key: 'gas' + gr.id });
    g.audio.play('smokePop', { pos: gr.pos, gain: 0.9, ref: 6 });
  }
  private updateGas(dt: number) {
    const g = this.g;
    let inGas = 0;
    const me = g.avatar as Combatant;
    for (let i = this.gases.length - 1; i >= 0; i--) {
      const c = this.gases[i];
      c.t += dt;
      c.r = 6 * Math.min(1, c.t / 2.5) * (c.t > c.life - 3 ? Math.max(0, (c.life - c.t) / 3) : 1);
      if (c.t >= c.life) {
        g.scene.remove(c.mesh);
        g.audio.stopEmitter(c.key);
        this.gases.splice(i, 1);
        continue;
      }
      // a heavy yellow-green cloud hugging the ground, hissing out of the canister
      if (c.t < c.life - 3 && c.p.distanceTo(g.camera.position) < 140) {
        const n = c.t < 3 ? 4 : 2;
        for (let k = 0; k < n; k++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * c.r * 0.7;
          g.fx.smoke.spawn(new THREE.Vector3(c.p.x + Math.cos(a) * r, c.p.y + 0.3 + Math.random() * 0.8, c.p.z + Math.sin(a) * r), new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.15, (Math.random() - 0.5) * 0.4), [0.62, 0.64, 0.38], 0.42, 1.6 + Math.random(), 4.5, { drag: 0.6, grav: 0.02, grow: 0.8 });
        }
        if (Math.random() < 0.6) g.fx.smoke.spawn(c.p.clone().setY(c.p.y + 0.1), new THREE.Vector3((Math.random() - 0.5) * 2.5, 0.6, (Math.random() - 0.5) * 2.5), [0.75, 0.78, 0.4], 0.5, 0.25, 1.6, { drag: 1.5, grav: 0, grow: 2.2 });
      }
      g.audio.emitter(c.key, g.audio.has('gasHiss') ? 'gasHiss' : 'smokeHiss', 0.5 * Math.min(1, c.r / 3), c.p, { ref: 4, bus: 'sfx' });
      for (const v of g.match.players as Combatant[]) {
        if (!v.alive) continue;
        const d = Math.hypot(v.position().x - c.p.x, v.position().z - c.p.z);
        if (d > c.r || Math.abs(v.position().y - c.p.y) > 3) continue;
        const k = 1 - d / Math.max(0.1, c.r);
        if (v === me) inGas = Math.max(inGas, 0.4 + 0.6 * k);
        else if (v instanceof Bot && !v.netPuppet) {
          // bots choke: they can't aim, they get out
          v.suppression = Math.min(1, v.suppression + dt * 1.5);
          (v as unknown as { stunT: number }).stunT = Math.max((v as unknown as { stunT: number }).stunT, 0.4);
          if (Math.random() < dt * 0.4) g.botVoice(v, 'blind');
        }
      }
      g.burnAt(c.p, c.r, 4, c.owner, dt, (v: Combatant) => v.team !== c.owner.team || v === c.owner, 2.5, 'Gas');
    }
    // in the cloud: streaming eyes, coughing, a shake in the hands
    this.gasT = inGas > 0 ? Math.min(1, this.gasT + dt * 1.4 * inGas) : Math.max(0, this.gasT - dt * 0.35);
    if (this.gasT > 0.05) {
      g.rig?.addTrauma?.(dt * 0.6 * this.gasT);
      this.coughT -= dt;
      if (this.coughT <= 0 && inGas > 0) {
        this.coughT = 1.2 + Math.random() * 1.4;
        g.audio.play(g.audio.has('cough') ? 'cough' : 'breathOut', { gain: 0.7, reverb: 0.05, vary: 0.1 });
      }
    }
    g.ui.gasFx?.(this.gasT);
  }

  // ================================================================ glow sticks, sensor darts (per-frame on the grenade)
  tick(gr: Grenade, dt: number) {
    const g = this.g;
    if (gr.kind === 'glow') {
      let a = this.glows.get(gr);
      const col = gr.owner.team === g.avatar.team ? 0x60ff80 : 0xff6040;
      if (!a) {
        a = this.light(gr.pos, col, 9, 8);
        this.glows.set(gr, a);
        const set = gr.mesh.userData.setColor as ((c: THREE.Color, k: number) => void) | undefined;
        set?.(new THREE.Color(col), 2.6);
      }
      a.p.copy(gr.pos).setY(gr.pos.y + 0.12);
      // dims over its last 20 s
      a.intensity = 9 * Math.min(1, gr.fuse / 20);
    }
    if (gr.kind === 'sensor' && gr.resting) {
      let next = this.sensors.get(gr) ?? 0.4;
      next -= dt;
      const led = gr.mesh.getObjectByName('led');
      if (led) setLed(led, next < 0.12 ? 1 : 0.1);
      if (next <= 0) {
        next = 1.2;
        this.sensorScan(gr);
      }
      this.sensors.set(gr, next);
    }
  }
  gone(gr: Grenade) {
    const a = this.glows.get(gr);
    if (a) {
      this.unlight(a);
      this.glows.delete(gr);
    }
    this.sensors.delete(gr);
  }
  private sensorScan(gr: Grenade) {
    const g = this.g;
    const R = 16;
    let n = 0;
    for (const c of g.match.players as Combatant[]) {
      if (!c.alive || c.team === gr.owner.team || c.position().distanceTo(gr.pos) > R) continue;
      const v = (c as unknown as { velocity?: THREE.Vector3; pc?: { vel: THREE.Vector3 } });
      const vel = v.velocity ?? v.pc?.vel;
      const moving = vel ? Math.hypot(vel.x, vel.z) > 0.6 : true;
      if (!moving) continue;
      n++;
      if (gr.owner.team === g.avatar.team) {
        g.spotted?.set(c.id, Math.max(g.spotted.get(c.id) ?? 0, g.time + 1.6));
        this.blip(c.position().clone().setY(c.position().y + 1.0));
      }
      if (c === g.avatar) g.ui.notify('MOTION SENSOR', 'YOU WERE DETECTED');
      for (const m of g.bots as Bot[]) if (m.alive && m.team === gr.owner.team && m.position().distanceTo(gr.pos) < 60) m.hear(c.position());
    }
    if (gr.pos.distanceTo(g.camera.position) < 25) g.audio.play(g.audio.has('sensorPing') ? 'sensorPing' : 'click', { pos: gr.pos, gain: n ? 0.7 : 0.25, rate: n ? 1.15 : 0.9, ref: 3, reverb: 0 });
  }
  private blip(p: THREE.Vector3) {
    const s = new THREE.Sprite(this.blipMat.clone());
    s.position.copy(p);
    s.scale.setScalar(0.6);
    s.renderOrder = 10;
    this.g.scene.add(s);
    this.blips.push({ mesh: s, t: 0 });
  }

  // ================================================================ breaching charge, door wedge
  breach(gr: Grenade) {
    const g = this.g;
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(gr.mesh.quaternion);
    const p = gr.pos.clone();
    // doors within reach: blown in, whatever holds them
    for (const d of g.doors.doors as Door[]) {
      if (d.centre.distanceTo(p) > 1.9) continue;
      g.doors.blast(d, p.clone().addScaledVector(n, 1));
      g.audio.play('imp_wood', { pos: d.centre, gain: 1, rate: 0.6, ref: 6 });
    }
    // walls that can be breached
    g.destruction?.breachAt?.(p, 1.6, gr.owner);
    // the far side: whoever is right behind it is stunned and blinded
    const behind = p.clone().addScaledVector(n, -2.5);
    for (const c of g.match.players as Combatant[]) {
      if (!c.alive || c.team === gr.owner.team) continue;
      if (c.position().distanceTo(behind) > 4.5) continue;
      if (c === g.avatar) g.flashBang?.(p.clone().addScaledVector(n, -0.5), gr.owner);
      else if (c instanceof Bot) {
        (c as unknown as { blindT: number; stunT: number }).blindT = Math.max((c as unknown as { blindT: number }).blindT, 2.5);
        (c as unknown as { stunT: number }).stunT = Math.max((c as unknown as { stunT: number }).stunT, 3);
      }
    }
    for (let i = 0; i < 26; i++) {
      const v = n.clone().multiplyScalar(-4 - Math.random() * 6).add(new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6));
      g.fx.sparks.spawn(p.clone(), v, [5, 3, 1.2], 1, 0.025, 0.4 + Math.random() * 0.3, { drag: 1, grav: 9.8 });
    }
  }
  /** [T] with the wedge: jam the door you are facing */
  placeWedge(): boolean {
    const g = this.g;
    const d = g.doorFocusAny?.() as Door | null;
    if (!d || Math.abs(d.angle) > 0.08 || d.jammed) return false;
    const proto = EQUIP_BUILDERS.wedge();
    // on the floor at the leaf's free edge, on your side, pointing under the door
    const side = Math.sign(g.doors.side(d, g.player.pos)) || 1;
    const free = d.spec.hinge.clone().addScaledVector(d.spec.along, d.spec.width - 0.18);
    const at = free.clone().addScaledVector(d.normal, side * 0.06);
    at.y = d.spec.hinge.y + 0.005;
    proto.position.copy(at);
    proto.rotation.y = Math.atan2(-d.normal.x * side, -d.normal.z * side) + Math.PI / 2;
    g.scene.add(proto);
    g.doors.jam(d, proto);
    g.audio.play('imp_metal_light', { pos: at, gain: 0.8, rate: 0.7, ref: 3 });
    g.audio.play('imp_wood', { pos: at, gain: 0.5, rate: 1.3, ref: 3 });
    g.ui.notify('DOOR WEDGED', 'NOBODY OPENS IT NOW');
    return true;
  }
  wedgeBroken(d: Door) {
    const g = this.g;
    const at = d.wedge ? d.wedge.position.clone() : d.centre.clone();
    g.doors.unjam(d);
    for (let i = 0; i < 6; i++) g.fx.sparks.spawn(at, new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3), [3, 2.4, 1.6], 1, 0.015, 0.3, { drag: 1, grav: 9.8 });
    g.audio.play('imp_metal', { pos: at, gain: 0.8, ref: 4, rate: 1.2 });
  }

  // ================================================================ field upgrades
  deploy(kind: 'ammo' | 'medkit' | 'beacon', owner: Combatant, pos: THREE.Vector3, yaw: number) {
    const g = this.g;
    const mesh = EQUIP_BUILDERS[kind === 'ammo' ? 'ammoCrate' : kind]() as THREE.Group;
    mesh.position.copy(pos);
    mesh.rotation.y = yaw;
    mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    g.scene.add(mesh);
    const team = owner.team;
    if (kind === 'beacon') {
      const b: Beacon = { mesh, p: pos.clone(), owner, team, t: 0, life: 180, hp: 3, deploy: 0, anchor: null, collider: null };
      this.beacons = this.beacons.filter((x) => {
        if (x.owner === owner) this.removeBeacon(x, false);
        return x.owner !== owner;
      });
      this.beacons.push(b);
      (mesh.userData.setColor as (c: THREE.Color, k: number) => void)(new THREE.Color(TEAM_GLOW[team === g.avatar.team ? 0 : 1]), 0.2);
      g.audio.play(g.audio.has('beaconOn') ? 'beaconOn' : 'trophyOut', { pos, gain: 0.7, ref: 4 });
      if (owner === g.avatar) g.ui.notify('SPAWN BEACON', 'YOUR TEAM CAN DEPLOY HERE');
      return;
    }
    const s: Station = { kind, mesh, p: pos.clone(), owner, team, t: 0, life: kind === 'ammo' ? 60 : 45, cd: new Map(), deploy: 0, anchor: kind === 'medkit' ? this.light(pos.clone().setY(pos.y + 0.6), 0x50ff90, 4, 5) : null, fx: 0 };
    this.stations.push(s);
    while (this.stations.filter((x) => x.owner === owner).length > 1) {
      const old = this.stations.find((x) => x.owner === owner)!;
      this.removeStation(old);
    }
    g.audio.play(g.audio.has('crateOpen') ? 'crateOpen' : 'imp_metal_light', { pos, gain: 0.8, rate: kind === 'medkit' ? 1.1 : 1, ref: 4 });
    if (owner === g.avatar) g.ui.notify(kind === 'ammo' ? 'AMMO CRATE' : 'MEDKIT STATION', 'DEPLOYED');
  }
  private removeStation(s: Station) {
    this.g.scene.remove(s.mesh);
    this.unlight(s.anchor);
    this.stations = this.stations.filter((x) => x !== s);
  }
  private removeBeacon(b: Beacon, destroyed: boolean) {
    const g = this.g;
    g.scene.remove(b.mesh);
    this.unlight(b.anchor);
    if (destroyed) {
      g.fx.explosion?.(b.p.clone(), new THREE.Vector3(0, 1, 0), 0.25, 'concrete');
      g.audio.play('imp_metal', { pos: b.p, gain: 1, ref: 5 });
      if (b.team === g.avatar.team) g.ui.notify('SPAWN BEACON DESTROYED', '');
    }
  }
  /** a bullet / blast near a beacon (the game routes world hits here) */
  hitBeacon(p: THREE.Vector3, by: Combatant | null) {
    for (const b of this.beacons) {
      if (b.p.distanceTo(p) > 0.4 || (by && by.team === b.team)) continue;
      b.hp--;
      this.g.fx.sparks.spawn(p.clone(), new THREE.Vector3(0, 2, 0), [4, 3, 1], 1, 0.02, 0.3, { drag: 1, grav: 9.8 });
      return true;
    }
    return false;
  }
  /** blasts take beacons and stations out */
  blast(p: THREE.Vector3, r: number) {
    for (const b of this.beacons) if (b.p.distanceTo(p) < r * 0.6) b.hp = 0;
    for (const s of this.stations) if (s.p.distanceTo(p) < r * 0.45) s.life = Math.min(s.life, s.t);
  }

  radarPulse(owner: Combatant, p: THREE.Vector3, R = 55) {
    const g = this.g;
    g.audio.play(g.audio.has('radarSweep') ? 'radarSweep' : 'snapPulse', { pos: p, gain: 1, ref: 12, reverb: 0.4 });
    if (!this.pulseMat) {
      this.pulseMat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uCol: { value: new THREE.Color(0.3, 1.3, 1.0) } },
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform float uT; uniform vec3 uCol; varying vec3 vW;
          void main(){ float h = clamp(1.0 - abs(vW.y - (cameraPosition.y - 1.4)) * 0.08, 0.0, 1.0);
            float band = 0.5 + 0.5*sin(vW.y * 6.0 - uT * 30.0);
            float a = (0.25 + 0.5*band) * h * (1.0 - uT) * (1.0 - uT);
            gl_FragColor = vec4(uCol * a, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
    }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 6, 64, 1, true), this.pulseMat.clone());
    mesh.position.copy(p).setY(p.y + 1);
    mesh.frustumCulled = false;
    g.scene.add(mesh);
    this.pulses.push({ mesh, t: 0, p: p.clone(), R });
    let n = 0;
    for (const c of g.match.players as Combatant[]) {
      if (!c.alive || c.team === owner.team || c.position().distanceTo(p) > R) continue;
      g.revealed.set(c.id, g.time + 4);
      n++;
      if (owner.team === g.avatar.team) g.spotted?.set(c.id, Math.max(g.spotted.get(c.id) ?? 0, g.time + 4));
      if (c === g.avatar) g.ui.announce('REVEALED', 'ENEMY RADAR PULSE', 'bad');
    }
    if (owner === g.avatar) g.ui.notify('RADAR PULSE', n ? `${n} ENEMIES IN RANGE` : 'NO ENEMIES IN RANGE');
  }

  // ================================================================ the frame
  update(dt: number) {
    const g = this.g;
    this.updateFires(dt);
    this.updateGas(dt);
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pl = this.pulses[i];
      pl.t += dt / 1.4;
      const r = pl.R * (1 - Math.pow(1 - Math.min(1, pl.t), 2.2));
      pl.mesh.scale.set(r, 1, r);
      (pl.mesh.material as THREE.ShaderMaterial).uniforms.uT.value = Math.min(1, pl.t);
      if (pl.t >= 1) {
        g.scene.remove(pl.mesh);
        pl.mesh.geometry.dispose();
        (pl.mesh.material as THREE.Material).dispose();
        this.pulses.splice(i, 1);
      }
    }
    for (let i = this.blips.length - 1; i >= 0; i--) {
      const b = this.blips[i];
      b.t += dt;
      const m = b.mesh.material as THREE.SpriteMaterial;
      m.opacity = Math.max(0, 1 - b.t / 1.2);
      b.mesh.scale.setScalar(0.35 + b.t * 0.9);
      if (b.t > 1.2) {
        g.scene.remove(b.mesh);
        m.dispose();
        this.blips.splice(i, 1);
      }
    }
    // stations: open the lid, then serve teammates
    for (const s of [...this.stations]) {
      s.t += dt;
      s.deploy = Math.min(1, s.deploy + dt * 1.6);
      (s.mesh.userData.setLid as (k: number) => void)(easeBack(Math.min(1, s.deploy * 1.3)));
      const led = s.mesh.getObjectByName('led');
      if (led) setLed(led, Math.sin(g.time * 3) > 0 ? 1 : 0.2);
      if (s.kind === 'medkit') {
        const lamp = s.mesh.getObjectByName('lamp');
        const k = 0.4 + 0.6 * Math.max(0, Math.sin(g.time * 3.4));
        if (lamp) ((lamp.userData.mat as THREE.MeshBasicMaterial).color as THREE.Color).setRGB(0.3, 1.0, 0.5).multiplyScalar(0.5 + 3.5 * k);
        if (s.anchor) s.anchor.intensity = 3 + 3 * k;
      }
      if (s.t > s.life) {
        this.removeStation(s);
        continue;
      }
      this.serve(s, dt);
    }
    // beacons: legs out, the strobe in your colour; shot / burnt / expired → gone
    for (const b of [...this.beacons]) {
      b.t += dt;
      b.deploy = Math.min(1, b.deploy + dt * 2.2);
      (b.mesh.userData.setLegs as (k: number) => void)(easeBack(b.deploy));
      const head = b.mesh.getObjectByName('head');
      if (head) head.rotation.y += dt * 5;
      const strobe = Math.pow(Math.max(0, Math.sin(g.time * 7 + b.p.x)), 12);
      (b.mesh.userData.setColor as (c: THREE.Color, k: number) => void)(new THREE.Color(TEAM_GLOW[b.team === g.avatar.team ? 0 : 1]), 0.15 + strobe);
      if (b.hp <= 0 || b.t > b.life) {
        this.removeBeacon(b, b.hp <= 0);
        this.beacons = this.beacons.filter((x) => x !== b);
      }
    }
  }

  /** ammo crate / medkit: what teammates nearby get */
  private serve(s: Station, dt: number) {
    const g = this.g;
    const R = s.kind === 'ammo' ? 2.6 : 4.5;
    for (const c of g.match.players as Combatant[]) {
      if (!c.alive || c.downed || c.team !== s.team || c.position().distanceTo(s.p) > R) continue;
      if (s.kind === 'medkit') {
        if (c.health < 100) {
          c.health = Math.min(100, c.health + 22 * dt);
          s.fx += dt;
          if (s.fx > 0.25) {
            s.fx = 0;
            const p = c.position().clone().setY(c.position().y + 0.6 + Math.random() * 0.9);
            g.fx.sparks.spawn(p.add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5)), new THREE.Vector3(0, 0.8, 0), [0.6, 2.6, 1.0], 1, 0.06, 0.8, { drag: 0.5, grav: -0.4, grow: 0.5 });
          }
        }
        continue;
      }
      const next = s.cd.get(c) ?? 0;
      if (g.time < next) continue;
      s.cd.set(c, g.time + 15);
      if (c === g.avatar) g.resupplyAtCrate?.();
      else if (c instanceof Bot) {
        c.mag = c.def.mag;
        c.spare = Math.min(3, (c.spare ?? 0) + 1);
        (c as unknown as { frags: number }).frags = Math.max(1, (c as unknown as { frags: number }).frags);
      }
      g.audio.play('cloth', { pos: s.p, gain: 0.4, ref: 3 });
      if (s.owner === g.avatar && c !== g.avatar) {
        g.avatar.score += 20;
        g.ui.killText?.(20, ['RESUPPLY']);
      }
    }
  }

  /** where the team can deploy (the spawn picker) */
  beaconsFor(team: 0 | 1) {
    return this.beacons.filter((b) => b.team === team && b.deploy >= 1 && b.hp > 0);
  }

  clear() {
    const g = this.g;
    for (const f of this.fires) {
      g.audio.stopEmitter(f.key);
      this.unlight(f.anchor);
      if (f.mesh) g.scene.remove(f.mesh);
    }
    this.fires = [];
    for (const c of this.gases) {
      g.scene.remove(c.mesh);
      g.audio.stopEmitter(c.key);
    }
    this.gases = [];
    for (const s of [...this.stations]) this.removeStation(s);
    for (const b of this.beacons) this.removeBeacon(b, false);
    this.beacons = [];
    for (const a of this.glows.values()) this.unlight(a);
    this.glows.clear();
    this.sensors.clear();
    this.gasT = 0;
    g.ui.gasFx?.(0);
    void PLATE_HP;
  }
}

function easeBack(t: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
