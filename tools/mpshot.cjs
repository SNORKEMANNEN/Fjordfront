const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const open = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => console.log(e.message)); await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day&peer=127.0.0.1:9000'); await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 }); return p; };
  const H = await open(), C = await open();
  await C.evaluate(() => { game.ui.showMenu(true); game.netg.name = 'Ingrid'; game.netg.showPanel('K7Q2M'); });
  await C.screenshot({ path: 'tools/shots/mp_panel.png' });
  await C.evaluate(() => document.querySelector('.netpanel').remove());
  const code = await H.evaluate(async () => { game.netg.name = 'Andreas'; const c = await game.netg.host(); game.startMatch(); return c; });
  await C.evaluate(async (c) => { await game.netg.join(c); }, code);
  const run = async (n) => { for (let i = 0; i < n; i++) { await H.evaluate(() => game.step(3, 1 / 60, false)); await C.evaluate(() => game.step(3, 1 / 60, false)); await wait(4); } };
  await run(20);
  // put the host where the client can see them; same team so the nameplate shows
  const myTeam = await C.evaluate(() => game.avatar.team);
  if (myTeam !== 0) { await C.evaluate(() => game.netg.submit('/team')); await run(15); }
  await H.evaluate(() => { const V = game.player.pos.constructor; const p = new V(6, 0, 12); p.y = game.terrain.heightAt(p.x, p.z) + 0.1; game.player.teleport(p, Math.PI); });
  await C.evaluate(() => { const V = game.player.pos.constructor; const p = new V(6, 0, 20); p.y = game.terrain.heightAt(p.x, p.z) + 0.1; game.player.teleport(p, 0); game.player.pitch = 0; });
  await H.evaluate(() => game.netg.submit('velkommen! /help for kommandoer'));
  await C.evaluate(() => game.netg.submit('takk, klar 👍'));
  await C.evaluate(() => game.netg.submit('/players'));
  await run(25);
  await C.evaluate(() => game.step(1));
  await C.screenshot({ path: 'tools/shots/mp_client.png' });
  await b.close();
})();
