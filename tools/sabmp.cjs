// Sabotasje online: host + one client on Solvik. Round state replication, buying, spawn events.
const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 } });
  const open = async (tag) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('GL Driver')) console.log(`[${tag} error] ${m.text().slice(0, 300)}`); });
    await p.goto('http://127.0.0.1:5173/?test&level=solvik&peer=127.0.0.1:9000', { timeout: 180000 });
    await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
    return p;
  };
  const H = await open('host'), A = await open('A');
  const tabs = [H, A];
  const code = await H.evaluate(async () => { game.netg.name = 'Hosty'; const c = await game.netg.host(); game.startMatch(); return c; });
  await A.evaluate(async (c) => { game.netg.name = 'Alfa'; await game.netg.join(c); }, code);
  const run = async (n) => { for (let i = 0; i < n; i++) { for (const t of tabs) await t.evaluate(() => game.step(3, 1 / 30, false)); await wait(4); } };
  await run(40);
  const st = async (t) => t.evaluate(() => {
    const s = game.sab?.sab;
    if (!s) return 'no sab';
    const me = s.seat(game.avatar);
    return { phase: s.phase, round: s.round, timer: Math.round(s.timer), atk: s.atk, ids: game.sab.players.map((c) => c.id).join(','), money: me?.money, kit: me?.kit.primary, alive: game.avatar.alive, team: game.avatar.team, slot: game.avatar.id, charge: s.charge.state };
  });
  console.log('host', JSON.stringify(await st(H)));
  console.log('A   ', JSON.stringify(await st(A)));
  // the client buys a rifle; the host should see it on the client's seat
  const r = await A.evaluate(() => {
    const s = game.sab.sab;
    if (s.phase !== 'buy') return 'not buy: ' + s.phase;
    return game.sab.ui.onBuy('vest') || 'bought';
  });
  console.log('client buy:', r);
  await run(20);
  console.log('host sees client kit:', await H.evaluate(() => { const s = game.sab.sab; const seat = s.seats.find((x) => x.c.netPuppet && x.c.netHuman); return seat ? 'armor ' + seat.kit.armor + ' kr' + seat.money : 'no human seat'; }));
  console.log('A   ', JSON.stringify(await st(A)));
  // run the round on for a while
  await run(300);
  console.log('host', JSON.stringify(await st(H)));
  console.log('A   ', JSON.stringify(await st(A)));
  await b.close();
})();
