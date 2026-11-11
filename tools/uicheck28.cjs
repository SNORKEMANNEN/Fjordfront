// Update 28 UI: multiplayer panel, settings (controls / multiplayer), loadout presets, death screen,
// spectator, gamepad (mocked navigator.getGamepads), aim assist
const { chromium } = require('playwright');
const OUT = __dirname + '/shots/';
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=low&peer=127.0.0.1:9000', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  // ---- multiplayer panel
  await p.evaluate(() => game.netg.showPanel());
  await p.waitForTimeout(6500);
  await p.screenshot({ path: OUT + 'u28_mp.png' });
  await p.evaluate(() => document.querySelector('.netpanel').remove());
  // ---- settings: controls + multiplayer
  await p.evaluate(() => { game.ui.showSettings('menu'); document.querySelector('.settings .tabs [data-t=c]').click(); });
  await p.evaluate(() => { document.querySelector('.settings .cg').value = '0.022'; document.querySelector('.settings .cv').value = '1.2'; document.querySelector('.settings [data-a=conv]').click(); });
  const sens = await p.evaluate(() => [game.ui && (window.game && (JSON.parse(localStorage.getItem('fjordfront.settings')).sensitivity)), document.querySelector('.convout').textContent]);
  console.log('converter CS2 1.2 ->', JSON.stringify(sens));
  // rebinding: click "Reload", press KeyP
  await p.evaluate(() => document.querySelector('[data-bind=reload]').click());
  await p.waitForTimeout(50);
  await p.keyboard.press('KeyP');
  const kb = await p.evaluate(() => ({ btn: document.querySelector('[data-bind=reload]').textContent, kb: JSON.parse(localStorage.getItem('fjordfront.settings')).keybinds }));
  console.log('rebind reload ->', JSON.stringify(kb));
  await p.screenshot({ path: OUT + 'u28_controls.png' });
  await p.evaluate(() => document.querySelector('[data-a=resetkeys]').click());
  await p.evaluate(() => document.querySelector('.settings .tabs [data-t=m]').click());
  await p.screenshot({ path: OUT + 'u28_mpsettings.png' });
  await p.evaluate(() => document.querySelector('.settings [data-a=back]').click());
  // ---- loadout presets
  await p.evaluate(() => game.ui.showLoadout('menu'));
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + 'u28_loadout.png' });
  await p.evaluate(() => document.querySelector('.ld [data-a=done]').click());
  // ---- match: death screen with loadout cards; keys pick a preset
  await p.evaluate(() => { game.startMatch(); game.step(30, 1 / 60, false); game.hurtPlayer(500, 'test'); game.step(20, 1 / 60, false); });
  await p.evaluate(() => { game.input.simulate('streak1', true); game.step(1, 1 / 60, false); game.input.simulate('streak1', false); game.step(1, 1 / 60, false); });
  console.log('death preset pick ->', await p.evaluate(() => game.ui.activePreset));
  await p.screenshot({ path: OUT + 'u28_death.png' });
  // ---- spectator
  await p.evaluate(() => { game.respawnPlayer?.call?.(game); });
  await p.evaluate(() => { game.toggleSpectate(); game.input.simulate('forward', true); game.step(60, 1 / 60, false); game.input.simulate('forward', false); });
  const sp = await p.evaluate(() => ({ spec: game.spectating, cam: game.camera.position.toArray().map((v) => +v.toFixed(1)), alive: game.avatar.alive }));
  await p.evaluate(() => { game.input.simulate('fire', true); game.step(1, 1 / 60, false); game.input.simulate('fire', false); game.step(40, 1 / 60, false); });
  await p.screenshot({ path: OUT + 'u28_spectate.png' });
  await p.evaluate(() => { game.toggleSpectate(); game.step(5, 1 / 60, false); });
  console.log('spectate ->', JSON.stringify(sp), 'after exit alive', await p.evaluate(() => game.avatar.alive));
  // ---- gamepad: mocked standard pad, left stick forward + right stick turn
  const pad = await p.evaluate(() => {
    const mk = (ax, btn) => ({ connected: true, mapping: 'standard', axes: ax, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: btn.includes(i), value: btn.includes(i) ? 1 : 0 })) });
    let cur = mk([0, -1, 0.8, 0], []);
    navigator.getGamepads = () => [cur];
    const y0 = game.player.yaw, p0 = game.player.pos.clone();
    game.step(60, 1 / 60, false);
    const moved = game.player.pos.distanceTo(p0), turned = game.player.yaw - y0;
    cur = mk([0, 0, 0, 0], [0]); // A = jump
    game.step(2, 1 / 60, false);
    const jumped = game.player.vel.y > 0.5 || !game.player.grounded;
    cur = mk([0, 0, 0, 0], []);
    game.step(30, 1 / 60, false);
    return { moved: +moved.toFixed(2), turned: +turned.toFixed(2), jumped, padActive: game.input.padActive };
  });
  console.log('gamepad ->', JSON.stringify(pad));
  // ---- aim assist: an enemy right off the crosshair, pad active, strafing → view drawn toward it
  const aa = await p.evaluate(() => {
    const me = game.avatar;
    const e = game.bots.find((x) => x.alive && x.team !== me.team);
    const cam = game.camera.position.clone();
    const fwd = new cam.constructor(0, 0, -1).applyQuaternion(game.camera.quaternion);
    // place the bot 12 m ahead, 3 degrees off
    const yaw = game.player.yaw + 0.05;
    const pos = cam.clone().add(new cam.constructor(-Math.sin(yaw) * 12, -1.4, -Math.cos(yaw) * 12));
    pos.y = game.terrain.heightAt(pos.x, pos.z);
    e.body.teleport(pos); e.hold?.(pos.clone(), 0, 2);
    const mk = (ax) => ({ connected: true, mapping: 'standard', axes: ax, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
    navigator.getGamepads = () => [mk([0.6, 0, 0, 0])];
    const y0 = game.player.yaw;
    game.step(20, 1 / 60, false);
    navigator.getGamepads = () => [];
    return { target: game.aaTarget ? game.aaTarget.id : null, bot: e.id, yawDelta: +(game.player.yaw - y0).toFixed(3), wantDelta: 0.05 };
  });
  console.log('aim assist ->', JSON.stringify(aa));
  await b.close();
})();
