import * as THREE from 'three';
import type { Bot } from './Bot';

/**
 * AI debug overlay (F4, or ?aidebug in the URL): for soldiers near the camera a label with what
 * they're doing and why (intent, its runner-up scores, awareness of you, suppression, stance,
 * cover, target), plus lines in the world: the planned route (white), the chosen cover spot
 * (yellow), the last known enemy position (red) and where they look (cyan).
 */
export class AIDebug {
  on = typeof location !== 'undefined' && location.search.includes('aidebug');
  private root: HTMLDivElement | null = null;
  private labels = new Map<number, HTMLDivElement>();
  private lines: THREE.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private max = 4096;

  constructor(private scene: THREE.Scene, private parent: HTMLElement) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.max * 6);
    this.col = new Float32Array(this.max * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85, fog: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.layers.set(1);
    this.lines.visible = false;
    scene.add(this.lines);
  }

  toggle() {
    this.on = !this.on;
    if (!this.on) this.hide();
  }
  private hide() {
    this.lines.visible = false;
    if (this.root) this.root.style.display = 'none';
  }

  update(bots: Bot[], cam: THREE.PerspectiveCamera, player: { position(): THREE.Vector3 } | null, range = 90) {
    if (!this.on) return;
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:25';
      this.parent.appendChild(this.root);
    }
    this.root.style.display = 'block';
    this.lines.visible = true;
    let n = 0;
    const seg = (a: THREE.Vector3, b: THREE.Vector3, r: number, g: number, bl: number) => {
      if (n >= this.max) return;
      this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6);
      this.col.set([r, g, bl, r, g, bl], n * 6);
      n++;
    };
    const W = window.innerWidth, H = window.innerHeight;
    const seen = new Set<number>();
    const v = new THREE.Vector3(), w2 = new THREE.Vector3();
    for (const b of bots) {
      if (!b.alive || b.netPuppet) continue;
      const p = b.position();
      if (p.distanceTo(cam.position) > range) continue;
      const info = b.debugInfo();
      // route
      let prev = v.copy(p).setY(p.y + 0.15);
      for (const q of info.path) {
        const qq = w2.copy(q).setY(q.y + 0.15);
        seg(prev, qq, 0.9, 0.9, 0.9);
        prev = v.copy(qq);
      }
      if (b.coverNode) seg(v.copy(p).setY(p.y + 1), w2.copy(b.coverNode.p).setY(b.coverNode.p.y + 1), 1, 0.85, 0.2);
      if (info.lastSeenT < 12) seg(v.copy(p).setY(p.y + 1.5), w2.copy(info.lastSeen).setY(info.lastSeen.y + 1.2), 1, 0.25, 0.2);
      const eye = b.eye(v);
      seg(eye, w2.copy(eye).addScaledVector(b.lookDir(new THREE.Vector3()), 3), 0.3, 0.9, 1);
      // label
      const head = w2.copy(p).setY(p.y + 2.3).project(cam);
      if (head.z > 1 || head.x < -1.1 || head.x > 1.1 || head.y < -1.1 || head.y > 1.1) continue;
      seen.add(b.id);
      let el = this.labels.get(b.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'aidbg t' + b.team;
        this.root.appendChild(el);
        this.labels.set(b.id, el);
      }
      el.style.left = `${(head.x * 0.5 + 0.5) * W}px`;
      el.style.top = `${(-head.y * 0.5 + 0.5) * H}px`;
      const sc = Object.entries(b.scores).sort((x, y) => (y[1] as number) - (x[1] as number)).slice(0, 3).map(([k, s]) => `${k.slice(0, 4)} ${(s as number).toFixed(2)}`).join(' · ');
      const aw = player ? b.awareness(player as never) : 0;
      el.textContent =
        `${b.name} [${b.team}] ${b.intent.toUpperCase()} hp ${Math.round(b.health)}\n` +
        `${sc}\n` +
        `aware(you) ${aw.toFixed(2)}  supp ${b.suppression.toFixed(2)}  ${b.stanceCur}${b.coverNode ? `  cover q${b.coverQ}` : ''}\n` +
        (b.target ? `target ${b.target.name} ${b.target.position().distanceTo(p).toFixed(0)}m  seen ${info.lastSeenT.toFixed(1)}s` : 'no target') +
        (b.order ? `\norder ${b.order.kind}` : '');
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) {
      el.remove();
      this.labels.delete(id);
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, n * 2);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
