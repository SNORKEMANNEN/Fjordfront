// Sabotasje HUD screenshots: node tools/sabshots.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  await p.evaluate(() => {
    const g = window.game;
    g.startMatch();
    g.step(60, 1 / 30, false);
    g.step(1, 1 / 30, true);
  });
  await p.screenshot({ path: 'tools/shots/sab_buy.png' });
  console.log('buy');
  await p.evaluate(() => {
    const g = window.game;
    g.sab.ui.closeBuy();
    g.step(330, 1 / 30, false);
    g.step(1, 1 / 30, true);
  });
  await p.screenshot({ path: 'tools/shots/sab_live.png' });
  console.log('live');
  // run to a plant if possible, then look at it
  const info = await p.evaluate(() => {
    const g = window.game;
    const sab = g.sab.sab;
    g.avatar.health = 1e9;
    for (let i = 0; i < 30 * 160 && sab.phase !== 'planted'; i++) g.step(1, 1 / 30, false);
    if (sab.phase === 'planted') {
      const c = sab.charge.pos;
      g.player.frozen = true;
      g.view(c.x + 4, c.z + 4, Math.atan2(4, 4), -0.35);
      g.step(20, 1 / 30, false);
      g.step(1, 1 / 30, true);
    }
    return { phase: sab.phase, site: sab.charge.site, round: sab.round };
  });
  console.log(JSON.stringify(info));
  await p.screenshot({ path: 'tools/shots/sab_planted.png' });
  await b.close();
})();
