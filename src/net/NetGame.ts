import * as THREE from 'three';
import { Net, NetMsg, cleanCode } from './Net';
import { NETF } from './NetFlags';
import type { Combatant, HitPart } from '../game/Combatant';
import { Bot } from '../ai/Bot';
import { WEAPONS, WeaponDef } from '../weapons/WeaponDefs';

/**
 * Multiplayer on top of the single-player game: one player hosts (their browser runs the bots, the
 * flags, the score and the clock), everyone else joins with a room code. Every soldier occupies one
 * of 24 slots; humans take over bot slots, and bots fill whatever is left.
 *
 *  - each machine owns its own player; the host owns the bots (see NetFlags for the damage rules)
 *  - 20 Hz: clients send their pose; the host sends every slot's pose, flags, score and clock
 *  - events: shots (replayed as harmless "ghost" bullets elsewhere), hits (to the victim's owner),
 *    deaths (decided by the owner, then everyone plays them), grenades / streaks (re-simulated
 *    everywhere), doors, chat and roster changes
 *
 * Chat [Enter] doubles as the console: /help lists the commands.
 */
const RATE = 1 / 20;
const VER = 1;
const SLOTS = 24;
type Slot = { slot: number; name: string; team: 0 | 1; human: boolean; disabled: boolean; peer?: string };
const r2 = (v: number) => Math.round(v * 100) / 100;

export class NetGame {
  net = new Net();
  name = 'Player';
  /** client: my slot / team */
  mySlot = 0;
  roster: Slot[] = [];
  /** host: peer id → slot */
  private peerSlot = new Map<string, number>();
  /** latest replicated pose per slot (host relays human poses) */
  private poses = new Map<number, number[]>();
  private sendT = 0;
  private doorT = 0;
  private envT = 0;
  private outShots: unknown[] = [];
  private replaying = 0;
  private botTarget = -1;
  /** for /net */
  rtt = 0;
  private pingSent = 0;

  // ui
  private chatEl: HTMLDivElement;
  private chatLines: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private statusEl: HTMLDivElement;
  private panel: HTMLDivElement | null = null;
  typing = false;

  constructor(private g: any) {
    this.name = (localStorage.getItem('ff.name') || '').slice(0, 16) || `Soldat${Math.floor(100 + Math.random() * 900)}`;
    const root: HTMLElement = g.ui.root;
    this.chatEl = document.createElement('div');
    this.chatEl.className = 'netchat';
    this.chatEl.innerHTML = `<div class="lines"></div><input class="hidden" maxlength="140" spellcheck="false" placeholder="Say something, or /help">`;
    root.appendChild(this.chatEl);
    this.chatLines = this.chatEl.querySelector('.lines') as HTMLDivElement;
    this.chatInput = this.chatEl.querySelector('input') as HTMLInputElement;
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'netstatus hidden';
    root.appendChild(this.statusEl);
    // Enter opens chat while playing; typed keys never reach the game
    window.addEventListener('keydown', (e) => {
      if (this.g.state !== 'playing' && this.g.state !== 'paused' && !this.typing) return;
      if (!this.typing && (e.code === 'Enter' || e.code === 'Slash') && this.g.state === 'playing') {
        e.preventDefault();
        this.openChat(e.code === 'Slash' ? '/' : '');
        return;
      }
      if (!this.typing) return;
      e.stopImmediatePropagation();
      if (e.code === 'Enter') {
        e.preventDefault();
        const text = this.chatInput.value.trim();
        this.closeChat();
        if (text) this.submit(text);
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.closeChat();
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (this.typing) e.stopImmediatePropagation();
    }, true);
    const n = this.net;
    n.onMessage = (from, m) => this.onMessage(from, m);
    n.onPeerLeave = (id) => this.onLeave(id);
    n.onClosed = (why) => this.onHostGone(why);
    NETF.route = (victim, from, amount, dir, part, weapon) => this.route(victim, from, amount, dir, part, weapon);
    this.wrapGame();
  }

  get active() {
    return this.net.role !== 'off';
  }
  get isHost() {
    return this.net.role === 'host';
  }
  get isClient() {
    return this.net.role === 'client';
  }
  inviteLink() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('join', this.net.code);
    const peer = new URLSearchParams(location.search).get('peer');
    if (peer) u.searchParams.set('peer', peer);
    return u.toString();
  }

  // ================================================================ slots & ownership
  /** the combatant in a slot on this machine */
  bySlot(s: number): Combatant | null {
    const g = this.g;
    if (g.avatar.id === s) return g.avatar;
    return g.bots.find((b: Bot) => b.id === s) ?? null;
  }
  /** decided on this machine? */
  owns(c: Combatant) {
    if (!this.active) return true;
    if (c === this.g.avatar) return true;
    return this.isHost && !(c as Bot).netPuppet;
  }

  private defaultRoster(): Slot[] {
    const g = this.g;
    const out: Slot[] = [{ slot: 0, name: this.name, team: g.avatar.team, human: true, disabled: false }];
    for (const b of g.bots as Bot[]) out.push({ slot: b.id, name: b.botName || b.name, team: b.team, human: false, disabled: !!b.netDisabled });
    return out.sort((a, b) => a.slot - b.slot);
  }

  // ================================================================ hosting / joining
  async host() {
    NETF.active = true;
    const code = await this.net.host();
    const g = this.g;
    for (const b of g.bots as Bot[]) if (!b.botName) b.botName = b.name;
    g.avatar.name = this.name;
    this.roster = this.defaultRoster();
    this.sys(`Hosting room <b>${code}</b>. Invite: <span class="sel">${this.inviteLink()}</span>`);
    this.sys('Friends join with MULTIPLAYER → JOIN and this code. Type /help for commands.');
    this.updateStatus();
    return code;
  }

  async join(code: string) {
    NETF.active = true;
    try {
      await this.net.join(cleanCode(code), { t: 'hello', name: this.name, ver: VER });
    } catch (e) {
      NETF.active = false;
      throw e;
    }
  }

  leave() {
    if (!this.active) return;
    this.net.close();
    NETF.active = false;
    location.href = location.pathname;
  }

  /** host: a bot slot for a newcomer, on the side with fewer humans */
  private pickSlot(pref?: 0 | 1): Slot | null {
    const humans = [0, 1].map((t) => this.roster.filter((s) => s.team === t && s.human).length);
    const order: (0 | 1)[] = pref !== undefined ? [pref, (1 - pref) as 0 | 1] : humans[0] <= humans[1] ? [0, 1] : [1, 0];
    for (const t of order) {
      const free = this.roster.filter((s) => s.team === t && !s.human).sort((a, b) => Number(a.disabled) - Number(b.disabled));
      if (free.length) return free[0];
    }
    return null;
  }

  private onJoin(peer: string, m: NetMsg) {
    const g = this.g;
    if (m.ver !== VER) {
      this.net.send({ t: 'kick', why: 'Different game version: refresh both pages.' }, peer);
      setTimeout(() => this.net.kick(peer), 300);
      return;
    }
    const s = this.pickSlot();
    if (!s) {
      this.net.send({ t: 'kick', why: 'The room is full (24 players).' }, peer);
      setTimeout(() => this.net.kick(peer), 300);
      return;
    }
    const name = this.uniqueName(String(m.name || 'Player').slice(0, 16));
    this.assignHuman(s.slot, peer, name);
    this.net.send(this.welcome(s.slot), peer);
    this.broadcastRoster();
    this.sys(`<b>${esc(name)}</b> joined (${g.match.teamNames[s.team]}).`, true);
  }

  private uniqueName(n: string) {
    let name = n.replace(/[<>]/g, '') || 'Player';
    let i = 2;
    while (this.roster.some((s) => s.human && s.name === name)) name = `${n}${i++}`;
    return name;
  }

  private assignHuman(slot: number, peer: string, name: string) {
    const b = this.bySlot(slot) as Bot;
    const s = this.roster.find((x) => x.slot === slot)!;
    s.human = true;
    s.disabled = false;
    s.name = name;
    s.peer = peer;
    this.peerSlot.set(peer, slot);
    b.netDisabled = false;
    b.setPuppet(true);
    b.netHuman = true;
    b.isPlayer = true;
    b.name = name;
    b.netHide();
    this.g.director?.forget?.(b.id);
  }

  private releaseSlot(slot: number) {
    const b = this.bySlot(slot) as Bot;
    const s = this.roster.find((x) => x.slot === slot);
    if (!b || !s) return;
    s.human = false;
    s.peer = undefined;
    s.name = b.botName;
    b.setPuppet(false);
    b.netHuman = false;
    b.isPlayer = false;
    b.name = b.botName;
    b.netHide();
    b.respawnT = 2;
    this.poses.delete(slot);
    this.applyBotCount();
  }

  private onLeave(peer: string) {
    const slot = this.peerSlot.get(peer);
    this.peerSlot.delete(peer);
    if (slot === undefined) return;
    const name = this.roster.find((s) => s.slot === slot)?.name ?? 'Someone';
    this.releaseSlot(slot);
    this.broadcastRoster();
    this.sys(`<b>${esc(name)}</b> left. A bot takes their place.`, true);
  }

  private welcome(slot: number): NetMsg {
    const g = this.g;
    return {
      t: 'welcome', ver: VER, slot, code: this.net.code, roster: this.roster.map(({ peer, ...r }) => (void peer, r)),
      flags: g.dom.flags.map((f: any) => ({ letter: f.letter, name: f.name, p: [f.pos.x, f.pos.y, f.pos.z] })),
      env: this.envState(), match: { scores: g.match.scores, time: g.match.timeLeft, phase: g.match.phase },
    };
  }
  private envState() {
    const e = this.g.env;
    return { hour: e.hour, scale: e.timeScale, weather: e.weather, winter: !!this.g.winter };
  }

  private broadcastRoster() {
    this.net.broadcast({ t: 'roster', roster: this.roster.map(({ peer, ...r }) => (void peer, r)) });
    this.updateStatus();
  }

  // ================================================================ client side
  private onWelcome(m: any) {
    const g = this.g;
    this.mySlot = m.slot;
    this.roster = m.roster;
    // a normal local start (world reset, loadout, HUD), then take the host's match over
    g.startMatch();
    g.dom.setupFixed(m.flags);
    this.applyEnv(m.env, true);
    g.match.scores = m.match.scores;
    g.match.timeLeft = m.match.time;
    for (const b of g.bots as Bot[]) {
      if (!b.botName) b.botName = b.name;
      b.setPuppet(true);
      b.netHide();
    }
    this.applyRoster(true);
    g.respawnPlayer();
    this.sys(`Joined room <b>${esc(m.code)}</b> as <b>${esc(this.name)}</b>. Enter to chat, /help for commands.`);
    if (!g.input.locked) g.ui.notify('CONNECTED', 'CLICK THE SCREEN TO TAKE CONTROL');
  }

  private applyEnv(e: any, full: boolean) {
    const g = this.g;
    if (full) {
      g.winter = e.winter;
      g.env.winter = e.winter;
      g.terrain.winter = e.winter;
      g.world.veg.grass.visible = !e.winter;
      g.env.setWeather(e.weather);
      g.weather.reset(e.winter, e.weather);
    }
    g.env.hour = e.hour;
    g.env.timeScale = e.scale;
    if (g.env.weather !== e.weather) g.env.setWeather(e.weather);
  }

  /** client: map the roster onto this machine's soldiers (my slot is my own player) */
  private applyRoster(first = false) {
    const g = this.g;
    const me = this.roster.find((s) => s.slot === this.mySlot);
    if (me) {
      const changed = g.avatar.team !== me.team;
      g.avatar.id = me.slot;
      g.avatar.team = me.team;
      g.avatar.name = me.name;
      this.name = me.name;
      g.dom.myTeam = me.team;
      if (changed && !first) {
        g.avatar.health = 0;
        g.avatar.alive = false;
        g.respawnPlayer();
      }
    }
    // keep bots whose id already matches a slot; give the leftovers the remaining slots
    const others = this.roster.filter((s) => s.slot !== this.mySlot);
    const bots = g.bots as Bot[];
    const taken = new Set<Bot>();
    const unplaced: Slot[] = [];
    for (const s of others) {
      const b = bots.find((x) => x.id === s.slot && !taken.has(x));
      if (b) taken.add(b);
      else unplaced.push(s);
    }
    const spare = bots.filter((b) => !taken.has(b));
    unplaced.forEach((s, i) => {
      const b = spare[i];
      if (!b) return;
      b.id = s.slot;
      b.netHide();
      taken.add(b);
    });
    for (const s of others) {
      const b = bots.find((x) => x.id === s.slot);
      if (!b) continue;
      if (b.team !== s.team) b.setTeam(s.team, g.teamMats[s.team]);
      b.name = s.name;
      b.netHuman = s.human;
      b.isPlayer = s.human;
      b.netDisabled = s.disabled;
      b.setPuppet(true);
      if (s.disabled && b.alive) b.netHide();
    }
    // a spare soldier left over (my own old slot): park it
    for (const b of bots) if (!taken.has(b)) { b.id = 1000 + b.id; b.netDisabled = true; b.netHide(); }
    this.updateStatus();
  }

  private onHostGone(why: string) {
    this.g.ui.notify('DISCONNECTED', why.toUpperCase());
    this.sys(why);
    NETF.active = false;
    setTimeout(() => (location.href = location.pathname), 3500);
  }

  // ================================================================ messages
  private onMessage(from: string, m: any) {
    const g = this.g;
    switch (m.t) {
      // ---- to the host
      case 'hello':
        if (this.isHost) this.onJoin(from, m);
        return;
      case 'st': {
        if (!this.isHost) return;
        const slot = this.peerSlot.get(from);
        if (slot === undefined) return;
        this.poses.set(slot, m.s);
        (this.bySlot(slot) as Bot)?.netState(m.s);
        if (m.shots) for (const sh of m.shots) this.replayShot(slot, sh);
        if (m.shots?.length) this.outShots.push(...m.shots.map((sh: any) => ({ ...sh, s: slot })));
        return;
      }
      case 'ping':
        this.net.send({ t: 'pong', at: m.at }, this.isHost ? from : undefined);
        return;
      case 'pong':
        this.rtt = performance.now() - m.at;
        return;
      // ---- either way
      case 'hit': {
        if (this.isHost && m.v !== 0 && this.slotPeer(m.v)) {
          // a client hit another client: pass it on
          this.net.send(m, this.slotPeer(m.v));
          return;
        }
        const v = this.bySlot(m.v), a = this.bySlot(m.a);
        if (v && a && this.owns(v)) this.applyHit(v, a, m.dmg, m.part, new THREE.Vector3(...(m.dir as [number, number, number])), m.w);
        return;
      }
      case 'died': {
        if (this.isHost) this.net.broadcast(m, from);
        this.replayDeath(m);
        return;
      }
      case 'nade': {
        if (this.isHost) this.net.broadcast(m, from);
        const o = this.bySlot(m.s);
        if (!o) return;
        this.replaying++;
        try {
          g.explosives.throw(o, new THREE.Vector3(...m.from), new THREE.Vector3(...m.v), m.fuse, m.kind);
        } finally {
          this.replaying--;
        }
        return;
      }
      case 'streak': {
        if (this.isHost) this.net.broadcast(m, from);
        const o = this.bySlot(m.s);
        if (!o) return;
        g.streaks.replay(o, m.id, g.time, m.shells ?? []);
        return;
      }
      case 'door': {
        const d = g.doors.doors[m.i];
        if (d) d.target = m.target;
        if (this.isHost) this.net.broadcast(m, from);
        return;
      }
      case 'chat': {
        const text = String(m.text).slice(0, 140);
        if (this.isHost) {
          const slot = this.peerSlot.get(from);
          const s = this.roster.find((x) => x.slot === slot);
          if (!s) return;
          const out = { t: 'chat', from: s.name, team: s.team, text };
          this.net.broadcast(out);
          this.chat(s.name, s.team, text);
        } else this.chat(m.from, m.team, text);
        return;
      }
      case 'cmd':
        if (this.isHost) this.hostCommand(from, m.cmd, m.args ?? []);
        return;
      // ---- to clients
      case 'welcome':
        this.onWelcome(m);
        return;
      case 'roster':
        this.roster = m.roster;
        this.applyRoster();
        return;
      case 'snap':
        this.applySnap(m);
        return;
      case 'match':
        this.onWelcome({ ...m, slot: this.mySlot, code: this.net.code });
        return;
      case 'end':
        g.match.phase = 'ended';
        g.match.winner = m.winner;
        g.onMatchEnd(m.winner);
        return;
      case 'sys':
        this.sys(m.html);
        return;
      case 'kick':
        this.onHostGone(m.why || 'You were removed from the room.');
        this.net.close();
        return;
    }
  }

  private slotPeer(slot: number) {
    return this.roster.find((s) => s.slot === slot)?.peer;
  }

  // ================================================================ damage & deaths
  /** a direct hit on a puppet here: send it to whoever owns the victim */
  private route(victim: Combatant, from: Combatant, amount: number, dir: THREE.Vector3, part: HitPart, weapon: string) {
    if (!this.owns(from)) return; // only the shooter's machine reports
    const w = weapon || (amount >= 200 ? 'Combat Knife' : from === this.g.avatar ? this.g.weapons.cur.def.name : (from as Bot).def?.name ?? '');
    const m = { t: 'hit', v: victim.id, a: from.id, dmg: r2(amount), part, dir: [r2(dir.x), r2(dir.y), r2(dir.z)], w };
    if (this.isClient) this.net.send(m);
    else {
      const peer = this.slotPeer(victim.id);
      if (peer) this.net.send(m, peer);
    }
  }

  /** a hit reported by another machine on something this machine owns */
  private applyHit(v: Combatant, a: Combatant, dmg: number, part: HitPart, dir: THREE.Vector3, weapon: string) {
    const g = this.g;
    if (!v.alive) return;
    const before = v.health;
    v.health = Math.max(0, v.health - dmg);
    v.onDamaged(a, dmg, dir, part);
    if (v === g.avatar) g.fx.impact(v.chest(new THREE.Vector3()), dir.clone().negate(), 'flesh', dir, part === 'head');
    if (before > 0 && v.health <= 0) {
      v.alive = false;
      g.onKill(a, v, weapon, part === 'head', false);
    }
  }

  /** Game.onKill on the owner's side: tell everyone */
  reportDeath(killer: Combatant, victim: Combatant, weapon: string, hs: boolean, wb: boolean) {
    if (!this.active || !this.owns(victim)) return;
    const m = { t: 'died', v: victim.id, a: killer.id, w: weapon, hs, wb };
    if (this.isClient) this.net.send(m);
    else this.net.broadcast(m);
  }

  private replayDeath(m: any) {
    const g = this.g;
    const v = this.bySlot(m.v), a = this.bySlot(m.a) ?? v;
    if (!v || !a || this.owns(v)) return;
    NETF.allowPuppetDeath++;
    try {
      if (v.alive) {
        v.health = 0;
        v.alive = false;
        g.onKill(a, v, m.w, !!m.hs, !!m.wb);
      }
    } finally {
      NETF.allowPuppetDeath--;
    }
  }

  // ================================================================ replicated actions
  private wrapGame() {
    const g = this.g;
    // shots by soldiers this machine owns go out (batched into the next state message)
    const fire0 = g.ballistics.fire.bind(g.ballistics);
    g.ballistics.fire = (shooter: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, muzzle: THREE.Vector3, tracer: boolean, ghost = false) => {
      fire0(shooter, origin, dir, def, muzzle, tracer, ghost);
      if (!this.active || ghost || !this.owns(shooter)) return;
      this.outShots.push({ s: shooter.id, o: [r2(origin.x), r2(origin.y), r2(origin.z)], d: [dir.x, dir.y, dir.z].map((x) => Math.round(x * 1e4) / 1e4), m: [r2(muzzle.x), r2(muzzle.y), r2(muzzle.z)], w: def.id, tr: tracer ? 1 : 0 });
    };
    const throw0 = g.explosives.throw.bind(g.explosives);
    g.explosives.throw = (owner: Combatant, from: THREE.Vector3, vel: THREE.Vector3, fuse?: number, kind?: string) => {
      const r = throw0(owner, from, vel, fuse, kind);
      if (this.active && !this.replaying && this.owns(owner)) {
        const m = { t: 'nade', s: owner.id, from: [from.x, from.y, from.z], v: [vel.x, vel.y, vel.z], fuse, kind };
        if (this.isClient) this.net.send(m);
        else this.net.broadcast(m);
      }
      return r;
    };
    const use0 = g.streaks.use.bind(g.streaks);
    g.streaks.use = (c: Combatant, id: string, now: number, aim?: THREE.Vector3) => {
      const ok = use0(c, id, now, aim);
      if (ok && this.active && this.owns(c)) {
        const m = { t: 'streak', s: c.id, id, shells: g.streaks.lastShells };
        if (this.isClient) this.net.send(m);
        else this.net.broadcast(m);
      }
      return ok;
    };
    const toggle0 = g.doors.toggle.bind(g.doors);
    g.doors.toggle = (d: any, from: THREE.Vector3) => {
      toggle0(d, from);
      if (!this.active) return;
      const m = { t: 'door', i: g.doors.doors.indexOf(d), target: d.target };
      if (this.isClient) this.net.send(m);
      else this.net.broadcast(m);
    };
  }

  /** another machine's shot: muzzle flash, sound, tracer and impacts, no damage */
  private replayShot(slot: number, sh: any) {
    const g = this.g;
    const c = this.bySlot(slot);
    const def = WEAPONS[sh.w as keyof typeof WEAPONS];
    if (!c || !def || c === g.avatar) return;
    const o = new THREE.Vector3(...(sh.o as [number, number, number]));
    const d = new THREE.Vector3(...(sh.d as [number, number, number])).normalize();
    const m = new THREE.Vector3(...(sh.m as [number, number, number]));
    g.ballistics.fire(c, o, d, def, m, !!sh.tr, true);
    const key = `${slot}`;
    const last = this.lastShotT.get(key) ?? -1;
    if (g.time - last > 0.03) {
      this.lastShotT.set(key, g.time);
      const cam = g.camera.position;
      const dist = m.distanceTo(cam);
      g.fx.muzzleWorld(m, d, !!def.sound.suppressed, def.cls === 'Sniper' ? 0.9 : 0.8);
      const occluded = dist > 4 && dist < 250 && !g.physics.lineOfSight(cam, m);
      g.gunshot(def, m, dist, occluded);
      if (!def.sound.suppressed) g.radarPing(c, c.position());
      g.noteGunfire(c.position());
      if (this.isHost) g.alertBots(c.position(), def.sound.suppressed ? 20 : 80, c.team);
    }
  }
  private lastShotT = new Map<string, number>();

  // ================================================================ per frame
  update(dt: number) {
    if (!this.active) return;
    const g = this.g;
    this.net.tickStats(performance.now() / 1000);
    this.sendT -= dt;
    if (this.sendT > 0) return;
    this.sendT += RATE;
    if (this.sendT < 0) this.sendT = 0;
    if (this.isClient) {
      const m: any = { t: 'st', s: this.myPose() };
      if (this.outShots.length) m.shots = this.outShots.splice(0);
      this.net.send(m);
      if (performance.now() - this.pingSent > 2000) {
        this.pingSent = performance.now();
        this.net.send({ t: 'ping', at: this.pingSent });
      }
      return;
    }
    // ---- host snapshot
    const s: number[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      const c = this.bySlot(slot);
      let p: ArrayLike<number> | undefined;
      if (slot === 0) p = this.myPose();
      else if (this.poses.has(slot)) p = this.poses.get(slot);
      else if (c instanceof Bot) {
        const r = c.replayState();
        p = c.netDisabled || (!c.alive && (c as any).deathT > 6) ? [0, -100, 0, 0, 0, 0, 0, 0, 0, 0, 0] : r;
      }
      for (let i = 0; i < 11; i++) s.push(r2(p ? p[i] : 0));
    }
    const m: any = {
      t: 'snap', s, sc: g.match.scores, tl: r2(g.match.timeLeft),
      fl: g.dom.flags.map((f: any) => [f.owner, f.capTeam, r2(f.progress), f.contested ? 1 : 0]),
      uav: g.streaks.uavUntil.map((u: number) => r2(u - g.time)),
    };
    if (this.outShots.length) m.shots = this.outShots.splice(0);
    this.doorT -= RATE;
    if (this.doorT <= 0) {
      this.doorT = 1;
      m.doors = g.doors.doors.map((d: any) => Math.round(d.target * 100) / 100);
    }
    this.envT -= RATE;
    if (this.envT <= 0) {
      this.envT = 5;
      m.env = this.envState();
    }
    this.net.broadcast(m);
  }

  private myPose() {
    const g = this.g, p = g.player, a = g.avatar;
    return [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.yaw), r2(p.yaw), r2(p.pitch), r2(p.horizSpeed()), a.alive ? 1 : 0, p.stance !== 'stand' ? 1 : 0, 0, 0];
  }

  private applySnap(m: any) {
    const g = this.g;
    const s = m.s as number[];
    for (let slot = 0; slot < SLOTS; slot++) {
      if (slot === this.mySlot) continue;
      const b = this.bySlot(slot);
      if (!(b instanceof Bot) || b.netDisabled) continue;
      const st = s.slice(slot * 11, slot * 11 + 11);
      if (st[1] < -50) {
        if (b.alive) b.netHide();
        continue;
      }
      b.netState(st);
    }
    g.match.scores = m.sc;
    g.match.timeLeft = m.tl;
    g.dom.applyRemote(m.fl, g.time, g.match.players);
    if (m.uav) g.streaks.uavUntil = m.uav.map((u: number) => g.time + u);
    if (m.shots) for (const sh of m.shots) if (sh.s !== this.mySlot) this.replayShot(sh.s, sh);
    if (m.doors) m.doors.forEach((t: number, i: number) => {
      const d = g.doors.doors[i];
      if (d && Math.abs(d.target - t) > 0.05) d.target = t;
    });
    if (m.env) this.applyEnv(m.env, false);
  }

  /** host: the match restarted / ended */
  onMatchStart() {
    if (!this.isHost) return;
    for (const [peer, slot] of this.peerSlot) {
      (this.bySlot(slot) as Bot)?.netHide();
      this.net.send({ ...this.welcome(slot), t: 'match' }, peer);
    }
    this.applyBotCount();
  }
  onMatchEnd(w: number) {
    if (this.isHost) this.net.broadcast({ t: 'end', winner: w });
  }

  // ================================================================ bots filling the slots
  /** host: /bots N — how many bots fill the empty slots (teams kept even) */
  private applyBotCount() {
    if (!this.isHost || this.botTarget < 0) return;
    const humans = this.roster.filter((s) => s.human);
    const total = Math.min(SLOTS, humans.length + this.botTarget);
    const per: [number, number] = [Math.ceil(total / 2), Math.floor(total / 2)];
    for (const t of [0, 1] as const) {
      let room = per[t] - humans.filter((h) => h.team === t).length;
      for (const s of this.roster.filter((x) => x.team === t && !x.human).sort((a, b) => a.slot - b.slot)) {
        const b = this.bySlot(s.slot) as Bot;
        const on = room > 0;
        room--;
        s.disabled = !on;
        if (!on && !b.netDisabled) {
          b.netDisabled = true;
          b.netHide();
        } else if (on && b.netDisabled) {
          b.netDisabled = false;
          b.respawnT = 0.5;
        }
      }
    }
    this.broadcastRoster();
  }

  // ================================================================ chat & commands
  private openChat(prefix: string) {
    this.typing = true;
    this.g.input.typing = true;
    this.chatInput.classList.remove('hidden');
    this.chatEl.classList.add('open');
    this.chatInput.value = prefix;
    setTimeout(() => this.chatInput.focus(), 0);
  }
  private closeChat() {
    this.typing = false;
    this.g.input.typing = false;
    this.chatInput.blur();
    this.chatInput.classList.add('hidden');
    this.chatEl.classList.remove('open');
  }

  submit(text: string) {
    if (text.startsWith('/')) return this.command(text);
    if (!this.active) return this.sys('Chat works in multiplayer games. /help lists the commands.');
    if (this.isClient) this.net.send({ t: 'chat', text });
    else {
      this.net.broadcast({ t: 'chat', from: this.name, team: this.g.avatar.team, text });
      this.chat(this.name, this.g.avatar.team, text);
    }
  }

  private command(text: string) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const c = (cmd || '').toLowerCase();
    const g = this.g;
    const hostOnly = ['bots', 'kick', 'restart', 'time', 'diff', 'weather'];
    switch (c) {
      case 'help':
      case '?':
        this.sys([
          '<b>Commands</b>',
          '/code — room code + invite link (copied)',
          '/players — who is in the room',
          '/name &lt;name&gt; — change your name',
          '/team — switch sides',
          '/ping — your round trip to the host',
          '/leave — leave the room',
          '<b>Host only</b>',
          '/bots &lt;0-23&gt; — how many bots fill the slots',
          '/kick &lt;name&gt; — remove a player',
          '/restart — new match',
          '/time &lt;dawn|day|golden|night&gt; — time of day',
          '/weather &lt;clear|overcast|rain|snow&gt;',
          '/diff &lt;recruit|regular|veteran&gt; — bot skill',
        ].join('<br>'));
        return;
      case 'code':
        if (!this.active) return this.sys('Not in a multiplayer room. Use MULTIPLAYER in the main menu.');
        navigator.clipboard?.writeText(this.inviteLink()).catch(() => {});
        this.sys(`Room <b>${this.net.code}</b> · <span class="sel">${this.inviteLink()}</span> (copied)`);
        return;
      case 'players':
      case 'who': {
        const rows = this.roster.filter((s) => s.human).map((s) => `${s.team === g.avatar.team ? '🔵' : '🔴'} ${esc(s.name)}${s.slot === 0 ? ' (host)' : ''}`);
        const bots = this.roster.filter((s) => !s.human && !s.disabled).length;
        this.sys(`${rows.join('<br>') || 'Just you.'}<br>+ ${bots} bots`);
        return;
      }
      case 'name': {
        const n = args.join(' ').replace(/[<>]/g, '').slice(0, 16).trim();
        if (!n) return this.sys('Usage: /name &lt;name&gt;');
        localStorage.setItem('ff.name', n);
        this.name = n;
        if (!this.active) return this.sys(`Name set to <b>${esc(n)}</b>.`);
        if (this.isClient) this.net.send({ t: 'cmd', cmd: 'name', args: [n] });
        else this.hostCommand('', 'name', [n]);
        return;
      }
      case 'team':
        if (!this.active) return this.sys('Not in a multiplayer room.');
        if (this.isClient) this.net.send({ t: 'cmd', cmd: 'team', args: [] });
        else this.hostCommand('', 'team', []);
        return;
      case 'ping':
        this.sys(this.isClient ? `Round trip to the host: <b>${Math.round(this.rtt)} ms</b> · up ${(this.net.stats.up / 1024).toFixed(1)} KB/s · down ${(this.net.stats.down / 1024).toFixed(1)} KB/s` : this.isHost ? `You are the host · ${this.net.conns.size} connected · up ${(this.net.stats.up / 1024).toFixed(1)} KB/s` : 'Not in a multiplayer room.');
        return;
      case 'leave':
      case 'quit':
        this.leave();
        return;
      default:
        if (hostOnly.includes(c)) {
          if (this.isClient) return this.sys('Only the host can do that.');
          return this.hostCommand('', c, args);
        }
        this.sys(`Unknown command /${esc(c)}. Try /help.`);
    }
  }

  /** commands the host runs (its own, or relayed from a client) */
  private hostCommand(from: string, cmd: string, args: string[]) {
    const g = this.g;
    const slot = from ? this.peerSlot.get(from) : 0;
    if (slot === undefined) return;
    const me = this.roster.find((s) => s.slot === slot);
    const reply = (html: string) => (from ? this.net.send({ t: 'sys', html }, from) : this.sys(html));
    const local = !from || !this.active;
    switch (cmd) {
      case 'name': {
        const n = this.uniqueName(args[0] ?? '');
        if (!me) return;
        const old = me.name;
        me.name = n;
        const c = this.bySlot(slot!);
        if (c) c.name = n;
        if (!from) this.name = n;
        if (this.active) this.broadcastRoster();
        this.sys(`${esc(old)} is now <b>${esc(n)}</b>.`, true);
        return;
      }
      case 'team': {
        if (!me) return;
        const want = (1 - me.team) as 0 | 1;
        if (!from) {
          // the host switches: swap places with a bot on the other side
          const other = this.roster.filter((s) => s.team === want && !s.human)[0];
          if (!other) return reply('No free slot on the other side.');
          const bot = this.bySlot(other.slot) as Bot;
          other.team = me.team;
          bot.setTeam(me.team, g.teamMats[me.team]);
          me.team = want;
          g.avatar.team = want;
          g.dom.myTeam = want;
          g.avatar.health = 0;
          g.avatar.alive = false;
          g.respawnPlayer();
          bot.netHide();
          bot.respawnT = 1;
          this.broadcastRoster();
          this.sys(`<b>${esc(me.name)}</b> switched to ${g.match.teamNames[want]}.`, true);
          return;
        }
        const target = this.roster.find((s) => s.team === want && !s.human);
        if (!target) return reply('No free slot on the other side.');
        const peer = from;
        const name = me.name;
        this.releaseSlot(slot!);
        this.assignHuman(target.slot, peer, name);
        this.net.send(this.welcome(target.slot), peer);
        this.broadcastRoster();
        this.sys(`<b>${esc(name)}</b> switched to ${g.match.teamNames[want]}.`, true);
        return;
      }
    }
    if (from) return reply('Only the host can do that.');
    switch (cmd) {
      case 'bots': {
        const n = Math.max(0, Math.min(23, parseInt(args[0] ?? '', 10)));
        if (Number.isNaN(n)) return reply('Usage: /bots &lt;0-23&gt;');
        this.botTarget = n;
        if (!this.active) {
          // offline: same rule, just for this match
          this.roster = this.defaultRoster();
          this.net.role = 'off';
        }
        this.applyBotCountAny();
        this.sys(`Bots: <b>${n}</b>.`, true);
        return;
      }
      case 'kick': {
        const who = args.join(' ').toLowerCase();
        const s = this.roster.find((x) => x.human && x.slot !== 0 && x.name.toLowerCase() === who);
        if (!s || !s.peer) return reply('No player by that name. /players lists them.');
        this.net.send({ t: 'kick', why: 'The host removed you from the room.' }, s.peer);
        setTimeout(() => this.net.kick(s.peer!), 300);
        this.sys(`${esc(s.name)} was kicked.`, true);
        return;
      }
      case 'restart':
        g.startMatch();
        this.sys('New match.', true);
        return;
      case 'time': {
        const p = (args[0] ?? '').toLowerCase();
        if (!['dawn', 'day', 'golden', 'night'].includes(p)) return reply('Usage: /time &lt;dawn|day|golden|night&gt;');
        g.env.setTime(p);
        this.envT = 0;
        this.sys(`Time of day: <b>${p}</b>.`, true);
        return;
      }
      case 'weather': {
        const w = (args[0] ?? '').toLowerCase();
        if (!['clear', 'overcast', 'rain', 'snow'].includes(w)) return reply('Usage: /weather &lt;clear|overcast|rain|snow&gt;');
        g.env.setWeather(w);
        g.weather.reset(g.winter, w);
        this.envT = 0;
        this.sys(`Weather: <b>${w}</b>.`, true);
        return;
      }
      case 'diff': {
        const d = (args[0] ?? '').toLowerCase();
        const v = ({ recruit: 0, regular: 0.5, veteran: 1 } as Record<string, number>)[d];
        if (v === undefined) return reply('Usage: /diff &lt;recruit|regular|veteran&gt;');
        for (const b of g.bots) (b as any).w.difficulty = v;
        this.sys(`Bot skill: <b>${d}</b>.`, true);
        return;
      }
    }
  }

  /** /bots also works offline (single player) */
  private applyBotCountAny() {
    if (this.isHost) return this.applyBotCount();
    const g = this.g;
    const total = Math.min(SLOTS, 1 + this.botTarget);
    const per: [number, number] = [Math.ceil(total / 2), Math.floor(total / 2)];
    for (const t of [0, 1] as const) {
      let room = per[t] - (g.avatar.team === t ? 1 : 0);
      for (const b of (g.bots as Bot[]).filter((x) => x.team === t).sort((a, b) => a.id - b.id)) {
        const on = room-- > 0;
        if (!on && !b.netDisabled) {
          b.netDisabled = true;
          b.netHide();
        } else if (on && b.netDisabled) {
          b.netDisabled = false;
          b.respawnT = 0.5;
        }
      }
    }
  }

  // ================================================================ ui
  private chat(from: string, team: number, text: string) {
    const mine = team === this.g.avatar.team;
    this.line(`<span class="${mine ? 'ally' : 'enemy'}">${esc(from)}:</span> ${esc(text)}`);
    this.g.audio.play('click', { gain: 0.2, bus: 'ui', reverb: 0, rate: 1.9 });
  }
  /** a system line (host: optionally to everyone) */
  sys(html: string, broadcast = false) {
    this.line(`<span class="sys">${html}</span>`);
    if (broadcast && this.isHost) this.net.broadcast({ t: 'sys', html });
  }
  private line(html: string) {
    const d = document.createElement('div');
    d.innerHTML = html;
    this.chatLines.appendChild(d);
    while (this.chatLines.children.length > 9) this.chatLines.firstChild!.remove();
    setTimeout(() => d.classList.add('old'), 12000);
  }

  private updateStatus() {
    if (!this.active) {
      this.statusEl.classList.add('hidden');
      return;
    }
    const humans = this.roster.filter((s) => s.human).length;
    const bots = this.roster.filter((s) => !s.human && !s.disabled).length;
    this.statusEl.classList.remove('hidden');
    this.statusEl.innerHTML = `${this.isHost ? 'HOST' : 'ONLINE'} · ROOM <b>${this.net.code}</b> · ${humans} PLAYER${humans === 1 ? '' : 'S'} + ${bots} BOTS`;
  }

  /** Main menu → MULTIPLAYER: name, host, join */
  showPanel(prefill = '') {
    const g = this.g;
    this.panel?.remove();
    const p = document.createElement('div');
    p.className = 'screen netpanel';
    p.innerHTML = `
      <div class="card">
        <h2>MULTIPLAYER</h2>
        <div class="sub">Play with friends. Bots fill every empty slot (12 v 12).</div>
        <label>YOUR NAME<input class="nm" maxlength="16" spellcheck="false"></label>
        <div class="row">
          <div class="col"><h3>HOST</h3><p>Start a room on this computer. You get a code to send to your friends.</p><button class="primary" data-a="host">HOST GAME</button></div>
          <div class="col"><h3>JOIN</h3><p>Type the code your friend got.</p><input class="code" maxlength="8" placeholder="CODE" spellcheck="false"><button class="primary" data-a="join">JOIN GAME</button></div>
        </div>
        <div class="msg"></div>
        <div class="foot"><span>Peer-to-peer: keep the host's game tab open and in front. Enter = chat, /help = commands.</span><button data-a="back">BACK</button></div>
      </div>`;
    g.ui.root.appendChild(p);
    this.panel = p;
    const nm = p.querySelector('.nm') as HTMLInputElement, code = p.querySelector('.code') as HTMLInputElement, msg = p.querySelector('.msg') as HTMLDivElement;
    nm.value = this.name;
    code.value = prefill;
    const setName = () => {
      const n = nm.value.replace(/[<>]/g, '').trim().slice(0, 16);
      if (n) {
        this.name = n;
        localStorage.setItem('ff.name', n);
      }
    };
    const busy = (v: boolean, text = '') => {
      p.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = v));
      msg.textContent = text;
    };
    p.querySelector('[data-a=back]')!.addEventListener('click', () => p.remove());
    p.querySelector('[data-a=host]')!.addEventListener('click', async () => {
      setName();
      busy(true, 'Opening a room…');
      try {
        await this.host();
        p.remove();
        g.startMatch();
        if (!g.input.locked) g.ui.notify('ROOM OPEN', 'CLICK THE SCREEN TO PLAY · /code FOR THE INVITE LINK');
      } catch (e) {
        busy(false, (e as Error).message);
        NETF.active = false;
      }
    });
    const doJoin = async () => {
      setName();
      if (cleanCode(code.value).length < 4) return busy(false, 'Type the room code first.');
      busy(true, 'Connecting…');
      try {
        await this.join(code.value);
        busy(true, 'Connected. Waiting for the host…');
        const wait = setInterval(() => {
          if (g.state === 'playing') {
            clearInterval(wait);
            p.remove();
          }
        }, 100);
      } catch (e) {
        busy(false, (e as Error).message);
      }
    };
    p.querySelector('[data-a=join]')!.addEventListener('click', doJoin);
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') doJoin();
    });
    nm.addEventListener('keydown', (e) => e.stopPropagation());
    if (prefill) setTimeout(() => code.focus(), 50);
  }
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
