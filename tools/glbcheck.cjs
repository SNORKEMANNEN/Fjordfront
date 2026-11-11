const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await p.goto('http://127.0.0.1:5173/tools/glbview.html');
  await p.waitForFunction(() => window.ready);
  console.log(JSON.stringify(await p.evaluate((u) => window.load(u), process.argv[2])));
  const times = JSON.parse(process.argv[4] || '[0]');
  for (const t of times) {
    const d = await p.evaluate((t) => window.at(t), t);
    fs.writeFileSync(`${process.argv[3]}_${t}.jpg`, Buffer.from(d.split(',')[1], 'base64'));
  }
  await b.close();
})();
