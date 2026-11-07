const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
  const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas>');
  const r = await p.evaluate(() => { const g = document.getElementById('c').getContext('webgl2'); if(!g) return 'no webgl2'; const d=g.getExtension('WEBGL_debug_renderer_info'); return [g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER), g.getParameter(g.MAX_TEXTURE_SIZE), !!g.getExtension('EXT_color_buffer_float'), 'gpu' in navigator].join(' | '); });
  console.log(r); await b.close();
})();
