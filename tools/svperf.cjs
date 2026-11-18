// draw calls / triangles / sim time: node tools/svperf.cjs <level>
const { chromium } = require('playwright');
(async () => {
  const level = process.argv[2] || 'solvik';
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  const t0 = Date.now();
  await p.goto('http://127.0.0.1:5173/?test&level=' + level, { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  console.log('ready', ((Date.now() - t0) / 1000).toFixed(0), 's');
  const r = await p.evaluate(() => {
    const g = window.game;
    g.startMatch();
    if (g.sab) g.sab.ui.closeBuy();
    g.step(30, 1 / 30, false);
    const views = [[0, 62, 0], [0, 30, 0], [-57, 20, 0], [40, -20, -0.8], [-40, -30, 0.7]];
    const out = [];
    for (const [x, z, yaw] of views) {
      g.view(x, z, yaw, 0);
      g.step(5, 1 / 30, true);
      const i = g.renderer.info.render;
      out.push(`(${x},${z}) calls=${i.calls} tris=${Math.round(i.triangles / 1000)}k`);
    }
    // simulation cost without rendering
    const s0 = performance.now();
    g.step(300, 1 / 30, false);
    const sim = (performance.now() - s0) / 300;
    return { out, sim: sim.toFixed(2), geo: g.renderer.info.memory.geometries, tex: g.renderer.info.memory.textures };
  });
  console.log(r.out.join('\n'));
  console.log('sim ms/frame', r.sim, 'geometries', r.geo, 'textures', r.tex);
  await b.close();
})();
