// The charge spawns on the ground in the attackers' spawn; the player can take it, else a bot fetches it.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  const ev = (f) => p.evaluate(`(() => { const g = window.game; if (g.state === 'paused') { g.state = 'playing'; g.ui.showPause(false); } return (${f})(g); })()`);
  console.log(await ev((g) => {
    g.startMatch();
    const m = g.sab, s = m.sab;
    m.ui.closeBuy();
    const out = [];
    const ch = s.charge;
    out.push(`round start: state=${ch.state} holder=${ch.holder && ch.holder.name} pos=${ch.pos.toArray().map((v) => v.toFixed(1))} fresh=${ch.fresh} mesh=${m.chargeMesh.visible} myTeam=${g.avatar.team} atk=${s.atk}`);
    window.__out = out;
    return out.join('\n');
  }));
  // look at it from spawn during the buy phase
  await ev((g) => {
    const s = g.sab.sab, cp = s.charge.pos, pp = g.player.pos;
    g.player.yaw = Math.atan2(pp.x - cp.x, pp.z - cp.z);
    g.player.pitch = -0.25;
    g.step(3, 1 / 30, true);
  });
  await p.screenshot({ path: 'tools/shots/cs_spawn.png' });
  console.log(await ev((g) => {
    const m = g.sab, s = m.sab, out = [];
    // case 1: the player is an attacker and walks over it after the freeze
    s.atk = g.avatar.team;
    g.step(370, 1 / 30, false); // to live
    out.push(`live: phase=${s.phase} state=${s.charge.state} holder=${s.charge.holder && s.charge.holder.name}`);
    g.player.teleport(s.charge.pos.clone().setY(s.charge.pos.y + 0.2), 0);
    g.step(6, 1 / 30, false);
    out.push(`player walks over: state=${s.charge.state} holder=${s.charge.holder === g.avatar ? 'ME' : s.charge.holder && s.charge.holder.name}`);
    return out.join('\n');
  }));
  await b.close();
})();
