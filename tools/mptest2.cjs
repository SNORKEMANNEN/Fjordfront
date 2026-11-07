// Three tabs: host + two clients. PvP hits in every direction, grenade, restart, host leaving.
const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 } });
  const open = async (tag) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag} error] ${m.text().slice(0, 300)}`); });
    await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day&peer=127.0.0.1:9000', { timeout: 180000 });
    await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
    return p;
  };
  const H = await open('host'), A = await open('A'), B = await open('B');
  const tabs = [H, A, B];
  const code = await H.evaluate(async () => { game.netg.name = 'Hosty'; const c = await game.netg.host(); game.startMatch(); return c; });
  await A.evaluate(async (c) => { game.netg.name = 'Alfa'; await game.netg.join(c); }, code);
  await B.evaluate(async (c) => { game.netg.name = 'Bravo'; await game.netg.join(c); }, code);
  const run = async (n) => { for (let i = 0; i < n; i++) { for (const t of tabs) await t.evaluate(() => game.step(3, 1 / 60, false)); await wait(4); } };
  // freeze the bots on the host so they don't interfere
  await run(30);
  await H.evaluate(() => { for (const b of game.bots) if (!b.netPuppet) { b.netDisabled = true; b.netHide(); } });
  const info = async (t) => t.evaluate(() => ({ slot: game.avatar.id, team: game.avatar.team, hp: Math.round(game.avatar.health), alive: game.avatar.alive }));
  console.log('host', JSON.stringify(await info(H)), 'A', JSON.stringify(await info(A)), 'B', JSON.stringify(await info(B)));
  // place shooter 4 m south of victim, aimed at the chest; fire n frames
  const duel = async (S, V, label) => {
    await V.evaluate(() => { game.avatar.health = 100; game.avatar.alive = true; game.player.dead = false; game.weapons.enabled = true; });
    const vp = await V.evaluate(() => { const V = game.player.pos.constructor; const p = new V(10, 0, 20); p.y = game.terrain.heightAt(p.x, p.z) + 0.1; game.player.teleport(p, 0); return p.toArray(); });
    await run(8);
    await S.evaluate(([x, y, z]) => {
      const V = game.player.pos.constructor;
      game.avatar.alive = true; game.player.dead = false; game.weapons.enabled = true;
      game.player.teleport(new V(x, game.terrain.heightAt(x, z + 5) + 0.1, z + 5), 0);
      const eye = game.player.eyePosition(new V());
      const d = new V(x, y + 1.2, z).sub(eye);
      game.player.yaw = Math.atan2(-d.x, -d.z); game.player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    }, vp);
    await run(4);
    await S.evaluate(() => game.input.simulate('fire', true));
    await run(6);
    await S.evaluate(() => game.input.simulate('fire', false));
    await run(6);
    const v = await info(V);
    const feed = await V.evaluate(() => game.match.feed.slice(0, 1).map((f) => `${f.killer}>${f.victim} ${f.weapon}`));
    console.log(label, 'victim', JSON.stringify(v), 'feed', JSON.stringify(feed));
  };
  const sameTeam = async (x, y) => (await info(x)).team === (await info(y)).team;
  // make sure pairs are enemies: put A on the other team from host, B on host's team? (switch as needed)
  if (await sameTeam(H, A)) { await A.evaluate(() => game.netg.submit('/team')); await run(12); }
  if (!(await sameTeam(H, B))) { await B.evaluate(() => game.netg.submit('/team')); await run(12); }
  console.log('teams host', (await info(H)).team, 'A', (await info(A)).team, 'B', (await info(B)).team);
  await duel(H, A, 'host -> A   ');
  await run(80); // respawn
  await duel(A, H, 'A -> host   ');
  await run(80);
  await duel(B, A, 'B -> A (relay)');
  await run(80);
  // grenade from A at the host's feet
  await H.evaluate(() => { game.avatar.health = 100; const V = game.player.pos.constructor; const p = new V(-20, 0, 10); p.y = game.terrain.heightAt(p.x, p.z) + 0.1; game.player.teleport(p, 0); });
  await run(6);
  await A.evaluate(() => { const V = game.player.pos.constructor; game.explosives.throw(game.avatar, new V(-20, game.terrain.heightAt(-20, 10) + 1.0, 10.5), new V(0, 0.5, -0.3), 0.6, 'frag'); });
  await run(40);
  console.log('grenade: host', JSON.stringify(await info(H)), 'host feed', JSON.stringify(await H.evaluate(() => game.match.feed.slice(0, 1).map((f) => `${f.killer}>${f.victim} ${f.weapon}`))));
  // restart from the host: everyone gets the same new flags
  await H.evaluate(() => game.netg.submit('/restart'));
  await run(20);
  const fl = await Promise.all(tabs.map((t) => t.evaluate(() => game.dom.flags.map((f) => f.name).join(',') + ' t=' + Math.round(game.match.timeLeft) + ' ' + game.state)));
  console.log('after /restart', JSON.stringify(fl));
  // host leaves
  await H.evaluate(() => game.netg.net.close());
  await run(10);
  console.log('A after host left:', await A.evaluate(() => [...document.querySelectorAll('.netchat .lines div')].map((d) => d.textContent).slice(-1)[0]));
  await b.close();
})();
