// Walk from A to B (world coords) and print a trace + what blocks the player.
// usage: node tools/walkpath.cjs '[[x,y,z],[x,y,z]]' ...
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  p.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const paths = process.argv.slice(2).map((a) => JSON.parse(a));
  const res = await p.evaluate((paths) => {
    const g = window.game; g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    const V = g.player.pos.constructor;
    const out = [];
    for (const [a, c] of paths) {
      const to = new V(...c);
      g.player.teleport(new V(a[0], a[1] + 0.15, a[2]), 0);
      g.input.simulate('forward', true);
      const tr = [];
      for (let f = 0; f < 900; f++) {
        const pp = g.player.pos; g.player.yaw = Math.atan2(-(to.x - pp.x), -(to.z - pp.z)); g.step(1, 1 / 60, false);
        if (f % 30 === 0) tr.push(pp.toArray().map((v) => +v.toFixed(2)).join(','));
        if (Math.hypot(to.x - pp.x, to.z - pp.z) < 0.8) break;
      }
      g.input.simulate('forward', false);
      const pp = g.player.pos.clone();
      const dir = new V(to.x - pp.x, 0, to.z - pp.z).normalize();
      const hits = [];
      for (const hh of [0.05, 0.2, 0.4, 0.8, 1.4]) {
        const h = g.physics.raycast(new V(pp.x, pp.y + hh, pp.z), dir, 1.5);
        if (h) { const t = h.collider.translation(); hits.push(`${hh}:${h.info.surface}/${h.info.tag || ''} d${h.distance.toFixed(2)} ctr${[t.x, t.y, t.z].map((v) => v.toFixed(1))} n${[h.normal.x, h.normal.y, h.normal.z].map((v) => v.toFixed(2))}`); }
      }
      out.push({ end: pp.toArray().map((v) => +v.toFixed(2)), grounded: g.player.body.grounded, tr: tr.join(' | '), hits });
    }
    return out;
  }, paths);
  for (const r of res) console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
