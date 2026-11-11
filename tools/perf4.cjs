const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=high&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game; g.startMatch(); g.view(0, 10, 0, 0); g.step(60, 1 / 60, false);
    const path = (o) => { const n = []; let x = o; while (x && n.length < 5) { n.push(x.name || x.type); x = x.parent; } return n.join('<'); };
    const groups = {};
    g.scene.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isPoints) || !o.visible) return;
      let vis = true; let x = o; while (x) { if (!x.visible) vis = false; x = x.parent; }
      if (!vis) return;
      const gm = o.geometry; const idx = gm.index ? gm.index.count : gm.attributes.position?.count ?? 0;
      const inst = o.isInstancedMesh ? o.count : 1;
      const tris = Math.round(idx / 3 * inst);
      const k = o.isSkinnedMesh ? 'SKINNED ' + path(o).split('<').slice(-2).join('<') : o.name === 'baked' ? 'baked<' + path(o).split('<').slice(1, 3).join('<') : path(o).split('<').slice(0, 3).join('<');
      groups[k] = groups[k] || { n: 0, tris: 0, shadow: 0 };
      groups[k].n++; groups[k].tris += tris; if (o.castShadow) groups[k].shadow++;
    });
    return Object.entries(groups).sort((a, c) => c[1].tris - a[1].tris).slice(0, 30);
  });
  for (const [k, v] of r) console.log(String(v.tris).padStart(9), String(v.n).padStart(4), 'shadow', v.shadow, ' ', k);
  await b.close();
})();
