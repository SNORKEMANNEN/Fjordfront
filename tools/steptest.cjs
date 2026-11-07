const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const res = await p.evaluate(() => {
    const g = window.game; g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    const V = g.camera.position.constructor;
    const out = [];
    for (const hgt of [0.1, 0.2, 0.3, 0.4]) {
      const x = 20 + hgt * 40, z = 170;
      const gy = g.terrain.heightAt(x, z);
      g.physics.addBox(new V(x, gy + hgt / 2 - 0.5, z - 3), new V(1, hgt / 2 + 0.5, 0.5), null, { surface: 'concrete' });
      g.physics.step();
      g.player.teleport(new V(x, gy + 0.05, z), 0);
      g.input.simulate('forward', true);
      let maxY = 0;
      for (let f = 0; f < 120; f++) { g.player.yaw = 0; g.step(1, 1 / 60, false); maxY = Math.max(maxY, g.player.pos.y - gy); }
      g.input.simulate('forward', false);
      out.push(`step ${hgt}: z=${g.player.pos.z.toFixed(2)} climbed=${maxY.toFixed(2)}`);
    }
    return out.join(' | ');
  });
  console.log(res);
  await b.close();
})();
