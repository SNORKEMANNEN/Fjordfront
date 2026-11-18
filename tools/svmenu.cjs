const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik&time=golden&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  await p.evaluate(() => { const g = window.game; g.env.hour = 15.1; g.env.applyLighting(true); g.toMenu(); for (let i = 0; i < 60; i++) g.frame(performance.now() + i * 16); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/home/user/fjordfront/tools/shots/sv_menu.png' });
  await b.close();
})();
