import * as THREE from 'three';
import { landmarkAt, MAP_NAME } from '../world/MapLayout';

/**
 * Map intro (Update 47): before you deploy, a short cinematic flyover of where you are fighting.
 *
 *  1  the establishing shot: high over the fjord, a slow orbit round the battlefield while the
 *     map's name, its latitude and the mode come up between letterbox bars
 *  2  down low: a dolly in towards the middle objective, its name on a card
 *  3  the crane down: from above and behind your squad onto your own shoulders, easing into
 *     first person as the bars pull away
 *
 * ~10 s, skipped with Space / a click / Esc. The soldiers are already moving out under it.
 */

type G = any;

interface Shot { dur: number; pos: (k: number) => THREE.Vector3; look: (k: number) => THREE.Vector3; fov: number; card?: { small: string; big: string } }

const LAT: Record<string, string> = { Kvitvika: '68°34′N · 14°52′E', Brosund: '67°17′N · 14°23′E', Solvik: '69°02′N · 16°10′E' };

export class MapIntro {
  active = false;
  private t = 0;
  private shots: Shot[] = [];
  private onDone: (() => void) | null = null;
  private el: HTMLElement | null = null;
  private shotIdx = -1;
  private endQ = new THREE.Quaternion();
  private endP = new THREE.Vector3();

  constructor(private g: G) {}

  start(mode: string, onDone: () => void) {
    const g = this.g;
    this.onDone = onDone;
    this.active = true;
    this.t = 0;
    this.shotIdx = -1;
    const flags = (g.dom?.flags ?? []) as { pos: THREE.Vector3; letter: string }[];
    const me = g.player.pos.clone() as THREE.Vector3;
    const centre = flags.length ? flags.reduce((c, f) => c.add(f.pos), new THREE.Vector3()).multiplyScalar(1 / flags.length) : me.clone();
    const mid = flags.find((f) => f.letter === 'B') ?? flags[0] ?? { pos: centre, letter: '' };
    const h = (p: THREE.Vector3) => Math.max(g.terrain.heightAt(p.x, p.z), 0);
    const spread = Math.max(80, ...flags.map((f) => f.pos.distanceTo(centre))) * 1.35;
    // 1: orbit
    const a0 = Math.atan2(me.x - centre.x, me.z - centre.z) + Math.PI * 0.85;
    const s1: Shot = {
      dur: 4.2, fov: 46,
      pos: (k) => {
        const a = a0 + k * 0.42;
        const p = new THREE.Vector3(centre.x + Math.sin(a) * spread, 0, centre.z + Math.cos(a) * spread);
        p.y = Math.max(h(p) + 30, centre.y + 62 - 10 * k);
        return p;
      },
      look: (k) => centre.clone().setY(centre.y + 4 - 4 * k),
      card: { small: `${LAT[MAP_NAME] ?? '68°N'} · ${mode}`, big: MAP_NAME.toUpperCase() },
    };
    // 2: dolly in on the middle objective (from the side away from our spawn)
    const away = mid.pos.clone().sub(me).setY(0).normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const d0 = mid.pos.clone().addScaledVector(away, 46).addScaledVector(side, 14);
    const d1 = mid.pos.clone().addScaledVector(away, 18).addScaledVector(side, 5);
    const s2: Shot = {
      dur: 3.4, fov: 52,
      pos: (k) => {
        const p = d0.clone().lerp(d1, ease(k));
        p.y = Math.max(h(p) + 4.5, mid.pos.y + 10 - 5 * k);
        return p;
      },
      look: (k) => mid.pos.clone().setY(mid.pos.y + 2 + 1.5 * (1 - k)),
      card: mid.letter ? { small: 'MÅL · OBJECTIVE', big: `${mid.letter} · ${landmarkAt(mid.pos.x, mid.pos.z).toUpperCase()}` } : undefined,
    };
    // 3: crane down onto your shoulders, settling into the first-person view
    const fwd = new THREE.Vector3(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
    const eye = g.player.eyePosition(new THREE.Vector3()) as THREE.Vector3;
    const c0 = eye.clone().addScaledVector(fwd, -16).add(new THREE.Vector3(0, 13, 0));
    const c1 = eye.clone().addScaledVector(fwd, -0.4).add(new THREE.Vector3(0, 0.25, 0));
    const s3: Shot = {
      dur: 2.6, fov: 60,
      pos: (k) => c0.clone().lerp(c1, ease(k)),
      look: (k) => eye.clone().addScaledVector(fwd, 6 + 20 * k).setY(eye.y - 2 * (1 - k)),
    };
    this.shots = [s1, s2, s3];
    this.endP.copy(eye);
    g.camera.updateMatrixWorld();
    this.endQ.copy(g.camera.quaternion);
    // the letterbox and the cards
    this.el?.remove();
    this.el = document.createElement('div');
    this.el.className = 'mapintro';
    this.el.innerHTML = '<i class="mi-top"></i><i class="mi-bot"></i><div class="mi-card"><small></small><b></b><s></s></div><div class="mi-skip"><kbd>SPACE</kbd> SKIP</div>';
    g.ui.root.appendChild(this.el);
    g.ui.showHUD?.(false);
    g.audio.play('uiWhoosh', { gain: 0.5, bus: 'ui', reverb: 0 });
  }

  /** after the rig has placed the first-person camera: put the camera on the flyover */
  apply(dt: number) {
    if (!this.active) return;
    const g = this.g;
    const inp = g.input;
    if (inp.wasPressed('jump') || inp.wasPressed('fire') || this.t > 0.6 && inp.wasPressed('spot')) return this.finish();
    this.t += dt;
    let t = this.t, i = 0;
    while (i < this.shots.length && t > this.shots[i].dur) {
      t -= this.shots[i].dur;
      i++;
    }
    if (i >= this.shots.length) return this.finish();
    const s = this.shots[i];
    const k = Math.min(1, t / s.dur);
    // the card follows game time: in with the shot, out before it cuts
    if (k > 0.8 && this.el) this.el.querySelector('.mi-card')?.classList.remove('on');
    if (i !== this.shotIdx) {
      this.shotIdx = i;
      this.card(s.card ?? null);
      if (i > 0) g.audio.play('uiWhoosh', { gain: 0.35, bus: 'ui', reverb: 0, rate: 0.8 });
      if (i === 2) this.el?.classList.add('out');
    }
    const cam = g.camera as THREE.PerspectiveCamera;
    const baseFov = cam.fov;
    cam.position.copy(s.pos(k));
    cam.lookAt(s.look(k));
    // the last shot hands over to your own eyes
    if (i === 2 && k > 0.6) {
      const b = ease((k - 0.6) / 0.4);
      cam.quaternion.slerp(this.endQ, b);
    }
    cam.fov = i === 2 ? s.fov + (baseFov - s.fov) * ease(k) : s.fov;
    cam.updateProjectionMatrix();
    g.vm.root.visible = false;
  }

  private card(c: { small: string; big: string } | null) {
    if (!this.el) return;
    const card = this.el.querySelector('.mi-card') as HTMLElement;
    card.classList.remove('on');
    void card.offsetWidth;
    if (!c) return;
    (card.querySelector('small') as HTMLElement).textContent = c.small;
    (card.querySelector('b') as HTMLElement).textContent = c.big;
    card.classList.add('on');
  }

  finish() {
    if (!this.active) return;
    const g = this.g;
    this.active = false;
    const el = this.el;
    this.el = null;
    if (el) {
      el.classList.add('done');
      setTimeout(() => el.remove(), 700);
    }
    g.ui.showHUD?.(true);
    const cb = this.onDone;
    this.onDone = null;
    cb?.();
  }
}

function ease(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
