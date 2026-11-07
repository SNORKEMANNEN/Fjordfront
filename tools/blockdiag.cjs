const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const idx = JSON.parse(process.argv[2]);
  const res = await p.evaluate((idx) => {
    const g = window.game; g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    const out = [];
    for (const i of idx) {
      const l = g.world.buildings.nav[i]; const from = l.a, to = l.b; const V = from.constructor;
      g.player.teleport(new V(from.x, from.y + 0.15, from.z), 0);
      g.input.simulate('forward', true);
      for (let f = 0; f < 180; f++) { const pp = g.player.pos; g.player.yaw = Math.atan2(-(to.x - pp.x), -(to.z - pp.z)); g.step(1, 1/60, false); }
      g.input.simulate('forward', false);
      const pp = g.player.pos.clone();
      const dir = new V(to.x - pp.x, 0, to.z - pp.z).normalize();
      const hits = [];
      for (const hh of [0.1, 0.3, 0.6, 1.0, 1.6]) {
        const h = g.physics.raycast(new V(pp.x, pp.y + hh, pp.z), dir, 2);
        if (h) { const c = h.collider; const t = c.translation(); const sh = c.shape; hits.push(`${hh}:${h.info.surface}/${h.info.tag||''} d${h.distance.toFixed(2)} top${(t.y + (sh.halfExtents ? sh.halfExtents.y : 0)).toFixed(2)} ctr${[t.x,t.y,t.z].map(v=>v.toFixed(1))}`); }
      }
      const down = g.physics.raycast(new V(pp.x, pp.y + 0.5, pp.z), new V(0, -1, 0), 3);
      out.push({ i, at: pp.toArray().map(v=>+v.toFixed(2)), ground: down ? down.point.y.toFixed(2) + ' ' + down.info.surface : 'none', stance: g.player.stance, hits });
    }
    return out;
  }, idx);
  for (const r of res) console.log(JSON.stringify(r));
  await b.close();
})();
