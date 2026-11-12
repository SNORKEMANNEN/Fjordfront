// MP7 rebuild: contact sheets of the inspect, tactical and empty reloads (first person, daylight)
// node tools/mp7shots.cjs  -> tools/shots/mp7_<action>.png (4x3 grid of t = 0 .. 1)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  await p.evaluate(() => {
    const g = window.game;
    g.startMatch();
    g.bots.forEach((x) => { x.frozen = true; });
    g.avatar.health = 1e9;
    g.weapons.setLoadout(['mp7', 'p80']);
    g.step(90, 1 / 60, false);
    // look at the sky over the fjord so the gun reads against a plain background
    g.player.pitch = 0.12;
    const sd = g.env.sunDir;
    g.player.yaw = Math.atan2(sd.x, sd.z);
    g.ui.root.style.visibility = 'hidden';
  });
  const fs = require('fs');
  const { execSync } = require('child_process');
  const actions = (process.argv[2] || 'inspect,reload,reloadEmpty').split(',');
  for (const act of actions) {
    const files = [];
    for (let i = 0; i < 12; i++) {
      const t = i / 11 * 0.98;
      await p.evaluate(([act, t]) => {
        const g = window.game, vm = g.vm;
        const dur = act === 'inspect' ? 3.0 : act === 'reload' ? 1.85 : 2.3;
        if (!vm.action || vm.action.type !== act) {
          vm.play(act, dur, []);
          if (act === 'reloadEmpty') vm.boltLocked = true;
        }
        // scrub: re-run the action from the start to t so one-shot captures (the old mag) happen
        vm.action.t = 0;
        vm.reloadFired?.clear?.();
        for (const k of Object.keys(vm.animMem ?? {})) delete vm.animMem[k];
        const n = Math.max(1, Math.round((t * dur) * 60));
        for (let k = 0; k < n; k++) g.step(1, 1 / 60, k === n - 1);
        g.vm.action && (g.vm.action.t = Math.min(g.vm.action.t, 0.999));
      }, [act, t]);
      const f = `tools/shots/mp7_${act}_${i}.png`;
      await p.screenshot({ path: f });
      files.push(f);
      await p.evaluate(() => { const vm = window.game.vm; vm.action = null; });
    }
    execSync(`python3 tools/mp7sheet.py ${act}`);
    for (const f of files) fs.unlinkSync(f);
  }
  await b.close();
})();
