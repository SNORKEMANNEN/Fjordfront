// node tools/loadtime.cjs [query]  -> boot phase timings (ms since boot start) + navigation timing
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
  const runs = Number(process.env.RUNS || 1);
  for (let run = 0; run < runs; run++) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[' + m.type() + '] ' + m.text().slice(0, 200)); });
  if (runs > 1) console.log('--- run ' + (run + 1));
  const t0 = Date.now();
  await p.goto('http://127.0.0.1:' + (process.env.PORT || 5173) + '/?' + (process.argv[2] || 'quality=high&weather=clear'), { timeout: 180000 });
  const tNav = Date.now() - t0;
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 100 });
  const r = await p.evaluate(() => ({ log: window.__bootLog, nav: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart, extra: window.__bootExtra }));
  console.log('goto', tNav, 'ms; DOMContentLoaded', r.nav, 'ms; total wall', Date.now() - t0, 'ms');
  let prev = 0;
  for (const [s, t] of r.log) { console.log(String(t).padStart(6), '+' + String(t - prev).padStart(5), s); prev = t; }
  if (r.extra) console.log(JSON.stringify(r.extra));
  await p.close();
  }
  await b.close();
})();
