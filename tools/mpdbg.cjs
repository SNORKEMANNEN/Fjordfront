const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 } });
  const open = async (tag) => { const p = await ctx.newPage(); p.on('pageerror', (e) => console.log(`[${tag}] ${e.message}`)); await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day&peer=127.0.0.1:9000'); await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 }); return p; };
  const H = await open('host'), A = await open('A');
  const code = await H.evaluate(async () => { const c = await game.netg.host(); game.startMatch(); return c; });
  await A.evaluate(async (c) => { await game.netg.join(c); }, code);
  const run = async (n) => { for (let i = 0; i < n; i++) { for (const t of [H, A]) await t.evaluate(() => game.step(3, 1 / 60, false)); await wait(4); } };
  await run(30);
  await H.evaluate(() => { for (const b of game.bots) if (!b.netPuppet) { b.netDisabled = true; b.netHide(); } window.__hits = 0; const om = game.netg.net.onMessage; game.netg.net.onMessage = (f, m) => { if (m.t === 'hit') window.__hits++; om(f, m); }; });
  await A.evaluate(() => { window.__routes = 0; const r = window.NETF_route; });
  await H.evaluate(() => { const V = game.player.pos.constructor; const p = new V(10, 0, 20); p.y = game.terrain.heightAt(p.x, p.z) + 0.1; game.player.teleport(p, 0); });
  await run(10);
  const r = await A.evaluate(() => {
    const p0 = game.bots.find((b) => b.id === 0);
    return { exists: !!p0, alive: p0?.alive, vis: p0?.root.visible, team: p0?.team, myTeam: game.avatar.team, pos: p0?.position().toArray().map((v) => +v.toFixed(1)), puppet: p0?.netPuppet, disabled: p0?.netDisabled, ids: game.bots.map((b) => b.id).join(',') };
  });
  console.log(JSON.stringify(r));
  await A.evaluate(([x, y, z]) => {
    const V = game.player.pos.constructor;
    game.player.teleport(new V(x, game.terrain.heightAt(x, z + 5) + 0.1, z + 5), 0);
    const eye = game.player.eyePosition(new V());
    const d = new V(x, y + 1.2, z).sub(eye);
    game.player.yaw = Math.atan2(-d.x, -d.z); game.player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }, r.pos);
  await run(4);
  await A.evaluate(() => game.input.simulate('fire', true));
  await run(6);
  await A.evaluate(() => game.input.simulate('fire', false));
  await run(6);
  console.log('A killcam?', await A.evaluate(() => !!game.killcam), 'host hits received', await H.evaluate(() => window.__hits), 'host', JSON.stringify(await H.evaluate(() => ({ hp: Math.round(game.avatar.health), alive: game.avatar.alive, feed: game.match.feed.slice(0,1).map(f=>f.killer+'>'+f.victim) }))));
  await b.close();
})();
