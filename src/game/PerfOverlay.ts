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

  constructor(private renderer: THREE.WebGLRenderer, parent: HTMLElement, private gpu: GpuTimer) {
    this.el = document.createElement('div');
    this.el.className = 'perfov';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
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
    if (a.t < 500) return;
    const f = (v: number) => v.toFixed(1);
    const g = this.gpu.ms;
    this.el.innerHTML =
      `<b>${Math.round(1000 / (a.frame / a.n))} FPS</b>` +
      `<div>frame ${f(a.frame / a.n)} ms · worst ${f(a.worst)}</div>` +
      `<div>sim (CPU) ${f(a.sim / a.n)} ms</div>` +
      `<div>render (CPU) ${f(a.cpu / a.n)} ms</div>` +
      `<div>GPU ${this.gpu.available ? (g >= 0 ? f(g) + ' ms' : '…') : 'n/a in this browser'}</div>` +
      `<div>draw calls ${Math.round(a.calls / a.n)} · tris ${Math.round(a.tris / a.n / 1000)}k</div>` +
      this.extra();
    this.acc = { n: 0, frame: 0, worst: 0, sim: 0, cpu: 0, calls: 0, tris: 0, t: 0 };
  }
}
