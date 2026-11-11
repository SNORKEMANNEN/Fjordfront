// node tools/allocprof.cjs -> allocation sampling during N match frames (top allocating functions, incl. collected objects)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  await p.goto('http://127.0.0.1:5173/?test&quality=medium&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 200 });
  await p.evaluate(() => { const g = window.game; g.startMatch(); g.step(300, 1 / 60, false); });
  const c = await p.context().newCDPSession(p);
  await c.send('HeapProfiler.enable');
  await c.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const N = Number(process.env.FRAMES || 600);
  const mem = await p.evaluate((n) => { const g = window.game; const m0 = performance.memory.usedJSHeapSize; g.step(n, 1 / 60, !!window.__renderToo); return performance.memory.usedJSHeapSize - m0; }, N);
  const { profile } = await c.send('HeapProfiler.stopSampling');
  const self = new Map();
  let total = 0;
  const walk = (n, stack) => {
    const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0].split('?')[0]}:${n.callFrame.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + n.selfSize);
    total += n.selfSize;
    for (const ch of n.children) walk(ch, stack);
  };
  walk(profile.head, []);
  console.log(`allocated ~${(total / 1024 / 1024).toFixed(1)} MB over ${N} frames = ${(total / N / 1024).toFixed(1)} KB/frame`);
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${(v / N / 1024).toFixed(2).padStart(7)} KB/f  ${k}`).join('\n'));
  await b.close();
})();
