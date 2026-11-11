// long bot match: do bots keep their gun in hand? (visibility, parenting, hand-to-grip distance, NaNs, jitter)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  await p.evaluate(() => { const g = window.game; g.startMatch(); g.player.frozen = true; g.avatar.alive = false; g.player.dead = true; g.respawnT = 1e9; });
  const secs = +(process.argv[2] || 240);
  for (let s = 0; s <= secs; s += 30) {
    if (s) for (let k = 0; k < 30; k++) await p.evaluate(() => window.game.step(60, 1 / 60, false));
    const r = await p.evaluate(() => {
      const g = window.game;
      const V = g.camera.position.constructor;
      const bad = [];
      for (const bt of g.bots) {
        if (!bt.alive || bt.netDisabled) continue;
        const w = bt.weapon.root, sol = bt.soldier;
        // put the camera near so LOD 0 + near gun are used, pose twice and compare
        const pos = bt.position();
        g.camera.position.set(pos.x + 4, pos.y + 1.6, pos.z);
        g.camera.updateMatrixWorld();
        bt.visualLod(4);
        const hand = (n) => sol.bones[n].getWorldPosition(new V());
        const grip = bt.weapon.sockets.rightHand ? bt.weapon.sockets.rightHand.getWorldPosition(new V()) : null;
        const h = hand('RightHand');
        const wp = w.getWorldPosition(new V());
        const info = {
          id: bt.id, vis: w.visible, par: w.parent === sol.model, sw: sol.weapon === bt.weapon,
          gm: bt.gunMesh ? bt.gunMesh.visible : null, gp: bt.gunProxy ? bt.gunProxy.visible : null,
          gripD: grip ? +h.distanceTo(grip).toFixed(2) : -1, gunD: +wp.distanceTo(pos).toFixed(2),
          nan: [wp.x, wp.y, wp.z, h.x].some((v) => !isFinite(v)), st: bt.state, intent: bt.intent, act: bt.anim?.action ?? bt.soldier.anim?.st?.action, sc: w.scale.x.toFixed(2),
        };
        if (!info.vis || !info.par || !info.sw || info.gripD > 0.15 || info.gunD > 2.5 || info.nan || info.gm === false && info.gp === false) bad.push(info);
      }
      return { t: Math.round(g.time), alive: g.bots.filter((x) => x.alive).length, bad: bad.slice(0, 8), nbad: bad.length };
    });
    console.log(JSON.stringify(r));
  }
  await b.close();
})();
