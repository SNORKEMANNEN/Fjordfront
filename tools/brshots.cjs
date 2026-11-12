// Update 34 map views. node tools/brshots.cjs <query> <views.json | inline JSON>
//   views: [[name, x, z, yaw, pitch, y?], ...]   (yaw 0 looks north / −z; y absolute, omitted = on the ground)
//   -> tools/shots/br_<name>.png  (no HUD, no viewmodel, player frozen in place)
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [query = '', viewsArg = '[]', js = ''] = process.argv.slice(2);
  const views = JSON.parse(fs.existsSync(viewsArg) ? fs.readFileSync(viewsArg, 'utf8') : viewsArg);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[console] ' + m.text()); });
  const t0 = Date.now();
  await p.goto('http://127.0.0.1:5173/?test&level=brosund&' + query, { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  console.log('ready in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  const info = await p.evaluate(async (js) => {
    const g = window.game;
    g.startMatch();
    g.bots.forEach((x) => { x.frozen = true; x.body && x.body.pos.set(0, -200, 0); });
    g.avatar.health = 1e9;
    g.ui.root.style.visibility = 'hidden';
    g.step(20, 1 / 60, false);
    return js ? await new Function('g', js)(g) : null;
  }, js);
  if (info) console.log(JSON.stringify(info));
  for (const [name, x, z, yaw, pitch, y] of views) {
    await p.evaluate(([x, z, yaw, pitch, y]) => {
      const g = window.game;
      g.player.frozen = true;
      g.view(x, z, yaw, pitch, y ?? undefined);
      if (g.vm && g.vm.root) g.vm.root.visible = false;
      g.vmScene.visible = false;
      g.step(40, 1 / 60, false);
      g.step(1, 1 / 60, true);
    }, [x, z, yaw, pitch, y ?? null]);
    await p.screenshot({ path: `tools/shots/br_${name}.png` });
    console.log('shot', name);
  }
  await b.close();
})();
