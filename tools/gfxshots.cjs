// Update 33 visual checks. node tools/gfxshots.cjs <name> <query> [js]
//   name  -> tools/shots/gfx_<name>.png
//   query -> extra URL params (e.g. "time=night&weather=clear")
//   js    -> evaluated with g = window.game after the match starts (set up the view)
const { chromium } = require('playwright');
(async () => {
  const [name, query = '', js = ''] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&' + query, { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(async (js) => {
    const g = window.game;
    g.startMatch();
    g.bots.forEach((x) => { x.frozen = true; });
    g.avatar.health = 1e9;
    g.ui.root.style.visibility = 'hidden';
    g.step(30, 1 / 60, false);
    const out = js ? await new Function('g', js)(g) : null;
    g.step(2, 1 / 60, true);
    return out;
  }, js);
  if (r !== null && r !== undefined) console.log(JSON.stringify(r));
  await p.screenshot({ path: `tools/shots/gfx_${name}.png` });
  await b.close();
})();
