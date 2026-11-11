// Exports the UAV killstreak for animating in Blender:
//   uav_fp_scene.glb  arms + tablet + rifle + game camera, with the current in-game UAV animation baked (30 fps)
//   uav_tablet.glb    the tablet on its own (named parts, origin at its centre)
//   screen_idle.png / screen_launched.png  the two screen images
// node tools/export_uav.cjs <outdir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const out = process.argv[2] || 'export/uav';
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[error] ' + m.text().slice(0, 300)); });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const res = await p.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const g = window.game;
    g.startMatch();
    for (const bt of g.bots) { bt.alive = false; bt.root.visible = false; bt.body.setEnabled(false); bt.respawnT = 1e9; }
    g.view(0, 10, 0, 0);
    g.step(90, 1 / 60, false);
    const vm = g.vm;
    const VM = vm.constructor;
    // ---- what to record: the viewmodel root, every arm bone, the rifle, the tablet
    const tablet = vm.items.phone;
    const gun = vm.model.root;
    gun.name = 'Rifle_' + vm.def.id.toUpperCase();
    vm.root.name = 'Viewmodel';
    const nodes = [vm.root, gun, tablet];
    vm.root.traverse((o) => { if (o.isBone) nodes.push(o); });
    // unique names (animation tracks are bound by name)
    const seen = new Map();
    // the tablet's parts keep their names; anything else that clashes gets a suffix
    tablet.traverse((o) => seen.set(o.name, 1));
    vm.root.traverse((o) => {
      if (o === tablet || o.parent === tablet) return;
      let n = (o.name || o.type).replace(/[.:\/\[\]]/g, '_');
      const k = seen.get(n) || 0;
      seen.set(n, k + 1);
      if (k) n = `${n}_${k}`;
      o.name = n;
    });
    // ---- play the UAV action and sample it
    vm.holdItem('phone');
    vm.play('uav', 1.4, []);
    const fps = 30, frames = Math.round(1.4 * fps);
    const times = [];
    const pos = nodes.map(() => []), quat = nodes.map(() => []);
    const tabletVisible = [];
    for (let f = 0; f <= frames; f++) {
      g.step(1, f === 0 ? 1e-4 : 1 / fps, false);
      times.push(f / fps);
      nodes.forEach((n, i) => { pos[i].push(n.position.x, n.position.y, n.position.z); quat[i].push(n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w); });
      tabletVisible.push(tablet.visible ? 1 : 0);
    }
    const tracks = [];
    nodes.forEach((n, i) => {
      tracks.push(new T.VectorKeyframeTrack(`${n.name}.position`, times, pos[i]));
      tracks.push(new T.QuaternionKeyframeTrack(`${n.name}.quaternion`, times, quat[i]));
    });
    const clip = new T.AnimationClip('uav_use', 1.4, tracks);
    // ---- materials the exporter can write: plain PBR colours for the gun (its in-game surfaces are shader-made)
    // (shader-textured parts have a white base colour: show those as black gunmetal)
    const plain = (m) => {
      const c = m.color ? m.color.clone() : new T.Color(0x777777);
      const hsl = {}; c.getHSL(hsl);
      if (hsl.l > 0.85 || m.map) c.set(0x2b2d30);
      return new T.MeshStandardMaterial({ color: c, roughness: m.roughness ?? 0.6, metalness: Math.min(0.6, m.metalness ?? 0.3), name: m.name || 'gun' });
    };
    gun.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(plain) : plain(o.material); });
    const scr = tablet.getObjectByName('screen');
    scr.material = new T.MeshBasicMaterial({ map: VM.phoneTex, name: 'screen' });
    // pose at frame 0 for the bind pose, everything that matters visible
    for (const it of Object.values(vm.items)) it.visible = it === tablet;
    tablet.visible = true;
    gun.visible = true;
    const cam = new T.PerspectiveCamera(g.vmCamera.fov, 16 / 9, 0.01, 10);
    cam.name = 'GameCamera';
    const ex = new GLTFExporter();
    const glb = await ex.parseAsync([vm.root, cam], { binary: true, animations: [clip], onlyVisible: true });
    // the tablet on its own, at the origin
    const solo = tablet.clone(true);
    solo.position.set(0, 0, 0);
    solo.quaternion.identity();
    solo.scale.set(1, 1, 1);
    solo.visible = true;
    const glb2 = await ex.parseAsync(solo, { binary: true, onlyVisible: false });
    const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const parts = []; tablet.traverse((o) => { if (o !== tablet) parts.push(o.name); });
    const bones = nodes.filter((n) => n.isBone).map((n) => n.name);
    return {
      scene: b64(glb), tablet: b64(glb2),
      idle: VM.phoneTex.image.toDataURL('image/png'), launched: VM.phoneTexPressed.image.toDataURL('image/png'),
      info: { fov: g.vmCamera.fov, gun: gun.name, frames, parts, bones, tabletVisible: tabletVisible.join(''), rootPos: vm.root.position.toArray() },
    };
  });
  fs.writeFileSync(path.join(out, 'uav_fp_scene.glb'), Buffer.from(res.scene, 'base64'));
  fs.writeFileSync(path.join(out, 'uav_tablet.glb'), Buffer.from(res.tablet, 'base64'));
  fs.writeFileSync(path.join(out, 'screen_idle.png'), Buffer.from(res.idle.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, 'screen_launched.png'), Buffer.from(res.launched.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, 'export_info.json'), JSON.stringify(res.info, null, 1));
  console.log(JSON.stringify({ ...res.info, bones: res.info.bones.length, parts: res.info.parts }));
  await b.close();
})();
