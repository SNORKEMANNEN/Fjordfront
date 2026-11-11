// node tools/bootprof.cjs [query] -> CPU profile of boot, top self-time and inclusive-time functions
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  const c = await p.context().newCDPSession(p);
  await c.send('Profiler.enable');
  await c.send('Profiler.setSamplingInterval', { interval: 500 });
  await c.send('Profiler.start');
  await p.goto('http://127.0.0.1:5173/?' + (process.argv[2] || 'quality=high&weather=clear'), { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 200 });
  const { profile } = await c.send('Profiler.stop');
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const self = new Map(), incl = new Map();
  const dts = profile.timeDeltas;
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0].split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (dts[i + 1] ?? 0) / 1000;
    let id = profile.samples[i];
    const k0 = key(nodes.get(id));
    self.set(k0, (self.get(k0) || 0) + dt);
    const seen = new Set();
    while (id != null) {
      const k = key(nodes.get(id));
      if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); }
      id = parent.get(id);
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms  ${k}`).join('\n');
  // call tree under a named function (inclusive ms), depth-limited
  const ROOT = process.env.TREE;
  if (ROOT) {
    const tot = new Map();
    const nodeTime = new Map();
    for (let i = 0; i < profile.samples.length; i++) nodeTime.set(profile.samples[i], (nodeTime.get(profile.samples[i]) || 0) + (dts[i + 1] ?? 0) / 1000);
    const inclN = (n) => { if (tot.has(n.id)) return tot.get(n.id); let t = nodeTime.get(n.id) || 0; for (const c of n.children || []) t += inclN(nodes.get(c)); tot.set(n.id, t); return t; };
    const agg = new Map();
    const walk = (n, depth, path) => {
      if (depth > Number(process.env.DEPTH || 2)) return;
      for (const c of n.children || []) { const cn = nodes.get(c); const k = path + ' > ' + key(cn); agg.set(k, (agg.get(k) || 0) + inclN(cn)); walk(cn, depth + 1, k); }
    };
    for (const n of profile.nodes) if (key(n).startsWith(ROOT + ' ')) walk(n, 1, ROOT);
    console.log([...agg.entries()].filter(([, v]) => v > 40).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${v.toFixed(0).padStart(7)} ${k}`).join('\n'));
  }
  console.log('=== SELF ===\n' + top(self, Number(process.env.N || 40)));
  console.log('=== INCLUSIVE ===\n' + top(incl, Number(process.env.N2 || 70)));
  await b.close();
})();
