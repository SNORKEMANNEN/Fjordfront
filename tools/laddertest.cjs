// Climb every ladder bottom→top, then walk back onto it from the top and climb down.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const only = process.argv[2] ? +process.argv[2] : -1;
  const res = await p.evaluate(async (only) => {
    const g = window.game;
    g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.root.visible = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    const L = g.player.constructor.LADDERS_REF || null; void L;
    const ladders = g.world.ladders ?? [];
    const out = [];
    const list = ladders.length ? ladders : [];
    for (let i = 0; i < list.length; i++) {
      if (only >= 0 && i !== only) continue;
      const l = list[i];
      const V = g.player.pos.constructor;
      const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
      // up
      g.player.teleport(new V(l.x + l.nx * 0.9, l.y0 + 0.05, l.z + l.nz * 0.9), yawTo(-l.nx, -l.nz));
      g.player.pitch = 0;
      g.step(3, 1 / 60, false);
      g.input.simulate('forward', true);
      let t = 0, grabbed = false;
      for (; t < 60 * 14; t++) { g.step(1, 1 / 60, false); if (g.player.ladder) grabbed = true; if (grabbed && !g.player.ladder && !g.player.mantle) break; }
      g.input.simulate('forward', false);
      g.step(20, 1 / 60, false);
      const top = g.player.pos.clone();
      const upOk = grabbed && Math.hypot(top.x - l.exit[0], top.z - l.exit[2]) < 1.2 && Math.abs(top.y - l.exit[1]) < 0.6;
      // down: face the ladder side from the top and walk over the edge
      g.player.yaw = yawTo(l.nx, l.nz);
      g.input.simulate('forward', true);
      let g2 = false;
      for (let f = 0; f < 60 * 3; f++) { g.step(1, 1 / 60, false); if (g.player.ladder) { g2 = true; break; } }
      // keep holding W (latched = down) until the bottom
      let f2 = 0;
      for (; f2 < 60 * 14 && (g.player.ladder || g.player.mantle); f2++) g.step(1, 1 / 60, false);
      g.input.simulate('forward', false);
      g.step(30, 1 / 60, false);
      const bot = g.player.pos.clone();
      const downOk = g2 && bot.y < l.y0 + 0.8 && g.avatar.health > 0;
      out.push({ i, at: [+l.x.toFixed(1), +l.z.toFixed(1)], upOk, upT: +(t / 60).toFixed(1), top: top.toArray().map((v) => +v.toFixed(2)), exit: l.exit.map((v) => +v.toFixed(2)), downOk, downT: +(f2 / 60).toFixed(1), bot: bot.toArray().map((v) => +v.toFixed(2)), hp: g.avatar.health });
      g.avatar.health = 100;
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }, only);
  for (const r of res) console.log(JSON.stringify(r));
  await b.close();
})();
