// Sabotasje smoke test: node tools/sabtest.cjs [seconds]
const { chromium } = require('playwright');
(async () => {
  const secs = +(process.argv[2] || 60);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  p.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('GL Driver') && !t.includes('GPU stall') && !t.includes('KHR_materials')) console.log('[console] ' + t.slice(0, 300));
  });
  await p.goto('http://127.0.0.1:5173/?test&level=solvik', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  const r = await p.evaluate(async (secs) => {
    const g = window.game;
    g.startMatch();
    const log = [];
    const sab = g.sab.sab;
    let lastPhase = '', lastRound = 0;
    g.avatar.health = 1e9;
    for (let i = 0; i < secs * 30; i++) {
      g.step(1, 1 / 30, false);
      if (sab.phase !== lastPhase || sab.round !== lastRound) {
        log.push('t=' + (i / 30).toFixed(1) + ' r' + sab.round + ' ' + sab.phase + ' score=' + sab.score + ' atk=' + sab.atk + ' charge=' + sab.charge.state + ' alive=' + sab.alive(0) + 'v' + sab.alive(1));
        lastPhase = sab.phase;
        lastRound = sab.round;
      }
      if (sab.phase === 'ended') break;
    }
    const seats = sab.seats.map((s) => s.c.name + ':' + s.c.team + ' kr' + s.money + ' k' + s.st.kills + ' d' + s.st.deaths + ' ' + (s.kit.primary || '-'));
    return { log, seats, charge: sab.charge.state, phase: sab.phase };
  }, secs);
  console.log(r.log.join('\n'));
  console.log(r.seats.join('\n'));
  await p.screenshot({ path: 'tools/shots/sab_end.png' });
  await b.close();
})();
