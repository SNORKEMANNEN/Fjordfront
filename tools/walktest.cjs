// Walk the player through every doorway link and report which ones fail.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const res = await p.evaluate(() => {
    const g = window.game;
    g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.root.visible = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    const out = [];
    const links = g.world.buildings.nav;
    links.forEach((l, i) => {
      for (const [from, to, dir] of [[l.a, l.b, 'in'], [l.b, l.a, 'out']]) {
        const V = from.constructor;
        const d = new V().subVectors(to, from);
        const yaw = Math.atan2(-d.x, -d.z);
        g.player.teleport(new V(from.x, from.y + 0.15, from.z), yaw);
        g.player.pitch = 0;
        const flat = Math.hypot(d.x, d.z);
        let best = 1e9;
        g.input.simulate('forward', true);
        for (let f = 0; f < 60 * Math.max(3, flat / 1.8); f++) {
          // steer toward target
          const pp = g.player.pos;
          g.player.yaw = Math.atan2(-(to.x - pp.x), -(to.z - pp.z));
          g.step(1, 1 / 60, false);
          const dist = Math.hypot(to.x - pp.x, to.z - pp.z) + Math.abs(to.y - pp.y) * 0.5;
          best = Math.min(best, dist);
          if (dist < 0.9) break;
        }
        g.input.simulate('forward', false);
        g.step(2, 1 / 60, false);
        if (best > 1.2) out.push({ i, dir, from: from.toArray().map((v) => +v.toFixed(1)), to: to.toArray().map((v) => +v.toFixed(1)), best: +best.toFixed(2), at: g.player.pos.toArray().map((v) => +v.toFixed(1)) });
      }
    });
    return { total: links.length, fails: out };
  });
  console.log(JSON.stringify(res, null, 0));
  await b.close();
})();
