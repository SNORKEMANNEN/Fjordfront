import * as THREE from 'three';
import { Settings } from '../game/Settings';
import type { Pipeline } from './Pipeline';

/** GPU frame time from EXT_disjoint_timer_query_webgl2 (where the browser exposes it). */
export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: any;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** latest GPU frame time (ms), smoothed; -1 while unknown */
  ms = -1;
  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    try {
      this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    } catch {
      this.ext = null;
    }
  }
  get available() {
    return !!this.ext;
  }
  begin() {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  /** collect finished queries (non-blocking) */
  poll() {
    while (this.pending.length) {
      const q = this.pending[0];
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number;
      if (!disjoint && ns > 0) {
        const ms = ns / 1e6;
        this.ms = this.ms < 0 ? ms : this.ms + (ms - this.ms) * 0.15;
      }
      this.gl.deleteQuery(q);
      this.pending.shift();
    }
  }
}

/** Expensive features the governor may switch off (in this order) when even the lowest render
 *  resolution can't hold the frame rate. Session-only: your saved settings are never changed. */
const LADDER: { key: 'ao' | 'bloom' | 'godRays' | 'antialias' | 'shadowRes'; label: string }[] = [
  { key: 'ao', label: 'ambient occlusion' },
  { key: 'godRays', label: 'sun shafts' },
  { key: 'bloom', label: 'bloom' },
  { key: 'shadowRes', label: 'shadow resolution' },
  { key: 'antialias', label: 'anti-aliasing' },
];

/**
 * Keeps the frame rate at the target (or the display's refresh rate, whichever is lower) without
 * visible side effects:
 *  - detects the monitor's refresh rate from the frame intervals, so a 120 fps target on a 60 Hz
 *    screen no longer reads as "always too slow" (that used to drive the resolution to its floor);
 *  - steps the internal render resolution in small steps with hysteresis and back-off, so it
 *    settles instead of oscillating (and never resizes the canvas — see Pipeline.applyScale);
 *  - uses GPU timer queries when available to know there is headroom before stepping up;
 *  - as a last resort (resolution at its floor and still slow for several seconds) switches off
 *    the costliest effects one by one, and tells the player.
 */
export class PerfGovernor {
  /** detected display refresh interval (ms) */
  refreshMs = 1000 / 60;
  private intervals: number[] = [];
  private win: number[] = [];
  private winT = 0;
  private goodWindows = 0;
  private upHold = 0;
  private upBackoff = 2;
  private lastUpAt = -1e9;
  private slowAtFloor = 0;
  private t = 0;
  private ladderStep = 0;
  /** last-measured stats for the overlay */
  stats = { avg: 0, p95: 0, scale: 1, target: 16.7 };
  onNotice: (msg: string) => void = () => {};

  constructor(private pipeline: Pipeline, public gpu: GpuTimer) {}

  /** call once per displayed frame with the interval since the previous one */
  frame(intervalMs: number, active: boolean) {
    if (!(intervalMs > 0) || intervalMs > 1000) return; // tab switches, breakpoints, pauses (rAF stops while hidden)
    this.gpu.poll();
    // refresh-rate estimate: a low percentile of recent intervals (frames that weren't late)
    this.intervals.push(intervalMs);
    if (this.intervals.length >= 90) {
      const s = this.intervals.slice().sort((a, b) => a - b);
      const p20 = s[Math.floor(s.length * 0.2)];
      const hz = 1000 / p20;
      const snap = [30, 48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 160, 165, 170, 180, 200, 240, 360].reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
      // only trust a snap that is close; otherwise keep the raw estimate
      const est = Math.abs(snap - hz) / snap < 0.06 ? 1000 / snap : p20;
      // the refresh interval only ever shrinks quickly (a slow phase must not read as a 30 Hz screen)
      this.refreshMs = est < this.refreshMs ? est : this.refreshMs + (est - this.refreshMs) * 0.1;
      this.intervals.length = 0;
    }
    if (!active || !Settings.data.dynamicRes) {
      this.win.length = 0;
      this.winT = 0;
      return;
    }
    this.t += intervalMs;
    this.win.push(intervalMs);
    this.winT += intervalMs;
    if (this.winT < 500) return;
    this.evaluate();
    this.win.length = 0;
    this.winT = 0;
  }

  private evaluate() {
    const p = this.pipeline;
    const target = Math.max(1000 / (Settings.data.targetFps || 60), this.refreshMs * 0.995);
    const w = this.win;
    const avg = this.winT / w.length;
    const s = w.slice().sort((a, b) => a - b);
    const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    // late frames: more than a quarter interval past the target (a missed vsync)
    let late = 0;
    for (const v of w) if (v > target * 1.25) late++;
    const lateFrac = late / w.length;
    const gpu = this.gpu.ms;
    const floor = Math.max(0.5, Math.min(1, 0.5 / Math.max(0.5, Settings.data.renderScale)));
    this.stats = { avg, p95, scale: p.dynScale, target };
    let next = p.dynScale;
    const slow = avg > target * 1.08 || lateFrac > 0.2;
    if (slow) {
      // bigger step when far off; GPU timing tells whether pixels are actually the problem
      const gpuBound = gpu < 0 || gpu > target * 0.7;
      if (gpuBound) next = Math.max(floor, p.dynScale - (avg > target * 1.5 ? 0.1 : 0.05));
      this.goodWindows = 0;
      // stepped up recently and it got slow: that level is too much — wait longer next time
      if (this.t - this.lastUpAt < 2500) this.upBackoff = Math.min(40, this.upBackoff * 2);
      this.upHold = this.upBackoff;
    } else if (avg <= target * 1.04 && lateFrac < 0.05) {
      this.goodWindows++;
      if (this.upHold > 0) this.upHold--;
      // headroom: either the GPU says so, or we are pinned at the refresh rate (probe upward)
      const headroom = gpu >= 0 ? gpu < target * 0.62 : true;
      if (p.dynScale < 1 && this.goodWindows >= 3 && this.upHold <= 0 && headroom) {
        next = Math.min(1, p.dynScale + 0.05);
        this.lastUpAt = this.t;
        this.goodWindows = 0;
      }
    }
    // hard floor reached and still slow: drop the next costliest effect (auto graphics only)
    if (slow && next <= floor + 1e-3 && Settings.data.autoQuality) {
      this.slowAtFloor += this.winT;
      if (this.slowAtFloor > 4000) {
        this.slowAtFloor = 0;
        this.dropFeature();
      }
    } else this.slowAtFloor = 0;
    if (Math.abs(next - p.dynScale) > 0.001) {
      p.dynScale = next;
      p.applyScale();
    }
  }

  private dropFeature() {
    const d = Settings.data;
    while (this.ladderStep < LADDER.length) {
      const step = LADDER[this.ladderStep++];
      if (step.key === 'shadowRes') {
        if (d.shadowRes > 1024) {
          d.shadowRes = d.shadowRes / 2;
          this.onNotice(`Lowered ${step.label} to keep the frame rate`);
          this.applied = true;
          return;
        }
        continue;
      }
      if (d[step.key]) {
        (d as any)[step.key] = false;
        this.onNotice(`Turned off ${step.label} to keep the frame rate`);
        this.applied = true;
        return;
      }
    }
  }
  /** set when dropFeature changed a setting (the game re-applies its settings and clears it) */
  applied = false;

  /** a fresh match / settings change: allow stepping up again quickly */
  reset() {
    this.upBackoff = 2;
    this.upHold = 0;
    this.goodWindows = 0;
    this.slowAtFloor = 0;
  }
}
