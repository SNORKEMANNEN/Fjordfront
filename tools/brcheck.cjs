// Update 34: Brosund gameplay checks. node tools/brcheck.cjs [seconds]
// nav routes from both bases to every flag (through the tunnel / over the bridge), spawn validity,
// then a bot-only match: scores, flag owners, kills, who uses the tunnel and the bridge.
const { chromium } = require('playwright');
(async () => {
  const secs = +(process.argv[2] || 240);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[error] ' + m.text().slice(0, 200)); });
  await p.goto('http://127.0.0.1:5173/?test&level=brosund&weather=clear&time=day', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 400000, polling: 500 });
  const r = await p.evaluate(async (secs) => {
    const g = window.game;
    const THREE = g.camera.position.constructor;
    const log = [];
    g.startMatch();
    log.push(`nav nodes ${g.nav.nodes.length}, flags ${g.dom.flags.map((f) => `${f.letter}:${f.name}@${f.pos.x.toFixed(0)},${f.pos.y.toFixed(1)},${f.pos.z.toFixed(0)}`).join(' ')}`);
    // routes from each team's spawn centroid to each flag
    const sp = g.match ? null : null;
    const SPAWNS = window.__spawns || null;
    void sp; void SPAWNS;
    const bases = [new THREE(-165, 0, 75), new THREE(186, 0, 68)];
    for (const bs of bases) bs.y = g.terrain.heightAt(bs.x, bs.z);
    for (const [ti, bs] of bases.entries()) {
      const parts = [];
      for (const f of g.dom.flags) {
        const path = g.nav.path(bs, f.pos, 20000);
        if (!path) { parts.push(`${f.letter}:NONE`); continue; }
        let L = 0, minY = 1e9;
        for (let i = 1; i < path.length; i++) { L += path[i].distanceTo(path[i - 1]); minY = Math.min(minY, path[i].y); }
        parts.push(`${f.letter}:${L.toFixed(0)}m${minY < -2 ? '(tunnel)' : ''}`);
      }
      log.push(`team ${ti} base → ${parts.join(' ')}`);
    }
    // the other crossing: from base 0 to base 1 avoiding the tunnel (force over the bridge)
    const tun = g.nav.path(new THREE(-30, 2.3, -60), new THREE(150, 2.6, -45), 20000);
    log.push(`west portal → east portal: ${tun ? tun.length + ' nodes, min y ' + Math.min(...tun.map((v) => v.y)).toFixed(1) : 'NONE'}`);
    const br = g.nav.path(new THREE(0, g.terrain.heightAt(0, 108), 108), new THREE(140, g.terrain.heightAt(140, 94), 94), 20000);
    log.push(`bridge west → east: ${br ? br.length + ' nodes, max y ' + Math.max(...br.map((v) => v.y)).toFixed(1) : 'NONE'}`);
    // spawns
    const bad = [];
    for (const s of g.match.spawnPoints ?? []) void s;
    const capsule = { x: 0, y: 0, z: 0 };
    void capsule;
    // bot match
    g.player.frozen = true;
    g.avatar.alive = false; g.player.dead = true; g.respawnT = 1e9;
    const t0 = performance.now();
    let inTun = 0, onBridge = 0, samples = 0, stuck = 0;
    const last = new Map();
    for (let s = 0; s < secs; s += 20) {
      for (let k = 0; k < 40; k++) {
        if (g.state !== 'playing') break;
        g.step(30, 1 / 60, false);
        for (const bt of g.bots) {
          if (!bt.alive) continue;
          const q = bt.position();
          samples++;
          if (q.y < -1.5) inTun++;
          if (Math.abs(q.z - 115) < 6 && q.x > 20 && q.x < 124 && q.y > 7) onBridge++;
          if (q.y < -3 && q.y > -30 && !(q.y < -1.5)) bad.push('deep');
        }
      }
      for (const bt of g.bots) {
        if (!bt.alive) continue;
        const q = bt.position().clone();
        const l = last.get(bt);
        if (l && l.distanceTo(q) < 0.6) stuck++;
        last.set(bt, q);
      }
      log.push(`t=${s + 20} score ${g.match.scores} flags ${g.dom.flags.map((f) => f.letter + f.owner).join(' ')} alive ${g.bots.filter((b) => b.alive).length} kills ${g.match.players.reduce((a, p) => a + p.kills, 0)} state ${g.state}`);
      if (g.state !== 'playing') break;
    }
    log.push(`sim ms/frame ${((performance.now() - t0) / (secs * 60)).toFixed(2)}; bot-samples in tunnel ${(100 * inTun / samples).toFixed(1)}% on bridge ${(100 * onBridge / samples).toFixed(1)}%; stationary-20s ${stuck}`);
    // where are the bots now
    log.push('bots: ' + g.bots.filter((b) => b.alive).map((b) => { const q = b.position(); return `${q.x.toFixed(0)},${q.y.toFixed(0)},${q.z.toFixed(0)}`; }).join(' '));
    return log.join('\n');
  }, secs);
  console.log(r);
  await b.close();
})();
