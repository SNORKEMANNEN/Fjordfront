import { build } from 'esbuild';
const r = await build({ entryPoints: ['src/world/MapLayout.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['three'] });
import fs from 'fs'; fs.writeFileSync('tools/.probe.mjs', r.outputFiles[0].text);
const m = await import('./.probe.mjs');
const pts = JSON.parse(process.argv[2] || '[[0,10],[0,0],[-30,0],[30,0],[0,-80],[38,-142],[0,80],[50,80],[-40,136],[40,172],[-100,0],[120,80]]');
for (const [x, z] of pts) console.log(x, z, 'nat', m.naturalHeight(x, z).toFixed(2), 'final', m.terrainHeight(x, z).toFixed(2));
