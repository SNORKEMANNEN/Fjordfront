// Usage: node tools/shot.cjs <name> [js...]   (each js arg is evaluated in order; returns logged)
// Page is loaded with ?test so the loop is paused; use game.step(n) inside js to advance.
const { chromium } = require('playwright');
(async () => {
  const name = process.argv[2] || 'shot';
  const scripts = process.argv.slice(3);
  const w = +(process.env.W || 960), h = +(process.env.H || 540);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const logs = [];
  p.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || process.env.LOG) logs.push(`[${t}] ${m.text()}`); });
  p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
  const t0 = Date.now();
  await p.goto('http://localhost:5173/?test&' + (process.env.Q || ''), { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const js of scripts) {
    const t1 = Date.now();
    const r = await p.evaluate(js).catch((e) => 'EVAL ERROR ' + e.message);
    console.log('eval', ((Date.now() - t1) / 1000).toFixed(1) + 's:', typeof r === 'string' ? r : JSON.stringify(r));
  }
  require('fs').mkdirSync('tools/shots', { recursive: true });
  await p.screenshot({ path: `tools/shots/${name}.png`, timeout: 120000 });
  console.log(logs.slice(0, 40).join('\n'));
  await b.close();
})();
