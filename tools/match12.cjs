const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[error] ' + m.text().slice(0, 200)); });
  await p.goto('http://127.0.0.1:5173/?test&weather=clear', { timeout: 180000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
  const r = await p.evaluate(async (secs) => {
    const g = window.game;
    const log = [];
    const said = [];
    const say0 = g.radio.say.bind(g.radio);
    g.radio.say = (spk, line, t, o) => { const ok = say0(spk, line, t, o); if (ok) said.push(`${t.toFixed(0)}s ${spk}:${line}`); return ok; };
    const bed0 = g.audio.music.bedTo.bind(g.audio.music);
    g.audio.music.bedTo = (id, f) => { said.push(`${g.time.toFixed(0)}s MUSIC ${id}`); return bed0(id, f); };
    const st0 = g.audio.music.sting.bind(g.audio.music);
    g.audio.music.sting = (id) => { said.push(`${g.time.toFixed(0)}s STING ${id}`); return st0(id); };
    g.startMatch();
    // spawn spread check: min distance between teammates at the opening
    const sp = [0, 1].map((t) => g.match.players.filter((c) => c.team === t).map((c) => c.position().clone()));
    const minD = sp.map((ps) => { let m = 1e9; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z)); return m.toFixed(1); });
    log.push(`players ${g.match.players.length} teams ${sp[0].length}v${sp[1].length} opening min spacing ${minD}`);
    g.player.frozen = true;
    g.avatar.alive = false; g.player.dead = true; g.respawnT = 1e9;
    const t0 = performance.now();
    let spawnClose = 0, spawns = 0;
    for (const bt of g.bots) { const s0 = bt.spawn.bind(bt); bt.spawn = (pos, yaw) => { spawns++; const e = g.match.players.filter((c) => c.alive && c.team !== bt.team); if (e.some((c) => Math.hypot(c.position().x - pos.x, c.position().z - pos.z) < 18)) spawnClose++; return s0(pos, yaw); }; }
    for (let s = 0; s < secs; s += 20) {
      for (let k = 0; k < 40; k++) { if (g.state !== 'playing') break; g.step(30, 1 / 60, false); }
      log.push(`t=${s + 20} score ${g.match.scores} flags ${g.dom.flags.map((f) => f.letter + f.owner).join(' ')} alive ${g.bots.filter((b) => b.alive).length} kills ${g.match.players.reduce((a, p) => a + p.kills, 0)} state ${g.state}`);
      if (g.state !== 'playing') break;
    }
    log.push(`sim ms/frame ${((performance.now() - t0) / (secs * 60)).toFixed(2)} respawns ${spawns} near-enemy(<18m) ${spawnClose}`);
    return log.join('\n') + '\n--- radio/music ---\n' + said.join('\n');
  }, +(process.argv[2] || 300));
  console.log(r);
  await b.close();
})();
