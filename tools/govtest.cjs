// live rAF loop: governor steps the internal resolution, canvas never resizes, no errors
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 800, height: 450 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('[error] ' + m.text().slice(0, 200)); });
  await p.goto('http://127.0.0.1:5173/?quality=medium&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 200 });
  const r = await p.evaluate(async () => {
    const g = window.game;
    const cw0 = g.canvas.width, ch0 = g.canvas.height;
    let resizes = 0;
    new MutationObserver(() => resizes++).observe(g.canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    g.startMatch();
    g.perf.visible = true;
    const log = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      log.push(`t=${(i + 1) * 2.5}s fps=${g.fps.toFixed(1)} scale=${g.pipeline.dynScale.toFixed(2)} rt=${g.pipeline.rw}x${g.pipeline.rh} refresh=${(1000 / g.governor.refreshMs).toFixed(0)}Hz target=${g.governor.stats.target.toFixed(1)} ao=${window.Settings.data.ao}`);
    }
    return { canvas: `${cw0}x${ch0} -> ${g.canvas.width}x${g.canvas.height}`, canvasResizes: resizes, log, overlay: g.perf.el.innerText };
  });
  console.log(JSON.stringify(r, null, 1));
  console.log(errs.slice(0, 10).join('\n') || 'no errors');
  await b.close();
})();
