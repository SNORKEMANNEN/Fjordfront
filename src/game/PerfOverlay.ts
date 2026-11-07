import * as THREE from 'three';

/**
 * F3 performance overlay: frame rate, frame time (avg / worst), simulation and render CPU time,
 * GPU time (EXT_disjoint_timer_query_webgl2 where the browser exposes it), draw calls, triangles
 * and the render resolution. Meant to show where the time goes on *your* machine.
 */
export class PerfOverlay {
  el: HTMLDivElement;
  private gl: WebGL2RenderingContext;
  private ext: any;
  private queries: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private acc = { n: 0, frame: 0, worst: 0, sim: 0, cpu: 0, gpu: 0, gpuN: 0, calls: 0, tris: 0, t: 0 };
  private last = performance.now();

  constructor(private renderer: THREE.WebGLRenderer, parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perfov';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get visible() {
    return this.el.style.display !== 'none';
  }
  set visible(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
    this.renderer.info.autoReset = !v;
  }

  beginGpu() {
    if (!this.visible || !this.ext || this.active) return;
    const q = this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  endGpu() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.active);
    this.active = null;
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
    // collect finished GPU timings
    while (this.queries.length) {
      const q = this.queries[0];
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number;
      if (!disjoint) {
        a.gpu += ns / 1e6;
        a.gpuN++;
      }
      this.gl.deleteQuery(q);
      this.queries.shift();
    }
    a.t += ft;
    if (a.t < 500) return;
    const sz = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const f = (v: number) => v.toFixed(1);
    this.el.innerHTML =
      `<b>${Math.round(1000 / (a.frame / a.n))} FPS</b>` +
      `<div>frame ${f(a.frame / a.n)} ms · worst ${f(a.worst)}</div>` +
      `<div>sim (CPU) ${f(a.sim / a.n)} ms</div>` +
      `<div>render (CPU) ${f(a.cpu / a.n)} ms</div>` +
      `<div>GPU ${this.ext ? (a.gpuN ? f(a.gpu / a.gpuN) + ' ms' : '…') : 'n/a in this browser'}</div>` +
      `<div>draw calls ${Math.round(a.calls / a.n)} · tris ${Math.round(a.tris / a.n / 1000)}k</div>` +
      `<div>${sz.x}×${sz.y} px</div>`;
    this.acc = { n: 0, frame: 0, worst: 0, sim: 0, cpu: 0, gpu: 0, gpuN: 0, calls: 0, tris: 0, t: 0 };
  }
}
