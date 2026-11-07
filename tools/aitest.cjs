// Bot behaviour metrics over a simulated match + opening spawn variety across matches.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game;
    const openings = [];
    for (let m = 0; m < 4; m++) {
      g.startMatch();
      const h = g.match.spawns.homes();
      const t0 = g.bots.filter((x) => x.team === 0).map((x) => x.position()), t1 = g.bots.filter((x) => x.team === 1).map((x) => x.position());
      const spread = (ps) => { let s = 0, n = 0; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) { s += ps[i].distanceTo(ps[j]); n++; } return Math.round(s / Math.max(1, n)); };
      openings.push(`homes ${h.map((v) => `(${v.x.toFixed(0)},${v.z.toFixed(0)})`).join(' vs ')} dist ${Math.round(h[0].distanceTo(h[1]))} squadSpread ${spread(t0)}/${spread(t1)}`);
    }
    // simulate and measure
    g.player.dead = true; g.avatar.alive = false;
    const navIndoor = (pos) => { const n = g.nav.nearest(pos, 3, false); return n ? n.indoor : false; };
    const inside = (pos) => g.world.buildings.footprints.some((f) => pos.x > f.min.x && pos.x < f.max.x && pos.z > f.min.z && pos.z < f.max.z) && g.physics.raycast(pos.clone().setY(pos.y + 1.2), new pos.constructor(0, 1, 0), 8) !== null;
    let samples = 0, indoorS = 0, nnSum = 0, nnN = 0; const kinds = {}; const visited = new Set();
    for (let i = 0; i < 240; i++) {
      g.step(15, 1 / 30, false);
      for (const bt of g.bots) {
        if (!bt.alive) continue;
        samples++;
        const pos = bt.position();
        if (inside(pos)) { indoorS++; visited.add(`${Math.round(pos.x / 15)},${Math.round(pos.z / 15)}`); }
        const k = g.director.kindOf(bt.id); if (k) kinds[k] = (kinds[k] || 0) + 1;
        let nn = 1e9; for (const o of g.bots) if (o !== bt && o.alive && o.team === bt.team) nn = Math.min(nn, o.position().distanceTo(pos));
        if (nn < 1e8) { nnSum += nn; nnN++; }
      }
    }
    return { openings, rooms: g.director.roomCount, indoorPct: +(100 * indoorS / samples).toFixed(1), buildingsEntered: visited.size, avgNearestMate: +(nnSum / nnN).toFixed(1), missionMix: kinds, scores: g.match.scores };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
