import * as THREE from 'three';
import { bakeStatic } from '../render/Batch';

/**
 * Supply pouches dropped by killed enemies. Walk over one to take it: health, a magazine's worth
 * of ammo for both weapons, a frag and a tactical (each capped at the loadout maximum). Pouches
 * bob, glint and slowly turn so they read from a distance; they blink before disappearing (30 s).
 */
interface Pouch { g: THREE.Group; p: THREE.Vector3; t: number; ground: number }

export class Pickups {
  pouches: Pouch[] = [];
  readonly life = 30;
  private proto: THREE.Group;
  private iconTex: THREE.CanvasTexture;

  constructor(private scene: THREE.Scene) {
    this.iconTex = Pickups.icon();
    this.proto = Pickups.model();
    bakeStatic(this.proto);
  }

  static icon() {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const x = c.getContext('2d')!;
    x.fillStyle = 'rgba(8,12,14,0.7)';
    x.beginPath();
    x.arc(48, 48, 40, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#ffd257';
    x.lineWidth = 5;
    x.stroke();
    // cross + three rounds
    x.fillStyle = '#ff5a48';
    x.fillRect(22, 40, 22, 8);
    x.fillRect(29, 33, 8, 22);
    x.fillStyle = '#e8c56c';
    for (let i = 0; i < 3; i++) {
      x.fillRect(52 + i * 9, 34, 6, 22);
      x.beginPath();
      x.arc(55 + i * 9, 34, 3, Math.PI, 0);
      x.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  static model() {
    const g = new THREE.Group();
    const od = new THREE.MeshStandardMaterial({ color: 0x4a4f38, roughness: 0.85 });
    const strap = new THREE.MeshStandardMaterial({ color: 0x2b2d22, roughness: 0.9 });
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.2), od);
    bag.position.y = 0.07;
    g.add(bag);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.03, 0.12), od);
    flap.position.set(0, 0.15, -0.04);
    flap.rotation.x = 0.15;
    g.add(flap);
    for (const x of [-0.09, 0.09]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.145, 0.205), strap);
      s.position.set(x, 0.072, 0);
      g.add(s);
    }
    const cross = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    cross.position.set(0, 0.08, 0.1015);
    g.add(cross);
    for (const [w, h] of [[0.04, 0.012], [0.012, 0.04]] as const) {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xc8201a }));
      r.position.set(0, 0.08, 0.102);
      g.add(r);
    }
    // ammo can strapped on top
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.09), new THREE.MeshStandardMaterial({ color: 0x3e4a2e, roughness: 0.5, metalness: 0.5 }));
    can.position.set(0.04, 0.2, 0.03);
    can.rotation.y = 0.3;
    g.add(can);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc29a4e, roughness: 0.3, metalness: 1 });
    for (let i = 0; i < 3; i++) {
      const rd = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.045, 8), brass);
      rd.rotation.z = Math.PI / 2;
      rd.position.set(-0.09, 0.165 + i * 0.002, -0.02 + i * 0.015);
      g.add(rd);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

  drop(p: THREE.Vector3, groundY: number) {
    const g = this.proto.clone();
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.iconTex, depthWrite: false, transparent: true, toneMapped: false }));
    icon.scale.setScalar(0.32);
    icon.position.y = 0.6;
    icon.name = 'icon';
    g.add(icon);
    g.position.set(p.x, groundY, p.z);
    g.rotation.y = Math.random() * Math.PI * 2;
    g.traverse((o) => o.layers.set(1));
    this.scene.add(g);
    this.pouches.push({ g, p: new THREE.Vector3(p.x, groundY, p.z), t: 0, ground: groundY });
    while (this.pouches.length > 20) this.remove(0);
  }

  private remove(i: number) {
    this.scene.remove(this.pouches[i].g);
    this.pouches.splice(i, 1);
  }

  clear() {
    while (this.pouches.length) this.remove(0);
  }

  /** Returns how many pouches the player picked up this frame. */
  update(dt: number, player: THREE.Vector3 | null, time: number) {
    let got = 0;
    for (let i = this.pouches.length - 1; i >= 0; i--) {
      const pc = this.pouches[i];
      pc.t += dt;
      pc.g.rotation.y += dt * 0.8;
      const icon = pc.g.getObjectByName('icon') as THREE.Sprite;
      icon.position.y = 0.6 + Math.sin(time * 3 + i) * 0.04;
      const blink = pc.t > this.life - 5 ? (Math.sin(pc.t * 14) > 0 ? 1 : 0.15) : 1;
      (icon.material as THREE.SpriteMaterial).opacity = blink;
      if (player && Math.hypot(player.x - pc.p.x, player.z - pc.p.z) < 1.35 && Math.abs(player.y - pc.ground) < 1.6) {
        got++;
        this.remove(i);
        continue;
      }
      if (pc.t > this.life) this.remove(i);
    }
    return got;
  }
}
