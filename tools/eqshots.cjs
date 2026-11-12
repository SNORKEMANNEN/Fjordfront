// Update 31: screenshots of the equipment sequences in daylight (first person + third person + blast)
// node tools/eqshots.cjs   -> tools/shots/eqs_*.png
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const ev = (f, a) => p.evaluate(f, a);
  await ev(() => { const g = window.game; g.startMatch(); g.respawnT = 0; g.step(90, 1 / 60, false); g.bots.forEach((x) => { x.frozen = true; }); });
  const shot = (n) => p.screenshot({ path: `tools/shots/eqs_${n}.png` });
  // hold an action at a given progress for a screenshot
  const fp = async (name, setup, slot, frames) => {
    await ev(([setup, slot, frames]) => {
      const g = window.game;
      g.smoke.clear();
      g.vm.action = null;
      new Function('g', setup)(g);
      g.input.simulate(slot, true);
      g.step(frames, 1 / 60, true);
    }, [setup, slot, frames]);
    await shot(name);
    await ev(([slot]) => { const g = window.game; g.input.simulate(slot, false); g.step(100, 1 / 60, false); g.explosives.clear(); }, [slot]);
  };
  await fp('frag_pin', "g.loadout.lethal='frag'; g.frags=2;", 'grenade', 26);
  await fp('frag_cook', "g.loadout.lethal='frag'; g.frags=2;", 'grenade', 100);
  await fp('sticky_peel', "g.loadout.lethal='sticky'; g.frags=2;", 'grenade', 30);
  await fp('knife_draw', "g.loadout.lethal='tknife'; g.frags=2;", 'grenade', 10);
  await fp('knife_spin', "g.loadout.lethal='tknife'; g.frags=2;", 'grenade', 112);
  await fp('c4_flick', "g.loadout.lethal='c4'; g.frags=2;", 'grenade', 30);
  await ev(() => { const g = window.game; g.input.simulate('grenade', false); g.step(120, 1 / 60, true); });
  await shot('detonator_idle');
  await ev(() => { const g = window.game; g.vm.detonatorOut = false; g.explosives.clear(); });
  await fp('tac_rifle', "g.loadout.tactical='flash'; g.tacCount=2;", 'tactical', 40);
  await fp('tac_pistol', "g.weapons.switchTo(1); g.step(60,1/60,false); g.loadout.tactical='stun'; g.tacCount=2;", 'tactical', 40);
  await fp('snapshot_twist', "g.weapons.switchTo(0); g.step(60,1/60,false); g.loadout.tactical='snapshot'; g.tacCount=2;", 'tactical', 26);
  await fp('stim_cap', "g.loadout.tactical='stim'; g.tacCount=2;", 'tactical', 27);
  await fp('stim_toss', "g.loadout.tactical='stim'; g.tacCount=2;", 'tactical', 55);
  // third person: a bot pulling and cooking a frag, seen from 4 m
  await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const bt = g.bots.find((x) => x.alive && x.team !== g.avatar.team);
    window.__bt = bt;
    bt.frozen = false; bt.sticky = false;
    bt.startThrow(true, g.player.pos.clone(), 1.5);
    g.player.frozen = true;
    for (let i = 0; i < 40; i++) {
      g.step(1, 1 / 60, false);
      const c = bt.position().clone().add(new V(Math.sin(bt.yaw) * -3.5 + 1.2, 1.5, Math.cos(bt.yaw) * -3.5));
      g.camera.position.copy(c);
      g.camera.lookAt(bt.position().clone().setY(bt.position().y + 1.3));
    }
    g.step(1, 1 / 60, true);
  });
  // (game.step re-aims the camera from the player; render a frame from the posed camera)
  await ev(() => {
    const g = window.game, bt = window.__bt;
    const V = g.camera.position.constructor;
    const c = bt.position().clone().add(new V(-Math.sin(bt.yaw) * 3.2 + 1.0, 1.6, -Math.cos(bt.yaw) * 3.2));
    g.camera.position.copy(c);
    g.camera.lookAt(bt.position().clone().setY(bt.position().y + 1.3));
    g.camera.updateMatrixWorld();
    bt.visualLod?.(3);
    g.renderer.render(g.scene, g.camera);
  });
  await shot('bot_cook');
  // a blast on the ground 7 m in front, looked at a beat later
  await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    g.player.frozen = false;
    g.step(5, 1 / 60, false);
    const fwd = new V(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
    const p = g.player.pos.clone().addScaledVector(fwd, 8);
    p.y = g.terrain.heightAt(p.x, p.z) + 0.15;
    g.explosives.explode(p, g.bots[0], { id: 'frag', name: 'Frag Grenade', cls: 'Explosive' }, 0.1, 0);
    g.step(9, 1 / 60, true);
  });
  await shot('blast_early');
  await ev(() => window.game.step(80, 1 / 60, true));
  await shot('blast_late');
  // smoke grenade cloud 10 m ahead after 6 s
  await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const fwd = new V(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
    const p = g.player.pos.clone().addScaledVector(fwd, 10);
    p.y = g.terrain.heightAt(p.x, p.z) + 1;
    const n = g.explosives.throw(g.bots[0], p, new V(0, -1, 0), 0.2, 'smoke');
    g.step(360, 1 / 60, true);
  });
  await shot('smoke');
  await b.close();
})();
