import * as THREE from 'three';
import { Bot } from '../ai/Bot';
import { WEAPONS } from '../weapons/WeaponDefs';
import { WEAPON_BUILDERS, WeaponId } from '../weapons/WeaponModels';
import { bakeFlat } from '../render/Batch';

/**
 * Scavenging (Update 47): the fallen leave their guns. A soldier's rifle clatters to the ground
 * where they drop (thrown along the hit, tumbling, bouncing once or twice) and lies there with a
 * faint glint for 45 s, blinking out at the end.
 *
 *  - walk over a gun that takes the same ammunition as one you carry: you strip its magazines
 *    (+AMMO); the gun stays for someone else
 *  - hold [F] by a gun: swap it for the one in that slot (yours is dropped in its place, with
 *    the ammo it has left) — every gun keeps its own magazine and reserve
 *
 * Supply pouches (Pickups) still drop as well: health, a magazine for each gun, grenades.
 */

type G = any;

interface Dropped {
  id: WeaponId;
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rest: boolean;
  bounces: number;
  mag: number;
  reserve: number;
  t: number;
  life: number;
  stripped: boolean;
  glint: THREE.Sprite;
}

/** calibre families: guns in one family share ammunition */
const AMMO: Partial<Record<WeaponId, string>> = {
  k416: '556', ks17: '556', lmg: '556', hval47: '762x39', stille9: '9', mp18: '9', p80: '9', ums45: '45', mp7: '46', pump12: '12', as20: '12', db12: '12',
  skv338: '338', dmr14: '762', kr98: '792', rv357: '357',
};

export class Scavenge {
  guns: Dropped[] = [];
  private glintMat: THREE.SpriteMaterial;
  private focusGun: Dropped | null = null;
  private holdT = 0;

  constructor(private g: G) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,250,230,1)');
    gr.addColorStop(0.15, 'rgba(255,240,200,0.55)');
    gr.addColorStop(1, 'rgba(255,240,200,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    // a four-point star
    x.strokeStyle = 'rgba(255,250,235,0.8)';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(32, 4);
    x.lineTo(32, 60);
    x.moveTo(4, 32);
    x.lineTo(60, 32);
    x.stroke();
    const t = new THREE.CanvasTexture(c);
    this.glintMat = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.0 });
  }

  get enabled() {
    return !this.g.sab;
  }

  /** a soldier fell: their gun hits the ground */
  dropFrom(b: Bot, dir: THREE.Vector3) {
    if (!this.enabled || b.def.cls === 'Melee') return;
    const g = this.g;
    if (b.position().distanceTo(g.camera.position) > 140) return;
    const hand = new THREE.Vector3();
    b.weapon.root.getWorldPosition(hand);
    if (!Number.isFinite(hand.x)) hand.copy(b.position()).setY(b.position().y + 1.1);
    const vel = dir.clone().setY(0).normalize().multiplyScalar(1.2 + Math.random() * 1.4).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 1.6 + Math.random() * 1.2, (Math.random() - 0.5) * 1.2)).add(b.velocity.clone().multiplyScalar(0.5));
    // the soldier's own gun goes with the ragdoll's hand out of sight: the world copy takes over
    b.weapon.root.visible = false;
    this.spawn(b.def.id as WeaponId, hand, vel, b.def.mag, Math.round(b.def.mag * (1.5 + Math.random() * 1.5)));
  }

  private spawn(id: WeaponId, at: THREE.Vector3, vel: THREE.Vector3, mag: number, reserve: number) {
    const g = this.g;
    const model = WEAPON_BUILDERS[id](g.wmats);
    bakeFlat(model.root, 'botgun', 'botgun:' + id);
    const holder = new THREE.Group();
    holder.add(model.root);
    holder.position.copy(at);
    holder.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    holder.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    const glint = new THREE.Sprite(this.glintMat.clone());
    glint.scale.setScalar(0.16);
    glint.renderOrder = 5;
    holder.add(glint);
    g.scene.add(holder);
    this.guns.push({ id, mesh: holder, pos: at.clone(), vel: vel.clone(), spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 14), rest: false, bounces: 0, mag, reserve, t: 0, life: 45, stripped: false, glint });
    while (this.guns.length > 16) this.remove(this.guns[0]);
  }

  private remove(d: Dropped) {
    this.g.scene.remove(d.mesh);
    (d.glint.material as THREE.Material).dispose();
    this.guns = this.guns.filter((x) => x !== d);
    if (this.focusGun === d) this.focusGun = null;
  }

  clear() {
    for (const d of [...this.guns]) this.remove(d);
  }

  update(dt: number) {
    const g = this.g;
    if (!this.enabled) {
      if (this.guns.length) this.clear();
      return;
    }
    const cam = g.camera.position as THREE.Vector3;
    for (const d of [...this.guns]) {
      d.t += dt;
      if (d.t > d.life) {
        this.remove(d);
        continue;
      }
      if (!d.rest) this.integrate(d, dt);
      // a glint that catches your eye from a distance; blinking out at the end
      const dist = d.pos.distanceTo(cam);
      const tw = Math.max(0, Math.sin(g.time * 2.2 + d.pos.x * 3.1)) ** 8;
      const fade = d.t > d.life - 5 ? (Math.sin(d.t * 14) > 0 ? 1 : 0.2) : 1;
      const m = d.glint.material as THREE.SpriteMaterial;
      m.opacity = (d.rest ? 1 : 0) * (dist < 30 ? 0.25 + 0.75 * tw : 0) * fade * (d.stripped ? 0.4 : 1);
      d.mesh.visible = fade > 0.5 || d.t < d.life - 5;
    }
    this.player(dt);
  }

  private integrate(d: Dropped, dt: number) {
    const g = this.g;
    d.vel.y -= 9.8 * dt;
    const step = d.vel.clone().multiplyScalar(dt);
    const len = step.length();
    const hit = len > 1e-5 ? g.physics.raycast(d.pos, step.clone().divideScalar(len), len + 0.06) : null;
    if (hit) {
      d.pos.copy(hit.point).addScaledVector(hit.normal, 0.04);
      const speed = d.vel.length();
      if (speed > 1.2) g.audio.play(d.bounces ? 'bounce_metal' : 'imp_metal_light', { pos: d.pos, gain: Math.min(0.7, 0.2 + speed * 0.1), ref: 3, rate: 0.7 + Math.random() * 0.2, vary: 0.08 });
      d.vel.reflect(hit.normal).multiplyScalar(0.28);
      d.spin.multiplyScalar(0.4);
      d.bounces++;
      if (hit.normal.y > 0.6 && (d.vel.length() < 1.1 || d.bounces > 3)) {
        d.rest = true;
        // settle on its side, along the ground
        const yaw = Math.atan2(d.vel.x, d.vel.z) + Math.random() * 0.8;
        d.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.normal).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, Math.PI / 2)));
        d.pos.copy(hit.point).addScaledVector(hit.normal, 0.03);
        g.fx.dust?.spawn?.(d.pos.clone(), new THREE.Vector3(0, 0.4, 0), [0.5, 0.48, 0.44], 0.25, 0.25, 0.8, { drag: 2, grav: -0.1, grow: 1.2 });
      }
    } else d.pos.add(step);
    if (!d.rest) {
      const w = d.spin.length();
      if (w > 1e-3) d.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(d.spin.clone().divideScalar(w), w * dt));
    }
    d.mesh.position.copy(d.pos);
    if (d.pos.y < -6) d.t = d.life;
  }

  // ---------------------------------------------------------------- the player
  private slotFor(id: WeaponId) {
    return WEAPONS[id].slot === 'primary' ? 0 : 1;
  }
  private player(dt: number) {
    const g = this.g;
    const a = g.avatar;
    this.focusGun = null;
    if (!a.alive || a.downed || g.field?.handsBusy) return;
    const me = g.player.pos as THREE.Vector3;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    let best: Dropped | null = null;
    let bs = -9;
    for (const d of this.guns) {
      if (!d.rest) continue;
      const to = d.pos.clone().sub(g.camera.position);
      const hd = Math.hypot(d.pos.x - me.x, d.pos.z - me.z);
      if (hd > 2.3 || Math.abs(d.pos.y - me.y) > 1.6) continue;
      // walked over one that takes your ammo: strip its magazines
      if (hd < 1.1 && !d.stripped) this.strip(d);
      const dot = to.normalize().dot(fwd);
      const sc = dot - hd * 0.25;
      if (sc > bs && (dot > 0.55 || hd < 1.0)) {
        bs = sc;
        best = d;
      }
    }
    this.focusGun = best;
    if (!best) {
      this.holdT = 0;
      return;
    }
    // hold [F]: swap
    if (g.input.isDown('spot')) {
      this.holdT += dt;
      g.ui.actionRing(Math.min(1, this.holdT / 0.4), `TAKE ${WEAPONS[best.id].short}`, 'take');
      if (this.holdT >= 0.4) {
        this.take(best);
        this.holdT = -9;
        g.ui.actionRing(null);
      }
    } else {
      if (this.holdT > 0) g.ui.actionRing(null);
      this.holdT = 0;
    }
  }
  hint(): string {
    const d = this.focusGun;
    if (!d) return '';
    const mine = this.g.weapons.slots[this.slotFor(d.id)];
    if (mine && mine.def.id === d.id) return d.stripped ? '' : '';
    return `HOLD [F] TAKE ${WEAPONS[d.id].short}  ·  ${d.mag + d.reserve} RDS`;
  }
  usesF() {
    const d = this.focusGun;
    if (!d) return false;
    const mine = this.g.weapons.slots[this.slotFor(d.id)];
    return !(mine && mine.def.id === d.id);
  }

  /** take the ammunition out of a dropped gun that shares a calibre with yours */
  private strip(d: Dropped) {
    const g = this.g;
    const fam = AMMO[d.id];
    let got = 0;
    for (const sl of g.weapons.slots) {
      if (!fam || AMMO[sl.def.id as WeaponId] !== fam) continue;
      const cap = sl.def.reserve * 1.5;
      const room = Math.max(0, cap - sl.reserve);
      const take = Math.min(room, d.mag + d.reserve);
      if (take <= 0) continue;
      sl.reserve += take;
      got += take;
      const fromMag = Math.min(d.mag, take);
      d.mag -= fromMag;
      d.reserve -= take - fromMag;
    }
    if (got > 0) {
      d.stripped = true;
      g.ui.killText?.(0, [`+${got} ROUNDS · ${WEAPONS[d.id].short}`]);
      g.audio.play(g.audio.has(`magIn@${g.weapons.cur.def.id}`) ? `magIn@${g.weapons.cur.def.id}` : 'click', { gain: 0.35, rate: 1.1, reverb: 0 });
      g.audio.play('cloth', { gain: 0.35, reverb: 0 });
    }
  }

  private take(d: Dropped) {
    const g = this.g;
    const i = this.slotFor(d.id);
    const old = g.weapons.slots[i];
    if (!old) return;
    // yours goes down where the new one was, with what it has left
    if (old.def.cls !== 'Melee') {
      const f = new THREE.Vector3(-Math.sin(g.player.yaw), 0.3, -Math.cos(g.player.yaw));
      this.spawn(old.def.id, g.camera.position.clone().addScaledVector(f, 0.5), f.clone().multiplyScalar(2.2), old.mag, old.reserve);
      const nd = this.guns[this.guns.length - 1];
      nd.t = 0.5;
    }
    g.weapons.replaceSlot(i, d.id, d.mag, d.reserve);
    this.remove(d);
    g.audio.play('cloth', { gain: 0.6, reverb: 0 });
    g.audio.play(g.audio.has(`boltBack@${d.id}`) ? `boltBack@${d.id}` : 'click', { gain: 0.5, reverb: 0 });
    g.ui.notify(WEAPONS[d.id].name.toUpperCase(), 'PICKED UP');
  }
}
