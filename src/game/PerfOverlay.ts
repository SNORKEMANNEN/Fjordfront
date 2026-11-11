import * as THREE from 'three';
import type { GpuTimer } from '../render/PerfGovernor';

/**
 * F3 performance overlay: frame rate, frame time (avg / worst), simulation and render CPU time,
 * GPU time (EXT_disjoint_timer_query_webgl2 where the browser exposes it), draw calls, triangles
 * and the render resolution. Meant to show where the time goes on *your* machine.
 */
export class PerfOverlay {
  el: HTMLDivElement;
  private acc = { n: 0, frame: 0, worst: 0, sim: 0, cpu: 0, calls: 0, tris: 0, t: 0 };
  private last = performance.now();
  /** extra lines (resolution scale, refresh rate, auto-graphics notes) */
  extra: () => string = () => '';
  /** multiplayer: network numbers for the graph (null offline) */
  net: (() => { rtt: number; loss: number; up: number; down: number; interp: number; jitter: number } | null) | null = null;
  private text: HTMLDivElement;
  private graph: HTMLCanvasElement;
  private hist: { rtt: number; loss: number; up: number; down: number; interp: number }[] = [];
  private netT = 0;

  constructor(private renderer: THREE.WebGLRenderer, parent: HTMLElement, private gpu: GpuTimer) {
    this.el = document.createElement('div');
    this.el.className = 'perfov';
    this.el.style.display = 'none';
    this.text = document.createElement('div');
    this.graph = document.createElement('canvas');
    this.graph.width = 200;
    this.graph.height = 70;
    this.graph.className = 'netgraph';
    this.graph.style.display = 'none';
    this.el.append(this.text, this.graph);
    parent.appendChild(this.el);
  }

  /**
   * Network graph (multiplayer): round trip (white), interpolation delay (blue), upload (green) and
   * download (yellow) KB/s over the last ~20 s, red bars for packet loss.
   */
  private drawNet(ft: number) {
    const n = this.net?.();
    this.graph.style.display = n ? 'block' : 'none';
    if (!n) return '';
    this.netT += ft;
    if (this.netT >= 200) {
      this.netT = 0;
      this.hist.push({ rtt: n.rtt, loss: n.loss, up: n.up, down: n.down, interp: n.interp });
      if (this.hist.length > 100) this.hist.shift();
      const c = this.graph.getContext('2d')!;
      const W = 200, H = 70;
      c.clearRect(0, 0, W, H);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(0, 0, W, H);
      const maxMs = Math.max(100, ...this.hist.map((h) => Math.max(h.rtt, h.interp))) * 1.15;
      const maxKb = Math.max(10, ...this.hist.map((h) => Math.max(h.up, h.down))) * 1.15;
      this.hist.forEach((h, i) => {
        if (h.loss > 0) {
          c.fillStyle = 'rgba(255,70,60,0.8)';
          const bh = Math.min(H, h.loss * 4);
          c.fillRect(i * 2, H - bh, 2, bh);
        }
      });
      const line = (col: string, f: (h: (typeof this.hist)[0]) => number, max: number) => {
        c.strokeStyle = col;
        c.lineWidth = 1;
        c.beginPath();
        this.hist.forEach((h, i) => {
          const y = H - (f(h) / max) * H;
          if (i) c.lineTo(i * 2, y);
          else c.moveTo(0, y);
        });
        c.stroke();
      };
      line('#9fd28a', (h) => h.up, maxKb);
      line('#e8d27a', (h) => h.down, maxKb);
      line('#7fb4ff', (h) => h.interp, maxMs);
      line('#ffffff', (h) => h.rtt, maxMs);
    }
    return `<div>net: rtt ${Math.round(n.rtt)} ms · loss ${n.loss.toFixed(1)}% · jitter ${Math.round(n.jitter)} ms · interp ${Math.round(n.interp)} ms</div><div>up ${n.up.toFixed(1)} · down ${n.down.toFixed(1)} KB/s <small style="opacity:.7">(white rtt · blue interp · green up · yellow down · red loss)</small></div>`;
  }

  get visible() {
    return this.el.style.display !== 'none';
  }
  set visible(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
    this.renderer.info.autoReset = !v;
  }

  /** once per frame, after rendering */
  frame(simMs: number, cpuRenderMs: number) {
    if (!this.visible) return;
    const now = performance.now();
    const ft = now - this.last;
    this.last = now;
    const a = this.acc;
    a.n++;
    a.frame += ft;
    a.worst = Math.max(a.worst, ft);
    a.sim += simMs;
    a.cpu += cpuRenderMs;
    const info = this.renderer.info;
    a.calls += info.render.calls;
    a.tris += info.render.triangles;
    info.reset();
    a.t += ft;
    const netLines = this.drawNet(ft);
    if (a.t < 500) return;
    const f = (v: number) => v.toFixed(1);
    const g = this.gpu.ms;
    this.text.innerHTML =
      `<b>${Math.round(1000 / (a.frame / a.n))} FPS</b>` +
      `<div>frame ${f(a.frame / a.n)} ms · worst ${f(a.worst)}</div>` +
      `<div>sim (CPU) ${f(a.sim / a.n)} ms</div>` +
      `<div>render (CPU) ${f(a.cpu / a.n)} ms</div>` +
      `<div>GPU ${this.gpu.available ? (g >= 0 ? f(g) + ' ms' : '…') : 'n/a in this browser'}</div>` +
      `<div>draw calls ${Math.round(a.calls / a.n)} · tris ${Math.round(a.tris / a.n / 1000)}k</div>` +
      this.extra() +
      netLines;
    this.acc = { n: 0, frame: 0, worst: 0, sim: 0, cpu: 0, calls: 0, tris: 0, t: 0 };
  }
}
