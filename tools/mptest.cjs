// Two-tab multiplayer test: a host and a client on a local PeerJS broker (127.0.0.1:9000).
const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 } });
  const open = async (tag) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
    p.on('console', (m) => { if (m.type() === 'error' || /\[net\]/.test(m.text())) console.log(`[${tag} ${m.type()}] ${m.text().slice(0, 300)}`); });
    await p.goto('http://127.0.0.1:5173/?test&weather=clear&peer=127.0.0.1:9000', { timeout: 180000 });
    await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
    return p;
  };
  const H = await open('host');
  const C = await open('client');
  const code = await H.evaluate(async () => { game.netg.name = 'Hosty'; const c = await game.netg.host(); game.startMatch(); return c; });
  console.log('room', code);
  await C.evaluate(async (code) => { game.netg.name = 'Clienty'; await game.netg.join(code); }, code);
  // run both sims for a while (messages arrive between steps)
  const run = async (n) => { for (let i = 0; i < n; i++) { await H.evaluate(() => game.step(3, 1 / 60, false)); await C.evaluate(() => game.step(3, 1 / 60, false)); await wait(5); } };
  await run(40);
  const r1 = await C.evaluate(() => ({ state: game.state, slot: game.netg.mySlot, team: game.avatar.team, humans: game.netg.roster.filter((s) => s.human).map((s) => s.name + '@' + s.slot), visibleBots: game.bots.filter((b) => b.root.visible).length, flags: game.dom.flags.map((f) => f.name).join(','), time: Math.round(game.match.timeLeft) }));
  const h1 = await H.evaluate(() => ({ flags: game.dom.flags.map((f) => f.name).join(','), time: Math.round(game.match.timeLeft), humans: game.netg.roster.filter((s) => s.human).map((s) => s.name + '@' + s.slot) }));
  console.log('client', JSON.stringify(r1));
  console.log('host  ', JSON.stringify(h1));
  // pose sync: where does the host see the client, vs where the client is
  const cp = await C.evaluate(() => game.player.pos.toArray().map((v) => +v.toFixed(1)));
  const seen = await H.evaluate((slot) => { const b = game.bots.find((x) => x.id === slot); return { pos: b.position().toArray().map((v) => +v.toFixed(1)), alive: b.alive, vis: b.root.visible, puppet: b.netPuppet, name: b.name }; }, r1.slot);
  console.log('client at', JSON.stringify(cp), ' host sees', JSON.stringify(seen));
  // bot pose sync: compare a host bot and the client's puppet of it
  const hb = await H.evaluate(() => game.bots.filter((b) => !b.netPuppet && b.alive).slice(0, 3).map((b) => [b.id, ...b.position().toArray().map((v) => +v.toFixed(1))]));
  const cb = await C.evaluate((ids) => ids.map((id) => { const b = game.bots.find((x) => x.id === id[0]); return b ? [b.id, ...b.position().toArray().map((v) => +v.toFixed(1)), b.alive] : null; }), hb);
  console.log('host bots', JSON.stringify(hb), '\nclient sees', JSON.stringify(cb));
  // chat both ways
  await C.evaluate(() => game.netg.submit('hello from client'));
  await H.evaluate(() => game.netg.submit('hi from host'));
  await run(5);
  const chatH = await H.evaluate(() => [...document.querySelectorAll('.netchat .lines div')].map((d) => d.textContent).slice(-3));
  const chatC = await C.evaluate(() => [...document.querySelectorAll('.netchat .lines div')].map((d) => d.textContent).slice(-3));
  console.log('host chat', JSON.stringify(chatH), '\nclient chat', JSON.stringify(chatC));
  // the client kills an enemy bot: stand right next to it, aim at its chest, fire
  const target = await C.evaluate(() => { const me = game.avatar.team; const b = game.bots.find((x) => x.alive && x.team !== me && !x.netHuman); return b ? b.id : -1; });
  let killedOnHost = false;
  for (let tries = 0; tries < 40 && !killedOnHost; tries++) {
    const tp = await H.evaluate((id) => { const b = game.bots.find((x) => x.id === id); if (!b.alive) return null; b.hold?.(b.position().clone(), 0, 0.5); return b.chest(b.position().clone()).toArray(); }, target);
    if (!tp) { killedOnHost = true; break; }
    await C.evaluate(([x, y, z]) => {
      const V = game.player.pos.constructor;
      const at = new V(x, y, z);
      const from = at.clone().add(new V(0, 0, 3));
      game.player.teleport(new V(from.x, game.terrain.heightAt(from.x, from.z) + 0.1, from.z), 0);
      const eye = game.player.eyePosition(new V());
      const d = at.clone().sub(eye);
      game.player.yaw = Math.atan2(-d.x, -d.z);
      game.player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      game.input.simulate('fire', true);
    }, tp);
    await run(4);
    await C.evaluate(() => game.input.simulate('fire', false));
    await run(2);
  }
  const kill = await H.evaluate((id) => { const b = game.bots.find((x) => x.id === id); return { alive: b.alive, feed: game.match.feed.slice(0, 2).map((f) => `${f.killer}>${f.victim} ${f.weapon}`) }; }, target);
  const killC = await C.evaluate((id) => ({ alive: game.bots.find((x) => x.id === id).alive, kills: game.avatar.kills, feed: game.match.feed.slice(0, 2).map((f) => `${f.killer}>${f.victim} ${f.weapon}`) }), target);
  console.log('client shot bot', target, 'host:', JSON.stringify(kill), 'client:', JSON.stringify(killC));
  // host bots shoot the client: put the client in front of an enemy squad and wait
  await C.evaluate(() => { game.avatar.health = 100; });
  let hurt = false, died = false;
  for (let i = 0; i < 60 && !died; i++) {
    const ep = await H.evaluate((slot) => { const me = game.bots.find((x) => x.id === slot); const e = game.bots.filter((x) => x.alive && !x.netPuppet && x.team !== me.team)[0]; return e ? e.position().toArray() : null; }, r1.slot);
    if (ep && i % 10 === 0) await C.evaluate(([x, y, z]) => { const V = game.player.pos.constructor; game.player.teleport(new V(x + 6, game.terrain.heightAt(x + 6, z) + 0.1, z), Math.PI / 2); }, ep);
    await run(3);
    const st = await C.evaluate(() => ({ hp: Math.round(game.avatar.health), alive: game.avatar.alive }));
    if (st.hp < 100) hurt = true;
    if (!st.alive) died = true;
  }
  const deathH = await H.evaluate(() => game.match.feed.slice(0, 3).map((f) => `${f.killer}>${f.victim}`));
  console.log('client hurt by bots:', hurt, 'died:', died, 'host feed', JSON.stringify(deathH));
  // commands
  await H.evaluate(() => game.netg.submit('/bots 6'));
  await run(10);
  const bc = await C.evaluate(() => ({ status: document.querySelector('.netstatus').textContent, enabled: game.netg.roster.filter((s) => !s.human && !s.disabled).length }));
  console.log('/bots 6 ->', JSON.stringify(bc));
  await C.evaluate(() => game.netg.submit('/team'));
  await run(10);
  const tm = await C.evaluate(() => ({ team: game.avatar.team, slot: game.netg.mySlot }));
  console.log('/team ->', JSON.stringify(tm), 'was', r1.team);
  const stats = await H.evaluate(() => ({ up: Math.round(game.netg.net.stats.up), conns: game.netg.net.conns.size }));
  console.log('host upload B/s', JSON.stringify(stats));
  await b.close();
})();
