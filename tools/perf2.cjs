// Per-frame render workload (draw calls / triangles per pass) and bot CPU breakdown.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://127.0.0.1:5173/?test&weather=' + (process.argv[2] || 'clear') + '&quality=' + (process.argv[3] || 'high') + '&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(() => {
    const g = window.game; g.startMatch();
    g.view(0, 10, 0, 0); Object.defineProperty(g.avatar, 'health', { get: () => 100, set: () => {} });
    g.step(120, 1 / 60, false);
    const now = () => performance.now();
    // ---- bot breakdown
    const BP = Object.getPrototypeOf(g.bots[0]);
    const T = {};
    const wrapP = (proto, fn, key) => { const o = proto[fn]; if (!o) return; proto[fn] = function (...a) { const t = now(); const res = o.apply(this, a); T[key] = (T[key] || 0) + now() - t; return res; }; };
    for (const fn of ['update', 'perceive', 'poseUpperBody', 'updateHitbox', 'followPath', 'pickGoal', 'shoot', 'seekCover', 'puppet']) wrapP(BP, fn, 'bot.' + fn);
    const bodyP = Object.getPrototypeOf(g.bots[0].body);
    wrapP(bodyP, 'move', 'body.move');
    wrapP(bodyP, 'setStance', 'body.setStance');
    wrapP(Object.getPrototypeOf(g.nav), 'path', 'nav.path');
    wrapP(Object.getPrototypeOf(g.director), 'pathOpts', 'director.pathOpts');
    for (const fn of ['onBotShot', 'footstepSound', 'animInterval', 'updateRadar', 'recordFrame', 'updateDoors', 'updateGlints', 'updateStreakWorld', 'updateDominationHUD', 'botVoice']) if (g[fn]) wrapP(g, fn, 'game.' + fn);
    wrapP(Object.getPrototypeOf(g.ballistics), 'update', 'ballistics.update');
    wrapP(Object.getPrototypeOf(g.dom), 'update', 'dom.update');
    wrapP(Object.getPrototypeOf(g.audio), 'play', 'audio.play');
    const mixP = Object.getPrototypeOf(g.bots[0].mixer);
    wrapP(mixP, 'update', 'bot.mixer');
    wrapP(Object.getPrototypeOf(g.physics), 'raycast', 'physics.raycast');
    wrapP(Object.getPrototypeOf(g.physics), 'lineOfSight', 'physics.los');
    let rc = 0, los = 0;
    const r0 = g.physics.raycast.bind(g.physics), l0 = g.physics.lineOfSight.bind(g.physics);
    g.physics.raycast = (...a) => { rc++; return r0(...a); };
    g.physics.lineOfSight = (...a) => { los++; return l0(...a); };
    const N = 300;
    const t0 = now();
    g.step(N, 1 / 60, false);
    const sim = (now() - t0) / N;
    const bots = {}; for (const k in T) bots[k] = +(T[k] / N).toFixed(3);
    // ---- render workload per pass
    const R = g.renderer;
    R.info.autoReset = false;
    const passes = [];
    const rend0 = R.render.bind(R);
    R.render = (scene, cam) => { const c0 = R.info.render.calls, t0 = R.info.render.triangles; rend0(scene, cam); passes.push({ scene: scene.name || scene.type, cam: cam.name || cam.type, target: R.getRenderTarget() ? `${R.getRenderTarget().width}x${R.getRenderTarget().height}` : 'screen', calls: R.info.render.calls - c0, tris: R.info.render.triangles - t0 }); };
    R.info.reset();
    g.step(1, 1 / 60, true);
    const total = { calls: R.info.render.calls, tris: R.info.render.triangles };
    // aggregate passes
    const agg = {};
    for (const ps of passes) { const k = `${ps.scene}/${ps.cam}@${ps.target}`; agg[k] = agg[k] || { n: 0, calls: 0, tris: 0 }; agg[k].n++; agg[k].calls += ps.calls; agg[k].tris += ps.tris; }
    let lights = 0; g.scene.traverse((o) => { if (o.isLight && o.visible && o.intensity > 0) lights++; });
    let shadowCasters = 0; g.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.castShadow && o.visible) shadowCasters++; });
    return { simMsPerFrame: +sim.toFixed(2), bots, raycastsPerFrame: +(rc / N).toFixed(1), losPerFrame: +(los / N).toFixed(1), total, passes: agg, lights, shadowCasters, size: [R.domElement.width, R.domElement.height], pixelRatio: R.getPixelRatio(), programs: R.info.programs.length };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
