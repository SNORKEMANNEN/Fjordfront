// node tools/grid.cjs name '[[x,z,yaw,pitch,y?],...]'
const { chromium } = require('playwright');
(async () => {
  const [name, views] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: +(process.env.W || 960), height: +(process.env.H || 540) } });
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await p.goto('http://localhost:5173/?test&' + (process.env.Q || 'weather=clear'), { timeout: 180000 });
  await p.waitForFunction(() => window.__ready || document.querySelector('.fatal'), null, { timeout: 300000, polling: 500 });
  if (process.env.PRE) await p.evaluate(process.env.PRE);
  const url = await p.evaluate(`game.grid(${views})`);
  require('fs').writeFileSync(`tools/shots/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(logs.slice(0, 20).join('\n'));
  await b.close();
})();
