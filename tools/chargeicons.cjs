// Charge icons (radar, tactical map, carrier marker) and a bot planting in third person.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  const run = (f, arg) => p.evaluate(([src, arg]) => {
    const g = window.game;
    if (g.state === 'paused') { g.state = 'playing'; g.ui.showPause(false); }
    return new Function('g', 'arg', src)(g, arg);
  }, [`return (${f.toString()})(g, arg)`, arg]);
  await run((g) => {
    const V = g.player.pos.constructor;
    g.startMatch();
    const m = g.sab, s = m.sab;
    m.ui.closeBuy();
    for (const bt of g.bots) bt.busy = true;
    g.step(400, 1 / 30, false);
    s.atk = g.avatar.team;
    const mate = m.players.find((c) => c.team === g.avatar.team && c !== g.avatar && c.alive);
    window.__mate = mate;
    // foes far away
    for (const c of m.players) if (c.team !== s.atk && c.body) c.body.teleport(new V(60, g.terrain.heightAt(60, 70) + 1, 70));
    s.giveCharge(mate);
    const site = new V(-45, 0, -40.8);
    site.y = g.terrain.heightAt(site.x, site.z) + 0.1;
    mate.body.teleport(site.clone());
    mate.yaw = 0;
    g.player.teleport(site.clone().add(new V(1.2, 0, 4.2)), 0.25);
    g.player.pitch = -0.15;
    g.step(10, 1 / 30, true);
  });
  await p.screenshot({ path: 'tools/shots/ci_carrier.png' });
  // the mate plants (rules driven directly), we watch at 1.6 s
  await run((g) => {
    const m = g.sab, s = m.sab, mate = window.__mate;
    for (let i = 0; i < 48; i++) {
      s.planting = { c: mate, t: 0.4 + i * 0.033 };
      const mp = mate.position(), pp = g.player.pos;
      if (i === 40) { g.player.teleport(mp.clone().add(new mp.constructor(1.4, 0, 2.2)), Math.atan2(1.4, 2.2)); }
      g.player.yaw = Math.atan2(pp.x - mp.x, pp.z - mp.z); g.player.pitch = -0.35;
      g.step(1, 1 / 30, i === 47);
    }
  });
  await p.screenshot({ path: 'tools/shots/ci_plant3p.png' });
  await run((g) => {
    const m = g.sab, s = m.sab, mate = window.__mate;
    for (let i = 0; i < 20; i++) {
      s.planting = { c: mate, t: 2.0 + i * 0.033 };
      const mp = mate.position(), pp = g.player.pos;
      g.player.yaw = Math.atan2(pp.x - mp.x, pp.z - mp.z); g.player.pitch = -0.35;
      g.step(1, 1 / 30, i === 19);
    }
  });
  await p.screenshot({ path: 'tools/shots/ci_plant3p_b.png' });
  // reset: drop it somewhere instead, open the map
  await run((g) => {
    const m = g.sab, s = m.sab, mate = window.__mate;
    s.planting = null;
    mate.busyAct = null;
    s.dropCharge(mate);
    g.step(10, 1 / 30, true);
  });
  await p.screenshot({ path: 'tools/shots/ci_dropped.png' });
  await run((g) => { g.setMapOpen(true); g.step(6, 1 / 30, true); });
  await p.screenshot({ path: 'tools/shots/ci_map.png' });
  console.log(await run((g) => JSON.stringify(g.sab.chargeView())));
  await b.close();
})();
