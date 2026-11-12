import * as THREE from 'three';
import { Net, NetMsg, cleanCode, LobbyRegistry, RoomInfo, probeRooms, myRegion } from './Net';
import { icon } from '../ui/Icons';
import { chartThumb } from '../ui/Chart';
import { Voice } from './Voice';
import { Settings } from '../game/Settings';
import { bindOf } from '../core/Input';
import { NETF } from './NetFlags';
import type { Combatant, HitPart } from '../game/Combatant';
import { POSE_N, Bot } from '../ai/Bot';
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
 * Chat [Enter] doubles as the console: /help lists the commands. [U] = team chat.
 */
/** words the chat filter masks (setting; on by default) */
const BAD = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|dick\w*|cock\w*|whore\w*|slut\w*|fag\w*|nigg\w*|retard\w*|twat\w*|wank\w*|faen|faan|helvete|j[aæ]vla\w*|j[aæ]vel\w*|fitte\w*|kuk\w*|pikk\w*|hore\w*|dritt\w*|satan\w*|homo)\b/gi;
export function filterText(t: string) {
  return Settings.data.profanityFilter ? t.replace(BAD, (w) => w[0] + '*'.repeat(w.length - 1)) : t;
}
const RATE = 1 / 20;
const VER = 1;
const HIDDEN = [0, -100, 0, ...new Array(17).fill(0)];
const SLOTS = 24;
type Slot = { slot: number; name: string; team: 0 | 1; human: boolean; disabled: boolean; peer?: string; host?: boolean; pid?: string; vc?: boolean; ready?: boolean };
const r2 = (v: number) => Math.round(v * 100) / 100;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Snapshot poses travel as quantised 16-bit integers (base64 inside the message) instead of JSON
 * number text: 24 slots × 20 values in ~1.3 KB instead of ~2.4 KB.
 */
const QS = [50, 50, 50, 5000, 5000, 5000, 100, 1, 1, 100, 1, 1, 1, 1000, 1, 1000, 100, 100, 100, 1];
function packPoses(v: number[]) {
  const q = new Int16Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(v[i] * QS[i % POSE_N])));
  const b = new Uint8Array(q.buffer);
  let str = '';
  for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
  return btoa(str);
}
function unpackPoses(s: string) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i);
  const q = new Int16Array(b.buffer);
  const out = new Array<number>(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / QS[i % POSE_N];
  return out;
}

/** this machine's clock (s) */
const now = () => performance.now() / 1000;
/** binary packets on the unreliable state channel */
const K_SNAP = 1, K_POSE = 2;
/**
 * Binary pose packet: u8 kind · u8 count · u16 seq · f32 sender time, then per soldier: u8 slot ·
 * u32 field mask (bit i = field i follows) · i16 per present field (QS-quantised). Fields that did
 * not change are left out; the receiver keeps the last value of each field per slot.
 */
function encodePoses(seq: number, t: number, slots: number[], poses: ArrayLike<number>[], masks: number[] | null, kind = K_SNAP) {
  const n = slots.length;
  let size = 8;
  for (let k = 0; k < n; k++) size += 5 + 2 * popcount(masks ? masks[k] : FULL);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint8(0, kind);
  dv.setUint8(1, n);
  dv.setUint16(2, seq & 0xffff);
  dv.setFloat32(4, t);
  let o = 8;
  for (let k = 0; k < n; k++) {
    const m = masks ? masks[k] : FULL;
    dv.setUint8(o++, slots[k]);
    dv.setUint32(o, m >>> 0);
    o += 4;
    const p = poses[k];
    for (let i = 0; i < POSE_N; i++) if (m & (1 << i)) {
      dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(p[i] * QS[i]))));
      o += 2;
    }
  }
  return buf;
}
const FULL = (1 << POSE_N) - 1;
function popcount(m: number) {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c;
}
/** decode into the per-slot last-known state (`base`), returning the slots touched */
function decodePoses(buf: ArrayBuffer, base: Map<number, number[]>) {
  const dv = new DataView(buf);
  const kind = dv.getUint8(0), n = dv.getUint8(1), seq = dv.getUint16(2), t = dv.getFloat32(4);
  const out: { slot: number; s: number[] }[] = [];
  let o = 8;
  for (let k = 0; k < n && o + 5 <= buf.byteLength; k++) {
    const slot = dv.getUint8(o++);
    const m = dv.getUint32(o);
    o += 4;
    let st = base.get(slot);
    if (!st) base.set(slot, (st = HIDDEN.slice()));
    if (o + 2 * popcount(m) > buf.byteLength) break;
    for (let i = 0; i < POSE_N; i++) if (m & (1 << i)) {
      st[i] = dv.getInt16(o) / QS[i];
      o += 2;
    }
    out.push({ slot, s: st.slice() });
  }
  return { kind, seq, t, out };
}

function quant(p: ArrayLike<number>) {
  const q = new Int16Array(POSE_N);
  for (let i = 0; i < POSE_N; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(p[i] * QS[i])));
  return q;
}
/** host: the last 2 s of every slot's position (lag-compensated hit checks) */
class History {
  private t = new Float64Array(40);
  private p = new Float32Array(120);
  private i = 0;
  private n = 0;
  push(t: number, x: number, y: number, z: number) {
    const k = this.i;
    this.t[k] = t;
    this.p[k * 3] = x;
    this.p[k * 3 + 1] = y;
    this.p[k * 3 + 2] = z;
    this.i = (k + 1) % 40;
    this.n = Math.min(40, this.n + 1);
  }
  /** position at time t (interpolated; clamped to the recorded window) */
  at(t: number, out: THREE.Vector3) {
    if (!this.n) return false;
    let best = -1, next = -1;
    for (let j = 0; j < this.n; j++) {
      const k = (this.i - 1 - j + 40) % 40;
      if (this.t[k] <= t) {
        best = k;
        next = j > 0 ? (k + 1) % 40 : -1;
        break;
      }
      best = k;
    }
    if (next < 0 || this.t[next] <= this.t[best]) return out.set(this.p[best * 3], this.p[best * 3 + 1], this.p[best * 3 + 2]), true;
    const f = Math.min(1, Math.max(0, (t - this.t[best]) / (this.t[next] - this.t[best])));
    out.set(
      this.p[best * 3] + (this.p[next * 3] - this.p[best * 3]) * f,
      this.p[best * 3 + 1] + (this.p[next * 3 + 1] - this.p[best * 3 + 1]) * f,
      this.p[best * 3 + 2] + (this.p[next * 3 + 2] - this.p[best * 3 + 2]) * f,
    );
    return true;
  }
}

/** per-sender clock offset: lowest (receive − send) seen, drifting up slowly (≈ clock skew + min latency) */
class ClockSync {
  private off = new Map<string, number>();
  map(src: string, remoteT: number) {
    const d = now() - remoteT;
    const o = this.off.get(src);
    if (o === undefined || d < o) this.off.set(src, d);
    else this.off.set(src, o + (d - o) * 0.002);
    return remoteT + this.off.get(src)!;
  }
  /** a remote clock reading → this machine's clock */
  toLocal(src: string, remoteT: number) {
    return remoteT + (this.off.get(src) ?? 0);
  }
  /** this machine's clock → the remote's */
  toRemote(src: string, localT: number) {
    return localT - (this.off.get(src) ?? 0);
  }
  reset() {
    this.off.clear();
  }
}

/** per-peer link quality: sequence gaps → loss %, arrival jitter, round trip */
class LinkStats {
  private last = -1;
  private got = 0;
  private lost = 0;
  private lastArr = 0;
  jitter = 0;
  loss = 0;
  rtt = 0;
  seen(seq: number) {
    const t = now();
    if (this.lastArr) this.jitter += (Math.abs(t - this.lastArr - 0.05) - this.jitter) * 0.05;
    this.lastArr = t;
    if (this.last >= 0) {
      const gap = (seq - this.last + 0x10000) & 0xffff;
      if (gap === 0 || gap > 0x8000) return false; // duplicate / old
      this.lost += gap - 1;
    }
    this.last = seq;
    this.got++;
    if (this.got + this.lost > 100) {
      this.loss = this.lost / (this.got + this.lost);
      this.got = this.lost = 0;
    }
    return true;
  }
}

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
  clock = new ClockSync();
  /** link stats: client → 'host'; host → per peer */
  links = new Map<string, LinkStats>();
  private seq = 0;
  /** host: what each peer last received per slot (delta snapshots) and a keyframe counter */
  private sentTo = new Map<string, { last: Map<number, Int16Array>; chg: Map<number, Int32Array>; n: number }>();
  /** receiver: last known pose fields per (sender, slot) */
  private rxBase = new Map<string, Map<number, number[]>>();
  /** client: last time anything arrived from the host (silence → host gone) */
  private lastHostRx = 0;
  /** interpolation delay (s): two snapshot intervals + jitter */
  interpDelay = 0.1;
  /** host: position history per slot, last accepted pose per client slot, shot budgets, strikes */
  private hist = new Map<number, History>();
  private lastPose = new Map<number, { t: number; x: number; z: number; alive: boolean; rej: number }>();
  private shotBudget = new Map<number, { tok: number; t: number; w: string; mag: number }>();
  private strikes = new Map<string, number>();
  /** a slot whose owner is gone but may rejoin (host migration) → deadline */
  private pendingRejoin = new Map<number, number>();
  private kicked = false;
  /** room browser announcements (public rooms) */
  private reg = new LobbyRegistry();
  isPublic = localStorage.getItem('ff.public') !== '0';
  voice = new Voice();
  private voiceT = 0;
  /** players muted on this machine (chat + voice), by name */
  muted = new Set<string>();
  /** match over: who is ready for the next one (host) / whether I am (client) */
  private readySet = new Set<number>();
  private readyT = -1;
  imReady = false;
  /** invite link side: join on the inviter's team */
  private teamPref: 0 | 1 | undefined;
  private chatTeam = false;
  migrating = false;
  private lastCode = '';
  /** host: everyone's ping / loss, broadcast for the scoreboard */
  netInfo: Record<number, [number, number]> = {};
  private link(id: string) {
    let l = this.links.get(id);
    if (!l) this.links.set(id, (l = new LinkStats()));
    return l;
  }

  // ui
  private chatEl: HTMLDivElement;
  private chatLines: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private statusEl: HTMLDivElement;
  private panel: HTMLDivElement | null = null;
  typing = false;

  constructor(private g: any) {
    this.name = (localStorage.getItem('ff.name') || '').slice(0, 16) || `Soldat${Math.floor(100 + Math.random() * 900)}`;
    const tp = new URLSearchParams(location.search).get('t');
    if (tp === '0' || tp === '1') this.teamPref = Number(tp) as 0 | 1;
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
      if (!this.typing && (e.code === 'Enter' || e.code === 'Slash' || bindOf(e.code) === 'chatTeam') && this.g.state === 'playing') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.openChat(e.code === 'Slash' ? '/' : '', bindOf(e.code) === 'chatTeam' && e.code !== 'Enter');
        return;
      }
      if (!this.typing) return;
      e.stopImmediatePropagation();
      if (e.code === 'Enter') {
        e.preventDefault();
        const text = this.chatInput.value.trim();
        const team = this.chatTeam;
        this.closeChat();
        if (text) this.submit(text, team);
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
    n.onClosed = (why) => {
      if (this.kicked || this.g.state === 'menu') this.onHostGone(why);
      else this.migrate(why);
    };
    n.onState = (from, buf) => this.onState(from, buf);
    n.onCall = (c) => this.voice.incoming(c);
    // a host tab in the background stops rendering (and so stops sending snapshots): timers still
    // run there, so keep the clients from thinking the host left
    setInterval(() => {
      if (this.isHost && document.hidden) this.net.broadcast({ t: 'ka' });
    }, 1000);
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
  /** room link; `party` = the friend joins my side */
  inviteLink(party = true) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('join', this.net.code);
    if (party) u.searchParams.set('t', String(this.g.avatar.team));
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
    const out: Slot[] = [{ slot: g.avatar.id, name: this.name, team: g.avatar.team, human: true, disabled: false, host: true }];
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
    this.lastCode = code;
    this.roster[0].pid = this.net.myId;
    this.announce();
    this.sys(`Hosting room <b>${code}</b>. Invite: <span class="sel">${this.inviteLink()}</span>`);
    this.sys('Friends join with MULTIPLAYER → JOIN and this code. Type /help for commands.');
    this.updateStatus();
    return code;
  }

  async join(code: string) {
    NETF.active = true;
    try {
      await this.net.join(cleanCode(code), { t: 'hello', name: this.name, ver: VER, team: this.teamPref });
    } catch (e) {
      NETF.active = false;
      throw e;
    }
  }

  leave() {
    if (!this.active) return;
    this.reg.stop();
    this.voice.disable();
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
    // reconnecting after a host migration: their old slot, if it is still waiting for them
    const back = typeof m.rejoin === 'number' ? this.roster.find((x) => x.slot === m.rejoin && x.human && !x.peer && this.pendingRejoin.has(x.slot)) : undefined;
    if (back) {
      this.pendingRejoin.delete(back.slot);
      this.assignHuman(back.slot, peer, back.name);
      back.pid = typeof m.pid === 'string' ? m.pid : undefined;
      this.net.send({ ...this.welcome(back.slot), rejoin: true }, peer);
      this.broadcastRoster();
      this.sys(`<b>${esc(back.name)}</b> reconnected.`, true);
      return;
    }
    const s = this.pickSlot(m.team === 0 || m.team === 1 ? m.team : undefined);
    if (!s) {
      this.net.send({ t: 'kick', why: 'The room is full (24 players).' }, peer);
      setTimeout(() => this.net.kick(peer), 300);
      return;
    }
    const name = this.uniqueName(String(m.name || 'Player').slice(0, 16));
    this.assignHuman(s.slot, peer, name);
    s.pid = typeof m.pid === 'string' ? m.pid : undefined;
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
    this.lastCode = m.code ?? this.lastCode;
    this.rxBase.clear();
    if (m.rejoin) {
      // back after a host migration: the match carries on as it was
      for (const b of g.bots as Bot[]) b.setPuppet(true);
      this.applyRoster();
      this.applyEnv(m.env, false);
      this.sys('Reconnected to the new host. The match continues.');
      g.ui.notify('RECONNECTED', 'THE MATCH CONTINUES');
      return;
    }
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
    g.ui.sfx('uiHorn', 1);
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
      if (b.team !== s.team) b.setTeam(s.team);
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
    console.warn('[net] leaving the room:', why);
    this.g.ui.notify('DISCONNECTED', why.toUpperCase());
    this.sys(why);
    NETF.active = false;
    setTimeout(() => (location.href = location.pathname), 3500);
  }

  // ================================================================ messages
  private onMessage(from: string, m: any) {
    const g = this.g;
    if (from === 'host') this.lastHostRx = now();
    switch (m.t) {
      // ---- to the host
      case 'hello':
        if (this.isHost) this.onJoin(from, m);
        return;
      case 'st': {
        if (!this.isHost) return;
        const slot = this.peerSlot.get(from);
        if (slot === undefined) return;
        if (m.s) this.acceptPose(slot, m.s, m.ct !== undefined ? this.clock.map(from, m.ct) : now(), from);
        const shots = m.shots ? this.checkShots(slot, m.shots) : [];
        for (const sh of shots) this.replayShot(slot, sh);
        if (shots.length) this.outShots.push(...shots.map((sh: any) => ({ ...sh, s: slot })));
        return;
      }
      case 'ping':
        this.net.send({ t: 'pong', at: m.at }, this.isHost ? from : undefined);
        if (this.isHost) {
          const slot = this.peerSlot.get(from);
          if (slot !== undefined) this.netInfo[slot] = [m.rtt ?? 0, Math.max(m.loss ?? 0, Math.round(this.link(from).loss * 1000) / 10)];
          if (typeof m.id === 'number') this.interpOf.set(from, Math.min(0.3, Math.max(0, m.id)));
        }
        return;
      case 'pong':
        this.rtt = performance.now() - m.at;
        return;
      // ---- either way
      case 'hit': {
        if (this.isHost && !this.checkHit(from, m)) return;
        if (this.isHost && m.v !== this.mySlot && this.slotPeer(m.v)) {
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
      case 'eq': {
        // equipment placed / fired on another machine
        if (this.isHost) this.net.broadcast(m, from);
        const o = this.bySlot(m.s);
        if (!o) return;
        const p = Array.isArray(m.p) ? new THREE.Vector3(...(m.p as [number, number, number])) : null;
        if (m.a === 'det') {
          for (const gr of g.explosives.grenades.filter((x: { kind: string; owner: unknown }) => x.kind === 'c4' && x.owner === o)) g.explosives.detonate(gr);
        } else if (m.a === 'clay' && p) g.deployables.placeClaymore(o, p, m.y as number);
        else if (m.a === 'trophy' && p) g.deployables.deployTrophy(o, p, m.y as number);
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
          const out = { t: 'chat', from: s.name, team: s.team, text, tm: m.tm ? 1 : 0 };
          if (m.tm) {
            // team channel: only that side's players
            for (const r of this.roster) if (r.human && r.team === s.team && r.peer) this.net.send(out, r.peer);
            if (this.g.avatar.team === s.team) this.chat(s.name, s.team, text, true);
          } else {
            this.net.broadcast(out);
            this.chat(s.name, s.team, text);
          }
        } else this.chat(m.from, m.team, text, !!m.tm);
        return;
      }
      case 'vc': {
        // a player turned voice chat on / off
        if (!this.isHost) return;
        const s = this.roster.find((x) => x.slot === this.peerSlot.get(from));
        if (s) {
          s.vc = !!m.on;
          this.broadcastRoster();
        }
        return;
      }
      case 'report': {
        // a player reported another (kept on the host's screen and console; there is no server)
        if (!this.isHost) return;
        const by = this.roster.find((x) => x.slot === this.peerSlot.get(from));
        const who = this.roster.find((x) => x.slot === m.slot);
        if (by && who) {
          console.warn('[report]', by.name, '→', who.name);
          this.sys(`Report: <b>${esc(by.name)}</b> reported <b>${esc(who.name)}</b>. /kick ${esc(who.name)} removes them.`);
        }
        return;
      }
      case 'ready': {
        if (!this.isHost) return;
        const slot = this.peerSlot.get(from);
        if (slot === undefined) return;
        if (m.v) this.readySet.add(slot);
        else this.readySet.delete(slot);
        this.checkReady();
        return;
      }
      case 'rdy':
        // host → clients: ready count while the match is over
        this.readyInfo = m.n !== undefined ? `${m.n}/${m.of}` : '';
        this.updateStatus();
        return;
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
        this.imReady = false;
        g.match.phase = 'ended';
        g.match.winner = m.winner;
        g.onMatchEnd(m.winner);
        return;
      case 'sys':
        this.sys(m.html);
        return;
      case 'kick':
        this.kicked = true;
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
    const m: any = { t: 'hit', v: victim.id, a: from.id, dmg: r2(amount), part, dir: [r2(dir.x), r2(dir.y), r2(dir.z)], w };
    if (this.isClient) {
      // for the host's lag-compensated check: when (host clock) and where I saw the victim and myself
      const vp = victim.position(), ap = from.position();
      m.rt = r2(this.clock.toRemote('host', Bot.netRenderT || now()));
      m.vp = [r2(vp.x), r2(vp.y), r2(vp.z)];
      m.ap = [r2(ap.x), r2(ap.y), r2(ap.z)];
      this.net.send(m);
    }
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
    g.equipNet = (a: string, d: Record<string, unknown>) => {
      if (!this.active) return;
      const m = { t: 'eq', s: g.avatar.id, a, ...d };
      if (this.isClient) this.net.send(m);
      else this.net.broadcast(m);
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

  // ================================================================ host validation
  // The host trusts each client with its own soldier (movement, aim, shots) — that is what makes
  // shooting feel instant on a peer-to-peer game. It checks what it is told, though: impossible
  // movement is ignored, shots beyond the gun's fire rate / magazine are dropped, and every hit is
  // checked against where the victim really was at the moment the shooter saw them (the host keeps
  // two seconds of everyone's positions and rewinds to the shooter's render time — lag
  // compensation). A peer that keeps failing the checks is removed.
  private record(slot: number, p: ArrayLike<number>) {
    if (p[1] < -50) return;
    let h = this.hist.get(slot);
    if (!h) this.hist.set(slot, (h = new History()));
    h.push(now(), p[0], p[1], p[2]);
  }
  private strike(peer: string, w: number, why: string) {
    const v = (this.strikes.get(peer) ?? 0) + w;
    this.strikes.set(peer, v);
    if (v >= 1 && v - w < 1) console.warn('[net] check failed:', why, 'slot', this.peerSlot.get(peer));
    if (v >= 8) {
      const s = this.roster.find((x) => x.peer === peer);
      this.net.send({ t: 'kick', why: 'Removed: your game sent impossible moves or hits (connection problem or a modified game).' }, peer);
      setTimeout(() => this.net.kick(peer), 300);
      this.strikes.delete(peer);
      if (s) this.sys(`${esc(s.name)} was removed by the server checks.`, true);
    }
  }
  private validateTick(dt: number) {
    if (!this.isHost) return;
    for (const [k, v] of this.strikes) this.strikes.set(k, Math.max(0, v - dt * 0.1));
    // players lost in a host migration who never came back → bots
    if (this.pendingRejoin.size) {
      const t = now();
      for (const [slot, until] of this.pendingRejoin) if (t > until) {
        this.pendingRejoin.delete(slot);
        const s = this.roster.find((x) => x.slot === slot);
        if (s?.human && !s.peer) {
          this.releaseSlot(slot);
          this.broadcastRoster();
        }
      }
    }
  }
  /** a client's own pose: accept unless it moved impossibly fast */
  private acceptPose(slot: number, st: number[], t: number, from: string) {
    const alive = st[7] > 0.5;
    const last = this.lastPose.get(slot);
    if (last && last.alive && alive) {
      const dt = Math.max(0.05, t - last.t);
      const d = Math.hypot(st[0] - last.x, st[2] - last.z);
      if (d > 1.5 && d / dt > 20) {
        this.strike(from, 0.25, `speed ${(d / dt).toFixed(1)} m/s`);
        // ignore it (a real teleport comes with a death + respawn) — unless the client insists for a
        // few packets: then resync rather than keep a stale position (the strikes still count)
        if (++last.rej < 4) return;
      }
    }
    if (last && last.alive && !alive) this.shotBudget.delete(slot); // died: magazines refill on respawn
    this.lastPose.set(slot, { t, x: st[0], z: st[2], alive, rej: 0 });
    // a reload / weapon switch refills the magazine count
    const act = Math.round(st[14]);
    if (act === 1 || act === 5) {
      const b = this.shotBudget.get(slot);
      if (b) b.mag = 0;
    }
    this.poses.set(slot, st);
    (this.bySlot(slot) as Bot)?.netState(st, t);
  }
  /** a client's shots: drop those beyond the gun's fire rate or magazine */
  private checkShots(slot: number, shots: any[]) {
    const peer = this.slotPeer(slot) ?? '';
    const ok: any[] = [];
    const t = now();
    for (const sh of shots) {
      const def = WEAPONS[sh.w as keyof typeof WEAPONS];
      if (!def || !Array.isArray(sh.o) || !Array.isArray(sh.d)) continue;
      let b = this.shotBudget.get(slot);
      const pel = Math.max(1, def.pellets);
      const cap = pel * 3 + 2;
      if (!b || b.w !== sh.w) {
        b = { tok: cap, t, w: sh.w, mag: 0 };
        this.shotBudget.set(slot, b);
      }
      // token bucket at 1.6× the fire rate (bursts, double barrels, timing jitter)
      b.tok = Math.min(cap, b.tok + (t - b.t) * (def.rpm / 60) * pel * 1.6);
      b.t = t;
      b.mag++;
      if (b.tok < 1) {
        this.strike(peer, 0.1, `fire rate ${def.name}`);
        continue;
      }
      if (b.mag > (def.mag + 1) * pel * 1.5 + 2) {
        this.strike(peer, 0.1, `magazine ${def.name}`);
        continue;
      }
      b.tok--;
      ok.push(sh);
    }
    return ok;
  }
  /**
   * A client's hit on something the host decides about (or passes on): the shooter must be the
   * sender, alive, and the victim must have been within reach of where the shooter saw them at
   * their render time (rewound host history).
   */
  private checkHit(from: string, m: any) {
    const slot = this.peerSlot.get(from);
    if (slot === undefined || m.a !== slot) return false;
    const a = this.bySlot(slot);
    if (!a || !a.alive) return false;
    if (!(m.dmg > 0) || m.dmg > 400) {
      this.strike(from, 1, 'damage');
      return false;
    }
    if (Array.isArray(m.vp) && typeof m.rt === 'number') {
      const h = this.hist.get(m.v);
      const at = this.sV;
      // rewind no further than the history (and a sane 1 s of latency)
      const rt = Math.max(now() - 1, Math.min(now(), m.rt));
      if (h && h.at(rt, at)) {
        const d = Math.hypot(at.x - m.vp[0], at.y - m.vp[1], at.z - m.vp[2]);
        if (d > 3) {
          this.strike(from, 1, `hit ${d.toFixed(1)} m from the victim`);
          return false;
        }
      }
      // the shooter has to be near where they said they were too
      // (the shooter sees themselves in the present, not interpolated: compare a little later)
      const ha = this.hist.get(slot);
      if (ha && ha.at(Math.min(now(), rt + this.interpDelayOf(from)), at) && Array.isArray(m.ap) && Math.hypot(at.x - m.ap[0], at.z - m.ap[2]) > 4) {
        this.strike(from, 1, 'shooter position');
        return false;
      }
    }
    return true;
  }
  private sV = new THREE.Vector3();
  /** a client's interpolation delay (they report it with their pings) */
  private interpOf = new Map<string, number>();
  private interpDelayOf(peer: string) {
    return this.interpOf.get(peer) ?? 0.1;
  }

  // ================================================================ host migration
  /**
   * The host left: the lowest-slot remaining player takes the room over under the same code (the
   * match, bots, flags and score carry on from where everyone last saw them); the others reconnect
   * to them and get their own slots back.
   */
  private async migrate(why: string) {
    const g = this.g;
    const code = this.lastCode;
    const old = this.roster.find((s) => s.host)?.slot ?? 0;
    const heirs = this.roster.filter((s) => s.human && s.slot !== old).sort((a, b) => a.slot - b.slot);
    if (this.migrating) return;
    if (!code || !heirs.length) return this.onHostGone(why);
    this.migrating = true;
    this.clock.reset();
    this.links.clear();
    this.rxBase.clear();
    this.voice.closeAll();
    g.ui.notify('HOST LEFT', 'MOVING THE GAME TO ANOTHER PLAYER…');
    this.sys('The host left. Moving the game to the next player…');
    const deadline = performance.now() + 30000;
    console.info('[net] migrating: heir slot', heirs[0].slot, 'me', this.mySlot);
    try {
      if (heirs[0].slot === this.mySlot) {
        while (performance.now() < deadline) {
          try {
            await this.net.host(code, true);
            break;
          } catch (e) {
            console.warn('[net] re-host attempt failed', (e as { taken?: boolean }).taken ? '(id still taken)' : e);
            await wait(1500);
          }
        }
        if (this.net.role !== 'host') return this.onHostGone('Could not take over the room.');
        this.becomeHost(old);
        return;
      }
      await wait(1200);
      while (performance.now() < deadline) {
        try {
          await this.net.join(code, { t: 'hello', name: this.name, ver: VER, rejoin: this.mySlot });
          return;
        } catch {
          await wait(1500);
        }
      }
      this.onHostGone('The host left and nobody could take the room over.');
    } finally {
      this.migrating = false;
    }
  }
  /** this machine now runs the room: bots, flags, clock and score continue from here */
  private becomeHost(oldHost: number) {
    const g = this.g;
    this.peerSlot.clear();
    this.poses.clear();
    this.sentTo.clear();
    this.hist.clear();
    this.lastPose.clear();
    this.shotBudget.clear();
    const t = now();
    for (const s of this.roster) {
      s.host = s.slot === this.mySlot;
      s.peer = undefined;
      s.pid = s.slot === this.mySlot ? this.net.myId : undefined;
      const b = this.bySlot(s.slot);
      if (!(b instanceof Bot)) continue;
      if (s.human && s.slot !== oldHost) {
        this.pendingRejoin.set(s.slot, t + 20); // keep it as their puppet for a while
        continue;
      }
      if (s.slot === oldHost) {
        s.human = false;
        s.name = b.botName || b.name;
        b.netHuman = false;
        b.isPlayer = false;
        b.name = s.name;
      }
      b.setPuppet(false);
      if (s.disabled) {
        b.netDisabled = true;
        b.netHide();
      } else if (b.alive) b.spawn(b.position().clone(), b.yaw);
      else b.respawnT = 1 + Math.random() * 2;
    }
    this.broadcastRoster();
    this.sys('You are now hosting this room. The others are reconnecting…');
    g.ui.notify('YOU ARE THE HOST', 'THE MATCH CONTINUES ON YOUR COMPUTER');
    this.announce();
  }

  // ================================================================ per frame
  update(dt: number) {
    if (!this.active) return;
    const g = this.g;
    this.net.tickStats(now());
    // snapshot interpolation: draw puppets interpDelay in the past (two intervals + jitter)
    const jit = this.isClient ? this.link('host').jitter : 0;
    this.interpDelay += (Math.min(0.25, Math.max(0.09, RATE * 2 + jit * 3)) - this.interpDelay) * 0.02;
    Bot.netRenderT = now() - this.interpDelay;
    this.validateTick(dt);
    this.voiceTick(dt);
    if (this.readyT > 0) {
      this.readyT -= dt;
      if (this.readyT <= 0 && this.isHost && g.match.phase === 'ended') g.startMatch();
    }
    this.sendT -= dt;
    if (this.sendT > 0) return;
    this.sendT += RATE;
    if (this.sendT < 0) this.sendT = 0;
    this.seq = (this.seq + 1) & 0xffff;
    if (this.isClient) {
      const pose = this.myPose();
      const sent = this.net.sendState(encodePoses(this.seq, now(), [this.mySlot], [pose], null, K_POSE));
      // the host went silent (closed tab, lost connection): treat it as gone
      if (this.lastHostRx && now() - this.lastHostRx > 6 && !this.migrating) {
        this.lastHostRx = 0;
        this.net.close();
        this.migrate('The host stopped responding.');
        return;
      }
      const m: any = { t: 'st' };
      if (!sent) {
        m.s = pose;
        m.ct = r2(now());
      }
      if (this.outShots.length) m.shots = this.outShots.splice(0);
      if (!sent || m.shots) this.net.send(m);
      if (performance.now() - this.pingSent > 2000) {
        this.pingSent = performance.now();
        this.net.send({ t: 'ping', at: this.pingSent, rtt: Math.round(this.rtt), loss: Math.round(this.link('host').loss * 1000) / 10, id: r2(this.interpDelay) });
      }
      return;
    }
    // ---- host: poses of every slot (binary, per peer: only changed slots, far ones at a third of
    // the rate, a full keyframe each second) + match state (reliable JSON)
    const slots: number[] = [], poses: ArrayLike<number>[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      const c = this.bySlot(slot);
      let p: ArrayLike<number> | undefined;
      if (slot === this.mySlot) p = this.myPose();
      else if (this.poses.has(slot)) p = this.poses.get(slot);
      else if (c instanceof Bot) {
        const r = c.replayState();
        p = c.netDisabled || (!c.alive && (c as any).deathT > 6) ? HIDDEN : r;
      }
      slots.push(slot);
      poses.push(p ?? HIDDEN);
      this.record(slot, p ?? HIDDEN);
    }
    const m: any = {
      t: 'snap', sc: g.match.scores, tl: r2(g.match.timeLeft),
      fl: g.dom.flags.map((f: any) => [f.owner, f.capTeam, r2(f.progress), f.contested ? 1 : 0]),
      uav: g.streaks.uavUntil.map((u: number) => r2(u - g.time)),
    };
    if (this.outShots.length) m.shots = this.outShots.splice(0);
    // match state at 10 Hz (shots go out right away)
    const sendJson = !!m.shots || this.seq % 2 === 0;
    this.doorT -= RATE;
    if (this.doorT <= 0) {
      this.doorT = 1;
      m.doors = g.doors.doors.map((d: any) => Math.round(d.target * 100) / 100);
    }
    this.envT -= RATE;
    if (this.envT <= 0) {
      this.envT = 5;
      m.env = this.envState();
      m.ni = this.netInfo;
    }
    let jsonPoses: string | null = null;
    for (const peer of this.net.conns.keys()) {
      if (this.net.hasState(peer)) {
        const st = this.sentTo.get(peer) ?? { last: new Map<number, Int16Array>(), chg: new Map<number, Int32Array>(), n: 0 };
        this.sentTo.set(peer, st);
        st.n++;
        const key = st.n % 20 === 1;
        const mine = this.bySlot(this.peerSlot.get(peer) ?? -1);
        const eye = mine ? mine.position() : null;
        const ss: number[] = [], pp: ArrayLike<number>[] = [], mm: number[] = [];
        for (let k = 0; k < slots.length; k++) {
          const p = poses[k];
          const q = quant(p);
          const prev = st.last.get(slots[k]);
          let chg = st.chg.get(slots[k]);
          if (!chg) st.chg.set(slots[k], (chg = new Int32Array(POSE_N).fill(-99)));
          // a field goes out if it changed in the last 3 packets (a lost packet is covered by the
          // next two), everything on a keyframe once a second
          let mask = 0;
          for (let i = 0; i < POSE_N; i++) {
            if (!prev || prev[i] !== q[i]) chg[i] = st.n;
            if (key || st.n - chg[i] < 3) mask |= 1 << i;
          }
          st.last.set(slots[k], q);
          // interest: soldiers far from this player update at a third of the rate
          const far = eye && Math.hypot(p[0] - eye.x, p[2] - eye.z) > 150;
          if (!mask || (far && !key && st.n % 3 !== 0)) continue;
          ss.push(slots[k]);
          pp.push(p);
          mm.push(mask);
        }
        this.net.sendState(encodePoses(this.seq, now(), ss, pp, mm), peer);
        if (sendJson) this.net.send(m, peer);
      } else {
        // no state channel (yet): poses inside the JSON message
        jsonPoses ??= packPoses(poses.flatMap((p) => Array.from(p).map(r2)));
        this.net.send({ ...m, sb: jsonPoses, ht: r2(now()) }, peer);
      }
    }
  }
  /** binary state packet from a peer */
  private onState(from: string, buf: ArrayBuffer) {
    let base = this.rxBase.get(from);
    if (!base) this.rxBase.set(from, (base = new Map()));
    // (sequence first: an old / duplicate packet must not overwrite newer fields)
    const dv = new DataView(buf);
    if (buf.byteLength < 8 || !this.link(from).seen(dv.getUint16(2))) return;
    if (from === 'host') this.lastHostRx = now();
    const pk = decodePoses(buf, base);
    const t = this.clock.map(from, pk.t);
    if (pk.kind === K_POSE && this.isHost) {
      const slot = this.peerSlot.get(from);
      const e = pk.out[0];
      if (slot === undefined || !e) return;
      this.acceptPose(slot, e.s, t, from);
    } else if (pk.kind === K_SNAP && this.isClient) {
      for (const e of pk.out) this.applySlotPose(e.slot, e.s, t);
    }
  }
  private applySlotPose(slot: number, st: number[], t: number) {
    if (slot === this.mySlot) return;
    const b = this.bySlot(slot);
    if (!(b instanceof Bot) || b.netDisabled) return;
    if (st[1] < -50) {
      if (b.alive) b.netHide();
      return;
    }
    b.netState(st, t);
  }

  private myPose() {
    const a = new Array(POSE_N).fill(0);
    this.g.playerPose(a);
    return a.map(r2);
  }

  private applySnap(m: any) {
    const g = this.g;
    if (m.sb) {
      const s = unpackPoses(m.sb);
      const t = m.ht !== undefined ? this.clock.map('host', m.ht) : now();
      for (let slot = 0; slot < SLOTS; slot++) this.applySlotPose(slot, s.slice(slot * POSE_N, slot * POSE_N + POSE_N), t);
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
    if (m.ni) this.netInfo = m.ni;
  }

  /** host: the match restarted / ended */
  onMatchStart() {
    this.readySet.clear();
    this.readyT = -1;
    this.imReady = false;
    this.readyInfo = '';
    this.updateStatus();
    if (!this.isHost) return;
    this.balance();
    for (const [peer, slot] of this.peerSlot) {
      (this.bySlot(slot) as Bot)?.netHide();
      this.net.send({ ...this.welcome(slot), t: 'match' }, peer);
    }
    this.applyBotCount();
  }
  onMatchEnd(w: number) {
    if (!this.isHost) return;
    this.net.broadcast({ t: 'end', winner: w });
    this.readySet.clear();
    this.checkReady();
  }

  // ================================================================ ready-up
  readyInfo = '';
  /** after a match: ready for the next (client → host; the host's own counts too) */
  setReady(v: boolean) {
    if (!this.active) return this.sys('Ready-up is for multiplayer rooms.');
    if (this.g.match.phase !== 'ended') return this.sys('Ready-up opens when the match is over.');
    this.imReady = v;
    if (v) this.g.ui.sfx('uiReady', 1);
    if (this.isClient) this.net.send({ t: 'ready', v });
    else {
      if (v) this.readySet.add(this.mySlot);
      else this.readySet.delete(this.mySlot);
      this.checkReady();
    }
    this.sys(v ? 'Ready. The next match starts when everyone is.' : 'Not ready.');
    this.updateStatus();
  }
  private checkReady() {
    if (!this.isHost || this.g.match.phase !== 'ended') return;
    const humans = this.roster.filter((s) => s.human);
    const n = humans.filter((s) => this.readySet.has(s.slot)).length;
    this.readyInfo = `${n}/${humans.length}`;
    this.net.broadcast({ t: 'rdy', n, of: humans.length });
    this.updateStatus();
    if (n === humans.length && humans.length > 1 && this.readyT < 0) {
      this.readyT = 3;
      this.g.ui.sfx('uiHorn', 1);
      this.sys('Everyone is ready: next match in 3 seconds.', true);
    }
  }

  // ================================================================ voice
  async toggleVoice() {
    if (this.voice.on) {
      this.voice.disable();
      Settings.set('voice', false);
      this.sys('Voice chat off.');
    } else {
      const ok = await this.voice.enable();
      if (!ok) return this.sys(this.voice.error);
      Settings.set('voice', true);
      this.sys(`Voice chat on: hold <b>${Settings.data.voiceMode === 'ptt' ? 'K' : 'nothing (open mic)'}</b> to talk · ${Settings.data.voiceChannel === 'team' ? 'your team hears you' : 'everyone near you hears you'}.`);
    }
    const me = this.roster.find((s) => s.slot === this.mySlot);
    if (me) me.vc = this.voice.on;
    if (this.isClient) this.net.send({ t: 'vc', on: this.voice.on });
    else if (this.isHost) this.broadcastRoster();
  }
  /** keep one call to every other voice-chat player (the lower slot rings) and set the volumes */
  private voiceTick(dt: number) {
    const v = this.voice;
    const g = this.g;
    if (!v.on || !this.net.peer) return;
    this.voiceT -= dt;
    if (this.voiceT <= 0) {
      this.voiceT = 1.5;
      const want = new Set<string>();
      for (const s of this.roster) {
        if (!s.human || !s.vc || !s.pid || s.slot === this.mySlot) continue;
        want.add(s.pid);
        if (this.mySlot < s.slot && !v.links.has(s.pid)) v.call(this.net.peer, s.pid, s.slot, this.mySlot);
      }
      for (const pid of [...v.links.keys()]) if (!want.has(pid)) v.hangUp(pid);
    }
    const me = g.avatar;
    const prox = Settings.data.voiceChannel === 'proximity';
    v.setVolume(Settings.data.voiceVolume);
    v.update(dt, (slot) => {
      const s = this.roster.find((x) => x.slot === slot);
      if (!s || this.muted.has(s.name)) return 0;
      if (!prox) return s.team === me.team ? 1 : 0;
      const c = this.bySlot(slot);
      if (!c) return 0;
      const d = c.position().distanceTo(me.position());
      return Math.max(0, Math.min(1, 1.25 - d / 40));
    }, Settings.data.voiceMode === 'ptt' ? g.input.rawDown('talk') : null);
    this.voiceHud();
  }
  private voiceEl: HTMLDivElement | null = null;
  private voiceKey = '';
  private voiceHud() {
    const v = this.voice;
    if (!this.voiceEl) {
      this.voiceEl = document.createElement('div');
      this.voiceEl.className = 'voicehud';
      this.g.ui.root.appendChild(this.voiceEl);
    }
    const names = [...v.speaking].map((s) => this.roster.find((x) => x.slot === s)?.name ?? '?');
    if (v.talking) names.unshift(this.name);
    const key = names.join('|');
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    this.voiceEl.innerHTML = names.map((n, i) => `<div class="${i === 0 && v.talking ? 'me' : ''}"><i></i>${esc(n)}</div>`).join('');
  }

  // ================================================================ room browser
  /** host: keep the public room listed */
  private announce() {
    if (!this.isHost || !this.isPublic) {
      this.reg.stop();
      return;
    }
    this.reg.announce((): RoomInfo | null => {
      if (!this.isHost || !this.isPublic) return null;
      const g = this.g;
      return { code: this.net.code, name: `${this.name}'s room`, players: this.roster.filter((s) => s.human).length, max: SLOTS, map: `${g.winter ? 'Winter' : 'Autumn'} · Domination`, region: myRegion() };
    });
  }

  // ================================================================ diagnostics
  async netReport() {
    if (!this.active) return this.sys('Not in a multiplayer room.');
    const d = await this.net.diagnose();
    const l = this.isClient ? this.link('host') : null;
    const parts = [
      d ? `Connection: <b>${d.type}</b> over ${d.protocol.toUpperCase()}` : 'Connection: checking…',
      this.isClient ? `Round trip ${Math.round(this.rtt)} ms · loss ${((l?.loss ?? 0) * 100).toFixed(1)}% · jitter ${Math.round((l?.jitter ?? 0) * 1000)} ms · interpolation ${Math.round(this.interpDelay * 1000)} ms` : `Hosting ${this.net.conns.size} player(s)`,
      `Up ${(this.net.stats.up / 1024).toFixed(1)} KB/s · down ${(this.net.stats.down / 1024).toFixed(1)} KB/s · ${this.net.hasState() || this.isHost ? 'binary state channel' : 'JSON fallback'}`,
    ];
    if (this.isHost) for (const s of this.roster) if (s.human && s.slot !== this.mySlot) {
      const i = this.netInfo[s.slot];
      parts.push(`${esc(s.name)}: ${i ? `${i[0]} ms · ${i[1]}% loss` : '…'}`);
    }
    this.sys(parts.join('<br>'));
  }
  /** for the scoreboard and the F3 graph */
  pingOf(slot: number) {
    if (!this.active) return '';
    const s = this.roster.find((x) => x.slot === slot);
    if (!s) return '';
    if (!s.human) return 'BOT';
    if (s.slot === this.mySlot && this.isClient) return `${Math.round(this.rtt)}`;
    if (s.host) return 'HOST';
    const i = this.netInfo[slot];
    return i ? `${i[0]}${i[1] >= 1 ? ` · ${Math.round(i[1])}%` : ''}` : '…';
  }
  speakingSlot(slot: number) {
    return this.voice.speaking.has(slot) || (slot === this.mySlot && this.voice.talking);
  }
  /** numbers for the F3 network graph */
  graphSample() {
    const l = this.isClient ? this.link('host') : null;
    return { rtt: this.isClient ? this.rtt : 0, loss: (l?.loss ?? 0) * 100, up: this.net.stats.up / 1024, down: this.net.stats.down / 1024, interp: this.interpDelay * 1000, jitter: (l?.jitter ?? 0) * 1000 };
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
  private openChat(prefix: string, team = false) {
    this.chatTeam = team;
    this.chatInput.placeholder = team ? 'Team chat' : 'Say something, or /help';
    this.chatEl.classList.toggle('team', team);
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

  submit(text: string, team = false) {
    if (text.startsWith('/')) return this.command(text);
    if (!this.active) return this.sys('Chat works in multiplayer games. /help lists the commands.');
    if (this.isClient) this.net.send({ t: 'chat', text, tm: team ? 1 : 0 });
    else {
      const out = { t: 'chat', from: this.name, team: this.g.avatar.team, text, tm: team ? 1 : 0 };
      if (team) {
        for (const r of this.roster) if (r.human && r.team === this.g.avatar.team && r.peer) this.net.send(out, r.peer);
      } else this.net.broadcast(out);
      this.chat(this.name, this.g.avatar.team, text, team);
    }
  }

  private command(text: string) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const c = (cmd || '').toLowerCase();
    const g = this.g;
    const hostOnly = ['bots', 'kick', 'restart', 'time', 'diff', 'weather', 'balance', 'public'];
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
          '/net — connection details (direct / relayed, loss, jitter, bandwidth)',
          '/mute &lt;name&gt; · /unmute &lt;name&gt; — hide a player\'s chat and voice',
          '/voice — voice chat on / off · [K] push to talk (Settings → Multiplayer)',
          '/ready — ready for the next match (after a match)',
          '/spec — spectate / free camera (again to rejoin)',
          '[U] — team chat',
          '/leave — leave the room',
          '<b>Host only</b>',
          '/bots &lt;0-23&gt; — how many bots fill the slots',
          '/kick &lt;name&gt; — remove a player',
          '/restart — new match',
          '/balance — even out the human players',
          '/public — show / hide the room in the room browser',
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
        const rows = this.roster.filter((s) => s.human).map((s) => `${s.team === g.avatar.team ? '🔵' : '🔴'} ${esc(s.name)}${s.host ? ' (host)' : ''}`);
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
      case 'net':
        this.netReport();
        return;
      case 'mute':
      case 'unmute': {
        const who = args.join(' ').toLowerCase();
        const s = this.roster.find((x) => x.human && x.name.toLowerCase() === who);
        if (!s) return this.sys(`Usage: /${c} &lt;name&gt; · /players lists them.`);
        if (c === 'mute') this.muted.add(s.name);
        else this.muted.delete(s.name);
        this.sys(`${esc(s.name)} ${c === 'mute' ? 'muted (chat and voice)' : 'unmuted'}.`);
        return;
      }
      case 'voice':
        this.toggleVoice();
        return;
      case 'ready':
        this.setReady(!this.imReady);
        return;
      case 'spec':
      case 'spectate':
        g.toggleSpectate?.();
        return;
      default:
        if (hostOnly.includes(c)) {
          if (this.isClient) return this.sys('Only the host can do that.');
          return this.hostCommand('', c, args);
        }
        this.sys(`Unknown command /${esc(c)}. Try /help.`);
    }
  }

  /** host: move a human to the other side (swap with a bot there) */
  private moveTeam(slot: number) {
    const g = this.g;
    const me = this.roster.find((s) => s.slot === slot);
    if (!me) return false;
    const want = (1 - me.team) as 0 | 1;
    if (slot === this.mySlot) {
      const other = this.roster.filter((s) => s.team === want && !s.human)[0];
      if (!other) return false;
      const bot = this.bySlot(other.slot) as Bot;
      other.team = me.team;
      bot.setTeam(me.team);
      me.team = want;
      g.avatar.team = want;
      g.dom.myTeam = want;
      g.avatar.health = 0;
      g.avatar.alive = false;
      g.respawnPlayer();
      bot.netHide();
      bot.respawnT = 1;
    } else {
      const target = this.roster.find((s) => s.team === want && !s.human);
      const peer = me.peer;
      if (!target || !peer) return false;
      const name = me.name, pid = me.pid, vc = me.vc;
      this.releaseSlot(slot);
      this.assignHuman(target.slot, peer, name);
      target.pid = pid;
      target.vc = vc;
      this.net.send(this.welcome(target.slot), peer);
    }
    this.broadcastRoster();
    this.sys(`<b>${esc(me.name)}</b> switched to ${g.match.teamNames[want]}.`, true);
    return true;
  }
  /** host: even out the humans (the most recent joiners on the bigger side move) */
  balance() {
    for (let k = 0; k < SLOTS; k++) {
      const hs = [0, 1].map((t) => this.roster.filter((s) => s.human && s.team === t));
      const big = hs[0].length - hs[1].length > 1 ? 0 : hs[1].length - hs[0].length > 1 ? 1 : -1;
      if (big < 0) return k;
      const mover = hs[big].filter((s) => s.slot !== this.mySlot).pop() ?? hs[big][0];
      if (!this.moveTeam(mover.slot)) return k;
    }
    return SLOTS;
  }

  /** commands the host runs (its own, or relayed from a client) */
  private hostCommand(from: string, cmd: string, args: string[]) {
    const g = this.g;
    const slot = from ? this.peerSlot.get(from) : this.mySlot;
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
        if (!this.moveTeam(slot!)) reply('No free slot on the other side.');
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
        const s = this.roster.find((x) => x.human && x.slot !== this.mySlot && x.name.toLowerCase() === who);
        if (!s || !s.peer) return reply('No player by that name. /players lists them.');
        this.net.send({ t: 'kick', why: 'The host removed you from the room.' }, s.peer);
        setTimeout(() => this.net.kick(s.peer!), 300);
        this.sys(`${esc(s.name)} was kicked.`, true);
        return;
      }
      case 'balance': {
        const n = this.balance();
        this.sys(n ? `Teams balanced (${n} moved).` : 'Teams are already even.', !!n);
        return;
      }
      case 'public': {
        this.isPublic = !this.isPublic;
        localStorage.setItem('ff.public', this.isPublic ? '1' : '0');
        this.announce();
        this.sys(this.isPublic ? 'The room is <b>public</b>: it shows in the room browser.' : 'The room is <b>private</b>: invite only.');
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
  private chat(from: string, team: number, text: string, teamOnly = false) {
    if (this.muted.has(from)) return;
    const mine = team === this.g.avatar.team;
    this.line(`${teamOnly ? '<span class="tm">[TEAM]</span> ' : ''}<span class="${mine ? 'ally' : 'enemy'}">${esc(from)}:</span> ${esc(filterText(text))}`);
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
    const rd = this.g.match?.phase === 'ended' && this.readyInfo ? ` · READY <b>${this.readyInfo}</b>${this.imReady ? '' : ' — /ready or PLAY AGAIN'}` : '';
    this.statusEl.innerHTML = `${this.isHost ? 'HOST' : 'ONLINE'}${this.isPublic && this.isHost ? ' · PUBLIC' : ''} · ROOM <b>${this.net.code}</b> · ${humans} PLAYER${humans === 1 ? '' : 'S'} + ${bots} BOTS${rd}`;
  }

  // ================================================================ scoreboard actions
  /** mute / unmute a player from the scoreboard (chat + voice, this machine only) */
  toggleMuteSlot(slot: number) {
    const s = this.roster.find((x) => x.slot === slot);
    if (!s) return;
    if (this.muted.has(s.name)) this.muted.delete(s.name);
    else this.muted.add(s.name);
    this.sys(`${esc(s.name)} ${this.muted.has(s.name) ? 'muted (chat and voice)' : 'unmuted'}.`);
  }
  isMutedSlot(slot: number) {
    const s = this.roster.find((x) => x.slot === slot);
    return !!s && this.muted.has(s.name);
  }
  /** report a player to the host (there is no server: the host decides) */
  report(slot: number) {
    const s = this.roster.find((x) => x.slot === slot);
    if (!s) return;
    if (this.isClient) this.net.send({ t: 'report', slot });
    else if (this.isHost) this.sys(`Noted. As the host you can remove <b>${esc(s.name)}</b> with /kick ${esc(s.name)}.`);
    this.sys(`Reported <b>${esc(s.name)}</b> to the host.`);
  }

  // ================================================================ quick play
  /** join the fullest public room with space, or open a public room if there is none */
  async quickPlay(status: (t: string) => void = (t) => this.g.ui.notify('QUICK PLAY', t.toUpperCase())) {
    status('Looking for a room…');
    const rs = (await LobbyRegistry.list()).filter((r) => r.players < r.max).sort((a, b) => b.players - a.players);
    for (const r of rs) {
      try {
        status(`Joining ${r.name}…`);
        await this.join(r.code);
        return;
      } catch {
        /* next */
      }
    }
    this.isPublic = true;
    localStorage.setItem('ff.public', '1');
    status('No open rooms — opening one');
    await this.host();
    this.panel?.remove();
    this.g.startMatch();
  }

  // ================================================================ the multiplayer screen
  private roomThumb: HTMLCanvasElement | null = null;
  /** Main menu → MULTIPLAYER: name, quick play, host (public / private), join by code, room cards */
  showPanel(prefill = '') {
    const g = this.g;
    this.panel?.remove();
    const p = document.createElement('div');
    p.className = 'screen netpanel';
    p.innerHTML = `
      <div class="card">
        <div class="eyebrow red">FLERSPILLER · MULTIPLAYER</div>
        <h2>FINN ET LAG</h2>
        <div class="sub">Play with friends — peer to peer, bots fill every empty slot (12 v 12).</div>
        <label>DITT NAVN · YOUR NAME<input class="nm" maxlength="16" spellcheck="false"></label>
        <div class="row">
          <div class="col">${icon('quick')}<h3>QUICK PLAY</h3><p>Join the fullest public room, or open one if there is none.</p><button class="primary" data-a="quick">QUICK PLAY</button></div>
          <div class="col">${icon('host')}<h3>HOST</h3><p>Start a room on this computer and send friends the code.</p>
            <label class="pub"><input type="checkbox" class="public"> Public — listed in the room browser</label>
            <button class="primary" data-a="host">HOST GAME</button></div>
          <div class="col">${icon('multiplayer')}<h3>JOIN</h3><p>Type the code your friend got.</p><input class="code" maxlength="8" placeholder="CODE" spellcheck="false"><button class="primary" data-a="join">JOIN GAME</button></div>
        </div>
        <div class="rooms"><div class="rh"><h3>OFFENTLIGE ROM · PUBLIC ROOMS</h3><button data-a="refresh">REFRESH</button></div><div class="rlist"><div class="rempty">Looking for rooms…</div></div></div>
        <div class="msg"></div>
        <div class="foot"><span>The host's game runs the match — if they leave, another player takes over. Enter = chat · U = team chat · /help = commands · connection problems: Settings → Multiplayer.</span><button class="back" data-a="back">BACK</button></div>
      </div>`;
    g.ui.root.appendChild(p);
    this.panel = p;
    const nm = p.querySelector('.nm') as HTMLInputElement, code = p.querySelector('.code') as HTMLInputElement, msg = p.querySelector('.msg') as HTMLDivElement;
    const pub = p.querySelector('.public') as HTMLInputElement;
    nm.value = this.name;
    code.value = prefill;
    pub.checked = this.isPublic;
    pub.addEventListener('change', () => {
      this.isPublic = pub.checked;
      localStorage.setItem('ff.public', this.isPublic ? '1' : '0');
    });
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
    const doHost = async () => {
      setName();
      busy(true, 'Opening a room…');
      try {
        await this.host();
        p.remove();
        g.startMatch();
        g.ui.sfx('uiHorn', 1);
        if (!g.input.locked) g.ui.notify('ROOM OPEN', 'CLICK THE SCREEN TO PLAY · /code FOR THE INVITE LINK');
      } catch (e) {
        busy(false, (e as Error).message);
        NETF.active = false;
      }
    };
    const doJoin = async (c = code.value) => {
      setName();
      if (cleanCode(c).length < 4) return busy(false, 'Type the room code first.');
      busy(true, 'Connecting…');
      try {
        await this.join(c);
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
    // room cards: chart thumbnail, name, players, region, measured ping
    let rooms: RoomInfo[] = [];
    const list = p.querySelector('.rlist') as HTMLDivElement;
    const refresh = async () => {
      list.innerHTML = '<div class="rempty">Looking for rooms…</div>';
      rooms = (await LobbyRegistry.list()).filter((r) => r.players < r.max).sort((a, b) => b.players - a.players);
      if (!p.isConnected) return;
      if (!rooms.length) {
        list.innerHTML = '<div class="rempty">No public rooms on the chart right now. Host one, or use QUICK PLAY.</div>';
        return;
      }
      try {
        this.roomThumb ??= chartThumb(g.terrain, 220, 124, [], { names: false, cover: true });
      } catch {
        this.roomThumb = null;
      }
      list.innerHTML = rooms.map((r, i) => `<div class="room" data-room="${i}"><canvas width="440" height="248"></canvas><span class="rtag">${esc(r.code)}</span>
        <div class="rb"><b>${esc(r.name)}</b><span class="rp"><span class="ms" data-ms="${esc(r.code)}">… ms</span>${icon('signal')}</span><small>${esc(r.map)}</small><small>${r.players}/${r.max} players · ${esc(r.region ?? '—')}</small></div></div>`).join('');
      list.querySelectorAll('.room').forEach((el) => {
        const cv = el.querySelector('canvas') as HTMLCanvasElement;
        if (this.roomThumb) cv.getContext('2d')!.drawImage(this.roomThumb, 0, 0, cv.width, cv.height);
        el.addEventListener('click', () => doJoin(rooms[+(el as HTMLElement).dataset.room!].code));
      });
      const pings = await probeRooms(rooms.map((r) => r.code));
      for (const [c, ms] of pings) {
        const el = list.querySelector(`[data-ms="${CSS.escape(c)}"]`);
        if (!el) continue;
        el.textContent = ms === null ? 'no reply' : `${ms} ms`;
        el.className = `ms ${ms === null ? 'bad' : ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad'}`;
      }
    };
    p.querySelector('[data-a=back]')!.addEventListener('click', () => p.remove());
    p.querySelector('[data-a=host]')!.addEventListener('click', doHost);
    p.querySelector('[data-a=join]')!.addEventListener('click', () => doJoin());
    p.querySelector('[data-a=refresh]')!.addEventListener('click', refresh);
    p.querySelector('[data-a=quick]')!.addEventListener('click', async () => {
      setName();
      busy(true, 'Looking for a room…');
      try {
        await this.quickPlay((t) => (msg.textContent = t));
        if (g.state === 'playing') p.remove();
      } catch (e) {
        busy(false, (e as Error).message);
      }
    });
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') doJoin();
    });
    nm.addEventListener('keydown', (e) => e.stopPropagation());
    if (prefill) setTimeout(() => code.focus(), 50);
    else refresh();
  }
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
