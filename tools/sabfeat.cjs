// Sabotasje features: firebomb burst + burn, gun drop + pickup, plant + wire pick, defuse by wire cut.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  const out = await p.evaluate(() => {
    const g = window.game;
    const V = g.player.pos.constructor;
    g.startMatch();
    const m = g.sab, s = m.sab;
    const log = [];
    // freeze the bots out of the way
    for (const b of g.bots) { b.busy = true; }
    s.atk = g.avatar.team;
    // ---- firebomb: buy one, throw at a bot's feet
    s.seat(g.avatar).money = 9000;
    log.push('buy fire: ' + (m.ui.onBuy('fire') || 'ok') + ', k416: ' + (m.ui.onBuy('k416') || 'ok') + ', vest: ' + (m.ui.onBuy('vesthelm') || 'ok'));
    log.push('kit ' + JSON.stringify(s.seat(g.avatar).kit) + ' lethal=' + g.loadout.lethal + ' frags=' + g.frags + ' weapons=' + g.weapons.slots.map((x) => x.def.id).join('/'));
    g.step(400, 1 / 30, false); // past the buy phase
    const foe = m.players.find((c) => c.team !== g.avatar.team && c.alive);
    const fp = foe.position().clone();
    const hp0 = foe.health;
    g.explosives.throw(g.avatar, fp.clone().add(new V(0, 3, 0)), new V(0, -6, 0), 2.6, 'molotov');
    for (let i = 0; i < 60; i++) { foe.body && foe.body.teleport(fp); g.step(1, 1 / 30, false); }
    log.push('fires=' + m.fireSpots().length + ' foe hp ' + Math.round(hp0) + ' -> ' + Math.round(foe.health) + ' alive=' + foe.alive);
    // ---- drop + pickup
    const before = s.seat(g.avatar).kit.primary;
    g.input.simulate && g.input.simulate('drop', true);
    m.playerDrop ? m.playerDrop() : null;
    log.push('dropped ' + before + ' -> kit ' + s.seat(g.avatar).kit.primary + ' ground=' + m.groundGuns().length);
    for (let i = 0; i < 40; i++) g.step(1, 1 / 30, false);
    const d = m.groundGuns()[0];
    if (d) {
      g.player.teleport(d.pos.clone(), 0);
      for (let i = 0; i < 20; i++) g.step(1, 1 / 30, false);
    }
    log.push('after walking over: kit ' + s.seat(g.avatar).kit.primary + ' ground=' + m.groundGuns().length);
    // ---- plant at A (give the player the charge)
    s.giveCharge(g.avatar);
    const site = new V(-45, 0, -40.8);
    site.y = g.terrain.heightAt(site.x, site.z) + 0.1;
    g.player.teleport(site, 0);
    for (let i = 0; i < 4; i++) g.step(1, 1 / 30, false);
    g.input.simulate('spot', true);
    for (let i = 0; i < 120 && s.phase !== 'planted'; i++) g.step(1, 1 / 30, false);
    g.input.simulate('spot', false);
    log.push('plant: phase=' + s.phase + ' site=' + s.charge.site + ' wireT>0=' + (m.wireT > 0));
    m.wireKey && m.wireKey(1);
    log.push('live wire=' + s.charge.wire);
    // ---- a defender bot cuts a wrong wire / right wire
    const def = m.players.find((c) => c.team !== s.atk && c.alive && c !== g.avatar);
    if (def && s.phase === 'planted') {
      def.body.teleport(s.charge.pos.clone());
      for (let i = 0; i < 50; i++) { s.use(def, true, 1 / 30, false); }
      const wrong = [0, 1, 2].find((w) => w !== s.charge.wire);
      const right = s.charge.wire;
      log.push('defusing t=' + (s.defusing ? s.defusing.t.toFixed(2) : '-'));
      s.cut(def, right);
      log.push('cut right wire: charge=' + s.charge.state + ' phase=' + s.phase + ' last=' + (s.last && s.last.reason));
      void wrong;
    }
    return log;
  });
  console.log(out.join('\n'));
  await p.screenshot({ path: 'tools/shots/sab_feat.png' });
  await b.close();
})();
