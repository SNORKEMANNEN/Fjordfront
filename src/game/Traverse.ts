import * as THREE from 'three';
import { makeHook } from '../weapons/FieldModels';

/**
 * Update 47 — getting up and down the map.
 *
 *  Ledge hang      jump at a ledge too high to mantle and you catch it: hands over the edge,
 *                  A / D shimmy along, W / Space pull up, S / C let go (PlayerController.climb)
 *  Rappel          stand at a drop of 4 m or more (a roof edge, a cliff, a quay wall) facing out:
 *                  [F] RAPPEL — an anchor goes in, you go over backwards on a rope. S down
 *                  (Shift: fast), W up, A / D along the wall, Space kicks off and drops you a
 *                  few metres in one swing, C lets go
 *  Grappling hook  [P]: a launcher on the left arm fires a three-pronged hook (32 m) at what you
 *                  aim at; it bites, the line goes taut and reels you in fast — onto the ledge
 *                  above if there is one (you arrive hanging), else up against the wall. 8 s
 *                  to rewind
 *  Blind fire      hold [Alt]: the gun goes up over the cover (or round the corner you lean at)
 *                  and fires blind: shots leave from the gun, wildly spread, your head stays down
 */

type G = any;

export class Traverse {
  private ropeMesh: THREE.Mesh;
  private ropeMat: THREE.MeshStandardMaterial;
  private anchorMesh: THREE.Mesh;
  private hook: THREE.Group;
  /** the hook in flight / bitten: from → to */
  private shot: { from: THREE.Vector3; to: THREE.Vector3; n: THREE.Vector3; top: number; t: number; dur: number; hit: boolean; back: number } | null = null;
  private grappleCd = 0;
  private rappelAt: { anchor: THREE.Vector3; n: THREE.Vector3; ground: number } | null = null;
  private scanT = 0;
  private lastClimb: string | null = null;
  private slideK = 0;
  private zipT = 0;

  constructor(private g: G) {
    this.ropeMat = new THREE.MeshStandardMaterial({ color: 0x3a3a30, roughness: 0.95, metalness: 0 });
    const geo = new THREE.CylinderGeometry(0.009, 0.009, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    this.ropeMesh = new THREE.Mesh(geo, this.ropeMat);
    this.ropeMesh.visible = false;
    this.ropeMesh.frustumCulled = false;
    g.scene.add(this.ropeMesh);
    this.anchorMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.12), new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.4, metalness: 0.8 }));
    this.anchorMesh.visible = false;
    g.scene.add(this.anchorMesh);
    this.hook = makeHook();
    this.hook.scale.setScalar(1.4);
    this.hook.visible = false;
    g.scene.add(this.hook);
    // climbing events: sounds and the hands
    g.player.onClimb = (ev: string, p?: THREE.Vector3) => this.onClimb(ev, p);
  }

  private onClimb(ev: string, p?: THREE.Vector3) {
    const g = this.g;
    const at = p ?? g.player.pos;
    if (ev === 'grab' || ev === 'pullDone') {
      g.audio.play(g.audio.has('ledgeGrab') ? 'ledgeGrab' : 'legs', { gain: 0.7, reverb: 0.05 });
      g.audio.play('imp_punch', { gain: 0.2, bus: 'ui', reverb: 0, rate: 0.7 });
      g.rig?.addTrauma?.(0.12);
    }
    if (ev === 'shimmy') g.audio.play('cloth', { gain: 0.35, rate: 1.2, reverb: 0, vary: 0.1 });
    if (ev === 'pullUp') g.audio.play('cloth', { gain: 0.6, rate: 0.85, reverb: 0 });
    if (ev === 'rappelStart') {
      g.audio.play('imp_metal_light', { pos: at, gain: 0.7, rate: 0.7, ref: 3 });
      g.audio.play('cloth', { gain: 0.6, reverb: 0 });
    }
    if (ev === 'rappelKick') {
      g.audio.play('legs', { gain: 0.7, rate: 0.7, reverb: 0.05 });
      g.audio.play('zipline', { gain: 0.35, rate: 1.3, reverb: 0 });
    }
    if (ev === 'rappelLand') g.audio.play('land', { gain: 0.6, reverb: 0.05 });
    void at;
  }

  /** prompt under the crosshair */
  hint(): string {
    const pl = this.g.player;
    if (pl.climb?.kind === 'hang') return '[W] PULL UP  ·  [A][D] SHIMMY  ·  [C] DROP';
    if (pl.climb?.kind === 'rappel') return '[S] DOWN  ·  [SHIFT] FAST  ·  [SPACE] KICK OFF  ·  [W] UP  ·  [C] LET GO';
    if (this.rappelAt) return '[F] RAPPEL DOWN';
    return '';
  }
  usesF() {
    return !!this.rappelAt;
  }

  update(dt: number) {
    const g = this.g;
    const pl = g.player;
    const a = g.avatar;
    const inp = g.input;
    this.grappleCd = Math.max(0, this.grappleCd - dt);
    const climb = pl.climb as { kind: string } | null;
    // hands follow the climb state
    const kind = climb?.kind ?? null;
    if (kind !== this.lastClimb) {
      if (kind === 'hang') g.vm.play('ledge', 0.9, [], undefined, { holdAt: 0.5, hold: () => g.player.climb?.kind === 'hang' });
      if (kind === 'rappel') g.vm.play('rappel', 0.9, [], undefined, { holdAt: 0.5, hold: () => g.player.climb?.kind === 'rappel' });
      this.lastClimb = kind;
    }
    const act = g.vm.action;
    if (act && act.type === 'ledge' && climb?.kind === 'hang') act.data.shimmy = (act.data.shimmy ?? 0) + dt * Math.abs(inp.axis('left', 'right'));
    if (act && act.type === 'rappel') {
      this.slideK = Math.abs(inp.axis('back', 'forward')) > 0.3 || (pl.climb?.kick ?? 0) > 0 ? 1 : 0;
      act.data.slide = this.slideK;
    }
    g.weapons.handsBusy = g.weapons.handsBusy || kind === 'hang' || kind === 'pull' || kind === 'rappel';

    // the rope: from the anchor (rappel) or the hook (grapple) to your harness
    this.updateRope(dt);

    if (!a.alive || a.downed || g.state !== 'playing') {
      this.rappelAt = null;
      return;
    }
    // a drop in front of you: offer the rope
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.2;
      this.rappelAt = !climb && pl.grounded && !pl.mantle && !pl.ladder ? this.findRappel() : null;
    }
    if (this.rappelAt && inp.wasPressed('spot') && !g.field.usesF() && !g.scav.usesF()) {
      const r = this.rappelAt;
      this.rappelAt = null;
      pl.startRappel(r.anchor, r.n, r.ground);
    }
    // grappling hook
    if (inp.wasPressed('grapple') && !g.sab) this.fireGrapple();
    // blind fire
    g.weapons.blindWant = inp.isDown('blind') && !climb && !g.field.handsBusy;
  }

  /** standing at an edge with 4+ m of drop in front, a wall face below it */
  private findRappel() {
    const g = this.g;
    const pl = g.player;
    const fwd = new THREE.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    const feet = pl.pos.clone();
    for (const d of [0.7, 1.0]) {
      const out = feet.clone().addScaledVector(fwd, d).setY(feet.y + 0.5);
      if (g.physics.raycast(feet.clone().setY(feet.y + 0.5), fwd, d)) return null; // a wall / railing in the way
      const near = g.physics.raycast(out, new THREE.Vector3(0, -1, 0), 4.5);
      if (near) continue;
      const far = g.physics.raycast(out, new THREE.Vector3(0, -1, 0), 60);
      const groundY = far ? far.point.y : g.terrain.heightAt(out.x, out.z);
      if (feet.y - groundY < 4 || groundY < -0.5) return null;
      // the face below the edge: look back at it from out in the air
      const probe = feet.clone().addScaledVector(fwd, d + 0.6).setY(feet.y - 1.2);
      const face = g.physics.raycast(probe, fwd.clone().negate(), d + 1.2);
      if (!face || Math.abs(face.normal.y) > 0.5) return null;
      const n = face.normal.clone().setY(0).normalize();
      const anchor = new THREE.Vector3(face.point.x, feet.y, face.point.z);
      return { anchor, n, ground: groundY };
    }
    return null;
  }

  // ---------------------------------------------------------------- grappling hook
  private fireGrapple() {
    const g = this.g;
    const pl = g.player;
    if (this.grappleCd > 0) {
      g.ui.notify('GRAPPLING HOOK', `REWINDING ${Math.ceil(this.grappleCd)} S`);
      return;
    }
    if (pl.climb || pl.mantle || pl.ladder || g.vm.action || g.weapons.switching || g.weapons.reloading) return;
    const eye = g.camera.position.clone();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    const hit = g.physics.raycast(eye, fwd, 32);
    let to: THREE.Vector3, n: THREE.Vector3, top = NaN, ok = false;
    if (hit && Math.abs(hit.normal.y) < 0.55 && hit.info.surface !== 'glass') {
      n = hit.normal.clone().setY(0).normalize();
      to = hit.point.clone();
      // a ledge up to 4 m above the bite: you'll arrive hanging from it
      const probe = new THREE.Vector3(to.x - n.x * 0.25, to.y + 4.2, to.z - n.z * 0.25);
      const h = g.physics.raycast(probe, new THREE.Vector3(0, -1, 0), 4.7);
      if (h && h.normal.y > 0.7 && h.point.y > to.y - 0.3) {
        top = h.point.y;
        // bite right under the edge
        to.y = top - 0.15;
      }
      ok = true;
    } else if (hit && hit.normal.y > 0.7) {
      // a roof / ledge top hit from below-ish: hang from its edge if there is a face under it
      to = hit.point.clone();
      n = new THREE.Vector3(-fwd.x, 0, -fwd.z).normalize();
      const face = g.physics.raycast(to.clone().addScaledVector(n, 0.8).setY(to.y - 0.4), n.clone().negate(), 2);
      if (face && Math.abs(face.normal.y) < 0.5) {
        n = face.normal.clone().setY(0).normalize();
        top = to.y;
        to = new THREE.Vector3(face.point.x, top - 0.15, face.point.z);
        ok = true;
      }
    } else {
      to = eye.clone().addScaledVector(fwd, 32);
      n = fwd.clone().negate();
    }
    // the launcher comes up and fires
    g.player.sprinting = false;
    g.vm.holdItem('grapple');
    g.vm.play('grapple', 1.1, [], undefined, { holdAt: 0.6, hold: () => !!this.shot || g.player.climb?.kind === 'pull' });
    const from = eye.clone().addScaledVector(fwd, 0.5).add(new THREE.Vector3(-0.15, -0.12, 0).applyQuaternion(g.camera.quaternion));
    this.shot = { from, to: to!, n: n!, top, t: -0.35, dur: Math.max(0.12, from.distanceTo(to!) / 60), hit: ok, back: 0 };
    this.grappleCd = 8;
  }

  /** the 'grappleFire' beat: the hook leaves the launcher */
  fired() {
    const g = this.g;
    if (!this.shot) return;
    this.shot.t = 0;
    g.audio.play('grappleFire', { gain: 0.9, reverb: 0.05 });
    if (!g.audio.has('grappleFire')) g.audio.play('slideBack', { gain: 0.8, rate: 0.6, reverb: 0.05 });
    g.rig?.addTrauma?.(0.1);
  }

  private updateRope(dt: number) {
    const g = this.g;
    const pl = g.player;
    const harness = pl.pos.clone().setY(pl.pos.y + 1.05);
    let a: THREE.Vector3 | null = null, b: THREE.Vector3 | null = null;
    const s = this.shot;
    if (s && s.t >= 0) {
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      // in flight: the hook spins out along the line
      if (s.back === 0) {
        const hp = s.from.clone().lerp(s.to, k);
        hp.y += Math.sin(k * Math.PI) * 0.3;
        this.hook.visible = true;
        this.hook.position.copy(hp);
        this.hook.lookAt(s.to);
        this.hook.rotateZ(s.t * 18);
        (this.hook.userData.setProngs as (k: number) => void)?.(k > 0.85 ? 1 : 0.2);
        a = hp;
        b = this.leftHand();
        if (k >= 1) {
          if (s.hit) {
            // it bites: sparks off the stone, the line snaps taut, you go
            g.audio.play('imp_metal', { pos: s.to, gain: 0.8, ref: 4, rate: 1.3 });
            for (let i = 0; i < 8; i++) g.fx.sparks.spawn(s.to.clone(), s.n.clone().multiplyScalar(2).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), [4, 3, 1.5], 1, 0.015, 0.3, { drag: 1, grav: 9.8 });
            pl.startPull(s.to, s.n, s.top);
            g.audio.play(g.audio.has('grappleReel') ? 'grappleReel' : 'zipline', { gain: 0.7, rate: 1.1, reverb: 0 });
            s.back = -1; // pulling
          } else {
            s.back = 0.001; // reel back in
            g.ui.notify('GRAPPLING HOOK', 'NO GRIP');
          }
        }
      }
      if (s.back < 0) {
        // reeling in: the hook stays bitten, the rope shortens
        a = s.to;
        b = harness;
        if (pl.climb?.kind !== 'pull') {
          this.shot = null;
          this.hook.visible = false;
        }
      } else if (s.back > 0) {
        s.back += dt * 3;
        const hp = s.to.clone().lerp(this.leftHand(), Math.min(1, s.back));
        this.hook.position.copy(hp);
        a = hp;
        b = this.leftHand();
        if (s.back >= 1) {
          this.shot = null;
          this.hook.visible = false;
        }
      }
    }
    const c = pl.climb as { kind: string; anchor?: THREE.Vector3 } | null;
    // the rope singing through the descender while you go down
    if (c?.kind === 'rappel' && this.slideK > 0) {
      this.zipT -= dt;
      if (this.zipT <= 0) {
        this.zipT = 0.9;
        g.audio.play(g.audio.has('rappelZip') ? 'rappelZip' : 'zipline', { gain: 0.45, reverb: 0.05, vary: 0.08 });
      }
    }
    if (c?.kind === 'rappel' && c.anchor) {
      a = c.anchor;
      b = harness;
      this.anchorMesh.visible = true;
      this.anchorMesh.position.copy(c.anchor).setY(c.anchor.y + 0.015);
    } else this.anchorMesh.visible = false;
    if (a && b) {
      const d = b.clone().sub(a);
      const len = d.length();
      this.ropeMesh.visible = len > 0.05;
      this.ropeMesh.position.copy(a);
      this.ropeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().divideScalar(Math.max(len, 1e-4)));
      this.ropeMesh.scale.set(1, len, 1);
    } else this.ropeMesh.visible = false;
  }
  private leftHand() {
    const g = this.g;
    return g.camera.position.clone().add(new THREE.Vector3(-0.15, -0.15, -0.45).applyQuaternion(g.camera.quaternion));
  }

  clear() {
    this.shot = null;
    this.hook.visible = false;
    this.ropeMesh.visible = false;
    this.anchorMesh.visible = false;
    this.rappelAt = null;
    this.grappleCd = 0;
    this.lastClimb = null;
  }
}
