const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=high&time=' + (process.argv[2] || 'day'), { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game; g.startMatch(); g.view(0, 10, 0, 0); Object.defineProperty(g.avatar, 'health', { get: () => 100, set: () => {} }); g.step(60, 1 / 60, false);
    const R = g.renderer; R.info.autoReset = false;
    const passes = []; const rend0 = R.render.bind(R);
    R.render = (scene, cam) => { const c0 = R.info.render.calls, t0 = R.info.render.triangles; rend0(scene, cam); if (cam.isPerspectiveCamera) passes.push({ cam: cam.name || '?', fov: Math.round(cam.fov), layers: cam.layers.mask, scene: scene === g.scene ? 'world' : scene === g.vmScene ? 'viewmodel' : 'other', target: R.getRenderTarget() ? `${R.getRenderTarget().width}x${R.getRenderTarget().height}` : 'screen', calls: R.info.render.calls - c0, tris: R.info.render.triangles - t0 }); };
    R.info.reset(); g.step(1, 1 / 60, true);
    const lights = []; g.scene.traverse((o) => { if (o.isLight && o.visible) lights.push(`${o.type}:${o.intensity.toFixed(1)}${o.castShadow ? ':shadow' : ''}`); });
    // biggest triangle contributors in the world scene (visible meshes)
    const top = []; g.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh || o.isBatchedMesh) && o.visible) { const gm = o.geometry; const idx = gm.index ? gm.index.count : gm.attributes.position.count; const inst = o.isInstancedMesh ? o.count : 1; top.push([o.name || o.type, Math.round(idx / 3 * inst), o.material?.type ?? '']); } });
    top.sort((a, c) => c[1] - a[1]);
    return { passes, lights, top: top.slice(0, 25) };
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
