const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=' + (process.argv[2] || 'high') + '&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate((pos) => {
    const g = window.game; g.startMatch(); g.view(...pos); Object.defineProperty(g.avatar, 'health', { get: () => 100, set: () => {} }); g.step(60, 1 / 60, false);
    const R = g.renderer;
    const acc = {}; let pass = 0; let inMain = false;
    const rend0 = R.render.bind(R);
    R.render = (scene, cam) => { pass++; inMain = scene === g.scene && pass === 1; rend0(scene, cam); inMain = false; };
    const rbd = R.renderBufferDirect.bind(R);
    R.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      if (inMain) {
        let n = object.name || object.type; let x = object.parent; let depth = 0; while (x && depth < 2 && !n.includes('static') && !n.includes('terrain')) { n += '<' + (x.name || x.type); x = x.parent; depth++; }
        if (object.isSkinnedMesh) n = 'SKINNED soldier';
        if (n.startsWith('baked') || n.startsWith('gunProxy')) n = n.split('<')[0];
        const idx = geometry.index ? geometry.index.count : geometry.attributes.position.count;
        let dc = group ? group.count : idx;
        if (object.isInstancedMesh) dc *= object.count;
        if (object.isBatchedMesh) dc = -1;
        acc[n] = acc[n] || { calls: 0, tris: 0 }; acc[n].calls++; acc[n].tris += Math.round(dc / 3);
      }
      return rbd(camera, scene, geometry, material, object, group);
    };
    g.step(1, 1 / 60, true);
    return Object.entries(acc).sort((a, c) => c[1].tris - a[1].tris).slice(0, 22);
  }, JSON.parse(process.argv[3] || '[0,10,0,0]'));
  for (const [k, v] of r) console.log(String(v.tris).padStart(9), String(v.calls).padStart(4), ' ', k);
  await b.close();
})();
