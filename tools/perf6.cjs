const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=high&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game; g.startMatch(); g.view(0, 10, 0, 0); g.step(30, 1 / 60, false);
    const R = g.renderer; R.info.autoReset = false;
    const res = [];
    g.scene.traverse((o) => { if (o.isBatchedMesh) res.push(o); });
    const out = [];
    for (const bm of res) {
      const vis = []; g.scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { vis.push([o, o.visible]); o.visible = o === bm; } });
      R.info.reset(); R.render(g.scene, g.camera);
      out.push([bm.name || bm.material.name || 'batched', R.info.render.calls, R.info.render.triangles, bm.instanceCount ?? bm._instanceInfo?.length]);
      for (const [o, v] of vis) o.visible = v;
    }
    return out;
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
