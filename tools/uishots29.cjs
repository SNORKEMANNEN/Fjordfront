// Update 29 (Sjøkart UI) screenshots: loading, menu, multiplayer panel, loadout, HUD, scoreboard,
// tactical map, death screen
const { chromium } = require('playwright');
const OUT = __dirname + '/shots/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.setDefaultTimeout(120000);
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error' && !/lobby|PeerJS/.test(m.text())) console.log('[error] ' + m.text().slice(0, 200)); });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=low&time=day&peer=127.0.0.1:9000', { timeout: 180000 });
  await wait(2500);
  await p.screenshot({ path: OUT + 'u29_loading.png' });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  // menu: render a few frames (test mode does not run the animation loop)
  await p.evaluate(() => { game.ui.hideLoading(); for (let i = 0; i < 4; i++) game.frame(performance.now() + i * 16); });
  await wait(4000);
  await p.evaluate(() => { game.refreshBrief(); for (let i = 0; i < 2; i++) game.frame(performance.now() + i * 16); });
  await wait(800);
  await p.screenshot({ path: OUT + 'u29_menu.png' });
  await p.evaluate(() => document.querySelector('.rail [data-tab=manual]').click());
  await wait(300);
  await p.screenshot({ path: OUT + 'u29_manual.png' });
  await p.evaluate(() => document.querySelector('.rail [data-tab=play]').click());
  // multiplayer panel
  await p.evaluate(() => game.netg.showPanel());
  await wait(6500);
  await p.screenshot({ path: OUT + 'u29_mp.png' });
  await p.evaluate(() => document.querySelector('.netpanel').remove());
  // loadout workbench: inspect another gun (compare)
  await p.evaluate(() => game.ui.showLoadout('menu'));
  await wait(1200);
  await p.evaluate(() => { const c = [...document.querySelectorAll('.ldcard')].find((x) => !x.classList.contains('eq')); c && c.click(); });
  await wait(1500);
  await p.screenshot({ path: OUT + 'u29_loadout.png' });
  await p.evaluate(() => document.querySelector('.ld [data-a=done]').click());
  // match HUD with events
  await p.evaluate(() => {
    game.startMatch();
    game.step(120, 1 / 60, false);
    const ui = game.ui;
    ui.popup('ELIMINATION', 100, 'kill'); ui.popup('HEADSHOT', 50); ui.popup('ASSIST', 50); ui.popup('CAPTURE B', 200, 'cap'); ui.popup('SPOTTED · HAUGEN', 0, 'info');
    ui.damageFrom(0.9, 'bullet'); ui.damageFrom(-2.2, 'explosion'); ui.damageFrom(2.6, 'fire');
    ui.hitmarker(true, true, 100);
    game.avatar.health = 64;
    game.match.feed.unshift({ killer: game.avatar.name, killerTeam: game.avatar.team, victim: 'Haugen', victimTeam: 1, weapon: 'K416 Carbine', headshot: true, wallbang: false, t: game.time });
    game.match.feed.unshift({ killer: 'Solberg', killerTeam: 1, victim: 'Moen', victimTeam: 0, weapon: 'Frag Grenade', headshot: false, wallbang: false, t: game.time });
    game.match.feed.unshift({ killer: 'Berg', killerTeam: 0, victim: 'Dahl', victimTeam: 1, weapon: 'SKV .338 Bolt Rifle', headshot: false, wallbang: true, t: game.time });
    game.worldPings = game.worldPings || [];
    game.step(2, 1 / 60, true);
  });
  await wait(300);
  await p.screenshot({ path: OUT + 'u29_hud.png' });
  // scoreboard
  await p.evaluate(() => { game.ui.setScoreboard(true, game.scoreRows(), game.match.teamNames, game.avatar.id); });
  await wait(300);
  await p.screenshot({ path: OUT + 'u29_scoreboard.png' });
  await p.evaluate(() => game.ui.setScoreboard(false));
  // tactical map
  await p.evaluate(() => { game.setMapOpen(true); game.step(3, 1 / 60, true); });
  await wait(400);
  await p.screenshot({ path: OUT + 'u29_map.png' });
  await p.evaluate(() => { game.setMapOpen(false); });
  // death screen
  await p.evaluate(() => { game.ui.showDeath(true, 'HAUGEN', 'HVAL-47 Assault Rifle', 4, 1); });
  await wait(300);
  await p.screenshot({ path: OUT + 'u29_death.png' });
  await b.close();
})();
