// node tools/frametime.cjs  (PORT=5173 default) -> load timings, first-frame hitches, sim + render frame-time distribution
const { chromium } = require('playwright');
(async () => {
  const port = process.env.PORT || 5173;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${port}/?test&weather=clear&time=day&${process.env.Q || 'quality=medium'}`, { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 100 });
  const ready = Date.now() - t0;
  const r = await p.evaluate(() => {
    const g = window.game;
    const stats = (a) => { const s = a.slice().sort((x, y) => x - y); const q = (k) => s[Math.min(s.length - 1, Math.floor(s.length * k))]; const mean = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length); return { mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2), sd: +sd.toFixed(2) }; };
    let t = performance.now(); g.renderer.getContext().finish(); const drain = performance.now() - t;
    t = performance.now(); g.step(1, 1 / 60, true); g.renderer.getContext().finish(); const firstMenu = performance.now() - t;
    t = performance.now(); g.startMatch(); g.step(1, 1 / 60, true); g.renderer.getContext().finish(); const firstMatch = performance.now() - t;
    // warm-up
    g.step(60, 1 / 60, false);
    const sim = [];
    for (let i = 0; i < 1200; i++) { const a = performance.now(); g.step(1, 1 / 60, false); sim.push(performance.now() - a); }
    const ren = [];
    for (let i = 0; i < 90; i++) { g.step(3, 1 / 60, false); const a = performance.now(); g.renderFrame(1 / 60); g.renderer.getContext().finish(); ren.push(performance.now() - a); }
    return { gpuDrain: Math.round(drain), firstMenu: Math.round(firstMenu), firstMatch: Math.round(firstMatch), sim: stats(sim), render: stats(ren), programs: g.renderer.info.programs.length, calls: g.renderer.info.render.calls };
  });
  console.log(JSON.stringify({ port, readyMs: ready, ...r }, null, 0));
  await b.close();
})();
