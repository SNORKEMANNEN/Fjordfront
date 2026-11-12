// Update 34: the main menu on the active map. node tools/brmenu.cjs <query> <out.png>
const { chromium } = require('playwright');
(async () => {
  const [query = '', out = 'tools/shots/br_menu.png'] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://127.0.0.1:5173/?test&' + query, { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  await p.evaluate(() => window.game.step(60, 1 / 60, true));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out });
  await b.close();
})();
