// node tools/vmgrid.cjs name '[["k416",{"ads":0}],["k416",{"tactical":1,"sprint":1,"speed01":1.2}, "reload", 0.35]]'
// each entry: [weaponId, vmForce, optional action ('reload'|'reloadEmpty'|'inspect'), optional t (0..1)]
const { chromium } = require('playwright');
(async () => {
  const [name, spec] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[err] ' + m.text()); });
  await p.goto('http://localhost:5173/?test&weather=clear&time=' + (process.env.T || 'day'), { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  const url = await p.evaluate(async (spec) => {
    const g = window.game;
    g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.root.visible = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    g.view(-3, 8, 1.2, 0.02);
    const items = JSON.parse(spec);
    const w = g.canvas.width, h = g.canvas.height, cols = items.length === 1 ? 1 : items.length === 2 ? 2 : 3, sc = cols <= 2 ? 1 : 0.5;
    const out = document.createElement('canvas');
    out.width = w * sc * cols; out.height = h * sc * Math.ceil(items.length / cols);
    const ctx = out.getContext('2d');
    for (let i = 0; i < items.length; i++) {
      const [id, force, action, at, side, pre, post] = items[i];
      if (pre) eval(pre);
      const ws = g.weapons;
      if (ws.slots[ws.current].def.id !== id) {
        g.weapons.setLoadout([id, id === 'p80' ? 'k416' : 'p80']);
        g.step(60, 1 / 60, false);
      }
      ws.vmForce = force;
      g.player.frozen = true;
      g.step(40, 1 / 60, false);
      if (action) {
        const vm = ws.vm;
        vm.play(action, 2.4, [], undefined);
        // scrub: advance the action to t
        const steps = Math.round((at * 2.4) / (1 / 60));
        g.step(Math.max(1, steps), 1 / 60, false);
        vm.action && (vm.action.dur = 1e9);
      }
      g.step(6);
      if (side) g.debugVM(...side);
      if (post) eval(post);
      ctx.drawImage(g.canvas, (i % cols) * w * sc, Math.floor(i / cols) * h * sc, w * sc, h * sc);
      ws.vm.cancelAction();
    }
    return out.toDataURL('image/jpeg', 0.85);
  }, spec);
  require('fs').writeFileSync(`tools/shots/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
  await b.close();
})();
