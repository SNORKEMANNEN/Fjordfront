// Simulate a bot match and measure spawn safety (nearest enemy, LOS at spawn).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game; g.startMatch();
    const m = g.match; const orig = m.pickSpawn.bind(m); const log = [];
    m.pickSpawn = (team) => {
      const s = orig(team);
      const en = m.players.filter((q) => q.alive && q.team !== team);
      let minE = 1e9, seen = 0;
      const head = s.pos.clone(); head.y += 1.6;
      for (const e of en) { minE = Math.min(minE, e.position().distanceTo(s.pos)); if (g.physics.lineOfSight(e.eye(), head)) seen++; }
      log.push({ team, t: +g.time.toFixed(1), p: s.pos.toArray().map((v) => Math.round(v)), minE: Math.round(minE), seen, why: m.spawns.lastPick?.reason });
      return s;
    };
    g.player.dead = true; g.avatar.alive = false; // spectate: bots only
    const t0 = performance.now();
    for (let i = 0; i < 160; i++) g.step(30, 1 / 30, false);
    return { log, ms: performance.now() - t0, scores: m.scores };
  });
  const L = r.log;
  console.log('spawns', L.length, 'sim ms', Math.round(r.ms), 'scores', r.scores);
  console.log('seen at spawn', L.filter((s) => s.seen).length, 'minE<30', L.filter((s) => s.minE < 30).length, 'median minE', L.map((s) => s.minE).sort((a, b) => a - b)[L.length >> 1]);
  for (const s of L.slice(0, 40)) console.log(JSON.stringify(s));
  await b.close();
})();
