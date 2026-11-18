const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('console', (m) => { if (m.text().startsWith('PAUSE')) console.log(m.text()); });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  await p.evaluate(() => { const g = window.game; const pg = g.pauseGame.bind(g); g.pauseGame = () => { console.log('PAUSE ' + new Error().stack.split('\n').slice(1,5).join(' | ') + ' locked=' + g.input.locked + ' buyOpen=' + g.sab?.ui.buyOpen); pg(); }; g.startMatch(); });
  for (let k = 0; k < 3; k++) {
    const r = await p.evaluate(() => {
      const g = window.game;
      for (let i = 0; i < 3000; i++) g.step(1, 1 / 30, false);
      g.step(1, 1 / 30, true);
      return { st: g.state, mph: g.match.phase, tm: Math.round(g.sab.sab.timer), heap: Math.round(performance.memory.usedJSHeapSize / 1e6), scene: g.scene.children.length, geo: g.renderer.info.memory.geometries, round: g.sab.sab.round, ph: g.sab.sab.phase };
    });
    console.log(JSON.stringify(r));
  }
  await b.close();
})();
