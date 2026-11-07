// node tools/seq.cjs name 'setupJS' 'js1' 'js2' ...  -> each js runs then a frame is captured into a 2-col grid
const { chromium } = require('playwright');
(async () => {
  const [name, setup, ...steps] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&' + (process.env.Q || 'weather=clear'), { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  await p.evaluate(setup);
  const shots = [];
  for (const s of steps) {
    const r = await p.evaluate(s);
    if (r !== undefined && r !== null && typeof r !== 'object') console.log('->', r);
    shots.push(await p.screenshot({ type: 'jpeg', quality: 80, timeout: 180000 }));
  }
  await p.evaluate(async (imgs) => {
    const c = document.createElement('canvas');
    const cols = 2, rows = Math.ceil(imgs.length / cols);
    c.width = 960; c.height = 270 * rows;
    const x = c.getContext('2d');
    for (let i = 0; i < imgs.length; i++) {
      const im = new Image();
      im.src = 'data:image/jpeg;base64,' + imgs[i];
      await im.decode();
      x.drawImage(im, (i % cols) * 480, Math.floor(i / cols) * 270, 480, 270);
    }
    window.__grid = c.toDataURL('image/jpeg', 0.85);
  }, shots.map((s) => s.toString('base64')));
  const url = await p.evaluate(() => window.__grid);
  require('fs').writeFileSync(`tools/shots/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(logs.slice(0, 15).join('\n'));
  await b.close();
})();
