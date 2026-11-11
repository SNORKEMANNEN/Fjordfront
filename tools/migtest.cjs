// Three-tab test: bandwidth of the binary snapshots, then host migration (the host tab closes).
const { chromium } = require('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 480, height: 270 }, permissions: ['microphone'] });
  const open = async (tag) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
    p.on('console', (m) => { if ((m.type() === 'error' && !/lobby-registry/.test(m.text())) || /\[net\]|\[voice\]/.test(m.text())) console.log(`[${tag} ${m.type()}] ${m.text().slice(0, /DBG/.test(m.text()) ? 4000 : 300)}`); });
    await p.goto('http://127.0.0.1:5173/?test&weather=clear&quality=low&peer=127.0.0.1:9000', { timeout: 180000 });
    await p.waitForFunction(() => window.__ready, null, { timeout: 300000, polling: 500 });
    await p.evaluate(() => { window.__dbg = (...a) => console.warn('[net] DBG', ...a); });
    return p;
  };
  const H = await open('host'), A = await open('A'), B = await open('B');
  const SKIPBW = !!process.env.FAST;
  const code = await H.evaluate(async () => { game.netg.name = 'Hosty'; game.netg.isPublic = false; const c = await game.netg.host(); game.startMatch(); return c; });
  await A.evaluate(async (c) => { game.netg.name = 'Anna'; await game.netg.join(c); }, code);
  await wait(300);
  await B.evaluate(async (c) => { game.netg.name = 'Bjorn'; await game.netg.join(c); }, code);
  const pages = [H, A, B];
  const run = async (n, ps = pages) => { for (let i = 0; i < n; i++) { for (const p of ps) await p.evaluate(() => game.step(2, 1 / 60, false)); await wait(4); } };
  await run(40);
  // bandwidth: count bytes for ~4 s of play
  for (const p of pages) await p.evaluate(() => { const n = game.netg.net; n.__b = 0; const s0 = n.sendState.bind(n); n.sendState = (buf, to) => { const ok = s0(buf, to); if (ok) n.__b += buf.byteLength; return ok; }; const j0 = n.send.bind(n); n.send = (m, to) => { n.__b += JSON.stringify(m).length; return j0(m, to); }; const bc = n.broadcast.bind(n); n.broadcast = (m, ex) => { n.__b += JSON.stringify(m).length * Math.max(0, n.conns.size - (ex ? 1 : 0)); return bc(m, ex); }; n.__t = game.time; });
  if (!SKIPBW) await run(60);
  const bw = [];
  for (const p of pages) bw.push(await p.evaluate(() => { const n = game.netg.net; return { role: n.role, Bps: Math.round(n.__b / (game.time - n.__t)), st: n.hasState(), interp: Math.round(game.netg.interpDelay * 1000) }; }));
  console.log('bandwidth per second of game time', JSON.stringify(bw));
  // voice: A and B turn voice on (fake mic) → a call between them
  await A.evaluate(() => game.netg.toggleVoice());
  await B.evaluate(() => game.netg.toggleVoice());
  await run(SKIPBW ? 20 : 80);
  const vc = [];
  for (const p of [A, B]) vc.push(await p.evaluate(() => ({ on: game.netg.voice.on, links: [...game.netg.voice.links.values()].map((l) => ({ slot: l.slot, stream: !!l.gain })) })));
  console.log('voice', JSON.stringify(vc));
  console.log('rosters before', JSON.stringify(await Promise.all(pages.map((p) => p.evaluate(() => game.netg.roster.filter((s) => s.human).map((s) => s.name + '@' + s.slot + (s.pid ? '+pid' : '') + (s.vc ? '+vc' : '')))))));
  const slots = await Promise.all([A, B].map((p) => p.evaluate(() => game.netg.mySlot)));
  console.log('slots A,B', slots, 'host is', await H.evaluate(() => game.netg.mySlot));
  // ---- the host leaves
  await H.close();
  const heir = slots[0] < slots[1] ? A : B, other = heir === A ? B : A;
  for (let i = 0; i < 60; i++) {
    await run(2, [A, B]);
    await wait(400);
    if (i % 5 === 0) console.log('t+', i, JSON.stringify(await Promise.all([A, B].map((p) => p.evaluate(() => { const pe = game.netg.net.peer; return game.netg.net.role + (game.netg.migrating ? ' (migrating)' : '') + ' peer ' + (pe ? `${pe.id} open=${pe.open} disc=${pe.disconnected} destroyed=${pe.destroyed}` : 'none'); })))));
    const ok = await heir.evaluate(() => game.netg.isHost) && await other.evaluate(() => game.netg.isClient && game.netg.net.conns !== undefined);
    if (ok && i > 5) break;
  }
  await run(60, [A, B]);
  const hs = await heir.evaluate(() => ({ role: game.netg.net.role, humans: game.netg.roster.filter((s) => s.human).map((s) => s.name + '@' + s.slot + (s.host ? '*' : '')), botsAI: game.bots.filter((b) => !b.netPuppet && b.alive).length, state: game.state, time: Math.round(game.match.timeLeft), conns: game.netg.net.conns.size }));
  const os = await other.evaluate(() => ({ role: game.netg.net.role, slot: game.netg.mySlot, state: game.state, time: Math.round(game.match.timeLeft), humans: game.netg.roster.filter((s) => s.human).map((s) => s.name + '@' + s.slot + (s.host ? '*' : '')) }));
  for (const [n, p] of [['heir', heir], ['other', other]]) console.log(n, 'chat:', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.netchat .lines div')].map((d) => d.textContent))));
  console.log('heir', JSON.stringify(hs));
  console.log('other', JSON.stringify(os));
  const hb = await heir.evaluate(() => game.bots.filter((b) => !b.netPuppet && b.alive).slice(0, 3).map((b) => [b.id, ...b.position().toArray().map((v) => +v.toFixed(1))]));
  await run(10, [A, B]);
  const ob = await other.evaluate((ids) => ids.map((id) => { const b = game.bots.find((x) => x.id === id[0]); return b ? [b.id, ...b.position().toArray().map((v) => +v.toFixed(1)), b.alive] : null; }), hb);
  console.log('new host bots', JSON.stringify(hb), '\nother sees    ', JSON.stringify(ob));
  await b.close();
})();
