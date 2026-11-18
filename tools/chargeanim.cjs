// First-person plant / defuse / wire-cut animation frames: node tools/chargeanim.cjs [plant|defuse|cut]
const { chromium } = require('playwright');
(async () => {
  const which = process.argv[2] || 'plant';
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('GL Driver')) console.log('[err] ' + m.text().slice(0, 200)); });
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  await p.evaluate((which) => {
    const g = window.game;
    const V = g.player.pos.constructor;
    g.startMatch();
    const m = g.sab, s = m.sab;
    m.ui.closeBuy();
    for (const bt of g.bots) bt.busy = true;
    g.step(400, 1 / 30, false); // past the buy phase
    const site = new V(-45, 0, -40.8);
    site.y = g.terrain.heightAt(site.x, site.z) + 0.1;
    if (which === 'plant') {
      s.atk = g.avatar.team;
      s.giveCharge(g.avatar);
      g.player.teleport(site, 0);
      g.step(4, 1 / 30, false);
    } else {
      // a planted charge in front of a defending player
      s.atk = 1 - g.avatar.team;
      const planter = m.players.find((c) => c.team === s.atk && c.alive);
      planter.body.teleport(site.clone());
      s.giveCharge(planter);
      for (let i = 0; i < 120 && s.phase !== 'planted'; i++) { s.use(planter, true, 1 / 30, false); }
      planter.body.teleport(site.clone().add(new V(20, 0, 0)));
      for (const c of m.players) if (c.team === s.atk && c.body) c.body.teleport(new V(60, g.terrain.heightAt(60, 70) + 1, 70));
      g.player.teleport(site.clone().add(new V(0, 0, 0.9)), 0);
      g.step(4, 1 / 30, false);
    }
    window.__hold = (on) => g.input.simulate('spot', on);
  }, which);
  const shots = which === 'plant' ? [0.15, 0.4, 0.75, 1.3, 1.9, 2.5, 2.8, 3.05, 3.4, 3.8] : which === 'defuse' ? [0.3, 0.9, 2.0, 3.2, 4.5, 6.0, 8.0, 9.4, 10.2, 10.8] : [0.5, 1.5, 1.75, 1.9, 2.0, 2.1, 2.2, 2.4, 2.8];
  await p.evaluate(() => window.__hold(true));
  p.on('console', (m) => { if (m.text().startsWith('dbg')) console.log(m.text()); });
  let t = 0;
  for (const at of shots) {
    const n = Math.max(1, Math.round((at - t) * 30));
    const info = await p.evaluate(([n, which, at, mode]) => {
      const g = window.game;
      if (g.state === 'paused') { g.state = 'playing'; g.ui.showPause(false); }
      if (which === 'cut' && at >= 1.75 && !window.__cut) { window.__cut = 1; g.sab.wireKey((mode === 'right' ? g.sab.sab.charge.wire : (g.sab.sab.charge.wire === 0 ? 1 : 0))); console.log('dbg cut ' + JSON.stringify(g.sab.vmAct && g.sab.vmAct.data.cut) + ' df ' + (g.sab.sab.defusing && g.sab.sab.defusing.t) + ' same ' + (g.vm.action && g.vm.action.data === (g.sab.vmAct && g.sab.vmAct.data)) + ' wireT ' + g.sab.wireT); }
      g.step(n - 1, 1 / 30, false);
      g.step(1, 1 / 30, true);
      const a = g.vm.action;
      const s = g.sab.sab;
      return `${a ? a.type + ' t=' + a.t.toFixed(3) : 'no action'} phase=${s.phase} pl=${s.planting ? s.planting.t.toFixed(2) : '-'} df=${s.defusing ? s.defusing.t.toFixed(2) : '-'} pitch=${g.player.pitch.toFixed(2)}`;
    }, [n, which, at, process.argv[3] || '']);
    t = at;
    console.log(at.toFixed(2), info);
    await p.screenshot({ path: `tools/shots/ch_${which}_${String(Math.round(at * 100)).padStart(4, '0')}.png` });
  }
  await b.close();
})();
