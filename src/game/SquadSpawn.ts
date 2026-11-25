import * as THREE from 'three';
import { Bot } from '../ai/Bot';
import { Combatant } from './Combatant';

/**
 * Squad spawning (Update 47). When you are down and out, the death screen lets you choose where
 * to come back (Q / E or click):
 *  - BASE            your side's spawn (the usual safe pick)
 *  - a squadmate     dropped in just behind them, facing where they face — not while they are
 *                    fighting (hit in the last 4 s or an enemy in their sights) or down
 *  - RALLY POINT     a radio pack and a pennant you planted with the squad orders wheel ([Y] →
 *                    RALLY POINT); it lasts 2 minutes and is overrun if enemies stand on it
 *  - SPAWN BEACON    any beacon your team has out (the field upgrade)
 * Bots use rally points and beacons too.
 */

type G = any;

export interface SpawnOpt { kind: 'base' | 'squad' | 'rally' | 'beacon'; label: string; sub: string; pos: THREE.Vector3 | null; yaw: number; ok: boolean; why?: string; key: string }

interface Rally { mesh: THREE.Group; p: THREE.Vector3; t: number; life: number; team: 0 | 1; over: number; flag: THREE.Mesh }

export class SquadSpawn {
  rally: Rally | null = null;
  private selKey = 'base';
  private opts: SpawnOpt[] = [];

  constructor(private g: G) {}

  get enabled() {
    return !this.g.sab;
  }

  /** what you can pick right now */
  options(): SpawnOpt[] {
    const g = this.g;
    const team = g.avatar.team as 0 | 1;
    const out: SpawnOpt[] = [{ kind: 'base', label: 'BASE', sub: 'TEAM SPAWN', pos: null, yaw: 0, ok: true, key: 'base' }];
    if (!this.enabled) return out;
    const me = g.avatar.position() as THREE.Vector3;
    for (const b of g.mySquad() as Bot[]) {
      const ok = b.alive && !b.downed && !b.inCombat;
      const why = !b.alive ? 'K.I.A.' : b.downed ? 'DOWN' : b.inCombat ? 'IN COMBAT' : '';
      const f = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw));
      out.push({ kind: 'squad', label: b.name.toUpperCase(), sub: ok ? `${Math.round(b.position().distanceTo(me))} M` : why, pos: b.alive ? b.position().clone().addScaledVector(f, -1.4) : null, yaw: b.yaw, ok, why, key: 'sq' + b.id });
    }
    if (this.rally && this.rally.team === team) {
      const r = this.rally;
      const ok = r.over < 0.5;
      out.push({ kind: 'rally', label: 'RALLY POINT', sub: ok ? `${Math.ceil(r.life - r.t)} S LEFT` : 'CONTESTED', pos: r.p.clone(), yaw: 0, ok, key: 'rally' });
    }
    g.gear.beaconsFor(team).forEach((bc: { p: THREE.Vector3; owner: Combatant; hp: number }, i: number) => {
      out.push({ kind: 'beacon', label: 'SPAWN BEACON', sub: bc.owner === g.avatar ? 'YOURS' : bc.owner.name.toUpperCase(), pos: bc.p.clone(), yaw: 0, ok: bc.hp > 0, key: 'bc' + i });
    });
    return out;
  }

  /** the death screen: cycle with Q / E (or the wheel), the panel shows the choice */
  updateDead() {
    const g = this.g;
    this.opts = this.options();
    let i = this.opts.findIndex((o) => o.key === this.selKey);
    if (i < 0 || !this.opts[i].ok) i = 0;
    const step = (g.input.wasPressed('leanR') ? 1 : 0) - (g.input.wasPressed('leanL') ? 1 : 0);
    if (step) {
      for (let k = 1; k <= this.opts.length; k++) {
        const j = (i + step * k + this.opts.length * 4) % this.opts.length;
        if (this.opts[j].ok) {
          i = j;
          break;
        }
      }
      g.audio.play('uiHover', { gain: 0.5, bus: 'ui', reverb: 0 });
    }
    this.selKey = this.opts[i]?.key ?? 'base';
    g.ui.spawnPicker?.(this.opts, i, (k: number) => {
      if (this.opts[k]?.ok) this.selKey = this.opts[k].key;
    });
  }
  hide() {
    this.g.ui.spawnPicker?.(null, 0);
  }

  /** where to put you on respawn (null: the normal spawn) */
  resolve(): { pos: THREE.Vector3; yaw: number; label: string } | null {
    const g = this.g;
    if (!this.enabled || g.match.initialSpawns) return null;
    const o = this.options().find((x) => x.key === this.selKey);
    if (!o || !o.ok || !o.pos || o.kind === 'base') return null;
    const p = this.safeSpot(o.pos);
    if (!p) return null;
    return { pos: p, yaw: o.kind === 'squad' ? o.yaw : g.player.yaw, label: o.kind === 'squad' ? `ON ${o.label}` : o.label };
  }
  /** a point on the nav mesh by p, clear of walls */
  private safeSpot(p: THREE.Vector3) {
    const g = this.g;
    const n = g.nav.nearest(p, 5, false);
    const q = n ? n.p.clone() : p.clone();
    if (q.distanceTo(p) > 5) return null;
    q.y += 0.05;
    return q;
  }

  // ---------------------------------------------------------------- rally points
  placeRally() {
    const g = this.g;
    const at = g.groundAhead(0.8) as THREE.Vector3;
    if (this.rally) g.scene.remove(this.rally.mesh);
    const team = g.avatar.team as 0 | 1;
    const mesh = new THREE.Group();
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.2), new THREE.MeshStandardMaterial({ color: 0x3f4430, roughness: 0.9 }));
    pack.position.y = 0.21;
    pack.rotation.x = -0.15;
    mesh.add(pack);
    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.07), new THREE.MeshStandardMaterial({ color: 0x1d1f1c, roughness: 0.6 }));
    radio.position.set(0.1, 0.46, 0.04);
    mesh.add(radio);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 1.7, 6), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.4 }));
    pole.position.set(-0.12, 0.85, 0);
    mesh.add(pole);
    const fg = new THREE.PlaneGeometry(0.5, 0.3, 8, 2);
    fg.translate(0.25, 0, 0);
    const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: team === 0 ? 0x2f7fd8 : 0xd83a3a, roughness: 0.85, side: THREE.DoubleSide, emissive: new THREE.Color(team === 0 ? 0x0a2a50 : 0x501010) }));
    flag.position.set(-0.12, 1.5, 0);
    mesh.add(flag);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.5, 1.2) }));
    lamp.position.set(0.13, 0.58, 0.04);
    lamp.name = 'lamp';
    mesh.add(lamp);
    mesh.position.copy(at);
    mesh.rotation.y = g.player.yaw;
    mesh.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = true) : 0));
    g.scene.add(mesh);
    this.rally = { mesh, p: at.clone(), t: 0, life: 120, team, over: 0, flag };
    g.ui.notify('RALLY POINT', 'YOUR SQUAD CAN DEPLOY HERE');
    g.audio.play('radio', { gain: 0.3, bus: 'ui', reverb: 0, rate: 1.1 });
    g.audio.play('cloth', { gain: 0.5, reverb: 0 });
  }

  update(dt: number) {
    const g = this.g;
    const r = this.rally;
    if (!r) return;
    r.t += dt;
    // the pennant flutters
    const pos = (r.flag.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, Math.sin(g.time * 7 + x * 9) * 0.04 * x * 2);
    }
    pos.needsUpdate = true;
    const lamp = r.mesh.getObjectByName('lamp') as THREE.Mesh | undefined;
    if (lamp) lamp.visible = Math.sin(g.time * 4) > 0;
    // enemies standing on it overrun it
    let foes = 0;
    for (const c of g.match.players as Combatant[]) if (c.alive && !c.downed && c.team !== r.team && c.position().distanceTo(r.p) < 10) foes++;
    r.over = foes ? Math.min(3, r.over + dt) : Math.max(0, r.over - dt);
    if (r.t > r.life || r.over >= 3) {
      if (r.over >= 3 && r.team === g.avatar.team) g.ui.notify('RALLY POINT OVERRUN', '');
      g.scene.remove(r.mesh);
      this.rally = null;
    }
  }

  /** bots: sometimes come back on a rally point or a beacon */
  botSpawn(b: Bot): { pos: THREE.Vector3; yaw: number } | null {
    const g = this.g;
    if (!this.enabled) return null;
    const opts: THREE.Vector3[] = [];
    if (this.rally && this.rally.team === b.team && this.rally.over < 0.5 && (g.mySquad() as Bot[]).includes(b)) opts.push(this.rally.p);
    for (const bc of g.gear.beaconsFor(b.team)) opts.push(bc.p);
    if (!opts.length || Math.random() > 0.4) return null;
    const p = this.safeSpot(opts[Math.floor(Math.random() * opts.length)]);
    return p ? { pos: p, yaw: Math.random() * Math.PI * 2 } : null;
  }

  clear() {
    if (this.rally) this.g.scene.remove(this.rally.mesh);
    this.rally = null;
    this.selKey = 'base';
  }
}
