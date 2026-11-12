// Update 31 equipment checks: sound bank, every throwable through its whole first-person action
// (cook, power, release), grenade physics per surface, smoke volume blocking, bot pull/cook/throw
// with held props, explosions (fx + audio paths), stim, C4 + detonator, knife pickup.
// node tools/eqtest.cjs [shots]
const { chromium } = require('playwright');
const shots = process.argv[2] === 'shots';
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); });
  p.on('console', (m) => { if (m.type() === 'error') console.log('[error] ' + m.text().slice(0, 300)); });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  const ev = (f, a) => p.evaluate(f, a);
  console.log('bank', JSON.stringify(await ev(() => {
    const need = ['pin', 'spoon', 'swish', 'swishLight', 'fuse', 'fuseLight', 'bounce_hard', 'bounce_metal', 'bounce_wood', 'bounce_soft', 'bounce_gravel', 'bounce_mud', 'bounce_can', 'roll', 'splash',
      'explosion', 'explosionCrack', 'explosionFar', 'explosionWater', 'debris', 'flashBang', 'stunBang', 'smokePop', 'smokeHiss', 'twist', 'snapPulse', 'stimCap', 'stimInject', 'stimHiss',
      'injectorToss', 'heartbeat', 'tinnitus', 'panicBreath', 'stick', 'peel', 'clack', 'coverFlip', 'beep', 'beepLow', 'armChirp', 'claymoreClick', 'legs', 'place', 'zap', 'servo', 'trophyDeploy',
      'fireIgnite', 'knifeDraw', 'knifeThrow', 'knifeCatch', 'knifePickup', 'effort', 'nadeBounce'];
    const bank = window.game.audio.bank;
    return { missing: need.filter((k) => !bank[k]?.length), n: need.length };
  })));
  await ev(() => { const g = window.game; g.startMatch(); g.respawnT = 0; });
  for (let i = 0; i < 6; i++) await ev(() => window.game.step(30, 1 / 60, false));
  await ev(() => { const g = window.game; g.bots.forEach((x) => { x.frozen = true; }); });

  // ---- each lethal / tactical through its action, holding the key for a cook / power
  const throwOne = async (slot, item, holdFrames) => ev(async ([slot, item, hold]) => {
    const g = window.game;
    if (slot === 'grenade') { g.loadout.lethal = item; g.frags = 2; } else { g.loadout.tactical = item; g.tacCount = 2; }
    g.vm.cancelAction?.();
    g.vm.action = null;
    g.weapons.switching = false; g.weapons.reloading = false;
    const before = g.explosives.grenades.length + g.tknives.knives.length;
    g.input.simulate(slot, true);
    g.step(1, 1 / 60, false);
    let maxCook = -1, held = 0, sawSpoon = false, maxPow = 0;
    for (let i = 0; i < hold; i++) {
      g.step(1, 1 / 60, false);
      const a = g.vm.action;
      if (a?.data?.cook) maxCook = Math.max(maxCook, a.data.cook());
      if (a?.data?.power) maxPow = Math.max(maxPow, a.data.power());
      if (a?.data?.heldT) held = a.data.heldT;
      if (a?.data?.spoonT !== undefined) sawSpoon = true;
    }
    g.input.simulate(slot, false);
    let type = g.vm.action?.type;
    for (let i = 0; i < 120 && g.vm.action; i++) g.step(1, 1 / 60, false);
    const after = g.explosives.grenades.length + g.tknives.knives.length;
    const gr = g.explosives.grenades[g.explosives.grenades.length - 1];
    return { item, type, thrown: after > before, maxCook: +maxCook.toFixed(2), maxPow: +maxPow.toFixed(2), held: +held.toFixed(2), sawSpoon, cooked: gr ? +gr.cooked.toFixed(2) : null, fuse: gr ? +gr.fuse.toFixed(2) : null, roll: gr?.roll, v: gr ? +gr.vel.length().toFixed(1) : null };
  }, [slot, item, holdFrames]);
  for (const [slot, item, hold] of [['grenade', 'frag', 15], ['grenade', 'frag', 110], ['grenade', 'sticky', 60], ['grenade', 'c4', 50], ['grenade', 'tknife', 150], ['tactical', 'flash', 15], ['tactical', 'stun', 60], ['tactical', 'smoke', 40], ['tactical', 'snapshot', 50], ['tactical', 'decoy', 50]]) {
    console.log('throw', JSON.stringify(await throwOne(slot, item, hold)));
    await ev(() => window.game.step(20, 1 / 60, false));
  }
  // let everything settle / go off
  for (let i = 0; i < 6; i++) await ev(() => window.game.step(30, 1 / 60, false));
  console.log('after', JSON.stringify(await ev(() => {
    const g = window.game;
    return { grenades: g.explosives.grenades.map((x) => [x.kind, x.resting, x.stuck?.what ?? null, x.surface]), smokes: g.explosives.smokes.length, puffs: g.smoke.puffs.length, heat: g.blastFx.heat.length, scorch: g.blastFx.scorch.count, spray: g.blastFx.spray.count };
  })));

  // ---- physics: drop a frag on several surfaces and on a slope; one into the sea
  console.log('physics', JSON.stringify(await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const out = [];
    const tryAt = (label, x, z, vel) => {
      const y = g.terrain.heightAt(x, z) + 2;
      const n = g.explosives.throw(g.bots[0], new V(x, y, z), vel ?? new V(2, -1, 0), 99, 'frag');
      let bounces = 0, t = 0;
      for (; t < 360 && !n.resting; t++) { g.explosives.update(1 / 60); }
      bounces = n.bounces;
      out.push({ label, surf: n.surface, bounces, rest: n.resting, wet: n.wet, travel: +Math.hypot(n.pos.x - x, n.pos.z - z).toFixed(1), frames: t });
      n.fuse = 0; g.explosives.update(1 / 60);
    };
    // find a few spots with distinct surfaces
    const seen = new Set();
    for (let x = -160; x < 160 && seen.size < 5; x += 13) for (let z = -160; z < 160 && seen.size < 5; z += 17) {
      const s = g.terrain.surfaceAt(x, z);
      if (s === 'water' || seen.has(s) || g.terrain.heightAt(x, z) < 0.5) continue;
      seen.add(s);
      tryAt('surf:' + s, x, z);
    }
    // the sea
    for (let x = 100; x < 400; x += 10) if (g.terrain.heightAt(x, 0) < -3) { tryAt('sea', x, 0, new V(1, -2, 0)); break; }
    return out;
  })));

  // ---- smoke volume: blocks a sight line through it, and stops the snapshot scan
  console.log('smoke', JSON.stringify(await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const c = g.player.pos.clone().add(new V(0, 0, -8));
    c.y = g.terrain.heightAt(c.x, c.z);
    g.smoke.clear();
    g.smoke.start(c, 20, false);
    for (let i = 0; i < 300; i++) g.smoke.update(1 / 60);
    const a = c.clone().add(new V(-12, 1.5, 0)), bb = c.clone().add(new V(12, 1.5, 0));
    const far = c.clone().add(new V(-12, 30, 0)), far2 = c.clone().add(new V(12, 30, 0));
    return { puffs: g.smoke.puffs.length, depth: +g.smoke.depth(a, bb).toFixed(2), blocks: g.smoke.blocks(a, bb), clearAbove: !g.smoke.blocks(far, far2), inside: +g.smoke.inside(c.clone().setY(c.y + 1)).toFixed(2) };
  })));

  // ---- explosion audio routing and FX (near / far / water)
  console.log('blast', JSON.stringify(await ev(() => {
    const g = window.game;
    const V = g.camera.position.constructor;
    const before = g.blastFx.scorch.count;
    const p = g.player.pos.clone().add(new V(6, 0, 0));
    p.y = g.terrain.heightAt(p.x, p.z) + 0.2;
    g.explosives.explode(p, g.bots[0], { id: 'frag', name: 'Frag Grenade', cls: 'Explosive' }, 0.1, 0);
    g.audio.explosionAt(p.clone().add(new V(150, 0, 0)), {});
    g.audio.explosionAt(p, { water: true });
    g.audio.explosionAt(p, { srcTunnel: true });
    g.step(5, 1 / 60, false);
    return { scorch: g.blastFx.scorch.count - before, heat: g.blastFx.heat.length, rings: g.blastFx.rings.filter((r) => r.mesh.visible).length };
  })));

  // ---- bots: pull, cook, throw (action + held prop), net pose code
  console.log('bots', JSON.stringify(await ev(() => {
    const g = window.game;
    const bt = g.bots.find((x) => x.alive && x.team !== g.avatar.team) ?? g.bots[0];
    bt.frozen = false;
    bt.frags = 1;
    bt.sticky = false;
    bt.startThrow(true, g.player.pos.clone(), 1.0);
    const seen = new Set(), items = new Set();
    let held = false, maxT = 0;
    const n0 = g.explosives.grenades.length;
    let cooked = null;
    for (let i = 0; i < 160; i++) {
      g.step(1, 1 / 60, false);
      seen.add(bt.anim.action);
      items.add(bt.anim.item);
      maxT = Math.max(maxT, bt.anim.actionT);
      if (bt.soldier.held?.visible) held = true;
      if (g.explosives.grenades.length > n0 && cooked === null) cooked = g.explosives.grenades[g.explosives.grenades.length - 1].cooked;
    }
    const st = bt.replayState();
    return { actions: [...seen], items: [...items], heldVisible: held, cooked, code19: st[19] };
  })));

  // ---- stim, C4 + detonator, claymore, knife pickup (actions run to the end without errors)
  console.log('misc', JSON.stringify(await ev(() => {
    const g = window.game;
    const res = {};
    const run = (k, f) => { try { f(); for (let i = 0; i < 200 && g.vm.action; i++) g.step(1, 1 / 60, false); res[k] = 'ok'; } catch (e) { res[k] = 'ERR ' + e.message; } };
    g.loadout.tactical = 'stim'; g.tacCount = 1;
    run('stim', () => { g.input.simulate('tactical', true); g.step(1, 1 / 60, false); g.input.simulate('tactical', false); });
    res.stimT = +g.stimT.toFixed(1);
    g.loadout.lethal = 'c4'; g.frags = 1;
    run('c4', () => { g.input.simulate('grenade', true); g.step(40, 1 / 60, false); g.input.simulate('grenade', false); });
    res.c4out = g.explosives.grenades.filter((x) => x.kind === 'c4').length;
    res.detOut = g.vm.detonatorOut;
    const pose = new Float32Array(20); g.playerPose(pose); res.poseItem = pose[19];
    g.frags = 0;
    run('det', () => { g.input.simulate('grenade', true); g.step(1, 1 / 60, false); g.input.simulate('grenade', false); });
    g.step(30, 1 / 60, false);
    res.c4left = g.explosives.grenades.filter((x) => x.kind === 'c4').length;
    g.loadout.lethal = 'claymore'; g.frags = 1;
    run('claymore', () => { g.input.simulate('grenade', true); g.step(30, 1 / 60, false); g.input.simulate('grenade', false); });
    g.vm.holdItem('tknife');
    run('knifePickup', () => g.vm.play('knifePickup', 1.2, []));
    return res;
  })));
  if (shots) {
    // a few frames of the first-person sequence, for eyeballing
    for (const [name, slot, item, frames] of [['frag_cook', 'grenade', 'frag', 70], ['sticky_peel', 'grenade', 'sticky', 26], ['tac_pistol', 'tactical', 'flash', 30], ['knife_ready', 'grenade', 'tknife', 90]]) {
      await ev(([slot, item, frames]) => {
        const g = window.game;
        if (slot === 'grenade') { g.loadout.lethal = item; g.frags = 2; } else { g.loadout.tactical = item; g.tacCount = 2; }
        g.input.simulate(slot, true);
        g.step(frames, 1 / 60, true);
      }, [slot, item, frames]);
      await p.screenshot({ path: `tools/shots/eq_${name}.png` });
      await ev(([slot]) => { const g = window.game; g.input.simulate(slot, false); g.step(90, 1 / 60, false); }, [slot]);
    }
  }
  console.log('errors', errs.length);
  await b.close();
})();
