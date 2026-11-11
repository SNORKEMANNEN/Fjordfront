// node tools/simprof.cjs -> CPU profile of N simulated match frames (no rendering): top self / inclusive
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  await p.goto('http://127.0.0.1:5173/?test&quality=medium&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 200 });
  await p.evaluate(() => { const g = window.game; g.startMatch(); g.step(300, 1 / 60, false); });
  const c = await p.context().newCDPSession(p);
  await c.send('Profiler.enable');
  await c.send('Profiler.setSamplingInterval', { interval: 200 });
  await c.send('Profiler.start');
  const ms = await p.evaluate((n) => { const g = window.game; const t = performance.now(); g.step(n, 1 / 60, false); return (performance.now() - t) / n; }, Number(process.env.FRAMES || 1200));
  const { profile } = await c.send('Profiler.stop');
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const self = new Map(), incl = new Map();
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0].split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000; total += dt;
    let id = profile.samples[i];
    const k0 = key(nodes.get(id)); self.set(k0, (self.get(k0) || 0) + dt);
    const seen = new Set();
    while (id != null) { const k = key(nodes.get(id)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); } id = parent.get(id); }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
  console.log(`sim ${ms.toFixed(2)} ms/frame\n=== SELF ===\n${top(self, 30)}\n=== INCLUSIVE ===\n${top(incl, 60)}`);
  await b.close();
})();
