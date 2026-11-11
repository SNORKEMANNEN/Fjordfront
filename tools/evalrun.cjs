// node tools/evalrun.cjs 'js1' 'js2' ...  -> runs each in the page (?test&quality=low), prints results, no screenshot
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[error] ' + m.text().slice(0, 300)); });
  await p.goto('http://127.0.0.1:5173/?test&' + (process.env.Q || 'quality=low') + '&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  for (const js of process.argv.slice(2)) {
    const t = Date.now();
    const r = await p.evaluate(js).catch((e) => 'EVAL ERROR ' + e.message);
    console.log(`[${((Date.now() - t) / 1000).toFixed(1)}s]`, typeof r === 'string' ? r : JSON.stringify(r));
  }
  await b.close();
})();
